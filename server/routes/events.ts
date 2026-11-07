import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentEventData, ModelDownloadJob, Task } from '../../shared/types.ts';
import type { Services } from '../services.ts';
import { isLocal } from '../http/local.ts';

export function registerEventsRoutes(
  app: Hono,
  { tasks, comfy, comfyStatus, projectEvents, agentEvents, revealEvents, downloadEvents }: Pick<Services, 'tasks' | 'comfy' | 'comfyStatus' | 'projectEvents' | 'agentEvents' | 'revealEvents' | 'downloadEvents'>,
) {
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      const onTask = (t: Task) => void send('task', t);
      const onComfy = (online: boolean) => void send('comfy', { online });
      const onProject = (e: { id: string; updatedAt: number; by: string }) => void send('project', e);
      // The agent conversation stays on this machine, like the agent itself.
      const onAgent = (e: AgentEventData) => void send('agent', e);
      const onReveal = (e: { projectId: string; ids: string[] }) => void send('reveal', e);
      const onDownload = (job: ModelDownloadJob) => void send('download', job);
      tasks.on('task', onTask);
      comfyStatus.on(onComfy);
      projectEvents.on(onProject);
      revealEvents.on(onReveal);
      downloadEvents.on(onDownload);
      if (isLocal(c)) agentEvents.on(onAgent);
      stream.onAbort(() => {
        tasks.off('task', onTask);
        comfyStatus.off(onComfy);
        projectEvents.off(onProject);
        revealEvents.off(onReveal);
        downloadEvents.off(onDownload);
        agentEvents.off(onAgent);
      });
      await send('hello', { comfyOnline: comfy.online, active: tasks.active() });
      while (!stream.aborted) {
        await stream.sleep(15_000);
        await stream.writeSSE({ event: 'ping', data: '' }).catch(() => {});
      }
    }),
  );
}
