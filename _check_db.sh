#!/bin/bash
DB=/home/bots/tennis-bot/data/tennis-bot.db
echo "=== bets schema ==="
sqlite3 "$DB" ".schema bets" | head -25
echo
echo "=== backfill counts ==="
sqlite3 "$DB" "SELECT COUNT(*) AS total, COUNT(sub_strategy) AS with_sub, COUNT(liability) AS with_liab, COUNT(momentum_at_bet) AS with_mom, COUNT(edge_at_bet) AS with_edge FROM bets;"
echo
echo "=== sub_strategy distribution ==="
sqlite3 "$DB" "SELECT sub_strategy, COUNT(*) FROM bets WHERE sub_strategy IS NOT NULL GROUP BY sub_strategy ORDER BY 2 DESC LIMIT 30;"
echo
echo "=== sample bets with new fields ==="
sqlite3 -header -column "$DB" "SELECT bet_id, strategy_name, sub_strategy, player_key, side, ROUND(stake,2) AS stake, ROUND(liability,2) AS liab, ROUND(momentum_at_bet,3) AS mom, ROUND(edge_at_bet,4) AS edge FROM bets ORDER BY placed_at DESC LIMIT 8;"
