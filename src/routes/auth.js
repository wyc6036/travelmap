/**
 * src/routes/auth.js · 会话：登录 / 登出 / 会话查询
 */
const express = require('express');
const { AUTH_ENABLED, requireAuth, login, makeToken } = require('../auth');

const router = express.Router();

router.get('/api/session', requireAuth, (_req, res) => {
  res.json({ authEnabled: AUTH_ENABLED, authed: true });
});

router.post('/api/login', (req, res) => {
  const r = login(req.body && req.body.password);
  if (r.ok) {
    res.cookie('tm_session', makeToken(), {
      httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000, path: '/',
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'bad password' });
});

router.post('/api/logout', (_req, res) => {
  res.clearCookie('tm_session', { path: '/' });
  res.json({ ok: true });
});

module.exports = router;
