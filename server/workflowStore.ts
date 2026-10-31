import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { CustomWorkflow } from '../shared/types.ts';
import { config } from './config.ts';

const ID = /^[\w-]{4,40}$/;

/** Imported workflows, one JSON file each under data/workflows/. */
export class WorkflowStore {
  private readonly dir = join(config.dataDir, 'workflows');
  private items = new Map<string, CustomWorkflow>();

  async init() {
    await mkdir(this.dir, { recursive: true });
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const wf = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as CustomWorkflow;
        if (wf.id && wf.graph) this.items.set(wf.id, wf);
      } catch {
        /* skip broken files */
      }
    }
  }

  list(): CustomWorkflow[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): CustomWorkflow | undefined {
    return this.items.get(id);
  }

  async save(data: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<CustomWorkflow> {
    const now = Date.now();
    const existing = data.id ? this.items.get(data.id) : undefined;
    const wf: CustomWorkflow = {
      id: existing?.id ?? (data.id && ID.test(data.id) && !this.items.has(data.id) ? data.id : nanoid(10)),
      name: data.name.trim().slice(0, 60),
      description: data.description?.trim().slice(0, 300) || undefined,
      kind: data.kind === 'video' ? 'video' : 'image',
      graph: data.graph,
      inputs: data.inputs,
      outputs: data.outputs,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const file = join(this.dir, `${wf.id}.json`);
    await writeFile(`${file}.tmp`, JSON.stringify(wf, null, 1));
    await rename(`${file}.tmp`, file);
    this.items.set(wf.id, wf);
    return wf;
  }

  async remove(id: string) {
    if (!ID.test(id)) return;
    this.items.delete(id);
    await rm(join(this.dir, `${id}.json`), { force: true });
  }
}
