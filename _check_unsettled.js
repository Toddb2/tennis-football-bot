const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

const candidates = [
  'Jaime Faria v Grigor Dimitrov',
  'Moise Kouame v Jacopo Vasami',
  'Darja Vidmanova v Xinyu Gao',
  'Rebeka Masarova v Maria Carle',
];

for (const name of candidates) {
  console.log('\n═══', name, '═══');
  const market = db.prepare(`SELECT * FROM markets WHERE match_name LIKE ?`).get(`%${name}%`);
  if (!market) { console.log('  no market'); continue; }
  console.log(`  market: ${market.betfair_market_id}  surface=${market.surface}  winner=${market.winner}  ended_at=${market.ended_at}  final_sets=${market.final_sets}`);

  // Latest snapshot
  const last = db.prepare(`SELECT ts, sets, player_a_back, player_b_back FROM market_snapshots WHERE betfair_market_id = ? ORDER BY ts DESC LIMIT 1`).get(market.betfair_market_id);
  console.log(`  latest_snap: ${last?.ts}  sets=${last?.sets}  A=${last?.player_a_back}  B=${last?.player_b_back}`);

  // Time since last snap
  if (last) {
    const ageMin = Math.round((Date.now() - new Date(last.ts).getTime()) / 60000);
    console.log(`  age of latest snap: ${ageMin} min`);
  }

  // The bets on this market
  for (const b of db.prepare(`SELECT bet_id, strategy_name, player_key, side, settled_at, pnl, settlement_type FROM bets WHERE betfair_market_id = ?`).all(market.betfair_market_id))
    console.log(`    bet: ${b.bet_id}  ${b.strategy_name}  ${b.side} ${b.player_key}  settled=${b.settled_at}  pnl=${b.pnl}  type=${b.settlement_type}`);
}
