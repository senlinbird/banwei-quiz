/* 管理后台 · 线上版（全部操作经数据库函数，权限与身份校验在服务端） */
'use strict';
const $ = s => document.querySelector(s);
let cloud = null;
let TOKEN = sessionStorage.getItem('bw_admin_token') || '';
let CACHE = [];

try {
  if (!window.WorkBuddyCloud || !window.BW_CONFIG) throw new Error('sdk-missing');
  cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: window.BW_CONFIG.endpoint,
    oauthRelayBaseUrl: window.BW_CONFIG.oauthRelayBaseUrl,
    publishableKey: window.BW_CONFIG.publishableKey
  });
} catch (e) {
  $('#boot-msg').textContent = '服务组件加载失败，请检查网络后刷新';
  $('#boot-error').classList.remove('hidden');
}

async function rpc(fn, params, timeoutMs = 15000) {
  if (!cloud) throw new Error('服务未就绪');
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('网络超时，请重试')), timeoutMs); });
  try {
    const res = await Promise.race([cloud.database.rpc(fn, params), timeout]);
    if (res && res.error) {
      const raw = String(res.error.message || '');
      if (/Failed to fetch|network|timeout/i.test(raw)) throw new Error('网络连接失败，请重试');
      throw new Error('服务暂时不可用，请稍后重试');
    }
    return res ? res.data : null;
  } finally { clearTimeout(timer); }
}

function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = text; t.classList.add('show');
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 登录 ---------- */
$('#btn-login').addEventListener('click', async () => {
  const pwd = $('#admin-pwd').value;
  const msg = $('#login-msg');
  if (!pwd) { msg.className = 'msg err'; msg.textContent = '请输入密码'; return; }
  const btn = $('#btn-login'); btn.disabled = true; btn.textContent = '登录中…';
  try {
    const data = await rpc('bw_admin_login', { p_pwd: pwd });
    if (!data || !data.ok) { msg.className = 'msg err'; msg.textContent = (data && data.msg) || '登录失败'; }
    else {
      TOKEN = data.token;
      sessionStorage.setItem('bw_admin_token', TOKEN);
      $('#admin-pwd').value = ''; msg.textContent = '';
      showPanel();
    }
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
  btn.disabled = false; btn.textContent = '登录';
});
$('#admin-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-login').click(); });
$('#btn-logout').addEventListener('click', () => { TOKEN = ''; sessionStorage.removeItem('bw_admin_token'); showLogin(); });

function showLogin() { $('#login-box').classList.remove('hidden'); $('#panel').classList.add('hidden'); }
function showPanel() { $('#login-box').classList.add('hidden'); $('#panel').classList.remove('hidden'); load(); }

/* ---------- 生成 ---------- */
$('#btn-generate').addEventListener('click', async () => {
  const count = Number($('#gen-count').value) || 0;
  const attempts = Number($('#gen-attempts').value) || 0;
  const btn = $('#btn-generate'); btn.disabled = true;
  try {
    const data = await rpc('bw_admin_generate', { p_token: TOKEN, p_count: count, p_attempts: attempts });
    if (!data || !data.ok) { $('#gen-result').className = 'msg err'; $('#gen-result').textContent = (data && data.msg) || '生成失败'; if (data && /登录/.test(data.msg || '')) showLogin(); }
    else {
      $('#gen-result').className = 'msg ok';
      $('#gen-result').textContent = `✅ 已生成 ${data.created} 个密码（每个可用 ${attempts} 次）：${(data.codes || []).slice(0, 5).join('、')}${data.created > 5 ? ' …' : ''}`;
      load();
    }
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});

/* ---------- 搜索 / 导出 ---------- */
let timer;
$('#search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 300); });
$('#btn-export').addEventListener('click', () => {
  const rows = [['code', 'total', 'attemptsLeft', 'status', 'createdAt'],
    ...CACHE.map(p => [p.code, p.total, p.attemptsLeft, p.status, p.createdAt])];
  const csv = '\uFEFF' + rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'passwords.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('已导出 CSV');
});

/* ---------- 列表 ---------- */
async function load() {
  try {
    const q = $('#search').value.trim();
    const data = await rpc('bw_admin_list', { p_token: TOKEN, p_q: q });
    if (!data || !data.ok) { if (data && /登录/.test(data.msg || '')) { toast('登录已过期，请重新登录'); showLogin(); } return; }
    CACHE = data.passwords || [];
    $('#stat-total').textContent = (data.stats && data.stats.total) || 0;
    $('#stat-left').textContent = (data.stats && data.stats.attemptsLeft) || 0;
    $('#stat-results').textContent = data.resultCount || 0;

    const fmt = t => new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const badge = { active: '<span class="badge active">可用</span>', used: '<span class="badge used">已用完</span>', disabled: '<span class="badge disabled">已禁用</span>' };
    $('#pw-body').innerHTML = CACHE.map(p => `
      <tr>
        <td><code>${p.code}</code></td>
        <td>${p.total}</td>
        <td><b>${p.attemptsLeft}</b></td>
        <td>${badge[p.status] || p.status}</td>
        <td>${fmt(p.createdAt)}</td>
        <td>${p.status !== 'disabled' ? `<button class="tool-btn danger" data-code="${p.code}">禁用</button>` : '—'}</td>
      </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--sub);">暂无密码，先批量生成吧</td></tr>';

    document.querySelectorAll('.tool-btn.danger').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm(`确定禁用密码 ${b.dataset.code} 吗？禁用后无法恢复。`)) return;
        try {
          const d = await rpc('bw_admin_disable', { p_token: TOKEN, p_codes: [b.dataset.code] });
          toast(d && d.ok ? `已禁用 ${d.disabled} 个密码` : (d && d.msg) || '操作失败');
          load();
        } catch (e) { toast(e.message); }
      });
    });
  } catch (e) { toast(e.message); }
}

/* ---------- 修改管理员密码 ---------- */
$('#btn-change-pwd').addEventListener('click', async () => {
  const v = $('#new-pwd').value;
  const box = $('#pwd-result');
  if (v.length < 8) { box.className = 'msg err'; box.textContent = '新密码至少需要8位'; return; }
  try {
    const d = await rpc('bw_admin_set_password', { p_token: TOKEN, p_new: v });
    box.className = d && d.ok ? 'msg ok' : 'msg err';
    box.textContent = (d && d.msg) || '操作失败';
    if (d && d.ok) $('#new-pwd').value = '';
  } catch (e) { box.className = 'msg err'; box.textContent = e.message; }
});

/* ---------- 入口：已有会话直接进面板 ---------- */
(async () => {
  if (!TOKEN) {
    showLogin();
    // ?pwd=<管理密码> 自动填入，方便反复调试；不自动登录
    const p = (new URLSearchParams(location.search).get('pwd') || '').trim();
    if (p) {
      $('#admin-pwd').value = p;
      $('#login-msg').className = 'msg';
      $('#login-msg').textContent = '密码已自动填入，点击「登录」即可';
      $('#btn-login').focus();
    }
    return;
  }
  try {
    const d = await rpc('bw_admin_list', { p_token: TOKEN, p_q: '' });
    if (d && d.ok) showPanel(); else { TOKEN = ''; sessionStorage.removeItem('bw_admin_token'); showLogin(); }
  } catch { showLogin(); }
})();
