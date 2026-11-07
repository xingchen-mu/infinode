import { ComfyError, type ComfyClient } from '../comfy/client.ts';

/** ComfyUI's model folders by type ("vae": ["/…/models/vae", …]), as paths on the ComfyUI machine. */
export type FolderPaths = Record<string, string[]>;

/** Older names of a folder type, still used as directory names. */
const ALIASES: Record<string, string[]> = {
  diffusion_models: ['diffusion_models', 'unet'],
  text_encoders: ['text_encoders', 'clip'],
};
const LEGACY: Record<string, string> = { unet: 'diffusion_models', clip: 'text_encoders' };

function isPaths(v: unknown): v is FolderPaths {
  return Boolean(v) && typeof v === 'object' && Object.values(v as object).every((p) => Array.isArray(p) && p.every((s) => typeof s === 'string'));
}

/**
 * Where ComfyUI looks for each model type. Returns null when this ComfyUI does not say (older versions);
 * throws when ComfyUI cannot be reached.
 */
export async function folderPaths(comfy: ComfyClient): Promise<FolderPaths | null> {
  try {
    const paths = await comfy.json<unknown>('/internal/folder_paths', {}, 10_000);
    if (isPaths(paths)) return paths;
  } catch (err) {
    if (err instanceof ComfyError && err.status === undefined) throw err; // unreachable, not just unsupported
  }
  try {
    const list = await comfy.json<{ name: string; folders: string[] }[]>('/api/experiment/models', {}, 10_000);
    if (Array.isArray(list)) return Object.fromEntries(list.filter((x) => typeof x?.name === 'string' && Array.isArray(x.folders)).map((x) => [x.name, x.folders]));
  } catch (err) {
    if (err instanceof ComfyError && err.status === undefined) throw err; // unreachable, not just unsupported
  }
  return null;
}

const parts = (p: string) => p.split(/[\\/]+/).filter(Boolean);
const baseName = (p: string) => parts(p).at(-1)?.toLowerCase() ?? '';
const parentName = (p: string) => parts(p).at(-2)?.toLowerCase() ?? '';

/** Joins with the separator the base path uses (ComfyUI may run on Windows). */
export function joinPath(base: string, ...rest: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...rest.flatMap((r) => r.split('/'))].join(sep);
}

export function parentPath(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i > 0 ? trimmed.slice(0, i) : trimmed.slice(0, i + 1);
}

/**
 * The folder a file of `directory` ("vae", "diffusion_models"…) goes into. ComfyUI may list several
 * (extra_model_paths.yaml, legacy names, output/ for saved models, even other types' folders), so take the first
 * whose own name matches the type, preferring ones that are not ComfyUI's output folder.
 */
export function pickFolder(paths: FolderPaths | null, directory: string): string | undefined {
  if (!paths) return undefined;
  const key = paths[directory] ? directory : LEGACY[directory];
  const names = ALIASES[key ?? directory] ?? [directory.toLowerCase()];
  const list = (key && paths[key]) || [];
  // The type's own name first ("text_encoders" over the legacy "clip"), then its other names.
  for (const name of [directory.toLowerCase(), ...names]) {
    const named = list.filter((p) => baseName(p) === name);
    const pick = named.find((p) => parentName(p) !== 'output') ?? named[0];
    if (pick) return pick;
  }
  if (list.length) return list.find((p) => parentName(p) !== 'output') ?? list[0];
  // A type ComfyUI does not know yet: next to its checkpoints folder.
  const checkpoints = (paths.checkpoints ?? []).find((p) => baseName(p) === 'checkpoints' && parentName(p) !== 'output');
  return checkpoints ? joinPath(parentPath(checkpoints), directory) : undefined;
}

/** A few folder paths, to tell whether they are on this machine. */
export function samplePaths(paths: FolderPaths): string[] {
  return [...new Set(['checkpoints', 'vae', 'loras', 'diffusion_models'].flatMap((k) => paths[k] ?? []))].slice(0, 8);
}
