/* 班味浓度检测 · 线上版前端（静态站 + 云端 RPC）· 含异常处理 */
'use strict';
const $ = s => document.querySelector(s);
const state = { code: '', token: '', answers: [], idx: 0, result: null };

/* ---------- 云端客户端 ---------- */
let cloud = null;
function bootError(msg) {
  $('#boot-msg').textContent = msg;
  $('#boot-error').classList.remove('hidden');
}
try {
  if (!window.WorkBuddyCloud || !window.BW_CONFIG) throw new Error('sdk-missing');
  cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: window.BW_CONFIG.endpoint,
    oauthRelayBaseUrl: window.BW_CONFIG.oauthRelayBaseUrl,
    publishableKey: window.BW_CONFIG.publishableKey
  });
} catch (e) {
  bootError('服务组件加载失败，请检查网络后刷新页面');
}

/* ---------- RPC 封装：超时 + 友好错误 ---------- */
async function rpc(fn, params, timeoutMs = 15000) {
  if (!cloud) throw new Error('服务未就绪，请刷新页面');
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('网络超时了，请检查网络后重试')), timeoutMs); });
  try {
    const res = await Promise.race([cloud.database.rpc(fn, params), timeout]);
    if (res && res.error) {
      const raw = String(res.error.message || '');
      if (/Failed to fetch|NetworkError|network|timeout/i.test(raw)) throw new Error('网络连接失败，请检查网络后重试');
      if (res.error.code === '42501') throw new Error('没有权限执行该操作');
      throw new Error('服务暂时不可用，请稍后重试');
    }
    return res ? res.data : null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 屏幕切换 ---------- */
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

/* ---------- 断网提醒 ---------- */
window.addEventListener('offline', () => toast('⚠️ 网络已断开，答题进度仍保留在本页'));
window.addEventListener('online', () => toast('✅ 网络已恢复，可以继续操作'));

/* ---------- 设备标识（每台设备共 3 次测评机会） ---------- */
const DEV_KEY = 'bw_did';
function newDeviceId() {
  try {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  } catch (e) { /* 降级 */ }
  let s = '';
  const alphabet = 'abcdef0123456789';
  for (let i = 0; i < 32; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}
function deviceId() {
  let id = '';
  try { id = localStorage.getItem(DEV_KEY) || ''; } catch (e) { /* 隐私模式 */ }
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    // localStorage 不可用或被清时，用 cookie 兜底，尽量保持同一台设备计数连续
    const m = document.cookie.match(/(?:^|;\s*)bw_did=([A-Za-z0-9_-]{16,64})/);
    id = m ? m[1] : newDeviceId();
  }
  try { localStorage.setItem(DEV_KEY, id); } catch (e) { /* 忽略 */ }
  try { document.cookie = 'bw_did=' + id + '; max-age=31536000; path=/; SameSite=Lax'; } catch (e) { /* 忽略 */ }
  return id;
}
/* 测试用：?resetdev=1 重置本设备标识（等同于清除本站数据，仅影响本机） */
if (/[?&]resetdev=1/.test(location.search)) {
  try { localStorage.removeItem(DEV_KEY); } catch (e) { /* 忽略 */ }
  try { document.cookie = 'bw_did=; max-age=0; path=/'; } catch (e) { /* 忽略 */ }
}

/* ---------- 密码门 ---------- */
let pendingAuto = false;   // ?auto=1 时为 true，验证通过后自动进入答题

/* 验证成功后清掉地址栏参数，避免用户复制地址时把密码带出去 */
function cleanQuery() {
  try { history.replaceState(null, '', location.pathname); } catch (e) { /* 忽略 */ }
}

$('#btn-verify').addEventListener('click', async () => {
  const code = $('#pwd-input').value.trim().toUpperCase();
  const msg = $('#gate-msg');
  if (!code) { msg.className = 'msg err'; msg.textContent = '请输入密码'; return; }
  if (!/^BW-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    msg.className = 'msg err'; msg.textContent = '密码格式应为 BW-XXXX-XXXX'; return;
  }
  const btn = $('#btn-verify'); btn.disabled = true; btn.textContent = '验证中…';
  try {
    const data = await rpc('bw_verify', { p_code: code, p_device: deviceId() }, 10000);
    if (!data || !data.ok) {
      msg.className = 'msg err'; msg.textContent = (data && data.msg) || '验证失败，请重试';
      $('#btn-start').classList.add('hidden');
      if (data && data.deviceBlocked) $('#pwd-input').blur();
    } else {
      state.code = code; state.token = data.token;
      const devLeft = (typeof data.deviceLeft === 'number') ? data.deviceLeft : data.attemptsLeft;
      const left = Math.min(data.attemptsLeft, devLeft);
      msg.className = 'msg ok';
      msg.textContent = `✅ 验证通过，本设备还可测 ${left} 次`;
      $('#btn-start').classList.remove('hidden');
      cleanQuery();
    }
  } catch (e) {
    msg.className = 'msg err'; msg.textContent = e.message;
  }
  btn.disabled = false; btn.textContent = '验证密码';
  if (pendingAuto) { pendingAuto = false; setTimeout(startQuiz, 500); }
});
$('#btn-start').addEventListener('click', startQuiz);
$('#pwd-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-verify').click(); });

/* ---------- 答题 ---------- */
function startQuiz() {
  if (!state.token) { show('#screen-gate'); return; }
  state.answers = new Array(12).fill(-1);
  state.idx = 0;
  show('#screen-quiz');
  renderQuestion();
}

function renderQuestion() {
  const qs = window.BW_QUESTIONS, i = state.idx, q = qs[i];
  $('#q-tag').textContent = `第 ${i + 1} 题 / 共 ${qs.length} 题`;
  $('#q-scene').textContent = q.scene;
  $('#q-now').textContent = i + 1;
  $('#progress-bar').style.width = ((i + 1) / qs.length * 100) + '%';

  const box = $('#options'); box.innerHTML = '';
  q.options.forEach((o, oi) => {
    const div = document.createElement('div');
    div.className = 'opt' + (state.answers[i] === oi ? ' sel' : '');
    div.innerHTML = `<span class="key">${o.key}</span><span>${o.text}</span>`;
    div.addEventListener('click', () => {
      state.answers[i] = oi;
      renderQuestion();
      if (i < qs.length - 1) setTimeout(() => { state.idx = i + 1; renderQuestion(); }, 220);
    });
    box.appendChild(div);
  });

  $('#btn-prev').style.visibility = i > 0 ? 'visible' : 'hidden';
  const answered = state.answers[i] >= 0;
  $('#btn-next').classList.toggle('hidden', !(answered && i < qs.length - 1));
  $('#btn-submit').classList.toggle('hidden', !(answered && i === qs.length - 1));
}

$('#btn-prev').addEventListener('click', () => { if (state.idx > 0) { state.idx--; renderQuestion(); } });
$('#btn-next').addEventListener('click', () => { if (state.idx < 12 - 1) { state.idx++; renderQuestion(); } });
$('#btn-submit').addEventListener('click', submitQuiz);

async function submitQuiz() {
  const btn = $('#btn-submit');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = '生成中…';
  try {
    const data = await rpc('bw_submit', { p_code: state.code, p_answers: state.answers, p_token: state.token, p_device: deviceId() }, 20000);
    if (!data || !data.ok) {
      if (data && data.deviceBlocked) {
        alert((data.msg || '本设备的测评机会已用完') + '\n如需更多机会，请联系管理员。');
        show('#screen-gate');
        state.token = '';
        $('#btn-start').classList.add('hidden');
        $('#pwd-input').value = state.code;
      } else if (data && data.retryable) {
        alert((data.msg || '答题会话已失效') + '\n重新验证后请重新作答（本次未扣次数）');
        show('#screen-gate');
        $('#pwd-input').value = state.code;
        state.token = '';
        $('#btn-verify').click();
      } else {
        alert((data && data.msg) || '提交失败，请重试');
      }
      return;
    }
    if (data.duplicate) toast('检测到重复提交，已为你返回原结果');
    await loadResult(data.resultId);
    history.replaceState(null, '', '?r=' + data.resultId);
  } catch (e) {
    alert(e.message + '\n答案已保留，点击「提交答卷」可安全重试');
  } finally {
    btn.disabled = false; btn.textContent = '提交答卷 ✓';
  }
}

/* ---------- 结果页 ---------- */
async function loadResult(id) {
  try {
    const data = await rpc('bw_result', { p_id: id }, 12000);
    if (!data || !data.ok) {
      $('#result-body').innerHTML = `<div class="card"><p>😕 ${(data && data.msg) || '报告加载失败'}</p>
        <button class="btn ghost" onclick="location.href=location.pathname">返回首页</button></div>`;
      show('#screen-result'); return;
    }
    state.result = {
      id: data.result.id,
      final: data.result.final,
      dims: data.result.dims,
      content: window.BW_RESULTS[data.result.resultKey]
    };
    renderResult();
    show('#screen-result');
    setTimeout(() => { const b = $('#conc-bar'); if (b) b.style.width = state.result.final + '%'; }, 100);
    try { generateImage(); } catch (e) { console.error(e); toast('长图生成失败，可点按钮重试'); }
  } catch (e) {
    $('#result-body').innerHTML = `<div class="card"><p>😕 ${e.message}</p>
      <button class="btn ghost" onclick="location.reload()">刷新重试</button></div>`;
    show('#screen-result');
  }
}

function dimLabel(k) { return { W: '工作渗透', E: '情绪损耗', S: '社交防御', R: '生活修复力' }[k]; }
function dimColor(k) { return { W: '#4f5df0', E: '#e5484d', S: '#e8862e', R: '#2f9e6e' }[k]; }

function renderResult() {
  const { final, dims, content } = state.result;
  if (!content) { $('#result-body').innerHTML = '<div class="card"><p>报告内容缺失</p></div>'; return; }
  const el = $('#result-body');
  el.innerHTML = `
    <div class="result-hero">
      <div class="rh-name">班味浓度检测报告</div>
      <div class="result-num">${final}<small>%</small></div>
      <div class="result-unit">你的班味浓度</div>
      <div class="conc-track"><div id="conc-bar"></div></div>
      <div class="conc-scale"><span>清新 0%</span><span>50%</span><span>陈年 99%</span></div>
      <div class="result-type">
        <span class="type-tag">🏷️ ${content.title}</span>
        <h2>${content.title}</h2>
        <div class="type-sub">${content.subtitle}</div>
      </div>
      <div class="share-bubble">💬 <b>${content.share}</b></div>
    </div>

    <div class="r-sec">
      <h3>你的班味成分</h3>
      ${['W','E','S','R'].map(k => {
        const max = k === 'R' ? 24 : 23;
        const v = dims[k] || 0;
        return `<div class="dim-row"><span class="d-name">${dimLabel(k)}</span>
          <span class="d-track"><span class="d-fill" style="width:${Math.min(100, v / max * 100)}%;background:${dimColor(k)}"></span></span>
          <span class="d-val">${v}</span></div>`;
      }).join('')}
      <div class="legend">工作渗透 / 情绪损耗 / 社交防御 越高班味越重；生活修复力是你的「排味系统」。</div>
    </div>

    <div class="r-sec"><h3>综合评价</h3><p>${content.evaluation}</p></div>
    <div class="r-sec"><h3>典型行为表现</h3><ul>${content.behaviors.map(b => `<li>${b}</li>`).join('')}</ul></div>
    <div class="r-sec"><h3>你的优势</h3><p>${content.strengths}</p></div>
    <div class="r-sec"><h3>潜在短板</h3><p>${content.weaknesses}</p></div>
    <div class="r-sec"><h3>一个熟悉的场景</h3><div class="case">${content.caseStory}</div></div>
    <div class="r-sec"><h3>改善建议</h3><ul>${content.tips.map(t => `<li>${t}</li>`).join('')}</ul></div>
  `;
}

/* ---------- 分享 ---------- */
$('#btn-copy').addEventListener('click', async () => {
  const link = location.origin + location.pathname + '?r=' + state.result.id;
  try { await navigator.clipboard.writeText(link); toast('链接已复制，快去分享吧'); }
  catch {
    try {
      const ta = document.createElement('textarea'); ta.value = link; document.body.appendChild(ta);
      ta.select(); document.execCommand('copy'); ta.remove(); toast('链接已复制');
    } catch { prompt('请手动复制链接：', link); }
  }
});
$('#btn-retry').addEventListener('click', () => {
  state.answers = []; state.idx = 0; state.token = '';
  $('#share-area').classList.add('hidden');
  $('#gate-msg').textContent = ''; $('#btn-start').classList.add('hidden');
  $('#pwd-input').value = state.code;
  history.replaceState(null, '', location.pathname);
  show('#screen-gate');
  $('#btn-verify').click();
});

/* ---------- 长图生成（Canvas 原生绘制） ---------- */
function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
  let line = '', lines = 0;
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW) {
      ctx.fillText(line, x, y); y += lineH; lines++; line = ch;
      if (maxLines && lines >= maxLines) { ctx.fillText(line + '…', x, y); return y + lineH; }
    } else line += ch;
  }
  if (line) { ctx.fillText(line, x, y); y += lineH; }
  return y;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function generateImage() {
  const { final, dims, content } = state.result;
  if (!content) return;
  const W = 750, pad = 48, innerW = W - pad * 2;
  const ctx = $('#share-canvas').getContext('2d');
  const sections = [
    { t: '综合评价', body: content.evaluation },
    { t: '典型行为表现', lines: content.behaviors },
    { t: '你的优势', body: content.strengths },
    { t: '潜在短板', body: content.weaknesses },
    { t: '一个熟悉的场景', body: content.caseStory },
    { t: '改善建议', lines: content.tips }
  ];
  const H = 900 + sections.reduce((a, s) => {
    if (s.body) return a + 66 + Math.ceil([...s.body].length / 20) * 42 + 10;
    return a + 66 + s.lines.reduce((x, l) => x + Math.ceil([...l].length / 20) * 42 + 16, 0);
  }, 0);
  ctx.canvas.width = W; ctx.canvas.height = H;

  ctx.fillStyle = '#f4f5fa'; ctx.fillRect(0, 0, W, H);
  const g = ctx.createLinearGradient(0, 0, W, 520);
  g.addColorStop(0, '#4f5df0'); g.addColorStop(.55, '#7a5cf0'); g.addColorStop(1, '#a44ff0');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, 520);
  ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.font = '600 26px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('🧪 班味浓度检测报告', W / 2, 74);
  ctx.font = '800 128px sans-serif'; ctx.fillStyle = '#fff';
  ctx.fillText(String(final), W / 2, 218);
  ctx.font = '600 34px sans-serif'; ctx.fillText('%  你的班味浓度', W / 2, 272);

  const barW = innerW - 40, barX = pad + 20;
  ctx.fillStyle = 'rgba(255,255,255,.25)'; roundRect(ctx, barX, 310, barW, 18, 9); ctx.fill();
  const bg2 = ctx.createLinearGradient(barX, 0, barX + barW, 0);
  bg2.addColorStop(0, '#ffe29a'); bg2.addColorStop(.5, '#ff8a5c'); bg2.addColorStop(1, '#ff5470');
  ctx.fillStyle = bg2; roundRect(ctx, barX, 310, Math.max(18, barW * final / 100), 18, 9); ctx.fill();
  ctx.font = '500 22px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillText('清新 0%', barX + 30, 356); ctx.fillText('陈年 99%', barX + barW - 40, 356);

  ctx.font = '700 46px sans-serif'; ctx.fillStyle = '#fff';
  ctx.fillText(content.title, W / 2, 428);
  ctx.font = '400 24px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.9)';
  ctx.fillText(content.subtitle, W / 2, 470);

  let y = 570; ctx.textAlign = 'left';
  ctx.fillStyle = '#fff'; roundRect(ctx, pad, y - 44, innerW, 260, 20); ctx.fill();
  ctx.font = '700 28px sans-serif'; ctx.fillStyle = '#22283a';
  ctx.fillText('你的班味成分', pad + 26, y);
  y += 18;
  const dimsDef = [['工作渗透', dims.W, 23, '#4f5df0'], ['情绪损耗', dims.E, 23, '#e5484d'], ['社交防御', dims.S, 23, '#e8862e'], ['生活修复力', dims.R, 24, '#2f9e6e']];
  for (const [name, v, max, color] of dimsDef) {
    y += 46;
    ctx.font = '600 23px sans-serif'; ctx.fillStyle = '#22283a';
    ctx.fillText(name, pad + 26, y);
    const tw = innerW - 26 * 2 - 150;
    ctx.fillStyle = '#e8eaf2'; roundRect(ctx, pad + 150, y - 15, tw, 14, 7); ctx.fill();
    ctx.fillStyle = color; roundRect(ctx, pad + 150, y - 15, Math.max(8, tw * (v || 0) / max), 14, 7); ctx.fill();
    ctx.font = '700 21px sans-serif'; ctx.fillStyle = '#69708a';
    ctx.fillText(String(v || 0), pad + 150 + tw + 16, y);
  }
  y += 60;

  const sec = (title, drawBody) => {
    ctx.font = '700 28px sans-serif'; ctx.fillStyle = '#4f5df0';
    ctx.fillText(title, pad, y); y += 16;
    ctx.font = '400 26px sans-serif'; ctx.fillStyle = '#22283a';
    y = drawBody() + 26;
  };
  for (const s of sections) {
    if (s.body) sec(s.t, () => wrapText(ctx, s.body, pad, y, innerW, 42));
    else sec(s.t, () => { for (const l of s.lines) { y = wrapText(ctx, '· ' + l, pad, y, innerW, 40) + 8; } return y - 8; });
  }

  ctx.font = '600 26px sans-serif'; ctx.fillStyle = '#4f5df0';
  y = wrapText(ctx, content.share, pad, y, innerW, 40);
  y += 16;
  ctx.font = '400 20px sans-serif'; ctx.fillStyle = '#a0a6bb'; ctx.textAlign = 'center';
  ctx.fillText('班味浓度检测 · 数据仅供娱乐 · 测完记得喝水', W / 2, Math.min(y + 10, H - 40));

  $('#share-area').classList.remove('hidden');
  $('#share-tip').textContent = '长按图片可保存或转发';
  if (navigator.canShare && $('#share-canvas').toBlob) {
    $('#share-canvas').toBlob(blob => {
      if (!blob) return;
      const file = new File([blob], 'banwei-result.png', { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        $('#btn-native-share').classList.remove('hidden');
        $('#btn-native-share').onclick = () => navigator.share({ files: [file], title: '我的班味浓度检测报告' }).catch(() => {});
        $('#share-tip').textContent = '点下方按钮可直接保存到相册或分享';
      }
    });
  }
}

$('#btn-image').addEventListener('click', () => {
  const area = $('#share-area');
  area.classList.toggle('hidden');
  if (!area.classList.contains('hidden')) {
    try { if (!$('#share-canvas').width) generateImage(); } catch { toast('长图生成失败，请稍后重试'); }
  }
  area.scrollIntoView({ behavior: 'smooth' });
});
$('#btn-download').addEventListener('click', () => {
  try {
    const a = document.createElement('a');
    a.download = `班味浓度检测报告-${state.result.final}%.png`;
    a.href = $('#share-canvas').toDataURL('image/png');
    a.click();
    toast('长图已开始下载');
  } catch { toast('下载失败，请长按图片保存'); }
});

function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = text; t.classList.add('show');
  clearTimeout(t._timer); t._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- 入口 ---------- */
/* ?r=<结果ID>  分享直达报告
   ?c=<密码>    自动填入测评密码（方便反复测试）
   ?c=<密码>&auto=1  自动填入并自动验证、直接进入答题 */
(function init() {
  const qs = new URLSearchParams(location.search);

  const rid = qs.get('r');
  if (rid) {
    show('#screen-result');
    $('#result-body').innerHTML = '<div class="card"><p>报告加载中…</p></div>';
    loadResult(rid);
    return;
  }

  const code = (qs.get('c') || '').trim().toUpperCase();
  if (/^BW-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    $('#pwd-input').value = code;
    const auto = String(qs.get('auto') || '').toLowerCase();
    if (auto === '1' || auto === 'true' || auto === 'yes') {
      pendingAuto = true;
      setTimeout(() => $('#btn-verify').click(), 120);
    } else {
      $('#pwd-input').focus();
      $('#gate-msg').className = 'msg';
      $('#gate-msg').textContent = '密码已自动填入，点击「验证密码」即可开始';
    }
  }
})();
