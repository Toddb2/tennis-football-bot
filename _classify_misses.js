// Classify every AIMISS-* bet by the most likely reason it was missed.
// Categories (in priority order):
//   1. NO_MARKET            — Betfair market not in our DB at all
//   2. STRATEGY_DISABLED_NEW — strategy is a mirror added after the match
//   3. BUG_BSCORES          — pre-fix mirrors with wrong allowedSetScores
//   4. GLOBAL_ODDS_CAP      — rejected because odds > maxOddsToBack
//   5. STRATEGY_OWN_ODDS    — odds outside strategy's own minOdds/maxOdds
//   6. REJECTED_OTHER       — rejection log shows other reason (VOLUME/FILTER/etc)
//   7. SILENT_MISS          — market in DB, strategy enabled, no rejection logged
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const fs = require('fs');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });
const cfg = JSON.parse(fs.readFileSync('/home/bots/tennis-bot/config/strategies.json', 'utf8'));

const globalMaxBack = cfg.filters?.maxOddsToBack ?? 6;
const globalMinBack = cfg.filters?.minOddsToBack ?? 1.3;
const globalMaxLay  = cfg.filters?.maxOddsToLay  ?? 4;
const globalMinLay  = cfg.filters?.minOddsToLay  ?? 1.1;
const stratByName = {};
for (const s of (cfg.systems || [])) stratByName[s.name] = s;

// The mirrors' allowedSetScores bug was fixed at this UTC instant
const FIX_DEPLOY = '2026-05-19T11:00:00.000Z';
const MIRROR_NAMES = new Set(['Strat7_P2','Strat8_P2','Strat9_P2','Strat10_P2','Strat11_P2','Strat12_P2']);
// (Originals were renamed from Strat7 -> Strat7_P1 same time; before that they ran as Strat7. So they aren't "new" strategies.)

const rows = db.prepare(`
  SELECT bet_id, betfair_market_id, strategy_name, side, requested_odds AS odds, settled_at, placed_at
  FROM bets WHERE bet_id LIKE 'AIMISS-%'
`).all();

console.log('Total AIMISS rows:', rows.length);

const buckets = {};
const examples = {};
function tag(row, bucket, note) {
  buckets[bucket] = (buckets[bucket] || 0) + 1;
  if (!examples[bucket]) examples[bucket] = [];
  if (examples[bucket].length < 3) examples[bucket].push({ ...row, note });
}

const marketCache = new Map();
function getMarket(id) {
  if (!marketCache.has(id)) {
    marketCache.set(id, db.prepare(`SELECT went_in_play_at, ended_at, match_name FROM markets WHERE betfair_market_id = ?`).get(id));
  }
  return marketCache.get(id);
}

const rejStmt = db.prepare(`
  SELECT rejection_stage, rejection_reason, COUNT(*) AS n
  FROM bet_rejections
  WHERE betfair_market_id = ? AND strategy_name = ?
  GROUP BY rejection_stage ORDER BY n DESC LIMIT 1
`);

for (const r of rows) {
  // Pre-rename: strategy might be Strat7_P1 in CSV, but rejection log may have Strat7 or Strat7_P1
  // Try both shapes
  const m = getMarket(r.betfair_market_id);
  if (!m || !m.went_in_play_at) {
    tag(r, 'NO_MARKET', 'market unknown to bot');
    continue;
  }

  // Was the match settled before the fix went in? (relevant for mirrors)
  const isMirror = MIRROR_NAMES.has(r.strategy_name);
  if (isMirror && m.ended_at && m.ended_at < FIX_DEPLOY) {
    tag(r, 'BUG_BSCORES', `mirror; match ended ${m.ended_at} before fix at ${FIX_DEPLOY}`);
    continue;
  }

  // Check rejection logs under both name conventions
  let rej = rejStmt.get(r.betfair_market_id, r.strategy_name);
  if (!rej) {
    // try without _P1 (in case rejection was logged with old name)
    const legacy = r.strategy_name.replace(/_P1$/, '');
    if (legacy !== r.strategy_name) rej = rejStmt.get(r.betfair_market_id, legacy);
  }
  if (!rej) {
    // try with _B (in case rejection was logged with old mirror name)
    if (isMirror) {
      const legacy = r.strategy_name.replace(/_P2$/, '_B');
      rej = rejStmt.get(r.betfair_market_id, legacy);
    }
  }

  if (rej) {
    if (rej.rejection_stage === 'GLOBAL_ODDS')      tag(r, 'GLOBAL_ODDS_CAP',  `odds ${r.odds} clipped by global cap`);
    else if (rej.rejection_stage === 'ENTRY_ODDS')  tag(r, 'STRATEGY_OWN_ODDS', `odds ${r.odds} outside strategy band`);
    else tag(r, 'REJECTED_OTHER', `${rej.rejection_stage} — ${rej.rejection_reason}`);
    continue;
  }

  // No rejection — but check if odds were outside global cap (would have been rejected on the day if evaluated)
  if (r.side === 'BACK' && r.odds > globalMaxBack) {
    tag(r, 'GLOBAL_ODDS_CAP', `BACK ${r.odds} > global ${globalMaxBack}`);
    continue;
  }
  if (r.side === 'BACK' && r.odds < globalMinBack) {
    tag(r, 'GLOBAL_ODDS_CAP', `BACK ${r.odds} < global ${globalMinBack}`);
    continue;
  }
  if (r.side === 'LAY' && r.odds > globalMaxLay) {
    tag(r, 'GLOBAL_ODDS_CAP', `LAY ${r.odds} > global ${globalMaxLay}`);
    continue;
  }

  tag(r, 'SILENT_MISS', `strategy enabled, market visible, no rejection logged`);
}

console.log('\n=== Categorisation ===');
const total = rows.length;
for (const [k, n] of Object.entries(buckets).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(n).padStart(4)}  (${(n / total * 100).toFixed(1)}%)`);
}

console.log('\n=== Sample per bucket ===');
for (const k of Object.keys(buckets)) {
  console.log(`\n  ${k}:`);
  for (const e of examples[k]) {
    console.log(`    ${e.bet_id} / ${e.strategy_name} / ${e.side} ${e.odds}  — ${e.note}`);
  }
}

// Drill into SILENT_MISS to see strategy distribution
console.log('\n=== SILENT_MISS by strategy ===');
const silentByStrat = {};
for (const r of rows) {
  const m = getMarket(r.betfair_market_id);
  if (!m || !m.went_in_play_at) continue;
  const isMirror = MIRROR_NAMES.has(r.strategy_name);
  if (isMirror && m.ended_at && m.ended_at < FIX_DEPLOY) continue;
  const rej = rejStmt.get(r.betfair_market_id, r.strategy_name);
  if (rej) continue;
  if (r.side === 'BACK' && (r.odds > globalMaxBack || r.odds < globalMinBack)) continue;
  if (r.side === 'LAY'  && r.odds > globalMaxLay) continue;
  silentByStrat[r.strategy_name] = (silentByStrat[r.strategy_name] || 0) + 1;
}
for (const [k, n] of Object.entries(silentByStrat).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${k.padEnd(14)} ${n}`);
}
