# Browser Play Set

`ubt` 分支：Ubuntu 最小服务器版。一个 Node.js Web 服务 + 无头 Chromium，通过 **服务器 IP:8787** 管理独立 Profile，使用 **Playwright + 官方 Playwright MCP** 执行任务。采用 MIT 许可证。桌面版保留在 `electron` 分支。

Profile 管理思路参考 [gpt-set](https://github.com/xieguu/gpt-set)。网站地址由用户填写，不绑定 ChatGPT 或任何其他站点。

![运行控制台](docs/images/console.png)

## 启动

在已安装 **Node.js 22+、npm、Git** 的 Ubuntu 22.04/24.04 上运行：

```bash
git clone -b ubt --single-branch https://github.com/xieguu/brower-play-set.git
cd brower-play-set
bash setup.sh
nano .env                   # 填写 BPS_ADMIN_PASSWORD
bash start.sh
```

打开 **http://服务器IP:8787**，输入 `.env` 中的用户名和密码。默认用户名 `admin`，密码必须自行填写。服务器防火墙/云安全组需放行 TCP 8787。`setup.sh` 使用 [Playwright 官方安装方式](https://playwright.dev/docs/browsers#install-system-dependencies)安装 Chromium 及系统依赖，安装系统包时可能需要 sudo。

部署只有 Node 服务和 Chromium，无需桌面环境、Electron、Xvfb、noVNC、Docker、数据库或前端构建。关闭网页不停止服务；终端按 `Ctrl+C` 会停止任务和实例。需要脱离终端运行时：

```bash
mkdir -p data
nohup bash start.sh >data/server.log 2>&1 &
echo $! >data/server.pid
# 停止：kill "$(cat data/server.pid)"
```

所有实例强制使用无头模式，兼容导入的 `headless` 字段不改变服务器运行模式。每个 Profile 使用自己的 `data/userdata/<id>/`；`viewport` 控制页面渲染及截图大小。网页提供预览截图，网站交互通过任务或 MCP 完成。备份 `data/`、`tasks/` 和 `.env` 即可保留配置、登录状态和任务；Electron User Data 不自动迁移。

`bash start.sh` 加载 `.env`。开发时直接 `npm start` 使用当前进程环境变量，默认仅监听 `127.0.0.1:8787`。

## 云服务器完整部署（Windows 通过 SSH 访问）

以下步骤适用于 Ubuntu 云服务器。第 1–4 步在已经通过 SSH 登录的服务器 `root@...:~#` 终端中执行；第 5 步在 Windows 新开的 CMD 窗口中执行。此方式让服务监听服务器本机，通过 SSH 转发访问，不需要对外放行 TCP 8787。

### 1. 安装 Node.js 22 和 Git

```bash
apt-get update
apt-get install -y ca-certificates curl git
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt-get install -y nodejs
node -v
```

### 2. 下载 ubt 分支并安装依赖

```bash
cd /opt
git clone -b ubt --single-branch https://github.com/xieguu/brower-play-set.git
cd brower-play-set
bash setup.sh
```

### 3. 设置管理账号密码

复制整段执行，按提示输入非空的字母和数字组合密码。此步骤写入 `.env`，设置用户名为 `admin`，监听地址为 `127.0.0.1:8787`。

```bash
read -rsp '设置管理密码: ' BPS_PASSWORD
echo
if [[ "$BPS_PASSWORD" =~ ^[A-Za-z0-9]+$ ]]; then
  (umask 077; printf 'HOST=127.0.0.1\nPORT=8787\nBPS_ADMIN_USER=admin\nBPS_ADMIN_PASSWORD="%s"\n' "$BPS_PASSWORD" > .env)
  chmod 600 .env
else
  echo '密码必须为非空的字母和数字组合，请重新执行本步骤。'
fi
unset BPS_PASSWORD
```

### 4. 后台启动

```bash
mkdir -p data
nohup bash start.sh >data/server.log 2>&1 &
echo $! >data/server.pid
sleep 2
cat data/server.log
```

日志出现 `http://127.0.0.1:8787` 且没有启动错误后，即可连接。退出 SSH 后程序仍会运行；此启动方式不配置服务器重启后的自动启动。查看日志和停止服务：

```bash
cd /opt/brower-play-set
tail -n 100 data/server.log
kill "$(cat data/server.pid)"
```

### 5. Windows 上打开管理页面

在 Windows **另开一个 CMD 窗口**，将 `SERVER_IP` 替换为云服务器公网 IP，然后执行：

```cmd
ssh -N -L 8787:127.0.0.1:8787 -o ExitOnForwardFailure=yes -o ServerAliveInterval=60 root@SERVER_IP
```

保持这个窗口打开，本机浏览器访问 **http://127.0.0.1:8787**。用户名为 `admin`，密码为第 3 步设置的密码。SSH 断开后重新执行该转发命令即可恢复访问。

进入「环境设置」，先把任务并发数设为 **1** 并保存，再创建实例运行任务。`ssh -D 1080` 提供 SOCKS 代理；这里的 `-L 8787:127.0.0.1:8787` 才是管理页面的端口转发。

## 使用

1. **创建 Profile**：填写名称、任意网站 URL、默认任务、提示词和代理。每个 Profile 都有自己的 User Data 目录。
2. **后台打开**：点击卡片上的「打开」，通过任务或 MCP 操作网站。Cookie、LocalStorage、IndexedDB、HTTP 缓存、CacheStorage 等保存在该 Profile 内。
3. **独立运行**：勾选多个 Profile，在运行页设置并发数。默认使用各 Profile 自己的任务、网址和提示词；可为本批次指定覆盖值。
4. **查看结果**：运行页显示排队、当前步骤、成功、失败和取消状态。「详情 / 产物」可查看结果 JSON、下载截图与文件。日志可按 Profile 和级别过滤。
5. **管理任务**：从「任务」页新建、导入、编辑 JSON；JS 插件放入 `tasks/` 后点击「重新加载」。

提示词是传给任务的 `{{prompt}}` 参数。JSON 步骤决定如何使用它；MCP 可供外部 AI 客户端调用。本项目不内置模型调用。

并发数量限制整个进程内正在执行的任务，多个批次共享上限。排队中的 Profile 也被预留，重复提交返回明确错误。任务结束默认关闭浏览器；选择「结束后保持打开」后，点击实例「关闭」释放资源。

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
      "url": "http://SERVER_IP:8787/mcp/PROFILE_ID",
      "headers": { "Authorization": "Basic BASE64_USERNAME_PASSWORD" }
    }
  }
}
```

将 `BASE64_USERNAME_PASSWORD` 替换为 `.env` 中 `用户名:密码` 的 Base64 编码；在服务器项目目录运行 `node --env-file=.env -e 'console.log(Buffer.from(process.env.BPS_ADMIN_USER+":"+process.env.BPS_ADMIN_PASSWORD).toString("base64"))'` 获取。配置中的地址由访问工作台的地址生成。使用支持 **Streamable HTTP** 和自定义请求头的 MCP 客户端，即可调用官方 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_file_upload` 等工具。

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

通过官方 `createConnection(config, contextGetter)` 接入已有 Chromium 上下文，使用 MCP SDK 传输和工具协议。新页面与网站弹窗共享所属实例会话。

## 数据与架构

```text
src/
  store.js             Profile / 设置校验、原子写入、配置文件锁
  browser.js           无头 Chromium、持久化上下文、跨进程 User Data 锁
  server-access.js     HTTP Basic 登录、Host / Origin 检查
  downloads.js         手动与自动下载统一保存
  activity.js          Profile 占用管理
  orchestrator.js      p-queue 全局调度、取消、进度、运行记录
  tasks/               任务加载、Zod 校验、模板、通用操作、执行器
  mcp.js               官方 Playwright MCP 接入
  mcp-http.js          按 Profile 提供 Streamable HTTP
  server.js / cli.js   Web GUI 接口与命令行
public/                原生 HTML / CSS / JavaScript，零构建
tasks/                 用户 JSON / JS 插件
data/
  profiles.json        Profile 配置
  settings.json        全局设置
  userdata/<id>/       独立 Chromium User Data，Default/ 保存网站数据
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

`run` 中未提供的任务、网址和提示词沿用各 Profile 配置。所有实例均无头运行；`--keep-open` 保持实例运行，`--fresh` 关闭已有实例再启动。失败或取消的批次返回非零退出码。CLI 加载部署配置时使用 `node --env-file=.env src/cli.js ...`。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `BPS_DATA_DIR` | `<项目>/data` | Profile、登录数据、下载与日志根目录 |
| `BPS_TASKS_DIR` | `<项目>/tasks` | 自定义任务目录 |
| `PORT` | `8787` | 管理界面与 MCP 端口 |
| `HOST` | `127.0.0.1` | `.env.example` 设置为 `0.0.0.0`，供远程访问 |
| `BPS_ADMIN_USER` | 未设置 | 管理员用户名，对外监听时必填 |
| `BPS_ADMIN_PASSWORD` | 未设置 | 管理员密码，对外监听时必填 |
| `BPS_PUBLIC_URL` | 未设置 | 可选的外部根地址，如 `https://bps.example.com` |

登录覆盖管理页、API、预览、事件流、下载与 MCP。使用 HTTPS 反向代理时设置 `BPS_PUBLIC_URL`，代理保留原始 Host，并关闭 SSE 响应缓冲。网站访问由各 Profile 的 URL 和代理配置决定。

## 验证

```powershell
npm run check             # 所有 JS 文件语法检查
npm test                  # 配置、模板、任务文件和路径检查
npm run browsers          # 安装 Chromium
npm run test:integration  # 无头实例、代理、MCP HTTP、Web GUI 全流程
npm run smoke             # 浏览器核心集成检查
```

集成测试使用本机测试网页和临时 User Data，不需要第三方账号。覆盖存储与缓存隔离、重启持久化、代理认证、跨进程锁、全局并发、取消、文件上传下载、MCP 与 GUI。GUI 检查截图保存在 `test-results/`。

CI 在 Ubuntu 和 Windows 上直接运行无头集成测试，Ubuntu 不需要显示服务。

依赖：[Playwright](https://github.com/microsoft/playwright)、[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)、Express、basic-auth、p-queue、Zod、proper-lockfile、write-file-atomic。依赖许可证保留在各包中；项目许可证见 [LICENSE](LICENSE)。
