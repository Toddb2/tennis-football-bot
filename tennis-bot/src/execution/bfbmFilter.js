'use strict';

/**
 * bfbmFilter.js — Server-side gate for which live signals get written to the
 * BFBM CSV. Mirrors the Filter Lab's client-side filter logic so the user can
 * configure once in the UI and have it consistently applied to the BFBM feed.
 *
 * The active filter is persisted at data/bfbm_filter.json. When no file exists
 * (or the saved filter has no constraints), every signal passes — preserving
 * historic behaviour.
 *
 * The signal object passed to passes() should carry whatever context the call
 * site has — missing fields don't fail the check (a constraint with no data
 * to compare against is treated as "can't reject").
 */

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const FILTER_PATH = path.join(__dirname, '../../data/bfbm_filter.json');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 5_000; // re-read at most every 5s so save→effect is near-instant

function _load() {
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL_MS) return _cache;
  try {
    if (fs.existsSync(FILTER_PATH)) {
      _cache = JSON.parse(fs.readFileSync(FILTER_PATH, 'utf8'));
    } else {
      _cache = null;
    }
  } catch (e) {
    logger.warn('bfbmFilter: failed to read filter file', { message: e.message });
    _cache = null;
  }
  _cacheTs = Date.now();
  return _cache;
}

/** Return the saved filter object (or null). */
function getActive() {
  return _load();
}

/** Persist filter; clears cache so next passes() sees it immediately. */
function setActive(filter) {
  try {
    fs.mkdirSync(path.dirname(FILTER_PATH), { recursive: true });
    fs.writeFileSync(FILTER_PATH, JSON.stringify({
      ...filter,
      savedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    _cache = null;
    _cacheTs = 0;
    logger.info('bfbmFilter: filter saved', { criteria: Object.keys(filter).length });
  } catch (e) {
    logger.error('bfbmFilter: failed to save filter', { message: e.message });
    throw e;
  }
}

/** Delete the saved filter — reverts to "all signals pass". */
function clearActive() {
  try { if (fs.existsSync(FILTER_PATH)) fs.unlinkSync(FILTER_PATH); } catch (_) {}
  _cache = null;
  _cacheTs = 0;
}

/**
 * Decide whether a signal passes the saved filter. Returns { ok, reason }.
 * If no filter is configured, every signal passes.
 *
 * @param {object} signal — fields any of: strategyName, side, playerKey,
 *   requestedOdds, surface, tournament, matchedVolume, momentumIndex,
 *   edgeAtBet, sqDiffS1, sqDiffS2, sqDiffTrigger, sqChange, dryRun
 */
function passes(signal) {
  const f = _load();
  if (!f) return { ok: true, reason: 'no filter configured' };

  const inRange = (v, lo, hi) => (v == null) ? true /* missing data → don't reject */
    : (lo == null || v >= lo) && (hi == null || v <= hi);

  // strategies — explicit allow-list
  if (Array.isArray(f.strategies) && f.strategies.length
      && !f.strategies.includes(signal.strategyName)) {
    return { ok: false, reason: `strategy ${signal.strategyName} not in allow-list` };
  }
  if (f.side && signal.side && signal.side !== f.side) {
    return { ok: false, reason: `side ${signal.side} != ${f.side}` };
  }
  if (f.betOn && signal.playerKey && signal.playerKey !== f.betOn) {
    return { ok: false, reason: `playerKey ${signal.playerKey} != ${f.betOn}` };
  }
  if (!inRange(signal.requestedOdds,  f.oddsMin,   f.oddsMax))   return { ok: false, reason: 'odds out of range' };
  if (!inRange(signal.edgeAtBet,      f.edgeMin,   f.edgeMax))   return { ok: false, reason: 'edge out of range' };
  if (!inRange(signal.momentumIndex,  f.momMin,    f.momMax))    return { ok: false, reason: 'momentum out of range' };
  if (!inRange(signal.matchedVolume,  f.liqMin,    f.liqMax))    return { ok: false, reason: 'liquidity out of range' };
  if (!inRange(signal.sqDiffS1,       f.sqS1Min,   f.sqS1Max))   return { ok: false, reason: 'sq S1 out of range' };
  if (!inRange(signal.sqDiffS2,       f.sqS2Min,   f.sqS2Max))   return { ok: false, reason: 'sq S2 out of range' };
  if (!inRange(signal.sqChange,       f.sqChgMin,  f.sqChgMax))  return { ok: false, reason: 'sq change out of range' };
  if (!inRange(signal.sqDiffTrigger,  f.sqTrigMin, f.sqTrigMax)) return { ok: false, reason: 'sq trigger out of range' };

  if (Array.isArray(f.surfaces) && f.surfaces.length && signal.surface
      && !f.surfaces.includes(signal.surface)) {
    return { ok: false, reason: `surface ${signal.surface} not in allow-list` };
  }
  if (f.tournament && signal.tournament
      && !signal.tournament.toLowerCase().includes(String(f.tournament).toLowerCase())) {
    return { ok: false, reason: 'tournament substring mismatch' };
  }
  if (f.mode === 'live' && signal.dryRun)  return { ok: false, reason: 'live-only filter, signal is dry-run' };
  if (f.mode === 'dry'  && !signal.dryRun) return { ok: false, reason: 'dry-only filter, signal is live' };

  return { ok: true, reason: 'all criteria pass' };
}

module.exports = { passes, getActive, setActive, clearActive, FILTER_PATH };
