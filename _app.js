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

let _sortBets   = { col: 'placed_at', dir: -1 };
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
      if (btn.dataset.tab === 'bets')       loadBets();
      if (btn.dataset.tab === 'analysis')   loadAnalysis();
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

    // Strategy column: if there's an open bet show its strategy, otherwise qualifying strategies
    let stratBadge;
    if (openPos?.strategyName) {
      stratBadge = badge(openPos.strategyName, 'green');
    } else if (qualSys.length) {
      stratBadge = qualSys.map(s => badge(s, 'blue')).join(' ');
    } else {
      stratBadge = badge('None', 'gray');
    }

    // Bet column: side + player + strategy label
    let betBadge = '';
    if (openPos) {
      const sideLabel = `${openPos.side}${openPos.playerKey ? ' ' + openPos.playerKey : ''}`;
      const stratLabel = openPos.strategyName ? `<span style="font-size:9px;opacity:.8"> · ${openPos.strategyName}</span>` : '';
      betBadge = `<span class="badge badge-yellow">${sideLabel}${stratLabel}</span>`;
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

  try {
    // Use cached snapshots if fresh enough (avoids re-fetching on every 5s tbody rebuild)
    const now    = Date.now();
    const cached = _snapCache.get(marketId);
    let snaps;
    if (cached && now - cached.loadedAt < SNAP_CACHE_TTL) {
      snaps = cached.snaps;
    } else {
      const since = new Date(now - 4 * 3600 * 1000).toISOString();
      snaps = await api(`/api/db/markets/${marketId}/snapshots?since=${encodeURIComponent(since)}`);
      _snapCache.set(marketId, { snaps, loadedAt: now });
    }
    if (!snaps.length) return;

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
  } catch (_) {}
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
      api(`/api/db/markets/${marketId}/snapshots?since=${encodeURIComponent(new Date(Date.now() - 4*3600*1000).toISOString())}`),
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
    html += `<div class="detail-section">
      <h4>Serve Stats</h4>
      <table style="width:100%;font-size:12px">
        <thead><tr><th style="text-align:left">Stat</th><th>${nA || 'P1'}</th><th>${nB || 'P2'}</th></tr></thead>
        <tbody>
          <tr><td>1st In (match)</td><td>${fmt.pct(ssA.firstServeIn)}</td><td>${fmt.pct(ssB.firstServeIn)}</td></tr>
          <tr><td>1st Won (match)</td><td>${fmt.pct(ssA.firstServeWon)}</td><td>${fmt.pct(ssB.firstServeWon)}</td></tr>
          <tr><td>2nd Won (match)</td><td>${fmt.pct(ssA.secondServeWon)}</td><td>${fmt.pct(ssB.secondServeWon)}</td></tr>
          <tr><td>DFs (match)</td><td>${ssA.doubleFaults ?? '—'}</td><td>${ssB.doubleFaults ?? '—'}</td></tr>
          <tr><td>1st In (set 1)</td><td>${fmt.pct(s1A.firstServeIn)}</td><td>${fmt.pct(s1B.firstServeIn)}</td></tr>
          <tr><td>1st Won (set 1)</td><td>${fmt.pct(s1A.firstServeWon)}</td><td>${fmt.pct(s1B.firstServeWon)}</td></tr>
          <tr><td>DFs (set 1)</td><td>${s1A.doubleFaults ?? '—'}</td><td>${s1B.doubleFaults ?? '—'}</td></tr>
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
    <h4>Odds History (last 4h)</h4>
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
async function loadBets() {
  const since    = $('bets-period').value;
  const strategy = $('bets-strategy').value;
  const status   = $('bets-status').value;

  $('bets-tbody').innerHTML = '<tr><td colspan="13" class="empty"><span class="spinner"></span> Loading…</td></tr>';

  try {
    const [data, perfData] = await Promise.all([
      api(`/api/db/bets?since=${encodeURIComponent(since)}&limit=1000${strategy ? '&strategy=' + encodeURIComponent(strategy) : ''}`),
      api('/api/db/bets/performance'),
    ]);

    let rows = data.bets || [];

    // Client-side filters
    if (status === 'open')  rows = rows.filter(r => !r.settled_at);
    if (status === 'win')   rows = rows.filter(r => r.pnl != null && r.pnl > 0);
    if (status === 'loss')  rows = rows.filter(r => r.pnl != null && r.pnl < 0);

    S.bets = rows;
    S.performance = perfData;

    renderBetsTable(rows);
    renderBetStats(rows);
    renderBetPerfStats(perfData);
    renderBetStratCharts(rows);

    // Populate strategy filter once
    if ($('bets-strategy').options.length <= 1) {
      const names = [...new Set(perfData.map(p => p.strategy_name).filter(Boolean))];
      names.forEach(n => {
        const o = new Option(n, n);
        $('bets-strategy').add(o);
        $('live-strategy').add(new Option(n, n));
        $('strat-refresh'); // will be populated later
      });
    }
  } catch (e) {
    $('bets-tbody').innerHTML = `<tr><td colspan="13" class="empty">Error: ${e.message}</td></tr>`;
  }
}

function renderBetsTable(rows) {
  if (!rows.length) {
    $('bets-tbody').innerHTML = '<tr><td colspan="13" class="empty">No bets found</td></tr>';
    return;
  }
  const { col, dir } = _sortBets;
  rows = [...rows].sort((a, b) => dir * (String(b[col] || '') > String(a[col] || '') ? 1 : -1));

  $('bets-tbody').innerHTML = rows.map((r, i) => {
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

    return `<tr class="bet-row" data-betidx="${i}" style="cursor:pointer">
      <td class="wrap"><strong>${r.match_name || '—'}</strong></td>
      <td class="score">${scoreStr}</td>
      <td>${r.strategy_name || '—'}</td>
      <td>${r.player_name || '—'}</td>
      <td>${r.side || '—'}</td>
      <td>${fmt.odds(r.requested_odds)}</td>
      <td>£${r.stake?.toFixed(2) || '—'}</td>
      <td>${pnlHtml}</td>
      <td>${statusBadge}</td>
      <td>${r.dry_run ? badge('DRY','yellow') : badge('LIVE','blue')}</td>
      <td>${r.hedge_odds != null ? fmt.odds(r.hedge_odds) : '—'}</td>
      <td>${fmt.date(r.placed_at)} ${fmt.ts(r.placed_at)}</td>
      <td><button class="del-bet-btn" data-betid="${r.bet_id}" title="Delete bet" onclick="event.stopPropagation();deleteTennisBet('${r.bet_id}')">✕</button></td>
    </tr>
    <tr class="bet-detail-row" id="bet-detail-${i}" style="display:none">
      <td colspan="13" style="padding:0"></td>
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
        const r = rows[idx];
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
  ['bets-period','bets-strategy','bets-status'].forEach(id => {
    $(id).addEventListener('change', loadBets);
  });
  $('bets-refresh').addEventListener('click', loadBets);
  $('bets-clear').addEventListener('click', clearBetHistory);

  $('bets-export').addEventListener('click', () => {
    const headers = ['bet_id','match_name','strategy_name','player_name','side','requested_odds','stake','pnl','settlement_type','dry_run','placed_at','settled_at','reason'];
    const csv = [headers.join(','), ...S.bets.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = `bets-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
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
      const names = [...new Set(perf.map(p => p.strategy_name).filter(Boolean))];
      names.forEach(n => {
        $('bets-strategy').add(new Option(n, n));
        $('live-strategy').add(new Option(n, n));
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

          <!-- Serve Quality Score Filter -->
          <div style="grid-column:1/-1;margin-top:10px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:8px 0 6px;border-top:1px solid var(--border)">
              Serve Quality Score Filter (optional — composite 0–100 score from set serve stats)
            </div>
            <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
              Scores each player's set serve stats: 1st serve in/won, 2nd serve won, aces, double faults.
              Pass=20pts each, Warn=10pts, Fail=0pts → max 100.
              <strong style="color:var(--text)">Winner</strong> = player who won the set (lay target).
              <strong style="color:var(--text)">Loser</strong> = player who lost.
              <strong style="color:var(--text)">Differential</strong> = loser−winner (positive = fav served well, market overreacted).
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
              <div class="edit-field">
                <label>Min winner score (0–100)</label>
                <input type="number" id="s${i}-sqf-winner" value="${sys.backtest?.serveQualityFilter?.minWinnerScore ?? ''}"
                  step="5" min="0" max="100" placeholder="e.g. 65 (winner ran hot)"
                  oninput="queueStratSave(${i})">
              </div>
              <div class="edit-field">
                <label>Min loser score (0–100)</label>
                <input type="number" id="s${i}-sqf-loser" value="${sys.backtest?.serveQualityFilter?.minLoserScore ?? ''}"
                  step="5" min="0" max="100" placeholder="e.g. 50 (loser competitive)"
                  oninput="queueStratSave(${i})">
              </div>
              <div class="edit-field">
                <label>Min differential (loser−winner)</label>
                <input type="number" id="s${i}-sqf-diff" value="${sys.backtest?.serveQualityFilter?.minDifferential ?? ''}"
                  step="5" min="-100" max="100" placeholder="e.g. 0 (fav ≥ underdog)"
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

    // Serve quality score filter
    const sqfWinner = parseFloat(gv('sqf-winner')) || null;
    const sqfLoser  = parseFloat(gv('sqf-loser'))  || null;
    const sqfDiff   = gv('sqf-diff') !== '' && gv('sqf-diff') != null ? parseFloat(gv('sqf-diff')) : null;
    const serveQualityFilter = (sqfWinner !== null || sqfLoser !== null || sqfDiff !== null)
      ? {
          ...(sqfWinner !== null ? { minWinnerScore: sqfWinner } : {}),
          ...(sqfLoser  !== null ? { minLoserScore:  sqfLoser  } : {}),
          ...(sqfDiff   !== null ? { minDifferential: sqfDiff  } : {}),
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
  if (!daily.length) { $('an-daily-tbody').innerHTML = '<tr><td colspan="6" class="empty">No data</td></tr>'; return; }
  let cum = 0;
  const rows = [...daily].reverse();
  $('an-daily-tbody').innerHTML = rows.map(d => {
    cum += d.pnl || 0;
    const wr = d.bets ? ((d.wins || 0) / d.bets * 100) : 0;
    return `<tr>
      <td>${d.day}</td>
      <td>${d.bets}</td>
      <td>${d.wins || 0}</td>
      <td>${d.bets ? fmt.pct(wr) : '—'}</td>
      <td class="${pnlClass(d.pnl)}">${fmt.pnl(d.pnl)}</td>
      <td class="${pnlClass(cum)}">${fmt.pnl(cum)}</td>
    </tr>`;
  }).join('');
}

function renderAnalysisChart() {
  const ctx = $('an-chart').getContext('2d');
  if (_anChart) { _anChart.destroy(); _anChart = null; }
  const titleEl = $('an-chart-title');

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

function renderAnalysisBets(bets) {
  const tbody  = $('an-bets-tbody');
  const badge_ = $('an-bets-count');
  const recent = [...bets].sort((a, b) => (b.placed_at || '') > (a.placed_at || '') ? 1 : -1).slice(0, 100);

  if (badge_) { badge_.textContent = bets.length; badge_.style.display = ''; }

  if (!recent.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">No bets in this period</td></tr>';
    return;
  }

  tbody.innerHTML = recent.map((r, i) => {
    const settled = r.settlement_type;
    const liveMatch = S.liveMatches.find(m => m.betfairMarketId === r.betfair_market_id);
    const isMatchOver = !settled && !liveMatch && r.latest_sets;
    const statusBadge = settled
      ? badge(settled, r.pnl >= 0 ? 'green' : 'red')
      : isMatchOver ? badge('Finished', 'blue') : badge('Open', 'yellow');
    const pnlHtml = r.pnl != null ? `<span class="${pnlClass(r.pnl)}">${fmt.pnl(r.pnl)}</span>` : '—';
    return `<tr class="an-bet-row" data-betidx="${i}" style="cursor:pointer">
      <td class="wrap"><strong>${r.match_name || '—'}</strong></td>
      <td>${r.strategy_name || '—'}</td>
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
    const counts = [];
    if (s.aces != null) counts.push(`${s.aces}a`);
    if (s.dfs  != null) counts.push(`${s.dfs}df`);
    if (s.bpWon != null) counts.push(`${s.bpWon}%bp`);
    const line1 = parts.join(' / ');
    const line2 = counts.join(' ');
    return `<span class="entry-serve-cell">${line1}${line2 ? `<br>${line2}` : ''}</span>`;
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
              <th rowspan="2">Result</th>
            </tr>
            <tr>
              <th>1st% / 1stW% / 2ndW% · Ac DF BP%</th>
              <th>1st% / 1stW% / 2ndW% · Ac DF BP%</th>
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

function copyEntryDataCsv() {
  if (!_entryData) return;
  const header = 'Strategy,Date,Match,Surface,SetScore,PreMatchA,PreMatchB,EntryOdds,Side,BetPlayer,DryRun,' +
    'P1_1stIn,P1_1stWon,P1_2ndWon,P1_Aces,P1_DFs,P1_BPWon,' +
    'P2_1stIn,P2_1stWon,P2_2ndWon,P2_Aces,P2_DFs,P2_BPWon,' +
    'Outcome,PnL';
  const lines = [header];
  for (const [strat, bets] of Object.entries(_entryData)) {
    for (const b of bets) {
      const date = b.placedAt ? new Date(b.placedAt).toLocaleDateString('en-GB') : '';
      const s = (v) => v != null ? v : '';
      const sa = b.serveSet1A || {};
      const sb = b.serveSet1B || {};
      const betPlayer = b.playerKey === 'A' ? (b.playerAName || 'P1') : (b.playerBName || 'P2');
      lines.push([
        strat,
        date,
        `"${(b.matchName||'').replace(/"/g,'""')}"`,
        b.surface || '',
        b.triggerSetScore || '',
        s(b.preMatchA), s(b.preMatchB),
        s(b.entryOdds), b.side || '', betPlayer, b.dryRun ? 'Y' : 'N',
        s(sa.firstIn), s(sa.firstWon), s(sa.secondWon), s(sa.aces), s(sa.dfs), s(sa.bpWon),
        s(sb.firstIn), s(sb.firstWon), s(sb.secondWon), s(sb.aces), s(sb.dfs), s(sb.bpWon),
        b.outcome, s(b.pnl),
      ].join(','));
    }
  }
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const btn = $('an-entry-csv-btn');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 2000);
  });
}

function initEntryData() {
  $('an-entry-load-btn').addEventListener('click', loadEntryData);
  $('an-entry-csv-btn').addEventListener('click', copyEntryDataCsv);
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
  tbody.innerHTML = '<tr><td colspan="10" class="empty"><span class="spinner"></span> Loading…</td></tr>';
  $('an-scanner-pagination').style.display = 'none';
  try {
    _scannerRows = await api('/api/db/market-scanner');
    _scannerPage = 0;
    renderScannerPage();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty">Error: ${e.message}</td></tr>`;
  }
}

function renderScannerPage() {
  const tbody = $('an-scanner-tbody');
  const pagEl = $('an-scanner-pagination');
  if (!tbody) return;

  if (!_scannerRows.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No completed matches over £100k found yet</td></tr>';
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
    return `<tr>
      <td style="white-space:nowrap">${d}</td>
      <td class="wrap"><strong>${r.match_name || '—'}</strong>${r.surface ? ` <span style="font-size:10px;color:var(--muted)">${r.surface}</span>` : ''}</td>
      <td>${r.pre_match_odds_a != null ? r.pre_match_odds_a.toFixed(2) : '—'}</td>
      <td>${r.pre_match_odds_b != null ? r.pre_match_odds_b.toFixed(2) : '—'}</td>
      <td>${r.s1_end_odds_a != null ? r.s1_end_odds_a.toFixed(2) : '—'}</td>
      <td>${r.s1_end_odds_b != null ? r.s1_end_odds_b.toFixed(2) : '—'}</td>
      <td>${r.s2_end_odds_a != null ? r.s2_end_odds_a.toFixed(2) : '—'}</td>
      <td>${r.s2_end_odds_b != null ? r.s2_end_odds_b.toFixed(2) : '—'}</td>
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
    return `<tr${m.inPlay ? ' style="background:rgba(74,222,128,0.06)"' : ''}>
      <td class="wrap"><strong>${m.matchName || '—'}</strong></td>
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
