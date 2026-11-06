import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, platform, arch, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const electronDir = join(root, '..', 'node_modules', 'electron');
const packageInfo = JSON.parse(await readFile(join(electronDir, 'package.json'), 'utf8'));
const version = packageInfo.version;

const platformPath = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
  win32: 'electron.exe',
}[platform()];
if (!platformPath) throw new Error(`Electron 不支持当前平台：${platform()}`);

const fileName = `electron-v${version}-${platform()}-${arch()}.zip`;
const dist = join(electronDir, 'dist');
const executable = join(dist, ...platformPath.split('/'));

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

if (await exists(executable) && await exists(join(electronDir, 'path.txt'))) {
  console.log(`Electron ${version} 已就绪`);
  process.exit(0);
}

async function findFile(dir) {
  if (!(await exists(dir))) return undefined;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) return file;
    if (entry.isDirectory()) {
      const found = await findFile(file);
      if (found) return found;
    }
  }
}

const cacheRoots = [
  process.env.electron_config_cache,
  join(homedir(), 'Library', 'Caches', 'electron'),
  join(homedir(), '.cache', 'electron'),
].filter(Boolean);
let archive;
for (const cache of cacheRoots) {
  archive = await findFile(cache);
  if (archive) break;
}

if (!archive) {
  const mirror = (process.env.ELECTRON_MIRROR || 'https://github.com/electron/electron/releases/download').replace(/\/$/, '');
  const customDir = (process.env.ELECTRON_CUSTOM_DIR || `v${version}`).replace(/^\//, '').replace(/\/$/, '');
  const url = `${mirror}/${customDir}/${fileName}`;
  archive = join(tmpdir(), fileName);
  console.log(`正在下载 Electron ${version}：${url}`);
  const download = spawnSync('curl', ['-fL', '--retry', '3', '--retry-delay', '1', '-o', archive, url], { stdio: 'inherit' });
  if (download.status !== 0) throw new Error('Electron 下载失败。可以设置 ELECTRON_MIRROR 后重试。');
}

console.log(`正在解压 Electron：${archive}`);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
let result;
if (platform() === 'win32') {
  result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${dist.replaceAll("'", "''")}' -Force`], { stdio: 'inherit' });
} else {
  result = spawnSync('unzip', ['-q', '-o', archive, '-d', dist], { stdio: 'inherit' });
}
if (result.status !== 0) throw new Error('Electron 解压失败，请确认系统有 unzip 或 PowerShell。');

await writeFile(join(electronDir, 'path.txt'), platformPath);
if (platform() !== 'win32') spawnSync('chmod', ['+x', executable]);
console.log(`Electron ${version} 已修复`);
