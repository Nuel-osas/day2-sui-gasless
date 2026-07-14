// Gasless stablecoin transfer — REAL, end to end, on Sui testnet.
//
// Proves the whole point of Day 2: a user who holds ZERO SUI can still send a
// stablecoin, because a sponsor pays the gas. We:
//   1. make a fresh USER keypair with 0 SUI
//   2. mint FUSD to the user (sponsor pays that gas)
//   3. USER sends FUSD to a recipient — gas SPONSORED (the gasless transfer)
//   4. assert: user's SUI balance is 0 the entire time; recipient got the FUSD
//
// Self-contained: the only input is SPONSOR_KEY (a funded testnet key, bech32
// `suiprivkey1...`). No app, no server — just the sponsored-transaction mechanism.
//
//   SPONSOR_KEY=suiprivkey1... node scripts/gasless-e2e.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { fromB64, toB64 } from "@mysten/sui/utils";

const __dir = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dir, "deployed.json"), "utf8"));
const client = new SuiClient({ url: cfg.rpc ?? getFullnodeUrl(cfg.network) });

const ONE_FUSD = 1_000_000n; // 6 decimals

function loadSponsor() {
  const key = process.env.SPONSOR_KEY;
  if (!key) throw new Error("set SPONSOR_KEY=suiprivkey1... (a funded testnet key)");
  const { secretKey } = decodeSuiPrivateKey(key.trim());
  return Ed25519Keypair.fromSecretKey(secretKey);
}

async function suiBalance(addr) {
  const b = await client.getBalance({ owner: addr, coinType: "0x2::sui::SUI" });
  return BigInt(b.totalBalance);
}
async function fusdBalance(addr) {
  const b = await client.getBalance({ owner: addr, coinType: cfg.coinType });
  return BigInt(b.totalBalance);
}
const fmtSui = (mist) => (Number(mist) / 1e9).toFixed(4);
const fmtFusd = (raw) => (Number(raw) / 1e6).toFixed(2);
const link = (d) => `https://suiscan.xyz/testnet/tx/${d}`;

// --- the gas station, in-process (same logic as packages/gas-station) --------
async function sponsorIntent(sponsor, txKindBytes, sender, gasBudget = 20_000_000n) {
  const tx = Transaction.fromKind(fromB64(txKindBytes));
  const { data: coins } = await client.getCoins({
    owner: sponsor.toSuiAddress(),
    coinType: "0x2::sui::SUI",
    limit: 50,
  });
  const gas = coins
    .filter((c) => BigInt(c.balance) >= gasBudget)
    .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
  if (!gas) throw new Error("sponsor has no SUI coin large enough for gas");

  tx.setSender(sender);
  tx.setGasOwner(sponsor.toSuiAddress());
  tx.setGasPayment([{ objectId: gas.coinObjectId, version: gas.version, digest: gas.digest }]);
  tx.setGasBudget(gasBudget);

  const txBytes = await tx.build({ client });
  const { signature } = await sponsor.signTransaction(txBytes);
  return { txBytes: toB64(txBytes), sponsorSignature: signature };
}

async function sponsorAndSend(sponsor, tx, senderKp) {
  const sender = senderKp.toSuiAddress();
  tx.setSender(sender);
  const kind = await tx.build({ client, onlyTransactionKind: true });
  const { txBytes, sponsorSignature } = await sponsorIntent(sponsor, toB64(kind), sender);
  const { signature: senderSignature } = await senderKp.signTransaction(fromB64(txBytes));
  const res = await client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: [senderSignature, sponsorSignature],
    options: { showEffects: true, showBalanceChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  return res;
}
// -----------------------------------------------------------------------------

async function main() {
  const sponsor = loadSponsor();
  const sponsorAddr = sponsor.toSuiAddress();
  const user = Ed25519Keypair.generate();
  const userAddr = user.toSuiAddress();
  const recipient = Ed25519Keypair.generate().toSuiAddress();

  console.log("Sponsor:  ", sponsorAddr, `(${fmtSui(await suiBalance(sponsorAddr))} SUI)`);
  console.log("User:     ", userAddr, "(holds ZERO SUI — never funded)");
  console.log("Recipient:", recipient);
  console.log();

  if ((await suiBalance(userAddr)) !== 0n) throw new Error("user should have 0 SUI");

  // [1] mint FUSD to the user (sponsor pays this gas too — user still has no SUI)
  console.log("[1] Mint 10 FUSD to the user (sponsor-paid)");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${cfg.packageId}::fusd::mint`,
      arguments: [tx.object(cfg.faucet), tx.pure.u64(10n * ONE_FUSD), tx.pure.address(userAddr)],
    });
    // sponsor is also the sender here (it's just a faucet call); pays its own gas
    tx.setSender(sponsorAddr);
    tx.setGasBudget(20_000_000n);
    const bytes = await tx.build({ client });
    const { signature } = await sponsor.signTransaction(bytes);
    const res = await client.executeTransactionBlock({ transactionBlock: bytes, signature, options: { showEffects: true } });
    await client.waitForTransaction({ digest: res.digest });
    console.log("    mint:", res.effects.status.status, "", link(res.digest));
  }

  console.log("    user FUSD:", fmtFusd(await fusdBalance(userAddr)), " user SUI:", fmtSui(await suiBalance(userAddr)));
  console.log();

  // [2] THE GASLESS TRANSFER — user sends 3 FUSD, holding 0 SUI, sponsor pays gas
  console.log("[2] User -> Recipient: send 3 FUSD  (user pays ZERO gas; sponsor sponsors it)");
  // call fusd::pay — a MoveCall into our package, so the gas station's strict
  // onlyPackages() policy can authorize it. gas is sponsored.
  {
    const { data: userCoins } = await client.getCoins({ owner: userAddr, coinType: cfg.coinType });
    const tx = new Transaction();
    tx.moveCall({
      target: `${cfg.packageId}::fusd::pay`,
      arguments: [tx.object(userCoins[0].coinObjectId), tx.pure.u64(3n * ONE_FUSD), tx.pure.address(recipient)],
    });

    const res = await sponsorAndSend(sponsor, tx, user);
    console.log("    transfer:", res.effects.status.status, "", link(res.digest));
    const sponsorChange = (res.balanceChanges ?? []).find((c) => c.owner?.AddressOwner === sponsorAddr);
    if (sponsorChange) console.log("    gas paid by sponsor:", fmtSui(-BigInt(sponsorChange.amount)), "SUI");
  }
  console.log();

  // [3] verify
  const userSui = await suiBalance(userAddr);
  const recvFusd = await fusdBalance(recipient);
  console.log("[3] Result");
  console.log("    user SUI:      ", fmtSui(userSui), "(still ZERO — never paid gas)");
  console.log("    user FUSD:     ", fmtFusd(await fusdBalance(userAddr)));
  console.log("    recipient FUSD:", fmtFusd(recvFusd));
  console.log();

  if (userSui !== 0n) throw new Error(`FAIL: user paid gas — SUI balance is ${userSui}`);
  if (recvFusd !== 3n * ONE_FUSD) throw new Error(`FAIL: recipient got ${fmtFusd(recvFusd)} FUSD, expected 3.00`);

  console.log("✅ Gasless transfer complete. The user moved a stablecoin holding ZERO SUI;");
  console.log("   the sponsor paid the gas. Sender + sponsor signatures, one on-chain tx.");
}

main().catch((e) => { console.error("\nE2E FAILED:", e.message); process.exit(1); });
