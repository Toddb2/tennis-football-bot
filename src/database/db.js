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
db.pragma('busy_timeout = 15000');   // wait (don't throw) when another process holds the write lock
                                     // — lets the candidateSim child process write while the bot runs

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

// 2026-05-19: sub_strategy classifies each bet as `${strategy}-P1` or `${strategy}-P2`
// so symmetric strategies (Strat5, Strat6) can be analysed per-side.
try { db.exec(`ALTER TABLE bets ADD COLUMN sub_strategy TEXT`); } catch (_) {}
// Snapshot momentum and edge at the moment the bet was placed (for analysis & UI).
try { db.exec(`ALTER TABLE bets ADD COLUMN momentum_at_bet REAL`); } catch (_) {}
try { db.exec(`ALTER TABLE bets ADD COLUMN edge_at_bet REAL`); } catch (_) {}

// Backfill sub_strategy from player_key for every existing bet (idempotent — only sets NULLs).
// If strategy name already encodes the side (ends in _P1 / _P2), use it as-is.
try {
  db.prepare(`
    UPDATE bets
    SET sub_strategy = CASE
      WHEN strategy_name LIKE '%_P1' OR strategy_name LIKE '%_P2' THEN strategy_name
      ELSE strategy_name || '-' || CASE player_key WHEN 'A' THEN 'P1' ELSE 'P2' END
    END
    WHERE sub_strategy IS NULL
      AND strategy_name IS NOT NULL
      AND player_key   IS NOT NULL
  `).run();
} catch (_) {}

// Backfill liability for existing bets where it's NULL.
//   BACK: liability = stake.   LAY: liability = stake * (odds - 1).
// Uses COALESCE(actual_odds, requested_odds) so we have an odds figure for lay bets.
try {
  db.prepare(`
    UPDATE bets
    SET liability = CASE
      WHEN side = 'LAY' THEN ROUND(stake * (COALESCE(actual_odds, requested_odds) - 1), 4)
      ELSE stake
    END
    WHERE liability IS NULL
      AND stake IS NOT NULL
  `).run();
} catch (_) {}

// Backfill momentum_at_bet & edge_at_bet from the nearest market_snapshots row at/before placed_at.
// Edge is signed for the player we bet on: BACK → edge_for_bet_player; LAY → -edge_for_bet_player.
try {
  // momentum stored signed for BET PLAYER (positive = bet player gaining momentum).
  // Raw snapshot.momentum_index is A-perspective → flip when bet is on P2 (player_key='B').
  db.prepare(`
    UPDATE bets
    SET momentum_at_bet = (CASE player_key WHEN 'B' THEN -1 ELSE 1 END) * (
      SELECT s.momentum_index FROM market_snapshots s
      WHERE s.betfair_market_id = bets.betfair_market_id
        AND s.ts <= bets.placed_at
        AND s.momentum_index IS NOT NULL
      ORDER BY s.ts DESC LIMIT 1
    )
    WHERE momentum_at_bet IS NULL
      AND placed_at IS NOT NULL
  `).run();
  // Player-A edge backfill
  db.prepare(`
    UPDATE bets
    SET edge_at_bet = CASE side WHEN 'BACK' THEN 1 ELSE -1 END * (
      SELECT s.edge_a FROM market_snapshots s
      WHERE s.betfair_market_id = bets.betfair_market_id
        AND s.ts <= bets.placed_at
        AND s.edge_a IS NOT NULL
      ORDER BY s.ts DESC LIMIT 1
    )
    WHERE edge_at_bet IS NULL
      AND player_key = 'A'
      AND placed_at  IS NOT NULL
  `).run();
  // Player-B edge backfill
  db.prepare(`
    UPDATE bets
    SET edge_at_bet = CASE side WHEN 'BACK' THEN 1 ELSE -1 END * (
      SELECT s.edge_b FROM market_snapshots s
      WHERE s.betfair_market_id = bets.betfair_market_id
        AND s.ts <= bets.placed_at
        AND s.edge_b IS NOT NULL
      ORDER BY s.ts DESC LIMIT 1
    )
    WHERE edge_at_bet IS NULL
      AND player_key = 'B'
      AND placed_at  IS NOT NULL
  `).run();
} catch (_) {}

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

// candidate_paper_bets: simulated/paper bets for Strategy Lab candidates.
// Populated by candidateSim.js — a backfill over history on candidate creation,
// plus a nightly forward increment. One row per (candidate, market); the UNIQUE
// constraint makes re-runs idempotent (INSERT OR IGNORE).
db.exec(`
  CREATE TABLE IF NOT EXISTS candidate_paper_bets (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_lab_id   INTEGER NOT NULL,
    strategy_name     TEXT,
    source            TEXT,                 -- 'backfill' | 'forward'
    bet_date          TEXT,                 -- YYYY-MM-DD the market ended
    market_id         TEXT,
    match_name        TEXT,
    tournament        TEXT,
    surface           TEXT,
    player_key        TEXT,                 -- 'A' | 'B'
    side              TEXT,                 -- 'BACK' | 'LAY'
    odds              REAL,
    stake             REAL,
    pnl               REAL,
    settlement        TEXT,                 -- 'WIN' | 'LOSS'
    winner            TEXT,
    set_boundary      INTEGER,
    ts                TEXT,
    created_at        TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(strategy_lab_id, market_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cpb_lab ON candidate_paper_bets(strategy_lab_id);
`);

// Candidate simulation status: 'pending' until the backfill has run, then 'done'
// (even if it produced 0 bets). Lets the UI show "simulating…" vs a real result.
try { db.exec(`ALTER TABLE strategy_lab ADD COLUMN sim_status TEXT DEFAULT 'pending'`); } catch (_) {}

// AI chat — persistent conversations + messages for the AI Analysis tab.
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_conversations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT,
    created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS ai_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role            TEXT NOT NULL,          -- 'user' | 'assistant'
    content         TEXT,
    proposals       TEXT,                   -- JSON array of tool proposals (assistant turns)
    attachments     TEXT,                   -- JSON array of {name,size} (user turns)
    tokens_used     INTEGER,
    created_at      TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id);
`);

module.exports = db;
