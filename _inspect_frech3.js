const db = require('better-sqlite3')('./data/tennis-bot.db', { readonly: true });
const m = db.prepare("SELECT * FROM markets WHERE betfair_market_id = '1.258471560'").get();
console.log('match:', m?.match_name, 'externalId:', m?.api_tennis_external_id || m?.external_id || '???');
console.log('all market cols:', Object.keys(m||{}));
console.log(JSON.stringify(m, null, 2));
