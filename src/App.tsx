import { useMemo, useState } from "react";
import "./App.css";

type OptionSide = {
  strike: number;
  type: "call" | "put";
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
  delta?: number | null;
  iv?: number | null; // percent in our app
};
type ExpirySlice = { expiry: string; options: OptionSide[] };

type YieldRow = {
  strike: number;
  bid: number;
  yieldPct: number;
  probOTM: number; // percent
  delta?: number | null;
  iv?: number | null;
  expiry: string;
  side: "call" | "put";
};

const DTE_BUCKETS = [7, 14, 21, 30] as const;

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

  // computed “top yields” per bucket
  const topYields = useMemo(() => {
    if (!expiries.length || uPrice == null) return null;

    // precompute expiry DTE
    const now = Date.now();
    const expWithDte = expiries.map((ex) => ({
      ex,
      dte: Math.max(0, Math.ceil((Date.parse(ex.expiry) - now) / (1000 * 60 * 60 * 24))),
    }));

    const result: Record<number, { calls: YieldRow[]; puts: YieldRow[] }> = {};

    for (const target of DTE_BUCKETS) {
      // pick the expiry with DTE closest to the target
      const nearest = expWithDte
        .slice()
        .sort((a, b) => Math.abs(a.dte - target) - Math.abs(b.dte - target))[0];
      if (!nearest) continue;

      const calls: YieldRow[] = [];
      const puts: YieldRow[] = [];

      for (const o of nearest.ex.options) {
        if (typeof o.bid !== "number" || typeof o.strike !== "number" || o.strike <= 0) continue;
        // need IV to estimate probability; skip if missing
        if (typeof o.iv !== "number" || o.iv <= 0) continue;

        const T = Math.max(1 / 365, nearest.dte / 365); // years, min 1 day for sanity
        const prob = probOTM(o.type, uPrice, o.strike, o.iv / 100, T);
        if (prob == null) continue;

        const y = o.bid / o.strike; // yield
        const row: YieldRow = {
          strike: o.strike,
          bid: o.bid,
          yieldPct: y * 100,
          probOTM: prob * 100,
          delta: o.delta,
          iv: o.iv,
          expiry: nearest.ex.expiry,
          side: o.type,
        };
        if (o.type === "call") calls.push(row);
        else puts.push(row);
      }

      const topCalls = calls.sort((a, b) => b.yieldPct - a.yieldPct).slice(0, 5);
      const topPuts = puts.sort((a, b) => b.yieldPct - a.yieldPct).slice(0, 5);

      result[target] = { calls: topCalls, puts: topPuts };
    }
    return result;
  }, [expiries, uPrice]);

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
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1200, margin: "0 auto" }}>
      <h1>Stock Price Lookup</h1>

      {/* Controls + Top Yields header row */}
      <div className="header-row">
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

        {/* Top Yields panel */}
        {topYields && uPrice != null && (
          <div className="yields-panel">
            <div className="y-meta">
              Underlier: <strong>{uPrice}</strong> &nbsp;•&nbsp; Yield = <code>bid / strike</code>
            </div>
            <div className="yields-grid">
              {DTE_BUCKETS.map((d) => {
                const bucket = topYields[d];
                if (!bucket) return null;
                return (
                  <div key={d} className="yield-card">
                    <h4>
                      <span className="y-badge">{d} DTE</span>
                    </h4>
                    <table className="yield-table">
                      <thead>
                        <tr>
                          <th>Top Calls</th>
                          <th>Bid</th>
                          <th>Yield</th>
                          <th>Prob OTM</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bucket.calls.length ? (
                          bucket.calls.map((r) => (
                            <tr key={`c-${d}-${r.strike}`}>
                              <td>{r.strike}</td>
                              <td>{fmtNum(r.bid)}</td>
                              <td>{fmtPct(r.yieldPct)}</td>
                              <td>{fmtPct(r.probOTM)}</td>
                            </tr>
                          ))
                        ) : (
                          <tr><td colSpan={4} style={{ textAlign: "center" }}>—</td></tr>
                        )}
                      </tbody>
                      <thead>
                        <tr>
                          <th style={{ paddingTop: 10 }}>Top Puts</th>
                          <th style={{ paddingTop: 10 }}>Bid</th>
                          <th style={{ paddingTop: 10 }}>Yield</th>
                          <th style={{ paddingTop: 10 }}>Prob OTM</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bucket.puts.length ? (
                          bucket.puts.map((r) => (
                            <tr key={`p-${d}-${r.strike}`}>
                              <td>{r.strike}</td>
                              <td>{fmtNum(r.bid)}</td>
                              <td>{fmtPct(r.yieldPct)}</td>
                              <td>{fmtPct(r.probOTM)}</td>
                            </tr>
                          ))
                        ) : (
                          <tr><td colSpan={4} style={{ textAlign: "center" }}>—</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Price + chain errors below header row */}
      {err && <p style={{ color: "crimson", marginTop: 8 }}>{err}</p>}
      {price !== null && !err && (
        <p style={{ marginTop: 8 }}>
          Current Price for <strong>{symbol}</strong>: {currency ? `${currency} ` : "$"}
          {price}
        </p>
      )}
      {chainErr && <p style={{ color: "crimson", marginTop: 8 }}>{chainErr}</p>}

      {/* Full options chain lower on the page to make room */}
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

          {/* Underlier ref */}
          {uPrice !== null && (
            <div style={{ marginTop: 8, opacity: 0.7 }}>
              Underlier: <strong>{uPrice}</strong>
            </div>
          )}

          {/* Chain table */}
          <div className="options-wrap">
            <div className="scroll-xy">
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
                        <td className={callClass}>{fmtPct(c?.iv)}</td>
                        <td className={callClass}>{fmtDelta(c?.delta)}</td>
                        <td className={callClass}>{fmtNum(c?.ask)}</td>
                        <td className={callClass}>{fmtNum(c?.bid)}</td>
                        <td className={callClass}>{fmtNum(c?.last)}</td>
                        <td className={`strike-sticky ${isAt ? "strike-underlier" : ""}`}>{r.strike}</td>
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

/* ----- Black-Scholes probability of finishing OTM ----- */
/* For calls:  P(OTM) = N(-d2)
   For puts:   P(OTM) = N(d2)
   where d2 = (ln(S/K) + (r - 0.5*σ^2)T) / (σ√T)
   We take r ≈ 0 for simplicity (short-dated). */
function probOTM(
  side: "call" | "put",
  S: number,
  K: number,
  ivFrac: number, // IV as fraction (e.g., 0.25)
  Tyears: number,
  r = 0
): number | null {
  if (![S, K, ivFrac, Tyears].every((v) => typeof v === "number" && v > 0)) return null;
  const sigma = ivFrac;
  const d2 = (Math.log(S / K) + (r - 0.5 * sigma * sigma) * Tyears) / (sigma * Math.sqrt(Tyears));
  const Nd2 = normCdf(d2);
  return side === "call" ? normCdf(-d2) : Nd2;
}

function normCdf(x: number) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number) {
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}
