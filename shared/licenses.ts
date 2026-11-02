// Licenses of the models behind the built-in tools and the official templates, for the commercial-use switch.
// Shared by the page (badges) and the server (enforcement). Users' own imported workflows are not listed:
// what they run is up to them. Check each model's own license text before relying on this.

import { type Translate, msg } from './i18n.ts';

export type CommercialUse = 'yes' | 'conditional' | 'no';

export interface ModelLicense {
  model: string;
  license: string;
  use: CommercialUse;
  /** Chinese source text: show it through `t`. */
  note: string;
}

const apache = (model: string): ModelLicense => ({ model, license: 'Apache 2.0', use: 'yes', note: msg('可以商用') });
const QWEN_21: ModelLicense = { model: 'Qwen-Image 2.1', license: 'Qwen Research License', use: 'no', note: msg('只允许研究和评估，商用要另外向模型方申请授权') };
const H3: ModelLicense = {
  model: 'MiniMax H3',
  license: 'MiniMax H3 Community License',
  use: 'conditional',
  note: msg('可以商用，但界面上要标明 MiniMax H3，年收入超过 2000 万美元要另外授权；不覆盖美国、欧盟、英国和韩国'),
};
const flux = (model: string): ModelLicense => ({ model, license: 'FLUX Non-Commercial License', use: 'no', note: msg('不能商用') });
const community = (model: string, license: string): ModelLicense => ({ model, license, use: 'conditional', note: msg('社区许可，商用有条件，以模型页面为准') });

/** By capability key: built-in tools (see REQUIREMENTS) and `custom:<preset id>`. */
export const LICENSES: Record<string, ModelLicense> = {
  'image.generate:qwen': QWEN_21,
  'image.inpaint': QWEN_21,
  'image.erase': QWEN_21,
  'image.outpaint': QWEN_21,
  'image.removeBg': QWEN_21,
  'image.generate:zimage': apache('Z-Image Turbo'),
  'image.upscale': apache('SeedVR2'),
  'video.generate:minimax': H3,
  'video.generate:minimax-ref': H3,
  'custom:tpl_flux-kontext': flux('FLUX.1 Kontext [dev]'),
  'custom:tpl_flux2-dev-ref': flux('FLUX.2 [dev]'),
  'custom:tpl_flux2-dev-t2i': flux('FLUX.2 [dev]'),
  'custom:tpl_flux2-klein-4b-edit': apache('FLUX.2 [klein] 4B'),
  'custom:tpl_flux2-klein-9b-t2i': flux('FLUX.2 [klein] 9B'),
  'custom:tpl_krea2-turbo': community('Krea 2', 'Krea Community License'),
  'custom:tpl_ltx2.3-flf2v': community('LTX-2.3', 'LTX-2 Community License'),
  'custom:tpl_ltx2.3-i2v': community('LTX-2.3', 'LTX-2 Community License'),
  'custom:tpl_ltx2.3-t2v': community('LTX-2.3', 'LTX-2 Community License'),
  'custom:tpl_minimax-h3-i2v': H3,
  'custom:tpl_minimax-h3-r2v': H3,
  'custom:tpl_minimax-h3-t2v': H3,
  'custom:tpl_qwen-bg-removal': QWEN_21,
  'custom:tpl_qwen-image-2.1-edit': QWEN_21,
  'custom:tpl_qwen-image-2.1-t2i': QWEN_21,
  'custom:tpl_qwen-edit-2509': apache('Qwen-Image-Edit 2509'),
  'custom:tpl_qwen-edit-2511': apache('Qwen-Image-Edit 2511'),
  'custom:tpl_qwen-image-2512': apache('Qwen-Image 2512'),
  'custom:tpl_sdxl': { model: 'SDXL', license: 'CreativeML Open RAIL++-M', use: 'conditional', note: msg('可以商用，但有使用限制条款') },
  'custom:tpl_seedvr2-image': apache('SeedVR2'),
  'custom:tpl_seedvr2-video': apache('SeedVR2'),
  'custom:tpl_wan2.2-flf2v': apache('Wan 2.2'),
  'custom:tpl_wan2.2-i2v': apache('Wan 2.2'),
  'custom:tpl_wan2.2-t2v': apache('Wan 2.2'),
  'custom:tpl_z-image-turbo': apache('Z-Image Turbo'),
};

/** Starts a missing-requirement entry that is a license block rather than a missing node or model; the capability key follows. */
export const COMMERCIAL_BLOCK = 'license:';

export const isBlock = (entry: string) => entry.startsWith(COMMERCIAL_BLOCK);

/** The entry for a capability that is off in commercial-only mode, or undefined when it may be used. */
export function commercialBlock(key: string): string | undefined {
  return LICENSES[key]?.use === 'no' ? `${COMMERCIAL_BLOCK}${key}` : undefined;
}

/** Why a blocked capability is off, e.g. "不可商用：Qwen-Image 2.1 只允许研究和评估…". */
export function blockReason(entry: string, t: Translate): string {
  const l = LICENSES[entry.slice(COMMERCIAL_BLOCK.length)];
  return l ? t(msg('不可商用：{model} {note}'), { model: l.model, note: t(l.note) }) : entry;
}

const LABELS = { yes: msg('可商用'), conditional: msg('有条件商用'), no: msg('不可商用') };

/** Short label for menus and template cards. */
export function licenseLabel(key: string, t: Translate): string | undefined {
  const l = LICENSES[key];
  return l && t(LABELS[l.use]);
}

/** "Apache 2.0: 可以商用" for a tooltip. */
export function licenseTitle(key: string, t: Translate): string | undefined {
  const l = LICENSES[key];
  return l && `${l.license}: ${t(l.note)}`;
}
