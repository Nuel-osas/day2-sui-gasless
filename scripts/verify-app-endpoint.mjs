// Verifies the APP's live /api/sponsor endpoint end-to-end by playing the role
// of the browser: a fresh user holding ZERO SUI mints + sends FUSD, with the
// running dev server's gas station sponsoring the gas. Same server path the UI uses.
//
//   APP_URL=http://localhost:5174 node scripts/verify-app-endpoint.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromB64, toB64 } from "@mysten/sui/utils";

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "deployed.json"), "utf8"));
const client = new SuiClient({ url: cfg.rpc });
const endpoint = (process.env.APP_URL ?? "http://localhost:5174") + "/api/sponsor";
const ONE = 1_000_000n;
const link = (d) => `https://suiscan.xyz/testnet/tx/${d}`;

// exactly what packages/gas-station/src/client.ts::sponsorAndSend does, over HTTP
async function sponsorAndSend(tx, senderKp) {
  const sender = senderKp.toSuiAddress();
  tx.setSender(sender);
  const kind = await tx.build({ client, onlyTransactionKind: true });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txKindBytes: toB64(kind), sender }),
  });
  if (!res.ok) throw new Error(`/api/sponsor ${res.status}: ${await res.text()}`);
  const { txBytes, sponsorSignature } = await res.json();
  const { signature: senderSig } = await senderKp.signTransaction(fromB64(txBytes));
  const out = await client.executeTransactionBlock({
    transactionBlock: txBytes,
    signature: [senderSig, sponsorSignature],
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: out.digest });
  if (out.effects.status.status !== "success") throw new Error(`exec failed: ${JSON.stringify(out.effects.status)}`);
  return out;
}
const sui = async (a) => BigInt((await client.getBalance({ owner: a, coinType: "0x2::sui::SUI" })).totalBalance);
const fusd = async (a) => BigInt((await client.getBalance({ owner: a, coinType: cfg.coinType })).totalBalance);

const user = Ed25519Keypair.generate();
const U = user.toSuiAddress();
const recipient = Ed25519Keypair.generate().toSuiAddress();
console.log("Endpoint:", endpoint);
console.log("User:", U, "(0 SUI)\n");

// 1) claim via endpoint (mint MoveCall — policy allows our package)
const mintTx = new Transaction();
mintTx.moveCall({ target: `${cfg.packageId}::fusd::mint`, arguments: [mintTx.object(cfg.faucet), mintTx.pure.u64(10n * ONE), mintTx.pure.address(U)] });
const m = await sponsorAndSend(mintTx, user);
console.log("[1] claim 10 FUSD via /api/sponsor:", m.effects.status.status, link(m.digest));

// 2) send via endpoint (pay MoveCall)
const coins = await client.getCoins({ owner: U, coinType: cfg.coinType });
const payTx = new Transaction();
payTx.moveCall({ target: `${cfg.packageId}::fusd::pay`, arguments: [payTx.object(coins.data[0].coinObjectId), payTx.pure.u64(4n * ONE), payTx.pure.address(recipient)] });
const p = await sponsorAndSend(payTx, user);
console.log("[2] send 4 FUSD via /api/sponsor: ", p.effects.status.status, link(p.digest));

const userSui = await sui(U);
console.log("\nuser SUI:", (Number(userSui) / 1e9).toFixed(4), "| recipient FUSD:", (Number(await fusd(recipient)) / 1e6).toFixed(2));
if (userSui !== 0n) throw new Error("FAIL: user paid gas");
if ((await fusd(recipient)) !== 4n * ONE) throw new Error("FAIL: recipient balance wrong");
console.log("\n✅ App /api/sponsor endpoint verified — real gasless mint + send, user never held SUI.");
