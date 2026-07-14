// Live testnet deployment. Mirrors scripts/deployed.json.
// If these stop resolving, testnet was reset — republish move/ and repaste IDs.
export const CONFIG = {
  network: "testnet" as const,
  rpc: "https://sui-testnet-rpc.publicnode.com",
  packageId: "0x25c5d3b509841312696b353a9218d1992caccafd03ca6f198f9fd7dfd7011efd",
  faucet: "0xe6dda9812f7d7f84eadd0686690c2c8b9d56b2dea2af018dcd73efb5794b583b",
  coinType: "0x25c5d3b509841312696b353a9218d1992caccafd03ca6f198f9fd7dfd7011efd::fusd::FUSD",
  decimals: 6,
  symbol: "FUSD",
  sponsorEndpoint: "/api/sponsor",
};

export const ONE_FUSD = 10n ** BigInt(CONFIG.decimals);
export const explorerTx = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;
