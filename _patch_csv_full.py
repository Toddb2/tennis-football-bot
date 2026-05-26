#!/usr/bin/env python3
"""Server-side CSV exports with full match + per-set serve stats.
   Replaces clipboard/inline-CSV with proper file downloads."""

# ── 1. server.js — three CSV endpoints ───────────────────────────────────────
SV = '/home/bots/tennis-bot/src/dashboard/server.js'
with open(SV, 'r', encoding='utf-8') as f:
    s = f.read()

if '/api/db/bets/csv' not in s:
    # Register routes alongside existing ones
    s = s.replace(
        "app.get('/api/db/market-scanner',               apiDbMarketScanner);",
        "app.get('/api/db/market-scanner',               apiDbMarketScanner);\n"
        "    app.get('/api/db/bets/csv',                    apiDbBetsCsv);\n"
        "    app.get('/api/db/market-scanner/csv',          apiDbScannerCsv);\n"
        "    app.get('/api/db/bets/entry-data/csv',         apiDbEntryDataCsv);"
    )

    helpers = r'''
// ── CSV export helpers ───────────────────────────────────────────────────────
function _csvEscape(v) {
  if (v == null) return '';
  if (typeof v === 'object') v = JSON.stringify(v);
  const str = String(v);
  return /["\n,]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}
function _parseJson(v) {
  if (v == null || typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
}
function _flatServe(prefix, ss) {
  // ss is the parsed serve_stats JSON: { match:{playerA,playerB}, set1:{...}, set2:{...}, set3:{...} }
  const out = {};
  const blocks = ['match', 'set1', 'set2', 'set3'];
  const fields = ['firstServeIn', 'firstServeWon', 'secondServeWon', 'aces', 'doubleFaults'];
  for (const blk of blocks) {
    const b = ss?.[blk] || {};
    for (const side of ['A', 'B']) {
      const p = side === 'A' ? b.playerA : b.playerB;
      for (const f of fields) {
        out[`${prefix}_${blk}_${side}_${f}`] = p?.[f] ?? '';
      }
    }
  }
  return out;
}
function _formatSets(setsJson) {
  // Convert [{a:6,b:4},{a:3,b:6}] → "6-4 3-6"
  if (!Array.isArray(setsJson)) return '';
  return setsJson.map(s => `${s.a ?? '?'}-${s.b ?? '?'}`).join(' ');
}
function _writeCsv(res, filename, rows, columns) {
  const header = columns.join(',');
  const body = rows.map(r => columns.map(c => _csvEscape(r[c])).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(header + '\n' + body + '\n');
}

function apiDbBetsCsv(req, res) {
  try {
    const since = req.query.since || '-90 days';
    const rows = db.prepare(`
      SELECT
        b.bet_id, b.strategy_name, b.side, b.player_key, b.player_name,
        b.requested_odds, b.actual_odds, b.stake, b.size_matched, b.liability,
        b.pnl, b.settlement_type, b.dry_run, b.hedge_odds, b.reason, b.exit_config,
        b.placed_at, b.settled_at, b.betfair_market_id,
        m.match_name, m.surface, m.tournament,
        m.player_a_name, m.player_b_name,
        m.pre_match_odds_a, m.pre_match_odds_b,
        (SELECT s.sets        FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at ORDER BY s.ts DESC LIMIT 1) AS sets_at_entry,
        (SELECT s.serve_stats FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at ORDER BY s.ts DESC LIMIT 1) AS serve_at_entry,
        (SELECT s.sets        FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id ORDER BY s.ts DESC LIMIT 1) AS sets_final,
        (SELECT s.serve_stats FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id ORDER BY s.ts DESC LIMIT 1) AS serve_final,
        (SELECT s.momentum_index FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at ORDER BY s.ts DESC LIMIT 1) AS momentum_at_entry,
        (SELECT s.matched_volume FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id ORDER BY s.ts DESC LIMIT 1) AS final_volume
      FROM bets b
      LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
      WHERE b.placed_at >= datetime('now', ?)
      ORDER BY b.placed_at DESC
    `).all(since);

    const flat = rows.map(r => {
      const sa = _parseJson(r.serve_at_entry);
      const sf = _parseJson(r.serve_final);
      const setsEntry = _parseJson(r.sets_at_entry);
      const setsFinal = _parseJson(r.sets_final);
      return {
        bet_id: r.bet_id,
        placed_at: r.placed_at,
        settled_at: r.settled_at,
        strategy: r.strategy_name,
        side: r.side,
        player_key: r.player_key,
        player_name: r.player_name,
        match: r.match_name,
        player_a: r.player_a_name,
        player_b: r.player_b_name,
        surface: r.surface,
        tournament: r.tournament,
        pre_match_odds_a: r.pre_match_odds_a,
        pre_match_odds_b: r.pre_match_odds_b,
        requested_odds: r.requested_odds,
        actual_odds: r.actual_odds,
        stake: r.stake,
        size_matched: r.size_matched,
        liability: r.liability,
        hedge_odds: r.hedge_odds,
        pnl: r.pnl,
        settlement: r.settlement_type,
        dry_run: r.dry_run,
        reason: r.reason,
        exit_config: r.exit_config,
        sets_at_entry: _formatSets(setsEntry),
        sets_final: _formatSets(setsFinal),
        momentum_at_entry: r.momentum_at_entry,
        final_volume: r.final_volume,
        market_id: r.betfair_market_id,
        ..._flatServe('entry', sa),
        ..._flatServe('final', sf),
      };
    });

    const cols = flat.length ? Object.keys(flat[0]) : [
      'bet_id','placed_at','settled_at','strategy','side','player_key','player_name',
      'match','player_a','player_b','surface','tournament','pre_match_odds_a','pre_match_odds_b',
      'requested_odds','actual_odds','stake','size_matched','liability','hedge_odds','pnl',
      'settlement','dry_run','reason','exit_config','sets_at_entry','sets_final',
      'momentum_at_entry','final_volume','market_id'
    ];
    _writeCsv(res, `tennis-bets-${new Date().toISOString().slice(0,10)}.csv`, flat, cols);
  } catch (err) {
    res.status(500).send('error: ' + err.message);
  }
}

function apiDbScannerCsv(req, res) {
  try {
    const rows = betRepo.getMarketScannerRows ? betRepo.getMarketScannerRows() : [];
    // Fall back to inline SQL if repo helper missing — same query as the existing scanner endpoint
    let scanRows = rows;
    if (!Array.isArray(scanRows) || !scanRows.length) {
      scanRows = db.prepare(`
        SELECT m.betfair_market_id, m.match_name, m.surface, m.tournament,
               m.player_a_name, m.player_b_name,
               m.pre_match_odds_a, m.pre_match_odds_b,
               m.s1_end_odds_a, m.s1_end_odds_b, m.s2_end_odds_a, m.s2_end_odds_b,
               m.winner, m.peak_volume, m.went_in_play_at, m.match_finished_at
        FROM markets m
        WHERE m.peak_volume >= 100000 AND m.match_finished_at IS NOT NULL
        ORDER BY m.went_in_play_at DESC
      `).all();
    }
    const enriched = scanRows.map(r => {
      const last = db.prepare(`
        SELECT serve_stats, sets, momentum_index, matched_volume
        FROM market_snapshots WHERE betfair_market_id = ?
        ORDER BY ts DESC LIMIT 1`).get(r.betfair_market_id);
      const ss   = _parseJson(last?.serve_stats);
      const sets = _parseJson(last?.sets);
      return {
        went_in_play_at: r.went_in_play_at,
        match_finished_at: r.match_finished_at,
        match: r.match_name,
        player_a: r.player_a_name,
        player_b: r.player_b_name,
        surface: r.surface,
        tournament: r.tournament,
        winner: r.winner,
        peak_volume: r.peak_volume,
        final_volume: last?.matched_volume,
        final_momentum: last?.momentum_index,
        pre_match_odds_a: r.pre_match_odds_a,
        pre_match_odds_b: r.pre_match_odds_b,
        s1_end_odds_a: r.s1_end_odds_a,
        s1_end_odds_b: r.s1_end_odds_b,
        s2_end_odds_a: r.s2_end_odds_a,
        s2_end_odds_b: r.s2_end_odds_b,
        sets_final: _formatSets(sets),
        market_id: r.betfair_market_id,
        ..._flatServe('match', ss),
      };
    });
    const cols = enriched.length ? Object.keys(enriched[0]) : ['went_in_play_at','match','market_id'];
    _writeCsv(res, `tennis-scanner-${new Date().toISOString().slice(0,10)}.csv`, enriched, cols);
  } catch (err) {
    res.status(500).send('error: ' + err.message);
  }
}

function apiDbEntryDataCsv(req, res) {
  try {
    const rows = db.prepare(`
      SELECT
        b.bet_id, b.strategy_name, b.side, b.player_key, b.player_name,
        b.requested_odds, b.actual_odds, b.stake, b.pnl, b.settlement_type,
        b.placed_at, b.settled_at, b.dry_run, b.reason, b.hedge_odds,
        m.match_name, m.surface, m.tournament,
        m.player_a_name, m.player_b_name,
        m.pre_match_odds_a, m.pre_match_odds_b,
        (SELECT s.sets        FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at ORDER BY s.ts DESC LIMIT 1) AS sets_at_entry,
        (SELECT s.serve_stats FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at ORDER BY s.ts DESC LIMIT 1) AS serve_at_entry,
        (SELECT s.sets        FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id ORDER BY s.ts DESC LIMIT 1) AS sets_final,
        (SELECT s.serve_stats FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id ORDER BY s.ts DESC LIMIT 1) AS serve_final
      FROM bets b
      LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
      WHERE b.placed_at >= datetime('now', '-365 days')
      ORDER BY b.strategy_name, b.placed_at DESC
    `).all();

    const flat = rows.map(r => {
      const setsE = _parseJson(r.sets_at_entry);
      const setsF = _parseJson(r.sets_final);
      return {
        strategy: r.strategy_name,
        bet_id: r.bet_id,
        placed_at: r.placed_at,
        settled_at: r.settled_at,
        match: r.match_name,
        player_a: r.player_a_name,
        player_b: r.player_b_name,
        surface: r.surface,
        tournament: r.tournament,
        pre_match_odds_a: r.pre_match_odds_a,
        pre_match_odds_b: r.pre_match_odds_b,
        sets_at_entry: _formatSets(setsE),
        sets_final: _formatSets(setsF),
        side: r.side,
        bet_player_key: r.player_key,
        bet_player_name: r.player_name,
        requested_odds: r.requested_odds,
        actual_odds: r.actual_odds,
        stake: r.stake,
        hedge_odds: r.hedge_odds,
        pnl: r.pnl,
        settlement: r.settlement_type,
        dry_run: r.dry_run,
        reason: r.reason,
        ..._flatServe('entry', _parseJson(r.serve_at_entry)),
        ..._flatServe('final', _parseJson(r.serve_final)),
      };
    });
    const cols = flat.length ? Object.keys(flat[0]) : ['strategy','bet_id','placed_at'];
    _writeCsv(res, `tennis-entry-data-${new Date().toISOString().slice(0,10)}.csv`, flat, cols);
  } catch (err) {
    res.status(500).send('error: ' + err.message);
  }
}

'''
    # Insert helpers above the existing apiDbDailyPnl function definition (consistent with other api* fns)
    s = s.replace('function apiDbDailyPnl(req, res) {', helpers + '\nfunction apiDbDailyPnl(req, res) {', 1)
    with open(SV, 'w', encoding='utf-8') as f:
        f.write(s)
    print('1. server.js: 3 CSV endpoints added')
else:
    print('1. server.js: CSV endpoints already present')

# ── 2. app.js — replace client-side CSV with server downloads + entry button ─
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

# Replace exportBetsCsv / exportScannerCsv with simple download triggers
old_bets = '''function exportBetsCsv() {
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
}'''
new_bets = '''function exportBetsCsv() {
  const since = (typeof $ === 'function' && $('bets-period') && $('bets-period').value) || '-90 days';
  const a = document.createElement('a');
  a.href = `/api/db/bets/csv?since=${encodeURIComponent(since)}`;
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}'''
if old_bets in s:
    s = s.replace(old_bets, new_bets, 1)
    print('2a. exportBetsCsv → server download')

old_scan = '''function exportScannerCsv() {
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
}'''
new_scan = '''function exportScannerCsv() {
  const a = document.createElement('a');
  a.href = '/api/db/market-scanner/csv';
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}'''
if old_scan in s:
    s = s.replace(old_scan, new_scan, 1)
    print('2b. exportScannerCsv → server download')

# Replace clipboard-based copyEntryDataCsv with server download
old_entry = "function copyEntryDataCsv() {"
if old_entry in s and 'function copyEntryDataCsv() {\n  const a = document' not in s:
    # Find end of the existing function and replace whole block.
    start = s.find('function copyEntryDataCsv() {')
    # Find closing "}\n" of this function — use brace counter from `start`
    depth = 0
    i = start
    while i < len(s):
        ch = s[i]
        if ch == '{': depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
        i += 1
    new_entry = '''function copyEntryDataCsv() {
  const a = document.createElement('a');
  a.href = '/api/db/bets/entry-data/csv';
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}'''
    s = s[:start] + new_entry + s[end:]
    print('2c. copyEntryDataCsv → server download (replaces clipboard)')

with open(AP, 'w', encoding='utf-8') as f:
    f.write(s)

# ── 3. index.html — relabel Entry Data button ────────────────────────────────
IX = '/home/bots/tennis-bot/src/dashboard/public/index.html'
with open(IX, 'r', encoding='utf-8') as f:
    h = f.read()
h2 = h.replace(
    '<button class="btn btn-sm" id="an-entry-csv-btn" style="display:none">Copy CSV</button>',
    '<button class="btn btn-sm" id="an-entry-csv-btn" style="display:none">⬇ CSV</button>',
    1
)
# Also update the helper text
h2 = h2.replace(
    'Set 1 serve stats per bet — Copy CSV to paste into Claude for analysis.',
    'Full per-set serve stats per bet — download CSV for offline analysis.',
    1
)
if h2 != h:
    with open(IX, 'w', encoding='utf-8') as f:
        f.write(h2)
    print('3. index.html: Entry Data button relabelled to download')

print('\nAll done.')
