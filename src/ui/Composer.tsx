import { ArrowUp, Clapperboard, Clock, Copy, Image as ImageIcon, Layers, Loader2, Ratio, SlidersHorizontal, Sparkle, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { blockReason, isBlock, licenseLabel } from '../../shared/licenses';
import { thumbUrl } from '../../shared/media';
import type { WorkflowInput, WorkflowLike } from '../../shared/types';
import { activeWorkflow, composerReferences, generateFromComposer, promptOptional } from '../lib/actions';
import { IMAGE_ASPECTS, IMAGE_MODELS, VIDEO_ASPECTS, VIDEO_DURATIONS, VIDEO_MODELS, unavailableReason } from '../lib/models';
import { select, setComposer, useStore } from '../store';
import { Dropdown, type DropdownOption } from './Dropdown';
import { list, t } from '../i18n';

const MANAGE = '__manage';
const BROWSE = '__presets';

function AspectIcon({ aspect }: { aspect: string }) {
  const m = /^(\d+):(\d+)$/.exec(aspect);
  const r = m ? Number(m[1]) / Number(m[2]) : 1;
  const w = r >= 1 ? 14 : 14 * r;
  const h = r >= 1 ? 14 / r : 14;
  return (
    <span className="aspect-icon">
      <span style={{ width: w, height: h }} />
    </span>
  );
}

function missingText(feature: string) {
  const { caps } = useStore.getState();
  if (!caps) return undefined;
  if (!caps.comfyOnline) return t('ComfyUI 未连接');
  const m = caps.features[feature];
  return m && m.length ? unavailableReason(m, true) : undefined;
}

const PARAM_TYPES = new Set(['number', 'text', 'select', 'boolean']);

/** Exposed parameters of an imported workflow; values persist per workflow. */
function ParamsButton({ wf }: { wf: WorkflowLike }) {
  const params = wf.inputs.filter((i) => PARAM_TYPES.has(i.type));
  const values = useStore((s) => s.composer.params[wf.id]) ?? {};
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  if (!params.length) return null;
  const setValue = (inp: WorkflowInput, v: string | number | boolean) => {
    const all = useStore.getState().composer.params;
    setComposer({ params: { ...all, [wf.id]: { ...(all[wf.id] ?? {}), [inp.id]: v } } });
  };
  const changed = params.filter((p) => values[p.id] !== undefined && values[p.id] !== p.default).length;
  return (
    <div className="dd" ref={ref}>
      <button className={`dd-btn ${open ? 'open' : ''}`} onClick={() => setOpen((v) => !v)} title={t('工作流参数')}>
        <SlidersHorizontal />
        <span>{t('参数')}{changed ? ` · ${changed}` : ''}</span>
      </button>
      {open && (
        <div className="dd-menu params-menu" data-scrollable>
          {params.map((p) => {
            const v = values[p.id] ?? p.default;
            return (
              <label key={p.id} className="param-row">
                <span className="param-label">{t(p.label)}</span>
                {p.type === 'boolean' ? (
                  <input type="checkbox" checked={Boolean(v)} onChange={(e) => setValue(p, e.target.checked)} />
                ) : p.type === 'select' ? (
                  <select value={String(v ?? '')} onChange={(e) => setValue(p, e.target.value)}>
                    {(p.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : p.type === 'number' ? (
                  <input
                    type="number"
                    value={v === undefined ? '' : Number(v)}
                    min={p.min}
                    max={p.max}
                    step={p.step ?? 'any'}
                    onChange={(e) => e.target.value !== '' && setValue(p, Number(e.target.value))}
                  />
                ) : (
                  <input type="text" value={String(v ?? '')} onChange={(e) => setValue(p, e.target.value)} />
                )}
              </label>
            );
          })}
          <button className="param-reset" onClick={() => setComposer({ params: { ...useStore.getState().composer.params, [wf.id]: {} } })}>
            {t('恢复默认')}
          </button>
        </div>
      )}
    </div>
  );
}

export function Composer() {
  const composer = useStore((s) => s.composer);
  const prompt = useStore((s) => s.prompt);
  const items = useStore((s) => s.items);
  const selection = useStore((s) => s.selection);
  const caps = useStore((s) => s.caps);
  const workflows = useStore((s) => s.workflows);
  const presets = useStore((s) => s.presets);
  const pendingOutput = useStore((s) => s.pendingOutput);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const isImage = composer.mode === 'image';

  // Recomputed when selection/items/workflows change.
  void items;
  void selection;
  void workflows;
  void presets;
  const wf = activeWorkflow();
  const { refs, videos, ignored } = composerReferences();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(180, el.scrollHeight)}px`;
  }, [prompt, composer.mode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea, [contenteditable]')) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const modelId = isImage ? composer.imageModel : composer.videoModel;
  const feature = wf
    ? `custom:${wf.id}`
    : isImage
      ? (IMAGE_MODELS.find((m) => m.id === composer.imageModel) ?? IMAGE_MODELS[0]).feature
      : (VIDEO_MODELS.find((m) => m.id === composer.videoModel) ?? VIDEO_MODELS[0]).feature;
  void caps;
  const missing = missingText(feature);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await generateFromComposer();
      useStore.setState({ prompt: '' });
    } finally {
      setBusy(false);
    }
  };

  const insertRef = (n: number) => {
    const el = ref.current;
    const tag = t('@图{n} ', { n });
    if (!el) return;
    const start = el.selectionStart ?? prompt.length;
    const end = el.selectionEnd ?? prompt.length;
    const next = prompt.slice(0, start) + tag + prompt.slice(end);
    useStore.setState({ prompt: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + tag.length, start + tag.length);
    });
  };

  const imageSlots = wf?.inputs.filter((i) => i.type === 'image') ?? [];
  const refLabel = (i: number) => {
    if (wf) return imageSlots[i] ? t(imageSlots[i].label) : t('图{n}', { n: i + 1 });
    if (isImage || composer.videoModel === 'minimax-ref') return t('图{n}', { n: i + 1 });
    return i === 0 ? t('首帧') : t('尾帧');
  };

  const kind = isImage ? 'image' : 'video';
  const builtins: DropdownOption<string>[] = (isImage ? IMAGE_MODELS : VIDEO_MODELS).map((m) => {
    const miss = caps?.features[m.feature];
    const license = licenseLabel(m.feature, t);
    // A license block holds whether or not ComfyUI is reachable.
    const block = miss?.find(isBlock);
    const blocked = block && blockReason(block, t);
    return {
      value: m.id,
      label: m.name,
      desc: blocked ?? (miss?.length && caps?.comfyOnline ? unavailableReason(miss) : `${m.desc}${license ? ` · ${license}` : ''}`),
      disabled: Boolean(blocked || (caps?.comfyOnline && miss?.length)),
      section: t('内置'),
    };
  });
  const mine: DropdownOption<string>[] = workflows
    .filter((w) => w.kind === kind)
    .map((w) => {
      const miss = caps?.features[`custom:${w.id}`];
      const slots = w.inputs.filter((i) => i.type === 'image' || i.type === 'video').length;
      return {
        value: `custom:${w.id}`,
        label: t(w.name),
        desc:
          miss?.length && caps?.comfyOnline
            ? unavailableReason(miss)
            : [w.description ? t(w.description) : slots ? t('需要 {n} 个输入素材', { n: slots }) : t('文生'), t('我导入的工作流')].join(' · '),
        section: t('我的工作流'),
      };
    });
  // Presets this ComfyUI can run; the rest live in the template gallery.
  const ready: DropdownOption<string>[] = presets
    .filter((p) => p.kind === kind && caps?.comfyOnline && !(caps.features[`custom:${p.id}`]?.length))
    .map((p) => {
      const license = licenseLabel(`custom:${p.id}`, t);
      return { value: `custom:${p.id}`, label: t(p.name), desc: [p.description && t(p.description), license].filter(Boolean).join(' · '), section: t('官方模板') };
    });
  const modelOptions: DropdownOption<string>[] = [
    ...builtins,
    { value: BROWSE, label: t('浏览模板库（{n} 个官方模板）…', { n: presets.length }), action: true, section: t('官方模板') },
    ...ready,
    ...mine,
    { value: MANAGE, label: t('导入 / 管理工作流…'), action: true, section: t('我的工作流') },
  ];

  const hasSize = wf ? wf.inputs.some((i) => i.type === 'width') : true;
  const aspect = isImage ? composer.imageAspect : composer.videoAspect;
  const hasRef = refs.length > 0 && (wf || isImage || composer.videoModel !== 'minimax-ref');
  const autoLabel = wf ? (hasRef ? t('跟随输入图') : t('工作流默认')) : isImage ? t('跟随参考图') : t('跟随首帧');
  const aspectOptions: DropdownOption<string>[] = [
    { value: 'auto', label: autoLabel, desc: wf ? undefined : hasRef ? undefined : isImage ? t('没有参考图时为 1:1') : t('没有首帧时为 16:9') },
    ...(isImage ? IMAGE_ASPECTS : VIDEO_ASPECTS).map((a) => ({ value: a, label: a })),
  ];
  const aspectDisplay = aspect === 'auto' ? (hasRef ? t('自动') : wf ? t('默认') : isImage ? '1:1' : '16:9') : aspect;
  const durations = !wf && !isImage ? VIDEO_DURATIONS[composer.videoModel as keyof typeof VIDEO_DURATIONS] ?? VIDEO_DURATIONS.minimax : [];
  const duration = durations.includes(composer.duration) ? composer.duration : durations[Math.min(1, durations.length - 1)];

  let hint = '';
  const linking = Boolean(pendingOutput && refs.some((r) => r.id === pendingOutput.from));
  if (linking) hint = t('结果会生成在连线终点的虚线框里（Esc 取消）');
  else if (wf && refs.length + videos.length < imageSlots.length + wf.inputs.filter((i) => i.type === 'video').length) {
    const need = wf.inputs.filter((i) => i.type === 'image' || i.type === 'video').map((i) => t(i.label));
    hint = t('「{name}」需要输入：{list}（在画布上按顺序选中）', { name: t(wf.name), list: list(need) });
  } else if (isImage && composer.imageModel === 'zimage' && ignored) hint = t('Z-Image 不支持参考图，选中的图片会被忽略');
  else if (ignored) hint = t('只使用前 {n} 张选中的图片', { n: refs.length });
  else if (!wf && !isImage && composer.videoModel === 'minimax-ref' && !refs.length) hint = t('先在画布上选中参考图（可多选）');

  const placeholder = wf
    ? wf.inputs.some((i) => i.type === 'prompt')
      ? promptOptional(wf)
        ? t('提示词（留空则用工作流里的默认提示词）')
        : t('输入提示词')
      : t('这个工作流不需要提示词，直接点生成')
    : isImage
      ? refs.length
        ? t('描述要怎么改，例如：把 @图1 的背景换成雪山，保持人物不变')
        : t('描述你想生成的画面，例如：一张秋日咖啡店海报，暖色调，写着“秋日限定”')
      : composer.videoModel === 'minimax-ref'
        ? t('描述视频，用 @图1、@图2 指代参考图，例如：@图1 的女孩在 @图2 的街道上奔跑')
        : refs.length
          ? t('描述画面如何运动，例如：镜头缓缓推进，人物转身微笑')
          : t('描述视频画面、动作和声音，例如：海浪拍打礁石，海鸥鸣叫');

  const canSubmit = !busy && !missing && (wf ? Boolean(prompt.trim()) || promptOptional(wf) : Boolean(prompt.trim()));

  return (
    <div className="panel composer" data-ui>
      {refs.length + videos.length > 0 && (
        <div className="refs">
          {[...refs, ...videos].map((r, i) => (
            <div key={r.id} className="ref" title={!wf && (isImage || composer.videoModel === 'minimax-ref') ? t('点击插入 @图{n}', { n: i + 1 }) : refLabel(i)}>
              <button className="ref-thumb" onClick={() => !wf && insertRef(i + 1)}>
                <img src={thumbUrl(r.asset!.url)} alt="" />
                <span className="ref-label">{r.kind === 'video' ? t('视频') : refLabel(i)}</span>
              </button>
              <button className="ref-x" title={t('不使用这个')} onClick={() => select([r.id], 'toggle')}>
                <X />
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        id="composer-input"
        ref={ref}
        rows={2}
        value={prompt}
        placeholder={placeholder}
        onChange={(e) => useStore.setState({ prompt: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSubmit) void submit();
          }
        }}
      />
      {hint && <div className={`composer-hint ${linking ? 'link' : ''}`}>{hint}</div>}
      <div className="composer-bar">
        <div className="seg mode-seg">
          <button className={isImage ? 'on' : ''} onClick={() => setComposer({ mode: 'image' })}>
            <ImageIcon /> {t('图片')}
          </button>
          <button className={!isImage ? 'on' : ''} onClick={() => setComposer({ mode: 'video' })}>
            <Clapperboard /> {t('视频')}
          </button>
        </div>
        <Dropdown
          value={modelId}
          options={modelOptions}
          wide
          icon={<Sparkle />}
          display={wf?.name ?? builtins.find((b) => b.value === modelId)?.label}
          onChange={(v) => {
            if (v === MANAGE) return useStore.setState({ modal: { type: 'workflows' } });
            if (v === BROWSE) return useStore.setState({ modal: { type: 'presets' } });
            setComposer(isImage ? { imageModel: v } : { videoModel: v });
          }}
        />
        {hasSize && (
          <Dropdown
            value={aspect}
            options={aspectOptions}
            icon={aspect === 'auto' ? <Ratio /> : <AspectIcon aspect={aspect} />}
            display={aspectDisplay}
            title={t('画面比例')}
            onChange={(v) => setComposer(isImage ? { imageAspect: v } : { videoAspect: v })}
          />
        )}
        {wf ? (
          <ParamsButton wf={wf} />
        ) : isImage ? (
          <Dropdown
            value={composer.imageQuality}
            options={[
              { value: '1k', label: '1K', desc: t('约 100 万像素') },
              { value: '2k', label: '2K', desc: composer.imageModel === 'qwen' ? t('约 400 万像素，耗时约 4 倍') : t('约 230 万像素') },
            ]}
            title={t('分辨率')}
            onChange={(v) => setComposer({ imageQuality: v })}
          />
        ) : (
          <>
            <Dropdown
              value={composer.videoQuality}
              options={[
                { value: '480p', label: '480P', desc: t('速度快') },
                { value: '720p', label: '768P', desc: t('原生分辨率，更清晰，耗时约 2.5 倍') },
              ]}
              title={t('分辨率')}
              onChange={(v) => setComposer({ videoQuality: v })}
            />
            <Dropdown
              value={duration}
              options={durations.map((d) => ({ value: d, label: t('{n} 秒', { n: d }) }))}
              icon={<Clock />}
              title={t('时长')}
              onChange={(v) => setComposer({ duration: v })}
            />
          </>
        )}
        <Dropdown
          value={isImage ? composer.count : Math.min(2, composer.count)}
          options={(isImage ? [1, 2, 3, 4] : [1, 2]).map((n) => ({ value: n, label: t(isImage ? '{n} 张' : '{n} 条', { n }) }))}
          icon={composer.count > 1 ? <Layers /> : <Copy />}
          title={t('数量')}
          onChange={(v) => setComposer({ count: v })}
        />
        <div className="grow" />
        <button className="gen-btn" disabled={!canSubmit} title={missing ?? t('生成（Enter）')} onClick={() => void submit()}>
          {busy ? <Loader2 className="spin" /> : <ArrowUp />}
        </button>
      </div>
    </div>
  );
}
