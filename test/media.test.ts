import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spansBetweenSilences } from '../server/agent/media.ts';

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
