/**
 * storage.js · 媒体存储抽象层
 * -----------------------------------------------------------
 * 对外只暴露「按 key 存取对象」，业务层不需要关心底层是 MinIO 还是本地磁盘。
 *
 * 两种存储模式（由运行时配置决定，可在「首次配置向导」里切换）：
 *   - minio：S3 兼容对象存储（内置 MinIO，也可指向自建 MinIO / 阿里云 OSS）
 *   - local：直接写到服务器本地目录（DATA_DIR 下或用户指定的绝对路径）
 *
 * 关键约定：无论后端是谁，业务层写入的「对象 key」就是对外 URL 的尾段，
 * 即 /media/<key>。这样数据库里存的 url 永远是 /media/xxx.webp，
 * 前端 12 个渲染模块、normalize()、getExport() 一行都不用改；
 * 读取时由服务端的 /media/:key 路由去对应后端取流再吐给浏览器。
 */

const Minio = require('minio');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('./db');

/* 运行时可变的存储配置。启动时若 db.meta 里有已保存的 storageConfig，
   就用它覆盖下面的默认值（默认值仍来自环境变量，也就是「内置 MinIO」）。 */
const config = {
  mode: 'minio', // 'minio' | 'local'
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || '',
    port: Number(process.env.MINIO_PORT || 9000),
    useSsl: (process.env.MINIO_USE_SSL || 'false').toLowerCase() === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || '',
    secretKey: process.env.MINIO_SECRET_KEY || '',
    bucket: process.env.MINIO_BUCKET || 'travelmap',
  },
  local: {
    /* 本地模式兜底目录：DATA_DIR 下的 media/。用户在向导里可改成别的路径。 */
    dir: path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'media'),
  },
};

/* 本地回退目录 + 处理用的临时目录（sharp/ffmpeg 必须先落本地再上传） */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const TMP_DIR = process.env.TMP_DIR || path.join(os.tmpdir(), 'travelmap-tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

let client = null;
let useMinio = false;
let localDir = config.local.dir;
let bucketReady = false;

/** 根据当前 config 重建 MinIO 客户端（无 MinIO 模式则为 null）。 */
function rebuildClient() {
  useMinio = config.mode === 'minio'
    && !!(config.minio.endpoint && config.minio.accessKey && config.minio.secretKey);
  if (useMinio) {
    client = new Minio.Client({
      endPoint: config.minio.endpoint,
      port: config.minio.port,
      useSSL: config.minio.useSsl,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
    });
  } else {
    client = null;
    // 本地模式：确保目录存在，且 /media 路由能从这里取流。
    localDir = config.local.dir;
    fs.mkdirSync(localDir, { recursive: true });
  }
}
rebuildClient();

/** 启动时从 db.meta 套用已保存的存储配置（若存在）。 */
async function initStorage() {
  try {
    const saved = db.getMeta('storageConfig');
    if (saved && typeof saved === 'object') {
      config.mode = saved.mode === 'local' ? 'local' : 'minio';
      if (saved.minio && typeof saved.minio === 'object') {
        config.minio = {
          endpoint: String(saved.minio.endpoint ?? config.minio.endpoint),
          port: Number(saved.minio.port ?? config.minio.port),
          useSsl: !!saved.minio.useSsl,
          accessKey: String(saved.minio.accessKey ?? config.minio.accessKey),
          secretKey: String(saved.minio.secretKey ?? config.minio.secretKey),
          bucket: String(saved.minio.bucket ?? config.minio.bucket),
        };
      }
      if (saved.local && saved.local.dir) {
        config.local.dir = String(saved.local.dir);
      }
      rebuildClient();
    }
  } catch (_) {
    /* meta 表尚未就绪等异常：保持环境变量默认值即可 */
  }
}

/** 当前连接信息（含密钥，仅用于已登录后的首配向导预填，不外泄给未登录请求）。 */
function getStorageInfo() {
  return {
    mode: config.mode,
    minio: { ...config.minio },
    local: { dir: config.local.dir },
    useMinio,
  };
}

/** 运行时套用一份新配置（重建 client + 建桶）。返回最终生效的 mode。 */
async function applyConfig(cfg) {
  config.mode = cfg && cfg.mode === 'local' ? 'local' : 'minio';
  if (cfg && cfg.minio && typeof cfg.minio === 'object') {
    config.minio = {
      endpoint: String(cfg.minio.endpoint || ''),
      port: Number(cfg.minio.port || 9000),
      useSsl: !!cfg.minio.useSsl,
      accessKey: String(cfg.minio.accessKey || ''),
      secretKey: String(cfg.minio.secretKey || ''),
      bucket: String(cfg.minio.bucket || 'travelmap'),
    };
  }
  if (cfg && cfg.local && cfg.local.dir) {
    // 解析为绝对路径（相对 DATA_DIR），避免相对路径依赖启动目录。
    const raw = String(cfg.local.dir).trim();
    config.local.dir = raw ? path.resolve(DATA_DIR, raw) : config.local.dir;
  }
  rebuildClient();
  await ensureBucket();
  return config.mode;
}

/** 快速校验一份配置是否可用（不持久化、不建桶等待）：用于首配提交前的连通性测试。 */
async function testConnection(cfg) {
  const mode = cfg && cfg.mode === 'local' ? 'local' : 'minio';
  if (mode === 'local') {
    const raw = String((cfg.local && cfg.local.dir) || '').trim();
    if (!raw) throw new Error('请填写本地目录路径');
    const dir = path.resolve(DATA_DIR, raw);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new Error('目录无法创建：' + e.message);
    }
    return;
  }
  const m = (cfg && cfg.minio) || {};
  const ep = String(m.endpoint || '');
  const ak = String(m.accessKey || '');
  const sk = String(m.secretKey || '');
  if (!ep || !ak || !sk) throw new Error('服务器地址、账号、密码均为必填');
  const probe = new Minio.Client({
    endPoint: ep,
    port: Number(m.port || 9000),
    useSSL: !!m.useSsl,
    accessKey: ak,
    secretKey: sk,
  });
  const bucket = String(m.bucket || 'travelmap');
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时（10 秒）')), 10000));
  await Promise.race([probe.bucketExists(bucket), timeout]);
}

/** 启动时确保 bucket 存在（MinIO 容器可能比本服务晚就绪，带重试）。本地模式无操作。 */
async function ensureBucket() {
  if (!useMinio) return;
  for (let i = 0; i < 15; i += 1) {
    try {
      const ok = await client.bucketExists(config.minio.bucket);
      if (!ok) await client.makeBucket(config.minio.bucket);
      bucketReady = true;
      console.log(`[storage] MinIO bucket 就绪：${config.minio.bucket} (${config.minio.endpoint}:${config.minio.port})`);
      return;
    } catch (e) {
      console.warn(`[storage] MinIO 未就绪（第 ${i + 1} 次重试）：${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  console.error('[storage] MinIO 始终不可用，媒体上传将失败（应用其余功能正常）。');
}

/**
 * 把本地文件作为对象 key 存进去。
 * @param {string} key 对象键（如 "<id>.webp"），也是 /media/<key> 的尾段
 * @param {string} filePath 本地临时文件路径
 * @param {string} contentType MIME 类型
 */
async function saveObject(key, filePath, contentType) {
  if (useMinio) {
    await client.fPutObject(config.minio.bucket, key, filePath, {
      'Content-Type': contentType || 'application/octet-stream',
    });
  } else {
    const dest = path.join(localDir, key);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(filePath, dest);
  }
}

/**
 * 读取对象，返回可读流（MinIO 流 / 本地 ReadStream），不存在返回 null。
 */
async function getObjectStream(key) {
  if (useMinio) {
    try {
      return await client.getObject(config.minio.bucket, key);
    } catch (_) {
      return null;
    }
  }
  const p = path.join(localDir, key);
  if (!fs.existsSync(p)) return null;
  return fs.createReadStream(p);
}

/** 对象是否存在（用于轻量校验）。 */
async function objectExists(key) {
  if (useMinio) {
    try { await client.statObject(config.minio.bucket, key); return true; } catch (_) { return false; }
  }
  return fs.existsSync(path.join(localDir, key));
}

module.exports = {
  getStorageInfo,
  initStorage,
  applyConfig,
  testConnection,
  ensureBucket,
  saveObject,
  getObjectStream,
  objectExists,
  bucketReady: () => bucketReady,
  TMP_DIR,
};
