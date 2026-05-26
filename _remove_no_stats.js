const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');
db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);

const targets = db.prepare(`
  SELECT b.bet_id, b.strategy_name, b.pnl
  FROM bets b
  WHERE NOT EXISTS (
    SELECT 1 FROM market_snapshots s
    WHERE s.betfair_market_id = b.betfair_market_id
      AND s.serve_stats IS NOT NULL
  )
`).all();
console.log(`Bets to delete (no serve_stats anywhere on their market): ${targets.length}`);
targets.forEach(t => console.log(`  ${t.bet_id}  ${t.strategy_name}  pnl=£${t.pnl}`));

const del = db.prepare(`DELETE FROM bets WHERE bet_id = ?`);
let n = 0;
const tx = db.transaction(() => {
  for (const t of targets) { del.run(t.bet_id); n++; }
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`)
    .run(`remove_no_stats_${new Date().toISOString()}`, JSON.stringify({ deleted: targets }));
});
tx();
console.log(`\nDeleted: ${n}`);

console.log('\n=== Updated totals ===');
for (const r of db.prepare(`
  SELECT CASE WHEN bet_id LIKE 'AIMISS-%' THEN 'AIMISS' WHEN bet_id LIKE 'RETRO-%' THEN 'RETRO' ELSE 'LIVE' END AS src,
         COUNT(*) n, ROUND(SUM(pnl),2) pnl, ROUND(SUM(stake),2) stake,
         ROUND(SUM(pnl)/NULLIF(SUM(stake),0)*100,2) roi
  FROM bets GROUP BY src
`).all()) console.log(`  ${r.src.padEnd(8)} bets=${String(r.n).padStart(4)}  pnl=£${r.pnl}  stake=£${r.stake}  ROI=${r.roi}%`);
const total = db.prepare(`SELECT COUNT(*) n, ROUND(SUM(pnl),2) pnl, ROUND(SUM(stake),2) stake, ROUND(SUM(pnl)/NULLIF(SUM(stake),0)*100,2) roi FROM bets`).get();
console.log(`\n  GRAND TOTAL: bets=${total.n}  pnl=£${total.pnl}  stake=£${total.stake}  ROI=${total.roi}%`);
