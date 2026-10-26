/**
 * wishstore.js · 心愿注解的唯一数据源（后端持久化 + 本机离线镜像）
 * -----------------------------------------------------------
 * 2026-10-17 起：心愿数据改为**服务端权威**，本地 localStorage 仅作离线镜像，
 * 这样换设备 / 重装 / 清缓存都能从服务器找回（与足迹一起在后端备份）。
 *
 * 数据分两类（与后端两张表对应）：
 *   - WISH_KEY(travelmap.wish.v1)        ：{ [placeId]: { wish, priority, note, target, addedAt } }
 *                                         对「已有足迹地点」或「自建心愿地点」的注解
 *   - WISH_PLACES_KEY(travelmap.wish.places.v1)：用户「新建」的纯本机心愿地点（不进足迹）
 *
 * 读写策略：
 *   - 内存中为即时状态（导入时即同步 localStorage，断网也能渲染）。
 *   - 每次写：先更新内存 + 写 localStorage 镜像 + 广播，再异步把变更推到服务端
 *     （fire-and-forget；网络/404 等「不可达」静默，5xx 才轻提示，数据始终安全在本机镜像）。
 *   - initWishes()：启动时拉取服务端；若服务端为空但本机有数据，则把本机数据迁移上云
 *     （一次性，upsert 幂等）；否则以服务端为准覆盖本机镜像。
 *
 * ⚠️ 派生口径（向后兼容）：未显式设置 wish 时，
 *     未来日期 + 未标注日期 + 类型为「目的地」 仍算心愿；
 *     显式 wish=true/false 可覆盖（例如把一条「目的地」移出清单）。
 */

import { api } from './api.js';
import { toast } from './utils.js';

const WISH_KEY = 'travelmap.wish.v1';
const WISH_PLACES_KEY = 'travelmap.wish.places.v1';

function readJSON(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* 隐私模式忽略 */ }
}

let wishAnn = readJSON(WISH_KEY, {});
let newPlaces = readJSON(WISH_PLACES_KEY, []);

export { WISH_KEY, WISH_PLACES_KEY };

/* 网络/404/401 等「不可达」：静默（本地镜像仍有效，不必打扰用户）；
   仅真正的服务端 5xx 才轻提示。 */
function isUnreachable(e) {
  if (e && e.status === 401) return true;
  return /404|Failed to fetch|NetworkError|ECONNREFUSED|unauthorized/i.test(String((e && e.message) || ''));
}

async function pushAnnotation(id) {
  try { await api.putWishAnnotation(id, wishAnn[id] || {}); }
  catch (e) { if (!isUnreachable(e)) { console.warn('[wishstore] 心愿注解同步失败：', e.message); toast('心愿同步到服务器失败，已存本机'); } }
}
async function pushPlace(place) {
  try { await api.postWishPlace(place); }
  catch (e) { if (!isUnreachable(e)) { console.warn('[wishstore] 心愿地点同步失败：', e.message); toast('心愿地点同步到服务器失败，已存本机'); } }
}

let _init = null;
/**
 * 启动时从服务端拉取心愿数据（幂等，可重复调用）。
 * - 服务端为空但本机有数据 → 把本机数据迁移上云（一次性）。
 * - 否则以服务端为准，覆盖本机镜像。
 * - 拉取失败（离线 / 无后端）→ 保持本机镜像，不阻塞。
 * @returns {Promise<void>}
 */
export function initWishes() {
  if (_init) return _init;
  _init = (async () => {
    try {
      const r = await api.getWishes();
      const annotations = (r && r.annotations) || {};
      const places = (r && r.places) || [];
      const serverEmpty = !Object.keys(annotations).length && !places.length;
      const localHas = Object.keys(wishAnn).length || newPlaces.length;
      if (serverEmpty && localHas) {
        // 首次迁移：本机 → 服务端（幂等 upsert）
        for (const id of Object.keys(wishAnn)) { try { await api.putWishAnnotation(id, wishAnn[id]); } catch (_) {} }
        for (const p of newPlaces) { try { await api.postWishPlace(p); } catch (_) {} }
        // 内存中保持本机数据（已是最新），仅写回镜像（已是）
      } else {
        // 服务端权威
        wishAnn = annotations;
        newPlaces = Array.isArray(places) ? places : [];
        writeJSON(WISH_KEY, wishAnn);
        writeJSON(WISH_PLACES_KEY, newPlaces);
      }
    } catch (e) {
      // 离线 / 404（无后端）/ 401（需登录）：保持本机镜像模式
      console.warn('[wishstore] 拉取服务端心愿失败，使用本机副本：', e && e.message);
    }
    })();
  return _init;
}

/** 取某地点的心愿注解（不存在时返回空对象） */
export function getAnn(id) { return wishAnn[id] || {}; }

/** 合并写入某地点的心愿注解：更新内存 + 本机镜像 + 广播，并异步同步服务端 */
export function setAnn(id, patch) {
  wishAnn[id] = { ...getAnn(id), ...patch };
  writeJSON(WISH_KEY, wishAnn);
  pushAnnotation(id);
}

/** 取用户「新建」的本机心愿地点数组（与模块内数组同引用，仅 push 不会重赋值） */
export function getNewPlaces() { return newPlaces; }

function addNewPlace(place) {
  newPlaces.push(place);
  writeJSON(WISH_PLACES_KEY, newPlaces);
}

/**
 * 在「添加心愿」面板新建一个纯本机心愿地点，并写入其心愿注解。
 * 先在内存 + 本机镜像落好（乐观更新，断网也能用），再异步推到服务端。
 * id 由前端生成（wish-...），保证本地与服务端一致。
 * @returns {string} 新建地点 id
 */
export function addWishPlace({ name, country, priority, note, target, lng, lat }) {
  const id = 'wish-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const addedAt = Date.now();
  const place = {
    id, name, countryZh: country || null, country: country || null,
    type: '目的地', date: '', dateTs: null, hasFutureDate: false,
    lng: (lng == null ? null : +lng), lat: (lat == null ? null : +lat),
    priority: priority || 0, note: note || '', target: target || '', addedAt,
    media: [], mediaCount: { image: 0, video: 0, text: 0, total: 0 }, cover: '', isWishNew: true,
  };
  addNewPlace(place);
  // 注解一并写入（内存 + 镜像 + 服务端）
  setAnn(id, { wish: true, priority: priority || 0, note: note || '', target: target || '', addedAt });
  pushPlace(place);
  return id;
}

async function pushPlaceUpdate(place) {
  try { await api.putWishPlace(place.id, place); }
  catch (e) { if (!isUnreachable(e)) { console.warn('[wishstore] 心愿地点更新失败：', e.message); toast('心愿地点同步到服务器失败，已存本机'); } }
}
async function pushDeletePlace(id) {
  try { await api.deleteWishPlace(id); }
  catch (e) { if (!isUnreachable(e)) { console.warn('[wishstore] 心愿地点删除失败：', e.message); } }
}

/**
 * 编辑一个已存在的「新建」心愿地点（名称 / 国家 / 城市 / 优先级 / 备注 / 目标时间 / 坐标）。
 * 同时在内存 + 本机镜像 + 服务端（PUT 按 id 幂等 upsert）落好。
 * @returns {boolean} 是否找到并更新成功
 */
export function updateWishPlace(id, { name, country, priority, note, target, lng, lat }) {
  const idx = newPlaces.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  const p = newPlaces[idx];
  const updated = {
    ...p,
    name: name || p.name,
    countryZh: country || null, country: country || null,
    lng: (lng == null ? p.lng : +lng),
    lat: (lat == null ? p.lat : +lat),
    priority: priority || 0,
    note: note || '', target: target || '',
  };
  newPlaces[idx] = updated;
  writeJSON(WISH_PLACES_KEY, newPlaces);
  pushPlaceUpdate(updated);
  // 注解（note / priority / target / wish）一并更新
  setAnn(id, { wish: true, priority: priority || 0, note: note || '', target: target || '', addedAt: p.addedAt || Date.now() });
  return true;
}

/**
 * 删除一个「新建」心愿地点（连同其注解，内存 + 本机镜像 + 服务端）。
 * 仅作用于本机自建的心愿地点（newPlaces）；普通足迹地点（非 isWishNew）不在范围内，调用无效。
 * @returns {boolean} 是否找到并删除
 */
export function deleteWishPlace(id) {
  const idx = newPlaces.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  newPlaces.splice(idx, 1);
  writeJSON(WISH_PLACES_KEY, newPlaces);
  delete wishAnn[id];
  writeJSON(WISH_KEY, wishAnn);
  pushDeletePlace(id);
  return true;
}
