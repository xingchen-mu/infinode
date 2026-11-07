import type { Lang } from './i18n.ts';
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
  /** Videos: seconds, once the page has read it. */
  duration?: number;
  createdAt?: number;
  usage?: AssetUsage;
}

export interface AssetUsage {
  references: number;
  projects: { id: string; name: string }[];
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
  /** Built-in tools: missing model files that can be downloaded, by capability id. */
  downloads?: Record<string, ModelDownload[]>;
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

/**
 * Where model downloads come from. Hugging Face links are fetched from the chosen endpoint;
 * 'auto' tries Hugging Face and hf-mirror.com in turn and remembers the one that answered.
 */
export type ModelSource = 'auto' | 'huggingface' | 'hf-mirror' | 'custom';

/**
 * How downloaded files reach ComfyUI's models folders: written directly (ComfyUI is on this machine),
 * fetched by the ComfyUI server itself over SSH (SSH_HOST), or by the user with the commands shown.
 */
export type ModelInstallMode = 'local' | 'ssh' | 'manual' | 'offline';

export interface ModelDownloadJob {
  id: string;
  name: string;
  directory: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  received: number;
  total?: number;
  /** Bytes per second while running. */
  speed?: number;
  /** Full path of the file on the ComfyUI machine. */
  path?: string;
  /** Host the file came from, e.g. "hf-mirror.com". */
  source?: string;
  /** The file was already there. */
  existed?: boolean;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface ModelInstallInfo {
  mode: ModelInstallMode;
  /** SSH host alias, in 'ssh' mode. */
  host?: string;
  /** Why files cannot be installed automatically ('manual' / 'offline'). */
  reason?: string;
  source: ModelSource;
  /** Endpoint for 'custom' (e.g. an in-house mirror). */
  endpoint?: string;
  hfTokenConfigured: boolean;
  jobs: ModelDownloadJob[];
}

/** What a download would do, shown before it starts. */
export interface ModelInstallPlan {
  mode: ModelInstallMode;
  host?: string;
  reason?: string;
  files: {
    name: string;
    directory: string;
    /** Target path on the ComfyUI machine (relative to the ComfyUI folder when unknown). */
    path: string;
    url: string;
    size?: number;
    exists?: boolean;
    /** Why this file could not be checked or cannot be downloaded. */
    error?: string;
  }[];
  /** Free space where the files go, when known. */
  free?: number;
  /** Shell commands that download the files by hand. */
  commands: string;
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
  /** Only models whose license allows commercial use (see shared/licenses.ts); the rest are switched off. */
  commercialOnly?: boolean;
  /** Interface language of the page that last opened Infinode: the server's messages and the assistant follow it. */
  language?: Lang;
  /** Canvas assistant model settings. The API key itself is never returned. */
  agentModel?: string;
  agentBaseUrl?: string;
  agentVision?: boolean;
  agentThinking?: string;
  /** Whether the assistant asks before every write operation. */
  agentApprovalMode?: 'risky' | 'always';
  agentApiKeyConfigured?: boolean;
  /** Where model downloads come from (see ModelSource). */
  modelSource?: ModelSource;
  /** Hugging Face compatible endpoint for modelSource 'custom'. */
  modelEndpoint?: string;
  /** A Hugging Face token is saved (for gated models). The token itself is never returned. */
  hfTokenConfigured?: boolean;
}

/** Text items hold notes such as a script or a shot list. */
export type ItemKind = MediaKind | 'text';

export interface CanvasItem {
  id: string;
  kind: ItemKind;
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
  /** Text items: the note (light Markdown); `name` is its title. */
  text?: string;
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

export interface ProjectSnapshotSummary {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  itemCount: number;
}

// ------------------------------------------------------------------ canvas agent

/** One row of the agent panel's conversation. */
export type AgentEntry =
  | {
      kind: 'user';
      id: string;
      text: string;
      /** Board items selected when the message was sent. */
      selection?: string[];
      at: number;
    }
  | { kind: 'assistant'; id: string; text: string; error?: string; at: number }
  /** Something that happened on its own, e.g. a batch of tasks finished and woke the agent. */
  | { kind: 'event'; id: string; text: string; at: number }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      label: string;
      /** `waiting`: held until the user approves it in the panel (`approval`). */
      status: 'running' | 'done' | 'error' | 'waiting';
      approval?: { title: string; detail: string };
      /** One line on what the call is doing or did (or its error). */
      summary: string;
      /** Board items it made or looked at. */
      items?: string[];
      at: number;
    };

export interface AgentStatus {
  /** False until a model is usable (e.g. its API key is missing); `reason` says what to do. */
  ready: boolean;
  /** "provider/model", e.g. "deepseek/deepseek-flash". */
  model: string;
  /** The model can look at images. */
  vision: boolean;
  reason?: string;
}

/** Tokens and estimated cost of a board's conversation so far (from the provider's catalog prices). */
export interface AgentUsage {
  tokens: number;
  cost: number;
}

export interface AgentView {
  entries: AgentEntry[];
  running: boolean;
  usage: AgentUsage;
}

/** Sent over /api/events as `agent`. */
export interface AgentEventData {
  projectId: string;
  /** Added or changed (matched by id). */
  entry?: AgentEntry;
  running?: boolean;
  usage?: AgentUsage;
  /** The conversation was cleared. */
  reset?: boolean;
}
