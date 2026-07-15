# Gasless on Sui — Two Architectures

There are **two different ways** to make Sui feel gasless. They are complementary,
not competing — a real payments app uses both.

| | **Technique 1 — Native (Address Balances)** | **Technique 2 — Sponsored (gas station)** |
|---|---|---|
| Who makes it free | The **protocol** | An **app-run sponsor** |
| Scope | **Only allowlisted stablecoins**, P2P transfer | **Any** tx — swaps, mints, your own token, app calls |
| Signatures | Just the sender | Sender **+** sponsor |
| Cost | Absorbed by the protocol | The sponsor's SUI |
| You run | Nothing | The sponsor service |
| Where | Mainnet | Any network |

**Rule of thumb:** sending an allowlisted stablecoin peer-to-peer → *native*.
Anything else you want to feel gasless → *sponsor it*.

---

## Technique 1 — Native gasless (Address Balances / SIP-58)

Live on Sui **mainnet since 2026-05-20** — the first L1 to zero stablecoin gas at
the protocol level (~$65B moved in five days). It is **not** a sponsor.

**The model shift.** Normally every coin is a `Coin<T>` **object** (UTXO-style:
select/split/merge; every transfer writes objects). **Address Balances** add a
canonical per-`(address, T)` balance, stored under a single root accumulator object
at `0xacc`. `T` needs only commutative merge/split.

**The accumulator.** A transfer **emits an accumulator event** (Merge=deposit,
Split=withdraw) instead of writing objects. At checkpoint construction, validators
aggregate the events and apply them via **settlement system-transactions**.
Deposits merge lock-free; withdrawals are reserved before execution via
`CallArg::FundsWithdrawal` so underflow can't happen → **no account-level locks**.
Because the op is bounded, no-object-write, and commutative, the protocol accepts
it at `gas_price = 0`.

**The API** (framework `0x2`):

```move
public fun send_funds<T>(balance: Balance<T>, recipient: address)
public fun redeem_funds<T>(w: Withdrawal<Balance<T>>): Balance<T>   // + coin:: variants
```

```ts
tx.moveCall({ target: "0x2::balance::send_funds", typeArguments: [USDC],
  arguments: [tx.balance({ type: USDC, balance: 5_000_000n }), tx.pure.address(to)] });
// gas left empty; gRPC/GraphQL auto-detect and set gas = 0. Tx building is STATELESS.
```

**Why "free" isn't abusable.** An **allowlist** (`get_gasless_allowed_token_types`)
— USDC, USDsui, SuiUSDe, USDY, FDUSD, AUSD, USDB — plus: PTB must be *only*
allowlisted balance/coin ops, **no object writes**, min transfer `0.01`, feature
flag `enable_address_balance_gas_payments`, and fee-payers are prioritized under
congestion. Your own token **cannot** opt in (governance-gated).

**Proof (real mainnet tx).** `WT4gyuLPvgeLDXBDZ79bQiQZMsjarFx8T5RXy7LFkko` — moved
~1,015 USDC, gas price 0, zero gas coins, computation fully rebated → **net gas 0
MIST**. Reproduce: `node scripts/mainnet-gasless-proof.mjs`. (You can't reproduce
true gas=0 with a custom token — the allowlist is mainnet-only.)

---

## Technique 2 — Sponsored transactions (the plug-and-play gas station)

For everything native gasless doesn't cover — swaps, mints, your own token, any app
call — an app-run sponsor pays the gas. This is the reusable piece in this repo
(`packages/gas-station`), and it composes with Day 1 (confidential) and Day 3 (tunnels).

### The one idea

On Sui, a transaction carries two separable things:

1. **The intent** — *what to do* (send 5 FUSD to Ada). Owned + signed by the **sender**.
2. **The gas** — *who pays* to run it. Owned + signed by the **sponsor**.

Normally the same wallet supplies both. **Gasless just gives the gas to someone
else.** The sender signs the intent; a sponsor signs the gas; both signatures ride
in one transaction. The user needs **zero SUI**.

That's the whole trick. Everything below is plumbing around this seam.

---

## The narrow boundary (this is what makes it plug-and-play)

The client and the sponsor talk through exactly two payloads:

```
  CLIENT  ──▶  { txKindBytes, sender }        ──▶  GAS STATION
  CLIENT  ◀──  { txBytes, sponsorSignature }  ◀──  GAS STATION
```

- `txKindBytes` — the intent, serialized with `onlyTransactionKind: true`. **No gas.**
- `txBytes` — the full transaction the station built (intent + sponsor gas). The
  **sender signs these exact bytes**.
- `sponsorSignature` — the sponsor's signature over `txBytes`.

Because the boundary is "a TransactionKind in, sponsor-signed bytes out," the gas
station is **asset-agnostic and app-agnostic**. It never knows or cares whether the
intent is a stablecoin transfer, an NFT mint, a swap, a confidential transfer, or a
tunnel settlement. Swap the app; the station is unchanged.

---

## The flow

```
┌──────────────────────────────────────────────────────────────────┐
│ ANY dApp frontend                                                  │
│  • builds a Transaction (the intent) — never sets gas              │
│  • tx.build({ onlyTransactionKind: true })  →  txKindBytes         │
└───────────────┬──────────────────────────────────────────────────┘
                │  POST /api/sponsor  { txKindBytes, sender }
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ GAS STATION  (packages/gas-station — the pluggable box)            │
│  1. policy check  (allowlist / rate-limit / per-tx cap)  ← the gate│
│  2. reserve a sponsor gas coin (lock it; no concurrent reuse)      │
│  3. Transaction.fromKind → setSender, setGasOwner(sponsor),        │
│     setGasPayment([coin]), setGasBudget → build → sign as sponsor  │
└───────────────┬──────────────────────────────────────────────────┘
                │  { txBytes, sponsorSignature }
                ▼
┌──────────────────────────────────────────────────────────────────┐
│ Frontend                                                           │
│  • signs the SAME txBytes as SENDER (wallet / dApp Kit)            │
│  • executeTransactionBlock({ txBytes, [senderSig, sponsorSig] })   │
└───────────────┬──────────────────────────────────────────────────┘
                ▼
             Sui network  →  user paid 0 SUI, sponsor paid gas
```

Two signatures, one on-chain transaction. Sender and sponsor **must sign identical
bytes** — that's why the station builds the final `txBytes` and hands them back for
the sender to sign, rather than the sender building their own.

---

## The pieces (and where they live)

| Piece | File | Role |
|---|---|---|
| **Client SDK** | `packages/gas-station/src/client.ts` | `sponsorAndSend(...)` — one call an app makes; does the whole round trip. |
| **Gas Station** | `packages/gas-station/src/station.ts` | `GasStation.sponsor(...)` — reserves gas, builds, signs as sponsor. |
| **HTTP handler** | `packages/gas-station/src/server.ts` | `createSponsorHandler(station)` — Web `Request→Response`; plugs into Vite / Node / Express / Workers / Next. |
| **Policies** | `packages/gas-station/src/policy.ts` | `onlyPackages`, `rateLimit`, `allOf` — compose the gate. |
| **Proof** | `scripts/gasless-e2e.mjs` | the same logic, self-contained, verified on testnet. |

---

## Two-line integration

**Server** (any runtime that can serve an HTTP POST):

```ts
const station = new GasStation({
  client,
  sponsor: Ed25519Keypair.fromSecretKey(process.env.SPONSOR_KEY),
  policy: allOf(onlyPackages([FUSD_PKG]), rateLimit(5, 60_000)),
});
export const POST = (req: Request) => createSponsorHandler(station)(req);
```

**Client** (dApp Kit / any signer):

```ts
await sponsorAndSend({
  client,
  tx,                         // your intent — no gas set
  sender: account.address,
  signAsSender: (bytes) => signTransaction({ transaction: bytes }),
  sponsor: "/api/sponsor",    // or an in-process GasStation for tests
});
```

Nothing above is stablecoin-specific. Change `tx` and you've sponsored something else.

---

## Deployment topologies (pick per app)

- **Dev / workshop** — sponsor key in a Vite dev-server middleware. Zero infra.
- **Web app** — sponsor key in a serverless function (Vercel/Cloudflare) behind
  `/api/sponsor`. The key never reaches the browser.
- **Mobile** — the same `/api/sponsor` endpoint; the phone only signs as sender
  (drops straight into the Day-2 mobile stack).
- **Production** — a standalone gas-station service with a **coin pool** (many
  small SUI coins so concurrent requests don't fight over one object), Redis-backed
  rate limits, and metrics.

---

## Composability — why "plug and play" is literal

The intent is just a `TransactionKind`, so **anything expressible as a PTB can be
sponsored**:

- **Day 1 — confidential + gasless.** Sponsor a confidential-transfer PTB → the
  amount is hidden **and** the user needs no SUI. Private *and* frictionless.
- **Day 3 — tunnels + gasless.** Sponsor the on-chain settlement of a tunnel so
  even opening/closing a channel costs the user nothing.
- **Anything else** — NFT mints, swaps, game moves. Same station, new `tx`.

The gas station sits *under* all three days as shared infrastructure.

---

## Trust & security model (one screen)

- **The sponsor can refuse, never steal.** It only adds a gas payment; it cannot
  alter the intent the sender signed. Worst case it **censors** (won't pay) or
  **griefs** (signs then never submits).
- **An open sponsor is a faucet drain.** Without a policy it pays for *any* tx from
  *anyone*. `onlyPackages` + `rateLimit` + a gas-budget cap are the minimum gate.
- **Gas-coin hygiene.** A gas coin locked by one in-flight sponsorship must not be
  reused by another, or you risk **equivocation** and an object locked until end of
  epoch. The station locks reserved coins; production uses a pool.
- **The sponsor address is public** (it paid gas on-chain). Gasless ≠ anonymous —
  compose with Day 1 if you also need privacy.

---

## Verified

Real testnet run (`scripts/gasless-e2e.mjs`): a freshly generated user holding
**0 SUI** sent 3 FUSD; the sponsor paid **0.0023 SUI** gas.

- gasless transfer: `GARm8aaLyURVbQvFgYEuRvE5WyAnwgJhBqzxUKNN5Nq6`
- FUSD package: `0xece91a946edbf64a18fc0c7c5abdd1aaab5cba9b2337ef0ec13457de6df28102`
