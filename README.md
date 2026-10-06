# Browser Play Set

轻量、开源、Windows 优先的多 Profile 浏览器自动化工具。使用本地 Web GUI 管理独立 Chromium 登录环境，通过 **Playwright + 官方 Playwright MCP** 执行通用任务。采用 MIT 许可证。

Profile 管理思路参考 [gpt-set](https://github.com/xieguu/gpt-set)。网站地址由用户填写，不绑定 ChatGPT 或任何其他站点。

![运行控制台](docs/images/console.png)

## 启动

需要 **Node.js 22 或更新版本**。Windows 10/11 首次双击 `setup.cmd` 安装依赖和 Chromium，以后双击 `start.cmd`。

也可以从源码目录运行：

```powershell
npm ci
npm run browsers
npm start
```

GUI：**http://127.0.0.1:8787**。启动时自动打开管理界面；在设置中可关闭此行为。按 `Ctrl+C` 退出，运行中的任务和浏览器会关闭。

无需 Electron、数据库、Docker、云端账号或前端构建。Playwright 与 MCP 固定在兼容版本，并共用一份 Chromium；`npm run browsers` 使用 `--no-shell`，有头和无头模式均运行完整 Chromium。

## 使用

1. **创建 Profile**：填写名称、任意网站 URL、默认任务、提示词和代理。每个 Profile 都有自己的 User Data 目录。
2. **手动登录**：点击卡片上的「打开」。登录后关闭窗口，Cookie、LocalStorage、IndexedDB、HTTP 缓存、CacheStorage 等保存在该 Profile 内。
3. **独立运行**：勾选多个 Profile，在运行页设置并发数。默认使用各 Profile 自己的任务、网址和提示词；可为本批次指定覆盖值。
4. **查看结果**：运行页显示排队、当前步骤、成功、失败和取消状态。「详情 / 产物」可查看结果 JSON、下载截图与文件。日志可按 Profile 和级别过滤。
5. **管理任务**：从「任务」页新建、导入、编辑 JSON；JS 插件放入 `tasks/` 后点击「重新加载」。

提示词是传给任务的 `{{prompt}}` 参数。JSON 步骤决定如何使用它；MCP 可供外部 AI 客户端调用。本项目不内置模型调用。

并发数量限制整个进程内正在执行的任务，多个批次共享上限。排队中的 Profile 也被预留，重复提交返回明确错误。任务结束默认关闭浏览器；选择「结束后保持打开」后，需要手动关闭窗口释放浏览器资源。

「复制 Profile」只复制配置，生成新的空白 User Data，不复制登录状态。修改正在打开的 Profile 配置，需要先关闭该浏览器。

### 代理

每个 Profile 可分别设置 HTTP、HTTPS、SOCKS4 或 SOCKS5 服务器，以及绕过列表。HTTP/HTTPS 支持用户名、密码，也支持 `http://USER:PASSWORD@HOST:PORT` 格式；密码中的空白会被保留。Chromium 不支持 SOCKS 用户名／密码认证，此类配置会直接报错。

## JSON 任务

在 GUI 新建任务，或保存为 `tasks/my-task.json`：

```json
{
  "id": "my-task",
  "name": "填写表单并读取结果",
  "defaults": {
    "input": { "role": "textbox", "name": "Message" },
    "submit": { "role": "button", "name": "Send" },
    "result": "#result"
  },
  "steps": [
    { "action": "open", "url": "{{url}}" },
    { "action": "type", "selector": "{{vars.input}}", "text": "{{prompt}}" },
    { "action": "click", "selector": "{{vars.submit}}" },
    { "action": "wait", "selector": "{{vars.result}}" },
    { "action": "read", "selector": "{{vars.result}}", "saveAs": "result" },
    { "action": "screenshot", "name": "result.png", "fullPage": true }
  ]
}
```

把 `defaults` 中的定位器改为目标网站实际元素即可，浏览器核心无需修改。运行页的「任务变量（JSON）」可覆盖 `defaults`。

支持操作：`open`、`read`、`locate`、`type`、`click`、`press`、`wait`、`screenshot`、`upload`、`download`、`evaluate`、`newPage`、`switchPage`、`closePage`、`log`、`mcp`。

详细字段、文件操作和 JS 插件接口见 [任务指南](docs/tasks.md)。

## Playwright MCP

### 外部客户端

打开某个 Profile 卡片的「⋯ → 连接 Playwright MCP」，复制该 Profile 的配置：

```json
{
  "mcpServers": {
    "my-profile": {
      "url": "http://127.0.0.1:8787/mcp/PROFILE_ID"
    }
  }
}
```

使用支持 **Streamable HTTP** 的 MCP 客户端。管理程序保持运行，客户端即可调用官方的 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_file_upload` 等工具。

每条 MCP 连接绑定一个 Profile，共用该 Profile 的持久上下文和代理。连接期间阻止同一 Profile 启动其他任务。客户端终止 MCP 会话后关闭浏览器并释放占用；客户端意外退出时，可在 MCP 面板点击「断开此 Profile 的 MCP」。多个 Profile 的 MCP 可同时连接。

### JSON / JS 内调用 MCP

内置 `mcp-snapshot` 任务可直接体验官方 MCP。自定义步骤：

```json
{
  "id": "read-with-mcp",
  "name": "MCP 页面快照",
  "steps": [
    { "action": "mcp", "tool": "browser_navigate", "arguments": { "url": "{{url}}" } },
    { "action": "mcp", "tool": "browser_snapshot", "saveAs": "snapshot" }
  ]
}
```

通过官方 `createConnection(config, contextGetter)` 接入已有上下文，使用 MCP SDK 传输和工具协议；没有额外 CDP 端口、MCP 浏览器进程或自行仿造的 MCP 工具。

## 数据与架构

```text
src/
  store.js             Profile / 设置校验、原子写入、配置文件锁
  browser.js           独立持久上下文、跨进程 User Data 锁
  downloads.js         手动与自动下载统一保存
  activity.js          Profile 占用管理
  orchestrator.js      p-queue 全局调度、取消、进度、运行记录
  tasks/               任务加载、Zod 校验、模板、通用操作、执行器
  mcp.js               官方 Playwright MCP 接入
  mcp-http.js          按 Profile 提供 Streamable HTTP
  server.js / cli.js   本地 GUI 接口与命令行
public/                原生 HTML / CSS / JavaScript，零构建
tasks/                 用户 JSON / JS 插件
data/
  profiles.json        Profile 配置
  settings.json        全局设置
  userdata/<id>/       独立 Chromium User Data
  downloads/<id>/      默认下载位置；任务下载位于各自 run-id 子目录
  artifacts/<id>/      每次任务的 run.json、result.json、截图及 MCP 产物
  logs/                按 UTC 日期保存的 JSONL 日志
```

自定义下载目录下同样按运行 ID 建立子目录，避免并发覆盖。下载会执行 `saveAs` 持久保存，任务关闭浏览器后文件仍在。截图文件名不允许目录穿越或 Windows 保留名称。

配置损坏、无效任务、重复 ID、缺失模板变量和执行错误都会明确显示，不回退为空配置或跳过失败步骤。重试只按任务显式配置执行。

## 命令行

```powershell
node src/cli.js list
node src/cli.js add --name A --url https://example.com --task open-page
node src/cli.js run --all --concurrency 3
node src/cli.js run --profile PROFILE_ID --task mcp-snapshot --headless
node src/cli.js mcp-config --profile PROFILE_ID
node src/cli.js remove PROFILE_ID --purge
```

`run` 中未提供的任务、网址、提示词和无头设置均沿用各 Profile 配置。`--keep-open` 保持浏览器打开；`--fresh` 关闭已有上下文再启动。失败或取消的批次返回非零退出码。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BPS_DATA_DIR` | `<项目>/data` | Profile、登录数据、下载与日志根目录 |
| `BPS_TASKS_DIR` | `<项目>/tasks` | 自定义任务目录 |
| `PORT` | `8787` | 管理界面与 MCP 端口 |
| `HOST` | `127.0.0.1` | 管理程序回环监听地址 |
| `BPS_NO_OPEN` | 未设置 | 设为 `1` 时不自动打开管理界面 |

管理接口仅监听本机并校验 Host / Origin；网站访问由 Profile 的 URL 和代理配置决定。

## 验证

```powershell
npm run check             # 所有 JS 文件语法检查
npm test                  # 配置、模板、任务文件和路径检查
npm run test:integration  # 真实 Chromium、代理、MCP HTTP、GUI 全流程
npm run smoke             # 浏览器核心集成检查
```

集成测试使用本机测试网页和临时 User Data，不需要第三方账号。覆盖存储与缓存隔离、重启持久化、代理认证、跨进程锁、全局并发、取消、文件上传下载、MCP 与 GUI。GUI 检查截图保存在 `test-results/`。

依赖：[Playwright](https://github.com/microsoft/playwright)、[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)、Express、p-queue、Zod、proper-lockfile、write-file-atomic、open。依赖许可证保留在各包中；项目许可证见 [LICENSE](LICENSE)。
