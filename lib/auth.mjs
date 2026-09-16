import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
export class AdminAuth {
  constructor(hash, { secure = false, path = '/' } = {}) {
    this.hash = hash; this.secure = secure; this.path = path;
    this.sessions = new Map(); this.failures = new Map();
    if (hash && !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)) throw new Error('ADMIN_PASSWORD_HASH 格式不正确');
  }
  get enabled() { return Boolean(this.hash); }
  prune() {
    const now = Date.now();
    for (const [id, expires] of this.sessions) if (expires < now) this.sessions.delete(id);
    for (const [ip, data] of this.failures) if (data.until < now) this.failures.delete(ip);
  }
  token(req) { return /(?:^|;\s*)intelligence_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1]; }
  authorized(req) { this.prune(); return !this.enabled || this.sessions.has(this.token(req)); }
  cookie(token, age) { return `intelligence_admin=${token}; HttpOnly; SameSite=Strict; Path=${this.path}; Max-Age=${age}${this.secure ? '; Secure' : ''}`; }
  login(password, ip) {
    this.prune();
    if (!this.enabled) return { ok:true };
    if ((this.failures.get(ip)?.count || 0) >= 5) return { status:429, error:'密码尝试过多，请 15 分钟后再试' };
    const [salt, hex] = this.hash.split(':');
    const correct = typeof password === 'string' && password.length <= 256 && timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hex, 'hex'));
    if (!correct) {
      const old = this.failures.get(ip);
      this.failures.set(ip, { count:(old?.count || 0) + 1, until:old?.until || Date.now() + 900_000 });
      return { status:401, error:'管理密码不正确' };
    }
    this.failures.delete(ip);
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, Date.now() + 3600_000);
    return { ok:true, cookie:this.cookie(token, 3600) };
  }
  logout(req) { this.sessions.delete(this.token(req)); return this.cookie('', 0); }
}
