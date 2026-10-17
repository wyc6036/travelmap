/**
 * detail-modal.js · 媒体详情弹窗（仿微信朋友圈）
 * -----------------------------------------------------------
 * 结构：
 *   上半 ─ 地图（独立 MapLibre 实例）
 *   下半 ─ 关联的多媒体资料（图片 / 视频 / 文字）
 *
 * 两种内容（2026-10-05 起）：
 *   ① **地点**：地图显示该地点 + 附近足迹的图钉，内容是该地点的媒体 —— 沿用原逻辑。
 *   ② **行程**（多地点行程的折叠头的标题被点开时）：地图不再放图钉，而是把这条
 *      路线"走一遍"（虚线从起点逐渐延伸到终点 + 脚印光标，见 js/route.js）；
 *      内容是该行程**所有地点媒体的汇总**。
 *      点行程组里的**具体某个地点**走的是 ①，不放动画。
 *
 * 核心交互：
 *   1. 滚动边缘模糊（ScrollEdgeEffect）
 *      滚动下半部分内容时，顶部地图高度在 320px → 132px 之间平滑收缩，
 *      同时叠加一层逐渐增强的 backdrop-filter 模糊与底部渐隐，衔接不生硬。
 *      实现：滚动进度 p ∈ [0,1] 写入 CSS 变量 --mw-h / --mw-blur / --mw-p，
 *      由 CSS 负责表现，JS 只做一帧一次的计算（rafThrottle），并同步 map.resize()。
 *   2. 全屏预览：点击图片/视频进入 lightbox，支持左右切换（按钮 + ← → 键）。
 *   3. 关闭：右上角按钮 / 点击遮罩 / ESC。关闭时**必须**停掉路线动画并清干净图层与标记。
 */

import { CONFIG, MEDIA_LABELS, regionLabel } from './config.js';
import {
  escapeHtml, formatDateRange, formatDateDot, clamp,
  rafThrottle, distanceKm, warnOnce, mixHex, toast,
} from './utils.js';
import { createMap, setBaseStyle } from './map.js';
import { addCountryLayers, applyVisitedCountries, partsOfCountry } from './countries.js';
import { countryAt } from './geo.js';
import { PIN, PIN_BODY, PIN_LIFT, pinSvg } from './markers.js';
import { createRouteAnim } from './route.js';
import { api } from './api.js';
import { createUploadModal } from './upload-modal.js';

/** 局部 $：detail-modal 模块内统一用 getElementById 取 DOM */
function $(id) { return document.getElementById(id); }

/** 地图收缩后的最小高度（仍保留足够的地理上下文） */
const MIN_MAP_H = 132;

/**
 * 小地图的图钉基准缩放。
 * 小地图 zoom≈10，视野只有几十公里，主图那套按 zoom 递减的 --pin-scale 不适用；
 * 这里固定放大一点，让 14×20 的钉子在 300px 高的小地图里不至于太小。
 */
const DETAIL_PIN_SCALE = 1.15;

/**
 * 小地图上"已访问"色块的不透明度。
 * 小地图 zoom≈10，视野内基本只有当前所在的一个国家，纯色满铺会把整块地图糊成一片色；
 * 降到 0.5 让暖米色底图透出来，更接近"淡淡的国土底色"的观感。
 */
const DETAIL_FILL = { fillOpacity: 0.5 };

function pinElement(color, active) {
  const body = color || PIN_BODY;
  const el = document.createElement('div');
  el.className = `tm-pin${active ? ' is-active' : ''}`;
  /* 与主图图钉同一套变量（见 js/markers.js createPinElement）：
     主体色 = 类型色，提亮色由类型色派生，保证小地图上的钉子与主图一致。 */
  el.style.setProperty('--pin-body', body);
  el.style.setProperty('--pin-body-lift', mixHex(body, '#FFFFFF', PIN_LIFT));
  el.style.setProperty('--pin-accent', body);
  el.style.setProperty('--pin-scale', String(DETAIL_PIN_SCALE));
  // 几何与主图共用同一份（js/markers.js pinSvg），不要在这里另写一遍路径
  el.innerHTML = `<div class="tm-pin__inner">${
    pinSvg({ bodyClass: 'tm-pin__body', holeClass: 'tm-pin__hole' })
  }</div>`;
  return el;
}

/** 取媒体中"可全屏预览"的部分（图片 / 视频） */
const isViewable = (m) => m.type === 'image' || m.type === 'video';

/**
 * 点击目标是否落在"点哪儿关窗口"的区域上（遮罩 / 关闭按钮，标了 data-close="1"）。
 *
 * ⚠️ 必须用 closest() 向上找，不能用 `target instanceof HTMLElement && target.dataset.close`：
 * 关闭按钮里包着 `<svg><use/></svg>`，用户点的往往是图标本身，此时
 * `e.target` 是 SVGElement —— 它**不是** HTMLElement，那个判断会直接漏掉，
 * 表现就是"点叉号没反应"（但按钮的空白边缘能点中，所以肉眼很难看出规律）。
 */
function isCloseTarget(target) {
  return target instanceof Element && target.closest('[data-close="1"]') !== null;
}

export function createDetailModal({
  colorOf, worldGeoJSON, getPlaces, getTrips, getVisited, getStyleKey, onEdit, onDeleted, onMediaChanged, onClosed,
}) {
  const modal = document.getElementById('tm-modal');
  const panel = modal.querySelector('.modal__panel');
  const bodyEl = document.getElementById('tm-modal-body');
  const mapwrapEl = document.getElementById('tm-modal-mapwrap');
  const titleEl = document.getElementById('tm-modal-title');
  const subEl = document.getElementById('tm-modal-sub');
  const dotEl = document.getElementById('tm-modal-dot');
  const tabsEl = document.getElementById('tm-modal-tabs');
  const contentEl = document.getElementById('tm-modal-content');
  const badgeEl = document.getElementById('tm-modal-badge');
  const closeBtn = document.getElementById('tm-modal-close');
  const editBtn = document.getElementById('tm-modal-edit');
  const deleteBtn = document.getElementById('tm-modal-delete');
  const fsBtn = document.getElementById('tm-modal-fs');
  const headEl = bodyEl.querySelector('.modal__head');
  const padEl = bodyEl.querySelector('.modal__pad');

  const lightbox = document.getElementById('tm-lightbox');
  const lbStage = document.getElementById('tm-lb-stage');
  const lbCounter = document.getElementById('tm-lb-counter');
  const lbCaption = document.getElementById('tm-lb-caption');
  const lbPrev = document.getElementById('tm-lb-prev');
  const lbNext = document.getElementById('tm-lb-next');

  let detailMap = null;
  let detailMarkers = [];
  let routeAnim = null;
  /** 当前展示内容的"视图对象"：{ kind, ref, name, sub, badge, color, media, mediaCount, places? }
   *  renderTabs / renderContent 只认 `.media` 与 `.mediaCount`，
   *  所以地点和行程可以共用同一套渲染，不需要两遍。 */
  let current = null;
  let activeTab = null;
  let boundStyleKey = null;
  let scrollMaxH = 320;
  let lastFocus = null;
  /** 全屏分栏视图是否开启（点右上角 ⤢ 切换） */
  let fsActive = false;

  /* 行程模式里被点选的站点（place id，null = 没选）。
     选中后：下面的媒体只显示那一站的，地图上其余打点压灰。点地图空白恢复。 */
  let stopFilter = null;

  /* 全屏预览状态 */
  let lbList = [];
  let lbIndex = 0;
  /** 信息栏里的迷你地图实例（仅当媒体带 GPS 时创建，关闭/切换时销毁） */
  let lbMap = null;

  /* 「添加媒体」独立弹窗实例（详情头部「添加媒体」按钮打开，与编辑/删除并列） */
  let uploadModal = null;

  /* =========================================================
   * 小地图
   * ========================================================= */
  function ensureDetailMap() {
    if (detailMap) return detailMap;
    detailMap = createMap('tm-modal-map', {
      /* 用 detailMap 自己的占位中心，**不要**复用 CONFIG.view.center ——
         后者已改成"世界视角"的中心（[20,15]），拿来当小地图占位会语义串味。
         这个 center 只活到第一次 renderDetailMarkers() 的 jumpTo。 */
      center: CONFIG.detailMap.center,
      zoom: CONFIG.detailMap.zoom,
      minZoom: CONFIG.detailMap.minZoom,
      maxZoom: CONFIG.detailMap.maxZoom,
      /* 必须关掉 MapLibre 自带的容器 ResizeObserver（createMap 默认透传 true）：
         滚动收缩时 .modal__mapwrap 的高度逐帧变（--mw-h），内置观察器会跟着逐帧
         map.resize() —— resize 清画布缓冲 + 取消在途瓦片请求，就是滚动时地图
         "闪一下白"的根源（2026-10-06 探针实测：滚动 20 步 canvas 高度变了 20 次）。
         关掉后 resize 只发生在"打开弹窗"与"窗口尺寸变化"这两处（滚动期间一次都不调）。 */
      trackResize: false,
    });
    detailMap.dragRotate?.disable?.();
    // 小地图铺在内容区顶部之上，若它自己吃掉滚轮（默认用于缩放），
    // 用户在地图区域内滚动就会"卡住"。这里改为把滚轮转交给内容区，
    // 双指/双击缩放（doubleClickZoom）与拖拽平移仍然保留。
    detailMap.scrollZoom?.disable?.();
    mapwrapEl.addEventListener('wheel', (e) => {
      bodyEl.scrollTop += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    boundStyleKey = getStyleKey();
    window.__tmDetailMap = detailMap;      // 调试入口

    // 每次样式加载完成后重新挂载国家图层与上色
    detailMap.registerStyleHook((m) => {
      if (!worldGeoJSON) return;
      addCountryLayers(m, worldGeoJSON);
      applyVisitedCountries(m, getVisited(), DETAIL_FILL);
    });
    /* 路线动画。⚠️ 必须在上面那个 style hook **之后**构造 ——
       registerStyleHook 的执行顺序 = 图层叠放顺序，早注册的会被后注册的压住，
       顺序反了路线折线就藏在国土色块底下（不报错，只是看不见）。 */
    routeAnim = createRouteAnim(detailMap);
    /* 站点被点 / 地图空白被点 → 切换媒体筛选。
       站号要换成 place id：routeAnim 内部会滤掉没有坐标的地点，站号与 places 不保证对齐。 */
    routeAnim.onStopSelect((idx) => {
      if (current?.kind !== 'trip') return;
      if (idx === null) { if (stopFilter !== null) applyStopFilter(null); return; }
      const id = routeAnim.getStopIds()[idx];
      if (id == null) return;
      applyStopFilter(stopFilter === id ? null : id);      // 再点同一站 = 取消
    });
    return detailMap;
  }

  function syncDetailStyle() {
    const key = getStyleKey();
    if (!detailMap || key === boundStyleKey) return;
    boundStyleKey = key;
    setBaseStyle(detailMap, key);
  }

  /** 清空小地图上的图钉（行程模式要的是"只剩路线"，不是"路线 + 一堆邻居"） */
  function clearDetailMarkers() {
    detailMarkers.forEach((m) => { try { m.remove(); } catch (_) { /* 忽略 */ } });
    detailMarkers = [];
  }

  /** 小地图上的图钉：选中地点 + 附近足迹 */
  function renderDetailMarkers(place) {
    clearDetailMarkers();

    const radius = CONFIG.detailMap.nearbyRadiusKm;
    const nearby = (getPlaces() || []).filter((p) => (
      p.id !== place.id && distanceKm(place.lng, place.lat, p.lng, p.lat) <= radius
    ));
    const list = [...nearby, place];

    for (const p of list) {
      const isMain = p.id === place.id;
      const el = pinElement(colorOf(p), isMain);
      el.title = p.name;
      if (!isMain) {
        // 邻近足迹：退到背景。用 --pin-scale 而不是直接写 transform，
        // 否则会覆盖 .tm-pin__inner 的 hover/选中位移。
        el.style.opacity = '.72';
        el.style.setProperty('--pin-scale', String(DETAIL_PIN_SCALE * 0.82));
      }
      el.addEventListener('click', () => {
        if (isMain) return;
        open(p);           // 点小地图上的邻近图钉 → 直接切换详情
      });
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([p.lng, p.lat])
        .addTo(detailMap);
      detailMarkers.push(marker);
    }

    detailMap.jumpTo({ center: [place.lng, place.lat], zoom: CONFIG.detailMap.zoom });
    // 让小地图略微下移目标点，给图钉留出视觉空间
    detailMap.easeTo({
      center: [place.lng, place.lat], duration: 0,
    });
  }

  /* =========================================================
   * 滚动边缘模糊 / 地图收缩
   * ---------------------------------------------------------
   * 滚动时只逐帧改外层 .modal__mapwrap 的高度（CSS 变量 --mw-h），
   * 里面的 .modal__map 高度恒为 --mw-max 并垂直居中（见 css/modal.css）。
   *
   * ⚠️ 2026-10-06：**滚动期间一次 map.resize() 都不能有**。
   *    旧写法是"高度变化 ≥28px 就 resize + 停止滚动后再补一次"，已经算节流了，
   *    但录屏对照实验（tm-modal-flicker.mjs）证明：每一次 resize 都会让合成器
   *    抓到一帧空画布（亮度 +18 的尖峰），节流到 6 次仍然闪 6 次；
   *    而"resize 变空操作"那组全程只有 1 处突变 —— 闪就是 resize 本身造成的。
   *    改成"容器尺寸恒定 + 居中裁切"后，容器尺寸在滚动期间根本不变，
   *    于是既不需要 resize，也不会有构图跳变（可见区始终以地图中心为中心）。
   *
   *    另外说明：MapLibre 自带的容器 ResizeObserver（trackResize）也必须关掉
   *    （见 ensureDetailMap），否则它会绕过这里、逐帧 resize。
   * ========================================================= */

  function syncScrollEffect() {
    if (fsActive) return;          // 全屏分栏下地图恒满高，不随滚动收缩
    // 收缩行程 = 地图最大高度 - 最小高度；滚动量与收缩量严格 1:1，
    // 于是标题始终贴着地图下沿（推导见 css/modal.css 中 .modal__body 注释）。
    const dist = Math.max(1, scrollMaxH - MIN_MAP_H);
    const p = clamp(bodyEl.scrollTop / dist, 0, 1);
    const h = scrollMaxH - dist * p;
    panel.style.setProperty('--mw-h', `${h.toFixed(2)}px`);
    // 模糊上限刻意压到 2.6px：再高会把地图糊成一片，反而失去"局部放大"的信息量
    panel.style.setProperty('--mw-blur', `${(p * 2.6).toFixed(2)}px`);
    panel.style.setProperty('--mw-p', p.toFixed(3));
    panel.classList.toggle('is-scrolled', p > 0.02);
    /* 这里**不再**调 map.resize() —— 原因见本段注释（滚动期 resize = 闪白）。
       画布尺寸恒为 --mw-max，容器尺寸全程不变，构图也就不需要重算。 */
  }
  const onScroll = rafThrottle(syncScrollEffect);

  /** 依据面板高度重算地图最大高度，并同步 --mw-max（占位高度必须与之相等） */
  function measureMaxH() {
    scrollMaxH = clamp(panel.clientHeight * 0.42, 176, 340);
    panel.style.setProperty('--mw-max', `${scrollMaxH}px`);
    return scrollMaxH;
  }

  /* =========================================================
   * 内容渲染
   * ---------------------------------------------------------
   * ⚠️ 下面三个函数只认 `view.media` 与 `view.mediaCount`，**不认** place / trip。
   *    所以"地点"和"行程"共用同一套渲染：行程只是一个把各地点媒体汇总起来的 view
   *    （见 mediaOfTrip / tripView）。加第三种内容类型时也不用动这里。
   * ========================================================= */
  function tabsFor(view) {
    const counts = view.mediaCount;
    return ['image', 'video', 'text']
      .filter((t) => counts[t] > 0)
      .map((t) => ({ type: t, count: counts[t] }));
  }

  function renderTabs(view) {
    const tabs = tabsFor(view);
    tabsEl.innerHTML = '';
    if (!tabs.length) return;

    if (!activeTab || !tabs.some((t) => t.type === activeTab)) {
      activeTab = tabs[0].type;
    }

    tabs.forEach(({ type, count }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tabs__btn${type === activeTab ? ' is-active' : ''}`;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(type === activeTab));
      btn.innerHTML = `${MEDIA_LABELS[type]}<b>${count}</b>`;
      btn.addEventListener('click', () => {
        activeTab = type;
        rerenderContent();
      });
      tabsEl.append(btn);
    });

    renderFilterChip(view);     // 行程模式选了站 → Tab 行右端补一枚筛选徽标
  }

  /**
   * 当前**真正要渲染**的视图。
   * 行程模式选了某一站时，media 换成那一站的 —— Tab 计数与网格都随之收窄。
   * ⚠️ Tab 的点击回调也要走这里：闭包里攥着旧的 view 参数会把筛选"冲掉"。
   */
  function renderView() {
    if (current?.kind !== 'trip' || !stopFilter) return current;
    const stop = (current.stops || []).find((s) => s.id === stopFilter);
    if (!stop) return current;
    return { ...current, media: stop.media, mediaCount: stop.count };
  }

  /** Tab / 筛选变化后的统一重绘入口 */
  function rerenderContent() {
    const view = renderView();
    renderTabs(view);
    renderContent(view);
    syncScrollEffect();
  }

  /**
   * 切换站点筛选。
   * @param {string|null} id 地点 id；null = 恢复整条行程的媒体
   */
  function applyStopFilter(id) {
    stopFilter = id;
    if (routeAnim) {
      routeAnim.settle();                       // 动画没走完也要立刻看到全貌
      const ids = routeAnim.getStopIds();
      routeAnim.highlight(id == null ? null : ids.indexOf(id));
    }
    rerenderContent();
  }

  /**
   * 站点筛选徽标（行程模式且选中了某一站时出现）。
   * 放在 Tab 行里跟着一起吸顶：滚到多低都能看见"现在只看哪一站"，
   * 也给"点地图空白恢复"提供一个不用回到地图上的出口。
   */
  function renderFilterChip(view) {
    const old = tabsEl.querySelector('.tabs__filter');
    if (old) old.remove();
    if (view?.kind !== 'trip' || !stopFilter) return;
    const stop = (view.stops || []).find((s) => s.id === stopFilter);
    if (!stop) return;

    const chip = document.createElement('span');
    chip.className = 'tabs__filter';
    chip.innerHTML = `<span class="tabs__filter-name">${escapeHtml(stop.name)} · ${stop.count.total}</span>`
      + '<button type="button" data-clear-stop="1" aria-label="显示全部">'
      + '<svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-close"/></svg></button>';
    chip.querySelector('button').addEventListener('click', () => applyStopFilter(null));
    tabsEl.append(chip);
  }

  function mediaCell(item, list, idx, { wide = false } = {}) {
    const cell = document.createElement('div');
    cell.className = `mgrid__cell${item.type === 'video' ? ' mgrid__cell--video' : ''}${wide ? ' mgrid__cell--wide' : ''}`;
    cell.title = item.caption || '点击全屏查看';

    const thumb = item.type === 'video' && item.poster ? item.poster : (item.thumb_url || item.url);
    cell.innerHTML = `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(item.caption || '')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
    if (item.type === 'video') {
      cell.insertAdjacentHTML('beforeend',
        '<span class="mgrid__play"><svg class="ico" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg></span>');
    }
    cell.insertAdjacentHTML('beforeend', `<span class="mgrid__count">${idx + 1}/${list.length}</span>`);

    const img = cell.querySelector('img');
    img?.addEventListener('error', () => {
      img.src = './assets/sidebar-art.svg';
    });

    /* 单地点模式下，每个格子右上角挂一个删除按钮（行程模式下不提供，避免误删归属不明的媒体） */
    const del = mediaDeleteBtn(item);
    if (del) cell.appendChild(del);

    /* 编辑按钮（原重命名入口）：同样仅单地点模式下提供 */
    const rn = mediaEditBtn(item);
    if (rn) cell.appendChild(rn);

    cell.addEventListener('click', () => openLightbox(list, idx));
    return cell;
  }

  /** 媒体删除按钮：仅单地点详情出现（行程模式媒体归属不定，不在此处提供删除）。 */
  function mediaDeleteBtn(item) {
    if (current?.kind !== 'place' || !item || !item.id) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mgrid__del';
    btn.title = '删除这条媒体';
    btn.setAttribute('aria-label', '删除媒体');
    /* 小尺寸垃圾桶：直线版、桶身略短，让视觉重心在 24px viewBox 中更居中 */
    btn.innerHTML = '<svg class="ico ico--sm" viewBox="0 0 24 24"><path d="M6 7h12"/><path d="M10 7V5h4v2"/><path d="M8 8l1 9h6l1-9"/></svg>';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!confirm('确定删除这条媒体？')) return;
      try {
        await api.deleteMedia(item.id);
        toast('已删除一条媒体', 1800);
        if (typeof onMediaChanged === 'function') onMediaChanged();
      } catch (err) {
        toast('删除失败：' + (err.message || err), 2600);
      }
    });
    return btn;
  }

  /** 媒体编辑按钮：仅单地点详情出现。点击后弹出小窗编辑「名称 + 备注」。
   * 复用原"重命名"入口（网格右上角铅笔键），只是从内联改名升级为独立弹窗。 */
  function mediaEditBtn(item) {
    if (current?.kind !== 'place' || !item || !item.id) return null;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mgrid__renamebtn';
    btn.title = '编辑名称和备注';
    btn.setAttribute('aria-label', '编辑媒体');
    btn.innerHTML = '<svg class="ico ico--sm" viewBox="0 0 24 24"><path d="M14.5 5.5 18.5 9.5M4 20l1.2-4.3 10.3-10.3a2 2 0 0 1 2.8 0l1.8 1.8a2 2 0 0 1 0 2.8L9.3 18.8 5 20z"/></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openMediaEditModal(item);
    });
    return btn;
  }

  /**
   * 照片编辑小弹窗：编辑「名称」(name) 与「备注」(remark)。
   * 复用了原"重命名"入口（网格铅笔键），点击后弹出 modal-edit 风格小窗；
   * 灯箱信息栏头部也复用同一函数，便于在预览时直接改。
   * 提交后写回后端，并就地刷新灯箱信息栏（若正显示这条媒体）+ 详情网格。
   */
  function openMediaEditModal(item) {
    if (!item || !item.id) return;
    if (document.getElementById('tm-media-edit-modal')) return; // 防重复打开

    const modal = document.createElement('div');
    modal.className = 'modal-edit';
    modal.id = 'tm-media-edit-modal';
    modal.innerHTML = `
      <div class="modal-edit__mask" data-close="1"></div>
      <div class="modal-edit__panel" role="dialog" aria-modal="true" aria-label="编辑媒体">
        <header class="modal-edit__head">
          <h3>编辑媒体</h3>
          <button class="modal-edit__close" type="button" data-close="1" aria-label="关闭">
            <svg class="ico" viewBox="0 0 24 24"><use href="#i-close"/></svg>
          </button>
        </header>
        <form class="modal-edit__body" id="tm-media-edit-form">
          <div class="form-row">
            <label class="form-label" for="tm-media-name">名称</label>
            <input id="tm-media-name" class="form-input" type="text" maxlength="120" placeholder="给这张照片起个名字" />
          </div>
          <div class="form-row">
            <label class="form-label" for="tm-media-remark">备注</label>
            <textarea id="tm-media-remark" class="form-input" rows="4" maxlength="500" placeholder="记录点什么…"></textarea>
          </div>
          <p class="form-status" id="tm-media-edit-status" hidden></p>
        </form>
        <div class="modal-edit__foot">
          <button class="btn btn--ghost" type="button" data-close="1">取消</button>
          <button class="btn btn--primary" type="button" id="tm-media-edit-go">保存</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const nameEl = modal.querySelector('#tm-media-name');
    const remarkEl = modal.querySelector('#tm-media-remark');
    const statusEl = modal.querySelector('#tm-media-edit-status');
    const goBtn = modal.querySelector('#tm-media-edit-go');
    const form = modal.querySelector('#tm-media-edit-form');

    nameEl.value = item.name || '';
    remarkEl.value = item.remark || '';

    const close = () => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    modal.querySelectorAll('[data-close="1"]').forEach((el) => el.addEventListener('click', close));

    const commit = async () => {
      goBtn.disabled = true;
      statusEl.hidden = true;
      const name = nameEl.value.trim();
      const remark = remarkEl.value.trim();
      try {
        await api.updateMedia(item.id, { name, remark });
        // 就地刷新灯箱信息栏（若正显示这条媒体）
        item.name = name;
        item.remark = remark;
        if (!lightbox.hidden && lbList[lbIndex] && lbList[lbIndex].id === item.id) {
          renderInfo(item);
        }
        toast('已保存', 1500);
        close();
        if (typeof onMediaChanged === 'function') onMediaChanged();
      } catch (err) {
        statusEl.hidden = false;
        statusEl.textContent = '保存失败：' + (err.message || err);
        goBtn.disabled = false;
      }
    };
    goBtn.addEventListener('click', commit);
    form.addEventListener('submit', (e) => { e.preventDefault(); commit(); });

    nameEl.focus();
  }

  function renderContent(view) {
    contentEl.innerHTML = '';
    const items = view.media.filter((m) => m.type === activeTab);

    if (activeTab === 'text') {
      const wrap = document.createElement('div');
      wrap.className = 'modal__section';
      items.forEach((m) => {
        const card = document.createElement('div');
        card.className = 'notecard';
        card.style.marginBottom = '10px';
        card.innerHTML = (m.caption ? `<p class="notecard__title">${escapeHtml(m.caption)}</p>` : '')
          + escapeHtml(m.text || '');
        const del = mediaDeleteBtn(m);
        if (del) { del.classList.add('mgrid__del--static'); card.appendChild(del); }
        const rn = mediaEditBtn(m);
        if (rn) { rn.classList.add('mgrid__renamebtn--static'); card.appendChild(rn); }
        wrap.append(card);
      });
      contentEl.append(wrap);
      return;
    }

    const list = items.filter(isViewable);
    const grid = document.createElement('div');
    grid.className = 'mgrid';
    list.forEach((item, i) => {
      // 瀑布流（CSS columns）下不再做"首图占两格"的特殊处理：
      // 不等高的卡片本就交错，强行拉宽反而会破坏列平衡。
      grid.append(mediaCell(item, list, i));
    });
    contentEl.append(grid);
  }

  /* =========================================================
   * 全屏预览
   * ========================================================= */
  /** 把 EXIF 的 ISO 时间 "2023-05-01T14:30:00" 格式化为 "2023-05-01 14:30" */
  function formatExifDate(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /**
   * 把媒体元数据渲染进信息栏；返回是否有任何可展示的信息（决定是否显示信息栏）。
   * 位置优先用 world.json 反查国家名（离线），再补经纬度文字 + 一张迷你线条地图（占位 div）。
   */
  function renderInfo(item) {
    const infoEl = document.getElementById('tm-lb-info-scroll');
    if (!infoEl) return false;
    const rows = [];
    if (item.takenAt) rows.push(['拍摄时间', escapeHtml(formatExifDate(item.takenAt))]);
    const device = [item.cameraMake, item.cameraModel].filter(Boolean).join(' ');
    if (device) {
      rows.push(['拍摄设备', escapeHtml(device) + (item.lens ? `<span class="lb-sub">${escapeHtml(item.lens)}</span>` : '')]);
    }
    const params = [];
    /* 旧数据里 focal/f_number 存的是 EXIF 原始浮点（5.960000038146973），展示端统一取整 */
    if (item.focalLength) params.push(`${Math.round(item.focalLength * 10) / 10} mm`);
    if (item.fNumber) params.push(`f/${Math.round(item.fNumber * 100) / 100}`);
    if (item.iso) params.push(`ISO ${item.iso}`);
    if (params.length) rows.push(['拍摄参数', escapeHtml(params.join(' · '))]);

    const hasMeta = rows.length > 0;
    const hasLoc = !!(item.gpsLat && item.gpsLng);

    // 顶部：名称（无 name 时回退到 caption，两者皆空则占位）+ 编辑入口
    const displayName = item.name || item.caption || '未命名';
    let html = '<div class="lb-head">'
      + `<div class="lb-name">${escapeHtml(displayName)}</div>`
      + '<button class="lb-edit" type="button" aria-label="编辑名称和备注">编辑</button>'
      + '</div>';

    let body = '';
    if (hasMeta) {
      body += '<dl class="lb-meta">';
      for (const [k, v] of rows) body += `<dt>${k}</dt><dd>${v}</dd>`;
      body += '</dl>';
    }
    if (hasLoc) {
      const feat = countryAt(item.gpsLng, item.gpsLat);
      const cname = feat ? (feat.properties?.['name:zh-Hans'] || feat.properties?.name || '') : '';
      body += '<div class="lb-loc"><span class="lb-loc__label">位置</span>'
        + `<span class="lb-loc__val">${cname ? escapeHtml(cname) + ' · ' : ''}${item.gpsLat.toFixed(4)}°, ${item.gpsLng.toFixed(4)}°</span>`
        + '<div class="lightbox__map" id="tm-lb-map"></div></div>';
    } else if (!hasMeta) {
      body = '<p class="lb-empty">这张媒体没有可用的拍摄信息</p>';
    }
    // 备注：紧贴在迷你地图下方（无位置信息时则落在元数据下方）
    if (item.remark) {
      body += `<div class="lb-remark"><span class="lb-remark__label">备注</span>${escapeHtml(item.remark)}</div>`;
    }
    html += body;
    infoEl.innerHTML = html;

    const editBtn = infoEl.querySelector('.lb-edit');
    if (editBtn) editBtn.addEventListener('click', () => openMediaEditModal(item));

    return hasMeta || hasLoc;
  }

  /** 在信息栏的 #tm-lb-map 上画一张迷你线条地图 + 打点（positron 线描底图） */
  function createLightboxMap(item) {
    const el = document.getElementById('tm-lb-map');
    if (!el || typeof maplibregl === 'undefined') return;
    requestAnimationFrame(() => {
      try {
        const map = new maplibregl.Map({
          container: el,
          style: CONFIG.styles.positron,
          center: [item.gpsLng, item.gpsLat],
          /* zoom 11 = 城市级，位置只到"城市"粒度；提到 15 = 街区/楼栋级，让打点位置更精细
             （用户诉求：要更精细的位置，不是更大的地图框）。地图框尺寸不变（仍 ~196px）。 */
          zoom: 15,
          attributionControl: false,
          dragRotate: false, pitchWithRotate: false, scrollZoom: true, trackResize: false,
        });
        map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
        // 缩放按钮（+/-）：让用户在灯箱迷你地图上手动调节缩放级别（关掉指南针与复位，只留放大/缩小）。
        // 滚轮缩放也已开启（scrollZoom:true），在地图上滚动滚轮即可缩放；按钮与滚轮两种方式并存。
        map.addControl(new maplibregl.NavigationControl({ showZoom: true, showCompass: false, showReset: false }), 'top-right');
        map.on('load', () => {
          const pin = document.createElement('div');
          pin.className = 'lb-pin';
          new maplibregl.Marker({ element: pin }).setLngLat([item.gpsLng, item.gpsLat]).addTo(map);
        });
        lbMap = map;
      } catch (e) {
        warnOnce('lb-map', `迷你地图创建失败：${e.message}`);
      }
    });
  }

  function destroyLightboxMap() {
    if (lbMap) { try { lbMap.remove(); } catch (_) { /* 忽略 */ } lbMap = null; }
  }

  function renderLightbox() {
    const item = lbList[lbIndex];
    if (!item) return;
    destroyLightboxMap();
    lbStage.innerHTML = '';
    lbStage.classList.remove('is-switching');
    void lbStage.offsetWidth;                 // 重排以重播动画
    lbStage.classList.add('is-switching');

    if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = item.url;
      video.controls = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'metadata';
      // 视频兜底：取源失败时退化为封面图，避免出现"黑框"
      video.addEventListener('error', () => {
        const img = document.createElement('img');
        img.src = item.poster || './assets/sidebar-art.svg';
        img.alt = item.caption || '';
        lbStage.innerHTML = '';
        lbStage.append(img);
      }, { once: true });
      lbStage.append(video);
    } else {
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.caption || '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        img.src = './assets/sidebar-art.svg';
      }, { once: true });
      lbStage.append(img);
    }

    // 信息栏常驻：有元数据展示明细，没有则显示占位提示（保证功能可被发现）
    renderInfo(item);
    const infoWrap = document.getElementById('tm-lb-info');
    if (infoWrap) infoWrap.hidden = false;
    if (item.gpsLat && item.gpsLng) createLightboxMap(item);

    lbCounter.textContent = lbList.length > 1 ? `${lbIndex + 1} / ${lbList.length}` : '';
    lbCaption.textContent = item.caption || '';
    lbPrev.disabled = lbIndex <= 0;
    lbNext.disabled = lbIndex >= lbList.length - 1;
  }

  function openLightbox(list, index) {
    lbList = list;
    lbIndex = index;
    lightbox.hidden = false;
    lightbox.classList.remove('is-closing');
    renderLightbox();
    lbNext.focus();
  }

  function closeLightbox() {
    if (lightbox.hidden) return;
    destroyLightboxMap();
    lightbox.hidden = true;
    lbStage.innerHTML = '';
    lbList = [];
    const infoSc = document.getElementById('tm-lb-info-scroll');
    if (infoSc) infoSc.innerHTML = '';
  }

  function stepLightbox(delta) {
    const next = lbIndex + delta;
    if (next < 0 || next >= lbList.length) return;
    lbIndex = next;
    renderLightbox();
  }

  /* =========================================================
   * 打开 / 关闭
   * ========================================================= */

  /** 把 media 的数目数出来（行程要汇总各地点，不能直接用某个地点的 mediaCount） */
  function countMedia(media) {
    const c = { image: 0, video: 0, text: 0, total: 0 };
    media.forEach((m) => { if (c[m.type] !== undefined) c[m.type] += 1; c.total += 1; });
    return c;
  }

  /** 地点视图 */
  function placeView(place) {
    const country = place.countryZh ? `${place.countryZh} · ` : '';
    return {
      kind: 'place',
      ref: place,
      name: place.name,
      sub: place.date
        ? `${country}${formatDateRange(place.date, place.endDate)}`
        : `${country}到访记录`,
      badge: place.countryZh
        ? `${place.countryZh} · ${place.lng.toFixed(2)}, ${place.lat.toFixed(2)}`
        : `${place.lng.toFixed(2)}, ${place.lat.toFixed(2)}`,
      color: colorOf(place),
      media: place.media,
      mediaCount: place.mediaCount,
    };
  }

  /**
   * 行程视图。
   * 媒体 = 各地点媒体**按到访顺序**串起来（每条的 caption 里本来就带地名，
   * 所以不必再套一层分组标题），计数 = 各地点之和。
   * `stops` 保留每一站自己的媒体 —— 地图上的打点被点中时，下面只显示那一站的。
   */
  function tripView(trip) {
    const places = [...trip.places].sort((a, b) => (a.dateTs || 0) - (b.dateTs || 0));
    const media = [];
    const stops = places.map((p) => {
      p.media.forEach((m) => media.push(m));
      return { id: p.id, name: p.name, media: p.media, count: countMedia(p.media) };
    });
    const region = regionLabel(places);
    const range = trip.endDate
      ? formatDateRange(trip.date, trip.endDate)
      : formatDateDot(trip.date);
    return {
      kind: 'trip',
      ref: trip,
      places,
      stops,
      name: trip.name,
      sub: [range || '—', `${places.length} 个地点`, region].filter(Boolean).join(' · '),
      badge: [`${places.length} 个地点`, region].filter(Boolean).join(' · '),
      color: colorOf(places[0]),
      media,
      mediaCount: countMedia(media),
    };
  }

  /**
   * 站点所在国家/地区的包围盒 —— 取景时的"地理上下文"。
   * 只装下路线会把地图顶到街道级，看不出这两站相对于国家在哪；
   * 把国家多边形一起量进包围盒，取景自然退到"看得到全国"的档位。
   * （route.js 还有一条保底：最多比"只装路线"低 1.1 档，防大国的盒子把路线压没。）
   */
  function contextBoundsFor(places) {
    if (!worldGeoJSON?.features?.length) return null;
    const ids = new Set();
    places.forEach((p) => {
      if (p.countryId) partsOfCountry(p.countryId).forEach((x) => ids.add(x));
    });
    if (!ids.size) return null;
    const extend = (coords) => {
      if (typeof coords[0] === 'number') { b?.extend(coords); return; }
      coords.forEach(extend);
    };
    let b = null;
    for (const f of worldGeoJSON.features) {
      if (!ids.has(f.properties?.id)) continue;
      if (!b) b = new maplibregl.LngLatBounds();
      extend(f.geometry?.coordinates || []);
    }
    return b;
  }

  /**
   * 数据更新后按 id 把对象**重新取一次**。
   *
   * ⚠️ 不能一直攥着打开那一刻的引用：轮询发现 places.json 变了就整份重新
   *    `normalize()` —— places / trips 全部换成**新对象**，旧引用从此与数据脱钩。
   *    弹窗开着时改了 places.json，界面会永远停在旧内容上（看着像"保存没生效"）。
   */
  function resolveRef(view) {
    const id = view.ref?.id;
    if (!id) return view.ref;
    const pool = view.kind === 'trip' ? (getTrips?.() || []) : (getPlaces() || []);
    return pool.find((x) => x.id === id) || view.ref;
  }

  /** 打开后的公共挂载流程。地点与行程只有"上半部地图怎么画"不同。 */
  function mount(view) {
    // 仅在"从关闭态重新打开"时清掉可能残留的全屏态；
    // 弹窗已开着时（点邻近图钉切换地点）保留全屏布局，只换内容。
    if (modal.hidden && fsActive) exitFs();
    current = view;
    stopFilter = null;                        // 新内容没有"上一次选中的站"

    // 记录关闭后要归还焦点的元素
    if (modal.hidden) lastFocus = document.activeElement;

    titleEl.textContent = view.name;
    dotEl.style.background = view.color;
    subEl.textContent = view.sub;
    badgeEl.textContent = view.badge;
    // 「编辑」对单地点与行程都有效（行程走编辑行程弹窗，增删足迹点）
    if (editBtn) editBtn.hidden = (view.kind !== 'place' && view.kind !== 'trip');
    // 「删除」同样仅对单地点有效
    if (deleteBtn) deleteBtn.hidden = view.kind !== 'place';
    // 「添加媒体」：仅单地点详情可见（按钮已移到头部，与编辑/删除并列）
    const addBtn = $('tm-modal-addbtn');
    if (addBtn) addBtn.hidden = view.kind !== 'place';

    renderTabs(view);
    renderContent(view);

    modal.hidden = false;
    modal.classList.remove('is-closing');
    document.body.classList.add('is-modal-open');

    // 每次打开都把滚动与地图高度复位
    bodyEl.scrollTop = 0;
    measureMaxH();
    panel.style.setProperty('--mw-h', `${scrollMaxH}px`);
    panel.style.setProperty('--mw-p', '0');
    panel.style.setProperty('--mw-blur', '0px');
    panel.classList.remove('is-scrolled');

    // 小地图在弹窗显示后再初始化，避免容器尺寸为 0 时 MapLibre 算出错误的画布尺寸
    requestAnimationFrame(() => {
      ensureDetailMap();
      syncDetailStyle();
      applyVisitedCountries(detailMap, getVisited(), DETAIL_FILL);   // 数据可能已更新，重新上色

      if (view.kind === 'trip') {
        /* 行程：上半部只画路线。
           先把地点图钉清掉，否则「京都 → 东京」这种短程路线会被周围一串邻居图钉淹没；
           routeAnim 自己也会清上一次的图层与站点标记。
           把站点所在国家的包围盒一起交给取景，让"走一遍"带上地理上下文。 */
        clearDetailMarkers();
        routeAnim.play(view.places, { contextBounds: contextBoundsFor(view.places) });
      } else {
        routeAnim.stop();                 // 从行程切到地点：动画与折线一并收掉
        renderDetailMarkers(view.ref);
      }
      detailMap.resize();
    });

    closeBtn.focus();
  }

  /** 打开一个地点（地图显示图钉与附近足迹，**不**放路线动画） */
  function open(place) {
    if (!place) return;
    mount(placeView(place));
  }

  /** 打开一次行程（地图播放"走一遍"，内容是各地点媒体的汇总） */
  function openTrip(trip) {
    if (!trip || !trip.places?.length) return;
    mount(tripView(trip));
  }

  function close() {
    if (modal.hidden) return;
    closeLightbox();
    stopFilter = null;                    // 下次打开不残留上一次的站点筛选
    routeAnim?.stop();                    // 先把动画停掉，别让它在退场动画期间继续跑
    modal.classList.add('is-closing');
    const done = () => {
      modal.hidden = true;
      modal.classList.remove('is-closing');
      document.body.classList.remove('is-modal-open');
      exitFs();                   // 关闭时还原全屏分栏的 DOM，确保下次打开是常规布局
      current = null;
      /* 弹窗完全关闭后通知外部（主图用它在 closeLightbox 之后把激活图钉
         恢复成普通大小——见 main.js 的 onClosed → markers.setActive(null)） */
      if (typeof onClosed === 'function') onClosed();
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    };
    // 等退场动画结束（尊重 prefers-reduced-motion）
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) done();
    else setTimeout(done, 240);
  }

  /* =========================================================
   * 全屏视图（左右分栏）
   * ---------------------------------------------------------
   * 右上角 ⤢ 按钮在「常规」与「全屏分栏」两种布局间切换：
   *   · 常规：地图在上、媒体在下（沿用既有滚动收缩逻辑）。
   *   · 全屏：左栏 = 地图 + 地点名称/日期等信息，右栏 = 多媒体网格。
   * 切换把 #tm-modal-mapwrap 与 .modal__head 临时搬进一个 .modal__left
   * 容器、并给 .modal 加 .modal--fullscreen；退出时把 DOM 还原，
   * 保证常规模式完全不受影响（地图实例本身不重建，只 resize）。
   * ========================================================= */
  const ICON_EXPAND = '<svg class="ico" viewBox="0 0 24 24"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"/></svg>';
  const ICON_COLLAPSE = '<svg class="ico" viewBox="0 0 24 24"><path d="M9 4v4a1 1 0 0 1-1 1H4M15 4v4a1 1 0 0 0 1 1h4M9 20v-4a1 1 0 0 0-1-1H4M15 20v-4a1 1 0 0 1 1-1h4"/></svg>';
  function setFsIcon(on) { if (fsBtn) fsBtn.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND; }

  function enterFs() {
    if (fsActive || modal.hidden) return;
    fsActive = true;
    modal.classList.add('modal--fullscreen');
    // 复位地图收缩相关变量（全屏下地图恒满高，--mw-p/--mw-blur 不应残留）
    panel.style.setProperty('--mw-p', '0');
    panel.style.setProperty('--mw-blur', '0px');
    const left = document.createElement('div');
    left.className = 'modal__left';
    panel.insertBefore(left, bodyEl);
    left.append(mapwrapEl, headEl);
    padEl.style.display = 'none';
    setFsIcon(true);
    if (fsBtn) { fsBtn.setAttribute('aria-pressed', 'true'); fsBtn.setAttribute('aria-label', '退出全屏视图'); }
    bodyEl.scrollTop = 0;
    // 布局切换后容器尺寸变了，地图必须 resize 才能铺满左栏
    requestAnimationFrame(() => { try { if (detailMap) detailMap.resize(); } catch (_) { /* 忽略 */ } });
  }

  function exitFs() {
    if (!fsActive) return;
    fsActive = false;
    modal.classList.remove('modal--fullscreen');
    // 先还原 .modal__head（紧跟占位块，恢复原有的 pad → head → tabs → content 顺序）
    padEl.after(headEl);
    // 再把地图容器移回 body 之前、删掉临时左栏
    panel.insertBefore(mapwrapEl, bodyEl);
    const left = panel.querySelector('.modal__left');
    if (left) left.remove();
    padEl.style.display = '';
    setFsIcon(false);
    if (fsBtn) { fsBtn.setAttribute('aria-pressed', 'false'); fsBtn.setAttribute('aria-label', '全屏视图'); }
    bodyEl.scrollTop = 0;
    // 仅在可见时 resize（隐藏态下容器为 0，resize 会报错且无意义）
    if (!modal.hidden) requestAnimationFrame(() => { try { if (detailMap) detailMap.resize(); } catch (_) { /* 忽略 */ } });
  }

  function toggleFs() { if (fsActive) exitFs(); else enterFs(); }

  /* =========================================================
   * 详情页：补充上传媒体（图片 / 视频 / 文本）
   * ---------------------------------------------------------
   * 走独立的「添加媒体」弹窗（upload-modal.js），由头部「添加媒体」按钮打开。
   * 弹窗自己负责多选 / 重命名 / 进度条，上传成功后通过 onAdded 回调刷新本弹窗。
   * ========================================================= */
  function openUploadModal() {
    const ref = current?.ref;
    if (current?.kind !== 'place' || !ref) return;
    if (!uploadModal) {
      uploadModal = createUploadModal({
        onAdded: () => { if (typeof onMediaChanged === 'function') onMediaChanged(); },
      });
    }
    uploadModal.open(ref.id, current?.name);
  }

  /* =========================================================
   * 事件绑定
   * ========================================================= */
  bodyEl.addEventListener('scroll', onScroll, { passive: true });
  closeBtn.addEventListener('click', close);
  fsBtn?.addEventListener('click', toggleFs);

  /* 详情页：头部「添加媒体」按钮（仅单地点模式可用，可见性由 mount 控制） */
  $('tm-modal-addbtn')?.addEventListener('click', openUploadModal);

  /* 编辑当前内容：地点交给新增/编辑弹窗，行程交给编辑行程弹窗（main.js 的 onEdit 按 places 数组分流） */
  editBtn?.addEventListener('click', () => {
    const ref = current?.ref;
    if (!ref) return;
    if (current?.kind !== 'place' && current?.kind !== 'trip') return;
    close();
    if (typeof onEdit === 'function') onEdit(ref);
  });

  /* 删除当前地点：先二次确认（破坏性操作，必须显式确认）→ 调后端删除 →
     关弹窗 → 通知上层刷新地图打点。后端会连带清掉该地点下的底层媒体文件，
     所以删除后数据库与磁盘都不会留下孤儿记录。 */
  deleteBtn?.addEventListener('click', async () => {
    const ref = current?.ref;
    if (current?.kind !== 'place' || !ref) return;
    if (!confirm(`确定删除「${ref.name}」及其所有媒体吗？\n此操作不可恢复。`)) return;
    try {
      await api.deletePlace(ref.id);
      close();
      if (typeof onDeleted === 'function') onDeleted();
    } catch (e) {
      toast(`删除失败：${e.message || '未知错误'}`);
    }
  });

  modal.addEventListener('click', (e) => {
    if (isCloseTarget(e.target)) close();
  });

  lbPrev.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
  lbNext.addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });
  lightbox.addEventListener('click', (e) => {
    if (isCloseTarget(e.target)) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (lightbox.hidden === false) {
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
      return;
    }
    if (!modal.hidden && e.key === 'Escape') { e.preventDefault(); close(); }
    if (!modal.hidden && (e.key === 'f' || e.key === 'F')) {
      // 别在输入框里打字时误触发（媒体编辑弹窗有 input/textarea）
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (!typing) { e.preventDefault(); toggleFs(); }
    }
  });

  window.addEventListener('resize', () => {
    if (modal.hidden) return;
    measureMaxH();
    syncScrollEffect();
  });

  /* 详情地图在窗口尺寸变化时同步 */
  try {
    window.addEventListener('resize', () => {
      try { detailMap?.resize(); } catch (err) { warnOnce('detail-resize', err.message); }
    });
  } catch (_) { /* 忽略 */ }

  return {
    open,
    openTrip,
    close,
    /** 直接进入全屏预览（照片查看页）：传入可视图媒体列表与起始索引。
     *   供「记录」页、主页海报墙点照片时直达，不再绕道地点详情弹窗。 */
    openLightbox,
    isOpen: () => !modal.hidden,
    get current() { return current?.ref || null; },
    /** 调试与验收用：当前是不是"行程模式"，以及这条路线上的站点顺序 */
    getTrip: () => (current?.kind === 'trip' ? current.ref : null),
    getStops: () => (current?.kind === 'trip' ? (routeAnim?.getStops() || []) : []),
    /** 调试与验收用：折线此刻画到哪儿了（点数 / 末端坐标 / 当前段） */
    getRouteProgress: () => (current?.kind === 'trip' ? (routeAnim?.progress() || null) : null),
    /** 调试与验收用：当前点选的站点（place id，null = 没选） */
    getStopFilter: () => stopFilter,
    /** 验收用：直接切换站点筛选（等同点打点 / 点空白） */
    selectStop: (id) => applyStopFilter(id),
    /**
     * 数据变化后刷新弹窗（由 main.js 的 renderAll 调用，10 秒一轮且只在
     * places.json 真的变了时才走到）。标题 / 副标题 / 徽标 / 媒体全部重建。
     *
     * ⚠️ 行程模式下**不重播**"走一遍"动画：那会让用户每 10 秒被迫从头看一遍。
     *    只有站点集合真的变了（往行程里加了地点）才重走。
     */
    refresh() {
      if (!current || modal.hidden) return;
      const kind = current.kind;
      const ref = resolveRef(current);
      const stopsBefore = kind === 'trip' ? (routeAnim?.getStops() || []).join('|') : '';

      current = kind === 'trip' ? tripView(ref) : placeView(ref);

      /* 数据更新后，原来选中的站可能已经不在行程里了 —— 先校验再渲染 */
      if (kind === 'trip' && stopFilter && !current.stops.some((s) => s.id === stopFilter)) {
        stopFilter = null;
      }

      titleEl.textContent = current.name;
      subEl.textContent = current.sub;
      badgeEl.textContent = current.badge;
      rerenderContent();                       // 含 Tab 计数与筛选徽标

      if (detailMap) applyVisitedCountries(detailMap, getVisited(), DETAIL_FILL);

      if (kind === 'trip') {
        const want = current.places.map((p) => p.name).join('|');
        if (want && want !== stopsBefore) {
          /* 站点集合真的变了 → 重播；重播会重建标记，选中态要在 play 之后补
             （play 内部会清 selIdx，而标记可能在样式就绪后才重建）。 */
          routeAnim.play(current.places, { contextBounds: contextBoundsFor(current.places) });
          if (stopFilter != null) routeAnim.highlight(routeAnim.getStopIds().indexOf(stopFilter));
        }
      } else {
        renderDetailMarkers(ref);      // 邻居图钉可能多了/少了
      }
    },
  };
}
