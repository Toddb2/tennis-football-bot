// Comprehensive validation + stress test of the bets data layer.
//   Stage 1 — rename Strat5/Strat6 bets to _P1/_P2 by player_key
//   Stage 2 — re-derive sub_strategy for everything
//   Stage 3 — verify pnl math against (side, odds, stake, outcome)
//   Stage 4 — check for duplicates again
//   Stage 5 — full analytics overview (the same data the dashboard renders)
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');

console.log('═══════════════════════════════════════════════════════════════════');
console.log(' STAGE 1 — Rename Strat5 / Strat6 bets to _P1 / _P2');
console.log('═══════════════════════════════════════════════════════════════════');
const tx1 = db.transaction(() => {
  for (const [oldN, newName] of [
    ['Strat5','Strat5_P1'], ['Strat5','Strat5_P2'],
    ['Strat6','Strat6_P1'], ['Strat6','Strat6_P2'],
  ]) {
    // skip — handled below by player_key
  }
  // Single statement using CASE on player_key
  const r1 = db.prepare(`
    UPDATE bets SET strategy_name = CASE player_key
      WHEN 'A' THEN 'Strat5_P1'
      WHEN 'B' THEN 'Strat5_P2'
      ELSE strategy_name
    END WHERE strategy_name = 'Strat5'
  `).run();
  const r2 = db.prepare(`
    UPDATE bets SET strategy_name = CASE player_key
      WHEN 'A' THEN 'Strat6_P1'
      WHEN 'B' THEN 'Strat6_P2'
      ELSE strategy_name
    END WHERE strategy_name = 'Strat6'
  `).run();
  const r3 = db.prepare(`UPDATE bet_rejections SET strategy_name = CASE WHEN strategy_name = 'Strat5' THEN 'Strat5_P1' WHEN strategy_name = 'Strat6' THEN 'Strat6_P1' ELSE strategy_name END WHERE strategy_name IN ('Strat5','Strat6')`).run();
  console.log(`  Strat5 bets renamed:    ${r1.changes}`);
  console.log(`  Strat6 bets renamed:    ${r2.changes}`);
  console.log(`  Rejections renamed:     ${r3.changes}`);
});
tx1();

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(' STAGE 2 — Re-derive sub_strategy for every bet');
console.log('═══════════════════════════════════════════════════════════════════');
const r = db.prepare(`
  UPDATE bets SET sub_strategy = CASE
    WHEN strategy_name LIKE '%_P1' OR strategy_name LIKE '%_P2' THEN strategy_name
    WHEN strategy_name IS NOT NULL AND player_key IS NOT NULL
      THEN strategy_name || '-' || CASE player_key WHEN 'A' THEN 'P1' ELSE 'P2' END
    ELSE sub_strategy
  END
`).run();
console.log(`  sub_strategy rewritten on ${r.changes} rows`);
console.log('  Distribution:');
for (const x of db.prepare(`SELECT strategy_name, sub_strategy, COUNT(*) AS n FROM bets GROUP BY strategy_name, sub_strategy ORDER BY n DESC`).all())
  console.log(`    ${x.strategy_name?.padEnd(12)} → ${x.sub_strategy?.padEnd(15)} ${x.n}`);

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(' STAGE 3 — Stress-test pnl math');
console.log('═══════════════════════════════════════════════════════════════════');
// For each settled bet, recompute the expected pnl from side + odds + stake +
// the actual outcome (winner from markets.winner). Flag any row where stored
// pnl differs from expected.
const settled = db.prepare(`
  SELECT b.bet_id, b.strategy_name, b.player_key, b.side, b.stake, b.liability,
         b.requested_odds, b.actual_odds, b.pnl, b.settlement_type, b.hedge_odds, m.winner
  FROM bets b
  LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE b.settled_at IS NOT NULL
`).all();

let mathBad = [], hedgedOk = 0, unknownWinner = 0;
for (const b of settled) {
  if (!b.winner || (b.winner !== 'A' && b.winner !== 'B')) { unknownWinner++; continue; }
  // Hedged bets aren't a straight win/loss — skip math check for these
  if (b.settlement_type === 'TRADE_OUT' || b.hedge_odds != null) { hedgedOk++; continue; }
  const odds  = b.actual_odds || b.requested_odds;
  const betWon = (b.side === 'BACK' && b.winner === b.player_key)
              || (b.side === 'LAY'  && b.winner !== b.player_key);
  const expected = betWon
    ? (b.side === 'BACK' ? +(b.stake * (odds - 1)).toFixed(2) : +b.stake.toFixed(2))
    : (b.side === 'BACK' ? -b.stake : -+(b.stake * (odds - 1)).toFixed(2));
  if (Math.abs((b.pnl ?? 0) - expected) > 0.02) {
    mathBad.push({ bet_id: b.bet_id, strat: b.strategy_name, side: b.side, key: b.player_key, odds, stake: b.stake, stored_pnl: b.pnl, expected_pnl: expected, winner: b.winner });
  }
}
console.log(`  Settled bets checked:           ${settled.length}`);
console.log(`  Hedged (skipped math check):    ${hedgedOk}`);
console.log(`  Unknown match winner (skipped): ${unknownWinner}`);
console.log(`  Math mismatches:                ${mathBad.length}`);
if (mathBad.length) {
  console.log('\n  First 8 mismatches:');
  mathBad.slice(0, 8).forEach(m => console.log('   ', m));
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(' STAGE 4 — Duplicate-bet check');
console.log('═══════════════════════════════════════════════════════════════════');
const dupExact = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT bet_id, COUNT(*) c FROM bets GROUP BY bet_id HAVING c > 1)`).get().n;
const dupLogical = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM bets WHERE strategy_name IS NOT NULL GROUP BY betfair_market_id, strategy_name, player_key, side HAVING COUNT(*) > 1)`).get().n;
console.log(`  exact bet_id dups:              ${dupExact}`);
console.log(`  logical dups (market+strategy+side+player): ${dupLogical}`);
if (dupLogical > 0) {
  console.log('\n  First 5 offending groups:');
  for (const x of db.prepare(`
    SELECT betfair_market_id, strategy_name, player_key, side, COUNT(*) AS n,
           GROUP_CONCAT(bet_id, ',') AS ids
    FROM bets WHERE strategy_name IS NOT NULL
    GROUP BY betfair_market_id, strategy_name, player_key, side HAVING n > 1 LIMIT 5
  `).all()) console.log('   ', x);
}

console.log('\n═══════════════════════════════════════════════════════════════════');
console.log(' STAGE 5 — Full analytics overview (the dashboard sees this)');
console.log('═══════════════════════════════════════════════════════════════════');
console.log('\n  Per-strategy summary (all sources mixed):');
const overview = db.prepare(`
  SELECT strategy_name,
         COUNT(*) AS bets,
         SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
         ROUND(SUM(pnl), 2) AS pnl,
         ROUND(AVG(requested_odds), 2) AS avg_odds,
         ROUND(SUM(stake), 2) AS stake,
         ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi_pct
  FROM bets WHERE settled_at IS NOT NULL
  GROUP BY strategy_name ORDER BY pnl DESC
`).all();
for (const x of overview) console.log(`    ${x.strategy_name?.padEnd(14)} bets=${String(x.bets).padStart(3)}  w=${String(x.wins).padStart(3)}  pnl=£${String(x.pnl).padStart(7)}  stake=£${String(x.stake).padStart(6)}  avgOdds=${x.avg_odds}  ROI=${x.roi_pct}%`);

console.log('\n  Source mix (LIVE / AIMISS / RETRO):');
for (const x of db.prepare(`
  SELECT CASE WHEN bet_id LIKE 'AIMISS-%' THEN 'AIMISS' WHEN bet_id LIKE 'RETRO-%' THEN 'RETRO' ELSE 'LIVE' END AS src,
         COUNT(*) AS n,
         SUM(CASE WHEN settled_at IS NULL THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
         ROUND(SUM(pnl), 2) AS pnl,
         ROUND(SUM(stake), 2) AS stake,
         ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
  FROM bets GROUP BY src
`).all()) console.log(`    ${x.src.padEnd(8)} bets=${String(x.n).padStart(4)}  open=${x.open}  wins=${x.wins}  pnl=£${x.pnl}  stake=£${x.stake}  ROI=${x.roi}%`);

console.log('\n  GRAND TOTAL across all bets:');
const total = db.prepare(`
  SELECT COUNT(*) AS bets,
         SUM(CASE WHEN settled_at IS NOT NULL THEN 1 ELSE 0 END) AS settled,
         SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
         ROUND(SUM(pnl), 2) AS pnl,
         ROUND(SUM(stake), 2) AS stake,
         ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
  FROM bets
`).get();
console.log(`    ${JSON.stringify(total)}`);

console.log('\n  Sanity: bets with no strategy_name / no market / null stake:');
console.log('    no strategy_name:', db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE strategy_name IS NULL`).get().n);
console.log('    no market_id:   ', db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE betfair_market_id IS NULL`).get().n);
console.log('    null stake:     ', db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE stake IS NULL`).get().n);
console.log('    null liability: ', db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE liability IS NULL`).get().n);
console.log('    null sub_strategy: ', db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE sub_strategy IS NULL AND strategy_name IS NOT NULL`).get().n);
