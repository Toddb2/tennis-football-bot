const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });
console.log('Today PnL:', db.prepare(`SELECT COALESCE(ROUND(SUM(pnl),2),0) AS pnl, COUNT(*) AS bets FROM bets WHERE settled_at IS NOT NULL AND DATE(settled_at)=DATE('now')`).get());
console.log('\nLatest 5 settled today:');
for (const r of db.prepare(`SELECT bet_id, strategy_name, ROUND(pnl,2) AS pnl, settled_at FROM bets WHERE DATE(settled_at)=DATE('now') ORDER BY settled_at DESC LIMIT 5`).all()) console.log(' ', r);
