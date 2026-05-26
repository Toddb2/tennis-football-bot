# Tennis Bot — Phase 14 Specification
# Set-Based Strategy Backtester

> **For Claude Code**: Phase 13 is complete. This phase adds a backtester
> specifically designed for the 6 set-based strategies built in Phase 13.
> It uses Betfair historical price data to replay what each strategy would
> have done historically.
>
> Build in order: 14A → 14B → 14C → 14D
> Stop for review after each section.

---

## Overview

The original Phase 10 backtester was designed for continuous signals.
Phase 13 replaced that with event-triggered set strategies. This backtester
is rebuilt from scratch to match the new architecture.

**How it works:**
1. Load historical Betfair price files for tennis MATCH_ODDS markets
2. Replay the price stream chronologically
3. Detect when Set 1 completes by watching for price patterns
4. Check if any of the 6 strategies would have fired
5. Record entry price, then fast-forward to check exit conditions
6. Calculate P&L for each bet
7. Generate a report broken down by strategy

**What makes this different from Phase 10:**
- Strategies fire once per match (at set completion), not continuously
- No serve stats needed — strategies are purely price and score based
- Pre-match price is available in the historical data
- Results are directly comparable to Dad's real BF Bot Manager results

---

## Where to Get Historical Data

Betfair historical data is available at:
**https://historicdata.betfair.com**

1. Log in with your Betfair account
2. Select **Sport**: Tennis
3. Select **Market Type**: Match Odds
4. Select **Plan**: Basic (free) or Advanced (paid, more granular)
5. Download by date range — start with 1-2 weeks to test

**File format**: Each download is a `.bz2` compressed file containing
one `.csv` or BSP streaming file per market.

**Store files in**: `data/historical/`

The Basic free plan gives you end-of-day data (1 price per minute).
The Advanced plan gives you full tick data (every price movement).
Start with Basic — it's enough to identify set completion moments
and entry/exit prices.

---

## Phase 14A — Historical Data Loader

### New files

```
backtest/
├── dataLoader.js       # Loads and parses Betfair historical files
├── setDetector.js      # Detects set completion from price movements
├── strategyReplayer.js # Replays strategies against historical data
├── reporter.js         # Generates reports
└── runner.js           # CLI entry point
```

---

### backtest/dataLoader.js

```javascript
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const HISTORICAL_DIR = path.join(__dirname, '../data/historical')

class DataLoader {

  // Scan historical directory and return list of available market files
  listAvailableFiles(fromDate, toDate) {
    if (!fs.existsSync(HISTORICAL_DIR)) {
      fs.mkdirSync(HISTORICAL_DIR, { recursive: true })
      return []
    }

    const files = fs.readdirSync(HISTORICAL_DIR)
      .filter(f => f.endsWith('.csv') || f.endsWith('.bz2') || f.endsWith('.json'))

    return files.map(f => ({
      filename: f,
      path: path.join(HISTORICAL_DIR, f)
    }))
  }

  // Load and parse a single market file
  // Returns array of price snapshots in chronological order
  async loadMarket(filePath) {
    const ext = path.extname(filePath)

    if (ext === '.bz2') {
      return this._loadBz2(filePath)
    } else if (ext === '.csv') {
      return this._loadCsv(filePath)
    } else if (ext === '.json') {
      return this._loadJson(filePath)
    }

    throw new Error(`Unsupported file format: ${ext}`)
  }

  // Parse Betfair's standard CSV historical format
  // Columns: MarketId, InplayDate, SelectionId, SelectionName,
  //          LastPriceTraded, BSP, MaxPrice, MinPrice, ...
  async _loadCsv(filePath) {
    const snapshots = []
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    })

    let headers = null
    for await (const line of rl) {
      if (!headers) {
        headers = line.split(',').map(h => h.trim())
        continue
      }

      const parts = line.split(',')
      const row = {}
      headers.forEach((h, i) => { row[h] = parts[i]?.trim() })

      snapshots.push({
        timestamp: new Date(row['PublishedDate'] || row['DATE_OF_MARKET']).getTime(),
        marketId: row['MARKET_ID'] || row['MarketId'],
        selectionId: row['SELECTION_ID'] || row['SelectionId'],
        selectionName: row['SELECTION_NAME'] || row['SelectionName'],
        lastTradedPrice: parseFloat(row['LAST_PRICE_TRADED'] || row['LastPriceTraded']) || null,
        bsp: parseFloat(row['BSP']) || null,
        inPlay: row['IN_PLAY'] === 'TRUE' || row['InPlay'] === 'Yes'
      })
    }

    return this._groupByMarket(snapshots)
  }

  // Group price snapshots by marketId → selectionId
  _groupByMarket(snapshots) {
    const markets = new Map()

    for (const snap of snapshots) {
      if (!markets.has(snap.marketId)) {
        markets.set(snap.marketId, {
          marketId: snap.marketId,
          runners: new Map(),
          timeline: []
        })
      }

      const market = markets.get(snap.marketId)

      if (!market.runners.has(snap.selectionId)) {
        market.runners.set(snap.selectionId, {
          selectionId: snap.selectionId,
          name: snap.selectionName,
          bsp: snap.bsp,
          priceHistory: []
        })
      }

      market.runners.get(snap.selectionId).priceHistory.push({
        timestamp: snap.timestamp,
        price: snap.lastTradedPrice,
        inPlay: snap.inPlay
      })

      market.timeline.push({
        timestamp: snap.timestamp,
        inPlay: snap.inPlay
      })
    }

    // Sort each runner's price history by timestamp
    for (const market of markets.values()) {
      for (const runner of market.runners.values()) {
        runner.priceHistory.sort((a, b) => a.timestamp - b.timestamp)
      }
      market.timeline.sort((a, b) => a.timestamp - b.timestamp)
    }

    return [...markets.values()]
  }
}

module.exports = DataLoader
```

---

## Phase 14B — Set Detector

Detecting when a set completes from price data alone requires
reading the price movement patterns. When a set completes:
- The winning player's price drops sharply
- The losing player's price spikes sharply
- The magnitude depends on the score

### backtest/setDetector.js

```javascript
class SetDetector {

  constructor() {
    // Minimum price movement to consider a "set completed" event
    // A set win typically moves the favourite by 15-40%
    this.MIN_PRICE_JUMP_PCT = 15
    this.DETECTION_WINDOW_MS = 60 * 1000  // Look within 1-minute windows
  }

  // Analyse a market's price history to find likely set completion moments
  // Returns array of detected set events with estimated timing and prices
  detectSets(market) {
    const runners = [...market.runners.values()]
    if (runners.length !== 2) return []  // Skip non-standard markets

    const [runnerA, runnerB] = runners
    const events = []

    // Combine both runners' price histories into a unified timeline
    const timeline = this._buildUnifiedTimeline(runnerA, runnerB)

    // Find in-play start
    const inPlayStart = timeline.find(t => t.inPlay)
    if (!inPlayStart) return []

    // Look for significant price jumps after in-play starts
    for (let i = 1; i < timeline.length; i++) {
      const prev = timeline[i - 1]
      const curr = timeline[i]

      if (!curr.inPlay) continue

      const priceA_prev = prev.priceA
      const priceA_curr = curr.priceA
      if (!priceA_prev || !priceA_curr) continue

      const changePct = Math.abs((priceA_curr - priceA_prev) / priceA_prev) * 100

      if (changePct >= this.MIN_PRICE_JUMP_PCT) {
        const aWon = priceA_curr < priceA_prev

        events.push({
          timestamp: curr.timestamp,
          estimatedSetNumber: events.length + 1,
          winnerEstimate: aWon ? 'playerA' : 'playerB',
          priceA_before: priceA_prev,
          priceA_after: priceA_curr,
          priceB_before: prev.priceB,
          priceB_after: curr.priceB,
          changePct: changePct.toFixed(1),
          confidence: changePct > 30 ? 'high' : 'medium'
        })
      }
    }

    return events
  }

  // Get pre-match price (last price before in-play started)
  getPreMatchPrice(runner) {
    const preMatchPrices = runner.priceHistory.filter(p => !p.inPlay && p.price)
    if (preMatchPrices.length === 0) return null
    return preMatchPrices[preMatchPrices.length - 1].price
  }

  _buildUnifiedTimeline(runnerA, runnerB) {
    const allTimestamps = new Set([
      ...runnerA.priceHistory.map(p => p.timestamp),
      ...runnerB.priceHistory.map(p => p.timestamp)
    ])

    const sorted = [...allTimestamps].sort()
    return sorted.map(ts => {
      const a = runnerA.priceHistory.find(p => p.timestamp === ts)
      const b = runnerB.priceHistory.find(p => p.timestamp === ts)
      return {
        timestamp: ts,
        inPlay: a?.inPlay || b?.inPlay || false,
        priceA: a?.price || null,
        priceB: b?.price || null
      }
    })
  }
}

module.exports = SetDetector
```

---

## Phase 14C — Strategy Replayer

The core of the backtester. For each detected set completion event,
checks if any of the 6 strategies would have fired and calculates P&L.

### backtest/strategyReplayer.js

```javascript
const path = require('path')
const fs = require('fs')

const STRATEGIES_PATH = path.join(__dirname, '../config/strategies.json')

class StrategyReplayer {

  constructor() {
    const config = JSON.parse(fs.readFileSync(STRATEGIES_PATH))
    this.strategies = config.systems || []
    this.results = []
  }

  // Replay all strategies against a single market
  replayMarket(market, setEvents, runnerA, runnerB) {
    if (setEvents.length === 0) return []

    const preMatchA = this._getPreMatchPrice(runnerA)
    const preMatchB = this._getPreMatchPrice(runnerB)

    const marketResults = []

    // Only evaluate Set 1 completion (all 6 strategies trigger on Set 1)
    const set1Event = setEvents[0]
    if (!set1Event) return []

    for (const strategy of this.strategies) {
      if (!strategy.trigger || strategy.trigger.setNumber !== 1) continue

      const result = this._evaluateStrategy(
        strategy,
        set1Event,
        setEvents,
        preMatchA,
        preMatchB,
        runnerA,
        runnerB,
        market.marketId
      )

      if (result) {
        marketResults.push(result)
        this.results.push(result)
      }
    }

    return marketResults
  }

  _evaluateStrategy(strategy, set1Event, allSetEvents, preMatchA, preMatchB, runnerA, runnerB, marketId) {
    const trigger = strategy.trigger
    const entry = strategy.entry

    // Check winner matches
    if (trigger.winner && trigger.winner !== set1Event.winnerEstimate) return null

    // Check set score validity (tiebreak strategies)
    if (trigger.score) {
      const isTiebreak = set1Event.changePct < 25  // Tiebreaks cause smaller price moves
      if (trigger.score.includes('7-6') && !isTiebreak) return null
      if (!trigger.score.includes('7-6') && isTiebreak) return null
    }

    // Check valid scores for comeback strategies
    if (trigger.validScores) {
      // For basic data we estimate: if price move is >35% it was a convincing set win
      // smaller moves suggest closer set like 6-4 or 7-5
      const convincingWin = parseFloat(set1Event.changePct) > 35
      // 6-7 or 4-6 or 5-7 scores cause moderate moves (20-35%)
      const moderateWin = parseFloat(set1Event.changePct) >= 20 && parseFloat(set1Event.changePct) <= 35
      if (!moderateWin && !convincingWin) return null
    }

    // Check pre-match odds
    if (trigger.preMatchOddsPlayerA) {
      if (!preMatchA) return null
      if (preMatchA < trigger.preMatchOddsPlayerA.min || preMatchA > trigger.preMatchOddsPlayerA.max) return null
    }
    if (trigger.preMatchOddsPlayerB) {
      if (!preMatchB) return null
      if (preMatchB < trigger.preMatchOddsPlayerB.min || preMatchB > trigger.preMatchOddsPlayerB.max) return null
    }

    // Get entry price (price immediately after set 1 completes)
    const entryPlayer = entry.player
    const entryPriceRaw = entryPlayer === 'playerA'
      ? set1Event.priceA_after
      : set1Event.priceB_after

    if (!entryPriceRaw) return null

    // Check entry price range
    if (entryPriceRaw < entry.minOdds || entryPriceRaw > entry.maxOdds) {
      return {
        marketId,
        strategy: strategy.name,
        triggered: false,
        skipReason: `Entry price ${entryPriceRaw} outside range ${entry.minOdds}-${entry.maxOdds}`,
        preMatchA,
        preMatchB
      }
    }

    // Calculate P&L based on exit type
    const exitType = strategy.exit?.type || 'none'
    let pnl = null
    let exitPrice = null
    let exitReason = null

    if (exitType === 'hedge') {
      // Find set 2 completion event
      const set2Event = allSetEvents[1]
      if (!set2Event) {
        pnl = null
        exitReason = 'Match not complete in data'
      } else {
        const hedgeCondition = strategy.exit.condition
        const set2WinnerA = set2Event.winnerEstimate === 'playerA'
        const shouldHedge = hedgeCondition.includes('playerA') ? set2WinnerA : !set2WinnerA

        if (shouldHedge) {
          // Hedge out — profit on both outcomes
          // Approximate green-up P&L: entry at X, hedge at Y
          exitPrice = entry.player === 'playerA'
            ? set2Event.priceA_after
            : set2Event.priceB_after

          if (exitPrice) {
            if (entry.side === 'BACK') {
              // Back at entryPrice, lay at exitPrice (lower = winning)
              pnl = exitPrice < entryPriceRaw
                ? ((entryPriceRaw / exitPrice) - 1)  // approximate green-up profit
                : -0.1  // price went wrong way, small loss on hedge
            } else {
              // Lay at entryPrice, back at exitPrice (higher = winning)
              pnl = exitPrice > entryPriceRaw
                ? ((exitPrice / entryPriceRaw) - 1)
                : -0.1
            }
          }
          exitReason = `Hedged out after Set 2 (${hedgeCondition})`
        } else {
          // Condition not met — lose stake
          pnl = -1.0
          exitReason = `Set 2 went wrong way — full loss`
        }
      }
    } else if (exitType === 'none') {
      // Let it run — check final price
      const lastEvent = allSetEvents[allSetEvents.length - 1]
      if (lastEvent) {
        const finalPrice = entry.player === 'playerA'
          ? lastEvent.priceA_after
          : lastEvent.priceB_after

        if (finalPrice) {
          pnl = entry.side === 'BACK'
            ? (finalPrice < 1.05 ? entryPriceRaw - 1 : -1.0)  // won or lost
            : (finalPrice > 5.0 ? 1.0 / (entryPriceRaw - 1) : -1.0)
        }
      }
      exitReason = 'Let run to match completion'
    }

    return {
      marketId,
      strategy: strategy.name,
      triggered: true,
      side: entry.side,
      player: entry.player,
      entryPrice: entryPriceRaw,
      exitPrice,
      pnl: pnl ? parseFloat(pnl.toFixed(3)) : null,
      exitReason,
      preMatchA,
      preMatchB,
      set1WinnerEstimate: set1Event.winnerEstimate,
      set1ChangePct: set1Event.changePct,
      confidence: set1Event.confidence
    }
  }

  _getPreMatchPrice(runner) {
    const prePlay = runner.priceHistory.filter(p => !p.inPlay && p.price)
    if (prePlay.length === 0) return null
    return prePlay[prePlay.length - 1].price
  }

  getSummary() {
    const triggered = this.results.filter(r => r.triggered)
    const withPnl = triggered.filter(r => r.pnl !== null)
    const wins = withPnl.filter(r => r.pnl > 0)

    const byStrategy = {}
    for (const r of triggered) {
      if (!byStrategy[r.strategy]) {
        byStrategy[r.strategy] = { bets: 0, wins: 0, totalPnl: 0, incomplete: 0 }
      }
      byStrategy[r.strategy].bets++
      if (r.pnl > 0) byStrategy[r.strategy].wins++
      if (r.pnl !== null) byStrategy[r.strategy].totalPnl += r.pnl
      if (r.pnl === null) byStrategy[r.strategy].incomplete++
    }

    return {
      totalMarketsAnalysed: this.results.length,
      totalBetsTriggered: triggered.length,
      completeBets: withPnl.length,
      wins: wins.length,
      winRate: withPnl.length > 0
        ? ((wins.length / withPnl.length) * 100).toFixed(1) + '%'
        : 'N/A',
      totalPnl: withPnl.reduce((s, r) => s + r.pnl, 0).toFixed(2),
      byStrategy
    }
  }
}

module.exports = StrategyReplayer
```

---

## Phase 14D — Reporter + Runner

### backtest/reporter.js

Generates two outputs:
1. Console summary table
2. HTML report saved to `backtest/report.html`

```javascript
const fs = require('fs')
const path = require('path')

class Reporter {

  generate(summary, allResults, options = {}) {
    this._printConsole(summary)
    this._saveHtml(summary, allResults, options)
  }

  _printConsole(summary) {
    console.log('\n' + '═'.repeat(65))
    console.log('  Tennis Bot — Set Strategy Backtest Report')
    console.log('═'.repeat(65))
    console.log(`  Markets analysed:    ${summary.totalMarketsAnalysed}`)
    console.log(`  Bets triggered:      ${summary.totalBetsTriggered}`)
    console.log(`  Complete bets:       ${summary.completeBets}`)
    console.log(`  Win rate:            ${summary.winRate}`)
    console.log(`  Total P&L (units):   ${summary.totalPnl > 0 ? '+' : ''}${summary.totalPnl}`)
    console.log('─'.repeat(65))
    console.log('  By Strategy:')
    console.log('─'.repeat(65))

    for (const [name, stats] of Object.entries(summary.byStrategy)) {
      const winRate = stats.bets > 0
        ? ((stats.wins / stats.bets) * 100).toFixed(0) + '%'
        : 'N/A'
      const pnl = stats.totalPnl > 0
        ? `+${stats.totalPnl.toFixed(2)}`
        : stats.totalPnl.toFixed(2)
      console.log(`  ${name.padEnd(20)} Bets: ${String(stats.bets).padStart(3)}  Win: ${winRate.padStart(5)}  P&L: ${pnl}`)
    }

    console.log('═'.repeat(65))
    console.log(`\n  Report saved to: backtest/report.html\n`)
  }

  _saveHtml(summary, results, options) {
    const triggered = results.filter(r => r.triggered)

    const strategyRows = Object.entries(summary.byStrategy)
      .map(([name, s]) => {
        const wr = s.bets > 0 ? ((s.wins / s.bets) * 100).toFixed(1) : 'N/A'
        const pnl = s.totalPnl >= 0 ? `+${s.totalPnl.toFixed(2)}` : s.totalPnl.toFixed(2)
        const pnlClass = s.totalPnl >= 0 ? 'pos' : 'neg'
        return `<tr>
          <td>${name}</td>
          <td>${s.bets}</td>
          <td>${s.wins}</td>
          <td>${wr}%</td>
          <td class="${pnlClass}">${pnl}</td>
          <td>${s.incomplete}</td>
        </tr>`
      }).join('')

    const betRows = triggered.map(r => {
      const pnlStr = r.pnl === null ? '—' : (r.pnl >= 0 ? `+${r.pnl}` : `${r.pnl}`)
      const pnlClass = r.pnl === null ? '' : (r.pnl >= 0 ? 'pos' : 'neg')
      return `<tr>
        <td>${r.marketId}</td>
        <td>${r.strategy}</td>
        <td>${r.side}</td>
        <td>${r.entryPrice}</td>
        <td>${r.exitPrice || '—'}</td>
        <td class="${pnlClass}">${pnlStr}</td>
        <td>${r.confidence}</td>
        <td>${r.exitReason || '—'}</td>
      </tr>`
    }).join('')

    const totalPnlClass = parseFloat(summary.totalPnl) >= 0 ? 'pos' : 'neg'

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Tennis Bot Backtest Report</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f1117; color: #e0e0e0; margin: 0; padding: 24px; }
  h1 { color: #4ade80; font-size: 22px; margin-bottom: 4px; }
  h2 { color: #94a3b8; font-size: 16px; font-weight: 400; margin-top: 32px; margin-bottom: 12px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 24px 0; }
  .card { background: #1e2130; border-radius: 10px; padding: 16px; }
  .card-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .card-value { font-size: 24px; font-weight: 600; margin-top: 4px; }
  .pos { color: #4ade80; }
  .neg { color: #f87171; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #1e2130; color: #64748b; text-align: left; padding: 10px 12px; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 10px 12px; border-bottom: 1px solid #1e2130; }
  tr:hover td { background: #1a1f2e; }
  .section { background: #161a25; border-radius: 10px; padding: 20px; margin-bottom: 20px; overflow-x: auto; }
</style>
</head>
<body>
<h1>🎾 Tennis Bot — Set Strategy Backtest</h1>
<p style="color:#64748b; margin:0">Generated ${new Date().toLocaleString()}</p>

<div class="stats">
  <div class="card">
    <div class="card-label">Markets Analysed</div>
    <div class="card-value">${summary.totalMarketsAnalysed}</div>
  </div>
  <div class="card">
    <div class="card-label">Bets Triggered</div>
    <div class="card-value">${summary.totalBetsTriggered}</div>
  </div>
  <div class="card">
    <div class="card-label">Win Rate</div>
    <div class="card-value">${summary.winRate}</div>
  </div>
  <div class="card">
    <div class="card-label">Total P&L (units)</div>
    <div class="card-value ${totalPnlClass}">${parseFloat(summary.totalPnl) >= 0 ? '+' : ''}${summary.totalPnl}</div>
  </div>
</div>

<div class="section">
  <h2>By Strategy</h2>
  <table>
    <thead>
      <tr><th>Strategy</th><th>Bets</th><th>Wins</th><th>Win Rate</th><th>P&L (units)</th><th>Incomplete</th></tr>
    </thead>
    <tbody>${strategyRows}</tbody>
  </table>
</div>

<div class="section">
  <h2>Individual Bets</h2>
  <table>
    <thead>
      <tr><th>Market ID</th><th>Strategy</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Confidence</th><th>Exit Reason</th></tr>
    </thead>
    <tbody>${betRows}</tbody>
  </table>
</div>

</body>
</html>`

    fs.writeFileSync(path.join(__dirname, 'report.html'), html)
  }
}

module.exports = Reporter
```

---

### backtest/runner.js

CLI entry point. Accepts date range and optional strategy filter.

```javascript
const path = require('path')
const DataLoader = require('./dataLoader')
const SetDetector = require('./setDetector')
const StrategyReplayer = require('./strategyReplayer')
const Reporter = require('./reporter')

async function run() {
  const args = parseArgs(process.argv.slice(2))

  console.log('\n🎾 Tennis Bot Set Strategy Backtester')
  console.log('─'.repeat(40))
  console.log(`Loading historical files from data/historical/...`)

  const loader = new DataLoader()
  const detector = new SetDetector()
  const replayer = new StrategyReplayer()
  const reporter = new Reporter()

  // Load files
  const files = loader.listAvailableFiles(args.from, args.to)

  if (files.length === 0) {
    console.log('\n❌ No historical files found in data/historical/')
    console.log('\nTo get data:')
    console.log('  1. Go to https://historicdata.betfair.com')
    console.log('  2. Log in with your Betfair account')
    console.log('  3. Select Sport: Tennis, Market Type: Match Odds')
    console.log('  4. Download date range and place files in data/historical/')
    process.exit(1)
  }

  console.log(`Found ${files.length} market files\n`)

  let processed = 0
  for (const file of files) {
    try {
      const markets = await loader.loadMarket(file.path)

      for (const market of markets) {
        const runners = [...market.runners.values()]
        if (runners.length !== 2) continue

        const [runnerA, runnerB] = runners
        const setEvents = detector.detectSets(market)

        if (setEvents.length === 0) continue

        replayer.replayMarket(market, setEvents, runnerA, runnerB)
        processed++
      }
    } catch (err) {
      console.warn(`  Skipped ${file.filename}: ${err.message}`)
    }
  }

  console.log(`Processed ${processed} markets\n`)

  const summary = replayer.getSummary()
  reporter.generate(summary, replayer.results, args)

  // Open in browser on Windows
  if (process.platform === 'win32') {
    const { exec } = require('child_process')
    exec(`start ${path.join(__dirname, 'report.html')}`)
  }
}

function parseArgs(args) {
  const result = { from: null, to: null, strategy: null }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') result.from = args[i + 1]
    if (args[i] === '--to') result.to = args[i + 1]
    if (args[i] === '--strategy') result.strategy = args[i + 1]
    if (args[i] === '--notes') result.notes = args[i + 1]
  }
  return result
}

run().catch(console.error)
```

---

### Add to package.json scripts

```json
"scripts": {
  "start": "node src/index.js",
  "backtest": "node backtest/runner.js",
  "backtest:strategy1": "node backtest/runner.js --strategy Strategy1",
  "backtest:strategy2": "node backtest/runner.js --strategy Strategy2"
}
```

---

## Phase 14E — Backtests Tab on Dashboard

Add the backtest results to the live dashboard.

### Add SQLite storage

Install: `npm install better-sqlite3`

Every time `runner.js` completes, save the summary to SQLite:

```javascript
// At end of runner.js
const { saveRun } = require('../src/dashboard/backtestDb')
saveRun({
  ranAt: new Date().toISOString(),
  fromDate: args.from || 'all',
  toDate: args.to || 'all',
  config: JSON.stringify(replayer.strategies),
  markets: processed,
  bets: summary.totalBetsTriggered,
  winRate: parseFloat(summary.winRate),
  totalPnl: parseFloat(summary.totalPnl),
  notes: args.notes || null
})
```

### Dashboard Backtests tab

Add to `src/dashboard/public/index.html` — a second tab:

```
[ 🎾 Live Trading ]  [ 📊 Backtests ]
```

Backtests tab shows:
- Table of all past runs (date, markets, bets, win rate, P&L)
- Click a row → expand to show per-strategy breakdown
- "Open full report" button → opens `backtest/report.html`
- Compare two runs side by side

---

## How to Run the Backtester

```bash
# Run against all files in data/historical/
npm run backtest

# Run a specific strategy only
npm run backtest -- --strategy Strategy1

# Run with notes for comparison
npm run backtest -- --notes "Tighter odds filter on S1"

# The HTML report opens automatically in your browser
```

---

## Getting Good Historical Data

**Free (Basic plan) from historicdata.betfair.com:**
- 1 price point per minute
- Good enough to detect set completion
- Good enough to estimate entry/exit prices
- Start here

**For more accurate results:**
- Advanced plan gives tick-by-tick data
- Entry/exit prices will be much more precise
- Worth it once you've confirmed the strategies work on Basic data

**How much data to download:**
- Start with 2-3 weeks of recent data to verify the backtester works
- Then download 3-6 months for a meaningful sample
- A Grand Slam fortnight is particularly good data — high volume markets

**What to look for in results:**
- Strategy 1 (tiebreak lay) should show ~55-60% win rate if the theory is correct
- Strategy 2/3 (favourite comeback) depends heavily on the pre-match odds filter
- If win rate is below 50% on a strategy, reconsider the trigger conditions
- Always check the "incomplete" count — high incomplete means data gaps

---

## Important Limitations

Document these in README.md:

1. **Set detection is estimated** — we infer set completion from price movements,
   not from actual score data in the historical files. Basic plan data (1 price/min)
   means the detected set completion moment may be up to 1 minute off.

2. **Entry price approximation** — the actual entry price in live trading will
   differ from the historical price at the detected moment. Use the results
   as directional guidance, not precise P&L prediction.

3. **No volume filter in backtest** — we can't know historical matched volume
   from the Basic data files. The live bot filters for £50k volume, but the
   backtester can't do this. Results may include low-volume markets the live
   bot would skip.

4. **Pre-match odds accuracy** — BSP (Betfair Starting Price) is available
   in the data and used as the pre-match price proxy. The actual pre-match
   price your dad's bot would see could differ slightly.

5. **Tick data gives much better results** — if the Basic plan backtester
   looks promising, upgrading to Advanced tick data will give much more
   accurate P&L estimates.

---

## Build Order for Claude Code

**14A + 14B together:**
> "Read TENNIS_BOT_PHASE14_SPEC.md. Build Phases 14A and 14B —
> the DataLoader and SetDetector. Stop when done and summarise."

**Then 14C:**
> "Build Phase 14C — the StrategyReplayer. Stop when done."

**Then 14D:**
> "Build Phase 14D — the Reporter and runner.js CLI.
> Add npm scripts to package.json. Stop when done."

**Then 14E:**
> "Build Phase 14E — SQLite storage for backtest runs
> and the Backtests tab on the dashboard. Stop when done."

---

*End of Phase 14 specification.*
