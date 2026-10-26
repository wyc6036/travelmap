/**
 * src/routes/profile.js · 用户资料（单用户：显示名 + 头像）+ 通用 meta 读写
 * ---------------------------------------------------------
 * 资料存 meta.userProfile；头像存在媒体后端（/media/<key>），URL 写回 meta；
 * 换头像时删旧对象避免孤儿。默认名 "Coral"（与前端侧栏默认值一致），
 * 头像为空时前端回退生成式 SVG。
 * 通用 meta：GET /api/meta/:key 返回 { value }；POST /api/meta 写入任意 key。
 *   （设置页用，例如高德逆地理编码 Key）
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { requireAuth } = require('../auth');
const { getMeta, setMeta } = require('../db');
const storage = require('../storage');
const { saveObject, TMP_DIR } = storage;
const { upload } = require('../uploads');

const router = express.Router();
const write = requireAuth;

const PROFILE_DEFAULT = { name: 'Coral', avatar: '' };

function getProfile() {
  const p = getMeta('userProfile');
  if (p && typeof p === 'object') {
    return { name: p.name || PROFILE_DEFAULT.name, avatar: p.avatar || '' };
  }
  return { ...PROFILE_DEFAULT };
}

function saveProfile(patch) {
  const cur = getProfile();
  const next = {
    name: (patch && patch.name != null ? String(patch.name).slice(0, 40) : cur.name) || cur.name,
    avatar: (patch && patch.avatar != null ? patch.avatar : cur.avatar),
  };
  setMeta('userProfile', next);
  return next;
}

router.get('/api/profile', requireAuth, (_req, res) => {
  res.json(getProfile());
});

router.put('/api/profile', requireAuth, (req, res) => {
  try { res.json(saveProfile(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});

router.get('/api/meta/:key', requireAuth, (req, res) => {
  try { res.json({ value: getMeta(req.params.key) || '' }); }
  catch (e) { res.status(500).json({ error: e.message || '读取失败' }); }
});

router.post('/api/meta', write, (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key 必填' });
    setMeta(String(key), value == null ? '' : String(value));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});

/* 头像上传：sharp 裁成 256 方形 webp，存媒体后端，URL 写回 meta */
router.post('/api/profile/avatar', write, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const inputPath = req.file.path;
    const id = req.file.generatedId;
    const out = path.join(TMP_DIR, id + '.webp');
    await sharp(inputPath).resize(256, 256, { fit: 'cover', position: 'centre' }).webp({ quality: 85 }).toFile(out);
    try { fs.unlinkSync(inputPath); } catch (_) {}
    const key = id + '.webp';
    await saveObject(key, out, 'image/webp');
    try { fs.unlinkSync(out); } catch (_) {}
    /* 删旧头像对象（新 key 也天然绕开 /media 的 immutable 缓存） */
    const cur = getProfile();
    if (cur.avatar) {
      const oldKey = String(cur.avatar).split('/media/')[1];
      if (oldKey) { try { await storage.deleteObject(oldKey); } catch (_) { /* 已丢失 */ } }
    }
    const next = saveProfile({ avatar: '/media/' + key });
    res.json({ ok: true, url: '/media/' + key, profile: next });
  } catch (e) {
    res.status(500).json({ error: e.message || '头像上传失败' });
  }
});

module.exports = router;
