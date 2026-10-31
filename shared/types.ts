// Types shared by the browser app and the backend.

export type MediaKind = 'image' | 'video';

export interface AssetInfo {
  id: string;
  url: string;
  kind: MediaKind;
  mime: string;
  width: number;
  height: number;
  name?: string;
}

export type ImageModel = 'zimage' | 'qwen';
export type VideoModel = 'minimax' | 'minimax-ref';
export type ImageQuality = '1k' | '2k';
export type VideoQuality = '480p' | '720p';

/** `aspect` is "W:H" (e.g. "16:9") or "auto" (follow the first input image). */
export type TaskRequest =
  | {
      op: 'image.generate';
      model: ImageModel;
      prompt: string;
      aspect: string;
      quality: ImageQuality;
      /** Reference images (asset ids). Only used by models that accept references. */
      images?: string[];
      seed?: number;
    }
  | { op: 'image.inpaint'; image: string; mask: string; prompt: string; seed?: number }
  | { op: 'image.erase'; image: string; mask: string; seed?: number }
  | {
      op: 'image.outpaint';
      image: string;
      /** Padding in source-image pixels. */
      left: number;
      top: number;
      right: number;
      bottom: number;
      prompt?: string;
      seed?: number;
    }
  | { op: 'image.removeBg'; image: string; seed?: number }
  | { op: 'image.upscale'; image: string; scale: number; seed?: number }
  | {
      op: 'video.generate';
      model: VideoModel;
      prompt: string;
      aspect: string;
      quality: VideoQuality;
      /** Seconds. */
      duration: number;
      /** minimax: [first frame?, last frame?]. minimax-ref: reference images. */
      images?: string[];
      seed?: number;
    }
  | {
      /** A workflow the user imported (see CustomWorkflow). */
      op: 'custom';
      workflow: string;
      prompt?: string;
      negative?: string;
      /** Asset ids for the workflow's image inputs, in order. */
      images?: string[];
      /** Asset ids for its video inputs, in order. */
      videos?: string[];
      mask?: string;
      /** Only used when the workflow exposes width/height. */
      aspect?: string;
      quality?: ImageQuality;
      /** Values for exposed parameters, by WorkflowInput.id. */
      params?: Record<string, string | number | boolean>;
      seed?: number;
    };

export type TaskOp = TaskRequest['op'];
export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Task {
  id: string;
  request: TaskRequest;
  status: TaskStatus;
  promptId?: string;
  /** 0..1 */
  progress: number;
  stage?: string;
  /** 0 = running next. Only set while queued. */
  queuePosition?: number;
  expected: { kind: MediaKind; width: number; height: number };
  results: AssetInfo[];
  error?: string;
  seed: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface Capabilities {
  comfyOnline: boolean;
  comfyUrl: string;
  comfyVersion?: string;
  gpu?: string;
  /** key: capability id (e.g. "image.generate:zimage", "custom:<id>"), value: missing requirements (empty = available) */
  features: Record<string, string[]>;
  /** Model files picked for built-in tools, by slot (e.g. "qwen.unet"). */
  models: Record<string, string>;
}

// ------------------------------------------------------------------ imported workflows

/** One node of a ComfyUI API-format prompt ("Export (API)"). */
export interface ComfyApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}

export type ComfyApiGraph = Record<string, ComfyApiNode>;

export type WorkflowInputType =
  | 'prompt'
  | 'negative'
  | 'image'
  | 'video'
  | 'mask'
  | 'seed'
  | 'width'
  | 'height'
  /** A ratio dropdown such as ResolutionSelector.aspect_ratio ("16:9 (Widescreen)"). */
  | 'aspect'
  | 'number'
  | 'text'
  | 'select'
  | 'boolean';

/** Binds a node field of the graph to something the canvas provides. */
export interface WorkflowInput {
  /** Unique within the workflow; params are sent under this key. */
  id: string;
  type: WorkflowInputType;
  node: string;
  field: string;
  label: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  /** Image/video inputs: may be left empty (the loader is then cut out of the graph). */
  optional?: boolean;
}

export interface CustomWorkflow {
  id: string;
  name: string;
  description?: string;
  /** What the outputs are. */
  kind: MediaKind;
  graph: ComfyApiGraph;
  inputs: WorkflowInput[];
  /** Nodes whose saved files are the results. */
  outputs: string[];
  createdAt: number;
  updatedAt: number;
}

/** What the canvas needs to run a workflow (user-imported or preset); the graph stays on the server. */
export type WorkflowLike = Omit<CustomWorkflow, 'graph'>;

/** A field of the graph that could be exposed, with its ComfyUI spec when known. */
export interface WorkflowField {
  node: string;
  classType: string;
  title?: string;
  field: string;
  value: unknown;
  kind: 'number' | 'text' | 'select' | 'boolean';
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

/** Something the connected ComfyUI lacks for a workflow. */
export interface WorkflowIssue {
  /** 'auto': a missing file this server has under another name/precision; used automatically. */
  type: 'node' | 'file' | 'offline' | 'auto';
  message: string;
  node?: string;
  field?: string;
  value?: string;
  /** For missing files: what the server does have for that field. */
  options?: string[];
}

/** What the server worked out from an imported JSON, for the editor to review. */
export interface WorkflowDraft {
  workflow: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string };
  fields: WorkflowField[];
  /** Nodes that can produce result files. */
  outputCandidates: { node: string; classType: string; title?: string }[];
  issues: WorkflowIssue[];
}

export interface ModelDownload {
  name: string;
  url: string;
  /** ComfyUI models subfolder, e.g. "diffusion_models". */
  directory: string;
}

/** An official ComfyUI template packaged as a ready-made tool (presets/*.json). */
export interface PresetInfo extends Omit<CustomWorkflow, 'graph'> {
  preset: true;
  template: string;
  category: string;
  usage: number;
  /** Thumbnail file name in ComfyUI's template folder. */
  thumb?: string;
  models: ModelDownload[];
  /** What the connected ComfyUI lacks (all empty = ready). `notes`: other blockers, e.g. fp8 support. */
  missing: { nodes: string[]; models: ModelDownload[]; notes: string[] };
}

export interface Settings {
  comfyUrl: string;
}

export interface CanvasItem {
  id: string;
  kind: MediaKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Set once the media exists. */
  asset?: AssetInfo;
  /** Set while the item is a placeholder waiting for a task. */
  taskId?: string;
  /** Index into task.results this placeholder will show. */
  resultIndex?: number;
  /** The request that produced (or will produce) this item; used for retry and info. */
  request?: TaskRequest;
  /** Board items this one was made from, in request order (drawn as connection lines). */
  inputs?: string[];
  /** Older name for inputs[0]; kept so earlier boards still show their links. */
  sourceId?: string;
  error?: string;
  name?: string;
  createdAt: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Project {
  id: string;
  name: string;
  items: CanvasItem[];
  viewport: Viewport;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  itemCount: number;
  cover?: string;
}
