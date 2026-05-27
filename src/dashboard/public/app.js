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

// Strategies removed from config — hide from dropdowns/charts even if historical
// bets still reference them in the DB.
const DELETED_STRATEGIES = new Set(['Strat5', 'Strat6']);

let _sortBets   = { col: 'placed_at', dir: 1 };
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
  pnl:  v => v == null ? '—' : (v >= 0 ? '+' : '-') + '£' + Math.abs(v).toFixed(2),
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
      if (btn.dataset.tab === 'bets')       loadBets();
      if (btn.dataset.tab === 'filter-lab') openFilterLab();
      if (btn.dataset.tab === 'analysis')   loadAnalysis();
      if (btn.dataset.tab === 'strategies') loadStrategies();
      if (btn.dataset.tab === 'ai')         loadAiHistory();
      if (btn.dataset.tab === 'exceptions') loadExceptions();
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
    // Live-refresh active data tabs so users don't have to hit Refresh.
    // Hidden tabs are skipped (document.hidden) to avoid wasted reloads.
    if (!document.hidden) {
      if ($('tab-bets')?.classList.contains('active'))     loadBets();
      if ($('tab-upcoming')?.classList.contains('active')) loadUpcoming();
      if ($('tab-analysis')?.classList.contains('active')) loadAnalysis();
    }
  }
  if (event === 'status') {
    S.botRunning = true;
    updateHeader({ isRunning: true, openBets: data.openBets, marketsWatched: data.marketsWatched });
  }
  if (event === 'bet_placed' || event === 'trade_out') {
    if ($('tab-bets').classList.contains('active')) { const _savedPage = _betsPage; loadBets().then(() => { _betsPage = _savedPage; _applyBetsFilters(); }); return; }
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
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No live markets match filters</td></tr>'; return; }

  tbody.innerHTML = rows.map(m => {
    const setStr     = score(m.sets);
    const qualSys    = (m.qualifyingSystems || []);
    const openPos    = openByMarket.get(m.betfairMarketId);

    // Strategy column:
    //   green  = open bet (merged with side/player so we don't need a separate Bet column)
    //   blue   = qualifying AND its trigger boundary is still ahead (genuinely live)
    //   orange = qualifying BUT trigger set already passed without firing (missed window)
    //   gray   = nothing qualifies
    let stratBadge;
    if (openPos?.strategyName) {
      const side = openPos.side ? ` · ${openPos.side}${openPos.playerKey ? ' ' + openPos.playerKey : ''}` : '';
      stratBadge = badge(openPos.strategyName + side, 'green');
    } else if (qualSys.length) {
      const completedSets = (m.sets || []).filter(s => {
        const a = s?.playerA ?? 0, b = s?.playerB ?? 0;
        const max = Math.max(a, b);
        if (max < 6) return false;
        if (max === 7) return true;
        return (max - Math.min(a, b)) >= 2;
      }).length;
      stratBadge = qualSys.map(name => {
        const sys = (S.strategies || []).find(x => x.name === name);
        const triggerSet = sys?.backtest?.trigger?.setNumber ?? null;
        // Trigger window: still open if trigger set hasn't completed yet, or
        // we're exactly AT the moment it completed (no later set has started).
        const passed = triggerSet != null && completedSets > triggerSet;
        return badge(name, passed ? 'orange' : 'blue');
      }).join(' ');
    } else {
      stratBadge = badge('None', 'gray');
    }
    const momVal = m.momentumIndex != null ? m.momentumIndex.toFixed(0) : '—';
    const momCls = m.momentumIndex != null ? pnlClass(m.momentumIndex) : '';
    const linked = m.externalMatchId ? '' : ' <span style="color:var(--red);font-size:10px">✗</span>';
    const isExpanded = _expandedMarket === m.betfairMarketId;
    return `<tr class="live-row${isExpanded ? ' selected' : ''}" data-id="${m.betfairMarketId}" style="cursor:pointer">
      <td class="wrap"><strong>${m.matchName || '—'}</strong>${linked}${(m.betfairEventName || m.tournament) ? `<br><span style="font-size:10px;color:var(--muted)">${m.betfairEventName || m.tournament}</span>` : ''}</td>
      <td class="score">${setStr}</td>
      <td>${fmt.odds(m.playerABack)}</td>
      <td>${fmt.odds(m.playerBBack)}</td>
      <td class="${momCls}">${momVal}</td>
      <td>${fmt.vol(m.matchedVolume)}</td>
      <td>${stratBadge}</td>
    </tr>
    <tr class="live-detail-row" style="${isExpanded ? '' : 'display:none'}">
      <td colspan="7" style="padding:0">${isExpanded ? buildMatchDetail(m, openByMarket.get(m.betfairMarketId)) : ''}</td>
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
      ${kv('Qualifying', (m.qualifyingSystems || []).join(', ') || 'None')}
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

    const mkLine = (id, datasets, yLabel, yMin, yMax) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const ctx = el.getContext('2d');
      return new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: datasets.length > 1, position: 'top', labels: { boxWidth: 10, font: { size: 10 } } } },
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
        <div class="kv"><div class="k">Strategies</div><div class="v">${(m.qualifyingSystems || []).join(', ') || 'None'}</div></div>
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

async function loadBets() {
  const periodVal = $('bets-period').value;
  const since    = periodVal === 'yesterday' ? '-2 days' : periodVal;
  const strategy = $('bets-strategy').value;

  // Only show Loading placeholder on first paint; on auto-refresh keep
  // existing rows visible so the table doesn't blink.
  const _bt = $('bets-tbody');
  if (_bt.querySelector('td.empty') || _bt.children.length === 0) {
    _bt.innerHTML = '<tr><td colspan="17" class="empty"><span class="spinner"></span> Loading…</td></tr>';
  }

  try {
    const [data, perfData] = await Promise.all([
      api(`/api/db/bets?since=${encodeURIComponent(since)}&limit=2000${strategy ? '&strategy=' + encodeURIComponent(strategy) : ''}`),
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
    _applyBetsFilters();             // applies status + SQ filters → S.bets → table + stats
    renderBetPerfStats(perfData);

    // Populate strategy filter once.  Natural sort so Strat1 → Strat1h → Strat2
     // → Strat2h → Strat3 etc. — alphabetic puts Strat10 between Strat1 and Strat2.
    if ($('bets-strategy').options.length <= 1) {
      const names = [...new Set(perfData.map(p => p.strategy_name).filter(Boolean))]
        .filter(n => !DELETED_STRATEGIES.has(n))
        .sort(_naturalStratCompare);
      names.forEach(n => {
        const o = new Option(n, n);
        $('bets-strategy').add(o);
        $('live-strategy').add(new Option(n, n));
        $('strat-refresh'); // will be populated later
      });
    }
  } catch (e) {
    $('bets-tbody').innerHTML = `<tr><td colspan="17" class="empty">Error: ${e.message}</td></tr>`;
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

let _expandedBetId = null;
function renderBetsTable(rows) {
  const pagEl = $('bets-pagination');
  if (!rows.length) {
    $('bets-tbody').innerHTML = '<tr><td colspan="17" class="empty">No bets found</td></tr>';
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
    const liveMatch = S.liveMatches.find(m => m.betfairMarketId === r.betfair_market_id);
    const isMatchOver = !settled && !liveMatch && r.latest_sets;
    const statusBadge = settled
      ? badge(settled, r.pnl >= 0 ? 'green' : 'red')
      : isMatchOver ? badge('Finished', 'blue') : badge('Open', 'yellow');
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

    return `<tr class="bet-row" data-betidx="${i}" data-betid="${r.bet_id}" style="cursor:pointer">
      <td class="wrap"><strong>${r.match_name || '—'}</strong></td>
      <td class="score">${scoreStr}</td>
      <td>${r.strategy_name || '—'}</td>
      <td>${r.pnl > 0 ? `<span style="color:var(--green);font-weight:600">${r.player_name || '—'}</span>` : (r.pnl != null && r.pnl <= 0 ? `<span style="color:var(--red)">${r.player_name || '—'}</span>` : (r.player_name || '—'))}</td>
      <td>${r.side || '—'}</td>
      <td>${fmt.odds(r.requested_odds)}</td>
      <td>£${r.stake?.toFixed(2) || '—'}</td>
      <td>${pnlHtml}</td>
      <td>${statusBadge}</td>
      <td>${r.dry_run ? badge('DRY','yellow') : badge('LIVE','blue')}</td>
      <td>${r.momentum_at_bet != null ? (r.momentum_at_bet > 0 ? '+' : '') + r.momentum_at_bet.toFixed(0) : '—'}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_s1)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_s2)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_trigger)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_match)}</td>
      <td>${fmt.date(r.placed_at)} ${fmt.ts(r.placed_at)}</td>
      <td><button class="del-bet-btn" data-betid="${r.bet_id}" title="Delete bet" onclick="event.stopPropagation();deleteTennisBet('${r.bet_id}')">✕</button></td>
    </tr>
    <tr class="bet-detail-row" id="bet-detail-${i}" style="display:none">
      <td colspan="17" style="padding:0"></td>
    </tr>`;
  }).join('');

  // Expand handler — also used to restore expansion after auto-refresh.
  const _expandRow = (tr, force = false) => {
    const idx    = tr.dataset.betidx;
    const detRow = document.getElementById(`bet-detail-${idx}`);
    if (!detRow) return;
    const isOpen = detRow.style.display !== 'none';
    $('bets-tbody').querySelectorAll('.bet-detail-row').forEach(r => { r.style.display = 'none'; });
    $('bets-tbody').querySelectorAll('.bet-row.selected-bet').forEach(r => r.classList.remove('selected-bet'));
    if (!isOpen || force) {
      tr.classList.add('selected-bet');
      detRow.style.display = '';
      const r = pageRows[idx];
      _expandedBetId = r.bet_id;
      detRow.querySelector('td').innerHTML = _buildBetDetail(r);
      if (r.betfair_market_id) {
        requestAnimationFrame(() => {
          loadMatchCharts(r.betfair_market_id, { matchName: r.match_name }, 'bch');
          loadMilestones(r.betfair_market_id, 'bch');
        });
      }
    } else {
      _expandedBetId = null;
    }
  };

  // Click to expand inline detail
  $('bets-tbody').querySelectorAll('tr.bet-row').forEach(tr => {
    tr.addEventListener('click', () => _expandRow(tr));
  });

  // Restore previously-expanded row after auto-refresh re-renders the table.
  if (_expandedBetId) {
    const tr = $('bets-tbody').querySelector(`tr.bet-row[data-betid="${_expandedBetId}"]`);
    if (tr) _expandRow(tr, true);
  }

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

  // Show serve stats: live data first, fall back to the entry-time snapshot
  // so open bets whose match has dropped out of the live state still display
  // the stats that were captured at trigger time.
  const lm = (S.liveMatches || []).find(m => m.betfairMarketId === r.betfair_market_id);
  const hasLiveStats = lm?.liveServeStats?.playerA?.firstServeIn != null || lm?.liveServeStats?.playerB?.firstServeIn != null;
  let serveSection = '';
  if (!hasLiveStats) {
    // Build from snapshot fields (server-side decorates these onto each bet row)
    const sv = (a, b) => `${a != null ? a.toFixed(0)+'%' : '—'} / ${b != null ? b.toFixed(0)+'%' : '—'}`;
    const setHasData = tag => r[`serve_${tag}_a_firstServeIn`] != null || r[`serve_${tag}_b_firstServeIn`] != null;
    const setBlock = (tag, label) => {
      if (!setHasData(tag)) return '';
      const A = (k) => r[`serve_${tag}_a_${k}`];
      const B = (k) => r[`serve_${tag}_b_${k}`];
      return `<div class="mdi-subtitle">${label}</div>
        ${kv('1st serve in',  sv(A('firstServeIn'),  B('firstServeIn')))}
        ${kv('1st serve won', sv(A('firstServeWon'), B('firstServeWon')))}
        ${kv('2nd serve won', sv(A('secondServeWon'),B('secondServeWon')))}
        ${kv('Aces',          `${A('aces') ?? '—'} / ${B('aces') ?? '—'}`)}
        ${kv('Double faults', `${A('doubleFaults') ?? '—'} / ${B('doubleFaults') ?? '—'}`)}`;
    };
    const [nA, nB] = (r.match_name || '').split(' v ').map(s => s.trim());
    const blocks = [setBlock('match','Match'), setBlock('s1','Set 1'), setBlock('s2','Set 2'), setBlock('s3','Set 3')].filter(Boolean);
    if (blocks.length) {
      serveSection = `<div class="mdi-section">
        <div class="mdi-title">Serve Stats at Entry (${nA||'A'} / ${nB||'B'})</div>
        ${blocks.join('')}
      </div>`;
    }
  }
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
  const strategies = [...new Set(rows.map(r => r.strategy_name).filter(Boolean))].sort(_naturalStratCompare);
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
    <td>${r.strategy_name || '—'}</td>
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
  // Period + strategy require a full server fetch.
  ['bets-period','bets-strategy'].forEach(id => {
    $(id).addEventListener('change', loadBets);
  });
  // Status + SQ filter are pure client-side.  Re-apply over cached rows.
  $('bets-status').addEventListener('change', () => { _betsPage = 0; _applyBetsFilters(); });
  $('bets-sq-set')?.addEventListener('change', () => { _betsPage = 0; _applyBetsFilters(); });
  $('bets-side')?.addEventListener('change', () => { _betsPage = 0; _applyBetsFilters(); });
  $('bets-mom-min')?.addEventListener('input', () => { _betsPage = 0; _applyBetsFilters(); });
  $('bets-mom-max')?.addEventListener('input', () => { _betsPage = 0; _applyBetsFilters(); });
  $('bets-refresh').addEventListener('click', loadBets);

  // Click-sort on any header that declares data-col.  Numeric + null-safe.
  document.querySelectorAll('#bets-table thead th[data-col]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      _sortBets = _sortBets.col === col
        ? { col, dir: -_sortBets.dir }
        : { col, dir: 1 };
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
      'strategy_name','player_key','player_name','side',
      'requested_odds','actual_odds','stake','size_matched','liability',
      'pnl','settlement_type','dry_run','exit_config','hedge_odds',
      'momentum_at_bet','edge_at_bet','volume_at_bet',
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
      momentum_at_bet: 'Momentum at Bet',
      edge_at_bet: 'Edge at Bet (pp)',
      volume_at_bet: 'Matched Volume at Bet (£)',
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

// ── STRATEGIES TAB ────────────────────────────────────────────────────────────
let _fullStrategyConfig = {};
let _saveTimer          = null;

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

    renderStrategyForms(cfg, perf);

    // Populate strategy filter dropdowns in other tabs (once)
    if ($('bets-strategy').options.length <= 1) {
      const names = [...new Set(perf.map(p => p.strategy_name).filter(Boolean))]
        .filter(n => !DELETED_STRATEGIES.has(n))
        .sort(_naturalStratCompare);
      names.forEach(n => {
        $('bets-strategy').add(new Option(n, n));
        $('live-strategy').add(new Option(n, n));
      });
    }
  } catch (e) {
    $('strat-edit-container').innerHTML = `<div class="empty">Error: ${e.message}</div>`;
  }
}

function _stratSortKey(name) {
  // Sort by leading number, then by suffix order: '' < 'h' < 'p1' < 'p2' < other.
  const m = String(name || '').match(/^[A-Za-z]*?(\d+)([A-Za-z]*\d*)?/);
  if (!m) return [999, 99, name || ''];
  const num = parseInt(m[1], 10);
  const suf = (m[2] || '').toLowerCase();
  const sufRank = suf === '' ? 0 : suf === 'h' ? 1 : suf.startsWith('p') ? 10 + (parseInt(suf.slice(1), 10) || 0) : 50;
  return [num, sufRank, name || ''];
}
function _stratCompare(a, b) {
  const ka = _stratSortKey(a), kb = _stratSortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function renderStrategyForms(cfg, perf) {
  const systems    = cfg.systems || [];
  const perfByName = {};
  for (const p of perf) perfByName[p.strategy_name] = p;

  // Render in numeric order (Strat1, 1h, 2, 2h, ..., 5p1, 5p2, ...) but keep
  // the original config index for save-back so queueStratSave(i) writes the right slot.
  const order = systems.map((sys, i) => ({ sys, i }))
    .sort((a, b) => _stratCompare(a.sys.name, b.sys.name));

  $('strat-edit-container').innerHTML =
    `<div class="flex gap8 items-center" style="margin-bottom:12px">
       <button class="btn btn-sm btn-primary" onclick="addStrategy()">+ New Strategy</button>
     </div>
     <div class="strat-edit-grid">${
    order.map(({ sys, i }) => {
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
      return `<div class="strat-edit-card ${sys.enabled ? '' : 'strat-disabled'} ${collapsed}" id="strat-card-${i}">
        <div class="strat-edit-header" onclick="toggleStratCollapse(event,${i})">
          <button class="strat-collapse-btn" tabindex="-1">▾</button>
          <label class="toggle-switch" title="Enable / disable" onclick="event.stopPropagation()">
            <input type="checkbox" id="s${i}-enabled" ${sys.enabled ? 'checked' : ''} onchange="queueStratSave(${i})">
            <span class="toggle-track"></span>
          </label>
          <input type="text" class="strat-name-input" id="s${i}-name" value="${nameVal}" placeholder="Strategy name" oninput="queueStratSave(${i})" onclick="event.stopPropagation()">
          <div class="strat-perf-pills">
            <span class="strat-perf-pill">${p.total_bets ?? 0} bets</span>
            <span class="strat-perf-pill ${pnl != null ? pnlClass(pnl) : 'neu'}">${pnl != null ? fmt.pnl(pnl) : '£—'}</span>
            ${wr != null ? `<span class="strat-perf-pill ${wr >= 50 ? 'pos' : wr > 0 ? 'neg' : 'neu'}">${fmt.pct(wr)} WR</span>` : ''}
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
let _anSince     = '-365 days';
let _anChartType = 'pnl';
let _anBets      = [];
let _anAllBets   = [];
let _anDaily     = [];
let _anFilter    = null;  // last-known Filter Lab state, applied to Strategy Breakdown

async function loadAnalysis() {
  try {
    const isAllTime = _anSince === '-365 days';
    const [betsResp, allBetsResp, daily, flState] = await Promise.all([
      api(`/api/db/bets?since=${encodeURIComponent(_anSince)}&limit=5000`),
      isAllTime ? Promise.resolve(null) : api('/api/db/bets?since=-3650 days&limit=5000'),
      api('/api/db/bets/daily-pnl'),
      api('/api/filter-lab/state').catch(() => null),
    ]);
    _anBets    = betsResp.bets || [];
    _anAllBets = isAllTime ? _anBets : (allBetsResp?.bets || []);
    _anDaily   = daily;
    _anFilter  = flState && Object.keys(flState).length ? flState : null;
    renderAnalysisSummary(_anBets);
    renderAnalysisFilteredSummary(_anAllBets);
    renderAnalysisStratTable(_anBets, _anAllBets);
    renderAnalysisChart();
  } catch (e) {
    $('an-strat-tbody').innerHTML = `<tr><td colspan="15" class="empty">Error: ${e.message}</td></tr>`;
  }
}

function _calcDrawdown(bets) {
  let cum = 0, peak = 0, maxDD = 0;
  for (const b of bets) {
    if (b.pnl == null) continue;
    cum += b.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}
function renderAnalysisFilteredSummary(bets) {
  const wrap = $('an-filt-summary');
  if (!wrap) return;
  if (!_anFilter) { wrap.style.display = 'none'; return; }
  const filtPasses = _flBuildPassFn(_anFilter);
  const filtered   = bets.filter(filtPasses).slice().reverse();
  const settled    = filtered.filter(b => b.pnl != null);
  const wins       = settled.filter(b => b.pnl > 0);
  const pnl        = settled.reduce((s, b) => s + b.pnl, 0);
  const stakes     = settled.reduce((s, b) => s + (b.stake || 0), 0);
  const avgOdds    = filtered.length ? filtered.reduce((s, b) => s + (b.requested_odds || 0), 0) / filtered.length : 0;
  const wr         = settled.length ? wins.length / settled.length * 100 : 0;
  const roi        = stakes > 0 ? pnl / stakes * 100 : 0;
  const dd         = _calcDrawdown(filtered);
  wrap.style.display = '';
  $('an-filt-total').textContent = filtered.length;
  $('an-filt-wins').textContent  = wins.length;
  $('an-filt-wr').textContent    = settled.length ? fmt.pct(wr) : '—';
  $('an-filt-pnl').textContent   = fmt.pnl(pnl);
  $('an-filt-pnl').className     = 'val ' + pnlClass(pnl);
  $('an-filt-roi').textContent   = stakes > 0 ? fmt.pct(roi) : '—';
  $('an-filt-roi').className     = 'val ' + pnlClass(roi);
  $('an-filt-avgodds').textContent = avgOdds > 0 ? avgOdds.toFixed(2) : '—';
  $('an-filt-dd').textContent    = dd > 0 ? fmt.pnl(-dd) : '—';
  $('an-filt-dd').className      = 'val ' + (dd > 0 ? 'neg' : '');
}
function renderAnalysisSummary(bets) {
  const sorted  = bets.slice().reverse();
  const settled = sorted.filter(b => b.pnl != null);
  const wins    = settled.filter(b => b.pnl > 0);
  const pnl     = settled.reduce((s, b) => s + b.pnl, 0);
  const stakes  = settled.reduce((s, b) => s + (b.stake || 0), 0);
  const avgOdds = bets.length ? bets.reduce((s, b) => s + (b.requested_odds || 0), 0) / bets.length : 0;
  const wr      = settled.length ? wins.length / settled.length * 100 : 0;
  const roi     = stakes > 0 ? pnl / stakes * 100 : 0;
  const dd      = _calcDrawdown(sorted);
  $('an-total').textContent   = bets.length;
  $('an-wins').textContent    = wins.length;
  $('an-wr').textContent      = settled.length ? fmt.pct(wr) : '—';
  $('an-pnl').textContent     = fmt.pnl(pnl);
  $('an-pnl').className       = 'val ' + pnlClass(pnl);
  $('an-roi').textContent     = stakes > 0 ? fmt.pct(roi) : '—';
  $('an-roi').className       = 'val ' + pnlClass(roi);
  $('an-avgodds').textContent = avgOdds > 0 ? avgOdds.toFixed(2) : '—';
  $('an-dd').textContent      = dd > 0 ? fmt.pnl(-dd) : '—';
  $('an-dd').className        = 'val ' + (dd > 0 ? 'neg' : '');
}
let _anStratSort = { col: 'name', dir: 'asc' };
let _anStratRows = [];
function renderAnalysisStratTable(bets, allBets) {
  // Build a client-side filter pass function from the active Filter Lab state
  const filtPasses = _anFilter ? _flBuildPassFn(_anFilter) : null;

  const byStrat = {};
  for (const b of bets) {
    const key = `${b.strategy_name || 'Unknown'}|${b.side || ''}`;
    if (!byStrat[key]) byStrat[key] = {
      name: b.strategy_name || 'Unknown', side: b.side || '—',
      bets: 0, wins: 0, pnl: 0, stakes: 0, oddsSum: 0, live: 0, dry: 0,
      fBets: 0, fWins: 0, fPnl: 0, fStakes: 0,
    };
    const s = byStrat[key];
    s.bets++;
    if (b.pnl != null && b.pnl > 0) s.wins++;
    s.pnl    += b.pnl || 0;
    s.stakes += b.stake || 0;
    s.oddsSum += b.requested_odds || 0;
    if (b.dry_run) s.dry++; else s.live++;
  }

  if (filtPasses && allBets) {
    for (const b of allBets) {
      if (!filtPasses(b)) continue;
      const key = `${b.strategy_name || 'Unknown'}|${b.side || ''}`;
      if (!byStrat[key]) byStrat[key] = { name: b.strategy_name || 'Unknown', side: b.side || '—', bets: 0, wins: 0, pnl: 0, stakes: 0, oddsSum: 0, live: 0, dry: 0, fBets: 0, fWins: 0, fPnl: 0, fStakes: 0 };
      const s = byStrat[key];
      s.fBets++;
      if (b.pnl != null && b.pnl > 0) s.fWins++;
      s.fPnl    += b.pnl || 0;
      s.fStakes += b.stake || 0;
    }
  }

  _anStratRows = Object.values(byStrat)
    .filter(s => s.name && s.name !== 'Unknown' && s.name !== 'null' && s.name !== 'undefined')
    .map(s => ({
      ...s,
      wr:   s.bets ? (s.wins / s.bets * 100) : 0,
      roi:  s.stakes > 0 ? (s.pnl / s.stakes * 100) : 0,
      avg:  s.bets ? (s.oddsSum / s.bets) : 0,
      fWr:  s.fBets ? (s.fWins / s.fBets * 100) : 0,
      fRoi: s.fStakes > 0 ? (s.fPnl / s.fStakes * 100) : 0,
    }));

  _anStratBindHeaders();
  _anStratRedraw();
}

function _anStratBindHeaders() {
  const ths = document.querySelectorAll('#an-strat-table thead th[data-sort]');
  ths.forEach(th => {
    if (th._sortBound) return;
    th._sortBound = true;
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (_anStratSort.col === col) {
        _anStratSort.dir = _anStratSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        _anStratSort = { col, dir: col === 'name' || col === 'side' ? 'asc' : 'desc' };
      }
      _anStratRedraw();
    });
  });
}

function _anStratRedraw() {
  const rows = _anStratRows;
  if (!rows.length) {
    $('an-strat-tbody').innerHTML = `<tr><td colspan="${_anFilter ? 14 : 10}" class="empty">No data</td></tr>`;
    return;
  }
  const { col, dir } = _anStratSort;
  const mult = dir === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    if (col === 'name') return _stratCompare(a.name, b.name) * mult;
    if (col === 'side') return (a.side || '').localeCompare(b.side || '') * mult;
    return ((a[col] ?? 0) - (b[col] ?? 0)) * mult;
  });

  // Show / hide Filter Lab columns
  document.querySelectorAll('#an-strat-table .an-fl-col').forEach(el => {
    el.style.display = '';
  });

  // Reflect sort state in header chevrons
  document.querySelectorAll('#an-strat-table thead th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === col) th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });

  $('an-strat-tbody').innerHTML = sorted.map(s => `
    <tr>
      <td><strong>${s.name}</strong></td>
      <td>${s.side}</td>
      <td>${s.bets}</td>
      <td>${s.wins}</td>
      <td>${s.bets ? fmt.pct(s.wr) : '—'}</td>
      <td class="${pnlClass(s.pnl)}">${fmt.pnl(s.pnl)}</td>
      <td class="${pnlClass(s.roi)}">${s.stakes > 0 ? fmt.pct(s.roi) : '—'}</td>
      <td>${s.avg > 0 ? s.avg.toFixed(2) : '—'}</td>
      <td>${s.live}</td>
      <td>${s.dry}</td>
      ${_anFilter ? `
        <td>${s.fBets}</td>
        <td class="${pnlClass(s.fWr - 50)}">${s.fBets ? fmt.pct(s.fWr) : '—'}</td>
        <td class="${pnlClass(s.fPnl)}">${s.fBets ? fmt.pnl(s.fPnl) : '—'}</td>
        <td class="${pnlClass(s.fRoi)}">${s.fBets ? fmt.pct(s.fRoi) : '—'}</td>
      ` : ''}
    </tr>`).join('');
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
    const datasets = [{
      label: 'All bets',
      data: _anDaily.map(d => { cum += d.pnl || 0; return parseFloat(cum.toFixed(2)); }),
      borderColor: '#4f8ef7', backgroundColor: 'rgba(79,142,247,.08)', borderWidth: 2, fill: true, pointRadius: 2, tension: 0.3,
    }];

    if (_anFilter) {
      const filtPasses = _flBuildPassFn(_anFilter);
      const filtByDay = {};
      for (const b of _anBets) {
        if (b.pnl == null || !filtPasses(b)) continue;
        const day = (b.placed_at || b.settled_at || '').slice(0, 10);
        if (day) filtByDay[day] = (filtByDay[day] || 0) + b.pnl;
      }
      let fCum = 0;
      datasets.push({
        label: 'Filtered',
        data: _anDaily.map(d => { fCum += filtByDay[d.day] || 0; return parseFloat(fCum.toFixed(2)); }),
        borderColor: '#22c55e', backgroundColor: 'transparent', borderWidth: 2, fill: false,
        pointRadius: 2, tension: 0.3, borderDash: [4, 3],
      });
    }

    mkChart('line', { labels: _anDaily.map(d => d.day), datasets },
      { ...axisDefaults('P&L (£)'), plugins: { legend: { display: !!_anFilter, position: 'top', labels: { font: { size: 10 }, boxWidth: 20 } } } });

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
  // Only show spinner placeholder on first paint, not on auto-refresh tick.
  if (!_entryData) {
    body.innerHTML = '<div style="padding:10px;color:var(--muted)"><span class="spinner"></span> Loading entry data…</div>';
  }

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
  const strats = Object.keys(byStrategy).sort(_naturalStratCompare);
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
    'Strategy','Bet ID','Date (Local)','Placed At (UTC)','Settled At (UTC)',
    'Match','Surface','Tournament','Tournament Round',
    'Player A Name','Player B Name','Bet Player Name','Bet Player Key (A/B)','Bet Side (back/lay)','Dry Run? (Y/N)',
    'Trigger Set Score','Pre-Match Odds A','Pre-Match Odds B','Pre-Match Volume',
    'Momentum at Entry','Volume at Entry',
    'Requested Odds','Actual Matched Odds','Entry Odds','Hedge Odds','Stake (£)','Size Matched (£)','Liability (£)',
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
      const row = [
        strat, b.betId, date, b.placedAt, b.settledAt, b.matchName, b.surface, b.tournament, b.tournamentRound,
        b.playerAName, b.playerBName, betPlayer, b.playerKey, b.side, b.dryRun ? 'Y' : 'N',
        b.triggerSetScore, b.preMatchA, b.preMatchB, b.preMatchVolume,
        b.snapshotMomentumAtEntry, b.snapshotVolumeAtEntry,
        b.requestedOdds, b.actualOdds, b.entryOdds, b.hedgeOdds, b.stake, b.sizeMatched, b.liability,
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
  if (tbody.querySelector('td.empty') || tbody.children.length === 0) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty"><span class="spinner"></span> Loading…</td></tr>';
  }
  if (_scannerRows.length === 0) $('an-scanner-pagination').style.display = 'none';
  try {
    _scannerRows = await api('/api/db/market-scanner');
    _scannerPage = 0;
    renderScannerPage();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="14" class="empty">Error: ${e.message}</td></tr>`;
  }
}

// Trigger a browser file download for CSV content. Reused by scanner + entry.
// UTF-8 BOM ('﻿') prefix tells Excel the file is UTF-8 — without it, Excel
// defaults to the local code page (Windows-1252 on Windows) and £/—/–/Δ/− render
// as Â£/â€"/â€"/Î"/âˆ'.
function _downloadCsv(filename, csvText) {
  const blob = new Blob(['﻿', csvText], { type: 'text/csv;charset=utf-8' });
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
  // Only show the Loading placeholder on the first fetch. On the 60s refresh
  // we leave the existing table visible to avoid the disappear/reappear flicker.
  const isFirstLoad = !_upcomingRawRows.length;
  if (isFirstLoad) {
    if (msg) msg.textContent = 'Loading…';
    if (wrap) wrap.style.display = 'none';
  }
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

// ── EXCEPTIONS TAB (daily missed-bets replay) ──────────────────────────────
function initExceptionsTab() {
  const y = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const inp = $('exc-date'); if (inp) inp.value = y;
  const btn = $('exc-run-btn');
  if (btn) btn.addEventListener('click', () => runExceptionsForDate($('exc-date').value));
}

async function loadExceptions() {
  await loadExceptionsHistory();
  const list = document.querySelectorAll('#exc-history-list .ai-hist-item');
  if (list.length && !$('exc-sections').innerHTML.trim()) list[0].click();
}

async function loadExceptionsHistory() {
  try {
    const hist = await api('/api/analysis/missed-bets/history');
    const wrap = $('exc-history-list');
    $('exc-hist-count').textContent = hist.length ? `${hist.length}` : '';
    if (!hist.length) {
      wrap.innerHTML = '<div class="ai-hist-empty">No runs yet — pick a date and hit Replay.</div>';
      return;
    }
    wrap.innerHTML = hist.map(h => {
      const pPnl = h.summary?.paperPnlTotal;
      const pTxt = pPnl != null ? ` · ${pPnl >= 0 ? '+' : ''}${pPnl.toFixed(2)}£` : '';
      return `
      <div class="ai-hist-item" data-date="${h.date}">
        <div class="ai-hist-date">${h.date}</div>
        <div class="ai-hist-meta">${h.summary?.missedCount ?? 0} missed · ${h.summary?.marketsScanned ?? 0} markets${pTxt}</div>
      </div>
    `;}).join('');
    wrap.querySelectorAll('.ai-hist-item').forEach(el => {
      el.addEventListener('click', () => {
        wrap.querySelectorAll('.ai-hist-item').forEach(x => x.classList.remove('active'));
        el.classList.add('active');
        loadExceptionsRun(el.dataset.date);
      });
    });
  } catch (e) {
    $('exc-history-list').innerHTML = `<div class="ai-hist-empty">Error: ${e.message}</div>`;
  }
}

async function runExceptionsForDate(date) {
  if (!date) return;
  const btn = $('exc-run-btn');
  btn.disabled = true; btn.textContent = 'Running…';
  try {
    const run = await fetch('/api/analysis/missed-bets/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    }).then(r => r.json());
    if (run.error) throw new Error(run.error);
    renderExceptionsRun(run);
    await loadExceptionsHistory();
  } catch (e) {
    alert('Replay failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Replay date';
  }
}

async function loadExceptionsRun(date) {
  try {
    const run = await api('/api/analysis/missed-bets/' + date);
    renderExceptionsRun(run);
  } catch (e) {
    $('exc-sections').innerHTML = `<div class="card">Error: ${e.message}</div>`;
  }
}

function renderExceptionsRun(run) {
  $('exc-placeholder').style.display = 'none';
  $('exc-snapshot-strip').style.display = '';
  $('exc-snap-markets').textContent = run.summary.marketsScanned;
  $('exc-snap-signals').textContent = run.summary.qualifyingSignals;
  $('exc-snap-real').textContent    = run.summary.realBetsPlaced;
  $('exc-snap-missed').textContent  = run.summary.missedCount;
  const pPnl = run.summary.paperPnlTotal;
  const pW   = run.summary.paperWins   ?? 0;
  const pL   = run.summary.paperLosses ?? 0;
  $('exc-snap-paper-pnl').textContent = pPnl != null
    ? (pPnl >= 0 ? '+' : '') + pPnl.toFixed(2)
    : '—';
  $('exc-snap-paper-wr').textContent = (pW + pL) > 0 ? `${pW}/${pL}` : '—';
  $('exc-summary-badge').textContent = `${run.date} · generated ${fmt.ts(run.generatedAt)}`;

  const byStrat   = run.summary.byStrategy || {};
  const byStratPP = run.summary.paperByStrategy || {};
  const stratPills = Object.keys(byStrat)
    .sort((a, b) => _stratCompare(a, b))
    .map(k => {
      const pp = byStratPP[k];
      const pnl = pp ? ` · ${pp.pnl >= 0 ? '+' : ''}${pp.pnl.toFixed(2)}` : '';
      return `<span class="strat-perf-pill neg">${k}: ${byStrat[k]}${pnl}</span>`;
    })
    .join(' ');

  const rows = (run.missed || []).map(m => {
    const fs = Array.isArray(m.finalSets)
      ? m.finalSets.map(s => {
          const a = Array.isArray(s) ? s[0] : s?.playerA;
          const b = Array.isArray(s) ? s[1] : s?.playerB;
          return `${a ?? '?'}-${b ?? '?'}`;
        }).join(' ')
      : '—';
    const sideLbl = m.side && m.playerKey ? `${m.side} ${m.playerKey}` : '—';
    const pnlNum  = m.paperPnl;
    const pnlCls  = pnlNum == null ? '' : (pnlNum >= 0 ? 'pos' : 'neg');
    const pnlTxt  = pnlNum == null ? '—' : (pnlNum >= 0 ? '+' : '') + pnlNum.toFixed(2);
    const settle  = m.paperSettlement || '—';
    return `<tr>
      <td>${fmt.ts(m.ts)}</td>
      <td><strong>${m.strategy}</strong></td>
      <td>${m.matchName || '—'}</td>
      <td>${m.tournament || '—'}</td>
      <td>${m.surface || '—'}</td>
      <td>S${m.setBoundary}</td>
      <td>${m.oddsA != null ? m.oddsA.toFixed(2) : '—'} / ${m.oddsB != null ? m.oddsB.toFixed(2) : '—'}</td>
      <td>${fs}</td>
      <td>${m.winner || '—'}</td>
      <td>${sideLbl}</td>
      <td>${settle}</td>
      <td class="${pnlCls}">${pnlTxt}</td>
    </tr>`;
  }).join('');

  $('exc-sections').innerHTML = `
    <div class="card" style="margin-bottom:12px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">By strategy (count · paper £)</div>
      <div class="strat-perf-pills">${stratPills || '<span class="strat-perf-pill neu">None — all signals had real bets placed.</span>'}</div>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr>
          <th>Time</th><th>Strategy</th><th>Match</th><th>Tournament</th>
          <th>Surface</th><th>At</th><th>Odds A / B</th><th>Final sets</th><th>Winner</th>
          <th>Bet</th><th>Paper result</th><th>Paper £</th>
        </tr></thead>
        <tbody>${rows || '<tr><td colspan="12" style="text-align:center;color:var(--muted)">No missed bets for this day.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

// ── FILTER LAB ─────────────────────────────────────────────────────────────
// Apply filter ranges retroactively to every bet in the period. Compare
// filtered vs raw baseline side-by-side. Presets + state persist in localStorage.
const FL_LS_FILTERS = 'tennisFilterLab.filters.v1';
const FL_LS_PRESETS = 'tennisFilterLab.presets.v1';
const FL_PAGE_SIZE  = 25;
let _flBaseRows = [];        // unfiltered rows for current period
let _flFilteredRows = [];
let _flPage = 0;
let _flStrategies = new Set(); // multi-select state

function initFilterLab() {
  // Wire buttons
  $('fl-apply').addEventListener('click', () => { _flPage = 0; runFilterLab(); });
  $('fl-reset').addEventListener('click', resetFilterLab);
  $('fl-save-preset').addEventListener('click', saveFilterLabPreset);
  $('fl-export').addEventListener('click', exportFilterLabCsv);
  $('fl-bfbm-save').addEventListener('click', saveAsBfbmFilter);
  $('fl-bfbm-clear').addEventListener('click', clearBfbmFilter);
  refreshBfbmFilterStatus();
  $('fl-period').addEventListener('change', loadFilterLabPeriod);
  $('fl-load-preset').addEventListener('change', e => {
    if (e.target.value) loadFilterLabPreset(e.target.value);
  });
  // Per-strategy SQ delta editor toggle + clear
  $('fl-strat-sq-toggle').addEventListener('click', () => {
    const grid = $('fl-strat-sq-grid');
    const chev = $('fl-strat-sq-chev');
    const isOpen = grid.style.display !== 'none';
    grid.style.display = isOpen ? 'none' : '';
    chev.textContent = isOpen ? '▶ show' : '▼ hide';
    if (!isOpen) _renderFlStrategyDeltaGrid();
  });
  $('fl-strat-sq-clear').addEventListener('click', () => {
    _flStrategyDeltaRanges = {};
    _renderFlStrategyDeltaGrid();
  });
  // Multi-select strategies popover
  $('fl-strategies').addEventListener('click', toggleFlStrategiesPop);
  document.addEventListener('click', e => {
    if (!e.target.closest('#fl-strategies') && !e.target.closest('#fl-strategies-pop')) {
      $('fl-strategies-pop').style.display = 'none';
    }
  });
  // Restore server-side state and presets list; first-paint may run before
  // these resolve, but openFilterLab/loadFilterLabPeriod handle refresh.
  restoreFilterLabFilters().then(() => refreshFilterLabPresetList());
}

function openFilterLab() {
  if (!_flBaseRows.length) loadFilterLabPeriod();
  _initDeltaQualityOnce();
}

// ─────────────────────────────────────────────────────────────────────────
// Delta Quality Lab (sub-tab under Filter Lab) — shadow-only per-strategy
// sqDiffTrigger filter view. Real bets are unaffected; this tab just shows
// which historical bets would have survived the preset in data/sq_delta_filter.json.
// ─────────────────────────────────────────────────────────────────────────
const DQ_PAGE_SIZE = 25;
const DQ_PRESET_NAME = 'Delta Quality v1';
let _dqPreset      = null;       // normalised filter shape currently applied
let _dqPresetLabel = DQ_PRESET_NAME;
let _dqBaseRows    = [];
let _dqFiltRows    = [];
let _dqAllTimeRows = null;       // lifetime baseline — cached
let _dqPage        = 0;
let _dqInited      = false;

function _initDeltaQualityOnce() {
  if (_dqInited) return;
  _dqInited = true;

  document.querySelectorAll('.fl-subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.fl-subtab-btn').forEach(b => {
        b.classList.remove('active');
        b.style.borderBottomColor = 'transparent';
        b.style.color = 'var(--muted)';
      });
      btn.classList.add('active');
      btn.style.borderBottomColor = 'var(--blue)';
      btn.style.color = 'var(--blue)';
      const which = btn.dataset.subtab;
      $('fl-sub-filters').style.display = which === 'filters' ? '' : 'none';
      $('fl-sub-delta').style.display   = which === 'delta'   ? '' : 'none';
      if (which === 'delta') loadDeltaQuality();
    });
  });

  $('dq-refresh').addEventListener('click', () => { _dqPreset = null; _dqAllTimeRows = null; _refreshDqPresetDropdown().then(loadDeltaQuality); });
  $('dq-period').addEventListener('change', loadDeltaQuality);
  $('dq-csv').addEventListener('click', exportDeltaQualityCsv);
  $('dq-preset-select').addEventListener('change', () => { _dqPreset = null; loadDeltaQuality(); });

  // Initial preset dropdown populate
  _refreshDqPresetDropdown();
}

async function _refreshDqPresetDropdown() {
  // Built-in always first; then user-saved presets from /api/filter-lab/presets.
  const select = $('dq-preset-select');
  const cur    = select.value || '__delta_quality__';
  let userPresets = {};
  try {
    userPresets = await fetch('/api/filter-lab/presets').then(r => r.json());
  } catch (_) {}
  const userNames = Object.keys(userPresets || {}).sort();
  select.innerHTML =
    `<option value="__delta_quality__">${DQ_PRESET_NAME} (per-strategy SQ delta)</option>` +
    userNames.map(n => `<option value="${n}">${n}</option>`).join('');
  // Restore previous selection if still present
  select.value = [...select.options].some(o => o.value === cur) ? cur : '__delta_quality__';
}

async function _resolveDqPreset() {
  // Returns a normalised filter shape: { strategies, side, betOn, *Min/Max,
  // surfaces, tournament, mode, status, strategyDeltaRanges, sqTrigMin/Max, ... }.
  // For the built-in Delta Quality preset, only strategyDeltaRanges is populated.
  const name = $('dq-preset-select').value || '__delta_quality__';
  _dqPresetLabel = name === '__delta_quality__' ? DQ_PRESET_NAME : name;
  if (name === '__delta_quality__') {
    const p = await api('/api/delta-quality/preset');
    const ranges = {};
    for (const [s, r] of Object.entries(p.ranges || {})) {
      if (r && (r.min != null || r.max != null)) ranges[s] = { min: r.min ?? null, max: r.max ?? null };
    }
    return { strategyDeltaRanges: ranges };
  }
  const all = await fetch('/api/filter-lab/presets').then(r => r.json());
  return all?.[name] || {};
}

async function loadDeltaQuality() {
  try {
    if (!_dqPreset) _dqPreset = await _resolveDqPreset();
    $('dq-preset-name').textContent = _dqPresetLabel || '—';
  } catch (e) {
    console.error('DQ preset load failed', e);
    _dqPreset = {};
  }

  const periodVal = $('dq-period').value;
  const since = periodVal === 'yesterday' ? '-2 days' : periodVal;

  $('dq-summary-tbody').innerHTML = '<tr><td colspan="10" class="empty"><span class="spinner"></span> Loading…</td></tr>';
  $('dq-bets-tbody').innerHTML    = '<tr><td colspan="16" class="empty"><span class="spinner"></span> Loading…</td></tr>';

  try {
    const reqs = [api(`/api/db/bets?since=${encodeURIComponent(since)}&limit=2000`)];
    // All-time baseline — fetched once per session, reused on period changes.
    if (!_dqAllTimeRows) {
      reqs.push(api('/api/db/bets?since=-3650 days&limit=2000'));
    }
    const results = await Promise.all(reqs);
    const data    = results[0];
    if (results.length > 1) _dqAllTimeRows = results[1].bets || [];
    let rows = data.bets || [];
    if (periodVal === 'yesterday') {
      const d = new Date(); d.setDate(d.getDate() - 1);
      const ymd = d.toISOString().slice(0, 10);
      rows = rows.filter(r => (r.placed_at || '').slice(0, 10) === ymd);
    }
    _dqBaseRows = rows;
    _dqFiltRows = rows.filter(_dqPasses);
    _dqPage = 0;
    _renderDeltaQualitySummary();
    _renderDeltaQualityStats();
    _renderDeltaQualityBets();
  } catch (e) {
    $('dq-summary-tbody').innerHTML = `<tr><td colspan="10" class="empty">Error: ${e.message}</td></tr>`;
    $('dq-bets-tbody').innerHTML    = `<tr><td colspan="16" class="empty">Error: ${e.message}</td></tr>`;
  }
}

function _dqRange(strategyName) {
  const ranges = _dqPreset?.strategyDeltaRanges;
  if (!ranges) return null;
  const r = ranges[strategyName];
  return (r && typeof r === 'object' && (r.min != null || r.max != null)) ? r : null;
}

function _dqPasses(bet) {
  const f = _dqPreset || {};
  const inRange  = (v, lo, hi) => (v == null) ? false : (lo == null || v >= lo) && (hi == null || v <= hi);
  const optRange = (v, lo, hi) => (lo == null && hi == null) ? true : inRange(v, lo, hi);

  if (Array.isArray(f.strategies) && f.strategies.length && !f.strategies.includes(bet.strategy_name)) return false;
  if (f.side  && bet.side       !== f.side)  return false;
  if (f.betOn && bet.player_key !== f.betOn) return false;
  if (Array.isArray(f.surfaces) && f.surfaces.length && bet.surface && !f.surfaces.includes(bet.surface)) return false;
  if (f.tournament && !(bet.tournament || '').toLowerCase().includes(String(f.tournament).toLowerCase())) return false;
  if (f.mode === 'live' && bet.dry_run) return false;
  if (f.mode === 'dry'  && !bet.dry_run) return false;
  if (f.status === 'open' && bet.pnl != null) return false;
  if (f.status === 'win'  && !(bet.pnl != null && bet.pnl > 0)) return false;
  if (f.status === 'loss' && !(bet.pnl != null && bet.pnl <= 0)) return false;
  if (!optRange(bet.requested_odds,                       f.oddsMin,  f.oddsMax))  return false;
  if (!optRange(bet.edge_at_bet,                          f.edgeMin,  f.edgeMax))  return false;
  if (!optRange(bet.momentum_at_bet,                      f.momMin,   f.momMax))   return false;
  if (!optRange(bet.volume_at_bet,                        f.liqMin,   f.liqMax))   return false;
  if (!optRange(bet.bet_player_serve_quality_diff_s1,     f.sqS1Min,  f.sqS1Max))  return false;
  if (!optRange(bet.bet_player_serve_quality_diff_s2,     f.sqS2Min,  f.sqS2Max))  return false;
  const s1 = bet.bet_player_serve_quality_diff_s1, s2 = bet.bet_player_serve_quality_diff_s2;
  const chg = (s1 != null && s2 != null) ? (s2 - s1) : null;
  if (!optRange(chg,                                      f.sqChgMin, f.sqChgMax)) return false;
  // Per-strategy SQ-trigger override beats global; if neither set, no constraint.
  const stratOverride = _dqRange(bet.strategy_name);
  if (stratOverride) {
    const v = bet.bet_player_serve_quality_diff_trigger;
    if (v == null) return false;
    if (stratOverride.min != null && v < stratOverride.min) return false;
    if (stratOverride.max != null && v > stratOverride.max) return false;
  } else if (!optRange(bet.bet_player_serve_quality_diff_trigger, f.sqTrigMin, f.sqTrigMax)) {
    return false;
  }
  return true;
}

function _dqStats(arr) {
  const settled = arr.filter(b => b.pnl != null);
  const wins  = settled.filter(b => b.pnl > 0).length;
  const stake = settled.reduce((s, b) => s + (b.stake || 0), 0);
  const pnl   = settled.reduce((s, b) => s + (b.pnl   || 0), 0);
  return {
    bets:    arr.length,
    settled: settled.length,
    wins,
    sr:      settled.length ? (wins / settled.length) : null,
    pnl,
    roi:     stake > 0 ? (pnl / stake) : null,
  };
}

function _dqMaxDrawdown(bets) {
  // Walk bets in placement order, tracking running cumulative PnL.
  // Max drawdown = largest peak-to-trough drop. Returned as a negative
  // number (or 0 if no drawdown).
  const settled = bets
    .filter(b => b.pnl != null && b.placed_at)
    .slice()
    .sort((a, b) => String(a.placed_at).localeCompare(String(b.placed_at)));
  let cum = 0, peak = 0, maxDD = 0;
  for (const b of settled) {
    cum += b.pnl || 0;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

function _renderDeltaQualityStats() {
  const f = _dqStats(_dqFiltRows);
  const maxDD = _dqMaxDrawdown(_dqFiltRows);
  $('dq-tot-bets').textContent = f.bets;
  $('dq-tot-wins').textContent = f.wins;
  $('dq-tot-wr').textContent   = f.sr == null ? '—' : (f.sr * 100).toFixed(1) + '%';
  $('dq-tot-pnl').innerHTML    = `<span class="${pnlClass(f.pnl)}">${fmt.pnl(f.pnl)}</span>`;
  $('dq-tot-roi').textContent  = f.roi == null ? '—' : (f.roi * 100).toFixed(1) + '%';
  $('dq-tot-dd').innerHTML     = `<span class="${pnlClass(maxDD)}">${fmt.pnl(maxDD)}</span>`;

  // All-time unfiltered baseline row
  if (_dqAllTimeRows && _dqAllTimeRows.length) {
    const a = _dqStats(_dqAllTimeRows);
    const aDD = _dqMaxDrawdown(_dqAllTimeRows);
    $('dq-all-bets').textContent = a.bets;
    $('dq-all-wins').textContent = a.wins;
    $('dq-all-wr').textContent   = a.sr == null ? '—' : (a.sr * 100).toFixed(1) + '%';
    $('dq-all-pnl').innerHTML    = `<span class="${pnlClass(a.pnl)}">${fmt.pnl(a.pnl)}</span>`;
    $('dq-all-roi').textContent  = a.roi == null ? '—' : (a.roi * 100).toFixed(1) + '%';
    $('dq-all-dd').innerHTML     = `<span class="${pnlClass(aDD)}">${fmt.pnl(aDD)}</span>`;
  }
}

function _renderDeltaQualitySummary() {
  const byStrat = new Map();
  for (const bet of _dqBaseRows) {
    const name = bet.strategy_name || '—';
    if (!byStrat.has(name)) byStrat.set(name, { base: [], filt: [] });
    const e = byStrat.get(name);
    e.base.push(bet);
    if (_dqPasses(bet)) e.filt.push(bet);
  }
  const names = [...byStrat.keys()].sort(_naturalStratCompare);
  if (!names.length) {
    $('dq-summary-tbody').innerHTML = '<tr><td colspan="10" class="empty">No bets in period.</td></tr>';
    return;
  }

  const rangeLabel = (name) => {
    const r = _dqRange(name);
    if (!r) return '<span style="color:var(--muted)">none</span>';
    const fmtN = n => (n > 0 ? '+' : '') + n;
    return `${fmtN(r.min)} to ${fmtN(r.max)}`;
  };
  const pnlSpan = v => `<span class="${pnlClass(v)}">${fmt.pnl(v)}</span>`;
  const pct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';

  let totB = { bets: 0, settled: 0, wins: 0, pnl: 0, stake: 0 };
  let totF = { bets: 0, settled: 0, wins: 0, pnl: 0, stake: 0 };

  const html = names.map(name => {
    const { base, filt } = byStrat.get(name);
    const b = _dqStats(base);
    const f = _dqStats(filt);
    totB.bets += b.bets; totB.settled += b.settled; totB.wins += b.wins; totB.pnl += b.pnl;
    totB.stake += base.filter(x => x.pnl != null).reduce((s, x) => s + (x.stake || 0), 0);
    totF.bets += f.bets; totF.settled += f.settled; totF.wins += f.wins; totF.pnl += f.pnl;
    totF.stake += filt.filter(x => x.pnl != null).reduce((s, x) => s + (x.stake || 0), 0);
    return `<tr>
      <td><strong>${name}</strong></td>
      <td>${rangeLabel(name)}</td>
      <td>${b.bets}</td><td>${pct(b.sr)}</td><td>${pnlSpan(b.pnl)}</td><td>${pct(b.roi)}</td>
      <td>${f.bets}</td><td>${pct(f.sr)}</td><td>${pnlSpan(f.pnl)}</td><td>${pct(f.roi)}</td>
    </tr>`;
  }).join('');

  const totBSr = totB.settled ? totB.wins / totB.settled : null;
  const totBRoi = totB.stake > 0 ? totB.pnl / totB.stake : null;
  const totFSr = totF.settled ? totF.wins / totF.settled : null;
  const totFRoi = totF.stake > 0 ? totF.pnl / totF.stake : null;

  const totalRow = `<tr style="font-weight:700;border-top:2px solid var(--border)">
    <td>TOTAL</td><td></td>
    <td>${totB.bets}</td><td>${pct(totBSr)}</td><td>${pnlSpan(totB.pnl)}</td><td>${pct(totBRoi)}</td>
    <td>${totF.bets}</td><td>${pct(totFSr)}</td><td>${pnlSpan(totF.pnl)}</td><td>${pct(totFRoi)}</td>
  </tr>`;

  $('dq-summary-tbody').innerHTML = html + totalRow;
}

function _renderDeltaQualityBets() {
  const rows = _dqFiltRows;
  const pagEl = $('dq-bets-pagination');
  $('dq-bets-count').textContent = `${rows.length} filtered`;
  if (!rows.length) {
    $('dq-bets-tbody').innerHTML = '<tr><td colspan="16" class="empty">No filtered bets in period.</td></tr>';
    pagEl.style.display = 'none';
    return;
  }
  const sorted = [...rows].sort((a, b) => String(b.placed_at || '').localeCompare(String(a.placed_at || '')));
  const totalPages = Math.max(1, Math.ceil(sorted.length / DQ_PAGE_SIZE));
  if (_dqPage >= totalPages) _dqPage = totalPages - 1;
  const start = _dqPage * DQ_PAGE_SIZE;
  const pageRows = sorted.slice(start, start + DQ_PAGE_SIZE);

  $('dq-bets-tbody').innerHTML = pageRows.map(r => {
    const settled    = r.settlement_type;
    const statusBadge = settled ? badge(settled, r.pnl >= 0 ? 'green' : 'red') : badge('Open', 'yellow');
    const pnlHtml = r.pnl != null ? `<span class="${pnlClass(r.pnl)}">${fmt.pnl(r.pnl)}</span>` : '—';
    let scoreStr = '—';
    if (r.latest_sets) {
      try { scoreStr = score(JSON.parse(r.latest_sets)); } catch (_) {}
    }
    return `<tr>
      <td class="wrap"><strong>${r.match_name || '—'}</strong></td>
      <td class="score">${scoreStr}</td>
      <td>${r.strategy_name || '—'}</td>
      <td>${r.pnl > 0 ? `<span style="color:var(--green);font-weight:600">${r.player_name || '—'}</span>` : (r.pnl != null && r.pnl <= 0 ? `<span style="color:var(--red)">${r.player_name || '—'}</span>` : (r.player_name || '—'))}</td>
      <td>${r.side || '—'}</td>
      <td>${fmt.odds(r.requested_odds)}</td>
      <td>£${r.stake?.toFixed(2) || '—'}</td>
      <td>${pnlHtml}</td>
      <td>${statusBadge}</td>
      <td>${r.dry_run ? badge('DRY','yellow') : badge('LIVE','blue')}</td>
      <td>${r.momentum_at_bet != null ? (r.momentum_at_bet > 0 ? '+' : '') + r.momentum_at_bet.toFixed(0) : '—'}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_s1)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_s2)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_trigger)}</td>
      <td>${_sqDiffCell(r.bet_player_serve_quality_diff_match)}</td>
      <td>${fmt.date(r.placed_at)} ${fmt.ts(r.placed_at)}</td>
    </tr>`;
  }).join('');

  if (totalPages <= 1) { pagEl.style.display = 'none'; return; }
  pagEl.style.display = 'flex';
  const end = Math.min(start + DQ_PAGE_SIZE, sorted.length);
  pagEl.innerHTML = `
    <button class="btn btn-sm" id="dq-prev" ${_dqPage === 0 ? 'disabled' : ''}>‹ Prev</button>
    <span>Page ${_dqPage + 1} / ${totalPages} &nbsp;(${start + 1}–${end} of ${sorted.length})</span>
    <button class="btn btn-sm" id="dq-next" ${_dqPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>`;
  $('dq-prev').onclick = () => { _dqPage--; _renderDeltaQualityBets(); };
  $('dq-next').onclick = () => { _dqPage++; _renderDeltaQualityBets(); };
}

function exportDeltaQualityCsv() {
  if (!_dqFiltRows.length) return;
  const cols = [
    'placed_at','match_name','strategy_name','player_name','side','requested_odds','stake',
    'pnl','settlement_type','dry_run','hedge_odds',
    'bet_player_serve_quality_diff_s1','bet_player_serve_quality_diff_s2',
    'bet_player_serve_quality_diff_trigger','bet_player_serve_quality_diff_match',
  ];
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[,"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [cols.join(',')];
  for (const r of _dqFiltRows) lines.push(cols.map(c => esc(r[c])).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `delta-quality-bets-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function loadFilterLabPeriod() {
  const periodVal = $('fl-period').value;
  const since = periodVal === 'yesterday' ? '-2 days' : periodVal;
  const btn = $('fl-apply');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  try {
    const data = await api(`/api/db/bets?since=${encodeURIComponent(since)}&limit=2000`);
    let rows = data.bets || [];
    if (periodVal === 'yesterday') {
      const d = new Date(); d.setDate(d.getDate() - 1);
      const ymd = d.toISOString().slice(0, 10);
      rows = rows.filter(r => (r.placed_at || '').slice(0, 10) === ymd);
    }
    _flBaseRows = rows;
    // Populate strategy multi-select
    const names = [...new Set(rows.map(r => r.strategy_name).filter(Boolean))]
      .filter(n => !DELETED_STRATEGIES.has(n))
      .sort(_naturalStratCompare);
    const pop = $('fl-strategies-pop');
    pop.innerHTML = names.map(n => `
      <label><input type="checkbox" value="${n}" ${_flStrategies.has(n) ? 'checked' : ''}> ${n}</label>
    `).join('') || '<div style="color:var(--muted);font-size:12px">No strategies in period.</div>';
    pop.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) _flStrategies.add(cb.value);
      else _flStrategies.delete(cb.value);
      _updateFlStrategiesLabel();
    }));
    _updateFlStrategiesLabel();
    _renderFlStrategyDeltaGrid();
    runFilterLab();
  } catch (e) {
    console.error('Filter Lab load failed', e);
    alert('Filter Lab load failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Apply filters'; }
  }
}

function toggleFlStrategiesPop(e) {
  e.stopPropagation();
  const pop = $('fl-strategies-pop');
  if (pop.style.display === 'none' || !pop.style.display) {
    const r = $('fl-strategies').getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.top  = (r.bottom + 4) + 'px';
    pop.style.left = r.left + 'px';
    pop.style.display = 'block';
  } else {
    pop.style.display = 'none';
  }
}

function _updateFlStrategiesLabel() {
  const n = _flStrategies.size;
  $('fl-strategies').textContent = n === 0 ? 'All strategies' : n === 1 ? [..._flStrategies][0] : `${n} selected`;
}

// In-memory map: strategy → { min, max } | null. Lives alongside _flStrategies.
let _flStrategyDeltaRanges = {};

function _flReadFilters() {
  const num = id => { const v = $(id).value; return v === '' ? null : parseFloat(v); };
  // Read per-strategy overrides from the editor (skip entries where both are blank)
  const ranges = {};
  for (const [name, r] of Object.entries(_flStrategyDeltaRanges || {})) {
    if (r && (r.min != null || r.max != null)) ranges[name] = { min: r.min ?? null, max: r.max ?? null };
  }
  return {
    strategies: [..._flStrategies],
    side:       $('fl-side').value,
    betOn:      $('fl-bet-on').value,
    oddsMin:    num('fl-odds-min'), oddsMax: num('fl-odds-max'),
    edgeMin:    num('fl-edge-min'), edgeMax: num('fl-edge-max'),
    momMin:     num('fl-mom-min'),  momMax:  num('fl-mom-max'),
    liqMin:     num('fl-liq-min'),  liqMax:  num('fl-liq-max'),
    sqS1Min:    num('fl-sq-s1-min'),  sqS1Max:  num('fl-sq-s1-max'),
    sqS2Min:    num('fl-sq-s2-min'),  sqS2Max:  num('fl-sq-s2-max'),
    sqChgMin:   num('fl-sq-chg-min'), sqChgMax: num('fl-sq-chg-max'),
    sqTrigMin:  num('fl-sq-trig-min'),sqTrigMax:num('fl-sq-trig-max'),
    strategyDeltaRanges: ranges,
    surfaces:   ['hard','clay','grass'].filter(s => $('fl-surf-' + s).checked),
    tournament: $('fl-tournament').value.trim().toLowerCase(),
    mode:       $('fl-mode').value,
    status:     $('fl-status').value,
    period:     $('fl-period').value,
  };
}

function _flWriteFilters(f) {
  const set = (id, v) => { const el = $(id); if (el) el.value = v == null ? '' : v; };
  set('fl-period',      f.period || '-365 days');
  set('fl-side',        f.side || '');
  set('fl-bet-on',      f.betOn || '');
  set('fl-odds-min', f.oddsMin); set('fl-odds-max', f.oddsMax);
  set('fl-edge-min', f.edgeMin); set('fl-edge-max', f.edgeMax);
  set('fl-mom-min',  f.momMin);  set('fl-mom-max',  f.momMax);
  set('fl-liq-min',  f.liqMin);  set('fl-liq-max',  f.liqMax);
  set('fl-sq-s1-min', f.sqS1Min); set('fl-sq-s1-max', f.sqS1Max);
  set('fl-sq-s2-min', f.sqS2Min); set('fl-sq-s2-max', f.sqS2Max);
  set('fl-sq-chg-min',  f.sqChgMin);  set('fl-sq-chg-max',  f.sqChgMax);
  set('fl-sq-trig-min', f.sqTrigMin); set('fl-sq-trig-max', f.sqTrigMax);
  set('fl-tournament', f.tournament || '');
  set('fl-mode',   f.mode   || '');
  set('fl-status', f.status || '');
  const surfs = new Set(f.surfaces || ['hard','clay','grass']);
  $('fl-surf-hard').checked  = surfs.has('hard');
  $('fl-surf-clay').checked  = surfs.has('clay');
  $('fl-surf-grass').checked = surfs.has('grass');
  _flStrategies = new Set(f.strategies || []);
  _updateFlStrategiesLabel();
  _flStrategyDeltaRanges = { ...(f.strategyDeltaRanges || {}) };
  _renderFlStrategyDeltaGrid();
}

function _renderFlStrategyDeltaGrid() {
  const grid = $('fl-strat-sq-rows');
  if (!grid) return;
  // Build the list of strategies: union of period bets + any keys already in the overrides
  const fromBets = [...new Set((_flBaseRows || []).map(r => r.strategy_name).filter(Boolean))];
  const fromOver = Object.keys(_flStrategyDeltaRanges || {});
  const names    = [...new Set([...fromBets, ...fromOver])].sort(_naturalStratCompare);
  if (!names.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;font-size:11px;color:var(--muted)">No strategies in period yet — load some bets first.</div>';
    _updateFlStratSqStatus();
    return;
  }
  grid.innerHTML = names.map(n => {
    const r = _flStrategyDeltaRanges[n] || {};
    const min = r.min == null ? '' : r.min;
    const max = r.max == null ? '' : r.max;
    return `<div style="font-size:12px"><strong>${n}</strong></div>
      <input type="text" inputmode="decimal" data-strat="${n}" data-bound="min" value="${min}" placeholder="min" style="font-size:12px;padding:4px 6px">
      <input type="text" inputmode="decimal" data-strat="${n}" data-bound="max" value="${max}" placeholder="max" style="font-size:12px;padding:4px 6px">`;
  }).join('');
  grid.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', () => {
      const name = inp.dataset.strat;
      const bound = inp.dataset.bound;
      const val = inp.value.trim() === '' ? null : parseFloat(inp.value);
      _flStrategyDeltaRanges[name] = _flStrategyDeltaRanges[name] || {};
      _flStrategyDeltaRanges[name][bound] = (val == null || Number.isNaN(val)) ? null : val;
      if (_flStrategyDeltaRanges[name].min == null && _flStrategyDeltaRanges[name].max == null) {
        delete _flStrategyDeltaRanges[name];
      }
      _updateFlStratSqStatus();
    });
  });
  _updateFlStratSqStatus();
}

function _updateFlStratSqStatus() {
  const n = Object.keys(_flStrategyDeltaRanges || {}).length;
  const el = $('fl-strat-sq-status');
  if (el) el.textContent = n === 0 ? 'none' : `${n} strategy override${n === 1 ? '' : 's'}`;
}

// Build the row-passes function from a serialised filter state. Shared between
// Filter Lab (live editing) and Analysis (reads persisted state).
function _flBuildPassFn(f) {
  if (!f) return () => true;
  f = {
    strategies: [], surfaces: [], strategyDeltaRanges: {},
    ...f,
  };
  const inRange = (v, lo, hi) => (v == null) ? false : (lo == null || v >= lo) && (hi == null || v <= hi);
  const optRange = (v, lo, hi) => (lo == null && hi == null) ? true : inRange(v, lo, hi);
  return r => {
    if (f.strategies.length && !f.strategies.includes(r.strategy_name)) return false;
    if (f.side  && r.side       !== f.side)  return false;
    if (f.betOn && r.player_key !== f.betOn) return false;
    if (f.surfaces.length && r.surface && !f.surfaces.includes(r.surface)) return false;
    if (f.tournament && !(r.tournament || '').toLowerCase().includes(f.tournament)) return false;
    if (f.mode === 'live' && r.dry_run) return false;
    if (f.mode === 'dry'  && !r.dry_run) return false;
    if (f.status === 'open' && r.pnl != null) return false;
    if (f.status === 'win'  && !(r.pnl != null && r.pnl > 0)) return false;
    if (f.status === 'loss' && !(r.pnl != null && r.pnl <= 0)) return false;
    if (!optRange(r.requested_odds,            f.oddsMin,   f.oddsMax))   return false;
    if (!optRange(r.edge_at_bet,               f.edgeMin,   f.edgeMax))   return false;
    if (!optRange(r.momentum_at_bet,           f.momMin,    f.momMax))    return false;
    if (!optRange(r.volume_at_bet,             f.liqMin,    f.liqMax))    return false;
    if (!optRange(r.bet_player_serve_quality_diff_s1,      f.sqS1Min,   f.sqS1Max))   return false;
    if (!optRange(r.bet_player_serve_quality_diff_s2,      f.sqS2Min,   f.sqS2Max))   return false;
    const s1 = r.bet_player_serve_quality_diff_s1, s2 = r.bet_player_serve_quality_diff_s2;
    const chg = (s1 != null && s2 != null) ? (s2 - s1) : null;
    if (!optRange(chg,                                     f.sqChgMin,  f.sqChgMax))  return false;
    const stratOverride = (f.strategyDeltaRanges || {})[r.strategy_name];
    if (stratOverride && (stratOverride.min != null || stratOverride.max != null)) {
      if (!optRange(r.bet_player_serve_quality_diff_trigger, stratOverride.min, stratOverride.max)) return false;
    } else {
      if (!optRange(r.bet_player_serve_quality_diff_trigger, f.sqTrigMin, f.sqTrigMax)) return false;
    }
    return true;
  };
}

function runFilterLab() {
  const f = _flReadFilters();
  // Persist to server so all machines see the same current filter state.
  try {
    fetch('/api/filter-lab/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f),
    });
  } catch (_) {}

  const passes = _flBuildPassFn(f);
  _flFilteredRows = _flBaseRows.filter(passes);
  renderFlStats(_flBaseRows, _flFilteredRows);
  renderFlChart(_flBaseRows, _flFilteredRows);
}

function _flStatsForRows(rows) {
  const settled = rows.filter(r => r.pnl != null);
  const wins = settled.filter(r => r.pnl > 0).length;
  const pnl  = settled.reduce((s, r) => s + r.pnl, 0);
  const stk  = settled.reduce((s, r) => s + (r.stake || 0), 0);
  const oddsRows = rows.filter(r => r.requested_odds);
  const odds = oddsRows.reduce((s, r) => s + r.requested_odds, 0) / Math.max(1, oddsRows.length);
  const stakedRows = rows.filter(r => r.stake);
  const avgStake = stakedRows.reduce((s, r) => s + r.stake, 0) / Math.max(1, stakedRows.length);
  const sorted = [...settled].sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at));
  let cum = 0, peak = 0, worstDD = 0;
  for (const r of sorted) {
    cum += r.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > worstDD) worstDD = dd;
  }
  return {
    bets:    rows.length,
    settled: settled.length,
    wr:      settled.length ? (wins / settled.length * 100) : null,
    pnl,
    roi:     stk > 0 ? (pnl / stk * 100) : null,
    odds:    rows.length ? odds : null,
    dd:      worstDD,
    stake:   stakedRows.length ? avgStake : null,
  };
}

function _flStats(rows) {
  // Split by BFBM go-live boundary so the headline numbers also expose how
  // the pre-era ("paper") and post-era ("live BFBM") slices compare.
  const lineMs = new Date(FL_LINE_IN_SAND + 'T00:00:00Z').getTime();
  const pre  = [], post = [];
  for (const r of rows) {
    if (!r.placed_at) { pre.push(r); continue; }
    (new Date(r.placed_at).getTime() < lineMs ? pre : post).push(r);
  }
  const overall = _flStatsForRows(rows);
  overall.pre   = _flStatsForRows(pre);
  overall.post  = _flStatsForRows(post);
  return overall;
}

function _flDelta(v, base, decimals = 2, signed = true) {
  if (v == null || base == null) return '';
  const d = v - base;
  if (Math.abs(d) < 0.005 && decimals < 2) return '';
  const txt = (signed && d >= 0 ? '+' : '') + d.toFixed(decimals);
  const cls = d > 0 ? 'pos' : d < 0 ? 'neg' : 'neu';
  return `<span class="delta ${cls}">(${txt})</span>`;
}

function _flEraPill(label, era, cls) {
  const pnlSigned = (era.pnl >= 0 ? '+' : '-') + '£' + Math.abs(era.pnl).toFixed(2);
  const pnlCls    = era.pnl > 0 ? 'pos' : era.pnl < 0 ? 'neg' : 'neu';
  return `<div class="fl-era-pill ${cls}">
    <span class="era-label">${label}</span>
    <span class="era-stats">${era.bets} bets · <span class="${pnlCls}">${pnlSigned}</span></span>
  </div>`;
}

function renderFlStats(baseRows, filtRows) {
  const b = _flStats(baseRows), f = _flStats(filtRows);
  $('fl-base-sub').textContent = `${baseRows.length} bets, period ${$('fl-period').value}`;
  $('fl-filt-sub').textContent = `${filtRows.length} of ${baseRows.length} bets pass`;
  // Era split — visually separates historic ("paper") bets from post-BFBM-go-live ones.
  $('fl-base-era').innerHTML =
    _flEraPill(`Pre BFBM (< ${FL_LINE_IN_SAND})`, b.pre, 'pre') +
    _flEraPill(`Post BFBM (≥ ${FL_LINE_IN_SAND})`, b.post, 'post');
  $('fl-filt-era').innerHTML =
    _flEraPill(`Pre BFBM (< ${FL_LINE_IN_SAND})`, f.pre, 'pre') +
    _flEraPill(`Post BFBM (≥ ${FL_LINE_IN_SAND})`, f.post, 'post');
  $('fl-base-bets').innerHTML    = b.bets;
  $('fl-base-settled').innerHTML = b.settled;
  $('fl-base-wr').innerHTML      = b.wr == null ? '—' : b.wr.toFixed(1);
  $('fl-base-pnl').innerHTML     = b.pnl.toFixed(2);
  $('fl-base-roi').innerHTML     = b.roi == null ? '—' : b.roi.toFixed(1);
  $('fl-base-odds').innerHTML    = b.odds == null ? '—' : b.odds.toFixed(2);
  $('fl-base-dd').innerHTML      = b.dd > 0 ? '-' + b.dd.toFixed(2) : '—';
  $('fl-base-stake').innerHTML   = b.stake == null ? '—' : b.stake.toFixed(2);

  $('fl-filt-bets').innerHTML    = f.bets    + _flDelta(f.bets, b.bets, 0);
  $('fl-filt-settled').innerHTML = f.settled + _flDelta(f.settled, b.settled, 0);
  $('fl-filt-wr').innerHTML      = (f.wr == null ? '—' : f.wr.toFixed(1))  + _flDelta(f.wr, b.wr);
  $('fl-filt-pnl').innerHTML     = f.pnl.toFixed(2) + _flDelta(f.pnl, b.pnl);
  $('fl-filt-roi').innerHTML     = (f.roi == null ? '—' : f.roi.toFixed(1)) + _flDelta(f.roi, b.roi);
  $('fl-filt-odds').innerHTML    = (f.odds == null ? '—' : f.odds.toFixed(2)) + _flDelta(f.odds, b.odds);
  // For drawdown a lower number is BETTER, so invert the sign for the delta colour.
  $('fl-filt-dd').innerHTML      = (f.dd > 0 ? '-' + f.dd.toFixed(2) : '—') + _flDelta(b.dd, f.dd, 2);
  $('fl-filt-stake').innerHTML   = (f.stake == null ? '—' : f.stake.toFixed(2)) + _flDelta(f.stake, b.stake);
}

// BFBM go-live boundary — bets placed at/after this date are the "after BFBM" era.
const FL_LINE_IN_SAND = '2026-05-21';

let _flChart = null;

function _flCumPoints(rows) {
  // Settled bets only, chronologically; emit { x: ms, y: cumPnl } per bet.
  const settled = rows.filter(r => r.pnl != null && r.placed_at)
    .sort((a, b) => new Date(a.placed_at) - new Date(b.placed_at));
  let cum = 0;
  return settled.map(r => {
    cum += r.pnl;
    return { x: new Date(r.placed_at).getTime(), y: Number(cum.toFixed(2)) };
  });
}

function _flFmtDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

function renderFlChart(baseRows, filtRows) {
  const canvas = $('fl-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const basePts = _flCumPoints(baseRows);
  const filtPts = _flCumPoints(filtRows);

  if (_flChart) { _flChart.destroy(); _flChart = null; }

  // Pick the chart's x-axis bounds from the union of both series so the
  // vertical "BFBM go-live" line sits in the right place even if one side
  // has no data after that date yet.
  const allTs = [...basePts, ...filtPts].map(p => new Date(p.x).getTime());
  const minMs = allTs.length ? Math.min(...allTs) : Date.now() - 30 * 24 * 3600 * 1000;
  const maxMs = allTs.length ? Math.max(...allTs, Date.now()) : Date.now();
  const lineMs = new Date(FL_LINE_IN_SAND + 'T00:00:00Z').getTime();

  _flChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'Unfiltered cum P&L',
          data: basePts,
          borderColor: '#58a6ff',
          backgroundColor: 'rgba(88,166,255,.08)',
          borderWidth: 2,
          fill: false,
          tension: 0.15,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
        {
          label: 'Filtered cum P&L',
          data: filtPts,
          borderColor: '#f0883e',
          backgroundColor: 'rgba(240,136,62,.08)',
          borderWidth: 2,
          fill: false,
          tension: 0.15,
          pointRadius: 0,
          pointHoverRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: true, labels: { color: '#8892a4', boxWidth: 12, padding: 12 } },
        tooltip: {
          callbacks: {
            title: items => new Date(items[0].parsed.x).toLocaleString('en-GB'),
            label: it => `${it.dataset.label}: ${(it.parsed.y >= 0 ? '+' : '-')}£${Math.abs(it.parsed.y).toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: minMs, max: maxMs,
          grid: { color: 'rgba(46,50,80,.4)' },
          ticks: {
            color: '#8892a4',
            maxTicksLimit: 10,
            callback: v => _flFmtDate(v),
          },
        },
        y: {
          grid: { color: 'rgba(46,50,80,.4)' },
          ticks: {
            color: '#8892a4',
            callback: v => (v >= 0 ? '+£' : '-£') + Math.abs(v).toFixed(0),
          },
        },
      },
    },
    plugins: [{
      id: 'lineInSand',
      afterDatasetsDraw(chart) {
        if (lineMs < chart.scales.x.min || lineMs > chart.scales.x.max) return;
        const c = chart.ctx;
        const x = chart.scales.x.getPixelForValue(lineMs);
        const top = chart.chartArea.top, bot = chart.chartArea.bottom;
        const left = chart.chartArea.left, right = chart.chartArea.right;
        c.save();
        // Subtle tinted band over the post-BFBM era for instant visual split
        c.fillStyle = 'rgba(227,179,65,.05)';
        c.fillRect(x, top, right - x, bot - top);
        // Strong vertical line
        c.strokeStyle = '#e3b341';
        c.setLineDash([6, 4]);
        c.lineWidth = 2;
        c.beginPath(); c.moveTo(x, top); c.lineTo(x, bot); c.stroke();
        c.setLineDash([]);
        // Label with arrow on the post side
        c.fillStyle = '#e3b341';
        c.font = 'bold 11px Inter, system-ui, sans-serif';
        c.fillText('▶ BFBM go-live ' + FL_LINE_IN_SAND, x + 6, top + 14);
        // Era labels at the bottom (Historic ← | → BFBM era)
        c.font = '10px Inter, system-ui, sans-serif';
        c.fillStyle = '#8892a4';
        c.fillText('◀ Historic (paper)', Math.max(left + 8, x - 130), bot - 6);
        c.fillStyle = '#e3b341';
        c.fillText('BFBM era ▶', x + 8, bot - 6);
        c.restore();
      },
    }],
  });
}

function resetFilterLab() {
  _flStrategies.clear();
  const defaults = { period: '-365 days', surfaces: ['hard','clay','grass'] };
  _flWriteFilters(defaults);
  try {
    fetch('/api/filter-lab/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defaults),
    });
  } catch (_) {}
  loadFilterLabPeriod();
}

async function restoreFilterLabFilters() {
  try {
    const f = await fetch('/api/filter-lab/state').then(r => r.json());
    if (f && typeof f === 'object') {
      if (Array.isArray(f.strategies)) {
        _flStrategies = new Set(f.strategies);
      }
      _flWriteFilters(f);
    }
  } catch (_) {}
}

let _flPresetsCache = {};

async function saveFilterLabPreset() {
  const presets = _flPresetsCache;
  const existing = Object.keys(presets).sort();
  let name;
  if (existing.length === 0) {
    name = prompt('Preset name:');
  } else {
    const list = existing.map((n, i) => `  ${i + 1}. ${n}`).join('\n');
    const reply = prompt(
      `Save as preset.\n\nType a new name to create, OR the number of an existing preset to OVERWRITE it:\n\n${list}\n\nOr type the existing name exactly to overwrite.`,
      ''
    );
    if (reply == null || !reply.trim()) return;
    const trimmed = reply.trim();
    const asNum = parseInt(trimmed, 10);
    if (!isNaN(asNum) && asNum >= 1 && asNum <= existing.length && String(asNum) === trimmed) {
      name = existing[asNum - 1];
      if (!confirm(`Overwrite preset "${name}" with current filters?`)) return;
    } else if (existing.includes(trimmed)) {
      if (!confirm(`A preset named "${trimmed}" already exists. Overwrite it?`)) return;
      name = trimmed;
    } else {
      name = trimmed;
    }
  }
  if (!name) return;
  try {
    const r = await fetch('/api/filter-lab/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, filters: _flReadFilters() }),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    _flPresetsCache = r.presets || {};
    refreshFilterLabPresetList();
  } catch (e) {
    alert('Save preset failed: ' + e.message);
  }
}

async function _flLoadPresets() {
  try {
    const r = await fetch('/api/filter-lab/presets').then(r => r.json());
    _flPresetsCache = r || {};
    return _flPresetsCache;
  } catch (_) { return _flPresetsCache; }
}

async function refreshFilterLabPresetList() {
  const presets = await _flLoadPresets();
  const names = Object.keys(presets).sort();
  const builtIn = `<option value="__delta_quality__">${DQ_PRESET_NAME} (per-strategy SQ delta)</option>`;
  $('fl-load-preset').innerHTML = '<option value="">— Load preset… —</option>' +
    builtIn +
    names.map(n => `<option value="${n}">${n}</option>`).join('');
}

async function loadFilterLabPreset(name) {
  $('fl-load-preset').value = '';
  if (name === '__delta_quality__') {
    // Built-in: pull the JSON and populate the per-strategy override grid.
    try {
      const preset = await api('/api/delta-quality/preset');
      const ranges = {};
      for (const [strat, r] of Object.entries(preset.ranges || {})) {
        if (r && (r.min != null || r.max != null)) ranges[strat] = { min: r.min ?? null, max: r.max ?? null };
      }
      // Apply ONLY the per-strategy ranges; leave global filters untouched.
      _flStrategyDeltaRanges = ranges;
      // Open the editor so user immediately sees what got loaded.
      $('fl-strat-sq-grid').style.display = '';
      $('fl-strat-sq-chev').textContent  = '▼ hide';
      _renderFlStrategyDeltaGrid();
      runFilterLab();
    } catch (e) {
      alert('Failed to load Delta Quality preset: ' + e.message);
    }
    return;
  }
  const f = _flPresetsCache[name];
  if (!f) return;
  _flWriteFilters(f);
  loadFilterLabPeriod();
}

async function refreshBfbmFilterStatus() {
  try {
    const f = await api('/api/bfbm-filter');
    const el = $('fl-bfbm-status');
    if (!el) return;
    if (!f) {
      el.textContent = 'BFBM filter: none (all signals export)';
      el.style.color = 'var(--muted)';
    } else {
      const t = f.savedAt ? new Date(f.savedAt).toLocaleString('en-GB') : 'unknown';
      el.textContent = `BFBM filter: ACTIVE · saved ${t}`;
      el.style.color = 'var(--green)';
    }
  } catch (_) {}
}

async function saveAsBfbmFilter() {
  const f = _flReadFilters();
  if (!confirm(`Save these filter criteria as the BFBM gate?\n\nFrom now until you clear it, ONLY strategy signals matching this filter will be written to bfbm-signals.csv. Other signals will be logged but skipped.`)) return;
  try {
    const r = await fetch('/api/bfbm-filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(f),
    }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    await refreshBfbmFilterStatus();
    alert('BFBM filter saved. New signals will be gated against this profile.');
  } catch (e) {
    alert('Save failed: ' + e.message);
  }
}

async function clearBfbmFilter() {
  if (!confirm('Clear the BFBM filter? Every fresh signal will then be written to bfbm-signals.csv (no gating).')) return;
  try {
    const r = await fetch('/api/bfbm-filter', { method: 'DELETE' }).then(r => r.json());
    if (r.error) throw new Error(r.error);
    await refreshBfbmFilterStatus();
  } catch (e) {
    alert('Clear failed: ' + e.message);
  }
}

function exportFilterLabCsv() {
  if (!_flFilteredRows.length) { alert('No filtered bets to export.'); return; }
  const cols = [
    ['Bet ID', 'bet_id'],
    ['Match', 'match_name'],
    ['Surface', 'surface'],
    ['Tournament', 'tournament'],
    ['Strategy', 'strategy_name'],
    ['Sub-Strategy', 'sub_strategy'],
    ['Player Key', 'player_key'],
    ['Bet Player Name', 'player_name'],
    ['Bet Side', 'side'],
    ['Requested Odds', 'requested_odds'],
    ['Actual Matched Odds', 'actual_odds'],
    ['Stake (£)', 'stake'],
    ['Size Matched (£)', 'size_matched'],
    ['Liability (£)', 'liability'],
    ['Profit/Loss (£)', 'pnl'],
    ['Momentum at Bet', 'momentum_at_bet'],
    ['Edge at Bet (pp)', 'edge_at_bet'],
    ['Matched Volume at Bet (£)', 'volume_at_bet'],
    ['Settlement Type', 'settlement_type'],
    ['Dry Run', 'dry_run'],
    ['Hedge Odds', 'hedge_odds'],
    ['Betfair Market ID', 'betfair_market_id'],
    ['Placed At', 'placed_at'],
    ['Settled At', 'settled_at'],
    ['Reason', 'reason'],
    ['Bet−Opp SQ Δ S1', 'bet_player_serve_quality_diff_s1'],
    ['Bet−Opp SQ Δ S2', 'bet_player_serve_quality_diff_s2'],
    ['Bet−Opp SQ Δ Trigger', 'bet_player_serve_quality_diff_trigger'],
    ['Bet−Opp SQ Δ Match', 'bet_player_serve_quality_diff_match'],
  ];
  const esc = v => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const header = cols.map(c => c[0]).join(',');
  const body = _flFilteredRows.map(r => cols.map(c => esc(r[c[1]])).join(',')).join('\n');
  const blob = new Blob(['﻿', header + '\n' + body], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `filter-lab-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initLiveTab();
  initBetsTab();
  initFilterLab();
  initAnalysisTab();
  initEntryData();
  initStrategiesTab();
  initAiTab();
  initExceptionsTab();
  initSystemTab();
  initHedgeCalc();

  connectWs();

  // Sync DB-based summary every 30s regardless of WebSocket
  syncDbSummary();
  setInterval(syncDbSummary, 30_000);

  // Initial data loads for the active (live) tab
  updateLiveStats();
  loadSignalsToday();
  // Pre-load strategies so the Live panel can render "missed-window" badges
  // (orange = trigger set already complete) without waiting for the user to
  // open the Strategies tab first.
  loadStrategies();
});
