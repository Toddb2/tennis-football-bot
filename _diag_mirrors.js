const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('=== bets / rejections for Strat*_B ===');
const bets = db.prepare("SELECT bet_id, strategy_name, side, player_key, ROUND(stake,2) AS stake, ROUND(pnl,2) AS pnl, placed_at FROM bets WHERE strategy_name LIKE '%_B' ORDER BY placed_at DESC LIMIT 10").all();
console.log('  bets fired:', bets.length); bets.forEach(b => console.log(' ', b));

const rejs = db.prepare("SELECT strategy_name, rejection_stage, rejection_reason, COUNT(*) AS n FROM bet_rejections WHERE strategy_name LIKE '%_B' AND ts >= datetime('now','-24 hours') GROUP BY strategy_name, rejection_stage, rejection_reason ORDER BY n DESC LIMIT 30").all();
console.log('\n=== rejections (last 24h) for Strat*_B ===');
console.log('  reject rows:', rejs.length); rejs.forEach(r => console.log(' ', r));

console.log('\n=== all strategy names in rejections (last 24h, top 30) ===');
for (const r of db.prepare("SELECT strategy_name, COUNT(*) AS n FROM bet_rejections WHERE ts >= datetime('now','-24 hours') GROUP BY strategy_name ORDER BY n DESC LIMIT 30").all())
  console.log(' ', r);

console.log('\n=== rejection stages distribution (Strat*_B last 24h) ===');
for (const r of db.prepare("SELECT rejection_stage, COUNT(*) AS n FROM bet_rejections WHERE strategy_name LIKE '%_B' AND ts >= datetime('now','-24 hours') GROUP BY rejection_stage ORDER BY n DESC").all())
  console.log(' ', r);
