// @gasless/station — plug-and-play sponsored transactions for Sui.
//
// Server:  const station = new GasStation({ client, sponsor, policy })
//          serve createSponsorHandler(station) at POST /api/sponsor
// Client:  await sponsorAndSend({ client, tx, sender, signAsSender, sponsor: "/api/sponsor" })
//
// The boundary between them is just { txKindBytes, sender } -> { txBytes, sponsorSignature }.

export { GasStation } from "./station";
export type { GasStationOptions, SponsorPolicy, SponsorRequest, SponsorResponse } from "./station";
export { createSponsorHandler } from "./server";
export { sponsorAndSend } from "./client";
export type { SponsorAndSendArgs } from "./client";
export { allOf, onlyPackages, rateLimit } from "./policy";
