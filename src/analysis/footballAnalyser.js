'use strict';

/**
 * footballAnalyser.js
 *
 * Queries bets.json + sportmonks_live.json for football bot performance data,
 * then calls the Claude API for natural-language insights.
 *
 * Results are cached for 30 minutes.
 * Set ANTHROPIC_API_KEY in .env to enable.
 *
 * Model: claude-opus-4-7 with prompt caching on the static system prompt.
 */

const Anthropic = require('@anthropic-ai/sdk');
const fs        = require('fs');
const path      = require('path');
const logger    = require('../utils/logger');

const CACHE_TTL_MS   = 30 * 60 * 1000;
const BETS_FILE      = '/home/bots/telegram-listener/bets.json';
const SM_LIVE_FILE   = '/home/bots/telegram-listener/sportmonks_live.json';
const HISTORY_FILE   = path.join(__dirname, '../../data/football_analysis_history.json');
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
    logger.error('footballAnalyser: failed to write history', { message: err.message });
  }
}

function getHistory() {
  return _loadHistory();
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert football trading analyst specialising in Over/Under goals markets on Betfair exchange via the CBB (Cloud Bet Bot) platform.

You will receive structured performance data from an automated football trading bot that monitors:
- Over/Under 0.5, 1.5 and 2.5 goals markets
- Three scanner systems: BFBM (Betfair Bet Matcher), InPlayGuru, and SportMonks momentum data
- Live match momentum statistics: xG, Pressure Index, Dangerous Attacks, Shots on Target

Your analysis should:
1. Identify which strategies (SystemA/B/C + market combos) are profitable and which are losing
2. Spot patterns by market (0.5/1.5/2.5), time of bet placement, and odds ranges
3. Highlight any correlation between SportMonks live stats (xG, pressure) and bet outcomes
4. Give concrete, actionable recommendations to improve profitability
5. Flag risk concerns (drawdown, strike rate collapse, small sample issues)

Format your response using these exact sections:
## Overall Performance Summary
(3–4 sentences — headline numbers, total P&L, strike rate)

## Strategy & Market Breakdown
(One paragraph per SystemA/B/C or market. End each with a verdict: ✅ KEEP / ⚠️ TUNE / ❌ DROP)

## Timing Analysis
(When during matches are bets being placed — early, mid, late? What's working?)

## SportMonks Signal Analysis
(If SportMonks data available: which momentum signals correlate with wins)

## Actionable Recommendations
(Numbered list, max 5 items — specific and actionable)

## Risk Flags
(Only include if genuine concerns exist — otherwise omit)

Be direct and use the actual numbers from the data. Don't hedge or be vague.`;

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

function _buildDataSummary() {
  let bets = [];
  try {
    if (fs.existsSync(BETS_FILE)) {
      bets = JSON.parse(fs.readFileSync(BETS_FILE, 'utf8'));
    }
  } catch (err) {
    throw new Error(`Cannot read bets.json: ${err.message}`);
  }

  // Filter to settled bets in last 90 days
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const settled = bets.filter(b => {
    if (b.result === 'pending' || !b.result) return false;
    if (!b.placedAt) return false;
    return new Date(b.placedAt) >= cutoff;
  });

  if (!settled.length) return null;

  // Overall stats
  const won  = settled.filter(b => b.result === 'won').length;
  const lost = settled.filter(b => b.result === 'lost').length;
  const totalPl = settled.reduce((a, b) => a + (b.avePoints ?? 0), 0);
  const oddsArr = settled.filter(b => b.overOdds != null).map(b => b.overOdds);
  const avgOdds = oddsArr.length ? oddsArr.reduce((a, b) => a + b, 0) / oddsArr.length : null;

  // By strategy
  const byStrategy = {};
  for (const b of settled) {
    const key = b.strategy || 'unknown';
    if (!byStrategy[key]) byStrategy[key] = { won: 0, lost: 0, pl: 0, odds: [] };
    if (b.result === 'won') byStrategy[key].won++;
    if (b.result === 'lost') byStrategy[key].lost++;
    byStrategy[key].pl += b.avePoints ?? 0;
    if (b.overOdds != null) byStrategy[key].odds.push(b.overOdds);
  }

  // By market
  const byMarket = {};
  for (const b of settled) {
    const key = `O/U ${b.overUnderValue || '?'}`;
    if (!byMarket[key]) byMarket[key] = { won: 0, lost: 0, pl: 0 };
    if (b.result === 'won') byMarket[key].won++;
    if (b.result === 'lost') byMarket[key].lost++;
    byMarket[key].pl += b.avePoints ?? 0;
  }

  // By timer bucket (match minute)
  const byTimer = { 'Pre-match / 0-15': { won:0,lost:0 }, '16-35': { won:0,lost:0 }, '36-60': { won:0,lost:0 }, '61-80': { won:0,lost:0 }, '81+': { won:0,lost:0 } };
  for (const b of settled) {
    const t = b.timer ?? b.goals ?? null;
    if (t == null) continue;
    const bucket = t <= 15 ? 'Pre-match / 0-15' : t <= 35 ? '16-35' : t <= 60 ? '36-60' : t <= 80 ? '61-80' : '81+';
    if (b.result === 'won') byTimer[bucket].won++;
    if (b.result === 'lost') byTimer[bucket].lost++;
  }

  // By goals at signal
  const byGoals = {};
  for (const b of settled) {
    const g = b.goals ?? (b.goalsA != null ? b.goalsA + b.goalsB : null);
    if (g == null) continue;
    const key = `${g} goals`;
    if (!byGoals[key]) byGoals[key] = { won:0, lost:0 };
    if (b.result === 'won') byGoals[key].won++;
    if (b.result === 'lost') byGoals[key].lost++;
  }

  // SportMonks signals
  let smSignals = [];
  try {
    if (fs.existsSync(SM_LIVE_FILE)) {
      const sm = JSON.parse(fs.readFileSync(SM_LIVE_FILE, 'utf8'));
      smSignals = sm.signalsFired || [];
    }
  } catch (_) {}

  // SportMonks signal bets (bets tagged with signalStrategy)
  const smBets = settled.filter(b => b.signalStrategy);
  const smByStrategy = {};
  for (const b of smBets) {
    const key = b.signalStrategy;
    if (!smByStrategy[key]) smByStrategy[key] = { won:0, lost:0, pl:0 };
    if (b.result === 'won') smByStrategy[key].won++;
    if (b.result === 'lost') smByStrategy[key].lost++;
    smByStrategy[key].pl += b.avePoints ?? 0;
  }

  return {
    totalSettled: settled.length,
    won, lost,
    totalPl: parseFloat(totalPl.toFixed(2)),
    avgOdds: avgOdds ? parseFloat(avgOdds.toFixed(2)) : null,
    dateRange: {
      first: settled.reduce((a, b) => a < b.placedAt ? a : b.placedAt, settled[0].placedAt),
      last:  settled.reduce((a, b) => a > b.placedAt ? a : b.placedAt, settled[0].placedAt),
    },
    byStrategy,
    byMarket,
    byTimer,
    byGoals,
    smSignals: smSignals.slice(0, 50),
    smByStrategy,
    dryRunCount: settled.filter(b => b.dryRun).length,
    liveCount:   settled.filter(b => !b.dryRun).length,
  };
}

function _formatForPrompt(data) {
  const sr = data.won + data.lost > 0 ? ((data.won / (data.won + data.lost)) * 100).toFixed(1) : '0';
  let txt = `FOOTBALL BOT PERFORMANCE DATA (last 90 days)\nGenerated: ${new Date().toISOString()}\n\n`;

  txt += `=== OVERALL ===\n`;
  txt += `Settled bets: ${data.totalSettled}  |  Won: ${data.won}  |  Lost: ${data.lost}  |  Strike Rate: ${sr}%\n`;
  txt += `Total P&L: ${data.totalPl >= 0 ? '+' : ''}${data.totalPl} pts  |  Avg entry odds: ${data.avgOdds ?? 'N/A'}\n`;
  txt += `Live bets: ${data.liveCount}  |  Dry-run bets: ${data.dryRunCount}\n`;
  txt += `Date range: ${data.dateRange.first?.split('T')[0] ?? 'N/A'} → ${data.dateRange.last?.split('T')[0] ?? 'N/A'}\n\n`;

  txt += `=== BY STRATEGY ===\n`;
  for (const [key, s] of Object.entries(data.byStrategy).sort((a, b) => b[1].pl - a[1].pl)) {
    const ss = s.won + s.lost;
    const wr = ss > 0 ? ((s.won / ss) * 100).toFixed(1) : '0';
    const avg = s.odds.length ? (s.odds.reduce((a, b) => a + b, 0) / s.odds.length).toFixed(2) : 'N/A';
    txt += `${key}: ${ss} bets | ${s.won}W / ${s.lost}L (${wr}% WR) | P&L ${s.pl >= 0 ? '+' : ''}${s.pl.toFixed(2)}pts | Avg odds ${avg}\n`;
  }
  txt += '\n';

  txt += `=== BY MARKET ===\n`;
  for (const [key, m] of Object.entries(data.byMarket)) {
    const ms = m.won + m.lost;
    const wr = ms > 0 ? ((m.won / ms) * 100).toFixed(1) : '0';
    txt += `${key}: ${ms} bets | ${m.won}W / ${m.lost}L (${wr}% WR) | P&L ${m.pl >= 0 ? '+' : ''}${m.pl.toFixed(2)}pts\n`;
  }
  txt += '\n';

  txt += `=== BY MATCH MINUTE (when bet placed) ===\n`;
  for (const [bucket, t] of Object.entries(data.byTimer)) {
    const ts = t.won + t.lost;
    if (!ts) continue;
    const wr = ((t.won / ts) * 100).toFixed(1);
    txt += `${bucket}: ${ts} bets | ${t.won}W / ${t.lost}L (${wr}% WR)\n`;
  }
  txt += '\n';

  if (Object.keys(data.byGoals).length > 0) {
    txt += `=== BY GOALS AT SIGNAL ===\n`;
    for (const [key, g] of Object.entries(data.byGoals).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
      const gs = g.won + g.lost;
      const wr = ((g.won / gs) * 100).toFixed(1);
      txt += `${key}: ${gs} bets | ${g.won}W / ${g.lost}L (${wr}% WR)\n`;
    }
    txt += '\n';
  }

  if (Object.keys(data.smByStrategy).length > 0) {
    txt += `=== SPORTMONKS SIGNAL BETS ===\n`;
    for (const [key, s] of Object.entries(data.smByStrategy)) {
      const ss = s.won + s.lost;
      const wr = ss > 0 ? ((s.won / ss) * 100).toFixed(1) : '0';
      txt += `${key}: ${ss} bets | ${s.won}W / ${s.lost}L (${wr}% WR) | P&L ${s.pl >= 0 ? '+' : ''}${s.pl.toFixed(2)}pts\n`;
    }
    txt += '\n';
  }

  if (data.smSignals.length > 0) {
    txt += `=== RECENT SPORTMONKS SIGNALS FIRED (last ${data.smSignals.length}) ===\n`;
    const signalCounts = {};
    for (const s of data.smSignals) {
      signalCounts[s.strategy] = (signalCounts[s.strategy] || 0) + 1;
    }
    for (const [k, v] of Object.entries(signalCounts)) {
      txt += `${k}: ${v} signals\n`;
    }
    txt += '\n';
  }

  return txt;
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
    return { error: 'ANTHROPIC_API_KEY not configured.' };
  }

  let data;
  try {
    data = _buildDataSummary();
  } catch (err) {
    logger.error('footballAnalyser: data build failed', { message: err.message });
    return { error: `Data error: ${err.message}` };
  }

  if (!data) {
    return { error: 'No settled bets found in the last 90 days.' };
  }

  const client = new Anthropic({ apiKey });
  const dataPrompt = _formatForPrompt(data);

  logger.info('footballAnalyser: starting Claude analysis', {
    bets: data.totalSettled,
  });

  try {
    const stream = client.messages.stream({
      model:      'claude-opus-4-7',
      max_tokens: 2048,
      system: [
        {
          type:          'text',
          text:          SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role:    'user',
          content: `Please analyse this football trading bot performance data and provide actionable insights:\n\n${dataPrompt}`,
        },
      ],
    });

    let analysis = '';
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        analysis += event.delta.text;
      }
    }

    const finalMsg = await stream.finalMessage();
    const usage    = finalMsg.usage || {};

    logger.info('footballAnalyser: analysis complete', {
      inputTokens:  usage.input_tokens,
      outputTokens: usage.output_tokens,
    });

    const result = {
      analysis,
      generatedAt: new Date().toISOString(),
      tokenUsage:  usage,
      dataSnapshot: {
        totalBets: data.totalSettled,
        totalPl:   data.totalPl,
        won:       data.won,
        lost:      data.lost,
      },
    };

    _cache   = result;
    _cacheTs = now;
    _appendHistory(result);
    return result;

  } catch (err) {
    logger.error('footballAnalyser: Claude API error', { message: err.message });
    return { error: `Claude API error: ${err.message}` };
  }
}

function getCached() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) return _cache;
  return null;
}

module.exports = { runAnalysis, getHistory, getCached };
