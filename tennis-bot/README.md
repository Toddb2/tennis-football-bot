# Tennis Trading Bot

A Node.js bot that monitors live tennis matches on the Betfair Exchange, computes true win probabilities using a Markov chain model, and places/manages in-play trades automatically.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 18+ | Uses `Map`, optional chaining, `Promise.allSettled` |
| Betfair account | Must have API access enabled |
| Betfair non-interactive application key | Required for in-play betting via API |
| Betfair SSL client certificate | Required for certificate-based login |
| Telegram bot token + chat ID | For notifications and `/status` command |

---

## 1. Betfair API Certificate

In-play betting via the Betfair API requires **certificate-based authentication** — username/password alone is blocked for in-play orders.

**Steps:**

1. Log in to the [Betfair Developer Portal](https://developer.betfair.com/)
2. Go to **API Access** → **Create application key** to get your App Key
3. Generate a self-signed SSL certificate and key pair:
   ```bash
   openssl req -x509 -nodes -days 1825 -newkey rsa:2048 \
     -keyout client-2048.key \
     -out client-2048.crt
   ```
4. Upload `client-2048.crt` to the Betfair Developer Portal under **SSL Certificates**
5. Place both files in `./certs/` (this directory is gitignored):
   ```
   tennis-bot/
   └── certs/
       ├── client-2048.crt
       └── client-2048.key
   ```

> **Never commit your cert or key files.** Add `certs/` to `.gitignore`.

---

## 2. Telegram Bot Setup

1. Open Telegram and message **@BotFather**
2. Send `/newbot` and follow the prompts — you'll receive a **bot token**
3. Start a conversation with your new bot, then visit:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
4. Send a message to your bot, then reload that URL — your **chat ID** appears in the JSON response under `message.chat.id`

---

## 3. Environment Setup

Copy the example file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```
# Betfair credentials
BETFAIR_USERNAME=your.email@example.com
BETFAIR_PASSWORD=your_betfair_password
BETFAIR_APP_KEY=your_app_key
BETFAIR_CERT_PATH=./certs/client-2048.crt
BETFAIR_KEY_PATH=./certs/client-2048.key

# Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
TELEGRAM_CHAT_ID=987654321

# Stats source
SOFASCORE_BASE_URL=https://api.sofascore.com/api/v1

# Risk settings
BANKROLL_GBP=1000

# Paper trading (no real bets placed)
DRY_RUN=true

# Logging
LOG_LEVEL=info

# Dashboard
DASHBOARD_ENABLED=true
DASHBOARD_PORT=3000
```

---

## 4. Installation and Running

```bash
# Install dependencies
npm install

# Run in paper trading mode (DRY_RUN=true in .env)
node src/index.js

# Run tests
npm test
```

The bot will:
1. Log in to Betfair using certificate auth
2. Connect to the Betfair Exchange Streaming API for live odds
3. Start polling Sofascore every 15 seconds for live match stats
4. Evaluate every live match every 5 seconds
5. Send a Telegram startup notification

---

## 5. Live Dashboard

When `DASHBOARD_ENABLED=true`, a live web dashboard is available at:

```
http://localhost:3000
```

It shows:
- Today's P&L and win rate
- Open positions with estimated live P&L
- All live match states (score, odds, edge, momentum bar)
- Settled trades for the day
- 30-day cumulative P&L chart

The dashboard updates in real time via WebSocket — no page refreshes needed.

---

## 6. Paper Trading (DRY_RUN)

Set `DRY_RUN=true` in `.env` (the default). In this mode:

- All bets are **simulated** — nothing is sent to Betfair
- Fake bet IDs are generated (`DRY-{timestamp}-{random}`)
- All logging, Telegram notifications, and CSV writes still happen normally
- The dashboard shows the simulated positions

This lets you verify the bot is making sensible decisions before risking real money.

To go live: set `DRY_RUN=false` and run against a small bankroll first.

---

## 7. Trade Log

Every order is appended to `data/trade_log.csv` with this schema:

| Column | Description |
|---|---|
| `timestamp` | ISO 8601 UTC timestamp |
| `marketId` | Betfair market ID |
| `matchName` | e.g. `Djokovic v Alcaraz` |
| `action` | `BACK`, `LAY`, or `SETTLE` |
| `player` | Player name backed/laid |
| `odds` | Price at placement |
| `stake` | Stake in GBP |
| `liability` | Maximum loss on this order |
| `pnl` | Realised P&L on settlement (blank until settled) |
| `reason` | Signal engine reason string |

The dashboard reads this file to compute all P&L stats. You can also open it in Excel.

---

## 8. Tuning the Strategy

All algorithm parameters live in `config/strategies.json` — no code changes needed:

```json
{
  "probabilityModel": {
    "minGamesForLiveStats": 3,
    "fullTrustAfterGames": 10,
    "surfaceAdjustment": true
  },
  "signalEngine": {
    "minEdgePercent": 3.0,
    "minMomentumToEnter": 20,
    "minMatchedVolume": 5000,
    "targetProfitPct": 50,
    "stopLossPct": 30,
    "tradeOutMomentumThreshold": 40
  },
  "riskManager": {
    "kellyFractionMultiplier": 0.25,
    "minStakeGBP": 2,
    "maxStakeGBP": 50,
    "maxTotalExposureGBP": 200,
    "maxOpenPositions": 5
  },
  "filters": {
    "blockedTournaments": ["ITF"],
    "minOddsToBack": 1.30,
    "maxOddsToBack": 6.00,
    "minOddsToLay": 1.10,
    "maxOddsToLay": 4.00
  }
}
```

**Key parameters explained:**

| Parameter | Effect |
|---|---|
| `minEdgePercent` | Minimum difference between model probability and market-implied probability to trigger a bet. Raise to be more selective. |
| `minMomentumToEnter` | Momentum index threshold (0–100) required to enter. Higher = only enter on strong momentum. |
| `targetProfitPct` | Trade out when unrealised P&L reaches this % of the original stake. Default 50% means take profit at +50%. |
| `stopLossPct` | Force close position when loss reaches this % of stake. Default 30% means cut at -30%. |
| `kellyFractionMultiplier` | Fraction of full Kelly stake to use. 0.25 = quarter-Kelly (conservative). |
| `maxTotalExposureGBP` | Hard cap on total simultaneous liability across all open bets. |
| `maxOpenPositions` | Maximum number of concurrent open bets. |

---

## 9. Telegram Commands

Once the bot is running, send commands to your Telegram bot:

| Command | Response |
|---|---|
| `/status` | Live summary: open positions, total exposure, today's P&L, markets monitored |
| `/debug [match name]` | Full JSON dump of a match's internal state (score, odds, probabilities, momentum) |

---

## 10. Project Structure

```
tennis-bot/
├── src/
│   ├── algorithm/
│   │   ├── probabilityModel.js   # Markov chain true probability calculator
│   │   ├── momentumDetector.js   # Momentum index from serve/break streaks
│   │   └── signalEngine.js       # Combines edge + momentum → BET/TRADE_OUT/HOLD
│   ├── collector/
│   │   ├── betfairStream.js      # Betfair Exchange Streaming API (live odds via WSS)
│   │   ├── statsPoller.js        # Sofascore live stats poller (score, serve stats)
│   │   └── historicalLoader.js   # Pre-match player stats from local JSON / RapidAPI
│   ├── dashboard/
│   │   ├── server.js             # Express + WebSocket dashboard server
│   │   └── public/               # Static dashboard frontend (HTML/CSS/JS)
│   ├── execution/
│   │   ├── betfairClient.js      # Betfair REST API wrapper (cert auth, place/cancel orders)
│   │   └── orderManager.js       # Open position tracking, trade-out logic, CSV logging
│   ├── notifications/
│   │   └── telegram.js           # Telegram alerts + /status and /debug commands
│   ├── risk/
│   │   └── riskManager.js        # Kelly stake sizing and exposure checks
│   ├── state/
│   │   ├── matchState.js         # Per-match state: score, odds, probabilities, momentum
│   │   └── stateStore.js         # In-memory store of all active matches
│   ├── utils/
│   │   ├── logger.js             # Timestamped logger (console + bot.log)
│   │   └── helpers.js            # Shared utilities (fuzzy name matching, etc.)
│   └── index.js                  # Entry point — startup, main loop, graceful shutdown
├── config/
│   └── strategies.json           # All tunable parameters
├── data/
│   ├── serve_stats.json          # Cached historical player serve stats
│   └── trade_log.csv             # Full trade history
├── certs/                        # Betfair SSL certificate (gitignored)
├── .env                          # Credentials (gitignored)
├── .env.example                  # Credential template
└── package.json
```

---

## 11. Important Betfair Notes

- **Non-interactive app key required** — the free "Delayed" key adds a 3-second price delay. Apply for a live key via the [Betfair Developer Programme](https://developer.betfair.com/) for real-time prices.
- **Markets suspend briefly after each point** in-play. The bot checks `status !== "SUSPENDED"` before placing any order; the API will reject orders placed during suspension.
- **Minimum bet is £2.00** — the risk manager enforces this as `minStakeGBP`.
- **Session tokens expire after ~8 hours** — the client auto-refreshes 5 minutes before expiry.
- **Rate limit** — do not exceed 20 REST requests/minute. The bot uses streaming for all price updates; REST calls are only made for order placement.
