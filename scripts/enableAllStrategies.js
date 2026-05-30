#!/usr/bin/env node
'use strict';

/**
 * Flip every system in config/strategies.json to enabled:true so the bot
 * fires (and BFBM-exports) for the full strategy roster. Writes a timestamped
 * backup of the prior file so this can be reversed.
 *
 *   node scripts/enableAllStrategies.js          # dry run — prints which flip
 *   node scripts/enableAllStrategies.js --apply  # commit
 */

const fs   = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const FILE  = path.join(__dirname, '..', 'config', 'strategies.json');

const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const systems = cfg.systems || [];

const flipped = [];
for (const s of systems) {
  if (!s.enabled) {
    flipped.push(s.name);
    s.enabled = true;
  }
}

console.log(`Total strategies: ${systems.length}`);
console.log(`Already enabled:  ${systems.length - flipped.length}`);
console.log(`Will be enabled:  ${flipped.length}`);
if (flipped.length) {
  console.log('  ' + flipped.join(', '));
}

if (APPLY) {
  const stamp = new Date().toISOString().slice(0, 10);
  const bak = FILE + '.bak.' + stamp + '-enable-all';
  fs.copyFileSync(FILE, bak);
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`Wrote ${FILE}`);
  console.log(`Backup at ${bak}`);
} else {
  console.log('Dry run — pass --apply to commit.');
}
