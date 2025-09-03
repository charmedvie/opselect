import { useMemo, useState } from "react";
import "./App.css";

/* ---------- Types ---------- */
type Side = "call" | "put";

type OptionSide = {
  strike: number;
  type: Side;
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
  delta?: number | null;
  iv?: number | null;     // % (e.g., 24.5)
  gamma?: number | null;  // per share, if provided by API
};

type ExpirySlice = { expiry: string; options: OptionSide[] };

type YieldRow = {
  strike: number;
  bid: number;
  yieldPct: number;   // %
  probOTM: number;    // %
  dte: number;        // days
  delta?: number | null;
  iv?: number | null;
  netGamma?: number | null; // per 100-share contract
  expiry: string;
  side: Side;
};

type ViewMode = "yields" | "chain" | null;

/* ---------- Constants ---------- */
const DTE_BUCKETS = [7, 14, 21, 30] as const;
const MIN_PROB_OTM = 60; // %
const CONTRACT_MULTIPLIER = 100;

/* ---------- Utils ---------- */
const nowMs = () => Date.now();
const daysBetween = (a: number, b: number) => Math.max(0, Math.ceil((b - a) / 86400000));
const fmtNum = (n?: number | null) => (typeof n === "number" && isFinite(n) ? String(n) : "—");
const fmtPct = (n?: number | null) =>
  typeof n === "number" && isFinite(n) ? String(Math.round(n * 100) / 100) : "—";
const fmtDelta = (n?: number | null) =>
  typeof n === "number" && isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : "—";
const fmtGamma = (n?: number | null) =>
  typeof n === "number" && isFinite(n) ? (Math.round(n * 10000) / 10000).toFixed(4) : "—";
const uniqKey = (r: YieldRow) => `${r.side}|${r.expiry}|${r.strike}`;

/* Black–Scholes components */
function probOTM(side: Side, S: number, K: number, ivFrac: number, Tyears: number): number | null {
  if (![S, K, ivFrac, Tyears].every((v) => typeof v === "number" && v > 0)) return null;
  const sigma = ivFrac;
  const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * Tyears) / (sigma * Math.sqrt(Tyears));
  const Nd2 = normCdf(d2);
  return side === "call" ? normCdf(-d2) : Nd2;
}
function bsGammaPerShare(S: number, K: number, ivFrac: number, Tyears: number): number | null {
  if (![S, K, ivFrac, Tyears].every((v) => typeof v === "number" && v > 0)) return null;
  const sigma = ivFrac;
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * Tyears) / (sigma * Math.sqrt(Tyears));
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  return pdf / (S * sigma * Math.sqrt(Tyears)); // same for calls & puts
}
function normCdf(x: number) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1, ax = Math.abs(x), t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

/* ---------- Component ---------- */
export default function App() {
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const [loading, setLoading] = useState(false);     // one loader for flows
  const [chainErr, setChainErr] = useState("");
  const [expiries, setExpiries] = useState<ExpirySlice[]>([]);
  const [uPrice, setUPrice] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [view, setView] = useState<ViewMode>(null);

  /* ---------- Actions ---------- */
  const updateQuote = async (s: string) => {
    setErr("");
    try {
      const res = await fetch(`/api/quote?symbol=${encodeURIComponent(s)}`);
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      const json = JSON.parse(text);
      if (typeof json?.price !== "number") throw new Error("Price not found");
      setPrice(json.price);
      setCurrency(json.currency ?? null);
    } catch (e: any) {
      setPrice(null);
      setCurrency(null);
      throw new Error(e?.message || "Quote fetch failed");
    }
  };

  const fetchOptions = async (s: string) => {
    const url = `/api/options?symbol=${encodeURIComponent(s)}`;
    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) throw new Error(text);
    const json = JSON.parse(text);
    if (!json?.expiries?.length) throw new Error("No options data found.");
    setUPrice(typeof json.underlierPrice === "number" ? json.underlierPrice : null);
    setExpiries(json.expiries);
  };

  const runFlow = async (targetView: ViewMode) => {
    const s = symbol.trim().toUpperCase();
    setSymbol(s);
    if (!s) return setErr("Enter a ticker first.");
    setLoading(true);
    setChainErr("");
    try {
      await updateQuote(s);
      await fetchOptions(s);
      setView(targetView);
      setActiveIdx(0);
    } catch (e: any) {
      setChainErr(e?.message || "Options fetch failed");
    } finally {
      setLoading(false);
    }
  };

  /* ---------- Derived: Top Yields (OTM only), merged & sorted ---------- */
  const topYields = useMemo(() => {
    if (!expiries.length || uPrice == null) return null;

    const now = nowMs();

    // Precompute (expiry -> DTE) once
    const expDte = expiries.map((ex) => ({
      ex,
      dte: daysBetween(now, Date.parse(ex.expiry)),
    }));

    // For each target DTE, select nearest expiry once
    const nearestByBucket = new Map<number, { ex: ExpirySlice; dte: number }>();
    for (const target of DTE_BUCKETS) {
      let best = null as null | { ex: ExpirySlice; dte: number; diff: number };
      for (const e of expDte) {
        const diff = Math.abs(e.dte - target);
        if (!best || diff < best.diff) best = { ex: e.ex, dte: e.dte, diff };
      }
      if (best) nearestByBucket.set(target, { ex: best.ex, dte: best.dte });
    }

    const callsAll: YieldRow[] = [];
    const putsAll: YieldRow[] = [];

    for (const target of DTE_BUCKETS) {
      const near = nearestByBucket.get(target);
      if (!near) continue;

      const Tyears = Math.max(1 / 365, near.dte / 365);

      for (const o of near.ex.options) {
        if (typeof o.bid !== "number" || typeof o.strike !== "number" || o.strike <= 0) continue;
        if (typeof o.iv !== "number" || o.iv <= 0) continue;

        // OTM only
        if (o.type === "call" && !(o.strike > uPrice)) continue;
        if (o.type === "put" && !(o.strike < uPrice)) continue;

        const p = probOTM(o.type, uPrice, o.strike, o.iv / 100, Tyears);
        if (p == null) continue;
        const probPct = p * 100;
        if (probPct < MIN_PROB_OTM) continue;

        // Net Gamma (per-contract)
        // prefer API gamma (per share) if present; else compute BS gamma per share
        const perShareGamma =
          typeof o.gamma === "number" && isFinite(o.gamma)
            ? o.gamma
            : bsGammaPerShare(uPrice, o.strike, o.iv / 100, Tyears);
        const netGamma = typeof perShareGamma === "number" ? perShareGamma * CONTRACT_MULTIPLIER : null;

        const row: YieldRow = {
          strike: o.strike,
          bid: o.bid,
          yieldPct: (o.bid / o.strike) * 100,
          probOTM: probPct,
          dte: near.dte,
          delta: o.delta,
          iv: o.iv,
          netGamma,
          expiry: near.ex.expiry,
          side: o.type,
        };

        (o.type === "call" ? callsAll : putsAll).push(row);
      }
    }

    // dedupe & sort
    const dedupe = (arr: YieldRow[]) => {
      const seen = new Set<string>();
      const out: YieldRow[] = [];
      for (const r of arr) {
        const k = uniqKey(r);
        if (!seen.has(k)) { seen.add(k); out.push(r); }
      }
      return out;
    };

    const callsTop = dedupe(callsAll).sort((a, b) => b.yieldPct - a.yieldPct).slice(0, 10);
    const putsTop  = dedupe(putsAll ).sort((a, b) => b.yieldPct - a.yieldPct).slice(0, 10);

    return { callsTop, putsTop };
  }, [expiries, uPrice]);

  /* ---------- Active expiry rows for the chain ---------- */
  const rows = useMemo(() => {
    const ex = expiries[activeIdx];
    if (!ex) return [] as { strike: number; call: OptionSide | null; put: OptionSide | null }[];

    const callsByStrike = new Map<number, OptionSide>();
    const putsByStrike = new Map<number, OptionSide>();
    for (const o of ex.options) (o.type === "call" ? callsByStrike : putsByStrike).set(o.strike, o);

    const strikes = Array.from(new Set([...callsByStrike.keys(), ...putsByStrike.keys()])).sort((a, b) => a - b);

    return strikes.map((strike) => ({
      strike,
      call: callsByStrike.get(strike) ?? null,
      put: putsByStrike.get(strike) ?? null,
    }));
  }, [expiries, activeIdx]);

  /* ---------- Render ---------- */
  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1200, margin: "0 auto" }}>
      <h1>Stock Price Lookup</h1>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && runFlow("yields")}
          placeholder="Enter ticker (e.g., AAPL)"
          style={{ textTransform: "uppercase", padding: 8, minWidth: 220 }}
        />
        <button onClick={() => runFlow("yields")} disabled={loading || !symbol.trim()}>
          {loading && view === "yields" ? "Loading…" : "Check Yields"}
        </button>
        <button onClick={() => runFlow("chain")} disabled={loading || !symbol.trim()}>
          {loading && view === "chain" ? "Loading…" : "Options Chain"}
        </button>
      </div>

      {/* Price + errors */}
      {err && <p style={{ color: "crimson", marginTop: 8 }}>{err}</p>}
      {price !== null && !err && (
        <p style={{ marginTop: 8 }}>
          Current Price for <strong>{symbol}</strong>: {currency ? `${currency} ` : "$"}
          {price}
        </p>
      )}
      {chainErr && <p style={{ color: "crimson", marginTop: 8 }}>{chainErr}</p>}

      {/* ---- Show one section at a time ---- */}

      {/* Yields ONLY */}
      {view === "yields" && topYields && uPrice != null && (
        <div className="yields-panel">
          <div className="y-meta">
            Underlier: <strong>{uPrice}</strong> • Yield = <code>bid / strike</code> • OTM only • Prob OTM ≥ {MIN_PROB_OTM}% • Top 10
          </div>

          <div className="yields-grid">
            {/* Calls */}
            <div className="yield-card">
              <h4><span className="y-badge">Calls (Top 10)</span></h4>
              <table className="yield-table">
                <thead>
                  <tr>
                    <th>Strike</th>
                    <th>DTE</th>
                    <th>Bid</th>
                    <th>Delta</th>
                    <th>Net Gamma</th>
                    <th>Yield</th>
                    <th>Prob OTM</th>
                  </tr>
                </thead>
                <tbody>
                  {topYields.callsTop.length ? (
                    topYields.callsTop.map((r) => (
                      <tr key={`c-${r.expiry}-${r.strike}`}>
                        <td style={{ textAlign: "left" }}>{r.strike}</td>
                        <td>{r.dte}</td>
                        <td>{fmtNum(r.bid)}</td>
                        <td>{fmtDelta(r.delta)}</td>
                        <td>{fmtGamma(r.netGamma)}</td>
                        <td>{fmtPct(r.yieldPct)}%</td>
                        <td>{fmtPct(r.probOTM)}%</td>
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={7} style={{ textAlign: "center" }}>—</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Puts */}
            <div className="yield-card">
              <h4><span className="y-badge">Puts (Top 10)</span></h4>
              <table className="yield-table">
                <thead>
                  <tr>
                    <th>Strike</th>
                    <th>DTE</th>
                    <th>Bid</th>
                    <th>Delta</th>
                    <th>Net Gamma</th>
                    <th>Yield</th>
                    <th>Prob OTM</th>
                  </tr>
                </thead>
                <tbody>
                  {topYields.putsTop.length ? (
                    topYields.putsTop.map((r) => (
                      <tr key={`p-${r.expiry}-${r.strike}`}>
                        <td style={{ textAlign: "left" }}>{r.strike}</td>
                        <td>{r.dte}</td>
                        <td>{fmtNum(r.bid)}</td>
                        <td>{fmtDelta(r.delta)}</td>
                        <td>{fmtGamma(r.netGamma)}</td>
                        <td>{fmtPct(r.yieldPct)}%</td>
                        <td>{fmtPct(r.probOTM)}%</td>
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={7} style={{ textAlign: "center" }}>—</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Chain ONLY */}
      {view === "chain" && expiries.length > 0 && (
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
                    <th>IV %</th>
                    <th>Delta</th>
                    <th>Ask</th>
                    <th>Bid</th>
                    <th>Last</th>
                    <th className="strike-sticky">-</th>
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
                      c && uPrice !== null ? (r.strike < uPrice ? "call-itm" : "call-otm") : "";
                    const putClass =
                      p && uPrice !== null ? (r.strike > uPrice ? "put-itm" : "put-otm") : "";

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
                      </td></tr>
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
    return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  }
  return s;
}
