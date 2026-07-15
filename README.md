# Gasless Stablecoins on Sui — Day 2

There are **two different ways** to make Sui feel gasless. This repo teaches and
proves **both** — they're complementary, not competing.

| | **Native (Address Balances)** | **Sponsored (gas station)** |
|---|---|---|
| Who makes it free | The **protocol** | An **app-run sponsor** |
| Scope | Only **allowlisted stablecoins**, P2P transfer | **Any** tx — swaps, mints, your own token, app calls |
| Signatures | Just the sender | Sender **+** sponsor |
| You run | Nothing | The sponsor service |

**Rule of thumb:** an allowlisted stablecoin peer-to-peer → *native, free, nothing
to run*. Anything else you want gasless → *sponsor it*. See `ARCHITECTURE.md` and
`docs/gasless-explained.md`.

**Proven both ways, for real:**
- **Native** — a real **mainnet** USDC transfer moved ~1,015 USDC for **$0.00 gas**
  (`node scripts/mainnet-gasless-proof.mjs`).
- **Sponsored** — a freshly generated wallet holding **0 SUI** sends our FUSD test
  token on testnet while a sponsor pays; verified by a script *and* the app's live
  endpoint.

## What's here

| Path | What it is |
|---|---|
| `packages/gas-station/` | **`@gasless/station`** — the plug-and-play piece: client SDK (`sponsorAndSend`), gas-station server (`GasStation`, `createSponsorHandler`), composable policies (`onlyPackages`, `rateLimit`). |
| `app/` | **SendFUSD** — a mobile-friendly React + dApp Kit payment app. Connect → claim FUSD → send, all gasless. Ships a Vite dev-server sponsor endpoint. |
| `move/` | **FUSD** — a test stablecoin (`fusd`) with an open faucet + a `pay` MoveCall so the station can strictly allowlist it. |
| `scripts/` | `mainnet-gasless-proof.mjs` (walks a real **native** mainnet gasless USDC tx), `gasless-e2e.mjs` (self-contained sponsored proof), `verify-app-endpoint.mjs` (drives the app's live `/api/sponsor`). |
| `docs/gasless-explained.md` | Teaching reference — **both** techniques end to end (native Address Balances + sponsored). |
| `ARCHITECTURE.md` | Both architectures + when to use which + how sponsoring composes with Day 1/Day 3. |

> **Note on the demo:** the runnable app demonstrates **sponsored** transactions
> (technique 2), because native gasless (technique 1) only works for allowlisted
> stablecoins on mainnet — you can't grant a custom testnet coin gas=0. The native
> feature is proven instead by a real mainnet transaction (`mainnet-gasless-proof.mjs`).

## The idea in one line

A transaction carries an **intent** (what to do) and a **gas payment** (who pays).
Normally one wallet supplies both. Gasless gives the gas to a **sponsor**: the
sender signs the intent, the sponsor signs the gas, both signatures ride in one
transaction. The boundary between them is narrow and app-agnostic:

```
CLIENT  ──▶  { txKindBytes, sender }        ──▶  GAS STATION
CLIENT  ◀──  { txBytes, sponsorSignature }  ◀──  GAS STATION
```

See `ARCHITECTURE.md` for the full picture.

## Run

```bash
pnpm install

# 1) prove the mechanism (self-contained; needs a funded testnet sponsor key)
SPONSOR_KEY=suiprivkey1... pnpm e2e                 # scripts/gasless-e2e.mjs

# 2) run the app
cd app && SPONSOR_KEY=suiprivkey1... pnpm dev       # http://localhost:5174

# 3) verify the app's live endpoint (in another terminal, app running)
node scripts/verify-app-endpoint.mjs
```

Get a `SPONSOR_KEY` by exporting any funded testnet address:
`sui keytool export --key-identity <addr> --json`. The sponsor only needs a little
SUI (~0.002 per tx); **your users need none.**

## Live on testnet

| | Address |
|---|---|
| FUSD package | `0x25c5d3b509841312696b353a9218d1992caccafd03ca6f198f9fd7dfd7011efd` |
| FUSD faucet (shared) | `0xe6dda9812f7d7f84eadd0686690c2c8b9d56b2dea2af018dcd73efb5794b583b` |
| Coin type | `…::fusd::FUSD` |

A real gasless transfer (user held 0 SUI, sponsor paid the gas):
`BW7k9MGfLfZdaCYKgiY7C6NGufXaZiXpxr1Tuva4BxvC`

> **Heads-up:** the public testnet fullnode `fullnode.testnet.sui.io` currently
> 404s for JSON-RPC, so the app + scripts pin `https://sui-testnet-rpc.publicnode.com`.
> Testnet resets periodically — if IDs stop resolving, republish `move/` and repaste.

## Security

An **open** sponsor pays for anyone's transactions and will be drained. The gas
station takes a **policy** — this repo's app allowlists only the FUSD package and
rate-limits per sender. A sponsor can *refuse* to pay but can never alter the
signed intent or steal. See `docs/gasless-explained.md`.

## Stack

Sui Move 2024 · `@mysten/sui` · `@mysten/dapp-kit` · React 18 · Vite · pnpm workspace.

---
SuiHub Lagos · Sui Stack 2026 · Day 2.
