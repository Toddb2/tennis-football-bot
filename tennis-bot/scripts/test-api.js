'use strict';

/**
 * test-api.js — Live diagnostic for api-tennis.com
 *
 * Run from the tennis-bot directory:
 *   node scripts/test-api.js
 *
 * What it does:
 *   1. Calls get_livescore and prints every field of the first singles match
 *   2. Runs every parse function against that match and shows the output
 *   3. Calls get_standings (ATP) and shows the first 5 players
 *   4. If a live match has player keys, fetches get_players and get_H2H
 *   5. Tries get_odds for the first live match
 *   6. Connects to the WebSocket for 15 s and prints the first message received
 */

require('dotenv').config();
const axios     = require('axios');
const WebSocket = require('ws');

const API_KEY = process.env.API_TENNIS_KEY;
if (!API_KEY) { console.error('API_TENNIS_KEY not set in .env'); process.exit(1); }

const http = axios.create({
  baseURL: 'https://api.api-tennis.com/tennis/',
  timeout: 15_000,
  headers: { Accept: 'application/json' },
});

const get = (params) => http.get('', { params: { ...params, APIkey: API_KEY } });

// ─── Helpers mirrored from statsPoller.js ────────────────────────────────────

function parseSets(match) {
  if (Array.isArray(match.scores) && match.scores.length > 0) {
    return match.scores.map(s => ({
      playerA: parseInt(s.score_first  ?? s.home ?? 0) || 0,
      playerB: parseInt(s.score_second ?? s.away ?? 0) || 0,
    }));
  }
  const raw = String(match.event_final_result || '');
  if (!raw || raw === '-') return [];
  return raw.split(',').map(part => {
    const [a, b] = part.trim().split('-').map(n => parseInt(n) || 0);
    return { playerA: a || 0, playerB: b || 0 };
  });
}

function parseGameScore(match) {
  const raw = String(match.event_game_result || '');
  if (!raw || raw === '-') return { playerA: 0, playerB: 0 };
  const POINT_MAP = { '0': 0, '15': 15, '30': 30, '40': 40, 'AD': 50, 'A': 50 };
  const parts = raw.split('-');
  const mapPt = v => {
    const s = String(v || '0').toUpperCase().trim();
    return POINT_MAP[s] ?? parseInt(s) ?? 0;
  };
  return { playerA: mapPt(parts[0]), playerB: mapPt(parts[1]) };
}

function parseServer(match) {
  const s = String(match.event_serve || '').toLowerCase();
  if (s === 'first player')  return 'playerA';
  if (s === 'second player') return 'playerB';
  return null;
}

function parseRound(raw) {
  if (!raw) return null;
  const part = raw.includes(' - ') ? raw.split(' - ').pop().trim() : raw.trim();
  const s = part.toLowerCase();
  if (s.includes('final') && !s.includes('semi') && !s.includes('quarter')) return 'F';
  if (s.includes('semi'))                                                     return 'SF';
  if (s.includes('quarter') || s === '1/4-finals')                           return 'QF';
  if (s === '1/8-finals'  || s.includes('round of 16'))  return 'R16';
  if (s === '1/16-finals' || s.includes('round of 32'))  return 'R32';
  if (s === '1/32-finals' || s.includes('round of 64'))  return 'R64';
  return part || null;
}

function parseBreakPointsFixed(match, setNum = null) {
  // Uses statistics array first (accurate), then falls back to pointbypoint with FIXED break_point check
  const bp = { playerA: { created: 0, converted: 0 }, playerB: { created: 0, converted: 0 } };
  const statsArr = Array.isArray(match.statistics) ? match.statistics : [];
  const p1Key = String(match.first_player_key || '');
  const p2Key = String(match.second_player_key || '');
  const period = setNum === null ? 'match' : `set${setNum}`;
  for (const item of statsArr) {
    if (item.stat_period !== period) continue;
    const pKey = String(item.player_key || '');
    const player = pKey === p1Key ? 'playerA' : pKey === p2Key ? 'playerB' : null;
    if (!player) continue;
    const name = (item.stat_name || '').toLowerCase();
    if (name === 'break points converted') {
      bp[player].created = item.stat_total || 0;
      bp[player].converted = item.stat_won || 0;
    }
  }
  if (bp.playerA.created > 0 || bp.playerB.created > 0) return bp;
  // Fallback: fixed break_point check
  let pbp = Array.isArray(match.pointbypoint) ? match.pointbypoint : [];
  if (setNum !== null) {
    pbp = pbp.filter(g => {
      const s = g.set_number ?? g.set ?? null;
      if (s === null) return false;
      const n = typeof s === 'number' ? s : parseInt(String(s).replace(/\D+/g, ''), 10);
      return !isNaN(n) && n === setNum;
    });
  }
  for (const game of pbp) {
    const server = (game.player_served || '').toLowerCase();
    if (!server || game.serve_winner === null) continue;
    const isA = server.includes('first');
    const points = Array.isArray(game.points) ? game.points : [];
    const hadBP = points.some(p => p.break_point !== null && p.break_point !== undefined && p.break_point !== '');
    if (!hadBP) continue;
    const creator = isA ? 'playerB' : 'playerA';
    bp[creator].created++;
    const winner = String(game.serve_winner || '').toLowerCase();
    const serverWon = isA ? winner.includes('first') : winner.includes('second');
    if (!serverWon) bp[creator].converted++;
  }
  return bp;
}

function parseServeStatsFixed(match, setNum = null) {
  const stats = {
    playerA: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
    playerB: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
  };
  const statsArr = Array.isArray(match.statistics) ? match.statistics : [];
  const p1Key = String(match.first_player_key || '');
  const p2Key = String(match.second_player_key || '');
  const period = setNum === null ? 'match' : `set${setNum}`;
  for (const item of statsArr) {
    if (item.stat_period !== period) continue;
    const pKey = String(item.player_key || '');
    const player = pKey === p1Key ? 'playerA' : pKey === p2Key ? 'playerB' : null;
    if (!player) continue;
    const name = (item.stat_name || '').toLowerCase();
    const val  = String(item.stat_value || '');
    const parsePct = v => { const n = parseFloat(String(v).replace('%','')); return isNaN(n) ? null : n; };
    const parseNum = v => { const n = parseInt(String(v),10); return isNaN(n) ? null : n; };
    if (name === 'aces')                       stats[player].aces           = parseNum(val);
    else if (name === 'double faults')         stats[player].doubleFaults   = parseNum(val);
    else if (name === '1st serve percentage')  stats[player].firstServeIn   = parsePct(val);
    else if (name === '1st serve points won')  stats[player].firstServeWon  = parsePct(val);
    else if (name === '2nd serve points won')  stats[player].secondServeWon = parsePct(val);
  }
  return stats;
}

function parseRoundFixed(raw) {
  if (!raw) return null;
  const part = raw.includes(' - ') ? raw.split(' - ').pop().trim() : raw.trim();
  const s = part.toLowerCase();
  if (s === '1/4-finals' || s.includes('quarter'))      return 'QF';
  if (s === '1/8-finals' || s.includes('round of 16'))  return 'R16';
  if (s === '1/16-finals'|| s.includes('round of 32'))  return 'R32';
  if (s === '1/32-finals'|| s.includes('round of 64'))  return 'R64';
  if (s === '1/64-finals'|| s.includes('round of 128')) return 'R128';
  if (s.includes('semi'))   return 'SF';
  if (s.includes('final'))  return 'F';
  return part || null;
}

function parseBreakPoints(match, setNum = null) {
  // OLD (buggy) version for comparison
  const bp = { playerA: { created: 0, converted: 0 }, playerB: { created: 0, converted: 0 } };
  let pbp = Array.isArray(match.pointbypoint) ? match.pointbypoint : [];
  if (setNum !== null) {
    pbp = pbp.filter(g => {
      const s = g.set ?? g.set_number ?? g.setNumber ?? null;
      if (s === null) return false;
      const n = typeof s === 'number' ? s : parseInt(String(s).replace(/\D+/g, ''), 10);
      return !isNaN(n) && n === setNum;
    });
  }
  for (const game of pbp) {
    const server = (game.player_served || '').toLowerCase();
    if (!server || game.serve_winner === null) continue;
    const isA   = server.includes('first');
    const points = Array.isArray(game.points) ? game.points : [];
    const hadBP  = points.some(p => p.break_point === true || p.break_point === 'true');
    if (!hadBP) continue;
    const creator = isA ? 'playerB' : 'playerA';
    bp[creator].created++;
    const winner = String(game.serve_winner || '').toLowerCase();
    const serverWon = isA ? winner.includes('first') : winner.includes('second');
    if (!serverWon) bp[creator].converted++;
  }
  return bp;
}

function serveHoldRate(match, setNum = null) {
  let pbp = Array.isArray(match.pointbypoint) ? match.pointbypoint : [];
  if (setNum !== null) {
    pbp = pbp.filter(g => {
      const s = g.set ?? g.set_number ?? g.setNumber ?? null;
      if (s === null) return false;
      const n = typeof s === 'number' ? s : parseInt(String(s).replace(/\D+/g, ''), 10);
      return !isNaN(n) && n === setNum;
    });
  }
  let aGames = 0, aHolds = 0, bGames = 0, bHolds = 0;
  for (const game of pbp) {
    const server = (game.player_served || '').toLowerCase();
    if (!server) continue;
    const isA = server.includes('first');
    const winner = game.serve_winner;
    const lost   = game.serve_lost;
    if (winner === null && lost === null) continue;
    let held;
    if (typeof winner === 'number' && typeof lost === 'number') held = winner > lost;
    else if (typeof winner === 'string') held = winner.toLowerCase().includes(isA ? 'first' : 'second');
    else held = Boolean(winner);
    if (isA) { aGames++; if (held) aHolds++; }
    else     { bGames++; if (held) bHolds++; }
  }
  return {
    playerA: aGames > 0 ? parseFloat(((aHolds / aGames) * 100).toFixed(1)) : null,
    playerB: bGames > 0 ? parseFloat(((bHolds / bGames) * 100).toFixed(1)) : null,
    aGames, bGames,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function sep(title) {
  console.log('\n' + '═'.repeat(60));
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function show(label, value) {
  const str = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  console.log(`  ${label}:`, str);
}

async function run() {
  // ── 1. Livescore ──────────────────────────────────────────────────────────
  sep('1. get_livescore — raw API response');
  const liveResp = await get({ method: 'get_livescore' });
  const allResults = Array.isArray(liveResp.data?.result) ? liveResp.data.result : [];
  console.log(`  Total events returned: ${allResults.length}`);

  const singles = allResults.filter(e =>
    String(e.event_live) === '1' &&
    String(e.event_status || '').toLowerCase() !== 'finished' &&
    !String(e.event_first_player  || '').includes('/') &&
    !String(e.event_second_player || '').includes('/')
  );
  console.log(`  Live singles (non-finished): ${singles.length}`);

  if (singles.length === 0) {
    console.log('\n  ⚠ No live singles matches right now — showing first raw result instead for field inspection');
    if (allResults.length > 0) {
      console.log('\n  FIRST RAW RESULT (all fields):');
      console.log(JSON.stringify(allResults[0], null, 2));
    }
  } else {
    const m = singles[0];

    sep('2. First live singles match — ALL RAW FIELDS');
    console.log(JSON.stringify(m, null, 2));

    sep('3. Parse function outputs for this match');
    show('matchName',       `${m.event_first_player} v ${m.event_second_player}`);
    show('event_key',       m.event_key);
    show('first_player_key',  m.first_player_key);
    show('second_player_key', m.second_player_key);
    show('event_status',   m.event_status);
    show('event_final_result (raw)', m.event_final_result);
    show('event_game_result (raw)',  m.event_game_result);
    show('event_serve (raw)',        m.event_serve);
    show('tournament_round (raw)',   m.tournament_round);
    show('scores[] (raw)',           m.scores);
    show('pointbypoint length',      (m.pointbypoint || []).length);
    console.log();
    show('parseSets()',       parseSets(m));
    show('parseGameScore()', parseGameScore(m));
    show('parseServer()',    parseServer(m));
    console.log();
    console.log('  ─── Round parsing (bug check) ───');
    show('parseRound() OLD (buggy)',  parseRound(m.tournament_round));
    show('parseRound() FIXED',        parseRoundFixed(m.tournament_round));
    console.log();
    console.log('  ─── Serve stats ───');
    show('serveStatsFixed() match',   parseServeStatsFixed(m));
    show('serveStatsFixed() set1',    parseServeStatsFixed(m, 1));
    show('serveStatsFixed() set2',    parseServeStatsFixed(m, 2));
    show('serveHoldRate() overall (fallback)',  serveHoldRate(m));
    show('serveHoldRate() set1 (fallback)',     serveHoldRate(m, 1));
    console.log();
    console.log('  ─── Break points ───');
    show('breakPointsFixed() match',  parseBreakPointsFixed(m));
    show('breakPointsFixed() set1',   parseBreakPointsFixed(m, 1));
    show('breakPoints() OLD (buggy)', parseBreakPoints(m));

    if ((m.pointbypoint || []).length > 0) {
      sep('4. First 2 pointbypoint game entries (raw)');
      console.log(JSON.stringify(m.pointbypoint.slice(0, 2), null, 2));
    } else {
      console.log('\n  ℹ pointbypoint is empty for this match');
    }

    // ── Get standings ────────────────────────────────────────────────────────
    sep('5. get_standings (ATP) — first 5 players');
    try {
      const standResp = await get({ method: 'get_standings', event_type: 'ATP' });
      const standings = Array.isArray(standResp.data?.result) ? standResp.data.result : [];
      console.log(`  Total: ${standings.length}`);
      standings.slice(0, 5).forEach(p => {
        console.log(`  #${p.place} ${p.player} (key: ${p.player_key}) — ${p.points} pts`);
      });

      // Look up the live match player keys in standings
      const p1 = String(m.first_player_key);
      const p2 = String(m.second_player_key);
      const found1 = standings.find(s => String(s.player_key) === p1);
      const found2 = standings.find(s => String(s.player_key) === p2);
      console.log(`\n  Player A (key ${p1}) in standings: ${found1 ? `#${found1.place} ${found1.player}` : 'NOT FOUND'}`);
      console.log(`  Player B (key ${p2}) in standings: ${found2 ? `#${found2.place} ${found2.player}` : 'NOT FOUND (likely WTA or unranked)'}`);
    } catch (err) {
      console.log('  ERROR:', err.message);
    }

    // ── Get player stats ─────────────────────────────────────────────────────
    sep('6. get_players for Player A');
    try {
      const pResp = await get({ method: 'get_players', player_key: m.first_player_key });
      const player = pResp.data?.result?.[0];
      if (player) {
        console.log(`  Name: ${player.player_name}, Country: ${player.player_country}`);
        const statsArr = Array.isArray(player.stats) ? player.stats : [];
        const latest = statsArr.sort((a, b) => (parseInt(b.season)||0) - (parseInt(a.season)||0))[0];
        if (latest) {
          console.log(`  Latest season: ${latest.season}, type: ${latest.type}`);
          console.log(`  Rank: ${latest.rank}, Titles: ${latest.titles}`);
          console.log(`  Hard: ${latest.hard_won}W/${latest.hard_lost}L`);
          console.log(`  Clay: ${latest.clay_won}W/${latest.clay_lost}L`);
          console.log(`  Grass: ${latest.grass_won}W/${latest.grass_lost}L`);
          console.log(`  Overall: ${latest.matches_won}W/${latest.matches_lost}L`);
        } else {
          console.log('  No stats entries returned');
          console.log('  Full player object:', JSON.stringify(player, null, 2));
        }
      } else {
        console.log('  No player found — full response:', JSON.stringify(pResp.data, null, 2));
      }
    } catch (err) {
      console.log('  ERROR:', err.message);
    }

    // ── Get H2H ──────────────────────────────────────────────────────────────
    sep('7. get_H2H');
    try {
      const h2hResp = await get({
        method: 'get_H2H',
        first_player_key:  m.first_player_key,
        second_player_key: m.second_player_key,
      });
      const h2h = h2hResp.data?.result;
      if (h2h) {
        console.log(`  Direct H2H matches: ${(h2h.H2H || []).length}`);
        console.log(`  P1 recent results: ${(h2h.firstPlayerResults || []).length}`);
        console.log(`  P2 recent results: ${(h2h.secondPlayerResults || []).length}`);
        if ((h2h.H2H || []).length > 0) {
          console.log('\n  Most recent H2H match:');
          console.log(JSON.stringify(h2h.H2H[0], null, 2));
        }
      } else {
        console.log('  No H2H data — response:', JSON.stringify(h2hResp.data, null, 2));
      }
    } catch (err) {
      console.log('  ERROR:', err.message);
    }

    // ── Get odds ─────────────────────────────────────────────────────────────
    sep('8. get_odds for this match');
    try {
      const oddsResp = await get({ method: 'get_odds', match_key: m.event_key });
      const oddsData = oddsResp.data?.result;
      if (oddsData && Object.keys(oddsData).length > 0) {
        const matchOdds = oddsData[String(m.event_key)];
        if (matchOdds) {
          console.log('  Markets available:', Object.keys(matchOdds).join(', '));
          console.log(JSON.stringify(matchOdds, null, 2));
        } else {
          console.log('  No odds for this event_key — keys in result:', Object.keys(oddsData));
        }
      } else {
        console.log('  No odds returned (match may not have bookmaker coverage)');
        console.log('  Raw response:', JSON.stringify(oddsResp.data, null, 2).slice(0, 500));
      }
    } catch (err) {
      console.log('  ERROR:', err.message);
    }

    // ── Live odds ─────────────────────────────────────────────────────────────
    sep('9. get_live_odds');
    try {
      const loResp = await get({ method: 'get_live_odds' });
      const loData = loResp.data?.result;
      if (loData && typeof loData === 'object') {
        const keys = Object.keys(loData);
        console.log(`  Matches with live odds: ${keys.length}`);
        if (keys.length > 0) {
          const first = loData[keys[0]];
          console.log(`\n  First match (event_key ${keys[0]}):`);
          console.log(`    Players: ${first.first_player_key} v ${first.second_player_key}`);
          console.log(`    Status: ${first.event_status}`);
          const odds = Array.isArray(first.live_odds) ? first.live_odds : [];
          console.log(`    Live odds markets: ${odds.length}`);
          if (odds.length > 0) {
            console.log('    First 5 odds:');
            odds.slice(0, 5).forEach(o => {
              console.log(`      ${o.odd_name} [${o.type}] = ${o.value} (suspended: ${o.suspended})`);
            });
          }
        }
      } else {
        console.log('  No live odds returned');
        console.log('  Raw:', JSON.stringify(loResp.data, null, 2).slice(0, 300));
      }
    } catch (err) {
      console.log('  ERROR:', err.message);
    }
  }

  // ── WebSocket test ────────────────────────────────────────────────────────
  sep('10. WebSocket — connecting for 15 s to capture first message');
  await new Promise((resolve) => {
    const url = `wss://wss.api-tennis.com/live?APIkey=${API_KEY}`;
    const ws  = new WebSocket(url);
    let received = 0;

    ws.on('open',  () => console.log('  Connected'));
    ws.on('error', (err) => console.log('  WS error:', err.message));

    ws.on('message', (data) => {
      received++;
      try {
        const msg = JSON.parse(String(data));
        if (received === 1) {
          console.log(`\n  First message received (all fields):`);
          console.log(JSON.stringify(msg, null, 2));
        }
      } catch (e) {
        console.log('  Parse error:', e.message);
      }
    });

    ws.on('close', () => {
      console.log(`\n  Disconnected after receiving ${received} message(s)`);
      resolve();
    });

    setTimeout(() => {
      console.log(`\n  Closing after 15 s (received ${received} messages)`);
      ws.terminate();
    }, 15_000);
  });

  sep('DONE');
  console.log('  Review the output above to verify:');
  console.log('  - parseSets() shows correct set scores');
  console.log('  - parseGameScore() shows correct point score');
  console.log('  - parseServer() correctly identifies the server');
  console.log('  - serveHoldRate() has non-null values (if pointbypoint has data)');
  console.log('  - WS message shape matches what livescore returns');
  console.log();
}

run().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
