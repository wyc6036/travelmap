/**
 * auth.js · 登录态管理（前端侧）
 * -----------------------------------------------------------
 * - 启动时拉 /api/config：若 authEnabled=false（未设 ADMIN_PASSWORD），
 *   视为开放，直接放行，并隐藏「退出」按钮。
 * - 若 authEnabled=true：显示登录遮罩，直到密码校验通过（服务端下发会话 cookie）。
 * - 暴露 initAuth()：返回 Promise，仅在「确定已登录」时 resolve(true)，
 *   因此 main.js 可以 `await initAuth()` 之后再拉数据。
 * - 暴露 showLogin()：会话失效（轮询拿到 401）时重新拉起遮罩。
 */

import { api } from './api.js';

let overlay, form, input, errEl, logoutBtn;
let resolveAuth = null; // 当前等待登录的 Promise 的 resolver

function bind() {
  overlay = document.getElementById('tm-login');
  form = document.getElementById('tm-login-form');
  input = document.getElementById('tm-login-password');
  errEl = document.getElementById('tm-login-error');
  logoutBtn = document.getElementById('tm-logout');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errEl) errEl.textContent = '';
    try {
      const r = await api.login(input.value);
      if (r && r.ok) {
        if (overlay) overlay.hidden = true;
        const done = resolveAuth;
        resolveAuth = null;
        if (done) done(true);
      } else if (errEl) {
        errEl.textContent = '密码错误，请重试';
      }
    } catch (e) {
      if (errEl) errEl.textContent = '登录失败：' + (e.message || '未知错误');
    }
  });

  logoutBtn?.addEventListener('click', async () => {
    try { await api.logout(); } catch (_) { /* 忽略 */ }
    location.reload();
  });
}

/** 拉配置并决定是否弹登录。返回 Promise<boolean>（是否放行） */
export async function initAuth() {
  bind();
  let cfg;
  try {
    cfg = await api.getConfig();
  } catch (_) {
    cfg = { authEnabled: false };
  }
  const enabled = !!(cfg && cfg.authEnabled);

  if (!enabled) {
    if (logoutBtn) logoutBtn.hidden = true;
    return true; // 开放模式，直接放行
  }

  if (logoutBtn) logoutBtn.hidden = false;

  /* 若已有有效会话（cookie 仍在 30 天有效期内），直接放行，不必再弹登录 */
  try {
    const s = await api.getSession();
    if (s && s.authed) return true;
  } catch (_) {
    /* 401 或网络异常 → 需要登录 */
  }

  if (overlay) {
    overlay.hidden = false;
    if (input) {
      input.value = '';
      input.focus();
    }
  }
  return new Promise((resolve) => { resolveAuth = resolve; });
}

/** 会话失效时重新拉起登录遮罩（轮询 401 时调用） */
export function showLogin() {
  if (overlay) {
    overlay.hidden = false;
    if (input) input.focus();
  }
}
