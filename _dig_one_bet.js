const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });
const b = db.prepare(`SELECT * FROM bets WHERE bet_id = ?`).get('DRY-1779185390406-5255');
console.log(b);
const m = db.prepare(`SELECT betfair_market_id, match_name, final_sets, winner FROM markets WHERE betfair_market_id = ?`).get(b.betfair_market_id);
console.log(m);
console.log('\nFinal sets parsed:', JSON.parse(m.final_sets));
