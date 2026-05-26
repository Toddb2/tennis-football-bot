#!/usr/bin/env python3
"""CSV polish + chat persistence:
  1. Fix _formatSets to read playerA/playerB (was using s.a/s.b)
  2. Round volume + final_volume + final_momentum + odds to clean dp
  3. Rename scanner serve prefix 'match' → 'final' (was producing match_match_*)
  4. localStorage persistence for AI chat
"""
SV = '/home/bots/tennis-bot/src/dashboard/server.js'
with open(SV, 'r', encoding='utf-8') as f:
    s = f.read()

# 1. _formatSets: support both shapes
old_fs = '''function _formatSets(setsJson) {
  // Convert [{a:6,b:4},{a:3,b:6}] → "6-4 3-6"
  if (!Array.isArray(setsJson)) return '';
  return setsJson.map(s => `${s.a ?? '?'}-${s.b ?? '?'}`).join(' ');
}'''
new_fs = '''function _formatSets(setsJson) {
  // Tennis sets in SQLite are stored as [{playerA:6,playerB:4}, ...]
  // — older code/tests sometimes used a/b keys, so support both.
  if (!Array.isArray(setsJson)) return '';
  return setsJson
    .map(s => {
      const a = s.playerA ?? s.a;
      const b = s.playerB ?? s.b;
      if (a == null && b == null) return '';
      return `${a ?? '?'}-${b ?? '?'}`;
    })
    .filter(Boolean)
    .join(' ');
}'''
if old_fs in s:
    s = s.replace(old_fs, new_fs, 1)
    print('1. _formatSets fixed (playerA/playerB keys)')
else:
    print('1. _formatSets unchanged (already patched?)')

# 2. Add round helper + apply to numeric fields in flatteners
if 'function _round2(' not in s:
    s = s.replace(
        'function _csvEscape(v) {',
        'function _round2(v) { return v == null || isNaN(v) ? v : Math.round(v * 100) / 100; }\nfunction _csvEscape(v) {'
    )
    print('2a. _round2 helper added')

# Apply rounding to bets CSV
s = s.replace(
    "momentum_at_entry: r.momentum_at_entry,\n        final_volume: r.final_volume,",
    "momentum_at_entry: _round2(r.momentum_at_entry),\n        final_volume: _round2(r.final_volume),"
)
s = s.replace(
    "pre_match_odds_a: r.pre_match_odds_a,\n        pre_match_odds_b: r.pre_match_odds_b,\n        requested_odds: r.requested_odds,\n        actual_odds: r.actual_odds,\n        stake: r.stake,\n        size_matched: r.size_matched,\n        liability: r.liability,\n        hedge_odds: r.hedge_odds,\n        pnl: r.pnl,",
    "pre_match_odds_a: _round2(r.pre_match_odds_a),\n        pre_match_odds_b: _round2(r.pre_match_odds_b),\n        requested_odds: _round2(r.requested_odds),\n        actual_odds: _round2(r.actual_odds),\n        stake: _round2(r.stake),\n        size_matched: _round2(r.size_matched),\n        liability: _round2(r.liability),\n        hedge_odds: _round2(r.hedge_odds),\n        pnl: _round2(r.pnl),"
)
print('2b. bets numeric rounding applied')

# Scanner — rename match→final prefix + round numerics
s = s.replace(
    "winner: r.winner,\n        peak_volume: r.peak_volume,\n        final_volume: last?.matched_volume,\n        final_momentum: last?.momentum_index,\n        pre_match_odds_a: r.pre_match_odds_a,\n        pre_match_odds_b: r.pre_match_odds_b,\n        s1_end_odds_a: r.s1_end_odds_a,\n        s1_end_odds_b: r.s1_end_odds_b,\n        s2_end_odds_a: r.s2_end_odds_a,\n        s2_end_odds_b: r.s2_end_odds_b,\n        sets_final: _formatSets(sets),\n        market_id: r.betfair_market_id,\n        ..._flatServe('match', ss),",
    "winner: r.winner,\n        peak_volume: _round2(r.peak_volume),\n        final_volume: _round2(last?.matched_volume),\n        final_momentum: _round2(last?.momentum_index),\n        pre_match_odds_a: _round2(r.pre_match_odds_a),\n        pre_match_odds_b: _round2(r.pre_match_odds_b),\n        s1_end_odds_a: _round2(r.s1_end_odds_a),\n        s1_end_odds_b: _round2(r.s1_end_odds_b),\n        s2_end_odds_a: _round2(r.s2_end_odds_a),\n        s2_end_odds_b: _round2(r.s2_end_odds_b),\n        sets_final: _formatSets(sets),\n        market_id: r.betfair_market_id,\n        ..._flatServe('final', ss),"
)
print('3. scanner: rounding + prefix match→final')

# Entry CSV — round odds + pnl
s = s.replace(
    "pre_match_odds_a: r.pre_match_odds_a,\n        pre_match_odds_b: r.pre_match_odds_b,\n        sets_at_entry: _formatSets(setsE),\n        sets_final: _formatSets(setsF),\n        side: r.side,\n        bet_player_key: r.player_key,\n        bet_player_name: r.player_name,\n        requested_odds: r.requested_odds,\n        actual_odds: r.actual_odds,\n        stake: r.stake,\n        hedge_odds: r.hedge_odds,\n        pnl: r.pnl,",
    "pre_match_odds_a: _round2(r.pre_match_odds_a),\n        pre_match_odds_b: _round2(r.pre_match_odds_b),\n        sets_at_entry: _formatSets(setsE),\n        sets_final: _formatSets(setsF),\n        side: r.side,\n        bet_player_key: r.player_key,\n        bet_player_name: r.player_name,\n        requested_odds: _round2(r.requested_odds),\n        actual_odds: _round2(r.actual_odds),\n        stake: _round2(r.stake),\n        hedge_odds: _round2(r.hedge_odds),\n        pnl: _round2(r.pnl),"
)
print('4. entry-data rounding applied')

with open(SV, 'w', encoding='utf-8') as f:
    f.write(s)

# 5. AI chat persistence — wrap _aiChatHistory operations with localStorage save/load
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

old_init = "let _aiChatHistory = [];"
new_init = '''let _aiChatHistory = (function(){
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
if old_init in s and 'function _saveAiChatHistory' not in s:
    s = s.replace(old_init, new_init, 1)
    print('5a. AI chat: localStorage load + save helpers added')

# Save after every push in sendAiChat. Replace the two key lines.
s = s.replace(
    "  _aiChatHistory.push({ role: 'user', content: q });\n  _aiChatHistory.push({ role: 'pending' });\n  _renderAiChat();",
    "  _aiChatHistory.push({ role: 'user', content: q });\n  _saveAiChatHistory();\n  _aiChatHistory.push({ role: 'pending' });\n  _renderAiChat();"
)
s = s.replace(
    "  btn.disabled = false; btn.textContent = 'Ask';\n  _renderAiChat();\n}",
    "  _saveAiChatHistory();\n  btn.disabled = false; btn.textContent = 'Ask';\n  _renderAiChat();\n}"
)
print('5b. sendAiChat: persists after each turn')

with open(AP, 'w', encoding='utf-8') as f:
    f.write(s)

print('\nAll done.')
