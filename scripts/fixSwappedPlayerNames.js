'use strict';

/**
 * One-off corrective pass for bets whose stored player_name belongs to the
 * OPPOSITE player relative to player_key. Settlement keys off player_key (which
 * is correct — verified 0 settlement mismatches), so this is a display/reporting
 * fix only: it realigns player_name to the canonical market name for the bet's
 * player_key.
 *
 * A row is corrected ONLY when its player_name clearly matches the opposite
 * player AND does not match its own key's player (so legitimate
 * formatting differences — "E Rybakina" vs "Elena Rybakina" — are left alone).
 *
 *   node scripts/fixSwappedPlayerNames.js            # dry run (report only)
 *   node scripts/fixSwappedPlayerNames.js --apply     # write corrections
 */

const path = require('path');
const Database = require('better-sqlite3');
const { playerNamesMatch } = require('../src/utils/helpers');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '../data/tennis-bot.db');
const db = new Database(DB_PATH);
db.pragma('busy_timeout = 10000');

const rows = db.prepare(`
  SELECT b.id, b.bet_id, b.player_key, b.player_name,
         m.match_name, m.player_a_name, m.player_b_name
  FROM bets b
  JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE b.player_key IN ('A','B')
    AND b.player_name IS NOT NULL AND b.player_name <> ''
    AND m.player_a_name IS NOT NULL AND m.player_b_name IS NOT NULL
`).all();

const fixes = [];
for (const r of rows) {
  const ownName = r.player_key === 'A' ? r.player_a_name : r.player_b_name;
  const oppName = r.player_key === 'A' ? r.player_b_name : r.player_a_name;
  const matchesOwn = playerNamesMatch(r.player_name, ownName);
  const matchesOpp = playerNamesMatch(r.player_name, oppName);
  // Swapped: looks like the other player and NOT like its own key's player.
  if (!matchesOwn && matchesOpp) {
    fixes.push({ ...r, ownName });
  }
}

console.log(`Bets examined            : ${rows.length}`);
console.log(`Swapped player_name found: ${fixes.length}\n`);
for (const f of fixes) {
  console.log(`bet=${f.bet_id}  ${f.match_name}  key=${f.player_key}  "${f.player_name}" -> "${f.ownName}"`);
}

if (!fixes.length) { console.log('\nNothing to correct.'); db.close(); process.exit(0); }

if (!APPLY) {
  console.log('\nDRY RUN — no rows written. Re-run with --apply to commit.');
  db.close();
  process.exit(0);
}

const upd = db.prepare(`UPDATE bets SET player_name = ? WHERE id = ?`);
const tx = db.transaction(list => { for (const f of list) upd.run(f.ownName, f.id); });
tx(fixes);
console.log(`\nAPPLIED ${fixes.length} corrections.`);
db.close();
