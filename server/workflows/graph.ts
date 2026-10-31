// Minimal builder for ComfyUI API-format prompts.

import type { ComfyApiNode } from '../../shared/types.ts';

export type Ref = [string, number];

export type ApiNode = ComfyApiNode;

export interface Handle {
  id: string;
  out(slot?: number): Ref;
}

export class Graph {
  readonly nodes: Record<string, ApiNode> = {};
  private next = 1;

  add(classType: string, inputs: Record<string, unknown>, title?: string): Handle {
    const id = String(this.next++);
    this.nodes[id] = { class_type: classType, inputs, ...(title ? { _meta: { title } } : {}) };
    return { id, out: (slot = 0) => [id, slot] };
  }
}

/** A heavy node whose progress events drive the task progress bar. */
export interface Stage {
  node: string;
  label: string;
  weight: number;
}

export interface BuiltWorkflow {
  graph: Record<string, ApiNode>;
  /** Nodes whose saved files are the task results. */
  outputNodes: string[];
  expected: { kind: 'image' | 'video'; width: number; height: number };
  stages: Stage[];
}

/** An input file that has already been uploaded to ComfyUI's input folder. */
export interface InputFile {
  /** Value for LoadImage / LoadVideo. */
  comfyName: string;
  width: number;
  height: number;
}

export function snap(v: number, multiple: number): number {
  return Math.max(multiple, Math.round(v / multiple) * multiple);
}

export function parseAspect(aspect: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect.trim());
  if (!m) return null;
  const r = Number(m[1]) / Number(m[2]);
  return r > 0 && Number.isFinite(r) ? r : null;
}

/** Width/height with the given aspect ratio and pixel budget (in megapixels, 1 MP = 1024²). */
export function sizeForAspect(aspect: number, megapixels: number, multiple: number) {
  const px = megapixels * 1024 * 1024;
  return {
    width: snap(Math.sqrt(px * aspect), multiple),
    height: snap(Math.sqrt(px / aspect), multiple),
  };
}

/** Same aspect as w×h, scaled to the pixel budget. */
export function fitPixels(w: number, h: number, megapixels: number, multiple: number) {
  return sizeForAspect(w / h, megapixels, multiple);
}

/** Same aspect as w×h, only scaled down when larger than the budget. */
export function capPixels(w: number, h: number, maxMegapixels: number, multiple: number) {
  const px = (w * h) / (1024 * 1024);
  if (px <= maxMegapixels) return { width: snap(w, multiple), height: snap(h, multiple) };
  return fitPixels(w, h, maxMegapixels, multiple);
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 48);
}
