'use strict';
/**
 * cbbPoller.js
 *
 * Polls the CBB external prices endpoint every POLL_INTERVAL_MS and emits
 * 'marketUpdate' events in the same shape as betfairStream.js so the rest
 * of the bot (stateStore, index.js) needs zero changes.
 *
 * Primary source: CBB endpoint (live, non-delayed prices)
 * Fallback:       betfairStream (delayed) takes over automatically if CBB
 *                 fails CBB_FAIL_THRESHOLD consecutive times.
 *
 * Env vars (optional — defaults shown):
 *   CBB_URL            — base URL of the CBB prices API
 *   CBB_POLL_MS        — poll interval in ms (default 5000)
 *   CBB_FAIL_THRESHOLD — consecutive failures before fallback (default 3)
 */

const EventEmitter = require('events');
const http         = require('http');
const logger       = require('../utils/logger');

const CBB_URL            = process.env.CBB_URL       || 'http://77.72.7.148:6616';
const POLL_INTERVAL_MS   = parseInt(process.env.CBB_POLL_MS || '5000', 10);
const FAIL_THRESHOLD     = parseInt(process.env.CBB_FAIL_THRESHOLD || '3', 10);

class CbbPoller extends EventEmitter {
  constructor() {
    super();
    this._timer       = null;
    this._polling     = false;
    this._failures    = 0;
    this._degraded    = false;   // true = CBB failing, fallback active
    this._lastMarkets = new Map(); // marketId → last update ts
  }

  start() {
    logger.info('CbbPoller: starting', { url: CBB_URL, intervalMs: POLL_INTERVAL_MS });
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_INTERVAL_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    logger.info('CbbPoller: stopped');
  }

  get isDegraded() { return this._degraded; }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    const date = new Date().toISOString().slice(0, 10);
    try {
      const resp = await new Promise((resolve, reject) => {
        const url = new URL(`${CBB_URL}/api/tennis/external/prices?date=${date}`);
        const req = http.get({ hostname: url.hostname, port: url.port, path: url.pathname + url.search, timeout: 10000, headers: { 'Connection': 'close' } }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('JSON parse failed')); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });

      if (!Array.isArray(resp)) throw new Error('Unexpected response shape');

      this._failures = 0;
      if (this._degraded) {
        logger.info('CbbPoller: recovered — resuming as primary price source');
        this._degraded = false;
        this.emit('recovered');
      }

      this._polling = false;
      logger.info('CbbPoller: poll ok', { markets: resp.length });
      for (const market of resp) {
        // Skip non-MATCH_ODDS and closed markets with no runners
        if (market.market_type && market.market_type !== 'MATCH_ODDS') continue;
        if (!Array.isArray(market.runners) || market.runners.length < 2) continue;

        const update = this._mapMarket(market);
        if (update) this.emit('marketUpdate', update);
      }

    } catch (err) {
      this._polling = false;
      this._failures++;
      logger.warn('CbbPoller: poll failed', {
        message:  err.message,
        failures: this._failures,
        threshold: FAIL_THRESHOLD,
      });
      if (this._failures >= FAIL_THRESHOLD && !this._degraded) {
        logger.warn('CbbPoller: threshold reached — falling back to Betfair stream');
        this._degraded = true;
        this.emit('degraded');
      }
    }
  }

  _mapMarket(m) {
    try {
      const [rA, rB] = m.runners;
      const pricesA  = rA.ipPrices || rA.ppPrices || rA.prices || {};
      const pricesB  = rB.ipPrices || rB.ppPrices || rB.prices || {};

      // Use in-play prices when available, fall back to pre-play
      const backA = pricesA.back ?? null;
      const layA  = pricesA.lay  ?? null;
      const backB = pricesB.back ?? null;
      const layB  = pricesB.lay  ?? null;
      const tvA   = parseFloat(pricesA.tv  || 0);
      const tvB   = parseFloat(pricesB.tv  || 0);
      const totalMatched = parseFloat(m.total_matched || 0) || (tvA + tvB);

      const inPlay = m.in_play === true;
      const status = m.status === 'CLOSED' ? 'CLOSED' : (inPlay ? 'LIVE' : 'OPEN');

      return {
        marketId:      m.marketId,
        eventId:       m.eventId       || null,
        matchName:     m.event_name    || null,
        eventName:     m.competition_name || null,
        marketType:    m.market_type   || 'MATCH_ODDS',
        inPlay,
        status,
        matchedVolume: totalMatched,
        timestamp:     Date.now(),
        runners: [
          {
            selectionId:     rA.selectionId,
            name:            rA.name,
            backPrice:       backA,
            layPrice:        layA,
            lastTradedPrice: pricesA.ltp ?? null,
            matchedVolume:   tvA,
          },
          {
            selectionId:     rB.selectionId,
            name:            rB.name,
            backPrice:       backB,
            layPrice:        layB,
            lastTradedPrice: pricesB.ltp ?? null,
            matchedVolume:   tvB,
          },
        ],
      };
    } catch (e) {
      logger.warn('CbbPoller: failed to map market', { marketId: m.marketId, message: e.message });
      return null;
    }
  }
}

module.exports = CbbPoller;
