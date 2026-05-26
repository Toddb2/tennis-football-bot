#!/bin/bash
grep -rn 'edgeA *=\|edgeB *=\|edge_a\|edge_b' /home/bots/tennis-bot/src 2>/dev/null | head -40
