#!/usr/bin/env node
'use strict';
/**
 * One-shot: delete bets where bet_player_serve_quality_trigger cannot be
 * computed (no usable serve_stats snapshot for the trigger set).
 *
 * Backfill is already covered by betRepo._getRecent's COALESCE fallback to
 * the latest serve_stats snapshot for the same market.  This script applies
 * the same logic and prunes bets that still come out null.
 */

const path        = require('path');
const Database    = require('better-sqlite3');
const serveScorer = require('../src/algorithm/serveScorer');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'tennis-bot.db');
const APPLY   = process.argv.includes('--apply');

const db = new Database(DB_PATH);

const bets = db.prepare(`
  SELECT b.bet_id, b.betfair_market_id, b.placed_at, b.player_key, b.reason,
         b.strategy_name, m.match_name
  FROM bets b
  LEFT JOIN markets m ON m.betfair_market_id = b.betfair_market_id
`).all();

const getSnap = db.prepare(`
  SELECT serve_stats FROM market_snapshots
  WHERE betfair_market_id = ? AND serve_stats IS NOT NULL
  ORDER BY CASE WHEN ts <= ? THEN 0 ELSE 1 END, ts DESC
  LIMIT 1
`);

const _sq = ps => ps ? serveScorer.score(ps).score : null;
const flip = v => (v == null ? null : -v);

const toDelete = [];
let backfilled = 0;
let alreadyOk  = 0;

for (const b of bets) {
  const row = getSnap.get(b.betfair_market_id, b.placed_at);
  let stats = null;
  try { stats = row?.serve_stats ? JSON.parse(row.serve_stats) : null; } catch (_) {}
  const setN = parseInt((b.reason || '').match(/set\s+(\d+)\s+complete/i)?.[1] || '1', 10);
  const setKey = setN === 2 ? 'set2' : 'set1';
  const sqA = _sq(stats?.[setKey]?.playerA);
  const sqB = _sq(stats?.[setKey]?.playerB);
  const betSq = b.player_key === 'A' ? sqA : sqB;

  if (betSq == null) {
    toDelete.push(b);
  } else {
    // Was the value sourced from a snapshot AFTER placed_at?  (i.e. backfill)
    const preRow = db.prepare(`
      SELECT 1 FROM market_snapshots
      WHERE betfair_market_id = ? AND serve_stats IS NOT NULL AND ts <= ?
      LIMIT 1
    `).get(b.betfair_market_id, b.placed_at);
    if (preRow) alreadyOk++; else backfilled++;
  }
}

console.log(`Total bets:        ${bets.length}`);
console.log(`Already had SQ:    ${alreadyOk}`);
console.log(`Backfilled (post): ${backfilled}`);
console.log(`To delete (null):  ${toDelete.length}`);

if (toDelete.length && toDelete.length <= 50) {
  for (const b of toDelete) {
    console.log(`  - ${b.bet_id}  ${b.placed_at}  ${b.strategy_name}  ${b.match_name}`);
  }
}

if (!APPLY) {
  console.log('\nDry-run only.  Re-run with --apply to actually delete.');
  process.exit(0);
}

const del = db.prepare('DELETE FROM bets WHERE bet_id = ?');
const tx  = db.transaction(rows => { for (const r of rows) del.run(r.bet_id); });
tx(toDelete);
console.log(`\nDeleted ${toDelete.length} bets.`);
