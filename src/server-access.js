import crypto from 'node:crypto';
import { parse, format } from 'basic-auth';

const loopback = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
const digest = value => crypto.createHash('sha256').update(value).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

export function createServerAccess({ host, username = process.env.BPS_ADMIN_USER || '',
  password = process.env.BPS_ADMIN_PASSWORD || '', publicUrl = process.env.BPS_PUBLIC_URL || '' }) {
  if (Boolean(username) !== Boolean(password)) throw new Error('BPS_ADMIN_USER 和 BPS_ADMIN_PASSWORD 必须一起设置');
  if (!loopback(host) && !password) throw new Error('对外监听必须设置 BPS_ADMIN_USER 和 BPS_ADMIN_PASSWORD');
  if (password) format({ name: username, pass: password });
  let publicOrigin = '';
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('BPS_PUBLIC_URL 必须是完整的 HTTP(S) 根地址，例如 https://bps.example.com');
    }
    publicOrigin = url.origin;
  }
  const access = {
    authenticated: Boolean(password),
    origin(req) { return publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`; },
    check(req) {
      let target;
      try { target = new URL(`http://${req.headers.host}`); } catch { return 403; }
      if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) return 403;
      if (publicOrigin) {
        if (target.host !== new URL(publicOrigin).host) return 403;
      } else if (loopback(host) && (!loopback(target.hostname) || Number(target.port || 80) !== req.socket.localPort)) return 403;
      if (req.headers.origin && req.headers.origin !== access.origin(req)) return 403;
      if (req.headers['sec-fetch-site'] === 'cross-site') return 403;
      if (password) {
        const credentials = parse(req.headers.authorization || '');
        if (!credentials || !(same(credentials.name, username) & same(credentials.pass, password))) return 401;
      }
      return 0;
    },
    middleware(req, res, next) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      const status = access.check(req);
      if (status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="Browser Play Set", charset="UTF-8"');
      if (status) return res.status(status).json({ error: status === 401 ? '请登录服务器工作台' : '拒绝无效 Host 或跨站请求' });
      next();
    },
  };
  return access;
}
