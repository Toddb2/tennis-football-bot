'use strict';

const path = require('path');
const fs   = require('fs');

const STRATEGIES_PATH = path.join(__dirname, '../config/strategies.json');

/**
 * strategyReplayer.js
 *
 * Replays the set-based backtest strategies (config/backtest_strategies.json)
 * against historical price data.
 *
 * Strategies use winner/loser-relative entry so they work regardless of
 * which runner happens to be labelled playerA or playerB in the market.
 *
 * P&L is expressed in units (1 unit = 1 point staked).
 */

class StrategyReplayer {

  constructor() {
    const config = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf8'));
    this.strategies = (config.systems || [])
      .filter(s => s.backtest && s.backtest.trigger && s.backtest.entry)
      .map(s => ({
        name:        s.name,
        description: s.description,
        trigger:     s.backtest.trigger,
        entry:       s.backtest.entry,
        exit:        s.backtest.exit || { type: 'none' },
      }));
    this.results = [];
  }

  /** Replay all strategies against a single market. */
  replayMarket(market, setEvents, runnerA, runnerB) {
    if (!setEvents.length) return;

    // Skip low-liquidity markets — only when totalMatched is known
    if (market.totalMatched > 0 && market.totalMatched < 50000) return;

    const preMatchA  = this._getPreMatchPrice(runnerA);
    const preMatchB  = this._getPreMatchPrice(runnerB);
    const set1Event  = setEvents[0];

    // Resolve settled match winner from definitive settlement data if available
    let matchWinner = null; // 'playerA' | 'playerB' | null
    if (market.winnerSelId) {
      matchWinner = market.winnerSelId === runnerA.selectionId ? 'playerA' : 'playerB';
    }

    for (const strategy of this.strategies) {
      const result = this._evaluateStrategy(
        strategy, set1Event, setEvents,
        preMatchA, preMatchB, market.marketId, matchWinner
      );
      if (result) this.results.push(result);
    }
  }

  _evaluateStrategy(strategy, set1Event, allSetEvents, preMatchA, preMatchB, marketId, matchWinner) {
    const { trigger, entry } = strategy;

    // Resolve which runner is the "winner" and "loser" of set 1
    const winnerIsA = set1Event.winnerEstimate === 'playerA';
    const winnerPreMatch = winnerIsA ? preMatchA : preMatchB;
    const loserPreMatch  = winnerIsA ? preMatchB : preMatchA;

    // --- Trigger checks ---

    // Tiebreak check
    if (trigger.isTiebreak !== undefined) {
      const isTiebreak = parseFloat(set1Event.changePct) < 22;
      if (trigger.isTiebreak && !isTiebreak) return null;
      if (!trigger.isTiebreak && isTiebreak)  return null;
    }

    // Minimum price move (convincing win)
    if (trigger.minChangePct != null) {
      if (parseFloat(set1Event.changePct) < trigger.minChangePct) return null;
    }

    // Pre-match odds of the SET 1 WINNER
    if (trigger.preMatchOddsWinner) {
      if (!winnerPreMatch) return null;
      if (winnerPreMatch < trigger.preMatchOddsWinner.min ||
          winnerPreMatch > trigger.preMatchOddsWinner.max) return null;
    }

    // Pre-match odds of the SET 1 LOSER
    if (trigger.preMatchOddsLoser) {
      if (!loserPreMatch) return null;
      if (loserPreMatch < trigger.preMatchOddsLoser.min ||
          loserPreMatch > trigger.preMatchOddsLoser.max) return null;
    }

    // --- Resolve entry player ---
    let resolvedPlayer;
    if (entry.player === 'winner') {
      resolvedPlayer = set1Event.winnerEstimate;           // 'playerA' or 'playerB'
    } else if (entry.player === 'loser') {
      resolvedPlayer = winnerIsA ? 'playerB' : 'playerA';
    } else {
      resolvedPlayer = entry.player;                       // explicit 'playerA'/'playerB'
    }

    // --- Entry price ---
    const entryPrice = resolvedPlayer === 'playerA'
      ? set1Event.priceA_after
      : set1Event.priceB_after;

    if (!entryPrice) return null;

    // --- Entry odds range check ---
    if (entryPrice < entry.minOdds || entryPrice > entry.maxOdds) {
      return {
        marketId,
        strategy:      strategy.name,
        triggered:     false,
        skipReason:    `Entry price ${entryPrice.toFixed(2)} outside range ${entry.minOdds}–${entry.maxOdds}`,
        preMatchA,
        preMatchB,
        set1ChangePct: set1Event.changePct,
        confidence:    set1Event.confidence,
      };
    }

    // --- P&L calculation ---
    // Prefer definitive settlement data (runner status = WINNER/LOSER from market def).
    // Fall back to last-set-event price proxy only when settlement is unavailable.
    const lastEvent  = allSetEvents[allSetEvents.length - 1];
    let pnl          = null;
    let exitPrice    = null;
    let exitReason   = null;

    if (matchWinner !== null) {
      // Definitive outcome — use settlement result directly
      const won = (resolvedPlayer === matchWinner);
      exitReason = 'Settlement (definitive)';
      if (entry.side === 'BACK') {
        pnl = won
          ? parseFloat((entryPrice - 1).toFixed(3))
          : parseFloat((-1).toFixed(3));
      } else {
        pnl = !won
          ? parseFloat((1.0 / (entryPrice - 1)).toFixed(3))
          : parseFloat((-1).toFixed(3));
      }
    } else if (lastEvent) {
      // Fallback proxy: last tracked price from final set event
      exitReason = 'Price proxy (no settlement data)';
      exitPrice  = resolvedPlayer === 'playerA'
        ? lastEvent.priceA_after
        : lastEvent.priceB_after;

      if (exitPrice) {
        if (entry.side === 'BACK') {
          pnl = exitPrice < 1.10
            ? parseFloat((entryPrice - 1).toFixed(3))
            : parseFloat((-1).toFixed(3));
        } else {
          pnl = exitPrice > 5.0
            ? parseFloat((1.0 / (entryPrice - 1)).toFixed(3))
            : parseFloat((-1).toFixed(3));
        }
      }
    }

    return {
      marketId,
      strategy:           strategy.name,
      triggered:          true,
      side:               entry.side,
      player:             resolvedPlayer,
      entryPrice,
      exitPrice,
      pnl,
      exitReason,
      matchWinner,
      preMatchA,
      preMatchB,
      set1WinnerEstimate: set1Event.winnerEstimate,
      set1ChangePct:      set1Event.changePct,
      confidence:         set1Event.confidence,
    };
  }

  _getPreMatchPrice(runner) {
    const pre = runner.priceHistory.filter(p => !p.inPlay && p.price);
    return pre.length ? pre[pre.length - 1].price : null;
  }

  /** Return aggregate summary across all replayed markets. */
  getSummary() {
    const triggered = this.results.filter(r => r.triggered);
    const withPnl   = triggered.filter(r => r.pnl !== null);
    const wins      = withPnl.filter(r => r.pnl > 0);

    const byStrategy = {};
    for (const r of triggered) {
      if (!byStrategy[r.strategy]) {
        byStrategy[r.strategy] = { bets: 0, wins: 0, totalPnl: 0, incomplete: 0, odds: [] };
      }
      const s = byStrategy[r.strategy];
      s.bets++;
      if (r.pnl > 0)      s.wins++;
      if (r.pnl !== null) s.totalPnl += r.pnl;
      if (r.pnl === null) s.incomplete++;
      if (r.entryPrice)   s.odds.push(r.entryPrice);
    }

    for (const s of Object.values(byStrategy)) {
      s.avgOdds = s.odds.length
        ? parseFloat((s.odds.reduce((a, b) => a + b, 0) / s.odds.length).toFixed(2))
        : null;
      delete s.odds;
    }

    const totalPnl = withPnl.reduce((s, r) => s + r.pnl, 0);
    return {
      totalMarketsAnalysed: new Set(this.results.map(r => r.marketId)).size,
      totalBetsTriggered:   triggered.length,
      completeBets:         withPnl.length,
      wins:                 wins.length,
      winRate:              withPnl.length > 0
        ? ((wins.length / withPnl.length) * 100).toFixed(1) + '%'
        : 'N/A',
      totalPnl:  totalPnl.toFixed(2),
      byStrategy,
    };
  }
}

module.exports = StrategyReplayer;
