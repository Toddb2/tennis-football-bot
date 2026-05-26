#!/usr/bin/env python3
"""AI tool use for strategy proposals:
  - strategyAnalyser.chat: defines two tools; returns proposals alongside answer
  - server.js: POST /api/strategies/add and POST /api/strategies/disable
  - app.js: render proposal cards with Apply button in chat
"""

# ── 1. strategyAnalyser.js — add tools ───────────────────────────────────────
SA = '/home/bots/tennis-bot/src/analysis/strategyAnalyser.js'
with open(SA, 'r', encoding='utf-8') as f:
    s = f.read()

if 'propose_new_strategy' not in s:
    # Find chat() function and replace its body
    import re
    m = re.search(r'async function chat\(\{ question, history = \[\] \}\) \{[\s\S]*?\n\}\n', s)
    if not m:
        raise SystemExit('chat() not found')

    new_chat = r'''async function chat({ question, history = [] }) {
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
      description: 'Propose adding a new strategy to config/strategies.json. The user must click Apply for the change to take effect — never assume it has been added. Use the same schema as existing entries in CURRENT STRATEGIES. Set enabled:false by default unless the user explicitly asks to enable it.',
      input_schema: {
        type: 'object',
        properties: {
          strategy: {
            type: 'object',
            description: 'Full strategy object matching the schema of existing entries (name, description, enabled, filters, staking, exit, backtest with trigger+entry).',
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
'''
    s = s[:m.start()] + new_chat + s[m.end():]
    with open(SA, 'w', encoding='utf-8') as f:
        f.write(s)
    print('1. strategyAnalyser.chat: tools added, returns proposals')
else:
    print('1. strategyAnalyser: tools already present')

# ── 2. server.js — strategy add + disable endpoints ──────────────────────────
SV = '/home/bots/tennis-bot/src/dashboard/server.js'
with open(SV, 'r', encoding='utf-8') as f:
    s = f.read()

if '/api/strategies/add' not in s:
    s = s.replace(
        "app.put('/api/config/strategies', apiPutStrategies);",
        "app.put('/api/config/strategies', apiPutStrategies);\n"
        "    app.post('/api/strategies/add',     apiPostStrategyAdd);\n"
        "    app.post('/api/strategies/disable', apiPostStrategyDisable);"
    )

    handlers = '''
function apiPostStrategyAdd(req, res) {
  try {
    const proposed = req.body?.strategy;
    if (!proposed || typeof proposed !== 'object' || !proposed.name) {
      return res.status(400).json({ error: 'strategy object with .name required' });
    }
    const cfg = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf8'));
    cfg.systems = cfg.systems || [];
    if (cfg.systems.some(s => s.name === proposed.name)) {
      return res.status(409).json({ error: `Strategy '${proposed.name}' already exists` });
    }
    // Force-disabled on first add — user enables manually on Strategies tab
    proposed.enabled = false;
    cfg.systems.push(proposed);
    const errors = validateConfig(cfg);
    if (errors.length) return res.status(422).json({ error: 'Validation failed', errors });
    const tmp = STRATEGIES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, STRATEGIES_PATH);
    logger.info('Dashboard: strategy added via AI proposal', { name: proposed.name });
    broadcast('strategies_updated', { systems: cfg.systems.map(s => s.name) });
    res.json({ ok: true, name: proposed.name, enabled: false });
  } catch (err) {
    logger.error('apiPostStrategyAdd', { message: err.message });
    res.status(500).json({ error: err.message });
  }
}

function apiPostStrategyDisable(req, res) {
  try {
    const name = req.body?.name;
    if (!name) return res.status(400).json({ error: 'name required' });
    const cfg = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf8'));
    const sys = (cfg.systems || []).find(s => s.name === name);
    if (!sys) return res.status(404).json({ error: `Strategy '${name}' not found` });
    if (sys.enabled === false) return res.json({ ok: true, name, alreadyDisabled: true });
    sys.enabled = false;
    const tmp = STRATEGIES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, STRATEGIES_PATH);
    logger.info('Dashboard: strategy disabled via AI proposal', { name });
    broadcast('strategies_updated', { systems: cfg.systems.map(s => s.name) });
    res.json({ ok: true, name });
  } catch (err) {
    logger.error('apiPostStrategyDisable', { message: err.message });
    res.status(500).json({ error: err.message });
  }
}

'''
    s = s.replace('function apiPutStrategies', handlers + '\nfunction apiPutStrategies', 1)
    with open(SV, 'w', encoding='utf-8') as f:
        f.write(s)
    print('2. server.js: /api/strategies/add and /disable added')
else:
    print('2. server.js: endpoints already present')

# ── 3. app.js — render proposals + Apply buttons in chat ─────────────────────
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

if '_renderAiProposal' not in s:
    # Update sendAiChat: persist `proposals` alongside content
    s = s.replace(
        "      _aiChatHistory.push({ role: 'assistant', content: out.answer || '(no response)' });",
        "      _aiChatHistory.push({ role: 'assistant', content: out.answer || '(no response)', proposals: out.proposals || [] });"
    )

    # Patch _renderAiChat to render proposals
    s = s.replace(
        "if (m.role === 'assistant') {\n      const html = _aiMarkdown(m.content);\n      return `<div style=\"margin:8px 0;padding:8px 12px;background:rgba(79,142,247,.06);border-radius:8px;border-left:3px solid #d2a8ff\"><div style=\"font-size:10px;font-weight:700;color:#d2a8ff;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px\">Claude</div><div>${html}</div></div>`;\n    }",
        "if (m.role === 'assistant') {\n      const html = _aiMarkdown(m.content);\n      const props = (m.proposals || []).map((p, i) => _renderAiProposal(p, i)).join('');\n      return `<div style=\"margin:8px 0;padding:8px 12px;background:rgba(79,142,247,.06);border-radius:8px;border-left:3px solid #d2a8ff\"><div style=\"font-size:10px;font-weight:700;color:#d2a8ff;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px\">Claude</div><div>${html}</div>${props}</div>`;\n    }"
    )

    helpers = r'''
function _renderAiProposal(p, idx) {
  if (!p || !p.name) return '';
  const stamp = `_aiProp_${Date.now()}_${idx}`;
  if (p.applied) {
    return `<div style="margin-top:8px;padding:8px 10px;background:rgba(63,185,80,.1);border:1px solid var(--green);border-radius:6px;font-size:12px;color:var(--green)">✓ Applied: ${p.appliedMsg || p.name}</div>`;
  }
  if (p.rejected) {
    return `<div style="margin-top:8px;padding:8px 10px;background:rgba(248,81,73,.08);border:1px solid var(--red);border-radius:6px;font-size:12px;color:var(--muted)">✗ Rejected proposal: ${p.name}</div>`;
  }
  if (p.name === 'propose_new_strategy') {
    const strat = p.input?.strategy || {};
    const rat = p.input?.rationale || '';
    const json = JSON.stringify(strat, null, 2);
    window[stamp] = { proposal: p, idx };
    return `<div style="margin-top:10px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:8px">
      <div style="font-size:11px;font-weight:700;color:var(--orange);margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Proposed: New strategy "${strat.name || '?'}"</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px">${rat}</div>
      <pre style="background:var(--surface2);padding:8px;border-radius:5px;overflow-x:auto;font-size:11px;line-height:1.4;max-height:240px">${json.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')}</pre>
      <div style="font-size:10px;color:var(--muted);margin:6px 0">Will be added with <strong>enabled: false</strong>. Enable manually on the Strategies tab when ready.</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-sm btn-primary" onclick="_applyAiProposal('${stamp}')">Apply</button>
        <button class="btn btn-sm" onclick="_rejectAiProposal('${stamp}')">Dismiss</button>
      </div>
    </div>`;
  }
  if (p.name === 'propose_disable_strategy') {
    const target = p.input?.name || '?';
    const reason = p.input?.reason || '';
    window[stamp] = { proposal: p, idx };
    return `<div style="margin-top:10px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:8px">
      <div style="font-size:11px;font-weight:700;color:var(--red);margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Proposed: Disable "${target}"</div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px">${reason}</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-sm btn-danger" onclick="_applyAiProposal('${stamp}')">Apply (disable)</button>
        <button class="btn btn-sm" onclick="_rejectAiProposal('${stamp}')">Dismiss</button>
      </div>
    </div>`;
  }
  return '';
}

async function _applyAiProposal(stampKey) {
  const ref = window[stampKey];
  if (!ref) return;
  const { proposal } = ref;
  try {
    let url, body;
    if (proposal.name === 'propose_new_strategy') {
      url = '/api/strategies/add';
      body = { strategy: proposal.input.strategy };
    } else if (proposal.name === 'propose_disable_strategy') {
      url = '/api/strategies/disable';
      body = { name: proposal.input.name };
    } else { return; }
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
    proposal.applied = true;
    proposal.appliedMsg = proposal.name === 'propose_new_strategy'
      ? `Strategy '${proposal.input.strategy.name}' added (disabled — enable on Strategies tab)`
      : `Strategy '${proposal.input.name}' disabled`;
    _saveAiChatHistory();
    _renderAiChat();
  } catch (e) {
    alert('Apply failed: ' + e.message);
  }
}
function _rejectAiProposal(stampKey) {
  const ref = window[stampKey];
  if (!ref) return;
  ref.proposal.rejected = true;
  _saveAiChatHistory();
  _renderAiChat();
}
'''
    # Insert helpers before sendAiChat (if present) else before _aiMarkdown
    anchor = 'async function sendAiChat'
    if anchor in s:
        s = s.replace(anchor, helpers + '\n' + anchor, 1)
    else:
        s += helpers
    with open(AP, 'w', encoding='utf-8') as f:
        f.write(s)
    print('3. app.js: proposal render + Apply/Dismiss handlers added')
else:
    print('3. app.js: proposal handlers already present')

print('\nAll done.')
