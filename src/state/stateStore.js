'use strict';

const MatchState   = require('./matchState');
const logger       = require('../utils/logger');
const { playerNamesMatch } = require('../utils/helpers');
const marketRepo   = require('../database/marketRepo');
const snapshotRepo = require('../database/snapshotRepo');

/**
 * In-memory store of all active MatchState instances, keyed by Betfair marketId.
 * Also maintains a reverse mapping from external stats IDs → marketId.
 */
class StateStore {
  constructor() {
    /** @type {Map<string, MatchState>} */
    this.matches = new Map();

    /** Archive of closed matches (kept for post-session logging) */
    this.closedMatches = [];

    /** External stats ID → Betfair marketId */
    this._externalToMarket = new Map();
  }

  /**
   * Create a new MatchState if one doesn't exist for marketId, then apply the update.
   * @param {string} marketId
   * @param {object} update  — either an odds update or a stats update (or partial construction data)
   * @param {'odds'|'stats'|'init'} type
   * @returns {MatchState}
   */
  upsert(marketId, update, type = 'init') {
    if (!this.matches.has(marketId)) {
      const matchName = update.matchName || marketId;
      const state = new MatchState(marketId, matchName);
      this.matches.set(marketId, state);
      logger.info('StateStore: new match added', { marketId, matchName });

      // Persist to DB (non-fatal)
      try {
        const [pA, pB] = matchName.split(' v ').map(s => s.trim());
        marketRepo.upsert({
          betfairMarketId: marketId,
          matchName,
          playerAName:     pA || null,
          playerBName:     pB || null,
          runnerIdA:       update.runnerIdA   || null,
          runnerIdB:       update.runnerIdB   || null,
          statsLinked:     false,
        });
      } catch (e) {
        logger.error('StateStore: marketRepo.upsert (new) failed', { message: e.message });
      }

      // Restore pre-match odds and serve stats from DB so strategies work after a restart
      try {
        const dbMarket = marketRepo.getById(marketId);
        if (dbMarket?.pre_match_odds_a) {
          state.preMatchOddsA = dbMarket.pre_match_odds_a;
          state.preMatchOddsB = dbMarket.pre_match_odds_b ?? null;
          logger.info('StateStore: pre-match odds restored from DB', {
            marketId,
            preMatchOddsA: state.preMatchOddsA,
            preMatchOddsB: state.preMatchOddsB,
          });
        }
        // Restore the api-tennis link so we don't lose scoring on every restart:
        // without this, statsPoller has to re-fuzzy-match each market from
        // incoming WebSocket events, and matches in a between-set lull stay
        // dark for minutes (or until the next point is played).
        if (dbMarket?.external_match_id && dbMarket?.stats_linked) {
          state.externalMatchId = dbMarket.external_match_id;
          this._externalToMarket.set(dbMarket.external_match_id, marketId);
          logger.info('StateStore: api-tennis link restored from DB', {
            marketId, externalId: dbMarket.external_match_id,
          });
        }
      } catch (e) {
        logger.error('StateStore: could not restore pre-match odds from DB', { message: e.message });
      }

      // Restore last-known serve stats so the dashboard and serve filters work after restart
      try {
        const snap = snapshotRepo.getLatestForMarket(marketId);
        if (snap?.serve_stats) {
          const ss = JSON.parse(snap.serve_stats);
          const merge = (target, src) => {
            if (!src) return;
            if (src.playerA) Object.assign(target.playerA, src.playerA);
            if (src.playerB) Object.assign(target.playerB, src.playerB);
          };
          merge(state.liveServeStats,     ss.match);
          merge(state.liveServeStatsSet1, ss.set1);
          merge(state.liveServeStatsSet2, ss.set2);
          merge(state.liveServeStatsSet3, ss.set3);
          logger.info('StateStore: serve stats restored from DB', {
            marketId,
            set1A: state.liveServeStatsSet1?.playerA?.firstServeIn,
            set1B: state.liveServeStatsSet1?.playerB?.firstServeIn,
          });
        }
      } catch (e) {
        logger.error('StateStore: could not restore serve stats from DB', { message: e.message });
      }
    }

    const state = this.matches.get(marketId);

    switch (type) {
      case 'odds':
        state.applyOddsUpdate(update);
        if (state.status === 'CLOSED') {
          this.close(marketId);
          return state;
        }
        state.recompute();
        // Keep DB surface/tournament up to date as we get enrichment from stats
        if (update.surface || update.tournament || state.tournamentRound) {
          try {
            marketRepo.upsert({
              betfairMarketId: marketId,
              matchName:       state.matchName,
              surface:         update.surface    || state.surface         || null,
              tournament:      update.tournament || state.tournament      || null,
              tournamentRound: state.tournamentRound                       || null,
            });
          } catch (e) { /* non-fatal */ }
        }
        break;
      case 'stats':
        state.applyStatsUpdate(update);
        state.recompute();
        // Write surface/tournament/round to DB the first time stats arrive with them
        if (update.surface || update.tournamentName || update.tournamentRound) {
          try {
            marketRepo.upsert({
              betfairMarketId: marketId,
              matchName:       state.matchName,
              surface:         update.surface          || state.surface         || null,
              tournament:      update.tournamentName   || state.tournament      || null,
              tournamentRound: update.tournamentRound  || state.tournamentRound || null,
            });
          } catch (e) { /* non-fatal */ }
        }
        break;
      case 'init':
        // Merge top-level fields directly (e.g., setting historicalStats)
        Object.assign(state, update);
        break;
      default:
        logger.warn('StateStore.upsert: unknown update type', { type });
    }

    return state;
  }

  /**
   * Retrieve a MatchState by Betfair marketId.
   * @param {string} marketId
   * @returns {MatchState|undefined}
   */
  get(marketId) {
    return this.matches.get(marketId);
  }

  /**
   * Retrieve a MatchState by external stats ID (e.g. Sofascore match ID).
   * @param {string} externalId
   * @returns {MatchState|undefined}
   */
  getByExternalId(externalId) {
    const marketId = this._externalToMarket.get(externalId);
    return marketId ? this.matches.get(marketId) : undefined;
  }

  /**
   * Return all active MatchState instances as an array.
   * @returns {MatchState[]}
   */
  getAll() {
    return Array.from(this.matches.values());
  }

  /**
   * Return all active market IDs.
   * @returns {string[]}
   */
  getAllMarketIds() {
    return Array.from(this.matches.keys());
  }

  /**
   * Move a match to the closed archive and remove it from the active map.
   * @param {string} marketId
   */
  close(marketId) {
    const state = this.matches.get(marketId);
    if (!state) {
      logger.warn('StateStore.close: marketId not found', { marketId });
      return;
    }

    state.status = 'CLOSED';
    state.isInPlay = false;
    if (!state.endTime) state.endTime = Date.now();
    const snapshot = state.toSnapshot ? state.toSnapshot() : state;
    this.closedMatches.push(snapshot);
    this.matches.delete(marketId);

    // Clean up reverse mapping
    if (state.externalMatchId) {
      this._externalToMarket.delete(state.externalMatchId);
    }

    // Persist close to DB (non-fatal)
    try {
      const sets = snapshot.sets?.filter(s => s && (s.playerA != null || s.playerB != null)) || [];
      // Determine winner from final odds or set scores
      let winner = null;
      const oddsA = snapshot.playerABack, oddsB = snapshot.playerBBack;
      if (oddsA != null && oddsB != null && oddsA > 1 && oddsB > 1) {
        winner = oddsA < oddsB ? 'A' : 'B';
      } else if (sets.length >= 2) {
        const sA = sets.filter(s => (s.playerA ?? 0) > (s.playerB ?? 0)).length;
        const sB = sets.filter(s => (s.playerB ?? 0) > (s.playerA ?? 0)).length;
        if (sA > sB) winner = 'A';
        else if (sB > sA) winner = 'B';
      }
      marketRepo.close(marketId, {
        endedAt:   new Date().toISOString(),
        finalSets: sets.map(s => [s.playerA ?? 0, s.playerB ?? 0]),
        winner,
      });
    } catch (e) {
      logger.error('StateStore: marketRepo.close failed', { message: e.message });
    }

    logger.info('StateStore: match closed', { marketId, matchName: state.matchName });
  }

  /**
   * Register the mapping from an external stats source ID to a Betfair marketId.
   * Called by statsPoller once a fuzzy name match succeeds.
   * @param {string} externalId
   * @param {string} marketId
   */
  linkStatsToMarket(externalId, marketId) {
    this._externalToMarket.set(externalId, marketId);

    // Also stamp the externalMatchId onto the MatchState itself for convenience
    const state = this.matches.get(marketId);
    if (state) {
      state.externalMatchId = externalId;
    }

    // Persist link to DB (non-fatal)
    try {
      marketRepo.setLinked(marketId, externalId);
    } catch (e) {
      logger.error('StateStore: marketRepo.setLinked failed', { message: e.message });
    }

    logger.info('StateStore: external ID linked', { externalId, marketId });
  }

  /**
   * Find the MatchState whose Betfair name best matches an external match name.
   * Splits both names on " v " and compares each player using playerNamesMatch,
   * which handles "Stefanos Tsitsipas" vs "Tsitsipas S" automatically.
   *
   * @param {string} externalMatchName  — e.g. "Stefanos Tsitsipas v Arthur Fery"
   * @returns {MatchState|null}
   */
  findMarketForExternalMatch(externalMatchName) {
    const [extA, extB] = externalMatchName.split(' v ').map(s => s.trim());
    if (!extA || !extB) return null;

    for (const ms of this.matches.values()) {
      const [mktA, mktB] = ms.matchName.split(' v ').map(s => s.trim());
      if (!mktA || !mktB) continue;

      if (
        (playerNamesMatch(extA, mktA) && playerNamesMatch(extB, mktB)) ||
        (playerNamesMatch(extA, mktB) && playerNamesMatch(extB, mktA))
      ) {
        return ms;
      }
    }

    return null;
  }

  /**
   * Return summary stats for logging / Telegram /status command.
   */
  summary() {
    return {
      activeMatches: this.matches.size,
      closedMatches: this.closedMatches.length,
      liveMatches: this.getAll().filter(m => m.isInPlay && m.status === 'LIVE').length,
    };
  }
}

module.exports = StateStore;
