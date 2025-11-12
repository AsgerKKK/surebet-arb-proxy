import express from 'express';
import fetch from 'node-fetch';

const app  = express();
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.OPTIC_API_KEY;

// VIGTIGT: korrekte OpticOdds IDs
const BOOKS = ['mr_green','888sport','bwin','unibet','betsson','betano','leovegas'];

// ---------- helpers ----------
const chunk = (arr, n) => { const out=[]; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };
const firstNum = (...v) => { for (const x of v){ const n=parseFloat(x); if (isFinite(n)) return n; } return NaN; };

const withTimeout = async (fn, ms) => {
  const ac = new AbortController(); const t=setTimeout(()=>ac.abort(), ms);
  try { return await fn(ac.signal); } finally { clearTimeout(t); }
};

const oo = async (path, params={}, signal) => {
  const sp = new URLSearchParams();
  for (const [k,v] of Object.entries(params)){
    if (Array.isArray(v)) v.forEach(x=>sp.append(k,x));
    else if (v!=null) sp.append(k,v);
  }
  const url = `https://api.opticodds.com/api/v3/${path}?${sp.toString()}`;
  const r = await fetch(url, { headers: { 'X-Api-Key': API_KEY }, signal });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
};

const normalizeLine = o => [o.selection_line ?? '', o.player_id ? String(o.player_id) : ''].filter(Boolean).join(':');
const prettyMarket  = (x) => {
  const id = String(x||'').toLowerCase();
  if (id.includes('moneyline')) return 'Moneyline';
  if (id.includes('spread') || id.includes('handicap')) return 'Point Spread';
  if (id.includes('total')) return 'Totals';
  if (id.includes('1x2'))   return '1X2';
  return x || 'Market';
};
const groupKey = (fix, odd) => [fix.id, String(odd.market||'').toLowerCase(), normalizeLine(odd)].join('::');

// ---------- simple checks ----------
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.get('/',       (_req, res) => res.status(200).send('surebet-proxy up'));

// ---------- DEBUG: quick fixture peek (soccer by default) ----------
app.get('/debug/fixtures', async (req,res) => {
  try {
    const sport = String(req.query.sport||'soccer');
    const leagues = (await oo('leagues', { sport })).data || [];
    const leagueId = leagues[0]?.id;
    if (!leagueId) return res.json({ sport, leagues: leagues.length, fixtures: [] });
    const fx = await oo('fixtures', { league: leagueId, has_odds:true, limit:50, page:1 });
    res.json({ sport, league: leagueId, fixtures: (fx.data||[]).slice(0,10) });
  } catch(e){ res.status(500).send(e.message); }
});

// ---------- DEBUG: raw odds for one fixture ----------
app.get('/debug/odds', async (req,res) => {
  try {
    const fixture_id = req.query.fixture_id;
    if (!fixture_id) return res.status(400).send('fixture_id required');
    const books = (req.query.books || BOOKS.join(',')).split(',').map(s=>s.trim());
    const js = await oo('fixtures/odds', {
      fixture_id: [fixture_id],
      sportsbook: books,
      odds_format:'DECIMAL',
      include_deep_link:true
    });
    res.json(js);
  } catch(e){ res.status(500).send(e.message); }
});

// ---------- main ----------
app.get('/arb', async (req, res) => {
  const limit        = Math.min(parseInt(req.query.limit || '150', 10), 500);
  const minEdge      = parseFloat(req.query.min_edge || '0');
  const onlySport    = (req.query.sport || '').toLowerCase();   // fx soccer
  const MAX_LEAGUES  = Math.min(parseInt(req.query.max_leagues  || '8', 10), 50);
  const MAX_FIXTURES = Math.min(parseInt(req.query.max_fixtures || '50', 10), 200);
  const debugMode    = String(req.query.debug||'').toLowerCase()==='1';

  try {
    // 1) sports
    const sportsJs = await withTimeout(sig => oo('sports/active', {}, sig), 12000);
    let sports = (sportsJs.data || []);
    if (onlySport) sports = sports.filter(s => String(s.id||'').toLowerCase().includes(onlySport));
    if (!sports.length) return res.json([]);

    // 2) leagues (capped)
    const leagueIds = [];
    for (const s of sports){
      const leaguesJs = await withTimeout(sig => oo('leagues', { sport: s.id }, sig), 12000);
      leagueIds.push(...(leaguesJs.data || []).slice(0, MAX_LEAGUES).map(l => l.id));
    }
    if (!leagueIds.length) return res.json([]);

    // 3) fixtures (has_odds), capped
    const fixtures = [];
    for (const L of leagueIds){
      const fx = await withTimeout(sig => oo('fixtures', { league: L, has_odds: true, limit: 50, page: 1 }, sig), 15000);
      fixtures.push(...(fx.data || []));
      if (fixtures.length >= MAX_FIXTURES) break;
    }
    const fixtureIds = fixtures.slice(0, MAX_FIXTURES).map(f => f.id);
    if (!fixtureIds.length) return res.json([]);

    // 4) odds batches (5 fixtures × 5 books)
    const groups = new Map();
    const fixBatches  = chunk(fixtureIds, 5);
    const bookBatches = chunk(BOOKS, 5);

    for (const fixBatch of fixBatches){
      for (const bookBatch of bookBatches){
        const js = await withTimeout(sig => oo('fixtures/odds', {
          fixture_id: fixBatch,
          sportsbook: bookBatch,
          odds_format:'DECIMAL',
          include_deep_link:true
        }, sig), 15000);

        for (const row of (js.data || [])){
          const meta = {
            event:  `${row.away_team_display || 'Away'} @ ${row.home_team_display || 'Home'}`,
            kickoff: row.start_date || ''
          };
          for (const o of (row.odds || [])){
            const k = groupKey(row, o);
            if (!groups.has(k)) groups.set(k, { meta: { ...meta, market: prettyMarket(o.market) }, byBook: {} });
            const b = (o.sportsbook || '').toLowerCase();
            const one = { name:o.name, price:firstNum(o.price), href:o.deep_link?.desktop || '' };
            if (!isFinite(one.price)) continue;
            if (!groups.get(k).byBook[b]) groups.get(k).byBook[b] = [];
            groups.get(k).byBook[b].push(one);
          }
        }
      }
    }

    // DEBUG VIEW: se hvilke books vi faktisk har pr. gruppe
    if (debugMode){
      const summary = [];
      for (const [k,g] of groups.entries()){
        const books = Object.keys(g.byBook);
        summary.push({
          key: k, event: g.meta.event, market: g.meta.market, kickoff: g.meta.kickoff,
          books, counts: Object.fromEntries(books.map(b=>[b, g.byBook[b].length]))
        });
      }
      summary.sort((a,b)=>b.books.length - a.books.length);
      return res.json({ groups: summary.slice(0, 30) });
    }

    // 5) find arbs
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

    // 2-way
    for (let i=0;i<names.length;i++){
      for (let j=0;j<names.length;j++){
        if (i===j) continue;
        const A = byBook[names[i]].find(x=>/over|home|^1$|^team1$|moneyline/i.test(x.name));
        const B = byBook[names[j]].find(x=>/under|away|^2$|^team2$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
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
          const H = byBook[names[i]].find(x=>/home|^1$|^team1$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
          const D = byBook[names[j]].find(x=>/draw|^x$/i.test(x.name));
          const A = byBook[names[k]].find(x=>/away|^2$|^team2$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
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
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Surebet arb server on ${PORT}`);
});
