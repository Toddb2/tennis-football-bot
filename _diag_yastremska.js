const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('=== Find the bet ===');
const bets = db.prepare(`
  SELECT b.*, m.match_name, m.final_sets, m.winner, m.player_a_name, m.player_b_name, m.went_in_play_at, m.ended_at
  FROM bets b
  LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE m.match_name LIKE '%Yastremska%' OR m.match_name LIKE '%Bouzas%'
  ORDER BY b.placed_at DESC
`).all();
for (const b of bets) {
  console.log(b);
  console.log('---');
}

if (bets.length) {
  const market = bets[0].betfair_market_id;
  console.log('\n=== Snapshots around bet for market', market, '===');
  const snaps = db.prepare(`
    SELECT ts, player_a_back, player_b_back, sets, momentum_index, edge_a, edge_b
    FROM market_snapshots
    WHERE betfair_market_id = ?
    ORDER BY ts
  `).all(market);
  console.log('  total snaps:', snaps.length, 'first:', snaps[0]?.ts, 'last:', snaps[snaps.length-1]?.ts);
  console.log('\n  Sample (every ~20):');
  for (let i = 0; i < snaps.length; i += Math.max(1, Math.floor(snaps.length/15))) {
    const s = snaps[i];
    console.log(`  ${s.ts}  A=${s.player_a_back}  B=${s.player_b_back}  sets=${s.sets}  mom=${s.momentum_index}`);
  }
  console.log('  last 5:');
  snaps.slice(-5).forEach(s => console.log(`  ${s.ts}  A=${s.player_a_back}  B=${s.player_b_back}  sets=${s.sets}`));

  console.log('\n=== Milestones ===');
  for (const m of db.prepare(`SELECT milestone, ts, player_a_back, player_b_back, set_score FROM price_milestones WHERE betfair_market_id = ? ORDER BY ts`).all(market))
    console.log(' ', m);
}
