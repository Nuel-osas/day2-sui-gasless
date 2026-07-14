// A drop-in HTTP handler wrapping a GasStation.
//
// Framework-agnostic: it speaks the Web-standard Request -> Response, so the same
// function plugs into a Vite dev middleware, a Node http server, an Express route
// (via a tiny adapter), a Cloudflare Worker, a Bun server, or a Next.js route.
//
//   const station = new GasStation({ client, sponsor, policy });
//   const handler = createSponsorHandler(station);
//   // then: serve POST /api/sponsor -> handler(request)

import type { GasStation, SponsorRequest } from "./station";

export function createSponsorHandler(station: GasStation) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }
    let body: SponsorRequest;
    try {
      body = (await request.json()) as SponsorRequest;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!body?.txKindBytes || !body?.sender) {
      return json({ error: "expected { txKindBytes, sender }" }, 400);
    }
    try {
      const sponsored = await station.sponsor(body);
      return json(sponsored, 200);
    } catch (e) {
      // policy rejection / out-of-funds / build error — 400 so the client sees why
      return json({ error: (e as Error).message }, 400);
    }
  };
}

function json(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
