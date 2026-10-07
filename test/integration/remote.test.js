import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { workspace, fixture, until } from '../helpers.js';

test('Ubuntu remote browser: real noVNC input, scaling, Chinese, isolation and cleanup',
  { skip: process.platform !== 'linux', timeout: 120000 }, async t => {
    const temp = workspace('bps-remote-');
    process.env.BPS_REMOTE_DESKTOP = '1';
    const { startServer } = await import('../../src/server.js');
    const { profiles } = await import('../../src/store.js');
    const { launch, getSession, close } = await import('../../src/browser.js');
    const { activity, reserve } = await import('../../src/activity.js');
    const site = await fixture();
    const credentials = { username: 'remote-admin', password: 'remote-test-password' };
    const headers = { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}` };
    const runtime = await startServer({ port: 0, ...credentials });
    const client = await chromium.launch({ channel: 'chromium', headless: true });
    let page;
    t.after(async () => {
      if (page && !page.isClosed()) {
        fs.mkdirSync('test-results', { recursive: true });
        await page.screenshot({ path: 'test-results/remote-final.png' });
      }
      await client.close(); await runtime.stop(); await site.close(); temp.remove();
    });
    const a = profiles.add({ name: 'Remote A', url: site.url, viewport: { width: 1000, height: 700 } });
    const b = profiles.add({ name: 'Remote B', url: site.url, viewport: { width: 1000, height: 700 } });
    const [sa, sb] = await Promise.all([launch(a), launch(b)]);
    assert.notEqual(sa.display.name, sb.display.name);
    const target = sa.context.pages()[0];
    await target.goto(site.url); await sb.context.pages()[0].goto(site.url);
    await target.bringToFront();
    const context = await client.newContext({ httpCredentials: credentials, viewport: { width: 1100, height: 850 } });
    page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const signals = [];
    page.on('console', message => { if (message.type() === 'error') signals.push(message.text().replace(/token=[a-f0-9]+/g, 'token=<REDACTED>')); });
    page.on('websocket', ws => ws.on('socketerror', error => signals.push(String(error).replace(/token=[a-f0-9]+/g, 'token=<REDACTED>'))));
    await page.goto(`${runtime.origin}/control.html?profile=${a.id}`);
    try { await page.locator('#status[data-state=connected]').waitFor({ timeout: 20000 }); }
    catch (error) {
      const { recentLogs } = await import('../../src/logger.js');
      throw new Error(JSON.stringify({ state: await page.locator('#status').textContent(),
        error: await page.locator('#error').textContent(), errors, signals,
        server: recentLogs().filter(entry => entry.level === 'error').map(entry => entry.message) }), { cause: error });
    }
    assert.equal(activity(a.id).kind, 'remote');
    assert.throws(() => reserve(a.id, { kind: 'task' }), /占用/);
    const canvas = page.locator('#screen canvas');
    await until(async () => (await canvas.evaluate(c => c.width)) === sa.display.width);
    async function remoteClick(selector) {
      const element = await target.locator(selector).boundingBox();
      const origin = await target.evaluate(() => ({ x: screenX + (outerWidth - innerWidth) / 2,
        y: screenY + outerHeight - innerHeight, w: screen.width, h: screen.height }));
      const frame = await canvas.boundingBox();
      await page.mouse.click(frame.x + (origin.x + element.x + element.width / 2) * frame.width / origin.w,
        frame.y + (origin.y + element.y + element.height / 2) * frame.height / origin.h);
    }
    await remoteClick('#prompt');
    await page.keyboard.type('remote-keyboard');
    await until(async () => await target.locator('#prompt').inputValue() === 'remote-keyboard');
    await page.locator('#text-panel summary').click();
    await page.locator('#text').fill('中文输入');
    await page.locator('#send').click();
    await until(async () => await target.locator('#prompt').inputValue() === 'remote-keyboard中文输入');
    await remoteClick('#apply');
    await until(async () => await target.locator('#message').textContent() === 'remote-keyboard中文输入');
    await page.setViewportSize({ width: 620, height: 900 });
    await remoteClick('#prompt');
    await page.keyboard.press('End'); await page.keyboard.type('-scaled');
    await until(async () => (await target.locator('#prompt').inputValue()).endsWith('-scaled'));
    await target.evaluate(() => { document.body.style.height = '2500px'; localStorage.setItem('remote-login', 'A'); });
    const frame = await canvas.boundingBox();
    await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
    await page.mouse.wheel(0, 500);
    await until(async () => await target.evaluate(() => scrollY > 0));
    assert.equal(await sb.context.pages()[0].evaluate(() => localStorage.getItem('remote-login')), null);
    fs.mkdirSync('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/remote-control.png' });
    assert.deepEqual(errors, []);

    const wsUrl = `${runtime.origin.replace('http:', 'ws:')}/api/profiles/${a.id}/control-socket?token=${'a'.repeat(64)}`;
    const rejected = await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { ...headers, Origin: runtime.origin } });
      ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
      ws.on('open', () => { ws.close(); reject(new Error('second viewer acquired control')); });
      ws.on('error', () => {});
    });
    assert.equal(rejected, 409);
    await page.locator('#disconnect').click();
    await until(() => activity(a.id) === null);
    assert.equal(getSession(a.id), sa, 'disconnect retains browser and login state');
    await page.locator('#reconnect').click();
    await page.locator('#status[data-state=connected]').waitFor();
    await close(a.id);
    await until(() => activity(a.id) === null);
    assert.ok(sa.display.child.exitCode !== null || sa.display.child.signalCode !== null);
    await until(async () => await page.locator('#status').textContent() === '已断开');
    const reopened = await launch(a);
    await reopened.context.pages()[0].goto(site.url);
    assert.equal(await reopened.context.pages()[0].evaluate(() => localStorage.getItem('remote-login')), 'A');
  });
