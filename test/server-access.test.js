import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { workspace } from './helpers.js';

const temp = workspace('bps-access-');
const { startServer } = await import('../src/server.js');
const credentials = { username: 'test-admin', password: 'test-password' };
const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
const runtime = await startServer({ port: 0, host: '0.0.0.0', ...credentials, publicUrl: '' });
const origin = `http://127.0.0.1:${runtime.server.address().port}`;
after(async () => { await runtime.stop(); temp.remove(); });

test('public listener refuses missing or incomplete credentials', async () => {
  for (const options of [{ username: '', password: '' }, { username: 'admin', password: '' }]) {
    await assert.rejects(startServer({ port: 0, host: '0.0.0.0', ...options }), /BPS_ADMIN/);
  }
});

test('authentication covers UI, API, previews, SSE, artifacts and MCP', async () => {
  for (const route of ['/', '/app.js', '/control.html', '/control.js', '/vendor/novnc/core/rfb.js', '/api/meta', '/api/events', '/api/profiles/id/preview', '/api/runs/id/artifacts/0', '/mcp/id']) {
    const response = await fetch(origin + route);
    assert.equal(response.status, 401, route);
    assert.match(response.headers.get('www-authenticate'), /^Basic /);
    await response.arrayBuffer();
  }
  const wrong = await fetch(origin + '/api/meta', { headers: { Authorization: 'Basic YWRtaW46d3Jvbmc=' } });
  assert.equal(wrong.status, 401);
  await wrong.arrayBuffer();
  const response = await fetch(origin + '/api/meta', { headers: { Authorization: authorization } });
  assert.equal(response.status, 200);
  const meta = await response.json();
  assert.equal(meta.authentication, true);
  assert.equal(meta.browser.headless, true);
});

test('remote WebSocket enforces authentication and same-origin before upgrade', async () => {
  const url = `${origin.replace('http:', 'ws:')}/api/profiles/aaaaaaaaaaaa/control-socket?token=${'b'.repeat(64)}`;
  for (const [headers, expected] of [[{ Origin: origin }, 401],
    [{ Authorization: authorization, Origin: 'https://evil.invalid' }, 403],
    [{ Authorization: authorization }, 403]]) {
    const status = await new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
      ws.on('open', () => { ws.close(); reject(new Error('unauthorized upgrade')); });
      ws.on('error', () => {});
    });
    assert.equal(status, expected);
  }
});

test('authenticated cross-site requests are rejected; same-origin SSE works', async () => {
  for (const headers of [{ Origin: 'https://other.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(origin + '/api/profiles', { headers: { Authorization: authorization, ...headers } });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
  }
  const response = await fetch(origin + '/api/events', { headers: { Authorization: authorization, Origin: origin } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
  await reader.cancel();
});

test('remote MCP configuration uses the request origin without disclosing credentials', async () => {
  const response = await fetch(origin + '/api/profiles', { method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'remote' }) });
  assert.equal(response.status, 201);
  const profile = await response.json();
  const configResponse = await fetch(`${origin}/api/profiles/${profile.id}/mcp-config`, { headers: { Authorization: authorization } });
  const config = await configResponse.json();
  const server = config.mcpServers[`profile-${profile.id}`];
  assert.equal(server.url, `${origin}/mcp/${profile.id}`);
  assert.equal(server.headers.Authorization, 'Basic BASE64_USERNAME_PASSWORD');
  assert.ok(!JSON.stringify(config).includes(credentials.password));
});
