export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const symbol = (req.query.symbol || '').toString().trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  try {
    // --- Try v7/quote first ---
    const q1 = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } }
    );
    const t1 = await q1.text();

    // If allowed, parse it
    if (q1.ok) {
      try {
        const j = JSON.parse(t1);
        const r = j?.quoteResponse?.result?.[0];
        if (r && typeof r.regularMarketPrice === 'number') {
          res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
          return res.status(200).json({
            symbol,
            price: r.regularMarketPrice,
            currency: r.currency || r.financialCurrency || null,
            source: 'v7.quote',
          });
        }
      } catch {
        /* fall through to chart */
      }
    }

    // --- Fallback: v8/chart (very reliable) ---
    const q2 = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`,
      { headers: { 'User-Agent': 'Mozilla/5.0', Ac
