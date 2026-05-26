'use strict';

/**
 * marketRepo.js — CRUD for the markets table
 *
 * All statements are prepared once at module load (better-sqlite3 best practice).
 */

const db = require('./db');

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const _upsert = db.prepare(`
  INSERT INTO markets (
    betfair_market_id, match_name, player_a_name, player_b_name,
    surface, tournament, tournament_round,
    pre_match_odds_a, pre_match_odds_b, pre_match_volume,
    external_match_id, runner_id_a, runner_id_b, stats_linked,
    went_in_play_at
  ) VALUES (
    @betfairMarketId, @matchName, @playerAName, @playerBName,
    @surface, @tournament, @tournamentRound,
    @preMatchOddsA, @preMatchOddsB, @preMatchVolume,
    @externalMatchId, @runnerIdA, @runnerIdB, @statsLinked,
    @wentInPlayAt
  )
  ON CONFLICT(betfair_market_id) DO UPDATE SET
    match_name        = COALESCE(excluded.match_name,        match_name),
    player_a_name     = COALESCE(excluded.player_a_name,     player_a_name),
    player_b_name     = COALESCE(excluded.player_b_name,     player_b_name),
    surface           = COALESCE(excluded.surface,           surface),
    tournament        = COALESCE(excluded.tournament,        tournament),
    tournament_round  = COALESCE(excluded.tournament_round,  tournament_round),
    pre_match_odds_a  = COALESCE(excluded.pre_match_odds_a,  pre_match_odds_a),
    pre_match_odds_b  = COALESCE(excluded.pre_match_odds_b,  pre_match_odds_b),
    pre_match_volume  = COALESCE(excluded.pre_match_volume,  pre_match_volume),
    external_match_id = COALESCE(excluded.external_match_id, external_match_id),
    runner_id_a       = COALESCE(excluded.runner_id_a,       runner_id_a),
    runner_id_b       = COALESCE(excluded.runner_id_b,       runner_id_b),
    stats_linked      = CASE WHEN excluded.stats_linked = 1 THEN 1 ELSE stats_linked END,
    went_in_play_at   = COALESCE(excluded.went_in_play_at,   went_in_play_at)
`);

const _close = db.prepare(`
  UPDATE markets
  SET ended_at   = @endedAt,
      final_sets = @finalSets,
      winner     = @winner
  WHERE betfair_market_id = @betfairMarketId
    AND ended_at IS NULL
`);

const _getById = db.prepare(`
  SELECT * FROM markets WHERE betfair_market_id = ?
`);

const _getAll = db.prepare(`
  SELECT * FROM markets ORDER BY went_in_play_at DESC
`);

const _getRecent = db.prepare(`
  SELECT * FROM markets
  WHERE went_in_play_at >= datetime('now', '-7 days')
  ORDER BY went_in_play_at DESC
`);

const _getUnlinked = db.prepare(`
  SELECT * FROM markets
  WHERE stats_linked = 0 AND went_in_play_at IS NOT NULL AND ended_at IS NULL
  ORDER BY went_in_play_at DESC
`);

const _setLinked = db.prepare(`
  UPDATE markets
  SET stats_linked = 1, external_match_id = @externalMatchId
  WHERE betfair_market_id = @betfairMarketId
`);

const _updateSurface = db.prepare(`
  UPDATE markets SET surface = @surface WHERE betfair_market_id = @betfairMarketId
`);

const _updatePreMatchOdds = db.prepare(`
  UPDATE markets
  SET pre_match_odds_a = @preMatchOddsA,
      pre_match_odds_b = @preMatchOddsB,
      pre_match_volume = @preMatchVolume
  WHERE betfair_market_id = @betfairMarketId
    AND pre_match_odds_a IS NULL
`);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert or update a market record.
 * Pass only the fields you have — null fields are ignored in the upsert.
 */
function upsert(fields) {
  _upsert.run({
    betfairMarketId:  fields.betfairMarketId  ?? null,
    matchName:        fields.matchName        ?? null,
    playerAName:      fields.playerAName      ?? null,
    playerBName:      fields.playerBName      ?? null,
    surface:          fields.surface          ?? null,
    tournament:       fields.tournament       ?? null,
    tournamentRound:  fields.tournamentRound  ?? null,
    preMatchOddsA:    fields.preMatchOddsA    ?? null,
    preMatchOddsB:    fields.preMatchOddsB    ?? null,
    preMatchVolume:   fields.preMatchVolume   ?? null,
    externalMatchId:  fields.externalMatchId  ?? null,
    runnerIdA:        fields.runnerIdA        ?? null,
    runnerIdB:        fields.runnerIdB        ?? null,
    statsLinked:      fields.statsLinked      ? 1 : 0,
    wentInPlayAt:     fields.wentInPlayAt     ?? null,
  });
}

/** Mark a market as closed with its final score. */
function close(betfairMarketId, { endedAt, finalSets, winner }) {
  _close.run({
    betfairMarketId,
    endedAt:   endedAt   ?? new Date().toISOString(),
    finalSets: finalSets ? JSON.stringify(finalSets) : null,
    winner:    winner    ?? null,
  });
}

function getById(betfairMarketId) {
  return _getById.get(betfairMarketId) ?? null;
}

function getAll() {
  return _getAll.all();
}

/** Markets from the last 7 days. */
function getRecent() {
  return _getRecent.all();
}

/** In-play markets where stats-linking hasn't succeeded yet. */
function getUnlinked() {
  return _getUnlinked.all();
}

/** Record that api-tennis.com was successfully linked for this market. */
function setLinked(betfairMarketId, externalMatchId) {
  _setLinked.run({ betfairMarketId, externalMatchId: externalMatchId ?? null });
}

function updateSurface(betfairMarketId, surface) {
  _updateSurface.run({ betfairMarketId, surface });
}

/**
 * Store pre-match odds only if not already set (first-write wins).
 * Called as soon as the market transitions in-play and odds are captured.
 */
function updatePreMatchOdds(betfairMarketId, { preMatchOddsA, preMatchOddsB, preMatchVolume }) {
  _updatePreMatchOdds.run({ betfairMarketId, preMatchOddsA, preMatchOddsB, preMatchVolume });
}

/**
 * Populate final_sets on any market where it is NULL but at least one snapshot
 * carries a sets payload. Covers markets that closed during a bot restart (the
 * delete-state path never fired, so close() was never called) — without this,
 * Entry Data shows empty set scores forever once snapshots get pruned.
 * Idempotent.
 */
function backfillFinalSetsFromSnapshots() {
  // Only touch markets that are PROVABLY closed:
  //   - ended_at is already set (the close path fired)
  //   - OR the latest snapshot is > 30 min old (match definitely over)
  // Never write ended_at — that's the close() path's job. We just fill
  // final_sets so the dashboard can show a score.
  const result = db.prepare(`
    UPDATE markets
       SET final_sets = (
             SELECT s.sets FROM market_snapshots s
              WHERE s.betfair_market_id = markets.betfair_market_id
                AND s.sets IS NOT NULL
              ORDER BY s.ts DESC LIMIT 1
           )
     WHERE final_sets IS NULL
       AND (
             ended_at IS NOT NULL
             OR (
               SELECT MAX(s.ts) FROM market_snapshots s
                WHERE s.betfair_market_id = markets.betfair_market_id
             ) < datetime('now', '-30 minutes')
           )
       AND EXISTS (
             SELECT 1 FROM market_snapshots s2
              WHERE s2.betfair_market_id = markets.betfair_market_id
                AND s2.sets IS NOT NULL
           )
  `).run();
  return { filled: result.changes };
}

module.exports = { upsert, close, getById, getAll, getRecent, getUnlinked, setLinked, updateSurface, updatePreMatchOdds, backfillFinalSetsFromSnapshots };
