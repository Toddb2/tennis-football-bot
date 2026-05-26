const db = require('/home/bots/tennis-bot/node_modules/better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

console.log('═══ Issue 1: NULL surface_wr_diff ═══');
// Replicate the dashboard's lookup
const wrStmt = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN (player_a_name = @name AND winner = 'A')
                        OR (player_b_name = @name AND winner = 'B') THEN 1 ELSE 0 END), 0) AS wins,
    COALESCE(SUM(CASE WHEN player_a_name = @name OR player_b_name = @name THEN 1 ELSE 0 END), 0) AS total
  FROM markets WHERE surface = @surface AND winner IN ('A','B') AND betfair_market_id != @excl
`);
const bets = db.prepare(`
  SELECT b.bet_id, b.betfair_market_id, m.surface, m.player_a_name, m.player_b_name
  FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
`).all();

let p1ok=0, p2ok=0, bothOk=0, neitherOk=0, noSurface=0, noNames=0;
const samples = { p1_only: [], p2_only: [], neither: [] };
for (const b of bets) {
  if (!b.surface) { noSurface++; continue; }
  if (!b.player_a_name || !b.player_b_name) { noNames++; continue; }
  const p1 = wrStmt.get({ name: b.player_a_name, surface: b.surface, excl: b.betfair_market_id });
  const p2 = wrStmt.get({ name: b.player_b_name, surface: b.surface, excl: b.betfair_market_id });
  const p1Pass = p1.total >= 3;
  const p2Pass = p2.total >= 3;
  if (p1Pass && p2Pass) bothOk++;
  else if (p1Pass) { p1ok++; if (samples.p2_only.length < 3) samples.p2_only.push({ ...b, p1Total: p1.total, p2Total: p2.total }); }
  else if (p2Pass) { p2ok++; if (samples.p1_only.length < 3) samples.p1_only.push({ ...b, p1Total: p1.total, p2Total: p2.total }); }
  else { neitherOk++; if (samples.neither.length < 3) samples.neither.push({ ...b, p1Total: p1.total, p2Total: p2.total }); }
}
console.log(`  Both players ≥3 matches on surface (WR shown): ${bothOk}`);
console.log(`  Only P1 has ≥3 (shown as null):                 ${p1ok}`);
console.log(`  Only P2 has ≥3 (shown as null):                 ${p2ok}`);
console.log(`  Neither has ≥3 matches:                         ${neitherOk}`);
console.log(`  No surface in markets table:                    ${noSurface}`);
console.log(`  Missing player names:                           ${noNames}`);

console.log('\n  Sample: only one side has enough data');
samples.p1_only.concat(samples.p2_only).slice(0, 5).forEach(s =>
  console.log(`    ${s.player_a_name} (${s.p1Total}) vs ${s.player_b_name} (${s.p2Total}) on ${s.surface}`));

console.log('\n  Sample: neither side has enough data');
samples.neither.slice(0, 5).forEach(s =>
  console.log(`    ${s.player_a_name} (${s.p1Total}) vs ${s.player_b_name} (${s.p2Total}) on ${s.surface}`));

console.log('\n═══ Issue 2: "Finished" bets with no result ═══');
// Renderer marks status="Finished" when !settled_at AND latest_sets present
const finishedNoResult = db.prepare(`
  SELECT b.bet_id, b.strategy_name, b.placed_at, b.settled_at, b.pnl, b.settlement_type,
         m.match_name, m.winner, m.final_sets, m.ended_at
  FROM bets b
  LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE (b.settled_at IS NULL OR b.pnl IS NULL)
`).all();

console.log(`  Total bets with null settled_at or null pnl: ${finishedNoResult.length}`);
const cat = { matchEnded_botMissedSettle: [], matchInProgress: [], noMatchData: [] };
for (const r of finishedNoResult) {
  if (r.ended_at && r.winner) cat.matchEnded_botMissedSettle.push(r);
  else if (!r.final_sets) cat.noMatchData.push(r);
  else cat.matchInProgress.push(r);
}
console.log(`    A. Match ENDED, bot didn't settle bet:       ${cat.matchEnded_botMissedSettle.length}`);
console.log(`    B. Match still in progress / no final_sets:  ${cat.matchInProgress.length}`);
console.log(`    C. No market data at all:                    ${cat.noMatchData.length}`);

console.log('\n  A. Match ended but bet not settled (auto-fixable — settle from outcome):');
cat.matchEnded_botMissedSettle.slice(0, 8).forEach(r =>
  console.log(`    ${r.bet_id}  ${r.strategy_name}  ${r.match_name}  winner=${r.winner}  ended=${r.ended_at}  current_pnl=${r.pnl}`));
console.log('\n  B. Match in progress:');
cat.matchInProgress.slice(0, 5).forEach(r =>
  console.log(`    ${r.bet_id}  ${r.strategy_name}  ${r.match_name}  ended=${r.ended_at}`));
