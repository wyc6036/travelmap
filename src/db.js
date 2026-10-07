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
  width       INTEGER DEFAULT 0,
  height      INTEGER DEFAULT 0,
  taken_at    TEXT DEFAULT '',
  sort_index  INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'ready',
  created_at  TEXT DEFAULT (datetime('now'))
);
`);

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
    INSERT INTO media (id,place_id,trip_id,kind,url,thumb_url,caption,text_body,width,height,taken_at,sort_index,status)
    VALUES (@id,@place_id,@trip_id,@kind,@url,@thumb_url,@caption,@text_body,@width,@height,@taken_at,@sort_index,@status)
  `),
  setMediaStatus: db.prepare('UPDATE media SET url=?, thumb_url=?, status=? WHERE id=?'),
  setMediaErr: db.prepare("UPDATE media SET status='error' WHERE id=?"),
  getTypes: db.prepare("SELECT value FROM meta WHERE key='types'"),
  setTypes: db.prepare("INSERT INTO meta (key,value) VALUES ('types',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  getMeta: db.prepare("SELECT value FROM meta WHERE key=?"),
  setMeta: db.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
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
  stmt.delPlaceMedia.run(id);
  stmt.delPlace.run(id);
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
  stmt.delTripMedia.run(id);
  stmt.setTripPlaces.run(id);
  stmt.delTrip.run(id);
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
    width: Number(m.width || 0),
    height: Number(m.height || 0),
    taken_at: String(m.taken_at || ''),
    sort_index: Number(m.sort_index || 0),
    status: m.status || 'ready',
  });
  return id;
}

function markMediaReady(id, url, thumb_url) {
  stmt.setMediaStatus.run(url, thumb_url || '', 'ready', id);
}
function markMediaError(id) {
  stmt.setMediaErr.run(id);
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
    const item = { type: m.kind, url: m.url, caption: m.caption, poster: m.thumb_url || '' };
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

module.exports = {
  db, DB_PATH, DATA_DIR,
  uid, saveTypes, getMeta, setMeta,
  createPlace, deletePlace, createTrip, deleteTrip, addMedia,
  markMediaReady, markMediaError,
  getExport, maybeSeed,
};
