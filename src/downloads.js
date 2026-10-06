import fs from 'node:fs';
import crypto from 'node:crypto';
import { outputFile } from './paths.js';

/** One download listener for both manual browsing and scripted clicks, including initial tabs. */
export function trackDownloads(context, session, logger) {
  const targets = new Map();
  const saved = new WeakMap();
  const pending = new Set();
  const failures = [];

  function attach(page) {
    page.on('download', download => {
      const target = targets.get(page) || {};
      const promise = (async () => {
        const filename = target.filename || `${crypto.randomUUID().slice(0, 8)}-${download.suggestedFilename()}`;
        const file = outputFile(target.directory || session.downloadDir, filename);
        // Reserve the destination before saving: explicit names never overwrite existing files.
        fs.closeSync(fs.openSync(file, 'wx'));
        try { await download.saveAs(file); }
        catch (error) { fs.rmSync(file, { force: true }); throw error; }
        logger.info(`下载已保存：${file}`);
        session.onDownload?.(file);
        return { file };
      })();
      saved.set(download, promise);
      pending.add(promise);
      promise.then(() => pending.delete(promise), error => {
        pending.delete(promise); failures.push(error);
        logger.error(`下载失败：${error.message}`);
      });
    });
  }
  context.pages().forEach(attach);
  context.on('page', attach);

  return {
    async capture(page, click, target, timeout) {
      if (targets.has(page)) throw new Error('同一标签页已有等待中的下载');
      targets.set(page, target);
      try {
        const [download] = await Promise.all([page.waitForEvent('download', { timeout }), click()]);
        return await saved.get(download);
      } finally { targets.delete(page); }
    },
    async flush() {
      await Promise.allSettled([...pending]);
      if (failures.length) throw new AggregateError(failures.splice(0), '一个或多个下载保存失败');
    },
  };
}
