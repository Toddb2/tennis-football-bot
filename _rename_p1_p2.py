#!/usr/bin/env python3
"""Rename Strat7-12 -> Strat7_P1...Strat12_P1; Strat7_B-Strat12_B -> Strat7_P2...Strat12_P2."""
import json
PATH = "/home/bots/tennis-bot/config/strategies.json"
cfg = json.load(open(PATH))

renames = {}
for s in cfg["systems"]:
    n = s["name"]
    if n in ('Strat7','Strat8','Strat9','Strat10','Strat11','Strat12'):
        new = f'{n}_P1'
        s["name"] = new
        renames[n] = new
    elif n.endswith('_B') and n[:-2] in ('Strat7','Strat8','Strat9','Strat10','Strat11','Strat12'):
        new = f'{n[:-2]}_P2'
        s["name"] = new
        renames[n] = new

with open(PATH, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)

print("strategies.json renames:")
for o, n in renames.items():
    print(f"  {o:12} -> {n}")
print(f"Total: {len(renames)}")
