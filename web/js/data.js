/**
 * data.js · 数据层
 * -----------------------------------------------------------
 * 完全复用 Ref_Globe 的数据契约，并向前兼容扩展：
 *   - normalize()  兼容 coord / 坐标 / lngLat / latLng / position 等写法
 *   - 未知字段一律保留在 place.raw 上，不丢数据
 *   - 每 15 秒轮询 /api/data（CONFIG.pollIntervalMs），内容变化才重建（沿用 Ref_Globe 的 lastRaw 比对策略）
 *   - media[] 归一化，缺省时按地点生成稳定的占位多媒体（便于后续平滑替换真实存储）
 */

import { CONFIG, COLORS, MEDIA_TYPES } from './config.js';
import { pick, parseDate, hashString, warnOnce } from './utils.js';

/* =========================================================
 * 坐标解析：兼容尽可能多的写法
 * ========================================================= */
function parseCoord(source) {
  const c = pick(source, ['coord', '坐标', 'coordinates', 'lngLat', 'latLng', 'position', 'location', '地理坐标']);
  let lng; let lat;

  if (Array.isArray(c) && c.length >= 2) {
    [lng, lat] = c;                                  // 约定 [经度, 纬度]（与 Ref_Globe 一致）
  } else if (c && typeof c === 'object') {
    lng = pick(c, ['lng', 'lon', 'long', 'longitude', '经度']);
    lat = pick(c, ['lat', 'latitude', '纬度']);
  } else if (typeof c === 'string' && c.includes(',')) {
    [lng, lat] = c.split(',').map((s) => Number(s.trim()));
  }

  if (lng === undefined) lng = pick(source, ['lng', 'lon', 'longitude', '经度']);
  if (lat === undefined) lat = pick(source, ['lat', 'latitude', '纬度']);

  lng = Number(lng);
  lat = Number(lat);
  return { lng, lat };
}

/* =========================================================
 * 媒体归一化
 * ========================================================= */
const URL_RE = /^(https?:)?\/\/|^\.{0,2}\/|^data:/i;

function inferMediaType(item) {
  if (typeof item === 'string') return URL_RE.test(item) ? 'image' : 'text';
  const raw = String(pick(item, ['type', '类型', 'kind', 'mediaType'], '')).toLowerCase();
  if (/video|mp4|movie|视频|影片/.test(raw)) return 'video';
  if (/text|note|文字|文本|笔记/.test(raw)) return 'text';
  if (/image|photo|picture|img|图片|照片/.test(raw)) return 'image';

  const url = String(pick(item, ['url', 'src', '地址', 'href'], ''));
  if (/\.(mp4|webm|ogg|mov|m4v)(\?|$)/i.test(url)) return 'video';
  if (/\.(jpe?g|png|webp|gif|avif|svg)(\?|$)/i.test(url)) return 'image';
  if (!url) return 'text';
  return 'image';
}

function normalizeMediaItem(item, place, index) {
  if (item == null) return null;
  const asObject = (typeof item === 'string') ? { url: item } : item;
  if (typeof asObject !== 'object') return null;

  const type = inferMediaType(asObject);
  const url = pick(asObject, ['url', 'src', '地址', 'href', 'source'], '');
  const caption = pick(asObject, ['caption', '说明', 'title', '标题', 'label'], '');
  const text = pick(asObject, ['text', 'content', '正文', '内容', 'body'], '');
  const poster = pick(asObject, ['poster', '封面', 'thumb', 'thumbnail'], '');

  /* 后端（/api/data）会带来 EXIF 元数据，必须逐字段透传——
     ⚠️ 曾在这里只挑 type/url/caption/poster 重建对象，把拍摄时间/设备/参数/GPS
     整体丢掉，导致灯箱信息栏永远显示"没有可用的拍摄信息"（DB 与 API 里都有）。 */
  const meta = {
    takenAt: String(pick(asObject, ['takenAt', 'taken_at'], '') || ''),
    cameraMake: String(pick(asObject, ['cameraMake', 'camera_make'], '') || ''),
    cameraModel: String(pick(asObject, ['cameraModel', 'camera_model'], '') || ''),
    lens: String(pick(asObject, ['lens', '镜头'], '') || ''),
    gpsLat: Number(pick(asObject, ['gpsLat', 'gps_lat'], 0)) || 0,
    gpsLng: Number(pick(asObject, ['gpsLng', 'gps_lng'], 0)) || 0,
    focalLength: Number(pick(asObject, ['focalLength', 'focal_length'], 0)) || 0,
    fNumber: Number(pick(asObject, ['fNumber', 'f_number'], 0)) || 0,
    iso: Number(pick(asObject, ['iso'], 0)) || 0,
  };

  /* id：后端给了真实 id 必须保留（删除/重命名接口靠它寻址），
     纯静态数据没有 id 时才退回按位置的合成 id。 */
  const id = String(pick(asObject, ['id'], `m${index}`) || `m${index}`);

  if (type === 'text') {
    const body = text || caption || url;
    if (!body) return null;
    return { type, text: String(body), caption: String(caption || ''), raw: item, id, ...meta };
  }
  if (!url) return null;
  return {
    type, url: String(url), caption: String(caption || ''),
    poster: poster ? String(poster) : '', raw: item, id,
    ...meta,
  };
}

/**
 * 占位素材已禁用：初始化状态不展示任何演示图/视频，用户上传真实媒体后才显示。
 * 如需恢复演示效果，把 buildPlaceholderMedia 改回原来生成占位图的逻辑即可。
 */
function buildPlaceholderMedia(/* place */) {
  return [];
}

/* =========================================================
 * 地点归一化
 * ========================================================= */
function normalizePlace(source, index) {
  const { lng, lat } = parseCoord(source);
  const name = pick(source, ['name', '名称', '地点名称', 'title', '标题'], `地点${index + 1}`);
  const rawMedia = pick(source, ['media', '多媒体', 'assets', 'galleries', 'mediaList']);

  const place = {
    index,
    id: String(pick(source, ['id', 'slug', 'key'], `p${index}`)),
    name: String(name),
    lng, lat,
    type: String(pick(source, ['type', '类型', 'category', '分类'], '默认')),
    date: String(pick(source, ['date', '日期', 'visitDate', 'startDate'], '') || ''),
    endDate: String(pick(source, ['endDate', '结束日期', 'dateEnd'], '') || ''),
    desc: String(pick(source, ['desc', '描述', 'note', 'notes', 'remark'], '') || ''),
    color: pick(source, ['color', '颜色'], null),
    country: pick(source, ['country', '国家', 'countryName'], null),
    countryCode: pick(source, ['countryCode', 'country_code', 'iso', 'iso2', '国家代码'], null),
    city: pick(source, ['city', '城市'], null),
    cover: pick(source, ['cover', '封面', 'coverImage'], null),
    media: [],
    raw: source,                    // 未知字段全部保留，向后扩展不丢数据
  };

  place.media = Array.isArray(rawMedia)
    ? rawMedia.map((m, i) => normalizeMediaItem(m, place, i)).filter(Boolean)
    : [];
  place.mediaGenerated = false;
  if (!place.media.length) {
    place.media = buildPlaceholderMedia(place);
    place.mediaGenerated = true;
  }

  const d = parseDate(place.date);
  place.dateTs = d.ts;
  place.year = d.y;
  place.hasFutureDate = d.valid && d.ts > Date.now();

  place.mediaCount = {
    image: place.media.filter((m) => m.type === 'image').length,
    video: place.media.filter((m) => m.type === 'video').length,
    text: place.media.filter((m) => m.type === 'text').length,
    total: place.media.length,
  };
  place.cover = place.cover
    || (place.media.find((m) => m.type === 'image' || m.type === 'video')?.url)
    || (place.media.find((m) => m.type === 'video')?.poster)
    || '';

  return place;
}

/**
 * 归一化整份数据。
 * 返回 { types, palette, places, meta }；对任何字段缺失都不抛错。
 */
export function normalize(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const typesIn = (src.types && typeof src.types === 'object') ? src.types : {};
  const types = {};
  for (const [k, v] of Object.entries(typesIn)) {
    if (typeof v === 'string' && v) types[k] = v;
  }

  const placesIn = Array.isArray(src.places) ? src.places
    : (Array.isArray(src) ? src : []);

  const places = placesIn
    .map((p, i) => normalizePlace(p, i))
    .filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat));

  const dropped = placesIn.length - places.length;
  if (dropped > 0) warnOnce('dropped-places', `有 ${dropped} 条地点因坐标缺失/非法被忽略。`);

  return {
    types,
    palette: Object.values(types),
    places,
    trips: normalizeTrips(src.trips || src.行程, places),
    meta: src.meta || src._meta || {},
  };
}

/** 为未在 types 里定义颜色的类型分配兜底色（保持与原逻辑一致的轮转策略） */
export function buildTypeColorMap(types) {
  const map = new Map();
  Object.entries(types).forEach(([k, v]) => map.set(k, v));
  let i = 0;
  return function colorOf(type) {
    const key = String(type || '默认');
    if (map.has(key)) return map.get(key);
    const c = COLORS.typeFallback[i % COLORS.typeFallback.length];
    i += 1;
    map.set(key, c);
    return c;
  };
}

/* =========================================================
 * 行程归一化
 * -----------------------------------------------------------
 * places 是"点"，trips 是"次"：一次行程可以覆盖多座城市，
 * 所以「次旅行」与「城市数」是两个不同口径的统计量。
 * 不写 trips 也能跑：此时「次旅行」退化为有日期的到访记录数。
 * ========================================================= */
function normalizeTrips(rawTrips, places) {
  if (!Array.isArray(rawTrips)) return [];

  const byName = new Map();
  places.forEach((p) => byName.set(p.name, p));

  return rawTrips.map((item, i) => {
    const t = (typeof item === 'string') ? { name: item } : (item || {});
    const names = pick(t, ['places', '地点', 'cities', '城市'], []);
    const list = (Array.isArray(names) ? names : [names])
      .map((n) => (typeof n === 'string' ? byName.get(n.trim()) : null))
      .filter(Boolean);

    // 没写日期时，取行程内最早的地点到访日期
    const fallback = list
      .filter((p) => p.dateTs)
      .sort((a, b) => a.dateTs - b.dateTs)[0];
    const date = String(pick(t, ['date', '日期', 'startDate'], '') || fallback?.date || '');
    const endDate = String(pick(t, ['endDate', '结束日期'], '') || '');
    const d = parseDate(date);

    const trip = {
      id: String(pick(t, ['id', 'slug'], `t${i}`)),
      name: String(pick(t, ['name', '名称', 'title', '标题'], `行程${i + 1}`)),
      date, endDate,
      desc: String(pick(t, ['desc', '描述', 'note'], '') || ''),
      places: list,
      cover: pick(t, ['cover', '封面'], '') || list.find((p) => p.cover)?.cover || '',
      dateTs: d.ts,
      year: d.y,
      raw: t,
    };

    // 反向标注：让地点知道自己属于哪次行程（时间线里可展示）
    list.forEach((p) => { if (!p.trip) p.trip = { id: trip.id, name: trip.name }; });
    return trip;
  }).filter((t) => t.places.length || t.name);
}

/* =========================================================
 * 读取 + 轮询
 * ========================================================= */
let lastRaw = null;

/** 内置兜底数据：/api/data 首次读取失败时（如未登录 / 网络异常）使用 */
const FALLBACK = {
  types: { 居住: '#4E7398', 旅行: '#C86E4A', 目的地: '#7E6C9C' },
  places: [
    { name: '北京', coord: [116.41, 39.90], type: '居住', date: '2019-03-01' },
    { name: '拉萨', coord: [91.14, 29.65], type: '旅行', date: '2022-07-20' },
    { name: '巴黎', coord: [2.35, 48.86], type: '旅行', date: '2018-05-11' },
    { name: '纽约', coord: [-74.01, 40.71], type: '旅行', date: '2017-08-05' },
  ],
};

/**
 * 读取一次 /api/data（首次失败才回退到内置兜底数据）。
 * @param {boolean} isFirst 是否首次加载（首次失败才回退到内置数据）
 * @returns {Promise<{data:object, changed:boolean, fromFallback:boolean}>}
 */
export async function loadPlaces(isFirst = false) {
  let raw = null;
  let fromFallback = false;

  try {
    const res = await fetch(CONFIG.apiBase + '/data', { cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 401) { const e = new Error('unauthorized'); e.status = 401; throw e; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.text();
  } catch (err) {
    if (err.status === 401) throw err; // 冒泡给上层（main.js）去弹登录
    if (!isFirst) return { data: null, changed: false, fromFallback: false };
    warnOnce('data-fallback', `读取数据失败，已使用内置兜底数据：${err.message}`);
    raw = JSON.stringify(FALLBACK);
    fromFallback = true;
  }

  if (raw === lastRaw) return { data: null, changed: false, fromFallback };
  lastRaw = raw;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warnOnce('data-parse', `数据解析失败，已忽略本次更新：${err.message}`);
    return { data: null, changed: false, fromFallback };
  }

  return { data: normalize(parsed), changed: true, fromFallback };
}

/** 启动轮询，返回停止函数。可选 onUnauthorized：轮询拿到 401 时回调（弹登录）。 */
export function startPolling(onData, { onUnauthorized } = {}) {
  if (!CONFIG.poll) return () => {};
  const timer = setInterval(async () => {
    try {
      const { data, changed } = await loadPlaces(false);
      if (changed && data) onData(data);
    } catch (err) {
      if (err && err.status === 401) { onUnauthorized && onUnauthorized(); }
      else warnOnce('poll-error', `轮询失败：${err.message}`);
    }
  }, CONFIG.pollIntervalMs);
  return () => clearInterval(timer);
}

/** 媒体类型合法性 */
export const isValidMediaType = (t) => MEDIA_TYPES.includes(t);
