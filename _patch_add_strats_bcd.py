#!/usr/bin/env python3
"""Add Strategies B, C, D from the user's downloaded analysis (184-match study).
   - All added DISABLED so the user reviews on Strategies tab before enabling.
   - Adds engine support for `trigger.requireSplitSets` (sets must be 1-1) for Strategy D.
"""
import json

# ── 1. Engine: add requireSplitSets support ──────────────────────────────────
EP = '/home/bots/tennis-bot/src/algorithm/strategyEngine.js'
with open(EP, 'r', encoding='utf-8') as f:
    s = f.read()

if 'requireSplitSets' not in s:
    # Insert the check just after the loserMustBe block
    s = s.replace(
        "    // ── Pre-match odds checks ─────────────────────────────────────────────",
        "    // ── requireSplitSets — match must be 1-1 going into the deciding set ──\n"
        "    if (trigger.requireSplitSets === true && trigger.setNumber >= 2) {\n"
        "      const prevWinner = setWinner(sets[trigger.setNumber - 2]);\n"
        "      const thisWinner = setWinner(sets[trigger.setNumber - 1]);\n"
        "      if (prevWinner === thisWinner) {\n"
        "        rej('SPLIT_SETS', `requireSplitSets=true but ${prevWinner} won both sets ${trigger.setNumber-1} and ${trigger.setNumber}`);\n"
        "      }\n"
        "    }\n"
        "    if (_rejected) continue;\n\n"
        "    // ── Pre-match odds checks ─────────────────────────────────────────────",
        1
    )
    with open(EP, 'w', encoding='utf-8') as f:
        f.write(s)
    print('1. strategyEngine: requireSplitSets check added')
else:
    print('1. requireSplitSets already in engine')

# ── 2. Add 3 strategies (all disabled) ───────────────────────────────────────
SP = '/home/bots/tennis-bot/config/strategies.json'
with open(SP, 'r', encoding='utf-8') as f:
    cfg = json.load(f)

new_strats = [
    {
        "name": "Strat6",
        "description": "Strategy B (184-match study, +30.6% EV n=99). Back the player who LOST set 1 if their post-S1 live odds drift to 3.0-10.0. No pre-match filter. A-side variant — duplicate as Strat6_B for B-side mirror.",
        "enabled": False,
        "filters": { "surfaces": ["hard","clay","grass"] },
        "staking": { "stakeGBP": 2 },
        "exit": { "type": "none" },
        "backtest": {
            "trigger": {
                "setNumber": 1,
                "loserMustBe": "A",
                "allowedSetScores": ["4-6","5-7","6-7","3-6","2-6","1-6","0-6"]
            },
            "entry": {
                "player": "loser",
                "side": "BACK",
                "minOdds": 3.0,
                "maxOdds": 10.0
            },
            "exit": { "type": "none" }
        }
    },
    {
        "name": "Strat7",
        "description": "Strategy D (184-match study, +25.9% EV n=89). At end of Set 2 in a 3-set match (sets 1-1), back whoever just won Set 2. Fires only when sets are split. A-side variant — duplicate as Strat7_B for full coverage.",
        "enabled": False,
        "filters": { "surfaces": ["hard","clay","grass"] },
        "staking": { "stakeGBP": 2 },
        "exit": { "type": "none" },
        "backtest": {
            "trigger": {
                "setNumber": 2,
                "loserMustBe": "B",
                "requireSplitSets": True,
                "allowedSetScores": ["6-4","6-3","6-2","6-1","6-0","7-5","7-6"]
            },
            "entry": {
                "player": "winner",
                "side": "BACK",
                "minOdds": 1.4,
                "maxOdds": 3.0
            },
            "exit": { "type": "none" }
        }
    },
    {
        "name": "Strat8",
        "description": "Strategy C (184-match study, +16.6% EV n=49). Pre-match underdog (>2.5) wins Set 1 — back them at end-of-S1 odds 1.5-3.0. A-side variant — duplicate as Strat8_B for B-side mirror.",
        "enabled": False,
        "filters": { "surfaces": ["hard","clay","grass"] },
        "staking": { "stakeGBP": 2 },
        "exit": { "type": "none" },
        "backtest": {
            "trigger": {
                "setNumber": 1,
                "loserMustBe": "B",
                "preMatchOddsWinner": { "min": 2.5, "max": 99 },
                "allowedSetScores": ["6-4","6-3","6-2","6-1","6-0","7-5","7-6"]
            },
            "entry": {
                "player": "winner",
                "side": "BACK",
                "minOdds": 1.5,
                "maxOdds": 3.0
            },
            "exit": { "type": "none" }
        }
    }
]

cfg.setdefault('systems', [])
existing = {s.get('name') for s in cfg['systems']}
added = []
for ns in new_strats:
    if ns['name'] in existing: continue
    cfg['systems'].append(ns)
    added.append(ns['name'])

if added:
    with open(SP, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
    print(f'2. config/strategies.json: added {added} (all disabled)')
else:
    print('2. strategies already exist')

print('\nDone — strategies.json hot-reloads. Restart tennis-bot to pick up engine change.')
