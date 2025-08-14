import { useState } from "react";

export default function App() {
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState<number | null>(null);
  const [chain, setChain] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const fetchData = async () => {
    setErr("");
    setPrice(null);
    setChain([]);
    const s = symbol.trim().toUpperCase();
    setSymbol(s);
    if (!s) return;

    try {
      setLoading(true);

      // 1) Stock quote
      const quoteRes = await fetch(`/api/quote?symbol=${encodeURIComponent(s)}`);
      if (!quoteRes.ok) throw new Error(await quoteRes.text());
      const quoteJson = await quoteRes.json();
      const q = quoteJson?.quoteResponse?.result?.[0];
      if (!q) throw new Error("No quote data");
      setPrice(q.regularMarketPrice ?? null);

      // 2) Options chain
      const optRes = await fetch(`/api/options?symbol=${encodeURIComponent(s)}`);
      if (!optRes.ok) throw new Error(await optRes.text());
      const optJson = await optRes.json();
      const optData = optJson?.optionChain?.result?.[0];
      const options = [
        ...(optData?.options?.[0]?.calls ?? []),
        ...(optData?.options?.[0]?.puts ?? []),
      ];
      setChain(options);
    } catch (e: any) {
      setErr(e?.message || "Fetch failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 960, margin: "0 auto" }}>
      <h1>opselect — Yahoo data via Vercel</h1>

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
        <p>
          Price for <strong>{symbol}</strong>: ${price}
        </p>
      )}

      {chain.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3>Options (calls & puts)</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Contract</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Type</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Strike</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Bid</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Ask</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>IV</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Δ</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Γ</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Θ</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>V</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>OI</th>
                <th style={{ borderBottom: "1px solid #ddd", padding: 6 }}>Expiry</th>
              </tr>
            </thead>
            <tbody>
              {chain.map((c, i) => (
                <tr key={i}>
                  <td style={{ padding: 6 }}>{c.contractSymbol}</td>
                  <td style={{ padding: 6 }}>{c.contractSymbol?.includes("C") ? "CALL" : "PUT"}</td>
                  <td style={{ padding: 6 }}>{c.strike}</td>
                  <td style={{ padding: 6 }}>{c.bid ?? "-"}</td>
                  <td style={{ padding: 6 }}>{c.ask ?? "-"}</td>
                  <td style={{ padding: 6 }}>{c.impliedVolatility ? (c.impliedVolatility * 100).toFixed(2) + "%" : "-"}</td>
                  <td style={{ padding: 6 }}>{c.delta ?? "-"}</td>
                  <td style={{ padding: 6 }}>{c.gamma ?? "-"}</td>
                  <td style={{ padding: 6 }}>{c.theta ?? "-"}</td>
                  <td style={{ padding: 6 }}>{c.vega ?? "-"}</td>
                  <td style={{ padding: 6 }}>{c.openInterest ?? "-"}</td>
                  <td style={{ padding: 6 }}>{optJson?.optionChain?.result?.[0]?.expirationDate ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
