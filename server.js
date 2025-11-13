// server.js
import express from 'express';
import fetch from 'node-fetch';

const app  = express();
const PORT = process.env.PORT || 10000;
const API_KEY = process.env.OPTIC_API_KEY;

// Dine 7 bøger (OpticOdds IDs – bemærk mr_green):
const BOOKS = ['mr_green','888sport','bwin','unibet','betsson','betano','leovegas'];

/* ----------------------- helpers ----------------------- */
const chunk = (arr, n) => { const out=[]; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };
const firstNum = (...v) => { for (const x of v){ const n = parseFloat(x); if (isFinite(n)) return n; } return NaN; };

const withTimeout = async (fn, ms) => {
  const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), ms);
  try { return await fn(ac.signal); } finally { clearTimeout(t); }
};

const oo = async (path, params={}, signal) => {
  const sp = new URLSearchParams();
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
  if (id.includes('total')) return 'Totals';
  if (id.includes('1x2'))   return '1X2';
  return x || 'Market';
};
const normalizeLine = o => [o.selection_line ?? '', o.player_id ? String(o.player_id) : ''].filter(Boolean).join(':');
const groupKey = (fix, odd) => [fix.id, String(odd.market||'').toLowerCase(), normalizeLine(odd)].join('::');

/* -------- fixtures direkte pr. sport (med odds) --------
   - is_live: 0/1
   - max: cap på hvor mange fixtures du vil returnere
-------------------------------------------------------- */
async function listFixturesWithOddsBySport(sport, is_live = false, max = 120) {
  const out = [];
  let page = 1;
  while (out.length < max) {
    const fx = await oo('fixtures', {
      sport,
      has_odds: true,
      is_live: !!is_live,
      limit: 50,
      page
    });
    const rows = fx.data || [];
    out.push(...rows);
    if (!rows.length || (fx.total_pages && page >= fx.total_pages)) break;
    page++;
  }
  return out.slice(0, max);
}

/* -------- fixtures per league (fallback / explicit) ---- */
async function listFixturesWithOddsByLeagues(leagueIds, is_live = false, max = 120) {
  const out = [];
  for (const L of leagueIds) {
    if (out.length >= max) break;
    let page = 1;
    while (out.length < max) {
      const fx = await oo('fixtures', {
        league: L,
        has_odds: true,
        is_live: !!is_live,
        limit: 50,
        page
      });
      const rows = fx.data || [];
      out.push(...rows);
      if (!rows.length || (fx.total_pages && page >= fx.total_pages)) break;
      page++;
    }
  }
  return out.slice(0, max);
}

/* ----------------------- health/debug ----------------------- */
app.get('/',       (_req, res) => res.status(200).send('surebet-proxy up'));
app.get('/healthz',(_req, res) => res.status(200).send('ok'));

app.get('/debug/fixtures', async (req,res) => {
  try {
    const sport = String(req.query.sport || 'soccer');
    const leagues = (await oo('leagues', { sport })).data || [];
    const leagueId = leagues[0]?.id;
    if (!leagueId) return res.json({ sport, leagues: leagues.length, fixtures: [] });
    // NB: dette viser side 1 i en vilkårlig liga (kan godt være uden odds)
    const fx = await oo('fixtures', { league: leagueId, has_odds:true, limit:50, page:1 });
    res.json({ sport, league: leagueId, fixtures: (fx.data||[]).slice(0,10) });
  } catch(e){ res.status(500).json({ error: String(e.message||e) }); }
});

app.get('/debug/fixtures_by_sport', async (req,res) => {
  try {
    const sport = String(req.query.sport || 'soccer');
    const is_live = String(req.query.is_live||'0') === '1';
    const rows  = await listFixturesWithOddsBySport(sport, is_live, 60);
    res.json({ sport, is_live, count: rows.length, sample: rows.slice(0, 10) });
  } catch(e){ res.status(500).json({ error: String(e.message||e) }); }
});

// Test odds for 1 fixture – prøver bøger en ad gangen og returnerer JSON altid
app.get('/debug/odds', async (req,res) => {
  try {
    const fixture_id = req.query.fixture_id;
    if (!fixture_id) return res.status(400).json({ error: 'fixture_id required' });

    const books = (req.query.books || BOOKS.join(','))
      .split(',').map(s=>s.trim()).filter(Boolean);

    const results = [];
    for (const b of books) {
      try {
        const js = await oo('fixtures/odds', {
          fixture_id: [fixture_id],
          sportsbook: [b],
          odds_format: 'DECIMAL',
          include_deep_link: true
        });
        results.push({
          book: b,
          status: 'ok',
          count: js.data?.[0]?.odds?.length || 0,
          sample: js.data?.[0]?.odds?.slice(0,3) || []
        });
      } catch (e) {
        results.push({ book: b, status: 'error', error: String(e.message || e) });
      }
    }
    res.json({ fixture_id, results });
  } catch(e){
    res.status(500).json({ error: String(e.message||e) });
  }
});

/* ----------------------- main: /arb -----------------------
   Parametre:
   - sports=... (comma)    fx soccer,basketball,hockey
   - is_live=0|1           default 0
   - leagues=... (comma)   valgfrit: hvis sat, hentes fixtures fra disse leagues først
   - max_leagues=8         cap
   - max_fixtures=300      cap
   - limit=150             antal arbs retur
   - min_edge=0
   - debug=1               returnerer groups-overblik i stedet for arbs
----------------------------------------------------------- */
app.get('/arb', async (req, res) => {
  const limit        = Math.min(parseInt(req.query.limit || '150', 10), 500);
  const minEdge      = parseFloat(req.query.min_edge || '0');
  const sportsParam  = String(req.query.sports || req.query.sport || 'soccer,basketball,tennis,hockey,handball');
  const sportsList   = sportsParam.split(',').map(s=>s.trim()).filter(Boolean);
  const is_live      = String(req.query.is_live||'0') === '1';
  const MAX_LEAGUES  = Math.min(parseInt(req.query.max_leagues  || '8', 10), 50);
  const MAX_FIXTURES = Math.min(parseInt(req.query.max_fixtures || '300', 10), 1000);
  const debugMode    = String(req.query.debug||'').toLowerCase()==='1';

  // specifikke leagues? (kommasepareret)
  const leaguesParam = String(req.query.leagues || '').trim();
  const leagueIds    = leaguesParam ? leaguesParam.split(',').map(s=>s.trim()).filter(Boolean) : [];

  try {
    // 1) saml fixtures (prioritér leagues hvis angivet)
    let fixtures = [];
    if (leagueIds.length){
      fixtures = await withTimeout(sig => listFixturesWithOddsByLeagues(leagueIds, is_live, MAX_FIXTURES), 25000);
    }
    if (!fixtures.length){
      for (const s of sportsList){
        const part = await withTimeout(sig => listFixturesWithOddsBySport(s, is_live, MAX_FIXTURES), 20000);
        fixtures.push(...part);
        if (fixtures.length >= MAX_FIXTURES) break;
      }
    }
    const fixtureIds = fixtures.slice(0, MAX_FIXTURES).map(f => f.id);
    if (!fixtureIds.length) return res.json([]);  // intet at arbejde med

    // 2) hent odds i batches (5 fixtures × 5 books)
    const groups = new Map();
    const fixBatches  = chunk(fixtureIds, 5);
    const bookBatches = chunk(BOOKS, 5);

    for (const fixBatch of fixBatches){
      for (const bookBatch of bookBatches){
        const js = await withTimeout(sig => oo('fixtures/odds', {
          fixture_id: fixBatch,
          sportsbook: bookBatch,
          odds_format: 'DECIMAL',
          include_deep_link: true
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

    // 3) debug-overblik i stedet for arbs
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
      return res.json({ groups: summary.slice(0, 50) });
    }

    // 4) find arbs (2-vejs + 3-vejs)
    const rows = findArbs(groups)
      .filter(r => (r.edge || 0) >= minEdge)
      .sort((a,b) => (b.edge || 0) - (a.edge || 0))
      .slice(0, limit);

    res.set('cache-control', 'no-store');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

function findArbs(groups){
  const out = [];
  for (const g of groups.values()){
    const { meta, byBook } = g;
    const names = Object.keys(byBook);

    // 2-vejs (Over/Home vs Under/Away)
    for (let i=0;i<names.length;i++){
      for (let j=0;j<names.length;j++){
        if (i===j) continue;
        const A = byBook[names[i]].find(x => /over|home|^1$|^team1$|moneyline/i.test(x.name));
        const B = byBook[names[j]].find(x => /under|away|^2$|^team2$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
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

    // 3-vejs (1 X 2)
    for (let i=0;i<names.length;i++){
      for (let j=0;j<names.length;j++){
        for (let k=0;k<names.length;k++){
          if (i===j || i===k || j===k) continue;
          const H = byBook[names[i]].find(x => /home|^1$|^team1$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
          const D = byBook[names[j]].find(x => /draw|^x$/i.test(x.name));
          const A = byBook[names[k]].find(x => /away|^2$|^team2$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
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

/* ----------------------- start ----------------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Surebet arb server on ${PORT}`);
});
