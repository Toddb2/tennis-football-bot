'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const unbzip2  = require('unbzip2-stream');

const HISTORICAL_DIR = path.join(__dirname, '../data/historical');

// Month name → 0-based index for parsing Betfair's directory structure
const MONTH_INDEX = {
  Jan:0, Feb:1, Mar:2, Apr:3, May:4,  Jun:5,
  Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11,
};

class DataLoader {

  /**
   * Scan the historical directory (recursively) and return all available
   * market files, optionally filtered by date range.
   *
   * Handles two layouts:
   *   • Betfair download: data/historical/data/BASIC/<year>/<Mon>/<day>/<eventId>/1.*.bz2
   *   • Recorder output / manual flat files: data/historical/<marketId>.json  or  .csv
   */
  listAvailableFiles(fromDate, toDate) {
    if (!fs.existsSync(HISTORICAL_DIR)) {
      fs.mkdirSync(HISTORICAL_DIR, { recursive: true });
      return [];
    }

    const from = fromDate ? new Date(fromDate) : null;
    const to   = toDate   ? new Date(toDate)   : null;
    const results = [];

    this._walkDir(HISTORICAL_DIR, results, from, to);

    return results;
  }

  /** Recursively walk a directory and collect market file entries. */
  _walkDir(dir, results, from, to) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        this._walkDir(fullPath, results, from, to);
        continue;
      }

      const name = entry.name;
      const ext  = path.extname(name).toLowerCase();

      // Only .bz2 files that look like Betfair market IDs (1.XXXXXXXXX.bz2)
      // Skip the event-level container files (e.g. 35207857.bz2)
      if (ext === '.bz2' && !name.startsWith('1.')) continue;

      if (ext !== '.bz2' && ext !== '.csv' && ext !== '.json') continue;

      // For Betfair-layout bz2 files, extract date from path and filter
      if (ext === '.bz2' && (from || to)) {
        const dateFromPath = this._dateFromBetfairPath(fullPath);
        if (dateFromPath) {
          if (from && dateFromPath < from) continue;
          if (to   && dateFromPath > to)   continue;
        }
      }

      results.push({ filename: name, path: fullPath });
    }
  }

  /**
   * Try to extract a Date from a Betfair-style path:
   *   .../data/BASIC/2026/Feb/1/...
   */
  _dateFromBetfairPath(filePath) {
    const m = filePath.replace(/\\/g, '/').match(/\/(\d{4})\/([A-Z][a-z]{2})\/(\d{1,2})\//);
    if (!m) return null;
    const year  = parseInt(m[1], 10);
    const month = MONTH_INDEX[m[2]];
    const day   = parseInt(m[3], 10);
    if (month === undefined) return null;
    return new Date(year, month, day);
  }

  /** Load and parse a single market file. Returns array of market objects. */
  async loadMarket(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.bz2')  return this._loadBz2(filePath);
    if (ext === '.csv')  return this._loadCsv(filePath);
    if (ext === '.json') return this._loadJson(filePath);
    throw new Error(`Unsupported file format: ${ext}`);
  }

  /**
   * Parse a Betfair Exchange Streaming API (ESA) bz2 file.
   *
   * Each line is a MarketChangeMessage (NDJSON):
   *   { "op":"mcm", "pt":<ms>, "mc":[{ "id":"1.xxx", "marketDefinition":{...}, "rc":[{ "id":<selId>, "ltp":<price> }] }] }
   *
   * We track runner names and inPlay state from marketDefinition updates,
   * and emit a flat snapshot for every ltp (last traded price) change.
   */
  async _loadBz2(filePath) {
    const snapshots = [];

    // Per-market state: runners (id→name), inPlay, status
    const state = {
      marketId:     path.basename(filePath, '.bz2'),  // e.g. "1.253400919"
      runnerNames:  new Map(),  // selectionId → name
      runnerStatus: new Map(),  // selectionId → 'WINNER' | 'LOSER' | 'ACTIVE' etc.
      inPlay:       false,
      status:       'OPEN',
      totalMatched: 0,          // total matched volume (£) — from mc.tv
    };

    const inputStream = fs.createReadStream(filePath).pipe(unbzip2());
    const rl = readline.createInterface({ input: inputStream, crlfDelay: Infinity });

    let marketTypeChecked = false;

    for await (const line of rl) {
      if (!line.trim()) continue;

      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }

      if (msg.op !== 'mcm' || !Array.isArray(msg.mc)) continue;

      const pt = msg.pt;  // timestamp ms

      for (const mc of msg.mc) {
        const marketId = mc.id || state.marketId;

        // Update runner names and market state from marketDefinition
        if (mc.marketDefinition) {
          const def = mc.marketDefinition;

          // Skip anything that isn't a 2-runner Match Odds market
          if (!marketTypeChecked) {
            marketTypeChecked = true;
            const activeRunners = (def.runners || []).filter(r => r.status === 'ACTIVE').length;
            if (def.marketType !== 'MATCH_ODDS' || activeRunners !== 2) {
              return [];  // not a singles match — bail out early
            }
          }

          if (typeof def.inPlay === 'boolean') state.inPlay  = def.inPlay;
          if (def.status)                       state.status = def.status;

          if (Array.isArray(def.runners)) {
            for (const r of def.runners) {
              if (r.id && r.name)   state.runnerNames.set(String(r.id), r.name);
              if (r.id && r.status) state.runnerStatus.set(String(r.id), r.status);
            }
          }
        }

        // Track total matched volume (mc.tv is cumulative)
        if (mc.tv != null) state.totalMatched = mc.tv;

        // Emit snapshots for each runner that has an ltp (last traded price)
        if (Array.isArray(mc.rc)) {
          for (const rc of mc.rc) {
            if (rc.ltp == null) continue;

            const selId = String(rc.id);
            snapshots.push({
              timestamp:       pt,
              marketId:        marketId,
              selectionId:     selId,
              selectionName:   state.runnerNames.get(selId) || '',
              lastTradedPrice: rc.ltp,
              bsp:             null,
              inPlay:          state.inPlay,
            });
          }
        }
      }
    }

    const markets = this._groupByMarket(snapshots);

    // Attach settlement outcome and total matched volume to each market
    for (const market of markets) {
      market.totalMatched = state.totalMatched;
      for (const [selId, runner] of market.runners) {
        const status = state.runnerStatus.get(selId);
        if (status === 'WINNER') market.winnerSelId = selId;
        if (status === 'LOSER')  market.loserSelId  = selId;
      }
    }

    return markets;
  }

  /**
   * Parse Betfair's standard CSV historical format.
   * Columns: MarketId, SelectionId, SelectionName, LastPriceTraded, BSP, InPlay, ...
   */
  async _loadCsv(filePath) {
    const snapshots = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    let headers = null;
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (!headers) {
        headers = line.split(',').map(h => h.trim());
        continue;
      }
      const parts = line.split(',');
      const row   = {};
      headers.forEach((h, i) => { row[h] = (parts[i] || '').trim(); });

      const ts = row['PublishedDate'] || row['DATE_OF_MARKET'] || row['Timestamp'];
      snapshots.push({
        timestamp:       ts ? new Date(ts).getTime() : 0,
        marketId:        row['MARKET_ID']        || row['MarketId']       || '',
        selectionId:     row['SELECTION_ID']     || row['SelectionId']    || '',
        selectionName:   row['SELECTION_NAME']   || row['SelectionName']  || '',
        lastTradedPrice: parseFloat(row['LAST_PRICE_TRADED'] || row['LastPriceTraded']) || null,
        bsp:             parseFloat(row['BSP']) || null,
        inPlay:          row['IN_PLAY'] === 'TRUE' || row['InPlay'] === 'Yes',
      });
    }

    return this._groupByMarket(snapshots);
  }

  async _loadJson(filePath) {
    const raw  = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    // Accept either an array of snapshots or a pre-grouped market array
    if (Array.isArray(data) && data[0]?.marketId && data[0]?.runners) {
      return data; // already grouped
    }
    return this._groupByMarket(Array.isArray(data) ? data : [data]);
  }

  /** Group flat snapshot array into per-market objects. */
  _groupByMarket(snapshots) {
    const markets = new Map();

    for (const snap of snapshots) {
      if (!snap.marketId) continue;
      if (!markets.has(snap.marketId)) {
        markets.set(snap.marketId, {
          marketId: snap.marketId,
          runners:  new Map(),
          timeline: [],
        });
      }

      const market = markets.get(snap.marketId);

      if (!market.runners.has(snap.selectionId)) {
        market.runners.set(snap.selectionId, {
          selectionId:  snap.selectionId,
          name:         snap.selectionName,
          bsp:          snap.bsp,
          priceHistory: [],
        });
      }

      market.runners.get(snap.selectionId).priceHistory.push({
        timestamp: snap.timestamp,
        price:     snap.lastTradedPrice,
        inPlay:    snap.inPlay,
      });

      market.timeline.push({ timestamp: snap.timestamp, inPlay: snap.inPlay });
    }

    // Sort chronologically
    for (const market of markets.values()) {
      for (const runner of market.runners.values()) {
        runner.priceHistory.sort((a, b) => a.timestamp - b.timestamp);
      }
      market.timeline.sort((a, b) => a.timestamp - b.timestamp);
    }

    return [...markets.values()];
  }
}

module.exports = DataLoader;
