'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const backend = require('../src/backend');

test('parseVideoId accepts real links', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=30', 'dQw4w9WgXcQ'],
    ['http://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share', 'dQw4w9WgXcQ'],
    ['www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['  "dQw4w9WgXcQ"  ', 'dQw4w9WgXcQ'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(backend.parseVideoId(input), expected, input);
  }
});

test('parseVideoId rejects non-video links', () => {
  const cases = [
    '', 'not a url at all',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/playlist?list=PLabcdefghijklmno',
    null,
  ];
  for (const input of cases) {
    assert.equal(backend.parseVideoId(input), null, String(input));
  }
});

test('canonicalUrl rebuilds a clean watch url', () => {
  assert.equal(backend.canonicalUrl('dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('parseStartOffset reads every link spelling', () => {
  const cases = [
    ['https://youtu.be/x?t=90', 90],
    ['https://www.youtube.com/watch?v=x&t=1h2m3s', 3723],
    ['https://www.youtube.com/watch?v=x&t=13m32s', 812],
    ['https://www.youtube.com/watch?v=x&start=45', 45],
    ['https://www.youtube.com/embed/x#t=12', 12],
    ['https://www.youtube.com/watch?v=x', null],
    ['not a url', null],
  ];
  for (const [input, expected] of cases) {
    const result = backend.parseStartOffset(input);
    if (expected === null) assert.equal(result, null, input);
    else assert.ok(Math.abs(result - expected) < 0.001, input);
  }
});

test('parseStartOffset: query wins over fragment', () => {
  const result = backend.parseStartOffset('https://www.youtube.com/watch?v=x&t=10#t=999');
  assert.ok(Math.abs(result - 10) < 0.001);
});

test('fmtTime with milliseconds', () => {
  assert.equal(backend.fmtTime(0), '00:00:00.000');
  assert.equal(backend.fmtTime(90.5), '00:01:30.500');
  assert.equal(backend.fmtTime(3723), '01:02:03.000');
  assert.equal(backend.fmtTime(-5), '00:00:00.000');
});

test('fmtTime without milliseconds', () => {
  assert.equal(backend.fmtTime(90.9, false), '00:01:30');
});

test('parseTime accepts lenient formats', () => {
  const cases = [
    ['90', 90], ['1:30', 90], ['01:30.5', 90.5], ['00:01:30.500', 90.5],
    ['2:90', 210], ['1,5', 1.5],
  ];
  for (const [input, expected] of cases) {
    assert.ok(Math.abs(backend.parseTime(input) - expected) < 0.001, input);
  }
});

test('parseTime rejects bad input', () => {
  for (const input of ['', '1:2:3:4', 'abc', '-5']) {
    assert.throws(() => backend.parseTime(input), undefined, input);
  }
});

test('safeFilename collapses whitespace before scrubbing control chars', () => {
  // Regression: a tab must fold into the surrounding space, not become "_".
  assert.equal(backend.safeFilename('a \t b'), 'a b');
});

test('safeFilename handles edge cases', () => {
  const cases = [
    ['normal title', 'normal title'],
    ['bad<>:"/\\|?*chars', 'bad_________chars'],
    ['', 'video'],
    ['   ', 'video'],
    ['CON', '_CON'],
    ['con.txt', '_con.txt'],
    ['COM1', '_COM1'],
    ['...', 'video'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(backend.safeFilename(input), expected, input);
  }
});

test('safeFilename truncates to limit', () => {
  const longName = 'a'.repeat(200);
  assert.equal(backend.safeFilename(longName).length, 120);
});

test('crfForCompression maps each slider step to its encoder setting', () => {
  assert.equal(backend.crfForCompression(0), 18);
  assert.equal(backend.crfForCompression(25), 23);
  assert.equal(backend.crfForCompression(50), 28);
  assert.equal(backend.crfForCompression(75), 32);
});

test('crfForCompression exposes exactly the four advertised steps', () => {
  assert.deepEqual(backend.COMPRESSION_STEPS, [0, 25, 50, 75]);
});

test('crfForCompression snaps a value that is not on a step', () => {
  // The value arrives over IPC, so it is not ours to assume valid.
  assert.equal(backend.crfForCompression(30), 23, '30 is nearest 25');
  assert.equal(backend.crfForCompression(60), 28, '60 is nearest 50');
  assert.equal(backend.crfForCompression(1000), 32, 'clamps to the strongest step');
  assert.equal(backend.crfForCompression(-40), 18, 'clamps to the weakest step');
});

test('crfForCompression falls back to the original quality on junk input', () => {
  for (const bad of [undefined, null, NaN, 'x', {}]) {
    assert.equal(backend.crfForCompression(bad), 18);
  }
});

test('cropFilter builds the filter ffmpeg wants', () => {
  assert.equal(
    backend.cropFilter({ x: 100, y: 50, width: 800, height: 600, sourceWidth: 1920, sourceHeight: 1080 }),
    'crop=800:600:100:50');
});

test('cropFilter forces every number even', () => {
  // yuv420p subsamples chroma two pixels at a time, so an odd width or height
  // has no valid encoding, and ffmpeg masks the low bit off x and y itself.
  assert.equal(
    backend.cropFilter({ x: 101, y: 51, width: 801, height: 601, sourceWidth: 1920, sourceHeight: 1080 }),
    'crop=800:600:100:50');
});

test('cropFilter treats the whole frame as no crop at all', () => {
  // A filter cannot ride a stream copy, so saying "keep everything" would cost
  // a full re-encode and change nothing.
  assert.equal(
    backend.cropFilter({ x: 0, y: 0, width: 1920, height: 1080, sourceWidth: 1920, sourceHeight: 1080 }),
    null);
  assert.equal(backend.cropFilter(null), null);
});

test('cropFilter clamps a rectangle that runs off the frame', () => {
  const args = backend.cropFilter(
    { x: 1800, y: 1000, width: 4000, height: 4000, sourceWidth: 1920, sourceHeight: 1080 });
  assert.equal(args, 'crop=120:80:1800:1000');
});

test('cropFilter refuses anything it cannot trust', () => {
  // All of it arrives over IPC, the same as the compression and volume values.
  for (const bad of [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: NaN, y: 0, width: 100, height: 100, sourceWidth: 640, sourceHeight: 480 },
    { x: 0, y: 0, width: 'wide', height: 100, sourceWidth: 640, sourceHeight: 480 },
    { x: 0, y: 0, width: 100, height: 100, sourceWidth: 1, sourceHeight: 480 },
  ]) {
    assert.equal(backend.cropFilter(bad), null);
  }
});

test('cropFilter keeps a negative offset inside the frame', () => {
  assert.equal(
    backend.cropFilter({ x: -40, y: -10, width: 320, height: 240, sourceWidth: 640, sourceHeight: 480 }),
    'crop=320:240:0:0');
});

test('containerFor only reads the extension, not the rest of the path', () => {
  assert.equal(backend.containerFor('clip.webm'), 'webm');
  assert.equal(backend.containerFor('C:/x/CLIP.WebM'), 'webm', 'the dialog may hand back any case');
  assert.equal(backend.containerFor('clip.mp4'), 'mp4');
  assert.equal(backend.containerFor('C:/webm/clip.mp4'), 'mp4', 'a folder named webm is not one');
  assert.equal(backend.containerFor('C:/my.webm.files/clip.mp4'), 'mp4');
  assert.equal(backend.containerFor(''), 'mp4', 'no destination is not a reason to change format');
  assert.equal(backend.containerFor(null), 'mp4');
});

test('vp9CrfForCompression snaps like its x264 twin but off its own table', () => {
  assert.equal(backend.vp9CrfForCompression(0), 33);
  assert.equal(backend.vp9CrfForCompression(75), 56);
  assert.equal(backend.vp9CrfForCompression(26), 41, 'nearest step wins');
  assert.equal(backend.vp9CrfForCompression('nonsense'), 33, 'an unusable value is not compressed');
  assert.equal(backend.vp9CrfForCompression(9999), 56);
});

test('canCopyInto holds out for streams the container can actually store', () => {
  const can = backend.canCopyInto;
  // video containers
  assert.equal(can('webm', { video: 'vp9', audio: 'opus' }, true), true);
  assert.equal(can('webm', { video: 'vp8', audio: 'vorbis' }, true), true);
  assert.equal(can('webm', { video: 'h264', audio: 'opus' }, true), false, 'the common case');
  assert.equal(can('webm', { video: 'vp9', audio: 'aac' }, true), false);
  assert.equal(can('webm', { video: 'vp9', audio: 'aac' }, false), true,
    'a dropped stream cannot be the wrong codec');
  assert.equal(can('webm', { video: 'vp9' }, true), true, 'no audio stream is nothing to carry');
  assert.equal(can('mov', { video: 'h264', audio: 'aac' }, true), true);
  assert.equal(can('mov', { video: 'vp9', audio: 'opus' }, true), false, 'mov will not take vp9');
  assert.equal(can('mp4', { video: 'vp9', audio: 'opus' }, true), true, 'but mp4 will');
  assert.equal(can('mp4', { video: 'vp8', audio: 'vorbis' }, true), false);
  assert.equal(can('mp4', { video: 'H264', audio: 'AAC' }, true), true, 'casing is not a promise');

  // audio-only outputs are one stream, and it has to be the right one
  assert.equal(can('mp3', { audio: 'mp3' }, true), true);
  assert.equal(can('mp3', { audio: 'aac' }, true), false);
  assert.equal(can('wav', { audio: 'pcm_s16le' }, true), true);
  assert.equal(can('wav', { audio: 'mp3' }, true), false,
    'ffmpeg would allow it, but a .wav holding mp3 is not what WAV means');
  assert.equal(can('ogg', { audio: 'vorbis' }, true), true);
  assert.equal(can('ogg', { audio: 'opus' }, true), true);
  assert.equal(can('flac', { audio: 'flac' }, true), true);
  assert.equal(can('mp3', {}, true), false, 'an unknown codec is not a match');
  assert.equal(can('mp3', undefined, true), false);
  assert.equal(can('nonsense', { audio: 'mp3' }, true), false);
});

test('the compression tables cover every format that claims to support one', () => {
  for (const f of [...backend.VIDEO_OUTPUTS, ...backend.AUDIO_OUTPUTS]) {
    for (const step of backend.COMPRESSION_STEPS) {
      const v = backend.compressionSetting(f, step);
      assert.equal(v === null, !backend.supportsCompression(f), f + ' at ' + step);
      if (v !== null) assert.ok(Number.isFinite(v), f + ' at ' + step + ' gave ' + v);
    }
  }
  assert.equal(backend.supportsCompression('wav'), false, 'PCM has no knob to turn');
});

test('every output format is reachable from its own extension', () => {
  for (const f of backend.VIDEO_OUTPUTS) assert.equal(backend.containerFor('x.' + f, false), f);
  for (const f of backend.AUDIO_OUTPUTS) assert.equal(backend.containerFor('x.' + f, true), f);
  assert.equal(backend.containerFor('x.webm', true), 'mp3', 'a video format cannot serve audio');
  assert.equal(backend.containerFor('x.flac', false), 'mp4', 'nor the other way round');
});

test('stepForBitrate starts an mp3 at the rate it already has', () => {
  assert.equal(backend.stepForBitrate('mp3', 320000), 0);
  assert.equal(backend.stepForBitrate('mp3', 192000), 25);
  assert.equal(backend.stepForBitrate('mp3', 128000), 50);
  assert.equal(backend.stepForBitrate('mp3', 64000), 75);
});

test('a rate that is none of the four gets the middle one, not the nearest', () => {
  // 245 kbit/s is not meaningfully "320", and rounding it up there would
  // promise a quality the source does not have.
  assert.equal(backend.stepForBitrate('mp3', 245123), 25);
  assert.equal(backend.stepForBitrate('mp3', 160000), 25);
  assert.equal(backend.stepForBitrate('mp3', 319400), 25, 'close is not the same as equal');
  assert.equal(backend.stepForBitrate('mp3', 0), 25, 'an unreadable rate is not a reason to guess');
  assert.equal(backend.stepForBitrate('mp3', NaN), 25);
  assert.equal(backend.stepForBitrate('mp3', undefined), 25);
});

test('only a format measured in bitrates can answer at all', () => {
  for (const f of ['wav', 'ogg', 'aac', 'flac', 'mp4', 'webm', 'mov']) {
    assert.equal(backend.stepForBitrate(f, 192000), null, f);
  }
});

test('containerFor is what decides the format a source opens on', () => {
  // The save row reads this straight off the source path, so the fallbacks are
  // the feature: a readable format the app cannot write lands on the default.
  assert.equal(backend.containerFor('a.mkv', false), 'mp4', 'readable, not writable');
  assert.equal(backend.containerFor('a.m4a', true), 'mp3');
  assert.equal(backend.containerFor('a.opus', true), 'mp3');
  assert.equal(backend.containerFor('a.mov', false), 'mov');
  assert.equal(backend.containerFor('a.flac', true), 'flac');
});
