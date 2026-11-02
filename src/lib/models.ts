import { COMMERCIAL_BLOCK } from '../../shared/licenses';
import type { ImageModel, VideoModel } from '../../shared/types';

/** Why a tool cannot run, for menus and tooltips: a license block reads differently from a missing model. */
export function unavailableReason(missing: string[]): string {
  return missing.find((m) => m.startsWith(COMMERCIAL_BLOCK)) ?? `缺少：${missing.join('、')}`;
}

export interface ModelOption<T extends string> {
  id: T;
  name: string;
  desc: string;
  /** capability key used to check the server has it */
  feature: string;
}

export const IMAGE_MODELS: ModelOption<ImageModel>[] = [
  { id: 'qwen', name: 'Qwen-Image 2.1', desc: '高质量 · 擅长中文文字 · 选中图片即可参考编辑', feature: 'image.generate:qwen' },
  { id: 'zimage', name: 'Z-Image Turbo', desc: '极速出图 · 约 8 秒 · 不支持参考图', feature: 'image.generate:zimage' },
];

export const VIDEO_MODELS: ModelOption<VideoModel>[] = [
  { id: 'minimax', name: 'MiniMax H3', desc: '带原生音频 · 首帧/尾帧可选 · 模型较大，生成需要几分钟', feature: 'video.generate:minimax' },
  { id: 'minimax-ref', name: 'MiniMax H3 多图参考', desc: '最多 9 张参考图，提示词里用 @图1 引用', feature: 'video.generate:minimax-ref' },
];

export const IMAGE_ASPECTS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '21:9'];
export const VIDEO_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4'];

export const VIDEO_DURATIONS: Record<VideoModel, number[]> = {
  minimax: [3, 5, 8, 10],
  'minimax-ref': [3, 5, 8, 10],
};

export function aspectValue(aspect: string): number | null {
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  return m ? Number(m[1]) / Number(m[2]) : null;
}
