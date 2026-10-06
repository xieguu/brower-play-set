import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import open from 'open';
import { HOST, PORT, PUBLIC_DIR, DATA_DIR, TASKS_DIR, VERSION } from './config.js';
import { ensureDataDirs, profiles, profileInputSchema, settings, userDataDir, resolveDownloadDir } from './store.js';
import { bus, recentLogs, clearLogs, logger, setLogRetention } from './logger.js';
import { taskSummaries, getTask, reloadTasks, saveTask } from './tasks/index.js';
import { submitBatch, listRuns, getRun, runs, cancelRun, stopAllRuns, queueStatus, loadRunHistory } from './orchestrator.js';
import { launch, close, closeAll, activeSessions, isRunning, browserInfo, withProfileDirectoryLock } from './browser.js';
import { activity, activities, assertAvailable } from './activity.js';
import { handleMcp, disconnectMcp, closeAllMcp, mcpSessions } from './mcp-http.js';
import { AppError, parse } from './errors.js';
import { createSystemMonitor, capturePreview, currentPage } from './monitor.js';

const require = createRequire(import.meta.url);
const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(next);
const count = (value, initial, max = 200) => value === undefined ? initial : Math.max(1, Math.min(Number(value) || initial, max));

function localOnly(req, res, next) {
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { return res.status(403).json({ error: '无效 Host' }); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) || Number(host.port || 80) !== req.socket.localPort) {
    return res.status(403).json({ error: '只接受本机地址请求' });
  }
  if (req.headers.origin && req.headers.origin !== host.origin) return res.status(403).json({ error: '拒绝跨站请求' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '拒绝跨站请求' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

function editable(id) {
  assertAvailable(id);
  if (isRunning(id)) throw new AppError('请先关闭此 Profile 的浏览器，再修改配置', 409);
}

export function createApp() {
  ensureDataDirs();
  profiles.all();
  setLogRetention(settings.all().logRetention);
  const app = express();
  const systemMetrics = createSystemMonitor();
  const eventClients = new Set();
  app.disable('x-powered-by');
  app.use(localOnly);
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const api = express.Router();
  app.use('/api', api);

  api.get('/meta', (req, res) => res.json({
    version: VERSION, platform: process.platform, node: process.version, dataDir: DATA_DIR, tasksDir: TASKS_DIR,
    playwright: require('playwright/package.json').version, mcp: require('@playwright/mcp/package.json').version,
    browser: browserInfo(), queue: queueStatus(),
  }));
  api.get('/settings', (req, res) => res.json(settings.all()));
  api.get('/system', (req, res) => res.json(systemMetrics()));
  api.put('/settings', (req, res) => {
    const value = settings.update(req.body); setLogRetention(value.logRetention); res.json(value);
  });

  api.get('/tasks', wrap(async (req, res) => res.json(await taskSummaries())));
  api.post('/tasks/reload', wrap(async (req, res) => res.json({ tasks: (await reloadTasks()).length })));
  api.post('/tasks', wrap(async (req, res) => res.status(201).json(await saveTask(req.body))));
  api.put('/tasks/:id', wrap(async (req, res) => {
    if (req.body.id !== req.params.id) throw new AppError('任务 ID 与路径不一致');
    res.json(await saveTask(req.body, true));
  }));
  api.get('/tasks/:id', wrap(async (req, res) => {
    const task = await getTask(req.params.id);
    if (!task) throw new AppError('任务不存在', 404);
    const { run, ...definition } = task; res.json(definition);
  }));

  api.get('/profiles', (req, res) => res.json(profiles.all().map(profile => ({
    ...profile, running: isRunning(profile.id), activity: activity(profile.id),
    userDataDir: userDataDir(profile.id), resolvedDownloadDir: resolveDownloadDir(profile),
  }))));
  api.post('/profiles', (req, res) => res.status(201).json(profiles.add(req.body)));
  api.post('/profiles/import', (req, res) => res.status(201).json({ profiles: profiles.import(req.body) }));
  api.put('/profiles/:id', (req, res) => {
    editable(req.params.id);
    const updated = profiles.update(req.params.id, req.body);
    if (!updated) throw new AppError('Profile 不存在', 404);
    res.json(updated);
  });
  api.post('/profiles/:id/duplicate', (req, res) => {
    const profile = profiles.get(req.params.id);
    if (!profile) throw new AppError('Profile 不存在', 404);
    const { id, createdAt, updatedAt, lastRunAt, lastStatus, ...config } = profile;
    res.status(201).json(profiles.add(parse(profileInputSchema, { ...config, name: `${profile.name.slice(0, 55)} 副本` })));
  });
  api.delete('/profiles/:id', wrap(async (req, res) => {
    const { id } = req.params;
    if (!profiles.get(id)) throw new AppError('Profile 不存在', 404);
    assertAvailable(id);
    await close(id);
    await withProfileDirectoryLock(id, () => {
      if (req.query.purge === '1') fs.rmSync(userDataDir(id), { recursive: true, force: true });
      profiles.remove(id);
    });
    res.json({ ok: true });
  }));

  api.get('/sessions', (req, res) => res.json(activeSessions()));
  api.get('/profiles/:id/preview', wrap(async (req, res) => {
    if (!profiles.get(req.params.id)) throw new AppError('Profile 不存在', 404);
    const { buffer, capturedAt } = await capturePreview(req.params.id);
    res.setHeader('X-Captured-At', String(capturedAt));
    res.type('jpeg').send(buffer);
  }));
  api.post('/profiles/:id/focus', wrap(async (req, res) => {
    if (!profiles.get(req.params.id)) throw new AppError('Profile 不存在', 404);
    const { session, page } = currentPage(req.params.id);
    await session.focus(page);
    res.json({ ok: true });
  }));
  api.post('/profiles/:id/launch', wrap(async (req, res) => {
    const profile = profiles.get(req.params.id);
    if (!profile) throw new AppError('Profile 不存在', 404);
    assertAvailable(profile.id);
    const existed = isRunning(profile.id);
    const session = await launch(profile);
    if (!existed && profile.url) await session.context.pages()[0].goto(profile.url, { waitUntil: 'domcontentloaded' });
    res.json({ ok: true });
  }));
  api.post('/profiles/:id/close', wrap(async (req, res) => {
    assertAvailable(req.params.id); res.json({ ok: await close(req.params.id) });
  }));

  api.post('/run', wrap(async (req, res) => {
    const { batchId, runIds } = await submitBatch(req.body); res.status(202).json({ batchId, runIds });
  }));
  api.get('/runs', (req, res) => res.json(listRuns(count(req.query.limit, 50))));
  api.get('/runs/:id', (req, res) => {
    const run = getRun(req.params.id); if (!run) throw new AppError('运行记录不存在', 404); res.json(run);
  });
  api.post('/runs/:id/cancel', wrap(async (req, res) => res.json({ ok: await cancelRun(req.params.id) })));
  api.get('/runs/:id/artifacts/:index', (req, res, next) => {
    const index = Number(req.params.index);
    const artifact = Number.isInteger(index) && index >= 0 ? getRun(req.params.id)?.artifacts[index] : null;
    if (!artifact || !fs.existsSync(artifact.file)) throw new AppError('产物不存在', 404);
    res.download(artifact.file, artifact.name, error => { if (error) next(error); });
  });

  api.get('/mcp', (req, res) => res.json(mcpSessions()));
  api.get('/profiles/:id/mcp-config', (req, res) => {
    if (!profiles.get(req.params.id)) throw new AppError('Profile 不存在', 404);
    res.json({ mcpServers: { [`profile-${req.params.id}`]: { url: `http://${req.headers.host}/mcp/${req.params.id}` } } });
  });
  api.post('/profiles/:id/mcp-disconnect', wrap(async (req, res) => res.json({ disconnected: await disconnectMcp(req.params.id) })));
  app.all('/mcp/:id', wrap(handleMcp));

  api.get('/logs', (req, res) => res.json(recentLogs(count(req.query.limit, 300, 20000))));
  api.delete('/logs', (req, res) => { clearLogs(); res.json({ ok: true }); });
  api.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.flushHeaders(); res.write('retry: 2000\n\n'); eventClients.add(res);
    const send = (type, value) => { if (!res.destroyed) res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`); };
    const onLog = value => send('log', value);
    const onRun = value => send('run', value);
    const onBatch = value => send('batch-done', value);
    const onClear = () => send('logs-cleared', {});
    const onSession = () => send('sessions', { sessions: activeSessions(), activities: activities() });
    bus.on('log', onLog); bus.on('logs-cleared', onClear); bus.on('sessions', onSession);
    runs.on('update', onRun); runs.on('batch-done', onBatch);
    send('snapshot', { logs: recentLogs(300), runs: listRuns(), sessions: activeSessions() });
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 25000);
    heartbeat.unref();
    res.on('close', () => {
      clearInterval(heartbeat); eventClients.delete(res);
      bus.off('log', onLog); bus.off('logs-cleared', onClear); bus.off('sessions', onSession);
      runs.off('update', onRun); runs.off('batch-done', onBatch);
    });
  });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.get('/vendor/lucide.js', (req, res) => res.sendFile(require.resolve('lucide/dist/umd/lucide.js')));
  app.use(express.static(PUBLIC_DIR));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || 500;
    if (status >= 500) logger.error(`${req.method} ${req.path}：${err.message}`);
    res.status(status).json({ error: err.message });
  });
  app.locals.closeEventClients = () => { for (const res of eventClients) res.end(); };
  return app;
}

export async function startServer({ port = PORT, host = HOST, openBrowser = false } = {}) {
  const app = createApp();
  loadRunHistory();
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener)); listener.once('error', reject);
  });
  const origin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  logger.info(`Browser Play Set v${VERSION}：${origin}`);
  if (openBrowser) open(origin).catch(error => logger.error(`打开界面失败，请访问 ${origin}：${error.message}`));
  return {
    app, server, origin,
    async stop() {
      await stopAllRuns(); await closeAllMcp(); await closeAll();
      app.locals.closeEventClients();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const runtime = await startServer({ openBrowser: process.env.BPS_NO_OPEN !== '1' && settings.all().autoOpenBrowser });
  console.log(`Browser Play Set\n${runtime.origin}\n数据目录：${DATA_DIR}\n按 Ctrl+C 退出`);
  let exiting = false;
  const shutdown = async () => {
    if (exiting) return; exiting = true;
    try { await runtime.stop(); process.exitCode = 0; }
    catch (error) { console.error(error); process.exitCode = 1; }
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
