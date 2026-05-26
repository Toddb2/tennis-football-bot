// Rename Strat7-12 -> Strat*_P1 and Strat*_B -> Strat*_P2 in bets + bet_rejections.
// Also recompute sub_strategy to avoid redundant suffix (Strat7_P1-P1).
const Database = require('/home/bots/tennis-bot/node_modules/better-sqlite3');
const db = new Database('/home/bots/tennis-bot/data/tennis-bot.db');

const renames = [
  ['Strat7',   'Strat7_P1'],
  ['Strat8',   'Strat8_P1'],
  ['Strat9',   'Strat9_P1'],
  ['Strat10',  'Strat10_P1'],
  ['Strat11',  'Strat11_P1'],
  ['Strat12',  'Strat12_P1'],
  ['Strat7_B', 'Strat7_P2'],
  ['Strat8_B', 'Strat8_P2'],
  ['Strat9_B', 'Strat9_P2'],
  ['Strat10_B','Strat10_P2'],
  ['Strat11_B','Strat11_P2'],
  ['Strat12_B','Strat12_P2'],
];

const tx = db.transaction(() => {
  for (const [oldN, newN] of renames) {
    const a = db.prepare(`UPDATE bets           SET strategy_name = ? WHERE strategy_name = ?`).run(newN, oldN);
    const b = db.prepare(`UPDATE bet_rejections SET strategy_name = ? WHERE strategy_name = ?`).run(newN, oldN);
    if (a.changes || b.changes) console.log(`  ${oldN.padEnd(12)} -> ${newN}: bets=${a.changes}, rejections=${b.changes}`);
  }
  // Recompute sub_strategy so we don't end up with Strat7_P1-P1.
  // Rule: if strategy_name already ends in _P1/_P2, sub_strategy = strategy_name.
  //       else sub_strategy = strategy_name + '-' + (player_key=='A' ? 'P1' : 'P2').
  db.prepare(`
    UPDATE bets SET sub_strategy = CASE
      WHEN strategy_name LIKE '%_P1' OR strategy_name LIKE '%_P2' THEN strategy_name
      WHEN strategy_name IS NOT NULL AND player_key IS NOT NULL
        THEN strategy_name || '-' || CASE player_key WHEN 'A' THEN 'P1' ELSE 'P2' END
      ELSE sub_strategy
    END
  `).run();
});
tx();

console.log('\n=== Post-rename distribution ===');
for (const r of db.prepare(`SELECT strategy_name, sub_strategy, COUNT(*) AS n FROM bets GROUP BY strategy_name, sub_strategy ORDER BY strategy_name`).all())
  console.log(' ', r);
