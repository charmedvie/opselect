// api/options.js
export default async function handler(req, res) {
  // --- CORS headers (same as quote.js) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "Missing symbol" });

  const apiKey = "GYGVXQFIDN0ROUE9"; // your Alpha Vantage key
  const url = `https://www.alphavantage.co/query?function=OPTION_CHAIN&symbol=${encodeURIComponent(
    symbol
  )}&apikey=${apiKey}`;

  try {
    const r = await fetch(url);
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text.slice(0, 500));

    const j = JSON.parse(text);

    // Error case (Alpha Vantage throttling or bad symbol)
    if (!j || !j.optionChain) {
      return res.status(502).json({ error: j?.Note || "No options data" });
    }

    const uPrice = j.optionChain.underlying_price ?? null;
    const expiries = [];

    // Each expiry has { calls:[], puts:[] }
    for (const exp of j.optionChain.expiration_dates || []) {
      const chain = j.optionChain.expirations[exp];
      if (!chain) continue;

      const calls = Array.isArray(chain.calls) ? chain.calls : [];
      const puts = Array.isArray(chain.puts) ? chain.puts : [];

      const mapped = [];

      for (const c of calls) {
        mapped.push({
          strike: num(c.strikePrice),
          type: "call",
          last: num(c.lastPrice),
          bid: num(c.bid),
          ask: num(c.ask),
          delta: num(c.delta),
          iv: num(c.impliedVolatility ? c.impliedVolatility * 100 : null), // convert to %
        });
      }

      for (const p of puts) {
        mapped.push({
          strike: num(p.strikePrice),
          type: "put",
          last: num(p.lastPrice),
          bid: num(p.bid),
          ask: num(p.ask),
          delta: num(p.delta),
          iv: num(p.impliedVolatility ? p.impliedVolatility * 100 : null),
        });
      }

      // Center to ~50 strikes around underlying
      const strikes = [...new Set(mapped.map((o) => o.strike))].sort((a, b) => a - b);
      const center =
        typeof uPrice === "number"
          ? uPrice
          : strikes[Math.floor(strikes.length / 2)] ?? 0;
      const sortedByDist = [...strikes].sort(
        (a, b) => Math.abs(a - center) - Math.abs(b - center)
      );
      const keep = new Set(sortedByDist.slice(0, 50));
      const filtered = mapped.filter((o) => keep.has(o.strike));

      expiries.push({ expiry: exp, options: filtered });
    }

    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60");
    return res.status(200).json({
      symbol,
      underlierPrice: uPrice,
      expiries,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "options proxy error" });
  }
}

/* helpers */
function num(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}
