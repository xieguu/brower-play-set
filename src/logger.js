import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { LOG_DIR } from './config.js';

export const bus = new EventEmitter();
bus.setMaxListeners(200);
const ring = [];
let retention = 2000;

export function setLogRetention(value) { retention = value; ring.splice(0, Math.max(0, ring.length - retention)); }

export function log(level, message, meta = {}) {
  const entry = {
    id: crypto.randomUUID(), time: new Date().toISOString(), level, message: String(message),
    profile: meta.profile || null, profileName: meta.profileName || null,
    runId: meta.runId || null, data: meta.data ?? null,
  };
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, `${entry.time.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
  ring.push(entry);
  if (ring.length > retention) ring.splice(0, ring.length - retention);
  bus.emit('log', entry);
  return entry;
}

export const logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (message, meta) => log(level, message, meta)]));
export function scopedLogger(profile, runId) {
  return Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (message, data) => log(level, message, {
    profile: profile?.id, profileName: profile?.name, runId, data,
  })]));
}
export function recentLogs(limit = 300) { return ring.slice(-Math.max(1, Math.min(limit, retention))); }
export function clearLogs() { ring.length = 0; bus.emit('logs-cleared'); }
