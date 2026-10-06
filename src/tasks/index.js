import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TASKS_DIR } from '../config.js';
import { readJSON, writeJSON } from '../store.js';
import { validateTask } from './schema.js';
import { AppError } from '../errors.js';
import { outputFile } from '../paths.js';

const builtin = [
  {
    id: 'open-only', name: '仅打开网页', description: '打开网址；配合「结束后保持打开」进行手动浏览和登录。', args: ['url'],
    steps: [{ action: 'open', url: '{{url}}' }],
  },
  {
    id: 'open-page', name: '打开并读取网页', description: '打开 Profile 的网址，读取标题和正文，保存整页截图。', args: ['url'],
    steps: [{ action: 'open', url: '{{url}}' }, { action: 'read', saveAs: 'page' }, { action: 'screenshot', name: 'page.png', fullPage: true }],
  },
  {
    id: 'screenshot', name: '网页截图', description: '访问任意网址并保存整页截图。', args: ['url'],
    steps: [{ action: 'open', url: '{{url}}' }, { action: 'screenshot', name: 'page.png', fullPage: true }],
  },
  {
    id: 'search-and-read', name: '填写并读取', description: '用 selector 参数指定输入框，填写提示词并回车，等待结果定位器出现。',
    args: ['url', 'prompt', 'selector', 'resultSelector'],
    steps: [{ action: 'open', url: '{{url}}' }, { action: 'type', selector: '{{vars.selector}}', text: '{{prompt}}', submit: 'Enter' },
      { action: 'wait', selector: '{{vars.resultSelector}}' }, { action: 'read', saveAs: 'page' }],
  },
  {
    id: 'login-and-check', name: '检查登录标记', description: '打开页面，等待提示词对应的文本出现；未出现则任务失败。', args: ['url', 'prompt'],
    steps: [{ action: 'open', url: '{{url}}' }, { action: 'wait', text: '{{prompt}}' }, { action: 'read', saveAs: 'page' }],
  },
  {
    id: 'mcp-snapshot', name: 'MCP 页面快照', description: '通过官方 Playwright MCP 打开网页并读取无障碍页面快照。', args: ['url'],
    steps: [{ action: 'mcp', tool: 'browser_navigate', arguments: { url: '{{url}}' } },
      { action: 'mcp', tool: 'browser_snapshot', saveAs: 'snapshot' }],
  },
];

let cache;
async function load() {
  const all = builtin.map(input => ({ ...validateTask(input), source: 'builtin', kind: 'json' }));
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  for (const file of fs.readdirSync(TASKS_DIR).sort()) {
    if (!/\.(json|m?js)$/.test(file)) continue;
    const filename = path.join(TASKS_DIR, file);
    if (!fs.statSync(filename).isFile()) continue;
    let definitions;
    if (file.endsWith('.json')) {
      const data = readJSON(filename);
      definitions = Array.isArray(data) ? data : [data];
    } else {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      const module = await import(`${pathToFileURL(filename).href}?v=${hash}`);
      definitions = [module.default];
    }
    for (const definition of definitions) {
      all.push({ ...validateTask(definition, file), source: file, kind: file.endsWith('.json') ? 'json' : 'js' });
    }
  }
  const ids = new Set();
  for (const task of all) {
    if (ids.has(task.id)) throw new AppError(`任务 ID 重复：${task.id}（${task.source}）`);
    ids.add(task.id);
  }
  return all;
}

export async function listTasks() {
  if (!cache) {
    cache = load();
    cache.catch(() => { cache = undefined; });
  }
  return cache;
}
export async function getTask(id) { return (await listTasks()).find(task => task.id === id) || null; }
export async function reloadTasks() { cache = undefined; return listTasks(); }
export async function taskSummaries() {
  return (await listTasks()).map(({ id, name, description, args, source, kind, steps, defaults }) => ({
    id, name, description: description || '', args: args || [], source, kind, defaults: defaults || {}, steps: steps?.length || 1,
  }));
}

export async function saveTask(input, replace = false) {
  const task = validateTask(input);
  if (task.run) throw new AppError('界面只保存 JSON 步骤；JS 插件请放入 tasks 目录');
  const existing = await getTask(task.id);
  if (existing && (!replace || existing.source !== `${task.id}.json`)) throw new AppError('任务 ID 已存在；内置任务和 JS 插件请另存为新 ID', 409);
  writeJSON(outputFile(TASKS_DIR, `${task.id}.json`), task);
  await reloadTasks();
  return task;
}
