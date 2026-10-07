/**
 * api.js · 后端接口封装
 * -----------------------------------------------------------
 * 所有请求都走 /api，浏览器会自动带上 httpOnly 会话 cookie，
 * 因此这里不需要手动管理令牌。唯一要处理的是 401（未登录 / 会话失效）：
 * 抛出一个带 status=401 的错误，交给上层（auth / 轮询）去弹登录。
 */

const BASE = '/api';

async function req(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(BASE + path, {
    method: opts.method || 'GET',
    headers: isForm ? undefined : (opts.body ? { 'Content-Type': 'application/json' } : undefined),
    body: opts.body,
    credentials: 'same-origin',
    cache: 'no-store',
  });

  if (res.status === 401) {
    const e = new Error('unauthorized');
    e.status = 401;
    throw e;
  }
  if (!res.ok) {
    let msg = `请求失败（${res.status}）`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch (_) { /* 非 JSON 错误体，用默认文案 */ }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : null;
}

function json(body) { return { method: 'POST', body: JSON.stringify(body || {}) }; }

export const api = {
  /* 启动配置：authEnabled / apiBase（前端据此决定是否弹登录） */
  getConfig: () => req('/config'),
  getSession: () => req('/session'),

  /* 登录 / 登出 */
  login: (password) => req('/login', json({ password })),
  logout: () => req('/logout', { method: 'POST' }),

  /* 首次配置向导 */
  getSetup: () => req('/setup'),
  saveSetup: (cfg) => req('/setup', json(cfg)),

  /* 数据（与 places.json 同构，normalize 直接吃） */
  getData: () => req('/data'),

  /* 地点 */
  createPlace: (place) => req('/places', json(place)),
  updatePlace: (id, place) => req(`/places/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(place) }),
  deletePlace: (id) => req(`/places/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* 行程 */
  createTrip: (trip) => req('/trips', json(trip)),
  updateTrip: (id, trip) => req(`/trips/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(trip) }),
  deleteTrip: (id) => req(`/trips/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* 类型调色板 */
  saveTypes: (types) => req('/types', json(types)),

  /* 媒体上传：传入 FormData（可含 file，或纯文字 text_body） */
  uploadMedia: (formData) => req('/upload', { method: 'POST', body: formData }),

  /* 删除单条媒体（按 id） */
  deleteMedia: (id) => req(`/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
