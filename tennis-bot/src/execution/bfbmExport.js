'use strict';

/**
 * bfbmExport.js — Appends a signal row to the BFBM tips CSV when a strategy
 * fires.
 *
 * 3-column ID-based format. Names are no longer in the CSV because
 * BFBM's name-matching diverges from Betfair canonical names, causing
 * tips to silently drop. IDs are authoritative.
 *
 *   Provider     — strategy name
 *   MarketId     — Betfair market id (e.g. 1.258602856)
 *   SelectionId  — Betfair runner selection id (numeric)
 *
 * BFBM Tips Settings → "Selection data exported" must be configured to:
 *   col 1 = Provider, col 2 = Market Id, col 3 = Selection Id.
 *
 * Names are still kept in the sidecar meta file for log readability and
 * for removeMarketSignals() / 6h stale-purge.
 *
 * Tip lifecycle:
 *   - appended on strategy trigger
 *   - dedup: same provider+player skipped within the same day
 *   - 6h auto-purge: any row whose writtenAt is older than 6h gets dropped
 *     (BFBM didn't pick it up in time → not a valid tip anymore)
 *   - match-end purge: removeMarketSignals(marketId) drops all rows for
 *     that market so a stale name can't re-bind to tomorrow's fixture
 *   - daily reset: file is wiped at calendar-day rollover
 */

const fs   = require('fs');
const path = require('path');

const logger     = require('../utils/logger');
const bfbmFilter = require('./bfbmFilter');

const EXPORT_PATH = path.join(__dirname, '../../data/bfbm-signals.csv');
const META_PATH   = path.join(__dirname, '../../data/bfbm-signals-meta.json');
const HEADER      = 'Provider,MarketId,SelectionId\n';
const STALE_MS    = 6 * 60 * 60 * 1000; // 6h tip TTL

// In-memory mirror of META_PATH. Each entry:
//   { writtenAt: epochMs, marketId, selectionId, strategy, player, csvLine }
let _rows       = [];
let _exportDate = null; // 'YYYY-MM-DD'

function _todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _sanitizeStrategy(name) {
  return String(name || '').replace(/_/g, '');
}

function _csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function _buildRow({ strategyName, marketId, selectionId }) {
  return [
    _sanitizeStrategy(strategyName),
    marketId || '',
    selectionId != null ? String(selectionId) : '',
  ].map(_csvEscape).join(',');
}

function _loadMeta() {
  try {
    if (fs.existsSync(META_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
      if (parsed && Array.isArray(parsed.rows)) {
        _rows       = parsed.rows;
        _exportDate = parsed.exportDate || _todayStr();
        return;
      }
    }
  } catch (e) {
    logger.warn('bfbmExport: meta load failed, starting fresh', { message: e.message });
  }
  _rows       = [];
  _exportDate = _todayStr();
}

function _saveMeta() {
  try {
    fs.writeFileSync(META_PATH, JSON.stringify({
      exportDate: _exportDate,
      rows:       _rows,
    }, null, 2), 'utf8');
  } catch (e) {
    logger.warn('bfbmExport: meta save failed', { message: e.message });
  }
}

function _rewriteCsv() {
  const body = _rows.map(r => r.csvLine).join('\n');
  const out  = HEADER + (body ? body + '\n' : '');
  fs.writeFileSync(EXPORT_PATH, out, 'utf8');
}

function _purgeStale() {
  const cutoff = Date.now() - STALE_MS;
  const before = _rows.length;
  _rows = _rows.filter(r => (r.writtenAt || 0) >= cutoff);
  return before - _rows.length;
}

function _dailyReset() {
  const today = _todayStr();
  if (_exportDate !== today) {
    _rows       = [];
    _exportDate = today;
    return true;
  }
  return false;
}

function _midnightWipe() {
  try {
    _rows       = [];
    _exportDate = _todayStr();
    _rewriteCsv();
    _saveMeta();
    logger.info('bfbmExport: midnight wipe complete', { date: _exportDate });
  } catch (e) {
    logger.warn('bfbmExport: midnight wipe failed', { message: e.message });
  }
}

function _scheduleMidnightWipe() {
  // Fire at the next local midnight (+5s slack), then every 24h.
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5, 0);
  setTimeout(() => {
    _midnightWipe();
    setInterval(_midnightWipe, 24 * 60 * 60 * 1000);
  }, next.getTime() - now.getTime());
}

function _initState() {
  const dir = path.dirname(EXPORT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _loadMeta();
  const wiped  = _dailyReset();
  const purged = _purgeStale();
  _rewriteCsv();
  _saveMeta();

  if (wiped)         logger.info('bfbmExport: daily reset on startup', { today: _exportDate });
  if (purged > 0)    logger.info('bfbmExport: stale tips purged on startup', { purged });
}

_initState();
_scheduleMidnightWipe();

function getExportPath() {
  return EXPORT_PATH;
}

function buildEmptyExport() {
  return HEADER;
}

/**
 * Append a signal to the CSV. Returns true if the tip is now in the CSV
 * (or already was, via dedup); false if blocked by Filter Lab / export disabled.
 */
function appendSignal(settings, signal) {
  if (!settings || !settings.enabled) return false;

  const verdict = bfbmFilter.passes(signal);
  if (!verdict.ok) {
    logger.info('bfbmExport: signal blocked by Filter Lab profile', {
      strategy: signal.strategyName,
      player:   signal.playerName,
      reason:   verdict.reason,
    });
    return false;
  }

  try {
    _dailyReset();
    const purged = _purgeStale();
    if (purged > 0) logger.info('bfbmExport: stale tips purged', { purged });

    const strategy = _sanitizeStrategy(signal.strategyName);
    const player      = signal.playerName || '';
    const marketId    = signal.marketId || null;
    const selectionId = signal.selectionId != null ? String(signal.selectionId) : null;
    // Dedup by (strategy, marketId, selectionId) — IDs are authoritative.
    // Fall back to player name only if IDs are missing (shouldn't happen in
    // normal flow but keeps the guard safe).
    const dedupKey = `${strategy}|${marketId || ''}|${selectionId || ''}|${marketId ? '' : player}`;

    if (_rows.some(r => `${r.strategy}|${r.marketId || ''}|${r.selectionId || ''}|${r.marketId ? '' : r.player}` === dedupKey)) {
      logger.debug('bfbmExport: duplicate signal skipped', { strategy, marketId, selectionId });
      _rewriteCsv();
      _saveMeta();
      return true;
    }

    const csvLine = _buildRow({
      strategyName: signal.strategyName,
      marketId,
      selectionId,
    });

    _rows.push({
      writtenAt:   Date.now(),
      marketId,
      selectionId,
      strategy,
      eventName:   signal.eventName || '',
      player,
      csvLine,
    });

    _rewriteCsv();
    _saveMeta();

    logger.info('bfbmExport: signal written', {
      file:     EXPORT_PATH,
      strategy: signal.strategyName,
      player:   signal.playerName,
    });
    return true;
  } catch (err) {
    logger.error('bfbmExport: failed to write signal', {
      message: err.message,
      file:    EXPORT_PATH,
    });
    return false;
  }
}

/**
 * Drop every row for `marketId`. Called when a match settles / market closes
 * so BFBM can't re-bind a stale player name to tomorrow's fixture.
 */
function removeMarketSignals(marketId) {
  if (!marketId) return 0;
  try {
    const before = _rows.length;
    _rows = _rows.filter(r => r.marketId !== marketId);
    const removed = before - _rows.length;
    if (removed > 0) {
      _rewriteCsv();
      _saveMeta();
      logger.info('bfbmExport: stale signals purged on match end', { marketId, removed });
    }
    return removed;
  } catch (err) {
    logger.warn('bfbmExport: removeMarketSignals failed', { marketId, message: err.message });
    return 0;
  }
}

module.exports = { appendSignal, removeMarketSignals, getExportPath, buildEmptyExport };
