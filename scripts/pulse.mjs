// 2A Pulse — daily archive builder (methodology v0.2)
//
// Fetches public data, computes 2A Pulse for every completed UTC day the sources allow,
// and APPENDS any day that is not yet in the archive. Days already archived are never changed.
//
// The maths here is the same as the live dashboard on 2aresearch.org (v0.2).
// Run:  node scripts/pulse.mjs
import fs from 'node:fs';
import path from 'node:path';

const METHOD = 'v0.2';
const DATA_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data');
const CSV = path.join(DATA_DIR, 'pulse-history.csv');
const JSONF = path.join(DATA_DIR, 'pulse-history.json');
const LATEST = path.join(DATA_DIR, 'latest.json');

const SIGNALS = [
  { key: 'momentum', w: 30 }, { key: 'volatility', w: 20 }, { key: 'funding', w: 25 },
  { key: 'stablecoins', w: 15 }, { key: 'volume', w: 10 },
];
const COLUMNS = [
  'date', 'score', 'band',
  'momentum', 'volatility', 'funding', 'stablecoins', 'volume',
  'pts_momentum', 'pts_volatility', 'pts_funding', 'pts_stablecoins', 'pts_volume',
  'btc_close_usd', 'raw_momentum_pct_vs_30d_avg', 'raw_volatility_ratio_14d_90d', 'raw_funding_pct_per_8h',
  'raw_stablecoin_change_pct_30d', 'raw_volume_ratio_7d_30d',
  'fear_greed_altme', 'price_source', 'method', 'recorded', 'computed_at_utc',
];

// ---------- helpers (identical rules to the dashboard) ----------
const r1 = x => Math.round(x * 10) / 10;
const clip = x => Math.max(0, Math.min(100, x));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const day = ms => new Date(+ms).toISOString().slice(0, 10);
const closeDay = ms => day(+ms - 1);          // CoinGecko's 00:00 UTC point on day D is the close of D-1
const shift = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const band = v => { const s = Math.round(v); return s < 25 ? 'Extreme fear' : s < 45 ? 'Fear' : s <= 55 ? 'Neutral' : s < 76 ? 'Greed' : 'Extreme greed'; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 4) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url, { headers: { 'accept': 'application/json', 'user-agent': '2a-pulse-archive' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (k >= tries) throw e;
      console.warn(`retry ${k}: ${e.message}`);
      await sleep(5000 * k);
    }
  }
}

// ---------- fetch ----------
async function okxCandles() {
  let rows = [], after = '';
  for (let k = 0; k < 4; k++) {
    const r = await get('https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT&bar=1Dutc&limit=100' + (after ? '&after=' + after : ''));
    const d = r.data || []; rows = rows.concat(d); if (d.length < 100) break; after = d[d.length - 1][0];
  }
  rows.sort((a, b) => a[0] - b[0]);
  // OKX stamps a candle with its OPEN time; shift one day to match CoinGecko's convention
  return { prices: rows.map(r => [+r[0] + 864e5, +r[4]]), total_volumes: rows.map(r => [+r[0] + 864e5, +r[7]]) };
}

async function fetchAll() {
  let priceSource = 'CoinGecko', cg;
  try { cg = await get('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=365&interval=daily'); }
  catch (e) { console.warn('CoinGecko unavailable, using OKX:', e.message); priceSource = 'OKX'; cg = await okxCandles(); }
  const fng = await get('https://api.alternative.me/fng/?limit=0').catch(() => ({ data: [] }));
  const st = await get('https://stablecoins.llama.fi/stablecoincharts/all');
  let fund = [], after = '';
  for (let k = 0; k < 20; k++) {
    const r = await get('https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100' + (after ? '&after=' + after : ''));
    const d = r.data || []; fund = fund.concat(d); if (d.length < 100) break; after = d[d.length - 1].fundingTime;
  }
  return { cg, fng, st, fund, priceSource };
}

// ---------- compute (same maths as the v0.2 dashboard) ----------
function compute({ cg, fng, st, fund, priceSource }) {
  const P = new Map(), V = new Map(), F = new Map(), S = new Map(), G = new Map();
  cg.prices.forEach(([t, v]) => P.set(closeDay(t), v));
  cg.total_volumes.forEach(([t, v]) => V.set(closeDay(t), v));
  fund.forEach(r => { const d = day(r.fundingTime), v = parseFloat(r.realizedRate || r.fundingRate); if (!isFinite(v)) return; if (!F.has(d)) F.set(d, []); F.get(d).push(v); });
  st.forEach(r => S.set(closeDay(+r.date * 1000), r.totalCirculatingUSD.peggedUSD));
  (fng.data || []).forEach(r => G.set(day(+r.timestamp * 1000), +r.value));
  const fk = [...F.keys()].sort(), sk = [...S.keys()].sort();
  const latest = (keys, map, d, maxGap) => { for (let j = keys.length - 1; j >= 0; j--) if (keys[j] <= d) { if ((Date.parse(d) - Date.parse(keys[j])) / 864e5 > maxGap) return null; return map.get(keys[j]); } return null; };
  const today = new Date().toISOString().slice(0, 10);
  const days = [...P.keys()].filter(d => d < today).sort();
  const out = [];
  for (let i = 91; i < days.length; i++) {
    const d = days[i], w = days.slice(0, i + 1);
    const fr = latest(fk, F, d, 2), s0 = latest(sk, S, d, 3), s30 = latest(sk, S, shift(d, -30), 3);
    if (fr == null || s0 == null || s30 == null) continue;
    if (w.slice(-91).some(x => !P.has(x)) || w.slice(-30).some(x => !V.has(x))) continue;
    const rets = ws => ws.slice(1).map((x, j) => Math.log(P.get(x) / P.get(ws[j])));
    const ma30 = mean(w.slice(-30).map(x => P.get(x)));
    const mom = clip(50 + (P.get(d) / ma30 - 1) * 500);
    const vratio = sd(rets(w.slice(-15))) / sd(rets(w.slice(-91)));
    const vol = clip(50 - (vratio - 1) * 60);
    const f = mean(fr), fund_ = clip(25 + f / 0.0001 * 50);
    const stab = clip(50 + (s0 / s30 - 1) * 1000);
    const vr = mean(w.slice(-7).map(x => V.get(x))) / mean(w.slice(-30).map(x => V.get(x)));
    const volu = clip(50 + (vr - 1) * 100);
    const c = [mom, vol, fund_, stab, volu].map(r1);
    const pt = c.map((v, k) => r1(v * SIGNALS[k].w / 100));
    const s = r1(pt.reduce((a, b) => a + b, 0));
    out.push({
      date: d, score: s, band: band(s),
      momentum: c[0], volatility: c[1], funding: c[2], stablecoins: c[3], volume: c[4],
      pts_momentum: pt[0], pts_volatility: pt[1], pts_funding: pt[2], pts_stablecoins: pt[3], pts_volume: pt[4],
      btc_close_usd: Math.round(P.get(d)),
      raw_momentum_pct_vs_30d_avg: +((P.get(d) / ma30 - 1) * 100).toFixed(4),
      raw_volatility_ratio_14d_90d: +vratio.toFixed(4),
      raw_funding_pct_per_8h: +(f * 100).toFixed(6),
      raw_stablecoin_change_pct_30d: +((s0 / s30 - 1) * 100).toFixed(4),
      raw_volume_ratio_7d_30d: +vr.toFixed(4),
      fear_greed_altme: G.get(d) ?? '',
      price_source: priceSource, method: METHOD,
    });
  }
  return out;
}

// ---------- archive (append-only) ----------
function readArchive() {
  if (!fs.existsSync(JSONF)) return [];
  return JSON.parse(fs.readFileSync(JSONF, 'utf8')).rows || [];
}
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function writeArchive(rows) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(CSV, [COLUMNS.join(','), ...rows.map(r => COLUMNS.map(c => csvCell(r[c])).join(','))].join('\n') + '\n');
  fs.writeFileSync(JSONF, JSON.stringify({
    name: '2A Pulse — Bitcoin Market Sentiment Index', publisher: '2A Research', site: 'https://2aresearch.org',
    method: METHOD, weights: Object.fromEntries(SIGNALS.map(s => [s.key, s.w / 100])),
    note: 'Append-only daily archive. Each row is one completed UTC day. recorded = backfill (reconstructed when the archive started), daily (computed the morning after that day closed) or catch-up (a missed day filled in later).',
    updated_at_utc: new Date().toISOString(), rows,
  }, null, 1) + '\n');
  const last = rows[rows.length - 1];
  fs.writeFileSync(LATEST, JSON.stringify(last, null, 1) + '\n');
}

const archive = readArchive();
const have = new Set(archive.map(r => r.date));
const firstRun = archive.length === 0;
const computed = compute(await fetchAll());
const yesterday = shift(new Date().toISOString().slice(0, 10), -1);
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const added = computed.filter(r => !have.has(r.date)).map(r => ({
  ...r, recorded: firstRun ? 'backfill' : (r.date === yesterday ? 'daily' : 'catch-up'), computed_at_utc: now,
}));
if (!added.length) { console.log('Nothing new to add. Archive has', archive.length, 'days.'); process.exit(0); }
writeArchive([...archive, ...added]);
console.log(`Added ${added.length} day(s): ${added[0].date} → ${added[added.length - 1].date}. Archive now ${archive.length + added.length} days.`);
console.log('Latest:', added[added.length - 1].date, added[added.length - 1].score, added[added.length - 1].band);
