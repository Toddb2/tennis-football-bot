#!/usr/bin/env python3
"""Tennis dashboard Phase C — AI chat overhaul:
  1. strategyAnalyser.js: add chat() function with deep per-bet/serve data context + cached data block
  2. server.js: add POST /api/analysis/chat
  3. index.html: add chat input + transcript at the bottom of the AI tab
  4. app.js: wire chat send + render
"""

# ── 1. strategyAnalyser.js — add deep data builder + chat() ───────────────────
SA = '/home/bots/tennis-bot/src/analysis/strategyAnalyser.js'
with open(SA, 'r', encoding='utf-8') as f:
    s = f.read()

if 'async function chat' not in s:
    chat_block = r'''
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

When asked a question, ground your answer in the data provided. Quote specific numbers, bet IDs, dates, and matches when relevant. If the data doesn't contain enough information, say so clearly rather than guessing. Use markdown for clarity (headers, bullet lists, tables) when it helps. Be direct and concise — no filler.`;

async function chat({ question, history = [] }) {
  if (!question || typeof question !== 'string') {
    return { error: 'question required' };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: 'ANTHROPIC_API_KEY not configured.' };

  let aggregateText, deepText;
  try {
    const aggregate = _buildDataSummary();
    aggregateText = _formatForPrompt(aggregate);
    const deep = _buildDeepData();
    deepText = _formatDeepDataForPrompt(deep);
  } catch (err) {
    return { error: 'DB error: ' + err.message };
  }

  const dataBlock = aggregateText + '\n' + deepText;
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
      messages,
    });
    const text = (resp.content || []).map(c => c.text || '').join('');
    return {
      answer: text,
      generatedAt: new Date().toISOString(),
      tokenUsage: resp.usage || {},
    };
  } catch (err) {
    return { error: 'Claude API error: ' + err.message };
  }
}

'''
    # Insert chat block above runAnalysis
    s = s.replace(
        '// ---------------------------------------------------------------------------\n// Main export\n// ---------------------------------------------------------------------------\n\nasync function runAnalysis',
        chat_block + '\n// ---------------------------------------------------------------------------\n// Main export\n// ---------------------------------------------------------------------------\n\nasync function runAnalysis',
        1
    )
    s = s.replace(
        'module.exports = { runAnalysis, getHistory, getCached };',
        'module.exports = { runAnalysis, getHistory, getCached, chat };'
    )
    with open(SA, 'w', encoding='utf-8') as f:
        f.write(s)
    print('1. strategyAnalyser.js: chat() + deep data context added')
else:
    print('1. strategyAnalyser.js: already patched')

# ── 2. server.js — POST /api/analysis/chat ────────────────────────────────────
SV = '/home/bots/tennis-bot/src/dashboard/server.js'
with open(SV, 'r', encoding='utf-8') as f:
    s = f.read()

if '/api/analysis/chat' not in s:
    s = s.replace(
        "app.get('/api/analysis/history',             apiGetAnalysisHistory);",
        "app.get('/api/analysis/history',             apiGetAnalysisHistory);\n"
        "    app.post('/api/analysis/chat',                apiPostAnalysisChat);"
    )
    handler = '''
function apiPostAnalysisChat(req, res) {
  Promise.resolve()
    .then(() => strategyAnalyser.chat({ question: req.body?.question, history: req.body?.history }))
    .then(out => res.json(out))
    .catch(err => res.status(500).json({ error: err.message }));
}
'''
    # Append handler near the other analysis handlers; place before module.exports if any, else at end of file
    s = s.replace(
        'function apiGetAnalysisHistory',
        handler + '\nfunction apiGetAnalysisHistory'
    )
    with open(SV, 'w', encoding='utf-8') as f:
        f.write(s)
    print('2. server.js: /api/analysis/chat route registered')
else:
    print('2. server.js: chat route already present')

# ── 3. index.html — add chat panel inside AI tab ──────────────────────────────
IX = '/home/bots/tennis-bot/src/dashboard/public/index.html'
with open(IX, 'r', encoding='utf-8') as f:
    h = f.read()

if 'ai-chat-panel' not in h:
    chat_html = '''
      <!-- Chat panel (free-text Q&A with full data context) -->
      <div id="ai-chat-panel" class="card" style="margin-top:16px;padding:14px">
        <div class="card-title" style="margin-bottom:10px">Ask AI a question</div>
        <div id="ai-chat-transcript" style="max-height:480px;overflow-y:auto;font-size:13px;line-height:1.5;margin-bottom:10px"></div>
        <div style="display:flex;gap:8px">
          <textarea id="ai-chat-input" rows="2" placeholder="e.g. Which strategies have the worst Set 2 serve performance? Are losing bets concentrated on hard courts?" style="flex:1;background:var(--surface2);border:1px solid var(--border);color:var(--text);padding:8px 10px;border-radius:6px;font-family:inherit;font-size:13px;resize:vertical"></textarea>
          <button class="btn btn-primary btn-sm" id="ai-chat-send" onclick="sendAiChat()" style="align-self:flex-end">Ask</button>
        </div>
        <div style="font-size:10px;color:var(--muted);margin-top:6px">Has access to all bet data, per-set serve stats, hedge prices, and final scores for the last 90 days.</div>
      </div>
'''
    h = h.replace(
        '<!-- Token footer -->\n      <div id="ai-token-info" class="ai-token-footer" style="display:none"></div>',
        '<!-- Token footer -->\n      <div id="ai-token-info" class="ai-token-footer" style="display:none"></div>' + chat_html,
        1
    )
    with open(IX, 'w', encoding='utf-8') as f:
        f.write(h)
    print('3. index.html: AI chat panel added')
else:
    print('3. index.html: chat panel already present')

# ── 4. app.js — chat send/render ──────────────────────────────────────────────
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

if 'function sendAiChat' not in s:
    chat_js = '''
// ── AI Chat ──────────────────────────────────────────────────────────────
let _aiChatHistory = [];
function _renderAiChat() {
  const el = document.getElementById('ai-chat-transcript');
  if (!el) return;
  if (!_aiChatHistory.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px">Ask anything about your bot performance — losing patterns, serve quality on losses, hedge timing, etc.</div>'; return; }
  el.innerHTML = _aiChatHistory.map(m => {
    if (m.role === 'user') {
      return `<div style="margin:8px 0;padding:8px 12px;background:var(--surface2);border-radius:8px;border-left:3px solid var(--blue)"><div style="font-size:10px;font-weight:700;color:var(--blue);margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">You</div><div style="white-space:pre-wrap">${m.content.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')}</div></div>`;
    }
    if (m.role === 'assistant') {
      const html = _aiMarkdown(m.content);
      return `<div style="margin:8px 0;padding:8px 12px;background:rgba(79,142,247,.06);border-radius:8px;border-left:3px solid #d2a8ff"><div style="font-size:10px;font-weight:700;color:#d2a8ff;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Claude</div><div>${html}</div></div>`;
    }
    if (m.role === 'pending') {
      return `<div style="margin:8px 0;padding:8px 12px;background:rgba(79,142,247,.04);border-radius:8px;color:var(--muted);font-size:12px"><span class="spinner"></span> Thinking…</div>`;
    }
    return '';
  }).join('');
  el.scrollTop = el.scrollHeight;
}
function _aiMarkdown(text) {
  // Tiny markdown: headers, bold, italic, code, lists, paragraphs
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;');
  html = html.replace(/```([\\s\\S]*?)```/g, (_, c) => `<pre style="background:var(--surface2);padding:8px;border-radius:5px;overflow-x:auto;font-size:11px">${c}</pre>`);
  html = html.replace(/`([^`\\n]+)`/g, '<code style="background:var(--surface2);padding:1px 5px;border-radius:3px;font-size:12px">$1</code>');
  html = html.replace(/^### (.*)$/gm, '<h4 style="font-size:13px;margin:10px 0 4px;color:var(--text)">$1</h4>');
  html = html.replace(/^## (.*)$/gm, '<h3 style="font-size:14px;margin:12px 0 6px;color:var(--text)">$1</h3>');
  html = html.replace(/^# (.*)$/gm, '<h2 style="font-size:15px;margin:14px 0 8px;color:var(--text)">$1</h2>');
  html = html.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\\*)\\*([^\\*\\n]+)\\*(?!\\*)/g, '<em>$1</em>');
  // simple bullet lists
  html = html.replace(/(^|\\n)((?:[-*]\\s.+\\n?)+)/g, (m, lead, block) => {
    const items = block.trim().split(/\\n/).map(l => l.replace(/^[-*]\\s+/, '').trim()).filter(Boolean).map(li => `<li>${li}</li>`).join('');
    return lead + `<ul style="margin:4px 0 4px 18px">${items}</ul>`;
  });
  html = html.split(/\\n{2,}/).map(p => /^<(h\\d|ul|pre)/.test(p.trim()) ? p : `<p style="margin:6px 0">${p}</p>`).join('');
  return html;
}
async function sendAiChat() {
  const inp = document.getElementById('ai-chat-input');
  const btn = document.getElementById('ai-chat-send');
  const q = (inp.value || '').trim();
  if (!q) return;
  inp.value = '';
  _aiChatHistory.push({ role: 'user', content: q });
  _aiChatHistory.push({ role: 'pending' });
  _renderAiChat();
  btn.disabled = true; btn.textContent = '…';
  try {
    // Strip pending from history sent to server; send only role/content alternation
    const histToSend = _aiChatHistory.filter(m => m.role === 'user' || m.role === 'assistant').slice(0, -1);
    const resp = await fetch('/api/analysis/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, history: histToSend }) });
    const out = await resp.json();
    // Replace pending with answer/error
    _aiChatHistory.pop();
    if (out.error) {
      _aiChatHistory.push({ role: 'assistant', content: `**Error:** ${out.error}` });
    } else {
      _aiChatHistory.push({ role: 'assistant', content: out.answer || '(no response)' });
    }
  } catch (e) {
    _aiChatHistory.pop();
    _aiChatHistory.push({ role: 'assistant', content: `**Error:** ${e.message}` });
  }
  btn.disabled = false; btn.textContent = 'Ask';
  _renderAiChat();
}
// Submit on Cmd/Ctrl+Enter
document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('ai-chat-input');
  if (inp) inp.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); sendAiChat(); } });
  _renderAiChat();
});
'''
    s += chat_js
    with open(AP, 'w', encoding='utf-8') as f:
        f.write(s)
    print('4. app.js: AI chat client added')
else:
    print('4. app.js: chat client already present')

print('\nAll done.')
