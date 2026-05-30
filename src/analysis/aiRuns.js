'use strict';

/**
 * aiRuns.js
 *
 * Core logic for the two AI jobs, decoupled from HTTP so both the dashboard
 * routes (POST /api/ai-runs/*) and the weekly scheduler (weeklyAiJobs.js) can
 * trigger them:
 *
 *   1. Strategy Discovery — feed Claude the market/bet/scanner data and ask for
 *      3–5 new strategies with minimal overlap. Saved to the strategy_lab table;
 *      each saved candidate is then backfilled through the simulator so its
 *      performance is ready to view immediately.
 *   2. Filter Review — ask Claude to review (not change) the live filters against
 *      actual bet performance. Markdown result stored in ai_runs.
 *
 * Each `start*` function inserts the ai_runs row, kicks the async work off
 * fire-and-forget, and returns the runId immediately. The HTTP handler responds
 * with that id while Claude works in the background.
 *
 * Uses the Node 20 global fetch — no node-fetch dependency.
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../database/db');
const logger = require('../utils/logger');

const MODEL = 'claude-sonnet-4-6';
const CONFIG_DIR = path.join(__dirname, '../../config');
const DATA_DIR   = path.join(__dirname, '../../data');

function _readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { logger.warn('aiRuns: could not read ' + p, { message: e.message }); return fallback; }
}

async function _callClaude(prompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  const text = (data.content && data.content[0] && data.content[0].text) || '';
  const tokensUsed = ((data.usage && data.usage.input_tokens) || 0) + ((data.usage && data.usage.output_tokens) || 0);
  if (!text && data.error) throw new Error(data.error.message || 'Claude API error');
  return { text, tokensUsed };
}

// ── STRATEGY DISCOVERY ───────────────────────────────────────────────────────

function startStrategyDiscovery() {
  const runId = db.prepare(`INSERT INTO ai_runs (run_type, model, prompt_summary) VALUES (?,?,?)`)
    .run('strategy_discovery', MODEL, 'Weekly strategy discovery from market data').lastInsertRowid;
  _doStrategyDiscovery(runId).catch(e => {
    logger.error('aiRuns: strategy discovery failed', { runId, message: e.message });
    try { db.prepare(`UPDATE ai_runs SET status='error', completed_at=?, error=? WHERE id=?`)
      .run(new Date().toISOString(), e.message, runId); } catch (_) {}
  });
  return runId;
}

async function _doStrategyDiscovery(runId) {
  const markets = db.prepare(`SELECT match_name, surface, tournament, tournament_round, pre_match_odds_a, pre_match_odds_b, winner, final_sets, went_in_play_at FROM markets WHERE winner IS NOT NULL AND pre_match_odds_a IS NOT NULL ORDER BY went_in_play_at DESC LIMIT 2000`).all();
  const scanner = db.prepare(`SELECT match_name, tournament, surface, went_in_play_at, pre_match_odds_a, pre_match_odds_b, set1_end_odds_a, set1_end_odds_b, set2_end_odds_a, set2_end_odds_b, peak_volume, winner, final_sets FROM market_scanner ORDER BY went_in_play_at DESC LIMIT 500`).all();
  const betStats = db.prepare(`SELECT strategy_name, COUNT(*) as bets, SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins, ROUND(SUM(pnl),2) as total_pnl, ROUND(AVG(requested_odds),3) as avg_odds FROM bets WHERE pnl IS NOT NULL GROUP BY strategy_name`).all();
  const allBets = db.prepare(`SELECT b.strategy_name, b.player_key, b.side, b.requested_odds, b.pnl, b.placed_at, b.momentum_at_bet, m.surface, m.tournament, m.pre_match_odds_a, m.pre_match_odds_b FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id WHERE b.pnl IS NOT NULL ORDER BY b.placed_at DESC`).all();
  const existingStrats = _readJson(path.join(CONFIG_DIR, 'strategies.json'), { systems: [] });
  const bfbmFilter = _readJson(path.join(DATA_DIR, 'bfbm_filter.json'), {});
  const labState   = _readJson(path.join(DATA_DIR, 'filter-lab-state.json'), {});

  const prompt = `You are a professional sports trading analyst for a tennis betting bot. Your job is to discover new profitable betting strategies from historical data.

EXISTING LIVE STRATEGIES (avoid overlapping these):
${JSON.stringify(existingStrats.systems.map(s => ({ name: s.name, description: s.description, trigger: s.backtest && s.backtest.trigger, entry: s.backtest && s.backtest.entry })), null, 2)}

CURRENT BFBM FILTER (active filter that gates bet placement):
${JSON.stringify(bfbmFilter, null, 2)}

CURRENT FILTER LAB STATE:
${JSON.stringify(labState, null, 2)}

STRATEGY PERFORMANCE SUMMARY:
${JSON.stringify(betStats, null, 2)}

ALL SETTLED BETS WITH CONTEXT (${allBets.length} bets):
${JSON.stringify(allBets, null, 2)}

COMPLETED MARKETS WITH OUTCOMES (${markets.length} matches):
${JSON.stringify(markets, null, 2)}

HIGH VOLUME MARKET SCANNER DATA (${scanner.length} matches >=200k volume):
${JSON.stringify(scanner, null, 2)}

TASK: Analyse ALL the above data thoroughly. Identify 3-5 new betting strategies that show genuine edge. Each strategy must:
1. Have minimal overlap with existing strategies
2. Be backed by specific data evidence you can cite
3. Use concrete, testable parameters (specific odds ranges, set scores, surfaces)
4. Follow the exact JSON structure of existing strategies

NAMING & DESCRIPTION RULES (important for readability):
- name: a SHORT, human-readable Title Case label of 3-5 words. NO codes, NO underscores, NO "StratNN" prefixes. Good: "Clay Tiebreak Underdog Fade", "Grass Favourite Set-1 Drift". Bad: "Strat13_TiebreakLoserDrift_P1".
- description: ONE clear plain-English sentence saying exactly when it fires and what bet it places, e.g. "After the favourite drops set 1 on clay (6-3/6-4), back them in-play at 1.8-2.6."
- rationale: ONE sentence citing the specific data evidence (sample size + win rate or P&L) that justifies it.

Return ONLY a JSON array. Each object must have these exact fields:
name, description, enabled (false), filters (surfaces array, minFirstServeWonDiff), staking (stakeGBP: 1), exit (type: "none"), backtest (trigger with setNumber/loserMustBe/requireSplitSets/allowedSetScores, entry with player/side/minOdds/maxOdds), rationale

Return ONLY valid JSON array, no markdown fences, no text outside the array.`;

  const { text, tokensUsed } = await _callClaude(prompt);
  let strategies = [];
  try { strategies = JSON.parse(text.replace(/```json|```/g, '').trim()); } catch (_) {}
  const savedIds = [];
  for (const s of (Array.isArray(strategies) ? strategies : [])) {
    try {
      const info = db.prepare(`INSERT OR IGNORE INTO strategy_lab (name, description, config, created_by, ai_run_id) VALUES (?,?,?,'ai',?)`)
        .run(s.name, s.description || s.rationale || null, JSON.stringify(s), String(runId));
      if (info.changes > 0) savedIds.push(Number(info.lastInsertRowid));
    } catch (_) {}
  }
  db.prepare(`UPDATE ai_runs SET status='completed', completed_at=?, strategies_found=?, tokens_used=?, result=? WHERE id=?`)
    .run(new Date().toISOString(), savedIds.length, tokensUsed, text.slice(0, 5000), runId);

  // Backfill the new candidates through the simulator (forked child process, so
  // the heavy historical replay never blocks the bot) — populates their
  // Performance / Simmed Bets tabs. --pending picks up exactly the candidates
  // that have no sim data yet.
  if (savedIds.length) {
    try { require('./candidateSim').spawnPending(); }
    catch (e) { logger.warn('aiRuns: could not spawn candidate sim', { message: e.message }); }
  }
  return { runId, strategiesFound: savedIds.length };
}

// ── FILTER REVIEW ────────────────────────────────────────────────────────────

function startFilterReview() {
  const runId = db.prepare(`INSERT INTO ai_runs (run_type, model, prompt_summary) VALUES (?,?,?)`)
    .run('filter_review', MODEL, 'Weekly filter review').lastInsertRowid;
  _doFilterReview(runId).catch(e => {
    logger.error('aiRuns: filter review failed', { runId, message: e.message });
    try { db.prepare(`UPDATE ai_runs SET status='error', completed_at=?, error=? WHERE id=?`)
      .run(new Date().toISOString(), e.message, runId); } catch (_) {}
  });
  return runId;
}

async function _doFilterReview(runId) {
  const allBets = db.prepare(`SELECT b.strategy_name, b.player_key, b.side, b.requested_odds, b.pnl, b.settlement_type, b.placed_at, b.momentum_at_bet, m.surface, m.tournament, m.pre_match_odds_a, m.pre_match_odds_b FROM bets b LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id WHERE b.pnl IS NOT NULL ORDER BY b.placed_at DESC`).all();
  const bfbmFilter = _readJson(path.join(DATA_DIR, 'bfbm_filter.json'), {});
  const labState   = _readJson(path.join(DATA_DIR, 'filter-lab-state.json'), {});
  const existingStrats = _readJson(path.join(CONFIG_DIR, 'strategies.json'), { systems: [] });

  const prompt = `You are a professional sports trading analyst reviewing a tennis betting bot filter performance.

CURRENT BFBM FILTER (the live filter gating which bets get placed):
${JSON.stringify(bfbmFilter, null, 2)}

CURRENT FILTER LAB STATE:
${JSON.stringify(labState, null, 2)}

LIVE STRATEGIES:
${JSON.stringify(existingStrats.systems.map(s => ({ name: s.name, description: s.description })), null, 2)}

ALL SETTLED BETS WITH FULL CONTEXT (${allBets.length} bets):
${JSON.stringify(allBets, null, 2)}

TASK: Review the current filter thresholds against actual bet performance. Provide a thorough, data-driven analysis:
1. For each active filter parameter, assess if it is too tight or too loose
2. Identify specific patterns in losing bets that should be filtered out
3. Identify patterns in winning bets that filters may be excluding
4. Give specific quantified recommendations with evidence

Format your response as markdown with these sections:
## Filter Review — ${new Date().toISOString().slice(0,10)}
### Overall Assessment
### Per-Parameter Analysis
### Recommended Changes (with data evidence)
### Patterns Identified
### Conclusion

These are recommendations only — no automatic changes will be made.`;

  const { text, tokensUsed } = await _callClaude(prompt);
  db.prepare(`UPDATE ai_runs SET status='completed', completed_at=?, tokens_used=?, result=? WHERE id=?`)
    .run(new Date().toISOString(), tokensUsed, text, runId);
  return { runId };
}

module.exports = { startStrategyDiscovery, startFilterReview };
