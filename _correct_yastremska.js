// Retroactive correction for the Yastremska v Bouzas Strat1h bet that
// was settled prematurely due to a Betfair stream score glitch (6-5 → 6-4).
// Bet #149: DRY-1778923195806-2990  market 1.258207552
//
//   Original (incorrect): DRY_LOSS, pnl -£0.72, no hedge
//   Corrected:            TRADE_OUT, pnl +£0.057, hedge_odds 1.40
//                         at the actual set-2 completion timestamp.
// Also: markets.final_sets [[7,6],[6,4]] -> [[7,6],[6,7],[7,6]] (real 3-set result).

const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

const BET_ID = 'DRY-1778923195806-2990';
const MARKET = '1.258207552';

console.log('=== Before ===');
console.log(db.prepare(`SELECT bet_id, strategy_name, side, ROUND(pnl,4) AS pnl, settlement_type, hedge_odds, settled_at FROM bets WHERE bet_id = ?`).get(BET_ID));
console.log(db.prepare(`SELECT betfair_market_id, final_sets, winner FROM markets WHERE betfair_market_id = ?`).get(MARKET));

db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);

const tx = db.transaction(() => {
  // Audit row capturing the original state for traceability
  const before = JSON.stringify(db.prepare(`SELECT bet_id, pnl, settlement_type, hedge_odds, settled_at FROM bets WHERE bet_id = ?`).get(BET_ID));
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`)
    .run(`retro_correct_${BET_ID}`, `${new Date().toISOString()} BEFORE=${before}`);

  // 1. Fix the bet — apply hedge result
  db.prepare(`
    UPDATE bets
    SET pnl             = 0.06,
        settlement_type = 'TRADE_OUT',
        hedge_odds      = 1.40,
        settled_at      = '2026-05-16T10:29:26.271Z',
        reason          = COALESCE(reason, '') || ' [RETRO-HEDGE: bot stream-glitched on set 2 score 6-5->6-4; corrected to actual set 2 end at 10:29:26 with P1 odds 1.40, hedge stake £1.943, locked +£0.06]'
    WHERE bet_id = ?
  `).run(BET_ID);

  // 2. Fix markets.final_sets — the recorded [[7,6],[6,4]] was the glitched mid-set-2 snapshot.
  //    Real final was [[7,6],[6,7],[7,6]] (Yastremska won 2-1).
  db.prepare(`
    UPDATE markets
    SET final_sets = '[[7,6],[6,7],[7,6]]'
    WHERE betfair_market_id = ?
  `).run(MARKET);
});
tx();

console.log('\n=== After ===');
console.log(db.prepare(`SELECT bet_id, strategy_name, side, ROUND(pnl,4) AS pnl, settlement_type, hedge_odds, settled_at FROM bets WHERE bet_id = ?`).get(BET_ID));
console.log(db.prepare(`SELECT betfair_market_id, final_sets, winner FROM markets WHERE betfair_market_id = ?`).get(MARKET));

console.log('\n=== PnL impact ===');
console.log('Original: -£0.72 (DRY_LOSS)');
console.log('Corrected: +£0.06 (TRADE_OUT hedged @ 1.40)');
console.log('Swing:    +£0.78');
