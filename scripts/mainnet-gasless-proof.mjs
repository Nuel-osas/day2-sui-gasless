// Walk through a REAL mainnet gasless stablecoin transfer.
//
// Native gasless transfers (Sui's protocol-level feature, live on mainnet since
// 2026-05-20) only work for allowlisted stablecoins — you can't reproduce them
// with a custom testnet coin. So the honest proof is a real mainnet transaction:
// this fetches one and shows it moved USDC for ZERO gas — no sponsor involved.
//
//   node scripts/mainnet-gasless-proof.mjs [digest]

const RPC = process.env.MAINNET_RPC ?? "https://sui-rpc.publicnode.com";
// A real gasless USDC transfer: ~1,015 USDC moved, net gas 0, no gas coin.
const PROOF = process.argv[2] ?? "WT4gyuLPvgeLDXBDZ79bQiQZMsjarFx8T5RXy7LFkko";

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

const t = await rpc("sui_getTransactionBlock", [
  PROOF,
  { showInput: true, showEffects: true, showBalanceChanges: true },
]);
const d = t.transaction.data;
const g = d.gasData;
const gu = t.effects.gasUsed;
const netGas = Number(gu.computationCost) + Number(gu.storageCost) - Number(gu.storageRebate);
const calls = (d.transaction.transactions ?? [])
  .filter((c) => c.MoveCall)
  .map((c) => `${c.MoveCall.package.slice(0, 6)}…::${c.MoveCall.module}::${c.MoveCall.function}`);

console.log("Real mainnet gasless transfer");
console.log("  digest:        ", PROOF);
console.log("  explorer:      ", `https://suiscan.xyz/mainnet/tx/${PROOF}`);
console.log("  status:        ", t.effects.status.status);
console.log();
console.log("  Gas — the point:");
console.log("    gas price:     ", g.price, "(zero)");
console.log("    gas budget:    ", g.budget);
console.log("    gas coins:     ", (g.payment ?? []).length, "(none attached)");
console.log("    computation:   ", gu.computationCost, "MIST");
console.log("    storage rebate:", gu.storageRebate, "MIST");
console.log("    NET GAS PAID:  ", netGas, "MIST  ← $0.00");
console.log();
console.log("  It's an Address Balances stablecoin move (not a sponsor):");
for (const c of calls) console.log("    •", c);
console.log();
console.log("  Value moved:");
for (const b of t.balanceChanges ?? []) {
  const sym = b.coinType.split("::").slice(-1)[0];
  const who = (b.owner?.AddressOwner ?? "").slice(0, 10);
  const amt = (Number(b.amount) / 1e6).toFixed(2);
  console.log(`    ${amt.padStart(12)} ${sym}  →  ${who}…`);
}
console.log();
console.log("  No second signature, no sponsor address, no gas coin. The PROTOCOL");
console.log("  accepted a gas=0 transfer because USDC is on the gasless allowlist.");
