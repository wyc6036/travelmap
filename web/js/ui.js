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
  if (item.type === 'video' && item.poster) return item.poster;
  return item.url;
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
    img?.addEventListener('error', () => { img.src = './assets/placeholder-photo.svg'; }, { once: true });
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
  const cover = place.cover || './assets/placeholder-photo.svg';
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
  img?.addEventListener('error', () => { img.src = './assets/placeholder-photo.svg'; }, { once: true });
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

export function createUI({ onSelectPlace, onOpenDetail, onViewChange, onSearch, onOpenTrip, onAddPlace, onAddTrip }) {
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

    recentTabs: '#tm-recent-tabs',
    recentGrid: '#tm-recent-grid',
    status: '#tm-status',

    collTotal: '#tm-coll-total',
    stripCollections: '#tm-strip-collections',
    wishTotal: '#tm-wish-total',
    stripWishlist: '#tm-strip-wishlist',

    posterWall: '#tm-poster-wall',
    posterTotal: '#tm-poster-total',
    posterShuffle: '#tm-poster-shuffle',

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

  /* 旅途海报：整墙的翻牌逻辑在 js/poster.js，这里只负责喂素材池 + 桥接点击 */
  const poster = createPoster({
    root: dom.posterWall,
    onOpen: (place) => onOpenDetail?.(place),
  });
  dom.posterShuffle?.addEventListener('click', () => poster.shuffle());

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

  /* ---------- 地图视图下半区 ---------- */
  function renderRecent(mediaFilter = 'all') {
    const grid = dom.recentGrid;
    grid.innerHTML = '';
    const stats = computeStats();

    if (mediaFilter === 'all') {
      stats.past.slice(0, 3).forEach((p) => grid.append(placeCard(p, { onOpen: onOpenDetail })));
    } else {
      const items = [];
      for (const p of stats.past) {
        for (const m of p.media) if (m.type === mediaFilter) items.push({ p, m });
      }
      items.slice(0, 3).forEach(({ p, m }) => grid.append(mediaCard(m, p, { onOpen: onOpenDetail })));
      if (!items.length) {
        grid.innerHTML = emptyState(`还没有${MEDIA_LABELS[mediaFilter]}`, '在 places.json 的 media 字段里补充即可');
      }
    }

    grid.append(addTile(
      '添加新足迹',
      '点亮更多地方',
      () => toast('本项目为纯前端演示：在 places.json 里新增一条地点即可，页面 10 秒内自动同步。', 4200),
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

  function renderStrips() {
    const stats = computeStats();

    // 我的记录：最近的多媒体（图/视频/笔记各取一些，按地点时间排）
    dom.stripCollections.innerHTML = '';
    const mediaPool = [];
    for (const p of stats.past) for (const m of p.media) mediaPool.push({ p, m });
    mediaPool.slice(0, 6).forEach(({ p, m }) => {
      dom.stripCollections.append(mediaCard(m, p, { onOpen: onOpenDetail }));
    });
    if (!mediaPool.length) dom.stripCollections.innerHTML = emptyState('暂无记录', '媒体资料会出现在这里');
    dom.collTotal.textContent = `(${stats.media.total})`;

    // 愿望清单预览（原「最近旅程」条带的位置）
    dom.stripWishlist.innerHTML = '';
    const wish = wishlistPlaces();
    wish.slice(0, 6).forEach((p) => dom.stripWishlist.append(placeCard(p, { onOpen: onOpenDetail })));
    if (!wish.length) dom.stripWishlist.innerHTML = emptyState('愿望清单是空的', '把 type 设为「目的地」，或填一个未来日期');
    dom.wishTotal.textContent = `(${wish.length})`;
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
    if (!state.places.length) { root.innerHTML = emptyState('还没有足迹', '先往 places.json 里加一条'); return; }
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

  function renderCollectionsView() {
    const root = dom.viewCollections;
    const pool = [];
    for (const p of state.places) for (const m of p.media) pool.push({ p, m });

    const filtered = collMediaFilter === 'all' ? pool : pool.filter((x) => x.m.type === collMediaFilter);
    root.innerHTML = '';
    if (!filtered.length) {
      root.innerHTML = emptyState('这个分类还没有内容', '在 places.json 的 media 里补充即可');
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'mediagrid';
    filtered.forEach(({ p, m }) => grid.append(mediaCard(m, p, { onOpen: onOpenDetail })));
    root.append(grid);
  }

  function renderWishlistView() {
    const root = dom.viewWishlist;
    const list = wishlistPlaces();
    root.innerHTML = '';
    if (!list.length) {
      root.innerHTML = emptyState('愿望清单是空的', '把 type 设为「目的地」，或填一个未来日期即可');
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

  function renderSettingsView({ styleKey, onStyleChange }) {
    const root = dom.viewSettings;
    root.innerHTML = `
      <div class="sect">
        <div class="sect__title">底图样式</div>
        <div class="sect__sub">OpenFreeMap 矢量瓦片，切换后地图与弹窗小地图会同步更新</div>
      </div>
      <div class="chips" id="tm-style-chips"></div>

      <div class="sect">
        <div class="sect__title">数据</div>
        <div class="sect__sub">修改 places.json 后无需刷新，最多 10 秒地图自动同步</div>
      </div>
      <div class="metarow">
        <span class="metatag">数据文件 <b>places.json</b></span>
        <span class="metatag">国家边界 <b>world.json</b></span>
        <span class="metatag">轮询间隔 <b>10s</b></span>
        <span class="metatag">地图引擎 <b>MapLibre GL JS v5</b></span>
        <span class="metatag">投影 <b>mercator（平面）</b></span>
      </div>

      <div class="sect">
        <div class="sect__title">国家上色</div>
        <div class="sect__sub">按国家唯一键哈希取色，共 ${COLORS.visitedPalette.length} 种暖色大地色系</div>
      </div>
      <div class="metarow">
        ${COLORS.visitedPalette.map((c) => `<span class="metatag"><span class="metatag__swatch" style="background:${c}"></span><b>${c}</b></span>`).join('')}
      </div>

      <div class="sect">
        <div class="sect__title">说明</div>
      </div>
      <div class="notecard">
        本项目支持上传真实照片 / 视频 / 笔记。点「记录新足迹」新增地点并上传媒体；
        未上传媒体时该地点不显示图片，上传后自动出现。
      </div>`;

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

    renderRecent(dom.recentTabs.querySelector('.tabs__btn.is-active')?.dataset.media || 'all');
    renderStrips();

    // 海报墙：只在第一次灌满五块（之后的数据同步只换池子，不动正在看的画面，见 poster.js）
    poster.setMedia(posterPool());
    dom.posterTotal.textContent = `(${stats.media.total})`;

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

  dom.recentTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tabs__btn');
    if (!btn) return;
    dom.recentTabs.querySelectorAll('.tabs__btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    renderRecent(btn.dataset.media);
  });

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
