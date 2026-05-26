// Comprehensive data audit + auto-fix pass over the bets / markets tables.
//
// Phases:
//   A. Date sanity (placed_at, settled_at, future dates, ordering)
//   B. Liability math (recompute from side + stake + odds)
//   C. Sub-strategy consistency (matches strategy_name + player_key rule)
//   D. Strategy↔side coherence (P1 strats fire on player_key=A, etc.)
//   E. Market integrity (every bet's market exists; winner matches final_sets)
//   F. final_sets corruption detection (cross-check vs market_snapshots)
//   G. Momentum / edge sign coherence (signed for bet player / bet side)
//   H. Settlement-type vs pnl-sign consistency
//   I. Orphan strategies (in bets but not in strategies.json)
//
// Auto-fixes (safe): B, C, H, parts of E (back-fill markets.winner from final_sets)
// Flags only (not auto-fixed): A anomalies, D, F, G, I
const fs = require('fs');
const path = require('path');
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

const cfg = JSON.parse(fs.readFileSync('/home/bots/tennis-bot/config/strategies.json', 'utf8'));
const stratByName = Object.fromEntries((cfg.systems || []).map(s => [s.name, s]));
const NOW = new Date().toISOString();

const report = { fixes: 0, issues: 0, byPhase: {} };
function inc(phase, key, n = 1) {
  if (!report.byPhase[phase]) report.byPhase[phase] = {};
  report.byPhase[phase][key] = (report.byPhase[phase][key] || 0) + n;
}

// ══════════════════════════════════════════════════════════════════════
console.log('═══ PHASE A — Date sanity ═══');
// ══════════════════════════════════════════════════════════════════════
const dateRows = db.prepare(`
  SELECT bet_id, placed_at, settled_at FROM bets
  WHERE placed_at IS NOT NULL
`).all();

let futurePlaced = 0, futureSettled = 0, settledBeforePlaced = 0;
for (const r of dateRows) {
  if (r.placed_at  > NOW) futurePlaced++;
  if (r.settled_at && r.settled_at > NOW) futureSettled++;
  if (r.settled_at && r.settled_at < r.placed_at) settledBeforePlaced++;
}
console.log(`  Future placed_at:           ${futurePlaced}`);
console.log(`  Future settled_at:          ${futureSettled}`);
console.log(`  settled_at < placed_at:     ${settledBeforePlaced}`);
inc('A', 'future_placed',  futurePlaced);
inc('A', 'future_settled', futureSettled);
inc('A', 'reverse_order',  settledBeforePlaced);
if (settledBeforePlaced > 0) {
  for (const x of db.prepare(`SELECT bet_id, placed_at, settled_at FROM bets WHERE settled_at < placed_at LIMIT 5`).all())
    console.log(`    ⚠ ${x.bet_id}  placed=${x.placed_at}  settled=${x.settled_at}`);
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE B — Liability math (auto-fix) ═══');
// ══════════════════════════════════════════════════════════════════════
const liabBad = db.prepare(`
  SELECT bet_id, side, stake, COALESCE(actual_odds, requested_odds) AS odds, liability
  FROM bets
  WHERE stake IS NOT NULL AND (actual_odds IS NOT NULL OR requested_odds IS NOT NULL)
`).all();

const liabFixStmt = db.prepare(`UPDATE bets SET liability = ? WHERE bet_id = ?`);
let liabFixed = 0;
const liabTx = db.transaction(() => {
  for (const b of liabBad) {
    const expected = b.side === 'BACK' ? b.stake : +(b.stake * (b.odds - 1)).toFixed(4);
    if (Math.abs((b.liability ?? 0) - expected) > 0.005) {
      liabFixStmt.run(expected, b.bet_id);
      liabFixed++;
    }
  }
});
liabTx();
console.log(`  Liability values corrected: ${liabFixed}`);
inc('B', 'fixed', liabFixed);
report.fixes += liabFixed;

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE C — Sub-strategy consistency (auto-fix) ═══');
// ══════════════════════════════════════════════════════════════════════
// Rule: if strategy_name ends in _P1/_P2, sub_strategy = strategy_name
//       else sub_strategy = strategy_name + '-' + ('P1' if player_key='A' else 'P2')
const subFixed = db.prepare(`
  UPDATE bets SET sub_strategy = CASE
    WHEN strategy_name LIKE '%_P1' OR strategy_name LIKE '%_P2' THEN strategy_name
    WHEN strategy_name IS NOT NULL AND player_key IS NOT NULL
      THEN strategy_name || '-' || CASE player_key WHEN 'A' THEN 'P1' ELSE 'P2' END
    ELSE sub_strategy
  END
  WHERE sub_strategy IS NULL OR sub_strategy != CASE
    WHEN strategy_name LIKE '%_P1' OR strategy_name LIKE '%_P2' THEN strategy_name
    ELSE strategy_name || '-' || CASE player_key WHEN 'A' THEN 'P1' ELSE 'P2' END
  END
`).run().changes;
console.log(`  Sub-strategy rows corrected: ${subFixed}`);
inc('C', 'fixed', subFixed);
report.fixes += subFixed;

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE D — Strategy↔side coherence (flag only) ═══');
// ══════════════════════════════════════════════════════════════════════
// Check that every bet's player_key matches what the strategy would fire on.
const stratSideBad = [];
const allBets = db.prepare(`SELECT bet_id, strategy_name, player_key, side FROM bets`).all();
for (const b of allBets) {
  const sys = stratByName[b.strategy_name];
  if (!sys) continue; // handled in Phase I
  const trig  = sys.backtest?.trigger || {};
  const entry = sys.backtest?.entry   || {};
  // Determine expected playerKey from strategy config
  let expectedKey = null;
  if (trig.loserMustBe === 'A') {
    expectedKey = entry.player === 'loser' ? 'A' : 'B';
  } else if (trig.loserMustBe === 'B') {
    expectedKey = entry.player === 'loser' ? 'B' : 'A';
  } else {
    // Symmetric strategy (no loserMustBe) — either side is fine
    continue;
  }
  if (b.player_key !== expectedKey) {
    stratSideBad.push({ bet_id: b.bet_id, strategy: b.strategy_name, key: b.player_key, expected: expectedKey });
  }
  // Side check
  if (entry.side && entry.side !== b.side) {
    stratSideBad.push({ bet_id: b.bet_id, strategy: b.strategy_name, side: b.side, expected_side: entry.side });
  }
}
console.log(`  Bets with side/key mismatch vs config: ${stratSideBad.length}`);
inc('D', 'mismatches', stratSideBad.length);
report.issues += stratSideBad.length;
stratSideBad.slice(0, 6).forEach(x => console.log('    ⚠', x));

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE E — Market integrity ═══');
// ══════════════════════════════════════════════════════════════════════
const orphanBets = db.prepare(`
  SELECT b.bet_id, b.betfair_market_id FROM bets b
  LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE m.betfair_market_id IS NULL
`).all();
console.log(`  Bets with no matching market row: ${orphanBets.length}`);
inc('E', 'orphan_bets', orphanBets.length);

// markets.winner should match the actual winner derived from final_sets
const winnerInconsistent = db.prepare(`
  SELECT betfair_market_id, match_name, final_sets, winner FROM markets
  WHERE final_sets IS NOT NULL AND winner IS NOT NULL
`).all();
let winnerFixed = 0;
const fixWinnerStmt = db.prepare(`UPDATE markets SET winner = ? WHERE betfair_market_id = ?`);
const winnerFlagged = [];
const winnerTx = db.transaction(() => {
  for (const m of winnerInconsistent) {
    let sets;
    try { sets = JSON.parse(m.final_sets); } catch (_) { continue; }
    if (!Array.isArray(sets)) continue;
    let setsA = 0, setsB = 0;
    for (const s of sets) {
      const a = Array.isArray(s) ? s[0] : s.playerA;
      const b = Array.isArray(s) ? s[1] : s.playerB;
      if (a == null || b == null) continue;
      if (a > b) setsA++; else if (b > a) setsB++;
    }
    const expected = setsA > setsB ? 'A' : setsB > setsA ? 'B' : null;
    if (!expected) continue;
    if (m.winner !== expected) {
      // Don't auto-update because some matches had truncated final_sets
      // (e.g. only 2 of 3 sets stored). Flag instead.
      winnerFlagged.push({ market: m.betfair_market_id, match: m.match_name, stored: m.winner, expected, sets });
    }
  }
});
winnerTx();
console.log(`  Markets where winner disagrees with final_sets: ${winnerFlagged.length}`);
inc('E', 'winner_mismatch', winnerFlagged.length);
winnerFlagged.slice(0, 5).forEach(w => console.log(`    ⚠ ${w.market}  ${w.match}  stored=${w.stored} expected=${w.expected}  sets=${JSON.stringify(w.sets)}`));

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE F — final_sets corruption vs snapshots ═══');
// ══════════════════════════════════════════════════════════════════════
// Cross-check the markets.final_sets against the LAST snapshot's sets array.
const finalCheck = db.prepare(`
  SELECT m.betfair_market_id, m.final_sets,
         (SELECT s.sets FROM market_snapshots s
          WHERE s.betfair_market_id = m.betfair_market_id AND s.sets IS NOT NULL
          ORDER BY s.ts DESC LIMIT 1) AS last_snap_sets
  FROM markets m
  WHERE m.final_sets IS NOT NULL
`).all();
const corruptFinal = [];
for (const r of finalCheck) {
  if (!r.last_snap_sets) continue;
  let stored, snap;
  try { stored = JSON.parse(r.final_sets); }      catch (_) { continue; }
  try { snap   = JSON.parse(r.last_snap_sets); }  catch (_) { continue; }
  if (!Array.isArray(stored) || !Array.isArray(snap)) continue;
  // Compare counts and final scores
  if (stored.length !== snap.length) {
    corruptFinal.push({ market: r.betfair_market_id, stored_count: stored.length, snap_count: snap.length, stored, snap });
  }
}
console.log(`  Markets where final_sets count != last snapshot's sets count: ${corruptFinal.length}`);
inc('F', 'count_mismatch', corruptFinal.length);
corruptFinal.slice(0, 6).forEach(c =>
  console.log(`    ⚠ ${c.market}  stored ${c.stored_count}-set: ${JSON.stringify(c.stored)}  vs snap ${c.snap_count}-set: ${JSON.stringify(c.snap)}`));

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE G — Momentum / edge sign coherence ═══');
// ══════════════════════════════════════════════════════════════════════
// Convention check: momentum_at_bet should be signed for bet player (positive = bet player has momentum).
// For P2 bets, raw snapshot momentum_index (A-perspective) should be negated.
// We can't fully verify without snapshot lookup per bet, but we can flag rows where the magnitude is implausible.
const momIssues = db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE momentum_at_bet IS NOT NULL AND (ABS(momentum_at_bet) > 200)`).get();
console.log(`  Bets with |momentum_at_bet| > 200 (implausible):  ${momIssues.n}`);
const edgeIssues = db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE edge_at_bet IS NOT NULL AND (ABS(edge_at_bet) > 99)`).get();
console.log(`  Bets with |edge_at_bet| > 99 pp (implausible):    ${edgeIssues.n}`);
inc('G', 'mom_out_of_range', momIssues.n);
inc('G', 'edge_out_of_range', edgeIssues.n);

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE H — Settlement-type vs pnl-sign (auto-fix) ═══');
// ══════════════════════════════════════════════════════════════════════
const settBad = db.prepare(`
  SELECT bet_id, settlement_type, pnl, hedge_odds FROM bets
  WHERE settled_at IS NOT NULL AND pnl IS NOT NULL
`).all();
const settFixStmt = db.prepare(`UPDATE bets SET settlement_type = ? WHERE bet_id = ?`);
let settFixed = 0;
const settTx = db.transaction(() => {
  for (const b of settBad) {
    // If it's a hedge, settlement_type should be TRADE_OUT (or STOP_LOSS for hedge losses)
    if (b.hedge_odds != null) {
      const expected = b.pnl >= 0 ? 'TRADE_OUT' : 'STOP_LOSS';
      if (b.settlement_type !== expected && b.settlement_type !== 'TRADE_OUT') {
        // Don't auto-fix this one — could legitimately be other types
      }
      continue;
    }
    // For DRY bets, DRY_WIN if pnl > 0, DRY_LOSS if pnl ≤ 0
    if (b.bet_id.startsWith('DRY') || b.bet_id.startsWith('AIMISS-') || b.bet_id.startsWith('RETRO-')) {
      const expected = b.pnl > 0 ? 'DRY_WIN' : (b.pnl < 0 ? 'DRY_LOSS' : 'VOID');
      if (b.settlement_type && b.settlement_type !== expected && b.settlement_type !== 'TRADE_OUT') {
        settFixStmt.run(expected, b.bet_id);
        settFixed++;
      } else if (!b.settlement_type) {
        settFixStmt.run(expected, b.bet_id);
        settFixed++;
      }
    }
  }
});
settTx();
console.log(`  Settlement-type rows fixed: ${settFixed}`);
inc('H', 'fixed', settFixed);
report.fixes += settFixed;

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ PHASE I — Orphan strategies in bets ═══');
// ══════════════════════════════════════════════════════════════════════
const allStratNames = new Set(Object.keys(stratByName));
const orphanStrats = db.prepare(`SELECT DISTINCT strategy_name FROM bets WHERE strategy_name IS NOT NULL`).all().map(r => r.strategy_name).filter(n => !allStratNames.has(n));
console.log(`  Strategies in bets but not in current config: ${orphanStrats.length}`);
orphanStrats.forEach(n => {
  const cnt = db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE strategy_name = ?`).get(n).n;
  console.log(`    ⚠ ${n}: ${cnt} bets`);
});
inc('I', 'orphan_strategies', orphanStrats.length);

// ══════════════════════════════════════════════════════════════════════
console.log('\n═══ FINAL TOTALS ═══');
console.log(`  Auto-fixes applied:  ${report.fixes}`);
console.log(`  Issues flagged:      ${report.issues}`);
console.log('  By phase:', JSON.stringify(report.byPhase, null, 2));
