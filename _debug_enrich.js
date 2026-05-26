const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('=== Sample bets to check enrichment for ===');
const sampleBets = db.prepare(`
  SELECT b.bet_id, b.betfair_market_id, m.surface, m.player_a_name, m.player_b_name
  FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE m.surface IS NOT NULL AND m.player_a_name IS NOT NULL AND m.player_b_name IS NOT NULL
  LIMIT 5
`).all();
sampleBets.forEach(b => console.log(' ', b));

console.log('\n=== Surface WR for these players ===');
const wrStmt = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN (player_a_name = @name AND winner = 'A')
                        OR (player_b_name = @name AND winner = 'B') THEN 1 ELSE 0 END), 0) AS wins,
    COALESCE(SUM(CASE WHEN player_a_name = @name OR player_b_name = @name THEN 1 ELSE 0 END), 0) AS total
  FROM markets
  WHERE surface = @surface AND winner IN ('A','B') AND betfair_market_id != @excl
`);
for (const b of sampleBets) {
  const p1 = wrStmt.get({ name: b.player_a_name, surface: b.surface, excl: b.betfair_market_id });
  const p2 = wrStmt.get({ name: b.player_b_name, surface: b.surface, excl: b.betfair_market_id });
  console.log(`  ${b.player_a_name} on ${b.surface}: ${p1.wins}/${p1.total}`);
  console.log(`  ${b.player_b_name} on ${b.surface}: ${p2.wins}/${p2.total}`);
}

console.log('\n=== Price milestones for one market ===');
console.log('  ' + sampleBets[0].betfair_market_id);
for (const m of db.prepare(`SELECT * FROM price_milestones WHERE betfair_market_id = ?`).all(sampleBets[0].betfair_market_id))
  console.log(' ', m);

console.log('\n=== Total milestones rows + distribution ===');
console.log('total rows:', db.prepare(`SELECT COUNT(*) n FROM price_milestones`).get().n);
for (const r of db.prepare(`SELECT milestone, COUNT(*) n FROM price_milestones GROUP BY milestone`).all())
  console.log(' ', r);

console.log('\n=== Markets pre_match_volume / went_in_play_at sanity ===');
for (const r of db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN surface IS NOT NULL THEN 1 ELSE 0 END) AS with_surface,
    SUM(CASE WHEN winner IN ('A','B') THEN 1 ELSE 0 END) AS with_winner,
    SUM(CASE WHEN player_a_name IS NOT NULL AND player_b_name IS NOT NULL THEN 1 ELSE 0 END) AS with_names
  FROM markets
`).all()) console.log(' ', r);
