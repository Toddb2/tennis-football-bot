'use strict';
/**
 * cbbStream.js
 *
 * SSE client for the CBB external stream endpoint.
 * Emits 'marketUpdate' events in the same shape as betfairStream.js.
 *
 * Events emitted:
 *   'marketUpdate' — same shape as betfairStream marketUpdate
 *   'connected'    — stream connected and snapshot received
 *   'disconnected' — stream closed (reconnect scheduled)
 *   'degraded'     — failed CBB_FAIL_THRESHOLD times, fallback active
 *   'recovered'    — stream reconnected after degraded
 */

const EventEmitter = require('events');
const http         = require('http');
const logger       = require('../utils/logger');

const CBB_URL         = (process.env.CBB_URL || 'http://77.72.7.148:6616').replace(/\/$/, '');
const RECONNECT_MS    = parseInt(process.env.CBB_RECONNECT_MS  || '5000',  10);
const FAIL_THRESHOLD  = parseInt(process.env.CBB_FAIL_THRESHOLD || '3',     10);

class CbbStream extends EventEmitter {
  constructor() {
    super();
    this._req          = null;
    this._failures     = 0;
    this._degraded     = false;
    this._stopped      = false;
    this._reconnTimer  = null;
  }

  start() {
    this._stopped = false;
    logger.info('CbbStream: starting', { url: CBB_URL });
    this._connect();
  }

  stop() {
    this._stopped = true;
    if (this._reconnTimer) { clearTimeout(this._reconnTimer); this._reconnTimer = null; }
    if (this._req) { this._req.destroy(); this._req = null; }
    logger.info('CbbStream: stopped');
  }

  get isDegraded() { return this._degraded; }

  _connect() {
    if (this._stopped) return;

    const path = '/api/tennis/external/stream?inPlay=true';
    logger.info('CbbStream: connecting', { path });

    let buffer = '';

    const req = http.get({
      hostname: '77.72.7.148',
      port:     6616,
      path,
      headers:  { Accept: 'text/event-stream', Connection: 'keep-alive' },
      timeout:  30000,
    }, (res) => {
      if (res.statusCode !== 200) {
        logger.warn('CbbStream: bad status', { status: res.statusCode });
        res.resume();
        this._onError(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      logger.info('CbbStream: HTTP connected', { status: res.statusCode });

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const block of parts) {
          const lines = block.split('\n').filter(Boolean);
          let event = 'message';
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) this._handleEvent(event, dataLines.join('\n'));
        }
      });

      res.on('end', () => {
        logger.warn('CbbStream: stream ended');
        this._onDisconnect();
      });

      res.on('error', (err) => this._onError(err));
    });

    req.on('error', (err) => this._onError(err));
    req.on('timeout', () => {
      logger.warn('CbbStream: request timeout');
      req.destroy();
    });

    this._req = req;
  }

  _handleEvent(event, dataRaw) {
    if (event === 'heartbeat') return;

    let data;
    try { data = JSON.parse(dataRaw); } catch (e) {
      logger.warn('CbbStream: JSON parse error', { event, message: e.message });
      return;
    }

    if (event === 'connected') {
      logger.info('CbbStream: connected', data);
      this._failures = 0;
      if (this._degraded) {
        logger.info('CbbStream: recovered');
        this._degraded = false;
        this.emit('recovered');
      }
      this.emit('connected');
      return;
    }

    if (event === 'snapshot') {
      logger.info('CbbStream: snapshot received', { count: data.count });
      for (const market of (data.markets || [])) {
        const update = this._mapMarket(market);
        if (update) this.emit('marketUpdate', update);
      }
      return;
    }

    if (event === 'market') {
      const update = this._mapMarket(data.market);
      if (update) this.emit('marketUpdate', update);
      return;
    }

    if (event === 'error') {
      logger.warn('CbbStream: server error event', data);
    }
  }

  _mapMarket(m) {
    if (!m || !Array.isArray(m.runners) || m.runners.length < 2) return null;
    try {
      const [rA, rB] = m.runners;
      const pA   = rA.ipPrices || rA.prices || {};
      const pB   = rB.ipPrices || rB.prices || {};
      const ppA  = rA.ppPrices || {};
      const ppB  = rB.ppPrices || {};
      const inPlay = m.in_play === true;
      const status = m.status === 'CLOSED' ? 'CLOSED' : (inPlay ? 'LIVE' : 'OPEN');

      return {
        marketId:      m.marketId,
        eventId:       m.eventId       || null,
        matchName:     m.event_name    || null,
        eventName:     m.competition_name || null,
        marketType:    'MATCH_ODDS',
        inPlay,
        status,
        matchedVolume: parseFloat(m.total_matched || 0),
        timestamp:     Date.now(),
        prePlayOddsA:    ppA.back ?? null,
        prePlayOddsB:    ppB.back ?? null,
        runners: [
          { selectionId: rA.selectionId, name: rA.name, backPrice: pA.back ?? null, layPrice: pA.lay ?? null, lastTradedPrice: pA.ltp ?? null, matchedVolume: 0 },
          { selectionId: rB.selectionId, name: rB.name, backPrice: pB.back ?? null, layPrice: pB.lay ?? null, lastTradedPrice: pB.ltp ?? null, matchedVolume: 0 },
        ],
      };
    } catch (e) {
      logger.warn('CbbStream: map error', { marketId: m?.marketId, message: e.message });
      return null;
    }
  }

  _onError(err) {
    if (this._stopped) return;
    this._failures++;
    logger.warn('CbbStream: error', { message: err.message, failures: this._failures });
    if (this._failures >= FAIL_THRESHOLD && !this._degraded) {
      logger.warn('CbbStream: degraded — Betfair stream fallback active');
      this._degraded = true;
      this.emit('degraded');
    }
    this._onDisconnect();
  }

  _onDisconnect() {
    if (this._stopped) return;
    if (this._req) { this._req.destroy(); this._req = null; }
    this.emit('disconnected');
    logger.info('CbbStream: reconnecting', { ms: RECONNECT_MS });
    this._reconnTimer = setTimeout(() => this._connect(), RECONNECT_MS);
  }
}

module.exports = CbbStream;
