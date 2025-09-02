import { useMemo, useState } from "react";
import "./App.css";

type OptionSide = {
  strike: number;
  type: "call" | "put";
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
  delta?: number | null;
  iv?: number | null;
};
type ExpirySlice = { expiry: string; options: OptionSide[] };

export default function App() {
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [chainLoading, setChainLoading] = useState(false);
  const [chainErr, setChainErr] = useState("");
  const [expiries, setExpiries] = useState<ExpirySlice[]>([]);
  const [uPrice, setUPrice] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const fetchPrice = async () => {
    setErr("");
    setPrice(null);
    setCurrency(null);
    const s = symbol.trim().toUpperCase();
    setSymbol(s);
    if (!s) return;

    try {
      setLoading(true);
      const res = await fetch(`/api/quote?symbol=${encodeURIComponent(s)}`);
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      const json = JSON.parse(text);
      if (typeof json?.price !== "number") throw new Error("Price not found");
      setPrice(json.price);
      setCurrency(json.currency ?? null);
    } catch (e: any) {
      setErr(e?.message || "Fetch failed");
    } finally {
      setLoading(false);
    }
  };

  const fetchOptionsChain = async () => {
    setChainErr("");
    setChainLoading(true);
    setExpiries([]);
    setActiveIdx(0);
    setUPrice(null);

    const s = symbol.trim().toUpperCase();
    setSymbol(s);
    if (!s) {
      setChainLoading(false);
      setChainErr("Enter a ticker first.");
      return;
    }

    try {
      const url = `/api/options?symbol=${encodeURIComponent(s)}`;
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      const json = JSON.parse(text);

      if (!json?.expiries?.length) throw new Error("No options data found.");
      setUPrice(typeof json.underlierPrice === "number" ? json.underlierPrice : null);
      setExpiries(json.expiries);
    } catch (e: any) {
      setChainErr(e?.message || "Options fetch failed");
    } finally {
      setChainLoading(false);
    }
  };

  const activeExpiry: ExpirySlice | undefined = expiries[activeIdx];

  const rows = useMemo(() => {
    if (!activeExpiry) return [] as {
      strike: number;
      call: OptionSide | null;
      put: OptionSide | null;
    }[];

    const callsByStrike = new Map<number, OptionSide>();
    const putsByStrike = new Map<number, OptionSide>();

    for (const o of activeExpiry.options as OptionSide[]) {
      if (o.type === "call") callsByStrike.set(o.strike, o);
      else putsByStrike.set(o.strike, o);
    }

    const strikes = Array.from(
      new Set<number>([
        ...Array.from(callsByStrike.keys()),
        ...Array.from(putsByStrike.keys()),
      ])
    ).sort((a, b) => a - b);

    return strikes.map((strike: number) => ({
      strike,
      call: callsByStrike.get(strike) ?? null,
      put: putsByStrike.get(strike) ?? null,
    }));
  }, [activeExpiry]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1100, margin: "0 auto" }}>
      <h1>Stock Price Lookup</h1>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && fetchPrice()}
          placeholder="Enter ticker (e.g., AAPL)"
          style={{ textTransform: "uppercase", padding: 8, minWidth: 220 }}
        />
        <button onClick={fetchPrice} disabled={loading || !symbol.trim()}>
          {loading ? "Loading…" : "Get Price"}
        </button>
        <button onClick={fetchOptionsChain} disabled={chainLoading || !symbol.trim()}>
          {chainLoading ? "Loading chain…" : "Get Options Chain"}
        </button>
      </div>

      {/* Price */}
      {err && <p style={{ color: "crimson", marginTop: 8 }}>{err}</p>}
      {price !== null && !err && (
        <p style={{ marginTop: 12 }}>
          Current Price for <strong>{symbol}</strong>: {currency ? `${currency} ` : "$"}
          {price}
        </p>
      )}
      {chainErr && <p style={{ color: "crimson", marginTop: 12 }}>{chainErr}</p>}

      {/* Chain */}
      {expiries.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
            {expiries.map((
