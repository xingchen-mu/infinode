import type { CanvasItem, ImageModel, VideoModel } from '../../shared/types';
import { toast, useStore } from '../store';
import { displaySize } from '../../shared/geometry';
import { VIDEO_DURATIONS, aspectValue } from './models';
import { list, t } from '../i18n';
import { IMAGE_LONG_SIDE, VIDEO_LONG_SIDE, selectedMedia } from '../canvas/items';
import { activeWorkflow, promptOptional, runWorkflow } from '../workflows/actions';
import { launch } from './tasks';

const get = useStore.getState;

/** Selected media the composer will use, given what the current model accepts. */
export function composerReferences(): { refs: CanvasItem[]; videos: CanvasItem[]; ignored: number; needed: number } {
  const { composer } = get();
  const images = selectedMedia('image');
  const wf = activeWorkflow();
  if (wf) {
    const imageSlots = wf.inputs.filter((i) => i.type === 'image').length;
    const videoSlots = wf.inputs.filter((i) => i.type === 'video').length;
    const videos = selectedMedia('video').slice(0, videoSlots);
    return {
      refs: images.slice(0, imageSlots),
      videos,
      ignored: Math.max(0, images.length - imageSlots),
      needed: imageSlots + videoSlots,
    };
  }
  let limit: number;
  if (composer.mode === 'image') limit = composer.imageModel === 'qwen' ? 10 : 0;
  else limit = composer.videoModel === 'minimax-ref' ? 9 : 2;
  return { refs: images.slice(0, limit), videos: [], ignored: Math.max(0, images.length - limit), needed: 0 };
}
export async function generateFromComposer() {
  const { composer, prompt } = get();
  const text = prompt.trim();
  const wf = activeWorkflow();
  const { refs, videos } = composerReferences();
  if (wf) {
    if (wf.inputs.some((i) => i.type === 'mask')) {
      toast(t('这个工作流需要蒙版：选中图片后，在图片上方的「我的工具」里使用'), 'info');
      return;
    }
    if (!text && !promptOptional(wf)) {
      toast(t('先写一句提示词吧'), 'info');
      return;
    }
    const needImages = wf.inputs.filter((i) => i.type === 'image' && !i.optional);
    const needVideos = wf.inputs.filter((i) => i.type === 'video' && !i.optional);
    if (refs.length < needImages.length || videos.length < needVideos.length) {
      const parts = [
        needImages.length ? t('{n} 张图片（{list}）', { n: needImages.length, list: list(needImages.map((i) => t(i.label))) }) : '',
        needVideos.length ? t('{n} 个视频', { n: needVideos.length }) : '',
      ].filter(Boolean);
      toast(t('「{name}」需要先在画布上选中 {what}', { name: t(wf.name), what: parts.join(t(' 和 ')) }), 'info');
      return;
    }
    await runWorkflow(wf, {
      prompt: text,
      images: refs,
      videos,
      aspect: composer.mode === 'image' ? composer.imageAspect : composer.videoAspect,
      count: composer.mode === 'video' ? Math.min(2, composer.count) : composer.count,
    });
    return;
  }
  if (!text) {
    toast(t('先写一句提示词吧'), 'info');
    return;
  }
  const first = refs[0]?.asset;
  if (composer.mode === 'image') {
    const aspect = composer.imageAspect === 'auto' && !first ? '1:1' : composer.imageAspect;
    const ratio = aspectValue(aspect) ?? (first ? first.width / first.height : 1);
    await launch({
      request: {
        op: 'image.generate',
        model: composer.imageModel as ImageModel,
        prompt: text,
        aspect,
        quality: composer.imageQuality,
        images: refs.map((r) => r.asset!.id),
      },
      kind: 'image',
      count: composer.count,
      size: displaySize(ratio, 1, IMAGE_LONG_SIDE),
      inputs: refs,
    });
  } else {
    const model = composer.videoModel as VideoModel;
    if (model === 'minimax-ref' && !refs.length) {
      toast(t('多图参考需要先在画布上选中至少一张图片'), 'info');
      return;
    }
    const aspect = composer.videoAspect === 'auto' && !first ? '16:9' : composer.videoAspect;
    const ratio = aspectValue(aspect) ?? (first ? first.width / first.height : 16 / 9);
    const durations = VIDEO_DURATIONS[model];
    const duration = durations.includes(composer.duration) ? composer.duration : durations[durations.length > 1 ? 1 : 0];
    await launch({
      request: {
        op: 'video.generate',
        model,
        prompt: text,
        aspect,
        quality: composer.videoQuality,
        duration,
        images: refs.map((r) => r.asset!.id),
      },
      kind: 'video',
      count: Math.min(2, composer.count),
      size: displaySize(ratio, 1, VIDEO_LONG_SIDE),
      inputs: refs,
    });
  }
}
