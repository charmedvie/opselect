// App.tsx — Options + Ticker app (forward-d2 OTM + IV interpolation + Yield Goal columns)
import React, { useMemo, useState } from "react";

// ----------------------------- Types -----------------------------
type OptionType = "call" | "put";

type Quote = {
  symbol: string;
  price: number;
  dividendYield?: number; // decimal, e.g., 0.012 for 1.2%
};

type ChainLeg = {
  type: OptionType;
  strike: number;
  expiry: string; // ISO date
  last?: number;  // premium; fallback to mid if needed
  bid?: number;
  ask?: number;
  iv?: number;    // decimal per strike if available
  delta?: number; // optional if your API gives it
  gamma?: number; // optional if your API gives it
  openInterest?: number;
};

type OptionsChain = ChainLeg[];

// ----------------------------- Config -----------------------------
const DEFAULT_RISK_FREE = 0.04; // simple proxy if you don't have a term-structure

// Wire these to your existing data layer:
async function fetchQuote(symbol: string): Promise<Quote> {
  // Replace with your real implementation
  // Must return {symbol, price, dividendYield?}
  const res = await fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error("Failed to fetch quote");
  return res.json();
}

async function fetchOptionsChain(symbol: string): Promise<OptionsChain> {
  // Replace with your real implementation
  const res = await fetch(`/api/options?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error("Failed to fetch options chain");
  return res.json();
}

// ----------------------------- Math Utils -----------------------------
const erf = (x: number) => {
  // Abramowitz–Stegun (good enough for CDF)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
};
const N = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

// Return a rough term structure if you want (can replace with real curve)
function riskFreeRateAnnual(Tyrs: number): number {
  // Simple: default for now
  return DEFAULT_RISK_FREE;
}

// Black–Scholes greeks (spot/forward form)
function d2_forward(S: number, K: number, T: number, iv: number, r: number, q: number): number {
  const sigma = Math.max(iv, 0.01);
  const TT = Math.max(T, 1 / 365);
  const F = S * Math.exp((r - q) * TT);
  return (Math.log(F / K) - 0.5 * sigma * sigma * TT) / (sigma * Math.sqrt(TT));
}

function probOTM_forwardD2(
  S: number,
  K: number,
  Tyrs: number,
  iv: number,
  r: number,
  q: number,
  type: OptionType
): number {
  const d2 = d2_forward(S, K, Tyrs, iv, r, q);
  return type === "call" ? N(-d2) : N(d2);
}

function bsDelta(
  S: number, K: number, T: number, iv: number, r: number, q: number, type: OptionType
): number {
  const sigma = Math.max(iv, 0.01);
  const TT = Math.max(T, 1 / 365);
  const F = S * Math.exp((r - q) * TT);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * TT) / (sigma * Math.sqrt(TT));
  const callDelta = Math.exp(-q * TT) * N(d1);
  return type === "call" ? callDelta : callDelta - Math.exp(-q * TT);
}

function bsGamma(S: number, K: number, T: number, iv: number, r: number, q: number): number {
  const sigma = Math.max(iv, 0.01);
  const TT = Math.max(T, 1 / 365);
  const F = S * Math.exp((r - q) * TT);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * TT) / (sigma * Math.sqrt(TT));
  const nPrime = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  // Spot gamma
  return (Math.exp(-q * TT) * nPrime) / (S * sigma * Math.sqrt(TT));
}

// Interpolate IV within a single expiry in log-moneyness space
function interpolateIV_logMoneyness(
  S: number,
  ivPoints: Array<{ K: number; iv: number }>,
  targetK: number
): number | null {
  const pts = ivPoints
    .filter((p) => isFinite(p.K) && p.K > 0 && isFinite(p.iv) && p.iv > 0)
    .map((p) => ({ x: Math.log(p.K / S), y: p.iv }))
    .sort((a, b) => a.x - b.x);

  if (pts.length === 0) return null;
  const tx = Math.log(targetK / S);

  // exact
  for (const p of pts) if (Math.abs(p.x - tx) < 1e-12) return p.y;

  // clamp
  if (tx <= pts[0].x) return pts[0].y;
  if (tx >= pts[pts.length - 1].x) return pts[pts.length - 1].y;

  // linear segment
  for (let i = 1; i < pts.length; i++) {
    const L = pts[i - 1],
      R = pts[i];
    if (tx >= L.x && tx <= R.x) {
      const t = (tx - L.x) / (R.x - L.x);
      return L.y + t * (R.y - L.y);
    }
  }
  return pts[0].y;
}

// ----------------------------- Yield Goal helpers -----------------------------
function yieldGoalByDTE(dte: number): number {
  if (dte >= 22 && dte <= 31) return 0.004; // 0.40%
  if (dte >= 15 && dte <= 21) return 0.003; // 0.30%
  if (dte >= 8 && dte <= 14) return 0.0018; // 0.18%
  return 0.0009; // 0–7 DTE (and negatives treated as 0)
}

const fmtPct = (v: number) => (isFinite(v) ? (v * 100).toFixed(2) + "%" : "—");
const fmtBps = (v: number) => (isFinite(v) ? `${Math.round(v)} bps` : "—");
const fmt2 = (v: number) => (isFinite(v) ? v.toFixed(2) : "—");

// ----------------------------- Component -----------------------------
type View = "yields" | "chain";

export default function App() {
  const [symbol, setSymbol] = useState("AMZN");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [chain, setChain] = useState<OptionsChain>([]);
  const [view, setView] = useState<View>("yields");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refreshPriceAnd(viewToShow: View) {
    try {
      setLoading(true);
      setError(null);
      const [q, c] = await Promise.all([fetchQuote(symbol.trim()), fetchOptionsChain(symbol.trim())]);
      setQuote(q);
      setChain(c || []);
      setView(viewToShow);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // Group chain by expiry for IV interpolation
  const chainByExpiry = useMemo(() => {
    const map = new Map<string, ChainLeg[]>();
    for (const leg of chain) {
      const k = leg.expiry;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(leg);
    }
    return map;
  }, [chain]);

  // Build Yields table rows
  const yieldRows = useMemo(() => {
    if (!quote || chain.length === 0) return [];
    const spot = quote.price;
    const now = Date.now();

    const rows: Array<{
      type: OptionType;
      ticker: string;
      strike: number;
      expiry: string;
      dte: number;
      probOtm: number;
      yieldDec: number;
      delta: number;
      gamma: number;
      netGamma?: number;
      ivUsed: number;
      yieldGoal: number;
      vsGoalBps: number;
      oi?: number;
      premium: number;
    }> = [];

    for (const [expiry, legs] of chainByExpiry.entries()) {
      const expiryMs = new Date(expiry).getTime();
      const dte = Math.max(0, Math.round((expiryMs - now) / (1000 * 60 * 60 * 24)));
      const Tyrs = Math.max(1 / 365, (expiryMs - now) / (365 * 24 * 60 * 60 * 1000));

      // Gather IV points for this expiry
      const ivPoints = legs
        .filter((x) => isFinite(x.strike) && x.strike > 0 && isFinite(x.iv || NaN) && (x.iv as number) > 0)
        .map((x) => ({ K: x.strike, iv: x.iv as number }));

      const q = Math.max(0, quote.dividendYield ?? 0);
      const r = riskFreeRateAnnual(Tyrs);

      for (const leg of legs) {
        // Premium: prefer last, fallback to mid, else bid
        const mid = isFinite((leg.bid ?? NaN)) && isFinite((leg.ask ?? NaN)) ? ((leg.bid! + leg.ask!) / 2) : undefined;
        const premium = isFinite(leg.last ?? NaN)
          ? (leg.last as number)
          : isFinite(mid ?? NaN)
          ? (mid as number)
          : (leg.bid ?? 0);

        if (!isFinite(premium) || premium <= 0) continue;

        // IV selection: per-strike if valid, else interpolate within expiry, else fallback to ATM-like
        let iv = leg.iv ?? NaN;
        if (!isFinite(iv) || iv <= 0) {
          const interp = interpolateIV_logMoneyness(spot, ivPoints, leg.strike);
          if (interp && isFinite(interp)) iv = interp;
        }
        if (!isFinite(iv) || iv <= 0) {
          // very last resort: small positive IV so maths doesn't explode
          iv = 0.25;
        }

        // Prob OTM (forward-based d2)
        const probOtm = probOTM_forwardD2(spot, leg.strike, Tyrs, iv, r, q, leg.type);

        // Filter: OTM probability >= 60%
        if (probOtm < 0.60) continue;

        // Delta/Gamma (prefer API values if present)
        const delta = isFinite(leg.delta ?? NaN)
          ? (leg.delta as number)
          : bsDelta(spot, leg.strike, Tyrs, iv, r, q, leg.type);

        const gammaSpot = isFinite(leg.gamma ?? NaN)
          ? (leg.gamma as number)
          : bsGamma(spot, leg.strike, Tyrs, iv, r, q);

        // NetGamma: gamma per contract * 100 * OI (approx)
        const oi = leg.openInterest;
        const netGamma = isFinite(oi ?? NaN) ? gammaSpot * 100 * (oi as number) : undefined;

        // Yield (decimal) — simple non-annualised premium/collateral
        // For CSPs, collateral ≈ strike; for CCs collateral is typically the underlying.
        const collateral = leg.type === "put" ? leg.strike : spot; // adjust if you use different convention
        const yieldDec = premium / collateral;

        // Yield Goal + Vs goal
        const yieldGoal = yieldGoalByDTE(dte);
        const vsGoalBps = (yieldDec - yieldGoal) * 10000;

        rows.push({
          type: leg.type,
          ticker: quote.symbol,
          strike: leg.strike,
          expiry,
          dte,
          probOtm,
          yieldDec,
          delta,
          gamma: gammaSpot,
          netGamma,
          ivUsed: iv,
          yieldGoal,
          vsGoalBps,
          oi,
          premium,
        });
      }
    }

    // Sort by yield desc and take top 10
    return rows.sort((a, b) => b.yieldDec - a.yieldDec).slice(0, 10);
  }, [quote, chain, chainByExpiry]);

  // ----------------------------- Render -----------------------------
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 16, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Options & Ticker</h1>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="Ticker (e.g., AMZN)"
          style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #ccc", width: 160 }}
        />
        <button
          onClick={() => refreshPriceAnd("yields")}
          disabled={loading || !symbol.trim()}
          style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd", boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}
        >
          Check Yields
        </button>
        <button
          onClick={() => refreshPriceAnd("chain")}
          disabled={loading || !symbol.trim()}
          style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ddd", boxShadow: "0 1px 4px rgba(0,0,0,0.1)" }}
        >
          Options Chain
        </button>
        {quote && (
          <div style={{ marginLeft: 12, opacity: 0.85 }}>
            <strong>{quote.symbol}</strong> spot: ${fmt2(quote.price)}
          </div>
        )}
      </div>

      {error && <div style={{ color: "#b00020", marginBottom: 8 }}>{error}</div>}
      {loading && <div style={{ marginBottom: 8 }}>Loading…</div>}

      {!loading && view === "yields" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Ticker</Th>
                <Th>Strike</Th>
                <Th>Expiry</Th>
                <Th>DTE</Th>
                <Th>Prob OTM</Th>
                <Th>Yield Goal</Th>
                <Th>Vs goal</Th>
                <Th>Yield</Th>
                <Th>Delta</Th>
                <Th>Gamma</Th>
                <Th>Net Gamma</Th>
                <Th>IV used</Th>
                <Th>OI</Th>
                <Th>Premium</Th>
              </tr>
            </thead>
            <tbody>
              {yieldRows.map((r, idx) => (
                <tr key={idx} style={{ borderTop: "1px solid #eee" }}>
                  <Td>{r.type.toUpperCase()}</Td>
                  <Td>{r.ticker}</Td>
                  <Td>{fmt2(r.strike)}</Td>
                  <Td>{r.expiry.slice(0, 10)}</Td>
                  <Td>{r.dte}</Td>
                  <Td>{fmtPct(r.probOtm)}</Td>
                  <Td>{fmtPct(r.yieldGoal)}</Td>
                  <Td style={{ color: r.vsGoalBps >= 0 ? "#136f2a" : "#9b1c1c" }}>
                    {(r.vsGoalBps > 0 ? "+" : "") + fmtBps(r.vsGoalBps)}
                  </Td>
                  <Td>{fmtPct(r.yieldDec)}</Td>
                  <Td>{fmt2(r.delta)}</Td>
                  <Td>{r.gamma.toExponential(3)}</Td>
                  <Td>{isFinite(r.netGamma ?? NaN) ? (r.netGamma as number).toExponential(3) : "—"}</Td>
                  <Td>{fmtPct(r.ivUsed)}</Td>
                  <Td>{isFinite(r.oi ?? NaN) ? r.oi : "—"}</Td>
                  <Td>{fmt2(r.premium)}</Td>
                </tr>
              ))}
              {yieldRows.length === 0 && (
                <tr>
                  <Td colSpan={15} style={{ padding: 16, textAlign: "center", opacity: 0.7 }}>
                    No rows (check symbol or filters).
                  </Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {!loading && view === "chain" && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <Th>Type</Th>
                <Th>Strike</Th>
                <Th>Expiry</Th>
                <Th>Bid</Th>
                <Th>Ask</Th>
                <Th>Last</Th>
                <Th>IV</Th>
                <Th>Delta</Th>
                <Th>Gamma</Th>
                <Th>OI</Th>
              </tr>
            </thead>
            <tbody>
              {chain.map((c, i) => (
                <tr key={i} style={{ borderTop: "1px solid #eee" }}>
                  <Td>{c.type.toUpperCase()}</Td>
                  <Td>{fmt2(c.strike)}</Td>
                  <Td>{c.expiry.slice(0, 10)}</Td>
                  <Td>{isFinite(c.bid ?? NaN) ? fmt2(c.bid as number) : "—"}</Td>
                  <Td>{isFinite(c.ask ?? NaN) ? fmt2(c.ask as number) : "—"}</Td>
                  <Td>{isFinite(c.last ?? NaN) ? fmt2(c.last as number) : "—"}</Td>
                  <Td>{isFinite(c.iv ?? NaN) ? fmtPct(c.iv as number) : "—"}</Td>
                  <Td>{isFinite(c.delta ?? NaN) ? fmt2(c.delta as number) : "—"}</Td>
                  <Td>{isFinite(c.gamma ?? NaN) ? (c.gamma as number).toExponential(3) : "—"}</Td>
                  <Td>{isFinite(c.openInterest ?? NaN) ? c.openInterest : "—"}</Td>
                </tr>
              ))}
              {chain.length === 0 && (
                <tr>
                  <Td colSpan={10} style={{ padding: 16, textAlign: "center", opacity: 0.7 }}>
                    No chain loaded yet.
                  </Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ----------------------------- Small UI bits -----------------------------
function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: "left",
        padding: "10px 8px",
        fontWeight: 600,
        borderBottom: "1px solid #ddd",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  colSpan,
  style,
}: {
  children: React.ReactNode;
  colSpan?: number;
  style?: React.CSSProperties;
}) {
  return (
    <td style={{ padding: "8px 8px", whiteSpace: "nowrap", ...style }} colSpan={colSpan}>
      {children}
    </td>
  );
}
