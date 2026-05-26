// Settle the Faria v Dimitrov match — bot lost stream but api-tennis confirms P1 won 2-1.
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');
db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);

const MARKET = '1.258306255';
const WINNER = 'A';
const FINAL_SETS = '[[3,6],[7,5],[7,6]]';   // tiebreak in S3, P1 won decider
const ENDED_AT = '2026-05-19T16:20:00.000Z';  // ~ time the tiebreak finished

console.log('═══ Updating market ═══');
db.prepare(`
  UPDATE markets SET winner = ?, final_sets = ?, ended_at = ? WHERE betfair_market_id = ?
`).run(WINNER, FINAL_SETS, ENDED_AT, MARKET);

const unsettled = db.prepare(`
  SELECT bet_id, strategy_name, side, player_key, stake,
         COALESCE(actual_odds, requested_odds) AS odds
  FROM bets WHERE betfair_market_id = ? AND (settled_at IS NULL OR pnl IS NULL)
`).all(MARKET);

console.log(`\n═══ Settling ${unsettled.length} bets ═══`);
const upd = db.prepare(`UPDATE bets SET settled_at = ?, pnl = ?, settlement_type = ? WHERE bet_id = ?`);
const tx = db.transaction(() => {
  for (const b of unsettled) {
    const won = (b.side === 'BACK' && WINNER === b.player_key)
             || (b.side === 'LAY'  && WINNER !== b.player_key);
    const pnl = won
      ? (b.side === 'BACK' ? +(b.stake * (b.odds - 1)).toFixed(2) : +b.stake.toFixed(2))
      : (b.side === 'BACK' ? -b.stake : -+(b.stake * (b.odds - 1)).toFixed(2));
    const stype = won ? 'DRY_WIN' : 'DRY_LOSS';
    upd.run(ENDED_AT, pnl, stype, b.bet_id);
    console.log(`  ${b.bet_id}  ${b.strategy_name}  ${b.side} ${b.player_key} @ ${b.odds}  → pnl £${pnl}  (${stype})`);
  }
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`)
    .run(`settle_faria_${new Date().toISOString()}`, JSON.stringify({ market: MARKET, bets: unsettled.map(b => b.bet_id) }));
});
tx();

const after = db.prepare(`SELECT bet_id, pnl, settlement_type FROM bets WHERE betfair_market_id = ?`).all(MARKET);
console.log('\n═══ After ═══');
for (const b of after) console.log(' ', b);
