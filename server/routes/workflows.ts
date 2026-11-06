import { Hono } from 'hono';
import type { CustomWorkflow, WorkflowDraft } from '../../shared/types.ts';
import type { WorkflowIssue } from '../../shared/types.ts';
import { checkWorkflow, detectWorkflow, graphIssues, listFields, parseWorkflowJson } from '../workflows/custom.ts';
import { RequestError } from '../workflows/index.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';

export function registerWorkflowsRoutes(app: Hono, { workflows, capabilities }: Pick<Services, 'workflows' | 'capabilities'>) {
  app.get('/api/workflows', (c) => c.json(workflows.list()));

  const offlineIssue = (): WorkflowIssue => ({ type: 'offline', message: t('ComfyUI 未连接，暂时无法检查节点和模型') });

  /** Reads an uploaded JSON and proposes a mapping for the editor (nothing is saved). */
  app.post('/api/workflows/draft', async (c) => {
    const body = await c.req.json<{ json: unknown; name?: string }>();
    const { graph, saved } = parseWorkflowJson(body.json);
    const info = await capabilities.objectInfo();
    const draft = detectWorkflow(graph, info);
    const result: WorkflowDraft = {
      ...draft,
      workflow: saved?.inputs && saved.outputs
        ? { name: saved.name ?? '', description: saved.description, kind: saved.kind === 'video' ? 'video' : 'image', graph, inputs: saved.inputs, outputs: saved.outputs }
        : { ...draft.workflow, name: (body.name ?? '').replace(/\.json$/i, '').trim() },
      issues: info ? graphIssues(graph, info) : [offlineIssue()],
    };
    return c.json(result);
  });

  /** Mapping editor data for a saved workflow. */
  app.get('/api/workflows/:id/draft', async (c) => {
    const wf = workflows.get(c.req.param('id'));
    if (!wf) return c.json({ error: t('工作流不存在') }, 404);
    const info = await capabilities.objectInfo();
    const { outputCandidates } = detectWorkflow(wf.graph, info);
    const result: WorkflowDraft = {
      workflow: wf,
      fields: listFields(wf.graph, info),
      outputCandidates,
      issues: info ? graphIssues(wf.graph, info) : [offlineIssue()],
    };
    return c.json(result);
  });

  async function saveWorkflow(data: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) {
    if (!data || typeof data.graph !== 'object' || !Array.isArray(data.inputs) || !Array.isArray(data.outputs)) {
      throw new RequestError(t('工作流数据不完整'));
    }
    const problem = checkWorkflow(data);
    if (problem) throw new RequestError(problem);
    const wf = await workflows.save(data);
    capabilities.invalidate();
    return wf;
  }

  app.post('/api/workflows', async (c) => {
    const { workflow } = await c.req.json<{ workflow: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> }>();
    return c.json(await saveWorkflow({ ...workflow, id: undefined }));
  });

  app.put('/api/workflows/:id', async (c) => {
    if (!workflows.get(c.req.param('id'))) return c.json({ error: t('工作流不存在') }, 404);
    const { workflow } = await c.req.json<{ workflow: Omit<CustomWorkflow, 'id' | 'createdAt' | 'updatedAt'> }>();
    return c.json(await saveWorkflow({ ...workflow, id: c.req.param('id') }));
  });

  app.delete('/api/workflows/:id', async (c) => {
    await workflows.remove(c.req.param('id'));
    capabilities.invalidate();
    return c.json({ ok: true });
  });
}
