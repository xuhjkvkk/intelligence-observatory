import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { Observatory } from './lib/observatory.mjs';
import { AdminAuth } from './lib/auth.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export async function startServer({ port = Number(process.env.PORT || 4317), dataDir = join(root, '.data'), env = process.env } = {}) {
  const observatory = await new Observatory(dataDir, env).init();
  const basePath = env.BASE_PATH || '';
  if (basePath && !/^\/[a-z0-9-]+$/.test(basePath)) throw new Error('BASE_PATH 格式不正确');
  const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : null;
  if (publicOrigin && !env.ADMIN_PASSWORD_HASH) throw new Error('公网部署必须设置 ADMIN_PASSWORD_HASH');
  const auth = new AdminAuth(env.ADMIN_PASSWORD_HASH, { secure:publicOrigin?.startsWith('https:'), path:basePath + '/' });
  let origin;
  const server = createServer(async (req, res) => {
    const headers = {
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    };
    const send = (status, body) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    // Loopback only. Reject DNS rebinding and cross-origin form/fetch writes.
    if (![`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`].includes(req.headers.host)) return send(403, { error: '不允许的主机地址' });
    if (req.headers.origin && ![origin, origin.replace('127.0.0.1', 'localhost'), publicOrigin].includes(req.headers.origin)) return send(403, { error: '不允许跨站请求' });
    const url = new URL(req.url, origin);
    let body = {};
    try {
      if (['POST', 'PUT'].includes(req.method)) {
        if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: '只接受 JSON' });
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length; if (size > 32_000) return send(413, { error: '请求内容过大' }); chunks.push(chunk);
        }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, { error: '无效的 JSON' }); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return send(400, { error: '请求必须是 JSON 对象' });
      }
      const admin = auth.authorized(req);
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const result = auth.login(body.password, publicOrigin ? (req.headers['x-real-ip'] || req.socket.remoteAddress) : req.socket.remoteAddress);
        if (result.cookie) headers['Set-Cookie'] = result.cookie;
        return send(result.status || 200, { ok:result.ok, error:result.error });
      }
      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        headers['Set-Cookie'] = auth.logout(req); return send(200, { ok:true });
      }
      if (url.pathname === '/api/auth' && req.method === 'GET') return send(200, { required:auth.enabled, authenticated:admin });
      if (url.pathname.startsWith('/api/') && (['POST', 'PUT', 'DELETE'].includes(req.method) || ['/api/config', '/api/models'].includes(url.pathname)) && !admin) return send(401, { error:'请先输入管理密码' });
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const state = observatory.state();
        state.auth = { required:auth.enabled, authenticated:admin };
        if (!admin) {
          const { model, effort, intervalMinutes, enabled } = state.config;
          state.config = { model, effort, intervalMinutes, enabled };
          state.lastError = null;
          state.items = state.items.map(({ error, ...item }) => item);
        }
        return send(200, state);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/observations/')) {
        let item = observatory.detail(url.pathname.split('/').at(-1));
        if (item && !admin) {
          const strip = ({ prompt, raw, error, challenge, ...rest }) => rest;
          item = { ...strip(item), attempts:item.attempts.map(strip) };
        }
        return send(item ? 200 : 404, item || { error: '记录不存在' });
      }
      if (req.method === 'PUT' && url.pathname === '/api/config') return send(200, await observatory.saveConfig(body));
      if (req.method === 'GET' && url.pathname === '/api/models') return send(200, { models: await observatory.models() });
      if (req.method === 'POST' && url.pathname === '/api/run') return send(202, observatory.run());
      if (req.method === 'POST' && url.pathname === '/api/stop') { observatory.stop(); return send(200, { ok: true }); }
      if (url.pathname.startsWith('/api/')) return send(404, { error: '接口不存在' });
      if (req.method !== 'GET') return send(405, { error: '不支持此方法' });
      const assets = { '/': ['index.html', 'text/html'], '/intelligence': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      assets['/theme.js'] = ['theme.js', 'text/javascript'];
      const asset = assets[url.pathname]; if (!asset) return send(404, { error: '页面不存在' });
      let content = await readFile(join(root, 'public', asset[0]));
      if (asset[0] === 'index.html' && basePath) content = content.toString().replaceAll('href="/intelligence"', `href="${basePath}/"`).replace(/(href|src)="\/(?!intelligence\/)/g, `$1="${basePath}/`);
      res.writeHead(200, { ...headers, 'Content-Type': `${asset[1]}; charset=utf-8` }); res.end(content);
    } catch (error) {
      const message = observatory.config.apiKey ? String(error.message).replaceAll(observatory.config.apiKey, '[已隐藏]') : error.message;
      send(400, { error: message });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, env.LISTEN_HOST || '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, observatory, origin, close: async () => { await observatory.close(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = await startServer();
  console.log(`Intelligence Online: ${app.origin}/intelligence`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
