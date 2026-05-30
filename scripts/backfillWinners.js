'use strict';

/**
 * Backfill markets.winner for resolved matches where it was left NULL but
 * final_sets contains a decisive best-of-3 result (a player won 2 completed
 * sets). Pure metadata repair — settlement already copes via final_sets, this
 * just fills the winner column so reporting / winner lookups are complete.
 *
 * Only writes when final_sets yields a clear 2-set winner; markets with no
 * decisive result (abandoned / walkover / still-live) are left NULL.
 *
 *   node scripts/backfillWinners.js            # dry run (report only)
 *   node scripts/backfillWinners.js --apply     # write winners
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '../data/tennis-bot.db');
const db = new Database(DB_PATH);
db.pragma('busy_timeout = 10000');

function isSetComplete(set) {
  if (!set) return false;
  if (set.playerA === 6 && set.playerB === 6) return false;
  const aWon = (set.playerA >= 6 && set.playerA - set.playerB >= 2) || set.playerA === 7;
  const bWon = (set.playerB >= 6 && set.playerB - set.playerA >= 2) || set.playerB === 7;
  return aWon || bWon;
}

function winnerFromFinalSets(finalSetsJson) {
  let arr;
  try { arr = JSON.parse(finalSetsJson || '[]'); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  let a = 0, b = 0;
  for (const pair of arr) {
    // final_sets is stored as [{playerA,playerB},...]; tolerate [[a,b],...] too.
    const s = Array.isArray(pair)
      ? { playerA: pair[0] ?? 0, playerB: pair[1] ?? 0 }
      : { playerA: pair.playerA ?? 0, playerB: pair.playerB ?? 0 };
    if (!isSetComplete(s)) continue;
    if (s.playerA > s.playerB) a++; else if (s.playerB > s.playerA) b++;
  }
  // SAFE subset only: a clean best-of-3 result (winner took exactly 2 sets,
  // <=3 completed total). Best-of-5 (GS) and any ambiguous/partial result is
  // left NULL — first-to-2 logic would misread a 5-setter, and writing a wrong
  // winner is worse than leaving it blank. The bot blocks best-of-5 anyway.
  const total = a + b;
  if (total > 3) return null;
  if (a === 2 && a > b) return 'A';
  if (b === 2 && b > a) return 'B';
  return null;
}

const rows = db.prepare(`
  SELECT betfair_market_id, match_name, final_sets
  FROM markets
  WHERE (winner IS NULL OR winner = '')
    AND final_sets IS NOT NULL AND final_sets <> '' AND final_sets <> '[]'
`).all();

const fixes = [];
let indecisive = 0;
for (const r of rows) {
  const w = winnerFromFinalSets(r.final_sets);
  if (!w) { indecisive++; continue; }
  fixes.push({ ...r, winner: w });
}

console.log(`Markets with NULL winner + final_sets : ${rows.length}`);
console.log(`Indecisive (left NULL)                : ${indecisive}`);
console.log(`Backfillable                          : ${fixes.length}\n`);
for (const f of fixes.slice(0, 30)) {
  console.log(`${f.betfair_market_id}  ${f.match_name}  -> winner=${f.winner}  [${f.final_sets}]`);
}
if (fixes.length > 30) console.log(`... and ${fixes.length - 30} more`);

if (!fixes.length) { console.log('\nNothing to backfill.'); db.close(); process.exit(0); }

if (!APPLY) {
  console.log('\nDRY RUN — no rows written. Re-run with --apply to commit.');
  db.close();
  process.exit(0);
}

const upd = db.prepare(`UPDATE markets SET winner = ? WHERE betfair_market_id = ?`);
const tx = db.transaction(list => { for (const f of list) upd.run(f.winner, f.betfair_market_id); });
tx(fixes);
console.log(`\nAPPLIED ${fixes.length} winner backfills.`);
db.close();
