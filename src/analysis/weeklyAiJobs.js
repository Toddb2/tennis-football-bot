'use strict';

/**
 * weeklyAiJobs.js
 *
 * Schedules the two automated weekly AI jobs, following the same recursive
 * setTimeout pattern as missedBetsAnalyser.startNightlyJob():
 *
 *   1. Strategy Discovery — Claude mines the market/scanner/bet data for new
 *      strategies; candidates land in strategy_lab and are auto-simulated.
 *   2. Filter Review — Claude reviews (does not change) the live filters; the
 *      markdown report is stored in ai_runs.
 *
 * Default cadence: Sunday 23:00 UTC. Change DAY_UTC / HOUR_UTC to adjust.
 * Both jobs are fire-and-forget (aiRuns inserts the ai_runs row and returns an
 * id immediately), so a Claude/network failure is recorded on that row and
 * never crashes the scheduler.
 */

const logger = require('../utils/logger');
const aiRuns = require('./aiRuns');

const DAY_UTC  = 0;   // 0 = Sunday
const HOUR_UTC = 23;  // 23:00 UTC

function _msUntilNextRun(now) {
  const next = new Date(now);
  next.setUTCHours(HOUR_UTC, 0, 0, 0);
  let days = (DAY_UTC - next.getUTCDay() + 7) % 7;
  if (days === 0 && next <= now) days = 7; // already past today's slot → next week
  next.setUTCDate(next.getUTCDate() + days);
  return { delay: next - now, next };
}

let _timer = null;
function startWeeklyJobs() {
  if (_timer) clearTimeout(_timer);
  const { delay, next } = _msUntilNextRun(new Date());
  _timer = setTimeout(() => {
    runNow('scheduled');
    startWeeklyJobs(); // reschedule for next week
  }, delay);
  logger.info('weeklyAiJobs: scheduled', { firesAt: next.toISOString() });
}

/** Fire both jobs immediately. Returns the two run ids. Used by the scheduler
 *  and available for a manual "run weekly jobs now" trigger. */
function runNow(trigger = 'manual') {
  const out = {};
  try { out.discoveryRunId = aiRuns.startStrategyDiscovery(); }
  catch (e) { logger.error('weeklyAiJobs: discovery start failed', { message: e.message }); }
  try { out.filterReviewRunId = aiRuns.startFilterReview(); }
  catch (e) { logger.error('weeklyAiJobs: filter review start failed', { message: e.message }); }
  logger.info('weeklyAiJobs: jobs started', { trigger, ...out });
  return out;
}

module.exports = { startWeeklyJobs, runNow };
