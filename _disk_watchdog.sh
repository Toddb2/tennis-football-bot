#!/usr/bin/env bash
# Disk-space watchdog. Sends a Telegram alert when / drops below 1500 MB free.
# Run every 15 min via cron. Alerts at most once per 6h to avoid spam.
#
# Reads TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from /home/bots/tennis-bot/.env.

set -u
THRESHOLD_MB=1500
STATE=/var/lib/tennis-bot/disk_watchdog.state
LOG=/var/log/tennis-bot-disk-watchdog.log
COOLDOWN_S=$((6*3600))

mkdir -p "$(dirname "$STATE")"
exec >> "$LOG" 2>&1

free_mb=$(df -BM / | awk 'NR==2 {gsub(/M/,"",$4); print $4}')
ts=$(date -Iseconds)
echo "$ts free_mb=$free_mb"

[ "$free_mb" -ge "$THRESHOLD_MB" ] && exit 0

# Cooldown check
now=$(date +%s)
last=$( [ -f "$STATE" ] && cat "$STATE" || echo 0 )
[ $((now - last)) -lt "$COOLDOWN_S" ] && { echo "in cooldown, suppressed"; exit 0; }

# Pull telegram creds from tennis-bot env
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' /home/bots/tennis-bot/.env | cut -d= -f2-)
CHAT=$( grep '^TELEGRAM_CHAT_ID='   /home/bots/tennis-bot/.env | cut -d= -f2-)

if [ -z "$TOKEN" ] || [ -z "$CHAT" ]; then
    echo "ERROR: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in /home/bots/tennis-bot/.env"
    exit 1
fi

msg="⚠️ Server disk low: ${free_mb}MB free on / (threshold ${THRESHOLD_MB}MB). Tennis-bot DB or logs may be growing too fast — run /home/bots/scripts/prune_snapshots.sh or review /var/log."
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
    -d chat_id="$CHAT" -d text="$msg" -o /dev/null
echo "$now" > "$STATE"
echo "ALERT sent"
