export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const symbol = (req.query.symbol || '').toString().trim();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; opselect/1.0)',
        'Accept': 'application/json'
      }
    });
    const text = await r.text();
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
    return res.status(r.ok ? 200 : r.status).send(text);
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'proxy error' });
  }
}
