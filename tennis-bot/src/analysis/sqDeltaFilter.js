'use strict';

/**
 * sqDeltaFilter.js — Shadow-only per-strategy sqDiffTrigger filter for the
 * "Delta Quality Lab" sub-tab. Reads ranges from data/sq_delta_filter.json
 * and decides which historical bets would have survived if the filter had
 * been live. Never blocks a real bet — for display in the Lab only.
 *
 * Bet field used: bet_player_serve_quality_diff_trigger (rounded number).
 * Strategies with `null` range pass every bet for that strategy unchanged.
 * Strategies absent from the preset also pass everything (no rejection).
 */

const fs   = require('fs');
const path = require('path');

const PRESET_PATH = path.join(__dirname, '../../data/sq_delta_filter.json');

let _cache    = null;
let _cacheTs  = 0;
const TTL_MS  = 5_000;

function _load() {
  if (_cache && (Date.now() - _cacheTs) < TTL_MS) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8'));
  } catch (_) {
    _cache = { name: 'none', ranges: {} };
  }
  _cacheTs = Date.now();
  return _cache;
}

function getPreset() {
  return _load();
}

/**
 * Does this bet pass the per-strategy range?
 * Returns { ok: bool, hasRange: bool, range: {min,max}|null }.
 */
function passesBet(bet) {
  const p     = _load();
  const strat = bet.strategy_name;
  if (!strat || !(strat in p.ranges)) return { ok: true, hasRange: false, range: null };
  const r = p.ranges[strat];
  if (r == null) return { ok: true, hasRange: false, range: null };

  const v = bet.bet_player_serve_quality_diff_trigger;
  if (v == null) return { ok: false, hasRange: true, range: r };

  const ok = (r.min == null || v >= r.min) && (r.max == null || v <= r.max);
  return { ok, hasRange: true, range: r };
}

/**
 * Split bets into baseline (all) and filtered (passes preset).
 * Returns per-strategy summary stats in the same shape as the user's image.
 */
function summarise(bets) {
  const preset = _load();
  const byStrat = new Map();

  for (const b of bets) {
    const name = b.strategy_name || '—';
    if (!byStrat.has(name)) byStrat.set(name, { base: [], filt: [] });
    const row = byStrat.get(name);
    row.base.push(b);
    if (passesBet(b).ok) row.filt.push(b);
  }

  const stats = (arr) => {
    const settled = arr.filter(b => b.pnl != null);
    const wins    = settled.filter(b => (b.settlement_type || '').toUpperCase() === 'WIN').length;
    const stake   = settled.reduce((s, b) => s + (b.stake || 0), 0);
    const pnl     = settled.reduce((s, b) => s + (b.pnl   || 0), 0);
    return {
      bets:    arr.length,
      settled: settled.length,
      wins,
      sr:      settled.length ? (wins / settled.length) : null,
      pnl,
      roi:     stake > 0 ? (pnl / stake) : null,
    };
  };

  const out = [];
  const names = [...byStrat.keys()].sort((a, b) => {
    const re = /^(.*?)(\d+)(.*)$/;
    const ma = a.match(re), mb = b.match(re);
    if (!ma || !mb) return a.localeCompare(b);
    if (ma[1] !== mb[1]) return ma[1].localeCompare(mb[1]);
    if (+ma[2] !== +mb[2]) return +ma[2] - +mb[2];
    return ma[3].localeCompare(mb[3]);
  });

  let bBets = 0, bWins = 0, bSettled = 0, bStake = 0, bPnl = 0;
  let fBets = 0, fWins = 0, fSettled = 0, fStake = 0, fPnl = 0;

  for (const name of names) {
    const { base, filt } = byStrat.get(name);
    const b = stats(base);
    const f = stats(filt);
    const range = (preset.ranges && name in preset.ranges) ? preset.ranges[name] : undefined;
    out.push({
      strategy: name,
      range:    range == null ? null : range,
      hasRange: range != null,
      base: b,
      filtered: f,
    });
    bBets += b.bets; bSettled += b.settled; bWins += b.wins;
    bStake += base.filter(x => x.pnl != null).reduce((s, x) => s + (x.stake || 0), 0);
    bPnl += b.pnl;
    fBets += f.bets; fSettled += f.settled; fWins += f.wins;
    fStake += filt.filter(x => x.pnl != null).reduce((s, x) => s + (x.stake || 0), 0);
    fPnl += f.pnl;
  }

  return {
    preset: { name: preset.name, description: preset.description },
    rows: out,
    totals: {
      base:     { bets: bBets, settled: bSettled, wins: bWins, sr: bSettled ? bWins / bSettled : null, pnl: bPnl, roi: bStake > 0 ? bPnl / bStake : null },
      filtered: { bets: fBets, settled: fSettled, wins: fWins, sr: fSettled ? fWins / fSettled : null, pnl: fPnl, roi: fStake > 0 ? fPnl / fStake : null },
    },
  };
}

/** Return just the filtered subset, preserving original order. */
function filterBets(bets) {
  return bets.filter(b => passesBet(b).ok);
}

module.exports = { getPreset, passesBet, summarise, filterBets, PRESET_PATH };
