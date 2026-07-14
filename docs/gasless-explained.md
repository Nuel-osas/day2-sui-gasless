# Gasless (Sponsored) Transactions on Sui — End to End

A teaching reference for how **sponsored transactions** let a user who holds
**zero SUI** still transact, because a **sponsor** pays the gas. Grounded in the
Move + TypeScript in this repo and in real, verified **testnet** transactions.
Day 2 of the Sui stack (Day 1 = confidential transfers, Day 3 = tunnels).

---

## 0. The one-paragraph mental model

Every Sui transaction carries two things: the **intent** (what to do — "send 3
FUSD to Ada") and the **gas payment** (a SUI coin that pays for execution).
Normally both come from the same wallet, which is why a first-time user is told
to *go buy SUI before they can move their stablecoin*. **Sponsored transactions
split those two roles.** The **sender** owns and signs the intent; a separate
**sponsor** owns the gas coin and signs to pay for it. One transaction, **two
signatures**, and the sender never needs a single MIST of SUI.

> **Gasless ≠ free.** Someone still pays — the **sponsor**. The user pays zero;
> the cost moves to whoever runs the gas station. "Gasless" is a UX property, not
> a physics one.

---

## 1. What is whose — sender vs. sponsor

| The SENDER (the user) | The SPONSOR (the gas station) |
|---|---|
| Owns the **intent** (the `TransactionKind`) | Owns the **gas coin** (a `Coin<SUI>`) |
| Signs the transaction as sender | Signs the transaction as gas owner |
| Needs **zero SUI** | Needs SUI to pay gas |
| Its address is `tx.sender` | Its address is `tx.gasOwner` |
| Cannot be impersonated — the sponsor can't alter what it signed | Can **refuse** (censor) but cannot **steal** |

Both facts are **public on-chain**: anyone reading the transaction sees the
sender *and* that the sponsor's coin paid. Gasless is about who *pays*, not about
hiding anything (that's Day 1).

---

## 2. The mechanism — the exact handshake

A sponsored transaction is built in **two halves that must sign the *same
bytes***. The order matters: the sponsor builds the final transaction (because
gas selection changes the bytes), then the sender signs what the sponsor built.

```
 CLIENT (user)                         GAS STATION (sponsor)
 ─────────────                         ─────────────────────
 build intent (a Transaction)
 setSender(user)
 build({ onlyTransactionKind: true })
        │  txKindBytes  (NO gas yet)
        │ ───────────────────────────►  Transaction.fromKind(txKindBytes)
        │                               setSender(user)
        │                               setGasOwner(sponsor)
        │                               setGasPayment([sponsorCoin])
        │                               setGasBudget(...)
        │                               txBytes = build()          ← final bytes
        │                               sponsorSig = sign(txBytes)
        │  ◄─────────────────────────── { txBytes, sponsorSig }
 senderSig = sign(txBytes)   ← the SAME bytes
        │
        └── executeTransactionBlock({ transactionBlock: txBytes,
                                      signature: [senderSig, sponsorSig] })
```

### 2.1 Client side — serialize the *intent only*

The client builds a normal `Transaction` and serializes it **without gas** using
`onlyTransactionKind: true`. That's the whole trick on the client: describe
*what* to do, attach *nothing* about paying for it.

```ts
// packages/gas-station/src/client.ts (shape)
tx.setSender(sender);
const kind = await tx.build({ client, onlyTransactionKind: true }); // no gas
const { txBytes, sponsorSignature } = await sponsor({ txKindBytes: toB64(kind), sender });
const { signature: senderSignature } = await signAsSender(fromB64(txBytes));
return client.executeTransactionBlock({
  transactionBlock: txBytes,
  signature: [senderSignature, sponsorSignature], // sender + sponsor
});
```

### 2.2 Sponsor side — attach gas, sign, return

The gas station rehydrates the intent with `Transaction.fromKind`, sets the
sender, points the gas at **its own** coin, builds, and signs:

```ts
// packages/gas-station/src/station.ts (core)
const tx = Transaction.fromKind(kindBytes);
tx.setSender(req.sender);
tx.setGasOwner(this.sponsorAddress);
tx.setGasPayment([{ objectId, version, digest }]); // a sponsor-owned SUI coin
tx.setGasBudget(this.gasBudget);

const txBytes = await tx.build({ client: this.client });
const { signature } = await this.sponsor.signTransaction(txBytes);
return { txBytes: toB64(txBytes), sponsorSignature: signature };
```

> **The golden rule:** the **sender and sponsor sign identical bytes.** That's
> why the sponsor builds *first* and the sender signs the sponsor's output. If
> the sender signs bytes built before gas was attached, the signatures cover
> different messages and execution fails. (See edge case #3.)

---

## 3. Why *Sui* makes this clean

- **First-class in the protocol.** Sui's transaction format has a distinct
  **gas owner** separate from the **sender**; sponsorship isn't a bolt-on, it's
  native. Two signers, one `TransactionData`.
- **`onlyTransactionKind`.** The SDK can serialize the intent *without* gas, so
  the client never has to know which coin will pay — the sponsor decides that.
- **Object-scoped signatures.** Because Sui signs over concrete object
  references (the exact gas coin version), the sponsor fully controls and bounds
  what its coin is used for — it can't be tricked into paying for a different
  transaction than it signed.

---

## 4. The gas station internals (`GasStation`)

The station is deliberately tiny and **app-agnostic**. Its whole job:

```
in:   { txKindBytes, sender }
out:  { txBytes, sponsorSignature }
```

### 4.1 Reserving a gas coin — and why it's the hard part

`reserveGasCoin()` lists the sponsor's SUI coins and picks the largest one that
covers the budget **and isn't already reserved** by an in-flight request:

```ts
const free = data
  .filter((c) => !this.locked.has(c.coinObjectId)) // not reserved
  .filter((c) => BigInt(c.balance) >= this.gasBudget)
  .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
```

**Why the lock matters (the #1 production footgun): object equivocation.** If two
concurrent sponsorships both grab the *same* gas coin and both get signed and
submitted, they reference the same object version. The validators accept one and
the coin is now **locked as equivocated until the end of the epoch** — the
sponsor's coin is frozen for up to ~24h. So a gas station must **never hand the
same coin to two in-flight transactions.** The in-memory `locked` set does this
for a single process.

### 4.2 Coin pool — throughput

One coin = one transaction at a time (per the lock above). To sponsor *N*
transactions in parallel, the sponsor needs *N* separate SUI coins. In
production you **split the sponsor's balance into a pool** of many coins (e.g.
100 × 0.1 SUI) and hand out a different one per request. A multi-process gas
station replaces the in-memory `Set` with a shared reservation (Redis, a DB row
lock, or Mysten's reference gas-station service).

### 4.3 Gas budget

`gasBudget` (default `20_000_000` MIST = 0.02 SUI) is the ceiling the sponsor is
willing to spend on one transaction. Unused gas is refunded to the sponsor;
setting it too low aborts execution (edge case #1). A real gas coin must hold
*at least* the budget.

---

## 5. End-to-end lifecycle (from `scripts/gasless-e2e.mjs`)

The verified script proves the whole point: a fresh user with **0 SUI** ends up
having sent a stablecoin.

### Step 0 — A stablecoin exists (`move/sources/fusd.move`)

FUSD is a plain `Coin<FUSD>` (6 decimals). The only special bit is a **shared
`Faucet`** wrapping the `TreasuryCap` so anyone can `mint`. Nothing in the coin
knows about gas — **gaslessness lives in how the transfer is sponsored, not in
the asset.**

```move
public entry fun mint(faucet: &mut Faucet, amount: u64, recipient: address, ctx: &mut TxContext) {
    let c = coin::mint(&mut faucet.cap, amount, ctx);
    transfer::public_transfer(c, recipient);
}
```

### Step 1 — User gets stablecoins, still holds 0 SUI

The sponsor mints FUSD to the user (sponsor pays that gas too). The user now has
FUSD and **zero SUI**.

### Step 2 — The gasless transfer

The user builds a split-and-transfer intent over their FUSD, and `sponsorAndSend`
does the handshake from §2. The user signs; the sponsor pays.

```ts
const tx = new Transaction();
const [sent] = tx.splitCoins(tx.object(userCoin), [tx.pure.u64(3n * ONE_FUSD)]);
tx.transferObjects([sent], tx.pure.address(recipient));
await sponsorAndSend(sponsor, tx, user); // user pays 0 gas
```

### Step 3 — Verify

```
user SUI:       0.0000  (still ZERO — never paid gas)
recipient FUSD: 3.00
gas paid by sponsor: 0.0023 SUI
```

**Real testnet run:**
- gasless transfer: [`GARm8aaLyURVbQvFgYEuRvE5WyAnwgJhBqzxUKNN5Nq6`](https://suiscan.xyz/testnet/tx/GARm8aaLyURVbQvFgYEuRvE5WyAnwgJhBqzxUKNN5Nq6)
  — user held 0 SUI, sponsor paid 0.0023 SUI.

```
Full gasless send, at a glance:

  USER (0 SUI)                          SPONSOR (has SUI)
  build intent ─ sign as sender ──┐
                                  │  (sponsor attaches gas + signs)
                                  └──► executeTransactionBlock([senderSig, sponsorSig])
                                       user pays 0 · sponsor pays gas · recipient credited
```

---

## 6. Security & abuse — the part that bites in production

A **naive open sponsor pays for *any* transaction anyone sends it.** That's a
drained wallet waiting to happen. The trust model and defenses:

### 6.1 What the sponsor *can* and *cannot* do

- ✅ **Refuse / censor** — decline to sponsor (that's the policy hook below).
- ✅ **Grief** — sign nothing, or accept the intent and then *not submit* it
  after the user signed. Annoying, not theft. (Mitigate: client submits, or a
  short timeout + retry.)
- ❌ **Steal / alter the intent** — impossible. The sender's signature covers the
  *exact* bytes, including the intent. The sponsor can only pay for what the user
  signed, or pay for nothing.
- ⚠️ **Equivocate its own gas coin** — a *self*-inflicted risk (§4.1), fixed by
  the reservation lock.

### 6.2 Policy — the single seam for defense

`GasStation` takes an optional `SponsorPolicy`: `(req) => null | reason`. Return
`null` to allow, a string to reject. This is where every real-world guard goes:

```ts
const policy: SponsorPolicy = ({ sender, tx }) => {
  // allowlist: only sponsor calls into MY package
  const calls = tx.getData().commands.filter((c) => c.MoveCall);
  if (!calls.every((c) => c.MoveCall.package === MY_PACKAGE)) return "not my package";
  if (await rateLimiter.exceeded(sender)) return "rate limit";     // per-sender cap
  if (estimatedGas(tx) > MAX_TX_GAS) return "over per-tx cap";     // per-tx cap
  return null; // ✅ sponsor it
};
```

Typical policies: **allowlist target package/function**, **per-sender rate
limit**, **per-tx gas cap**, **daily budget cap**, **KYC/session gating**. Without
one, assume your sponsor gets drained.

---

## 7. Composability — why it's built "plug and play"

The station's input is **just a `TransactionKind`** — it never inspects the
asset or the app beyond policy. So **anything** can be made gasless by routing
its intent through the same station:

| Sponsor this intent… | …and you get |
|---|---|
| A stablecoin transfer (this repo) | Gasless payments |
| A **Day-1 confidential transfer PTB** | **Gasless *and* private** — hidden amount, zero SUI |
| An NFT mint / a DEX swap | Gasless mint / gasless trade |
| A **Day-3 tunnel settlement** | Gasless channel close |
| Any Move call your app makes | Gasless onboarding for that app |

Same `GasStation`, same two-signature handshake. The gas station is asset- and
app-agnostic infrastructure — drop it into any Sui dApp.

---

## 8. Why this is the real unlock (Africa / Nigeria framing)

The single biggest onboarding killer in Lagos, Nairobi, or anywhere: to send $5
of stablecoins, a first-time user is told to *first buy a different token (SUI)
for gas*. That step ends more sessions than any UI problem. Sponsored
transactions delete it — the user holds only the stablecoin they care about and
sends it. "No SUI needed" isn't a nice-to-have here; it's the whole product.

---

## 9. Edge cases & gotchas (the part students trip on)

| # | Case | What happens / rule |
|---|---|---|
| 1 | **Gas budget too low** | Execution aborts (`InsufficientGas`). Raise `gasBudget`; unused gas is refunded, so a generous budget is safe. |
| 2 | **Sponsor out of funds / no coin covers budget** | `reserveGasCoin` throws "gas station out of funds." Top up, or split the sponsor's balance into more/larger coins. |
| 3 | **Sender signs stale bytes** | ⚠️ Most common bug. The sender **must sign the bytes the *sponsor* built** (post-gas), not the pre-gas kind. Sign the sponsor's `txBytes`, or both signatures cover different messages and it fails. |
| 4 | **Gas coin locked by a concurrent sponsorship** | Two in-flight txs sharing one coin → equivocation → coin frozen till epoch end (~24h). The `locked` set prevents it in-process; use a shared lock across processes. |
| 5 | **Sponsor == sender (same address)** | Allowed but degenerate — it's just a normal self-paid tx. The e2e's *mint* step does exactly this (sponsor is also sender). Gasless only matters when they differ. |
| 6 | **Intent references objects the sender doesn't own** | Passes building, **fails at execution** (the sender can't touch objects it doesn't own). Policy/UX should catch this early. |
| 7 | **Sponsor griefs (never submits)** | The user signed but nothing lands. Not theft — no state changed. Have the *client* submit, or time out and retry. |
| 8 | **Testnet public fullnode 404s** | ⚠️ `https://fullnode.testnet.sui.io` returns **404 for JSON-RPC** (SDK `getFullnodeUrl('testnet')` hits it). We pin a working RPC: **`https://sui-testnet-rpc.publicnode.com`** (see `scripts/deployed.json`). |
| 9 | **Devnet/testnet reset** | Object IDs stop resolving after a network wipe. Re-publish `move/`, repaste IDs into `deployed.json`. Testnet resets far less often than devnet — prefer testnet for a demo. |
| 10 | **Object version drift on the gas coin** | `setGasPayment` needs the coin's current `{objectId, version, digest}`. If the sponsor used that coin elsewhere between read and sign, the version is stale → rebuild. The per-request read + lock keeps this fresh. |
| 11 | **Two signatures, order** | `signature: [senderSig, sponsorSig]` — Sui matches signatures to the sender and gas owner by their public keys, but keep the convention sender-first for clarity. |

---

## 10. Security model — one-screen summary

- **Gasless, not trustless-free.** The sponsor pays; protect it with **policy**.
- **Sponsor can censor, never steal.** The sender's signature binds the intent;
  the sponsor only chooses to pay or not.
- **Equivocation is self-inflicted.** Never reuse a gas coin across concurrent
  sponsorships — lock it, or run a coin pool.
- **Both parties are public.** Sender and sponsor are on-chain. Want the *amount*
  hidden too? Compose with Day 1 (confidential + gasless).
- **The intent is the contract.** Everything downstream (policy, gas, signing)
  is arranged around bytes the sender authored and signed.

---

## 11. Cheat-sheet

**The two-signature rule:** sponsor builds the final `txBytes` → sender signs
*those* bytes → submit `signature: [senderSig, sponsorSig]`.

**Client (intent, no gas):**
`tx.setSender(u)` · `tx.build({ onlyTransactionKind: true })`

**Sponsor (attach gas, sign):**
`Transaction.fromKind(kind)` · `setSender` · `setGasOwner` · `setGasPayment([coin])`
· `setGasBudget` · `build()` · `sponsor.signTransaction(bytes)`

**Submit:**
`client.executeTransactionBlock({ transactionBlock: txBytes, signature: [senderSig, sponsorSig] })`

**Policy hook:** `(req) => null | "reason"` — allowlist · rate-limit · per-tx cap · daily cap.

**Anti-drain checklist:** policy on ✔ · gas coin pool ✔ · per-coin reservation lock ✔ · budget cap ✔.

**Deployed (testnet):**
- RPC: `https://sui-testnet-rpc.publicnode.com`
- FUSD package: `0xece91a946edbf64a18fc0c7c5abdd1aaab5cba9b2337ef0ec13457de6df28102`
- FUSD faucet (shared): `0xe14ea541e30910a297d6c3d3df73afdd2afb6a424717d05d8706c4ee293ea667`
- coinType: `0xece91a946edbf64a18fc0c7c5abdd1aaab5cba9b2337ef0ec13457de6df28102::fusd::FUSD`
- sponsor: `0x9a5b0ad3a18964ab7c0dbf9ab4cdecfd6b3899423b47313ae6e78f4b801022a3`
- verified gasless tx: `GARm8aaLyURVbQvFgYEuRvE5WyAnwgJhBqzxUKNN5Nq6`

**Key limits:** default budget `20_000_000` MIST (0.02 SUI) · one gas coin per
in-flight tx · sender + sponsor sign identical bytes.
