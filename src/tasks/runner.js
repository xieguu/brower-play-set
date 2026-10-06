import { setTimeout as delay } from 'node:timers/promises';
import { actions } from './actions.js';
import { interpolate } from './template.js';
import { validateTask, stepSchema } from './schema.js';
import { parse } from '../errors.js';
import { createMcpBridge } from '../mcp.js';

export async function runTask({ profile, task, context, logger, args = {}, paths, runId,
  downloads, signal = new AbortController().signal, onProgress = () => {}, onArtifact = () => {}, defaultTimeout = 30000 }) {
  const { source, kind, ...definition } = task;
  validateTask(definition);
  const vars = { ...(task.defaults || {}), ...(args.vars || {}) };
  let page = context.pages()[0] || await context.newPage();
  let last = null;
  let executed = 0;
  let bridgePromise;
  const bridge = () => bridgePromise ||= createMcpBridge(async () => context, paths.screenshotDir, logger);
  const ctx = {
    profile, context, args, vars, signal, log: logger, runId, downloads,
    downloadDir: paths.downloadDir, screenshotDir: paths.screenshotDir, stepIndex: 0,
    get page() { if (!page || page.isClosed()) throw new Error('当前标签页已关闭，请使用 newPage 或 switchPage'); return page; },
    setPage(next) { page = next; },
    checkpoint() { signal.throwIfAborted(); },
    timeout(ms) { return ms ?? defaultTimeout; },
    artifact: onArtifact,
    mcp: {
      async call(...params) { return (await bridge()).call(...params); },
      async tools() { return (await bridge()).tools(); },
    },
  };
  try {
    logger.info(`执行任务：${task.name}`);
    signal.throwIfAborted();
    if (task.run) {
      onProgress({ step: 1, totalSteps: 1, stepLabel: task.name });
      const result = await task.run(ctx, actions);
      signal.throwIfAborted();
      return { ok: true, steps: 1, vars, result };
    }
    for (const [index, raw] of task.steps.entries()) {
      signal.throwIfAborted();
      ctx.stepIndex = index + 1;
      const scope = { url: args.url ?? '', prompt: args.prompt ?? '', profile: { id: profile.id, name: profile.name }, vars, last, index: index + 1, runId };
      // Evaluate conditions first: a skipped branch may legitimately reference unavailable data.
      if (raw.when !== undefined) {
        const condition = interpolate(raw.when, scope);
        if (typeof condition !== 'boolean') throw new Error('when 必须解析为布尔值');
        if (!condition) { logger.debug(`跳过步骤 ${index + 1}`); continue; }
      }
      const step = parse(stepSchema, interpolate(raw, scope), `步骤 ${index + 1}`);
      const label = step.label || step.action;
      onProgress({ step: index + 1, totalSteps: task.steps.length, stepLabel: label });
      const retries = step.retries ?? task.retries ?? 0;
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          last = await actions[step.action](ctx, step);
          signal.throwIfAborted();
          if (step.saveAs) vars[step.saveAs] = last;
          executed++;
          logger.info(`步骤 ${index + 1}/${task.steps.length} 完成：${label}`);
          break;
        } catch (error) {
          if (signal.aborted || attempt >= retries) throw error;
          logger.warn(`步骤 ${index + 1} 失败，按配置重试 ${attempt + 1}/${retries}：${error.message}`);
          await delay(500 * 2 ** attempt, undefined, { signal });
        }
      }
    }
    return { ok: true, steps: executed, vars, result: last };
  } catch (error) {
    const message = signal.aborted ? '任务已取消' : error.message;
    logger[signal.aborted ? 'info' : 'error'](message);
    return { ok: false, cancelled: signal.aborted, steps: executed, vars, error: message };
  } finally {
    if (bridgePromise) await (await bridgePromise).close();
  }
}
