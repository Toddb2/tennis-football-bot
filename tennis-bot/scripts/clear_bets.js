'use strict';
const db = require('/home/bots/tennis-bot/src/database/db');
const n = db.prepare('DELETE FROM bets').run();
console.log('Deleted', n.changes, 'bets');
try { db.prepare('DELETE FROM bet_rejections').run(); } catch(_) {}
process.exit(0);
