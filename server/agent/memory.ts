import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { type AgentMemory, ENTRY_CHARS, MEMORY_LIMIT, MEMORY_TYPES, type MemoryEntry, type MemoryScope, type MemoryType } from '../../shared/types.ts';
import { t } from '../i18n.ts';
import { RequestError } from '../workflows/index.ts';
import { writeJson } from './write.ts';

/**
 * Long-term memory, after the designs agents share (Letta's core memory blocks, Claude Code's CLAUDE.md and
 * ChatGPT's saved memories): small, typed entries always in context, which the assistant writes itself and
 * the user can see and edit. Two scopes: this board, and the user across boards. What is on the board
 * (scripts, shot lists, prompts) stays there; memory holds what the board does not say.
 */

const TYPE_LABEL: Record<MemoryType, string> = { setting: '设定', decision: '决定', preference: '偏好', feedback: '纠正' };

export interface MemoryOp {
  action: 'add' | 'update' | 'delete';
  scope: MemoryScope;
  id?: string;
  type?: MemoryType;
  text?: string;
  why?: string;
}

const empty = (): AgentMemory => ({ auto: true, entries: [] });
const size = (entries: MemoryEntry[]) => entries.reduce((n, e) => n + e.text.length + (e.why?.length ?? 0), 0);
const same = (a: string, b: string) => a.replace(/[\s，。,.、；;：:！!？?]/g, '') === b.replace(/[\s，。,.、；;：:！!？?]/g, '');

export class MemoryStore {
  constructor(private readonly dir: string) {}

  private file(scope: MemoryScope, projectId: string) {
    return join(this.dir, scope === 'user' ? 'memory-user.json' : `memory-board-${projectId}.json`);
  }

  async read(scope: MemoryScope, projectId: string): Promise<AgentMemory> {
    try {
      const saved = JSON.parse(await readFile(this.file(scope, projectId), 'utf8')) as Partial<AgentMemory>;
      return { auto: saved.auto !== false, entries: Array.isArray(saved.entries) ? saved.entries : [] };
    } catch {
      return empty();
    }
  }

  /** The user's own edit of a scope, from the memory page: checked like the assistant's. */
  async replace(scope: MemoryScope, projectId: string, memory: unknown): Promise<AgentMemory> {
    const given = memory as Partial<AgentMemory> | undefined;
    if (!given || !Array.isArray(given.entries)) throw new RequestError(t('请求格式错误'));
    const before = await this.read(scope, projectId);
    const now = Date.now();
    const entries = given.entries.map((e: Partial<MemoryEntry>) => {
      const text = String(e?.text ?? '').trim();
      const why = String(e?.why ?? '').trim();
      const type = MEMORY_TYPES[scope].includes(e?.type as MemoryType) ? (e!.type as MemoryType) : MEMORY_TYPES[scope][0];
      const old = before.entries.find((x) => x.id === e?.id);
      const changed = !old || old.text !== text || (old.why ?? '') !== why || old.type !== type;
      return { id: old?.id ?? `m${nanoid(6)}`, type, text, ...(why ? { why } : {}), at: changed ? now : old.at, by: changed ? 'user' : old.by } as MemoryEntry;
    });
    const filled = entries.filter((e) => e.text);
    for (const e of filled) if (e.text.length + (e.why?.length ?? 0) > ENTRY_CHARS) throw new RequestError(t('一条记忆不超过 {n} 字', { n: ENTRY_CHARS }));
    if (size(filled) > MEMORY_LIMIT[scope]) throw new RequestError(t('记忆太长了（{size}/{limit} 字），删掉或合并一些', { size: size(filled), limit: MEMORY_LIMIT[scope] }));
    const next = { auto: given.auto !== false, entries: filled };
    await writeJson(this.file(scope, projectId), () => next);
    return next;
  }

  /**
   * The assistant's changes, each applied or refused with a reason it can act on (a full memory, an unknown
   * id). An entry saying what another already says is not added twice.
   */
  async apply(projectId: string, ops: MemoryOp[]): Promise<{ done: string[]; refused: string[] }> {
    const done: string[] = [];
    const refused: string[] = [];
    for (const scope of ['board', 'user'] as const) {
      const mine = ops.filter((o) => o.scope === scope);
      if (!mine.length) continue;
      const memory = await this.read(scope, projectId);
      const where = scope === 'board' ? t('画布记忆') : t('用户偏好');
      if (!memory.auto) {
        refused.push(t('{where}：用户关掉了自动记忆，没有写入', { where }));
        continue;
      }
      const entries = [...memory.entries];
      const before = done.length;
      for (const op of mine) {
        const text = op.text?.trim() ?? '';
        const why = op.why?.trim() || undefined;
        const at = entries.findIndex((e) => e.id === op.id);
        if (op.action === 'delete') {
          if (at < 0) refused.push(t('{where}里没有 {id}', { where, id: op.id ?? '' }));
          else done.push(t('删掉了{where}「{text}」', { where, text: entries.splice(at, 1)[0].text }));
          continue;
        }
        if (!text) {
          refused.push(t('text 不能是空的'));
          continue;
        }
        if (text.length + (why?.length ?? 0) > ENTRY_CHARS) {
          refused.push(t('「{text}…」太长了：一条不超过 {n} 字，拆开或写短一些', { text: text.slice(0, 20), n: ENTRY_CHARS }));
          continue;
        }
        const type = op.type && MEMORY_TYPES[scope].includes(op.type) ? op.type : undefined;
        if (op.action === 'update') {
          if (at < 0) {
            refused.push(t('{where}里没有 {id}', { where, id: op.id ?? '' }));
            continue;
          }
          const next = { ...entries[at], text, ...(type ? { type } : {}), ...(why ? { why } : {}), at: Date.now(), by: 'assistant' as const };
          if (size(entries.map((e, i) => (i === at ? next : e))) > MEMORY_LIMIT[scope]) {
            refused.push(t('{where}满了（上限 {n} 字）：先合并或删掉不再需要的', { where, n: MEMORY_LIMIT[scope] }));
            continue;
          }
          entries[at] = next;
          done.push(t('更新了{where}「{text}」', { where, text }));
          continue;
        }
        if (entries.some((e) => same(e.text, text))) continue;
        const entry: MemoryEntry = { id: `m${nanoid(6)}`, type: type ?? MEMORY_TYPES[scope][0], text, ...(why ? { why } : {}), at: Date.now(), by: 'assistant' };
        if (size([...entries, entry]) > MEMORY_LIMIT[scope]) {
          refused.push(t('{where}满了（上限 {n} 字）：先合并或删掉不再需要的，再记「{text}」', { where, n: MEMORY_LIMIT[scope], text: text.slice(0, 20) }));
          continue;
        }
        entries.push(entry);
        done.push(t('记住了{where}「{text}」', { where, text }));
      }
      if (done.length > before) await writeJson(this.file(scope, projectId), () => ({ auto: memory.auto, entries }));
    }
    return { done, refused };
  }

  /** The board was deleted. */
  async forget(projectId: string) {
    await rm(this.file('board', projectId), { force: true });
  }
}

/** Memory as the model reads it, ids included so it can update or delete an entry. */
export function memoryBlock(board: AgentMemory, user: AgentMemory): string {
  const lines = (m: AgentMemory) => m.entries.map((e) => `- [${e.id} · ${TYPE_LABEL[e.type]}] ${e.text}${e.why ? `（${e.why}）` : ''}`);
  const section = (title: string, m: AgentMemory) =>
    [
      `### ${title}`,
      ...(m.entries.length ? lines(m) : ['（空）']),
      ...(m.auto ? [] : ['用户关掉了这部分的自动记忆：除非用户明确让你记，不要往里写。']),
    ].join('\n');
  return [
    '## 记忆',
    '下面是之前记下的，方括号里是 id。它们可能过时：和画布内容、用户最新的话冲突时，以后者为准，并用 remember 更新或删掉旧的。',
    section('用户偏好（所有画布通用，scope user）', user),
    section('这块画布（scope board）', board),
  ].join('\n');
}
