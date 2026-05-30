'use strict';

/**
 * Side-integrity monitor — the backstop that ensures the P1/P2 runner-order bug can
 * never recur silently. Two checks:
 *   1. DB: any bet whose player_name resolves to the OPPOSITE title player vs its
 *      player_key (a mis-sided bet). Should always be 0.
 *   2. Logs: any time the placement guard BLOCKED a bet for side misalignment in the
 *      last ~2 days (means alignment broke and the guard caught it — investigate).
 *
 * On any hit it sends a Telegram alert (creds from .env) and appends to
 * logs/side-integrity-audit.log. Otherwise logs an OK line. Run via cron.
 *
 *   node scripts/monitorSideIntegrity.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');
const { playerNamesMatch } = require('../src/utils/helpers');

const ROOT = path.join(__dirname, '..');
const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// ── 1. DB scan: mis-sided bets ──────────────────────────────────────────────
const db = new Database(path.join(ROOT, 'data/tennis-bot.db'), { readonly: true });
const rows = db.prepare(`
  SELECT b.bet_id, b.strategy_name, b.player_key, b.player_name, b.side,
         b.settlement_type, b.pnl, b.stake, b.requested_odds, b.actual_odds,
         m.match_name, m.player_a_name, m.player_b_name, m.winner
  FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE b.player_key IN ('A','B') AND b.player_name <> ''
    AND m.player_a_name <> '' AND m.player_b_name <> ''
`).all();
db.close();

const misSided = rows.filter(r => {
  const own = r.player_key === 'A' ? r.player_a_name : r.player_b_name;
  const opp = r.player_key === 'A' ? r.player_b_name : r.player_a_name;
  return !playerNamesMatch(r.player_name, own) && playerNamesMatch(r.player_name, opp);
});

// Settlement-consistency: for settled DRY bets on a market with a known winner,
// the stored outcome must match the recompute from player_key vs winner. Catches
// any mis-settlement (e.g. if the Betfair-winner path ever fails on a match).
const settleMismatch = rows.filter(r => {
  if (!(r.winner === 'A' || r.winner === 'B')) return false;
  if (r.settlement_type !== 'DRY_WIN' && r.settlement_type !== 'DRY_LOSS') return false;
  const won = (r.side === 'BACK' && r.player_key === r.winner) ||
              (r.side === 'LAY'  && r.player_key !== r.winner);
  return (won ? 'DRY_WIN' : 'DRY_LOSS') !== r.settlement_type;
});

// ── 2. Log scan: placement guard fired in the last 2 calendar days ──────────
const d = new Date();
const ymd = t => t.toISOString().slice(0, 10);
const today = ymd(d);
const yday = ymd(new Date(d.getTime() - 86400000));
let blocked = 0;
for (const f of ['bot.log', 'bot.log.1']) {
  try {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const line of txt.split('\n')) {
      if ((line.startsWith(`[${today}`) || line.startsWith(`[${yday}`)) &&
          line.includes('BET BLOCKED — player/side misaligned')) blocked++;
    }
  } catch (_) {}
}

// ── Report + alert ──────────────────────────────────────────────────────────
const LOG = path.join(ROOT, 'logs/side-integrity-audit.log');
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });

if (misSided.length === 0 && blocked === 0 && settleMismatch.length === 0) {
  fs.appendFileSync(LOG, `[${now}] OK  mis-sided=0  blocked=0  settle-mismatch=0\n`);
  console.log(`[${now}] OK — no side/settlement integrity issues.`);
  process.exit(0);
}

const examples = [...misSided, ...settleMismatch].slice(0, 10)
  .map(r => `${r.strategy_name} ${r.match_name} key=${r.player_key} name=${r.player_name} ${r.settlement_type || ''}`).join('\n');
const msg = `⚠️ SIDE/SETTLEMENT INTEGRITY ALERT (${now})\n` +
  `Mis-sided bets in DB: ${misSided.length}\n` +
  `Settlement mismatches: ${settleMismatch.length}\n` +
  `Bets blocked by guard (24-48h): ${blocked}\n` +
  (examples ? `\n${examples}` : '');

fs.appendFileSync(LOG, `[${now}] ALERT mis-sided=${misSided.length} settle-mismatch=${settleMismatch.length} blocked=${blocked}\n${examples}\n`);
console.error(msg);

// Telegram (reuse the bot's creds; same pattern as disk_watchdog.sh)
try {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const grab = k => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
  const token = grab('TELEGRAM_BOT_TOKEN'), chat = grab('TELEGRAM_CHAT_ID');
  if (token && chat) {
    const body = JSON.stringify({ chat_id: chat, text: msg });
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, res => res.resume());
    req.on('error', () => {});
    req.write(body); req.end();
  }
} catch (_) {}
