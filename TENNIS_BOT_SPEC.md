# Tennis Trading Bot — Build Specification

> **For Claude Code**: Read this file in full before writing any code.
> Work through each phase in order. Do not skip ahead.
> Ask for clarification on any section marked ⚠️ before implementing it.

---

## Project Overview

Build a Node.js bot that:
1. Collects live tennis match data from multiple sources
2. Maintains a real-time match state object for every in-play match
3. Runs an algorithm to detect trading opportunities (entry and exit signals)
4. Places and manages bets on the Betfair Exchange via the Betfair API (not CloudBetBot)
5. Manages risk (stake sizing, stop loss, max exposure)
6. Sends Telegram notifications and logs all activity

This is NOT a signal relay like the football bot. This bot does its own thinking.

---

## Repository Structure

Create this folder structure before writing any code:

```
tennis-bot/
├── src/
│   ├── collector/
│   │   ├── betfairStream.js      # Betfair Exchange Streaming API client
│   │   ├── statsPoller.js        # Live stats poller (Sofascore or RapidAPI)
│   │   └── historicalLoader.js   # Loads pre-match player H2H and serve stats
│   ├── state/
│   │   ├── matchState.js         # Match state class and update logic
│   │   └── stateStore.js         # In-memory store of all active matches
│   ├── algorithm/
│   │   ├── probabilityModel.js   # True probability calculator from score + serve stats
│   │   ├── momentumDetector.js   # Momentum / pressure signals
│   │   └── signalEngine.js       # Combines signals → BET / TRADE_OUT / HOLD decision
│   ├── risk/
│   │   └── riskManager.js        # Kelly criterion stake sizing, stop loss, exposure cap
│   ├── execution/
│   │   ├── betfairClient.js      # Betfair REST API wrapper (place, update, cancel orders)
│   │   └── orderManager.js       # Tracks open positions, manages trade-out logic
│   ├── notifications/
│   │   └── telegram.js           # Telegram bot for alerts
│   ├── utils/
│   │   ├── logger.js             # File + console logger
│   │   └── helpers.js            # Shared utility functions
│   └── index.js                  # Entry point — wires everything together
├── data/
│   ├── serve_stats.json          # Cached player serve/return stats (refreshed daily)
│   └── trade_log.csv             # Full trade history for P&L analysis
├── config/
│   └── strategies.json           # Strategy parameters (editable without code changes)
├── .env                          # Credentials — never commit this
├── .env.example                  # Template showing required env vars
├── package.json
└── README.md
```

---

## Phase 1 — Project Setup

### 1.1 package.json dependencies

```json
{
  "dependencies": {
    "axios": "^1.6.0",
    "dotenv": "^16.0.0",
    "node-telegram-bot-api": "^0.64.0",
    "betfair-api-ng": "^1.1.5",
    "ws": "^8.16.0",
    "csv-writer": "^1.6.0",
    "zod": "^3.22.0"
  }
}
```

### 1.2 .env.example

```
# Betfair credentials
BETFAIR_USERNAME=
BETFAIR_PASSWORD=
BETFAIR_APP_KEY=
BETFAIR_CERT_PATH=./certs/client-2048.crt
BETFAIR_KEY_PATH=./certs/client-2048.key

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Stats API (choose one)
RAPIDAPI_KEY=
SOFASCORE_BASE_URL=https://api.sofascore.com/api/v1

# Algorithm settings (can also go in config/strategies.json)
MIN_EDGE_PERCENT=3          # minimum edge over market price to trigger bet
MAX_STAKE_GBP=50            # hard cap per bet
MAX_OPEN_POSITIONS=5        # max concurrent open bets
BANKROLL_GBP=1000           # total bankroll for Kelly sizing

# Toggle dry run mode (no real bets placed)
DRY_RUN=true
```

### 1.3 Logger (src/utils/logger.js)

Simple timestamped logger that writes to both console and `bot.log`.
Must handle log levels: INFO, WARN, ERROR, DEBUG.
DEBUG lines only print if `process.env.LOG_LEVEL=debug`.

---

## Phase 2 — Data Collection

### 2.1 Betfair Exchange Streaming (src/collector/betfairStream.js)

Use the Betfair Exchange Streaming API (WSS, not REST polling) to receive real-time:
- Market odds changes
- Matched volume
- Order book depth

**Connection details:**
- Endpoint: `wss://stream-api.betfair.com:443/api/stream`
- Auth: Uses the same session token as REST API
- Protocol: BFLP (line-delimited JSON)

**What to stream:**
- Tennis markets only (eventTypeId = "2")
- In-play markets only
- Market types: MATCH_ODDS, SET_BETTING, GAME_BETTING

**What to extract per market update:**
```javascript
{
  marketId: "1.234567890",
  eventId: "12345678",
  matchName: "Djokovic v Alcaraz",
  marketType: "MATCH_ODDS",
  runners: [
    {
      selectionId: 12345,
      name: "Djokovic",
      backPrice: 1.85,      // best available back
      layPrice: 1.90,       // best available lay
      lastTradedPrice: 1.87,
      matchedVolume: 45200
    }
  ],
  inPlay: true,
  status: "OPEN",
  timestamp: 1710000000000
}
```

**Implementation notes:**
- Reconnect automatically on disconnect (exponential backoff, max 30s)
- Emit events using Node.js EventEmitter so other modules can subscribe
- Clk and initialClk tokens must be stored and sent on reconnect for delta updates
- Handle heartbeat messages (send back if server requests)

### 2.2 Live Stats Poller (src/collector/statsPoller.js)

Poll a stats source every 15 seconds for in-play match data.

**Preferred source: RapidAPI Tennis Live Scores**
Endpoint example: `GET https://tennis-live-data.p.rapidapi.com/matches-by-date/{date}`

**What to extract per match update:**
```javascript
{
  externalMatchId: "abc123",      // ID in the stats source
  matchName: "Djokovic v Alcaraz",
  tournamentName: "Roland Garros",
  surface: "clay",                // clay | hard | grass | carpet
  round: "QF",
  sets: [
    { playerA: 6, playerB: 4 },
    { playerA: 3, playerB: 2 }   // current set
  ],
  currentGame: { playerA: 30, playerB: 15 },  // in game score
  currentServer: "playerA",
  serveStats: {
    playerA: { firstServeIn: 68, firstServeWon: 74, secondServeWon: 52, aces: 4, doubleFaults: 1 },
    playerB: { firstServeIn: 61, firstServeWon: 71, secondServeWon: 48, aces: 2, doubleFaults: 3 }
  },
  breakPoints: {
    playerA: { created: 5, converted: 2 },
    playerB: { created: 3, converted: 1 }
  },
  timestamp: 1710000000000
}
```

**Implementation notes:**
- Match the stats source match to a Betfair market using fuzzy name matching
  (reuse the `teamNamesMatch` pattern from the football bot, adapted for player names)
- If a match cannot be linked to a Betfair market, log a warning but continue
- Store the last 50 stat updates per match in a rolling buffer for momentum calculation

### 2.3 Historical Data Loader (src/collector/historicalLoader.js)

Before a match starts (or at bot startup), load pre-match player stats.

**What to load:**
- Career serve win % on specific surface
- Recent form (last 10 matches win/loss)
- H2H record between these two players

**Source options (in order of preference):**
1. ATP/WTA official API (if available with your key)
2. RapidAPI tennis statistics endpoint
3. Stored locally in `data/serve_stats.json` as fallback

**Output format per player:**
```javascript
{
  playerId: "djokovic-novak",
  name: "Novak Djokovic",
  surfaceStats: {
    clay:  { serveWin: 0.71, returnWin: 0.44, holdPct: 0.87, breakPct: 0.42 },
    hard:  { serveWin: 0.74, returnWin: 0.46, holdPct: 0.89, breakPct: 0.44 },
    grass: { serveWin: 0.76, returnWin: 0.43, holdPct: 0.91, breakPct: 0.41 }
  },
  recentForm: [1, 1, 0, 1, 1, 0, 1, 1, 1, 0],   // 1 = win, 0 = loss, index 0 = most recent
  h2h: {}  // populated per match pairing
}
```

Refresh `data/serve_stats.json` once daily at midnight.

---

## Phase 3 — Match State

### 3.1 Match State Class (src/state/matchState.js)

One instance per live match. Holds the unified view of everything the algorithm needs.

```javascript
class MatchState {
  constructor(betfairMarketId, matchName) {
    this.betfairMarketId = betfairMarketId;
    this.matchName = matchName;

    // Score
    this.sets = [];
    this.currentGame = { playerA: 0, playerB: 0 };
    this.currentServer = null;
    this.surface = null;

    // Live odds
    this.playerABack = null;
    this.playerALay = null;
    this.playerBBack = null;
    this.playerBLay = null;
    this.matchedVolume = 0;

    // Serve stats (live, updated as match progresses)
    this.liveServeStats = {};

    // Pre-match baseline (from historicalLoader)
    this.historicalStats = {};

    // Momentum index — computed by momentumDetector
    // Range: -100 (playerB dominating) to +100 (playerA dominating)
    this.momentumIndex = 0;

    // True probability — computed by probabilityModel
    this.trueProbabilityA = null;
    this.trueProbabilityB = null;

    // Edge — difference between true probability and market implied probability
    this.edgeA = null;
    this.edgeB = null;

    // State tracking
    this.lastUpdated = null;
    this.isInPlay = false;
    this.status = "INACTIVE";  // INACTIVE | LIVE | SUSPENDED | CLOSED
  }

  // Merge an odds update from betfairStream
  applyOddsUpdate(oddsData) { ... }

  // Merge a stats update from statsPoller
  applyStatsUpdate(statsData) { ... }

  // Recompute derived fields (momentum, true probability, edge)
  recompute() { ... }

  // Return a plain object snapshot for logging
  toSnapshot() { ... }
}
```

### 3.2 State Store (src/state/stateStore.js)

An in-memory Map keyed by Betfair marketId.

```javascript
class StateStore {
  constructor() {
    this.matches = new Map();   // marketId → MatchState
    this.closedMatches = [];    // archive for logging
  }

  upsert(marketId, update) { ... }   // create or update MatchState
  get(marketId) { ... }
  getAll() { ... }
  close(marketId) { ... }            // move to archive, clear from active
  linkStatsToMarket(externalId, marketId) { ... }  // mapping from stats → betfair
}
```

---

## Phase 4 — Algorithm Engine

> ⚠️ This is the most important phase. The quality of this logic determines profitability. Build it carefully and make every parameter configurable in `config/strategies.json`.

### 4.1 Probability Model (src/algorithm/probabilityModel.js)

**Purpose:** Given the current score state and serve statistics, compute the true win probability for each player independent of the market price.

**Method — Markov chain serve model:**

Tennis win probability can be modelled precisely using a recursive Markov chain:
- At any score state, if player A is serving with p_serve probability of winning the point, and player B is returning with p_return probability, the game win probability can be computed exactly from that point
- This scales up from game → set → match

**Implementation steps:**

1. `pointWinProb(p)` — given probability p of winning a serve point, compute probability of winning the current game from (0,0)
   - Use the standard tennis game Markov chain formula
   - Handle deuce scenarios (40-40 onward uses the geometric series formula)

2. `gameWinProb(holdPct, breakPct, gamesA, gamesB, server)` — given current game score in the set, compute probability of winning the set

3. `setWinProb(setsA, setsB, gameProbs)` — given current sets score, compute match win probability

4. `computeTrueProbability(matchState)` — top-level function that:
   - Reads current score from matchState
   - Uses live serve stats if available (prefer these once 3+ games played)
   - Falls back to historical surface stats if match is early
   - Blends live and historical stats: `blend = min(gamesPlayed / 10, 1.0)` — full trust in live data after 10 games
   - Returns `{ playerA: 0.62, playerB: 0.38 }`

**Key parameters (in config/strategies.json):**
```json
{
  "probabilityModel": {
    "minGamesForLiveStats": 3,
    "fullTrustAfterGames": 10,
    "surfaceAdjustment": true
  }
}
```

### 4.2 Momentum Detector (src/algorithm/momentumDetector.js)

**Purpose:** Detect when one player has momentum — useful for timing entries and exits.

**Signals to track:**

1. **Break streak** — has a player broken serve consecutively? +25 per consecutive break
2. **Game streak** — has a player won the last N games without response? +10 per game in streak
3. **Serve efficiency trend** — is first serve % climbing or dropping in the rolling 50-point buffer? +15 if climbing >5%
4. **Double fault pressure** — has a player hit 2+ double faults in the current set? -10 per fault over threshold
5. **Break point conversion rate** — ratio of converted vs created break points this match. High = +15

**Momentum index formula:**
```
momentumIndex = clamp(
  breakStreakScore + gameStreakScore + serveEfficiencyScore +
  doubleFaultPenalty + breakConversionScore,
  -100, 100
)
```

**Output:** A number from -100 to +100, where positive = playerA momentum, negative = playerB momentum.

**Important:** Momentum decays — halve the streak scores after 3 games without a momentum event.

### 4.3 Signal Engine (src/algorithm/signalEngine.js)

**Purpose:** Combine probability edge and momentum to produce a trading decision.

**Decision outputs:**
```javascript
{
  action: "BET_BACK_A" | "BET_BACK_B" | "BET_LAY_A" | "BET_LAY_B" | "TRADE_OUT" | "HOLD",
  confidence: 0.0 – 1.0,
  reason: "string explaining why",
  suggestedOdds: 1.85,
  marketId: "1.234567890",
  selectionId: 12345
}
```

**Entry signal logic:**

```
IF edge > MIN_EDGE_PERCENT
AND abs(momentumIndex) > 20                   ← some momentum required
AND momentumDirection aligns with edge        ← momentum favours the underpriced player
AND matchedVolume > 5000                      ← enough liquidity
AND no open position on this market
AND market is in-play and not suspended
THEN: BET in direction of edge
```

**Exit signal logic (TRADE_OUT):**

Trigger a trade out (lay the back bet or back the lay bet to green up) when:
- Edge has reversed (market now correctly priced or overpriced against position)
- Momentum has swung strongly against the position (momentumIndex crosses -40 if long playerA)
- A break of serve has occurred against the backed player
- P&L on the position has reached the target profit (configurable, default 50% of liability)
- P&L on the position has hit the stop loss (configurable, default -30% of stake)

**Key parameters (in config/strategies.json):**
```json
{
  "signalEngine": {
    "minEdgePercent": 3,
    "minMomentumToEnter": 20,
    "minMatchedVolume": 5000,
    "targetProfitPct": 50,
    "stopLossPct": 30,
    "tradeOutMomentumThreshold": 40
  }
}
```

---

## Phase 5 — Risk Manager

### 5.1 riskManager.js

**Purpose:** Calculate stake size and enforce exposure limits before any bet is sent.

**Stake sizing — fractional Kelly:**

```
kellyFraction = (edge * bankroll) / (odds - 1)
actualStake = kellyFraction * KELLY_FRACTION_MULTIPLIER   ← use 0.25 (quarter Kelly) to be conservative
actualStake = min(actualStake, MAX_STAKE_GBP)
actualStake = max(actualStake, MIN_STAKE_GBP)             ← Betfair minimum is £2
```

**Exposure checks before placing:**
1. Total open liability across all bets must not exceed `MAX_TOTAL_EXPOSURE_GBP`
2. No more than `MAX_OPEN_POSITIONS` bets at once
3. No more than 1 open bet per market at a time
4. If `DRY_RUN=true`, approve all bets but do not send to Betfair

**Output:**
```javascript
{
  approved: true | false,
  rejectionReason: null | "string",
  recommendedStake: 12.50,
  projectedLiability: 10.63
}
```

**Parameters (config/strategies.json):**
```json
{
  "riskManager": {
    "kellyFractionMultiplier": 0.25,
    "minStakeGBP": 2,
    "maxStakeGBP": 50,
    "maxTotalExposureGBP": 200,
    "maxOpenPositions": 5
  }
}
```

---

## Phase 6 — Execution Layer

### 6.1 Betfair Client (src/execution/betfairClient.js)

Wrap the Betfair API (use the `betfair-api-ng` npm package or direct HTTPS calls to `https://api.betfair.com/exchange/betting/json-rpc/v1`).

**Required operations:**

```javascript
// Login (certificate-based — required for in-play betting)
async login()

// List markets (used to resolve market IDs)
async listMarketCatalogue({ eventTypeIds: ["2"], inPlayOnly: true, marketTypes: ["MATCH_ODDS"] })

// Place a back or lay bet
async placeOrder({ marketId, selectionId, side: "BACK"|"LAY", price, size })

// Update an existing order (reprice)
async updateOrder({ marketId, betId, newPrice })

// Cancel an order
async cancelOrder({ marketId, betId })

// Get current orders (to track P&L)
async listCurrentOrders()

// Get market book (spot-check prices before placing)
async listMarketBook(marketIds)
```

**Authentication notes:**
- Betfair requires certificate-based login for in-play API betting (not username/password alone)
- The cert files go in `./certs/` (never commit these)
- Session token expires after ~8 hours — implement auto-refresh

### 6.2 Order Manager (src/execution/orderManager.js)

Tracks every open position and manages the lifecycle from placement to settlement.

```javascript
class OrderManager {
  constructor(betfairClient) {
    this.openOrders = new Map();   // betId → order object
    this.settledOrders = [];
  }

  async placeBack(marketId, selectionId, odds, stake) { ... }
  async placeLay(marketId, selectionId, odds, stake) { ... }
  async tradeOut(marketId, selectionId) { ... }  // greens up the position
  async cancelAll(marketId) { ... }

  getOpenPositionForMarket(marketId) { ... }
  getCurrentPnL(betId) { ... }
  logToCSV(order) { ... }   // append to data/trade_log.csv
}
```

**Trade-out logic:**
When a TRADE_OUT signal arrives for a market where we have an open back bet at odds X with stake S:
- Calculate the green-up lay stake: `layStake = (backStake * backOdds) / currentLayOdds`
- Place that lay bet so that profit is equal regardless of outcome
- Log both legs to trade_log.csv

---

## Phase 7 — Notifications

### 7.1 Telegram (src/notifications/telegram.js)

Use `node-telegram-bot-api`.

**Send on these events:**

| Event | Message format |
|-------|---------------|
| Bet placed | `✅ BET PLACED — [Match]\nBacking [Player] @ [Odds]\nStake: £[X] | Edge: [Y]%\nReason: [reason]` |
| Trade out | `📤 TRADED OUT — [Match]\nGreen book: £[profit]\nReason: [reason]` |
| Stop loss hit | `🛑 STOP LOSS — [Match]\nLoss: £[amount]\nPosition closed.` |
| Error | `❌ ERROR: [message]` |
| Startup | `🎾 Tennis bot online. Monitoring [N] live markets.` |
| No liquidity | `⚠️ Skipped [Match] — volume too low ([vol])` |

**Also implement `/status` command** — when sent to the Telegram bot, reply with:
```
🎾 Tennis Bot Status
Open positions: N
Total exposure: £X
Matched today: £Y
P&L today: £Z (estimated)
Markets monitored: N
```

---

## Phase 8 — Entry Point

### 8.1 index.js

The main file wires everything together. Startup sequence:

1. Load `.env` and `config/strategies.json`
2. Initialise logger
3. Initialise Telegram notifier
4. Login to Betfair — exit and alert on failure
5. Load historical player stats → stateStore
6. Start Betfair streaming client — subscribe to all live tennis markets
7. Start stats poller on 15s interval
8. Start signal engine on 5s interval (reads stateStore, emits decisions)
9. Signal engine decisions → risk manager → order manager
10. Send startup notification

**Main loop (every 5 seconds):**
```
for each match in stateStore:
  if match.isInPlay and match.status === "LIVE":
    decision = signalEngine.evaluate(match)
    if decision.action !== "HOLD":
      approval = riskManager.check(decision)
      if approval.approved:
        orderManager.execute(decision, approval.recommendedStake)
        telegram.notify(decision, approval)
```

**Graceful shutdown (SIGINT/SIGTERM):**
- Cancel all open orders on Betfair
- Log final positions
- Send Telegram notification
- Exit cleanly

---

## Phase 9 — Configuration File

### config/strategies.json

This is the single file to tune without touching code:

```json
{
  "probabilityModel": {
    "minGamesForLiveStats": 3,
    "fullTrustAfterGames": 10,
    "surfaceAdjustment": true,
    "surfaces": ["clay", "hard", "grass"]
  },
  "signalEngine": {
    "minEdgePercent": 3.0,
    "minMomentumToEnter": 20,
    "minMatchedVolume": 5000,
    "targetProfitPct": 50,
    "stopLossPct": 30,
    "tradeOutMomentumThreshold": 40,
    "onlyEntryAfterBreak": false,
    "requireServeMomentumAlignment": true
  },
  "riskManager": {
    "kellyFractionMultiplier": 0.25,
    "minStakeGBP": 2,
    "maxStakeGBP": 50,
    "maxTotalExposureGBP": 200,
    "maxOpenPositions": 5
  },
  "filters": {
    "allowedTournaments": [],
    "blockedTournaments": ["ITF"],
    "minOddsToBack": 1.30,
    "maxOddsToBack": 6.00,
    "minOddsToLay": 1.10,
    "maxOddsToLay": 4.00,
    "surfaces": ["clay", "hard", "grass"]
  }
}
```

---

## Phase 10 — README

Create `README.md` covering:

1. Prerequisites (Node.js 18+, Betfair account with API access, valid SSL cert for in-play, Telegram bot)
2. How to get a Betfair API certificate (link to Betfair developer docs)
3. How to get the Telegram bot token and chat ID
4. `.env` setup instructions
5. How to run: `npm install && node src/index.js`
6. How to set `DRY_RUN=true` for paper trading
7. How to read the trade log at `data/trade_log.csv`
8. How to tune the strategy via `config/strategies.json` without touching code

---

## Build Order for Claude Code

Work through phases in this exact order. Complete and test each phase before starting the next.

1. **Phase 1** — Scaffold folders, package.json, .env.example, logger
2. **Phase 3** — MatchState and StateStore (pure logic, no external deps — easiest to test)
3. **Phase 4** — Algorithm engine (probabilityModel first, then momentum, then signalEngine)
4. **Phase 5** — Risk manager
5. **Phase 2** — Data collectors (Betfair stream + stats poller)
6. **Phase 6** — Execution layer (betfairClient + orderManager)
7. **Phase 7** — Telegram notifications
8. **Phase 8** — index.js entry point
9. **Phase 9** — config/strategies.json
10. **Phase 10** — README

> ⚠️ Do NOT build Phase 6 (live order execution) until DRY_RUN mode has been tested end-to-end with real streaming data. Real money is at stake.

---

## Testing Notes

### Unit tests to write (at minimum):
- `probabilityModel.test.js` — known score states should produce known probabilities (verify against published tennis Markov chain tables)
- `momentumDetector.test.js` — feed in a sequence of game results, check index moves correctly
- `riskManager.test.js` — edge cases: zero edge, max exposure hit, Kelly produces negative stake

### Manual integration test before going live:
1. Set `DRY_RUN=true`
2. Run bot during a live Grand Slam day session
3. Confirm match state is being populated correctly (add a `/debug [matchName]` Telegram command that dumps the full MatchState as JSON)
4. Confirm signals are firing and being logged
5. Confirm Telegram alerts arrive correctly
6. Only then set `DRY_RUN=false` with a small bankroll

---

## Important Betfair API Notes

- In-play betting via API requires a **non-interactive application key** (the "Delayed" key is free but adds a 3-second delay to prices). Get a live key from the Betfair Developer Programme.
- In-play API orders also require **certificate-based authentication** — username/password alone is blocked for in-play.
- Betfair minimum bet is **£2.00**.
- The API has a rate limit — do not poll REST endpoints more than 20 req/min. Use streaming for prices.
- Markets go SUSPENDED briefly after each point in-play. Do not place orders during suspension (the API will reject them). Check `status !== "SUSPENDED"` before every order.

---

## Reference: Football Bot Patterns to Reuse

The existing `listener.js` has good patterns worth carrying over:
- `teamNamesMatch()` fuzzy name matching → adapt for player name matching
- `catalogueCache` TTL cache pattern → reuse for stats API responses
- `sendNotification()` + `log()` pattern → replace with the new logger + telegram modules
- `uncaughtException` / `unhandledRejection` global handlers → copy as-is
- Graceful crash notification → keep this, extend to also cancel open orders

---

*End of specification. Start with Phase 1.*
