#!/usr/bin/env python3
"""Tennis dashboard Phase B:
  1. Bet-detail dropdown: render historical per-set serve stats from latest snapshot
  2. Auto-load Market Scanner + Entry Data when their sub-tab is opened
  3. CSV export buttons on Bets table + Market Scanner
"""
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
IX = '/home/bots/tennis-bot/src/dashboard/public/index.html'

with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

# ── 1. Add historical serve-stats placeholder to _buildBetDetail ──────────────
# Insert <div id="${prefix}-srv-${mid}"></div> placeholder right above the milestones div
old_marker = '<div class="mdi-milestones" id="${prefix}-ms-${mid}" style="display:none"></div>'
new_marker = '<div class="mdi-historical-serve" id="${prefix}-srv-${mid}" style="margin:0 16px 14px"></div>\n  ' + old_marker
if old_marker in s and 'mdi-historical-serve' not in s:
    s = s.replace(old_marker, new_marker, 1)
    print('1a. _buildBetDetail: serve placeholder added')
else:
    print('1a. _buildBetDetail: already patched or marker missing')

# ── 1b. After loadMatchCharts fetches snaps, render historical serve stats ──
# Insert serve-stats render after `if (!snaps.length) return;`
old_b = "    if (!snaps.length) return;\n\n    const [nA, nB] = (m?.matchName"
new_b = '''    if (!snaps.length) return;

    // ── Historical per-set serve stats from latest snapshot ──────────────
    try {
      const srvEl = document.getElementById(`${prefix}-srv-${marketId}`);
      if (srvEl) {
        const latest = snaps[snaps.length - 1];
        let ss = latest && latest.serve_stats;
        if (typeof ss === 'string') { try { ss = JSON.parse(ss); } catch(_) { ss = null; } }
        if (ss && (ss.match || ss.set1 || ss.set2)) {
          const [nameA, nameB] = (m?.matchName || '').split(' v ').map(t => t.trim());
          const fmtPct = v => v != null ? (typeof v === 'number' ? v.toFixed(1) + '%' : v) : '—';
          const num = v => v != null ? v : '—';
          const block = (label, a, b) => {
            if (!a && !b) return '';
            a = a || {}; b = b || {};
            return `<div class="mdi-subtitle">${label}</div>
              <div class="det-kv"><span class="det-k">1st serve in</span><span class="det-v">${fmtPct(a.firstServeIn)} / ${fmtPct(b.firstServeIn)}</span></div>
              <div class="det-kv"><span class="det-k">1st serve won</span><span class="det-v">${fmtPct(a.firstServeWon)} / ${fmtPct(b.firstServeWon)}</span></div>
              <div class="det-kv"><span class="det-k">2nd serve won</span><span class="det-v">${fmtPct(a.secondServeWon)} / ${fmtPct(b.secondServeWon)}</span></div>
              <div class="det-kv"><span class="det-k">Aces</span><span class="det-v">${num(a.aces)} / ${num(b.aces)}</span></div>
              <div class="det-kv"><span class="det-k">Double faults</span><span class="det-v">${num(a.doubleFaults)} / ${num(b.doubleFaults)}</span></div>`;
          };
          srvEl.innerHTML = `<div class="mdi-section">
            <div class="mdi-title">Historical Serve Stats (${nameA || 'A'} / ${nameB || 'B'})</div>
            ${block('Match', ss.match?.playerA, ss.match?.playerB)}
            ${ss.set1 ? block('Set 1', ss.set1.playerA, ss.set1.playerB) : ''}
            ${ss.set2 ? block('Set 2', ss.set2.playerA, ss.set2.playerB) : ''}
            ${ss.set3 ? block('Set 3', ss.set3.playerA, ss.set3.playerB) : ''}
          </div>`;
        }
      }
    } catch (_) {}

    const [nA, nB] = (m?.matchName'''
if old_b in s:
    s = s.replace(old_b, new_b, 1)
    print('1b. loadMatchCharts: historical serve stats render injected')
else:
    print('1b. loadMatchCharts: anchor not found')

# ── 2. Auto-load on Market Scanner / Entry Data sub-tab switch ────────────────
old_st = (
    "function switchAnSubtab(name) {\n"
    "  _anSubtab = name;\n"
    "  ['overview', 'scanner', 'entry'].forEach(id => {\n"
    "    $('an-sub-' + id).style.display = id === name ? '' : 'none';\n"
    "  });\n"
    "  document.querySelectorAll('.an-subtab-btn').forEach(b => {\n"
    "    const active = b.dataset.subtab === name;\n"
    "    b.style.color       = active ? 'var(--blue)' : 'var(--muted)';\n"
    "    b.style.borderBottom = active ? '2px solid var(--blue)' : '2px solid transparent';\n"
    "  });\n"
    "}"
)
new_st = (
    "function switchAnSubtab(name) {\n"
    "  _anSubtab = name;\n"
    "  ['overview', 'scanner', 'entry'].forEach(id => {\n"
    "    $('an-sub-' + id).style.display = id === name ? '' : 'none';\n"
    "  });\n"
    "  document.querySelectorAll('.an-subtab-btn').forEach(b => {\n"
    "    const active = b.dataset.subtab === name;\n"
    "    b.style.color       = active ? 'var(--blue)' : 'var(--muted)';\n"
    "    b.style.borderBottom = active ? '2px solid var(--blue)' : '2px solid transparent';\n"
    "  });\n"
    "  // Auto-load when first opened (no need to click Load)\n"
    "  if (name === 'scanner' && !_scannerRows.length) loadMarketScanner();\n"
    "  if (name === 'entry'   && !_entryData)         loadEntryData();\n"
    "}"
)
if old_st in s:
    s = s.replace(old_st, new_st, 1)
    print('2. switchAnSubtab: auto-load enabled')
else:
    print('2. switchAnSubtab: not patched')

# ── 3a. CSV export — Bets table ──────────────────────────────────────────────
# Inject helpers + wire button below renderBetsTable
csv_helpers_marker = "function _renderBetSysStats(rows, strategies) {"
if 'function exportBetsCsv' not in s:
    csv_block = '''function _csvEsc(v) {
  if (v == null) return '';
  const str = String(v);
  return /["\\n,]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function exportBetsCsv() {
  const rows = (S.bets || []);
  if (!rows.length) { alert('No bets to export'); return; }
  const cols = [
    'bet_id','strategy_name','match_name','surface','tournament','player_name','side',
    'requested_odds','actual_odds','stake','liability','size_matched',
    'pnl','settlement_type','dry_run','hedge_odds',
    'placed_at','settled_at','reason','exit_config','latest_sets','betfair_market_id'
  ];
  const out = [cols.join(',')];
  for (const r of rows) out.push(cols.map(c => _csvEsc(r[c])).join(','));
  const blob = new Blob([out.join('\\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tennis-bets-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportScannerCsv() {
  if (!_scannerRows.length) { alert('No scanner rows to export'); return; }
  const cols = ['went_in_play_at','match_name','surface','player_a_name','player_b_name',
    'pre_match_odds_a','pre_match_odds_b','s1_end_odds_a','s1_end_odds_b','s2_end_odds_a','s2_end_odds_b',
    'winner','peak_volume','betfair_market_id'];
  const out = [cols.join(',')];
  for (const r of _scannerRows) out.push(cols.map(c => _csvEsc(r[c])).join(','));
  const blob = new Blob([out.join('\\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `market-scanner-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

'''
    s = s.replace(csv_helpers_marker, csv_block + csv_helpers_marker, 1)
    print('3a. exportBetsCsv + exportScannerCsv helpers added')

with open(AP, 'w', encoding='utf-8') as f:
    f.write(s)

# ── 3b. index.html: add CSV buttons ──────────────────────────────────────────
with open(IX, 'r', encoding='utf-8') as f:
    h = f.read()

# Bets tab CSV button — add near bets-refresh
if 'bets-csv-btn' not in h:
    h = h.replace(
        '<button class="btn btn-sm" id="bets-refresh">Refresh</button>',
        '<button class="btn btn-sm" id="bets-refresh">Refresh</button>\n      <button class="btn btn-sm" id="bets-csv-btn" onclick="exportBetsCsv()">⬇ CSV</button>',
        1
    )
    print('3b. bets CSV button added')

# Scanner CSV button
if 'an-scanner-csv-btn' not in h:
    h = h.replace(
        '<button class="btn btn-sm" id="an-scanner-load-btn">Load / Refresh</button>',
        '<button class="btn btn-sm" id="an-scanner-csv-btn" onclick="exportScannerCsv()">⬇ CSV</button>\n      <button class="btn btn-sm" id="an-scanner-load-btn">Load / Refresh</button>',
        1
    )
    print('3b. scanner CSV button added')

with open(IX, 'w', encoding='utf-8') as f:
    f.write(h)

print('\nDone. Hard-refresh browser to pick up changes.')
