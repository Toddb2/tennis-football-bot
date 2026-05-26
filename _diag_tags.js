const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('=== Strat*_B rejections in last 1h (post allowedSetScores fix) ===');
for (const r of db.prepare(`
  SELECT strategy_name, rejection_stage, rejection_reason, COUNT(*) AS n
  FROM bet_rejections
  WHERE strategy_name LIKE '%_B' AND ts >= datetime('now','-1 hours')
  GROUP BY strategy_name, rejection_stage, rejection_reason
  ORDER BY strategy_name, n DESC
`).all()) console.log(' ', r);

console.log('\n=== Strat9 vs Strat9_B activity last 6h (rejections + bets) ===');
for (const r of db.prepare(`
  SELECT strategy_name, rejection_stage, COUNT(*) AS n
  FROM bet_rejections
  WHERE strategy_name IN ('Strat9','Strat9_B') AND ts >= datetime('now','-6 hours')
  GROUP BY strategy_name, rejection_stage
  ORDER BY strategy_name, n DESC
`).all()) console.log(' ', r);

console.log('\n=== bets fired in last 6h ===');
for (const b of db.prepare(`
  SELECT bet_id, strategy_name, sub_strategy, side, player_key, ROUND(stake,2) AS stake, placed_at
  FROM bets
  WHERE placed_at >= datetime('now','-6 hours')
  ORDER BY placed_at DESC LIMIT 20
`).all()) console.log(' ', b);

console.log('\n=== matches with 3+ qualifying mirrors recently (look for the 7B/11B/12B one) ===');
// We don't store qualifyingSystems history, but we CAN find matches where Strat7_B/11_B/12_B all logged
// rejections within minutes of each other — that means all three saw the same trigger moment.
const triple = db.prepare(`
  SELECT betfair_market_id, match_name, GROUP_CONCAT(DISTINCT strategy_name) AS strats,
         MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS n
  FROM bet_rejections
  WHERE ts >= datetime('now','-12 hours')
    AND strategy_name LIKE '%_B'
  GROUP BY betfair_market_id
  HAVING COUNT(DISTINCT strategy_name) >= 2
  ORDER BY n DESC LIMIT 10
`).all();
for (const t of triple) console.log(' ', t);
