'use strict';

/**
 * snapshotLoader.js
 *
 * Reads real captured market data from the SQLite database (market_snapshots
 * table) and converts it into the format expected by StrategyReplayer.
 *
 * This is more accurate than the historical CSV loader because:
 *   - Exact set scores are stored (not inferred from price movements)
 *   - Serve stats are available at every snapshot point
 *   - Pre-match odds are reliably captured
 *   - Surface and tournament are known
 *
 * Usage:
 *   const loader = new SnapshotLoader();
 *   const markets = loader.loadMarkets({ from: '2026-04-01', to: '2026-04-30' });
 *   // each market: { marketId, matchName, surface, tournament, preMatchOddsA, preMatchOddsB,
 *   //               totalMatched, snapshots: [...], setCompletions: [...] }
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../data/tennis-bot.db');

class SnapshotLoader {
  constructor() {
    try {
      this._db = new Database(DB_PATH, { readonly: true });
    } catch (err) {
      throw new Error(`SnapshotLoader: cannot open database — has the bot run yet? (${err.message})`);
    }
  }

  /**
   * Load all markets in a date range, with their snapshots grouped by market.
   * @param {{ from?: string, to?: string }} opts  — ISO date strings (YYYY-MM-DD)
   * @returns {object[]}
   */
  loadMarkets({ from, to } = {}) {
    // Build date filter
    const fromTs = from ? `${from}T00:00:00Z` : '2000-01-01T00:00:00Z';
    const toTs   = to   ? `${to}T23:59:59Z`   : '2100-01-01T00:00:00Z';

    // Fetch markets in range
    const markets = this._db.prepare(`
      SELECT *
      FROM markets
      WHERE went_in_play_at >= ? AND went_in_play_at <= ?
        AND ended_at IS NOT NULL
    `).all(fromTs, toTs);

    console.log(`  SnapshotLoader: found ${markets.length} completed markets in range`);

    const result = [];

    for (const market of markets) {
      const snaps = this._db.prepare(`
        SELECT * FROM market_snapshots
        WHERE betfair_market_id = ?
        ORDER BY ts
      `).all(market.betfair_market_id);

      if (snaps.length < 5) continue;  // too few snapshots to be useful

      // Parse JSON columns in snapshots
      const parsedSnaps = snaps.map(s => ({
        ...s,
        sets:         s.sets         ? JSON.parse(s.sets)         : null,
        current_game: s.current_game ? JSON.parse(s.current_game) : null,
        serve_stats:  s.serve_stats  ? JSON.parse(s.serve_stats)  : null,
      }));

      // Detect set completions from actual score data (not price heuristics)
      const setCompletions = this._detectSetCompletions(parsedSnaps);
      if (!setCompletions.length) continue;

      const maxVolume = parsedSnaps.reduce((max, s) => Math.max(max, s.matched_volume || 0), 0);

      result.push({
        marketId:       market.betfair_market_id,
        matchName:      market.match_name,
        surface:        market.surface       || null,
        tournament:     market.tournament    || null,
        preMatchOddsA:  market.pre_match_odds_a || null,
        preMatchOddsB:  market.pre_match_odds_b || null,
        totalMatched:   maxVolume,
        finalSets:      market.final_sets    ? JSON.parse(market.final_sets) : null,
        winner:         market.winner        || null,
        snapshots:      parsedSnaps,
        setCompletions,
      });
    }

    return result;
  }

  /**
   * Detect exactly when each set completed by watching the sets array in snapshots.
   * Returns one entry per set completion with the odds at the moment of completion.
   */
  _detectSetCompletions(snaps) {
    const completions = [];
    let lastSetCount = 0;

    for (let i = 0; i < snaps.length; i++) {
      const s = snaps[i];
      if (!Array.isArray(s.sets)) continue;

      const completeSets = s.sets.filter(st => this._isSetComplete(st));
      if (completeSets.length <= lastSetCount) continue;

      // New set completed
      const targetSet = completeSets[completeSets.length - 1];
      const setNum    = completeSets.length;

      // Winner of this set
      const aWon = targetSet.playerA > targetSet.playerB;

      completions.push({
        setNumber:        setNum,
        timestamp:        s.ts,
        winnerEstimate:   aWon ? 'playerA' : 'playerB',
        score:            [targetSet.playerA, targetSet.playerB],
        isTiebreak:       (targetSet.playerA === 7 && targetSet.playerB === 6) ||
                          (targetSet.playerB === 7 && targetSet.playerA === 6),
        priceA_after:     s.player_a_back,
        priceB_after:     s.player_b_back,
        snapshotIndex:    i,
        // Serve stats at set completion (set-specific)
        serveStats: s.serve_stats ? {
          set1: s.serve_stats.set1 || null,
          set2: s.serve_stats.set2 || null,
        } : null,
      });

      lastSetCount = completeSets.length;
    }

    return completions;
  }

  _isSetComplete(set) {
    if (!set) return false;
    const aWon = (set.playerA >= 6 && set.playerA - set.playerB >= 2) || set.playerA === 7;
    const bWon = (set.playerB >= 6 && set.playerB - set.playerA >= 2) || set.playerB === 7;
    return aWon || bWon;
  }

  /** Return summary stats about available data in the DB. */
  getDataSummary() {
    try {
      const total    = this._db.prepare(`SELECT COUNT(*) AS n FROM markets WHERE ended_at IS NOT NULL`).get().n;
      const snaps    = this._db.prepare(`SELECT COUNT(*) AS n FROM market_snapshots`).get().n;
      const earliest = this._db.prepare(`SELECT MIN(went_in_play_at) AS d FROM markets`).get().d;
      const latest   = this._db.prepare(`SELECT MAX(went_in_play_at) AS d FROM markets`).get().d;
      return { completedMarkets: total, totalSnapshots: snaps, earliest, latest };
    } catch (_) {
      return { completedMarkets: 0, totalSnapshots: 0, earliest: null, latest: null };
    }
  }

  close() {
    this._db.close();
  }
}

module.exports = SnapshotLoader;
