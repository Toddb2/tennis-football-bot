'use strict';

/**
 * AUTHORITATIVE re-settlement. For every market that has bets, fetch the real result
 * from api-tennis (the source of truth), map the winner to this market's A/B BY NAME,
 * and settle every bet as player_key vs that winner — recomputing settlement_type + pnl.
 * Also rewrites markets.winner and final_sets to the real, title-ordered result.
 *
 * No flipping/reversing of prior (possibly wrong) state — every value is recomputed
 * from api-tennis, so it cannot compound earlier errors.
 *
 *   node scripts/resettleFromApiTennis.js          # dry run (report only)
 *   node scripts/resettleFromApiTennis.js --apply
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');
const { playerNamesMatch } = require('../src/utils/helpers');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const KEY = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^API_TENNIS_KEY=(.*)$/m) || [])[1].trim();
const db = new Database(path.join(ROOT, 'data/tennis-bot.db'));
db.pragma('busy_timeout = 15000');
const round2 = n => Math.round(n * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getDay(date) {
  const url = `https://api.api-tennis.com/tennis/?method=get_fixtures&APIkey=${KEY}&date_start=${date}&date_stop=${date}`;
  return new Promise(res => {
    https.get(url, r => { let d = ''; r.on('data', c => (d += c)); r.on('end', () => { try { res(JSON.parse(d).result || []); } catch { res([]); } }); })
      .on('error', () => res([]));
  });
}

(async () => {
  // 1. Build event_key -> result map over the bet date range.
  const range = db.prepare(`SELECT MIN(date(settled_at)) a, MAX(date(placed_at)) b FROM bets WHERE settled_at IS NOT NULL`).get();
  const start = new Date(range.a + 'T00:00:00Z'), end = new Date((range.b || range.a) + 'T00:00:00Z');
  const byKey = new Map();
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    const fx = await getDay(ds);
    for (const f of fx) byKey.set(String(f.event_key), f);
    await sleep(120);
  }
  console.log(`Fetched ${byKey.size} api-tennis fixtures across ${range.a}..${range.b}\n`);

  // 2. Re-settle each market with bets.
  const markets = db.prepare(`
    SELECT DISTINCT b.betfair_market_id, m.match_name, m.player_a_name, m.player_b_name,
           m.winner, m.external_match_id
    FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id
    WHERE m.external_match_id IS NOT NULL AND m.external_match_id <> ''
  `).all();

  const betsFor = db.prepare(`SELECT id, strategy_name, player_key, side, requested_odds, actual_odds, stake, settlement_type, pnl FROM bets WHERE betfair_market_id = ?`);
  const updMarket = db.prepare(`UPDATE markets SET winner = ?, final_sets = ? WHERE betfair_market_id = ?`);
  const updBet = db.prepare(`UPDATE bets SET settlement_type = ?, pnl = ? WHERE id = ?`);

  let mkChanged = 0, betFlips = 0, betPnl = 0, skipped = 0;
  const examples = [];
  const apply = [];

  for (const m of markets) {
    const key = String(m.external_match_id).replace('at:', '');
    const f = byKey.get(key);
    if (!f || !/Finished/i.test(f.event_status || '')) { skipped++; continue; }
    const first = f.event_first_player, second = f.event_second_player;
    const winnerName = f.event_winner === 'First Player' ? first : f.event_winner === 'Second Player' ? second : null;
    if (!winnerName) { skipped++; continue; }

    // Map winner -> A/B by NAME (authoritative; never by feed position).
    let winner = null;
    const wA = playerNamesMatch(winnerName, m.player_a_name), wB = playerNamesMatch(winnerName, m.player_b_name);
    if (wA && !wB) winner = 'A'; else if (wB && !wA) winner = 'B';
    if (!winner) { skipped++; continue; }

    // Title-order final_sets: first/second mapped to A/B by name.
    const firstIsA = playerNamesMatch(first, m.player_a_name) && !playerNamesMatch(first, m.player_b_name);
    const sets = (f.scores || []).map(s => firstIsA
      ? [parseInt(s.score_first) || 0, parseInt(s.score_second) || 0]
      : [parseInt(s.score_second) || 0, parseInt(s.score_first) || 0]);

    if (m.winner !== winner) mkChanged++;
    apply.push({ type: 'market', id: m.betfair_market_id, winner, sets: JSON.stringify(sets) });

    for (const b of betsFor.all(m.betfair_market_id)) {
      const won = b.side === 'LAY' ? b.player_key !== winner : b.player_key === winner;
      const newType = won ? 'DRY_WIN' : 'DRY_LOSS';
      const odds = b.actual_odds || b.requested_odds || 0;
      const newPnl = round2(won
        ? (b.side === 'LAY' ? b.stake : b.stake * (odds - 1))
        : (b.side === 'LAY' ? -(b.stake * (odds - 1)) : -b.stake));
      const flipped = b.settlement_type && newType !== b.settlement_type;
      if (flipped) betFlips++; else if (Math.abs((b.pnl ?? 0) - newPnl) > 0.005) betPnl++;
      if (flipped && examples.length < 20)
        examples.push(`${flipped ? 'FLIP' : 'pnl '} ${b.strategy_name} ${m.match_name} key=${b.player_key} ${b.settlement_type}(${b.pnl})->${newType}(${newPnl}) [winner=${winner} ${winnerName}]`);
      apply.push({ type: 'bet', id: b.id, newType, newPnl });
    }
  }

  console.log(`Markets re-settled: ${markets.length - skipped} | winner changed: ${mkChanged} | skipped (no result/in-play): ${skipped}`);
  console.log(`Bet settlement FLIPS (W<->L): ${betFlips} | pnl-only changes: ${betPnl}\n`);
  examples.forEach(e => console.log('  ' + e));

  if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to write.'); db.close(); return; }

  const tx = db.transaction(list => {
    for (const a of list) {
      if (a.type === 'market') updMarket.run(a.winner, a.sets, a.id);
      else updBet.run(a.newType, a.newPnl, a.id);
    }
  });
  tx(apply);
  console.log(`\nAPPLIED — ${mkChanged} market winners corrected, ${betFlips} bet outcomes flipped.`);
  db.close();
})();
