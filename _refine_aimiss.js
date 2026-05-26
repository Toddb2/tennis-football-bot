// Refine AIMISS-* bets using actual market_snapshots data:
//   - replace AI's estimated odds with the real back/lay odds at the moment
//     the relevant set ended on our Betfair stream
//   - replace momentum_at_bet & edge_at_bet with the snapshot's real values
//   - re-compute pnl with the corrected odds + known final result
//   - re-anchor placed_at to the real trigger timestamp
//   - leave bets alone where the snapshot history was pruned / market missing.
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

const aimiss = db.prepare(`
  SELECT bet_id, betfair_market_id, strategy_name, side, player_key,
         requested_odds, stake, reason, settled_at
  FROM bets WHERE bet_id LIKE 'AIMISS-%'
`).all();
console.log('AIMISS rows:', aimiss.length);

const snapsStmt = db.prepare(`
  SELECT ts, player_a_back, player_b_back, sets, momentum_index, edge_a, edge_b
  FROM market_snapshots
  WHERE betfair_market_id = ? AND sets IS NOT NULL
  ORDER BY ts
`);

const marketStmt = db.prepare(`SELECT winner, final_sets FROM markets WHERE betfair_market_id = ?`);

const updateStmt = db.prepare(`
  UPDATE bets
  SET requested_odds  = @odds,
      actual_odds     = @odds,
      liability       = @liability,
      pnl             = @pnl,
      settlement_type = @settlement,
      placed_at       = @placedAt,
      momentum_at_bet = @momentum,
      edge_at_bet     = @edge,
      reason          = @reason
  WHERE bet_id = @betId
`);

let refined = 0, skipped = 0, oddsMoved = 0, pnlSwung = 0;
let totalSwingPnl = 0;
const issues = { noMarket: 0, noSnapshots: 0, noTransition: 0, noPriceAtMoment: 0 };

for (const b of aimiss) {
  const setMatch = /set (\d+) complete (\d+-\d+)/i.exec(b.reason || '');
  if (!setMatch) { skipped++; continue; }
  const targetSet = parseInt(setMatch[1], 10);   // 1, 2 or 3
  const [tA, tB]  = setMatch[2].split('-').map(Number);

  const m = marketStmt.get(b.betfair_market_id);
  if (!m || !m.winner || !m.final_sets) { skipped++; issues.noMarket++; continue; }

  const snaps = snapsStmt.all(b.betfair_market_id);
  if (!snaps.length) { skipped++; issues.noSnapshots++; continue; }

  // Locate the first snapshot where the target set has just become complete with the
  // specified score (no later set has started yet, or it just transitioned).
  let triggerSnap = null;
  for (const s of snaps) {
    let sets; try { sets = JSON.parse(s.sets); } catch (_) { continue; }
    if (!Array.isArray(sets)) continue;
    if (sets.length < targetSet) continue;
    const tgt = sets[targetSet - 1];
    if (!tgt || tgt.playerA !== tA || tgt.playerB !== tB) continue;
    // Ensure the set is "complete" (one player ≥6 with a margin or a tiebreak)
    const a = tgt.playerA, c = tgt.playerB;
    const setComplete = (a >= 6 && a - c >= 2) || (c >= 6 && c - a >= 2) || a === 7 || c === 7;
    if (!setComplete) continue;
    triggerSnap = s;
    break;
  }
  if (!triggerSnap) { skipped++; issues.noTransition++; continue; }

  // Real odds for the bet player at the moment of the trigger.
  const realOdds = b.player_key === 'A' ? triggerSnap.player_a_back : triggerSnap.player_b_back;
  if (realOdds == null || realOdds < 1.01) { skipped++; issues.noPriceAtMoment++; continue; }

  // Re-compute pnl with the real odds + known final winner.
  const betWon = (b.side === 'BACK' && m.winner === b.player_key)
              || (b.side === 'LAY'  && m.winner !== b.player_key);
  const liability = b.side === 'BACK' ? b.stake : +(b.stake * (realOdds - 1)).toFixed(4);
  const newPnl = betWon
    ? (b.side === 'BACK' ? +(b.stake * (realOdds - 1)).toFixed(2) : +b.stake.toFixed(2))
    : (b.side === 'BACK' ? -b.stake : -liability);
  const settlement = betWon ? 'DRY_WIN' : 'DRY_LOSS';

  // Real momentum & edge from the snapshot (signed for bet player)
  const rawMom = triggerSnap.momentum_index;
  const momForBet = (rawMom != null)
    ? (b.player_key === 'B' ? -rawMom : rawMom)
    : null;
  const rawEdge = b.player_key === 'A' ? triggerSnap.edge_a : triggerSnap.edge_b;
  const edgeForBet = (rawEdge != null)
    ? (b.side === 'BACK' ? rawEdge : -rawEdge)
    : null;

  const newReason = `[AIMISS refined w/ real snap] strat=${b.strategy_name} set${targetSet} ${tA}-${tB} at ${triggerSnap.ts} odds=${realOdds}`;

  // Track movement
  const oddsDelta = Math.abs((realOdds - b.requested_odds) / b.requested_odds);
  if (oddsDelta > 0.02) oddsMoved++;
  const oldPnl = db.prepare(`SELECT pnl FROM bets WHERE bet_id = ?`).get(b.bet_id)?.pnl ?? 0;
  if (Math.sign(oldPnl) !== Math.sign(newPnl)) pnlSwung++;
  totalSwingPnl += newPnl - oldPnl;

  updateStmt.run({
    betId:      b.bet_id,
    odds:       realOdds,
    liability,
    pnl:        newPnl,
    settlement,
    placedAt:   triggerSnap.ts,
    momentum:   momForBet,
    edge:       edgeForBet,
    reason:     newReason,
  });
  refined++;
}

console.log('\n=== Refinement summary ===');
console.log('Refined:                ', refined);
console.log('Skipped (no usable snap):', skipped);
console.log('  market not in DB:     ', issues.noMarket);
console.log('  no snapshots:         ', issues.noSnapshots);
console.log('  no matching transition:', issues.noTransition);
console.log('  no price at moment:   ', issues.noPriceAtMoment);
console.log('Bets where odds moved >2%:', oddsMoved);
console.log('Bets where pnl sign flipped:', pnlSwung);
console.log('Total net PnL change:   £' + totalSwingPnl.toFixed(2));

console.log('\n=== Refined per-strategy summary ===');
for (const r of db.prepare(`
  SELECT strategy_name, COUNT(*) AS n,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(AVG(requested_odds), 2) AS avg_odds,
    ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
  FROM bets WHERE bet_id LIKE 'AIMISS-%'
  GROUP BY strategy_name ORDER BY pnl DESC
`).all()) console.log(' ', r);
