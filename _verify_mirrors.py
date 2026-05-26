import json
cfg = json.load(open("/home/bots/tennis-bot/config/strategies.json"))
for s in cfg["systems"][-6:]:
    lm = s.get("backtest", {}).get("trigger", {}).get("loserMustBe", "?")
    flt = s.get("backtest", {}).get("trigger", {}).get("filters", {})
    print(f'{s["name"]:12} | loserMustBe={lm} | filters={flt}')
    print(f'   {s["description"][:140]}')
