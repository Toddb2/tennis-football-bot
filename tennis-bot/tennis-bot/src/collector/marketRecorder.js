'use strict';

/**
 * marketRecorder.js
 *
 * Listens to the BetfairStream 'marketUpdate' events and accumulates price
 * snapshots for every market the live bot watches.  When a market closes it
 * is flushed to  data/historical/<marketId>.json  in the flat-snapshot format
 * that backtest/dataLoader.js already understands.
 *
 * Usage:
 *   const MarketRecorder = require('./marketRecorder');
 *   const recorder = new MarketRecorder();
 *   betfairStream.on('marketUpdate', u => recorder.record(u));
 *   // on shutdown:
 *   recorder.flush();   // writes any still-open markets to disk
 */

const fs   = require('fs');
const path = require('path');

const HISTORICAL_DIR = path.join(__dirname, '../../data/historical');

// Minimum snapshots before we consider a market worth saving (avoids tiny
// fragments from markets that were immediately suspended/removed).
const MIN_SNAPSHOTS = 10;

class MarketRecorder {
  constructor() {
    // Map<marketId, { meta, snapshots[] }>
    this._markets = new Map();
  }

  /**
   * Feed a single marketUpdate event into the recorder.
   * Called on every betfairStream 'marketUpdate' event.
   *
   * @param {object} update  — the raw marketUpdate payload
   */
  record(update) {
    const { marketId, matchName, runners, inPlay, status, timestamp } = update;
    if (!marketId) return;

    if (!this._markets.has(marketId)) {
      this._markets.set(marketId, {
        meta:      { marketId, matchName: matchName || '' },
        snapshots: [],
      });
    }

    const entry = this._markets.get(marketId);

    // Capture a flat snapshot for each runner
    if (Array.isArray(runners)) {
      const ts = timestamp || Date.now();
      for (const runner of runners) {
        const price = runner.lastTradedPrice ?? runner.backPrice ?? null;
        if (price === null) continue;

        entry.snapshots.push({
          timestamp:       ts,
          marketId:        marketId,
          selectionId:     String(runner.selectionId ?? ''),
          selectionName:   runner.name ?? '',
          lastTradedPrice: price,
          bsp:             null,
          inPlay:          inPlay === true,
        });
      }
    }

    // Flush when Betfair marks the market as CLOSED
    if (status === 'CLOSED') {
      this._flushMarket(marketId);
    }
  }

  /**
   * Flush all still-open (in-progress) markets to disk.
   * Call this during shutdown so partially-recorded matches are not lost.
   */
  flush() {
    for (const marketId of [...this._markets.keys()]) {
      this._flushMarket(marketId);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  _flushMarket(marketId) {
    const entry = this._markets.get(marketId);
    if (!entry) return;

    // Remove from buffer regardless of whether we write
    this._markets.delete(marketId);

    if (entry.snapshots.length < MIN_SNAPSHOTS) return;

    fs.mkdirSync(HISTORICAL_DIR, { recursive: true });

    const filePath = path.join(HISTORICAL_DIR, `${marketId}.json`);

    // If the file already exists (e.g. a resumed session), merge snapshots
    // rather than overwrite, so no data is lost.
    let existing = [];
    try {
      if (fs.existsSync(filePath)) {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(existing)) existing = [];
      }
    } catch (_) {
      existing = [];
    }

    const merged = existing.concat(entry.snapshots);

    // Deduplicate by (selectionId, timestamp) and sort chronologically
    const seen = new Set();
    const deduped = merged.filter(s => {
      const key = `${s.selectionId}:${s.timestamp}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    deduped.sort((a, b) => a.timestamp - b.timestamp);

    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(deduped, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }
}

module.exports = MarketRecorder;
