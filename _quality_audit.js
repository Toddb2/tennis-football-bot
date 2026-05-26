// Deep quality audit — answer 3 questions:
//   1. Are there any duplicate bets across sources (post-dedupe)?
//   2. Are all bets accurate (pnl computed from real outcome, not guessed)?
//   3. Are all games fully simulated (settled + known winner)?
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

const HR = '─'.repeat(76);

console.log('═══ 1. DUPLICATE BETS ═══');
console.log('Checking every possible dedup key…');
const checks = [
  { name: 'exact bet_id',                  sql: `SELECT bet_id AS k, COUNT(*) n FROM bets GROUP BY bet_id HAVING n > 1` },
  { name: 'market+strategy+side+playerKey',sql: `SELECT betfair_market_id || '|' || strategy_name || '|' || side || '|' || player_key AS k, COUNT(*) n FROM bets WHERE strategy_name IS NOT NULL GROUP BY k HAVING n > 1` },
  { name: 'market+strategy (any side)',    sql: `SELECT betfair_market_id || '|' || strategy_name AS k, COUNT(*) n FROM bets WHERE strategy_name IS NOT NULL GROUP BY k HAVING n > 1` },
  { name: 'market+sub_strategy',           sql: `SELECT betfair_market_id || '|' || sub_strategy AS k, COUNT(*) n FROM bets WHERE sub_strategy IS NOT NULL GROUP BY k HAVING n > 1` },
];
for (const c of checks) {
  const rows = db.prepare(c.sql).all();
  console.log(`  ${c.name.padEnd(38)} groups=${rows.length}`);
  if (rows.length) rows.slice(0, 3).forEach(r => console.log(`    ⚠ ${r.k}: ${r.n}`));
}

// market+strategy where there are >1 bet but DIFFERENT side or playerKey — these are LEGITIMATE (e.g. hedged pairs)
console.log('\n  Legitimate co-firings (same market, multiple strategies):');
const coFirings = db.prepare(`
  SELECT betfair_market_id, COUNT(DISTINCT strategy_name) AS strategies, COUNT(*) AS bets
  FROM bets WHERE strategy_name IS NOT NULL
  GROUP BY betfair_market_id
  HAVING bets > 1
  ORDER BY bets DESC LIMIT 5
`).all();
coFirings.forEach(r => console.log(`    ${r.betfair_market_id}: ${r.bets} bets across ${r.strategies} different strategies`));

console.log('\n' + HR);
console.log('═══ 2. BETS BY DATA QUALITY TIER ═══');
console.log(HR);
const tiers = db.prepare(`
  SELECT
    CASE
      WHEN bet_id LIKE 'AIMISS-%' AND reason LIKE '%refined w/ real snap%'  THEN '2a. AIMISS — refined with real snapshot odds'
      WHEN bet_id LIKE 'AIMISS-%'                                            THEN '2b. AIMISS — AI-claimed odds (snapshot pruned)'
      WHEN bet_id LIKE 'RETRO-%'                                              THEN '3.  RETRO — bot caught up via own snapshots'
      ELSE                                                                         '1.  LIVE — bot fired in real-time'
    END AS tier,
    COUNT(*) AS n,
    SUM(CASE WHEN settled_at IS NULL THEN 1 ELSE 0 END) AS open,
    SUM(CASE WHEN pnl IS NULL THEN 1 ELSE 0 END) AS no_pnl,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(stake), 2) AS stake,
    ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi_pct
  FROM bets
  GROUP BY tier
  ORDER BY tier
`).all();
console.log();
tiers.forEach(t => console.log(`  ${t.tier.padEnd(48)} ${String(t.n).padStart(4)} bets   open=${t.open}   null_pnl=${t.no_pnl}   pnl=£${t.pnl}   ROI=${t.roi_pct}%`));

console.log('\n' + HR);
console.log('═══ 3. SIMULATION COMPLETENESS ═══');
console.log(HR);
// Every bet should have settled_at + pnl + market.winner
const checks2 = [
  { label: 'Total bets',                                            sql: `SELECT COUNT(*) n FROM bets` },
  { label: 'Settled (settled_at IS NOT NULL)',                      sql: `SELECT COUNT(*) n FROM bets WHERE settled_at IS NOT NULL` },
  { label: 'Has computed pnl',                                      sql: `SELECT COUNT(*) n FROM bets WHERE pnl IS NOT NULL` },
  { label: 'Market.winner known (A or B)',                          sql: `SELECT COUNT(*) n FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id WHERE m.winner IN ('A','B')` },
  { label: 'Market.final_sets populated',                           sql: `SELECT COUNT(*) n FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id WHERE m.final_sets IS NOT NULL` },
  { label: 'Has BOTH market data AND own settlement (FULL SIM)',    sql: `SELECT COUNT(*) n FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id WHERE b.settled_at IS NOT NULL AND b.pnl IS NOT NULL AND m.winner IN ('A','B') AND m.final_sets IS NOT NULL` },
];
console.log();
checks2.forEach(c => console.log(`  ${c.label.padEnd(54)} ${db.prepare(c.sql).get().n}`));

// Show the gap — bets that ARE NOT fully simulated
console.log('\n  Sample of bets where simulation is incomplete:');
for (const r of db.prepare(`
  SELECT b.bet_id, b.strategy_name, b.settled_at, b.pnl, m.winner, m.final_sets
  FROM bets b
  LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE b.settled_at IS NULL OR b.pnl IS NULL OR m.winner NOT IN ('A','B') OR m.final_sets IS NULL
  LIMIT 8
`).all()) console.log('    ⚠', r);

console.log('\n' + HR);
console.log('═══ 4. AIMISS DATA-QUALITY BREAKDOWN ═══');
console.log(HR);
// For AIMISS specifically, distinguish refined (real snapshots) vs estimated (AI text only)
console.log();
for (const r of db.prepare(`
  SELECT
    CASE
      WHEN reason LIKE '%refined w/ real snap%'                  THEN 'A. Refined with real Betfair snapshot odds  (HIGH confidence)'
      WHEN betfair_market_id IN (SELECT betfair_market_id FROM markets WHERE went_in_play_at IS NOT NULL)
                                                                  THEN 'B. Market known to bot, snapshot pruned       (MEDIUM — AI odds)'
      ELSE                                                            'C. Market never seen by bot                    (LOW — AI-only)'
    END AS qual,
    COUNT(*) AS n,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
    ROUND(SUM(pnl), 2) AS pnl,
    ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
  FROM bets WHERE bet_id LIKE 'AIMISS-%'
  GROUP BY qual ORDER BY qual
`).all()) console.log(`  ${r.qual.padEnd(60)} n=${String(r.n).padStart(3)}  wins=${r.wins}  pnl=£${r.pnl}  ROI=${r.roi}%`);

console.log('\n' + HR);
console.log('═══ FINAL: HIGHEST-CONFIDENCE NUMBERS ═══');
console.log(HR);
// LIVE + AIMISS-refined + RETRO are all "real-data" sources.
// AIMISS-unrefined is partly estimated. AIMISS-no-market is AI-only.
const high = db.prepare(`
  SELECT COUNT(*) AS n, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
         ROUND(SUM(pnl), 2) AS pnl, ROUND(SUM(stake), 2) AS stake,
         ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
  FROM bets
  WHERE bet_id NOT LIKE 'AIMISS-%' OR reason LIKE '%refined w/ real snap%'
`).get();
console.log(`\n  HIGH-CONFIDENCE subset (LIVE + AIMISS-refined + RETRO):`);
console.log(`    bets=${high.n}  wins=${high.wins}  pnl=£${high.pnl}  stake=£${high.stake}  ROI=${high.roi}%`);

const all = db.prepare(`SELECT COUNT(*) AS n, ROUND(SUM(pnl), 2) AS pnl, ROUND(SUM(stake), 2) AS stake, ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi FROM bets`).get();
console.log(`\n  ALL bets (incl. AIMISS estimates):`);
console.log(`    bets=${all.n}  pnl=£${all.pnl}  stake=£${all.stake}  ROI=${all.roi}%`);
