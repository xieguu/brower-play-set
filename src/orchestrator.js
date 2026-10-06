import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import PQueue from 'p-queue';
import { profiles, settings, resolveDownloadDir, profileIdSchema, urlSchema, writeJSON, readJSON } from './store.js';
import { launch, close, isRunning } from './browser.js';
import { getTask } from './tasks/index.js';
import { runTask } from './tasks/runner.js';
import { scopedLogger, logger } from './logger.js';
import { reserve, assertAvailable } from './activity.js';
import { ARTIFACT_DIR } from './config.js';
import { AppError, parse } from './errors.js';

export const runs = new EventEmitter();
runs.setMaxListeners(200);
const queue = new PQueue({ concurrency: 3 });
const records = new Map();
const jobs = new Map();
const active = new Set(['queued', 'launching', 'running', 'cancelling']);
const MAX_RECORDS = 200;
let stopping = false;

const batchSchema = z.object({
  profileIds: z.array(profileIdSchema).min(1).max(100), concurrency: z.number().int().min(1).max(20).optional(),
  taskId: z.string().min(1).optional(), prompt: z.string().max(50000).optional(), url: urlSchema.optional(),
  vars: z.record(z.string(), z.unknown()).optional(), headless: z.boolean().optional(),
  reuseBrowser: z.boolean().optional(), keepOpen: z.boolean().optional(),
}).strict();

function record(runId, patch) {
  const previous = records.get(runId);
  const next = { ...previous, ...patch, updatedAt: Date.now() };
  records.set(runId, next);
  if (next.outputDir) writeJSON(path.join(next.outputDir, 'run.json'), next);
  if (records.size > MAX_RECORDS) {
    const completed = [...records.values()].filter(item => !active.has(item.status)).sort((a, b) => a.createdAt - b.createdAt);
    for (const item of completed.slice(0, records.size - MAX_RECORDS)) records.delete(item.runId);
  }
  runs.emit('update', next);
  return next;
}

/** Restore completed history; interrupted records are displayed as errors after a restart. */
export function loadRunHistory() {
  if (!fs.existsSync(ARTIFACT_DIR)) return;
  const entries = [];
  for (const profile of fs.readdirSync(ARTIFACT_DIR, { withFileTypes: true })) {
    if (!profile.isDirectory() || !/^[0-9a-f]{12}$/.test(profile.name)) continue;
    for (const run of fs.readdirSync(path.join(ARTIFACT_DIR, profile.name), { withFileTypes: true })) {
      if (!run.isDirectory() || !/^run-[\w-]+$/.test(run.name)) continue;
      const entry = readJSON(path.join(ARTIFACT_DIR, profile.name, run.name, 'run.json'), null);
      if (!entry || entry.runId !== run.name || entry.profileId !== profile.name) continue;
      if (active.has(entry.status)) Object.assign(entry, { status: 'error', error: '上次运行被中断', finishedAt: Date.now() });
      entries.push(entry);
    }
  }
  for (const entry of entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_RECORDS)) records.set(entry.runId, entry);
}

export async function submitBatch(input) {
  if (stopping) throw new AppError('程序正在退出', 503);
  const opts = parse(batchSchema, input, '运行配置');
  if (new Set(opts.profileIds).size !== opts.profileIds.length) throw new AppError('同一批次不能重复选择 Profile');
  const prepared = [];
  for (const id of opts.profileIds) {
    const profile = profiles.get(id);
    if (!profile) throw new AppError(`Profile 不存在：${id}`, 404);
    const task = await getTask(opts.taskId ?? profile.taskId);
    if (!task) throw new AppError(`任务不存在：${opts.taskId ?? profile.taskId}`, 404);
    prepared.push({ profile, task });
  }
  // Validate the whole batch before reserving any profile or launching any browser.
  for (const { profile } of prepared) assertAvailable(profile.id);
  const concurrency = opts.concurrency ?? settings.all().concurrency;
  if ([...records.values()].some(item => active.has(item.status)) && queue.concurrency !== concurrency) {
    throw new AppError(`已有任务排队或执行中，当前全局并发为 ${queue.concurrency}；队列空闲后可调整`, 409);
  }
  queue.concurrency = concurrency;
  const batchId = `batch-${crypto.randomUUID()}`;
  const created = [];
  for (const { profile, task } of prepared) {
    const runId = `run-${crypto.randomUUID()}`;
    const outputDir = path.join(ARTIFACT_DIR, profile.id, runId);
    const release = reserve(profile.id, { kind: 'task', runId });
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const job = { runId, batchId, profile, task, opts, outputDir, release, done, resolveDone,
      controller: new AbortController(), started: false, finished: false };
    jobs.set(runId, job); created.push(job);
    record(runId, {
      runId, batchId, profileId: profile.id, profileName: profile.name, taskId: task.id, taskName: task.name,
      status: 'queued', createdAt: Date.now(), startedAt: null, finishedAt: null,
      step: 0, totalSteps: task.steps?.length || 1, artifacts: [], outputDir,
    });
  }
  logger.info(`批次已入队：${created.length} 个 Profile，全局并发 ${concurrency}`);
  for (const job of created) {
    queue.add(() => execute(job)).catch(error => {
      logger.error(`运行清理失败：${error.message}`);
      finish(job, { status: job.controller.signal.aborted ? 'cancelled' : 'error', error: error.message });
    });
  }
  const done = Promise.all(created.map(job => job.done)).then(results => {
    runs.emit('batch-done', { batchId, results });
    return { batchId, results };
  });
  return { batchId, runIds: created.map(job => job.runId), done };
}

function finish(job, outcome) {
  if (job.finished) return;
  job.finished = true;
  const result = { profileId: job.profile.id, runId: job.runId, ok: outcome.status === 'success', error: outcome.error || null };
  try {
    record(job.runId, { ...outcome, finishedAt: Date.now() });
    profiles.markRun(job.profile.id, outcome.status);
  } finally {
    jobs.delete(job.runId); job.release(); job.resolveDone(result);
  }
}

async function execute(job) {
  if (job.finished) return;
  const { profile, task, opts, runId, controller, outputDir } = job;
  const { signal } = controller;
  const log = scopedLogger(profile, runId);
  job.started = true;
  let session;
  let outcome;
  try {
    signal.throwIfAborted();
    record(runId, { status: 'launching', startedAt: Date.now() });
    if (opts.reuseBrowser === false && isRunning(profile.id)) await close(profile.id);
    signal.throwIfAborted();
    session = await launch(profile, { headless: opts.headless ?? profile.headless });
    signal.throwIfAborted();
    const downloadDir = path.join(resolveDownloadDir(profile), runId);
    fs.mkdirSync(downloadDir, { recursive: true });
    session.downloadDir = downloadDir;
    const addArtifact = (file, type = 'download') => {
      const artifacts = records.get(runId).artifacts;
      if (!artifacts.some(item => item.file === file)) record(runId, { artifacts: [...artifacts, { file, name: path.basename(file), type }] });
    };
    session.onDownload = addArtifact;
    record(runId, { status: 'running' });
    const result = await runTask({
      profile, task, context: session.context, logger: log, runId, signal,
      downloads: session.downloads, args: { url: opts.url ?? profile.url, prompt: opts.prompt ?? profile.prompt, vars: opts.vars || {} },
      paths: { downloadDir, screenshotDir: outputDir }, onArtifact: addArtifact,
      onProgress: progress => record(runId, progress),
    });
    if (!signal.aborted) await session.downloads.flush();
    const resultPath = path.join(outputDir, 'result.json');
    writeJSON(resultPath, result); addArtifact(resultPath, 'result');
    outcome = { status: signal.aborted ? 'cancelled' : result.ok ? 'success' : 'error', steps: result.steps, error: result.error || null };
  } catch (error) {
    outcome = { status: signal.aborted ? 'cancelled' : 'error', error: signal.aborted ? '任务已取消' : error.message };
    log[outcome.status === 'cancelled' ? 'info' : 'error'](outcome.error);
  } finally {
    try {
      if (session) { session.onDownload = null; session.downloadDir = resolveDownloadDir(profile); }
      if (!opts.keepOpen || signal.aborted) await close(profile.id);
    } catch (error) {
      outcome = { status: signal.aborted ? 'cancelled' : 'error', error: `${outcome?.error || ''} 关闭浏览器失败：${error.message}`.trim() };
    }
    finish(job, outcome);
  }
}

export async function runBatch(options) { return (await submitBatch(options)).done; }

export async function cancelRun(runId) {
  const job = jobs.get(runId);
  if (!job) return false;
  job.controller.abort(new Error('任务已取消'));
  if (!job.started) { finish(job, { status: 'cancelled', error: '排队任务已取消' }); return true; }
  record(runId, { status: 'cancelling' });
  await close(job.profile.id);
  return true;
}

export async function stopAllRuns() {
  stopping = true;
  const pending = [...jobs.values()];
  await Promise.all(pending.map(job => cancelRun(job.runId)));
  await Promise.all(pending.map(job => job.done));
  await queue.onIdle();
}

export function listRuns(limit = 50) { return [...records.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit); }
export function getRun(id) { return records.get(id) || null; }
export function queueStatus() {
  const values = [...records.values()];
  return { concurrency: queue.concurrency, queued: values.filter(item => item.status === 'queued').length,
    running: values.filter(item => ['launching', 'running', 'cancelling'].includes(item.status)).length };
}
