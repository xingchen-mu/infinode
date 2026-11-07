import type {
  AgentEventData,
  AgentStatus,
  AgentView,
  AssetInfo,
  Capabilities,
  CustomWorkflow,
  ModelDownloadJob,
  ModelInstallInfo,
  ModelInstallPlan,
  ModelSource,
  PresetInfo,
  Project,
  ProjectSnapshotSummary,
  ProjectSummary,
  Settings,
  Task,
  TaskRequest,
  WorkflowDraft,
} from '../../shared/types';
import { t } from '../i18n';

export type WorkflowData = Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'>;
export type AgentSettingsPatch = {
  agentModel?: string;
  agentBaseUrl?: string;
  agentApiKey?: string;
  clearAgentApiKey?: boolean;
  agentVision?: boolean;
  agentThinking?: string;
  agentApprovalMode?: 'risky' | 'always';
  /** null: back to the default. */
  agentContextWindow?: number | null;
  agentReasoning?: boolean;
};
export type ModelSettingsPatch = {
  modelSource?: ModelSource;
  modelEndpoint?: string;
  hfToken?: string;
  clearHfToken?: boolean;
};

/** Identifies this tab's own board saves, so their change events are not merged back in. */
export const clientId = `tab-${crypto.randomUUID().slice(0, 8)}`;

/** A save refused because the board changed elsewhere; carries the current board. */
export class ConflictError extends Error {
  constructor(message: string, readonly project: Project) {
    super(message);
  }
}

export interface ProjectEvent {
  id: string;
  updatedAt: number;
  by: string;
  deleted?: boolean;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error(t('无法连接本地服务，请确认 npm run dev 正在运行'));
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  const message = (data as { error?: string })?.error ?? t('请求失败 ({status})', { status: res.status });
  if (res.status === 409 && (data as { project?: Project })?.project) throw new ConflictError(message, (data as { project: Project }).project);
  if (!res.ok) throw new Error(message);
  return data as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  capabilities: (refresh = false) => request<Capabilities>(`/api/capabilities${refresh ? '?refresh=1' : ''}`),

  uploadAsset(file: Blob, name: string, size?: { width: number; height: number }) {
    const form = new FormData();
    form.append('file', file, name);
    form.append('name', name);
    if (size) {
      form.append('width', String(size.width));
      form.append('height', String(size.height));
    }
    return request<AssetInfo>('/api/assets', { method: 'POST', body: form });
  },
  assets: () => request<AssetInfo[]>('/api/assets'),

  setAssetSize: (id: string, width: number, height: number) =>
    request<{ ok: true }>(`/api/assets/${id}/size`, json('POST', { width, height })),

  createTask: (req: TaskRequest, id?: string) => request<Task>('/api/tasks', json('POST', { request: req, id })),
  cancelTask: (id: string) => request<Task>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  tasks: (ids: string[]) => request<Task[]>(`/api/tasks?ids=${ids.join(',')}`),

  projects: () => request<ProjectSummary[]>('/api/projects'),
  createProject: (name?: string) => request<Project>('/api/projects', json('POST', { name })),
  project: (id: string) => request<Project>(`/api/projects/${id}`),
  saveProject: (
    id: string,
    patch: Partial<Pick<Project, 'name' | 'items' | 'viewport'>> & { baseUpdatedAt?: number },
    keepalive = false,
  ) => {
    const init = json('PUT', patch);
    return request<{ updatedAt: number }>(`/api/projects/${id}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'X-Infinode-Client': clientId },
      keepalive,
    });
  },
  deleteProject: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: 'DELETE' }),
  projectSnapshots: (id: string) => request<ProjectSnapshotSummary[]>(`/api/projects/${id}/snapshots`),
  createSnapshot: (id: string, name?: string) => request<ProjectSnapshotSummary>(`/api/projects/${id}/snapshots`, json('POST', { name })),
  restoreSnapshot: (id: string, snapshotId: string) => request<Project>(`/api/projects/${id}/snapshots/${encodeURIComponent(snapshotId)}/restore`, { method: 'POST' }),
  branchProject: (id: string, snapshotId: string, name?: string) => request<Project>(`/api/projects/${id}/branches`, json('POST', { snapshotId, name })),

  settings: () => request<Settings>('/api/settings'),
  saveSettings: (patch: Omit<Partial<Settings>, keyof AgentSettingsPatch> & AgentSettingsPatch & ModelSettingsPatch) =>
    request<{ settings: Settings; capabilities: Capabilities }>('/api/settings', json('PUT', patch)),
  testComfy: (comfyUrl: string) =>
    request<{ ok: boolean; url?: string; version?: string; gpu?: string; error?: string }>('/api/settings/test', json('POST', { comfyUrl })),

  workflows: () => request<CustomWorkflow[]>('/api/workflows'),
  presets: () => request<PresetInfo[]>('/api/presets'),
  preset: (id: string) => request<CustomWorkflow & { template: string }>(`/api/presets/${encodeURIComponent(id)}`),
  draftWorkflow: (jsonData: unknown, name?: string) => request<WorkflowDraft>('/api/workflows/draft', json('POST', { json: jsonData, name })),
  workflowDraft: (id: string) => request<WorkflowDraft>(`/api/workflows/${id}/draft`),
  createWorkflow: (workflow: WorkflowData) => request<CustomWorkflow>('/api/workflows', json('POST', { workflow })),
  updateWorkflow: (id: string, workflow: WorkflowData) => request<CustomWorkflow>(`/api/workflows/${id}`, json('PUT', { workflow })),
  deleteWorkflow: (id: string) => request<{ ok: true }>(`/api/workflows/${id}`, { method: 'DELETE' }),

  agentStatus: () => request<AgentStatus>('/api/agent/status'),
  agent: (projectId: string) => request<AgentView>(`/api/agent/${projectId}`),
  sendAgent: (projectId: string, body: { text: string; selection: string[]; view: { x: number; y: number } }) =>
    request<{ ok: true }>(`/api/agent/${projectId}`, json('POST', body)),
  abortAgent: (projectId: string) => request<{ ok: true }>(`/api/agent/${projectId}/abort`, { method: 'POST' }),
  clearAgent: (projectId: string) => request<{ ok: true }>(`/api/agent/${projectId}`, { method: 'DELETE' }),
  /** What this page shows, for outside agents (MCP) to act on "the selected items". */
  presence: (body: { projectId: string; selection: string[]; view: { x: number; y: number } }) =>
    request<{ ok: true }>('/api/presence', json('PUT', body)),
  approveAgent: (projectId: string, id: string, ok: boolean) => request<{ ok: true }>(`/api/agent/${projectId}/approve`, json('POST', { id, ok })),

  modelInstall: () => request<ModelInstallInfo>('/api/models/install'),
  modelDownloads: () => request<ModelDownloadJob[]>('/api/models/downloads'),
  planModels: (names: string[]) => request<ModelInstallPlan>('/api/models/plan', json('POST', { names })),
  downloadModels: (names: string[]) => request<ModelDownloadJob[]>('/api/models/downloads', json('POST', { names })),
  cancelDownload: (id: string) => request<ModelDownloadJob>(`/api/models/downloads/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
};

export interface EventHandlers {
  onTask(task: Task): void;
  onComfy(online: boolean): void;
  onHello(data: { comfyOnline: boolean; active: Task[] }): void;
  onProject(e: ProjectEvent): void;
  onAgent(e: AgentEventData): void;
  /** Items an outside agent just made, to bring into view. */
  onReveal(e: { projectId: string; ids: string[] }): void;
  /** A model download started, moved on or ended. */
  onDownload(job: ModelDownloadJob): void;
  onConnection(ok: boolean): void;
}

/** Server-sent events; EventSource reconnects on its own. */
export function subscribeEvents(h: EventHandlers): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    h.onConnection(true);
    h.onHello(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener('task', (e) => h.onTask(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('comfy', (e) => h.onComfy(JSON.parse((e as MessageEvent).data).online));
  es.addEventListener('project', (e) => h.onProject(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('agent', (e) => h.onAgent(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('reveal', (e) => h.onReveal(JSON.parse((e as MessageEvent).data)));
  es.addEventListener('download', (e) => h.onDownload(JSON.parse((e as MessageEvent).data)));
  es.onerror = () => h.onConnection(false);
  return () => es.close();
}
