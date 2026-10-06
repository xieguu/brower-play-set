# 任务脚本接口

JSON 文件放入 `tasks/`，从 GUI「任务 → 重新加载」生效。任务 ID 唯一，文件也可包含任务数组。JS 文件使用 ESM 默认导出。无效文件会报告文件名和错误，不会被静默忽略。

## 模板和控制字段

| 字段 | 行为 |
| --- | --- |
| `label` | 日志中显示的步骤名称 |
| `timeout` | 当前操作超时，默认 30000 毫秒 |
| `saveAs` | 把该步骤结果保存在 `vars` 下 |
| `when` | 布尔值或解析成布尔值的模板，`false` 时跳过 |
| `retries` | 显式重试次数，0–5，默认 0；任务级同名字段可设置统一次数 |
| `name` | 截图／下载的文件名 |

可引用 `{{url}}`、`{{prompt}}`、`{{profile.id}}`、`{{profile.name}}`、`{{vars.KEY}}`、`{{last.FIELD}}`、`{{index}}`、`{{runId}}`。单个模板占满一个字段时保留原始 JSON 类型，例如 `"files":"{{vars.files}}"` 可得到数组。缺失变量会使任务失败。

`defaults` 定义任务变量，运行时 `vars` 覆盖它。`when` 先于该步骤其他字段求值，所以跳过的步骤可以引用尚未生成的变量。不支持 `continueOnError`。

## 定位元素

`selector` 可以是 Playwright 选择器字符串，也可以是以下对象之一：

```json
{ "role": "button", "name": "提交", "exact": true }
{ "label": "用户名" }
{ "placeholder": "输入关键词" }
{ "testId": "submit-button" }
{ "text": "操作成功" }
{ "css": ".result", "nth": 1 }
{ "frame": "iframe#editor", "role": "textbox", "name": "内容" }
```

同一对象只能选择一种定位方式。默认精确匹配可访问性名称；多个匹配会报错，需要任务明确指定 `nth`（从 0 开始）。

## 操作字段

| action | 主要字段 / 结果 |
| --- | --- |
| `open` | `url`，可选 `waitUntil`；返回 `url/title/status` |
| `read` | 可选 `selector`、`html`、`maxLength`；返回文本、HTML 或页面标题与地址 |
| `locate` | `selector`，可选 `state`；等待匹配元素状态 |
| `type` | `selector/text`，可选 `submit:"Enter"`、`delay`；先清空再输入 |
| `click` | `selector`，可选 `force` |
| `press` | `key`，可选 `selector`；没有定位器时发送到页面键盘 |
| `wait` | 选择一种：`ms`、`selector`、`text`、`url`，或只设置页面加载 `state` |
| `screenshot` | 可选 `name/dir/fullPage`；返回 `file` |
| `upload` | `selector` 与 `file` 或 `files`，使用本机文件路径 |
| `download` | `selector`，可选 `name/dir`；点击触发下载并持久保存，返回 `file` |
| `evaluate` | `script` 或 `expression`，JS 表达式或函数表达式；返回 `{result: 原始结果}` |
| `newPage` | 可选 `url`，同时切换到新页面 |
| `switchPage` | `index`，从 0 开始，超出范围会报错 |
| `closePage` | 关闭当前页面，剩余页面中选择最后一个 |
| `log` | `message` |
| `mcp` | 官方 `tool` 名称与 `arguments`；失败响应会使步骤失败 |

`wait` 的元素状态支持 `attached/detached/visible/hidden`；加载状态支持 `domcontentloaded/load/networkidle`。优先等待实际结果元素或 URL，避免固定延时。按下提交按钮后页面加载完成并不等于异步结果已出现。

文件操作示例：

```json
{
  "id": "file-flow",
  "name": "上传并下载结果",
  "steps": [
    { "action": "open", "url": "{{url}}" },
    { "action": "upload", "selector": "input[type=file]", "files": "{{vars.files}}" },
    { "action": "click", "selector": { "role": "button", "name": "生成" } },
    { "action": "wait", "selector": "a#download" },
    { "action": "download", "selector": "a#download", "name": "result.zip" }
  ]
}
```

运行变量填写 `{"files":["C:/Users/you/Documents/input.pdf"]}`。Windows 路径可使用 `/`；若使用反斜杠，JSON 中写成 `\\`。已存在的显式下载文件名不会被覆盖。

页面脚本示例：`{"action":"evaluate","script":"() => ({title: document.title, links: document.links.length})","saveAs":"stats"}`。脚本运行在网页上下文，JS 插件则运行在本机 Node.js 中。

## JS 插件

```js
export default {
  id: 'custom-workflow',
  name: '自定义流程',
  async run(ctx, actions) {
    await actions.open(ctx, { url: ctx.args.url });
    await actions.type(ctx, {
      selector: { role: 'textbox', name: 'Message' },
      text: ctx.args.prompt,
    });
    ctx.checkpoint();
    const links = await ctx.page.locator('a').count();
    const snapshot = await ctx.mcp.call('browser_snapshot', {}, ctx.signal);
    await actions.screenshot(ctx, { name: 'result.png' });
    return { links, snapshot };
  },
};
```

`ctx` 提供 `profile`、`context`、当前 `page`、`setPage(page)`、`args`、`vars`、`log`、`runId`、`downloadDir`、`screenshotDir`、`signal`、`checkpoint()` 和 `mcp`。`ctx.mcp.tools()` 可获取官方工具及输入 schema；`ctx.mcp.call(name, arguments, signal)` 调用工具。产物可通过 `ctx.artifact(absolutePath, type)` 登记到 GUI。

任务取消会设置 `ctx.signal` 并关闭当前浏览器。自定义长循环和自建网络请求需要检查 `ctx.signal`；例如 Node.js 的 `fetch(url, {signal: ctx.signal})`。每个浏览器操作前后使用 `ctx.checkpoint()` 可以立即响应取消。

任务 ID、上下文、代理和运行产物由核心统一管理。插件只描述网站流程，不应自行启动第二个浏览器或更换 User Data 目录。

重新加载会按 JS 文件内容更新模块缓存，下一次运行使用新定义；已开始的任务继续使用提交时的定义。

## 文件与错误

`result.json` 保存执行结果、`vars`、已完成步骤数和错误信息。`run.json` 保存状态、进度及产物清单，程序重启后可查看最近 200 条记录。运行中意外中断的记录显示为失败。

JSON / JS 任务使用相同的生命周期和日志。一次失败只结束自己的任务，其他 Profile 继续执行。同一 Profile 的任务和外部 MCP 连接互斥。
