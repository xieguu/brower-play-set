import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { z } from 'zod';
import { getSession } from './browser.js';
import { reserve } from './activity.js';
import { AppError, parse } from './errors.js';
import { stopChild } from './virtual-display.js';
import { logger } from './logger.js';
import { LOG_DIR } from './config.js';

const viewers = new Map();
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('text'), text: z.string().min(1).max(20000) }),
  z.object({ action: z.literal('navigate'), url: z.string().url().refine(url => /^https?:\/\//i.test(url)) }),
  z.object({ action: z.enum(['back', 'forward', 'reload']) }),
]);

export function desktopInfo(id) {
  const session = getSession(id);
  if (!session || session.closed) throw new AppError('实例尚未启动，请先在工作台点击打开', 409);
  if (!session.display) throw new AppError('此实例未启用网页远程操作，请在 Ubuntu 运行 bash setup.sh 并重启服务', 503);
  return { name: session.profile.name, width: session.display.width, height: session.display.height };
}

export async function controlCommand(id, token, input) {
  const viewer = viewers.get(id);
  if (!viewer || viewer.closing || !token || token !== viewer.token) throw new AppError('远程操作连接已断开，请重新连接', 409);
  const command = parse(commandSchema, input);
  // Serialize toolbar operations with a bounded queue; VNC itself handles keyboard/mouse ordering.
  if (viewer.busy) throw new AppError('上一项操作尚未完成', 409);
  viewer.busy = true;
  viewer.pending = (async () => { try {
    const pages = viewer.session.context.pages();
    let page;
    for (const candidate of pages) {
      if (!candidate.isClosed() && await candidate.evaluate(() => document.hasFocus())) { page = candidate; break; }
    }
    if (!page) throw new AppError('请先点击远程网页，使需要操作的标签页获得焦点', 409);
    if (command.action === 'text') await page.keyboard.insertText(command.text);
    if (command.action === 'navigate') await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (command.action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
    if (command.action === 'forward') await page.goForward({ waitUntil: 'domcontentloaded', timeout: 30000 });
    if (command.action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    return { ok: true, url: page.url() };
  } finally { viewer.busy = false; } })();
  return viewer.pending;
}

export async function disconnectControl(id) {
  const viewer = viewers.get(id);
  if (viewer) await viewer.close();
}

/** x11vnc inetd gets a bidirectional socket, not separate stdin/stdout pipes. */
async function connectVnc(display) {
  let child, peer, client;
  const listener = net.createServer({ pauseOnConnect: true });
  let errorText = '';
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `vnc-${crypto.randomUUID()}.log`);
  await new Promise((resolve, reject) => {
    listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve);
  });
  try {
    const accepted = new Promise((resolve, reject) => {
      listener.once('connection', socket => {
        peer = socket;
        peer.on('error', () => {});
        child = spawn('x11vnc', ['-inetd', '-q', '-o', logFile, '-display', display, '-nopw', '-noshm', '-noxdamage', '-xkb', '-repeat'],
          { stdio: [socket, socket, 'pipe'] });
        child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-2000); });
        child.once('error', reject); child.once('spawn', resolve);
      });
      client = net.connect(listener.address().port, '127.0.0.1');
      client.once('error', reject);
    });
    await accepted;
    return { child, socket: client,
      diagnostic: () => errorText + (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-2000) : ''),
      async close() {
        client.destroy(); peer.destroy(); await stopChild(child); fs.rmSync(logFile, { force: true });
      } };
  } catch (error) {
    client?.destroy(); peer?.destroy(); if (child?.pid) await stopChild(child);
    fs.rmSync(logFile, { force: true });
    throw error;
  } finally { listener.close(); }
}

export function attachRemoteControl(server, access) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const connections = new Set();
  const upgrade = async (req, socket, head) => {
    socket.on('error', () => {});
    const deny = status => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const status = access.check(req);
    if (status) return deny(status);
    // Browser WebSockets must supply the same Origin, including authenticated connections.
    if (req.headers.origin !== access.origin(req)) return deny(403);
    const match = /^\/api\/profiles\/([0-9a-f]{12})\/control-socket\?token=([0-9a-f]{64})$/.exec(req.url);
    if (!match) return deny(404);
    const [, id, token] = match;
    let release, backend;
    try {
      desktopInfo(id);
      release = reserve(id, { kind: 'remote' });
      const session = getSession(id);
      backend = await connectVnc(session.display.name);
      if (socket.destroyed || session.closed) throw new AppError('连接已关闭', 409);
      wss.handleUpgrade(req, socket, head, ws => {
        const stream = createWebSocketStream(ws);
        let closing;
        const viewer = { token, session, busy: false, closing: false, close: () => closing ||= (async () => {
          viewer.closing = true;
          ws.terminate(); stream.destroy();
          await backend.close(); session.context.off('close', viewer.close);
          if (viewer.pending) await viewer.pending.catch(() => {});
          viewers.delete(id); connections.delete(viewer); release();
        })() };
        viewers.set(id, viewer); connections.add(viewer);
        ws.on('error', () => viewer.close()); ws.on('close', () => viewer.close());
        stream.on('error', () => viewer.close()); backend.socket.on('error', () => viewer.close());
        backend.child.on('exit', code => {
          if (code && !viewer.closing) logger.error(`远程画面进程退出：${backend.diagnostic() || code}`);
          viewer.close();
        });
        session.context.once('close', viewer.close);
        backend.socket.pipe(stream).pipe(backend.socket);
        // Dead browser tabs/connections release exclusive control promptly.
        let alive = true;
        ws.on('pong', () => { alive = true; });
        const timer = setInterval(() => { if (!alive) viewer.close(); else { alive = false; ws.ping(); } }, 15000);
        timer.unref(); ws.once('close', () => clearInterval(timer));
      });
    } catch (error) {
      if (!error.status || error.status >= 500) logger.error(`远程操作连接失败：${error.message}`);
      if (backend) await backend.close(); release?.(); deny(error.status || 503);
    }
  };
  server.on('upgrade', upgrade);
  return async () => {
    server.off('upgrade', upgrade);
    await Promise.all([...connections].map(viewer => viewer.close()));
    await new Promise(resolve => wss.close(resolve));
  };
}
