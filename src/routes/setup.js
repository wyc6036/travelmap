/**
 * src/routes/setup.js · 首次配置向导 + 前端启动配置
 * ---------------------------------------------------------
 * - GET /api/config（公开）：前端启动时问「要不要走首配向导」
 * - GET /api/setup（需登录）：返回 setupRequired 与当前连接信息（含密钥，供向导预填）
 * - POST /api/setup（需登录）：校验连通性 → 写入 meta → 运行时套用
 */
const express = require('express');
const { getMeta, setMeta } = require('../db');
const { AUTH_ENABLED, requireAuth } = require('../auth');
const { getStorageInfo, applyConfig, testConnection } = require('../storage');

const router = express.Router();

/* 首配是否已完成（setupDone 标记存在于 meta 表） */
function isSetupDone() {
  try { return getMeta('setupDone') === '1'; } catch (_) { return false; }
}

router.get('/api/config', (_req, res) => {
  res.json({ authEnabled: AUTH_ENABLED, apiBase: '/api', setupRequired: !isSetupDone() });
});

router.get('/api/setup', requireAuth, (_req, res) => {
  res.json({ setupRequired: !isSetupDone(), config: getStorageInfo() });
});

router.post('/api/setup', requireAuth, async (req, res) => {
  try {
    const cfg = req.body || {};
    await testConnection(cfg);
    setMeta('storageConfig', cfg);
    setMeta('setupDone', '1');
    await applyConfig(cfg); // 运行时重建 client + 建桶
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || '配置失败' });
  }
});

module.exports = router;
