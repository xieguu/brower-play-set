/**
 * 自定义 JS 任务示例。
 *
 * JS 任务导出一个对象，包含 `id/name/description` 与 `run(ctx, actions)`。
 * `ctx` 提供：
 *   - ctx.page      当前 Playwright Page
 *   - ctx.context   BrowserContext（可 newPage / pages）
 *   - ctx.log       带 Profile 上下文的 logger
 *   - ctx.args      { url, prompt, vars }
 *   - ctx.vars      可写变量，供模板使用
 *   - ctx.downloadDir / ctx.screenshotDir
 * 也可以直接调用内置原语：actions.open(ctx, step) 等。
 *
 * 本示例：打开 URL，统计页面中的链接数量并写回变量。
 */
export default {
  id: 'count-links',
  name: '统计页面链接（JS 示例）',
  description: '打开 URL，统计页面上 <a> 链接数量，并截图。演示 JS 任务脚本。',
  args: ['url'],

  async run(ctx, actions) {
    await actions.open(ctx, { url: ctx.args.url });
    const count = await ctx.page.evaluate(() => document.querySelectorAll('a').length);
    ctx.vars.linkCount = count;
    ctx.log.info(`页面共有 ${count} 个链接`);
    await actions.screenshot(ctx, { name: `${ctx.profile.id}-links.png`, fullPage: true });
    return { linkCount: count };
  },
};
