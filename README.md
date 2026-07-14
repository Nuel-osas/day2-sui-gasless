# Gasless Stablecoins on Sui — Day 2

Send a stablecoin holding **zero SUI**. A sponsor pays the gas; the user only
signs. Built on Sui's native **sponsored transactions** — no relayer hacks.

**Real, not a mockup:** a freshly generated wallet with 0 SUI mints and sends a
test stablecoin on **testnet**, and the sponsor pays the fee. Verified two ways —
a self-contained script and the app's live endpoint.

## What's here

| Path | What it is |
|---|---|
| `packages/gas-station/` | **`@gasless/station`** — the plug-and-play piece: client SDK (`sponsorAndSend`), gas-station server (`GasStation`, `createSponsorHandler`), composable policies (`onlyPackages`, `rateLimit`). |
| `app/` | **SendFUSD** — a mobile-friendly React + dApp Kit payment app. Connect → claim FUSD → send, all gasless. Ships a Vite dev-server sponsor endpoint. |
| `move/` | **FUSD** — a test stablecoin (`fusd`) with an open faucet + a `pay` MoveCall so the station can strictly allowlist it. |
| `scripts/` | `gasless-e2e.mjs` (self-contained proof) and `verify-app-endpoint.mjs` (drives the app's live `/api/sponsor`). |
| `docs/gasless-explained.md` | Teaching reference — sponsored-tx mechanics end to end. |
| `ARCHITECTURE.md` | The plug-and-play design + how it composes with Day 1 (confidential) and Day 3 (tunnels). |

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
