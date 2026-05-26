'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE     = path.join(__dirname, '../../bot.log');
const LOG_LEVELS   = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB — rotate to bot.log.1 at this size

const configuredLevel      = (process.env.LOG_LEVEL || 'info').toLowerCase();
const configuredLevelValue = LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.info;

// Track approximate file size so we can rotate without a stat call on every write.
let _approxBytes = 0;
try { _approxBytes = fs.statSync(LOG_FILE).size; } catch (_) {}

function rotateIfNeeded() {
  if (_approxBytes < MAX_LOG_BYTES) return;
  try {
    const backup = LOG_FILE + '.1';
    try { fs.unlinkSync(backup); } catch (_) {}
    fs.renameSync(LOG_FILE, backup);
    _approxBytes = 0;
  } catch (err) {
    console.error(`[logger] log rotation failed: ${err.message}`);
  }
}

function timestamp() {
  return new Date().toISOString();
}

function formatLine(level, message, meta) {
  const metaPart = meta ? ' ' + JSON.stringify(meta) : '';
  return `[${timestamp()}] [${level.toUpperCase()}] ${message}${metaPart}`;
}

function write(level, message, meta) {
  const levelValue = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (levelValue < configuredLevelValue) return;

  const line      = formatLine(level, message, meta);
  const lineBytes = Buffer.byteLength(line + '\n');

  // Console output — colour by level
  switch (level) {
    case 'error': console.error(line); break;
    case 'warn':  console.warn(line);  break;
    case 'debug': console.debug(line); break;
    default:      console.log(line);
  }

  // Rotate before writing if we've hit the size limit
  _approxBytes += lineBytes;
  rotateIfNeeded();

  fs.appendFile(LOG_FILE, line + '\n', (err) => {
    if (err) {
      _approxBytes -= lineBytes;
      console.error(`[logger] Failed to write to log file: ${err.message}`);
    }
  });
}

const logger = {
  info:  (message, meta) => write('info',  message, meta),
  warn:  (message, meta) => write('warn',  message, meta),
  error: (message, meta) => write('error', message, meta),
  debug: (message, meta) => write('debug', message, meta),
};

module.exports = logger;
