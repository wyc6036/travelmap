/**
 * src/routes/media.js · 媒体对象读取 + 媒体记录增删改 + 上传转码
 * ---------------------------------------------------------
 * - GET /media/:key        无论底层是 MinIO 还是本地磁盘，对外 URL 统一 /media/<key>。
 *                          对象 key 是扁平 id（无斜杠），拒掉任何含 "/" 或 ".." 的请求防目录穿越。
 * - DELETE/PUT /api/media/:id  删行+底层对象 / 改 caption、taken_at、name、remark
 * - GET /api/media/pending     未归类媒体计数（首页「待整理照片」小组件）
 * - POST /api/upload           图片 sharp 转码 / 视频 ffmpeg 异步转码 / 文字笔记 / 其它原样保存
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { requireAuth } = require('../auth');
const { addMedia, deleteMedia, updateMedia, setPlaceCoverUrl, getPendingMediaCount } = require('../db');
const { getObjectStream, saveObject, TMP_DIR } = require('../storage');
const { upload, CTYPE } = require('../uploads');
const { extractImageMeta } = require('../exif');
const { transcodeVideo } = require('../transcode');

const router = express.Router();
const write = requireAuth;

router.get('/media/:key', async (req, res) => {
  const key = req.params.key;
  if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) {
    return res.status(400).end();
  }
  try {
    const stream = await getObjectStream(key);
    if (!stream) return res.status(404).end();
    res.setHeader('Content-Type', CTYPE[path.extname(key).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    stream.pipe(res);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  } catch (_) {
    res.status(404).end();
  }
});

/* 删除单条媒体：删 DB 行 + 底层对象（图 / 缩略图 / 视频 / 首帧） */
router.delete('/api/media/:id', write, async (req, res) => {
  try {
    const ok = await deleteMedia(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || '删除失败' });
  }
});

/* 更新单条媒体：重命名 caption / 补 taken_at / 名称 name / 备注 remark（传什么改什么） */
router.put('/api/media/:id', write, (req, res) => {
  try {
    const ok = updateMedia(req.params.id, {
      caption: req.body && typeof req.body.caption === 'string' ? req.body.caption : undefined,
      taken_at: req.body && typeof req.body.taken_at === 'string' ? req.body.taken_at : undefined,
      name: req.body && typeof req.body.name === 'string' ? req.body.name : undefined,
      remark: req.body && typeof req.body.remark === 'string' ? req.body.remark : undefined,
    });
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || '更新失败' });
  }
});

/* 待整理照片计数：未归类（不属于任何地点）的媒体数量。
   首页「待整理照片」小组件用它做头条数字 —— 未归类照片不在 /api/data 的 places 里，
   前端拿不到，只能单独问一次。只回一个数字，不拉整行。 */
router.get('/api/media/pending', requireAuth, (_req, res) => {
  try {
    res.json({ count: getPendingMediaCount() });
  } catch (e) {
    res.status(500).json({ error: e.message || '读取待整理照片失败' });
  }
});

router.post('/api/upload', write, upload.single('file'), async (req, res) => {
  try {
    const placeId = (req.body && req.body.placeId) || '';
    const tripId = (req.body && req.body.tripId) || '';
    const caption = (req.body && req.body.caption) || '';
    const kind = (req.body && req.body.kind) || '';

    // 纯文字笔记：无文件
    if (kind === 'text' || (!req.file && kind === 'text')) {
      const id = addMedia({ place_id: placeId, trip_id: tripId, kind: 'text', caption, text_body: (req.body && req.body.text_body) || '' });
      return res.json({ ok: true, id, status: 'ready' });
    }
    if (!req.file) return res.status(400).json({ error: 'no file' });

    const mediaId = req.file.generatedId;
    const inputPath = req.file.path;
    const mime = req.file.mimetype || '';

    if (mime.startsWith('image/')) {
      const full = path.join(TMP_DIR, mediaId + '.webp');
      const thumb = path.join(TMP_DIR, mediaId + '_thumb.webp');
      /* ⚠️ 必须 .rotate()：sharp 默认忽略 EXIF Orientation，会让竖拍照片（如 4284×5712）
         被当成横图处理、显示时"横过来"。无参 .rotate() 会按 EXIF 自动正方向，
         输出尺寸（info.width/height）即为校正后的真实宽高，存入 DB 供瀑布流按比例排布。
         ⚠️ 像素已转正后，用 .withMetadata({ orientation: 1 }) 把 Orientation 标回 1，
         同时**保留其余 EXIF（GPS / 相机型号 / 拍摄时间等）** —— 满足"保留媒体 EXIF 信息"。
         历史遗留的烂方向图（首轮转码时方向已烧死、EXIF 已丢）只能删了重传，
         这里保证此后每张新上传都自动正方向且带 EXIF，不再出现横显。 */
      const fullPipe = sharp(inputPath).rotate().resize(1600, null, { withoutEnlargement: true }).withMetadata({ orientation: 1 }).webp({ quality: 82 });
      const info = await fullPipe.toFile(full);
      await sharp(inputPath).rotate().resize(720, null, { withoutEnlargement: true }).withMetadata({ orientation: 1 }).webp({ quality: 80 }).toFile(thumb);
      /* 提取原始 EXIF（独立读一次文件头，不干扰上面的转码）。失败不影响上传。 */
      let exifMeta = null;
      try { const raw = await sharp(inputPath).metadata(); exifMeta = extractImageMeta(raw.exif); } catch (_) {}
      try { fs.unlinkSync(inputPath); } catch (_) {}
      await saveObject(mediaId + '.webp', full, 'image/webp');
      await saveObject(mediaId + '_thumb.webp', thumb, 'image/webp');
      try { fs.unlinkSync(full); } catch (_) {}
      try { fs.unlinkSync(thumb); } catch (_) {}
      const id = addMedia({
        place_id: placeId, trip_id: tripId, kind: 'image',
        url: '/media/' + mediaId + '.webp', thumb_url: '/media/' + mediaId + '_thumb.webp',
        caption, width: info.width || 0, height: info.height || 0,
        ...(exifMeta || {}),
      });
      /* 上传了真实图片/视频 → 该地点若曾用"联网地标占位图"作封面，现在应完全让位给真实媒体。
         即便前端按"有媒体优先"已能盖掉占位图，这里也把 cover_url 置空，确保占位资源被清理。 */
      if (placeId) { try { setPlaceCoverUrl(placeId, ''); } catch (_) {} }
      return res.json({ ok: true, id, status: 'ready' });
    }

    if (mime.startsWith('video/')) {
      // 先插入一条 processing 的记录，转码完再回填（getExport 仅导出 ready，故转码期间不显示）
      addMedia({ place_id: placeId, trip_id: tripId, kind: 'video', url: '', thumb_url: '', caption, status: 'processing' });
      // 视频同样是真实媒体：占位图让位（见图片分支注释）
      if (placeId) { try { setPlaceCoverUrl(placeId, ''); } catch (_) {} }
      transcodeVideo(inputPath, mediaId); // 异步：转完自动上传 + 回填
      return res.json({ ok: true, id: mediaId, status: 'processing' });
    }

    // 其它类型：原样保存
    const ext = path.extname(req.file.originalname || '');
    const tmpDest = path.join(TMP_DIR, mediaId + ext);
    fs.renameSync(inputPath, tmpDest);
    await saveObject(mediaId + ext, tmpDest, mime || 'application/octet-stream');
    try { fs.unlinkSync(tmpDest); } catch (_) {}
    const id = addMedia({ place_id: placeId, trip_id: tripId, kind: 'image', url: '/media/' + mediaId + ext, caption });
    return res.json({ ok: true, id, status: 'ready' });
  } catch (e) {
    console.error('[upload] 失败:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
