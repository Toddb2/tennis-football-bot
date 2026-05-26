// Apply two corrective fixes flagged by the audit:
//   1. Phase A — 2 RETRO bets where settled_at is microseconds before placed_at.
//      Fix: settled_at = placed_at + 1ms.
//   2. Phase F — 4 markets where final_sets is truncated vs snapshot history.
//      Fix: rebuild final_sets from the last snapshot's sets array; recompute winner.
//      For each, re-derive bet pnl based on the corrected outcome.
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

db.exec(`CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)`);

// ── Phase A fix ────────────────────────────────────────────────────────────
console.log('═══ Phase A — Fix reverse-order timestamps ═══');
const aRows = db.prepare(`SELECT bet_id, placed_at, settled_at FROM bets WHERE settled_at < placed_at`).all();
const aFix = db.prepare(`UPDATE bets SET settled_at = ? WHERE bet_id = ?`);
const aTx = db.transaction(() => {
  for (const r of aRows) {
    const newSettled = new Date(new Date(r.placed_at).getTime() + 1).toISOString();
    aFix.run(newSettled, r.bet_id);
    console.log(`  ${r.bet_id}: ${r.settled_at} → ${newSettled}`);
  }
});
aTx();
console.log(`  Fixed: ${aRows.length}`);

// ── Phase F fix ────────────────────────────────────────────────────────────
console.log('\n═══ Phase F — Rebuild corrupted final_sets from snapshots ═══');
const fMarkets = db.prepare(`
  SELECT m.betfair_market_id, m.match_name, m.final_sets, m.winner,
         (SELECT s.sets FROM market_snapshots s
          WHERE s.betfair_market_id = m.betfair_market_id AND s.sets IS NOT NULL
          ORDER BY s.ts DESC LIMIT 1) AS last_snap_sets
  FROM markets m
  WHERE m.final_sets IS NOT NULL
`).all();

const fixMarket = db.prepare(`UPDATE markets SET final_sets = ?, winner = ? WHERE betfair_market_id = ?`);
const betsForMarket = db.prepare(`SELECT bet_id, side, player_key, COALESCE(actual_odds, requested_odds) AS odds, stake, settlement_type, hedge_odds FROM bets WHERE betfair_market_id = ? AND settled_at IS NOT NULL`);
const fixBet = db.prepare(`UPDATE bets SET pnl = ?, settlement_type = ? WHERE bet_id = ?`);

let marketsFixed = 0, betsRecomputed = 0;
const fTx = db.transaction(() => {
  for (const m of fMarkets) {
    let stored, snap;
    try { stored = JSON.parse(m.final_sets); }    catch (_) { continue; }
    try { snap   = JSON.parse(m.last_snap_sets || '[]'); } catch (_) { continue; }
    if (!Array.isArray(stored) || !Array.isArray(snap)) continue;
    if (stored.length === snap.length) continue;
    if (snap.length === 0) continue;

    // Rebuild final_sets as [[a,b], [a,b], ...] from snap objects
    const newFinal = snap.map(s => [s.playerA, s.playerB]);
    // Compute winner
    let setsA = 0, setsB = 0;
    for (const [a, b] of newFinal) {
      if (a == null || b == null) continue;
      if (a > b) setsA++; else if (b > a) setsB++;
    }
    const newWinner = setsA > setsB ? 'A' : setsB > setsA ? 'B' : null;
    if (!newWinner) continue;

    console.log(`\n  ${m.betfair_market_id} ${m.match_name}`);
    console.log(`    stored: ${JSON.stringify(stored)}  winner=${m.winner}`);
    console.log(`    new:    ${JSON.stringify(newFinal)}  winner=${newWinner}`);
    fixMarket.run(JSON.stringify(newFinal), newWinner, m.betfair_market_id);
    marketsFixed++;

    // Recompute pnl for every settled bet on this market (skip hedged ones — those
    // were resolved at hedge_odds, outcome doesn't determine pnl).
    for (const b of betsForMarket.all(m.betfair_market_id)) {
      if (b.settlement_type === 'TRADE_OUT' || b.hedge_odds != null) continue;
      const betWon = (b.side === 'BACK' && newWinner === b.player_key)
                  || (b.side === 'LAY'  && newWinner !== b.player_key);
      const newPnl = betWon
        ? (b.side === 'BACK' ? +(b.stake * (b.odds - 1)).toFixed(2) : +b.stake.toFixed(2))
        : (b.side === 'BACK' ? -b.stake : -+(b.stake * (b.odds - 1)).toFixed(2));
      const newSettle = b.bet_id.startsWith('DRY') || b.bet_id.startsWith('AIMISS-') || b.bet_id.startsWith('RETRO-')
        ? (betWon ? 'DRY_WIN' : 'DRY_LOSS')
        : b.settlement_type;
      fixBet.run(newPnl, newSettle, b.bet_id);
      console.log(`      bet ${b.bet_id} → pnl ${newPnl}  (${newSettle})`);
      betsRecomputed++;
    }
  }
  db.prepare(`INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)`)
    .run(`final_sets_rebuild_${new Date().toISOString()}`, JSON.stringify({ marketsFixed, betsRecomputed }));
});
fTx();
console.log(`\n  Markets fixed:    ${marketsFixed}`);
console.log(`  Bets re-computed: ${betsRecomputed}`);
