#!/usr/bin/env python3
"""Flip allowedSetScores in every Strat*_B mirror — they were left in P1-winner
perspective when I added the mirrors, so the SET_SCORE check rejected every
opportunity. A score string "6-4" (P1 wins 7-game set 6-4) becomes "4-6" for
the P2-winning mirror, etc."""
import json

PATH = "/home/bots/tennis-bot/config/strategies.json"
cfg = json.load(open(PATH))

def flip(score):
    # score is "X-Y" — swap halves
    parts = score.split("-")
    if len(parts) != 2:
        return score
    return f"{parts[1]}-{parts[0]}"

fixed = []
for s in cfg["systems"]:
    if not s["name"].endswith("_B"):
        continue
    trig = s.get("backtest", {}).get("trigger", {})
    if "allowedSetScores" in trig and isinstance(trig["allowedSetScores"], list):
        old = trig["allowedSetScores"]
        new = [flip(x) for x in old]
        if new != old:
            trig["allowedSetScores"] = new
            fixed.append((s["name"], old, new))

with open(PATH, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

for name, o, n in fixed:
    print(f"{name}: {o}  ->  {n}")
print(f"\nFixed {len(fixed)} mirrors.")
