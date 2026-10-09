/**
 * stats.js · 统计页
 * -----------------------------------------------------------
 * 图**全部手写 SVG / HTML**，不引第三方图表库 ——
 * 与项目其余部分保持一致（无框架、无构建工具），也才能完全贴合设计令牌。
 *
 * ⚠️ 这里是 ui.js 的**下游**：只接受 ui.js 注入的 { stats, state, onGoPlace, pinGlyph }，
 *    绝不 import ui.js（否则 stats ↔ ui 会形成循环依赖）。需要 ui 的能力就通过回调传进来。
 *
 * 版面（.panels 用 grid-template-areas，2/3/4 列各有自己的排布）：
 *   KPI 条 · 世界探索度 · 足迹构成 · 足迹年轮 · 媒体构成 · 国家排行 · 出发的季节 · 里程碑
 *
 * 交互一览（"轻交互"是有意为之：不需要点开任何东西就能读到结论）：
 *   ① KPI 数字滚动（复用 utils.countUp）+ 卡面 hover 抬起
 *   ② 世界探索度：环形进度从"空环"扫到目标值（CSS keyframes，几何在 JS 算）
 *   ③ 足迹构成：hover / 点击图例 → 对应扇区变暗，圆心数字切换成该类型的数量与名称
 *   ④ 足迹年轮：hover 出 tooltip（各类型构成 + 城市清单）；**点击柱子筛选该年**，
 *      下方展开那一年的足迹芯片，芯片可点 → 跳地图定位；再点一次取消
 *   ⑤ 媒体构成：100% 堆叠条从 0 撑开，行 hover 高亮
 *   ⑥ 国家排行：hover 出该国城市清单，**点击 → 切到地图并定位**
 *   ⑦ 出发的季节：12 个月热力格，格子深浅 = 出发次数，hover 抬起
 *   ⑧ 全页共享一枚 tooltip（.stattip），文案在渲染时算好，事件里只查表
 *
 * 入场动画一律走 CSS @keyframes（静态值就是终态），**不在这里加类名** ——
 * 见 css/components.css 顶部那段注释，那里说明了为什么不用「初始态 + .is-in」。
 *
 * ⚠️ 所有数据来源（地点名 / 国家名 / 类型名 / 色值）都必须过 escapeHtml 再进模板，
 *    这个文件里全是 innerHTML 模板字符串 —— 漏一层就是 XSS，漏一个闭合标签就会"吞"掉后面的内容
 *    （后者本项目已经栽过一次，改完务必跑 tm-dom-health.mjs）。
 *    反向也成立：**写进 textContent 的值不要再 escapeHtml**，那会显示成 &amp; 之类的实体。
 */

import { MEDIA_LABELS } from './config.js';
import {
  escapeHtml, formatDateDot, countUp, distanceKm, mixHex, clamp,
} from './utils.js';

/** 与 ui.js 里的同名 helper 一致（不跨模块 import 是为了避免 stats ↔ ui 循环依赖） */
const icon = (name, cls = 'ico') => `<svg class="${cls}" viewBox="0 0 24 24"><use href="#i-${name}"/></svg>`;

const MEDIA_ORDER = ['image', 'video', 'text'];
const MONTH_LABELS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

/** 环形进度：viewBox 132×132、r=56、描边 12 → 周长 */
const RING_R = 56;
const RING_C = 2 * Math.PI * RING_R;

/** 圆角的数字格式（千分位） */
const fmtNum = (n) => Number(n || 0).toLocaleString('zh-CN');

/** 里程：超过 1 万公里改用「万公里」，否则几千公里也读得出来 */
function fmtKm(km) {
  if (km >= 10000) return `${(km / 10000).toFixed(1)} 万公里`;
  return `${Math.round(km).toLocaleString('zh-CN')} 公里`;
}

/* =========================================================
 * 统计模型
 * ========================================================= */
function buildModel(stats, state) {
  const { places } = state;
  const past = stats.past;

  /* ---- 年份 × 类型（供堆叠柱状图） ---- */
  const typeTotals = {};
  places.forEach((p) => { typeTotals[p.type] = (typeTotals[p.type] || 0) + 1; });
  const typeEntries = Object.entries(typeTotals).sort((a, b) => b[1] - a[1]);
  /** 堆叠顺序：数量多的压在下面（柱状图更稳），固定顺序保证各年配色一一对应 */
  const stackOrder = typeEntries.map(([t]) => t);

  const years = [...stats.byYear.entries()]
    .filter(([y]) => y > 0)
    .map(([year, list]) => {
      const byType = {};
      list.forEach((p) => { byType[p.type] = (byType[p.type] || 0) + 1; });
      return { year, list, byType, total: list.length };
    })
    .sort((a, b) => a.year - b.year);

  const maxYearTotal = Math.max(1, ...years.map((y) => y.total));
  const avgYearTotal = years.length
    ? years.reduce((s, y) => s + y.total, 0) / years.length
    : 0;
  const busiest = years.slice().sort((a, b) => b.total - a.total)[0] || null;

  /* ---- 国家 / 地区排行 ---- */
  const byCountryMap = new Map();
  places.forEach((p) => {
    const key = p.countryZh || p.country || '未归属国家';
    if (!byCountryMap.has(key)) byCountryMap.set(key, { name: key, list: [] });
    byCountryMap.get(key).list.push(p);
  });
  const countries = [...byCountryMap.values()]
    .map((c) => {
      const media = c.list.reduce((s, p) => s + p.mediaCount.total, 0);
      const dated = c.list.filter((p) => p.dateTs).sort((a, b) => a.dateTs - b.dateTs);
      return { ...c, media, first: dated[0] || null, last: dated[dated.length - 1] || null };
    })
    .sort((a, b) => b.list.length - a.list.length || a.name.localeCompare(b.name, 'zh'));
  const maxCountryCount = Math.max(1, ...countries.map((c) => c.list.length));

  /* ---- 按月分布 ---- */
  const months = new Array(12).fill(0);
  past.forEach((p) => {
    const m = new Date(p.dateTs).getMonth();
    if (m >= 0 && m < 12) months[m] += 1;
  });
  const maxMonth = Math.max(1, ...months);

  /* ---- 累计里程（按时间顺序连点） ---- */
  const chrono = past.slice().sort((a, b) => a.dateTs - b.dateTs);
  let km = 0;
  for (let i = 1; i < chrono.length; i += 1) {
    km += distanceKm(chrono[i - 1].lng, chrono[i - 1].lat, chrono[i].lng, chrono[i].lat);
  }

  /* ---- 里程碑 ---- */
  const firstTrip = chrono[0] || null;
  const lastTrip = chrono[chrono.length - 1] || null;
  const mostMedia = places.slice().sort((a, b) => b.mediaCount.total - a.mediaCount.total)[0] || null;

  /* ---- 探索度里程碑（每 5% 一档，给一句"还差几个"） ---- */
  const total = Math.max(1, state.countryTotal || 1);
  const nextStep = Math.ceil((stats.pct + 0.0001) / 5) * 5;
  const needForNext = Math.max(
    1,
    Math.ceil((nextStep / 100) * total) - stats.countries,
  );

  return {
    stats,
    past,
    places,
    typeEntries,
    stackOrder,
    years,
    maxYearTotal,
    avgYearTotal,
    busiest,
    countries,
    maxCountryCount,
    months,
    maxMonth,
    km,
    firstTrip,
    lastTrip,
    mostMedia,
    nextStep: nextStep > 100 ? 100 : nextStep,
    needForNext,
    countryTotal: total,
  };
}

/* =========================================================
 * 各面板
 * ========================================================= */

/** 顶部 KPI 条 */
function kpiStrip(m) {
  const md = m.stats.media;
  /* 初始文案统一写 '0'：countUp 从 dataset.value（首次为 0）滚到目标值，
     若这里直接写终值，动画会先把数字"抹"回 0 再涨上来，反而闪。 */
  const items = [
    { key: 'countries', name: '国家 / 地区', ico: 'globe', sub: `占世界 ${m.stats.pct.toFixed(1)}%` },
    { key: 'cities', name: '城市 / 地点', ico: 'pin', sub: `${m.typeEntries.length} 种地点类型` },
    { key: 'trips', name: '次旅行', ico: 'route', sub: m.stats.tripsList ? '按 trips 字段计' : '按到访记录计' },
    { key: 'media', name: '多媒体', ico: 'image', sub: `${md.image} 照片 · ${md.video} 视频` },
  ];
  return `<div class="kpis">${
    items.map((it) => `
      <div class="kpi">
        <span class="kpi__ico">${icon(it.ico)}</span>
        <span class="kpi__txt">
          <span class="kpi__num" data-kpi="${it.key}">0</span>
          <span class="kpi__label">${escapeHtml(it.name)}</span>
          <span class="kpi__sub">${escapeHtml(it.sub)}</span>
        </span>
      </div>`).join('')
  }</div>`;
}

/** ① 世界探索度 */
function explorePanel(m) {
  const pct = clamp(m.stats.pct, 0, 100);
  const offset = RING_C * (1 - pct / 100);
  const span = m.lastTrip && m.firstTrip ? Math.max(1, m.lastTrip.year - m.firstTrip.year + 1) : 0;

  const facts = [
    { ico: 'route', big: fmtKm(m.km), sub: '按时间顺序连点累计的直线里程' },
    { ico: 'calendar', big: span ? `${span} 年` : '—', sub: m.firstTrip ? `${m.firstTrip.year} 年第一次远行` : '暂无带日期的足迹' },
    { ico: 'target', big: `还差 ${m.needForNext} 个`, sub: `到下一个里程碑 ${m.nextStep}%` },
  ];

  return `
    <section class="panel panel--explore">
      <div class="panel__head">
        <h3 class="panel__title">世界探索度</h3>
        <p class="panel__sub">按 ${m.countryTotal} 个国家 / 地区计算</p>
      </div>
      <div class="panel__body explore">
        <div class="ring">
          <svg class="ring__svg" viewBox="0 0 132 132" aria-hidden="true">
            <defs>
              <linearGradient id="tm-ring-grad" x1="0" y1="0" x2="1" y2="1">
                <stop class="ring__stop-a" offset="0"/>
                <stop class="ring__stop-b" offset="1"/>
              </linearGradient>
            </defs>
            <circle class="ring__track" cx="66" cy="66" r="${RING_R}"/>
            <circle class="ring__fill" cx="66" cy="66" r="${RING_R}"
              transform="rotate(-90 66 66)"
              stroke-dasharray="${RING_C.toFixed(2)}"
              style="--ring-c:${RING_C.toFixed(2)};--ring-off:${offset.toFixed(2)}"/>
          </svg>
          <div class="ring__center">
            <span class="ring__val">
              <span class="ring__num" data-kpi="pct" data-decimals="1">0</span><span class="ring__unit">%</span>
            </span>
            <span class="ring__cap">已点亮</span>
          </div>
        </div>
        <div class="explore__side">
          <p class="explore__lead">
            已经走过 <b>${m.stats.countries}</b> 个国家 / 地区，
            相当于世界的 <b>${pct.toFixed(1)}%</b>。
          </p>
          <ul class="explore__facts">${
            facts.map((f) => `
              <li>
                <span class="explore__ico">${icon(f.ico, 'ico ico--sm')}</span>
                <span class="explore__txt"><b>${escapeHtml(f.big)}</b><span>${escapeHtml(f.sub)}</span></span>
              </li>`).join('')
          }</ul>
        </div>
      </div>
    </section>`;
}

/** ② 类型构成（环形图 + 可点图例） */
function typePanel(m) {
  const total = m.places.length || 1;
  let acc = 0;
  const segs = m.typeEntries.map(([type, n], i) => {
    const frac = n / total;
    const seg = {
      type, n, i,
      color: state_color(type),
      frac,
      pct: frac * 100,
      dash: `${(frac * RING_T_C).toFixed(2)} ${RING_T_C.toFixed(2)}`,
      off: (-acc * RING_T_C).toFixed(2),
    };
    acc += frac;
    return seg;
  });

  return `
    <section class="panel panel--type">
      <div class="panel__head">
        <h3 class="panel__title">足迹构成</h3>
        <p class="panel__sub">按地点类型，可点选高亮</p>
      </div>
      <div class="panel__body typebox">
        <div class="typebox__ring">
          <svg class="donut" viewBox="0 0 132 132" aria-hidden="true">
            <circle class="donut__track" cx="66" cy="66" r="${RING_T_R}"/>
            <g transform="rotate(-90 66 66)">${
              segs.map((s) => `<circle class="donut__seg" data-type="${escapeHtml(s.type)}"
                cx="66" cy="66" r="${RING_T_R}" stroke="${escapeHtml(s.color)}"
                stroke-dasharray="${s.dash}" stroke-dashoffset="${s.off}"
                style="--i:${s.i}"/>`).join('')
            }</g>
          </svg>
          <div class="typebox__center">
            <span class="typebox__num" id="tm-type-num">${total}</span>
            <span class="typebox__cap" id="tm-type-cap">个地点</span>
          </div>
        </div>
        <div class="typebox__legend" role="group" aria-label="按类型高亮">${
          segs.map((s) => `
            <button type="button" class="typekey" data-type="${escapeHtml(s.type)}" data-tipkey="t-${escapeHtml(s.type)}">
              <span class="typekey__pin">${pinGlyph(s.color)}</span>
              <span class="typekey__name">${escapeHtml(s.type)}</span>
              <span class="typekey__val">${s.n} · ${s.pct.toFixed(1)}%</span>
            </button>`).join('')
        }</div>
      </div>
    </section>`;
}

/** ③ 足迹年轮（交互堆叠柱状图） */
function yearsPanel(m) {
  if (!m.years.length) {
    return `
      <section class="panel panel--years">
        <div class="panel__head"><h3 class="panel__title">足迹年轮</h3></div>
        <div class="panel__body"><p class="muted">还没有带年份的足迹 —— 新增足迹时填好出发日期，就会在这里长出年轮。</p></div>
      </section>`;
  }

  const H_MIN = 6;    // 只去过 1 个地方的年份也要看得见
  const H_MAX = 96;   // 顶部留 4% 给数值标签，不然最高那根柱子的数字会被顶出画布
  /** 归一化柱高（百分比，相对 .years__plot 的高度） */
  const barH = (n) => H_MIN + (n / m.maxYearTotal) * (H_MAX - H_MIN);

  const bars = m.years.map((y, i) => {
    /* column-reverse：DOM 里第一个是**柱子的最底下**一段。
       ⚠️ 高度写在 .ybar 的 --h 上，而不是柱子本身：柱顶的数值标签
          （.ybar__cap）要按同一个 --h 定位到柱子正上方，两者必须同源。 */
    const segs = m.stackOrder
      .filter((t) => y.byType[t])
      .map((t) => {
        const share = (y.byType[t] / y.total) * 100;
        return `<i class="ybar__seg" style="height:${share.toFixed(2)}%;background:${
          escapeHtml(state_color(t))}"></i>`;
      }).join('');
    return `
      <button type="button" class="ybar" data-year="${y.year}" data-tipkey="y-${y.year}"
              style="--h:${barH(y.total).toFixed(2)}%;--d:${Math.min(i * 45, 540)}ms"
              aria-label="${y.year} 年，${y.total} 个地点">
        <span class="ybar__stack">${segs}</span>
        <span class="ybar__cap" aria-hidden="true">${y.total}</span>
      </button>`;
  }).join('');

  const avgTop = 100 - barH(m.avgYearTotal);
  const busiestTxt = m.busiest
    ? `最高产的是 ${m.busiest.year} 年，一年走了 ${m.busiest.total} 个地方`
    : '';
  /* 年份多到标签会撞在一起时，只画隔一个的标签。
     空字符串照样占一个 flex 槽位，所以下面的柱子与标签仍然一一对齐。 */
  const labelStep = m.years.length > 10 ? 2 : 1;

  return `
    <section class="panel panel--years">
      <div class="panel__head">
        <h3 class="panel__title">足迹年轮</h3>
        <p class="panel__sub">颜色为类型 · 点击柱子可筛选该年的足迹</p>
      </div>
      <div class="panel__body">
        <div class="years" id="tm-years">
          <div class="years__plot">
            <div class="years__grid" aria-hidden="true"></div>
            <div class="years__avg" style="top:${clamp(avgTop, 0, 100).toFixed(1)}%">
              <span>年均 ${m.avgYearTotal.toFixed(1)}</span>
            </div>
            <div class="years__bars">${bars}</div>
          </div>
          <div class="years__labels">${
            m.years.map((y, i) => `<span class="years__x">${i % labelStep === 0 ? y.year : ''}</span>`).join('')
          }</div>
        </div>
        <div class="years__detail" id="tm-years-detail">
          <p class="years__hint">
            ${icon('target', 'ico ico--sm')} 点击任意柱子，这里会列出那一年的足迹${busiestTxt ? ` · ${escapeHtml(busiestTxt)}` : ''}
          </p>
        </div>
      </div>
    </section>`;
}

/** ④ 媒体构成（100% 堆叠条） */
function mediaPanel(m) {
  const total = m.stats.media.total || 1;
  const rows = MEDIA_ORDER.map((k) => ({
    key: k,
    label: MEDIA_LABELS[k],
    n: m.stats.media[k],
    pct: (m.stats.media[k] / total) * 100,
    color: MEDIA_COLORS[k],
  }));

  return `
    <section class="panel panel--media">
      <div class="panel__head">
        <h3 class="panel__title">媒体构成</h3>
        <p class="panel__sub">共 ${fmtNum(m.stats.media.total)} 项记录</p>
      </div>
      <div class="panel__body">
        <div class="mediabar" role="img"
             aria-label="照片 ${rows[0].n} 项，视频 ${rows[1].n} 项，笔记 ${rows[2].n} 项">
          ${rows.map((r) => `
            <span class="mediabar__seg" data-tipkey="m-${r.key}"
                  style="--w:${r.pct.toFixed(2)}%;background:${r.color}"></span>`).join('')}
        </div>
        <ul class="mediakeys">${
          rows.map((r) => `
            <li class="mediakey" data-tipkey="m-${r.key}">
              <span class="mediakey__dot" style="background:${r.color}"></span>
              <span class="mediakey__name">${escapeHtml(r.label)}</span>
              <span class="mediakey__val">${fmtNum(r.n)}</span>
              <span class="mediakey__pct">${r.pct.toFixed(1)}%</span>
            </li>`).join('')
        }</ul>
      </div>
    </section>`;
}

/** ⑤ 国家 / 地区排行 */
function countryPanel(m) {
  const top = m.countries.slice(0, 6);
  return `
    <section class="panel panel--country">
      <div class="panel__head">
        <h3 class="panel__title">国家 / 地区</h3>
        <p class="panel__sub">按地点数排序 · 点击可在地图上定位</p>
      </div>
      <div class="panel__body">
        <ul class="crank">${
          top.map((c) => {
            const w = (c.list.length / m.maxCountryCount) * 100;
            const target = c.list.slice().sort((a, b) => b.mediaCount.total - a.mediaCount.total)[0];
            return `
              <li class="crank__row">
                <button type="button" class="crank__btn" data-place="${escapeHtml(target.id)}"
                        data-tipkey="c-${escapeHtml(c.name)}" title="在地图上定位${escapeHtml(c.name)}">
                  <span class="crank__name">${escapeHtml(c.name)}</span>
                  <span class="crank__track"><span class="crank__fill" style="--w:${w.toFixed(1)}%"></span></span>
                  <span class="crank__val">${c.list.length}</span>
                </button>
              </li>`;
          }).join('')
        }</ul>
        ${m.countries.length > top.length
    ? `<p class="panel__note">另有 ${m.countries.length - top.length} 个国家 / 地区各 1 个地点，可在「足迹」页查看全部。</p>`
    : ''}
      </div>
    </section>`;
}

/** ⑥ 出发的季节 */
function seasonPanel(m) {
  const cells = m.months.map((n, i) => {
    const t = n / m.maxMonth;
    const strong = t >= 0.6;
    const bg = n === 0
      ? 'var(--surface-3)'
      : mixHex('#DDE5F0', '#7C9CC3', 0.3 + 0.7 * t);
    return `
      <div class="season__cell${n === 0 ? ' is-empty' : ''}${strong ? ' is-strong' : ''}"
           style="background:${bg}" data-tipkey="s-${i}"
           title="${MONTH_LABELS[i]}：${n} 次出发">
        <span class="season__n">${n || ''}</span>
      </div>`;
  }).join('');

  const peak = m.months.indexOf(Math.max(...m.months));
  return `
    <section class="panel panel--season">
      <div class="panel__head">
        <h3 class="panel__title">出发的季节</h3>
        <p class="panel__sub">${m.maxMonth > 1 ? `最爱在 ${MONTH_LABELS[peak]} 出发` : '按月统计的出发次数'}</p>
      </div>
      <div class="panel__body">
        <div class="season">${cells}</div>
        <div class="season__axis">${
          MONTH_LABELS.map((l) => `<span>${l.replace('月', '')}</span>`).join('')
        }</div>
      </div>
    </section>`;
}

/** ⑦ 里程碑 */
function milestonePanel(m) {
  const items = [
    m.firstTrip && {
      ico: 'star', k: '第一次远行', v: m.firstTrip.name, sub: formatDateDot(m.firstTrip.date),
    },
    m.lastTrip && {
      ico: 'pin', k: '最近一次', v: m.lastTrip.name, sub: formatDateDot(m.lastTrip.date),
    },
    m.mostMedia && {
      ico: 'image', k: '记录最多', v: m.mostMedia.name, sub: `${m.mostMedia.mediaCount.total} 项多媒体`,
    },
    m.busiest && {
      ico: 'chart', k: '最高产的一年', v: `${m.busiest.year} 年`, sub: `${m.busiest.total} 个地点`,
    },
  ].filter(Boolean);

  if (!items.length) return '';
  return `
    <section class="panel panel--mile">
      <div class="panel__head"><h3 class="panel__title">里程碑</h3></div>
      <div class="panel__body milestone">${
        items.map((it) => `
          <div class="milestone__item">
            <span class="milestone__ico">${icon(it.ico, 'ico ico--sm')}</span>
            <span class="milestone__k">${escapeHtml(it.k)}</span>
            <span class="milestone__v">${escapeHtml(it.v)}</span>
            <span class="milestone__sub">${escapeHtml(it.sub)}</span>
          </div>`).join('')
      }</div>
    </section>`;
}

/* =========================================================
 * 工具
 * ========================================================= */

/** 类型环形图的半径 / 周长（与 hero 环形分开，避免一个改动牵连两处几何） */
const RING_T_R = 52;
const RING_T_C = 2 * Math.PI * RING_T_R;

/** 媒体三色的固定语义色（沿用项目主色系，不占类型色） */
const MEDIA_COLORS = {
  image: '#7C9CC3',
  video: '#E3C98F',
  text: '#B9C6A6',
};

/* 类型 → 颜色。renderStatsView 每次渲染时注入，避免把 state 穿到每个面板函数里 */
let state_color = () => '#7C9CC3';

/** 类型标记直接复用地图上那枚图钉（几何来自 markers.js 的 pinSvg，见那边的注释） */
let pinGlyph = () => '';

/** tooltip：key → HTML，渲染时填好，事件里只做查表 */
const tips = new Map();

function tipList(places, limit = 6) {
  const shown = places.slice(0, limit);
  const rest = places.length - shown.length;
  return `<ul class="stattip__list">${
    shown.map((p) => `<li>${escapeHtml(p.name)}<span>${
      escapeHtml(p.date ? formatDateDot(p.date) : p.type)}</span></li>`).join('')
  }${rest > 0 ? `<li class="stattip__more">… 还有 ${rest} 个</li>` : ''}</ul>`;
}

/* =========================================================
 * 挂载
 * ========================================================= */
/**
 * @param {HTMLElement} root  #tm-view-stats
 * @param {object} ctx
 * @param {object} ctx.stats  ui.js computeStats() 的结果
 * @param {object} ctx.state  ui.js 的内部 state（places / types / colorOf / countryTotal …）
 * @param {(place:object)=>void} ctx.onGoPlace 点击国家排行 / 年份芯片 → 跳地图定位
 * @param {(color:string)=>string} ctx.pinGlyph 生成图钉 SVG；**入参是该类型的色值**
 *        而不是类型名 —— 调用处（typePanel）手上只有色值，再回查一次类型纯属多余。
 *        实现由 ui.js 从 markers.js 的 pinSvg 注入，保证与地图上是同一份字形。
 */
export function renderStatsView(root, { stats, state, onGoPlace, pinGlyph: glyph }) {
  state_color = (t) => state.colorOf({ type: t });
  pinGlyph = typeof glyph === 'function' ? glyph : () => '';

  if (!state.places.length) {
    root.innerHTML = '<p class="muted" style="padding:8px 2px">还没有任何地点数据。</p>';
    return;
  }

  const m = buildModel(stats, state);

  /* ---- tooltip 文案：一次算好，事件里只查表，避免每次移动都拼字符串 ---- */
  tips.clear();
  m.years.forEach((y) => {
    const breakdown = m.stackOrder
      .filter((t) => y.byType[t])
      .map((t) => `${escapeHtml(t)} ${y.byType[t]}`).join(' · ');
    tips.set(`y-${y.year}`, `<b>${y.year} 年</b><span>${y.total} 个地点 · ${breakdown}</span>${tipList(y.list)}`);
  });
  m.typeEntries.forEach(([t, n]) => {
    const list = m.places.filter((p) => p.type === t);
    tips.set(`t-${t}`, `<b>${escapeHtml(t)}</b><span>${n} 个地点 · ${(n / m.places.length * 100).toFixed(1)}%</span>${tipList(list)}`);
  });
  m.countries.slice(0, 6).forEach((c) => {
    tips.set(`c-${c.name}`, `<b>${escapeHtml(c.name)}</b><span>${c.list.length} 个地点${
      c.first ? ` · 首访 ${c.first.year}` : ''}</span>${tipList(c.list)}`);
  });
  MEDIA_ORDER.forEach((k) => {
    const n = m.stats.media[k];
    const share = m.stats.media.total ? (n / m.stats.media.total * 100).toFixed(1) : '0.0';
    tips.set(`m-${k}`, `<b>${escapeHtml(MEDIA_LABELS[k])}</b><span>${n} 项 · 占 ${share}%</span>`);
  });
  m.months.forEach((n, i) => {
    const list = m.past.filter((p) => new Date(p.dateTs).getMonth() === i);
    tips.set(`s-${i}`, `<b>${MONTH_LABELS[i]}</b><span>${n} 次出发</span>${
      n ? tipList(list, 4) : '<ul class="stattip__list"><li>没有在这个月出发过</li></ul>'}`);
  });

  /* ---- 渲染 ---- */
  root.innerHTML = kpiStrip(m)
    + '<div class="panels">'
    + explorePanel(m)
    + typePanel(m)
    + yearsPanel(m)
    + mediaPanel(m)
    + countryPanel(m)
    + seasonPanel(m)
    + milestonePanel(m)
    + '</div>'
    + '<div class="stattip" id="tm-stattip" hidden></div>';

  /* ---- 数字滚动 ---- */
  root.querySelectorAll('[data-kpi]').forEach((node) => {
    const key = node.dataset.kpi;
    const decimals = Number(node.dataset.decimals || 0);
    const to = key === 'pct' ? m.stats.pct
      : (key === 'media' ? m.stats.media.total : m.stats[key]);
    countUp(node, to, { decimals });
  });

  /* ---- 入场动画 ----
     这里**不加任何类名**：所有"从 0 长出来"的图形都用 CSS @keyframes 的
     backwards 填充模式实现（见 css/components.css 顶部注释），元素插入文档即播放。
     好处是静态样式就是正确终态 —— 这段 JS 万一没跑到，图表也只是不animate，
     不会整块停在 opacity:0 / 高度 0。 */
  enableTips(root);
  bindYearFilter(root, m, onGoPlace);
  bindTypeHighlight(root, m);
  bindCountryJump(root, m, onGoPlace);
}

/* =========================================================
 * 交互
 * ========================================================= */

/** 共享 tooltip：hover 到任何带 data-tipkey 的元素时浮出 */
function enableTips(root) {
  const tip = root.querySelector('#tm-stattip');
  if (!tip) return;

  const show = (target) => {
    const html = tips.get(target.dataset.tipkey);
    if (!html) return;
    tip.innerHTML = html;
    tip.hidden = false;
    /* 先显示再量尺寸，否则 offsetWidth 是 0，定位会飘 */
    const rr = root.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = tr.left - rr.left + tr.width / 2 - tw / 2;
    let y = tr.top - rr.top - th - 10;
    if (y < 0) y = tr.bottom - rr.top + 10;              // 上方放不下就翻到下方
    x = clamp(x, 4, Math.max(4, root.clientWidth - tw - 4));
    /* 用 --tx/--ty 而不是直接改 left/top：定位交给 CSS 的 transform，避免触发布局抖动 */
    tip.style.setProperty('--tx', `${Math.round(x)}px`);
    tip.style.setProperty('--ty', `${Math.round(y)}px`);
  };

  const hide = () => { tip.hidden = true; };

  root.querySelectorAll('[data-tipkey]').forEach((el) => {
    el.addEventListener('mouseenter', () => show(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('mouseleave', hide);
    el.addEventListener('blur', hide);
  });
}

/** 年份柱：点击筛选；芯片可点 → 跳地图 */
function bindYearFilter(root, m, onGoPlace) {
  const bars = [...root.querySelectorAll('.ybar')];
  const detail = root.querySelector('#tm-years-detail');
  const plotWrap = root.querySelector('.years');
  if (!bars.length || !detail) return;

  let selected = null;

  const renderDetail = () => {
    const row = m.years.find((y) => y.year === selected);
    if (!row) {
      const busiestTxt = m.busiest
        ? `最高产的是 ${m.busiest.year} 年，一年走了 ${m.busiest.total} 个地方`
        : '';
      detail.innerHTML = `<p class="years__hint">${icon('target', 'ico ico--sm')} 点击任意柱子，这里会列出那一年的足迹${
        busiestTxt ? ` · ${escapeHtml(busiestTxt)}` : ''}</p>`;
      return;
    }
    const chips = row.list
      .slice()
      .sort((a, b) => a.dateTs - b.dateTs)
      .map((p) => `
        <button type="button" class="ycard" data-place="${escapeHtml(p.id)}">
          <span class="ycard__dot" style="background:${escapeHtml(state_color(p.type))}"></span>
          <span class="ycard__name">${escapeHtml(p.name)}</span>
          <span class="ycard__meta">${escapeHtml(p.countryZh || p.type)}${
  p.date ? ` · ${escapeHtml(formatDateDot(p.date))}` : ''}</span>
        </button>`).join('');
    detail.innerHTML = `
      <div class="years__detailhead">
        <b>${row.year} 年</b>
        <span>${row.total} 个地点 · ${m.stackOrder.filter((t) => row.byType[t])
    .map((t) => `${escapeHtml(t)} ${row.byType[t]}`).join(' · ')}</span>
      </div>
      <div class="years__cards">${chips}</div>`;
    detail.querySelectorAll('[data-place]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = m.places.find((x) => x.id === b.dataset.place);
        if (p) onGoPlace?.(p);
      });
    });
  };

  bars.forEach((bar) => {
    bar.addEventListener('click', () => {
      const y = Number(bar.dataset.year);
      selected = selected === y ? null : y;
      bars.forEach((b) => {
        const on = Number(b.dataset.year) === selected;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', String(on));
      });
      plotWrap?.classList.toggle('has-selection', selected !== null);
      renderDetail();
    });
  });
}

/** 类型环形图：hover / 点击图例 → 高亮扇区并把圆心数字切成该类型 */
function bindTypeHighlight(root, m) {
  const keys = [...root.querySelectorAll('.typekey')];
  const segs = [...root.querySelectorAll('.donut__seg')];
  const numEl = root.querySelector('#tm-type-num');
  const capEl = root.querySelector('#tm-type-cap');
  const total = m.places.length;
  if (!keys.length) return;

  let locked = null;

  const apply = (active) => {
    keys.forEach((k) => {
      const on = k.dataset.type === active;
      k.classList.toggle('is-active', on);
      k.classList.toggle('is-dim', active !== null && !on);
    });
    segs.forEach((s) => s.classList.toggle('is-dim', active !== null && s.dataset.type !== active));
    const row = m.typeEntries.find(([t]) => t === active);
    if (numEl) numEl.textContent = row ? String(row[1]) : String(total);
    /* ⚠️ textContent **不要**过 escapeHtml：那是给 innerHTML 用的，
       这里会把「居住」原样写成「居住」倒还好，但类型名里只要有 & < " 就会显示成实体。 */
    if (capEl) capEl.textContent = row ? row[0] : '个地点';
  };

  const activate = (t) => apply(locked ?? t);

  keys.forEach((k) => {
    k.addEventListener('mouseenter', () => activate(k.dataset.type));
    k.addEventListener('mouseleave', () => apply(locked));
    k.addEventListener('click', () => {
      locked = locked === k.dataset.type ? null : k.dataset.type;
      apply(locked);
    });
  });
  segs.forEach((s) => {
    s.addEventListener('mouseenter', () => activate(s.dataset.type));
    s.addEventListener('mouseleave', () => apply(locked));
  });
}

/** 国家排行：点击 → 交给 ui.js 切到地图并定位 */
function bindCountryJump(root, m, onGoPlace) {
  root.querySelectorAll('.crank__btn[data-place]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = m.places.find((x) => x.id === btn.dataset.place);
      if (p) onGoPlace?.(p);
    });
  });
}
