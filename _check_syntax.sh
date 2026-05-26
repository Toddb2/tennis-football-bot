#!/bin/bash
set -e
export PATH=/root/.nvm/versions/node/v20.20.1/bin:$PATH
node -c /home/bots/tennis-bot/src/database/db.js
node -c /home/bots/tennis-bot/src/database/betRepo.js
node -c /home/bots/tennis-bot/src/execution/orderManager.js
node -c /home/bots/tennis-bot/src/dashboard/server.js
python3 -c 'import json; json.load(open("/home/bots/tennis-bot/config/strategies.json"))'
echo ALL_SYNTAX_OK
