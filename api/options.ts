import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const symbol = (req.query.symbol as string)?.trim();
  const date = (req.query.date as string | undefined)?.trim();

  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  try {
    const base = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
    const url = date ? `${base}?date=${encodeURIComponent(date)}` : base;

    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; opselect/1.0)' },
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).send(text.slice(0, 500));
    }

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
    return res.status(200).send(text);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'proxy error' });
  }
}
