'use strict';

/**
 * strategyEngine.js
 *
 * Evaluates set-result based strategy triggers defined in strategies.json.
 *
 * Each strategy's `backtest.trigger` describes the conditions that must be met
 * (e.g., set 1 complete, favourite lost, price moved 25%+) and `backtest.entry`
 * describes how to bet (player, side, odds range).
 *
 * Called every main loop tick. Returns the list of strategies that just fired so
 * index.js can place bets. A strategy fires at most once per market per session
 * (tracked by the caller via the `firedSet` argument).
 *
 * Supported trigger fields:
 *   setNumber          — which set must be complete (1-indexed)
 *   isTiebreak         — true/false — whether the set ended in a tiebreak
 *   allowedSet1Scores  — string[] — allowed scores from P1-P2 view e.g. ["7-6","6-7","6-4"]
 *   preMatchOddsLoser  — { min, max } — pre-match odds of whoever lost the set
 *   preMatchOddsWinner — { min, max } — pre-match odds of whoever won the set
 *   preMatchOddsA      — { min, max } — pre-match odds of player A (P1) specifically
 *   preMatchOddsB      — { min, max } — pre-match odds of player B (P2) specifically
 *   loserMustBe        — "A" | "B"   — the set loser must be this specific player
 *   minChangePct       — minimum % price move from pre-match to now (for the bet player)
 *
 * Supported filter fields (per-player serve stats):
 *   p1MinFirstServeIn / p1MaxFirstServeIn    — P1 1st serve in % range
 *   p1MinFirstServeWon / p1MaxFirstServeWon  — P1 1st serve won % range
 *   p1MinSecondServeWon / p1MaxSecondServeWon — P1 2nd serve won % range
 *   p1MinAces / p1MaxAces                    — P1 aces range
 *   p1MinDoubleFaults / p1MaxDoubleFaults    — P1 double faults range
 *   p1MinBreakpointsWon / p1MaxBreakpointsWon — P1 breakpoints converted range
 *   p2MinFirstServeIn / p2MaxFirstServeIn    — P2 1st serve in % range
 *   p2MinFirstServeWon / p2MaxFirstServeWon  — P2 1st serve won % range
 *   p2MinSecondServeWon / p2MaxSecondServeWon — P2 2nd serve won % range
 *   p2MinAces / p2MaxAces                    — P2 aces range
 *   p2MinDoubleFaults / p2MaxDoubleFaults    — P2 double faults range
 *   p2MinBreakpointsWon / p2MaxBreakpointsWon — P2 breakpoints converted range
 *   minFirstServeWonDiff / maxFirstServeWonDiff — band on (bet-player − opponent)
 *                          1st-serve-won % at the trigger set. 20pp at S1, 10pp
 *                          at S2 per study; max caps absurdly wide gaps.
 *
 * Supported entry fields:
 *   player   — "loser" | "winner" — who to bet on
 *   side     — "BACK" | "LAY"
 *   minOdds  — minimum current odds (optional)
 *   maxOdds  — maximum current odds (optional)
 */

const logger       = require('../utils/logger');
const serveScorer  = require('./serveScorer');

// ---------------------------------------------------------------------------
// Set helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if a set object has a definitive winner.
 * A set is complete when one player has ≥6 games with a 2-game lead, or one
 * player has 7 (tiebreak win: 7-6).
 */
function isSetComplete(set) {
  if (!set) return false;
  // 6-6 means tiebreak in progress — not complete yet
  if (set.playerA === 6 && set.playerB === 6) return false;
  const aWon = (set.playerA >= 6 && set.playerA - set.playerB >= 2) || set.playerA === 7;
  const bWon = (set.playerB >= 6 && set.playerB - set.playerA >= 2) || set.playerB === 7;
  return aWon || bWon;
}

/**
 * Returns the winner of a completed set ('playerA' or 'playerB').
 * Call only after isSetComplete() returns true.
 */
function setWinner(set) {
  const aWon = (set.playerA >= 6 && set.playerA - set.playerB >= 2) || set.playerA === 7;
  return aWon ? 'playerA' : 'playerB';
}

/**
 * Returns true if the set ended in a tiebreak (score contains a 7).
 */
function isTiebreakSet(set) {
  return !!(set && (
    (set.playerA === 7 && set.playerB === 6) ||
    (set.playerB === 7 && set.playerA === 6)
  ));
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Evaluate all enabled strategies against the current match state.
 *
 * Returns { triggers, rejections } where:
 *   triggers   — strategies that fired: [{ system, playerKey, side, odds, reason }]
 *   rejections — strategies that were evaluated but failed: [{ systemName, stage, reason }]
 *
 * @param {object}   matchState  — MatchState instance
 * @param {object[]} systems     — strategies.json systems array
 * @param {Set}      firedSet    — systemNames already fired for this market this session
 * @param {object}   [config]    — global liquidity config (strategies.json liquidity section)
 * @returns {{ triggers: object[], rejections: object[] }}
 */
function evaluateStrategies(matchState, systems, firedSet, config = {}) {
  if (!Array.isArray(systems) || !systems.length) return { triggers: [], rejections: [] };

  const minVolumeAtTrigger = config.minVolumeAtTrigger ?? 100_000;
  const globalFilters      = config.globalFilters || {};

  const {
    sets = [],
    preMatchOddsA,
    preMatchOddsB,
    playerABack,
    playerBBack,
    matchedVolume = 0,
    surface,
    tournament,
  } = matchState;

  // Collect rejection reasons so the caller can log them to the DB
  const rejections = [];
  const reject = (systemName, stage, reason) => {
    rejections.push({ systemName, stage, reason });
  };

  const results = [];

  for (const system of systems) {
    if (!system.enabled) continue;
    // Require a trigger + a usable entry. Guard entry.side specifically — an empty
    // entry object ({}) is truthy but would crash later on entry.side.toLowerCase().
    // (setNumber is intentionally NOT required — it defaults to 1 below.)
    if (!system.backtest?.trigger || !system.backtest?.entry?.side) continue;
    if (firedSet.has(system.name)) continue;

    const trigger = system.backtest.trigger;
    const entry   = system.backtest.entry;

    // ── Target set must exist and be complete ─────────────────────────────
    const setIdx    = (trigger.setNumber || 1) - 1;
    const targetSet = sets[setIdx];
    if (!targetSet || !isSetComplete(targetSet)) continue; // not yet — don't log, fires every loop

    // ── Only bet when the current set is at 0-0 ──────────────────────────────
    if (sets.length > setIdx + 1) {
      const cur = sets[sets.length - 1];
      if (cur.playerA !== 0 || cur.playerB !== 0) continue;
    }

    const winner = setWinner(targetSet);
    const loser  = winner === 'playerA' ? 'playerB' : 'playerA';

    // Helper — emit structured rejection and skip to next strategy
    let _rejected = false;
    const rej = (stage, reason) => { reject(system.name, stage, reason); _rejected = true; };

    // ── Tiebreak condition ────────────────────────────────────────────────
    if (trigger.isTiebreak === true  && !isTiebreakSet(targetSet))
      { rej('TIEBREAK', `Set ${trigger.setNumber} was not a tiebreak (${targetSet.playerA}-${targetSet.playerB})`); }
    if (trigger.isTiebreak === false &&  isTiebreakSet(targetSet))
      { rej('TIEBREAK', `Set ${trigger.setNumber} was a tiebreak but strategy requires non-tiebreak`); }
    if (_rejected) continue;

    // ── Set score filter ──────────────────────────────────────────────────
    const allowedScores = trigger.allowedSetScores || trigger.allowedSet1Scores;
    if (allowedScores?.length) {
      const scoreKey = `${targetSet.playerA}-${targetSet.playerB}`;
      if (!allowedScores.includes(scoreKey))
        { rej('SET_SCORE', `Score ${scoreKey} not in allowed: ${allowedScores.join(', ')}`); }
    }
    if (_rejected) continue;

    // ── loserMustBe ───────────────────────────────────────────────────────
    if (trigger.loserMustBe === 'A' && loser !== 'playerA')
      { rej('LOSER_MUST_BE', `loserMustBe=A but loser is playerB`); }
    if (trigger.loserMustBe === 'B' && loser !== 'playerB')
      { rej('LOSER_MUST_BE', `loserMustBe=B but loser is playerA`); }
    if (_rejected) continue;

    // ── Pre-match odds checks ─────────────────────────────────────────────
    const loserPreMatch  = loser  === 'playerA' ? preMatchOddsA : preMatchOddsB;
    const winnerPreMatch = winner === 'playerA' ? preMatchOddsA : preMatchOddsB;

    if (trigger.preMatchOddsLoser) {
      if (loserPreMatch == null)
        { rej('PRE_MATCH_ODDS', 'Pre-match odds not yet captured'); }
      else {
        const { min, max } = trigger.preMatchOddsLoser;
        if (loserPreMatch < min || loserPreMatch > max)
          { rej('PRE_MATCH_ODDS', `Loser pre-match ${loserPreMatch.toFixed(2)} outside [${min}–${max}]`); }
      }
    }
    if (trigger.preMatchOddsWinner) {
      if (winnerPreMatch == null)
        { rej('PRE_MATCH_ODDS', 'Pre-match odds not yet captured'); }
      else {
        const { min, max } = trigger.preMatchOddsWinner;
        if (winnerPreMatch < min || winnerPreMatch > max)
          { rej('PRE_MATCH_ODDS', `Winner pre-match ${winnerPreMatch.toFixed(2)} outside [${min}–${max}]`); }
      }
    }
    if (trigger.preMatchOddsA) {
      if (preMatchOddsA == null) { rej('PRE_MATCH_ODDS', 'Pre-match odds A not captured'); }
      else { const { min, max } = trigger.preMatchOddsA; if (preMatchOddsA < min || preMatchOddsA > max) rej('PRE_MATCH_ODDS', `preMatchOddsA ${preMatchOddsA.toFixed(2)} outside [${min}–${max}]`); }
    }
    if (trigger.preMatchOddsB) {
      if (preMatchOddsB == null) { rej('PRE_MATCH_ODDS', 'Pre-match odds B not captured'); }
      else { const { min, max } = trigger.preMatchOddsB; if (preMatchOddsB < min || preMatchOddsB > max) rej('PRE_MATCH_ODDS', `preMatchOddsB ${preMatchOddsB.toFixed(2)} outside [${min}–${max}]`); }
    }
    if (_rejected) continue;

    // ── Which player are we betting on? ──────────────────────────────────
    let betOn;
    if (entry.player === 'momentum_high') {
      const mom = matchState.momentumIndex ?? 0;
      if (mom === 0) { rej('MOMENTUM', 'Momentum index is 0 — no clear leader, skipping'); continue; }
      betOn = mom > 0 ? 'playerA' : 'playerB';
    } else {
      betOn = entry.player === 'loser' ? loser : winner;
    }
    const betPlayerKey = betOn === 'playerA' ? 'A' : 'B';
    const currentOdds  = betPlayerKey === 'A' ? playerABack : playerBBack;

    if (currentOdds == null) { rej('ODDS_UNAVAILABLE', `Current price for ${betOn} not available`); continue; }

    // ── Minimum price move % ──────────────────────────────────────────────
    if (trigger.minChangePct != null) {
      const betPreMatch = betOn === 'playerA' ? preMatchOddsA : preMatchOddsB;
      if (betPreMatch == null) { rej('PRICE_MOVE', 'Pre-match odds not captured for change % calc'); continue; }
      const changePct = Math.abs((currentOdds - betPreMatch) / betPreMatch * 100);
      if (changePct < trigger.minChangePct)
        rej('PRICE_MOVE', `Price moved ${changePct.toFixed(1)}% but min is ${trigger.minChangePct}%`);
    }
    if (_rejected) continue;

    // ── Entry odds range ──────────────────────────────────────────────────
    if (entry.minOdds != null && currentOdds < entry.minOdds)
      { rej('ENTRY_ODDS', `Current odds ${currentOdds.toFixed(2)} < min ${entry.minOdds}`); }
    if (entry.maxOdds != null && currentOdds > entry.maxOdds)
      { rej('ENTRY_ODDS', `Current odds ${currentOdds.toFixed(2)} > max ${entry.maxOdds}`); }
    if (_rejected) continue;

    // ── Global odds floor/ceiling (safety net for misconfigured strategies) ──
    const side = (entry.side || '').toUpperCase();
    if (side === 'BACK') {
      if (globalFilters.minOddsToBack != null && currentOdds < globalFilters.minOddsToBack)
        rej('GLOBAL_ODDS', `BACK odds ${currentOdds.toFixed(2)} < global min ${globalFilters.minOddsToBack}`);
      if (globalFilters.maxOddsToBack != null && currentOdds > globalFilters.maxOddsToBack)
        rej('GLOBAL_ODDS', `BACK odds ${currentOdds.toFixed(2)} > global max ${globalFilters.maxOddsToBack}`);
    } else if (side === 'LAY') {
      if (globalFilters.minOddsToLay != null && currentOdds < globalFilters.minOddsToLay)
        rej('GLOBAL_ODDS', `LAY odds ${currentOdds.toFixed(2)} < global min ${globalFilters.minOddsToLay}`);
      if (globalFilters.maxOddsToLay != null && currentOdds > globalFilters.maxOddsToLay)
        rej('GLOBAL_ODDS', `LAY odds ${currentOdds.toFixed(2)} > global max ${globalFilters.maxOddsToLay}`);
    }
    if (_rejected) continue;

    // ── Trigger-time liquidity ─────────────────────────────────────────────
    if (matchedVolume < minVolumeAtTrigger)
      { rej('VOLUME_AT_TRIGGER', `Volume at trigger ${matchedVolume.toFixed(0)} < min ${minVolumeAtTrigger}`); }
    if (_rejected) continue;

    // ── System-level filters ──────────────────────────────────────────────
    const f = system.filters || {};

    if (f.surfaces?.length && surface && !f.surfaces.includes(surface))
      { rej('SURFACE', `Surface "${surface}" not in [${f.surfaces.join(', ')}]`); }
    if (f.minMatchedVolume && matchedVolume < f.minMatchedVolume)
      { rej('VOLUME', `Volume ${matchedVolume.toFixed(0)} < system min ${f.minMatchedVolume}`); }
    if (f.blockedTournaments?.length && tournament) {
      const blocked = f.blockedTournaments.some(t => tournament.toUpperCase().includes(t.toUpperCase()));
      if (blocked) rej('BLOCKED_TOURNAMENT', `Tournament "${tournament}" is blocked`);
    }
    if (_rejected) continue;

    // ── Per-player serve stat filters ─────────────────────────────────────
    const triggerSet = trigger.setNumber || 1;
    const lssMap = { 1: matchState.liveServeStatsSet1, 2: matchState.liveServeStatsSet2, 3: matchState.liveServeStatsSet3 };
    const lss = lssMap[triggerSet] || matchState.liveServeStats || {};
    const ssA = lss.playerA || {};
    const ssB = lss.playerB || {};
    const bpMap = { 1: matchState.breakPointsSet1, 2: matchState.breakPointsSet2, 3: matchState.breakPointsSet3 };
    const bpLookup = bpMap[triggerSet] || matchState.breakPoints || {};

    const chkStat = (val, min, max, name) => {
      if (min != null && (val == null || val < min)) return rej('SERVE_STAT', `${name} ${val ?? 'null'} < min ${min}`);
      if (max != null && (val == null || val > max)) return rej('SERVE_STAT', `${name} ${val ?? 'null'} > max ${max}`);
    };

    chkStat(ssA.firstServeIn,   f.p1MinFirstServeIn,   f.p1MaxFirstServeIn,   'P1 1stIn');
    chkStat(ssA.firstServeWon,  f.p1MinFirstServeWon,  f.p1MaxFirstServeWon,  'P1 1stWon');
    chkStat(ssA.secondServeWon, f.p1MinSecondServeWon, f.p1MaxSecondServeWon, 'P1 2ndWon');
    chkStat(ssA.aces,           f.p1MinAces,           f.p1MaxAces,           'P1 Aces');
    chkStat(ssA.doubleFaults,   f.p1MinDoubleFaults,   f.p1MaxDoubleFaults,   'P1 DFs');
    const bpA = bpLookup.playerA || {};
    chkStat(bpA.converted,      f.p1MinBreakpointsWon, f.p1MaxBreakpointsWon, 'P1 BPconv');
    chkStat(ssB.firstServeIn,   f.p2MinFirstServeIn,   f.p2MaxFirstServeIn,   'P2 1stIn');
    chkStat(ssB.firstServeWon,  f.p2MinFirstServeWon,  f.p2MaxFirstServeWon,  'P2 1stWon');
    chkStat(ssB.secondServeWon, f.p2MinSecondServeWon, f.p2MaxSecondServeWon, 'P2 2ndWon');
    chkStat(ssB.aces,           f.p2MinAces,           f.p2MaxAces,           'P2 Aces');
    chkStat(ssB.doubleFaults,   f.p2MinDoubleFaults,   f.p2MaxDoubleFaults,   'P2 DFs');
    const bpB = bpLookup.playerB || {};
    chkStat(bpB.converted,      f.p2MinBreakpointsWon, f.p2MaxBreakpointsWon, 'P2 BPconv');

    // ── First-serve-won % differential (bet-player − opponent) ────────────
    // From the 184-match study: at S1 entry a 20pp edge is the threshold for
    // genuine dominance; at S2 entry 10pp is enough because the live odds
    // already absorbed the S1 information.
    if (f.minFirstServeWonDiff != null || f.maxFirstServeWonDiff != null) {
      const betStats = betOn === 'playerA' ? ssA : ssB;
      const oppStats = betOn === 'playerA' ? ssB : ssA;
      if (betStats.firstServeWon == null || oppStats.firstServeWon == null) {
        rej('SERVE_DIFF', `1st-serve-won % missing for set ${triggerSet} — cannot apply differential filter`);
      } else {
        const diff = betStats.firstServeWon - oppStats.firstServeWon;
        if (f.minFirstServeWonDiff != null && diff < f.minFirstServeWonDiff)
          rej('SERVE_DIFF', `1st-serve-won diff ${diff.toFixed(0)}pp (bet ${betStats.firstServeWon} − opp ${oppStats.firstServeWon}) < min ${f.minFirstServeWonDiff}pp`);
        if (f.maxFirstServeWonDiff != null && diff > f.maxFirstServeWonDiff)
          rej('SERVE_DIFF', `1st-serve-won diff ${diff.toFixed(0)}pp (bet ${betStats.firstServeWon} − opp ${oppStats.firstServeWon}) > max ${f.maxFirstServeWonDiff}pp`);
      }
    }
    if (_rejected) continue;

    // ── Serve quality filter (composite score + differential) ─────────────
    const sqf = system.backtest?.serveQualityFilter;
    if (sqf && !_rejected) {
      const winnerStats = winner === 'playerA' ? ssA : ssB;
      const loserStats  = loser  === 'playerA' ? ssA : ssB;
      const wScore = serveScorer.score(winnerStats);
      const lScore = serveScorer.score(loserStats);
      const diff   = lScore.score - wScore.score; // positive = loser outserved = overreaction

      if (sqf.minDifferential != null && diff < sqf.minDifferential)
        rej('SERVE_QUALITY', `Serve differential ${diff} (loser−winner) < min ${sqf.minDifferential} — underdog didn't outserve enough`);
      if (sqf.maxDifferential != null && diff > sqf.maxDifferential)
        rej('SERVE_QUALITY', `Serve differential ${diff} (loser−winner) > max ${sqf.maxDifferential} — gap too wide, signal noisy`);

      if (!_rejected) {
        logger.info('strategyEngine: serve quality check passed', {
          system: system.name, winnerScore: wScore.score, loserScore: lScore.score,
          differential: diff, verdict: serveScorer.verdict(diff),
        });
      }
    }

    // ── Momentum filters ─────────────────────────────────────────────────
    const mom = matchState.momentumIndex ?? null;
    if (f.momentumFavoursBetPlayer && mom != null) {
      const inFavour = betPlayerKey === 'A' ? mom > 0 : mom < 0;
      if (!inFavour) rej('MOMENTUM', `Momentum ${mom.toFixed(0)} not in favour of ${betPlayerKey}`);
    }
    if (f.minAbsMomentum != null && mom != null && Math.abs(mom) < f.minAbsMomentum)
      rej('MOMENTUM', `|Momentum| ${Math.abs(mom).toFixed(0)} < min ${f.minAbsMomentum}`);

    if (_rejected) continue;

    // ── All conditions met — build trigger result ─────────────────────────
    const setScore = `${targetSet.playerA}-${targetSet.playerB}`;
    const loserPre = loserPreMatch ? ` (fav @ ${loserPreMatch.toFixed(2)} pre-match)` : '';
    const reason   = `${system.name}: set ${trigger.setNumber} complete ${setScore}${loserPre}, ${entry.side.toLowerCase()} ${betOn} @ ${currentOdds}`;

    logger.info('strategyEngine: trigger conditions met', {
      system:        system.name,
      marketId:      matchState.betfairMarketId,
      matchName:     matchState.matchName,
      setScore,
      betOn,
      betPlayerKey,
      side:          entry.side,
      currentOdds,
      loserPreMatch,
    });

    results.push({
      system,
      playerKey: betPlayerKey,
      side:      entry.side,
      odds:      currentOdds,
      reason,
    });
  }

  return { triggers: results, rejections };
}

// ---------------------------------------------------------------------------
// Config validation — called by the dashboard PUT /api/config/strategies
// ---------------------------------------------------------------------------

/**
 * Validate a strategies.json config object.
 * Returns an array of human-readable error strings (empty = valid).
 */
function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') { errors.push('Config must be a JSON object'); return errors; }

  const systems = config.systems;
  if (!Array.isArray(systems)) { errors.push('"systems" must be an array'); return errors; }

  for (const [i, sys] of systems.entries()) {
    const prefix = `System ${i + 1} "${sys.name || '(unnamed)'}":`;

    if (!sys.name)        errors.push(`${prefix} missing "name"`);
    if (sys.enabled == null) errors.push(`${prefix} missing "enabled" flag`);
    if (!sys.description) errors.push(`${prefix} missing "description"`);

    const st = sys.staking;
    if (!st) errors.push(`${prefix} missing "staking" block`);
    else if (!st.stakeGBP || st.stakeGBP <= 0) errors.push(`${prefix} stakeGBP must be > 0`);

    const bt = sys.backtest;
    if (!bt)           { errors.push(`${prefix} missing "backtest" block`); continue; }
    if (!bt.trigger)   errors.push(`${prefix} missing "backtest.trigger"`);
    if (!bt.entry)     errors.push(`${prefix} missing "backtest.entry"`);

    if (bt.trigger) {
      const t = bt.trigger;
      if (!t.setNumber || t.setNumber < 1) errors.push(`${prefix} trigger.setNumber must be ≥ 1`);
      const checkRange = (key, label) => {
        if (!t[key]) return;
        const { min, max } = t[key];
        if (min == null || max == null) errors.push(`${prefix} trigger.${key} needs both min and max`);
        else if (min > max)             errors.push(`${prefix} trigger.${key}: min (${min}) > max (${max})`);
        else if (min <= 1 || max <= 1)  errors.push(`${prefix} trigger.${key}: odds must be > 1.0`);
      };
      checkRange('preMatchOddsLoser',  'loser pre-match odds');
      checkRange('preMatchOddsWinner', 'winner pre-match odds');
      checkRange('preMatchOddsA',      'player A pre-match odds');
      checkRange('preMatchOddsB',      'player B pre-match odds');
    }

    if (bt.entry) {
      const e = bt.entry;
      if (!['BACK','LAY'].includes(e.side)) errors.push(`${prefix} entry.side must be BACK or LAY`);
      if (!['loser','winner','momentum_high'].includes(e.player)) errors.push(`${prefix} entry.player must be "loser", "winner", or "momentum_high"`);
      if (e.minOdds != null && e.maxOdds != null && e.minOdds > e.maxOdds)
        errors.push(`${prefix} entry.minOdds (${e.minOdds}) > entry.maxOdds (${e.maxOdds})`);
    }

    if (sys.exit) {
      const x = sys.exit;
      if (x.type === 'set_result') {
        if (!x.setNumber || x.setNumber < 1) errors.push(`${prefix} exit.setNumber must be ≥ 1`);
      }
    }
  }

  return errors;
}

module.exports = { evaluateStrategies, isSetComplete, setWinner, isTiebreakSet, validateConfig };
