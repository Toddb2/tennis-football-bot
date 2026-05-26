#!/usr/bin/env node
'use strict';

/**
 * fitMomentumWeights.js
 *
 * Fits the weights in src/algorithm/momentumDetector.js (W.*) against
 * historical snapshots that have momentum_features captured.
 *
 * Label: forward Δlog-odds for playerA over a horizon (default 5 minutes).
 *        positive label = market drifted toward playerA = momentum should be +.
 *
 * Method: ordinary least squares on the 6 features → label.
 *         Weights are rescaled so that their L2 norm matches the current
 *         hand-tuned norm, preserving the tanh saturation regime.
 *
 * Usage:
 *   node scripts/fitMomentumWeights.js [--horizon=300] [--min-samples=2000] [--apply]
 *
 *   --horizon       seconds ahead for the label (default 300)
 *   --min-samples   bail out if we have fewer rows than this (default 2000)
 *   --apply         write the new weights into momentumDetector.js
 *                   (without this flag, the script just prints them)
 */

const path = require('path');
const fs   = require('fs');
const db   = require('../src/database/db');
const { WEIGHTS } = require('../src/algorithm/momentumDetector');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.replace(/^--/, '').split('=');
      return [k, v ?? true];
    })
);
const HORIZON_SEC = parseInt(args.horizon, 10) || 300;
const MIN_SAMPLES = parseInt(args['min-samples'], 10) || 2000;
const APPLY       = !!args.apply;

const FEATURE_KEYS = [
  'fBreakStreak', 'fGameStreak', 'fServeTrend',
  'fDoubleFault', 'fBpConv',     'fBpLeverage',
];
const WEIGHT_KEYS = [
  'BREAK_STREAK', 'GAME_STREAK', 'SERVE_TREND',
  'DOUBLE_FAULT', 'BP_CONVERSION', 'BP_LEVERAGE',
];

// ---------------------------------------------------------------------------
// Load training rows
// ---------------------------------------------------------------------------
console.log(`Loading snapshots with momentum_features and forward horizon ${HORIZON_SEC}s…`);

const rows = db.prepare(`
  SELECT betfair_market_id AS marketId,
         ts,
         player_a_back     AS backA,
         momentum_features AS features
  FROM market_snapshots
  WHERE momentum_features IS NOT NULL
    AND player_a_back IS NOT NULL
    AND player_a_back > 1.01
  ORDER BY betfair_market_id, ts
`).all();

console.log(`Loaded ${rows.length} candidate snapshots.`);

// Build training set: pair each row with the snapshot ~HORIZON_SEC later in the same market.
const samples = [];
let i = 0;
while (i < rows.length) {
  // Find the next-market boundary
  let j = i;
  while (j < rows.length && rows[j].marketId === rows[i].marketId) j++;

  for (let k = i; k < j; k++) {
    const t0 = Date.parse(rows[k].ts);
    const targetTs = t0 + HORIZON_SEC * 1000;
    let m = k + 1;
    while (m < j && Date.parse(rows[m].ts) < targetTs) m++;
    if (m >= j) break; // not enough lookahead in this market
    const t1 = Date.parse(rows[m].ts);
    if (t1 - t0 > HORIZON_SEC * 1000 * 1.5) continue; // gap too large

    let feats;
    try { feats = JSON.parse(rows[k].features); } catch { continue; }
    const x = FEATURE_KEYS.map(key => Number(feats[key]) || 0);

    const y = Math.log(rows[k].backA) - Math.log(rows[m].backA);
    // Δlog(backA) is positive when A's back odds dropped — i.e. market moved toward A.

    if (Number.isFinite(y)) samples.push({ x, y, leverage: feats.leverage || 1 });
  }
  i = j;
}

console.log(`Built ${samples.length} (features → label) pairs.`);
if (samples.length < MIN_SAMPLES) {
  console.error(`Not enough samples (${samples.length} < ${MIN_SAMPLES}). Aborting.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// OLS:  X β = y
//   X is (n × 6) — features × leverage (so we recover the non-leveraged weight)
//   β is the 6-dim weight vector
//   solve via normal equations:  β = (XᵀX)^-1 Xᵀy
// ---------------------------------------------------------------------------
const n = samples.length;
const p = FEATURE_KEYS.length;

// XtX (p×p), Xty (p)
const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
const Xty = new Array(p).fill(0);

for (const s of samples) {
  const lev = s.leverage || 1;
  for (let a = 0; a < p; a++) {
    const xa = s.x[a] * lev;
    Xty[a] += xa * s.y;
    for (let b = 0; b < p; b++) {
      XtX[a][b] += xa * s.x[b] * lev;
    }
  }
}

// Tikhonov regularisation so we never blow up if a feature is rare/colinear.
const ridge = 1e-3;
for (let a = 0; a < p; a++) XtX[a][a] += ridge;

// Gauss–Jordan inversion of XtX, then β = XtX^-1 · Xty.
function solve(A, b) {
  const N = A.length;
  // Build augmented [A | I | b]
  const M = A.map((row, i) => [...row, ...Array.from({ length: N }, (_, j) => i === j ? 1 : 0), b[i]]);
  for (let c = 0; c < N; c++) {
    // Partial pivot
    let pivot = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    const div = M[c][c];
    if (Math.abs(div) < 1e-12) throw new Error('Singular matrix at column ' + c);
    for (let j = 0; j < M[c].length; j++) M[c][j] /= div;
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = 0; j < M[c].length; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map(row => row[row.length - 1]);
}

const betaRaw = solve(XtX, Xty);

// ---------------------------------------------------------------------------
// Rescale: keep the same ‖W‖₂ as the current hand-tuned weights, so the tanh
// saturation regime is preserved. Only the *direction* (relative balance of
// features) is being learned here.
// ---------------------------------------------------------------------------
const currentW = WEIGHT_KEYS.map(k => WEIGHTS[k]);
const norm = vec => Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
const targetNorm = norm(currentW);
const fittedNorm = norm(betaRaw);
const scale = fittedNorm > 0 ? targetNorm / fittedNorm : 1;
const betaScaled = betaRaw.map(b => b * scale);

// ---------------------------------------------------------------------------
// R² on training set (not held out — diagnostic only)
// ---------------------------------------------------------------------------
const yMean = samples.reduce((s, r) => s + r.y, 0) / n;
let ssTot = 0, ssRes = 0;
for (const s of samples) {
  const yhat = s.x.reduce((acc, v, i) => acc + v * betaScaled[i] * (s.leverage || 1), 0);
  ssTot += (s.y - yMean) ** 2;
  ssRes += (s.y - yhat) ** 2;
}
const r2 = 1 - ssRes / ssTot;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('\nFitted weights (rescaled to current norm):');
for (let i = 0; i < p; i++) {
  const k = WEIGHT_KEYS[i];
  const cur = currentW[i].toFixed(3);
  const next = betaScaled[i].toFixed(3);
  const arrow = betaScaled[i] > currentW[i] ? '↑' : (betaScaled[i] < currentW[i] ? '↓' : '=');
  console.log(`  ${k.padEnd(15)}  current=${cur}  fitted=${next}  ${arrow}`);
}
console.log(`\nTraining R²: ${r2.toFixed(4)}  (n=${n}, horizon=${HORIZON_SEC}s)`);

if (r2 < 0.005) {
  console.warn('\nR² is very low — features have little predictive power on this horizon.');
  console.warn('Consider increasing --horizon, collecting more data, or revisiting features.');
}

// ---------------------------------------------------------------------------
// Optionally apply
// ---------------------------------------------------------------------------
if (!APPLY) {
  console.log('\nDry-run only. Re-run with --apply to write these weights into momentumDetector.js.');
  process.exit(0);
}

const detectorPath = path.join(__dirname, '..', 'src', 'algorithm', 'momentumDetector.js');
let src = fs.readFileSync(detectorPath, 'utf8');
const before = src;

for (let i = 0; i < p; i++) {
  const k = WEIGHT_KEYS[i];
  const re = new RegExp(`(${k}:\\s*)([0-9.]+)`);
  src = src.replace(re, (_m, lhs) => `${lhs}${betaScaled[i].toFixed(3)}`);
}

if (src === before) {
  console.error('No weights replaced — file format may have changed. Aborting.');
  process.exit(2);
}

const backupPath = detectorPath + '.bak.' + Date.now();
fs.writeFileSync(backupPath, before);
fs.writeFileSync(detectorPath, src);
console.log(`\nApplied. Backup written to ${backupPath}.`);
