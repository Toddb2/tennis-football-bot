'use strict';

/**
 * db.js — SQLite connection and schema migrations
 *
 * Single shared connection (better-sqlite3 is synchronous, one connection is correct).
 * All tables created here; repositories import this module and use db.prepare().
 *
 * Database file: data/tennis-bot.db  (next to trade_log.csv)
 */

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '../../data/tennis-bot.db');

// Ensure data/ directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// WAL mode: readers don't block writers, much better for a live bot
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');   // safe with WAL, faster than FULL

// ---------------------------------------------------------------------------
// Schema migrations — idempotent (IF NOT EXISTS everywhere)
// ---------------------------------------------------------------------------

db.exec(`
  -- -------------------------------------------------------------------------
  -- markets: one row per Betfair market seen by the bot
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS markets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    betfair_market_id   TEXT    UNIQUE NOT NULL,
    match_name          TEXT    NOT NULL,
    player_a_name       TEXT,
    player_b_name       TEXT,
    surface             TEXT,
    tournament          TEXT,
    tournament_round    TEXT,
    pre_match_odds_a    REAL,
    pre_match_odds_b    REAL,
    pre_match_volume    REAL,
    external_match_id   TEXT,
    runner_id_a         TEXT,
    runner_id_b         TEXT,
    stats_linked        INTEGER DEFAULT 0,  -- 1 when api-tennis linked
    went_in_play_at     TEXT,
    ended_at            TEXT,
    final_sets          TEXT,               -- JSON array e.g. [[6,4],[3,6],[7,5]]
    winner              TEXT,               -- 'A' | 'B' | null
    created_at          TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- -------------------------------------------------------------------------
  -- market_snapshots: time-series of odds/score/stats, written every 5 s
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS market_snapshots (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    betfair_market_id   TEXT    NOT NULL,
    ts                  TEXT    NOT NULL,
    player_a_back       REAL,
    player_a_lay        REAL,
    player_b_back       REAL,
    player_b_lay        REAL,
    matched_volume      REAL,
    true_prob_a         REAL,
    true_prob_b         REAL,
    edge_a              REAL,
    edge_b              REAL,
    sets                TEXT,               -- JSON
    current_game        TEXT,               -- JSON {playerA, playerB}
    current_server      TEXT,
    serve_stats         TEXT,               -- JSON
    momentum_index      REAL,
    FOREIGN KEY (betfair_market_id) REFERENCES markets(betfair_market_id)
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_market_ts
    ON market_snapshots(betfair_market_id, ts);

  -- -------------------------------------------------------------------------
  -- bets: every bet placed (real or dry-run)
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS bets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    bet_id              TEXT    UNIQUE NOT NULL,
    betfair_market_id   TEXT    NOT NULL,
    strategy_name       TEXT,
    player_key          TEXT,               -- 'A' | 'B'
    player_name         TEXT,
    side                TEXT,               -- 'BACK' | 'LAY'
    requested_odds      REAL,
    actual_odds         REAL,
    stake               REAL,
    size_matched        REAL,
    liability           REAL,
    placed_at           TEXT,
    settled_at          TEXT,
    settlement_type     TEXT,               -- 'TRADE_OUT'|'DRY_WIN'|'DRY_LOSS'|'CANCELLED'
    pnl                 REAL,
    dry_run             INTEGER DEFAULT 0,
    reason              TEXT,
    exit_config         TEXT,               -- JSON
    FOREIGN KEY (betfair_market_id) REFERENCES markets(betfair_market_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bets_market   ON bets(betfair_market_id);
  CREATE INDEX IF NOT EXISTS idx_bets_strategy ON bets(strategy_name);
  CREATE INDEX IF NOT EXISTS idx_bets_placed   ON bets(placed_at);

  -- -------------------------------------------------------------------------
  -- bet_rejections: every time a strategy considered but rejected a bet
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS bet_rejections (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    betfair_market_id   TEXT,
    match_name          TEXT,
    strategy_name       TEXT,
    rejection_stage     TEXT,               -- 'ODDS_INVALID'|'RISK_MANAGER'|'VOLUME'|'FILTER'|etc
    rejection_reason    TEXT,
    odds                REAL,
    details             TEXT                -- JSON with full context
  );
  CREATE INDEX IF NOT EXISTS idx_rejections_market ON bet_rejections(betfair_market_id);

  -- -------------------------------------------------------------------------
  -- backtest_runs: one row per backtest execution
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS backtest_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT    UNIQUE NOT NULL,
    strategy_name TEXT,
    config        TEXT,                     -- JSON strategy config snapshot
    date_from     TEXT,
    date_to       TEXT,
    started_at    TEXT,
    ended_at      TEXT,
    total_bets    INTEGER DEFAULT 0,
    winning_bets  INTEGER DEFAULT 0,
    total_pnl     REAL    DEFAULT 0,
    roi           REAL    DEFAULT 0,
    status        TEXT    DEFAULT 'running' -- 'running'|'complete'|'failed'
  );

  -- -------------------------------------------------------------------------
  -- backtest_results: individual bet records from a backtest run
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS backtest_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT    NOT NULL,
    match_name    TEXT,
    surface       TEXT,
    tournament    TEXT,
    bet_date      TEXT,
    player_name   TEXT,
    side          TEXT,
    entry_odds    REAL,
    exit_odds     REAL,
    stake         REAL,
    pnl           REAL,
    outcome       TEXT,                     -- 'WIN'|'LOSS'|'VOID'
    reason        TEXT,
    FOREIGN KEY (run_id) REFERENCES backtest_runs(run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bt_results_run ON backtest_results(run_id);

  -- -------------------------------------------------------------------------
  -- price_milestones: odds snapshot at key match moments (pre-match, set ends, match end)
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS price_milestones (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    betfair_market_id TEXT    NOT NULL,
    milestone         TEXT    NOT NULL,  -- 'pre_match'|'set_1_end'|'set_2_end'|'set_3_end'|'match_end'
    ts                TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    player_a_back     REAL,
    player_b_back     REAL,
    set_score         TEXT,              -- e.g. "6-4" or "6-4 7-5"
    matched_volume    REAL,
    UNIQUE(betfair_market_id, milestone),
    FOREIGN KEY (betfair_market_id) REFERENCES markets(betfair_market_id)
  );
  CREATE INDEX IF NOT EXISTS idx_milestones_market ON price_milestones(betfair_market_id);

  -- -------------------------------------------------------------------------
  -- system_events: errors, warnings, circuit-breaker trips, data-link issues
  -- -------------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS system_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    level   TEXT    NOT NULL,               -- 'ERROR'|'WARN'|'INFO'
    source  TEXT    NOT NULL,               -- module name
    message TEXT    NOT NULL,
    details TEXT                            -- JSON
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts     ON system_events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_level  ON system_events(level);
  CREATE INDEX IF NOT EXISTS idx_events_source ON system_events(source);
`);

// ---------------------------------------------------------------------------
// Incremental migrations — safe to run on every startup
// ---------------------------------------------------------------------------

// Add hedge_odds column if not present (tracks the price at which a position was hedged out)
try { db.exec(`ALTER TABLE bets ADD COLUMN hedge_odds REAL`); } catch (_) {}

// Persist raw momentum features per snapshot for later weight-fitting (added 2026-05-09)
try { db.exec(`ALTER TABLE market_snapshots ADD COLUMN momentum_features TEXT`); } catch (_) {}

// Rename strategy names to match new naming convention (idempotent — safe to run every startup)
// Handles both old long-form names (e.g. "Strat1 P1 wins 1st set") and short-form ("Strat1")
const _stratLikePrefixes = [
  ['Strat1 ',  'Strat1h'],
  ['Strat2a ', 'Strat2'],
  ['Strat2b ', 'Strat2h'],
  ['Strat3 ',  'Strat3h'],
  ['Strat4a ', 'Strat4'],
  ['Strat4b ', 'Strat4h'],
];
const _stratExact = [
  ['Strat1',  'Strat1h'],
  ['Strat2a', 'Strat2'],
  ['Strat2b', 'Strat2h'],
  ['Strat3',  'Strat3h'],
  ['Strat4a', 'Strat4'],
  ['Strat4b', 'Strat4h'],
];
const _renameStmtLike  = db.prepare(`UPDATE bets           SET strategy_name = ? WHERE strategy_name LIKE ?`);
const _renameRejLike   = db.prepare(`UPDATE bet_rejections SET strategy_name = ? WHERE strategy_name LIKE ?`);
const _renameStmtExact = db.prepare(`UPDATE bets           SET strategy_name = ? WHERE strategy_name = ?`);
const _renameRejExact  = db.prepare(`UPDATE bet_rejections SET strategy_name = ? WHERE strategy_name = ?`);
for (const [prefix, newName] of _stratLikePrefixes) {
  try { _renameStmtLike.run(newName, prefix + '%'); } catch (_) {}
  try { _renameRejLike.run(newName,  prefix + '%'); } catch (_) {}
}
for (const [oldName, newName] of _stratExact) {
  try { _renameStmtExact.run(newName, oldName); } catch (_) {}
  try { _renameRejExact.run(newName,  oldName); } catch (_) {}
}

// market_scanner: all in-play markets for AI/trade research (no vol filter — query filters)
db.exec(`
  CREATE TABLE IF NOT EXISTS market_scanner (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    betfair_market_id TEXT    NOT NULL UNIQUE,
    match_name        TEXT,
    tournament        TEXT,
    surface           TEXT,
    went_in_play_at   TEXT,
    pre_match_odds_a  REAL,
    pre_match_odds_b  REAL,
    set1_end_odds_a   REAL,
    set1_end_odds_b   REAL,
    set2_end_odds_a   REAL,
    set2_end_odds_b   REAL,
    peak_volume       REAL,
    winner            TEXT,
    final_sets        TEXT,
    recorded_at       TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scanner_played_at ON market_scanner(went_in_play_at);
`);

module.exports = db;
