import express from 'express';
import fetch from 'node-fetch';

const app  = express();
const PORT = process.env.PORT || 10000;              // Render sætter PORT (typisk 10000)
const API_KEY = process.env.OPTIC_API_KEY;

const BOOKS = ['mrgreen','888sport','bwin','unibet','betsson','betano','leovegas'];

// ---------- helpers ----------
const chunk = (arr, n) => { const out=[]; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };
const firstNum = (...v) => { for (const x of v){ const n=parseFloat(x); if (isFinite(n)) return n; } return NaN; };

const withTimeout = async (fn, ms, label='req') => {
  const ac = new AbortController();
  const t  = setTimeout(()=>ac.abort(), ms);
  try { return await fn(ac.signal); }
  finally { clearTimeout(t); }
};

const oo = async (path, params={}, signal) => {
  const sp  = new URLSearchParams();
  // Render / node-fetch accepterer repeat params ved at kalde sp.append for arrays
  for (const [k,v] of Object.entries(params)){
    if (Array.isArray(v)) v.forEach(x=>sp.append(k, x));
    else if (v!=null)     sp.append(k, v);
  }
  const url = `https://api.opticodds.com/api/v3/${path}?${sp.toString()}`;
  const r = await fetch(url, { headers: { 'X-Api-Key': API_KEY }, signal });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
};

const prettyMarket = (x) => {
  const id = String(x||'').toLowerCase();
  if (id.includes('moneyline')) return 'Moneyline';
  if (id.includes('spread') || id.includes('handicap')) return 'Point Spread';
  if (id.includes('total')  || id.includes('overunder')) return 'Totals';
  if (id.includes('1x2'))    return '1X2';
  return x || 'Market';
};
const normalizeLine = o => [o.selection_line ?? '', o.player_id ? String(o.player_id) : ''].filter(Boolean).join(':');
const groupKey = (fix, odd) => [fix.id, String(odd.market||'').toLowerCase(), normalizeLine(odd)].join('::');

// ---------- simple checks ----------
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/',       (_req, res) => res.status(200).send('surebet-proxy up'));

// ---------- main ----------
app.get('/arb', async (req, res) => {
  const limit        = Math.min(parseInt(req.query.limit || '150', 10), 500);
  const minEdge      = parseFloat(req.query.min_edge || '0');
  const onlySport    = (req.query.sport || '').toLowerCase();   // fx soccer, basketball
  const MAX_LEAGUES  = Math.min(parseInt(req.query.max_leagues  || '8', 10), 50);
  const MAX_FIXTURES = Math.min(parseInt(req.query.max_fixtures || '50', 10), 200);

  try {
    // 1) aktive sports
    const sportsJs = await withTimeout(sig => oo('sports/active', {}, sig), 12000, 'sports');
    let sports = (sportsJs.data || []);
    if (onlySport) sports = sports.filter(s => String(s.id||'').toLowerCase().includes(onlySport));
    if (!sports.length) return res.json([]);

    // 2) leagues (cap pr. sport)
    const leagueIds = [];
    for (const s of sports){
      const leaguesJs = await withTimeout(sig => oo('leagues', { sport: s.id }, sig), 12000, 'leagues');
      leagueIds.push(...(leaguesJs.data || []).slice(0, MAX_LEAGUES).map(l => l.id));
    }
    if (!leagueIds.length) return res.json([]);

    // 3) fixtures (has_odds=true), cap + 1. side for hastighed
    const fixtures = [];
    for (const L of leagueIds){
      const fx = await withTimeout(
        sig => oo('fixtures', { league: L, has_odds: true, is_live: false, limit: 50, page: 1 }, sig),
        15000, 'fixtures'
      );
      fixtures.push(...(fx.data || []));
      if (fixtures.length >= MAX_FIXTURES) break;
    }
    const fixtureIds = fixtures.slice(0, MAX_FIXTURES).map(f => f.id);
    if (!fixtureIds.length) return res.json([]);

    // 4) odds i batches (maks 5 fixtures × 5 books pr. request)
    const groups = new Map();
    const fixBatches  = chunk(fixtureIds, 5);
    const bookBatches = chunk(BOOKS, 5);

    for (const fixBatch of fixBatches){
      for (const bookBatch of bookBatches){
        const js = await withTimeout(sig => oo('fixtures/odds', {
          fixture_id: fixBatch,                 // gentagne params ok
          sportsbook: bookBatch,               // gentagne params ok
          odds_format: 'DECIMAL',
          include_deep_link: true
        }, sig), 15000, 'fixtures/odds');

        for (const row of (js.data || [])){
          const meta = {
            event:  `${row.away_team_display || 'Away'} @ ${row.home_team_display || 'Home'}`,
            kickoff: row.start_date || ''
          };
          for (const o of (row.odds || [])){
            const k = groupKey(row, o);
            if (!groups.has(k)) groups.set(k, { meta: { ...meta, market: prettyMarket(o.market) }, byBook: {} });
            const b   = (o.sportsbook || '').toLowerCase();
            const one = { name: o.name, price: firstNum(o.price), href: o.deep_link?.desktop || '' };
            if (!isFinite(one.price)) continue;
            if (!groups.get(k).byBook[b]) groups.get(k).byBook[b] = [];
            groups.get(k).byBook[b].push(one);
          }
        }
      }
    }

    // 5) find arbs (2-vejs + 3-vejs)
    const rows = findArbs(groups)
      .filter(r => (r.edge || 0) >= minEdge)
      .sort((a,b) => (b.edge || 0) - (a.edge || 0))
      .slice(0, limit);

    res.set('cache-control', 'no-store');
    res.json(rows);
  } catch (e) {
    res.status(500).send(e.message || 'error');
  }
});

function findArbs(groups){
  const out = [];
  for (const g of groups.values()){
    const { meta, byBook } = g;
    const names = Object.keys(byBook);

    // 2-way (Over/Home vs Under/Away)
    for (let i=0;i<names.length;i++){
      for (let j=0;j<names.length;j++){
        if (i===j) continue;
        const A = byBook[names[i]].find(x => /over|home|^1$|moneyline/i.test(x.name));
        const B = byBook[names[j]].find(x => /under|away|^2$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
        if (A && B){
          const s = 1/A.price + 1/B.price;
          if (s < 1){
            out.push({
              event: meta.event, detail: meta.kickoff, market: meta.market, edge: (1 - s) * 100,
              sides: [
                { book:names[i], line:A.name, odds:A.price, href:A.href },
                { book:names[j], line:B.name, odds:B.price, href:B.href }
              ]
            });
          }
        }
      }
    }

    // 3-way (1 X 2)
    for (let i=0;i<names.length;i++){
      for (let j=0;j<names.length;j++){
        for (let k=0;k<names.length;k++){
          if (i===j || i===k || j===k) continue;
          const H = byBook[names[i]].find(x => /home|^1$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
          const D = byBook[names[j]].find(x => /draw|^x$/i.test(x.name));
          const A = byBook[names[k]].find(x => /away|^2$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
          if (H && D && A){
            const s = 1/H.price + 1/D.price + 1/A.price;
            if (s < 1){
              out.push({
                event: meta.event, detail: meta.kickoff, market: meta.market, edge: (1 - s) * 100,
                sides: [
                  { book:names[i], line:H.name, odds:H.price, href:H.href },
                  { book:names[j], line:D.name, odds:D.price, href:D.href },
                  { book:names[k], line:A.name, odds:A.price, href:A.href }
                ]
              });
            }
          }
        }
      }
    }
  }
  return out;
}

// ---------- start ----------
app.listen(PORT, '0.0.0.0', ()=>console.log(`Surebet arb server on ${PORT}`));
  console.log(`Surebet arb server on ${PORT}`);