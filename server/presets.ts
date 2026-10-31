import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CustomWorkflow, ModelDownload } from '../shared/types.ts';

export interface Preset extends CustomWorkflow {
  preset: true;
  template: string;
  category: string;
  usage: number;
  thumb?: string;
  models: ModelDownload[];
}

/** Official templates shipped with the app (presets/*.json, built by scripts/build-presets.ts). Read-only. */
export class PresetStore {
  private readonly dir = resolve(process.env.PRESETS_DIR ?? 'presets');
  private items = new Map<string, Preset>();

  async init() {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const p = JSON.parse(await readFile(join(this.dir, name), 'utf8'));
        if (p.format !== 'infinode/preset' || !p.graph) continue;
        const preset: Preset = {
          id: `tpl_${p.id}`,
          name: p.name,
          description: p.description,
          kind: p.kind === 'video' ? 'video' : 'image',
          graph: p.graph,
          inputs: p.inputs ?? [],
          outputs: p.outputs ?? [],
          createdAt: 0,
          updatedAt: 0,
          preset: true,
          template: p.template,
          category: p.category ?? '其它',
          usage: p.usage ?? 0,
          thumb: p.thumb ?? `${p.template}-1.webp`,
          models: p.models ?? [],
        };
        this.items.set(preset.id, preset);
      } catch {
        /* skip broken files */
      }
    }
  }

  list(): Preset[] {
    return [...this.items.values()].sort((a, b) => b.usage - a.usage);
  }

  get(id: string): Preset | undefined {
    return this.items.get(id);
  }
}
