import { AppError } from './errors.js';
import { bus } from './logger.js';

const owners = new Map();
export function activity(profileId) { return owners.get(profileId) || null; }
export function activities() { return [...owners].map(([profileId, value]) => ({ profileId, activity: value })); }
export function assertAvailable(profileId) {
  if (owners.has(profileId)) {
    const labels = { mcp: 'MCP 客户端', task: '任务', remote: '网页远程操作' };
    throw new AppError(`Profile 正被${labels[owners.get(profileId).kind]}占用，请先停止或断开`, 409);
  }
}

/** Reservations cover queued work as well as running work. */
export function reserve(profileId, owner) {
  assertAvailable(profileId);
  owners.set(profileId, owner); bus.emit('sessions');
  return () => {
    if (owners.get(profileId) === owner) { owners.delete(profileId); bus.emit('sessions'); }
  };
}
