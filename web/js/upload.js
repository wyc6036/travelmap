/**
 * upload.js · 新增地点 + 上传媒体
 * -----------------------------------------------------------
 * 提供 createAddPlace({ getMap, onSaved })：
 *   - open()   打开「记录新足迹」弹窗
 *   - 表单：名称 / 类型 / 日期 / 经纬度（可点地图拾取）/ 国家代码 / 城市 / 简介
 *   - 媒体：多文件（照片 / 视频）+ 文字笔记，提交后依次上传到 /api/upload
 *   - 保存成功后调用 onSaved()（main.js 用它立即刷新数据，不必等轮询）
 *
 * 不直接绑 #tm-add：那个按钮由 ui.js 统一调度，点击时调 onAddPlace 回调，
 * main.js 把回调接到 addPlace.open()。
 */

import { api } from './api.js';
import { toast } from './utils.js';

let modal, form, statusEl;
let mapGetter = () => null;
let onSaved = () => {};
let tempMarker = null;
let pickMode = false;
let pickHandler = null;

function $(id) { return document.getElementById(id); }

function resetForm() {
  if (form) form.reset();
  if (statusEl) statusEl.textContent = '';
  if ($('tm-add-lng')) $('tm-add-lng').value = '';
  if ($('tm-add-lat')) $('tm-add-lat').value = '';
  removeTempMarker();
}

function removeTempMarker() {
  if (tempMarker) { try { tempMarker.remove(); } catch (_) {} tempMarker = null; }
}

function showStatus(msg, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('is-error', !!isError);
}

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

  /* 提交 */
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submit();
  });

  return { open, close };
}

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
  resetForm();
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
    showStatus('请填写有效的经纬度（可在地图上拾取）', true);
    return;
  }

  const place = {
    name,
    coord: [lng, lat],
    type: $('tm-add-type')?.value || '旅行',
    date: $('tm-add-date')?.value || '',
    endDate: $('tm-add-enddate')?.value || '',
    countryCode: ($('tm-add-country')?.value || '').trim(),
    city: ($('tm-add-city')?.value || '').trim(),
    desc: ($('tm-add-desc')?.value || '').trim(),
  };

  const files = Array.from($('tm-add-files')?.files || []);
  const caption = ($('tm-add-caption')?.value || '').trim();
  const note = ($('tm-add-note')?.value || '').trim();

  const submitBtn = $('tm-add-submit');
  if (submitBtn) { submitBtn.disabled = true; }
  showStatus('正在保存地点…');

  try {
    const created = await api.createPlace(place);
    const id = created && created.id;
    if (!id) throw new Error('服务端未返回地点 ID');

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
    toast(`已记录「${name}」`, 2600);
    onSaved();
    setTimeout(close, 350);
  } catch (err) {
    showStatus('保存失败：' + (err.message || err), true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
