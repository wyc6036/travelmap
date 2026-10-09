/**
 * geocode.js · 批量 GPS 归档（逆地理编码 + 聚类）
 * -----------------------------------------------------------
 * 解决的问题：用户一次拖入一堆照片（尚未绑定地点），每张照片自带 EXIF GPS。
 *   ① 逐张反查所在城市（离线 GeoNames，零网络依赖；可选高德在线增强中文名）
 *   ② 距已有地点 ≤ EXISTING_MATCH_KM → 直接归入该地点（绕开命名不一致）
 *   ③ 其余按距离单链聚类（≤ CLUSTER_KM 连成一片）→ 提议新建地点
 *   ④ 无 GPS 的照片单列，交用户手动指派
 *
 * 设计取舍：
 *   - 绝不「算所有照片中心点」——那会落在两个城市之间的荒野（如东京+京都中点=琵琶湖）。
 *     正确做法是逐张反查、按反查结果归堆，坐标再分散也不会串。
 *   - 匹配已有地点用「距离」而非「城市名」，因为 GeoNames 里 "Tokyo" 与库里 "东京"
 *     名字对不上，但坐标距离能稳稳判定。
 *   - analyze 只「看」不改；apply 才落库。前端先给预览，用户确认/改完才写。
 */

const db = require('./db');

const EXISTING_MATCH_KM = 50; // 照片距已有地点 ≤50km → 归入该地点
const CLUSTER_KM = 30;        // 新照片两两 ≤30km → 聚成同一新地点
const CITY_SEARCH_DEG = 3;    // 逆地理编码经纬度搜索半径（度，≈±330km）

/** 球面两点距离（km），haversine 公式。 */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 高德 key：环境变量优先，其次 meta 里用户填的（设置页可配）。 */
function getAmapKey() {
  const env = process.env.AMAP_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const m = db.getMeta('amapKey');
    if (m && typeof m === 'string' && m.trim()) return m.trim();
  } catch (_) { /* 表未就绪 */ }
  return '';
}

/** 离线：在 geocities 表里找给定坐标最近的城市（先按经纬度框缩小范围再逐条算距离）。 */
function nearestCity(lat, lng) {
  const latMin = lat - CITY_SEARCH_DEG, latMax = lat + CITY_SEARCH_DEG;
  const lngMin = lng - CITY_SEARCH_DEG, lngMax = lng + CITY_SEARCH_DEG;
  const rows = db.db.prepare(
    'SELECT geonameid,name,asciiname,lat,lng,country,admin1,population FROM geocities WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?',
  ).all(latMin, latMax, lngMin, lngMax);
  if (!rows.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const r of rows) {
    const d = haversine(lat, lng, r.lat, r.lng);
    if (d < bestD) { bestD = d; best = r; }
  }
  if (!best) return null;
  return {
    geonameid: best.geonameid, name: best.name, asciiname: best.asciiname,
    lat: best.lat, lng: best.lng, country: best.country, admin1: best.admin1,
    population: best.population, distanceKm: bestD,
  };
}

/**
 * 给新地点起名：在聚簇中心 maxKm（默认 30km）范围内挑「人口最多」的城市，
 * 通常就是都市圈名（如东京的 23 个特别区在 GeoNames 里各自独立，质心最近的常是某个
 * 区名「Chiyoda」，而人口最多的才是「Tokyo」）。半径内没城市才回退到最近城市。
 * 这样自动归档出的地点名更贴近用户直觉，且用户仍可在预览里手动改。
 */
function bestCityForCluster(lat, lng, maxKm = 30) {
  const latMin = lat - CITY_SEARCH_DEG, latMax = lat + CITY_SEARCH_DEG;
  const lngMin = lng - CITY_SEARCH_DEG, lngMax = lng + CITY_SEARCH_DEG;
  const rows = db.db.prepare(
    'SELECT geonameid,name,asciiname,lat,lng,country,admin1,population FROM geocities WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?',
  ).all(latMin, latMax, lngMin, lngMax);
  let within = [];
  for (const r of rows) {
    if (haversine(lat, lng, r.lat, r.lng) <= maxKm) within.push(r);
  }
  if (!within.length) return nearestCity(lat, lng);
  within.sort((a, b) => b.population - a.population);
  const c = within[0];
  return {
    geonameid: c.geonameid, name: c.name, asciiname: c.asciiname,
    lat: c.lat, lng: c.lng, country: c.country, admin1: c.admin1, population: c.population,
  };
}

/** 在线（高德逆地理编码）：中文地名最准、可细到区/县。超时 4s，任何失败返回 null 由离线兜底。 */
async function amapReverse(lat, lng) {
  const key = getAmapKey();
  if (!key) return null;
  const url = `https://restapi.amap.com/v3/geocode/regeo?location=${lng.toFixed(6)},${lat.toFixed(6)}`
    + `&key=${encodeURIComponent(key)}&radius=1000&extensions=base&batch=false`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'TravelMap/1.0' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.status !== '1' || !j.regeocode) return null;
    const ac = j.regeocode.addressComponent || {};
    const city = Array.isArray(ac.city) ? ac.city[0] : (ac.city || '');
    const countryCode = ac.country === '中国' ? 'CN' : (ac.country || '');
    return {
      name: city || ac.district || ac.province || '',
      city: city || '',
      countryCode,
      admin1: ac.province || '',
      source: 'amap',
      lat, lng,
    };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 逆地理编码：在线（高德，中文名更准）优先，失败/无 key 回退离线 GeoNames。
 * 返回 { name, city, countryCode, admin1, source, lat, lng } 或 null（城市库为空时）。
 */
async function reverseGeocode(lat, lng) {
  const amap = await amapReverse(lat, lng);
  if (amap && amap.name) return amap;
  const c = nearestCity(lat, lng);
  if (!c) return null;
  return {
    name: c.name, city: c.name, countryCode: c.country, admin1: c.admin1,
    source: 'offline', lat: c.lat, lng: c.lng,
  };
}

/** 把媒体行精简成前端预览要的字段。 */
function serializeMedia(m) {
  return {
    id: m.id,
    kind: m.kind,
    url: m.url || '',
    thumb_url: m.thumb_url || '',
    caption: m.caption || '',
    taken_at: m.taken_at || '',
    gps_lat: Number(m.gps_lat) || 0,
    gps_lng: Number(m.gps_lng) || 0,
  };
}

/**
 * 分析所有未归类媒体，返回可编辑的归档方案预览（只读不写）。
 * 结构：{ total, withGps, noGps, geocodeReady, clusters[], unassigned[] }
 *   - clusters[].kind = 'existing'：距已有地点 ≤50km，建议「归入」该地点
 *   - clusters[].kind = 'new'：需新建地点，已给出建议名/中心/日期范围
 *   - unassigned[]：无 GPS，需手动指派
 */
async function analyzeUnassigned() {
  const media = db.getUnassignedMediaWithGps();
  const places = db.getAllPlacesLite();
  const geocodeReady = db.getGeocitiesCount() > 0;

  // 逐张反查 + 算与最近已有地点的距离（用于「归入已有」判定）
  const items = [];
  for (const m of media) {
    const rg = geocodeReady ? (await reverseGeocode(m.gps_lat, m.gps_lng)) : null;
    let nearestPlace = null;
    let nearestDist = Infinity;
    if (places.length) {
      for (const p of places) {
        const d = haversine(m.gps_lat, m.gps_lng, p.lat, p.lng);
        if (d < nearestDist) { nearestDist = d; nearestPlace = p; }
      }
    }
    items.push({
      m,
      rg,
      nearestPlace: (nearestPlace && nearestDist <= EXISTING_MATCH_KM) ? nearestPlace : null,
    });
  }

  const clusters = [];

  // ① 归入已有地点：同一已有地点合并成一个 cluster
  for (const it of items) {
    if (!it.nearestPlace) continue;
    let cl = clusters.find((c) => c.existingPlaceId === it.nearestPlace.id);
    if (!cl) {
      cl = {
        id: 'ex_' + it.nearestPlace.id,
        existingPlaceId: it.nearestPlace.id,
        name: it.nearestPlace.name,
        countryCode: '', city: '',
        center: [it.nearestPlace.lng, it.nearestPlace.lat],
        media: [], mediaCount: 0, kind: 'existing',
      };
      clusters.push(cl);
    }
    cl.media.push(serializeMedia(it.m));
    cl.mediaCount += 1;
  }

  // ② 新地点：单链聚类（两两 ≤ CLUSTER_KM 连成一片）
  const news = items.filter((it) => !it.nearestPlace && it.rg);
  const parent = news.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  for (let i = 0; i < news.length; i += 1) {
    for (let j = i + 1; j < news.length; j += 1) {
      if (haversine(news[i].m.gps_lat, news[i].m.gps_lng, news[j].m.gps_lat, news[j].m.gps_lng) <= CLUSTER_KM) union(i, j);
    }
  }
  const comps = {};
  news.forEach((_, i) => { const r = find(i); (comps[r] ||= []).push(i); });
  for (const r of Object.keys(comps)) {
    const members = comps[r].map((i) => news[i]);
    const clat = members.reduce((s, x) => s + x.m.gps_lat, 0) / members.length;
    const clng = members.reduce((s, x) => s + x.m.gps_lng, 0) / members.length;
    const c = bestCityForCluster(clat, clng);
    const name = c ? c.name : (members[0].rg.name || '未命名地点');
    const countryCode = c ? c.country : (members[0].rg.countryCode || '');
    const city = c ? c.name : (members[0].rg.city || '');
    const dates = members.map((x) => x.m.taken_at).filter(Boolean).sort();
    clusters.push({
      id: 'new_' + r,
      existingPlaceId: null,
      name,
      countryCode,
      city,
      center: [clng, clat],
      media: members.map((x) => serializeMedia(x.m)),
      mediaCount: members.length,
      minDate: dates[0] || '',
      maxDate: dates[dates.length - 1] || '',
      kind: 'new',
    });
  }

  // ③ 无 GPS：单列，交用户手动指派
  const noGps = db.getUnassignedNoGps().map(serializeMedia);

  return {
    total: media.length + noGps.length,
    withGps: media.length,
    noGps: noGps.length,
    geocodeReady,
    clusters,
    unassigned: noGps,
  };
}

/**
 * 执行归档方案（落库）。plan.clusters[] 每项：
 *   { id, action: 'create'|'assign'|'skip', name?, countryCode?, city?, center?,
 *     minDate?, maxDate?, existingPlaceId?, placeId?, mediaIds? }
 *   - skip：跳过（不动）
 *   - assign：归入已有 placeId（或 existingPlaceId）
 *   - create（默认）：按 name/center 新建地点，再归入
 * 每项用 mediaIds（用户勾选后的子集）决定实际归哪些媒体；缺省取整个 cluster.media 的 id。
 * @returns {{createdPlaces:number, assignedMedia:number}}
 */
function applyPlan(plan) {
  const clusters = (plan && plan.clusters) || [];
  const tx = db.db.transaction(() => {
    let created = 0;
    let assigned = 0;
    for (const cl of clusters) {
      if (!cl || cl.action === 'skip') continue;
      let placeId = cl.existingPlaceId || cl.placeId || null;
      if (cl.action === 'create' || (!placeId)) {
        placeId = db.createPlace({
          name: String(cl.name || '未命名地点'),
          coord: Array.isArray(cl.center) ? cl.center : [0, 0],
          countryCode: cl.countryCode || '',
          city: cl.city || '',
          type: cl.type || '旅行',
          date: cl.minDate || '',
          endDate: cl.maxDate || '',
        });
        created += 1;
      }
      const ids = cl.mediaIds && cl.mediaIds.length
        ? cl.mediaIds
        : (cl.media || []).map((m) => m.id);
      for (const id of ids) {
        if (id) { db.assignMediaToPlace(id, placeId); assigned += 1; }
      }
    }
    return { createdPlaces: created, assignedMedia: assigned };
  });
  return tx();
}

module.exports = {
  haversine, nearestCity, reverseGeocode, analyzeUnassigned, applyPlan,
};
