'use strict';

/**
 * Simple cookie-based auth.
 * - Single account: AUTH_USER / AUTH_PASS (env, with defaults)
 * - 30-day signed cookie (HMAC-SHA256). No external deps.
 * - Exposes: requireAuth middleware, mount(app) to add /login + /logout.
 */

const crypto = require('crypto');

const USER   = process.env.AUTH_USER || 'Admin';
const PASS   = process.env.AUTH_PASS || 'TennisFootyBot1998!';
const SECRET = process.env.AUTH_SECRET || 'tennisfooty-' + USER + '-' + PASS;
const COOKIE = 'auth';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return !!verify(cookies[COOKIE]);
}

function requireAuth(req, res, next) {
  // allow login routes + static login asset
  if (req.path === '/login' || req.path === '/logout') return next();
  // public CSV feeds for BFBM Bot Manager (no auth — needed for HTTP polling)
  if (req.path === '/football/api/upload.csv' || req.path === '/football/api/bfbm-csv' ||
      req.path === '/api/bfbm/export' || req.path === '/api/bfbm-signals.csv' || req.path === '/api/tennis.csv') return next();
  if (isAuthed(req)) return next();
  // For API/XHR calls return 401; for page loads redirect to /login
  const accept = req.headers.accept || '';
  if (req.path.startsWith('/api/') || req.path.startsWith('/football/api/')) {
    return res.status(401).json({ error: 'auth_required' });
  }
  if (accept.includes('text/html') || req.method === 'GET') {
    return res.redirect('/login');
  }
  return res.status(401).end('auth required');
}

const LOGIN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  form{background:#1c1c1c;padding:28px 32px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.5);min-width:280px}
  h1{margin:0 0 18px;font-size:18px;font-weight:600}
  label{display:block;font-size:12px;color:#aaa;margin:10px 0 4px}
  input{width:100%;padding:9px 10px;background:#0c0c0c;border:1px solid #333;border-radius:6px;color:#eee;font-size:14px;box-sizing:border-box}
  input:focus{outline:none;border-color:#4a9eff}
  .row{display:flex;align-items:center;gap:6px;margin-top:12px;font-size:13px;color:#bbb}
  button{margin-top:16px;width:100%;padding:10px;background:#4a9eff;color:#fff;border:0;border-radius:6px;font-size:14px;cursor:pointer}
  button:hover{background:#3a8eef}
  .err{color:#ff6b6b;font-size:13px;margin-top:10px;min-height:18px}
</style></head>
<body>
<form method="POST" action="/login">
  <h1>Sign in</h1>
  <label>Username</label>
  <input name="username" autocomplete="username" autofocus required>
  <label>Password</label>
  <input name="password" type="password" autocomplete="current-password" required>
  <label class="row"><input type="checkbox" name="remember" value="1" checked style="width:auto"> Stay signed in for 30 days</label>
  <button type="submit">Sign in</button>
  <div class="err">__ERR__</div>
</form>
</body></html>`;

function mount(app) {
  const express = require('express');
  app.use(express.urlencoded({ extended: false }));

  app.get('/login', (req, res) => {
    if (isAuthed(req)) return res.redirect('/');
    res.type('html').send(LOGIN_HTML.replace('__ERR__', ''));
  });

  app.post('/login', (req, res) => {
    const { username, password, remember } = req.body || {};
    const userOk = typeof username === 'string' && username.length === USER.length &&
                   crypto.timingSafeEqual(Buffer.from(username), Buffer.from(USER));
    const passOk = typeof password === 'string' && password.length === PASS.length &&
                   crypto.timingSafeEqual(Buffer.from(password), Buffer.from(PASS));
    if (!userOk || !passOk) {
      return res.status(401).type('html').send(LOGIN_HTML.replace('__ERR__', 'Invalid username or password'));
    }
    const maxAge = remember ? MAX_AGE_MS : 0; // 0 = session cookie
    const token = sign({ u: USER, exp: Date.now() + (remember ? MAX_AGE_MS : 12 * 60 * 60 * 1000) });
    const parts = [
      `${COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
    ];
    if (remember) parts.push(`Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`);
    res.setHeader('Set-Cookie', parts.join('; '));
    res.redirect('/');
  });

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.redirect('/login');
  });
}

module.exports = { requireAuth, mount, isAuthed, verify, parseCookies, COOKIE };
