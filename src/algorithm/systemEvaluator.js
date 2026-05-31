'use strict';

/**
 * systemEvaluator.js
 *
 * Evaluates a MatchState against all configured systems from strategies.json.
 * Returns the list of systems whose filters are all satisfied by the match.
 *
 * Usage:
 *   const { evaluateSystems } = require('./systemEvaluator');
 *   const qualifying = evaluateSystems(matchState, strategies.systems || [], strategies);
 */

function _isSetComplete(set) {
  if (!set) return false;
  const a = set.playerA ?? 0, b = set.playerB ?? 0;
  const max = Math.max(a, b);
  if (max < 6) return false;
  if (max === 7) return true;
  return (max - Math.min(a, b)) >= 2;
}

/**
 * Return all enabled systems that this match qualifies for.
 *
 * @param {object} matchState   — MatchState instance (after recompute())
 * @param {object[]} systems    — systems array from strategies.json
 * @param {object} config       — full strategies config (unused for now, available for future)
 * @returns {{ systemName, cbbStrategyKey, staking, reason, description }[]}
 */
function evaluateSystems(matchState, systems, config) {
  if (!Array.isArray(systems)) return [];

  const results = [];

  for (const system of systems) {
    if (!system.enabled) continue;

    const check = passesFilters(matchState, system.filters || {});
    if (!check.passes) continue;

    // Pre-match odds gate: use only the captured pre-match snapshot (never fall back
    // to live odds) so the dashboard only tags matches that would actually trigger a bet.
    // Mirrors the exact logic in strategyEngine.evaluateStrategies().
    const trigger = system.backtest?.trigger;
    if (trigger) {
      const pmA = matchState.preMatchOddsA ?? null;
      const pmB = matchState.preMatchOddsB ?? null;

      // preMatchOddsWinner / preMatchOddsLoser → check the specific player when
      // loserMustBe/winnerMustBe is set; otherwise either player can satisfy the range.
      if (trigger.preMatchOddsWinner || trigger.preMatchOddsLoser) {
        const range = trigger.preMatchOddsWinner || trigger.preMatchOddsLoser;
        const { min = 0, max = Infinity } = range;
        const mustBe = trigger.loserMustBe || trigger.winnerMustBe || null; // 'A' or 'B'
        let passes = false;
        if (mustBe === 'A') {
          passes = pmA != null && pmA >= min && pmA <= max;
        } else if (mustBe === 'B') {
          passes = pmB != null && pmB >= min && pmB <= max;
        } else {
          passes = (pmA != null && pmA >= min && pmA <= max) ||
                   (pmB != null && pmB >= min && pmB <= max);
        }
        if (!passes) continue;
      }

      if (trigger.preMatchOddsA) {
        const { min = 0, max = Infinity } = trigger.preMatchOddsA;
        if (pmA == null || pmA < min || pmA > max) continue;
      }

      if (trigger.preMatchOddsB) {
        const { min = 0, max = Infinity } = trigger.preMatchOddsB;
        if (pmB == null || pmB < min || pmB > max) continue;
      }
    }

    // Set-trigger gate: the strategy's target set must be complete with a matching score.
    // Without this check the badge appears before the trigger condition is even possible,
    // leading to "tagged but no bet" confusion on the dashboard.
    if (trigger && trigger.setNumber) {
      const sets = matchState.sets || [];
      const completedSets = sets.filter(_isSetComplete);

      // Target set not finished yet — don't show badge
      if (completedSets.length < trigger.setNumber) continue;

      const targetSet = completedSets[trigger.setNumber - 1];
      if (!targetSet) continue;

      // Set score check — scores stored as "loserGames-winnerGames" (loser first)
      if (trigger.allowedSetScores?.length) {
        const winnerGames = Math.max(targetSet.playerA, targetSet.playerB);
        const loserGames  = Math.min(targetSet.playerA, targetSet.playerB);
        const scoreStr    = `${loserGames}-${winnerGames}`;
        if (!trigger.allowedSetScores.includes(scoreStr)) continue;
      }

      // loserMustBe check — who actually lost the target set
      if (trigger.loserMustBe) {
        const aLost = targetSet.playerA < targetSet.playerB;
        if (trigger.loserMustBe === 'A' && !aLost) continue;
        if (trigger.loserMustBe === 'B' &&  aLost) continue;
      }
    }

    // Entry odds gate: if the strategy requires entry odds in a specific range,
    // skip this system if neither player's current live odds are in that range.
    const entry = system.backtest?.entry;
    if (entry && (entry.minOdds != null || entry.maxOdds != null)) {
      const oddsA = matchState.playerABack;
      const oddsB = matchState.playerBBack;
      const minO = entry.minOdds ?? 1;
      const maxO = entry.maxOdds ?? Infinity;
      const aInRange = oddsA != null && oddsA >= minO && oddsA <= maxO;
      const bInRange = oddsB != null && oddsB >= minO && oddsB <= maxO;
      if (!aInRange && !bInRange) continue;
    }

    results.push({
      systemName:     system.name,
      cbbStrategyKey: system.cbbStrategyKey,
      staking:        system.staking,
      reason:         check.reason,
      description:    system.description,
    });
  }

  return results;
}

/**
 * Test whether a single MatchState passes all filters defined in a system.
 *
 * @param {object} matchState
 * @param {object} filters
 * @returns {{ passes: boolean, reason: string }}
 */
function passesFilters(matchState, filters) {
  // Surface check — skip entirely when surface is not yet known (comes from stats poller,
  // not the stream, so many markets won't have it set yet)
  if (filters.surfaces && filters.surfaces.length > 0 && matchState.surface != null) {
    if (!filters.surfaces.includes(matchState.surface)) {
      return { passes: false, reason: `Surface ${matchState.surface} not in [${filters.surfaces}]` };
    }
  }

  // Edge check
  const bestEdge = Math.max(matchState.edgeA || 0, matchState.edgeB || 0);
  if (filters.minEdgePercent && bestEdge < filters.minEdgePercent) {
    return { passes: false, reason: `Edge ${bestEdge.toFixed(1)}% below min ${filters.minEdgePercent}%` };
  }

  // Momentum check
  const absMomentum = Math.abs(matchState.momentumIndex || 0);
  if (filters.minMomentum && absMomentum < filters.minMomentum) {
    return { passes: false, reason: `Momentum ${absMomentum} below min ${filters.minMomentum}` };
  }

  // Volume check
  if (filters.minMatchedVolume && (matchState.matchedVolume || 0) < filters.minMatchedVolume) {
    return { passes: false, reason: `Volume ${matchState.matchedVolume || 0} below min ${filters.minMatchedVolume}` };
  }

  // Odds range check — when edge is available, use the better-edge player.
  // When edge is not yet computed (both 0), check if either player's odds are in range.
  const edgeA = matchState.edgeA || 0;
  const edgeB = matchState.edgeB || 0;
  const hasEdge = edgeA !== 0 || edgeB !== 0;

  let backOdds;
  if (hasEdge) {
    backOdds = edgeA >= edgeB ? matchState.playerABack : matchState.playerBBack;
  } else {
    // No edge computed yet — pick whichever player's odds fall in the filter range,
    // so a match isn't excluded just because stats haven't arrived yet
    const oddsA = matchState.playerABack;
    const oddsB = matchState.playerBBack;
    const minO  = filters.minOddsToBack || 1;
    const maxO  = filters.maxOddsToBack || Infinity;
    const aInRange = oddsA != null && oddsA >= minO && oddsA <= maxO;
    const bInRange = oddsB != null && oddsB >= minO && oddsB <= maxO;
    if (oddsA != null || oddsB != null) {
      // At least one player has odds — pass if either is in range
      if (!aInRange && !bInRange) {
        return { passes: false, reason: `Neither player's odds in range [${minO}–${maxO}]: A=${oddsA} B=${oddsB}` };
      }
      return {
        passes: true,
        reason: `Passed all ${Object.keys(filters).length} filters`,
      };
    }
    backOdds = null; // no odds at all yet — skip the check
  }

  if (backOdds != null) {
    if (filters.maxOddsToBack && backOdds > filters.maxOddsToBack) {
      return { passes: false, reason: `Odds ${backOdds} above max ${filters.maxOddsToBack}` };
    }
    if (filters.minOddsToBack && backOdds < filters.minOddsToBack) {
      return { passes: false, reason: `Odds ${backOdds} below min ${filters.minOddsToBack}` };
    }
  }

  // First serve win % check (grass/serving systems) — uses current server
  if (filters.minFirstServeWinPct || filters.maxFirstServeWinPct) {
    const server   = matchState.currentServer;
    const serveWin = matchState.liveServeStats?.[server]?.firstServeWon || 0;
    if (filters.minFirstServeWinPct && serveWin < filters.minFirstServeWinPct) {
      return { passes: false, reason: `1st serve win ${serveWin}% below min ${filters.minFirstServeWinPct}%` };
    }
    if (filters.maxFirstServeWinPct && serveWin > filters.maxFirstServeWinPct) {
      return { passes: false, reason: `1st serve win ${serveWin}% above max ${filters.maxFirstServeWinPct}%` };
    }
  }

  // Tournament tier check
  if (filters.allowedTournamentTiers && filters.allowedTournamentTiers.length > 0) {
    const tier = matchState.tournamentTier || 'unknown';
    if (!filters.allowedTournamentTiers.includes(tier)) {
      return { passes: false, reason: `Tournament tier '${tier}' not in allowed list` };
    }
  }

  // Blocked tournament name check
  if (filters.blockedTournaments && filters.blockedTournaments.length > 0) {
    const tournament = matchState.tournament || '';
    if (filters.blockedTournaments.some(b => tournament.toUpperCase().includes(b.toUpperCase()))) {
      return { passes: false, reason: `Tournament '${tournament}' is blocked` };
    }
  }

  // Games played in match (min/max)
  if (filters.minGamesPlayedInMatch || filters.maxGamesPlayedInMatch) {
    const games = typeof matchState.totalGamesPlayed === 'function'
      ? matchState.totalGamesPlayed()
      : (matchState.totalGamesPlayed || 0);
    if (filters.minGamesPlayedInMatch && games < filters.minGamesPlayedInMatch) {
      return { passes: false, reason: `Only ${games} games played, need ${filters.minGamesPlayedInMatch}` };
    }
    if (filters.maxGamesPlayedInMatch && games > filters.maxGamesPlayedInMatch) {
      return { passes: false, reason: `${games} games played, max is ${filters.maxGamesPlayedInMatch}` };
    }
  }

  // Break in current set — a break has occurred when games are uneven
  if (filters.requireBreakInCurrentSet) {
    const currentSet = matchState.sets[matchState.sets.length - 1];
    const hasBreak = currentSet
      ? (currentSet.playerA || 0) !== (currentSet.playerB || 0)
      : false;
    if (!hasBreak) {
      return { passes: false, reason: 'No break in current set' };
    }
  }

  // Server momentum alignment
  if (filters.requireServerMomentum) {
    const server   = matchState.currentServer;
    const momentum = matchState.momentumIndex || 0;
    const serverHasMomentum = (server === 'playerA' && momentum > 0) ||
                              (server === 'playerB' && momentum < 0);
    if (!serverHasMomentum) {
      return { passes: false, reason: 'Server momentum not aligned with betting direction' };
    }
  }

  // (Removed: onlyBackFavourite / onlyBackUnderdog filters. In tennis the in-play
  // price swings too much for "favourite" to mean anything reliable, so we no
  // longer gate bets on favourite/underdog by odds.)

  // --- Advanced metrics (backed-player relative) ---
  const backedPlayerKey = (matchState.edgeA || 0) >= (matchState.edgeB || 0) ? 'playerA' : 'playerB';
  const backedServe     = matchState.liveServeStats?.[backedPlayerKey] || {};
  const backedBp        = matchState.breakPoints?.[backedPlayerKey]    || {};
  const backedTrueProb  = backedPlayerKey === 'playerA' ? matchState.trueProbabilityA : matchState.trueProbabilityB;
  const backedProbPct   = backedTrueProb != null ? backedTrueProb * 100 : null;

  // True probability range of backed player
  if (filters.minTrueProbabilityBacked != null && backedProbPct != null) {
    if (backedProbPct < filters.minTrueProbabilityBacked) {
      return { passes: false, reason: `True prob ${backedProbPct.toFixed(1)}% below min ${filters.minTrueProbabilityBacked}%` };
    }
  }
  if (filters.maxTrueProbabilityBacked != null && backedProbPct != null) {
    if (backedProbPct > filters.maxTrueProbabilityBacked) {
      return { passes: false, reason: `True prob ${backedProbPct.toFixed(1)}% above max ${filters.maxTrueProbabilityBacked}%` };
    }
  }

  // 1st serve in % for backed player (min/max)
  if (filters.minFirstServeInPct != null) {
    const v = backedServe.firstServeIn || 0;
    if (v < filters.minFirstServeInPct) {
      return { passes: false, reason: `1st Serve In ${v.toFixed(0)}% below min ${filters.minFirstServeInPct}%` };
    }
  }
  if (filters.maxFirstServeInPct != null) {
    const v = backedServe.firstServeIn || 0;
    if (v > filters.maxFirstServeInPct) {
      return { passes: false, reason: `1st Serve In ${v.toFixed(0)}% above max ${filters.maxFirstServeInPct}%` };
    }
  }

  // 2nd serve won % for backed player (min/max)
  if (filters.minSecondServeWonPct != null) {
    const v = backedServe.secondServeWon || 0;
    if (v < filters.minSecondServeWonPct) {
      return { passes: false, reason: `2nd Serve Won ${v.toFixed(0)}% below min ${filters.minSecondServeWonPct}%` };
    }
  }
  if (filters.maxSecondServeWonPct != null) {
    const v = backedServe.secondServeWon || 0;
    if (v > filters.maxSecondServeWonPct) {
      return { passes: false, reason: `2nd Serve Won ${v.toFixed(0)}% above max ${filters.maxSecondServeWonPct}%` };
    }
  }

  // Double faults for backed player (min/max)
  if (filters.minDoubleFaults != null) {
    const v = backedServe.doubleFaults || 0;
    if (v < filters.minDoubleFaults) {
      return { passes: false, reason: `Double faults ${v} below min ${filters.minDoubleFaults}` };
    }
  }
  if (filters.maxDoubleFaults != null) {
    const v = backedServe.doubleFaults || 0;
    if (v > filters.maxDoubleFaults) {
      return { passes: false, reason: `Double faults ${v} above max ${filters.maxDoubleFaults}` };
    }
  }

  // Break point conversion % for backed player (min/max)
  if (filters.minBreakPointConvPct != null || filters.maxBreakPointConvPct != null) {
    const created = backedBp.created   || 0;
    const conv    = backedBp.converted || 0;
    const convPct = created > 0 ? (conv / created * 100) : 0;
    if (filters.minBreakPointConvPct != null && convPct < filters.minBreakPointConvPct) {
      return { passes: false, reason: `BP conv ${convPct.toFixed(0)}% below min ${filters.minBreakPointConvPct}%` };
    }
    if (filters.maxBreakPointConvPct != null && convPct > filters.maxBreakPointConvPct) {
      return { passes: false, reason: `BP conv ${convPct.toFixed(0)}% above max ${filters.maxBreakPointConvPct}%` };
    }
  }

  // ── Per-player serve stat filters (mirrors strategyEngine, checked against set 1) ──
  // These are saved by the strategy editor modal (p1MinFirstServeIn etc.) and must be
  // evaluated here so the qualifying display on the live tab matches what the bet engine
  // will actually enforce at trigger time.
  const s1 = matchState.liveServeStatsSet1 || matchState.liveServeStats || {};
  const b1 = matchState.breakPointsSet1    || matchState.breakPoints    || {};
  const p1  = s1.playerA || {};
  const p2  = s1.playerB || {};
  const bp1 = b1.playerA || {};
  const bp2 = b1.playerB || {};

  const chk = (val, min, max, label) => {
    if (min != null && (val == null || val < min)) return { passes: false, reason: `${label} ${val ?? 'null'} below min ${min}` };
    if (max != null && (val == null || val > max)) return { passes: false, reason: `${label} ${val ?? 'null'} above max ${max}` };
    return null;
  };

  const serveChecks = [
    chk(p1.firstServeIn,   filters.p1MinFirstServeIn,   filters.p1MaxFirstServeIn,   'P1 1stIn%'),
    chk(p1.firstServeWon,  filters.p1MinFirstServeWon,  filters.p1MaxFirstServeWon,  'P1 1stWon%'),
    chk(p1.secondServeWon, filters.p1MinSecondServeWon, filters.p1MaxSecondServeWon, 'P1 2ndWon%'),
    chk(p1.aces,           filters.p1MinAces,           filters.p1MaxAces,           'P1 Aces'),
    chk(p1.doubleFaults,   filters.p1MinDoubleFaults,   filters.p1MaxDoubleFaults,   'P1 DFs'),
    chk(bp1.converted,     filters.p1MinBreakpointsWon, filters.p1MaxBreakpointsWon, 'P1 BPsWon'),
    chk(p2.firstServeIn,   filters.p2MinFirstServeIn,   filters.p2MaxFirstServeIn,   'P2 1stIn%'),
    chk(p2.firstServeWon,  filters.p2MinFirstServeWon,  filters.p2MaxFirstServeWon,  'P2 1stWon%'),
    chk(p2.secondServeWon, filters.p2MinSecondServeWon, filters.p2MaxSecondServeWon, 'P2 2ndWon%'),
    chk(p2.aces,           filters.p2MinAces,           filters.p2MaxAces,           'P2 Aces'),
    chk(p2.doubleFaults,   filters.p2MinDoubleFaults,   filters.p2MaxDoubleFaults,   'P2 DFs'),
    chk(bp2.converted,     filters.p2MinBreakpointsWon, filters.p2MaxBreakpointsWon, 'P2 BPsWon'),
  ];
  for (const result of serveChecks) {
    if (result) return result;
  }

  return {
    passes: true,
    reason: `Passed all ${Object.keys(filters).length} filters`,
  };
}

module.exports = { evaluateSystems, passesFilters };
