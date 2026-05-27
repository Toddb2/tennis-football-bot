'use strict';

/**
 * index.js — Tennis Trading Bot entry point
 *
 * Startup sequence:
 *   1. Load .env and config/strategies.json
 *   2. Initialise logger
 *   3. Initialise Telegram notifier
 *   4. Login to Betfair — exit and alert on failure
 *   5. Load historical player stats
 *   6. Start Betfair streaming client
 *   7. Start stats poller (15 s interval)
 *   8. Start main signal loop (5 s interval)
 *   9. Send startup Telegram notification
 *
 * Main loop (every 5 s):
 *   For each LIVE in-play match → evaluate signal → risk check → execute
 *
 * Graceful shutdown (SIGINT / SIGTERM):
 *   Stop loops → cancel all open orders → log state → notify Telegram → exit
 */

// ---------------------------------------------------------------------------
// 1. Environment + config
// ---------------------------------------------------------------------------
require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const STRATEGIES_PATH = path.join(__dirname, '../config/strategies.json');

/** Load strategies.json — all algorithm/risk thresholds live here. */
function loadStrategies() {
  try {
    return JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf8'));
  } catch (err) {
    // Non-fatal: modules fall back to their own defaults
    logger.warn('index: could not load strategies.json — using defaults', { message: err.message });
    return {};
  }
}

/**
 * Watch strategies.json for changes and hot-reload without restart.
 * Uses setInterval + stat polling rather than fs.watchFile, which can lose
 * track of files that are atomically replaced on Windows.
 */
let _strategyWatchTimer = null;

function watchStrategies() {
  let lastMtime = 0;
  try { lastMtime = fs.statSync(STRATEGIES_PATH).mtimeMs; } catch (_) {}

  _strategyWatchTimer = setInterval(() => {
    let mtime = 0;
    try { mtime = fs.statSync(STRATEGIES_PATH).mtimeMs; } catch (_) { return; }
    if (mtime === lastMtime) return;
    lastMtime = mtime;

    const reloaded = loadStrategies();
    if (!reloaded || Object.keys(reloaded).length === 0) return;

    const prevSystemNames = (strategies.systems || []).map(s => s.name).sort().join(',');
    const newSystemNames  = (reloaded.systems  || []).map(s => s.name).sort().join(',');

    strategies = reloaded;

    // Update Telegram with the latest strategies so /matches etc. reflect changes
    if (telegram) telegram._strategies = strategies;

    // Clear strategy-fired cache so updated/re-enabled systems re-evaluate
    _strategyFired.clear();

    logger.info('index: strategies.json reloaded', {
      systems:  (strategies.systems || []).length,
      changed:  prevSystemNames !== newSystemNames,
    });

    // Tell dashboard clients to refresh their Systems tab
    dashboard.broadcast('config_updated', {
      systems: (strategies.systems || []).map(s => ({ name: s.name, enabled: s.enabled })),
    });
  }, 1000);

  if (_strategyWatchTimer.unref) _strategyWatchTimer.unref();
  logger.info('index: watching strategies.json for changes (1s poll)');
}

// ---------------------------------------------------------------------------
// 2. Logger (must be first so every module below can use it)
// ---------------------------------------------------------------------------
const logger = require('./utils/logger');

// ---------------------------------------------------------------------------
// Module imports
// ---------------------------------------------------------------------------
const TelegramNotifier  = require('./notifications/telegram');
const BetfairClient     = require('./execution/betfairClient');
const BfbmClient        = require('./execution/bfbmClient');
const bfbmExport        = require('./execution/bfbmExport');
const BetfairStream     = require('./collector/betfairStream');
const CbbStream         = require('./collector/cbbStream');
const StatsPoller       = require('./collector/statsPoller');
const HistoricalLoader  = require('./collector/historicalLoader');
const MarketRecorder    = require('./collector/marketRecorder');
const StateStore        = require('./state/stateStore');
const signalEngine                = require('./algorithm/signalEngine');
const { computeTrueProbability }  = require('./algorithm/probabilityModel');
const { computeMomentum }         = require('./algorithm/momentumDetector');
const systemEvaluator   = require('./algorithm/systemEvaluator');
const strategyEngine    = require('./algorithm/strategyEngine');
const { isSetComplete } = strategyEngine;
const riskManager       = require('./risk/riskManager');
const OrderManager      = require('./execution/orderManager');
const dashboard         = require('./dashboard/server');
const snapshotRepo      = require('./database/snapshotRepo');
const betRepo           = require('./database/betRepo');
const marketRepo        = require('./database/marketRepo');
const systemEventRepo   = require('./database/systemEventRepo');
const priceRepo         = require('./database/priceRepo');

// ---------------------------------------------------------------------------
// Global error handlers (before any async code runs)
// ---------------------------------------------------------------------------

process.on('uncaughtException', async (err) => {
  logger.error('UNCAUGHT EXCEPTION', { message: err.message, stack: err.stack });
  try { await telegram.notifyError(`UNCAUGHT EXCEPTION: ${err.message}`); } catch (_) {}
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error('UNHANDLED REJECTION', { reason: msg });
  try { await telegram.notifyError(`UNHANDLED REJECTION: ${msg}`); } catch (_) {}
  // Don't exit — rejections are often recoverable
});

// ---------------------------------------------------------------------------
// Module-level handles (populated during startup)
// ---------------------------------------------------------------------------
let telegram      = null;
let betfairClient    = null;
let betfairStream    = null;
let cbbStream_cbb    = null;
let marketRecorder   = null;
let statsPoller      = null;
let historicalLoader = null;
let stateStore    = null;
let orderManager  = null;
let strategies    = {};

let mainLoopTimer    = null;
let isLoopRunning    = false;   // prevent overlapping iterations
let isShuttingDown   = false;

/**
 * Tracks which strategy names have already fired for each market.
 * Prevents a strategy from entering more than once per match.
 * Key: marketId, Value: Set<systemName>
 */
const _strategyFired = new Map();

/**
 * Pending entry triggers awaiting the 20s market-inefficiency delay.
 * Key: `${marketId}:${systemName}`, Value: { trigger, detectedAt }
 *
 * Persisted to disk so PM2 restarts inside the 20s window don't silently
 * drop the bet. Only `trigger.system.name` + playerKey/side/reason are saved;
 * the full system object is re-hydrated from strategies.json on boot.
 */
const _pendingTriggers = new Map();
const PENDING_TRIGGERS_FILE = path.join(__dirname, '../data/pending_triggers.json');
const PENDING_TRIGGERS_TTL_MS = 5 * 60 * 1000; // discard anything older than 5min on boot

function _savePendingTriggers() {
  try {
    const rows = [];
    for (const [key, val] of _pendingTriggers.entries()) {
      const t = val && val.trigger;
      if (!t || !t.system || !t.system.name) continue;
      rows.push({
        key,
        systemName: t.system.name,
        playerKey:  t.playerKey,
        side:       t.side,
        reason:     t.reason,
        detectedAt: val.detectedAt,
      });
    }
    fs.writeFileSync(PENDING_TRIGGERS_FILE, JSON.stringify(rows, null, 2), 'utf8');
  } catch (e) {
    logger.warn('index: _savePendingTriggers failed', { message: e.message });
  }
}

function _restorePendingTriggers() {
  try {
    if (!fs.existsSync(PENDING_TRIGGERS_FILE)) return 0;
    const rows = JSON.parse(fs.readFileSync(PENDING_TRIGGERS_FILE, 'utf8'));
    if (!Array.isArray(rows)) return 0;
    const cutoff = Date.now() - PENDING_TRIGGERS_TTL_MS;
    let restored = 0;
    for (const r of rows) {
      if (!r || !r.key || !r.systemName) continue;
      if ((r.detectedAt || 0) < cutoff) continue;
      const system = (strategies.systems || []).find(s => s.name === r.systemName);
      if (!system) continue;  // strategy was deleted while we were down
      const trigger = { system, playerKey: r.playerKey, side: r.side, reason: r.reason };
      _pendingTriggers.set(r.key, { trigger, detectedAt: r.detectedAt });
      restored++;
    }
    return restored;
  } catch (e) {
    logger.warn('index: _restorePendingTriggers failed', { message: e.message });
    return 0;
  }
}

/**
 * Pending hedge trade-outs awaiting the 20s market-inefficiency delay.
 * Key: betId, Value: { detectedAt }
 */
const _pendingHedges = new Map();

// Price milestone tracking — odds captured at pre-match and each set end
const _prevSetCounts             = new Map();  // marketId → completed-set count last loop
const _preMatchMilestoneRecorded = new Set();  // marketIds whose pre-match milestone was saved

function _checkPriceMilestones(matchState) {
  const { betfairMarketId, sets, playerABack, playerBBack, matchedVolume } = matchState;

  // Pre-match: record once when pre-match odds are first captured
  if (matchState.preMatchOddsA && !_preMatchMilestoneRecorded.has(betfairMarketId)) {
    _preMatchMilestoneRecorded.add(betfairMarketId);
    try {
      priceRepo.insertMilestone({
        betfairMarketId,
        milestone:     'pre_match',
        playerABack:   matchState.preMatchOddsA,
        playerBBack:   matchState.preMatchOddsB,
        setScore:      null,
        matchedVolume: matchState.preMatchVolume,
      });
    } catch (_) {}
  }

  // Set completions: record when completed-set count increases
  const completedSets = (sets || []).filter(isSetComplete);
  const prevCount     = _prevSetCounts.get(betfairMarketId) ?? 0;

  if (completedSets.length > prevCount) {
    for (let i = prevCount; i < completedSets.length; i++) {
      const setScore = completedSets.slice(0, i + 1).map(s => `${s.playerA}-${s.playerB}`).join(' ');
      try {
        priceRepo.insertMilestone({
          betfairMarketId,
          milestone:     `set_${i + 1}_end`,
          playerABack,
          playerBBack,
          setScore,
          matchedVolume,
        });
      } catch (_) {}
    }
  }

  _prevSetCounts.set(betfairMarketId, completedSets.length);
}

// Match logging — write a compact record when a live match ends
const MATCH_LOG_PATH = path.join(__dirname, '../data/match_log.jsonl');
const _prevLiveSnapshots = new Map();  // marketId → last matchState snapshot

function logCompletedMatch(snapshot) {
  // Settle any open DRY_RUN bet for this market now that the match is over
  orderManager.settleDryRunOrder(snapshot.betfairMarketId, snapshot);

  try {
    const record = {
      date:           new Date().toISOString().split('T')[0],
      ts:             new Date().toISOString(),
      matchName:      snapshot.matchName,
      tournament:     snapshot.tournament     || null,
      surface:        snapshot.surface        || null,
      sets:           snapshot.sets           || [],
      preMatchOddsA:  snapshot.preMatchOddsA  || null,
      preMatchOddsB:  snapshot.preMatchOddsB  || null,
      matchedVolume:  snapshot.matchedVolume  || null,
      marketId:       snapshot.betfairMarketId,
    };
    fs.appendFileSync(MATCH_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
  } catch (_) {}
}

/**
 * Cooldown for signal logging — prevents the same action on the same market
 * from flooding the log every 5 s.
 * Key: marketId, Value: { action, loggedAt }
 */
const _lastSignalLog = new Map();
const SIGNAL_LOG_COOLDOWN_MS = 60_000;

const MAIN_LOOP_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the bankroll from env — strategies config takes precedence over .env.
 */
function getBankroll() {
  return parseFloat(process.env.BANKROLL_GBP || '1000');
}

/**
 * Build the current exposure snapshot from orderManager for riskManager.check().
 */
function buildExposure() {
  const orders = [...orderManager.openOrders.values()];
  return {
    openPositionCount: orders.length,
    openMarketIds:     orders.map(o => o.marketId),
    openOrders:        orders,
  };
}

/**
 * Build the set of marketIds that already have an open position.
 */
function openMarketSet() {
  return new Set([...orderManager.openOrders.values()].map(o => o.marketId));
}

/**
 * Translate a signal action string to { side, playerKey } for the order calls.
 */
function decodeAction(action) {
  switch (action) {
    case 'BET_BACK_A': return { side: 'BACK', playerKey: 'A' };
    case 'BET_BACK_B': return { side: 'BACK', playerKey: 'B' };
    case 'BET_LAY_A':  return { side: 'LAY',  playerKey: 'A' };
    case 'BET_LAY_B':  return { side: 'LAY',  playerKey: 'B' };
    default:           return null;
  }
}

/**
 * Return the edge % relevant to a bet action from the match state.
 */
function edgeForAction(action, matchState) {
  return action.includes('_A') ? (matchState.edgeA || 0) : (matchState.edgeB || 0);
}

// ---------------------------------------------------------------------------
// Main loop — evaluate every live match
// ---------------------------------------------------------------------------

async function runMainLoop() {
  if (isLoopRunning) {
    logger.debug('index: main loop iteration skipped (previous still running)');
    return;
  }
  isLoopRunning = true;

  try {
    const MIN_VOLUME = strategies.liquidity?.minVolumeAtTrigger ?? 100_000;

    // All in-play LIVE matches — used for probability/edge refresh (dashboard display)
    const allLiveMatches = stateStore.getAll().filter(m => m.isInPlay && m.status === 'LIVE');

    if (allLiveMatches.length === 0) {
      logger.debug('index: no live matches');
      return;
    }

    // Auto-close matches whose set scores show a completed best-of-3 match.
    // Handles the case where Betfair stream goes quiet without sending CLOSED.
    for (const matchState of [...allLiveMatches]) {
      let setsWonA = 0, setsWonB = 0;
      for (const s of (matchState.sets || [])) {
        if (!isSetComplete(s)) continue;
        if (s.playerA > s.playerB) setsWonA++; else setsWonB++;
      }
      if (setsWonA >= 2 || setsWonB >= 2) {
        logger.info('index: auto-closing finished match', {
          marketId: matchState.betfairMarketId,
          matchName: matchState.matchName,
          setsWonA, setsWonB,
        });
        stateStore.close(matchState.betfairMarketId);
      }
    }

    // Volume-qualified matches — used for strategy evaluation / betting
    const liveMatches = allLiveMatches.filter(m =>
      m.matchedVolume >= MIN_VOLUME && m.status !== 'CLOSED'
    );

    // Refresh probability and edge for ALL live matches so the dashboard always
    // shows live values, even for markets below the minimum betting volume.
    for (const matchState of allLiveMatches) {
      if (!liveMatches.includes(matchState)) {
        const probs = computeTrueProbability(matchState, strategies.signalEngine?.probabilityModel || {});
        matchState.trueProbabilityA = probs.playerA;
        matchState.trueProbabilityB = probs.playerB;
        computeMomentum(matchState);
        matchState.recompute();
      }
    }

    const openMarkets = openMarketSet();

    // Prune signal caches for markets no longer live
    const liveMarketIds = new Set(allLiveMatches.map(m => m.betfairMarketId));
    for (const marketId of _lastSignalLog.keys()) {
      if (!liveMarketIds.has(marketId)) _lastSignalLog.delete(marketId);
    }
    for (const marketId of _strategyFired.keys()) {
      if (!liveMarketIds.has(marketId)) _strategyFired.delete(marketId);
    }
    // Prune pending entry triggers for markets no longer live
    let _prunedPending = false;
    for (const key of _pendingTriggers.keys()) {
      const mid = key.split(':')[0];
      if (!liveMarketIds.has(mid)) { _pendingTriggers.delete(key); _prunedPending = true; }
    }
    if (_prunedPending) _savePendingTriggers();
    // Prune pending hedges for bets no longer open
    const _openBetIds = new Set(orderManager.openOrders.keys());
    for (const betId of _pendingHedges.keys()) {
      if (!_openBetIds.has(betId)) _pendingHedges.delete(betId);
    }

    // Log completed matches (markets that were live last loop but are gone now)
    for (const [marketId, snapshot] of _prevLiveSnapshots.entries()) {
      if (!liveMarketIds.has(marketId)) {
        logCompletedMatch(snapshot);
        // Record match-end price milestone
        try {
          priceRepo.insertMilestone({
            betfairMarketId: marketId,
            milestone:       'match_end',
            playerABack:     snapshot.odds?.playerABack ?? snapshot.playerABack,
            playerBBack:     snapshot.odds?.playerBBack ?? snapshot.playerBBack,
            setScore:        (snapshot.sets || []).filter(isSetComplete)
                               .map(s => `${s.playerA}-${s.playerB}`).join(' ') || null,
            matchedVolume:   snapshot.odds?.matchedVolume ?? snapshot.matchedVolume,
          });
        } catch (_) {}
        _prevLiveSnapshots.delete(marketId);
        _prevSetCounts.delete(marketId);
        _preMatchMilestoneRecorded.delete(marketId);
      }
    }
    // Update snapshot store
    for (const m of allLiveMatches) {
      _prevLiveSnapshots.set(m.betfairMarketId, m.toSnapshot ? m.toSnapshot() : m);
    }

    // Check for new price milestones (pre-match capture + set completions)
    for (const matchState of allLiveMatches) {
      _checkPriceMilestones(matchState);
    }

    // Settle stale DRY_RUN bets for markets that are no longer live
    // (handles the case where bot restarted after a match ended, OR the
    // Betfair stream dropped the market before settlement). Tries in order:
    //   1. parse last DB snapshot and pass to settleDryRunOrder
    //   2. if that gives up (sets tied, no extreme odds), query api-tennis
    //      via external_match_id and force-settle with the official winner
    const _settledStaleMarkets = new Set();
    for (const [betId, order] of orderManager.openOrders.entries()) {
      if (order.dryRun && !liveMarketIds.has(order.marketId) && !_settledStaleMarkets.has(order.marketId)) {
        _settledStaleMarkets.add(order.marketId);
        logger.info('index: settling stale DRY_RUN order — market no longer live', {
          marketId: order.marketId, matchName: order.matchName,
        });
        try {
          const snaps = snapshotRepo.getForMarket(order.marketId);
          const lastSnap = snaps.length ? snaps[snaps.length - 1] : null;
          // Parse JSON fields stored as strings in SQLite so settleDryRunOrder
          // can read snapshot.sets as an array (raw DB row gives a string).
          const parsedSnap = lastSnap ? {
            ...lastSnap,
            sets: (() => { try { return JSON.parse(lastSnap.sets || '[]'); } catch (_) { return []; } })(),
            playerABack: lastSnap.player_a_back,
            playerBBack: lastSnap.player_b_back,
          } : {};
          const settled = orderManager.settleDryRunOrder(order.marketId, parsedSnap);
          if (settled !== false && orderManager.getOpenPositionForMarket(order.marketId)) {
            // Snapshot couldn't determine winner — fall back to api-tennis.
            await _settleViaApiTennis(order.marketId).catch(e =>
              logger.warn('index: api-tennis fallback failed', { marketId: order.marketId, message: e.message }));
          }
        } catch (e) {
          logger.warn('index: stale settle threw', { marketId: order.marketId, message: e.message });
        }
      }
    }

    for (const matchState of liveMatches) {
      await evaluateMatch(matchState, openMarkets);
    }

    // Write market snapshots to DB for all live markets (every loop = every 5s)
    try {
      if (allLiveMatches.length > 0) {
        snapshotRepo.writeMany(allLiveMatches);
      }
    } catch (e) {
      logger.error('index: snapshotRepo.writeMany failed', { message: e.message });
    }

    // Broadcast live state to dashboard clients
    dashboard.broadcast('state_update', {
      matches:    dashboard.getMatchSnapshots(),
      openOrders: [...orderManager.openOrders.values()],
    });

    dashboard.broadcast('status', {
      openBets:       orderManager.openOrders.size,
      marketsWatched: stateStore.matches.size,
      exposure:       orderManager.getTotalExposure(),
    });
  } catch (err) {
    logger.error('index: main loop error', { message: err.message, stack: err.stack });
  } finally {
    isLoopRunning = false;
  }
}

/**
 * Evaluate one match: strategy trigger check → risk check → execute.
 *
 * Entry logic: strategy-based (set-result triggers from strategies.json backtest config).
 * Exit logic:  set-hedge (fires when the system's exit set result is met).
 *              Emergency close: if market suspends/closes with an open position.
 */
async function evaluateMatch(matchState, openMarkets) {
  const marketId     = matchState.betfairMarketId;

  // Refresh probability, momentum, and edge so dashboard shows live values
  const probs = computeTrueProbability(matchState, strategies.signalEngine?.probabilityModel || {});
  matchState.trueProbabilityA = probs.playerA;
  matchState.trueProbabilityB = probs.playerB;
  computeMomentum(matchState);
  matchState.recompute();

  // ── 1. Manage ALL open positions on this market ───────────────────────────
  const openPositions = orderManager.getOpenPositionsForMarket(marketId);

  if (openPositions.length > 0) {
    // Set-result hedges — fire for each order that has one configured
    for (const pos of openPositions) {
      await checkSetHedge(matchState, pos);
    }

    // Dry-run fallback settlement
    const hasDryRun = openPositions.some(p => p.dryRun);
    if (hasDryRun) checkDryRunMatchEnd(matchState);

    // Emergency exit — market closed/suspended
    if (matchState.status === 'CLOSED' || matchState.status === 'SUSPENDED') {
      for (const pos of openPositions) {
        const emergencyOdds = pos.playerKey === 'A' ? matchState.playerABack : matchState.playerBBack;
        if (emergencyOdds) {
          logger.warn('index: emergency exit — market closed/suspended with open position', { marketId });
          await handleTradeOut(matchState, pos, {
            action: 'TRADE_OUT',
            reason: `Market ${matchState.status} — emergency close`,
            suggestedOdds: emergencyOdds,
            confidence: 1,
            marketId,
          });
        }
      }
      // Purge any BFBM signals for this closed market so they can't be re-bound
      // by BFBM to a later fixture with the same player name.
      try { bfbmExport.removeMarketSignals(marketId); } catch (_) {}
      openMarkets.delete(marketId);
      return;
    }
  } else if (matchState.status === 'CLOSED' || matchState.status === 'SUSPENDED') {
    // No open position but market closed — still purge any signals we wrote.
    try { bfbmExport.removeMarketSignals(marketId); } catch (_) {}
  }

  // ── 2. Strategy trigger evaluation ────────────────────────────────────────
  // (Continue regardless of open positions — _strategyFired guards re-entry per strategy)
  const firedSet = _strategyFired.get(marketId) || new Set();
  const { triggers, rejections } = strategyEngine.evaluateStrategies(
    matchState,
    strategies.systems || [],
    firedSet,
    { ...(strategies.liquidity || {}), globalFilters: strategies.filters || {} }
  );

  // Log strategy rejections to DB (once per strategy per market, throttled to avoid spam)
  // Only log when there are completed sets (i.e. strategy had a chance to fire)
  if (rejections.length > 0 && (matchState.sets || []).some(strategyEngine.isSetComplete)) {
    const lastLog = _lastSignalLog.get(marketId);
    const now = Date.now();
    if (!lastLog || now - lastLog.loggedAt > SIGNAL_LOG_COOLDOWN_MS) {
      for (const rej of rejections) {
        try {
          betRepo.insertRejection({
            betfairMarketId: marketId,
            matchName:       matchState.matchName,
            strategyName:    rej.systemName,
            rejectionStage:  rej.stage,
            rejectionReason: rej.reason,
            odds:            matchState.playerABack,
          });
        } catch (_) {}
      }
    }
  }

  if (triggers.length === 0) {
    // Log set state once per market per minute so we can see why strategies aren't firing
    const lastLog = _lastSignalLog.get(marketId);
    const now = Date.now();
    if (!lastLog || now - lastLog.loggedAt > SIGNAL_LOG_COOLDOWN_MS) {
      _lastSignalLog.set(marketId, { action: 'waiting', loggedAt: now });
      const completedSets = (matchState.sets || []).filter(strategyEngine.isSetComplete);
      const enabledSystems = (strategies.systems || []).filter(s => s.enabled && !firedSet.has(s.name));
      logger.info('index: waiting for trigger', {
        marketId,
        matchName:     matchState.matchName,
        sets:          matchState.sets,
        completedSets: completedSets.length,
        statsLinked:   !!matchState.externalMatchId,
        enabledSystems: enabledSystems.map(s => s.name),
        preMatchOddsA: matchState.preMatchOddsA,
        preMatchOddsB: matchState.preMatchOddsB,
        playerABack:   matchState.playerABack,
        playerBBack:   matchState.playerBBack,
        rejections:    rejections.map(r => `${r.systemName}: ${r.stage}`),
      });
    }
    return;
  }

  // ── 3. Entry — 20s delayed trigger execution ─────────────────────────────
  //
  // Phase A: record any newly detected triggers (start the 20s clock).
  // Phase B: execute any pending triggers whose 20s window has elapsed.
  //
  // This lets odds settle after a set ends before we enter the position.
  const ENTRY_DELAY_MS = 20_000;

  // Phase A — record new triggers. Telegram + BFBM both wait until the bet
  // actually fires (see handleEntry), so detection here is silent.
  let _pendingDirty = false;
  for (const trigger of triggers) {
    const pendingKey = `${marketId}:${trigger.system.name}`;
    if (_pendingTriggers.has(pendingKey) || firedSet.has(trigger.system.name)) continue;

    _pendingTriggers.set(pendingKey, { trigger, detectedAt: Date.now() });
    _pendingDirty = true;

    logger.info('index: strategy trigger detected — waiting 20s before entry', {
      marketId, matchName: matchState.matchName, system: trigger.system.name,
    });
  }

  // Phase B — execute triggers whose 20s delay has elapsed
  for (const [pendingKey, pending] of _pendingTriggers.entries()) {
    if (!pendingKey.startsWith(`${marketId}:`)) continue;
    const systemName = pendingKey.slice(marketId.length + 1);

    if (firedSet.has(systemName)) {
      _pendingTriggers.delete(pendingKey);
      _pendingDirty = true;
      continue;
    }
    if (Date.now() - pending.detectedAt < ENTRY_DELAY_MS) continue;

    // Delay elapsed — execute the entry using CURRENT market odds
    _pendingTriggers.delete(pendingKey);
    _pendingDirty = true;
    const { trigger } = pending;
    const { system, playerKey, side, reason } = trigger;

    firedSet.add(system.name);

    const currentOdds = playerKey === 'A' ? matchState.playerABack : matchState.playerBBack;

    // Re-validate the entry odds band against the freshly-read price. The
    // strategyEngine already enforced this at detection time; we re-check
    // here because odds can drift during the 20s settle window. Without this,
    // a bet whose odds drift outside the band fires silently outside the band
    // and the miss is invisible in bet_rejections. With it, the skip is
    // logged so missedBetsAnalyser can attribute the gap correctly.
    const entry = system.backtest?.entry || {};
    if (currentOdds != null) {
      const oobReason =
        (entry.minOdds != null && currentOdds < entry.minOdds)
          ? `Post-delay odds ${currentOdds.toFixed(2)} < min ${entry.minOdds}`
        : (entry.maxOdds != null && currentOdds > entry.maxOdds)
          ? `Post-delay odds ${currentOdds.toFixed(2)} > max ${entry.maxOdds}`
        : null;
      if (oobReason) {
        logger.info('index: strategy entry skipped — odds drifted outside band during 20s wait', {
          marketId, matchName: matchState.matchName, system: system.name, currentOdds,
          minOdds: entry.minOdds, maxOdds: entry.maxOdds,
        });
        try {
          betRepo.insertRejection({
            betfairMarketId: marketId,
            matchName:       matchState.matchName,
            strategyName:    system.name,
            rejectionStage:  'ENTRY_ODDS_DELAYED',
            rejectionReason: oobReason,
            odds:            currentOdds,
          });
        } catch (_) {}
        continue;
      }
    }

    logger.info('index: strategy trigger firing after 20s delay', {
      marketId, matchName: matchState.matchName,
      system: system.name, playerKey, side, currentOdds, reason,
    });

    const action = `BET_${side}_${playerKey}`;
    const decision = { action, suggestedOdds: currentOdds, reason, confidence: 1, marketId };

    const systemForEntry = {
      systemName:  system.name,
      description: system.description,
      staking:     system.staking,
      exit:        system.exit || null,
    };

    await handleEntry(matchState, decision, openMarkets, systemForEntry);
  }

  _strategyFired.set(marketId, firedSet);
  if (_pendingDirty) _savePendingTriggers();
}

/**
 * Check whether a specific open order has met its system-defined set-result
 * hedge condition, and if so trigger a trade-out automatically.
 *
 * Called every loop iteration for each open order on the market.
 * Returns true if a hedge was triggered.
 */
async function checkSetHedge(matchState, order) {
  if (!order || !order.exitConfig) return false;
  const { betfairMarketId, sets } = matchState;

  const { type, setNumber } = order.exitConfig;
  if (type !== 'set_result') return false;

  // Count only definitively completed sets (excludes in-progress last set)
  const completedSets = (sets || []).filter(isSetComplete).length;
  if (completedSets < setNumber) return false;       // target set not finished yet
  if (order.setsAtEntry >= setNumber) return false;  // was already done when we entered

  // Target set must be fully complete
  const targetSet = sets[setNumber - 1];
  if (!targetSet || !isSetComplete(targetSet)) return false;

  // Enforce 20s delay so the market can settle its price after the set ends
  const HEDGE_DELAY_MS = 20_000;
  if (!_pendingHedges.has(order.betId)) {
    _pendingHedges.set(order.betId, { detectedAt: Date.now() });
    logger.info('index: set-hedge condition met — waiting 20s', {
      marketId: betfairMarketId, matchName: matchState.matchName,
      setNumber, playerKey: order.playerKey, betId: order.betId,
    });
    return false;
  }
  if (Date.now() - _pendingHedges.get(order.betId).detectedAt < HEDGE_DELAY_MS) return false;

  _pendingHedges.delete(order.betId);

  logger.info('index: set-hedge executing after 20s delay', {
    marketId: betfairMarketId,
    matchName: matchState.matchName,
    setNumber,
    playerKey: order.playerKey,
    betId: order.betId,
  });

  const selectionId = order.playerKey === 'A' ? matchState.runnerIdA : matchState.runnerIdB;
  const greenupOdds = order.playerKey === 'A' ? matchState.playerABack : matchState.playerBBack;

  if (!greenupOdds) {
    logger.warn('index: set-hedge — no price available to hedge at', { marketId: betfairMarketId });
    return false;
  }

  const settled = await orderManager.tradeOut(
    order.betId, selectionId, greenupOdds,
    { matchName: matchState.matchName, reason: `Set ${setNumber} result hedge` }
  );

  if (!settled) return false;

  const profit = settled.estimatedPnL || 0;
  await telegram.notifyTradeOut({
    matchName: matchState.matchName, profit,
    reason: `Set ${setNumber} result hedge`,
  });
  dashboard.broadcast('trade_out', { matchName: matchState.matchName, profit });

  return true;
}

/**
 * DRY_RUN safety-net: settle a fake open bet if the match appears finished.
 * Used when the stream goes quiet instead of sending a CLOSED status, which
 * would normally trigger settleDryRunOrder via the _prevLiveSnapshots mechanism.
 *
 * Considers the match over if:
 *   (a) One player's back price collapses to ≤ 1.05 (winner essentially decided), OR
 *   (b) The set scores show a best-of-3 winner (2 completed sets won by same player).
 *
 * Returns true if settlement was triggered.
 */
/**
 * Last-resort settle path for stale DRY_RUN bets — when the on-disk
 * snapshot doesn't show enough to determine a winner (sets tied, no
 * extreme odds, retired match, etc.), query api-tennis using the market's
 * stored external_match_id and force-settle with the official outcome.
 */
async function _settleViaApiTennis(marketId) {
  const market = marketRepo.getById(marketId);
  const extId  = market?.external_match_id;
  if (!extId) return;
  const matchKey = String(extId).replace(/^at:/, '');
  const axios = require('axios');
  const r = await axios.get('https://api.api-tennis.com/tennis/', {
    params: {
      method:     'get_fixtures',
      APIkey:     process.env.API_TENNIS_KEY,
      match_key:  matchKey,
      date_start: (market.created_at || new Date().toISOString()).slice(0, 10),
      date_stop:  new Date().toISOString().slice(0, 10),
    },
    timeout: 8000,
  });
  const fx = r.data?.result?.[0];
  if (!fx) return;
  const winnerLabel = fx.event_winner; // "First Player" | "Second Player" | null
  if (winnerLabel !== 'First Player' && winnerLabel !== 'Second Player') return;
  const winner = winnerLabel === 'First Player' ? 'A' : 'B';
  // Build a synthetic snapshot whose `sets` array forces the chosen winner.
  // settleDryRunOrder's set-based path picks A if setsA > setsB (or B reversed).
  const fakeSets = winner === 'A'
    ? [{ playerA: 6, playerB: 0 }, { playerA: 6, playerB: 0 }]
    : [{ playerA: 0, playerB: 6 }, { playerA: 0, playerB: 6 }];
  logger.info('index: api-tennis settling stale match', {
    marketId, matchName: market.match_name, winner, eventStatus: fx.event_status,
  });
  orderManager.settleDryRunOrder(marketId, { sets: fakeSets });
}

function checkDryRunMatchEnd(matchState) {
  const { betfairMarketId } = matchState;
  const order = orderManager.getOpenPositionForMarket(betfairMarketId);
  if (!order || !order.dryRun) return false;

  // If the bet has a set-result exit config, extreme odds mid-set are not a reliable
  // match-end signal — a player can be at 1.02 while serving for the set at 5-4, then
  // lose. Only the set-score path is safe for these bets.
  const exitCfg = (() => { try { return JSON.parse(order.exitConfig || 'null'); } catch(_) { return null; } })();
  const hasSetHedge = exitCfg?.type === 'set_result';

  // (a) Extreme odds — one player has effectively won (skip for set-hedge bets)
  const oddsA = matchState.playerABack;
  const oddsB = matchState.playerBBack;
  const oddsExtreme = !hasSetHedge &&
    ((oddsA != null && oddsA <= 1.05) || (oddsB != null && oddsB <= 1.05));

  // (b) Best-of-3 set winner determined from completed set scores
  let setsWonA = 0;
  let setsWonB = 0;
  for (const s of (matchState.sets || [])) {
    if (!isSetComplete(s)) continue;
    if (s.playerA > s.playerB) setsWonA++; else setsWonB++;
  }
  const setWinnerFound = setsWonA >= 2 || setsWonB >= 2;

  if (!oddsExtreme && !setWinnerFound) return false;

  logger.info('index: dry-run match-end detected — force settling open position', {
    marketId:    betfairMarketId,
    matchName:   matchState.matchName,
    oddsExtreme,
    setWinnerFound,
    setsWonA,
    setsWonB,
  });

  orderManager.settleDryRunOrder(betfairMarketId, matchState);
  try { bfbmExport.removeMarketSignals(betfairMarketId); } catch (_) {}
  return true;
}

/**
 * Execute a TRADE_OUT signal — green up the open position.
 */
async function handleTradeOut(matchState, openPosition, decision) {
  if (!openPosition) return;

  const marketId = matchState.betfairMarketId;
  const selectionId  = openPosition.selectionId;
  // Lay price for the player we are long
  const currentLayOdds = openPosition.playerKey === 'A'
    ? matchState.playerALay
    : matchState.playerBLay;

  if (!currentLayOdds) {
    logger.warn('index: TRADE_OUT — no lay price available', { marketId });
    return;
  }

  const layOrder = await orderManager.tradeOut(
    openPosition.betId, selectionId, currentLayOdds,
    { matchName: matchState.matchName, reason: decision.reason }
  );

  if (!layOrder) return;

  const profit = layOrder.estimatedPnL || 0;
  await telegram.notifyTradeOut({ matchName: matchState.matchName, profit, reason: decision.reason });
  dashboard.broadcast('trade_out', { matchName: matchState.matchName, profit });
}

/**
 * Execute an entry signal — risk check then place the bet.
 * @param {object} system  — qualifying system from systemEvaluator (includes staking overrides)
 */
async function handleEntry(matchState, decision, openMarkets, system) {
  const marketId = matchState.betfairMarketId;
  const decoded = decodeAction(decision.action);
  if (!decoded) return;

  const { side, playerKey } = decoded;
  const selectionId = playerKey === 'A' ? matchState.runnerIdA : matchState.runnerIdB;
  const odds        = decision.suggestedOdds;
  const edgePct     = edgeForAction(decision.action, matchState);

  // Helper: log a rejection to the DB (non-fatal, fire-and-forget)
  const logRejection = (stage, reason, extra = {}) => {
    try {
      betRepo.insertRejection({
        betfairMarketId: marketId,
        matchName:       matchState.matchName,
        strategyName:    system?.systemName || null,
        rejectionStage:  stage,
        rejectionReason: reason,
        odds,
        details:         { side, playerKey, ...extra },
      });
    } catch (_) {}
  };

  // ── Odds sanity check — odds must be > 1.0 and < 1000 ───────────────────
  if (!odds || odds <= 1.0 || odds > 1000) {
    logger.info('index: entry rejected — invalid odds', { marketId, odds, side });
    logRejection('ODDS_INVALID', `Odds ${odds} outside valid range (1.0–1000)`);
    return;
  }

  // ── Global tournament block ───────────────────────────────────────────────
  const globalFilters = strategies.filters || {};
  if (globalFilters.blockedTournaments?.length && matchState.tournament) {
    const blocked = globalFilters.blockedTournaments.some(t =>
      matchState.tournament.toUpperCase().includes(t.toUpperCase())
    );
    if (blocked) {
      logger.info('index: entry rejected — blocked tournament', {
        marketId, tournament: matchState.tournament,
      });
      logRejection('BLOCKED_TOURNAMENT', `Tournament blocked: ${matchState.tournament}`);
      return;
    }
  }

  // ── Block men's best-of-5 Grand Slam matches ──────────────────────────────
  // Strategies built/backtested on best-of-3 don't transfer to BO5; the
  // set-end signals (set 1, set 2 trigger) hit a totally different game-state
  // distribution. Identify by tournament name (4 GS venues) + men's tour
  // marker in the Betfair event name ("ATP …" / "Men's …"). Women's draws at
  // the same venues are BO3 and continue normally.
  {
    const tournament = (matchState.tournament || '').toLowerCase();
    const eventName  = (matchState.betfairEventName || '').toLowerCase();
    const isGS = ['australian open', 'roland garros', 'french open', 'wimbledon', 'us open']
      .some(g => tournament.includes(g) || eventName.includes(g));
    const isMens = /\b(atp|mens|men's|men)\b/.test(eventName);
    if (isGS && isMens) {
      logger.info('index: entry rejected — men\'s best-of-5 Grand Slam', {
        marketId, tournament: matchState.tournament, eventName: matchState.betfairEventName,
      });
      logRejection('BO5_GRAND_SLAM', `Men's best-of-5 Grand Slam (${matchState.tournament})`);
      return;
    }
  }

  // ── Risk check ───────────────────────────────────────────────────────────
  // Merge system-specific staking overrides on top of global riskManager config.
  // Exchange bets have no £2 minimum, so we stake whatever the config says (£1 default).
  const configuredStake = system?.staking?.stakeGBP ?? strategies.riskManager?.stakeGBP ?? 1;
  const stakingConfig = { stakeGBP: configuredStake };

  const approval = riskManager.check(
    {
      marketId,
      side,
      odds,
      edgePercent: edgePct,
      bankroll:    getBankroll(),
    },
    buildExposure(),
    stakingConfig
  );

  if (!approval.approved) {
    logger.info('index: bet rejected by risk manager', {
      marketId, reason: approval.rejectionReason,
    });
    logRejection('RISK_MANAGER', approval.rejectionReason, { edgePct });

    // Notify Telegram if it was specifically a liquidity issue
    if (approval.rejectionReason?.toLowerCase().includes('volume')) {
      await telegram.notifyLowLiquidity({
        matchName: matchState.matchName,
        volume:    matchState.matchedVolume,
      });
    }
    return;
  }

  // ── Place the order ──────────────────────────────────────────────────────
  const playerName   = playerKey === 'A' ? matchState.playerAName : matchState.playerBName;
  const playerLabel  = playerName || `Player ${playerKey}`;
  const placeFn      = side === 'BACK' ? 'placeBack' : 'placeLay';

  const order = await orderManager[placeFn](
    marketId,
    selectionId,
    odds,
    approval.recommendedStake,
    {
      matchName:    matchState.matchName,
      playerName:   playerLabel,
      playerKey,
      strategyName: system?.systemName || null,
      reason:       decision.reason,
      exitConfig:   system?.exit || null,
      setsAtEntry: (matchState.sets || []).filter(isSetComplete).length,
    }
  );

  if (!order) return;

  // Update openMarkets so later matches in this loop iteration know about it
  openMarkets.add(marketId);

  // BFBM CSV — write ONLY after the bet was successfully placed (and after
  // every risk-manager / odds-range / max-open-bets check passed). This keeps
  // the CSV strictly equal to the bot's own bet ledger so BFBM downstream
  // never sees a signal that the simulated bot vetoed.
  // bfbmAccepted = true means signal passed Filter Lab (or no filter is configured).
  // Telegram alerts are gated on this so users only get pinged for BFBM-bound bets.
  let bfbmAccepted = false;
  let sqDiffTriggerForAlert = null;
  try {
    const bp1 = playerKey === 'A' ? matchState.liveServeStatsSet1?.playerA : matchState.liveServeStatsSet1?.playerB;
    const op1 = playerKey === 'A' ? matchState.liveServeStatsSet1?.playerB : matchState.liveServeStatsSet1?.playerA;
    const sqDiffS1 = (bp1?.firstServeWon != null && op1?.firstServeWon != null) ? bp1.firstServeWon - op1.firstServeWon : null;
    const bp2 = playerKey === 'A' ? matchState.liveServeStatsSet2?.playerA : matchState.liveServeStatsSet2?.playerB;
    const op2 = playerKey === 'A' ? matchState.liveServeStatsSet2?.playerB : matchState.liveServeStatsSet2?.playerA;
    const sqDiffS2 = (bp2?.firstServeWon != null && op2?.firstServeWon != null) ? bp2.firstServeWon - op2.firstServeWon : null;
    const triggerSetN = (matchState.sets || []).filter(isSetComplete).length;
    sqDiffTriggerForAlert = triggerSetN === 2 ? sqDiffS2 : sqDiffS1;
    // matchState.momentumIndex is player-A relative. We want "bet player's
    // momentum" so it matches the dashboard's bets.momentum_at_bet column
    // (which flips only on player_key, not side). Filter Lab's momMin/momMax
    // then compare against the same number the user sees in the table.
    const betPlayerMomentum = (matchState.momentumIndex ?? 0) * (playerKey === 'A' ? 1 : -1);
    bfbmAccepted = bfbmExport.appendSignal(strategies.bfbmExportSettings || {}, {
      strategyName:   system?.systemName || null,
      marketId,
      selectionId,
      eventName:      matchState.matchName,
      playerName:     playerLabel,
      playerKey,
      side,
      requestedOdds:  odds,
      surface:        matchState.surface,
      tournament:     matchState.tournament,
      matchedVolume:  matchState.matchedVolume,
      momentumIndex:  betPlayerMomentum,
      edgeAtBet:      edgePct,
      sqDiffS1, sqDiffS2,
      sqChange:       (sqDiffS1 != null && sqDiffS2 != null) ? sqDiffS2 - sqDiffS1 : null,
      sqDiffTrigger:  triggerSetN === 2 ? sqDiffS2 : sqDiffS1,
      dryRun:         !!order.dryRun,
    });
  } catch (e) {
    logger.warn('index: BFBM signal write failed', { message: e.message });
  }

  // Telegram alerts mirror the BFBM CSV — only notify for bets that BFBM
  // will actually execute downstream. If the Filter Lab blocked the signal
  // (or BFBM export is disabled), suppress the Telegram alert.
  if (!bfbmAccepted) {
    logger.info('index: Telegram bet-placed alert suppressed — signal not BFBM-bound', {
      strategy: system?.systemName, player: playerLabel,
    });
    dashboard.broadcast('bet_placed', {
      matchName:  matchState.matchName,
      player:     playerLabel,
      odds,
      stake:      approval.recommendedStake,
    });
    return;
  }

  await telegram.notifyBetPlaced({
    matchName:           matchState.matchName,
    player:              playerLabel,
    side,
    odds,
    stake:               approval.recommendedStake,
    sizeMatched:         order.sizeMatched,
    averagePriceMatched: order.averagePriceMatched,
    sqDiffTrigger:       sqDiffTriggerForAlert,
    momentumAtTrigger:   (matchState.momentumIndex ?? null) === null ? null : matchState.momentumIndex * (playerKey === 'A' ? 1 : -1),
    reason:              decision.reason,
    system:              system?.systemName,
    betId:               order.betId,
    dryRun:              order.dryRun,
  });

  dashboard.broadcast('bet_placed', {
    matchName:  matchState.matchName,
    player:     playerLabel,
    odds,
    stake:      approval.recommendedStake,
  });
}

/**
 * Build the openPosition descriptor for signalEngine.evaluate().
 * Returns null if there is no open position on this market.
 */
function buildOpenPosition(marketId) {
  const order = orderManager.getOpenPositionForMarket(marketId);
  if (!order) return null;

  return {
    betId:       order.betId,
    side:        order.side,
    playerKey:   order.playerKey || 'A',
    selectionId: order.selectionId,
    backOdds:    order.odds,
    stake:       order.stake,
    currentPnL:  orderManager.getCurrentPnL(order.betId, _currentBackPrice(marketId, order)),
  };
}

/** Get the current back price for an open order's selection from the stateStore. */
function _currentBackPrice(marketId, order) {
  const ms = stateStore.get(marketId);
  if (!ms) return null;
  // Determine which runner the order is on by comparing selectionId
  if (order.selectionId === ms.runnerIdA) return ms.playerABack;
  if (order.selectionId === ms.runnerIdB) return ms.playerBBack;
  return ms.playerABack; // fallback
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // Safety net: force exit after 12 s so we always finish inside PM2's 15 s
  // kill_timeout. Without this, a hung Telegram queue or hanging cancelAll()
  // could cause PM2 to SIGKILL the process (exit 137), which triggers autorestart.
  const forceExitTimer = setTimeout(() => {
    logger.warn('index: shutdown timeout — forcing exit');
    process.exit(0);
  }, 12_000);
  if (forceExitTimer.unref) forceExitTimer.unref();

  logger.info('index: shutdown initiated', { signal });

  // Stop new loop iterations
  if (mainLoopTimer) { clearInterval(mainLoopTimer); mainLoopTimer = null; }

  // Stop data collection
  if (statsPoller)    statsPoller.stop();
  if (cbbStream_cbb) cbbStream_cbb.stop();
  if (betfairStream)  betfairStream.disconnect();
  if (marketRecorder) { marketRecorder.flush(); logger.info('index: market recorder flushed'); }

  // Preserve open orders across restart — do NOT call cancelAll() here.
  // cancelAll() wipes open_orders.json which causes duplicate bets on the next startup
  // because _strategyFired is empty and the open position reference is gone.
  // Matched bets on Betfair are unaffected; unmatched bets lapse naturally (persistenceType: LAPSE).
  const openMarketIds = [...new Set(
    [...(orderManager?.openOrders.values() || [])].map(o => o.marketId)
  )];
  if (openMarketIds.length > 0) {
    logger.info('index: shutdown — preserving open orders for restart', {
      count:   openMarketIds.length,
      markets: openMarketIds,
    });
  }

  // Final position log
  logger.info('index: final state', {
    openOrders:     orderManager?.openOrders.size ?? 0,
    settledOrders:  orderManager?.settledOrders.length ?? 0,
    pnlToday:       orderManager?.getPnlToday().toFixed(2) ?? 'N/A',
  });

  // Telegram farewell
  try { await telegram?.notifyShutdown(signal); } catch (_) {}

  // Cleanup
  if (_strategyWatchTimer) clearInterval(_strategyWatchTimer);
  historicalLoader?.destroy();

  logger.info('index: shutdown complete');
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// On Windows, Ctrl+C in Command Prompt doesn't fire SIGINT unless Node.js is
// actively reading stdin.  Creating a readline interface forces that behaviour.
if (process.platform === 'win32') {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => process.emit('SIGINT'));
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  logger.info('index: ══════ Tennis Bot starting ══════');

  // ── 1. Load strategies config + start file watcher ───────────────────────
  strategies = loadStrategies();
  logger.info('index: strategies loaded', { keys: Object.keys(strategies) });
  watchStrategies();

  // ── 3. Telegram notifier ──────────────────────────────────────────────────
  // Initialise early so startup/error notifications can fire
  telegram = new TelegramNotifier();
  // Wire stateStore and orderManager after they're created (below)

  // ── 4. Login to Betfair ───────────────────────────────────────────────────
  betfairClient = new BetfairClient();
  try {
    await betfairClient.login();
  } catch (err) {
    logger.error('index: Betfair login failed', { message: err.message });
    await telegram.notifyError(`Betfair login failed: ${err.message}`);
    process.exit(1);
  }

  // ── 5. Historical stats + StateStore ─────────────────────────────────────
  stateStore       = new StateStore();
  historicalLoader = new HistoricalLoader();
  await historicalLoader.init();
  logger.info('index: historical stats ready', { players: historicalLoader._cache.size });

  // ── 6. Order manager ─────────────────────────────────────────────────────
  orderManager = new OrderManager();
  orderManager.setClient(betfairClient);

  // Restore _strategyFired from open orders that survived the restart.
  // Without this, a strategy that already fired would re-trigger on startup
  // even though an open position already exists for the same market.
  for (const [betId, order] of orderManager.openOrders.entries()) {
    if (order.strategyName) {
      const set = _strategyFired.get(order.marketId) || new Set();
      set.add(order.strategyName);
      _strategyFired.set(order.marketId, set);
    }
  }
  if (_strategyFired.size > 0) {
    logger.info('index: _strategyFired restored from open orders', {
      markets: _strategyFired.size,
      entries: [..._strategyFired.entries()].map(([m, s]) => `${m}:${[...s].join(',')}`),
    });
  }

  // Restore any pending-entry triggers that were mid-20s-delay when the bot
  // went down. The 5-min TTL prunes anything too old to be valid (well past
  // the 20s window). On the next poll the trigger will either fire or be
  // dropped because the strategy fired_set already contains it.
  const _restoredPending = _restorePendingTriggers();
  if (_restoredPending > 0) {
    logger.info('index: _pendingTriggers restored from disk', {
      count: _restoredPending,
      keys:  [..._pendingTriggers.keys()],
    });
  }

  // Wire BFBM as execution layer if enabled
  const bfbmClient = new BfbmClient();
  if (bfbmClient.enabled) {
    orderManager.setBfbmClient(bfbmClient);
    const bfbmReachable = await bfbmClient.ping();
    if (!bfbmReachable) {
      logger.warn('index: BFBM_ENABLED=true but BFBM is not responding — check BF Bot Manager is running');
    } else {
      logger.info('index: BFBM execution layer active — bets/hedges will route through BF Bot Manager');
    }
  }

  // Wire stateStore and orderManager into Telegram for /status and /debug
  telegram._stateStore   = stateStore;
  telegram._orderManager = orderManager;
  telegram._strategies   = strategies;
  telegram._onStop       = () => shutdown('Telegram /stop');
  // Command listener disabled — handled by separate telegram-bot process

  // Backfill final_sets for any market that closed during a previous bot
  // restart (close() never fired). Cheap one-shot UPDATE; runs every startup.
  try {
    const r = marketRepo.backfillFinalSetsFromSnapshots();
    if (r.filled) logger.info('Startup: backfilled final_sets', { rows: r.filled });
  } catch (e) {
    logger.warn('Startup: final_sets backfill failed', { message: e.message });
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────
  dashboard.init({ stateStore, orderManager, betfairClient, bfbmClient });
  await dashboard.start();

  // ── 6a. CBB poller (primary price source) ──────────────────────────────────
  cbbStream_cbb = new CbbStream();

  // ── 6. Betfair stream ─────────────────────────────────────────────────────
  betfairStream = new BetfairStream({
    appKey: process.env.BETFAIR_APP_KEY,
  });

  marketRecorder = new MarketRecorder();

  const onMarketUpdate = (update) => {
    marketRecorder.record(update);
    const isNew = !stateStore.get(update.marketId);

    // Enrich new markets with historical stats before first odds update
    if (isNew && update.matchName) {
      const [nameA, nameB] = update.matchName.split(' v ').map(s => s.trim());
      if (nameA && nameB) {
        const hist = historicalLoader.buildMatchHistoricalStats(nameA, nameB, null);
        stateStore.upsert(update.marketId, {
          matchName:       update.matchName,
          historicalStats: hist,
          // Store runner IDs for order placement
          runnerIdA:  update.runners?.[0]?.selectionId || null,
          runnerIdB:  update.runners?.[1]?.selectionId || null,
          playerAName: nameA,
          playerBName: nameB,
        }, 'init');
      }
    }

    const wasInPlay = stateStore.get(update.marketId)?.isInPlay;
    stateStore.upsert(update.marketId, update, 'odds');

    // When a market transitions to in-play for the first time, stamp went_in_play_at
    const nowState = stateStore.get(update.marketId);
    if (!wasInPlay && nowState?.isInPlay) {
      try {
        marketRepo.upsert({
          betfairMarketId: update.marketId,
          matchName:       update.matchName || update.marketId,
          wentInPlayAt:    new Date().toISOString(),
          surface:         nowState.surface         || null,
          tournament:      nowState.tournament      || null,
          tournamentRound: nowState.tournamentRound || null,
        });
      } catch (e) { /* non-fatal */ }
    }

    // Backfill player names if they weren't set when the market was first seen
    // (can happen if the first stream event arrived before Betfair sent runner names)
    const _state = stateStore.get(update.marketId);
    if (_state && (!_state.playerAName || !_state.playerBName) && update.matchName) {
      const [_nameA, _nameB] = update.matchName.split(' v ').map(s => s.trim());
      if (_nameA && _nameB) {
        _state.playerAName = _nameA;
        _state.playerBName = _nameB;
        logger.info('index: player names backfilled', {
          marketId: update.marketId,
          playerAName: _nameA,
          playerBName: _nameB,
        });
      }
    }

    if (isNew) {
      logger.info('index: market added to stateStore', {
        marketId:  update.marketId,
        matchName: update.matchName,
        inPlay:    update.inPlay,
        status:    stateStore.get(update.marketId)?.status,
        total:     stateStore.matches.size,
      });


    }
  };
  // Wire CBB as primary — Betfair stream only fires when CBB is degraded
  cbbStream_cbb.on('marketUpdate', onMarketUpdate);
  cbbStream_cbb.on('degraded', () => {
    logger.warn('index: CBB degraded — enabling Betfair stream fallback');
  });
  cbbStream_cbb.on('recovered', () => {
    logger.info('index: CBB recovered — Betfair stream remains as backup');
  });
  betfairStream.on('marketUpdate', (update) => {
    if (cbbStream_cbb.isDegraded) onMarketUpdate(update);
  });
  betfairStream.on('connected', () => {
    logger.info('index: Betfair stream connected');
  });

  betfairStream.on('disconnected', () => {
    logger.warn('index: Betfair stream disconnected — reconnect in progress');
  });

  let _lastStreamErrorNotify = 0;
  betfairStream.on('error', async (err) => {
    logger.error('index: Betfair stream error', { message: err.message });
    try { systemEventRepo.error('betfairStream', err.message, { code: err.code }); } catch (_) {}
    // Throttle Telegram notifications to at most one every 3 min to avoid
    // flooding during a reconnect loop (e.g. connection-limit errors).
    const now = Date.now();
    if (now - _lastStreamErrorNotify >= 3 * 60_000) {
      _lastStreamErrorNotify = now;
      await telegram.notifyError(`Stream error: ${err.message}`);
    }
  });

  betfairStream.connect();
  cbbStream_cbb.start();

  // ── 7. Stats poller ───────────────────────────────────────────────────────
  statsPoller = new StatsPoller({ stateStore, betfairStream });
  statsPoller.start();
  // Hand poller to dashboard so /api/upcoming can enrich rows with fixtures cache
  if (typeof dashboard.setStatsPoller === 'function') {
    dashboard.setStatsPoller(statsPoller);
  }

  // ── 8. Main signal loop ───────────────────────────────────────────────────
  mainLoopTimer = setInterval(runMainLoop, MAIN_LOOP_INTERVAL_MS);
  logger.info('index: main loop started', { intervalMs: MAIN_LOOP_INTERVAL_MS });

  // ── 8a. Orphaned-bet cleanup — hourly, expires any bets open > 24 h ───────
  setInterval(() => orderManager._expireOrphanedBets(24), 60 * 60 * 1000);

  // ── 9. Startup notification ───────────────────────────────────────────────
  await telegram.notifyStartup();
  logger.info('index: ══════ Tennis Bot running ══════', {
    dryRun: process.env.DRY_RUN === 'true',
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
main().catch(async (err) => {
  logger.error('index: fatal startup error', { message: err.message, stack: err.stack });
  try { await telegram?.notifyError(`Fatal startup error: ${err.message}`); } catch (_) {}
  process.exit(1);
});
