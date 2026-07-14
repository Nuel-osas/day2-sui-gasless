import { useState } from "react";
import {
  ConnectButton,
  useCurrentAccount,
  useSuiClient,
  useSignTransaction,
  useSuiClientQuery,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { sponsorAndSend } from "@gasless/station";
import { CONFIG, ONE_FUSD, explorerTx } from "./config";

type Status = { kind: "idle" | "working" | "ok" | "err"; msg?: string; digest?: string };

export default function App() {
  const account = useCurrentAccount();
  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="logo">₦</span>
          <div>
            <h1>SendFUSD</h1>
            <p className="tag">Stablecoins with <b>no gas token</b></p>
          </div>
        </div>
        <ConnectButton />
      </header>

      {!account ? <Landing /> : <Wallet address={account.address} />}

      <footer className="foot">
        Gas paid by a sponsor · you hold zero SUI · testnet ·{" "}
        <span className="mono">{short(CONFIG.packageId)}</span>
      </footer>
    </div>
  );
}

function Landing() {
  return (
    <main className="card center">
      <h2>Send money without buying “gas” first.</h2>
      <p className="muted">
        On most chains, a first-time user must go buy a second token just to pay
        fees. Here a sponsor covers the gas — connect a wallet holding{" "}
        <b>zero SUI</b> and send a stablecoin anyway.
      </p>
      <div className="hintRow">
        <span className="pill">1 · Connect</span>
        <span className="pill">2 · Get test FUSD</span>
        <span className="pill">3 · Send — no gas</span>
      </div>
    </main>
  );
}

function Wallet({ address }: { address: string }) {
  const client = useSuiClient();
  const { mutateAsync: signTransaction } = useSignTransaction();

  const fusd = useSuiClientQuery("getBalance", { owner: address, coinType: CONFIG.coinType });
  const sui = useSuiClientQuery("getBalance", { owner: address, coinType: "0x2::sui::SUI" });

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const fusdBal = fusd.data ? Number(fusd.data.totalBalance) / 1e6 : 0;
  const suiBal = sui.data ? Number(sui.data.totalBalance) / 1e9 : 0;

  const signAsSender = async (bytes: Uint8Array) => {
    const { signature } = await signTransaction({ transaction: Transaction.from(bytes) });
    return { signature };
  };

  const refresh = () => {
    fusd.refetch();
    sui.refetch();
  };

  async function claim() {
    setStatus({ kind: "working", msg: "Minting 10 test FUSD (sponsor pays gas)…" });
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${CONFIG.packageId}::fusd::mint`,
        arguments: [tx.object(CONFIG.faucet), tx.pure.u64(10n * ONE_FUSD), tx.pure.address(address)],
      });
      const res = await sponsorAndSend({
        client,
        tx,
        sender: address,
        signAsSender,
        sponsor: CONFIG.sponsorEndpoint,
      });
      await client.waitForTransaction({ digest: res.digest });
      setStatus({ kind: "ok", msg: "Got 10 FUSD", digest: res.digest });
      refresh();
    } catch (e) {
      setStatus({ kind: "err", msg: (e as Error).message });
    }
  }

  async function send() {
    const amt = Number(amount);
    if (!to.startsWith("0x") || to.length < 10) return setStatus({ kind: "err", msg: "Enter a valid 0x… address" });
    if (!amt || amt <= 0) return setStatus({ kind: "err", msg: "Enter an amount" });
    if (amt > fusdBal) return setStatus({ kind: "err", msg: "Not enough FUSD" });

    setStatus({ kind: "working", msg: `Sending ${amt} FUSD — you pay no gas…` });
    try {
      const coins = await client.getCoins({ owner: address, coinType: CONFIG.coinType });
      if (!coins.data.length) throw new Error("no FUSD coins — claim some first");
      const tx = new Transaction();
      tx.moveCall({
        target: `${CONFIG.packageId}::fusd::pay`,
        arguments: [
          tx.object(coins.data[0].coinObjectId),
          tx.pure.u64(BigInt(Math.round(amt * 1e6))),
          tx.pure.address(to),
        ],
      });
      const res = await sponsorAndSend({
        client,
        tx,
        sender: address,
        signAsSender,
        sponsor: CONFIG.sponsorEndpoint,
      });
      await client.waitForTransaction({ digest: res.digest });
      setStatus({ kind: "ok", msg: `Sent ${amt} FUSD`, digest: res.digest });
      setAmount("");
      refresh();
    } catch (e) {
      setStatus({ kind: "err", msg: (e as Error).message });
    }
  }

  const busy = status.kind === "working";

  return (
    <main className="stack">
      <section className="card balance">
        <div className="balMain">
          <span className="muted small">Your balance</span>
          <div className="big">
            {fusdBal.toFixed(2)} <span className="unit">FUSD</span>
          </div>
        </div>
        <div className="balSui">
          <span className="muted small">Gas token (SUI)</span>
          <div className={suiBal === 0 ? "zero" : "mono"}>{suiBal.toFixed(4)} SUI</div>
          <span className="okNote">{suiBal === 0 ? "0 — and you can still send ✓" : "not needed to send"}</span>
        </div>
      </section>

      <button className="ghost" onClick={claim} disabled={busy}>
        + Get 10 test FUSD
      </button>

      <section className="card">
        <label className="fieldLabel">Send to</label>
        <input className="input" placeholder="0x… recipient address" value={to} onChange={(e) => setTo(e.target.value.trim())} />
        <label className="fieldLabel">Amount (FUSD)</label>
        <input className="input" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button className="primary" onClick={send} disabled={busy}>
          {busy ? "…" : "Send — no gas needed"}
        </button>
      </section>

      {status.kind !== "idle" && (
        <div className={`toast ${status.kind}`}>
          <span>{status.msg}</span>
          {status.digest && (
            <a href={explorerTx(status.digest)} target="_blank" rel="noreferrer">
              view receipt ↗
            </a>
          )}
        </div>
      )}
    </main>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
