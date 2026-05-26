#!/usr/bin/env python3
"""Split Strat5 and Strat6 into Strat5_P1/_P2 and Strat6_P1/_P2 with proper
side-locking via loserMustBe + allowedSetScores."""
import json, copy

PATH = "/home/bots/tennis-bot/config/strategies.json"
cfg = json.load(open(PATH))

# Find existing Strat5 and Strat6
src5 = next((s for s in cfg["systems"] if s["name"] == "Strat5"), None)
src6 = next((s for s in cfg["systems"] if s["name"] == "Strat6"), None)
existing = {s["name"] for s in cfg["systems"]}
new_systems = []

def replace_or_skip(name, replacement):
    """Add `replacement` to new_systems unless a system with that name already exists."""
    if name not in existing:
        new_systems.append(replacement)
        return True
    return False

# ── Strat5 split ───────────────────────────────────────────────────────────────
# Original triggers on set 2 complete, BACK winner, no score filter.
# P1 variant: P1 wins set 2 (loserMustBe='B').  P2 variant: loserMustBe='A'.
if src5:
    desc5 = (
        "Bet on: {who} (Set 2 winner; {side}-side) | Side: BACK | Pre-match: BOTH players 1.80-2.20 (even match) | "
        "In-play BACK odds: 1.70-2.30 | Trigger: end of Set 2 with {who} winning AND momentum favours {who} | "
        "Exit: straight bet to settlement. Experimental — needs minMatchedVolume £100k+."
    )
    for label, side, lmb in [("P1", "P1", "B"), ("P2", "P2", "A")]:
        clone = copy.deepcopy(src5)
        clone["name"] = f"Strat5_{label}"
        clone["description"] = desc5.format(who=side, side=side)
        clone["backtest"]["trigger"]["loserMustBe"] = lmb
        replace_or_skip(clone["name"], clone)

# ── Strat6 split ───────────────────────────────────────────────────────────────
# Original has allowedSetScores=[6-4,7-5,7-6] (P1-win) — only fires P1-side currently.
# P1 variant: keep scores as-is.  P2 variant: flip to [4-6,5-7,6-7] and loserMustBe='A'.
if src6:
    desc6 = (
        "Bet on: {who} (Set 2 winner; {side}-side) | Side: LAY | Pre-match: winner 1.20-1.80 | "
        "In-play LAY odds: 1.10-1.30 | Trigger: end of Set 2, {who} wins {scores} AND momentum favours {who} | "
        "Exit: hedge if {who} loses Set 3. minMatchedVolume £100k+."
    )
    # P1 variant
    p1 = copy.deepcopy(src6)
    p1["name"] = "Strat6_P1"
    p1["description"] = desc6.format(who="P1", side="P1", scores="6-4/7-5/7-6")
    p1["backtest"]["trigger"]["loserMustBe"] = "B"
    replace_or_skip(p1["name"], p1)
    # P2 variant
    p2 = copy.deepcopy(src6)
    p2["name"] = "Strat6_P2"
    p2["description"] = desc6.format(who="P2", side="P2", scores="4-6/5-7/6-7")
    p2["backtest"]["trigger"]["loserMustBe"] = "A"
    p2["backtest"]["trigger"]["allowedSetScores"] = ["4-6", "5-7", "6-7"]
    replace_or_skip(p2["name"], p2)

# Remove the originals once splits are in.
cfg["systems"] = [s for s in cfg["systems"] if s["name"] not in ("Strat5", "Strat6")] + new_systems

with open(PATH, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print(f"Added {len(new_systems)} split strategies:")
for s in new_systems:
    print(f"  {s['name']:12} loserMustBe={s['backtest']['trigger'].get('loserMustBe')}  scores={s['backtest']['trigger'].get('allowedSetScores', 'any')}")
print(f"\nTotal strategies in config now: {len(cfg['systems'])}")
