/**
 * auth.js · 单用户密码登录
 *
 * 设计取舍：
 * - 这是"只有我一个人用"的应用，不需要注册 / 多用户体系。
 * - 登录密码来自环境变量 ADMIN_PASSWORD；它的 SHA-256 哈希存在进程里。
 * - 登录成功后下发一个 HMAC 签名的会话 cookie（httpOnly），服务端校验签名即可。
 * - 若未设置 ADMIN_PASSWORD（空串），则整个应用视为"开放"（仅本地开发用）。
 */
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PASSWORD_HASH = ADMIN_PASSWORD ? sha256(ADMIN_PASSWORD) : '';
const AUTH_ENABLED = PASSWORD_HASH.length > 0;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function makeToken() {
  const t = Date.now().toString();
  const sig = crypto.createHmac('sha256', SECRET).update(t).digest('hex');
  return `${t}.${sig}`;
}

function verifyToken(token) {
  if (!token) return false;
  const [t, sig] = token.split('.');
  if (!t || !sig) return false;
  const expect = crypto.createHmac('sha256', SECRET).update(t).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  } catch {
    return false;
  }
}

/** Express 中间件：需要登录时才拦截 */
function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next(); // 未设密码 = 开放
  const token = req.cookies ? req.cookies.tm_session : null;
  if (verifyToken(token)) return next();
  // API 请求返回 401，页面请求也返回 401（由前端跳登录）
  return res.status(401).json({ error: 'unauthorized' });
}

function login(password) {
  if (!AUTH_ENABLED) return { ok: true, open: true };
  if (sha256(password) === PASSWORD_HASH) return { ok: true };
  return { ok: false };
}

module.exports = { AUTH_ENABLED, requireAuth, login, makeToken };
