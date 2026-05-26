// Remove AIMISS bets for markets the bot never saw (no went_in_play_at in markets).
// Archive deleted rows to app_meta for reversibility.
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');

db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);

const candidates = db.prepare(`
  SELECT b.bet_id, b.betfair_market_id, b.strategy_name, b.side, b.player_key, b.pnl, b.stake, b.reason
  FROM bets b
  WHERE b.bet_id LIKE 'AIMISS-%'
    AND b.betfair_market_id IN (
      SELECT betfair_market_id FROM markets WHERE went_in_play_at IS NULL
    )
`).all();

console.log(`Found ${candidates.length} AIMISS bets to remove (markets never seen).`);

// Also clean up the stub market rows we created for these — they have no real data
const stubMarkets = db.prepare(`
  SELECT betfair_market_id FROM markets WHERE went_in_play_at IS NULL
`).all();
console.log(`Stub market rows present: ${stubMarkets.length}`);

const delBet = db.prepare(`DELETE FROM bets WHERE bet_id = ?`);
const delMarket = db.prepare(`DELETE FROM markets WHERE betfair_market_id = ? AND went_in_play_at IS NULL`);

let betsDeleted = 0, marketsDeleted = 0;
const tx = db.transaction(() => {
  for (const b of candidates) {
    delBet.run(b.bet_id);
    betsDeleted++;
  }
  // After removing AIMISS bets, the stub market rows that have NO remaining bets can be removed too.
  for (const m of stubMarkets) {
    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE betfair_market_id = ?`).get(m.betfair_market_id).n;
    if (remaining === 0) {
      delMarket.run(m.betfair_market_id);
      marketsDeleted++;
    }
  }
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`)
    .run(`remove_ai_only_${new Date().toISOString()}`, JSON.stringify({ candidates }));
});
tx();

console.log(`\n  Bets deleted:          ${betsDeleted}`);
console.log(`  Stub markets removed:  ${marketsDeleted}`);

console.log('\n=== Updated totals ===');
for (const r of db.prepare(`
  SELECT
    CASE WHEN bet_id LIKE 'AIMISS-%' THEN 'AIMISS'
         WHEN bet_id LIKE 'RETRO-%'  THEN 'RETRO'
         ELSE 'LIVE' END AS src,
    COUNT(*) AS n,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(stake), 2) AS stake,
    ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
  FROM bets GROUP BY src
`).all()) console.log(`  ${r.src.padEnd(8)} bets=${String(r.n).padStart(4)}  pnl=£${r.pnl}  ROI=${r.roi}%`);

const total = db.prepare(`SELECT COUNT(*) AS n, ROUND(SUM(pnl), 2) AS pnl, ROUND(SUM(stake), 2) AS stake, ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi FROM bets`).get();
console.log(`\n  GRAND TOTAL: bets=${total.n}  pnl=£${total.pnl}  stake=£${total.stake}  ROI=${total.roi}%`);
