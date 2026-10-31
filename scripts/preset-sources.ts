// Official ComfyUI templates offered as ready-made canvas tools (built by scripts/build-presets.ts).
//
// set     fixes template values before export: node title → its `value`, or "<nodeId>.<field>" → value.
//         Fixed switches are then resolved and unused branches dropped.
// inputs  overrides detected inputs by id (label, type, optional…). Detected parameters that are
//         not listed here are not exposed, so presets stay simple.
// add     exposes extra fields by API node id.
import type { WorkflowInput } from '../shared/types.ts';

export interface PresetSource {
  template: string;
  id: string;
  name: string;
  description: string;
  category: '图片生成' | '图片编辑' | '视频生成' | '工具';
  set?: Record<string, unknown>;
  drop?: string[];
  inputs?: Record<string, Partial<WorkflowInput>>;
  add?: WorkflowInput[];
  keepParams?: boolean;
}

const duration = (min: number, max: number): Partial<WorkflowInput> => ({ label: '时长（秒）', min, max, step: 1 });
const size: Record<string, Partial<WorkflowInput>> = { p_width: { type: 'width', label: '宽' }, p_height: { type: 'height', label: '高' } };
const megapixels = (node: string, def: number, max: number): WorkflowInput => ({
  id: 'megapixels',
  type: 'number',
  node,
  field: 'megapixels',
  label: '清晰度（百万像素）',
  default: def,
  min: 0.2,
  max,
  step: 0.1,
});

export const PRESET_SOURCES: PresetSource[] = [
  // ---------------------------------------------------------------- image generation
  {
    template: 'image_qwen_image_2_1_t2i',
    id: 'qwen-image-2.1-t2i',
    name: 'Qwen Image 2.1 文生图',
    category: '图片生成',
    description: '通义千问 2.1，中文文字和海报排版出色',
    add: [megapixels('13', 1, 4)],
  },
  { template: 'image_z_image_turbo', id: 'z-image-turbo', name: 'Z-Image Turbo 文生图', category: '图片生成', description: '8 步极速出图，写实人像好' },
  {
    template: 'image_krea2_turbo_t2i',
    id: 'krea2-turbo',
    name: 'Krea 2 Turbo 文生图',
    category: '图片生成',
    description: '自带提示词扩写，审美风格强',
    add: [megapixels('49', 1, 4)],
  },
  { template: 'image_flux2_text_to_image_9b', id: 'flux2-klein-9b-t2i', name: 'Flux.2 Klein 9B 文生图', category: '图片生成', description: 'Flux.2 轻量版，显存要求较低', inputs: size },
  { template: 'image_flux2_text_to_image', id: 'flux2-dev-t2i', name: 'Flux.2 Dev 文生图', category: '图片生成', description: 'Flux.2 Dev 高质量文生图（模型较大）' },
  { template: 'image_qwen_Image_2512', id: 'qwen-image-2512', name: 'Qwen-Image 2512 文生图', category: '图片生成', description: 'Qwen-Image 2512 版' },
  { template: 'image_sdxl_simple', id: 'sdxl', name: 'SDXL 文生图', category: '图片生成', description: '经典 SDXL，8G 显存可用' },
  // ---------------------------------------------------------------- image editing
  {
    template: 'image_qwen_image_2_1_image_edit',
    id: 'qwen-image-2.1-edit',
    name: 'Qwen Image 2.1 图片编辑',
    category: '图片编辑',
    description: '一句话改图；可再选一张作参考，提示词里用 <image1> <image2> 指代',
    inputs: { image1: { label: '原图' }, image2: { label: '参考图', optional: true } },
  },
  { template: 'image_qwen_image_edit_2511_int8', id: 'qwen-edit-2511', name: 'Qwen Image Edit 2511', category: '图片编辑', description: 'Qwen 图片编辑 2511', inputs: { image1: { label: '原图' } } },
  { template: 'image_qwen_image_edit_2509', id: 'qwen-edit-2509', name: 'Qwen-Image-Edit 2509', category: '图片编辑', description: 'Qwen 图片编辑 2509（4 步加速）', inputs: { image1: { label: '原图' } } },
  { template: 'image_flux2_klein_image_edit_4b_distilled', id: 'flux2-klein-4b-edit', name: 'Flux.2 Klein 4B 图片编辑', category: '图片编辑', description: '轻量快速的 Flux.2 改图', inputs: { image1: { label: '原图' } } },
  { template: 'flux_kontext_dev_basic', id: 'flux-kontext', name: 'Flux.1 Kontext 图片编辑', category: '图片编辑', description: 'Flux.1 Kontext Dev 指令改图', inputs: { image1: { label: '原图' } } },
  { template: 'image_flux2', id: 'flux2-dev-ref', name: 'Flux.2 Dev 参考图生成', category: '图片编辑', description: '以参考图为条件生成新图', inputs: { image1: { label: '参考图' } } },
  // ---------------------------------------------------------------- tools
  {
    template: 'image_qwen_image_2_1_background_removal',
    id: 'qwen-bg-removal',
    name: 'Qwen Image 2.1 抠图',
    category: '工具',
    description: '去除背景，输出透明 PNG',
    drop: ['prompt', 'negative'],
    inputs: { image1: { label: '原图' } },
  },
  {
    template: 'utility_seedvr2_7b_int8_upscale_image',
    id: 'seedvr2-image',
    name: 'SeedVR2 图片超清',
    category: '工具',
    description: 'SeedVR2 7B 一步超分，修复细节',
    inputs: { image1: { label: '原图' } },
    add: [{ id: 'scale', type: 'number', node: '66:57', field: 'resize_type.multiplier', label: '放大倍数', default: 2, min: 1, max: 4, step: 0.5 }],
  },
  { template: 'utility_seedvr2_3b_int8_upscale_video', id: 'seedvr2-video', name: 'SeedVR2 视频超清', category: '工具', description: 'SeedVR2 3B 视频超分', inputs: { video1: { label: '原视频' } } },
  // ---------------------------------------------------------------- video
  {
    template: 'video_minimax_h3_i2v',
    id: 'minimax-h3-i2v',
    name: 'MiniMax H3 图生视频',
    category: '视频生成',
    description: '首帧生成带音频的视频（8 步加速）',
    set: { 'Boolean (Enable Lightning LoRA)': true },
    inputs: { image1: { label: '首帧' }, p_duration: duration(2, 15) },
    add: [megapixels('115', 0.4, 1)],
  },
  {
    template: 'video_minimax_h3_t2v',
    id: 'minimax-h3-t2v',
    name: 'MiniMax H3 文生视频',
    category: '视频生成',
    description: '文字生成带音频的视频（8 步加速）',
    set: { 'Boolean (Enable Lightning LoRA)': true },
    inputs: { p_duration: duration(2, 15) },
    add: [megapixels('115', 0.4, 1)],
  },
  {
    template: 'video_minimax_h3_r2v',
    id: 'minimax-h3-r2v',
    name: 'MiniMax H3 参考生视频',
    category: '视频生成',
    description: '用参考图锁定人物/物体，提示词里用 <Picture 1> <Picture 2> 指代',
    set: { 'Boolean (Enable Lightning LoRA)': true },
    inputs: { image1: { label: '参考图1' }, image2: { label: '参考图2', optional: true }, p_duration: duration(2, 15) },
    add: [megapixels('115', 0.4, 1)],
  },
  { template: 'video_ltx2_3_i2v', id: 'ltx2.3-i2v', name: 'LTX-2.3 图生视频', category: '视频生成', description: 'LTX-2.3 图生视频（带音频）', inputs: { image1: { label: '首帧' }, p_duration: duration(2, 10), ...size } },
  { template: 'video_ltx2_3_t2v', id: 'ltx2.3-t2v', name: 'LTX-2.3 文生视频', category: '视频生成', description: 'LTX-2.3 文生视频（带音频）', drop: ['width', 'height'], inputs: { p_duration: duration(2, 10), ...size } },
  {
    template: 'video_ltx2_3_flf2v',
    id: 'ltx2.3-flf2v',
    name: 'LTX-2.3 首尾帧视频',
    category: '视频生成',
    description: '给定首帧和尾帧生成中间的过渡',
    inputs: { image1: { label: '首帧' }, image2: { label: '尾帧' }, p_duration: duration(2, 10), ...size },
  },
  {
    template: 'video_wan2_2_14B_i2v',
    id: 'wan2.2-i2v',
    name: 'Wan 2.2 图生视频',
    category: '视频生成',
    description: 'Wan 2.2 14B 图生视频（4 步加速）',
    set: { 'Enable 4steps LoRA?': true },
    inputs: { image1: { label: '首帧' }, p_duration: duration(1, 6) },
  },
  {
    template: 'video_wan2_2_14B_t2v',
    id: 'wan2.2-t2v',
    name: 'Wan 2.2 文生视频',
    category: '视频生成',
    description: 'Wan 2.2 14B 文生视频（4 步加速）',
    set: { 'Enable Lightning LoRA': true },
    inputs: { p_duration: duration(1, 6) },
  },
  {
    template: 'video_wan2_2_14B_flf2v',
    id: 'wan2.2-flf2v',
    name: 'Wan 2.2 首尾帧视频',
    category: '视频生成',
    description: 'Wan 2.2 14B 首尾帧生成过渡视频',
    inputs: { image1: { label: '首帧' }, image2: { label: '尾帧' } },
  },
];
