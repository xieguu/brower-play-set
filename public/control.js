import RFB from '/vendor/novnc/core/rfb.js';

const $ = selector => document.querySelector(selector);
const id = new URLSearchParams(location.search).get('profile');
let rfb, token, connected = false, connecting = false, intentional = false, connectionTimer;
const buttons = ['#disconnect', '#go', '#send', '[data-nav]'];
function status(text, state) {
  $('#status').textContent = text; $('#status').dataset.state = state;
  connected = state === 'connected';
  buttons.forEach(selector => document.querySelectorAll(selector).forEach(button => { button.disabled = !connected; }));
  $('#reconnect').hidden = connected || state === 'connecting';
}
function showError(error) { $('#error').textContent = error.message; $('#error').hidden = false; }
async function api(suffix, options = {}) {
  const response = await fetch(`/api/profiles/${id}/${suffix}`, { ...options,
    headers: { 'Content-Type': 'application/json', 'X-Control-Token': token || '', ...options.headers } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}
async function connect() {
  if (connecting || connected) return;
  connecting = true; intentional = false; $('#error').hidden = true; status('正在连接…', 'connecting');
  try {
    if (!/^[0-9a-f]{12}$/.test(id || '')) throw new Error('无效实例 ID，请从工作台打开操作页');
    const info = await api('desktop');
    $('#name').textContent = info.name; document.title = `${info.name} · 远程浏览器`;
    token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
    const socketUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/profiles/${id}/control-socket?token=${token}`;
    rfb = new RFB($('#screen'), socketUrl);
    rfb.scaleViewport = $('#fit').checked;
    rfb.resizeSession = false;
    rfb.qualityLevel = 6; rfb.compressionLevel = 2;
    connectionTimer = setTimeout(() => {
      showError(new Error('连接超时，请确认服务器已运行 bash setup.sh，并检查 WebSocket 转发配置'));
      rfb.disconnect();
    }, 15000);
    rfb.addEventListener('connect', () => {
      clearTimeout(connectionTimer); connecting = false; status('已连接 · 可操作', 'connected'); rfb.focus();
    });
    rfb.addEventListener('disconnect', async () => {
      clearTimeout(connectionTimer); connecting = false; status('已断开', 'disconnected');
      if (!intentional && $('#error').hidden) {
        showError(new Error('连接已断开。请确认实例未被任务、MCP 或另一个操作页占用，再点击重新连接。'));
      }
    });
    rfb.addEventListener('securityfailure', event => showError(new Error(event.detail.reason || '远程连接认证失败')));
  } catch (error) { connecting = false; status('连接失败', 'disconnected'); showError(error); }
}
async function command(value) {
  if (!connected) return;
  $('#error').hidden = true;
  const result = await api('control', { method: 'POST', body: JSON.stringify(value) });
  if (result.url) $('#url').value = result.url;
}
$('#navigate').addEventListener('submit', async event => {
  event.preventDefault();
  try { await command({ action: 'navigate', url: $('#url').value }); rfb.focus(); } catch (error) { showError(error); }
});
document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', async () => {
  try { await command({ action: button.dataset.nav }); } catch (error) { showError(error); }
}));
$('#insert').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('#text').value) return;
  try {
    await command({ action: 'text', text: $('#text').value }); $('#text').value = ''; rfb.focus();
  } catch (error) { showError(error); }
});
$('#fit').addEventListener('change', () => { if (rfb) rfb.scaleViewport = $('#fit').checked; });
$('#fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch (error) { showError(error); }
});
$('#disconnect').addEventListener('click', () => { intentional = true; rfb?.disconnect(); });
$('#reconnect').addEventListener('click', connect);
window.addEventListener('pagehide', () => { intentional = true; clearTimeout(connectionTimer); rfb?.disconnect(); });
connect();
