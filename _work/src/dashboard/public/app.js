/* app.js — Tennis Bot Dashboard (rebuilt Phase 2) */
'use strict';

// ── Global state ──────────────────────────────────────────────────────────────
const S = {
  liveMatches:  [],   // from WebSocket state_update
  openOrders:   [],   // from WebSocket
  strategies:   [],   // from /api/config/strategies
  bets:         [],   // from /api/db/bets
  performance:  [],   // from /api/db/bets/performance
  dailyPnl:     [],   // from /api/db/bets/daily-pnl
  events:       [],   // from /api/db/events
  wsReady:      false,
  botRunning:   false,
  dryRun:       false,
};

let _sortBets   = { col: 'placed_at', dir: 1 };  // newest first by default
let _sortLive   = { col: 'matchedVolume', dir: -1 };
let _stratChart = null;
let _ws              = null;
let _wsReconnectMs   = 2000;

// ── Chart.js defaults ─────────────────────────────────────────────────────────
Chart.defaults.color          = '#8892a4';
Chart.defaults.borderColor    = '#2e3250';
Chart.defaults.font.family    = 'Inter, system-ui, sans-serif';
Chart.defaults.font.size      = 11;
Chart.defaults.plugins.legend.display = false;

// ── Utility helpers ───────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const fmt = {
  pnl:  v => v == null ? '—' : (v >= 0 ? '+' : '') + '£' + Math.abs(v).toFixed(2),
  odds: v => (v == null || v === 0) ? '—' : v.toFixed(2),
  pct:  v => v == null ? '—' : v.toFixed(1) + '%',
  vol:  v => (v == null || v === 0) ? '—' : v < 100 ? '<0.1k' : (v/1000).toFixed(v < 1000 ? 1 : 0) + 'k',
  ts:   v => { if (!v) return '—'; const d = new Date(v); return d.toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'}); },
  date: v => { if (!v) return '—'; const d = new Date(v); return d.toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'2-digit'}); },
};

function pnlClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu'; }

function badge(text, cls) { return `<span class="badge badge-${cls}">${text}</span>`; }

function score(sets) {
  if (!sets || !sets.length) return '—';
  return sets.map(s => `${s.playerA ?? s[0] ?? 0}-${s.playerB ?? s[1] ?? 0}`).join(' ');
}

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'bets')          loadBets();
      if (btn.dataset.tab === 'bets-filtered') loadFilteredBets();
      if (btn.dataset.tab === 'analysis')      loadAnalysis();
      if (btn.dataset.tab === 'strategies') loadStrategies();
      if (btn.dataset.tab === 'ai')         loadAiHistory();
      if (btn.dataset.tab === 'system')     loadSystem();
    });
  });
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  _ws = new WebSocket(`${proto}://${location.host}`);

  _ws.onopen = () => {
    _wsReconnectMs = 2000;
    S.wsReady = true;
  };

  _ws.onmessage = ({ data }) => {
    try { handleWsEvent(JSON.parse(data)); } catch (_) {}
  };

  _ws.onclose = () => {
    S.wsReady = false;
    updateHeader({ isRunning: false });
    setTimeout(connectWs, _wsReconnectMs);
    _wsReconnectMs = Math.min(_wsReconnectMs * 1.5, 30000);
  };
}

function handleWsEvent({ event, data }) {
  if (event === 'init') {
    S.botRunning = data.summary?.isRunning ?? false;
    S.dryRun     = data.summary?.dryRun    ?? false;
    updateHeader(data.summary || {});
    if (Array.isArray(data.matches)) {
      S.liveMatches = data.matches;
      renderLiveTable();
    }
    if (Array.isArray(data.openOrders)) S.openOrders = data.openOrders;
  }
  if (event === 'state_update') {
    if (Array.isArray(data.matches)) {
      S.liveMatches = data.matches;
      renderLiveTable();
    }
    if (Array.isArray(data.openOrders)) S.openOrders = data.openOrders;
    updateLiveStats();
    loadSignalsToday();
  }
  if (event === 'status') {
    S.botRunning = true;
    updateHeader({ isRunning: true, openBets: data.openBets, marketsWatched: data.marketsWatched });
  }
  if (event === 'bet_placed' || event === 'trade_out' || event === 'stop_loss') {
    if ($('tab-bets').classList.contains('active')) loadBets();
  }
  if (event === 'strategies_updated') {
    // Another client saved strategies — reload if on strategies tab, otherwise refresh silently
    loadStrategies();
  }
}

// ── Header ─────────────────────────────────────────────────────────────────────
function updateHeader(d) {
  const dot = $('hd-dot'), status = $('hd-status');
  if (d.isRunning != null) {
    dot.className = 'dot' + (d.isRunning ? ' live' : '');
    status.textContent = d.isRunning ? (d.dryRun || S.dryRun ? 'DRY RUN' : 'LIVE') : 'Offline';
  }
  if (d.pnlToday != null) {
    $('hd-pnl').textContent = fmt.pnl(d.pnlToday);
    $('hd-pnl').className   = 'val ' + pnlClass(d.pnlToday);
  }
  if (d.openBets != null)       $('hd-bets').textContent = d.openBets;
  if (d.marketsWatched != null) $('hd-mkts').textContent = d.marketsWatched;
  if (d.dryRun || S.dryRun) { $('hd-status').textContent = 'DRY RUN'; $('hd-dot').className = 'dot dry'; }
}

function updateLiveStats() {
  const live   = S.liveMatches.filter(m => m.isInPlay || m.status === 'LIVE');
  const linked = live.filter(m => m.externalMatchId).length;
  $('l-live').textContent   = live.length;
  $('l-open').textContent   = S.openOrders.length;
  $('l-linked').textContent = `${linked}/${live.length}`;
}

// ── LIVE TAB ──────────────────────────────────────────────────────────────────
let _expandedMarket = null;

const MIN_LIVE_VOL = 100_000;

function renderLiveTable() {
  const search     = $('live-search').value.toLowerCase();
  const linkedFilt = $('live-linked').value;
  const stratFilt  = $('live-strategy').value;

  let rows = S.liveMatches.filter(m => (m.isInPlay || m.status === 'LIVE') && (m.matchedVolume || 0) >= MIN_LIVE_VOL);

  if (search)             rows = rows.filter(m => m.matchName?.toLowerCase().includes(search));
  if (linkedFilt === '1') rows = rows.filter(m =>  m.externalMatchId);
  if (linkedFilt === '0') rows = rows.filter(m => !m.externalMatchId);
  if (stratFilt)          rows = rows.filter(m => m.qualifyingSystems?.includes(stratFilt));

  rows = [...rows].sort((a, b) => {
    const av = a[_sortLive.col] ?? 0, bv = b[_sortLive.col] ?? 0;
    return _sortLive.dir * (bv > av ? 1 : bv < av ? -1 : 0);
  });

  const openByMarket = new Map(S.openOrders.map(o => [o.marketId, o]));
  const tbody = $('live-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No live markets match filters</td></tr>'; return; }

  tbody.innerHTML = rows.map(m => {
    const setStr     = score(m.sets);
    const qualSys    = (m.qualifyingSystems || []);
    const openPos    = openByMarket.get(m.betfairMarketId);

    // Strategy column: if there's an open bet show its strategy, otherwise qualifying strategies.
    // Wraps each strategy label in a tooltip showing the strategy's full definition.
    const _badgeWithTip = (name, color) =>
      `<span class="badge badge-${color}" title="${_stratTooltipText(name)}">${name}</span>`;
    let stratBadge;
    if (openPos?.strategyName) {
      stratBadge = _badgeWithTip(openPos.strategyName, 'green');
    } else if (qualSys.length) {
      stratBadge = qualSys.map(s => _badgeWithTip(s, 'blue')).join(' ');
    } else {
      stratBadge = badge('None', 'gray');
    }

    // Bet column: side + player + strategy label
    let betBadge = '';
    if (openPos) {
      const sideLabel = `${openPos.side}${openPos.playerKey ? ' ' + openPos.playerKey : ''}`;
      const stratLabel = openPos.strategyName ? `<span style="font-size:9px;opacity:.8"> · ${openPos.strategyName}</span>` : '';
      const stratTip   = openPos.strategyName ? ` title="${_stratTooltipText(openPos.strategyName)}"` : '';
      betBadge = `<span class="badge badge-yellow"${stratTip}>${sideLabel}${stratLabel}</span>`;
    }
    const eA = m.edgeA, eB = m.edgeB;
    const bestEdge   = eA != null && eB != null ? (eA > eB ? eA : eB) : (eA ?? eB);
    const linked = m.externalMatchId ? '' : ' <span style="color:var(--red);font-size:10px">✗</span>';
    const isExpanded = _expandedMarket === m.betfairMarketId;
    return `<tr class="live-row${isExpanded ? ' selected' : ''}" data-id="${m.betfairMarketId}" style="cursor:pointer">
      <td class="wrap"><strong>${m.matchName || '—'}</strong>${linked}${(m.betfairEventName || m.tournament) ? `<br><span style="font-size:10px;color:var(--muted)">${m.betfairEventName || m.tournament}</span>` : ''}</td>
      <td class="score">${setStr}</td>
      <td>${fmt.odds(m.playerABack)}</td>
      <td>${fmt.odds(m.playerBBack)}</td>
      <td class="${bestEdge != null ? pnlClass(bestEdge) : ''}">${bestEdge != null ? fmt.pct(bestEdge) : '—'}</td>
      <td>${fmt.vol(m.matchedVolume)}</td>
      <td>${stratBadge}</td>
      <td>${betBadge}</td>
    </tr>
    <tr class="live-detail-row" style="${isExpanded ? '' : 'display:none'}">
      <td colspan="8" style="padding:0">${isExpanded ? buildMatchDetail(m, openByMarket.get(m.betfairMarketId)) : ''}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr.live-row').forEach(tr => {
    tr.addEventListener('click', async () => {
      const mid    = tr.dataset.id;
      const detRow = tr.nextElementSibling;
      if (_expandedMarket === mid) {
        _expandedMarket = null;
        tr.classList.remove('selected');
        detRow.style.display = 'none';
      } else {
        tbody.querySelectorAll('tr.live-row.selected').forEach(r => { r.classList.remove('selected'); if (r.nextElementSibling) r.nextElementSibling.style.display = 'none'; });
        _expandedMarket = mid;
        tr.classList.add('selected');
        const m = S.liveMatches.find(x => x.betfairMarketId === mid);
        detRow.querySelector('td').innerHTML = buildMatchDetail(m, openByMarket.get(mid), 'ch');
        detRow.style.display = '';
        loadMatchCharts(mid, m, 'ch');
        loadMilestones(mid, 'ch');
      }
    });
  });

  // Restore previously expanded market after every tbody rebuild
  if (_expandedMarket) {
    const tr = tbody.querySelector(`tr.live-row[data-id="${_expandedMarket}"]`);
    if (tr) {
      const m = S.liveMatches.find(x => x.betfairMarketId === _expandedMarket);
      if (m) {
        tr.classList.add('selected');
        const detRow = tr.nextElementSibling;
        detRow.querySelector('td').innerHTML = buildMatchDetail(m, openByMarket.get(_expandedMarket), 'ch');
        detRow.style.display = '';
        loadMatchCharts(_expandedMarket, m, 'ch');
        loadMilestones(_expandedMarket, 'ch');
      } else {
        _expandedMarket = null;
      }
    } else {
      _expandedMarket = null;
    }
  }

  updateLiveStats();
}

function buildMatchDetail(m, openPos, prefix = 'ch') {
  if (!m) return '';
  const [nA, nB] = (m.matchName || '').split(' v ').map(s => s.trim());
  const ssA  = m.liveServeStats?.playerA  || {};
  const ssB  = m.liveServeStats?.playerB  || {};
  const s1A  = m.liveServeStatsSet1?.playerA || {};
  const s1B  = m.liveServeStatsSet1?.playerB || {};
  const s2A  = m.liveServeStatsSet2?.playerA || {};
  const s2B  = m.liveServeStatsSet2?.playerB || {};
  const bpA  = m.breakPoints?.playerA || {};
  const bpB  = m.breakPoints?.playerB || {};
  const bp1A = m.breakPointsSet1?.playerA || {};
  const bp1B = m.breakPointsSet1?.playerB || {};
  const bp2A = m.breakPointsSet2?.playerA || {};
  const bp2B = m.breakPointsSet2?.playerB || {};
  const hasStats  = ssA.firstServeIn != null || s1A.firstServeIn != null;
  const hasSet2   = s2A.firstServeIn != null || s2B.firstServeIn != null;
  const sfA = m.playerASurfaceStats;
  const sfB = m.playerBSurfaceStats;

  const kv = (k, v) => v != null && v !== '—' && v !== '' ? `<div class="det-kv"><span class="det-k">${k}</span><span class="det-v">${v}</span></div>` : '';
  const pct2 = v => v != null ? `${v.toFixed(1)}%` : null;
  const sv = (a, b) => (a != null || b != null) ? `${pct2(a) || '—'} / ${pct2(b) || '—'}` : null;
  const hdStat = (lbl, val) => `<div class="mdi-hd-stat"><span class="mdi-hd-val">${val}</span><span class="mdi-hd-lbl">${lbl}</span></div>`;

  const gameScore = m.currentGame ? `${m.currentGame.playerA ?? 0} – ${m.currentGame.playerB ?? 0}` : null;
  const server    = m.currentServer === 'playerA' ? nA : m.currentServer === 'playerB' ? nB : null;
  const momVal    = m.momentumIndex != null ? `<span class="${pnlClass(m.momentumIndex)}">${m.momentumIndex > 0 ? '+' : ''}${m.momentumIndex.toFixed(0)}</span>` : '—';
  const eA = m.edgeA != null ? `<span class="${pnlClass(m.edgeA)}">${fmt.pct(m.edgeA)}</span>` : '—';
  const eB = m.edgeB != null ? `<span class="${pnlClass(m.edgeB)}">${fmt.pct(m.edgeB)}</span>` : '—';

  let html = `<div class="match-detail-inline">
  <div class="mdi-header">
    <div class="mdi-hd-name">${m.matchName || '—'}${m.tournamentRound ? `<span style="font-weight:400;color:var(--muted);font-size:11px;margin-left:8px">${m.tournamentRound}</span>` : ''}</div>
    <div class="mdi-hd-score">${score(m.sets) || '—'}</div>
    <div class="mdi-hd-stats">
      ${hdStat(`${nA || 'A'} back`, fmt.odds(m.playerABack))}
      ${hdStat(`${nB || 'B'} back`, fmt.odds(m.playerBBack))}
      ${gameScore ? hdStat('Game', gameScore) : ''}
      ${server ? hdStat('Serving', server) : ''}
      ${hdStat('Momentum', momVal)}
      ${hdStat('Vol', fmt.vol(m.matchedVolume))}
      ${hdStat(`Edge ${nA || 'A'}`, eA)}
      ${hdStat(`Edge ${nB || 'B'}`, eB)}
    </div>
  </div>
  <div class="mdi-grid">
    <div class="mdi-section">
      <div class="mdi-title">Prices</div>
      ${kv(`${nA || 'A'} back / lay`, `${fmt.odds(m.playerABack)} / ${fmt.odds(m.playerALay)}`)}
      ${kv(`${nB || 'B'} back / lay`, `${fmt.odds(m.playerBBack)} / ${fmt.odds(m.playerBLay)}`)}
      ${kv('Pre-match A', fmt.odds(m.preMatchOddsA))}
      ${kv('Pre-match B', fmt.odds(m.preMatchOddsB))}
    </div>
    <div class="mdi-section">
      <div class="mdi-title">Strategy</div>
      ${kv('Qualifying', (m.qualifyingSystems || []).length
            ? (m.qualifyingSystems).map(_stratChip).join(', ')
            : 'None')}
      ${kv('Surface', m.surface)}
      ${kv('Tournament', m.tournament)}
      ${m.playerARank ? kv(`${nA || 'A'} rank`, `#${m.playerARank}`) : ''}
      ${m.playerBRank ? kv(`${nB || 'B'} rank`, `#${m.playerBRank}`) : ''}
      ${m.h2hStats ? kv('H2H record', `${m.h2hStats.p1Wins || 0}–${m.h2hStats.p2Wins || 0} (${m.h2hStats.total || 0} total)`) : ''}
      ${openPos ? kv('Open bet', `${openPos.side} on ${openPos.playerKey === 'A' ? nA : nB} @ ${fmt.odds(openPos.odds)} £${openPos.stake?.toFixed(2) || '—'}`) : ''}
    </div>`;

  if (hasStats) {
    const bpRow = (a, b) => `${a.converted ?? 0}/${a.created ?? 0} / ${b.converted ?? 0}/${b.created ?? 0}`;
    const serveBlock = (a, b, bpA2, bpB2) => `
      ${kv('1st serve in',  sv(a.firstServeIn,  b.firstServeIn))}
      ${kv('1st serve won', sv(a.firstServeWon, b.firstServeWon))}
      ${kv('2nd serve won', sv(a.secondServeWon, b.secondServeWon))}
      ${kv('Aces',         `${a.aces ?? '—'} / ${b.aces ?? '—'}`)}
      ${kv('Double faults',`${a.doubleFaults ?? '—'} / ${b.doubleFaults ?? '—'}`)}
      ${(bpA2?.created || bpB2?.created) ? kv('Break pts won', bpRow(bpA2 || {}, bpB2 || {})) : ''}`;

    html += `<div class="mdi-section">
      <div class="mdi-title">Serve Stats (${nA || 'A'} / ${nB || 'B'})</div>
      <div class="mdi-subtitle">Match</div>
      ${serveBlock(ssA, ssB, bpA, bpB)}
      ${s1A.firstServeIn != null ? `<div class="mdi-subtitle">Set 1</div>${serveBlock(s1A, s1B, bp1A, bp1B)}` : ''}
      ${hasSet2 ? `<div class="mdi-subtitle">Set 2</div>${serveBlock(s2A, s2B, bp2A, bp2B)}` : ''}
    </div>`;
  }

  const surfRec = (sf, surf) => {
    const s = sf?.surface?.[surf];
    return s ? `${s.won || 0}W-${s.lost || 0}L${s.winRate != null ? ` (${(s.winRate * 100).toFixed(0)}%)` : ''}` : null;
  };
  const formStr = arr => arr?.length ? arr.map(r => `<span class="${r === 'W' ? 'val-pos' : 'val-neg'}">${r}</span>`).join('') : null;
  const surf = m.surface?.toLowerCase();
  const hasSurfaceForm = sfA?.surface || sfB?.surface || m.h2hStats?.p1RecentForm || m.playerACountry;
  if (hasSurfaceForm) {
    html += `<div class="mdi-section">
      <div class="mdi-title">Form & Surface</div>
      ${m.playerACountry || m.playerBCountry ? kv('Countries', `${m.playerACountry || '—'} / ${m.playerBCountry || '—'}`) : ''}
      ${m.h2hStats?.p1RecentForm ? kv(`${nA || 'A'} form`, formStr(m.h2hStats.p1RecentForm) || '—') : ''}
      ${m.h2hStats?.p2RecentForm ? kv(`${nB || 'B'} form`, formStr(m.h2hStats.p2RecentForm) || '—') : ''}
      ${surf ? kv(`${surf.charAt(0).toUpperCase()+surf.slice(1)} record`, `${surfRec(sfA, surf) || '—'} / ${surfRec(sfB, surf) || '—'}`) : ''}
      ${sfA?.surface ? kv(`${nA || 'A'} H/C/G`, `${sfA.surface.hard?.won||0}-${sfA.surface.hard?.lost||0} / ${sfA.surface.clay?.won||0}-${sfA.surface.clay?.lost||0} / ${sfA.surface.grass?.won||0}-${sfA.surface.grass?.lost||0}`) : ''}
      ${sfB?.surface ? kv(`${nB || 'B'} H/C/G`, `${sfB.surface.hard?.won||0}-${sfB.surface.hard?.lost||0} / ${sfB.surface.clay?.won||0}-${sfB.surface.clay?.lost||0} / ${sfB.surface.grass?.won||0}-${sfB.surface.grass?.lost||0}`) : ''}
    </div>`;
  }

  // Chart containers — populated async after render
  const mid = m.betfairMarketId;
  const p   = prefix + '-';
  html += `</div>
  <div class="mdi-milestones" id="${p}ms-${mid}" style="display:none"></div>
  <div class="mdi-charts">
    <div>
      <div class="mdi-chart-title">${nA || 'A'} vs ${nB || 'B'} — Odds</div>
      <div class="mdi-chart-wrap"><canvas id="${p}odds-${mid}"></canvas></div>
    </div>
    <div>
      <div class="mdi-chart-title">Momentum (+ = ${nA || 'A'}, − = ${nB || 'B'})</div>
      <div class="mdi-chart-wrap"><canvas id="${p}mom-${mid}"></canvas></div>
    </div>
    <div>
      <div class="mdi-chart-title">Edge A vs Edge B (%)</div>
      <div class="mdi-chart-wrap"><canvas id="${p}edge-${mid}"></canvas></div>
    </div>
    <div>
      <div class="mdi-chart-title">Volume</div>
      <div class="mdi-chart-wrap"><canvas id="${p}vol-${mid}"></canvas></div>
    </div>
  </div>
  </div>`;
  return html;
}

// Per-market chart instances and snapshot cache
const _matchCharts    = new Map();  // key → Chart[]
const _snapCache      = new Map();  // marketId → { snaps, loadedAt }
const _msCache        = new Map();  // marketId → { rows, loadedAt }
const SNAP_CACHE_TTL  = 60_000;
const MS_CACHE_TTL    = 300_000;    // milestones rarely change — cache 5 min

// Vertical-line plugin for set-transition markers on time-series charts.
// Configured per-chart via `plugins.setMarkers.markers = [{index, label}, ...]`.
// Registered once at module load.
if (typeof Chart !== 'undefined' && !window._setMarkerPluginRegistered) {
  Chart.register({
    id: 'setMarkers',
    afterDatasetsDraw(chart, _args, opts) {
      const markers = opts?.markers || [];
      if (!markers.length) return;
      const x = chart.scales.x, y = chart.scales.y;
      const ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(180,170,90,.55)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(220,210,140,.95)';
      for (const m of markers) {
        const px = x.getPixelForValue(m.index);
        if (!isFinite(px)) continue;
        ctx.beginPath();
        ctx.moveTo(px, y.top);
        ctx.lineTo(px, y.bottom);
        ctx.stroke();
        if (m.label) ctx.fillText(m.label, px + 3, y.top + 10);
      }
      ctx.restore();
    },
  });
  window._setMarkerPluginRegistered = true;
}

/** Detect set transitions in a snapshot stream. Returns [{index, label}]. */
function _detectSetMarkers(snaps) {
  const out = [];
  let prevLen = 0, prevLast = null;
  snaps.forEach((s, i) => {
    let sets = null;
    if (s.sets) { try { sets = typeof s.sets === 'string' ? JSON.parse(s.sets) : s.sets; } catch (_) {} }
    if (!Array.isArray(sets)) return;
    if (sets.length > prevLen) {
      // New set just started — the just-completed set is at index prevLen-1 of prev OR sets[prevLen-1] of new array.
      const justClosed = sets[prevLen - 1] || prevLast;
      const label = justClosed && justClosed.length === 2
        ? `S${prevLen} end: ${justClosed[0]}-${justClosed[1]}`
        : `S${prevLen} end`;
      if (prevLen > 0) out.push({ index: i, label });
    }
    prevLen  = sets.length;
    prevLast = sets[sets.length - 1] || prevLast;
  });
  return out;
}

async function loadMatchCharts(marketId, m, prefix = 'ch') {
  const key = `${prefix}:${marketId}`;

  // Destroy previous charts for this key
  const prev = _matchCharts.get(key);
  if (prev) { prev.forEach(c => { try { c.destroy(); } catch(_) {} }); _matchCharts.delete(key); }

  // Helper to plant a "no data" placeholder in each chart canvas's parent
  // when there's nothing to draw, so the user sees why the chart is empty
  // instead of just a blank box.
  const showNoData = (msg) => {
    for (const slot of ['odds','mom','edge','vol']) {
      const c = document.getElementById(`${prefix}-${slot}-${marketId}`);
      if (c) c.parentElement.innerHTML = `<div style="height:140px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted);text-align:center;padding:0 10px">${msg}</div>`;
    }
  };

  try {
    // Use cached snapshots if fresh enough (avoids re-fetching on every 5s tbody rebuild)
    const now    = Date.now();
    const cached = _snapCache.get(marketId);
    let snaps;
    if (cached && now - cached.loadedAt < SNAP_CACHE_TTL) {
      snaps = cached.snaps;
    } else {
      // No `since` filter — fetch every snapshot for this market. The query
      // is bounded by match duration (~1.5-3h, ~1000-3000 rows). Was previously
      // capped at the last 4 hours, which broke charts for any bet older than
      // ~4h since the snapshots fell outside the window.
      snaps = await api(`/api/db/markets/${marketId}/snapshots`);
      _snapCache.set(marketId, { snaps, loadedAt: now });
    }
    if (!snaps.length) {
      showNoData('No snapshot data — this market\'s rows were pruned from market_snapshots');
      return;
    }

    const [nA, nB] = (m?.matchName || '').split(' v ').map(s => s.trim());
    const labels   = snaps.map(s => fmt.ts(s.ts));
    const setMarkers = _detectSetMarkers(snaps);  // shared across all charts for this market

    const mkLine = (id, datasets, yLabel, yMin, yMax) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const ctx = el.getContext('2d');
      return new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: {
            legend:     { display: datasets.length > 1, position: 'top', labels: { boxWidth: 10, font: { size: 10 } } },
            setMarkers: { markers: setMarkers },
          },
          scales: {
            x: { ticks: { maxTicksLimit: 6, font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
            y: { ...(yMin != null ? { min: yMin } : {}), ...(yMax != null ? { max: yMax } : {}),
                 title: { display: !!yLabel, text: yLabel, font: { size: 10 } },
                 ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
          },
        },
      });
    };

    const p = `${prefix}-`;
    const charts = [
      mkLine(`${p}odds-${marketId}`, [
        { label: nA || 'A', data: snaps.map(s => s.player_a_back), borderColor: '#4f8ef7', borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
        { label: nB || 'B', data: snaps.map(s => s.player_b_back), borderColor: '#ef4444', borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
      ], 'Back Price'),

      (() => {
        const momData = snaps.map(s => s.momentum_index);
        const hasRealMom = momData.some(v => v != null && v !== 0);
        if (!hasRealMom) {
          // Show placeholder when no momentum data yet
          const el = document.getElementById(`${p}mom-${marketId}`);
          if (el) {
            el.parentElement.innerHTML = `<div class="mdi-chart-title">Momentum</div><div style="height:140px;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--muted)">No momentum data yet — accumulates after a few games</div>`;
          }
          return null;
        }
        return mkLine(`${p}mom-${marketId}`, [
          { label: 'Momentum', data: momData, borderColor: '#f59e0b', borderWidth: 1.5, pointRadius: 0, tension: 0.3,
            fill: true, backgroundColor: ctx => {
              const gradient = ctx.chart.ctx.createLinearGradient(0, 0, 0, 140);
              gradient.addColorStop(0, 'rgba(34,197,94,.25)');
              gradient.addColorStop(0.5, 'rgba(255,255,255,0)');
              gradient.addColorStop(1, 'rgba(239,68,68,.25)');
              return gradient;
            }},
        ], '', -100, 100);
      })(),

      mkLine(`${p}edge-${marketId}`, [
        { label: `Edge ${nA || 'A'}`, data: snaps.map(s => s.edge_a), borderColor: '#4f8ef7', borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
        { label: `Edge ${nB || 'B'}`, data: snaps.map(s => s.edge_b), borderColor: '#ef4444', borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
      ], 'Edge %'),

      mkLine(`${p}vol-${marketId}`, [
        { label: 'Volume', data: snaps.map(s => s.matched_volume), borderColor: '#8892a4', borderWidth: 1.5, pointRadius: 0, tension: 0.2, fill: true, backgroundColor: 'rgba(136,146,164,.1)' },
      ], '£ Matched'),
    ].filter(Boolean);

    _matchCharts.set(key, charts);
  } catch (err) {
    console.error('loadMatchCharts failed:', err);
    showNoData(`Chart error: ${err.message}`);
  }
}

async function loadMilestones(marketId, prefix) {
  const elId = `${prefix}-ms-${marketId}`;
  const el   = document.getElementById(elId);
  if (!el) return;

  try {
    const now    = Date.now();
    const cached = _msCache.get(marketId);
    let rows;
    if (cached && now - cached.loadedAt < MS_CACHE_TTL) {
      rows = cached.rows;
    } else {
      rows = await api(`/api/db/markets/${marketId}/price-milestones`);
      _msCache.set(marketId, { rows, loadedAt: now });
    }

    if (!rows.length) { el.style.display = 'none'; return; }

    const pmRow = rows.find(r => r.milestone === 'pre_match');
    const pmA   = pmRow?.player_a_back;
    const pmB   = pmRow?.player_b_back;
    const LABELS = { pre_match:'Pre-match', set_1_end:'Set 1 end', set_2_end:'Set 2 end', set_3_end:'Set 3 end', match_end:'Match end' };
    const m  = (S.liveMatches || []).find(x => x.betfairMarketId === marketId);
    const [nA, nB] = (m?.matchName || '').split(' v ').map(s => s.trim());

    const movCell = (curr, base, isBase) => {
      if (isBase) return curr != null ? curr.toFixed(2) : '—';
      if (!curr)  return '—';
      const cls = (!base || curr === base) ? '' : curr > base ? 'val-pos' : 'val-neg';
      const pct = base ? ((curr - base) / base * 100) : 0;
      const pctStr = base ? ` <span class="${cls}" style="font-size:10px">${pct > 0 ? '+' : ''}${pct.toFixed(1)}%</span>` : '';
      return `${curr.toFixed(2)}${pctStr}`;
    };

    el.style.display = '';
    el.innerHTML = `
      <div class="mdi-title" style="margin-bottom:8px">Price Movement</div>
      <table style="width:100%;font-size:11px;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;padding:3px 8px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:600">Stage</th>
          <th style="text-align:center;padding:3px 8px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:600">${nA || 'A'}</th>
          <th style="text-align:center;padding:3px 8px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:600">${nB || 'B'}</th>
          <th style="text-align:left;padding:3px 8px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:600">Score</th>
          <th style="text-align:right;padding:3px 8px;border-bottom:1px solid var(--border);color:var(--muted);font-weight:600">Vol</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => {
            const isBase = r.milestone === 'pre_match';
            return `<tr>
              <td style="padding:3px 8px;color:var(--muted)">${LABELS[r.milestone] || r.milestone}</td>
              <td style="padding:3px 8px;text-align:center">${movCell(r.player_a_back, pmA, isBase)}</td>
              <td style="padding:3px 8px;text-align:center">${movCell(r.player_b_back, pmB, isBase)}</td>
              <td style="padding:3px 8px;color:var(--muted);font-size:10px">${r.set_score || '—'}</td>
              <td style="padding:3px 8px;text-align:right;color:var(--muted)">${r.matched_volume ? fmt.vol(r.matched_volume) : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (_) {
    el.style.display = 'none';
  }
}

function initLiveTab() {
  ['live-search','live-linked','live-strategy'].forEach(id => {
    $(id).addEventListener('input', renderLiveTable);
    $(id).addEventListener('change', renderLiveTable);
  });

  initUpcoming();

  // Sortable columns
  document.querySelectorAll('#live-table thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      _sortLive = _sortLive.col === col ? { col, dir: -_sortLive.dir } : { col, dir: -1 };
      document.querySelectorAll('#live-table thead th').forEach(t => t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(_sortLive.dir === 1 ? 'sort-asc' : 'sort-desc');
      renderLiveTable();
    });
  });
}

// ── BETS TAB ──────────────────────────────────────────────────────────────────
async function _DEAD_openDetail(marketId) {
  _detailMarketId = marketId;
  renderLiveTable(); // re-highlight

  const panel = $('detail-panel');
  panel.classList.add('open');
  $('detail-body').innerHTML = '<div style="padding:20px;text-align:center"><span class="spinner"></span></div>';

  const m = S.liveMatches.find(x => x.betfairMarketId === marketId);
  $('detail-title').textContent = m?.matchName || marketId;

  try {
    const [snapshots, bets, milestones] = await Promise.all([
      api(`/api/db/markets/${marketId}/snapshots`),
      api(`/api/db/markets/${marketId}/bets`),
      api(`/api/db/markets/${marketId}/price-milestones`).catch(() => []),
    ]);
    renderDetailBody(marketId, m, snapshots, bets, [], milestones);
  } catch (e) {
    $('detail-body').innerHTML = `<div class="empty">Error loading detail: ${e.message}</div>`;
  }
}

function renderDetailBody(marketId, m, snapshots, bets, rejections, milestones = []) {
  const [nA, nB] = (m?.matchName || '').split(' v ').map(s => s.trim());
  const openOrder = S.openOrders.find(o => o.marketId === marketId);

  let html = '';

  // ── Current state ──────────────────────────────────────────────────────────
  if (m) {
    const setStr = score(m.sets);
    const pmA = m.preMatchOddsA, pmB = m.preMatchOddsB;
    html += `<div class="detail-section">
      <h4>Current State</h4>
      <div class="kv-grid">
        <div class="kv"><div class="k">Score</div><div class="v score">${setStr}</div></div>
        <div class="kv"><div class="k">Surface</div><div class="v">${m.surface || '—'}</div></div>
        <div class="kv"><div class="k">Tournament</div><div class="v">${m.tournament || '—'}</div></div>
        <div class="kv"><div class="k">Server</div><div class="v">${m.currentServer === 'playerA' ? nA : m.currentServer === 'playerB' ? nB : '—'}</div></div>
        <div class="kv"><div class="k">Odds A (back/lay)</div><div class="v">${fmt.odds(m.playerABack)} / ${fmt.odds(m.playerALay)}</div></div>
        <div class="kv"><div class="k">Odds B (back/lay)</div><div class="v">${fmt.odds(m.playerBBack)} / ${fmt.odds(m.playerBLay)}</div></div>
        <div class="kv"><div class="k">Pre-match A</div><div class="v">${fmt.odds(pmA)}</div></div>
        <div class="kv"><div class="k">Pre-match B</div><div class="v">${fmt.odds(pmB)}</div></div>
        <div class="kv"><div class="k">Edge A</div><div class="v ${pnlClass(m.edgeA)}">${fmt.pct(m.edgeA)}</div></div>
        <div class="kv"><div class="k">Edge B</div><div class="v ${pnlClass(m.edgeB)}">${fmt.pct(m.edgeB)}</div></div>
        <div class="kv"><div class="k">Volume</div><div class="v">${fmt.vol(m.matchedVolume)}</div></div>
        <div class="kv"><div class="k">Stats Linked</div><div class="v">${m.externalMatchId ? '✅' : '❌ No'}</div></div>
        <div class="kv"><div class="k">Strategies</div><div class="v">${(m.qualifyingSystems || []).length ? (m.qualifyingSystems).map(_stratChip).join(', ') : 'None'}</div></div>
      </div>
    </div>`;
  }

  // ── Serve stats ──────────────────────────────────────────────────────────
  if (m?.liveServeStats) {
    const ssA = m.liveServeStats.playerA || {}, ssB = m.liveServeStats.playerB || {};
    const s1A = m.liveServeStatsSet1?.playerA || {}, s1B = m.liveServeStatsSet1?.playerB || {};
    const s2A = m.liveServeStatsSet2?.playerA || {}, s2B = m.liveServeStatsSet2?.playerB || {};
    const _d = (a, b) => (a != null && b != null) ? `${(a - b) > 0 ? '+' : ''}${(a - b).toFixed(0)}pp` : '—';
    const _dCls = (a, b) => (a == null || b == null) ? '' : Math.abs(a - b) >= 20 ? 'val-pos' : '';
    html += `<div class="detail-section">
      <h4>Serve Stats</h4>
      <table style="width:100%;font-size:12px">
        <thead><tr><th style="text-align:left">Stat</th><th>${nA || 'P1'}</th><th>${nB || 'P2'}</th><th title="Player A minus Player B">Δ (A−B)</th></tr></thead>
        <tbody>
          <tr><td>1st In (match)</td><td>${fmt.pct(ssA.firstServeIn)}</td><td>${fmt.pct(ssB.firstServeIn)}</td><td>${_d(ssA.firstServeIn, ssB.firstServeIn)}</td></tr>
          <tr><td>1st Won (match)</td><td>${fmt.pct(ssA.firstServeWon)}</td><td>${fmt.pct(ssB.firstServeWon)}</td><td class="${_dCls(ssA.firstServeWon, ssB.firstServeWon)}">${_d(ssA.firstServeWon, ssB.firstServeWon)}</td></tr>
          <tr><td>2nd Won (match)</td><td>${fmt.pct(ssA.secondServeWon)}</td><td>${fmt.pct(ssB.secondServeWon)}</td><td>${_d(ssA.secondServeWon, ssB.secondServeWon)}</td></tr>
          <tr><td>DFs (match)</td><td>${ssA.doubleFaults ?? '—'}</td><td>${ssB.doubleFaults ?? '—'}</td><td>—</td></tr>
          <tr><td>1st In (set 1)</td><td>${fmt.pct(s1A.firstServeIn)}</td><td>${fmt.pct(s1B.firstServeIn)}</td><td>${_d(s1A.firstServeIn, s1B.firstServeIn)}</td></tr>
          <tr><td>1st Won (set 1)</td><td>${fmt.pct(s1A.firstServeWon)}</td><td>${fmt.pct(s1B.firstServeWon)}</td><td class="${_dCls(s1A.firstServeWon, s1B.firstServeWon)}">${_d(s1A.firstServeWon, s1B.firstServeWon)}</td></tr>
          <tr><td>1st Won (set 2)</td><td>${fmt.pct(s2A.firstServeWon)}</td><td>${fmt.pct(s2B.firstServeWon)}</td><td class="${_dCls(s2A.firstServeWon, s2B.firstServeWon)}">${_d(s2A.firstServeWon, s2B.firstServeWon)}</td></tr>
          <tr><td>DFs (set 1)</td><td>${s1A.doubleFaults ?? '—'}</td><td>${s1B.doubleFaults ?? '—'}</td><td>—</td></tr>
        </tbody>
      </table>
    </div>`;
  }

  // ── Open position ────────────────────────────────────────────────────────
  if (openOrder) {
    const hedgeOdds = openOrder.side === 'BACK'
      ? (m?.playerALay  ?? m?.playerBLay  ?? '')
      : (m?.playerABack ?? m?.playerBBack ?? '');
    html += `<div class="detail-section">
      <h4>Open Position</h4>
      <div class="kv-grid">
        <div class="kv"><div class="k">Player</div><div class="v">${openOrder.playerName}</div></div>
        <div class="kv"><div class="k">Side</div><div class="v">${openOrder.side}</div></div>
        <div class="kv"><div class="k">Odds</div><div class="v">${fmt.odds(openOrder.odds)}</div></div>
        <div class="kv"><div class="k">Stake</div><div class="v">£${openOrder.stake?.toFixed(2) || '—'}</div></div>
        <div class="kv"><div class="k">Placed</div><div class="v">${fmt.ts(openOrder.placedAt)}</div></div>
        <div class="kv"><div class="k">Strategy</div><div class="v">${openOrder.reason || '—'}</div></div>
      </div>
      <button class="btn btn-sm mt8" onclick="fillHedgeCalc('${openOrder.side}',${openOrder.odds || 0},${openOrder.stake || 0},${hedgeOdds || 0})">
        Calculate Hedge →
      </button>
    </div>`;
  }

  // ── Price milestones ─────────────────────────────────────────────────────
  if (milestones.length) {
    const [nA2, nB2] = (m?.matchName || '').split(' v ').map(s => s.trim());
    const LABELS = {
      pre_match: 'Pre-match',
      set_1_end: 'Set 1 end',
      set_2_end: 'Set 2 end',
      set_3_end: 'Set 3 end',
      match_end: 'Match end',
    };
    const pmRow = milestones.find(r => r.milestone === 'pre_match');
    const pmA   = pmRow?.player_a_back;
    const pmB   = pmRow?.player_b_back;

    const movPct = (curr, base) => {
      if (!curr || !base) return '';
      const pct = ((curr - base) / base * 100).toFixed(1);
      const cls = pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'neu';
      return `<span class="${cls}" style="font-size:10px;margin-left:4px">${pct > 0 ? '+' : ''}${pct}%</span>`;
    };

    html += `<div class="detail-section">
      <h4>Price Movement</h4>
      <table style="width:100%;font-size:12px">
        <thead><tr><th style="text-align:left">Milestone</th><th>${nA2 || 'Player A'}</th><th>${nB2 || 'Player B'}</th><th style="text-align:left">Score</th></tr></thead>
        <tbody>${milestones.map(r => `<tr>
          <td>${LABELS[r.milestone] || r.milestone}</td>
          <td>${r.player_a_back != null ? r.player_a_back.toFixed(2) : '—'}${r.milestone !== 'pre_match' ? movPct(r.player_a_back, pmA) : ''}</td>
          <td>${r.player_b_back != null ? r.player_b_back.toFixed(2) : '—'}${r.milestone !== 'pre_match' ? movPct(r.player_b_back, pmB) : ''}</td>
          <td>${r.set_score || '—'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  // ── Odds history chart ───────────────────────────────────────────────────
  html += `<div class="detail-section">
    <h4>Odds History</h4>
    <div class="chart-wrap"><canvas id="odds-chart"></canvas></div>
  </div>`;

  // ── Bets on this market ─────────────────────────────────────────────────
  if (bets.length) {
    html += `<div class="detail-section">
      <h4>Bets on this market</h4>
      <table style="width:100%;font-size:12px">
        <thead><tr><th>Side</th><th>Odds</th><th>Stake</th><th>P&L</th><th>Status</th><th>Time</th></tr></thead>
        <tbody>${bets.map(b => `<tr>
          <td>${b.side}</td>
          <td>${fmt.odds(b.requested_odds)}</td>
          <td>£${b.stake?.toFixed(2) || '—'}</td>
          <td class="${pnlClass(b.pnl)}">${b.pnl != null ? fmt.pnl(b.pnl) : '—'}</td>
          <td>${b.settlement_type ? badge(b.settlement_type, b.pnl >= 0 ? 'green' : 'red') : badge('Open','yellow')}</td>
          <td>${fmt.ts(b.placed_at)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  }

  $('detail-body').innerHTML = html;

  // Render odds chart
  if (snapshots.length > 1) {
    const labels = snapshots.map(s => fmt.ts(s.ts));
    const aData  = snapshots.map(s => s.player_a_back);
    const bData  = snapshots.map(s => s.player_b_back);
    const ctx    = $('odds-chart').getContext('2d');
    if (_oddsChart) _oddsChart.destroy();
    _oddsChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: nA, data: aData, borderColor: '#4f8ef7', borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: nB, data: bData, borderColor: '#ef4444', borderWidth: 2, pointRadius: 0, tension: 0.3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'top' } },
        scales: {
          x: { ticks: { maxTicksLimit: 8 } },
          y: { title: { display: true, text: 'Back Price' } },
        },
      },
    });
  }
}

// ── BETS TAB ──────────────────────────────────────────────────────────────────
let _betsPage = 0;
const BETS_PAGE_SIZE = 25;

// SQ Δ buckets — pills the user toggles to filter the bets list. Each bucket
// is [min, max] inclusive on the low end / exclusive on the high. Negatives
// included so the filter actually works for diffs.
const SQ_BUCKETS = [
  { id: 'lt-40', label: '≤−40', test: v => v <= -40 },
  { id: '-40',   label: '−40..−20', test: v => v > -40 && v <= -20 },
  { id: '-20',   label: '−20..−10', test: v => v > -20 && v <= -10 },
  { id: '0',     label: '−10..10',  test: v => v > -10 && v <  10 },
  { id: '10',    label: '10..20',   test: v => v >= 10 && v <  20 },
  { id: '20',    label: '20..40',   test: v => v >= 20 && v <  40 },
  { id: 'gt40',  label: '≥40',      test: v => v >= 40 },
];
const _selectedSqBuckets = new Set();
const _SQ_SET_FIELD = {
  trig:  'bet_player_serve_quality_diff_trigger',
  s1:    'bet_player_serve_quality_diff_s1',
  s2:    'bet_player_serve_quality_diff_s2',
  match: 'bet_player_serve_quality_diff_match',
};

function _renderSqBucketPills() {
  const wrap = $('bets-sq-buckets');
  if (!wrap) return;
  wrap.innerHTML = SQ_BUCKETS.map(b =>
    `<button type="button" data-bid="${b.id}" class="sq-pill${_selectedSqBuckets.has(b.id) ? ' on' : ''}">${b.label}</button>`
  ).join('');
  wrap.querySelectorAll('button[data-bid]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.bid;
      _selectedSqBuckets.has(id) ? _selectedSqBuckets.delete(id) : _selectedSqBuckets.add(id);
      btn.classList.toggle('on');
      _betsPage = 0;
      _applyBetsFilters();
    });
  });
}

function _applyBetsFilters() {
  if (!S.allBets) return;
  const status = $('bets-status').value;
  const sqSet  = $('bets-sq-set')?.value || 'trig';
  const field  = _SQ_SET_FIELD[sqSet] || _SQ_SET_FIELD.trig;
  let rows = [...S.allBets];

  if (status === 'open')  rows = rows.filter(r => !r.settled_at);
  if (status === 'win')   rows = rows.filter(r => r.pnl != null && r.pnl > 0);
  if (status === 'loss')  rows = rows.filter(r => r.pnl != null && r.pnl < 0);

  // Multi-strategy filter (empty Set = all)
  if (window._selectedStrats && window._selectedStrats.size > 0) {
    rows = rows.filter(r => window._selectedStrats.has(r.strategy_name));
  }

  // Edge / momentum range filters (empty input = no constraint)
  const _readNum = id => { const v = $(id)?.value; return v === '' || v == null ? null : +v; };
  const _within  = (v, lo, hi) => (v == null ? false : ((lo == null || v >= lo) && (hi == null || v <= hi)));
  const eMin = _readNum('bets-edge-min'), eMax = _readNum('bets-edge-max');
  const mMin = _readNum('bets-mom-min'),  mMax = _readNum('bets-mom-max');
  if (eMin != null || eMax != null) rows = rows.filter(r => _within(r.edge_at_bet,     eMin, eMax));
  if (mMin != null || mMax != null) rows = rows.filter(r => _within(r.momentum_at_bet, mMin, mMax));

  if (_selectedSqBuckets.size) {
    const tests = SQ_BUCKETS.filter(b => _selectedSqBuckets.has(b.id)).map(b => b.test);
    rows = rows.filter(r => {
      const v = r[field];
      if (v == null) return false;
      return tests.some(t => t(v));
    });
  }

  S.bets = rows;
  renderBetsTable(rows);
  renderBetStratCharts(rows);
  renderBetStats(rows);             // top cards react live to filters
}

// Multi-strategy filter state. Empty set = "All strategies".
window._selectedStrats = window._selectedStrats || new Set();

/** Union of strategies that have placed bets and strategies that are configured
 *  but haven't fired yet (e.g. new B-side mirrors). Sorted naturally. */
function _allStrategiesForFilter(perfData = []) {
  const fromBets = (perfData || []).map(p => p.strategy_name).filter(Boolean);
  const fromCfg  = Object.keys(window._stratDefs || {});
  return [...new Set([...fromBets, ...fromCfg])].sort(_naturalStratCompare);
}

/** Render the strategy-checkbox panel. Idempotent. */
function _renderStratChecklist(perfData = []) {
  const panel = document.getElementById('bets-strategy-checks');
  if (!panel) return;
  const names = _allStrategiesForFilter(perfData);
  panel.innerHTML = names.map(n => {
    const checked = window._selectedStrats.has(n) ? 'checked' : '';
    const desc    = _stratTooltipText(n);
    return `<label style="display:flex;align-items:center;gap:6px;padding:2px 4px;cursor:pointer;border-radius:3px" title="${desc}">
      <input type="checkbox" class="bets-strat-check" data-strat="${n}" ${checked}> ${n}
    </label>`;
  }).join('') || '<div style="color:var(--muted);font-size:11px">No strategies known yet</div>';
  panel.querySelectorAll('.bets-strat-check').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const name = e.target.dataset.strat;
      if (e.target.checked) window._selectedStrats.add(name);
      else                   window._selectedStrats.delete(name);
      _updateStratFilterLabel();
      _applyBetsFilters();
    });
  });
  _updateStratFilterLabel();
}

function _updateStratFilterLabel() {
  const btn = document.getElementById('bets-strategy-btn');
  if (!btn) return;
  const n = window._selectedStrats.size;
  btn.firstChild.textContent = n === 0 ? 'All strategies ' : `Strategies: ${n} ` ;
}

// Wire panel open/close + select-all / clear once
function _initStratFilterWiring() {
  if (window._stratFilterWired) return;
  const btn   = document.getElementById('bets-strategy-btn');
  const panel = document.getElementById('bets-strategy-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn) panel.style.display = 'none';
  });
  document.getElementById('bets-strategy-all')?.addEventListener('click', () => {
    _allStrategiesForFilter(S.performance).forEach(n => window._selectedStrats.add(n));
    _renderStratChecklist(S.performance);
    _applyBetsFilters();
  });
  document.getElementById('bets-strategy-none')?.addEventListener('click', () => {
    window._selectedStrats.clear();
    _renderStratChecklist(S.performance);
    _applyBetsFilters();
  });
  window._stratFilterWired = true;
}

async function loadBets() {
  const periodVal = $('bets-period').value;
  const since    = periodVal === 'yesterday' ? '-2 days' : periodVal;

  $('bets-tbody').innerHTML = '<tr><td colspan="25" class="empty"><span class="spinner"></span> Loading…</td></tr>';

  try {
    // Always fetch every strategy — client-side filter applies the multi-select.
    const [data, perfData] = await Promise.all([
      api(`/api/db/bets?since=${encodeURIComponent(since)}&limit=2000`),
      api('/api/db/bets/performance'),
    ]);

    let rows = data.bets || [];
    if (periodVal === 'yesterday') {
      const d = new Date(); d.setDate(d.getDate() - 1);
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
      const yyyy_mm_dd = `${y}-${m}-${day}`;
      rows = rows.filter(r => (r.placed_at || '').slice(0, 10) === yyyy_mm_dd);
    }

    S.allBets     = rows;            // post-period rows for the table base
    S.performance = perfData;

    _betsPage = 0;
    _renderSqBucketPills();
    _initStratFilterWiring();
    _renderStratChecklist(perfData);
    _applyBetsFilters();             // applies status + SQ + strategy filters → S.bets → table + stats
    renderBetPerfStats(perfData);

    // Populate live-strategy single-select (kept as-is) with union of configured + bet-emitting strategies.
    const liveSel = $('live-strategy');
    if (liveSel) {
      const existing = new Set(Array.from(liveSel.options).map(o => o.value));
      _allStrategiesForFilter(perfData).forEach(n => {
        if (!existing.has(n)) liveSel.add(new Option(n, n));
      });
    }
  } catch (e) {
    $('bets-tbody').innerHTML = `<tr><td colspan="25" class="empty">Error: ${e.message}</td></tr>`;
  }
}

// Sort strategy names by (alpha prefix, integer, suffix) so '1' < '1h' < '2' < '10'.
function _naturalStratCompare(a, b) {
  const re = /^(.*?)(\d+)(.*)$/;
  const ma = a.match(re), mb = b.match(re);
  if (!ma || !mb) return a.localeCompare(b);
  if (ma[1] !== mb[1]) return ma[1].localeCompare(mb[1]);
  const na = parseInt(ma[2], 10), nb = parseInt(mb[2], 10);
  if (na !== nb) return na - nb;
  return ma[3].localeCompare(mb[3]);
}

function _sqDiffCell(v) {
  if (v == null) return '<span style="color:var(--muted)">—</span>';
  const col = v >= 15 ? 'var(--green)' : v <= -15 ? 'var(--red)' : 'var(--text)';
  const fw  = Math.abs(v) >= 15 ? '700' : '500';
  return `<span style="color:${col};font-weight:${fw}">${v > 0 ? '+' : ''}${Math.round(v)}</span>`;
}

function renderBetsTable(rows) {
  const pagEl = $('bets-pagination');
  if (!rows.length) {
    $('bets-tbody').innerHTML = '<tr><td colspan="25" class="empty">No bets found</td></tr>';
    if (pagEl) pagEl.style.display = 'none';
    return;
  }
  const { col, dir } = _sortBets;
  rows = [...rows].sort((a, b) => {
    const av = a[col], bv = b[col];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;       // nulls always sink to bottom
    if (bv == null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return dir * (bv - av);
    return dir * String(bv).localeCompare(String(av));
  });

  const total      = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / BETS_PAGE_SIZE));
  if (_betsPage >= totalPages) _betsPage = totalPages - 1;
  const start = _betsPage * BETS_PAGE_SIZE;
  const pageRows = rows.slice(start, start + BETS_PAGE_SIZE);

  $('bets-tbody').innerHTML = pageRows.map((r, i) => {
    const settled = r.settlement_type;
    // Live-match cache: still used for the live SCORE field (so in-play matches
    // show their current point-by-point score). The status badge no longer relies on
    // it — see match_state below.
    const liveMatch = S.liveMatches.find(m => m.betfairMarketId === r.betfair_market_id);
    // match_state comes from the server (replaces the old !liveMatch heuristic that
    // misclassified in-progress matches as 'Finished' when the live cache was stale).
    // States: 'finished' | 'in_progress' | 'unknown' | (absent)
    const statusBadge = settled
      ? badge(settled, r.pnl >= 0 ? 'green' : 'red')
      : r.match_state === 'finished'    ? badge('Finished',    'blue')
      : r.match_state === 'in_progress' ? badge('In Play',     'yellow')
      : r.match_state === 'unknown'     ? badge('Unknown',     'gray')
      :                                    badge('Open',        'yellow');
    const pnlHtml = r.pnl != null ? `<span class="${pnlClass(r.pnl)}">${fmt.pnl(r.pnl)}</span>` : '—';
    // Score: prefer live data, fall back to latest_sets from DB
    let scoreStr = '—';
    if (liveMatch?.sets?.length) {
      scoreStr = score(liveMatch.sets);
    } else if (r.latest_sets) {
      try {
        const sets = JSON.parse(r.latest_sets);
        scoreStr = score(sets);
      } catch (_) {}
    }

    const stratName = r.strategy_name || '—';
    const subStrat  = r.sub_strategy || (stratName !== '—' && r.player_key
                        ? (/_P[12]$/.test(stratName)
                              ? stratName
                              : `${stratName}-${r.player_key === 'A' ? 'P1' : 'P2'}`)
                        : null);
    const stratLabel = subStrat || stratName;
    const stratTip   = _stratTooltipText(stratName);
    const fmtMom = v => (v == null) ? '—'
                    : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${(+v).toFixed(2)}</span>`;
    // edge_at_bet is already stored in percentage points (matchState.js multiplies
    // (trueProb − impliedProb) by 100 before persisting). Do NOT multiply again.
    const fmtEdge = v => (v == null) ? '—'
                    : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${(+v).toFixed(2)} pp</span>`;
    const liab = r.liability != null
                  ? r.liability
                  : (r.side === 'LAY' && r.stake && r.requested_odds
                        ? r.stake * (r.requested_odds - 1)
                        : r.stake);
    return `<tr class="bet-row" data-betidx="${i}" style="cursor:pointer">
      <td class="wrap"><strong>${r.match_name || '—'}</strong></td>
      <td class="score">${scoreStr}</td>
      <td><span class="strategy-tag" title="${stratTip}">${stratLabel}</span></td>
      <td>${r.player_name || '—'}</td>
      <td>${r.side || '—'}</td>
      <td>${fmt.odds(r.requested_odds)}</td>
      <td>£${r.stake?.toFixed(2) || '—'}</td>
      <td>${liab != null ? '£' + (+liab).toFixed(2) : '—'}</td>
      <td>${pnlHtml}</td>
      <td>${fmtMom(r.momentum_at_bet)}</td>
      <td>${fmtEdge(r.edge_at_bet)}</td>
      <td>${statusBadge}</td>
      <td>${r.dry_run ? badge('DRY','yellow') : badge('LIVE','blue')}</td>
      <td>${r.hedge_odds != null ? fmt.odds(r.hedge_odds) : '—'}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_s1)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_s2)}</td>
      <td>${_sqDiffCell(
        (r.bet_player_serve_quality_diff_s2 != null && r.bet_player_serve_quality_diff_s1 != null)
          ? r.bet_player_serve_quality_diff_s2 - r.bet_player_serve_quality_diff_s1
          : null
      )}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_trigger)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_match)}</td>
      <td title="${
        r.surface_wr_diff != null
          ? `P1 ${r.surface_p1_wins_used}/${r.surface_p1_total_used} vs P2 ${r.surface_p2_wins_used}/${r.surface_p2_total_used} (source: ${r.surface_wr_source})`
          : 'No prior data for one or both players on any surface'
      }">${
        r.surface_wr_diff == null ? '—'
          : `<span class="${r.surface_wr_diff > 0 ? 'pos' : r.surface_wr_diff < 0 ? 'neg' : ''}">${r.surface_wr_diff > 0 ? '+' : ''}${r.surface_wr_diff.toFixed(1)}%${r.surface_wr_source !== 'surface' ? '*' : ''}</span>`
      }</td>
      <td>${r.vol_pre_match != null ? fmt.vol(r.vol_pre_match) : '—'}</td>
      <td>${r.vol_set1_end  != null ? fmt.vol(r.vol_set1_end)  : '—'}</td>
      <td>${r.vol_set2_end  != null ? fmt.vol(r.vol_set2_end)  : '—'}</td>
      <td>${fmt.date(r.placed_at)} ${fmt.ts(r.placed_at)}</td>
      <td><button class="del-bet-btn" data-betid="${r.bet_id}" title="Delete bet" onclick="event.stopPropagation();deleteTennisBet('${r.bet_id}')">✕</button></td>
    </tr>
    <tr class="bet-detail-row" id="bet-detail-${i}" style="display:none">
      <td colspan="25" style="padding:0"></td>
    </tr>`;
  }).join('');

  // Click to expand inline detail
  $('bets-tbody').querySelectorAll('tr.bet-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const idx    = tr.dataset.betidx;
      const detRow = document.getElementById(`bet-detail-${idx}`);
      const isOpen = detRow.style.display !== 'none';
      // Collapse all others
      $('bets-tbody').querySelectorAll('.bet-detail-row').forEach(r => { r.style.display = 'none'; });
      $('bets-tbody').querySelectorAll('.bet-row.selected-bet').forEach(r => r.classList.remove('selected-bet'));
      if (!isOpen) {
        tr.classList.add('selected-bet');
        detRow.style.display = '';
        const r = pageRows[idx];
        detRow.querySelector('td').innerHTML = _buildBetDetail(r);
        if (r.betfair_market_id) {
          requestAnimationFrame(() => {
            loadMatchCharts(r.betfair_market_id, { matchName: r.match_name }, 'bch');
            loadMilestones(r.betfair_market_id, 'bch');
          });
        }
      }
    });
  });

  if (totalPages <= 1) {
    if (pagEl) pagEl.style.display = 'none';
  } else {
    pagEl.style.display = 'flex';
    const end = Math.min(start + BETS_PAGE_SIZE, total);
    pagEl.innerHTML = `
      <button class="btn btn-sm" id="bets-prev" ${_betsPage === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span>Page ${_betsPage + 1} / ${totalPages} &nbsp;(${start + 1}–${end} of ${total})</span>
      <button class="btn btn-sm" id="bets-next" ${_betsPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>`;
    $('bets-prev').onclick = () => { _betsPage--; renderBetsTable(S.bets); };
    $('bets-next').onclick = () => { _betsPage++; renderBetsTable(S.bets); };
  }
}

function _buildBetDetail(r, prefix = 'bch') {
  if (!r) return '';
  const mid     = r.betfair_market_id;
  const exitCfg = r.exit_config ? (() => { try { return JSON.parse(r.exit_config); } catch(_) { return null; } })() : null;
  const kv = (k, v) => v != null && v !== '' && v !== '—' ? `<div class="det-kv"><span class="det-k">${k}</span><span class="det-v">${v}</span></div>` : '';

  // Show live serve stats if match is still in play and has actual API data
  const lm = (S.liveMatches || []).find(m => m.betfairMarketId === r.betfair_market_id);
  const hasLiveStats = lm?.liveServeStats?.playerA?.firstServeIn != null || lm?.liveServeStats?.playerB?.firstServeIn != null;
  let serveSection = '';
  if (hasLiveStats) {
    const [nA, nB] = (r.match_name || '').split(' v ').map(s => s.trim());
    const ssA = lm.liveServeStats.playerA || {};
    const ssB = lm.liveServeStats.playerB || {};
    const s1A = lm.liveServeStatsSet1?.playerA || {};
    const s1B = lm.liveServeStatsSet1?.playerB || {};
    const s2A = lm.liveServeStatsSet2?.playerA || {};
    const s2B = lm.liveServeStatsSet2?.playerB || {};
    const bpM = lm.breakPoints || {};
    const bp1 = lm.breakPointsSet1 || {};
    const bp2 = lm.breakPointsSet2 || {};
    const sv  = (a, b) => `${a != null ? a.toFixed(1)+'%' : '—'} / ${b != null ? b.toFixed(1)+'%' : '—'}`;
    const bpRow = (pA, pB) => `${(pA?.converted??0)}/${(pA?.created??0)} / ${(pB?.converted??0)}/${(pB?.created??0)}`;
    const serveBlock = (a, b, bp) => `
      ${kv('1st serve in', sv(a.firstServeIn, b.firstServeIn))}
      ${kv('1st serve won', sv(a.firstServeWon, b.firstServeWon))}
      ${kv('2nd serve won', sv(a.secondServeWon, b.secondServeWon))}
      ${kv('Aces', `${a.aces??'—'} / ${b.aces??'—'}`)}
      ${kv('Double faults', `${a.doubleFaults??'—'} / ${b.doubleFaults??'—'}`)}
      ${(bp?.playerA?.created||bp?.playerB?.created) ? kv('Break pts', bpRow(bp.playerA, bp.playerB)) : ''}`;
    serveSection = `<div class="mdi-section">
      <div class="mdi-title">Live Serve Stats (${nA||'A'} / ${nB||'B'})</div>
      <div class="mdi-subtitle">Match</div>
      ${serveBlock(ssA, ssB, bpM)}
      ${s1A.firstServeIn != null ? `<div class="mdi-subtitle">Set 1</div>${serveBlock(s1A, s1B, bp1)}` : ''}
      ${s2A.firstServeIn != null ? `<div class="mdi-subtitle">Set 2</div>${serveBlock(s2A, s2B, bp2)}` : ''}
    </div>`;
  }

  return `<div class="match-detail-inline"><div class="mdi-grid">
    <div class="mdi-section">
      <div class="mdi-title">Entry</div>
      ${kv('Side', r.side)}
      ${kv('Player', r.player_name)}
      ${kv('Requested odds', fmt.odds(r.requested_odds))}
      ${kv('Actual odds', fmt.odds(r.actual_odds))}
      ${kv('Stake', r.stake != null ? `£${r.stake.toFixed(2)}` : null)}
      ${kv('Liability', r.liability != null ? `£${r.liability.toFixed(2)}` : null)}
      ${kv('Mode', r.dry_run ? badge('DRY RUN','yellow') : badge('LIVE','blue'))}
    </div>
    <div class="mdi-section">
      <div class="mdi-title">Settlement</div>
      ${kv('Status', r.settlement_type || 'Open')}
      ${kv('P&amp;L', r.pnl != null ? `<span class="${pnlClass(r.pnl)}">${fmt.pnl(r.pnl)}</span>` : `<span style="color:var(--muted)">Open — not yet settled</span>`)}
      ${kv('Placed', r.placed_at ? new Date(r.placed_at).toLocaleString('en-GB') : null)}
      ${kv('Settled', r.settled_at ? new Date(r.settled_at).toLocaleString('en-GB') : null)}
      ${exitCfg ? kv('Exit rule', `Hedge out at end of set ${exitCfg.setNumber}`) : ''}
    </div>
    <div class="mdi-section">
      <div class="mdi-title">Context</div>
      ${kv('Strategy', r.strategy_name)}
      ${kv('Signal', r.reason)}
      ${kv('Market', mid)}
    </div>
  </div>
  ${serveSection ? `<div style="padding:0 16px 14px">${serveSection}</div>` : ''}
  <div class="mdi-milestones" id="${prefix}-ms-${mid}" style="display:none"></div>
  <div class="mdi-charts">
    <div>
      <div class="mdi-chart-title">Odds History</div>
      <div class="mdi-chart-wrap"><canvas id="${prefix}-odds-${mid}"></canvas></div>
    </div>
    <div>
      <div class="mdi-chart-title">Momentum</div>
      <div class="mdi-chart-wrap"><canvas id="${prefix}-mom-${mid}"></canvas></div>
    </div>
    <div>
      <div class="mdi-chart-title">Edge</div>
      <div class="mdi-chart-wrap"><canvas id="${prefix}-edge-${mid}"></canvas></div>
    </div>
    <div>
      <div class="mdi-chart-title">Volume</div>
      <div class="mdi-chart-wrap"><canvas id="${prefix}-vol-${mid}"></canvas></div>
    </div>
  </div></div>`;
}

async function deleteTennisBet(betId) {
  if (!confirm('Delete this bet from history?')) return;
  try {
    const r = await fetch(`/api/db/bets/${encodeURIComponent(betId)}`, { method: 'DELETE' });
    if (r.ok) loadBets();
  } catch (e) { alert('Delete failed: ' + e.message); }
}

function renderBetStats(rows) {
  const settled = rows.filter(r => r.pnl != null);
  const wins    = settled.filter(r => r.pnl > 0);
  const pnl     = settled.reduce((s, r) => s + r.pnl, 0);
  const stakes  = settled.reduce((s, r) => s + (r.stake || 0), 0);

  // Days won / days lost
  const byDay = {};
  for (const r of settled) {
    const d = (r.placed_at || '').slice(0, 10);
    if (d) byDay[d] = (byDay[d] || 0) + r.pnl;
  }
  const dayValues = Object.values(byDay);
  const daysWon   = dayValues.filter(v => v > 0).length;
  const daysLost  = dayValues.filter(v => v < 0).length;

  // Worst peak-to-trough drawdown on cumulative P&L
  const sorted = [...settled].sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at));
  let cum = 0, peak = 0, worstDD = 0;
  for (const r of sorted) {
    cum += r.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > worstDD) worstDD = dd;
  }

  $('b-total').textContent   = rows.length;
  $('b-wins').textContent    = wins.length;
  $('b-winrate').textContent = settled.length ? fmt.pct(wins.length / settled.length * 100) : '—';
  $('b-pnl').textContent     = fmt.pnl(pnl);
  $('b-pnl').className       = 'val ' + pnlClass(pnl);
  $('b-roi').textContent     = stakes > 0 ? fmt.pct(pnl / stakes * 100) : '—';
  $('b-days-won').textContent  = daysWon  || '—';
  $('b-days-won').className    = 'val ' + (daysWon  > 0 ? 'pos' : 'neu');
  $('b-days-lost').textContent = daysLost || '—';
  $('b-days-lost').className   = 'val ' + (daysLost > 0 ? 'neg' : 'neu');
  $('b-drawdown').textContent  = worstDD > 0 ? '-£' + worstDD.toFixed(2) : '—';
  $('b-drawdown').className    = 'val ' + (worstDD > 0 ? 'neg' : 'neu');
}

function renderBetPerfStats(_perf) {
  // Header P&L is "today" — set via syncDbSummary, don't overwrite with all-time total here.
}

// ── BETS TAB — SYSTEMS PERFORMANCE CHARTS ────────────────────────────────────
const _SYS_COLORS = [
  { solid: '#58a6ff', bg: 'rgba(88,166,255,.08)'  },
  { solid: '#3fb950', bg: 'rgba(63,185,80,.08)'   },
  { solid: '#f0883e', bg: 'rgba(240,136,62,.08)'  },
  { solid: '#bc8cff', bg: 'rgba(188,140,255,.08)' },
  { solid: '#f85149', bg: 'rgba(248,81,73,.08)'   },
  { solid: '#e3b341', bg: 'rgba(227,179,65,.08)'  },
  { solid: '#4ec9b0', bg: 'rgba(78,201,176,.08)'  },
];
let _betsCumplChart = null;
let _betsBpdChart   = null;
let _betsActiveSys  = '';

function renderBetStratCharts(rows) {
  const strategies = [...new Set(rows.map(r => r.strategy_name).filter(Boolean))].sort();
  const sec = $('bets-systems-section');
  if (!sec) return;
  if (!strategies.length) { sec.style.display = 'none'; return; }
  sec.style.display = '';

  if (_betsActiveSys && !strategies.includes(_betsActiveSys)) _betsActiveSys = '';

  const tabsEl = $('bets-sys-tabs');
  if (tabsEl) {
    tabsEl.innerHTML = [{ id: '', label: 'All Systems', color: null },
      ...strategies.map((s, i) => ({ id: s, label: s, color: _SYS_COLORS[i % _SYS_COLORS.length].solid }))
    ].map(({ id, label, color }) => {
      const active = _betsActiveSys === id;
      const style = color
        ? `border-color:${color};color:${active ? '#fff' : color};background:${active ? color : 'transparent'};`
        : active ? 'background:var(--blue);color:#fff;border-color:var(--blue);' : '';
      return `<button class="btn btn-sm" onclick="setBetsSystem('${id}')" style="${style}">${label}</button>`;
    }).join('');
  }

  _renderBetSysStats(rows, strategies);
  _renderBetSysCharts(rows, strategies);
  _renderBetSysList(rows);
}

function setBetsSystem(sys) {
  _betsActiveSys = sys;
  renderBetStratCharts(S.bets);
}

function _renderBetSysStats(rows, strategies) {
  const statsEl = $('bets-sys-stats');
  if (!statsEl) return;
  const isSettled = r => r.pnl != null;

  if (!_betsActiveSys) {
    statsEl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:4px">
      ${strategies.map((s, i) => {
        const { solid } = _SYS_COLORS[i % _SYS_COLORS.length];
        const sb = rows.filter(r => r.strategy_name === s);
        const won = sb.filter(r => r.pnl > 0).length;
        const lost = sb.filter(r => r.pnl != null && r.pnl <= 0).length;
        const tot = won + lost;
        const pnl = sb.filter(isSettled).reduce((a, r) => a + r.pnl, 0);
        const stk = sb.filter(isSettled).reduce((a, r) => a + (r.stake || 0), 0);
        const roi = stk > 0 ? pnl / stk * 100 : null;
        const oddsArr = sb.filter(r => r.requested_odds);
        const avgOdds = oddsArr.length ? oddsArr.reduce((a, r) => a + r.requested_odds, 0) / oddsArr.length : null;
        const cells = [
          ['Bets',     sb.length,                                             'var(--text)'],
          ['Won',      won,                                                    'var(--green)'],
          ['Lost',     lost,                                                   'var(--red)'],
          ['Win Rate', tot > 0 ? (won/tot*100).toFixed(1)+'%' : '—',         won >= lost ? 'var(--green)' : 'var(--red)'],
          ['Avg Odds', avgOdds != null ? avgOdds.toFixed(2) : '—',           'var(--orange)'],
          ['P&L',      fmt.pnl(pnl),                                          pnl >= 0 ? 'var(--green)' : 'var(--red)'],
          ['ROI',      roi != null ? fmt.pct(roi) : '—',                     roi != null && roi >= 0 ? 'var(--green)' : 'var(--red)'],
        ];
        return `<div style="background:var(--surface2);border:1px solid var(--border);border-top:3px solid ${solid};border-radius:8px;padding:11px">
          <div style="font-size:12px;font-weight:700;color:${solid};margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${s}">${s}</div>
          ${cells.map(([l, v, c]) => `<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid rgba(48,54,61,.3)">
            <span style="font-size:10px;color:var(--muted)">${l}</span>
            <span style="font-size:10px;font-weight:700;color:${c}">${v}</span>
          </div>`).join('')}
        </div>`;
      }).join('')}
    </div>`;
  } else {
    const i = strategies.indexOf(_betsActiveSys);
    const { solid } = _SYS_COLORS[i % _SYS_COLORS.length];
    const sb = rows.filter(r => r.strategy_name === _betsActiveSys);
    const won = sb.filter(r => r.pnl > 0).length;
    const lost = sb.filter(r => r.pnl != null && r.pnl <= 0).length;
    const tot = won + lost;
    const pnl = sb.filter(isSettled).reduce((a, r) => a + r.pnl, 0);
    const stk = sb.filter(isSettled).reduce((a, r) => a + (r.stake || 0), 0);
    const roi = stk > 0 ? pnl / stk * 100 : null;
    const oddsArr = sb.filter(r => r.requested_odds);
    const avgOdds = oddsArr.length ? oddsArr.reduce((a, r) => a + r.requested_odds, 0) / oddsArr.length : null;
    const cells = [
      ['Total',      sb.length,                                             'var(--blue)'],
      ['Won',        won,                                                    'var(--green)'],
      ['Lost',       lost,                                                   'var(--red)'],
      ['Win Rate',   tot > 0 ? (won/tot*100).toFixed(1)+'%' : '—',         won >= lost ? 'var(--green)' : 'var(--red)'],
      ['Avg Odds',   avgOdds != null ? avgOdds.toFixed(2) : '—',           'var(--orange)'],
      ['P&L',        fmt.pnl(pnl),                                          pnl >= 0 ? 'var(--green)' : 'var(--red)'],
      ['ROI',        roi != null ? fmt.pct(roi) : '—',                     roi != null && roi >= 0 ? 'var(--green)' : 'var(--red)'],
    ];
    statsEl.innerHTML = `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:4px">
      ${cells.map(([l, v, c]) => `<div style="background:var(--surface2);border:1px solid var(--border);border-top:3px solid ${solid};border-radius:8px;padding:8px 12px;min-width:72px;text-align:center">
        <div style="font-size:13px;font-weight:700;color:${c}">${v}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">${l}</div>
      </div>`).join('')}
    </div>`;
  }
}

function _renderBetSysCharts(rows, strategies) {
  const co = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1c2128', borderColor: '#30363d', borderWidth: 1, bodyColor: '#e6edf3', padding: 8 } },
    scales: {
      x: { grid: { color: 'rgba(48,54,61,.4)' }, ticks: { color: '#8b949e', font: { size: 10 }, maxTicksLimit: 12 } },
      y: { grid: { color: 'rgba(48,54,61,.4)' }, ticks: { color: '#8b949e', font: { size: 10 } } },
    },
  };
  if (_betsCumplChart) { _betsCumplChart.destroy(); _betsCumplChart = null; }
  if (_betsBpdChart)   { _betsBpdChart.destroy();   _betsBpdChart   = null; }

  const isSettled = r => r.pnl != null;
  const ctxCumpl  = document.getElementById('bets-cumpl-chart');
  const ctxBpd    = document.getElementById('bets-bpd-chart');

  // If either canvas isn't laid out yet (parent flipping from display:none),
  // try again next frame. Otherwise Chart.js renders to 0×0 and never repaints.
  if ((ctxCumpl && (ctxCumpl.offsetWidth === 0 || ctxCumpl.offsetHeight === 0)) ||
      (ctxBpd   && (ctxBpd.offsetWidth   === 0 || ctxBpd.offsetHeight   === 0))) {
    requestAnimationFrame(() => _renderBetSysCharts(rows, strategies));
    return;
  }

  if (!_betsActiveSys) {
    // All systems — multi-line cumulative P&L
    const allDates = new Set();
    const stratDaily = {};
    for (const s of strategies) {
      const pts = rows.filter(r => r.strategy_name === s && isSettled(r)).sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at));
      if (!pts.length) continue;
      stratDaily[s] = {};
      for (const r of pts) {
        const d = (r.placed_at || '').slice(0, 10);
        stratDaily[s][d] = (stratDaily[s][d] || 0) + r.pnl;
        allDates.add(d);
      }
    }
    const days = [...allDates].sort();
    const datasets = strategies.filter(s => stratDaily[s]).map((s, i) => {
      const { solid } = _SYS_COLORS[i % _SYS_COLORS.length];
      let cum = 0;
      const data = days.map(d => {
        if (stratDaily[s][d] != null) cum = parseFloat((cum + stratDaily[s][d]).toFixed(2));
        return { x: d, y: cum };
      });
      return { label: s, data, borderColor: solid, backgroundColor: 'transparent', tension: 0.3, pointRadius: 2, borderWidth: 2, fill: false };
    });
    if (ctxCumpl && datasets.length) {
      _betsCumplChart = new Chart(ctxCumpl, { type: 'line', data: { datasets },
        options: { ...co, plugins: { ...co.plugins, legend: { display: true, labels: { color: '#8b949e', boxWidth: 10, font: { size: 10 } } } },
          scales: { x: { type: 'category', grid: co.scales.x.grid, ticks: co.scales.x.ticks }, y: co.scales.y } } });
    }
    // Bets per day — all strategies combined
    const dm = {};
    for (const r of rows.filter(isSettled)) {
      const d = (r.placed_at || '').slice(0, 10);
      if (!dm[d]) dm[d] = { w: 0, l: 0 };
      if (r.pnl > 0) dm[d].w++; else dm[d].l++;
    }
    const days2 = Object.keys(dm).sort().slice(-45);
    if (ctxBpd && days2.length) {
      _betsBpdChart = new Chart(ctxBpd, { type: 'bar', data: { labels: days2,
        datasets: [
          { label: 'Won',  data: days2.map(d => dm[d].w), backgroundColor: 'rgba(63,185,80,.7)',  borderRadius: 2 },
          { label: 'Lost', data: days2.map(d => dm[d].l), backgroundColor: 'rgba(248,81,73,.7)', borderRadius: 2 },
        ] },
        options: { ...co, plugins: { ...co.plugins, legend: { display: true, labels: { color: '#8b949e', boxWidth: 8, font: { size: 10 } } } },
          scales: { x: { stacked: true, ...co.scales.x }, y: { stacked: true, ...co.scales.y } } } });
    }
  } else {
    // Individual strategy
    const i = strategies.indexOf(_betsActiveSys);
    const { solid, bg } = _SYS_COLORS[i % _SYS_COLORS.length];
    const pts = rows.filter(r => r.strategy_name === _betsActiveSys && isSettled(r)).sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at));
    if (pts.length >= 2) {
      const daily = {};
      for (const r of pts) { const d = (r.placed_at || '').slice(0, 10); daily[d] = (daily[d] || 0) + r.pnl; }
      const days = Object.keys(daily).sort();
      let cum = 0;
      const data = days.map(d => { cum = parseFloat((cum + daily[d]).toFixed(2)); return { x: d, y: cum }; });
      if (ctxCumpl) {
        _betsCumplChart = new Chart(ctxCumpl, { type: 'line', data: { datasets: [{ data, borderColor: solid, backgroundColor: bg, tension: 0.3, pointRadius: 2, borderWidth: 2, fill: true }] },
          options: { ...co, plugins: { ...co.plugins, tooltip: { ...co.plugins.tooltip, callbacks: { label: c => `${c.parsed.y >= 0 ? '+' : ''}£${c.parsed.y.toFixed(2)}` } } },
            scales: { x: { type: 'category', grid: co.scales.x.grid, ticks: co.scales.x.ticks }, y: co.scales.y } } });
      }
    }
    // Bets per day for this strategy
    const dm = {};
    for (const r of rows.filter(r => r.strategy_name === _betsActiveSys && isSettled(r))) {
      const d = (r.placed_at || '').slice(0, 10);
      if (!dm[d]) dm[d] = { w: 0, l: 0 };
      if (r.pnl > 0) dm[d].w++; else dm[d].l++;
    }
    const days2 = Object.keys(dm).sort().slice(-45);
    if (ctxBpd && days2.length) {
      _betsBpdChart = new Chart(ctxBpd, { type: 'bar', data: { labels: days2,
        datasets: [
          { label: 'Won',  data: days2.map(d => dm[d].w), backgroundColor: 'rgba(63,185,80,.7)',  borderRadius: 2 },
          { label: 'Lost', data: days2.map(d => dm[d].l), backgroundColor: 'rgba(248,81,73,.7)', borderRadius: 2 },
        ] },
        options: { ...co, plugins: { ...co.plugins, legend: { display: true, labels: { color: '#8b949e', boxWidth: 8, font: { size: 10 } } } },
          scales: { x: { stacked: true, ...co.scales.x }, y: { stacked: true, ...co.scales.y } } } });
    }
  }
}

function _renderBetSysList(rows) {
  const listEl = $('bets-sys-list');
  if (!listEl) return;
  if (!_betsActiveSys) { listEl.innerHTML = ''; return; }
  const bets = rows.filter(r => r.strategy_name === _betsActiveSys).slice(0, 20);
  if (!bets.length) { listEl.innerHTML = `<div style="font-size:12px;color:var(--muted)">No bets for ${_betsActiveSys} in the selected period.</div>`; return; }
  listEl.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">Last ${bets.length} bets</div>
    <div style="display:flex;flex-direction:column;gap:5px">
      ${bets.map(r => {
        const settled = r.settlement_type;
        const sc = !settled ? 'var(--yellow)' : r.pnl > 0 ? 'var(--green)' : 'var(--red)';
        return `<div style="background:var(--surface2);border:1px solid var(--border);border-left:3px solid ${sc};border-radius:7px;padding:9px 12px">
          <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:3px">
            <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${r.match_name || r.betfair_market_id || '—'}</div>
            <span style="font-size:11px;font-weight:700;color:${sc};white-space:nowrap">${settled ? fmt.pnl(r.pnl) : 'Open'}</span>
          </div>
          <div style="display:flex;gap:8px;font-size:11px;color:var(--muted);flex-wrap:wrap">
            <span>${fmt.date(r.placed_at)} ${fmt.ts(r.placed_at)}</span>
            <span>${r.side || '—'} @ <span style="color:var(--orange);font-weight:600">${fmt.odds(r.requested_odds)}</span></span>
            ${r.player_name ? `<span>${r.player_name}</span>` : ''}
            ${settled ? `<span>${settled}</span>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

const REJ_PAGE_SIZE = 12;
let _rejPage = 0;
let _rejAll  = [];

function renderRejections(rows) {
  _rejAll  = rows;
  _rejPage = 0;
  _renderRejPage();
}

function _renderRejPage() {
  const section = $('bets-rejections-section');
  section.style.display = _rejAll.length ? '' : 'none';
  if (!_rejAll.length) return;

  const total = _rejAll.length;
  const pages = Math.ceil(total / REJ_PAGE_SIZE);
  const start = _rejPage * REJ_PAGE_SIZE;
  const end   = Math.min(start + REJ_PAGE_SIZE, total);

  $('rej-tbody').innerHTML = _rejAll.slice(start, end).map(r => `<tr>
    <td>${fmt.ts(r.ts)}</td>
    <td class="wrap">${r.match_name || '—'}</td>
    <td>${_stratChip(r.strategy_name)}</td>
    <td>${badge(r.rejection_stage || '?', 'yellow')}</td>
    <td class="wrap" style="max-width:280px">${r.rejection_reason || '—'}</td>
    <td>${fmt.odds(r.odds)}</td>
  </tr>`).join('');

  $('rej-page-info').textContent = total > REJ_PAGE_SIZE ? `${start + 1}–${end} of ${total}` : `${total} total`;
  $('rej-prev').disabled = _rejPage === 0;
  $('rej-next').disabled = _rejPage >= pages - 1;
}

async function clearBetHistory() {
  if (!confirm('Delete all bet history from the database? This cannot be undone.')) return;
  try {
    const r = await fetch('/api/db/bets', { method: 'DELETE' });
    if (!r.ok) throw new Error(await r.text());
    S.bets = [];
    S.performance = [];
    await loadBets();
    if ($('tab-analysis').classList.contains('active')) loadAnalysis();
  } catch (e) {
    alert('Failed to clear history: ' + e.message);
  }
}

function initBetsTab() {
  // Period requires a full server fetch (date window).
  // Strategy filter is multi-select widget — handled via _initStratFilterWiring.
  $('bets-period').addEventListener('change', loadBets);
  // Status + SQ + edge + momentum filters are pure client-side. Re-apply over cached rows.
  $('bets-status').addEventListener('change', () => { _betsPage = 0; _applyBetsFilters(); });
  $('bets-sq-set')?.addEventListener('change', () => { _betsPage = 0; _applyBetsFilters(); });
  ['bets-edge-min','bets-edge-max','bets-mom-min','bets-mom-max'].forEach(id => {
    $(id)?.addEventListener('input', () => { _betsPage = 0; _applyBetsFilters(); });
  });
  $('bets-refresh').addEventListener('click', loadBets);

  // Click-sort on any header that declares data-col.  Numeric + null-safe.
  document.querySelectorAll('#bets-table thead th[data-col]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      _sortBets = _sortBets.col === col
        ? { col, dir: -_sortBets.dir }
        : { col, dir: -1 };
      _betsPage = 0;
      renderBetsTable(S.bets || []);
    });
  });
  $('bets-clear').addEventListener('click', clearBetHistory);

  $('bets-export').addEventListener('click', () => {
    // Verbose export — every bet field + the joined market metadata (surface,
    // tournament, latest sets) the bets endpoint already returns.
    const rawServeCols = [];
    for (const tag of ['s1','s2','s3','match']) {
      for (const side of ['a','b']) {
        for (const m of ['firstServeIn','firstServeWon','secondServeWon','aces','doubleFaults','breakpointsWon','breakpointsCreated']) {
          rawServeCols.push(`serve_${tag}_${side}_${m}`);
        }
      }
    }
    const headers = [
      'bet_id','match_name','surface','tournament',
      'strategy_name','sub_strategy','player_key','player_name','side',
      'requested_odds','actual_odds','stake','size_matched','liability',
      'pnl','roi_pct','momentum_at_bet','edge_at_bet',
      'surface_wr_diff','surface_p1_wins','surface_p1_total','surface_p2_wins','surface_p2_total',
      'vol_pre_match','vol_set1_end','vol_set2_end',
      'settlement_type','dry_run','exit_config','hedge_odds',
      'betfair_market_id','placed_at','settled_at','reason','latest_sets',
      'serve_quality_s1_a','serve_quality_s1_b','serve_quality_diff_s1',
      'serve_quality_s2_a','serve_quality_s2_b','serve_quality_diff_s2',
      'serve_quality_s3_a','serve_quality_s3_b','serve_quality_diff_s3',
      'serve_quality_match_a','serve_quality_match_b','serve_quality_diff_match',
      'bet_player_serve_quality_trigger','opp_serve_quality_trigger',
      'bet_player_serve_quality_diff_trigger',
      // Per-set bet-player SQ Δ (consistent sign perspective so swings A→B are obvious)
      'bet_player_serve_quality_diff_s1',
      'bet_player_serve_quality_diff_s2',
      'bet_player_serve_quality_diff_match',
      ...rawServeCols,
    ];
    // Friendly header labels — every internal field gets a verbose, human
    // readable name in the exported CSV (helps when opening in Excel without
    // needing to consult a schema doc).
    const HEADER_LABELS = {
      bet_id: 'Bet ID',
      match_name: 'Match',
      surface: 'Surface',
      tournament: 'Tournament',
      strategy_name: 'Strategy',
      player_key: 'Player Key (A/B)',
      player_name: 'Bet Player Name',
      side: 'Bet Side (back/lay)',
      requested_odds: 'Requested Odds',
      actual_odds: 'Actual Matched Odds',
      stake: 'Stake (£)',
      size_matched: 'Size Matched (£)',
      liability: 'Liability (£)',
      pnl: 'Profit/Loss (£)',
      settlement_type: 'Settlement Type',
      dry_run: 'Dry Run? (1/0)',
      exit_config: 'Exit Config',
      hedge_odds: 'Hedge Odds',
      betfair_market_id: 'Betfair Market ID',
      placed_at: 'Placed At (UTC)',
      settled_at: 'Settled At (UTC)',
      reason: 'Reason / Note',
      latest_sets: 'Latest Set Scores',
      serve_quality_s1_a: 'Serve Quality Set 1 — Player A (0–100)',
      serve_quality_s1_b: 'Serve Quality Set 1 — Player B (0–100)',
      serve_quality_diff_s1: 'Serve Quality Δ Set 1 (A − B)',
      serve_quality_s2_a: 'Serve Quality Set 2 — Player A (0–100)',
      serve_quality_s2_b: 'Serve Quality Set 2 — Player B (0–100)',
      serve_quality_diff_s2: 'Serve Quality Δ Set 2 (A − B)',
      serve_quality_s3_a: 'Serve Quality Set 3 — Player A (0–100)',
      serve_quality_s3_b: 'Serve Quality Set 3 — Player B (0–100)',
      serve_quality_diff_s3: 'Serve Quality Δ Set 3 (A − B)',
      serve_quality_match_a: 'Serve Quality Match — Player A (0–100)',
      serve_quality_match_b: 'Serve Quality Match — Player B (0–100)',
      serve_quality_diff_match: 'Serve Quality Δ Match (A − B)',
      bet_player_serve_quality_trigger: 'Bet Player Serve Quality at Trigger',
      opp_serve_quality_trigger: 'Opponent Serve Quality at Trigger',
      bet_player_serve_quality_diff_trigger: 'Bet Player − Opponent SQ at Trigger',
      bet_player_serve_quality_diff_s1: 'Bet Player − Opp SQ Δ Set 1',
      bet_player_serve_quality_diff_s2: 'Bet Player − Opp SQ Δ Set 2',
      bet_player_serve_quality_diff_match: 'Bet Player − Opp SQ Δ Match',
      sub_strategy:        'Sub-Strategy (StratX-P1 / StratX-P2)',
      momentum_at_bet:     'Momentum Index at Bet (range −1 to +1, positive = bet player gaining momentum)',
      edge_at_bet:         'Edge at Bet (signed; bot model probability − implied market probability; positive = +EV per model)',
      roi_pct:             'ROI % (PnL ÷ Stake × 100)',
      surface_wr_diff:     'Surface Win-Rate Difference (P1 − P2) on this surface, pp (positive = P1 wins more often)',
      surface_p1_wins:     'P1 Wins on this surface (count, from our DB excluding current match)',
      surface_p1_total:    'P1 Total matches on this surface (count)',
      surface_p2_wins:     'P2 Wins on this surface (count)',
      surface_p2_total:    'P2 Total matches on this surface (count)',
      vol_pre_match:       'Matched Volume at Pre-Match (£)',
      vol_set1_end:        'Matched Volume at End of Set 1 (£)',
      vol_set2_end:        'Matched Volume at End of Set 2 (£)',
    };
    // Translate the raw per-set serve columns (serve_s1_a_firstServeIn etc.)
    // into human labels via lookup tables.
    const SET_LABEL = { s1: 'Set 1', s2: 'Set 2', s3: 'Set 3', match: 'Match' };
    const METRIC_LABEL = {
      firstServeIn:        '1st Serve In %',
      firstServeWon:       '1st Serve Won %',
      secondServeWon:      '2nd Serve Won %',
      aces:                'Aces',
      doubleFaults:        'Double Faults',
      breakpointsWon:      'Break Points Won',
      breakpointsCreated:  'Break Points Created',
    };
    const friendlyHeader = h => {
      if (HEADER_LABELS[h]) return HEADER_LABELS[h];
      // Raw serve cols come in as `serve_<set>_<side>_<metric>`.
      const m = /^serve_(s1|s2|s3|match)_(a|b)_(.+)$/.exec(h);
      if (m) {
        const setLbl   = SET_LABEL[m[1]];
        const sideLbl  = m[2] === 'a' ? 'Player A' : 'Player B';
        const metLbl   = METRIC_LABEL[m[3]] || m[3];
        return `${setLbl} ${sideLbl} ${metLbl}`;
      }
      return h;
    };
    const esc = v => {
      if (v == null) return '';
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = [headers.map(h => esc(friendlyHeader(h))).join(','), ...S.bets.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
    _downloadCsv(`bets-${new Date().toISOString().slice(0,10)}.csv`, csv);
  });
}

// ── BETS (FILTERED) TAB — Filter Lab ──────────────────────────────────────────
// Retrospective A/B comparison: take historical bets, apply a filter pipeline,
// and compare the resulting subset's PnL / ROI / win-rate against the unfiltered
// baseline. Filter state persists in localStorage so it survives reloads, and
// presets can be saved & re-loaded for repeatable A/B tests.

const _BF_LS_KEY    = 'bf.filters.v1';
const _BF_PRESETS_KEY = 'bf.presets.v1';
let   _bfSelectedStrats = new Set();
let   _bfData = [];            // fetched bets for current period
let   _bfBaseStats = null;     // baseline stats (period-restricted but no filter)

function _bfReadFilters() {
  try { return JSON.parse(localStorage.getItem(_BF_LS_KEY) || '{}'); } catch (_) { return {}; }
}
function _bfWriteFilters(f) {
  try { localStorage.setItem(_BF_LS_KEY, JSON.stringify(f)); } catch (_) {}
}
function _bfReadPresets() {
  try { return JSON.parse(localStorage.getItem(_BF_PRESETS_KEY) || '{}'); } catch (_) { return {}; }
}
function _bfWritePresets(p) {
  try { localStorage.setItem(_BF_PRESETS_KEY, JSON.stringify(p)); } catch (_) {}
}

function _bfCurrentFilters() {
  const num = id => { const v = $(id).value; return v === '' ? null : +v; };
  const surfaces = Array.from(document.querySelectorAll('.bf-surface'))
                        .filter(c => c.checked).map(c => c.value);
  return {
    period:     $('bf-period').value,
    strategies: [..._bfSelectedStrats],
    side:       $('bf-side').value,
    playerKey:  $('bf-player-key').value,
    oddsMin:    num('bf-odds-min'),  oddsMax:  num('bf-odds-max'),
    edgeMin:    num('bf-edge-min'),  edgeMax:  num('bf-edge-max'),
    momMin:     num('bf-mom-min'),   momMax:   num('bf-mom-max'),
    sq1Min:     num('bf-sq1-min'),   sq1Max:   num('bf-sq1-max'),
    sq2Min:     num('bf-sq2-min'),   sq2Max:   num('bf-sq2-max'),
    sq12Min:    num('bf-sq12-min'),  sq12Max:  num('bf-sq12-max'),
    sqtMin:     num('bf-sqt-min'),   sqtMax:   num('bf-sqt-max'),
    surfaces,
    tournament: $('bf-tournament').value.trim().toLowerCase(),
    mode:       $('bf-mode').value,
    status:     $('bf-status').value,
  };
}

function _bfRestoreFilters(f) {
  if (!f) return;
  const set = (id, v) => { if (v != null) $(id).value = v; };
  set('bf-period',      f.period);
  set('bf-side',        f.side);
  set('bf-player-key',  f.playerKey);
  set('bf-odds-min',    f.oddsMin); set('bf-odds-max', f.oddsMax);
  set('bf-edge-min',    f.edgeMin); set('bf-edge-max', f.edgeMax);
  set('bf-mom-min',     f.momMin);  set('bf-mom-max',  f.momMax);
  set('bf-sq1-min',     f.sq1Min);  set('bf-sq1-max',  f.sq1Max);
  set('bf-sq2-min',     f.sq2Min);  set('bf-sq2-max',  f.sq2Max);
  set('bf-sq12-min',    f.sq12Min); set('bf-sq12-max', f.sq12Max);
  set('bf-sqt-min',     f.sqtMin);  set('bf-sqt-max',  f.sqtMax);
  set('bf-tournament',  f.tournament);
  set('bf-mode',        f.mode);
  set('bf-status',      f.status);
  if (Array.isArray(f.surfaces)) {
    document.querySelectorAll('.bf-surface').forEach(c => { c.checked = f.surfaces.includes(c.value); });
  }
  _bfSelectedStrats = new Set(f.strategies || []);
}

function _bfApplyFilter(bets, f) {
  const within = (v, lo, hi) => (v == null ? false : ((lo == null || v >= lo) && (hi == null || v <= hi)));
  return bets.filter(b => {
    if (f.strategies?.length && !f.strategies.includes(b.strategy_name)) return false;
    if (f.side && b.side !== f.side) return false;
    if (f.playerKey && b.player_key !== f.playerKey) return false;
    if (f.surfaces?.length && b.surface && !f.surfaces.includes(b.surface)) return false;
    if (f.tournament && !(b.tournament || '').toLowerCase().includes(f.tournament)) return false;
    if (f.mode === 'live' && b.dry_run) return false;
    if (f.mode === 'dry'  && !b.dry_run) return false;
    if (f.status === 'settled' && b.settled_at == null) return false;
    if (f.status === 'open'    && b.settled_at != null) return false;
    if (f.status === 'win'     && !(b.pnl != null && b.pnl >  0)) return false;
    if (f.status === 'loss'    && !(b.pnl != null && b.pnl <= 0)) return false;
    const odds = b.requested_odds ?? b.actual_odds;
    if ((f.oddsMin != null || f.oddsMax != null) && !within(odds, f.oddsMin, f.oddsMax)) return false;
    if ((f.edgeMin != null || f.edgeMax != null) && !within(b.edge_at_bet, f.edgeMin, f.edgeMax)) return false;
    if ((f.momMin  != null || f.momMax  != null) && !within(b.momentum_at_bet, f.momMin, f.momMax)) return false;
    if ((f.sq1Min  != null || f.sq1Max  != null) && !within(b.bet_player_serve_quality_diff_s1, f.sq1Min, f.sq1Max)) return false;
    if ((f.sq2Min  != null || f.sq2Max  != null) && !within(b.bet_player_serve_quality_diff_s2, f.sq2Min, f.sq2Max)) return false;
    if ((f.sqtMin  != null || f.sqtMax  != null) && !within(b.bet_player_serve_quality_diff_trigger, f.sqtMin, f.sqtMax)) return false;
    if (f.sq12Min != null || f.sq12Max != null) {
      const s1 = b.bet_player_serve_quality_diff_s1;
      const s2 = b.bet_player_serve_quality_diff_s2;
      if (s1 == null || s2 == null) return false;
      if (!within(s2 - s1, f.sq12Min, f.sq12Max)) return false;
    }
    return true;
  });
}

function _bfComputeStats(bets) {
  const settled = bets.filter(b => b.pnl != null);
  const wins    = settled.filter(b => b.pnl > 0).length;
  const pnl     = settled.reduce((s,b) => s + b.pnl, 0);
  const stake   = settled.reduce((s,b) => s + (b.stake || 0), 0);
  return {
    bets:    bets.length,
    settled: settled.length,
    wins,
    winRate: settled.length ? +(wins / settled.length * 100).toFixed(1) : null,
    pnl:     +pnl.toFixed(2),
    // ROI = PnL ÷ Stake (industry standard yield on turnover)
    roi:     stake > 0 ? +(pnl / stake * 100).toFixed(2) : null,
    avgOdds: bets.length ? +(bets.reduce((s,b) => s + (b.requested_odds || 0), 0) / bets.length).toFixed(2) : null,
  };
}

function _bfRenderStats(elId, s, compare) {
  if (!s) { $(elId).innerHTML = ''; return; }
  const cell = (label, val, cmp) => {
    const delta = (cmp != null && val != null && typeof val === 'number' && typeof cmp === 'number')
      ? (val - cmp) : null;
    const deltaStr = delta == null ? ''
      : ` <span style="font-size:11px;color:${delta >= 0 ? 'var(--green)' : 'var(--red)'}">(${delta >= 0 ? '+' : ''}${delta.toFixed(2)})</span>`;
    return `<div class="stat-box"><div class="val">${val == null ? '—' : val}</div><div class="lbl">${label}${deltaStr}</div></div>`;
  };
  $(elId).innerHTML =
    cell('Bets',    s.bets,    compare?.bets) +
    cell('Settled', s.settled, compare?.settled) +
    cell('Win Rate %', s.winRate, compare?.winRate) +
    cell('PnL £',   s.pnl,     compare?.pnl) +
    cell('ROI %',   s.roi,     compare?.roi) +
    cell('Avg Odds', s.avgOdds, compare?.avgOdds);
}

const _BF_PAGE_SIZE = 25;
let   _bfPage    = 0;
let   _bfLastRows = [];

function _bfRenderTable(rows) {
  const tbody = $('bf-bets-tbody');
  _bfLastRows  = rows;
  const total  = rows.length;
  const pages  = Math.max(1, Math.ceil(total / _BF_PAGE_SIZE));
  if (_bfPage >= pages) _bfPage = pages - 1;
  if (_bfPage < 0)      _bfPage = 0;
  const start  = _bfPage * _BF_PAGE_SIZE;
  const slice  = rows.slice(start, start + _BF_PAGE_SIZE);

  $('bf-rows-info').textContent = total
    ? `${start + 1}–${start + slice.length} of ${total}`
    : '0 bets';

  if (!total) { tbody.innerHTML = '<tr><td colspan="17" class="empty">No bets match these filters</td></tr>'; _bfRenderPagination(0, 1); return; }

  const fmtMom  = v => v == null ? '—' : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${(+v).toFixed(2)}</span>`;
  const fmtEdge = v => v == null ? '—' : `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${(+v).toFixed(2)} pp</span>`;
  tbody.innerHTML = slice.map(r => {
    const sqDelta = (r.bet_player_serve_quality_diff_s2 != null && r.bet_player_serve_quality_diff_s1 != null)
      ? r.bet_player_serve_quality_diff_s2 - r.bet_player_serve_quality_diff_s1 : null;
    const status = r.settlement_type ? badge(r.settlement_type, r.pnl >= 0 ? 'green' : 'red')
                                     : badge('Open', 'yellow');
    return `<tr>
      <td class="wrap"><strong>${r.match_name || '—'}</strong></td>
      <td class="score">${(() => { try { return r.latest_sets ? score(JSON.parse(r.latest_sets)) : '—'; } catch (_) { return '—'; } })()}</td>
      <td>${_stratChip(r.strategy_name)}</td>
      <td>${r.player_name || '—'}</td>
      <td>${r.side || '—'}</td>
      <td>${fmt.odds(r.requested_odds)}</td>
      <td>£${r.stake != null ? r.stake.toFixed(2) : '—'}</td>
      <td>${r.liability != null ? '£' + (+r.liability).toFixed(2) : '—'}</td>
      <td>${r.pnl != null ? `<span class="${pnlClass(r.pnl)}">${fmt.pnl(r.pnl)}</span>` : '—'}</td>
      <td>${fmtMom(r.momentum_at_bet)}</td>
      <td>${fmtEdge(r.edge_at_bet)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_s1)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_s2)}</td>
      <td>${_sqDiffCell(sqDelta)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_trigger)}</td>
      <td>${status}</td>
      <td>${fmt.date(r.placed_at)} ${fmt.ts(r.placed_at)}</td>
    </tr>`;
  }).join('');
  _bfRenderPagination(total, pages);
}

function _bfRenderPagination(total, pages) {
  let bar = document.getElementById('bf-pagination');
  if (!bar) {
    // Create a pagination bar under the table once
    const card = document.querySelector('#tab-bets-filtered .card:last-of-type');
    if (!card) return;
    bar = document.createElement('div');
    bar.id = 'bf-pagination';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--muted);justify-content:center;flex-wrap:wrap';
    card.appendChild(bar);
  }
  if (total === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  bar.innerHTML = `
    <button class="btn btn-sm" id="bf-pg-first"  ${_bfPage === 0 ? 'disabled' : ''}>«</button>
    <button class="btn btn-sm" id="bf-pg-prev"   ${_bfPage === 0 ? 'disabled' : ''}>‹ Prev</button>
    <span>Page ${_bfPage + 1} / ${pages} · ${total} bet${total === 1 ? '' : 's'}</span>
    <button class="btn btn-sm" id="bf-pg-next"   ${_bfPage >= pages - 1 ? 'disabled' : ''}>Next ›</button>
    <button class="btn btn-sm" id="bf-pg-last"   ${_bfPage >= pages - 1 ? 'disabled' : ''}>»</button>
  `;
  const re = () => _bfRenderTable(_bfLastRows);
  document.getElementById('bf-pg-first').onclick = () => { _bfPage = 0;            re(); };
  document.getElementById('bf-pg-prev').onclick  = () => { _bfPage--;              re(); };
  document.getElementById('bf-pg-next').onclick  = () => { _bfPage++;              re(); };
  document.getElementById('bf-pg-last').onclick  = () => { _bfPage = pages - 1;    re(); };
}

function _bfRefreshStratChecks() {
  const panel = $('bf-strat-checks');
  if (!panel) return;
  const names = _allStrategiesForFilter(S.performance);
  panel.innerHTML = names.map(n => `<label style="display:flex;align-items:center;gap:6px;padding:2px 4px" title="${_stratTooltipText(n)}">
    <input type="checkbox" class="bf-strat-check" data-strat="${n}" ${_bfSelectedStrats.has(n) ? 'checked' : ''}> ${n}
  </label>`).join('') || '<div style="color:var(--muted);font-size:11px">No strategies known yet</div>';
  panel.querySelectorAll('.bf-strat-check').forEach(cb => {
    cb.addEventListener('change', e => {
      const n = e.target.dataset.strat;
      if (e.target.checked) _bfSelectedStrats.add(n); else _bfSelectedStrats.delete(n);
      _bfUpdateStratBtnLabel();
    });
  });
  _bfUpdateStratBtnLabel();
}
function _bfUpdateStratBtnLabel() {
  const btn = $('bf-strat-btn');
  if (!btn) return;
  btn.textContent = _bfSelectedStrats.size === 0 ? 'All strategies ▾' : `Strategies: ${_bfSelectedStrats.size} ▾`;
}

function _bfRefreshPresetDropdown() {
  const sel = $('bf-presets');
  if (!sel) return;
  const presets = _bfReadPresets();
  sel.innerHTML = '<option value="">— Load preset… —</option>' +
    Object.keys(presets).sort().map(n => `<option value="${n}">${n}</option>`).join('');
}

function bfApplyAndRender() {
  const f = _bfCurrentFilters();
  _bfWriteFilters(f);
  const filtered = _bfApplyFilter(_bfData, f);
  const filtStats = _bfComputeStats(filtered);
  _bfRenderStats('bf-stats-base', _bfBaseStats, null);
  _bfRenderStats('bf-stats-filt', filtStats, _bfBaseStats);
  _bfPage = 0;  // reset to first page on filter change
  _bfRenderTable(filtered);
  $('bf-filt-count').textContent = `${filtered.length} of ${_bfData.length} bets pass`;
}

async function loadFilteredBets() {
  // Restore filters from localStorage on first open (idempotent)
  if (!window._bfInited) {
    _bfRestoreFilters(_bfReadFilters());
    // Wire panel toggle for strategy multi
    $('bf-strat-btn').addEventListener('click', e => {
      e.stopPropagation();
      const p = $('bf-strat-panel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', e => {
      const p = $('bf-strat-panel');
      if (p && !p.contains(e.target) && e.target !== $('bf-strat-btn')) p.style.display = 'none';
    });
    $('bf-strat-all').addEventListener('click', () => {
      _allStrategiesForFilter(S.performance).forEach(n => _bfSelectedStrats.add(n));
      _bfRefreshStratChecks();
    });
    $('bf-strat-none').addEventListener('click', () => {
      _bfSelectedStrats.clear();
      _bfRefreshStratChecks();
    });
    $('bf-apply').addEventListener('click', bfApplyAndRender);
    $('bf-reset').addEventListener('click', () => {
      _bfRestoreFilters({});
      _bfSelectedStrats = new Set();
      document.querySelectorAll('.bf-surface').forEach(c => c.checked = true);
      _bfRefreshStratChecks();
      bfApplyAndRender();
    });
    $('bf-save').addEventListener('click', () => {
      const name = prompt('Preset name:'); if (!name) return;
      const presets = _bfReadPresets();
      presets[name] = _bfCurrentFilters();
      _bfWritePresets(presets);
      _bfRefreshPresetDropdown();
      $('bf-presets').value = name;
    });
    $('bf-presets').addEventListener('change', e => {
      const presets = _bfReadPresets();
      const f = presets[e.target.value];
      if (!f) return;
      _bfRestoreFilters(f);
      _bfRefreshStratChecks();
      $('bf-delete-preset').style.display = '';
      bfApplyAndRender();
    });
    $('bf-delete-preset').addEventListener('click', () => {
      const name = $('bf-presets').value;
      if (!name) return;
      if (!confirm(`Delete preset "${name}"?`)) return;
      const presets = _bfReadPresets(); delete presets[name]; _bfWritePresets(presets);
      _bfRefreshPresetDropdown();
      $('bf-delete-preset').style.display = 'none';
    });
    $('bf-period').addEventListener('change', loadFilteredBets);
    $('bf-export').addEventListener('click', () => {
      const filtered = _bfApplyFilter(_bfData, _bfCurrentFilters());
      const headers = ['bet_id','strategy_name','sub_strategy','match_name','surface','tournament','player_key','player_name','side','requested_odds','stake','liability','pnl','momentum_at_bet','edge_at_bet','bet_player_serve_quality_diff_s1','bet_player_serve_quality_diff_s2','bet_player_serve_quality_diff_trigger','dry_run','placed_at','settled_at'];
      const esc = v => v == null ? '' : (/[,"\n]/.test(String(v)) ? '"' + String(v).replace(/"/g,'""') + '"' : v);
      const csv = [headers.join(','), ...filtered.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
      _downloadCsv(`bets-filtered-${new Date().toISOString().slice(0,10)}.csv`, csv);
    });
    window._bfInited = true;
  }

  // Pull period-restricted bets from the server (uses same endpoint as Bets tab)
  const since = $('bf-period').value || '-7 days';
  $('bf-bets-tbody').innerHTML = '<tr><td colspan="17" class="empty"><span class="spinner"></span> Loading…</td></tr>';
  try {
    const data = await api(`/api/db/bets?since=${encodeURIComponent(since)}&limit=2000`);
    _bfData      = data.bets || [];
    _bfBaseStats = _bfComputeStats(_bfData);
    $('bf-base-period').textContent = `${_bfData.length} bets, period ${since}`;
    _bfRefreshStratChecks();
    _bfRefreshPresetDropdown();
    bfApplyAndRender();
  } catch (e) {
    $('bf-bets-tbody').innerHTML = `<tr><td colspan="17" class="empty">Error: ${e.message}</td></tr>`;
  }
}

// ── STRATEGIES TAB ────────────────────────────────────────────────────────────
let _fullStrategyConfig = {};
let _saveTimer          = null;

// Strategy-description lookup populated on dashboard load. Used by the
// `_stratTooltipText` helper to render hover tooltips on strategy chips
// across every tab (bets, live, scanner, upcoming, AI).
window._stratDefs = window._stratDefs || {};

/**
 * Bootstrap once on dashboard load — pulls /api/strategies and indexes each
 * system by name so any cell that renders a strategy tag can show its full
 * definition on hover. Race condition: tabs that render before this fetch
 * completes show empty title="" → no tooltip. So when defs arrive we
 * re-render any currently-rendered table that has strategy chips.
 */
window._stratDefsLoaded = false;
async function _bootstrapStratDefs() {
  try {
    const r = await fetch('/api/config/strategies', { credentials: 'same-origin' });
    if (!r.ok) return;
    const cfg = await r.json();
    for (const s of (cfg.systems || [])) {
      if (s && s.name) window._stratDefs[s.name] = s.description || '';
    }
    window._stratDefsLoaded = true;
    // If any visible table already rendered without tooltips, refresh it.
    if (Array.isArray(S?.bets) && S.bets.length) {
      try { renderBetsTable(S.bets); } catch (_) {}
    }
    if (typeof renderLiveTable === 'function') {
      try { renderLiveTable(); } catch (_) {}
    }
  } catch (_) {}
}
_bootstrapStratDefs();

/** Returns the human-readable description for `stratName` (best effort).
 *  Falls back to the strategy name itself so the browser always renders a
 *  tooltip on hover (empty title="" means no tooltip in every browser). */
function _stratTooltipText(stratName) {
  if (!stratName || stratName === '—') return '';
  const desc = window._stratDefs[stratName];
  const text = desc && desc.trim() ? desc : `${stratName} (definition not yet loaded — refresh page)`;
  return text.replace(/"/g, '&quot;');
}

/** Wrap a strategy name in a span with hover tooltip. Use anywhere strategy
 *  text appears as a plain td/inline node (badges have their own helper). */
function _stratChip(stratName) {
  if (!stratName || stratName === '—') return '—';
  return `<span class="strategy-tag" style="cursor:help;border-bottom:1px dotted var(--muted)" title="${_stratTooltipText(stratName)}">${stratName}</span>`;
}

const _stratCollapsed = new Set(
  JSON.parse(localStorage.getItem('stratCollapsed') || '[]')
);
function toggleStratCollapse(evt, idx) {
  if (evt.target.closest('input, select, button:not(.strat-collapse-btn)')) return;
  const card = $('strat-card-' + idx);
  if (!card) return;
  if (_stratCollapsed.has(idx)) {
    _stratCollapsed.delete(idx);
    card.classList.remove('collapsed');
  } else {
    _stratCollapsed.add(idx);
    card.classList.add('collapsed');
  }
  localStorage.setItem('stratCollapsed', JSON.stringify([..._stratCollapsed]));
}

async function loadStrategies() {
  try {
    const [cfg, perf] = await Promise.all([
      api('/api/config/strategies'),
      api('/api/db/bets/performance'),
    ]);

    _fullStrategyConfig = cfg;
    S.strategies  = cfg.systems || [];
    S.performance = perf;

    // Keep _stratDefs in sync with the Strategies tab — if a user edits a
    // description here, the bets-tab tooltip picks it up immediately.
    for (const s of (cfg.systems || [])) {
      if (s && s.name) window._stratDefs[s.name] = s.description || '';
    }
    window._stratDefsLoaded = true;

    renderStrategyForms(cfg, perf);

    // Populate live-strategy single-select with union of configured + bet-emitting strategies.
    // (bets-strategy is now a multi-select widget, populated by _renderStratChecklist.)
    const liveSel = $('live-strategy');
    if (liveSel) {
      const existing = new Set(Array.from(liveSel.options).map(o => o.value));
      _allStrategiesForFilter(perf).forEach(n => {
        if (!existing.has(n)) liveSel.add(new Option(n, n));
      });
    }
  } catch (e) {
    $('strat-edit-container').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

function renderStrategyForms(cfg, perf) {
  const systems    = cfg.systems || [];
  const perfByName = {};
  for (const p of perf) perfByName[p.strategy_name] = p;

  $('strat-edit-container').innerHTML =
    `<div class="flex gap8 items-center" style="margin-bottom:12px">
       <button class="btn btn-sm btn-primary" onclick="addStrategy()">+ New Strategy</button>
     </div>
     <div class="strat-edit-grid">${
    systems.map((sys, i) => {
      const p   = perfByName[sys.name] || {};
      const pnl = p.total_pnl ?? null;
      const wr  = p.wins != null && p.total_bets ? (p.wins / p.total_bets * 100) : null;

      const trig  = sys.backtest?.trigger || {};
      const entry = sys.backtest?.entry   || {};
      const exit  = sys.exit              || {};

      let pmType  = 'winner';
      let pmRange = { min: '', max: '' };
      if      (trig.preMatchOddsWinner) { pmType = 'winner'; pmRange = trig.preMatchOddsWinner; }
      else if (trig.preMatchOddsLoser)  { pmType = 'loser';  pmRange = trig.preMatchOddsLoser; }
      else if (trig.preMatchOddsA)      { pmType = 'A';      pmRange = trig.preMatchOddsA; }
      else if (trig.preMatchOddsB)      { pmType = 'B';      pmRange = trig.preMatchOddsB; }

      const tbVal          = trig.isTiebreak === true ? 'true' : trig.isTiebreak === false ? 'false' : '';
      const allowedScores  = (trig.allowedSetScores || trig.allowedSet1Scores || []).join(', ');
      const loserMustBe    = trig.loserMustBe || '';
      const currentHedge   = (sys.exit?.type === 'none' || !sys.exit?.hedgeWhen) && sys.exit?.type !== 'set_result'
        ? 'none' : (sys.exit?.hedgeWhen || 'bet_player_loses_set');

      const descVal = (sys.description || '').replace(/"/g, '&quot;');
      const nameVal = (sys.name || '').replace(/"/g, '&quot;');
      const sel = (val, opt) => opt === val ? 'selected' : '';

      const collapsed = _stratCollapsed.has(i) ? 'collapsed' : '';
      // At-a-glance description shown next to the name in the tile header.
      // Stays visible when the tile is collapsed so you can scan the list
      // and read what each strategy does without expanding every card.
      const descPreview = (sys.description || '').replace(/"/g, '&quot;');
      return `<div class="strat-edit-card ${sys.enabled ? '' : 'strat-disabled'} ${collapsed}" id="strat-card-${i}">
        <div class="strat-edit-header" onclick="toggleStratCollapse(event,${i})">
          <button class="strat-collapse-btn" tabindex="-1">▾</button>
          <label class="toggle-switch" title="Enable / disable" onclick="event.stopPropagation()">
            <input type="checkbox" id="s${i}-enabled" ${sys.enabled ? 'checked' : ''} onchange="queueStratSave(${i})">
            <span class="toggle-track"></span>
          </label>
          <div style="display:flex;flex-direction:column;gap:2px;flex:1;min-width:0">
            <input type="text" class="strat-name-input" id="s${i}-name" value="${nameVal}" placeholder="Strategy name" oninput="queueStratSave(${i})" onclick="event.stopPropagation()">
            <div class="strat-desc-preview" id="s${i}-desc-preview"
                 title="${descPreview}"
                 style="font-size:11px;color:var(--muted);line-height:1.35;white-space:normal;word-break:break-word;padding-left:2px">
              ${descPreview || '<span style="opacity:.5">(no description — click to expand and add one)</span>'}
            </div>
          </div>
          <div class="strat-perf-pills">
            <span class="strat-perf-pill">${p.total_bets ?? 0} bets</span>
            <span class="strat-perf-pill ${pnlClass(pnl)}">${pnl != null ? fmt.pnl(pnl) : '£—'}</span>
            ${wr != null ? `<span class="strat-perf-pill">${fmt.pct(wr)} WR</span>` : ''}
          </div>
          <button class="btn btn-sm" style="padding:2px 7px;font-size:12px;flex-shrink:0" onclick="event.stopPropagation();duplicateStrategy(${i})" title="Duplicate strategy">⧉</button>
          <button class="btn btn-sm btn-danger" style="padding:2px 7px;font-size:12px;flex-shrink:0" onclick="event.stopPropagation();deleteStrategy(${i})" title="Delete strategy">✕</button>
        </div>
        <div class="strat-edit-body">
          <div class="edit-field" style="grid-column:1/-1">
            <label>Description</label>
            <input type="text" id="s${i}-desc" value="${descVal}" oninput="queueStratSave(${i})">
          </div>
          <div class="edit-field">
            <label>Stake (£)</label>
            <input type="number" id="s${i}-stake" value="${sys.staking?.stakeGBP ?? 2}" min="0.5" step="0.5" oninput="queueStratSave(${i})">
          </div>
          <div class="edit-field">
            <label>Trigger after set #</label>
            <select id="s${i}-trigger-set" onchange="queueStratSave(${i})">
              ${[1,2,3].map(n => `<option value="${n}" ${trig.setNumber===n?'selected':''}>${n}</option>`).join('')}
            </select>
          </div>
          <div class="edit-field">
            <label>Pre-match odds of set</label>
            <select id="s${i}-pm-type" onchange="queueStratSave(${i})">
              <option value="winner" ${sel(pmType,'winner')}>Winner</option>
              <option value="loser"  ${sel(pmType,'loser')}>Loser</option>
            </select>
          </div>
          <div class="edit-field">
            <label>Pre-match odds range</label>
            <div class="odds-range">
              <input type="number" id="s${i}-pm-min" value="${pmRange.min ?? ''}" step="0.05" placeholder="e.g. 1.80" oninput="queueStratSave(${i})">
              <span>–</span>
              <input type="number" id="s${i}-pm-max" value="${pmRange.max ?? ''}" step="0.05" placeholder="e.g. 2.20" oninput="queueStratSave(${i})">
            </div>
          </div>
          <div class="edit-field">
            <label>Bet on set</label>
            <select id="s${i}-player" onchange="queueStratSave(${i})">
              <option value="winner" ${sel(entry.player,'winner')}>Winner</option>
              <option value="loser"  ${sel(entry.player,'loser')}>Loser</option>
            </select>
          </div>
          <div class="edit-field">
            <label>Entry side</label>
            <select id="s${i}-side" onchange="queueStratSave(${i})">
              <option value="BACK" ${sel(entry.side,'BACK')}>BACK</option>
              <option value="LAY"  ${sel(entry.side,'LAY')}>LAY</option>
            </select>
          </div>
          <div class="edit-field" style="grid-column:1/-1">
            <label>Entry odds range</label>
            <div class="odds-range">
              <input type="number" id="s${i}-min-odds" value="${entry.minOdds ?? ''}" step="0.05" placeholder="Min" oninput="queueStratSave(${i})">
              <span>–</span>
              <input type="number" id="s${i}-max-odds" value="${entry.maxOdds ?? ''}" step="0.05" placeholder="Max" oninput="queueStratSave(${i})">
            </div>
          </div>
          <div class="edit-field">
            <label>Exit after set #</label>
            <select id="s${i}-exit-set" onchange="queueStratSave(${i})">
              ${[1,2,3].map(n => `<option value="${n}" ${exit.setNumber===n?'selected':''}>${n}</option>`).join('')}
            </select>
          </div>
          <div class="edit-field">
            <label>Hedge / exit</label>
            <select id="s${i}-hedge-when" onchange="queueStratSave(${i})">
              <option value="none"                 ${sel(currentHedge,'none')}>No hedge — let bet run</option>
              <option value="bet_player_wins_set"  ${sel(currentHedge,'bet_player_wins_set')}>When bet player wins that set</option>
              <option value="bet_player_loses_set" ${sel(currentHedge,'bet_player_loses_set')}>When bet player loses that set</option>
            </select>
          </div>
          <div class="edit-field">
            <label>Set type</label>
            <select id="s${i}-tiebreak" onchange="queueStratSave(${i})">
              <option value=""     ${!tbVal         ?'selected':''}>Any (normal or tiebreak)</option>
              <option value="true" ${tbVal==='true'  ?'selected':''}>Tiebreak sets only</option>
              <option value="false"${tbVal==='false' ?'selected':''}>Normal sets only (no TB)</option>
            </select>
          </div>
          <div class="edit-field" style="grid-column:1/-1">
            <label>Allowed set scores (A-B format, comma-separated)</label>
            <input type="text" id="s${i}-allowed-scores" value="${allowedScores}" placeholder="e.g. 6-4, 7-5, 7-6 (blank = any score)" oninput="queueStratSave(${i})">
          </div>
          <div class="edit-field">
            <label>Set loser must be</label>
            <select id="s${i}-loser-must-be" onchange="queueStratSave(${i})">
              <option value=""  ${sel(loserMustBe,'')}>Either player</option>
              <option value="A" ${sel(loserMustBe,'A')}>P1 (A) must lose</option>
              <option value="B" ${sel(loserMustBe,'B')}>P2 (B) must lose</option>
            </select>
          </div>
          <div class="edit-field">
            <label>Min price change from pre-match %</label>
            <input type="number" id="s${i}-minchange" value="${trig.minChangePct ?? ''}" step="1" min="0" max="100" placeholder="e.g. 15 (optional)" oninput="queueStratSave(${i})">
          </div>
          <div class="edit-field">
            <label>Min matched volume (£)</label>
            <input type="number" id="s${i}-minvol" value="${sys.filters?.minMatchedVolume ?? ''}" step="1000" placeholder="e.g. 30000 (optional)" oninput="queueStratSave(${i})">
          </div>
          <div class="edit-field">
            <label>Min edge % to enter</label>
            <input type="number" id="s${i}-minedge" value="${sys.filters?.minEdgePercent ?? ''}" step="0.5" placeholder="e.g. 2.0 (optional)" oninput="queueStratSave(${i})">
          </div>
          <div class="edit-field">
            <label>Min |momentum| strength</label>
            <input type="number" id="s${i}-minmom" value="${sys.filters?.minAbsMomentum ?? ''}" step="5" min="0" max="100" placeholder="e.g. 20 (optional)" oninput="queueStratSave(${i})">
          </div>
          <div class="edit-field" style="grid-column:1/-1">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="s${i}-momfavours" ${sys.filters?.momentumFavoursBetPlayer ? 'checked' : ''} onchange="queueStratSave(${i})">
              Momentum must favour the bet player at entry
            </label>
          </div>
          <div style="grid-column:1/-1">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:8px 0 6px;border-top:1px solid var(--border)">Serve Stat Filters (optional — applies at trigger set)</div>
            <div class="serve-filter-grid">
              <div class="serve-filter-col">
                <div class="serve-filter-col-title">P1 (Player A)</div>
                ${['p1-1stin','p1-1stwon','p1-2ndwon','p1-aces','p1-dfs','p1-bpwon'].map((id, j) => {
                  const labels = ['1st serve in %','1st serve won %','2nd serve won %','Aces','Double faults','Break pts won'];
                  const minKeys = ['p1MinFirstServeIn','p1MinFirstServeWon','p1MinSecondServeWon','p1MinAces','p1MinDoubleFaults','p1MinBreakpointsWon'];
                  const maxKeys = ['p1MaxFirstServeIn','p1MaxFirstServeWon','p1MaxSecondServeWon','p1MaxAces','p1MaxDoubleFaults','p1MaxBreakpointsWon'];
                  return `<div style="margin-bottom:6px"><div style="font-size:10px;color:var(--muted);margin-bottom:2px">${labels[j]}</div>
                    <div class="serve-minmax">
                      <div><label>Min</label><input type="number" id="s${i}-${id}-min" value="${sys.filters?.[minKeys[j]] ?? ''}" step="${j<3?1:1}" placeholder="—" oninput="queueStratSave(${i})" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);font-size:11px"></div>
                      <div><label>Max</label><input type="number" id="s${i}-${id}-max" value="${sys.filters?.[maxKeys[j]] ?? ''}" step="${j<3?1:1}" placeholder="—" oninput="queueStratSave(${i})" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);font-size:11px"></div>
                    </div></div>`;
                }).join('')}
              </div>
              <div class="serve-filter-col">
                <div class="serve-filter-col-title">P2 (Player B)</div>
                ${['p2-1stin','p2-1stwon','p2-2ndwon','p2-aces','p2-dfs','p2-bpwon'].map((id, j) => {
                  const labels = ['1st serve in %','1st serve won %','2nd serve won %','Aces','Double faults','Break pts won'];
                  const minKeys = ['p2MinFirstServeIn','p2MinFirstServeWon','p2MinSecondServeWon','p2MinAces','p2MinDoubleFaults','p2MinBreakpointsWon'];
                  const maxKeys = ['p2MaxFirstServeIn','p2MaxFirstServeWon','p2MaxSecondServeWon','p2MaxAces','p2MaxDoubleFaults','p2MaxBreakpointsWon'];
                  return `<div style="margin-bottom:6px"><div style="font-size:10px;color:var(--muted);margin-bottom:2px">${labels[j]}</div>
                    <div class="serve-minmax">
                      <div><label>Min</label><input type="number" id="s${i}-${id}-min" value="${sys.filters?.[minKeys[j]] ?? ''}" step="1" placeholder="—" oninput="queueStratSave(${i})" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);font-size:11px"></div>
                      <div><label>Max</label><input type="number" id="s${i}-${id}-max" value="${sys.filters?.[maxKeys[j]] ?? ''}" step="1" placeholder="—" oninput="queueStratSave(${i})" style="width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);font-size:11px"></div>
                    </div></div>`;
                }).join('')}
              </div>
            </div>
          </div>

          <!-- 1st-serve-won differential filter (bet player minus opponent at trigger set) -->
          <div style="grid-column:1/-1;margin-top:10px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:8px 0 6px;border-top:1px solid var(--border)">
              1st-Serve-Won Differential (optional — bet player minus opponent at trigger set)
            </div>
            <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
              The 184-match study (10 May) showed first-serve-won % differential is the cleanest serve-quality signal.
              <strong style="color:var(--text)">20pp</strong> recommended for S1-entry strategies (Strat10),
              <strong style="color:var(--text)">10pp</strong> for S2-entry (Strat11).
              Leave blank to disable.
            </div>
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;max-width:520px">
              <div class="edit-field">
                <label>Min diff (pp)</label>
                <input type="number" id="s${i}-fswon-diff" value="${sys.filters?.minFirstServeWonDiff ?? ''}"
                  step="5" min="-100" max="100" placeholder="e.g. 20"
                  oninput="queueStratSave(${i})">
              </div>
              <div class="edit-field">
                <label>Max diff (pp)</label>
                <input type="number" id="s${i}-fswon-diff-max" value="${sys.filters?.maxFirstServeWonDiff ?? ''}"
                  step="5" min="-100" max="100" placeholder="e.g. 40 (cap extremes)"
                  oninput="queueStratSave(${i})">
              </div>
            </div>
            <div style="font-size:11px;color:var(--muted);margin-top:6px">
              Bet player's 1st-serve-won % minus opponent's at the trigger set must sit between Min and Max. Leave either blank for one-sided.
            </div>
          </div>

          <!-- Serve Quality Score Filter -->
          <div style="grid-column:1/-1;margin-top:10px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:8px 0 6px;border-top:1px solid var(--border)">
              Serve Quality Score Filter (optional — composite 0–100 score from set serve stats)
            </div>
            <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
              Scores each player's set serve stats: 1st serve in/won, 2nd serve won, aces, double faults.
              Pass=20pts each, Warn=10pts, Fail=0pts → max 100.
              <strong style="color:var(--text)">Differential</strong> = loser−winner score (positive = underdog outserved the favourite ⇒ market overreaction).
              Set both Min and Max to constrain the band, or leave either blank for one-sided.
            </div>
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;max-width:520px">
              <div class="edit-field">
                <label>Min differential (loser−winner)</label>
                <input type="number" id="s${i}-sqf-diff" value="${sys.backtest?.serveQualityFilter?.minDifferential ?? ''}"
                  step="5" min="-100" max="100" placeholder="e.g. 0 (underdog ≥ fav)"
                  oninput="queueStratSave(${i})">
              </div>
              <div class="edit-field">
                <label>Max differential (loser−winner)</label>
                <input type="number" id="s${i}-sqf-diff-max" value="${sys.backtest?.serveQualityFilter?.maxDifferential ?? ''}"
                  step="5" min="-100" max="100" placeholder="e.g. 40 (cap extremes)"
                  oninput="queueStratSave(${i})">
              </div>
            </div>
          </div>

        </div>
      </div>`;
    }).join('')
  }</div>`;
}

function queueStratSave(idx) {
  // Reflect enabled toggle on the card immediately
  if (idx != null) {
    const card = document.getElementById(`strat-card-${idx}`);
    if (card) {
      const enabled = document.getElementById(`s${idx}-enabled`)?.checked;
      card.classList.toggle('strat-disabled', !enabled);
    }
    // Keep the header description preview in sync with the body Description input
    // so the tile shows the latest text without waiting for the save round-trip.
    const descInput   = document.getElementById(`s${idx}-desc`);
    const descPreview = document.getElementById(`s${idx}-desc-preview`);
    if (descInput && descPreview) {
      const v = descInput.value || '';
      descPreview.textContent = v || '(no description — click to expand and add one)';
      descPreview.setAttribute('title', v);
    }
  }
  const statusEl = $('strat-save-status');
  if (statusEl) { statusEl.textContent = 'Unsaved…'; statusEl.className = 'strat-save-status saving'; }
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveStrategiesFromForm, 1200);
}

function _collectStrategyForms() {
  return (S.strategies || []).map((sys, i) => {
    const g   = id => document.getElementById(`s${i}-${id}`);
    const gv  = id => g(id)?.value;
    const gn  = (id, fb) => parseFloat(gv(id)) || fb;
    const gni = (id, fb) => parseInt(gv(id))   || fb;

    const pmType       = gv('pm-type') || 'winner';
    const pmMin        = parseFloat(gv('pm-min'))   || null;
    const pmMax        = parseFloat(gv('pm-max'))   || null;
    const minOdds      = parseFloat(gv('min-odds')) || null;
    const maxOdds      = parseFloat(gv('max-odds')) || null;
    const minChangePct = parseFloat(gv('minchange')) || null;
    const minVol       = parseFloat(gv('minvol'))    || null;
    const minEdge      = parseFloat(gv('minedge'))   || null;
    const tbVal        = gv('tiebreak'); // '' | 'true' | 'false'

    const allowedScoresRaw = gv('allowed-scores') || '';
    const allowedScores    = allowedScoresRaw.split(',').map(s => s.trim()).filter(Boolean);
    const loserMustBeVal   = gv('loser-must-be') || '';
    const hedgeWhenVal     = gv('hedge-when') || 'none';

    const pmKey = { winner:'preMatchOddsWinner', loser:'preMatchOddsLoser', A:'preMatchOddsA', B:'preMatchOddsB' }[pmType] || 'preMatchOddsWinner';
    // Spread existing trigger to preserve any fields not shown in the UI
    const trigger = { ...(sys.backtest?.trigger || {}), setNumber: gni('trigger-set', 1) };
    // Clear all preMatchOdds keys then set the selected one
    delete trigger.preMatchOddsWinner; delete trigger.preMatchOddsLoser;
    delete trigger.preMatchOddsA;      delete trigger.preMatchOddsB;
    if (pmMin !== null || pmMax !== null) {
      trigger[pmKey] = {};
      if (pmMin !== null) trigger[pmKey].min = pmMin;
      if (pmMax !== null) trigger[pmKey].max = pmMax;
    }
    if (tbVal === 'true')  trigger.isTiebreak = true;
    else if (tbVal === 'false') trigger.isTiebreak = false;
    else delete trigger.isTiebreak;
    if (minChangePct !== null) trigger.minChangePct = minChangePct; else delete trigger.minChangePct;
    if (allowedScores.length) trigger.allowedSetScores = allowedScores; else delete trigger.allowedSetScores;
    if (loserMustBeVal) trigger.loserMustBe = loserMustBeVal; else delete trigger.loserMustBe;

    const entry = { ...(sys.backtest?.entry || {}), player: gv('player') || 'winner', side: gv('side') || 'LAY' };
    if (minOdds !== null) entry.minOdds = minOdds; else delete entry.minOdds;
    if (maxOdds !== null) entry.maxOdds = maxOdds; else delete entry.maxOdds;

    const minMom    = parseFloat(gv('minmom')) || null;
    const momFavours = !!g('momfavours')?.checked;

    const filters = { ...(sys.filters || {}) };
    if (minVol    !== null) filters.minMatchedVolume       = minVol;    else delete filters.minMatchedVolume;
    if (minEdge   !== null) filters.minEdgePercent         = minEdge;   else delete filters.minEdgePercent;
    if (minMom    !== null) filters.minAbsMomentum         = minMom;    else delete filters.minAbsMomentum;
    if (momFavours)         filters.momentumFavoursBetPlayer = true;    else delete filters.momentumFavoursBetPlayer;
    if (!filters.surfaces) filters.surfaces = ['hard','clay','grass'];

    // Serve stat filters
    const sfPairs = [
      ['p1-1stin',  'p1MinFirstServeIn',   'p1MaxFirstServeIn'],
      ['p1-1stwon', 'p1MinFirstServeWon',  'p1MaxFirstServeWon'],
      ['p1-2ndwon', 'p1MinSecondServeWon', 'p1MaxSecondServeWon'],
      ['p1-aces',   'p1MinAces',           'p1MaxAces'],
      ['p1-dfs',    'p1MinDoubleFaults',   'p1MaxDoubleFaults'],
      ['p1-bpwon',  'p1MinBreakpointsWon', 'p1MaxBreakpointsWon'],
      ['p2-1stin',  'p2MinFirstServeIn',   'p2MaxFirstServeIn'],
      ['p2-1stwon', 'p2MinFirstServeWon',  'p2MaxFirstServeWon'],
      ['p2-2ndwon', 'p2MinSecondServeWon', 'p2MaxSecondServeWon'],
      ['p2-aces',   'p2MinAces',           'p2MaxAces'],
      ['p2-dfs',    'p2MinDoubleFaults',   'p2MaxDoubleFaults'],
      ['p2-bpwon',  'p2MinBreakpointsWon', 'p2MaxBreakpointsWon'],
    ];
    for (const [id, minKey, maxKey] of sfPairs) {
      const minVal = parseFloat(document.getElementById(`s${i}-${id}-min`)?.value) || null;
      const maxVal = parseFloat(document.getElementById(`s${i}-${id}-max`)?.value) || null;
      if (minVal !== null) filters[minKey] = minVal; else delete filters[minKey];
      if (maxVal !== null) filters[maxKey] = maxVal; else delete filters[maxKey];
    }

    // 1st-serve-won differential filter (lives on `filters`, not `backtest`)
    const fsDiffRaw = gv('fswon-diff');
    const fsDiffMaxRaw = gv('fswon-diff-max');
    const fsDiff = fsDiffRaw !== '' && fsDiffRaw != null ? parseFloat(fsDiffRaw) : null;
    const fsDiffMax = fsDiffMaxRaw !== '' && fsDiffMaxRaw != null ? parseFloat(fsDiffMaxRaw) : null;
    if (fsDiff !== null && isFinite(fsDiff)) filters.minFirstServeWonDiff = fsDiff;
    else delete filters.minFirstServeWonDiff;
    if (fsDiffMax !== null && isFinite(fsDiffMax)) filters.maxFirstServeWonDiff = fsDiffMax;
    else delete filters.maxFirstServeWonDiff;

    // Serve quality score filter — differential band (loser − winner).
    // Min and Max constrain the band; either can be blank for one-sided.
    const sqfMinDiffRaw = gv('sqf-diff');
    const sqfMaxDiffRaw = gv('sqf-diff-max');
    const sqfMinDiff = sqfMinDiffRaw !== '' && sqfMinDiffRaw != null ? parseFloat(sqfMinDiffRaw) : null;
    const sqfMaxDiff = sqfMaxDiffRaw !== '' && sqfMaxDiffRaw != null ? parseFloat(sqfMaxDiffRaw) : null;
    const serveQualityFilter = (sqfMinDiff !== null || sqfMaxDiff !== null)
      ? {
          ...(sqfMinDiff !== null && isFinite(sqfMinDiff) ? { minDifferential: sqfMinDiff } : {}),
          ...(sqfMaxDiff !== null && isFinite(sqfMaxDiff) ? { maxDifferential: sqfMaxDiff } : {}),
        }
      : undefined;

    const backtest = { ...(sys.backtest || {}), trigger, entry, exit: { type: 'none' } };
    if (serveQualityFilter) backtest.serveQualityFilter = serveQualityFilter;
    else delete backtest.serveQualityFilter;

    return {
      ...sys,
      name:        gv('name')?.trim() || sys.name || `Strategy ${i + 1}`,
      description: gv('desc') ?? sys.description ?? '',
      enabled:     !!g('enabled')?.checked,
      filters,
      staking:     { stakeGBP: gn('stake', sys.staking?.stakeGBP || 2) },
      exit: hedgeWhenVal === 'none'
        ? { type: 'none' }
        : { type: 'set_result', setNumber: gni('exit-set', 2), hedgeWhen: hedgeWhenVal },
      backtest,
    };
  });
}

async function saveStrategiesFromForm() {
  const statusEl = $('strat-save-status');
  try {
    const updatedSystems = _collectStrategyForms();
    const fullConfig     = { ..._fullStrategyConfig, systems: updatedSystems };

    const r = await fetch('/api/config/strategies', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fullConfig),
    });
    if (!r.ok) throw new Error(await r.text());

    S.strategies = updatedSystems;
    _fullStrategyConfig.systems = updatedSystems;

    if (statusEl) { statusEl.textContent = '✓ Saved'; statusEl.className = 'strat-save-status saved'; }
    setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.className = 'strat-save-status'; } }, 2500);
  } catch (e) {
    if (statusEl) { statusEl.textContent = '✗ Save failed: ' + e.message; statusEl.className = 'strat-save-status'; statusEl.style.color = 'var(--red)'; }
  }
}

function renderStrategyChart(systems, daily) {
  const ctx = $('strat-chart').getContext('2d');
  if (_stratChart) _stratChart.destroy();

  // Build cumulative P&L per day for each strategy from daily data
  // (daily gives aggregate — for per-strategy we use /api/db/bets and compute ourselves)
  // For now show aggregate cumulative
  const labels = daily.map(d => d.day);
  let cum = 0;
  const data = daily.map(d => { cum += d.pnl || 0; return parseFloat(cum.toFixed(2)); });

  _stratChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative P&L',
        data,
        borderColor: '#4f8ef7',
        backgroundColor: 'rgba(79,142,247,.08)',
        borderWidth: 2,
        fill: true,
        pointRadius: 2,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: {
        x: { ticks: { maxTicksLimit: 10 } },
        y: { title: { display: true, text: 'P&L (£)' } },
      },
    },
  });
}

function addStrategy() {
  const newStrat = {
    name:        `Strategy ${S.strategies.length + 1}`,
    description: 'New strategy — configure trigger and entry conditions below.',
    enabled:     false,
    filters:     { surfaces: ['hard','clay','grass'] },
    staking:     { stakeGBP: 2 },
    exit:        { type: 'set_result', setNumber: 2, hedgeWhen: 'bet_player_loses_set' },
    backtest: {
      trigger: { setNumber: 1, preMatchOddsWinner: { min: 1.8, max: 2.2 } },
      entry:   { player: 'winner', side: 'LAY', minOdds: 1.2, maxOdds: 1.3 },
      exit:    { type: 'none' },
    },
  };
  S.strategies.push(newStrat);
  _fullStrategyConfig.systems = S.strategies;
  renderStrategyForms(_fullStrategyConfig, S.performance || []);
  saveStrategiesFromForm();
}

function deleteStrategy(idx) {
  const name = S.strategies[idx]?.name || `Strategy ${idx + 1}`;
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  S.strategies.splice(idx, 1);
  _fullStrategyConfig.systems = S.strategies;
  renderStrategyForms(_fullStrategyConfig, S.performance || []);
  saveStrategiesFromForm();
}

function duplicateStrategy(idx) {
  const original = S.strategies[idx];
  if (!original) return;
  const copy = JSON.parse(JSON.stringify(original));
  copy.name = (original.name || `Strategy ${idx + 1}`) + ' (copy)';
  copy.enabled = false;
  S.strategies.splice(idx + 1, 0, copy);
  _fullStrategyConfig.systems = S.strategies;
  renderStrategyForms(_fullStrategyConfig, S.performance || []);
  saveStrategiesFromForm();
  // Scroll the new card into view
  const newCard = $('strat-card-' + (idx + 1));
  if (newCard) newCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function initStrategiesTab() {
  $('strat-refresh').addEventListener('click', loadStrategies);
  $('strat-export')?.addEventListener('click', exportStrategiesCsv);
}

/**
 * Build a comprehensive CSV combining every strategy's config (from strategies.json)
 * with its live performance (from /api/db/bets/performance). One row per strategy.
 *
 * Columns are deliberately verbose & human-readable so you can paste straight
 * into an AI prompt without explaining the schema.
 */
function exportStrategiesCsv() {
  const systems = _fullStrategyConfig?.systems || [];
  if (!systems.length) { alert('No strategies loaded — open the Strategies tab and try again.'); return; }
  const perfByName = {};
  for (const p of (S.performance || [])) perfByName[p.strategy_name] = p;

  const headers = [
    'Strategy Name',
    'Enabled (1/0)',
    'Description (full definition)',
    'Stake per bet (£)',
    'Trigger Set Number',
    'Allowed Set Scores',
    'Loser Must Be (A=P1, B=P2)',
    'Require Split Sets',
    'Pre-Match Odds — applies to',
    'Pre-Match Odds — Min',
    'Pre-Match Odds — Max',
    'Entry Player (winner/loser/both)',
    'Entry Side (BACK/LAY)',
    'Entry Odds — Min',
    'Entry Odds — Max',
    'Exit Type (none/set_result)',
    'Exit Set Number',
    'Exit Hedge When',
    'Filter — Surfaces',
    'Filter — Min 1st-Serve-Won Diff (pp)',
    'Filter — Max 1st-Serve-Won Diff (pp)',
    'Filter — Min Matched Volume (£)',
    'Filter — Momentum Favours Bet Player',
    'Filter — Per-Player Serve Stat Constraints (JSON)',
    'Performance — Total Bets',
    'Performance — Wins',
    'Performance — Losses',
    'Performance — Win Rate %',
    'Performance — Total Stake (£)',
    'Performance — Total Liability (£)',
    'Performance — Total PnL (£)',
    'Performance — Avg Entry Odds',
    'Performance — ROI % (PnL ÷ Stake × 100)',
  ];

  const esc = v => {
    if (v == null) return '';
    const s = typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  const rows = systems.map(sys => {
    const trig    = sys.backtest?.trigger || {};
    const entry   = sys.backtest?.entry   || {};
    const exit    = sys.exit              || {};
    const filters = sys.filters           || {};
    const p       = perfByName[sys.name]  || {};
    // Determine which pre-match odds clause is active (winner / loser / A / B)
    let pmTarget = '', pmMin = '', pmMax = '';
    if (trig.preMatchOddsWinner) { pmTarget = 'winner'; pmMin = trig.preMatchOddsWinner.min ?? ''; pmMax = trig.preMatchOddsWinner.max ?? ''; }
    else if (trig.preMatchOddsLoser)  { pmTarget = 'loser';  pmMin = trig.preMatchOddsLoser.min  ?? ''; pmMax = trig.preMatchOddsLoser.max  ?? ''; }
    else if (trig.preMatchOddsA)      { pmTarget = 'A';      pmMin = trig.preMatchOddsA.min      ?? ''; pmMax = trig.preMatchOddsA.max      ?? ''; }
    else if (trig.preMatchOddsB)      { pmTarget = 'B';      pmMin = trig.preMatchOddsB.min      ?? ''; pmMax = trig.preMatchOddsB.max      ?? ''; }

    // Extract per-player serve-stat filters into a tidy JSON blob
    const serveStatFilters = {};
    for (const k of Object.keys(trig.filters || {})) serveStatFilters[k] = trig.filters[k];

    const winRate = (p.total_bets && p.wins != null)
      ? +((p.wins / (p.wins + p.losses)) * 100).toFixed(2)
      : '';
    return [
      sys.name,
      sys.enabled ? 1 : 0,
      sys.description || '',
      sys.staking?.stakeGBP ?? '',
      trig.setNumber ?? '',
      (trig.allowedSetScores || trig.allowedSet1Scores || []).join('|'),
      trig.loserMustBe || '',
      trig.requireSplitSets ? 1 : 0,
      pmTarget, pmMin, pmMax,
      entry.player || '',
      entry.side || '',
      entry.minOdds ?? '',
      entry.maxOdds ?? '',
      exit.type || 'none',
      exit.setNumber ?? '',
      exit.hedgeWhen || '',
      (filters.surfaces || []).join('|'),
      filters.minFirstServeWonDiff ?? '',
      filters.maxFirstServeWonDiff ?? '',
      filters.minMatchedVolume ?? '',
      filters.momentumFavoursBetPlayer ? 1 : 0,
      Object.keys(serveStatFilters).length ? serveStatFilters : '',
      p.total_bets ?? 0,
      p.wins ?? 0,
      p.losses ?? 0,
      winRate,
      p.total_stake ?? '',
      p.total_liability ?? '',
      p.total_pnl ?? 0,
      p.avg_odds ?? '',
      p.roi_pct ?? '',
    ];
  });

  const csv = [headers.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
  _downloadCsv(`strategies-${new Date().toISOString().slice(0,10)}.csv`, csv);
}

function initAiTab() {
  initAiAnalysis();
}

// ── APP SWITCHER (Tennis ↔ Football) ─────────────────────────────────────────
let _footballLoaded = false;
function switchApp(app) {
  const tennisActive = app === 'tennis';
  $('app-btn-tennis').classList.toggle('active', tennisActive);
  $('app-btn-football').classList.toggle('active', !tennisActive);

  // Show/hide tennis chrome
  $('tabs').style.display          = tennisActive ? '' : 'none';
  $('hd-pill').style.display       = tennisActive ? '' : 'none';
  $('hd-stat-pnl').style.display   = tennisActive ? '' : 'none';
  $('hd-stat-bets').style.display  = tennisActive ? '' : 'none';
  $('hd-stat-mkts').style.display  = tennisActive ? '' : 'none';

  // All tennis tab panels
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.style.display = tennisActive ? '' : 'none';
  });

  // Football overlay
  $('football-app').style.display = tennisActive ? 'none' : '';

  if (!tennisActive && !_footballLoaded) {
    _footballLoaded = true;
    $('football-iframe').src = '/football.html';
  }
}

// ── AI STRATEGY ANALYSIS ──────────────────────────────────────────────────────

let _aiHistory    = [];
let _aiHistoryIdx = -1; // index into _aiHistory of what's currently displayed; -1 = none

async function loadAiHistory() {
  try {
    const r = await fetch('/api/analysis/history');
    if (!r.ok) return;
    _aiHistory = await r.json();
    renderAiHistoryList();
    // If there's history and nothing is displayed yet, show the most recent run
    if (_aiHistory.length && _aiHistoryIdx === -1) {
      _showRun(_aiHistory[0], 0);
    }
  } catch (_) {}
}

function renderAiHistoryList() {
  const el = $('ai-history-list');
  const countEl = $('ai-hist-count');
  if (!_aiHistory.length) {
    el.innerHTML = '<div class="ai-hist-empty">No runs yet — click Run Analysis</div>';
    if (countEl) countEl.textContent = '';
    return;
  }
  if (countEl) countEl.textContent = `${_aiHistory.length} saved`;
  el.innerHTML = _aiHistory.map((run, i) => {
    const d    = new Date(run.generatedAt);
    const now  = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const dateStr = isToday ? 'Today' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const bets  = run.dataSnapshot?.totalBets ?? '—';
    const pnl   = run.dataSnapshot?.totalPnl  != null ? `£${run.dataSnapshot.totalPnl}` : null;
    const strats = run.dataSnapshot?.strategies ?? null;
    const isActive = _aiHistoryIdx === i;
    return `<div class="ai-hist-item${isActive ? ' active' : ''}" onclick="showHistoryRun(${i})">
      <div class="ai-hist-when">${dateStr} <span class="ai-hist-time">${timeStr}</span></div>
      <div class="ai-hist-meta">${bets} bets${strats ? ' · ' + strats + ' strats' : ''}${pnl ? ' · ' + pnl : ''}</div>
    </div>`;
  }).join('');
}

function _showRun(run, idx) {
  _aiHistoryIdx = idx;
  renderAiHistoryList();

  $('ai-placeholder').style.display = 'none';
  $('ai-sections').innerHTML = _renderAiSections(run.analysis || '');

  const genAt = $('ai-generated-at');
  if (genAt) genAt.textContent = 'Generated ' + new Date(run.generatedAt).toLocaleTimeString('en-GB');
  $('ai-cache-badge').style.display = 'none';

  const strip = $('ai-snapshot-strip');
  if (run.dataSnapshot) {
    $('ai-snap-bets').textContent   = run.dataSnapshot.totalBets ?? '—';
    $('ai-snap-pnl').textContent    = run.dataSnapshot.totalPnl  != null ? `£${run.dataSnapshot.totalPnl}` : '—';
    $('ai-snap-strats').textContent = run.dataSnapshot.strategies ?? '—';
  }
  if (run.tokenUsage) {
    const u = run.tokenUsage;
    const total = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    $('ai-snap-tokens').textContent = total.toLocaleString();
    const parts = [`Input: ${(u.input_tokens ?? 0).toLocaleString()}`, `Output: ${(u.output_tokens ?? 0).toLocaleString()}`];
    if (u.cache_read_input_tokens) parts.push(`Cache hit: ${u.cache_read_input_tokens.toLocaleString()}`);
    $('ai-token-info').textContent = parts.join('  ·  ');
    $('ai-token-info').style.display = '';
  }
  if (strip) strip.style.display = '';
  $('ai-main').scrollTop = 0;
}

function showHistoryRun(idx) {
  const run = _aiHistory[idx];
  if (run) _showRun(run, idx);
}

const AI_SECTION_META = {
  'Overall Performance Summary': { icon: '📊', accent: 'blue' },
  'Strategy Breakdown':          { icon: '🎾', accent: 'blue' },
  'Surface Analysis':            { icon: '🌍', accent: 'blue' },
  'Actionable Recommendations':  { icon: '💡', accent: 'yellow' },
  'Risk Flags':                  { icon: '⚠️',  accent: 'red'  },
};

function _esc(t) {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _inlineMd(text) {
  return _esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function _renderVerdict(line) {
  if (/✅\s*KEEP/i.test(line))  return `<span class="ai-verdict ai-verdict-keep">✅ KEEP</span>`;
  if (/⚠️\s*TUNE/i.test(line))  return `<span class="ai-verdict ai-verdict-tune">⚠️ TUNE</span>`;
  if (/❌\s*DROP/i.test(line))  return `<span class="ai-verdict ai-verdict-drop">❌ DROP</span>`;
  return '';
}

function _renderSectionBody(title, bodyText) {
  const lines = bodyText.trim().split('\n');
  let html = '';
  let inList = false;
  let listType = '';

  const flushList = () => {
    if (inList) { html += `</${listType}>`; inList = false; listType = ''; }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) { flushList(); html += '<div class="ai-spacer"></div>'; continue; }

    const numMatch = line.match(/^(\d+)\.\s+(.+)/);
    const bulMatch = line.match(/^[-•*]\s+(.+)/);
    const h3Match  = line.match(/^###\s+(.+)/);

    if (h3Match) {
      flushList();
      html += `<h3 class="ai-h3">${_inlineMd(h3Match[1])}</h3>`;
    } else if (numMatch) {
      if (!inList || listType !== 'ol') { flushList(); html += '<ol class="ai-list">'; inList = true; listType = 'ol'; }
      html += `<li>${_inlineMd(numMatch[2])}</li>`;
    } else if (bulMatch) {
      if (!inList || listType !== 'ul') { flushList(); html += '<ul class="ai-list">'; inList = true; listType = 'ul'; }
      html += `<li>${_inlineMd(bulMatch[1])}</li>`;
    } else {
      flushList();
      const verdict = _renderVerdict(line);
      const cleaned = line
        .replace(/✅\s*KEEP/gi, '').replace(/⚠️\s*TUNE/gi, '').replace(/❌\s*DROP/gi, '').trim();
      if (cleaned) {
        html += `<p class="ai-para">${_inlineMd(cleaned)}${verdict ? ' ' + verdict : ''}</p>`;
      } else if (verdict) {
        html += `<p class="ai-para">${verdict}</p>`;
      }
    }
  }
  flushList();
  return html;
}

function _renderAiSections(analysisText) {
  // Split by ## headings
  const parts = analysisText.split(/^## /m);
  const sections = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const nl = part.indexOf('\n');
    const title = nl >= 0 ? part.slice(0, nl).trim() : part.trim();
    const body  = nl >= 0 ? part.slice(nl + 1) : '';
    sections.push({ title, body });
  }

  return sections.map(({ title, body }) => {
    const meta    = AI_SECTION_META[title] || { icon: '📋', accent: 'blue' };
    const isRisk  = meta.accent === 'red';
    const isRec   = meta.accent === 'yellow';
    return `
      <div class="ai-section-card ${isRisk ? 'ai-section-risk' : ''} ${isRec ? 'ai-section-rec' : ''}">
        <div class="ai-section-header">
          <span class="ai-section-icon">${meta.icon}</span>
          <span class="ai-section-title">${_esc(title)}</span>
        </div>
        <div class="ai-section-body">${_renderSectionBody(title, body)}</div>
      </div>`;
  }).join('');
}

async function runAiAnalysis(forceRefresh = false) {
  const btns    = [$('ai-run-btn'), $('ai-run-btn-2')].filter(Boolean);
  const sections = $('ai-sections');
  const placeholder = $('ai-placeholder');
  const info    = $('ai-token-info');
  const genAt   = $('ai-generated-at');
  const cacheBadge = $('ai-cache-badge');
  const strip   = $('ai-snapshot-strip');

  btns.forEach(b => { b.disabled = true; b.textContent = 'Analysing…'; });
  placeholder.innerHTML = `
    <div class="ai-placeholder-icon">🤖</div>
    <div class="ai-placeholder-title">Asking Claude…</div>
    <div class="ai-placeholder-sub"><span class="spinner"></span> Analysing your strategy performance data. This takes around 10–20 seconds.</div>`;
  placeholder.style.display = '';
  sections.innerHTML = '';
  info.style.display = 'none';
  strip.style.display = 'none';

  try {
    const endpoint = forceRefresh ? '/api/analysis/strategies/refresh' : '/api/analysis/strategies';
    const method   = forceRefresh ? 'POST' : 'GET';
    const r    = await fetch(endpoint, { method });
    const data = await r.json();

    if (data.error) {
      placeholder.innerHTML = `
        <div class="ai-placeholder-icon">⚠️</div>
        <div class="ai-placeholder-title" style="color:var(--red)">Analysis failed</div>
        <div class="ai-placeholder-sub" style="color:var(--red)">${_esc(data.error)}</div>
        <button class="btn btn-sm" id="ai-run-btn-2">Try Again</button>`;
      $('ai-run-btn-2')?.addEventListener('click', () => runAiAnalysis(true));
      btns.forEach(b => { if (b.id === 'ai-run-btn') { b.disabled = false; b.textContent = 'Run Analysis'; }});
      return;
    }

    // Prepend to local history list and display
    if (!data.fromCache) {
      _aiHistory.unshift({
        id:           Date.now(),
        generatedAt:  data.generatedAt,
        analysis:     data.analysis,
        tokenUsage:   data.tokenUsage,
        dataSnapshot: data.dataSnapshot,
      });
      if (_aiHistory.length > 20) _aiHistory.length = 20;
    }
    _showRun(_aiHistory[0], 0);

    cacheBadge.style.display = data.fromCache ? '' : 'none';
    btns.forEach(b => { b.disabled = false; b.textContent = b.id === 'ai-run-btn' ? 'Refresh' : 'Refresh Analysis'; });
  } catch (e) {
    placeholder.innerHTML = `
      <div class="ai-placeholder-icon">⚠️</div>
      <div class="ai-placeholder-title" style="color:var(--red)">Request failed</div>
      <div class="ai-placeholder-sub" style="color:var(--red)">${_esc(e.message)}</div>
      <button class="btn btn-sm" id="ai-run-btn-2">Try Again</button>`;
    $('ai-run-btn-2')?.addEventListener('click', () => runAiAnalysis(true));
    btns.forEach(b => { if (b.id === 'ai-run-btn') { b.disabled = false; b.textContent = 'Run Analysis'; }});
  }
}

function initAiAnalysis() {
  $('ai-run-btn').addEventListener('click', () => runAiAnalysis(true));
  $('ai-run-btn-2').addEventListener('click', () => runAiAnalysis(true));
  loadAiHistory();
}

// ── ANALYSIS TAB ──────────────────────────────────────────────────────────────
let _anChart     = null;
let _anSince     = '-7 days';
let _anChartType = 'pnl';
let _anBets      = [];
let _anDaily     = [];

async function loadAnalysis() {
  try {
    const [betsResp, daily] = await Promise.all([
      api(`/api/db/bets?since=${encodeURIComponent(_anSince)}&limit=5000`),
      api('/api/db/bets/daily-pnl'),
    ]);
    _anBets  = betsResp.bets || [];
    _anDaily = daily;
    renderAnalysisSummary(_anBets);
    renderAnalysisStratTable(_anBets);
    renderAnalysisDailyTable(daily);
    renderAnalysisChart();
    renderAnalysisBets(_anBets);
  } catch (e) {
    $('an-strat-tbody').innerHTML = `<tr><td colspan="11" class="empty">Error: ${e.message}</td></tr>`;
  }
}

function renderAnalysisSummary(bets) {
  const settled = bets.filter(b => b.pnl != null);
  const wins    = settled.filter(b => b.pnl > 0);
  const pnl     = settled.reduce((s, b) => s + b.pnl, 0);
  const stakes  = settled.reduce((s, b) => s + (b.stake || 0), 0);
  const avgOdds = bets.length ? bets.reduce((s, b) => s + (b.requested_odds || 0), 0) / bets.length : 0;
  const wr      = settled.length ? wins.length / settled.length * 100 : 0;
  const roi     = stakes > 0 ? pnl / stakes * 100 : 0;

  $('an-total').textContent   = bets.length;
  $('an-wins').textContent    = wins.length;
  $('an-wr').textContent      = settled.length ? fmt.pct(wr) : '—';
  $('an-pnl').textContent     = fmt.pnl(pnl);
  $('an-pnl').className       = 'val ' + pnlClass(pnl);
  $('an-roi').textContent     = stakes > 0 ? fmt.pct(roi) : '—';
  $('an-roi').className       = 'val ' + pnlClass(roi);
  $('an-avgodds').textContent = avgOdds > 0 ? avgOdds.toFixed(2) : '—';
}

function renderAnalysisStratTable(bets) {
  const byStrat = {};
  for (const b of bets) {
    const key = `${b.strategy_name || 'Unknown'}|${b.side || ''}`;
    if (!byStrat[key]) byStrat[key] = { name: b.strategy_name || 'Unknown', side: b.side || '—', bets: 0, wins: 0, pnl: 0, stakes: 0, oddsSum: 0, live: 0, dry: 0 };
    const s = byStrat[key];
    s.bets++;
    if (b.pnl != null && b.pnl > 0) s.wins++;
    s.pnl    += b.pnl || 0;
    s.stakes += b.stake || 0;
    s.oddsSum += b.requested_odds || 0;
    if (b.dry_run) s.dry++; else s.live++;
  }

  const rows = Object.values(byStrat)
    .filter(s => s.name && s.name !== 'Unknown' && s.name !== 'null' && s.name !== 'undefined')
    .sort((a, b) => b.pnl - a.pnl);
  if (!rows.length) {
    $('an-strat-tbody').innerHTML = '<tr><td colspan="10" class="empty">No data</td></tr>';
    return;
  }

  $('an-strat-tbody').innerHTML = rows.map(s => {
    const wr  = s.bets ? (s.wins / s.bets * 100) : 0;
    const roi = s.stakes > 0 ? (s.pnl / s.stakes * 100) : 0;
    const avg = s.bets ? (s.oddsSum / s.bets) : 0;
    return `<tr>
      <td><strong>${s.name}</strong></td>
      <td>${s.side}</td>
      <td>${s.bets}</td>
      <td>${s.wins}</td>
      <td>${s.bets ? fmt.pct(wr) : '—'}</td>
      <td class="${pnlClass(s.pnl)}">${fmt.pnl(s.pnl)}</td>
      <td class="${pnlClass(roi)}">${s.stakes > 0 ? fmt.pct(roi) : '—'}</td>
      <td>${avg > 0 ? avg.toFixed(2) : '—'}</td>
      <td>${s.live}</td>
      <td>${s.dry}</td>
    </tr>`;
  }).join('');
}

function renderAnalysisDailyTable(daily) {
  if (!daily.length) { $('an-daily-tbody').innerHTML = '<tr><td colspan="7" class="empty">No data</td></tr>'; return; }
  let cum = 0;
  const rows = [...daily].reverse();
  $('an-daily-tbody').innerHTML = rows.map(d => {
    cum += d.pnl || 0;
    const wr  = d.bets ? ((d.wins || 0) / d.bets * 100) : 0;
    const roi = d.roi_pct;
    return `<tr>
      <td>${d.day}</td>
      <td>${d.bets || 0}</td>
      <td>${d.wins || 0}</td>
      <td>${d.bets ? fmt.pct(wr) : '—'}</td>
      <td class="${pnlClass(d.pnl)}">${fmt.pnl(d.pnl)}</td>
      <td class="${roi != null ? pnlClass(roi) : ''}">${roi != null ? fmt.pct(roi) : '—'}</td>
      <td class="${pnlClass(cum)}">${fmt.pnl(cum)}</td>
    </tr>`;
  }).join('');
}

function renderAnalysisChart() {
  const canvas = $('an-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (_anChart) { _anChart.destroy(); _anChart = null; }
  const titleEl = $('an-chart-title');

  // If the canvas's parent has zero height (e.g. the tab was hidden when
  // render was triggered), re-draw on the next animation frame once layout
  // has settled. Chart.js draws into a 0×0 canvas otherwise and the chart
  // looks permanently blank until you flip chart types.
  if (canvas.offsetWidth === 0 || canvas.offsetHeight === 0) {
    requestAnimationFrame(() => renderAnalysisChart());
    return;
  }

  // No-data guard: every chart type pulls from _anBets or _anDaily — if both
  // are empty the canvas should say so, not silently render nothing.
  if ((!_anBets || _anBets.length === 0) && (!_anDaily || _anDaily.length === 0)) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#8b949e';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No bets in selected period', canvas.width / 2, canvas.height / 2);
    return;
  }

  const mkChart = (type, data, options) => {
    _anChart = new Chart(ctx, { type, data, options: { responsive: true, maintainAspectRatio: false, animation: false, ...options } });
  };
  const axisDefaults = (yLabel) => ({
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { maxTicksLimit: 14, font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
      y: { title: { display: !!yLabel, text: yLabel, font: { size: 10 } }, ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
    },
  });

  if (_anChartType === 'pnl') {
    if (titleEl) titleEl.textContent = 'Cumulative P&L';
    let cum = 0;
    mkChart('line', {
      labels: _anDaily.map(d => d.day),
      datasets: [{ label: 'Cum P&L', data: _anDaily.map(d => { cum += d.pnl || 0; return parseFloat(cum.toFixed(2)); }),
        borderColor: '#4f8ef7', backgroundColor: 'rgba(79,142,247,.08)', borderWidth: 2, fill: true, pointRadius: 2, tension: 0.3 }],
    }, { ...axisDefaults('P&L (£)'), plugins: { legend: { display: false } } });

  } else if (_anChartType === 'daily-pnl') {
    if (titleEl) titleEl.textContent = 'Daily P&L';
    mkChart('bar', {
      labels: _anDaily.map(d => d.day),
      datasets: [{ label: 'Daily P&L', data: _anDaily.map(d => d.pnl || 0),
        backgroundColor: _anDaily.map(d => (d.pnl || 0) >= 0 ? 'rgba(34,197,94,.7)' : 'rgba(239,68,68,.7)') }],
    }, axisDefaults('P&L (£)'));

  } else if (_anChartType === 'odds-dist') {
    if (titleEl) titleEl.textContent = 'Odds Distribution';
    const buckets = [1.0,1.2,1.4,1.6,1.8,2.0,2.5,3.0,4.0,5.0,7.0];
    const counts  = Array(buckets.length).fill(0);
    const pnls    = Array(buckets.length).fill(0);
    for (const b of _anBets) {
      const o = b.requested_odds || 0;
      let bi  = buckets.findLastIndex(bp => o >= bp);
      if (bi < 0) bi = 0;
      counts[bi]++;
      pnls[bi] += b.pnl || 0;
    }
    const labels = buckets.map((b, i) => i < buckets.length - 1 ? `${b}–${buckets[i+1]}` : `${b}+`);
    mkChart('bar', {
      labels,
      datasets: [
        { label: 'Bets', data: counts, backgroundColor: 'rgba(79,142,247,.7)', yAxisID: 'y' },
        { label: 'P&L', data: pnls.map(p => parseFloat(p.toFixed(2))), type: 'line', borderColor: '#22c55e', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 3, yAxisID: 'y2' },
      ],
    }, { plugins: { legend: { display: true, position: 'top', labels: { font: { size: 10 } } } },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
        y:  { position: 'left',  title: { display: true, text: 'Bets', font: { size: 10 } }, ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
        y2: { position: 'right', title: { display: true, text: 'P&L (£)', font: { size: 10 } }, ticks: { font: { size: 10 } }, grid: { drawOnChartArea: false } },
      },
    });

  } else if (_anChartType === 'pnl-strat') {
    if (titleEl) titleEl.textContent = 'P&L by Strategy';
    const byStrat = {};
    for (const b of _anBets) {
      const k = b.strategy_name || 'Unknown';
      if (!byStrat[k]) byStrat[k] = { pnl: 0, bets: 0, wins: 0 };
      byStrat[k].pnl  += b.pnl || 0;
      byStrat[k].bets++;
      if ((b.pnl || 0) > 0) byStrat[k].wins++;
    }
    const entries = Object.entries(byStrat).sort((a, b) => b[1].pnl - a[1].pnl);
    mkChart('bar', {
      labels: entries.map(([k]) => k),
      datasets: [
        { label: 'P&L', data: entries.map(([, v]) => parseFloat(v.pnl.toFixed(2))),
          backgroundColor: entries.map(([, v]) => v.pnl >= 0 ? 'rgba(34,197,94,.7)' : 'rgba(239,68,68,.7)'), yAxisID: 'y' },
        { label: 'Win %', data: entries.map(([, v]) => v.bets ? parseFloat((v.wins/v.bets*100).toFixed(1)) : 0),
          type: 'line', borderColor: '#4f8ef7', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 4, yAxisID: 'y2' },
      ],
    }, { plugins: { legend: { display: true, position: 'top', labels: { font: { size: 10 } } } },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
        y:  { position: 'left',  title: { display: true, text: 'P&L (£)', font: { size: 10 } }, ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
        y2: { position: 'right', title: { display: true, text: 'Win %', font: { size: 10 } }, ticks: { font: { size: 10 } }, grid: { drawOnChartArea: false } },
      },
    });

  } else if (_anChartType === 'pnl-surface') {
    if (titleEl) titleEl.textContent = 'P&L by Surface';
    const bySurf = {};
    for (const b of _anBets) {
      const k = b.surface || 'Unknown';
      if (!bySurf[k]) bySurf[k] = { pnl: 0, bets: 0, wins: 0 };
      bySurf[k].pnl += b.pnl || 0;
      bySurf[k].bets++;
      if ((b.pnl || 0) > 0) bySurf[k].wins++;
    }
    const entries = Object.entries(bySurf);
    const surfColors = { hard: 'rgba(79,142,247,.7)', clay: 'rgba(239,100,50,.7)', grass: 'rgba(34,197,94,.7)' };
    mkChart('bar', {
      labels: entries.map(([k]) => k),
      datasets: [
        { label: 'P&L', data: entries.map(([, v]) => parseFloat(v.pnl.toFixed(2))),
          backgroundColor: entries.map(([k, v]) => v.pnl >= 0 ? (surfColors[k.toLowerCase()] || 'rgba(79,142,247,.7)') : 'rgba(239,68,68,.7)'), yAxisID: 'y' },
        { label: 'Win %', data: entries.map(([, v]) => v.bets ? parseFloat((v.wins/v.bets*100).toFixed(1)) : 0),
          type: 'line', borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 6, yAxisID: 'y2' },
      ],
    }, { plugins: { legend: { display: true, position: 'top', labels: { font: { size: 10 } } } },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
        y:  { position: 'left',  title: { display: true, text: 'P&L (£)', font: { size: 10 } }, ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
        y2: { position: 'right', title: { display: true, text: 'Win %', font: { size: 10 } }, min: 0, max: 100, ticks: { font: { size: 10 } }, grid: { drawOnChartArea: false } },
      },
    });

  } else if (_anChartType === 'winrate') {
    if (titleEl) titleEl.textContent = 'Win Rate & ROI by Odds Range';
    const buckets = [1.0,1.3,1.6,2.0,2.5,3.0,4.0,6.0];
    const data    = buckets.map(() => ({ bets: 0, wins: 0, pnl: 0, stakes: 0 }));
    for (const b of _anBets) {
      if (b.pnl == null) continue;
      const o  = b.requested_odds || 0;
      let bi   = buckets.findLastIndex(bp => o >= bp);
      if (bi < 0) bi = 0;
      data[bi].bets++;
      data[bi].stakes += b.stake || 0;
      data[bi].pnl    += b.pnl;
      if (b.pnl > 0) data[bi].wins++;
    }
    const labels = buckets.map((b, i) => i < buckets.length - 1 ? `${b}–${buckets[i+1]}` : `${b}+`);
    const wr  = data.map(d => d.bets ? parseFloat((d.wins/d.bets*100).toFixed(1)) : null);
    const roi = data.map(d => d.stakes > 0 ? parseFloat((d.pnl/d.stakes*100).toFixed(1)) : null);
    mkChart('bar', {
      labels,
      datasets: [
        { label: 'Win %', data: wr, backgroundColor: 'rgba(79,142,247,.7)', yAxisID: 'y' },
        { label: 'ROI %', data: roi, type: 'line', borderColor: '#f59e0b', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 4, yAxisID: 'y' },
      ],
    }, { plugins: { legend: { display: true, position: 'top', labels: { font: { size: 10 } } } },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
        y: { title: { display: true, text: '%', font: { size: 10 } }, ticks: { font: { size: 10 } }, grid: { color: 'rgba(46,50,80,.5)' } },
      },
    });
  }
}

let _anBetsPage = 0;
const AN_BETS_PAGE_SIZE = 25;

function renderAnalysisBets(bets) {
  const tbody  = $('an-bets-tbody');
  const pagEl  = $('an-bets-pagination');
  const badge_ = $('an-bets-count');
  // Sort newest-first; persist into module state so prev/next can re-render the
  // same dataset without re-fetching.
  if (bets) {
    _anBets = [...bets].sort((a, b) => (b.placed_at || '') > (a.placed_at || '') ? 1 : -1);
    _anBetsPage = 0;
  }
  const all = _anBets;

  if (badge_) { badge_.textContent = all.length; badge_.style.display = ''; }

  if (!all.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No bets in this period</td></tr>';
    if (pagEl) pagEl.style.display = 'none';
    return;
  }

  const total      = all.length;
  const totalPages = Math.max(1, Math.ceil(total / AN_BETS_PAGE_SIZE));
  if (_anBetsPage >= totalPages) _anBetsPage = totalPages - 1;
  const start  = _anBetsPage * AN_BETS_PAGE_SIZE;
  const recent = all.slice(start, start + AN_BETS_PAGE_SIZE);

  tbody.innerHTML = recent.map((r, i) => {
    const settled = r.settlement_type;
    // match_state comes from the server (replaces the old !liveMatch heuristic that
    // misclassified in-progress matches as 'Finished' when the live cache was stale).
    // States: 'finished' | 'in_progress' | 'unknown' | (absent)
    const statusBadge = settled
      ? badge(settled, r.pnl >= 0 ? 'green' : 'red')
      : r.match_state === 'finished'    ? badge('Finished',    'blue')
      : r.match_state === 'in_progress' ? badge('In Play',     'yellow')
      : r.match_state === 'unknown'     ? badge('Unknown',     'gray')
      :                                    badge('Open',        'yellow');
    const pnlHtml = r.pnl != null ? `<span class="${pnlClass(r.pnl)}">${fmt.pnl(r.pnl)}</span>` : '—';
    const _stratName = r.strategy_name || '—';
    const _stratTipAttr = _stratName !== '—' ? ` title="${_stratTooltipText(_stratName)}"` : '';
    return `<tr class="an-bet-row" data-betidx="${i}" style="cursor:pointer">
      <td class="wrap"><strong>${r.match_name || '—'}</strong></td>
      <td><span class="strategy-tag"${_stratTipAttr}>${_stratName}</span></td>
      <td>${r.side || '—'}</td>
      <td>${fmt.odds(r.requested_odds)}</td>
      <td>£${r.stake?.toFixed(2) || '—'}</td>
      <td>${pnlHtml}</td>
      <td>${statusBadge}</td>
      <td>${fmt.date(r.placed_at)} ${fmt.ts(r.placed_at)}</td>
    </tr>
    <tr class="an-bet-detail-row" id="an-bet-det-${i}" style="display:none">
      <td colspan="8" style="padding:0"></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr.an-bet-row').forEach(tr => {
    tr.addEventListener('click', async () => {
      const idx    = tr.dataset.betidx;
      const detRow = document.getElementById(`an-bet-det-${idx}`);
      const isOpen = detRow.style.display !== 'none';
      tbody.querySelectorAll('.an-bet-detail-row').forEach(r => { r.style.display = 'none'; });
      tbody.querySelectorAll('.an-bet-row.selected-bet').forEach(r => r.classList.remove('selected-bet'));
      if (!isOpen) {
        tr.classList.add('selected-bet');
        const r = recent[idx];
        detRow.querySelector('td').innerHTML = _buildBetDetail(r, 'anch');
        detRow.style.display = '';
        if (r.betfair_market_id) requestAnimationFrame(() => {
          loadMatchCharts(r.betfair_market_id, { matchName: r.match_name }, 'anch');
          loadMilestones(r.betfair_market_id, 'anch');
        });
      }
    });
  });

  if (totalPages <= 1) {
    if (pagEl) pagEl.style.display = 'none';
  } else {
    pagEl.style.display = 'flex';
    const end = Math.min(start + AN_BETS_PAGE_SIZE, total);
    pagEl.innerHTML = `
      <button class="btn btn-sm" id="an-bets-prev" ${_anBetsPage === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span>Page ${_anBetsPage + 1} / ${totalPages} &nbsp;(${start + 1}–${end} of ${total})</span>
      <button class="btn btn-sm" id="an-bets-next" ${_anBetsPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>`;
    $('an-bets-prev').onclick = () => { _anBetsPage--; renderAnalysisBets(null); };
    $('an-bets-next').onclick = () => { _anBetsPage++; renderAnalysisBets(null); };
  }
}

// ── ENTRY DATA BY STRATEGY ────────────────────────────────────────────────────
let _entryData      = null;
let _entryCollapsed = new Set(JSON.parse(localStorage.getItem('entryCollapsed') || '[]'));

async function loadEntryData() {
  const body    = $('an-entry-body');
  const loadBtn = $('an-entry-load-btn');
  const csvBtn  = $('an-entry-csv-btn');
  const badge   = $('an-entry-count');

  loadBtn.disabled    = true;
  loadBtn.textContent = 'Loading…';
  body.innerHTML      = '<div style="padding:10px;color:var(--muted)"><span class="spinner"></span> Loading entry data…</div>';

  try {
    const data = await api('/api/db/bets/entry-data');
    _entryData = data.byStrategy;
    renderEntryData(_entryData);
    const total = Object.values(_entryData).reduce((s, arr) => s + arr.length, 0);
    badge.textContent    = total;
    badge.style.display  = total ? '' : 'none';
    csvBtn.style.display = total ? '' : 'none';
    loadBtn.textContent  = 'Reload';
    loadBtn.disabled     = false;
  } catch (e) {
    body.innerHTML      = `<div style="color:var(--red);padding:8px">Error: ${e.message}</div>`;
    loadBtn.textContent = 'Load';
    loadBtn.disabled    = false;
  }
}

function renderEntryData(byStrategy) {
  const body = $('an-entry-body');
  const strats = Object.keys(byStrategy).sort();
  if (!strats.length) {
    body.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px">No settled bets with serve data found.</div>';
    return;
  }

  const serveCell = (s) => {
    if (!s) return '<span style="color:var(--muted)">—</span>';
    const parts = [];
    if (s.firstIn  != null) parts.push(`${s.firstIn}%`);
    if (s.firstWon != null) parts.push(`${s.firstWon}%`);
    if (s.secondWon != null) parts.push(`${s.secondWon}%`);
    return `<span class="entry-serve-cell">${parts.join(' / ')}</span>`;
  };
  // Format 1st-serve-won % differential as a coloured cell (bet-player − opp).
  const diffCell = (v) => {
    if (v == null) return '<span style="color:var(--muted)">—</span>';
    const sign = v > 0 ? '+' : '';
    const col  = v >= 20 ? 'var(--green)' : v <= -20 ? 'var(--red)' : 'var(--text)';
    const fw   = Math.abs(v) >= 20 ? '700' : '500';
    return `<span style="color:${col};font-weight:${fw}">${sign}${v.toFixed(0)}pp</span>`;
  };
  // Serve quality composite score 0–100 (colour-coded).
  const sqCell = (v) => {
    if (v == null) return '<span style="color:var(--muted)">—</span>';
    const col = v >= 60 ? 'var(--green)' : v <= 40 ? 'var(--red)' : 'var(--text)';
    return `<span style="color:${col};font-weight:600">${v}</span>`;
  };
  // Integer-valued differential (used for serve-quality bet-player − opponent).
  const diffCellInt = (v) => {
    if (v == null) return '<span style="color:var(--muted)">—</span>';
    const sign = v > 0 ? '+' : '';
    const col  = v >= 15 ? 'var(--green)' : v <= -15 ? 'var(--red)' : 'var(--text)';
    const fw   = Math.abs(v) >= 15 ? '700' : '500';
    return `<span style="color:${col};font-weight:${fw}">${sign}${Math.round(v)}</span>`;
  };

  const outcomeCell = (row) => {
    const cls = row.outcome === 'WIN' ? 'entry-outcome-win'
      : row.outcome === 'LOSS'        ? 'entry-outcome-loss'
      : 'entry-outcome-open';
    const pnl = row.pnl != null ? ` ${row.pnl >= 0 ? '+' : ''}£${row.pnl.toFixed(2)}` : '';
    return `<span class="${cls}">${row.outcome}${pnl}</span>`;
  };

  body.innerHTML = strats.map(strat => {
    const bets = byStrategy[strat];
    const wins = bets.filter(b => b.outcome === 'WIN').length;
    const settled = bets.filter(b => b.outcome !== 'OPEN').length;
    const pnl = bets.reduce((s, b) => s + (b.pnl || 0), 0);
    const pnlStr = pnl >= 0 ? `+£${pnl.toFixed(2)}` : `-£${Math.abs(pnl).toFixed(2)}`;
    const pnlCls = pnl >= 0 ? 'color:var(--green)' : 'color:var(--red)';
    const isCollapsed = _entryCollapsed.has(strat);

    const rows = bets.map(b => {
      const date = b.placedAt ? new Date(b.placedAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short' }) : '—';
      const pmA = b.preMatchA ? b.preMatchA.toFixed(2) : '—';
      const pmB = b.preMatchB ? b.preMatchB.toFixed(2) : '—';
      const betPlayer = b.playerKey === 'A' ? (b.playerAName || 'P1') : (b.playerBName || 'P2');
      const dryTag = b.dryRun ? ' <span class="entry-dry">DRY</span>' : '';
      return `<tr>
        <td>${date}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis" title="${b.matchName || ''}">${b.matchName ? b.matchName.replace(' v ', ' v<br>') : '—'}</td>
        <td>${b.surface || '—'}</td>
        <td style="font-weight:600">${b.triggerSetScore || '—'}</td>
        <td>${pmA}</td>
        <td>${pmB}</td>
        <td style="font-weight:600">${b.entryOdds ? b.entryOdds.toFixed(2) : '—'}</td>
        <td>${b.side || '—'}</td>
        <td>${betPlayer}${dryTag}</td>
        <td>${serveCell(b.serveSet1A)}</td>
        <td>${serveCell(b.serveSet1B)}</td>
        <td>${diffCell(b.betPlayerS1FirstWonDiff)}</td>
        <td>${sqCell(b.serveQualityS1A)}</td>
        <td>${sqCell(b.serveQualityS1B)}</td>
        <td>${diffCellInt(b.betPlayerServeQualityDiffS1)}</td>
        <td>${outcomeCell(b)}</td>
      </tr>`;
    }).join('');

    return `<div class="entry-strat-block${isCollapsed ? ' collapsed' : ''}" id="entry-block-${CSS.escape(strat)}">
      <div class="entry-strat-header" onclick="toggleEntryCollapse('${strat.replace(/'/g, "\\'")}')">
        <button class="entry-collapse-btn" tabindex="-1">▾</button>
        <span>${strat}</span>
        <span class="badge badge-gray" style="font-size:10px">${bets.length} bets</span>
        ${settled > 0 ? `<span class="badge badge-gray" style="font-size:10px">${wins}/${settled} W</span>` : ''}
        ${settled > 0 ? `<span style="font-size:11px;${pnlCls}">${pnlStr}</span>` : ''}
      </div>
      <div class="entry-tbl-wrap">
        <table>
          <thead>
            <tr>
              <th rowspan="2">Date</th>
              <th rowspan="2">Match</th>
              <th rowspan="2">Surf</th>
              <th rowspan="2">Set Score</th>
              <th rowspan="2">PM-A</th>
              <th rowspan="2">PM-B</th>
              <th rowspan="2">Entry</th>
              <th rowspan="2">Side</th>
              <th rowspan="2">Player</th>
              <th class="th-group" colspan="1">── P1 Set 1 Serve ──</th>
              <th class="th-group" colspan="1">── P2 Set 1 Serve ──</th>
              <th rowspan="2" title="Bet player's 1st-serve-won % minus opponent's at trigger set">1stW Δ</th>
              <th rowspan="2" title="P1 set-1 serve quality composite score (0–100)">P1 SQ</th>
              <th rowspan="2" title="P2 set-1 serve quality composite score (0–100)">P2 SQ</th>
              <th rowspan="2" title="Bet player's set-1 serve quality score minus opponent's">SQ Δ</th>
              <th rowspan="2">Result</th>
            </tr>
            <tr>
              <th>1st% / 1stW% / 2ndW%</th>
              <th>1st% / 1stW% / 2ndW%</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

function toggleEntryCollapse(strat) {
  const block = document.getElementById('entry-block-' + CSS.escape(strat));
  if (!block) return;
  if (_entryCollapsed.has(strat)) {
    _entryCollapsed.delete(strat);
    block.classList.remove('collapsed');
  } else {
    _entryCollapsed.add(strat);
    block.classList.add('collapsed');
  }
  localStorage.setItem('entryCollapsed', JSON.stringify([..._entryCollapsed]));
}

function downloadEntryDataCsv() {
  if (!_entryData) return;
  // Verbose schema — every per-set serve metric + match-level totals + final
  // result + all the differentials. Lets downstream analysis run without
  // re-derivation. Use the per-player 6-col block helper to keep it readable.
  // Per-player × per-set serve block. Header is verbose ("Set 1 — Player A
  // — 1st Serve In %") so downstream readers don't need a schema doc.
  const serveCols = (setLabel) => [
    `${setLabel} — Player A — 1st Serve In %`,
    `${setLabel} — Player A — 1st Serve Won %`,
    `${setLabel} — Player A — 2nd Serve Won %`,
    `${setLabel} — Player A — Aces`,
    `${setLabel} — Player A — Double Faults`,
    `${setLabel} — Player A — Break Points Won`,
    `${setLabel} — Player B — 1st Serve In %`,
    `${setLabel} — Player B — 1st Serve Won %`,
    `${setLabel} — Player B — 2nd Serve Won %`,
    `${setLabel} — Player B — Aces`,
    `${setLabel} — Player B — Double Faults`,
    `${setLabel} — Player B — Break Points Won`,
  ];
  const headerCols = [
    'Strategy','Sub-Strategy (P1/P2 split)','Bet ID','Date (Local)','Placed At (UTC)','Settled At (UTC)',
    'Match','Surface','Tournament','Tournament Round',
    'Player A Name','Player B Name','Bet Player Name','Bet Player Key (A/B)','Bet Side (back/lay)','Dry Run? (Y/N)',
    'Trigger Set Score','Pre-Match Odds A','Pre-Match Odds B','Pre-Match Volume',
    'Momentum at Entry (snapshot)','Volume at Entry',
    'Momentum Index at Bet (range −1..+1, positive = bet player gaining momentum)',
    'Edge at Bet (signed; model probability − implied; positive = +EV)',
    'Requested Odds','Actual Matched Odds','Entry Odds','Hedge Odds','Stake (£)','Size Matched (£)','Liability (£)',
    'ROI % (PnL ÷ Stake × 100)',
    ...serveCols('Set 1'),
    ...serveCols('Set 2'),
    ...serveCols('Set 3'),
    ...serveCols('Match'),
    'Set 1 — 1st Serve Won % Δ (A − B)','Set 2 — 1st Serve Won % Δ (A − B)','Set 3 — 1st Serve Won % Δ (A − B)','Match — 1st Serve Won % Δ (A − B)',
    'Set 1 — Bet Player − Opp 1st Serve Won % Δ','Set 2 — Bet Player − Opp 1st Serve Won % Δ',
    'Set 3 — Bet Player − Opp 1st Serve Won % Δ','Match — Bet Player − Opp 1st Serve Won % Δ',
    'Set 1 — Player A Serve Quality (0–100)','Set 1 — Player B Serve Quality (0–100)',
    'Set 2 — Player A Serve Quality (0–100)','Set 2 — Player B Serve Quality (0–100)',
    'Set 3 — Player A Serve Quality (0–100)','Set 3 — Player B Serve Quality (0–100)',
    'Match — Player A Serve Quality (0–100)','Match — Player B Serve Quality (0–100)',
    'Set 1 — Serve Quality Δ (A − B)','Set 2 — Serve Quality Δ (A − B)',
    'Set 3 — Serve Quality Δ (A − B)','Match — Serve Quality Δ (A − B)',
    'Set 1 — Bet Player − Opp SQ Δ','Set 2 — Bet Player − Opp SQ Δ',
    'Set 3 — Bet Player − Opp SQ Δ','Match — Bet Player − Opp SQ Δ',
    'Went In Play At (UTC)','Ended At (UTC)','Winner (A/B)','Final Set Scores','Settlement Type','Outcome','Profit/Loss (£)','Reason / Note',
  ];
  const lines = [headerCols.join(',')];

  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const sv = obj => obj ? [obj.firstIn, obj.firstWon, obj.secondWon, obj.aces, obj.dfs, obj.bpWon] : [null,null,null,null,null,null];

  for (const [strat, bets] of Object.entries(_entryData)) {
    for (const b of bets) {
      const date = b.placedAt ? new Date(b.placedAt).toLocaleDateString('en-GB') : '';
      const betPlayer = b.playerKey === 'A' ? (b.playerAName || 'P1') : (b.playerBName || 'P2');
      const subStrat = b.subStrategy || (b.playerKey ? `${strat}-${b.playerKey === 'A' ? 'P1' : 'P2'}` : '');
      const roiPct   = (b.stake && b.pnl != null) ? +((b.pnl / b.stake) * 100).toFixed(2) : null;
      const row = [
        strat, subStrat, b.betId, date, b.placedAt, b.settledAt, b.matchName, b.surface, b.tournament, b.tournamentRound,
        b.playerAName, b.playerBName, betPlayer, b.playerKey, b.side, b.dryRun ? 'Y' : 'N',
        b.triggerSetScore, b.preMatchA, b.preMatchB, b.preMatchVolume,
        b.snapshotMomentumAtEntry, b.snapshotVolumeAtEntry,
        b.momentumAtBet, b.edgeAtBet,
        b.requestedOdds, b.actualOdds, b.entryOdds, b.hedgeOdds, b.stake, b.sizeMatched, b.liability,
        roiPct,
        ...sv(b.serveSet1A), ...sv(b.serveSet1B),
        ...sv(b.serveSet2A), ...sv(b.serveSet2B),
        ...sv(b.serveSet3A), ...sv(b.serveSet3B),
        ...sv(b.serveMatchA), ...sv(b.serveMatchB),
        b.s1FirstWonDiff, b.s2FirstWonDiff, b.s3FirstWonDiff, b.matchFirstWonDiff,
        b.betPlayerS1FirstWonDiff, b.betPlayerS2FirstWonDiff,
        b.betPlayerS3FirstWonDiff, b.betPlayerMatchFirstWonDiff,
        b.serveQualityS1A, b.serveQualityS1B,
        b.serveQualityS2A, b.serveQualityS2B,
        b.serveQualityS3A, b.serveQualityS3B,
        b.serveQualityMatchA, b.serveQualityMatchB,
        b.serveQualityDiffS1AB, b.serveQualityDiffS2AB,
        b.serveQualityDiffS3AB, b.serveQualityDiffMatchAB,
        b.betPlayerServeQualityDiffS1, b.betPlayerServeQualityDiffS2,
        b.betPlayerServeQualityDiffS3, b.betPlayerServeQualityDiffMatch,
        b.wentInPlayAt, b.endedAt, b.winner, b.finalSetsStr, b.settlementType, b.outcome, b.pnl, b.reasonText,
      ];
      lines.push(row.map(esc).join(','));
    }
  }
  _downloadCsv(`entry-data-${new Date().toISOString().split('T')[0]}.csv`, lines.join('\n'));
  const btn = $('an-entry-csv-btn');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = 'Downloaded';
    setTimeout(() => btn.textContent = orig, 2000);
  }
}

function initEntryData() {
  $('an-entry-load-btn').addEventListener('click', loadEntryData);
  $('an-entry-csv-btn').addEventListener('click', downloadEntryDataCsv);
}

// ── ANALYSIS SUB-TABS ─────────────────────────────────────────────────────────
let _anSubtab = 'overview';

function switchAnSubtab(name) {
  _anSubtab = name;
  ['overview', 'scanner', 'entry'].forEach(id => {
    $('an-sub-' + id).style.display = id === name ? '' : 'none';
  });
  document.querySelectorAll('.an-subtab-btn').forEach(b => {
    const active = b.dataset.subtab === name;
    b.style.color       = active ? 'var(--blue)' : 'var(--muted)';
    b.style.borderBottom = active ? '2px solid var(--blue)' : '2px solid transparent';
  });
}

// ── MARKET SCANNER ────────────────────────────────────────────────────────────
let _scannerRows = [];
let _scannerPage = 0;
const SCANNER_PAGE_SIZE = 25;

async function loadMarketScanner() {
  const tbody = $('an-scanner-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="14" class="empty"><span class="spinner"></span> Loading…</td></tr>';
  $('an-scanner-pagination').style.display = 'none';
  try {
    _scannerRows = await api('/api/db/market-scanner');
    _scannerPage = 0;
    renderScannerPage();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="14" class="empty">Error: ${e.message}</td></tr>`;
  }
}

// Trigger a browser file download for CSV content. Reused by scanner + entry.
function _downloadCsv(filename, csvText) {
  const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadMarketScannerCsv() {
  if (!_scannerRows || !_scannerRows.length) return;
  // Verbose schema — every per-set odds + per-set serve stats (S1/S2/S3 +
  // match totals) for both players + all 1st-serve-won diffs + final state.
  const serveCols = (label) => [
    `${label} — Player A — 1st Serve In %`,
    `${label} — Player A — 1st Serve Won %`,
    `${label} — Player A — 2nd Serve Won %`,
    `${label} — Player A — Aces`,
    `${label} — Player A — Double Faults`,
    `${label} — Player A — Break Points Won`,
    `${label} — Player B — 1st Serve In %`,
    `${label} — Player B — 1st Serve Won %`,
    `${label} — Player B — 2nd Serve Won %`,
    `${label} — Player B — Aces`,
    `${label} — Player B — Double Faults`,
    `${label} — Player B — Break Points Won`,
  ];
  const headerCols = [
    'Date','Betfair Market ID','Match','Player A Name','Player B Name','Surface','Tournament','Tournament Round','External Match ID',
    'Pre-Match Odds A','Pre-Match Odds B','Pre-Match Volume (£)','Pre-Match Volume at Milestone (£)',
    'Set 1 End Odds A','Set 1 End Odds B','Set 1 End Volume (£)',
    'Set 2 End Odds A','Set 2 End Odds B','Set 2 End Volume (£)',
    'Final Odds A','Final Odds B','Peak Volume (£)',
    ...serveCols('Set 1'), ...serveCols('Set 2'), ...serveCols('Set 3'), ...serveCols('Match'),
    'Set 1 — 1st Serve Won % Δ (A − B)','Set 2 — 1st Serve Won % Δ (A − B)','Set 3 — 1st Serve Won % Δ (A − B)','Match — 1st Serve Won % Δ (A − B)',
    'Set 1 — Player A Serve Quality (0–100)','Set 1 — Player B Serve Quality (0–100)',
    'Set 2 — Player A Serve Quality (0–100)','Set 2 — Player B Serve Quality (0–100)',
    'Set 3 — Player A Serve Quality (0–100)','Set 3 — Player B Serve Quality (0–100)',
    'Match — Player A Serve Quality (0–100)','Match — Player B Serve Quality (0–100)',
    'Set 1 — Serve Quality Δ (A − B)','Set 2 — Serve Quality Δ (A − B)',
    'Set 3 — Serve Quality Δ (A − B)','Match — Serve Quality Δ (A − B)',
    'Winner (A/B)','Winner Name','Final Set Scores','Ended At (UTC)',
  ];
  const lines = [headerCols.join(',')];

  const esc = v => {
    if (v == null) return '';
    const s = String(v);
    return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const num = v => v != null ? +(+v).toFixed(2) : '';
  const sv = obj => obj
    ? [obj.firstServeIn, obj.firstServeWon, obj.secondServeWon, obj.aces, obj.doubleFaults, obj.breakpointsWon]
    : [null,null,null,null,null,null];

  for (const r of _scannerRows) {
    const d = r.went_in_play_at ? new Date(r.went_in_play_at).toISOString().split('T')[0] : '';
    const winnerName = r.winner === 'A' ? (r.player_a_name || 'P1')
                     : r.winner === 'B' ? (r.player_b_name || 'P2') : '';
    const finalSetsStr = Array.isArray(r.final_sets_parsed) ? r.final_sets_parsed.join(' ') : '';
    const row = [
      d, r.betfair_market_id, r.match_name, r.player_a_name, r.player_b_name,
      r.surface, r.tournament, r.tournament_round, r.external_match_id,
      num(r.pre_match_odds_a), num(r.pre_match_odds_b),
      r.pre_match_volume != null ? Math.round(r.pre_match_volume) : '',
      r.pre_match_volume_at_milestone != null ? Math.round(r.pre_match_volume_at_milestone) : '',
      num(r.s1_end_odds_a), num(r.s1_end_odds_b),
      r.s1_end_volume != null ? Math.round(r.s1_end_volume) : '',
      num(r.s2_end_odds_a), num(r.s2_end_odds_b),
      r.s2_end_volume != null ? Math.round(r.s2_end_volume) : '',
      num(r.final_odds_a), num(r.final_odds_b),
      r.peak_volume != null ? Math.round(r.peak_volume) : '',
      ...sv(r.s1_serve_stats?.playerA),    ...sv(r.s1_serve_stats?.playerB),
      ...sv(r.s2_serve_stats?.playerA),    ...sv(r.s2_serve_stats?.playerB),
      ...sv(r.s3_serve_stats?.playerA),    ...sv(r.s3_serve_stats?.playerB),
      ...sv(r.match_serve_stats?.playerA), ...sv(r.match_serve_stats?.playerB),
      r.s1_first_won_diff, r.s2_first_won_diff, r.s3_first_won_diff, r.match_first_won_diff,
      r.s1_serve_quality_a, r.s1_serve_quality_b,
      r.s2_serve_quality_a, r.s2_serve_quality_b,
      r.s3_serve_quality_a, r.s3_serve_quality_b,
      r.match_serve_quality_a, r.match_serve_quality_b,
      r.s1_serve_quality_diff, r.s2_serve_quality_diff,
      r.s3_serve_quality_diff, r.match_serve_quality_diff,
      r.winner, winnerName, finalSetsStr, r.ended_at,
    ];
    lines.push(row.map(esc).join(','));
  }
  _downloadCsv(`market-scanner-${new Date().toISOString().split('T')[0]}.csv`, lines.join('\n'));
  const btn = $('an-scanner-csv-btn');
  if (btn) {
    const orig = btn.textContent;
    btn.textContent = `↓ ${_scannerRows.length}`;
    setTimeout(() => btn.textContent = orig, 2000);
  }
}

function renderScannerPage() {
  const tbody = $('an-scanner-tbody');
  const pagEl = $('an-scanner-pagination');
  if (!tbody) return;

  if (!_scannerRows.length) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty">No completed matches over £100k found yet</td></tr>';
    pagEl.style.display = 'none';
    return;
  }

  const totalPages = Math.ceil(_scannerRows.length / SCANNER_PAGE_SIZE);
  const start = _scannerPage * SCANNER_PAGE_SIZE;
  const page  = _scannerRows.slice(start, start + SCANNER_PAGE_SIZE);

  tbody.innerHTML = page.map(r => {
    const d = r.went_in_play_at ? new Date(r.went_in_play_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'2-digit' }) : '—';
    const winnerLabel = r.winner === 'A' ? (r.player_a_name || 'P1') : r.winner === 'B' ? (r.player_b_name || 'P2') : '—';
    const winCls = r.winner ? 'val-pos' : '';
    const diff = r.s1_first_won_diff;
    const diffStr = diff == null ? '—' : `${diff > 0 ? '+' : ''}${diff.toFixed(0)}pp`;
    const diffCls = diff == null ? '' : diff >= 20 ? 'val-pos' : diff <= -20 ? 'val-neg' : '';
    const sqA = r.s1_serve_quality_a, sqB = r.s1_serve_quality_b, sqD = r.s1_serve_quality_diff;
    const sqCellHtml = (v) => v == null ? '—' : `<span style="font-weight:600;color:${v >= 60 ? 'var(--green)' : v <= 40 ? 'var(--red)' : 'inherit'}">${v}</span>`;
    const sqDiffHtml = sqD == null ? '—'
      : `<span style="font-weight:${Math.abs(sqD) >= 15 ? '700' : '500'};color:${sqD >= 15 ? 'var(--green)' : sqD <= -15 ? 'var(--red)' : 'inherit'}">${sqD > 0 ? '+' : ''}${Math.round(sqD)}</span>`;
    return `<tr>
      <td style="white-space:nowrap">${d}</td>
      <td class="wrap"><strong>${r.match_name || '—'}</strong>${r.surface ? ` <span style="font-size:10px;color:var(--muted)">${r.surface}</span>` : ''}</td>
      <td>${r.pre_match_odds_a != null ? r.pre_match_odds_a.toFixed(2) : '—'}</td>
      <td>${r.pre_match_odds_b != null ? r.pre_match_odds_b.toFixed(2) : '—'}</td>
      <td>${r.s1_end_odds_a != null ? r.s1_end_odds_a.toFixed(2) : '—'}</td>
      <td>${r.s1_end_odds_b != null ? r.s1_end_odds_b.toFixed(2) : '—'}</td>
      <td>${r.s2_end_odds_a != null ? r.s2_end_odds_a.toFixed(2) : '—'}</td>
      <td>${r.s2_end_odds_b != null ? r.s2_end_odds_b.toFixed(2) : '—'}</td>
      <td class="${diffCls}">${diffStr}</td>
      <td>${sqCellHtml(sqA)}</td>
      <td>${sqCellHtml(sqB)}</td>
      <td>${sqDiffHtml}</td>
      <td class="${winCls}">${winnerLabel}</td>
      <td>${fmt.vol(r.peak_volume)}</td>
    </tr>`;
  }).join('');

  if (totalPages <= 1) { pagEl.style.display = 'none'; return; }
  pagEl.style.display = 'flex';
  pagEl.innerHTML = `
    <button class="btn btn-sm" id="sc-prev" ${_scannerPage === 0 ? 'disabled' : ''}>‹ Prev</button>
    <span>Page ${_scannerPage + 1} / ${totalPages} &nbsp;(${_scannerRows.length} matches)</span>
    <button class="btn btn-sm" id="sc-next" ${_scannerPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>`;
  $('sc-prev').onclick = () => { _scannerPage--; renderScannerPage(); };
  $('sc-next').onclick = () => { _scannerPage++; renderScannerPage(); };
}

function initAnalysisTab() {
  // Sub-tab switching
  document.querySelectorAll('.an-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchAnSubtab(btn.dataset.subtab));
  });

  document.querySelectorAll('.an-period').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.an-period').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _anSince = btn.dataset.since;
      loadAnalysis();
    });
  });
  document.querySelectorAll('.an-chart-type').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.an-chart-type').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _anChartType = btn.dataset.type;
      renderAnalysisChart();
    });
  });
  $('an-refresh').addEventListener('click', loadAnalysis);
  $('an-clear').addEventListener('click', clearBetHistory);
  $('an-scanner-load-btn').addEventListener('click', loadMarketScanner);
  $('an-scanner-csv-btn')?.addEventListener('click', downloadMarketScannerCsv);
}

// ── DEBUG TAB ─────────────────────────────────────────────────────────────────
async function loadSystem() {
  try {
    const [pipeline, events, counts, mode] = await Promise.all([
      api('/api/db/pipeline'),
      api('/api/db/events?since=-6+hours&limit=300'),
      api('/api/db/events/counts?since=-24+hours'),
      api('/api/debug/mode').catch(() => ({})),
    ]);

    renderSystemHealth(pipeline, counts);
    renderEventLog(events);
    renderDebugMode(mode);

    const errCount = counts.ERROR || 0;
    const badge_el = $('sys-badge');
    badge_el.style.display = errCount ? '' : 'none';
    badge_el.textContent   = errCount > 9 ? '9+' : errCount;
  } catch (e) {
    $('sys-health').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

function renderDebugMode(mode) {
  const dot  = $('db-mode-dot');
  const text = $('db-mode-text');
  const sub  = $('db-mode-sub');
  if (!dot) return;
  const isDry = mode.dryRun !== false; // default true
  dot.className  = 'dot' + (isDry ? ' dry' : ' live');
  text.textContent = isDry ? 'DRY RUN' : 'LIVE BETTING';
  text.style.color = isDry ? 'var(--yellow)' : 'var(--green)';
  sub.textContent  = isDry
    ? 'Strategies evaluate, bets are simulated only'
    : `Open bets: ${mode.openBets ?? 0}  |  P&L today: £${(mode.pnlToday ?? 0).toFixed(2)}`;
  $('db-dryrun-toggle').textContent = isDry ? 'Switch to LIVE' : 'Switch to DRY RUN';
  $('db-dryrun-toggle').className   = isDry ? 'btn btn-sm' : 'btn btn-sm btn-danger';
}

function renderDebugMarkets(markets) {
  const tbody  = $('db-markets-tbody');
  const badge_ = $('db-markets-count');
  if (!tbody) return;

  if (badge_) { badge_.textContent = markets.length; badge_.style.display = markets.length ? '' : 'none'; }

  if (!markets.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No live markets — bot may be waiting for in-play markets to appear</td></tr>';
    return;
  }

  const scr = sets => sets?.length ? sets.map(s => `${s.playerA}-${s.playerB}`).join(' ') : '—';

  tbody.innerHTML = markets.map(m => {
    const qual = m.qualSystems?.length ? badge(m.qualSystems[0], 'blue') : badge('None','gray');
    const rej  = m.topRejection ? badge(m.topRejection, 'yellow') : '—';
    return `<tr>
      <td class="wrap"><strong>${m.matchName}</strong>${m.statsLinked ? '' : ' <span style="color:var(--red);font-size:10px">✗stats</span>'}</td>
      <td class="score">${scr(m.sets)}</td>
      <td>${m.playerABack?.toFixed(2) ?? '—'}</td>
      <td>${m.playerBBack?.toFixed(2) ?? '—'}</td>
      <td>${qual}</td>
      <td>${rej}</td>
      <td>${fmt.vol(m.matchedVolume)}</td>
    </tr>`;
  }).join('');
}

function renderSystemHealth(pipeline, counts) {
  const stream = pipeline.betfairStream || {};
  const isUp   = stream.isConnected;
  const errCt  = counts.ERROR || 0;
  const warnCt = counts.WARN  || 0;

  $('sys-health').innerHTML = `
    <div class="health-item ${isUp ? 'ok' : 'err'}">
      <div class="h-name">Betfair Stream</div>
      <div class="h-val">${isUp ? '🟢 Connected' : '🔴 Offline'}</div>
      <div class="h-sub">${stream.lastHeartbeat ? 'Last msg: ' + fmt.ts(stream.lastHeartbeat) : 'Never connected'}</div>
    </div>
    <div class="health-item ${pipeline.liveMarkets > 0 ? 'ok' : 'warn'}">
      <div class="h-name">Live Markets</div>
      <div class="h-val">${pipeline.liveMarkets ?? 0}</div>
      <div class="h-sub">${pipeline.statsLinked ?? 0} stats linked</div>
    </div>
    <div class="health-item ${pipeline.withServeStats > 0 ? 'ok' : 'warn'}">
      <div class="h-name">Serve Stats</div>
      <div class="h-val">${pipeline.withServeStats ?? 0}</div>
      <div class="h-sub">markets with live stats</div>
    </div>
    <div class="health-item ${errCt === 0 ? 'ok' : 'err'}">
      <div class="h-name">Errors (24h)</div>
      <div class="h-val">${errCt}</div>
      <div class="h-sub">${warnCt} warnings</div>
    </div>
  `;
}

function renderEventLog(events) {
  const level  = $('sys-log-level').value;
  const source = $('sys-log-source').value;
  let rows = events;
  if (level)  rows = rows.filter(e => e.level === level || (level === 'WARN' && (e.level === 'WARN' || e.level === 'ERROR')));
  if (source) rows = rows.filter(e => e.source === source);

  if (!rows.length) {
    $('sys-event-log').innerHTML = '<div class="empty">No events</div>';
    return;
  }
  $('sys-event-log').innerHTML = rows.map(e => `
    <div class="event-row ${e.level}">
      <span class="event-ts">${fmt.ts(e.ts)}</span>
      <span class="event-src">${e.source}</span>
      <span class="event-msg">${e.message}</span>
    </div>`).join('');
}

function renderUnlinked(unlinked) {
  const card = $('sys-unlinked-card');
  card.style.display = unlinked.length ? '' : 'none';
  if (!unlinked.length) return;
  $('sys-unlinked-tbody').innerHTML = unlinked.map(m => `<tr>
    <td>${m.matchName}</td>
    <td style="font-family:monospace;font-size:11px">${m.marketId}</td>
    <td>${m.wentInPlayAt ? fmt.ts(m.wentInPlayAt) : '—'}</td>
  </tr>`).join('');
}

// ── HEDGE CALCULATOR ──────────────────────────────────────────────────────────

// Browser-side hedge math (mirrors hedgeCalculator.js on the server)
const _hc = {
  r2: n => Math.round(n * 100) / 100,
  pnlBack(S, E, C, H) {
    return { w: this.r2(S*(E-1) - H*(C-1)), l: this.r2(-S + H) };
  },
  pnlLay(S, E, C, H) {
    return { w: this.r2(-S*(E-1) + H*(C-1)), l: this.r2(S - H) };
  },
  pnl(side, S, E, C, H) {
    return side === 'BACK' ? this.pnlBack(S,E,C,H) : this.pnlLay(S,E,C,H);
  },
  greenUp(side, S, E, C) {
    const H = this.r2((S * E) / C);
    const locked = side === 'BACK' ? this.r2(S*(E-C)/C) : this.r2(S*(C-E)/C);
    const p = this.pnl(side, S, E, C, H);
    return { H, locked, w: p.w, l: p.l };
  },
  partial(side, S, E, C, ratio) {
    const gu = (S * E) / C;
    const H  = this.r2(gu * ratio);
    const p  = this.pnl(side, S, E, C, H);
    return { H, w: p.w, l: p.l };
  },
  kelly(side, S, E, C, edgePct) {
    const gu = this.greenUp(side, S, E, C);
    if (gu.locked <= 0 || edgePct <= 0) return { ...gu, label: 'Kelly (full — no edge)' };
    const ratio = Math.max(0.2, 1 - Math.min(edgePct / 10, 0.8));
    const p = this.partial(side, S, E, C, ratio);
    return { H: p.H, w: p.w, l: p.l, label: `Kelly ${Math.round(ratio*100)}% (${edgePct.toFixed(1)}% edge)` };
  },
  breakEven(side, S, E, C) {
    const gu = this.greenUp(side, S, E, C);
    if (gu.locked >= 0) return { ...gu, label: 'Break-even (already in profit — full GU)' };
    const maxH = C > 1 ? this.r2(S / (C - 1)) : 0;
    const H    = Math.min(maxH, this.r2(S));
    const p    = this.pnl(side, S, E, C, H);
    return { H, w: p.w, l: p.l, label: 'Break-even (partial recovery)' };
  },
};

function calculateHedge() {
  const side      = $('hc-side').value;
  const entryOdds = parseFloat($('hc-entry-odds').value);
  const stake     = parseFloat($('hc-stake').value);
  const hedgeOdds = parseFloat($('hc-hedge-odds').value);
  const edgePct   = parseFloat($('hc-edge-pct').value) || 0;
  const el        = $('hc-result');

  el.style.display = 'block';

  if (!entryOdds || !stake || !hedgeOdds || entryOdds <= 1 || hedgeOdds <= 1 || stake <= 0) {
    el.innerHTML = '<div style="color:var(--red);font-size:13px">Enter valid odds (>1.01) and a positive stake.</div>';
    return;
  }

  const hedgeSide = side === 'BACK' ? 'LAY' : 'BACK';
  const gu   = _hc.greenUp(side, stake, entryOdds, hedgeOdds);
  const p50  = _hc.partial(side, stake, entryOdds, hedgeOdds, 0.5);
  const kly  = _hc.kelly(side, stake, entryOdds, hedgeOdds, edgePct);
  const be   = _hc.breakEven(side, stake, entryOdds, hedgeOdds);

  const row = (label, r, note = '') => {
    const locked = _hc.r2((r.w + r.l) / 2);
    const cls    = locked >= 0 ? 'pos' : 'neg';
    const sign   = locked >= 0 ? '+' : '';
    return `<tr>
      <td style="color:var(--muted);font-size:12px">${label}</td>
      <td><strong>£${r.H.toFixed(2)}</strong> <span style="color:var(--muted);font-size:11px">${hedgeSide}</span></td>
      <td class="${r.w >= 0 ? 'pos' : 'neg'}">${r.w >= 0 ? '+' : ''}£${r.w.toFixed(2)}</td>
      <td class="${r.l >= 0 ? 'pos' : 'neg'}">${r.l >= 0 ? '+' : ''}£${r.l.toFixed(2)}</td>
      <td class="${cls}"><strong>${sign}£${Math.abs(locked).toFixed(2)}</strong></td>
      <td style="color:var(--muted);font-size:11px">${note}</td>
    </tr>`;
  };

  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--muted);font-size:11px;text-align:left">
        <th style="padding:4px 8px 4px 0">Mode</th>
        <th style="padding:4px 8px">Hedge</th>
        <th style="padding:4px 8px">If Wins</th>
        <th style="padding:4px 8px">If Loses</th>
        <th style="padding:4px 8px">Locked P&L</th>
        <th style="padding:4px 8px"></th>
      </tr></thead>
      <tbody style="border-top:1px solid var(--border)">
        ${row('Full green-up', gu, 'Guaranteed — no risk')}
        ${row('50% partial',   p50, 'Half banked, half live')}
        ${row(kly.label || 'Kelly', kly, edgePct > 0 ? '' : 'Set Edge % for Kelly')}
        ${row(be.label  || 'Break-even', be, '')}
      </tbody>
    </table>
    <div style="font-size:11px;color:var(--muted);margin-top:6px">
      Entry: ${side} @ ${entryOdds} | Stake: £${stake} | Current: ${hedgeOdds} | Hedge side: ${hedgeSide}
    </div>`;
}

function fillHedgeCalc(side, entryOdds, stake, hedgeOdds) {
  $('hc-side').value       = side;
  $('hc-entry-odds').value = entryOdds || '';
  $('hc-stake').value      = stake     || '';
  $('hc-hedge-odds').value = hedgeOdds || '';
  // Navigate to System tab and run the calculation
  document.querySelector('.tab-btn[data-tab="system"]').click();
  setTimeout(() => { calculateHedge(); $('hc-hedge-odds').focus(); }, 50);
}

function initHedgeCalc() {
  $('hc-calc-btn').addEventListener('click', calculateHedge);
  ['hc-entry-odds','hc-stake','hc-hedge-odds'].forEach(id => {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') calculateHedge(); });
  });
}

// ── UPCOMING MATCHES ──────────────────────────────────────────────────────────
const UP_PER_PAGE = 10;
let _upPage = 0;
let _upcomingAllRows = [];
let _upcomingRawRows = [];   // unfiltered — so toggle re-renders without a fresh fetch
let _upcomingTimer = null;
let _upFilterVol = false;

async function loadUpcoming() {
  const msg  = $('upcoming-msg');
  const wrap = $('upcoming-wrap');
  if (msg) msg.textContent = 'Loading…';
  if (wrap) wrap.style.display = 'none';
  try {
    const data = await api('/api/upcoming');
    renderUpcoming(data);
    const ts = $('upcoming-refresh-time');
    if (ts) ts.textContent = fmt.ts(Date.now());
  } catch (e) {
    if (msg) msg.textContent = 'Error: ' + e.message;
  }
}

function renderUpcoming(markets) {
  const msg    = $('upcoming-msg');
  const wrap   = $('upcoming-wrap');
  const badge_ = $('upcoming-count');

  const now  = Date.now();
  // Show upcoming (future start time) AND in-play matches not yet in the bot stream
  _upcomingRawRows = (markets || []).filter(m => {
    const t = m.startTime ? new Date(m.startTime).getTime() : 0;
    return t > now || m.inPlay;
  }).sort((a, b) => {
    // In-play first, then upcoming sorted by start time
    if (a.inPlay && !b.inPlay) return -1;
    if (!a.inPlay && b.inPlay) return 1;
    return new Date(a.startTime) - new Date(b.startTime);
  });

  _applyUpcomingFilter(msg, wrap, badge_);
}

function _applyUpcomingFilter(msg, wrap, badge_) {
  msg    = msg    || $('upcoming-msg');
  wrap   = wrap   || $('upcoming-wrap');
  badge_ = badge_ || $('upcoming-count');

  const rows = _upFilterVol
    ? _upcomingRawRows.filter(m => (m.matchedVolume || 0) >= 100_000)
    : _upcomingRawRows;

  const btn = $('upcoming-vol-toggle');
  if (btn) {
    btn.classList.toggle('btn-active', _upFilterVol);
    btn.textContent = _upFilterVol ? '100k+ ✓' : '100k+ only';
  }

  if (!rows.length) {
    const reason = _upFilterVol && _upcomingRawRows.length
      ? `No upcoming matches above 100k volume (${_upcomingRawRows.length} total hidden).`
      : 'No upcoming matches found for today.';
    if (msg)    msg.textContent     = reason;
    if (wrap)   wrap.style.display  = 'none';
    if (badge_) badge_.style.display = 'none';
    return;
  }

  if (badge_) { badge_.textContent = rows.length; badge_.style.display = ''; }
  if (msg)    msg.textContent     = '';
  if (wrap)   wrap.style.display  = '';

  _upcomingAllRows = rows;
  _upPage = Math.min(_upPage, Math.max(0, Math.ceil(rows.length / UP_PER_PAGE) - 1));
  _renderUpcomingPage();
}

function _renderUpcomingPage() {
  const tbody = $('upcoming-tbody');
  if (!tbody) return;
  const rows  = _upcomingAllRows;
  const pages = Math.ceil(rows.length / UP_PER_PAGE) || 1;
  const page  = _upcomingAllRows.slice(_upPage * UP_PER_PAGE, (_upPage + 1) * UP_PER_PAGE);

  tbody.innerHTML = page.map(m => {
    const startStr = m.inPlay
      ? '<span class="badge badge-live" style="font-size:10px">IN PLAY</span>'
      : (m.startTime ? new Date(m.startTime).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) : '—');
    const tourn = m.tournament
      ? `<span title="${m.tournament.replace(/"/g, '&quot;')}">${m.tournament.length > 28 ? m.tournament.slice(0, 26) + '…' : m.tournament}</span>`
      : '—';
    return `<tr${m.inPlay ? ' style="background:rgba(74,222,128,0.06)"' : ''}>
      <td class="wrap"><strong>${m.matchName || '—'}</strong></td>
      <td class="wrap" style="font-size:11px">${tourn}</td>
      <td>${m.round || '—'}</td>
      <td>${m.surface ? m.surface[0].toUpperCase() + m.surface.slice(1) : '—'}</td>
      <td>${m.playerARank != null ? m.playerARank : '—'}</td>
      <td>${m.playerBRank != null ? m.playerBRank : '—'}</td>
      <td>${startStr}</td>
      <td>${m.backA != null ? m.backA.toFixed(2) : '—'}</td>
      <td>${m.backB != null ? m.backB.toFixed(2) : '—'}</td>
      <td>${fmt.vol(m.matchedVolume)}</td>
    </tr>`;
  }).join('');

  // Pagination controls
  let ctrl = $('up-pagination');
  if (!ctrl) {
    ctrl = document.createElement('div');
    ctrl.id = 'up-pagination';
    ctrl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--muted)';
    $('upcoming-wrap').appendChild(ctrl);
  }
  if (pages <= 1) { ctrl.style.display = 'none'; return; }
  ctrl.style.display = 'flex';
  ctrl.innerHTML = `
    <button class="btn btn-sm" id="up-prev" ${_upPage === 0 ? 'disabled' : ''}>‹ Prev</button>
    <span>Page ${_upPage + 1} / ${pages}</span>
    <button class="btn btn-sm" id="up-next" ${_upPage >= pages - 1 ? 'disabled' : ''}>Next ›</button>`;
  $('up-prev').onclick = () => { _upPage--; _renderUpcomingPage(); };
  $('up-next').onclick = () => { _upPage++; _renderUpcomingPage(); };
}

function initUpcoming() {
  $('upcoming-refresh-btn').addEventListener('click', loadUpcoming);
  $('upcoming-vol-toggle').addEventListener('click', () => {
    _upFilterVol = !_upFilterVol;
    _applyUpcomingFilter();
  });
  loadUpcoming();
  _upcomingTimer = setInterval(loadUpcoming, 60_000);
  if (_upcomingTimer.unref) _upcomingTimer.unref();
}

// ── SIGNALS TODAY ─────────────────────────────────────────────────────────────
let _signalsLastLoaded = 0;

async function loadSignalsToday() {
  // Throttle: don't reload more than once per 15s
  if (Date.now() - _signalsLastLoaded < 15_000) return;
  _signalsLastLoaded = Date.now();
  try {
    const data = await api('/api/bfbm/signals');
    renderSignalsToday(data);
  } catch (_) {}
}

function renderSignalsToday({ signals = [], count = 0 } = {}) {
  const el    = $('signals-body');
  const badge = $('signals-count');

  if (!signals.length) {
    el.innerHTML = '<span style="color:var(--muted)">No signals fired yet today.</span>';
    badge.style.display = 'none';
    return;
  }

  badge.textContent   = count;
  badge.style.display = '';

  // Group by strategy
  const grouped = {};
  for (const s of signals) {
    if (!grouped[s.strategyName]) grouped[s.strategyName] = [];
    grouped[s.strategyName].push(s.playerName);
  }

  el.innerHTML = Object.entries(grouped).map(([strat, players]) =>
    `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
      ${badge(strat, 'blue')}
      <span style="color:var(--text)">${players.join(', ')}</span>
    </div>`
  ).join('');
}

// ── BFBM PING ─────────────────────────────────────────────────────────────────
async function bfbmPing() {
  const btn    = $('bfbm-ping-btn');
  const result = $('bfbm-ping-result');
  const dot    = $('bfbm-dot');
  const status = $('bfbm-status-text');

  btn.disabled    = true;
  btn.textContent = 'Testing…';
  result.textContent = '';

  try {
    const data = await api('/api/bfbm/ping');
    dot.className      = 'dot' + (data.reachable ? ' live' : '');
    status.textContent = data.enabled
      ? (data.reachable ? 'Connected' : 'Not reachable')
      : 'Disabled (BFBM_ENABLED=false)';
    result.textContent = data.message || '';
    result.style.color = data.reachable ? 'var(--green)' : 'var(--red)';
  } catch (e) {
    status.textContent = 'Error';
    result.textContent = e.message;
    result.style.color = 'var(--red)';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Test Connection';
  }
}

function initSystemTab() {
  $('sys-refresh').addEventListener('click', loadSystem);
  $('bfbm-ping-btn').addEventListener('click', bfbmPing);

  $('db-dryrun-toggle').addEventListener('click', async () => {
    const btn = $('db-dryrun-toggle');
    btn.disabled = true;
    try {
      const current = await api('/api/debug/mode');
      const data = await fetch('/api/debug/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: !current.dryRun }),
      }).then(r => r.json());
      renderDebugMode(data);
    } catch (e) { console.warn('toggle failed', e); }
    btn.disabled = false;
  });

  $('sys-log-level').addEventListener('change', () => {
    api('/api/db/events?since=-6+hours&limit=300').then(renderEventLog).catch(() => {});
  });
  $('sys-log-source').addEventListener('change', () => {
    api('/api/db/events?since=-6+hours&limit=300').then(renderEventLog).catch(() => {});
  });
}

// ── DB summary → header sync ──────────────────────────────────────────────────
async function syncDbSummary() {
  try {
    const d = await api('/api/db/summary');
    updateHeader(d);
    // System badge
    const errCt = d.errorsLast24h || 0;
    const b = $('sys-badge');
    b.style.display = errCt ? '' : 'none';
    b.textContent   = errCt > 9 ? '9+' : errCt;
  } catch (_) {}
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initLiveTab();
  initBetsTab();
  initAnalysisTab();
  initEntryData();
  initStrategiesTab();
  initAiTab();
  initSystemTab();
  initHedgeCalc();

  connectWs();

  // Sync DB-based summary every 30s regardless of WebSocket
  syncDbSummary();
  setInterval(syncDbSummary, 30_000);

  // Initial data loads for the active (live) tab
  updateLiveStats();
  loadSignalsToday();
});
