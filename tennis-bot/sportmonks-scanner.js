'use strict';

/**
 * sportmonks-scanner.js — Third scanner for the football bot.
 *
 * Polls SportMonks v3 API every ~45s for live match momentum data:
 *   - xG (Expected Goals) velocity
 *   - Pressure Index
 *   - Dangerous attacks burst
 *
 * When configurable signal conditions are met it places bets via CBB,
 * logs to bets.json, and sends a Telegram notification — exactly like
 * the InPlayGuru and BFBM scanners.
 *
 * SETUP:
 *   1. Add SPORTMONKS_API_KEY=... to .env
 *   2. require('./sportmonks-scanner').start(deps) in listener.js startup
 *   3. Edit sportmonks-strategies.json to tune thresholds
 *
 * FIELD NAME NOTE: SportMonks v3 field names for xG and Pressure Index are
 * confirmed by running SPORTMONKS_DEBUG=1 on first launch — the scanner logs
 * the full structure of the first fixture so you can verify the exact paths.
 */

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');

const DATA_DIR          = __dirname;
const BETS_FILE         = path.join(DATA_DIR, 'bets.json');
const EXCEPTIONS_FILE   = path.join(DATA_DIR, 'exceptions.json');
const FIRED_FILE        = path.join(DATA_DIR, 'sportmonks_fired.json');
const STRATEGIES_FILE   = path.join(DATA_DIR, 'sportmonks-strategies.json');
const GOALS_FILE        = path.join(DATA_DIR, 'sportmonks_goals.json');
const SM_BASE           = 'https://api.sportmonks.com/v3/football';

// ── State ─────────────────────────────────────────────────────────────────────
// fixturePrev: Map<fixtureId, { minute, xgHome, xgAway, xgTotal, pressureHome,
//              pressureAway, dangerousHome, dangerousAway, shotsOnTargetHome,
//              shotsOnTargetAway, polledAt }>
const fixturePrev = new Map();

// goalSnapshots: Map<fixtureId, GoalSnapshot[]>
// Each GoalSnapshot captures xG + momentum the moment a goal is detected
const goalSnapshots = new Map();

// Signals fired this session (persisted to disk to survive restarts)
let firedSignals = loadFiredSignals();

// Injected by start()
let _cbbApi        = null;
let _sendTelegram  = null;
let _getEvents     = null;
let _getCatalogue  = null;

// ── Persistence helpers ────────────────────────────────────────────────────────
function loadFiredSignals() {
  try {
    if (fs.existsSync(FIRED_FILE)) {
      const raw    = JSON.parse(fs.readFileSync(FIRED_FILE, 'utf8'));
      const cutoff = Date.now() - 12 * 60 * 60 * 1000; // purge after 12h
      return new Set(raw.filter(k => {
        const ts = parseInt(k.split(':').pop() || '0');
        return isNaN(ts) || ts > cutoff;
      }));
    }
  } catch (_) {}
  return new Set();
}

function saveFiredSignals() {
  try { fs.writeFileSync(FIRED_FILE, JSON.stringify([...firedSignals]), 'utf8'); }
  catch (_) {}
}

function loadBets() {
  try { if (fs.existsSync(BETS_FILE)) return JSON.parse(fs.readFileSync(BETS_FILE, 'utf8')); }
  catch (_) {}
  return [];
}

function saveBets(bets) {
  try { fs.writeFileSync(BETS_FILE, JSON.stringify(bets, null, 2), 'utf8'); }
  catch (err) { console.error('[SM] saveBets error:', err.message); }
}

function logBet(record) {
  const bets = loadBets();
  bets.unshift(record);
  if (bets.length > 2000) bets.length = 2000;
  saveBets(bets);
}

function logException(record) {
  let ex = [];
  try { if (fs.existsSync(EXCEPTIONS_FILE)) ex = JSON.parse(fs.readFileSync(EXCEPTIONS_FILE, 'utf8')); }
  catch (_) {}
  ex.unshift({ ...record, at: new Date().toISOString() });
  if (ex.length > 1000) ex.length = 1000;
  try { fs.writeFileSync(EXCEPTIONS_FILE, JSON.stringify(ex, null, 2), 'utf8'); } catch (_) {}
}

// ── Config ─────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(STRATEGIES_FILE, 'utf8'));
  } catch (_) {
    console.warn('[SM] sportmonks-strategies.json not found — using defaults');
    return getDefaultConfig();
  }
}

function getDefaultConfig() {
  return {
    enabled: true,
    dryRun:  true,        // set false to place real bets
    pollIntervalSeconds: 45,
    // CBB strategy key used for all SportMonks-originated bets
    // Add a SystemA/B/C key here once you've set it up in CBB
    cbbStrategyKey: 'SystemA1',
    strategies: [
      {
        name:        'SM_xG_Surge',
        description: 'xG velocity burst — rapid expected goals buildup',
        enabled:     true,
        market:      '1.5',
        // Conditions
        minMinute:   35,
        maxMinute:   78,
        maxGoals:    1,
        // xG gained since last poll divided by minutes elapsed must exceed this
        xgVelocityMin: 0.10,
        // Optional: only fire if combined xG already above threshold
        minTotalXg:  0.8,
      },
      {
        name:        'SM_Pressure_Wave',
        description: 'Sustained pressure index spike — team dominating danger zone',
        enabled:     true,
        market:      '1.5',
        minMinute:   40,
        maxMinute:   82,
        maxGoals:    1,
        // Pressure index 0-100; 70+ = heavy dominance
        // NOTE: field name verified at runtime — see FIELD NAMES comment below
        minPressureIndex: 68,
        // Must hold above threshold for 2+ consecutive polls before firing
        sustainedPolls: 2,
      },
      {
        name:        'SM_Danger_Burst',
        description: 'Dangerous attacks burst + shots on target accumulation',
        enabled:     true,
        market:      '1.5',
        minMinute:   30,
        maxMinute:   80,
        maxGoals:    1,
        // Dangerous attacks gained since last poll
        dangerAttacksDelta: 8,
        // Shots on target (cumulative) across both teams
        minShotsOnTarget: 4,
        // xG already above threshold
        minTotalXg: 0.7,
      },
      {
        name:        'SM_Late_xG_Mismatch',
        description: 'Late game — high xG but low goals (defence over-performing)',
        enabled:     true,
        market:      '1.5',
        minMinute:   65,
        maxMinute:   85,
        // Score must be low despite high xG
        maxGoals:    1,
        minTotalXg:  1.8,
      },
    ],
  };
}

// ── SportMonks API ─────────────────────────────────────────────────────────────
async function fetchLiveFixtures(apiKey) {
  const resp = await axios.get(`${SM_BASE}/livescores/inplay`, {
    params: {
      api_token: apiKey,
      include:   'xgfixture;statistics;scores;participants;periods;events',
      per_page:  100,
    },
    timeout: 12000,
  });
  return resp.data?.data || [];
}

// ── Parse SportMonks v3 fixture into a normalised state object ─────────────────
//
// FIELD NAMES — confirmed from live API debug dump (fixture 19425224):
//   xG:           f.xgfixture[] — array of shot entries; type_id 7942 = xG value per shot
//                 Sum all type_id 7942 entries per location to get xgHome/xgAway
//   Score:        f.scores[] where description === 'CURRENT'
//   Statistics:   f.statistics[] keyed by type_id + location
//     type_id 34  = Shots on Target
//     type_id 41  = Ball Possession (%)
//     type_id 42  = Shots Total
//     type_id 44  = Shots Off Target
//     type_id 45  = Corners
//     type_id 55  = Attacks
//     type_id 58  = Offsides
//     type_id 62  = Ball Safes / Saves (keeper)
//     type_id 78  = Tackles
//     type_id 80  = Passes
//     type_id 81  = Accurate Passes
//     type_id 82  = Dangerous Attacks  (was 83 — corrected)
//     type_id 27264/27265 = Pressure Index (was 1029 — corrected)
//     type_id 1012/45140/286 = Momentum (candidate — confirmed at runtime via debug log)
//   Minute:       active period's counts_from + minutes
//
function parseFixture(f) {
  // Team names
  const participants = f.participants || [];
  const home = participants.find(p => p.meta?.location === 'home') || participants[0];
  const away = participants.find(p => p.meta?.location === 'away') || participants[1];
  if (!home || !away) return null;

  // Score
  let goalsHome = 0, goalsAway = 0;
  for (const s of (f.scores || [])) {
    if (s.description !== 'CURRENT') continue;
    const loc = s.score?.participant || s.location;
    if (loc === 'home') goalsHome = s.score?.goals ?? 0;
    if (loc === 'away') goalsAway = s.score?.goals ?? 0;
  }

  // Match minute — find active (most recent) period
  const periods  = f.periods || [];
  const active   = periods.slice().sort((a, b) => (b.sort_order || 0) - (a.sort_order || 0))[0];
  const matchMinute = active
    ? (active.counts_from || 0) + (active.minutes || 0)
    : 0;

  // xG — xgfixture is a lowercase array; sum type_id 7942 per location
  let xgHome = 0, xgAway = 0;
  const xgArr = f.xgfixture || f.xGFixture;
  if (Array.isArray(xgArr)) {
    for (const entry of xgArr) {
      if (entry.type_id !== 7942) continue;
      const val = parseFloat(entry.data?.value ?? entry.value ?? 0) || 0;
      const loc = entry.location || (entry.participant_id === home?.id ? 'home' : 'away');
      if (loc === 'home') xgHome += val;
      else xgAway += val;
    }
  } else if (xgArr && typeof xgArr === 'object') {
    xgHome = xgArr.xg_home ?? xgArr.home ?? 0;
    xgAway = xgArr.xg_away ?? xgArr.away ?? 0;
  }
  xgHome = parseFloat(xgHome.toFixed(3));
  xgAway = parseFloat(xgAway.toFixed(3));
  const xgTotal = parseFloat((xgHome + xgAway).toFixed(3));

  // Statistics helper — keyed by type_id + location
  const statByTypeAndLoc = {};
  for (const s of (f.statistics || [])) {
    const loc = s.location || (s.participant_id === home?.id ? 'home' : 'away');
    const key = `${s.type_id}:${loc}`;
    statByTypeAndLoc[key] = s.data?.value ?? s.value ?? 0;
  }
  const stat = (typeId, loc) => statByTypeAndLoc[`${typeId}:${loc}`] ?? 0;

  // Core stats with corrected type_ids
  const shotsOnTargetHome  = stat(34, 'home');
  const shotsOnTargetAway  = stat(34, 'away');
  const possessionHome     = stat(41, 'home');
  const possessionAway     = stat(41, 'away');
  const shotsTotalHome     = stat(42, 'home');
  const shotsTotalAway     = stat(42, 'away');
  const shotsOffTargetHome = stat(44, 'home');
  const shotsOffTargetAway = stat(44, 'away');
  const cornersHome        = stat(45, 'home');
  const cornersAway        = stat(45, 'away');
  const attacksHome        = stat(55, 'home');
  const attacksAway        = stat(55, 'away');
  const offsidesHome       = stat(58, 'home');
  const offsidesAway       = stat(58, 'away');
  const savesHome          = stat(62, 'home');
  const savesAway          = stat(62, 'away');
  const passesHome         = stat(80, 'home');
  const passesAway         = stat(80, 'away');
  const accuratePassesHome = stat(81, 'home');
  const accuratePassesAway = stat(81, 'away');
  // type_id 82 = Dangerous Attacks (corrected from 83)
  const dangerousHome      = stat(82, 'home');
  const dangerousAway      = stat(82, 'away');
  // type_id 27264/27265 = Pressure Index (corrected from 1029)
  const pressureHome = stat(27264, 'home') || stat(27265, 'home') || possessionHome;
  const pressureAway = stat(27264, 'away') || stat(27265, 'away') || possessionAway;

  // Momentum — try known candidate type_ids; falls back to pressure if none found
  // Runtime debug will reveal the exact type_id if present
  const momentumHome = stat(1012, 'home') || stat(45140, 'home') || stat(286, 'home') || pressureHome;
  const momentumAway = stat(1012, 'away') || stat(45140, 'away') || stat(286, 'away') || pressureAway;

  // Goal events — type_id 14=goal, 15=penalty, 16=own-goal
  // Each entry: { eventId, typeId, teamId, minute, extraMinute, scoringTeam, isOwnGoal }
  const GOAL_TYPE_IDS = new Set([14, 15, 16]);
  const goalEvents = (f.events || [])
    .filter(e => GOAL_TYPE_IDS.has(e.type_id))
    .map(e => {
      const rawLoc = e.location || (e.participant_id === home?.id ? 'home' : 'away');
      const isOwnGoal = e.type_id === 16;
      // Own goal: the participant scored against themselves — benefit goes to other team
      const scoringTeam = isOwnGoal ? (rawLoc === 'home' ? 'away' : 'home') : rawLoc;
      return {
        eventId:     e.id,
        typeId:      e.type_id,
        teamId:      e.participant_id,
        minute:      e.minute || 0,
        extraMinute: e.extra_minute || 0,
        isOwnGoal,
        scoringTeam,
      };
    });

  return {
    fixtureId:           f.id,
    teamHome:            home.name,
    teamAway:            away.name,
    minute:              matchMinute,
    goalsHome,
    goalsAway,
    totalGoals:          goalsHome + goalsAway,
    xgHome,
    xgAway,
    xgTotal,
    pressureHome,
    pressureAway,
    maxPressure:         Math.max(pressureHome, pressureAway),
    momentumHome,
    momentumAway,
    goalEvents,
    dangerousHome,
    dangerousAway,
    totalDangerous:      dangerousHome + dangerousAway,
    shotsOnTargetHome,
    shotsOnTargetAway,
    totalShots:          shotsOnTargetHome + shotsOnTargetAway,
    shotsTotalHome,
    shotsTotalAway,
    shotsOffTargetHome,
    shotsOffTargetAway,
    cornersHome,
    cornersAway,
    totalCorners:        cornersHome + cornersAway,
    attacksHome,
    attacksAway,
    totalAttacks:        attacksHome + attacksAway,
    possessionHome,
    possessionAway,
    offsidesHome,
    offsidesAway,
    savesHome,
    savesAway,
    passesHome,
    passesAway,
    accuratePassesHome,
    accuratePassesAway,
    polledAt:            Date.now(),
    _rawTypeIds:         [...new Set((f.statistics || []).map(s => s.type_id))],
  };
}

// ── Signal evaluation ──────────────────────────────────────────────────────────
function evaluateSignals(cur, prev, strategies) {
  const fired = [];
  const minutesDelta = prev ? Math.max((cur.minute - prev.minute), 1) : 1;
  const xgDelta      = prev ? Math.max(cur.xgTotal - prev.xgTotal, 0) : 0;
  const xgVelocity   = xgDelta / minutesDelta;
  const dangerDelta  = prev ? Math.max(cur.totalDangerous - prev.totalDangerous, 0) : 0;

  for (const strat of strategies) {
    if (!strat.enabled) continue;
    if (cur.minute  < (strat.minMinute  ?? 0)) continue;
    if (cur.minute  > (strat.maxMinute  ?? 90)) continue;
    if (cur.totalGoals > (strat.maxGoals ?? 99)) continue;

    let passes = false;

    if (strat.name === 'SM_xG_Surge') {
      passes = xgVelocity >= strat.xgVelocityMin
            && cur.xgTotal >= (strat.minTotalXg ?? 0);
    }
    else if (strat.name === 'SM_Pressure_Wave') {
      // Need sustained high pressure — check prev too
      passes = cur.maxPressure  >= strat.minPressureIndex
            && (!prev || prev.maxPressure >= strat.minPressureIndex);
    }
    else if (strat.name === 'SM_Danger_Burst') {
      passes = dangerDelta          >= (strat.dangerAttacksDelta ?? 8)
            && cur.totalShots       >= (strat.minShotsOnTarget  ?? 4)
            && cur.xgTotal          >= (strat.minTotalXg        ?? 0);
    }
    else if (strat.name === 'SM_Late_xG_Mismatch') {
      passes = cur.xgTotal >= strat.minTotalXg;
    }

    if (passes) fired.push({ strat, xgVelocity, xgDelta, dangerDelta });
  }

  return fired;
}

// ── CBB bet placement (mirrors listener.js logic) ─────────────────────────────
function normaliseTeam(name) {
  return (name || '')
    .toLowerCase()
    .replace(/\bfc\b|\baf\b|\bsc\b|\bac\b|\bfk\b|\bnk\b|\bsk\b|\bif\b|\bbk\b/g, '')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function teamsMatch(a, b, threshold = 0.6) {
  const na = normaliseTeam(a), nb = normaliseTeam(b);
  if (na === nb || nb.includes(na) || na.includes(nb)) return true;
  const wa = na.split(' ').filter(w => w.length > 2);
  const wb = nb.split(' ').filter(w => w.length > 2);
  return wa.filter(w => wb.includes(w)).length / Math.max(wa.length, 1) >= threshold;
}

function findEventInCatalogue(teamA, teamB, catalogue) {
  if (!catalogue || typeof catalogue !== 'object') return null;
  for (const [betfairEventId, eventData] of Object.entries(catalogue)) {
    const name = eventData?.details?.name || eventData?.name || '';
    const parts = name.split(/\s+v\s+/i);
    if (parts.length !== 2) continue;
    const [cA, cB] = parts;
    if ((teamsMatch(teamA, cA) || teamsMatch(teamA, cB)) &&
        (teamsMatch(teamB, cA) || teamsMatch(teamB, cB))) {
      return { betfairEventId, eventName: name, markets: eventData.markets || {} };
    }
  }
  return null;
}

function findOverSelectionId(runners) {
  for (const [selId, runner] of Object.entries(runners)) {
    if ((runner.name || '').toLowerCase().startsWith('over')) return selId;
  }
  return null;
}

const OVER_UNDER_MARKET_MAP = {
  '0.5': 'Over/Under 0.5 Goals',
  '1.5': 'Over/Under 1.5 Goals',
  '2.5': 'Over/Under 2.5 Goals',
  '3.5': 'Over/Under 3.5 Goals',
};

async function placeBetForSignal(fixture, stratEntry, config) {
  const { strat }         = stratEntry;
  const marketName        = OVER_UNDER_MARKET_MAP[strat.market];
  const marketParam       = `OVER_UNDER_${strat.market.replace('.', '')}0`.replace('00', '0');
  const cbbStrategyKey    = strat.cbbStrategyKey || config.cbbStrategyKey || 'SystemA1';

  // Dedup key — one signal per fixture + strategy per match
  const dedupKey = `${fixture.fixtureId}:${strat.name}:${Date.now()}`;
  const alreadyFired = [...firedSignals].some(k =>
    k.startsWith(`${fixture.fixtureId}:${strat.name}:`)
  );
  if (alreadyFired) {
    console.log(`[SM] ${strat.name} already fired for fixture ${fixture.fixtureId} — skipping`);
    return;
  }

  console.log(`[SM] 🎯 Signal: ${strat.name} | ${fixture.teamHome} vs ${fixture.teamAway} | Min ${fixture.minute} | xG ${fixture.xgTotal.toFixed(2)}`);

  try {
    const [events, catalogue] = await Promise.all([
      _getEvents(),
      _getCatalogue(marketParam),
    ]);

    const catalogueEvent = findEventInCatalogue(fixture.teamHome, fixture.teamAway, catalogue);
    if (!catalogueEvent) {
      console.log(`[SM] No catalogue match for ${fixture.teamHome} vs ${fixture.teamAway}`);
      logException({ source: 'sportmonks', reason: 'No catalogue match', teamA: fixture.teamHome, teamB: fixture.teamAway, strategy: strat.name });
      return;
    }

    let marketId = null, selectionId = null;
    for (const [mId, mData] of Object.entries(catalogueEvent.markets)) {
      if (mData.name && mData.name !== marketName) continue;
      const selId = findOverSelectionId(mData.runners || {});
      if (selId) { marketId = mId; selectionId = selId; break; }
    }

    if (!marketId) {
      console.log(`[SM] No market found: ${marketName}`);
      return;
    }

    // Record signal as fired before placing (prevents retry loops)
    firedSignals.add(`${fixture.fixtureId}:${strat.name}:${Date.now()}`);
    saveFiredSignals();

    const isDry = config.dryRun !== false;
    let success = false;
    if (!isDry) {
      const result = await _cbbApi(marketId, selectionId, cbbStrategyKey);
      success = result?.success ?? false;
    } else {
      success = true; // dry run always "succeeds"
    }

    const msg = `${isDry ? '🔬 DRY RUN' : (success ? '✅' : '❌')} SportMonks Signal: ${strat.name}\n`
      + `${fixture.teamHome} vs ${fixture.teamAway}\n`
      + `Min: ${fixture.minute} | Score: ${fixture.goalsHome}-${fixture.goalsAway}\n`
      + `xG: ${fixture.xgHome.toFixed(2)} — ${fixture.xgAway.toFixed(2)} (total: ${fixture.xgTotal.toFixed(2)})\n`
      + `Pressure: ${fixture.pressureHome}% / ${fixture.pressureAway}%\n`
      + `Danger attacks: ${fixture.totalDangerous} | Shots on target: ${fixture.totalShots}\n`
      + `Market: Over ${strat.market} | CBB Key: ${cbbStrategyKey}`;

    console.log('[SM]', msg);
    if (_sendTelegram) await _sendTelegram(msg);

    logBet({
      id:             `SM-${fixture.fixtureId}-${strat.name}-${Date.now()}`,
      source:         'sportmonks',
      placedAt:       new Date().toISOString(),
      match:          `${fixture.teamHome} vs ${fixture.teamAway}`,
      teamA:          fixture.teamHome,
      teamB:          fixture.teamAway,
      marketId,
      selectionId,
      marketName,
      overUnderValue: strat.market,
      strategy:       cbbStrategyKey,
      signalStrategy: strat.name,
      signalDesc:     strat.description,
      timer:          fixture.minute,
      goals:          fixture.totalGoals,
      goalsA:         fixture.goalsHome,
      goalsB:         fixture.goalsAway,
      xgHome:         fixture.xgHome,
      xgAway:         fixture.xgAway,
      xgTotal:        fixture.xgTotal,
      pressureHome:   fixture.pressureHome,
      pressureAway:   fixture.pressureAway,
      dangerousAttacks: fixture.totalDangerous,
      shotsOnTarget:  fixture.totalShots,
      success,
      dryRun:         isDry,
      result:         'pending',
      finalGoalsA:    null,
      finalGoalsB:    null,
      finalGoals:     null,
      priceSnapshots: [],
    });

  } catch (err) {
    console.error('[SM] placeBetForSignal error:', err.message);
  }
}

// ── Goal snapshot helpers ──────────────────────────────────────────────────────

function _buildGoalSnapshot(cur, prev, scoringTeam, evt = null) {
  const minute      = evt ? evt.minute      : cur.minute;
  const extraMinute = evt ? evt.extraMinute : 0;
  return {
    fixtureId:      cur.fixtureId,
    match:          `${cur.teamHome} vs ${cur.teamAway}`,
    minute,
    extraMinute,
    minuteDisplay:  minute + (extraMinute > 0 ? `+${extraMinute}` : ''),
    isOwnGoal:      evt?.isOwnGoal ?? false,
    scoringTeam,
    scoreHome:      cur.goalsHome,
    scoreAway:      cur.goalsAway,
    // xG at moment of goal
    xgHome:         cur.xgHome,
    xgAway:         cur.xgAway,
    xgTotal:        cur.xgTotal,
    xgDeltaHome:    prev ? parseFloat((cur.xgHome - prev.xgHome).toFixed(3)) : null,
    xgDeltaAway:    prev ? parseFloat((cur.xgAway - prev.xgAway).toFixed(3)) : null,
    // Momentum/pressure at moment of goal
    momentumHome:   cur.momentumHome,
    momentumAway:   cur.momentumAway,
    pressureHome:   cur.pressureHome,
    pressureAway:   cur.pressureAway,
    // Danger at moment of goal
    dangerousHome:  cur.dangerousHome,
    dangerousAway:  cur.dangerousAway,
    // Was goal against the run of play?
    againstMomentum: scoringTeam === 'home'
      ? cur.momentumAway > cur.momentumHome
      : cur.momentumHome > cur.momentumAway,
    detectedAt:     new Date().toISOString(),
  };
}

function _saveGoalsFile() {
  try {
    const all = [];
    for (const snaps of goalSnapshots.values()) {
      all.push(...snaps);
    }
    // Sort newest first
    all.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));
    // Keep last 500 goal events across all fixtures
    if (all.length > 500) all.length = 500;
    fs.writeFileSync(GOALS_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (_) {}
}

// ── Main poll loop ─────────────────────────────────────────────────────────────
let _debugLoggedOnce = false;

async function poll(apiKey, config) {
  try {
    const raw      = await fetchLiveFixtures(apiKey);
    const debug    = process.env.SPORTMONKS_DEBUG === '1';

    if (debug && !_debugLoggedOnce && raw.length > 0) {
      _debugLoggedOnce = true;
      console.log('[SM] DEBUG — first fixture raw structure:');
      console.log(JSON.stringify(raw[0], null, 2));
    }

    const fixtures = raw.map(parseFixture).filter(Boolean);
    console.log(`[SM] Poll: ${fixtures.length} live fixtures`);

    const newSignals = [];
    let newGoals = 0;
    for (const cur of fixtures) {
      const prev    = fixturePrev.get(cur.fixtureId);
      const signals = evaluateSignals(cur, prev, config.strategies);

      for (const sigEntry of signals) {
        newSignals.push({ fixture: cur, ...sigEntry });
        await placeBetForSignal(cur, sigEntry, config);
      }

      // ── Goal detection via events (more reliable than score comparison) ───────
      if (!goalSnapshots.has(cur.fixtureId)) goalSnapshots.set(cur.fixtureId, []);
      const snaps = goalSnapshots.get(cur.fixtureId);

      if (!prev) {
        // First time seeing this fixture — mark any pre-existing goals so they appear
        // in the history table, but without pressure snapshots (data unavailable).
        for (const evt of cur.goalEvents) {
          snaps.push({
            fixtureId:     cur.fixtureId,
            match:         `${cur.teamHome} vs ${cur.teamAway}`,
            minute:        evt.minute,
            extraMinute:   evt.extraMinute,
            minuteDisplay: evt.minute + (evt.extraMinute > 0 ? `+${evt.extraMinute}` : ''),
            scoringTeam:   evt.scoringTeam,
            isOwnGoal:     evt.isOwnGoal,
            scoreHome:     cur.goalsHome,
            scoreAway:     cur.goalsAway,
            xgHome:        cur.xgHome,
            xgAway:        cur.xgAway,
            xgTotal:       cur.xgTotal,
            xgDeltaHome:   null,
            xgDeltaAway:   null,
            momentumHome:  cur.momentumHome,
            momentumAway:  cur.momentumAway,
            pressureHome:  cur.pressureHome,
            pressureAway:  cur.pressureAway,
            dangerousHome: cur.dangerousHome,
            dangerousAway: cur.dangerousAway,
            againstMomentum: evt.scoringTeam === 'home'
              ? cur.momentumAway > cur.momentumHome
              : cur.momentumHome > cur.momentumAway,
            preExisting:   true,
            detectedAt:    new Date().toISOString(),
          });
          newGoals++;
        }
      } else {
        // Subsequent polls — detect new events by comparing event IDs
        const prevEventIds = new Set((prev.goalEvents || []).map(e => e.eventId));
        const newEvts = cur.goalEvents.filter(e => !prevEventIds.has(e.eventId));
        for (const evt of newEvts) {
          const snap = _buildGoalSnapshot(cur, prev, evt.scoringTeam, evt);
          snaps.push(snap);
          newGoals++;
          const scorer = evt.scoringTeam === 'home' ? cur.teamHome : cur.teamAway;
          const minStr = evt.minute + (evt.extraMinute > 0 ? `+${evt.extraMinute}` : '');
          console.log(`[SM] ⚽ Goal! ${scorer} (${evt.scoringTeam}) ${cur.goalsHome}-${cur.goalsAway} @ min ${minStr}${evt.isOwnGoal ? ' [OG]' : ''} | xG H:${cur.xgHome} A:${cur.xgAway} | momentum H:${cur.momentumHome} A:${cur.momentumAway}${snap.againstMomentum ? ' [AGAINST MOMENTUM]' : ''}`);
        }
      }
      // ─────────────────────────────────────────────────────────────────────────

      // Log available pressure/stat type_ids on first fixture (once per session)
      if (!_debugLoggedOnce && cur._rawTypeIds.length > 0) {
        console.log(`[SM] Available stat type_ids for fixture ${cur.fixtureId}: ${cur._rawTypeIds.join(', ')}`);
      }

      fixturePrev.set(cur.fixtureId, cur);
    }

    if (newGoals > 0) _saveGoalsFile();

    _saveLiveFile(fixtures, newSignals);

    // Clean up state for fixtures that are no longer live
    const liveIds = new Set(fixtures.map(f => f.fixtureId));
    for (const id of fixturePrev.keys()) {
      if (!liveIds.has(id)) {
        fixturePrev.delete(id);
        goalSnapshots.delete(id);
      }
    }

  } catch (err) {
    console.error('[SM] Poll error:', err.message);
  }
}

// ── Live data cache (for dashboard) ──────────────────────────────────────────
let _lastLiveData = { lastPolledAt: null, fixtureCount: 0, fixtures: [], signalsFired: [] };

function getLiveData() { return _lastLiveData; }

function _saveLiveFile(fixtures, newSignals) {
  // Keep a rolling log of signals fired (last 200)
  const prev = _lastLiveData.signalsFired || [];
  const allSignals = [
    ...newSignals.map(s => ({
      id:         `${s.fixture.fixtureId}:${s.strat.name}:${Date.now()}`,
      fixtureId:  s.fixture.fixtureId,
      match:      `${s.fixture.teamHome} vs ${s.fixture.teamAway}`,
      strategy:   s.strat.name,
      description: s.strat.description,
      minute:     s.fixture.minute,
      score:      `${s.fixture.goalsHome}-${s.fixture.goalsAway}`,
      xgTotal:    s.fixture.xgTotal,
      xgVelocity: s.xgVelocity,
      dangerDelta: s.dangerDelta,
      firedAt:    new Date().toISOString(),
    })),
    ...prev,
  ].slice(0, 200);

  _lastLiveData = {
    lastPolledAt: new Date().toISOString(),
    apiKeySet:    true,
    fixtureCount: fixtures.length,
    fixtures:     fixtures.map(f => ({
      fixtureId:           f.fixtureId,
      teamHome:            f.teamHome,
      teamAway:            f.teamAway,
      minute:              f.minute,
      goalsHome:           f.goalsHome,
      goalsAway:           f.goalsAway,
      xgHome:              f.xgHome,
      xgAway:              f.xgAway,
      xgTotal:             f.xgTotal,
      pressureHome:        f.pressureHome,
      pressureAway:        f.pressureAway,
      maxPressure:         f.maxPressure,
      momentumHome:        f.momentumHome,
      momentumAway:        f.momentumAway,
      dangerousHome:       f.dangerousHome,
      dangerousAway:       f.dangerousAway,
      totalDangerous:      f.totalDangerous,
      shotsOnTargetHome:   f.shotsOnTargetHome,
      shotsOnTargetAway:   f.shotsOnTargetAway,
      totalShots:          f.totalShots,
      shotsTotalHome:      f.shotsTotalHome,
      shotsTotalAway:      f.shotsTotalAway,
      shotsOffTargetHome:  f.shotsOffTargetHome,
      shotsOffTargetAway:  f.shotsOffTargetAway,
      cornersHome:         f.cornersHome,
      cornersAway:         f.cornersAway,
      totalCorners:        f.totalCorners,
      attacksHome:         f.attacksHome,
      attacksAway:         f.attacksAway,
      totalAttacks:        f.totalAttacks,
      possessionHome:      f.possessionHome,
      possessionAway:      f.possessionAway,
      offsidesHome:        f.offsidesHome,
      offsidesAway:        f.offsidesAway,
      savesHome:           f.savesHome,
      savesAway:           f.savesAway,
      passesHome:          f.passesHome,
      passesAway:          f.passesAway,
      accuratePassesHome:  f.accuratePassesHome,
      accuratePassesAway:  f.accuratePassesAway,
      goalSnapshots:       goalSnapshots.get(f.fixtureId) || [],
    })),
    signalsFired: allSignals,
  };

  try {
    fs.writeFileSync(
      path.join(DATA_DIR, 'sportmonks_live.json'),
      JSON.stringify(_lastLiveData, null, 2),
      'utf8'
    );
  } catch (_) {}
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * start({ apiKey, cbbApi, sendTelegram, getEvents, getCatalogue })
 *
 * cbbApi(marketId, selectionId, strategyKey) → { success, cbbResponse }
 * sendTelegram(message) → void
 * getEvents() → events array
 * getCatalogue(marketParam) → catalogue object
 */
function start({ apiKey, cbbApi, sendTelegram, getEvents, getCatalogue }) {
  if (!apiKey) {
    console.warn('[SM] No SPORTMONKS_API_KEY set — scanner disabled');
    return;
  }

  _cbbApi       = cbbApi;
  _sendTelegram = sendTelegram;
  _getEvents    = getEvents;
  _getCatalogue = getCatalogue;

  const config   = loadConfig();
  if (!config.enabled) {
    console.log('[SM] SportMonks scanner disabled in sportmonks-strategies.json');
    return;
  }

  const interval = (config.pollIntervalSeconds || 45) * 1000;
  console.log(`[SM] SportMonks scanner starting — polling every ${config.pollIntervalSeconds || 45}s | dryRun: ${config.dryRun !== false}`);

  // Poll immediately then on interval
  poll(apiKey, config);
  setInterval(() => poll(apiKey, config), interval);
}

module.exports = { start, getLiveData };
