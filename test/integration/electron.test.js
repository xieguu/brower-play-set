import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, fixture, until } from '../helpers.js';

const temp = workspace('bps-electron-');
const site = await fixture();
const { profiles, userDataDir } = await import('../../src/store.js');
const { launch, close, closeAll, getSession } = await import('../../src/browser.js');

after(async () => { await closeAll(); await site.close(); temp.remove(); });

test('Electron 实例使用独立原生窗口、持久化会话和沙箱', { timeout: 30000 }, async () => {
  const profile = profiles.add({ name: 'Electron isolated window', headless: true });
  const running = await launch(profile);
  try {
    assert.ok(running.application, 'Profile must be hosted by an Electron application');
    const native = await running.application.evaluate(({ app, BrowserWindow, session }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const preferences = window.webContents.getLastWebPreferences();
      return { electron: process.versions.electron, count: BrowserWindow.getAllWindows().length,
        title: window.getTitle(), visible: window.isVisible(), userData: app.getPath('userData'),
        storage: window.webContents.session.storagePath,
        persistent: window.webContents.session.isPersistent(),
        defaultSession: window.webContents.session === session.defaultSession,
        nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation,
        sandbox: preferences.sandbox };
    });
    assert.ok(native.electron);
    assert.equal(native.count, 1);
    assert.match(native.title, /Electron isolated window/);
    assert.equal(native.visible, false);
    assert.equal(native.userData, userDataDir(profile.id));
    assert.equal(native.storage, path.join(userDataDir(profile.id), 'Default'));
    assert.equal(native.persistent, true);
    assert.equal(native.defaultSession, true);
    assert.equal(native.nodeIntegration, false);
    assert.equal(native.contextIsolation, true);
    assert.equal(native.sandbox, true);
    const page = running.context.pages()[0];
    await page.goto(site.url);
    assert.match(await running.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()),
      /Electron isolated window/);
    assert.deepEqual(await page.evaluate(() => ({ require: typeof require, process: typeof process })),
      { require: 'undefined', process: 'undefined' });
  } finally { await close(profile.id); }
});

test('Electron 多页面和网站弹窗仍属于同一实例，聚焦可恢复隐藏窗口', { timeout: 30000 }, async () => {
  const profile = profiles.add({ name: 'Electron pages', headless: true });
  const running = await launch(profile);
  try {
    const first = running.context.pages()[0];
    await first.goto(site.url);
    await first.evaluate(() => localStorage.setItem('identity', 'same-profile'));
    const second = await running.context.newPage();
    await second.goto(site.url);
    assert.equal(await second.evaluate(() => localStorage.getItem('identity')), 'same-profile');
    const popupEvent = first.waitForEvent('popup');
    await first.evaluate(url => window.open(url, '_blank'), site.url);
    const popup = await popupEvent;
    await popup.waitForLoadState();
    assert.equal(await popup.evaluate(() => localStorage.getItem('identity')), 'same-profile');
    const windows = await running.application.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows().map(window => {
      const preferences = window.webContents.getLastWebPreferences();
      return { visible: window.isVisible(), sameSession: window.webContents.session === session.defaultSession,
        nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox };
    }));
    assert.equal(windows.length, 3);
    for (const window of windows) {
      assert.equal(window.visible, false);
      assert.equal(window.sameSession, true);
      assert.equal(window.nodeIntegration, false);
      assert.equal(window.contextIsolation, true);
      assert.equal(window.sandbox, true);
    }
    await running.focus(second);
    const nativeWindow = await running.application.browserWindow(second);
    try { assert.equal(await nativeWindow.evaluate(window => window.isVisible()), true); }
    finally { await nativeWindow.dispose(); }
    await popup.close(); await second.close();
    assert.equal(running.context.pages().length, 1);
  } finally { await close(profile.id); }
});

test('Electron 独立进程、语言时区、User-Agent 和初始窗口尺寸覆盖所有新窗口', { timeout: 30000 }, async () => {
  const a = profiles.add({ name: 'Japanese', headless: true, locale: 'ja-JP', timezone: 'Asia/Tokyo',
    userAgent: 'Profile-A/1.0', viewport: { width: 900, height: 640 } });
  const b = profiles.add({ name: 'English', headless: true, locale: 'en-US', timezone: 'America/New_York',
    userAgent: 'Profile-B/1.0', viewport: { width: 1024, height: 768 } });
  const [sa, sb] = await Promise.all([launch(a), launch(b)]);
  try {
    assert.notEqual(await sa.application.evaluate(() => process.pid), await sb.application.evaluate(() => process.pid));
    const extra = await Promise.all([sa.context.newPage(), sa.context.newPage()]);
    assert.notEqual(extra[0], extra[1]);
    for (const [running, profile] of [[sa, a], [sb, b]]) {
      for (const page of running.context.pages()) {
        await page.goto(site.url);
        assert.deepEqual(await page.evaluate(() => ({ locale: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, userAgent: navigator.userAgent })), {
          locale: profile.locale, timezone: profile.timezone, userAgent: profile.userAgent,
        });
        const window = await running.application.browserWindow(page);
        try {
          const [width, height] = await window.evaluate(window => window.getContentSize());
          const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          assert.ok(Math.abs(layout.width - width) <= 2 && Math.abs(layout.height - height) <= 2);
          assert.ok(width <= profile.viewport.width + 2 && height <= profile.viewport.height + 2);
        } finally { await window.dispose(); }
      }
    }
  } finally { await Promise.all([close(a.id), close(b.id)]); }
});

test('Electron 关闭最后一个实例窗口后释放锁，允许重新打开', { timeout: 30000 }, async () => {
  const profile = profiles.add({ name: 'Electron reopen', headless: true });
  const running = await launch(profile);
  const closed = running.application.waitForEvent('close');
  await running.context.pages()[0].close();
  await closed;
  await until(() => getSession(profile.id) === null);
  const reopened = await launch(profile);
  assert.ok(reopened.application);
  assert.notEqual(reopened.context, running.context);
  await close(profile.id);
});

test('Electron 页面随原生窗口缩放，居中弹窗始终位于可见内容区', { timeout: 30000 }, async () => {
  const profile = profiles.add({ name: 'Responsive Electron', headless: false,
    viewport: { width: 1280, height: 800 } });
  const running = await launch(profile);
  const page = running.context.pages()[0];
  const window = await running.application.browserWindow(page);
  try {
    await page.goto(site.url);
    await page.setContent(`<!doctype html><style>
      html,body { margin:0; width:100%; height:100%; font:16px sans-serif; }
      .backdrop { position:fixed; inset:0; display:grid; place-items:center; background:#eee; }
      .dialog { box-sizing:border-box; width:min(480px,calc(100% - 32px)); max-height:calc(100% - 32px);
        padding:32px; border-radius:20px; overflow:auto; background:white; }
      button { width:100%; height:48px; }
      </style><div class="backdrop"><section class="dialog"><h1>Login</h1>
      <p>The dialog stays centered when the window is resized.</p><button>Continue</button></section></div>`);
    await window.evaluate(window => window.setContentSize(800, 580));
    await page.waitForFunction(() => innerWidth > 0);
    const native = await window.evaluate(window => ({ size: window.getContentSize(), zoom: window.webContents.getZoomFactor() }));
    const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
      dialog: document.querySelector('.dialog').getBoundingClientRect().toJSON(), dpr: devicePixelRatio }));
    fs.mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/electron-responsive.png' });
    assert.ok(Math.abs(layout.width * native.zoom - native.size[0]) <= 2,
      `Visible content and layout viewport must match: ${JSON.stringify({ native, layout })}`);
    assert.ok(Math.abs(layout.height * native.zoom - native.size[1]) <= 2);
    assert.ok(layout.dialog.x >= 0 && layout.dialog.right * native.zoom <= native.size[0] + 2);
    assert.ok(layout.dialog.y >= 0 && layout.dialog.bottom * native.zoom <= native.size[1] + 2);
  } finally { await window.dispose(); await close(profile.id); }
});
