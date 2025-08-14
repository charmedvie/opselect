import { useState } from "react";

export default function App() {
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const fetchPrice = async () => {
    setErr("");
    setPrice(null);
    const s = symbol.trim().toUpperCase();
    setSymbol(s);
    if (!s) return;

    try {
      setLoading(true);
      const res = await fetch(`/api/quote?symbol=${encodeURIComponent(s)}`);
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      const q = json?.quoteResponse?.result?.[0];
      if (!q) throw new Error("No quote data");
      setPrice(q.regularMarketPrice ?? null);
    } catch (e: any) {
      setErr(e?.message || "Fetch failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Stock Price Lookup</h1>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          placeholder="Enter ticker (e.g., AAPL)"
          style={{ textTransform: "uppercase", padding: 8 }}
          onKeyDown={(e) => e.key === "Enter" && fetchPrice()}
        />
        <button onClick={fetchPrice} disabled={loading || !symbol.trim()}>
          {loading ? "Loading…" : "Get Price"}
        </button>
      </div>

      {err && <p style={{ color: "crimson" }}>{err}</p>}
      {price !== null && !err && (
        <p style={{ marginTop: 12 }}>
          Current Price for <strong>{symbol}</strong>: ${price}
        </p>
      )}
    </div>
  );
}
