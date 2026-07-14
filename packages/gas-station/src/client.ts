// Client-side helper — the one call an app makes to send a transaction gaslessly.
//
// The app builds a normal `Transaction` describing WHAT it wants to do (send 5
// FUSD to Ada). It never thinks about gas. `sponsorAndSend` does the round trip:
//   1. serialize the intent as a TransactionKind (no gas)
//   2. POST it to the gas station -> get back sponsor-signed full tx bytes
//   3. sign those exact bytes as the SENDER
//   4. submit both signatures
//
// The user pays 0 SUI. They only ever sign; the sponsor pays.

import type { SuiClient, SuiTransactionBlockResponseOptions } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import { fromB64 } from "@mysten/sui/utils";
import type { SponsorResponse } from "./station";

export interface SponsorAndSendArgs {
  client: SuiClient;
  /** the intent — a Transaction with NO gas config set. */
  tx: Transaction;
  /** the sender's address. */
  sender: string;
  /**
   * sign the given full transaction bytes as the sender.
   * In a wallet app this is `signTransaction` from dApp Kit; in a script it's a keypair.
   * Must return the sender's signature (base64).
   */
  signAsSender: (txBytes: Uint8Array) => Promise<{ signature: string }>;
  /**
   * how to reach the gas station. Either an HTTP endpoint URL, or an in-process
   * function (e.g. a `GasStation.sponsor` bound method) for tests / edge runtimes.
   */
  sponsor:
    | string
    | ((req: { txKindBytes: string; sender: string }) => Promise<SponsorResponse>);
  options?: SuiTransactionBlockResponseOptions;
}

export async function sponsorAndSend(args: SponsorAndSendArgs) {
  const { client, tx, sender, signAsSender, sponsor, options } = args;

  tx.setSender(sender);
  const kind = await tx.build({ client, onlyTransactionKind: true });
  const txKindBytes = toBase64(kind);

  const sponsored =
    typeof sponsor === "string"
      ? await postJson<SponsorResponse>(sponsor, { txKindBytes, sender })
      : await sponsor({ txKindBytes, sender });

  const fullBytes = fromB64(sponsored.txBytes);
  const { signature: senderSignature } = await signAsSender(fullBytes);

  return client.executeTransactionBlock({
    transactionBlock: sponsored.txBytes,
    signature: [senderSignature, sponsored.sponsorSignature],
    options: options ?? { showEffects: true, showObjectChanges: true },
  });
}

function toBase64(bytes: Uint8Array): string {
  // browser-safe base64 (avoids a Buffer dependency in the client bundle)
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bytes).toString("base64");
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`gas station ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}
