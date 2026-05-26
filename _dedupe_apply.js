// Remove duplicate bets — same market+strategy+playerKey+side.
// Preference: LIVE > AIMISS > earliest RETRO (most realistic info > AI estimate > first catch-up).
// Reports what was deleted, archives the IDs to app_meta for auditability.
const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');

const sourceRank = (id) => {
  if (id.startsWith('AIMISS-')) return 1;
  if (id.startsWith('RETRO-'))  return 0;  // RETRO lowest
  return 2;                                // LIVE highest
};

const groups = db.prepare(`
  SELECT betfair_market_id, strategy_name, player_key, side, COUNT(*) AS n,
         GROUP_CONCAT(bet_id, '|') AS ids,
         GROUP_CONCAT(placed_at, '|') AS placed
  FROM bets
  WHERE strategy_name IS NOT NULL
  GROUP BY betfair_market_id, strategy_name, player_key, side
  HAVING n > 1
`).all();

console.log(`Found ${groups.length} duplicate groups`);

let kept = 0, deleted = 0;
const archived = [];
const deleteStmt = db.prepare(`DELETE FROM bets WHERE bet_id = ?`);

const tx = db.transaction(() => {
  for (const g of groups) {
    const ids = g.ids.split('|');
    const placed = g.placed.split('|');
    // Rank: higher rank wins; tie → earliest placed_at wins.
    const items = ids.map((id, i) => ({ id, placed: placed[i], rank: sourceRank(id) }));
    items.sort((a, b) => b.rank - a.rank || a.placed.localeCompare(b.placed));
    const winner  = items[0];
    const losers  = items.slice(1);
    kept++;
    for (const l of losers) {
      deleteStmt.run(l.id);
      deleted++;
      archived.push({ kept: winner.id, deleted: l.id, market: g.betfair_market_id, strat: g.strategy_name });
    }
  }
  // Audit row so we can reconstruct if needed
  db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`)
    .run(`dedupe_${new Date().toISOString()}`, JSON.stringify(archived));
});
tx();

console.log(`Kept ${kept} canonical bets`);
console.log(`Deleted ${deleted} duplicates`);

console.log('\n=== Sample archived ===');
archived.slice(0, 10).forEach(a => console.log(' ', a));

console.log('\n=== Post-dedupe verification ===');
const remaining = db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT 1 FROM bets
    WHERE strategy_name IS NOT NULL
    GROUP BY betfair_market_id, strategy_name, player_key, side
    HAVING COUNT(*) > 1
  )
`).get();
console.log(`  Remaining duplicate groups: ${remaining.n}`);

console.log('\n=== Updated counts by source ===');
for (const r of db.prepare(`
  SELECT
    CASE
      WHEN bet_id LIKE 'AIMISS-%' THEN 'AIMISS'
      WHEN bet_id LIKE 'RETRO-%'  THEN 'RETRO'
      ELSE 'LIVE'
    END AS source,
    COUNT(*) AS n,
    ROUND(SUM(pnl), 2) AS pnl
  FROM bets GROUP BY source
`).all()) console.log(`  ${r.source.padEnd(10)} ${String(r.n).padStart(5)}   £${r.pnl}`);
