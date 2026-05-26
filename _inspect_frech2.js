const db = require('better-sqlite3')('./data/tennis-bot.db', { readonly: true });
const cols = db.prepare("PRAGMA table_info(market_snapshots)").all();
console.log('snapshot cols:', cols.map(c => c.name).join(', '));
console.log('---');
const snaps = db.prepare("SELECT * FROM market_snapshots WHERE betfair_market_id = '1.258471560' ORDER BY rowid DESC LIMIT 2").all();
console.log('snapshots:', snaps.length);
for (const s of snaps) {
  console.log(JSON.stringify(s, null, 2));
  console.log('---');
}
const m = db.prepare("SELECT * FROM markets WHERE betfair_market_id = '1.258471560'").get();
console.log('market row:', JSON.stringify(m, null, 2));
