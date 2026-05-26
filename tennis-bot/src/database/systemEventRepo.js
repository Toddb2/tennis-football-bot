'use strict';

/**
 * systemEventRepo.js — Write and read system_events
 *
 * Used to surface errors, warnings, and circuit-breaker trips in the
 * dashboard System tab rather than only in log files.
 */

const db = require('./db');

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

const _insert = db.prepare(`
  INSERT INTO system_events (level, source, message, details)
  VALUES (@level, @source, @message, @details)
`);

const _getRecent = db.prepare(`
  SELECT * FROM system_events
  WHERE ts >= datetime('now', @since)
  ORDER BY ts DESC
  LIMIT @limit
`);

const _getByLevel = db.prepare(`
  SELECT * FROM system_events
  WHERE level = @level
    AND ts >= datetime('now', @since)
  ORDER BY ts DESC
  LIMIT @limit
`);

const _getBySource = db.prepare(`
  SELECT * FROM system_events
  WHERE source = @source
    AND ts >= datetime('now', @since)
  ORDER BY ts DESC
  LIMIT @limit
`);

const _countByLevel = db.prepare(`
  SELECT level, COUNT(*) AS n
  FROM system_events
  WHERE ts >= datetime('now', @since)
  GROUP BY level
`);

const _purge = db.prepare(`
  DELETE FROM system_events WHERE ts < datetime('now', @since)
`);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function _log(level, source, message, details = null) {
  _insert.run({
    level,
    source,
    message,
    details: details ? JSON.stringify(details) : null,
  });
}

const error = (source, message, details) => _log('ERROR', source, message, details);
const warn  = (source, message, details) => _log('WARN',  source, message, details);
const info  = (source, message, details) => _log('INFO',  source, message, details);

/**
 * Recent events (last 24h by default).
 * @param {string} since — SQLite datetime modifier e.g. '-24 hours'
 * @param {number} limit
 */
function getRecent(since = '-24 hours', limit = 500) {
  return _getRecent.all({ since, limit });
}

function getByLevel(level, since = '-24 hours', limit = 200) {
  return _getByLevel.all({ level, since, limit });
}

function getBySource(source, since = '-24 hours', limit = 200) {
  return _getBySource.all({ source, since, limit });
}

/** Summary count by level — for the dashboard health indicators. */
function countByLevel(since = '-24 hours') {
  const rows = _countByLevel.all({ since });
  const result = { ERROR: 0, WARN: 0, INFO: 0 };
  for (const r of rows) result[r.level] = r.n;
  return result;
}

/** Purge events older than N days. */
function purgeOlderThan(days = 14) {
  return _purge.run({ since: `-${days} days` }).changes;
}

module.exports = { error, warn, info, getRecent, getByLevel, getBySource, countByLevel, purgeOlderThan };
