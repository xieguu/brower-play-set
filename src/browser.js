import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import PQueue from 'p-queue';
import lockfile from 'proper-lockfile';
import { userDataDir, resolveDownloadDir } from './store.js';
import { scopedLogger, bus } from './logger.js';
import { AppError } from './errors.js';
import { trackDownloads } from './downloads.js';

const sessions = new Map();
const launches = new Map();
const closings = new Map();
const require = createRequire(import.meta.url);
const profileEntry = fileURLToPath(new URL('./profile-window.cjs', import.meta.url));

function launchOptions(profile, opts) {
  return {
    headless: opts.headless ?? profile.headless,
    viewport: profile.viewport, acceptDownloads: true,
    locale: profile.locale, timezoneId: profile.timezone,
    ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
    ...(profile.proxy ? { proxy: profile.proxy } : {}),
  };
}

async function acquireDirectory(profileId) {
  const dir = userDataDir(profileId);
  fs.mkdirSync(dir, { recursive: true });
  try { return await lockfile.lock(dir, { retries: 0 }); }
  catch (error) {
    if (error.code === 'ELOCKED') throw new AppError('该 Profile 的 User Data 正被另一个进程使用', 409);
    throw error;
  }
}

/** Used by deletion too; a second CLI/GUI process cannot delete a live profile. */
export async function withProfileDirectoryLock(profileId, operation) {
  const unlock = await acquireDirectory(profileId);
  try { return await operation(); } finally { await unlock(); }
}

async function launchFresh(profile, options, signature) {
  const logger = scopedLogger(profile);
  const unlock = await acquireDirectory(profile.id);
  let releasePromise;
  const release = () => releasePromise ||= unlock();
  let application;
  try {
    logger.info(`启动 Electron 实例（${options.headless ? '后台' : '窗口'}模式）`);
    const { headless, viewport, proxy, userAgent, ...contextOptions } = options;
    const env = { ...process.env, BPS_ELECTRON_PROFILE: JSON.stringify({
      name: profile.name, userDataDir: userDataDir(profile.id), headless, viewport, proxy, userAgent,
    }) };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await electron.launch({ args: [profileEntry], env, ...contextOptions,
      chromiumSandbox: true, timeout: 30000 });
    const context = application.context();
    await application.firstWindow({ timeout: 30000 });
    // Electron pages must be BrowserWindows. Keep the context API used by tasks and MCP.
    const windows = new PQueue({ concurrency: 1 });
    context.newPage = () => windows.add(async () => {
      const [page] = await Promise.all([
        application.waitForEvent('window', { timeout: 30000 }),
        application.evaluate(({ app }) => app.emit('bps-new-window')),
      ]);
      return page;
    });
    context.setDefaultTimeout(30000);
    const session = {
      application, context, profile, signature, startedAt: Date.now(), closed: false,
      downloadDir: resolveDownloadDir(profile), onDownload: null, release,
      async focus(page = context.pages().at(-1)) {
        if (!page || page.isClosed()) throw new AppError('实例没有可显示的窗口', 409);
        const window = await application.browserWindow(page);
        try {
          await window.evaluate(window => {
            if (window.isMinimized()) window.restore();
            window.show(); window.focus();
          });
        } finally { await window.dispose(); }
        await page.bringToFront();
      },
    };
    fs.mkdirSync(session.downloadDir, { recursive: true });
    session.downloads = trackDownloads(context, session, logger);
    sessions.set(profile.id, session);
    application.once('close', () => {
      session.closed = true;
      if (sessions.get(profile.id) === session) sessions.delete(profile.id);
      release().catch(error => logger.error(`释放 Profile 锁失败：${error.message}`));
      logger.info('Electron 实例已关闭'); bus.emit('sessions');
    });
    bus.emit('sessions');
    return session;
  } catch (error) {
    try { if (application) await application.close(); }
    finally { await release(); }
    throw new AppError(`Electron 实例启动失败：${error.message}`, 500, { cause: error });
  }
}

/** Coalesce simultaneous launches; never launch two processes on the same User Data. */
export async function launch(profile, opts = {}) {
  if (closings.has(profile.id)) await closings.get(profile.id);
  const options = launchOptions(profile, opts);
  const signature = JSON.stringify(options);
  const existing = sessions.get(profile.id) || launches.get(profile.id);
  if (existing) {
    if (existing.signature !== signature) throw new AppError('浏览器已经打开且配置不同，请关闭后重新运行', 409);
    return existing.promise || existing;
  }
  const promise = launchFresh(profile, options, signature);
  const pending = { promise, signature };
  launches.set(profile.id, pending); bus.emit('sessions');
  try { return await promise; }
  finally { if (launches.get(profile.id) === pending) launches.delete(profile.id); bus.emit('sessions'); }
}

export function getSession(profileId) { return sessions.get(profileId) || null; }
export function isRunning(profileId) { return sessions.has(profileId) || launches.has(profileId) || closings.has(profileId); }

export async function close(profileId) {
  if (closings.has(profileId)) return closings.get(profileId);
  const promise = (async () => {
    const session = launches.has(profileId) ? await launches.get(profileId).promise : sessions.get(profileId);
    if (!session) return false;
    try { await session.application.close(); }
    finally { await session.release(); }
    return true;
  })();
  closings.set(profileId, promise);
  try { return await promise; }
  finally { closings.delete(profileId); bus.emit('sessions'); }
}

export async function closeAll() {
  const results = await Promise.allSettled([...new Set([...sessions.keys(), ...launches.keys()])].map(close));
  const failures = results.filter(r => r.status === 'rejected').map(r => r.reason);
  if (failures.length) throw new AggregateError(failures, '关闭浏览器失败');
}

export function activeSessions() {
  return [...sessions.values()].map(s => ({
    profileId: s.profile.id, name: s.profile.name, startedAt: s.startedAt, engine: 'electron',
    pages: s.context.pages().length, headless: JSON.parse(s.signature).headless,
  }));
}

export function browserInfo() {
  const executablePath = require('electron/index.js');
  return { engine: 'electron', version: require('electron/package.json').version,
    installed: fs.existsSync(executablePath), executablePath };
}
