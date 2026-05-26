'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'data', 'tennis-bot.db'), { readonly: true });

// Today's bets
const bets = db.prepare(`
  SELECT strategy_name, player_name, bet_id, placed_at, dry_run, settlement_type
    FROM bets
   WHERE substr(placed_at, 1, 10) = '2026-05-20'
   ORDER BY placed_at
`).all();

// Today's rejections (informational)
const rej = db.prepare(`
  SELECT strategy_name, match_name, rejection_stage, rejection_reason, ts
    FROM bet_rejections
   WHERE substr(ts, 1, 10) = '2026-05-20'
     AND strategy_name IS NOT NULL
   ORDER BY ts
`).all();

console.log(`Bets in DB today: ${bets.length}`);
const betKeys = new Set(bets.map(b => `${b.strategy_name}|${b.player_name}`));
console.log(`Distinct (strategy|player) bets: ${betKeys.size}`);

// BFBM CSV
const csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'bfbm-signals.csv'), 'utf8');
const lines = csv.split('\n').slice(1).filter(l => l.trim());
console.log(`BFBM CSV rows: ${lines.length}`);
const csvKeys = new Set();
for (const l of lines) {
  const cols = l.split(',');
  csvKeys.add(`${cols[0]}|${cols[3]}`);
}
console.log(`Distinct (strategy|player) in CSV: ${csvKeys.size}`);

// In CSV but not in bets
const orphans = [...csvKeys].filter(k => !betKeys.has(k));
console.log(`\nIn CSV but NO bet placed: ${orphans.length}`);
for (const k of orphans) {
  const [s, p] = k.split('|');
  const matchingRej = rej.filter(r => r.strategy_name === s && (r.match_name || '').includes(p)).slice(0, 1);
  const why = matchingRej.length ? `${matchingRej[0].rejection_stage}: ${matchingRej[0].rejection_reason}` : '(no rejection log)';
  console.log(`  ${s.padEnd(12)} | ${p.padEnd(28)} | ${why}`);
}

// In bets but not in CSV
const missingFromCsv = [...betKeys].filter(k => !csvKeys.has(k));
console.log(`\nBet placed but NOT in CSV: ${missingFromCsv.length}`);
for (const k of missingFromCsv.slice(0, 20)) console.log(`  ${k}`);
