/**
 * countries.js · 已访问国家上色
 * -----------------------------------------------------------
 * 数据源：本地 world.json（Natural Earth 110m，见 tools/build-world-json.py）
 *
 * 上色算法（按需求：禁止实现四色定理，用哈希取色）
 *   countryId ──FNV-1a 哈希──▶ 调色板下标 ──▶ 颜色
 *   优点：
 *     1. O(1)，与"有多少已访问国家、谁和谁相邻"完全无关，永不退化；
 *     2. 确定性：同一国家任何时刻都是同一颜色，改数据不会整片换色；
 *     3. 真实的着色开销为 0 —— 颜色被编译成一条 MapLibre match 表达式，
 *        由 GPU 在绘制时按 feature 属性查表，无逐帧计算、无 JS 循环。
 *   代价：相邻国家可能撞色。缓解手段见下方 PALETTE 注释与 switch 参数。
 *
 * 想更进一步（可选增强，默认关闭）
 *   若要彻底避免相邻撞色，可在构建期对"接壤图"做贪心着色并落盘到
 *   world.json 的 colorIndex 字段，运行时直接读取；代价是丢掉了确定性
 *   （新增/删除国家会让一批颜色漂移），且需要维护边界邻接关系。
 *   当前数据规模（几十个已访问国家、6 色）下，撞色概率很低，不值得引入该复杂度。
 */

import { COLORS } from './config.js';
import { hashString, warnOnce } from './utils.js';

export const SOURCE_ID = 'tm-world';
export const LAYER_BASE = 'tm-country-base';
export const LAYER_VISITED = 'tm-country-visited';
export const LAYER_VISITED_LINE = 'tm-country-visited-line';
export const LAYER_LINE = 'tm-country-line';
export const LAYER_LABEL = 'tm-country-label';

const TRANSPARENT = 'rgba(0,0,0,0)';

/**
 * parent → [childId] 索引。
 * world.json 里被归并到父级的 feature（当前只有台湾 → CHN）需要跟父级同色，
 * 否则数据上算作"已访问中国"时，台湾地块会留白。
 */
let childIndex = new Map();

function buildChildIndex(geo) {
  childIndex = new Map();
  for (const f of geo?.features || []) {
    const p = f.properties || {};
    if (!p.parent || !p.id) continue;
    if (!childIndex.has(p.parent)) childIndex.set(p.parent, []);
    childIndex.get(p.parent).push(p.id);
  }
}

/** 返回某国家 id 需要一并上色的所有地块 id（含自身与归并子级） */
export function partsOfCountry(countryId) {
  return [countryId, ...(childIndex.get(countryId) || [])];
}

/* =========================================================
 * 取色
 * ========================================================= */
/** 稳定哈希取色：同一国家永远同一颜色 */
export function colorForCountry(countryId) {
  const palette = COLORS.visitedPalette;
  return palette[hashString(countryId) % palette.length];
}

/** 按比例加深颜色（用于已访问国家的描边，让地块更有"贴上去"的质感） */
function shade(hex, factor = 0.84) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return hex;
  const to = (v) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return `rgb(${to((n >> 16) & 255)},${to((n >> 8) & 255)},${to(n & 255)})`;
}

/* =========================================================
 * 图层挂载
 * =========================================================
 * 图层分两组，插在底图的不同高度上，这是"未访问国家干净、已访问国家成块"的关键：
 *
 *   A 组（贴近 background）：tm-country-base —— 给所有国家铺一层暖米色底。
 *     位置很低，底图的地物（林地/建成区）会盖在它上面，
 *     于是未访问国家保留一点自然肌理，不会糊成一片死白。
 *
 *   B 组（压在地物之上、道路之下）：tm-country-visited / -visited-line / -line
 *     —— 已访问国家的色块与国界白描边。
 *     必须在地物之上，否则林地/建成区的冷色会把国家色冲淡。
 *
 *   随后把底图的 water 图层抬到 B 组之上（raiseWaterAboveFills）：
 *   水面由底图按真实海岸线绘制，反过来裁掉国家色块压到海里的那部分，
 *   避免了 Natural Earth 110m 概化精度带来的"色块糊出海面"。
 */

/** A 组锚点：background 之后的第一层 */
function findBaseAnchor(map) {
  const layers = map.getStyle?.()?.layers || [];
  const first = layers.find((l) => l.type !== 'background');
  return first?.id;
}

/** B 组锚点：第一条"道路/建筑/水系"类图层（即地物之后、道路之前） */
function findOverlayAnchor(map) {
  const layers = map.getStyle?.()?.layers || [];
  const road = layers.find((l) => /waterway|building|highway|road|tunnel|bridge|railway|aeroway|pier/i.test(l.id));
  if (road) return road.id;
  // 退路：第一个符号（标注）图层之前
  const symbol = layers.find((l) => l.type === 'symbol');
  return symbol?.id;
}

function findFont(map) {
  const layers = map.getStyle?.()?.layers || [];
  const withFont = layers.find((l) => l.type === 'symbol' && (l.layout?.['text-font']?.length));
  return withFont?.layout['text-font']?.slice() || ['Noto Sans Regular'];
}

/** 把底图的水面图层抬到国家色块之上，用真实海岸线裁剪色块 */
function raiseWaterAboveFills(map) {
  if (!map.getLayer(LAYER_VISITED) || !map.getLayer(LAYER_LINE)) return;
  const layers = map.getStyle?.()?.layers || [];
  const water = layers.find((l) => l.type === 'fill' && /water|ocean|sea/i.test(l.id));
  if (!water) return;

  const ids = layers.map((l) => l.id);
  const waterIdx = ids.indexOf(water.id);
  const topFillIdx = Math.max(ids.indexOf(LAYER_VISITED), ids.indexOf(LAYER_VISITED_LINE), ids.indexOf(LAYER_LINE));

  // 水面已在色块之上则无需处理
  if (waterIdx > topFillIdx) return;

  // 移到 B 组锚点之前 → 由于色块更早插在同一锚点之前，水面实际落在色块之上、道路之下
  const anchor = findOverlayAnchor(map);
  try {
    map.moveLayer(water.id, anchor);
  } catch (err) {
    warnOnce('water-raise', `上移水面图层失败：${err.message}`);
  }
}

/**
 * 挂载国家图层（幂等：重复调用不会重复添加）。
 * @param {object} map
 * @param {object} worldGeoJSON world.json 的 FeatureCollection
 */
export function addCountryLayers(map, worldGeoJSON) {
  buildChildIndex(worldGeoJSON);

  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'geojson', data: worldGeoJSON, generateId: false });
  }

  const baseAnchor = findBaseAnchor(map);
  const overlayAnchor = findOverlayAnchor(map);

  /* ① A 组：未访问国家统一暖米色底（压掉底图冷色地物对"未访问"的干扰） */
  if (!map.getLayer(LAYER_BASE)) {
    map.addLayer({
      id: LAYER_BASE,
      type: 'fill',
      source: SOURCE_ID,
      paint: { 'fill-color': COLORS.land, 'fill-opacity': 1 },
    }, baseAnchor);
  }

  /* ② B 组：已访问国家色块（颜色由 match 表达式动态给出，初始全透明） */
  if (!map.getLayer(LAYER_VISITED)) {
    map.addLayer({
      id: LAYER_VISITED,
      type: 'fill',
      source: SOURCE_ID,
      paint: { 'fill-color': TRANSPARENT, 'fill-opacity': 1 },
    }, overlayAnchor);
  }

  /* ③ B 组：已访问国家描边（同色系加深，增强块面感） */
  if (!map.getLayer(LAYER_VISITED_LINE)) {
    map.addLayer({
      id: LAYER_VISITED_LINE,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': TRANSPARENT,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.9, 4, 1.6, 8, 2.4],
        'line-opacity': 0.5,
      },
    }, overlayAnchor);
  }

  /* ④ B 组：全部国家的细国界（效果图里是"陆地色压暗一档"的米色线，不是白线）
     宽度 1.3px 是扫描出来的：设计稿的线在 1x 下量到线芯亮度中位 210、
     与陆地落差 −21.6；本项目在 dpr2 下按 CSS 像素同口径回测，
     1.3px + COLORS.border 时是 209 / −22.1，再细或再粗都会偏离。详见 docs/03。 */
  if (!map.getLayer(LAYER_LINE)) {
    map.addLayer({
      id: LAYER_LINE,
      type: 'line',
      source: SOURCE_ID,
      paint: {
        'line-color': COLORS.border,
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.3, 4, 1.7, 8, 2.4],
        'line-opacity': 0.95,
      },
    }, overlayAnchor);
  }

  raiseWaterAboveFills(map);

  /* ⑤ 国家名标注（中文）：用自有数据，口径可控（台湾 → 中国台湾） */
  if (!map.getLayer(LAYER_LABEL)) {
    map.addLayer({
      id: LAYER_LABEL,
      type: 'symbol',
      source: SOURCE_ID,
      maxzoom: 7,
      layout: {
        'text-field': ['coalesce', ['get', 'zh'], ['get', 'name']],
        'text-font': findFont(map),
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 4, 12, 6, 13.5],
        'text-letter-spacing': 0.04,
        'text-max-width': 7,
        'text-allow-overlap': false,
        'text-padding': 6,
      },
      paint: {
        'text-color': COLORS.mapLabel,
        'text-halo-color': 'rgba(255,255,255,.85)',
        'text-halo-width': 1.2,
      },
    });
  }
}

/**
 * 应用"已访问"高亮。
 * @param {object} map
 * @param {Map<string, {feature:object}>} visited geo.collectVisited() 的结果
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] 是否启用（关闭时全部恢复浅色）
 * @param {number}  [options.fillOpacity=1] 色块不透明度。
 *        主图用 1（对齐效果图的平面色块）；弹窗小地图缩放很大、视野内往往全是同一个国家，
 *        纯色铺满会显得很闷，用 ~0.5 让暖米色底透出来，才像"淡淡的国土底色"。
 */
export function applyVisitedCountries(map, visited, options = {}) {
  const { enabled = true, fillOpacity = 1 } = options;
  if (!map.getLayer(LAYER_VISITED)) return;

  if (!enabled || !visited || !visited.size) {
    try {
      map.setPaintProperty(LAYER_VISITED, 'fill-color', TRANSPARENT);
      map.setPaintProperty(LAYER_VISITED_LINE, 'line-color', TRANSPARENT);
    } catch (err) { warnOnce('visited-clear', err.message); }
    return;
  }

  const fillExpr = ['match', ['get', 'id']];
  const lineExpr = ['match', ['get', 'id']];

  for (const [id] of visited) {
    const color = colorForCountry(id);
    // partsOfCountry 把归并子级（如台湾）一起纳入，保证与父级同色、色块连片
    for (const part of partsOfCountry(id)) {
      fillExpr.push(part, color);
      lineExpr.push(part, shade(color));
    }
  }
  fillExpr.push(TRANSPARENT);
  lineExpr.push(TRANSPARENT);

  try {
    map.setPaintProperty(LAYER_VISITED, 'fill-color', fillExpr);
    map.setPaintProperty(LAYER_VISITED, 'fill-opacity', fillOpacity);
    map.setPaintProperty(LAYER_VISITED_LINE, 'line-color', lineExpr);
  } catch (err) {
    warnOnce('visited-apply', `国家上色失败：${err.message}`);
  }
}

/**
 * 依据 world.json 反查 feature（台湾 → 取父级 CHN 的颜色，保证同色）。
 * 供图例、详情弹窗小地图复用。
 */
export function visitedColorMap(visited) {
  const out = new Map();
  for (const [id] of visited) {
    const c = colorForCountry(id);
    for (const part of partsOfCountry(id)) out.set(part, c);
  }
  return out;
}
