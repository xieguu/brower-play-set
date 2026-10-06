import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-unit-'));
process.env.BPS_DATA_DIR = path.join(temp, 'data');
process.env.BPS_TASKS_DIR = path.join(temp, 'tasks');
const { normalizeProfile, normalizeProxy, profiles, settings, readJSON, userDataDir, resolveDownloadDir } = await import('../src/store.js');
const { PROFILES_FILE } = await import('../src/config.js');
const { interpolate } = await import('../src/tasks/template.js');
const { taskSummaries, getTask, reloadTasks, saveTask } = await import('../src/tasks/index.js');
const { validateTask } = await import('../src/tasks/schema.js');
const { outputFile } = await import('../src/paths.js');

after(() => { assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });

test('配置：隔离目录、不可注入 ID、保留提示词与代理密码空白', () => {
  const a = profiles.add({ name: ' A ', prompt: '  keep spaces\n', proxy: { server: 'http://localhost:8888', username: 'user', password: ' pass ' } });
  const b = profiles.add({ name: 'B' });
  assert.equal(a.name, 'A'); assert.equal(a.prompt, '  keep spaces\n'); assert.equal(a.proxy.password, ' pass ');
  assert.notEqual(userDataDir(a.id), userDataDir(b.id));
  assert.notEqual(resolveDownloadDir(a), resolveDownloadDir(b));
  assert.throws(() => profiles.add({ id: '../escape', name: 'bad' }));
  assert.throws(() => profiles.update(a.id, { id: b.id }));
  assert.throws(() => userDataDir('../../outside'));
  assert.equal(profiles.update(a.id, { url: 'https://unrestricted.example/path' }).id, a.id);
  profiles.markRun(a.id, 'cancelled'); assert.equal(profiles.get(a.id).lastStatus, 'cancelled');
});

test('配置：无效值明确报错，新 Profile 继承默认无头设置', () => {
  assert.throws(() => settings.update({ concurrency: 0 }));
  assert.throws(() => settings.update({ concurrency: 21 }));
  assert.throws(() => settings.update({ concurrency: '3' }));
  assert.throws(() => normalizeProfile({ viewport: { width: 10, height: 0 } }));
  assert.throws(() => normalizeProfile({ url: 'not a URL' }));
  assert.throws(() => normalizeProfile({ timezone: 'not-a-zone' }));
  settings.update({ defaultHeadless: true });
  assert.equal(profiles.add({ name: 'C' }).headless, true);
  assert.equal(profiles.add({ name: 'D', headless: false }).headless, false);
});

test('代理：解析 URL 认证，不接受 Chromium 不支持的 SOCKS 认证', () => {
  assert.deepEqual(normalizeProxy('http://user:p%40ss@127.0.0.1:8080'), { server: 'http://127.0.0.1:8080', username: 'user', password: 'p@ss' });
  assert.deepEqual(normalizeProxy('socks5://localhost:1080'), { server: 'socks5://localhost:1080' });
  assert.throws(() => normalizeProxy({ server: 'socks5://localhost:1080', username: 'u', password: 'p' }), /Chromium/);
  assert.throws(() => normalizeProxy('localhost:8080'));
  assert.throws(() => normalizeProxy({ username: 'x', server: '' }));
  assert.equal(normalizeProxy('  '), null);
});

test('配置导入：整批校验、原子保存和全新实例 ID', () => {
  const before = fs.readFileSync(PROFILES_FILE, 'utf8');
  const document = { format: 'browser-play-set-profiles', version: 1, profiles: [
    { name: 'Imported A', prompt: '  keep\n', headless: false },
    { name: 'Imported B', timezone: 'invalid/timezone' },
  ] };
  assert.throws(() => profiles.import(document), /语言或时区/);
  assert.equal(fs.readFileSync(PROFILES_FILE, 'utf8'), before);
  assert.throws(() => profiles.import({ ...document, version: 2 }));
  assert.throws(() => profiles.import({ ...document, profiles: [{ id: '123456789abc' }] }));
  document.profiles[1] = { name: 'Imported B', proxy: { server: 'http://localhost:8888', password: ' pass ' } };
  const first = profiles.import(document);
  const second = profiles.import(document);
  assert.equal(new Set([...first, ...second].map(p => p.id)).size, 4);
  assert.equal(first[0].prompt, '  keep\n'); assert.equal(first[0].headless, false);
  assert.equal(first[1].proxy.password, ' pass ');
  assert.equal(fs.existsSync(userDataDir(first[0].id)), false);
  assert.deepEqual(profiles.all().slice(0, JSON.parse(before).length), JSON.parse(before));
});

test('持久化：损坏或错误类型的配置不能悄悄变为空列表', () => {
  const original = fs.readFileSync(PROFILES_FILE);
  try {
    fs.writeFileSync(PROFILES_FILE, '{ broken');
    assert.throws(() => profiles.all(), /JSON 文件损坏/);
    assert.throws(() => profiles.add({ name: 'should fail' }), /JSON 文件损坏/);
    assert.equal(fs.readFileSync(PROFILES_FILE, 'utf8'), '{ broken');
    fs.writeFileSync(PROFILES_FILE, 'null'); assert.throws(() => profiles.all());
    fs.writeFileSync(PROFILES_FILE, '\uFEFF[]'); assert.deepEqual(profiles.all(), []);
  } finally { fs.writeFileSync(PROFILES_FILE, original); }
  assert.deepEqual(readJSON(path.join(temp, 'new-file.json'), []), []);
});

test('模板：保留类型，缺失变量和原型属性访问失败', () => {
  const scope = { prompt: 'hello', vars: { enabled: false, count: 2, files: ['a', 'b'] } };
  assert.equal(interpolate('{{vars.enabled}}', scope), false);
  assert.equal(interpolate('{{vars.count}}', scope), 2);
  assert.deepEqual(interpolate('{{vars.files}}', scope), ['a', 'b']);
  assert.equal(interpolate('count={{vars.count}}', scope), 'count=2');
  assert.throws(() => interpolate('{{vars.missing}}', scope), /未定义/);
  assert.throws(() => interpolate('{{vars.constructor}}', scope), /未定义/);
});

test('JSON 任务：无效 action、空步骤、跳过错误、缺少输入均被拒绝', () => {
  for (const steps of [[], [{ action: 'does-not-exist' }], [{ action: 'click' }], [{ action: 'log', message: 'a', continueOnError: true }], [{ action: 'upload', selector: '#file' }]]) {
    assert.throws(() => validateTask({ id: 'invalid', name: 'invalid', steps }));
  }
  assert.throws(() => validateTask({ id: 'bad', name: 'bad', steps: [{ action: 'wait', ms: 0, selector: 'body' }] }));
});

test('任务注册：JSON 保存、重复 ID 检测、损坏文件可见、JS 内容更新生效', async () => {
  const list = await taskSummaries(); assert.ok(list.some(t => t.id === 'mcp-snapshot'));
  const task = { id: 'custom', name: 'Custom', steps: [{ action: 'log', message: 'hello' }] };
  await saveTask(task); assert.equal((await getTask('custom')).name, 'Custom');
  await assert.rejects(saveTask(task), /已存在/);
  fs.writeFileSync(path.join(process.env.BPS_TASKS_DIR, 'bad.json'), '{broken');
  await assert.rejects(reloadTasks(), /JSON 文件损坏/);
  fs.rmSync(path.join(process.env.BPS_TASKS_DIR, 'bad.json'));
  const plugin = path.join(process.env.BPS_TASKS_DIR, 'fresh.mjs');
  fs.writeFileSync(plugin, 'export default {id:"fresh",name:"first",async run(){return 1}};');
  await reloadTasks(); assert.equal(await (await getTask('fresh')).run(), 1);
  fs.writeFileSync(plugin, 'export default {id:"fresh",name:"second",async run(){return 2}};');
  await reloadTasks(); assert.equal(await (await getTask('fresh')).run(), 2);
  fs.writeFileSync(path.join(process.env.BPS_TASKS_DIR, 'duplicate.json'), JSON.stringify(task));
  await assert.rejects(reloadTasks(), /重复/);
  fs.rmSync(path.join(process.env.BPS_TASKS_DIR, 'duplicate.json'));
  await reloadTasks();
});

test('Windows 产物路径：拒绝目录穿越和保留文件名', () => {
  for (const name of ['../outside', 'C:\\outside', 'CON', 'NUL.txt', 'a/b.png', 'bad.']) assert.throws(() => outputFile(temp, name));
  assert.equal(outputFile(temp, 'valid.png'), path.join(temp, 'valid.png'));
});
