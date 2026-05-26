# Tennis Bot — Phase 6 CBB Replacement Specification

> **For Claude Code**: Phase 6 of the tennis bot was built using direct Betfair API
> with certificate authentication. This document replaces that approach entirely.
> The bot will instead send bet signals to CloudBetBot (CBB) exactly like the
> existing football bot does.
>
> Delete or ignore the existing src/execution/betfairClient.js and
> src/execution/orderManager.js files. Replace them with the files described below.
> Everything else (Phases 1-5, 7-11) stays exactly the same.

---

## Why CBB Instead of Direct Betfair API

- No SSL certificate required
- No Betfair API key required
- No Betfair developer account needed
- CBB handles all Betfair authentication on its end
- Nigel controls staking profiles in CBB as usual
- Same approach as the working football bot

---

## What You Need From Nigel

Before building, get these from Nigel:

| Item | Where it goes in .env |
|------|----------------------|
| CBB service name | `CBB_SERVICE` |
| CBB access key | `CBB_KEY` |
| CBB service ID | `CBB_ID` |

Also ask Nigel to create a **tennis strategy profile** in CBB settings.
Suggest naming it `TennisBotA` as the first strategy.
He sets the staking rules on his end exactly like he does for football.

---

## Updated .env

Remove the Betfair cert entries and replace with CBB credentials:

```
# CloudBetBot credentials (get from Nigel)
CBB_SERVICE=
CBB_KEY=
CBB_ID=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Stats API
RAPIDAPI_KEY=

# Bot settings
DRY_RUN=true
BANKROLL_GBP=1000
LOG_LEVEL=info

# Dashboard
DASHBOARD_PORT=3000
DASHBOARD_ENABLED=true
```

---

## New File: src/execution/cbbClient.js

Replace betfairClient.js with this simpler CBB client.

```javascript
const axios = require('axios')
const logger = require('../utils/logger')

const CBB_UPSERT_URL = 'https://www.cloudbetbot.com/api/rpc/hooks/upsert_bets.php'
const CBB_CATALOGUE_URL = 'https://www.cloudbetbot.com/api/rpc/services/predictology/v2/market_catalogue.php'

class CbbClient {
  constructor() {
    this.service = process.env.CBB_SERVICE
    this.key = process.env.CBB_KEY
    this.id = process.env.CBB_ID
    this.isDryRun = process.env.DRY_RUN === 'true'

    // TTL cache for catalogue — avoids re-fetching same market within 30s
    this.catalogueCache = new Map()
    this.CATALOGUE_TTL_MS = 30 * 1000
  }

  // Place or update a bet via CBB
  // strategyKey matches the profile name Nigel set up in CBB (e.g. "TennisBotA")
  async upsertBet(marketId, selectionId, strategyKey, points = 1) {
    if (this.isDryRun) {
      logger.info(`[DRY RUN] Would upsert bet → marketId: ${marketId} | selectionId: ${selectionId} | strategy: ${strategyKey}`)
      return { success: true, dryRun: true }
    }

    const payload = {
      service: { id: this.id, access_key: this.key },
      bets: [{
        marketId,
        selectionId,
        active: true,
        settings_key: strategyKey,
        overrides: null,
        points
      }]
    }

    try {
      const response = await axios.post(CBB_UPSERT_URL, payload)
      logger.info(`CBB bet upserted: ${JSON.stringify(response.data)}`)
      return { success: true, data: response.data }
    } catch (error) {
      logger.error(`CBB upsert failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  }

  // Cancel/deactivate a bet via CBB
  async cancelBet(marketId, selectionId, strategyKey) {
    if (this.isDryRun) {
      logger.info(`[DRY RUN] Would cancel bet → marketId: ${marketId}`)
      return { success: true, dryRun: true }
    }

    const payload = {
      service: { id: this.id, access_key: this.key },
      bets: [{
        marketId,
        selectionId,
        active: false,
        settings_key: strategyKey,
        overrides: null,
        points: 0
      }]
    }

    try {
      const response = await axios.post(CBB_UPSERT_URL, payload)
      logger.info(`CBB bet cancelled: ${JSON.stringify(response.data)}`)
      return { success: true, data: response.data }
    } catch (error) {
      logger.error(`CBB cancel failed: ${error.message}`)
      return { success: false, error: error.message }
    }
  }

  // Fetch tennis market catalogue from CBB
  // Used to resolve marketId + selectionId for a given match
  async getTennisCatalogue(marketParam = null) {
    const cacheKey = marketParam || 'all'
    const cached = this.catalogueCache.get(cacheKey)

    if (cached && Date.now() - cached.fetchedAt < this.CATALOGUE_TTL_MS) {
      logger.debug(`Catalogue served from cache (${cacheKey})`)
      return cached.data
    }

    const marketQuery = marketParam ? `&market=${marketParam}` : ''
    const url = `${CBB_CATALOGUE_URL}?sport=tennis&access_key=${this.key}&access_name=${this.service}${marketQuery}`

    try {
      const response = await axios.get(url)
      this.catalogueCache.set(cacheKey, { data: response.data, fetchedAt: Date.now() })
      return response.data
    } catch (error) {
      logger.error(`CBB catalogue fetch failed: ${error.message}`)
      return cached?.data || {}
    }
  }

  // Find the correct marketId and selectionId for a player in a match
  // playerName: the player to back (e.g. "Djokovic")
  // matchName: "Djokovic v Alcaraz"
  async resolveSelection(playerName, matchName) {
    const catalogue = await this.getTennisCatalogue('MATCH_ODDS')

    if (!catalogue || Object.keys(catalogue).length === 0) {
      logger.warn('No catalogue data available from CBB')
      return null
    }

    // Find the matching event
    for (const [eventId, eventData] of Object.entries(catalogue)) {
      const eventName = eventData?.name || eventData?.event || ''

      // Fuzzy match the match name
      if (!this._matchNames(matchName, eventName)) continue

      // Find the right runner (player to back)
      for (const [marketId, marketData] of Object.entries(eventData.markets || {})) {
        for (const [selectionId, runnerData] of Object.entries(marketData.runners || {})) {
          if (this._matchNames(playerName, runnerData.name || '')) {
            return { marketId, selectionId, eventName }
          }
        }
      }
    }

    logger.warn(`Could not resolve selection for: ${playerName} in ${matchName}`)
    return null
  }

  // Simple fuzzy name match (adapted from football bot)
  _matchNames(a, b) {
    const clean = s => s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

    const ca = clean(a)
    const cb = clean(b)

    if (ca === cb) return true
    if (ca.includes(cb) || cb.includes(ca)) return true

    // Token matching — any significant token from a appears in b
    const tokens = ca.split(' ').filter(w => w.length > 3)
    return tokens.some(t => cb.includes(t))
  }
}

module.exports = CbbClient
```

---

## New File: src/execution/orderManager.js

Replace the existing orderManager.js with this CBB-aware version.

```javascript
const CbbClient = require('./cbbClient')
const logger = require('../utils/logger')
const fs = require('fs')
const path = require('path')

const TRADE_LOG = path.join(__dirname, '../../data/trade_log.csv')

class OrderManager {
  constructor() {
    this.cbb = new CbbClient()
    this.openOrders = new Map()    // marketId → order object
    this.settledOrders = []
    this._ensureCSV()
  }

  // Place a back bet via CBB
  async placeBack(marketId, selectionId, playerName, matchName, odds, stake, strategyKey, meta = {}) {
    const result = await this.cbb.upsertBet(marketId, selectionId, strategyKey, 1)

    if (!result.success) {
      logger.error(`Failed to place back bet: ${result.error}`)
      return null
    }

    const order = {
      betId: result.dryRun ? `DRY-${Date.now()}` : `CBB-${marketId}-${selectionId}`,
      marketId,
      selectionId,
      playerName,
      matchName,
      side: 'BACK',
      odds,
      stake,
      strategyKey,
      liability: stake,
      placedAt: new Date().toISOString(),
      dryRun: result.dryRun || false,
      edgePct: meta.edgePct || null,
      momentumIndex: meta.momentumIndex || null,
      reason: meta.reason || null,
      pnl: null
    }

    this.openOrders.set(marketId, order)
    this._logToCSV({ ...order, action: 'BET_PLACED' })
    logger.info(`Back bet placed → ${matchName} | ${playerName} @ ${odds} | £${stake} | ${strategyKey}`)
    return order
  }

  // Trade out — cancel the active bet on CBB
  async tradeOut(marketId, reason = 'signal') {
    const order = this.openOrders.get(marketId)
    if (!order) {
      logger.warn(`No open order found for market ${marketId}`)
      return null
    }

    const result = await this.cbb.cancelBet(marketId, order.selectionId, order.strategyKey)

    if (!result.success) {
      logger.error(`Failed to trade out: ${result.error}`)
      return null
    }

    // Settle the order
    const settled = {
      ...order,
      settledAt: new Date().toISOString(),
      action: 'TRADE_OUT',
      reason,
      pnl: null   // CBB handles actual settlement — we can't know exact P&L here
    }

    this.openOrders.delete(marketId)
    this.settledOrders.push(settled)
    this._logToCSV(settled)
    logger.info(`Traded out → ${order.matchName} | Reason: ${reason}`)
    return settled
  }

  // Stop loss — cancel and log
  async stopLoss(marketId, reason = 'stop_loss') {
    const order = this.openOrders.get(marketId)
    if (!order) return null

    await this.cbb.cancelBet(marketId, order.selectionId, order.strategyKey)

    const settled = {
      ...order,
      settledAt: new Date().toISOString(),
      action: 'STOP_LOSS',
      reason
    }

    this.openOrders.delete(marketId)
    this.settledOrders.push(settled)
    this._logToCSV(settled)
    logger.warn(`Stop loss triggered → ${order.matchName}`)
    return settled
  }

  // Cancel all open orders (called on shutdown)
  async cancelAll() {
    for (const [marketId, order] of this.openOrders.entries()) {
      await this.cbb.cancelBet(marketId, order.selectionId, order.strategyKey)
      logger.info(`Cancelled on shutdown → ${order.matchName}`)
    }
    this.openOrders.clear()
  }

  getOpenPositionForMarket(marketId) {
    return this.openOrders.get(marketId) || null
  }

  getOpenMarketIds() {
    return [...this.openOrders.keys()]
  }

  getOpenCount() {
    return this.openOrders.size
  }

  getTotalExposure() {
    let total = 0
    for (const order of this.openOrders.values()) {
      total += order.liability || 0
    }
    return total
  }

  getPnlToday() {
    const today = new Date().toISOString().split('T')[0]
    return this.settledOrders
      .filter(o => o.settledAt && o.settledAt.startsWith(today) && o.pnl !== null)
      .reduce((sum, o) => sum + (o.pnl || 0), 0)
  }

  getMatchedToday() {
    const today = new Date().toISOString().split('T')[0]
    return this.settledOrders
      .filter(o => o.settledAt && o.settledAt.startsWith(today))
      .reduce((sum, o) => sum + (o.stake || 0), 0)
  }

  // CSV logging
  _ensureCSV() {
    if (!fs.existsSync(TRADE_LOG)) {
      fs.writeFileSync(TRADE_LOG,
        'betId,marketId,matchName,playerName,side,odds,stake,liability,action,' +
        'edgePct,momentumIndex,strategyKey,reason,placedAt,settledAt,pnl,dryRun\n',
        'utf-8'
      )
    }
  }

  _logToCSV(order) {
    const row = [
      order.betId, order.marketId, order.matchName, order.playerName,
      order.side, order.odds, order.stake, order.liability, order.action,
      order.edgePct, order.momentumIndex, order.strategyKey, order.reason,
      order.placedAt, order.settledAt || '', order.pnl || '', order.dryRun
    ].map(v => this._csvEscape(v)).join(',')

    fs.appendFileSync(TRADE_LOG, row + '\n', 'utf-8')
  }

  _csvEscape(val) {
    if (val === null || val === undefined) return ''
    const s = String(val)
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"'
    }
    return s
  }
}

module.exports = OrderManager
```

---

## Changes to src/index.js

The only change needed in index.js is to remove the Betfair login step
(step 4 in the startup sequence) since CBB handles authentication.

Replace:
```javascript
// Step 4 — Login to Betfair
await betfairClient.login()
```

With:
```javascript
// Step 4 — Verify CBB credentials are present
if (!process.env.CBB_KEY || !process.env.CBB_ID || !process.env.CBB_SERVICE) {
  logger.error('CBB credentials missing from .env — cannot start')
  await telegram.notifyError('CBB credentials missing. Bot cannot start.')
  process.exit(1)
}
logger.info('CBB credentials loaded')
```

Also update the import at the top of index.js:
```javascript
// Remove:
const BetfairClient = require('./execution/betfairClient')

// Replace with:
const CbbClient = require('./execution/cbbClient')
```

---

## How the Signal → Bet Flow Works

The signal engine still produces the same decisions as before:
```
BET_BACK_A | BET_BACK_B | TRADE_OUT | HOLD
```

But instead of going through betfairClient → Betfair API directly,
the execution now goes:

```
signalEngine.evaluate()
    → riskManager.check()
        → orderManager.placeBack()
            → cbbClient.upsertBet()
                → CBB API
                    → Betfair Exchange
```

The market resolution also changes slightly — instead of using the
Betfair Streaming API to get marketId + selectionId, the bot now
calls `cbbClient.resolveSelection()` which queries the CBB catalogue
endpoint (same one the football bot uses).

---

## CBB Strategy Key Mapping

Create a `config/tennis_strategies.json` file:

```json
{
  "default": "TennisBotA",
  "clay": "TennisBotA",
  "hard": "TennisBotA",
  "grass": "TennisBotA"
}
```

In future you can ask Nigel to set up different CBB profiles per surface
(e.g. TennisBotClay, TennisBotHard) with different staking rules,
and map them here without touching code.

The strategy key is passed to `orderManager.placeBack()` which passes
it to `cbbClient.upsertBet()` as `settings_key` — same as the football bot.

---

## What Nigel Needs to Do

1. Set up a new service in CBB for the tennis bot
   (or add tennis strategies to the existing service)

2. Create at least one strategy profile — suggest `TennisBotA`
   with whatever staking rules your dad wants

3. Send you:
   - `CBB_SERVICE` name
   - `CBB_KEY`
   - `CBB_ID`

4. The bot handles everything else — Nigel doesn't need to do
   anything else ongoing unless new strategy profiles are needed

---

## Build Instructions for Claude Code

Tell Claude Code:

> "Read TENNIS_BOT_CBB_SPEC.md in full.
> Replace src/execution/betfairClient.js with the new cbbClient.js as described.
> Replace src/execution/orderManager.js with the CBB version as described.
> Update src/index.js to remove the Betfair login step and add the CBB credential check.
> Create config/tennis_strategies.json.
> Keep everything else exactly as it is. Stop when done and confirm what was changed."

---

## Testing Without CBB Credentials

With `DRY_RUN=true` in `.env`, no actual calls are made to CBB.
The bot runs fully — streaming, algorithm, signals, dashboard —
but all bet placements are simulated and logged as DRY-* entries.

You can test the full system on your own without Nigel's credentials
as long as DRY_RUN=true. Only switch to DRY_RUN=false once you have
the CBB credentials from Nigel.

---

*End of CBB replacement specification.*
