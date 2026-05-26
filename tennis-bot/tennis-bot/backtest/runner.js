'use strict';

/**
 * backtest/runner.js
 *
 * CLI entry point for the set-based strategy backtester.
 *
 * Usage:
 *   node backtest/runner.js                          # Betfair historical CSV files
 *   node backtest/runner.js --source db              # real captured SQLite data
 *   node backtest/runner.js --from 2024-01-01 --to 2024-03-31
 *   node backtest/runner.js --strategy Strategy1
 *   node backtest/runner.js --notes "Tighter odds filter on S1"
 *
 * npm shortcut:
 *   npm run backtest
 */

const DataLoader        = require('./dataLoader');
const SetDetector       = require('./setDetector');
const StrategyReplayer  = require('./strategyReplayer');
const Reporter          = require('./reporter');
const backtestDb        = require('../src/dashboard/backtestDb');

async function run() {
  const args = parseArgs(process.argv.slice(2));

  const sourceDb = args.source === 'db';

  console.log('\n🎾 Tennis Bot — Set Strategy Backtester');
  console.log('─'.repeat(42));
  console.log(`Source:  ${sourceDb ? 'SQLite captured data' : 'Historical CSV files'}`);
  if (args.from || args.to) console.log(`Period:  ${args.from || 'start'} → ${args.to || 'now'}`);
  if (args.strategy)        console.log(`Strategy filter: ${args.strategy}`);

  const replayer = new StrategyReplayer();
  const reporter = new Reporter();
  let processed  = 0;

  if (sourceDb) {
    // ── Mode: replay against real SQLite snapshots ──────────────────────────
    const SnapshotLoader = require('./snapshotLoader');
    let loader;
    try { loader = new SnapshotLoader(); } catch (err) { console.error('\n❌ ' + err.message); process.exit(1); }

    const summary = loader.getDataSummary();
    console.log(`\nDatabase: ${summary.completedMarkets} completed markets, ${summary.totalSnapshots} snapshots`);
    if (summary.earliest) console.log(`Range:    ${summary.earliest?.slice(0,10)} → ${summary.latest?.slice(0,10)}`);
    console.log('');

    const markets = loader.loadMarkets({ from: args.from, to: args.to });
    loader.close();

    if (!markets.length) {
      console.log('❌  No completed markets found for this date range.');
      console.log('   The bot must have run and captured data first.');
      process.exit(1);
    }

    console.log(`Replaying ${markets.length} market(s)...\n`);

    for (const market of markets) {
      if (market.totalMatched < 50_000) continue;
      if (!market.setCompletions.length) continue;

      // Adapt snapshot format to what StrategyReplayer expects
      const runnerA = {
        selectionId:  null,
        priceTimeline: market.snapshots.map(s => ({ t: s.ts, price: s.player_a_back, inPlay: true })),
      };
      const runnerB = {
        selectionId:  null,
        priceTimeline: market.snapshots.map(s => ({ t: s.ts, price: s.player_b_back, inPlay: true })),
      };

      // Inject pre-match odds directly — no need to infer from timeline
      runnerA._preMatchPrice = market.preMatchOddsA;
      runnerB._preMatchPrice = market.preMatchOddsB;

      // Build a market object compatible with StrategyReplayer
      const mkt = {
        marketId:      market.marketId,
        matchName:     market.matchName,
        surface:       market.surface,
        tournament:    market.tournament,
        totalMatched:  market.totalMatched,
        winnerSelId:   null,
        runners:       new Map([['A', runnerA], ['B', runnerB]]),
        // Enrich set events with exact score data
        _exactSetCompletions: market.setCompletions,
      };

      replayer.replayMarket(mkt, market.setCompletions, runnerA, runnerB);
      processed++;
    }

  } else {
    // ── Mode: historical CSV files (original) ───────────────────────────────
    const loader   = new DataLoader();
    const detector = new SetDetector();

    console.log(`\nLoading historical files from data/historical/...`);
    const files = loader.listAvailableFiles(args.from, args.to);

    if (!files.length) {
      console.log('\n❌  No historical files found in data/historical/');
      console.log('\nTo get data:');
      console.log('  1. Go to https://historicdata.betfair.com');
      console.log('  2. Log in with your Betfair account');
      console.log('  3. Select Sport: Tennis, Market Type: Match Odds');
      console.log('  4. Download a date range and place .csv files in data/historical/');
      process.exit(1);
    }

    console.log(`Found ${files.length} file(s)\n`);

    for (const file of files) {
      try {
        const markets = await loader.loadMarket(file.path);
        for (const market of markets) {
          const runners = [...market.runners.values()];
          if (runners.length !== 2) continue;
          const [runnerA, runnerB] = runners;
          const setEvents = detector.detectSets(market);
          if (!setEvents.length) continue;
          replayer.replayMarket(market, setEvents, runnerA, runnerB);
          processed++;
        }
      } catch (err) {
        console.warn(`  ⚠  Skipped ${file.filename}: ${err.message}`);
      }
    }
  }

  console.log(`Processed ${processed} market(s)\n`);

  const summary = replayer.getSummary();

  // Print console table
  reporter.printConsole(summary);

  // Build per-strategy breakdown array for DB
  const strategyBreakdown = Object.entries(summary.byStrategy).map(([name, s]) => ({
    strategyName: name,
    betsPlaced:   s.bets,
    betsWon:      s.wins,
    totalPnl:     parseFloat(s.totalPnl.toFixed(3)),
    avgOdds:      s.avgOdds ?? null,
    incomplete:   s.incomplete,
  }));

  // Build individual bets array (triggered only)
  const bets = replayer.results
    .filter(r => r.triggered)
    .map(r => ({
      strategy:     r.strategy,
      marketId:     r.marketId,
      side:         r.side    ?? null,
      entryPrice:   r.entryPrice ?? null,
      exitPrice:    r.exitPrice  ?? null,
      pnl:          r.pnl       ?? null,
      confidence:   r.confidence ?? null,
      exitReason:   r.exitReason ?? null,
      preMatchA:    r.preMatchA  ?? null,
      preMatchB:    r.preMatchB  ?? null,
      set1ChangePct: r.set1ChangePct ?? null,
    }));

  // Compute overall ROI (total P&L / bets placed × 100)
  const betsPlaced = parseInt(summary.totalBetsTriggered, 10);
  const totalPnl   = parseFloat(summary.totalPnl);
  const roi        = betsPlaced > 0
    ? parseFloat(((totalPnl / betsPlaced) * 100).toFixed(2))
    : 0;

  // Avg entry odds across all triggered bets
  const allOdds = bets.filter(b => b.entryPrice).map(b => b.entryPrice);
  const avgOdds = allOdds.length
    ? parseFloat((allOdds.reduce((a, b) => a + b, 0) / allOdds.length).toFixed(2))
    : null;

  // Save to SQLite
  try {
    const saved = backtestDb.insertRun({
      ranAt:              new Date().toISOString(),
      fromDate:           args.from  || null,
      toDate:             args.to    || null,
      systemName:         args.strategy || 'All',
      markets:            processed,
      betsPlaced,
      betsWon:            parseInt(summary.wins, 10),
      totalPnl,
      roi,
      avgOdds,
      notes:              args.notes || null,
      strategyBreakdown,
      bets,
    });

    console.log(`\n✅  Results saved  (run ID: ${saved.id})`);
    console.log(`\n📊  View in dashboard → http://localhost:${process.env.DASHBOARD_PORT || 3000}`);
    console.log(`    Open the Backtests tab and click on this run to see the full breakdown.\n`);
  } catch (err) {
    console.error('\n⚠  Could not save to SQLite:', err.message);
    console.error('   Make sure better-sqlite3 is installed: npm install\n');
  }
}

function parseArgs(args) {
  const result = { from: null, to: null, strategy: null, notes: null, source: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from')     result.from     = args[i + 1];
    if (args[i] === '--to')       result.to       = args[i + 1];
    if (args[i] === '--strategy') result.strategy = args[i + 1];
    if (args[i] === '--notes')    result.notes    = args[i + 1];
    if (args[i] === '--source')   result.source   = args[i + 1];  // 'db' | 'csv' (default csv)
  }
  return result;
}

run().catch(err => {
  console.error('\n❌  Backtester error:', err.message);
  process.exit(1);
});
