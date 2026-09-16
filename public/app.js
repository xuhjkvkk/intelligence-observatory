import { initializeTheme } from './theme.js';

const $ = selector => document.querySelector(selector);
const apiBase = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
if (apiBase) {
  $('.local-label').innerHTML = '<span class="dot"></span>在线观测站';
  $('.page-footer span:last-child').textContent = '独立部署 · 自动检测 · 自定义模型接口';
  document.querySelectorAll('small, .section-description, .settings-note, .switch-row p').forEach(element => {
    element.textContent = element.textContent.replaceAll('本机服务端', '服务器端').replaceAll('本地服务', '服务').replaceAll('本地保存', '服务器保存');
  });
}
const icons = {
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m9 3 1-1h4l1 3 3 1 3 1v4l-2 2 1 3-2 3-3-1-2 3h-4l-1-3-3-1-2-2 1-3-1-3 3-2z"/>',
  play: '<path d="m8 5 11 7-11 7z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>', check: '<path d="m5 12 4 4L19 6"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 13A8.5 8.5 0 0 1 11 3a9 9 0 1 0 9.5 10Z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/>',
  activity: '<path d="M2 12h4l3-9 6 18 3-9h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.activity}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[x]));
const number = value => Number(value || 0).toLocaleString('zh-CN');
const time = value => new Date(value).toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false });
const date = value => new Date(value).toLocaleString('zh-CN', { hour12:false });
let state = null, resultSignature = '', detail = null, selectedAttempt = 0, toastTimer;
let playing = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let busy = false, fetching = false, clearKey = false;

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(apiBase + path, { method, headers: body ? { 'Content-Type':'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}
function updateThemeButton() {
  const light = document.documentElement.classList.contains('light');
  $('#theme-toggle').innerHTML = icon(light ? 'moon' : 'sun');
  $('#theme-toggle').setAttribute('aria-label', light ? '切换深色主题' : '切换浅色主题');
}
initializeTheme(window, document, updateThemeButton);
$('#settings-button').innerHTML = icon('settings') + '检测设置';
$('#run-button').innerHTML = icon('play') + '立即检测';
$('#reveal-key').innerHTML = icon('eye');
document.querySelectorAll('.dialog-header .close-dialog').forEach(button => { button.innerHTML = icon('close'); });
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => { document.body.style.overflow = ''; });
});
function openDialog(dialog) { dialog.showModal(); document.body.style.overflow = 'hidden'; }

function badge(record) {
  let kind, label, glyph;
  if (record.status === 'running') { kind = ''; label = '正在检测'; glyph = 'clock'; }
  else if (record.status === 'failed') { kind = 'failed'; label = '生成失败'; glyph = 'alert'; }
  else if (record.status === 'flagged') { kind = 'flagged'; label = '需要进一步观察'; glyph = 'alert'; }
  else { kind = 'success'; label = record.review?.status === 'passed' ? '源码检查通过' : '格式检查通过'; glyph = 'check'; }
  return `<span class="badge ${kind}">${icon(glyph)}${label}</span>`;
}
function previewDocument(svg, animate) {
  // SVG was parsed and sanitized on the server. The iframe has an opaque origin,
  // zero script permissions and an independent CSP that forbids all requests.
  let safe = svg;
  if (!animate) safe = safe.replace(/<(animate|animateTransform|animateMotion|set)\b([^>]*?)(\/?)>/g,
    (_, tag, attrs, slash) => `<${tag}${attrs.replace(/\sbegin=(?:"[^"]*"|'[^']*')/gi, '')} begin="indefinite"${slash}>`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}body>svg{display:block;width:100%;height:100%}*{${animate ? '' : 'animation-play-state:paused!important;transition:none!important'}}</style></head><body>${safe}</body></html>`;
}
function mountFrame(container, svg, animate, title) {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('title', title); frame.setAttribute('tabindex', '-1'); frame.loading = 'lazy';
  frame.srcdoc = previewDocument(svg, animate); container.replaceChildren(frame);
}
function card(record, large) {
  return `<article class="observation-card" data-card="${esc(record.id)}" data-large="${large}">
    <button class="preview-button" data-open="${esc(record.id)}" aria-label="查看 ${esc(date(record.startedAt))} 的检测详情">
      <div class="preview-inner" data-preview="${esc(record.id)}">${record.svg ? '' : `<div class="failure-preview">${icon('activity')}<span>${record.status === 'failed' ? '生成失败' : '等待动画生成'}</span></div>`}</div><span class="expand">${icon('expand')}</span>
    </button><div class="card-body"><div class="card-main-line"><time datetime="${new Date(record.startedAt).toISOString()}">${time(record.startedAt)}</time>${badge(record)}</div><div class="card-meta"><span>${esc([record.animal, record.scene, record.style].filter(Boolean).join(' · ') || '—')}</span><span>${(record.latencyMs / 1000).toFixed(1)}s · ${number(record.outputTokens)} 输出 tokens</span></div></div></article>`;
}
function updatePlayButton() { $('#play-toggle').innerHTML = icon(playing ? 'pause' : 'play') + (playing ? '暂停动画' : '播放动画'); $('#play-toggle').setAttribute('aria-pressed', String(playing)); }
updatePlayButton();
function renderResults() {
  if (!state) return;
  const items = state.items.filter(item => item.status !== 'running');
  const signature = JSON.stringify(items.map(({ id, status, svg, outputTokens }) => ({ id, status, length: svg?.length, outputTokens }))) + playing + state.config.hasKey;
  if (signature === resultSignature) return; resultSignature = signature;
  const latest = items[0];
  if (!latest) {
    $('#results').innerHTML = `<div class="empty-state"><div class="empty-symbol">${icon('activity')}</div><h3>等待第一次检测</h3><p>下一次检测完成后，结果会自动出现在这里。<br>每次开启全新对话，让模型画出一幅动物骑行的动画。</p><button class="button" id="empty-action">${icon(state.config.hasKey ? 'play' : 'settings')}${state.config.hasKey ? '开始第一次检测' : '配置模型 API'}</button></div>`;
    $('#empty-action').addEventListener('click', state.config.hasKey ? run : openSettings); return;
  }
  $('#results').innerHTML = `<div class="featured">${card(latest, true)}<aside class="feature-info"><div><p class="eyebrow">最新一次检测</p><h3>${esc(latest.animal ? latest.animal + '骑自行车' : '每次检测，一幅新的动画')}</h3><p class="feature-description">每次开启全新对话，随机更换动物、场景、画风，并加入一次性校验码。</p></div><dl class="facts"><div><dt>模型</dt><dd>${esc(latest.model)}</dd></div><div><dt>推理强度</dt><dd>${esc(latest.effort === 'default' ? '默认' : latest.effort)}</dd></div><div><dt>输入 tokens</dt><dd>${number(latest.inputTokens)}</dd></div><div><dt>输出 tokens</dt><dd>${number(latest.outputTokens)}</dd></div></dl><p class="fine-print">这是视觉抽查，不是智商评分。格式检查通过不代表模型质量；请求失败也可能来自网络或渠道问题。</p></aside></div>${items.length > 1 ? `<div class="history-grid">${items.slice(1).map(item => card(item, false)).join('')}</div>` : ''}`;
  document.querySelectorAll('[data-preview]').forEach(container => {
    const item = items.find(item => item.id === container.dataset.preview);
    if (!item.svg) return;
    const article = container.closest('article'), large = article.dataset.large === 'true';
    mountFrame(container, item.svg, playing && large, `${item.animal}骑自行车 · ${item.scene}`);
    if (!large) {
      const button = article.querySelector('.preview-button');
      button.addEventListener('mouseenter', () => { if (playing) mountFrame(container, item.svg, true, `${item.animal}骑自行车`); });
      button.addEventListener('mouseleave', () => mountFrame(container, item.svg, false, `${item.animal}骑自行车`));
      button.addEventListener('focus', () => { if (playing) mountFrame(container, item.svg, true, `${item.animal}骑自行车`); });
      button.addEventListener('blur', () => mountFrame(container, item.svg, false, `${item.animal}骑自行车`));
    }
  });
  document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => openDetail(button.dataset.open)));
}
$('#play-toggle').addEventListener('click', () => { playing = !playing; updatePlayButton(); renderResults(); if ($('#detail-dialog').open) renderDetail(); });
function updateCountdown() {
  if (!state) return;
  const current = state.items.find(item => item.status === 'running');
  if (state.running) $('#countdown').textContent = current?.stage || '正在生成动画';
  else if (state.config.enabled && state.nextRun) {
    const seconds = Math.max(0, Math.ceil((state.nextRun - Date.now()) / 1000));
    const period = state.schedule?.period === 'night' ? '夜间' : '白天';
    $('#countdown').textContent = seconds ? `${period}模式 · 下次检测还有 ${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒` : '正在安排下一次检测';
  } else $('#countdown').textContent = '自动检测已暂停';
}
function renderState() {
  const c = state.config;
  $('#status-dot').className = `dot ${state.running ? 'running' : c.enabled ? 'active' : ''}`;
  $('#model-caption').textContent = `${c.model || '尚未配置模型'} · ${c.effort === 'default' ? '默认推理强度' : c.effort} · 白天 ${c.intervalMinutes} 分钟 / 夜间 ${c.intervalMinutes * 2} 分钟 · 北京时间`;
  $('#run-button').disabled = state.running || busy;
  $('#run-button').innerHTML = state.running ? '<span class="loader"></span>正在检测' : icon('play') + '立即检测';
  const missing = state.auth?.authenticated !== false && (!c.baseURL || !c.hasKey || !c.model);
  $('#connection-banner').hidden = !missing;
  if (missing) {
    $('#connection-banner').innerHTML = `<span>接入自己的模型 API，开启你的第一轮动画观测。</span><button class="button small" id="connect-now">${icon('settings')}配置接口</button>`;
    $('#connect-now').addEventListener('click', openSettings);
  }
  $('#running-strip').hidden = !state.running;
  if (state.running) {
    const current = state.items.find(item => item.status === 'running');
    $('#running-strip').innerHTML = `<span class="running-stage"><span class="loader"></span>${esc(current?.stage || '正在检测')}<span class="muted">${current ? Math.floor((Date.now() - current.startedAt) / 1000) + 's' : ''}</span></span><button class="button small" id="stop-run">${icon('stop')}停止</button>`;
    $('#stop-run').addEventListener('click', async () => { if (!await requireAdmin()) return; try { await api('/api/stop', { method:'POST', body:{} }); toast('正在停止检测'); } catch(error) { toast(error.message); } });
  }
  $('#error-banner').hidden = !state.lastError;
  if (state.lastError) $('#error-banner').textContent = state.lastError;
  updateCountdown(); renderResults();
}
async function refresh() {
  if (fetching) return; fetching = true;
  try {
    state = await api('/api/state'); renderState();
    if ($('#detail-dialog').open && detail?.status === 'running') { detail = await api(`/api/observations/${detail.id}`); renderDetail(); }
  } catch (error) { $('#error-banner').hidden = false; $('#error-banner').textContent = `无法连接本地服务：${error.message}。请确认 npm start 正在运行。`; }
  finally { fetching = false; }
}
async function run() {
  if (!state || busy) return;
  if (!await requireAdmin()) return;
  if (!state.config.baseURL || !state.config.hasKey || !state.config.model) { openSettings(); toast('请先配置 API 地址、密钥和模型'); return; }
  busy = true; $('#run-button').disabled = true;
  try { await api('/api/run', { method:'POST', body:{} }); toast('检测已开始'); }
  catch (error) { toast(error.message); }
  finally { busy = false; await refresh(); }
}
$('#run-button').addEventListener('click', run);

async function openSettings() {
  if (!state) { toast('等待本地服务连接'); return; }
  if (!await requireAdmin()) return;
  const form = $('#settings-form');
  for (const [key, value] of Object.entries(state.config)) {
    const input = form.elements.namedItem(key); if (!input || key === 'apiKey') continue;
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
  }
  form.elements.apiKey.value = ''; form.elements.apiKey.type = 'password';
  form.elements.apiKey.placeholder = state.config.hasKey ? '已保存密钥 · 留空保持不变' : '输入 API Key';
  $('#key-help').textContent = state.config.hasKey ? `密钥已保存在${apiBase ? '服务器端' : '本机服务端'}，页面不会回显。留空可保持原密钥。` : '密钥只用于向你指定的 Base URL 发起请求。';
  $('#clear-key').disabled = !state.config.hasKey;
  $('#settings-error').hidden = true; $('#model-load-status').textContent = '';
  $('#save-settings').disabled = state.running;
  if (state.running) { $('#settings-error').textContent = '检测正在运行，完成后才能修改配置。'; $('#settings-error').hidden = false; }
  clearKey = false; updateProtocolField(); openDialog($('#settings-dialog'));
}
$('#settings-button').addEventListener('click', openSettings);
$('#header-settings').addEventListener('click', openSettings);
let pendingLogin;
async function requireAdmin() {
  try {
    const auth = await api('/api/auth');
    if (auth.authenticated) {
      if (state?.auth?.authenticated === false) await refresh();
      return true;
    }
    if (pendingLogin) return false;
    $('#admin-password').value = ''; $('#auth-error').hidden = true;
    openDialog($('#auth-dialog'));
    return await new Promise(resolve => { pendingLogin = resolve; });
  } catch(error) { toast(error.message); return false; }
}
$('#auth-dialog').addEventListener('close', () => { if (pendingLogin) { pendingLogin(false); pendingLogin = null; } });
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#auth-submit').disabled = true; $('#auth-error').hidden = true;
  try {
    await api('/api/auth/login', { method:'POST', body:{ password:$('#admin-password').value } });
    $('#admin-password').value = ''; await refresh();
    const resolve = pendingLogin; pendingLogin = null; $('#auth-dialog').close(); resolve?.(true);
    toast('管理权限已解锁，有效期 1 小时');
  } catch(error) { $('#auth-error').textContent = error.message; $('#auth-error').hidden = false; }
  finally { $('#auth-submit').disabled = false; }
});
$('#logout-admin').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method:'POST', body:{} }); $('#settings-dialog').close(); await refresh(); toast('已退出管理'); }
  catch(error) { toast(error.message); }
});
function updateProtocolField() { $('#token-param-field').hidden = $('#settings-form').elements.protocol.value === 'responses'; }
$('#settings-form').elements.protocol.addEventListener('change', updateProtocolField);
$('#reveal-key').addEventListener('click', () => {
  const input = $('#settings-form').elements.apiKey; input.type = input.type === 'password' ? 'text' : 'password';
  $('#reveal-key').setAttribute('aria-label', input.type === 'password' ? '显示密钥' : '隐藏密钥');
});
$('#clear-key').addEventListener('click', () => { clearKey = true; $('#settings-form').elements.apiKey.value = ''; $('#key-help').textContent = '保存设置时将清除旧密钥。'; $('#settings-form').elements.enabled.checked = false; });
$('#settings-form').elements.apiKey.addEventListener('input', () => { if ($('#settings-form').elements.apiKey.value) clearKey = false; });
$('#load-models').addEventListener('click', async () => {
  const button = $('#load-models'); button.disabled = true; $('#model-load-status').textContent = '正在读取…';
  try {
    const { models } = await api('/api/models');
    $('#model-list').replaceChildren(...models.map(model => { const option = document.createElement('option'); option.value = model; return option; }));
    $('#model-load-status').textContent = `找到 ${models.length} 个模型，可在模型输入框选择。`;
  } catch (error) { $('#model-load-status').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
  for (const key of ['enabled', 'aiReview']) values[key] = form.elements[key].checked;
  for (const key of ['intervalMinutes', 'timeoutSeconds', 'maxOutputTokens', 'retries']) values[key] = Number(values[key]);
  values.clearKey = clearKey;
  $('#save-settings').disabled = true; $('#save-settings').textContent = '正在保存…'; $('#settings-error').hidden = true;
  try {
    await api('/api/config', { method:'PUT', body:values });
    form.elements.apiKey.value = ''; $('#settings-dialog').close(); toast('设置已保存'); await refresh();
  } catch (error) { $('#settings-error').textContent = error.message; $('#settings-error').hidden = false; $('#settings-error').scrollIntoView({ block:'nearest' }); }
  finally { $('#save-settings').disabled = false; $('#save-settings').textContent = '保存设置'; }
});

async function openDetail(id) {
  $('#detail-content').innerHTML = '<div class="empty-state"><span class="loader"></span><h3>正在加载检测详情…</h3></div>';
  $('#detail-date').textContent = ''; openDialog($('#detail-dialog'));
  try { detail = await api(`/api/observations/${encodeURIComponent(id)}`); selectedAttempt = detail.attempts.length - 1; renderDetail(); }
  catch (error) { $('#detail-content').textContent = error.message; }
}
function renderDetail() {
  if (!detail) return;
  const a = detail.attempts[selectedAttempt] || detail;
  $('#detail-date').textContent = date(detail.startedAt);
  const checks = { animal:'动物', bicycle:'自行车', motion:'踩踏动画', scene:'场景', style:'画风' };
  $('#detail-content').innerHTML = `${detail.attempts.length ? `<div class="attempt-tabs">${detail.attempts.map((attempt,index) => `<button class="button small ${index === selectedAttempt ? 'selected' : ''}" data-attempt="${index}">第 ${attempt.number} 次检测 ${attempt.status === 'succeeded' ? '✓' : attempt.status === 'running' ? '…' : '!'}</button>`).join('')}</div>` : ''}<div class="detail-preview" id="detail-preview">${a.svg ? '' : `<div class="failure-preview">${icon('activity')}<span>${a.status === 'running' ? '等待动画生成' : '没有可预览的动画'}</span></div>`}</div><div class="detail-line">${badge(a)}<div class="heading-actions"><button class="button small" id="detail-play">${icon(playing ? 'pause' : 'play')}${playing ? '暂停动画' : '播放动画'}</button><button class="button small" id="download-svg" ${a.svg ? '' : 'disabled'}>${icon('download')}下载 SVG</button></div></div><p class="detail-meta">${esc(detail.model)} · ${esc(detail.effort)} · ${((a.latencyMs || 0) / 1000).toFixed(1)}s<br>本轮总计：输入 ${number(detail.inputTokens)} · 输出 ${number(detail.outputTokens)} · 推理 ${number(detail.reasoningTokens)} tokens</p>${a.error || a.signals?.length ? `<div class="issue-list">${a.error ? `<p>${esc(a.error)}</p>` : ''}${(a.signals || []).map(s => `<p>${esc(s)}</p>`).join('')}</div>` : ''}${a.review ? `<div class="review-box"><h3>AI 源码检查 · ${esc(a.review.model)}</h3><p>${esc(a.review.summary)}</p>${a.review.checks ? `<div class="checks">${Object.entries(checks).map(([key,label]) => `<span class="badge ${a.review.checks[key] ? 'success' : 'flagged'}">${icon(a.review.checks[key] ? 'check' : 'alert')}${label}</span>`).join('')}</div>` : ''}</div>` : '<p class="fine-print">本次未进行 AI 源码复核。格式检查仅确认 SVG、动画声明和随机校验码，不判断实际画面质量。</p>'}<details class="detail-section"><summary>提示词与校验信息</summary><pre>${esc(a.prompt || detail.prompt || '')}</pre><p class="hash">SHA-256: ${esc(a.fingerprint || '—')}</p></details><details class="detail-section"><summary>模型原始输出</summary><pre>${esc(a.raw || '暂无输出')}</pre></details>`;
  if (a.svg) mountFrame($('#detail-preview'), a.svg, playing, `${a.animal || detail.animal}骑自行车：检测结果`);
  document.querySelectorAll('[data-attempt]').forEach(button => button.addEventListener('click', () => { selectedAttempt = Number(button.dataset.attempt); renderDetail(); }));
  $('#detail-play').addEventListener('click', () => { playing = !playing; updatePlayButton(); renderResults(); renderDetail(); });
  $('#download-svg').addEventListener('click', () => {
    if (!a.svg) return;
    const url = URL.createObjectURL(new Blob([a.svg], { type:'image/svg+xml' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `observation-${detail.id.slice(0,8)}-attempt-${a.number || 1}.svg`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

await refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 2500);
setInterval(updateCountdown, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
