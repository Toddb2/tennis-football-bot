'use strict';

/**
 * backtestDb.js — SQLite-backed backtest storage
 *
 * Migrated from JSON file to the shared better-sqlite3 database.
 * Public API is identical so runner.js and server.js need no changes.
 *
 * Tables used: backtest_runs, backtest_results (created by src/database/db.js)
 */

const db = require('../database/db');

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const _insertRun = db.prepare(`
  INSERT INTO backtest_runs
    (run_id, strategy_name, config, date_from, date_to, started_at, ended_at,
     total_bets, winning_bets, total_pnl, roi, status)
  VALUES
    (@runId, @strategyName, @config, @dateFrom, @dateTo, @startedAt, @endedAt,
     @totalBets, @winningBets, @totalPnl, @roi, 'complete')
`);

const _insertResult = db.prepare(`
  INSERT INTO backtest_results
    (run_id, match_name, surface, tournament, bet_date, player_name,
     side, entry_odds, exit_odds, stake, pnl, outcome, reason)
  VALUES
    (@runId, @matchName, @surface, @tournament, @betDate, @playerName,
     @side, @entryOdds, @exitOdds, @stake, @pnl, @outcome, @reason)
`);

const _insertResultMany = db.transaction((runId, bets) => {
  for (const b of bets) {
    _insertResult.run({
      runId,
      matchName:   b.marketId   || null,   // use marketId as name for historical runs
      surface:     b.surface    || null,
      tournament:  b.tournament || null,
      betDate:     b.betDate    || null,
      playerName:  b.playerName || null,
      side:        b.side       || null,
      entryOdds:   b.entryPrice ?? b.entryOdds ?? null,
      exitOdds:    b.exitPrice  ?? b.exitOdds  ?? null,
      stake:       b.stake      ?? 1,
      pnl:         b.pnl        ?? null,
      outcome:     b.pnl != null ? (b.pnl >= 0 ? 'WIN' : 'LOSS') : null,
      reason:      b.exitReason || b.reason || null,
    });
  }
});

const _deleteRun     = db.prepare(`DELETE FROM backtest_runs    WHERE run_id = ?`);
const _deleteResults = db.prepare(`DELETE FROM backtest_results WHERE run_id = ?`);
const _getRun        = db.prepare(`SELECT * FROM backtest_runs WHERE run_id = ?`);
const _getAllRuns     = db.prepare(`SELECT * FROM backtest_runs ORDER BY started_at DESC`);
const _getResults    = db.prepare(`SELECT * FROM backtest_results WHERE run_id = ? ORDER BY id`);

const _getBreakdown  = db.prepare(`
  SELECT
    reason          AS strategyName,
    COUNT(*)        AS betsPlaced,
    SUM(CASE WHEN pnl >= 0 THEN 1 ELSE 0 END) AS betsWon,
    ROUND(SUM(pnl), 3)                          AS totalPnl,
    ROUND(AVG(entry_odds), 3)                   AS avgOdds
  FROM backtest_results
  WHERE run_id = ?
  GROUP BY reason
  ORDER BY totalPnl DESC
`);

// ---------------------------------------------------------------------------
// ID generator
// ---------------------------------------------------------------------------

function _makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------------------
// Public API (identical to old JSON version)
// ---------------------------------------------------------------------------

/**
 * Insert a new backtest run.
 * Accepts the same shape that runner.js passes.
 */
function insertRun(run) {
  const runId   = run.id || _makeId();
  const startedAt = run.ranAt || new Date().toISOString();

  _insertRun.run({
    runId,
    strategyName: run.systemName   || run.strategyName || null,
    config:       run.config       ? JSON.stringify(run.config) : null,
    dateFrom:     run.fromDate     || null,
    dateTo:       run.toDate       || null,
    startedAt,
    endedAt:      run.endedAt      || startedAt,
    totalBets:    run.betsPlaced   ?? 0,
    winningBets:  run.betsWon      ?? 0,
    totalPnl:     run.totalPnl     ?? 0,
    roi:          run.roi          ?? 0,
  });

  // Insert individual bet records tagged with strategy name in the `reason` column
  // so we can group them later in _getBreakdown.
  const bets = [];
  if (Array.isArray(run.bets)) {
    for (const b of run.bets) {
      bets.push({ ...b, reason: b.strategy || b.strategyName || null });
    }
  }
  if (bets.length) _insertResultMany(runId, bets);

  return { id: runId, ranAt: startedAt, ...run };
}

function getRuns() {
  return _getAllRuns.all().map(_mapRun);
}

function getRun(id) {
  const row = _getRun.get(id);
  return row ? _mapRun(row) : null;
}

function getStrategyBreakdown(runId) {
  return _getBreakdown.all(runId);
}

function getBets(runId) {
  return _getResults.all(runId);
}

function deleteRun(id) {
  db.transaction(() => {
    _deleteResults.run(id);
    _deleteRun.run(id);
  })();
}

// ---------------------------------------------------------------------------
// Shape mapper — DB column names → old JSON field names the dashboard expects
// ---------------------------------------------------------------------------

function _mapRun(row) {
  return {
    id:          row.run_id,
    ranAt:       row.started_at,
    fromDate:    row.date_from,
    toDate:      row.date_to,
    systemName:  row.strategy_name,
    betsPlaced:  row.total_bets,
    betsWon:     row.winning_bets,
    totalPnl:    row.total_pnl,
    roi:         row.roi,
    notes:       null,
    config:      row.config ? JSON.parse(row.config) : null,
  };
}

module.exports = { insertRun, getRuns, getRun, getStrategyBreakdown, getBets, deleteRun };
