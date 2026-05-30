// scripts/retroCatchUp.js — replay missed set-end transitions from market_snapshots
//
// Idea: the live engine evaluates strategies on STATE TRANSITIONS (set just ended).
// If the bot is restarting / disconnected during a transition, that moment is gone.
// This script walks every market's snapshot history, detects set-end transitions
// that have no bet or rejection within a tight window (= silent miss), reconstructs
// a synthetic matchState from the snapshot, calls systemEvaluator, and inserts a
// DRY bet (bet_id prefix RETRO-) for any strategy that would have qualified.
//
// Idempotent: bet_id is deterministic per (market, strategy, set-number, transition-ts)
// so re-runs INSERT OR IGNORE. Safe to run on startup AND daily.
//
// Usage:  node scripts/retroCatchUp.js [--hours 24] [--dry]

const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const ROOT       = path.join(__dirname, '..');
const DB_PATH    = path.join(ROOT, 'data', 'tennis-bot.db');
const CFG_PATH   = path.join(ROOT, 'config', 'strategies.json');
const STATE_PATH = path.join(ROOT, 'data', 'retro_catchup.json');

const args = process.argv.slice(2);
const HOURS_BACK = parseInt(args[args.indexOf('--hours') + 1] || '24', 10);
const DRY_RUN    = args.includes('--dry');

const db  = new Database(DB_PATH);
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const systems = (cfg.systems || []).filter(s => s.enabled);
const globalFilters = cfg.filters || {};

// Use the actual systemEvaluator + matchState classes for fidelity
const systemEvaluator = require(path.join(ROOT, 'src/algorithm/systemEvaluator'));
const MatchState      = require(path.join(ROOT, 'src/state/matchState'));

// Load run state — last-processed transition ts per market.
const lastRun = (() => {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (_) { return { markets: {} }; }
})();

// Helper: is set complete (one player has ≥6 with 2-game lead, or won 7-x tiebreak)
function isSetComplete(s) {
  if (!s || s.playerA == null || s.playerB == null) return false;
  const a = s.playerA, b = s.playerB;
  return (a >= 6 && a - b >= 2) || (b >= 6 && b - a >= 2) || a === 7 || b === 7;
}

// Build a synthetic matchState from a snapshot row + markets row.
function reconstructMatchState(market, snap) {
  const s = new MatchState(market.betfair_market_id, market.match_name);
  s.surface       = market.surface || null;
  s.tournament    = market.tournament || null;
  s.preMatchOddsA = market.pre_match_odds_a;
  s.preMatchOddsB = market.pre_match_odds_b;
  s.playerABack   = snap.player_a_back;
  s.playerBBack   = snap.player_b_back;
  s.matchedVolume = snap.matched_volume || 0;
  try { s.sets = snap.sets ? JSON.parse(snap.sets) : []; } catch (_) { s.sets = []; }
  s.currentServer = snap.current_server || null;
  s.momentumIndex = snap.momentum_index ?? 0;
  s.edgeA         = snap.edge_a;
  s.edgeB         = snap.edge_b;
  s.trueProbabilityA = snap.true_prob_a;
  s.trueProbabilityB = snap.true_prob_b;
  // Serve stats are stored as JSON on snapshot
  try {
    const ss = snap.serve_stats ? JSON.parse(snap.serve_stats) : null;
    if (ss) {
      if (ss.match) s.liveServeStats     = ss.match;
      if (ss.set1)  s.liveServeStatsSet1 = ss.set1;
      if (ss.set2)  s.liveServeStatsSet2 = ss.set2;
      if (ss.set3)  s.liveServeStatsSet3 = ss.set3;
    }
  } catch (_) {}
  return s;
}

// For each market with snapshots in the window, walk transitions and find silent misses.
const sinceIso = new Date(Date.now() - HOURS_BACK * 3600_000).toISOString();
const markets = db.prepare(`
  SELECT DISTINCT s.betfair_market_id
  FROM market_snapshots s
  WHERE s.ts >= ?
`).all(sinceIso).map(r => r.betfair_market_id);

console.log(`Scanning ${markets.length} markets with snapshots since ${sinceIso}…`);

const marketInfo  = db.prepare(`SELECT * FROM markets WHERE betfair_market_id = ?`);
const marketSnaps = db.prepare(`
  SELECT * FROM market_snapshots WHERE betfair_market_id = ? AND ts >= ? ORDER BY ts
`);
const betsForMarket = db.prepare(`
  SELECT bet_id, strategy_name, placed_at FROM bets WHERE betfair_market_id = ?
`);
const rejsForMarket = db.prepare(`
  SELECT strategy_name, ts FROM bet_rejections WHERE betfair_market_id = ?
`);

const insertBet = db.prepare(`
  INSERT OR IGNORE INTO bets (
    bet_id, betfair_market_id, strategy_name, sub_strategy,
    player_key, player_name, side,
    requested_odds, actual_odds, stake, size_matched, liability,
    momentum_at_bet, edge_at_bet,
    placed_at, settled_at, settlement_type, pnl,
    dry_run, reason, exit_config
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '{"type":"none"}')
`);

// Determine bet side/player from strategy entry + which set just ended in the snapshot
function planEntry(system, setIdx, sets) {
  const tgt = sets[setIdx];
  if (!tgt) return null;
  const winnerKey = tgt.playerA > tgt.playerB ? 'A' : 'B';
  const loserKey  = winnerKey === 'A' ? 'B' : 'A';
  const e = system.backtest?.entry || {};
  let playerKey;
  if (e.player === 'winner')      playerKey = winnerKey;
  else if (e.player === 'loser')  playerKey = loserKey;
  else                            playerKey = winnerKey;
  return { playerKey, side: e.side || 'BACK', minOdds: e.minOdds, maxOdds: e.maxOdds };
}

let evaluated = 0, fired = 0, skippedDup = 0, skippedFilter = 0;
const newLastRun = { markets: { ...lastRun.markets } };

for (const mid of markets) {
  const market = marketInfo.get(mid);
  if (!market) continue;
  const snaps = marketSnaps.all(mid, sinceIso);
  if (!snaps.length) continue;
  const existingBets = betsForMarket.all(mid).map(b => ({ s: b.strategy_name, t: b.placed_at }));
  const existingRejs = rejsForMarket.all(mid).map(r => ({ s: r.strategy_name, t: r.ts }));

  // Detect set-end transitions using a HIGH-WATER MARK rather than
  // strictly-increasing, because Betfair data flickers (e.g. 6-5 briefly
  // appearing as 6-4 then back to 6-5) which would cause spurious re-fires.
  // Only fire once per (market, completedSetCount).
  let maxComplete = 0;
  const transitions = [];
  for (let i = 0; i < snaps.length; i++) {
    const sn = snaps[i];
    let parsed = null;
    try { parsed = sn.sets ? JSON.parse(sn.sets) : null; } catch (_) {}
    if (!Array.isArray(parsed)) continue;
    const completeLen = parsed.filter(isSetComplete).length;
    if (completeLen > maxComplete) {
      transitions.push({ idx: i, setIdx: completeLen - 1, ts: sn.ts });
      maxComplete = completeLen;
    }
  }

  const lastTs = lastRun.markets[mid] || '1970-01-01T00:00:00Z';
  for (const t of transitions) {
    if (t.ts <= lastTs) continue;  // already processed in a previous run

    const snap = snaps[t.idx];
    const state = reconstructMatchState(market, snap);
    const qualifying = systemEvaluator.evaluateSystems(state, systems, cfg);

    for (const q of qualifying) {
      const system = systems.find(s => s.name === q.systemName);
      if (!system) continue;
      const trigSetNum = system.backtest?.trigger?.setNumber;
      if (trigSetNum && trigSetNum !== t.setIdx + 1) continue;  // only fire on the trigger set
      const plan = planEntry(system, t.setIdx, state.sets);
      if (!plan) continue;

      // Determine real odds at this moment for the planned player
      const odds = plan.playerKey === 'A' ? state.playerABack : state.playerBBack;
      if (odds == null || odds < 1.01) { skippedFilter++; continue; }

      // Strategy-own entry odds gate
      if (plan.minOdds != null && odds < plan.minOdds) { skippedFilter++; continue; }
      if (plan.maxOdds != null && odds > plan.maxOdds) { skippedFilter++; continue; }

      // Global filters
      if (plan.side === 'BACK') {
        if (globalFilters.minOddsToBack != null && odds < globalFilters.minOddsToBack) { skippedFilter++; continue; }
        if (globalFilters.maxOddsToBack != null && odds > globalFilters.maxOddsToBack) { skippedFilter++; continue; }
      } else {
        if (globalFilters.minOddsToLay  != null && odds < globalFilters.minOddsToLay)  { skippedFilter++; continue; }
        if (globalFilters.maxOddsToLay  != null && odds > globalFilters.maxOddsToLay)  { skippedFilter++; continue; }
      }

      // Skip if a real bet or rejection was logged anywhere near this moment OR
      // a synthetic bet (AIMISS / earlier RETRO) already covers it.
      // Window is wide (30 min) because trigger-time and bet-time can drift a lot
      // when a match has score flicker around set ends.
      const transTs = new Date(t.ts).getTime();
      const within = (logged) => {
        const dt = Math.abs(new Date(logged.t).getTime() - transTs);
        return dt <= 30 * 60_000 && logged.s === system.name;
      };
      if (existingBets.some(within) || existingRejs.some(within)) { skippedDup++; continue; }

      // Compute outcome from known final winner
      const winner = market.winner;
      const stake  = system.staking?.stakeGBP ?? cfg.riskManager?.stakeGBP ?? 2;
      const liability = plan.side === 'BACK' ? stake : +(stake * (odds - 1)).toFixed(4);
      let pnl = null, settlement = null;
      if (winner === 'A' || winner === 'B') {
        const betWon = (plan.side === 'BACK' && winner === plan.playerKey)
                    || (plan.side === 'LAY'  && winner !== plan.playerKey);
        pnl = betWon
          ? (plan.side === 'BACK' ? +(stake * (odds - 1)).toFixed(2) : +stake.toFixed(2))
          : (plan.side === 'BACK' ? -stake : -liability);
        settlement = betWon ? 'DRY_WIN' : 'DRY_LOSS';
      }

      // Sub-strategy: if name already encodes side, leave alone
      const subStrategy = /_P[12]$/.test(system.name)
        ? system.name
        : `${system.name}-${plan.playerKey === 'A' ? 'P1' : 'P2'}`;

      const playerName = plan.playerKey === 'A' ? market.player_a_name : market.player_b_name;
      const betId = `RETRO-${mid}-${system.name}-S${t.setIdx + 1}-${Math.floor(new Date(t.ts).getTime() / 1000)}`;

      // Momentum signed for bet player; edge signed for the bet
      const mom = snap.momentum_index != null
        ? (plan.playerKey === 'B' ? -snap.momentum_index : snap.momentum_index)
        : null;
      const rawEdge = plan.playerKey === 'A' ? snap.edge_a : snap.edge_b;
      const edge = rawEdge != null ? (plan.side === 'BACK' ? rawEdge : -rawEdge) : null;

      const tgt = state.sets[t.setIdx];
      const scoreStr = `${tgt.playerA}-${tgt.playerB}`;
      const reasonStr = `[RETRO catch-up] ${system.name}: set ${t.setIdx + 1} complete ${scoreStr}, would have ${plan.side} ${playerName} @ ${odds}`;

      evaluated++;
      if (DRY_RUN) {
        console.log(`  DRY ${betId.slice(0, 60)}… ${plan.side} ${plan.playerKey} @ ${odds}  pnl=${pnl}`);
      } else {
        const info = insertBet.run(
          betId, mid, system.name, subStrategy,
          plan.playerKey, playerName, plan.side,
          odds, odds, stake, stake, liability,
          mom, edge,
          t.ts, market.ended_at || t.ts, settlement, pnl,
          reasonStr.slice(0, 500)
        );
        if (info.changes) fired++;
      }
    }

    newLastRun.markets[mid] = t.ts;
  }
}

if (!DRY_RUN) fs.writeFileSync(STATE_PATH, JSON.stringify(newLastRun, null, 2));

console.log('\n=== Retro catch-up summary ===');
console.log(`  Markets scanned:           ${markets.length}`);
console.log(`  Transitions evaluated:     ${evaluated}`);
console.log(`  Retro bets fired:          ${fired}`);
console.log(`  Skipped (filter):          ${skippedFilter}`);
console.log(`  Skipped (already handled): ${skippedDup}`);

if (!DRY_RUN) {
  console.log('\n=== RETRO bets summary by strategy ===');
  for (const r of db.prepare(`
    SELECT strategy_name, COUNT(*) AS n,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
      ROUND(SUM(pnl), 2) AS pnl,
      ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
    FROM bets WHERE bet_id LIKE 'RETRO-%'
    GROUP BY strategy_name ORDER BY pnl DESC
  `).all()) console.log(' ', r);
}
