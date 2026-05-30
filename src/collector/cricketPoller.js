'use strict';

/**
 * cricketPoller.js — SportMonks Cricket API v2.0 client.
 *
 * Captures the live match state the price-movement model needs: run score, wickets,
 * overs, 4s and 6s. Detailed includes (runs/batting/balls) are only returned by the
 * SINGLE-fixture endpoint on this plan, so the flow is: /livescores -> fixture ids ->
 * /fixtures/{id}?include=runs,batting per match.
 *
 * Lightweight by design: poll runs + batting (cumulative score/wickets/overs/4s/6s) and
 * let the caller detect EVENTS as deltas between snapshots (score +4 = four, +6 = six,
 * wickets +1 = fall of wicket). The heavy `balls` include is reserved for backfill /
 * exact ball timing, not routine polling.
 *
 * Standalone module — not yet wired into the main loop or Betfair stream.
 *
 *   node src/collector/cricketPoller.js        # self-test against the live API
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const BASE = 'https://cricket.sportmonks.com/api/v2.0';

function apiToken() {
  if (process.env.SPORTMONKS_CRICKET_API_KEY) return process.env.SPORTMONKS_CRICKET_API_KEY;
  // Fallback: read straight from .env if the process env isn't populated.
  try {
    const env = fs.readFileSync(path.join(__dirname, '../../.env'), 'utf8');
    return (env.match(/^SPORTMONKS_CRICKET_API_KEY=(.*)$/m) || [])[1]?.trim() || null;
  } catch (_) { return null; }
}

function get(endpoint) {
  const token = apiToken();
  if (!token) return Promise.reject(new Error('SPORTMONKS_CRICKET_API_KEY not set'));
  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${BASE}${endpoint}${sep}api_token=${token}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`cricket API HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('cricket API bad JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('cricket API timeout')); });
  });
}

/** Live fixtures right now: [{ id, league_id, status, localteam_id, visitorteam_id, total_overs_played }]. */
async function getLiveFixtures() {
  const r = await get('/livescores');
  return Array.isArray(r.data) ? r.data : [];
}

/**
 * Full normalised state for one fixture — the shape the capture loop / model consumes.
 * Returns null if the fixture can't be fetched.
 */
async function getMatchState(fixtureId) {
  const r = await get(`/fixtures/${fixtureId}?include=runs,batting,localteam,visitorteam`);
  const f = r.data;
  if (!f) return null;

  const innings = (f.runs?.data || []).map(i => ({
    teamId: i.team_id, inning: i.inning, score: i.score ?? 0,
    wickets: i.wickets ?? 0, overs: i.overs ?? 0,
    powerplay1: i.pp1 ?? null,
  }));
  const batting = f.batting?.data || [];
  const fours = batting.reduce((s, b) => s + (b.four_x || 0), 0);
  const sixes = batting.reduce((s, b) => s + (b.six_x || 0), 0);

  return {
    fixtureId: f.id,
    leagueId: f.league_id,
    status: f.status,                       // e.g. '1st Innings', 'Finished'
    startingAt: f.starting_at,
    note: f.note || null,                   // human summary once finished
    localteam: { id: f.localteam_id, name: f.localteam?.data?.name || null },
    visitorteam: { id: f.visitorteam_id, name: f.visitorteam?.data?.name || null },
    totalOversPlayed: f.total_overs_played ?? 0,
    innings,                                // per-innings score/wickets/overs
    totalRuns: innings.reduce((s, i) => s + i.score, 0),
    totalWickets: innings.reduce((s, i) => s + i.wickets, 0),
    fours,
    sixes,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getLiveFixtures, getMatchState, _get: get };

// ── Self-test ───────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    try {
      const live = await getLiveFixtures();
      console.log(`Live fixtures: ${live.length}`);
      // Prove the normaliser on a known covered fixture (IPL: PBKS v RR).
      const sample = live[0]?.id || 69662;
      const st = await getMatchState(sample);
      console.log(`\nMatch state for fixture ${sample}:`);
      console.log(JSON.stringify(st, null, 2));
    } catch (e) {
      console.error('self-test failed:', e.message);
      process.exit(1);
    }
  })();
}
