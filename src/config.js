import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.BPS_DATA_DIR || path.join(ROOT, 'data'));
export const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const USERDATA_DIR = path.join(DATA_DIR, 'userdata');
export const DOWNLOAD_DIR = path.join(DATA_DIR, 'downloads');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const ARTIFACT_DIR = path.join(DATA_DIR, 'artifacts');
export const TASKS_DIR = path.resolve(process.env.BPS_TASKS_DIR || path.join(ROOT, 'tasks'));
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const HOST = process.env.HOST || '127.0.0.1';
export const PORT = Number(process.env.PORT || 8787);
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

if (!HOST.trim() || /[\s/]/.test(HOST)) throw new Error('HOST 必须是有效监听地址');
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('PORT 必须是 0–65535 的整数');
