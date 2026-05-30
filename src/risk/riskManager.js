'use strict';

/**
 * riskManager.js
 *
 * Approves bets and returns the flat stake configured for the system.
 * Rejects only on invalid input (bad odds).
 * Edge check removed — strategy-based bets are approved by trigger conditions,
 * not by a real-time edge calculation.
 */

const logger = require('../utils/logger');

const DEFAULT_STAKE = 1;

function roundStake(value) {
  return Math.round(value * 100) / 100;
}

function liability(side, stake, odds) {
  if (side === 'LAY') return stake * (odds - 1);
  return stake;
}

function totalLiability(openOrders) {
  return openOrders.reduce((sum, o) => sum + liability(o.side, o.stake, o.odds), 0);
}

function check(proposal, _exposure, config = {}) {
  const { marketId, side = 'BACK', odds, edgePercent } = proposal;

  const reject = (reason) => {
    logger.warn('RiskManager: bet rejected', { marketId, reason });
    return { approved: false, rejectionReason: reason, recommendedStake: 0, projectedLiability: 0 };
  };

  if (!odds || odds <= 1) return reject('Invalid odds (<= 1)');

  const recommendedStake = roundStake(config.stakeGBP ?? DEFAULT_STAKE);
  const projectedLiability = roundStake(liability(side, recommendedStake, odds));

  const isDryRun = process.env.DRY_RUN === 'true';
  logger.info(isDryRun ? 'RiskManager: DRY_RUN — bet approved (not sent)' : 'RiskManager: bet approved', {
    marketId, side, odds, edgePercent, recommendedStake,
  });

  return { approved: true, rejectionReason: null, recommendedStake, projectedLiability, dryRun: isDryRun };
}

module.exports = { check, totalLiability, liability };
