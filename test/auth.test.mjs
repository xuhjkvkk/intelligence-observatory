import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminAuth, passwordHash } from '../lib/auth.mjs';
import { startServer } from '../server.mjs';

test('管理认证：错误密码限流、Cookie 标记、退出和过期', () => {
  const auth = new AdminAuth(passwordHash('test-password-only'), { secure:true, path:'/intelligence/' });
  for (let i=0;i<5;i++) assert.equal(auth.login('wrong', 'a').status, 401);
  assert.equal(auth.login('test-password-only','a').status, 429);
  const login = auth.login('test-password-only','b');
  assert.match(login.cookie, /HttpOnly; SameSite=Strict; Path=\/intelligence\/; Max-Age=3600; Secure/);
  const req = { headers:{ cookie:login.cookie.split(';')[0] } };
  assert.equal(auth.authorized(req), true);
  auth.logout(req); assert.equal(auth.authorized(req), false);
  const login2 = auth.login('test-password-only','b');
  const req2 = { headers:{cookie:login2.cookie.split(';')[0]} };
  auth.sessions.set(auth.token(req2), Date.now()-1);
  assert.equal(auth.authorized(req2), false);
});

test('公网接口：匿名只读、管理端点保护、登录与子路径静态资源', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'intelligence-auth-'));
  const app = await startServer({ port:0, dataDir:directory, env:{ ADMIN_PASSWORD_HASH:passwordHash('test-password-only'), PUBLIC_ORIGIN:'https://example.com', BASE_PATH:'/intelligence' } });
  try {
    const fetchAPI = (path, method='GET', body, cookie) => fetch(app.origin+path, {method,headers:{'Content-Type':'application/json', ...(cookie?{Cookie:cookie}: {})},body:body?JSON.stringify(body):undefined});
    const state = await (await fetchAPI('/api/state')).json();
    assert.equal(state.auth.authenticated, false);
    assert.equal('baseURL' in state.config, false); assert.equal('prompt' in state.config, false);
    for (const [path, method] of [['/api/run','POST'],['/api/stop','POST'],['/api/config','PUT'],['/api/models','GET']]) assert.equal((await fetchAPI(path,method,method==='GET'?undefined:{})).status,401);
    const login = await fetchAPI('/api/auth/login','POST',{password:'test-password-only'});
    assert.equal(login.status,200); const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetchAPI('/api/state','GET',undefined,cookie)).json()).auth.authenticated,true);
    assert.equal((await fetchAPI('/api/config','PUT',{model:'protected-model'},cookie)).status,200);
    const page=await fetch(app.origin+'/');
    assert.equal(page.headers.get('x-frame-options'),'SAMEORIGIN');
    assert.match(page.headers.get('content-security-policy'), /(?:^|; )frame-ancestors 'self'(?:;|$)/);
    assert.match(page.headers.get('content-security-policy'), /object-src 'none'/);
    const crossOrigin=await fetch(app.origin+'/api/run', {method:'POST', headers:{Origin:'https://untrusted.example','Content-Type':'application/json',Cookie:cookie},body:'{}'});
    assert.equal(crossOrigin.status,403);
    const html=await page.text();
    assert.ok(html.includes('src="/intelligence/app.js"'));
    assert.ok(html.includes('href="/intelligence/"'));
    assert.ok(!html.includes('/intelligence/intelligence'));
    const themeModule = await fetch(app.origin+'/theme.js');
    assert.equal(themeModule.status,200);
    assert.match(themeModule.headers.get('content-type'), /text\/javascript/);
    assert.equal((await fetchAPI('/api/auth/logout','POST',{},cookie)).status,200);
    assert.equal((await fetchAPI('/api/run','POST',{},cookie)).status,401);
  } finally { await app.close(); await rm(directory,{recursive:true,force:true}); }
});
