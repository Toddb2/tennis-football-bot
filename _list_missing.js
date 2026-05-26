const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

const wrStmt = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN player_a_name = @name OR player_b_name = @name THEN 1 ELSE 0 END), 0) AS total
  FROM markets WHERE surface = @surface AND winner IN ('A','B')
`);

const recent = db.prepare(`
  SELECT b.bet_id, b.placed_at, m.surface, m.player_a_name, m.player_b_name, m.tournament
  FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  ORDER BY b.placed_at DESC LIMIT 80
`).all();

const missingPlayers = new Set();
for (const b of recent) {
  if (!b.surface) continue;
  for (const p of [b.player_a_name, b.player_b_name].filter(Boolean)) {
    const c = wrStmt.get({ name: p, surface: b.surface }).total;
    if (c === 0) missingPlayers.add(`${p} | ${b.surface} | ${b.tournament}`);
  }
}
console.log(`Players with 0 surface matches (in recent 80 bets): ${missingPlayers.size}\n`);
[...missingPlayers].forEach(p => console.log('  ' + p));

// Check player's overall record (any surface)
console.log('\n=== Their overall (any surface) records in our DB ===');
const overall = db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN player_a_name = @name OR player_b_name = @name THEN 1 ELSE 0 END), 0) AS matches,
         COALESCE(SUM(CASE WHEN (player_a_name = @name AND winner = 'A') OR (player_b_name = @name AND winner = 'B') THEN 1 ELSE 0 END), 0) AS wins
  FROM markets WHERE winner IN ('A','B')
`);
const names = [...new Set([...missingPlayers].map(p => p.split(' | ')[0]))];
for (const n of names) {
  const r = overall.get({ name: n });
  const wr = r.matches > 0 ? (r.wins / r.matches * 100).toFixed(0) + '%' : '—';
  console.log(`  ${n.padEnd(35)} matches=${r.matches}  wins=${r.wins}  overallWR=${wr}`);
}
