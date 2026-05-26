const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

// 1. Get every player name occurring as player_a_name or player_b_name in markets,
//    deduped, with count of appearances.
const allPlayers = db.prepare(`
  SELECT name, SUM(c) AS appearances FROM (
    SELECT player_a_name AS name, COUNT(*) AS c FROM markets WHERE player_a_name IS NOT NULL GROUP BY player_a_name
    UNION ALL
    SELECT player_b_name AS name, COUNT(*) AS c FROM markets WHERE player_b_name IS NOT NULL GROUP BY player_b_name
  ) GROUP BY name ORDER BY appearances DESC
`).all();
console.log(`Total unique player names: ${allPlayers.length}`);

// Look for names that share a "last name" — these could be the same player under different aliases.
function lastWords(name) {
  return name.trim().split(/\s+/).filter(w => !/^[A-Z]\.?$/.test(w)).slice(-2).join(' ').toLowerCase();
}

const byLastName = new Map();
for (const p of allPlayers) {
  const ln = lastWords(p.name);
  if (!ln) continue;
  if (!byLastName.has(ln)) byLastName.set(ln, []);
  byLastName.get(ln).push(p);
}

const aliases = [...byLastName.entries()].filter(([_, list]) => list.length > 1);
console.log(`\nLast-name collisions (potential aliases): ${aliases.length}`);
console.log('First 15:');
aliases.slice(0, 15).forEach(([ln, list]) =>
  console.log(`  "${ln}": ${list.map(p => `${p.name}(${p.appearances})`).join(', ')}`)
);

// Now check: among the bets that currently show SurfWR null, how many would benefit
// from fuzzy last-name match?
console.log('\n=== Players in recent unmatched bets ===');
const recentNull = db.prepare(`
  SELECT DISTINCT m.player_a_name, m.player_b_name, m.surface
  FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE m.surface IS NOT NULL
  ORDER BY b.placed_at DESC LIMIT 50
`).all();
let recoverable = 0, irrecoverable = 0;
for (const r of recentNull) {
  for (const p of [r.player_a_name, r.player_b_name].filter(Boolean)) {
    const direct = db.prepare(`SELECT COUNT(*) n FROM markets WHERE (player_a_name = ? OR player_b_name = ?) AND surface = ? AND winner IN ('A','B')`).get(p, p, r.surface).n;
    if (direct >= 1) continue;
    // Try fuzzy last-name match
    const ln = lastWords(p);
    const fuzzy = db.prepare(`SELECT COUNT(*) n FROM markets WHERE (LOWER(player_a_name) LIKE ? OR LOWER(player_b_name) LIKE ?) AND surface = ? AND winner IN ('A','B')`).get(`%${ln}%`, `%${ln}%`, r.surface).n;
    if (fuzzy >= 1) { recoverable++; }
    else { irrecoverable++; }
  }
}
console.log(`  Players that would gain data via fuzzy: ${recoverable}`);
console.log(`  Players with no data even via fuzzy:    ${irrecoverable}`);

// Count of unique players with zero surface data anywhere in our DB
const playersWithZero = db.prepare(`
  SELECT name FROM (
    SELECT player_a_name AS name FROM markets WHERE player_a_name IS NOT NULL
    UNION
    SELECT player_b_name AS name FROM markets WHERE player_b_name IS NOT NULL
  ) WHERE name NOT IN (
    SELECT player_a_name FROM markets WHERE winner IN ('A','B') AND player_a_name IS NOT NULL
    UNION
    SELECT player_b_name FROM markets WHERE winner IN ('A','B') AND player_b_name IS NOT NULL
  )
`).all();
console.log(`\nPlayers in markets but never appearing in a settled match (winner IN A/B): ${playersWithZero.length}`);
