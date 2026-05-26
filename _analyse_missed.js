// Inspect the AI-generated missed_bets.csv: count, distribution, and
// cross-check against the live DB (do the markets exist? do the rejections
// confirm the strategy was evaluated? was a real bet placed already?).
const fs = require('fs');
const path = require('path');

// SIMPLE CSV parser respecting quoted fields (handles ""-escaped quotes).
function parseCsv(text) {
  const lines = [];
  let cur = '', row = [], inQ = false;
  const flush = () => { row.push(cur); cur = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') flush();
      else if (c === '\n') { flush(); lines.push(row); row = []; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur || row.length) { flush(); lines.push(row); }
  return lines;
}

const csvPath = process.argv[2];
const raw = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const rows = parseCsv(raw);
const header = rows.shift();
const idx = (name) => {
  const i = header.findIndex(h => h === name);
  return i;
};
const COL = {
  betId:      idx('Bet ID'),
  match:      idx('Match'),
  surface:    idx('Surface'),
  tournament: idx('Tournament'),
  strategy:   idx('Strategy'),
  subStrat:   idx('Sub-Strategy (StratX-P1 / StratX-P2)'),
  playerKey:  idx('Player Key (A/B)'),
  player:     idx('Bet Player Name'),
  side:       idx('Bet Side (back/lay)'),
  odds:       idx('Requested Odds'),
  stake:      idx('Stake (£)'),
  marketId:   idx('Betfair Market ID'),
  reason:     idx('Reason / Note'),
  latestSets: idx('Latest Set Scores'),
};

console.log('=== File summary ===');
console.log('Total data rows:', rows.length - 1);  // last is empty
console.log('Header cols:', header.length);

const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
// run locally? need to skip if DB not available
let db;
try {
  db = new Database('/home/bots/tennis-bot/data/tennis-bot.db', { readonly: true });
} catch (e) {
  console.error('Cannot open DB locally:', e.message);
  process.exit(1);
}

// Distribution
const byStrat = {};
const bySide  = {};
const byKey   = {};
for (const r of rows) {
  if (!r[COL.strategy]) continue;
  byStrat[r[COL.strategy]] = (byStrat[r[COL.strategy]] || 0) + 1;
  bySide[r[COL.side]]      = (bySide[r[COL.side]]      || 0) + 1;
  byKey[r[COL.playerKey]]  = (byKey[r[COL.playerKey]]  || 0) + 1;
}
console.log('\n=== By strategy ==='); Object.entries(byStrat).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k.padEnd(14)} ${v}`));
console.log('\n=== By side ===');     Object.entries(bySide).forEach(([k,v]) => console.log(`  ${k.padEnd(6)} ${v}`));
console.log('\n=== By player_key ==='); Object.entries(byKey).forEach(([k,v]) => console.log(`  ${k.padEnd(2)} ${v}`));

// Spot-check markets: do we have them in our markets table?
const marketIds = [...new Set(rows.map(r => r[COL.marketId]).filter(Boolean))];
console.log('\n=== Market verification ===');
console.log('Unique markets in CSV:', marketIds.length);
const existingMarkets = db.prepare(
  `SELECT betfair_market_id, match_name, final_sets, winner FROM markets WHERE betfair_market_id IN (${marketIds.map(() => '?').join(',')})`
).all(...marketIds);
console.log('Markets present in DB:', existingMarkets.length);
console.log('Markets MISSING from DB:', marketIds.length - existingMarkets.length);

const missingMarkets = marketIds.filter(m => !existingMarkets.find(e => e.betfair_market_id === m));
if (missingMarkets.length) {
  console.log('First 10 missing:');
  missingMarkets.slice(0, 10).forEach(m => {
    const sample = rows.find(r => r[COL.marketId] === m);
    console.log(`  ${m}  ${sample?.[COL.match]}  ${sample?.[COL.strategy]}`);
  });
}

// For markets that exist: was a bet actually placed already?
const placedByMarket = db.prepare(
  `SELECT betfair_market_id, strategy_name, player_key, side FROM bets WHERE betfair_market_id IN (${marketIds.map(() => '?').join(',')})`
).all(...marketIds);
console.log('\n=== Cross-check vs existing bets ===');
const placedKey = (b) => `${b.betfair_market_id}|${b.strategy_name}|${b.player_key}|${b.side}`;
const placedSet = new Set(placedByMarket.map(placedKey));

let alreadyPlaced = 0, trulyMissed = 0, marketMissing = 0;
const noMarket = [], duplicates = [];
for (const r of rows) {
  if (!r[COL.marketId]) continue;
  const market = r[COL.marketId];
  const strat  = r[COL.strategy];
  const key    = r[COL.playerKey];
  const side   = r[COL.side];
  if (!existingMarkets.find(e => e.betfair_market_id === market)) {
    marketMissing++;
    noMarket.push({ market, match: r[COL.match], strat });
    continue;
  }
  const k = `${market}|${strat}|${key}|${side}`;
  if (placedSet.has(k)) { alreadyPlaced++; duplicates.push({ market, strat, key, side }); }
  else trulyMissed++;
}
console.log(`  Already placed:   ${alreadyPlaced}`);
console.log(`  Truly missed:     ${trulyMissed}`);
console.log(`  Market not in DB: ${marketMissing}`);

if (duplicates.length) {
  console.log('\n=== Sample already-placed (so CSV would duplicate) ===');
  duplicates.slice(0, 8).forEach(d => console.log(' ', d));
}

// Were rejections logged for these markets/strategies? If yes, the strategy was
// evaluated but rejected — so the bet was NOT silently missed; it was rejected.
console.log('\n=== Rejection cross-check (sample 8 truly missed) ===');
const missedSamples = [];
for (const r of rows) {
  if (!r[COL.marketId]) continue;
  if (missedSamples.length >= 8) break;
  const k = `${r[COL.marketId]}|${r[COL.strategy]}|${r[COL.playerKey]}|${r[COL.side]}`;
  if (placedSet.has(k)) continue;
  if (!existingMarkets.find(e => e.betfair_market_id === r[COL.marketId])) continue;
  missedSamples.push(r);
}
for (const r of missedSamples) {
  const rej = db.prepare(`
    SELECT rejection_stage, rejection_reason, COUNT(*) AS n
    FROM bet_rejections
    WHERE betfair_market_id = ? AND strategy_name = ?
    GROUP BY rejection_stage, rejection_reason
    ORDER BY n DESC LIMIT 3
  `).all(r[COL.marketId], r[COL.strategy]);
  console.log(`\n  ${r[COL.match]}  (${r[COL.strategy]} ${r[COL.side]} ${r[COL.player]} @ ${r[COL.odds]})`);
  console.log(`    market: ${r[COL.marketId]}`);
  console.log(`    final_sets in DB: ${existingMarkets.find(e => e.betfair_market_id === r[COL.marketId])?.final_sets}`);
  console.log(`    AI claim score:   ${r[COL.latestSets]}`);
  if (rej.length === 0) {
    console.log(`    ⚠ NO rejections logged for this strategy on this market — strategy may not have been evaluated`);
  } else {
    rej.forEach(rr => console.log(`    rejected: ${rr.rejection_stage} — ${rr.rejection_reason} (×${rr.n})`));
  }
}
