import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export function workspace(prefix) {
  process.env.BPS_REMOTE_DESKTOP = '0';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.BPS_DATA_DIR = path.join(root, 'data');
  process.env.BPS_TASKS_DIR = path.join(root, 'tasks');
  fs.mkdirSync(process.env.BPS_TASKS_DIR);
  return { root, remove() { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); } };
}

export async function until(predicate, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { const value = await predicate(); if (value) return value; await delay(25); }
  throw new Error(`Condition did not become true within ${timeout}ms`);
}

export async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`, async close() {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  } };
}

export async function fixture() {
  let cacheRequests = 0;
  return listen((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/download') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="fixture.txt"' });
      res.end('persistent download content'); return;
    }
    if (url.pathname === '/cache-token') {
      res.writeHead(200, { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'text/plain' });
      res.end(String(++cacheRequests)); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><title>Automation Fixture</title></head><body>
      <h1>Automation Fixture</h1><form action="/" method="get"><label for="prompt">Prompt</label><input id="prompt" name="q"><button type="submit">Search</button></form>
      <button id="apply" type="button">Apply</button><p id="message">Ready</p>
      <label for="upload">Upload</label><input id="upload" type="file" multiple><output id="uploads"></output>
      <a id="download" href="/download" download>Download file</a><a href="/next">Next</a>
      <script>const q=new URL(location.href).searchParams.get('q');
      if(q)document.querySelector('#message').textContent='Result: '+q;
      document.querySelector('#apply').onclick=()=>document.querySelector('#message').textContent=document.querySelector('#prompt').value;
      document.querySelector('#upload').onchange=e=>document.querySelector('#uploads').textContent=Array.from(e.target.files,f=>f.name).join(',');</script>
      </body></html>`);
  });
}

export async function proxy(label, credentials) {
  const requests = [];
  const endpoint = await listen((req, res) => {
    requests.push({ url: req.url, authorization: req.headers['proxy-authorization'] });
    if (credentials && req.headers['proxy-authorization'] !== `Basic ${Buffer.from(credentials).toString('base64')}`) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="fixture"' }); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(`<h1>${label}</h1>`);
  });
  endpoint.server.on('connect', (req, socket) => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  return { ...endpoint, requests };
}
