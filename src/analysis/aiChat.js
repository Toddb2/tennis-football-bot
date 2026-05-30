'use strict';

/**
 * aiChat.js
 *
 * Streaming, multi-turn AI chat for the AI Analysis tab.
 *
 *  - Persists conversations + messages (ai_conversations / ai_messages).
 *  - Streams Claude's reply token-by-token over Server-Sent Events.
 *  - Accepts uploaded file content (CSV/JSON parsed to text) folded into context.
 *  - When Claude calls propose_new_strategy, the strategy is shipped straight to
 *    the Strategy Lab (strategy_lab) as a draft candidate and a backfill sim is
 *    kicked off — exactly the "proposals ship to Strategy Lab" flow.
 *
 * Reuses strategyAnalyser's data builders + chat system prompt (exported there).
 */

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database/db');
const logger = require('../utils/logger');
const sa = require('./strategyAnalyser');

const MODEL = 'claude-opus-4-7';
const MAX_TOKENS = 4096;

// Tool definitions — mirror strategyAnalyser's chat tools so Claude can ship
// fully-formed strategies to the Lab and flag under-performers.
const CHAT_TOOLS = [
  {
    name: 'propose_new_strategy',
    // Schema is FLAT (no nested "strategy" wrapper) — a nested object wrapper made
    // the model mangle the name field (it leaked the internal <parameter> syntax).
    description: 'Propose a new strategy. It is saved to the Strategy Lab as a draft candidate (disabled) and automatically simulated — the user reviews its performance there before promoting to live. Populate every field with concrete values.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short, human-readable Title Case name of 3-5 words. NO codes, underscores or "StratNN" prefixes. e.g. "Clay Tiebreak Underdog Fade". Must be unique.' },
        description: { type: 'string', description: 'One-line plain-English description of when it fires.' },
        filters: {
          type: 'object',
          properties: { surfaces: { type: 'array', items: { type: 'string', enum: ['hard', 'clay', 'grass'] } } },
          required: ['surfaces'],
        },
        staking: { type: 'object', properties: { stakeGBP: { type: 'number' } }, required: ['stakeGBP'] },
        exit: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['none', 'set_result'] },
            setNumber: { type: 'number' },
            hedgeWhen: { type: 'string', enum: ['bet_player_wins_set', 'bet_player_loses_set'] },
          },
          required: ['type'],
        },
        trigger: {
          type: 'object',
          description: 'When the strategy fires. Include setNumber, loserMustBe (A or B), allowedSetScores (winner-loser order e.g. "6-3"), and optionally preMatchOddsWinner/preMatchOddsLoser as { min, max }.',
          properties: {
            setNumber: { type: 'number' },
            loserMustBe: { type: 'string', enum: ['A', 'B'] },
            allowedSetScores: { type: 'array', items: { type: 'string' } },
            preMatchOddsWinner: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } },
            preMatchOddsLoser: { type: 'object', properties: { min: { type: 'number' }, max: { type: 'number' } } },
          },
          required: ['setNumber'],
        },
        entry: {
          type: 'object',
          properties: {
            player: { type: 'string', enum: ['winner', 'loser'] },
            side: { type: 'string', enum: ['BACK', 'LAY'] },
            minOdds: { type: 'number' },
            maxOdds: { type: 'number' },
          },
          required: ['player', 'side', 'minOdds', 'maxOdds'],
        },
        rationale: { type: 'string', description: 'One short sentence explaining why, grounded in the data.' },
      },
      required: ['name', 'description', 'filters', 'staking', 'trigger', 'entry'],
    },
  },
  {
    name: 'propose_disable_strategy',
    description: 'Flag an existing live strategy that the data shows is losing money. This is advisory only — surfaced to the user, no automatic change.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact name of an existing strategy.' },
        reason: { type: 'string', description: 'One short sentence with the data point that justifies disabling.' },
      },
      required: ['name', 'reason'],
    },
  },
];

// ── Context ──────────────────────────────────────────────────────────────────
function _buildDataBlock() {
  const aggregateText = sa.formatForPrompt(sa.buildDataSummary());
  const deepText = sa.formatDeepDataForPrompt(sa.buildDeepData());
  let stratBlock = '';
  try {
    const fs = require('fs');
    const path = require('path');
    const strat = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/strategies.json'), 'utf8'));
    if (Array.isArray(strat.systems)) {
      stratBlock = `\n=== CURRENT STRATEGIES (schema reference + existing entries) ===\n${JSON.stringify(strat.systems, null, 2)}\n`;
    }
  } catch (_) {}
  return aggregateText + '\n' + deepText + stratBlock;
}

// ── Conversation persistence ─────────────────────────────────────────────────
function listConversations() {
  return db.prepare(`
    SELECT c.id, c.title, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM ai_messages m WHERE m.conversation_id = c.id) AS message_count
      FROM ai_conversations c ORDER BY c.updated_at DESC LIMIT 100`).all();
}

function getConversation(id) {
  const conv = db.prepare(`SELECT * FROM ai_conversations WHERE id=?`).get(id);
  if (!conv) return null;
  const messages = db.prepare(`SELECT id, role, content, proposals, attachments, tokens_used, created_at FROM ai_messages WHERE conversation_id=? ORDER BY id`).all(id)
    .map(m => ({ ...m, proposals: _json(m.proposals, []), attachments: _json(m.attachments, []) }));
  return { ...conv, messages };
}

function createConversation(title) {
  const info = db.prepare(`INSERT INTO ai_conversations (title) VALUES (?)`).run(title || 'New conversation');
  return Number(info.lastInsertRowid);
}

function renameConversation(id, title) {
  db.prepare(`UPDATE ai_conversations SET title=? WHERE id=?`).run(title, id);
}

function deleteConversation(id) {
  db.transaction(() => {
    db.prepare(`DELETE FROM ai_messages WHERE conversation_id=?`).run(id);
    db.prepare(`DELETE FROM ai_conversations WHERE id=?`).run(id);
  })();
}

function _json(v, fallback) { try { return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } }
function _now() { return new Date().toISOString(); }

// ── Proposals → Strategy Lab ─────────────────────────────────────────────────
function _saveProposal(p, conversationId) {
  if (p.name !== 'propose_new_strategy') return null;
  const inp = p.input || {};
  if (!inp.name) return null;
  // Assemble the live-shaped strategy config from the flat tool fields.
  const strategy = {
    name:        inp.name,
    description: inp.description || null,
    enabled:     false,                                   // never auto-enable
    filters:     inp.filters || { surfaces: ['hard', 'clay', 'grass'] },
    staking:     inp.staking || { stakeGBP: 1 },
    exit:        inp.exit || { type: 'none' },
    backtest:    { trigger: inp.trigger || {}, entry: inp.entry || {} },
    rationale:   inp.rationale || undefined,
  };
  try {
    const info = db.prepare(`INSERT OR IGNORE INTO strategy_lab (name, description, config, created_by, notes) VALUES (?,?,?,?,?)`)
      .run(strategy.name, strategy.description || inp.rationale || null, JSON.stringify(strategy), 'ai-chat',
           `Proposed in AI chat #${conversationId}`);
    if (info.changes > 0) {
      // Backfill is kicked off once (spawnPending) after the whole turn — see streamChat.
      return { strategyLabId: Number(info.lastInsertRowid), name: strategy.name };
    }
    // Name already existed
    const existing = db.prepare(`SELECT id FROM strategy_lab WHERE name=?`).get(strategy.name);
    return existing ? { strategyLabId: existing.id, name: strategy.name, duplicate: true } : null;
  } catch (e) {
    logger.warn('aiChat: could not save proposal', { message: e.message });
    return null;
  }
}

// ── Streaming chat ───────────────────────────────────────────────────────────
/**
 * Stream a chat turn over SSE. `res` is the Express response (headers not yet sent).
 * body: { conversationId?, message, attachments?: [{name, content}] }
 */
async function streamChat(body, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const sse = (obj) => { res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  if (!apiKey) { sse({ type: 'error', message: 'ANTHROPIC_API_KEY not configured.' }); return res.end(); }
  const message = (body.message || '').trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (!message && !attachments.length) { sse({ type: 'error', message: 'Empty message.' }); return res.end(); }

  // Resolve / create conversation
  let conversationId = body.conversationId ? Number(body.conversationId) : null;
  let isNew = false;
  if (!conversationId || !db.prepare(`SELECT 1 FROM ai_conversations WHERE id=?`).get(conversationId)) {
    conversationId = createConversation(message.slice(0, 60) || 'New conversation');
    isNew = true;
  }
  sse({ type: 'meta', conversationId, isNew });

  // Build Claude message history from stored turns
  const prior = db.prepare(`SELECT role, content FROM ai_messages WHERE conversation_id=? ORDER BY id`).all(conversationId)
    .filter(m => m.content);
  const messages = prior.map(m => ({ role: m.role, content: m.content }));

  // Current user turn: data context (cached) + attachments + question.
  // Text files (CSV/JSON/…) are folded into a text block; PDFs become native
  // document blocks Claude reads directly.
  const pdfAtts  = attachments.filter(a => a.kind === 'pdf' && a.data);
  const textAtts = attachments.filter(a => a.kind !== 'pdf' && a.content != null);
  const attachText = textAtts.map(a => `\n\n=== ATTACHED FILE: ${a.name} ===\n${String(a.content || '').slice(0, 60000)}`).join('');
  let dataBlock;
  try { dataBlock = _buildDataBlock(); }
  catch (e) { sse({ type: 'error', message: 'Data error: ' + e.message }); return res.end(); }

  const content = [{ type: 'text', text: dataBlock, cache_control: { type: 'ephemeral' } }];
  for (const a of pdfAtts) {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } });
  }
  content.push({ type: 'text', text: (attachText ? attachText + '\n\n---\n' : '') + '\n\nQuestion: ' + message });
  messages.push({ role: 'user', content });

  // Persist the user turn now (so it survives even if streaming fails). Store
  // attachment metadata only (name/kind/size) — not the file bytes.
  const attMeta = attachments.map(a => ({
    name: a.name, kind: a.kind || 'text',
    size: a.kind === 'pdf' ? (a.data ? a.data.length : 0) : (a.content || '').length,
  }));
  db.prepare(`INSERT INTO ai_messages (conversation_id, role, content, attachments) VALUES (?,?,?,?)`)
    .run(conversationId, 'user', message, JSON.stringify(attMeta));

  const client = new Anthropic({ apiKey });
  let answer = '';
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: sa.CHAT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: CHAT_TOOLS,
      messages,
    });

    for await (const event of stream) {
      if (aborted) { stream.abort?.(); break; }
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        answer += event.delta.text;
        sse({ type: 'delta', text: event.delta.text });
      }
    }

    const finalMsg = await stream.finalMessage();
    const usage = finalMsg.usage || {};

    // Extract + ship proposals
    const proposals = [];
    for (const block of (finalMsg.content || [])) {
      if (block.type === 'tool_use') {
        const saved = block.name === 'propose_new_strategy' ? _saveProposal(block, conversationId) : null;
        const proposal = {
          kind: block.name,
          input: block.input || {},
          saved,            // { strategyLabId, name } when shipped to the Lab
        };
        proposals.push(proposal);
        sse({ type: 'proposal', proposal });
      }
    }

    // Persist assistant turn
    const info = db.prepare(`INSERT INTO ai_messages (conversation_id, role, content, proposals, tokens_used) VALUES (?,?,?,?,?)`)
      .run(conversationId, 'assistant', answer, JSON.stringify(proposals),
           (usage.input_tokens || 0) + (usage.output_tokens || 0));
    db.prepare(`UPDATE ai_conversations SET updated_at=? WHERE id=?`).run(_now(), conversationId);

    // If any strategies were shipped to the Lab, backfill them all in ONE
    // sequential worker (avoids concurrent-child lock contention).
    if (proposals.some(p => p.saved && p.saved.strategyLabId)) {
      try { require('./candidateSim').spawnPending(); } catch (_) {}
    }

    sse({ type: 'done', conversationId, messageId: Number(info.lastInsertRowid), usage, proposals });
  } catch (e) {
    logger.error('aiChat: stream failed', { conversationId, message: e.message });
    sse({ type: 'error', message: 'Claude API error: ' + e.message });
    // Save whatever we streamed so the turn isn't lost
    if (answer) {
      try { db.prepare(`INSERT INTO ai_messages (conversation_id, role, content) VALUES (?,?,?)`)
        .run(conversationId, 'assistant', answer); } catch (_) {}
    }
  }
  res.end();
}

module.exports = {
  listConversations, getConversation, createConversation, renameConversation, deleteConversation, streamChat,
};
