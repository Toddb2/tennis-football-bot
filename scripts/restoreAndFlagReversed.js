'use strict';

/**
 * Historical correction for bets affected by the Betfair runner-order bug, where a
 * StratNP1/P2 bet landed on the OPPOSITE player to the title's P1/P2 (because the
 * stream delivered the runner array reversed vs the match title).
 *
 * "Relabel truthfully + flag":
 *   1. Restore the 5 bets whose player_name an earlier pass over-corrected to title
 *      order — back to the player the bet ACTUALLY landed on (the runner name).
 *   2. Flag (side_reversed = 1) every bet whose player_name matches the OPPOSITE
 *      title slot to its player_key — i.e. the bet ran on the wrong side vs the
 *      strategy's P1/P2 intent. Settlement (player_key vs winner, both runner-order)
 *      already grades the actual runner correctly, so pnl/settlement are left as-is.
 *
 *   node scripts/restoreAndFlagReversed.js          # dry run
 *   node scripts/restoreAndFlagReversed.js --apply   # write
 */

const path = require('path');
const Database = require('better-sqlite3');
const { playerNamesMatch } = require('../src/utils/helpers');

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(__dirname, '../data/tennis-bot.db'));
db.pragma('busy_timeout = 10000');
try { db.exec(`ALTER TABLE bets ADD COLUMN side_reversed INTEGER DEFAULT 0`); } catch (_) {}

// Truthful (runner-order) names for the 5 bets a prior pass relabelled to title order.
const RESTORE = {
  'DRY-1779906698978-6792': 'Marina Bassols Ribera',
  'DRY-1779906699080-2974': 'Mirra Andreeva',
  'DRY-1779963250050-9141': 'Oleksandra Oliynykova',
  'DRY-1779963250214-5140': 'Oleksandra Oliynykova',
  'DRY-1779973322172-1461': 'Maja Chwalinska',
};

const restoreStmt = db.prepare(`UPDATE bets SET player_name = ? WHERE bet_id = ? AND ? <> ''`);
const flagStmt    = db.prepare(`UPDATE bets SET side_reversed = 1 WHERE id = ?`);

const run = db.transaction(() => {
  let restored = 0;
  for (const [betId, name] of Object.entries(RESTORE)) {
    const info = restoreStmt.run(name, betId, name);
    if (info.changes) restored++;
  }
  return restored;
});

// Detect reversed bets (after restore) by name-vs-title-slot.
function detect() {
  const rows = db.prepare(`
    SELECT b.id, b.bet_id, b.strategy_name, b.player_key, b.player_name,
           m.match_name, m.player_a_name, m.player_b_name
    FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id
    WHERE b.player_key IN ('A','B') AND b.player_name <> ''
      AND m.player_a_name <> '' AND m.player_b_name <> ''
  `).all();
  return rows.filter(r => {
    const own = r.player_key === 'A' ? r.player_a_name : r.player_b_name;
    const opp = r.player_key === 'A' ? r.player_b_name : r.player_a_name;
    return !playerNamesMatch(r.player_name, own) && playerNamesMatch(r.player_name, opp);
  });
}

if (!APPLY) {
  // Preview: show what restore + detect WOULD do (without writing). We can't see
  // post-restore state in a dry run for the 5, so report both sets.
  console.log('Would restore names for bet_ids:', Object.keys(RESTORE).join(', '));
  const rev = detect();
  console.log(`Currently-detectable reversed bets (pre-restore): ${rev.length}`);
  rev.forEach(r => console.log(`  ${r.strategy_name}  ${r.match_name}  key=${r.player_key}  name=${r.player_name}`));
  console.log('\nDRY RUN — re-run with --apply to restore names + flag all reversed.');
  db.close();
  process.exit(0);
}

const restored = run();
const rev = detect();              // now includes the restored 5
const flagTx = db.transaction(list => { for (const r of list) flagStmt.run(r.id); });
flagTx(rev);

console.log(`Restored ${restored} over-corrected names.`);
console.log(`Flagged ${rev.length} reversed bets (side_reversed = 1):`);
rev.forEach(r => console.log(`  ${r.strategy_name}  ${r.match_name}  key=${r.player_key}  name=${r.player_name}`));
db.close();
