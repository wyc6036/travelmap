/**
 * geo.js · 国家边界与归属判定
 * -----------------------------------------------------------
 * 职责：
 *   1. 加载 world.json（Natural Earth 110m，本地文件，见 tools/build-world-json.py）
 *   2. 建立 唯一键 / 别名 → feature 的索引
 *   3. 把地点归属到国家：
 *      ① places.json 明确写了 countryCode / country / 国家  → 直接按值匹配（最高优先级）
 *      ② 没写 → 用坐标做点落多边形（ray casting），110m 精度足够国家级别
 *   4. 汇总"已访问国家"，供上色与统计使用
 *
 * 合规约定：feature.properties.parent 存在时（当前只有台湾 → CHN），
 * 归属与取色一律以 parent 为准，且 count=false 不单独计入国家/地区数量。
 */

import { CONFIG } from './config.js';

let world = null;               // 原始 FeatureCollection
let features = [];              // 预处理后的 feature 列表
const byKey = new Map();        // 归一化键 → feature
let ready = false;

/* =========================================================
 * 点落多边形（ray casting）
 * ========================================================= */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0]; const yi = ring[i][1];
    const xj = ring[j][0]; const yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat))
      && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(lng, lat, rings) {
  // rings[0] = 外环，其余为洞
  if (!rings.length || !pointInRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (pointInRing(lng, lat, rings[i])) return false;
  }
  return true;
}

function pointInFeature(lng, lat, feat) {
  const [minX, minY, maxX, maxY] = feat.bbox;
  if (lng < minX || lng > maxX || lat < minY || lat > maxY) return false;

  const g = feat.geometry;
  if (!g) return false;
  if (g.type === 'Polygon') return pointInPolygonCoords(lng, lat, g.coordinates);
  if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates) {
      if (pointInPolygonCoords(lng, lat, poly)) return true;
    }
  }
  return false;
}

function bboxOf(geometry) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const scan = (coords) => {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      return;
    }
    coords.forEach(scan);
  };
  scan(geometry.coordinates);
  return [minX, minY, maxX, maxY];
}

/* =========================================================
 * 索引
 * ========================================================= */
const normKey = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s._'-]/g, '');

function indexFeature(feat) {
  const p = feat.properties || {};
  const keys = [p.id, p.iso2, p.iso3, p.name, p.zh, ...(p.alt || [])];
  for (const k of keys) {
    const nk = normKey(k);
    if (nk && !byKey.has(nk)) byKey.set(nk, feat);
  }
}

/** 加载并预处理 world.json */
export async function loadWorld(url = CONFIG.worldUrl) {
  if (ready) return world;
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`加载 ${url} 失败：HTTP ${res.status}`);
  world = await res.json();

  features = (world.features || []).map((f) => {
    const feat = {
      id: f.properties?.id || f.properties?.iso3 || String(f.id),
      properties: f.properties || {},
      geometry: f.geometry,
    };
    feat.bbox = feat.geometry ? bboxOf(feat.geometry) : [0, 0, 0, 0];
    indexFeature(feat);
    return feat;
  });

  ready = true;
  return world;
}

export const isWorldReady = () => ready;
export const getFeatures = () => features;

export function getFeature(id) {
  if (!id) return null;
  return byKey.get(normKey(id)) || null;
}

/** 图面/统计用的"有效 id"：台湾等特殊 feature 归并到 parent */
export function effectiveId(feature) {
  return feature?.properties?.parent || feature?.properties?.id || null;
}

export function countsAsCountry(feature) {
  const p = feature?.properties;
  if (!p) return false;
  return p.count !== false;
}

/* =========================================================
 * 归属判定
 * ========================================================= */
/** 纯几何判定 */
export function countryAt(lng, lat) {
  for (const feat of features) {
    if (pointInFeature(lng, lat, feat)) return feat;
  }
  return null;
}

/* ---------------------------------------------------------
 * 沿海城市兜底
 * ---------------------------------------------------------
 * Natural Earth 110m 的海岸线是高度概化的：像威海、伊斯坦布尔这类
 * 紧贴海岸或跨海峡的城市，坐标会落在"海里"，直接点落多边形会判定失败。
 * 这里补一层"最近陆地"判定：只有当点不属于任何国家时才会触发，
 * 且限定在 MAX_SNAP_DEG 之内，避免把公海上的点乱归属。
 */
const MAX_SNAP_DEG = 0.35;      // ≈ 30~39 km

function pointSegmentDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}

function ringDist2(lng, lat, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const d = pointSegmentDist2(lng, lat, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (d < best) best = d;
  }
  return best;
}

function featureDist2(lng, lat, feat) {
  // bbox 预筛：点离 bbox 的距离已经超过容忍半径就直接跳过
  const [minX, minY, maxX, maxY] = feat.bbox;
  const dx = lng < minX ? minX - lng : (lng > maxX ? lng - maxX : 0);
  const dy = lat < minY ? minY - lat : (lat > maxY ? lat - maxY : 0);
  if (dx * dx + dy * dy > MAX_SNAP_DEG ** 2) return Infinity;

  const g = feat.geometry;
  if (!g) return Infinity;
  let best = Infinity;
  const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p) => p[0]);
  for (const ring of rings) {
    const d = ringDist2(lng, lat, ring);
    if (d < best) best = d;
  }
  return best;
}

/** 找最近的陆地国家；超出容忍半径返回 null */
export function nearestCountry(lng, lat) {
  let best = null;
  let bestD = MAX_SNAP_DEG ** 2;
  for (const feat of features) {
    const d = featureDist2(lng, lat, feat);
    if (d < bestD) { bestD = d; best = feat; }
  }
  return best;
}

/**
 * 解析一个地点的所属国家。
 * @returns {{ feature: object|null, source: 'code'|'name'|'geometry'|'nearby'|null }}
 */
export function resolveCountry(place) {
  if (!ready) return { feature: null, source: null };

  if (place.countryCode) {
    const f = getFeature(place.countryCode);
    if (f) return { feature: f, source: 'code' };
  }
  if (place.country) {
    const f = getFeature(place.country);
    if (f) return { feature: f, source: 'name' };
  }
  const inside = countryAt(place.lng, place.lat);
  if (inside) return { feature: inside, source: 'geometry' };

  const near = nearestCountry(place.lng, place.lat);
  return { feature: near, source: near ? 'nearby' : null };
}

/* =========================================================
 * 已访问国家汇总
 * ========================================================= */
/**
 * 汇总已访问国家。
 * @returns {{ visited: Map<string, {feature, places:[]}>, unresolved: [] }}
 */
export function collectVisited(places) {
  const visited = new Map();     // effectiveId → { feature, places }
  const unresolved = [];

  for (const place of places) {
    const { feature, source } = resolveCountry(place);
    place.countrySource = source;
    if (!feature) {
      place.countryId = null;
      place.countryZh = place.country || place.countryCode || null;
      place.countryCounted = false;
      unresolved.push(place);
      continue;
    }
    const id = effectiveId(feature);
    place.countryFeature = feature;
    place.countryId = id;
    place.countryZh = feature.properties.zh || feature.properties.name;
    place.countryCounted = countsAsCountry(feature);

    // 若命中台湾（parent=CHN），归属与展示统一到父级
    const owner = feature.properties.parent ? getFeature(feature.properties.parent) || feature : feature;
    place.countryFeature = owner;
    place.countryZh = owner.properties.zh || owner.properties.name;

    if (!visited.has(id)) visited.set(id, { feature: owner, places: [] });
    visited.get(id).places.push(place);
  }

  return { visited, unresolved };
}

/** 统计口径：只计入 count !== false 的国家/地区 */
export function countCountries(visited) {
  let n = 0;
  for (const { feature } of visited.values()) if (countsAsCountry(feature)) n += 1;
  return n;
}
