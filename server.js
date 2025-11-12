import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPTIC_API_KEY;

// Kun disse bøger
const BOOKS = ['mrgreen','888sport','bwin','unibet','betsson','betano','leovegas'];

// === små helpers ===
const oo = async (path, params = {}) => {
  const sp = new URLSearchParams(params);
  const url = `https://api.opticodds.com/api/v3/${path}?${sp.toString()}`;
  const r = await fetch(url, { headers: { 'X-Api-Key': API_KEY } });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
};
const chunk = (arr, n) => {
  const out=[]; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out;
};

// === normalize / arb ===
function firstNum(...v){ for (const x of v){ const n=parseFloat(x); if (isFinite(n)) return n; } return NaN; }
function normalizeLine(oddsObj){
  // brug selection_line + player_id til at skelne props/linjer
  const ln = oddsObj.selection_line ?? '';
  const player = oddsObj.player_id ? String(oddsObj.player_id) : '';
  return [ln, player].filter(Boolean).join(':');
}
function prettyMarket(x){
  const id = String(x||'').toLowerCase();
  if (id.includes('moneyline')) return 'Moneyline';
  if (id.includes('spread')||id.includes('handicap')) return 'Point Spread';
  if (id.includes('total')) return 'Totals';
  if (id.includes('1x2')) return '1X2';
  return x || 'Market';
}
function mapOutcome(o){
  return {
    sportsbook: (o.sportsbook||'').toLowerCase(),
    market: o.market,
    name: o.name,               // “Over 2.5”, “Home”, “Draw” osv.
    price: firstNum(o.price),   // vi beder om DECIMAL længere nede
    deep:  o.deep_link?.desktop || null,
    line:  o.selection_line ?? null
  };
}
function groupKey(fix, odd){
  // fixture_id + market + line/person -> saml tværs af bøger
  return [
    fix.id,
    (odd.market||'').toLowerCase(),
    normalizeLine(odd)
  ].join('::');
}
function findArbs(groups){
  const out = [];
  for (const g of groups.values()){
    const { meta, byBook } = g;
    const names = Object.keys(byBook);

    // 2-vejs: A=Over/Home, B=Under/Away (heuristik)
    for (let i=0;i<names.length;i++){
      for (let j=0;j<names.length;j++){
        if (i===j) continue;
        const b1 = names[i], b2 = names[j];
        const A  = byBook[b1].find(x=>/over|home|^1$|moneyline/i.test(x.name));
        const B  = byBook[b2].find(x=>/under|away|^2$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
        if (A && B && isFinite(A.price) && isFinite(B.price)){
          const sumInv = 1/A.price + 1/B.price;
          if (sumInv < 1){
            out.push({
              event:  meta.event,
              detail: meta.kickoff,
              market: meta.market,
              edge:   (1 - sumInv) * 100,
              sides: [
                { book:b1, line:A.name, odds:A.price, href:A.deep || '' },
                { book:b2, line:B.name, odds:B.price, href:B.deep || '' },
              ],
            });
          }
        }
      }
    }

    // 3-vejs: 1 X 2
    for (let i=0;i<names.length;i++){
      for (let j=0;j<names.length;j++){
        for (let k=0;k<names.length;k++){
          if (i===j || i===k || j===k) continue;
          const b1=names[i], b2=names[j], b3=names[k];
          const H = byBook[b1].find(x=>/home|^1$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
          const D = byBook[b2].find(x=>/draw|^x$/i.test(x.name));
          const A = byBook[b3].find(x=>/away|^2$|moneyline/i.test(x.name) && !/draw/i.test(x.name));
          if (H && D && A && [H.price,D.price,A.price].every(isFinite)){
            const sumInv = 1/H.price + 1/D.price + 1/A.price;
            if (sumInv < 1){
              out.push({
                event:  meta.event,
                detail: meta.kickoff,
                market: meta.market,
                edge:   (1 - sumInv) * 100,
                sides: [
                  { book:b1, line:H.name, odds:H.price, href:H.deep || '' },
                  { book:b2, line:D.name, odds:D.price, href:D.deep || '' },
                  { book:b3, line:A.name, odds:A.price, href:A.deep || '' },
                ],
              });
            }
          }
        }
      }
    }
  }
  return out;
}

// === hoved-endpoint ===
app.get('/arb', async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit||'150',10), 500);
    const minEdge = parseFloat(req.query.min_edge||'0');

    // 1) aktive sports -> leagues -> fixtures (med odds)
    const sports = (await oo('sports/active')).data || [];                         // :contentReference[oaicite:4]{index=4}
    const allLeagueIds = [];
    for (const s of sports){
      const leagues = (await oo('leagues', { sport: s.id })).data || [];
      allLeagueIds.push(...leagues.map(l=>l.id));
    }

    // Hent fixtures der har odds (unplayed + live)
    // (endpoint’et er /fixtures, filtrer has_odds=true)
    // return-format indeholder bl.a. id, start_date, teams, liga osv.  :contentReference[oaicite:5]{index=5}
    const fixtures = [];
    for (const L of allLeagueIds){
      const js = await oo('fixtures', { league: L, has_odds: true, is_live: false });
      fixtures.push(...(js.data||[]));
    }
    if (!fixtures.length) return res.json([]);

    // 2) odds for batches (maks 5 fixtures og maks 5 books pr. request)  :contentReference[oaicite:6]{index=6}
    const groups = new Map(); // key -> {meta, byBook: {book: [outs...]}}
    const fixBatches = chunk(fixtures.map(f=>f.id), 5);
    const bookBatches= chunk(BOOKS, 5);

    for (const fixBatch of fixBatches){
      for (const bookBatch of bookBatches){
        const js = await oo('fixtures/odds', {
          fixture_id: fixBatch,                    // multiple values OK (op til 5)
          sportsbook: bookBatch,                   // multiple values OK (op til 5)
          odds_format: 'DECIMAL',                  // få decimal odds
          include_deep_link: true
        });                                        // kravene står i v3 docs  :contentReference[oaicite:7]{index=7}
        for (const row of (js.data||[])){
          const meta = {
            fixtureId: row.id,
            event: `${row.away_team_display || 'Away'} @ ${row.home_team_display || 'Home'}`,
            kickoff: row.start_date || '',
          };
          for (const o of (row.odds||[])){
            const k = groupKey(row, o);
            if (!groups.has(k)){
              groups.set(k, { meta: { ...meta, market: prettyMarket(o.market) }, byBook: {} });
            }
            const g = groups.get(k);
            const mapped = mapOutcome(o);
            const b = mapped.sportsbook;
            if (!g.byBook[b]) g.byBook[b] = [];
            g.byBook[b].push({ name: mapped.name, price: mapped.price, deep: mapped.deep });
          }
        }
      }
    }

    // 3) find arbs
    let rows = findArbs(groups)
      .filter(r => (r.edge||0) >= minEdge)
      .sort((a,b)=>(b.edge||0)-(a.edge||0))
      .slice(0, limit);

    res.set('cache-control', 'no-store');
    res.json(rows);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => console.log('Surebet arb server on', PORT));
