const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });
const market = '1.258207552';

console.log('=== Set transitions in this match ===');
const snaps = db.prepare(`
  SELECT ts, player_a_back, player_b_back, sets, current_game
  FROM market_snapshots
  WHERE betfair_market_id = ?
    AND sets IS NOT NULL
  ORDER BY ts
`).all(market);

let prevSig = '';
const transitions = [];
for (const s of snaps) {
  let parsed; try { parsed = JSON.parse(s.sets); } catch (_) { continue; }
  if (!Array.isArray(parsed)) continue;
  const sig = parsed.map(x => `${x.playerA}-${x.playerB}`).join('|');
  if (sig !== prevSig) {
    transitions.push({ ts: s.ts, sets: sig, A: s.player_a_back, B: s.player_b_back });
    prevSig = sig;
  }
}
console.log('  transitions:', transitions.length);
console.log('\n=== Score progression with odds ===');
for (const t of transitions) console.log(`  ${t.ts}  ${t.sets.padEnd(30)}  A=${t.A}  B=${t.B}`);

console.log('\n=== bet #149 (Strat1h LAY P1 @ 1.36) — what hedge looked like at key moments ===');
const layStake = 2;
const layOdds  = 1.36;
const liability = layStake * (layOdds - 1);  // 0.72
console.log(`  Lay £${layStake} P1 @ ${layOdds}  → liability £${liability.toFixed(2)}, win-payoff £${layStake}\n`);

// Hedge: BACK P1 at price Y with stake X → locked profit = layStake - X
// For balanced hedge across outcomes: X = (layStake * layOdds) / Y
function hedgeMath(layStake, layOdds, hedgeOdds) {
  const hedgeStake = (layStake * layOdds) / hedgeOdds;
  const locked     = layStake - hedgeStake;
  return { hedgeStake, locked };
}

// Find moments where set 2 actually ended (P2 wins set 2)
console.log('  Candidate hedge moments after P1 lost set 2:');
let inSet2 = true;
for (const t of transitions) {
  // sets[1] = [a, b]. set 2 ends when one of them reaches 6+ with lead, or wins tiebreak.
  // Look for the first appearance of [a<7,b>=7] or [a<6,b=6] etc — easier: when 3rd set sigs appear
  const parts = t.sets.split('|');
  // 3rd set started → set 2 just ended
  if (parts.length === 3) {
    if (inSet2) {
      console.log(`  >> set 2 ended at ${t.ts}, sets so far: ${t.sets}`);
      const h = hedgeMath(layStake, layOdds, t.A);
      console.log(`     P1 back odds = ${t.A} → hedge BACK £${h.hedgeStake.toFixed(2)} → locked profit £${h.locked.toFixed(2)}`);
      inSet2 = false;
    }
  }
}
