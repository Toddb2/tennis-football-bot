#!/usr/bin/env python3
"""Fix blank match charts on Bets / Analysis detail expand: use bet's placed_at as snapshot anchor instead of fixed 4h lookback."""
AP = '/home/bots/tennis-bot/src/dashboard/public/app.js'
with open(AP, 'r', encoding='utf-8') as f:
    s = f.read()

# Replace fixed 4h lookback with placedAt-aware window
old = (
    "    if (cached && now - cached.loadedAt < SNAP_CACHE_TTL) {\n"
    "      snaps = cached.snaps;\n"
    "    } else {\n"
    "      const since = new Date(now - 4 * 3600 * 1000).toISOString();\n"
    "      snaps = await api(`/api/db/markets/${marketId}/snapshots?since=${encodeURIComponent(since)}`);\n"
    "      _snapCache.set(marketId, { snaps, loadedAt: now });\n"
    "    }"
)
new = (
    "    if (cached && now - cached.loadedAt < SNAP_CACHE_TTL) {\n"
    "      snaps = cached.snaps;\n"
    "    } else {\n"
    "      // Anchor the lookback to the bet's placed_at when available; fall back to 4h for live views.\n"
    "      let sinceMs = now - 4 * 3600 * 1000;\n"
    "      if (m?.placedAt) {\n"
    "        const pms = new Date(m.placedAt).getTime();\n"
    "        if (Number.isFinite(pms)) sinceMs = pms - 2 * 3600 * 1000; // 2h before placement\n"
    "      }\n"
    "      const since = new Date(sinceMs).toISOString();\n"
    "      snaps = await api(`/api/db/markets/${marketId}/snapshots?since=${encodeURIComponent(since)}`);\n"
    "      _snapCache.set(marketId, { snaps, loadedAt: now });\n"
    "    }"
)
if old in s:
    s = s.replace(old, new, 1)
    print('loadMatchCharts since-window now placedAt-anchored')
else:
    print('loadMatchCharts block not found')

# Update callers in Bets tab + Analysis bet detail to pass placedAt
s = s.replace(
    "loadMatchCharts(r.betfair_market_id, { matchName: r.match_name }, 'bch');",
    "loadMatchCharts(r.betfair_market_id, { matchName: r.match_name, placedAt: r.placed_at }, 'bch');",
    1
)
s = s.replace(
    "loadMatchCharts(r.betfair_market_id, { matchName: r.match_name }, 'anch');",
    "loadMatchCharts(r.betfair_market_id, { matchName: r.match_name, placedAt: r.placed_at }, 'anch');",
    1
)

with open(AP, 'w', encoding='utf-8') as f:
    f.write(s)
print('callers updated to pass placedAt')
