/**
 * db.js · SQLite 数据层（better-sqlite3，同步 API，适合个人级数据量）
 *
 * 设计取舍：
 * - 单文件数据库落在挂载卷 /data 下，容器重建数据不丢，且能直接 cp 备份。
 * - 表里存的是"归一化后"的字段（lng/lat/name/type...），但对外导出时
 *   重新拼回 places.json 的原始结构（coord:[lng,lat]、media 数组……），
 *   这样前端现有的 normalize() 与 12 个渲染模块一行都不用改。
 * - trip_places 是关联表，专门修掉原 JSON 里 place.trip "先到先得"的坑。
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'travelmap.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS places (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  lng         REAL NOT NULL,
  lat         REAL NOT NULL,
  type        TEXT DEFAULT '默认',
  date        TEXT DEFAULT '',
  end_date    TEXT DEFAULT '',
  desc        TEXT DEFAULT '',
  country_code TEXT DEFAULT '',
  city        TEXT DEFAULT '',
  color       TEXT DEFAULT '',
  cover_url   TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  date        TEXT DEFAULT '',
  end_date    TEXT DEFAULT '',
  desc        TEXT DEFAULT '',
  cover_url   TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trip_places (
  trip_id     TEXT,
  place_id    TEXT,
  sort_order  INTEGER DEFAULT 0,
  PRIMARY KEY (trip_id, place_id)
);
CREATE TABLE IF NOT EXISTS media (
  id          TEXT PRIMARY KEY,
  place_id    TEXT DEFAULT '',
  trip_id     TEXT DEFAULT '',
  kind        TEXT DEFAULT 'image',
  url         TEXT DEFAULT '',
  thumb_url   TEXT DEFAULT '',
  caption     TEXT DEFAULT '',
  text_body   TEXT DEFAULT '',
  /* 名称 / 备注：用户可在照片编辑弹窗里维护（与 caption/笔记相互独立） */
  name        TEXT DEFAULT '',
  remark      TEXT DEFAULT '',
  width       INTEGER DEFAULT 0,
  height      INTEGER DEFAULT 0,
  taken_at    TEXT DEFAULT '',
  /* 媒体元数据（从原文件 EXIF / 视频标签提取，供查看页信息栏展示）。
     缺失即空串 / 0，前端按"有值才显示"渲染。 */
  camera_make TEXT DEFAULT '',
  camera_model TEXT DEFAULT '',
  lens        TEXT DEFAULT '',
  gps_lat     REAL DEFAULT 0,
  gps_lng     REAL DEFAULT 0,
  focal_length REAL DEFAULT 0,
  f_number    REAL DEFAULT 0,
  iso         INTEGER DEFAULT 0,
  sort_index  INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'ready',
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS geocities (
  geonameid   TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  asciiname   TEXT DEFAULT '',
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  country     TEXT DEFAULT '',
  admin1      TEXT DEFAULT '',
  population  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS geocities_latlng ON geocities(lat, lng);
/* 心愿数据（2026-10-17 起由后端持久化，原仅存 localStorage）。
   - wish_annotations：对「已有足迹地点」或「自建心愿地点」的注解（wish 标记 / 优先级 / 备注 / 目标季）。
     place_id 既可指向 places 表里的足迹地点，也可指向 wish_places 表里的自建心愿地点。
   - wish_places：用户在心愿面板「新建」的纯心愿目的地（不在 places 表里，故不会出现在足迹地图/列表中，仅心愿清单可见）。 */
CREATE TABLE IF NOT EXISTS wish_annotations (
  place_id   TEXT PRIMARY KEY,
  wish       INTEGER DEFAULT 0,
  priority   INTEGER DEFAULT 0,
  note       TEXT DEFAULT '',
  target     TEXT DEFAULT '',
  added_at   TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wish_places (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  country    TEXT DEFAULT '',
  lng        REAL DEFAULT 0,
  lat        REAL DEFAULT 0,
  priority   INTEGER DEFAULT 0,
  note       TEXT DEFAULT '',
  target     TEXT DEFAULT '',
  added_at   TEXT DEFAULT (datetime('now'))
);
`);

/* 老库补列必须赶在下面的预备语句之前：stmt.insertMedia / stmt.setMediaMeta
   引用了 media 的 8 个元数据列，若旧库缺列，require 阶段 prepare 就会抛
   "table media has no column named camera_make" 并让进程崩溃循环。
   （migrateMediaMeta 是函数声明，有提升，这里可安全调用下方定义。） */
migrateMediaMeta();

/* ----------------------------- 写入 API ----------------------------- */

function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

const stmt = {
  upsertPlace: db.prepare(`
    INSERT INTO places (id,name,lng,lat,type,date,end_date,desc,country_code,city,color,cover_url,updated_at)
    VALUES (@id,@name,@lng,@lat,@type,@date,@end_date,@desc,@country_code,@city,@color,@cover_url,datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, lng=excluded.lng, lat=excluded.lat, type=excluded.type,
      date=excluded.date, end_date=excluded.end_date, desc=excluded.desc,
      country_code=excluded.country_code, city=excluded.city, color=excluded.color,
      cover_url=excluded.cover_url, updated_at=datetime('now')
  `),
  getPlace: db.prepare('SELECT * FROM places WHERE id=?'),
  delPlace: db.prepare('DELETE FROM places WHERE id=?'),
  delPlaceMedia: db.prepare("DELETE FROM media WHERE place_id=?"),
  delTripMedia: db.prepare("DELETE FROM media WHERE trip_id=?"),
  upsertTrip: db.prepare(`
    INSERT INTO trips (id,name,date,end_date,desc,cover_url)
    VALUES (@id,@name,@date,@end_date,@desc,@cover_url)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, date=excluded.date, end_date=excluded.end_date,
      desc=excluded.desc, cover_url=excluded.cover_url
  `),
  getTrip: db.prepare('SELECT * FROM trips WHERE id=?'),
  delTrip: db.prepare('DELETE FROM trips WHERE id=?'),
  setTripPlaces: db.prepare('DELETE FROM trip_places WHERE trip_id=?'),
  addTripPlace: db.prepare('INSERT OR IGNORE INTO trip_places (trip_id,place_id,sort_order) VALUES (?,?,?)'),
  insertMedia: db.prepare(`
    INSERT INTO media (id,place_id,trip_id,kind,url,thumb_url,caption,text_body,name,remark,width,height,taken_at,
      camera_make,camera_model,lens,gps_lat,gps_lng,focal_length,f_number,iso,sort_index,status)
    VALUES (@id,@place_id,@trip_id,@kind,@url,@thumb_url,@caption,@text_body,@name,@remark,@width,@height,@taken_at,
      @camera_make,@camera_model,@lens,@gps_lat,@gps_lng,@focal_length,@f_number,@iso,@sort_index,@status)
  `),
  /* 媒体元数据（上传后回填：图片走 sharp+exif-reader，视频走 ffprobe） */
  setMediaMeta: db.prepare(`
    UPDATE media SET camera_make=@camera_make, camera_model=@camera_model, lens=@lens,
      gps_lat=@gps_lat, gps_lng=@gps_lng, focal_length=@focal_length, f_number=@f_number, iso=@iso
    WHERE id=@id
  `),
  setMediaStatus: db.prepare('UPDATE media SET url=?, thumb_url=?, status=? WHERE id=?'),
  setMediaErr: db.prepare("UPDATE media SET status='error' WHERE id=?"),
  setPlaceCoverUrl: db.prepare('UPDATE places SET cover_url=? WHERE id=?'),
  getTypes: db.prepare("SELECT value FROM meta WHERE key='types'"),
  setTypes: db.prepare("INSERT INTO meta (key,value) VALUES ('types',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  getMeta: db.prepare("SELECT value FROM meta WHERE key=?"),
  setMeta: db.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  /* 地理编码城市库（GeoNames cities15000，约 3.4 万城市，城市级粒度）。 */
  geocitiesCount: db.prepare('SELECT COUNT(*) AS n FROM geocities'),
  insertGeocity: db.prepare('INSERT OR IGNORE INTO geocities (geonameid,name,asciiname,lat,lng,country,admin1,population) VALUES (?,?,?,?,?,?,?,?)'),
  /* 未归类（place_id 为空）且带 GPS 的媒体：批量归档的分析对象 */
  unassignedGps: db.prepare("SELECT id,kind,url,thumb_url,caption,taken_at,gps_lat,gps_lng FROM media WHERE status='ready' AND (place_id IS NULL OR place_id='') AND (gps_lat<>0 OR gps_lng<>0)"),
  /* 无 GPS 的未归类媒体：需用户手动指派 */
  unassignedNoGps: db.prepare("SELECT id,kind,url,thumb_url,caption,taken_at FROM media WHERE status='ready' AND (place_id IS NULL OR place_id='') AND gps_lat=0 AND gps_lng=0"),
  /* 待整理照片：未归类（place_id 为空）的媒体总数，首页「待整理照片」小组件用它做头条数字。
     只取 COUNT，不拉整行 —— 未归类的照片可能有几百张，widget 每轮渲染都读一次。 */
  pendingMediaCount: db.prepare("SELECT COUNT(*) AS n FROM media WHERE status='ready' AND (place_id IS NULL OR place_id='')"),
  allPlacesLite: db.prepare('SELECT id,name,lng,lat FROM places'),
  assignMedia: db.prepare("UPDATE media SET place_id=? WHERE id=?"),
  /* 心愿：注解（按 place_id 索引）与自建心愿地点 */
  getWishAnnotations: db.prepare('SELECT * FROM wish_annotations'),
  getWishPlaces: db.prepare('SELECT * FROM wish_places'),
  upsertWishAnnotation: db.prepare(`
    INSERT INTO wish_annotations (place_id, wish, priority, note, target, added_at)
    VALUES (@place_id, @wish, @priority, @note, @target, @added_at)
    ON CONFLICT(place_id) DO UPDATE SET
      wish=excluded.wish, priority=excluded.priority, note=excluded.note,
      target=excluded.target, added_at=excluded.added_at
  `),
  delWishAnnotation: db.prepare('DELETE FROM wish_annotations WHERE place_id=?'),
  upsertWishPlace: db.prepare(`
    INSERT INTO wish_places (id, name, country, lng, lat, priority, note, target, added_at)
    VALUES (@id, @name, @country, @lng, @lat, @priority, @note, @target, @added_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, country=excluded.country, lng=excluded.lng, lat=excluded.lat,
      priority=excluded.priority, note=excluded.note, target=excluded.target
  `),
  delWishPlace: db.prepare('DELETE FROM wish_places WHERE id=?'),
};

function saveTypes(types) {
  stmt.setTypes.run(JSON.stringify(types || {}));
}

/* 通用键值读写：用于持久化存储配置（storageConfig）与首配标记（setupDone）。 */
function getMeta(key) {
  const row = stmt.getMeta.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setMeta(key, value) {
  stmt.setMeta.run(key, JSON.stringify(value));
}

function createPlace(p) {
  const id = p.id && String(p.id).startsWith('p_') ? p.id : uid('p');
  const coord = Array.isArray(p.coord) ? p.coord : [Number(p.lng), Number(p.lat)];
  stmt.upsertPlace.run({
    id,
    name: String(p.name || '未命名'),
    lng: Number(coord[0]),
    lat: Number(coord[1]),
    type: String(p.type || '默认'),
    date: String(p.date || ''),
    end_date: String(p.end_date || ''),
    desc: String(p.desc || ''),
    country_code: String(p.countryCode || p.country || ''),
    city: String(p.city || ''),
    color: p.color ? String(p.color) : '',
    cover_url: p.cover ? String(p.cover) : '',
  });
  return id;
}

function deletePlace(id) {
  /* 先取出该地点下媒体的 url / thumb_url（删完 DB 行就查不到了），
     拿到底层对象 key。 */
  const rows = db.prepare('SELECT url, thumb_url FROM media WHERE place_id=?').all(id);
  /* 先删 DB 行（含其下媒体行）：保证地点立刻从地图消失，不依赖底层清理结果。 */
  stmt.delPlaceMedia.run(id);
  stmt.delPlace.run(id);
  /* 再尽力删底层对象（图 / 缩略图 / 视频 / 首帧），失败仅告警，不阻塞主流程。
     storage 通过惰性 require 引入，避免与 storage.js 的循环依赖在加载期互相阻塞。 */
  const keys = [];
  for (const r of rows) {
    for (const u of [r.url, r.thumb_url]) {
      if (!u) continue;
      const k = String(u).split('/media/')[1];
      if (k) keys.push(k);
    }
  }
  if (keys.length) {
    const storage = require('./storage');
    (async () => {
      for (const k of keys) {
        try { await storage.deleteObject(k); }
        catch (e) { console.warn('[deletePlace] 删除底层对象失败：', k, e.message); }
      }
    })();
  }
}

function createTrip(t) {
  const id = t.id && String(t.id).startsWith('t_') ? t.id : uid('t');
  stmt.upsertTrip.run({
    id,
    name: String(t.name || '未命名行程'),
    date: String(t.date || ''),
    end_date: String(t.end_date || ''),
    desc: String(t.desc || ''),
    cover_url: t.cover ? String(t.cover) : '',
  });
  if (Array.isArray(t.places)) {
    stmt.setTripPlaces.run(id);
    t.places.forEach((pid, i) => stmt.addTripPlace.run(id, String(pid), i));
  }
  return id;
}

function deleteTrip(id) {
  /* 先取出该行程下媒体的 url / thumb_url（删完 DB 行就查不到了），
     拿到底层对象 key。 */
  const rows = db.prepare('SELECT url, thumb_url FROM media WHERE trip_id=?').all(id);
  /* 先删 DB 行：行程媒体 + 行程-地点关联 + 行程本体，保证立刻从列表消失。 */
  stmt.delTripMedia.run(id);
  stmt.setTripPlaces.run(id);
  stmt.delTrip.run(id);
  /* 再尽力删底层对象（图 / 缩略图 / 视频 / 首帧），失败仅告警，不阻塞主流程。
     与 deletePlace 同一套做法：storage 惰性 require，避免循环依赖在加载期互相阻塞。
     ⚠️ 注意：delTripMedia 会把"同时挂在某地点上"的媒体行也一起删掉（既有行为），
     这类媒体的底层对象同样在此清理，避免删行不删文件的孤儿残留。 */
  const keys = [];
  for (const r of rows) {
    for (const u of [r.url, r.thumb_url]) {
      if (!u) continue;
      const k = String(u).split('/media/')[1];
      if (k) keys.push(k);
    }
  }
  if (keys.length) {
    const storage = require('./storage');
    (async () => {
      for (const k of keys) {
        try { await storage.deleteObject(k); }
        catch (e) { console.warn('[deleteTrip] 删除底层对象失败：', k, e.message); }
      }
    })();
  }
}

function addMedia(m) {
  const id = uid('m');
  stmt.insertMedia.run({
    id,
    place_id: m.place_id ? String(m.place_id) : '',
    trip_id: m.trip_id ? String(m.trip_id) : '',
    kind: String(m.kind || 'image'),
    url: String(m.url || ''),
    thumb_url: m.thumb_url ? String(m.thumb_url) : '',
    caption: String(m.caption || ''),
    text_body: String(m.text_body || ''),
    name: String(m.name || ''),
    remark: String(m.remark || ''),
    width: Number(m.width || 0),
    height: Number(m.height || 0),
    taken_at: String(m.taken_at || ''),
    camera_make: String(m.camera_make || ''),
    camera_model: String(m.camera_model || ''),
    lens: String(m.lens || ''),
    gps_lat: Number(m.gps_lat || 0),
    gps_lng: Number(m.gps_lng || 0),
    focal_length: Number(m.focal_length || 0),
    f_number: Number(m.f_number || 0),
    iso: Number(m.iso || 0),
    sort_index: Number(m.sort_index || 0),
    status: m.status || 'ready',
  });
  return id;
}

/**
 * 上传后回填媒体元数据（EXIF / 视频标签提取结果）。
 * 只更新这 8 个元数据列，不动 url / 宽高 / 状态，便于视频在转码完（markMediaReady）后再补。
 */
function setMediaMeta(id, m) {
  if (!m) return false;
  stmt.setMediaMeta.run({
    id: String(id),
    camera_make: String(m.camera_make || ''),
    camera_model: String(m.camera_model || ''),
    lens: String(m.lens || ''),
    gps_lat: Number(m.gps_lat || 0),
    gps_lng: Number(m.gps_lng || 0),
    focal_length: Number(m.focal_length || 0),
    f_number: Number(m.f_number || 0),
    iso: Number(m.iso || 0),
  });
  return true;
}

function markMediaReady(id, url, thumb_url) {
  stmt.setMediaStatus.run(url, thumb_url || '', 'ready', id);
}
function markMediaError(id) {
  stmt.setMediaErr.run(id);
}

/**
 * 更新单条媒体的可编辑字段（目前支持 caption 重命名、taken_at 拍摄时间）。
 * 只改调用方显式传入的字段，未传的保持原值。
 * @returns {boolean} 是否真的改到了行（id 不存在返回 false）
 */
function updateMedia(id, fields) {
  if (!fields || typeof fields !== 'object') return false;
  const sets = [];
  const vals = [];
  if (typeof fields.caption === 'string') { sets.push('caption = ?'); vals.push(fields.caption); }
  if (typeof fields.taken_at === 'string') { sets.push('taken_at = ?'); vals.push(fields.taken_at); }
  if (typeof fields.name === 'string') { sets.push('name = ?'); vals.push(fields.name); }
  if (typeof fields.remark === 'string') { sets.push('remark = ?'); vals.push(fields.remark); }
  if (!sets.length) return false;
  vals.push(id);
  const r = db.prepare(`UPDATE media SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return r.changes > 0;
}

/**
 * 写入 / 清空某地点的封面图（cover_url）。
 * - 占位图场景：新增愿望清单地点时由服务端联网拉取地标图后写入。
 * - 清理场景：用户上传真实媒体后把占位图 URL 置空（封面改由媒体兜底），
 *   满足"上传媒体后占位图需完全被清理掉"。
 * @param {string} id   地点 id
 * @param {string|null} url  封面 URL；传 null/'' 表示清空
 */
function setPlaceCoverUrl(id, url) {
  stmt.setPlaceCoverUrl.run(String(url == null ? '' : url), String(id));
  return true;
}

/* ----------------------------- 心愿数据（后端持久化） ----------------------------- */

/**
 * 读取全部心愿数据：注解（按 place_id）+ 自建心愿地点。
 * addedAt 统一规范成数字（前端排序用），避免 SQLite 文本与 localStorage 数字混用。
 * @returns {{annotations: object, places: Array}}
 */
function getWishes() {
  const annotations = {};
  for (const a of stmt.getWishAnnotations.all()) {
    annotations[a.place_id] = {
      wish: !!a.wish,
      priority: Number(a.priority) || 0,
      note: a.note || '',
      target: a.target || '',
      addedAt: a.added_at != null ? Number(a.added_at) || a.added_at : null,
    };
  }
  const places = stmt.getWishPlaces.all().map((p) => ({
    id: p.id,
    name: p.name,
    country: p.country || '',
    countryZh: p.country || '',
    lng: p.lng != null ? Number(p.lng) : null,
    lat: p.lat != null ? Number(p.lat) : null,
    priority: Number(p.priority) || 0,
    note: p.note || '',
    target: p.target || '',
    addedAt: p.added_at != null ? Number(p.added_at) || p.added_at : null,
    type: '目的地',
    isWishNew: true,
    media: [],
    mediaCount: { image: 0, video: 0, text: 0, total: 0 },
    cover: '',
  }));
  return { annotations, places };
}

/**
 * 写入 / 更新某地点的心愿注解（覆盖式：传什么改什么由调用方决定）。
 * @param {object} a { place_id, wish, priority, note, target, addedAt }
 */
function upsertWishAnnotation(a) {
  if (!a || !a.place_id) return false;
  stmt.upsertWishAnnotation.run({
    place_id: String(a.place_id),
    wish: a.wish ? 1 : 0,
    priority: Number(a.priority || 0),
    note: String(a.note || ''),
    target: String(a.target || ''),
    added_at: a.addedAt != null ? String(a.addedAt) : new Date().toISOString(),
  });
  return true;
}

/** 删除某地点的心愿注解（移出清单时 wish=false 仅覆盖，这里则彻底清行）。 */
function deleteWishAnnotation(placeId) {
  stmt.delWishAnnotation.run(String(placeId));
  return true;
}

/**
 * 写入 / 更新一个自建心愿地点（upsert，按 id）。
 * id 由前端生成（形如 wish-...），便于乐观更新与服务端一致；缺省则服务端生成。
 * @param {object} p { id?, name, country, lng, lat, priority, note, target, addedAt }
 * @returns {string} 实际写入的 id
 */
function saveWishPlace(p) {
  const id = p && p.id ? String(p.id) : uid('wish');
  stmt.upsertWishPlace.run({
    id,
    name: String((p && p.name) || '未命名'),
    country: String((p && p.country) || ''),
    lng: p && p.lng != null ? Number(p.lng) : null,
    lat: p && p.lat != null ? Number(p.lat) : null,
    priority: Number((p && p.priority) || 0),
    note: String((p && p.note) || ''),
    target: String((p && p.target) || ''),
    added_at: p && p.addedAt != null ? String(p.addedAt) : new Date().toISOString(),
  });
  return id;
}

/** 删除自建心愿地点（同时清掉它的注解行）。 */
function deleteWishPlace(id) {
  stmt.delWishPlace.run(String(id));
  stmt.delWishAnnotation.run(String(id));
  return true;
}

/* ----------------------------- 批量 GPS 归档（地理编码） ----------------------------- */

/** 把媒体指派到某地点（批量归档的核心写操作）。 */
function assignMediaToPlace(mediaId, placeId) {
  stmt.assignMedia.run(String(placeId || ''), String(mediaId));
  return true;
}

/** 未归类且带 GPS 的媒体（分析对象）。 */
function getUnassignedMediaWithGps() {
  return stmt.unassignedGps.all();
}

/** 未归类且无 GPS 的媒体（需手动指派）。 */
function getUnassignedNoGps() {
  return stmt.unassignedNoGps.all();
}

/** 未归类媒体的总数（含无 GPS 的），只回一个数字。 */
function getPendingMediaCount() {
  return stmt.pendingMediaCount.get().n;
}

/** 全部地点的轻量字段（用于「距已有地点多近就归入」的距离匹配）。 */
function getAllPlacesLite() {
  return stmt.allPlacesLite.all();
}

/** geocities 表当前行数（0 表示城市库尚未导入，逆地理编码不可用）。 */
function getGeocitiesCount() {
  return stmt.geocitiesCount.get().n;
}

/**
 * 把 GeoNames cities15000.txt（tab 分隔，19 列）解析并批量写入 geocities 表。
 * 取列：0=geonameid 1=name 2=asciiname 4=纬度 5=经度 8=国家码 10=admin1 14=人口。
 * 用事务包裹，整批失败回滚；已存在的 geonameid 走 INSERT OR IGNORE（幂等可重跑）。
 * @param {string} txtPath
 * @returns {number} 实际插入行数
 */
function importGeocities(txtPath) {
  const content = fs.readFileSync(txtPath, 'utf8');
  const lines = content.split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split('\t');
    if (c.length < 6) continue;
    const lat = parseFloat(c[4]);
    const lng = parseFloat(c[5]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const population = parseInt(c[14] || '0', 10) || 0;
    rows.push([c[0], c[1], c[2] || c[1], lat, lng, c[8] || '', c[10] || '', population]);
  }
  const ins = db.transaction((rs) => { for (const r of rs) stmt.insertGeocity.run(r); });
  ins(rows);
  return rows.length;
}

/**
 * 启动时确保城市库已导入（幂等）：表为空且镜像内 / 数据目录里能找到
 * cities15000.txt 才导入；否则打印警告并降级（批量归档退化为「手动归类」，
 * 不影响其余功能）。导入只发生一次（表在挂载卷 /data 的库里，重建容器不丢）。
 * @returns {number} 库内城市行数
 */
function ensureGeocitiesLoaded() {
  try {
    const n = getGeocitiesCount();
    if (n > 0) return n;
    const candidates = [
      path.join(__dirname, '..', 'geonames', 'cities15000.txt'),
      path.join(DATA_DIR, 'geonames', 'cities15000.txt'),
      '/app/geonames/cities15000.txt',
    ];
    const file = candidates.find((p) => {
      try { return fs.existsSync(p); } catch { return false; }
    });
    if (!file) {
      console.warn('[geocode] 未找到 cities15000.txt，逆地理编码不可用（批量 GPS 归档将退化为手动归类）');
      return 0;
    }
    const cnt = importGeocities(file);
    console.log(`[geocode] 已从 ${file} 导入 ${cnt} 个城市到 geocities 表`);
    return cnt;
  } catch (e) {
    console.error('[geocode] 导入城市库失败：', e.message);
    return 0;
  }
}

/**
 * 删除单条媒体：先删 DB 行，再尽力删底层对象（图 + 缩略图 / 视频 + 首帧）。
 * storage 通过惰性 require 引入，避免与 storage.js 的循环依赖在加载期互相阻塞。
 * @returns {Promise<boolean>} 是否真的删到了（没找到返回 false）
 */
async function deleteMedia(id) {
  const row = db.prepare('SELECT id, url, thumb_url FROM media WHERE id=?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM media WHERE id=?').run(id);
  const storage = require('./storage');
  const keys = [row.url, row.thumb_url]
    .map((u) => (u ? String(u).split('/media/')[1] : ''))
    .filter(Boolean);
  for (const k of keys) {
    try { await storage.deleteObject(k); } catch (_) { /* 对象已丢失不影响结果 */ }
  }
  return true;
}

/* ----------------------------- 导出 API ----------------------------- */

function getExport() {
  const typesRow = stmt.getTypes.get();
  const types = typesRow ? JSON.parse(typesRow.value || '{}') : {};
  const placeRows = db.prepare('SELECT * FROM places ORDER BY created_at').all();
  const mediaRows = db.prepare("SELECT * FROM media WHERE status='ready' ORDER BY sort_index, created_at").all();
  const tripRows = db.prepare('SELECT * FROM trips').all();
  const tpRows = db.prepare('SELECT trip_id, place_id, sort_order FROM trip_places ORDER BY sort_order').all();
  const nameById = Object.fromEntries(placeRows.map((p) => [p.id, p.name]));

  const mediaByPlace = {};
  const mediaByTrip = {};
  for (const m of mediaRows) {
    const item = {
      id: m.id, type: m.kind, url: m.url, caption: m.caption, poster: m.thumb_url || '',
      name: m.name || '', remark: m.remark || '',
      takenAt: m.taken_at || '',
      cameraMake: m.camera_make || '', cameraModel: m.camera_model || '', lens: m.lens || '',
      gpsLat: Number(m.gps_lat) || 0, gpsLng: Number(m.gps_lng) || 0,
      focalLength: Number(m.focal_length) || 0, fNumber: Number(m.f_number) || 0, iso: Number(m.iso) || 0,
    };
    if (m.text_body) item.text = m.text_body;
    if (m.place_id) (mediaByPlace[m.place_id] ||= []).push(item);
    if (m.trip_id) (mediaByTrip[m.trip_id] ||= []).push(item);
  }

  const places = placeRows.map((p) => ({
    id: p.id,
    name: p.name,
    coord: [p.lng, p.lat],
    type: p.type,
    date: p.date,
    endDate: p.end_date,
    desc: p.desc,
    country: p.country_code,
    countryCode: p.country_code,
    city: p.city,
    color: p.color || null,
    cover: p.cover_url || null,
    media: mediaByPlace[p.id] || [],
  }));

  const trips = tripRows.map((t) => ({
    id: t.id,
    name: t.name,
    date: t.date,
    endDate: t.end_date,
    desc: t.desc,
    cover: t.cover_url || '',
    places: tpRows.filter((r) => r.trip_id === t.id).map((r) => nameById[r.place_id]).filter(Boolean),
  }));

  return { types, places, trips };
}

/* ----------------------------- 备份迁移 ----------------------------- */

/**
 * 导出完整数据集（供打包成 zip 备份）。
 * 与 getExport() 不同：这里导出的是「数据库原始行」而非前端归一化结构，
 * 且 media 表全量导出（含处理中 / 失败态，便于精确还原），
 * 连同 types（类型调色板）与 userProfile（用户名 + 头像）一起带回。
 * 媒体文件本身由 server 端按 url/thumb_url 去存储后端取流打包。
 * @returns {{version:number, exportedAt:string, data:object}}
 */
function getExportBundle() {
  const typesRow = stmt.getTypes.get();
  const types = typesRow ? JSON.parse(typesRow.value || '{}') : {};
  const profile = getMeta('userProfile') || null;
  const places = db.prepare('SELECT * FROM places').all();
  const trips = db.prepare('SELECT * FROM trips').all();
  const tripPlaces = db.prepare('SELECT trip_id, place_id, sort_order FROM trip_places').all();
  const media = db.prepare('SELECT * FROM media').all();
  const wishAnnotations = db.prepare('SELECT * FROM wish_annotations').all();
  const wishPlaces = db.prepare('SELECT * FROM wish_places').all();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: { types, userProfile: profile, places, trips, trip_places: tripPlaces, media, wish_annotations: wishAnnotations, wish_places: wishPlaces },
  };
}

/**
 * 导出一份自洽的 SQLite 单文件快照（Buffer），随备份 zip 一起存档。
 *
 * ⚠️ 为什么必须先 checkpoint：本库开了 WAL 模式，服务运行期间**近期写入都还堆在
 *    travelmap.db-wal 里**（实测主库文件可以一整天没动过）。若直接读主库文件打包，
 *    拿到的会是一个落后若干个事务的库 —— 单独 cp .db 恢复就会静默丢数据。
 *    `wal_checkpoint(TRUNCATE)` 把 WAL 内容写回主库并把日志截断归零，
 *    此后 travelmap.db 自身即完整自洽，可以直接 sqlite3 打开。
 *
 * checkpoint 是**尽力而为**：若此刻恰有并发写事务，它可能只 checkpoint 一部分。
 * 这只影响快照的"新鲜度"，不影响主流程 —— 恢复走的是 data.json，
 * 这个 .db 文件只是给人的**兜底存档**，不是导入的数据源。
 * @returns {Buffer}
 */
function exportDbSnapshot() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.warn('[export] checkpoint 失败（快照可能略滞后）：', e.message);
  }
  return fs.readFileSync(DB_PATH);
}

/** 从形如 "/media/<key>" 的 URL 里抽出对象 key；非本地对象（远程 URL）返回空串。 */
function collectKeysFromUrls(urls) {
  const keys = [];
  for (const u of urls) {
    if (!u) continue;
    const k = String(u).split('/media/')[1];
    if (k) keys.push(k);
  }
  return keys;
}

/**
 * 按当前库的列定义，把一组行安全插入某表。
 * 取「数据库列 ∩ 行字段」的交集，避免导出方与导入方 schema 版本不一致时
 * （导出方多列 / 导入方缺列，或反之）INSERT 报错；缺失的列走 DEFAULT。
 * @param {string} table 表名
 * @param {Array<object>} rows 原始行（字段名即列名）
 */
function insertRowsSafe(table, rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const dbCols = new Set((db.pragma(`table_info(${table})`) || []).map((c) => c.name));
  const cols = Object.keys(rows[0]).filter((k) => dbCols.has(k));
  if (!cols.length) return;
  const stmtIns = db.prepare(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`,
  );
  const run = db.transaction((rs) => { for (const r of rs) stmtIns.run(r); });
  run(rows);
}

/**
 * 导入完整数据集：在一个事务里清空旧表、重建新数据，并回设 types / userProfile。
 * 媒体文件本身由 server 端先 putObject 回存，这里只处理数据库。
 * 导入前先快照「旧库引用的对象 key」，导入后删掉「新数据不再引用」的孤儿对象，
 * 避免恢复后底层存储残留上一版的文件（与删除链路的"不留垃圾"一致）。
 * @param {{version?:number, data:object}} bundle 解析自 data.json
 * @returns {{places:number, trips:number, media:number, orphansDeleted:number}}
 */
function applyImportBundle(bundle) {
  if (!bundle || !bundle.data || typeof bundle.data !== 'object') {
    throw new Error('压缩包内容无效：缺少 data 字段');
  }
  const d = bundle.data;
  const requireArr = (name) => {
    if (!Array.isArray(d[name])) throw new Error(`压缩包内容无效：缺少 ${name} 数组`);
    return d[name];
  };
  const places = requireArr('places');
  const trips = requireArr('trips');
  const tripPlaces = requireArr('trip_places');
  const media = requireArr('media');

  // 旧对象 key 快照（导入前先取，事务内 DELETE 后就查不到了）
  const oldKeys = new Set();
  for (const r of db.prepare('SELECT url, thumb_url FROM media').all()) {
    collectKeysFromUrls([r.url, r.thumb_url]).forEach((k) => oldKeys.add(k));
  }
  const oldAvatar = getMeta('userProfile');
  if (oldAvatar && oldAvatar.avatar) collectKeysFromUrls([oldAvatar.avatar]).forEach((k) => oldKeys.add(k));

  // 新对象 key 集合（导入后保留，其余旧 key 视为孤儿）
  const newKeys = new Set();
  for (const m of media) collectKeysFromUrls([m.url, m.thumb_url]).forEach((k) => newKeys.add(k));
  const prof = d.userProfile;
  if (prof && prof.avatar) collectKeysFromUrls([prof.avatar]).forEach((k) => newKeys.add(k));
  for (const p of places) collectKeysFromUrls([p.cover_url]).forEach((k) => newKeys.add(k));
  for (const t of trips) collectKeysFromUrls([t.cover_url]).forEach((k) => newKeys.add(k));

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM trip_places').run();
    db.prepare('DELETE FROM media').run();
    db.prepare('DELETE FROM places').run();
    db.prepare('DELETE FROM trips').run();
    db.prepare('DELETE FROM wish_annotations').run();
    db.prepare('DELETE FROM wish_places').run();
    insertRowsSafe('places', places);
    insertRowsSafe('trips', trips);
    insertRowsSafe('trip_places', tripPlaces);
    insertRowsSafe('media', media);
    insertRowsSafe('wish_annotations', d.wish_annotations || []);
    insertRowsSafe('wish_places', d.wish_places || []);
    if (d.types && typeof d.types === 'object') stmt.setTypes.run(JSON.stringify(d.types));
    if (prof && typeof prof === 'object') stmt.setMeta.run('userProfile', JSON.stringify(prof));
  });
  tx();

  // 清理孤儿：删掉旧库里、新数据不再引用的对象（尽力删，失败仅告警，不阻塞）
  const orphans = [...oldKeys].filter((k) => !newKeys.has(k));
  if (orphans.length) {
    const storage = require('./storage');
    (async () => {
      for (const k of orphans) {
        try { await storage.deleteObject(k); }
        catch (e) { console.warn('[import] 清理孤儿对象失败：', k, e.message); }
      }
    })();
  }
  return {
    places: places.length,
    trips: trips.length,
    media: media.length,
    orphansDeleted: orphans.length,
  };
}

/* ----------------------------- 种子迁移 ----------------------------- */

/**
 * 如果库是空的，且 /data/seed/places.json 存在，就把它导进来。
 * 复用原字段名（coord / type / media / trips[].places 名称数组），
 * 自动跳过 raw.generated===true 的占位图（那是前端合成的假数据）。
 */
function maybeSeed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM places').get().n;
  if (count > 0) return false;
  /* 种子来源优先级：① 挂载卷里用户放进去的 /data/seed/places.json（便于手动迁移）；
     ② 镜像内自带的 /app/seed/places.json（Dockerfile 把现有 38 个地点打进镜像，
        首次启动即有数据，不必从空库开始）。两者都没有则留空库，让用户自己上传。 */
  const userSeed = path.join(DATA_DIR, 'seed', 'places.json');
  const bundledSeed = path.join(__dirname, '..', 'seed', 'places.json');
  const seedPath = fs.existsSync(userSeed) ? userSeed
    : (fs.existsSync(bundledSeed) ? bundledSeed : null);
  if (!seedPath) return false;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  } catch (e) {
    console.error('[seed] places.json 解析失败，跳过：', e.message);
    return false;
  }
  const src = raw && typeof raw === 'object' ? raw : {};
  if (src.types) saveTypes(src.types);
  const placeIdByName = {};
  for (const p of (src.places || [])) {
    const id = createPlace(p);
    placeIdByName[p.name] = id;
    for (const m of (p.media || [])) {
      const isGenerated = m && m.raw && m.raw.generated === true;
      if (isGenerated) continue; // 跳过 picsum 占位
      if (m && (m.url || m.text)) {
        addMedia({
          place_id: id,
          kind: m.type || (/\.(mp4|webm|mov)$/i.test(m.url || '') ? 'video' : 'image'),
          url: m.url || '',
          thumb_url: m.poster || '',
          caption: m.caption || '',
          text_body: m.text || '',
        });
      }
    }
  }
  for (const t of (src.trips || [])) {
    const placeIds = (t.places || [])
      .map((n) => placeIdByName[n])
      .filter(Boolean);
    createTrip({ ...t, places: placeIds });
  }
  console.log('[seed] 已从 seed/places.json 导入', (src.places || []).length, '个地点');
  return true;
}

/**
 * 媒体元数据迁移：老库（或老种子）的 media 表可能缺少 8 个元数据列，
 * 这里在启动时按需 ALTER 补齐，避免 SELECT * 取到 undefined 字段。
 * 用 PRAGMA table_info 探测，缺哪一列补哪一列（幂等，可反复跑）。
 */
function migrateMediaMeta() {
  const have = new Set((db.pragma('table_info(media)') || []).map((c) => c.name));
  const numericReal = ['gps_lat', 'gps_lng', 'focal_length', 'f_number'];
  for (const col of ['camera_make', 'camera_model', 'lens', 'gps_lat', 'gps_lng', 'focal_length', 'f_number', 'iso', 'name', 'remark']) {
    if (!have.has(col)) {
      const type = numericReal.includes(col) ? 'REAL' : (col === 'iso' ? 'INTEGER' : 'TEXT');
      try { db.prepare(`ALTER TABLE media ADD COLUMN ${col} ${type} DEFAULT ''`).run(); }
      catch (e) { console.warn('[migrate] media 加列失败', col, e.message); }
    }
  }
}

module.exports = {
  db, DB_PATH, DATA_DIR,
  uid, saveTypes, getMeta, setMeta,
  createPlace, deletePlace, createTrip, deleteTrip, addMedia, deleteMedia,
  updateMedia, setPlaceCoverUrl, setMediaMeta, migrateMediaMeta,
  markMediaReady, markMediaError,
  getExport, getExportBundle, applyImportBundle, exportDbSnapshot, maybeSeed,
  assignMediaToPlace, getUnassignedMediaWithGps, getUnassignedNoGps, getPendingMediaCount,
  getAllPlacesLite, getGeocitiesCount, importGeocities, ensureGeocitiesLoaded,
  getWishes, upsertWishAnnotation, deleteWishAnnotation, saveWishPlace, deleteWishPlace,
};
