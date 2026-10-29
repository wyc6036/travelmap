/**
 * ui.js · 侧栏 / 页头 / 统计 / 各类列表视图
 * -----------------------------------------------------------
 * 还原 UI_Ref.jpeg 的仪表盘结构：
 *   侧栏（品牌 / 导航 / 用户卡 / 底部插画）
 *   页头（标题 + 分享 / 搜索 / 底图切换 / 记录新足迹）
 *   地图卡（在 map.js / markers.js 中处理）
 *   下半区：左列「最近足迹 · 愿望清单 · 我的记录」上下叠放 ｜ 右列「旅途海报」（两列等高）
 * 其余视图（足迹 / 记录 / 愿望清单 / 统计 / 设置）数据驱动，全部可用。
 *
 * ⚠️ 2026-10-06 改版：右列原来是「选中地点详情」卡 —— 只有点图钉才更新，
 *    静止时大半时间是「选择一处足迹」的占位态，占着最大的一块地方却没内容。
 *    换成旅途海报（js/poster.js）：从全部多媒体里随机抽，尺寸不等、各自随机翻牌。
 *
 * ⚠️ 「行程」视图已并入「足迹」（2026-10-05）。原因：两个模块的组织方式完全相同
 *    （都按年份分组、同一批数据），差别只在单位（趟 vs 点），而 33 次行程里有 30 次
 *    只覆盖 1 个地点 —— 于是两个页面 91% 的内容是同一条记录的两种说法。
 *    现在统一为「年份 → 行程 → 地点」两级时间线：
 *    多地点行程渲染成一张**可折叠**的分组行（点标题进弹窗，弹窗小地图里跑
 *    "在地图上走一遍"，见 js/route.js；点箭头只展开/收起组内地点行），
 *    单地点行程自动退化为一行普通足迹。
 */

import { MEDIA_LABELS, VIEW_META, COLORS, regionLabel } from './config.js';
import { api } from './api.js';
import { CITIES } from './cities.js';
import {
  escapeHtml, formatDateDot, formatDateRange, countUp, toast, parseDate, debounce,
} from './utils.js';
/* 统计页拆到独立模块（内容多、且几乎全是自绘图表，混在本文件里不好维护）。
   这里只做"注入依赖 + 桥接事件"，图表本身一行都不在 ui.js 里。 */
import { renderStatsView as renderStatsPanel } from './stats.js';
/* 图例 / 统计页的类型标记都用地图上那枚图钉（同一份字形，来自 markers.js 的 pinSvg） */
import { pinSvg } from './markers.js';
/* 地图页右列的「旅途海报」墙（多张同时陈列 + 各自随机翻牌） */
import { createPoster } from './poster.js';
/* 心愿注解的唯一数据源（localStorage + 跨模块变更通知），与 upload.js 共用，
   避免重复维护、缓存不一致。ui.js 内只保留派生口径等纯函数。 */
import { getAnn, setAnn, getNewPlaces, addWishPlace, updateWishPlace, deleteWishPlace, initWishes } from './wishstore.js';
/* 国家 / 地区中心点经纬度库（离线优先，Nominatim 在线兜底）—— 新建心愿地点填国家时补全坐标 */
import { COUNTRY_CENTROIDS } from './country-centroids.js';

const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`;

/* =========================================================
 * 小组件
 * ========================================================= */
function mediaThumb(item, { lazy = true } = {}) {
  /* 网格缩略图优先用后端预生成的 720px 缩略图（thumb_url），重量级全图（url）只留给灯箱查看页，
     这样滚动时下载/解码压力大幅降低，避免“一半白屏” */
  if (item.type === 'video' && item.poster) return item.poster;
  return item.thumb_url || item.url;
}

function mediaCard(item, place, { onOpen, showPlace = true }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `mcard${item.type === 'text' ? ' mcard--text' : ''}`;
  btn.title = item.caption || place.name;

  if (item.type === 'text') {
    btn.innerHTML = `<div class="mcard__media"><p class="mcard__note">${escapeHtml(item.text || '')}</p></div>`;
  } else {
    btn.innerHTML = `
      <div class="mcard__media">
        <img src="${escapeHtml(mediaThumb(item))}" alt="${escapeHtml(item.caption || place.name)}"
             loading="lazy" decoding="async" referrerpolicy="no-referrer" />
        ${item.type === 'video' ? `<span class="mcard__badge">${icon('video', 'ico ico--sm')}视频</span>` : ''}
      </div>`;
    const img = btn.querySelector('img');
    img?.addEventListener('error', () => { img.src = './assets/sidebar-art.svg'; }, { once: true });
  }

  btn.insertAdjacentHTML('beforeend', `
    <div class="mcard__meta">
      <p class="mcard__name">${escapeHtml(place.name)}</p>
      <p class="mcard__sub">${icon('pin', 'ico ico--sm')}
        ${escapeHtml(place.countryZh || place.type)}${place.date ? ` · ${escapeHtml(formatDateDot(place.date))}` : ''}
      </p>
    </div>`);

  btn.addEventListener('click', () => onOpen?.(place, item));
  return btn;
}

/** 地点卡（用于「最近足迹」条带与愿望清单）
 *  opts.badge: 'total' 时角标改成「记录总数」（默认只标视频数）——
 *  首页磁贴空间紧张，一张卡只说得出一个数，说总数比只说视频有用。 */
function placeCard(place, { onOpen, badge = 'video' }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mcard';
  /* 封面优先级：真实媒体（用户上传的图/视频首帧）> 联网地标占位图（cover_url）> 默认占位 SVG。
     这样"上传真实媒体后占位图被替换 + 彻底让位"自然成立，无需额外判断。 */
  const media = place.media || [];
  const realCover = (media.find((m) => m.type === 'image') || {}).thumb_url
    || (media.find((m) => m.type === 'image') || {}).url
    || (media.find((m) => m.type === 'video') || {}).poster
    || (media.find((m) => m.type === 'video') || {}).url
    || '';
  const cover = realCover || place.cover || './assets/sidebar-art.svg';
  const total = place.mediaCount ? place.mediaCount.total : 0;
  const countBadge = badge === 'total' && total
    ? `<span class="mcard__badge">${icon('image', 'ico ico--sm')}${total}</span>`
    : (place.mediaCount.video ? `<span class="mcard__badge">${icon('video', 'ico ico--sm')}${place.mediaCount.video}</span>` : '');
  btn.innerHTML = `
    <div class="mcard__media">
      <img src="${escapeHtml(cover)}" alt="${escapeHtml(place.name)}"
           loading="lazy" decoding="async" referrerpolicy="no-referrer" />
      ${countBadge}
    </div>
    <div class="mcard__meta">
      <p class="mcard__name">${escapeHtml(place.name)}</p>
      <p class="mcard__sub">${icon('pin', 'ico ico--sm')}
        ${escapeHtml(place.countryZh || place.type)}${place.date ? ` · ${escapeHtml(formatDateDot(place.date))}` : ''}
      </p>
    </div>`;
  const img = btn.querySelector('img');
  img?.addEventListener('error', () => { img.src = './assets/sidebar-art.svg'; }, { once: true });
  btn.addEventListener('click', () => onOpen?.(place));
  return btn;
}

/* 行程卡 tripCard() 已删（2026-10-05）：它只服务「行程」视图与「最近旅程」条带，
   两者都并入了「足迹」。行程现在渲染成时间线里的**可折叠分组行**，由本文件内部的
   tripGroupRow() 生成 —— 形态与 tripCard 不同（整幅宽的条带，标题旁一个箭头），
   但信息口径一致：名称 / 日期区间 / 大洲或国家 / 地点数与地点名（展开后可见）。 */

function addTile(label, hint, onClick) {  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'mcard mcard--add';
  tile.innerHTML = `
    <div class="mcard__media">
      <span class="mcard__plus">＋</span>
      <span class="mcard__hint">${escapeHtml(label)}</span>
      <span class="mcard__hint2">${escapeHtml(hint)}</span>
    </div>`;
  tile.addEventListener('click', onClick);
  return tile;
}

function emptyState(title, sub) {
  return `<div class="empty"><div class="empty__big">🗺️</div><div>${escapeHtml(title)}</div>`
    + `<div class="muted" style="font-size:12px;margin-top:4px">${escapeHtml(sub)}</div></div>`;
}

/* =========================================================
 * 主 UI
 * ========================================================= */
/**
 * @param {object} deps
 * @param {(place:object, opts?:object)=>void} deps.onSelectPlace 选中地点（地图定位）
 * @param {(place:object)=>void} deps.onOpenDetail 打开地点详情弹窗
 * @param {(name:string, opts?:object)=>void} deps.onViewChange 视图切换
 * @param {(kw:string)=>void} deps.onSearch 搜索
 * @param {(trip:object)=>void} deps.onOpenTrip 打开行程（媒体弹窗里带"走一遍"动画）
 */
/* ---------- DOM 契约自检 ----------
   index.html 与 js/ 是**成对发布**的，两边版本必须一致。浏览器一旦把改动前后的两份混着
   缓存（`python3 -m http.server` 不发 `Cache-Control`，浏览器按"末次修改的 10%"估一个
   新鲜期，于是几分钟前刚改过的文件会被当成"还能直接用"而不去校验），这里就会取到 null。
   而报错往往从十万八千里外的 innerHTML 赋值处冒出来 —— 只有一句
   `Cannot set properties of null (setting 'innerHTML')`，完全看不出是缓存问题。
   所以在这里一次性把缺失的选择器报全，并直接给出解法。
   ⚠️ 正常路径零额外开销：一次 Object.entries 遍历，约 30 个键。 */
function pickDom(map) {
  const out = {};
  const missing = [];
  for (const [key, sel] of Object.entries(map)) {
    const node = sel.startsWith('#')
      ? document.getElementById(sel.slice(1))
      : document.querySelector(sel);
    if (!node) missing.push(sel);
    out[key] = node;
  }
  if (missing.length) {
    throw new Error(
      `页面 HTML 与脚本不是同一版本：找不到 ${missing.join('、')}。`
      + '浏览器多半缓存了改动前的文件，请强制刷新（macOS Cmd+Shift+R / Windows Ctrl+F5）后重试。',
    );
  }
  return out;
}

export function createUI({ onSelectPlace, onOpenDetail, onOpenPhoto, onViewChange, onSearch, onOpenTrip, onAddPlace, onAddTrip, onOpenArchive, onEditPlace }) {
  const dom = pickDom({
    nav: '#tm-nav',
    scroll: '#tm-scroll',
    title: '#tm-view-title',
    sub: '#tm-view-sub',
    share: '#tm-share',
    add: '#tm-add',
    tripAdd: '#tm-trip',
    search: '#tm-search',
    styleToggle: '#tm-style-toggle',

    statCountries: '[data-count="tm-stat-countries"]',
    statCities: '[data-count="tm-stat-cities"]',
    statTrips: '[data-count="tm-stat-trips"]',

    userCountries: '#tm-user-countries',
    userPct: '#tm-user-pct',
    userBar: '#tm-user-bar',

    status: '#tm-status',

    collFilter: '#tm-coll-filter',
    viewFootprints: '#tm-view-footprints',
    viewCollections: '#tm-view-collections',
    viewWishlist: '#tm-view-wishlist',
    viewStats: '#tm-view-stats',
    viewSettings: '#tm-view-settings',
  });

  let state = null;
  let currentView = 'map';
  let collMediaFilter = 'all';
  /* 已展开的行程分组 id。放在闭包里而不是 DOM 上：足迹视图每次渲染都整块重建，
     状态若只存在 DOM 里，10 秒一轮的自动同步就会把它抹掉（见 tripGroupRow）。 */
  const expandedTrips = new Set();

  /* 旅途海报改由 Widget 注册表里的 poster 组件按需创建（见下方 Widget 系统）。
     这里不再持有全局 poster 实例。 */

  /* 记录页筛选条：常驻顶部（sticky）；玻璃带强度随滚动进度渐显。
     把 p∈[0,1] 写进 CSS 变量 --coll-p，由 CSS 负责「模糊 + 底部渐隐」的表现
     —— 复刻地点详情弹窗「地图与媒体之间」的 ScrollEdgeEffect（JS 只算值，一帧一次）。 */
  if (dom.scroll && dom.collFilter) {
    let rafId = 0;
    const syncFilterEdge = () => {
      rafId = 0;
      const p = Math.min(1, Math.max(0, dom.scroll.scrollTop / 24));
      dom.collFilter.style.setProperty('--coll-p', p.toFixed(3));
    };
    dom.scroll.addEventListener('scroll', () => {
      if (!rafId) rafId = requestAnimationFrame(syncFilterEdge);
    }, { passive: true });
    syncFilterEdge();
  }

  /* ---------- 视图切换 ---------- */
  function setView(name, { media } = {}) {
    if (!VIEW_META[name]) name = 'map';
    currentView = name;
    if (media) collMediaFilter = media;

    document.querySelectorAll('.view').forEach((v) => {
      const active = v.dataset.view === name;
      v.hidden = !active;
      v.classList.toggle('is-active', active);
    });

    // 页尾说明文字（底图/数据/国界版权等）：仅主页（地图）与设置页展示，其余视图隐藏
    const foot = document.querySelector('.sitefoot');
    if (foot) foot.hidden = !(name === 'map' || name === 'settings');

    dom.nav.querySelectorAll('[data-view]').forEach((b) => {
      const same = b.dataset.view === name;
      const mediaOk = !b.dataset.media || b.dataset.media === collMediaFilter;
      b.classList.toggle('is-active', same && mediaOk);
    });
    dom.collFilter.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('is-active', c.dataset.media === collMediaFilter);
    });

    const meta = VIEW_META[name];
    dom.title.textContent = meta.title;
    dom.sub.textContent = meta.sub;
    dom.scroll.scrollTop = 0;

    // 惰性渲染：切到哪个视图就渲染哪个。
    // （renderAll 只在数据变化时兜底重渲染，不能作为"进入视图"的唯一入口，
    //   否则首次点进"足迹/行程/愿望清单/统计"会是一整片空白，直到下一次轮询。）
    renderViewFor(name);
    if (typeof onViewChange === 'function') onViewChange(name, { media: collMediaFilter });
  }

  /** 视图名 → 渲染函数（map 视图由 renderAll 的仪表盘部分负责，无需单独入口） */
  function renderViewFor(name) {
    if (!state) return;
    if (name === 'footprints') renderFootprintsView();
    else if (name === 'collections') renderCollectionsView();
    else if (name === 'wishlist') renderWishlistView();
    else if (name === 'stats') renderStatsView();
  }

  /* ---------- 统计口径 ---------- */
  function computeStats() {
    const places = state.places;
    const now = Date.now();
    const dated = places.filter((p) => p.dateTs).sort((a, b) => b.dateTs - a.dateTs);
    // 未来日期属于"计划/愿望"，不该出现在"最近足迹"里
    const past = dated.filter((p) => p.dateTs <= now);
    const future = dated.filter((p) => p.dateTs > now);
    const undated = places.filter((p) => !p.dateTs);

    const byType = {};
    places.forEach((p) => { byType[p.type] = (byType[p.type] || 0) + 1; });

    const media = { image: 0, video: 0, text: 0, total: 0 };
    places.forEach((p) => {
      media.image += p.mediaCount.image;
      media.video += p.mediaCount.video;
      media.text += p.mediaCount.text;
      media.total += p.mediaCount.total;
    });

    const byYear = new Map();
    past.forEach((p) => {
      const y = p.year || 0;
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(p);
    });

    // trips 存在时用它作为「次旅行」口径（一次行程可覆盖多座城市）
    const tripsList = (state.trips || []).length ? state.trips : null;

    return {
      countries: state.countriesCount,
      cities: places.length,
      trips: tripsList ? tripsList.length : past.length,
      tripsList,
      media,
      byType,
      byYear,
      dated,
      past,
      future,
      undated,
      pct: state.countriesCount / Math.max(1, state.countryTotal) * 100,
    };
  }

  /* ---------- 首页「最近足迹」磁贴的填充（只服务 widget，别处不用） ----------
     按容器**实测高度**逐张试插、放不下就回退：
     2×1 只能容一行 4 张，旧实现固定塞 6 张会把第二行裁掉半截（溢出 148px）；
     620px 窄屏 .mediagrid 变 2 列，溢出更是到 800px 以上。这样任何尺寸/列数自洽。
     也刻意不再往磁贴里塞「添加新足迹」瓦片 —— 它会把第 5 张卡挤到第二行，
     而新增足迹的入口顶栏本来就有。 */
  function paintRecent(grid, mediaFilter = 'all') {
    if (!grid) return;
    grid.innerHTML = '';
    const stats = computeStats();

    const makers = [];
    if (mediaFilter === 'all') {
      stats.past.slice(0, 8).forEach((p) => makers.push(() => placeCard(p, { onOpen: onOpenDetail, badge: 'total' })));
    } else {
      const items = [];
      for (const p of stats.past) {
        for (const m of p.media) if (m.type === mediaFilter) items.push({ p, m });
      }
      items.slice(0, 8).forEach(({ p, m }) => makers.push(() => mediaCard(m, p, { onOpen: onOpenPhoto })));
      if (!items.length) {
        grid.innerHTML = emptyState(`还没有${MEDIA_LABELS[mediaFilter]}`, '打开地点详情，用「添加媒体」上传即可');
        return;
      }
    }

    const maxH = grid.clientHeight;
    let placed = 0;
    for (const make of makers) {
      const el = make();
      grid.append(el);
      if (maxH > 0 && grid.scrollHeight > maxH + 2) {
        el.remove();
        /* 一张都放不下（卡片被拉得很宽/容器特别矮）：宁可让卡体内部可滚动，
           也不要交出一整片空白 —— 空白的磁贴比滚动条更像出错。 */
        if (!placed) grid.append(make());
        break;
      }
      placed += 1;
    }
  }

  /* ---------- 旅途海报的素材池 ----------
     全部地点里的照片 + 视频（笔记没有画面，不进池）。
     ⚠️ 每条都要带上 place：点某一块要能直接开到那个地点。
     ⚠️ 视频优先用 poster 封面（有封面就完全不用加载视频文件），
        没有封面的才交给 js/poster.js 用 <video> 取首帧。
     ⚠️ 按地点配平 + 轮次交错（2026-10-29）：一趟旅行可能贡献 130 张，
        纯随机下去整面墙 8/10 块都是同一个地方（"主题重复"）。现在每个地点
        **均匀采样**最多 4 张，再按轮次交叉排出，邻块天然来自不同地点。 */
  const POSTER_PER_PLACE = 4;
  function posterSample(list, n) {
    if (list.length <= n) return list.slice();
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
    return out;
  }
  function posterPool() {
    const groups = [];
    (state?.places || []).forEach((p) => {
      const items = [];
      p.media.forEach((m) => {
        if (m.type !== 'image' && m.type !== 'video') return;
        items.push({
          kind: m.type,
          src: m.url,
          poster: m.type === 'video' ? (m.poster || '') : '',
          place: p,
          media: m,
          title: p.name,
          sub: p.date ? formatDateRange(p.date, p.endDate) : (p.countryZh || ''),
        });
      });
      if (items.length) groups.push(posterSample(items, POSTER_PER_PLACE));
    });
    const out = [];
    for (let round = 0; round < POSTER_PER_PLACE; round += 1) {
      groups.forEach((g) => { if (g[round]) out.push(g[round]); });
    }
    return out;
  }

  /* ---------- 愿望清单：注解存储 + 派生口径 ----------
     心愿是「想去的地点」的增强视图。为避免改动后端/数据结构，心愿专属字段
     （wish 显式标记 / priority 优先级 / note 备注 / target 目标季 / addedAt）存浏览器
     localStorage，按 place.id 索引，渲染时合并回地点对象。
     ⚠️ 派生口径保持向后兼容：未显式设置时，未来日期 + 未标注日期 + 类型为「目的地」
        仍算心愿；显式 wish=true/false 可覆盖（例如把一条「目的地」移出清单）。
     ⚠️ 存储已抽到共享模块 wishstore.js（ui.js / upload.js 共用），这里仅留别名与派生口径。 */
  const annOf = getAnn;   // 别名，沿用下方大量调用点

  /** 是否已加入心愿（合并显式标记与派生口径） */
  function isWished(p) {
    const w = annOf(p.id).wish;
    if (w === true) return true;
    if (w === false) return false;
    return !!(p.hasFutureDate || !p.dateTs || p.type === '目的地');
  }
  /** 心愿是否已"实现"（已落地为过去日期的足迹） */
  function wishDone(p) { return !!(p.dateTs && p.dateTs <= Date.now()); }
  /** 心愿统计：活跃数 / 已实现数 / 总数 / 完成百分比 */
  function wishStats(list) {
    const done = list.filter(wishDone).length;
    const total = list.length;
    return { done, total, active: total - done, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function wishlistPlaces() {
    const base = state.places.filter(isWished);
    const extra = getNewPlaces().filter(isWished);   // 用户新建的心愿地点
    const list = base.concat(extra);
    return list.sort((a, b) => {
      const da = wishDone(a) ? 1 : 0, db = wishDone(b) ? 1 : 0;
      if (da !== db) return da - db;                       // 已实现的沉底
      const pa = annOf(a.id).priority || 0, pb = annOf(b.id).priority || 0;
      if (pb !== pa) return pb - pa;                       // 优先级高在前
      const va = a.dateTs || Infinity, vb = b.dateTs || Infinity;
      if (va !== vb) return va - vb;                       // 再按日期升序
      return String(a.name).localeCompare(String(b.name), 'zh');
    });
  }

  /** 被「取消」的心愿（显式 wish:false），放进可回收站，误点星星也能找回。 */
  function canceledPlaces() {
    const np = getNewPlaces().filter((p) => annOf(p.id).wish === false);
    const sp = state.places.filter((p) => annOf(p.id).wish === false);
    return np.concat(sp);
  }

  function paintWishlist(stripEl, totalEl) {
    const wish = wishlistPlaces();
    (stripEl || (stripEl = document.createElement('div'))).innerHTML = '';
    wish.slice(0, 6).forEach((p) => stripEl.append(placeCard(p, { onOpen: onOpenDetail })));
    if (!wish.length) stripEl.innerHTML = emptyState('愿望清单是空的', '点顶部「愿望清单」里的「+ 添加心愿」，规划一个想去的地方');
    if (totalEl) totalEl.textContent = `(${wish.length})`;
  }

  function paintCollections(stripEl, totalEl) {
    const stats = computeStats();
    const mediaPool = [];
    for (const p of stats.past) for (const m of p.media) mediaPool.push({ p, m });
    (stripEl || (stripEl = document.createElement('div'))).innerHTML = '';
    mediaPool.slice(0, 6).forEach(({ p, m }) => stripEl.append(mediaCard(m, p, { onOpen: onOpenPhoto })));
    if (!mediaPool.length) stripEl.innerHTML = emptyState('暂无记录', '媒体资料会出现在这里');
    if (totalEl) totalEl.textContent = `(${stats.media.total})`;
  }

  /* ---------- 其它视图 ---------- */

  /** 类型标签 —— 颜色取**地图图例**那一档（types 表），两处必须同源，
   *  否则同一个「旅行」在图例里和在时间线上是两种颜色。 */
  function typeTag(place) {
    if (!place?.type) return '';
    return `<span class="tl__type" style="color:${state.colorOf(place)}">${escapeHtml(place.type)}</span>`;
  }

  /**
   * 时间线里一行的骨架：`类型圆点 | 日期 | 主标题(+可选折叠箭头) | 信息`。
   *
   * ⚠️ 整行为什么不再是一个 `<button>`：
   *   行程分组行要在标题后面放一枚"展开/收起"的箭头，而它必须是一个**真的 button**
   *   （要能 Tab 聚焦、要能带 aria-expanded）。按钮不能嵌套按钮 ——
   *   所以整行改成静态容器，另加一层**绝对定位的透明按钮**兜住"点哪都能打开"，
   *   箭头再用更高的 z-index 压在它上面。两个动作各是一个独立控件，
   *   Tab 顺序也自然：先「打开行程」，再「展开」。
   *   （`.tl__hit` 是空按钮，可见文本全在它下面，所以必须自己带 aria-label。）
   */
  function buildRow({ dotColor, date, title, desc, infoHTML, fold, label }) {
    const row = document.createElement('div');
    row.className = 'tl__row';

    const dot = document.createElement('span');
    dot.className = 'typeDot';
    dot.style.background = dotColor;

    const dateEl = document.createElement('span');
    dateEl.className = 'tl__date';
    dateEl.textContent = date;

    const main = document.createElement('span');
    main.className = 'tl__main';
    const nameEl = document.createElement('span');
    nameEl.className = 'tl__name';
    nameEl.textContent = title;
    main.append(nameEl);
    if (desc) {
      const d = document.createElement('span');
      d.className = 'tl__desc';
      d.textContent = desc;
      main.append(d);
    }

    const info = document.createElement('span');
    info.className = 'tl__info';
    info.innerHTML = infoHTML;

    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'tl__hit';
    hit.setAttribute('aria-label', label);

    /* 顺序 = 视觉顺序：箭头必须紧跟在标题后面（`.tl__info` 靠 margin-left:auto 靠右） */
    row.append(dot, dateEl, main);
    if (fold) row.append(fold);
    row.append(info, hit);
    return row;
  }

  /** 折叠箭头。aria-expanded 由 toggle 同步，CSS 读它决定朝向。 */
  function foldButton(tripName) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tl__fold';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', `展开「${tripName}」里的行程`);
    btn.innerHTML = '<svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-chevron"/></svg>';
    return btn;
  }

  /**
   * 时间线里的一行「地点」。
   * @param {object} place
   * @param {{sub?:boolean, groupName?:string}} [opts]
   *        sub=true 表示它嵌在行程分组内部（缩进一级）；
   *        groupName 是所在分组的行程名，用来判断"行程名要不要再写一遍"
   */
  function placeRow(place, { sub = false, groupName = '' } = {}) {
    const tripName = place.trip?.name || '';
    /* 主标题 = 「这次出行的名字」。
       顶层行用行程名：33 次行程里 30 次只覆盖 1 个地点，那一行的"地点名"
       本来就是行程名的另一种写法（用户 2026-10-05 要求换过来）。
       组内行仍用地点名 —— 分组头已经写着行程名了，再写一遍是纯重复。 */
    const title = sub ? place.name : (tripName || place.name);

    const parts = [];
    if (place.type) parts.push(typeTag(place));
    parts.push(escapeHtml(place.countryZh || '—'));
    if (title !== place.name) parts.push(escapeHtml(place.name));
    /* ⚠️ 组内行要写出"另一个行程名"：一个地点可以同时属于两次行程（实测「东京」在
       「东京中转」与「京都赏樱」里各出现一次），而分组用的是完整行程对象，
       于是「东京」会显示在「京都赏樱」分组里，它的另一个行程名没有任何别处会写出来。
       判据是**"是否与所在分组同名"**，不是"是否在分组内部" —— 后者会让这 1 次行程
       从整条时间线上静默消失。 */
    if (sub && tripName && tripName !== groupName) parts.push(escapeHtml(tripName));
    parts.push(`${place.mediaCount.total} 项资料`);

    const row = buildRow({
      dotColor: state.colorOf(place),
      date: place.date ? formatDateDot(place.date) : '—',
      title,
      desc: place.desc || '',
      infoHTML: parts.join(' · '),
      label: `打开「${title}」的多媒体资料`,
    });
    row.querySelector('.tl__hit').addEventListener('click', () => onSelectPlace?.(place, { openModal: true }));
    return row;
  }

  /**
   * 行程分组（**可折叠**）—— 只在行程覆盖 ≥2 个地点时出现。
   * 单地点行程退化成一整行普通足迹（33 次里 30 次是单地点，给它们也套一层
   * 会让整条时间线变成"一组套一行"的套娃）。
   *
   * 行内信息按用户要求**不写具体城市**，只写国家；跨国家的行程写所在大洲
   * （见 config.js 的 regionLabel）。
   * 点标题 → 打开媒体弹窗（弹窗上半部的小地图会"走一遍"这条路线，见 js/route.js）；
   * 点箭头 → 就地展开/收起组内的地点行。
   */
  function tripGroupRow(trip) {
    const places = [...trip.places].sort((a, b) => (a.dateTs || 0) - (b.dateTs || 0));
    const total = places.reduce((n, p) => n + p.mediaCount.total, 0);
    const parts = [];
    if (places[0]?.type) parts.push(typeTag(places[0]));
    const region = regionLabel(places);
    if (region) parts.push(escapeHtml(region));
    parts.push(`${total} 项资料`);

    const fold = foldButton(trip.name);
    const row = buildRow({
      dotColor: state.colorOf(places[0]),
      date: trip.date ? formatDateDot(trip.date) : '—',
      title: trip.name,
      desc: trip.desc || '',
      infoHTML: parts.join(' · '),
      fold,
      label: `打开「${trip.name}」的多媒体资料`,
    });
    row.querySelector('.tl__hit')
      .addEventListener('click', () => onOpenTrip?.(trip));

    /* 编辑入口不放在时间线（用户要求：列表保持干净，编辑只进详情弹窗后操作 ——
       行程详情弹窗头部的「编辑」已覆盖此需求，见 detail-modal.js 的 onEdit 接线）。 */

    /* 组内地点行。**升序**：与弹窗里"走一遍"的顺序一致（route.js 同样按 dateTs 排），
       两处不一致的话"列表第二行"和"动画第二站"就对不上。 */
    const sub = document.createElement('div');
    sub.className = 'tl__sub';
    places.forEach((p) => sub.append(placeRow(p, { sub: true, groupName: trip.name })));

    /* 展开状态要跨重渲染保留：renderFootprintsView() 会被 10 秒轮询整块重建，
       不留状态的话用户展开一次、10 秒后自己收起来（看着像"点了没用"）。 */
    const setOpen = (open) => {
      sub.hidden = !open;
      fold.setAttribute('aria-expanded', String(open));
      fold.setAttribute('aria-label', `${open ? '收起' : '展开'}「${trip.name}」里的行程`);
      if (open) expandedTrips.add(trip.id); else expandedTrips.delete(trip.id);
    };
    fold.addEventListener('click', () => setOpen(sub.hidden));
    setOpen(expandedTrips.has(trip.id));

    const box = document.createElement('div');
    box.className = 'tlgrp';
    box.append(row, sub);
    return box;
  }

  /**
   * 足迹 = 「年份 → 行程 → 地点」两级时间线。
   *
   * 每个年份下的条目有两类，混排后按时间**倒序**（最近的在最上面，与改造前的足迹视图一致）：
   *   · 行程分组（≥2 个地点）：一行"折叠头"（箭头默认收起），展开后列出组内各地点的行
   *   · 单独一行：单地点行程，以及不属于任何行程的到访
   *
   * ⚠️ 必须用 trips 里的**完整行程对象**分组，不能用 place.trip（那只是 {id,name} 的反向引用）。
   *    反向引用是"先到先得"的（data.js 的 normalizeTrips 里 `if (!p.trip)`），
   *    同一个地点出现在两次行程里时只认第一次；照它分组会让第二次行程少掉一个地点。
   *    实测数据里「东京」同时在「东京中转」与「京都赏樱」里，就是这种情况。
   * ⚠️ 行程整体归入 trip.year，**不按各地点自己的年份拆开** ——
   *    跨年行程（12 月出发、1 月返程）若被拆到两年，同一张分组卡会被撕成两半。
   * ⚠️ 未来日期的行程不进这条时间线（它们属于「愿望清单」）：只取 dateTs ≤ now 的。
   *    代价是未来行程里的地点也不会以"单独一行"出现（它们本来就在 future 里，见 computeStats）。
   */
  function renderFootprintsView() {
    const root = dom.viewFootprints;
    if (!state.places.length) { root.innerHTML = emptyState('还没有足迹', '先点上方「+ 新增」创建一条足迹'); return; }
    const stats = computeStats();
    const now = Date.now();

    const multis = (state.trips || [])
      .filter((t) => t.places.length > 1 && (!t.dateTs || t.dateTs <= now));
    const claimed = new Set();
    multis.forEach((t) => t.places.forEach((p) => claimed.add(p.id)));

    const buckets = new Map();
    const push = (y, item) => {
      if (!buckets.has(y)) buckets.set(y, []);
      buckets.get(y).push(item);
    };
    multis.forEach((t) => push(t.year || 0, { kind: 'trip', trip: t, ts: t.dateTs || 0 }));
    stats.past.forEach((p) => {
      if (claimed.has(p.id)) return;
      push(p.year || 0, { kind: 'place', place: p, ts: p.dateTs || 0 });
    });

    const wrap = document.createElement('div');
    wrap.className = 'tl';
    [...buckets.keys()].sort((a, b) => b - a).forEach((y) => {
      const items = buckets.get(y).sort((a, b) => b.ts - a.ts);
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="tl__year">${escapeHtml(y || '未标注日期')}</div>`;
      const list = document.createElement('div');
      list.className = 'tl__list';
      items.forEach((it) => list.append(
        it.kind === 'trip' ? tripGroupRow(it.trip) : placeRow(it.place),
      ));
      sec.append(list);
      wrap.append(sec);
    });

    root.innerHTML = '';
    root.append(wrap);
  }

  /**
   * 「我的记录」：按地点归类展示。
   * 每个地点一行：左侧是地点时间线节点（日期 + 名称 + 连接线），右侧是该地点的媒体网格。
   * 地点按日期从新到旧排序（无日期的沉底）；顶部筛选（全部/图片/视频/文字）仍生效。
   */
  function renderCollectionsView() {
    const root = dom.viewCollections;
    root.innerHTML = '';

    const groups = [...state.places]
      .map((p) => {
        let media = p.media || [];
        if (collMediaFilter !== 'all') media = media.filter((m) => m.type === collMediaFilter);
        return { place: p, media };
      })
      .filter((g) => g.media.length > 0)
      .sort((a, b) => {
        const ta = a.place.dateTs || (a.place.date ? Date.parse(a.place.date) || 0 : 0);
        const tb = b.place.dateTs || (b.place.date ? Date.parse(b.place.date) || 0 : 0);
        return tb - ta;
      });

    if (!groups.length) {
      root.innerHTML = emptyState('这个分类还没有内容', '打开地点详情，用「添加媒体」上传即可');
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'coll-byplace';

    groups.forEach((g) => {
      const section = document.createElement('section');
      section.className = 'coll-group';

      // 左：地点时间线节点
      const tl = document.createElement('div');
      tl.className = 'coll-timeline';
      const dateLabel = g.place.date ? formatDateDot(g.place.date) : '未标注日期';
      tl.innerHTML = `<span class="coll-dot"></span>`
        + `<span class="coll-date">${escapeHtml(dateLabel)}</span>`
        + `<span class="coll-place">${escapeHtml(g.place.name)}</span>`;

      // 右：该地点媒体网格
      const media = document.createElement('div');
      media.className = 'coll-media';
      const grid = document.createElement('div');
      grid.className = 'mediagrid';
      g.media.forEach((m) => grid.append(mediaCard(m, g.place, { onOpen: onOpenPhoto })));
      media.append(grid);

      section.append(tl, media);
      wrap.append(section);
    });

    root.append(wrap);
  }

  /* ---------- 愿望清单视图（重设计） ----------
     顶部进度环 + 筛选/排序工具栏 + 按国家分组的心愿列表 + 右侧栏
     「愿望地图」（按经纬度投影聚合，不用 MapLibre，避免动地图模块）+「年内计划」。
     心愿增删改只写浏览器 localStorage 注解，不碰后端与数据结构。 */
  let wlFilter = 'all';     // 'all' | 国家名 | '__undated'
  let wlSort = 'priority';  // priority | target | added | country
  const byWishId = (id) => state.places.find((p) => p.id === id) || getNewPlaces().find((p) => p.id === id);

  /* 封面：有真实图用图，否则按类型色给渐变占位（与 App 类型色同源） */
  const WL_COVER = {
    目的地: 'linear-gradient(135deg,#9b86b8,#7E6C9C)',
    旅行: 'linear-gradient(135deg,#E0A183,#C86E4A)',
    居住: 'linear-gradient(135deg,#AEC5D9,#4E7398)',
    __: 'linear-gradient(135deg,#9A9287,#6B655C)',
  };
  function wlCover(p) {
    if (p.cover) {
      return `<div class="wl-card__cover" style="background:#eee">
        <img src="${escapeHtml(p.cover)}" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"
             onerror="this.style.display='none'" />
        <span class="lbl">${escapeHtml(p.name)}</span></div>`;
    }
    return `<div class="wl-card__cover" style="background:${WL_COVER[p.type] || WL_COVER.__}">
      <div class="scene"></div><span class="lbl">${escapeHtml(p.name)}</span></div>`;
  }

  /* 心愿卡 */
  function wishCard(p) {
    const a = annOf(p.id);
    const done = wishDone(p);
    const canceled = a.wish === false;     // 显式「取消」：仅在「已取消」筛选里出现，可一键恢复
    const pri = a.priority || 0;
    const el = document.createElement('div');
    el.className = 'wl-card' + (done ? ' is-done' : '') + (canceled ? ' is-canceled' : '');
    el.dataset.id = p.id;
    const stars = [1, 2, 3].map((i) => `<span class="${i <= pri ? '' : 'off'}" data-pri="${i}">★</span>`).join('');
    const note = a.note ? `<div class="wl-note"><b>为什么想去：</b>${escapeHtml(a.note)}</div>` : '';
    const target = a.target
      ? `<span class="wl-tag">🎯 ${escapeHtml(a.target)}</span>`
      : (p.hasFutureDate ? `<span class="wl-tag">🗓 ${escapeHtml(formatDateDot(p.date))}</span>` : '<span class="wl-tag">🗓 未定</span>');
    el.innerHTML = `
      ${wlCover(p)}
      ${canceled
        ? `<div class="wl-card__acts">
             <button class="wl-card__act wl-card__restore" data-act="restore" type="button" title="恢复心愿" aria-label="恢复">↺ 恢复</button>
             <button class="wl-card__act wl-card__del" data-act="wishdel" type="button" title="删除心愿地点" aria-label="删除">🗑 删除</button>
           </div>`
        : `<div class="wl-card__star" data-act="wish" title="想去 / 取消">★</div>`}
      ${done ? '<div class="wl-card__done">✓ 已实现</div>' : ''}
      <div class="wl-card__meta">
        <p class="wl-card__name"><span class="wl-dot" style="background:${state.colorOf(p) || '#7E6C9C'}"></span>${escapeHtml(p.name)}</p>
        <p class="wl-card__sub">📍 ${escapeHtml(p.countryZh || p.type)}${done ? ' · 已旅行' : ''}</p>
        <div class="wl-stars" data-act="pri">${stars}</div>
        ${note}
        <div class="wl-tags">${canceled ? '<span class="wl-tag wl-tag--muted">↺ 已取消</span>' : ''}${target}</div>
        <button class="wl-card__edit" data-act="edit" type="button">✎ 编辑心愿</button>
      </div>
      <div class="wl-editor" data-role="editor" data-pri="${pri}">
        <div>
          <label>优先级</label>
          <div class="wl-editor__stars" data-role="estars">${[1, 2, 3].map((i) => `<span class="${i <= pri ? '' : 'off'}" data-epri="${i}">★</span>`).join('')}</div>
        </div>
        <div>
          <label>为什么想去 / 想做的事</label>
          <textarea data-role="enote" placeholder="写一句心愿，比如：想赶樱花季拍竹林">${escapeHtml(a.note || '')}</textarea>
        </div>
        <div>
          <label>目标时间（如 2026 春 / 未定）</label>
          <input type="text" data-role="etarget" value="${escapeHtml(a.target || '')}" placeholder="2026 春" />
        </div>
        <div class="wl-editor__acts">
          <button class="save" data-act="save" type="button">保存</button>
          <button class="ghost" data-act="cancel" type="button">取消</button>
          <button class="ghost danger" data-act="remove" type="button">移出清单</button>
        </div>
      </div>`;
    return el;
  }

  function sortWish(view, mode) {
    const arr = view.slice();
    const base = (a, b) => { const da = wishDone(a) ? 1 : 0, db = wishDone(b) ? 1 : 0; return da - db; };
    if (mode === 'priority') arr.sort((a, b) => base(a, b) || ((annOf(b.id).priority || 0) - (annOf(a.id).priority || 0)) || ((a.dateTs || Infinity) - (b.dateTs || Infinity)));
    else if (mode === 'target') arr.sort((a, b) => base(a, b) || ((a.dateTs || Infinity) - (b.dateTs || Infinity)) || String(a.name).localeCompare(String(b.name), 'zh'));
    else if (mode === 'added') arr.sort((a, b) => base(a, b) || ((annOf(b.id).addedAt || 0) - (annOf(a.id).addedAt || 0)));
    else if (mode === 'country') arr.sort((a, b) => base(a, b) || String(a.countryZh || '未定').localeCompare(String(b.countryZh || '未定'), 'zh') || String(a.name).localeCompare(String(b.name), 'zh'));
    return arr;
  }

  function buildWishGroups(view) {
    const frag = document.createElement('div');
    const groups = new Map();
    view.forEach((p) => {
      const k = p.countryZh || '未定目的地';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    });
    [...groups.entries()].forEach(([k, arr]) => {
      const g = document.createElement('div');
      g.className = 'wl-grp';
      const flag = k === '未定目的地' ? '🌍' : '🏳';
      g.innerHTML = `<div class="wl-grp__h"><span class="flag">${flag}</span><span class="name">${escapeHtml(k)}</span><span class="cnt">${arr.length} 项</span><span class="line"></span></div>`;
      const grid = document.createElement('div');
      grid.className = 'wl-grid';
      arr.forEach((p) => grid.append(wishCard(p)));
      g.append(grid);
      frag.append(g);
    });
    return frag;
  }

  /* 聚合地图：等距圆柱投影，按真实经纬度落点，按大洲配色（不依赖 MapLibre） */
  const CONTINENT = {
    中国: '亚洲', 日本: '亚洲', 韩国: '亚洲', 泰国: '亚洲', 新加坡: '亚洲', 马来西亚: '亚洲', 越南: '亚洲', 印尼: '亚洲', 印度: '亚洲', 土耳其: '亚洲',
    法国: '欧洲', 英国: '欧洲', 德国: '欧洲', 意大利: '欧洲', 西班牙: '欧洲', 葡萄牙: '欧洲', 荷兰: '欧洲', 瑞士: '欧洲', 瑞典: '欧洲', 挪威: '欧洲', 丹麦: '欧洲', 希腊: '欧洲', 奥地利: '欧洲', 比利时: '欧洲', 芬兰: '欧洲', 爱尔兰: '欧洲', 冰岛: '欧洲', 俄罗斯: '欧洲',
    美国: '美洲', 加拿大: '美洲', 巴西: '美洲', 墨西哥: '美洲', 阿根廷: '美洲',
    澳大利亚: '大洋洲', 新西兰: '大洋洲',
    埃及: '非洲', 南非: '非洲', 摩洛哥: '非洲', 肯尼亚: '非洲', 坦桑尼亚: '非洲',
  };
  const REGION_COLOR = { 亚洲: '#E0A183', 欧洲: '#AEC5D9', 美洲: '#93A7BC', 大洋洲: '#E3C98F', 非洲: '#B9C6A6', 其他: '#D9AFA4' };
  const continentOf = (c) => (c && CONTINENT[c]) || '其他';
  function buildWishMap(all) {
    const box = document.createElement('div');
    box.className = 'wl-minimap';
    for (let i = 1; i < 6; i++) { const v = (i * 100) / 6; const gl = document.createElement('div'); gl.className = 'grid-line'; gl.style.left = v + '%'; gl.style.top = '0'; gl.style.width = '1px'; gl.style.height = '100%'; box.append(gl); }
    for (let i = 1; i < 4; i++) { const v = (i * 100) / 4; const gl = document.createElement('div'); gl.className = 'grid-line'; gl.style.top = v + '%'; gl.style.left = '0'; gl.style.height = '1px'; gl.style.width = '100%'; box.append(gl); }
    const counts = {};
    all.forEach((p) => {
      if (!Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return;
      const x = ((p.lng + 180) / 360) * 100;
      const y = ((90 - Math.max(-56, Math.min(78, p.lat))) / 180) * 100;
      const reg = continentOf(p.countryZh);
      counts[reg] = (counts[reg] || 0) + 1;
      const d = document.createElement('div');
      d.className = 'dot'; d.style.left = x + '%'; d.style.top = y + '%'; d.style.background = REGION_COLOR[reg];
      d.title = `${p.name}（${reg}）`;
      box.append(d);
    });
    const noCoord = all.filter((p) => !Number.isFinite(p.lng) || !Number.isFinite(p.lat)).length;
    const legend = document.createElement('div');
    legend.className = 'wl-minimap__legend';
    const legendItems = Object.entries(counts).map(([r, n]) => `<span><i style="background:${REGION_COLOR[r]}"></i>${r} ${n}</span>`);
    if (noCoord) legendItems.push(`<span class="wl-minimap__legend-warn"><i></i>未定位 ${noCoord}</span>`);
    legend.innerHTML = legendItems.join('');
    box.append(legend);
    return box;
  }

  function buildSoonList(all) {
    const wrap = document.createElement('div');
    wrap.className = 'wl-soon';
    const items = all.filter((p) => { const a = annOf(p.id); return (a.target && a.target !== '未定') || p.hasFutureDate; })
      .sort((a, b) => (a.dateTs || Infinity) - (b.dateTs || Infinity));
    if (!items.length) { wrap.innerHTML = '<div class="wl-soon__empty">还没有设定目标时间的心愿</div>'; return wrap; }
    items.slice(0, 8).forEach((p) => {
      const a = annOf(p.id);
      const when = (a.target && a.target !== '未定') ? a.target : (p.date ? formatDateDot(p.date) : '未定');
      const it = document.createElement('div');
      it.className = 'wl-soon__item';
      it.innerHTML = `<span class="wl-soon__dot" style="background:${state.colorOf(p)}"></span><span class="wl-soon__name">${escapeHtml(p.name)}</span><span class="wl-soon__when">${escapeHtml(when)}</span>`;
      wrap.append(it);
    });
    return wrap;
  }

  /* ---------------- 国家 / 地区自动补全（带中心点经纬度） ----------------
     复用「记录新足迹」城市补全的同套思路：离线库优先 + Nominatim 在线兜底，
     输入即弹匹配项（含中心点经纬度），选中把经纬度写进心愿，使其能在愿望地图落点。 */
  let countryAC = null;          // 国家补全下拉（挂到 ncountry 父节点）
  let wishCountryGeo = null;     // 选中的国家中心点 { lng, lat, cc }
  let wishCityGeo = null;        // 选中的城市精确坐标 { lng, lat, cc }（优先级高于国家中心点）
  /* 当前激活的「心愿表单」容器：默认回退到愿望清单视图里的添加面板；
     打开「编辑心愿地点」弹窗时临时切到弹窗表单，使国家/城市补全与坐标写入落到正确输入框。 */
  let wishFormRoot = null;
  const wf = (sel) => (wishFormRoot || dom.viewWishlist).querySelector(sel);
  function wishDebounce(fn, ms) {
    let t = 0;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
  function ensureCountryAC() {
    const input = wf('[data-role="ncountry"]');
    if (!input) return null;
    if (countryAC && countryAC.isConnected) return countryAC;
    countryAC = document.createElement('div');
    countryAC.className = 'tm-city-ac';          // 复用记录新足迹城市补全的下拉样式
    countryAC.hidden = true;
    const parent = input.parentElement;
    if (parent) { parent.style.position = 'relative'; parent.appendChild(countryAC); }
    return countryAC;
  }
  function localCountryMatches(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return COUNTRY_CENTROIDS
      .filter((c) => c.name.toLowerCase().includes(s) || (c.en || '').toLowerCase().includes(s) || (c.cc || '').toLowerCase() === s)
      .slice(0, 8);
  }
  async function onlineCountryMatches(q) {
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6'
        + '&accept-language=zh-CN&featuretype=country&q=' + encodeURIComponent(q);
      const ctrl = ('AbortController' in window) ? new AbortController() : null;
      const r = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
      if (!r.ok) return [];
      const arr = await r.json();
      return (arr || []).map((it) => ({
        name: (it.address && it.address.country) || it.name || (it.display_name || '').split(',')[0] || '',
        cc: ((it.address && it.address.country_code) || '').toUpperCase(),
        lat: parseFloat(it.lat),
        lng: parseFloat(it.lon),
      })).filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lng));
    } catch (_) { return []; }
  }
  function renderCountryAC(items) {
    const box = ensureCountryAC();
    if (!box) return;
    box.innerHTML = '';
    if (!items.length) { box.hidden = true; return; }
    items.forEach((c) => {
      const li = document.createElement('button');
      li.type = 'button';
      li.className = 'tm-city-ac__item';
      const sub = [c.cc].filter(Boolean).join(' · ');
      li.innerHTML = `<span class="tm-city-ac__name">${escapeHtml(c.name)}</span>`
        + (sub ? `<span class="tm-city-ac__sub">${escapeHtml(sub)}</span>` : '')
        + `<span class="tm-city-ac__coord">${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}</span>`;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pickCountry(c); });
      box.append(li);
    });
    box.hidden = false;
  }
  function pickCountry(c) {
    const input = wf('[data-role="ncountry"]');
    if (input) input.value = c.name;
    wishCountryGeo = { lng: c.lng, lat: c.lat, cc: c.cc || null };
    if (countryAC) countryAC.hidden = true;
    toast(`已填入「${c.name}」中心点坐标`, 1800);
  }
  function hideCountryAC() { if (countryAC) countryAC.hidden = true; }
  const onCountryInput = wishDebounce(() => {
    const input = wf('[data-role="ncountry"]');
    const q = (input?.value || '').trim();
    wishCountryGeo = null;                     // 用户改了输入，之前选中的国家坐标作废
    if (!q) { hideCountryAC(); return; }
    const base = localCountryMatches(q);
    renderCountryAC(base);
    if (base.length < 4) {
      onlineCountryMatches(q)
        .then((online) => {
          if ((wf('[data-role="ncountry"]')?.value || '').trim() !== q) return;
          const seen = new Set(base.map((i) => i.name + '|' + i.lat.toFixed(2) + '|' + i.lng.toFixed(2)));
          const merged = base.slice();
          for (const o of online) {
            const k = o.name + '|' + o.lat.toFixed(2) + '|' + o.lng.toFixed(2);
            if (!seen.has(k)) { merged.push(o); seen.add(k); }
          }
          renderCountryAC(merged.slice(0, 8));
        })
        .catch(() => {});
    }
  }, 320);

  /* ---------------- 城市自动补全（精确到城市经纬度） ---------------- */
  /* 复用「记录新足迹」城市补全思路：离线 CITIES 优先 + Nominatim 在线兜底。
     用户想精确到城市时填「城市」字段，选中写入 wishCityGeo，优先级高于国家中心点。 */
  let cityAC = null;             // 城市补全下拉（挂到 ncity 父节点）
  function ensureCityAC() {
    const input = wf('[data-role="ncity"]');
    if (!input) return null;
    if (cityAC && cityAC.isConnected) return cityAC;
    cityAC = document.createElement('div');
    cityAC.className = 'tm-city-ac';          // 复用城市补全下拉样式
    cityAC.hidden = true;
    const parent = input.parentElement;
    if (parent) { parent.style.position = 'relative'; parent.appendChild(cityAC); }
    return cityAC;
  }
  function localCityMatches(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return CITIES
      .filter((c) => c.name.toLowerCase().includes(s) || (c.country || '').toLowerCase().includes(s))
      .slice(0, 8);
  }
  async function onlineCityMatches(q) {
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5'
        + '&accept-language=zh-CN&q=' + encodeURIComponent(q);
      const ctrl = ('AbortController' in window) ? new AbortController() : null;
      const r = await fetch(url, { signal: ctrl ? ctrl.signal : undefined });
      if (!r.ok) return [];
      const arr = await r.json();
      return (arr || []).map((it) => ({
        name: it.name || (it.display_name || '').split(',')[0] || '',
        country: (it.address && it.address.country) || '',
        cc: ((it.address && it.address.country_code) || '').toUpperCase(),
        lat: parseFloat(it.lat),
        lng: parseFloat(it.lon),
      })).filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lng));
    } catch (_) { return []; }
  }
  function renderCityAC(items) {
    const box = ensureCityAC();
    if (!box) return;
    box.innerHTML = '';
    if (!items.length) { box.hidden = true; return; }
    items.forEach((c) => {
      const li = document.createElement('button');
      li.type = 'button';
      li.className = 'tm-city-ac__item';
      const sub = [c.country, c.cc].filter(Boolean).join(' · ');
      li.innerHTML = `<span class="tm-city-ac__name">${escapeHtml(c.name)}</span>`
        + (sub ? `<span class="tm-city-ac__sub">${escapeHtml(sub)}</span>` : '')
        + `<span class="tm-city-ac__coord">${c.lat.toFixed(2)}, ${c.lng.toFixed(2)}</span>`;
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pickCity(c); });
      box.append(li);
    });
    box.hidden = false;
  }
  function pickCity(c) {
    const input = wf('[data-role="ncity"]');
    if (input) input.value = c.name;
    // 城市更精确：直接覆盖国家中心点；若国家字段为空，用城市的国名顺手补全
    wishCityGeo = { lng: c.lng, lat: c.lat, cc: c.cc || null };
    const countryInput = wf('[data-role="ncountry"]');
    if (countryInput && !countryInput.value.trim() && c.country) countryInput.value = c.country;
    if (cityAC) cityAC.hidden = true;
    toast(`已填入「${c.name}」坐标`, 1800);
  }
  function hideCityAC() { if (cityAC) cityAC.hidden = true; }
  const onCityInput = wishDebounce(() => {
    const input = wf('[data-role="ncity"]');
    const q = (input?.value || '').trim();
    wishCityGeo = null;                        // 用户改了输入，之前选中的城市坐标作废
    if (!q) { hideCityAC(); return; }
    const base = localCityMatches(q);
    renderCityAC(base);
    if (base.length < 4) {
      onlineCityMatches(q)
        .then((online) => {
          if ((wf('[data-role="ncity"]')?.value || '').trim() !== q) return;
          const seen = new Set(base.map((i) => i.name + '|' + i.lat.toFixed(2) + '|' + i.lng.toFixed(2)));
          const merged = base.slice();
          for (const o of online) {
            const k = o.name + '|' + o.lat.toFixed(2) + '|' + o.lng.toFixed(2);
            if (!seen.has(k)) { merged.push(o); seen.add(k); }
          }
          renderCityAC(merged.slice(0, 8));
        })
        .catch(() => {});
    }
  }, 320);

  function buildAddPanel() {
    wishCountryGeo = null; wishCityGeo = null; // 面板重建，清空上次选中的坐标
    const panel = document.createElement('div');
    panel.className = 'wl-add'; panel.dataset.role = 'addpanel';
    panel.innerHTML = `
      <div class="wl-add__h"><h3>添加心愿</h3><button class="x" data-act="addclose" type="button" aria-label="关闭">×</button></div>
      <div class="wl-add__tabs">
        <button class="wl-add__tab is-on" data-act="addtab" data-tab="new" type="button">新建心愿地点</button>
        <button class="wl-add__tab" data-act="addtab" data-tab="existing" type="button">从已有地点</button>
      </div>
      <div class="wl-add__new" data-role="addnew">
        <label>名称 *</label>
        <input type="text" data-role="nname" placeholder="例如：冰岛环岛" />
        <div class="wl-add__row">
          <label>国家 / 地区</label>
          <input type="text" data-role="ncountry" placeholder="例如：冰岛" />
        </div>
        <div class="wl-add__row">
          <label>城市（精确到城市经纬度，可选）</label>
          <input type="text" data-role="ncity" placeholder="例如：雷克雅未克" />
        </div>
        <label>优先级</label>
        <div class="wl-editor__stars" data-role="cstars" data-pri="0"><span class="off" data-cpri="1">★</span><span class="off" data-cpri="2">★</span><span class="off" data-cpri="3">★</span></div>
        <label>为什么想去 / 想做的事</label>
        <textarea data-role="nnote" placeholder="写一句心愿，比如：想赶樱花季拍竹林"></textarea>
        <label>目标时间（如 2026 春 / 未定）</label>
        <input type="text" data-role="ntarget" placeholder="2026 春" />
        <button class="wl-add__create" data-act="createwish" type="button">创建心愿</button>
        <div class="wl-add__err" data-role="nerr"></div>
      </div>
      <div class="wl-add__existing" data-role="addexisting" hidden>
        <input type="search" data-role="addsearch" placeholder="搜索地点名称…" />
        <div class="wl-add__list" data-role="addlist"></div>
      </div>`;
    return panel;
  }

  /* ---------------- 编辑心愿地点弹窗（替代 travel/residence 弹窗） ----------------
     未定位 / 已定位的心愿地点都走这个专属弹窗：可改名称、国家（带中心点经纬度）、城市、
     优先级、备注、目标时间，并能据此把"未定位"心愿补上坐标。复用上面国家/城市补全的
     wf() 作用域，所以打开弹窗时把 wishFormRoot 指向弹窗表单即可。 */
  function setVal(m, role, v) { const el = m.querySelector(`[data-role="${role}"]`); if (el) el.value = (v == null ? '' : v); }

  function getWishEditModal() {
    let m = document.getElementById('tm-wish-edit');
    if (m) return m;
    m = document.createElement('div');
    m.className = 'modal-edit wl-edit'; m.id = 'tm-wish-edit'; m.hidden = true;
    m.innerHTML = `
      <div class="modal-edit__mask" data-close="1"></div>
      <div class="modal-edit__panel" role="dialog" aria-modal="true" aria-label="编辑心愿地点">
        <header class="modal-edit__head">
          <h3 id="tm-wish-edit-title">编辑心愿地点</h3>
          <button class="modal-edit__close" data-close="1" type="button" aria-label="关闭">×</button>
        </header>
        <form class="modal-edit__body" data-role="wishform">
          <label>名称 *</label>
          <input type="text" data-role="nname" placeholder="例如：冰岛环岛" />
          <div class="wl-add__row">
            <label>国家 / 地区</label>
            <input type="text" data-role="ncountry" placeholder="例如：冰岛" />
          </div>
          <div class="wl-add__row">
            <label>城市（精确到城市经纬度，可选）</label>
            <input type="text" data-role="ncity" placeholder="例如：雷克雅未克" />
          </div>
          <label>优先级</label>
          <div class="wl-editor__stars" data-role="cstars" data-pri="0"><span class="off" data-cpri="1">★</span><span class="off" data-cpri="2">★</span><span class="off" data-cpri="3">★</span></div>
          <label>为什么想去 / 想做的事</label>
          <textarea data-role="nnote" placeholder="写一句心愿，比如：想赶樱花季拍竹林"></textarea>
          <label>目标时间（如 2026 春 / 未定）</label>
          <input type="text" data-role="ntarget" placeholder="2026 春" />
          <div class="wl-add__err" data-role="nerr"></div>
        </form>
        <div class="modal-edit__foot">
          <button class="ghost" data-act="wishcancel" type="button">取消</button>
          <button class="save" data-act="wishsave" type="button">保存</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    // 关闭：点遮罩 / 关闭键
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-close="1"]')) { closeWishEdit(); return; }
      const csta = e.target.closest('[data-cpri]');
      if (csta) {                                  // 优先级星标
        const box = e.target.closest('[data-role="cstars"]');
        const v = +csta.dataset.cpri;
        box.querySelectorAll('[data-cpri]').forEach((s) => s.classList.toggle('off', +s.dataset.cpri > v));
        box.dataset.pri = String(v);
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'wishsave') saveWishEdit();
      else if (act === 'wishcancel') closeWishEdit();
    });
    // 输入：国家 / 城市补全（wf 已指向弹窗表单）
    m.addEventListener('input', (e) => {
      if (e.target.matches('[data-role="ncountry"]')) onCountryInput();
      else if (e.target.matches('[data-role="ncity"]')) onCityInput();
    });
    return m;
  }

  function openWishEdit(place) {
    if (!place) return;
    const a = annOf(place.id);
    const m = getWishEditModal();
    const body = m.querySelector('[data-role="wishform"]');
    wishFormRoot = body;                            // 让 wf() 指向弹窗表单
    setVal(m, 'nname', place.name);
    setVal(m, 'ncountry', place.countryZh || place.country || '');
    setVal(m, 'ncity', place.city || '');
    setVal(m, 'nnote', a.note || '');
    setVal(m, 'ntarget', a.target || '');
    const stars = body.querySelector('[data-role="cstars"]');
    const pri = place.priority || a.priority || 0;
    stars.dataset.pri = String(pri);
    stars.querySelectorAll('[data-cpri]').forEach((s) => s.classList.toggle('off', +s.dataset.cpri > pri));
    // 已有坐标则预填国家中心点（保存时若不改国家即原样保留；城市字段另算更高优先级）
    wishCountryGeo = (Number.isFinite(place.lng) && Number.isFinite(place.lat))
      ? { lng: place.lng, lat: place.lat, cc: place.countryCode || place.cc || null }
      : null;
    wishCityGeo = null;
    m.dataset.id = place.id;
    m.hidden = false;
    body.querySelector('[data-role="nname"]')?.focus();
  }

  function closeWishEdit() {
    const m = document.getElementById('tm-wish-edit');
    if (m) {
      m.hidden = true;
      m.removeAttribute('data-id');
      const err = m.querySelector('[data-role="nerr"]'); if (err) err.textContent = '';
    }
    wishFormRoot = null;
    wishCountryGeo = null; wishCityGeo = null;
  }

  function saveWishEdit() {
    const m = document.getElementById('tm-wish-edit');
    const id = m?.dataset.id; if (!id) return;
    const body = m.querySelector('[data-role="wishform"]');
    const name = body.querySelector('[data-role="nname"]').value.trim();
    const err = body.querySelector('[data-role="nerr"]');
    if (!name) { if (err) err.textContent = '请填写名称'; return; }
    const country = body.querySelector('[data-role="ncountry"]').value.trim();
    const pri = +(body.querySelector('[data-role="cstars"]').dataset.pri || 0);
    const note = body.querySelector('[data-role="nnote"]').value.trim();
    const target = body.querySelector('[data-role="ntarget"]').value.trim();
    const geo = wishCityGeo || wishCountryGeo;       // 城市精确坐标优先
    updateWishPlace(id, {
      name, country, priority: pri, note, target,
      lng: geo?.lng ?? null, lat: geo?.lat ?? null,
    });
    closeWishEdit();
    renderWishlistView();
    toast('已保存', 1500);
  }

  function fillAddList(q = '') {
    const panel = dom.viewWishlist.querySelector('[data-role="addpanel"]');
    if (!panel) return;
    const list = panel.querySelector('[data-role="addlist"]');
    const ql = q.trim().toLowerCase();
    const cand = state.places.filter((p) => !isWished(p) && (!ql || (p.name || '').toLowerCase().includes(ql) || (p.countryZh || '').toLowerCase().includes(ql)));
    if (!cand.length) { list.innerHTML = '<div class="wl-add__empty">没有可添加的地点</div>'; return; }
    list.innerHTML = '';
    cand.slice(0, 60).forEach((p) => {
      const it = document.createElement('div');
      it.className = 'wl-add__item'; it.dataset.act = 'addpick'; it.dataset.id = p.id;
      it.innerHTML = `<span class="wl-soon__dot" style="background:${state.colorOf(p)}"></span><span class="nm">${escapeHtml(p.name)}</span><span class="sub">${escapeHtml(p.countryZh || p.type)}</span>`;
      list.append(it);
    });
  }

  function buildWishAside(all) {
    const aside = document.createElement('div');
    aside.className = 'wl-aside';
    const mapCard = document.createElement('div');
    mapCard.className = 'wl-aside__card';
    mapCard.innerHTML = '<h3>愿望地图</h3><p class="ah-sub">心愿按地区聚合，一眼看清集中在哪</p>';
    mapCard.append(buildWishMap(all));
    aside.append(mapCard);
    const soonCard = document.createElement('div');
    soonCard.className = 'wl-aside__card';
    soonCard.innerHTML = '<h3>年内计划</h3><p class="ah-sub">带目标时间的心愿</p>';
    soonCard.append(buildSoonList(all));
    aside.append(soonCard);
    return aside;
  }

  function onWishClick(e) {
    const esta = e.target.closest('[data-epri]');
    if (esta) {
      const ed = e.target.closest('.wl-editor'); const v = +esta.dataset.epri;
      ed.querySelectorAll('[data-epri]').forEach((s) => s.classList.toggle('off', +s.dataset.epri > v));
      ed.dataset.pri = String(v);
      return;
    }
    const csta = e.target.closest('[data-cpri]');
    if (csta) {
      const box = e.target.closest('[data-role="cstars"]'); const v = +csta.dataset.cpri;
      box.querySelectorAll('[data-cpri]').forEach((s) => s.classList.toggle('off', +s.dataset.cpri > v));
      box.dataset.pri = String(v);
      return;
    }
    const t = e.target.closest('[data-act]');
    if (!t) {
      const card = e.target.closest('.wl-card');
      if (card && !e.target.closest('.wl-editor')) { const p = byWishId(card.dataset.id); if (p) onOpenDetail?.(p); }
      return;
    }
    const act = t.dataset.act;
    const card = t.closest('.wl-card');
    if (act === 'wish') {
      const p = byWishId(card.dataset.id); if (!p) return;
      const now = isWished(p);
      setAnn(p.id, { wish: !now, addedAt: !now ? Date.now() : undefined });
      renderWishlistView();
      // 取消不再"凭空消失"：明确告知去了哪里，并给出找回入口
      toast(now ? '已移入「↺ 已取消」，可在清单顶部找回' : '已加回愿望清单', 2200);
    } else if (act === 'restore') {
      const p = byWishId(card.dataset.id); if (!p) return;
      setAnn(p.id, { wish: true, addedAt: Date.now() });
      toast('已加回愿望清单', 1600);
      renderWishlistView();
    } else if (act === 'wishdel') {
      if (confirm('确定删除该心愿地点吗？此操作不可恢复。')) {
        const p = byWishId(card.dataset.id);
        if (p && p.isWishNew) deleteWishPlace(card.dataset.id);   // 自建心愿地点：整体删除
        else setAnn(card.dataset.id, { wish: undefined });         // 真实足迹：仅退出「已取消」回收站，不删足迹
        toast('已删除', 1500);
        renderWishlistView();
      }
    } else if (act === 'clearcanceled') {
      if (confirm('确定清除所有已取消的心愿地点吗？此操作不可恢复。')) {
        canceledPlaces().forEach((p) => {
          if (p.isWishNew) deleteWishPlace(p.id);                 // 自建心愿地点：整体删除
          else setAnn(p.id, { wish: undefined });                 // 真实足迹：仅退出回收站
        });
        toast('已清除', 1500);
        renderWishlistView();
      }
    } else if (act === 'edit') {
      card.classList.toggle('is-editing');
    } else if (act === 'cancel') {
      renderWishlistView();
    } else if (act === 'remove') {
      setAnn(card.dataset.id, { wish: false });
      renderWishlistView();
    } else if (act === 'save') {
      const id = card.dataset.id;
      const ed = card.querySelector('.wl-editor');
      const pri = +(ed.dataset.pri || annOf(id).priority || 0);
      const note = ed.querySelector('[data-role="enote"]').value.trim();
      const target = ed.querySelector('[data-role="etarget"]').value.trim();
      setAnn(id, { priority: pri, note, target, wish: true });
      renderWishlistView();
    } else if (act === 'pri') {
      setAnn(card.dataset.id, { priority: +t.dataset.pri });
      renderWishlistView();
    } else if (act === 'filter') {
      wlFilter = t.dataset.val; renderWishlistView();
    } else if (act === 'addopen') {
      const ap = dom.viewWishlist.querySelector('[data-role="addpanel"]');
      if (ap) {
        ap.classList.add('is-open');
        const newTab = ap.querySelector('[data-act="addtab"][data-tab="new"]');
        if (newTab) newTab.click();                       // 回到「新建」页并同步显隐
        ap.querySelector('[data-role="nname"]').focus();
      }
    } else if (act === 'addclose') {
      t.closest('.wl-add').classList.remove('is-open');
    } else if (act === 'addtab') {
      const ap = t.closest('.wl-add');
      const newOn = t.dataset.tab === 'new';
      ap.querySelectorAll('.wl-add__tab').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === t.dataset.tab));
      ap.querySelector('[data-role="addnew"]').hidden = !newOn;
      ap.querySelector('[data-role="addexisting"]').hidden = newOn;
      if (!newOn) fillAddList();
    } else if (act === 'createwish') {
      const ap = t.closest('.wl-add');
      const name = ap.querySelector('[data-role="nname"]').value.trim();
      const err = ap.querySelector('[data-role="nerr"]');
      if (!name) { err.textContent = '请填写名称'; return; }
      const country = ap.querySelector('[data-role="ncountry"]').value.trim();
      const pri = +(ap.querySelector('[data-role="cstars"]').dataset.pri || 0);
      const note = ap.querySelector('[data-role="nnote"]').value.trim();
      const target = ap.querySelector('[data-role="ntarget"]').value.trim();
      const geo = wishCityGeo || wishCountryGeo;   // 城市精确坐标优先，否则用国家中心点
      addWishPlace({ name, country, priority: pri, note, target, lng: geo?.lng ?? null, lat: geo?.lat ?? null });
      renderWishlistView();
    } else if (act === 'addpick') {
      setAnn(t.dataset.id, { wish: true, addedAt: Date.now() });
      renderWishlistView();
    }
  }

  let wlBound = false;
  function bindWishEvents() {
    if (wlBound) return; wlBound = true;
    dom.viewWishlist.addEventListener('click', onWishClick);
    dom.viewWishlist.addEventListener('input', (e) => {
      if (e.target.matches('[data-role="addsearch"]')) fillAddList(e.target.value);
      else if (e.target.matches('[data-role="ncountry"]')) onCountryInput();
      else if (e.target.matches('[data-role="ncity"]')) onCityInput();
    });
    dom.viewWishlist.addEventListener('focusin', (e) => {
      if (e.target.matches('[data-role="ncountry"]')) onCountryInput();
      else if (e.target.matches('[data-role="ncity"]')) onCityInput();
    });
    dom.viewWishlist.addEventListener('focusout', (e) => {
      if (e.target.matches('[data-role="ncountry"]')) setTimeout(hideCountryAC, 150);
      else if (e.target.matches('[data-role="ncity"]')) setTimeout(hideCityAC, 150);
    });
    dom.viewWishlist.addEventListener('change', (e) => { if (e.target.matches('[data-act="sort"]')) { wlSort = e.target.value; renderWishlistView(); } });
  }

  function renderWishlistView() {
    bindWishEvents();
    initWishes();   // 幂等：首拉服务端（或迁移本机数据），之后为 no-op
    const root = dom.viewWishlist;
    const all = wishlistPlaces();
    root.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'wl';

    const stats = wishStats(all);
    const head = document.createElement('div');
    head.className = 'wl__head';
    head.innerHTML = `
      <div class="wl__title">
        <h2>我的愿望清单</h2>
        <p>把想去的地方管理起来 —— 备注、优先级、进度、地图聚合一次到位。</p>
      </div>
      <div class="wl-progress">
        <div class="wl-ring" style="--p:${stats.pct}"><b>${stats.pct}%</b></div>
        <div class="wl-progress__txt">
          已实现 <span class="big">${stats.done}</span> / ${stats.total} 项<br>
          还差 <b>${stats.active}</b> 个心愿待出发
        </div>
      </div>`;
    wrap.append(head);

    const countries = [...new Set(all.map((p) => p.countryZh || '未定目的地').filter(Boolean))];
    const noCoordCount = all.filter((p) => !Number.isFinite(p.lng) || !Number.isFinite(p.lat)).length;
    const canceledCount = canceledPlaces().length;
    const toolbar = document.createElement('div');
    toolbar.className = 'wl-toolbar';
    const chips = ['全部', ...countries].map((c) => {
      const val = c === '全部' ? 'all' : (c === '未定目的地' ? '__undated' : c);
      const on = wlFilter === val ? ' is-on' : '';
      const label = c === '未定目的地' ? '🌍 未定目的地' : (c === '全部' ? '全部' : c);
      return `<span class="wl-chip${on}" data-act="filter" data-val="${escapeHtml(val)}">${label}</span>`;
    }).join('');
    // 「📍 未定位 N」：筛出没有经纬度的心愿（新建时没选国家/城市）。仅在有未定位心愿时出现。
    const noCoordChip = noCoordCount
      ? `<span class="wl-chip wl-chip--warn${wlFilter === '__nocoord' ? ' is-on' : ''}" data-act="filter" data-val="__nocoord">📍 未定位 ${noCoordCount}</span>`
      : '';
    const canceledChip = canceledCount
      ? `<span class="wl-chip wl-chip--muted${wlFilter === '__canceled' ? ' is-on' : ''}" data-act="filter" data-val="__canceled">↺ 已取消 ${canceledCount}</span>`
      : '';
    toolbar.innerHTML = `
      <div class="wl-chips">${chips}${noCoordChip}${canceledChip}</div>
      ${wlFilter === '__canceled' ? `<button class="wl-clear-canceled" data-act="clearcanceled" type="button">🗑 一键清除（${canceledCount}）</button>` : ''}
      <div class="spacer"></div>
      <button class="wl-add-btn" data-act="addopen" type="button">＋ 添加心愿</button>
      <select class="wl-sort" data-act="sort" title="排序">
        <option value="priority"${wlSort === 'priority' ? ' selected' : ''}>排序：优先级</option>
        <option value="target"${wlSort === 'target' ? ' selected' : ''}>排序：目标日期</option>
        <option value="added"${wlSort === 'added' ? ' selected' : ''}>排序：添加时间</option>
        <option value="country"${wlSort === 'country' ? ' selected' : ''}>排序：国家</option>
      </select>`;
    wrap.append(toolbar);
    wrap.append(buildAddPanel());

    let view = all;
    if (wlFilter === '__undated') view = view.filter((p) => !p.countryZh);
    else if (wlFilter === '__nocoord') view = view.filter((p) => !Number.isFinite(p.lng) || !Number.isFinite(p.lat));
    else if (wlFilter === '__canceled') view = canceledPlaces();
    else if (wlFilter !== 'all') view = view.filter((p) => (p.countryZh || '未定目的地') === wlFilter);
    view = sortWish(view, wlSort);

    const cols = document.createElement('div');
    cols.className = 'wl-cols';
    if (view.length) {
      cols.append(buildWishGroups(view));
    } else {
      const empty = document.createElement('div');
      empty.innerHTML = (wlFilter === '__canceled')
        ? emptyState('没有已取消的心愿', '你已处理完所有取消的心愿')
        : emptyState('这里还没有心愿', '点上方「＋ 添加心愿」，把想去的地方加进来');
      cols.append(empty);
    }
    cols.append(buildWishAside(all));
    wrap.append(cols);

    const foot = document.createElement('div');
    foot.className = 'wl-foot';
    foot.textContent = '心愿数据已同步保存到服务器（与你的足迹一起备份）；本机浏览器另存一份离线副本，断网时也能看。';
    wrap.append(foot);

    root.append(wrap);
  }

  /**
   * 统计视图 —— 实体在 js/stats.js。
   * 这里只负责把 ui.js 内部的东西（state / computeStats / 选点跳转 / 图钉字形）注入进去，
   * 保持 stats.js 不反向依赖 ui.js（否则会形成循环 import）。
   */
  function renderStatsView() {
    renderStatsPanel(dom.viewStats, {
      stats: computeStats(),
      state,
      /* 点国家排行 / 年份芯片 → 回到地图并定位（与「足迹」时间线同一套交互）。
         先切视图再选点：selectPlace 里的 flyTo 需要地图容器已经可见，
         否则 MapLibre 会按 0 尺寸画布算中心，落点会飘。 */
      onGoPlace: (place) => {
        setView('map');
        onSelectPlace?.(place, { openModal: true });
      },
      /* 入参是色值（typePanel 手上只有色值）。类型色来自数据，照旧过一层 escapeHtml。 */
      pinGlyph: (color) => pinSvg({ fill: escapeHtml(color) }),
    });
  }

  function renderSettingsView({ styleKey, onStyleChange, onDataReload }) {
    const root = dom.viewSettings;
    root.innerHTML = `
      <div class="sect">
        <div class="sect__title">底图样式</div>
        <div class="sect__sub">OpenFreeMap 矢量瓦片，切换后地图与弹窗小地图会同步更新</div>
      </div>
      <div class="chips" id="tm-style-chips"></div>

      <div class="sect">
        <div class="sect__title">数据备份与恢复</div>
        <div class="sect__sub">导出为 zip 备份（含照片 / 视频与数据库快照）；新部署后导入该压缩包即可恢复全部数据</div>
      </div>
      <div class="datarow">
        <button class="btn btn--primary" id="tm-export-btn" type="button">导出备份（zip）</button>
        <button class="btn" id="tm-import-btn" type="button">导入备份（zip）</button>
        <input type="file" id="tm-import-file" accept=".zip,application/zip" hidden>
      </div>

      <div class="sect">
        <div class="sect__title">批量照片归类</div>
        <div class="sect__sub">把还没归类到地点的照片，按每张自带的 GPS 坐标自动识别城市、聚成地点。先看预览再确认写入。</div>
      </div>
      <div class="datarow">
        <button class="btn" id="tm-archive-btn" type="button">智能归档（按 GPS 自动建地点）</button>
      </div>

      <div class="sect">
        <div class="sect__title">高德逆地理编码（可选增强）</div>
        <div class="sect__sub">留空则用内置离线城市库（GeoNames，约 3.4 万城市）。填入高德 Web 服务 Key 后，中文地名更精确、可细到区/县。Key 仅保存在本机数据库，不上传。</div>
      </div>
      <div class="datarow">
        <input type="text" id="tm-amap-key" class="input" placeholder="高德 Web 服务 Key（留空用离线库）" autocomplete="off" spellcheck="false">
        <button class="btn" id="tm-amap-save" type="button">保存 Key</button>
      </div>

      <div class="sect">
        <div class="sect__title">国家上色</div>
        <div class="sect__sub">按国家唯一键哈希取色，共 ${COLORS.visitedPalette.length} 种暖色大地色系</div>
      </div>
      <div class="metarow">
        ${COLORS.visitedPalette.map((c) => `<span class="metatag"><span class="metatag__swatch" style="background:${c}"></span><b>${c}</b></span>`).join('')}
      </div>

      <div class="sect">
        <div class="sect__title">系统信息</div>
        <div class="sect__sub">当前部署的运行环境与数据来源</div>
      </div>
      <div class="metarow">
        <span class="metatag">数据 · 后端数据库（SQLite）</span>
        <span class="metatag">国家边界 <b>world.json</b></span>
        <span class="metatag">轮询间隔 <b>15s</b></span>
        <span class="metatag">地图引擎 <b>MapLibre GL JS v5</b></span>
        <span class="metatag">投影 <b>mercator（平面）</b></span>
      </div>

      <div class="sect">
        <div class="sect__title">说明</div>
      </div>
      <div class="notecard">本项目支持上传真实照片 / 视频 / 笔记。点「记录新足迹」新增地点并上传媒体；未上传媒体时该地点不显示图片，上传后自动出现。</div>`;

    const chips = root.querySelector('#tm-style-chips');
    Object.keys({ positron: 1, liberty: 1, bright: 1 }).forEach((key) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `chip${key === styleKey ? ' is-active' : ''}`;
      b.textContent = key;
      b.addEventListener('click', () => {
        chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('is-active'));
        b.classList.add('is-active');
        onStyleChange?.(key);
      });
      chips.append(b);
    });

    /* 数据备份 / 恢复 */
    const exportBtn = root.querySelector('#tm-export-btn');
    const importBtn = root.querySelector('#tm-import-btn');
    const importFile = root.querySelector('#tm-import-file');
    exportBtn.addEventListener('click', async () => {
      try {
        setStatus('正在导出备份…');
        await api.exportZip();
        setStatus('导出完成 ✓');
        toast('备份已导出');
      } catch (e) {
        setStatus('导出失败');
        toast(e.message || '导出失败');
      }
    });
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const f = importFile.files && importFile.files[0];
      if (!f) return;
      if (!window.confirm('导入将覆盖当前全部地点、行程、媒体与资料，确定继续吗？\n（建议先导出一份备份）')) {
        importFile.value = '';
        return;
      }
      try {
        setStatus('正在导入备份…');
        const r = await api.importZip(f);
        toast(`导入完成：地点 ${r.places || 0} · 行程 ${r.trips || 0} · 媒体 ${r.media || 0}`);
        setStatus('导入完成，正在刷新…');
        if (typeof onDataReload === 'function') onDataReload();
        importFile.value = '';
      } catch (e) {
        setStatus('导入失败');
        toast(e.message || '导入失败');
        importFile.value = '';
      }
    });

    /* 批量照片归类（智能归档） */
    const archiveBtn = root.querySelector('#tm-archive-btn');
    if (archiveBtn && typeof onOpenArchive === 'function') {
      archiveBtn.addEventListener('click', () => onOpenArchive());
    }

    /* 高德 Key（可选逆地理增强）：预填 + 保存 */
    const amapInput = root.querySelector('#tm-amap-key');
    const amapSave = root.querySelector('#tm-amap-save');
    if (amapInput && amapSave) {
      api.getMeta('amapKey').then((r) => { if (r && r.value) amapInput.value = r.value; }).catch(() => {});
      amapSave.addEventListener('click', async () => {
        try {
          await api.setMeta('amapKey', amapInput.value.trim());
          toast('高德 Key 已保存');
        } catch (e) {
          toast(e.message || '保存失败');
        }
      });
    }
  }

  /* ---------- 汇总渲染 ---------- */
  function renderAll(next) {
    state = next;
    const stats = computeStats();

    countUp(dom.statCountries, stats.countries);
    countUp(dom.statCities, stats.cities);
    countUp(dom.statTrips, stats.trips);

    dom.userCountries.textContent = String(stats.countries);
    dom.userPct.textContent = `${stats.pct.toFixed(1)}%`;
    requestAnimationFrame(() => { dom.userBar.style.width = `${Math.min(100, stats.pct)}%`; });

    // 首页小组件网格（Widget 注册表渲染，见下方 Widget 系统）
    renderHome();

    if (currentView === 'footprints') renderFootprintsView();
    if (currentView === 'collections') renderCollectionsView();
    if (currentView === 'wishlist') renderWishlistView();
    if (currentView === 'stats') renderStatsView();
  }

  function setStatus(text) { if (dom.status) dom.status.textContent = text; }

  /* ---------- 事件 ---------- */
  dom.nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    setView(btn.dataset.view, { media: btn.dataset.media });
  });

  /* 视图切换按钮（页头 / 卡片里那些「查看全部足迹 / 查看全部…」）
     ⚠️ 选择器必须是 `button[data-view]`，**不能**写成 `[data-view]`。
        因为 <section class="view" data-view="stats"> 这些**视图容器自身**也带 data-view，
        用 `[data-view]` 会把点击监听器直接绑到容器上 —— 于是「在视图里点任何东西」都会冒泡到容器，
        再 setView 一次当前视图。后果有两个，都是静默的：
          1) renderViewFor() 重设 root.innerHTML → 该视图里**一切瞬时交互状态被抹掉**
             （统计页年份柱子的选中态就是这么没的：点完立刻被重渲染回初始态，看起来像"监听没绑上"）；
          2) setView 末尾的 dom.scroll.scrollTop = 0 会把页面拽回顶部。
        这个 bug 在统计页改成可交互之前一直没暴露（旧统计页没有任何可点元素）。 */
  document.querySelectorAll('button[data-view]').forEach((btn) => {
    if (btn.closest('#tm-nav')) return;      // 侧栏导航由 #tm-nav 的委托统一处理
    btn.addEventListener('click', () => setView(btn.dataset.view, { media: btn.dataset.media }));
  });

  /* 行程分组的展开/收起由 tripGroupRow 直接绑在箭头上（那里是唯一知道
     trip id、DOM 引用和展开状态的地方）。**不需要事件委托**：
     委托的代价是把 trip id 编码进 DOM 再查回来（上一版用 `[data-trip]` 就是这么做的），
     而分组每次重渲染本来就要重建按钮，顺手绑一下更直接。
     ⚠️ 箭头与 `.tl__hit` 是**兄弟**，不是嵌套 —— 箭头 z-index 更高，
        点箭头不会碰到"打开"那层，所以这里也不需要 stopPropagation。 */

  // 记录视图的筛选 chips（只建一次）
  // ⚠️ 2026-10-06 起这是**唯一**的分类筛选入口：侧栏那三个子项已去掉，
  //    它们和 chips 共用同一个 collMediaFilter，等于同一份能力的两个入口，留 chips 就够。
  ['all', 'image', 'video', 'text'].forEach((key) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = `chip${key === 'all' ? ' is-active' : ''}`;
    c.dataset.media = key;
    c.textContent = key === 'all' ? '全部' : MEDIA_LABELS[key];
    c.addEventListener('click', () => {
      collMediaFilter = key;
      dom.collFilter.querySelectorAll('.chip').forEach((x) => x.classList.remove('is-active'));
      c.classList.add('is-active');
      renderCollectionsView();
    });
    dom.collFilter.append(c);
  });

  dom.share.addEventListener('click', async () => {
    const url = location.href;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        toast('地图链接已复制到剪贴板');
      } else {
        toast(url, 5000);
      }
    } catch (_) {
      toast('当前浏览器不允许自动复制，请手动复制地址栏链接', 3600);
    }
  });

  dom.add.addEventListener('click', () => {
    if (typeof onAddPlace === 'function') onAddPlace();
    else toast('新增足迹功能未就绪', 2600);
  });

  dom.tripAdd.addEventListener('click', () => {
    if (typeof onAddTrip === 'function') onAddTrip();
    else toast('新建行程功能未就绪', 2600);
  });

  let searchTimer = null;
  dom.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => onSearch?.(dom.search.value.trim()), 180);
  });

  // （原「选中地点详情」卡的两个按钮随卡片一起删掉了：卡片已被旅途海报取代）

  /* =========================================================
   * 首页小组件系统（iOS 风格可编辑磁贴）
   * ---------------------------------------------------------
   * - 组件由 WIDGET_DEFS 注册；每个组件 mount(head, body) 填充卡头与卡体，返回 { update, destroy? }。
   * - layout = [{type, size}]，size 为离散格数 'WxH'（列×行），可选 1x1 / 2x1 / 1x2 / 2x2 / 3x2。
   * - 网格列数固定（桌面4 / 中屏2 / 窄屏1），组件只占整数格 → 调整后始终对齐。
   * - 编辑态：顶栏「编辑模块」↔「完成」；每卡出工具栏（尺寸 / 替换 / 移除）；SortableJS 拖拽重排。
   * - 布局存浏览器（STORAGE_KEY），启动读取，缺失回退 DEFAULT_LAYOUT。
   * ========================================================= */
  const STORAGE_KEY = 'travelmap.layout.v1';
  const GRID_SIZES = ['1x1', '2x1', '1x2', '2x2', '3x2'];
  /* 出厂默认布局：三行都刚好铺满（4 列）
       行1  最近足迹 2 + 愿望清单 1 + 我的记录 1
       行2  最近一次旅行 2 + 旅途海报 2
       行3  最爱几月 2 + 抽签下一站 1 + 待整理照片 1 */
  const DEFAULT_LAYOUT = [
    { type: 'recent', size: '2x1' },
    { type: 'wishlist', size: '1x1' },
    { type: 'collections', size: '1x1' },
    { type: 'lastTrip', size: '2x1' },
    { type: 'poster', size: '2x2' },
    { type: 'month', size: '2x1' },
    { type: 'roulette', size: '1x1' },
    { type: 'pending', size: '1x1' },
  ];

  function currentCols() {
    const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--cols'), 10);
    return Number.isFinite(v) && v > 0 ? v : 4;
  }
  function parseSize(sz) {
    const [w, h] = String(sz || '1x1').split('x').map(Number);
    return { w: Math.max(1, w || 1), h: Math.max(1, h || 1) };
  }
  /** 列数不足时把宽度 clamp 到可用列数，保证不溢出 */
  function clampSize(sz) {
    const { w, h } = parseSize(sz);
    return `${Math.min(w, currentCols())}x${h}`;
  }

  /* ---------- 小组件共用的派生数据 ----------
     这 4 个组件都是"同一批足迹换一种说法"，派生逻辑留在这里，
     组件 mount() 里只管画 DOM —— 免得每个组件各写一份口径。 */
  const MONTH_NAMES = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

  /** 最近一次旅行：优先「行程」（一次行程可覆盖多座城市），没写行程就退化为最近的一个过去足迹 */
  function lastTripInfo() {
    const now = Date.now();
    /* ⚠️ 只认「挂了地点」的行程：数据里存在同名空壳行程（同一趟行程有两条记录，
       一条只填了日期、一条只填了地点名），空壳会把「N 个地点 / N 份记录」显示成 0，
       看起来像坏了。没有可用行程时退回最近一个过去足迹，信息至少是真的。 */
    const trips = (state.trips || [])
      .filter((t) => t.dateTs && t.dateTs <= now && (t.places || []).length)
      .map((t) => {
        const list = t.places || [];
        const placeEnd = list.reduce((mx, p) => Math.max(mx, p.dateTs || 0), 0);
        const startTs = t.dateTs;
        const endTs = Math.max(parseDate(t.endDate).ts || 0, placeEnd, startTs);
        return {
          trip: t,
          list,
          startTs,
          endTs,
          mediaCount: list.reduce((n, p) => n + (p.mediaCount ? p.mediaCount.total : 0), 0),
          cover: t.cover || (list.find((p) => p.cover) || {}).cover || '',
        };
      })
      .sort((a, b) => b.endTs - a.endTs);
    const best = trips[0];
    if (best) {
      const t = best.trip;
      return {
        kind: 'trip',
        name: t.name,
        trip: t,
        date: t.date,
        /* 行程没写结束日期时，用组内最后一个地点补上区间（否则只显示一个孤零零的日期） */
        endDate: t.endDate || formatDateDot(new Date(best.endTs).toISOString().slice(0, 10)),
        days: Math.max(1, Math.round((best.endTs - best.startTs) / 86400000) + 1),
        placeCount: best.list.length,
        mediaCount: best.mediaCount,
        cover: best.cover,
        target: best.list[0] || null,
      };
    }
    const p = computeStats().past[0];
    if (!p) return null;
    const endTs = Math.max(parseDate(p.endDate).ts || 0, p.dateTs);
    return {
      kind: 'place',
      name: p.name,
      trip: null,
      date: p.date,
      endDate: p.endDate,
      days: Math.max(1, Math.round((endTs - p.dateTs) / 86400000) + 1),
      placeCount: 1,
      mediaCount: p.mediaCount ? p.mediaCount.total : 0,
      cover: p.cover || '',
      target: p,
    };
  }

  /** 「待整理」三个口径：未归类照片（服务端）/ 缺拍摄时间的照片 / 缺日期的地点 */
  function pendingBuckets(remoteCount) {
    const places = (state && state.places) || [];
    const noTime = [];   // { place, media }
    const noDate = [];   // place
    places.forEach((p) => {
      if (!p.dateTs) noDate.push(p);
      p.media.forEach((m) => {
        if (m.type === 'text') return;         // 文字笔记本来就没有拍摄时间
        if (!m.takenAt) noTime.push({ place: p, media: m });
      });
    });
    const unassigned = Number.isFinite(remoteCount) && remoteCount > 0 ? remoteCount : 0;
    /* 每一桶顺手带一张"代表图"：卡片里只有数字太干，给一张缩略图
       才能让人认出"哦是那批照片"。未归类照片只有后端计数、拿不到具体文件，故无图。 */
    const coverOf = (p) => (p && p.media && p.media.length ? mediaThumb(p.media[0]) : (p && p.cover) || '');
    return {
      unassigned,
      noTime: noTime.length,
      noTimeThumb: noTime[0] ? mediaThumb(noTime[0].media) : '',
      noTimePlace: noTime[0] ? noTime[0].place : null,
      noDate: noDate.length,
      noDateThumb: coverOf(noDate[0]),
      noDatePlace: noDate[0] || null,
      total: unassigned + noTime.length + noDate.length,
    };
  }

  /* 未归类照片要走一次后端（不在 /api/data 的 places 里）：
     60s 内不重复问；失败也记时间，避免每轮 15s 轮询都重试。
     ui.js 里其它地方从不缓存请求结果，这里破例是因为 update() 会被轮询反复调用。 */
  const pendingRemote = { at: 0, count: null, busy: false };
  function loadPendingRemote(done) {
    if (pendingRemote.busy) return;
    if (pendingRemote.count !== null && Date.now() - pendingRemote.at < 60000) return;
    pendingRemote.busy = true;
    api.pendingMedia()
      .then((r) => { pendingRemote.count = Number(r && r.count) || 0; })
      .catch(() => { pendingRemote.count = null; })
      .finally(() => {
        pendingRemote.at = Date.now();
        pendingRemote.busy = false;
        done?.();
      });
  }

  /* 组件注册表：8 个组件，全部可用（原来 4 个占位的第二阶段已落地） */
  const WIDGET_DEFS = {
    recent: {
      title: '最近足迹', defaultSize: '2x1',
      mount(head, body) {
        head.innerHTML = `
          <div class="tabs" role="tablist">
            ${['all', 'image', 'video', 'text'].map((t) => `
              <button class="tabs__btn${t === 'all' ? ' is-active' : ''}" data-media="${t}" role="tab">
                ${icon(t === 'all' ? 'pin' : t, 'ico')}${t === 'all' ? '最近足迹' : MEDIA_LABELS[t]}
              </button>`).join('')}
          </div>
          <button class="link" data-view="footprints">查看全部
            <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
          </button>`;
        body.classList.add('mediagrid');
        const w = { activeMedia: 'all' };
        const tabs = head.querySelector('.tabs');
        tabs.addEventListener('click', (e) => {
          const b = e.target.closest('.tabs__btn'); if (!b) return;
          tabs.querySelectorAll('.tabs__btn').forEach((x) => x.classList.remove('is-active'));
          b.classList.add('is-active');
          w.activeMedia = b.dataset.media;
          paintRecent(body, w.activeMedia);
        });
        head.querySelector('[data-view="footprints"]').addEventListener('click', () => setView('footprints'));
        return { update() { paintRecent(body, w.activeMedia); } };
      },
    },
    /* ---------- 愿望清单（1×1）：不再是一排缩小版的足迹卡 ----------
       原来和「最近足迹」用同一个 placeCard 横向条带，1×1 里只露 1.6 张、
       而且"想去"和"去过"长得一模一样。现在改成心愿卡：
       封面 + 想去/已去角标 + 名字 + 国家（含目标的补目标季）+ 优先级星，
       底部给「待出发 / 已实现」的进度。容量按实测高度自适应。 */
    wishlist: {
      title: '愿望清单', defaultSize: '1x1',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">愿望清单</h3>
          <button class="link" data-view="wishlist">查看全部 <span class="muted" data-role="total">(0)</span>
            <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
          </button>`;
        body.classList.add('wg');
        head.querySelector('[data-view="wishlist"]').addEventListener('click', () => setView('wishlist'));
        const totalEl = head.querySelector('[data-role="total"]');

        const wcard = (p) => {
          const a = annOf(p.id);
          const done = wishDone(p);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `wcard ${done ? 'wcard--done' : 'wcard--want'}`;
          const img0 = (p.media || []).find((m) => m.type === 'image') || {};
          const cover = img0.thumb_url || img0.url || p.cover || './assets/sidebar-art.svg';
          /* 国家优先：city 常常就是地点名本身（"西雅图 · 西雅图"重复过一版） */
          const where = p.countryZh || p.country || p.city || p.type || '';
          const extra = done
            ? (p.date ? formatDateDot(p.date) : '')
            : (a.target && a.target !== '未定' ? a.target : '');
          const sub = [where, extra].filter(Boolean).join(' · ');
          const pri = Number(a.priority) || 0;
          btn.innerHTML = `
            <span class="wcard__media">
              <img src="${escapeHtml(cover)}" alt="${escapeHtml(p.name)}"
                   loading="lazy" decoding="async" referrerpolicy="no-referrer" />
              <span class="wcard__tag">${done ? '已去' : '想去'}</span>
              ${pri > 0 ? `<span class="wcard__star" title="优先级 ${pri}">${'★'.repeat(Math.min(3, pri))}</span>` : ''}
            </span>
            <span class="wcard__name">${escapeHtml(p.name)}</span>
            ${sub ? `<span class="wcard__sub">${escapeHtml(sub)}</span>` : ''}`;
          const img = btn.querySelector('img');
          img?.addEventListener('error', () => { img.src = './assets/sidebar-art.svg'; }, { once: true });
          btn.addEventListener('click', () => onOpenDetail?.(p));
          return btn;
        };

        return {
          update() {
            const wish = wishlistPlaces();
            totalEl.textContent = `(${wish.length})`;
            body.innerHTML = '';
            if (!wish.length) {
              body.innerHTML = emptyState('愿望清单是空的', '点上方「+ 添加心愿」，新建或挑一个想去的地方');
              return;
            }
            const grid = document.createElement('div');
            grid.className = 'wg__grid';
            body.append(grid);
            /* 先放页脚再逐张试插：容器高度随时可由用户改尺寸/换列数，
               用「塞不下就退回」比固定塞 6 张稳（旧版同款问题见 paintRecent）。 */
            const st = wishStats(wish);
            const foot = document.createElement('div');
            foot.className = 'wg__foot';
            foot.innerHTML = `
              <span>待出发 <b>${st.active}</b></span>
              <span>已实现 <b>${st.done}</b></span>
              <span class="wg__bar"><i style="width:${st.pct}%"></i></span>`;
            body.append(foot);
            for (const p of wish) {
              const el = wcard(p);
              grid.append(el);
              if (body.scrollHeight > body.clientHeight + 2) { el.remove(); break; }
            }
          },
        };
      },
    },
    /* ---------- 我的记录（1×1）：从「图片墙」改成「记录概览」 ----------
       旧版和「最近足迹」一样是横向图片条带，而它按 stats.past 铺开所有媒体，
       前 6 张常常是同一个地点的连拍（九寨沟 ×3），150 份记录只露出 2 张。
       现在讲的是"积累了多少"：总数 + 图/视频/笔记构成 + 最近一条。
       —— 与「最近足迹」（最近去了哪）分工，不再重复。 */
    collections: {
      title: '我的记录', defaultSize: '1x1',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">我的记录</h3>
          <button class="link" data-view="collections">查看全部 <span class="muted" data-role="total">(0)</span>
            <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
          </button>`;
        body.classList.add('cl');
        head.querySelector('[data-view="collections"]').addEventListener('click', () => setView('collections'));
        const totalEl = head.querySelector('[data-role="total"]');

        return {
          update() {
            const stats = computeStats();
            const m = stats.media;
            totalEl.textContent = `(${m.total})`;
            body.innerHTML = '';
            if (!m.total) { body.innerHTML = emptyState('暂无记录', '媒体资料会出现在这里'); return; }

            const pool = [];
            for (const p of stats.past) for (const it of p.media) pool.push({ p, it });
            const places = new Set(pool.map((x) => x.p.id)).size;
            const pct = (n) => (m.total ? (n / m.total) * 100 : 0);

            body.innerHTML = `
              <div class="cl__sum"><b>${m.total}</b><span>份记录</span>
                <span class="cl__cover">覆盖 ${places} 个地点</span></div>
              <div class="cl__mix">
                <i class="is-img" style="width:${pct(m.image)}%"></i>
                <i class="is-vid" style="width:${pct(m.video)}%"></i>
                <i class="is-txt" style="width:${pct(m.text)}%"></i>
              </div>
              <div class="cl__legend">
                <span><i style="background:var(--c1)"></i>照片 <b>${m.image}</b></span>
                <span><i style="background:var(--c4)"></i>视频 <b>${m.video}</b></span>
                <span><i style="background:var(--c2)"></i>笔记 <b>${m.text}</b></span>
              </div>
              <div class="cl__latest"></div>`;

            /* 最近一条：最近一次落地地点里的第一份记录（stats.past 已按日期倒序）。
               点它直接开到那张图，而不是再跳一次「查看全部」。 */
            const p0 = stats.past.find((p) => p.media && p.media.length);
            const latestSlot = body.querySelector('.cl__latest');

            /* 被拉到 2×2 这类大尺寸时，上面那点内容只占 1/3，下面是整片空白。
               补一块「按地点分布」排行榜，行高用 flex 等分剩余空间 ——
               行数固定 8，卡片越高每行越舒展，不用为每个尺寸写一套规则。 */
            if (body.clientHeight >= 300) {
              const byPlace = stats.past
                .filter((p) => p.media && p.media.length)
                .map((p) => ({ p, n: p.media.length }))
                .sort((a, b) => b.n - a.n)
                .slice(0, 8);
              if (byPlace.length > 1) {
                const list = document.createElement('div');
                list.className = 'cl__places';
                const peak = byPlace[0].n || 1;
                byPlace.forEach(({ p, n }) => {
                  const row = document.createElement('button');
                  row.type = 'button';
                  row.className = 'cl__place';
                  row.innerHTML = `<b>${n}</b><span class="cl__pname">${escapeHtml(p.name)}</span>
                    <span class="cl__pbar"><i style="width:${Math.round((n / peak) * 100)}%"></i></span>`;
                  row.addEventListener('click', () => onOpenDetail?.(p));
                  list.append(row);
                });
                body.insertBefore(list, latestSlot);
              }
            }

            if (!p0) return;
            const it0 = p0.media[0];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cl__latest';
            btn.innerHTML = `
              <img src="${escapeHtml(mediaThumb(it0))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
              <span class="cl__latest-main">
                <span class="cl__latest-name">${escapeHtml(p0.name)}</span>
                <span class="cl__latest-sub">最近一条 · ${escapeHtml(p0.date ? formatDateDot(p0.date) : (MEDIA_LABELS[it0.type] || '记录'))}</span>
              </span>
              <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>`;
            const img = btn.querySelector('img');
            img?.addEventListener('error', () => { img.src = './assets/sidebar-art.svg'; }, { once: true });
            btn.addEventListener('click', () => onOpenPhoto?.(p0, it0));
            body.querySelector('.cl__latest').replaceWith(btn);
          },
        };
      },
    },
    poster: {
      title: '旅途海报', defaultSize: '2x2',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">旅途海报 <span class="muted" data-role="sum"></span></h3>
          <div class="card__actions">
            <button class="btn btn--pill" data-role="shuffle">换一批</button>
            <button class="link" data-view="collections">查看全部 <span class="muted" data-role="total">(0)</span>
              <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
            </button>
          </div>`;
        body.classList.add('posterwall');
        const posterApi = createPoster({ root: body, onOpen: (place, item) => onOpenPhoto?.(place, item) });
        head.querySelector('[data-role="shuffle"]').addEventListener('click', () => posterApi.shuffle());
        head.querySelector('[data-view="collections"]').addEventListener('click', () => setView('collections'));
        return {
          update() {
            const pool = posterPool();
            posterApi.setMedia(pool);
            const stats = computeStats();
            head.querySelector('[data-role="total"]').textContent = `(${stats.media.total})`;
            /* 图墙只看图会"不知道自己在看什么"，补一句口径：覆盖几地、几张可看 */
            const places = new Set(pool.map((it) => it.place && it.place.id)).size;
            head.querySelector('[data-role="sum"]').textContent = pool.length ? `${places} 地 · ${pool.length} 张` : '';
          },
          destroy() { posterApi.destroy(); },
        };
      },
    },
    /* ---------- 待整理照片（1×1）：三个「能立刻动手」的口径 ----------
       头条数字是总项数，下面固定三行可点的清单（0 项的行置灰）。
       ⚠️「未归类照片」不在 /api/data 里（那些媒体 place_id 为空，不属于任何地点），
          只能单独问后端；另外两类从已有地点/媒体现场算。 */
    pending: {
      title: '待整理照片', defaultSize: '1x1',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">待整理照片</h3>
          <button class="link" data-role="go">去整理
            <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
          </button>`;
        body.classList.add('pnd');

        const goArchive = () => {
          if (typeof onOpenArchive === 'function') onOpenArchive();
          else toast('批量归类功能未就绪', 2400);
        };
        head.querySelector('[data-role="go"]').addEventListener('click', goArchive);

        const paint = () => {
          const b = pendingBuckets(pendingRemote.count);
          if (pendingRemote.count !== null && !b.total) {
            body.innerHTML = emptyState('都整理好了', '照片的时间、地点、归类都齐了');
            return;
          }
          /* 三行固定出现（计数为 0 的行置灰），不做「有才显示」——
             否则整理掉一项后卡片高度/条目顺序都会跳，像是抽掉了什么。
             未归类照片要走一次后端，数据没到手前那行显示「·」而不是 0（0 会是假话）。 */
          const rows = [
            { label: '未归类照片', n: pendingRemote.count === null ? null : b.unassigned, thumb: '', c: 'var(--c1)', on: goArchive },
            { label: '缺拍摄时间', n: b.noTime, thumb: b.noTimeThumb, c: 'var(--c4)', on: () => b.noTimePlace && onOpenDetail?.(b.noTimePlace) },
            { label: '缺日期', n: b.noDate, thumb: b.noDateThumb, c: 'var(--c2)', on: () => {
              if (!b.noDatePlace) return;
              if (typeof onEditPlace === 'function') onEditPlace(b.noDatePlace);
              else onOpenDetail?.(b.noDatePlace);
            } },
          ];

          body.innerHTML = `<div class="pnd__sum"><b>${b.total}</b><span>项待整理</span></div><div class="pnd__list"></div>`;
          const list = body.querySelector('.pnd__list');
          rows.forEach((r) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `pnd__row${r.n ? '' : ' is-zero'}`;
            btn.style.setProperty('--c', r.c);
            btn.title = r.label;
            btn.innerHTML = `${r.thumb
              ? `<img class="pnd__thumb" src="${escapeHtml(r.thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`
              : '<span class="pnd__dot"></span>'}
              <span class="pnd__label">${r.label}</span>`
              + `<b class="pnd__n">${r.n === null ? '·' : r.n}</b>`
              + `<svg class="ico ico--sm pnd__arrow" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>`;
            /* 缩略图挂了就退回小色点，别留一个灰方块 */
            const im = btn.querySelector('.pnd__thumb');
            im?.addEventListener('error', () => {
              im.replaceWith(Object.assign(document.createElement('span'), { className: 'pnd__dot', style: `--c:${r.c}` }));
            }, { once: true });
            btn.addEventListener('click', r.on);
            list.append(btn);
          });
        };

        return {
          update() {
            paint();
            loadPendingRemote(paint);   // 未归类照片数到手后再画一次
          },
        };
      },
    },

    /* ---------- 最近一次旅行（2×1）：封面 + 日期 + 三个数字 ----------
       优先「行程」（一次行程可覆盖多座城市），没写行程就退化为最近一个过去足迹。
       点卡片：行程 → 弹窗里跑路线动画；单个足迹 → 地点详情。 */
    lastTrip: {
      title: '最近一次旅行', defaultSize: '2x1',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">最近一次旅行</h3>
          <button class="link" data-view="footprints">全部足迹
            <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
          </button>`;
        body.classList.add('lt');
        head.querySelector('[data-view="footprints"]').addEventListener('click', () => setView('footprints'));

        const openInfo = (info) => {
          if (!info) return;
          if (info.kind === 'trip' && typeof onOpenTrip === 'function') { onOpenTrip(info.trip); return; }
          if (info.target) onOpenDetail?.(info.target);
        };

        /* 距今多久：「2026.10.01 - 03」说的是什么时候，但看首页的人想知道
           "这趟过去多久了"。只服务这张卡，放在组件区内。 */
        const agoText = (endDate, fallbackDate) => {
          const ts = parseDate(endDate).ts || parseDate(fallbackDate).ts;
          if (!ts) return '';
          const d = Math.floor((Date.now() - ts) / 86400000);
          if (d <= 0) return '进行中';
          if (d === 1) return '昨天结束';
          if (d < 30) return `${d} 天前`;
          if (d < 365) return `${Math.floor(d / 30)} 个月前`;
          return `${Math.floor(d / 365)} 年前`;
        };

        return {
          update() {
            const info = lastTripInfo();
            if (!info) {
              body.innerHTML = emptyState('还没有出发记录', '有日期的足迹会在这里汇总成一次旅行');
              return;
            }
            const when = info.endDate
              ? formatDateRange(info.date, info.endDate)
              : (formatDateDot(info.date) || '未写日期');
            /* 行程的站点名（超过 4 个收成「等 N 站」）：单点足迹不显示这一行 */
            const names = info.kind === 'trip' && info.trip
              ? (info.trip.places || []).map((p) => p.name)
              : [];
            const stops = names.length > 1
              ? `${names.slice(0, 4).join(' · ')}${names.length > 4 ? ` 等 ${names.length} 站` : ''}`
              : '';
            body.innerHTML = `
              <div class="lt__cover">
                ${info.cover ? `<img src="${escapeHtml(info.cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}
                <span class="lt__tag">${info.kind === 'trip' ? '行程' : '足迹'}</span>
              </div>
              <div class="lt__info">
                <p class="lt__when">${escapeHtml(when)}${
                  agoText(info.endDate, info.date) ? `<span class="lt__ago">${escapeHtml(agoText(info.endDate, info.date))}</span>` : ''
                }</p>
                <p class="lt__name">${escapeHtml(info.name)}</p>
                <div class="lt__stats">
                  <span><b>${info.days}</b><i>天</i></span>
                  <span><b>${info.placeCount}</b><i>个地点</i></span>
                  <span><b>${info.mediaCount}</b><i>份记录</i></span>
                </div>
                ${stops ? `<p class="lt__stops" title="${escapeHtml(names.join(' → '))}">${escapeHtml(stops)}</p>` : ''}
              </div>
              <span class="lt__cta">${info.kind === 'trip' ? '走一遍' : '看看'}</span>
              <button type="button" class="lt__hit" aria-label="打开 ${escapeHtml(info.name)}"></button>`;
            const img = body.querySelector('.lt__cover img');
            /* 封面文件缺失（离线/被清理）时整块让位，不显示破图 */
            img?.addEventListener('error', () => img.remove(), { once: true });
            body.querySelector('.lt__hit').addEventListener('click', () => openInfo(info));
          },
        };
      },
    },

    /* ---------- 抽签下一站（1×1）：从「待出发」的心愿里随机抽一个 ----------
       滚动抽签是纯前端动画（setTimeout 逐帧换名字 + 减速），落地后点名字可直接进详情。 */
    roulette: {
      title: '抽签下一站', defaultSize: '1x1',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">抽签下一站</h3>
          <button class="link" data-view="wishlist">心愿清单
            <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
          </button>`;
        body.classList.add('rlt');
        body.innerHTML = `
          <div class="rlt__stage">
            <span class="rlt__thumb" data-role="thumb" aria-hidden="true"></span>
            <p class="rlt__kicker" data-role="kicker">从心愿清单里抽一签</p>
            <p class="rlt__name" data-role="name">准备好了吗</p>
            <p class="rlt__sub" data-role="sub"></p>
          </div>
          <button type="button" class="rlt__go" data-role="go">抽一签</button>`;
        head.querySelector('[data-view="wishlist"]').addEventListener('click', () => setView('wishlist'));

        const nameEl = body.querySelector('[data-role="name"]');
        const subEl = body.querySelector('[data-role="sub"]');
        const kickerEl = body.querySelector('[data-role="kicker"]');
        const goEl = body.querySelector('[data-role="go"]');
        const thumbEl = body.querySelector('[data-role="thumb"]');
        const w = { pool: [], cur: null, idx: 0, timer: 0, spinning: false };

        /* 抽中后给一个画面的落点：有照片就用该心愿的首图，没有就退化成
           带首字的色块。未抽时留一个虚线「?」占位 —— 否则默认态只有一句话
           加一个按钮、中间全空，而且抽中的瞬间整块会往上跳。 */
        function paintThumb(p) {
          thumbEl.className = 'rlt__thumb';
          thumbEl.style.backgroundImage = '';
          thumbEl.style.background = '';
          thumbEl.textContent = '';
          if (!p) {
            thumbEl.textContent = '?';
            thumbEl.classList.add('is-on', 'is-ph', 'is-idle');
            return;
          }
          const img = (p.media || []).find((m) => m.type === 'image');
          if (img) {
            thumbEl.style.backgroundImage = `url("${img.thumb_url || img.url}")`;
            thumbEl.classList.add('is-on');
            return;
          }
          thumbEl.style.background = `linear-gradient(150deg, ${(state.colorOf && state.colorOf(p)) || '#9DB4CC'}, var(--surface-3))`;
          thumbEl.textContent = String(p.name || '').slice(0, 1);
          thumbEl.classList.add('is-on', 'is-ph');
        }
        function resetIdle() {
          w.cur = null;
          nameEl.textContent = '准备好了吗';
          nameEl.classList.remove('is-hit', 'is-rolling');
          kickerEl.textContent = '从心愿清单里抽一签';
          goEl.textContent = '抽一签';
          goEl.disabled = false;
          paintThumb(null);
        }
        function syncPool() {
          const all = wishlistPlaces();
          w.pool = all.filter((p) => !wishDone(p));   // 已实现的沉底，不参与抽签
          subEl.textContent = all.length
            ? `心愿 ${all.length} 个 · 待出发 ${w.pool.length} 个`
            : '愿望清单还是空的';
          if (w.cur && !w.pool.includes(w.cur)) resetIdle();
        }
        function settle() {
          const n = w.pool.length;
          let i = Math.floor(Math.random() * n);
          if (n > 1 && w.pool[i] === w.cur) i = (i + 1) % n;
          w.idx = i;
          w.cur = w.pool[i];
          w.spinning = false;
          nameEl.classList.remove('is-rolling', 'is-hit');
          void nameEl.offsetWidth;          // 强制重排，让 is-hit 的动画每次都重新播
          nameEl.textContent = w.cur.name;
          nameEl.classList.add('is-hit');
          kickerEl.textContent = '这一站去';
          /* 顺位 = 它在完整心愿列表里的位置（已按优先级/日期排好），
             比单写国家更能表达"这个心愿在心里排第几"。 */
          const rank = wishlistPlaces().indexOf(w.cur) + 1;
          const where = w.cur.countryZh || w.cur.country || w.cur.city || '';
          subEl.textContent = [where, rank > 0 ? `第 ${rank} 顺位` : ''].filter(Boolean).join(' · ') || '点名字看详情';
          paintThumb(w.cur);
          goEl.textContent = '再抽一次';
          goEl.disabled = false;
        }
        function spin() {
          if (w.spinning) return;
          syncPool();
          if (!w.pool.length) { toast('愿望清单里还没有待出发的地方', 2600); return; }
          w.spinning = true;
          goEl.disabled = true;
          goEl.textContent = '抽签中…';
          kickerEl.textContent = '正在摇签筒';
          paintThumb(null);   // 摇的时候不能还挂着上一次的封面
          nameEl.classList.remove('is-hit');
          nameEl.classList.add('is-rolling');
          let remain = 18;
          const tick = () => {
            w.idx = (w.idx + 1) % w.pool.length;
            nameEl.textContent = w.pool[w.idx].name;
            remain -= 1;
            if (remain <= 0) { w.timer = 0; settle(); return; }
            w.timer = setTimeout(tick, remain <= 3 ? 130 : remain <= 7 ? 90 : 55);   // 越接近落地越慢
          };
          w.timer = setTimeout(tick, 55);
        }

        goEl.addEventListener('click', spin);
        nameEl.addEventListener('click', () => {
          if (!w.cur) return;
          if (!Number.isFinite(w.cur.lng) || !Number.isFinite(w.cur.lat)) {
            toast('这个心愿还没有坐标，先补上再看详情', 2600);
            return;
          }
          onOpenDetail?.(w.cur);
        });

        paintThumb(null);   // 未抽签的初始占位（与抽中后的结构一致，不跳动）

        return {
          update() { if (!w.spinning) syncPool(); },
          destroy() { if (w.timer) clearTimeout(w.timer); },
        };
      },
    },

    /* ---------- 你最爱几月出发（2×1）：12 个月柱状，峰值月高亮 ----------
       口径与统计页一致：只算「有日期且已过」的足迹（stats.past），一张照片不算一次出发。 */
    month: {
      title: '你最爱几月出发', defaultSize: '2x1',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">你最爱几月出发</h3>
          <span class="muted" data-role="sum"></span>`;
        body.classList.add('mon');
        const sumEl = head.querySelector('[data-role="sum"]');

        return {
          update() {
            const stats = computeStats();
            const counts = new Array(12).fill(0);
            stats.past.forEach((p) => {
              /* dateTs 来自 Date.UTC()，必须用 getUTCMonth —— 用本地时区的 getMonth
                 在东八区会把「每月 1 号」的足迹挪到上一个月（UTC 0 点是本地 8 点，看似无事，
                 但 UTC-x 时区就会前移一天）。 */
              const d = new Date(p.dateTs);
              if (!Number.isNaN(d.getTime())) counts[d.getUTCMonth()] += 1;
            });
            const total = counts.reduce((a, b) => a + b, 0);
            sumEl.textContent = total ? `共 ${total} 次出发` : '';
            if (!total) {
              body.innerHTML = emptyState('还没有出发记录', '有日期的足迹会自动按月统计');
              return;
            }
            const max = Math.max(...counts);
            const peak = counts.indexOf(max);
            const min = Math.min(...counts);
            const cold = counts.indexOf(min);
            const avg = (total / 12).toFixed(1);
            body.innerHTML = `
              <p class="mon__lead">最常出发的是<b>${MONTH_NAMES[peak]}</b>
                <span class="mon__pct">${max} 次 · ${Math.round((max / total) * 100)}%</span></p>
              <div class="mon__bars"></div>
              <p class="mon__foot">
                <span>平均每月 <b>${avg}</b> 次</span>
                <span>${min === max ? '每个月都有出发' : `最冷清 <b>${MONTH_NAMES[cold]}</b>${min ? `（${min} 次）` : ''}`}</span>
              </p>`;
            const bars = body.querySelector('.mon__bars');
            /* 柱子按季节上色（春/夏/秋/冬，取现有国家色系，不新造颜色）：
               12 根柱里常年只有 3~4 根有值，纯灰的空轨道看不出"一年是什么节奏"。
               零值柱改画 2px 基线（CSS 里覆盖内联高度），月份轴才完整。 */
            const seasonOf = (i) => (i >= 2 && i <= 4 ? 'spring'
              : i >= 5 && i <= 7 ? 'summer'
              : i >= 8 && i <= 10 ? 'autumn' : 'winter');
            counts.forEach((n, i) => {
              const col = document.createElement('div');
              col.className = `mon__col is-${seasonOf(i)}${i === peak ? ' is-peak' : ''}${n ? '' : ' is-zero'}`;
              col.title = `${MONTH_NAMES[i]} · ${n} 次`;
              /* 柱高按「该月次数 / 最高月」的百分比写在柱子上，柱子外面必须有一层
                 .mon__track 兜住底部对齐 —— 直接给 .mon__col 百分比会让柱子按
                 「含月份标签」的整列高度算，满格那根会顶掉标签。 */
              col.innerHTML = `<span class="mon__track"><span class="mon__bar" style="height:${n ? Math.max(12, Math.round((n / max) * 100)) : 0}%"></span></span>`
                + `<span class="mon__lab">${i + 1}</span>`;
              bars.append(col);
            });
          },
        };
      },
    },
  };

  const gridEl = document.getElementById('tm-widget-grid');
  const editBtn = document.getElementById('tm-edit-widgets');
  const resetBtn = document.getElementById('tm-reset-layout');
  let layout = loadLayout() || DEFAULT_LAYOUT.map((s) => ({ ...s }));
  let editing = false;
  let slots = [];
  let addEl = null;        // 网格末尾的「＋ 添加模块」瓦片（每次 buildGrid 重建）
  let dragMoved = false;   // 刚结束拖拽时为 true，避免拖完组件后的点击被当成"点空白保存"
  let sortable = null;

  /* 模块在首页上的唯一性：一个模块只能出现一次。
     layout 是唯一权威（含 DOM 反推来的最新状态），因此「已占用」= layout 里的 type 集合；
     已占用的不再进待选列表，移除后自动回到列表。
     注意：替换场景不需要给目标开例外 —— 目标本身就占用着那一格，
     所以它天然不会出现在「未占用」列表里（早期版本给它开了例外，反而让它自己列了出来）。 */
  function usedTypes() {
    return new Set(layout.map((s) => s.type));
  }
  function availableTypes() {
    const used = usedTypes();
    return Object.keys(WIDGET_DEFS).filter((t) => !used.has(t));
  }
  /* 「＋ 添加模块」瓦片状态：还有剩余模块才可点；全加满则保留瓦片但置灰不可点
     （入口不隐藏，避免用户以为功能消失）。 */
  function refreshAddTile() {
    if (!addEl) return;
    const depleted = availableTypes().length === 0;
    addEl.disabled = depleted;
    addEl.classList.toggle('is-depleted', depleted);
    addEl.title = depleted ? '所有模块都已在主页上，移除某个模块后可再次添加' : '添加模块';
    const label = addEl.querySelector('span');
    if (label) label.textContent = depleted ? '已全部添加' : '添加模块';
  }

  function loadLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return null;
      return arr.filter((s) => WIDGET_DEFS[s.type]);
    } catch (_) { return null; }
  }
  function persistLayout() {
    syncLayoutFromDom();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layout)); } catch (_) {}
  }
  function syncLayoutFromDom() {
    const order = [...gridEl.querySelectorAll('.widget')].map((el) => ({
      type: el.dataset.type,
      size: clampSize(el.dataset.size || WIDGET_DEFS[el.dataset.type].defaultSize),
    }));
    layout = order;
  }
  function applySize(rec) {
    const sz = clampSize(rec.size || WIDGET_DEFS[rec.type].defaultSize);
    rec.size = sz;
    const { w, h } = parseSize(sz);
    rec.el.style.setProperty('--w', w);
    rec.el.style.setProperty('--h', h);
    rec.el.dataset.size = sz;
    const lbl = rec.el.querySelector('.widget__size');
    if (lbl) lbl.textContent = `${w}×${h}`;
  }

  function buildGrid() {
    destroySortable();
    slots.forEach((s) => s.api && s.api.destroy && s.api.destroy());
    gridEl.innerHTML = '';
    slots = [];
    layout.forEach((slot) => {
      const def = WIDGET_DEFS[slot.type];
      if (!def) return;
      const el = document.createElement('section');
      el.className = 'card widget';
      el.dataset.type = slot.type;
      const tools = document.createElement('div');
      tools.className = 'widget__tools';
      tools.innerHTML = `
        <button class="widget__btn widget__size" type="button" title="调整尺寸"></button>
        <button class="widget__btn widget__replace" type="button" title="替换组件">${icon('edit', 'ico ico--sm')}</button>
        <button class="widget__btn widget__remove" type="button" title="移除">${icon('minus', 'ico ico--sm')}</button>`;
      const head = document.createElement('div');
      head.className = 'card__head card__head--spread widget__head';
      const body = document.createElement('div');
      body.className = 'card__body widget__body';
      el.append(tools, head, body);
      gridEl.append(el);

      const api = def.mount(head, body);
      const rec = { el, type: slot.type, size: slot.size || def.defaultSize, api };
      applySize(rec);

      tools.querySelector('.widget__size').addEventListener('click', (e) => { e.stopPropagation(); openSizeMenu(rec, e.currentTarget); });
      tools.querySelector('.widget__replace').addEventListener('click', (e) => { e.stopPropagation(); openWidgetSheet(rec); });
      tools.querySelector('.widget__remove').addEventListener('click', (e) => { e.stopPropagation(); removeSlot(rec); });
      slots.push(rec);
    });
    /* 网格末尾的「＋ 添加模块」：只在编辑态露出（显隐交给 CSS），
       是 openWidgetSheet(null) 的唯一入口 —— 此前只有卡片上的「替换」能打开那个弹窗，
       于是一旦把模块移除就再也加不回来。它不是 .widget，所以不参与拖拽，也不进布局。 */
    addEl = document.createElement('button');
    addEl.type = 'button';
    addEl.className = 'widget-add';
    addEl.innerHTML = `${icon('plus', 'ico')}<span>添加模块</span>`;
    addEl.addEventListener('click', (e) => { e.stopPropagation(); openWidgetSheet(null); });
    gridEl.append(addEl);
    refreshAddTile();   // 全部模块都在首页时置灰不可点

    if (editing) enterEditVisual();
  }

  function renderHome() {
    slots.forEach((s) => s.api && s.api.update && s.api.update());
  }

  function removeSlot(rec) {
    rec.el.remove();
    if (rec.api && rec.api.destroy) rec.api.destroy();
    slots = slots.filter((s) => s !== rec);
    syncLayoutFromDom();
    refreshAddTile();   // 释放出来的模块回到待选列表，瓦片重新可用
  }
  function addSlot(type = 'recent', size) {
    const def = WIDGET_DEFS[type];
    if (!def) return;
    if (usedTypes().has(type)) { toast('该模块已在主页上'); return; }  // 兜底：同一模块只允许一个
    layout.push({ type, size: size || def.defaultSize });
    buildGrid();
    renderHome();
  }

  function enterEditVisual() {
    gridEl.classList.add('is-editing');
    slots.forEach((s) => s.el.classList.add('is-shaking'));
    initSortable();
  }
  function exitEditVisual() {
    gridEl.classList.remove('is-editing');
    slots.forEach((s) => s.el.classList.remove('is-shaking'));
    destroySortable();
  }
  function initSortable() {
    if (sortable || !window.Sortable || !gridEl) return;
    sortable = window.Sortable.create(gridEl, {
      animation: 160,
      draggable: '.widget',
      onEnd: () => { syncLayoutFromDom(); dragMoved = true; },
    });
  }
  function destroySortable() { if (sortable) { sortable.destroy(); sortable = null; } }

  function enterEdit() {
    if (editing) return;
    editing = true;
    if (editBtn) { editBtn.textContent = '完成'; editBtn.classList.add('is-active'); }
    if (resetBtn) resetBtn.hidden = false;   // 编辑态才暴露「重置布局」
    enterEditVisual();
  }
  function exitEdit() {
    if (!editing) return;
    editing = false;
    if (editBtn) { editBtn.textContent = '编辑模块'; editBtn.classList.remove('is-active'); }
    if (resetBtn) resetBtn.hidden = true;
    exitEditVisual();
    persistLayout();
  }

  /* 尺寸快捷菜单（5 种离散尺寸） */
  function openSizeMenu(rec, anchor) {
    closeWidgetMenus();
    const menu = document.createElement('div');
    menu.className = 'wj-menu';
    menu.dataset.role = 'size-menu';
    menu.innerHTML = GRID_SIZES.map((sz) => {
      const { w, h } = parseSize(sz);
      const disabled = w > currentCols();
      return `<button type="button" data-size="${sz}" ${disabled ? 'disabled' : ''}>${w}×${h}${disabled ? '（空间不足）' : ''}</button>`;
    }).join('');
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${r.left}px`;
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-size]'); if (!b || b.disabled) return;
      rec.size = b.dataset.size;
      applySize(rec);
      syncLayoutFromDom();
      closeWidgetMenus();
    });
    setTimeout(() => document.addEventListener('click', closeWidgetMenus, { once: true }), 0);
  }

  /* 替换 / 新增 底部弹窗（只列出尚未上首页的组件） */
  const sheet = document.getElementById('tm-widget-sheet');
  const sheetMask = document.getElementById('tm-widget-sheet-mask');
  const sheetBody = document.getElementById('tm-widget-sheet-body');
  const sheetTitle = document.getElementById('tm-widget-sheet-title');
  let sheetTarget = null; // 替换目标 rec；为 null 表示新增

  /* 替换 / 新增 共用的列表渲染：
     - 已添加到首页的模块不出现在列表里（严格按需求），因此每项都是「真正可选」的。
     - 替换时目标同样不在列表里（它正占用着那一格），标题写成「替换「最近一次旅行」」交代当前对象。
     - 列表可能为空（默认布局就把 8 个模块全用上了），此时给空态说明怎么解除。 */
  function renderSheetList(rec) {
    syncLayoutFromDom();   // 以 DOM 为准，避免拖拽 / 替换后 layout 落后一拍
    const types = availableTypes();
    if (!types.length) {
      const total = Object.keys(WIDGET_DEFS).length;
      sheetBody.innerHTML = `<p class="wj-sheet__empty">${
        rec
          ? `没有其他可替换的模块 —— ${total} 个模块都已在主页上。<br>先移除某个模块，再来替换。`
          : `${total} 个模块都已在主页上。<br>移除某个模块后，它会重新出现在这里。`
      }</p>`;
      return;
    }
    sheetBody.innerHTML = types.map((type) => `
      <button type="button" class="wj-sheet__item" data-type="${type}">
        <span class="wj-sheet__name">${WIDGET_DEFS[type].title}</span>
        <span class="wj-sheet__size">${WIDGET_DEFS[type].defaultSize}</span>
      </button>`).join('');
    sheetBody.querySelectorAll('button[data-type]').forEach((b) => {
      b.addEventListener('click', () => {
        const type = b.dataset.type;
        if (sheetTarget) {
          if (sheetTarget.api && sheetTarget.api.destroy) sheetTarget.api.destroy();
          sheetTarget.type = type;
          sheetTarget.el.dataset.type = type;
          const head = sheetTarget.el.querySelector('.widget__head');
          const body = sheetTarget.el.querySelector('.widget__body');
          head.innerHTML = '';
          body.className = 'card__body widget__body';
          body.innerHTML = '';
          sheetTarget.api = WIDGET_DEFS[type].mount(head, body);
          if (editing) sheetTarget.el.classList.add('is-shaking');
        } else {
          addSlot(type);
        }
        syncLayoutFromDom();
        refreshAddTile();   // 替换后旧模块被释放，瓦片可能从置灰恢复
        closeWidgetSheet();
      });
    });
  }

  function openWidgetSheet(rec) {
    sheetTarget = rec || null;
    const targetDef = rec ? WIDGET_DEFS[rec.type] : null;
    sheetTitle.textContent = rec ? `替换「${targetDef ? targetDef.title : '组件'}」` : '新增组件';
    renderSheetList(rec);
    sheet.hidden = false; sheetMask.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('is-open'));
  }
  function closeWidgetSheet() {
    sheet.classList.remove('is-open');
    sheetMask.hidden = true;
    setTimeout(() => { sheet.hidden = true; }, 240);
  }
  function closeWidgetMenus() {
    document.querySelectorAll('[data-role="size-menu"]').forEach((m) => m.remove());
  }
  sheetMask?.addEventListener('click', closeWidgetSheet);
  document.getElementById('tm-widget-sheet-close')?.addEventListener('click', closeWidgetSheet);

  editBtn?.addEventListener('click', () => { editing ? exitEdit() : enterEdit(); });
  resetBtn?.addEventListener('click', (e) => { e.stopPropagation(); resetLayout(); });

  /* 重置布局：把首页模块恢复为出厂默认（DEFAULT_LAYOUT），覆盖当前自定义。
     仅在编辑态可见；先二次确认，避免误触丢失自定义。 */
  function resetLayout() {
    if (!window.confirm('确定把首页模块恢复为默认布局吗？\n当前自定义（顺序 / 尺寸 / 已移除的模块）将被覆盖。')) return;
    layout = DEFAULT_LAYOUT.map((s) => ({ ...s }));
    buildGrid();      // 重建网格；editing 态会由 enterEditVisual 重新套上抖动 + 拖拽
    renderHome();
    persistLayout();  // 内部 syncLayoutFromDom → 写回 localStorage
    toast('已恢复默认布局');
  }

  // 每次按下先清掉"拖拽残留"标记，保证下一次交互的判断是干净的
  document.addEventListener('mousedown', () => { dragMoved = false; });

  // 编辑态下点网格空白处关闭尺寸菜单（点工具栏按钮已 stopPropagation，不会触发）
  gridEl.addEventListener('click', (e) => {
    if (!e.target.closest('.widget__tools')) closeWidgetMenus();
  });

  // 编辑态点击「主页空白处」即保存并退出编辑（除完成按钮外多一种保存方式）。
  // 网格内的空白（点在网格容器/间隙上、不在任何组件里）一律视为空白：
  // 网格里除组件外不该有任何可交互元素，无论命中什么都直接保存退出，
  // 这样海报墙右侧空列等任何网格空白都能结束编辑。
  // 网格外则按排除名单判断（地图/顶栏/侧栏/浮层/交互控件不触发）。
  // 刚拖拽完组件（onEnd 置位 dragMoved）的点击不算空白保存，避免松手即退出。
  document.addEventListener('click', (e) => {
    if (!editing) return;
    if (dragMoved) { dragMoved = false; return; }
    const t = e.target;
    if (gridEl.contains(t) && !t.closest('.widget') && !t.closest('.widget-add')
      && !t.closest('.wj-menu') && !t.closest('.wj-sheet')) { exitEdit(); return; }
    if (t.closest('.widget') || t.closest('.widget-add') || t.closest('.mapcard') || t.closest('.topbar')
      || t.closest('.sidebar') || t.closest('.wj-menu') || t.closest('.wj-sheet')
      || t.closest('#tm-edit-widgets')
      || t.closest('button, a, input, select, textarea, label')) return;
    exitEdit();   // 内部会 persistLayout() 落盘
  });

  // 列数变化（响应式）时重新 clamp 尺寸，保证不溢出。
  // ⚠️ 还要重排内容：几个模块是按「当前容器能放下多少」渲染的（最近足迹逐张试插、
  //    愿望清单同款），只改 --w/--h 不重排的话，窄屏下会留着宽屏算出的张数被裁掉。
  const reflowWidgets = debounce(() => {
    slots.forEach((s) => applySize(s));
    renderHome();
  }, 180);
  window.addEventListener('resize', reflowWidgets);

  // 首次构建网格：即使还没数据，也先摆出空态卡片；数据到达后 renderHome 填充
  buildGrid();

  return {
    setView,
    setStatus,
    renderAll,
    renderSettingsView,
    /* 打开「编辑心愿地点」弹窗（替代 travel/residence 弹窗，用于心愿地点二次编辑 / 补坐标） */
    openWishEdit,
    /* 卡片没了，但"当前选中哪个地点"仍要记着：弹窗、图钉高亮、搜索定位都读它 */
    setSelected(place) { if (state) state.selected = place; },
    getStats: computeStats,
    getView: () => currentView,
  };
}
