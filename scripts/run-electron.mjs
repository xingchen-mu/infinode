import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'node_modules', 'electron', 'cli.js');
const env = { ...process.env };
// Some Node/Electron development environments export this globally. It makes
// the Electron binary behave like plain Node, so the app module never loads.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
