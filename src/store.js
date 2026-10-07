import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import lockfile from 'proper-lockfile';
import writeFileAtomic from 'write-file-atomic';
import { DATA_DIR, PROFILES_FILE, SETTINGS_FILE, USERDATA_DIR, DOWNLOAD_DIR, LOG_DIR, ARTIFACT_DIR } from './config.js';
import { AppError, parse } from './errors.js';
import { within } from './paths.js';

export const profileIdSchema = z.string().regex(/^[0-9a-f]{12}$/, '无效的 Profile ID');
const text = (max) => z.string().trim().max(max);
export const urlSchema = z.string().max(16384).refine(value => {
  if (value === '') return true;
  try { return ['http:', 'https:', 'file:', 'data:', 'about:'].includes(new URL(value).protocol); }
  catch { return false; }
}, '请输入完整 URL，例如 https://example.com（不限制域名）');

const proxySchema = z.object({
  server: text(2048), username: z.string().max(1000).optional(),
  password: z.string().max(1000).optional(), bypass: text(2000).optional(),
}).strict();

export const profileInputSchema = z.object({
  name: text(60).min(1).optional(), url: urlSchema.optional(),
  taskId: text(120).min(1).optional(), prompt: z.string().max(50000).optional(),
  proxy: z.union([z.string(), proxySchema, z.null()]).optional(),
  downloadDir: text(2000).optional(), headless: z.boolean().optional(),
  locale: text(60).min(1).optional(), timezone: text(100).min(1).optional(),
  userAgent: text(1000).optional(),
  viewport: z.object({ width: z.number().int().min(320).max(3840), height: z.number().int().min(240).max(2160) }).strict().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
}).strict();

const profileImportSchema = z.object({
  format: z.literal('browser-play-set-profiles'), version: z.literal(1),
  profiles: z.array(profileInputSchema).min(1).max(100),
}).strict();

const storedProfileSchema = profileInputSchema.required().extend({
  id: profileIdSchema, proxy: proxySchema.nullable(),
  createdAt: z.string(), updatedAt: z.string(), lastRunAt: z.string().nullable(),
  lastStatus: z.enum(['idle', 'success', 'error', 'cancelled']),
});

export const DEFAULT_SETTINGS = Object.freeze({
  concurrency: 3, defaultHeadless: true, defaultDownloadDir: DOWNLOAD_DIR,
  logRetention: 2000, theme: 'auto', autoOpenBrowser: false,
});
export const settingsSchema = z.object({
  concurrency: z.number().int().min(1).max(20), defaultHeadless: z.boolean(),
  defaultDownloadDir: text(2000).min(1), logRetention: z.number().int().min(100).max(20000),
  theme: z.enum(['auto', 'light', 'dark']), autoOpenBrowser: z.boolean(),
}).strict();

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, USERDATA_DIR, DOWNLOAD_DIR, LOG_DIR, ARTIFACT_DIR]) fs.mkdirSync(dir, { recursive: true });
}

/** Only a missing file means a new installation. Corrupt data is never replaced by defaults. */
export function readJSON(file, initial) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return initial; throw error; }
  try { return JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch (error) { throw new AppError(`JSON 文件损坏：${file}；${error.message}`, 500, { cause: error }); }
}

export function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic.sync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function mutate(file, operation) {
  ensureDataDirs();
  let unlock;
  try { unlock = lockfile.lockSync(file, { realpath: false }); }
  catch (error) { if (error.code === 'ELOCKED') throw new AppError('另一个进程正在更新配置，请重试', 409); throw error; }
  try { return operation(); } finally { unlock(); }
}

export function makeId() { return crypto.randomBytes(6).toString('hex'); }

export function normalizeProxy(input) {
  if (input == null || (typeof input === 'string' && !input.trim())) return null;
  const config = parse(proxySchema, typeof input === 'string' ? { server: input } : input, '代理');
  if (!config.server) {
    if (config.username || config.password) throw new AppError('代理凭据需要代理服务器地址');
    return null;
  }
  let url;
  try { url = new URL(config.server); } catch { throw new AppError('代理地址需要协议，例如 http://127.0.0.1:8080'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname ||
      (url.pathname && url.pathname !== '/') || url.search || url.hash) throw new AppError('代理必须是 HTTP、HTTPS、SOCKS4 或 SOCKS5 服务器地址');
  const username = config.username ?? decodeURIComponent(url.username);
  const password = config.password ?? decodeURIComponent(url.password);
  if (url.protocol.startsWith('socks') && (username || password)) throw new AppError('Chromium 不支持带用户名／密码的 SOCKS 代理，请使用无认证 SOCKS 或 HTTP 代理');
  url.username = ''; url.password = '';
  return {
    server: `${url.protocol}//${url.host}`,
    ...(username ? { username } : {}), ...(password ? { password } : {}),
    ...(config.bypass ? { bypass: config.bypass } : {}),
  };
}

export function normalizeProfile(input = {}, base = {}) {
  const patch = parse(profileInputSchema, input, 'Profile');
  const id = base.id || makeId();
  parse(profileIdSchema, id);
  const now = new Date().toISOString();
  const merged = {
    id, name: `Profile-${id.slice(0, 4)}`, url: '', taskId: 'open-page', prompt: '', proxy: null,
    downloadDir: '', headless: true, locale: 'zh-CN', timezone: 'Asia/Shanghai', userAgent: '',
    viewport: { width: 1280, height: 800 }, color: '#4f8cff',
    createdAt: now, lastRunAt: null, lastStatus: 'idle', ...base, ...patch, updatedAt: now,
  };
  merged.proxy = normalizeProxy(merged.proxy);
  try { new Intl.DateTimeFormat(merged.locale, { timeZone: merged.timezone }); }
  catch { throw new AppError('语言或时区无效'); }
  return parse(storedProfileSchema, merged, 'Profile');
}

export const profiles = {
  all() {
    const list = parse(z.array(storedProfileSchema), readJSON(PROFILES_FILE, []), PROFILES_FILE);
    if (new Set(list.map(p => p.id)).size !== list.length) throw new AppError('profiles.json 中存在重复 ID', 500);
    return list;
  },
  get(id) { parse(profileIdSchema, id); return this.all().find(p => p.id === id) || null; },
  add(input = {}) {
    return mutate(PROFILES_FILE, () => {
      const list = this.all();
      const profile = normalizeProfile({ headless: settings.all().defaultHeadless, ...input });
      list.push(profile); writeJSON(PROFILES_FILE, list); return profile;
    });
  },
  import(input) {
    const document = parse(profileImportSchema, input, '实例配置文件');
    return mutate(PROFILES_FILE, () => {
      const list = this.all();
      const defaults = { headless: settings.all().defaultHeadless };
      const imported = document.profiles.map(value => normalizeProfile({ ...defaults, ...value }));
      writeJSON(PROFILES_FILE, [...list, ...imported]);
      return imported;
    });
  },
  update(id, input) {
    parse(profileIdSchema, id);
    return mutate(PROFILES_FILE, () => {
      const list = this.all(); const index = list.findIndex(p => p.id === id);
      if (index < 0) return null;
      list[index] = normalizeProfile(input, list[index]);
      writeJSON(PROFILES_FILE, list); return list[index];
    });
  },
  remove(id) {
    parse(profileIdSchema, id);
    return mutate(PROFILES_FILE, () => {
      const list = this.all(); const next = list.filter(p => p.id !== id);
      if (next.length === list.length) return false;
      writeJSON(PROFILES_FILE, next); return true;
    });
  },
  markRun(id, status) {
    return mutate(PROFILES_FILE, () => {
      const list = this.all(); const item = list.find(p => p.id === id);
      if (!item) return;
      item.lastStatus = status; item.lastRunAt = new Date().toISOString();
      parse(storedProfileSchema, item); writeJSON(PROFILES_FILE, list);
    });
  },
};

export const settings = {
  all() {
    const saved = parse(settingsSchema.partial(), readJSON(SETTINGS_FILE, {}), SETTINGS_FILE);
    return { ...DEFAULT_SETTINGS, ...saved };
  },
  update(input = {}) {
    const patch = parse(settingsSchema.partial(), input, '设置');
    return mutate(SETTINGS_FILE, () => {
      const next = parse(settingsSchema, { ...this.all(), ...patch });
      writeJSON(SETTINGS_FILE, next); return next;
    });
  },
};

export function userDataDir(id) {
  parse(profileIdSchema, id);
  return within(USERDATA_DIR, path.join(USERDATA_DIR, id));
}

export function resolveDownloadDir(profile) {
  if (profile.downloadDir) return path.resolve(profile.downloadDir);
  return path.join(path.resolve(settings.all().defaultDownloadDir), profile.id);
}
