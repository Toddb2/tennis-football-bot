#!/usr/bin/env python3
"""Tennis dashboard Phase A bug fixes:
  1. betRepo.getDailyPnl SQL: add `bets` and `wins` counts so daily breakdown shows them
  2. renderAnalysisStratTable WR formula: divide by settled bets (not total)
  3. renderAnalysisSummary already correct, leave as-is
  4. Add `bets` and `wins` to renderAnalysisDailyTable (already references them — just needs API to return them)
"""
import sys

# 1. betRepo.js — extend getDailyPnl SQL
BR = '/home/bots/tennis-bot/src/database/betRepo.js'
with open(BR, 'r', encoding='utf-8') as f:
    s = f.read()
old = (
    "const _getDailyPnl = db.prepare(`\n"
    "  SELECT\n"
    "    strftime('%Y-%m-%d', settled_at) AS day,\n"
    "    ROUND(SUM(pnl), 2)               AS pnl\n"
    "  FROM bets\n"
    "  WHERE settled_at IS NOT NULL\n"
    "    AND settled_at >= datetime('now', '-30 days')\n"
    "  GROUP BY day\n"
    "  ORDER BY day\n"
    "`);"
)
new = (
    "const _getDailyPnl = db.prepare(`\n"
    "  SELECT\n"
    "    strftime('%Y-%m-%d', settled_at)              AS day,\n"
    "    COUNT(*)                                       AS bets,\n"
    "    SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)      AS wins,\n"
    "    SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END)     AS losses,\n"
    "    ROUND(SUM(pnl), 2)                             AS pnl,\n"
    "    ROUND(SUM(stake), 2)                           AS stakes\n"
    "  FROM bets\n"
    "  WHERE settled_at IS NOT NULL\n"
    "    AND settled_at >= datetime('now', '-90 days')\n"
    "  GROUP BY day\n"
    "  ORDER BY day\n"
    "`);"
)
if old in s:
    s = s.replace(old, new, 1)
    with open(BR, 'w', encoding='utf-8') as f:
        f.write(s)
    print('betRepo.js — getDailyPnl SQL extended (bets/wins/losses + 90d window)')
else:
    print('betRepo.js: getDailyPnl block not found (already patched?)')

# 2. app.js — renderAnalysisStratTable WR formula uses settled bets only
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

# Add a settledBets counter to byStrat so WR uses settled denominator
old2 = (
    "    if (!byStrat[key]) byStrat[key] = { name: b.strategy_name || 'Unknown', side: b.side || '—', bets: 0, wins: 0, pnl: 0, stakes: 0, oddsSum: 0, live: 0, dry: 0 };\n"
    "    const s = byStrat[key];\n"
    "    s.bets++;\n"
    "    if (b.pnl != null && b.pnl > 0) s.wins++;\n"
    "    s.pnl    += b.pnl || 0;\n"
    "    s.stakes += b.stake || 0;\n"
    "    s.oddsSum += b.requested_odds || 0;\n"
    "    if (b.dry_run) s.dry++; else s.live++;"
)
new2 = (
    "    if (!byStrat[key]) byStrat[key] = { name: b.strategy_name || 'Unknown', side: b.side || '—', bets: 0, settledBets: 0, wins: 0, losses: 0, pnl: 0, stakes: 0, oddsSum: 0, live: 0, dry: 0 };\n"
    "    const s = byStrat[key];\n"
    "    s.bets++;\n"
    "    if (b.pnl != null) {\n"
    "      s.settledBets++;\n"
    "      if (b.pnl > 0) s.wins++; else s.losses++;\n"
    "    }\n"
    "    s.pnl    += b.pnl || 0;\n"
    "    s.stakes += b.stake || 0;\n"
    "    s.oddsSum += b.requested_odds || 0;\n"
    "    if (b.dry_run) s.dry++; else s.live++;"
)
if old2 in s:
    s = s.replace(old2, new2, 1)
    print('app.js — renderAnalysisStratTable: now tracks settledBets')
else:
    print('app.js: byStrat init block not found')

# Update WR formula to use settledBets denominator
old3 = (
    "    const wr  = s.bets ? (s.wins / s.bets * 100) : 0;\n"
    "    const roi = s.stakes > 0 ? (s.pnl / s.stakes * 100) : 0;\n"
    "    const avg = s.bets ? (s.oddsSum / s.bets) : 0;"
)
new3 = (
    "    const wr  = s.settledBets ? (s.wins / s.settledBets * 100) : null;\n"
    "    const roi = s.stakes > 0 ? (s.pnl / s.stakes * 100) : 0;\n"
    "    const avg = s.bets ? (s.oddsSum / s.bets) : 0;"
)
if old3 in s:
    s = s.replace(old3, new3, 1)
    print('app.js — strat WR uses settled denominator')

# Update WR cell rendering to use null check
old4 = "<td>${s.bets ? fmt.pct(wr) : '—'}</td>"
new4 = "<td>${wr != null ? fmt.pct(wr) : '—'}</td>"
if old4 in s:
    s = s.replace(old4, new4, 1)
    print('app.js — strat WR cell uses null check')

with open(AP, 'w', encoding='utf-8') as f:
    f.write(s)

print('\nAll done. Restart tennis-bot to pick up SQL change.')
