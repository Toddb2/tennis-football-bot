'use strict';

/**
 * Make reversed markets fully title-consistent with their (already-reversed) bets.
 *
 * After reverseMisSidedBets.js moved the bets to title convention, the MARKET fields
 * (winner, final_sets, runner ids) for those markets were still in Betfair runner
 * order — so a settlement recompute (player_key vs markets.winner) disagrees. This
 * detects such markets self-correctingly: a market is reversed iff its settled bets
 * are INCONSISTENT with the current winner but CONSISTENT with the flipped winner.
 * For each, it flips winner (A<->B), swaps final_sets, and swaps runner ids.
 * Non-reversed markets (already consistent) are left untouched.
 *
 *   node scripts/fixReversedMarketsToTitle.js          # dry run
 *   node scripts/fixReversedMarketsToTitle.js --apply
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(__dirname, '../data/tennis-bot.db'));
db.pragma('busy_timeout = 10000');
const flipWinner = w => (w === 'A' ? 'B' : w === 'B' ? 'A' : w);
const won = (side, key, winner) => (side === 'BACK' && key === winner) || (side === 'LAY' && key !== winner);
const expected = (side, key, winner) => won(side, key, winner) ? 'DRY_WIN' : 'DRY_LOSS';

function swapFinalSets(json) {
  let arr; try { arr = JSON.parse(json || '[]'); } catch { return json; }
  if (!Array.isArray(arr)) return json;
  const swapped = arr.map(s => Array.isArray(s)
    ? [s[1], s[0]]
    : { ...s, playerA: s.playerB, playerB: s.playerA });
  return JSON.stringify(swapped);
}

const markets = db.prepare(`
  SELECT betfair_market_id, match_name, winner, final_sets, runner_id_a, runner_id_b
  FROM markets WHERE winner IN ('A','B')
`).all();
const betsFor = db.prepare(`
  SELECT player_key, side, settlement_type FROM bets
  WHERE betfair_market_id = ? AND settlement_type IN ('DRY_WIN','DRY_LOSS') AND player_key IN ('A','B')
`);

const fixes = [];
for (const m of markets) {
  const bets = betsFor.all(m.betfair_market_id);
  if (!bets.length) continue;
  const misCur  = bets.filter(b => expected(b.side, b.player_key, m.winner)            !== b.settlement_type).length;
  const misFlip = bets.filter(b => expected(b.side, b.player_key, flipWinner(m.winner)) !== b.settlement_type).length;
  if (misCur > 0 && misFlip === 0) fixes.push(m);
}

console.log(`Markets with settled bets + winner : ${markets.length}`);
console.log(`Reversed markets to flip           : ${fixes.length}\n`);
for (const f of fixes) console.log(`  ${f.match_name}  winner ${f.winner}->${flipWinner(f.winner)}`);

if (!fixes.length) { console.log('\nNothing to flip.'); db.close(); process.exit(0); }
if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to write.'); db.close(); process.exit(0); }

const upd = db.prepare(`UPDATE markets SET winner = ?, final_sets = ?, runner_id_a = ?, runner_id_b = ? WHERE betfair_market_id = ?`);
const tx = db.transaction(list => {
  for (const f of list) upd.run(flipWinner(f.winner), swapFinalSets(f.final_sets), f.runner_id_b, f.runner_id_a, f.betfair_market_id);
});
tx(fixes);
console.log(`\nAPPLIED — flipped ${fixes.length} markets to title order.`);
db.close();
