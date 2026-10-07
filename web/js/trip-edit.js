/**
 * trip-edit.js · 新建行程组（多地点行程）
 * -----------------------------------------------------------
 * 提供 createAddTrip({ getPlaces, onSaved })：
 *   - open()   打开「新建行程」弹窗，列出当前所有地点供勾选
 *   - 表单：行程名称 / 日期 / 勾选参与地点（≥1 个）
 *   - 提交后调用 api.createTrip({ name, date, places:[ids] })
 *   - 成功后 onSaved()（main.js 用它立即刷新数据，不必等轮询）
 *
 * 不直接绑 #tm-trip：那个按钮由 ui.js 统一调度，点击时调 onAddTrip 回调，
 * main.js 把回调接到 addTrip.open()。
 */

import { api } from './api.js';
import { toast } from './utils.js';

let modal, form, statusEl, placesBox;
let placeGetter = () => [];
let onSaved = () => {};

function $(id) { return document.getElementById(id); }

function resetForm() {
  if (form) form.reset();
  if (statusEl) statusEl.textContent = '';
  if (placesBox) placesBox.innerHTML = '';
}

function showStatus(msg, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('is-error', !!isError);
}

function renderPlaces() {
  if (!placesBox) return;
  const places = Array.isArray(placeGetter()) ? placeGetter() : [];
  placesBox.innerHTML = '';
  if (!places.length) {
    placesBox.innerHTML = '<p class="tm-trip-empty">还没有任何地点。请先通过「记录新足迹」添加地点，再来编行程。</p>';
    return;
  }
  // 按名称排序，便于查找
  const sorted = [...places].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
  for (const p of sorted) {
    const id = p.id || '';
    const label = document.createElement('label');
    label.className = 'tm-trip-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = id;
    cb.className = 'tm-trip-cb';
    const name = document.createElement('span');
    name.className = 'tm-trip-name';
    name.textContent = p.name || '未命名';
    const meta = document.createElement('span');
    meta.className = 'tm-trip-meta';
    meta.textContent = [p.type, p.date].filter(Boolean).join(' · ');
    label.append(cb, name, meta);
    placesBox.appendChild(label);
  }
}

export function createAddTrip({ getPlaces, onSaved: saved } = {}) {
  placeGetter = getPlaces || placeGetter;
  onSaved = saved || (() => {});

  modal = document.getElementById('tm-trip-modal');
  form = document.getElementById('tm-trip-form');
  statusEl = document.getElementById('tm-trip-status');
  placesBox = document.getElementById('tm-trip-places');

  /* 关闭：遮罩 / 取消 / Esc —— 所有带 data-close="1" 的元素都绑定 */
  modal?.querySelectorAll('[data-close="1"]').forEach((el) => el.addEventListener('click', close));
  $('tm-trip-cancel')?.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) close();
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
  renderPlaces();
  modal.hidden = false;
  $('tm-trip-name')?.focus();
}

function close() {
  if (!modal) return;
  modal.hidden = true;
  resetForm();
}

/* ---------------- 提交 ---------------- */

async function submit() {
  const name = ($('tm-trip-name')?.value || '').trim();
  const date = $('tm-trip-date')?.value || '';
  const ids = placesBox
    ? Array.from(placesBox.querySelectorAll('.tm-trip-cb:checked')).map((cb) => cb.value).filter(Boolean)
    : [];

  if (!name) { showStatus('请填写行程名称', true); return; }
  if (!ids.length) { showStatus('请至少勾选一个地点', true); return; }

  const submitBtn = $('tm-trip-submit');
  if (submitBtn) submitBtn.disabled = true;
  showStatus('正在保存行程…');

  try {
    const created = await api.createTrip({ name, date, places: ids });
    if (!created) throw new Error('服务端未确认');
    showStatus('已保存 ✓');
    toast(`已创建行程「${name}」`, 2600);
    onSaved();
    setTimeout(close, 350);
  } catch (err) {
    showStatus('保存失败：' + (err.message || err), true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
