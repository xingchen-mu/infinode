import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { contactSheet, spansBetweenSilences } from '../server/agent/media.ts';

const log = (...lines: string[]) => lines.join('\n');

test('speech late in a shot is found between silences', () => {
  // As measured on an H3 shot: quiet ambience, then the line near the end.
  const spans = spansBetweenSilences(log('[silencedetect] silence_start: 0', '[silencedetect] silence_end: 3.79 | silence_duration: 3.79', '[silencedetect] silence_start: 4.67', '[silencedetect] silence_end: 5.167'), 5.167);
  assert.deepEqual(spans, [{ start: 3.79, end: 4.67 }]);
});

test('sound running to the end, all sound, all quiet, and blips too short to count', () => {
  assert.deepEqual(spansBetweenSilences(log('silence_start: 0', 'silence_end: 4.5'), 5.2), [{ start: 4.5, end: 5.2 }]);
  assert.deepEqual(spansBetweenSilences('', 3), [{ start: 0, end: 3 }]);
  assert.deepEqual(spansBetweenSilences(log('silence_start: 0'), 3), []);
  assert.deepEqual(spansBetweenSilences(log('silence_start: 0.05', 'silence_end: 2', 'silence_start: 2.1'), 3), []);
});

test('review sheets: four images at two columns are about 960 px each, video frames three to a row', async () => {
  const frame = (shade: number) => sharp({ create: { width: 1376, height: 768, channels: 3, background: { r: shade, g: shade, b: shade } } }).png().toBuffer();
  const tiles = await Promise.all([10, 60, 110, 160, 210, 250].map(async (s, i) => ({ image: await frame(s), label: `${i + 1}` })));
  const four = await sharp(await contactSheet(tiles.slice(0, 4), 2)).metadata();
  assert.deepEqual([four.width, four.height], [1920, 2 * 534 + 8]);
  const six = await sharp(await contactSheet(tiles, 3)).metadata();
  assert.deepEqual([six.width, six.height], [3 * 634 + 16, 2 * 354 + 8]);
});
