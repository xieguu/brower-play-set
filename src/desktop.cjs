const path = require('node:path');
const { app, BrowserWindow, dialog, screen } = require('electron');

app.setName('Browser Play Set');
app.setPath('userData', path.join(path.resolve(process.env.BPS_DATA_DIR || path.join(__dirname, '..', 'data')), 'desktop-ui'));
let window;
let runtime;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(async () => {
    const { startServer } = await import('./server.js');
    runtime = await startServer({ openBrowser: false });
    const area = screen.getPrimaryDisplay().workAreaSize;
    window = new BrowserWindow({
      width: Math.min(1480, area.width), height: Math.min(940, area.height),
      minWidth: 900, minHeight: 620, show: false, title: 'Browser Play Set',
      backgroundColor: '#f5f7fb', autoHideMenuBar: true,
      titleBarStyle: 'hidden', titleBarOverlay: { color: '#ffffff', symbolColor: '#667089', height: 53 },
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== runtime.origin) event.preventDefault();
    });
    window.webContents.session.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(permission === 'clipboard-sanitized-write' && details.requestingUrl.startsWith(`${runtime.origin}/`));
    });
    window.once('ready-to-show', () => window.show());
    await window.loadURL(`${runtime.origin}/?desktop=1`);
  }).catch(error => {
    const message = error.code === 'EADDRINUSE'
      ? '管理端口已被占用。请先关闭已运行的网页版服务，再启动桌面工作台。'
      : error.message;
    dialog.showErrorBox('Browser Play Set 启动失败', message);
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (!runtime || quitting) return;
    event.preventDefault(); quitting = true;
    runtime.stop().then(() => app.quit()).catch(error => {
      dialog.showErrorBox('关闭服务失败', error.message); app.exit(1);
    });
  });
}
