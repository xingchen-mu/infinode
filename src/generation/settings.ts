import type { ImageQuality, VideoQuality } from '../../shared/types';

export interface ComposerSettings {
  mode: 'image' | 'video';
  /** Built-in id ('qwen', 'zimage') or 'custom:<workflow id>'. */
  imageModel: string;
  /** Built-in id ('minimax', 'minimax-ref') or 'custom:<workflow id>'. */
  videoModel: string;
  imageAspect: string;
  videoAspect: string;
  imageQuality: ImageQuality;
  videoQuality: VideoQuality;
  count: number;
  duration: number;
  /** Last values of imported workflows' parameters: workflow id → input id → value. */
  params: Record<string, Record<string, string | number | boolean>>;
}

const COMPOSER_KEY = 'infinode:composer';
const defaultComposer: ComposerSettings = {
  mode: 'image',
  imageModel: 'qwen',
  videoModel: 'minimax',
  imageAspect: 'auto',
  videoAspect: 'auto',
  imageQuality: '1k',
  videoQuality: '480p',
  count: 1,
  duration: 5,
  params: {},
};

export function loadComposer(): ComposerSettings {
  try {
    const saved = { ...defaultComposer, ...JSON.parse(localStorage.getItem(COMPOSER_KEY) ?? '{}') } as ComposerSettings;
    // Unknown ids (e.g. a deleted workflow) fall back once the workflow list is loaded.
    if (typeof saved.imageModel !== 'string') saved.imageModel = defaultComposer.imageModel;
    if (typeof saved.videoModel !== 'string') saved.videoModel = defaultComposer.videoModel;
    if (!saved.params || typeof saved.params !== 'object') saved.params = {};
    return saved;
  } catch {
    return defaultComposer;
  }
}

export function saveComposer(composer: ComposerSettings) {
  localStorage.setItem(COMPOSER_KEY, JSON.stringify(composer));
}
