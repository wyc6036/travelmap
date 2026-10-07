/**
 * server.js · 单进程 Express 服务
 *
 * 一个容器里同时负责：
 *   1. 托管改造后的 TravelMap 前端（静态文件）
 *   2. /api/data 返回与 places.json 同构的数据（前端 normalize 直接吃）
 *   3. 地点 / 行程 / 媒体 的增删改查（SQLite）
 *   4. 文件上传 → 转码后存入媒体后端（MinIO 对象存储，未配则回退本地磁盘 /data/media）
 *   5. 图片用 sharp 生成缩略图；视频用 ffmpeg 转 H.264（全平台能播）
 *   6. 单密码登录会话
 *
 * 所有持久数据都在挂载卷 DATA_DIR（默认 /data）下：travelmap.db。
 * 媒体文件存在 MinIO（或回退的本地 media/），经 /media/:key 路由对外提供，
 * 对外 URL 始终是 /media/<key>，与原来本地磁盘方案完全一致。
 */
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { DATA_DIR, uid, getExport, maybeSeed, saveTypes, getMeta, setMeta,
  createPlace, deletePlace, createTrip, deleteTrip, addMedia, deleteMedia,
  markMediaReady, markMediaError } = require('./src/db');
const { AUTH_ENABLED, requireAuth, login, makeToken } = require('./src/auth');
const storage = require('./src/storage');
const { initStorage, getStorageInfo, applyConfig, testConnection,
  ensureBucket, saveObject, getObjectStream, TMP_DIR } = storage;

const WEB_DIR = path.join(__dirname, 'web');
const PORT = Number(process.env.PORT || 8080);

const app = express();
app.use(express.json({ limit: '2mb' }));

/* 手动解析 cookie（不引额外依赖） */
app.use((req, _res, next) => {
  const h = req.headers.cookie;
  const out = {};
  if (h) h.split(';').forEach((s) => {
    const i = s.indexOf('=');
    if (i > -1) out[s.slice(0, i).trim()] = decodeURIComponent(s.slice(i + 1).trim());
  });
  req.cookies = out;
  next();
});

/* 静态资源 */
app.use(express.static(WEB_DIR));

/* 媒体读取：无论底层是 MinIO 还是本地磁盘，对外 URL 统一为 /media/<key>。
   对象 key 是扁平 id（无斜杠），拒掉任何含 "/" 或 ".." 的请求防目录穿越。 */
const CTYPE = {
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.svg': 'image/svg+xml',
};
app.get('/media/:key', async (req, res) => {
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

/* 鉴权相关 */
app.get('/api/session', requireAuth, (_req, res) => {
  res.json({ authEnabled: AUTH_ENABLED, authed: true });
});
app.post('/api/login', (req, res) => {
  const r = login(req.body && req.body.password);
  if (r.ok) {
    res.cookie('tm_session', makeToken(), {
      httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000, path: '/',
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'bad password' });
});
app.post('/api/logout', (_req, res) => {
  res.clearCookie('tm_session', { path: '/' });
  res.json({ ok: true });
});

/* 前端启动配置 */
app.get('/api/config', (_req, res) => {
  res.json({ authEnabled: AUTH_ENABLED, apiBase: '/api', setupRequired: !isSetupDone() });
});

/* 首次配置向导
   - GET（需登录）：返回 setupRequired 与当前连接信息（含密钥，供向导预填）
   - POST（需登录）：校验连通性 → 写入 meta → 运行时套用 */
app.get('/api/setup', requireAuth, (_req, res) => {
  res.json({ setupRequired: !isSetupDone(), config: getStorageInfo() });
});
app.post('/api/setup', requireAuth, async (req, res) => {
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

/* 数据读取（受登录保护） */
app.get('/api/data', requireAuth, (_req, res) => {
  res.json(getExport());
});

/* 写入接口（全部受登录保护） */
const write = requireAuth;

app.post('/api/places', write, (req, res) => {
  const id = createPlace(req.body || {});
  res.json({ ok: true, id });
});
app.put('/api/places/:id', write, (req, res) => {
  createPlace({ ...(req.body || {}), id: req.params.id });
  res.json({ ok: true });
});
app.delete('/api/places/:id', write, (req, res) => {
  deletePlace(req.params.id);
  res.json({ ok: true });
});

app.post('/api/trips', write, (req, res) => {
  const id = createTrip(req.body || {});
  res.json({ ok: true, id });
});
app.put('/api/trips/:id', write, (req, res) => {
  createTrip({ ...(req.body || {}), id: req.params.id });
  res.json({ ok: true });
});
app.delete('/api/trips/:id', write, (req, res) => {
  deleteTrip(req.params.id);
  res.json({ ok: true });
});

/* 删除单条媒体：删 DB 行 + 底层对象（图 / 缩略图 / 视频 / 首帧） */
app.delete('/api/media/:id', write, async (req, res) => {
  try {
    const ok = await deleteMedia(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || '删除失败' });
  }
});

app.post('/api/types', write, (req, res) => {
  saveTypes(req.body || {});
  res.json({ ok: true });
});

/* ----------------------------- 上传 + 转码 ----------------------------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, file, cb) => {
      const id = uid('m');
      file.generatedId = id;
      const ext = path.extname(file.originalname || '') || '';
      cb(null, id + '_orig' + ext);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024 },
});

/**
 * 视频转码：ffmpeg 在临时目录产出 mp4 + 首帧 jpg，再上传到媒体后端，
 * 然后回填数据库；无论成功失败都清理临时文件。返回 Promise。
 */
async function transcodeVideo(input, mediaId) {
  const mp4 = path.join(TMP_DIR, mediaId + '.mp4');
  const poster = path.join(TMP_DIR, mediaId + '.jpg');
  const args = [
    '-y', '-i', input,
    '-vf', 'scale=\'min(1280,iw)\':-2', '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', mp4,
    '-ss', '00:00:01', '-vframes', '1', '-q:v', '3', poster,
  ];
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', async (code) => {
      try { fs.unlinkSync(input); } catch (_) {}
      if (code === 0) {
        try {
          await saveObject(mediaId + '.mp4', mp4, 'video/mp4');
          await saveObject(mediaId + '.jpg', poster, 'image/jpeg');
          markMediaReady(mediaId, '/media/' + mediaId + '.mp4', '/media/' + mediaId + '.jpg');
        } catch (e) {
          console.error('[storage] 视频上传后端失败：', e.message);
          markMediaError(mediaId);
        } finally {
          try { fs.unlinkSync(mp4); } catch (_) {}
          try { fs.unlinkSync(poster); } catch (_) {}
        }
      } else {
        console.error('[ffmpeg] 转码失败:', stderr.slice(0, 300));
        markMediaError(mediaId);
      }
      resolve();
    });
  });
}

app.post('/api/upload', write, upload.single('file'), async (req, res) => {
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
      const meta = await sharp(inputPath).metadata();
      await sharp(inputPath).resize(1600, null, { withoutEnlargement: true }).webp({ quality: 82 }).toFile(full);
      await sharp(inputPath).resize(720, null, { withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumb);
      try { fs.unlinkSync(inputPath); } catch (_) {}
      await saveObject(mediaId + '.webp', full, 'image/webp');
      await saveObject(mediaId + '_thumb.webp', thumb, 'image/webp');
      try { fs.unlinkSync(full); } catch (_) {}
      try { fs.unlinkSync(thumb); } catch (_) {}
      const id = addMedia({
        place_id: placeId, trip_id: tripId, kind: 'image',
        url: '/media/' + mediaId + '.webp', thumb_url: '/media/' + mediaId + '_thumb.webp',
        caption, width: meta.width || 0, height: meta.height || 0,
      });
      return res.json({ ok: true, id, status: 'ready' });
    }

    if (mime.startsWith('video/')) {
      // 先插入一条 processing 的记录，转码完再回填（getExport 仅导出 ready，故转码期间不显示）
      addMedia({ place_id: placeId, trip_id: tripId, kind: 'video', url: '', thumb_url: '', caption, status: 'processing' });
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

/* 首配是否已完成（setupDone 标记存在于 meta 表） */
function isSetupDone() {
  try { return getMeta('setupDone') === '1'; } catch (_) { return false; }
}

/* 兜底：未知 API */
app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

/* SPA 兜底（非 API、非 media 的 GET 都回 index.html） */
app.get(/^(?!\/(api|media)).*/, (_req, res) => {
  res.sendFile(path.join(WEB_DIR, 'index.html'));
});

(async () => {
  await initStorage();   // 套用已保存的存储配置（若有）
  await ensureBucket();
  maybeSeed();
  app.listen(PORT, () => {
    const info = getStorageInfo();
    console.log(`TravelMap 运行中：http://0.0.0.0:${PORT}  (auth=${AUTH_ENABLED ? 'on' : 'off'})`);
    console.log(`数据目录：${DATA_DIR}`);
    console.log(`媒体存储：${info.useMinio
      ? `MinIO bucket "${info.minio.bucket}" @ ${info.minio.endpoint}:${info.minio.port}`
      : '本地磁盘 ' + info.local.dir}`);
  });
})();
