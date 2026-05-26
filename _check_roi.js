const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('=== Per-strategy ROI (current calc: SUM(pnl)/SUM(liability)) ===');
for (const r of db.prepare(`
  SELECT strategy_name,
         COUNT(*) AS n,
         SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
         ROUND(SUM(stake),2)     AS sum_stake,
         ROUND(SUM(liability),2) AS sum_liab,
         ROUND(SUM(pnl),2)       AS sum_pnl,
         ROUND(SUM(pnl)/NULLIF(SUM(stake),0)*100, 2)     AS roi_by_stake,
         ROUND(SUM(pnl)/NULLIF(SUM(liability),0)*100, 2) AS roi_by_liab
  FROM bets
  WHERE settled_at IS NOT NULL
  GROUP BY strategy_name
  ORDER BY sum_pnl DESC
`).all()) console.log(' ', r);

console.log('\n=== Sample bets per strategy showing liability vs stake (LAY vs BACK) ===');
for (const r of db.prepare(`
  SELECT strategy_name, side, ROUND(actual_odds,2) AS odds,
         ROUND(stake,2) AS stake, ROUND(liability,2) AS liab, ROUND(pnl,2) AS pnl
  FROM bets
  WHERE settled_at IS NOT NULL
  ORDER BY strategy_name, placed_at
  LIMIT 30
`).all()) console.log(' ', r);

console.log('\n=== Edge cases: liability=NULL or liability=0 ===');
const bad = db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE settled_at IS NOT NULL AND (liability IS NULL OR liability = 0)`).get();
console.log('  count:', bad.n);
if (bad.n > 0) {
  for (const r of db.prepare(`SELECT bet_id, strategy_name, side, stake, liability, pnl FROM bets WHERE settled_at IS NOT NULL AND (liability IS NULL OR liability = 0) LIMIT 5`).all())
    console.log(' ', r);
}
