import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Project, ProjectSummary } from '../shared/types.ts';
import { config } from './config.ts';

const ID = /^[\w-]{6,32}$/;

export class ProjectStore {
  private readonly dir = join(config.dataDir, 'projects');

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  private file(id: string) {
    if (!ID.test(id)) throw new Error('invalid project id');
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<ProjectSummary[]> {
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
    const out: ProjectSummary[] = [];
    for (const n of names) {
      try {
        const p = JSON.parse(await readFile(join(this.dir, n), 'utf8')) as Project;
        const cover = p.items.find((i) => i.asset?.kind === 'image')?.asset?.url;
        out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, itemCount: p.items.length, ...(cover ? { cover } : {}) });
      } catch {
        /* skip unreadable files */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Project | undefined> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as Project;
    } catch {
      return undefined;
    }
  }

  async create(name = '未命名画布'): Promise<Project> {
    const now = Date.now();
    const p: Project = { id: nanoid(10), name, items: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now };
    await this.write(p);
    return p;
  }

  async save(id: string, patch: Partial<Pick<Project, 'name' | 'items' | 'viewport'>>): Promise<Project | undefined> {
    const p = await this.get(id);
    if (!p) return undefined;
    if (typeof patch.name === 'string') p.name = patch.name.trim().slice(0, 80) || p.name;
    if (Array.isArray(patch.items)) p.items = patch.items;
    if (patch.viewport) p.viewport = patch.viewport;
    p.updatedAt = Date.now();
    await this.write(p);
    return p;
  }

  async remove(id: string) {
    await rm(this.file(id), { force: true });
  }

  private async write(p: Project) {
    const file = this.file(p.id);
    const tmp = `${file}.${nanoid(4)}.tmp`;
    await writeFile(tmp, JSON.stringify(p));
    await rename(tmp, file);
  }
}
