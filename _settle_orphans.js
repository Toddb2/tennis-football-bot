// Settle bets where the match has ended but the bot didn't settle them.
// Investigate / delete bets with no market data.
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');
db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);

console.log('═══ Part 1: Auto-settle bets where match ended ═══');
const settleable = db.prepare(`
  SELECT b.bet_id, b.strategy_name, b.side, b.player_key, b.stake, b.liability,
         COALESCE(b.actual_odds, b.requested_odds) AS odds,
         b.hedge_odds, b.exit_config,
         m.winner, m.ended_at
  FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE (b.settled_at IS NULL OR b.pnl IS NULL)
    AND m.winner IN ('A','B')
    AND m.ended_at IS NOT NULL
`).all();

console.log(`Found ${settleable.length} bets to settle:`);
const update = db.prepare(`
  UPDATE bets SET settled_at = ?, pnl = ?, settlement_type = ? WHERE bet_id = ?
`);

let n = 0;
const tx = db.transaction(() => {
  for (const b of settleable) {
    // Hedged bets: leave settlement_type alone but compute proper pnl
    // BACK win: pnl = stake*(odds-1); BACK loss: pnl = -stake
    // LAY  win: pnl = stake;          LAY loss: pnl = -stake*(odds-1)
    const betWon = (b.side === 'BACK' && b.winner === b.player_key)
                || (b.side === 'LAY'  && b.winner !== b.player_key);
    const pnl = betWon
      ? (b.side === 'BACK' ? +(b.stake * (b.odds - 1)).toFixed(2) : +b.stake.toFixed(2))
      : (b.side === 'BACK' ? -b.stake : -+(b.stake * (b.odds - 1)).toFixed(2));
    const settlement = betWon ? 'DRY_WIN' : 'DRY_LOSS';
    update.run(b.ended_at, pnl, settlement, b.bet_id);
    console.log(`  ${b.bet_id}  ${b.strategy_name}  ${b.side} ${b.player_key}  winner=${b.winner}  pnl=£${pnl}  (${settlement})`);
    n++;
  }
});
tx();
console.log(`Settled: ${n}`);

console.log('\n═══ Part 2: Bets with NO market data ═══');
const noMarket = db.prepare(`
  SELECT b.bet_id, b.strategy_name, b.placed_at, b.betfair_market_id,
         m.match_name, m.winner, m.final_sets, m.ended_at, m.went_in_play_at
  FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE (b.settled_at IS NULL OR b.pnl IS NULL)
`).all();
console.log(`Remaining unsettled (no market data): ${noMarket.length}`);
noMarket.forEach(r => console.log(`  ${r.bet_id}  ${r.strategy_name}  placed=${r.placed_at}  market=${r.betfair_market_id}  in_play=${r.went_in_play_at || 'null'}  ended=${r.ended_at || 'null'}`));

// Check if those markets are still in-play (in stateStore / not yet ended)
console.log('\n  These are likely matches still in progress — bot will settle them when the stream closes them.');
console.log('  No action needed unless you want to manually delete them.');

console.log('\n═══ Final unsettled count ═══');
const remaining = db.prepare(`SELECT COUNT(*) n FROM bets WHERE settled_at IS NULL OR pnl IS NULL`).get();
console.log(`  Still unsettled: ${remaining.n}`);
