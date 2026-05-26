'use strict';

/**
 * momentumDetector.js
 *
 * Continuous-feature momentum model.
 *
 * Each signal is computed as a smooth value (no binary thresholds), z-ish
 * normalised so its typical range is ~[-1, +1] for the playerA−playerB
 * differential, weighted, summed, and squashed through tanh to give an
 * index in [-100, +100].
 *
 *   Positive = playerA momentum, negative = playerB.
 *
 * Public API (unchanged):
 *   computeMomentum(matchState)         → number
 *   recordGameResult(matchState, w, br) → void
 */

// ---------------------------------------------------------------------------
// Weights — tunable from backtest. Roughly reflect prior hand-tuned constants
// but expressed as multipliers on continuous features.
// ---------------------------------------------------------------------------
const W = {
  BREAK_STREAK:    1.20,  // consecutive breaks (high impact)
  GAME_STREAK:     0.55,  // consecutive games
  SERVE_TREND:     0.45,  // 1st-serve % trend (pp delta)
  DOUBLE_FAULT:    0.40,  // DFs per set above baseline
  BP_CONVERSION:   0.55,  // BP conversion rate above 40%
  BP_LEVERAGE:     0.30,  // raw BP creation differential
};

// Decay: per game elapsed since last streak-reinforcing event
const DECAY_PER_GAME = 0.18;   // streak halflife ≈ 4 games (exp(-0.18*4) ≈ 0.49)

// Set-leverage: multiply final tanh argument by this when in a decider
const LEVERAGE_BY_SET_INDEX = [1.0, 1.15, 1.30, 1.45, 1.60];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function tanh(x) { return Math.tanh(x); }

// ---------------------------------------------------------------------------
// Feature: serve efficiency trend
// Continuous pp delta between recent and earlier 1st-serve-in % within buffer.
// Returns playerA − playerB delta in percentage points (positive = A trending up).
// ---------------------------------------------------------------------------
function serveEfficiencyDelta(buffer, player) {
  if (!buffer || buffer.length < 4) return 0;
  const vals = buffer
    .map(e => e?.serveStats?.[player]?.firstServeIn)
    .filter(v => v != null);
  if (vals.length < 4) return 0;

  const q = Math.max(1, Math.floor(vals.length / 4));
  const oldAvg = vals.slice(0, q).reduce((a, b) => a + b, 0) / q;
  const newAvg = vals.slice(-q).reduce((a, b) => a + b, 0) / q;
  return newAvg - oldAvg;
}

// ---------------------------------------------------------------------------
// Feature: BP conversion above neutral.
// Returns rate − 0.4, scaled by sqrt(created) so 1-of-2 counts less than 5-of-10.
// ---------------------------------------------------------------------------
function breakConversionScore(bp) {
  if (!bp || !bp.created) return 0;
  const rate = bp.converted / bp.created;
  const confidence = Math.min(1, Math.sqrt(bp.created) / 3); // ≈1 at 9 BPs created
  return (rate - 0.4) * confidence;
}

// ---------------------------------------------------------------------------
// Feature: double-fault pressure.
// Continuous excess over 1 DF/set baseline, normalised by sets played.
// Returns a positive number to be subtracted from the offending player's score.
// ---------------------------------------------------------------------------
function doubleFaultPenalty(liveServeStats, player, setsPlayed = 1) {
  const dfs = liveServeStats?.[player]?.doubleFaults;
  if (dfs == null) return 0;
  const baseline = Math.max(1, setsPlayed);
  const excess = Math.max(0, dfs - baseline); // 1 DF/set is "neutral"
  return excess / 3;                           // 3 excess DFs ≈ full unit penalty
}

// ---------------------------------------------------------------------------
// Decay multiplier: smooth exponential, advances on every game without an event.
// ---------------------------------------------------------------------------
function decayMultiplier(gamesSinceEvent) {
  return Math.exp(-DECAY_PER_GAME * Math.max(0, gamesSinceEvent));
}

// ---------------------------------------------------------------------------
// Set-leverage multiplier — late sets matter more.
// ---------------------------------------------------------------------------
function leverageMultiplier(matchState) {
  const idx = Array.isArray(matchState.sets) ? matchState.sets.length : 0;
  return LEVERAGE_BY_SET_INDEX[Math.min(idx, LEVERAGE_BY_SET_INDEX.length - 1)];
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
function computeMomentum(matchState) {
  const {
    breakStreak    = { player: null, count: 0 },
    gameStreak     = { player: null, count: 0 },
    statsBuffer    = [],
    liveServeStats = {},
    breakPoints    = {
      playerA: { created: 0, converted: 0 },
      playerB: { created: 0, converted: 0 },
    },
    sets = [],
  } = matchState;

  const setsPlayed = Math.max(1, sets.length);
  const decay      = decayMultiplier(matchState._gamesSinceStreakEvent || 0);

  // 1. Break streak — continuous, decayed.
  const breakStreakSigned =
      (breakStreak.player === 'playerA' ?  breakStreak.count :
       breakStreak.player === 'playerB' ? -breakStreak.count : 0);
  const fBreakStreak = (breakStreakSigned / 2) * decay; // 2 consecutive breaks ≈ ±1

  // 2. Game streak — continuous, decayed. 4-game streak ≈ ±1.
  const gameStreakSigned =
      (gameStreak.player === 'playerA' ?  gameStreak.count :
       gameStreak.player === 'playerB' ? -gameStreak.count : 0);
  const fGameStreak = (gameStreakSigned / 4) * decay;

  // 3. Serve efficiency trend — pp delta / 10 (10pp swing ≈ ±1).
  const fServeTrend =
      (serveEfficiencyDelta(statsBuffer, 'playerA') -
       serveEfficiencyDelta(statsBuffer, 'playerB')) / 10;

  // 4. Double-fault pressure (offender penalised → flip sign for A).
  const dfA = doubleFaultPenalty(liveServeStats, 'playerA', setsPlayed);
  const dfB = doubleFaultPenalty(liveServeStats, 'playerB', setsPlayed);
  const fDoubleFault = dfB - dfA;

  // 5. BP conversion differential.
  const fBpConv =
      breakConversionScore(breakPoints.playerA) -
      breakConversionScore(breakPoints.playerB);

  // 6. BP leverage — created BP differential, log-scaled (pressure proxy).
  const bpcA = breakPoints.playerA?.created || 0;
  const bpcB = breakPoints.playerB?.created || 0;
  const fBpLeverage = (Math.log1p(bpcA) - Math.log1p(bpcB)) / 2;

  // ---------------------------------------------------------------------------
  // Weighted blend
  // ---------------------------------------------------------------------------
  const z =
      W.BREAK_STREAK   * fBreakStreak
    + W.GAME_STREAK    * fGameStreak
    + W.SERVE_TREND    * fServeTrend
    + W.DOUBLE_FAULT   * fDoubleFault
    + W.BP_CONVERSION  * fBpConv
    + W.BP_LEVERAGE    * fBpLeverage;

  const leverage = leverageMultiplier(matchState);
  const leveraged = z * leverage;
  const momentumIndex = Math.round(tanh(leveraged) * 100);

  // Persist raw features for later weight-fitting (consumed by snapshotRepo.write)
  matchState.momentumFeatures = {
    fBreakStreak,
    fGameStreak,
    fServeTrend,
    fDoubleFault,
    fBpConv,
    fBpLeverage,
    leverage,
    decay,
    z,
  };

  matchState.momentumIndex = clamp(momentumIndex, -100, 100);
  return matchState.momentumIndex;
}

// ---------------------------------------------------------------------------
// Streak bookkeeping. Called from matchState.applyStatsUpdate when a game ends.
// Fixes prior bug: any streak-reinforcing event resets the decay counter,
// not only break events.
// ---------------------------------------------------------------------------
function recordGameResult(matchState, gameWinner, wasBreak) {
  let reinforced = false;

  // Game streak
  if (matchState.gameStreak.player === gameWinner) {
    matchState.gameStreak.count++;
    reinforced = true;
  } else {
    matchState.gameStreak = { player: gameWinner, count: 1 };
    reinforced = true; // a fresh streak counts as a momentum event
  }

  // Break streak
  if (wasBreak) {
    if (matchState.breakStreak.player === gameWinner) {
      matchState.breakStreak.count++;
    } else {
      matchState.breakStreak = { player: gameWinner, count: 1 };
    }
    reinforced = true;
  }

  if (reinforced) {
    matchState._gamesSinceStreakEvent = 0;
  } else {
    matchState._gamesSinceStreakEvent = (matchState._gamesSinceStreakEvent || 0) + 1;
  }

  // Back-compat alias used by older code paths
  matchState._gamesSinceBreakEvent = matchState._gamesSinceStreakEvent;
}

module.exports = {
  computeMomentum,
  recordGameResult,
  // Exposed for unit tests
  serveEfficiencyDelta,
  breakConversionScore,
  doubleFaultPenalty,
  decayMultiplier,
  leverageMultiplier,
  clamp,
  WEIGHTS: W,
};
