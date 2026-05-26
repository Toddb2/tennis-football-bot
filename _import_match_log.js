// Import match_log.jsonl rows into markets (INSERT OR IGNORE so existing data isn't disturbed).
// This is the richest historical source we have — 1635 matches with surface + result.
const fs = require('fs');
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

const lines = fs.readFileSync('/home/bots/tennis-bot/data/match_log.jsonl', 'utf8').trim().split('\n');
console.log(`Read ${lines.length} match-log rows`);

const insert = db.prepare(`
  INSERT OR IGNORE INTO markets (
    betfair_market_id, match_name, player_a_name, player_b_name,
    surface, tournament, pre_match_odds_a, pre_match_odds_b, pre_match_volume,
    final_sets, winner, ended_at, went_in_play_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function pickWinner(sets) {
  let setsA = 0, setsB = 0;
  for (const s of (sets || [])) {
    if (s.playerA == null || s.playerB == null) continue;
    if (s.playerA > s.playerB) setsA++;
    else if (s.playerB > s.playerA) setsB++;
  }
  return setsA > setsB ? 'A' : setsB > setsA ? 'B' : null;
}

let inserted = 0, skippedDup = 0, skippedBadName = 0, skippedNoWinner = 0;
const tx = db.transaction(() => {
  for (const ln of lines) {
    let r;
    try { r = JSON.parse(ln); } catch (_) { continue; }
    if (!r.marketId || !r.matchName) continue;
    // Parse player names (Betfair format is "A name v B name")
    const m = r.matchName.match(/^(.+?)\s+v\s+(.+?)$/);
    if (!m) { skippedBadName++; continue; }
    const [_, nameA, nameB] = m;
    const winner = pickWinner(r.sets);
    if (!winner) { skippedNoWinner++; continue; }
    const before = db.prepare(`SELECT 1 FROM markets WHERE betfair_market_id = ?`).get(r.marketId);
    if (before) { skippedDup++; continue; }
    insert.run(
      r.marketId, r.matchName, nameA.trim(), nameB.trim(),
      r.surface || null, r.tournament || null,
      r.preMatchOddsA || null, r.preMatchOddsB || null, r.matchedVolume || null,
      JSON.stringify(r.sets || []), winner, r.ts, r.ts
    );
    inserted++;
  }
});
tx();

console.log(`\nInserted: ${inserted}`);
console.log(`Skipped (duplicate market):  ${skippedDup}`);
console.log(`Skipped (could not parse names): ${skippedBadName}`);
console.log(`Skipped (no clear winner): ${skippedNoWinner}`);

// Verify coverage improvement
const stats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM markets) AS total_markets,
    (SELECT COUNT(*) FROM markets WHERE winner IN ('A','B')) AS settled,
    (SELECT COUNT(*) FROM markets WHERE surface IS NOT NULL) AS with_surface,
    (SELECT COUNT(DISTINCT player_a_name) + COUNT(DISTINCT player_b_name) FROM markets) AS player_slots
`).get();
console.log('\n=== markets table after import ===');
console.log(' ', stats);

// Re-check the same recent-50 WR availability we measured earlier
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
let ok = 0, insufficient = 0;
for (const b of recent) {
  if (!b.surface || !b.player_a_name || !b.player_b_name) { insufficient++; continue; }
  const p1 = wrStmt.get({ name: b.player_a_name, surface: b.surface, excl: b.betfair_market_id });
  const p2 = wrStmt.get({ name: b.player_b_name, surface: b.surface, excl: b.betfair_market_id });
  if (p1.total >= 1 && p2.total >= 1) ok++; else insufficient++;
}
console.log(`\n=== Recent-50 SurfWR coverage AFTER import ===`);
console.log(`  WR shown: ${ok}/50  (was 37/50)`);
console.log(`  Still insufficient: ${insufficient}/50`);
