'use strict';

const db = require('./db');

const _insert = db.prepare(`
  INSERT OR IGNORE INTO price_milestones
    (betfair_market_id, milestone, player_a_back, player_b_back, set_score, matched_volume)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function insertMilestone({ betfairMarketId, milestone, playerABack, playerBBack, setScore, matchedVolume }) {
  _insert.run(
    betfairMarketId,
    milestone,
    playerABack  ?? null,
    playerBBack  ?? null,
    setScore     || null,
    matchedVolume ?? null
  );
}

function getMilestonesForMarket(betfairMarketId) {
  return db.prepare(
    'SELECT * FROM price_milestones WHERE betfair_market_id = ? ORDER BY ts ASC'
  ).all(betfairMarketId);
}

function getRecentMilestones(limit = 100) {
  return db.prepare(`
    SELECT pm.*, m.match_name
    FROM price_milestones pm
    LEFT JOIN markets m ON pm.betfair_market_id = m.betfair_market_id
    ORDER BY pm.ts DESC
    LIMIT ?
  `).all(limit);
}

module.exports = { insertMilestone, getMilestonesForMarket, getRecentMilestones };
