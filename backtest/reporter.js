'use strict';

/**
 * reporter.js
 *
 * Prints a formatted summary table to the console after a backtest run.
 * The HTML report has been replaced by the dashboard — see runner.js.
 */

class Reporter {

  printConsole(summary) {
    console.log('\n' + '═'.repeat(65));
    console.log('  Tennis Bot — Set Strategy Backtest Report');
    console.log('═'.repeat(65));
    console.log(`  Markets analysed:    ${summary.totalMarketsAnalysed}`);
    console.log(`  Bets triggered:      ${summary.totalBetsTriggered}`);
    console.log(`  Complete bets:       ${summary.completeBets}`);
    console.log(`  Win rate:            ${summary.winRate}`);
    const pnlSign = parseFloat(summary.totalPnl) >= 0 ? '+' : '';
    console.log(`  Total P&L (units):   ${pnlSign}${summary.totalPnl}`);
    console.log('─'.repeat(65));
    console.log('  By Strategy:');
    console.log('─'.repeat(65));

    for (const [name, s] of Object.entries(summary.byStrategy)) {
      const wr  = s.bets > 0
        ? ((s.wins / s.bets) * 100).toFixed(0) + '%'
        : 'N/A';
      const pnl = s.totalPnl >= 0
        ? `+${s.totalPnl.toFixed(2)}`
        : s.totalPnl.toFixed(2);
      console.log(
        `  ${name.padEnd(20)} Bets: ${String(s.bets).padStart(3)}` +
        `  Win: ${wr.padStart(5)}  P&L: ${pnl}`
      );
    }

    console.log('═'.repeat(65));
  }
}

module.exports = Reporter;
