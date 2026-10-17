/**
 * upload.js · 新增 / 编辑地点 + 上传媒体
 * -----------------------------------------------------------
 * 提供 createAddPlace({ getMap, onSaved })：
 *   - open()  打开「记录新足迹」弹窗（新增模式）
 *   - edit(p) 打开弹窗并预填地点 p 的字段（编辑模式）：可改名称 / 类型 / 日期 /
 *             经纬度（含地图拾取）/ 国家 / 城市 / 简介，并管理已有媒体（逐条删除）
 *             与新增媒体（照片 / 视频 / 文字笔记）。
 *   - 城市输入：输入后本地库 + 在线（Nominatim）补全默认经纬度，省去手填；
 *             仍可在地图上拾取做微调。
 *
 * 不直接绑 #tm-add：那个按钮由 ui.js 统一调度，点击时调 onAddPlace 回调，
 * main.js 把回调接到 addPlace.open() / addPlace.edit()。
 */

import { api } from './api.js';
import { CITIES } from './cities.js';
import { toast } from './utils.js';

let modal, form, statusEl;
let mapGetter = () => null;
let onSaved = () => {};
let tempMarker = null;
let pickMode = false;
let pickHandler = null;
let editingId = null;            // 非 null = 编辑模式
let editingType = null;          // 编辑模式下原地点类型（下拉里已无「目的地」选项，需保留原值防误改）
let editingDefaultSelType = null;// 编辑时若原类型无法在 dropdown 表达，浏览器回落到的默认选中值
let existingMedia = [];          // 编辑模式下该地点的已有媒体（含 id）
let cityAC = null;               // 城市自动补全下拉

function $(id) { return document.getElementById(id); }

function resetForm() {
  if (form) form.reset();
  if (statusEl) statusEl.textContent = '';
  if ($('tm-add-lng')) $('tm-add-lng').value = '';
  if ($('tm-add-lat')) $('tm-add-lat').value = '';
  removeTempMarker();
  // 退出编辑态
  editingId = null;
  editingType = null;
  editingDefaultSelType = null;
  existingMedia = [];
  renderExistingMedia();
  const title = $('tm-add-title');
  if (title) title.textContent = '记录新足迹';
}

function removeTempMarker() {
  if (tempMarker) { try { tempMarker.remove(); } catch (_) {} tempMarker = null; }
}

function showStatus(msg, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('is-error', !!isError);
}

/* ---------------- 已有媒体（编辑模式） ---------------- */

function renderExistingMedia() {
  const box = $('tm-add-existing');
  if (!box) return;
  box.innerHTML = '';
  if (!editingId) { box.hidden = true; return; }
  box.hidden = false;

  const head = document.createElement('div');
  head.className = 'tm-exist__head';
  const total = existingMedia.length;
  head.innerHTML = `<span>已有媒体（${total}）</span>`
    + (total ? '<span class="tm-exist__hint">删除后即时生效</span>' : '');
  box.append(head);

  if (!total) {
    const empty = document.createElement('p');
    empty.className = 'tm-exist__empty';
    empty.textContent = '暂无媒体，可在下方继续添加。';
    box.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'tm-exist__grid';
  existingMedia.forEach((m) => {
    const cell = document.createElement('div');
    cell.className = 'tm-exist__cell';
    const isText = m.type === 'text';
    const thumb = isText ? '' : (m.type === 'video' ? (m.poster || '') : (m.url || ''));
    const inner = isText
      ? `<div class="tm-exist__text">${escapeHtml((m.caption || m.text || '文字笔记').slice(0, 50))}</div>`
      : `<img class="tm-exist__img" src="${escapeHtml(thumb || './assets/sidebar-art.svg')}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />`;
    cell.innerHTML = inner
      + `<button type="button" class="tm-exist__del" data-id="${escapeHtml(m.id)}" title="删除这条媒体" aria-label="删除媒体">`
      + '<svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-close"/></svg></button>';
    cell.querySelector('.tm-exist__del').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('确定删除这条媒体？')) return;
      const id = m.id;
      try {
        await api.deleteMedia(id);
        existingMedia = existingMedia.filter((x) => x.id !== id);
        renderExistingMedia();
        toast('已删除一条媒体', 1800);
      } catch (err) {
        toast('删除失败：' + (err.message || err), 2600);
      }
    });
    const img = cell.querySelector('img');
    if (img) img.addEventListener('error', () => { img.src = './assets/sidebar-art.svg'; });
    grid.append(cell);
  });
  box.append(grid);
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 城市自动补全（默认经纬度） ---------------- */

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function ensureCityAC() {
  if (cityAC) return cityAC;
  const city = $('tm-add-city');
  cityAC = document.createElement('div');
  cityAC.id = 'tm-city-ac';
  cityAC.className = 'tm-city-ac';
  cityAC.hidden = true;
  if (city && city.parentElement) {
    city.parentElement.style.position = 'relative';
    city.parentElement.appendChild(cityAC);
  }
  return cityAC;
}

function localMatches(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return CITIES
    .filter((c) => c.name.toLowerCase().includes(s) || (c.country || '').toLowerCase().includes(s))
    .slice(0, 8);
}

async function onlineMatches(q) {
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
    // 用 mousedown 抢在 input blur 之前，避免下拉被先关掉导致点不中
    li.addEventListener('mousedown', (e) => { e.preventDefault(); pickCity(c); });
    box.append(li);
  });
  box.hidden = false;
}

function pickCity(c) {
  if ($('tm-add-city')) $('tm-add-city').value = c.name;
  if ($('tm-add-lng')) $('tm-add-lng').value = c.lng.toFixed(5);
  if ($('tm-add-lat')) $('tm-add-lat').value = c.lat.toFixed(5);
  if (c.cc && $('tm-add-country')) $('tm-add-country').value = c.cc;
  if (cityAC) cityAC.hidden = true;
  toast(`已填入「${c.name}」默认坐标，可在地图上继续微调`, 2200);
}

const onCityInput = debounce(() => {
  const q = ($('tm-add-city')?.value || '').trim();
  if (!q) { hideCityAC(); return; }
  const base = localMatches(q);
  // 本地优先：立即渲染，绝不等在线请求（Nominatim 慢/被墙也不阻塞下拉）
  renderCityAC(base);
  // 本地不足 4 条时，后台再补在线结果；拿到才追加，失败/超时静默，且只在该次输入未变化时覆盖
  if (base.length < 4) {
    onlineMatches(q)
      .then((online) => {
        if (($('tm-add-city')?.value || '').trim() !== q) return; // 用户已继续输入，丢弃旧结果
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

function hideCityAC() { if (cityAC) cityAC.hidden = true; }

/* ---------------- 初始化 ---------------- */

export function createAddPlace({ getMap, onSaved: saved } = {}) {
  mapGetter = getMap || mapGetter;
  onSaved = saved || (() => {});

  modal = document.getElementById('tm-add-modal');
  form = document.getElementById('tm-add-form');
  statusEl = document.getElementById('tm-add-status');

  /* 关闭：遮罩 / 取消 / Esc —— 所有带 data-close="1" 的元素都绑定 */
  modal?.querySelectorAll('[data-close="1"]').forEach((el) => el.addEventListener('click', close));
  $('tm-add-cancel')?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) close();
  });

  /* 在地图上拾取坐标 */
  $('tm-add-pick')?.addEventListener('click', (e) => {
    e.preventDefault();
    startPick();
  });

  /* 城市自动补全 */
  $('tm-add-city')?.addEventListener('input', onCityInput);
  $('tm-add-city')?.addEventListener('focus', onCityInput);
  $('tm-add-city')?.addEventListener('blur', () => setTimeout(hideCityAC, 150));

  /* 提交 */
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submit();
  });

  return { open, close, edit };
}

/* ---------------- 打开 / 关闭 ---------------- */

function open() {
  if (!modal) return;
  resetForm();
  modal.hidden = false;
  $('tm-add-name')?.focus();
}

function close() {
  if (!modal) return;
  modal.hidden = true;
  cancelPick();
  hideCityAC();
  resetForm();
}

function edit(place) {
  if (!modal || !place) return;
  resetForm();
  editingId = place.id;
  existingMedia = Array.isArray(place.media) ? place.media.slice() : [];

  const set = (id, v) => { const el = $(id); if (el) el.value = (v == null ? '' : v); };
  set('tm-add-name', place.name);
  set('tm-add-type', place.type);
  /* 记录原类型：下拉已移除「目的地」选项，若原类型是「目的地」浏览器无法选中，
     会在提交时回落成其它类型，把心愿地点误改成普通足迹 —— 这里记下原值以便提交时还原。 */
  editingType = place.type;
  editingDefaultSelType = $('tm-add-type')?.value || null;
  set('tm-add-date', place.date);
  set('tm-add-enddate', place.endDate);
  const lng = place.lng != null ? place.lng : (place.coord && place.coord[0]);
  const lat = place.lat != null ? place.lat : (place.coord && place.coord[1]);
  set('tm-add-lng', lng == null ? '' : lng);
  set('tm-add-lat', lat == null ? '' : lat);
  set('tm-add-country', place.countryCode || place.country || '');
  set('tm-add-city', place.city);
  set('tm-add-desc', place.desc);

  const title = $('tm-add-title');
  if (title) title.textContent = '编辑足迹';
  renderExistingMedia();
  modal.hidden = false;
  $('tm-add-name')?.focus();
}

/* ---------------- 地图拾取 ---------------- */

function startPick() {
  const map = mapGetter();
  if (!map) {
    toast('地图尚未就绪，请手动填写经纬度', 2600);
    return;
  }
  pickMode = true;
  modal.hidden = true; // 让出地图，便于点击
  toast('点击地图任意一点以选择位置', 2600);

  const handler = (ev) => {
    const { lng, lat } = ev.lngLat;
    if ($('tm-add-lng')) $('tm-add-lng').value = lng.toFixed(5);
    if ($('tm-add-lat')) $('tm-add-lat').value = lat.toFixed(5);
    dropTempMarker(lng, lat);
    map.off('click', handler);
    pickHandler = null;
    pickMode = false;
    modal.hidden = false; // 选完回到弹窗
  };
  pickHandler = handler;
  map.on('click', handler);
}

function cancelPick() {
  const map = mapGetter();
  if (map && pickHandler) { try { map.off('click', pickHandler); } catch (_) {} }
  pickHandler = null;
  pickMode = false;
}

function dropTempMarker(lng, lat) {
  const map = mapGetter();
  if (!map || !window.maplibregl) return;
  removeTempMarker();
  const el = document.createElement('div');
  el.className = 'tm-temp-pin';
  tempMarker = new window.maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
}

/* ---------------- 提交 ---------------- */

async function submit() {
  const name = ($('tm-add-name')?.value || '').trim();
  const lng = parseFloat($('tm-add-lng')?.value);
  const lat = parseFloat($('tm-add-lat')?.value);

  if (!name) { showStatus('请填写地点名称', true); return; }
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    showStatus('请填写有效的经纬度（可地图拾取，或在城市输入后自动补全）', true);
    return;
  }

  /* 精度收敛到 5 位小数（≈1.1m）：地图拾取/在线补全可能给出更长的小数，
     入库前统一 round，避免出现 104.06573000000001 这类脏精度。 */
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const lngS = r5(lng);
  const latS = r5(lat);

  /* 编辑模式下，若原类型是下拉里已删除的「目的地」（浏览器无法选中、回落成默认项），
     且用户没手动改过类型，则还原为原类型，避免把心愿地点误改成普通足迹。 */
  const selType = $('tm-add-type')?.value || '旅行';
  const type = (editingId && editingType && editingDefaultSelType != null && selType === editingDefaultSelType)
    ? editingType
    : selType;

  const place = {
    name,
    coord: [lngS, latS],
    type,
    date: $('tm-add-date')?.value || '',
    end_date: $('tm-add-enddate')?.value || '',     // ⚠️ 后端 db 读 end_date（原 endDate 字段名是 bug）
    countryCode: ($('tm-add-country')?.value || '').trim(),
    city: ($('tm-add-city')?.value || '').trim(),
    desc: ($('tm-add-desc')?.value || '').trim(),
  };

  const files = Array.from($('tm-add-files')?.files || []);
  const caption = ($('tm-add-caption')?.value || '').trim();
  const note = ($('tm-add-note')?.value || '').trim();

  const submitBtn = $('tm-add-submit');
  if (submitBtn) { submitBtn.disabled = true; }
  showStatus(editingId ? '正在保存修改…' : '正在保存地点…');

  try {
    let id;
    if (editingId) {
      await api.updatePlace(editingId, place);
      id = editingId;
    } else {
      const created = await api.createPlace(place);
      id = created && created.id;
      if (!id) throw new Error('服务端未返回地点 ID');
    }

    let done = 0;
    const total = files.length + (note ? 1 : 0);
    if (total > 0) {
      // 照片 / 视频
      for (const file of files) {
        const fd = new FormData();
        fd.append('placeId', id);
        fd.append('file', file);
        fd.append('caption', caption);
        await api.uploadMedia(fd);
        done += 1;
        showStatus(`正在上传媒体 ${done}/${total}…`);
      }
      // 文字笔记
      if (note) {
        const fd = new FormData();
        fd.append('placeId', id);
        fd.append('kind', 'text');
        fd.append('text_body', note);
        fd.append('caption', '');
        await api.uploadMedia(fd);
        done += 1;
      }
    }

    showStatus('已保存 ✓');
    toast(editingId ? `已更新「${name}」` : `已记录「${name}」`, 2200);
    onSaved();
    setTimeout(close, 350);
  } catch (err) {
    showStatus('保存失败：' + (err.message || err), true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
