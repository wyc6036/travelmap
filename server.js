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
const archiver = require('archiver');
const sharp = require('sharp');
const exifReader = require('exif-reader');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { DATA_DIR, uid, getExport, getExportBundle, applyImportBundle, exportDbSnapshot, maybeSeed, saveTypes, getMeta, setMeta,
  createPlace, deletePlace, createTrip, deleteTrip, addMedia, deleteMedia,
  updateMedia, setPlaceCoverUrl, setMediaMeta, migrateMediaMeta,
  markMediaReady, markMediaError, ensureGeocitiesLoaded, getPendingMediaCount,
  getWishes, upsertWishAnnotation, deleteWishAnnotation, saveWishPlace, deleteWishPlace } = require('./src/db');
const { AUTH_ENABLED, requireAuth, login, makeToken } = require('./src/auth');
const storage = require('./src/storage');
const geocode = require('./src/geocode');
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

/* =========================================================
 * 联网拉取地标占位图（新增地点时作封面）
 * ---------------------------------------------------------
 * 用维基百科 / 维基共享资源的公开 API（无需 key）：
 *   1. 中文维基 pageimages（取词条首图缩略图，通常是该地标志性地标）
 *   2. 英文维基 pageimages（中文没命中时兜底）
 *   3. 维基共享资源 Commons 按 "<地名> landmark" 搜索，取第一张图
 * 全程带 4s 超时与异常兜底；拿不到就返回 null（封面留空，前端回退默认占位图）。
 * 返回的是远程图片 URL（不下载到本地），前端 <img> 直接展示即可。
 * ========================================================= */
async function fetchLandmarkImage(name) {
  if (!name || typeof name !== 'string' || !name.trim()) return null;
  const q = name.trim();

  const wikiThumb = async (lang) => {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json`
      + `&prop=pageimages&piprop=thumbnail&pithumbsize=800&redirects=1&titles=${encodeURIComponent(q)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'TravelMap/1.0 (travelmap)' } });
      if (!r.ok) return null;
      const j = await r.json();
      const pages = (j && j.query && j.query.pages) || {};
      for (const k of Object.keys(pages)) {
        const thumb = pages[k] && pages[k].thumbnail && pages[k].thumbnail.source;
        if (thumb) return thumb;
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const commonsThumb = async () => {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json`
      + `&generator=search&gsrsearch=${encodeURIComponent(q + ' landmark')}`
      + `&gsrnamespace=6&gsrlimit=3&prop=imageinfo&iiprop=url&iiurlwidth=800&redirects=1`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'TravelMap/1.0 (travelmap)' } });
      if (!r.ok) return null;
      const j = await r.json();
      const pages = (j && j.query && j.query.pages) || {};
      for (const k of Object.keys(pages)) {
        const ii = pages[k] && pages[k].imageinfo && pages[k].imageinfo[0];
        if (ii && ii.thumburl) return ii.thumburl;
      }
      return null;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return (await wikiThumb('zh')) || (await wikiThumb('en')) || (await commonsThumb());
}

/* =========================================================
 * 媒体元数据提取（拍摄时间 / 设备 / 位置 等，供查看页信息栏展示）
 * ---------------------------------------------------------
 * 图片：sharp 读出原始 EXIF buffer → exif-reader 解析成结构化字段。
 * 视频：ffprobe 读 format.tags（creation_time / location / Make / Model）。
 * 全部包在 try 里、失败返回 null —— 元数据是"锦上添花"，绝不让它拖垮上传。
 * ========================================================= */

/** 把 EXIF 的 "2023:05:01 14:30:00" 规整成 ISO "2023-05-01T14:30:00" */
function parseExifDateTime(s) {
  if (!s) return '';
  // exif-reader 把日期标签解析成 Date 对象，也可能直接给字符串
  const str = (s instanceof Date)
    ? s.toISOString()
    : (typeof s === 'string' ? s : '');
  if (!str) return '';
  // ISO 格式（exif-reader 多给这种）：2026-10-03T15:28:37.000Z / 2026-10-03T15:28:37Z
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  // EXIF 原始格式：2026:10:03 15:28:37
  m = str.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return str;
}

/** EXIF GPS 可能是十进制数字，也可能是 [度,分,秒] 的数组（exif-reader 不一定会转成十进制）。
 *  每段还可能再包一层数组；按 N/S/E/W 参考方向决定是否取负。 */
function gpsToDecimal(coord, ref) {
  if (coord == null) return null;
  let dec;
  if (typeof coord === 'number') dec = coord;
  else if (Array.isArray(coord)) {
    const pick = (v) => (Array.isArray(v) ? v[0] : v);
    const d = Number(pick(coord[0]));
    const m = Number(pick(coord[1]));
    const s = Number(pick(coord[2]));
    if (![d, m, s].every(Number.isFinite)) return null;
    dec = d + m / 60 + s / 3600;
  } else {
    dec = Number(coord);
  }
  if (!Number.isFinite(dec)) return null;
  if (typeof ref === 'string' && /[SW]/i.test(ref)) dec = -dec;
  return dec;
}

/** EXIF 里部分字段可能是数组（如 ISO=[80,80]），统一取首值转数字 */
function numOr0(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) v = v[0];
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从 sharp 读出的原始 EXIF buffer 解析出展示所需的元数据。
 * 注意：exif-reader 多数情况下把 GPS 给成 [度,分,秒] 数组（而非十进制），由 gpsToDecimal 换算。
 * @returns {object|null} { taken_at, camera_make, camera_model, lens, gps_lat, gps_lng, focal_length, f_number, iso }
 */
function extractImageMeta(exifBuf) {
  if (!exifBuf) return null;
  let data;
  try { data = exifReader(exifBuf); } catch (_) { return null; }
  const img = data.image || {};
  const ex = data.exif || {};
  const gps = data.gps || {};
  const out = {
    camera_make: String(img.Make || '').trim(),
    camera_model: String(img.Model || '').trim(),
    lens: String(ex.LensModel || ex.Lens || '').trim(),
    focal_length: Math.round(numOr0(ex.FocalLength) * 10) / 10,   // 1 位小数：EXIF 常带 5.960000038146973 这类浮点噪音
    f_number: Math.round(numOr0(ex.FNumber) * 100) / 100,
    iso: Math.round(numOr0(ex.ISO)),
  };
  if (ex.DateTimeOriginal) out.taken_at = parseExifDateTime(ex.DateTimeOriginal);
  const lat = gpsToDecimal(gps.GPSLatitude, gps.GPSLatitudeRef);
  const lng = gpsToDecimal(gps.GPSLongitude, gps.GPSLongitudeRef);
  if (lat != null && lng != null) {
    out.gps_lat = +lat.toFixed(6);
    out.gps_lng = +lng.toFixed(6);
  }
  // 全空则不返回，省得写一堆空字段
  const has = out.taken_at || out.camera_make || out.camera_model || out.lens
    || out.gps_lat || out.gps_lng || out.focal_length || out.f_number || out.iso;
  return has ? out : null;
}

/**
 * 视频元数据：ffprobe 取 format.tags。
 *   creation_time → 拍摄时间（ISO，去掉末尾 Z 由前端自由格式化）
 *   location      → QuickTime 格式 "+35.0116+135.7681/"，解析出经纬度
 *   Make / Model  → 部分设备会写
 * @returns {object|null}
 */
function extractVideoMeta(inputPath) {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath]);
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const j = JSON.parse(out || '{}');
        const tags = (j && j.format && j.format.tags) || {};
        const meta = {
          camera_make: '', camera_model: '', lens: '',
          focal_length: 0, f_number: 0, iso: 0, gps_lat: 0, gps_lng: 0,
        };
        if (tags.creation_time) meta.taken_at = String(tags.creation_time).replace(/Z$/, '');
        if (tags.location) {
          const m = String(tags.location).match(/([+-]?\d+(?:\.\d+)?)[ ,]?([+-]?\d+(?:\.\d+)?)/);
          if (m) { meta.gps_lat = parseFloat(m[1]); meta.gps_lng = parseFloat(m[2]); }
        }
        if (tags.Make) meta.camera_make = String(tags.Make).trim();
        if (tags.Model) meta.camera_model = String(tags.Model).trim();
        const has = meta.taken_at || meta.camera_make || meta.camera_model
          || meta.gps_lat || meta.gps_lng;
        resolve(has ? meta : null);
      } catch (_) { resolve(null); }
    });
  });
}

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

app.post('/api/places', write, async (req, res) => {
  try {
    const body = req.body || {};
    const id = createPlace(body);
    /* 新地点：若调用方没自带封面，且地点还没有媒体（新增时通常还没有），
       联网拉一张该地地标图作占位封面（愿望清单场景尤甚）。
       网络可能慢/失败/被墙 → 全部吞掉，占位图留空即可，绝不拖慢保存。 */
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

/* 更新单条媒体：重命名 caption / 补 taken_at / 名称 name / 备注 remark（传什么改什么） */
app.put('/api/media/:id', write, (req, res) => {
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

app.post('/api/types', write, (req, res) => {
  saveTypes(req.body || {});
  res.json({ ok: true });
});

/* ----------------------------- 心愿数据（后端持久化） -----------------------------
   心愿是地点的增强视图：注解（wish/priority/note/target）按 place_id 落到 wish_annotations，
   用户在心愿面板新建的纯目的地落到 wish_places（不进 places 表，故不污染足迹地图/列表）。
   全部受登录保护（write）。 */
app.get('/api/wishes', requireAuth, (_req, res) => {
  res.json(getWishes());
});
/* 写/改某地点的心愿注解（覆盖式：前端传完整的注解对象） */
app.put('/api/wishes/annotations/:placeId', write, (req, res) => {
  try {
    upsertWishAnnotation({ place_id: req.params.placeId, ...(req.body || {}) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});
app.post('/api/wishes/places', write, (req, res) => {
  try {
    const id = saveWishPlace(req.body || {});
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});
app.put('/api/wishes/places/:id', write, (req, res) => {
  try {
    const id = saveWishPlace({ ...(req.body || {}), id: req.params.id });
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});
app.delete('/api/wishes/places/:id', write, (req, res) => {
  try { deleteWishPlace(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message || '删除失败' }); }
});

/* ----------------------------- 批量 GPS 归档 -----------------------------
   analyze：只读，扫描未归类媒体、逐张逆地理编码、聚类，返回可编辑预览。
   apply：落库，按前端确认后的方案新建地点 / 归入已有地点 / 跳过。
   两步分离保证「先看清再写」，避免把照片误归到荒野（坐标中心点）。 */
app.post('/api/gps/analyze', write, async (_req, res) => {
  try {
    res.json(await geocode.analyzeUnassigned());
  } catch (e) {
    res.status(500).json({ error: e.message || '分析失败' });
  }
});
app.post('/api/gps/apply', write, (req, res) => {
  try {
    const r = geocode.applyPlan(req.body || {});
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message || '归档失败' });
  }
});

/* 待整理照片计数：未归类（不属于任何地点）的媒体数量。
   首页「待整理照片」小组件用它做头条数字 —— 未归类照片不在 /api/data 的 places 里，
   前端拿不到，只能单独问一次。只回一个数字，不拉整行。 */
app.get('/api/media/pending', requireAuth, (_req, res) => {
  try {
    res.json({ count: getPendingMediaCount() });
  } catch (e) {
    res.status(500).json({ error: e.message || '读取待整理照片失败' });
  }
});

/* =========================================================
 * multer 上传实例（磁盘暂存到 TMP_DIR，文件名用生成的媒体 id）
 * ---------------------------------------------------------
 * 必须定义在所有引用 upload.single 的路由（/api/profile/avatar、/api/upload）
 * 之前：路由注册在 require 阶段就执行，const 有暂时性死区，放后面会抛
 * "Cannot access 'upload' before initialization"。
 * ========================================================= */
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

/* 备份导入：zip 压缩包走内存（不必落临时盘），上限 2GB（个人级数据足够）。 */
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});
/* ----------------------------- 备份导出 / 导入（zip） ----------------------------- */


/* 导出：把数据库原始行 + 媒体文件打包成 zip 直接下载。
   zip 内结构：
     data.json            —— { version, exportedAt, data:{ types, userProfile, places, trips, trip_places, media } }
                             数据库原始行，程序导入时读这个（唯一的恢复数据源）
     travelmap.db         —— 已 checkpoint 的自洽 SQLite 单文件，纯兜底存档，导入时不读
     media/<key>          —— 各媒体对象文件（图 / 缩略图 / 视频 / 首帧 / 头像），按 key 扁平存放
   受登录保护；用 archiver 流式打包，不落临时盘。 */
app.get('/api/export-zip', requireAuth, async (_req, res) => {
  try {
    const bundle = getExportBundle();
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`travelmap-backup-${new Date().toISOString().slice(0, 10)}.zip`);
    archive.pipe(res);

    archive.append(JSON.stringify(bundle, null, 2), { name: 'data.json' });

    /* 再塞一份「Bootstrap 快照」：checkpoint 后自洽的 SQLite 单文件。
       纯兜底存档（解压即可用 sqlite3 直接查，或整文件拷回 /data 做冷恢复）。
       ⚠️ 导入走的是上面的 data.json，**不读这个文件** —— 它是给人留的后路，
          不是程序的数据源。放在这里是因为它必须先 checkpoint 才能自洽，
          而这事只能在服务端对着正在运行的连接做。 */
    try {
      archive.append(exportDbSnapshot(), { name: 'travelmap.db' });
    } catch (e) {
      console.warn('[export-zip] db 快照打包失败（不影响导出）：', e.message);
    }

    /* 收集需要打包的媒体 key：媒体 url/thumb + 地点/行程封面 + 头像 */
    const keys = new Set();
    for (const m of bundle.data.media) {
      for (const u of [m.url, m.thumb_url]) {
        const k = u ? String(u).split('/media/')[1] : '';
        if (k) keys.add(k);
      }
    }
    for (const p of bundle.data.places) {
      const k = p.cover_url ? String(p.cover_url).split('/media/')[1] : '';
      if (k) keys.add(k);
    }
    for (const t of bundle.data.trips) {
      const k = t.cover_url ? String(t.cover_url).split('/media/')[1] : '';
      if (k) keys.add(k);
    }
    const prof = bundle.data.userProfile;
    if (prof && prof.avatar) {
      const k = String(prof.avatar).split('/media/')[1];
      if (k) keys.add(k);
    }

    for (const k of keys) {
      const buf = await storage.getObjectBuffer(k);
      if (buf) archive.append(buf, { name: 'media/' + k });
    }
    await archive.finalize();
  } catch (e) {
    console.error('[export-zip] 失败:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message || '导出失败' });
  }
});

/* 导入：上传 zip 备份，先回存媒体文件，再在事务里重建数据库。
   受登录保护（write）。导入会覆盖当前全部数据（含媒体），操作前前端已二次确认。 */
app.post('/api/import-zip', write, importUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const AdmZip = require('adm-zip');
    let zip;
    try { zip = new AdmZip(req.file.buffer); }
    catch (_) { return res.status(400).json({ error: '不是有效的 zip 文件' }); }

    const entry = zip.getEntry('data.json');
    if (!entry) return res.status(400).json({ error: '压缩包缺少 data.json' });
    let bundle;
    try { bundle = JSON.parse(zip.readAsText(entry)); }
    catch (_) { return res.status(400).json({ error: 'data.json 解析失败' }); }

    /* 先回存媒体文件（扁平 key，拒绝任何含路径的条目防目录穿越） */
    const mediaEntries = zip.getEntries()
      .filter((en) => !en.isDirectory && en.entryName.startsWith('media/'));
    for (const en of mediaEntries) {
      const key = en.entryName.slice('media/'.length);
      if (!key || key.includes('/') || key.includes('\\') || key.includes('..')) continue;
      try {
        await storage.putObject(key, en.getData(), CTYPE[path.extname(key).toLowerCase()] || 'application/octet-stream');
      } catch (err) {
        console.warn('[import-zip] 写入媒体对象失败：', key, err.message);
      }
    }

    const summary = applyImportBundle(bundle);
    res.json({ ok: true, ...summary });
  } catch (e) {
    console.error('[import-zip] 失败:', e);
    res.status(500).json({ error: e.message || '导入失败' });
  }
});


/* =========================================================
 * 用户资料（单用户：显示名 + 头像，存 meta.userProfile）
 * ---------------------------------------------------------
 * 头像存在媒体后端（/media/<key>），URL 写回 meta；换头像时删旧对象避免孤儿。
 * 默认名 "Coral"（与前端侧栏默认值一致），头像为空时前端回退生成式 SVG。
 * ========================================================= */
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

app.get('/api/profile', requireAuth, (_req, res) => {
  res.json(getProfile());
});

app.put('/api/profile', requireAuth, (req, res) => {
  try { res.json(saveProfile(req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});

/* 通用 meta 读写（设置页用，例如高德逆地理编码 Key）。
   GET 返回 { value }（不存在时为空串）；POST 写入任意 key（仅本机数据库）。 */
app.get('/api/meta/:key', requireAuth, (req, res) => {
  try { res.json({ value: getMeta(req.params.key) || '' }); }
  catch (e) { res.status(500).json({ error: e.message || '读取失败' }); }
});
app.post('/api/meta', write, (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key 必填' });
    setMeta(String(key), value == null ? '' : String(value));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message || '保存失败' }); }
});

/* 头像上传：sharp 裁成 256 方形 webp，存媒体后端，URL 写回 meta */
app.post('/api/profile/avatar', write, upload.single('file'), async (req, res) => {
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

/* ----------------------------- 上传 + 转码 ----------------------------- */
/* （multer 实例 upload 已上移到「用户资料」段之前，见该处说明。） */

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
      /* 先抽元数据（原文件还在），再删原文件，避免 ffprobe 读不到 */
      let vmeta = null;
      try { vmeta = await extractVideoMeta(input); } catch (_) {}
      try { fs.unlinkSync(input); } catch (_) {}
      if (code === 0) {
        try {
          await saveObject(mediaId + '.mp4', mp4, 'video/mp4');
          await saveObject(mediaId + '.jpg', poster, 'image/jpeg');
          markMediaReady(mediaId, '/media/' + mediaId + '.mp4', '/media/' + mediaId + '.jpg');
          if (vmeta) setMediaMeta(mediaId, vmeta);   // 拍摄时间 / 位置等回填
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
  migrateMediaMeta();    // 老库补齐媒体元数据列（幂等）
  ensureGeocitiesLoaded(); // 首次启动把 GeoNames 城市库导入 geocities 表（幂等）
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
