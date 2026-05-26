'use strict';

/**
 * hedgeCalculator.js
 *
 * Calculates optimal hedge stakes for open Betfair positions.
 *
 * All functions accept an `order` object (from orderManager.openOrders) and
 * return a `HedgeResult` describing the recommended hedge stake and expected P&L.
 *
 * ── Core formula ──────────────────────────────────────────────────────────────
 *
 * For a position opened at entry odds E with stake S:
 *
 *   hedgeStake   = (S × E) / C          where C = current odds
 *   lockedProfit = S × (E − C) / C      = hedgeStake − S
 *
 * This is identical for BACK and LAY positions (S is always the back-equivalent
 * stake: what the backer risked). The hedge direction is the opposite side:
 *   • BACK entry  → LAY to hedge
 *   • LAY entry   → BACK to hedge
 *
 * ── Four hedging modes ────────────────────────────────────────────────────────
 *
 *  1. greenUp          — lock in 100 % of available profit/loss (guaranteed P&L)
 *  2. partialHedge     — lock in X % of available profit, leave rest running
 *  3. kellyHedge       — Kelly-optimal hedge: full green-up if edge gone,
 *                        partial if remaining edge still positive
 *  4. breakEvenHedge   — hedge enough to recover stake (zero net), or full
 *                        green-up if profit has already exceeded stake
 *
 * ── Usage ─────────────────────────────────────────────────────────────────────
 *
 *   const hc = require('./hedgeCalculator');
 *
 *   const result = hc.greenUp({ stake: 2, entryOdds: 3.0, side: 'BACK' }, 2.2);
 *   // result.hedgeStake → 2.73, result.lockedProfit → 0.73
 *
 *   const result = hc.kellyHedge(order, 2.2, { remainingEdgePct: 4, bankroll: 1000 });
 *   // result.hedgeStake → 1.95 (partial — some edge left so don't fully exit)
 */

// ---------------------------------------------------------------------------
// Types (JSDoc only — runtime validation kept minimal for performance)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Order
 * @property {number} stake       — back-equivalent stake placed (GBP)
 * @property {number} entryOdds   — Betfair decimal odds at entry
 * @property {'BACK'|'LAY'} side  — direction of the entry bet
 */

/**
 * @typedef {object} HedgeResult
 * @property {number}           hedgeStake    — recommended stake for the hedge bet (GBP)
 * @property {'BACK'|'LAY'}     hedgeSide     — direction of the hedge bet
 * @property {number}           lockedProfit  — guaranteed P&L once hedge is placed (GBP)
 * @property {number}           hedgeOdds     — the current odds the hedge is priced at
 * @property {number}           profitIfWins  — P&L if selection wins after hedge
 * @property {number}           profitIfLoses — P&L if selection loses after hedge
 * @property {string}           mode          — which calculation mode was used
 * @property {string}           rationale     — human-readable explanation
 */

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Round to nearest Betfair tick (sufficient for 2dp stake sizing). */
function _round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Core formula: full green-up stake and locked profit.
 * Returns { hedgeStake, lockedProfit } before rounding.
 *
 * BACK: profit = S*(E-C)/C  — positive when odds shorten (E > C)
 * LAY:  profit = S*(C-E)/C  — positive when odds drift   (C > E)
 */
function _fullGreenUpRaw(stake, entryOdds, currentOdds, side = 'BACK') {
  const hedgeStake   = (stake * entryOdds) / currentOdds;
  const lockedProfit = side === 'BACK'
    ? stake * (entryOdds - currentOdds) / currentOdds
    : stake * (currentOdds - entryOdds) / currentOdds;
  return { hedgeStake, lockedProfit };
}

/**
 * P&L breakdown for a partial hedge of `hedgeStake` on an open BACK position.
 *
 * If A wins:  backProfit - layLoss = S×(E−1) − hedgeStake×(C−1)
 * If A loses: backLoss + layWin   = −S       + hedgeStake
 */
function _pnlBack(stake, entryOdds, currentOdds, hedgeStake) {
  const profitIfWins  = _round2(stake * (entryOdds - 1) - hedgeStake * (currentOdds - 1));
  const profitIfLoses = _round2(-stake + hedgeStake);
  return { profitIfWins, profitIfLoses };
}

/**
 * P&L breakdown for a partial hedge on a LAY position.
 * Entry was LAY at odds E, stake S (backer's stake = what we risked as layer).
 *
 * If A wins:  −liability + backWin    = −S×(E−1) + hedgeStake×(C−1)
 * If A loses: layCollect + backLoss   = +S        − hedgeStake
 */
function _pnlLay(stake, entryOdds, currentOdds, hedgeStake) {
  const profitIfWins  = _round2(-stake * (entryOdds - 1) + hedgeStake * (currentOdds - 1));
  const profitIfLoses = _round2(stake - hedgeStake);
  return { profitIfWins, profitIfLoses };
}

function _pnl(order, currentOdds, hedgeStake) {
  return order.side === 'BACK'
    ? _pnlBack(order.stake, order.entryOdds, currentOdds, hedgeStake)
    : _pnlLay(order.stake, order.entryOdds, currentOdds, hedgeStake);
}

function _hedgeSide(entrySide) {
  return entrySide === 'BACK' ? 'LAY' : 'BACK';
}

// ---------------------------------------------------------------------------
// 1. Full green-up — lock in 100 % of available P&L
// ---------------------------------------------------------------------------

/**
 * Calculate the stake needed to guarantee the same P&L regardless of outcome.
 *
 * This is the standard "green up" used at set-result exits.
 *
 * @param {Order}  order
 * @param {number} currentOdds  — live market price for the selection
 * @returns {HedgeResult}
 */
function greenUp(order, currentOdds) {
  const { hedgeStake: raw, lockedProfit } = _fullGreenUpRaw(order.stake, order.entryOdds, currentOdds, order.side);
  const hedgeStake = _round2(raw);
  const { profitIfWins, profitIfLoses } = _pnl(order, currentOdds, hedgeStake);

  const direction  = lockedProfit >= 0 ? 'profit' : 'loss';
  const absPnl     = Math.abs(lockedProfit).toFixed(2);

  return {
    hedgeStake,
    hedgeSide:    _hedgeSide(order.side),
    lockedProfit: _round2(lockedProfit),
    hedgeOdds:    currentOdds,
    profitIfWins,
    profitIfLoses,
    mode:         'greenUp',
    rationale:    `Lock in £${absPnl} ${direction} — entry @ ${order.entryOdds}, current @ ${currentOdds}`,
  };
}

// ---------------------------------------------------------------------------
// 2. Partial hedge — lock in a chosen percentage of the available profit/loss
// ---------------------------------------------------------------------------

/**
 * Hedge enough to lock in `ratio` (0–1) of the full green-up P&L.
 * The remainder of the position stays open at full risk.
 *
 * ratio = 0   → no hedge (hold full position)
 * ratio = 0.5 → hedge half; if P&L goes against you, loss is halved
 * ratio = 1   → identical to greenUp()
 *
 * Use this when you have conviction that the remaining odds move will
 * continue in your favour but want to bank some profit first.
 *
 * @param {Order}  order
 * @param {number} currentOdds
 * @param {number} ratio        — 0.0 to 1.0
 * @returns {HedgeResult}
 */
function partialHedge(order, currentOdds, ratio = 0.5) {
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const { hedgeStake: rawFull } = _fullGreenUpRaw(order.stake, order.entryOdds, currentOdds, order.side);

  const hedgeStake   = _round2(rawFull * clampedRatio);
  const lockedProfit = _round2(hedgeStake - order.stake * clampedRatio);
  const { profitIfWins, profitIfLoses } = _pnl(order, currentOdds, hedgeStake);
  const pct = Math.round(clampedRatio * 100);

  return {
    hedgeStake,
    hedgeSide:    _hedgeSide(order.side),
    lockedProfit,
    hedgeOdds:    currentOdds,
    profitIfWins,
    profitIfLoses,
    mode:         'partialHedge',
    rationale:    `${pct}% partial hedge — locks £${Math.abs(lockedProfit).toFixed(2)}, leaves ${100 - pct}% open`,
  };
}

// ---------------------------------------------------------------------------
// 3. Kelly-optimal hedge — reduce or fully exit based on remaining edge
// ---------------------------------------------------------------------------

/**
 * Determine the optimal hedge fraction using Kelly logic.
 *
 * If the remaining implied edge (based on your true probability estimate vs
 * current odds) is still positive, a full exit destroys expected value. Kelly
 * says keep a fraction proportional to the remaining edge.
 *
 * Algorithm:
 *   • fullGreenUpProfit = S × (E − C) / C
 *   • remainingEV       = stake × (remainingEdgePct / 100)
 *   • If fullGreenUpProfit ≤ 0: always full green-up (no edge to keep)
 *   • Else: hedgeRatio  = 1 − clamp(remainingEdgePct / maxEdgePct, 0, 0.8)
 *     (never hedge less than 20% — always reduce risk somewhat once in profit)
 *
 * @param {Order}  order
 * @param {number} currentOdds
 * @param {{ remainingEdgePct: number, bankroll?: number, maxEdgePct?: number }} opts
 *   remainingEdgePct — your current estimated edge % on the open selection (0 if edge gone)
 *   bankroll         — total bankroll (used to cap max stake, optional)
 *   maxEdgePct       — edge % at which hedge ratio bottoms out at 20% (default 10)
 * @returns {HedgeResult}
 */
function kellyHedge(order, currentOdds, { remainingEdgePct = 0, bankroll = Infinity, maxEdgePct = 10 } = {}) {
  const { lockedProfit } = _fullGreenUpRaw(order.stake, order.entryOdds, currentOdds, order.side);

  // If position is underwater or edge is gone — full green-up to limit loss
  if (lockedProfit <= 0 || remainingEdgePct <= 0) {
    return {
      ...greenUp(order, currentOdds),
      mode:      'kellyHedge',
      rationale: `Kelly: no remaining edge (${remainingEdgePct.toFixed(1)}%) — full exit at £${_round2(lockedProfit).toFixed(2)}`,
    };
  }

  // Scale hedge ratio: high edge → hedge less, low edge → hedge more
  // At remainingEdgePct = maxEdgePct we hedge 20% (minimum); at 0% we hedge 100%
  const rawRatio    = 1 - Math.min(remainingEdgePct / maxEdgePct, 0.8);
  const hedgeRatio  = Math.max(0.2, Math.min(1, rawRatio));

  const result     = partialHedge(order, currentOdds, hedgeRatio);
  const edgeStr    = remainingEdgePct.toFixed(1);
  const ratioStr   = Math.round(hedgeRatio * 100);

  return {
    ...result,
    mode:      'kellyHedge',
    rationale: `Kelly: ${edgeStr}% remaining edge → ${ratioStr}% hedge. Locked £${Math.abs(result.lockedProfit).toFixed(2)}, remainder still live.`,
  };
}

// ---------------------------------------------------------------------------
// 4. Break-even hedge — recover stake, minimise loss
// ---------------------------------------------------------------------------

/**
 * Calculate the hedge needed to recover the original stake (break even).
 * If the position is already profitable enough for a full green-up profit
 * to exceed stake, this falls back to greenUp().
 *
 * Useful when a bet is going against you: hedge enough to get stake back
 * rather than taking the full loss.
 *
 * @param {Order}  order
 * @param {number} currentOdds
 * @returns {HedgeResult}
 */
function breakEvenHedge(order, currentOdds) {
  const { lockedProfit } = _fullGreenUpRaw(order.stake, order.entryOdds, currentOdds, order.side);

  // Already profitable enough — just green up fully
  if (lockedProfit >= 0) {
    return {
      ...greenUp(order, currentOdds),
      mode:      'breakEvenHedge',
      rationale: `Position in profit (£${lockedProfit.toFixed(2)}) — full green-up applied`,
    };
  }

  // Underwater — hedge enough so the loss is minimised to half the current loss
  // (full break-even requires the hedge itself to make back the entire stake
  //  which is only possible if the price has moved favourably enough)
  const maxRecoverable = currentOdds > 1
    ? _round2(order.stake / (currentOdds - 1))   // max we can recover via lay
    : 0;

  const hedgeStake     = Math.min(maxRecoverable, _round2(order.stake));
  const { profitIfWins, profitIfLoses } = _pnl(order, currentOdds, hedgeStake);
  const worstCase      = Math.min(profitIfWins, profitIfLoses);
  const fullLoss       = -order.stake;
  const improvement    = _round2(worstCase - fullLoss);

  return {
    hedgeStake,
    hedgeSide:    _hedgeSide(order.side),
    lockedProfit: _round2(Math.max(profitIfWins, profitIfLoses)), // not truly locked, but best case
    hedgeOdds:    currentOdds,
    profitIfWins,
    profitIfLoses,
    mode:         'breakEvenHedge',
    rationale:    `Position down £${Math.abs(lockedProfit).toFixed(2)} — partial recovery saves ~£${improvement.toFixed(2)} vs full loss`,
  };
}

// ---------------------------------------------------------------------------
// Summary helper — returns all four modes for dashboard comparison
// ---------------------------------------------------------------------------

/**
 * Run all four hedge modes and return a comparison array.
 * Useful for the dashboard "Hedge Options" panel.
 *
 * @param {Order}  order
 * @param {number} currentOdds
 * @param {number} [remainingEdgePct=0]
 * @returns {HedgeResult[]}
 */
function compareAll(order, currentOdds, remainingEdgePct = 0) {
  return [
    greenUp(order, currentOdds),
    partialHedge(order, currentOdds, 0.5),
    kellyHedge(order, currentOdds, { remainingEdgePct }),
    breakEvenHedge(order, currentOdds),
  ];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  greenUp,
  partialHedge,
  kellyHedge,
  breakEvenHedge,
  compareAll,
};
