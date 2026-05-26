// For markets that already exist, fill missing surface / winner / final_sets from match_log.jsonl.
const fs = require('fs');
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

const lines = fs.readFileSync('/home/bots/tennis-bot/data/match_log.jsonl', 'utf8').trim().split('\n');

const update = db.prepare(`
  UPDATE markets SET
    surface     = COALESCE(surface,     ?),
    tournament  = COALESCE(tournament,  ?),
    final_sets  = COALESCE(final_sets,  ?),
    winner      = COALESCE(winner,      ?),
    ended_at    = COALESCE(ended_at,    ?),
    player_a_name = COALESCE(player_a_name, ?),
    player_b_name = COALESCE(player_b_name, ?)
  WHERE betfair_market_id = ?
`);

function pickWinner(sets) {
  let a = 0, b = 0;
  for (const s of (sets || [])) {
    if (s.playerA == null || s.playerB == null) continue;
    if (s.playerA > s.playerB) a++;
    else if (s.playerB > s.playerA) b++;
  }
  return a > b ? 'A' : b > a ? 'B' : null;
}

let touched = 0;
const tx = db.transaction(() => {
  for (const ln of lines) {
    let r; try { r = JSON.parse(ln); } catch (_) { continue; }
    if (!r.marketId || !r.matchName) continue;
    const m = r.matchName.match(/^(.+?)\s+v\s+(.+?)$/);
    if (!m) continue;
    const winner = pickWinner(r.sets);
    const res = update.run(
      r.surface || null,
      r.tournament || null,
      r.sets && r.sets.length ? JSON.stringify(r.sets) : null,
      winner,
      r.ts || null,
      m[1].trim(),
      m[2].trim(),
      r.marketId
    );
    if (res.changes) touched++;
  }
});
tx();
console.log(`Markets touched: ${touched}`);

// Now: recompute the audit numbers
const wrStmt = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN (player_a_name = @name AND winner = 'A')
                        OR (player_b_name = @name AND winner = 'B') THEN 1 ELSE 0 END), 0) AS wins,
    COALESCE(SUM(CASE WHEN player_a_name = @name OR player_b_name = @name THEN 1 ELSE 0 END), 0) AS total
  FROM markets WHERE surface = @surface AND winner IN ('A','B') AND betfair_market_id != @excl
`);

const recent = db.prepare(`
  SELECT b.bet_id, m.betfair_market_id, m.surface, m.player_a_name, m.player_b_name
  FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  ORDER BY b.placed_at DESC LIMIT 50
`).all();
let ok = 0, insuf = 0, noMeta = 0;
for (const b of recent) {
  if (!b.surface || !b.player_a_name || !b.player_b_name) { noMeta++; continue; }
  const p1 = wrStmt.get({ name: b.player_a_name, surface: b.surface, excl: b.betfair_market_id });
  const p2 = wrStmt.get({ name: b.player_b_name, surface: b.surface, excl: b.betfair_market_id });
  if (p1.total >= 1 && p2.total >= 1) ok++; else insuf++;
}
console.log(`\n=== Recent-50 SurfWR coverage AFTER enrichment ===`);
console.log(`  WR shown:          ${ok}/50`);
console.log(`  Still insufficient: ${insuf}/50`);
console.log(`  No surface/names:  ${noMeta}/50`);

// Full bets coverage
const allBets = db.prepare(`SELECT b.bet_id, m.surface, m.player_a_name, m.player_b_name, b.betfair_market_id FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id`).all();
let allOk=0, allInsuf=0, allNoMeta=0;
for (const b of allBets) {
  if (!b.surface || !b.player_a_name || !b.player_b_name) { allNoMeta++; continue; }
  const p1 = wrStmt.get({ name: b.player_a_name, surface: b.surface, excl: b.betfair_market_id });
  const p2 = wrStmt.get({ name: b.player_b_name, surface: b.surface, excl: b.betfair_market_id });
  if (p1.total >= 1 && p2.total >= 1) allOk++; else allInsuf++;
}
console.log(`\n=== ALL ${allBets.length} bets ===`);
console.log(`  WR shown:          ${allOk}  (${(allOk/allBets.length*100).toFixed(1)}%)`);
console.log(`  Still insufficient: ${allInsuf}  (${(allInsuf/allBets.length*100).toFixed(1)}%)`);
console.log(`  No surface/names:  ${allNoMeta}  (${(allNoMeta/allBets.length*100).toFixed(1)}%)`);
