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
import {
  escapeHtml, formatDateDot, formatDateRange, countUp, toast,
} from './utils.js';
/* 统计页拆到独立模块（内容多、且几乎全是自绘图表，混在本文件里不好维护）。
   这里只做"注入依赖 + 桥接事件"，图表本身一行都不在 ui.js 里。 */
import { renderStatsView as renderStatsPanel } from './stats.js';
/* 图例 / 统计页的类型标记都用地图上那枚图钉（同一份字形，来自 markers.js 的 pinSvg） */
import { pinSvg } from './markers.js';
/* 地图页右列的「旅途海报」墙（多张同时陈列 + 各自随机翻牌） */
import { createPoster } from './poster.js';

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

/** 地点卡（用于「最近足迹」条带与愿望清单） */
function placeCard(place, { onOpen }) {
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
  btn.innerHTML = `
    <div class="mcard__media">
      <img src="${escapeHtml(cover)}" alt="${escapeHtml(place.name)}"
           loading="lazy" decoding="async" referrerpolicy="no-referrer" />
      ${place.mediaCount.video ? `<span class="mcard__badge">${icon('video', 'ico ico--sm')}${place.mediaCount.video}</span>` : ''}
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

export function createUI({ onSelectPlace, onOpenDetail, onOpenPhoto, onViewChange, onSearch, onOpenTrip, onAddPlace, onAddTrip, onOpenArchive }) {
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

  /* ---------- 地图视图下半区（Widget 用：接收目标容器） ---------- */
  function paintRecent(grid, mediaFilter = 'all') {
    if (!grid) return;
    grid.innerHTML = '';
    const stats = computeStats();

    if (mediaFilter === 'all') {
      stats.past.slice(0, 6).forEach((p) => grid.append(placeCard(p, { onOpen: onOpenDetail })));
    } else {
      const items = [];
      for (const p of stats.past) {
        for (const m of p.media) if (m.type === mediaFilter) items.push({ p, m });
      }
      items.slice(0, 6).forEach(({ p, m }) => grid.append(mediaCard(m, p, { onOpen: onOpenPhoto })));
      if (!items.length) {
        grid.innerHTML = emptyState(`还没有${MEDIA_LABELS[mediaFilter]}`, '打开地点详情，用「添加媒体」上传即可');
      }
    }

    /* 与顶栏「新增」共用同一入口：main.js 把 onAddPlace 接到 addPlace.open()（新增/编辑足迹弹窗）。
       ⚠️ 这里曾是前端壳子时代的演示 toast（"改 places.json 即可"），后端化之后忘了换，别再回退。 */
    grid.append(addTile(
      '添加新足迹',
      '点亮更多地方',
      () => (typeof onAddPlace === 'function' ? onAddPlace() : toast('新增足迹功能未就绪', 2600)),
    ));
  }

  /* ---------- 旅途海报的素材池 ----------
     全部地点里的照片 + 视频（笔记没有画面，不进池）。
     ⚠️ 每条都要带上 place：点某一块要能直接开到那个地点。
     ⚠️ 视频优先用 poster 封面（有封面就完全不用加载视频文件），
        没有封面的才交给 js/poster.js 用 <video> 取首帧。 */
  function posterPool() {
    const out = [];
    (state?.places || []).forEach((p) => {
      p.media.forEach((m) => {
        if (m.type !== 'image' && m.type !== 'video') return;
        out.push({
          kind: m.type,
          src: m.url,
          poster: m.type === 'video' ? (m.poster || '') : '',
          place: p,
          media: m,
          title: p.name,
          sub: p.date ? formatDateRange(p.date, p.endDate) : (p.countryZh || ''),
        });
      });
    });
    return out;
  }

  /* ---------- 愿望清单口径 ----------
     三处共用（地图页预览条带 / 愿望清单视图 / 计数），抽出来避免两处口径漂移：
     未来日期（计划） + 未标注日期 + 类型为「目的地」的，去重后按日期升序。
     ⚠️ 未标注日期的排在最后（key 取 Infinity）：它们没有"先后"，混在中间会让顺序看着随机。 */
  function wishlistPlaces() {
    const stats = computeStats();
    const seen = new Set();
    return [...stats.future, ...stats.undated, ...state.places.filter((p) => p.type === '目的地')]
      .filter((p) => !seen.has(p.id) && seen.add(p.id))
      .sort((a, b) => (a.dateTs || Infinity) - (b.dateTs || Infinity));
  }

  function paintWishlist(stripEl, totalEl) {
    const wish = wishlistPlaces();
    (stripEl || (stripEl = document.createElement('div'))).innerHTML = '';
    wish.slice(0, 6).forEach((p) => stripEl.append(placeCard(p, { onOpen: onOpenDetail })));
    if (!wish.length) stripEl.innerHTML = emptyState('愿望清单是空的', '新增足迹时把类型选「目的地」，或填一个未来日期');
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

  function renderWishlistView() {
    const root = dom.viewWishlist;
    const list = wishlistPlaces();
    root.innerHTML = '';
    if (!list.length) {
      root.innerHTML = emptyState('愿望清单是空的', '新增足迹时把类型选「目的地」，或填一个未来日期即可');
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'mediagrid';
    list.forEach((p) => grid.append(placeCard(p, { onOpen: onOpenDetail })));
    root.append(grid);
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
  const DEFAULT_LAYOUT = [
    { type: 'recent', size: '2x1' },
    { type: 'wishlist', size: '1x1' },
    { type: 'collections', size: '1x1' },
    { type: 'poster', size: '2x2' },
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

  /* 已实现的 4 个组件 + 4 个占位（第二阶段） */
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
    wishlist: {
      title: '愿望清单', defaultSize: '1x1',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">愿望清单</h3>
          <button class="link" data-view="wishlist">查看全部 <span class="muted" data-role="total">(0)</span>
            <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
          </button>`;
        body.classList.add('strip');
        head.querySelector('[data-view="wishlist"]').addEventListener('click', () => setView('wishlist'));
        return {
          update() {
            const wish = wishlistPlaces();
            body.innerHTML = '';
            wish.slice(0, 6).forEach((p) => body.append(placeCard(p, { onOpen: onOpenDetail })));
            if (!wish.length) body.innerHTML = emptyState('愿望清单是空的', '新增足迹时把类型选「目的地」，或填一个未来日期');
            head.querySelector('[data-role="total"]').textContent = `(${wish.length})`;
          },
        };
      },
    },
    collections: {
      title: '我的记录', defaultSize: '1x1',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">我的记录</h3>
          <button class="link" data-view="collections">查看全部 <span class="muted" data-role="total">(0)</span>
            <svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-arrow"/></svg>
          </button>`;
        body.classList.add('strip');
        head.querySelector('[data-view="collections"]').addEventListener('click', () => setView('collections'));
        return {
          update() {
            const stats = computeStats();
            const pool = [];
            for (const p of stats.past) for (const m of p.media) pool.push({ p, m });
            body.innerHTML = '';
            pool.slice(0, 6).forEach(({ p, m }) => body.append(mediaCard(m, p, { onOpen: onOpenPhoto })));
            if (!pool.length) body.innerHTML = emptyState('暂无记录', '媒体资料会出现在这里');
            head.querySelector('[data-role="total"]').textContent = `(${stats.media.total})`;
          },
        };
      },
    },
    poster: {
      title: '旅途海报', defaultSize: '2x2',
      mount(head, body) {
        head.innerHTML = `
          <h3 class="card__title">旅途海报</h3>
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
            posterApi.setMedia(posterPool());
            const stats = computeStats();
            head.querySelector('[data-role="total"]').textContent = `(${stats.media.total})`;
          },
          destroy() { posterApi.destroy(); },
        };
      },
    },
    // —— 以下 4 个新组件第二阶段实现，先占位（comingSoon，替换弹窗里置灰）——
    pending:     { title: '待整理照片', defaultSize: '1x1', comingSoon: true },
    lastTrip:    { title: '最近一次旅行', defaultSize: '2x1', comingSoon: true },
    roulette:    { title: '抽签下一站', defaultSize: '1x1', comingSoon: true },
    month:       { title: '你最爱几月出发', defaultSize: '2x1', comingSoon: true },
  };

  const gridEl = document.getElementById('tm-widget-grid');
  const editBtn = document.getElementById('tm-edit-widgets');
  const resetBtn = document.getElementById('tm-reset-layout');
  let layout = loadLayout() || DEFAULT_LAYOUT.map((s) => ({ ...s }));
  let editing = false;
  let slots = [];
  let dragMoved = false;   // 刚结束拖拽时为 true，避免拖完组件后的点击被当成"点空白保存"
  let sortable = null;

  function loadLayout() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return null;
      return arr.filter((s) => WIDGET_DEFS[s.type] && !WIDGET_DEFS[s.type].comingSoon);
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
      if (!def || def.comingSoon) return;
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
  }
  function addSlot(type = 'recent', size) {
    const def = WIDGET_DEFS[type];
    if (!def || def.comingSoon) return;
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

  /* 替换 / 新增 底部弹窗（列出全部组件，未实现的置灰） */
  const sheet = document.getElementById('tm-widget-sheet');
  const sheetMask = document.getElementById('tm-widget-sheet-mask');
  const sheetBody = document.getElementById('tm-widget-sheet-body');
  const sheetTitle = document.getElementById('tm-widget-sheet-title');
  let sheetTarget = null; // 替换目标 rec；为 null 表示新增

  function openWidgetSheet(rec) {
    sheetTarget = rec || null;
    sheetTitle.textContent = rec ? '替换组件' : '新增组件';
    sheetBody.innerHTML = Object.entries(WIDGET_DEFS).map(([type, def]) => `
      <button type="button" class="wj-sheet__item${def.comingSoon ? ' is-disabled' : ''}" data-type="${type}" ${def.comingSoon ? 'disabled' : ''}>
        <span class="wj-sheet__name">${def.title}</span>
        <span class="wj-sheet__size">${def.defaultSize}${def.comingSoon ? ' · 即将推出' : ''}</span>
      </button>`).join('');
    sheetBody.querySelectorAll('button[data-type]').forEach((b) => {
      if (b.disabled) return;
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
        closeWidgetSheet();
      });
    });
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
    if (gridEl.contains(t) && !t.closest('.widget')
      && !t.closest('.wj-menu') && !t.closest('.wj-sheet')) { exitEdit(); return; }
    if (t.closest('.widget') || t.closest('.mapcard') || t.closest('.topbar')
      || t.closest('.sidebar') || t.closest('.wj-menu') || t.closest('.wj-sheet')
      || t.closest('#tm-edit-widgets')
      || t.closest('button, a, input, select, textarea, label')) return;
    exitEdit();   // 内部会 persistLayout() 落盘
  });

  // 列数变化（响应式）时重新 clamp 尺寸，保证不溢出
  window.addEventListener('resize', () => { slots.forEach((s) => applySize(s)); });

  // 首次构建网格：即使还没数据，也先摆出空态卡片；数据到达后 renderHome 填充
  buildGrid();

  return {
    setView,
    setStatus,
    renderAll,
    renderSettingsView,
    /* 卡片没了，但"当前选中哪个地点"仍要记着：弹窗、图钉高亮、搜索定位都读它 */
    setSelected(place) { if (state) state.selected = place; },
    getStats: computeStats,
    getView: () => currentView,
  };
}
