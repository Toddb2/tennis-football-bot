'use strict';

/**
 * snapshotRepo.js — Write and read market_snapshots
 *
 * Snapshots are written every 5 s per in-play market by the main loop.
 * Reads are used by the dashboard (odds history chart) and the backtest runner.
 *
 * Bulk inserts use a prepared statement inside a transaction for throughput.
 */

const db = require('./db');

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const _insert = db.prepare(`
  INSERT INTO market_snapshots (
    betfair_market_id, ts,
    player_a_back, player_a_lay, player_b_back, player_b_lay,
    matched_volume,
    true_prob_a, true_prob_b,
    edge_a, edge_b,
    sets, current_game, current_server,
    serve_stats, momentum_index, momentum_features
  ) VALUES (
    @betfairMarketId, @ts,
    @playerABack, @playerALay, @playerBBack, @playerBLay,
    @matchedVolume,
    @trueProbA, @trueProbB,
    @edgeA, @edgeB,
    @sets, @currentGame, @currentServer,
    @serveStats, @momentumIndex, @momentumFeatures
  )
`);

const _getForMarket = db.prepare(`
  SELECT * FROM market_snapshots
  WHERE betfair_market_id = ?
  ORDER BY ts
`);

const _getForMarketSince = db.prepare(`
  SELECT * FROM market_snapshots
  WHERE betfair_market_id = ?
    AND ts >= ?
  ORDER BY ts
`);

// Single latest snapshot for one market (for post-restart state restore)
const _getLatestForMarket = db.prepare(`
  SELECT * FROM market_snapshots
  WHERE betfair_market_id = ?
  ORDER BY ts DESC
  LIMIT 1
`);

// Latest snapshot per market (for live dashboard overview)
const _getLatestAll = db.prepare(`
  SELECT s.*
  FROM market_snapshots s
  INNER JOIN (
    SELECT betfair_market_id, MAX(ts) AS latest_ts
    FROM market_snapshots
    GROUP BY betfair_market_id
  ) latest ON s.betfair_market_id = latest.betfair_market_id
          AND s.ts = latest.latest_ts
`);

// For backtest: all snapshots for markets in a date range (sorted by market+time)
const _getForBacktest = db.prepare(`
  SELECT s.*
  FROM market_snapshots s
  INNER JOIN markets m ON s.betfair_market_id = m.betfair_market_id
  WHERE m.went_in_play_at >= @dateFrom
    AND m.went_in_play_at <= @dateTo
  ORDER BY s.betfair_market_id, s.ts
`);

// Purge snapshots older than N days to keep DB size manageable
const _purgeOld = db.prepare(`
  DELETE FROM market_snapshots
  WHERE ts < datetime('now', @since)
`);

// ---------------------------------------------------------------------------
// Bulk insert transaction (for writing many markets at once efficiently)
// ---------------------------------------------------------------------------

const _insertMany = db.transaction((rows) => {
  for (const row of rows) _insert.run(row);
});

// ---------------------------------------------------------------------------
// Dedup cache
//
// At ~5s poll cadence most polls produce a row identical to the previous one
// (odds + score + serve stats unchanged). Skipping those drops snapshot growth
// by ~80%. The entry-data join uses `ts <= placed_at ORDER BY ts DESC LIMIT 1`,
// so a skipped row is functionally equivalent to the previous kept row.
//
// Fingerprint deliberately excludes matched_volume (drifts every poll) and
// derived fields (edges, momentum) which follow from the inputs already hashed.
//
// A 60 s max-gap floor guarantees state-restore and dashboard charts always
// have a recent row even on totally static markets.
// ---------------------------------------------------------------------------

const MAX_GAP_MS  = 60_000;
const EVICT_MS    = 3_600_000;
const _lastByMarket = new Map(); // marketId → { sig, tsMs }

function _fingerprint(row) {
  return JSON.stringify([
    row.playerABack, row.playerALay, row.playerBBack, row.playerBLay,
    row.sets, row.currentGame, row.currentServer, row.serveStats,
  ]);
}

function _shouldWrite(row, nowMs) {
  const last = _lastByMarket.get(row.betfairMarketId);
  if (!last) return true;
  if (nowMs - last.tsMs >= MAX_GAP_MS) return true;
  return _fingerprint(row) !== last.sig;
}

function _recordWrite(row, nowMs) {
  _lastByMarket.set(row.betfairMarketId, { sig: _fingerprint(row), tsMs: nowMs });
}

function _evictStale(nowMs) {
  for (const [k, v] of _lastByMarket) {
    if (nowMs - v.tsMs > EVICT_MS) _lastByMarket.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write one snapshot for a market.
 * @param {object} matchState — current MatchState object from stateStore
 */
// Merge break-point counts into a set's playerA/playerB serve stat blocks so
// downstream consumers (apiDbEntryData, scanner CSV, AI tools) can read
// `breakpointsWon` / `breakpointsCreated` from the same per-player object.
function _mergeBp(serveSet, bpSet) {
  if (!serveSet) return null;
  const merge = (sv, bp) => sv ? {
    ...sv,
    breakpointsWon:     bp?.converted ?? null,
    breakpointsCreated: bp?.created   ?? null,
  } : null;
  return {
    playerA: merge(serveSet.playerA, bpSet?.playerA),
    playerB: merge(serveSet.playerB, bpSet?.playerB),
  };
}

function _buildRow(m) {
  const serveStats = m.liveServeStats
    ? {
        match: _mergeBp(m.liveServeStats,     m.breakPoints),
        set1:  _mergeBp(m.liveServeStatsSet1, m.breakPointsSet1),
        set2:  _mergeBp(m.liveServeStatsSet2, m.breakPointsSet2),
        set3:  _mergeBp(m.liveServeStatsSet3, m.breakPointsSet3),
      }
    : null;
  return {
    betfairMarketId: m.betfairMarketId,
    ts:              new Date().toISOString(),
    playerABack:     m.playerABack     ?? null,
    playerALay:      m.playerALay      ?? null,
    playerBBack:     m.playerBBack     ?? null,
    playerBLay:      m.playerBLay      ?? null,
    matchedVolume:   m.matchedVolume   ?? null,
    trueProbA:       m.trueProbabilityA ?? null,
    trueProbB:       m.trueProbabilityB ?? null,
    edgeA:           m.edgeA           ?? null,
    edgeB:           m.edgeB           ?? null,
    sets:            m.sets?.length    ? JSON.stringify(m.sets) : null,
    currentGame:     m.currentGame     ? JSON.stringify(m.currentGame) : null,
    currentServer:   m.currentServer   ?? null,
    serveStats:      serveStats        ? JSON.stringify(serveStats) : null,
    momentumIndex:   m.momentumIndex   ?? null,
    momentumFeatures: m.momentumFeatures ? JSON.stringify(m.momentumFeatures) : null,
  };
}

function write(matchState, { force = false } = {}) {
  const row   = _buildRow(matchState);
  const nowMs = Date.now();
  if (!force && !_shouldWrite(row, nowMs)) return false;
  _insert.run(row);
  _recordWrite(row, nowMs);
  return true;
}

/**
 * Write snapshots for many markets in a single transaction.
 * @param {MatchState[]} matchStates
 */
function writeMany(matchStates) {
  const nowMs = Date.now();
  const kept  = [];
  for (const m of matchStates) {
    const row = _buildRow(m);
    if (_shouldWrite(row, nowMs)) kept.push(row);
  }
  if (kept.length === 0) {
    _evictStale(nowMs);
    return { inserted: 0, skipped: matchStates.length };
  }
  _insertMany(kept);
  for (const row of kept) _recordWrite(row, nowMs);
  _evictStale(nowMs);
  return { inserted: kept.length, skipped: matchStates.length - kept.length };
}

/** All snapshots for one market, ordered by time. */
function getForMarket(betfairMarketId, since = null) {
  if (since) return _getForMarketSince.all(betfairMarketId, since);
  return _getForMarket.all(betfairMarketId);
}

/** Most recent snapshot for a single market — used to restore state after restart. */
function getLatestForMarket(betfairMarketId) {
  return _getLatestForMarket.get(betfairMarketId) || null;
}

/** Latest snapshot per market — used by the live dashboard tab. */
function getLatestAll() {
  return _getLatestAll.all();
}

/** All snapshots for markets that started between two dates — for backtesting. */
function getForBacktest(dateFrom, dateTo) {
  return _getForBacktest.all({ dateFrom, dateTo });
}

/**
 * Delete snapshots older than N days to keep DB size manageable.
 * @param {number} days — default 30
 */
function purgeOlderThan(days = 30) {
  const result = _purgeOld.run({ since: `-${days} days` });
  return result.changes;
}

module.exports = { write, writeMany, getForMarket, getLatestForMarket, getLatestAll, getForBacktest, purgeOlderThan };
