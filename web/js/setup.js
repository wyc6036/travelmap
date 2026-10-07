/**
 * setup.js · 首次配置向导（前端侧）
 * -----------------------------------------------------------
 * 用户在「首次进入网站」时选择媒体存储方式：
 *   - 对象存储 MinIO：默认填好内置 MinIO 的连接信息，可直接进入，也可改成自建 MinIO / 阿里云 OSS
 *   - 本地目录：媒体直接存到服务器上的一个文件夹
 *
 * 流程：initSetup() 拉 /api/setup，若 setupRequired=false 直接放行；
 * 否则弹出遮罩、按当前连接信息预填表单，提交时调 /api/setup 校验连通性并保存。
 * 仅在「确定已保存」时 resolve(true)，所以 main.js 可以 await initSetup() 之后再加载数据。
 */

import { api } from './api.js';

let overlay, form, errEl, saveBtn, minioFields, localFields;
let resolveSetup = null;

function bind() {
  overlay = document.getElementById('tm-setup');
  form = document.getElementById('tm-setup-form');
  errEl = document.getElementById('tm-setup-error');
  saveBtn = document.getElementById('tm-setup-save');
  minioFields = document.getElementById('tm-setup-minio');
  localFields = document.getElementById('tm-setup-local');

  /* 存储方式切换：显示对应字段组 */
  overlay.querySelectorAll('input[name="tm-setup-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      const local = r.value === 'local' && r.checked;
      localFields.hidden = !local;
      minioFields.hidden = local;
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errEl) errEl.textContent = '';
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '正在连接并保存…'; }
    try {
      const cfg = collect();
      const r = await api.saveSetup(cfg);
      if (r && r.ok) {
        overlay.hidden = true;
        const done = resolveSetup;
        resolveSetup = null;
        if (done) done(true);
      } else if (errEl) {
        errEl.textContent = (r && r.error) || '保存失败，请检查配置';
      }
    } catch (e) {
      const msg = e.message || '未知错误';
      let tip = '保存失败：' + msg;
      // SSL 勾错时的典型错误：连 HTTP 端点却开了 HTTPS
      if (/EPROTO|wrong version number|SSL|ssl3_get_record|DEPTH_ZERO_SELF_SIGNED_CERT/i.test(msg)) {
        tip += '。提示：当前端点可能是 HTTP，请取消勾选「启用 HTTPS」后再试。';
      }
      if (errEl) errEl.textContent = tip;
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存并进入'; }
    }
  });
}

function collect() {
  const mode = overlay.querySelector('input[name="tm-setup-mode"]:checked')?.value || 'minio';
  if (mode === 'local') {
    return {
      mode: 'local',
      local: { dir: document.getElementById('tm-setup-dir').value.trim() },
    };
  }
  return {
    mode: 'minio',
    minio: {
      endpoint: document.getElementById('tm-setup-endpoint').value.trim(),
      port: Number(document.getElementById('tm-setup-port').value) || 9000,
      useSsl: document.getElementById('tm-setup-ssl').checked,
      accessKey: document.getElementById('tm-setup-access').value.trim(),
      secretKey: document.getElementById('tm-setup-secret').value,
      bucket: document.getElementById('tm-setup-bucket').value.trim() || 'travelmap',
    },
  };
}

function prefill(cfg) {
  cfg = cfg || {};
  const mode = cfg.mode === 'local' ? 'local' : 'minio';
  const mr = overlay.querySelector(`input[name="tm-setup-mode"][value="${mode}"]`);
  if (mr) mr.checked = true;
  localFields.hidden = mode !== 'local';
  minioFields.hidden = mode === 'local';

  const m = cfg.minio || {};
  document.getElementById('tm-setup-endpoint').value = m.endpoint || '';
  document.getElementById('tm-setup-port').value = m.port || 9000;
  document.getElementById('tm-setup-ssl').checked = !!m.useSsl;
  document.getElementById('tm-setup-access').value = m.accessKey || '';
  document.getElementById('tm-setup-secret').value = m.secretKey || '';
  document.getElementById('tm-setup-bucket').value = m.bucket || 'travelmap';
  document.getElementById('tm-setup-dir').value = (cfg.local && cfg.local.dir) || '';
}

/** 拉配置并决定是否弹向导。返回 Promise<boolean>（是否放行） */
export async function initSetup() {
  bind();
  let info;
  try { info = await api.getSetup(); } catch (_) { info = { setupRequired: false }; }
  if (!info || !info.setupRequired) return true; // 已配置，直接放行

  prefill(info.config);
  overlay.hidden = false;
  return new Promise((resolve) => { resolveSetup = resolve; });
}
