import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const symbol = (req.query.symbol as string)?.trim();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; opselect/1.0)' },
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(r.status).send(txt);
    }
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
    return res.status(200).json(data);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'proxy error' });
  }
}
