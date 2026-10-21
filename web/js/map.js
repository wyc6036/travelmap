/**
 * map.js · 地图引擎封装（平面 mercator）
 * -----------------------------------------------------------
 * 相对 Ref_Globe 的关键改动（本文件是"球体 → 平面"的落点）：
 *   ✔ projection: 'mercator'，不再调用 map.setProjection({type:'globe'})
 *   ✔ 删除 map.setSky({...}) 整段（天空/雾效仅服务球体边缘融合）
 *   ✔ 删除自动旋转 spin 与 ⟳ 按钮（平面下无意义）
 *   ✔ updateVisibility 里 dot < 0 的背面遮挡算法删除（见 markers.js）
 *   ✔ 初始视角改为「整个世界」：由 fitWorld() 按容器尺寸把世界铺满
 *     （center [20,15] / zoom = log2(max(宽,高)/512) / minZoom 由 syncWorldMinZoom() 钉在世界档）
 *   ✔ 横向可循环拖动：renderWorldCopies:true，绕地球一圈无缝；靠锁缩放下限挡住"两份世界"
 *
 * 另外做了一层"暖色底图覆盖"：把 OpenFreeMap 的 positron/liberty/bright
 * 现成图层改成本项目调色板（海洋 / 陆地 / 边界），让底图与 UI_Ref.jpeg 一致。
 */

import { CONFIG, COLORS } from './config.js';
import { warnOnce, hexToRgba, toast } from './utils.js';

const styleHooks = new Set();
let tileErrorCount = 0;

/* 底图 style 加载状态：按 map 实例记录，避免污染地图对象本身。
   failed 表示正处于「style 拉取失败」态；retries 达上限后只给手动重试。 */
const styleState = new WeakMap();
const MAX_STYLE_RETRIES = 5;
const STYLE_RETRY_BASE_MS = 2000;

/** 暖色底图覆盖：把底图图层改成项目调色板 */
export function applyWarmStyle(map) {
  const style = map.getStyle?.();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    const id = layer.id || '';
    try {
      /* 陆地底色（positron 把陆地放在 background 图层上） */
      if (layer.type === 'background') {
        map.setPaintProperty(id, 'background-color', COLORS.land);
        continue;
      }

      /* 海洋 / 内水：统一到效果图的淡蓝，并补一条海岸线描边。
         ⚠️ 为什么描边加在 water 上是对的：countries.js 的 raiseWaterAboveFills()
         已经把 water 抬到国家色块之上，所以"看得见的陆地边缘"就是 water 多边形的边，
         fill-outline-color 描出来正好贴合，不会与 Natural Earth 110m 的概化边错位。
         副产物：湖泊与宽河也一并描边 —— 与设计稿一致，是想要的。

         ⚠️ 但这条描边在**低缩放档必须淡出**，否则太平洋正中会多出一条竖线：
         OpenMapTiles 的 ocean 是"一张覆盖全球"的多边形，实测其经度范围是
         −182.813°~182.813°（两端各超出约 2.8° 用来兜住横向循环的接缝），
         于是它必然带一条 **±180° 的竖直切边**；fill-outline-color 会把切边
         当成海岸线一起描出来。实测证据（1600 宽视口，180° 落在屏幕正中 x=673）：
           · 关掉 fill-outline-color → 该竖线立刻消失（列剖面暗度 26.7 → 噪声 ~1）；
           · 与循环开关无关：renderWorldCopies=false 后竖线依然在（暗度 22.6）；
           · 位置严格跟随经度：中心由 180° 挪到 60°，竖线同步平移 594px
             （120° × 4.952 px/° @z1.8），即它钉在 ±180° 而不是"世界重复的边界"；
           · 只在低缩放档出现（等瓦片加载完的稳定态，固定视角连拍 4 次的读数）：
             z=1.4 → 22.2、z=1.8 → 22.7（8/8 次都有）；z=2.2 偶发（1/4）；
             z≥2.6 基本干净（3.0 / 3.5 / 4 / 6 / 10 共 20+ 次读数全为 0~1.1，噪声级）。
             也就是说它随"当前用的是哪一级瓦片"出现，切换档位附近有竞态，
             所以淡出区间取 2.6 起、3.6 结束 —— 把 ≤2.6 全部归零后仍有半档余量。
         代价：z<2.6 看不到海岸线描边。这个区间本来就只有整块大陆，
         1 设备像素的描边看不出细节，而城市 / 区域级（z≥3.6）与改动前完全一致。 */
      if (layer.type === 'fill' && /water|ocean|sea/i.test(id)) {
        map.setPaintProperty(id, 'fill-color', COLORS.ocean);
        map.setPaintProperty(id, 'fill-opacity', 1);
        /* fill-outline-color 是 fill 图层原生 paint 属性，宽度固定为 1 设备像素、
           不随 zoom 变粗，所以放到 z16 也不会糊成粗边；颜色取 COLORS.coast
           （从效果图逐像素抠出的实测值，理由见 config.js 的注释）。
           两端的 RGBA 都由 COLORS.coast 派生（只有 alpha 不同），
           这样颜色插值不会经过透明黑、淡入过程不带灰边，改色也不会漏改这里。 */
        map.setPaintProperty(id, 'fill-outline-color', [
          'interpolate', ['linear'], ['zoom'],
          2.6, hexToRgba(COLORS.coast, 0),
          3.6, hexToRgba(COLORS.coast, 1),
        ]);
        continue;
      }

      /* 地物（林地 / 建成区 / 绿地）：压成暖色调。
         OpenMapTiles 的 landcover_wood 在positron 里是偏冷的灰蓝，
         在低缩放下会大面积铺满俄罗斯/加拿大，与本项目的暖色国家调色板冲突，
         容易被误读成"已访问国家"。这里统一改成暖色，只保留极弱的肌理。 */
      if (layer.type === 'fill' && /landcover_wood|landuse_residential|park|grass|wood|scrub/i.test(id)) {
        const warm = /wood|scrub/i.test(id) ? '#EDE7D8'
          : (/residential/i.test(id) ? '#F5F0E6' : '#EAE8D9');
        map.setPaintProperty(id, 'fill-color', warm);
        map.setPaintProperty(id, 'fill-opacity', 0.75);
        continue;
      }

      /* 冰川 / 冰盖：压到接近陆地色，避免出现冷色调噪点 */
      if (layer.type === 'fill' && /ice_shelf|glacier/i.test(id)) {
        map.setPaintProperty(id, 'fill-color', '#F0EEE7');
        continue;
      }

      /* 行政边界：改暖灰细线 */
      if (layer.type === 'line' && /^boundary_?\d*$|admin/i.test(id)) {
        map.setPaintProperty(id, 'line-color', COLORS.mapLine);
        map.setPaintProperty(id, 'line-opacity', 0.9);
        continue;
      }

      /* 底图自带的国家名标注一律隐藏：
         本项目用 world.json 自行标注，保证国名口径（尤其台湾）可控。 */
      if (layer.type === 'symbol' && /label_country|country_label|place_country/i.test(id)) {
        map.setLayoutProperty(id, 'visibility', 'none');
      }
    } catch (err) {
      warnOnce(`style-${id}`, `覆盖底图图层 ${id} 失败：${err.message}`);
    }
  }
}

/** 中文标注 + 各 symbol 图层 text-field 改写（沿用 Ref_Globe 思路） */
export function applyChineseLabels(map) {
  try {
    if (typeof map.setLanguage === 'function') map.setLanguage(CONFIG.lang);
  } catch (_) { /* 老版本无此 API，忽略 */ }

  const zhExpr = ['coalesce', ...CONFIG.zhNameKeys.map((k) => ['get', k])];
  const layers = map.getStyle?.()?.layers || [];

  for (const layer of layers) {
    if (layer.type !== 'symbol') continue;
    if (/label_country|country_label|place_country/i.test(layer.id)) continue;
    let tf = '';
    try {
      tf = JSON.stringify(layer.layout?.['text-field'] ?? '');
    } catch (_) { tf = ''; }
    if (!tf.includes('name')) continue;           // 只改"名称类"标注，避开门牌/路号
    try {
      map.setLayoutProperty(layer.id, 'text-field', zhExpr);
    } catch (_) { /* 个别图层不可改，跳过 */ }
  }
}

/**
 * 创建地图实例。
 * @param {string|HTMLElement} container
 * @param {object} [overrides] 覆盖默认视图参数（弹窗小地图会用到）
 */
export function createMap(container, overrides = {}) {
  if (typeof maplibregl === 'undefined') {
    throw new Error('MapLibre GL JS 未加载：请确认 web/vendor/maplibre-gl.js 已随前端正确部署。');
  }

  const view = { ...CONFIG.view, ...overrides };

  const map = new maplibregl.Map({
    container,
    style: CONFIG.styles[CONFIG.defaultStyle],
    center: view.center,
    zoom: view.zoom,
    minZoom: view.minZoom,
    maxZoom: view.maxZoom,
    projection: view.projection,        // ← 唯一本质差异：平面 mercator
    dragRotate: false,                  // 平面地图不需要旋转
    pitchWithRotate: false,
    touchPitch: false,
    attributionControl: false,
    /* false = 低缩放时**不再**横向平铺出多个世界（平铺会在接缝处留下竖直海色细线）。
       代价是 MapLibre 会把相机夹在"世界宽度恰好铺满视口"那一档，见 CONFIG.view 注释。 */
    renderWorldCopies: view.renderWorldCopies ?? true,
    /* 容器尺寸变化时 MapLibre 自带的 ResizeObserver 会自动 resize（默认 true）。
       主地图保持默认；详情弹窗的小地图**必须传 false** —— 它的容器高度在滚动收缩时
       逐帧变化，内置观察器会跟着逐帧 resize：resize 清画布缓冲 + 取消在途瓦片请求，
       就是弹窗滚动时地图"闪白"的根源（2026-10-06 探针实测：滚动 20 步 canvas 高度
       跟着变了 20 次）。关掉后 resize 只走 detail-modal 的 scheduleMapResize 节流。 */
    trackResize: view.trackResize ?? true,
    fadeDuration: 200,
  });

  /* 记录该 map 的底图状态（初始 style 由构造函数传入，先登记 key + 未加载态）。 */
  const containerEl = typeof container === 'string' ? document.getElementById(container) : container;
  const isMain = containerEl?.id === 'tm-map';
  styleState.set(map, {
    key: CONFIG.defaultStyle,
    loaded: false,
    pending: true,
    retries: 0,
    timer: 0,
    failed: false,
    isMain,
  });
  if (isMain) {
    document.getElementById('tm-map-retry')?.addEventListener('click', () => retryNow(map));
  }

  /* 底图署名不在这里挂控件：MapLibre 的 AttributionControl 会渲染成圆形 ⓘ 按钮，
     与地图卡视觉冲突。署名改为 index.html 里的静态文字链接 .tm-map-attrib
     （OSM / OpenFreeMap 要求可见署名，所以是"换形式"而非"去掉"）。 */
  /* 瓦片/样式报错：区分「style 拉取失败」与「瓦片错误」 */
  map.on('error', (e) => {
    const st = styleState.get(map);
    /* style 拉取失败（或精灵/字形等初始资源失败）：既没有 sourceId 也没有 tile，
       且当前 style 尚未加载完成 → 视为底图源没连上，进入自动重试流程。
       瓦片错误会带 sourceId/tile，走下面的计数逻辑。 */
    const isStyleFail = !st?.loaded && !e?.sourceId && !e?.tile;
    if (isStyleFail) {
      scheduleStyleRetry(map);
      return;
    }
    tileErrorCount += 1;
    const msg = e?.error?.message || '未知错误';
    warnOnce('tile-error', `底图瓦片加载异常（不影响本地数据展示）：${msg}`);
    if (tileErrorCount === 8) {
      setMapStatus(map, '底图瓦片加载受限，本地足迹数据仍可正常查看', false);
    }
  });

  /* 样式每次加载完成（首次 + 切换后）都要重新套用覆盖与自定义图层 */
  map.on('style.load', () => {
    const st = styleState.get(map);
    if (st) {
      st.loaded = true;
      st.pending = false;
      st.retries = 0;
      if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
    }
    applyWarmStyle(map);
    applyChineseLabels(map);
    styleHooks.forEach((fn) => {
      try { fn(map); } catch (err) { warnOnce(`hook-${fn.name}`, `样式钩子执行错误：${err.message}`); }
    });
    /* 若本次是从失败态恢复，给用户一个明确反馈并收起提示条 */
    if (st?.failed) {
      toast('底图已恢复');
      st.failed = false;
      hideMapStatus(map);
    }
  });

  /**
   * 注册"样式就绪"钩子。
   * 用于在首次加载与每次切换底图后，重新挂载 world.json 的 source/layer
   * （map.setStyle 会清空自定义 source 与 layer）。
   */
  map.registerStyleHook = (fn) => {
    styleHooks.add(fn);
    if (map.isStyleLoaded?.()) {
      applyWarmStyle(map);
      try { fn(map); } catch (err) { warnOnce('hook-reg', err.message); }
    }
    return () => styleHooks.delete(fn);
  };

  return map;
}

/**
 * 底图 style 加载失败时：指数退避自动重试（2s→4s→8s…最多 MAX_STYLE_RETRIES 次），
 * 重试耗尽则常驻提示 + 亮出「重试」按钮，交给用户手动触发。
 * （已有一个重试定时器在途时直接返回，避免错误事件叠加出多个定时器。）
 */
function scheduleStyleRetry(map) {
  const st = styleState.get(map);
  if (!st || st.timer) return;
  st.failed = true;
  if (st.retries >= MAX_STYLE_RETRIES) {
    setMapStatus(map, '底图加载失败，请检查网络后点「重试」', true);
    return;
  }
  const delay = STYLE_RETRY_BASE_MS * Math.pow(2, st.retries);
  st.retries += 1;
  toast(`底图加载失败，正在重试（${st.retries}/${MAX_STYLE_RETRIES}）…`);
  setMapStatus(map, '底图加载失败，正在重试…', false);
  st.timer = setTimeout(() => {
    st.timer = 0;
    if (styleState.get(map)?.loaded) return;   // 期间已自行恢复
    setBaseStyle(map, st.key);
  }, delay);
}

/** 用户手动点「重试」：立即重设 style 并清零重试计数 */
function retryNow(map) {
  const st = styleState.get(map);
  if (!st) return;
  if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
  st.retries = 0;
  st.failed = false;
  hideMapStatus(map);
  toast('正在重新加载底图…');
  setBaseStyle(map, st.key);
}

/** 在地图区状态条上显示一条提示（仅主地图，弹窗小地图不显示） */
function setMapStatus(map, msg, withRetry) {
  const st = styleState.get(map);
  if (!st?.isMain) return;
  const bar = document.getElementById('tm-map-status');
  if (!bar) return;
  const msgEl = document.getElementById('tm-map-status-msg');
  const btn = document.getElementById('tm-map-retry');
  if (msgEl) msgEl.textContent = msg;
  if (btn) btn.hidden = !withRetry;
  bar.hidden = false;
}

/** 收起地图区状态条（仅主地图） */
function hideMapStatus(map) {
  const st = styleState.get(map);
  if (!st?.isMain) return;
  const bar = document.getElementById('tm-map-status');
  if (bar) bar.hidden = true;
}

/** 切换底图样式（positron / liberty / bright）。
 *  同时登记该 map 的 style 状态，供「加载失败自动重试」使用。 */
export function setBaseStyle(map, key) {
  const url = CONFIG.styles[key];
  if (!url) return false;
  const st = styleState.get(map) || {
    retries: 0, timer: 0, loaded: false, failed: false,
    isMain: map.getContainer()?.id === 'tm-map',
  };
  st.key = key;
  st.loaded = false;
  st.pending = true;
  if (st.timer) { clearTimeout(st.timer); st.timer = 0; }
  styleState.set(map, st);
  map.setStyle(url);
  return true;
}

/**
 * 相机在当前容器下能缩到的**最小** zoom，也就是"世界视角"该用的 zoom。
 *
 * mercator 下世界是一个**正方形**：x 与 y 各占 1 个瓦片单位，在 zoom z 时
 * 边长都是 512 · 2^z 像素。renderWorldCopies:false 时 MapLibre 会强制
 * "世界把视口盖满"（宽和高都要盖住，否则边缘会露出没有世界的那片空），
 * 所以下限 = log2( max(宽, 高) / 512 )。
 *
 * ⚠️ 别只按宽度算。卡片比宽还高时（窄屏极端情况），高度才是约束项，
 *    只按宽算出来的值比真实下限还小 → 请求被夹取 → "停在世界档"的判断失效
 *    （实测手机缩到 170×278 时，按宽算 −1.59、真实下限 −0.88，差了 0.71 档）。
 * ⚠️ 常规版式下卡片总是宽 ≥ 高，此时宽度就是约束项，世界**恰好**铺满宽度
 *    （实测东西边界正好落在 ±180°）。
 */
export function worldFitZoom(map) {
  const el = map.getContainer();
  const w = el.clientWidth || 1;
  const h = el.clientHeight || 1;
  return Math.log2(Math.max(w, h) / 512);
}

/**
 * 把 minZoom 钉死在"世界档"上。
 *
 * 世界横向循环（renderWorldCopies:true）时，MapLibre **不再**替我们夹住相机，
 * 于是"能不能缩到看见两份世界"就完全取决于 minZoom。这是唯一的闸门：
 * 一旦漏掉，低缩放下会平铺出两份世界 + 1 条 1px 竖直接缝（列剖面峰值 22.4，肉眼可见）。
 *
 * ⚠️ 下限依赖容器尺寸，所以**每次容器尺寸可能变化**（建图、resize、切回视图）都要重算，
 *    不能只在建图时设一次。
 */
export function syncWorldMinZoom(map) {
  const z = worldFitZoom(map);
  /* setMinZoom 在 z > maxZoom 时会抛（容器极小 + maxZoom 很大时才可能），保持原值即可 */
  if (z <= map.getMaxZoom()) {
    try { map.setMinZoom(z); } catch (_) { /* 忽略 */ }
  }
  return z;
}

/**
 * 把整个世界铺到地图卡片里（默认视角 / 「回到初始视角」按钮用）。
 *
 * 为什么是"铺满"而不是"缩到整个世界都装得下"：
 *   相机下限被 syncWorldMinZoom() 钉在 log2(max(宽,高)/512)，
 *   所以能做的只是"铺满 + 纵向裁一段"，纵向露多少完全取决于容器高度
 *   （世界在 mercator 下是正方形，卡片越扁看到的纬度带越窄）。
 *   卡片高度见 css/tokens.css 的 --map-h。
 *
 * @param {maplibregl.Map} map
 * @param {{animate?: boolean}} [opts] animate=true 时用 flyTo（复位按钮），否则 jumpTo
 * @returns {number} 实际采用的 zoom
 */
export function fitWorld(map, { animate = false } = {}) {
  const [lng, lat] = CONFIG.view.center;
  const zoom = syncWorldMinZoom(map);
  const center = [lng, lat];
  if (animate) {
    map.flyTo({ center, zoom, speed: 0.9, curve: 1.5 });
  } else {
    map.jumpTo({ center, zoom });
  }
  return zoom;
}

/**
 * 按当前容器尺寸重新铺满，但**保留用户已经拖到的经度**。
 *
 * 窗口尺寸变化时用它，而不是 fitWorld()：fitWorld 会把经度拉回 center[0]，
 * 用户拖到某处之后改一下窗口就被拽回 0°，很突兀。
 * 只改 zoom（jumpTo 只传 zoom 时中心不动）。
 */
export function refitWorldZoom(map) {
  const zoom = syncWorldMinZoom(map);
  map.jumpTo({ zoom });
  return zoom;
}

/** 复位到初始视角（= 整个世界，经度回到 center[0]） */
export function resetView(map) {
  fitWorld(map, { animate: true });
}

export const getTileErrorCount = () => tileErrorCount;
