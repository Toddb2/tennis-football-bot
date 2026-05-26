'use strict';

/**
 * serveScorer.js
 *
 * Converts raw per-set serve statistics into a composite quality score (0–100).
 * Used as a pre-trade filter to distinguish market overreactions from genuine
 * underdog performances.
 *
 * ── Scoring bands (from strategy analysis) ───────────────────────────────────
 *
 *   Metric              Pass (20pts)   Warn (10pts)   Fail (0pts)
 *   ─────────────────── ────────────── ────────────── ─────────────
 *   1st serve % in      > 63           55–63          < 55
 *   1st serve pts won   > 68           60–68          < 60
 *   2nd serve pts won   > 52           44–52          < 44
 *   Aces (count)        ≥ 4            2–3            ≤ 1
 *   Double faults(count)< 2            2–4            ≥ 5  (inverted)
 *
 * Total: 5 × 20 = 100 points max.
 * Missing/null values are scored as warn (10) — absent data is neutral.
 *
 * ── Interpretation ───────────────────────────────────────────────────────────
 *
 *   For the SET LOSER (favourite in a fightback trade):
 *     High score = market overreacted — fav served well despite losing
 *     Low score  = loser was genuinely poor — set loss may be meaningful
 *
 *   For the SET WINNER (to be laid in an even-match lay trade):
 *     High score = winner ran HOT — regression likely next set
 *     Low score  = winner didn't dominate serve — win was more structural
 *
 *   Differential = loser.score − winner.score
 *     Positive (+20 or more) → ideal fightback trade (fav outserved underdog)
 *     Near zero               → use caution
 *     Negative                → stand aside (underdog genuinely outserved fav)
 */

// ---------------------------------------------------------------------------
// Scoring logic
// ---------------------------------------------------------------------------

function _pts(val, passThreshold, warnThreshold, inverted = false) {
  if (val === null || val === undefined) return 10; // missing → neutral
  if (!inverted) {
    if (val > passThreshold) return 20;
    if (val >= warnThreshold) return 10;
    return 0;
  } else {
    // lower is better (e.g. double faults)
    if (val < passThreshold) return 20;
    if (val < warnThreshold) return 10;
    return 0;
  }
}

function _rating(pts) {
  return pts === 20 ? 'pass' : pts === 10 ? 'warn' : 'fail';
}

/**
 * Score a single player's set serve statistics.
 *
 * @param {object} stats — { firstServeIn, firstServeWon, secondServeWon, aces, doubleFaults }
 * @returns {{ score: number, breakdown: object }}
 */
function score(stats = {}) {
  const p1 = _pts(stats.firstServeIn,   63, 55);
  const p2 = _pts(stats.firstServeWon,  68, 60);
  const p3 = _pts(stats.secondServeWon, 52, 44);
  const p4 = _pts(stats.aces,            3,  1);  // ≥4 = pass (>3), ≥2 = warn
  const p5 = _pts(stats.doubleFaults,    2,  5, true); // <2 = pass, <5 = warn

  const total = p1 + p2 + p3 + p4 + p5;

  return {
    score: total,
    breakdown: {
      firstServeIn:   { value: stats.firstServeIn   ?? null, rating: _rating(p1), points: p1 },
      firstServeWon:  { value: stats.firstServeWon  ?? null, rating: _rating(p2), points: p2 },
      secondServeWon: { value: stats.secondServeWon ?? null, rating: _rating(p3), points: p3 },
      aces:           { value: stats.aces           ?? null, rating: _rating(p4), points: p4 },
      doubleFaults:   { value: stats.doubleFaults   ?? null, rating: _rating(p5), points: p5 },
    },
  };
}

/**
 * Score both players for a set and compute the differential.
 *
 * @param {object} setServeStats  — e.g. matchState.liveServeStatsSet1 { playerA:{...}, playerB:{...} }
 * @param {'playerA'|'playerB'} winnerKey — which player won the set
 * @returns {{ winner: ScoreResult, loser: ScoreResult, differential: number }}
 *   differential = loser.score − winner.score (positive = loser outserved = overreaction trade)
 */
function compareSet(setServeStats = {}, winnerKey) {
  const loserKey = winnerKey === 'playerA' ? 'playerB' : 'playerA';
  const winner = score(setServeStats[winnerKey] || {});
  const loser  = score(setServeStats[loserKey]  || {});
  return {
    winner,
    loser,
    differential: loser.score - winner.score,
  };
}

/**
 * Human-readable verdict for the differential.
 */
function verdict(differential) {
  if (differential >= 20) return 'strong — market overreacted';
  if (differential >= 0)  return 'marginal — use caution';
  if (differential >= -15) return 'neutral — both served similarly';
  return 'stand aside — underdog earned the set';
}

module.exports = { score, compareSet, verdict };
