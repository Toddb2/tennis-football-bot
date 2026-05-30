'use strict';

/**
 * probabilityModel.js
 *
 * Computes true win probability for each player using a recursive Markov chain
 * that models tennis from point → game → set → match.
 *
 * Parameters are read from config/strategies.json (passed in at construction time
 * or via the module-level defaults).
 */

// ---------------------------------------------------------------------------
// Default config (overridden by strategies.json at runtime)
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  minGamesForLiveStats: 3,
  fullTrustAfterGames: 10,
  surfaceAdjustment: true,
};

// ---------------------------------------------------------------------------
// Low-level Markov helpers
// ---------------------------------------------------------------------------

/**
 * Probability of winning a game from score (a, b) where `p` is the probability
 * of winning a single serve point.
 *
 * Uses the standard recursive tennis game formula.
 * At deuce (a=3, b=3 or beyond) the infinite geometric series collapses to:
 *   P(win from deuce) = p² / (p² + (1-p)²)
 *
 * @param {number} p   - probability of winning one point on serve (0–1)
 * @param {number} a   - server's points won so far  (0–4, where 3=40, 4=Ad)
 * @param {number} b   - returner's points won so far
 * @returns {number}
 */
function gameWinProbFromScore(p, a, b) {
  const q = 1 - p;

  // Base cases
  if (a >= 4 && a - b >= 2) return 1; // server won
  if (b >= 4 && b - a >= 2) return 0; // returner won

  // Deuce shortcut — use the closed-form geometric series
  if (a >= 3 && b >= 3) {
    return (p * p) / (p * p + q * q);
  }

  // Recursive step
  return p * gameWinProbFromScore(p, a + 1, b) +
         q * gameWinProbFromScore(p, a, b + 1);
}

/**
 * Probability of winning a game from (0, 0) — the common entry point.
 * @param {number} p - probability of winning a serve point
 */
function pointWinProb(p) {
  return gameWinProbFromScore(p, 0, 0);
}

/**
 * Probability of winning a set from game score (gA, gB) given per-game
 * win probabilities for the server and returner.
 *
 * Standard sets are first to 6 with a 2-game lead (tiebreak at 6-6).
 * Tiebreak is modelled as a single coin-flip with probability tiebreakP.
 *
 * @param {number} holdA    - P(playerA wins a game when serving)
 * @param {number} holdB    - P(playerB wins a game when serving)
 * @param {number} gA       - games already won by playerA in this set
 * @param {number} gB       - games already won by playerB in this set
 * @param {string} server   - who serves next: "playerA" | "playerB"
 * @param {number} [tiebreakP] - P(playerA wins tiebreak), defaults to holdA
 * @returns {number}  P(playerA wins the set from this point)
 */
function setWinProbFromScore(holdA, holdB, gA, gB, server, tiebreakP) {
  // Memoisation key
  const key = `${gA},${gB},${server}`;
  if (setWinProbFromScore._cache.has(key)) return setWinProbFromScore._cache.get(key);

  let result;

  // Guard: scores ≥7 mean a tiebreak result was passed in directly (e.g. 7-6)
  if (gA >= 7 || gB >= 7) return gA > gB ? 1 : 0;

  // Terminal: playerA won
  if (gA >= 6 && gA - gB >= 2) { result = 1; }
  // Terminal: playerB won
  else if (gB >= 6 && gB - gA >= 2) { result = 0; }
  // Tiebreak at 6-6
  else if (gA === 6 && gB === 6) {
    result = tiebreakP !== undefined ? tiebreakP : holdA;
  }
  else {
    const pWinGame = server === 'playerA' ? holdA : (1 - holdB);
    const nextServer = server === 'playerA' ? 'playerB' : 'playerA';

    result = pWinGame       * setWinProbFromScore(holdA, holdB, gA + 1, gB,     nextServer, tiebreakP) +
             (1 - pWinGame) * setWinProbFromScore(holdA, holdB, gA,     gB + 1, nextServer, tiebreakP);
  }

  setWinProbFromScore._cache.set(key, result);
  return result;
}
setWinProbFromScore._cache = new Map();

/**
 * Clear the set-win memoisation cache. Call between matches or when p values change.
 */
function clearSetCache() {
  setWinProbFromScore._cache.clear();
}

/**
 * Probability of playerA winning the match from a given sets score.
 *
 * Supports best-of-3 and best-of-5 formats.
 *
 * @param {number} setsA        - sets won by playerA
 * @param {number} setsB        - sets won by playerB
 * @param {number} holdA        - P(playerA holds serve)
 * @param {number} holdB        - P(playerB holds serve)
 * @param {number} gA           - games won in current set by playerA
 * @param {number} gB           - games won in current set by playerB
 * @param {string} server       - who is serving next game
 * @param {number} [bestOf]     - 3 or 5 (default 3)
 * @param {number} [tiebreakP]  - P(playerA wins tiebreak); defaults to 0.5 if omitted
 * @returns {number}  P(playerA wins match)
 */
function matchWinProb(setsA, setsB, holdA, holdB, gA, gB, server, bestOf = 3, tiebreakP = 0.5) {
  const setsNeeded = Math.ceil(bestOf / 2);

  // Terminal: already won
  if (setsA >= setsNeeded) return 1;
  if (setsB >= setsNeeded) return 0;

  const pWinCurrentSet = setWinProbFromScore(holdA, holdB, gA, gB, server, tiebreakP);

  // After current set: recurse into next set (server alternates at start of set — simplification:
  // first server of new set is the player who did NOT serve the first game of the previous set;
  // here we approximate by alternating server for the next set start).
  const nextSetServer = server === 'playerA' ? 'playerB' : 'playerA';

  return pWinCurrentSet       * matchWinProb(setsA + 1, setsB,     holdA, holdB, 0, 0, nextSetServer, bestOf, tiebreakP) +
         (1 - pWinCurrentSet) * matchWinProb(setsA,     setsB + 1, holdA, holdB, 0, 0, nextSetServer, bestOf, tiebreakP);
}

// ---------------------------------------------------------------------------
// Stat extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract serve-win probability from a liveServeStats entry.
 * Returns null if insufficient data.
 */
function serveWinPctFromLive(stats) {
  if (!stats) return null;
  const { firstServeIn, firstServeWon, secondServeWon } = stats;
  if (firstServeIn == null || firstServeWon == null || secondServeWon == null) return null;

  const fsi = firstServeIn / 100;          // proportion of 1st serves in
  const fsw = firstServeWon / 100;         // P(win | 1st serve in)
  const ssw = secondServeWon / 100;        // P(win | 2nd serve in)

  // P(win serve point) = P(1st in) * P(win | 1st in) + P(1st out) * P(win | 2nd in)
  // (simplifying: assume 2nd serve always goes in)
  return fsi * fsw + (1 - fsi) * ssw;
}

/**
 * Extract serve-win probability from historical surface stats for a player.
 */
function serveWinPctFromHistorical(historicalStats, surface) {
  if (!historicalStats || !surface) return null;
  const playerKey = Object.keys(historicalStats)[0]; // e.g. "playerA"
  const stats = historicalStats[playerKey];
  if (!stats) return null;
  const surfaceStats = stats.surfaceStats && stats.surfaceStats[surface];
  if (!surfaceStats) return null;
  return surfaceStats.serveWin;
}

/**
 * Derive hold% (P playerA wins a game when serving) from serve-win-per-point probability.
 * Uses pointWinProb.
 */
function holdPctFromServeWin(serveWinPct) {
  return pointWinProb(serveWinPct);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute true win probability for both players from the current MatchState.
 *
 * @param {import('../state/matchState')} matchState
 * @param {object} [config]  — from strategies.json probabilityModel section
 * @returns {{ playerA: number, playerB: number }}
 */
function computeTrueProbability(matchState, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const {
    sets = [],
    currentGame = { playerA: 0, playerB: 0 },
    currentServer,
    surface,
    liveServeStats = {},
    historicalStats = {},
  } = matchState;

  // Count total games played (across all completed sets + current set)
  const completedSetGames = sets.reduce((s, set) => s + (set.playerA || 0) + (set.playerB || 0), 0);
  const gamesPlayed = completedSetGames;

  // Blending factor: 0 = full historical, 1 = full live
  const blend = Math.min(gamesPlayed / cfg.fullTrustAfterGames, 1.0);
  const useLive = gamesPlayed >= cfg.minGamesForLiveStats;

  // --- Derive serve-win probabilities for each player ---
  let serveWinA = null;
  let serveWinB = null;

  if (useLive && liveServeStats.playerA) {
    const live = serveWinPctFromLive(liveServeStats.playerA);
    const hist = _historicalServeWin(historicalStats, 'playerA', surface);
    serveWinA = hist !== null ? (1 - blend) * hist + blend * live : live;
  } else {
    serveWinA = _historicalServeWin(historicalStats, 'playerA', surface);
  }

  if (useLive && liveServeStats.playerB) {
    const live = serveWinPctFromLive(liveServeStats.playerB);
    const hist = _historicalServeWin(historicalStats, 'playerB', surface);
    serveWinB = hist !== null ? (1 - blend) * hist + blend * live : live;
  } else {
    serveWinB = _historicalServeWin(historicalStats, 'playerB', surface);
  }

  // Fallbacks if we have nothing
  if (serveWinA === null) serveWinA = 0.62; // ATP average ~62%
  if (serveWinB === null) serveWinB = 0.62;

  // Hold percentages (P of winning a game on serve)
  const holdA = holdPctFromServeWin(serveWinA);
  const holdB = holdPctFromServeWin(serveWinB);

  // Tiebreak probability: approximated as average of playerA's serve-win and return-win rates.
  // (serveWinA + returnWinA) / 2  where returnWinA = 1 − serveWinB
  // In the symmetric case this equals 0.5, which is correct.
  const tiebreakP = (serveWinA + (1 - serveWinB)) / 2;

  // Determine sets already won from the sets array
  // Convention: sets array may include the in-progress set as the last entry.
  // We count a set as complete when both values are present and one has ≥6 games with 2-game lead,
  // OR one has 7 (tiebreak won). The last entry is the current in-progress set.
  let setsA = 0;
  let setsB = 0;
  let currentSetGamesA = 0;
  let currentSetGamesB = 0;

  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    const isLast = i === sets.length - 1;
    const completeA = s.playerA >= 6 && s.playerA - s.playerB >= 2;
    const completeB = s.playerB >= 6 && s.playerB - s.playerA >= 2;
    const tiebreakA = s.playerA === 7;
    const tiebreakB = s.playerB === 7;

    if (!isLast && (completeA || tiebreakA)) setsA++;
    else if (!isLast && (completeB || tiebreakB)) setsB++;
    else {
      // In-progress set
      currentSetGamesA = s.playerA || 0;
      currentSetGamesB = s.playerB || 0;
    }
  }

  // Detect best-of-3 vs best-of-5 (Grand Slams use BO5 for men)
  // Simple heuristic: if any player has won 2 sets, it's at least BO3.
  // Caller can override by setting matchState.bestOf.
  const bestOf = matchState.bestOf || 3;

  const server = currentServer || 'playerA';

  clearSetCache();
  const probA = matchWinProb(setsA, setsB, holdA, holdB, currentSetGamesA, currentSetGamesB, server, bestOf, tiebreakP);
  const probB = 1 - probA;

  return {
    playerA: parseFloat(probA.toFixed(4)),
    playerB: parseFloat(probB.toFixed(4)),
  };
}

/** @private */
function _historicalServeWin(historicalStats, playerKey, surface) {
  const player = historicalStats[playerKey];
  if (!player || !player.surfaceStats) return null;
  const s = surface && player.surfaceStats[surface];
  if (s && s.serveWin != null) return s.serveWin;
  // Fallback: average across known surfaces
  const vals = Object.values(player.surfaceStats).map(x => x.serveWin).filter(v => v != null);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  computeTrueProbability,
  // Exposed for unit testing
  pointWinProb,
  gameWinProbFromScore,
  setWinProbFromScore,
  matchWinProb,
  holdPctFromServeWin,
  serveWinPctFromLive,
  clearSetCache,
};
