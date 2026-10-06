import { AppError } from './errors.js';
import { bus } from './logger.js';

const owners = new Map();
export function activity(profileId) { return owners.get(profileId) || null; }
export function activities() { return [...owners].map(([profileId, value]) => ({ profileId, activity: value })); }
export function assertAvailable(profileId) {
  if (owners.has(profileId)) throw new AppError(`Profile 正被${owners.get(profileId).kind === 'mcp' ? ' MCP 客户端' : '任务'}占用，请先停止或断开`, 409);
}

/** Reservations cover queued work as well as running work. */
export function reserve(profileId, owner) {
  assertAvailable(profileId);
  owners.set(profileId, owner); bus.emit('sessions');
  return () => {
    if (owners.get(profileId) === owner) { owners.delete(profileId); bus.emit('sessions'); }
  };
}
