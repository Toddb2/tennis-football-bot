'use strict';

/**
 * historicalLoader.js
 *
 * Loads pre-match player statistics used by the probability model from
 * data/serve_stats.json (local cache).
 *
 * Stats are keyed by normalised player name so they can be looked up from
 * either the Betfair match name or the api-tennis.com match name.
 *
 * Usage:
 *   const loader = new HistoricalLoader();
 *   await loader.init();
 *   const statsA = loader.getPlayerStats('Djokovic');
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger');
const { normaliseName, playerNamesMatch } = require('../utils/helpers');

const CACHE_FILE = path.join(__dirname, '../../data/serve_stats.json');

// ATP default serve stats by surface — used when no player-specific data is available
const ATP_DEFAULTS = {
  clay:  { serveWin: 0.62, returnWin: 0.38, holdPct: 0.82, breakPct: 0.28 },
  hard:  { serveWin: 0.64, returnWin: 0.39, holdPct: 0.84, breakPct: 0.27 },
  grass: { serveWin: 0.66, returnWin: 0.37, holdPct: 0.86, breakPct: 0.25 },
  carpet:{ serveWin: 0.65, returnWin: 0.38, holdPct: 0.85, breakPct: 0.26 },
};

// WTA default serve stats by surface
const WTA_DEFAULTS = {
  clay:  { serveWin: 0.56, returnWin: 0.44, holdPct: 0.73, breakPct: 0.37 },
  hard:  { serveWin: 0.58, returnWin: 0.44, holdPct: 0.75, breakPct: 0.36 },
  grass: { serveWin: 0.60, returnWin: 0.42, holdPct: 0.77, breakPct: 0.34 },
  carpet:{ serveWin: 0.59, returnWin: 0.43, holdPct: 0.76, breakPct: 0.35 },
};

class HistoricalLoader {
  constructor() {
    /** @type {Map<string, object>}  normalisedName → player stats */
    this._cache    = new Map();
    this._lastLoad = null;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load stats from cache file (and optionally refresh from API).
   * Must be called once at startup.
   */
  async init() {
    await this._loadFromFile();
    logger.info('HistoricalLoader: initialised', { cachedPlayers: this._cache.size });
  }

  /**
   * Get stats for a player by name. Fuzzy-matches against the cache.
   *
   * @param {string} name — player name (any format)
   * @returns {object|null}  — player stats object, or null if not found
   */
  getPlayerStats(name) {
    if (!name) return null;

    const key     = normaliseName(name);
    const direct  = this._cache.get(key);
    if (direct) return direct;

    // Fuzzy: use playerNamesMatch which handles "Surname Initial." formats
    for (const [, stats] of this._cache) {
      if (playerNamesMatch(name, stats.name || '')) return stats;
    }

    return null;
  }

  /**
   * Get the best available surface stats for a player, falling back to
   * ATP/WTA defaults if the player isn't in the cache.
   *
   * @param {string}  name
   * @param {string}  surface  — "clay"|"hard"|"grass"|"carpet"
   * @param {'atp'|'wta'} [tour]
   * @returns {object}  { serveWin, returnWin, holdPct, breakPct }
   */
  getSurfaceStats(name, surface, tour = 'atp') {
    const player    = this.getPlayerStats(name);
    const surf      = (surface || 'hard').toLowerCase();
    const defaults  = tour === 'wta' ? WTA_DEFAULTS : ATP_DEFAULTS;

    if (player?.surfaceStats?.[surf]) return player.surfaceStats[surf];

    // Try averaging across known surfaces
    if (player?.surfaceStats) {
      const vals = Object.values(player.surfaceStats);
      if (vals.length > 0) {
        const avg = key => vals.reduce((s, v) => s + (v[key] || 0), 0) / vals.length;
        return {
          serveWin:  avg('serveWin'),
          returnWin: avg('returnWin'),
          holdPct:   avg('holdPct'),
          breakPct:  avg('breakPct'),
        };
      }
    }

    return defaults[surf] || defaults.hard;
  }

  /**
   * Manually set stats for a player (used by integration test or manual seeding).
   * @param {string} name
   * @param {object} stats
   */
  setPlayerStats(name, stats) {
    const key = normaliseName(name);
    this._cache.set(key, { ...stats, name });
  }

  /**
   * Build a historicalStats object in the shape expected by probabilityModel,
   * given the two player names from a match.
   *
   * @param {string} nameA
   * @param {string} nameB
   * @param {string} surface
   * @returns {{ playerA: object, playerB: object }}
   */
  buildMatchHistoricalStats(nameA, nameB, surface) {
    const statA = this.getPlayerStats(nameA) || this._syntheticPlayer(nameA, surface);
    const statB = this.getPlayerStats(nameB) || this._syntheticPlayer(nameB, surface);
    return { playerA: statA, playerB: statB };
  }

  // ---------------------------------------------------------------------------
  // Cache file I/O
  // ---------------------------------------------------------------------------

  async _loadFromFile() {
    try {
      const raw    = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);

      this._lastLoad = parsed.lastUpdated ? new Date(parsed.lastUpdated) : null;

      const players = parsed.players || {};
      for (const [id, stats] of Object.entries(players)) {
        const key = normaliseName(stats.name || id);
        this._cache.set(key, stats);
      }

      logger.info('HistoricalLoader: loaded from cache file', { players: this._cache.size });
    } catch (err) {
      if (err.code === 'ENOENT') {
        logger.warn('HistoricalLoader: cache file not found, starting empty');
      } else {
        logger.error('HistoricalLoader: failed to read cache file', { message: err.message });
      }
    }
  }

  _saveToFile() {
    try {
      const players = {};
      for (const [key, stats] of this._cache) {
        const id = stats.playerId || key;
        players[id] = stats;
      }

      const payload = {
        _comment:    'Cached player serve/return stats. Refreshed daily at midnight by historicalLoader.js.',
        lastUpdated: new Date().toISOString(),
        players,
      };

      fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
      logger.info('HistoricalLoader: cache saved', { players: this._cache.size });
    } catch (err) {
      logger.error('HistoricalLoader: failed to save cache file', { message: err.message });
    }
  }


  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a synthetic player stats object using surface defaults.
   * Used as fallback when a player isn't in the cache.
   */
  _syntheticPlayer(name, surface) {
    const surf     = (surface || 'hard').toLowerCase();
    const defaults = ATP_DEFAULTS[surf] || ATP_DEFAULTS.hard;

    return {
      playerId:     normaliseName(name),
      name,
      surfaceStats: {
        clay:   ATP_DEFAULTS.clay,
        hard:   ATP_DEFAULTS.hard,
        grass:  ATP_DEFAULTS.grass,
        carpet: ATP_DEFAULTS.carpet,
      },
      recentForm: [],
      h2h: {},
      _synthetic: true,
    };
  }

  destroy() {
    // no-op — retained for call-site compatibility
  }
}

module.exports = HistoricalLoader;
