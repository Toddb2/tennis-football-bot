'use strict';

const logger  = require('../utils/logger');
const fs      = require('fs');
const path    = require('path');
const betRepo = require('../database/betRepo');
const hc      = require('../algorithm/hedgeCalculator');

const TRADE_LOG        = path.join(__dirname, '../../data/trade_log.csv');
const OPEN_ORDERS_FILE = path.join(__dirname, '../../data/open_orders.json');
const BETFAIR_MIN_BET  = 1.00;
const HEDGE_RETRY_MS   = 60 * 1000; // back off 60s after a failed hedge attempt

/**
 * True when a set object has a definitive winner (≥6 games with a 2-game lead,
 * or a 7-6 tiebreak win). Inlined here (rather than requiring strategyEngine) to
 * avoid a circular dependency. Mirror of strategyEngine.isSetComplete.
 */
function isSetComplete(set) {
  if (!set) return false;
  if (set.playerA === 6 && set.playerB === 6) return false; // tiebreak in progress
  const aWon = (set.playerA >= 6 && set.playerA - set.playerB >= 2) || set.playerA === 7;
  const bWon = (set.playerB >= 6 && set.playerB - set.playerA >= 2) || set.playerB === 7;
  return aWon || bWon;
}

function roundStake(v) { return Math.round(v * 100) / 100; }

class OrderManager {
  constructor() {
    this._betfair     = null;
    this._bfbm        = null;   // BF Bot Manager client (optional — set via setBfbmClient)
    this.openOrders   = new Map();   // betId → order object
    this.settledOrders = [];
    this._hedgeFailedAt = new Map(); // marketId → timestamp of last failed hedge attempt
    this._ensureCSV();
    this._loadOpenOrders();
  }

  /** Wire up after construction — called from index.js once betfairClient is ready. */
  setClient(betfairClient) {
    this._betfair = betfairClient;
  }

  /** Wire up BFBM as execution layer — called from index.js when BFBM_ENABLED=true. */
  setBfbmClient(bfbmClient) {
    this._bfbm = bfbmClient;
    logger.info('OrderManager: BFBM execution layer registered');
  }

  /** Returns the active execution client: BFBM if enabled, otherwise direct Betfair. */
  _executionClient() {
    if (this._bfbm?.enabled) return this._bfbm;
    return this._betfair;
  }

  /** Reload any open orders that were persisted before a restart. */
  _loadOpenOrders() {
    try {
      if (!fs.existsSync(OPEN_ORDERS_FILE)) return;
      const saved = JSON.parse(fs.readFileSync(OPEN_ORDERS_FILE, 'utf-8'));
      if (!Array.isArray(saved)) return;
      for (const order of saved) {
        if (order.betId) this.openOrders.set(order.betId, order);
      }
      if (this.openOrders.size > 0) {
        logger.warn(`OrderManager: restored ${this.openOrders.size} open order(s) from disk — will resume set-hedge monitoring`, {
          markets: [...this.openOrders.values()].map(o => o.marketId),
        });
      }
    } catch (err) {
      logger.error('OrderManager: failed to load open_orders.json', { message: err.message });
    }

    // Expire any DB bets that are unsettled but have no open order (lost after restart).
    // Also backfill strategy_name if it was left null but is embedded in the reason.
    try {
      const openMarketIds = new Set([...this.openOrders.values()].map(o => o.marketId));
      const stale = betRepo.getOpen().filter(b => !openMarketIds.has(b.betfair_market_id));
      const now   = new Date().toISOString();
      for (const b of stale) {
        const nameFromReason = b.strategy_name == null && b.reason
          ? (b.reason.match(/^(\S+):/) || [])[1] || null
          : null;
        betRepo.settle(b.bet_id, {
          settlementType: 'EXPIRED',
          pnl:            0,
          settledAt:      now,
          actualOdds:     null,
        });
        if (nameFromReason) {
          betRepo.backfillStrategyName(b.bet_id, nameFromReason);
        }
        logger.warn('OrderManager: expired stale unsettled bet', {
          betId: b.bet_id, marketId: b.betfair_market_id,
          strategyName: nameFromReason || b.strategy_name,
        });
      }
    } catch (err) {
      logger.error('OrderManager: stale-bet cleanup failed', { message: err.message });
    }
  }

  /**
   * Expire any DB bets that have been unsettled for more than maxAgeHours.
   * Runs periodically to catch positions that were never traded out or cancelled.
   */
  _expireOrphanedBets(maxAgeHours = 24) {
    try {
      const cutoff = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
      const _openMarketIds = new Set([...this.openOrders.values()].map(o => o.marketId));
      const stale  = betRepo.getOpen().filter(b =>
        b.placed_at < cutoff && !_openMarketIds.has(b.betfair_market_id)
      );
      if (!stale.length) return;
      const now = new Date().toISOString();
      for (const b of stale) {
        betRepo.settle(b.bet_id, { settlementType: 'EXPIRED', pnl: 0, settledAt: now });
        logger.warn('OrderManager: expired orphaned bet (no open order, >24h old)', {
          betId: b.bet_id, marketId: b.betfair_market_id, placedAt: b.placed_at,
        });
      }
    } catch (err) {
      logger.error('OrderManager: _expireOrphanedBets failed', { message: err.message });
    }
  }

  /** Persist current open orders to disk so they survive a restart. */
  _saveOpenOrders() {
    try {
      const orders = [...this.openOrders.values()];
      fs.writeFileSync(OPEN_ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf-8');
    } catch (err) {
      logger.error('OrderManager: failed to save open_orders.json', { message: err.message });
    }
  }

  // ---------------------------------------------------------------------------
  // Order placement
  // ---------------------------------------------------------------------------

  /**
   * Place a back bet via Betfair.
   * @param {string}  marketId
   * @param {number}  selectionId
   * @param {number}  odds
   * @param {number}  stake
   * @param {object}  meta  — { matchName, playerName, playerKey, reason }
   */
  async placeBack(marketId, selectionId, odds, stake, meta = {}) {
    return this._placeOrder(marketId, selectionId, 'BACK', odds, stake, meta);
  }

  /**
   * Place a lay bet via Betfair.
   */
  async placeLay(marketId, selectionId, odds, stake, meta = {}) {
    return this._placeOrder(marketId, selectionId, 'LAY', odds, stake, meta);
  }

  async _placeOrder(marketId, selectionId, side, odds, stake, meta = {}) {
    const client = this._executionClient();
    const result = await client.placeOrder({ marketId, selectionId, side, price: odds, size: stake });

    const report = result?.instructionReports?.[0];
    if (!report || report.status !== 'SUCCESS') {
      logger.error('OrderManager: placeOrder failed', {
        marketId, side, status: result?.status, errorCode: result?.errorCode,
      });
      return null;
    }

    const betId     = report.betId || `DRY-${Date.now()}`;
    const liability = side === 'LAY' ? roundStake(stake * (odds - 1)) : stake;
    const isDry     = betId.startsWith('DRY-');

    // Rough P&L estimate for dry-run bets (how much we'd make/lose at match end)
    const estimatedWinPnL  = isDry
      ? (side === 'BACK' ? roundStake(stake * (odds - 1)) : stake)
      : null;
    const estimatedLossPnL = isDry
      ? (side === 'BACK' ? -stake : -roundStake(stake * (odds - 1)))
      : null;

    const order = {
      betId,
      marketId,
      selectionId,
      playerName:          meta.playerName   || '',
      playerKey:           meta.playerKey    || null,  // 'A' or 'B' — used for trade-out price lookup
      matchName:           meta.matchName    || '',
      strategyName:        meta.strategyName || null,  // persisted so _strategyFired can be restored on restart
      side,
      odds,
      stake,
      sizeMatched:         report.sizeMatched          ?? stake,
      averagePriceMatched: report.averagePriceMatched   ?? odds,
      liability,
      placedAt:            new Date().toISOString(),
      dryRun:              isDry,
      reason:              meta.reason       || null,
      exitConfig:          meta.exitConfig   || null,  // system-level exit condition
      setsAtEntry:         meta.setsAtEntry  ?? 0,     // sets.length when bet was placed
      momentumAtBet:       meta.momentumAtBet ?? null,
      pnl:                 null,
      estimatedWinPnL,
      estimatedLossPnL,
    };

    this.openOrders.set(betId, order);
    this._saveOpenOrders();
    this._logToCSV({ ...order, action: 'BET_PLACED' });

    // Write to DB (non-fatal — CSV is the fallback)
    try {
      betRepo.insert({
        betId:           order.betId,
        betfairMarketId: order.marketId,
        strategyName:    meta.strategyName || meta.systemName || null,
        playerKey:       order.playerKey,
        playerName:      order.playerName,
        side:            order.side,
        requestedOdds:   order.odds,
        actualOdds:      order.averagePriceMatched || order.odds,
        stake:           order.stake,
        sizeMatched:     order.sizeMatched,
        liability:       order.liability,
        placedAt:        order.placedAt,
        dryRun:          order.dryRun,
        reason:          order.reason,
        exitConfig:      order.exitConfig,
        momentumAtBet:   order.momentumAtBet ?? null,
      });
    } catch (e) {
      logger.error('OrderManager: betRepo.insert failed', { message: e.message });
    }

    if (isDry) {
      logger.info(
        `${side} placed (DRY) → ${meta.matchName} | ${meta.playerName} @ ${odds} | £${stake}` +
        ` | est. if win: £${estimatedWinPnL.toFixed(2)} | est. if lose: £${estimatedLossPnL.toFixed(2)}`
      );
    } else {
      logger.info(`${side} placed → ${meta.matchName} | ${meta.playerName} @ ${odds} | £${stake}`);
    }
    return order;
  }

  // ---------------------------------------------------------------------------
  // Exit
  // ---------------------------------------------------------------------------

  /**
   * Trade out — place the opposite side order to fully hedge the open position.
   * @param {string} betId
   * @param {number} selectionId
   * @param {number} greenupOdds  — current price at which to hedge
   * @param {object} meta         — { matchName, reason }
   */
  async tradeOut(betId, selectionId, greenupOdds, meta = {}) {
    const order = this.openOrders.get(betId);
    if (!order) {
      logger.warn('OrderManager: tradeOut — no open order', { betId });
      return null;
    }
    const marketId = order.marketId;

    // Back off if the last hedge attempt failed recently (prevents hammering on every tick)
    const lastFail = this._hedgeFailedAt.get(marketId);
    if (lastFail && (Date.now() - lastFail) < HEDGE_RETRY_MS) return null;

    // Full green-up via hedgeCalculator — same P&L regardless of outcome
    const hcResult     = hc.greenUp({ stake: order.stake, entryOdds: order.odds, side: order.side }, greenupOdds);
    const hedgeSide    = hcResult.hedgeSide;
    // Clamp to Betfair minimum — calculated stakes just under £2 would otherwise be rejected
    const hedgeStake   = Math.max(roundStake(hcResult.hedgeStake), BETFAIR_MIN_BET);
    const estimatedPnL = roundStake(hcResult.lockedProfit);

    // Dry-run positions: simulate the hedge without placing a real order
    if (order.dryRun) {
      const settled = {
        ...order,
        settledAt:    new Date().toISOString(),
        action:       'TRADE_OUT',
        reason:       meta.reason || 'set hedge',
        pnl:          estimatedPnL,
        estimatedPnL,
      };
      this.openOrders.delete(betId);
      this._saveOpenOrders();
      this.settledOrders.push(settled);
      this._logToCSV(settled);
      try {
        betRepo.settle(order.betId, { settlementType: 'TRADE_OUT', pnl: estimatedPnL, hedgeOdds: greenupOdds, settledAt: settled.settledAt });
      } catch (e) {
        logger.error('OrderManager: betRepo.settle (dryRun tradeOut) failed', { message: e.message });
      }
      logger.info(`DRY_RUN traded out → ${order.matchName} | est. P&L £${estimatedPnL.toFixed(2)} | ${meta.reason || 'set hedge'}`);
      return settled;
    }

    const client = this._executionClient();
    const result = await client.placeOrder({
      marketId,
      selectionId,
      side:  hedgeSide,
      price: greenupOdds,
      size:  hedgeStake,
    });
    logger.info(`OrderManager: hedge via ${this._bfbm?.enabled ? 'BFBM' : 'Betfair direct'}`, {
      marketId, hedgeSide, greenupOdds, hedgeStake,
    });

    const report = result?.instructionReports?.[0];
    if (!report || report.status !== 'SUCCESS') {
      logger.error('OrderManager: tradeOut hedge bet failed', { marketId });
      this._hedgeFailedAt.set(marketId, Date.now());
      return null;
    }
    this._hedgeFailedAt.delete(marketId);

    const settled = {
      ...order,
      settledAt:    new Date().toISOString(),
      action:       'TRADE_OUT',
      reason:       meta.reason || 'signal',
      pnl:          estimatedPnL,
      estimatedPnL,
    };

    this.openOrders.delete(betId);
    this._saveOpenOrders();
    this.settledOrders.push(settled);
    this._logToCSV(settled);

    try {
      betRepo.settle(order.betId, {
        settlementType: 'TRADE_OUT',
        pnl:            estimatedPnL,
        hedgeOdds:      greenupOdds,
        settledAt:      settled.settledAt,
      });
    } catch (e) {
      logger.error('OrderManager: betRepo.settle (tradeOut) failed', { message: e.message });
    }

    logger.info(`Traded out → ${order.matchName} | est. P&L £${estimatedPnL.toFixed(2)} | ${meta.reason}`);
    return settled;
  }

  /**
   * DRY_RUN only: settle an open fake bet when the match finishes.
   * Determines winner from final odds (lower = winner) or set scores,
   * then records a DRY_WIN / DRY_LOSS row in the trade log with actual P&L.
   * @param {string} marketId
   * @param {object} snapshot — final matchState snapshot
   */
  settleDryRunOrder(marketId, snapshot, opts = {}) {
    const orders = this.getOpenPositionsForMarket(marketId).filter(o => o.dryRun);
    if (orders.length === 0) return;

    // Determine the winner. We ONLY settle when the match is genuinely decided,
    // by exactly one of two authoritative signals:
    //   1. opts.officialWinner ('A'|'B') supplied by the caller — from api-tennis
    //      "Finished"/"Retired" or Betfair settlement. Handles retirements/walkovers.
    //   2. a completed best-of-3 result: a player has won 2 COMPLETED sets.
    //      (The bot blocks best-of-5, so 2 completed sets always decides the match.)
    //
    // We deliberately NEVER infer the winner from transient in-play odds. A player
    // can be ≤1.05 while serving for a set at 5-4 and then lose; markets also
    // suspend constantly between games/sets. Guessing from odds during those
    // windows previously settled bets early and backwards (e.g. a backer of the
    // eventual winner marked LOSS while their player was a set down). When the
    // result isn't yet certain we defer and let a later loop settle it correctly.
    let winner = (opts.officialWinner === 'A' || opts.officialWinner === 'B')
      ? opts.officialWinner
      : null;

    // Betfair's authoritative settled result: the winning selectionId → A/B via the
    // stored runner ids. Ordering-proof (independent of A/B labelling) and exact, so
    // it takes precedence over set-score inference.
    if (!winner && snapshot.winnerSelectionId && (snapshot.runnerIdA || snapshot.runnerIdB)) {
      if (String(snapshot.winnerSelectionId) === String(snapshot.runnerIdA)) winner = 'A';
      else if (String(snapshot.winnerSelectionId) === String(snapshot.runnerIdB)) winner = 'B';
    }

    if (!winner && Array.isArray(snapshot.sets)) {
      let setsA = 0, setsB = 0;
      for (const s of snapshot.sets) {
        if (!isSetComplete(s)) continue;            // ignore the in-progress set
        if ((s.playerA ?? 0) > (s.playerB ?? 0)) setsA++;
        else if ((s.playerB ?? 0) > (s.playerA ?? 0)) setsB++;
      }
      if (setsA >= 2) winner = 'A';
      else if (setsB >= 2) winner = 'B';
    }

    if (!winner) {
      // Not decided yet (mid-match suspension, 1-1 in sets, or feed lost before
      // the end). Do NOT settle — leave the bet open so the next loop, or the
      // api-tennis fallback once the match is officially Finished, settles it right.
      logger.info('OrderManager: DRY_RUN settlement deferred — match not yet decided', {
        marketId, matchNames: orders.map(o => o.matchName),
      });
      return false;
    }

    for (const order of orders) {
      const betWon = (order.side === 'BACK' && order.playerKey === winner) ||
                     (order.side === 'LAY'  && order.playerKey !== winner);

      const pnl = betWon
        ? (order.side === 'BACK'
            ? roundStake(order.stake * (order.odds - 1))
            : order.stake)
        : (order.side === 'BACK'
            ? -order.stake
            : -roundStake(order.stake * (order.odds - 1)));

      const settled = {
        ...order,
        settledAt: new Date().toISOString(),
        action:    betWon ? 'DRY_WIN' : 'DRY_LOSS',
        reason:    `Match finished — ${betWon ? 'won' : 'lost'}`,
        pnl,
      };

      this.openOrders.delete(order.betId);
      this.settledOrders.push(settled);
      this._logToCSV(settled);

      try {
        betRepo.settle(order.betId, {
          settlementType: settled.action,          // 'DRY_WIN' or 'DRY_LOSS'
          pnl,
          settledAt:      settled.settledAt,
        });
      } catch (e) {
        logger.error('OrderManager: betRepo.settle (dryRun) failed', { message: e.message });
      }

      logger.info(
        `DRY_RUN settled → ${order.matchName} | ${order.side} on ${order.playerName} @ ${order.odds} | ${betWon ? 'WIN' : 'LOSS'} | P&L £${pnl.toFixed(2)}`
      );
    }

    this._saveOpenOrders();
    return true;
  }

  /**
   * Cancel all open orders — called on shutdown.
   */
  async cancelAll() {
    for (const [betId, order] of this.openOrders.entries()) {
      try {
        await this._executionClient().cancelOrder({ marketId: order.marketId, betId });
        logger.info(`Cancelled on shutdown → ${order.matchName}`);
      } catch (err) {
        logger.error('OrderManager: cancelAll — cancel failed', { marketId: order.marketId, message: err.message });
      }
    }
    this.openOrders.clear();
    this._saveOpenOrders();
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Estimated unrealised P&L for an open position given its current price.
   * @param {string} betId
   * @param {number|null} currentPrice  — current back price of the selection
   */
  getCurrentPnL(betId, currentPrice) {
    for (const order of this.openOrders.values()) {
      if (order.betId !== betId) continue;
      if (!currentPrice || currentPrice <= 1) return 0;
      return roundStake(hc.greenUp({ stake: order.stake, entryOdds: order.odds, side: order.side }, currentPrice).lockedProfit);
    }
    return 0;
  }

  getOpenPositionForMarket(marketId) {
    for (const o of this.openOrders.values()) {
      if (o.marketId === marketId) return o;
    }
    return null;
  }

  getOpenPositionsForMarket(marketId) {
    return [...this.openOrders.values()].filter(o => o.marketId === marketId);
  }

  getOpenMarketIds()   { return [...new Set([...this.openOrders.values()].map(o => o.marketId))]; }
  getOpenCount()       { return this.openOrders.size; }

  getTotalExposure() {
    let total = 0;
    for (const o of this.openOrders.values()) total += o.liability || 0;
    return total;
  }

  getPnlToday() {
    const today = new Date().toISOString().split('T')[0];
    return this.settledOrders
      .filter(o => o.settledAt?.startsWith(today) && o.pnl !== null)
      .reduce((sum, o) => sum + (o.pnl || 0), 0);
  }

  getMatchedToday() {
    const today = new Date().toISOString().split('T')[0];
    return this.settledOrders
      .filter(o => o.settledAt?.startsWith(today))
      .reduce((sum, o) => sum + (o.stake || 0), 0);
  }

  // ---------------------------------------------------------------------------
  // CSV logging
  // ---------------------------------------------------------------------------

  _ensureCSV() {
    if (!fs.existsSync(TRADE_LOG)) {
      fs.writeFileSync(
        TRADE_LOG,
        'betId,marketId,matchName,playerName,side,odds,stake,liability,action,reason,placedAt,settledAt,pnl,dryRun,estimatedWinPnL,estimatedLossPnL\n',
        'utf-8'
      );
    }
  }

  _logToCSV(order) {
    const row = [
      order.betId, order.marketId, order.matchName, order.playerName,
      order.side, order.odds, order.stake, order.liability, order.action,
      order.reason, order.placedAt, order.settledAt || '', order.pnl ?? '', order.dryRun,
      order.estimatedWinPnL ?? '', order.estimatedLossPnL ?? '',
    ].map(v => this._csvEscape(v)).join(',');
    fs.appendFileSync(TRADE_LOG, row + '\n', 'utf-8');
  }

  _csvEscape(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
}

module.exports = OrderManager;
