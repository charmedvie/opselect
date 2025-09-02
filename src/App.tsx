import { useMemo, useState } from "react";

/** ===== Expected /api/options response (example) =====
type OptionSide = {
  strike: number;
  type: "call" | "put";
  last?: number | null;
  bid?: number | null;
  ask?: number | null;
  delta?: number | null;      // e.g., 0.42 or -0.58
  iv?: number | null;         // e.g., 24.3 for 24.3%
};

type ExpirySlice = {
  expiry: string;             // ISO date or YYYY-MM-DD
  options: OptionSide[];      // mixed calls & puts
};

type OptionsChainResponse = {
  symbol: string;
  underlierPrice?: number;    // optional, but helpful for centering 50 strikes
  expiries: ExpirySlice[];
};
======================================================= */

export default function App() {
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState<number | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // Options chain state
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
      // The backend should return ALL expiries; we’ll locally center to ~50 strikes if needed.
      const url = `/api/options?symbol=${encodeURIComponent(
        s
      )}&allExpiries=1&limit=50`;
      const res = await fetch(url);
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      const json: OptionsChainResponse = JSON.parse(text);

      if (!json?.expiries?.length) throw new Error("No options data found.");
      setUPrice(typeof json.underlierPrice === "number" ? json.underlierPrice : null);

      // Ensure each expiry has calls + puts arrays and filter/center to ~50 strikes
      const normalized = json.expiries.map((slice) => {
        const calls = slice.options.filter((o) => o.type === "call");
        const puts = slice.options.filter((o) => o.type === "put");
        const strikesSet = new Set<number>([
          ...calls.map((c) => c.strike),
          ...puts.map((p) => p.strike),
        ]);
        const strikes = Array.from(strikesSet).sort((a, b) => a - b);

        // Pick ~50 strikes centered around underlier (or median if underlier missing)
        const center =
          typeof json.underlierPrice === "number"
            ? json.underlierPrice
            : strikes[Math.floor(strikes.length / 2)] ?? 0;

        const strikesByDistance = [...strikes].sort(
          (a, b) => Math.abs(a - center) - Math.abs(b - center)
        );
        const targetStrikes = new Set(strikesByDistance.slice(0, 50).sort((a, b) => a - b));

        const filteredCalls = calls.filter((c) => targetStrikes.has(c.strike));
        const filteredPuts = puts.filter((p) => targetStrikes.has(p.strike));

        return {
          expiry: slice.expiry,
          options: [...filteredCalls, ...filteredPuts],
        };
      });

      setExpiries(normalized);
    } catch (e: any) {
      setChainErr(e?.message || "Options fetch failed");
    } finally {
      setChainLoading(false);
    }
  };

  const activeExpiry = expiries[activeIdx];

  // Build table rows: one row per strike, calls | strike | puts
  const rows = useMemo(() => {
    if (!activeExpiry) return [];
    const callsByStrike = new Map<number, OptionSide>();
    const putsByStrike = new Map<number, OptionSide>();

    for (const o of activeExpiry.options) {
      if (o.type === "call") callsByStrike.set(o.strike, o);
      else putsByStrike.set(o.strike, o);
    }

    const strikes = Array.from(
      new Set<number>([
        ...Array.from(callsByStrike.keys()),
        ...Array.from(putsByStrike.keys()),
      ])
    ).sort((a, b) => a - b);

    return strikes.map((strike) => ({
      strike,
      call: callsByStrike.get(strike) || null,
      put: putsByStrike.get(strike) || null,
    }));
  }, [activeExpiry]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 1100, margin: "0 auto" }}>
      <h1>Stock Price Lookup</h1>

      {/* Symbol + actions */}
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

      {/* Price output */}
      {err && <p style={{ color: "crimson", marginTop: 8 }}>{err}</p>}
      {price !== null && !err && (
        <p style={{ marginTop: 12 }}>
          Current Price for <strong>{symbol}</strong>: {currency ? `${currency} ` : "$"}
          {price}
        </p>
      )}

      {/* Chain Errors */}
      {chainErr && <p style={{ color: "crimson", marginTop: 12 }}>{chainErr}</p>}

      {/* Expiry Tabs */}
      {expiries.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 8 }}>
            {expiries.map((ex, i) => (
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

          {/* Chain Table */}
          <div style={{ marginTop: 12, border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
                <thead style={{ background: "#f9fafb" }}>
                  <tr>
                    {/* Calls header */}
                    <th colSpan={5} style={thStyle}>Calls</th>
                    <th style={thStyle}>Strike</th>
                    {/* Puts header */}
                    <th colSpan={5} style={thStyle}>Puts</th>
                  </tr>
                  <tr>
                    {/* Calls cols */}
                    <th style={thStyle}>Last</th>
                    <th style={thStyle}>Bid</th>
                    <th style={thStyle}>Ask</th>
                    <th style={thStyle}>Delta</th>
                    <th style={thStyle}>IV %</th>
                    {/* Strike */}
                    <th style={thStyle}>-</th>
                    {/* Puts cols */}
                    <th style={thStyle}>IV %</th>
                    <th style={thStyle}>Delta</th>
                    <th style={thStyle}>Ask</th>
                    <th style={thStyle}>Bid</th>
                    <th style={thStyle}>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const c = r.call, p = r.put;
                    return (
                      <tr key={r.strike}>
                        {/* Calls */}
                        <td style={tdStyle}>{fmtNum(c?.last)}</td>
                        <td style={tdStyle}>{fmtNum(c?.bid)}</td>
                        <td style={tdStyle}>{fmtNum(c?.ask)}</td>
                        <td style={tdStyle}>{fmtDelta(c?.delta)}</td>
                        <td style={tdStyle}>{fmtPct(c?.iv)}</td>

                        {/* Strike */}
                        <td style={{ ...tdStyle, fontWeight: 700 }}>{r.strike}</td>

                        {/* Puts */}
                        <td style={tdStyle}>{fmtPct(p?.iv)}</td>
                        <td style={tdStyle}>{fmtDelta(p?.delta)}</td>
                        <td style={tdStyle}>{fmtNum(p?.ask)}</td>
                        <td style={tdStyle}>{fmtNum(p?.bid)}</td>
                        <td style={tdStyle}>{fmtNum(p?.last)}</td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={11} style={{ ...tdStyle, textAlign: "center", padding: 24 }}>
                        No data for this expiry.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 8, opacity: 0.6, fontSize: 12 }}>
            Showing up to 50 strikes centred near the underlier for each expiry.
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- Types ---------- */
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

/* ---------- Helpers / formatting ---------- */
function formatExpiry(s: string) {
  // Accept ISO or YYYY-MM-DD; display as, e.g., "19 Sep 2025"
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

/* ---------- Table cell styles ---------- */
const thStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "10px 8px",
  borderBottom: "1px solid #e5e7eb",
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  textAlign: "center",
  padding: "8px 6px",
  borderBottom: "1px solid #f1f5f9",
  whiteSpace: "nowrap",
};
