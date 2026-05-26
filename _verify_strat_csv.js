// Reproduce the dashboard's strategy CSV server-side and inspect every row + cell.
const fs = require('fs');
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const cfg = JSON.parse(fs.readFileSync('/home/bots/tennis-bot/config/strategies.json', 'utf8'));
const db  = new Database('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });

// Mirror of betRepo.getPnlByStrategy (Stake-based ROI)
const perfRows = db.prepare(`
  SELECT strategy_name,
    COUNT(*) AS total_bets,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
    ROUND(SUM(pnl), 2)            AS total_pnl,
    ROUND(AVG(requested_odds), 3) AS avg_odds,
    ROUND(SUM(stake), 2)          AS total_stake,
    ROUND(SUM(liability), 2)      AS total_liability,
    ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi_pct
  FROM bets
  WHERE settled_at IS NOT NULL
  GROUP BY strategy_name
`).all();
const perfByName = Object.fromEntries(perfRows.map(r => [r.strategy_name, r]));

const headers = [
  'Strategy Name','Enabled (1/0)','Description (full definition)','Stake per bet (£)',
  'Trigger Set Number','Allowed Set Scores','Loser Must Be (A=P1, B=P2)','Require Split Sets',
  'Pre-Match Odds — applies to','Pre-Match Odds — Min','Pre-Match Odds — Max',
  'Entry Player (winner/loser/both)','Entry Side (BACK/LAY)','Entry Odds — Min','Entry Odds — Max',
  'Exit Type (none/set_result)','Exit Set Number','Exit Hedge When',
  'Filter — Surfaces','Filter — Min 1st-Serve-Won Diff (pp)','Filter — Max 1st-Serve-Won Diff (pp)',
  'Filter — Min Matched Volume (£)','Filter — Momentum Favours Bet Player',
  'Filter — Per-Player Serve Stat Constraints (JSON)',
  'Performance — Total Bets','Performance — Wins','Performance — Losses','Performance — Win Rate %',
  'Performance — Total Stake (£)','Performance — Total Liability (£)','Performance — Total PnL (£)',
  'Performance — Avg Entry Odds','Performance — ROI % (PnL ÷ Stake × 100)',
];

const esc = v => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const rows = (cfg.systems || []).map(sys => {
  const trig    = sys.backtest?.trigger || {};
  const entry   = sys.backtest?.entry   || {};
  const exit    = sys.exit              || {};
  const filters = sys.filters           || {};
  const p       = perfByName[sys.name]  || {};
  let pmTarget = '', pmMin = '', pmMax = '';
  if (trig.preMatchOddsWinner) { pmTarget = 'winner'; pmMin = trig.preMatchOddsWinner.min ?? ''; pmMax = trig.preMatchOddsWinner.max ?? ''; }
  else if (trig.preMatchOddsLoser)  { pmTarget = 'loser';  pmMin = trig.preMatchOddsLoser.min  ?? ''; pmMax = trig.preMatchOddsLoser.max  ?? ''; }
  else if (trig.preMatchOddsA)      { pmTarget = 'A';      pmMin = trig.preMatchOddsA.min      ?? ''; pmMax = trig.preMatchOddsA.max      ?? ''; }
  else if (trig.preMatchOddsB)      { pmTarget = 'B';      pmMin = trig.preMatchOddsB.min      ?? ''; pmMax = trig.preMatchOddsB.max      ?? ''; }
  const serveStatFilters = {};
  for (const k of Object.keys(trig.filters || {})) serveStatFilters[k] = trig.filters[k];
  const winRate = (p.total_bets && p.wins != null)
    ? +((p.wins / (p.wins + p.losses)) * 100).toFixed(2)
    : '';
  return [
    sys.name,
    sys.enabled ? 1 : 0,
    sys.description || '',
    sys.staking?.stakeGBP ?? '',
    trig.setNumber ?? '',
    (trig.allowedSetScores || trig.allowedSet1Scores || []).join('|'),
    trig.loserMustBe || '',
    trig.requireSplitSets ? 1 : 0,
    pmTarget, pmMin, pmMax,
    entry.player || '', entry.side || '',
    entry.minOdds ?? '', entry.maxOdds ?? '',
    exit.type || 'none', exit.setNumber ?? '', exit.hedgeWhen || '',
    (filters.surfaces || []).join('|'),
    filters.minFirstServeWonDiff ?? '', filters.maxFirstServeWonDiff ?? '',
    filters.minMatchedVolume ?? '',
    filters.momentumFavoursBetPlayer ? 1 : 0,
    Object.keys(serveStatFilters).length ? serveStatFilters : '',
    p.total_bets ?? 0, p.wins ?? 0, p.losses ?? 0, winRate,
    p.total_stake ?? '', p.total_liability ?? '', p.total_pnl ?? 0,
    p.avg_odds ?? '', p.roi_pct ?? '',
  ];
});

// === Inspect each row as { header: value } map ===
for (const r of rows) {
  console.log('\n========================================');
  for (let i = 0; i < headers.length; i++) {
    const v = r[i];
    const printable = (v == null || v === '') ? '·'
      : typeof v === 'object' ? JSON.stringify(v) : v;
    console.log(`  ${headers[i].padEnd(50)} ${printable}`);
  }
}

// === Cross-check sanity ===
console.log('\n========================================');
console.log('=== SANITY CHECKS ===');

let issues = 0;
for (const sys of cfg.systems) {
  const trig = sys.backtest?.trigger || {};
  // Mirrors should have flipped allowedSetScores (P2 perspective: starts with low-X)
  if (sys.name.endsWith('_P2') && Array.isArray(trig.allowedSetScores)) {
    const allLowFirst = trig.allowedSetScores.every(s => {
      const [a, b] = s.split('-').map(Number);
      return a < b;
    });
    if (!allLowFirst) {
      console.log(`  ⚠ ${sys.name} has non-P2 allowed scores:`, trig.allowedSetScores);
      issues++;
    }
  }
  if (sys.name.endsWith('_P1') && Array.isArray(trig.allowedSetScores)) {
    const allHighFirst = trig.allowedSetScores.every(s => {
      const [a, b] = s.split('-').map(Number);
      return a > b;
    });
    if (!allHighFirst) {
      console.log(`  ⚠ ${sys.name} has non-P1 allowed scores:`, trig.allowedSetScores);
      issues++;
    }
  }
}

console.log(`\nTotal rows:     ${rows.length}`);
console.log(`Perf rows seen: ${perfRows.length}`);
console.log(`Sanity issues:  ${issues}`);

// Strategies in perf table but not in cfg (orphans):
const cfgNames = new Set(cfg.systems.map(s => s.name));
for (const p of perfRows) {
  if (!cfgNames.has(p.strategy_name)) {
    console.log(`  ⚠ perf has bets under '${p.strategy_name}' but no matching strategy in config`);
    issues++;
  }
}

console.log('\nDone.');
