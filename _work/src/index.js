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

    // Clear notification and strategy-fired caches so updated/re-enabled systems re-evaluate
    _qualifyingNotified.clear();
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
 * Tracks which (marketId, systemName) pairs have already triggered a system-match
 * alert this session.  Cleared automatically when a market goes offline.
 * Key: marketId, Value: Set<systemName>
 */
const _qualifyingNotified = new Map();

/**
 * Tracks which strategy names have already fired for each market.
 * Prevents a strategy from entering more than once per match.
 * Key: marketId, Value: Set<systemName>
 */
const _strategyFired = new Map();

/**
 * Pending entry triggers awaiting the 20s market-inefficiency delay.
 * Key: `${marketId}:${systemName}`, Value: { trigger, detectedAt }
 */
const _pendingTriggers = new Map();

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

    // Prune notification/signal caches for markets no longer live
    const liveMarketIds = new Set(allLiveMatches.map(m => m.betfairMarketId));
    for (const marketId of _qualifyingNotified.keys()) {
      if (!liveMarketIds.has(marketId)) _qualifyingNotified.delete(marketId);
    }
    for (const marketId of _lastSignalLog.keys()) {
      if (!liveMarketIds.has(marketId)) _lastSignalLog.delete(marketId);
    }
    for (const marketId of _strategyFired.keys()) {
      if (!liveMarketIds.has(marketId)) _strategyFired.delete(marketId);
    }
    // Prune pending entry triggers for markets no longer live
    for (const key of _pendingTriggers.keys()) {
      const mid = key.split(':')[0];
      if (!liveMarketIds.has(mid)) _pendingTriggers.delete(key);
    }
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
    // (handles the case where bot restarted after a match ended)
    const _settledStaleMarkets = new Set();
    for (const [betId, order] of orderManager.openOrders.entries()) {
      if (order.dryRun && !liveMarketIds.has(order.marketId) && !_settledStaleMarkets.has(order.marketId)) {
        _settledStaleMarkets.add(order.marketId);
        logger.info('index: settling stale DRY_RUN order — market no longer live', {
          marketId: order.marketId, matchName: order.matchName,
        });
        // Use last known snapshot from DB to determine winner
        try {
          const snaps = snapshotRepo.getForMarket(order.marketId);
          const lastSnap = snaps.length ? snaps[snaps.length - 1] : null;
          orderManager.settleDryRunOrder(order.marketId, lastSnap || {});
        } catch (_) {
          orderManager.settleDryRunOrder(order.marketId, {});
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
      openMarkets.delete(marketId);
      return;
    }
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
  const notified = _qualifyingNotified.get(marketId) || new Set();
  const ENTRY_DELAY_MS = 20_000;

  // Phase A — record new triggers
  for (const trigger of triggers) {
    const pendingKey = `${marketId}:${trigger.system.name}`;
    if (_pendingTriggers.has(pendingKey) || firedSet.has(trigger.system.name)) continue;

    _pendingTriggers.set(pendingKey, { trigger, detectedAt: Date.now() });

    logger.info('index: strategy trigger detected — waiting 20s before entry', {
      marketId, matchName: matchState.matchName, system: trigger.system.name,
    });

    // Notify Telegram and BFBM at detection time (not at execution time)
    if (!notified.has(trigger.system.name)) {
      notified.add(trigger.system.name);
      _qualifyingNotified.set(marketId, notified);
      telegram.notifySystemMatch(matchState, {
        systemName:  trigger.system.name,
        description: trigger.system.description,
        staking:     trigger.system.staking,
      }).catch(() => {});
    }
    bfbmExport.appendSignal(strategies.bfbmExportSettings || {}, {
      strategyName: trigger.system.name,
      playerName:   trigger.playerKey === 'A' ? matchState.playerAName : matchState.playerBName,
    });
  }

  // Phase B — execute triggers whose 20s delay has elapsed
  for (const [pendingKey, pending] of _pendingTriggers.entries()) {
    if (!pendingKey.startsWith(`${marketId}:`)) continue;
    const systemName = pendingKey.slice(marketId.length + 1);

    if (firedSet.has(systemName)) {
      _pendingTriggers.delete(pendingKey);
      continue;
    }
    if (Date.now() - pending.detectedAt < ENTRY_DELAY_MS) continue;

    // Delay elapsed — execute the entry using CURRENT market odds
    _pendingTriggers.delete(pendingKey);
    const { trigger } = pending;
    const { system, playerKey, side, reason } = trigger;

    firedSet.add(system.name);

    const currentOdds = playerKey === 'A' ? matchState.playerABack : matchState.playerBBack;

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
  if (profit < 0) {
    await telegram.notifyStopLoss({ matchName: matchState.matchName, loss: Math.abs(profit) });
    dashboard.broadcast('stop_loss', { matchName: matchState.matchName, loss: Math.abs(profit) });
  } else {
    await telegram.notifyTradeOut({
      matchName: matchState.matchName, profit,
      reason: `Set ${setNumber} result hedge`,
      system:    order.strategyName,
      playerKey: order.playerKey,
      entryOdds: order.odds,
      hedgeOdds: greenupOdds,
    });
    dashboard.broadcast('trade_out', { matchName: matchState.matchName, profit });
  }

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
  const isStopLoss = profit < 0;

  if (isStopLoss) {
    await telegram.notifyStopLoss({ matchName: matchState.matchName, loss: Math.abs(profit) });
    dashboard.broadcast('stop_loss', { matchName: matchState.matchName, loss: Math.abs(profit) });
  } else {
    await telegram.notifyTradeOut({
      matchName: matchState.matchName, profit, reason: decision.reason,
      system:    openPosition.strategyName,
      playerKey: openPosition.playerKey,
      entryOdds: openPosition.odds,
      hedgeOdds: currentLayOdds,
    });
    dashboard.broadcast('trade_out', { matchName: matchState.matchName, profit });
  }
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

  // ── Max open bets cap ─────────────────────────────────────────────────────
  const maxOpenBets = strategies.riskManager?.maxOpenBets ?? 10;
  const currentOpen = orderManager.getOpenCount();
  if (currentOpen >= maxOpenBets) {
    logger.info('index: entry rejected — max open bets reached', {
      marketId, currentOpen, maxOpenBets,
    });
    logRejection('MAX_OPEN_BETS', `Already at max open bets (${currentOpen}/${maxOpenBets})`);
    return;
  }

  // ── Risk check ───────────────────────────────────────────────────────────
  // Merge system-specific staking overrides on top of global riskManager config
  const stakingConfig = {
    stakeGBP: system?.staking?.stakeGBP ?? strategies.riskManager?.stakeGBP ?? 2,
  };

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

  await telegram.notifyBetPlaced({
    matchName:           matchState.matchName,
    player:              playerLabel,
    playerKey:           trigger.playerKey,
    side,
    odds,
    stake:               approval.recommendedStake,
    liability:           order.liability,
    sizeMatched:         order.sizeMatched,
    averagePriceMatched: order.averagePriceMatched,
    edgePercent:         edgePct,
    momentumIndex:       matchState.momentumIndex,
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

  // ── Dashboard ─────────────────────────────────────────────────────────────
  dashboard.init({ stateStore, orderManager, betfairClient, bfbmClient });
  await dashboard.start();

  // ── 6. Betfair stream ─────────────────────────────────────────────────────
  betfairStream = new BetfairStream({
    appKey: process.env.BETFAIR_APP_KEY,
  });

  marketRecorder = new MarketRecorder();

  betfairStream.on('marketUpdate', (update) => {
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

  // ── 8b. Retro catch-up — replay any set-end transitions the bot missed during
  // restart / disconnection windows. Runs 90s after startup (so the stream has
  // a chance to populate live state first) and then every 12 hours thereafter.
  // The script is idempotent (deterministic bet_id) so re-runs are harmless.
  const runRetroCatchUp = () => {
    const { spawn } = require('child_process');
    const script = require('path').join(__dirname, '..', 'scripts', 'retroCatchUp.js');
    const child = spawn(process.execPath, [script, '--hours', '24'], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', d => logger.info('retroCatchUp: ' + String(d).trim()));
    child.stderr.on('data', d => logger.warn('retroCatchUp(stderr): ' + String(d).trim()));
    child.on('exit', code => logger.info(`retroCatchUp: exited ${code}`));
  };
  setTimeout(runRetroCatchUp, 90_000);
  setInterval(runRetroCatchUp, 12 * 60 * 60 * 1000);

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
