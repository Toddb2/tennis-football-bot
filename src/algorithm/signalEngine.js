'use strict';

/**
 * signalEngine.js
 *
 * Combines probability edge and momentum to produce a trading decision.
 *
 * Entry logic  — backs a player when edge + momentum align and conditions met.
 * Exit logic   — triggers TRADE_OUT when edge reverses, momentum swings, or
 *               a profit/stop-loss threshold is hit.
 *
 * All thresholds are read from config/strategies.json (signalEngine section).
 */

const { computeTrueProbability } = require('./probabilityModel');
const { computeMomentum }        = require('./momentumDetector');
const logger                     = require('../utils/logger');

// ---------------------------------------------------------------------------
// Default parameters — overridden by strategies.json at runtime
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  minEdgePercent:            3.0,
  minMomentumToEnter:        20,
  minMatchedVolume:          5000,
  tradeOutMomentumThreshold: 40,
  onlyEntryAfterBreak:       false,
  requireServeMomentumAlignment: true,
};

// ---------------------------------------------------------------------------
// Decision shape
// ---------------------------------------------------------------------------
/**
 * @typedef {object} Signal
 * @property {'BET_BACK_A'|'BET_BACK_B'|'BET_LAY_A'|'BET_LAY_B'|'TRADE_OUT'|'HOLD'} action
 * @property {number}  confidence   0.0 – 1.0
 * @property {string}  reason
 * @property {number|null} suggestedOdds
 * @property {string}  marketId
 * @property {number|null} selectionId
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Implied probability from a back price (1 / backPrice).
 */
function impliedProb(price) {
  if (!price || price <= 1) return null;
  return 1 / price;
}

/**
 * Edge as a percentage:  (trueProbability − impliedProbability) × 100.
 * Positive = we think the player is underpriced (good to back).
 */
function edgePct(trueProb, backPrice) {
  const imp = impliedProb(backPrice);
  if (imp === null || trueProb === null) return null;
  return (trueProb - imp) * 100;
}

/**
 * Confidence score — combines normalised edge and normalised momentum.
 * Returns a value in [0, 1].
 */
function calcConfidence(edgePercent, momentumAbs) {
  const edgeNorm = Math.min(edgePercent / 20, 1);   // full confidence at 20%+ edge
  const momNorm  = Math.min(momentumAbs  / 100, 1);
  return parseFloat(((edgeNorm + momNorm) / 2).toFixed(3));
}

// ---------------------------------------------------------------------------
// Entry evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether there is a valid entry signal on this match.
 *
 * @param {import('../state/matchState')} matchState
 * @param {Set<string>}   openMarkets   — set of marketIds with an open position
 * @param {object}        config
 * @returns {Signal}
 */
function evaluateEntry(matchState, openMarkets, config) {
  const {
    betfairMarketId, matchName,
    playerABack, playerALay,
    playerBBack, playerBLay,
    matchedVolume, isInPlay, status,
    momentumIndex,
    trueProbabilityA, trueProbabilityB,
  } = matchState;

  const HOLD = (reason) => ({
    action: 'HOLD', confidence: 0, reason,
    suggestedOdds: null, marketId: betfairMarketId, selectionId: null,
  });

  // --- Hard guards ---
  if (!isInPlay)               return HOLD('Market not in-play');
  if (status === 'SUSPENDED')  return HOLD('Market suspended');
  if (status === 'CLOSED')     return HOLD('Market closed');
  if (openMarkets.has(betfairMarketId)) return HOLD('Position already open on this market');

  if (!matchedVolume || matchedVolume < config.minMatchedVolume) {
    return HOLD(`Matched volume too low (${matchedVolume || 0} < ${config.minMatchedVolume})`);
  }

  if (trueProbabilityA === null || trueProbabilityB === null) {
    return HOLD('True probability not yet computed');
  }

  // --- Compute edges ---
  const eA = edgePct(trueProbabilityA, playerABack);
  const eB = edgePct(trueProbabilityB, playerBBack);

  const edgeAok = eA !== null && eA >= config.minEdgePercent;
  const edgeBok = eB !== null && eB >= config.minEdgePercent;

  if (!edgeAok && !edgeBok) {
    return HOLD(`Edge below threshold (edgeA=${eA?.toFixed(2)}, edgeB=${eB?.toFixed(2)})`);
  }

  // --- Momentum filter ---
  const absM = Math.abs(momentumIndex);
  if (absM < config.minMomentumToEnter) {
    return HOLD(`Momentum too low (|${momentumIndex}| < ${config.minMomentumToEnter})`);
  }

  // Momentum direction: positive = playerA, negative = playerB
  const momentumFavoursA = momentumIndex > 0;
  const momentumFavoursB = momentumIndex < 0;

  // --- Match edge direction with momentum direction ---
  if (edgeAok && momentumFavoursA) {
    const confidence = calcConfidence(eA, absM);
    logger.info('SignalEngine: BET_BACK_A', { marketId: betfairMarketId, edgeA: eA, momentum: momentumIndex });
    return {
      action: 'BET_BACK_A',
      confidence,
      reason: `Edge ${eA.toFixed(2)}% on playerA; momentum ${momentumIndex} favours A`,
      suggestedOdds: playerABack,
      marketId: betfairMarketId,
      selectionId: matchState.runnerIdA || null,
    };
  }

  if (edgeBok && momentumFavoursB) {
    const confidence = calcConfidence(eB, absM);
    logger.info('SignalEngine: BET_BACK_B', { marketId: betfairMarketId, edgeB: eB, momentum: momentumIndex });
    return {
      action: 'BET_BACK_B',
      confidence,
      reason: `Edge ${eB.toFixed(2)}% on playerB; momentum ${momentumIndex} favours B`,
      suggestedOdds: playerBBack,
      marketId: betfairMarketId,
      selectionId: matchState.runnerIdB || null,
    };
  }

  return HOLD('Edge and momentum directions do not align');
}

// ---------------------------------------------------------------------------
// Exit evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate whether an open position should be traded out.
 *
 * @param {import('../state/matchState')} matchState
 * @param {object} openPosition   — { side: 'A'|'B', backOdds, stake, currentPnL }
 * @param {object} config
 * @returns {Signal|null}   null = no exit signal
 */
function evaluateExit(matchState, openPosition, config) {
  if (!openPosition) return null;

  const {
    betfairMarketId,
    playerABack, playerBBack,
    momentumIndex,
    trueProbabilityA, trueProbabilityB,
    status,
  } = matchState;

  const { side, stake, currentPnL } = openPosition;

  const TRADE_OUT = (reason) => ({
    action: 'TRADE_OUT',
    confidence: 1,
    reason,
    suggestedOdds: side === 'A' ? playerABack : playerBBack,
    marketId: betfairMarketId,
    selectionId: side === 'A' ? matchState.runnerIdA : matchState.runnerIdB || null,
  });

  // Market closed / suspended — get out
  if (status === 'CLOSED' || status === 'SUSPENDED') {
    return TRADE_OUT('Market closed or suspended — closing position');
  }

  // --- Edge reversal ---
  if (trueProbabilityA !== null && trueProbabilityB !== null) {
    if (side === 'A') {
      const eA = edgePct(trueProbabilityA, playerABack);
      if (eA !== null && eA < 0) {
        return TRADE_OUT(`Edge reversed on playerA (edge=${eA.toFixed(2)}%)`);
      }
    } else {
      const eB = edgePct(trueProbabilityB, playerBBack);
      if (eB !== null && eB < 0) {
        return TRADE_OUT(`Edge reversed on playerB (edge=${eB.toFixed(2)}%)`);
      }
    }
  }

  // --- Momentum swing against position ---
  const threshold = config.tradeOutMomentumThreshold;
  if (side === 'A' && momentumIndex <= -threshold) {
    return TRADE_OUT(`Momentum swung strongly against playerA (index=${momentumIndex})`);
  }
  if (side === 'B' && momentumIndex >= threshold) {
    return TRADE_OUT(`Momentum swung strongly against playerB (index=${momentumIndex})`);
  }

  return null; // no exit signal
}

// ---------------------------------------------------------------------------
// Top-level evaluate — called from the main loop
// ---------------------------------------------------------------------------

/**
 * Run the full signal evaluation for one match.
 *
 * Steps:
 *  1. Recompute trueProbability and momentumIndex on the matchState.
 *  2. Check exit signal if there is an open position.
 *  3. Check entry signal if there is no open position.
 *
 * @param {import('../state/matchState')} matchState
 * @param {object} [opts]
 * @param {Set<string>}  [opts.openMarkets]    — marketIds with open positions
 * @param {object|null}  [opts.openPosition]   — existing position details (for exit check)
 * @param {object}       [opts.config]         — strategies.json signalEngine section
 * @returns {Signal}
 */
function evaluate(matchState, opts = {}) {
  const {
    openMarkets  = new Set(),
    openPosition = null,
    config       = {},
  } = opts;

  const cfg = { ...DEFAULT_CONFIG, ...config };

  // --- 1. Refresh derived state ---
  // trueProbability is written directly to matchState
  const probs = computeTrueProbability(matchState, cfg.probabilityModel);
  matchState.trueProbabilityA = probs.playerA;
  matchState.trueProbabilityB = probs.playerB;

  // momentumIndex is written directly to matchState
  computeMomentum(matchState);

  matchState.recompute(); // updates edgeA/edgeB

  // --- 2. Exit check (takes priority over entry) ---
  if (openPosition) {
    const exitSignal = evaluateExit(matchState, openPosition, cfg);
    if (exitSignal) return exitSignal;
  }

  // --- 3. Entry check ---
  return evaluateEntry(matchState, openMarkets, cfg);
}

module.exports = {
  evaluate,
  // Exposed for unit tests
  evaluateEntry,
  evaluateExit,
  edgePct,
  calcConfidence,
};
