import { mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const target = join(root, 'site', 'assets');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(join(root, 'docs', 'media', 'logo.svg'), join(target, 'logo.svg'));
await cp(join(root, 'docs', 'media', 'hero.png'), join(target, 'hero.png'));
console.log('site assets copied');
