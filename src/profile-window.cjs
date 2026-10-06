const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session, screen } = require('electron');

const config = JSON.parse(process.env.BPS_ELECTRON_PROFILE);
delete process.env.BPS_ELECTRON_PROFILE;
app.setName('Browser Play Set');
app.setPath('userData', config.userDataDir);
// Chromium profiles keep website storage in Default. Keep using that directory.
const storageDir = path.join(config.userDataDir, 'Default');
fs.mkdirSync(storageDir, { recursive: true });
app.setPath('sessionData', storageDir);
app.enableSandbox();

function windowOptions() {
  return {
    width: config.viewport.width, height: config.viewport.height, useContentSize: true,
    show: !config.headless, title: `${config.name} · Browser Play Set`, autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false, session: session.defaultSession },
  };
}

app.on('browser-window-created', (_event, window) => {
  window.removeMenu();
  // Keep the native viewport: Electron handles DPI and window resizing itself.
  const bounds = window.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  window.setBounds({ width, height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
  if (config.userAgent) window.webContents.setUserAgent(config.userAgent);
  window.on('page-title-updated', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: windowOptions() }));
});

function createWindow() {
  const window = new BrowserWindow(windowOptions());
  window.loadURL('about:blank').catch(error => { console.error(error); app.exit(1); });
}

app.on('login', (event, _contents, _details, authInfo, callback) => {
  if (!config.proxy || !authInfo.isProxy) return;
  const proxy = new URL(config.proxy.server);
  const port = Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80));
  if (authInfo.host !== proxy.hostname || authInfo.port !== port) return;
  event.preventDefault();
  callback(config.proxy.username || '', config.proxy.password || '');
});

app.whenReady().then(async () => {
  if (config.userAgent) session.defaultSession.setUserAgent(config.userAgent);
  if (config.proxy) {
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: config.proxy.server,
      proxyBypassRules: config.proxy.bypass || '' });
  }
  app.on('bps-new-window', createWindow);
  createWindow();
}).catch(error => { console.error(error); app.exit(1); });

app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  if (quitting || !app.isReady()) return;
  event.preventDefault();
  quitting = true;
  session.defaultSession.flushStorageData();
  session.defaultSession.cookies.flushStore().then(() => app.quit()).catch(error => {
    console.error(error); app.exit(1);
  });
});
