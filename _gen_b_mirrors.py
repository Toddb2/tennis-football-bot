#!/usr/bin/env python3
"""Generate B-side mirrors of Strat7-12 and append to strategies.json.

For each source strategy:
  - clone the JSON object
  - rename:  StratN  ->  StratN_B
  - flip loserMustBe:  'B' -> 'A'  (or 'A' -> 'B' for Strat9)
  - flip p1*/p2* serve-stat filters
  - rewrite description from P1 -> P2 wording
"""
import json, copy, re

PATH = "/home/bots/tennis-bot/config/strategies.json"

with open(PATH) as f:
    cfg = json.load(f)

existing_names = {s["name"] for s in cfg["systems"]}
targets = ["Strat7", "Strat8", "Strat9", "Strat10", "Strat11", "Strat12"]

# Mapped flip for serve-stat filter keys (p1<->p2)
def flip_filter_keys(filters):
    out = {}
    for k, v in filters.items():
        if k.startswith("p1"):
            out["p2" + k[2:]] = v
        elif k.startswith("p2"):
            out["p1" + k[2:]] = v
        else:
            out[k] = v
    return out

# Rewrite a P1-style description to P2 wording.
def rewrite_desc(desc):
    d = desc
    # Common phrasings used in our new format
    d = d.replace("Bet on: P1", "Bet on: P2")
    d = d.replace("A-side variant", "B-side variant (mirror of the A-side strategy)")
    d = d.replace("P1 (Set 2 winner",         "P2 (Set 2 winner")
    d = d.replace("P1 (Set 1 underdog winner","P2 (Set 1 underdog winner")
    d = d.replace("P1 (Set 1 loser drifting", "P2 (Set 1 loser drifting")
    d = d.replace("P1 (Set 1 winner with serve edge","P2 (Set 1 winner with serve edge")
    d = d.replace("P1 (Set 2 winner with serve edge","P2 (Set 2 winner with serve edge")
    d = d.replace("P1 (pre-match favourite recovering","P2 (pre-match favourite recovering")
    d = d.replace("P1 odds",                  "P2 odds")
    d = d.replace("P1 wins Set 2",            "P2 wins Set 2")
    d = d.replace("P1 wins (",                "P2 wins (")
    d = d.replace("P1 loses (",               "P2 loses (")
    d = d.replace("P1 won Set 2",             "P2 won Set 2")
    d = d.replace("P1's 1st-serve-won %",     "P2's 1st-serve-won %")
    d = d.replace("P1's S2 1st-serve-won %",  "P2's S2 1st-serve-won %")
    d = d.replace("than P2's",                "than P1's")
    d = d.replace("P1 winning Set 2",         "P2 winning Set 2")
    return d

added = []
for name in targets:
    mirror_name = f"{name}_B"
    if mirror_name in existing_names:
        continue
    src = next((s for s in cfg["systems"] if s["name"] == name), None)
    if not src:
        continue
    mirror = copy.deepcopy(src)
    mirror["name"] = mirror_name
    # Strat9 has loserMustBe='A' (loser=P1 → BACK P1). Mirror flips loser to B.
    # Others have loserMustBe='B' (loser=P2 → winner=P1). Mirror flips to A.
    trig = mirror.get("backtest", {}).get("trigger", {})
    if "loserMustBe" in trig:
        trig["loserMustBe"] = "A" if trig["loserMustBe"] == "B" else "B"
    # Flip per-player filters inside backtest.trigger.filters
    if "filters" in trig and isinstance(trig["filters"], dict):
        trig["filters"] = flip_filter_keys(trig["filters"])
    mirror["description"] = rewrite_desc(mirror.get("description", ""))
    cfg["systems"].append(mirror)
    added.append(mirror_name)

with open(PATH, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print(f"Added {len(added)} mirrors: {added}")
