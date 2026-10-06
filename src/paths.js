import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';

/** Apply Windows filename rules on every platform so task files remain portable. */
export function safeFilename(name) {
  if (typeof name !== 'string' || !name || name.length > 180 ||
      /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new AppError('产物名称必须是有效文件名，不能包含路径或 Windows 保留名称');
  }
  return name;
}

export function within(root, target) {
  const base = path.resolve(root);
  const absolute = path.resolve(target);
  const relative = path.relative(base, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AppError(`路径必须位于指定目录内：${base}`);
  }
  let ancestor = absolute;
  while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.existsSync(base) && fs.existsSync(ancestor)) {
    const rel = path.relative(fs.realpathSync(base), fs.realpathSync(ancestor));
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new AppError('路径通过符号链接或目录联接越界');
    }
  }
  return absolute;
}

export function outputFile(directory, filename) {
  fs.mkdirSync(directory, { recursive: true });
  return within(directory, path.join(directory, safeFilename(filename)));
}
