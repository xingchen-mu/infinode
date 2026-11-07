import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Task, TaskRequest } from '../shared/types.ts';
import { imageEstimate, roughly, speedNote, videoEstimate } from '../server/agent/estimate.ts';

let clock = 0;
/** A finished run that started after the previous one and took `seconds`. */
function run(request: TaskRequest, seconds: number): Task {
  clock += 1000_000;
  return { id: `t${clock}`, request, status: 'done', progress: 1, results: [], seed: 1, createdAt: clock, startedAt: clock, finishedAt: clock + seconds * 1000, expected: { kind: 'image', width: 1, height: 1 } };
}
const h3 = (seconds: number): TaskRequest => ({ op: 'video.generate', model: 'minimax', prompt: 'x', aspect: 'auto', quality: '720p', duration: seconds });
const qwen: TaskRequest = { op: 'image.generate', model: 'qwen', prompt: 'x', aspect: '1:1', quality: '1k' };

test('without history, videos use the reference GPU figures and include loading the model', () => {
  const e = videoEstimate([], '480p', [5, 5]);
  assert.equal(e.seconds, 2 * 5 * 30 + 600);
  assert.equal(e.measured, false);
});

test('with history: per-second cost from warm runs, load time from cold ones, skipped when H3 is loaded', () => {
  const history = [run(qwen, 40), run(h3(5), 900), run(h3(5), 330), run(h3(5), 340)];
  const loaded = videoEstimate(history, '720p', [5, 5]);
  assert.equal(loaded.measured, true);
  assert.equal(loaded.seconds, 2 * 5 * 67);
  const afterImages = videoEstimate([...history, run(qwen, 40)], '720p', [5]);
  assert.equal(afterImages.seconds, 5 * 67 + (900 - 5 * 67));
});

test('images take the median of similar finished runs', () => {
  assert.equal(imageEstimate([run(qwen, 30), run(qwen, 50), run(qwen, 40), run({ ...qwen, model: 'zimage' }, 8)], qwen), 40);
  assert.equal(imageEstimate([], qwen), 45);
  assert.equal(roughly(40), '约 40 秒');
  assert.equal(roughly(21 * 60), '约 21 分钟');
});

test('the speed line the assistant plans with comes from this server\'s runs', () => {
  assert.equal(speedNote([]), '这台服务器的速度（还没有足够的实测数据，按参考显卡估算）：qwen 出一张 1k 图约 45 秒；MiniMax H3 一段 5 秒的视频，480p 约 3 分钟、720p 约 6 分钟，GPU 刚跑过别的模型时，第一段另加约 10 分钟加载模型。');
  const sd = (seconds: number): TaskRequest => ({ op: 'video.generate', model: 'minimax', prompt: 'x', aspect: 'auto', quality: '480p', duration: seconds });
  // Warm 480p clips at 31 s per second of video, then H3 still loaded: no load time to add.
  const note = speedNote([run(qwen, 38), run(qwen, 42), run(sd(5), 700), run(sd(5), 150), run(sd(5), 160)]);
  assert.match(note, /^这台服务器的速度（按以往任务实测）：qwen 出一张 1k 图约 40 秒；MiniMax H3 一段 5 秒的视频，480p 约 3 分钟、/);
  assert.ok(!note.includes('加载模型'), note);
});
