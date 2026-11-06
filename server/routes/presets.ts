import { Hono } from 'hono';
import type { PresetInfo } from '../../shared/types.ts';
import { isBlock } from '../../shared/licenses.ts';
import { graphIssues } from '../workflows/custom.ts';
import { t } from '../i18n.ts';
import type { Services } from '../services.ts';
import { FP8_NOTE } from '../comfy/capabilities.ts';

export function registerPresetsRoutes(app: Hono, { presets, comfy, capabilities }: Pick<Services, 'presets' | 'comfy' | 'capabilities'>) {
  app.get('/api/presets', async (c) => {
    const info = await capabilities.objectInfo();
    const list: PresetInfo[] = presets.list().map(({ graph, ...p }) => {
      const issues = info ? graphIssues(graph, info) : [];
      const missingFiles = [...new Set(issues.filter((i) => i.type === 'file').map((i) => i.value!))];
      const blocked = capabilities.cached()?.features[`custom:${p.id}`]?.filter((m) => m === t(FP8_NOTE) || isBlock(m)) ?? [];
      return {
        ...p,
        missing: {
          nodes: [...new Set(issues.filter((i) => i.type === 'node').map((i) => i.value!))],
          notes: blocked,
          // With a download link when the template provides one.
          models: missingFiles.map((name) => p.models.find((m) => m.name === name) ?? { name, url: '', directory: '' }),
        },
      };
    });
    return c.json(list);
  });

  /** Full preset (graph included), e.g. to copy it into "my workflows". */
  app.get('/api/presets/:id', (c) => {
    const p = presets.get(c.req.param('id'));
    return p ? c.json(p) : c.json({ error: t('模板不存在') }, 404);
  });

  /** Thumbnail from ComfyUI's bundled template package. */
  app.get('/api/presets/:id/thumb', async (c) => {
    const p = presets.get(c.req.param('id'));
    if (!p?.thumb) return c.notFound();
    const base = p.thumb.replace(/\.\w+$/, '');
    for (const name of [p.thumb, `${base}.png`, `${base}.jpg`]) {
      try {
        const res = await fetch(`${comfy.baseUrl}/templates/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) continue;
        return c.body(new Uint8Array(await res.arrayBuffer()), 200, {
          'Content-Type': res.headers.get('content-type') ?? 'image/webp',
          'Cache-Control': 'public, max-age=86400',
        });
      } catch {
        /* try the next name */
      }
    }
    return c.notFound();
  });
}
