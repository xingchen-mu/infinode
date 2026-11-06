import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isDev = process.env.INFINODE_DESKTOP_DEV === '1';
const devUrl = process.env.INFINODE_DEV_URL || 'http://127.0.0.1:5173';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let backend;
let backendUrl;
let quitting = false;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close();
      if (port) resolve(port);
      else reject(new Error('无法分配本地端口'));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`本地服务提前退出（${child.exitCode}）`);
    try {
      const response = await fetch(`${url}/api/capabilities`, { signal: AbortSignal.timeout(800) });
      if (response.status < 500) return;
    } catch {
      // The server may still be initializing its stores. Keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('等待本地服务启动超时');
}

function runtimePath(...parts) {
  if (!app.isPackaged) return path.join(sourceRoot, ...parts);
  return path.join(process.resourcesPath, 'app.asar.unpacked', ...parts);
}

async function startBackend() {
  const port = await freePort();
  const appPath = app.isPackaged ? app.getAppPath() : sourceRoot;
  const dataDir = path.join(app.getPath('userData'), 'data');
  const envFile = path.join(app.getPath('userData'), '.env');
  const runner = runtimePath('node_modules', 'tsx', 'dist', 'cli.mjs');
  const entry = path.join(appPath, 'server', 'index.ts');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    INFINODE_APP_ROOT: appPath,
    INFINODE_ENV_FILE: envFile,
    PRESETS_DIR: path.join(appPath, 'presets'),
    ELECTRON_RUN_AS_NODE: '1',
  };

  backend = spawn(process.execPath, [runner, entry], {
    cwd: app.isPackaged ? process.resourcesPath : appPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  backend.stdout?.on('data', (chunk) => console.log(`[infinode] ${chunk.toString().trimEnd()}`));
  backend.stderr?.on('data', (chunk) => console.error(`[infinode] ${chunk.toString().trimEnd()}`));
  backend.on('error', (error) => console.error('[infinode] backend error', error));
  backendUrl = `http://127.0.0.1:${port}`;
  await waitForServer(backendUrl, backend);
  return backendUrl;
}

async function createWindow() {
  const url = isDev ? devUrl : await startBackend();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    title: 'Infinode',
    backgroundColor: '#17191d',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  await win.loadURL(url);
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

function stopBackend() {
  if (!backend || backend.killed) return;
  backend.kill('SIGTERM');
  backend = undefined;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: 'Infinode',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
    ]));

    try {
      await createWindow();
    } catch (error) {
      console.error(error);
      await dialog.showMessageBox({
        type: 'error',
        title: 'Infinode 启动失败',
        message: error instanceof Error ? error.message : String(error),
        detail: '请查看终端输出，确认本地服务和依赖安装完整。',
      });
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    if (!quitting) {
      quitting = true;
      stopBackend();
    }
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}
