#!/usr/bin/env node
'use strict';

/**
 * One-off backfill of the markets.surface column. Walks every market row with
 * NULL surface and runs the venue/tournament inference against the existing
 * tournament name. Safe to re-run.
 *
 *   node scripts/backfillSurface.js              # dry run, prints stats
 *   node scripts/backfillSurface.js --apply      # actually writes
 */

const path = require('path');
const Database = require('better-sqlite3');
const { inferSurface } = require('../src/utils/surfaceInference');

const APPLY = process.argv.includes('--apply');
const dbPath = process.env.TENNIS_DB
  || path.join(__dirname, '..', 'data', 'tennis-bot.db');

const db = new Database(dbPath, { readonly: !APPLY });

const rows = db.prepare(`
  SELECT betfair_market_id, tournament
    FROM markets
   WHERE surface IS NULL OR surface = ''
`).all();

const upd = APPLY
  ? db.prepare(`UPDATE markets SET surface = ? WHERE betfair_market_id = ?`)
  : null;

const tally = { hard: 0, clay: 0, grass: 0, carpet: 0, unknown: 0 };
const unknownSamples = new Set();

const tx = db.transaction(() => {
  for (const row of rows) {
    const s = inferSurface({ tournament: row.tournament });
    if (s) {
      tally[s] = (tally[s] || 0) + 1;
      if (APPLY) upd.run(s, row.betfair_market_id);
    } else {
      tally.unknown++;
      if (row.tournament && unknownSamples.size < 40) unknownSamples.add(row.tournament);
    }
  }
});
tx();

console.log(`Markets with NULL surface: ${rows.length}`);
console.log('Inferred:', tally);
console.log(APPLY ? 'Wrote updates.' : 'Dry run — pass --apply to commit.');
if (unknownSamples.size) {
  console.log('\nUnmapped tournament names (sample):');
  for (const t of unknownSamples) console.log('  ' + t);
}
