/**
 * upload-modal.js · 独立「添加媒体」弹窗
 * -----------------------------------------------------------
 * 由详情弹窗头部的「添加媒体」按钮打开（与编辑 / 删除并列）。
 * 相对旧版「在详情底部直接延伸出上传输入框」的改进：
 *   1. 这是一个正经弹窗，不再挤在媒体网格下面，视觉更清晰；
 *   2. 支持多选 + 拖拽，且每条文件都能单独重命名（caption）；
 *   3. 上传时用 XHR 的 upload.onprogress 显示「整体进度条 + 每条状态」，
 *      多文件也能看清传到哪儿了；传完自动刷新详情媒体的网格。
 *
 * 对外：createUploadModal({ onAdded }) → { open(placeId, placeName) }
 *   - onAdded：每成功添加一次（文件或笔记）后回调，用于让详情弹窗刷新网格。
 */

import { api } from './api.js';
import { toast } from './utils.js';

let modal, titleEl, dropEl, fileInput, listEl, noteEl, noteCapEl,
    progressEl, progressFill, progressLabel, uploadBtn, cancelBtn, statusEl;
let placeId = null;
let files = [];                 // [{ file, name, status, hint }]
let onAdded = () => {};

const STATUS_TEXT = {
  ready: '待上传',
  uploading: '上传中…',
  done: '已上传',
  error: '失败',
};

function $(id) { return document.getElementById(id); }

export function createUploadModal({ onAdded: added } = {}) {
  onAdded = added || (() => {});

  modal = $('tm-upload-modal');
  if (!modal) return { open() {} };

  titleEl = $('tm-upload-title');
  dropEl = $('tm-upload-drop');
  fileInput = $('tm-upload-input');
  listEl = $('tm-upload-list');
  noteEl = $('tm-upload-note');
  noteCapEl = $('tm-upload-notecap');
  progressEl = $('tm-upload-progress');
  progressFill = $('tm-upload-fill');
  progressLabel = $('tm-upload-progress-label');
  uploadBtn = $('tm-upload-go');
  cancelBtn = $('tm-upload-cancel');
  statusEl = $('tm-upload-status');

  /* 点拖拽区 = 触发文件选择 */
  dropEl.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  /* 拖拽：阻止浏览器默认「打开文件」，并给个视觉态 */
  ['dragenter', 'dragover'].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.add('is-drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dropEl.addEventListener(ev, (e) => { e.preventDefault(); dropEl.classList.remove('is-drag'); }));
  dropEl.addEventListener('drop', (e) => addFiles(e.dataTransfer?.files));

  uploadBtn.addEventListener('click', startUpload);
  cancelBtn.addEventListener('click', close);
  modal.querySelectorAll('[data-close="1"]').forEach((el) => el.addEventListener('click', close));
  modal.addEventListener('click', (e) => { if (e.target.closest('[data-close="1"]')) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) close();
  });

  return { open };
}

/* ---------------- 打开 / 关闭 ---------------- */

function open(id, name) {
  if (!modal) return;
  placeId = id;
  if (titleEl) titleEl.textContent = `添加媒体到「${name || '地点'}」`;
  reset();
  modal.hidden = false;
}

function close() {
  if (!modal) return;
  modal.hidden = true;
}

function reset() {
  files = [];
  renderList();
  if (noteEl) noteEl.value = '';
  if (noteCapEl) noteCapEl.value = '';
  if (progressEl) progressEl.hidden = true;
  if (progressFill) progressFill.style.width = '0%';
  if (progressLabel) progressLabel.textContent = '';
  setStatus('');
  setUploading(false);
}

function setStatus(msg, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('is-error', !!isError);
}

function setUploading(on) {
  if (uploadBtn) uploadBtn.disabled = on;
  if (cancelBtn) cancelBtn.disabled = on;
  if (fileInput) fileInput.disabled = on;
  dropEl?.classList.toggle('is-busy', on);
}

/* ---------------- 文件选择与列表 ---------------- */

function addFiles(fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return;
  for (const f of arr) {
    const base = (f.name || '').replace(/\.[^.]+$/, '') || '未命名';
    files.push({ file: f, name: base, status: 'ready', hint: '' });
  }
  renderList();
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function renderList() {
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('p');
    empty.className = 'upload__empty';
    empty.textContent = '还没有选择文件';
    listEl.append(empty);
    return;
  }
  files.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'upload__row';
    row.dataset.idx = String(idx);

    /* 预览：图片用本地 objectURL，视频用图标 */
    const prev = document.createElement('div');
    prev.className = 'upload__prev';
    if (item.file.type.startsWith('image/')) {
      const img = document.createElement('img');
      const url = URL.createObjectURL(item.file);
      img.src = url;
      img.onload = () => URL.revokeObjectURL(url);
      img.onerror = () => { img.remove(); prev.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><use href="#i-image"/></svg>'; };
      prev.append(img);
    } else if (item.file.type.startsWith('video/')) {
      prev.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><use href="#i-video"/></svg>';
    } else {
      prev.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><use href="#i-note"/></svg>';
    }

    /* 名称（可重命名）+ 类型/大小 */
    const nameWrap = document.createElement('div');
    nameWrap.className = 'upload__name';
    const input = document.createElement('input');
    input.className = 'form-input upload__name-input';
    input.value = item.name;
    input.placeholder = '文件名（可重命名）';
    input.maxLength = 80;
    input.addEventListener('input', () => { item.name = input.value; });
    const meta = document.createElement('div');
    meta.className = 'upload__meta';
    meta.textContent = `${item.file.type || '文件'} · ${formatSize(item.file.size)}`;
    nameWrap.append(input, meta);

    /* 状态 */
    const st = document.createElement('div');
    st.className = 'upload__st';
    st.textContent = statusText(item);

    /* 移除 */
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'upload__rm';
    rm.title = '移除';
    rm.setAttribute('aria-label', '移除');
    rm.innerHTML = '<svg class="ico ico--sm" viewBox="0 0 24 24"><use href="#i-close"/></svg>';
    rm.addEventListener('click', () => { if (uploadBtn.disabled) return; files.splice(idx, 1); renderList(); });

    row.append(prev, nameWrap, st, rm);
    listEl.append(row);
  });
}

function statusText(item) {
  if (item.status === 'done' && item.hint) return item.hint;
  return STATUS_TEXT[item.status] || '';
}

function setRowStatus(idx, status, hint) {
  const row = listEl?.querySelector(`.upload__row[data-idx="${idx}"]`);
  if (!row) return;
  if (status) row.dataset.status = status;
  const st = row.querySelector('.upload__st');
  if (st) {
    if (status) files[idx].status = status;
    if (typeof hint === 'string') files[idx].hint = hint;
    st.textContent = statusText(files[idx]);
  }
}

function setOverallProgress(doneCount, fraction, total) {
  if (!progressFill) return;
  const pct = total > 0 ? Math.round(((doneCount + Math.max(0, Math.min(1, fraction))) / total) * 100) : 0;
  progressFill.style.width = pct + '%';
  if (progressLabel) progressLabel.textContent = `${Math.min(doneCount + (fraction > 0 ? 1 : 0), total)} / ${total} · ${pct}%`;
}

/* ---------------- 上传 ---------------- */

async function startUpload() {
  const note = (noteEl?.value || '').trim();
  const noteCap = (noteCapEl?.value || '').trim();
  const hasFiles = files.length > 0;
  const hasNote = !!note;
  if (!hasFiles && !hasNote) { setStatus('请先选择文件，或写点文字笔记', true); return; }
  if (!placeId) return;

  setUploading(true);
  setStatus('正在上传…');
  if (progressEl) progressEl.hidden = false;

  let addedAny = false;
  try {
    /* 文字笔记（无文件时也能单独传） */
    if (hasNote) {
      const fd = new FormData();
      fd.append('placeId', placeId);
      fd.append('kind', 'text');
      fd.append('text_body', note);
      fd.append('caption', noteCap);
      await api.uploadMedia(fd);
      addedAny = true;
      toast('已添加文字笔记', 1600);
    }

    /* 文件：逐条上传以拿到真实进度 */
    let done = 0;
    for (let i = 0; i < files.length; i += 1) {
      const item = files[i];
      setRowStatus(i, 'uploading');
      setOverallProgress(done, 0, files.length);
      try {
        const r = await uploadOne(item, i, files.length);
        if (r && r.status === 'processing') setRowStatus(i, 'done', '已上传 · 转码中');
        else setRowStatus(i, 'done');
        addedAny = true;
      } catch (e) {
        setRowStatus(i, 'error');
        setStatus('部分文件上传失败：' + (e.message || e), true);
      }
      done += 1;
      setOverallProgress(done, 0, files.length);
    }

    if (addedAny) {
      setStatus('全部上传完成 ✓');
      toast('已添加媒体', 2200);
      onAdded();
      /* 清空文件列表（保留笔记框供继续添加），让弹窗回到「可继续添加」状态 */
      files = [];
      renderList();
      if (noteEl) noteEl.value = '';
      if (noteCapEl) noteCapEl.value = '';
    }
  } finally {
    setUploading(false);
  }
}

/**
 * 用 XMLHttpRequest 上传单文件，以便拿到 upload.onprogress 真实进度。
 * fetch 没有上传进度事件，所以这里不用 api.uploadMedia。
 * @returns {Promise<{status?:string}>} 解析时返回服务端响应（含 status，视频为 processing）
 */
function uploadOne(item, index, total) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('placeId', placeId);
    fd.append('file', item.file);
    fd.append('caption', (item.name || '').trim());

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.withCredentials = true;       // 带上 httpOnly 会话 cookie
    xhr.upload.onprogress = (e) => {
      const frac = e.lengthComputable ? e.loaded / e.total : 0;
      setOverallProgress(index, frac, total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let j = null;
        try { j = JSON.parse(xhr.responseText); } catch (_) { /* 忽略非 JSON */ }
        resolve(j || {});
      } else {
        let msg = '上传失败';
        try { const j = JSON.parse(xhr.responseText); if (j && j.error) msg = j.error; } catch (_) { /* 忽略 */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.onabort = () => reject(new Error('已取消'));
    xhr.send(fd);
  });
}
