'use strict';

/**
 * Reverse bets that landed on the OPPOSITE player to their strategy's P1/P2 intent
 * (the Betfair runner-order bug). Each flagged bet (side_reversed = 1) is moved to
 * the intended TITLE-slot player (player_key A -> player_a_name, B -> player_b_name),
 * repriced at THAT player's market back price at bet time (from market_snapshots),
 * its result flipped (the other player in a 2-player match), pnl recomputed from the
 * new odds, and the flag cleared. Unsettled/in-play bets keep null settlement and will
 * settle normally later (now title-aligned). player_key is unchanged — after the fix
 * A = title-first, so keeping the key makes P1=title-A, P2=title-B.
 *
 *   node scripts/reverseMisSidedBets.js          # dry run
 *   node scripts/reverseMisSidedBets.js --apply
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const db = new Database(path.join(__dirname, '../data/tennis-bot.db'));
db.pragma('busy_timeout = 10000');
const round2 = n => Math.round(n * 100) / 100;
const flip = t => ({ DRY_WIN: 'DRY_LOSS', DRY_LOSS: 'DRY_WIN', WIN: 'LOSS', LOSS: 'WIN' }[t] || t || null);

const bets = db.prepare(`
  SELECT b.id, b.bet_id, b.strategy_name, b.player_key, b.player_name, b.side,
         b.requested_odds, b.actual_odds, b.stake, b.settlement_type, b.pnl, b.placed_at,
         b.betfair_market_id, m.match_name, m.player_a_name, m.player_b_name
  FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE b.side_reversed = 1
`).all();

const snap = db.prepare(`
  SELECT player_a_back, player_b_back FROM market_snapshots
  WHERE betfair_market_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1
`);

const plan = [];
for (const b of bets) {
  const s = snap.get(b.betfair_market_id, b.placed_at) || {};
  // Title-slot player for this key, and that player's price = the OPPOSITE snapshot
  // slot (the market was reversed, so title-A == runner-B and vice-versa).
  const newName = b.player_key === 'A' ? b.player_a_name : b.player_b_name;
  const newOdds = b.player_key === 'A' ? s.player_b_back : s.player_a_back;
  const newSettle = flip(b.settlement_type);
  let newPnl = b.pnl;
  if (!newSettle) { newPnl = null; }
  else if (newOdds) {
    const won = newSettle === 'DRY_WIN' || newSettle === 'WIN';
    newPnl = round2(b.side === 'LAY'
      ? (won ? b.stake : -(b.stake * (newOdds - 1)))
      : (won ? b.stake * (newOdds - 1) : -b.stake));
  }
  plan.push({ ...b, newName, newOdds, newSettle, newPnl });
}

console.log(`Reversing ${plan.length} mis-sided bets:\n`);
for (const p of plan) {
  console.log(`${p.strategy_name}  ${p.match_name}  key=${p.player_key}`);
  console.log(`   ${p.player_name} @${p.requested_odds} ${p.settlement_type ?? 'OPEN'}(${p.pnl ?? '-'})` +
              `  ->  ${p.newName} @${p.newOdds ?? '??'} ${p.newSettle ?? 'OPEN'}(${p.newPnl ?? '-'})`);
}

const missing = plan.filter(p => !p.newOdds && p.settlement_type);
if (missing.length) console.log(`\nWARNING: ${missing.length} settled bet(s) have no recoverable snapshot price — odds left unchanged.`);

if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to write.'); db.close(); process.exit(0); }

const upd = db.prepare(`
  UPDATE bets SET player_name = ?, requested_odds = ?, actual_odds = ?,
                  settlement_type = ?, pnl = ?, side_reversed = 0
  WHERE id = ?
`);
const tx = db.transaction(list => {
  for (const p of list) {
    const odds = p.newOdds ?? p.requested_odds;
    const actual = p.actual_odds != null ? (p.newOdds ?? p.actual_odds) : p.actual_odds;
    upd.run(p.newName, odds, actual, p.newSettle, p.newPnl, p.id);
  }
});
tx(plan);
console.log(`\nAPPLIED — reversed ${plan.length} bets, cleared side_reversed flag.`);
db.close();
