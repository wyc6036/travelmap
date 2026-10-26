/**
 * src/routes/wishes.js · 心愿数据（后端持久化）
 * ---------------------------------------------------------
 * 心愿是地点的增强视图：注解（wish/priority/note/target）按 place_id 落到 wish_annotations，
 * 用户在心愿面板新建的纯目的地落到 wish_places（不进 places 表，故不污染足迹地图/列表）。
 * 全部受登录保护（write）。
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { getWishes, upsertWishAnnotation, saveWishPlace, deleteWishPlace } = require('../db');

const router = express.Router();
const write = requireAuth;

router.get('/api/wishes', requireAuth, (_req, res) => {
  res.json(getWishes());
});

/* 写/改某地点的心愿注解（覆盖式：前端传完整的注解对象） */
router.put('/api/wishes/annotations/:placeId', write, (req, res) => {
  try {
    upsertWishAnnotation({ place_id: req.params.placeId, ...(req.body || {}) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});

router.post('/api/wishes/places', write, (req, res) => {
  try {
    const id = saveWishPlace(req.body || {});
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});

router.put('/api/wishes/places/:id', write, (req, res) => {
  try {
    const id = saveWishPlace({ ...(req.body || {}), id: req.params.id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});

router.delete('/api/wishes/places/:id', write, (req, res) => {
  try { deleteWishPlace(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message || '删除失败' }); }
});

module.exports = router;
