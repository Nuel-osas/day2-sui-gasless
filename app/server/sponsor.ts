// Dev-server sponsor endpoint.
//
// Mounts POST /api/sponsor using the SAME @gasless/station the docs describe.
// Runs inside the Vite dev server (Node), so the sponsor key never reaches the
// browser. In production this exact handler moves to a serverless function.

import type { Connect } from "vite";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { GasStation, createSponsorHandler, allOf, onlyPackages, rateLimit } from "../../packages/gas-station/src/index";
import { CONFIG } from "../src/config";

export function sponsorPlugin() {
  return {
    name: "gasless-sponsor-endpoint",
    configureServer(server: { middlewares: Connect.Server }) {
      const key = process.env.SPONSOR_KEY;
      if (!key) {
        console.warn("\n⚠️  SPONSOR_KEY not set — /api/sponsor will return 503.");
        console.warn("   Run:  SPONSOR_KEY=suiprivkey1... pnpm dev\n");
      }
      const station = key ? buildStation(key) : null;
      const handler = station ? createSponsorHandler(station) : null;

      server.middlewares.use("/api/sponsor", async (req, res) => {
        if (!handler) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: "sponsor not configured (set SPONSOR_KEY)" }));
          return;
        }
        // adapt Node req/res <-> Web Request/Response
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const request = new Request("http://local/api/sponsor", {
          method: req.method,
          headers: { "content-type": "application/json" },
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        const response = await handler(request);
        res.statusCode = response.status;
        res.setHeader("content-type", "application/json");
        res.end(await response.text());
      });
    },
  };
}

function buildStation(key: string) {
  const client = new SuiClient({ url: CONFIG.rpc });
  const { secretKey } = decodeSuiPrivateKey(key.trim());
  const sponsor = Ed25519Keypair.fromSecretKey(secretKey);
  console.log(`\n⛽ Gas station ready. Sponsor: ${sponsor.getPublicKey().toSuiAddress()}\n`);
  return new GasStation({
    client,
    sponsor,
    gasBudget: 20_000_000n,
    // only pay for calls into OUR stablecoin package + coin ops; rate-limit per sender
    policy: allOf(onlyPackages([CONFIG.packageId]), rateLimit(10, 60_000)),
  });
}
