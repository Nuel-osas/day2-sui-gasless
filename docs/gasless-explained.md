# Gasless on Sui — Two Techniques, End to End

A teaching reference for the **two different ways to remove gas friction on Sui**.
They are complementary, not competing:

1. **Native gasless stablecoin transfers** — a *protocol-level* feature (live on
   **mainnet** since 2026-05-20). Sending an allowlisted stablecoin peer-to-peer
   costs **$0.00**, with **no sponsor and no second signature**. Built on a new
   primitive called **Address Balances** (SIP-58).
2. **Sponsored transactions** (the *gas station*) — an *app-level* pattern where a
   **sponsor** pays the gas for the user. Works for **any transaction and any
   token**, on any network.

> The one-line mental model: **an allowlisted stablecoin, sent peer-to-peer → use
> the native feature (free, nothing to run). Anything else you want to feel
> gasless → sponsor it.** A real app often uses *both* — native for stablecoin
> payments, a sponsor for its swaps / mints / app calls.

Day 2 of the Sui stack (Day 1 = confidential transfers, Day 3 = tunnels).

---
---

# Technique 1 — Native gasless stablecoin transfers (Address Balances / SIP-58)

## 1.0 The one-paragraph mental model

Sui normally holds every coin as an **object** — a `Coin<T>` with its own id and
version (UTXO-style: you select, split, and merge coins, and every transfer
*writes objects*). **Address Balances** add a second model: a canonical
**per-address, per-type balance** — an account-style number keyed by
`(address, CoinType)`. Moving an allowlisted stablecoin over this balance is such
a **bounded, no-object-write** operation that the **protocol itself accepts it
with `gas_price = 0` and no gas coin at all.** No sponsor pays; the network
settles it. That is what "gasless stablecoin transfer" means on Sui — and it's
why Sui became the first L1 to zero stablecoin gas at the protocol level (it moved
~**$65B in its first five days**).

> **Native gasless ≠ sponsored.** There is **no sponsor, no second signature, no
> service to run.** The user signs one transaction with `gas = 0` and the protocol
> settles it. This is a property of the chain, not of your app.

## 1.1 The model shift — objects → an accumulator (account model)

| `Coin<T>` object model (classic) | Address Balances (SIP-58) |
|---|---|
| Each coin is an on-chain **object** (id + version + balance) | One **balance number** per `(address, T)` |
| You **select / split / merge** coins; every move **writes objects** | Deposits **auto-merge**; nothing to manage |
| Transaction building is **stateful** (must know coin versions) | Transaction building is **stateless** (no versions to look up) |
| Parallelism limited by object contention | **Unlimited parallel** deposits + withdrawals |

An Address Balance is stored as a **dynamic field under a single root accumulator
object at id `0xacc`**, keyed by `(SuiAddress, T)`. `T` only needs a **commutative
merge/split** — which is exactly what money is.

## 1.2 The accumulator mechanism — events, not object writes

A native transfer does **not** mutate a coin object. It **emits an "accumulator
event"**:

- **Merge** = a deposit (add to the recipient's balance)
- **Split** = a withdrawal (subtract from the sender's balance)

At **checkpoint construction**, validators **aggregate** all the accumulator
events and apply them via **settlement system-transactions** that atomically
update the balances. Because the hot path emits events instead of versioning
objects, there is **no object contention** on a balance update.

### Why that makes it free *and* parallel — and safe from abuse

- **Deposits** merge into an accumulator with **no locking**.
- **Withdrawals** are *reserved before execution* via a new transaction input,
  `CallArg::FundsWithdrawal` (reservation amount + currency type + fund owner).
  The scheduler guarantees no underflow up front, so there are **no account-level
  locks at execution time**. At runtime the reservation becomes a
  `0x2::funds_accumulator::Withdrawal<T>` (with `split` / `join`); crucially, a
  withdrawal is **"not withdrawn unless redeemed."**
- Because the operation is **bounded, commutative, and writes no objects**, the
  protocol can safely execute it with **`gas_price = 0` and an empty
  `gas_payment`** — settlement is cheap and spam-limited (see guardrails, §1.5).

## 1.3 The Move API (framework `0x2`)

```move
// Deposit a Balance into a recipient's funds accumulator (send).
public fun send_funds<T>(balance: Balance<T>, recipient: address)

// Redeem a reserved withdrawal into a usable Balance (coin:: variant returns Coin<T>).
public fun redeem_funds<T>(w: Withdrawal<Balance<T>>): Balance<T>

// Withdraw from an OBJECT-owned balance — needs &mut UID, so it is NOT parallel.
public fun withdraw_funds_from_object<T>(obj: &mut UID, value: u64): Withdrawal<Balance<T>>
```

Helpers: `coin::into_balance` (Coin → Balance), `coin::send_funds` (send a Coin
directly), and `withdrawal_split` / `withdrawal_join` on a `Withdrawal<T>`.

## 1.4 TypeScript — a stateless, gasless send

```ts
// SEND an allowlisted stablecoin to an address balance
const tx = new Transaction();
tx.moveCall({
  target: "0x2::balance::send_funds",
  typeArguments: [USDC],
  arguments: [tx.balance({ type: USDC, balance: 1_000_000n }), tx.pure.address(to)],
});
// gRPC/GraphQL transports auto-DETECT eligibility and set gas=0 during simulation.
// On JSON-RPC you set it yourself:  tx.setGasPrice(0)  (+ empty gas payment)

// WITHDRAW / redeem from your address balance back into a Coin
const [coin] = tx.moveCall({
  target: "0x2::coin::redeem_funds",
  typeArguments: [USDC],
  arguments: [tx.withdrawal({ amount: 1_000_000, type: USDC })],
});
```

Transaction building is **fully stateless** — `tx.withdrawal({ amount, type })`
needs **no coin object versions**, so a client can build a valid transfer offline
without querying chain state. RPC now separates the two models:
`getBalance` returns **`coinBalance`** vs **`addressBalance`** vs **`totalBalance`**
(the `fundsInAddressBalance` field).

## 1.5 Eligibility & guardrails (all protocol config)

Native gasless is **narrow by design** — that narrowness is the security model.

- **Allowlist** — `get_gasless_allowed_token_types`. Only these qualify:
  **USDC, USDsui, SuiUSDe, USDY, FDUSD, AUSD, USDB**. Your own token **cannot**
  opt in (it's governance-gated, mainnet-only).
- **Feature flag** — `enable_address_balance_gas_payments`.
- **Transaction shape** — the PTB must be **only** allowlisted balance/coin
  accumulator ops on an allowlisted type, with **no object writes**.
- **Minimum transfer** — **0.01**; smaller transfers are rejected.
- **Congestion** — when the network is busy, **fee-paying transactions are
  prioritized** over gasless ones.
- **Replay** — stateless transactions are bounded by a **two-epoch validity
  window + a nonce** (`TransactionExpiration::ValidDuring`), using validator
  digests from the current/prior epoch.

**Who pays?** No one attaches gas; the **protocol absorbs** the bounded settlement
cost. The allowlist + minimum + no-object-writes + congestion deprioritization are
precisely what stop it from becoming a spam or free-compute vector.

## 1.6 The proof — a real mainnet gasless transfer

You **cannot** reproduce true `gas = 0` with a custom token — the allowlist is
mainnet-only and governance-gated. (The Address Balances API itself —
`send_funds` / `redeem_funds` — is usable on testnet, but the protocol only grants
`gas = 0` to **allowlisted** coins.) So the honest proof is a real mainnet tx:

```
digest:  WT4gyuLPvgeLDXBDZ79bQiQZMsjarFx8T5RXy7LFkko   (suiscan.xyz/mainnet/tx/…)
gas price:      0        gas budget: 0        gas coins attached: 0
computation:    3927528 MIST     storage rebate: 3927528 MIST
NET GAS PAID:   0 MIST   ← $0.00
calls:   0x2::coin::into_balance · 0x2::balance::send_funds · 0x2::coin::send_funds
type:    0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC
moved:   ~1,015 USDC   sender → recipient      status: success
```

Reproduce it: **`node scripts/mainnet-gasless-proof.mjs`** (reads the tx off a
mainnet fullnode and prints the breakdown). No sponsor, no gas coin — the protocol
accepted a `gas = 0` transfer because **USDC is on the gasless allowlist.**

---
---

# Technique 2 — Sponsored transactions (the gas station)

When the native feature doesn't apply — **your own token**, a **swap**, an **NFT
mint**, **any app call** — you make it gasless the app-level way: a **sponsor**
pays the gas so the user (holding **0 SUI**) only signs.

## 2.1 The mental model — split the intent from the gas

Every Sui transaction carries an **intent** (what to do) and a **gas payment** (a
SUI coin). Normally both come from one wallet. Sponsorship **splits the roles**:
the **sender** owns + signs the intent; a separate **sponsor** owns the gas coin
and signs to pay. One transaction, **two signatures**, sender needs zero SUI.

| The SENDER (user) | The SPONSOR (gas station) |
|---|---|
| Owns the **intent** (`TransactionKind`) | Owns the **gas coin** (`Coin<SUI>`) |
| Signs as sender (`tx.sender`) | Signs as gas owner (`tx.gasOwner`) |
| Needs **zero SUI** | Needs SUI to pay gas |
| Cannot be impersonated | Can **refuse** (censor) but cannot **steal** |

> **Sponsored ≠ free.** Someone pays — the sponsor. "Gasless" here is a UX
> property. Both parties are **public on-chain**.

## 2.2 The mechanism — the two-signature handshake

The sender and sponsor **must sign the *same bytes*.** The sponsor builds the
final transaction (gas selection changes the bytes), then the sender signs the
sponsor's output.

```
 CLIENT (user)                         GAS STATION (sponsor)
 build intent (Transaction)
 setSender(user)
 build({ onlyTransactionKind: true })
        │  txKindBytes (NO gas)  ─────►  Transaction.fromKind(txKindBytes)
        │                               setSender(user)
        │                               setGasOwner(sponsor)
        │                               setGasPayment([sponsorCoin])
        │                               setGasBudget(...)
        │                               txBytes = build()      ← final bytes
        │  ◄── { txBytes, sponsorSig } ─ sponsorSig = sign(txBytes)
 senderSig = sign(txBytes)   ← the SAME bytes
        └── executeTransactionBlock({ transactionBlock: txBytes,
                                      signature: [senderSig, sponsorSig] })
```

**Client — serialize the intent only** (`packages/gas-station/src/client.ts`):

```ts
tx.setSender(sender);
const kind = await tx.build({ client, onlyTransactionKind: true }); // no gas
const { txBytes, sponsorSignature } = await sponsor({ txKindBytes: toB64(kind), sender });
const { signature: senderSignature } = await signAsSender(fromB64(txBytes)); // SAME bytes
return client.executeTransactionBlock({
  transactionBlock: txBytes,
  signature: [senderSignature, sponsorSignature],
});
```

**Sponsor — attach gas, sign, return** (`packages/gas-station/src/station.ts`):

```ts
const tx = Transaction.fromKind(kindBytes);
tx.setSender(req.sender);
tx.setGasOwner(this.sponsorAddress);
tx.setGasPayment([{ objectId, version, digest }]); // a sponsor-owned SUI coin
tx.setGasBudget(this.gasBudget);
const txBytes = await tx.build({ client: this.client });
const { signature } = await this.signer.signTransaction(txBytes);
return { txBytes: toB64(txBytes), sponsorSignature: signature };
```

> **Golden rule:** sender and sponsor **sign identical bytes**. The sponsor builds
> first; the sender signs the sponsor's output. Sign pre-gas bytes and it fails.

## 2.3 Gas station internals

- **Reserve a gas coin** — list the sponsor's SUI coins, pick the largest that
  covers the budget **and isn't already reserved** by an in-flight request.
- **Equivocation (the #1 footgun)** — if two concurrent sponsorships grab the
  *same* coin and both submit, the coin is **locked as equivocated until end of
  epoch** (~24h). Never hand one coin to two in-flight txs; the `locked` set does
  this in-process, Redis/DB across processes.
- **Coin pool** — one coin = one tx at a time. To sponsor *N* in parallel, split
  the sponsor's balance into *N* coins.
- **Gas budget** — default `20_000_000` MIST (0.02 SUI); unused gas is refunded.

## 2.4 Policy — the seam that stops a drained wallet

A **naive open sponsor pays for anyone's transactions.** `GasStation` takes a
`SponsorPolicy: (req) => null | reason`:

```ts
policy: allOf(
  onlyPackages([FUSD_PKG]),   // only sponsor calls into MY package
  rateLimit(10, 60_000),      // per-sender cap
)
```

Typical guards: **allowlist target package**, **per-sender rate limit**, **per-tx
gas cap**, **daily budget cap**. Note a pure coin transfer carries **no MoveCall**,
so this repo's FUSD exposes a `fusd::pay` MoveCall — that's what lets `onlyPackages`
strictly authorize a stablecoin send.

## 2.5 The verified demo (`scripts/gasless-e2e.mjs`, `app/`)

A fresh user with **0 SUI** claims FUSD and sends it, sponsor paying gas:

```
user SUI:       0.0000  (still ZERO — never paid gas)
recipient FUSD: 3.00
gas paid by sponsor: 0.0023 SUI
```

Real testnet run — gasless transfer via `fusd::pay`:
[`BW7k9MGfLfZdaCYKgiY7C6NGufXaZiXpxr1Tuva4BxvC`](https://suiscan.xyz/testnet/tx/BW7k9MGfLfZdaCYKgiY7C6NGufXaZiXpxr1Tuva4BxvC)
— user held 0 SUI, sponsor paid 0.0023 SUI. The app's live `/api/sponsor` endpoint
is verified the same way (`scripts/verify-app-endpoint.mjs`).

## 2.6 Composability — sponsor anything

The station's input is **just a `TransactionKind`**, so anything can be made
gasless by routing its intent through it:

| Sponsor this intent… | …and you get |
|---|---|
| A **Day-1 confidential transfer** | Gasless **and** private (hidden amount, zero SUI) |
| An NFT mint / a DEX swap | Gasless mint / gasless trade |
| A **Day-3 tunnel settlement** | Gasless channel close |
| **Your own token** transfer | Gasless payments for a non-allowlisted coin |

---
---

# When to use which

| | **Native (Address Balances)** | **Sponsored (gas station)** |
|---|---|---|
| Who allows free | The **protocol** | An **app-run sponsor** pays |
| Signatures | **Sender only** | **Sender + sponsor** |
| Works for | **Only allowlisted stablecoins**, P2P transfer | **Any tx, any token** (swaps, mints, app calls, your coin) |
| Cost | Absorbed by the protocol (bounded) | The sponsor's SUI |
| Infra to run | **None** | A gas-station service + funded sponsor + policy |
| Network | **Mainnet** (allowlist) | Any network |
| Underlying tech | Accumulator / `send_funds` / SIP-58 | Two-signature `TransactionData` (gas owner ≠ sender) |

**Rule of thumb:** sending an **allowlisted stablecoin peer-to-peer** → native
(free, nothing to run). **Anything else** you want to feel gasless → **sponsor
it**. They **compose**: a payments app can settle stablecoin transfers natively
and sponsor its own non-transfer actions.

> **Why this matters here (Africa / Nigeria):** the biggest onboarding killer is
> "first, go buy SUI for gas." Native gasless deletes it for stablecoins with
> *nothing to run*; sponsorship deletes it for everything else. Either way, "no
> SUI needed" stops being a nice-to-have and becomes the product.

---

# Edge cases & gotchas

| # | Technique | Case | Rule |
|---|---|---|---|
| 1 | Native | **Non-allowlisted token** | `gas = 0` is refused. Only USDC/USDsui/SuiUSDe/USDY/FDUSD/AUSD/USDB qualify; your own coin never will. Use a sponsor instead. |
| 2 | Native | **Transfer below 0.01** | Rejected by the minimum-transfer rule. |
| 3 | Native | **PTB does more than a balance/coin op** | Any object write / non-allowlisted call disqualifies it from gasless — it needs gas. Keep gasless PTBs to pure `send_funds`/`redeem_funds`. |
| 4 | Native | **JSON-RPC transport** | Only gRPC/GraphQL auto-detect eligibility. On JSON-RPC you must set `gasPrice(0)` yourself, or it's treated as a normal (paid) tx. |
| 5 | Native | **Network congested** | Gasless is **deprioritized** behind fee-payers; a free transfer may wait. Paying a fee jumps the queue. |
| 6 | Native | **Reproducing on testnet** | The API works, but `gas = 0` isn't granted to custom coins — verify the concept with the **real mainnet tx** (`mainnet-gasless-proof.mjs`), not a testnet mint. |
| 7 | Sponsor | **Sender signs stale bytes** | ⚠️ Most common bug. Sign the bytes the **sponsor** built (post-gas), not the pre-gas kind, or the two signatures cover different messages. |
| 8 | Sponsor | **Gas coin equivocated** | Two in-flight txs sharing one coin → coin frozen till epoch end (~24h). Lock reserved coins; pool in prod. |
| 9 | Sponsor | **Open sponsor with no policy** | Drained wallet. Add `onlyPackages` + `rateLimit` + a per-tx cap. |
| 10 | Sponsor | **Sponsor griefs (never submits)** | User signed, nothing lands — annoying, not theft. Have the client submit / time out + retry. |
| 11 | Both | **Testnet public fullnode 404s** | `https://fullnode.testnet.sui.io` returns **404 for JSON-RPC**. We pin `https://sui-testnet-rpc.publicnode.com`; mainnet reads use `https://sui-rpc.publicnode.com`. |

---

# Security model — one screen

**Native gasless**
- **No sponsor, no second signature** — the protocol settles it.
- **Narrowness *is* the security**: allowlist + min 0.01 + no object writes +
  congestion deprioritization keep "free" from being a spam / free-compute vector.
- **Not anonymous** — sender, recipient, and amount are public (compose with Day 1
  for privacy).

**Sponsored**
- **Gasless, not trustless-free** — the sponsor pays; protect it with **policy**.
- **Sponsor can censor, never steal** — the sender's signature binds the intent.
- **Equivocation is self-inflicted** — never reuse a gas coin concurrently.
- **Both parties public** — sender and sponsor are on-chain.

---

# Cheat-sheet

**Native (allowlisted stablecoin, P2P):**
`0x2::balance::send_funds<T>(balance, recipient)` · `0x2::coin::redeem_funds<T>(withdrawal)` ·
`tx.withdrawal({ amount, type })` · **`gas_price = 0`, no gas coin** · gRPC/GraphQL auto-detect ·
allowlist `get_gasless_allowed_token_types` · flag `enable_address_balance_gas_payments` ·
min 0.01 · root accumulator `0xacc` · proof `WT4gyuLPvgeLDXBDZ79bQiQZMsjarFx8T5RXy7LFkko`.

**Sponsored (anything else):**
sponsor builds final `txBytes` → sender signs *those* bytes → `signature: [senderSig, sponsorSig]`.
Client: `tx.build({ onlyTransactionKind: true })`. Sponsor: `Transaction.fromKind` · `setGasOwner` ·
`setGasPayment([coin])` · `setGasBudget` · `signTransaction`. Policy: `onlyPackages` · `rateLimit` ·
per-tx cap. Anti-drain: policy ✔ · coin pool ✔ · reservation lock ✔ · budget cap ✔.

**Deployed (Technique-2 demo, testnet):**
- RPC: `https://sui-testnet-rpc.publicnode.com`
- FUSD package: `0x25c5d3b509841312696b353a9218d1992caccafd03ca6f198f9fd7dfd7011efd`
- FUSD faucet (shared): `0xe6dda9812f7d7f84eadd0686690c2c8b9d56b2dea2af018dcd73efb5794b583b`
- coinType: `0x25c5d3b509841312696b353a9218d1992caccafd03ca6f198f9fd7dfd7011efd::fusd::FUSD`
- sponsor: `0x9a5b0ad3a18964ab7c0dbf9ab4cdecfd6b3899423b47313ae6e78f4b801022a3`
- verified sponsored tx: `BW7k9MGfLfZdaCYKgiY7C6NGufXaZiXpxr1Tuva4BxvC`

**Native proof (mainnet):** `node scripts/mainnet-gasless-proof.mjs` — USDC moved for **0 MIST** gas.
