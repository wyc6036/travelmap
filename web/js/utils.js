/**
 * utils.js · 通用工具函数
 * -----------------------------------------------------------
 * 无依赖、纯函数为主，便于单独测试。
 */

/** HTML 转义（所有插入 innerHTML 的用户数据都必须过这一层） */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** #RRGGBB / #RGB → rgba(r,g,b,a) */
export function hexToRgba(hex, alpha = 1) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return `rgba(46,68,96,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/**
 * 把颜色与目标色混合（t=0 取原色，t=1 取目标色），返回 `rgb(...)`。
 *
 * 用途：图钉主体色由 types 数据驱动（居住/旅行/目的地…），hover 需要的"提亮色"
 * 没法在 CSS 里预先写死 —— 数据里加一个类型就得多写一个色值。
 * 统一在这里从类型色派生，CSS 侧只认 `--pin-body-lift` 一个变量。
 *
 * 输入不合法时原样返回，调用方不必写异常分支。
 */
export function mixHex(hex, target = '#FFFFFF', t = 0.16) {
  const parse = (value) => {
    let s = String(value ?? '').trim().replace('#', '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length !== 6) return null;
    const n = parseInt(s, 16);
    if (!Number.isFinite(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const from = parse(hex);
  const to = parse(target);
  if (!from || !to) return hex;
  const k = clamp(Number(t) || 0, 0, 1);
  const mixed = from.map((v, i) => Math.round(v + (to[i] - v) * k));
  return `rgb(${mixed[0]},${mixed[1]},${mixed[2]})`;
}

/**
 * FNV-1a 32 位字符串哈希。
 * 用途：国家唯一键 → 稳定的调色板下标（同一国家永远同色，与数据顺序无关）。
 */
export function hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function clamp(v, min, max) {
  return v < min ? min : (v > max ? max : v);
}

/** 帧节流：滚动/拖拽等高频事件里使用 */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  return function throttled(...args) {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn.apply(this, lastArgs);
    });
  };
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/** 创建元素的小助手 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
}

/** 查询助手 */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 日期解析：兼容 YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY-MM / YYYY。
 * 返回 { raw, y, m, d, ts, valid }，无法解析时 ts = null。
 */
export function parseDate(input) {
  const raw = String(input ?? '').trim();
  const out = { raw, y: null, m: null, d: null, ts: null, valid: false };
  if (!raw) return out;
  const m = raw.match(/^(\d{4})(?:[-/.年](\d{1,2}))?(?:[-/.月](\d{1,2}))?/);
  if (!m) return out;
  out.y = Number(m[1]);
  out.m = m[2] ? Number(m[2]) : null;
  out.d = m[3] ? Number(m[3]) : null;
  const ts = Date.UTC(out.y, (out.m || 1) - 1, out.d || 1);
  if (Number.isFinite(ts)) { out.ts = ts; out.valid = true; }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

/** 2024-04-01 → 2024.04.01（效果图里的日期写法） */
export function formatDateDot(input) {
  const d = parseDate(input);
  if (!d.valid) return '';
  return `${d.y}.${pad(d.m || 1)}.${pad(d.d || 1)}`;
}

/** 日期区间：2024.04.01 - 2024.04.06（同月/同年做简写） */
export function formatDateRange(start, end) {
  const a = parseDate(start);
  const b = parseDate(end);
  if (!a.valid) return '';
  if (!b.valid) return formatDateDot(start);
  if (a.y === b.y && a.m === b.m) return `${formatDateDot(start)} - ${pad(b.d || 1)}`;
  if (a.y === b.y) return `${formatDateDot(start)} - ${pad(b.m || 1)}.${pad(b.d || 1)}`;
  return `${formatDateDot(start)} - ${formatDateDot(end)}`;
}

/** 两点球面距离（公里） */
export function distanceKm(lng1, lat1, lng2, lat2) {
  const R = 6371;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 数字滚动动画（统计卡里用），尊重 prefers-reduced-motion */
export function countUp(node, to, { duration = 900, decimals = 0 } = {}) {
  if (!node) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const target = Number(to) || 0;
  const from = Number(node.dataset.value || 0);
  node.dataset.value = String(target);

  if (reduce || duration <= 0 || from === target) {
    node.textContent = target.toFixed(decimals);
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const p = clamp((now - t0) / duration, 0, 1);
    const eased = 1 - (1 - p) ** 3;                    // easeOutCubic
    node.textContent = (from + (target - from) * eased).toFixed(decimals);
    if (p < 1) requestAnimationFrame(step);
    else node.textContent = target.toFixed(decimals);
  };
  requestAnimationFrame(step);
}

/** 轻量 toast */
let toastTimer = null;
export function toast(message, ms = 2200) {
  let node = document.getElementById('tm-toast');
  if (!node) {
    node = el('div', { class: 'toast', id: 'tm-toast' });
    document.body.append(node);
  }
  node.textContent = message;
  node.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-on'), ms);
}

/** 取对象里第一个命中的键（数据层对未知字段容错时使用） */
export function pick(obj, keys, fallback = undefined) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

/** 只在控制台提示一次，避免轮询/瓦片失败时刷屏 */
const warned = new Set();
export function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[TravelMap] ${message}`);
}
