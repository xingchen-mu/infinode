import type { Task, TaskRequest } from '../../shared/types.ts';
import { t } from '../i18n.ts';

/** GPU seconds per second of MiniMax H3 video, and the extra for loading it, measured on the reference GPU. */
const H3_DEFAULT = { '480p': { perSecond: 30, warmup: 600 }, '720p': { perSecond: 66, warmup: 600 } } as const;
const IMAGE_DEFAULT = 45;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

type VideoRequest = Extract<TaskRequest, { op: 'video.generate' }>;

const isH3 = (r: TaskRequest): r is VideoRequest => r.op === 'video.generate' && (r.model === 'minimax' || r.model === 'minimax-ref');
const took = (t: Task) => ((t.finishedAt ?? 0) - (t.startedAt ?? 0)) / 1000;

/** Finished runs with timings, oldest first. */
function finished(history: Task[]) {
  return history.filter((t) => t.status === 'done' && t.startedAt && t.finishedAt && t.finishedAt > t.startedAt).sort((a, b) => a.startedAt! - b.startedAt!);
}

/**
 * GPU time for H3 clips of these lengths, from this server's own history when it has some: runs that
 * followed another H3 run give the per-second cost, runs that followed something else give the cost of
 * loading the model, which is added unless the last thing the GPU ran was H3.
 */
export function videoEstimate(history: Task[], quality: '480p' | '720p', clips: number[]): { seconds: number; measured: boolean } {
  const done = finished(history);
  const warm: Task[] = [];
  const cold: Task[] = [];
  done.forEach((t, i) => {
    if (!isH3(t.request) || t.request.quality !== quality) return;
    const before = done[i - 1];
    (before && isH3(before.request) ? warm : cold).push(t);
  });
  const length = (t: Task) => (t.request as VideoRequest).duration;
  const perSecond = warm.length ? median(warm.map((t) => took(t) / length(t))) : H3_DEFAULT[quality].perSecond;
  const warmup = cold.length ? Math.max(0, median(cold.map((t) => took(t) - perSecond * length(t)))) : H3_DEFAULT[quality].warmup;
  const last = done.at(-1);
  const loaded = Boolean(last && isH3(last.request));
  return { seconds: clips.reduce((n, s) => n + s * perSecond, 0) + (loaded ? 0 : warmup), measured: warm.length >= 2 };
}

/** Typical seconds for one image like this, from finished runs of the same kind here. */
export function imageEstimate(history: Task[], request: TaskRequest): number {
  const same = (r: TaskRequest) =>
    r.op === request.op && ('model' in r ? r.model : undefined) === ('model' in request ? request.model : undefined) && ('quality' in r ? r.quality : undefined) === ('quality' in request ? request.quality : undefined);
  const runs = finished(history).filter((t) => same(t.request));
  return runs.length ? Math.round(median(runs.slice(-20).map(took))) : IMAGE_DEFAULT;
}

/** "约 12 分钟" / "约 40 秒" (in the server's language). */
export function roughly(seconds: number): string {
  return seconds >= 90 ? t('约 {n} 分钟', { n: Math.round(seconds / 60) }) : t('约 {n} 秒', { n: Math.max(5, Math.round(seconds / 5) * 5) });
}

/**
 * This server's speeds in one line, for the model to plan with instead of guessing: it said "1.5–2.5
 * hours" for ten clips from the prompt's old rule of thumb, while the approval card measured 35 minutes.
 */
export function speedNote(history: Task[]): string {
  const image = imageEstimate(history, { op: 'image.generate', model: 'qwen', quality: '1k' } as TaskRequest);
  const clip = (quality: '480p' | '720p') => {
    const one = videoEstimate(history, quality, [5]);
    const per = videoEstimate(history, quality, [5, 5]).seconds - one.seconds;
    return { per, load: one.seconds - per, measured: one.measured };
  };
  const [sd, hd] = [clip('480p'), clip('720p')];
  return (
    `这台服务器的速度（${sd.measured ? '按以往任务实测' : '还没有足够的实测数据，按参考显卡估算'}）：qwen 出一张 1k 图${roughly(image)}；` +
    `MiniMax H3 一段 5 秒的视频，480p ${roughly(sd.per)}、720p ${roughly(hd.per)}` +
    (sd.load > 0 ? `，GPU 刚跑过别的模型时，第一段另加${roughly(sd.load)}加载模型。` : '。')
  );
}
