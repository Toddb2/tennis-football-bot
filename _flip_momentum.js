// One-off: flip momentum_at_bet for every P2 bet (player_key='B') so that
// positive always means "good for bet player", matching edge_at_bet semantics.
// Idempotent guard via a flag row in a tiny meta table.
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
const flag = db.prepare(`SELECT value FROM app_meta WHERE key='momentum_signed_for_bet_player'`).get();
if (flag) {
  console.log('Already flipped — skipping (flag set on', flag.value + ').');
  process.exit(0);
}

const before = db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE player_key='B' AND momentum_at_bet IS NOT NULL`).get().n;
const tx = db.transaction(() => {
  db.prepare(`UPDATE bets SET momentum_at_bet = -momentum_at_bet WHERE player_key='B' AND momentum_at_bet IS NOT NULL`).run();
  db.prepare(`INSERT INTO app_meta (key, value) VALUES ('momentum_signed_for_bet_player', ?)`).run(new Date().toISOString());
});
tx();
console.log(`Flipped momentum_at_bet sign on ${before} P2 bets.`);

// Verify
const sample = db.prepare(`SELECT bet_id, strategy_name, side, player_key, ROUND(momentum_at_bet,2) AS mom, ROUND(edge_at_bet,2) AS edge FROM bets WHERE player_key='B' ORDER BY placed_at DESC LIMIT 5`).all();
console.log('\nSample P2 bets after flip:'); sample.forEach(b => console.log(' ', b));
