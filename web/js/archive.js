/**
 * archive.js · 批量照片归类（按 GPS 自动建地点）
 * -----------------------------------------------------------
 * 三步：分析 → 预览（可改）→ 确认归档。
 *   - 分析：POST /api/gps/analyze（只读），后端逐张逆地理编码 + 聚类，返回方案预览。
 *   - 预览：每簇可改名、可勾选「跳过」；「归入已有」的簇不可改名（地点已定）。
 *   - 确认：POST /api/gps/apply，按 edited 方案落库。
 * 另含「上传零散照片」：先以 placeId='' 上传，照片进入未归类状态，之后再来分析。
 */

import { api } from './api.js';
import { toast } from './utils.js';

export function createArchive({ onSaved } = {}) {
  const modal = document.getElementById('tm-archive-modal');
  const body = document.getElementById('tm-archive-body');
  const foot = document.getElementById('tm-archive-foot');
  const scatterModal = document.getElementById('tm-scatter-modal');

  let analysis = null;   // 最近一次 analyze 结果
  let edited = null;     // 可编辑方案，与 analysis.clusters 平行
  let busy = false;
  let scatterFiles = [];

  /* ---------------- 打开 / 关闭 ---------------- */
  function open() {
    modal.hidden = false;
    renderStart();
  }
  function close() {
    modal.hidden = true;
    analysis = null;
    edited = null;
  }

  /* ---------------- 开始态 ---------------- */
  function renderStart(msg) {
    foot.innerHTML = '';
    body.innerHTML = `
      <div class="arch-intro">
        <p>把还没归类到地点的照片，按每张照片自带的 GPS 坐标自动识别所在城市、聚成地点。</p>
        <ul class="arch-points">
          <li>逐张反查城市（离线 GeoNames，无需联网）；可在设置填高德 key 换取更准中文名</li>
          <li>距已有地点 ≤50km 直接归入；其余按距离聚成新地点</li>
          <li>先看预览、可改名 / 跳过，确认后才写入</li>
        </ul>
      </div>
      <div class="arch-actions">
        <button class="btn btn--primary" id="tm-arch-analyze" type="button">分析未归类照片</button>
        <button class="btn" id="tm-arch-scatter" type="button">上传零散照片</button>
      </div>
      ${msg ? `<p class="form-status is-error">${escapeHtml(msg)}</p>` : ''}
    `;
    body.querySelector('#tm-arch-analyze').addEventListener('click', doAnalyze);
    body.querySelector('#tm-arch-scatter').addEventListener('click', openScatter);
  }

  async function doAnalyze() {
    if (busy) return;
    busy = true;
    const btn = body.querySelector('#tm-arch-analyze');
    if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }
    try {
      const r = await api.gpsAnalyze();
      analysis = r;
      if (!r.geocodeReady) {
        renderStart('城市库未就绪：逆地理编码不可用。请确认镜像内已包含 GeoNames 数据（重新构建镜像）。');
        return;
      }
      if (r.total === 0) { renderEmpty(); return; }
      renderPreview();
    } catch (e) {
      renderStart(e.message || '分析失败');
    } finally {
      busy = false;
    }
  }

  /* ---------------- 空态 ---------------- */
  function renderEmpty() {
    foot.innerHTML = '';
    body.innerHTML = `
      <div class="arch-empty">
        <p>没有「未归类」的照片。</p>
        <p class="muted">先把照片通过「上传零散照片」导入（暂不归类），再来分析；或直接在某地点里添加媒体。</p>
      </div>
      <div class="arch-actions">
        <button class="btn btn--primary" id="tm-arch-scatter2" type="button">上传零散照片</button>
        <button class="btn" id="tm-arch-back" type="button">返回</button>
      </div>`;
    body.querySelector('#tm-arch-scatter2').addEventListener('click', openScatter);
    body.querySelector('#tm-arch-back').addEventListener('click', renderStart);
  }

  /* ---------------- 预览态 ---------------- */
  function renderPreview() {
    const r = analysis;
    // 初始化可编辑方案：每个簇一个动作（归入已有 / 新建；可改后转 skip）
    edited = r.clusters.map((c) => ({
      id: c.id,
      action: c.kind === 'existing' ? 'assign' : 'create',
      name: c.name,
      countryCode: c.countryCode,
      city: c.city,
      center: c.center,
      minDate: c.minDate,
      maxDate: c.maxDate,
      existingPlaceId: c.existingPlaceId || null,
      mediaIds: c.media.map((m) => m.id),
    }));

    const newN = r.clusters.filter((c) => c.kind === 'new').length;
    const exN = r.clusters.filter((c) => c.kind === 'existing').length;
    body.innerHTML = `
      <div class="arch-summary">
        共 <b>${r.total}</b> 张未归类照片：含 GPS <b>${r.withGps}</b> 张，识别为
        <b>${r.clusters.length}</b> 个地点（<b>${newN}</b> 个新建 / <b>${exN}</b> 个归入已有）；
        无 GPS <b>${r.noGps}</b> 张需手动指派。
      </div>
      <div class="arch-clusters" id="tm-arch-clusters"></div>
      ${r.noGps ? `<div class="arch-nogps">
        <div class="arch-nogps__title">无 GPS 的照片（${r.noGps} 张）</div>
        <div class="arch-nogps__grid">${r.unassigned.map(thumbHtml).join('')}</div>
        <p class="muted">这些照片没有坐标，无法自动归类，可在对应地点里手动「添加媒体」。</p>
      </div>` : ''}
    `;
    const list = body.querySelector('#tm-arch-clusters');
    r.clusters.forEach((c, i) => list.append(clusterCard(c, i)));

    foot.innerHTML = `
      <button class="btn btn--ghost" id="tm-arch-reanalyze" type="button">重新分析</button>
      <button class="btn btn--primary" id="tm-arch-apply" type="button">确认归档</button>
    `;
    foot.querySelector('#tm-arch-reanalyze').addEventListener('click', doAnalyze);
    foot.querySelector('#tm-arch-apply').addEventListener('click', doApply);
  }

  function clusterCard(c, i) {
    const el = document.createElement('div');
    el.className = 'arch-cluster arch-cluster--' + c.kind;
    const mediaHtml = c.media.slice(0, 14).map(thumbHtml).join('');
    const more = c.media.length > 14 ? `<span class="arch-cluster__more">+${c.media.length - 14}</span>` : '';
    const dateRange = (c.minDate || c.maxDate)
      ? `<span class="arch-cluster__date">${fmtDate(c.minDate)} ~ ${fmtDate(c.maxDate)}</span>` : '';
    el.innerHTML = `
      <div class="arch-cluster__head">
        <span class="arch-cluster__badge">${c.kind === 'existing' ? '归入已有' : '新建地点'}</span>
        <input class="form-input arch-cluster__name" type="text" value="${escapeHtml(c.name)}" maxlength="40" ${c.kind === 'existing' ? 'disabled' : ''}>
        ${dateRange}
        <span class="arch-cluster__count">${c.mediaCount} 张</span>
      </div>
      <div class="arch-cluster__thumbs">${mediaHtml}${more}</div>
      ${c.kind === 'new' ? `<label class="arch-cluster__skip"><input type="checkbox" data-skip="${i}"> 跳过这簇（不归档）</label>` : ''}
    `;
    const nameInput = el.querySelector('.arch-cluster__name');
    nameInput.addEventListener('input', () => { if (edited[i]) edited[i].name = nameInput.value; });
    const skip = el.querySelector('[data-skip]');
    if (skip) skip.addEventListener('change', () => { if (edited[i]) edited[i].action = skip.checked ? 'skip' : 'create'; });
    return el;
  }

  function thumbHtml(m) {
    const src = m.thumb_url || m.url || './assets/sidebar-art.svg';
    const isVideo = m.kind === 'video';
    return `<div class="arch-thumb"><img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">${isVideo ? '<span class="arch-thumb__video">▶</span>' : ''}</div>`;
  }

  /* ---------------- 确认归档 ---------------- */
  async function doApply() {
    if (busy) return;
    busy = true;
    const btn = foot.querySelector('#tm-arch-apply');
    if (btn) { btn.disabled = true; btn.textContent = '归档中…'; }
    const plan = {
      clusters: edited
        .filter((c) => c.action !== 'skip')
        .map((c) => ({
          id: c.id,
          action: c.action,
          name: c.name,
          countryCode: c.countryCode,
          city: c.city,
          center: c.center,
          minDate: c.minDate,
          maxDate: c.maxDate,
          existingPlaceId: c.existingPlaceId || null,
          mediaIds: c.mediaIds,
        })),
    };
    try {
      const res = await api.gpsApply(plan);
      toast(`归档完成：新建 ${res.createdPlaces || 0} 个地点，归入 ${res.assignedMedia || 0} 张照片`);
      close();
      if (typeof onSaved === 'function') onSaved();
    } catch (e) {
      toast('归档失败：' + (e.message || e), 3000);
      if (btn) btn.textContent = '确认归档';
    } finally {
      busy = false;
    }
  }

  /* ---------------- 零散照片上传 ---------------- */
  function openScatter() {
    scatterModal.hidden = false;
    scatterFiles = [];
    renderScatterList();
    setScatterStatus('');
    const prog = document.getElementById('tm-scatter-progress');
    if (prog) prog.hidden = true;
  }
  function closeScatter() { scatterModal.hidden = true; }

  function addScatterFiles(fileList) {
    for (const f of Array.from(fileList || [])) scatterFiles.push(f);
    renderScatterList();
  }
  function renderScatterList() {
    const list = document.getElementById('tm-scatter-list');
    if (!list) return;
    list.innerHTML = '';
    scatterFiles.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'upload__item';
      row.innerHTML = `<span class="upload__name">${escapeHtml(f.name)}</span><span class="upload__size">${fmtSize(f.size)}</span>`;
      list.append(row);
    });
  }
  async function doScatterUpload() {
    if (!scatterFiles.length) { setScatterStatus('请先选择照片 / 视频'); return; }
    const go = document.getElementById('tm-scatter-go');
    if (go) go.disabled = true;
    const prog = document.getElementById('tm-scatter-progress');
    const fill = document.getElementById('tm-scatter-fill');
    const label = document.getElementById('tm-scatter-progress-label');
    if (prog) prog.hidden = false;
    let done = 0;
    try {
      for (const f of scatterFiles) {
        const fd = new FormData();
        fd.append('placeId', '');      // 暂不归类
        fd.append('file', f);
        await api.uploadMedia(fd);
        done += 1;
        if (fill) fill.style.width = Math.round((done / scatterFiles.length) * 100) + '%';
        if (label) label.textContent = `上传 ${done}/${scatterFiles.length}`;
      }
      toast(`已上传 ${done} 张零散照片`, 2200);
      closeScatter();
      open();   // 回到归档开始态，提示去分析
    } catch (e) {
      setScatterStatus('上传失败：' + (e.message || e), true);
    } finally {
      if (go) go.disabled = false;
    }
  }
  function setScatterStatus(msg, isErr) {
    const s = document.getElementById('tm-scatter-status');
    if (!s) return;
    s.textContent = msg || '';
    s.classList.toggle('is-error', !!isErr);
  }

  /* 零散上传弹窗的事件（drag/drop + 选择 + 提交 + 关闭） */
  const drop = document.getElementById('tm-scatter-drop');
  const input = document.getElementById('tm-scatter-input');
  const go = document.getElementById('tm-scatter-go');
  if (drop && input) {
    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { addScatterFiles(input.files); input.value = ''; });
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-drag'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer) addScatterFiles(e.dataTransfer.files); });
  }
  if (go) go.addEventListener('click', doScatterUpload);

  modal.querySelectorAll('[data-close="1"]').forEach((el) => el.addEventListener('click', close));
  scatterModal.querySelectorAll('[data-close="1"]').forEach((el) => el.addEventListener('click', closeScatter));

  return { open, close };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDate(s) { if (!s) return ''; return String(s).slice(0, 10); }
function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(0) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}
