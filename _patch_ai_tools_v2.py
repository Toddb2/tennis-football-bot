#!/usr/bin/env python3
"""Tighten propose_new_strategy schema so Claude must fill the full strategy object.
Also: render partial proposals more gracefully (show what we got, not just '?')."""

# ── 1. strategyAnalyser.js — full required schema ───────────────────────────
SA = '/home/bots/tennis-bot/src/analysis/strategyAnalyser.js'
with open(SA, 'r', encoding='utf-8') as f:
    s = f.read()

# Replace the propose_new_strategy tool definition
import re
m = re.search(r"\{\s*name:\s*'propose_new_strategy',[\s\S]*?required:\s*\['strategy',\s*'rationale'\],\s*\},\s*\}", s)
if m:
    new_tool = """{
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
    }"""
    s = s[:m.start()] + new_tool + s[m.end():]
    with open(SA, 'w', encoding='utf-8') as f:
        f.write(s)
    print('1. tool schema tightened — strategy fields are now required')
else:
    print('1. tool block not found')

# ── 2. app.js — render partial proposals more gracefully ────────────────────
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

# Replace the propose_new_strategy card rendering
old = '''  if (p.name === 'propose_new_strategy') {
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
  }'''
new = '''  if (p.name === 'propose_new_strategy') {
    const strat = p.input?.strategy || {};
    const rat = p.input?.rationale || '';
    const hasContent = strat && Object.keys(strat).length > 0 && strat.name;
    const json = JSON.stringify(strat, null, 2);
    window[stamp] = { proposal: p, idx };
    if (!hasContent) {
      // Claude returned the tool call but didn't fill the strategy object.
      return `<div style="margin-top:10px;padding:10px;background:var(--surface);border:1px solid var(--red);border-radius:8px">
        <div style="font-size:11px;font-weight:700;color:var(--red);margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Proposal incomplete</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Claude proposed a strategy but didn't fill the spec fields. Ask again, e.g. "give me the full strategy JSON ready to apply (name, filters, staking, exit, backtest.trigger, backtest.entry)".</div>
        ${rat ? `<div style="font-size:12px;color:var(--text);margin-bottom:6px"><em>Rationale Claude provided:</em> ${rat.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')}</div>` : ''}
        <button class="btn btn-sm" onclick="_rejectAiProposal('${stamp}')">Dismiss</button>
      </div>`;
    }
    return `<div style="margin-top:10px;padding:10px;background:var(--surface);border:1px solid var(--border);border-radius:8px">
      <div style="font-size:11px;font-weight:700;color:var(--orange);margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px">Proposed: New strategy "${strat.name}"</div>
      ${strat.description ? `<div style="font-size:12px;color:var(--text);margin-bottom:6px">${String(strat.description).replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')}</div>` : ''}
      ${rat ? `<div style="font-size:11px;color:var(--muted);margin-bottom:8px"><em>Why:</em> ${String(rat).replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')}</div>` : ''}
      <pre style="background:var(--surface2);padding:8px;border-radius:5px;overflow-x:auto;font-size:11px;line-height:1.4;max-height:280px">${json.replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;')}</pre>
      <div style="font-size:10px;color:var(--muted);margin:6px 0">Will be added with <strong>enabled: false</strong>. Enable manually on the Strategies tab when ready.</div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="btn btn-sm btn-primary" onclick="_applyAiProposal('${stamp}')">Apply</button>
        <button class="btn btn-sm" onclick="_rejectAiProposal('${stamp}')">Dismiss</button>
      </div>
    </div>`;
  }'''
if old in s:
    s = s.replace(old, new, 1)
    with open(AP, 'w', encoding='utf-8') as f:
        f.write(s)
    print('2. proposal card: graceful handling when Claude returns empty input')
else:
    print('2. proposal card not found')

print('\nDone.')
