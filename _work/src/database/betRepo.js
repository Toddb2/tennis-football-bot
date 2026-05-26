'use strict';

/**
 * betRepo.js — CRUD for the bets and bet_rejections tables
 */

const db = require('./db');

// ---------------------------------------------------------------------------
// Prepared statements — bets
// ---------------------------------------------------------------------------

const _insert = db.prepare(`
  INSERT OR IGNORE INTO bets (
    bet_id, betfair_market_id, strategy_name, sub_strategy,
    player_key, player_name, side,
    requested_odds, actual_odds, stake, size_matched, liability,
    momentum_at_bet, edge_at_bet,
    placed_at, dry_run, reason, exit_config
  ) VALUES (
    @betId, @betfairMarketId, @strategyName, @subStrategy,
    @playerKey, @playerName, @side,
    @requestedOdds, @actualOdds, @stake, @sizeMatched, @liability,
    @momentumAtBet, @edgeAtBet,
    @placedAt, @dryRun, @reason, @exitConfig
  )
`);

const _settle = db.prepare(`
  UPDATE bets
  SET settled_at      = @settledAt,
      settlement_type = @settlementType,
      pnl             = @pnl,
      actual_odds     = COALESCE(@actualOdds, actual_odds),
      hedge_odds      = COALESCE(@hedgeOdds, hedge_odds)
  WHERE bet_id = @betId
`);

const _getOpen = db.prepare(`
  SELECT * FROM bets WHERE settled_at IS NULL ORDER BY placed_at DESC
`);

const _getByMarket = db.prepare(`
  SELECT * FROM bets WHERE betfair_market_id = ? ORDER BY placed_at
`);

const _getRecent = db.prepare(`
  SELECT b.*, m.surface, m.tournament, m.match_name, m.player_a_name, m.player_b_name,
    COALESCE(
      (SELECT s.sets FROM market_snapshots s
       WHERE s.betfair_market_id = b.betfair_market_id
         AND s.sets IS NOT NULL
       ORDER BY s.ts DESC LIMIT 1),
      m.final_sets
    ) AS latest_sets,
    COALESCE(
      (SELECT s.serve_stats FROM market_snapshots s
       WHERE s.betfair_market_id = b.betfair_market_id
         AND s.ts <= b.placed_at
         AND s.serve_stats IS NOT NULL
       ORDER BY s.ts DESC LIMIT 1),
      (SELECT s.serve_stats FROM market_snapshots s
       WHERE s.betfair_market_id = b.betfair_market_id
         AND s.serve_stats IS NOT NULL
       ORDER BY s.ts DESC LIMIT 1)
    ) AS snapshot_serve_stats
  FROM bets b
  LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE b.placed_at >= datetime('now', @since)
  ORDER BY b.placed_at DESC
  LIMIT @limit
`);

const _getAll = db.prepare(`
  SELECT b.*, m.surface, m.tournament
  FROM bets b
  LEFT JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  ORDER BY b.placed_at DESC
  LIMIT @limit OFFSET @offset
`);

const _countAll = db.prepare(`SELECT COUNT(*) AS n FROM bets`);

// ROI = PnL ÷ Stake (industry standard yield on turnover). Comparable across
// back and lay strategies — for a £2 lay at 1.4, ROI = pnl/2, not pnl/0.80.
// liability is still surfaced in the bets table & CSV for per-bet risk visibility.
const _getPnlByStrategy = db.prepare(`
  SELECT
    strategy_name,
    COUNT(*)                                                AS total_bets,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                AS wins,
    SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END)               AS losses,
    ROUND(SUM(pnl), 2)                                      AS total_pnl,
    ROUND(AVG(requested_odds), 3)                           AS avg_odds,
    ROUND(SUM(stake), 2)                                    AS total_stake,
    ROUND(SUM(liability), 2)                                AS total_liability,
    ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2)        AS roi_pct
  FROM bets
  WHERE settled_at IS NOT NULL
  GROUP BY strategy_name
  ORDER BY total_pnl DESC
`);

// Same shape as _getPnlByStrategy but split into P1/P2 sub-strategies.
const _getPnlBySubStrategy = db.prepare(`
  SELECT
    COALESCE(sub_strategy, strategy_name || '-?') AS sub_strategy,
    strategy_name,
    COUNT(*)                                                AS total_bets,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                AS wins,
    SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END)               AS losses,
    ROUND(SUM(pnl), 2)                                      AS total_pnl,
    ROUND(AVG(requested_odds), 3)                           AS avg_odds,
    ROUND(SUM(stake), 2)                                    AS total_stake,
    ROUND(SUM(liability), 2)                                AS total_liability,
    ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2)        AS roi_pct
  FROM bets
  WHERE settled_at IS NOT NULL
  GROUP BY sub_strategy, strategy_name
  ORDER BY total_pnl DESC
`);

const _getDailyPnl = db.prepare(`
  SELECT
    strftime('%Y-%m-%d', settled_at)                  AS day,
    COUNT(*)                                          AS bets,
    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)          AS wins,
    SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END)         AS losses,
    ROUND(SUM(stake), 2)                              AS stake,
    ROUND(SUM(liability), 2)                          AS liability,
    ROUND(SUM(pnl), 2)                                AS pnl,
    ROUND(SUM(pnl) / NULLIF(SUM(stake), 0) * 100, 2)  AS roi_pct
  FROM bets
  WHERE settled_at IS NOT NULL
    AND settled_at >= datetime('now', '-30 days')
  GROUP BY day
  ORDER BY day
`);

// ---------------------------------------------------------------------------
// Prepared statements — bet_rejections
// ---------------------------------------------------------------------------

const _insertRejection = db.prepare(`
  INSERT INTO bet_rejections (
    betfair_market_id, match_name, strategy_name,
    rejection_stage, rejection_reason, odds, details
  ) VALUES (
    @betfairMarketId, @matchName, @strategyName,
    @rejectionStage, @rejectionReason, @odds, @details
  )
`);

const _getRecentRejections = db.prepare(`
  SELECT * FROM bet_rejections
  WHERE ts >= datetime('now', '-24 hours')
  ORDER BY ts DESC
  LIMIT 200
`);

const _getRejectionsByMarket = db.prepare(`
  SELECT * FROM bet_rejections
  WHERE betfair_market_id = ?
  ORDER BY ts
`);

// ---------------------------------------------------------------------------
// Public API — bets
// ---------------------------------------------------------------------------

/** Record a newly placed bet. */
function insert(fields) {
  // Auto-derive sub_strategy if caller hasn't supplied one.
  // If strategy name already encodes the side (ends in _P1 or _P2), don't append a redundant suffix.
  const subStrategy = fields.subStrategy ?? (() => {
    const n = fields.strategyName;
    const k = fields.playerKey;
    if (!n || !k) return null;
    if (/_P[12]$/.test(n)) return n;
    return `${n}-${k === 'A' ? 'P1' : 'P2'}`;
  })();
  // Auto-derive liability if caller hasn't supplied one.
  const odds = fields.actualOdds ?? fields.requestedOdds;
  const liability = fields.liability ?? (
    (fields.stake != null && odds != null)
      ? (fields.side === 'LAY' ? +(fields.stake * (odds - 1)).toFixed(4) : fields.stake)
      : null
  );
  _insert.run({
    betId:           fields.betId           ?? null,
    betfairMarketId: fields.betfairMarketId ?? null,
    strategyName:    fields.strategyName    ?? null,
    subStrategy:     subStrategy,
    playerKey:       fields.playerKey       ?? null,
    playerName:      fields.playerName      ?? null,
    side:            fields.side            ?? null,
    requestedOdds:   fields.requestedOdds   ?? null,
    actualOdds:      fields.actualOdds      ?? null,
    stake:           fields.stake           ?? null,
    sizeMatched:     fields.sizeMatched     ?? null,
    liability:       liability,
    momentumAtBet:   fields.momentumAtBet   ?? null,
    edgeAtBet:       fields.edgeAtBet       ?? null,
    placedAt:        fields.placedAt        ?? new Date().toISOString(),
    dryRun:          fields.dryRun          ? 1 : 0,
    reason:          fields.reason          ?? null,
    exitConfig:      fields.exitConfig      ? JSON.stringify(fields.exitConfig) : null,
  });

  // Post-insert: backfill momentum / edge from the latest pre-bet snapshot
  // for callers that didn't supply them (most do not).
  try { _postInsertBackfill.run({ betId: fields.betId }); }                       catch (_) {}
  try { _postInsertEdgeBackfillA.run({ betId: fields.betId }); }                  catch (_) {}
  try { _postInsertEdgeBackfillB.run({ betId: fields.betId }); }                  catch (_) {}
}

// momentum stored signed for BET PLAYER: positive = bet player has momentum.
// Raw market_snapshots.momentum_index is A-perspective, so flip for P2 bets.
const _postInsertBackfill = db.prepare(`
  UPDATE bets
  SET momentum_at_bet = (CASE player_key WHEN 'B' THEN -1 ELSE 1 END) * (
    SELECT s.momentum_index FROM market_snapshots s
    WHERE s.betfair_market_id = bets.betfair_market_id
      AND s.ts <= bets.placed_at
      AND s.momentum_index IS NOT NULL
    ORDER BY s.ts DESC LIMIT 1
  )
  WHERE bet_id = @betId AND momentum_at_bet IS NULL
`);
const _postInsertEdgeBackfillA = db.prepare(`
  UPDATE bets
  SET edge_at_bet = CASE side WHEN 'BACK' THEN 1 ELSE -1 END * (
    SELECT s.edge_a FROM market_snapshots s
    WHERE s.betfair_market_id = bets.betfair_market_id
      AND s.ts <= bets.placed_at
      AND s.edge_a IS NOT NULL
    ORDER BY s.ts DESC LIMIT 1
  )
  WHERE bet_id = @betId AND player_key = 'A' AND edge_at_bet IS NULL
`);
const _postInsertEdgeBackfillB = db.prepare(`
  UPDATE bets
  SET edge_at_bet = CASE side WHEN 'BACK' THEN 1 ELSE -1 END * (
    SELECT s.edge_b FROM market_snapshots s
    WHERE s.betfair_market_id = bets.betfair_market_id
      AND s.ts <= bets.placed_at
      AND s.edge_b IS NOT NULL
    ORDER BY s.ts DESC LIMIT 1
  )
  WHERE bet_id = @betId AND player_key = 'B' AND edge_at_bet IS NULL
`);

/** Settle an existing bet (trade-out, win, loss, cancel). */
function settle(betId, { settlementType, pnl, actualOdds, hedgeOdds, settledAt }) {
  _settle.run({
    betId,
    settlementType: settlementType ?? null,
    pnl:            pnl            ?? null,
    actualOdds:     actualOdds     ?? null,
    hedgeOdds:      hedgeOdds      ?? null,
    settledAt:      settledAt      ?? new Date().toISOString(),
  });
}

function getOpen() {
  return _getOpen.all();
}

function getByMarket(betfairMarketId) {
  return _getByMarket.all(betfairMarketId);
}

/**
 * Recent bets with market metadata joined in.
 * @param {string} since — SQLite datetime modifier e.g. '-7 days'
 * @param {number} limit
 */
function getRecent(since = '-7 days', limit = 500) {
  return _getRecent.all({ since, limit });
}

function getAll({ limit = 1000, offset = 0 } = {}) {
  return _getAll.all({ limit, offset });
}

function countAll() {
  return _countAll.get().n;
}

/** Per-strategy P&L summary for the dashboard analytics tab. ROI uses liability. */
function getPnlByStrategy() {
  return _getPnlByStrategy.all();
}

/** Per P1/P2 sub-strategy P&L summary (splits symmetric strategies by side). */
function getPnlBySubStrategy() {
  return _getPnlBySubStrategy.all();
}

/** Daily P&L for the last 30 days (for chart). */
function getDailyPnl() {
  return _getDailyPnl.all();
}

/** PnL settled today (UTC date). Restart-proof — reads from DB, not in-memory. */
const _getPnlToday = db.prepare(`
  SELECT COALESCE(ROUND(SUM(pnl), 2), 0) AS pnl,
         COUNT(*)                         AS bets
  FROM bets
  WHERE settled_at IS NOT NULL
    AND DATE(settled_at) = DATE('now')
`);
function getPnlToday() {
  const r = _getPnlToday.get();
  return { pnl: r?.pnl ?? 0, bets: r?.bets ?? 0 };
}

// ---------------------------------------------------------------------------
// Public API — rejections
// ---------------------------------------------------------------------------

/** Log a bet that was considered but not placed. */
function insertRejection(fields) {
  _insertRejection.run({
    betfairMarketId: fields.betfairMarketId ?? null,
    matchName:       fields.matchName       ?? null,
    strategyName:    fields.strategyName    ?? null,
    rejectionStage:  fields.rejectionStage  ?? null,
    rejectionReason: fields.rejectionReason ?? null,
    odds:            fields.odds            ?? null,
    details:         fields.details         ? JSON.stringify(fields.details) : null,
  });
}

function getRecentRejections() {
  return _getRecentRejections.all();
}

function getRejectionsByMarket(betfairMarketId) {
  return _getRejectionsByMarket.all(betfairMarketId);
}

/** Backfill a null strategy_name after the fact (e.g. from reason field). */
function backfillStrategyName(betId, strategyName) {
  db.prepare('UPDATE bets SET strategy_name = ? WHERE bet_id = ? AND strategy_name IS NULL')
    .run(strategyName, betId);
}

/** Delete all bets and rejections — triggered by dashboard "Clear History" button. */
function clearAll() {
  db.prepare('DELETE FROM bets').run();
  db.prepare('DELETE FROM bet_rejections').run();
}

/** Delete a single bet by its bet_id. */
function deleteById(betId) {
  db.prepare('DELETE FROM bets WHERE bet_id = ?').run(betId);
}

module.exports = {
  insert, settle, getOpen, getByMarket, getRecent, getAll, countAll,
  getPnlByStrategy, getPnlBySubStrategy, getDailyPnl, getPnlToday,
  insertRejection, getRecentRejections, getRejectionsByMarket,
  backfillStrategyName, clearAll, deleteById,
};
