'use strict';

/**
 * bfbmClient.js
 *
 * BF Bot Manager (BFBM) External Bot API client.
 *
 * BFBM is a desktop betting automation app that exposes a local HTTP API
 * allowing external programs to place/cancel bets. This replaces the CBB
 * integration for bet execution and hedging.
 *
 * Setup in BFBM:
 *   1. Open BF Bot Manager → Settings → External Bot API
 *   2. Enable the API and set a port (default 9119)
 *   3. Note the API key if authentication is required
 *   4. Set BFBM_ENABLED=true in .env
 *
 * Env vars:
 *   BFBM_ENABLED    — "true" to route bets through BFBM (default: false)
 *   BFBM_PORT       — port BFBM listens on (default: 9119)
 *   BFBM_HOST       — host (default: 127.0.0.1)
 *   BFBM_API_KEY    — API key if BFBM requires auth (optional)
 *
 * NOTE: Verify the exact endpoint paths and request/response format match
 * your version of BF Bot Manager. These are based on BFBM v3.x External Bot API.
 * Check BF Bot Manager → Help → External Bot API for the exact spec.
 */

const axios  = require('axios');
const logger = require('../utils/logger');

class BfbmClient {
  constructor() {
    const host = process.env.BFBM_HOST || '127.0.0.1';
    const port = process.env.BFBM_PORT || '9119';
    this._baseUrl  = `http://${host}:${port}`;
    this._apiKey   = process.env.BFBM_API_KEY || null;
    this._isDryRun = process.env.DRY_RUN === 'true';
    this._enabled  = process.env.BFBM_ENABLED === 'true';

    this._http = axios.create({
      baseURL: this._baseUrl,
      timeout: 10_000,
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        ...(this._apiKey ? { 'X-API-Key': this._apiKey } : {}),
      },
    });
  }

  get enabled() { return this._enabled; }

  /**
   * Place a bet via BFBM.
   * Returns a result in the same shape as betfairClient.placeOrder() so
   * orderManager.js can use either client transparently.
   *
   * @param {object} opts
   * @param {string}  opts.marketId
   * @param {number}  opts.selectionId
   * @param {string}  opts.side       — 'BACK' or 'LAY'
   * @param {number}  opts.price      — requested odds
   * @param {number}  opts.size       — stake in GBP
   * @returns {object|null}  instructionReports-compatible response
   */
  async placeOrder({ marketId, selectionId, side, price, size }) {
    if (this._isDryRun) {
      const fakeBetId = `BFBM-DRY-${Date.now()}`;
      logger.info(`[DRY RUN] BFBM would place: ${side} ${marketId}/${selectionId} @ ${price} £${size}`);
      return this._wrapSuccess(fakeBetId, price, size);
    }

    if (!this._enabled) {
      logger.warn('BfbmClient: placeOrder called but BFBM_ENABLED is not true');
      return null;
    }

    try {
      // NOTE: verify this endpoint path against your BFBM version docs
      const resp = await this._http.post('/api/PlaceBets', {
        Bets: [{
          MarketId:    marketId,
          SelectionId: selectionId,
          Side:        side,       // "BACK" or "LAY"
          Price:       price,
          Size:        size,
        }],
      });

      const result = resp.data;
      logger.info('BfbmClient: place response', { result: JSON.stringify(result).slice(0, 300) });

      // Parse BFBM response into the same shape orderManager expects
      // NOTE: adjust these field names to match your BFBM version
      const bet = result?.Bets?.[0] || result?.bets?.[0];
      const betId = bet?.BetId || bet?.betId || bet?.BetID;
      const status = (bet?.Status || bet?.status || '').toUpperCase();

      if (!betId || status === 'FAILED' || status === 'ERROR') {
        logger.error('BfbmClient: bet rejected', { result: JSON.stringify(result).slice(0, 300) });
        return null;
      }

      return this._wrapSuccess(betId, price, size);
    } catch (err) {
      logger.error('BfbmClient: placeOrder failed', {
        message: err.message,
        status:  err.response?.status,
        data:    JSON.stringify(err.response?.data || '').slice(0, 200),
      });
      return null;
    }
  }

  /**
   * Cancel a bet via BFBM.
   * @param {object} opts
   * @param {string} opts.marketId
   * @param {string} opts.betId
   */
  async cancelOrder({ marketId, betId }) {
    if (this._isDryRun) {
      logger.info(`[DRY RUN] BFBM would cancel: betId=${betId} marketId=${marketId}`);
      return { success: true, dryRun: true };
    }

    if (!this._enabled) return null;

    try {
      // NOTE: verify this endpoint path against your BFBM version docs
      const resp = await this._http.post('/api/CancelBets', {
        BetIds:   betId ? [betId]    : [],
        MarketIds: marketId ? [marketId] : [],
      });

      logger.info('BfbmClient: cancel response', { data: JSON.stringify(resp.data).slice(0, 200) });
      return { success: true, data: resp.data };
    } catch (err) {
      logger.error('BfbmClient: cancelOrder failed', { message: err.message });
      return null;
    }
  }

  /**
   * Wrap a successful bet response in the same shape betfairClient uses,
   * so orderManager.js can handle either client without changes.
   */
  _wrapSuccess(betId, price, size) {
    return {
      status: 'SUCCESS',
      instructionReports: [{
        status:              'SUCCESS',
        betId,
        sizeMatched:         size,
        averagePriceMatched: price,
      }],
    };
  }

  /**
   * Health check — ping BFBM to verify it's reachable.
   * Returns true if BFBM responds.
   */
  async ping() {
    if (!this._enabled) return false;
    try {
      // NOTE: adjust endpoint to match BFBM's status/ping route
      await this._http.get('/api/Status', { timeout: 3000 });
      return true;
    } catch (_) {
      return false;
    }
  }
}

module.exports = BfbmClient;
