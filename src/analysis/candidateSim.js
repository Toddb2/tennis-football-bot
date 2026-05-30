'use strict';

/**
 * candidateSim.js
 *
 * Simulates Strategy Lab candidate strategies against real captured market data
 * to give each candidate a Performance read-out and a list of Simmed Bets BEFORE
 * it ever goes live.
 *
 * One engine, two entry points (per the "Both" decision):
 *   - backfillCandidate(labId)  — replays the candidate over ALL recent history
 *     (default 180 days) the moment it is created. Idempotent: clears the
 *     candidate's prior sim rows first, then re-simulates.
 *   - runForDate(date)          — nightly forward increment: replays every draft
 *     candidate over a single day's completed markets and appends new bets.
 *
 * Both share _simulateMarkets(), which mirrors the live evaluation path exactly:
 * synthetic MatchState from market_snapshots → evaluateSystems() (the SAME engine
 * the live bot and the missed-bets replay use, so the new-schema triggers
 * setNumber/loserMustBe/allowedSetScores are honoured) → hypothetical P&L.
 *
 * Results land in candidate_paper_bets (UNIQUE(strategy_lab_id, market_id) makes
 * everything safely re-runnable via INSERT OR IGNORE).
 */

const fs   = require('fs');
const path = require('path');
const db   = require('../database/db');
const logger = require('../utils/logger');
const strategyEngine = require('../algorithm/strategyEngine'); // the LIVE bet engine — same path that places real bets
const mb = require('./missedBetsAnalyser'); // shared helpers (buildSyntheticState, etc.)

const STRATEGIES_FILE = path.join(__dirname, '../../config/strategies.json');
const DEFAULT_BACKFILL_DAYS = 120;

function _loadStrategiesConfig() {
  try { return JSON.parse(fs.readFileSync(STRATEGIES_FILE, 'utf8')); }
  catch (_) { return { systems: [] }; }
}

// Build the config object strategyEngine expects — mirrors the live call in
// index.js: { ...strategies.liquidity, globalFilters: strategies.filters }.
function _engineConfig(cfg) {
  return { ...(cfg.liquidity || {}), globalFilters: cfg.filters || {} };
}

// Build a live-shaped system (enabled:true) from a strategy_lab row's config.
function _systemFromRow(row) {
  let cfg = {};
  try { cfg = JSON.parse(row.config); } catch (_) {}
  return { ...cfg, enabled: true, name: row.name, staking: cfg.staking || { stakeGBP: 1 } };
}

function _loadMarkets({ from = null, to = null } = {}) {
  let sql = `SELECT betfair_market_id, match_name, tournament, surface,
                    pre_match_odds_a, pre_match_odds_b, final_sets, winner, ended_at
               FROM markets
              WHERE winner IS NOT NULL AND ended_at IS NOT NULL`;
  const params = [];
  if (from) { sql += ` AND substr(ended_at,1,10) >= ?`; params.push(from); }
  if (to)   { sql += ` AND substr(ended_at,1,10) <= ?`; params.push(to); }
  sql += ` ORDER BY ended_at`;
  return db.prepare(sql).all(...params);
}

// Two snapshot queries: a LEAN one (no serve_stats) and a FULL one. serve_stats
// is a large JSON blob per row; skipping it when no candidate uses serve-stat
// filters roughly halves the I/O of a backfill (the dominant cost). Most
// candidates filter on set score / odds / surface only, so lean is the norm.
const _SNAP_BASE = `betfair_market_id, ts, player_a_back, player_a_lay, player_b_back, player_b_lay,
  matched_volume, true_prob_a, true_prob_b, edge_a, edge_b, sets, current_game, current_server, momentum_index`;
const _snapStmtLean = db.prepare(`SELECT ${_SNAP_BASE} FROM market_snapshots WHERE betfair_market_id = ? AND sets IS NOT NULL ORDER BY ts`);
const _snapStmtFull = db.prepare(`SELECT ${_SNAP_BASE}, serve_stats FROM market_snapshots WHERE betfair_market_id = ? AND sets IS NOT NULL ORDER BY ts`);

const _SERVE_RE = /serve|aces|doublefault|breakpoint|firstserve|secondserve|servequality/i;
function _needsServeStats(systems) {
  return systems.some(s => _SERVE_RE.test(JSON.stringify(s.filters || {}) + JSON.stringify(s.backtest || {})));
}
function _snapStmtFor(systems) { return _needsServeStats(systems) ? _snapStmtFull : _snapStmtLean; }

const _insertBet = db.prepare(`
  INSERT OR IGNORE INTO candidate_paper_bets
    (strategy_lab_id, strategy_name, source, bet_date, market_id, match_name,
     tournament, surface, player_key, side, odds, stake, pnl, settlement,
     winner, set_boundary, ts)
  VALUES
    (@labId, @strategyName, @source, @betDate, @marketId, @matchName,
     @tournament, @surface, @playerKey, @side, @odds, @stake, @pnl, @settlement,
     @winner, @setBoundary, @ts)`);

/**
 * Replay ONE candidate over a set of markets, inserting at most one paper bet
 * per market — the single valid entry moment, matching the live bot's
 * one-bet-per-market discipline. Returns count inserted.
 *
 * A setNumber strategy can only enter the instant its target set completes, so
 * we evaluate at the FIRST snapshot whose completed-set count reaches setNumber
 * and then stop scanning that market (using .iterate() + break to avoid reading
 * the rest of a long match — the key performance win). Strategies without a
 * setNumber are checked at every set boundary until one qualifies.
 */
function _simulateMarkets(labId, system, markets, cfg, source) {
  const engineConfig = _engineConfig(cfg);
  const targetSet = system.backtest?.trigger?.setNumber || null;
  const stake = system.staking?.stakeGBP ?? 1;
  const snapStmt = _snapStmtFor([system]);
  let inserted = 0;

  const insertMany = db.transaction((rows) => {
    for (const r of rows) { if (_insertBet.run(r).changes > 0) inserted++; }
  });

  const toInsert = [];
  for (const market of markets) {
    let placed = null;
    const firedSet = new Set(); // empty — we break on first fire (one bet/market)

    // Walk snapshots in time order and fire on the FIRST snapshot where the
    // live engine would have triggered — its internal gates (target set
    // complete, current set 0-0, volume, odds, filters) decide the exact entry
    // moment, exactly as the live bot does. Once a setNumber strategy's target
    // set is fully past, its entry window is closed — stop scanning the market.
    for (const snap of snapStmt.iterate(market.betfair_market_id)) {
      const completed = mb.countCompletedSets(mb.parseJson(snap.sets, []));
      if (targetSet) {
        if (completed > targetSet) break;        // entry window closed — stop reading
        if (completed < targetSet) continue;     // pre-boundary — skip the expensive buildState/eval
      }
      const state = mb.buildSyntheticState(market, snap);
      const { triggers } = strategyEngine.evaluateStrategies(state, [system], firedSet, engineConfig);
      if (!triggers.length) continue;

      placed = _buildBet(labId, system, source, market, snap, triggers[0], completed);
      break; // one bet per market
    }
    if (placed) toInsert.push(placed);
  }

  if (toInsert.length) insertMany(toInsert);
  return inserted;
}

// Build one paper-bet row from a strategyEngine trigger result.
function _buildBet(labId, system, source, market, snap, t, completed) {
  const stake = system.staking?.stakeGBP ?? 1;
  const paper = mb.hypotheticalPnL({
    playerKey: t.playerKey, side: t.side,
    oddsA: snap.player_a_back, oddsB: snap.player_b_back,
    winner: market.winner, stake,
  });
  return {
    labId, strategyName: system.name, source,
    betDate:  (market.ended_at || '').slice(0, 10) || null,
    marketId: market.betfair_market_id, matchName: market.match_name,
    tournament: market.tournament, surface: market.surface,
    playerKey: t.playerKey, side: t.side,
    odds: t.odds ?? paper?.odds ?? null, stake,
    pnl: paper?.pnl ?? null, settlement: paper?.settlement ?? null,
    winner: market.winner, setBoundary: completed, ts: snap.ts,
  };
}

/**
 * Single-pass simulation of MANY candidates at once. Each market's snapshots are
 * read ONCE and every system is evaluated against each boundary (strategyEngine
 * already takes a systems[] and dedups per-market via firedSet). This makes a
 * full --pending backfill cost ~one scan instead of one-scan-per-candidate.
 * Each system must carry a `_labId`. Returns total bets inserted.
 */
function _simulateMarketsMulti(systems, markets, cfg, source) {
  if (!systems.length) return 0;
  const engineConfig = _engineConfig(cfg);
  const allHaveSet = systems.every(s => s.backtest?.trigger?.setNumber);
  const maxTarget = allHaveSet ? Math.max(...systems.map(s => s.backtest.trigger.setNumber)) : null;
  // Earliest target set across systems — below it, no system can fire, so skip
  // the expensive buildState/eval for those pre-boundary snapshots.
  const minTarget = allHaveSet ? Math.min(...systems.map(s => s.backtest.trigger.setNumber)) : null;
  const snapStmt = _snapStmtFor(systems);
  let inserted = 0;
  const insertMany = db.transaction((rows) => {
    for (const r of rows) { if (_insertBet.run(r).changes > 0) inserted++; }
  });

  const toInsert = [];
  for (const market of markets) {
    const firedSet = new Set();      // strategyEngine skips systems already in here
    const placed = {};               // systemName -> bet (one per market per system)
    try {
      for (const snap of snapStmt.iterate(market.betfair_market_id)) {
        const completed = mb.countCompletedSets(mb.parseJson(snap.sets, []));
        if (maxTarget != null && completed > maxTarget) break;  // all entry windows closed
        if (minTarget != null && completed < minTarget) continue; // pre-boundary — skip
        const state = mb.buildSyntheticState(market, snap);
        const { triggers } = strategyEngine.evaluateStrategies(state, systems, firedSet, engineConfig);
        for (const t of triggers) {
          firedSet.add(t.system.name);
          placed[t.system.name] = _buildBet(t.system._labId, t.system, source, market, snap, t, completed);
        }
        if (firedSet.size >= systems.length) break;             // everyone fired
      }
    } catch (e) {
      logger.warn('candidateSim: market eval failed (skipped)', { market: market.betfair_market_id, message: e.message });
    }
    for (const k in placed) toInsert.push(placed[k]);
  }
  if (toInsert.length) insertMany(toInsert);
  return inserted;
}

function _systemsForRows(rows) {
  return rows.map(r => { const s = _systemFromRow(r); s._labId = r.id; return s; });
}

// ── Milestone-based simulation (fast path, all-time) ─────────────────────────
// price_milestones stores one row per set boundary per market (set_1_end, …)
// with the exact odds, set score and volume at that moment — a compact, long-term
// store (vs the 21-day full snapshots). A strategy that triggers on set score /
// odds / surface / pre-match odds can be evaluated directly against it: one row
// per market instead of scanning hundreds of snapshots, and it covers as far back
// as milestone recording goes (growing over time).
//
// A strategy is only eligible if everything it filters on is present in the
// milestone (set score, live odds, volume, surface, pre-match odds). Anything
// needing per-set serve stats, momentum, edge, true-probability, break points or
// games-played falls back to the accurate full-snapshot replay.
const _SAFE_FILTER_KEYS = new Set(['surfaces', 'minMatchedVolume', 'blockedTournaments']);
function _milestoneEligible(system) {
  const bt = system.backtest || {};
  const tr = bt.trigger || {};
  const en = bt.entry || {};
  if (!tr.setNumber) return false;                                  // need a set boundary
  if (en.player !== 'winner' && en.player !== 'loser') return false; // momentum_high needs live momentum
  if (bt.serveQualityFilter) return false;
  for (const k of Object.keys(system.filters || {})) if (!_SAFE_FILTER_KEYS.has(k)) return false;
  if (/serve|aces|momentum|breakpoint|firstserve|secondserve|doublefault|edge|probability/i.test(JSON.stringify(tr))) return false;
  return true;
}

// Build a MatchState at a set-N-end milestone. set_score is the full match-to-date
// (e.g. "3-6 6-3"), so we get the real sets array. Length === setNumber, so the
// engine's "current set must be 0-0" gate is skipped (the next set is 0-0 here).
function _stateFromMilestone(r, setNum) {
  const sets = String(r.set_score).trim().split(/\s+/).map(p => {
    const [a, b] = p.split('-').map(x => parseInt(x, 10));
    return { playerA: a || 0, playerB: b || 0 };
  });
  if (sets.length < setNum) return null;                            // not enough sets recorded
  if (sets.length > setNum) sets.length = setNum;                  // trim to the target boundary
  return {
    matchName: r.match_name, surface: r.surface, tournament: r.tournament, tournamentTier: null,
    preMatchOddsA: r.pre_match_odds_a, preMatchOddsB: r.pre_match_odds_b,
    playerABack: r.player_a_back, playerBBack: r.player_b_back,
    edgeA: 0, edgeB: 0, momentumIndex: null, matchedVolume: r.matched_volume || 0,
    sets, currentServer: null, liveServeStats: {},
    totalGamesPlayed: () => sets.reduce((s, x) => s + (x.playerA || 0) + (x.playerB || 0), 0),
  };
}

const _milestoneStmt = db.prepare(`
  SELECT pm.betfair_market_id mid, pm.set_score, pm.player_a_back, pm.player_b_back, pm.matched_volume, pm.ts,
         m.match_name, m.tournament, m.surface, m.pre_match_odds_a, m.pre_match_odds_b, m.winner, m.ended_at
    FROM price_milestones pm
    JOIN markets m ON m.betfair_market_id = pm.betfair_market_id
   WHERE pm.milestone = ? AND m.winner IS NOT NULL AND pm.set_score IS NOT NULL`);
const _milestoneStmtDate = db.prepare(`
  SELECT pm.betfair_market_id mid, pm.set_score, pm.player_a_back, pm.player_b_back, pm.matched_volume, pm.ts,
         m.match_name, m.tournament, m.surface, m.pre_match_odds_a, m.pre_match_odds_b, m.winner, m.ended_at
    FROM price_milestones pm
    JOIN markets m ON m.betfair_market_id = pm.betfair_market_id
   WHERE pm.milestone = ? AND m.winner IS NOT NULL AND pm.set_score IS NOT NULL
     AND substr(COALESCE(m.ended_at, pm.ts), 1, 10) = ?`);

/** Simulate milestone-eligible systems against price_milestones (one row per
 *  market per set boundary). `date` (optional) limits to that day (forward run). */
function _simulateMilestone(systems, cfg, source, date) {
  if (!systems.length) return 0;
  const engineConfig = _engineConfig(cfg);
  const bySet = new Map();
  for (const s of systems) {
    const n = s.backtest.trigger.setNumber;
    if (!bySet.has(n)) bySet.set(n, []);
    bySet.get(n).push(s);
  }
  let inserted = 0;
  const insertMany = db.transaction((rows) => {
    for (const r of rows) { if (_insertBet.run(r).changes > 0) inserted++; }
  });
  const toInsert = [];
  for (const [setNum, group] of bySet) {
    const milestone = 'set_' + setNum + '_end';
    const rows = date ? _milestoneStmtDate.all(milestone, date) : _milestoneStmt.all(milestone);
    for (const r of rows) {
      const state = _stateFromMilestone(r, setNum);
      if (!state) continue;
      let triggers;
      try { ({ triggers } = strategyEngine.evaluateStrategies(state, group, new Set(), engineConfig)); }
      catch (_) { continue; }
      for (const t of triggers) {
        const market = { betfair_market_id: r.mid, match_name: r.match_name, tournament: r.tournament, surface: r.surface, winner: r.winner, ended_at: r.ended_at };
        const snap = { player_a_back: r.player_a_back, player_b_back: r.player_b_back, ts: r.ts };
        toInsert.push(_buildBet(t.system._labId, t.system, source, market, snap, t, setNum));
      }
    }
  }
  if (toInsert.length) insertMany(toInsert);
  return inserted;
}

/**
 * Full-history backfill for MANY candidates in one scan. Without ids, picks every
 * draft candidate that has no sim data yet. Clears those candidates' rows first.
 */
function backfillPending({ days = DEFAULT_BACKFILL_DAYS, ids = null } = {}) {
  let rows;
  if (ids && ids.length) {
    rows = ids.map(id => db.prepare(`SELECT * FROM strategy_lab WHERE id=?`).get(id)).filter(Boolean);
  } else {
    // "Needs simming" = not yet marked done (covers 0-trigger strategies, which
    // legitimately have no paper bets but ARE done — so they aren't re-picked).
    rows = db.prepare(`SELECT * FROM strategy_lab WHERE status='draft' AND (sim_status IS NULL OR sim_status <> 'done')`).all();
  }
  if (!rows.length) { logger.info('candidateSim: backfillPending — nothing to do'); return { candidates: 0, bets: 0 }; }

  const cfg = _loadStrategiesConfig();
  const systems = _systemsForRows(rows);
  const milestoneSys = systems.filter(_milestoneEligible);
  const snapSys = systems.filter(s => !_milestoneEligible(s));

  const del = db.prepare(`DELETE FROM candidate_paper_bets WHERE strategy_lab_id=?`);
  db.transaction(() => { for (const r of rows) del.run(r.id); })();

  let n = 0;
  if (milestoneSys.length) n += _simulateMilestone(milestoneSys, cfg, 'backfill');
  if (snapSys.length) {
    const from = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    n += _simulateMarketsMulti(snapSys, _loadMarkets({ from }), cfg, 'backfill');
  }
  const mark = db.prepare(`UPDATE strategy_lab SET sim_status='done' WHERE id=?`);
  db.transaction(() => { for (const r of rows) mark.run(r.id); })();
  logger.info('candidateSim: backfillPending done', { candidates: rows.length, milestone: milestoneSys.length, snapshot: snapSys.length, bets: n });
  return { candidates: rows.length, bets: n };
}

/** Full-history backfill for a single candidate (idempotent — clears & re-sims). */
function backfillCandidate(labId, { days = DEFAULT_BACKFILL_DAYS } = {}) {
  const row = db.prepare(`SELECT * FROM strategy_lab WHERE id=?`).get(labId);
  if (!row) { logger.warn('candidateSim: backfill — no such candidate', { labId }); return 0; }

  const system = _systemFromRow(row); system._labId = labId;
  const cfg = _loadStrategiesConfig();

  db.prepare(`DELETE FROM candidate_paper_bets WHERE strategy_lab_id=?`).run(labId);
  let n, via;
  if (_milestoneEligible(system)) {
    via = 'milestone'; n = _simulateMilestone([system], cfg, 'backfill');
  } else {
    via = 'snapshot';
    const from = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
    n = _simulateMarkets(labId, system, _loadMarkets({ from }), cfg, 'backfill');
  }
  db.prepare(`UPDATE strategy_lab SET sim_status='done' WHERE id=?`).run(labId);
  logger.info('candidateSim: backfilled candidate', { labId, name: row.name, via, bets: n });
  return n;
}

/** Nightly forward increment — replay every draft candidate over one day in a
 *  single pass. INSERT OR IGNORE dedups by (lab, market), so re-runs are safe. */
function runForDate(date) {
  const candidates = db.prepare(`SELECT * FROM strategy_lab WHERE status='draft'`).all();
  if (!candidates.length) return { date, candidates: 0, bets: 0 };
  const cfg = _loadStrategiesConfig();
  const systems = _systemsForRows(candidates);
  const milestoneSys = systems.filter(_milestoneEligible);
  const snapSys = systems.filter(s => !_milestoneEligible(s));
  let total = 0;
  if (milestoneSys.length) total += _simulateMilestone(milestoneSys, cfg, 'forward', date);
  if (snapSys.length) total += _simulateMarketsMulti(snapSys, _loadMarkets({ from: date, to: date }), cfg, 'forward');
  logger.info('candidateSim: forward run', { date, candidates: candidates.length, bets: total });
  return { date, candidates: candidates.length, bets: total };
}

/** Aggregate performance for a candidate (resolved bets only). */
function getStats(labId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS bets,
           SUM(CASE WHEN pnl IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
           SUM(CASE WHEN settlement='WIN' THEN 1 ELSE 0 END) AS wins,
           ROUND(SUM(COALESCE(pnl,0)), 2) AS pnl,
           ROUND(AVG(odds), 3) AS avg_odds,
           SUM(CASE WHEN source='backfill' THEN 1 ELSE 0 END) AS backfill_bets,
           SUM(CASE WHEN source='forward'  THEN 1 ELSE 0 END) AS forward_bets,
           MIN(bet_date) AS first_bet, MAX(bet_date) AS last_bet
      FROM candidate_paper_bets WHERE strategy_lab_id=?`).get(labId);
  const resolved = row.resolved || 0;
  const wins = row.wins || 0;
  const totalStake = db.prepare(`SELECT ROUND(SUM(COALESCE(stake,0)),2) AS s FROM candidate_paper_bets WHERE strategy_lab_id=? AND pnl IS NOT NULL`).get(labId).s || 0;

  // Max drawdown of the cumulative P&L curve (chronological).
  const pnls = db.prepare(`SELECT pnl FROM candidate_paper_bets WHERE strategy_lab_id=? AND pnl IS NOT NULL ORDER BY bet_date, id`).all(labId);
  let cum = 0, peak = 0, maxDd = 0;
  for (const r of pnls) { cum += r.pnl; if (cum > peak) peak = cum; const dd = peak - cum; if (dd > maxDd) maxDd = dd; }

  return {
    bets:        row.bets || 0,
    resolved,
    wins,
    losses:      resolved - wins,
    winRate:     resolved ? Math.round((wins / resolved) * 1000) / 10 : null,
    pnl:         row.pnl || 0,
    roi:         totalStake ? Math.round((row.pnl / totalStake) * 1000) / 10 : null,
    maxDrawdown: Math.round(maxDd * 100) / 100,
    avgOdds:     row.avg_odds,
    backfillBets: row.backfill_bets || 0,
    forwardBets:  row.forward_bets || 0,
    firstBet:    row.first_bet,
    lastBet:     row.last_bet,
  };
}

/** Individual simmed bets for a candidate, newest first. */
function getBets(labId, limit = 500) {
  return db.prepare(`SELECT * FROM candidate_paper_bets WHERE strategy_lab_id=? ORDER BY bet_date DESC, id DESC LIMIT ?`).all(labId, limit);
}

// ── Background spawning ──────────────────────────────────────────────────────
// The full-history backfill scans a lot of snapshots; running it in-process
// would block the bot (better-sqlite3 is synchronous). Instead we run a short
// standalone script (scripts/simCandidate.js) in its own process with its own
// DB connection (WAL + busy_timeout make this safe).
//
// We use spawn() (not fork()) because fork() requires an IPC channel — passing a
// custom stdio array without 'ipc' throws "Forked processes must have an IPC
// channel". We don't need IPC; we only watch exit/error and inherit stdout/stderr
// so the child's progress shows in pm2 logs.

const { spawn } = require('child_process');
const SIM_SCRIPT = path.join(__dirname, '../../scripts/simCandidate.js');

// Serial queue: only ONE sim child runs at a time. Running several concurrent
// backfills hammers the DB and the write transactions hit lock contention
// (SQLITE_BUSY), so they're queued and drained one-by-one.
const _spawnQueue = [];
let _spawnBusy = false;

function _drainSpawnQueue() {
  if (_spawnBusy || !_spawnQueue.length) return;
  _spawnBusy = true;
  const { args, tag } = _spawnQueue.shift();
  try {
    const child = spawn(process.execPath, [SIM_SCRIPT, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', e => { logger.warn('candidateSim: child error', { tag, message: e.message }); _spawnBusy = false; _drainSpawnQueue(); });
    child.on('exit', code => { logger.info('candidateSim: child finished', { tag, code }); _spawnBusy = false; _drainSpawnQueue(); });
  } catch (e) {
    logger.warn('candidateSim: failed to spawn child', { tag, message: e.message });
    _spawnBusy = false; _drainSpawnQueue();
  }
}

function _spawn(args, tag) {
  _spawnQueue.push({ args, tag });
  _drainSpawnQueue();
  return true;
}

/** Fork a backfill for a single candidate (non-blocking). */
function spawnBackfill(labId) { return _spawn([String(labId)], 'backfill:' + labId); }

/** Fork a backfill for every draft candidate that has no sim data yet. */
function spawnPending() { return _spawn(['--pending'], 'pending'); }

let _timer = null;
function startNightlyJob() {
  if (_timer) clearTimeout(_timer);
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(2, 30, 0, 0); // 30 min after missed-bets so yesterday's markets are settled
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  _timer = setTimeout(() => {
    try { runForDate(mb.yesterdayUtc()); }
    catch (e) { logger.error('candidateSim: nightly run failed', { message: e.message }); }
    startNightlyJob();
  }, delay);
  logger.info('candidateSim: nightly forward job scheduled', { firesAt: next.toISOString() });
}

module.exports = { backfillCandidate, backfillPending, runForDate, getStats, getBets, startNightlyJob, spawnBackfill, spawnPending };
