#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { profiles, settings, ensureDataDirs, userDataDir } from './store.js';
import { HOST, PORT } from './config.js';
import { taskSummaries } from './tasks/index.js';
import { runBatch, stopAllRuns } from './orchestrator.js';
import { closeAll, withProfileDirectoryLock } from './browser.js';

const help = `Browser Play Set

  serve [--port 8787]                      启动本地 GUI
  list                                    列出 Profile
  add --name A --url https://example.com   创建 Profile
  remove ID [--purge]                      删除配置；可选清除登录数据
  tasks                                   列出 JSON / JS 任务
  run --profile ID [--profile ID2]         运行所选 Profile
  run --all --concurrency 3                批量运行
  mcp-config --profile ID                  输出 MCP HTTP 客户端配置
  settings [--concurrency 3]               查看或更新设置

add/run: --task ID --prompt TEXT --headless
add:     --proxy http://HOST:PORT --download-dir PATH
run:     --url URL --vars '{"key":"value"}' --keep-open --fresh

环境变量：BPS_DATA_DIR、BPS_TASKS_DIR、PORT、BPS_NO_OPEN=1
Windows 首次运行 setup.cmd，以后双击 start.cmd。`;

const out = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const defined = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'serve';
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, name: { type: 'string' }, url: { type: 'string' }, task: { type: 'string' },
    prompt: { type: 'string' }, proxy: { type: 'string' }, headless: { type: 'boolean' },
    'download-dir': { type: 'string' }, profile: { type: 'string', multiple: true }, all: { type: 'boolean' },
    concurrency: { type: 'string' }, 'keep-open': { type: 'boolean' }, fresh: { type: 'boolean' },
    purge: { type: 'boolean' }, port: { type: 'string' }, vars: { type: 'string' },
  } });
  if (values.help) return out(help);
  ensureDataDirs();
  if (command === 'serve') {
    const { startServer } = await import('./server.js');
    const runtime = await startServer({ port: values.port === undefined ? PORT : Number(values.port) });
    out(`Browser Play Set\n${runtime.origin}\n按 Ctrl+C 退出`);
    const stop = () => runtime.stop().catch(error => { console.error(error); process.exitCode = 1; });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return;
  }
  if (command === 'list') return out(profiles.all().map(({ proxy, ...p }) => ({ ...p, proxy: proxy?.server || null })));
  if (command === 'tasks') return out(await taskSummaries());
  if (command === 'add') return out(profiles.add(defined({
    name: values.name, url: values.url, taskId: values.task, prompt: values.prompt,
    proxy: values.proxy, headless: values.headless, downloadDir: values['download-dir'],
  })));
  if (command === 'remove') {
    const id = positionals[0];
    if (!id || !profiles.get(id)) throw new Error('请指定现有 Profile ID');
    await withProfileDirectoryLock(id, () => {
      if (values.purge) fs.rmSync(userDataDir(id), { recursive: true, force: true });
      profiles.remove(id);
    });
    return out({ ok: true });
  }
  if (command === 'settings') return out(settings.update(defined({
    concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency), defaultHeadless: values.headless,
  })));
  if (command === 'mcp-config') {
    const ids = values.profile || [];
    if (!ids.length) throw new Error('使用 --profile ID 选择 Profile');
    for (const id of ids) if (!profiles.get(id)) throw new Error(`Profile 不存在：${id}`);
    const host = HOST === '::1' ? '[::1]' : HOST;
    if (['0.0.0.0', '::'].includes(HOST) && !process.env.BPS_PUBLIC_URL) throw new Error('远程 MCP 配置请从 Web 工作台复制，或设置 BPS_PUBLIC_URL');
    const origin = process.env.BPS_PUBLIC_URL || `http://${host}:${values.port || PORT}`;
    return out({ mcpServers: Object.fromEntries(ids.map(id => [`profile-${id}`, {
      url: `${origin.replace(/\/$/, '')}/mcp/${id}`,
      ...(process.env.BPS_ADMIN_PASSWORD ? { headers: { Authorization: 'Basic BASE64_USERNAME_PASSWORD' } } : {}),
    }])) });
  }
  if (command === 'run') {
    const ids = values.all ? profiles.all().map(p => p.id) : values.profile || positionals;
    const stop = async () => { await stopAllRuns(); await closeAll(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const result = await runBatch(defined({
      profileIds: ids, concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
      taskId: values.task, url: values.url, prompt: values.prompt, vars: values.vars === undefined ? undefined : JSON.parse(values.vars),
      headless: values.headless, keepOpen: values['keep-open'], reuseBrowser: !values.fresh,
    }));
    out(result);
    if (result.results.some(item => !item.ok)) process.exitCode = 1;
    return;
  }
  throw new Error(`未知命令：${command}\n${help}`);
}

main().catch(async error => {
  console.error(error.message);
  await closeAll();
  process.exitCode = 1;
});
