const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('=== bets per Strat7-12 (originals) split by player_key ===');
for (const r of db.prepare(`
  SELECT strategy_name, player_key, COUNT(*) AS n,
         SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
         ROUND(SUM(pnl),2) AS pnl
  FROM bets
  WHERE strategy_name IN ('Strat7','Strat8','Strat9','Strat10','Strat11','Strat12')
  GROUP BY strategy_name, player_key
  ORDER BY strategy_name, player_key
`).all()) console.log(' ', r);

console.log('\n=== bets per mirror (Strat*_B) ===');
const mirrors = db.prepare(`
  SELECT strategy_name, player_key, COUNT(*) AS n
  FROM bets WHERE strategy_name LIKE '%_B'
  GROUP BY strategy_name, player_key
`).all();
console.log('  row count:', mirrors.length);
mirrors.forEach(r => console.log(' ', r));

console.log('\n=== confirm Strat7-12 only ever fired with player_key=A (P1) ===');
const wrong = db.prepare(`
  SELECT bet_id, strategy_name, player_key, side, placed_at, reason
  FROM bets
  WHERE strategy_name IN ('Strat7','Strat8','Strat9','Strat10','Strat11','Strat12')
    AND player_key != 'A'
  ORDER BY placed_at DESC
`).all();
console.log('  unexpected P2 bets on A-only strategies:', wrong.length);
wrong.forEach(b => console.log(' ', b));
