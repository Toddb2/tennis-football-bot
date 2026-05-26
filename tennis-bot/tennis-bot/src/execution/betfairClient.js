'use strict';

/**
 * betfairClient.js
 *
 * Wrapper around the Betfair REST API (betting exchange).
 *
 * Authentication: certificate-based login (required for in-play betting via API).
 * Cert files are read from BETFAIR_CERT_PATH / BETFAIR_KEY_PATH env vars.
 * Session token is auto-refreshed after SESSION_TTL_MS (7.5 hours).
 *
 * DRY_RUN mode (DRY_RUN=true):
 *   - login() completes normally (needed to prove certs work).
 *   - All mutating operations (placeOrders, updateOrders, cancelOrders)
 *     return a simulated success response without contacting Betfair.
 *   - Read-only operations (listMarketCatalogue, listMarketBook,
 *     listCurrentOrders) still hit the API so market data stays accurate.
 *
 * Betfair API notes:
 *   - Minimum bet: £1.00
 *   - Do not place orders when market status is SUSPENDED
 *   - Rate limit: ≤ 20 REST requests/min (streaming handles price data)
 *   - In-play orders require a "live" (non-delayed) application key
 */

const https  = require('https');
const fs     = require('fs');
const axios  = require('axios');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LOGIN_URL      = 'https://identitysso-cert.betfair.com/api/certlogin';
const API_BASE       = 'https://api.betfair.com/exchange/betting/rest/v1.0';
const SESSION_TTL_MS = 7.5 * 60 * 60 * 1000; // 7.5 hours (token lives ~8 h)

class BetfairClient {
  constructor() {
    this._appKey        = process.env.BETFAIR_APP_KEY      || '';
    this._username      = process.env.BETFAIR_USERNAME     || '';
    this._password      = process.env.BETFAIR_PASSWORD     || '';
    this._certPath      = process.env.BETFAIR_CERT_PATH    || './certs/client-2048.crt';
    this._keyPath       = process.env.BETFAIR_KEY_PATH     || './certs/client-2048.key';

    this._sessionToken      = null;
    this._sessionCreatedAt  = null;
    this._refreshTimer      = null;

    this._isDryRun = process.env.DRY_RUN === 'true';

    // Axios instance for the Betfair REST API (no cert needed here)
    this._api = axios.create({
      baseURL: API_BASE,
      timeout: 15_000,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    });
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /**
   * Certificate-based login.
   * Must be called once at startup; throws on failure so the bot can exit cleanly.
   */
  async login() {
    logger.info('BetfairClient: logging in', { username: this._username });

    // Load cert files — fail early if missing
    let cert, key;
    try {
      cert = fs.readFileSync(this._certPath);
      key  = fs.readFileSync(this._keyPath);
    } catch (err) {
      throw new Error(
        `BetfairClient: cannot read cert/key files — ${err.message}\n` +
        `  BETFAIR_CERT_PATH=${this._certPath}\n` +
        `  BETFAIR_KEY_PATH=${this._keyPath}`
      );
    }

    // Build an HTTPS agent that presents the client certificate
    const agent = new https.Agent({ cert, key, rejectUnauthorized: true });

    const params = new URLSearchParams();
    params.append('username', this._username);
    params.append('password', this._password);

    const resp = await axios.post(LOGIN_URL, params.toString(), {
      httpsAgent: agent,
      headers: {
        'X-Application':  this._appKey,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
      },
      timeout: 15_000,
    });

    if (resp.data?.loginStatus !== 'SUCCESS') {
      throw new Error(`BetfairClient: login failed — status: ${resp.data?.loginStatus}`);
    }

    this._sessionToken     = resp.data.sessionToken;
    this._sessionCreatedAt = Date.now();

    logger.info('BetfairClient: login successful');
    this._scheduleRefresh();
  }

  /**
   * Returns the current session token.
   * Used by BetfairStream which needs it for its own authentication.
   */
  getSessionToken() {
    return this._sessionToken;
  }

  /** Schedule an automatic session refresh before the token expires. */
  _scheduleRefresh() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    // Refresh 5 minutes before expiry
    const delay = SESSION_TTL_MS - 5 * 60 * 1000;
    this._refreshTimer = setTimeout(async () => {
      logger.info('BetfairClient: refreshing session token');
      try {
        await this.login();
      } catch (err) {
        logger.error('BetfairClient: session refresh failed', { message: err.message });
      }
    }, delay);
    if (this._refreshTimer.unref) this._refreshTimer.unref();
  }

  /** Check whether the session is still valid; re-login if stale. */
  async _ensureSession() {
    if (!this._sessionToken) {
      throw new Error('BetfairClient: not logged in — call login() first');
    }
    if (Date.now() - this._sessionCreatedAt > SESSION_TTL_MS) {
      logger.warn('BetfairClient: session expired, re-logging in');
      await this.login();
    }
  }

  // ---------------------------------------------------------------------------
  // Shared request helper
  // ---------------------------------------------------------------------------

  async _post(endpoint, body) {
    await this._ensureSession();
    try {
      const resp = await this._api.post(`/${endpoint}/`, body, {
        headers: {
          'X-Application':  this._appKey,
          'X-Authentication': this._sessionToken,
        },
      });
      return resp.data;
    } catch (err) {
      // Log the full Betfair error body so we can diagnose rejections
      if (err.response) {
        logger.error('BetfairClient: API error response', {
          status:   err.response.status,
          endpoint,
          body:     JSON.stringify(err.response.data).slice(0, 500),
        });
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Read-only operations
  // ---------------------------------------------------------------------------

  /**
   * List market catalogue for in-play tennis markets.
   * @param {object} [filter]
   */
  async listMarketCatalogue(filter = {}) {
    // Extract friendly aliases; Betfair REST API uses 'marketTypeCodes' not 'marketTypes'
    const { marketTypes, eventTypeIds, inPlayOnly, ...rest } = filter;
    const payload = {
      filter: {
        eventTypeIds:   eventTypeIds   || ['2'],
        inPlayOnly:     inPlayOnly     ?? true,
        marketTypeCodes: marketTypes   || ['MATCH_ODDS'],
        ...rest,
      },
      marketProjection: ['RUNNER_DESCRIPTION', 'EVENT', 'MARKET_START_TIME'],
      maxResults: '1000',
    };
    logger.debug('BetfairClient: listMarketCatalogue', { marketTypeCodes: payload.filter.marketTypeCodes });
    return this._post('listMarketCatalogue', payload);
  }

  /**
   * Get the current book (best prices + volume) for a list of markets.
   * @param {string[]} marketIds
   */
  async listMarketBook(marketIds) {
    const payload = {
      marketIds,
      priceProjection: {
        priceData:      ['EX_BEST_OFFERS'],
        exBestOffersOverrides: { bestPricesDepth: 1 },
        rolloverStakes: false,
      },
      orderProjection: 'EXECUTABLE',
      matchProjection: 'NO_ROLLUP',
    };
    logger.debug('BetfairClient: listMarketBook', { count: marketIds.length });
    return this._post('listMarketBook', payload);
  }

  /**
   * List all currently open (unmatched + partially matched) orders.
   */
  async listCurrentOrders() {
    logger.debug('BetfairClient: listCurrentOrders');
    return this._post('listCurrentOrders', {});
  }

  // ---------------------------------------------------------------------------
  // Mutating operations  (suppressed in DRY_RUN mode)
  // ---------------------------------------------------------------------------

  /**
   * Place a single back or lay bet.
   * @param {object} p
   * @param {string}  p.marketId
   * @param {number}  p.selectionId
   * @param {'BACK'|'LAY'} p.side
   * @param {number}  p.price   — decimal odds
   * @param {number}  p.size    — stake in GBP
   * @returns {object}  placeExecutionReport
   */
  async placeOrder({ marketId, selectionId, side, price, size }) {
    // Exchange bets — no £2 minimum applies. Allow £1 stakes through.

    if (this._isDryRun) {
      const fakeBetId = `DRY-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      logger.info('BetfairClient: DRY_RUN placeOrder (suppressed)', {
        marketId, selectionId, side, price, size, fakeBetId,
      });
      return {
        status:           'SUCCESS',
        instructionReports: [{
          status:      'SUCCESS',
          instruction: { selectionId, side, limitOrder: { price, size } },
          betId:       fakeBetId,
          placedDate:  new Date().toISOString(),
          averagePriceMatched: price,
          sizeMatched: size,
        }],
      };
    }

    await this._ensureSession();
    logger.info('BetfairClient: placeOrder', { marketId, selectionId, side, price, size });

    const payload = {
      marketId,
      instructions: [{
        selectionId,
        handicap:  0,
        side,
        orderType: 'LIMIT',
        limitOrder: {
          size:            parseFloat(size.toFixed(2)),
          price,
          persistenceType: 'LAPSE',
        },
      }],
    };

    return this._post('placeOrders', payload);
  }

  /**
   * Update the price of an existing unmatched order.
   * @param {object} p
   * @param {string} p.marketId
   * @param {string} p.betId
   * @param {number} p.newPrice
   */
  async updateOrder({ marketId, betId, newPrice }) {
    if (this._isDryRun) {
      logger.info('BetfairClient: DRY_RUN updateOrder (suppressed)', { marketId, betId, newPrice });
      return { status: 'SUCCESS', instructionReports: [{ status: 'SUCCESS', betId }] };
    }

    await this._ensureSession();
    logger.info('BetfairClient: updateOrder', { marketId, betId, newPrice });

    return this._post('updateOrders', {
      marketId,
      instructions: [{ betId, newPrice }],
    });
  }

  /**
   * Cancel a single order or all orders on a market.
   * @param {object} p
   * @param {string}  p.marketId
   * @param {string}  [p.betId]   — omit to cancel all orders on the market
   */
  async cancelOrder({ marketId, betId }) {
    if (this._isDryRun) {
      logger.info('BetfairClient: DRY_RUN cancelOrder (suppressed)', { marketId, betId });
      return { status: 'SUCCESS', instructionReports: [{ status: 'SUCCESS', betId }] };
    }

    await this._ensureSession();
    logger.info('BetfairClient: cancelOrder', { marketId, betId });

    const instructions = betId ? [{ betId }] : [];
    return this._post('cancelOrders', { marketId, instructions });
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  /**
   * Fetch account funds — returns available balance, exposure, etc.
   * Uses the Account API (different base URL from betting API).
   */
  async getAccountFunds() {
    await this._ensureSession();
    const resp = await axios.post(
      'https://api.betfair.com/exchange/account/rest/v1.0/getAccountFunds/',
      {},
      {
        headers: {
          'X-Application':    this._appKey,
          'X-Authentication': this._sessionToken,
          'Accept':           'application/json',
          'Content-Type':     'application/json',
        },
        timeout: 10_000,
      }
    );
    return resp.data; // { availableToBetBalance, exposure, retainedCommission, ... }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  destroy() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  }
}

module.exports = BetfairClient;
