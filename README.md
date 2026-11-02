# paybond-mcp-coding-agent

MCP coding agent (read-only + one paid tool). Clone, log in to Paybond sandbox, and run smoke in under a minute.

## Quickstart (60 seconds)

```bash
git clone https://github.com/nonameuserd/paybond-mcp-coding-agent.git
cd paybond-mcp-coding-agent
cp .env.example .env.local
paybond login
npm install
npm run smoke
```

## Run the demo

```bash
npm start
```

## MCP host wiring

```bash
paybond login
paybond mcp install --host claude --tool-policy spend-write
paybond mcp verify-config --host claude
```

Read-only tools pass through; side-effecting tools require Harbor authorization.

## Policy

Local `paybond.policy.yaml` is yours to edit. Bundled preset: **custom**.

## Docs

- [Agent quickstart](https://paybond.ai/docs/kit/quickstart-agent)
- [Agent middleware](https://paybond.ai/docs/kit/agent-middleware)

## Optional: feeless Nano (XNO) settlement for paid tools

`src/nano.ts` is a small, optional, receive-only Nano (XNO) settlement verifier. A Nano
block has no memo, so a confirmed send proves only that an amount reached an account; the
seller therefore binds each block to one issued order:

```ts
import { InMemoryNanoOrderStore, issueNanoOrder, verifyNanoPayment } from "./nano.js";

const store = new InMemoryNanoOrderStore(); // use a database-backed store in production

// 402 step: issue an order; give the requester orderId, payTo and amountRaw.
const order = await issueNanoOrder({ store, payTo: MY_NANO_ACCOUNT, priceXno: "0.1" });

// Paid retry: the requester presents orderId AND the block hash it sent.
const settled = await verifyNanoPayment({ store, orderId, blockHash });
if (!settled) throw new Error("payment not verified");
```

- The order id is an opaque 128-bit secret; a block hash alone is never accepted.
- The amount carries a random per-order tag that no other open order for the account
  shares, and the block must be a confirmed send of exactly that amount to exactly that
  account, made inside the order's issue-to-expiry window (the block's own time).
- `blockHash -> orderId` is claimed once in the store: a hash cannot pay a second order,
  and a paid order takes no second block. `InMemoryNanoOrderStore` is for tests and one
  process; a seller that restarts or runs several workers implements `NanoOrderStore`
  over a database with a UNIQUE index on the block hash and on the order id.
- Node lookups time out (8 s default) and cap the response (64 KiB default); a plain-HTTP
  RPC URL is refused unless it is loopback.

Keyless: no private key is held, no gas, no facilitator. Verification is fail-closed.
Tests (Node's built-in `node:test`, no network) run against the compiled output:
`npm run build`, then `npm test`.
