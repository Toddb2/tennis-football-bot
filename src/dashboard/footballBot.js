'use strict';

/**
 * footballBot.js — Football over/under bet tracking, integrated into the tennis bot server.
 *
 * All routes are mounted at /football/api/* so the patched football.html can reach them.
 * Data files live in FOOTBALL_DATA_DIR (the old telegram-listener folder).
 */

const fs                = require('fs');
const path              = require('path');
const axios             = require('axios');
const footballAnalyser  = require('../analysis/footballAnalyser');

const FOOTBALL_DATA_DIR   = '/home/bots/telegram-listener';
const BETS_FILE           = path.join(FOOTBALL_DATA_DIR, 'bets.json');
const EXCEPTIONS_FILE     = path.join(FOOTBALL_DATA_DIR, 'exceptions.json');
const SM_LIVE_FILE        = path.join(FOOTBALL_DATA_DIR, 'sportmonks_live.json');
const SM_GOALS_FILE       = path.join(FOOTBALL_DATA_DIR, 'sportmonks_goals.json');
const SM_RESULTS_PATH     = path.join(FOOTBALL_DATA_DIR, 'sportmonks_results.json');
const SM_STRATEGIES_FILE  = path.join(FOOTBALL_DATA_DIR, 'sportmonks-strategies.json');
const FOOTBALL_API      = 'https://v3.football.api-sports.io';

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();
let knownBetIds  = null;

// ── Bets file helpers ─────────────────────────────────────────────────────────
function loadBets() {
  try {
    if (fs.existsSync(BETS_FILE)) return JSON.parse(fs.readFileSync(BETS_FILE, 'utf8'));
  } catch (_) {}
  return [];
}

function saveBets(bets) {
  try { fs.writeFileSync(BETS_FILE, JSON.stringify(bets, null, 2), 'utf8'); }
  catch (err) { console.error('[footballBot] Error saving bets:', err.message); }
}

// ── SSE broadcast ─────────────────────────────────────────────────────────────
function broadcastNewBets(newBets) {
  if (!newBets.length || !sseClients.size) return;
  const payload = `data: ${JSON.stringify(newBets)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function watchBetsFile() {
  if (!fs.existsSync(BETS_FILE)) {
    setTimeout(watchBetsFile, 5000);
    return;
  }
  if (knownBetIds === null) {
    try { knownBetIds = new Set(JSON.parse(fs.readFileSync(BETS_FILE, 'utf8')).map(b => b.id)); }
    catch (_) { knownBetIds = new Set(); }
  }
  fs.watch(BETS_FILE, { persistent: false }, () => {
    setTimeout(() => {
      try {
        const bets  = JSON.parse(fs.readFileSync(BETS_FILE, 'utf8'));
        const fresh = bets.filter(b => !knownBetIds.has(b.id));
        if (fresh.length) {
          fresh.forEach(b => knownBetIds.add(b.id));
          broadcastNewBets(fresh);
        }
      } catch (_) {}
    }, 150);
  });
}

// ── Team name matching ────────────────────────────────────────────────────────
function normaliseTeam(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\bfc\b|\baf\b|\bsc\b|\bac\b|\bfk\b|\bnk\b|\bsk\b|\bif\b|\bbk\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsMatch(a, b) {
  const na = normaliseTeam(a), nb = normaliseTeam(b);
  if (na === nb || nb.includes(na) || na.includes(nb)) return true;
  const wa = na.split(' ').filter(w => w.length > 2);
  const wb = nb.split(' ').filter(w => w.length > 2);
  return wa.filter(w => wb.includes(w)).length / Math.max(wa.length, 1) >= 0.6;
}

// ── Fixture result lookup ─────────────────────────────────────────────────────
// Three-stage lookup:
//   1. sportmonks_results.json (cache filled by in-play scanner + this fn)
//   2. SportMonks /fixtures/date (covers leagues in the SM plan that the
//      in-play scanner never saw, e.g. a match that finished while the bot
//      was offline)
//   3. api-football.com (only if FOOTBALL_API_KEY is set — covers the
//      leagues SportMonks doesn't have)
// Match-day constraint prevents "West Ham v Arsenal (10 May)" joining to
// "Brentford v West Ham (9 May)" via partial-name fuzzy matches.
const SM_BASE = 'https://api.sportmonks.com/v3/football';
const SM_FINISHED_STATES = new Set([5, 7, 8, 10, 14, 17]);
const _smDateFetched = new Set(); // YYYY-MM-DD already pulled this process

function _findInSmResults(teamA, teamB, matchDateStr) {
  let sm = {};
  try { sm = JSON.parse(fs.readFileSync(SM_RESULTS_PATH, 'utf8')); } catch (_) {}
  for (const r of Object.values(sm)) {
    const rDay = (r.playedAt || r.finishedAt || '').slice(0, 10);
    if (matchDateStr && rDay && rDay !== matchDateStr) continue;
    const aHome = teamsMatch(teamA, r.teamHome), bAway = teamsMatch(teamB, r.teamAway);
    const aAway = teamsMatch(teamA, r.teamAway), bHome = teamsMatch(teamB, r.teamHome);
    if ((aHome && bAway) || (aAway && bHome)) {
      const hg = r.goalsHome ?? 0, ag = r.goalsAway ?? 0;
      const [gA, gB] = aHome ? [hg, ag] : [ag, hg];
      return { finalGoalsA: gA, finalGoalsB: gB, finalGoals: gA + gB, source: 'sportmonks' };
    }
  }
  return null;
}

async function _refreshSmForDate(matchDateStr) {
  if (!matchDateStr || _smDateFetched.has(matchDateStr)) return;
  const apiKey = process.env.SPORTMONKS_API_KEY;
  if (!apiKey) return;
  _smDateFetched.add(matchDateStr);
  try {
    const out = [];
    let page = 1;
    while (true) {
      const r = await axios.get(`${SM_BASE}/fixtures/date/${matchDateStr}`, {
        params: { api_token: apiKey, include: 'scores;participants', per_page: 50, page },
        timeout: 15000,
      });
      out.push(...(r.data?.data || []));
      if (!r.data?.pagination?.has_more) break;
      if (++page > 10) break;
    }
    let sm = {};
    try { sm = JSON.parse(fs.readFileSync(SM_RESULTS_PATH, 'utf8')); } catch (_) {}
    let added = 0;
    for (const f of out) {
      if (!SM_FINISHED_STATES.has(f.state_id)) continue;
      const homeP = (f.participants || []).find(p => p.meta?.location === 'home');
      const awayP = (f.participants || []).find(p => p.meta?.location === 'away');
      if (!homeP || !awayP) continue;
      let homeG = null, awayG = null;
      for (const s of (f.scores || [])) {
        if (s.description !== 'CURRENT') continue;
        const loc = s.score?.participant, pid = s.participant_id;
        if (loc === 'home' || pid === homeP.id) homeG = s.score?.goals ?? homeG;
        if (loc === 'away' || pid === awayP.id) awayG = s.score?.goals ?? awayG;
      }
      if (homeG == null || awayG == null) continue;
      if (!sm[String(f.id)]) added++;
      sm[String(f.id)] = {
        fixtureId: f.id, teamHome: homeP.name, teamAway: awayP.name,
        goalsHome: homeG, goalsAway: awayG, totalGoals: homeG + awayG,
        finishedAt: f.starting_at || new Date().toISOString(),
        playedAt: f.starting_at || null,
      };
    }
    if (added > 0) {
      fs.writeFileSync(SM_RESULTS_PATH, JSON.stringify(sm, null, 2));
      console.log(`[footballBot] SM /fixtures/date ${matchDateStr}: +${added} results cached`);
    }
  } catch (err) {
    console.error(`[footballBot] SM date fetch failed for ${matchDateStr}: ${err.message}`);
  }
}

async function lookupFixtureResult(teamA, teamB, matchDateStr) {
  let hit = _findInSmResults(teamA, teamB, matchDateStr);
  if (hit) return hit;

  await _refreshSmForDate(matchDateStr);
  hit = _findInSmResults(teamA, teamB, matchDateStr);
  if (hit) return hit;

  const key = process.env.FOOTBALL_API_KEY;
  if (!key) return null;
  try {
    const resp = await axios.get(`${FOOTBALL_API}/fixtures`, {
      headers: { 'x-apisports-key': key },
      params:  { date: matchDateStr },
      timeout: 10000,
    });
    for (const f of (resp.data?.response || [])) {
      const home = f.teams?.home?.name || '';
      const away = f.teams?.away?.name || '';
      const aHome = teamsMatch(teamA, home), bAway = teamsMatch(teamB, away);
      const aAway = teamsMatch(teamA, away), bHome = teamsMatch(teamB, home);
      if ((aHome && bAway) || (aAway && bHome)) {
        const short = f.fixture?.status?.short;
        if (short !== 'FT' && short !== 'AET' && short !== 'PEN') return null;
        const hg = f.goals?.home ?? 0, ag = f.goals?.away ?? 0;
        const [gA, gB] = aHome ? [hg, ag] : [ag, hg];
        return { finalGoalsA: gA, finalGoalsB: gB, finalGoals: gA + gB, source: 'api-football' };
      }
    }
    return null;
  } catch (err) {
    console.error('[footballBot] api-football error:', err.message);
    return null;
  }
}

function matchDateString(bet) {
  if (bet.startDate) return bet.startDate.split('T')[0].split(' ')[0];
  const placed  = new Date(bet.placedAt);
  const timer   = typeof bet.timer === 'number' ? bet.timer : 45;
  return new Date(placed.getTime() - timer * 60 * 1000).toISOString().split('T')[0];
}

function calcResult(finalGoals, overUnderValue) {
  if (finalGoals == null || overUnderValue == null) return 'pending';
  return finalGoals > parseFloat(overUnderValue) ? 'won' : 'lost';
}

async function fetchAndSaveResult(betId) {
  const bets = loadBets();
  const bet  = bets.find(b => b.id === betId);
  if (!bet) return { ok: false, reason: 'bet not found' };
  if (!bet.teamA || !bet.teamB) {
    const parts = (bet.match || '').split(/ v /i);
    if (parts.length === 2) { bet.teamA = parts[0].trim(); bet.teamB = parts[1].trim(); }
    else return { ok: false, reason: 'no team names stored' };
  }
  const dateStr = matchDateString(bet);
  const outcome = await lookupFixtureResult(bet.teamA, bet.teamB, dateStr);
  if (!outcome) return { ok: false, reason: 'fixture not found or not finished' };

  let updated = 0;
  for (const b of bets) {
    if (b.marketId === bet.marketId && b.result === 'pending') {
      b.finalGoalsA = outcome.finalGoalsA;
      b.finalGoalsB = outcome.finalGoalsB;
      b.finalGoals  = outcome.finalGoals;
      b.result      = calcResult(outcome.finalGoals, b.overUnderValue);
      b.resultFetchedAt = new Date().toISOString();
      updated++;
    }
  }
  saveBets(bets);
  return { ok: true, ...outcome, updated };
}

// ── Scan pending bets ─────────────────────────────────────────────────────────
const recentlyChecked = new Set();

async function scanPendingBets() {
  if (!process.env.FOOTBALL_API_KEY) return;
  const bets = loadBets();
  const now  = Date.now();
  const seenMarkets = new Set();
  for (const bet of bets) {
    if (bet.result !== 'pending' || recentlyChecked.has(bet.marketId) || seenMarkets.has(bet.marketId)) continue;
    const kickoff    = bet.startDate ? new Date(bet.startDate).getTime() : new Date(bet.placedAt).getTime() - (bet.timer || 45) * 60 * 1000;
    const matchEnd   = kickoff + 2.5 * 60 * 60 * 1000;
    if (now < matchEnd) continue;
    seenMarkets.add(bet.marketId);
    recentlyChecked.add(bet.marketId);
    setTimeout(() => recentlyChecked.delete(bet.marketId), 15 * 60 * 1000);
    fetchAndSaveResult(bet.id).then(r => console.log(`[footballBot] scan: ${bet.match} → ${JSON.stringify(r)}`));
  }
}

// ── CBB helpers ───────────────────────────────────────────────────────────────
function ouValueFromMarketType(marketType) {
  const m = (marketType || '').match(/OVER_UNDER_(\d+)/);
  return m ? (parseInt(m[1]) / 10).toFixed(1) : null;
}

function mapCBBBet(cbbBet) {
  const { runner, market, outcome } = cbbBet;
  const overUnderValue = ouValueFromMarketType(market?.marketType);
  const strategy = (runner?.settings_key || '').replace(/^settings_/, '');
  let result = 'pending';
  if (outcome) result = outcome.outcome === 'W' ? 'won' : outcome.outcome === 'L' ? 'lost' : 'pending';
  return {
    id: `cbb-${runner.runner_id}`,
    placedAt: market?.startTime ? new Date(market.startTime).toISOString() : null,
    match: null, teamA: null, teamB: null, league: null,
    startDate: market?.startTime || null,
    betfairEventId: null, marketId: runner.marketId,
    selectionId: String(runner.selectionId),
    marketName: market?.marketName || null,
    overUnderValue, strategy, signalStrategy: null,
    overOdds: outcome?.ave_price ?? null, underOdds: null,
    timer: null, goalsA: null, goalsB: null, goals: null,
    success: true, isCompanion: false, isHistorical: true,
    result, finalGoalsA: null, finalGoalsB: null, finalGoals: null,
    avePoints: outcome ? parseFloat(outcome.ave_points) : null,
    cbbRunnerId: runner.runner_id,
    priceSnapshots: outcome?.ave_price
      ? [{ at: market?.startTime || new Date().toISOString(), over: outcome.ave_price, under: null }]
      : [],
  };
}

const marketNameCache = new Map();

async function lookupMatchName(marketId) {
  if (marketNameCache.has(marketId)) return marketNameCache.get(marketId);
  try {
    const resp = await axios.get(
      'https://www.cloudbetbot.com/api/rpc/services/predictology/v2/market_catalogue.php',
      { params: { sport: 'soccer', access_key: process.env.CBB_KEY, access_name: process.env.CBB_SERVICE, marketId }, timeout: 8000 }
    );
    const cat = resp.data;
    if (cat && typeof cat === 'object') {
      for (const eventData of Object.values(cat)) {
        if (eventData?.markets?.[marketId]) {
          const name = eventData?.details?.name || null;
          marketNameCache.set(marketId, name);
          return name;
        }
      }
    }
  } catch (_) {}
  marketNameCache.set(marketId, null);
  return null;
}

async function fetchCBBHistory(fromDate, toDate) {
  const body = JSON.stringify({
    service: { id: parseInt(process.env.CBB_ID), access_key: process.env.CBB_KEY },
    params:  { from: fromDate, to: toDate },
  });
  const resp = await axios.post(
    'https://www.cloudbetbot.com/api/rpc/hooks/get_bets.php',
    body,
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
  );
  if (!resp.data?.success) throw new Error(resp.data?.message || 'CBB API error');
  return resp.data.bets || [];
}

// ── Route handlers ────────────────────────────────────────────────────────────
const VALID_STRATEGY  = /^(System[ABC]\d{1,2}|sm[12]|SM_[A-Za-z_]+)$/;
const ALLOWED_MARKETS = ['0.5', '1.5', '2.5'];
const CUTOFF_DATE     = new Date('2026-03-01T00:00:00.000Z');

function handleSse(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');
  sseClients.add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
}

function handleGetBets(req, res) {
  try {
    const bets = loadBets().filter(b => {
      // Pending bets kept so LHS history matches what was actually placed.
      // Settled-only consumers (charts, P&L) already gate on b.result.
      if (!VALID_STRATEGY.test(b.strategy || '')) return false;
      if (!ALLOWED_MARKETS.includes(String(b.overUnderValue))) return false;
      if (b.placedAt && new Date(b.placedAt) < CUTOFF_DATE) return false;
      return true;
    });
    res.json(bets);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function handleGetBetsCsv(req, res) {
  try {
    const bets = loadBets()
      .filter(b => VALID_STRATEGY.test(b.strategy || '') &&
                   ALLOWED_MARKETS.includes(String(b.overUnderValue)) &&
                   !(b.placedAt && new Date(b.placedAt) < CUTOFF_DATE))
      .sort((a, b) => String(b.placedAt || '').localeCompare(String(a.placedAt || '')));

    const fmtDate = (v) => {
      if (!v) return '';
      try { return new Date(v).toISOString().replace('T', ' ').slice(0, 16); } catch (_) { return String(v); }
    };
    const esc = (v) => {
      if (v == null) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const headers = [
      'Date Placed', 'Date Settled', 'Match', 'League', 'Kick Off',
      'Strategy', 'Signal Strategy', 'Data Source',
      'Market', 'Over/Under Line', 'Bet Type',
      'Over Odds', 'Under Odds', 'Odds Taken',
      'Minute of Bet', 'Score at Bet', 'Goals at Bet',
      'Result', 'Final Score', 'Final Goals', 'Final Goals (est)',
      'P&L (pts)',
    ];
    const lines = [headers.join(',')];
    for (const b of bets) {
      const goalsNum = b.goals != null && b.goals !== '' ? parseFloat(b.goals) : null;
      const lineNum  = b.overUnderValue != null ? parseFloat(b.overUnderValue) : null;
      const isOver   = goalsNum != null && lineNum != null
        ? (b.result === 'won' ? goalsNum > lineNum : goalsNum <= lineNum)
        : true;
      const betType  = isOver ? 'OVER' : 'UNDER';
      const oddsT    = isOver ? b.overOdds : b.underOdds;
      const scoreAtBet = (b.goalsA != null && b.goalsA !== '' && b.goalsB != null && b.goalsB !== '') ? `${b.goalsA}-${b.goalsB}` : '';
      const finalScore = (b.finalGoalsA != null && b.finalGoalsA !== '' && b.finalGoalsB != null && b.finalGoalsB !== '') ? `${b.finalGoalsA}-${b.finalGoalsB}` : '';
      // Estimate final goals range from result + line when not recorded
      let finalGoalsEst = '';
      if (!b.finalGoals && lineNum != null) {
        if (betType === 'OVER')  finalGoalsEst = b.result === 'won' ? `>=${Math.ceil(lineNum + 0.1)}` : `<=${Math.floor(lineNum)}`;
        if (betType === 'UNDER') finalGoalsEst = b.result === 'won' ? `<=${Math.floor(lineNum)}` : `>=${Math.ceil(lineNum + 0.1)}`;
      }
      const dataSource = b.historical ? 'Historical' : 'Live';
      const row = [
        fmtDate(b.placedAt), fmtDate(b.settledAt),
        esc(b.match), esc(b.league), fmtDate(b.startDate),
        esc(b.strategy), esc(b.signalStrategy), dataSource,
        esc(b.marketName), esc(b.overUnderValue), betType,
        esc(b.overOdds), esc(b.underOdds), esc(oddsT),
        esc(b.timer), esc(scoreAtBet), esc(goalsNum),
        esc(b.result), esc(finalScore), esc(b.finalGoals), esc(finalGoalsEst),
        esc(b.avePoints),
      ];
      lines.push(row.join(','));
    }

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="football-bets-${today}.csv"`);
    res.send(lines.join('\n') + '\n');
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function handleDeleteBet(req, res) {
  const bets = loadBets();
  const idx  = bets.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  bets.splice(idx, 1);
  saveBets(bets);
  res.json({ ok: true });
}

function handlePatchBet(req, res) {
  const bets = loadBets();
  const bet  = bets.find(b => b.id === req.params.id);
  if (!bet) return res.status(404).json({ error: 'not found' });
  const { result, finalGoalsA, finalGoalsB } = req.body;
  if (result) bet.result = result;
  if (finalGoalsA != null) bet.finalGoalsA = finalGoalsA;
  if (finalGoalsB != null) bet.finalGoalsB = finalGoalsB;
  if (finalGoalsA != null && finalGoalsB != null) bet.finalGoals = finalGoalsA + finalGoalsB;
  if ((finalGoalsA != null || finalGoalsB != null) && !result)
    bet.result = calcResult(bet.finalGoals, bet.overUnderValue);
  // When result is set manually without goals, derive avePoints so the
  // cum-P&L chart picks it up. Mirrors the simple +/− 1 unit Tennis uses.
  if (bet.result === 'won')  bet.avePoints = (bet.overOdds != null ? +(bet.overOdds - 1).toFixed(2) : 1);
  if (bet.result === 'lost') bet.avePoints = -1;
  bet.manualSettle    = !!result && finalGoalsA == null && finalGoalsB == null;
  bet.settledAt       = bet.settledAt || new Date().toISOString();
  bet.resultFetchedAt = new Date().toISOString();
  saveBets(bets);
  res.json(bet);
}

async function handleFetchResult(req, res) {
  try {
    res.json(await fetchAndSaveResult(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function handleLiveSnapshot(req, res) {
  const bets = loadBets();
  const bet  = bets.find(b => b.id === req.params.id);
  if (!bet?.marketId) return res.status(404).json({ ok: false, reason: 'bet not found' });
  try {
    const url = `https://www.cloudbetbot.com/api/rpc/services/predictology/v2/prices.php` +
      `?marketId=${encodeURIComponent(bet.marketId)}&access_key=${process.env.CBB_KEY}&access_name=${process.env.CBB_SERVICE}`;
    const resp = await axios.get(url, { timeout: 8000 });
    const data = resp.data;
    let overOdds = null, underOdds = null;
    function tryExtract(runners) {
      if (!runners || typeof runners !== 'object') return;
      for (const runner of Object.values(runners)) {
        if (typeof runner !== 'object') continue;
        const name  = (runner.name || runner.runnerName || runner.selection || '').toLowerCase();
        const price = runner.price ?? runner.best_back ?? runner.back?.[0]?.price ?? runner.lastPrice ?? runner.sp?.nearPrice ?? runner.lastPriceTraded;
        if (price == null) continue;
        if (name.includes('over')  && overOdds  == null) overOdds  = parseFloat(price);
        if (name.includes('under') && underOdds == null) underOdds = parseFloat(price);
      }
    }
    tryExtract(data?.runners);
    if (overOdds == null) tryExtract(data?.[bet.marketId]?.runners);
    if (overOdds == null) tryExtract(Object.values(data || {})[0]?.runners ?? Object.values(data || {})[0]);
    if (overOdds == null && underOdds == null)
      return res.json({ ok: false, reason: 'could not parse prices from CBB response' });
    const snapshot = { at: new Date().toISOString(), over: overOdds, under: underOdds };
    bet.priceSnapshots = bet.priceSnapshots || [];
    const last  = bet.priceSnapshots[bet.priceSnapshots.length - 1];
    const isDup = last && last.over === overOdds && last.under === underOdds;
    if (!isDup) { bet.priceSnapshots.push(snapshot); saveBets(bets); }
    res.json({ ok: true, snapshot, total: bet.priceSnapshots.length, isDup });
  } catch (err) { res.status(502).json({ ok: false, reason: err.message }); }
}

async function handlePrices(req, res) {
  try {
    const url = `https://www.cloudbetbot.com/api/rpc/services/predictology/v2/prices.php` +
      `?marketId=${encodeURIComponent(req.params.marketId)}&access_key=${process.env.CBB_KEY}&access_name=${process.env.CBB_SERVICE}`;
    res.json((await axios.get(url, { timeout: 8000 })).data);
  } catch (err) { res.status(502).json({ error: err.message }); }
}

// CBB push-mode config (lives on the listener side; shared file).
const CBB_PUSH_CONFIG_FILE = path.join(FOOTBALL_DATA_DIR, 'cbb_push_config.json');
const BFBM_CSV_FILE        = path.join(FOOTBALL_DATA_DIR, 'upload.csv');
// New canonical mode set. Old values ('a20_only', 'all') still accepted via
// migration for backwards compat — both POST handler + listener migrate.
const VALID_PUSH_MODES = new Set(['off', 'cbb_20', 'cbb_all', 'bfbm_20', 'bfbm_all', 'a20_only', 'all']);
function _migratePushMode(mode, bfbmAllBets) {
  if (mode === 'a20_only') return bfbmAllBets ? 'bfbm_all' : 'cbb_20';
  if (mode === 'all')      return bfbmAllBets ? 'bfbm_all' : 'cbb_all';
  return mode || 'cbb_20';
}

function handleDownloadBfbmCsv(req, res) {
  res.setHeader('Content-Disposition', 'attachment; filename="upload.csv"');
  res.setHeader('Content-Type', 'text/csv');

  if (!fs.existsSync(BFBM_CSV_FILE)) {
    return res.send('Provider,MarketType,EventName,MarketName,SelectionName\n');
  }

  res.sendFile(BFBM_CSV_FILE);
}

function handleGetCbbPushConfig(req, res) {
  try {
    const raw = fs.existsSync(CBB_PUSH_CONFIG_FILE)
      ? JSON.parse(fs.readFileSync(CBB_PUSH_CONFIG_FILE, 'utf8'))
      : { mode: 'cbb_20', enabledSystems: ['SystemA20', 'SystemB20', 'SystemC20'] };
    raw.mode = _migratePushMode(raw.mode, raw.bfbmAllBets === true);
    delete raw.bfbmAllBets;
    res.json(raw);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function handleSetCbbPushConfig(req, res) {
  const { mode } = req.body || {};
  if (!VALID_PUSH_MODES.has(mode)) return res.status(400).json({ error: `invalid mode (use off / cbb_20 / cbb_all / bfbm_20 / bfbm_all)` });
  try {
    let cfg = { mode: 'cbb_20', enabledSystems: ['SystemA20', 'SystemB20', 'SystemC20'] };
    if (fs.existsSync(CBB_PUSH_CONFIG_FILE)) {
      try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CBB_PUSH_CONFIG_FILE, 'utf8')) }; } catch (_) {}
    }
    cfg.mode = _migratePushMode(mode, false);
    delete cfg.bfbmAllBets;
    cfg._comment = 'mode: off / cbb_20 / cbb_all / bfbm_20 / bfbm_all — mutually exclusive execution paths. cbb_* pushes via cloudbetbot; bfbm_* writes to bfbm-signals.csv for BFBM to pull. _20 = .20 strategies only; _all = every system.';
    fs.writeFileSync(CBB_PUSH_CONFIG_FILE, JSON.stringify(cfg, null, 2));
    res.json({ ok: true, mode: cfg.mode });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// Refresh outcomes from CBB for live (non-historical) pending bets.
// CBB knows the won/lost outcome for every bet placed through it — even in
// leagues SportMonks doesn't cover. We pull history, then match by
// (marketId, settings_key→strategy) and merge outcomes onto pending live bets.
async function refreshOutcomesFromCbb({ days = 7 } = {}) {
  const to   = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt  = d => d.toISOString().split('T')[0];
  const cbbBets = await fetchCBBHistory(fmt(from), fmt(to));
  const bets    = loadBets();
  let updated = 0, skipped = 0, noOutcome = 0;
  const sample = [];
  for (const cbbBet of cbbBets) {
    const outcome = cbbBet.outcome;
    if (!outcome || (outcome.outcome !== 'W' && outcome.outcome !== 'L')) { noOutcome++; continue; }
    const cbbMarketId = cbbBet.runner?.marketId;
    const cbbStrategy = (cbbBet.runner?.settings_key || '').replace(/^settings_/, '');
    if (!cbbMarketId || !cbbStrategy) { skipped++; continue; }
    for (const b of bets) {
      if (b.marketId !== cbbMarketId) continue;
      if (b.strategy !== cbbStrategy) continue;
      if (b.isHistorical || b.historical) continue;
      if (b.result !== 'pending') continue;
      b.result    = outcome.outcome === 'W' ? 'won' : 'lost';
      b.avePoints = outcome.ave_points != null ? parseFloat(outcome.ave_points) : (b.result === 'won' ? +(b.overOdds || 2) - 1 : -1);
      if (b.overOdds == null && outcome.ave_price != null) b.overOdds = outcome.ave_price;
      b.resultFetchedAt  = new Date().toISOString();
      b.settlementSource = 'cbb_outcomes';
      updated++;
      if (sample.length < 20) sample.push(`${b.match || b.marketId} [${b.strategy}] → ${b.result}`);
    }
  }
  if (updated > 0) saveBets(bets);
  return { cbbBets: cbbBets.length, updated, skipped, noOutcome, sample };
}

// One-shot: walk bets.json, look up the CBB market name for any bet with
// `match: null` and patch it in. Solves the legacy CBB-imported bets that
// show "Unknown" in the bet list because the import skipped catalogue lookups.
async function handleBackfillMatchNames(req, res) {
  try {
    const bets = loadBets();
    const targets = bets.filter(b => !b.match && b.marketId);
    if (!targets.length) return res.json({ ok: true, scanned: 0, updated: 0 });

    const uniqueMarkets = [...new Set(targets.map(b => b.marketId))];
    await Promise.all(uniqueMarkets.map(id => lookupMatchName(id)));

    let updated = 0;
    const samples = [];
    for (const b of targets) {
      const name = marketNameCache.get(b.marketId);
      if (name) {
        b.match = name;
        const parts = name.split(/ v /i);
        if (parts.length === 2) {
          if (!b.teamA) b.teamA = parts[0].trim();
          if (!b.teamB) b.teamB = parts[1].trim();
        }
        updated++;
        if (samples.length < 15) samples.push(`${b.id}: ${name}`);
      }
    }
    if (updated > 0) saveBets(bets);
    res.json({ ok: true, scanned: targets.length, updated, sample: samples });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

async function handleRefreshCbbOutcomes(req, res) {
  const days = Math.max(1, Math.min(90, parseInt(req.body?.days || '14', 10)));
  try {
    const r = await refreshOutcomesFromCbb({ days });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error('[footballBot] refresh-cbb-outcomes failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// Auto-scanner: pulls a short CBB-history window every 5 min and merges any
// new outcomes onto pending bets. Skipped entirely when no pending bets exist
// to avoid wasting CBB API calls.
let _cbbScanInFlight = false;
async function scanCbbOutcomes() {
  if (_cbbScanInFlight) return;
  const bets = loadBets();
  const hasPending = bets.some(b => b.result === 'pending' && !b.isHistorical && !b.historical);
  if (!hasPending) return;
  _cbbScanInFlight = true;
  try {
    const r = await refreshOutcomesFromCbb({ days: 3 });
    if (r.updated > 0) {
      console.log(`[footballBot] auto-CBB scan: settled ${r.updated} (of ${r.cbbBets} CBB bets scanned)`);
    }
  } catch (err) {
    console.error('[footballBot] auto-CBB scan failed:', err.message);
  } finally {
    _cbbScanInFlight = false;
  }
}

async function handleImportCBB(req, res) {
  const from = req.body?.from || '2025-01-01';
  const to   = req.body?.to   || new Date().toISOString().split('T')[0];
  try {
    const cbbBets = await fetchCBBHistory(from, to);
    const existing   = loadBets();
    const existingIds = new Set(existing.map(b => b.id));
    const uniqueMarkets = [...new Set(cbbBets.map(b => b.runner?.marketId).filter(Boolean))];
    await Promise.all(uniqueMarkets.map(id => lookupMatchName(id)));
    const imported = [];
    for (const cbbBet of cbbBets) {
      const mapped = mapCBBBet(cbbBet);
      mapped.match = marketNameCache.get(mapped.marketId) || null;
      if (!existingIds.has(mapped.id)) {
        imported.push(mapped);
        existingIds.add(mapped.id);
      } else {
        const ex = existing.find(b => b.id === mapped.id);
        if (ex && ex.result === 'pending' && mapped.result !== 'pending') {
          ex.result = mapped.result;
          ex.overOdds = mapped.overOdds;
          ex.avePoints = mapped.avePoints;
          ex.priceSnapshots = mapped.priceSnapshots;
        }
      }
    }
    const merged = [...existing, ...imported].sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
    saveBets(merged);
    res.json({ ok: true, total: cbbBets.length, imported: imported.length, updated: cbbBets.length - imported.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

function handleExceptions(req, res) {
  try {
    if (!fs.existsSync(EXCEPTIONS_FILE)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, 'utf8')));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function handleSmStrategiesGet(req, res) {
  try {
    if (!fs.existsSync(SM_STRATEGIES_FILE)) return res.json({ strategies: [] });
    res.json(JSON.parse(fs.readFileSync(SM_STRATEGIES_FILE, 'utf8')));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function handleSmStrategiesPost(req, res) {
  try {
    const cfg = req.body;
    if (!cfg || !Array.isArray(cfg.strategies)) {
      return res.status(400).json({ error: 'invalid payload — expected { strategies: [...] }' });
    }
    if (fs.existsSync(SM_STRATEGIES_FILE)) {
      fs.copyFileSync(SM_STRATEGIES_FILE, SM_STRATEGIES_FILE + '.bak.' + Date.now());
    }
    fs.writeFileSync(SM_STRATEGIES_FILE, JSON.stringify(cfg, null, 2));
    res.json({ ok: true, count: cfg.strategies.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function handleSmLive(req, res) {
  try {
    if (!fs.existsSync(SM_LIVE_FILE)) {
      return res.json({ apiKeySet: false, fixtureCount: 0, fixtures: [], signalsFired: [], lastPolledAt: null });
    }
    res.json(JSON.parse(fs.readFileSync(SM_LIVE_FILE, 'utf8')));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function handleGoalsHistory(req, res) {
  try {
    if (!fs.existsSync(SM_GOALS_FILE)) return res.json([]);
    res.json(JSON.parse(fs.readFileSync(SM_GOALS_FILE, 'utf8')));
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function handleFootballAnalysisRun(req, res) {
  const forceRefresh = req.query.force === '1';
  // Only invoke Claude when explicitly forced. Otherwise return cached result
  // (or a hint to click Run Analysis) so we never auto-burn API credits on
  // tab/page loads.
  if (!forceRefresh) {
    const cached = footballAnalyser.getCached?.();
    if (cached) return res.json({ ...cached, fromCache: true });
    return res.json({ error: 'No analysis yet. Click + New to generate one.' });
  }
  try {
    const result = await footballAnalyser.runAnalysis({ forceRefresh });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

function handleFootballAnalysisHistory(req, res) {
  res.json(footballAnalyser.getHistory());
}

// ── Register routes on the given express app ──────────────────────────────────
function register(app) {
  app.get   ('/football/api/events',                   handleSse);
  app.get   ('/football/api/bets',                     handleGetBets);
  app.get   ('/football/api/bets.csv',                 handleGetBetsCsv);
  app.delete('/football/api/bets/:id',                 handleDeleteBet);
  app.patch ('/football/api/bets/:id',                 handlePatchBet);
  app.post ('/football/api/bets/:id/fetch-result',   handleFetchResult);
  app.post ('/football/api/bets/:id/live-snapshot',  handleLiveSnapshot);
  app.get  ('/football/api/prices/:marketId',        handlePrices);
  app.post ('/football/api/import-cbb',              handleImportCBB);
  app.get  ('/football/api/cbb-push-config',         handleGetCbbPushConfig);
  app.post ('/football/api/cbb-push-config',         handleSetCbbPushConfig);
  app.post ('/football/api/refresh-cbb-outcomes',    handleRefreshCbbOutcomes);
  app.post ('/football/api/backfill-match-names',    handleBackfillMatchNames);
  app.get  ('/football/api/upload.csv',              handleDownloadBfbmCsv);
  app.get  ('/football/api/bfbm-csv',                handleDownloadBfbmCsv);
  app.get  ('/football/api/exceptions',              handleExceptions);
  app.get  ('/football/api/sportmonks/live',         handleSmLive);
  app.get  ('/football/api/sm-strategies',           handleSmStrategiesGet);
  app.post ('/football/api/sm-strategies',           handleSmStrategiesPost);
  app.get  ('/football/api/goals/history',           handleGoalsHistory);
  app.get  ('/football/api/analysis/run',            handleFootballAnalysisRun);
  app.get  ('/football/api/analysis/history',        handleFootballAnalysisHistory);

  // Background tasks
  watchBetsFile();
  scanPendingBets();
  setInterval(scanPendingBets, 5 * 60 * 1000);
  // CBB auto-settler — runs 90s after start (CBB-side outcomes lag a beat
  // behind market close) then every 5 min. Skips itself when no pending bets.
  setTimeout(scanCbbOutcomes, 90 * 1000);
  setInterval(scanCbbOutcomes, 5 * 60 * 1000);

  console.log('[footballBot] routes registered at /football/api/*');
}

module.exports = { register };
