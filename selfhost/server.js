/**
 * 班味浓度检测 · 服务端（零依赖，Node.js 18+）
 * 启动: node server.js
 * 密码校验 / 次数扣减 / 计分 / 结果存储 / 管理后台 全部在服务端完成
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------- 环境变量（支持 .env 文件，优先级低于真实环境变量） ---------------- */
(function loadEnv() {
  const envFile = path.join(__dirname, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(24).toString('hex');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ATTEMPTS_PER_RESULT = process.env.MAX_ATTEMPTS ? Number(process.env.MAX_ATTEMPTS) : 3;

if (!ADMIN_PASSWORD) {
  console.warn('⚠️  未设置 ADMIN_PASSWORD，管理后台使用默认密码 admin123（仅供本地调试，部署前务必在 .env 中修改！）');
}
const ADMIN_PWD = ADMIN_PASSWORD || 'admin123';
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  未设置 SESSION_SECRET，已使用随机值（重启后管理员需重新登录）。');
}

/* ---------------- 数据层：JSON 文件存储（原子写入） ---------------- */
const DB_FILE = path.join(DATA_DIR, 'db.json');
let db = { passwords: [], results: [] };

function initDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('数据库文件损坏，已重建', e); }
  }
  if (!Array.isArray(db.passwords)) db.passwords = [];
  if (!Array.isArray(db.results)) db.results = [];
  // 首次运行：预置一个演示密码
  if (db.passwords.length === 0) {
    db.passwords.push(makePassword('BW-8888-8888', 10));
    saveDb();
    console.log('✅ 已预置演示密码：BW-8888-8888（10次），请在管理后台生成正式密码。');
  }
}

function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function makePassword(code, attempts) {
  return { code, total: attempts, attemptsLeft: attempts, status: 'active', createdAt: new Date().toISOString() };
}

/* ---------------- 进程内互斥锁：保证同一密码的并发提交串行执行 ---------------- */
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

/* ---------------- IP 限流（滑动窗口，防暴力试密码/刷接口） ---------------- */
const RATE_RULES = {
  verify: { max: 20, windowMs: 60 * 1000 },
  submit: { max: 12, windowMs: 60 * 1000 },
  login:  { max: 10, windowMs: 60 * 1000 }
};
const rateHits = new Map(); // ip -> { rule: [timestamps] }
function rateLimit(ruleName, req) {
  const rule = RATE_RULES[ruleName];
  if (!rule) return true;
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const key = ip + ':' + ruleName;
  const arr = (rateHits.get(key) || []).filter(t => now - t < rule.windowMs);
  if (arr.length >= rule.max) { rateHits.set(key, arr); return false; }
  arr.push(now);
  rateHits.set(key, arr);
  return true;
}
// 每5分钟清理过期限流记录
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of rateHits) {
    const ruleName = k.split(':').pop();
    const keep = arr.filter(t => now - t < (RATE_RULES[ruleName]?.windowMs || 60000));
    if (keep.length === 0) rateHits.delete(k); else rateHits.set(k, keep);
  }
}, 5 * 60 * 1000).unref();

/* ---------------- 提交令牌（一次性 + 幂等重试，防重复请求重复扣次） ---------------- */
const TOKEN_TTL = 30 * 60 * 1000;
const submitTokens = new Map(); // token -> { code, exp, status: 'pending'|'done', resultId }
function newSubmitToken(code) {
  const token = crypto.randomBytes(16).toString('hex');
  submitTokens.set(token, { code, exp: Date.now() + TOKEN_TTL, status: 'pending', resultId: null });
  return token;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, v] of submitTokens) if (v.exp < now) submitTokens.delete(t);
}, 5 * 60 * 1000).unref();

/* ---------------- 工具函数 ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = n => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `BW-${seg(4)}-${seg(4)}`;
}
function genId() { return crypto.randomBytes(8).toString('hex'); }

/* ---------------- 管理员会话（HMAC 签名 Cookie） ---------------- */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || ''), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function getAdmin(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)admin_token=([^\s;]+)/);
  return m ? verifyToken(m[1]) : null;
}

/* ---------------- 业务逻辑 ---------------- */
function findPassword(code) { return db.passwords.find(p => p.code === code); }

function createResults(count, attempts) {
  const made = [];
  let guard = 0;
  while (made.length < count && guard++ < count * 20) {
    const code = genCode();
    if (findPassword(code)) continue;
    const p = makePassword(code, attempts);
    db.passwords.push(p);
    made.push(p);
  }
  saveDb();
  return made;
}

/* ---------------- HTTP 服务 ---------------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404); res.end('Not Found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    /* ---------- 用户端 API ---------- */
    // 校验密码（不扣次数；带限流防暴力试密码）
    if (p === '/api/verify' && req.method === 'POST') {
      if (!rateLimit('verify', req)) return json(res, 429, { ok: false, msg: '尝试太频繁了，请1分钟后再试' });
      const { code } = await readBody(req);
      const c = String(code || '').trim().toUpperCase();
      if (!/^BW-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)) return json(res, 200, { ok: false, msg: '密码格式不对，应为 BW-XXXX-XXXX' });
      const pwd = findPassword(c);
      if (!pwd) return json(res, 200, { ok: false, msg: '密码不存在，请检查后重试' });
      if (pwd.status === 'disabled') return json(res, 200, { ok: false, msg: '该密码已被禁用，请联系管理员' });
      if (pwd.attemptsLeft <= 0) return json(res, 200, { ok: false, msg: '该密码的测评次数已用完' });
      return json(res, 200, { ok: true, attemptsLeft: pwd.attemptsLeft, total: pwd.total });
    }

    // 获取题目（脱敏，不含分值）
    if (p === '/api/quiz' && req.method === 'GET') {
      const { QUESTIONS } = require('./data-quiz');
      return json(res, 200, {
        questions: QUESTIONS.map(q => ({ id: q.id, scene: q.scene, options: q.options.map(o => ({ key: o.key, text: o.text })) }))
      });
    }

    // 领取提交令牌：开始答题前调用，提交时必须携带（一次性，30分钟有效）
    if (p === '/api/prepare' && req.method === 'POST') {
      if (!rateLimit('submit', req)) return json(res, 429, { ok: false, msg: '请求太频繁了，请稍后再试' });
      const { code } = await readBody(req);
      const c = String(code || '').trim().toUpperCase();
      const pwd = findPassword(c);
      if (!pwd || pwd.status === 'disabled' || pwd.attemptsLeft <= 0) {
        return json(res, 200, { ok: false, msg: '密码不可用，请重新验证' });
      }
      return json(res, 200, { ok: true, token: newSubmitToken(c) });
    }

    // 提交答卷：令牌校验 → 加锁 → 校验 → 扣次数 → 计分 → 存结果（原子完成，并发安全）
    // 幂等：同一令牌重复提交（网络重试/双击）直接返回已生成的结果，不重复扣次数
    if (p === '/api/submit' && req.method === 'POST') {
      if (!rateLimit('submit', req)) return json(res, 429, { ok: false, msg: '请求太频繁了，请稍后再试' });
      const { code, answers, token } = await readBody(req);
      if (typeof token !== 'string' || !submitTokens.has(token)) {
        return json(res, 200, { ok: false, retryable: true, msg: '答题会话已失效，请重新验证密码' });
      }
      const t = submitTokens.get(token);
      const c = String(code || '').trim().toUpperCase();
      if (t.code !== c) return json(res, 200, { ok: false, retryable: true, msg: '答题会话与密码不匹配，请重新验证' });
      // 幂等重试：令牌已完成，直接返回原结果
      if (t.status === 'done' && t.resultId) {
        return json(res, 200, { ok: true, resultId: t.resultId, duplicate: true, attemptsLeft: findPassword(c)?.attemptsLeft ?? 0 });
      }
      if (!Array.isArray(answers) || answers.length !== 12 || answers.some(a => !Number.isInteger(a) || a < 0 || a > 3)) {
        return json(res, 200, { ok: false, msg: '答卷不完整或有误，请完成全部题目' });
      }
      const result = await withLock('pwd:' + c, async () => {
        // 锁内二次确认幂等（并发双击场景）
        const tk = submitTokens.get(token);
        if (tk && tk.status === 'done' && tk.resultId) {
          return { ok: true, resultId: tk.resultId, duplicate: true, attemptsLeft: findPassword(c)?.attemptsLeft ?? 0 };
        }
        const pwd = findPassword(c);
        if (!pwd) return { ok: false, msg: '密码不存在' };
        if (pwd.status === 'disabled') return { ok: false, msg: '该密码已被禁用' };
        if (pwd.attemptsLeft <= 0) return { ok: false, msg: '该密码的测评次数已用完' };
        const { score } = require('./data-quiz');
        const { judge } = require('./data-results');
        const sc = score(answers);
        const res0 = judge(sc.W, sc.E, sc.S, sc.R, sc.final);
        pwd.attemptsLeft -= 1;
        if (pwd.attemptsLeft === 0) pwd.status = 'used';
        const record = {
          id: genId(),
          final: sc.final, W: sc.W, E: sc.E, S: sc.S, R: sc.R,
          resultKey: res0.id, answers,
          createdAt: new Date().toISOString()
        };
        db.results.push(record);
        saveDb();   // 扣减与存储同事务落盘
        if (submitTokens.has(token)) { submitTokens.set(token, { ...submitTokens.get(token), status: 'done', resultId: record.id }); }
        return { ok: true, resultId: record.id, attemptsLeft: pwd.attemptsLeft };
      });
      return json(res, 200, result);
    }

    // 读取结果（分享页用，不返回任何密码信息）
    if (p === '/api/result' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      const rec = db.results.find(r => r.id === id);
      if (!rec) return json(res, 404, { ok: false, msg: '结果不存在或已失效' });
      const { RESULTS } = require('./data-results');
      const r = RESULTS.find(x => x.id === rec.resultKey);
      return json(res, 200, {
        ok: true,
        result: {
          id: rec.id, final: rec.final,
          dims: { W: rec.W, E: rec.E, S: rec.S, R: rec.R },
          createdAt: rec.createdAt,
          content: r
        }
      });
    }

    /* ---------- 管理后台 API ---------- */
    if (p === '/api/admin/login' && req.method === 'POST') {
      if (!rateLimit('login', req)) return json(res, 429, { ok: false, msg: '尝试太频繁了，请1分钟后再试' });
      const { password } = await readBody(req);
      const a = Buffer.from(String(password || '')), b = Buffer.from(ADMIN_PWD);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return json(res, 401, { ok: false, msg: '密码错误' });
      }
      const token = sign({ role: 'admin', exp: Date.now() + 12 * 3600 * 1000 });
      res.setHeader('Set-Cookie', `admin_token=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/admin/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'admin_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }

    if (p.startsWith('/api/admin/')) {
      const admin = getAdmin(req);
      if (!admin) return json(res, 401, { ok: false, msg: '未登录或会话已过期' });

      if (p === '/api/admin/passwords/generate' && req.method === 'POST') {
        const { count, attempts } = await readBody(req);
        const n = Math.min(500, Math.max(1, Number(count) || 0));
        const att = Math.min(99, Math.max(1, Number(attempts) || ATTEMPTS_PER_RESULT));
        const made = await withLock('db', async () => createResults(n, att));
        return json(res, 200, { ok: true, created: made.length, passwords: made });
      }
      if (p === '/api/admin/passwords' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim().toUpperCase();
        let list = [...db.passwords].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (q) list = list.filter(x => x.code.includes(q));
        return json(res, 200, { ok: true, passwords: list, resultCount: db.results.length });
      }
      if (p === '/api/admin/passwords/disable' && req.method === 'POST') {
        const { codes } = await readBody(req);
        let n = 0;
        await withLock('db', async () => {
          for (const c of codes || []) {
            const pwd = findPassword(c);
            if (pwd && pwd.status !== 'disabled') { pwd.status = 'disabled'; n++; }
          }
          saveDb();
        });
        return json(res, 200, { ok: true, disabled: n });
      }
      if (p === '/api/admin/export' && req.method === 'GET') {
        const rows = [['code', 'total', 'attemptsLeft', 'status', 'createdAt'],
          ...db.passwords.map(x => [x.code, x.total, x.attemptsLeft, x.status, x.createdAt])];
        const csv = '\uFEFF' + rows.map(r => r.join(',')).join('\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="passwords.csv"' });
        return res.end(csv);
      }
      return json(res, 404, { ok: false, msg: '未知管理接口' });
    }

    /* ---------- 静态页面 ---------- */
    if (p === '/' || p.match(/^\/r\/[a-zA-Z0-9]+$/)) return serveStatic(res, 'index.html');
    if (p === '/admin' || p === '/admin/') return serveStatic(res, 'admin.html');
    if (p.startsWith('/api/')) return json(res, 404, { ok: false, msg: '接口不存在' });
    const safe = p.replace(/^\/+/, '');
    if (safe && !safe.includes('..')) return serveStatic(res, safe);
    res.writeHead(404); res.end('Not Found');
  } catch (err) {
    console.error(err);
    json(res, 500, { ok: false, msg: '服务器开小差了，请稍后重试' });
  }
});

initDb();
server.listen(PORT, () => {
  console.log(`\n🧪 班味浓度检测 已启动`);
  console.log(`   测评页面:  http://localhost:${PORT}/`);
  console.log(`   管理后台:  http://localhost:${PORT}/admin`);
  console.log(`   数据目录:  ${DATA_DIR}\n`);
});
