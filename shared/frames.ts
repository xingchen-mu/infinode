import type { CanvasItem } from './types';

/**
 * A keyframe redone after `since`: the newest ready image with the same name and group. A video
 * approval card made before the redo shows and submits this one, so the user confirms what they see.
 * Only versions made after the card count, so a frame the assistant chose on purpose stays.
 */
export function redoneVersion(items: CanvasItem[], frame: CanvasItem, since: number, ready: (item: CanvasItem) => boolean): CanvasItem | undefined {
  if (!frame.name) return undefined;
  let newest: CanvasItem | undefined;
  for (const i of items) {
    if (i.id === frame.id || i.kind !== 'image' || i.name !== frame.name || (i.group ?? '') !== (frame.group ?? '')) continue;
    if (i.createdAt <= since || !ready(i)) continue;
    if (!newest || i.createdAt > newest.createdAt) newest = i;
  }
  return newest;
}
