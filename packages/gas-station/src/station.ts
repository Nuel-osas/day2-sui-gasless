// The Gas Station — the drop-in SPONSOR service.
//
// Plug-and-play contract: it takes a *TransactionKind* (the user's intent, with
// NO gas attached) and returns fully-built, sponsor-signed transaction bytes.
// It knows nothing about your app — only "here is an intent, I will pay for it."
//
// The boundary is deliberately narrow so this composes with anything:
//   in:  { txKindBytes, sender }
//   out: { txBytes, sponsorSignature }
// The caller then signs `txBytes` as the sender and submits BOTH signatures.

import type { SuiClient } from "@mysten/sui/client";
import type { Signer } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { fromB64, toB64 } from "@mysten/sui/utils";

export interface SponsorRequest {
  /** base64 TransactionKind bytes — built client-side with `onlyTransactionKind: true`. */
  txKindBytes: string;
  /** the address that will sign as sender. */
  sender: string;
}

export interface SponsorResponse {
  /** base64 full TransactionData the SENDER must now sign. */
  txBytes: string;
  /** the sponsor's signature over `txBytes`. */
  sponsorSignature: string;
}

/**
 * A policy decides whether the station will pay for a given intent.
 * Return `null` to allow, or a human-readable reason string to reject.
 * This is the single seam where you bolt on allowlists, rate limits, per-tx
 * caps, KYC gating, "only sponsor calls into MY package", etc.
 */
export type SponsorPolicy = (
  req: { sender: string; tx: Transaction; txKindBytes: Uint8Array },
) => Promise<string | null> | string | null;

export interface GasStationOptions {
  client: SuiClient;
  /** the sponsor keypair (pays the gas). Any @mysten Signer works. */
  sponsor: Signer;
  /** gas budget in MIST. Default 20_000_000 (0.02 SUI). */
  gasBudget?: bigint;
  /** optional gate — see SponsorPolicy. */
  policy?: SponsorPolicy;
}

export class GasStation {
  private client: SuiClient;
  private signer: Signer;
  private sponsorAddress: string;
  private gasBudget: bigint;
  private policy?: SponsorPolicy;
  /** coins currently reserved by an in-flight sponsorship (avoids double-spend). */
  private locked = new Set<string>();

  constructor(opts: GasStationOptions) {
    this.client = opts.client;
    this.signer = opts.sponsor;
    this.sponsorAddress = opts.sponsor.getPublicKey().toSuiAddress();
    this.gasBudget = opts.gasBudget ?? 20_000_000n;
    this.policy = opts.policy;
  }

  get address() {
    return this.sponsorAddress;
  }

  /** Sponsor one intent. Throws if the policy rejects or no gas coin is free. */
  async sponsor(req: SponsorRequest): Promise<SponsorResponse> {
    const kindBytes = fromB64(req.txKindBytes);
    const tx = Transaction.fromKind(kindBytes);

    if (this.policy) {
      const reason = await this.policy({ sender: req.sender, tx, txKindBytes: kindBytes });
      if (reason) throw new Error(`sponsorship denied: ${reason}`);
    }

    const gasCoin = await this.reserveGasCoin();
    try {
      tx.setSender(req.sender);
      tx.setGasOwner(this.sponsorAddress);
      tx.setGasPayment([
        { objectId: gasCoin.coinObjectId, version: gasCoin.version, digest: gasCoin.digest },
      ]);
      tx.setGasBudget(this.gasBudget);

      const txBytes = await tx.build({ client: this.client });
      const { signature } = await this.signer.signTransaction(txBytes);
      return { txBytes: toB64(txBytes), sponsorSignature: signature };
    } finally {
      this.locked.delete(gasCoin.coinObjectId);
    }
  }

  /** Pick a sponsor-owned SUI coin that isn't already reserved by an in-flight request. */
  private async reserveGasCoin() {
    const { data } = await this.client.getCoins({
      owner: this.sponsorAddress,
      coinType: "0x2::sui::SUI",
      limit: 50,
    });
    const free = data
      .filter((c) => !this.locked.has(c.coinObjectId))
      .filter((c) => BigInt(c.balance) >= this.gasBudget)
      .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
    const coin = free[0];
    if (!coin) {
      throw new Error(
        "gas station out of funds: no free SUI coin covers the budget. Top up or split the sponsor's coins.",
      );
    }
    this.locked.add(coin.coinObjectId);
    return coin;
  }
}
