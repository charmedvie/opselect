import { useState } from "react";

const POLYGON_API_KEY = "jRU3AOMqa5zoUiXUKIw_2JkLVCIZ9ST9";

type OptionSnap = {
  results?: Array<{
    details: {
      ticker: string;
      strike_price: number;
      expiration_date: string;
      contract_type: "call" | "put";
    };
    greeks?: {
      delta?: number; gamma?: number; theta?: number; vega?: number; implied_volatility?: number;
    };
    last_quote?: { ask?: number; bid?: number };
    open_interest?: { oi?: number };
  }>;
};

async function getJsonOrThrow(res: Response) {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

export default function App() {
  const [symbol, setSymbol] = useState<string>("");
  const [price, setPrice] = useState<number | null>(null);
  const [chain, setChain] = useState<OptionSnap["results"]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string>("");

  const fetchData = async () => {
    setErr("");
    setPrice(null);
    setChain([]);
    const s = symbol.trim().toUpperCase();
    setSymbol(s);
    if (!s) return;

    try {
      setLoading(true);

      // -------- PRICE (robust fallbacks) --------
      // 1) Last trade (simple, reliable on free tier)
      const lastTradeUrl = `https://api.polygon.io/v2/last/trade/${encodeURIComponent(s)}?apiKey=${POLYGON_API_KEY}`;
      let p: number | null = null;
      try {
        const lastTradeJson = await getJsonOrThrow(await fetch(lastTradeUrl));
        // shapes: { results: { p } } or { results: { price } }
        p = lastTradeJson?.results?.p ?? lastTradeJson?.results?.price ?? null;
      } catch (e) {
        // 2) Previous close as fallback (if last trade blocked)
        const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(s)}/prev?adjusted=true&apiKey=${POLYGON_API_KEY}`;
        const prevJson = await getJsonOrThrow(await fetch(prevUrl));
        p = prevJson?.results?.[0]?.c ?? null; // close
      }
      if (typeof p === "number") setPrice(p);

      // -------- OPTIONS CHAIN --------
      // For index options, use `const underlying = \`I:${s}\`;`
      const underlying = s;
      const chainUrl = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(underlying)}?limit=500&apiKey=${POLYGON_API_KEY}`;
      const chainJson: OptionSnap = await getJsonOrThrow(await fetch(chainUrl));
      setChain(chainJson.results ?? []);
    } catch (e: any) {
      setErr(e?.message || "Fetch failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 920, margin: "0 auto" }}>
      <h1>opselect — Polygon (delayed)</h1>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          placeholder="Symbol (e.g., AAPL)"
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          style={{ textTransform: "uppercase", flex: 1, padding: 8 }}
        />
        <button onClick={fetchData} disabled={loading || !symbol.trim()}>
          {loading ? "Loading…" : "Fetch"}
        </button>
      </div>

      {err && <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{err}</pre>}

      {price !== null && (
        <p style={{ marginTop: 8 }}>
          Price (delayed) for <strong>{symbol}</strong>: ${price}
        </p>
      )}

      {chain && chain.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3>Options (first {Math.min(chain.length, 30)} shown)</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Contract</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Type</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Strike</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Bid</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Ask</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>IV</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Δ</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Γ</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>Θ</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>V</th>
                <th style={{ textAlign: "right", borderBottom: "1px solid #ddd", padding: 6 }}>OI</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Expiry</th>
              </tr>
            </thead>
            <tbody>
              {chain.slice(0, 30).map((c, i) => (
                <tr key={i}>
                  <td style={{ padding: 6 }}>{c.details.ticker}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.details.contract_type.toUpperCase()}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.details.strike_price}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.last_quote?.bid ?? "-"}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.last_quote?.ask ?? "-"}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>
                    {c.greeks?.implied_volatility !== undefined
                      ? (c.greeks!.implied_volatility! * 100).toFixed(2) + "%"
                      : "-"}
                  </td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.greeks?.delta?.toFixed(3) ?? "-"}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.greeks?.gamma?.toFixed(3) ?? "-"}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.greeks?.theta?.toFixed(3) ?? "-"}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.greeks?.vega?.toFixed(3) ?? "-"}</td>
                  <td style={{ textAlign: "right", padding: 6 }}>{c.open_interest?.oi ?? "-"}</td>
                  <td style={{ padding: 6 }}>{c.details.expiration_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ opacity: 0.7, marginTop: 8 }}>Showing a subset to keep UI snappy.</p>
        </div>
      )}
    </div>
  );
}
