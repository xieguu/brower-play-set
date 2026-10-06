import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { outputFile } from '../paths.js';
import { AppError, parse } from '../errors.js';
import { urlSchema } from '../store.js';

/** Strict locators: multiple matches fail unless the task explicitly supplies nth. */
export function locator(page, selector) {
  if (!selector) throw new AppError('操作需要 selector');
  if (typeof selector === 'string') return page.locator(selector);
  const root = selector.frame ? page.frameLocator(selector.frame) : page;
  const exact = selector.exact ?? true;
  let element;
  if (selector.css !== undefined) element = root.locator(selector.css);
  else if (selector.role !== undefined) element = root.getByRole(selector.role, { name: selector.name, exact });
  else if (selector.text !== undefined) element = root.getByText(selector.text, { exact });
  else if (selector.label !== undefined) element = root.getByLabel(selector.label, { exact });
  else if (selector.placeholder !== undefined) element = root.getByPlaceholder(selector.placeholder, { exact });
  else if (selector.testId !== undefined) element = root.getByTestId(selector.testId);
  else throw new AppError('无效的定位器');
  return selector.nth === undefined ? element : element.nth(selector.nth);
}

const truncate = (value, length = 20000) => String(value).slice(0, length);

export const actions = {
  async open(ctx, step) {
    const url = step.url ?? ctx.args.url;
    if (!url) throw new AppError('open 需要 URL，请设置 Profile 网址或任务 url');
    parse(urlSchema, url, 'URL');
    const response = await ctx.page.goto(url, { waitUntil: step.waitUntil || 'domcontentloaded', timeout: ctx.timeout(step.timeout) });
    return { url: ctx.page.url(), title: await ctx.page.title(), status: response?.status() ?? null };
  },
  async read(ctx, step) {
    if (step.selector) return { text: truncate(await locator(ctx.page, step.selector).innerText({ timeout: ctx.timeout(step.timeout) }), step.maxLength), selector: step.selector };
    if (step.html) return { html: truncate(await ctx.page.content(), step.maxLength ?? 200000) };
    return {
      url: ctx.page.url(), title: await ctx.page.title(),
      text: truncate(await ctx.page.locator('body').innerText({ timeout: ctx.timeout(step.timeout) }), step.maxLength),
    };
  },
  async locate(ctx, step) {
    const element = locator(ctx.page, step.selector);
    const state = step.state || 'visible';
    await element.waitFor({ state, timeout: ctx.timeout(step.timeout) });
    return { selector: step.selector, state, count: await element.count() };
  },
  async type(ctx, step) {
    const element = locator(ctx.page, step.selector);
    const options = { timeout: ctx.timeout(step.timeout) };
    await element.fill(step.delay ? '' : step.text, options);
    if (step.delay) await element.pressSequentially(step.text, { ...options, delay: step.delay });
    if (step.submit) await element.press(step.submit, options);
    return { selector: step.selector, characters: step.text.length };
  },
  async click(ctx, step) {
    await locator(ctx.page, step.selector).click({ timeout: ctx.timeout(step.timeout), force: step.force ?? false });
    return { selector: step.selector };
  },
  async press(ctx, step) {
    if (step.selector) await locator(ctx.page, step.selector).press(step.key, { timeout: ctx.timeout(step.timeout) });
    else await ctx.page.keyboard.press(step.key);
    return { key: step.key };
  },
  async wait(ctx, step) {
    const timeout = ctx.timeout(step.timeout);
    if (step.ms !== undefined) { await delay(step.ms, undefined, { signal: ctx.signal }); return { waitedMs: step.ms }; }
    if (step.selector !== undefined) {
      await locator(ctx.page, step.selector).waitFor({ state: step.state || 'visible', timeout });
      return { selector: step.selector };
    }
    if (step.text !== undefined) {
      if (!step.text) throw new AppError('等待文本不能为空');
      await ctx.page.getByText(step.text, { exact: step.exact ?? true }).waitFor({ state: step.state || 'visible', timeout });
      return { text: step.text };
    }
    if (step.url !== undefined) { await ctx.page.waitForURL(step.url, { timeout }); return { url: ctx.page.url() }; }
    await ctx.page.waitForLoadState(step.state || 'domcontentloaded', { timeout });
    return { state: step.state || 'domcontentloaded' };
  },
  async screenshot(ctx, step) {
    const file = outputFile(step.dir || ctx.screenshotDir, step.name || `step-${ctx.stepIndex}.png`);
    if (fs.existsSync(file)) throw new AppError(`截图文件已存在：${file}`);
    await ctx.page.screenshot({ path: file, type: 'png', fullPage: step.fullPage ?? true, timeout: ctx.timeout(step.timeout) });
    ctx.artifact(file, 'screenshot');
    return { file };
  },
  async upload(ctx, step) {
    const files = step.files || [step.file];
    if (!files.length || files.some(file => typeof file !== 'string' || !fs.statSync(file).isFile())) throw new AppError('上传需要有效文件路径');
    await locator(ctx.page, step.selector).setInputFiles(files, { timeout: ctx.timeout(step.timeout) });
    return { files };
  },
  async download(ctx, step) {
    const timeout = ctx.timeout(step.timeout);
    return ctx.downloads.capture(ctx.page, () => locator(ctx.page, step.selector).click({ timeout }),
      { directory: step.dir || ctx.downloadDir, filename: step.name }, timeout);
  },
  async evaluate(ctx, step) {
    const result = await ctx.page.evaluate(source => {
      const value = (0, eval)(`(${source})`);
      return typeof value === 'function' ? value() : value;
    }, step.script || step.expression);
    return { result };
  },
  async newPage(ctx, step) {
    const page = await ctx.context.newPage(); ctx.setPage(page);
    if (step.url) await actions.open(ctx, step);
    return { url: page.url(), index: ctx.context.pages().indexOf(page) };
  },
  async switchPage(ctx, step) {
    const page = ctx.context.pages()[step.index];
    if (!page) throw new AppError(`标签页序号不存在：${step.index}`);
    ctx.setPage(page); await page.bringToFront();
    return { index: step.index, url: page.url() };
  },
  async closePage(ctx) {
    await ctx.page.close(); ctx.setPage(ctx.context.pages().at(-1) || null);
    return { remaining: ctx.context.pages().length };
  },
  async log(ctx, step) { ctx.log.info(step.message); return { message: step.message }; },
  async mcp(ctx, step) {
    const result = await ctx.mcp.call(step.tool, step.arguments || {}, ctx.signal, ctx.timeout(step.timeout));
    const pages = ctx.context.pages();
    if (pages.length === 1) ctx.setPage(pages[0]);
    if (step.tool === 'browser_tabs') {
      if (step.arguments?.action === 'new') ctx.setPage(pages.at(-1));
      if (step.arguments?.action === 'select') ctx.setPage(pages[step.arguments.index]);
      if (step.arguments?.action === 'close') ctx.setPage(pages.at(-1) || null);
    }
    return result;
  },
};

export const ACTION_NAMES = Object.keys(actions);
export const hasAction = name => Object.hasOwn(actions, name);
