module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const symbol = (req.query.symbol || '').toString().trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    const text = await r.text();
    if (!r.ok) return res.status(r.status).send(text.slice(0, 500));

    const j = JSON.parse(text);
    const result = j?.chart?.result?.[0];
    const price =
      result?.meta?.regularMarketPrice ??
      (Array.isArray(result?.indicators?.quote?.[0]?.close)
        ? result.indicators.quote[0].close.filter((n) => typeof n === 'number').pop() ?? null
        : null);

    if (typeof price !== 'number') return res.status(502).json({ error: 'Price not available' });

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
    return res.status(200).json({
      symbol,
      price,
      currency: result?.meta?.currency || null,
      source: 'v8.chart'
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'proxy error' });
  }
};
