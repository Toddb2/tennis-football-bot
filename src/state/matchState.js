'use strict';

const logger = require('../utils/logger');
const { recordGameResult } = require('../algorithm/momentumDetector');

/**
 * Sanitise an incoming odds value. Valid decimal odds are finite and in
 * (1, 1000]; Betfair never trades at ≤ 1.0. Anything else (null, 0, NaN, a
 * negative, or an absurd value) returns null so the caller keeps the last good
 * price instead of storing garbage (e.g. a 0 that would make 1/odds = ∞).
 */
function validOdds(v) {
  return (typeof v === 'number' && isFinite(v) && v > 1 && v <= 1000) ? v : null;
}

/**
 * One instance per live match.
 * Holds the unified view of everything the algorithm needs.
 */
class MatchState {
  constructor(betfairMarketId, matchName) {
    this.betfairMarketId = betfairMarketId;
    this.matchName = matchName;

    // Score
    this.sets = [];                            // [{ playerA: 6, playerB: 4 }, ...]
    this.currentGame = { playerA: 0, playerB: 0 };
    this.currentServer = null;                 // "playerA" | "playerB"
    this.surface = null;                       // "clay" | "hard" | "grass" | "carpet"
    this.tournament = null;                    // e.g. "Miami", "Roland Garros"
    this.betfairEventName = null;              // e.g. "ATP Rome 2026" (from Betfair catalogue)

    // Live odds
    this.playerABack = null;
    this.playerALay = null;
    this.playerBBack = null;
    this.playerBLay = null;
    this.matchedVolume = 0;

    // Serve stats (live, updated as match progresses)
    this.liveServeStats = {
      playerA: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
      playerB: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
    };

    // Per-set serve stats (Set 1 is primary focus; Set 2 stored separately for later use)
    this.liveServeStatsSet1 = {
      playerA: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
      playerB: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
    };
    this.liveServeStatsSet2 = {
      playerA: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
      playerB: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
    };
    this.liveServeStatsSet3 = {
      playerA: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
      playerB: { firstServeIn: null, firstServeWon: null, secondServeWon: null, aces: null, doubleFaults: null },
    };

    // Pre-match baseline (from historicalLoader)
    this.historicalStats = {};

    // Rolling buffer of the last 50 stat updates — used by momentumDetector
    this.statsBuffer = [];

    // Break point and game streak tracking for momentum
    this.breakPoints = {
      playerA: { created: 0, converted: 0 },
      playerB: { created: 0, converted: 0 },
    };
    this.breakPointsSet1 = {
      playerA: { created: 0, converted: 0 },
      playerB: { created: 0, converted: 0 },
    };
    this.breakPointsSet2 = {
      playerA: { created: 0, converted: 0 },
      playerB: { created: 0, converted: 0 },
    };
    this.breakPointsSet3 = {
      playerA: { created: 0, converted: 0 },
      playerB: { created: 0, converted: 0 },
    };
    this.gameStreak = { player: null, count: 0 };   // who is on a streak and how long
    this.breakStreak = { player: null, count: 0 };  // consecutive breaks

    // Momentum index — computed by momentumDetector
    // Range: -100 (playerB dominating) to +100 (playerA dominating)
    this.momentumIndex = 0;

    // True probability — computed by probabilityModel
    this.trueProbabilityA = null;
    this.trueProbabilityB = null;

    // Edge — difference between true probability and market implied probability (as %)
    this.edgeA = null;
    this.edgeB = null;

    // Pre-match odds and volume — captured on first in-play transition, used by strategy triggers
    this.preMatchOddsA  = null;
    this.preMatchOddsB  = null;
    this.preMatchVolume = 0;

    // State tracking
    this.lastUpdated = null;
    this.startTime   = null;   // ms timestamp — when match first went in-play
    this.endTime     = null;   // ms timestamp — when match closed
    this.isInPlay = false;
    this.status = 'INACTIVE'; // INACTIVE | LIVE | SUSPENDED | CLOSED

    // External stats source ID (used for linkage in StateStore)
    this.externalMatchId = null;

    // api-tennis.com player keys (first_player_key / second_player_key)
    this.playerAKey = null;
    this.playerBKey = null;

    // Rankings from get_standings (ATP/WTA)
    this.playerARank    = null;
    this.playerBRank    = null;
    this.playerACountry = null;
    this.playerBCountry = null;

    // Surface win/loss stats from get_players (most recent singles season)
    // Shape: { season, rank, titles, surface: { hard, clay, grass }, overall: { won, lost } }
    this.playerASurfaceStats = null;
    this.playerBSurfaceStats = null;

    // Head-to-head from get_H2H
    // Shape: { total, p1Wins, p2Wins, p1RecentForm[], p2RecentForm[], lastH2H[] }
    this.h2hStats = null;

    // Pre-match bookmaker odds from get_odds
    // Shape: { matchWinner, set1Winner, setBetting, straightSets }
    this.bookmakerOdds = null;

    // In-play bookmaker odds from get_live_odds (raw array, updated every 30s)
    this.liveBookmakerOdds = [];

    // Tournament round: "F" | "SF" | "QF" | "R16" | "R32" etc.
    this.tournamentRound = null;
  }

  /**
   * Merge an odds update received from betfairStream.
   * @param {object} oddsData — shape matches betfairStream output
   */
  applyOddsUpdate(oddsData) {
    const { runners, inPlay, status, matchedVolume, eventName, timestamp } = oddsData;
    if (eventName) this.betfairEventName = eventName;

    const wasInPlay = this.isInPlay;

    if (typeof inPlay === 'boolean') {
      if (inPlay && !this.isInPlay) this.startTime = timestamp || Date.now(); // first moment in-play
      this.isInPlay = inPlay;
    }
    if (status) {
      if (status === 'CLOSED' && !this.endTime) this.endTime = timestamp || Date.now();
      this.status = status;
    }
    if (typeof matchedVolume === 'number') this.matchedVolume = matchedVolume;

    if (Array.isArray(runners) && runners.length >= 2) {
      const [a, b] = runners;
      if (a) {
        const ab = validOdds(a.backPrice), al = validOdds(a.layPrice);
        if (ab != null) this.playerABack = ab;   // ignore null/0/≤1/NaN — keep last good price
        if (al != null) this.playerALay  = al;
      }
      if (b) {
        const bb = validOdds(b.backPrice), bl = validOdds(b.layPrice);
        if (bb != null) this.playerBBack = bb;
        if (bl != null) this.playerBLay  = bl;
      }
      // Flag a crossed book (back > lay) — should not happen on a healthy market;
      // usually a transient during a fast move or a bad tick. We keep the values
      // (they may be momentarily valid) but log so persistent crossing is visible.
      if (this.playerABack != null && this.playerALay != null && this.playerABack > this.playerALay + 1e-9) {
        logger.debug('matchState: crossed book playerA (back > lay)', {
          marketId: this.betfairMarketId, back: this.playerABack, lay: this.playerALay });
      }
      if (this.playerBBack != null && this.playerBLay != null && this.playerBBack > this.playerBLay + 1e-9) {
        logger.debug('matchState: crossed book playerB (back > lay)', {
          marketId: this.betfairMarketId, back: this.playerBBack, lay: this.playerBLay });
      }
      // Use the sum of runner volumes if total isn't provided directly
      if (!matchedVolume) {
        this.matchedVolume = runners.reduce((sum, r) => sum + (r.matchedVolume || 0), 0);
      }
    }

    // Capture pre-match odds and volume once we're in-play and prices have arrived.
    // We don't gate on !wasInPlay so that a retry fires if the first update had null prices.
    // Only capture pre-match odds if prices look genuine pre-match.
    // If both runners are < 1.5 the market is already deep in-play (e.g. 5-0 in set 3).
    const oddsLookPreMatch = this.playerABack != null && this.playerBBack != null
      ? !(this.playerABack < 1.5 && this.playerBBack < 1.5)
        && (1 / this.playerABack + 1 / this.playerBBack) <= 1.20   // plausible pre-match overround
      : (this.playerABack != null && this.playerABack >= 1.1);
    // Prefer ppPrices (Betfair pre-play) from CBB stream — accurate regardless of
    // when the bot first saw the market. But sanity-check them: a real pre-match
    // book can't have both players short (e.g. both < 1.2 → overround ~1.67).
    // When both prices are present their overround must be plausible (≤ 1.20);
    // otherwise the "pre-play" value is actually an in-play price and we reject it.
    const ppA = validOdds(oddsData.prePlayOddsA);
    const ppB = validOdds(oddsData.prePlayOddsB);
    const ppOverroundOk = ppB == null || (1 / ppA + 1 / ppB) <= 1.20;
    if (ppA != null && ppA > 1.05 && ppOverroundOk && !this.preMatchOddsA) {
      this.preMatchOddsA  = ppA;
      this.preMatchOddsB  = ppB;
      this.preMatchVolume = this.matchedVolume ?? 0;
      try {
        require('../database/marketRepo').updatePreMatchOdds(this.betfairMarketId, {
          preMatchOddsA:  this.preMatchOddsA,
          preMatchOddsB:  this.preMatchOddsB,
          preMatchVolume: this.preMatchVolume,
        });
      } catch (_) {}
    } else if (inPlay && !this.preMatchOddsA && this.playerABack && oddsLookPreMatch) {
      this.preMatchOddsA  = this.playerABack;
      this.preMatchOddsB  = this.playerBBack   ?? null;
      this.preMatchVolume = this.matchedVolume ?? 0;
      logger.debug('matchState: pre-match odds/volume captured', {
        marketId:       this.betfairMarketId,
        preMatchOddsA:  this.preMatchOddsA,
        preMatchOddsB:  this.preMatchOddsB,
        preMatchVolume: this.preMatchVolume,
      });
      // Persist to DB (non-fatal — required for strategy back-fill on restart)
      try {
        require('../database/marketRepo').updatePreMatchOdds(this.betfairMarketId, {
          preMatchOddsA:  this.preMatchOddsA,
          preMatchOddsB:  this.preMatchOddsB,
          preMatchVolume: this.preMatchVolume,
        });
      } catch (_) {}
    }

    this.lastUpdated = timestamp || Date.now();
    logger.debug('applyOddsUpdate', { marketId: this.betfairMarketId, status: this.status });
  }

  /**
   * Merge a stats update received from statsPoller.
   * @param {object} statsData — shape matches statsPoller output
   */
  applyStatsUpdate(statsData) {
    const {
      sets, currentGame, currentServer, surface, tournamentName, tournamentRound,
      serveStats, serveStatsSet1, serveStatsSet2, serveStatsSet3,
      breakPoints, breakPointsSet1, breakPointsSet2, breakPointsSet3,
      externalMatchId, timestamp,
      playerAKey, playerBKey,
      playerARank, playerBRank,
      playerACountry, playerBCountry,
      playerASurfaceStats, playerBSurfaceStats,
      h2hStats, bookmakerOdds, liveBookmakerOdds,
    } = statsData;

    if (Array.isArray(sets)) {
      // Detect game completions so streak-based momentum stays accurate.
      // Compare new sets to previous; if a game was just added, record the result.
      const prevServer = this.currentServer;  // server before this update
      const prevSets   = this.sets;
      if (prevSets.length > 0 && sets.length > 0) {
        const si       = Math.min(prevSets.length, sets.length) - 1;
        const prevG    = (prevSets[si]?.playerA || 0) + (prevSets[si]?.playerB || 0);
        const newG     = (sets[si]?.playerA     || 0) + (sets[si]?.playerB     || 0);
        if (newG > prevG) {
          const wonA   = (sets[si]?.playerA || 0) > (prevSets[si]?.playerA || 0);
          const winner = wonA ? 'playerA' : 'playerB';
          // Break = server lost the game (use server from BEFORE this update)
          const wasBreak = prevServer != null && prevServer !== winner;
          try { recordGameResult(this, winner, wasBreak); } catch (_) {}
        }
      }
      this.sets = sets;
    }
    if (currentGame)                 this.currentGame = currentGame;
    if (currentServer)               this.currentServer = currentServer;
    if (surface)                     this.surface = surface;
    if (tournamentName)              this.tournament = tournamentName;
    if (tournamentRound)             this.tournamentRound = tournamentRound;
    if (externalMatchId)             this.externalMatchId = externalMatchId;
    if (playerAKey)                  this.playerAKey = playerAKey;
    if (playerBKey)                  this.playerBKey = playerBKey;
    if (playerARank   != null)       this.playerARank = playerARank;
    if (playerBRank   != null)       this.playerBRank = playerBRank;
    if (playerACountry)              this.playerACountry = playerACountry;
    if (playerBCountry)              this.playerBCountry = playerBCountry;
    if (playerASurfaceStats)         this.playerASurfaceStats = playerASurfaceStats;
    if (playerBSurfaceStats)         this.playerBSurfaceStats = playerBSurfaceStats;
    if (h2hStats)                    this.h2hStats = h2hStats;
    if (bookmakerOdds)               this.bookmakerOdds = bookmakerOdds;
    if (Array.isArray(liveBookmakerOdds) && liveBookmakerOdds.length) this.liveBookmakerOdds = liveBookmakerOdds;

    // Deep merge helper — only overwrites non-null values so partial updates
    // never wipe out previously good data
    const mergeServe = (target, src) => {
      if (!src) return;
      for (const player of ['playerA', 'playerB']) {
        if (!src[player]) continue;
        if (!target[player]) target[player] = {};
        for (const [k, v] of Object.entries(src[player])) {
          if (v !== null) target[player][k] = v;
        }
      }
    };

    const mergeBp = (target, src) => {
      if (!src) return;
      for (const player of ['playerA', 'playerB']) {
        if (!src[player]) continue;
        for (const [k, v] of Object.entries(src[player])) {
          if (v !== null && v !== undefined) target[player][k] = v;
        }
      }
    };

    mergeServe(this.liveServeStats,     serveStats);
    mergeServe(this.liveServeStatsSet1, serveStatsSet1);
    mergeServe(this.liveServeStatsSet2, serveStatsSet2);
    mergeServe(this.liveServeStatsSet3, serveStatsSet3);
    mergeBp(this.breakPoints,     breakPoints);
    mergeBp(this.breakPointsSet1, breakPointsSet1);
    mergeBp(this.breakPointsSet2, breakPointsSet2);
    mergeBp(this.breakPointsSet3, breakPointsSet3);

    // Push into rolling buffer (max 50 entries)
    this.statsBuffer.push({ ...statsData, capturedAt: timestamp || Date.now() });
    if (this.statsBuffer.length > 50) this.statsBuffer.shift();

    this.lastUpdated = timestamp || Date.now();
    logger.debug('applyStatsUpdate', { marketId: this.betfairMarketId, sets: this.sets });
  }

  /**
   * Recompute derived fields: edge.
   * momentumIndex and trueProbability are written directly by algorithm modules.
   */
  recompute() {
    // Edge = trueProbability - implied probability from market odds
    // Implied probability = 1 / back price (using back price as the market's estimate)
    if (this.trueProbabilityA !== null && this.playerABack && this.playerABack > 1) {
      const impliedA = 1 / this.playerABack;
      this.edgeA = parseFloat(((this.trueProbabilityA - impliedA) * 100).toFixed(2));
    } else {
      this.edgeA = null;
    }

    if (this.trueProbabilityB !== null && this.playerBBack && this.playerBBack > 1) {
      const impliedB = 1 / this.playerBBack;
      this.edgeB = parseFloat(((this.trueProbabilityB - impliedB) * 100).toFixed(2));
    } else {
      this.edgeB = null;
    }

    logger.debug('recompute', {
      marketId: this.betfairMarketId,
      edgeA: this.edgeA,
      edgeB: this.edgeB,
      momentumIndex: this.momentumIndex,
    });
  }

  /**
   * Count total games played across all completed sets plus the current set.
   * Used by probabilityModel to decide live vs historical stat blending.
   */
  totalGamesPlayed() {
    const completedSetGames = this.sets.reduce(
      (sum, s) => sum + (s.playerA || 0) + (s.playerB || 0),
      0
    );
    const currentSetGames =
      (this.currentGame ? (this.currentGame.playerA || 0) + (this.currentGame.playerB || 0) : 0);
    // currentGame holds the point score (0/15/30/40), not the game count within the set.
    // The set game count is carried in this.sets' last (in-progress) entry if included.
    // Return completed set games as a proxy — callers should use sets directly for precision.
    return completedSetGames + currentSetGames;
  }

  /**
   * Return a plain-object snapshot suitable for logging / JSON serialisation.
   */
  toSnapshot() {
    return {
      betfairMarketId:  this.betfairMarketId,
      matchName:        this.matchName,
      surface:          this.surface,
      tournament:       this.tournament,
      betfairEventName: this.betfairEventName,
      runnerIdA:        this.runnerIdA,
      runnerIdB:        this.runnerIdB,
      winnerSelectionId: this.winnerSelectionId,   // Betfair's settled winner (selectionId), if received
      sets:            this.sets,
      currentGame:     this.currentGame,
      currentServer:   this.currentServer,
      isInPlay:        this.isInPlay,
      status:          this.status,
      odds: {
        playerABack: this.playerABack,
        playerALay:  this.playerALay,
        playerBBack: this.playerBBack,
        playerBLay:  this.playerBLay,
        matchedVolume: this.matchedVolume,
      },
      preMatchOddsA:    this.preMatchOddsA,
      preMatchOddsB:    this.preMatchOddsB,
      preMatchVolume:   this.preMatchVolume,
      externalMatchId:     this.externalMatchId,
      playerAKey:          this.playerAKey,
      playerBKey:          this.playerBKey,
      playerARank:         this.playerARank,
      playerBRank:         this.playerBRank,
      playerACountry:      this.playerACountry,
      playerBCountry:      this.playerBCountry,
      playerASurfaceStats: this.playerASurfaceStats,
      playerBSurfaceStats: this.playerBSurfaceStats,
      h2hStats:            this.h2hStats,
      bookmakerOdds:       this.bookmakerOdds,
      liveBookmakerOdds:   this.liveBookmakerOdds,
      tournamentRound:     this.tournamentRound,
      liveServeStats:      this.liveServeStats,
      liveServeStatsSet1:  this.liveServeStatsSet1,
      liveServeStatsSet2:  this.liveServeStatsSet2,
      liveServeStatsSet3:  this.liveServeStatsSet3,
      breakPoints:         this.breakPoints,
      breakPointsSet1:     this.breakPointsSet1,
      breakPointsSet2:     this.breakPointsSet2,
      breakPointsSet3:     this.breakPointsSet3,
      momentumIndex:    this.momentumIndex,
      trueProbabilityA: this.trueProbabilityA,
      trueProbabilityB: this.trueProbabilityB,
      edgeA:            this.edgeA,
      edgeB:            this.edgeB,
      lastUpdated:      this.lastUpdated,
      startTime:        this.startTime,
      endTime:          this.endTime,
    };
  }
}

module.exports = MatchState;
