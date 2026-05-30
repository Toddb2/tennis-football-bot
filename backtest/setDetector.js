'use strict';

/**
 * setDetector.js
 *
 * Detects set-completion events from Betfair historical price data.
 * When a set finishes, the winning player's odds drop sharply and the
 * loser's odds spike. We look for jumps ≥ MIN_PRICE_JUMP_PCT.
 *
 * Accuracy is limited by data granularity:
 *   Basic plan  (1 price/min) → detection within ~1 minute of actual set end
 *   Advanced    (tick-by-tick) → near-exact
 */

class SetDetector {

  constructor() {
    this.MIN_PRICE_JUMP_PCT  = 15;          // % move that signals a set
    this.DETECTION_WINDOW_MS = 60 * 1000;  // max look-ahead window
  }

  /**
   * Analyse a market and return detected set-completion events.
   * Each event carries estimated timing, winner, and before/after prices.
   */
  detectSets(market) {
    const runners = [...market.runners.values()];
    if (runners.length !== 2) return [];

    const [runnerA, runnerB] = runners;
    const events   = [];
    const timeline = this._buildUnifiedTimeline(runnerA, runnerB);

    if (!timeline.find(t => t.inPlay)) return [];

    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1];
      const curr = timeline[i];
      if (!curr.inPlay || !prev.priceA || !curr.priceA) continue;

      const changePct = Math.abs((curr.priceA - prev.priceA) / prev.priceA) * 100;
      if (changePct < this.MIN_PRICE_JUMP_PCT) continue;

      const aWon = curr.priceA < prev.priceA;

      events.push({
        timestamp:           curr.timestamp,
        estimatedSetNumber:  events.length + 1,
        winnerEstimate:      aWon ? 'playerA' : 'playerB',
        priceA_before:       prev.priceA,
        priceA_after:        curr.priceA,
        priceB_before:       prev.priceB,
        priceB_after:        curr.priceB,
        changePct:           changePct.toFixed(1),
        confidence:          changePct > 30 ? 'high' : 'medium',
      });
    }

    return events;
  }

  /** Extract the last pre-match price for a runner (before inPlay). */
  getPreMatchPrice(runner) {
    const pre = runner.priceHistory.filter(p => !p.inPlay && p.price);
    return pre.length ? pre[pre.length - 1].price : null;
  }

  _buildUnifiedTimeline(runnerA, runnerB) {
    const tsSet = new Set([
      ...runnerA.priceHistory.map(p => p.timestamp),
      ...runnerB.priceHistory.map(p => p.timestamp),
    ]);

    return [...tsSet].sort().map(ts => {
      const a = runnerA.priceHistory.find(p => p.timestamp === ts);
      const b = runnerB.priceHistory.find(p => p.timestamp === ts);
      return {
        timestamp: ts,
        inPlay:    a?.inPlay || b?.inPlay || false,
        priceA:    a?.price  || null,
        priceB:    b?.price  || null,
      };
    });
  }
}

module.exports = SetDetector;
