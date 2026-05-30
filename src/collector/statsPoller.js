'use strict';

/**
 * statsPoller.js
 *
 * api-tennis.com is the primary (and only) stats source.
 *
 * Sources used:
 *   WebSocket  wss://wss.api-tennis.com/live   — real-time match push (primary)
 *   get_livescore                              — 30 s HTTP fallback
 *   get_standings  (ATP + WTA)                 — rankings, fetched on startup + daily
 *   get_players                                — surface stats, fetched once per player_key
 *   get_H2H                                    — head-to-head, fetched once per match pair
 *   get_odds                                   — pre-match bookmaker odds, fetched once per match
 *   get_live_odds                              — in-play bookmaker odds, polled every 30 s
 *
 * Betfair Scores REST API (supplementary):
 *   listScores                                 — server + set scores for in-play markets, every 10 s
 *
 * Requires env vars:
 *   API_TENNIS_KEY  — api-tennis.com key (mandatory)
 */

const axios     = require('axios');
const WebSocket = require('ws');
const logger    = require('../utils/logger');
const { playerNamesMatch } = require('../utils/helpers');
const { inferSurface } = require('../utils/surfaceInference');

// Surface string → canonical form
const SURFACE_MAP = {
  clay:   'clay',
  hard:   'hard',
  grass:  'grass',
  carpet: 'carpet',
  indoor: 'hard',
};

// Tournament name substring → surface (api-tennis.com omits a surface field)
const TOURNAMENT_SURFACE_MAP = [
  // Hard outdoor
  ['miami',          'hard'],
  ['indian wells',   'hard'],
  ['australian open','hard'],
  ['us open',        'hard'],
  ['toronto',        'hard'],
  ['montreal',       'hard'],
  ['cincinnati',     'hard'],
  ['dubai',          'hard'],
  ['doha',           'hard'],
  ['rotterdam',      'hard'],
  ['beijing',        'hard'],
  ['tokyo',          'hard'],
  ['shanghai',       'hard'],
  ['acapulco',       'hard'],
  ['delray beach',   'hard'],
  ['dallas',         'hard'],
  ['san diego',      'hard'],
  ['washington',     'hard'],
  ['winston-salem',  'hard'],
  ['atlanta',        'hard'],
  ['astana',         'hard'],
  ['tel aviv',       'hard'],
  ['metz',           'hard'],
  ['sofia',          'hard'],
  ['stockholm',      'hard'],
  ['antwerp',        'hard'],
  ['vienna',         'hard'],
  ['paris',          'hard'],
  ['bercy',          'hard'],
  ['singapore',      'hard'],
  ['wuhan',          'hard'],
  ['florence',       'hard'],
  ['gijon',          'hard'],
  // Clay outdoor
  ['roland garros',  'clay'],
  ['french open',    'clay'],
  ['madrid',         'clay'],
  ['rome',           'clay'],
  ['monte carlo',    'clay'],
  ['monte-carlo',    'clay'],
  ['barcelona',      'clay'],
  ['hamburg',        'clay'],
  ['houston',        'clay'],
  ['estoril',        'clay'],
  ['lyon',           'clay'],
  ['bucharest',      'clay'],
  ['marrakech',      'clay'],
  ['budapest',       'clay'],
  ['kitzbuhel',      'clay'],
  ['umag',           'clay'],
  ['gstaad',         'clay'],
  ['palermo',        'clay'],
  ['prague',         'clay'],
  ['bogota',         'clay'],
  ['buenos aires',   'clay'],
  ['cordoba',        'clay'],
  ['rio',            'clay'],
  ['sao paulo',      'clay'],
  ['dubrovnik',      'clay'],
  ['istanbul',       'clay'],
  ['munich',         'clay'],
  ['geneva',         'clay'],
  ['bordeaux',       'clay'],
  ['aix-en-provence','clay'],
  ['tunis',          'clay'],
  ['casablanca',     'clay'],
  ['rabat',          'clay'],
  ['bastad',         'clay'],
  ['newport',        'clay'],
  ['sarajevo',       'clay'],
  ['seville',        'clay'],
  ['portoroz',       'clay'],
  ['cluj',           'clay'],
  ['marbella',       'clay'],
  ['lima',           'clay'],
  ['santiago',       'clay'],
  ['montevideo',     'clay'],
  ['concepcion',     'clay'],
  ['cancun',         'clay'],
  ['guadalajara',    'clay'],
  // Grass outdoor
  ['wimbledon',      'grass'],
  ['halle',          'grass'],
  ["queen's",        'grass'],
  ['queens',         'grass'],
  ['eastbourne',     'grass'],
  ['birmingham',     'grass'],
  ['nottingham',     'grass'],
  ['stuttgart',      'grass'],
  ['s-hertogenbosch','grass'],
];

class StatsPoller {
  /**
   * @param {object} opts
   * @param {object} opts.stateStore    — StateStore instance
   * @param {object} [opts.betfairStream] — BetfairStream instance (for Scores API auth)
   */
  constructor({ stateStore, betfairStream }) {
    this._stateStore    = stateStore;
    this._betfairStream = betfairStream || null;
    this._running       = false;

    // Timers
    this._staleTimer          = null;   // stale-score warning, 60 s
    this._scoresTimer         = null;   // Betfair Scores API, 10 s
    this._apiTennisTimer      = null;   // livescore HTTP fallback, 30 s
    this._liveOddsTimer       = null;   // get_live_odds, 30 s
    this._standingsTimer      = null;   // standings refresh, 24 h
    this._apiTennisWsReconnectTimer = null;

    // WebSocket state
    this._ws                  = null;
    this._wsReconnectDelayMs  = 15_000;

    // Enrichment caches
    this._standingsCache   = new Map();  // player_key → { rank, points, league, country, name }
    this._playerCache      = new Map();  // player_key → { country, season, rank, surface, overall }
    this._playerFetchQueue = new Set();  // player_keys currently being fetched
    this._h2hCache         = new Map();  // "p1:p2" (sorted) → processed h2h object
    this._h2hFetchQueue    = new Set();  // pair keys currently being fetched
    this._oddsCache        = new Map();  // event_key → bookmaker odds object
    this._oddsFetchQueue   = new Set();  // event_keys currently being fetched
    this._fixturesCache    = new Map();  // event_key → fixture meta (scheduled matches for next 2 days)
    this._fixturesTimer    = null;       // refreshes every 3 h

    // Circuit breakers — trip after N failures, auto-recover after 5 min
    this._apiTennisFailCount   = 0;
    this._apiTennisDisabled    = false;
    this._apiTennisDisabledAt  = null;   // timestamp of trip
    this._firstLogDone         = false;
    this._atUnlinkLogged       = new Set();

    this._scoresFailCount      = 0;
    this._scoresDisabled       = false;
    this._scoresDisabledAt     = null;
    this._scoresFirstLog       = true;

    if (!process.env.API_TENNIS_KEY) {
      logger.warn('StatsPoller: API_TENNIS_KEY not set — all stats disabled');
    }

    this._http = axios.create({
      baseURL: 'https://api.api-tennis.com/tennis/',
      timeout: 10_000,
      headers: { Accept: 'application/json' },
    });

    // NOTE: Betfair Exchange API does NOT expose live scores (per Betfair Dev FAQ).
    // This client is retained only to avoid a bigger refactor; _pollBetfairScores
    // is a no-op so it never gets called.
    this._httpScores = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start() {
    if (this._running) return;
    this._running = true;
    logger.info('StatsPoller: started');

    if (!process.env.API_TENNIS_KEY) return;

    // Fetch standings immediately (ATP + WTA), then refresh every 24 h
    setTimeout(() => this._fetchAllStandings().catch(() => {}), 3_000);
    this._standingsTimer = setInterval(
      () => this._fetchAllStandings().catch(err =>
        logger.debug('StatsPoller: standings refresh error', { message: err.message })
      ),
      24 * 60 * 60_000
    );
    if (this._standingsTimer.unref) this._standingsTimer.unref();

    // Seed live state via HTTP, then 30 s fallback
    setTimeout(() => this._pollLivescore().catch(() => {}), 5_000);
    this._apiTennisTimer = setInterval(
      () => this._pollLivescore().catch(err =>
        logger.debug('StatsPoller: livescore HTTP error', { message: err.message })
      ),
      30_000
    );
    if (this._apiTennisTimer.unref) this._apiTennisTimer.unref();

    // Real-time WebSocket (starts slightly after HTTP seed)
    setTimeout(() => this._connectWebSocket(), 6_000);

    // Fixtures (scheduled matches) for today + next 2 days — used to pre-link
    // upcoming Betfair markets and enrich the dashboard upcoming view with
    // tournament/round/surface/rank before a match goes live.
    setTimeout(() => this._pollFixtures().catch(() => {}), 8_000);
    this._fixturesTimer = setInterval(
      () => this._pollFixtures().catch(err =>
        logger.debug('StatsPoller: fixtures refresh error', { message: err.message })
      ),
      3 * 60 * 60_000
    );
    if (this._fixturesTimer.unref) this._fixturesTimer.unref();

    // Live bookmaker odds, every 30 s
    this._liveOddsTimer = setInterval(
      () => this._pollLiveOdds().catch(err =>
        logger.debug('StatsPoller: live odds error', { message: err.message })
      ),
      30_000
    );
    if (this._liveOddsTimer.unref) this._liveOddsTimer.unref();

    // Betfair Scores API — requires betfairStream for session token
    if (this._betfairStream) {
      setTimeout(() => this._pollBetfairScores().catch(() => {}), 5_000);
      this._scoresTimer = setInterval(
        () => this._pollBetfairScores().catch(err =>
          logger.debug('StatsPoller: Betfair Scores error', { message: err.message })
        ),
        10_000
      );
      if (this._scoresTimer.unref) this._scoresTimer.unref();
      logger.info('StatsPoller: Betfair Scores poller started');
    }

    // Stale-score warning, every 60 s
    this._staleTimer = setInterval(() => this._checkStaleScores(), 60_000);
    if (this._staleTimer.unref) this._staleTimer.unref();

    logger.info('StatsPoller: all sources started (WebSocket + HTTP + odds + rankings + H2H)');
  }

  stop() {
    const intervals = [
      '_staleTimer', '_scoresTimer', '_apiTennisTimer',
      '_liveOddsTimer', '_standingsTimer', '_fixturesTimer',
    ];
    for (const t of intervals) {
      if (this[t]) { clearInterval(this[t]); this[t] = null; }
    }
    if (this._apiTennisWsReconnectTimer) {
      clearTimeout(this._apiTennisWsReconnectTimer);
      this._apiTennisWsReconnectTimer = null;
    }
    if (this._ws) { this._ws.terminate(); this._ws = null; }
    this._running = false;
    logger.info('StatsPoller: stopped');
  }

  // ---------------------------------------------------------------------------
  // Stale-score check
  // ---------------------------------------------------------------------------

  _checkStaleScores() {
    const STALE_MS = 5 * 60_000;
    const now = Date.now();
    if (!this._stateStore) return;
    for (const m of this._stateStore.getAll()) {
      if (!m.isInPlay || m.status !== 'LIVE') continue;
      const last = m.timestamp || m.lastUpdated || 0;
      if (last && (now - last) > STALE_MS) {
        logger.warn('StatsPoller: STALE SCORE — no update for 5+ min', {
          matchName:     m.matchName,
          marketId:      m.betfairMarketId,
          linkedSource:  m.externalMatchId ? m.externalMatchId.split(':')[0] : 'none',
          lastUpdateMin: Math.floor((now - last) / 60000),
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Standings (get_standings)
  // ---------------------------------------------------------------------------

  async _fetchAllStandings() {
    await Promise.allSettled([
      this._fetchStandings('ATP'),
      this._fetchStandings('WTA'),
    ]);
  }

  async _fetchStandings(league) {
    try {
      const resp = await this._http.get('', {
        params: { method: 'get_standings', APIkey: process.env.API_TENNIS_KEY, event_type: league },
      });
      const results = Array.isArray(resp.data?.result) ? resp.data.result : [];
      let count = 0;
      for (const item of results) {
        if (!item.player_key) continue;
        this._standingsCache.set(String(item.player_key), {
          rank:     parseInt(item.place)  || null,
          points:   parseInt(item.points) || null,
          league,
          movement: item.movement || null,
          country:  item.country  || null,
          name:     item.player   || null,
        });
        count++;
      }
      logger.info('StatsPoller: standings updated', { league, count });
    } catch (err) {
      logger.warn('StatsPoller: standings fetch failed', { league, message: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Player stats (get_players) — fetched once per player_key, cached
  // ---------------------------------------------------------------------------

  _ensurePlayerStats(playerKey) {
    if (!playerKey) return;
    const key = String(playerKey);
    if (this._playerCache.has(key) || this._playerFetchQueue.has(key)) return;
    this._playerFetchQueue.add(key);
    this._fetchPlayerStats(key)
      .then(stats => { if (stats) this._playerCache.set(key, stats); })
      .catch(err => logger.debug('StatsPoller: player fetch error', { key, message: err.message }))
      .finally(() => this._playerFetchQueue.delete(key));
  }

  async _fetchPlayerStats(playerKey) {
    try {
      const resp = await this._http.get('', {
        params: { method: 'get_players', APIkey: process.env.API_TENNIS_KEY, player_key: playerKey },
      });
      const player = resp.data?.result?.[0];
      if (!player) return null;

      const statsArr = Array.isArray(player.stats) ? player.stats : [];
      // Most recent singles season
      const singles = statsArr
        .filter(s => !s.type || s.type === 'singles')
        .sort((a, b) => (parseInt(b.season) || 0) - (parseInt(a.season) || 0));
      const latest = singles[0] || {};

      return {
        country: player.player_country || null,
        season:  latest.season || null,
        rank:    parseInt(latest.rank)   || null,
        titles:  parseInt(latest.titles) || null,
        surface: {
          hard:  this._surfaceStat(latest.hard_won,  latest.hard_lost),
          clay:  this._surfaceStat(latest.clay_won,  latest.clay_lost),
          grass: this._surfaceStat(latest.grass_won, latest.grass_lost),
        },
        overall: {
          won:  parseInt(latest.matches_won)  || 0,
          lost: parseInt(latest.matches_lost) || 0,
        },
      };
    } catch (err) {
      logger.debug('StatsPoller: _fetchPlayerStats error', { playerKey, message: err.message });
      return null;
    }
  }

  _surfaceStat(wonRaw, lostRaw) {
    const won   = parseInt(wonRaw)  || 0;
    const lost  = parseInt(lostRaw) || 0;
    const total = won + lost;
    return {
      won,
      lost,
      winRate: total > 0 ? parseFloat(((won / total) * 100).toFixed(1)) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // H2H (get_H2H) — fetched once per unique player pair, cached
  // ---------------------------------------------------------------------------

  _h2hKey(p1, p2) {
    const a = String(p1), b = String(p2);
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  _ensureH2H(p1Key, p2Key) {
    if (!p1Key || !p2Key) return;
    const key = this._h2hKey(p1Key, p2Key);
    if (this._h2hCache.has(key) || this._h2hFetchQueue.has(key)) return;
    this._h2hFetchQueue.add(key);
    this._fetchH2H(p1Key, p2Key)
      .then(data => { if (data) this._h2hCache.set(key, data); })
      .catch(err => logger.debug('StatsPoller: H2H fetch error', { key, message: err.message }))
      .finally(() => this._h2hFetchQueue.delete(key));
  }

  async _fetchH2H(p1Key, p2Key) {
    try {
      const resp = await this._http.get('', {
        params: {
          method:            'get_H2H',
          APIkey:            process.env.API_TENNIS_KEY,
          first_player_key:  p1Key,
          second_player_key: p2Key,
        },
      });
      const result = resp.data?.result;
      if (!result) return null;

      const h2hMatches = Array.isArray(result.H2H)                  ? result.H2H                  : [];
      const p1Results  = Array.isArray(result.firstPlayerResults)   ? result.firstPlayerResults   : [];
      const p2Results  = Array.isArray(result.secondPlayerResults)  ? result.secondPlayerResults  : [];

      let p1Wins = 0, p2Wins = 0;
      for (const m of h2hMatches) {
        if (m.event_winner === 'First Player')  p1Wins++;
        else if (m.event_winner === 'Second Player') p2Wins++;
      }

      const recentForm = (matches, playerPos) =>
        matches.slice(0, 5)
          .map(m => {
            if (!m.event_winner) return null;
            return m.event_winner === (playerPos === 1 ? 'First Player' : 'Second Player') ? 'W' : 'L';
          })
          .filter(Boolean);

      return {
        total:        h2hMatches.length,
        p1Wins,
        p2Wins,
        p1RecentForm: recentForm(p1Results, 1),
        p2RecentForm: recentForm(p2Results, 2),
        lastH2H: h2hMatches.slice(0, 5).map(m => ({
          date:       m.event_date,
          score:      m.event_final_result,
          winner:     m.event_winner === 'First Player' ? 'p1'
                    : m.event_winner === 'Second Player' ? 'p2' : null,
          tournament: m.tournament_name,
          round:      this._parseRound(m.tournament_round),
        })),
      };
    } catch (err) {
      logger.debug('StatsPoller: _fetchH2H error', { p1Key, p2Key, message: err.message });
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Pre-match odds (get_odds) — fetched once per event_key, cached
  // ---------------------------------------------------------------------------

  _ensurePreMatchOdds(eventKey) {
    if (!eventKey) return;
    const key = String(eventKey);
    if (this._oddsCache.has(key) || this._oddsFetchQueue.has(key)) return;
    this._oddsFetchQueue.add(key);
    this._fetchPreMatchOdds(key)
      .then(odds => { if (odds) this._oddsCache.set(key, odds); })
      .catch(err => logger.debug('StatsPoller: odds fetch error', { key, message: err.message }))
      .finally(() => this._oddsFetchQueue.delete(key));
  }

  async _fetchPreMatchOdds(eventKey) {
    try {
      const resp = await this._http.get('', {
        params: { method: 'get_odds', APIkey: process.env.API_TENNIS_KEY, match_key: eventKey },
      });
      const raw = resp.data?.result?.[eventKey];
      if (!raw) return null;
      return this._processBookmakerOdds(raw);
    } catch (err) {
      logger.debug('StatsPoller: _fetchPreMatchOdds error', { eventKey, message: err.message });
      return null;
    }
  }

  _avgOdds(bookObj) {
    if (!bookObj || typeof bookObj !== 'object') return null;
    const vals = Object.values(bookObj).map(v => parseFloat(v)).filter(v => !isNaN(v) && v > 1);
    if (!vals.length) return null;
    return parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3));
  }

  _processBookmakerOdds(raw) {
    const homeAway = raw['Home/Away']          || {};
    const set1     = raw['Home/Away (1st Set)'] || {};
    const setBet   = raw['Set Betting']         || {};
    const ss1      = raw['Win In Straight Sets (Player 1)'] || {};
    const ss2      = raw['Win In Straight Sets (Player 2)'] || {};

    return {
      matchWinner: {
        homeAvg: this._avgOdds(homeAway.Home),
        awayAvg: this._avgOdds(homeAway.Away),
      },
      set1Winner: {
        homeAvg: this._avgOdds(set1.Home),
        awayAvg: this._avgOdds(set1.Away),
      },
      setBetting: {
        '2:0': this._avgOdds(setBet['2:0']),
        '2:1': this._avgOdds(setBet['2:1']),
        '0:2': this._avgOdds(setBet['0:2']),
        '1:2': this._avgOdds(setBet['1:2']),
      },
      straightSets: {
        p1: this._avgOdds(ss1.Yes),
        p2: this._avgOdds(ss2.Yes),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Live bookmaker odds (get_live_odds) — polled every 30 s
  // ---------------------------------------------------------------------------

  async _pollLiveOdds() {
    if (this._apiTennisDisabled) return;
    try {
      const resp = await this._http.get('', {
        params: { method: 'get_live_odds', APIkey: process.env.API_TENNIS_KEY },
      });
      const result = resp.data?.result;
      if (!result || typeof result !== 'object') return;

      let updated = 0;
      for (const [eventKey, matchData] of Object.entries(result)) {
        const atId = `at:${eventKey}`;
        const ms   = this._stateStore.getByExternalId(atId);
        if (!ms) continue;
        const odds = Array.isArray(matchData.live_odds) ? matchData.live_odds : [];
        if (!odds.length) continue;
        this._stateStore.upsert(ms.betfairMarketId, { liveBookmakerOdds: odds, timestamp: Date.now() }, 'stats');
        updated++;
      }
      if (updated > 0) logger.debug('StatsPoller: live odds updated', { markets: updated });
    } catch (err) {
      logger.debug('StatsPoller: live odds poll failed', { message: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket (real-time push)
  // ---------------------------------------------------------------------------

  _connectWebSocket() {
    if (!this._running || this._apiTennisDisabled) return;

    const url = `wss://wss.api-tennis.com/live?APIkey=${process.env.API_TENNIS_KEY}`;
    logger.info('StatsPoller: WebSocket connecting', {
      url: url.replace(/APIkey=[^&]+/, 'APIkey=***'),
    });

    const ws = new WebSocket(url);
    this._ws = ws;
    let openedAt = null;

    ws.on('open', () => {
      openedAt = Date.now();
      logger.info('StatsPoller: WebSocket connected — receiving real-time pushes');
    });

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(String(data));
        // API sends an array of all matches that received an update
        const matches = Array.isArray(parsed) ? parsed : [parsed];
        for (const match of matches) {
          if (!match || typeof match !== 'object' || Array.isArray(match)) continue;

          if (!this._firstLogDone &&
              !String(match.event_first_player  || '').includes('/') &&
              !String(match.event_second_player || '').includes('/')) {
            this._firstLogDone = true;
            logger.info('StatsPoller: WS first singles message sample', {
              sample: JSON.stringify(match).slice(0, 1600),
            });
          }

          this._processMatch(match).catch(err =>
            logger.debug('StatsPoller: WS process error', { message: err.message })
          );
        }
      } catch (err) {
        logger.debug('StatsPoller: WS parse error', { message: err.message });
      }
    });

    ws.on('close', (code) => {
      this._ws = null;
      if (!this._running) return;
      const livedMs = openedAt ? Date.now() - openedAt : 0;
      this._wsReconnectDelayMs = livedMs < 5_000
        ? Math.min(this._wsReconnectDelayMs * 2, 5 * 60_000)
        : 15_000;
      const delay = this._wsReconnectDelayMs;
      logger.warn(`StatsPoller: WS closed — reconnecting in ${Math.round(delay / 1000)} s`, { code });
      this._apiTennisWsReconnectTimer = setTimeout(() => {
        this._apiTennisWsReconnectTimer = null;
        this._connectWebSocket();
      }, delay);
    });

    ws.on('error', (err) => {
      logger.warn('StatsPoller: WS error', { message: err.message });
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP livescore fallback (get_livescore)
  // ---------------------------------------------------------------------------

  async _pollLivescore() {
    // Auto-recover circuit breaker after 5 min
    if (this._apiTennisDisabled) {
      if (Date.now() - this._apiTennisDisabledAt > 5 * 60_000) {
        this._apiTennisDisabled   = false;
        this._apiTennisFailCount  = 0;
        this._apiTennisDisabledAt = null;
        logger.info('StatsPoller: API Tennis circuit breaker RESET — retrying');
        try { require('../database/systemEventRepo').info('statsPoller', 'API Tennis circuit breaker reset'); } catch (_) {}
      } else {
        return;
      }
    }
    const allMatches = this._stateStore.getAll();
    const unlinked   = allMatches.filter(m => !m.externalMatchId);
    const atLinked   = allMatches.filter(m => m.externalMatchId?.startsWith('at:'));
    if (unlinked.length === 0 && atLinked.length === 0) return;

    const matches = await this._fetchLive();
    if (!matches.length) return;

    logger.info('StatsPoller: HTTP livescore', {
      total: matches.length, unlinked: unlinked.length, atLinked: atLinked.length,
    });
    for (const match of matches) {
      await this._processMatch(match);
    }
  }

  async _fetchLive() {
    try {
      const resp = await this._http.get('', {
        params: { method: 'get_livescore', APIkey: process.env.API_TENNIS_KEY },
      });
      const data = resp.data || {};

      if (!this._firstLogDone && data.result?.length > 0) {
        const singles = data.result.find(e =>
          !String(e.event_first_player  || '').includes('/') &&
          !String(e.event_second_player || '').includes('/')
        );
        if (singles) {
          this._firstLogDone = true;
          logger.info('StatsPoller: HTTP first singles sample', {
            sample: JSON.stringify(singles).slice(0, 1600),
          });
        }
      }

      this._apiTennisFailCount = 0;
      const results = Array.isArray(data.result) ? data.result : [];
      return results.filter(e =>
        String(e.event_live) === '1' &&
        String(e.event_status || '').toLowerCase() !== 'finished'
      );
    } catch (err) {
      this._apiTennisFailCount++;
      if (this._apiTennisFailCount >= 5 && !this._apiTennisDisabled) {
        this._apiTennisDisabled   = true;
        this._apiTennisDisabledAt = Date.now();
        logger.warn('StatsPoller: API Tennis circuit breaker OPEN — will retry in 5 min', {
          message: err.message, status: err.response?.status,
        });
        try { require('../database/systemEventRepo').warn('statsPoller', `API Tennis circuit breaker opened: ${err.message}`, { status: err.response?.status }); } catch (_) {}
      } else if (!this._apiTennisDisabled) {
        logger.warn('StatsPoller: livescore fetch failed', {
          message: err.message, status: err.response?.status,
        });
      }
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Match processing
  // ---------------------------------------------------------------------------

  async _processMatch(match) {
    const homeName = match.event_first_player  || '';
    const awayName = match.event_second_player || '';
    if (!homeName || !awayName) return;
    if (homeName.includes('/') || awayName.includes('/')) return;  // skip doubles

    const p1Key    = String(match.first_player_key  || '');
    const p2Key    = String(match.second_player_key || '');
    const eventKey = String(match.event_key || '');
    const atId     = `at:${eventKey}`;

    // Fire-and-forget enrichment fetches — results appear in stateStore on next update
    this._ensurePlayerStats(p1Key);
    this._ensurePlayerStats(p2Key);
    this._ensureH2H(p1Key, p2Key);
    this._ensurePreMatchOdds(eventKey);

    const update = this._buildUpdate(atId, match);
    if (!update) return;

    // If already linked, push update (re-oriented to the market's A/B order)
    const existing = this._stateStore.getByExternalId(atId);
    if (existing) {
      this._stateStore.upsert(existing.betfairMarketId, this._orientToMarket(update, existing), 'stats');
      return;
    }

    // Find matching Betfair market by player name
    const ms = this._stateStore.findMarketForExternalMatch(update.matchName);
    if (!ms) {
      if (!this._atUnlinkLogged.has(atId)) {
        this._atUnlinkLogged.add(atId);
        const betfairNames = [...this._stateStore.matches.values()]
          .map(m => m.matchName).slice(0, 10);
        logger.info('StatsPoller: could not link (will not repeat)', {
          apiName:       update.matchName,
          betfairSample: betfairNames,
          betfairTotal:  this._stateStore.matches.size,
        });
      }
      return;
    }

    // Don't overwrite an existing link (shouldn't happen but guard anyway)
    if (ms.externalMatchId) return;

    this._stateStore.linkStatsToMarket(atId, ms.betfairMarketId);
    this._stateStore.upsert(ms.betfairMarketId, this._orientToMarket(update, ms), 'stats');
    logger.info('StatsPoller: linked match', {
      apiName:     update.matchName,
      betfairName: ms.matchName,
      marketId:    ms.betfairMarketId,
    });
  }

  /**
   * Ensure a stats update's playerA/playerB correspond to the Betfair market's
   * A/B ordering. api-tennis and Betfair can list the two players in opposite
   * order; without this, scores, serve stats, break points, ranks and player
   * keys would attach to the WRONG player (and so would settlement and momentum).
   *
   * Orientation is re-derived from the player names on every update, so it is
   * correct even after a restart restores the link from the DB. If the names
   * can't be matched either way we leave the update untouched (no worse than
   * before) rather than guess.
   *
   * @param {object}     update — output of _buildUpdate (api-tennis order)
   * @param {MatchState} ms     — the linked Betfair market
   * @returns {object} the update, possibly with playerA/playerB swapped
   */
  _orientToMarket(update, ms) {
    if (!update || !ms) return update;
    const [extA, extB] = String(update.matchName || '').split(' v ').map(s => s.trim());
    const [mktA, mktB] = String(ms.matchName    || '').split(' v ').map(s => s.trim());
    if (!extA || !extB || !mktA || !mktB) return update;

    const direct   = playerNamesMatch(extA, mktA) && playerNamesMatch(extB, mktB);
    const reversed = playerNamesMatch(extA, mktB) && playerNamesMatch(extB, mktA);
    if (direct || !reversed) return update;   // already aligned, or undeterminable

    if (!this._reversedLogged) this._reversedLogged = new Set();
    if (!this._reversedLogged.has(ms.betfairMarketId)) {
      this._reversedLogged.add(ms.betfairMarketId);
      logger.warn('StatsPoller: api-tennis player order reversed vs Betfair — swapping to align', {
        apiName: update.matchName, betfairName: ms.matchName, marketId: ms.betfairMarketId,
      });
    }
    return this._swapUpdatePlayers(update);
  }

  /** Return a shallow clone of a stats update with all paired playerA/playerB fields swapped. */
  _swapUpdatePlayers(u) {
    const swapPair = o => (o ? { playerA: o.playerB, playerB: o.playerA } : o);
    const sw = { ...u };
    if (Array.isArray(u.sets)) sw.sets = u.sets.map(s => ({ playerA: s.playerB, playerB: s.playerA }));
    if (u.currentGame) sw.currentGame = swapPair(u.currentGame);
    if (u.currentServer === 'playerA') sw.currentServer = 'playerB';
    else if (u.currentServer === 'playerB') sw.currentServer = 'playerA';
    for (const k of ['serveStats', 'serveStatsSet1', 'serveStatsSet2', 'serveStatsSet3',
                     'breakPoints', 'breakPointsSet1', 'breakPointsSet2', 'breakPointsSet3']) {
      if (u[k]) sw[k] = swapPair(u[k]);
    }
    sw.playerAKey          = u.playerBKey;          sw.playerBKey          = u.playerAKey;
    sw.playerARank         = u.playerBRank;         sw.playerBRank         = u.playerARank;
    sw.playerACountry      = u.playerBCountry;      sw.playerBCountry      = u.playerACountry;
    sw.playerASurfaceStats = u.playerBSurfaceStats; sw.playerBSurfaceStats = u.playerASurfaceStats;
    if (u.h2hStats) {
      const h = u.h2hStats;
      sw.h2hStats = { ...h, p1Wins: h.p2Wins, p2Wins: h.p1Wins,
                      p1RecentForm: h.p2RecentForm, p2RecentForm: h.p1RecentForm };
    }
    return sw;
  }

  _buildUpdate(externalId, match) {
    const homeName = match.event_first_player  || null;
    const awayName = match.event_second_player || null;
    if (!homeName || !awayName) return null;

    const p1Key    = String(match.first_player_key  || '');
    const p2Key    = String(match.second_player_key || '');
    const eventKey = String(match.event_key || '');

    // Enrich with whatever is already cached (empty on first update, populated quickly)
    const p1Standing = this._standingsCache.get(p1Key) || null;
    const p2Standing = this._standingsCache.get(p2Key) || null;
    const p1Stats    = this._playerCache.get(p1Key)    || null;
    const p2Stats    = this._playerCache.get(p2Key)    || null;
    const h2h        = this._h2hCache.get(this._h2hKey(p1Key, p2Key)) || null;
    const bookOdds   = this._oddsCache.get(eventKey)   || null;

    return {
      externalMatchId:     externalId,
      matchName:           `${homeName} v ${awayName}`,
      tournamentName:      match.tournament_name || null,
      tournamentRound:     this._parseRound(match.tournament_round),
      surface:             this._parseSurface(match),
      sets:                this._parseSets(match),
      currentGame:         this._parseGameScore(match),
      currentServer:       this._parseServer(match),
      serveStats:          this._parseServeStats(match),
      serveStatsSet1:      this._parseServeStats(match, 1),
      serveStatsSet2:      this._parseServeStats(match, 2),
      serveStatsSet3:      this._parseServeStats(match, 3),
      breakPoints:         this._parseBreakPoints(match),
      breakPointsSet1:     this._parseBreakPoints(match, 1),
      breakPointsSet2:     this._parseBreakPoints(match, 2),
      breakPointsSet3:     this._parseBreakPoints(match, 3),
      playerAKey:          p1Key || null,
      playerBKey:          p2Key || null,
      playerARank:         p1Standing?.rank    ?? null,
      playerBRank:         p2Standing?.rank    ?? null,
      playerACountry:      p1Stats?.country    ?? p1Standing?.country ?? null,
      playerBCountry:      p2Stats?.country    ?? p2Standing?.country ?? null,
      playerASurfaceStats: p1Stats             ?? null,
      playerBSurfaceStats: p2Stats             ?? null,
      h2hStats:            h2h                 ?? null,
      bookmakerOdds:       bookOdds            ?? null,
      timestamp:           Date.now(),
    };
  }

  // ---------------------------------------------------------------------------
  // Parse helpers (api-tennis.com field format)
  // ---------------------------------------------------------------------------

  _parseRound(raw) {
    if (!raw) return null;
    const part = raw.includes(' - ') ? raw.split(' - ').pop().trim() : raw.trim();
    const s = part.toLowerCase();
    // Check fraction-named rounds FIRST — they contain "final" in the string
    if (s === '1/4-finals'  || s.includes('quarter'))        return 'QF';
    if (s === '1/8-finals'  || s.includes('round of 16'))    return 'R16';
    if (s === '1/16-finals' || s.includes('round of 32'))    return 'R32';
    if (s === '1/32-finals' || s.includes('round of 64'))    return 'R64';
    if (s === '1/64-finals' || s.includes('round of 128'))   return 'R128';
    // Named rounds after fractions
    if (s.includes('semi'))                                   return 'SF';
    if (s.includes('final'))                                  return 'F';
    return part || null;
  }

  _parseSurface(match) {
    return inferSurface({
      tournament:   match.tournament_name,
      eventSurface: match.event_surface,
      courtSurface: match.court_surface,
      venue:        match.event_venue || match.venue,
    });
  }

  _parseSets(match) {
    if (Array.isArray(match.scores) && match.scores.length > 0) {
      return match.scores.map(s => ({
        playerA: parseInt(s.score_first  ?? s.home ?? 0) || 0,
        playerB: parseInt(s.score_second ?? s.away ?? 0) || 0,
      }));
    }
    const raw = String(match.event_final_result || '');
    if (!raw || raw === '-') return [];
    return raw.split(',').map(part => {
      const [a, b] = part.trim().split('-').map(n => parseInt(n) || 0);
      return { playerA: a || 0, playerB: b || 0 };
    });
  }

  _parseGameScore(match) {
    const raw = String(match.event_game_result || '');
    if (!raw || raw === '-') return { playerA: 0, playerB: 0 };
    const POINT_MAP = { '0': 0, '15': 15, '30': 30, '40': 40, 'AD': 50, 'A': 50 };
    const [rawA, rawB] = raw.split('-');
    const mapPt = v => {
      const s = String(v || '0').toUpperCase().trim();
      if (POINT_MAP[s] != null) return POINT_MAP[s];
      const n = parseInt(s, 10);   // `?? parseInt(s) ?? 0` left NaN through (NaN is not null)
      return Number.isNaN(n) ? 0 : n;
    };
    return { playerA: mapPt(rawA), playerB: mapPt(rawB) };
  }

  _parseServer(match) {
    const s = String(match.event_serve || '').toLowerCase();
    if (s === 'first player')  return 'playerA';
    if (s === 'second player') return 'playerB';
    return null;
  }

  /**
   * Derive serve stats from api-tennis.com data.
   *
   * Primary: statistics[] array — per-player rows keyed by player_key:
   *   { player_key, stat_period: "match"|"set1"|"set2"|..., stat_name, stat_value }
   *
   * Fallback: pointbypoint game records → serve hold rate as firstServeWon proxy.
   */
  _parseServeStats(match, setNum = null) {
    const stats = {
      playerA: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
      playerB: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
    };

    const statsArr = Array.isArray(match.statistics) ? match.statistics : [];
    const p1Key    = String(match.first_player_key  || '');
    const p2Key    = String(match.second_player_key || '');
    const period   = setNum === null ? 'match' : `set${setNum}`;

    for (const item of statsArr) {
      if (item.stat_period !== period) continue;
      const pKey   = String(item.player_key || '');
      const player = pKey === p1Key ? 'playerA' : pKey === p2Key ? 'playerB' : null;
      if (!player) continue;
      const name = (item.stat_name || '').toLowerCase();
      const val  = String(item.stat_value || '');
      if (name === 'aces')                       stats[player].aces           = this._parseNum(val);
      else if (name === 'double faults')         stats[player].doubleFaults   = this._parseNum(val);
      else if (name === '1st serve percentage')  stats[player].firstServeIn   = this._parsePct(val);
      else if (name === '1st serve points won')  stats[player].firstServeWon  = this._parsePct(val);
      else if (name === '2nd serve points won')  stats[player].secondServeWon = this._parsePct(val);
    }

    const gotStats = Object.values(stats.playerA).some(v => v !== null) ||
                     Object.values(stats.playerB).some(v => v !== null);
    if (gotStats) return stats;

    // Fallback: derive serve hold rate from pointbypoint game records
    let pbp = Array.isArray(match.pointbypoint) ? match.pointbypoint : [];
    if (!pbp.length) return stats;

    if (setNum !== null) {
      pbp = pbp.filter(g => {
        const sn = g.set_number ?? g.set ?? g.setNumber ?? null;
        if (sn === null) return false;
        const n = typeof sn === 'number' ? sn : parseInt(String(sn).replace(/\D+/g, ''), 10);
        return !isNaN(n) && n === setNum;
      });
      if (!pbp.length) return stats;
    }

    let aGames = 0, aHolds = 0, bGames = 0, bHolds = 0;
    for (const game of pbp) {
      const server = (game.player_served || '').toLowerCase();
      if (!server) continue;
      const isA   = server.includes('first');
      const winner = game.serve_winner;
      const lost   = game.serve_lost;
      if (winner === null && lost === null) continue;
      let held;
      if (typeof winner === 'number' && typeof lost === 'number') held = winner > lost;
      else if (typeof winner === 'string') held = winner.toLowerCase().includes(isA ? 'first' : 'second');
      else held = Boolean(winner);
      if (isA) { aGames++; if (held) aHolds++; }
      else      { bGames++; if (held) bHolds++; }
    }
    if (aGames > 0) stats.playerA.firstServeWon = parseFloat(((aHolds / aGames) * 100).toFixed(1));
    if (bGames > 0) stats.playerB.firstServeWon = parseFloat(((bHolds / bGames) * 100).toFixed(1));
    return stats;
  }

  _parseBreakPoints(match, setNum = null) {
    const bp = {
      playerA: { created: 0, converted: 0 },
      playerB: { created: 0, converted: 0 },
    };

    // Primary: statistics array — "Break Points Converted" gives receiver's break points created/converted
    const statsArr = Array.isArray(match.statistics) ? match.statistics : [];
    const p1Key    = String(match.first_player_key  || '');
    const p2Key    = String(match.second_player_key || '');
    const period   = setNum === null ? 'match' : `set${setNum}`;

    for (const item of statsArr) {
      if (item.stat_period !== period) continue;
      const pKey   = String(item.player_key || '');
      const player = pKey === p1Key ? 'playerA' : pKey === p2Key ? 'playerB' : null;
      if (!player) continue;
      const name = (item.stat_name || '').toLowerCase();
      if (name === 'break points converted') {
        bp[player].created   = item.stat_total || 0;
        bp[player].converted = item.stat_won   || 0;
      }
    }

    if (bp.playerA.created > 0 || bp.playerB.created > 0) return bp;

    // Fallback: derive from pointbypoint game records
    // break_point field is "First Play" / "Second Play" (non-null = break point exists)
    let pbp = Array.isArray(match.pointbypoint) ? match.pointbypoint : [];
    if (setNum !== null) {
      pbp = pbp.filter(g => {
        const sn = g.set_number ?? g.set ?? g.setNumber ?? null;
        if (sn === null) return false;
        const n = typeof sn === 'number' ? sn : parseInt(String(sn).replace(/\D+/g, ''), 10);
        return !isNaN(n) && n === setNum;
      });
      if (!pbp.length) return bp;
    }

    for (const game of pbp) {
      const server = (game.player_served || '').toLowerCase();
      if (!server || game.serve_winner === null) continue;
      const isA    = server.includes('first');
      const points = Array.isArray(game.points) ? game.points : [];
      // break_point is "First Play" or "Second Play" (not a boolean)
      const hadBP  = points.some(p => p.break_point !== null && p.break_point !== undefined && p.break_point !== '');
      if (!hadBP) continue;
      const creator = isA ? 'playerB' : 'playerA';
      bp[creator].created++;
      const winner    = String(game.serve_winner || '').toLowerCase();
      const serverWon = isA ? winner.includes('first') : winner.includes('second');
      if (!serverWon) bp[creator].converted++;
    }
    return bp;
  }

  // ---------------------------------------------------------------------------
  // Betfair Scores REST API (server + set scores for every in-play market)
  // ---------------------------------------------------------------------------

  async _pollBetfairScores() {
    // No-op: Betfair Exchange API does not expose live scores (confirmed via
    // Betfair Dev FAQ, 2026-05-25). Leaving the method here so the interval
    // timer + start path still wires up cleanly without throwing.
    return;
    // eslint-disable-next-line no-unreachable
    if (this._scoresDisabled) {
      if (Date.now() - this._scoresDisabledAt > 5 * 60_000) {
        this._scoresDisabled   = false;
        this._scoresFailCount  = 0;
        this._scoresDisabledAt = null;
        logger.info('StatsPoller: Betfair Scores circuit breaker RESET — retrying');
        try { require('../database/systemEventRepo').info('statsPoller', 'Betfair Scores circuit breaker reset'); } catch (_) {}
      } else {
        return;
      }
    }
    const token  = this._betfairStream?.getSessionToken();
    const appKey = process.env.BETFAIR_APP_KEY;
    if (!token || !appKey) return;

    const liveIds = this._stateStore.getAll()
      .filter(m => m.isInPlay && m.status === 'LIVE')
      .map(m => m.betfairMarketId);
    if (liveIds.length === 0) return;

    for (let i = 0; i < liveIds.length; i += 100) {
      const batch = liveIds.slice(i, i + 100);
      let results;
      try {
        const resp = await this._httpScores.post('', {
          jsonrpc: '2.0',
          method:  'SportsAPING/v1.0/listScores',
          params:  { updateKeys: batch.map(marketId => ({ marketId, lastUpdateSequenceNumber: 0 })) },
          id:      1,
        }, {
          headers: { 'X-Application': appKey, 'X-Authentication': token },
        });
        if (resp.data?.error) throw new Error(`Betfair error: ${JSON.stringify(resp.data.error)}`);
        results = Array.isArray(resp.data?.result) ? resp.data.result : [];
      } catch (err) {
        this._scoresFailCount++;
        if (this._scoresFailCount >= 3 && !this._scoresDisabled) {
          this._scoresDisabled   = true;
          this._scoresDisabledAt = Date.now();
          logger.warn('StatsPoller: Betfair Scores circuit breaker OPEN — will retry in 5 min');
          try { require('../database/systemEventRepo').warn('statsPoller', 'Betfair Scores circuit breaker opened', { message: err.message }); } catch (_) {}
        } else if (!this._scoresDisabled) {
          logger.warn('StatsPoller: Betfair Scores API failed', {
            message: err.message, status: err.response?.status,
          });
        }
        return;
      }

      if (this._scoresFirstLog && results.length > 0) {
        this._scoresFirstLog = false;
        const sample = results.find(r => r.score) || results[0];
        logger.info('StatsPoller: Betfair Scores first response', {
          count: results.length,
          sample: JSON.stringify(sample).slice(0, 600),
        });
      }

      let updated = 0;
      for (const item of results) {
        if (this._applyBetfairScore(item)) updated++;
      }
      if (updated > 0) logger.debug('StatsPoller: Betfair Scores applied', { updated });
    }
  }

  _applyBetfairScore(item) {
    if (!item?.marketId || !item.score) return false;
    const { marketId, score } = item;
    const ms = this._stateStore.get(marketId);
    if (!ms?.isInPlay) return false;

    const update = { timestamp: Date.now() };

    if (score.homeCurrentServer !== undefined) {
      update.currentServer = score.homeCurrentServer ? 'playerA' : 'playerB';
    }

    if (score.currentGame) {
      const mapPt = v => {
        const s = String(v ?? '0').toUpperCase();
        return { '0': 0, '15': 15, '30': 30, '40': 40, 'A': 50, 'AD': 50 }[s] ?? parseInt(v) ?? 0;
      };
      update.currentGame = {
        playerA: mapPt(score.currentGame.homeScore),
        playerB: mapPt(score.currentGame.awayScore),
      };
    }

    if (score.currentSet) {
      const curA = parseInt(score.currentSet.homeScore) || 0;
      const curB = parseInt(score.currentSet.awayScore) || 0;
      const existing = ms.sets || [];

      const _isComplete = s =>
        !!(s && (
          (s.playerA >= 6 && s.playerA - s.playerB >= 2) || s.playerA === 7 ||
          (s.playerB >= 6 && s.playerB - s.playerA >= 2) || s.playerB === 7
        ));

      if (existing.length === 0) {
        update.sets = [{ playerA: curA, playerB: curB }];
      } else if (_isComplete(existing[existing.length - 1])) {
        update.sets = [...existing, { playerA: curA, playerB: curB }];
      } else {
        const updated = [...existing];
        updated[updated.length - 1] = { playerA: curA, playerB: curB };
        update.sets = updated;
      }
    }

    this._stateStore.upsert(marketId, update, 'stats');
    return true;
  }

  // ---------------------------------------------------------------------------
  // Scheduled fixtures (get_fixtures) — fetched on startup + every 3 h
  //
  // Builds a cache of upcoming/today's scheduled matches keyed by event_key so
  // the dashboard upcoming view can be enriched with tournament/round/surface/
  // rank, and so player-stats / H2H / pre-match-odds are pre-warmed before
  // the match goes live.
  // ---------------------------------------------------------------------------

  async _pollFixtures() {
    if (this._apiTennisDisabled) return;
    const fmt = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };
    const now    = new Date();
    const start  = new Date(now); start.setDate(start.getDate() - 1); // catch overnight late finishes
    const end    = new Date(now); end.setDate(end.getDate() + 2);     // look ahead 2 days

    try {
      const resp = await this._http.get('', {
        params: {
          method:     'get_fixtures',
          APIkey:     process.env.API_TENNIS_KEY,
          date_start: fmt(start),
          date_stop:  fmt(end),
        },
      });
      const results = Array.isArray(resp.data?.result) ? resp.data.result : [];

      let added = 0;
      for (const f of results) {
        if (!f || !f.event_key) continue;
        const homeName = f.event_first_player  || '';
        const awayName = f.event_second_player || '';
        if (!homeName || !awayName) continue;
        if (homeName.includes('/') || awayName.includes('/')) continue; // doubles

        const eventKey = String(f.event_key);
        const fixture = {
          eventKey,
          p1Key:      String(f.first_player_key  || ''),
          p2Key:      String(f.second_player_key || ''),
          p1Name:     homeName,
          p2Name:     awayName,
          matchName:  `${homeName} v ${awayName}`,
          tournament: f.tournament_name || null,
          round:      this._parseRound(f.tournament_round),
          surface:    this._parseSurface(f),
          startTime:  f.event_date && f.event_time
            ? `${f.event_date}T${f.event_time}:00`
            : (f.event_date || null),
          league:     f.event_type_type || f.tournament_season || null,
        };
        const wasNew = !this._fixturesCache.has(eventKey);
        this._fixturesCache.set(eventKey, fixture);
        if (wasNew) added++;

        // Pre-warm enrichment caches — fire-and-forget. Already deduped
        // internally via _ensurePlayerStats / _ensureH2H / _ensurePreMatchOdds.
        this._ensurePlayerStats(fixture.p1Key);
        this._ensurePlayerStats(fixture.p2Key);
        this._ensureH2H(fixture.p1Key, fixture.p2Key);
        this._ensurePreMatchOdds(eventKey);

        // Best-effort pre-link to a Betfair market we already know about
        if (this._stateStore) {
          const ms = this._stateStore.findMarketForExternalMatch(fixture.matchName);
          if (ms && !ms.externalMatchId) {
            const atId = `at:${eventKey}`;
            this._stateStore.linkStatsToMarket(atId, ms.betfairMarketId);
            this._stateStore.upsert(ms.betfairMarketId, {
              externalMatchId: atId,
              tournamentName:  fixture.tournament,
              tournamentRound: fixture.round,
              surface:         fixture.surface,
            }, 'stats');
          }
        }
      }

      // Prune fixtures older than ~36 h so the cache doesn't grow forever
      const cutoffMs = now.getTime() - 36 * 60 * 60_000;
      for (const [k, fx] of this._fixturesCache.entries()) {
        const t = fx.startTime ? new Date(fx.startTime).getTime() : 0;
        if (t && t < cutoffMs) this._fixturesCache.delete(k);
      }

      logger.info('StatsPoller: fixtures updated', {
        total: this._fixturesCache.size, added, returned: results.length,
      });
    } catch (err) {
      logger.warn('StatsPoller: fixtures fetch failed', {
        message: err.message, status: err.response?.status,
      });
    }
  }

  /**
   * Look up a cached fixture by a Betfair-style match name ("Player A v Player B").
   * Uses the same fuzzy player matcher as stateStore so abbreviated /
   * compound surname variants resolve correctly.
   * @param {string} matchName
   * @returns {object|null} enriched fixture object, or null if not found
   */
  getEnrichedFixtureForMatchName(matchName) {
    if (!matchName) return null;
    const parts = matchName.split(' v ');
    if (parts.length !== 2) return null;
    const [bfA, bfB] = parts.map(s => s.trim());
    if (!bfA || !bfB) return null;

    for (const fx of this._fixturesCache.values()) {
      const match =
        (playerNamesMatch(bfA, fx.p1Name) && playerNamesMatch(bfB, fx.p2Name)) ||
        (playerNamesMatch(bfA, fx.p2Name) && playerNamesMatch(bfB, fx.p1Name));
      if (!match) continue;
      const p1Standing = this._standingsCache.get(fx.p1Key) || null;
      const p2Standing = this._standingsCache.get(fx.p2Key) || null;
      const p1Stats    = this._playerCache.get(fx.p1Key)    || null;
      const p2Stats    = this._playerCache.get(fx.p2Key)    || null;
      const h2h        = this._h2hCache.get(this._h2hKey(fx.p1Key, fx.p2Key)) || null;
      const bookOdds   = this._oddsCache.get(fx.eventKey)   || null;
      // Decide which fixture player corresponds to Betfair A vs Betfair B
      const directOrder = playerNamesMatch(bfA, fx.p1Name);
      return {
        eventKey:   fx.eventKey,
        tournament: fx.tournament,
        round:      fx.round,
        surface:    fx.surface,
        startTime:  fx.startTime,
        playerARank:    directOrder ? (p1Standing?.rank ?? null) : (p2Standing?.rank ?? null),
        playerBRank:    directOrder ? (p2Standing?.rank ?? null) : (p1Standing?.rank ?? null),
        playerACountry: directOrder
          ? (p1Stats?.country ?? p1Standing?.country ?? null)
          : (p2Stats?.country ?? p2Standing?.country ?? null),
        playerBCountry: directOrder
          ? (p2Stats?.country ?? p2Standing?.country ?? null)
          : (p1Stats?.country ?? p1Standing?.country ?? null),
        h2h, bookOdds,
      };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  _parsePct(raw) {
    if (raw == null) return null;
    const n = parseFloat(String(raw).replace('%', ''));
    return isNaN(n) ? null : n;
  }

  _parseNum(raw) {
    if (raw == null) return null;
    const n = parseInt(String(raw), 10);
    return isNaN(n) ? null : n;
  }
}

module.exports = StatsPoller;
