'use strict';

/**
 * dashboard/server.js
 *
 * Express + WebSocket server for the live bot dashboard.
 *
 * Lifecycle:
 *   1. index.js calls dashboard.init({ stateStore, orderManager })
 *   2. index.js calls await dashboard.start()
 *   3. index.js calls dashboard.broadcast(event, data) at key points
 *
 * REST API:
 *   GET /api/summary           — headline stats
 *   GET /api/trades/daily      — last 30 days P&L for chart
 *   GET /api/trades/open       — current open positions
 *   GET /api/trades/settled    — recent settled trades from CSV (?limit=50)
 *   GET /api/matches           — all active MatchState snapshots
 *
 * WebSocket:
 *   Server → client events: { event, data, ts }
 *   'init'         — full state dump on connection
 *   'bet_placed'   — new open position
 *   'trade_out'    — position greened up
 *   'state_update' — match state snapshots (every 5 s)
 *   'status'       — bot heartbeat
 *
 * DASHBOARD_ENABLED=false → start() is a no-op
 * DASHBOARD_PORT=3000     — configurable
 */

const express    = require('express');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const { spawn }  = require('child_process');
const { WebSocketServer } = require('ws');
const axios      = require('axios');
const logger           = require('../utils/logger');
const systemEvaluator  = require('../algorithm/systemEvaluator');
const backtestDb       = require('./backtestDb');
const { validateConfig } = require('../algorithm/strategyEngine');
const betRepo          = require('../database/betRepo');
const marketRepo       = require('../database/marketRepo');
const snapshotRepo     = require('../database/snapshotRepo');
const db               = require('../database/db');
const systemEventRepo  = require('../database/systemEventRepo');
const priceRepo          = require('../database/priceRepo');
const strategyAnalyser   = require('../analysis/strategyAnalyser');
const missedBetsAnalyser = require('../analysis/missedBetsAnalyser');
const aiRuns             = require('../analysis/aiRuns');
const candidateSim       = require('../analysis/candidateSim');
const aiChat             = require('../analysis/aiChat');
const footballBot        = require('./footballBot');
const serveScorer        = require('../algorithm/serveScorer');
const auth               = require('./auth');

const TRADE_LOG       = path.join(__dirname, '../../data/trade_log.csv');
const PUBLIC_DIR      = path.join(__dirname, 'public');
const STRATEGIES_PATH           = path.join(__dirname, '../../config/strategies.json');
const BACKTEST_STRATEGIES_PATH  = path.join(__dirname, '../../config/backtest_strategies.json');
const RUNNER_PATH     = path.join(__dirname, '../../backtest/runner.js');
const PORT       = parseInt(process.env.DASHBOARD_PORT || '3001', 10);
const ENABLED    = process.env.DASHBOARD_ENABLED !== 'false';

// Heartbeat: if no broadcast in 30 s, bot is considered offline
const BOT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Module-level state (singleton)
// ---------------------------------------------------------------------------
let _stateStore      = null;
let _orderManager    = null;
let _betfairClient   = null;
let _bfbmClient      = null;
let _statsPoller     = null;
let _wss             = null;
let _started         = false;
let _lastHeartbeat   = 0;
let _backtestRunning = false;
let _minLiveVol      = parseInt(process.env.MIN_LIVE_VOL || '100000', 10);

// Match history — ring buffer of compact snapshots per market (survives page reload)
const _matchHistoryStore = new Map();   // marketId → Array<HistoryEntry>
const MATCH_HISTORY_MAX  = 500;         // ~41 min at 5 s per tick

// All markets the bot has seen today — survives page reload, includes finished matches
const _seenMarketsToday = new Map();    // marketId → { matchName, maxVolume, lastSeenAt, isFinished }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register live bot modules so API endpoints can query them.
 * Call before start().
 */
function init({ stateStore, orderManager, betfairClient, bfbmClient, statsPoller }) {
  _stateStore     = stateStore;
  _orderManager   = orderManager;
  _betfairClient  = betfairClient || null;
  _bfbmClient     = bfbmClient    || null;
  _statsPoller    = statsPoller   || null;
}

/**
 * Allow index.js to register statsPoller after dashboard has started — useful
 * because the dashboard starts before the poller is constructed.
 */
function setStatsPoller(statsPoller) {
  _statsPoller = statsPoller || null;
}

/**
 * Start the Express + WebSocket server.
 * Resolves when the server is listening.
 * No-op if DASHBOARD_ENABLED=false.
 */
function start() {
  if (!ENABLED) {
    logger.info('Dashboard: disabled (DASHBOARD_ENABLED=false)');
    return Promise.resolve();
  }
  if (_started) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const app    = express();
    const server = http.createServer(app);

    // Internal localhost-only Betfair price lookup (used by the football
    // telegram-listener to enrich BFBM signals with overOdds/underOdds at
    // placement time). Mounted before auth — gated to 127.0.0.1.
    app.get('/api/internal/betfair-prices', apiInternalBetfairPrices);

    // Auth: must come before static + routes so unauthenticated requests redirect to /login
    auth.mount(app);
    app.use(auth.requireAuth);

    // Static files
    app.use(express.static(PUBLIC_DIR));
    app.use(express.json({ limit: '25mb' })); // headroom for AI-chat file uploads (CSV/JSON text + base64 PDFs)

    // REST routes
    app.get('/api/summary',        apiSummary);
    app.get('/api/trades/daily',   apiTradesDaily);
    app.get('/api/trades/open',    apiTradesOpen);
    app.get('/api/trades/settled', apiTradesSettled);
    app.get('/api/matches',        apiMatches);
    app.get('/api/stats-status',   apiStatsStatus);
    app.get('/api/debug/stats-raw', apiDebugStatsRaw);
    app.get('/api/debug/link-gaps', apiDebugLinkGaps);

    // Config routes
    app.get('/api/config/strategies', apiGetStrategies);
    app.put('/api/config/strategies', apiPutStrategies);

    // Betfair account & schedule
    app.get('/api/betfair/balance',   apiGetBetfairBalance);
    app.get('/api/upcoming',          apiGetUpcoming);
    app.get('/api/match-history/:marketId', apiGetMatchHistory);

    // Bet history
    app.get('/api/bets/live',           apiGetLiveBets);
    app.delete('/api/trades/history',   apiClearBetHistory);
    app.delete('/api/db/bets',          apiDbClearBets);
    app.delete('/api/db/bets/:betId',   apiDbDeleteBet);

    // Markets seen today (for finished-match schedule)
    app.get('/api/schedule/seen',     apiGetSeenToday);

    // Backtest routes
    app.get('/api/backtest/runs',                  apiGetBacktests);
    app.post('/api/backtest/runs',                 apiPostBacktest);
    app.delete('/api/backtest/runs/:id',           apiDeleteBacktest);
    app.get('/api/backtest/runs/:id/breakdown',    apiGetBreakdown);
    app.get('/api/backtest/runs/:id/bets',         apiGetBets);
    app.post('/api/backtest/trigger',              apiTriggerBacktest);
    app.get('/api/backtest/db-summary',            apiBacktestDbSummary);
    app.get('/api/backtest/running',               apiBacktestRunning);
    app.get('/api/backtest/strategy-stats',        apiBacktestStrategyStats);
    app.get('/api/performance',                    apiGetPerformance);

    // BFBM
    app.get('/api/bfbm/export',   apiGetBfbmExport);
    app.get('/api/bfbm-signals.csv', apiGetBfbmExport);
    app.get('/api/tennis.csv',       apiGetBfbmExport);

    // BFBM filter profile — saved Filter Lab criteria that gate which signals
    // get written to bfbm-signals.csv going forward.
    app.get   ('/api/bfbm-filter', apiGetBfbmFilter);
    app.post  ('/api/bfbm-filter', apiSetBfbmFilter);
    app.delete('/api/bfbm-filter', apiClearBfbmFilter);
    // Filter Lab presets (shared across machines)
    app.get   ('/api/filter-lab/presets',         apiGetFilterLabPresets);
    app.post  ('/api/filter-lab/presets',         apiSaveFilterLabPreset);
    app.delete('/api/filter-lab/presets/:name',   apiDeleteFilterLabPreset);
    app.get   ('/api/filter-lab/state',           apiGetFilterLabState);
    app.put   ('/api/filter-lab/state',           apiPutFilterLabState);
    app.get('/api/bfbm/signals',  apiGetBfbmSignals);
    app.get('/api/bfbm/ping',     apiGetBfbmPing);

    // CSV downloads
    app.get('/api/csv/trades',    apiGetTradesCsv);

    // Hedge calculator
    app.post('/api/hedge/calculate', apiHedgeCalculate);

    // AI strategy analysis
    app.get('/api/analysis/strategies',          apiGetAnalysis);
    app.post('/api/analysis/strategies/refresh', apiRefreshAnalysis);
    app.get('/api/analysis/history',             apiGetAnalysisHistory);
    app.get('/api/analysis/matrix',              apiAnalysisMatrix);

    // AI chat (streaming + persistent conversations)
    app.get   ('/api/ai-chat/conversations',     apiAiChatList);
    app.get   ('/api/ai-chat/conversations/:id', apiAiChatGet);
    app.post  ('/api/ai-chat/conversations',     apiAiChatCreate);
    app.put   ('/api/ai-chat/conversations/:id', apiAiChatRename);
    app.delete('/api/ai-chat/conversations/:id', apiAiChatDelete);
    app.post  ('/api/ai-chat',                   apiAiChatStream);

    // Missed-bets replay (Exceptions tab)
    app.get('/api/analysis/missed-bets/history',  apiMissedBetsHistory);
    app.get('/api/analysis/missed-bets/:date',    apiMissedBetsByDate);
    app.post('/api/analysis/missed-bets/refresh', apiMissedBetsRefresh);

    // Volume filter
    app.get('/api/config/volume',  apiGetVolume);
    app.post('/api/config/volume', apiSetVolume);

    // Debug
    app.get('/api/debug/mode',  apiGetDebugMode);
    app.post('/api/debug/mode', apiSetDebugMode);
    app.get('/api/debug/markets', apiGetDebugMarkets);

    // ── SQLite-backed API (Phase 2 rebuild) ─────────────────────────────────
    app.get('/api/db/summary',                     apiDbSummary);
    app.get('/api/db/bets',                        apiDbBets);
    app.get('/api/db/bets/performance',            apiDbPerformance);
    app.get('/api/db/bets/daily-pnl',              apiDbDailyPnl);
    app.get('/api/db/bets/entry-data',             apiDbEntryData);
    app.get('/api/db/rejections',                  apiDbRejections);
    app.get('/api/db/markets',                     apiDbMarkets);
    app.get('/api/db/markets/:id/snapshots',        apiDbSnapshots);
    app.get('/api/db/markets/:id/bets',             apiDbMarketBets);
    app.get('/api/db/markets/:id/rejections',       apiDbMarketRejections);
    app.get('/api/db/markets/:id/price-milestones', apiDbPriceMilestones);
    app.get('/api/db/market-scanner',               apiDbMarketScanner);
    // Strategy Lab
    app.get   ('/api/strategy-lab',                 apiGetStrategyLab);
    app.post  ('/api/strategy-lab',                 apiPostStrategyLab);
    app.put   ('/api/strategy-lab/:id',             apiPutStrategyLab);
    app.delete('/api/strategy-lab/:id',             apiDeleteStrategyLab);
    app.post  ('/api/strategy-lab/:id/promote',     apiPromoteStrategyLab);
    app.get   ('/api/strategy-lab/:id/performance', apiStrategyLabPerformance);
    app.get   ('/api/strategy-lab/:id/bets',        apiStrategyLabBets);
    app.post  ('/api/strategy-lab/:id/resim',       apiStrategyLabResim);
    // AI runs
    app.get   ('/api/ai-runs',                      apiGetAiRuns);
    app.post  ('/api/ai-runs/strategy-discovery',   apiRunStrategyDiscovery);
    app.post  ('/api/ai-runs/filter-review',        apiRunFilterReview);
    app.get   ('/api/ai-runs/:id',                  apiGetAiRun);
    app.get('/api/db/events',                      apiDbEvents);
    app.get('/api/db/events/counts',               apiDbEventCounts);
    app.get('/api/db/pipeline',                    apiDbPipeline);
    app.get('/api/delta-quality/preset',            apiDeltaQualityPreset);

    // Football bot — routes registered directly (no proxy, no second process)
    footballBot.register(app);

    // WebSocket — verify auth cookie on upgrade
    _wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const cookies = auth.parseCookies(req.headers.cookie || '');
      if (!auth.verify(cookies[auth.COOKIE])) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      _wss.handleUpgrade(req, socket, head, (ws) => _wss.emit('connection', ws, req));
    });
    _wss.on('connection', onWsConnection);

    server.listen(PORT, () => {
      _started = true;
      _lastHeartbeat = Date.now(); // bot is alive — server just started
      logger.info(`Dashboard running at http://localhost:${PORT}`);
      try { missedBetsAnalyser.startNightlyJob(); }
      catch (e) { logger.warn('missedBetsAnalyser scheduler failed', { message: e.message }); }
      try { candidateSim.startNightlyJob(); }
      catch (e) { logger.warn('candidateSim scheduler failed', { message: e.message }); }
      // Safety net: backfill any candidate that has no sim data yet (e.g. a worker
      // was interrupted by a restart). No-op when everything is already simulated.
      try { candidateSim.spawnPending(); }
      catch (e) { logger.warn('candidateSim startup backfill failed', { message: e.message }); }
      try { require('../analysis/weeklyAiJobs').startWeeklyJobs(); }
      catch (e) { logger.warn('weeklyAiJobs scheduler failed', { message: e.message }); }
      resolve();
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`Dashboard: port ${PORT} is already in use. Set DASHBOARD_PORT to a free port. Tennis-bot must NOT share a port with telegram-dashboard (3000).`);
        process.exit(1);
      }
      reject(err);
    });
  });
}

/**
 * Broadcast an event to all connected browser tabs.
 * No-op if dashboard is not started.
 */
function broadcast(event, data) {
  if (!_started || !_wss) return;
  _lastHeartbeat = Date.now();

  if (event === 'state_update' && data.matches) {
    _recordMatchHistory(data.matches);
  }

  const msg = JSON.stringify({ event, data, ts: Date.now() });
  for (const client of _wss.clients) {
    if (client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  }
}

function _recordMatchHistory(snapshots) {
  const now = Date.now();
  for (const snap of snapshots) {
    const id = snap.betfairMarketId;
    if (!id) continue;

    // Price history ring buffer
    if (!_matchHistoryStore.has(id)) _matchHistoryStore.set(id, []);
    const hist = _matchHistoryStore.get(id);
    const entry = {
      t:   now,
      bA:  snap.odds?.playerABack   ?? snap.playerABack  ?? null,
      bB:  snap.odds?.playerBBack   ?? snap.playerBBack  ?? null,
      lA:  snap.odds?.playerALay    ?? snap.playerALay   ?? null,
      lB:  snap.odds?.playerBLay    ?? snap.playerBLay   ?? null,
      tpA: snap.trueProbabilityA    ?? null,
      tpB: snap.trueProbabilityB    ?? null,
      eA:  snap.edgeA               ?? null,
      eB:  snap.edgeB               ?? null,
      vol: snap.odds?.matchedVolume ?? snap.matchedVolume ?? null,
    };
    // Persist pre-match odds on the first entry so they survive page reload
    if (hist.length === 0 && snap.preMatchOddsA) {
      entry.pmA = snap.preMatchOddsA;
      entry.pmB = snap.preMatchOddsB ?? null;
    }
    // Also update first entry if we now have pre-match odds but didn't when it was written
    if (hist.length > 0 && !hist[0].pmA && snap.preMatchOddsA) {
      hist[0].pmA = snap.preMatchOddsA;
      hist[0].pmB = snap.preMatchOddsB ?? null;
    }
    hist.push(entry);
    if (hist.length > MATCH_HISTORY_MAX) hist.shift();

    // Track this market for the day's schedule (survives page reload, includes finished)
    const prev = _seenMarketsToday.get(id) || {};
    const vol  = snap.matchedVolume || snap.odds?.matchedVolume || 0;
    _seenMarketsToday.set(id, {
      matchName:  snap.matchName  || prev.matchName  || '',
      startTime:  prev.startTime  || snap.startTime  || null,
      maxVolume:  Math.max(prev.maxVolume || 0, vol),
      lastSeenAt: now,
      isFinished: prev.isFinished || (!snap.isInPlay && (prev.maxVolume || 0) > 0),
    });
  }
}



// ── STRATEGY LAB ─────────────────────────────────────────────────────────────
function apiGetStrategyLab(req, res) {
  try {
    const rows = db.prepare(`SELECT * FROM strategy_lab ORDER BY created_at DESC`).all();
    res.json({ strategies: rows.map(r => ({
      ...r,
      config: JSON.parse(r.config),
      stats: (() => { try { return candidateSim.getStats(r.id); } catch (_) { return null; } })(),
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function apiPostStrategyLab(req, res) {
  try {
    const { name, description, config, created_by, ai_run_id, notes } = req.body;
    if (!name || !config) return res.status(400).json({ error: 'name and config required' });
    const info = db.prepare(`INSERT INTO strategy_lab (name, description, config, created_by, ai_run_id, notes) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(name, description||null, JSON.stringify(config), created_by||'ai', ai_run_id||null, notes||null);
    const newId = Number(info.lastInsertRowid);
    // Backfill the simulator in a forked child so Performance/Simmed Bets populate.
    candidateSim.spawnBackfill(newId);
    res.json({ ok: true, id: newId });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function apiPutStrategyLab(req, res) {
  try {
    const { id } = req.params;
    const { name, description, config, status, notes } = req.body;
    db.prepare(`UPDATE strategy_lab SET name=COALESCE(?,name), description=COALESCE(?,description), config=COALESCE(?,config), status=COALESCE(?,status), notes=COALESCE(?,notes) WHERE id=?`)
      .run(name||null, description||null, config ? JSON.stringify(config) : null, status||null, notes||null, id);
    // If the config changed, re-simulate from scratch so performance reflects it.
    if (config) candidateSim.spawnBackfill(Number(id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function apiDeleteStrategyLab(req, res) {
  try {
    db.prepare(`DELETE FROM candidate_paper_bets WHERE strategy_lab_id=?`).run(req.params.id);
    db.prepare(`DELETE FROM strategy_lab WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// Simulated-performance aggregate for one candidate (backtest + forward paper).
function apiStrategyLabPerformance(req, res) {
  try { res.json({ stats: candidateSim.getStats(Number(req.params.id)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
}

// Individual simmed bets for one candidate.
function apiStrategyLabBets(req, res) {
  try { res.json({ bets: candidateSim.getBets(Number(req.params.id)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
}

// Manual re-simulation trigger (background) — e.g. after fresh data arrives.
function apiStrategyLabResim(req, res) {
  try {
    const id = Number(req.params.id);
    try { db.prepare(`UPDATE strategy_lab SET sim_status='pending' WHERE id=?`).run(id); } catch (_) {}
    candidateSim.spawnBackfill(id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function apiPromoteStrategyLab(req, res) {
  try {
    const row = db.prepare(`SELECT * FROM strategy_lab WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    const fs = require('fs');
    const path = require('path');
    const stratPath = path.join(__dirname, '../../config/strategies.json');
    const strats = JSON.parse(fs.readFileSync(stratPath, 'utf8'));
    const config = JSON.parse(row.config);
    if (!strats.systems.find(s => s.name === config.name)) {
      strats.systems.push(config);
      fs.writeFileSync(stratPath, JSON.stringify(strats, null, 2));
    }
    db.prepare(`UPDATE strategy_lab SET status='promoted', promoted_at=? WHERE id=?`).run(new Date().toISOString(), req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ── AI RUNS ──────────────────────────────────────────────────────────────────
function apiGetAiRuns(req, res) {
  try {
    const rows = db.prepare(`SELECT id, run_type, started_at, completed_at, status, strategies_found, tokens_used, model, prompt_summary, error FROM ai_runs ORDER BY started_at DESC LIMIT 50`).all();
    res.json({ runs: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// Full single run incl. the (potentially large) result column — used by the UI to render a run's output.
function apiGetAiRun(req, res) {
  try {
    const row = db.prepare(`SELECT * FROM ai_runs WHERE id=?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json({ run: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function apiRunStrategyDiscovery(req, res) {
  try {
    const runId = aiRuns.startStrategyDiscovery();
    res.json({ ok: true, runId });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function apiRunFilterReview(req, res) {
  try {
    const runId = aiRuns.startFilterReview();
    res.json({ ok: true, runId });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = { init, setStatsPoller, start, broadcast, getMatchSnapshots: buildMatchSnapshots };

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Betfair account
// ---------------------------------------------------------------------------

async function apiGetBetfairBalance(req, res) {
  if (!_betfairClient) return res.json({ available: null, exposure: null, error: 'client not ready' });
  try {
    const data = await _betfairClient.getAccountFunds();
    res.json({
      available: data.availableToBetBalance ?? null,
      exposure:  data.exposure              ?? null,
    });
  } catch (err) {
    logger.warn('dashboard: getAccountFunds error', { message: err.message });
    res.json({ available: null, exposure: null, error: err.message });
  }
}

async function apiGetUpcoming(req, res) {
  try {
    const MIN_VOLUME = 50_000;
    const now   = new Date();
    const start = new Date(now); start.setDate(start.getDate() - 1); start.setHours(0, 0, 0, 0); // yesterday 00:00 — catches overnight/multi-day matches
    // Look ahead 36 h so the upcoming view surfaces tomorrow's early-morning
    // matches (e.g. Grand Slam qualifiers) before they go in-play. Aligns with
    // the statsPoller fixtures cache window so enrichment is available.
    const end   = new Date(now.getTime() + 36 * 60 * 60_000);

    // ── 1. Finished markets the bot tracked today ─────────────────────────
    // These already passed the 50k gate in the main loop, so always include them
    const seenById = new Map();
    for (const [marketId, info] of _seenMarketsToday.entries()) {
      if (!info.matchName) continue;
      seenById.set(marketId, {
        marketId,
        matchName:     info.matchName,
        startTime:     info.startTime || null,
        matchedVolume: info.maxVolume,
        hasHistory:    _matchHistoryStore.has(marketId),
        source:        'seen',
      });
    }

    // ── 2. Live + upcoming from Betfair API ───────────────────────────────
    // Betfair listMarketCatalogue is capped at 1000 results per call. On
    // busy days (Grand Slam qualifying + global ATP/WTA/ITF/Challenger), the
    // global MATCH_ODDS market count can exceed that, silently truncating
    // qualifier markets. Slice the window into 6-hour buckets to stay well
    // under the cap and merge the results.
    const liveUpcoming = [];
    if (_betfairClient) {
      const markets = [];
      try {
        const BUCKET_MS = 6 * 60 * 60_000;
        const seenIds = new Set();
        for (let t = start.getTime(); t < end.getTime(); t += BUCKET_MS) {
          const bFrom = new Date(t);
          const bTo   = new Date(Math.min(t + BUCKET_MS, end.getTime()));
          try {
            const batch = await _betfairClient.listMarketCatalogue({
              inPlayOnly:      false,
              marketTypes:     ['MATCH_ODDS'],
              marketStartTime: { from: bFrom.toISOString(), to: bTo.toISOString() },
            });
            const arr = Array.isArray(batch) ? batch : [];
            if (arr.length >= 1000) {
              logger.warn('dashboard: listMarketCatalogue bucket hit 1000 cap', {
                from: bFrom.toISOString(), to: bTo.toISOString(),
              });
            }
            for (const m of arr) {
              if (!m?.marketId || seenIds.has(m.marketId)) continue;
              seenIds.add(m.marketId);
              markets.push(m);
            }
            logger.debug('dashboard: listMarketCatalogue bucket', {
              from: bFrom.toISOString(), to: bTo.toISOString(), returned: arr.length, totalMerged: markets.length,
            });
          } catch (bucketErr) {
            logger.warn('dashboard: listMarketCatalogue bucket error', {
              from: bFrom.toISOString(), to: bTo.toISOString(), message: bucketErr.message,
            });
          }
        }

        const JUNK    = /^(under|over|yes|no|two sets|three sets|\d)/i;
        const nameSeen = new Set();

        for (const m of (markets || [])) {
          if (!m.runners || m.runners.length !== 2) continue;
          const nameA = (m.runners[0]?.runnerName || '').trim();
          const nameB = (m.runners[1]?.runnerName || '').trim();
          if (JUNK.test(nameA) || JUNK.test(nameB)) continue;
          const nameKey = [nameA.toLowerCase(), nameB.toLowerCase()].sort().join('|');
          if (nameSeen.has(nameKey)) continue;
          nameSeen.add(nameKey);

          // If we've already seen this market in our bot stream, merge start time in
          if (seenById.has(m.marketId)) {
            seenById.get(m.marketId).startTime = m.marketStartTime || null;
            continue; // already included via seen list
          }

          liveUpcoming.push({
            marketId:  m.marketId,
            matchName: `${nameA} v ${nameB}`,
            startTime: m.marketStartTime || null,
            matchedVolume: 0,  // filled from book below
            hasHistory: _matchHistoryStore.has(m.marketId),
            source: 'betfair',
          });
        }
      } catch (apiErr) {
        logger.warn('dashboard: listMarketCatalogue error', { message: apiErr.message });
      }

      // Fetch volumes + best back/lay prices for live/upcoming markets
      if (liveUpcoming.length > 0) {
        const ids = liveUpcoming.map(u => u.marketId);
        const books = [];
        for (let i = 0; i < ids.length; i += 40) {
          try {
            const batch = await _betfairClient.listMarketBook(ids.slice(i, i + 40));
            if (Array.isArray(batch)) books.push(...batch);
          } catch (_) {}
        }
        const bookMap = new Map(books.map(b => [b.marketId, b]));
        for (const u of liveUpcoming) {
          const book    = bookMap.get(u.marketId) || {};
          const runners = book.runners || [];
          u.matchedVolume = book.totalMatched || 0;
          u.inPlay = book.inplay || false;
          u.backA = runners[0]?.ex?.availableToBack?.[0]?.price ?? null;
          u.layA  = runners[0]?.ex?.availableToLay?.[0]?.price  ?? null;
          u.backB = runners[1]?.ex?.availableToBack?.[0]?.price ?? null;
          u.layB  = runners[1]?.ex?.availableToLay?.[0]?.price  ?? null;
        }
      }
    }

    // ── 3. Merge + filter ─────────────────────────────────────────────────
    const all = [
      ...seenById.values(),   // finished/live markets bot tracked (always 50k+)
      ...liveUpcoming.filter(u => {
        const startTime = u.startTime ? new Date(u.startTime) : null;
        const isUpcoming = startTime && startTime > now;
        // Always show: upcoming, in-play, or high-volume past-start markets
        return isUpcoming || u.inPlay || u.matchedVolume >= MIN_VOLUME;
      }),
    ];

    // Final dedup by marketId (in case Betfair returned a market we also saw)
    const byId = new Map(all.map(u => [u.marketId, u]));
    const result = [...byId.values()];
    result.sort((a, b) => {
      // Finished (no startTime or past) → top; upcoming → sorted by start time
      const aT = a.startTime ? new Date(a.startTime).getTime() : 0;
      const bT = b.startTime ? new Date(b.startTime).getTime() : 0;
      return aT - bT;
    });

    // ── 4. Enrich with api-tennis fixtures cache (tournament/round/surface/ranks)
    if (_statsPoller && typeof _statsPoller.getEnrichedFixtureForMatchName === 'function') {
      for (const u of result) {
        if (!u.matchName) continue;
        const fx = _statsPoller.getEnrichedFixtureForMatchName(u.matchName);
        if (!fx) continue;
        u.tournament  = fx.tournament  || null;
        u.round       = fx.round       || null;
        u.surface     = fx.surface     || null;
        u.playerARank = fx.playerARank ?? null;
        u.playerBRank = fx.playerBRank ?? null;
        u.eventKey    = fx.eventKey    || null;
      }
    }

    res.json(result);
  } catch (err) {
    logger.warn('dashboard: getUpcoming error', { message: err.message });
    res.json([]);
  }
}

function apiGetSeenToday(req, res) {
  const result = [];
  for (const [marketId, info] of _seenMarketsToday.entries()) {
    result.push({
      marketId,
      matchName:  info.matchName,
      maxVolume:  info.maxVolume,
      isFinished: info.isFinished,
      hasHistory: _matchHistoryStore.has(marketId),
    });
  }
  res.json(result);
}

function apiClearBetHistory(req, res) {
  const CSV_HEADER = 'betId,marketId,matchName,playerName,side,odds,stake,liability,action,reason,placedAt,settledAt,pnl,dryRun,estimatedWinPnL,estimatedLossPnL\n';
  try {
    fs.writeFileSync(TRADE_LOG, CSV_HEADER, 'utf8');
    logger.info('Dashboard: bet history cleared by user');
    res.json({ success: true });
  } catch (err) {
    // If the file is locked, delete it and recreate
    try {
      if (fs.existsSync(TRADE_LOG)) fs.unlinkSync(TRADE_LOG);
      fs.writeFileSync(TRADE_LOG, CSV_HEADER, 'utf8');
      logger.info('Dashboard: bet history cleared (via delete+recreate)');
      res.json({ success: true });
    } catch (err2) {
      logger.error('Dashboard: failed to clear bet history', { message: err2.message });
      res.status(500).json({ success: false, error: err2.message });
    }
  }
}

async function apiGetMatchHistory(req, res) {
  const { marketId } = req.params;
  const hist = _matchHistoryStore.get(marketId);
  if (!hist) return res.json([]);
  res.json(hist);
}

function apiGetLiveBets(req, res) {
  const period = req.query.period || 'today';
  try {
    if (!fs.existsSync(TRADE_LOG)) return res.json([]);
    const raw   = fs.readFileSync(TRADE_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length < 2) return res.json([]);

    const headers = lines[0].split(',');
    const idx = k => headers.indexOf(k);

    const now   = new Date();
    const cutoff = new Date(now);
    if      (period === 'today')   { cutoff.setHours(0, 0, 0, 0); }
    else if (period === 'week')    { cutoff.setDate(now.getDate() - 7); }
    else if (period === 'month')   { cutoff.setDate(now.getDate() - 30); }
    else if (period === 'quarter') { cutoff.setDate(now.getDate() - 90); }
    else                           { cutoff.setFullYear(2000); } // all time

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols   = _csvParseLine(lines[i]);
      const placed = cols[idx('placedAt')];
      if (!placed || new Date(placed) < cutoff) continue;
      rows.push({
        betId:      cols[idx('betId')],
        marketId:   cols[idx('marketId')],
        matchName:  cols[idx('matchName')],
        playerName: cols[idx('playerName')],
        side:       cols[idx('side')],
        odds:       parseFloat(cols[idx('odds')])   || null,
        stake:      parseFloat(cols[idx('stake')])  || null,
        liability:  parseFloat(cols[idx('liability')]) || null,
        action:     cols[idx('action')],
        reason:     cols[idx('reason')],
        placedAt:   placed,
        settledAt:  cols[idx('settledAt')] || null,
        pnl:        cols[idx('pnl')] !== '' ? parseFloat(cols[idx('pnl')]) : null,
        dryRun:     cols[idx('dryRun')] === 'true',
      });
    }

    // Pair BET_PLACED rows with their settlement rows (TRADE_OUT, DRY_WIN, DRY_LOSS)
    const SETTLEMENT_ACTIONS = new Set(['TRADE_OUT', 'DRY_WIN', 'DRY_LOSS']);
    const settlementByBetId  = new Map();
    const settlementByMktId  = new Map();
    for (const r of rows) {
      if (!SETTLEMENT_ACTIONS.has(r.action)) continue;
      if (r.betId)    settlementByBetId.set(r.betId,    r);
      if (r.marketId) settlementByMktId.set(r.marketId, r);
    }
    const bets = rows
      .filter(r => r.action === 'BET_PLACED')
      .map(r => ({
        ...r,
        tradeOut: settlementByBetId.get(r.betId) || settlementByMktId.get(r.marketId) || null,
      }));

    bets.sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
    res.json(bets);
  } catch (err) {
    logger.warn('dashboard: getLiveBets error', { message: err.message });
    res.json([]);
  }
}

function _csvParseLine(line) {
  const cols = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { cols.push(cur); cur = ''; continue; }
    cur += c;
  }
  cols.push(cur);
  return cols;
}

// ---------------------------------------------------------------------------
// Config & Backtest route handlers
// ---------------------------------------------------------------------------

function apiGetStrategies(req, res) {
  try {
    if (!fs.existsSync(STRATEGIES_PATH)) return res.json({});
    const raw = fs.readFileSync(STRATEGIES_PATH, 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) {
    logger.error('Dashboard: failed to read strategies', { message: err.message });
    res.status(500).json({ error: 'Failed to read strategies.json' });
  }
}

function apiGetBfbmFilter(req, res) {
  try {
    const bfbmFilter = require('../execution/bfbmFilter');
    res.json(bfbmFilter.getActive() || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function apiSetBfbmFilter(req, res) {
  try {
    const bfbmFilter = require('../execution/bfbmFilter');
    bfbmFilter.setActive(req.body || {});
    res.json({ ok: true, filter: bfbmFilter.getActive() });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function apiClearBfbmFilter(req, res) {
  try {
    const bfbmFilter = require('../execution/bfbmFilter');
    bfbmFilter.clearActive();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ── Filter Lab presets — server-side persistence (shared across machines) ──
const FL_PRESETS_PATH = path.join(__dirname, '../../data/filter-lab-presets.json');
function _flLoadPresetsFile() {
  try { return JSON.parse(fs.readFileSync(FL_PRESETS_PATH, 'utf8')); }
  catch (_) { return {}; }
}
function _flSavePresetsFile(obj) {
  const tmp = FL_PRESETS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, FL_PRESETS_PATH);
}
function apiGetFilterLabPresets(req, res) {
  try { res.json(_flLoadPresetsFile()); }
  catch (e) { res.status(500).json({ error: e.message }); }
}
function apiSaveFilterLabPreset(req, res) {
  try {
    const { name, filters } = req.body || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name required' });
    if (!filters || typeof filters !== 'object') return res.status(400).json({ error: 'filters required' });
    const presets = _flLoadPresetsFile();
    presets[name] = { ...filters, savedAt: new Date().toISOString() };
    _flSavePresetsFile(presets);
    res.json({ ok: true, presets });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function apiDeleteFilterLabPreset(req, res) {
  try {
    const name = req.params.name;
    const presets = _flLoadPresetsFile();
    if (!(name in presets)) return res.status(404).json({ error: 'not found' });
    delete presets[name];
    _flSavePresetsFile(presets);
    res.json({ ok: true, presets });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

const FL_STATE_PATH = path.join(__dirname, '../../data/filter-lab-state.json');
function apiGetFilterLabState(req, res) {
  try {
    if (!fs.existsSync(FL_STATE_PATH)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(FL_STATE_PATH, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function apiPutFilterLabState(req, res) {
  try {
    const body = req.body || {};
    const tmp = FL_STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...body, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    fs.renameSync(tmp, FL_STATE_PATH);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function apiGetBfbmExport(req, res) {
  try {
    const bfbmExport = require('../execution/bfbmExport');
    const filePath   = bfbmExport.getExportPath();

    res.setHeader('Content-Disposition', 'attachment; filename="tennis.csv"');
    res.setHeader('Content-Type', 'text/csv');

    if (!fs.existsSync(filePath)) {
      return res.send(bfbmExport.buildEmptyExport());
    }

    res.sendFile(filePath);
  } catch (err) {
    logger.error('Dashboard: failed to serve BFBM export', { message: err.message });
    res.status(500).json({ error: 'Failed to read export file' });
  }
}

function apiGetBfbmSignals(req, res) {
  try {
    const bfbmExport = require('../execution/bfbmExport');
    const filePath   = bfbmExport.getExportPath();

    if (!fs.existsSync(filePath)) {
      return res.json({ signals: [], count: 0 });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines   = content.split('\n').slice(1).filter(l => l.trim());

    const signals = lines.map(line => {
      // Parse CSV line respecting quoted fields
      const cols = [];
      let cur = '', inQuote = false;
      for (const ch of line) {
        if (ch === '"') { inQuote = !inQuote; continue; }
        if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; continue; }
        cur += ch;
      }
      cols.push(cur);
      return {
        strategyName: cols[0] || '',
        marketType:   cols[1] || '',
        playerName:   cols[3] || '',
      };
    });

    res.json({ signals, count: signals.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function apiGetBfbmPing(req, res) {
  const enabled = _bfbmClient?.enabled ?? false;
  if (!enabled) {
    return res.json({ reachable: false, enabled: false, message: 'BFBM_ENABLED=false — set it to true in .env to use BFBM' });
  }
  try {
    const reachable = await _bfbmClient.ping();
    res.json({
      reachable,
      enabled: true,
      message: reachable ? 'BFBM is reachable' : 'BFBM did not respond — is BF Bot Manager running?',
    });
  } catch (err) {
    res.json({ reachable: false, enabled: true, message: err.message });
  }
}

function apiHedgeCalculate(req, res) {
  const { side, entryOdds, stake, hedgeOdds } = req.body || {};

  if (!side || !entryOdds || !stake || !hedgeOdds ||
      entryOdds <= 1 || hedgeOdds <= 1 || stake <= 0) {
    return res.status(400).json({ error: 'Invalid inputs — side, entryOdds, stake, hedgeOdds all required (odds > 1, stake > 0)' });
  }

  const hedgeStake   = (stake * entryOdds) / hedgeOdds;
  const lockedProfit = side === 'BACK'
    ? stake * (entryOdds - hedgeOdds) / hedgeOdds
    : stake * (hedgeOdds - entryOdds) / hedgeOdds;
  const roi      = (lockedProfit / stake) * 100;
  const hedgeSide = side === 'BACK' ? 'LAY' : 'BACK';

  res.json({
    hedgeStake:   parseFloat(hedgeStake.toFixed(4)),
    hedgeSide,
    hedgeOdds,
    lockedProfit: parseFloat(lockedProfit.toFixed(4)),
    roi:          parseFloat(roi.toFixed(2)),
    isProfit:     lockedProfit >= 0,
  });
}

function apiGetDebugMode(req, res) {
  res.json({
    dryRun:       process.env.DRY_RUN === 'true',
    bfbmEnabled:  process.env.BFBM_ENABLED === 'true',
    streamEnabled: process.env.BETFAIR_STREAM_ENABLED === 'true',
    openBets:     _orderManager?.openOrders.size ?? 0,
    pnlToday:     _orderManager?.getPnlToday() ?? 0,
  });
}

function apiSetDebugMode(req, res) {
  const { dryRun } = req.body || {};
  if (typeof dryRun === 'boolean') {
    process.env.DRY_RUN = dryRun ? 'true' : 'false';
    logger.info(`Dashboard: DRY_RUN toggled to ${process.env.DRY_RUN} by user`);
    // Broadcast updated mode to all clients
    broadcast('status_update', { dryRun });
  }
  res.json({ dryRun: process.env.DRY_RUN === 'true' });
}

function apiGetVolume(req, res) {
  res.json({ minLiveVol: _minLiveVol });
}

function apiSetVolume(req, res) {
  const val = parseInt(req.body?.minLiveVol, 10);
  if (!Number.isFinite(val) || val < 0) {
    return res.status(400).json({ error: 'minLiveVol must be a non-negative integer' });
  }
  _minLiveVol = val;
  logger.info(`Dashboard: minLiveVol updated to ${_minLiveVol} by user`);
  broadcast('config_update', { minLiveVol: _minLiveVol });
  res.json({ minLiveVol: _minLiveVol });
}

function apiGetDebugMarkets(req, res) {
  if (!_stateStore) return res.json([]);
  let strategies = [];
  let stratConfig = {};
  try {
    stratConfig = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf8'));
    strategies = stratConfig.systems || [];
  } catch (_) {}

  const markets = _stateStore.getAll()
    .filter(m => m.isInPlay || m.status === 'LIVE')
    .map(m => {
      const snap = m.toSnapshot();
      // Run strategy evaluation to show why each strategy is/isn't firing
      let qualSystems = [];
      let topRejection = null;
      try {
        const stratEngine = require('../algorithm/strategyEngine');
        const { triggers, rejections } = stratEngine.evaluateStrategies(m, strategies, new Set(), stratConfig.liquidity || {});
        qualSystems = triggers.map(t => t.system.name);
        if (!qualSystems.length && rejections.length) {
          // Find most common rejection stage
          const counts = {};
          for (const r of rejections) counts[r.stage] = (counts[r.stage] || 0) + 1;
          topRejection = Object.entries(counts).sort((a,b) => b[1]-a[1])[0]?.[0] || null;
        }
      } catch (_) {}
      return {
        marketId:      m.betfairMarketId,
        matchName:     m.matchName,
        sets:          m.sets,
        playerABack:   m.playerABack,
        playerBBack:   m.playerBBack,
        matchedVolume: m.matchedVolume,
        isInPlay:      m.isInPlay,
        status:        m.status,
        statsLinked:   !!m.externalMatchId,
        qualSystems,
        topRejection,
        preMatchOddsA: m.preMatchOddsA,
        preMatchOddsB: m.preMatchOddsB,
      };
    });
  res.json(markets);
}

// ── Strategy matrix heatmap ───────────────────────────────────────────────
// Classifies every settled bet into one of 8 cells:
//   entry set (1|2) × backed-player's result in that set (winner|loser) × pre-match
//   role (fav|dog). Entry set comes from the strategy config; the set result from the
//   actual final_sets; the role from pre-match odds of the backed runner. "Either"
//   strategies naturally split into their fav and dog halves here.
function apiAnalysisMatrix(req, res) {
  try {
    const since = req.query.since || '-3650 days';
    const setByStrat = {};
    try {
      const cfg = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf8'));
      for (const s of (cfg.systems || [])) {
        const n = s.backtest && s.backtest.trigger && s.backtest.trigger.setNumber;
        if (n) setByStrat[s.name] = n;
      }
    } catch (_) {}
    try {
      for (const r of db.prepare(`SELECT name, config FROM strategy_lab`).all()) {
        try { const c = JSON.parse(r.config); const n = c.backtest && c.backtest.trigger && c.backtest.trigger.setNumber; if (n) setByStrat[r.name] = n; } catch (_) {}
      }
    } catch (_) {}

    const bets = db.prepare(`
      SELECT b.strategy_name, b.player_key, b.side, b.pnl, b.stake,
             m.final_sets, m.pre_match_odds_a, m.pre_match_odds_b
      FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id
      WHERE b.settlement_type IN ('DRY_WIN','DRY_LOSS')
        AND b.placed_at >= datetime('now', ?)
    `).all(since);

    const cells = {};
    for (const s of [1, 2]) for (const r of ['winner', 'loser']) for (const f of ['fav', 'dog'])
      cells[`S${s}_${r}_${f}`] = { entrySet: s, role: r, fav: f, count: 0, wins: 0, pnl: 0, stake: 0 };
    let unclassified = 0;

    for (const b of bets) {
      const entrySet = setByStrat[b.strategy_name];
      if (entrySet !== 1 && entrySet !== 2) { unclassified++; continue; }
      let sets; try { sets = JSON.parse(b.final_sets || '[]'); } catch { sets = []; }
      const row = Array.isArray(sets) ? sets[entrySet - 1] : null;
      if (!row) { unclassified++; continue; }
      const ga = Array.isArray(row) ? row[0] : row.playerA;
      const gb = Array.isArray(row) ? row[1] : row.playerB;
      const idx = b.player_key === 'A' ? 0 : 1;
      const mine = idx === 0 ? ga : gb, opp = idx === 0 ? gb : ga;
      if (mine == null || opp == null || mine === opp) { unclassified++; continue; }
      const role = mine > opp ? 'winner' : 'loser';
      const myOdds = b.player_key === 'A' ? b.pre_match_odds_a : b.pre_match_odds_b;
      const opOdds = b.player_key === 'A' ? b.pre_match_odds_b : b.pre_match_odds_a;
      if (myOdds == null || opOdds == null) { unclassified++; continue; }
      const fav = myOdds < opOdds ? 'fav' : 'dog';
      const c = cells[`S${entrySet}_${role}_${fav}`];
      c.count++; c.pnl += b.pnl || 0; c.stake += b.stake || 0; if ((b.pnl || 0) > 0) c.wins++;
    }
    for (const k in cells) {
      const c = cells[k];
      c.pnl = Math.round(c.pnl * 100) / 100;
      c.roi = c.stake > 0 ? Math.round((c.pnl / c.stake) * 1000) / 10 : null;
      c.winRate = c.count > 0 ? Math.round((c.wins / c.count) * 1000) / 10 : null;
    }
    res.json({ cells, unclassified, totalBets: bets.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function apiGetAnalysis(req, res) {
  // Cache-only — never invoke Claude from this GET endpoint.
  // To force a new run, POST to /api/analysis/strategies/refresh.
  try {
    const cached = strategyAnalyser.getCached();
    if (cached) return res.json({ ...cached, fromCache: true });
    res.json({ error: 'No analysis yet. Click Run Analysis to generate one.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function apiRefreshAnalysis(req, res) {
  try {
    const result = await strategyAnalyser.runAnalysis({ forceRefresh: true });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiGetAnalysisHistory(req, res) {
  try {
    res.json(strategyAnalyser.getHistory());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ── AI CHAT ──────────────────────────────────────────────────────────────────
function apiAiChatList(req, res) {
  try { res.json({ conversations: aiChat.listConversations() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
}
function apiAiChatGet(req, res) {
  try {
    const conv = aiChat.getConversation(Number(req.params.id));
    if (!conv) return res.status(404).json({ error: 'not found' });
    res.json({ conversation: conv });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
function apiAiChatCreate(req, res) {
  try { res.json({ id: aiChat.createConversation(req.body?.title) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
}
function apiAiChatRename(req, res) {
  try { aiChat.renameConversation(Number(req.params.id), String(req.body?.title || '').slice(0, 120)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
}
function apiAiChatDelete(req, res) {
  try { aiChat.deleteConversation(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
}
// Streaming endpoint — Server-Sent Events. aiChat.streamChat owns the response.
function apiAiChatStream(req, res) {
  aiChat.streamChat(req.body || {}, res).catch(e => {
    logger.error('apiAiChatStream failed', { message: e.message });
    try { if (!res.headersSent) res.status(500).json({ error: e.message }); else res.end(); } catch (_) {}
  });
}

function apiMissedBetsHistory(req, res) {
  try { res.json(missedBetsAnalyser.getHistory()); }
  catch (err) { res.status(500).json({ error: err.message }); }
}
function apiMissedBetsByDate(req, res) {
  try {
    const date = String(req.params.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date — expected YYYY-MM-DD' });
    const run = missedBetsAnalyser.getRun(date);
    if (!run) return res.status(404).json({ error: 'No run stored for that date' });
    res.json(run);
  } catch (err) { res.status(500).json({ error: err.message }); }
}
function apiMissedBetsRefresh(req, res) {
  try {
    const date = String(req.body?.date || req.query?.date || missedBetsAnalyser.yesterdayUtc()).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date — expected YYYY-MM-DD' });
    const run = missedBetsAnalyser.runAndStore(date);
    res.json(run);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function apiGetTradesCsv(req, res) {
  try {
    res.setHeader('Content-Disposition', 'attachment; filename="trade_log.csv"');
    res.setHeader('Content-Type', 'text/csv');
    if (!fs.existsSync(TRADE_LOG)) {
      return res.send('betId,marketId,matchName,playerName,side,odds,stake,liability,action,reason,placedAt,settledAt,pnl,dryRun\n');
    }
    res.sendFile(TRADE_LOG);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiPutStrategies(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }

  // Validate config before writing
  const errors = validateConfig(body);
  if (errors.length) {
    return res.status(422).json({ error: 'Validation failed', errors });
  }

  const tmp = STRATEGIES_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
    fs.renameSync(tmp, STRATEGIES_PATH);
    logger.info('Dashboard: strategies.json updated by user');
    broadcast('strategies_updated', { systems: (body.systems || []).map(s => s.name) });
    res.json({ ok: true });
  } catch (err) {
    logger.error('Dashboard: failed to write strategies', { message: err.message });
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    res.status(500).json({ error: 'Failed to write strategies.json' });
  }
}

function apiGetBacktestStrategies(req, res) {
  try {
    if (!fs.existsSync(BACKTEST_STRATEGIES_PATH)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(BACKTEST_STRATEGIES_PATH, 'utf8')));
  } catch (err) {
    logger.error('Dashboard: failed to read backtest strategies', { message: err.message });
    res.status(500).json({ error: 'Failed to read backtest_strategies.json' });
  }
}

function apiPutBacktestStrategies(req, res) {
  const body = req.body;
  if (!Array.isArray(body)) return res.status(400).json({ error: 'Body must be a JSON array' });
  const tmp = BACKTEST_STRATEGIES_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
    fs.renameSync(tmp, BACKTEST_STRATEGIES_PATH);
    res.json({ ok: true });
  } catch (err) {
    logger.error('Dashboard: failed to write backtest strategies', { message: err.message });
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
    res.status(500).json({ error: 'Failed to write backtest_strategies.json' });
  }
}

function apiGetBacktests(req, res) {
  try {
    res.json(backtestDb.getRuns());
  } catch (err) {
    logger.error('Dashboard: failed to read backtest runs', { message: err.message });
    res.status(500).json({ error: 'Failed to read backtest runs' });
  }
}

function apiPostBacktest(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Body must be a JSON object' });
  }
  try {
    const run = backtestDb.insertRun(body);
    res.json(run);
  } catch (err) {
    logger.error('Dashboard: failed to save backtest run', { message: err.message });
    res.status(500).json({ error: 'Failed to save backtest run' });
  }
}

function apiDeleteBacktest(req, res) {
  try {
    backtestDb.deleteRun(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    logger.error('Dashboard: failed to delete backtest run', { message: err.message });
    res.status(500).json({ error: 'Failed to delete backtest run' });
  }
}

function apiBacktestRunning(req, res) {
  res.json({ running: _backtestRunning });
}

function apiBacktestDbSummary(req, res) {
  try {
    const SnapshotLoader = require('../../backtest/snapshotLoader');
    const loader = new SnapshotLoader();
    const summary = loader.getDataSummary();
    loader.close();
    res.json(summary);
  } catch (err) {
    res.json({ completedMarkets: 0, totalSnapshots: 0, earliest: null, latest: null, error: err.message });
  }
}

function apiTriggerBacktest(req, res) {
  if (_backtestRunning) {
    return res.status(409).json({ error: 'A backtest is already running' });
  }

  const { from, to, strategy, notes, source } = req.body || {};

  const args = [];
  if (from)     args.push('--from',     from);
  if (to)       args.push('--to',       to);
  if (strategy) args.push('--strategy', strategy);
  if (notes)    args.push('--notes',    notes);
  if (source)   args.push('--source',   source);   // 'db' for captured data

  _backtestRunning = true;
  broadcast('backtest_started', { from: from || null, to: to || null, strategy: strategy || null });

  const child = spawn(process.execPath, [RUNNER_PATH, ...args], {
    cwd: path.join(__dirname, '../..'),
    env: process.env,
  });

  child.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) broadcast('backtest_progress', { line: line.trimEnd() });
    }
  });

  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) broadcast('backtest_progress', { line: line.trimEnd() });
    }
  });

  child.on('close', (code) => {
    _backtestRunning = false;
    if (code === 0) {
      broadcast('backtest_complete', {});
    } else {
      broadcast('backtest_error', { message: `Backtest process exited with code ${code}` });
    }
  });

  res.json({ ok: true });
}

function apiGetBreakdown(req, res) {
  try {
    res.json(backtestDb.getStrategyBreakdown(req.params.id));
  } catch (err) {
    logger.error('Dashboard: failed to read strategy breakdown', { message: err.message });
    res.status(500).json({ error: 'Failed to read strategy breakdown' });
  }
}

function apiGetBets(req, res) {
  try {
    res.json(backtestDb.getBets(req.params.id));
  } catch (err) {
    logger.error('Dashboard: failed to read bet records', { message: err.message });
    res.status(500).json({ error: 'Failed to read bet records' });
  }
}

function apiBacktestStrategyStats(req, res) {
  try {
    const runs = backtestDb.getRuns();
    if (!runs.length) return res.json({});
    const latest    = runs[0]; // already sorted newest first
    const breakdown = backtestDb.getStrategyBreakdown(latest.id);
    const stats = {};
    for (const s of breakdown) {
      const complete = s.betsPlaced - (s.incomplete || 0);
      stats[s.strategyName] = {
        bets:    s.betsPlaced,
        wins:    s.betsWon,
        winRate: complete > 0 ? parseFloat((s.betsWon / complete * 100).toFixed(1)) : null,
        pnl:     s.totalPnl,
        roi:     s.betsPlaced > 0 ? parseFloat((s.totalPnl / s.betsPlaced * 100).toFixed(1)) : null,
        ranAt:   latest.ranAt,
      };
    }
    res.json(stats);
  } catch (err) {
    logger.error('Dashboard: failed to read strategy stats', { message: err.message });
    res.status(500).json({ error: 'Failed to read strategy stats' });
  }
}

function apiGetPerformance(req, res) {
  try {
    const allRows = readAllTrades();
    const placed  = allRows.filter(r => r.action === 'BET_PLACED');
    const settled = allRows.filter(r => ['SETTLE', 'TRADE_OUT', 'DRY_WIN', 'DRY_LOSS'].includes(r.action));

    // Build a pnl lookup: betId → pnl
    const pnlByBetId = {};
    for (const r of settled) {
      if (r.betId && r.pnl !== '' && r.pnl != null) {
        pnlByBetId[r.betId] = parseFloat(r.pnl);
      }
    }

    // Also index TRADE_OUT rows by marketId (DRY_RUN bets share marketId)
    const pnlByMarketId = {};
    for (const r of settled) {
      if (r.marketId && r.pnl !== '' && r.pnl != null) {
        pnlByMarketId[r.marketId] = parseFloat(r.pnl);
      }
    }

    // Seed bySystem with all configured strategies so they always appear
    const bySystem = {};
    try {
      const cfg = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf8'));
      for (const s of (cfg.systems || [])) {
        bySystem[s.name] = { bets: [], name: s.name };
      }
    } catch (_) {}

    // Group bets by strategy name (extracted from the reason field: "Strategy X: …")
    for (const bet of placed) {
      // reason looks like "Strategy 2: set 1 complete 4-6 …"
      const match = (bet.reason || '').match(/^([^:]+):/);
      const sysName = match ? match[1].trim() : null;
      if (!sysName) continue;  // skip test/unknown entries

      if (!bySystem[sysName]) {
        bySystem[sysName] = { bets: [], name: sysName };
      }

      const pnl = pnlByBetId[bet.betId] ?? pnlByMarketId[bet.marketId] ?? null;
      bySystem[sysName].bets.push({
        betId:      bet.betId,
        matchName:  bet.matchName,
        playerName: bet.playerName,
        side:       bet.side,
        odds:       parseFloat(bet.odds) || null,
        stake:      parseFloat(bet.stake) || null,
        placedAt:   bet.placedAt,
        settledAt:  bet.settledAt || null,
        pnl,
        dryRun:     bet.dryRun === 'true',
        reason:     bet.reason,
      });
    }

    // Build summary stats per system
    const systems = Object.values(bySystem).map(s => {
      const bets       = s.bets;
      const total      = bets.length;
      const settledB   = bets.filter(b => b.pnl != null);
      const wins       = settledB.filter(b => b.pnl > 0).length;
      const totalPnl   = settledB.reduce((sum, b) => sum + b.pnl, 0);
      const winRate    = settledB.length > 0 ? wins / settledB.length * 100 : null;
      const roi        = settledB.length > 0 ? totalPnl / settledB.length * 100 : null;
      const avgOdds    = total > 0
        ? bets.reduce((sum, b) => sum + (b.odds || 0), 0) / total
        : null;
      // Build chronological P&L series (one point per settled bet)
      const pnlSeries  = settledB
        .sort((a, b) => new Date(a.placedAt) - new Date(b.placedAt))
        .map(b => b.pnl);
      const cumPnl     = pnlSeries.reduce((acc, v) => {
        acc.push((acc[acc.length - 1] || 0) + v);
        return acc;
      }, []);

      return {
        name:       s.name,
        bets:       total,
        settled:    settledB.length,
        wins,
        winRate:    winRate != null ? parseFloat(winRate.toFixed(1)) : null,
        pnl:        parseFloat(totalPnl.toFixed(2)),
        roi:        roi != null ? parseFloat(roi.toFixed(1)) : null,
        avgOdds:    avgOdds != null ? parseFloat(avgOdds.toFixed(2)) : null,
        pnlSeries,
        cumPnl,
        recentBets: bets.slice(-20).reverse(),
      };
    });

    systems.sort((a, b) => a.name.localeCompare(b.name));

    res.json({ systems });
  } catch (err) {
    logger.error('Dashboard: failed to build performance data', { message: err.message });
    res.status(500).json({ error: 'Failed to build performance data' });
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection handler
// ---------------------------------------------------------------------------

function onWsConnection(ws) {
  logger.debug('Dashboard: browser connected');

  // Send full state immediately so the page renders without waiting for next tick
  const initData = {
    summary:         buildSummary(),
    matches:         buildMatchSnapshots(),
    open:            buildOpenOrders(),
    settled:         readSettledTrades(20),
    daily:           buildDailyPnl(30),
    backtestRunning: _backtestRunning,
    matchHistory:    Object.fromEntries(_matchHistoryStore),
  };
  ws.send(JSON.stringify({ event: 'init', data: initData, ts: Date.now() }));

  ws.on('error', (err) => {
    logger.debug('Dashboard: WS client error', { message: err.message });
  });
}

// ---------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------

function apiSummary(req, res) {
  res.json(buildSummary());
}

function apiTradesDaily(req, res) {
  res.json(buildDailyPnl(30));
}

function apiTradesOpen(req, res) {
  res.json(buildOpenOrders());
}

function apiTradesSettled(req, res) {
  const limit = parseInt(req.query.limit || '50', 10);
  res.json(readSettledTrades(limit));
}

function apiMatches(req, res) {
  res.json(buildMatchSnapshots());
}

function apiStatsStatus(req, res) {
  if (!_stateStore) return res.json({ total: 0, linked: 0, withStats: 0, matches: [] });
  const all = _stateStore.getAll();
  const matches = all.map(m => ({
    matchName:    m.matchName,
    externalId:   m.externalMatchId || null,
    linked:       !!m.externalMatchId,
    hasServeStats: !!(
      m.liveServeStats?.playerA?.firstServeIn != null ||
      m.liveServeStats?.playerB?.firstServeIn != null
    ),
  }));
  res.json({
    total:     matches.length,
    linked:    matches.filter(m => m.linked).length,
    withStats: matches.filter(m => m.hasServeStats).length,
    matches,
  });
}

async function apiDebugStatsRaw(req, res) {
  const apiKey = process.env.API_TENNIS_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API_TENNIS_KEY not set' });

  const http2 = axios.create({
    baseURL: 'https://api.api-tennis.com/tennis/',
    timeout: 10_000,
    headers: { Accept: 'application/json' },
  });

  // If ?matchId= provided, return the full livescore entry for that event_key
  const matchId = req.query.matchId;
  if (matchId) {
    try {
      const resp = await http2.get('', { params: { method: 'get_livescore', APIkey: apiKey, match_key: matchId } });
      return res.json({ matchId, raw: resp.data });
    } catch (err) {
      return res.status(500).json({ error: err.message, status: err.response?.status });
    }
  }

  // Otherwise return the full livescore (all live events) — useful for inspecting field shapes
  try {
    const resp = await http2.get('', { params: { method: 'get_livescore', APIkey: apiKey } });
    const results = Array.isArray(resp.data?.result) ? resp.data.result : [];
    const singles = results.filter(e =>
      !String(e.event_first_player  || '').includes('/') &&
      !String(e.event_second_player || '').includes('/')
    );
    res.json({
      totalEvents:   results.length,
      singlesEvents: singles.length,
      firstSingles:  singles[0] || null,
      allEvents:     results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response?.status });
  }
}

/**
 * GET /api/debug/link-gaps
 * Shows which Betfair markets have no TennisAPI match and which TennisAPI events
 * have no Betfair market — so you can see exactly why coverage is low.
 */
async function apiDebugLinkGaps(req, res) {
  const apiKey = process.env.API_TENNIS_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API_TENNIS_KEY not set' });
  if (!_stateStore) return res.status(500).json({ error: 'stateStore not ready' });

  const http2 = axios.create({
    baseURL: 'https://api.api-tennis.com/tennis/',
    timeout: 10_000,
    headers: { Accept: 'application/json' },
  });

  try {
    const resp = await http2.get('', { params: { method: 'get_livescore', APIkey: apiKey } });
    const results = Array.isArray(resp.data?.result) ? resp.data.result : [];

    // Singles only, currently live
    const apiEvents = results
      .filter(e =>
        String(e.event_live) === '1' &&
        !String(e.event_first_player  || '').includes('/') &&
        !String(e.event_second_player || '').includes('/')
      )
      .map(e => ({
        id:         String(e.event_key),
        name:       `${e.event_first_player} v ${e.event_second_player}`,
        tournament: e.tournament_name || '',
        status:     e.event_status || '',
      }));

    const betfairMarkets = _stateStore.getAll().map(m => ({
      marketId:   m.betfairMarketId,
      name:       m.matchName,
      linked:     !!m.externalMatchId,
      externalId: m.externalMatchId || null,
      rank:       m.playerARank != null ? `${m.playerARank} / ${m.playerBRank}` : null,
      hasStats:   !!(m.liveServeStats?.playerA?.firstServeWon != null || m.liveServeStats?.playerB?.firstServeWon != null),
    }));

    const linkedExternalIds = new Set(
      betfairMarkets.filter(m => m.linked).map(m => m.externalId)
    );

    res.json({
      betfairTotal:     betfairMarkets.length,
      betfairLinked:    betfairMarkets.filter(m => m.linked).length,
      betfairWithStats: betfairMarkets.filter(m => m.hasStats).length,
      apiEventsTotal:   results.length,
      apiEventsSingles: apiEvents.length,
      betfairUnlinked:  betfairMarkets.filter(m => !m.linked).map(m => m.name),
      apiUnlinked:      apiEvents.filter(e => !linkedExternalIds.has(`at:${e.id}`))
                          .map(e => ({ id: e.id, name: e.name, tournament: e.tournament })),
      linked:           betfairMarkets.filter(m => m.linked).map(m => ({
        betfairName: m.name,
        externalId:  m.externalId,
        ranks:       m.rank,
        hasStats:    m.hasStats,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Data builders
// ---------------------------------------------------------------------------

function buildSummary() {
  const rows     = readAllTrades();
  const SETTLED  = new Set(['SETTLE', 'TRADE_OUT', 'DRY_WIN', 'DRY_LOSS']);
  const settled  = rows.filter(r => SETTLED.has(r.action));
  const winners  = settled.filter(r => parseFloat(r.pnl) > 0);

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayPnl = settled
    .filter(r => r.timestamp?.slice(0, 10) === todayStr)
    .reduce((s, r) => s + (parseFloat(r.pnl) || 0), 0);

  const openBets       = _orderManager ? _orderManager.openOrders.size : 0;
  const marketsWatched = _stateStore   ? _stateStore.matches.size      : 0;

  return {
    pnlToday:       parseFloat(todayPnl.toFixed(2)),
    openBets,
    marketsWatched,
    winRate:        settled.length ? winners.length / settled.length : 0,
    winBets:        winners.length,
    totalBets:      settled.length,
    isRunning:      Date.now() - _lastHeartbeat < BOT_TIMEOUT_MS,
    dryRun:         process.env.DRY_RUN === 'true',
    minLiveVol:     _minLiveVol,
  };
}

function buildDailyPnl(days) {
  const rows     = readAllTrades();
  const SETTLED  = new Set(['SETTLE', 'TRADE_OUT', 'DRY_WIN', 'DRY_LOSS']);
  const settled  = rows.filter(r => SETTLED.has(r.action));

  // Build a map of date → daily P&L
  const byDate = {};
  for (const row of settled) {
    const date = row.timestamp?.slice(0, 10);
    if (!date) continue;
    byDate[date] = (byDate[date] || 0) + (parseFloat(row.pnl) || 0);
  }

  // Generate the last `days` calendar dates
  const result    = [];
  let   cumulative = 0;

  for (let i = days - 1; i >= 0; i--) {
    const d   = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const pnl     = parseFloat((byDate[dateStr] || 0).toFixed(2));
    cumulative    = parseFloat((cumulative + pnl).toFixed(2));
    result.push({ date: dateStr, pnl, cumulative });
  }

  return result;
}

function buildOpenOrders() {
  if (!_orderManager) return [];
  return [..._orderManager.openOrders.values()].map(o => ({
    betId:        o.betId,
    marketId:     o.marketId,
    matchName:    o.matchName,
    side:         o.side,
    odds:         o.odds,
    stake:        o.stake,
    playerName:   o.playerName,
    playerKey:    o.playerKey,
    strategyName: o.strategyName,
    reason:       o.reason,
    placedAt:     o.placedAt,
    dryRun:       o.dryRun,
  }));
}

function buildMatchSnapshots() {
  if (!_stateStore) return [];

  // Re-read strategies from disk each time so dashboard edits are reflected immediately
  let systems = [];
  let stratConfig = {};
  try {
    stratConfig = JSON.parse(fs.readFileSync(STRATEGIES_PATH, 'utf8'));
    systems = stratConfig.systems || [];
  } catch (_) {}

  return _stateStore.getAll()
    .filter(m => (m.isInPlay || m.status === 'LIVE') && (m.matchedVolume || 0) >= _minLiveVol)
    .map(m => {
      const snap = m.toSnapshot();
      snap.qualifyingSystems = systemEvaluator
        .evaluateSystems(m, systems, stratConfig)
        .map(s => s.systemName);

      if (snap.odds) {
        snap.playerABack   = snap.odds.playerABack;
        snap.playerALay    = snap.odds.playerALay;
        snap.playerBBack   = snap.odds.playerBBack;
        snap.playerBLay    = snap.odds.playerBLay;
        snap.matchedVolume = snap.odds.matchedVolume;
      }

      return snap;
    });
}

function readSettledTrades(limit) {
  const SETTLED = new Set(['SETTLE', 'TRADE_OUT', 'DRY_WIN', 'DRY_LOSS']);
  const rows = readAllTrades()
    .filter(r => SETTLED.has(r.action))
    .reverse()
    .slice(0, limit);
  return rows;
}

// ---------------------------------------------------------------------------
// CSV reader
// ---------------------------------------------------------------------------

function readAllTrades() {
  try {
    if (!fs.existsSync(TRADE_LOG)) return [];
    const raw   = fs.readFileSync(TRADE_LOG, 'utf8').trim();
    const lines = raw.split('\n');
    if (lines.length < 2) return [];

    const headers = parseCsvLine(lines[0]);
    return lines.slice(1)
      .filter(l => l.trim())
      .map(line => {
        const values = parseCsvLine(line);
        const obj    = {};
        headers.forEach((h, i) => { obj[h.trim()] = (values[i] || '').trim(); });
        return obj;
      });
  } catch (err) {
    logger.error('Dashboard: failed to read trade log', { message: err.message });
    return [];
  }
}

// ---------------------------------------------------------------------------
// SQLite-backed API handlers (Phase 2)
// ---------------------------------------------------------------------------

function apiDbSummary(req, res) {
  try {
    const pnlByStrategy = betRepo.getPnlByStrategy();
    const totalPnl  = pnlByStrategy.reduce((s, r) => s + (r.total_pnl || 0), 0);
    const totalBets = pnlByStrategy.reduce((s, r) => s + (r.total_bets || 0), 0);
    const totalWins = pnlByStrategy.reduce((s, r) => s + (r.wins || 0), 0);
    const openBets  = _orderManager ? _orderManager.openOrders.size : 0;
    const eventCounts = systemEventRepo.countByLevel('-24 hours');
    const liveMarkets = _stateStore ? _stateStore.getAll().filter(m => m.isInPlay && m.status === 'LIVE') : [];
    res.json({
      isRunning:      Date.now() - _lastHeartbeat < BOT_TIMEOUT_MS,
      dryRun:         process.env.DRY_RUN === 'true',
      openBets,
      marketsWatched: _stateStore ? _stateStore.matches.size : 0,
      liveMatches:    liveMarkets.length,
      pnlToday:       parseFloat((_orderManager?.getPnlToday() ?? 0).toFixed(2)),
      totalPnl:       parseFloat(totalPnl.toFixed(2)),
      totalBets,
      totalWins,
      winRate:        totalBets > 0 ? parseFloat((totalWins / totalBets * 100).toFixed(1)) : 0,
      errorsLast24h:  eventCounts.ERROR,
      warnsLast24h:   eventCounts.WARN,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbClearBets(req, res) {
  try {
    betRepo.clearAll();
    logger.info('Dashboard: bet history cleared by user');
    res.json({ ok: true });
  } catch (err) {
    logger.error('Dashboard: failed to clear bet history', { message: err.message });
    res.status(500).json({ error: err.message });
  }
}

function apiDbDeleteBet(req, res) {
  try {
    betRepo.deleteById(req.params.betId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function apiInternalBetfairPrices(req, res) {
  // Localhost-only — guards against external exposure since this skips auth.
  const ip = (req.ip || req.connection?.remoteAddress || '').replace('::ffff:', '');
  if (ip !== '127.0.0.1' && ip !== '::1') {
    return res.status(403).json({ error: 'localhost only' });
  }
  if (!_betfairClient) return res.status(503).json({ error: 'betfair client not ready' });
  const marketId    = req.query.marketId;
  const overSelId   = req.query.overSelectionId;
  if (!marketId) return res.status(400).json({ error: 'marketId required' });

  try {
    const books = await _betfairClient.listMarketBook([marketId]);
    const book  = Array.isArray(books) ? books[0] : null;
    if (!book) return res.json({ marketId, over: null, under: null });
    const runners = book.runners || [];
    const priceOf = (r) => r?.ex?.availableToBack?.[0]?.price ?? r?.lastPriceTraded ?? null;
    if (overSelId) {
      const over  = runners.find(r => String(r.selectionId) === String(overSelId));
      const under = runners.find(r => String(r.selectionId) !== String(overSelId));
      return res.json({
        marketId,
        over:  over  ? priceOf(over)  : null,
        under: under ? priceOf(under) : null,
        inplay: book.inplay || false,
      });
    }
    // No selection hint — return both runners
    return res.json({
      marketId,
      runners: runners.map(r => ({ selectionId: r.selectionId, price: priceOf(r) })),
      inplay: book.inplay || false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDeltaQualityPreset(req, res) {
  try {
    const sqDeltaFilter = require('../analysis/sqDeltaFilter');
    res.json(sqDeltaFilter.getPreset());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbBets(req, res) {
  try {
    const limit    = Math.min(parseInt(req.query.limit  || '500', 10), 2000);
    const offset   = parseInt(req.query.offset || '0', 10);
    const since    = req.query.since || '-30 days';
    const strategy = req.query.strategy || null;

    let rows = betRepo.getRecent(since, limit + offset);
    if (strategy) rows = rows.filter(r => r.strategy_name === strategy);

    // Decorate each bet with serve-quality composite scores derived from the
    // pre-entry serve_stats snapshot so the bets CSV / UI table can show SQ
    // without a second round-trip. Drops the raw JSON blob from the payload.
    const _sq = stats => stats ? serveScorer.score(stats).score : null;
    for (const r of rows) {
      let serveStats = null;
      try { serveStats = r.snapshot_serve_stats ? JSON.parse(r.snapshot_serve_stats) : null; } catch (_) {}
      delete r.snapshot_serve_stats;
      const s1 = serveStats?.set1, s2 = serveStats?.set2, s3 = serveStats?.set3, sM = serveStats?.match;
      r.serve_quality_s1_a    = _sq(s1?.playerA); r.serve_quality_s1_b    = _sq(s1?.playerB);
      r.serve_quality_s2_a    = _sq(s2?.playerA); r.serve_quality_s2_b    = _sq(s2?.playerB);
      r.serve_quality_s3_a    = _sq(s3?.playerA); r.serve_quality_s3_b    = _sq(s3?.playerB);
      r.serve_quality_match_a = _sq(sM?.playerA); r.serve_quality_match_b = _sq(sM?.playerB);
      const _d = (a, b) => (a != null && b != null) ? a - b : null;
      r.serve_quality_diff_s1    = _d(r.serve_quality_s1_a,    r.serve_quality_s1_b);
      r.serve_quality_diff_s2    = _d(r.serve_quality_s2_a,    r.serve_quality_s2_b);
      r.serve_quality_diff_s3    = _d(r.serve_quality_s3_a,    r.serve_quality_s3_b);
      r.serve_quality_diff_match = _d(r.serve_quality_match_a, r.serve_quality_match_b);
      // Bet-player − opponent SQ diff (handy for sort/filter)
      const flip = v => (v == null ? null : -v);
      const setN = parseInt((r.reason || '').match(/set\s+(\d+)\s+complete/i)?.[1] || '1', 10);
      const triggerDiffAB = setN === 2 ? r.serve_quality_diff_s2 : r.serve_quality_diff_s1;
      r.bet_player_serve_quality_diff_trigger = r.player_key === 'A' ? triggerDiffAB : flip(triggerDiffAB);
      // Absolute SQ for bet-player and opponent at trigger set (handy for range filters)
      const sqA = setN === 2 ? r.serve_quality_s2_a : r.serve_quality_s1_a;
      const sqB = setN === 2 ? r.serve_quality_s2_b : r.serve_quality_s1_b;
      r.bet_player_serve_quality_trigger = r.player_key === 'A' ? sqA : sqB;
      r.opp_serve_quality_trigger        = r.player_key === 'A' ? sqB : sqA;
      // Per-set bet-player SQ Δ (consistent sign perspective for swing detection)
      r.bet_player_serve_quality_diff_s1    = r.player_key === 'A' ? r.serve_quality_diff_s1    : flip(r.serve_quality_diff_s1);
      r.bet_player_serve_quality_diff_s2    = r.player_key === 'A' ? r.serve_quality_diff_s2    : flip(r.serve_quality_diff_s2);
      r.bet_player_serve_quality_diff_match = r.player_key === 'A' ? r.serve_quality_diff_match : flip(r.serve_quality_diff_match);
      // Expose raw per-set serve stats for CSV consumers
      const _raw = ps => ps ? {
        firstServeIn:       ps.firstServeIn       ?? null,
        firstServeWon:      ps.firstServeWon      ?? null,
        secondServeWon:     ps.secondServeWon     ?? null,
        aces:               ps.aces               ?? null,
        doubleFaults:       ps.doubleFaults       ?? null,
        breakpointsWon:     ps.breakpointsWon     ?? null,
        breakpointsCreated: ps.breakpointsCreated ?? null,
      } : null;
      for (const [tag, src] of [['s1', s1], ['s2', s2], ['s3', s3], ['match', sM]]) {
        const a = _raw(src?.playerA), b = _raw(src?.playerB);
        r[`serve_${tag}_a_firstServeIn`]       = a?.firstServeIn       ?? null;
        r[`serve_${tag}_a_firstServeWon`]      = a?.firstServeWon      ?? null;
        r[`serve_${tag}_a_secondServeWon`]     = a?.secondServeWon     ?? null;
        r[`serve_${tag}_a_aces`]               = a?.aces               ?? null;
        r[`serve_${tag}_a_doubleFaults`]       = a?.doubleFaults       ?? null;
        r[`serve_${tag}_a_breakpointsWon`]     = a?.breakpointsWon     ?? null;
        r[`serve_${tag}_a_breakpointsCreated`] = a?.breakpointsCreated ?? null;
        r[`serve_${tag}_b_firstServeIn`]       = b?.firstServeIn       ?? null;
        r[`serve_${tag}_b_firstServeWon`]      = b?.firstServeWon      ?? null;
        r[`serve_${tag}_b_secondServeWon`]     = b?.secondServeWon     ?? null;
        r[`serve_${tag}_b_aces`]               = b?.aces               ?? null;
        r[`serve_${tag}_b_doubleFaults`]       = b?.doubleFaults       ?? null;
        r[`serve_${tag}_b_breakpointsWon`]     = b?.breakpointsWon     ?? null;
        r[`serve_${tag}_b_breakpointsCreated`] = b?.breakpointsCreated ?? null;
      }
    }

    res.json({
      total: betRepo.countAll(),
      bets:  rows.slice(offset, offset + limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbPerformance(req, res) {
  try {
    res.json(betRepo.getPnlByStrategy());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbDailyPnl(req, res) {
  try {
    res.json(betRepo.getDailyPnl());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbEntryData(req, res) {
  try {
    const _entryDataQuery = db.prepare(`
      SELECT
        b.bet_id, b.strategy_name, b.player_key, b.player_name, b.side,
        b.requested_odds, b.actual_odds, b.stake, b.pnl, b.settlement_type,
        b.placed_at, b.settled_at, b.reason, b.dry_run, b.hedge_odds,
        m.match_name, m.surface, m.tournament, m.tournament_round,
        m.pre_match_odds_a, m.pre_match_odds_b, m.pre_match_volume,
        m.player_a_name, m.player_b_name,
        m.went_in_play_at, m.ended_at, m.final_sets, m.winner,
        (SELECT s.sets       FROM market_snapshots s
         WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at
         ORDER BY s.ts DESC LIMIT 1) AS snapshot_sets,
        (SELECT s.serve_stats FROM market_snapshots s
         WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at
         ORDER BY s.ts DESC LIMIT 1) AS snapshot_serve_stats,
        (SELECT s.momentum_index FROM market_snapshots s
         WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at
         ORDER BY s.ts DESC LIMIT 1) AS snapshot_momentum,
        (SELECT s.matched_volume FROM market_snapshots s
         WHERE s.betfair_market_id = b.betfair_market_id AND s.ts <= b.placed_at
         ORDER BY s.ts DESC LIMIT 1) AS snapshot_volume
      FROM bets b
      JOIN markets m ON m.betfair_market_id = b.betfair_market_id
      WHERE b.strategy_name IS NOT NULL
        AND (b.settlement_type IS NULL OR b.settlement_type != 'CANCELLED')
      ORDER BY b.placed_at DESC
    `);

    const rows = _entryDataQuery.all();
    const byStrategy = {};

    for (const row of rows) {
      const strat = row.strategy_name;
      if (!byStrategy[strat]) byStrategy[strat] = [];

      const scoreMatch = (row.reason || '').match(/set \d+ complete ([\d]+-[\d]+)/i);

      let serveStats = null;
      try { serveStats = row.snapshot_serve_stats ? JSON.parse(row.snapshot_serve_stats) : null; } catch (_) {}
      const s1 = serveStats?.set1 || null;
      const s2 = serveStats?.set2 || null;
      const s3 = serveStats?.set3 || null;
      const sM = serveStats?.match || null;

      // Final set scores from the markets row (always available once match ended)
      let finalSets = null;
      try { finalSets = row.final_sets ? JSON.parse(row.final_sets) : null; } catch (_) {}
      const finalSetsArr = Array.isArray(finalSets) ? finalSets : [];
      const setScoreStr = finalSetsArr.map(s => Array.isArray(s) ? s.join('-') : (s?.playerA != null ? `${s.playerA}-${s.playerB}` : '')).filter(Boolean).join(' ');

      // Pre-compute 1st-serve-won % differentials so the entry CSV / AI tools
      // can sort/filter without re-deriving each time.
      const _diff = (a, b) => (a != null && b != null) ? +(a - b).toFixed(1) : null;
      const s1DiffAB = _diff(s1?.playerA?.firstServeWon, s1?.playerB?.firstServeWon);
      const s2DiffAB = _diff(s2?.playerA?.firstServeWon, s2?.playerB?.firstServeWon);
      const s3DiffAB = _diff(s3?.playerA?.firstServeWon, s3?.playerB?.firstServeWon);
      const matchDiffAB = _diff(sM?.playerA?.firstServeWon, sM?.playerB?.firstServeWon);
      const betKey = row.player_key;
      const flip = v => (v == null ? null : -v);
      const betPlayerS1Diff = betKey === 'A' ? s1DiffAB    : flip(s1DiffAB);
      const betPlayerS2Diff = betKey === 'A' ? s2DiffAB    : flip(s2DiffAB);
      const betPlayerS3Diff = betKey === 'A' ? s3DiffAB    : flip(s3DiffAB);
      const betPlayerMatchDiff = betKey === 'A' ? matchDiffAB : flip(matchDiffAB);

      // Serve quality composite scores per set (0–100) for both players + the
      // bet-player vs opponent differential. Drives the SQ columns in the UI
      // tables and the CSV export.
      const sqScore = stats => stats ? serveScorer.score(stats).score : null;
      const sqA1 = sqScore(s1?.playerA); const sqB1 = sqScore(s1?.playerB);
      const sqA2 = sqScore(s2?.playerA); const sqB2 = sqScore(s2?.playerB);
      const sqA3 = sqScore(s3?.playerA); const sqB3 = sqScore(s3?.playerB);
      const sqAM = sqScore(sM?.playerA); const sqBM = sqScore(sM?.playerB);
      const sqDiff = (a, b) => (a != null && b != null) ? a - b : null;
      const sqDiffS1AB    = sqDiff(sqA1, sqB1);
      const sqDiffS2AB    = sqDiff(sqA2, sqB2);
      const sqDiffS3AB    = sqDiff(sqA3, sqB3);
      const sqDiffMatchAB = sqDiff(sqAM, sqBM);
      const betPlayerSqDiffS1    = betKey === 'A' ? sqDiffS1AB    : flip(sqDiffS1AB);
      const betPlayerSqDiffS2    = betKey === 'A' ? sqDiffS2AB    : flip(sqDiffS2AB);
      const betPlayerSqDiffS3    = betKey === 'A' ? sqDiffS3AB    : flip(sqDiffS3AB);
      const betPlayerSqDiffMatch = betKey === 'A' ? sqDiffMatchAB : flip(sqDiffMatchAB);

      const outcome = row.pnl == null ? 'OPEN'
        : row.pnl > 0 ? 'WIN'
        : row.pnl < 0 ? 'LOSS'
        : 'VOID';

      const pickStat = (obj, key) => obj?.[key] != null ? +obj[key].toFixed(1) : null;

      byStrategy[strat].push({
        betId:          row.bet_id,
        matchName:      row.match_name,
        surface:        row.surface || null,
        tournament:     row.tournament || null,
        playerAName:    row.player_a_name || 'P1',
        playerBName:    row.player_b_name || 'P2',
        playerKey:      row.player_key,
        playerName:     row.player_name,
        side:           row.side,
        entryOdds:      row.actual_odds || row.requested_odds,
        stake:          row.stake,
        pnl:            row.pnl,
        outcome,
        dryRun:         row.dry_run === 1,
        placedAt:       row.placed_at,
        triggerSetScore: scoreMatch ? scoreMatch[1] : null,
        preMatchA:      row.pre_match_odds_a,
        preMatchB:      row.pre_match_odds_b,
        serveSet1A: s1?.playerA ? {
          firstIn:   pickStat(s1.playerA, 'firstServeIn'),
          firstWon:  pickStat(s1.playerA, 'firstServeWon'),
          secondWon: pickStat(s1.playerA, 'secondServeWon'),
          aces:      s1.playerA.aces ?? null,
          dfs:       s1.playerA.doubleFaults ?? null,
          bpWon:     pickStat(s1.playerA, 'breakpointsWon'),
        } : null,
        serveSet1B: s1?.playerB ? {
          firstIn:   pickStat(s1.playerB, 'firstServeIn'),
          firstWon:  pickStat(s1.playerB, 'firstServeWon'),
          secondWon: pickStat(s1.playerB, 'secondServeWon'),
          aces:      s1.playerB.aces ?? null,
          dfs:       s1.playerB.doubleFaults ?? null,
          bpWon:     pickStat(s1.playerB, 'breakpointsWon'),
        } : null,
        serveSet2A: s2?.playerA ? {
          firstIn:   pickStat(s2.playerA, 'firstServeIn'),
          firstWon:  pickStat(s2.playerA, 'firstServeWon'),
          secondWon: pickStat(s2.playerA, 'secondServeWon'),
          aces:      s2.playerA.aces ?? null,
          dfs:       s2.playerA.doubleFaults ?? null,
          bpWon:     pickStat(s2.playerA, 'breakpointsWon'),
        } : null,
        serveSet2B: s2?.playerB ? {
          firstIn:   pickStat(s2.playerB, 'firstServeIn'),
          firstWon:  pickStat(s2.playerB, 'firstServeWon'),
          secondWon: pickStat(s2.playerB, 'secondServeWon'),
          aces:      s2.playerB.aces ?? null,
          dfs:       s2.playerB.doubleFaults ?? null,
          bpWon:     pickStat(s2.playerB, 'breakpointsWon'),
        } : null,
        serveSet3A: s3?.playerA ? {
          firstIn:   pickStat(s3.playerA, 'firstServeIn'),
          firstWon:  pickStat(s3.playerA, 'firstServeWon'),
          secondWon: pickStat(s3.playerA, 'secondServeWon'),
          aces:      s3.playerA.aces ?? null,
          dfs:       s3.playerA.doubleFaults ?? null,
          bpWon:     pickStat(s3.playerA, 'breakpointsWon'),
        } : null,
        serveSet3B: s3?.playerB ? {
          firstIn:   pickStat(s3.playerB, 'firstServeIn'),
          firstWon:  pickStat(s3.playerB, 'firstServeWon'),
          secondWon: pickStat(s3.playerB, 'secondServeWon'),
          aces:      s3.playerB.aces ?? null,
          dfs:       s3.playerB.doubleFaults ?? null,
          bpWon:     pickStat(s3.playerB, 'breakpointsWon'),
        } : null,
        serveMatchA: sM?.playerA ? {
          firstIn:   pickStat(sM.playerA, 'firstServeIn'),
          firstWon:  pickStat(sM.playerA, 'firstServeWon'),
          secondWon: pickStat(sM.playerA, 'secondServeWon'),
          aces:      sM.playerA.aces ?? null,
          dfs:       sM.playerA.doubleFaults ?? null,
          bpWon:     pickStat(sM.playerA, 'breakpointsWon'),
        } : null,
        serveMatchB: sM?.playerB ? {
          firstIn:   pickStat(sM.playerB, 'firstServeIn'),
          firstWon:  pickStat(sM.playerB, 'firstServeWon'),
          secondWon: pickStat(sM.playerB, 'secondServeWon'),
          aces:      sM.playerB.aces ?? null,
          dfs:       sM.playerB.doubleFaults ?? null,
          bpWon:     pickStat(sM.playerB, 'breakpointsWon'),
        } : null,
        // 1st-serve-won % differentials per set + match (A minus B)
        s1FirstWonDiff:        s1DiffAB,
        s2FirstWonDiff:        s2DiffAB,
        s3FirstWonDiff:        s3DiffAB,
        matchFirstWonDiff:     matchDiffAB,
        betPlayerS1FirstWonDiff:    betPlayerS1Diff,
        betPlayerS2FirstWonDiff:    betPlayerS2Diff,
        betPlayerS3FirstWonDiff:    betPlayerS3Diff,
        betPlayerMatchFirstWonDiff: betPlayerMatchDiff,
        // Serve quality composite scores (0–100) per set + match
        serveQualityS1A: sqA1, serveQualityS1B: sqB1,
        serveQualityS2A: sqA2, serveQualityS2B: sqB2,
        serveQualityS3A: sqA3, serveQualityS3B: sqB3,
        serveQualityMatchA: sqAM, serveQualityMatchB: sqBM,
        serveQualityDiffS1AB:    sqDiffS1AB,
        serveQualityDiffS2AB:    sqDiffS2AB,
        serveQualityDiffS3AB:    sqDiffS3AB,
        serveQualityDiffMatchAB: sqDiffMatchAB,
        betPlayerServeQualityDiffS1:    betPlayerSqDiffS1,
        betPlayerServeQualityDiffS2:    betPlayerSqDiffS2,
        betPlayerServeQualityDiffS3:    betPlayerSqDiffS3,
        betPlayerServeQualityDiffMatch: betPlayerSqDiffMatch,
        // Match outcome + venue context
        tournamentRound:       row.tournament_round || null,
        preMatchVolume:        row.pre_match_volume,
        snapshotMomentumAtEntry: row.snapshot_momentum,
        snapshotVolumeAtEntry:   row.snapshot_volume,
        wentInPlayAt:          row.went_in_play_at,
        endedAt:               row.ended_at,
        settledAt:             row.settled_at,
        hedgeOdds:             row.hedge_odds,
        winner:                row.winner,
        finalSets:             finalSetsArr,
        finalSetsStr:          setScoreStr || null,
        sizeMatched:           row.size_matched,
        liability:             row.liability,
        actualOdds:            row.actual_odds,
        requestedOdds:         row.requested_odds,
        settlementType:        row.settlement_type,
        reasonText:            row.reason,
      });
    }

    res.json({ byStrategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbRejections(req, res) {
  try {
    res.json(betRepo.getRecentRejections());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbMarkets(req, res) {
  try {
    const markets = marketRepo.getRecent();
    // Enrich with live state if available
    const liveById = new Map();
    if (_stateStore) {
      for (const m of _stateStore.getAll()) {
        liveById.set(m.betfairMarketId, {
          isLive:       m.isInPlay && m.status === 'LIVE',
          sets:         m.sets,
          currentGame:  m.currentGame,
          currentServer: m.currentServer,
          playerABack:  m.playerABack,
          playerBBack:  m.playerBBack,
          edgeA:        m.edgeA,
          edgeB:        m.edgeB,
          matchedVolume: m.matchedVolume,
          statsLinked:  !!m.externalMatchId,
        });
      }
    }
    const enriched = markets.map(m => ({
      ...m,
      final_sets: m.final_sets ? JSON.parse(m.final_sets) : null,
      live: liveById.get(m.betfair_market_id) || null,
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbSnapshots(req, res) {
  try {
    const { id }  = req.params;
    const since   = req.query.since || null;
    const rows    = snapshotRepo.getForMarket(id, since);
    // Parse JSON columns
    const parsed = rows.map(r => ({
      ...r,
      sets:         r.sets         ? JSON.parse(r.sets)         : null,
      current_game: r.current_game ? JSON.parse(r.current_game) : null,
      serve_stats:  r.serve_stats  ? JSON.parse(r.serve_stats)  : null,
    }));
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbMarketBets(req, res) {
  try {
    res.json(betRepo.getByMarket(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbMarketRejections(req, res) {
  try {
    res.json(betRepo.getRejectionsByMarket(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbPriceMilestones(req, res) {
  try {
    res.json(priceRepo.getMilestonesForMarket(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbMarketScanner(req, res) {
  try {
    const rows = db.prepare(`
      SELECT
        m.betfair_market_id,
        m.match_name,
        m.tournament,
        m.surface,
        m.went_in_play_at,
        m.player_a_name,
        m.player_b_name,
        m.winner,
        m.final_sets,
        COALESCE(pm_pre.player_a_back, m.pre_match_odds_a)  AS pre_match_odds_a,
        COALESCE(pm_pre.player_b_back, m.pre_match_odds_b)  AS pre_match_odds_b,
        pm_s1.player_a_back  AS s1_end_odds_a,
        pm_s1.player_b_back  AS s1_end_odds_b,
        pm_s2.player_a_back  AS s2_end_odds_a,
        pm_s2.player_b_back  AS s2_end_odds_b,
        COALESCE(pm_end.matched_volume, pm_s2.matched_volume,
                 pm_s1.matched_volume, pm_pre.matched_volume) AS peak_volume,
        m.tournament_round, m.pre_match_volume,
        m.ended_at, m.external_match_id,
        pm_pre.matched_volume AS pre_match_volume_at_milestone,
        pm_s1.matched_volume  AS s1_end_volume,
        pm_s2.matched_volume  AS s2_end_volume,
        pm_end.player_a_back  AS final_odds_a,
        pm_end.player_b_back  AS final_odds_b,
        (SELECT ss.serve_stats FROM market_snapshots ss
           WHERE ss.betfair_market_id = m.betfair_market_id
             AND pm_s1.ts IS NOT NULL
             AND ss.ts <= pm_s1.ts
             AND ss.serve_stats IS NOT NULL
           ORDER BY ss.ts DESC LIMIT 1)        AS s1_serve_stats_json,
        (SELECT ss.serve_stats FROM market_snapshots ss
           WHERE ss.betfair_market_id = m.betfair_market_id
             AND pm_s2.ts IS NOT NULL
             AND ss.ts <= pm_s2.ts
             AND ss.serve_stats IS NOT NULL
           ORDER BY ss.ts DESC LIMIT 1)        AS s2_serve_stats_json,
        (SELECT ss.serve_stats FROM market_snapshots ss
           WHERE ss.betfair_market_id = m.betfair_market_id
             AND ss.serve_stats IS NOT NULL
           ORDER BY ss.ts DESC LIMIT 1)        AS final_serve_stats_json
      FROM markets m
      LEFT JOIN price_milestones pm_pre ON pm_pre.betfair_market_id = m.betfair_market_id AND pm_pre.milestone = 'pre_match'
      LEFT JOIN price_milestones pm_s1  ON pm_s1.betfair_market_id  = m.betfair_market_id AND pm_s1.milestone  = 'set_1_end'
      LEFT JOIN price_milestones pm_s2  ON pm_s2.betfair_market_id  = m.betfair_market_id AND pm_s2.milestone  = 'set_2_end'
      LEFT JOIN price_milestones pm_end ON pm_end.betfair_market_id = m.betfair_market_id AND pm_end.milestone = 'match_end'
      WHERE m.ended_at IS NOT NULL
        AND COALESCE(pm_end.matched_volume, pm_s1.matched_volume, pm_pre.matched_volume, 0) >= 200000
      ORDER BY m.went_in_play_at DESC
    `).all();
    // (No LIMIT — the scanner CSV records every qualifying match, uncapped.)
    // Flatten serve_stats blobs into per-set objects + compute 1st-serve-won %
    // differentials per set + match. The clients (AI tools / CSV download) can
    // consume these without JSON parsing or re-derivation.
    const _diff = (a, b) => (a != null && b != null) ? +(a - b).toFixed(1) : null;
    const _parse = (raw, sliceKey) => {
      if (!raw) return null;
      try { const p = JSON.parse(raw); return p?.[sliceKey] || null; } catch (_) { return null; }
    };
    for (const r of rows) {
      r.s1_serve_stats    = _parse(r.s1_serve_stats_json, 'set1');
      r.s2_serve_stats    = _parse(r.s2_serve_stats_json, 'set2');
      r.match_serve_stats = _parse(r.final_serve_stats_json, 'match');
      // Parse a third-set view from the same snapshot used for the final read
      r.s3_serve_stats    = _parse(r.final_serve_stats_json, 'set3');
      delete r.s1_serve_stats_json;
      delete r.s2_serve_stats_json;
      delete r.final_serve_stats_json;

      r.s1_first_won_diff    = _diff(r.s1_serve_stats?.playerA?.firstServeWon,    r.s1_serve_stats?.playerB?.firstServeWon);
      r.s2_first_won_diff    = _diff(r.s2_serve_stats?.playerA?.firstServeWon,    r.s2_serve_stats?.playerB?.firstServeWon);
      r.s3_first_won_diff    = _diff(r.s3_serve_stats?.playerA?.firstServeWon,    r.s3_serve_stats?.playerB?.firstServeWon);
      r.match_first_won_diff = _diff(r.match_serve_stats?.playerA?.firstServeWon, r.match_serve_stats?.playerB?.firstServeWon);

      // Serve quality composite (0–100) per set + match for both players + AB diff.
      const _sq = stats => stats ? serveScorer.score(stats).score : null;
      r.s1_serve_quality_a    = _sq(r.s1_serve_stats?.playerA);
      r.s1_serve_quality_b    = _sq(r.s1_serve_stats?.playerB);
      r.s2_serve_quality_a    = _sq(r.s2_serve_stats?.playerA);
      r.s2_serve_quality_b    = _sq(r.s2_serve_stats?.playerB);
      r.s3_serve_quality_a    = _sq(r.s3_serve_stats?.playerA);
      r.s3_serve_quality_b    = _sq(r.s3_serve_stats?.playerB);
      r.match_serve_quality_a = _sq(r.match_serve_stats?.playerA);
      r.match_serve_quality_b = _sq(r.match_serve_stats?.playerB);
      const _sqDiff = (a, b) => (a != null && b != null) ? a - b : null;
      r.s1_serve_quality_diff    = _sqDiff(r.s1_serve_quality_a,    r.s1_serve_quality_b);
      r.s2_serve_quality_diff    = _sqDiff(r.s2_serve_quality_a,    r.s2_serve_quality_b);
      r.s3_serve_quality_diff    = _sqDiff(r.s3_serve_quality_a,    r.s3_serve_quality_b);
      r.match_serve_quality_diff = _sqDiff(r.match_serve_quality_a, r.match_serve_quality_b);

      // Parse final_sets JSON into a flat per-set string array for easy CSV
      try {
        const fs = r.final_sets ? JSON.parse(r.final_sets) : null;
        r.final_sets_parsed = Array.isArray(fs)
          ? fs.map(s => Array.isArray(s) ? s.join('-') : (s?.playerA != null ? `${s.playerA}-${s.playerB}` : '')).filter(Boolean)
          : [];
      } catch (_) { r.final_sets_parsed = []; }
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbEvents(req, res) {
  try {
    const since  = req.query.since  || '-24 hours';
    const level  = req.query.level  || null;
    const source = req.query.source || null;
    const limit  = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    if (level)  return res.json(systemEventRepo.getByLevel(level, since, limit));
    if (source) return res.json(systemEventRepo.getBySource(source, since, limit));
    res.json(systemEventRepo.getRecent(since, limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbEventCounts(req, res) {
  try {
    res.json(systemEventRepo.countByLevel(req.query.since || '-24 hours'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function apiDbPipeline(req, res) {
  try {
    const liveMatches = _stateStore ? _stateStore.getAll().filter(m => m.isInPlay) : [];
    const linked   = liveMatches.filter(m => m.externalMatchId).length;
    const withStats = liveMatches.filter(m =>
      m.liveServeStats?.playerA?.firstServeIn != null ||
      m.liveServeStats?.playerB?.firstServeIn != null
    ).length;
    const unlinked = marketRepo.getUnlinked();

    res.json({
      betfairStream: {
        isConnected: Date.now() - _lastHeartbeat < BOT_TIMEOUT_MS,
        lastHeartbeat: _lastHeartbeat,
      },
      liveMarkets:   liveMatches.length,
      statsLinked:   linked,
      withServeStats: withStats,
      unlinkedMarkets: unlinked.map(m => ({
        marketId:  m.betfair_market_id,
        matchName: m.match_name,
        wentInPlayAt: m.went_in_play_at,
      })),
      recentErrors: systemEventRepo.getByLevel('ERROR', '-1 hours', 10),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/** RFC-4180 compliant single-line CSV parser. */
function parseCsvLine(line) {
  const fields = [];
  let cur   = '';
  let inQ   = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"')                    { inQ = false; }
      else                                    { cur += ch; }
    } else {
      if (ch === '"')       { inQ = true; }
      else if (ch === ',')  { fields.push(cur); cur = ''; }
      else                  { cur += ch; }
    }
  }
  fields.push(cur);
  return fields;
}
