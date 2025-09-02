// api/options.js
export default async function handler(req, res) {
  // CORS headers (same as quote.js)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "Missing symbol" });

  const apiKey = "jRU3AOMqa5zoUiXUKIw_2JkLVCIZ9ST9"; // Polygon key
  const url = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(
    symbol
  )}?apiKey=${apiKey}`;

  try {
    const r = await fetch(url);
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text.slice(0, 500));

    const j = JSON.parse(text);

    if (!j || !Array.isArray(j.results)) {
      return res.status(502).json({ error: j?.error || "No options data" });
    }

    const uPrice = j.underlying_asset?.price ?? null;
    const byExpiry = new Map();

    for (const opt of j.results) {
      const exp = opt.details.expiration_date;
      if (!byExpiry.has(exp)) byExpiry.set(exp, []);
      byExpiry.get(exp).push({
        strike: opt.details.strike_price,
        type: opt.details.contract_type.toLowerCase(), // "call" | "put"
        last: num(opt.last_quote?.p),
        bid: num(opt.last_quote?.b),
        ask: num(opt.last_quote?.a),
        delta: num(opt.greeks?.delta),
        iv: num(opt.greeks?.iv ? opt.greeks.iv * 100 : null), // percent
      });
    }

    // Convert map to array, trim ~50 strikes per expiry
    const expiries = [];
    for (const [exp, arr] of byExpiry.entries()) {
      const strikes = [...new Set(arr.map((o) => o.strike))].sort((a, b) => a - b);
      const center =
        typeof uPrice === "number"
          ? uPrice
          : strikes[Math.floor(strikes.length / 2)] ?? 0;
      const sortedByDist = [...strikes].sort(
        (a, b) => Math.abs(a - center) - Math.abs(b - center)
      );
      const keep = new Set(sortedByDist.slice(0, 50));
      expiries.push({
        expiry: exp,
        options: arr.filter((o) => keep.has(o.strike)),
      });
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
