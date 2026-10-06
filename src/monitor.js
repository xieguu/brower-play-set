import os from 'node:os';
import { getSession } from './browser.js';
import { AppError } from './errors.js';

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return sum;
  }, { idle: 0, total: 0 });
}

export function createSystemMonitor() {
  let previous = cpuTimes();
  let sampledAt = Date.now();
  let cpuPercent = null;
  return () => {
    const now = Date.now();
    if (now - sampledAt >= 1000) {
      const current = cpuTimes();
      const total = current.total - previous.total;
      cpuPercent = total > 0 ? Math.round(1000 * (1 - (current.idle - previous.idle) / total)) / 10 : null;
      previous = current; sampledAt = now;
    }
    const total = os.totalmem();
    return { sampledAt, cpuPercent, memory: { total, used: total - os.freemem() },
      processMemory: process.memoryUsage().rss, uptime: Math.floor(process.uptime()) };
  };
}

const previews = new WeakMap();
export function currentPage(profileId) {
  const session = getSession(profileId);
  if (!session || session.closed) throw new AppError('浏览器尚未启动', 409);
  const page = session.context.pages().at(-1);
  if (!page || page.isClosed()) throw new AppError('浏览器没有可预览的标签页', 409);
  return { session, page };
}

export async function capturePreview(profileId) {
  const { session, page } = currentPage(profileId);
  let entry = previews.get(session);
  if (entry?.page === page && entry.url === page.url()) {
    if (entry.pending) return entry.pending;
    if (entry.result && Date.now() - entry.result.capturedAt < 2500) return entry.result;
  }
  entry = { page, url: page.url() };
  previews.set(session, entry);
  entry.pending = page.screenshot({ type: 'jpeg', quality: 45, timeout: 3500 }).then(buffer => {
    entry.result = { buffer, capturedAt: Date.now() }; return entry.result;
  }).finally(() => { entry.pending = null; });
  return entry.pending;
}
