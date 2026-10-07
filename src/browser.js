import fs from 'node:fs';
import { chromium } from 'playwright';
import lockfile from 'proper-lockfile';
import { userDataDir, resolveDownloadDir } from './store.js';
import { scopedLogger, bus } from './logger.js';
import { AppError } from './errors.js';
import { trackDownloads } from './downloads.js';
import { createVirtualDisplay, remoteDesktopEnabled } from './virtual-display.js';

const sessions = new Map();
const launches = new Map();
const closings = new Map();

function launchOptions(profile) {
  return {
    channel: 'chromium',
    headless: !remoteDesktopEnabled(),
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
  let display, context;
  const release = () => releasePromise ||= (async () => {
    try { if (display) await display.close(); } finally { await unlock(); }
  })();
  try {
    logger.info(`启动浏览器（${options.headless ? '无头' : '有头'}模式）`);
    if (!options.headless) display = await createVirtualDisplay(profile.viewport);
    context = await chromium.launchPersistentContext(userDataDir(profile.id), { ...options,
      ...(display ? { env: { ...process.env, DISPLAY: display.name },
        args: ['--window-position=0,0', `--window-size=${display.width},${display.height}`] } : {}) });
    context.setDefaultTimeout(30000);
    const session = {
      context, display, profile, signature, startedAt: Date.now(), closed: false,
      downloadDir: resolveDownloadDir(profile), onDownload: null, release,
    };
    fs.mkdirSync(session.downloadDir, { recursive: true });
    session.downloads = trackDownloads(context, session, logger);
    sessions.set(profile.id, session);
    if (display) display.child.once('exit', () => {
      if (!session.closed) {
        logger.error('虚拟屏幕退出，关闭对应浏览器实例');
        context.close().catch(error => logger.error(error.message));
      }
    });
    context.once('close', () => {
      session.closed = true;
      if (sessions.get(profile.id) === session) sessions.delete(profile.id);
      release().catch(error => logger.error(`释放 Profile 锁失败：${error.message}`));
      logger.info('浏览器已关闭'); bus.emit('sessions');
    });
    bus.emit('sessions');
    return session;
  } catch (error) {
    try { if (context) await context.close(); } finally { await release(); }
    throw new AppError(`浏览器启动失败：${error.message}`, 500, { cause: error });
  }
}

/** Coalesce simultaneous launches; never launch two processes on the same User Data. */
export async function launch(profile) {
  if (closings.has(profile.id)) await closings.get(profile.id);
  const options = launchOptions(profile);
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
    try { await session.context.close(); }
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
    profileId: s.profile.id, name: s.profile.name, startedAt: s.startedAt,
    pages: s.context.pages().length, headless: JSON.parse(s.signature).headless,
  }));
}

export function browserInfo() {
  const executablePath = chromium.executablePath();
  return { engine: 'chromium', headless: !remoteDesktopEnabled(), remoteControl: remoteDesktopEnabled(),
    installed: fs.existsSync(executablePath), executablePath };
}
