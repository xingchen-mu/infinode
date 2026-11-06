import type { CanvasItem } from '../../shared/types';

/**
 * Three-way merge by item id against `base`: an item changed (or added) here keeps the local
 * version; everything else follows `remote`, including its additions and deletions.
 */
export function mergeItems(base: Map<string, string>, local: CanvasItem[], remote: CanvasItem[]): CanvasItem[] {
  const localById = new Map(local.map((i) => [i.id, i]));
  const remoteIds = new Set(remote.map((i) => i.id));
  const out: CanvasItem[] = [];
  for (const r of remote) {
    const l = localById.get(r.id);
    const b = base.get(r.id);
    if (!l) {
      // Gone here: new on the server, or deleted here but changed there (the edit wins), or deleted here.
      if (b === undefined || JSON.stringify(r) !== b) out.push(r);
      continue;
    }
    out.push(b === undefined || JSON.stringify(l) !== b ? l : r);
  }
  for (const l of local) {
    if (remoteIds.has(l.id)) continue;
    const b = base.get(l.id);
    // Added here, or deleted there but changed here; untouched items deleted there stay deleted.
    if (b === undefined || JSON.stringify(l) !== b) out.push(l);
  }
  return out;
}
