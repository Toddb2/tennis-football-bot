'use strict';

/**
 * betfairStream.js
 *
 * Betfair Exchange Streaming API client.
 *
 * Transport: raw TLS socket to stream-api.betfair.com:443 using the BFLP
 * (line-delimited JSON) protocol. This is NOT a WebSocket connection — Betfair's
 * stream endpoint speaks raw TLS. Using ws/wss produces "Parse Error: Expected HTTP/"
 * because the server never sends an HTTP upgrade response.
 *
 * Connection sequence:
 *   1. POST to identitysso-cert.betfair.com/api/certlogin with client cert + credentials
 *      → receive sessionToken
 *   2. Open raw TLS socket to stream-api.betfair.com:443 with client cert
 *      → server sends { op: "connection" }
 *   3. Send { op: "authentication", appKey, session: sessionToken }
 *      → server sends { op: "status", statusCode: "SUCCESS" }
 *   4. Send { op: "marketSubscription", ... }
 *      → server streams MarketChangeMessages
 *
 * Emits:
 *   'marketUpdate'  — { marketId, eventId, matchName, marketType, runners,
 *                       inPlay, status, matchedVolume, timestamp }
 *   'connected'     — stream authenticated and subscribed
 *   'disconnected'  — stream closed (reconnect will follow)
 *   'error'         — Error object
 *
 * Requires env vars:
 *   BETFAIR_CERT_PATH  — absolute path to client .crt file
 *   BETFAIR_KEY_PATH   — absolute path to client .key file
 *   BETFAIR_USERNAME   — Betfair account username
 *   BETFAIR_PASSWORD   — Betfair account password
 *   BETFAIR_STREAM_ENABLED — must be "true" to connect
 */

const EventEmitter = require('events');
const fs           = require('fs');
const https        = require('https');
const tls          = require('tls');
const logger       = require('../utils/logger');

const STREAM_HOST     = 'stream-api.betfair.com';
const STREAM_PORT     = 443;
const CERTLOGIN_HOST  = 'identitysso-cert.betfair.com';
const CERTLOGIN_PATH  = '/api/certlogin';

// Only subscribe to match-winner markets — SET_BETTING and GAME_BETTING
// multiply the market count 3x and push past Betfair's 200-market limit.
const MARKET_TYPES = ['MATCH_ODDS'];

// Reconnect config
const RECONNECT_BASE_MS  = 1_000;
const RECONNECT_MAX_MS   = 5 * 60_000;  // 5 min cap
const RECONNECT_FACTOR   = 2;

// Heartbeat interval (ms) — send a heartbeat if no message received
const HEARTBEAT_INTERVAL_MS = 10_000;

// How often to check for new in-play markets and refresh the subscription if any are found.
const SUBSCRIPTION_REFRESH_MS = 90_000; // 90 seconds

// Betfair REST API — used to fetch market definitions when the stream omits them
const BETFAIR_REST_HOST      = 'api.betfair.com';
const BETFAIR_REST_CATALOGUE = '/exchange/betting/rest/v1.0/listMarketCatalogue/';
const CATALOGUE_BATCH        = 100; // max marketIds per listMarketCatalogue call

// Betfair streaming API hard limit is 200 markets per connection.
// We cap at 195 to leave a small safety margin for markets that start
// between the REST discovery call and the subscription message.
const STREAM_MARKET_LIMIT = 195;

class BetfairStream extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.appKey        — Betfair application key
   * @param {string} [opts.sessionToken] — ignored; token is obtained via certlogin
   */
  constructor({ appKey }) {
    super();
    this._appKey       = appKey;
    this._sessionToken = null;
    this._socket       = null;
    this._msgId        = 1;

    // Delta-update tokens — sent on reconnect to resume from last position
    this._initialClk  = null;
    this._clk         = null;

    // In-memory market catalogue: marketId → { eventId, matchName, marketType }
    this._catalogue   = new Map();

    // Per-market runner state: marketId → Map<selectionId, runnerSnapshot>
    this._runnerState = new Map();

    // Markets excluded after definition inspection (doubles, ITF) — avoids
    // re-evaluating the same definition on every subsequent delta message.
    this._blockedMarkets = new Set();

    // Reconnect state
    this._reconnectDelay  = RECONNECT_BASE_MS;
    this._reconnecting    = false;
    this._reconnectTimer  = null;
    this._stopped         = false;

    // Heartbeat timer
    this._heartbeatTimer  = null;
    this._lastMsgTime     = 0;

    // Subscription refresh timer — periodically check for new markets
    this._subscriptionRefreshTimer = null;

    // Market IDs from the last subscription — used to detect new in-play markets
    this._subscribedMarketIds = new Set();

    // Buffer for incomplete lines from the TCP stream
    this._lineBuffer = '';

    // Count of fully-parsed messages received — used to log the first N for debugging
    this._rawMsgCount = 0;

    // Count of MCM market-change objects processed — used to cap verbose parse logging
    this._mcmMarketCount = 0;

    // Per-market authoritative total matched volume (mc.tv from stream)
    this._marketVolume = new Map();

    // Markets received from the stream without a marketDefinition — resolved via REST
    this._pendingCatalogue  = new Set();
    this._catalogueFetching = false;

    // Load mTLS credentials at construction time
    this._cert = this._loadCertFile(process.env.BETFAIR_CERT_PATH, 'BETFAIR_CERT_PATH');
    this._key  = this._loadCertFile(process.env.BETFAIR_KEY_PATH,  'BETFAIR_KEY_PATH');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Returns the current session token (obtained via certlogin). */
  getSessionToken() {
    return this._sessionToken;
  }

  /** Login via certlogin then open the stream. */
  connect() {
    if (process.env.BETFAIR_STREAM_ENABLED !== 'true') {
      logger.warn('BetfairStream: BETFAIR_STREAM_ENABLED is not set to "true" — skipping connection');
      return;
    }
    this._stopped = false;
    this._loginAndConnect();
  }

  /** Gracefully close the stream and stop reconnecting. */
  disconnect() {
    this._stopped = true;
    this._clearHeartbeat();
    this._clearSubscriptionRefresh();
    // Cancel any pending reconnect timer so the stream cannot re-open after disconnect.
    // Without this, an in-flight setTimeout from _scheduleReconnect would fire and call
    // _loginAndConnect(), opening a new socket even though we are shutting down.
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = false;
    this._pendingCatalogue.clear();
    this._catalogueFetching = false;
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    logger.info('BetfairStream: disconnected by caller');
  }

  // ---------------------------------------------------------------------------
  // Login → connect sequence
  // ---------------------------------------------------------------------------

  async _loginAndConnect() {
    if (this._stopped) return;
    try {
      logger.info('BetfairStream: logging in via certlogin');
      this._sessionToken = await this._certLogin();
      logger.info('BetfairStream: certlogin successful');
      if (!this._stopped) this._openSocket();
    } catch (err) {
      logger.error('BetfairStream: certlogin failed', { message: err.message });
      this.emit('error', err);
      if (!this._stopped) this._scheduleReconnect();
    }
  }

  /**
   * POST to Betfair's certificate login endpoint and return the session token.
   * Uses the client cert + key for mTLS and the account credentials in the body.
   */
  _certLogin() {
    return new Promise((resolve, reject) => {
      const username = process.env.BETFAIR_USERNAME;
      const password = process.env.BETFAIR_PASSWORD;

      if (!username || !password) {
        return reject(new Error('BETFAIR_USERNAME or BETFAIR_PASSWORD not set'));
      }
      if (!this._cert || !this._key) {
        return reject(new Error('Client certificate or key not loaded — check BETFAIR_CERT_PATH / BETFAIR_KEY_PATH'));
      }

      const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

      const req = https.request({
        hostname: CERTLOGIN_HOST,
        path:     CERTLOGIN_PATH,
        method:   'POST',
        cert:     this._cert,
        key:      this._key,
        headers:  {
          'X-Application':  this._appKey,
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Betfair certlogin HTTP ${res.statusCode} — body: ${data.slice(0, 200)}`));
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.loginStatus === 'SUCCESS') {
              resolve(parsed.sessionToken);
            } else {
              reject(new Error(`Betfair certlogin failed: ${parsed.loginStatus}`));
            }
          } catch (e) {
            reject(new Error(`Betfair certlogin response parse error: ${e.message} — body: ${data.slice(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // TLS socket lifecycle
  // ---------------------------------------------------------------------------

  _openSocket() {
    logger.info('BetfairStream: opening TLS socket', { host: STREAM_HOST, port: STREAM_PORT });

    const socket = tls.connect({
      host:               STREAM_HOST,
      port:               STREAM_PORT,
      cert:               this._cert,
      key:                this._key,
      rejectUnauthorized: true,
    });

    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000); // prevent NAT/firewall dropping idle connections

    socket.on('secureConnect', () => this._onOpen());
    socket.on('data',          (data) => this._onMessage(data));
    socket.on('close',         ()     => this._onClose());
    socket.on('error',         (err)  => this._onError(err));

    this._socket = socket;
  }

  _onOpen() {
    logger.info('BetfairStream: TLS socket connected — awaiting connection message');
    this._resetHeartbeat();
  }

  _onClose() {
    logger.warn('BetfairStream: connection closed');
    this._clearHeartbeat();
    this._clearSubscriptionRefresh();
    this.emit('disconnected');
    if (!this._stopped) this._scheduleReconnect();
  }

  _onError(err) {
    logger.error('BetfairStream: socket error', { message: err.message });
    this.emit('error', err);
    // ECONNRESET leaves a ghost connection on Betfair's side for ~15-20 s.
    // Use a 60 s floor (matching the connection-limit penalty) so that even if
    // two rapid disconnects leave two overlapping ghosts, both have time to expire.
    if (err.code === 'ECONNRESET') {
      this._reconnectDelay = Math.max(this._reconnectDelay, 60_000);
    }
    // close event will follow and trigger reconnect
  }

  // ---------------------------------------------------------------------------
  // Reconnect with exponential backoff
  // ---------------------------------------------------------------------------

  _scheduleReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;

    logger.info('BetfairStream: reconnecting in', { ms: this._reconnectDelay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnecting      = false;
      this._reconnectTimer    = null;
      this._lineBuffer        = '';
      this._rawMsgCount       = 0;
      this._mcmMarketCount    = 0;
      this._msgId             = 1; // reset so auth=1 / subscribe=2 IDs stay predictable
      this._pendingCatalogue.clear();
      this._catalogueFetching = false;
      this._loginAndConnect(); // re-login on every reconnect — token may have expired
    }, this._reconnectDelay);

    this._reconnectDelay = Math.min(
      this._reconnectDelay * RECONNECT_FACTOR,
      RECONNECT_MAX_MS
    );
  }

  /**
   * Cancel any pending reconnect timer and reset reconnect state so a fresh
   * call to _scheduleReconnect uses the current _reconnectDelay value.
   * Use this when we need to override an in-flight short reconnect timer with
   * a much longer one (e.g. connection-limit exceeded).
   */
  _cancelPendingReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._reconnecting = false;
  }

  _resetReconnectDelay() {
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._startSubscriptionRefresh();
  }

  // ---------------------------------------------------------------------------
  // Subscription refresh — reconnect periodically to pick up new markets
  // ---------------------------------------------------------------------------

  _startSubscriptionRefresh() {
    this._clearSubscriptionRefresh();
    this._subscriptionRefreshTimer = setTimeout(async () => {
      this._subscriptionRefreshTimer = null;
      if (this._stopped) return;

      // Check whether any new in-play markets have appeared since last subscription.
      // Update in-place by re-sending marketSubscription on the existing socket —
      // no need to destroy/reconnect, which was causing ~90s churn on busy days.
      try {
        const freshIds = await this._discoverInPlayTennisMarketIds();
        const hasNew = freshIds.some(id => !this._subscribedMarketIds.has(id));
        if (!hasNew) {
          logger.debug('BetfairStream: subscription check — no new markets');
          this._startSubscriptionRefresh();
          return;
        }
        logger.info('BetfairStream: new in-play markets detected — updating subscription in place', {
          total: freshIds.length,
          newCount: freshIds.filter(id => !this._subscribedMarketIds.has(id)).length,
        });
        this._subscribedMarketIds = new Set(freshIds);
        if (this._socket && !this._socket.destroyed) {
          this._send({
            op: 'marketSubscription',
            id: this._nextId(),
            marketFilter: { marketIds: freshIds },
            marketDataFilter: { fields: ['EX_BEST_OFFERS', 'EX_TRADED'], ladderLevels: 1 },
          });
        }
      } catch (err) {
        logger.warn('BetfairStream: subscription refresh failed — will retry next cycle', { message: err.message });
      }
      this._startSubscriptionRefresh();
    }, SUBSCRIPTION_REFRESH_MS);
  }

  _clearSubscriptionRefresh() {
    if (this._subscriptionRefreshTimer) {
      clearTimeout(this._subscriptionRefreshTimer);
      this._subscriptionRefreshTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  _resetHeartbeat() {
    this._clearHeartbeat();
    this._lastMsgTime    = Date.now();
    this._heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this._lastMsgTime;
      if (elapsed > HEARTBEAT_INTERVAL_MS && this._socket && !this._socket.destroyed) {
        logger.debug('BetfairStream: sending heartbeat');
        this._send({ op: 'heartbeat', id: this._nextId() });
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  _clearHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message framing — BFLP is newline-delimited JSON over the raw socket
  // ---------------------------------------------------------------------------

  _onMessage(chunk) {
    this._lastMsgTime = Date.now();
    this._lineBuffer += chunk;

    const lines = this._lineBuffer.split('\r\n');
    // Last element may be an incomplete line — keep it in the buffer
    this._lineBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Log the first 10 raw messages verbatim to diagnose stream startup issues.
      // Logged at info so they appear regardless of LOG_LEVEL setting.
      if (this._rawMsgCount < 10) {
        this._rawMsgCount++;
        logger.info(`BetfairStream: raw message #${this._rawMsgCount}`, {
          raw: trimmed.slice(0, 500),
        });
      }

      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (err) {
        logger.warn('BetfairStream: failed to parse message', { line: trimmed.slice(0, 200) });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Protocol message handling
  // ---------------------------------------------------------------------------

  _handleMessage(msg) {
    logger.debug('BetfairStream: received', { op: msg.op, ct: msg.ct });

    switch (msg.op) {
      case 'connection':
        this._onConnection(msg);
        break;

      case 'status':
        this._onStatus(msg);
        break;

      case 'mcm': // MarketChangeMessage
        if (msg.ct !== 'HEARTBEAT') {
          this._onMarketChangeMessage(msg);
        }
        break;

      default:
        logger.debug('BetfairStream: unhandled op', { op: msg.op });
    }
  }

  _onConnection(msg) {
    logger.info('BetfairStream: connection established', { connectionId: msg.connectionId });
    this._authenticate();
  }

  _onStatus(msg) {
    if (msg.statusCode === 'SUCCESS') {
      if (msg.id === 1) {
        logger.info('BetfairStream: authenticated');
        this._subscribe();
      } else if (msg.id === 2) {
        logger.info('BetfairStream: subscribed to tennis markets');
        this._resetReconnectDelay();
        this.emit('connected');
      }
    } else {
      const err = new Error(
        `BetfairStream: status error ${msg.statusCode} ${msg.errorMessage || ''}`
      );
      logger.error(err.message);

      // If Betfair rejected us because we hit the connection limit, cancel any
      // in-flight short reconnect timer and force a 3 min back-off so ghost
      // connections have time to expire on Betfair's side before we try again.
      if ((msg.errorMessage || '').toLowerCase().includes('connection limit') ||
          (msg.errorMessage || '').toLowerCase().includes('active connection')) {
        logger.warn('BetfairStream: connection limit hit — waiting 3 min before retry');
        this._cancelPendingReconnect();
        this._reconnectDelay = 3 * 60_000;
      }

      this.emit('error', err);

      // Destroy the socket so Betfair releases the connection slot immediately.
      // The resulting 'close' event will schedule the reconnect via _onClose.
      if (this._socket && !this._socket.destroyed) {
        this._socket.destroy();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication & subscription messages
  // ---------------------------------------------------------------------------

  _authenticate() {
    this._send({
      op:      'authentication',
      id:      this._nextId(), // will be 1
      appKey:  this._appKey,
      session: this._sessionToken,
    });
  }

  async _subscribe() {
    // Betfair's streaming API rejects subscriptions with > 200 markets.
    // On busy days (e.g. weekends) there can be 200+ in-play tennis markets.
    // To avoid SUBSCRIPTION_LIMIT_EXCEEDED, we first discover the current
    // in-play market IDs via REST and cap at STREAM_MARKET_LIMIT (195).
    // Sort by MAXIMUM_TRADED so the highest-volume (strategy-relevant) markets
    // always fill the 195 slots — ITF/challenger markets with low volume fall off.
    let specificMarketIds = null;
    try {
      specificMarketIds = await this._discoverInPlayTennisMarketIds();
      if (specificMarketIds.length > 0) {
        this._subscribedMarketIds = new Set(specificMarketIds);
        logger.info('BetfairStream: subscribing to specific market IDs', {
          count: specificMarketIds.length,
          capped: specificMarketIds.length >= STREAM_MARKET_LIMIT,
        });
      }
    } catch (err) {
      logger.warn('BetfairStream: market discovery failed — falling back to broad filter', {
        message: err.message,
      });
    }

    const sub = {
      op: 'marketSubscription',
      id: this._nextId(), // will be 2
      marketDataFilter: {
        fields:       ['EX_BEST_OFFERS', 'EX_TRADED'],
        ladderLevels: 1,
      },
    };

    if (specificMarketIds && specificMarketIds.length > 0) {
      sub.marketFilter = { marketIds: specificMarketIds };
    } else {
      // Fallback: broad filter (works fine when < 200 markets are in-play)
      sub.marketFilter = {
        eventTypeIds: ['2'],
        marketTypes:  MARKET_TYPES,
        inPlayOnly:   true,
      };
    }

    // On reconnect: send clk tokens to resume from last position (delta updates)
    if (this._initialClk) sub.initialClk = this._initialClk;
    if (this._clk)        sub.clk        = this._clk;

    this._send(sub);
  }

  /**
   * Fetch the IDs of all currently in-play tennis MATCH_ODDS markets via REST,
   * sorted most-recently-started first, capped at STREAM_MARKET_LIMIT.
   * @returns {Promise<string[]>}
   */
  _discoverInPlayTennisMarketIds() {
    return new Promise((resolve, reject) => {
      if (!this._sessionToken) {
        return reject(new Error('No session token — certlogin must complete first'));
      }

      const body = JSON.stringify({
        filter: {
          eventTypeIds: ['2'],
          marketTypes:  MARKET_TYPES,
          inPlayOnly:   true,
        },
        sort:             'MAXIMUM_TRADED',
        maxResults:       STREAM_MARKET_LIMIT,
        marketProjection: [],
      });

      const req = https.request({
        hostname: BETFAIR_REST_HOST,
        path:     BETFAIR_REST_CATALOGUE,
        method:   'POST',
        headers: {
          'X-Application':    this._appKey,
          'X-Authentication': this._sessionToken,
          'Content-Type':     'application/json',
          'Accept':           'application/json',
          'Content-Length':   Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(
              `_discoverInPlayTennisMarketIds HTTP ${res.statusCode}: ${data.slice(0, 300)}`
            ));
          }
          try {
            const parsed = JSON.parse(data);
            const ids = Array.isArray(parsed) ? parsed.map(m => m.marketId) : [];
            resolve(ids);
          } catch (e) {
            reject(new Error(
              `_discoverInPlayTennisMarketIds parse error: ${e.message} — body: ${data.slice(0, 300)}`
            ));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Market Change Message parsing
  // ---------------------------------------------------------------------------

  _onMarketChangeMessage(msg) {
    if (msg.initialClk) this._initialClk = msg.initialClk;
    if (msg.clk)        this._clk        = msg.clk;

    if (!Array.isArray(msg.mc)) {
      logger.warn('BetfairStream: MCM has no mc array', {
        ct: msg.ct, keys: Object.keys(msg).join(','),
      });
      return;
    }

    // Counters reset per MCM batch — logged as a single summary line at the end.
    const tally = { total: msg.mc.length, hasDef: 0, excluded: 0, emitted: 0, nullUpdate: 0 };

    for (const mc of msg.mc) {
      this._processMarketChange(mc, msg.pt || Date.now(), tally);
    }

    // If any markets arrived without definitions, resolve them via the REST catalogue API.
    if (this._pendingCatalogue.size > 0 && !this._catalogueFetching) {
      this._fetchMissingCatalogues().catch(err =>
        logger.error('BetfairStream: catalogue fetch error', { message: err.message })
      );
    }

    logger.info('BetfairStream: MCM batch', {
      ct:          msg.ct || '(delta)',
      total:       tally.total,
      hasDef:      tally.hasDef,      // markets that carried a marketDefinition
      excluded:    tally.excluded,    // filtered out (ITF / doubles)
      emitted:     tally.emitted,     // marketUpdate fired → stateStore.upsert called
      nullUpdate:  tally.nullUpdate,  // _buildUpdate returned null — no catalogue entry yet
    });
  }

  _processMarketChange(mc, timestamp, tally) {
    const marketId = mc.id;
    if (!marketId) {
      logger.warn('BetfairStream: mc item has no id', { keys: Object.keys(mc).join(',') });
      return;
    }

    // Fast-path: skip markets we have already decided to exclude.
    if (this._blockedMarkets.has(marketId)) return;

    if (mc.marketDefinition) {
      tally.hasDef++;
      const def = mc.marketDefinition;

      // Log every definition: these are the key filter values the user asked for.
      logger.info('BetfairStream: definition', {
        marketId,
        inPlay:     def.inPlay,           // must be true for live match processing
        marketType: def.marketType,       // must be MATCH_ODDS
        status:     def.status,
        runnerNames: (def.runners || []).slice(0, 2).map(r => r.name || r.runnerName || '?').join(' v '),
        eventName:  def.eventName || '(none)',
        defKeys:    Object.keys(def).join(','),
      });

      if (this._isExcludedMarket(def)) {
        tally.excluded++;
        this._blockedMarkets.add(marketId);
        logger.info('BetfairStream: EXCLUDED market', {
          marketId,
          reason: (def.marketType && def.marketType !== 'MATCH_ODDS') ? `marketType:${def.marketType}` : def.runners?.some(r => (r.name || '').includes('/')) ? 'doubles' : 'ITF',
          name:   def.name,
          runners: (def.runners || []).map(r => r.name).join(' / '),
        });
        return;
      }
      this._updateCatalogue(marketId, def);
    } else if (!this._catalogue.has(marketId)) {
      // No definition in this message and market not yet catalogued — queue for REST fetch.
      this._pendingCatalogue.add(marketId);
    }

    // Track authoritative market total volume when Betfair provides it
    if (typeof mc.tv === 'number') {
      this._marketVolume.set(marketId, mc.tv);
      logger.debug('BetfairStream: mc.tv received', { marketId, tv: mc.tv });
    }

    if (Array.isArray(mc.rc) && mc.rc.length > 0) {
      this._applyRunnerChanges(marketId, mc.rc);
    }

    this._mcmMarketCount++;

    const update = this._buildUpdate(marketId, mc, timestamp);
    if (!update) {
      tally.nullUpdate++;
      // This fires when there is no catalogue entry yet (definition not received yet)
      // and no runners in state — market will be populated once a definition arrives.
      logger.debug('BetfairStream: no update for market (no definition in catalogue)', { marketId });
      return;
    }

    tally.emitted++;
    logger.info('BetfairStream: → stateStore.upsert', {
      marketId,
      matchName: update.matchName,
      inPlay:    update.inPlay,
      status:    update.status,
      runners:   update.runners.map(r => `${r.name}@${r.backPrice ?? '?'}`).join(' v '),
    });
    this.emit('marketUpdate', update);
  }

  /**
   * Returns true if the market should be excluded from tracking.
   *   - Non-MATCH_ODDS: marketType is not MATCH_ODDS (SET_BETTING, GAME_BY_GAME, etc.)
   *   - Doubles:        any runner name contains "/" (Betfair's doubles pair separator)
   *   - ITF:            eventName contains "ITF" (case-insensitive)
   *   - Non-player:     runner named "Under"/"Over"/"Yes"/"No" or set-score pattern "X-Y"
   */
  _isExcludedMarket(def) {
    if (def.marketType && def.marketType !== 'MATCH_ODDS') return true;

    const eventName = (def.eventName || def.name || '').toUpperCase();
    if (eventName.includes('ITF')) return true;

    if (Array.isArray(def.runners)) {
      // Skip doubles (runner name contains "/")
      if (def.runners.some(r => r.name?.includes('/'))) return true;

      // Skip non-player markets: "Under v Over", "Yes v No", "Two Sets v Three Sets",
      // score markets ("Svitolina 2-0 v Svitolina 2-1"). Detect by checking if any
      // runner name is a known non-player token or contains a set-score pattern (digit-digit).
      const NON_PLAYER = new Set(['under', 'over', 'yes', 'no']);
      const SET_SCORE_RE = /\d-\d/;
      if (def.runners.slice(0, 2).some(r => {
        const n = (r.name || '').trim().toLowerCase();
        if (!n) return false;
        if (NON_PLAYER.has(n)) return true;
        if (SET_SCORE_RE.test(n)) return true;  // "Svitolina 2-0" style
        return false;
      })) return true;
    }

    return false;
  }

  _updateCatalogue(marketId, def) {
    const existing = this._catalogue.get(marketId) || {};

    // Build matchName: prefer runner names ("Tsitsipas S v Fery A"), fall back to
    // eventName from the definition, then the existing value, then the raw marketId.
    let matchName = existing.matchName || null;

    if (Array.isArray(def.runners) && def.runners.length >= 2) {
      // Try `name` (standard) then `runnerName` (older Betfair streaming versions)
      const names = def.runners.slice(0, 2)
        .map(r => r.name || r.runnerName)
        .filter(Boolean);
      if (names.length === 2) matchName = names.join(' v ');
    }

    // Fall back to eventName in the definition if runners had no names
    if (!matchName && def.eventName) matchName = def.eventName;
    if (!matchName) matchName = marketId;

    // Map in-play markets to 'LIVE' so the main loop filter picks them up.
    // Always derive from inPlay first — Betfair sometimes resumes a market
    // (inPlay: true) without re-sending status: 'OPEN', which would leave the
    // market stuck as 'SUSPENDED' if we only checked rawStatus.
    const rawStatus = def.status || existing.status || 'OPEN';
    const inPlay    = def.inPlay ?? existing.inPlay ?? false;
    const status    = inPlay ? 'LIVE' : rawStatus;

    logger.info('BetfairStream: catalogue updated', {
      marketId, matchName, status, inPlay, marketType: def.marketType,
    });

    // Only accept def.eventName as a tournament/competition name if it doesn't look
    // like a player matchup (streaming sends match names as eventName). Keep any
    // previously stored tournament name from the REST catalogue in preference.
    const isTournamentName = def.eventName && !def.eventName.includes(' v ');
    const eventName = existing.eventName || (isTournamentName ? def.eventName : null);

    this._catalogue.set(marketId, {
      ...existing,
      eventId:    def.eventId    || existing.eventId    || null,
      eventName,
      matchName,
      marketType: def.marketType || existing.marketType || null,
      inPlay,
      status,
      runners:    def.runners    || existing.runners     || [],
    });
  }

  _applyRunnerChanges(marketId, changes) {
    if (!this._runnerState.has(marketId)) {
      this._runnerState.set(marketId, new Map());
    }
    const state = this._runnerState.get(marketId);

    for (const rc of changes) {
      const selectionId = rc.id;
      const existing    = state.get(selectionId) || {};

      const backPrice = rc.batb?.[0]?.[1] ?? existing.backPrice ?? null;
      const layPrice  = rc.batl?.[0]?.[1] ?? existing.layPrice  ?? null;

      // Merge trd (traded volume ladder) into the stored ladder.
      // Betfair sends delta updates — only changed price levels are included,
      // each with its cumulative total at that price. We must merge into the
      // existing ladder (not replace it) to avoid losing unchanged price levels.
      const trdLadder = existing.trdLadder ? { ...existing.trdLadder } : {};
      if (Array.isArray(rc.trd) && rc.trd.length > 0) {
        for (const [price, size] of rc.trd) {
          trdLadder[price] = size;  // size is cumulative at this price
        }
      }
      const matchedVolume = Object.values(trdLadder).reduce((sum, v) => sum + v, 0);

      const lastTradedPrice = rc.ltp ?? existing.lastTradedPrice ?? null;

      state.set(selectionId, {
        ...existing,
        selectionId,
        backPrice,
        layPrice,
        lastTradedPrice,
        matchedVolume,
        trdLadder,
      });
    }
  }

  _buildUpdate(marketId, mc, timestamp) {
    const cat     = this._catalogue.get(marketId) || {};
    const runners = this._runnerState.get(marketId);

    const runnerDefs = cat.runners || [];
    const runnerList = runnerDefs.map(def => {
      const state = runners?.get(def.id) || {};
      return {
        selectionId:     def.id,
        name:            def.name || String(def.id),
        backPrice:       state.backPrice        ?? null,
        layPrice:        state.layPrice         ?? null,
        lastTradedPrice: state.lastTradedPrice  ?? null,
        matchedVolume:   state.matchedVolume    ?? 0,
      };
    });

    if (!runnerList.length && !mc.marketDefinition) {
      logger.debug('BetfairStream: _buildUpdate returning null — no runners and no definition', { marketId });
      return null;
    }

    // Prefer mc.tv (Betfair's authoritative market total) if we have it stored.
    // Fallback: sum all runners' trd volumes. In a 2-runner market each trade
    // appears on exactly ONE runner's trd ladder (the one being backed/laid), so
    // summing both runners gives the correct total — there is no double-counting.
    // Using only runner[0] would give roughly half the actual market volume.
    const storedVolume = this._marketVolume.get(marketId);
    const totalVolume  = storedVolume != null
      ? storedVolume
      : runnerList.reduce((sum, r) => sum + (r.matchedVolume ?? 0), 0);

    return {
      marketId,
      eventId:       cat.eventId    || null,
      eventName:     cat.eventName  || null,
      matchName:     cat.matchName  || marketId,
      marketType:    cat.marketType || null,
      runners:       runnerList,
      inPlay:        cat.inPlay     ?? false,
      status:        cat.status     || 'OPEN',
      matchedVolume: totalVolume,
      timestamp,
    };
  }

  // ---------------------------------------------------------------------------
  // REST catalogue fetch — resolves markets that arrived without streaming definitions
  // ---------------------------------------------------------------------------

  /**
   * Fetch market definitions for all queued marketIds via listMarketCatalogue,
   * populate the in-memory catalogue, then emit 'marketUpdate' for each so
   * stateStore.upsert is called and the markets become visible to the main loop.
   */
  async _fetchMissingCatalogues() {
    if (this._pendingCatalogue.size === 0 || this._catalogueFetching) return;
    this._catalogueFetching = true;

    // Snapshot and clear so markets arriving during the async fetch accumulate separately.
    const marketIds = [...this._pendingCatalogue];
    this._pendingCatalogue.clear();

    logger.info('BetfairStream: fetching catalogue via REST', { count: marketIds.length });

    try {
      let resolved = 0;
      for (let i = 0; i < marketIds.length; i += CATALOGUE_BATCH) {
        const batch = marketIds.slice(i, i + CATALOGUE_BATCH);
        let catalogues;
        try {
          catalogues = await this._listMarketCatalogue(batch);
        } catch (err) {
          // Session expired — re-login once and retry this batch.
          if (this._isSessionError(err)) {
            logger.warn('BetfairStream: session token expired — refreshing and retrying');
            await this._refreshSession();
            catalogues = await this._listMarketCatalogue(batch);
          } else {
            throw err;
          }
        }
        resolved += this._applyCatalogues(catalogues);
      }
      logger.info('BetfairStream: REST catalogue complete', {
        requested: marketIds.length, resolved,
      });
    } catch (err) {
      logger.error('BetfairStream: REST catalogue fetch failed', { message: err.message });
      // Re-queue for retry — only markets we don't already know about
      for (const id of marketIds) {
        if (!this._catalogue.has(id)) this._pendingCatalogue.add(id);
      }
    } finally {
      this._catalogueFetching = false;
      // Markets that arrived while we were fetching — schedule a follow-up pass
      if (this._pendingCatalogue.size > 0) {
        setTimeout(() => {
          this._fetchMissingCatalogues().catch(err =>
            logger.error('BetfairStream: follow-up catalogue fetch error', { message: err.message })
          );
        }, 2_000);
      }
    }
  }

  /**
   * Map a listMarketCatalogue response array into the internal catalogue and emit
   * a 'marketUpdate' for each valid market so stateStore picks it up.
   * Returns the count of markets successfully emitted.
   */
  _applyCatalogues(catalogues) {
    let resolved = 0;
    for (const cat of catalogues) {
      const marketId = cat.marketId;
      if (!marketId) continue;

      // Build a synthetic definition in the same shape _updateCatalogue expects
      const def = {
        eventId:    cat.event?.id            || null,
        // competition.name = "ATP Rome 2026"; event.name = match name (players) — we want the former
        eventName:  cat.competition?.name    || null,
        name:       cat.marketName           || 'Match Odds',
        marketType: cat.description?.marketType || null,
        inPlay:     cat.description?.inPlay  ?? true,
        status:     'OPEN',
        runners: (cat.runners || []).map(r => ({
          id:     r.selectionId,
          name:   r.runnerName,
          status: r.status || 'ACTIVE',
        })),
      };

      if (this._isExcludedMarket(def)) {
        this._blockedMarkets.add(marketId);
        logger.debug('BetfairStream: REST catalogue — excluding market', {
          marketId, eventName: def.eventName,
        });
        continue;
      }

      this._updateCatalogue(marketId, def);

      // _buildUpdate will succeed now that catalogue has runner names.
      // Pass an empty mc object — the null guard only fires when both
      // runnerList AND mc.marketDefinition are absent, which won't be
      // the case after _updateCatalogue has populated cat.runners.
      const update = this._buildUpdate(marketId, {}, Date.now());
      if (update) {
        logger.info('BetfairStream: → stateStore.upsert (REST catalogue)', {
          marketId,
          matchName: update.matchName,
          inPlay:    update.inPlay,
          status:    update.status,
        });
        this.emit('marketUpdate', update);
        resolved++;
      }
    }
    return resolved;
  }

  /**
   * Call Betfair REST listMarketCatalogue for the given marketIds.
   * Uses the session token already obtained from certlogin.
   * @param {string[]} marketIds
   * @returns {Promise<object[]>}
   */
  _listMarketCatalogue(marketIds) {
    return new Promise((resolve, reject) => {
      if (!this._sessionToken) {
        return reject(new Error('No session token — certlogin must complete first'));
      }

      const body = JSON.stringify({
        filter:           { marketIds },
        marketProjection: ['COMPETITION', 'EVENT', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION'],
        maxResults:       marketIds.length,
      });

      const req = https.request({
        hostname: BETFAIR_REST_HOST,
        path:     BETFAIR_REST_CATALOGUE,
        method:   'POST',
        headers: {
          'X-Application':   this._appKey,
          'X-Authentication': this._sessionToken,
          'Content-Type':    'application/json',
          'Accept':          'application/json',
          'Content-Length':  Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(
              `listMarketCatalogue HTTP ${res.statusCode}: ${data.slice(0, 300)}`
            ));
          }
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (e) {
            reject(new Error(
              `listMarketCatalogue parse error: ${e.message} — body: ${data.slice(0, 300)}`
            ));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ---------------------------------------------------------------------------
  // Session refresh — Betfair sessions expire after ~20 min idle. The streaming
  // socket does its own re-auth on reconnect, but REST callers (catalogue
  // fetcher, Betfair Scores poller) need a way to refresh the token in place
  // without bouncing the socket.
  // ---------------------------------------------------------------------------

  _isSessionError(err) {
    const msg = String(err?.message || '');
    return msg.includes('INVALID_SESSION_INFORMATION')
        || msg.includes('NO_SESSION')
        || msg.includes('SESSION_EXPIRED');
  }

  async _refreshSession() {
    // De-dupe concurrent refreshes so a burst of 400s doesn't trigger N logins.
    if (this._sessionRefreshing) return this._sessionRefreshing;
    this._sessionRefreshing = (async () => {
      try {
        const fresh = await this._certLogin();
        this._sessionToken = fresh;
        logger.info('BetfairStream: session token refreshed');
      } finally {
        this._sessionRefreshing = null;
      }
    })();
    return this._sessionRefreshing;
  }

  // ---------------------------------------------------------------------------
  // Send helper
  // ---------------------------------------------------------------------------

  _send(obj) {
    if (!this._socket || this._socket.destroyed) {
      logger.warn('BetfairStream: attempted send on closed socket');
      return;
    }
    this._socket.write(JSON.stringify(obj) + '\r\n');
  }

  _nextId() {
    return this._msgId++;
  }

  // ---------------------------------------------------------------------------
  // Certificate loader
  // ---------------------------------------------------------------------------

  _loadCertFile(filePath, envVar) {
    if (!filePath) {
      logger.warn(`BetfairStream: ${envVar} not set — mTLS will fail`);
      return undefined;
    }
    try {
      const buf = fs.readFileSync(filePath);
      logger.info('BetfairStream: loaded cert file', { envVar, path: filePath });
      return buf;
    } catch (err) {
      logger.error(`BetfairStream: failed to read ${envVar}`, { path: filePath, message: err.message });
      return undefined;
    }
  }
}

module.exports = BetfairStream;
