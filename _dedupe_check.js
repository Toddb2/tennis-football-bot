// Check for duplicate bets — same market + strategy + side + player_key
// fired multiple times (e.g. real bet + AIMISS + RETRO all on the same trigger).
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('=== bet_id uniqueness (UNIQUE constraint expected) ===');
const dupIds = db.prepare(`
  SELECT bet_id, COUNT(*) AS n FROM bets GROUP BY bet_id HAVING n > 1
`).all();
console.log(`  exact bet_id duplicates: ${dupIds.length}`);
dupIds.forEach(d => console.log('   ', d));

console.log('\n=== Same market+strategy+playerKey+side fired multiple times ===');
const groups = db.prepare(`
  SELECT betfair_market_id, strategy_name, player_key, side,
         COUNT(*) AS n,
         GROUP_CONCAT(bet_id, '|') AS bet_ids,
         GROUP_CONCAT(placed_at, '|') AS placed_ats,
         ROUND(SUM(pnl), 2) AS combined_pnl
  FROM bets
  WHERE betfair_market_id IS NOT NULL
    AND strategy_name IS NOT NULL
  GROUP BY betfair_market_id, strategy_name, player_key, side
  HAVING n > 1
  ORDER BY n DESC
`).all();
console.log(`  groups with >1 bet on identical key: ${groups.length}`);

// Classify each group by which sources are involved
const classify = (ids) => {
  const sources = new Set();
  for (const id of ids.split('|')) {
    if (id.startsWith('AIMISS-'))      sources.add('AIMISS');
    else if (id.startsWith('RETRO-'))  sources.add('RETRO');
    else                                sources.add('LIVE');
  }
  return [...sources].sort().join('+');
};

const byClass = {};
for (const g of groups) {
  const c = classify(g.bet_ids);
  byClass[c] = (byClass[c] || 0) + 1;
}
console.log('\n  Breakdown by source mix:');
for (const [k, v] of Object.entries(byClass).sort((a,b) => b[1]-a[1]))
  console.log(`    ${k.padEnd(28)} ${v}`);

console.log('\n  Top 10 worst offenders (most rows per identical key):');
groups.slice(0, 10).forEach(g => {
  console.log(`    ${g.betfair_market_id}  ${g.strategy_name}  ${g.side} ${g.player_key}  ×${g.n}  combined_pnl £${g.combined_pnl}`);
  console.log(`      ids: ${g.bet_ids}`);
});

console.log('\n=== Same market+strategy regardless of side ===');
const stratGroups = db.prepare(`
  SELECT betfair_market_id, strategy_name, COUNT(*) AS n
  FROM bets WHERE strategy_name IS NOT NULL
  GROUP BY betfair_market_id, strategy_name
  HAVING n > 1
  ORDER BY n DESC LIMIT 10
`).all();
console.log(`  any strategy fired >1× on a market: ${stratGroups.length}`);
stratGroups.forEach(g => console.log(`    ${g.betfair_market_id}  ${g.strategy_name}  ×${g.n}`));

console.log('\n=== Total bet counts by source ===');
const sources = db.prepare(`
  SELECT
    CASE
      WHEN bet_id LIKE 'AIMISS-%' THEN 'AIMISS'
      WHEN bet_id LIKE 'RETRO-%'  THEN 'RETRO'
      ELSE 'LIVE'
    END AS source,
    COUNT(*) AS n,
    ROUND(SUM(pnl), 2) AS pnl
  FROM bets GROUP BY source
`).all();
sources.forEach(s => console.log(`  ${s.source.padEnd(10)} ${String(s.n).padStart(5)} bets   pnl £${s.pnl}`));
