'use strict';

/**
 * One-off corrective pass for DRY bets that were settled by the old logic before
 * the match actually finished (settling on a transient/mid-match state, sometimes
 * on the wrong side). Recomputes each settled DRY bet's outcome from the AUTHORITATIVE
 * final result and rewrites settlement_type + pnl where they disagree.
 *
 * Winner source, in order:
 *   1. completed best-of-3 set result from markets.final_sets (2 sets won), else
 *   2. markets.winner (set at true match close).
 * Bets whose market has neither a decisive final_sets nor a winner are left alone.
 *
 * SAFE BY DEFAULT: prints what it would change and writes nothing.
 * Pass --apply to actually update the rows.
 *
 *   node scripts/resettleDryBets.js            # dry run (report only)
 *   node scripts/resettleDryBets.js --apply    # write corrections
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB_PATH = path.join(__dirname, '../data/tennis-bot.db');
const db = new Database(DB_PATH);
db.pragma('busy_timeout = 10000');   // wait out the running bot's writes (WAL)

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
    const s = { playerA: pair[0] ?? 0, playerB: pair[1] ?? 0 };
    if (!isSetComplete(s)) continue;
    if (s.playerA > s.playerB) a++; else if (s.playerB > s.playerA) b++;
  }
  if (a >= 2) return 'A';
  if (b >= 2) return 'B';
  return null;
}

const round2 = n => Math.round(n * 100) / 100;

const rows = db.prepare(`
  SELECT b.id, b.bet_id, b.player_key, b.player_name, b.side, b.actual_odds, b.requested_odds,
         b.stake, b.settlement_type, b.pnl,
         m.match_name, m.final_sets, m.winner
  FROM bets b
  JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE b.settlement_type IN ('DRY_WIN','DRY_LOSS')
`).all();

const fixes = [];
let undecidable = 0;

for (const r of rows) {
  const winner = winnerFromFinalSets(r.final_sets) || (r.winner === 'A' || r.winner === 'B' ? r.winner : null);
  if (!winner) { undecidable++; continue; }

  const odds  = r.actual_odds || r.requested_odds;
  const stake = r.stake;
  if (!odds || !stake) { undecidable++; continue; }

  const betWon = (r.side === 'BACK' && r.player_key === winner) ||
                 (r.side === 'LAY'  && r.player_key !== winner);
  const newType = betWon ? 'DRY_WIN' : 'DRY_LOSS';
  const newPnl  = round2(betWon
    ? (r.side === 'BACK' ? stake * (odds - 1) : stake)
    : (r.side === 'BACK' ? -stake : -(stake * (odds - 1))));

  const typeChanged = newType !== r.settlement_type;
  const pnlChanged  = Math.abs((r.pnl ?? 0) - newPnl) > 0.005;
  if (typeChanged || pnlChanged) {
    fixes.push({ ...r, winner, newType, newPnl, typeChanged });
  }
}

console.log(`Settled DRY bets examined : ${rows.length}`);
console.log(`Undecidable (skipped)     : ${undecidable}`);
console.log(`Corrections needed        : ${fixes.length}`);
console.log(`Of which flipped W<->L    : ${fixes.filter(f => f.typeChanged).length}`);
console.log('');
for (const f of fixes) {
  console.log(`${f.typeChanged ? 'FLIP' : 'pnl '}  bet=${f.bet_id}  ${f.match_name}  ${f.side}/${f.player_key} @${f.actual_odds || f.requested_odds}` +
              `  ${f.settlement_type}(${f.pnl}) -> ${f.newType}(${f.newPnl})  [winner=${f.winner}]`);
}

if (!fixes.length) { console.log('\nNothing to correct.'); db.close(); process.exit(0); }

if (!APPLY) {
  console.log('\nDRY RUN — no rows written. Re-run with --apply to commit these corrections.');
  db.close();
  process.exit(0);
}

const upd = db.prepare(`UPDATE bets SET settlement_type = ?, pnl = ? WHERE id = ?`);
const tx = db.transaction(list => { for (const f of list) upd.run(f.newType, f.newPnl, f.id); });
tx(fixes);
console.log(`\nAPPLIED ${fixes.length} corrections.`);
db.close();
