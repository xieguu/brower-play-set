import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { workspace, until } from '../helpers.js';

const temp = workspace('bps-electron-layout-');
const entry = fileURLToPath(new URL('../../src/profile-window.cjs', import.meta.url));
after(() => temp.remove());

for (const scale of [1, 1.5, 2]) {
  test(`Electron ${scale * 100}% DPI：初始窗口、拉伸、最大化、还原和页面缩放`, { timeout: 30000 }, async () => {
    const userDataDir = path.join(temp.root, `dpi-${scale}`);
    fs.mkdirSync(userDataDir);
    const env = { ...process.env, BPS_ELECTRON_PROFILE: JSON.stringify({
      name: `DPI ${scale * 100}%`, userDataDir, headless: false, viewport: { width: 3840, height: 2160 },
    }) };
    delete env.ELECTRON_RUN_AS_NODE;
    const application = await electron.launch({ args: [entry, `--force-device-scale-factor=${scale}`], env,
      chromiumSandbox: true, timeout: 10000 });
    try {
      const page = await application.firstWindow();
      const window = await application.browserWindow(page);
      try {
        await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
          <style>html,body{margin:0;height:100%;font:16px sans-serif;background:#e8eef7}
          main{position:fixed;inset:0;display:grid;place-items:center}
          section{box-sizing:border-box;width:min(440px,calc(100% - 32px));max-height:calc(100% - 32px);
          padding:24px;border-radius:20px;background:#fff;overflow:auto}
          button{width:100%;height:44px;margin-top:12px}</style>
          <main><section><h1>Sign in</h1><p>Native viewport · ${scale * 100}% DPI</p>
          <button>Continue</button><button>Cancel</button></section></main>`);
        const initial = await application.evaluate(({ BrowserWindow, screen }) => {
          const bounds = BrowserWindow.getAllWindows()[0].getBounds();
          return { bounds, area: screen.getDisplayMatching(bounds).workArea };
        });
        assert.ok(initial.bounds.x >= initial.area.x - 2 && initial.bounds.y >= initial.area.y - 2);
        assert.ok(initial.bounds.x + initial.bounds.width <= initial.area.x + initial.area.width + 2);
        assert.ok(initial.bounds.y + initial.bounds.height <= initial.area.y + initial.area.height + 2);
        assert.ok(Math.abs(await page.evaluate(() => devicePixelRatio) - scale) < 0.01);

        const verifyLayout = async () => {
          const native = await window.evaluate(window => ({ size: window.getContentSize(), zoom: window.webContents.getZoomFactor() }));
          await page.waitForFunction(({ size, zoom }) => Math.abs(innerWidth * zoom - size[0]) <= 2 &&
            Math.abs(innerHeight * zoom - size[1]) <= 2, native, { timeout: 3000 });
          const rect = await page.locator('section').boundingBox();
          assert.ok(rect.x >= 0 && rect.y >= 0);
          assert.ok((rect.x + rect.width) * native.zoom <= native.size[0] + 2);
          assert.ok((rect.y + rect.height) * native.zoom <= native.size[1] + 2);
          assert.ok(Math.abs((rect.x + rect.width / 2) * native.zoom - native.size[0] / 2) <= 2);
          await page.getByRole('button', { name: 'Continue' }).click();
        };
        await verifyLayout();
        for (const size of [[800, 580], [520, 420], [960, 640]]) {
          await window.evaluate((window, [width, height]) => window.setContentSize(width, height), size);
          await verifyLayout();
        }
        await window.evaluate(window => window.maximize());
        await until(() => window.evaluate(window => window.isMaximized()));
        await verifyLayout();
        await window.evaluate(window => window.unmaximize());
        await until(() => window.evaluate(window => !window.isMaximized()));
        await verifyLayout();
        await window.evaluate(window => window.webContents.setZoomFactor(1.25));
        await verifyLayout();
        await window.evaluate(window => window.webContents.setZoomFactor(1));
        await verifyLayout();
        fs.mkdirSync('test-results', { recursive: true });
        await page.screenshot({ path: `test-results/electron-dpi-${scale * 100}.png` });
      } finally { await window.dispose(); }
    } finally { await application.close(); }
  });
}
