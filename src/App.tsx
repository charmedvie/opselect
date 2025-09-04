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
};

type ExpirySlice = { expiry: string; options: OptionSide[] };

type YieldRow = {
  strike: number;
  bid: number;
  yieldPct: number;   // %
  probOTM: number;    // %
  yieldGoalPct: number; // %
  vsGoalBps: number;    // basis points (can be +/-)
  dte: number;        // days
  delta?: number | null;
  iv?: number | null; // %
  expiry: string;
  side: Side;
};

type ViewMode = "yields" | "chain" | null;

/* ---------- Constants ---------- */
const DTE_BUCKETS = [7, 14, 21, 30] as const;
const MIN_PROB_OTM = 60; // %
const DEFAULT_RISK_FREE = 0.04; // r (annualised)
const DEFAULT_DIVIDEND_YIELD = 0.0; // q (annualised)

/* ---------- Utils ---------- */
const nowMs = () => Date.now();
const daysBetween = (a: number, b: number) => Math.max(0, Math.ceil((b - a) / 86400000));
const fmtNum = (n?: number | null) => (typeof n === "number" && isFinite(n) ? String(n) : "—");
const fmtPct = (n?: number | null) =>
  typeof n === "number" && isFinite(n) ? String(Math.round(n * 100) / 100) : "—";
const fmtDelta = (n?: number | null) =>
  typeof n === "number" && isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : "—";
const fmt0 = (n?: number | null) =>
  typeof n === "number" && isFinite(n) ? String(Math.round(n)) : "—";
const uniqKey = (r: YieldRow) => `${r.side}|${r.expiry}|${r.strike}`;

/* ------ Yield goal helpers (percent values, e.g., 0.40 for 0.40%) ------ */
function yieldGoalByDTE(dte: number): number {
  if (dte >= 22 && dte <= 31) return 0.40;
  if (dte >= 15 && dte <= 21) return 0.30;
  if (dte >= 8  && dte <= 14) return 0.18;
  return 0.09; // 0–7 DTE (and anything else)
}

/* ---------- Normal CDF / erf ---------- */
function normCdf(x: number) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x: number) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1, ax = Math.abs(x), t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-ax * ax);
  return sign * y;
}

/* ---------- Black–Scholes components (forward-based d2) ---------- */
// Probability an option finishes OTM using forward-based d2.
// Inputs: ivFrac is decimal (e.g., 0.24), Tyears in years, r = risk-free, q = dividend yield.
function probOTM_forward(
  side: Side, S: number, K: number, ivFrac: number, Tyears: number, r = DEFAULT_RISK_FREE, q = DEFAULT_DIVIDEND_YIELD
): number | null {
  if (![S, K, ivFrac, Tyears].every((v) => typeof v === "number" && v > 0)) return null;
  const sigma = Math.max(ivFrac, 0.01);
  const T = Math.max(Tyears, 1 / 365);
  const F = S * Math.exp((r - q) * T);
  const d2 = (Math.log(F / K) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
  const Nd2 = normCdf(d2);
  return side === "call" ? normCdf(-d2) : Nd2;
}

/* ---------- IV interpolation in log-moneyness (per expiry) ---------- */
// Returns iv as a FRACTION (e.g., 0.24) or null if impossible.
function interpolateIV_logMoneyness(
  S: number,
  points: Array<{ K: number; ivFrac: number }>,
  targetK: number
): number | null {
  const pts = points
    .filter(p => isFinite(p.K) && p.K > 0 && isFinite(p.ivFrac) && p.ivFrac > 0)
    .map(p => ({ x: Math.log(p.K / S), y: p.ivFrac }))
    .sort((a, b) => a.x - b.x);
  if (pts.length === 0 || !isFinite(targetK) || targetK <= 0) return null;

  const tx = Math.log(targetK / S);
  for (const p of pts) if (Math.abs(p.x - tx) < 1e-12) return p.y;
  if (tx <= pts[0].x) return pts[0].y;
  if (tx >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 1; i < pts.length; i++) {
    const L = pts[i - 1], R = pts[i];
    if (tx >= L.x && tx <= R.x) {
      const t = (tx - L.x) / (R.x - L.x);
      return L.y + t * (R.y - L.y);
    }
  }
  return null;
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
  const [dataTimestamp, setDataTimestamp] = useState<string | null>(null);

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
      setDataTimestamp(new Date().toLocaleString());
    } catch (e: any) {
      setChainErr(e?.message || "Options fetch failed");
    } finally {
      setLoading(false);
    }
  };

  /* ---------- Simple Stock IV estimate (unchanged) ---------- */
  const stockIvPct = useMemo(() => {
    if (!expiries.length || uPrice == null) return null;
    const now = nowMs();
    let best: { ex: ExpirySlice; dte: number } | null = null;
    for (const ex of expiries) {
      const dte = daysBetween(now, Date.parse(ex.expiry));
      if (!best || dte < best.dte) best = { ex, dte };
    }
    if (!best) return null;

    let nearestCallIv: number | null = null;
    let nearestPutIv: number | null = null;
    let minDiffCall = Infinity, minDiffPut = Infinity;

    for (const o of best.ex.options) {
      if (typeof o.strike !== "number" || o.strike <= 0) continue;
      const diff = Math.abs(o.strike - uPrice);
      if (o.type === "call" && diff < minDiffCall) {
        minDiffCall = diff;
        nearestCallIv = typeof o.iv === "number" ? o.iv : null;
      }
      if (o.type === "put" && diff < minDiffPut) {
        minDiffPut = diff;
        nearestPutIv = typeof o.iv === "number" ? o.iv : null;
      }
    }
    const ivs: number[] = [];
    if (nearestCallIv != null) ivs.push(nearestCallIv);
    if (nearestPutIv != null) ivs.push(nearestPutIv);
    if (!ivs.length) return null;
    return Math.round((ivs.reduce((a, b) => a + b, 0) / ivs.length) * 100) / 100;
  }, [expiries, uPrice]);

  /* ---------- Derived: Top Yields (PUTS ONLY), with Vs-goal ---------- */
  const topPuts = useMemo(() => {
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

    const putsAll: YieldRow[] = [];

    for (const target of DTE_BUCKETS) {
      const near = nearestByBucket.get(target);
      if (!near) continue;

      const Tyears = Math.max(1 / 365, near.dte / 365);

      // Build IV points for this expiry (average across sides if duplicated)
      const ivPoints: Array<{ K: number; ivFrac: number }> = [];
      {
        const tmp = new Map<number, number[]>();
        for (const o of near.ex.options) {
          if (typeof o.strike === "number" && o.strike > 0 && typeof o.iv === "number" && o.iv > 0) {
            if (!tmp.has(o.strike)) tmp.set(o.strike, []);
            tmp.get(o.strike)!.push(o.iv / 100); // store as fraction
          }
        }
        for (const [K, arr] of tmp.entries()) {
          const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
          ivPoints.push({ K, ivFrac: mean });
        }
      }

      for (const o of near.ex.options) {
        if (o.type !== "put") continue; // PUTS ONLY
        if (typeof o.bid !== "number" || o.bid <= 0) continue;
        if (typeof o.strike !== "number" || o.strike <= 0) continue;

        // OTM only
        if (!(o.strike < uPrice)) continue;

        // Resolve IV (fraction)
        let ivFrac: number | null =
          typeof o.iv === "number" && o.iv > 0 ? o.iv / 100 : interpolateIV_logMoneyness(uPrice, ivPoints, o.strike);
        if (ivFrac == null || !isFinite(ivFrac) || ivFrac <= 0) continue;

        // Prob OTM (forward-based d2 with r, q)
        const p = probOTM_forward(o.type, uPrice, o.strike, ivFrac, Tyears, DEFAULT_RISK_FREE, DEFAULT_DIVIDEND_YIELD);
        if (p == null) continue;
        const probPct = p * 100;
        if (probPct < MIN_PROB_OTM) continue;

        // Yield (%)
        const yieldPct = (o.bid / o.strike) * 100;

        // Yield goal & vs goal (bps)
        const yieldGoalPct = yieldGoalByDTE(near.dte); // percent value, e.g., 0.40
        const vsGoalBps = (yieldPct - yieldGoalPct) * 100; // 1% = 100 bps

        const row: YieldRow = {
          strike: o.strike,
          bid: o.bid,
          yieldPct,
          probOTM: probPct,
          yieldGoalPct,
          vsGoalBps,
          dte: near.dte,
          delta: o.delta,
          iv: typeof o.iv === "number" && o.iv > 0 ? o.iv : Math.round(ivFrac * 10000) / 100, // store as %
          expiry: near.ex.expiry,
          side: o.type,
        };

        putsAll.push(row);
      }
    }

    // dedupe & sort
    const seen = new Set<string>();
    const out: YieldRow[] = [];
    for (const r of putsAll) {
      const k = uniqKey(r);
      if (!seen.has(k)) { seen.add(k); out.push(r); }
    }
    const putsTop = out.sort((a, b) => b.yieldPct - a.yieldPct).slice(0, 10);
    return putsTop;
  }, [expiries, uPrice]);

  /* ---------- Row gradient (soft greens) based on Vs goal (bps) ---------- */
  function rowStyle(v: number, min: number, max: number) {
    const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const t = max > min ? clamp((v - min) / (max - min), 0, 1) : 0.5;
    // softer than before: very light mint -> soft green
    const l = lerp(96, 86, t);  // lightness 96% -> 86%
    const s = lerp(28, 40, t);  // saturation 28% -> 40%
    return { background: `hsl(140 ${s}% ${l}%)` } as const;
  }

  /* ---------- Active expiry rows for the chain (unchanged) ---------- */
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
      <h1 style={{ marginBottom: 8 }}>Options Selector</h1>

      {/* Controls */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && runFlow("yields")}
          placeholder="Enter ticker (e.g., AAPL)"
          style={{ textTransform: "uppercase", padding: 10, minWidth: 220, borderRadius: 8, border: "1px solid #cbd5e1" }}
        />
        <button
          onClick={() => runFlow("yields")}
          disabled={loading || !symbol.trim()}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #c7e9d8",
            background: "#eaf7f0",
            color: "#0f5132",
            cursor: loading || !symbol.trim() ? "not-allowed" : "pointer",
          }}
        >
          {loading && view === "yields" ? "Loading…" : "Check Yields"}
        </button>
        <button
          onClick={() => runFlow("chain")}
          disabled={loading || !symbol.trim()}
          style={{
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #cfe2ff",
            background: "#eef5ff",
            color: "#084298",
            cursor: loading || !symbol.trim() ? "not-allowed" : "pointer",
          }}
        >
          {loading && view === "chain" ? "Loading…" : "Options Chain"}
        </button>

        {price !== null && !err && (
          <span
            style={{
              marginLeft: 12,
              padding: "6px 10px",
              borderRadius: 8,
              background: "#fff3cd",
              color: "#7a5d00",
              border: "1px solid #ffe69c",
              fontWeight: 600,
            }}
          >
            {currency ? `${currency} ` : "$"}{price}
          </span>
        )}
      </div>

      {/* Errors */}
      {err && <p style={{ color: "crimson", marginTop: 8 }}>{err}</p>}
      {chainErr && <p style={{ color: "crimson", marginTop: 8 }}>{chainErr}</p>}

      {/* ---- Yields ONLY (PUTS ONLY) ---- */}
      {view === "yields" && topPuts && uPrice != null && (
        <div className="yields-panel" style={{ marginTop: 12 }}>
          {/* Timestamp only (as you asked earlier) */}
          <div className="y-meta" style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            Data timestamp: <strong>{dataTimestamp ?? new Date().toLocaleString()}</strong>
          </div>

          {/* Simple Stock IV box */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, background: "#fafafa" }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 4 }}>Stock IV (est.)</div>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                {stockIvPct != null ? `${stockIvPct}%` : "—"}
              </div>
            </div>
          </div>

          {/* Puts table only, entire row uses soft green gradient by Vs goal */}
          <div className="yields-grid">
            <div className="yield-card">
              <h4><span className="y-badge">Puts (Top 10)</span></h4>
              {(() => {
                const puts = topPuts ?? [];
                let min = 0, max = 0;
                if (puts.length) {
                  min = puts[0].vsGoalBps; max = puts[0].vsGoalBps;
                  for (const r of puts) {
                    if (r.vsGoalBps < min) min = r.vsGoalBps;
                    if (r.vsGoalBps > max) max = r.vsGoalBps;
                  }
                }
                return (
                  <table className="yield-table">
                    <thead>
                      <tr>
                        <th>Strike</th>
                        <th>DTE</th>
                        <th>Bid</th>
                        <th>Delta</th>
                        <th>Yield</th>
                        <th>Prob OTM</th>
                        <th>Yield Goal</th>
                        <th>Vs goal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {puts.length ? (
                        puts.map((r) => (
                          <tr key={`p-${r.expiry}-${r.strike}`} style={rowStyle(r.vsGoalBps, min, max)}>
                            <td style={{ textAlign: "left" }}>{r.strike}</td>
                            <td>{r.dte}</td>
                            <td>{fmtNum(r.bid)}</td>
                            <td>{fmtDelta(r.delta)}</td>
                            <td>{fmtPct(r.yieldPct)}%</td>
                            <td>{fmt0(r.probOTM)}%</td>
                            <td>{fmtPct(r.yieldGoalPct)}%</td>
                            <td>{(Math.round(r.vsGoalBps) >= 0 ? "+" : "") + Math.round(r.vsGoalBps) + " bps"}</td>
                          </tr>
                        ))
                      ) : (
                        <tr><td colSpan={8} style={{ textAlign: "center" }}>—</td></tr>
                      )}
                    </tbody>
                  </table>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ---- Chain ONLY (unchanged) ---- */}
      {view === "chain" && expiries.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {/* Tabs */}
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
            {expiries.map((ex: ExpirySlice, i: number) => (
              <button
                key={ex.expiry + i}
                onClick={() => setActiveIdx(i)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid #e2e8f0",
                  background: i === activeIdx ? "#eaf2ff" : "#ffffff",
                  color: "#111827",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
                title={ex.expiry}
              >
                {formatExpiry(ex.expiry)}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
            Data timestamp: <strong>{dataTimestamp ?? new Date().toLocaleString()}</strong>
          </div>

          {/* Underlier badge */}
          {uPrice !== null && (
            <div style={{ marginTop: 2, marginBottom: 8, display: "inline-block",
              padding: "4px 8px", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
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
