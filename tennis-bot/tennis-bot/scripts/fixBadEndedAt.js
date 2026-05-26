#!/usr/bin/env node
'use strict';

/**
 * Earlier today the startup backfill bug set markets.ended_at = latest
 * snapshot ts for any market with NULL final_sets — which marked in-play
 * matches as "ended". Symptoms: ended_at < went_in_play_at on rows that are
 * still receiving live snapshots. This script un-sets ended_at on every
 * such row so the analyser stops including them as "today's closed markets".
 *
 *   node scripts/fixBadEndedAt.js          # dry run
 *   node scripts/fixBadEndedAt.js --apply  # commit
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const dbPath = process.env.TENNIS_DB
  || path.join(__dirname, '..', 'data', 'tennis-bot.db');

const db = new Database(dbPath);

// A market is "actually still in play" if it has a snapshot in the last 30 min
// OR its ended_at is somehow earlier than its went_in_play_at (impossible).
const bad = db.prepare(`
  SELECT betfair_market_id, match_name, ended_at, went_in_play_at,
         (SELECT MAX(s.ts) FROM market_snapshots s
           WHERE s.betfair_market_id = m.betfair_market_id) AS last_snap_ts
    FROM markets m
   WHERE ended_at IS NOT NULL
     AND winner IS NULL
     AND (
           ended_at < went_in_play_at
           OR (SELECT MAX(s.ts) FROM market_snapshots s
                WHERE s.betfair_market_id = m.betfair_market_id) >= datetime('now', '-30 minutes')
         )
`).all();

const upd = APPLY
  ? db.prepare(`UPDATE markets SET ended_at = NULL WHERE betfair_market_id = ?`)
  : null;

const tx = db.transaction(() => {
  for (const r of bad) if (APPLY) upd.run(r.betfair_market_id);
});
tx();

console.log(`Bad rows found: ${bad.length}`);
for (const r of bad.slice(0, 15)) {
  console.log(`  ${r.betfair_market_id}  ${r.match_name}  ended_at=${r.ended_at}  went_in_play=${r.went_in_play_at}  last_snap=${r.last_snap_ts}`);
}
console.log(APPLY ? 'Cleared ended_at on those rows.' : 'Dry run — pass --apply to commit.');
