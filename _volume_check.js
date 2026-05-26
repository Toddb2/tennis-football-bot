// Volume check — find each bet's matched_volume at placed_at and break down
// by 100k threshold. Deletes those under threshold (per user instruction).
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');

db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);

const THRESHOLD = 100_000;

// For each bet, pick the snapshot at placed_at (or just before) to find matched_volume.
// Fallback: peak across the market's snapshots, then market.pre_match_volume.
const bets = db.prepare(`
  SELECT b.bet_id, b.betfair_market_id, b.placed_at, b.strategy_name, b.stake, b.pnl,
         m.pre_match_volume,
         (SELECT s.matched_volume FROM market_snapshots s
          WHERE s.betfair_market_id = b.betfair_market_id
            AND s.ts <= b.placed_at
            AND s.matched_volume IS NOT NULL
          ORDER BY s.ts DESC LIMIT 1) AS vol_at_bet,
         (SELECT MAX(s.matched_volume) FROM market_snapshots s
          WHERE s.betfair_market_id = b.betfair_market_id
            AND s.matched_volume IS NOT NULL) AS peak_vol
  FROM bets b
  LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
`).all();

console.log(`Inspecting ${bets.length} bets…\n`);

const tiers = { over: [], under: [], unknown: [] };
for (const b of bets) {
  const v = b.vol_at_bet ?? b.peak_vol ?? b.pre_match_volume;
  if (v == null) tiers.unknown.push(b);
  else if (v >= THRESHOLD) tiers.over.push(b);
  else tiers.under.push(b);
}

console.log('=== Volume tier breakdown ===');
console.log(`  Over £${THRESHOLD/1000}k:  ${tiers.over.length}    keep`);
console.log(`  Under £${THRESHOLD/1000}k: ${tiers.under.length}    DELETE`);
console.log(`  Unknown (no snapshot data): ${tiers.unknown.length}    DELETE`);

console.log('\n=== Sample under-threshold ===');
tiers.under.slice(0, 8).forEach(b => {
  const v = b.vol_at_bet ?? b.peak_vol ?? b.pre_match_volume;
  console.log(`  ${b.bet_id}  ${b.strategy_name}  vol=£${Math.round(v).toLocaleString()}`);
});
console.log('\n=== Sample unknown-volume ===');
tiers.unknown.slice(0, 8).forEach(b => console.log(`  ${b.bet_id}  ${b.strategy_name}  no volume data`));

// Apply deletes (under + unknown)
const toDelete = [...tiers.under, ...tiers.unknown];
console.log(`\nDeleting ${toDelete.length} bets (under threshold + unknown)…`);

const delStmt = db.prepare(`DELETE FROM bets WHERE bet_id = ?`);
let deleted = 0;
const tx = db.transaction(() => {
  for (const b of toDelete) {
    delStmt.run(b.bet_id);
    deleted++;
  }
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`)
    .run(`vol_filter_${new Date().toISOString()}`, JSON.stringify({ deleted: toDelete.map(b => b.bet_id) }));
});
tx();
console.log(`Deleted: ${deleted}`);

console.log('\n=== Updated totals ===');
for (const r of db.prepare(`
  SELECT CASE WHEN bet_id LIKE 'AIMISS-%' THEN 'AIMISS' WHEN bet_id LIKE 'RETRO-%' THEN 'RETRO' ELSE 'LIVE' END AS src,
         COUNT(*) AS n,
         ROUND(SUM(pnl), 2) AS pnl,
         ROUND(SUM(stake), 2) AS stake,
         ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
  FROM bets GROUP BY src
`).all()) console.log(`  ${r.src.padEnd(8)} bets=${String(r.n).padStart(4)}  pnl=£${r.pnl}  stake=£${r.stake}  ROI=${r.roi}%`);

const total = db.prepare(`SELECT COUNT(*) AS n, ROUND(SUM(pnl), 2) AS pnl, ROUND(SUM(stake), 2) AS stake, ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi FROM bets`).get();
console.log(`\n  GRAND TOTAL: bets=${total.n}  pnl=£${total.pnl}  stake=£${total.stake}  ROI=${total.roi}%`);

console.log('\n=== Per-strategy summary (post-filter) ===');
for (const r of db.prepare(`
  SELECT strategy_name, COUNT(*) AS n,
         SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
         ROUND(SUM(pnl), 2) AS pnl,
         ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
  FROM bets WHERE settled_at IS NOT NULL
  GROUP BY strategy_name ORDER BY pnl DESC
`).all()) console.log(`  ${r.strategy_name.padEnd(14)} bets=${String(r.n).padStart(3)}  wins=${r.wins}  pnl=£${String(r.pnl).padStart(7)}  ROI=${r.roi}%`);
