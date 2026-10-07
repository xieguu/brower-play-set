/* ==========================================================================
   Browser Play Set — 前端应用
   无框架、零构建：原生 ES Module + fetch + EventSource。
   ========================================================================== */

import { cleanError, explainError } from './errors.js';
/* ------------------------------ 工具函数 ------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
const icon = name => `<i data-lucide="${name}"></i>`;
const drawIcons = () => window.lucide.createIcons();
const ACTIVE_RUNS = new Set(['queued', 'launching', 'running', 'cancelling']);

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function initials(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const cjk = s.match(/[一-龥]/g);
  if (cjk) return cjk.slice(0, 2).join('');
  return s.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}

function timeAgo(iso) {
  if (!iso) return '从未运行';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------ 状态 ------------------------------ */
const state = {
  profiles: [],
  tasks: [],
  settings: {},
  runs: new Map(),
  logs: [],
  selected: new Set(),
  filter: '',
  logFilter: '',
  logLevel: 'info',
  logFollow: true,
  editingId: null,
  editingTaskId: null,
  deletingId: null,
  mcpProfileId: null,
  logProfile: '',
  statusFilter: 'all',
  view: 'profiles',
  layout: 'grid',
  profileErrors: new Map(),
  previews: new Map(),
  previewPending: new Set(),
  metrics: { cpu: [], memory: [] },
  importDocument: null,
};

/* ------------------------------ API ------------------------------ */
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `请求失败（${res.status}）`);
  }
  return res.status === 204 ? null : res.json();
}

const guarded = fn => event => Promise.resolve().then(() => fn(event)).catch(error => toast(error.message, 'error'));

async function openSelectedBrowsers() {
  if (!state.selected.size) return;
  await api('/run', { method: 'POST', body: {
    profileIds: [...state.selected], taskId: 'open-only', concurrency: Number($('#runConcurrency').value),
    keepOpen: true, reuseBrowser: true,
  } });
  toast('所选浏览器已加入打开队列', 'success');
  await loadProfiles();
}

function openTaskEditor(definition = null, editingId = null) {
  state.editingTaskId = editingId;
  $('#taskEditorError').textContent = '';
  $('#taskEditorTitle').textContent = editingId ? `编辑任务 · ${editingId}` : '新建 JSON 任务';
  const task = definition || {
    id: `custom-${Date.now().toString(36)}`, name: '自定义任务', description: '',
    steps: [{ action: 'open', url: '{{url}}' }, { action: 'read', saveAs: 'page' }, { action: 'screenshot', name: 'page.png', fullPage: true }],
  };
  $('#taskJson').value = JSON.stringify(task, null, 2);
  $('#taskEditor').showModal();
}

async function editTask(id) {
  const { kind, source, ...task } = await api(`/tasks/${encodeURIComponent(id)}`);
  if (source === `${id}.json`) openTaskEditor(task, id);
  else openTaskEditor({ ...task, id: `${id.slice(0, 55)}-copy-${Date.now().toString(36)}`, name: `${task.name.slice(0, 90)} 副本` });
}

async function saveTaskDefinition(event) {
  event.preventDefault();
  $('#saveTaskBtn').disabled = true;
  $('#taskEditorError').textContent = '';
  try {
    const definition = JSON.parse($('#taskJson').value);
    const editing = state.editingTaskId === definition.id;
    await api(editing ? `/tasks/${encodeURIComponent(definition.id)}` : '/tasks', { method: editing ? 'PUT' : 'POST', body: definition });
    await loadTasks(); $('#taskEditor').close(); toast('任务已校验并保存', 'success');
  } catch (error) { $('#taskEditorError').textContent = error.message; }
  finally { $('#saveTaskBtn').disabled = false; }
}

async function showMcp(id) {
  state.mcpProfileId = id;
  $('#mcpConfig').value = JSON.stringify(await api(`/profiles/${id}/mcp-config`), null, 2);
  $('#mcpTitle').textContent = `Playwright MCP · ${state.profiles.find(p => p.id === id)?.name || id}`;
  $('#mcpDialog').showModal();
}

async function showRunDetail(id) {
  const run = await api(`/runs/${encodeURIComponent(id)}`);
  $('#runDetailTitle').textContent = `${run.profileName} · ${run.taskName}`;
  $('#runDetailBody').innerHTML = `
    <dl class="kv"><dt>状态</dt><dd>${escapeHtml(run.status)}</dd><dt>运行 ID</dt><dd>${escapeHtml(run.runId)}</dd><dt>产物目录</dt><dd>${escapeHtml(run.outputDir)}</dd></dl>
    ${run.error ? `<p class="error-summary">${escapeHtml(explainError(run.error))}</p><details><summary>原始错误详情</summary><pre class="raw-error">${escapeHtml(cleanError(run.error))}</pre></details>` : ''}
    <div class="artifact-list">${(run.artifacts || []).map((artifact, index) => `<a class="btn ghost" href="/api/runs/${encodeURIComponent(id)}/artifacts/${index}" download>${escapeHtml(artifact.name)}</a>`).join('') || '<p class="muted">此运行没有生成文件。</p>'}</div>
    <pre id="runResultPreview" class="result-preview" hidden></pre>`;
  $('#runDetail').showModal();
  const resultIndex = (run.artifacts || []).findIndex(artifact => artifact.type === 'result');
  if (resultIndex >= 0) {
    const result = await api(`/runs/${encodeURIComponent(id)}/artifacts/${resultIndex}`);
    $('#runResultPreview').hidden = false;
    $('#runResultPreview').textContent = JSON.stringify(result, null, 2);
  }
}

/* ------------------------------ 提示 ------------------------------ */
function toast(message, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    setTimeout(() => el.remove(), 320);
  }, 2600);
}

/* ------------------------------ 视图切换 ------------------------------ */
function switchView(name) {
  if (!['profiles', 'run', 'tasks', 'proxies', 'logs', 'settings'].includes(name)) name = 'profiles';
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => {
    const on = t.dataset.view === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', String(on));
  });
  location.hash = name;
  closeCardMenu();
  if (name === 'profiles') refreshPreviews();
}

/* ==========================================================================
   Profile 渲染
   ========================================================================== */
function statusBadge(p) {
  if (p.activity?.kind === 'remote') return '<span class="badge primary">手动操作中</span>';
  if (p.activity?.kind === 'mcp') return '<span class="badge primary">MCP 已连接</span>';
  if (p.activity?.kind === 'task') return '<span class="badge primary"><span class="pulse"></span>任务处理中</span>';
  if (p.running) return '<span class="badge success"><span class="dot green"></span>运行中</span>';
  const map = {
    success: ['', '已停止'],
    error: ['error', '异常'],
    idle: ['', '已停止'],
    cancelled: ['warn', '已取消'],
  };
  const [cls, label] = map[p.lastStatus] || map.idle;
  return `<span class="badge ${cls}">${label}</span>`;
}

/** 卡片上的标签集合（状态 / 任务 / 代理 / 无头） */
function tagsHtml(p) {
  return [
    statusBadge(p),
    `<span class="badge">${escapeHtml(p.taskId)}</span>`,
    p.proxy?.server ? '<span class="badge">代理</span>' : '',
    p.headless ? '<span class="badge">后台</span>' : '',
  ].join('');
}

/** 单个 Profile 运行结束后刷新其状态标签 */
async function refreshProfileStatus(profileId) {
  try {
    const list = await api('/profiles');
    state.profiles = list;
    renderProfiles(); renderProxies();
  } catch (error) { toast(error.message, 'error'); }
}

function renderStats() {
  const total = state.profiles.length;
  const opened = state.profiles.filter(p => p.running).length;
  const failed = state.profiles.filter(p => profileProblem(p)).length;
  const items = [[opened, '运行中', 'green'], [total - opened, '已停止', ''], [failed, '最近发生异常', 'red'], [total, '实例总数', 'blue']];
  $('#profileStats').innerHTML = items.map(([value, label, color]) => `<div class="stat-row"><span class="dot ${color}"></span>${label}<strong>${value}</strong></div>`).join('');
  for (const [id, value] of Object.entries({ navProfileCount: total, filterAllCount: total, filterOpenCount: opened, filterIdleCount: total - opened, filterErrorCount: failed })) $(`#${id}`).textContent = value;
}

function profileProblem(p) {
  if (state.profileErrors.has(p.id)) return state.profileErrors.get(p.id);
  if (p.lastStatus !== 'error') return '';
  const recent = [...state.runs.values()].filter(r => r.profileId === p.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  return recent?.error || '上次任务失败，请到运行控制台查看详情';
}

function visibleProfiles() {
  const kw = state.filter.trim().toLowerCase();
  return state.profiles.filter(p => (!kw || `${p.name} ${p.url} ${p.taskId}`.toLowerCase().includes(kw)) &&
    (state.statusFilter === 'all' || state.statusFilter === 'open' && p.running || state.statusFilter === 'idle' && !p.running || state.statusFilter === 'error' && profileProblem(p)));
}

function siteName(p) {
  try { return new URL(p.url).hostname || '空白页'; } catch { return '未设置网址'; }
}

function renderProfiles() {
  const grid = $('#profileGrid');
  const list = visibleProfiles();

  grid.innerHTML = '';
  $('#profileEmpty').hidden = state.profiles.length > 0;
  $('#noMatches').hidden = !state.profiles.length || list.length > 0;
  grid.classList.toggle('list-layout', state.layout === 'list');

  for (const p of list) {
    const card = document.createElement('article');
    card.className = `profile-card${state.selected.has(p.id) ? ' selected' : ''}`;
    card.dataset.id = p.id;
    const problem = profileProblem(p);
    const frame = state.previews.get(p.id);
    const number = String(state.profiles.indexOf(p) + 1).padStart(2, '0');
    card.innerHTML = `
      <div class="pc-head"><label class="check"><input type="checkbox" data-select aria-label="选择 ${escapeHtml(p.name)}" ${state.selected.has(p.id) ? 'checked' : ''} /></label><span class="pc-number">${number}</span><div class="pc-title">${icon('globe')}<strong title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</strong></div><span class="pc-status">${statusBadge(p)}</span><button class="icon-btn" data-act="more" title="更多" aria-label="${escapeHtml(p.name)} 的更多操作">${icon('ellipsis')}</button></div>
      <div class="pc-address">${icon('globe-2')}<span title="${escapeHtml(p.url)}">${escapeHtml(p.url || '未设置网址')}</span></div>
      <button class="pc-preview" data-act="${p.running ? 'focus' : 'launch'}" ${!p.running && p.activity ? 'disabled' : ''} aria-label="${p.running ? '查看' : '打开'} ${escapeHtml(p.name)} 的浏览器">
        <img alt="${escapeHtml(p.name)} 的浏览器预览" ${p.running && frame?.url ? `src="${frame.url}"` : 'hidden'} />
        <span class="preview-placeholder" ${p.running && frame?.url ? 'hidden' : ''}><span class="site-monogram">${escapeHtml(initials(siteName(p)))}</span><strong>${escapeHtml(siteName(p))}</strong><small>${p.running ? '正在获取实时预览' : '浏览器已停止 · 点击打开'}</small></span>
        <span class="preview-hint" ${p.running && frame?.url ? '' : 'hidden'}>${$('#previewEnabled').checked ? '实时预览 · 点击操作' : '预览已暂停'}</span>
      </button>
      ${problem ? `<div class="profile-error-line" title="${escapeHtml(explainError(problem))}">${icon('circle-alert')}<span>${escapeHtml(explainError(problem))}</span></div>` : ''}
      <div class="pc-foot"><span class="pc-network" title="${escapeHtml(p.proxy?.server || '使用当前运行账号的系统网络设置')}">${icon(p.proxy ? 'shield-check' : 'network')}<span>${p.proxy ? '独立代理' : '系统网络'}</span></span><button class="btn sm ghost" data-act="${p.running || p.activity ? 'close' : 'launch'}">${icon(p.running || p.activity ? 'square' : 'play')}${p.running || p.activity ? '停止' : '打开'}</button><button class="btn sm ghost" data-act="run" ${p.activity ? 'disabled' : ''}>${icon('circle-play')}任务</button><button class="btn sm ghost" data-act="edit" ${p.running || p.activity ? 'disabled title="停止实例后可修改配置"' : ''}>${icon('settings-2')}配置</button></div>`;
    grid.appendChild(card);
  }
  if (state.profiles.length && !state.filter && state.statusFilter === 'all') {
    const create = document.createElement('button'); create.className = 'create-tile';
    create.innerHTML = `${icon('plus')}<span>新建后台实例</span><small>一个实例，一个独立工作空间</small>`;
    create.addEventListener('click', () => openDrawer()); grid.appendChild(create);
  }
  updateSelectedCount();
  renderStats();
  drawIcons();
  refreshPreviews();
}

function updateSelectedCount() {
  $('#selectedCount').textContent = `已选 ${state.selected.size} 个`;
  $('#batchRunBtn').disabled = state.selected.size === 0;
  $('#batchLaunchBtn').disabled = state.selected.size === 0;
  $('#batchStopBtn').disabled = !state.profiles.some(p => state.selected.has(p.id) && (p.running || p.activity));
  const visible = visibleProfiles();
  const all = visible.length > 0 && visible.every((p) => state.selected.has(p.id));
  $('#selectAll').checked = all;
  $('#selectAll').indeterminate = !all && visible.some(p => state.selected.has(p.id));
}

/* ==========================================================================
   运行视图
   ========================================================================== */
function renderRunChips() {
  const box = $('#runProfileChips');
  if (!state.profiles.length) {
    box.innerHTML = '<span class="muted">请先在 Profile 页创建</span>';
    return;
  }
  box.innerHTML = state.profiles.map((p) => `
    <button type="button" class="chip ${state.selected.has(p.id) ? 'is-on' : ''}" aria-pressed="${state.selected.has(p.id)}" data-id="${escapeHtml(p.id)}">
      <span class="dot" style="background:${escapeHtml(p.color || '#4f8cff')}"></span>
      ${escapeHtml(p.name)}
    </button>
  `).join('');
}

function renderTaskOptions() {
  const runValue = $('#runTask').value;
  const profileValue = $('#pfTask').value;
  const opts = state.tasks.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join('');
  $('#runTask').innerHTML = '<option value="">按各 Profile 的任务运行</option>' + opts;
  $('#pfTask').innerHTML = opts;
  if (state.tasks.some(t => t.id === runValue)) $('#runTask').value = runValue;
  if (state.tasks.some(t => t.id === profileValue)) $('#pfTask').value = profileValue;
}

function renderRuns() {
  const list = [...state.runs.values()].sort((a, b) => b.createdAt - a.createdAt);
  const box = $('#runList');
  $('#runEmpty').hidden = list.length > 0;
  const active = list.filter((r) => ['queued', 'launching', 'running', 'cancelling'].includes(r.status)).length;
  $('#runSummary').textContent = active ? `${active} 个进行中` : '';

  box.innerHTML = list.slice(0, 40).map((r) => {
    const running = ['queued', 'launching', 'running', 'cancelling'].includes(r.status);
    const label = { queued: '排队', launching: '启动浏览器', running: '执行中', cancelling: '正在取消', cancelled: '已取消', success: '完成', error: '失败' }[r.status] || r.status;
    const cls = { success: 'success', error: 'error', running: 'primary', launching: 'primary', queued: '' }[r.status] || '';
    return `
      <div class="run-row" data-run-id="${escapeHtml(r.runId)}" data-status="${escapeHtml(r.status)}">
        ${running ? '<span class="spinner"></span>' : ''}
        <div style="min-width:0">
          <div class="name">${escapeHtml(r.profileName || r.profileId)}</div>
          <div class="meta">${escapeHtml(r.taskName || r.taskId || '')}${r.error ? ` · ${escapeHtml(explainError(r.error))}` : ''}</div>
          ${running ? `<div class="step-meta">${r.step || 0}/${r.totalSteps || 1} · ${escapeHtml(r.stepLabel || label)}</div><progress value="${r.step || 0}" max="${r.totalSteps || 1}" aria-label="任务进度"></progress>` : ''}
        </div>
        <span class="spacer"></span>
        <span class="badge ${cls}">${label}</span>
        ${running ? `<button class="btn sm ghost" data-cancel-run="${escapeHtml(r.runId)}" ${r.status === 'cancelling' ? 'disabled' : ''}>取消</button>` : `<button class="btn sm ghost" data-run-detail="${escapeHtml(r.runId)}">详情 / 产物</button>`}
      </div>
    `;
  }).join('');
  renderQueue();
}

function renderQueue() {
  const list = [...state.runs.values()].sort((a, b) => Number(ACTIVE_RUNS.has(b.status)) - Number(ACTIVE_RUNS.has(a.status)) || b.createdAt - a.createdAt).slice(0, 4);
  const labels = { queued: '等待中', launching: '启动中', running: '执行中', cancelling: '取消中', cancelled: '已取消', success: '已完成', error: '失败' };
  $('#dashboardQueue').innerHTML = list.map(r => `<div class="queue-item"><span class="dot ${r.status === 'error' ? 'red' : r.status === 'success' ? 'green' : 'blue'}"></span><div><strong title="${escapeHtml(r.taskName)}">${escapeHtml(r.taskName)}</strong><small>${escapeHtml(r.profileName)} · ${fmtTime(r.createdAt)}</small></div><span class="badge ${r.status === 'error' ? 'error' : r.status === 'success' ? 'success' : 'primary'}">${labels[r.status] || escapeHtml(r.status)}</span></div>`).join('') || '<p class="queue-empty">暂无任务<br><small>执行后的任务会显示在这里</small></p>';
}

function renderProxies() {
  $('#proxyTableBody').innerHTML = state.profiles.map(p => `<tr><td><strong>${escapeHtml(p.name)}</strong></td><td>${p.proxy ? '独立代理' : '系统网络'}</td><td>${escapeHtml(p.proxy?.server || '跟随运行账号的网络设置')}</td><td>${p.proxy?.username ? '已配置' : '无'}</td><td>${statusBadge(p)}</td><td><button class="btn sm ghost" data-edit-proxy="${p.id}" ${p.running || p.activity ? 'disabled title="请先停止此实例"' : ''}>配置代理</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">创建实例后可在这里管理代理。</td></tr>';
}

function renderDockLogs() {
  const box = $('#dockLogBox');
  const position = box.scrollTop;
  const logs = state.logs.filter(entry => LEVEL_RANK[entry.level] >= LEVEL_RANK[$('#dockLogLevel').value]).slice(-100);
  $('#dockLogCount').textContent = `${logs.length} 条`;
  box.innerHTML = logs.map(entry => `<div class="log-line ${escapeHtml(entry.level)}"><span class="ts">${fmtTime(entry.time)}</span><span class="lvl">${escapeHtml(entry.level.toUpperCase())}</span>${entry.profileName ? `<span class="scope">${escapeHtml(entry.profileName)}</span>` : ''}<span class="msg" title="${escapeHtml(cleanError(entry.message))}">${escapeHtml(cleanError(entry.message))}</span></div>`).join('') || '<p class="queue-empty">等待操作，运行日志会实时显示在这里。</p>';
  box.scrollTop = $('#dockLogFollow').checked ? box.scrollHeight : position;
}

function chart(name, values) {
  const points = values.map((value, index) => `${(index * 240 / Math.max(values.length - 1, 1)).toFixed(1)},${(42 - Math.min(100, Math.max(0, value)) * .4).toFixed(1)}`);
  const line = points.length ? `M${points.join(' L')}` : '';
  $(`#${name}Line`).setAttribute('d', line);
  $(`#${name}Area`).setAttribute('d', line ? `${line} L${values.length > 1 ? 240 : 0},44 L0,44 Z` : '');
}

async function refreshMetrics() {
  if (document.hidden || state.view !== 'profiles') return;
  try {
    const data = await api('/system');
    $('#cpuValue').textContent = data.cpuPercent == null ? '采样中' : `${data.cpuPercent}%`;
    $('#memoryValue').textContent = `${(data.memory.used / 1024 ** 3).toFixed(1)} / ${(data.memory.total / 1024 ** 3).toFixed(1)} GB`;
    $('#processMemory').textContent = `${Math.round(data.processMemory / 1024 ** 2)} MB`;
    const minutes = Math.floor(data.uptime / 60);
    $('#serviceUptime').textContent = minutes < 60 ? `${minutes} 分 ${data.uptime % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
    if (data.cpuPercent != null) state.metrics.cpu.push(data.cpuPercent);
    state.metrics.memory.push(data.memory.used / data.memory.total * 100);
    for (const name of ['cpu', 'memory']) { state.metrics[name] = state.metrics[name].slice(-40); chart(name, state.metrics[name]); }
    $('#metricsStatus').innerHTML = '<span class="dot green"></span>实时';
    $('#metricsStatus').removeAttribute('title');
  } catch (error) {
    $('#metricsStatus').textContent = '采集失败'; $('#metricsStatus').title = error.message;
    for (const id of ['cpuValue', 'memoryValue', 'processMemory', 'serviceUptime']) $(`#${id}`).textContent = '—';
  }
}

async function updatePreview(card) {
  const id = card.dataset.id;
  if (state.previewPending.has(id)) return;
  state.previewPending.add(id);
  try {
    const response = await fetch(`/api/profiles/${id}/preview`, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
    if (!response.ok) { const error = await response.json(); throw new Error(error.error); }
    const blob = await response.blob();
    if (!state.profiles.find(p => p.id === id)?.running || !$('#previewEnabled').checked) return;
    const url = URL.createObjectURL(blob);
    const old = state.previews.get(id);
    state.previews.set(id, { url });
    if (old?.url) URL.revokeObjectURL(old.url);
    const current = $(`.profile-card[data-id="${id}"]`);
    if (!current) return;
    const img = $('.pc-preview img', current); img.src = url; img.hidden = false;
    $('.preview-placeholder', current).hidden = true; $('.preview-hint', current).hidden = false; $('.preview-hint', current).textContent = '实时预览 · 点击操作';
  } catch (error) {
    const old = state.previews.get(id);
    if (old?.url) URL.revokeObjectURL(old.url);
    state.previews.delete(id);
    const current = $(`.profile-card[data-id="${id}"]`);
    if (!current) return;
    $('.pc-preview img', current).hidden = true; $('.preview-hint', current).hidden = true;
    $('.preview-placeholder', current).hidden = false;
    $('.preview-placeholder small', current).textContent = `预览不可用：${explainError(error.message)}`;
  } finally { state.previewPending.delete(id); }
}

async function refreshPreviews() {
  if (document.hidden || state.view !== 'profiles' || !$('#previewEnabled').checked || state.layout === 'list') return;
  const cards = $$('.profile-card').filter(card => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && state.profiles.find(p => p.id === card.dataset.id)?.running;
  });
  for (let i = 0; i < cards.length; i += 3) await Promise.all(cards.slice(i, i + 3).map(updatePreview));
}

async function stopSelectedBrowsers() {
  const selected = state.profiles.filter(p => state.selected.has(p.id) && (p.running || p.activity));
  $('#batchStopBtn').disabled = true;
  const results = await Promise.allSettled(selected.map(stopProfile));
  results.forEach((result, i) => { if (result.status === 'rejected') toast(`${selected[i].name}：${result.reason.message}`, 'error'); });
  const count = results.filter(result => result.status === 'fulfilled').length;
  if (count) toast(`已停止 ${count} 个实例`, 'success');
  await loadProfiles();
}

async function stopProfile(profile) {
  if (profile.activity?.kind === 'remote') await api(`/profiles/${profile.id}/control-disconnect`, { method: 'POST' });
  if (profile.activity?.kind === 'task') await api(`/runs/${profile.activity.runId}/cancel`, { method: 'POST' });
  else if (profile.activity?.kind === 'mcp') await api(`/profiles/${profile.id}/mcp-disconnect`, { method: 'POST' });
  else await api(`/profiles/${profile.id}/close`, { method: 'POST' });
}

function exportProfiles() {
  const profiles = state.profiles.map(p => Object.fromEntries(['name', 'url', 'taskId', 'prompt', 'proxy', 'downloadDir', 'headless', 'locale', 'timezone', 'userAgent', 'viewport', 'color'].map(key => [key, p[key]])));
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'browser-play-set-profiles', version: 1, profiles }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'browser-play-set-profiles.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出实例配置，不包含浏览器登录数据', 'success');
}

async function prepareProfileImport(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) throw new Error('配置文件不能超过 2 MB');
  const document = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
  if (document?.format !== 'browser-play-set-profiles' || document.version !== 1 ||
      !Array.isArray(document.profiles) || !document.profiles.length || document.profiles.length > 100) {
    throw new Error('请选择本工具导出的配置文件，每次可导入 1–100 个实例');
  }
  state.importDocument = document;
  $('#importProfilesSummary').textContent = `${file.name} · ${document.profiles.length} 个实例`;
  $('#importProfilesList').innerHTML = document.profiles.map(p => `<li>${escapeHtml(p.name || '未命名实例')}<small>${escapeHtml(p.url || '空白页')}</small></li>`).join('');
  $('#importProfilesError').textContent = '';
  $('#importProfilesDialog').showModal();
}

async function confirmProfileImport() {
  const button = $('#confirmImportProfilesBtn');
  button.disabled = true;
  $('#importProfilesError').textContent = '';
  try {
    const result = await api('/profiles/import', { method: 'POST', body: state.importDocument });
    $('#importProfilesDialog').close(); state.importDocument = null;
    await loadProfiles(); switchView('profiles');
    toast(`已导入 ${result.profiles.length} 个独立实例`, 'success');
  } catch (error) { $('#importProfilesError').textContent = error.message; }
  finally { button.disabled = false; }
}

/* ==========================================================================
   任务视图
   ========================================================================== */
function renderTasks() {
  $('#taskGrid').innerHTML = state.tasks.map((t) => `
    <article class="card panel">
      <h2>${escapeHtml(t.name)}</h2>
      <p class="muted">${escapeHtml(t.description || '无描述')}</p>
      <div class="pc-tags">
        <span class="badge primary">${escapeHtml(t.id)}</span>
        <span class="badge">${t.steps} 步</span>
        <span class="badge">${escapeHtml(t.source)}</span>
        ${(t.args || []).map((a) => `<span class="badge">${escapeHtml(a)}</span>`).join('')}
      </div>
      <button class="btn sm ghost" data-run-task="${escapeHtml(t.id)}">用此任务运行</button>
      ${t.kind === 'json' ? `<button class="btn sm ghost" data-edit-task="${escapeHtml(t.id)}">${t.source === `${t.id}.json` ? '编辑 JSON' : '复制为自定义'}</button>` : ''}
    </article>
  `).join('') || '<div class="empty"><p>没有可用任务。</p></div>';
}

/* ==========================================================================
   日志
   ========================================================================== */
function logPasses(entry) {
  if (state.logProfile && entry.profile !== state.logProfile) return false;
  if (LEVEL_RANK[entry.level] < LEVEL_RANK[state.logLevel]) return false;
  if (state.logFilter) {
    const hay = `${entry.message} ${entry.profileName || ''}`.toLowerCase();
    if (!hay.includes(state.logFilter.toLowerCase())) return false;
  }
  return true;
}

function appendLog(entry) {
  state.logs.push(entry);
  if (state.logs.length > 3000) state.logs.splice(0, state.logs.length - 3000);
  renderDockLogs();
  if (!logPasses(entry)) return;

  const box = $('#logBox');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const line = document.createElement('div');
  line.className = `log-line ${entry.level}`;
  line.innerHTML = `
    <span class="ts">${fmtTime(entry.time)}</span>
    <span class="lvl">${entry.level.toUpperCase()}</span>
    ${entry.profileName ? `<span class="scope">[${escapeHtml(entry.profileName)}]</span>` : ''}
    <span class="msg">${escapeHtml(entry.message)}</span>
  `;
  box.appendChild(line);

  while (box.childElementCount > 2000) box.removeChild(box.firstChild);
  if (state.logFollow && atBottom) box.scrollTop = box.scrollHeight;
}

function renderLogs() {
  renderDockLogs();
  const box = $('#logBox');
  box.innerHTML = '';
  state.logs.filter(logPasses).forEach((entry) => {
    const line = document.createElement('div');
    line.className = `log-line ${entry.level}`;
    line.innerHTML = `
      <span class="ts">${fmtTime(entry.time)}</span>
      <span class="lvl">${entry.level.toUpperCase()}</span>
      ${entry.profileName ? `<span class="scope">[${escapeHtml(entry.profileName)}]</span>` : ''}
      <span class="msg">${escapeHtml(entry.message)}</span>
    `;
    box.appendChild(line);
  });
  box.scrollTop = box.scrollHeight;
}

/* ==========================================================================
   设置
   ========================================================================== */
function renderSettings() {
  const s = state.settings;
  $('#setConcurrency').value = s.concurrency ?? 3;
  $('#setDownloadDir').value = s.defaultDownloadDir ?? '';
  $('#setLogRetention').value = s.logRetention ?? 2000;
  $('#runConcurrency').value = s.concurrency ?? 3;
}

/* ==========================================================================
   抽屉：新建 / 编辑 Profile
   ========================================================================== */
function setProfileSelectValue(selector, value) {
  const select = $(selector);
  select.querySelector('option[data-saved-value]')?.remove();
  if (!Array.from(select.options).some(option => option.value === value)) {
    const option = new Option(`当前配置（${value}）`, value);
    option.dataset.savedValue = '';
    select.add(option);
  }
  select.value = value;
}

function openDrawer(profile = null) {
  state.editingId = profile?.id || null;
  $('#drawerTitle').textContent = profile ? '编辑 Profile' : '新建 Profile';
  $('#pfId').value = profile?.id || '';
  $('#pfName').value = profile?.name || '';
  $('#pfUrl').value = profile?.url || '';
  $('#pfTask').value = profile?.taskId || state.tasks[0]?.id || 'open-page';
  $('#pfPrompt').value = profile?.prompt || '';
  $('#pfProxy').value = profile?.proxy?.server || '';
  $('#pfProxyUser').value = profile?.proxy?.username || '';
  $('#pfProxyPass').value = profile?.proxy?.password || '';
  $('#pfProxyBypass').value = profile?.proxy?.bypass || '';
  setProfileSelectValue('#pfLocale', profile?.locale ?? 'zh-CN');
  setProfileSelectValue('#pfTimezone', profile?.timezone ?? 'Asia/Shanghai');
  $('#pfWidth').value = profile?.viewport?.width || 1280;
  $('#pfHeight').value = profile?.viewport?.height || 800;
  $('#pfDownloadDir').value = profile?.downloadDir || '';
  $('#pfUserAgent').value = profile?.userAgent || '';
  $('#pfStorageInfo').textContent = profile ? `User Data：${profile.userDataDir}\n下载目录：${profile.resolvedDownloadDir}` : '创建后自动分配独立的登录数据和下载目录。';

  $('#drawer').hidden = false;
  $('#drawerBackdrop').hidden = false;
  setTimeout(() => $('#pfName').focus(), 60);
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawerBackdrop').hidden = true;
  state.editingId = null;
}

async function saveProfile() {
  const name = $('#pfName').value.trim();
  if (!name) return toast('请填写名称', 'error');

  const body = {
    name,
    url: $('#pfUrl').value.trim(),
    taskId: $('#pfTask').value,
    prompt: $('#pfPrompt').value,
    proxy: $('#pfProxy').value.trim()
      ? { server: $('#pfProxy').value.trim(), ...($('#pfProxyUser').value ? { username: $('#pfProxyUser').value } : {}), ...($('#pfProxyPass').value ? { password: $('#pfProxyPass').value } : {}), bypass: $('#pfProxyBypass').value.trim() }
      : null,
    locale: $('#pfLocale').value.trim(),
    timezone: $('#pfTimezone').value.trim(),
    viewport: { width: Number($('#pfWidth').value), height: Number($('#pfHeight').value) },
    downloadDir: $('#pfDownloadDir').value.trim(),
    userAgent: $('#pfUserAgent').value.trim(),
    headless: true,
  };

  try {
    if (state.editingId) {
      await api(`/profiles/${state.editingId}`, { method: 'PUT', body });
      toast('已保存', 'success');
    } else {
      await api('/profiles', { method: 'POST', body });
      toast('已创建', 'success');
    }
    closeDrawer();
    await loadProfiles();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteProfile(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  state.deletingId = id;
  $('#deleteDescription').textContent = `删除「${p.name}」的配置。默认保留实例登录数据。`;
  $('#deletePurge').checked = false;
  $('#deleteDialog').showModal();
}

async function confirmDelete() {
  const id = state.deletingId;
  const purge = $('#deletePurge').checked;
  try {
    await api(`/profiles/${id}?purge=${purge ? 1 : 0}`, { method: 'DELETE' });
    state.selected.delete(id);
    toast('已删除', 'success');
    $('#deleteDialog').close();
    await loadProfiles();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function duplicateProfile(id) {
  try {
    await api(`/profiles/${id}/duplicate`, { method: 'POST' });
    toast('已复制', 'success');
    await loadProfiles();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------------------ 卡片操作菜单 ------------------------------ */
let openMenu = null;

function closeCardMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
    document.removeEventListener('click', onDocClickForMenu, true);
  }
}

function onDocClickForMenu(e) {
  if (openMenu && !openMenu.contains(e.target)) closeCardMenu();
}

function openCardMenu(anchor, profile) {
  if (!anchor || !profile) return;
  closeCardMenu();

  const items = [
    { label: '启动浏览器', run: () => launchBrowser(profile.id) },
    { label: '关闭浏览器', run: () => closeBrowser(profile.id) },
    { label: '复制 Profile', run: () => duplicateProfile(profile.id) },
    { label: '连接 Playwright MCP', run: () => showMcp(profile.id) },
    { label: '编辑', run: () => openDrawer(profile) },
    { sep: true },
    { label: '删除', danger: true, run: () => deleteProfile(profile.id) },
  ];

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = items.map((it) => it.sep
    ? '<div class="menu-sep"></div>'
    : `<button class="menu-item${it.danger ? ' danger' : ''}">${it.label}</button>`
  ).join('');

  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = rect.right - mw;
  let top = rect.bottom + 6;
  if (left < 8) left = 8;
  if (top + mh > window.innerHeight - 8) top = rect.top - mh - 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.addEventListener('click', (e) => {
    const idx = [...menu.querySelectorAll('.menu-item')].indexOf(e.target.closest('.menu-item'));
    const actionable = items.filter((it) => !it.sep);
    const item = actionable[idx];
    if (item) { closeCardMenu(); Promise.resolve().then(item.run).catch(error => toast(error.message, 'error')); }
  });

  openMenu = menu;
  setTimeout(() => document.addEventListener('click', onDocClickForMenu, true), 0);
}

/* ==========================================================================
   运行操作
   ========================================================================== */
async function runProfiles(ids, overrides = {}) {
  if (!ids.length) return toast('请先选择 Profile', 'error');
  const body = {
    profileIds: ids,
    concurrency: Number($('#runConcurrency').value),
    taskId: $('#runTask').value || undefined,
    prompt: $('#runPrompt').value || undefined,
    url: $('#runUrl').value.trim() || undefined,
    headless: true,
    reuseBrowser: $('#runReuse').checked,
    keepOpen: $('#runKeepOpen').checked,
    ...overrides,
  };
  const btn = $('#runBtn');
  btn.disabled = true;
  try {
    body.vars = $('#runVars').value.trim() ? JSON.parse($('#runVars').value) : undefined;
    await api('/run', { method: 'POST', body });
    toast(`${ids.length} 个任务已加入队列`, 'success');
    switchView('run');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function launchBrowser(id) {
  try {
    await api(`/profiles/${id}/launch`, { method: 'POST', body: {} });
    state.profileErrors.delete(id);
    toast('浏览器已启动', 'success');
  } catch (err) {
    state.profileErrors.set(id, err.message);
    toast(explainError(err.message), 'error');
  } finally { await loadProfiles(); }
}

async function closeBrowser(id) {
  try {
    await stopProfile(state.profiles.find(profile => profile.id === id));
    await loadProfiles();
    toast('已关闭', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ==========================================================================
   加载数据
   ========================================================================== */
async function loadProfiles() {
  state.profiles = await api('/profiles');
  state.selected = new Set([...state.selected].filter(id => state.profiles.some(p => p.id === id)));
  for (const [id, frame] of state.previews) {
    if (!state.profiles.some(p => p.id === id && p.running)) { URL.revokeObjectURL(frame.url); state.previews.delete(id); }
  }
  $('#logProfile').innerHTML = '<option value="">全部 Profile</option>' + state.profiles.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  $('#logProfile').value = state.logProfile;
  renderProfiles();
  renderRunChips();
  renderProxies();
}
async function loadTasks() {
  try {
    state.tasks = await api('/tasks');
    $('#taskLoadError').hidden = true;
    renderTaskOptions(); renderTasks();
  } catch (error) {
    $('#taskLoadError').textContent = error.message; $('#taskLoadError').hidden = false;
    throw error;
  }
}
async function loadSettings() {
  state.settings = await api('/settings');
  renderSettings();
}

/* ==========================================================================
   SSE 实时事件
   ========================================================================== */
function connectEvents() {
  const dot = $('#connDot');
  const es = new EventSource('/api/events');

  es.addEventListener('open', () => { dot.className = 'status-dot online'; $('#connectionLabel').textContent = '服务已连接'; });
  es.addEventListener('error', () => { dot.className = 'status-dot offline'; $('#connectionLabel').textContent = '连接已断开'; });

  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    state.logs = data.logs || [];
    state.runs = new Map((data.runs || []).map((r) => [r.runId, r]));
    renderLogs();
    renderRuns();
    renderProfiles();
  });

  es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));

  es.addEventListener('run', (e) => {
    const rec = JSON.parse(e.data);
    state.runs.set(rec.runId, rec);
    renderRuns();
    if (['success', 'error', 'cancelled'].includes(rec.status)) {
      state.profileErrors.delete(rec.profileId);
      // 运行结束后刷新该 Profile 的最近状态（仅局部更新）
      refreshProfileStatus(rec.profileId);
    }
  });

  es.addEventListener('sessions', (e) => {
    const { sessions, activities } = JSON.parse(e.data);
    const running = new Set(sessions.map((s) => s.profileId));
    const owners = new Map(activities.map(item => [item.profileId, item.activity]));
    for (const p of state.profiles) { p.running = running.has(p.id); p.activity = owners.get(p.id); }
    for (const [id, frame] of state.previews) if (!running.has(id)) { URL.revokeObjectURL(frame.url); state.previews.delete(id); }
    renderProfiles(); renderProxies();
  });

  es.addEventListener('logs-cleared', () => {
    state.logs = [];
    renderLogs();
  });
}

/* ==========================================================================
   事件绑定
   ========================================================================== */
function bindEvents() {
  // 标签切换
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  $$('[data-go]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.go)));
  window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (view !== state.view) switchView(view); });
  $('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
  $('#quickAddBtn').addEventListener('click', () => openDrawer());
  $('#quickTaskBtn').addEventListener('click', () => openTaskEditor());
  $('#exportProfilesBtn').addEventListener('click', exportProfiles);
  $('#importProfilesBtn').addEventListener('click', () => $('#importProfilesFile').click());
  $('#importProfilesFile').addEventListener('change', guarded(prepareProfileImport));
  $('#confirmImportProfilesBtn').addEventListener('click', confirmProfileImport);
  $('#refreshProfilesBtn').addEventListener('click', guarded(async () => { await loadProfiles(); await refreshMetrics(); }));
  $('#batchStopBtn').addEventListener('click', guarded(stopSelectedBrowsers));
  $('#dockLogLevel').addEventListener('change', renderDockLogs);
  $('#dockLogFollow').addEventListener('change', renderDockLogs);
  $('#previewEnabled').addEventListener('change', () => {
    if ($('#previewEnabled').checked) refreshPreviews();
    else $$('.preview-hint').forEach(el => { el.textContent = '预览已暂停'; });
  });
  $$('[data-status-filter]').forEach(button => button.addEventListener('click', () => {
    state.statusFilter = button.dataset.statusFilter;
    $$('[data-status-filter]').forEach(el => el.classList.toggle('is-active', el === button)); renderProfiles();
  }));
  $$('[data-layout]').forEach(button => button.addEventListener('click', () => {
    state.layout = button.dataset.layout;
    $$('[data-layout]').forEach(el => el.classList.toggle('is-active', el === button)); renderProfiles();
  }));
  $('#resetFiltersBtn').addEventListener('click', () => {
    state.filter = ''; state.statusFilter = 'all'; $('#profileSearch').value = '';
    $$('[data-status-filter]').forEach(el => el.classList.toggle('is-active', el.dataset.statusFilter === 'all')); renderProfiles();
  });
  $('#proxyTableBody').addEventListener('click', event => {
    const id = event.target.closest('[data-edit-proxy]')?.dataset.editProxy;
    if (id) { openDrawer(state.profiles.find(p => p.id === id)); $('#pfProxy').focus(); }
  });

  // 主题
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('bps-theme', next); } catch { /* ignore */ }
  });

  // Profile 搜索
  $('#profileSearch').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderProfiles();
  });

  // 全选
  $('#selectAll').addEventListener('change', (e) => {
    visibleProfiles().forEach(p => { if (e.target.checked) state.selected.add(p.id); else state.selected.delete(p.id); });
    renderProfiles();
    renderRunChips();
  });

  // 新建
  $('#addProfileBtn').addEventListener('click', () => openDrawer());
  $('#emptyAddBtn').addEventListener('click', () => openDrawer());

  // 批量运行
  $('#batchRunBtn').addEventListener('click', () => runProfiles([...state.selected]));
  $('#batchLaunchBtn').addEventListener('click', guarded(openSelectedBrowsers));

  // Profile 卡片交互（事件委托）
  $('#profileGrid').addEventListener('click', guarded(async (e) => {
    const card = e.target.closest('.profile-card');
    if (!card) return;
    const id = card.dataset.id;

    const selectBox = e.target.closest('[data-select]');
    if (selectBox) {
      if (selectBox.checked) state.selected.add(id); else state.selected.delete(id);
      card.classList.toggle('selected', selectBox.checked);
      updateSelectedCount();
      renderRunChips();
      return;
    }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'run') return runProfiles([id], { taskId: undefined, prompt: undefined, url: undefined, headless: undefined });
    if (act === 'launch') return launchBrowser(id);
    if (act === 'close') return closeBrowser(id);
    if (act === 'focus') return window.open(`/control.html?profile=${id}`, '_blank', 'noopener');
    if (act === 'edit') return openDrawer(state.profiles.find((p) => p.id === id));
    if (act === 'more') {
      const btn = e.target.closest('[data-act="more"]');
      return openCardMenu(btn, state.profiles.find((p) => p.id === id));
    }
  }));

  // 运行页 Profile 芯片
  $('#runProfileChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const id = chip.dataset.id;
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    chip.classList.toggle('is-on');
    renderProfiles();
  });

  // 运行
  $('#runBtn').addEventListener('click', () => runProfiles([...state.selected]));

  // 任务视图：用某任务运行
  $('#taskGrid').addEventListener('click', guarded(async (e) => {
    const editId = e.target.closest('[data-edit-task]')?.dataset.editTask;
    if (editId) return editTask(editId);
    const id = e.target.closest('[data-run-task]')?.dataset.runTask;
    if (!id) return;
    $('#runTask').value = id;
    switchView('run');
    toast('已选择任务，勾选 Profile 后开始运行');
  }));

  // 重新加载任务
  $('#reloadTasksBtn').addEventListener('click', guarded(async () => {
    await api('/tasks/reload', { method: 'POST' });
    await loadTasks();
    toast('任务已重新加载', 'success');
  }));
  $('#newTaskBtn').addEventListener('click', () => openTaskEditor());
  $('#importTaskBtn').addEventListener('click', () => $('#importTaskFile').click());
  $('#importTaskFile').addEventListener('change', guarded(async e => {
    const file = e.target.files[0]; if (!file) return;
    openTaskEditor(JSON.parse(await file.text())); e.target.value = '';
  }));
  $('#taskEditorForm').addEventListener('submit', saveTaskDefinition);
  $('#runList').addEventListener('click', guarded(async e => {
    const cancel = e.target.closest('[data-cancel-run]')?.dataset.cancelRun;
    const detail = e.target.closest('[data-run-detail]')?.dataset.runDetail;
    if (cancel) await api(`/runs/${cancel}/cancel`, { method: 'POST' });
    if (detail) await showRunDetail(detail);
  }));
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
  $('#copyMcpBtn').addEventListener('click', guarded(async () => { await navigator.clipboard.writeText($('#mcpConfig').value); toast('配置已复制', 'success'); }));
  $('#disconnectMcpBtn').addEventListener('click', guarded(async () => {
    await api(`/profiles/${state.mcpProfileId}/mcp-disconnect`, { method: 'POST' });
    toast('MCP 已断开', 'success'); await loadProfiles();
  }));
  $('#confirmDeleteBtn').addEventListener('click', confirmDelete);

  // 日志过滤
  $('#logFilter').addEventListener('input', (e) => { state.logFilter = e.target.value; renderLogs(); });
  $('#logLevel').addEventListener('change', (e) => { state.logLevel = e.target.value; renderLogs(); });
  $('#logProfile').addEventListener('change', e => { state.logProfile = e.target.value; renderLogs(); });
  $('#logFollow').addEventListener('change', (e) => { state.logFollow = e.target.checked; });
  $('#clearLogsBtn').addEventListener('click', guarded(async () => {
    await api('/logs', { method: 'DELETE' });
    toast('日志已清空', 'success');
  }));

  // 设置保存
  $('#saveSettingsBtn').addEventListener('click', async () => {
    try {
      state.settings = await api('/settings', {
        method: 'PUT',
        body: {
          concurrency: Number($('#setConcurrency').value),
          defaultDownloadDir: $('#setDownloadDir').value.trim(),
          logRetention: Number($('#setLogRetention').value),
          defaultHeadless: true,
          autoOpenBrowser: false,
        },
      });
      renderSettings();
      toast('设置已保存', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // 抽屉
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerCancel').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  $('#drawerSave').addEventListener('click', saveProfile);
  $('#profileForm').addEventListener('submit', (e) => { e.preventDefault(); saveProfile(); });

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('#drawer').hidden) saveProfile();
  });
}

/* ==========================================================================
   环境信息
   ========================================================================== */
async function loadMeta() {
  try {
    const meta = await api('/meta');
    $('#metaLine').textContent = `v${meta.version} · ${meta.platform}`;
    $('#envInfo').innerHTML = `
      <dt>版本</dt><dd>${escapeHtml(meta.version)}</dd>
      <dt>平台</dt><dd>${escapeHtml(meta.platform)}</dd>
      <dt>Node</dt><dd>${escapeHtml(meta.node)}</dd>
      <dt>数据目录</dt><dd>${escapeHtml(meta.dataDir)}</dd>
      <dt>任务目录</dt><dd>${escapeHtml(meta.tasksDir)}</dd>
      <dt>Playwright</dt><dd>${escapeHtml(meta.playwright)}</dd>
      <dt>Playwright MCP</dt><dd>${escapeHtml(meta.mcp)}</dd>
      <dt>Chromium</dt><dd>${meta.browser.installed ? '后台运行' : '尚未安装'}</dd>
    `;
    if (!meta.browser.installed) {
      $('#browserNotice').hidden = false;
      $('#browserNotice').textContent = '首次使用：在服务器项目目录运行 bash setup.sh 安装 Chromium 和项目依赖。';
    }
  } catch (error) { toast(error.message, 'error'); }
}

/* ==========================================================================
   启动
   ========================================================================== */
async function boot() {
  try {
    const saved = localStorage.getItem('bps-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* ignore */ }

  bindEvents();
  drawIcons();

  const hash = location.hash.replace('#', '');
  if (hash) switchView(hash);

  const results = await Promise.allSettled([loadMeta(), loadSettings(), loadTasks(), loadProfiles()]);
  for (const result of results) if (result.status === 'rejected') toast(result.reason.message, 'error');
  connectEvents();
  async function poll() {
    await Promise.all([refreshMetrics(), refreshPreviews()]);
    setTimeout(poll, 3000);
  }
  poll();
}

boot().catch(error => toast(error.message, 'error'));
