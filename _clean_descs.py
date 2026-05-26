#!/usr/bin/env python3
"""Rewrite descriptions for Strat7_P1 .. Strat12_P2 with clean P1/P2 wording."""
import json
PATH = "/home/bots/tennis-bot/config/strategies.json"
cfg = json.load(open(PATH))

# Clean descriptions, indexed by strategy name.
CLEAN = {
    'Strat7_P1':  'Bet on: P1 (Set 2 winner; P1-side) | Side: BACK | Pre-match: any | In-play BACK odds: 1.40-3.00 | Trigger: end of Set 2, sets split 1-1 with P1 winning Set 2 (6-4/6-3/6-2/6-1/6-0/7-5/7-6) | Exit: straight bet to settlement. Source: 184-match study, +25.9% EV n=89.',
    'Strat8_P1':  'Bet on: P1 (Set 1 underdog winner; P1-side) | Side: BACK | Pre-match: P1 odds 2.50+ (underdog) | In-play BACK odds: 1.50-3.00 | Trigger: end of Set 1, P1 wins (6-4/6-3/6-2/6-1/6-0/7-5/7-6) | Exit: straight bet to settlement. Source: 184-match study, +16.6% EV n=49.',
    'Strat9_P1':  'Bet on: P1 (Set 1 loser drifting; P1-side) | Side: BACK | Pre-match: any | In-play BACK odds: 3.00-10.00 (drifted) | Trigger: end of Set 1, P1 loses (4-6/5-7/6-7/3-6/2-6/1-6/0-6) AND post-S1 odds in 3.0-10.0 band | Exit: straight bet to settlement. Source: 184-match study, +30.6% EV n=99.',
    'Strat10_P1': 'Bet on: P1 (Set 1 winner with serve edge; P1-side) | Side: BACK | Pre-match: any | In-play BACK odds: 1.50-3.00 | Trigger: end of Set 1, P1 wins (6-4/6-3/6-2/6-1/6-0/7-5/7-6) AND P1\'s 1st-serve-won % is ≥20pp higher than P2\'s | Exit: straight bet to settlement. Source: 184-match study, +18.4% EV n=22 (1.5-3.0 band).',
    'Strat11_P1': 'Bet on: P1 (Set 2 winner with serve edge; P1-side) | Side: BACK | Pre-match: any | In-play BACK odds: 1.50-3.00 | Trigger: end of Set 2, sets split 1-1, P1 wins Set 2 (6-4/6-3/6-2/6-1/6-0/7-5/7-6) AND P1\'s S2 1st-serve-won % is ≥10pp higher than P2\'s | Exit: straight bet to settlement. Source: 184-match study, +5.7% EV n=29 (tighter Strat7).',
    'Strat12_P1': 'Bet on: P1 (pre-match favourite recovering; P1-side) | Side: BACK | Pre-match: P1 odds 1.01-1.99 (favourite) | In-play BACK odds: 1.01-3.00 | Trigger: end of Set 2, sets split 1-1, P1 won Set 2 (6-4/6-3/6-2/6-1/6-0/7-5/7-6) after losing Set 1 | Exit: straight bet to settlement. Source: 184-match study, -2.9% EV n=50 (NEGATIVE — leave DISABLED unless paper-trading).',

    'Strat7_P2':  'Bet on: P2 (Set 2 winner; P2-side mirror of Strat7_P1) | Side: BACK | Pre-match: any | In-play BACK odds: 1.40-3.00 | Trigger: end of Set 2, sets split 1-1 with P2 winning Set 2 (4-6/3-6/2-6/1-6/0-6/5-7/6-7) | Exit: straight bet to settlement. Source: 184-match study, +25.9% EV n=89 (untested on P2-side; no live bets yet).',
    'Strat8_P2':  'Bet on: P2 (Set 1 underdog winner; P2-side mirror of Strat8_P1) | Side: BACK | Pre-match: P2 odds 2.50+ (underdog) | In-play BACK odds: 1.50-3.00 | Trigger: end of Set 1, P2 wins (4-6/3-6/2-6/1-6/0-6/5-7/6-7) | Exit: straight bet to settlement. Source: 184-match study, +16.6% EV n=49 (untested on P2-side; no live bets yet).',
    'Strat9_P2':  'Bet on: P2 (Set 1 loser drifting; P2-side mirror of Strat9_P1) | Side: BACK | Pre-match: any | In-play BACK odds: 3.00-10.00 (drifted) | Trigger: end of Set 1, P2 loses (6-4/7-5/7-6/6-3/6-2/6-1/6-0) AND post-S1 odds in 3.0-10.0 band | Exit: straight bet to settlement. Source: 184-match study, +30.6% EV n=99 (untested on P2-side; no live bets yet).',
    'Strat10_P2': 'Bet on: P2 (Set 1 winner with serve edge; P2-side mirror of Strat10_P1) | Side: BACK | Pre-match: any | In-play BACK odds: 1.50-3.00 | Trigger: end of Set 1, P2 wins (4-6/3-6/2-6/1-6/0-6/5-7/6-7) AND P2\'s 1st-serve-won % is ≥20pp higher than P1\'s | Exit: straight bet to settlement. Source: 184-match study, +18.4% EV n=22 (1.5-3.0 band) (untested on P2-side; no live bets yet).',
    'Strat11_P2': 'Bet on: P2 (Set 2 winner with serve edge; P2-side mirror of Strat11_P1) | Side: BACK | Pre-match: any | In-play BACK odds: 1.50-3.00 | Trigger: end of Set 2, sets split 1-1, P2 wins Set 2 (4-6/3-6/2-6/1-6/0-6/5-7/6-7) AND P2\'s S2 1st-serve-won % is ≥10pp higher than P1\'s | Exit: straight bet to settlement. Source: 184-match study, +5.7% EV n=29 (tighter Strat7) (untested on P2-side; no live bets yet).',
    'Strat12_P2': 'Bet on: P2 (pre-match favourite recovering; P2-side mirror of Strat12_P1) | Side: BACK | Pre-match: P2 odds 1.01-1.99 (favourite) | In-play BACK odds: 1.01-3.00 | Trigger: end of Set 2, sets split 1-1, P2 won Set 2 (4-6/3-6/2-6/1-6/0-6/5-7/6-7) after losing Set 1 | Exit: straight bet to settlement. Source: 184-match study, -2.9% EV n=50 (NEGATIVE — leave DISABLED unless paper-trading).',
}

updated = 0
for s in cfg["systems"]:
    if s["name"] in CLEAN:
        s["description"] = CLEAN[s["name"]]
        updated += 1

with open(PATH, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print(f"Updated {updated} descriptions.")
for name in CLEAN:
    print(f"  - {name}")
