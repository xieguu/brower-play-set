import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { workspace, fixture, until } from '../helpers.js';

const temp = workspace('bps-server-');
const site = await fixture();
const { startServer } = await import('../../src/server.js');
const { getSession } = await import('../../src/browser.js');
const { activity } = await import('../../src/activity.js');
const { bus } = await import('../../src/logger.js');
const runtime = await startServer({ port: 0 });
after(async () => { await runtime.stop(); await site.close(); temp.remove(); });

async function api(route, options = {}) {
  const response = await fetch(`${runtime.origin}/api${route}`, { ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await response.json(); return { response, body };
}

test('工作台：真实资源数据、预览、窗口聚焦和关闭后的预览失效', { timeout: 30000 }, async () => {
  const metrics = await api('/system');
  assert.equal(metrics.response.status, 200);
  assert.ok(metrics.body.memory.total > 0);
  assert.ok(metrics.body.memory.used <= metrics.body.memory.total);
  assert.ok(metrics.body.processMemory > 0);
  const { body: profile } = await api('/profiles', { method: 'POST', body: { name: '预览检查', url: site.url, headless: true } });
  assert.equal((await api(`/profiles/${profile.id}/preview`)).response.status, 409);
  assert.equal((await api(`/profiles/${profile.id}/launch`, { method: 'POST' })).response.status, 200);
  const preview = await fetch(`${runtime.origin}/api/profiles/${profile.id}/preview`);
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-type'), /image\/jpeg/);
  assert.equal(preview.headers.get('cache-control'), 'no-store');
  const bytes = new Uint8Array(await preview.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 2)], [255, 216]);
  assert.ok(bytes.length > 1000);
  assert.equal((await api(`/profiles/${profile.id}/focus`, { method: 'POST' })).response.status, 200);
  assert.equal((await api('/sessions')).body.find(s => s.profileId === profile.id).headless, true);
  assert.equal((await api('/meta')).body.browser.engine, 'chromium');
  await api(`/profiles/${profile.id}/close`, { method: 'POST' });
  assert.equal((await api(`/profiles/${profile.id}/preview`)).response.status, 409);
  await api(`/profiles/${profile.id}`, { method: 'DELETE' });
});

test('HTTP：Profile CRUD、任意站点、错误输入状态码和只允许本机来源', async () => {
  const created = await api('/profiles', { method: 'POST', body: { name: 'API', url: 'https://custom-domain.invalid/path', headless: true } });
  assert.equal(created.response.status, 201);
  const profile = created.body;
  assert.equal((await api(`/profiles/${profile.id}`, { method: 'PUT', body: { prompt: 'per-profile prompt' } })).body.prompt, 'per-profile prompt');
  const copy = await api(`/profiles/${profile.id}/duplicate`, { method: 'POST' });
  assert.notEqual(copy.body.id, profile.id); assert.equal(copy.body.lastRunAt, null);
  const list = (await api('/profiles')).body;
  assert.notEqual(list[0].userDataDir, list[1].userDataDir); assert.equal(list[0].downloadDir, '');
  assert.equal((await api('/profiles', { method: 'POST', body: { name: 'bad', id: '../../bad' } })).response.status, 400);
  assert.equal((await api('/profiles', { method: 'POST', body: { name: 'bad', url: 'invalid-url' } })).response.status, 400);
  assert.equal((await api('/settings', { method: 'PUT', body: { concurrency: -1 } })).response.status, 400);
  assert.equal((await api('/profiles', { headers: { Origin: 'https://other-site.example' } })).response.status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const request = http.get(`${runtime.origin}/api/meta`, { headers: { Host: `other-site.example:${runtime.server.address().port}` } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
  });
  assert.equal(rebound, 403);
  for (const p of list) assert.equal((await api(`/profiles/${p.id}`, { method: 'DELETE' })).response.status, 200);
});

test('HTTP：运行接口立即返回 202，逐步状态、取消和文件产物可读取', { timeout: 30000 }, async () => {
  const task = { id: 'http-task', name: 'HTTP task', steps: [{ action: 'open', url: '{{url}}' }, { action: 'wait', ms: 250 }, { action: 'screenshot', name: 'http.png' }] };
  assert.equal((await api('/tasks', { method: 'POST', body: task })).response.status, 201);
  const profile = (await api('/profiles', { method: 'POST', body: { name: 'HTTP Run', url: site.url, taskId: task.id, headless: true } })).body;
  const start = Date.now();
  const submitted = await api('/run', { method: 'POST', body: { profileIds: [profile.id] } });
  assert.equal(submitted.response.status, 202); assert.ok(Date.now() - start < 2000);
  const runId = submitted.body.runIds[0];
  const completed = await until(async () => { const run = (await api(`/runs/${runId}`)).body; return ['success', 'error'].includes(run.status) ? run : null; });
  assert.equal(completed.status, 'success', completed.error); assert.equal(completed.step, 3);
  const shotIndex = completed.artifacts.findIndex(file => file.name === 'http.png');
  assert.ok(shotIndex >= 0);
  const screenshot = await fetch(`${runtime.origin}/api/runs/${runId}/artifacts/${shotIndex}`);
  assert.equal(screenshot.status, 200); assert.match(screenshot.headers.get('content-disposition'), /attachment/);
  assert.equal(Buffer.from(await screenshot.arrayBuffer()).readUInt32BE(0), 0x89504e47);
  assert.equal((await api(`/runs/${runId}/artifacts/99`)).response.status, 404);
});

test('SSE 断开后移除全部事件监听器', { timeout: 10000 }, async () => {
  const before = bus.listenerCount('logs-cleared');
  for (let index = 0; index < 3; index++) {
    const controller = new AbortController();
    const response = await fetch(`${runtime.origin}/api/events`, { signal: controller.signal });
    const reader = response.body.getReader(); await reader.read();
    assert.equal(bus.listenerCount('logs-cleared'), before + 1);
    await reader.cancel(); controller.abort();
    await until(() => bus.listenerCount('logs-cleared') === before);
  }
});

test('MCP Streamable HTTP：两个 Profile 独立、调用官方工具、互斥和断开释放', { timeout: 60000 }, async () => {
  const a = (await api('/profiles', { method: 'POST', body: { name: 'Remote A', headless: true, url: site.url } })).body;
  const b = (await api('/profiles', { method: 'POST', body: { name: 'Remote B', headless: true, url: site.url } })).body;
  const ca = new Client({ name: 'test-a', version: '1.0' }), cb = new Client({ name: 'test-b', version: '1.0' });
  const ta = new StreamableHTTPClientTransport(new URL(`${runtime.origin}/mcp/${a.id}`));
  const tb = new StreamableHTTPClientTransport(new URL(`${runtime.origin}/mcp/${b.id}`));
  await Promise.all([ca.connect(ta), cb.connect(tb)]);
  try {
    const tools = (await ca.listTools()).tools;
    for (const name of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_file_upload']) assert.ok(tools.some(t => t.name === name), name);
    const results = await Promise.all([ca.callTool({ name: 'browser_navigate', arguments: { url: site.url } }), cb.callTool({ name: 'browser_navigate', arguments: { url: site.url } })]);
    results.forEach(result => assert.ok(!result.isError, JSON.stringify(result)));
    const changed = await ca.callTool({ name: 'browser_evaluate', arguments: { function: '() => { localStorage.setItem("identity", "Remote A"); return document.title; }' } });
    assert.ok(!changed.isError, JSON.stringify(changed));
    assert.equal(await getSession(a.id).context.pages()[0].evaluate(() => localStorage.getItem('identity')), 'Remote A');
    assert.equal(await getSession(b.id).context.pages()[0].evaluate(() => localStorage.getItem('identity')), null);
    const snapshot = await ca.callTool({ name: 'browser_snapshot', arguments: {} });
    assert.match(JSON.stringify(snapshot), /Automation Fixture/);
    const newWindow = await ca.callTool({ name: 'browser_tabs', arguments: { action: 'new' } });
    assert.ok(!newWindow.isError, JSON.stringify(newWindow));
    assert.equal(getSession(a.id).context.pages().length, 2);
    const navigate = await ca.callTool({ name: 'browser_navigate', arguments: { url: site.url } });
    assert.ok(!navigate.isError, JSON.stringify(navigate));
    assert.equal(await getSession(a.id).context.pages().at(-1).evaluate(() => localStorage.getItem('identity')), 'Remote A');
    assert.equal((await api('/run', { method: 'POST', body: { profileIds: [a.id] } })).response.status, 409);
    assert.equal((await api(`/profiles/${a.id}`, { method: 'PUT', body: { name: 'Busy' } })).response.status, 409);
    const error = await ca.callTool({ name: 'browser_click', arguments: { target: '#absent' } });
    assert.equal(error.isError, true);
  } finally {
    await Promise.all([ta.terminateSession(), tb.terminateSession()]); await Promise.all([ca.close(), cb.close()]);
    await until(() => activity(a.id) === null && activity(b.id) === null);
  }
  assert.equal(getSession(a.id), null); assert.equal(getSession(b.id), null);
  const accepted = await api('/run', { method: 'POST', body: { profileIds: [a.id] } }); assert.equal(accepted.response.status, 202);
  await until(async () => (await api(`/runs/${accepted.body.runIds[0]}`)).body.status === 'success');
});
