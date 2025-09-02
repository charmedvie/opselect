// api/options.js
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "Missing symbol" });

  const token = process.env.FINNHUB_KEY || ""; // put your key in Vercel envs
  if (!token) return res.status(500).json({ error: "Missing FINNHUB_KEY" });

  const url = `https://finnhub.io/api/v1/stock/option-chain?symbol=${encodeURIComponent(symbol)}&token=${token}`;

  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text.slice(0, 1000));

    const j = JSON.parse(text);
    // Expected shape (matches your sample):
    // { code, exchange, lastTradeDate, lastTradePrice, data: [ { expirationDate, options: { CALL:[], PUT:[] } } ] }

    if (!j?.data || !Array.isArray(j.data) || j.data.length === 0) {
      // Rate-limit / entitlement messages often show as {error}, {note}, etc.
      return res.status(502).json({ error: j?.error || "No options data" });
    }

    const underlier = num(j.lastTradePrice);

    // Map expiries to our frontend format
    const expiries = j.data.map((slice) => {
      const exp = slice.expirationDate; // ISO-like "YYYY-MM-DD"
      const calls = Array.isArray(slice?.options?.CALL) ? slice.options.CALL : [];
      const puts  = Array.isArray(slice?.options?.PUT)  ? slice.options.PUT  : [];

      const mapped = [];
      for (const c of calls) {
        mapped.push({
          strike: num(c.strike),
          type: "call",
          last: num(c.lastPrice),
          bid: num(c.bid),
          ask: num(c.ask),
          delta: num(c.delta),
          iv: normIv(c.impliedVolatility), // show as %
        });
      }
      for (const p of puts) {
        mapped.push({
          strike: num(p.strike),
          type: "put",
          last: num(p.lastPrice),
          bid: num(p.bid),
          ask: num(p.ask),
          delta: num(p.delta),
          iv: normIv(p.impliedVolatility),
        });
      }

      // Keep ~50 strikes centred near underlying (fallback to median)
      const strikes = [...new Set(mapped.map((o) => o.strike))].sort((a, b) => a - b);
      const center = typeof underlier === "number" ? underlier : (strikes[Math.floor(strikes.length / 2)] ?? 0);
      const sortedByDist = [...strikes].sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
      const keep = new Set(sortedByDist.slice(0, 50));
      const filtered = mapped.filter((o) => keep.has(o.strike));

      return { expiry: exp, options: filtered };
    });

    // Sort expiries ascending
    expiries.sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)));

    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60");
    return res.status(200).json({
      symbol,
      underlierPrice: underlier,
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
// Provider sometimes returns IV as percent (e.g., 357.34) or fraction (e.g., 0.3573).
function normIv(iv) {
  if (!Number.isFinite(Number(iv))) return null;
  const v = Number(iv);
  // Heuristic: treat <= 3 as fraction, else already percent.
  return v <= 3 ? round(v * 100, 2) : round(v, 2);
}
function round(n, dp = 2) {
  const p = 10 ** dp;
  return Math.round(n * p) / p;
}
