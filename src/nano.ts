/**
 * Receive-only Nano (XNO) settlement verifier for the paid tool.
 *
 * Optionally settles `deploy.preview` (and any other paid tool) by verifying a confirmed
 * Nano send on-chain, so an agent can pay feeless in XNO instead of (or beside) the USD
 * spend control. Keyless: it reads the block over a Nano RPC and holds no private key.
 *
 * A Nano block has no memo, so a confirmed send proves only that an amount reached an
 * account. To release a result for ONE order the seller therefore:
 *
 *  1. issues an order (`issueNanoOrder`): an opaque random `orderId` the requester keeps,
 *     the `payTo` account, an exact `amountRaw` carrying a random per-order tag that no
 *     other open order for that account shares, and an issue/expiry window;
 *  2. verifies a block against that order (`verifyNanoPayment`): the order is read from
 *     the store (never from caller input), the block must be a confirmed send of exactly
 *     that amount to exactly that account, made inside the order's window, and the
 *     `blockHash -> orderId` pair is claimed once in the store (UNIQUE on the hash);
 *  3. the claim lives behind `NanoOrderStore`. The in-memory store is for tests and one
 *     process; a seller that restarts or runs several workers passes a store backed by a
 *     database (a UNIQUE index on `blockHash` and on `orderId` in the claims table).
 *
 * Node lookups are bounded (timeout, response size) and a plain-HTTP RPC URL is refused
 * unless it is loopback. 1 XNO = 10^30 raw.
 */
const XNO_TO_RAW = 10n ** 30n;

/** Each order adds a random tag of 1..TAG_SPAN-1 raw to its price (10^6 raw = 10^-24 XNO). */
const TAG_SPAN = 1_000_000n;
const TAG_ATTEMPTS = 64;
/** Node and seller clocks may differ a little; the window check tolerates this much. */
const CLOCK_SKEW_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_RPC_URL = "https://rpc.nano.to";
const BLOCK_HASH = /^[0-9A-F]{64}$/;

export interface NanoOrder {
  /** Opaque random id (128 bits). The requester's claim secret; never a counter. */
  orderId: string;
  /** Nano account the buyer must pay. */
  payTo: string;
  /** Exact raw amount, tag included. */
  amountRaw: string;
  /** Issue time, ms since epoch. A block made earlier cannot pay this order. */
  issuedAtMs: number;
  /** Expiry, ms since epoch. A block made later cannot pay this order. */
  expiresAtMs: number;
}

/**
 * Where orders and claimed blocks live. Every method must be atomic. A persistent
 * implementation keeps `claims(block_hash UNIQUE, order_id UNIQUE)`.
 */
export interface NanoOrderStore {
  /**
   * Store `order` unless another order that has not expired already holds the same
   * `payTo` and `amountRaw`. Returns false when the amount is taken.
   */
  put(order: NanoOrder, nowMs: number): Promise<boolean>;
  get(orderId: string): Promise<NanoOrder | undefined>;
  /**
   * Record `blockHash -> orderId`. Returns true when this exact pair is already
   * recorded (idempotent re-read) or was just recorded; false when the hash belongs to
   * another order or the order already has a different block.
   */
  claim(blockHash: string, orderId: string): Promise<boolean>;
}

/** In-memory store: one process, lost on restart. Use a database-backed store in production. */
export class InMemoryNanoOrderStore implements NanoOrderStore {
  private orders = new Map<string, NanoOrder>();
  private byBlock = new Map<string, string>();
  private byOrder = new Map<string, string>();

  async put(order: NanoOrder, nowMs: number): Promise<boolean> {
    for (const held of this.orders.values()) {
      if (
        held.payTo === order.payTo &&
        held.amountRaw === order.amountRaw &&
        held.expiresAtMs > nowMs
      ) {
        return false;
      }
    }
    this.orders.set(order.orderId, { ...order });
    return true;
  }

  async get(orderId: string): Promise<NanoOrder | undefined> {
    const order = this.orders.get(orderId);
    return order ? { ...order } : undefined;
  }

  async claim(blockHash: string, orderId: string): Promise<boolean> {
    const owner = this.byBlock.get(blockHash);
    const held = this.byOrder.get(orderId);
    if (owner !== undefined || held !== undefined) {
      return owner === orderId && held === blockHash;
    }
    this.byBlock.set(blockHash, orderId);
    this.byOrder.set(orderId, blockHash);
    return true;
  }
}

function toRaw(xno: string): bigint {
  const s = xno.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`not a decimal amount: ${xno}`);
  }
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > 30) {
    throw new Error(`more than 30 decimal places: ${xno}`);
  }
  const fracPadded = (frac + "0".repeat(30)).slice(0, 30);
  return BigInt(whole || "0") * XNO_TO_RAW + BigInt(fracPadded || "0");
}

function toRawString(xnoRaw: bigint): string {
  return xnoRaw.toString();
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomTag(): bigint {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return 1n + (BigInt(buf[0] as number) % (TAG_SPAN - 1n));
}

export interface IssueNanoOrderOpts {
  store: NanoOrderStore;
  payTo: string;
  /** Price in XNO, a decimal string. Rounded up never; the tag is added on top. */
  priceXno: string;
  /** How long the order stays payable. Default 15 minutes. */
  ttlMs?: number;
  /** Test clock. */
  nowMs?: number;
}

/**
 * Issue one order. Hand `orderId`, `payTo` and `amountRaw` to the requester; keep the
 * rest in the store. Throws when no free tagged amount is found for this price.
 */
export async function issueNanoOrder(opts: IssueNanoOrderOpts): Promise<NanoOrder> {
  if (!opts.payTo) {
    throw new Error("payTo is required");
  }
  const price = toRaw(opts.priceXno);
  if (price <= 0n) {
    throw new Error("price must be positive");
  }
  const ttlMs = opts.ttlMs ?? 15 * 60_000;
  if (!(ttlMs > 0)) {
    throw new Error("ttlMs must be positive");
  }
  const now = opts.nowMs ?? Date.now();
  for (let i = 0; i < TAG_ATTEMPTS; i++) {
    const order: NanoOrder = {
      orderId: randomHex(16),
      payTo: opts.payTo,
      amountRaw: toRawString(price + randomTag()),
      issuedAtMs: now,
      expiresAtMs: now + ttlMs,
    };
    if (await opts.store.put(order, now)) {
      return order;
    }
  }
  throw new Error("no free amount for this price and account");
}

export interface NanoVerifyOpts {
  store: NanoOrderStore;
  /** The order id the requester presents. The block hash alone is never a proof. */
  orderId: string;
  /** Hash of the settled Nano send block. */
  blockHash: string;
  /** axios/fetch-compatible function; injectable for tests. Default is globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Nano RPC endpoint. https, or http only on loopback. Default rpc.nano.to. */
  rpcUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Test clock. */
  nowMs?: number;
}

/** Refuse plain-HTTP RPC endpoints unless they are loopback. */
export function assertSafeRpcUrl(rpcUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error(`invalid rpc url: ${rpcUrl}`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (url.protocol === "http:" && loopback) {
    return url;
  }
  throw new Error("rpc url must be https (plain http only on loopback)");
}

async function readBounded(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers?.get?.("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error("rpc response too large");
  }
  const reader = res.body?.getReader?.();
  let text: string;
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("rpc response too large");
      }
      chunks.push(value);
    }
    const all = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    text = new TextDecoder().decode(all);
    return JSON.parse(text);
  }
  if (typeof res.text === "function") {
    text = await res.text();
    if (text.length > maxBytes) {
      throw new Error("rpc response too large");
    }
    return JSON.parse(text);
  }
  return res.json();
}

/**
 * Verify that `blockHash` pays the order `orderId`. Returns true only if a node reports
 * the block confirmed, a send, of exactly the order's amount to exactly its account,
 * made inside the order's window, and the `blockHash -> orderId` claim is recorded
 * (idempotent for the same pair). Fails closed: any node error, unknown order, short or
 * excess amount, late or early block, or a block already claimed returns false.
 */
export async function verifyNanoPayment(opts: NanoVerifyOpts): Promise<boolean> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchFn) {
    throw new Error("no fetch implementation available");
  }
  const rpcUrl = assertSafeRpcUrl(opts.rpcUrl ?? DEFAULT_RPC_URL);
  const blockHash = typeof opts.blockHash === "string" ? opts.blockHash.trim().toUpperCase() : "";
  if (!BLOCK_HASH.test(blockHash) || typeof opts.orderId !== "string" || !opts.orderId) {
    return false;
  }
  const order = await opts.store.get(opts.orderId);
  if (!order) {
    return false;
  }
  const now = opts.nowMs ?? Date.now();
  if (now >= order.expiresAtMs) {
    return false;
  }

  let data: Record<string, unknown>;
  try {
    const res = await fetchFn(rpcUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "block_info", json_block: "true", hash: blockHash }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (!res || !res.ok) {
      return false;
    }
    data = (await readBounded(res, opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) as Record<
      string,
      unknown
    >;
  } catch {
    return false;
  }
  if (!data || typeof data !== "object" || data.error !== undefined) {
    return false;
  }
  // `confirmed` and `amount` are top-level fields of block_info; confirmed is often "true".
  if (data.confirmed !== true && data.confirmed !== "true") {
    return false;
  }
  const contents = data.contents as Record<string, unknown> | undefined;
  if (!contents || typeof contents !== "object") {
    return false;
  }
  if (data.subtype !== "send" && contents.type !== "send") {
    return false;
  }
  if (!/^\d+$/.test(String(data.amount ?? "")) || String(data.amount) !== order.amountRaw) {
    return false;
  }
  const recipient = contents.link_as_account ?? contents.destination;
  if (recipient !== order.payTo) {
    return false;
  }
  // The block's own time must fall inside the order's window, so a late block for an
  // expired order cannot pay a newer order that was handed the same amount.
  const blockMs = Number(String(data.local_timestamp ?? "")) * 1000;
  if (!Number.isFinite(blockMs) || blockMs <= 0) {
    return false;
  }
  if (blockMs < order.issuedAtMs - CLOCK_SKEW_MS || blockMs > order.expiresAtMs + CLOCK_SKEW_MS) {
    return false;
  }
  return opts.store.claim(blockHash, order.orderId);
}

export { XNO_TO_RAW, toRaw, toRawString };
