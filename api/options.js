// api/options.js
export default async function handler(req, res) {
  // CORS (same as quote.js)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const symbol = String(req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'Missing symbol' });

  const wantAll = String(req.query.allExpiries || '1') === '1';
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50))); // frontend centers to ~50

  try {
    // 1) First call: get list of expiration dates + underlier
    const baseUrl = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}`;
    const base = await fetch(baseUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const baseText = await base.text();
    if (!base.ok) return res.status(base.status).send(baseText.slice(0, 1000));
    const baseJson = JSON.parse(baseText);
    const bRes = baseJson?.optionChain?.result?.[0];
    if (!bRes) return res.status(502).json({ error: 'No options data' });

    const expirationDates = Array.isArray(bRes.expirationDates) ? bRes.expirationDates : [];
    const underlier = bRes?.quote?.regularMarketPrice ?? null;

    // helper to fetch a specific expiry
    const fetchExpiry = async (epochSec) => {
      const url = `${baseUrl}?date=${epochSec}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
      const text = await r.text();
      if (!r.ok) throw new Error(`Upstream error ${r.status}: ${text.slice(0, 200)}`);
      const j = JSON.parse(text);
      const res0 = j?.optionChain?.result?.[0];
      const chain = res0?.options?.[0];
      if (!chain) return null;

      const calls = Array.isArray(chain.calls) ? chain.calls : [];
      const puts  = Array.isArray(chain.puts)  ? chain.puts  : [];
      const expiryMs = (chain?.expiration ?? epochSec) * 1000;
      const u = typeof res0?.quote?.regularMarketPrice === 'number' ? res0.quote.regularMarketPrice : underlier;

      // Map to our wire format & compute delta (if IV present)
      const mapped = [];
      for (const c of calls) {
        mapped.push({
          strike: num(c.strike),
          type: 'call',
          last: num(c.lastPrice),
          bid: num(c.bid),
          ask: num(c.ask),
          delta: calcDelta('call', u, num(c.strike), num(c.impliedVolatility), expiryMs),
          iv: ivPct(num(c.impliedVolatility)),
        });
      }
      for (const p of puts) {
        mapped.push({
          strike: num(p.strike),
          type: 'put',
          last: num(p.lastPrice),
          bid: num(p.bid),
          ask: num(p.ask),
          delta: calcDelta('put', u, num(p.strike), num(p.impliedVolatility), expiryMs),
          iv: ivPct(num(p.impliedVolatility)),
        });
      }

      // Optional: trim to ~limit strikes around underlier (UI also centres; harmless to send all)
      const strikes = Array.from(new Set(mapped.map(o => o.strike))).sort((a,b)=>a-b);
      const center = (typeof u === 'number' && u > 0) ? u : (strikes[Math.floor(strikes.length/2)] ?? 0);
      const sortedByDist = [...strikes].sort((a,b)=>Math.abs(a-center)-Math.abs(b-center));
      const keep = new Set(sortedByDist.slice(0, limit));
      const filtered = mapped.filter(o => keep.has(o.strike));

      return {
        expiry: new Date(expiryMs).toISOString().slice(0,10),
        options: filtered
      };
    };

    // 2) Build list of expiries to fetch
    let targets = expirationDates;
    if (!wantAll && expirationDates.length > 0) targets = [expirationDates[0]];

    // Always include the already-fetched current chain if present (base result has one options slice)
    const slices = [];
    if (bRes?.options?.[0]) {
      const chain0 = bRes.options[0];
      const expiry0ms = (chain0?.expiration ?? expirationDates[0]) * 1000;
      const u0 = typeof bRes?.quote?.regularMarketPrice === 'number' ? bRes.quote.regularMarketPrice : underlier;
      const calls0 = Array.isArray(chain0.calls) ? chain0.calls : [];
      const puts0  = Array.isArray(chain0.puts)  ? chain0.puts  : [];
      const mapped0 = [];
      for (const c of calls0) {
        mapped0.push({
          strike: num(c.strike),
          type: 'call',
          last: num(c.lastPrice),
          bid: num(c.bid),
          ask: num(c.ask),
          delta: calcDelta('call', u0, num(c.strike), num(c.impliedVolatility), expiry0ms),
          iv: ivPct(num(c.impliedVolatility)),
        });
      }
      for (const p of puts0) {
        mapped0.push({
          strike: num(p.strike),
          type: 'put',
          last: num(p.lastPrice),
          bid: num(p.bid),
          ask: num(p.ask),
          delta: calcDelta('put', u0, num(p.strike), num(p.impliedVolatility), expiry0ms),
          iv: ivPct(num(p.impliedVolatility)),
        });
      }

      // trim around underlier
      const strikes0 = Array.from(new Set(mapped0.map(o => o.strike))).sort((a,b)=>a-b);
      const center0 = (typeof u0 === 'number' && u0 > 0) ? u0 : (strikes0[Math.floor(strikes0.length/2)] ?? 0);
      const sortedByDist0 = [...strikes0].sort((a,b)=>Math.abs(a-center0)-Math.abs(b-center0));
      const keep0 = new Set(sortedByDist0.slice(0, limit));
      slices.push({
        expiry: new Date(expiry0ms).toISOString().slice(0,10),
        options: mapped0.filter(o => keep0.has(o.strike))
      });
    }

    // 3) Fetch remaining expiries (excluding the first which we already added)
    const rest = targets.filter(d => slices.length === 0 || d !== (bRes?.options?.[0]?.expiration ?? targets[0]));
    const chunks = await Promise.allSettled(rest.map(fetchExpiry));
    for (const c of chunks) {
      if (c.status === 'fulfilled' && c.value) slices.push(c.value);
    }

    // Sort by date asc
    slices.sort((a,b) => a.expiry.localeCompare(b.expiry));

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=60');
    return res.status(200).json({
      symbol,
      underlierPrice: typeof underlier === 'number' ? round(underlier,2) : null,
      expiries: slices
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'options proxy error' });
  }
}

/* ---------------- helpers ---------------- */
function num(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : null;
}
function ivPct(iv) {
  // Yahoo iv is fraction (e.g. 0.2431). Return percent with 2dp.
  return typeof iv === 'number' && Number.isFinite(iv) ? round(iv * 100, 2) : null;
}
function round(n, dp = 2) {
  const p = 10 ** dp;
  return Math.round(n * p) / p;
}

// Black-Scholes Delta (approx; r = 0.0 by default)
function calcDelta(type, S, K, ivFrac, expiryMs, r = 0.0) {
  if (![S, K, ivFrac].every(v => typeof v === 'number' && v > 0)) return null;
  const T = Math.max(0, (expiryMs - Date.now()) / (365 * 24 * 60 * 60 * 1000)); // years
  if (T === 0) return null;

  const sigma = ivFrac; // already a fraction
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const Nd1 = normCdf(d1);

  if (type === 'call') return round(Nd1, 4);
  // put delta = Nd1 - 1 (under BS)
  return round(Nd1 - 1, 4);
}

// Standard normal CDF via erf approximation
function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
// Abramowitz-Stegun approximation of erf
function erf(x) {
  // constants
  const a1 =  0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}
