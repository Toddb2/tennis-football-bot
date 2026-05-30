'use strict';

/**
 * scripts/simCandidate.js
 *
 * Standalone backfill worker for Strategy Lab candidate simulation. Forked by
 * candidateSim.spawnBackfill()/spawnPending() so the heavy historical replay
 * runs in its own process and never blocks the bot's event loop.
 *
 * A cross-process lock file ensures only ONE sim worker runs at a time, no
 * matter what triggered it (discovery, chat, manual create, edit, CLI). A
 * second worker waits for the lock, then runs — so candidates created while a
 * backfill is in flight still get picked up afterwards (no collisions, no
 * half-written rows).
 *
 * Usage:
 *   node scripts/simCandidate.js <labId>     # backfill one candidate
 *   node scripts/simCandidate.js --pending   # backfill every draft candidate
 *                                            # with no sim data, in ONE scan
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const db = require('../src/database/db');
const candidateSim = require('../src/analysis/candidateSim');
const logger = require('../src/utils/logger');

const LOCK_FILE   = path.join(__dirname, '../data/.candidate_sim.lock');
const STALE_MS    = 30 * 60 * 1000;   // fallback: lock older than this is abandoned
const WAIT_STEP   = 5000;
const MAX_WAIT_MS = 30 * 60 * 1000;

function _sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Is the process that owns the lock still alive? signal 0 only checks existence.
function _ownerAlive() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }   // throws ESRCH if dead
    catch (e) { return e.code === 'EPERM'; }      // EPERM = exists but not ours → alive
  } catch (_) { return false; }
}

function acquireLock() {
  const deadline = Date.now() + MAX_WAIT_MS;
  let waited = false;
  while (true) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');     // fails if it already exists
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Steal the lock if its owner is dead, or if it's older than STALE_MS.
      let steal = !_ownerAlive();
      if (!steal) { try { steal = (Date.now() - fs.statSync(LOCK_FILE).mtimeMs) > STALE_MS; } catch (_) { steal = true; } }
      if (steal) { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} continue; }
      if (Date.now() > deadline) { logger.warn('simCandidate: lock wait timed out — proceeding anyway'); return false; }
      if (!waited) { logger.info('simCandidate: another sim worker holds the lock — waiting'); waited = true; }
      _sleepSync(WAIT_STEP);
    }
  }
}

function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} }
// Release on abnormal termination too (SIGTERM from pm2 restart, Ctrl-C, etc.).
process.on('SIGTERM', () => { releaseLock(); process.exit(143); });
process.on('SIGINT',  () => { releaseLock(); process.exit(130); });

function main() {
  const arg = process.argv[2];
  if (!arg) { console.error('usage: simCandidate.js <labId> | --pending'); process.exit(1); }

  acquireLock();
  process.on('exit', releaseLock);

  const t0 = Date.now();
  try {
    if (arg === '--pending') {
      const r = candidateSim.backfillPending();
      logger.info('simCandidate: pending done', { ...r, ms: Date.now() - t0 });
    } else {
      const n = candidateSim.backfillCandidate(Number(arg));
      logger.info('simCandidate: done', { id: Number(arg), bets: n, ms: Date.now() - t0 });
    }
  } catch (e) {
    logger.error('simCandidate: failed', { arg, message: e.message });
  } finally {
    releaseLock();
  }
}

main();
