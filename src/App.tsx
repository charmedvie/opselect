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
            {expiries.map((ex: ExpirySlice, i: number) => (
              <button
                key={ex.expiry + i}
                onClick={() => setActiveIdx(i)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 8,
                  border: "1px solid #d1d5db",
                  background: i === activeIdx ? "#111827" : "transparent",
                  color: i === activeIdx ? "#fff" : "#111827",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
                title={ex.expiry}
              >
                {formatExpiry(ex.expiry)}
              </button>
            ))}
          </div>

          {/* Underlier */}
          {uPrice !== null && (
            <div style={{ marginTop: 8, opacity: 0.7 }}>
              Underlier: <strong>{uPrice}</strong>
            </div>
          )}

          {/* Table */}
          <div className="options-wrap">
            <div className="scroll-x">
              <table className="options-table">
                <thead>
                  <tr>
                    <th colSpan={5}>Calls</th>
                    <th className="strike-sticky">Strike</th>
                    <th colSpan={5}>Puts</th>
                  </tr>
                  <tr>
                    {/* Calls inverted: IV, Delta, Ask, Bid, Last */}
                    <th>IV %</th>
                    <th>Delta</th>
                    <th>Ask</th>
                    <th>Bid</th>
                    <th>Last</th>
                    {/* Strike header cell sticks horizontally too */}
                    <th className="strike-sticky">-</th>
                    {/* Puts: Last, Bid, Ask, Delta, IV */}
                    <th>Last</th>
                    <th>Bid</th>
                    <th>Ask</th>
                    <th>Delta</th>
                    <th>IV %</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const c = r.call, p = r.put;
                    const isAt = uPrice !== null && r.strike === Math.round(uPrice);

                    const callClass =
                      c && uPrice !== null
                        ? r.strike < uPrice
                          ? "call-itm"
                          : "call-otm"
                        : "";
                    const putClass =
                      p && uPrice !== null
                        ? r.strike > uPrice
                          ? "put-itm"
                          : "put-otm"
                        : "";

                    return (
                      <tr key={r.strike}>
                        {/* Calls (IV, Delta, Ask, Bid, Last) */}
                        <td className={callClass}>{fmtPct(c?.iv)}</td>
                        <td className={callClass}>{fmtDelta(c?.delta)}</td>
                        <td className={callClass}>{fmtNum(c?.ask)}</td>
                        <td className={callClass}>{fmtNum(c?.bid)}</td>
                        <td className={callClass}>{fmtNum(c?.last)}</td>

                        {/* Strike (sticky + underline if at-underlier) */}
                        <td className={`strike-sticky ${isAt ? "strike-underlier" : ""}`}>
                          {r.strike}
                        </td>

                        {/* Puts (Last, Bid, Ask, Delta, IV) */}
                        <td className={putClass}>{fmtNum(p?.last)}</td>
                        <td className={putClass}>{fmtNum(p?.bid)}</td>
                        <td className={putClass}>{fmtNum(p?.ask)}</td>
                        <td className={putClass}>{fmtDelta(p?.delta)}</td>
                        <td className={putClass}>{fmtPct(p?.iv)}</td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={11} style={{ textAlign: "center", padding: 24 }}>
                        No data for this expiry.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

/* ---------- Helpers ---------- */
function formatExpiry(s: string) {
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return d.toLocaleDateString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  }
  return s;
}
function fmtNum(n?: number | null) {
  return typeof n === "number" ? String(n) : "—";
}
function fmtPct(n?: number | null) {
  return typeof n === "number" ? `${round(n, 2)}` : "—";
}
function fmtDelta(n?: number | null) {
  return typeof n === "number" ? round(n, 2).toFixed(2) : "—";
}
function round(n: number, dp: number) {
  const p = 10 ** dp;
  return Math.round(n * p) / p;
}
