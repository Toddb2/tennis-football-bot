#!/usr/bin/env node
'use strict';

/**
 * One-off destructive rewrite: normalise every historic bet to stake = £1 and
 * rescale dependent monetary fields proportionally so ROI / WR / cumulative
 * P&L all stay numerically correct under the new unit stake.
 *
 *   pnl_new       = pnl_old / stake_old
 *   liability_new = liability_old / stake_old
 *   size_matched_new = size_matched_old / stake_old
 *   stake_new     = 1.0
 *
 * The original stake is preserved in a new column `stake_original` so this is
 * reversible if needed.
 *
 *   node scripts/rewriteStakesToOne.js          # dry run — prints diff stats
 *   node scripts/rewriteStakesToOne.js --apply  # commit
 */

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const dbPath = process.env.TENNIS_DB
  || path.join(__dirname, '..', 'data', 'tennis-bot.db');

// Open read-write so we can ALTER the schema even on dry-run (the ALTER alone
// is harmless — adds a NULL column). UPDATE rows are still gated on APPLY.
const db = new Database(dbPath);

try { db.exec('ALTER TABLE bets ADD COLUMN stake_original REAL'); }
catch (e) { /* already exists */ }

const rows = db.prepare(`
  SELECT id, stake, stake_original, pnl, liability, size_matched
    FROM bets
   WHERE stake IS NOT NULL AND stake > 0
`).all();

const upd = APPLY ? db.prepare(`
  UPDATE bets
     SET stake_original = COALESCE(stake_original, ?),
         stake          = 1.0,
         pnl            = CASE WHEN pnl IS NULL THEN NULL ELSE ? END,
         liability      = CASE WHEN liability IS NULL THEN NULL ELSE ? END,
         size_matched   = CASE WHEN size_matched IS NULL THEN NULL ELSE ? END
   WHERE id = ?
`) : null;

let scanned = 0, alreadyUnit = 0, rescaled = 0;
let pnlBefore = 0, pnlAfter = 0;
const tx = db.transaction(() => {
  for (const r of rows) {
    scanned++;
    if (r.stake === 1 && r.stake_original != null) { alreadyUnit++; continue; }
    const s = r.stake;
    const newPnl = r.pnl == null ? null : r.pnl / s;
    const newLiab = r.liability == null ? null : r.liability / s;
    const newSize = r.size_matched == null ? null : r.size_matched / s;
    if (r.pnl != null) { pnlBefore += r.pnl; pnlAfter += newPnl; }
    rescaled++;
    if (APPLY) upd.run(s, newPnl, newLiab, newSize, r.id);
  }
});
tx();

console.log(`Bets scanned: ${scanned}`);
console.log(`  already at unit-stake: ${alreadyUnit}`);
console.log(`  rescaled:              ${rescaled}`);
console.log(`  total P&L before:      ${pnlBefore.toFixed(2)}`);
console.log(`  total P&L after:       ${pnlAfter.toFixed(2)}`);
console.log(APPLY ? 'Wrote updates. Original stakes saved in bets.stake_original.'
                  : 'Dry run — pass --apply to commit.');
