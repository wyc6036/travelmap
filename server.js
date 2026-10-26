/**
 * server.js · 单进程 Express 服务（装配层）
 *
 * 一个容器里同时负责：
 *   1. 托管改造后的 TravelMap 前端（静态文件）
 *   2. /api/data 返回与 places.json 同构的数据（前端 normalize 直接吃）
 *   3. 地点 / 行程 / 媒体 / 心愿 的增删改查（SQLite，路由在 src/routes/）
 *   4. 文件上传 → 转码后存入媒体后端（MinIO 对象存储，未配则回退本地磁盘 /data/media）
 *   5. 图片用 sharp 生成缩略图；视频用 ffmpeg 转 H.264（全平台能播）
 *   6. 单密码登录会话
 *
 * 本文件只做「装配」：中间件（cookie 解析 / gzip / 静态缓存）、路由挂载、启动流程。
 * 各领域路由在 src/routes/{auth,setup,places,media,wishes,backup,profile}.js，
 * 纯逻辑在 src/{landmark,exif,transcode}.js，上传实例在 src/uploads.js。
 *
 * 所有持久数据都在挂载卷 DATA_DIR（默认 /data）下：travelmap.db。
 * 媒体文件存在 MinIO（或回退的本地 media/），经 /media/:key 路由对外提供，
 * 对外 URL 始终是 /media/<key>，与原来本地磁盘方案完全一致。
 */
const express = require('express');
const compression = require('compression');
const path = require('path');

const { DATA_DIR, getExport, maybeSeed, migrateMediaMeta, ensureGeocitiesLoaded } = require('./src/db');
const { AUTH_ENABLED, requireAuth } = require('./src/auth');
const { initStorage, getStorageInfo, ensureBucket } = require('./src/storage');

const WEB_DIR = path.join(__dirname, 'web');
const PORT = Number(process.env.PORT || 8080);

const app = express();
app.disable('x-powered-by');

/* gzip：只压文本类（JSON / JS / CSS / HTML）。
   /media 已经是 webp/mp4 等压缩格式不重复压；/api/export-zip 本身就是 level 9 zip。 */
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/media/') || req.path.startsWith('/api/export-zip')) return false;
    return compression.filter(req, res);
  },
}));

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

/* 静态资源缓存策略：
   - vendor/（maplibre-gl 等大文件）内容随版本走，30 天 + immutable，命中即零请求
   - 其余 JS/CSS 1 天（升级后最迟次日生效，或强刷）
   - HTML 永远 no-cache（每次带 ETag 协商，升级后立即生效）
   注意：前端文件没有内容 hash，所以不能无脑全局长缓存 —— html 是引用入口，必须最先更新。 */
app.use('/vendor', express.static(path.join(WEB_DIR, 'vendor'), { maxAge: '30d', immutable: true }));
app.use(express.static(WEB_DIR, {
  maxAge: '1d',
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

/* 路由挂载（领域拆分见 src/routes/） */
app.use(require('./src/routes/auth'));
app.use(require('./src/routes/setup'));
app.use(require('./src/routes/places'));
app.use(require('./src/routes/media'));
app.use(require('./src/routes/wishes'));
app.use(require('./src/routes/backup'));
app.use(require('./src/routes/profile'));

/* 数据读取（受登录保护）。
   Express 对 res.json 默认带 ETag：数据没变时客户端带 If-None-Match → 304 空体，
   省流量但省不了服务端拼装 —— 数据量大后若要省 CPU，再考虑手工强 ETag 或增量接口。 */
app.get('/api/data', requireAuth, (_req, res) => {
  res.json(getExport());
});

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
    if (!AUTH_ENABLED) {
      console.warn('⚠️  未设置 ADMIN_PASSWORD —— 当前没有任何登录校验，任何能访问本端口的人都能读写你的数据。');
      console.warn('   仅限本机调试；部署到局域网 / 公网前请在 .env 里填 ADMIN_PASSWORD 再重启。');
    }
    console.log(`数据目录：${DATA_DIR}`);
    console.log(`媒体存储：${info.useMinio
      ? `MinIO bucket "${info.minio.bucket}" @ ${info.minio.endpoint}:${info.minio.port}`
      : '本地磁盘 ' + info.local.dir}`);
  });
})();
