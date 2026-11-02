import { spawn } from 'node:child_process';
import sharp from 'sharp';

/** Runs a command; resolves with stdout (or stderr, where ffmpeg filters report), rejects with the tail of stderr. */
function exec(cmd: string, args: string[], signal?: AbortSignal, want: 'stdout' | 'stderr' = 'stdout'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => want === 'stdout' && out.push(d));
    p.stderr.on('data', (d: Buffer) => {
      if (want === 'stderr') out.push(d);
      err = (err + d.toString()).slice(-4000);
    });
    p.on('error', (e) => reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`找不到 ${cmd}：剪辑和看视频需要安装 ffmpeg（macOS：brew install ffmpeg）`) : e));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} 出错：${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
}

export async function probe(path: string): Promise<VideoInfo> {
  const json = JSON.parse(
    (await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', path])).toString(),
  ) as { streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[]; format: { duration?: string } };
  const video = json.streams.find((s) => s.codec_type === 'video');
  const [num, den] = (video?.r_frame_rate ?? '24/1').split('/').map(Number);
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    duration: Number(json.format.duration) || 0,
    fps: num && den ? num / den : 24,
    hasAudio: json.streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * Stretches where the sound clearly stands out: in generated shots that is mostly dialogue, since the
 * ambience stays far quieter (H3 ambience sits around -40 dB, speech around -20 dB).
 */
export async function soundSpans(path: string, duration: number, threshold = -28): Promise<{ start: number; end: number }[]> {
  const log = (await exec('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', `silencedetect=n=${threshold}dB:d=0.25`, '-f', 'null', '-'], undefined, 'stderr')).toString();
  const spans: { start: number; end: number }[] = [];
  let soundFrom = 0;
  for (const m of log.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    const t = Number(m[2]);
    if (m[1] === 'start') {
      if (t - soundFrom >= 0.15) spans.push({ start: soundFrom, end: t });
    } else soundFrom = t;
  }
  // Sound runs to the end unless the last silence did.
  const lastStart = [...log.matchAll(/silence_start: ([\d.]+)/g)].at(-1);
  const lastEnd = [...log.matchAll(/silence_end: ([\d.]+)/g)].at(-1);
  const openSilence = lastStart && (!lastEnd || Number(lastStart[1]) > Number(lastEnd[1]));
  if (!openSilence && duration - soundFrom >= 0.15) spans.push({ start: soundFrom, end: duration });
  return spans.map((s) => ({ start: Math.round(s.start * 100) / 100, end: Math.round(Math.min(s.end, duration) * 100) / 100 }));
}

/** One frame of a video as PNG. */
export async function videoFrame(path: string, at: number): Promise<Buffer> {
  return exec('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, at)), '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']);
}

/**
 * Numbered thumbnails on one JPEG, so a model can review a whole batch in one image.
 * At most 4 per row and 1920 px wide, which vision models take without downscaling much.
 */
export async function contactSheet(images: (Buffer | string)[]): Promise<Buffer> {
  const cols = Math.min(4, images.length);
  const rows = Math.ceil(images.length / cols);
  const cellW = cols <= 2 ? 720 : 480;
  // Cells take the median shape, so a mixed batch wastes the least space.
  const ratios = (await Promise.all(images.map((img) => sharp(img).metadata()))).map((m) => (m.height ?? 9) / (m.width ?? 16)).sort((a, b) => a - b);
  const cellH = Math.round(Math.min(1.4, Math.max(0.5, ratios[Math.floor(ratios.length / 2)])) * cellW);
  const gap = 8;
  const tiles = await Promise.all(
    images.map(async (img, i) => {
      const label = Buffer.from(
        `<svg width="${cellW}" height="${cellH}"><rect x="8" y="8" rx="8" width="${String(i + 1).length * 18 + 22}" height="40" fill="rgba(0,0,0,0.72)"/>` +
          `<text x="19" y="37" font-size="28" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="#ffffff">${i + 1}</text></svg>`,
      );
      const tile = await sharp(img)
        .resize(cellW, cellH, { fit: 'contain', background: '#141518' })
        .composite([{ input: label }])
        .png()
        .toBuffer();
      return { input: tile, left: (i % cols) * (cellW + gap), top: Math.floor(i / cols) * (cellH + gap) };
    }),
  );
  return sharp({ create: { width: cols * cellW + (cols - 1) * gap, height: rows * cellH + (rows - 1) * gap, channels: 3, background: '#0e0f11' } })
    .composite(tiles)
    .jpeg({ quality: 82 })
    .toBuffer();
}

export interface Clip {
  path: string;
  /** Seconds into the clip; whole clip when omitted. */
  start?: number;
  end?: number;
}

/**
 * Joins clips in order into one H.264/AAC MP4, trimming each, at the first clip's size and frame rate.
 * Clips without sound get silence, so the audio stays in step.
 */
export async function concatClips(clips: Clip[], out: string, signal?: AbortSignal): Promise<VideoInfo> {
  const infos = await Promise.all(clips.map((c) => probe(c.path)));
  const W = infos[0].width - (infos[0].width % 2);
  const H = infos[0].height - (infos[0].height % 2);
  const fps = Math.round(infos[0].fps * 1000) / 1000;
  const args = ['-v', 'error', '-y'];
  const graph: string[] = [];
  const pairs: string[] = [];
  let input = 0;
  let total = 0;
  clips.forEach((c, i) => {
    const info = infos[i];
    const start = Math.max(0, Math.min(c.start ?? 0, info.duration));
    const end = Math.min(info.duration, c.end ?? info.duration);
    if (end - start < 0.1) throw new Error(`第 ${i + 1} 段裁剪后没有内容（${start}–${end} 秒，片长 ${info.duration.toFixed(2)} 秒）`);
    total += end - start;
    const v = input++;
    args.push('-i', c.path);
    graph.push(
      `[${v}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
    if (info.hasAudio) {
      graph.push(`[${v}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    } else {
      const a = input++;
      args.push('-f', 'lavfi', '-t', String(end - start), '-i', 'anullsrc=r=48000:cl=stereo');
      graph.push(`[${a}:a]asetpts=PTS-STARTPTS[a${i}]`);
    }
    pairs.push(`[v${i}][a${i}]`);
  });
  graph.push(`${pairs.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`);
  args.push('-filter_complex', graph.join(';'), '-map', '[v]', '-map', '[a]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out);
  await exec('ffmpeg', args, signal);
  return { width: W, height: H, duration: total, fps, hasAudio: true };
}
