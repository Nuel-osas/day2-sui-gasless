# Native Gasless on Mainnet — Reference Architecture

How an app *should* be built to do **native gasless stablecoin transfers** on Sui
mainnet. This is the "how to do it right" blueprint — distinct from how the
protocol works internally (see `gasless-explained.md` §1) and from the gas-station
pattern (`ARCHITECTURE.md` Technique 2).

## The one rule that shapes everything

Native gasless is **narrow by design**. It only applies when *all* of these hold:

- **Mainnet.** The feature isn't granted on testnet/devnet.
- **An allowlisted stablecoin** — USDC, USDsui, SuiUSDe, USDY, FDUSD, AUSD, USDB
  (protocol config `get_gasless_allowed_token_types`; can change across versions).
- **A peer-to-peer balance transfer** — the PTB is *only* allowlisted `balance`/`coin`
  accumulator ops on that type, **no object writes**, amount **≥ 0.01**.

Everything in this architecture is either (a) satisfying those conditions, or
(b) falling back cleanly when they don't hold. **There is no sponsor and no backend
for the transfer itself** — that's the headline: it's a *client-only* flow.

## End-to-end architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ WALLET  — holds the stablecoin, needs ZERO SUI                         │
│   user intent: "send X USDC to Y"                                      │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ APP CLIENT  — SuiGrpcClient (or SuiGraphQLClient)   ← the linchpin     │
│                                                                        │
│ 1. PRE-FLIGHT eligibility                                              │
│    • coinType ∈ on-chain allowlist?                                    │
│    • amount ≥ 0.01 ?                                                   │
│    • funds available in the sender's ADDRESS BALANCE (accumulator)?    │
│    • PTB shape = only balance/coin ops, no object writes?             │
│                                                                        │
│ 2. BUILD (stateless — no coin-object versions looked up)              │
│    tx.moveCall('0x2::balance::send_funds', [USDC],                     │
│                [tx.balance({type:USDC, balance:X}), Y])                │
│    — gas is NOT set; the gRPC client detects eligibility on simulate   │
│      and sets gas_price = 0, gas_budget = 0                            │
│    — tx carries TransactionExpiration::ValidDuring (window + nonce)    │
│                                                                        │
│ 3. SIGN  — a single wallet signature (no sponsor)                     │
│ 4. signAndExecuteTransaction                                          │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ SUI PROTOCOL                                                           │
│  • validates: allowlisted type + eligible shape ⇒ accepts gas = 0     │
│  • emits accumulator events: Split (−X from sender), Merge (+X to Y)  │
│  • at checkpoint: a settlement SYSTEM-transaction applies balances    │
│    atomically — no object versioning, fully parallel                  │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
        Receipt: gas price 0, net gas 0  →  show the user "$0.00 fee"

   FALLBACK (if any pre-flight check fails, or the network is congested,
   or the wallet can't sign a gas-0 tx):
        → pay normal gas,  OR  route through a gas station (Technique 2)
```

## The components, and the decisions each one forces

### 1. Transport — use gRPC or GraphQL, not JSON-RPC
This is the single most important architectural choice. `SuiGrpcClient`
(`@mysten/sui/grpc`) and `SuiGraphQLClient` **auto-detect** gasless eligibility
during simulation and set `gas_price = 0` for you. The legacy JSON-RPC `SuiClient`
does **not** — you'd have to `tx.setGasPrice(0)` manually and hope the shape is
eligible, which fails validation if you're wrong. **Pin gRPC/GraphQL** for the
gasless path.

### 2. Eligibility is dynamic — query it, don't hardcode blindly
The allowlist is **protocol configuration that can change across protocol
versions**. Architecture: keep a config of allowlisted types, but treat it as a
cache to be **refreshed from chain**, and always let the client's simulate step be
the final arbiter. Never assume a coin is eligible because it was last week.

### 3. Funds must live in the address balance (or be converted)
`send_funds` moves a `Balance<T>`. Two sources:
- funds already in the sender's **address balance** (accumulator) — spend via
  `tx.withdrawal({...})` → `redeem_funds`;
- funds held as **`Coin<T>` objects** — convert with `coin::into_balance` (or use
  `coin::send_funds` which takes a `Coin<T>` directly).

**Onboarding implication:** when a user *receives* USDC as coin objects (e.g. from
an exchange), your app should deposit them into the address balance so subsequent
sends are gasless and stateless. Design a "consolidate into balance" step.

### 4. Construction is stateless — that's a feature, use it
Because you reference no coin object versions, transaction building needs **no
online state lookup** and parallelizes freely. The trade: replay protection now
rides on `TransactionExpiration::ValidDuring` (a ~2-epoch validity window + a
nonce), which the SDK sets. Architecture: handle **expiry** — if a built tx sits
too long unsent, rebuild it rather than retrying stale bytes.

### 5. Signing — single signature, and the wallet must cooperate
No sponsor means one signature: the sender's. But the **wallet must support signing
a gas-0 / address-balances transaction** (some wallets historically insist on
attaching a gas coin). Architecture: detect wallet capability; if unsupported, fall
back (below). For your own keypair/server-side signing, `signAndExecuteTransaction`
on the gRPC client is enough.

### 6. Always design the fallback — gasless is best-effort
Native gasless can *not* apply, for several reasons: coin not allowlisted, amount
< 0.01, PTB shape ineligible (you added a non-transfer op), the wallet can't sign
it, or — importantly — **the network is congested and gasless is deprioritized**
(fee-paying txs go first). A production app therefore has a **decision node**:

```
try gasless  →  on ineligible/timeout  →  { pay normal gas }  or  { sponsor it }
```

This is why the two techniques compose: the **gas station (Technique 2)** is the
natural fallback for the gasless path, and the catch-all for every non-stablecoin
action your app has.

### 7. No backend for the transfer
Unlike the gas station, the native path needs **no server, no sponsor key, no
policy engine**. Your "architecture" for the transfer is entirely in the client.
(You may still run a backend for *other* reasons — indexing, a sponsor for other
actions — but not for the gasless transfer.)

## Composability — staying gasless across a whole flow

**The hard wall:** eligibility requires the PTB to be *only* allowlisted
`balance`/`coin` accumulator ops on an allowlisted stablecoin. So **any object
write — and even any custom `moveCall` that writes nothing — disqualifies the whole
transaction.** You can't smuggle a state change into a gasless tx.

The move is to **maneuver, not smuggle**: keep the value-movement legs pure, and
push object creation *out* of the user's transaction.

- **Fan-out stays free.** Multiple `send_funds` in one PTB is still only accumulator
  ops → **one-to-many disbursement is gasless**: payroll, revenue splits, marketplace
  payouts, allowlisted-stablecoin airdrops — all in a single free transaction.
- **Deposit-and-settle.** Instead of the user calling your contract (mutates a
  shared object → gas), the user does a **gasless `send_funds` into your app's
  address balance**, and your app performs the object-writing settlement **later, in
  bulk, on its own dime**. The user's action is free; the state change is amortized.
- **Native + sponsored split.** When an object write must happen *for* the user
  (mint a receipt, open a position), split into two txns: **transfer leg
  native-gasless, object leg sponsored** (Technique 2). The user pays nothing
  end-to-end; only the object leg costs you.
- **Balances-first data model.** Represent state as address balances where possible;
  mint receipts/NFTs lazily or batched, not per-transfer.

**Mental model:** you can't make an object-writing *transaction* free — but you can
make the user's *experience* free by keeping money movement as pure accumulator ops
and deferring / batching / sponsoring the object legs. The constraint pushes you
toward good payment-systems design: separate the **money rail** (free, fast,
high-frequency) from the **ledger/state updates** (batched, settled, low-frequency).

## Reference implementation (mainnet)

```ts
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiGrpcClient({ url: "https://fullnode.mainnet.sui.io:443" });
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

async function sendGasless(signer, recipient, rawAmount /* 6-dp */) {
  const tx = new Transaction();
  tx.setSender(signer.toSuiAddress());
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [USDC],
    arguments: [tx.balance({ type: USDC, balance: rawAmount }), tx.pure.address(recipient)],
  });
  // NOTE: no gas set — the gRPC client detects eligibility and sets gas = 0.
  return client.signAndExecuteTransaction({ transaction: tx, signer });
  // Verify the receipt: gasUsed net == 0, gasData.price == 0.
}
```

## Build checklist

- [ ] Use `SuiGrpcClient` / GraphQL for the gasless path (never rely on JSON-RPC auto-detect).
- [ ] Pre-flight: coin allowlisted? amount ≥ 0.01? shape = pure balance/coin transfer, no object writes?
- [ ] Ensure funds are in the address balance (convert coin objects with `into_balance`).
- [ ] Don't set gas; let the client set `gas_price = 0`.
- [ ] Confirm the wallet can sign a gas-0 tx; else fall back.
- [ ] Have a fallback: normal gas or a gas station (congestion / ineligibility).
- [ ] Verify the receipt shows net gas 0 and surface "$0.00 fee".
- [ ] Refresh the allowlist from chain; don't hardcode-and-forget.

## Proof it's real

Read-only, on mainnet: `node scripts/mainnet-gasless-proof.mjs` walks
`WT4gyuLPvgeLDXBDZ79bQiQZMsjarFx8T5RXy7LFkko` — ~1,015 USDC moved for **net gas 0**,
gas price 0, zero gas coins, one signature, no sponsor.
