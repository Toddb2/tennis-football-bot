const db = require('better-sqlite3')('./data/tennis-bot.db', { readonly: true });
const rows = db.prepare("SELECT bet_id, strategy_name, player_name, side, requested_odds, stake, settled_at, settlement_type, pnl, hedge_odds, betfair_market_id, placed_at FROM bets WHERE player_name LIKE '%Frech%' OR player_name LIKE '%Ruse%' ORDER BY placed_at DESC LIMIT 10").all();
console.log(JSON.stringify(rows, null, 2));
