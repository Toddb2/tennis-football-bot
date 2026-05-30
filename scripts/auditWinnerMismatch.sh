#!/usr/bin/env bash
#
# Daily audit: did api-tennis settlement fall back to POSITIONAL winner mapping
# because the winner's name couldn't be matched to either market player?
#
# Each hit is a settlement that bypassed the name-based P1/P2 safeguard and used
# feed order instead — i.e. a case worth a human glance to confirm the right
# side was settled. Zero hits = the name matcher is covering every settled match.
#
# Scans the current + most recent rotated bot log for the last 2 calendar days
# (covers a ~24-48h window regardless of when cron runs) and appends a dated
# summary to logs/winner-mismatch-audit.log. Also prints that summary to stdout.
#
#   scripts/auditWinnerMismatch.sh        # run manually any time

cd "$(dirname "$0")/.." || exit 1

PHRASE='winner name did not match market players'
OUT='logs/winner-mismatch-audit.log'
TODAY=$(date -u +%Y-%m-%d)
YDAY=$(date -u -d 'yesterday' +%Y-%m-%d)
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

mkdir -p logs

# Pull lines from the last two dates out of current + rotated logs, then keep
# only the positional-fallback warnings.
hits=$(grep -hE "^\[($TODAY|$YDAY)T" bot.log bot.log.1 2>/dev/null | grep -F "$PHRASE")
count=$(printf '%s\n' "$hits" | grep -c . )

{
  if [ "$count" -gt 0 ]; then
    echo "[$NOW] ALERT: $count positional-fallback settlement(s) in last 24-48h — review:"
    printf '%s\n' "$hits"
  else
    echo "[$NOW] OK: 0 positional-fallback settlements in last 24-48h (name matcher covered every match)."
  fi
} | tee -a "$OUT"
