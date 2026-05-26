const db = require('better-sqlite3')('./data/tennis-bot.db');
const now = new Date().toISOString();

// Strat10P1: BACK Frech @ 1.64, stake £1, Frech won → DRY_WIN, pnl = (1.64-1)*1 = 0.64
const r1 = db.prepare(`
  UPDATE bets
  SET settled_at = ?, settlement_type = 'DRY_WIN', pnl = 0.64
  WHERE bet_id = 'DRY-1779635245816-4977'
`).run(now);
console.log('Strat10P1 Frech BACK @ 1.64 → DRY_WIN +0.64 |', r1.changes, 'row');

// Strat9P2: BACK Ruse @ 3.30, stake £1, Ruse retired → DRY_LOSS, pnl = -1
const r2 = db.prepare(`
  UPDATE bets
  SET settled_at = ?, settlement_type = 'DRY_LOSS', pnl = -1
  WHERE bet_id = 'DRY-1779635920859-8631'
`).run(now);
console.log('Strat9P2 Ruse BACK @ 3.30 → DRY_LOSS -1 |', r2.changes, 'row');

// Also record final result on the markets row
db.prepare(`UPDATE markets SET ended_at = ?, final_sets = ?, winner = ? WHERE betfair_market_id = '1.258471560'`)
  .run(now, '[{"playerA":7,"playerB":6},{"playerA":2,"playerB":1}]', 'A');
console.log('market row updated with retirement result (Frech)');
