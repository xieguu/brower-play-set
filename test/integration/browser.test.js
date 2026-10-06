import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workspace, fixture, proxy, until } from '../helpers.js';

const temp = workspace('bps-browser-');
const site = await fixture();
const { profiles } = await import('../../src/store.js');
const { launch, close, closeAll, getSession } = await import('../../src/browser.js');
const { submitBatch, getRun, cancelRun, runs, stopAllRuns } = await import('../../src/orchestrator.js');
const { saveTask } = await import('../../src/tasks/index.js');
after(async () => { await stopAllRuns(); await closeAll(); await site.close(); temp.remove(); });

async function storage(page, value) {
  return page.evaluate(async value => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('profile-state', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('values');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const cache = await caches.open('profile-cache');
    if (value !== undefined) {
      document.cookie = `identity=${value}; Max-Age=3600; Path=/`;
      localStorage.setItem('identity', value);
      await new Promise((resolve, reject) => { const tx = db.transaction('values', 'readwrite'); tx.objectStore('values').put(value, 'identity'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      await cache.put('/stored-resource', new Response(value));
    }
    const idb = await new Promise((resolve, reject) => { const request = db.transaction('values').objectStore('values').get('identity'); request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error); });
    db.close();
    const cached = await cache.match('/stored-resource');
    return { cookie: document.cookie, local: localStorage.getItem('identity'), idb, cache: cached ? await cached.text() : null, httpCache: await (await fetch('/cache-token')).text() };
  }, value);
}

test('真实 Chromium：Cookie / LocalStorage / IndexedDB / CacheStorage / HTTP 缓存隔离且重启保持', { timeout: 60000 }, async () => {
  const a = profiles.add({ name: 'Alpha', url: site.url, headless: true });
  const b = profiles.add({ name: 'Beta', url: site.url, headless: true });
  const [sa, sb] = await Promise.all([launch(a), launch(b)]);
  const pa = sa.context.pages()[0], pb = sb.context.pages()[0];
  await Promise.all([pa.goto(site.url), pb.goto(site.url)]);
  const aState = await storage(pa, 'alpha');
  const empty = await storage(pb);
  assert.equal(empty.cookie, ''); assert.equal(empty.local, null); assert.equal(empty.idb, null); assert.equal(empty.cache, null);
  assert.notEqual(empty.httpCache, aState.httpCache);
  const bState = await storage(pb, 'beta');
  assert.equal((await storage(pa)).local, 'alpha');
  await Promise.all([close(a.id), close(b.id)]);
  const [ra, rb] = await Promise.all([launch(a), launch(b)]);
  await Promise.all([ra.context.pages()[0].goto(site.url), rb.context.pages()[0].goto(site.url)]);
  assert.deepEqual(await storage(ra.context.pages()[0]), aState);
  assert.deepEqual(await storage(rb.context.pages()[0]), bState);
  await Promise.all([close(a.id), close(b.id)]);
});

test('同一 Profile 同时启动只产生一个上下文，并拒绝另一个进程占用', { timeout: 30000 }, async () => {
  const profile = profiles.add({ name: 'Lock', headless: true });
  const sessions = await Promise.all([launch(profile), launch(profile), launch(profile)]);
  assert.equal(sessions[0].context, sessions[1].context); assert.equal(sessions[0].context, sessions[2].context);
  const code = `import {profiles} from './src/store.js'; import {launch,closeAll} from './src/browser.js'; try {await launch(profiles.get('${profile.id}')); await closeAll(); process.exitCode=1;} catch(e) {console.log(e.message);}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const codeResult = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(codeResult, 0, output); assert.match(output, /另一个进程/);
  await close(profile.id);
});

test('每个 Profile 独立 HTTP 代理和代理认证', { timeout: 40000 }, async () => {
  const pa = await proxy('Proxy Alpha', 'user: pass '), pb = await proxy('Proxy Beta');
  const a = profiles.add({ name: 'ProxyA', headless: true, proxy: { server: pa.url, username: 'user', password: ' pass ' } });
  const b = profiles.add({ name: 'ProxyB', headless: true, proxy: pb.url });
  try {
    const [sa, sb] = await Promise.all([launch(a), launch(b)]);
    const url = 'http://isolated-profile.invalid/';
    await Promise.all([sa.context.pages()[0].goto(url), sb.context.pages()[0].goto(url)]);
    assert.equal(await sa.context.pages()[0].locator('h1').innerText(), 'Proxy Alpha');
    assert.equal(await sb.context.pages()[0].locator('h1').innerText(), 'Proxy Beta');
    assert.ok(pa.requests.some(item => item.authorization === `Basic ${Buffer.from('user: pass ').toString('base64')}`));
    assert.ok(pb.requests.some(item => item.url === url));
  } finally { await Promise.all([close(a.id), close(b.id)]); await Promise.all([pa.close(), pb.close()]); }
});

test('通用任务：定位、输入、点击、等待、读取、上传、下载、截图、标签页与结果落盘', { timeout: 40000 }, async () => {
  const upload = path.join(temp.root, 'upload.txt'); fs.writeFileSync(upload, 'upload fixture');
  await saveTask({ id: 'all-actions', name: 'All actions', steps: [
    { action: 'open', url: '{{url}}' }, { action: 'locate', selector: { role: 'textbox', name: 'Prompt' } },
    { action: 'type', selector: { label: 'Prompt' }, text: '{{prompt}}' },
    { action: 'click', selector: { role: 'button', name: 'Apply' } },
    { action: 'wait', text: '{{prompt}}' }, { action: 'read', selector: '#message', saveAs: 'message' },
    { action: 'press', selector: '#prompt', key: 'Enter' }, { action: 'wait', url: '**/?q=Alpha' },
    { action: 'upload', selector: '#upload', files: [upload] }, { action: 'read', selector: '#uploads', saveAs: 'uploaded' },
    { action: 'download', selector: '#download', name: 'saved.txt', saveAs: 'download' },
    { action: 'screenshot', name: 'fixture.png' }, { action: 'evaluate', script: '() => document.title', saveAs: 'title' },
    { action: 'newPage', url: '{{url}}' }, { action: 'switchPage', index: 0 }, { action: 'closePage' },
  ] });
  const profile = profiles.add({ name: 'Actions', url: site.url, headless: true, taskId: 'all-actions', prompt: 'Alpha' });
  const batch = await submitBatch({ profileIds: [profile.id] });
  const result = await batch.done; assert.equal(result.results[0].ok, true, result.results[0].error);
  const run = getRun(batch.runIds[0]);
  const resultData = JSON.parse(fs.readFileSync(path.join(run.outputDir, 'result.json'), 'utf8'));
  assert.equal(resultData.vars.message.text, 'Alpha'); assert.equal(resultData.vars.uploaded.text, 'upload.txt');
  assert.equal(resultData.vars.title.result, 'Automation Fixture');
  assert.equal(fs.readFileSync(resultData.vars.download.file, 'utf8'), 'persistent download content');
  assert.equal(fs.readFileSync(path.join(run.outputDir, 'fixture.png')).readUInt32BE(0), 0x89504e47);
  assert.equal(getSession(profile.id), null);
});

test('跨批次全局并发、重复提交拒绝、失败不影响其他 Profile', { timeout: 60000 }, async () => {
  await saveTask({ id: 'bounded', name: 'Bounded', steps: [{ action: 'open', url: '{{url}}' }, { action: 'wait', ms: 500 }] });
  await saveTask({ id: 'fail-fast', name: 'Fail', steps: [{ action: 'open', url: '{{url}}' }, { action: 'click', selector: '#missing', timeout: 100 }] });
  const selected = Array.from({ length: 4 }, (_, index) => profiles.add({ name: `Queue${index}`, url: site.url, headless: true, taskId: 'bounded' }));
  const statuses = new Map(); let peak = 0;
  const listener = record => { statuses.set(record.runId, record.status); peak = Math.max(peak, [...statuses.values()].filter(s => ['launching', 'running', 'cancelling'].includes(s)).length); };
  runs.on('update', listener);
  try {
    const first = await submitBatch({ profileIds: selected.slice(0, 2).map(p => p.id), concurrency: 2 });
    await assert.rejects(submitBatch({ profileIds: [selected[0].id], concurrency: 2 }), /占用/);
    const second = await submitBatch({ profileIds: selected.slice(2).map(p => p.id), concurrency: 2 });
    const outcomes = await Promise.all([first.done, second.done]);
    assert.equal(outcomes.flatMap(batch => batch.results).filter(result => result.ok).length, 4);
    assert.equal(peak, 2);
  } finally { runs.off('update', listener); }
  profiles.update(selected[0].id, { taskId: 'fail-fast' });
  const mixed = await submitBatch({ profileIds: selected.slice(0, 2).map(p => p.id), concurrency: 2 });
  const outcome = await mixed.done;
  assert.equal(outcome.results[0].ok, false); assert.equal(outcome.results[1].ok, true);
});

test('取消排队和执行中的任务，释放 Profile 后可以重新提交', { timeout: 40000 }, async () => {
  await saveTask({ id: 'long-wait', name: 'Long wait', steps: [{ action: 'open', url: '{{url}}' }, { action: 'wait', ms: 10000 }] });
  const a = profiles.add({ name: 'Cancel A', url: site.url, headless: true, taskId: 'long-wait' });
  const b = profiles.add({ name: 'Cancel B', url: site.url, headless: true, taskId: 'long-wait' });
  const batch = await submitBatch({ profileIds: [a.id, b.id], concurrency: 1 });
  await until(() => getRun(batch.runIds[0]).status === 'running');
  await cancelRun(batch.runIds[1]); assert.equal(getRun(batch.runIds[1]).status, 'cancelled');
  const retry = await submitBatch({ profileIds: [b.id], taskId: 'open-page', concurrency: 1 });
  await cancelRun(batch.runIds[0]); await batch.done;
  assert.equal(getRun(batch.runIds[0]).status, 'cancelled');
  assert.equal((await retry.done).results[0].ok, true);
  assert.equal(getSession(a.id), null);
});

test('官方 MCP 与 Playwright 共用 Profile，JSON mcp 步骤返回真实快照', { timeout: 40000 }, async () => {
  const profile = profiles.add({ name: 'MCP task', url: site.url, headless: true, taskId: 'mcp-snapshot' });
  const batch = await submitBatch({ profileIds: [profile.id], keepOpen: true });
  const result = await batch.done; assert.equal(result.results[0].ok, true, result.results[0].error);
  const run = getRun(batch.runIds[0]);
  const output = JSON.parse(fs.readFileSync(path.join(run.outputDir, 'result.json'), 'utf8'));
  assert.match(JSON.stringify(output.vars.snapshot), /Automation Fixture/);
  assert.equal(await getSession(profile.id).context.pages()[0].title(), 'Automation Fixture');
  await close(profile.id);
});
