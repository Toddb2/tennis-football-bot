#!/usr/bin/env node
'use strict';

/**
 * Populate markets.final_sets for any market where it is NULL but at least one
 * market_snapshots row carries a sets payload. Same logic that runs at bot
 * startup; available as a standalone script for ad-hoc runs.
 *
 *   node scripts/backfillFinalSets.js          # dry run
 *   node scripts/backfillFinalSets.js --apply  # commit
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const dbPath = process.env.TENNIS_DB
  || path.join(__dirname, '..', 'data', 'tennis-bot.db');

const db = new Database(dbPath, { readonly: !APPLY });

const rows = db.prepare(`
  SELECT m.betfair_market_id,
         m.ended_at,
         (SELECT sets FROM market_snapshots s
           WHERE s.betfair_market_id = m.betfair_market_id
             AND s.sets IS NOT NULL
           ORDER BY s.ts DESC LIMIT 1) AS sets_blob,
         (SELECT ts FROM market_snapshots s
           WHERE s.betfair_market_id = m.betfair_market_id
           ORDER BY s.ts DESC LIMIT 1) AS last_ts
    FROM markets m
   WHERE m.final_sets IS NULL
`).all();

const upd = APPLY
  ? db.prepare(`UPDATE markets SET final_sets = ?, ended_at = COALESCE(ended_at, ?) WHERE betfair_market_id = ?`)
  : null;

let filled = 0, stillEmpty = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    if (!r.sets_blob) { stillEmpty++; continue; }
    filled++;
    if (APPLY) upd.run(r.sets_blob, r.last_ts || r.ended_at, r.betfair_market_id);
  }
});
tx();

console.log(`Markets with NULL final_sets: ${rows.length}`);
console.log(`  fillable from snapshots:   ${filled}`);
console.log(`  no usable snapshot:        ${stillEmpty}`);
console.log(APPLY ? 'Wrote updates.' : 'Dry run — pass --apply to commit.');
