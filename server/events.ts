import type { AgentEventData, ModelDownloadJob } from '../shared/types.ts';

export function createEvents() {
  return {
    comfyStatus: createChannel<boolean>(),
    projectEvents: createChannel<{ id: string; updatedAt: number; by: string; deleted?: boolean }>(),
    agentEvents: createChannel<AgentEventData>(),
    revealEvents: createChannel<{ projectId: string; ids: string[] }>(),
    downloadEvents: createChannel<ModelDownloadJob>(),
  };
}

/** Tiny listener set for the ComfyUI online flag. */
function createChannel<T>() {
  const fns = new Set<(value: T) => void>();
  return {
    on: (fn: (value: T) => void) => void fns.add(fn),
    off: (fn: (value: T) => void) => void fns.delete(fn),
    emit: (value: T) => fns.forEach((fn) => fn(value)),
  };
}
