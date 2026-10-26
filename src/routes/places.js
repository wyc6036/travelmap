/**
 * src/routes/places.js · 地点 / 行程 / 自定义类型 / 批量 GPS 归档
 * ---------------------------------------------------------
 * 写入接口全部受登录保护（write = requireAuth）。
 * 新建地点时若无封面，联网拉一张地标占位图（src/landmark.js），
 * 网络可能慢/失败/被墙 → 全部吞掉，占位图留空即可，绝不拖慢保存。
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { createPlace, deletePlace, createTrip, deleteTrip, saveTypes, setPlaceCoverUrl } = require('../db');
const { fetchLandmarkImage } = require('../landmark');
const geocode = require('../geocode');

const router = express.Router();
const write = requireAuth;

router.post('/api/places', write, async (req, res) => {
  try {
    const body = req.body || {};
    const id = createPlace(body);
    /* 新地点：若调用方没自带封面，且地点还没有媒体（新增时通常还没有），
       联网拉一张该地地标图作占位封面（愿望清单场景尤甚）。 */
    if (!body.cover && id) {
      try {
        const url = await fetchLandmarkImage(body.name || '');
        if (url) setPlaceCoverUrl(id, url);
      } catch (_) { /* 占位图非关键，静默 */ }
    }
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message || '保存失败' });
  }
});

router.put('/api/places/:id', write, (req, res) => {
  createPlace({ ...(req.body || {}), id: req.params.id });
  res.json({ ok: true });
});

router.delete('/api/places/:id', write, (req, res) => {
  deletePlace(req.params.id);
  res.json({ ok: true });
});

router.post('/api/trips', write, (req, res) => {
  const id = createTrip(req.body || {});
  res.json({ ok: true, id });
});

router.put('/api/trips/:id', write, (req, res) => {
  createTrip({ ...(req.body || {}), id: req.params.id });
  res.json({ ok: true });
});

router.delete('/api/trips/:id', write, (req, res) => {
  deleteTrip(req.params.id);
  res.json({ ok: true });
});

router.post('/api/types', write, (req, res) => {
  saveTypes(req.body || {});
  res.json({ ok: true });
});

/* ----------------------------- 批量 GPS 归档 -----------------------------
   analyze：只读，扫描未归类媒体、逐张逆地理编码、聚类，返回可编辑预览。
   apply：落库，按前端确认后的方案新建地点 / 归入已有地点 / 跳过。
   两步分离保证「先看清再写」，避免把照片误归到荒野（坐标中心点）。 */
router.post('/api/gps/analyze', write, async (_req, res) => {
  try {
    res.json(await geocode.analyzeUnassigned());
  } catch (e) {
    res.status(500).json({ error: e.message || '分析失败' });
  }
});

router.post('/api/gps/apply', write, (req, res) => {
  try {
    const r = geocode.applyPlan(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message || '归档失败' });
  }
});

module.exports = router;
