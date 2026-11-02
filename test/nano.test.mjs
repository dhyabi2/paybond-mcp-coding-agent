import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryNanoOrderStore,
  assertSafeRpcUrl,
  issueNanoOrder,
  toRaw,
  toRawString,
  verifyNanoPayment,
  XNO_TO_RAW,
} from "../dist/nano.js";

const PAY_TO = "nano_1payto";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

// A fetch stub serving block_info from a canned reply, as a real node would.
function fakeNode(reply) {
  return async () => ({
    ok: true,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(reply);
    },
  });
}

function blockFor(order, over = {}) {
  return {
    amount: order.amountRaw,
    confirmed: "true",
    subtype: "send",
    local_timestamp: String(Math.floor((order.issuedAtMs + 1000) / 1000)),
    contents: { type: "state", link_as_account: order.payTo },
    ...over,
  };
}

async function setup(ttlMs = 60_000) {
  const store = new InMemoryNanoOrderStore();
  const order = await issueNanoOrder({ store, payTo: PAY_TO, priceXno: "0.1", ttlMs });
  return { store, order };
}

const verify = (store, order, blockHash, reply, extra = {}) =>
  verifyNanoPayment({
    store,
    orderId: order.orderId,
    blockHash,
    fetchImpl: fakeNode(reply),
    nowMs: order.issuedAtMs + 2000,
    ...extra,
  });

test("toRaw decodes 30-decimal Nano amounts", () => {
  assert.equal(toRaw("1"), XNO_TO_RAW);
  assert.equal(toRaw("0.1"), 100000000000000000000000000000n);
  assert.equal(toRaw("0.000000000000000000000000000001"), 1n);
  assert.equal(toRawString(toRaw("0.25")), "250000000000000000000000000000");
});

test("toRaw rejects more than 30 decimal places and non-decimals", () => {
  assert.throws(() => toRaw("0.0000000000000000000000000000001"));
  assert.throws(() => toRaw("1e3"));
});

test("an order has an opaque id and a tagged amount above the price", async () => {
  const { order } = await setup();
  assert.match(order.orderId, /^[0-9a-f]{32}$/);
  assert.ok(BigInt(order.amountRaw) > toRaw("0.1"));
  assert.ok(BigInt(order.amountRaw) < toRaw("0.1") + 1_000_000n);
});

test("two open orders for one price never share an amount", async () => {
  const store = new InMemoryNanoOrderStore();
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const o = await issueNanoOrder({ store, payTo: PAY_TO, priceXno: "0.1" });
    assert.ok(!seen.has(o.amountRaw));
    seen.add(o.amountRaw);
  }
});

test("a block for the order verifies, and re-reading it is idempotent", async () => {
  const { store, order } = await setup();
  assert.equal(await verify(store, order, H1, blockFor(order)), true);
  assert.equal(await verify(store, order, H1, blockFor(order)), true);
});

test("a block hash cannot pay a second order (UNIQUE on the hash)", async () => {
  const { store, order } = await setup();
  const other = await issueNanoOrder({ store, payTo: PAY_TO, priceXno: "0.1" });
  assert.equal(await verify(store, order, H1, blockFor(order)), true);
  // Even if the amounts matched, the hash is already owned by the first order.
  assert.equal(await verify(store, other, H1, blockFor(other)), false);
});

test("a second block for an already-paid order is refused", async () => {
  const { store, order } = await setup();
  assert.equal(await verify(store, order, H1, blockFor(order)), true);
  assert.equal(await verify(store, order, H2, blockFor(order)), false);
});

test("a block for another order's amount does not pay this order", async () => {
  const { store, order } = await setup();
  const other = await issueNanoOrder({ store, payTo: PAY_TO, priceXno: "0.1" });
  assert.equal(await verify(store, order, H1, blockFor(other)), false);
});

test("an unknown order id, or a hash without one, pays nothing", async () => {
  const { store, order } = await setup();
  assert.equal(await verify(store, { ...order, orderId: "f".repeat(32) }, H1, blockFor(order)), false);
  assert.equal(await verify(store, { ...order, orderId: "" }, H1, blockFor(order)), false);
});

test("short, excess and wrong-recipient blocks are refused", async () => {
  const { store, order } = await setup();
  const more = (BigInt(order.amountRaw) + 1n).toString();
  const less = (BigInt(order.amountRaw) - 1n).toString();
  assert.equal(await verify(store, order, H1, blockFor(order, { amount: more })), false);
  assert.equal(await verify(store, order, H1, blockFor(order, { amount: less })), false);
  assert.equal(
    await verify(store, order, H1, blockFor(order, { contents: { type: "state", link_as_account: "nano_1other" } })),
    false,
  );
  // A reply with no recipient or no amount must not pass by omission.
  assert.equal(await verify(store, order, H1, blockFor(order, { contents: { type: "state" } })), false);
  assert.equal(await verify(store, order, H1, blockFor(order, { amount: undefined })), false);
});

test("unconfirmed, non-send and node-error replies fail closed", async () => {
  const { store, order } = await setup();
  assert.equal(await verify(store, order, H1, blockFor(order, { confirmed: "false" })), false);
  assert.equal(await verify(store, order, H1, blockFor(order, { confirmed: undefined })), false);
  assert.equal(await verify(store, order, H1, blockFor(order, { subtype: "receive" })), false);
  assert.equal(await verify(store, order, H1, { error: "Block not found" }), false);
  const throwing = async () => {
    throw new Error("network down");
  };
  assert.equal(
    await verifyNanoPayment({ store, orderId: order.orderId, blockHash: H1, fetchImpl: throwing, nowMs: order.issuedAtMs }),
    false,
  );
});

test("a malformed block hash is refused before any lookup", async () => {
  const { store, order } = await setup();
  let called = false;
  const spy = async () => {
    called = true;
    return fakeNode(blockFor(order))();
  };
  for (const bad of ["abc", "g".repeat(64), "", "1".repeat(63)]) {
    assert.equal(
      await verifyNanoPayment({ store, orderId: order.orderId, blockHash: bad, fetchImpl: spy, nowMs: order.issuedAtMs }),
      false,
    );
  }
  assert.equal(called, false);
});

test("hash case does not create a second claim", async () => {
  const { store, order } = await setup();
  const h = "ab".repeat(32);
  assert.equal(await verify(store, order, h, blockFor(order)), true);
  const other = await issueNanoOrder({ store, payTo: PAY_TO, priceXno: "0.1" });
  assert.equal(await verify(store, other, h.toUpperCase(), blockFor(other)), false);
});

test("a block made after expiry, or before the order, is refused", async () => {
  const { store, order } = await setup(60_000);
  const late = String(Math.floor((order.expiresAtMs + 120_000) / 1000));
  const early = String(Math.floor((order.issuedAtMs - 120_000) / 1000));
  assert.equal(await verify(store, order, H1, blockFor(order, { local_timestamp: late })), false);
  assert.equal(await verify(store, order, H1, blockFor(order, { local_timestamp: early })), false);
  assert.equal(await verify(store, order, H1, blockFor(order, { local_timestamp: "0" })), false);
  assert.equal(await verify(store, order, H1, blockFor(order, { local_timestamp: undefined })), false);
});

test("an expired order cannot be verified", async () => {
  const { store, order } = await setup(60_000);
  assert.equal(await verify(store, order, H1, blockFor(order), { nowMs: order.expiresAtMs + 1 }), false);
});

test("a late block for an expired order cannot pay a newer order with the same amount", async () => {
  const store = new InMemoryNanoOrderStore();
  const a = await issueNanoOrder({ store, payTo: PAY_TO, priceXno: "0.1", ttlMs: 1000, nowMs: 1_000_000 });
  // Force the same tagged amount onto a later order after A has expired.
  const b = { ...a, orderId: "b".repeat(32), issuedAtMs: 1_100_000, expiresAtMs: 1_200_000 };
  assert.equal(await store.put(b, 1_100_000), true);
  const blockMadeAfterAExpiredBeforeBIssued = {
    ...blockFor(b),
    local_timestamp: String(1_050_000 / 1000),
  };
  assert.equal(
    await verifyNanoPayment({
      store,
      orderId: b.orderId,
      blockHash: H1,
      fetchImpl: fakeNode(blockFromReply(blockMadeAfterAExpiredBeforeBIssued)),
      nowMs: 1_110_000,
    }),
    false,
  );
});
function blockFromReply(r) {
  return r;
}

test("plain-HTTP non-loopback RPC urls are refused", async () => {
  assert.throws(() => assertSafeRpcUrl("http://rpc.example.com"));
  assert.throws(() => assertSafeRpcUrl("ftp://x"));
  assert.throws(() => assertSafeRpcUrl("not a url"));
  assertSafeRpcUrl("https://rpc.nano.to");
  assertSafeRpcUrl("http://127.0.0.1:7076");
  assertSafeRpcUrl("http://localhost:7076");
  const { store, order } = await setup();
  await assert.rejects(
    verifyNanoPayment({ store, orderId: order.orderId, blockHash: H1, rpcUrl: "http://rpc.example.com", fetchImpl: fakeNode(blockFor(order)) }),
  );
});

test("an oversized node response is refused", async () => {
  const { store, order } = await setup();
  const big = async () => ({
    ok: true,
    headers: { get: () => String(10 * 1024 * 1024) },
    async text() {
      return "{}";
    },
  });
  assert.equal(
    await verifyNanoPayment({ store, orderId: order.orderId, blockHash: H1, fetchImpl: big, nowMs: order.issuedAtMs }),
    false,
  );
  const long = async () => ({
    ok: true,
    headers: { get: () => null },
    async text() {
      return JSON.stringify({ pad: "x".repeat(200_000) });
    },
  });
  assert.equal(
    await verifyNanoPayment({ store, orderId: order.orderId, blockHash: H1, fetchImpl: long, nowMs: order.issuedAtMs }),
    false,
  );
});

test("the request carries a timeout signal", async () => {
  const { store, order } = await setup();
  let signal;
  const spy = async (_url, init) => {
    signal = init.signal;
    return fakeNode(blockFor(order))();
  };
  await verifyNanoPayment({ store, orderId: order.orderId, blockHash: H1, fetchImpl: spy, nowMs: order.issuedAtMs + 2000 });
  assert.ok(signal && typeof signal.aborted === "boolean");
});
