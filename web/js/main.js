/**
 * main.js · 启动编排
 * -----------------------------------------------------------
 * 职责：把各模块接起来，不承载具体业务逻辑。
 *   1. 建地图（mercator 平面）
 *   2. 读 world.json → 挂国家图层
 *   3. 读 places.json → 归属国家 → 上色 → 打图钉 → 图例 → 仪表盘
 *   4. 绑定控件（缩放 / 复位 / 底图切换 / 搜索 / 视图切换）
 *   5. 10 秒轮询自动同步
 */

import { CONFIG } from './config.js';
import {
  loadPlaces, startPolling, buildTypeColorMap,
} from './data.js';
import {
  loadWorld, collectVisited, countCountries, getFeatures,
} from './geo.js';
import { createMap, setBaseStyle, resetView, fitWorld, worldFitZoom, refitWorldZoom, syncWorldMinZoom } from './map.js';
import { addCountryLayers, applyVisitedCountries } from './countries.js';
import { createMarkerLayer } from './markers.js';
import { createLegend } from './legend.js';
import { createDetailModal } from './detail-modal.js';
import { createUI } from './ui.js';
import { $$, warnOnce, toast, rafThrottle } from './utils.js';
import { api } from './api.js';
import { initAuth, showLogin } from './auth.js';
import { initSetup } from './setup.js';
import { createAddPlace } from './upload.js';
import { createAddTrip } from './trip-edit.js';
import { createArchive } from './archive.js';
import { initWishes } from './wishstore.js';

/* =========================================================
 * 启动状态
 * ========================================================= */
const app = {
  map: null,
  world: null,
  places: [],
  trips: [],
  types: {},
  typeColor: () => '#7C9CC3',
  visited: new Map(),
  countriesCount: 0,
  countryTotal: 1,
  styleKey: CONFIG.defaultStyle,
  legend: null,
  markers: null,
  ui: null,
  modal: null,
  search: '',
  booted: false,
};

const bootEl = document.getElementById('tm-boot');
const errEl = document.getElementById('tm-boot-error');
const errMsgEl = document.getElementById('tm-boot-error-msg');

function hideBoot() {
  bootEl?.classList.add('is-hidden');
}
function showError(message) {
  bootEl?.classList.add('is-hidden');
  if (errEl) errEl.hidden = false;
  if (errMsgEl) errMsgEl.textContent = message;
}

/* =========================================================
 * 搜索过滤
 * ========================================================= */
function isVisible(place) {
  if (!app.search) return true;
  const q = app.search.toLowerCase();
  return [place.name, place.countryZh, place.type, place.country, place.city]
    .filter(Boolean)
    .some((s) => String(s).toLowerCase().includes(q));
}

function applySearch(keyword) {
  app.search = keyword;
  app.markers?.updateVisibility(isVisible);

  const matched = app.places.filter(isVisible);
  app.ui?.setStatus(`已加载 ${app.places.length} 个地点 · ${app.countriesCount} 个国家/地区`
    + (keyword ? ` · 匹配「${keyword}」${matched.length} 条` : '')
    + ' · 每 15 秒自动同步');

  if (keyword && matched.length) {
    app.map.flyTo({ center: [matched[0].lng, matched[0].lat], zoom: Math.max(app.map.getZoom(), 4), speed: 1.1 });
  }
}

/* =========================================================
 * 选择地点
 * ========================================================= */
function selectPlace(place, { openModal = false, fly = true } = {}) {
  if (!place) return;
  app.markers?.setActive(place.id);
  app.ui?.setSelected(place);

  if (fly && Number.isFinite(place.lng) && Number.isFinite(place.lat)) {
    app.map.flyTo({
      center: [place.lng, place.lat],
      zoom: Math.max(app.map.getZoom(), 4.5),
      speed: 0.9,
      curve: 1.4,
    });
  }
  if (openModal) app.modal?.open(place);
}

/* =========================================================
 * 数据 → 视图
 * ========================================================= */
async function renderAll() {
  // 1) 国家归属
  const { visited } = collectVisited(app.places);
  app.visited = visited;
  app.countriesCount = countCountries(visited);

  // 2) 国家上色
  if (app.map) applyVisitedCountries(app.map, visited);

  // 3) 图钉
  let hidden = app.legend?.getHiddenTypes() || new Set();
  app.markers.setHiddenTypes(hidden);
  app.markers.render(app.places, isVisible);

  // 4) 图例
  app.legend.setTypes(app.types);
  app.markers.setHiddenTypes(app.legend.getHiddenTypes());
  app.markers.updateVisibility(isVisible);

  // 5) 仪表盘
  app.ui.renderAll({
    places: app.places,
    trips: app.trips,
    types: app.types,
    colorOf: (p) => (p && p.color) || app.typeColor(p?.type),
    visited,
    countriesCount: app.countriesCount,
    countryTotal: app.countryTotal,
    selected: app.markers.getActiveId()
      ? app.places.find((p) => p.id === app.markers.getActiveId())
      : null,
  });

  applySearch(app.search);
  app.modal?.refresh();
  hideBoot();
}

async function handleData(data, { first = false } = {}) {
  app.types = data.types;
  app.places = data.places;
  app.trips = data.trips || [];
  app.typeColor = buildTypeColorMap(data.types);
  await renderAll();
  if (first) {
    // 记住"最近一次已发生的足迹"：弹窗、图钉高亮会用到 selected。
    // （原来这里是给右侧的「选中地点详情」卡填内容，那张卡 2026-10-06 已换成旅途海报。）
    const now = Date.now();
    const recent = app.places
      .filter((p) => p.dateTs && p.dateTs <= now)
      .sort((a, b) => b.dateTs - a.dateTs)[0];
    if (recent) app.ui?.setSelected(recent);
  }
}

/** 写入后主动刷新一次（不必等轮询）。401 时弹登录。 */
async function refreshData() {
  try {
    const r = await loadPlaces(false);
    if (r && r.data) await handleData(r.data);
  } catch (err) {
    if (err && err.status === 401) showLogin();
  }
}

/* =========================================================
 * 用户资料（侧栏头像 / 用户名 → 弹窗编辑）
 * ========================================================= */
let userProfile = null; // 当前资料，弹窗取用

/** 把资料渲染回侧栏：用户名 + 头像（有 avatar 则盖掉默认 SVG）。 */
function renderUserHead(profile) {
  if (!profile) return;
  userProfile = profile;
  const hi = document.getElementById('tm-user-hi');
  const avatar = document.getElementById('tm-user-avatar');
  if (hi) hi.textContent = `Hi, ${profile.name || 'Coral'}`;
  if (avatar) {
    if (profile.avatar) avatar.innerHTML = `<img src="${profile.avatar}" alt="">`;
    /* 没有 avatar 时保留 HTML 里默认的那枚生成式 SVG，不动它 */
  }
}

/** 拉取资料并渲染侧栏（独立于地点数据，尽早调用）。 */
async function loadProfile() {
  try {
    const profile = await api.getProfile();
    renderUserHead(profile);
  } catch (err) {
    if (err && err.status === 401) return; // 稍后由登录遮罩处理
    warnOnce('profile', `读取用户资料失败：${err.message}`);
  }
}

/** 绑定「点侧栏 → 弹窗」「换头像」「保存用户名」。 */
function initUserProfile() {
  const openBtn = document.getElementById('tm-user-open');
  const modal = document.getElementById('tm-user-modal');
  const form = document.getElementById('tm-user-form');
  const nameInput = document.getElementById('tm-user-name');
  const avInput = document.getElementById('tm-user-avinput');
  const changeBtn = document.getElementById('tm-user-change-av');
  const modalAvatar = document.getElementById('tm-user-modal-avatar');
  const status = document.getElementById('tm-user-status');
  if (!openBtn || !modal || !form) return;

  const defaultAvatarHTML = modalAvatar ? modalAvatar.innerHTML : '';
  let pendingAvatar = null; // { file, url } 或 null

  function openModal() {
    const cur = userProfile || { name: 'Coral', avatar: '' };
    nameInput.value = cur.name || '';
    pendingAvatar = null;
    if (modalAvatar) {
      modalAvatar.innerHTML = cur.avatar ? `<img src="${cur.avatar}" alt="">` : defaultAvatarHTML;
    }
    status.textContent = '';
    status.classList.remove('is-error');
    modal.hidden = false;
  }
  function closeModal() { modal.hidden = true; }

  openBtn.addEventListener('click', openModal);
  modal.querySelectorAll('[data-close="1"]').forEach((el) => el.addEventListener('click', closeModal));

  changeBtn?.addEventListener('click', () => avInput && avInput.click());
  avInput?.addEventListener('change', () => {
    const file = avInput.files && avInput.files[0];
    if (!file || !modalAvatar) return;
    if (pendingAvatar && pendingAvatar.url) URL.revokeObjectURL(pendingAvatar.url);
    const url = URL.createObjectURL(file);
    pendingAvatar = { file, url };
    modalAvatar.innerHTML = `<img src="${url}" alt="">`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (nameInput.value || '').trim() || 'Coral';
    status.textContent = '保存中…';
    status.classList.remove('is-error');
    try {
      let merged = { ...(userProfile || {}), name };
      const r = await api.putProfile({ name });
      if (r && r.name) merged.name = r.name;

      if (pendingAvatar && pendingAvatar.file) {
        const fd = new FormData();
        fd.append('file', pendingAvatar.file);
        const ar = await api.uploadAvatar(fd);
        if (ar && ar.url) merged.avatar = ar.url;
        if (ar && ar.profile && ar.profile.name) merged.name = ar.profile.name;
        if (pendingAvatar.url) URL.revokeObjectURL(pendingAvatar.url);
        pendingAvatar = null;
      }
      renderUserHead(merged);
      status.textContent = '已保存';
      setTimeout(closeModal, 600);
    } catch (err) {
      status.textContent = err.message || '保存失败';
      status.classList.add('is-error');
    }
  });
}

/* =========================================================
 * 控件
 * ========================================================= */
/**
 * 按缩放级别微调图钉大小（相对基准的倍数，不改变基准本身）。
 * 基准尺寸见 js/markers.js 的 PIN.w / PIN.h（= 效果图实测 14×20 × PIN_DISPLAY）。
 * 下面这一串是**相对倍数**，与 PIN_DISPLAY 无关，改图钉大小不需要动这里。
 * 低缩放档位为 1，越放大只是略微加大，避免高缩放下钉子显得太小。
 */
function bindZoomScale() {
  const apply = () => {
    const z = app.map.getZoom();
    const scale = z < 2.6 ? 1 : (z < 3.6 ? 1.08 : (z < 5 ? 1.18 : 1.3));
    app.map.getContainer().style.setProperty('--pin-scale', String(scale));
  };
  app.map.on('zoom', rafThrottle(apply));
  apply();
}

/**
 * 记录**上一次算出来的世界档**。
 *
 * ⚠️ 判断"用户有没有放大过"，不能拿「当前 zoom」去比「用**新**容器尺寸算出的世界档」：
 *    窗口变窄时世界档会**变小**，于是"上一档的世界视角"看起来就像"被放大过"，
 *    重排会被静默跳过（实测：1600→1480 后 zoom 卡在 1.3945，没有跟到 1.2597）。
 *    必须拿"上一次的世界档"当基准。
 */
let lastFitZoom = null;

/**
 * 仅当相机仍停在"世界视角"那一档时，按当前容器尺寸重新铺满。
 *
 * 用户一旦放大探索过（zoom 明显高于世界档），这里什么也不做 ——
 * 否则改个窗口大小就会把他刚拉近的视角一把拽回全世界，很烦人。
 *
 * ⚠️ 重排用 refitWorldZoom 而不是 fitWorld：世界横向是**循环**的、用户可能已经
 *    拖到别的经度，这里只该跟着新尺寸改 zoom，不该把经度拉回 center[0]。
 * ⚠️ 缩放下限（= 世界档）依赖容器尺寸，**无论要不要重排都得跟着改**，
 *    否则缩到底会停在旧的下限上（世界比视口宽 → 看不到整幅世界）。
 */
function refitIfWorldView() {
  if (!app.map) return;
  const z = worldFitZoom(app.map);
  const atWorld = lastFitZoom == null || app.map.getZoom() <= lastFitZoom + 0.02;
  lastFitZoom = z;
  if (atWorld) refitWorldZoom(app.map);   // 内部即 syncWorldMinZoom + jumpTo(zoom)
  else syncWorldMinZoom(app.map);         // 只把闸门跟着容器改，不动用户的视角
}

/* 视口尺寸变化 → 卡片尺寸可能变了 → 世界档跟着变。
   去抖 160ms：拖窗口时不必每一帧都重算（MapLibre 自己会 resize 画布）。 */
let refitTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(refitIfWorldView, 160);
});

function bindControls() {
  document.getElementById('tm-zoom-in')?.addEventListener('click', () => app.map.zoomIn());
  document.getElementById('tm-zoom-out')?.addEventListener('click', () => app.map.zoomOut());
  document.getElementById('tm-reset')?.addEventListener('click', () => resetView(app.map));
  document.getElementById('tm-style-toggle')?.addEventListener('click', () => {
    const keys = Object.keys(CONFIG.styles);
    const next = keys[(keys.indexOf(app.styleKey) + 1) % keys.length];
    app.styleKey = next;
    setBaseStyle(app.map, next);
    toast(`底图样式：${next}`);
  });

  // 地图容器在视图切换时会隐藏，重新显示后需要 resize，否则画布尺寸为 0
  app.ui?.setView(app.ui.getView());
}

/* =========================================================
 * 启动
 * ========================================================= */
async function boot() {
  if (typeof maplibregl === 'undefined') {
    showError('MapLibre GL JS 加载失败：请确认 web/vendor/maplibre-gl.js 已随前端正确部署，然后刷新页面。');
    return;
  }

  /* ---- 地图 ---- */
  try {
    app.map = createMap('tm-map');
  } catch (err) {
    showError(`地图初始化失败：${err.message}`);
    return;
  }

  // 调试入口：控制台可直接访问 window.__tm.map / .places / .visited
  window.__tm = app;
  window.__tmMap = app.map;

  /* 默认视角 = 整个世界。这里就调一次，让**首帧**就是世界视角，
     免得先闪一下 config 里的占位视角再跳过去（数据加载期间 boot 遮罩虽在，
     但遮罩是渐隐的，跳变仍可能被看见）。
     ⚠️ 必须等容器有尺寸：.mapcard 的高度来自 CSS，而 main.js 是 module 脚本，
        执行时 DOM 已就绪、样式已应用，clientWidth 是准的。
     返回值记进 lastFitZoom，作为"用户有没有放大过"的比较基准。 */
  lastFitZoom = fitWorld(app.map);

  /* ---- 国家边界（上色与归属的基础） ---- */
  try {
    app.world = await loadWorld();
    app.countryTotal = getFeatures().filter((f) => f.properties?.count !== false).length || 1;
  } catch (err) {
    warnOnce('world-load', `读取 world.json 失败，已跳过国家上色与自动归属：${err.message}`);
    app.world = null;
  }

  const onCountryLayers = (m) => {
    if (!app.world) return;
    addCountryLayers(m, app.world);
    applyVisitedCountries(m, app.visited);
  };
  app.map.registerStyleHook(onCountryLayers);

  /* ---- 模块 ---- */
  app.markers = createMarkerLayer(app.map, {
    colorOf: (p) => p.color || app.typeColor(p.type),
    onSelect: (place) => selectPlace(place, { openModal: true, fly: true }),
  });

  /* 注意：**主地图上已经没有任何路线回放**（2026-10-05 需求调整）。
     「在地图上走一遍」搬进了媒体弹窗，跑在弹窗自己那张小地图上，
     由 detail-modal.js 持有（见 js/route.js 的文件头注释）。 */

  /* 图例：常驻在「足迹概览」卡内部（#tm-legend），不再自己单独开合 ——
     整张卡本身就是可收起的（见下面 app.legend 之后的收起接线）。 */
  const legendPanel = document.getElementById('tm-legend');

  /* 足迹概览的**整块**收起 / 展开。
     卡片默认收起（#tm-statcard 在 HTML 上就带 hidden），地图左下角只留一枚小开关，
     点它才把整张卡展开。收起不改变任何筛选状态 —— 被隐藏的类型记在 app.legend 里，
     卡片藏起来只是看不见，地图上的图钉该少还是少。 */
  const statCard = document.getElementById('tm-statcard');
  const statToggle = document.getElementById('tm-stat-toggle');

  /* 卡片收着、但图例里有类型被筛掉时点亮开关按钮。
     不做这个提示的话，用户收起卡片后看不到任何状态：随手点一下筛选、卡片一收，
     图钉少了一半却找不到原因，会以为地图坏了或"点了没反应"。 */
  function syncStatToggle() {
    if (!statToggle) return;
    const hidden = app.legend ? app.legend.getHiddenTypes().size : 0;
    statToggle.classList.toggle('is-active', hidden > 0);
  }

  app.legend = createLegend(legendPanel, {
    onChange: () => {
      app.markers.setHiddenTypes(app.legend.getHiddenTypes());
      app.markers.updateVisibility(isVisible);
      syncStatToggle();
    },
  });

  if (statToggle && statCard) {
    statToggle.addEventListener('click', () => {
      const expand = statCard.hidden;         // 当前是收起 → 本次即「展开」
      statCard.hidden = !expand;
      /* 箭头朝向、按钮形态（胶囊 ↔ 圆钮）、以及展开后挪进卡片右上角，
         都由 CSS 读 aria-expanded 决定，这里只同步这一个属性 */
      statToggle.setAttribute('aria-expanded', String(expand));
      statToggle.title = expand ? '收起足迹概览' : '展开足迹概览';
    });
  }

  app.ui = createUI({
    onSelectPlace: (place, opts) => selectPlace(place, { openModal: opts?.openModal, fly: true }),
    onOpenDetail: (place) => selectPlace(place, { openModal: true, fly: false }),
    /* 点照片（记录页 / 海报墙）→ 直接进全屏照片查看页（lightbox），不再弹地点详情弹窗。
       ⚠️ 文字笔记没有画面，lightbox 无法预览，回落到地点详情弹窗。 */
    onOpenPhoto: (place, item) => {
      if (!place) return;
      if (!item || item.type === 'text') {
        selectPlace(place, { openModal: true, fly: false });
        return;
      }
      const list = (place.media || []).filter((m) => m.type === 'image' || m.type === 'video');
      let index = list.findIndex((m) => m.id && item.id && m.id === item.id);
      if (index < 0) index = list.findIndex((m) => m.url === item.url);
      if (index < 0) index = 0;
      app.modal?.openLightbox(list, index);
    },
    onAddPlace: () => addPlace?.open(),
    /* 编辑已有地点（「待整理照片」组件里的「缺日期 / 缺坐标」条目点进来就走这里，
       直接落到「编辑足迹」弹窗，而不是只读的详情弹窗） */
    onEditPlace: (place) => addPlace?.edit(place),
    onAddTrip: () => addTrip?.open(),
    onOpenArchive: () => archive?.open(),
    /* 行程分组头的标题被点开：直接开媒体弹窗，路线动画跑在弹窗上半部的小地图里。
       ⚠️ app.modal 是在 createUI **之后**才建的（见下面 createDetailModal），
          所以这里必须惰性取用，不能在参数里直接引用 app.modal.openTrip。 */
    onOpenTrip: (trip) => app.modal?.openTrip(trip),
    onViewChange: (name) => {
      if (name !== 'map') return;          // 只有回到地图视图才需要校正画布尺寸
      /* 地图视图重新可见后校正画布尺寸。
         ⚠️ 必须**同步** resize 一次，不能只靠 rAF 里的那一次：
            统计页点「国家排行 / 年份芯片」会在同一次点击里先 setView('map') 再 flyTo，
            此时 MapLibre 内部记的画布尺寸还是切走前的 0×0（setView 只翻了 hidden 属性，
            resize 排在 rAF 里，赶不上紧随其后的 flyTo）。
            flyTo 用 0×0 的画布算投影 → **落点会偏**：实测去北京（116.41°E）落到了 131.11°E，
            纬度却基本正确，所以只看"飞过去了"很容易漏掉。多调一次没有副作用，
            这里也不是逐帧调用（不会打断在途瓦片请求）。 */
      try { app.map.resize(); } catch (_) { /* 忽略 */ }
      requestAnimationFrame(() => {
        try { app.map.resize(); } catch (_) { /* 忽略 */ }
        /* 回到地图视图时若仍停在世界档，按当前宽度重新铺满
           （在别的视图里改过窗口大小时会用到；宽度没变则是幂等的） */
        refitIfWorldView();
      });
    },
    onSearch: applySearch,
  });

  app.modal = createDetailModal({
    colorOf: (p) => (p && p.color) || app.typeColor(p?.type),
    worldGeoJSON: app.world,
    getPlaces: () => app.places,
    /* 弹窗开着时若数据刷新，要能按 id 取到"新对象"（轮询把 places/trips 整批换成
       新引用，弹窗不能一直攥着打开那一刻的旧引用，详见 detail-modal 的 resolveRef） */
    getTrips: () => app.trips,
    getVisited: () => app.visited,
    getStyleKey: () => app.styleKey,
    /* 详情弹窗「编辑」→ 地点交给新增/编辑弹窗，行程交给编辑行程弹窗（按 places 数组区分）。
       addPlace / addTrip 都在下方创建，点击时才取用，无 TDZ 问题。 */
    onEdit: (item) => {
      if (item && Array.isArray(item.places)) { addTrip?.edit(item); return; }
      /* 心愿地点（本机自建）走专属「编辑心愿地点」弹窗，而不是 travel/residence 弹窗 */
      if (item && item.isWishNew) { app.ui?.openWishEdit(item); return; }
      addPlace?.edit(item);
    },
    /* 详情弹窗「删除」→ 删完主动刷新一次地图打点（不必等 15 秒轮询） */
    onDeleted: () => refreshData(),
    /* 详情弹窗内「补充上传 / 删除单条媒体」→ 上传/删除后主动刷新（弹窗会跟着 refresh） */
    onMediaChanged: () => refreshData(),
    /* 详情弹窗关闭 → 取消图钉的选中放大（is-active 只在查看期间保留，
       否则看过的那个钉子会一直停在 1.3 倍大小不回去） */
    onClosed: () => { app.markers?.setActive(null); },
  });

  /* ---- 新增 / 上传（记录新足迹 / 照片 / 视频 / 笔记） ---- */
  const addPlace = createAddPlace({ getMap: () => app.map, onSaved: refreshData });

  /* ---- 新建行程组（多地点行程） ---- */
  const addTrip = createAddTrip({ getPlaces: () => app.places, onSaved: refreshData });

  /* ---- 批量照片归类（按 GPS 自动建地点） ---- */
  const archive = createArchive({ onSaved: refreshData });

  /* ---- 鉴权：未设密码则开放，否则弹登录遮罩，登录成功才继续 ---- */
  const authed = await initAuth();
  if (!authed) return; // 停在登录遮罩，不加载数据

  /* ---- 首次配置向导：首进时选择媒体存储方式（内置 MinIO / 本地目录） ---- */
  const setupOk = await initSetup();
  if (!setupOk) return; // 停在配置遮罩，不加载数据

  /* ---- 用户资料：拉取并渲染侧栏，绑定编辑弹窗 ---- */
  initUserProfile();
  await loadProfile();

  /* ---- 心愿数据：从服务端拉取（首次会把本机 localStorage 数据迁移上云） ---- */
  await initWishes();

  /* ---- 数据 ---- */
  let first;
  try {
    first = await loadPlaces(true);
  } catch (err) {
    if (err && err.status === 401) { showLogin(); return; }
    showError('读取数据失败：' + (err.message || err));
    return;
  }
  if (first.data) {
    await handleData(first.data, { first: true });
  } else {
    showError('读取数据失败：请确认后端服务已启动，且通过 HTTP 访问页面。');
    return;
  }

  app.ui.renderSettingsView({
    styleKey: app.styleKey,
    onStyleChange: (key) => { app.styleKey = key; setBaseStyle(app.map, key); },
    /* 导入备份完成后立刻重新拉数据（否则要等 15 秒轮询才看到恢复的内容） */
    onDataReload: () => { refreshData(); },
  });

  bindControls();
  bindZoomScale();
  app.ui.setView('map');

  /* ---- 自动同步 ---- */
  startPolling((data) => { handleData(data); }, { onUnauthorized: () => showLogin() });

  app.booted = true;
}

/* 视图切换后地图尺寸校正（覆盖所有进入地图视图的路径） */
const mapViewObserver = () => {
  const view = document.querySelector('.view[data-view="map"]');
  if (!view || !app.map) return;
  const io = new MutationObserver(() => {
    if (!view.hidden) requestAnimationFrame(() => { try { app.map.resize(); } catch (_) { /* 忽略 */ } });
  });
  io.observe(view, { attributes: true, attributeFilter: ['hidden'] });
};
mapViewObserver();

/* 全局兜底：捕获未处理异常，展示可读提示，避免用户面对空白页面 */
window.addEventListener('unhandledrejection', (e) => {
  warnOnce('unhandled', `未处理的异步错误：${e.reason?.message || e.reason}`);
});

boot().catch((err) => {
  /* 带上出错位置的第一帧。项目没有打包步骤，栈里的文件名就是源码文件名，
     否则用户只能拿到一句光秃秃的 TypeError，排查全靠猜。 */
  const at = String(err.stack || '').split('\n')
    .map((l) => l.match(/([\w.-]+\.js):(\d+)/))
    .find(Boolean);
  showError(`启动失败：${err.message}${at ? `（${at[1]}:${at[2]}）` : ''}`);
});
