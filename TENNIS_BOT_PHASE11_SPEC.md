# Tennis Bot — Phase 11 Addon Specification

> **For Claude Code**: Phases 1–10 of the tennis bot are already complete.
> This file adds Phase 11 which covers four things:
>   A) SQLite storage for backtest runs
>   B) Backtesting tab on the live dashboard
>   C) ngrok setup for sharing the dashboard with others
>   D) VPS deployment guide for 24/7 running
>
> Read this file in full before writing any code.
> Work through sections A, B, C, D in order.
> Stop and wait for review between each section.

---

## Phase 11A — SQLite Backtest Storage

Right now the backtester runs and produces a report but saves nothing permanently.
This section adds a SQLite database so every backtest run is stored and comparable.

---

### Why SQLite

- No server required — it's just a file (`data/backtest.db`)
- Works perfectly for this use case — read-heavy, single user
- Easy to query and inspect with free tools like DB Browser for SQLite
- Carries straight into the platform spec later (swap to PostgreSQL)

---

### New files

```
tennis-bot/
├── backtest/
│   ├── db.js              # SQLite client + schema setup
│   └── ...existing files
├── data/
│   └── backtest.db        # Created automatically on first run
```

Add to package.json:
```json
"better-sqlite3": "^9.4.0"
```

---

### 11A.1 Database schema (backtest/db.js)

```javascript
// Opens (or creates) data/backtest.db on first call
// Creates tables if they don't exist
// Exports db instance and helper functions
```

```sql
-- One row per backtest run
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at        TEXT NOT NULL,          -- ISO timestamp
  from_date     TEXT NOT NULL,
  to_date       TEXT NOT NULL,
  config        TEXT NOT NULL,          -- JSON string of strategies.json used
  markets       INTEGER,
  bets          INTEGER,
  win_rate      REAL,
  total_pnl     REAL,
  roi           REAL,
  max_drawdown  REAL,
  avg_edge      REAL,
  avg_odds      REAL,
  notes         TEXT                    -- optional label e.g. "increased edge to 4%"
);

-- One row per simulated bet within a run
CREATE TABLE IF NOT EXISTS run_bets (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER REFERENCES runs(id),
  market_id     TEXT,
  match_name    TEXT,
  surface       TEXT,
  tournament    TEXT,
  side          TEXT,
  odds          REAL,
  stake         REAL,
  action        TEXT,   -- BET_PLACED | TRADE_OUT | STOP_LOSS
  pnl           REAL,
  edge_pct      REAL,
  momentum      REAL,
  placed_at     TEXT,
  settled_at    TEXT
);
```

---

### 11A.2 Update backtest/runner.js

After `report.generate(results)` is called, also save to SQLite:

```javascript
const db = require('./db')

// Save the run summary
const runId = db.saveRun({
  ranAt: new Date().toISOString(),
  fromDate: args.from,
  toDate: args.to,
  config: JSON.stringify(config),
  markets: results.length,
  bets: totalBets,
  winRate: winRate,
  totalPnl: totalPnl,
  roi: roi,
  maxDrawdown: maxDrawdown,
  avgEdge: avgEdge,
  avgOdds: avgOdds,
  notes: args.notes || null   // --notes "test with edge=4%" optional CLI arg
})

// Save every individual bet
db.saveBets(runId, allBets)

console.log(`\nRun saved to database (ID: ${runId})`)
console.log('View all runs: node backtest/compare.js')
```

---

### 11A.3 New file: backtest/compare.js

A simple CLI tool to compare saved runs:

```bash
node backtest/compare.js
```

Output:

```
═══════════════════════════════════════════════════════════════════════
  Backtest Run History
═══════════════════════════════════════════════════════════════════════
  ID  Date        Period                  Bets  Win%   P&L      ROI   Notes
  ─────────────────────────────────────────────────────────────────────
   1  2026-03-19  Jan 2026 → Mar 2026      89   61.8%  +£342    12.8%
   2  2026-03-19  Jan 2026 → Mar 2026      64   58.2%  +£201     8.4%  edge=4%
   3  2026-03-20  Jan 2026 → Mar 2026     112   63.1%  +£389    14.5%  momentum=15
═══════════════════════════════════════════════════════════════════════
  Best ROI:   Run 3 — 14.5%
  Best P&L:   Run 3 — +£389
  Most bets:  Run 3 — 112
═══════════════════════════════════════════════════════════════════════

Run 'node backtest/compare.js --id 1 --id 3' to compare two runs in detail
```

When called with `--id` flags, show a side-by-side comparison:

```
                        Run 1          Run 3          Difference
  ─────────────────────────────────────────────────────────────
  Period            Jan-Mar 2026   Jan-Mar 2026
  Config change     baseline       momentum=15
  Bets placed              89            112              +23
  Win rate               61.8%          63.1%            +1.3%
  Total P&L             +£342          +£389             +£47
  ROI                   12.8%          14.5%            +1.7%
  Max drawdown          -£67           -£54             +£13
  Best surface          Hard           Hard
  Worst surface         Clay           Clay
```

---

## Phase 11B — Backtesting Tab on Dashboard

Add a second tab to the live dashboard at `http://localhost:3000` that shows
backtest history from the SQLite database.

---

### 11B.1 New dashboard API endpoints (src/dashboard/server.js)

Add these routes:

```
GET /api/backtest/runs
  Returns: all rows from runs table, newest first
  [ { id, ranAt, fromDate, toDate, bets, winRate, totalPnl, roi, notes }, ... ]

GET /api/backtest/runs/:id
  Returns: run summary + all run_bets for that run

GET /api/backtest/runs/:id/chart
  Returns: daily P&L data for that run (for chart)
  [ { date, pnl, cumulative }, ... ]
```

---

### 11B.2 Update dashboard UI

Add a tab bar at the top of the dashboard page:

```
[ Live Trading ]  [ Backtests ]
```

**Backtests tab:**

```
┌─────────────────────────────────────────────────────┐
│  Backtest History                  [Run New ▶]      │
├────┬────────────┬─────────────┬──────┬──────┬───────┤
│ ID │ Date run   │ Period      │ Bets │  ROI │  P&L  │
├────┼────────────┼─────────────┼──────┼──────┼───────┤
│  3 │ 2026-03-20 │ Jan-Mar '26 │  112 │ 14.5%│ +£389 │  ← click to expand
│  2 │ 2026-03-19 │ Jan-Mar '26 │   64 │  8.4%│ +£201 │
│  1 │ 2026-03-19 │ Jan-Mar '26 │   89 │ 12.8%│ +£342 │
└────┴────────────┴─────────────┴──────┴──────┴───────┘

[ Compare Run 1 vs Run 3 ]   ← button appears when 2 rows are selected
```

**When a run row is clicked — expand below it:**

```
▼ Run 3 — Jan 2026 → Mar 2026 — momentum=15

  [P&L Chart for this run]

  Surface breakdown:
  Hard:  68 bets  65.2%  +£241
  Clay:  31 bets  58.1%  +£89
  Grass: 13 bets  61.5%  +£59

  [Full bet table — sortable by date/odds/P&L]
```

**Compare view (when two runs selected):**

Side-by-side stat cards showing the differences, same as compare.js CLI output but visual.

---

## Phase 11C — ngrok Setup Guide

> This section is documentation only — add it to README.md
> No code changes needed.

---

### What ngrok does

ngrok creates a secure tunnel from a public URL on the internet to your
localhost:3000. Anyone with the URL can see your dashboard in their browser
without you needing to open router ports or set up a server.

### Setup (one time)

1. Go to https://ngrok.com and create a free account
2. Download ngrok for Windows and extract it somewhere (e.g. `C:\ngrok\ngrok.exe`)
3. Run this once to link your account:
```bash
ngrok config add-authtoken YOUR_TOKEN_HERE
```

### Using it

Every time you want to share the dashboard:

1. Start the bot as normal: `node src/index.js`
2. In a second terminal window, run:
```bash
ngrok http 3000
```
3. ngrok shows you a URL like `https://abc123.ngrok-free.app`
4. Send that URL to your dad — he opens it in his browser
5. Works until you close the ngrok terminal

### Adding a password

To stop anyone who finds the URL from accessing it:
```bash
ngrok http 3000 --basic-auth "tennis:yourpassword"
```
Then give your dad the username `tennis` and whatever password you set.

### Fixed URL (optional, £8/month)

On the free plan the URL changes every time you restart ngrok.
If you pay for ngrok's Basic plan you get a fixed subdomain like
`https://tennis-bot.ngrok.app` that never changes.

### Limitations

- Only works while your PC is on and the bot is running
- If you close your laptop the dashboard goes offline
- For always-on access see Phase 11D (VPS deployment)

---

## Phase 11D — VPS Deployment Guide

> This section is documentation only — add it to README.md
> No code changes needed.
> Follow this when you're ready to run the bot 24/7.

---

### What you need

A VPS (Virtual Private Server) — a small always-on Linux server in the cloud.

**Recommended: Hetzner Cloud CX22**
- £3.50/month
- 2 vCPU, 4GB RAM — more than enough
- Based in Germany (good Betfair API latency)
- Sign up at https://www.hetzner.com/cloud

---

### One-time server setup

After creating the server (choose Ubuntu 24.04), SSH into it:

```bash
ssh root@YOUR_SERVER_IP
```

Install Node.js:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Install PM2 (keeps the bot running, restarts if it crashes):
```bash
npm install -g pm2
```

---

### Deploy the bot

On your PC, copy the bot files to the server:
```bash
# From inside your tennis-bot folder on your PC
scp -r . root@YOUR_SERVER_IP:/root/tennis-bot
```

On the server:
```bash
cd /root/tennis-bot
npm install
```

Create the `.env` file on the server (same contents as your local one):
```bash
nano .env
# Paste your .env contents, save with Ctrl+X
```

Copy your cert files to the server:
```bash
# From your PC
scp certs/client-2048.crt certs/client-2048.key root@YOUR_SERVER_IP:/root/tennis-bot/certs/
```

---

### Start the bot with PM2

```bash
pm2 start src/index.js --name tennis-bot
pm2 save               # saves so it restarts on server reboot
pm2 startup            # makes PM2 start on boot
```

Useful PM2 commands:
```bash
pm2 status             # see if bot is running
pm2 logs tennis-bot    # see live log output
pm2 restart tennis-bot # restart after config changes
pm2 stop tennis-bot    # stop the bot
```

---

### Access the dashboard remotely

The dashboard runs on port 3000 on the server.
To access it securely, use an SSH tunnel — no need to open the port publicly:

```bash
# Run this on your PC whenever you want to see the dashboard
ssh -L 3000:localhost:3000 root@YOUR_SERVER_IP
```

Then open `http://localhost:3000` in your browser as normal.
The connection is encrypted through SSH.

Alternatively, install nginx on the server to serve the dashboard
on a proper domain with HTTPS — add this to README as a follow-up step
when you're ready to share with your dad without them needing SSH.

---

### Updating the bot after code changes

```bash
# On your PC — copy changed files to server
scp -r src/ root@YOUR_SERVER_IP:/root/tennis-bot/
scp config/strategies.json root@YOUR_SERVER_IP:/root/tennis-bot/config/

# On the server — restart to pick up changes
pm2 restart tennis-bot
```

---

### Monitoring

PM2 keeps a log at `/root/.pm2/logs/tennis-bot-out.log`

Set up email alerts if the bot crashes (optional):
```bash
pm2 install pm2-slack   # or pm2-telegram for Telegram alerts on crash
```

---

## Build Order for Claude Code

Tell Claude Code:

> "Read TENNIS_BOT_PHASE11_SPEC.md. Phases 1–10 are complete.
> Build Phase 11A only — SQLite backtest storage. Stop when done."

Then after reviewing:

> "11A looks good. Build Phase 11B — backtesting tab on the dashboard. Stop when done."

Then:

> "11B looks good. Build Phase 11C and 11D — add the ngrok and VPS sections to README.md. Stop when done."

---

## Summary of What Phase 11 Adds

| Section | What it does |
|---------|-------------|
| 11A | Saves every backtest run to SQLite — never lose results |
| 11A | `compare.js` CLI to compare runs side by side |
| 11B | Backtests tab on dashboard — visual history and comparisons |
| 11C | ngrok guide — share dashboard with your dad in 2 minutes |
| 11D | VPS deployment — bot runs 24/7 even when PC is off |

---

*End of Phase 11 specification.*
