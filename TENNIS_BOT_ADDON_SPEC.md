# Tennis Bot — Phase 9 & 10 Addon Specification

> **For Claude Code**: Phases 1–8 of the tennis bot are already complete.
> This file adds Phase 9 (live dashboard) and Phase 10 (backtester).
> Read this file in full before writing any code.
> Work through Phase 9 completely before starting Phase 10.

---

## Phase 9 — Live Dashboard

A local web dashboard that runs alongside the bot and shows live bet data,
open positions, P&L and match states in real time.

No external hosting needed — it runs on localhost and is only accessible on your PC.

---

### 9.1 Overview

The dashboard is a simple Express.js server with a single HTML page.
It reads from the same `data/trade_log.csv` and connects to the running bot
via a WebSocket so the page updates live without refreshing.

```
tennis-bot/
├── src/
│   └── dashboard/
│       ├── server.js          # Express + WebSocket server
│       └── public/
│           ├── index.html     # Single page dashboard
│           ├── style.css      # Styles
│           └── app.js         # Frontend JS (charts, live updates)
```

Add to package.json:
```json
"express": "^4.18.0",
"ws": "^8.16.0"
```
(ws is already installed — just add express if not present)

---

### 9.2 Dashboard Server (src/dashboard/server.js)

```javascript
// Express server on port 3000 (configurable via DASHBOARD_PORT in .env)
// Serves the public/ folder as static files
// WebSocket server on the same port
// 
// The bot's index.js calls dashboard.broadcast(event, data) 
// whenever something notable happens:
//   - 'bet_placed'    → new row in open positions table
//   - 'trade_out'     → position moved to settled
//   - 'stop_loss'     → position closed at loss
//   - 'state_update'  → match state snapshot (every 5s loop)
//   - 'status'        → bot heartbeat (markets watched, exposure)
//
// All connected browser tabs receive these events instantly
// If the bot is not running, the dashboard still serves historical
// data from trade_log.csv
```

**Integrate into index.js:**

Add these two lines to index.js after Phase 8's startup sequence:
```javascript
const dashboard = require('./dashboard/server')
await dashboard.start()
```

And call `dashboard.broadcast()` at the appropriate points in the main loop.

---

### 9.3 Dashboard Page (src/dashboard/public/index.html)

Single HTML file. No frameworks — plain HTML, CSS and vanilla JS.
Uses Chart.js (loaded from CDN) for the P&L chart.

**Layout — four sections stacked vertically:**

```
┌─────────────────────────────────────────────────────┐
│  🎾 Tennis Bot Dashboard          🟢 Bot Running    │
│  Last update: 14:32:05            DRY RUN MODE      │
├──────────┬──────────┬──────────┬────────────────────┤
│  P&L     │  Open    │ Markets  │  Win Rate          │
│ Today    │  Bets    │ Watched  │                    │
│ +£47.20  │    3     │   12     │  64% (18/28)       │
├──────────┴──────────┴──────────┴────────────────────┤
│  P&L Chart (line chart — last 30 days, daily)       │
│                                                     │
│  [chart renders here]                               │
├─────────────────────────────────────────────────────┤
│  Open Positions                                     │
│  ┌──────────────┬──────┬──────┬──────┬──────┬────┐ │
│  │ Match        │ Side │ Odds │Stake │ P&L  │Edge│ │
│  │ Djokovic v   │ BACK │ 1.85 │£12.50│+£6.20│ 4% │ │
│  │ Alcaraz      │      │      │      │      │    │ │
│  └──────────────┴──────┴──────┴──────┴──────┴────┘ │
├─────────────────────────────────────────────────────┤
│  Live Match States                                  │
│  ┌──────────────┬────────┬───────┬────────┬───────┐ │
│  │ Match        │ Score  │ Odds  │ Edge   │Moment.│ │
│  │ Djokovic v   │ 6-4    │ 1.85  │ +4.2%  │  +45  │ │
│  │ Alcaraz      │ 3-2 *  │       │        │       │ │
│  └──────────────┴────────┴───────┴────────┴───────┘ │
├─────────────────────────────────────────────────────┤
│  Settled Trades (today)                             │
│  [scrollable table — most recent first]             │
└─────────────────────────────────────────────────────┘
```

**Live updates:**
- WebSocket connection established on page load
- Each event from the bot updates only the relevant section
- Status dot (🟢/🔴) in the header reflects bot connection
- If WebSocket drops, show "⚠️ Bot disconnected" and retry every 5s

**P&L Chart:**
- Load last 30 days from `GET /api/trades/daily` endpoint
- Line chart, green line, show cumulative P&L
- X axis: dates, Y axis: £ P&L
- Updates live when a trade settles

**Open Positions table:**
- Colour rows: green if current P&L positive, red if negative
- Show "No open positions" when empty
- Estimated P&L updates every 5s from state_update events

**Live Match States table:**
- One row per active market being monitored
- Momentum shown as a coloured bar: green (+) / red (-)
- Edge shown in green if above minEdgePercent threshold
- Asterisk (*) next to current server's score

---

### 9.4 Dashboard API Endpoints

The Express server exposes these REST endpoints (used by the frontend on load):

```
GET /api/summary
  Returns: { pnlToday, openBets, marketsWatched, winRate, totalBets, isRunning, dryRun }

GET /api/trades/daily
  Returns: [{ date: "2026-03-01", pnl: 47.20 }, ...]  ← last 30 days from CSV

GET /api/trades/open
  Returns: current open orders from orderManager

GET /api/trades/settled
  Query: ?limit=50
  Returns: last N settled rows from trade_log.csv

GET /api/matches
  Returns: all active MatchState snapshots from stateStore
```

---

### 9.5 Add to .env

```
DASHBOARD_PORT=3000
DASHBOARD_ENABLED=true
```

When `DASHBOARD_ENABLED=false` the dashboard server does not start (useful on a headless server).

---

### 9.6 How to open the dashboard

Once the bot is running, open a browser and go to:
```
http://localhost:3000
```

Add a log line on startup:
```
[INFO] Dashboard running at http://localhost:3000
```

---

## Phase 10 — Backtester

A standalone script that replays historical Betfair price data through
the algorithm engine and produces a P&L report — without placing any real bets.

---

### 10.1 Overview

```
tennis-bot/
├── backtest/
│   ├── runner.js           # Main backtest entry point
│   ├── dataLoader.js       # Loads and parses historical price files
│   ├── simulator.js        # Replays prices through the algorithm
│   └── report.js           # Generates HTML report from results
├── data/
│   └── historical/         # Put your historical price files here
│       └── README.txt      # Instructions on where to get data
```

Run with:
```bash
node backtest/runner.js --from 2026-01-01 --to 2026-03-01
```

---

### 10.2 Historical Data Source

Betfair historical price data can be downloaded from:
**https://historicdata.betfair.com**

- Log in with your Betfair account
- Select Sport: Tennis
- Select market type: Match Odds
- Download gives you `.bz2` compressed files of tick-by-tick price data

Each file covers one market (one match). The format is Betfair's own
BSP/streaming format — one JSON object per line, same format as the
live streaming API the bot already uses.

**Store downloaded files in `data/historical/`**

The dataLoader will decompress and parse them automatically.

---

### 10.3 Data Loader (backtest/dataLoader.js)

```javascript
// Scans data/historical/ for .bz2 and .json files
// Decompresses .bz2 files on the fly using the 'unbzip2-stream' package
// Parses each line as a Betfair streaming MCM (Market Change Message)
// Groups messages by marketId
// Returns an array of markets, each with:
//   {
//     marketId,
//     matchName,
//     startTime,
//     messages: [ ...chronological MCM objects ]
//   }
// Filters to date range passed in from runner.js
```

Add to package.json:
```json
"unbzip2-stream": "^1.4.3"
```

---

### 10.4 Simulator (backtest/simulator.js)

This is the core of the backtester. It replays each market's price messages
through the same algorithm engine the live bot uses.

```javascript
async function simulateMarket(market, config) {
  // 1. Create a fresh MatchState for this market
  // 2. Create a fresh OrderManager in DRY_RUN mode
  // 3. Walk through each MCM message in chronological order:
  //    a. Apply odds update to MatchState (same as live bot)
  //    b. If a stats update is available for this timestamp, apply it
  //    c. Call signalEngine.evaluate(matchState, { ...config, openMarkets, openPosition })
  //    d. If BET signal: call riskManager.check(), then orderManager.placeBack/placeLay()
  //    e. If TRADE_OUT signal: call orderManager.tradeOut()
  //    f. Record every decision in a results array
  // 4. At market close: settle all open positions at final price
  // 5. Return results array
}
```

**Key difference from live bot:**
- No real sleep/wait between messages — replay as fast as possible
- Stats data (serve %, break points) won't be in the historical price files
  so the simulator falls back to historical player stats from serve_stats.json
- Time between messages is simulated by reading the `pt` (publish time) field

---

### 10.5 Report Generator (backtest/report.js)

Takes the array of all market results and produces two outputs:

**1. Console summary**
```
═══════════════════════════════════════
  Tennis Bot Backtest Report
  Period: 2026-01-01 → 2026-03-01
═══════════════════════════════════════
  Markets analysed:        247
  Bets placed:              89
  Win rate:               61.8%
  Total P&L:            +£342.50
  Best day:             +£89.20 (2026-02-14)
  Worst day:            -£43.10 (2026-01-22)
  Max drawdown:         -£67.40
  Avg edge at entry:       4.2%
  Avg odds backed:         2.14
  ROI:                   12.8%
═══════════════════════════════════════
```

**2. HTML report saved to `backtest/report.html`**

Same layout as the dashboard but for historical data:
- P&L chart (daily, full backtest period)
- Trade table (all bets with outcome)
- Summary stats cards
- Breakdown by surface (clay / hard / grass)
- Breakdown by tournament tier (Grand Slam / ATP 500 / ATP 250)

Open in browser:
```bash
start backtest/report.html    # Windows
open backtest/report.html     # Mac
```

---

### 10.6 Runner (backtest/runner.js)

```javascript
// Parse CLI args: --from, --to, optional --config (path to alt strategies.json)
// Load config from config/strategies.json (or --config path)
// Print: "Loading historical data..."
// dataLoader.load({ from, to }) → markets array
// Print: "Found N markets. Running simulation..."
// For each market: simulator.simulateMarket(market, config)
// Collect all results
// report.generate(results, { from, to })
// Print console summary
// Save report.html
```

---

### 10.7 Backtester Limitations (document in README)

Be honest about what backtesting can and cannot tell you:

- **No live serve stats** — the backtester uses pre-match historical averages
  because point-by-point data is not in the price files. This means momentum
  signals will be weaker than in live trading.
- **No market impact** — your simulated bets don't move the price, but in
  reality a £50 bet at 1.85 in a low-volume market does move it slightly.
- **Survivorship bias** — you only have data for markets you downloaded.
  If you only download Grand Slams, results won't reflect ITF match behaviour.
- **Overfitting risk** — if you tune `strategies.json` to maximise backtest
  profit and then go live, you may have overfit to historical patterns.
  Always test on data you haven't seen before.

---

## Build Order for Claude Code

Tell Claude Code:

> "Read TENNIS_BOT_ADDON_SPEC.md. Phases 1–8 of the bot are complete.
> Now build Phase 9 only — the live dashboard. Stop when done and summarise."

Then after reviewing:

> "Phase 9 looks good. Now build Phase 10 — the backtester. Stop when done."

---

## Quick Start After Building

**Run the bot with dashboard:**
```bash
cd tennis-bot
node src/index.js
# Open http://localhost:3000 in browser
```

**Run a backtest:**
```bash
# First download some historical data from historicdata.betfair.com
# Put the files in data/historical/
node backtest/runner.js --from 2026-01-01 --to 2026-03-19
# Open backtest/report.html in browser
```

---

*End of addon specification.*
