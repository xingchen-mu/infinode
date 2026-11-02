import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { CanvasItem, Project, ProjectSummary } from '../shared/types.ts';
import { config } from './config.ts';
import { t } from './i18n.ts';

const ID = /^[\w-]{6,32}$/;

/** The board changed since the version the writer started from. */
export class ProjectConflict extends Error {
  constructor(readonly project: Project) {
    super(t('画布已在别处被修改'));
  }
}

export interface ItemsPatch {
  /** Added, or replacing the item with the same id (keeping its place in the stack). */
  upsert?: CanvasItem[];
  remove?: string[];
}

export class ProjectStore {
  private readonly dir = join(config.dataDir, 'projects');
  private readonly locks = new Map<string, Promise<unknown>>();

  /** Read-modify-write on one board runs one at a time. */
  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve()).then(fn, fn);
    const settled = run.catch(() => {});
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return run;
  }

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

  async create(name = t('未命名画布')): Promise<Project> {
    const now = Date.now();
    const p: Project = { id: nanoid(10), name, items: [], viewport: { x: 0, y: 0, zoom: 1 }, createdAt: now, updatedAt: now };
    await this.write(p);
    return p;
  }

  /** `base`: the updatedAt the writer last saw; a newer board is a conflict instead of being overwritten. */
  save(id: string, patch: Partial<Pick<Project, 'name' | 'items' | 'viewport'>>, base?: number): Promise<Project | undefined> {
    return this.exclusive(id, async () => {
      const p = await this.get(id);
      if (!p) return undefined;
      if (base !== undefined && base !== p.updatedAt) throw new ProjectConflict(p);
      if (typeof patch.name === 'string') p.name = patch.name.trim().slice(0, 80) || p.name;
      if (Array.isArray(patch.items)) p.items = patch.items;
      if (patch.viewport) p.viewport = patch.viewport;
      return this.touch(p);
    });
  }

  /** Adds, replaces and removes items without touching the rest of the board (for scripts and agents). */
  patchItems(id: string, patch: ItemsPatch): Promise<Project | undefined> {
    return this.exclusive(id, async () => {
      const p = await this.get(id);
      if (!p) return undefined;
      const drop = new Set(patch.remove ?? []);
      const upsert = new Map((patch.upsert ?? []).map((i) => [i.id, i]));
      const items = p.items.filter((i) => !drop.has(i.id)).map((i) => upsert.get(i.id) ?? i);
      const kept = new Set(items.map((i) => i.id));
      for (const i of upsert.values()) if (!kept.has(i.id) && !drop.has(i.id)) items.push(i);
      p.items = items;
      return this.touch(p);
    });
  }

  private async touch(p: Project) {
    // Strictly increasing, so it works as a version number.
    p.updatedAt = Math.max(Date.now(), p.updatedAt + 1);
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
