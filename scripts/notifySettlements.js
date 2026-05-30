'use strict';

/**
 * Settlement notifier — Telegrams you each time a match with bets settles, with the
 * result, each bet's outcome/pnl, and a built-in correctness check (side + settlement),
 * so you can track bets settling (and see the guards working) without SSH/Claude.
 *
 * Server-side; runs via cron, independent of any interactive session. State in
 * data/settle-notify-state.json tracks the last settled_at processed; the first run
 * only sets the baseline (no backlog spam).
 *
 *   node scripts/notifySettlements.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');
const { playerNamesMatch } = require('../src/utils/helpers');

const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'data/settle-notify-state.json');

function telegram(text) {
  const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const grab = k => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
  const token = grab('TELEGRAM_BOT_TOKEN'), chat = grab('TELEGRAM_CHAT_ID');
  if (!token || !chat) return Promise.resolve();
  const body = JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true });
  return new Promise(res => {
    const req = https.request({
      hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, r => { r.resume(); r.on('end', res); });
    req.on('error', res); req.on('timeout', () => { req.destroy(); res(); });
    req.write(body); req.end();
  });
}

const db = new Database(path.join(ROOT, 'data/tennis-bot.db'), { readonly: true });

let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}

// Newest settled_at in the DB right now.
const maxRow = db.prepare(`SELECT MAX(settled_at) AS m FROM bets WHERE settled_at IS NOT NULL`).get();
const newMax = maxRow?.m || null;

// First run: just set the baseline, don't blast historical settlements.
if (!state.lastSettledAt) {
  fs.writeFileSync(STATE, JSON.stringify({ lastSettledAt: newMax || new Date().toISOString() }, null, 2));
  console.log('Baseline set, no backlog sent.');
  db.close(); process.exit(0);
}

const rows = db.prepare(`
  SELECT b.strategy_name, b.player_key, b.player_name, b.side, b.settlement_type, b.pnl,
         b.settled_at, b.betfair_market_id,
         m.match_name, m.player_a_name, m.player_b_name, m.winner
  FROM bets b JOIN markets m ON b.betfair_market_id = m.betfair_market_id
  WHERE b.settled_at > ? AND b.settlement_type IN ('DRY_WIN','DRY_LOSS')
  ORDER BY b.settled_at
`).all(state.lastSettledAt);

db.close();

if (!rows.length) { console.log('No new settlements.'); process.exit(0); }

// Group by market.
const byMarket = new Map();
for (const r of rows) {
  if (!byMarket.has(r.betfair_market_id)) byMarket.set(r.betfair_market_id, []);
  byMarket.get(r.betfair_market_id).push(r);
}

(async () => {
  for (const [, bets] of byMarket) {
    const m = bets[0];
    const winnerName = m.winner === 'A' ? m.player_a_name : m.winner === 'B' ? m.player_b_name : '?';
    const lines = bets.map(b => {
      const won = b.settlement_type === 'DRY_WIN';
      // Correctness: side not reversed + settlement matches recompute.
      const ownTitle = b.player_key === 'A' ? m.player_a_name : m.player_b_name;
      const oppTitle = b.player_key === 'A' ? m.player_b_name : m.player_a_name;
      const sideOk = !(playerNamesMatch(b.player_name, oppTitle) && !playerNamesMatch(b.player_name, ownTitle));
      const expWon = (b.side === 'BACK' && b.player_key === m.winner) || (b.side === 'LAY' && b.player_key !== m.winner);
      const setOk = !(m.winner === 'A' || m.winner === 'B') || (expWon ? 'DRY_WIN' : 'DRY_LOSS') === b.settlement_type;
      const flag = (sideOk && setOk) ? '✓' : '⚠️CHECK';
      const pnl = (b.pnl >= 0 ? '+' : '') + (b.pnl ?? 0).toFixed(2);
      return `  • ${b.strategy_name}  ${b.player_name}  ${won ? 'WON' : 'LOST'}  ${pnl}  ${flag}`;
    });
    const msg = `🎾 ${m.match_name} — winner: ${winnerName}\n${lines.join('\n')}`;
    await telegram(msg);
    console.log(msg);
  }
  fs.writeFileSync(STATE, JSON.stringify({ lastSettledAt: newMax }, null, 2));
})();
