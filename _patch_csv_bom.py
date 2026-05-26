#!/usr/bin/env python3
"""Phase-1 patch: add UTF-8 BOM to every CSV download so Excel decodes correctly.
Targets tennis-bot dashboard (server.js, public/app.js) + footballBot.js."""
import os, sys, re

BASE = "/home/bots/tennis-bot/src/dashboard"
files = {
    "app":      f"{BASE}/public/app.js",
    "server":   f"{BASE}/server.js",
    "football": f"{BASE}/footballBot.js",
}

def patch(path, replacements, label):
    s = open(path, encoding="utf-8").read()
    orig = s
    for old, new in replacements:
        if old not in s:
            print(f"[{label}] MISS: {old[:80]!r}")
            continue
        s = s.replace(old, new)
        print(f"[{label}] OK:   {old[:80]!r}")
    if s != orig:
        open(path, "w", encoding="utf-8").write(s)
        print(f"[{label}] WROTE {path}")
    else:
        print(f"[{label}] NO CHANGE")

# 1. app.js: prepend BOM in _downloadCsv
patch(files["app"], [(
    "const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });",
    "const blob = new Blob(['\\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });",
)], "app.js")

# 2. server.js: bfbm + trades endpoints
patch(files["server"], [
    ("res.setHeader('Content-Disposition', 'attachment; filename=\"bfbm-signals.csv\"');\n    res.setHeader('Content-Type', 'text/csv');",
     "res.setHeader('Content-Disposition', 'attachment; filename=\"bfbm-signals.csv\"');\n    res.setHeader('Content-Type', 'text/csv; charset=utf-8');"),
    ("res.setHeader('Content-Disposition', 'attachment; filename=\"trade_log.csv\"');\n    res.setHeader('Content-Type', 'text/csv');",
     "res.setHeader('Content-Disposition', 'attachment; filename=\"trade_log.csv\"');\n    res.setHeader('Content-Type', 'text/csv; charset=utf-8');"),
    ("res.sendFile(filePath);",
     "res.write('\\uFEFF'); fs.createReadStream(filePath).pipe(res);"),
    ("res.sendFile(TRADE_LOG);",
     "res.write('\\uFEFF'); fs.createReadStream(TRADE_LOG).pipe(res);"),
    ("return res.send(bfbmExport.buildEmptyExport());",
     "return res.send('\\uFEFF' + bfbmExport.buildEmptyExport());"),
    ("return res.send('betId,marketId,matchName,playerName,side,odds,stake,liability,action,reason,placedAt,settledAt,pnl,dryRun\\n');",
     "return res.send('\\uFEFFbetId,marketId,matchName,playerName,side,odds,stake,liability,action,reason,placedAt,settledAt,pnl,dryRun\\n');"),
], "server.js")

# 3. footballBot.js: upload.csv endpoint
patch(files["football"], [
    ("res.setHeader('Content-Type', 'text/csv');",
     "res.setHeader('Content-Type', 'text/csv; charset=utf-8');"),
    ("res.sendFile(BFBM_CSV_FILE);",
     "res.write('\\uFEFF'); fs.createReadStream(BFBM_CSV_FILE).pipe(res);"),
    ("return res.send('Provider,MarketType,EventName,MarketName,SelectionName\\n');",
     "return res.send('\\uFEFFProvider,MarketType,EventName,MarketName,SelectionName\\n');"),
], "footballBot.js")

print("DONE")
