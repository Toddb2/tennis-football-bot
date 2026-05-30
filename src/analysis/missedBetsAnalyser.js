'use strict';

/**
 * missedBetsAnalyser.js
 *
 * Nightly replay: walk every market that ended on a given date, reconstruct
 * a minimal matchState at each set boundary from stored market_snapshots, and
 * run evaluateSystems() against it. Any strategy that qualifies but never
 * placed a real bet is logged as a "missed opportunity".
 *
 * Persists per-date in data/missed_bets_history.json, mirroring the
 * strategyAnalyser history pattern so the dashboard can render side tabs.
 *
 * Limitations:
 *   - Snapshot fields used directly. Derived signals (momentumIndex,
 *     liveServeStats, edge_a/edge_b) come from the snapshot row as-is.
 *   - Only set boundaries are checked; mid-set entries not replayed.
 *   - Bet existence matched on (market_id, strategy_name).
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../database/db');
const logger = require('../utils/logger');
const { evaluateSystems } = require('../algorithm/systemEvaluator');
const { inferSurface } = require('../utils/surfaceInference');
const bfbmFilter = require('../execution/bfbmFilter');

const HISTORY_FILE = path.join(__dirname, '../../data/missed_bets_history.json');
const HISTORY_MAX  = 60;
const STRATEGIES_FILE = path.join(__dirname, '../../config/strategies.json');

function _loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    logger.warn('missedBetsAnalyser: failed to read history', { message: e.message });
  }
  return [];
}

function _writeHistory(history) {
  try {
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    logger.error('missedBetsAnalyser: failed to write history', { message: e.message });
  }
}

function getHistory() {
  return _loadHistory().map(({ date, generatedAt, summary }) => ({ date, generatedAt, summary }));
}
function getRun(date) {
  return _loadHistory().find(r => r.date === date) || null;
}

function _loadStrategies() {
  try { return JSON.parse(fs.readFileSync(STRATEGIES_FILE, 'utf8')); }
  catch (e) {
    logger.error('missedBetsAnalyser: cannot read strategies.json', { message: e.message });
    return { systems: [] };
  }
}

function _parseJson(v, fallback = null) {
  if (!v) return fallback;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

/**
 * Hypothetical PnL for a paper bet that never actually placed.
 *
 * BACK: win → stake * (odds - 1), lose → -stake.
 * LAY : win → stake (you keep the layer's stake), lose → -stake * (odds - 1).
 *
 * Returns { stake, odds, pnl, settlement } or null if we can't determine outcome.
 */
function _hypotheticalPnL({ playerKey, side, oddsA, oddsB, winner, stake }) {
  if (!playerKey || !side || !winner) return null;
  const odds = playerKey === 'A' ? oddsA : oddsB;
  if (!odds || odds <= 1) return null;
  const won = (playerKey === winner);
  let pnl;
  if (side === 'BACK') pnl = won ? stake * (odds - 1) : -stake;
  else                 pnl = won ? -stake * (odds - 1) :  stake;
  return {
    stake,
    odds,
    pnl: Math.round(pnl * 100) / 100,
    settlement: won === (side === 'BACK') ? 'WIN' : 'LOSS',
  };
}

function _isSetComplete(set) {
  if (!set) return false;
  const a = set.playerA ?? 0, b = set.playerB ?? 0;
  const max = Math.max(a, b);
  if (max < 6) return false;
  if (max === 7) return true;
  return (max - Math.min(a, b)) >= 2;
}
function _countCompletedSets(sets) { return (sets || []).filter(_isSetComplete).length; }

// Derive the (playerKey, side, requestedOdds) a real bet would have used, so
// the Filter Lab gate sees the same signal shape index.js would have built.
function _signalShape(system, snap, state, qualifying) {
  const entry = system.backtest?.entry || {};
  const trig  = system.backtest?.trigger || {};
  let playerKey = null;
  if (trig.loserMustBe === 'A')      playerKey = entry.player === 'loser' ? 'A' : 'B';
  else if (trig.loserMustBe === 'B') playerKey = entry.player === 'loser' ? 'B' : 'A';
  const side = entry.side || 'BACK';
  const requestedOdds = playerKey === 'A' ? snap.player_a_back
                      : playerKey === 'B' ? snap.player_b_back
                      : null;
  // Match the bets.momentum_at_bet convention: bet player's momentum
  // (player-A snapshot value flipped only on playerKey, not on side).
  const momentumIndex = (snap.momentum_index ?? 0) * (playerKey === 'A' ? 1 : -1);
  return {
    strategyName:  qualifying.systemName,
    playerKey, side, requestedOdds,
    surface:       state.surface,
    tournament:    state.tournament,
    matchedVolume: state.matchedVolume,
    momentumIndex,
    edgeAtBet:     playerKey === 'A' ? state.edgeA : state.edgeB,
    sqDiffS1: null, sqDiffS2: null, sqChange: null, sqDiffTrigger: null,
    dryRun: true,
  };
}

function _buildSyntheticState(market, snapshot) {
  const sets = _parseJson(snapshot.sets, []);
  const serveStats = _parseJson(snapshot.serve_stats, {});
  return {
    matchName:        market.match_name,
    surface:          market.surface || inferSurface({ tournament: market.tournament }),
    tournament:       market.tournament,
    tournamentTier:   null,
    preMatchOddsA:    market.pre_match_odds_a ?? null,
    preMatchOddsB:    market.pre_match_odds_b ?? null,
    playerABack:      snapshot.player_a_back ?? null,
    playerBBack:      snapshot.player_b_back ?? null,
    edgeA:            snapshot.edge_a ?? 0,
    edgeB:            snapshot.edge_b ?? 0,
    momentumIndex:    snapshot.momentum_index ?? 0,
    matchedVolume:    snapshot.matched_volume ?? 0,
    sets,
    currentServer:    snapshot.current_server || null,
    liveServeStats:   serveStats || {},
    totalGamesPlayed: () => (sets || []).reduce(
      (s, set) => s + (set.playerA ?? 0) + (set.playerB ?? 0), 0
    ),
  };
}

function runForDate(date) {
  const strategies = _loadStrategies();
  const systems    = strategies.systems || [];
  // Same hard floor strategyEngine enforces: a bet only fires if the market
  // had this much volume matched at trigger. Sub-floor markets are correctly
  // skipped by the live bot, not missed — so the analyser must apply the
  // same gate or it floods the "missed" list with low-vol ITF qualifiers.
  const minVolumeAtTrigger = strategies.liquidity?.minVolumeAtTrigger ?? 100000;

  const markets = db.prepare(`
    SELECT betfair_market_id, match_name, tournament, surface,
           pre_match_odds_a, pre_match_odds_b, final_sets, winner, ended_at
      FROM markets
     WHERE substr(COALESCE(ended_at, ''), 1, 10) = ?
  `).all(date);

  const realBets = db.prepare(`
    SELECT DISTINCT betfair_market_id, strategy_name
      FROM bets
     WHERE substr(placed_at, 1, 10) = ?
  `).all(date);
  const realBetKey = new Set(realBets.map(b => b.betfair_market_id + '|' + b.strategy_name));

  // Risk-manager / other deliberate rejections — these are not "missed", they
  // were rejected by design (e.g. one-bet-per-market discipline). Exclude
  // them so the missed list shows only genuine coverage gaps.
  const rejections = db.prepare(`
    SELECT DISTINCT betfair_market_id, strategy_name
      FROM bet_rejections
     WHERE substr(ts, 1, 10) = ?
       AND strategy_name IS NOT NULL
  `).all(date);
  const rejectedKey = new Set(rejections.map(r => r.betfair_market_id + '|' + r.strategy_name));

  const snapsByMarket = new Map();
  const placeholders = markets.map(() => '?').join(',') || "''";
  const allSnaps = db.prepare(`
    SELECT betfair_market_id, ts, player_a_back, player_a_lay,
           player_b_back, player_b_lay, matched_volume,
           true_prob_a, true_prob_b, edge_a, edge_b,
           sets, current_game, current_server, serve_stats, momentum_index
      FROM market_snapshots
     WHERE betfair_market_id IN (${placeholders})
       AND sets IS NOT NULL
     ORDER BY betfair_market_id, ts
  `).all(...markets.map(m => m.betfair_market_id));
  for (const s of allSnaps) {
    if (!snapsByMarket.has(s.betfair_market_id)) snapsByMarket.set(s.betfair_market_id, []);
    snapsByMarket.get(s.betfair_market_id).push(s);
  }

  const missed = [];
  let evaluated = 0;
  for (const market of markets) {
    const snaps = snapsByMarket.get(market.betfair_market_id) || [];
    if (!snaps.length) continue;
    const seenCount = new Set();

    // A strategy can only fire ONCE per market in real life — when its
    // trigger set completes. The set-1-trigger condition keeps satisfying
    // at set 2 and set 3 boundaries too if we don't dedup, which is what
    // was inflating the missed count ~3-5x. Track which (market, strategy)
    // we've already counted so we report each miss at most once.
    const seenMissForMarket = new Set();
    const qualifiedForMarket = new Set();

    for (const snap of snaps) {
      const completed = _countCompletedSets(_parseJson(snap.sets, []));
      if (completed === 0 || seenCount.has(completed)) continue;
      seenCount.add(completed);
      const state = _buildSyntheticState(market, snap);
      // Volume gate matches strategyEngine. If the market wasn't liquid
      // enough at this set boundary, the live bot would have skipped it
      // (no rejection logged because the check short-circuits). Don't
      // count anything here as missed.
      if ((state.matchedVolume || 0) < minVolumeAtTrigger) continue;
      const qualifying = evaluateSystems(state, systems, strategies);

      for (const q of qualifying) {
        if (qualifiedForMarket.has(q.systemName)) continue;
        qualifiedForMarket.add(q.systemName);
        evaluated++;

        const key = market.betfair_market_id + '|' + q.systemName;
        if (realBetKey.has(key)) continue;
        if (rejectedKey.has(key)) continue;          // rejected by design
        if (seenMissForMarket.has(q.systemName)) continue;

        // Filter Lab gate: a signal blocked by the active Filter Lab profile
        // wouldn't have been written to BFBM, so don't count it as missed.
        const sysDef = systems.find(s => s.name === q.systemName);
        if (sysDef) {
          const verdict = bfbmFilter.passes(_signalShape(sysDef, snap, state, q));
          if (!verdict.ok) continue;
        }

        seenMissForMarket.add(q.systemName);

        const shape = sysDef ? _signalShape(sysDef, snap, state, q) : { playerKey: null, side: null };
        const stake = sysDef?.staking?.stakeGBP ?? strategies.riskManager?.stakeGBP ?? 1;
        const paper = _hypotheticalPnL({
          playerKey: shape.playerKey,
          side:      shape.side,
          oddsA:     snap.player_a_back,
          oddsB:     snap.player_b_back,
          winner:    market.winner,
          stake,
        });

        missed.push({
          marketId:        market.betfair_market_id,
          matchName:       market.match_name,
          tournament:      market.tournament,
          surface:         market.surface,
          strategy:        q.systemName,
          setBoundary:     completed,
          ts:              snap.ts,
          oddsA:           snap.player_a_back,
          oddsB:           snap.player_b_back,
          preMatchOddsA:   market.pre_match_odds_a,
          preMatchOddsB:   market.pre_match_odds_b,
          finalSets:       _parseJson(market.final_sets, null),
          winner:          market.winner,
          reason:          q.reason,
          playerKey:       shape.playerKey,
          side:            shape.side,
          paperStake:      paper?.stake     ?? null,
          paperOdds:       paper?.odds      ?? null,
          paperPnl:        paper?.pnl       ?? null,
          paperSettlement: paper?.settlement ?? null,
        });
      }
    }
  }
  const byStrategy = {};
  for (const m of missed) byStrategy[m.strategy] = (byStrategy[m.strategy] || 0) + 1;

  // Paper-PnL aggregation: only counts misses where we could resolve an outcome
  // (i.e. settled markets with a known winner and valid odds for the bet side).
  let paperPnlTotal = 0, paperWins = 0, paperLosses = 0, paperResolved = 0;
  const paperByStrategy = {};
  for (const m of missed) {
    if (m.paperPnl == null) continue;
    paperResolved++;
    paperPnlTotal += m.paperPnl;
    if (m.paperSettlement === 'WIN') paperWins++; else paperLosses++;
    const s = paperByStrategy[m.strategy] || { count: 0, pnl: 0, wins: 0 };
    s.count++; s.pnl += m.paperPnl;
    if (m.paperSettlement === 'WIN') s.wins++;
    paperByStrategy[m.strategy] = s;
  }
  // Round for display
  paperPnlTotal = Math.round(paperPnlTotal * 100) / 100;
  for (const k of Object.keys(paperByStrategy)) {
    paperByStrategy[k].pnl = Math.round(paperByStrategy[k].pnl * 100) / 100;
  }

  return {
    date,
    generatedAt: new Date().toISOString(),
    summary: {
      marketsScanned:     markets.length,
      qualifyingSignals:  evaluated,
      missedCount:        missed.length,
      realBetsPlaced:     realBets.length,
      rejectedByDesign:   rejections.length,
      byStrategy,
      paperResolved,
      paperWins,
      paperLosses,
      paperPnlTotal,
      paperByStrategy,
    },
    missed,
  };
}

function runAndStore(date) {
  const run = runForDate(date);
  const history = _loadHistory().filter(r => r.date !== date);
  history.unshift(run);
  _writeHistory(history);
  logger.info('missedBetsAnalyser: stored run', {
    date, marketsScanned: run.summary.marketsScanned, missed: run.summary.missedCount,
  });
  return run;
}

function yesterdayUtc() {
  return new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
}

let _timer = null;
function startNightlyJob() {
  if (_timer) clearTimeout(_timer);
  const now = new Date();
  const next = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  _timer = setTimeout(() => {
    try { runAndStore(yesterdayUtc()); }
    catch (e) { logger.error('missedBetsAnalyser: nightly run failed', { message: e.message }); }
    startNightlyJob();
  }, delay);
  logger.info('missedBetsAnalyser: nightly job scheduled', { firesAt: next.toISOString() });
}

module.exports = {
  runForDate, runAndStore, getHistory, getRun, yesterdayUtc, startNightlyJob,
  // Reusable evaluation helpers shared with candidateSim.js (additive — do not remove).
  buildSyntheticState: _buildSyntheticState,
  hypotheticalPnL:     _hypotheticalPnL,
  signalShape:         _signalShape,
  countCompletedSets:  _countCompletedSets,
  parseJson:           _parseJson,
};
