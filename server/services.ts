import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from '../shared/types.ts';
import { AgentHub } from './agent/runtime.ts';
import { CanvasMcp, type Presence } from './mcp/server.ts';
import { AssetStore } from './assets/store.ts';
import { ComfyClient } from './comfy/client.ts';
import { config } from './config.ts';
import { PresetStore } from './workflows/presets.ts';
import { ProjectStore } from './projects/store.ts';
import { SettingsStore } from './settings.ts';
import { TaskManager } from './tasks/manager.ts';
import { ThumbStore } from './assets/thumbnails.ts';
import { WorkflowStore } from './workflows/store.ts';
import { createCapabilities } from './comfy/capabilities.ts';
import { createEvents } from './events.ts';

async function stableClientId() {
  const file = join(config.dataDir, 'comfy-client-id');
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    const id = `infinode-${randomUUID().slice(0, 8)}`;
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(file, id);
    return id;
  }
}

export async function createServices() {
  await mkdir(config.dataDir, { recursive: true });
  const settings = new SettingsStore();
  await settings.init();
  const comfy = new ComfyClient(settings.value.comfyUrl, await stableClientId());
  const assets = new AssetStore();
  const projects = new ProjectStore();
  const workflows = new WorkflowStore();
  const presets = new PresetStore();
  const thumbs = new ThumbStore();
  const capabilities = createCapabilities(comfy, workflows, presets, settings);
  const tasks = new TaskManager(
    comfy,
    assets,
    (id) => workflows.get(id) ?? presets.get(id),
    capabilities.cachedObjectInfo,
  );
  await Promise.all([assets.init(), projects.init(), workflows.init(), presets.init(), tasks.init(), thumbs.init()]);

  const events = createEvents();
  const { projectEvents, agentEvents, revealEvents } = events;
  let presence: Presence | undefined;
  const canvasDeps = {
    projects,
    tasks,
    assets,
    workflows: () => [...workflows.list(), ...presets.list()],
    capabilities: () => capabilities.get(),
    changed: (p: Project) => projectEvents.emit({ id: p.id, updatedAt: p.updatedAt, by: 'agent' }),
    commercialOnly: () => Boolean(settings.value.commercialOnly),
  };
  const agent = new AgentHub(canvasDeps, (e) => agentEvents.emit(e), {}, settings);
  const mcp = new CanvasMcp(canvasDeps, () => presence, (projectId, ids) => revealEvents.emit({ projectId, ids }), process.env.npm_package_version ?? 'dev');
  await agent.init();
  return {
    settings, comfy, assets, projects, workflows, presets, thumbs, tasks, agent, mcp, capabilities,
    ...events,
    setPresence: (next: Presence) => { presence = next; },
  };
}

export type Services = Awaited<ReturnType<typeof createServices>>;
