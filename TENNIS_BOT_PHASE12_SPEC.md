# Tennis Bot — Phase 12 Specification
# Strategy Filters + Backtesting Dashboard Tab

> **For Claude Code**: Phases 1–11 are complete. The bot is fully running with
> 92 live markets, real Betfair odds, and edge detection working.
> This phase adds two things:
>   A) Strategy filter system — define named systems with specific criteria
>   B) Backtesting tab on the dashboard
>
> Read this file in full before writing any code.
> Build Phase 12A first, stop for review, then 12B.

---

## Phase 12A — Strategy Filter System

Right now the signal engine evaluates every match the same way.
This phase adds named "systems" — each system has its own filters
and criteria for when to bet. Only matches passing all filters
get acted on.

---

### 12A.1 Update config/strategies.json

Add a `systems` array. Each system is a named set of filters:

```json
{
  "probabilityModel": { ... },
  "signalEngine": { ... },
  "riskManager": { ... },
  "filters": { ... },

  "systems": [
    {
      "name": "SystemA",
      "description": "High edge on favourite, hard court only",
      "enabled": true,
      "cbbStrategyKey": "TennisBotA",
      "filters": {
        "surfaces": ["hard"],
        "minEdgePercent": 5.0,
        "minMomentum": 25,
        "minMatchedVolume": 10000,
        "maxOddsToBack": 3.0,
        "minOddsToBack": 1.30,
        "minSetsPlayed": 0,
        "maxSetsPlayed": 5,
        "allowedTournamentTiers": ["grand_slam", "atp500", "atp1000", "wta_premier"],
        "blockedTournaments": [],
        "requireBreakInCurrentSet": false,
        "requireServerMomentum": true,
        "onlyBackFavourite": false,
        "onlyBackUnderdog": false,
        "minGamesPlayedInMatch": 0
      },
      "staking": {
        "kellyMultiplier": 0.25,
        "maxStakeGBP": 20,
        "minStakeGBP": 2
      }
    },
    {
      "name": "SystemB",
      "description": "Clay court specialist — momentum after break",
      "enabled": true,
      "cbbStrategyKey": "TennisBotB",
      "filters": {
        "surfaces": ["clay"],
        "minEdgePercent": 3.0,
        "minMomentum": 30,
        "minMatchedVolume": 5000,
        "maxOddsToBack": 4.0,
        "minOddsToBack": 1.50,
        "requireBreakInCurrentSet": true,
        "requireServerMomentum": false,
        "minGamesPlayedInMatch": 6
      },
      "staking": {
        "kellyMultiplier": 0.20,
        "maxStakeGBP": 15,
        "minStakeGBP": 2
      }
    },
    {
      "name": "SystemC",
      "description": "Big server on grass — backing server dominance",
      "enabled": false,
      "cbbStrategyKey": "TennisBotC",
      "filters": {
        "surfaces": ["grass"],
        "minEdgePercent": 4.0,
        "minMomentum": 20,
        "minMatchedVolume": 8000,
        "maxOddsToBack": 2.5,
        "minOddsToBack": 1.20,
        "requireServerMomentum": true,
        "minFirstServeWinPct": 75
      },
      "staking": {
        "kellyMultiplier": 0.25,
        "maxStakeGBP": 25,
        "minStakeGBP": 2
      }
    }
  ]
}
```

---

### 12A.2 New file: src/algorithm/systemEvaluator.js

```javascript
// Takes a matchState and the systems array from strategies.json
// Returns array of systems that this match qualifies for
// Each result includes: systemName, cbbStrategyKey, suggestedStake, reason

function evaluateSystems(matchState, systems, config) {
  const results = []

  for (const system of systems) {
    if (!system.enabled) continue

    const check = passesFilters(matchState, system.filters)
    if (check.passes) {
      results.push({
        systemName: system.name,
        cbbStrategyKey: system.cbbStrategyKey,
        staking: system.staking,
        reason: check.reason,
        description: system.description
      })
    }
  }

  return results
}

function passesFilters(matchState, filters) {
  // Surface check
  if (filters.surfaces && filters.surfaces.length > 0) {
    if (!filters.surfaces.includes(matchState.surface)) {
      return { passes: false, reason: `Surface ${matchState.surface} not in ${filters.surfaces}` }
    }
  }

  // Edge check
  const bestEdge = Math.max(matchState.edgeA || 0, matchState.edgeB || 0)
  if (filters.minEdgePercent && bestEdge < filters.minEdgePercent) {
    return { passes: false, reason: `Edge ${bestEdge.toFixed(1)}% below min ${filters.minEdgePercent}%` }
  }

  // Momentum check
  const absMomentum = Math.abs(matchState.momentumIndex || 0)
  if (filters.minMomentum && absMomentum < filters.minMomentum) {
    return { passes: false, reason: `Momentum ${absMomentum} below min ${filters.minMomentum}` }
  }

  // Volume check
  if (filters.minMatchedVolume && (matchState.matchedVolume || 0) < filters.minMatchedVolume) {
    return { passes: false, reason: `Volume too low` }
  }

  // Odds range check
  const backOdds = matchState.edgeA > matchState.edgeB
    ? matchState.playerABack
    : matchState.playerBBack

  if (filters.maxOddsToBack && backOdds > filters.maxOddsToBack) {
    return { passes: false, reason: `Odds ${backOdds} above max ${filters.maxOddsToBack}` }
  }
  if (filters.minOddsToBack && backOdds < filters.minOddsToBack) {
    return { passes: false, reason: `Odds ${backOdds} below min ${filters.minOddsToBack}` }
  }

  // Serve win % check (for grass/serving systems)
  if (filters.minFirstServeWinPct) {
    const server = matchState.currentServer
    const serveWin = matchState.liveServeStats?.[server]?.firstServeWon || 0
    if (serveWin < filters.minFirstServeWinPct) {
      return { passes: false, reason: `1st serve win ${serveWin}% below min ${filters.minFirstServeWinPct}%` }
    }
  }

  // Tournament tier check
  if (filters.allowedTournamentTiers && filters.allowedTournamentTiers.length > 0) {
    const tier = matchState.tournamentTier || 'unknown'
    if (!filters.allowedTournamentTiers.includes(tier)) {
      return { passes: false, reason: `Tournament tier ${tier} not allowed` }
    }
  }

  // Blocked tournaments
  if (filters.blockedTournaments && filters.blockedTournaments.length > 0) {
    const tournament = matchState.tournamentName || ''
    if (filters.blockedTournaments.some(b => tournament.includes(b))) {
      return { passes: false, reason: `Tournament blocked` }
    }
  }

  // Minimum games played
  if (filters.minGamesPlayedInMatch) {
    const games = matchState.totalGamesPlayed?.() || 0
    if (games < filters.minGamesPlayedInMatch) {
      return { passes: false, reason: `Only ${games} games played, need ${filters.minGamesPlayedInMatch}` }
    }
  }

  // Server momentum alignment
  if (filters.requireServerMomentum) {
    const server = matchState.currentServer
    const momentum = matchState.momentumIndex || 0
    const serverHasMomentum = (server === 'playerA' && momentum > 0) ||
                              (server === 'playerB' && momentum < 0)
    if (!serverHasMomentum) {
      return { passes: false, reason: `Server momentum not aligned` }
    }
  }

  // Favourite/underdog filter
  if (filters.onlyBackFavourite) {
    const backingA = matchState.edgeA > matchState.edgeB
    const aIsFavourite = matchState.playerABack < matchState.playerBBack
    if (backingA !== aIsFavourite) {
      return { passes: false, reason: `Not backing favourite` }
    }
  }

  return {
    passes: true,
    reason: `Passed all ${Object.keys(filters).length} filters`
  }
}

module.exports = { evaluateSystems, passesFilters }
```

---

### 12A.3 Update src/index.js main loop

Replace the current signal evaluation with system-based evaluation:

```javascript
// In runMainLoop, replace the signal engine call with:

const SystemEvaluator = require('./algorithm/systemEvaluator')

for (const match of stateStore.getAll()) {
  if (!match.isInPlay || match.status !== 'LIVE') continue

  // Evaluate which systems this match qualifies for
  const qualifyingSystems = SystemEvaluator.evaluateSystems(
    match,
    strategies.systems || [],
    strategies
  )

  if (qualifyingSystems.length === 0) continue

  // Check we don't already have a position on this market
  const openPosition = orderManager.getOpenPositionForMarket(match.betfairMarketId)
  if (openPosition) {
    // Check exit conditions on existing position
    const exitSignal = signalEngine.evaluateExit(match, openPosition, strategies.signalEngine)
    if (exitSignal.action !== 'HOLD') {
      await orderManager.tradeOut(match.betfairMarketId, exitSignal.reason)
      telegram.notifyTradeOut({ ...match, ...exitSignal })
    }
    continue
  }

  // Use first qualifying system (highest priority = first in array)
  const system = qualifyingSystems[0]

  // Risk check with system-specific staking
  const approval = riskManager.check(
    { ...match, edgePct: Math.max(match.edgeA, match.edgeB) },
    orderManager.getOpenMarketIds(),
    orderManager.getTotalExposure(),
    { ...strategies.riskManager, ...system.staking }
  )

  if (!approval.approved) {
    logger.debug(`Risk rejected ${match.matchName}: ${approval.rejectionReason}`)
    continue
  }

  // Determine which player to back
  const backPlayerA = match.edgeA > match.edgeB
  const playerName = backPlayerA ? match.playerAName : match.playerBName
  const odds = backPlayerA ? match.playerABack : match.playerBBack

  // Resolve selection on CBB
  const selection = await cbbClient.resolveSelection(playerName, match.matchName)
  if (!selection) continue

  // Place the bet
  await orderManager.placeBack(
    selection.marketId,
    selection.selectionId,
    playerName,
    match.matchName,
    odds,
    approval.recommendedStake,
    system.cbbStrategyKey,
    {
      edgePct: Math.max(match.edgeA, match.edgeB),
      momentumIndex: match.momentumIndex,
      reason: `${system.name}: ${system.description}`
    }
  )

  telegram.notifyBetPlaced({
    matchName: match.matchName,
    playerName,
    odds,
    stake: approval.recommendedStake,
    edgePct: Math.max(match.edgeA, match.edgeB),
    system: system.name,
    reason: system.description
  })

  openMarkets.add(match.betfairMarketId)
}
```

---

### 12A.4 Update /matches Telegram command

Show which system each match qualifies for (if any):

```
🎾 Stefanos Tsitsipas v Arthur Fery
Score: 6-1 6-6 · Hard · Tsitsipas serving
Odds: 1.10 / 9.60 · Prob: 91.2% / 8.8%
Edge: -15.9% / +14.6% · 1st srv: 68% / —
Momentum: +12 (Tsitsipas)
System: ✅ SystemA — High edge on favourite
Signal: 🟢 BET Fery

🎾 Fabian Marozsan v Joao Fonseca  
Score: 3-4 · Clay
Odds: 6.40 / 1.15 · Prob: 14.2% / 85.8%
Edge: +10.3% / -12.9%
Momentum: -8 (Fonseca)
System: ✅ SystemB — Clay court specialist
Signal: 🟢 BET Fonseca

🎾 Casper Ruud v Ethan Quinn
Score: 0-0
Odds: 1.24 / 2.30
Edge: -30.6% / +6.5%
System: ❌ No system matched
Signal: ⚪ HOLD
```

---

### 12A.5 Add /systems Telegram command

New command that shows all configured systems and their status:

```
⚙️ Configured Systems

✅ SystemA — ENABLED
High edge on favourite, hard court only
Filters: Hard only · Edge ≥5% · Momentum ≥25
Max stake: £20 · Kelly: 0.25x

✅ SystemB — ENABLED  
Clay court specialist — momentum after break
Filters: Clay only · Edge ≥3% · Break required
Max stake: £15 · Kelly: 0.20x

❌ SystemC — DISABLED
Big server on grass
Filters: Grass only · Edge ≥4% · Server momentum
Max stake: £25 · Kelly: 0.25x

To enable/disable: edit config/strategies.json
```

---

## Phase 12B — Backtesting Tab on Dashboard

Add a second tab to the existing dashboard at http://localhost:3000.

---

### 12B.1 Add SQLite database

Install: `npm install better-sqlite3`

New file: `src/dashboard/backtestDb.js`

```javascript
const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = path.join(__dirname, '../../data/backtest.db')

function getDb() {
  const db = new Database(DB_PATH)

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at TEXT NOT NULL,
      from_date TEXT NOT NULL,
      to_date TEXT NOT NULL,
      system_name TEXT,
      config TEXT NOT NULL,
      markets INTEGER,
      bets INTEGER,
      win_rate REAL,
      total_pnl REAL,
      roi REAL,
      max_drawdown REAL,
      avg_edge REAL,
      avg_odds REAL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS run_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER REFERENCES runs(id),
      market_id TEXT,
      match_name TEXT,
      surface TEXT,
      tournament TEXT,
      side TEXT,
      odds REAL,
      stake REAL,
      action TEXT,
      pnl REAL,
      edge_pct REAL,
      momentum REAL,
      system_name TEXT,
      placed_at TEXT,
      settled_at TEXT
    );
  `)

  return db
}

function saveRun(data) {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO runs (ran_at, from_date, to_date, system_name, config, markets,
      bets, win_rate, total_pnl, roi, max_drawdown, avg_edge, avg_odds, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    data.ranAt, data.fromDate, data.toDate, data.systemName,
    JSON.stringify(data.config), data.markets, data.bets,
    data.winRate, data.totalPnl, data.roi, data.maxDrawdown,
    data.avgEdge, data.avgOdds, data.notes || null
  )
  return result.lastInsertRowid
}

function getRuns() {
  const db = getDb()
  return db.prepare('SELECT * FROM runs ORDER BY ran_at DESC').all()
}

function getRunBets(runId) {
  const db = getDb()
  return db.prepare('SELECT * FROM run_bets WHERE run_id = ? ORDER BY placed_at').all(runId)
}

function saveBets(runId, bets) {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO run_bets (run_id, market_id, match_name, surface, tournament,
      side, odds, stake, action, pnl, edge_pct, momentum, system_name, placed_at, settled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMany = db.transaction((bets) => {
    for (const bet of bets) {
      stmt.run(runId, bet.marketId, bet.matchName, bet.surface, bet.tournament,
        bet.side, bet.odds, bet.stake, bet.action, bet.pnl, bet.edgePct,
        bet.momentum, bet.systemName, bet.placedAt, bet.settledAt)
    }
  })
  insertMany(bets)
}

module.exports = { saveRun, getRuns, getRunBets, saveBets }
```

---

### 12B.2 Add backtest API endpoints to dashboard server

Add to `src/dashboard/server.js`:

```javascript
const backtestDb = require('./backtestDb')

// Get all backtest runs
app.get('/api/backtest/runs', (req, res) => {
  try {
    const runs = backtestDb.getRuns()
    res.json(runs)
  } catch (err) {
    res.json([])
  }
})

// Get bets for a specific run
app.get('/api/backtest/runs/:id', (req, res) => {
  const bets = backtestDb.getRunBets(parseInt(req.params.id))
  res.json(bets)
})
```

---

### 12B.3 Update dashboard UI

Add a tab bar at the top of `src/dashboard/public/index.html`:

```html
<div class="tab-bar">
  <button class="tab active" onclick="showTab('live')">🎾 Live Trading</button>
  <button class="tab" onclick="showTab('backtest')">📊 Backtests</button>
  <button class="tab" onclick="showTab('systems')">⚙️ Systems</button>
</div>
```

**Backtests tab content:**

```
┌─────────────────────────────────────────────────────┐
│  Backtest History                                    │
├────┬────────────┬─────────────┬──────┬───────┬──────┤
│ ID │ Date       │ Period      │ Bets │  ROI  │  P&L │
├────┼────────────┼─────────────┼──────┼───────┼──────┤
│  3 │ 2026-03-20 │ Jan-Mar '26 │  112 │ 14.5% │+£389 │
│  2 │ 2026-03-19 │ Jan-Mar '26 │   64 │  8.4% │+£201 │
└────┴────────────┴─────────────┴──────┴───────┴──────┘

[Click row to expand and see P&L chart + bet table]
```

**Systems tab content:**

Shows all systems from strategies.json with:
- Name and description
- Enabled/disabled toggle (updates strategies.json via API)
- Filter summary
- Stats from trade_log.csv (bets placed, win rate, P&L per system)

---

### 12B.4 Add system performance to trade log

Update `src/execution/orderManager.js` to include `systemName` in every CSV row.
This enables the Systems tab to show per-system performance from real trades.

---

### 12B.5 Add /api/systems endpoint

```javascript
app.get('/api/systems', (req, res) => {
  const strategies = JSON.parse(fs.readFileSync(STRATEGIES_PATH))
  const systems = strategies.systems || []

  // Enrich with live trade stats from CSV
  const trades = readTradeCsv()
  const enriched = systems.map(system => {
    const systemTrades = trades.filter(t => t.strategyKey === system.cbbStrategyKey)
    const settled = systemTrades.filter(t => t.pnl !== '')
    const wins = settled.filter(t => parseFloat(t.pnl) > 0)
    return {
      ...system,
      stats: {
        totalBets: systemTrades.length,
        settledBets: settled.length,
        winRate: settled.length > 0 ? (wins.length / settled.length * 100).toFixed(1) : null,
        totalPnl: settled.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0).toFixed(2)
      }
    }
  })

  res.json(enriched)
})

app.put('/api/systems/:name/toggle', (req, res) => {
  const strategies = JSON.parse(fs.readFileSync(STRATEGIES_PATH))
  const system = strategies.systems?.find(s => s.name === req.params.name)
  if (system) {
    system.enabled = !system.enabled
    fs.writeFileSync(STRATEGIES_PATH, JSON.stringify(strategies, null, 2))
    res.json({ name: system.name, enabled: system.enabled })
  } else {
    res.status(404).json({ error: 'System not found' })
  }
})
```

---

## Build Order for Claude Code

Tell Claude Code:

> "Read TENNIS_BOT_PHASE12_SPEC.md in full.
> Build Phase 12A first — the system evaluator and strategies.json update.
> Stop when done and show a summary."

Then after reviewing:

> "Phase 12A looks good. Now build Phase 12B — SQLite backtest storage,
> backtest tab, and systems tab on the dashboard. Stop when done."

---

## What This Gives You

After Phase 12 you can:

1. **Define named trading systems** in `config/strategies.json`
   - Each system has its own surface, edge, momentum, odds filters
   - Each system maps to a different CBB strategy profile
   - Enable/disable systems without touching code

2. **See which system fires on each match** in Telegram `/matches`

3. **View system performance** on the dashboard Systems tab
   - Win rate, P&L, bets placed per system from real trade history

4. **Store and compare backtests** on the dashboard Backtests tab
   - Every backtest run saved to SQLite
   - P&L chart per run
   - Compare runs side by side

---

## Example Systems to Set Up

These are just starting points — tune the filters based on what you see in dry run:

| System | Surface | Edge | Momentum | Notes |
|--------|---------|------|----------|-------|
| SystemA | Hard | ≥5% | ≥25 | High confidence only |
| SystemB | Clay | ≥3% | ≥30 | After break of serve |
| SystemC | Grass | ≥4% | ≥20 | Server momentum |
| SystemD | Any | ≥8% | ≥40 | Massive edge only |
| SystemE | Hard/Clay | ≥4% | ≥20 | Grand Slams only |

---

*End of Phase 12 specification.*
