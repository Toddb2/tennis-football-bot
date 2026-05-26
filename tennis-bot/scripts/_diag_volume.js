'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'tennis-bot.db'), { readonly: true });

const sql = `
  SELECT b.bet_id, b.betfair_market_id, b.placed_at,
    (SELECT s.matched_volume FROM market_snapshots s
     WHERE s.betfair_market_id = b.betfair_market_id
       AND s.ts <= b.placed_at
       AND s.matched_volume IS NOT NULL
     ORDER BY s.ts DESC LIMIT 1) AS vol_before,
    (SELECT s.matched_volume FROM market_snapshots s
     WHERE s.betfair_market_id = b.betfair_market_id
       AND s.matched_volume IS NOT NULL
     ORDER BY s.ts DESC LIMIT 1) AS vol_latest,
    (SELECT MIN(ts) FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id) AS first_snap_ts,
    (SELECT COUNT(*) FROM market_snapshots s WHERE s.betfair_market_id = b.betfair_market_id) AS snap_count
  FROM bets b
  WHERE b.placed_at > '2026-05-15'
  LIMIT 5
`;
console.log(JSON.stringify(db.prepare(sql).all(), null, 2));
