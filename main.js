import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { activateWindow, registerSingleInstance } from './lib/app-lifecycle.js';
import { DshHost, DshHostError } from './lib/dsh-host.js';
import { installNavigationGuards } from './lib/navigation-policy.js';

const DSH_VERSION = '0.1.0-rc.6';
const SETTINGS_FILE = 'settings.json';
const DEFAULT_WORKSPACE_NAME = 'DSH Workspace';

let mainWindow = null;
let tray = null;
let allowedOrigin = null;
let settings = {};
let startupPromise = null;
let failurePromise = null;
let shutdownPromise = null;
let bootstrapPromise = null;
let activationPromise = null;
let quitting = false;

function supportedNodeRuntime(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 19);
}

function dshEntryPath() {
  const relative = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (app.isPackaged) return path.join(process.resourcesPath, 'dsh-runtime', relative);
  return path.join(app.getAppPath(), relative);
}

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

async function readSettings() {
  try {
    const value = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function writeSettings() {
  const target = settingsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

async function defaultWorkspace() {
  const target = path.join(app.getPath('documents'), DEFAULT_WORKSPACE_NAME);
  await fs.mkdir(target, { recursive: true });
  return target;
}

async function resolveWorkspace() {
  const configured = typeof settings.workspace === 'string' && path.isAbsolute(settings.workspace)
    ? path.normalize(settings.workspace)
    : null;
  if (configured) {
    try {
      const stat = await fs.stat(configured);
      if (stat.isDirectory()) return configured;
    } catch {
      // The previously selected directory may have been moved or deleted.
    }
  }
  const target = await defaultWorkspace();
  settings.workspace = target;
  await writeSettings();
  return target;
}

function appIcon() {
  const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'favicon.png'));
  return icon.isEmpty() ? nativeImage.createEmpty() : icon;
}

function updateTrayMenu() {
  if (!tray) return;
  const workspace = settings.workspace || '未选择';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DSH', click: showMainWindow },
    { label: '隐藏窗口', click: () => { if (mainWindow) mainWindow.hide(); } },
    { type: 'separator' },
    { label: `工作区：${path.basename(workspace)}`, enabled: false },
    { label: '选择工作区…', click: () => { void chooseWorkspace(); } },
    { label: '重启 DSH 服务', click: () => { void restartHost(); } },
    { type: 'separator' },
    { label: '退出', click: () => { void requestQuit(); } },
  ]));
}

function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip('DSH Desktop');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  updateTrayMenu();
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1117',
    icon: appIcon(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  installNavigationGuards(window, () => allowedOrigin);
  window.webContents.on('did-finish-load', () => {
    activateWindow(window);
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame && !quitting && startupPromise === null && errorCode !== -3) {
      void handleRuntimeFailure(new Error(`DSH 页面加载失败（${errorCode}）：${errorDescription} ${validatedURL}`));
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting) void handleRuntimeFailure(new Error(`DSH 渲染进程已退出：${details.reason}`));
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  mainWindow = window;
  return window;
}

const host = new DshHost({
  entryPath: dshEntryPath(),
  logger: (stream, text) => {
    if (process.env.DSH_DESKTOP_DEBUG === '1') process.stderr.write(`[dsh:${stream}] ${text}`);
  },
});

host.on('exit', ({ intentional, code, signal }) => {
  if (!intentional && !quitting) {
    void handleRuntimeFailure(new Error(`DSH 服务意外退出（code=${code ?? 'null'}, signal=${signal ?? 'none'}）。`));
  }
});

host.on('child-error', (error) => {
  if (!quitting) void handleRuntimeFailure(error);
});

async function startHostAndLoad({ forceRestart = false } = {}) {
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    const workspace = await resolveWorkspace();
    if (forceRestart) await host.stop();
    const url = await host.start(workspace);
    allowedOrigin = new URL(url).origin;
    const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
    await window.loadURL(url);
    activateWindow(window);
  })();
  try {
    await startupPromise;
  } catch (error) {
    await host.stop();
    throw error;
  } finally {
    startupPromise = null;
  }
}

async function chooseWorkspace() {
  if (quitting) return;
  const options = {
    title: '选择 DSH 工作区',
    buttonLabel: '使用此文件夹',
    properties: ['openDirectory', 'createDirectory'],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || !result.filePaths[0]) return;
  settings.workspace = path.resolve(result.filePaths[0]);
  await writeSettings();
  updateTrayMenu();
  try {
    await startHostAndLoad({ forceRestart: true });
  } catch (error) {
    await showStartupError(error);
  }
}

async function restartHost() {
  if (quitting) return;
  try {
    await startHostAndLoad({ forceRestart: true });
  } catch (error) {
    await showStartupError(error);
  }
}

async function handleRuntimeFailure(error) {
  if (failurePromise || quitting) return failurePromise;
  failurePromise = (async () => {
    await host.stop();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    mainWindow = null;
    const result = await dialog.showMessageBox({
      type: 'error',
      title: 'DSH 服务已停止',
      message: error.message,
      detail: '可以重试启动服务，或退出 DSH Desktop。',
      buttons: ['重试', '退出'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0 && !quitting) {
      try { await startHostAndLoad(); } catch (retryError) { await showStartupError(retryError); }
    } else {
      await requestQuit();
    }
  })().finally(() => { failurePromise = null; });
  return failurePromise;
}

async function showStartupError(error) {
  const rawDiagnostics = error instanceof DshHostError ? error.stderr || error.stdout || '' : '';
  const diagnostics = rawDiagnostics ? `\n\n${rawDiagnostics.slice(-4_000)}` : '';
  await dialog.showMessageBox({
    type: 'error',
    title: '无法启动 DSH',
    message: error.message,
    detail: `请确认已安装 DSH ${DSH_VERSION}，并重试。${diagnostics}`,
  });
}

function showMainWindow() {
  if (quitting || activateWindow(mainWindow) || activationPromise || !bootstrapPromise) return;
  activationPromise = bootstrapPromise.then(async () => {
    if (quitting || activateWindow(mainWindow)) return;
    try {
      await startHostAndLoad();
      activateWindow(mainWindow);
    } catch (error) {
      await showStartupError(error);
    }
  }, () => {
    // bootstrap reports its own startup error and quits the application.
  }).finally(() => {
    activationPromise = null;
  });
}

async function requestQuit() {
  if (shutdownPromise) return shutdownPromise;
  quitting = true;
  shutdownPromise = (async () => {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    await host.stop();
    app.quit();
  })();
  return shutdownPromise;
}

async function bootstrap() {
  if (!supportedNodeRuntime()) {
    dialog.showErrorBox(
      'DSH Desktop 运行时不兼容',
      `当前 Electron 内置 Node.js ${process.versions.node}，DSH ${DSH_VERSION} 需要 Node.js 22.19+ 或 24+。请升级 Electron。`,
    );
    await requestQuit();
    return;
  }
  settings = await readSettings();
  createTray();
  try {
    await startHostAndLoad();
  } catch (error) {
    await showStartupError(error);
    await requestQuit();
  }
}

if (!registerSingleInstance(app, showMainWindow)) {
  quitting = true;
  app.quit();
} else {
  app.on('before-quit', (event) => {
    if (!quitting) {
      event.preventDefault();
      void requestQuit();
    }
  });

  app.on('window-all-closed', () => {
    // DSH Desktop intentionally remains available from the tray.
  });

  bootstrapPromise = app.whenReady().then(bootstrap);
  void bootstrapPromise.catch(async (error) => {
    await showStartupError(error);
    await requestQuit();
  });

  app.on('activate', showMainWindow);
}
