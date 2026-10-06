import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { workspace, fixture, until } from '../helpers.js';

test('桌面工作台：独立窗口、真实浏览器预览与退出清理', { timeout: 60000 }, async () => {
  const temp = workspace('bps-desktop-');
  const site = await fixture();
  const env = { ...process.env, PORT: '0', BPS_NO_OPEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  let desktop;
  let origin;
  try {
    desktop = await electron.launch({ args: [path.resolve('.')], env, timeout: 20000 });
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(10000);
    await page.locator('#connDot.online').waitFor();
    origin = new URL(page.url()).origin;
    assert.equal(await page.locator('body.desktop').count(), 1);
    const properties = await desktop.evaluate(({ BrowserWindow, app }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const preferences = window.webContents.getLastWebPreferences();
      return { count: BrowserWindow.getAllWindows().length, visible: window.isVisible(),
        nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation,
        sandbox: preferences.sandbox, userData: app.getPath('userData') };
    });
    assert.equal(properties.count, 1); assert.equal(properties.visible, true);
    assert.equal(properties.nodeIntegration, false); assert.equal(properties.contextIsolation, true);
    assert.equal(properties.sandbox, true); assert.ok(properties.userData.startsWith(temp.root));
    await page.locator('#addProfileBtn').click();
    await page.locator('#pfName').fill('桌面工作空间');
    await page.locator('#pfUrl').fill(site.url);
    await page.locator('#pfHeadless').check();
    await page.locator('#drawerSave').click();
    await page.locator('#drawer').waitFor({ state: 'hidden' });
    await page.locator('.pc-foot [data-act="launch"]').click();
    await page.locator('.pc-preview img:not([hidden])').waitFor();
    assert.equal(await page.locator('.pc-status').innerText(), '运行中');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    fs.mkdirSync('test-results', { recursive: true });
    await until(async () => await page.locator('.toast').count() === 0);
    await page.screenshot({ path: 'test-results/desktop-workspace.png' });
    await desktop.close(); desktop = null;
    await assert.rejects(fetch(`${origin}/api/meta`, { signal: AbortSignal.timeout(1500) }));
  } finally {
    if (desktop) await desktop.close();
    await site.close(); temp.remove();
  }
});
