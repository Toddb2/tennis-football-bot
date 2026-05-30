'use strict';

/**
 * historicalLoader.js
 *
 * Loads and caches pre-match player statistics used by the probability model.
 *
 * Source priority:
 *   1. RapidAPI tennis statistics endpoint  (if RAPIDAPI_KEY is set)
 *   2. data/serve_stats.json                (local cache — always present as fallback)
 *
 * The local cache is refreshed from RapidAPI once daily at midnight.
 * Stats are keyed by normalised player name so they can be looked up from
 * either the Betfair match name or the Sofascore match name.
 *
 * Usage:
 *   const loader = new HistoricalLoader();
 *   await loader.init();
 *   const statsA = loader.getPlayerStats('Djokovic');
 */

const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const logger = require('../utils/logger');
const { normaliseName, playerNamesMatch } = require('../utils/helpers');

const CACHE_FILE     = path.join(__dirname, '../../data/serve_stats.json');
const REFRESH_HOUR   = 0;    // midnight
const REFRESH_MINUTE = 0;

// RapidAPI endpoint for tennis player stats
// https://rapidapi.com/api-sports/api/tennis-live-data
const RAPIDAPI_HOST    = 'tennisapi1.p.rapidapi.com';
const RAPIDAPI_BASE    = `https://${RAPIDAPI_HOST}`;

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
    this._cache     = new Map();
    this._lastLoad  = null;
    this._refreshTimer = null;

    this._rapidApiKey = process.env.RAPIDAPI_KEY || null;
    this._http = this._rapidApiKey
      ? axios.create({
          baseURL: RAPIDAPI_BASE,
          timeout: 15_000,
          headers: {
            'X-RapidAPI-Host': RAPIDAPI_HOST,
            'X-RapidAPI-Key':  this._rapidApiKey,
          },
        })
      : null;
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
    await this._maybeRefreshFromApi();
    this._scheduleNightlyRefresh();
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
  // RapidAPI refresh
  // ---------------------------------------------------------------------------

  async _maybeRefreshFromApi() {
    if (!this._http) {
      logger.debug('HistoricalLoader: no RAPIDAPI_KEY — skipping API refresh');
      return;
    }

    // Skip if we refreshed today already
    if (this._lastLoad) {
      const todayMidnight = new Date();
      todayMidnight.setHours(0, 0, 0, 0);
      if (this._lastLoad >= todayMidnight) {
        logger.debug('HistoricalLoader: cache is fresh, skipping refresh');
        return;
      }
    }

    await this._refreshFromApi();
  }

  async _refreshFromApi() {
    logger.info('HistoricalLoader: refreshing player stats from RapidAPI');

    try {
      // Fetch ATP + WTA rankings to get player IDs
      const [atpResp, wtaResp] = await Promise.all([
        this._http.get('/api/tennis/rankings/atp'),
        this._http.get('/api/tennis/rankings/wta'),
      ]);
      const players = [
        ...(atpResp.data?.results || []),
        ...(wtaResp.data?.results || []),
      ];

      let updated = 0;
      for (const entry of players.slice(0, 50)) {
        const playerId = entry.player?.id;
        const name     = entry.player?.fullname || entry.player?.name;
        if (!playerId || !name) continue;

        try {
          const statsResp = await this._http.get(`/player/${playerId}`);
          const raw       = statsResp.data?.results;
          if (!raw) continue;

          const mapped = this._mapRapidApiPlayer(raw, name);
          if (mapped) {
            const key = normaliseName(name);
            this._cache.set(key, mapped);
            updated++;
          }

          // Respect rate limit — RapidAPI free tier allows ~20 req/min
          await new Promise(r => setTimeout(r, 3_500));
        } catch (inner) {
          logger.debug('HistoricalLoader: failed to fetch player stats', {
            name, message: inner.message,
          });
        }
      }

      this._saveToFile();
      logger.info('HistoricalLoader: API refresh complete', { updated });
    } catch (err) {
      logger.error('HistoricalLoader: API refresh failed', { message: err.message });
    }
  }

  /**
   * Map a RapidAPI player stats response to the canonical format.
   * @param {object} raw
   * @param {string} name
   */
  _mapRapidApiPlayer(raw, name) {
    if (!raw) return null;

    // RapidAPI returns surface stats under different structures depending on endpoint version
    // This handles the common shape
    const surfaceStats = {};

    const surfaces = ['clay', 'hard', 'grass'];
    for (const surf of surfaces) {
      const s = raw[surf] || raw[`${surf}_court`];
      if (!s) continue;

      surfaceStats[surf] = {
        serveWin:  this._pct(s.serve_win_pct  || s.first_serve_won_pct),
        returnWin: this._pct(s.return_win_pct || s.first_return_won_pct),
        holdPct:   this._pct(s.hold_pct       || s.service_games_won_pct),
        breakPct:  this._pct(s.break_pct      || s.return_games_won_pct),
      };
    }

    // Recent form (last 10 results): 1=win, 0=loss
    const recentForm = (raw.recent_results || [])
      .slice(0, 10)
      .map(r => (r.result === 'W' || r.result === 1) ? 1 : 0);

    return {
      playerId:    raw.id || normaliseName(name),
      name,
      surfaceStats: Object.keys(surfaceStats).length > 0 ? surfaceStats : undefined,
      recentForm,
      h2h: {},
    };
  }

  _pct(val) {
    if (val == null) return null;
    const n = parseFloat(val);
    // Normalise to 0–1 range (RapidAPI sometimes returns 0–100, sometimes 0–1)
    return isNaN(n) ? null : n > 1 ? n / 100 : n;
  }

  // ---------------------------------------------------------------------------
  // Nightly refresh scheduler
  // ---------------------------------------------------------------------------

  _scheduleNightlyRefresh() {
    // Calculate ms until next midnight
    const msUntilMidnight = this._msUntilTime(REFRESH_HOUR, REFRESH_MINUTE);
    logger.debug('HistoricalLoader: next refresh scheduled', { msUntilMidnight });

    this._refreshTimer = setTimeout(async () => {
      await this._refreshFromApi();
      // Re-schedule for the following midnight
      this._scheduleNightlyRefresh();
    }, msUntilMidnight);

    // Prevent the timer from blocking process exit
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  _msUntilTime(hour, minute) {
    const now   = new Date();
    const next  = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
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

  /** Stop background refresh timer (call on shutdown). */
  destroy() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}

module.exports = HistoricalLoader;
