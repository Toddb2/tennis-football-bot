# Tennis Bot — Phase 13 Specification
# Strategy Rework: Dad's Real Trading Systems

> **For Claude Code**: This is a significant architecture update based on
> real trading experience. Read every section carefully before writing any code.
> The existing bot infrastructure (Betfair stream, stats poller, dashboard,
> Telegram) stays the same. What changes is the strategy logic and dashboard display.
>
> Build in this order: 13A → 13B → 13C → 13D
> Stop for review after each section.

---

## Background: What We're Moving Away From

The current system uses a continuous Markov chain probability model that
evaluates every match every 5 seconds. Dad's feedback is that this approach
is overengineered for what he actually wants to do.

**Dad's real strategies are event-triggered** — they fire at specific
match moments (end of a set meeting certain criteria), not continuously.
This is much closer to how experienced tennis traders actually operate.

**Reference**: The Udemy course "Tennis Trading: Learn to Trade Tennis
Matches and Make Money" covers these approaches. The bot should be built
to support what's taught in that course, not generic Markov chain theory.

---

## Phase 13A — Simplify Staking (Remove Kelly)

### Problem
Kelly criterion staking is mathematically correct but practically inappropriate
for this use case. It requires accurate edge estimates which we don't have
reliably. It also confuses the strategy config unnecessarily.

### Solution
Replace Kelly with simple **fixed stake per system** — Nigel's CBB handles
the actual staking rules on his end anyway. The bot's job is just to signal
when to bet, not how much.

### Changes to config/strategies.json

Remove from every system:
```json
"staking": {
  "kellyMultiplier": 0.25,
  "maxStakeGBP": 20,
  "minStakeGBP": 2
}
```

Replace with:
```json
"points": 1
```

`points` maps directly to CBB's points system — Nigel sets the actual
stake amount in CBB against that points value. The bot just passes
`points: 1` (or 2 for higher confidence) to `upsert_bets`.

### Changes to riskManager.js

Remove all Kelly calculation logic.

Simplify `check()` to only validate:
1. Is `DRY_RUN` enabled?
2. Are CBB credentials present?
3. Is there already an open position on this market?
4. Does matched volume meet minimum threshold?
5. Is the market currently LIVE and not SUSPENDED?

Return `{ approved: true/false, rejectionReason, points }` — no stake amounts.

### Changes to orderManager.js

Remove stake/liability tracking columns from CSV.
Keep: marketId, matchName, playerName, side, odds, action, points,
edgePct, system, reason, placedAt, settledAt, dryRun.

---

## Phase 13B — Minimum Volume Filter

### Change
Add a global minimum matched volume of **£50,000** applied before
any system evaluation. Markets below this are ignored entirely —
they don't have enough liquidity to trade without moving the price.

### Implementation

In `src/index.js` main loop, add before system evaluation:

```javascript
const MIN_VOLUME = parseInt(process.env.MIN_MATCHED_VOLUME || '50000')

for (const match of stateStore.getAll()) {
  if (!match.isInPlay || match.status !== 'LIVE') continue

  // Skip low liquidity markets
  if ((match.matchedVolume || 0) < MIN_VOLUME) {
    logger.debug(`Skipping ${match.matchName} — volume ${match.matchedVolume} below ${MIN_VOLUME}`)
    continue
  }

  // ... rest of evaluation
}
```

Add to `.env`:
```
MIN_MATCHED_VOLUME=50000
```

Add to dashboard — show volume on every match row. Highlight in red
if below 50,000, green if above.

---

## Phase 13C — Dad's Real Trading Systems

These are the 6 strategies Dad currently runs on BF Bot Manager.
Replicate them exactly. Each strategy is **set-based** — it triggers
at the END of a set, not continuously.

### How Set-Based Triggers Work

The statsPoller already tracks set scores. When a new set completes
(i.e. sets[n].playerA + sets[n].playerB reaches a completed score),
the system evaluator checks if any strategy should fire.

Add a new event emitter call in statsPoller when a set completes:
```javascript
this.emit('setCompleted', { matchState, completedSet, setNumber })
```

The strategy engine listens for this event and evaluates all 6 strategies.

---

### Strategy Definitions

#### Strategy 1 — "P1 wins first set 7-6, lay P1"

**Trigger**: Set 1 completed, P1 wins 7-6 (tiebreak)
**Action**: LAY P1 (back P2) at current market price
**Entry price filter**: Lay odds must be between 1.20 and 2.00
**Exit**: HEDGE OUT if P2 wins the 2nd set (green up)
**If P1 wins 2nd set**: Lose the stake (no action — let it settle)
**CBB key**: `TennisBotS1`

**Rationale**: P1 won a tight tiebreak. The market overreacts and P1's
price drops. The underlying match is still 50/50. Lay P1 to fade
the overreaction.

```json
{
  "name": "Strategy1",
  "description": "P1 wins first set 7-6 — lay P1",
  "enabled": true,
  "cbbStrategyKey": "TennisBotS1",
  "points": 1,
  "trigger": {
    "type": "set_completed",
    "setNumber": 1,
    "winner": "playerA",
    "score": "7-6"
  },
  "entry": {
    "side": "LAY",
    "player": "playerA",
    "minOdds": 1.20,
    "maxOdds": 2.00
  },
  "exit": {
    "type": "hedge",
    "condition": "set2_winner_playerB"
  }
}
```

---

#### Strategy 2 — "P1 is fave, loses first set, back P1 (hedge out)"

**Trigger**: Set 1 completed, P2 wins (P1 loses). P1 was favourite
at match start (pre-match odds between 1.20 and 1.60)
**Action**: BACK P1 at current market price (price has drifted out)
**Entry price filter**: Back odds must be between 1.60 and 3.00
**Exit**: HEDGE OUT if P1 wins the 2nd set (green up profit)
**If P2 wins 2nd set**: Lose the stake
**CBB key**: `TennisBotS2`

**Rationale**: The favourite was priced 1.2-1.6 pre-match for good reason.
After losing set 1, their price drifts to 1.6-3.0. Back them to come back.

**Valid first set scores for P1 to lose**: 4-6, 5-7, 6-7

```json
{
  "name": "Strategy2",
  "description": "P1 fave loses first set — back P1 and hedge",
  "enabled": true,
  "cbbStrategyKey": "TennisBotS2",
  "points": 1,
  "trigger": {
    "type": "set_completed",
    "setNumber": 1,
    "winner": "playerB",
    "validScores": ["4-6", "5-7", "6-7"],
    "preMatchOddsPlayerA": { "min": 1.20, "max": 1.60 }
  },
  "entry": {
    "side": "BACK",
    "player": "playerA",
    "minOdds": 1.60,
    "maxOdds": 3.00
  },
  "exit": {
    "type": "hedge",
    "condition": "set2_winner_playerA"
  }
}
```

---

#### Strategy 3 — "P1 is fave, loses first set, back P1 (let run)"

**Same trigger as Strategy 2** but NO hedge — let the bet run to match completion.

```json
{
  "name": "Strategy3",
  "description": "P1 fave loses first set — back P1 and let run",
  "enabled": true,
  "cbbStrategyKey": "TennisBotS3",
  "points": 1,
  "trigger": {
    "type": "set_completed",
    "setNumber": 1,
    "winner": "playerB",
    "validScores": ["4-6", "5-7", "6-7"],
    "preMatchOddsPlayerA": { "min": 1.20, "max": 1.60 }
  },
  "entry": {
    "side": "BACK",
    "player": "playerA",
    "minOdds": 1.60,
    "maxOdds": 3.00
  },
  "exit": {
    "type": "none"
  }
}
```

---

#### Strategies 4, 5, 6 — Mirror of 1, 2, 3 for P2

Exactly the same logic but with playerA and playerB swapped:

**Strategy 4**: P2 wins first set 7-6 → lay P2 (back P1)
**Strategy 5**: P2 is fave, loses first set → back P2, hedge out
**Strategy 6**: P2 is fave, loses first set → back P2, let run

```json
{
  "name": "Strategy4",
  "description": "P2 wins first set 7-6 — lay P2",
  "enabled": true,
  "cbbStrategyKey": "TennisBotS4",
  "points": 1,
  "trigger": {
    "type": "set_completed",
    "setNumber": 1,
    "winner": "playerB",
    "score": "6-7"
  },
  "entry": {
    "side": "LAY",
    "player": "playerB",
    "minOdds": 1.20,
    "maxOdds": 2.00
  },
  "exit": {
    "type": "hedge",
    "condition": "set2_winner_playerA"
  }
},
{
  "name": "Strategy5",
  "description": "P2 fave loses first set — back P2 and hedge",
  "enabled": true,
  "cbbStrategyKey": "TennisBotS5",
  "points": 1,
  "trigger": {
    "type": "set_completed",
    "setNumber": 1,
    "winner": "playerA",
    "validScores": ["6-4", "7-5", "7-6"],
    "preMatchOddsPlayerB": { "min": 1.20, "max": 1.60 }
  },
  "entry": {
    "side": "BACK",
    "player": "playerB",
    "minOdds": 1.60,
    "maxOdds": 3.00
  },
  "exit": {
    "type": "hedge",
    "condition": "set2_winner_playerB"
  }
},
{
  "name": "Strategy6",
  "description": "P2 fave loses first set — back P2 and let run",
  "enabled": true,
  "cbbStrategyKey": "TennisBotS6",
  "points": 1,
  "trigger": {
    "type": "set_completed",
    "setNumber": 1,
    "winner": "playerA",
    "validScores": ["6-4", "7-5", "7-6"],
    "preMatchOddsPlayerB": { "min": 1.20, "max": 1.60 }
  },
  "entry": {
    "side": "BACK",
    "player": "playerB",
    "minOdds": 1.60,
    "maxOdds": 3.00
  },
  "exit": {
    "type": "none"
  }
}
```

---

### Pre-Match Odds Tracking

Strategies 2, 3, 5, 6 require knowing the **pre-match starting price**.
The Betfair stream sends prices before the match goes in-play.

Add to matchState.js:
```javascript
this.preMatchOddsA = null   // Recorded when match first appears (before inPlay=true)
this.preMatchOddsB = null
```

In betfairStream.js, when a market appears with `inPlay: false`,
record the current back price as the pre-match price. Once `inPlay: true`,
stop updating the pre-match price — it's locked in.

---

### End-of-Set Stats

Dad's notes: end of set stats should be collected and stored for
tight first sets (7-6, 7-5, 6-4 for P1 or 6-7, 5-7, 4-6 for P2).

Stats to capture at end of set 1:

```javascript
{
  setNumber: 1,
  winner: "playerA",
  score: "7-6",
  isTight: true,   // scores above count as tight
  playerA: {
    serviceGamesWon: 5,
    firstServePct: 68,
    firstServePointsWon: 74,
    firstServePointsLost: 26,
    secondServePct: 55,
    secondServePointsWon: 52,
    secondServePointsLost: 48,
    doubleFaults: 2,
    aces: 4
  },
  playerB: {
    serviceGamesWon: 4,
    firstServePct: 61,
    firstServePointsWon: 69,
    firstServePointsLost: 31,
    secondServePct: 48,
    secondServePointsWon: 45,
    secondServePointsLost: 55,
    doubleFaults: 3,
    aces: 1
  }
}
```

Store in matchState.js as `this.setStats = []` — one object per completed set.

Display in the dashboard when viewing a specific match.
Include in the Telegram alert when a strategy fires.

**Future use**: These stats will help refine which tight sets are worth
trading (e.g. if P1 was dominant on serve despite a 7-6 scoreline,
the lay P1 strategy might be less attractive).

---

### New file: src/algorithm/setStrategyEngine.js

Replaces the continuous signalEngine for these strategies.
Listens for `setCompleted` events and evaluates all 6 strategies.

```javascript
class SetStrategyEngine {

  constructor(strategies, stateStore, orderManager, cbbClient, telegram) { ... }

  // Called when statsPoller detects a set has completed
  async onSetCompleted(matchState, completedSetIndex) {
    const set = matchState.sets[completedSetIndex]
    const setScore = `${set.playerA}-${set.playerB}`
    const winner = set.playerA > set.playerB ? 'playerA' : 'playerB'

    for (const strategy of this.strategies) {
      if (!strategy.enabled) continue
      if (strategy.trigger.type !== 'set_completed') continue
      if (strategy.trigger.setNumber !== completedSetIndex + 1) continue

      const qualifies = this._checkTrigger(matchState, strategy, winner, setScore)
      if (!qualifies.passes) {
        logger.debug(`${strategy.name} not triggered: ${qualifies.reason}`)
        continue
      }

      // Check volume
      if ((matchState.matchedVolume || 0) < this.minVolume) {
        logger.debug(`${strategy.name} skipped: volume too low`)
        continue
      }

      // Check entry odds
      const entryOdds = this._getEntryOdds(matchState, strategy)
      if (!this._oddsInRange(entryOdds, strategy.entry)) {
        logger.debug(`${strategy.name} skipped: odds ${entryOdds} not in range`)
        continue
      }

      // Place the bet
      await this._executeBet(matchState, strategy, entryOdds)
    }
  }

  _checkTrigger(matchState, strategy, winner, setScore) {
    const t = strategy.trigger

    // Winner check
    if (t.winner && t.winner !== winner) {
      return { passes: false, reason: `Winner was ${winner}, needed ${t.winner}` }
    }

    // Exact score check (for tiebreak strategies)
    if (t.score) {
      const normalised = winner === 'playerA'
        ? `${matchState.sets[0].playerA}-${matchState.sets[0].playerB}`
        : `${matchState.sets[0].playerA}-${matchState.sets[0].playerB}`
      if (setScore !== t.score && setScore !== t.score.split('-').reverse().join('-')) {
        return { passes: false, reason: `Score was ${setScore}, needed ${t.score}` }
      }
    }

    // Valid scores check (for comeback strategies)
    if (t.validScores && !t.validScores.includes(setScore)) {
      return { passes: false, reason: `Score ${setScore} not in valid scores` }
    }

    // Pre-match odds check
    if (t.preMatchOddsPlayerA) {
      const preOdds = matchState.preMatchOddsA
      if (!preOdds || preOdds < t.preMatchOddsPlayerA.min || preOdds > t.preMatchOddsPlayerA.max) {
        return { passes: false, reason: `Pre-match odds ${preOdds} not in range` }
      }
    }
    if (t.preMatchOddsPlayerB) {
      const preOdds = matchState.preMatchOddsB
      if (!preOdds || preOdds < t.preMatchOddsPlayerB.min || preOdds > t.preMatchOddsPlayerB.max) {
        return { passes: false, reason: `Pre-match odds ${preOdds} not in range` }
      }
    }

    return { passes: true, reason: 'All trigger conditions met' }
  }

  _getEntryOdds(matchState, strategy) {
    const { side, player } = strategy.entry
    if (side === 'BACK') {
      return player === 'playerA' ? matchState.playerABack : matchState.playerBBack
    } else {
      return player === 'playerA' ? matchState.playerALay : matchState.playerBLay
    }
  }

  _oddsInRange(odds, entryConfig) {
    return odds >= entryConfig.minOdds && odds <= entryConfig.maxOdds
  }

  async _executeBet(matchState, strategy, odds) {
    // Resolve selection via CBB catalogue
    const playerName = strategy.entry.player === 'playerA'
      ? matchState.playerAName : matchState.playerBName

    const selection = await this.cbbClient.resolveSelection(
      playerName, matchState.matchName
    )
    if (!selection) return

    await this.orderManager.placeBack(
      selection.marketId,
      selection.selectionId,
      playerName,
      matchState.matchName,
      odds,
      0,  // stake handled by CBB
      strategy.cbbStrategyKey,
      {
        strategy: strategy.name,
        reason: strategy.description,
        setScore: matchState.sets.map(s => `${s.playerA}-${s.playerB}`).join(', '),
        preMatchOddsA: matchState.preMatchOddsA,
        preMatchOddsB: matchState.preMatchOddsB
      }
    )

    // Store exit instructions for this position
    this.orderManager.setExitCondition(
      selection.marketId,
      strategy.exit
    )

    // Send Telegram alert with set stats
    await this.telegram.notifyStrategyFired({
      strategy: strategy.name,
      description: strategy.description,
      matchName: matchState.matchName,
      side: strategy.entry.side,
      player: playerName,
      odds,
      setStats: matchState.setStats[matchState.setStats.length - 1]
    })
  }

  // Called every 5 seconds to check exit conditions on open positions
  async checkExits(matchState) {
    const position = this.orderManager.getOpenPositionForMarket(matchState.betfairMarketId)
    if (!position || !position.exitCondition) return

    const exit = position.exitCondition
    if (exit.type === 'none') return
    if (exit.type === 'hedge') {
      const shouldHedge = this._checkHedgeCondition(matchState, exit.condition)
      if (shouldHedge) {
        await this.orderManager.tradeOut(matchState.betfairMarketId, exit.condition)
        await this.telegram.notifyTradeOut({
          matchName: matchState.matchName,
          reason: exit.condition
        })
      }
    }
  }

  _checkHedgeCondition(matchState, condition) {
    // condition examples: "set2_winner_playerA", "set2_winner_playerB"
    const parts = condition.split('_')
    const setNum = parseInt(parts[1].replace('set', ''))
    const expectedWinner = parts[3]  // "playerA" or "playerB"

    if (matchState.sets.length < setNum) return false
    const set = matchState.sets[setNum - 1]
    if (!set || (set.playerA + set.playerB) === 0) return false

    const setWinner = set.playerA > set.playerB ? 'playerA' : 'playerB'
    return setWinner === expectedWinner
  }
}

module.exports = SetStrategyEngine
```

---

## Phase 13D — Enhanced Dashboard Table

Show ALL available data from the tennis API so Dad can see
exactly what he has to work with when building future strategies.

### New dashboard table columns

Replace the current simplified table with a full data table.
Use horizontal scrolling so all columns fit.

**Match info:**
- Match name
- Tournament
- Round
- Surface
- Status (LIVE badge)

**Score:**
- Current set scores (e.g. "6-4, 3-2*")
- Current game score (e.g. "40-15")
- Current server (⚡ icon next to server's name)

**Betfair market:**
- Back A / Back B (current best back price)
- Lay A / Lay B (current best lay price)
- Matched volume (£ formatted, red if <50k, green if >50k)
- Pre-match odds A / B

**Algorithm output:**
- True prob A / B (from Markov model)
- Edge A / Edge B (colour coded: green >3%, amber 1-3%, grey <1%)
- Momentum index (progress bar -100 to +100)

**Live serve stats (from RapidAPI):**
- P1 1st serve %
- P1 1st serve points won %
- P1 2nd serve points won %
- P1 aces
- P1 double faults
- P1 break points won/created
- P2 same columns

**Set history:**
- Set 1 score
- Set 2 score (if played)
- Set 3 score (if played)

**Strategy signals:**
- Which strategy (if any) fired on this match
- Signal: BET / HOLD / WAITING FOR SET / TRADED OUT

### Table design notes

- Freeze the Match column on the left when scrolling horizontally
- Clicking a row expands it to show the full set stats breakdown
- Highlight rows where a strategy has fired in the current session
- Show "⏳ Waiting" for matches that meet pre-conditions but set hasn't completed yet
- Colour volume: red <£50k, amber £50-100k, green >£100k

### Telegram /matches update

Update the match card format to include:
```
🎾 Djokovic N v Alcaraz C
📍 Miami Open · Hard · R16
💰 Pre-match: 1.45 / 2.90
📊 Current: 1.10 / 9.60 | Vol: £234,500
🎯 Set 1: 6-1 (Djokovic)
📈 Serve: 74% | 1st won: 81% | DF: 0 | Aces: 3
🔄 Strategy: ⏳ Waiting (S4 pre-conditions met)
```

---

## Build Order for Claude Code

**13A first:**
> "Read TENNIS_BOT_PHASE13_SPEC.md. Build Phase 13A only —
> remove Kelly staking from riskManager.js and simplify to points-based.
> Update strategies.json. Stop when done."

**Then 13B:**
> "Build Phase 13B — add minimum volume filter of £50,000
> to the main loop in index.js. Add MIN_MATCHED_VOLUME to .env. Stop when done."

**Then 13C:**
> "Build Phase 13C — the set strategy engine. Create
> src/algorithm/setStrategyEngine.js, update statsPoller.js to emit
> setCompleted events, add pre-match odds tracking to matchState.js,
> update strategies.json with all 6 strategies. Stop when done."

**Then 13D:**
> "Build Phase 13D — update the dashboard table to show all available
> data fields as described in the spec. Stop when done."

---

## What Nigel Needs to Do

Before the strategies can fire live bets, Nigel needs to create
6 CBB strategy profiles:

| CBB Key | Strategy | Description |
|---------|----------|-------------|
| `TennisBotS1` | Strategy 1 | P1 wins 7-6, lay P1 |
| `TennisBotS2` | Strategy 2 | P1 fave loses set, back P1 hedge |
| `TennisBotS3` | Strategy 3 | P1 fave loses set, back P1 run |
| `TennisBotS4` | Strategy 4 | P2 wins 7-6, lay P2 |
| `TennisBotS5` | Strategy 5 | P2 fave loses set, back P2 hedge |
| `TennisBotS6` | Strategy 6 | P2 fave loses set, back P2 run |

Each profile sets the actual stake amount in CBB.
The bot passes `points: 1` and CBB converts that to £ based on Nigel's settings.

---

## Notes for Future Development

**End of set stats refinement**: Once we have real trade data,
we can add a filter to strategies 1 and 4 (tiebreak lay) that checks
whether the tiebreak winner was dominant on serve during the set.
If they were (e.g. 80%+ 1st serve win rate), the lay is less attractive.
This is data we already collect — just not acted on yet.

**Udemy course alignment**: The course "Tennis Trading: Learn to Trade
Tennis Matches and Make Money" likely covers additional entry triggers
and refinements. As you work through the course, add new strategies to
strategies.json following the same pattern as the 6 above.
No code changes needed to add a new strategy — just add it to the JSON.

**Additional strategy ideas to explore from the course:**
- Break of serve betting (momentum plays mid-set)
- Pre-match value betting on outsiders
- Third set lay strategies (fatigue effects)
- Surface-specific serve dominance plays

---

*End of Phase 13 specification.*
