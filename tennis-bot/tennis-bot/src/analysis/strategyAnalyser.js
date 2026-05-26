'use strict';

/**
 * strategyAnalyser.js
 *
 * Queries the SQLite DB for bet performance data, then calls the Claude API
 * to generate natural language insights about strategy profitability.
 *
 * Results are cached for 30 minutes — subsequent dashboard loads are free.
 * Set ANTHROPIC_API_KEY in .env to enable.
 *
 * Model: claude-opus-4-7 with prompt caching on the static system prompt.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const db        = require('../database/db');
const logger    = require('../utils/logger');

const CACHE_TTL_MS   = 30 * 60 * 1000;
const HISTORY_FILE   = path.join(__dirname, '../../data/analysis_history.json');
const HISTORY_MAX    = 20;

let _cache   = null;
let _cacheTs = 0;

// ---------------------------------------------------------------------------
// History persistence
// ---------------------------------------------------------------------------

function _loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (_) {}
  return [];
}

function _appendHistory(result) {
  try {
    const history = _loadHistory();
    history.unshift({
      id:           Date.now(),
      generatedAt:  result.generatedAt,
      analysis:     result.analysis,
      tokenUsage:   result.tokenUsage,
      dataSnapshot: result.dataSnapshot,
    });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    logger.error('strategyAnalyser: failed to write history', { message: err.message });
  }
}

function getHistory() {
  return _loadHistory();
}

// ---------------------------------------------------------------------------
// System prompt — cached by Claude (stable content, changes rarely)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert sports trading analyst specialising in tennis Betfair exchange strategies.

You will receive structured performance data from an automated tennis trading bot and must provide concise, actionable insights.

Your analysis should:
1. Identify which strategies are profitable and which are losing money
2. Spot patterns by surface (clay / hard / grass), odds ranges, and recent trend
3. Call out the specific conditions where each strategy works or fails
4. Give concrete, actionable recommendations to improve profitability
5. Flag any risk concerns (e.g. large drawdown, excessive rejections, small sample size)

Format your response using these exact sections:
## Overall Performance Summary
(3–4 sentences covering the headline numbers)

## Strategy Breakdown
(One paragraph per strategy. End each with a verdict: ✅ KEEP / ⚠️ TUNE / ❌ DROP)

## Surface Analysis
(Brief — which surfaces are working, which are not)

## Actionable Recommendations
(Numbered list, max 5 items — each must be specific and actionable, not generic)

## Risk Flags
(Only include if there are genuine concerns — otherwise omit this section)

Be direct and use the actual numbers from the data. Don't hedge or be vague.`;

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

function _buildDataSummary() {
  // Use 90-day window; if fewer than 20 bets found, widen to all-time so the AI
  // has enough data to say anything meaningful.
  const count90 = db.prepare(`SELECT COUNT(*) AS n FROM bets WHERE placed_at >= datetime('now', '-90 days')`).get().n;
  const window  = count90 >= 20 ? "'-90 days'" : "'-3650 days'";
  const label   = count90 >= 20 ? 'last 90 days' : 'all-time';

  const overall = db.prepare(`
    SELECT
      COUNT(*)                                                         AS total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                       AS wins,
      SUM(CASE WHEN pnl <= 0 AND settled_at IS NOT NULL THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN settled_at IS NULL THEN 1 ELSE 0 END)             AS open,
      ROUND(SUM(COALESCE(pnl, 0)), 2)                                 AS total_pnl,
      ROUND(AVG(requested_odds), 2)                                   AS avg_odds,
      MIN(placed_at)                                                   AS first_bet,
      MAX(placed_at)                                                   AS last_bet
    FROM bets
    WHERE placed_at >= datetime('now', ${window})
  `).get();

  const byStrategy = db.prepare(`
    SELECT
      strategy_name,
      side,
      COUNT(*)                                                               AS count,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                             AS wins,
      SUM(CASE WHEN pnl <= 0 AND settled_at IS NOT NULL THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(COALESCE(pnl, 0)), 2)                                       AS total_pnl,
      ROUND(AVG(requested_odds), 2)                                         AS avg_odds,
      ROUND(MIN(requested_odds), 2)                                         AS min_odds,
      ROUND(MAX(requested_odds), 2)                                         AS max_odds,
      SUM(CASE WHEN dry_run = 0 THEN 1 ELSE 0 END)                         AS live_count,
      ROUND(SUM(CASE WHEN dry_run = 0 THEN COALESCE(pnl,0) ELSE 0 END), 2) AS live_pnl
    FROM bets
    WHERE placed_at >= datetime('now', ${window})
    GROUP BY strategy_name, side
    ORDER BY strategy_name
  `).all();

  const bySurface = db.prepare(`
    SELECT
      COALESCE(NULLIF(m.surface,''), 'unknown')                              AS surface,
      COUNT(*)                                                               AS count,
      SUM(CASE WHEN b.pnl > 0 THEN 1 ELSE 0 END)                           AS wins,
      SUM(CASE WHEN b.pnl <= 0 AND b.settled_at IS NOT NULL THEN 1 ELSE 0 END) AS losses,
      ROUND(SUM(COALESCE(b.pnl, 0)), 2)                                     AS total_pnl
    FROM bets b
    LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
    WHERE b.placed_at >= datetime('now', ${window})
    GROUP BY surface
    ORDER BY count DESC
  `).all();

  const weeklyPnl = db.prepare(`
    SELECT
      strftime('%Y-W%W', placed_at)    AS week,
      COUNT(*)                          AS bets,
      ROUND(SUM(COALESCE(pnl, 0)), 2)  AS pnl
    FROM bets
    WHERE placed_at  >= datetime('now', '-56 days')
      AND settled_at IS NOT NULL
    GROUP BY week
    ORDER BY week ASC
  `).all();

  const rejections = db.prepare(`
    SELECT strategy_name, rejection_stage, COUNT(*) AS count
    FROM bet_rejections
    WHERE ts >= datetime('now', '-30 days')
    GROUP BY strategy_name, rejection_stage
    ORDER BY count DESC
    LIMIT 20
  `).all();

  const dryRunSplit = db.prepare(`
    SELECT
      dry_run,
      COUNT(*) AS count,
      ROUND(SUM(COALESCE(pnl, 0)), 2) AS total_pnl
    FROM bets
    WHERE placed_at >= datetime('now', ${window})
    GROUP BY dry_run
  `).all();

  // Open bets with age so AI can tell if they're genuinely open or just stale
  const openBets = db.prepare(`
    SELECT bet_id, strategy_name, placed_at, requested_odds,
           ROUND((julianday('now') - julianday(placed_at)) * 24, 1) AS hours_open
    FROM bets
    WHERE settled_at IS NULL
    ORDER BY placed_at DESC
    LIMIT 10
  `).all();

  return { overall, byStrategy, bySurface, weeklyPnl, rejections, dryRunSplit, openBets, label };
}

function _formatForPrompt(data) {
  const { overall, byStrategy, bySurface, weeklyPnl, rejections, dryRunSplit, openBets, label } = data;
  const dry   = dryRunSplit.find(r => r.dry_run === 1);
  const live  = dryRunSplit.find(r => r.dry_run === 0);

  const settled = (overall.wins || 0) + (overall.losses || 0);
  const winRate = settled > 0 ? ((overall.wins / settled) * 100).toFixed(1) : '0';

  let txt = `TENNIS BOT STRATEGY PERFORMANCE DATA (${label})\n`;
  txt += `Generated: ${new Date().toISOString()}\n\n`;

  txt += `=== OVERALL ===\n`;
  txt += `Total bets: ${overall.total}  |  Wins: ${overall.wins}  |  Losses: ${overall.losses}  |  Open: ${overall.open}\n`;
  txt += `Win rate (settled): ${winRate}%\n`;
  txt += `Total P&L: £${overall.total_pnl}  |  Avg entry odds: ${overall.avg_odds}\n`;
  if (dry)  txt += `Dry-run: ${dry.count} bets, P&L £${dry.total_pnl}\n`;
  if (live) txt += `Live:    ${live.count} bets, P&L £${live.total_pnl}\n`;
  txt += `Date range: ${overall.first_bet?.split('T')[0] ?? 'N/A'} → ${overall.last_bet?.split('T')[0] ?? 'N/A'}\n\n`;

  txt += `=== BY STRATEGY ===\n`;
  for (const s of byStrategy) {
    const settledS = (s.wins || 0) + (s.losses || 0);
    const wr = settledS > 0 ? ((s.wins / settledS) * 100).toFixed(1) : '0';
    txt += `${s.strategy_name} (${s.side}): ${s.count} bets | ${s.wins}W / ${s.losses}L (${wr}% WR)`;
    txt += ` | P&L £${s.total_pnl} | odds range ${s.min_odds}–${s.max_odds} (avg ${s.avg_odds})`;
    if (s.live_count > 0) txt += ` | Live: ${s.live_count} bets, P&L £${s.live_pnl}`;
    txt += '\n';
  }
  txt += '\n';

  txt += `=== BY SURFACE ===\n`;
  for (const s of bySurface) {
    const settledS = (s.wins || 0) + (s.losses || 0);
    const wr = settledS > 0 ? ((s.wins / settledS) * 100).toFixed(1) : '0';
    txt += `${s.surface}: ${s.count} bets | ${s.wins}W / ${s.losses}L (${wr}% WR) | P&L £${s.total_pnl}\n`;
  }
  txt += '\n';

  if (weeklyPnl.length > 0) {
    txt += `=== WEEKLY P&L TREND (last 8 weeks) ===\n`;
    for (const w of weeklyPnl) {
      const sign = w.pnl >= 0 ? '+' : '';
      txt += `${w.week}: ${w.bets} bets, P&L ${sign}£${w.pnl}\n`;
    }
    txt += '\n';
  }

  if (rejections.length > 0) {
    txt += `=== REJECTION PATTERNS (last 30 days) ===\n`;
    for (const r of rejections) {
      txt += `${r.strategy_name ?? 'unknown'} | ${r.rejection_stage}: ${r.count}x\n`;
    }
    txt += '\n';
  }

  if (openBets && openBets.length > 0) {
    txt += `=== OPEN / UNSETTLED BETS ===\n`;
    for (const b of openBets) {
      txt += `${b.strategy_name ?? 'unknown'} | placed ${b.placed_at?.split('T')[0] ?? '?'} | odds ${b.requested_odds} | open ${b.hours_open}h\n`;
    }
    txt += '\n';
  }

  return txt;
}


// ---------------------------------------------------------------------------
// Deep data context for chat — per-bet + serve stats + set scores
// ---------------------------------------------------------------------------
function _buildDeepData() {
  const settled = db.prepare(`
    SELECT
      b.bet_id, b.strategy_name, b.side, b.player_key, b.player_name,
      b.requested_odds, b.actual_odds, b.stake, b.pnl, b.dry_run,
      b.placed_at, b.settled_at, b.settlement_type, b.reason, b.exit_config,
      b.hedge_odds,
      m.match_name, m.surface, m.tournament,
      m.pre_match_odds_a, m.pre_match_odds_b,
      m.player_a_name, m.player_b_name,
      (SELECT s.sets FROM market_snapshots s
        WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at
        ORDER BY s.ts DESC LIMIT 1) AS sets_at_entry,
      (SELECT s.serve_stats FROM market_snapshots s
        WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at
        ORDER BY s.ts DESC LIMIT 1) AS serve_at_entry,
      (SELECT s.serve_stats FROM market_snapshots s
        WHERE s.betfair_market_id = b.betfair_market_id
        ORDER BY s.ts DESC LIMIT 1) AS serve_final,
      (SELECT s.sets FROM market_snapshots s
        WHERE s.betfair_market_id = b.betfair_market_id
        ORDER BY s.ts DESC LIMIT 1) AS sets_final
    FROM bets b
    LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
    WHERE b.placed_at >= datetime('now', '-90 days')
    ORDER BY b.placed_at DESC
    LIMIT 300
  `).all();

  // Parse JSON columns; trim large fields to keep prompt size sensible
  for (const r of settled) {
    if (typeof r.sets_at_entry === 'string') { try { r.sets_at_entry = JSON.parse(r.sets_at_entry); } catch (_) {} }
    if (typeof r.sets_final    === 'string') { try { r.sets_final    = JSON.parse(r.sets_final);    } catch (_) {} }
    if (typeof r.serve_at_entry === 'string') { try { r.serve_at_entry = JSON.parse(r.serve_at_entry); } catch (_) {} }
    if (typeof r.serve_final   === 'string') { try { r.serve_final   = JSON.parse(r.serve_final);   } catch (_) {} }
    if (typeof r.exit_config   === 'string') { try { r.exit_config   = JSON.parse(r.exit_config);   } catch (_) {} }
  }
  return settled;
}

function _formatDeepDataForPrompt(deep) {
  // Compact text — one bet per line followed by serve stats block when present
  let txt = `=== DETAILED BET RECORDS (last 90d, max 300 most recent) ===\n`;
  for (const b of deep) {
    const date = (b.placed_at || '').split('T')[0];
    const result = b.pnl == null ? 'OPEN' : (b.pnl > 0 ? `WIN +£${b.pnl.toFixed(2)}` : `LOSS £${b.pnl.toFixed(2)}`);
    txt += `\n[${date}] ${b.strategy_name || '?'} ${b.side || ''} on ${b.player_name || '?'} @${b.requested_odds ?? '?'}`;
    txt += ` | ${b.match_name || '?'} (${b.surface || '?'})`;
    txt += ` | PM: ${b.pre_match_odds_a?.toFixed?.(2) || '?'}/${b.pre_match_odds_b?.toFixed?.(2) || '?'}`;
    txt += ` | ${result}${b.dry_run ? ' (DRY)' : ''}`;
    if (b.hedge_odds != null) txt += ` | hedge@${b.hedge_odds}`;
    if (b.sets_at_entry) txt += ` | sets@entry: ${JSON.stringify(b.sets_at_entry)}`;
    if (b.sets_final && JSON.stringify(b.sets_final) !== JSON.stringify(b.sets_at_entry)) txt += ` | final sets: ${JSON.stringify(b.sets_final)}`;
    if (b.reason) txt += `\n  signal: ${b.reason}`;
    const ss = b.serve_at_entry || b.serve_final;
    if (ss) {
      const fmt = p => p ? `1stIn:${p.firstServeIn ?? '?'} 1stWon:${p.firstServeWon ?? '?'} 2ndWon:${p.secondServeWon ?? '?'} A:${p.aces ?? 0} DF:${p.doubleFaults ?? 0}` : '?';
      if (ss.match)  txt += `\n  serve(match): A=[${fmt(ss.match.playerA)}] B=[${fmt(ss.match.playerB)}]`;
      if (ss.set1)   txt += `\n  serve(set1):  A=[${fmt(ss.set1.playerA)}] B=[${fmt(ss.set1.playerB)}]`;
      if (ss.set2)   txt += `\n  serve(set2):  A=[${fmt(ss.set2.playerA)}] B=[${fmt(ss.set2.playerB)}]`;
      if (ss.set3)   txt += `\n  serve(set3):  A=[${fmt(ss.set3.playerA)}] B=[${fmt(ss.set3.playerB)}]`;
    }
  }
  return txt + '\n';
}

const CHAT_SYSTEM = `You are an expert tennis trading analyst with full read access to a Betfair tennis bot's bet history, including per-bet match data, set scores at entry, final set scores, hedge prices, and per-set serve stats (1st serve in/won %, 2nd serve won %, aces, double faults).

Style:
- Write in plain, conversational English. No filler, no hedging, no "Sure, here's..." preambles.
- Lead with the headline finding in a single sentence, then explain.
- Use short paragraphs and bullet lists. AVOID large markdown tables — they render poorly. If you must compare items, use a tight bulleted list with one bullet per item.
- Quote actual numbers, dates and player names from the data so the user can verify.
- Group findings under simple bold labels (e.g. **Pattern 1: …**) rather than nested headings.
- End with a short "What to do" section listing 2-4 concrete filter or rule changes the user could test, each in one line.

If the data is insufficient to answer, say so directly in one sentence and stop. Never invent data.`;

async function chat({ question, history = [] }) {
  if (!question || typeof question !== 'string') {
    return { error: 'question required' };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured.' };

  let aggregateText, deepText, currentStrategies;
  try {
    const aggregate = _buildDataSummary();
    aggregateText = _formatForPrompt(aggregate);
    const deep = _buildDeepData();
    deepText = _formatDeepDataForPrompt(deep);
    // Read current strategies.json so the AI knows the schema and what already exists
    const stratPath = require('path').join(__dirname, '../../config/strategies.json');
    try { currentStrategies = JSON.parse(require('fs').readFileSync(stratPath, 'utf8')); }
    catch (_) { currentStrategies = null; }
  } catch (err) {
    return { error: 'DB error: ' + err.message };
  }

  const stratBlock = currentStrategies && Array.isArray(currentStrategies.systems)
    ? `\n=== CURRENT STRATEGIES (config/strategies.json schema reference + existing entries) ===\n${JSON.stringify(currentStrategies.systems, null, 2)}\n`
    : '';
  const dataBlock = aggregateText + '\n' + deepText + stratBlock;

  const tools = [
    {
      name: 'propose_new_strategy',
      description: 'Propose adding a new strategy to config/strategies.json. The user must click Apply for the change to take effect — never assume it has been added. The strategy object MUST be fully populated using the same shape as the entries in CURRENT STRATEGIES — do not return an empty object. Every required field below must be supplied with a concrete value, not left blank.',
      input_schema: {
        type: 'object',
        properties: {
          strategy: {
            type: 'object',
            description: 'Full strategy spec. Mirror the schema of an existing entry in CURRENT STRATEGIES exactly.',
            properties: {
              name: { type: 'string', description: 'Unique strategy name, e.g. Strat2h_serveFiltered. Must not already exist.' },
              description: { type: 'string', description: 'One-line plain-English description of when it fires.' },
              enabled: { type: 'boolean', description: 'Will be forced to false by the server, but include it.' },
              filters: {
                type: 'object',
                properties: {
                  surfaces: { type: 'array', items: { type: 'string', enum: ['hard','clay','grass'] } },
                },
                required: ['surfaces'],
              },
              staking: {
                type: 'object',
                properties: { stakeGBP: { type: 'number' } },
                required: ['stakeGBP'],
              },
              exit: {
                type: 'object',
                description: 'Exit/hedge rule. Use { type: "none" } for no hedge, or { type: "set_result", setNumber, hedgeWhen } for set-end hedge.',
                properties: {
                  type: { type: 'string', enum: ['none','set_result'] },
                  setNumber: { type: 'number' },
                  hedgeWhen: { type: 'string', enum: ['bet_player_wins_set','bet_player_loses_set'] },
                },
                required: ['type'],
              },
              backtest: {
                type: 'object',
                properties: {
                  trigger: {
                    type: 'object',
                    description: 'When the strategy fires. Include setNumber, loserMustBe (A or B), allowedSetScores, and EITHER preMatchOddsWinner or preMatchOddsLoser as { min, max }. Optionally add serve filters: minBackPlayerFirstWonSet1, maxOpponentFirstWonSet1, minBackPlayerSecondWonSet1, etc.',
                    properties: {
                      setNumber: { type: 'number' },
                      loserMustBe: { type: 'string', enum: ['A','B'] },
                      allowedSetScores: { type: 'array', items: { type: 'string' } },
                      preMatchOddsWinner: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } },
                      preMatchOddsLoser:  { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } },
                    },
                    required: ['setNumber'],
                  },
                  entry: {
                    type: 'object',
                    properties: {
                      player: { type: 'string', enum: ['winner','loser'] },
                      side: { type: 'string', enum: ['BACK','LAY'] },
                      minOdds: { type: 'number' },
                      maxOdds: { type: 'number' },
                    },
                    required: ['player','side','minOdds','maxOdds'],
                  },
                  exit: {
                    type: 'object',
                    properties: { type: { type: 'string' } },
                  },
                },
                required: ['trigger','entry'],
              },
            },
            required: ['name','description','enabled','filters','staking','exit','backtest'],
          },
          rationale: {
            type: 'string',
            description: 'One short sentence explaining why this strategy is being proposed, grounded in the data shown.',
          },
        },
        required: ['strategy', 'rationale'],
      },
    },
    {
      name: 'propose_disable_strategy',
      description: 'Propose disabling an existing strategy by name. The user must click Apply. Only use when the data clearly shows the strategy is losing money or behaving badly.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact name of an existing strategy as listed in CURRENT STRATEGIES.' },
          reason: { type: 'string', description: 'One short sentence with the data point that justifies disabling.' },
        },
        required: ['name', 'reason'],
      },
    },
  ];

  const client = new Anthropic({ apiKey });
  const messages = [];
  for (const m of history) {
    if (m && m.role && m.content) messages.push({ role: m.role, content: m.content });
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: dataBlock, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n---\n\nQuestion: ' + question },
    ],
  });

  try {
    const resp = await client.messages.create({
      model:      'claude-opus-4-7',
      max_tokens: 2048,
      system: [{ type: 'text', text: CHAT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools,
      messages,
    });

    // Extract text + any tool_use blocks
    let text = '';
    const proposals = [];
    for (const block of (resp.content || [])) {
      if (block.type === 'text') text += block.text || '';
      else if (block.type === 'tool_use') proposals.push({ name: block.name, input: block.input || {}, id: block.id });
    }

    return {
      answer: text || (proposals.length ? '_(I prepared proposals — see the cards below.)_' : '(no response)'),
      proposals,
      generatedAt: new Date().toISOString(),
      tokenUsage: resp.usage || {},
    };
  } catch (err) {
    return { error: 'Claude API error: ' + err.message };
  }
}


// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

async function runAnalysis({ forceRefresh = false } = {}) {
  const now = Date.now();

  if (!forceRefresh && _cache && (now - _cacheTs) < CACHE_TTL_MS) {
    return { ..._cache, fromCache: true };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      error: 'ANTHROPIC_API_KEY not configured. Add it to /home/bots/tennis-bot/.env to enable AI analysis.',
    };
  }

  let data;
  try {
    data = _buildDataSummary();
  } catch (err) {
    logger.error('strategyAnalyser: DB query failed', { message: err.message });
    return { error: `Database error: ${err.message}` };
  }

  if ((data.overall.total || 0) === 0) {
    return {
      error: 'No bet data found in the last 90 days. Place some bets (or dry-run bets) first.',
    };
  }

  const client = new Anthropic({ apiKey });
  const dataPrompt = _formatForPrompt(data);

  logger.info('strategyAnalyser: starting Claude analysis', {
    bets: data.overall.total,
    strategies: data.byStrategy.length,
  });

  try {
    const stream = client.messages.stream({
      model:      'claude-opus-4-7',
      max_tokens: 2048,
      system: [
        {
          type:          'text',
          text:          SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },  // cache the static system prompt
        },
      ],
      messages: [
        {
          role:    'user',
          content: `Please analyse this tennis trading bot performance data and provide actionable insights:\n\n${dataPrompt}`,
        },
      ],
    });

    let analysis = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        analysis += event.delta.text;
      }
    }

    const finalMsg  = await stream.finalMessage();
    const usage     = finalMsg.usage || {};

    logger.info('strategyAnalyser: analysis complete', {
      inputTokens:  usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheRead:    usage.cache_read_input_tokens,
      cacheWrite:   usage.cache_creation_input_tokens,
    });

    const result = {
      analysis,
      generatedAt: new Date().toISOString(),
      tokenUsage:  usage,
      dataSnapshot: {
        totalBets:  data.overall.total,
        totalPnl:   data.overall.total_pnl,
        strategies: data.byStrategy.length,
      },
    };

    _cache   = result;
    _cacheTs = now;
    _appendHistory(result);
    return result;

  } catch (err) {
    logger.error('strategyAnalyser: Claude API error', { message: err.message });
    return { error: `Claude API error: ${err.message}` };
  }
}

function getCached() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) return _cache;
  return null;
}

module.exports = { runAnalysis, getHistory, getCached, chat };
