// Composable sponsorship policies — the seam where you decide what you'll pay for.
//
// A GasStation with no policy is an OPEN sponsor: it pays for ANY transaction from
// ANYONE. That's fine for a closed workshop; it's a faucet-drainer in production.
// Compose these (or write your own) and pass to `new GasStation({ policy: allOf(...) })`.

import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { SponsorPolicy } from "./station";

/** Allow only if EVERY policy allows. First rejection wins. */
export function allOf(...policies: SponsorPolicy[]): SponsorPolicy {
  return async (req) => {
    for (const p of policies) {
      const reason = await p(req);
      if (reason) return reason;
    }
    return null;
  };
}

/**
 * Only sponsor transactions whose Move calls all target one of the allowed
 * packages. Stops your gas station from paying for arbitrary unrelated txs.
 */
export function onlyPackages(allowed: string[]): SponsorPolicy {
  const set = new Set(allowed.map((a) => normalizeSuiAddress(a)));
  return (req) => {
    const cmds = req.tx.getData().commands;
    const calls = cmds.filter((c) => c.$kind === "MoveCall");
    if (calls.length === 0) return "no MoveCall to authorize";
    for (const c of calls) {
      const raw = (c as any).MoveCall?.package as string | undefined;
      const pkg = raw ? normalizeSuiAddress(raw) : undefined;
      if (!pkg || !set.has(pkg)) return `package ${pkg} not on the allowlist`;
    }
    return null;
  };
}

/** Simple in-memory per-sender rate limit: at most `max` sponsorships per `windowMs`. */
export function rateLimit(max: number, windowMs: number): SponsorPolicy {
  const hits = new Map<string, number[]>();
  return (req) => {
    // NOTE: uses wall-clock; fine for a single-process station. Swap for Redis in prod.
    const now = Date.now();
    const arr = (hits.get(req.sender) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return `rate limit: ${max} per ${windowMs}ms exceeded`;
    arr.push(now);
    hits.set(req.sender, arr);
    return null;
  };
}
