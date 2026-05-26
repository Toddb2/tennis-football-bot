const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('=== bets schema ===');
const cols = db.prepare("PRAGMA table_info(bets)").all();
for (const c of cols) console.log(`  ${c.name.padEnd(22)} ${c.type}`);

console.log('\n=== backfill counts ===');
console.log(db.prepare(`SELECT COUNT(*) AS total, COUNT(sub_strategy) AS with_sub, COUNT(liability) AS with_liab, COUNT(momentum_at_bet) AS with_mom, COUNT(edge_at_bet) AS with_edge FROM bets`).get());

console.log('\n=== sub_strategy distribution (top 30) ===');
for (const r of db.prepare(`SELECT sub_strategy, COUNT(*) AS n FROM bets WHERE sub_strategy IS NOT NULL GROUP BY sub_strategy ORDER BY n DESC LIMIT 30`).all())
  console.log(`  ${(r.sub_strategy||'').padEnd(20)} ${r.n}`);

console.log('\n=== sample bets with new fields (latest 8) ===');
for (const r of db.prepare(`SELECT bet_id, strategy_name, sub_strategy, player_key, side, ROUND(stake,2) AS stake, ROUND(liability,2) AS liab, ROUND(momentum_at_bet,3) AS mom, ROUND(edge_at_bet,4) AS edge, ROUND(pnl,2) AS pnl FROM bets ORDER BY placed_at DESC LIMIT 8`).all())
  console.log(r);

console.log('\n=== ROI by strategy (liability-based) ===');
for (const r of db.prepare(`SELECT strategy_name, COUNT(*) AS n, ROUND(SUM(pnl),2) AS pnl, ROUND(SUM(liability),2) AS liab, ROUND(SUM(pnl)/NULLIF(SUM(liability),0)*100,2) AS roi_pct FROM bets WHERE settled_at IS NOT NULL GROUP BY strategy_name ORDER BY pnl DESC`).all())
  console.log(r);
