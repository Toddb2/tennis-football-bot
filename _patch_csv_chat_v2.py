#!/usr/bin/env python3
"""1. Drop all-empty columns from server CSV exports.
   2. Scope AI chat history to the active analysis period (-7d / -30d / -90d / All)."""

# ── 1. server.js — _writeCsv prunes all-empty columns ────────────────────────
SV = '/home/bots/tennis-bot/src/dashboard/server.js'
with open(SV, 'r', encoding='utf-8') as f:
    s = f.read()

old = '''function _writeCsv(res, filename, rows, columns) {
  const header = columns.join(',');
  const body = rows.map(r => columns.map(c => _csvEscape(r[c])).join(',')).join('\\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(header + '\\n' + body + '\\n');
}'''
new = '''function _writeCsv(res, filename, rows, columns) {
  // Drop columns that are empty in every row (e.g. set3 stats when no match has them).
  // Always keep id/key columns even if empty so structure is predictable.
  const KEEP_EMPTY = new Set(['bet_id', 'market_id', 'placed_at', 'strategy', 'match']);
  const keptCols = columns.filter(c => {
    if (KEEP_EMPTY.has(c)) return true;
    return rows.some(r => {
      const v = r[c];
      return v != null && String(v).trim() !== '';
    });
  });
  const header = keptCols.join(',');
  const body = rows.map(r => keptCols.map(c => _csvEscape(r[c])).join(',')).join('\\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(header + '\\n' + body + '\\n');
}'''
if old in s:
    s = s.replace(old, new, 1)
    with open(SV, 'w', encoding='utf-8') as f:
        f.write(s)
    print('1. _writeCsv: prunes all-empty columns')
else:
    print('1. _writeCsv: target not found (already patched?)')

# ── 2. app.js — chat scoped to current period ────────────────────────────────
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

# Replace the localStorage init block + add period-aware key + reload helper
old_block = '''let _aiChatHistory = (function(){
  try { const raw = localStorage.getItem('aiChatHistory'); return raw ? JSON.parse(raw) : []; }
  catch(_) { return []; }
})();
function _saveAiChatHistory() {
  try { localStorage.setItem('aiChatHistory', JSON.stringify(_aiChatHistory.filter(m => m.role !== 'pending'))); } catch(_) {}
}
function clearAiChatHistory() {
  _aiChatHistory = [];
  _saveAiChatHistory();
  _renderAiChat();
}'''
new_block = '''function _aiChatStorageKey() {
  // Bind chat history to the active analysis period (-7 days / -30 days / etc.)
  const period = (typeof _anSince === 'string' && _anSince) ? _anSince : 'default';
  return 'aiChatHistory:' + period;
}
function _loadAiChatForPeriod() {
  try { const raw = localStorage.getItem(_aiChatStorageKey()); _aiChatHistory = raw ? JSON.parse(raw) : []; }
  catch(_) { _aiChatHistory = []; }
}
let _aiChatHistory = [];
_loadAiChatForPeriod();
function _saveAiChatHistory() {
  try { localStorage.setItem(_aiChatStorageKey(), JSON.stringify(_aiChatHistory.filter(m => m.role !== 'pending'))); } catch(_) {}
}
function reloadAiChatForPeriod() {
  _loadAiChatForPeriod();
  _renderAiChat();
}
function clearAiChatHistory() {
  _aiChatHistory = [];
  _saveAiChatHistory();
  _renderAiChat();
}'''
if old_block in s:
    s = s.replace(old_block, new_block, 1)
    print('2a. AI chat history is now period-scoped')
else:
    print('2a. AI chat init block not found')

# Hook into the period-button click handler so the chat reloads when period changes
old_period = '''  document.querySelectorAll('.an-period').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.an-period').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _anSince = btn.dataset.since;
      loadAnalysis();
    });
  });'''
new_period = '''  document.querySelectorAll('.an-period').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.an-period').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _anSince = btn.dataset.since;
      loadAnalysis();
      if (typeof reloadAiChatForPeriod === 'function') reloadAiChatForPeriod();
    });
  });'''
if old_period in s:
    s = s.replace(old_period, new_period, 1)
    print('2b. period button click reloads chat for that period')
else:
    print('2b. period click handler not found')

# Update the empty-state message in the chat panel to mention the period
old_empty = "if (!_aiChatHistory.length) { el.innerHTML = '<div style=\"color:var(--muted);font-size:12px;padding:8px\">Ask anything about your bot performance — losing patterns, serve quality on losses, hedge timing, etc.</div>'; return; }"
new_empty = "if (!_aiChatHistory.length) { const period = (_anSince || '-7 days').replace(/^-/,'last '); el.innerHTML = `<div style=\"color:var(--muted);font-size:12px;padding:8px\">Conversation for <strong>${period}</strong>. Ask anything about your bot — losing patterns, serve quality, hedge timing, etc. Switching periods opens a separate conversation.</div>`; return; }"
if old_empty in s:
    s = s.replace(old_empty, new_empty, 1)
    print('2c. empty-state message references current period')

with open(AP, 'w', encoding='utf-8') as f:
    f.write(s)

print('\nDone.')
