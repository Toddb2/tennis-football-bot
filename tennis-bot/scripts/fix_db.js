'use strict';
const db = require('/home/bots/tennis-bot/src/database/db');

// Delete Jones/Pohankova market — children first, then parent
const mid = '1.257639049';
db.prepare('DELETE FROM bets WHERE betfair_market_id = ?').run(mid);
db.prepare('DELETE FROM market_snapshots WHERE betfair_market_id = ?').run(mid);
try { db.prepare('DELETE FROM price_milestones WHERE betfair_market_id = ?').run(mid); } catch(_) {}
try { db.prepare('DELETE FROM bet_rejections WHERE betfair_market_id = ?').run(mid); } catch(_) {}
db.prepare('DELETE FROM markets WHERE betfair_market_id = ?').run(mid);
console.log('Deleted market', mid);

// Backfill strategy_name from reason for bets with null strategy_name
const bets = db.prepare('SELECT id, reason FROM bets WHERE strategy_name IS NULL AND reason IS NOT NULL').all();
const upd  = db.prepare('UPDATE bets SET strategy_name = ? WHERE id = ?');
let n = 0;
for (const b of bets) {
  const m = b.reason && b.reason.match(/^([^:]+):/);
  if (m) { upd.run(m[1].trim(), b.id); n++; }
}
console.log('Backfilled strategy_name for', n, 'bets');

// Show current bets
const rows = db.prepare('SELECT id, bet_id, strategy_name, match_name, settlement_type, pnl FROM bets').all();
console.log('Current bets:', JSON.stringify(rows, null, 2));
process.exit(0);
