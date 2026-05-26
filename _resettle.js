'use strict';
// One-shot: settle pending football bets using SportMonks /fixtures/date.
// Parses the actual SM response shape (score.participant + s.participant_id).
// No simulation fallback — unmatched bets stay pending.

require('dotenv').config({ path: '/home/bots/telegram-listener/.env' });
const axios = require('axios');
const fs    = require('fs');

const BETS_PATH    = '/home/bots/telegram-listener/bets.json';
const RESULTS_PATH = '/home/bots/telegram-listener/sportmonks_results.json';
const SM_BASE      = 'https://api.sportmonks.com/v3/football';
const apiKey       = process.env.SPORTMONKS_API_KEY;
if (!apiKey) { console.error('No SPORTMONKS_API_KEY'); process.exit(1); }

const FINISHED_STATES = new Set([5, 7, 8, 10, 14, 17]);

function normaliseTeam(name) {
    return (name || '').toLowerCase()
        .replace(/\bfc\b|\baf\b|\bsc\b|\bac\b|\bfk\b|\bnk\b|\bsk\b|\bif\b|\bbk\b|\bcf\b/g, '')
        .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
function teamsMatch(a, b, threshold = 0.5) {
    const na = normaliseTeam(a), nb = normaliseTeam(b);
    if (!na || !nb) return false;
    if (na === nb || nb.includes(na) || na.includes(nb)) return true;
    const wa = na.split(' ').filter(w => w.length > 2);
    const wb = nb.split(' ').filter(w => w.length > 2);
    if (!wa.length) return false;
    return wa.filter(w => wb.includes(w)).length / wa.length >= threshold;
}

async function fetchFixturesForDate(date) {
    const out = [];
    let page = 1;
    while (true) {
        const r = await axios.get(`${SM_BASE}/fixtures/date/${date}`, {
            params: { api_token: apiKey, include: 'scores;participants', per_page: 50, page },
            timeout: 15000,
        });
        out.push(...(r.data?.data || []));
        if (!r.data?.pagination?.has_more) break;
        if (++page > 10) break;
    }
    return out;
}

// Parse final goals from a SM fixture. The SM shape:
//   - participants[].meta.location = 'home'|'away', participants[].id
//   - scores[].participant_id, scores[].score.goals,
//     scores[].score.participant = 'home'|'away',
//     scores[].description (we use 'CURRENT' or 'FT' as final-state markers)
function parseFinalScore(f) {
    if (!FINISHED_STATES.has(f.state_id)) return null;
    let homeId = null, awayId = null;
    for (const p of (f.participants || [])) {
        if (p.meta?.location === 'home') homeId = p.id;
        if (p.meta?.location === 'away') awayId = p.id;
    }
    if (homeId == null || awayId == null) return null;

    // Prefer the 'CURRENT' total (which == FT once state is finished). If
    // missing, fall back to summing 1ST_HALF + 2ND_HALF.
    let homeG = null, awayG = null;
    for (const s of (f.scores || [])) {
        if (s.description !== 'CURRENT') continue;
        const loc = s.score?.participant;
        const pid = s.participant_id;
        if (loc === 'home' || pid === homeId) homeG = s.score?.goals ?? homeG;
        if (loc === 'away' || pid === awayId) awayG = s.score?.goals ?? awayG;
    }
    if (homeG == null || awayG == null) {
        // Fallback: sum halves
        let hH = 0, hA = 0, h2 = 0, a2 = 0, sawH = false, saw2 = false;
        for (const s of (f.scores || [])) {
            const loc = s.score?.participant;
            const pid = s.participant_id;
            const isHome = loc === 'home' || pid === homeId;
            const isAway = loc === 'away' || pid === awayId;
            if (s.description === '1ST_HALF') {
                sawH = true;
                if (isHome) hH = s.score?.goals ?? hH;
                if (isAway) hA = s.score?.goals ?? hA;
            } else if (s.description === '2ND_HALF') {
                saw2 = true;
                if (isHome) h2 = s.score?.goals ?? h2;
                if (isAway) a2 = s.score?.goals ?? a2;
            }
        }
        if (sawH && saw2) { homeG = hH + h2; awayG = hA + a2; }
    }
    return (homeG != null && awayG != null) ? { homeG, awayG } : null;
}

function loadResults() { try { return JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8')); } catch { return {}; } }

(async () => {
    const bets = JSON.parse(fs.readFileSync(BETS_PATH, 'utf8'));
    const pending = bets.filter(b => b.result === 'pending' && b.placedAt && b.match);
    console.log(`Pending bets with match name: ${pending.length}`);

    // Dates to query: the date(s) the matches actually kicked off (startDate or placedAt fallback).
    const dateSet = new Set();
    for (const b of pending) {
        const d = b.startDate ? b.startDate.slice(0, 10).replace(/ .*/, '') : b.placedAt.slice(0, 10);
        dateSet.add(d);
    }
    const dates = [...dateSet].sort();
    console.log(`Querying SM for dates: ${dates.join(', ')}`);

    const results = loadResults();
    let added = 0, parsedFailed = 0;
    for (const d of dates) {
        let fx = [];
        try { fx = await fetchFixturesForDate(d); }
        catch (err) { console.error(`  ${d}: fetch error ${err.message}`); continue; }
        const finished = fx.filter(f => FINISHED_STATES.has(f.state_id));
        console.log(`  ${d}: ${fx.length} total / ${finished.length} finished`);
        for (const f of finished) {
            const score = parseFinalScore(f);
            if (!score) { parsedFailed++; continue; }
            const home = (f.participants || []).find(p => p.meta?.location === 'home');
            const away = (f.participants || []).find(p => p.meta?.location === 'away');
            if (!home || !away) continue;
            results[String(f.id)] = {
                fixtureId: f.id, teamHome: home.name, teamAway: away.name,
                goalsHome: score.homeG, goalsAway: score.awayG,
                totalGoals: score.homeG + score.awayG,
                finishedAt: f.starting_at || new Date().toISOString(),
                playedAt: f.starting_at || null,
            };
            added++;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    console.log(`+${added} results cached (parseFinalScore failures: ${parsedFailed}). Total: ${Object.keys(results).length}.`);

    // Settle pending bets against the refreshed results file
    let settled = 0, unmatched = 0;
    const unmatchedSamples = [];
    for (const b of pending) {
        const parts = (b.match || '').split(/ v /i).map(s => s.trim());
        if (parts.length !== 2) { unmatched++; continue; }
        const [bA, bB] = parts;
        const dateOfBet = b.startDate ? b.startDate.slice(0, 10).replace(/ .*/, '') : b.placedAt.slice(0, 10);

        let found = null;
        for (const r of Object.values(results)) {
            // Constrain candidate matches to the same playing day to avoid
            // West Ham v Arsenal (May 10) joining to Brentford v West Ham (May 9).
            const rDay = (r.playedAt || r.finishedAt || '').slice(0, 10);
            if (rDay && rDay !== dateOfBet) continue;
            const aH = teamsMatch(bA, r.teamHome), bAw = teamsMatch(bB, r.teamAway);
            const aA = teamsMatch(bA, r.teamAway), bH = teamsMatch(bB, r.teamHome);
            if ((aH && bAw) || (aA && bH)) { found = { ...r, betSideIsHome: aH }; break; }
        }
        if (!found) {
            unmatched++;
            if (unmatchedSamples.length < 10) unmatchedSamples.push(`${b.match} (${dateOfBet}) [${b.strategy}]`);
            continue;
        }

        const total = (found.goalsHome || 0) + (found.goalsAway || 0);
        const ouVal = parseFloat(b.overUnderValue);
        const isWin = total > ouVal;
        b.finalGoalsA = found.betSideIsHome ? found.goalsHome : found.goalsAway;
        b.finalGoalsB = found.betSideIsHome ? found.goalsAway : found.goalsHome;
        b.finalGoals  = total;
        b.result      = isWin ? 'won' : 'lost';
        const odds    = b.overOdds || 2;
        b.avePoints   = isWin ? +(odds - 1).toFixed(2) : -1;
        b.resultFetchedAt  = new Date().toISOString();
        b.settlementSource = 'sportmonks_backfill';
        settled++;
    }

    fs.writeFileSync(BETS_PATH, JSON.stringify(bets, null, 2));
    console.log(`Settled: ${settled}.  Unmatched: ${unmatched} (left pending).`);
    if (unmatchedSamples.length) {
        console.log('Sample unmatched:');
        unmatchedSamples.forEach(s => console.log('  ', s));
    }
})().catch(e => { console.error(e); process.exit(1); });
