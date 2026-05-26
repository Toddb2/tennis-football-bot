// Check every bet for serve-stats availability.
// Source: market_snapshots.serve_stats (JSON keyed by set1/set2/set3/match).
// For each bet, find the latest snapshot at-or-before placed_at with serve_stats, parse it,
// and verify each per-set / match slice has actual data (firstServeIn, firstServeWon, etc).
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

const bets = db.prepare(`
  SELECT b.bet_id, b.betfair_market_id, b.placed_at, b.strategy_name, b.player_key,
         (SELECT s.serve_stats FROM market_snapshots s
          WHERE s.betfair_market_id = b.betfair_market_id
            AND s.ts <= b.placed_at
            AND s.serve_stats IS NOT NULL
          ORDER BY s.ts DESC LIMIT 1) AS serve_stats_pre,
         (SELECT s.serve_stats FROM market_snapshots s
          WHERE s.betfair_market_id = b.betfair_market_id
            AND s.serve_stats IS NOT NULL
          ORDER BY s.ts DESC LIMIT 1) AS serve_stats_latest
  FROM bets b
`).all();

console.log(`Inspecting ${bets.length} bets…\n`);

// Categorise availability
const tiers = {
  full:       [],   // has set1 AND set2 (and maybe more) stats
  s1_only:    [],   // only set1 has data
  match_only: [],   // only the rolled-up "match" key
  empty:      [],   // serve_stats present but every set/match slice is empty
  none:       [],   // no serve_stats snapshot at all
};

function hasData(ss) {
  if (!ss) return false;
  return Object.values(ss).some(v =>
    v != null && (v.firstServeIn != null || v.firstServeWon != null || v.secondServeWon != null || v.aces != null)
  );
}

for (const b of bets) {
  const raw = b.serve_stats_pre || b.serve_stats_latest;
  if (!raw) { tiers.none.push(b); continue; }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) {}
  if (!parsed) { tiers.none.push(b); continue; }

  const haveS1    = hasData(parsed.set1);
  const haveS2    = hasData(parsed.set2);
  const haveS3    = hasData(parsed.set3);
  const haveMatch = hasData(parsed.match);

  if (haveS1 && (haveS2 || haveS3 || haveMatch))  tiers.full.push(b);
  else if (haveS1)                                tiers.s1_only.push(b);
  else if (haveMatch)                             tiers.match_only.push(b);
  else                                            tiers.empty.push(b);
}

console.log('=== Serve-stats availability ===');
console.log(`  Full (set1 + at least one of set2/3/match): ${tiers.full.length}`);
console.log(`  Set 1 only:                                  ${tiers.s1_only.length}`);
console.log(`  Match-rollup only (no per-set):              ${tiers.match_only.length}`);
console.log(`  Snapshot exists but all empty:               ${tiers.empty.length}`);
console.log(`  No serve-stats snapshot at all:              ${tiers.none.length}`);

console.log('\n=== Coverage by strategy ===');
const byStratStats = db.prepare(`
  SELECT strategy_name,
         COUNT(*) AS total,
         SUM(CASE WHEN (
           SELECT s.serve_stats FROM market_snapshots s
           WHERE s.betfair_market_id = b.betfair_market_id
             AND s.serve_stats IS NOT NULL
             AND s.ts <= b.placed_at
           LIMIT 1) IS NOT NULL THEN 1 ELSE 0 END) AS with_stats
  FROM bets b
  GROUP BY strategy_name
  ORDER BY total DESC
`).all();
for (const r of byStratStats) {
  const pct = (r.with_stats / r.total * 100).toFixed(0);
  console.log(`  ${r.strategy_name.padEnd(14)} ${r.with_stats}/${r.total} (${pct}%)`);
}

console.log('\n=== Sample of "no serve stats" bets ===');
for (const b of tiers.none.slice(0, 10)) {
  const m = db.prepare(`SELECT match_name, went_in_play_at FROM markets WHERE betfair_market_id = ?`).get(b.betfair_market_id);
  console.log(`  ${b.bet_id}  ${b.strategy_name}  ${m?.match_name || '—'}  in-play=${m?.went_in_play_at || '—'}`);
}

console.log('\n=== Sample of "Set 1 only" bets ===');
for (const b of tiers.s1_only.slice(0, 5)) {
  const m = db.prepare(`SELECT match_name FROM markets WHERE betfair_market_id = ?`).get(b.betfair_market_id);
  const parsed = JSON.parse(b.serve_stats_pre || b.serve_stats_latest);
  console.log(`  ${b.bet_id}  ${b.strategy_name}  ${m?.match_name || '—'}`);
  console.log(`    set1: ${JSON.stringify(parsed.set1).slice(0,160)}`);
}

console.log('\n=== Source breakdown of "none" ===');
const noneBySource = { LIVE: 0, AIMISS: 0, RETRO: 0 };
for (const b of tiers.none) {
  if (b.bet_id.startsWith('AIMISS-')) noneBySource.AIMISS++;
  else if (b.bet_id.startsWith('RETRO-')) noneBySource.RETRO++;
  else noneBySource.LIVE++;
}
console.log(`  LIVE:   ${noneBySource.LIVE}`);
console.log(`  AIMISS: ${noneBySource.AIMISS}`);
console.log(`  RETRO:  ${noneBySource.RETRO}`);
