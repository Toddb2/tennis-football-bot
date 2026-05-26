// Standalone test of the dedup logic from snapshotRepo.js
const path = require('path');
const repo = require(path.resolve('/home/bots/tennis-bot/src/database/snapshotRepo.js'));

// Check whether the exports include the new functions / dedup actually runs
console.log('exports:', Object.keys(repo));

// Build two near-identical matchStates and try to write both
const fakeMatch = {
  betfairMarketId: 'TEST-DEDUP-1',
  playerABack: 1.5, playerALay: 1.51, playerBBack: 2.8, playerBLay: 2.85,
  matchedVolume: 1000,
  trueProbabilityA: 0.65, trueProbabilityB: 0.35,
  edgeA: 0.02, edgeB: -0.01,
  sets: [{a:6,b:3}],
  currentGame: {a:30, b:15},
  currentServer: 'A',
  liveServeStats: null,
  momentumIndex: 5,
  momentumFeatures: { foo: 1 },
};

const r1 = repo.write(fakeMatch);
const r2 = repo.write(fakeMatch);
const r3 = repo.write({ ...fakeMatch, currentGame: {a:40, b:15} });
console.log('first write returned:', r1, '(should be true)');
console.log('second write (identical) returned:', r2, '(should be false — dedup)');
console.log('third write (game changed) returned:', r3, '(should be true)');

// Cleanup test rows
const db = require('better-sqlite3')('/home/bots/tennis-bot/data/tennis-bot.db');
const removed = db.prepare("DELETE FROM market_snapshots WHERE betfair_market_id = 'TEST-DEDUP-1'").run();
console.log(`cleanup: removed ${removed.changes} test rows`);
