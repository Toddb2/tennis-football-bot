# Tennis Bot — Full Documentation

## Table of Contents

1. [Overview](#overview)
2. [How It Works — End to End](#how-it-works--end-to-end)
3. [File Structure](#file-structure)
4. [Module Explanations](#module-explanations)
   - [Entry Point](#entry-point)
   - [Data Collection](#data-collection)
   - [Match State](#match-state)
   - [Algorithm Engine](#algorithm-engine)
   - [Risk Management](#risk-management)
   - [Execution Layer](#execution-layer)
   - [Notifications](#notifications)
   - [Dashboard](#dashboard)
   - [Backtester](#backtester)
   - [Utilities](#utilities)
5. [Configuration Reference](#configuration-reference)
   - [Environment Variables (.env)](#environment-variables-env)
   - [strategies.json — Full Settings Guide](#strategiesjson--full-settings-guide)
6. [External APIs](#external-apis)
7. [Trading Logic Deep Dive](#trading-logic-deep-dive)
   - [Probability Model (Markov Chain)](#probability-model-markov-chain)
   - [Momentum Detection](#momentum-detection)
   - [Signal Engine](#signal-engine)
8. [Multi-System Architecture](#multi-system-architecture)
9. [Backtesting](#backtesting)
   - [Historical Data](#historical-data)
   - [Running a Backtest](#running-a-backtest)
   - [How the Backtester Works](#how-the-backtester-works)
   - [Auto-Growing Match Pool](#auto-growing-match-pool)
10. [Dry-Run Mode](#dry-run-mode)
11. [Dashboard & Monitoring](#dashboard--monitoring)
12. [Telegram Commands](#telegram-commands)
13. [Dependencies](#dependencies)
14. [Setup & Running](#setup--running)
15. [Moving to a Dedicated PC](#moving-to-a-dedicated-pc)

---

## Overview

Tennis Bot is an autonomous trading bot that monitors live tennis matches on the **Betfair Exchange** and places bets via **CloudBetBot (CBB)**. It does not blindly follow tips — it makes its own decisions by:

- Pulling live score and serve data from **RapidAPI**
- Pulling live odds from the **Betfair Streaming API**
- Computing the **true win probability** for each player using a Markov chain model
- Comparing that to the **market-implied probability** from the current odds
- Detecting **momentum** shifts (breaks, streaks, serve stats)
- Placing bets when edge + momentum align
- Greening up (trading out) positions when conditions reverse

All decisions go through configurable systems defined in `config/strategies.json`, which can be edited live without restarting the bot. Performance can be validated before going live using the built-in backtester, which runs against real Betfair historical data and displays results directly in the dashboard.

---

## How It Works — End to End

```
Betfair Streaming API ──► betfairStream.js ──► marketRecorder.js ──► data/historical/
                                │
                                └──────────────────────► stateStore
                                                              │
RapidAPI (live scores) ──► statsPoller.js ───────────────────┘
                                                              │
                                                        matchState
                                                       (per market)
                                                              │
                                          ┌───────────────────┼───────────────────┐
                                          ▼                   ▼                   ▼
                                probabilityModel    momentumDetector    systemEvaluator
                                          └───────────────────┼───────────────────┘
                                                              ▼
                                                        signalEngine
                                                    (HOLD / BET / TRADE_OUT)
                                                              │
                                                        riskManager
                                                  (stake sizing, exposure check)
                                                              │
                                                        orderManager
                                                    (place via cbbClient)
                                                              │
                                    ┌─────────────────────────┼─────────────────────────┐
                                    ▼                         ▼                         ▼
                              telegram.js            dashboard/server            trade_log.csv
```

### Main Loop (every 5 seconds)

For every live match in the state store:

1. Check if the match qualifies for any enabled trading system
2. Run the signal engine to compute edge and momentum
3. If a **BET** signal is returned:
   - Apply system-level filters (odds range, surface, tournament)
   - Risk-check via stake sizing + exposure limits
   - If approved: place via CBB, log to CSV, notify Telegram
4. If a **TRADE_OUT** signal is returned:
   - Place inverse bet to green up
   - Close position, log P&L, notify Telegram
5. Broadcast updated match states to dashboard WebSocket clients

---

## File Structure

```
tennis-bot/
├── src/
│   ├── collector/
│   │   ├── betfairStream.js       # Betfair Streaming API (TLS socket)
│   │   ├── statsPoller.js         # RapidAPI live score poller (15s)
│   │   ├── historicalLoader.js    # Pre-match serve stats (cached daily)
│   │   └── marketRecorder.js      # Records live match price data to disk
│   ├── state/
│   │   ├── matchState.js          # Per-match state class
│   │   └── stateStore.js          # In-memory store of all active matches
│   ├── algorithm/
│   │   ├── probabilityModel.js    # Markov chain win probability
│   │   ├── momentumDetector.js    # 5-component momentum scoring
│   │   ├── signalEngine.js        # Entry/exit decision logic
│   │   └── systemEvaluator.js     # Matches a market against trading systems
│   ├── risk/
│   │   └── riskManager.js         # Stake sizing + exposure validation
│   ├── execution/
│   │   ├── cbbClient.js           # CloudBetBot HTTP API client
│   │   └── orderManager.js        # Position tracking + CSV logging
│   ├── notifications/
│   │   └── telegram.js            # Alerts + bot commands
│   ├── dashboard/
│   │   ├── server.js              # Express + WebSocket dashboard server
│   │   ├── backtestDb.js          # Backtest results storage (JSON-backed)
│   │   └── public/                # Dashboard frontend (HTML/JS/CSS)
│   ├── utils/
│   │   ├── logger.js              # Console + file logging
│   │   └── helpers.js             # Fuzzy name matching, utilities
│   └── index.js                   # Entry point and main loop
├── backtest/
│   ├── runner.js                  # CLI entry point for the backtester
│   ├── dataLoader.js              # Loads bz2/CSV/JSON historical files
│   ├── setDetector.js             # Detects set completions from price data
│   ├── strategyReplayer.js        # Replays strategies against historical data
│   └── reporter.js                # Console output for backtest results
├── config/
│   ├── strategies.json            # Hot-reloadable thresholds and trading systems
│   └── tennis_strategies.json     # Legacy/backup config
├── data/
│   ├── historical/                # Historical market data for backtesting
│   │   └── data/BASIC/            # Betfair download format (bz2 files)
│   ├── backtests.json             # Saved backtest run results
│   ├── serve_stats.json           # Cached player stats (refreshed nightly)
│   └── trade_log.csv              # Full bet history for P&L tracking
├── certs/
│   ├── client-2048.crt            # SSL cert (legacy)
│   └── client-2048.key            # SSL key (legacy)
├── .env                           # Credentials and runtime config
├── .env.example                   # Template
└── package.json
```

---

## Module Explanations

### Entry Point

**`src/index.js`**

The startup and orchestration file. On launch it:

1. Loads `.env` and `strategies.json`
2. Sets up a file watcher on `strategies.json` for hot-reload
3. Initialises all modules (logger, Telegram, CBB, stateStore, orderManager, betfairStream, statsPoller, marketRecorder, dashboard)
4. Starts the **main loop** on a 5-second interval
5. Registers graceful shutdown on `SIGINT`/`SIGTERM` (cancels open orders, flushes the market recorder cleanly)

---

### Data Collection

**`src/collector/betfairStream.js`**

Connects to the Betfair Streaming API over a raw TLS socket. Authenticates using a session token and exchanges BFLP (line-delimited JSON) messages. Subscribes to tennis in-play `MATCH_ODDS` markets only — skipping doubles and ITF matches by inspecting the market definition.

- Emits `marketUpdate` events with runner odds and matched volume
- Auto-reconnects with exponential backoff if the socket drops

**`src/collector/statsPoller.js`**

Polls RapidAPI's tennis-live-data endpoint every 15 seconds for:
- Current score (sets, games, points)
- Serve stats (1st serve %, aces, double faults, break points)

Uses fuzzy player name matching to link an external match to a Betfair market. Maintains a retry queue for matches that haven't been linked yet.

**`src/collector/historicalLoader.js`**

Loads pre-match surface-specific stats for each player (serve win %, return win %, hold %, break %) from RapidAPI or a local cache. Falls back to ATP/WTA tour averages if a player isn't found. Refreshes the cache nightly at midnight.

**`src/collector/marketRecorder.js`**

Listens to the same `marketUpdate` events from `betfairStream` and silently records every price tick to disk. This means every match the live bot watches is automatically saved to `data/historical/` for future backtesting — the match pool grows on its own without any manual effort.

How it works:
- Buffers one snapshot per runner per tick (`{ timestamp, selectionId, selectionName, lastTradedPrice, inPlay }`)
- When a market is marked `CLOSED` by the stream, flushes the full price history to `data/historical/<marketId>.json`
- On shutdown, flushes any in-progress markets so partial recordings are not lost
- If a file already exists for that market (bot restarted mid-match), it merges and deduplicates snapshots rather than overwriting
- Markets with fewer than 10 snapshots are discarded (avoids tiny fragments from suspended markets)

The output format is the same flat-snapshot JSON that the backtester's `dataLoader` already handles, so recorded files are immediately usable for backtesting.

---

### Match State

**`src/state/matchState.js`**

One instance exists per live market. Holds the full unified view of a match:
- Score (sets, games, points, server)
- Live odds (best back/lay for each player)
- Matched volume
- Live serve stats (from RapidAPI)
- Historical serve stats (from historicalLoader)
- Computed true probabilities and edges
- Current momentum index

Key methods:
- `applyOddsUpdate(data)` — Updates odds from Betfair stream
- `applyStatsUpdate(data)` — Updates score/serve stats from RapidAPI
- `recompute()` — Recalculates edges (true prob vs implied prob)
- `toSnapshot()` — Returns a serialisable summary for the dashboard/Telegram

**`src/state/stateStore.js`**

An in-memory `Map` of `marketId → MatchState`. Handles upsert logic when updates arrive from either data source. Maintains a reverse lookup from external stats ID to marketId. Archives closed markets. Exposes `findMarketForExternalMatch()` for fuzzy-matching names across sources.

---

### Algorithm Engine

**`src/algorithm/probabilityModel.js`**

Computes the true win probability using a recursive Markov chain model:

- `pointWinProb(serveWinPct)` → probability of winning a game from P(win point)
- `setWinProbFromScore(holdA, holdB, gA, gB, server)` → probability of winning the set given current game score
- `matchWinProb(setsA, setsB, holdA, holdB, gA, gB, server)` → full match win probability

Blends live serve stats with historical stats. Live stats are trusted fully after 10 games played; before that, they are blended with historical averages proportionally. Set calculations are memoised for performance.

**`src/algorithm/momentumDetector.js`**

Scores momentum from -100 to +100 using five components:

| Component | Max Contribution | Trigger |
|---|---|---|
| Break streak | +25 per consecutive break | Player just broke serve |
| Game streak | +10 per game won | Player winning games consecutively |
| Serve efficiency trend | +15 | 1st-serve % climbed >5pp in recent games |
| Double fault penalty | -10 per fault over threshold | >2 double faults per set |
| Break point conversion | +15 | Conversion rate >50% |

All components decay by half every 3 games without a new event, keeping the signal responsive to recent play rather than stale history.

**`src/algorithm/signalEngine.js`**

Combines edge and momentum to produce a decision:

- **BET_BACK_A / BET_BACK_B**: Edge ≥ threshold AND momentum aligns AND volume ≥ minimum
- **BET_LAY_A / BET_LAY_B**: Lay-side edge detected
- **TRADE_OUT**: Edge reversed OR momentum swung against open position OR profit target hit OR stop-loss triggered
- **HOLD**: No qualifying condition

Returns `{ action, confidence, reason, suggestedOdds, marketId, selectionId }`.

**`src/algorithm/systemEvaluator.js`**

Tests a match against all enabled systems in `strategies.json`. Each system has its own filter set (surface, tournament tier, odds range, minimum games played, serve conditions, etc.). Returns qualifying systems in priority order so the main loop can use the highest-priority one.

---

### Risk Management

**`src/risk/riskManager.js`**

Before any bet is placed, the risk manager:

1. Calculates the stake using the edge and configured multiplier, clamped within min/max bounds
2. Validates:
   - No more than `maxOpenPositions` concurrent bets
   - No more than 1 open position per market
   - Total liability < `maxTotalExposureGBP`

Returns `{ approved, rejectionReason, recommendedStake, projectedLiability }`.

---

### Execution Layer

**`src/execution/cbbClient.js`**

HTTP client for the CloudBetBot API. Key methods:

- `upsertBet(marketId, selectionId, strategyKey, points)` — Place or update a bet
- `cancelBet(marketId, selectionId, strategyKey)` — Deactivate a bet
- `getTennisCatalogue()` — Fetch market definitions (30-second TTL cache)

In `DRY_RUN` mode, logs the intended action without sending any HTTP request.

**`src/execution/orderManager.js`**

Tracks the full position lifecycle:

- `placeBack(...)` / `placeLay(...)` — Places a bet via CBB, records in `openOrders` Map
- `tradeOut(marketId, reason)` — Cancels the bet, moves to `settledOrders`, logs to CSV
- `stopLoss(marketId)` — Triggered by the signal engine's exit logic
- `_logToCSV(...)` — Appends a row to `data/trade_log.csv`
- `getTotalExposure()` / `getCurrentPnL()` — Query methods for the dashboard and Telegram

---

### Notifications

**`src/notifications/telegram.js`**

Sends alerts and listens for commands via the Telegram Bot API.

Outbound alerts include: bet placed, trade out, stop loss triggered, system qualification, startup confirmation, low liquidity warnings, and errors.

See [Telegram Commands](#telegram-commands) for inbound commands.

Degrades gracefully if `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` are missing.

---

### Dashboard

**`src/dashboard/server.js`**

Runs an Express HTTP server and WebSocket server for live monitoring. The dashboard is designed to stay running permanently — a ngrok tunnel can expose it remotely without the server ever needing to come down.

REST endpoints:
| Endpoint | Description |
|---|---|
| `GET /api/summary` | Open bets, total exposure, markets watched |
| `GET /api/trades/daily` | Last 30 days P&L for the chart |
| `GET /api/trades/open` | Current open positions |
| `GET /api/trades/settled` | Historical trades from CSV |
| `GET /api/matches` | Active match snapshots with signal state |
| `GET /api/config/strategies` | Current strategies.json contents |
| `PUT /api/config/strategies` | Save updated strategies.json |
| `GET /api/backtest/runs` | All saved backtest run summaries |
| `POST /api/backtest/runs` | Save a manually created run |
| `DELETE /api/backtest/runs/:id` | Delete a run and its data |
| `GET /api/backtest/runs/:id/breakdown` | Per-strategy breakdown for a run |
| `GET /api/backtest/runs/:id/bets` | Individual bet records for a run |
| `POST /api/backtest/trigger` | Start a new backtest from the browser |
| `GET /api/backtest/running` | Whether a backtest is currently in progress |

WebSocket broadcasts:
| Event | When |
|---|---|
| `init` | Immediately on connection — full state including `backtestRunning` flag |
| `state_update` | Every 5 seconds — all match states |
| `bet_placed` | New position opened |
| `trade_out` | Position greened up |
| `stop_loss` | Position closed at a loss |
| `backtest_started` | A backtest has been triggered |
| `backtest_progress` | One line of output from the running backtest process |
| `backtest_complete` | Backtest finished successfully |
| `backtest_error` | Backtest process exited with an error |

**`src/dashboard/backtestDb.js`**

Persistent storage for backtest results, implemented as a structured JSON file (`data/backtests.json`). Stores three collections:

- `runs` — summary record per backtest (date range, markets processed, P&L, ROI, etc.)
- `breakdown` — per-strategy stats for each run
- `bets` — individual triggered bet records for each run

Public API: `insertRun(run)`, `getRuns()`, `getRun(id)`, `getStrategyBreakdown(runId)`, `getBets(runId)`, `deleteRun(id)`.

Writes atomically via a `.tmp` file + rename to avoid corruption if the process is killed mid-write.

---

### Backtester

The backtester is an offline analysis tool that replays historical Betfair data through the same set-based strategies as the live bot, then saves the results to the dashboard.

**`backtest/dataLoader.js`**

Finds and loads historical market files. Handles three formats:

- **Betfair bz2** (`1.XXXXXXXXX.bz2`) — the standard Betfair Historical Data Service download. Each file is decompressed using `unbzip2-stream` (pure JavaScript, no native build tools required) and parsed as Exchange Streaming API (ESA) newline-delimited JSON. Only 2-runner `MATCH_ODDS` markets are loaded; tournament outrights and multi-runner markets are skipped automatically after reading just the first line.
- **CSV** — Betfair's standard historical CSV format with standard column headers
- **JSON** — Flat snapshot arrays saved by the market recorder

The loader scans recursively through the full directory tree under `data/historical/`, so Betfair's nested folder structure (`data/BASIC/2026/Feb/1/<eventId>/`) is handled automatically. Date range filtering (`--from`/`--to`) uses the year/month/day from the folder path for speed, without opening files.

**`backtest/setDetector.js`**

Detects set completions by watching for price jumps of 15% or more in a runner's price history. A sudden price shift of that magnitude reliably marks the moment a set ended, without needing any score data. For each detected set boundary it captures the pre-set entry price (the last stable price before the jump) for both runners.

**`backtest/strategyReplayer.js`**

Loads the six set-based strategies from `config/strategies.json` and replays them against each market:

- At each detected set completion, evaluates whether the strategy would have triggered a bet
- If it would have, records the entry price, simulates holding through to a defined exit, and calculates P&L
- Accumulates results per strategy and overall

Returns a full summary with win rate, total P&L, ROI, per-strategy breakdown, and individual bet records.

**`backtest/reporter.js`**

Prints a formatted summary table to the console when a backtest completes.

**`backtest/runner.js`**

CLI entry point that wires everything together:

```
DataLoader → SetDetector → StrategyReplayer → Reporter → backtestDb.insertRun()
```

Accepts optional arguments:
- `--from YYYY-MM-DD` — only process files from this date onwards
- `--to YYYY-MM-DD` — only process files up to this date
- `--strategy StrategyName` — filter to one strategy
- `--notes "text"` — attach a note to the saved run

After completing, results are saved to `data/backtests.json` and immediately visible in the dashboard Backtests tab.

---

### Utilities

**`src/utils/logger.js`**

Dual-output logger (console + `bot.log` file). Levels: `debug`, `info`, `warn`, `error`. Respects the `LOG_LEVEL` environment variable.

**`src/utils/helpers.js`**

Shared utility functions: fuzzy player name normalisation and matching (`normaliseName`, `playerNamesMatch`), odds-to-probability conversion, and numeric `clamp`.

---

## Configuration Reference

### Environment Variables (.env)

| Variable | Required | Description | Example |
|---|---|---|---|
| `CBB_SERVICE` | Yes | CloudBetBot service name | `mybot` |
| `CBB_KEY` | Yes | CloudBetBot API access key | `abc123...` |
| `CBB_ID` | Yes | CloudBetBot service ID | `42` |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token | `8527...:AAF...` |
| `TELEGRAM_CHAT_ID` | Yes | Telegram chat ID to send alerts to | `-519863...` |
| `RAPIDAPI_KEY` | Yes | RapidAPI key for tennis live data | `134f04...` |
| `DRY_RUN` | No | If `true`, no real bets are placed | `true` |
| `BANKROLL_GBP` | No | Total bankroll in GBP, used for stake sizing calculations | `1000` |
| `DASHBOARD_ENABLED` | No | Enable the live dashboard | `true` |
| `DASHBOARD_PORT` | No | Dashboard HTTP port | `3000` |
| `LOG_LEVEL` | No | Log verbosity (`debug`, `info`, `warn`, `error`) | `info` |
| `BETFAIR_APP_KEY` | No | Betfair app key (used by the streaming API) | |

---

### strategies.json — Full Settings Guide

This file is **hot-reloadable** — changes take effect within 1 second without restarting the bot. It is split into five sections.

---

#### `probabilityModel` — How the bot calculates true win probability

| Setting | What it does |
|---|---|
| `minGamesForLiveStats` | How many games must be played before the bot starts using live serve data. Before this point it relies entirely on historical averages. Set to `3` by default — so the bot won't trust the first game or two of stats. |
| `fullTrustAfterGames` | After this many games the bot uses live serve stats exclusively, with no blending of historical data. Default is `10`. Between `minGamesForLiveStats` and this threshold the two are gradually blended. |
| `surfaceAdjustment` | `true` or `false`. When enabled, historical stats are looked up per surface (clay, hard, grass) rather than using an overall average. Recommended to leave on. |
| `surfaces` | The list of surfaces the bot will operate on. Any match played on a surface not in this list is ignored entirely. |

---

#### `signalEngine` — When to enter and exit bets

| Setting | What it does |
|---|---|
| `minEdgePercent` | The minimum edge required to consider a bet. Edge is the difference between the bot's calculated true probability and what the market odds imply. For example, if the bot thinks a player has a 60% chance of winning but the odds only imply 55%, the edge is 5%. Set to `3` — so the bot needs at least a 3-point edge. |
| `minMomentumToEnter` | The minimum momentum score (0–100) needed before entering a bet. Momentum tracks recent match dynamics like breaks of serve and game streaks. Set to `20` — the bot won't bet unless the player it's backing has some tangible recent momentum. |
| `minMatchedVolume` | The minimum amount of money (in GBP) that must already be matched on the market. This filters out illiquid markets where odds could move sharply. Set to `5000`. |
| `targetProfitPct` | If the position is currently showing a profit of this percentage or more, the bot will trade out (green up) to lock in the gain. Set to `50` — so the bot targets a 50% return before greening. |
| `stopLossPct` | If the position is showing a loss of this percentage or more, the bot will exit to limit further damage. Set to `30`. |
| `tradeOutMomentumThreshold` | If the momentum score rises above this number (against the bot's position), it will trade out regardless of profit/loss. Set to `40` — if the opponent gains strong momentum the bot exits early. |
| `onlyEntryAfterBreak` | `true` or `false`. If enabled, the bot will only enter a bet immediately after a break of serve has just occurred. Useful for systems that specifically trade break momentum. Currently `false`. |
| `requireServeMomentumAlignment` | `true` or `false`. If enabled, the bot will only bet when the current server's momentum is aligned with the bet direction. Prevents backing a player who is about to serve if they're in poor serving form. Currently `true`. |

---

#### `riskManager` — How much to stake and maximum exposure

| Setting | What it does |
|---|---|
| `kellyFractionMultiplier` | A multiplier applied to the calculated stake to scale it down. `0.25` means the bot bets at 25% of what the edge calculation suggests — a conservative setting that keeps stakes small. Higher values mean larger stakes. |
| `minStakeGBP` | The smallest stake the bot will ever place, regardless of the edge calculation. Set to `2`. |
| `maxStakeGBP` | The largest stake the bot will place on any single bet. Set to `50`. |
| `maxTotalExposureGBP` | The maximum total amount the bot can have at risk across all open bets at once. If placing a new bet would exceed this, the bet is rejected. Set to `200`. |
| `maxOpenPositions` | The maximum number of bets that can be open at the same time. Set to `5`. |

---

#### `filters` — Global match filters (apply to all systems)

| Setting | What it does |
|---|---|
| `allowedTournaments` | A whitelist of tournament names. If this list is empty (as it is by default) then all tournaments are allowed, subject to the blocked list. |
| `blockedTournaments` | Tournaments that are always excluded. `"ITF"` is blocked by default — these are lower-tier events with less liquidity. |
| `minOddsToBack` | The bot will not back a player whose odds are shorter than this. Set to `1.3` — avoids very heavy favourites where there's little value. |
| `maxOddsToBack` | The bot will not back a player whose odds are longer than this. Set to `6` — avoids long shots. |
| `minOddsToLay` | The bot will not lay a player whose odds are shorter than this. Set to `1.1`. |
| `maxOddsToLay` | The bot will not lay a player whose odds are longer than this. Set to `4`. |
| `surfaces` | Surfaces to operate on globally. Matches on any other surface are skipped. |

---

#### `systems` — Individual trading strategies

Each system in this array is a named strategy with its own filters and staking rules. The bot evaluates every live match against all enabled systems and uses the first one that qualifies.

**System-level fields:**

| Field | What it does |
|---|---|
| `name` | A label for the system, used in Telegram alerts and logs. |
| `description` | A human-readable summary of what the system is targeting. |
| `enabled` | `true` or `false`. Quickly enable or disable a system without deleting it. |
| `cbbStrategyKey` | The name of the strategy profile in CloudBetBot that this system maps to. CBB uses this to determine how the bet is placed and sized on the exchange. |

**System `filters` — override the global filters for this system:**

| Field | What it does |
|---|---|
| `surfaces` | Surfaces this system operates on. Overrides the global surfaces list. |
| `minEdgePercent` | Minimum edge required for this system (can be higher or lower than the global setting). |
| `minMomentum` | Minimum momentum score for this system. |
| `minMatchedVolume` | Minimum matched volume for this system. |
| `minOddsToBack` | Minimum back odds for this system. |
| `maxOddsToBack` | Maximum back odds for this system. |
| `minGamesPlayedInMatch` | Won't enter a bet until at least this many games have been played in the match. Useful for waiting for a clear picture to emerge before betting. |
| `requireServerMomentum` | `true` or `false`. If `true`, the bot only enters when the player being backed is also the current server and has serve-side momentum. |
| `requireBreakInCurrentSet` | `true` or `false`. If `true`, the bot only enters if a break of serve has already occurred in the current set — targeting matches with clear momentum patterns. |
| `allowedTournamentTiers` | Restrict the system to specific tournament categories, e.g. `grand_slam`, `atp1000`, `atp500`, `wta_premier`. Leave out to allow all. |
| `minFirstServeWinPct` | Only enter if the player's 1st-serve win percentage is at or above this threshold. Useful for systems focused on dominant servers (e.g. on grass). |

**System `staking` — stake sizing for this system:**

| Field | What it does |
|---|---|
| `kellyMultiplier` | Same as `kellyFractionMultiplier` in the global risk manager, but applies only to this system. Lets you be more aggressive or conservative on a per-system basis. |
| `minStakeGBP` | Minimum stake for bets placed by this system. |
| `maxStakeGBP` | Maximum stake for bets placed by this system. |

---

**The four systems currently in the config:**

| System | Surface | Odds range | Edge needed | Notes |
|---|---|---|---|---|
| SystemA | Hard only | 1.3 – 3.0 | 5% | Grand Slams and big ATP events only. Disabled. |
| SystemB | Clay only | 1.5 – 4.0 | 3% | Requires a break in the current set. Waits until 6 games in. Disabled. |
| SystemC | Grass only | 1.2 – 2.5 | 4% | Targets big servers with 75%+ 1st-serve win rate. Disabled. |
| Dads Odds | All surfaces | 1.8 – 2.2 | 0.1% | Broad entry in a tight odds band. Very low edge/momentum threshold. **Enabled.** |

---

## External APIs

### Betfair Streaming API

- **Endpoint**: `stream-api.betfair.com:443` (raw TLS)
- **Protocol**: BFLP (line-delimited JSON)
- **Auth**: Certificate + session token
- **Subscription**: Tennis in-play `MATCH_ODDS` markets

### RapidAPI — Tennis Live Data

- **Host**: `tennisapi1.p.rapidapi.com`
- **Key endpoints**:
  - `GET /api/tennis/events/live` — All in-progress matches
  - `GET /matchStatistics?matchId={id}` — Serve stats, break point data
  - `GET /tennisMatchDetails?matchId={id}` — Set scores, current game state
- **Auth**: `X-RapidAPI-Key` header

### CloudBetBot (CBB)

- **Endpoint**: `https://www.cloudbetbot.com/api/rpc/hooks/upsert_bets.php`
- **Method**: POST
- **Auth**: Service credentials in request body
- The bot does not call Betfair's betting API directly — all bet placement goes through CBB

### Telegram Bot API

- Communicates via the standard Telegram Bot API using long polling
- Credentials: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` environment variables

---

## Trading Logic Deep Dive

### Probability Model (Markov Chain)

The model calculates the probability that a player wins the match from any given score state by working upwards through three levels:

**1. Point → Game**

Given that a player wins each point on serve with probability `p`, the model recursively calculates `P(win game)`, handling the deuce-advantage loop.

**2. Game → Set**

From the current game score (e.g., 3-2), the model recursively calculates `P(win set)`, handling the tiebreak scenario at 6-6.

**3. Set → Match**

From the current set score (e.g., 1-0), the model recursively calculates `P(win match)`.

**Blending live and historical stats**

Before 10 games are played, live serve stats are blended with historical surface stats to avoid small-sample noise:

```
blended = (gamesPlayed / 10) × live + (1 − gamesPlayed / 10) × historical
```

After 10 games, live stats are used entirely.

---

### Momentum Detection

The momentum index represents recent match dynamics on a -100 to +100 scale:

| Component | Points | Condition |
|---|---|---|
| Break streak | +25 per break | Consecutive breaks of serve |
| Game streak | +10 per game | Games won without response |
| Serve efficiency | +15 | 1st-serve % increased >5pp recently |
| Double fault penalty | -10 each | More than 2 per set |
| Break point conversion | +15 | Conversion rate >50% |

**Decay**: All streak-based scores halve every 3 games without a new triggering event, so the index reflects what's happening now, not 20 minutes ago.

---

### Signal Engine

Entry conditions (all must be true):
- Edge ≥ `minEdgePercent` (true probability materially exceeds implied)
- Momentum score ≥ `minMomentumToEnter` and in the right direction
- Matched volume ≥ `minMatchedVolume`
- Match passes system filters (surface, tournament, odds range, games played)
- No existing open position on this market

Exit (TRADE_OUT) conditions (any one triggers):
- Edge reversed (market moved against our position)
- Momentum dropped below `tradeOutMomentumThreshold`
- Profit target reached (`targetProfitPct`)
- Stop-loss triggered (`stopLossPct`)

---

## Multi-System Architecture

Multiple named trading systems can be defined in `strategies.json`. This allows running different strategies simultaneously — for example:

- **"SystemA"**: High-confidence hard court only, large ATP events, aggressive stake
- **"Dads Odds"**: Broader filters, smaller stakes, any surface

Each system has its own:
- Filter set (surface, tournament tier, odds range, games played, momentum threshold, etc.)
- CBB strategy key (maps to a staking profile inside CloudBetBot)
- Staking overrides (stake multiplier, min/max stake)
- Priority (if multiple systems match, the first enabled one in the array wins)

A Telegram alert is sent the first time a match qualifies for a system in a session. If `strategies.json` is edited and reloaded, the notification cache resets.

---

## Backtesting

### Historical Data

The backtester reads from `data/historical/`. Two sources of data feed into it:

**1. Betfair Historical Data Service download**

Downloaded manually from [historicdata.betfair.com](https://historicdata.betfair.com). The downloaded files have a nested directory structure:

```
data/historical/data/BASIC/2026/Feb/1/<eventId>/1.XXXXXXXXX.bz2
```

Each `1.XXXXXXXXX.bz2` file is a Betfair market (one tennis match), compressed with bzip2. When decompressed, the file contains newline-delimited JSON in the Betfair Exchange Streaming API format — the same format as the live stream. The bot currently has data covering **January through mid-March 2026**, totalling approximately 35,000 market files.

The `dataLoader` handles this format natively — no manual extraction is needed. It recursively scans the entire folder tree and filters to only `MATCH_ODDS` markets with exactly 2 runners, skipping tournament outrights and multi-runner markets automatically.

**2. Market recorder (live auto-collection)**

While the live bot is running, `marketRecorder.js` automatically saves every match it watches to `data/historical/<marketId>.json`. These files are in the same format the backtester reads, so the match pool grows on its own over time without any manual work.

---

### Running a Backtest

**From the dashboard (recommended):**

1. Open `http://localhost:3000` and go to the **Backtests** tab
2. Click **▶ Run Backtest**
3. Fill in the date range, optional strategy filter, and optional notes
4. Click **▶ Start** — the modal closes and a blue progress strip appears showing live output
5. When the backtest finishes, the progress strip disappears and the results table refreshes automatically

**From the terminal:**

```bash
npm run backtest                          # all data, all strategies
npm run backtest -- --from 2026-02-01 --to 2026-02-28
npm run backtest -- --strategy Strategy1
npm run backtest -- --notes "Testing tighter odds filter"
```

In both cases results are saved to `data/backtests.json` and displayed in the dashboard. The dashboard does not need to be running for a terminal backtest to save — the results will appear when you open the Backtests tab.

**Refresh button**: Click **↻ Refresh** on the Backtests tab at any time to re-fetch the list without reloading the page. Useful if a terminal backtest just completed while you had the tab open.

---

### How the Backtester Works

1. **DataLoader** scans `data/historical/` recursively, applies the date filter, and returns the list of market files
2. For each file, it decompresses (if bz2) and parses the price history into a structured market object with two runners, each having a chronological list of price ticks
3. **SetDetector** analyses the price history of each runner looking for jumps ≥ 15% — these mark set completions. For each detected set boundary it captures the pre-set price for both runners
4. **StrategyReplayer** evaluates each of the six set-based strategies at each set boundary. If a strategy would have triggered, it simulates the bet: entry at the pre-set price, exit at the next major price move or end of market, and calculates P&L
5. **Reporter** prints a summary to the console
6. Results (summary + per-strategy breakdown + individual bets) are saved via **backtestDb**

**Clicking a row** in the Backtests table expands a detail panel showing:
- Per-strategy breakdown (bets, win rate, P&L, average odds)
- Every individual triggered bet (entry price, exit price, P&L, confidence, exit reason)

---

### Auto-Growing Match Pool

Once the bot is running live, the market recorder ensures the historical pool grows automatically:

- Every match the bot monitors is recorded to `data/historical/`
- When that market closes, the file is written and immediately available for the next backtest
- You don't need to re-download from Betfair — the data accumulates passively

The only manual step is the initial bulk download from historicdata.betfair.com to seed the pool. After that it's self-sustaining.

---

## Dry-Run Mode

Set `DRY_RUN=true` in `.env` to run without placing real bets. In this mode:

- CBB client logs "Would upsert bet" instead of sending HTTP requests
- All algorithm logic, Telegram alerts, and dashboard updates run normally
- Trade log entries are written with `[DRY_RUN]` prefix

This is the recommended mode for initial setup and testing.

---

## Dashboard & Monitoring

When `DASHBOARD_ENABLED=true`, an Express server starts on `DASHBOARD_PORT` (default `3000`).

Open `http://localhost:3000` in a browser to see three tabs:

**Live Trading tab:**
- Headline stat cards (P&L today, open bets, markets watched, win rate)
- Cumulative P&L chart — last 30 days
- Open positions table with live estimated P&L
- Live match states with odds, edge, momentum, and qualifying systems
- Settled trades from today

**Systems tab:**
- Live-edit global risk and signal settings
- Add, edit, enable/disable, and delete trading systems
- All changes auto-save to `strategies.json` and hot-reload into the live bot without restart

**Backtests tab:**
- **▶ Run Backtest** button — triggers a full backtest from the browser. Progress streams live via WebSocket. Results appear automatically when done.
- **↻ Refresh** button — re-fetches the runs list without reloading the page
- Runs table with date, period, P&L, ROI, win rate, average odds
- Click any row to expand the per-strategy breakdown and individual bet records

The dashboard is designed to stay running permanently. A ngrok tunnel (or similar reverse proxy) can expose it externally so you can check in from anywhere without the server ever coming down.

---

## Telegram Commands

| Command | Description |
|---|---|
| `/status` | Open positions, total exposure, today's P&L, markets being watched |
| `/matches [filter]` | Active matches with their current signal state |
| `/systems` | List all enabled trading systems |
| `/debug [name]` | Full `MatchState` JSON for a specific match |
| `/stop` | Graceful shutdown (cancels open orders first) |
| `/help` | List available commands |

---

## Dependencies

| Package | Purpose |
|---|---|
| `axios` | HTTP client for RapidAPI and CloudBetBot |
| `dotenv` | Load `.env` file |
| `express` | Dashboard REST API |
| `ws` | WebSocket for dashboard real-time updates |
| `node-telegram-bot-api` | Telegram alerts and command handling |
| `csv-writer` | Append rows to `trade_log.csv` |
| `zod` | Schema validation |
| `unbzip2-stream` | Pure-JavaScript bzip2 decompression for Betfair historical files |

---

## Setup & Running

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Fill in all required values (see [Environment Variables](#environment-variables-env)).

### 3. Configure trading systems

Edit `config/strategies.json` to set your thresholds, filters, and systems. You can do this while the bot is running — changes reload automatically. The Systems tab in the dashboard provides a UI for editing without touching the file directly.

### 4. Add historical data (for backtesting)

Place Betfair historical data files in `data/historical/`. The recommended way is:

1. Go to [historicdata.betfair.com](https://historicdata.betfair.com)
2. Log in with your Betfair account
3. Select **Sport: Tennis**, **Market Type: Match Odds**, **Data Type: Basic**
4. Download your date range — the files extract to a nested folder structure like `data/BASIC/2026/Feb/...`
5. Move that folder into `data/historical/` so the path becomes `data/historical/data/BASIC/...`

No extraction of the `.bz2` files is needed — the backtester handles them natively.

### 5. Test with dry-run

Set `DRY_RUN=true` in `.env`, then start:

```bash
node src/index.js
# or
npm start
```

Open `http://localhost:3000` to see the dashboard. Watch the Telegram alerts and dashboard to confirm everything is working.

### 6. Run a backtest

Click **▶ Run Backtest** in the dashboard Backtests tab, or from a terminal:

```bash
npm run backtest -- --from 2026-01-01 --to 2026-03-01
```

Review the results in the dashboard to validate the strategies before going live.

### 7. Go live

Set `DRY_RUN=false` and restart.

---

## Moving to a Dedicated PC

When moving to a separate machine to run continuously:

### Transfer the project

Copy the entire `tennis-bot/` folder, including:
- `data/historical/` — all the historical match data
- `data/backtests.json` — saved backtest results
- `config/strategies.json` — your tuned settings
- `.env` — your credentials

Do **not** copy `node_modules/` — run `npm install` fresh on the new machine.

### Install Node.js

Download and install Node.js (v18 or later recommended) from [nodejs.org](https://nodejs.org).

### Install dependencies

```bash
cd tennis-bot
npm install
```

### Set up ngrok for remote access

1. Download ngrok from [ngrok.com](https://ngrok.com) and create a free account
2. Run the bot: `npm start`
3. In a separate terminal: `ngrok http 3000`
4. ngrok gives you a public URL (e.g. `https://abc123.ngrok.io`) — this is your dashboard URL from anywhere

To keep ngrok running persistently, use a process manager:

```bash
# Install pm2
npm install -g pm2

# Start the bot
pm2 start src/index.js --name tennis-bot

# Start ngrok (or run ngrok separately)
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

### Keep it running on reboot

Using pm2 as above, the bot restarts automatically when the machine reboots. The ngrok URL changes each restart on the free plan — use a paid ngrok plan or a static reverse proxy if you need a permanent URL.

---

> **Note**: Never commit your `.env` file or SSL certificates. Credentials should be kept out of version control.
