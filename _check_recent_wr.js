const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

const wrStmt = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN (player_a_name = @name AND winner = 'A')
                        OR (player_b_name = @name AND winner = 'B') THEN 1 ELSE 0 END), 0) AS wins,
    COALESCE(SUM(CASE WHEN player_a_name = @name OR player_b_name = @name THEN 1 ELSE 0 END), 0) AS total
  FROM markets WHERE surface = @surface AND winner IN ('A','B') AND betfair_market_id != @excl
`);

console.log('=== 20 most recent bets — diagnose surface WR availability ===\n');
const recent = db.prepare(`
  SELECT b.bet_id, b.strategy_name, b.placed_at, b.betfair_market_id,
         m.surface, m.player_a_name, m.player_b_name, m.winner
  FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  ORDER BY b.placed_at DESC LIMIT 20
`).all();

for (const b of recent) {
  let p1 = null, p2 = null, diff = null, note = '';
  if (!b.surface) note = 'NO_SURFACE on market';
  else if (!b.player_a_name || !b.player_b_name) note = 'NO_PLAYER_NAMES on market';
  else {
    p1 = wrStmt.get({ name: b.player_a_name, surface: b.surface, excl: b.betfair_market_id });
    p2 = wrStmt.get({ name: b.player_b_name, surface: b.surface, excl: b.betfair_market_id });
    if (p1.total >= 1 && p2.total >= 1) {
      diff = +((p1.wins / p1.total - p2.wins / p2.total) * 100).toFixed(1);
      note = `OK: ${diff}%`;
    } else {
      note = `INSUFFICIENT — p1=${p1.total} matches, p2=${p2.total} matches`;
    }
  }
  console.log(`  ${b.placed_at.slice(0,16)}  ${b.bet_id.slice(0,30).padEnd(30)} ${(b.strategy_name||'?').padEnd(12)} surf=${(b.surface||'?').padEnd(7)} ${note}`);
}

console.log('\n=== Counts: recent 50 bets ===');
const recent50 = db.prepare(`SELECT b.bet_id, b.betfair_market_id, m.surface, m.player_a_name, m.player_b_name FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id ORDER BY b.placed_at DESC LIMIT 50`).all();
let ok=0, noSurf=0, noNames=0, insuf=0;
for (const b of recent50) {
  if (!b.surface) { noSurf++; continue; }
  if (!b.player_a_name || !b.player_b_name) { noNames++; continue; }
  const p1 = wrStmt.get({ name: b.player_a_name, surface: b.surface, excl: b.betfair_market_id });
  const p2 = wrStmt.get({ name: b.player_b_name, surface: b.surface, excl: b.betfair_market_id });
  if (p1.total >= 1 && p2.total >= 1) ok++; else insuf++;
}
console.log(`  WR shown:   ${ok}`);
console.log(`  Insufficient sample: ${insuf}`);
console.log(`  No surface: ${noSurf}`);
console.log(`  No player names: ${noNames}`);

console.log('\n=== Verify deployed server.js has the threshold-1 fix ===');
const fs = require('fs');
const srv = fs.readFileSync('/home/bots/tennis-bot/src/dashboard/server.js', 'utf8');
const m = srv.match(/p1\.total >= (\d+) && p2\.total >= (\d+)/);
console.log('  Found:', m ? `>= ${m[1]} (P1) && >= ${m[2]} (P2)` : 'NOT FOUND');
