// Backfill the AI-supplied missed_bets.csv as DRY bets in the bets table.
// PnL is computed from the final set scores (latest_sets) vs the bet side/player.
// Each bet gets bet_id AIMISS-N-StrategyName so they're trivially filterable.
const fs = require('fs');
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');

function parseCsv(text) {
  const out = []; let cur = '', row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); out.push(row); cur = ''; row = []; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); out.push(row); }
  return out;
}

const csvPath = process.argv[2];
const dryRun  = process.argv[3] === '--dry';
const raw = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const rows = parseCsv(raw);
const header = rows.shift();
const C = (n) => header.findIndex(h => h === n);
const cols = {
  match:   C('Match'),
  surface: C('Surface'),
  tourney: C('Tournament'),
  strat:   C('Strategy'),
  key:     C('Player Key (A/B)'),
  player:  C('Bet Player Name'),
  side:    C('Bet Side (back/lay)'),
  odds:    C('Requested Odds'),
  stake:   C('Stake (£)'),
  market:  C('Betfair Market ID'),
  reason:  C('Reason / Note'),
  sets:    C('Latest Set Scores'),
};

const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

// Mirror of betRepo.insert columns
const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO bets (
    bet_id, betfair_market_id, strategy_name, sub_strategy,
    player_key, player_name, side,
    requested_odds, actual_odds, stake, size_matched, liability,
    momentum_at_bet, edge_at_bet,
    placed_at, settled_at, settlement_type, pnl,
    dry_run, reason, exit_config
  ) VALUES (
    @betId, @market, @strategy, @subStrategy,
    @playerKey, @playerName, @side,
    @odds, @odds, @stake, @stake, @liability,
    NULL, NULL,
    @placedAt, @settledAt, @settlementType, @pnl,
    1, @reason, '{"type":"none"}'
  )
`);

// Insert/ensure market row exists for AI-claimed markets we don't have (so the JOIN works).
const upsertMarket = db.prepare(`
  INSERT INTO markets (betfair_market_id, match_name, surface, tournament, final_sets, winner)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(betfair_market_id) DO UPDATE SET
    match_name = COALESCE(markets.match_name, excluded.match_name),
    surface    = COALESCE(markets.surface,    excluded.surface),
    tournament = COALESCE(markets.tournament, excluded.tournament),
    final_sets = COALESCE(markets.final_sets, excluded.final_sets),
    winner     = COALESCE(markets.winner,     excluded.winner)
`);

let inserted = 0, skipped = 0, computed = { wins: 0, losses: 0, totalPnl: 0 };
const issues = [];

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (!r[cols.market] || !r[cols.strat]) continue;

  const strategy   = r[cols.strat];
  const market     = r[cols.market];
  const playerKey  = r[cols.key];
  const playerName = r[cols.player];
  const side       = r[cols.side];
  const odds       = parseFloat(r[cols.odds]);
  const stake      = parseFloat(r[cols.stake]) || 2;

  if (!odds || isNaN(odds)) { skipped++; issues.push(`row ${i}: bad odds`); continue; }
  if (!['BACK','LAY'].includes(side)) { skipped++; issues.push(`row ${i}: bad side`); continue; }
  if (!['A','B'].includes(playerKey)) { skipped++; issues.push(`row ${i}: bad playerKey`); continue; }

  // Parse final set scores from the CSV's "Latest Set Scores" JSON
  let sets;
  try { sets = JSON.parse(r[cols.sets]); } catch (_) {
    skipped++; issues.push(`row ${i}: bad sets JSON`); continue;
  }
  if (!Array.isArray(sets) || !sets.length) { skipped++; issues.push(`row ${i}: empty sets`); continue; }

  // Determine the match winner from completed sets
  let setsWonA = 0, setsWonB = 0;
  for (const s of sets) {
    if (s.playerA == null || s.playerB == null) continue;
    if (s.playerA > s.playerB) setsWonA++; else if (s.playerB > s.playerA) setsWonB++;
  }
  // Best-of-3 (women / regular men): first to 2. Best-of-5 (slam men): first to 3. Accept 2 either way.
  const winner = setsWonA >= 2 ? 'A' : setsWonB >= 2 ? 'B' : null;
  if (!winner) { skipped++; issues.push(`row ${i}: no clear winner from ${JSON.stringify(sets)}`); continue; }

  // Compute pnl + settlement
  // BACK wins: pnl = stake*(odds-1).  BACK loses: pnl = -stake.
  // LAY  wins: pnl = stake.            LAY loses: pnl = -stake*(odds-1).
  const betWon = (side === 'BACK' && winner === playerKey)
              || (side === 'LAY'  && winner !== playerKey);
  const liability = side === 'BACK' ? stake : +(stake * (odds - 1)).toFixed(4);
  const pnl       = betWon
    ? (side === 'BACK' ? +(stake * (odds - 1)).toFixed(2) : +stake.toFixed(2))
    : (side === 'BACK' ? -stake : -liability);
  const settlementType = betWon ? 'DRY_WIN' : 'DRY_LOSS';

  // Synthetic timestamps: use the existing market's went_in_play_at + ended_at when known,
  // else fall back to a recent UTC range so they cluster sensibly in the dashboard.
  const mRow = db.prepare(`SELECT went_in_play_at, ended_at FROM markets WHERE betfair_market_id = ?`).get(market);
  // Trigger point inferred from the reason "set N complete" — placed shortly after
  const setMatch = /set (\d+) complete/i.exec(r[cols.reason] || '');
  const setN = setMatch ? parseInt(setMatch[1], 10) : 1;
  // Use ended_at for settled_at; placed_at ≈ ended_at minus 30min*(num_sets - setN)
  const endedAt = mRow?.ended_at || '2026-05-15T12:00:00.000Z';
  const totalSets = sets.length;
  const minutesBack = Math.max(20, (totalSets - setN) * 30);
  const placedAt = new Date(new Date(endedAt).getTime() - minutesBack * 60000).toISOString();

  // Sub-strategy: auto-derive (Strat7_P1 stays as-is; Strat5/etc append -P1/-P2)
  const subStrategy = /_P[12]$/.test(strategy) ? strategy : `${strategy}-${playerKey === 'A' ? 'P1' : 'P2'}`;

  // Ensure the market row exists so dashboard joins work; populate sparse fields if missing.
  upsertMarket.run(
    market,
    r[cols.match] || null,
    r[cols.surface] || null,
    r[cols.tourney] || null,
    JSON.stringify(sets.map(s => [s.playerA, s.playerB])),
    winner
  );

  const params = {
    betId: `AIMISS-${i.toString().padStart(4, '0')}-${strategy}`,
    market, strategy, subStrategy,
    playerKey, playerName, side,
    odds, stake, liability,
    placedAt,
    settledAt: endedAt,
    settlementType, pnl,
    reason: `[AIMISS retro back-fill] ${r[cols.reason] || ''}`.slice(0, 500),
  };

  if (dryRun) {
    if (i < 10) console.log('PREVIEW', params);
  } else {
    const info = insertStmt.run(params);
    if (info.changes) {
      inserted++;
      computed.totalPnl += pnl;
      if (betWon) computed.wins++; else computed.losses++;
    } else {
      skipped++;
      issues.push(`row ${i}: insert IGNORE (duplicate bet_id?)`);
    }
  }
}

console.log('\n=== Backfill summary ===');
console.log('Mode:        ', dryRun ? 'DRY (no DB changes)' : 'APPLIED');
console.log('Inserted:    ', inserted);
console.log('Skipped:     ', skipped);
console.log('Wins:        ', computed.wins);
console.log('Losses:      ', computed.losses);
console.log('Total PnL:   ', '£' + computed.totalPnl.toFixed(2));
console.log('Win rate:    ', computed.wins / (computed.wins + computed.losses || 1) * 100, '%');
if (issues.length) {
  console.log('\nFirst 10 issues:');
  issues.slice(0, 10).forEach(x => console.log('  ' + x));
}

if (!dryRun) {
  console.log('\n=== Per-strategy backfilled summary ===');
  for (const r of db.prepare(`
    SELECT strategy_name, COUNT(*) AS n,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
      ROUND(SUM(pnl), 2) AS pnl,
      ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2) AS roi
    FROM bets WHERE bet_id LIKE 'AIMISS-%'
    GROUP BY strategy_name ORDER BY pnl DESC
  `).all()) console.log(' ', r);
}
