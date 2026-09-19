'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ffmpegProgress, isProgressLine, fmtEta } = require('../src/progress');

// One real -progress block, in the order ffmpeg writes it. The order is the
// point: speed arrives after out_time, which is why the reader waits for the
// progress= line that ends the block before saying anything.
function block({ out = '00:00:04.000000', speed = '2.0x', end = 'continue' } = {}) {
  return [
    'frame=120',
    'fps=60.0',
    'stream_0_0_q=28.0',
    'bitrate=1234.5kbits/s',
    'total_size=123456',
    'out_time_us=4000000',
    'out_time_ms=4000000',
    'out_time=' + out,
    'dup_frames=0',
    'drop_frames=0',
    'speed=' + speed,
    'progress=' + end,
  ];
}

function feed(reader, lines) {
  const updates = [];
  for (const line of lines) {
    const u = reader.line(line);
    if (u) updates.push(u);
  }
  return updates;
}

test('a block produces exactly one update, and only once it has ended', () => {
  const reader = ffmpegProgress(10);
  const lines = block();
  // Everything up to and including speed= is still mid-block.
  for (const line of lines.slice(0, -1)) {
    assert.equal(reader.line(line), null, line + ' should not emit on its own');
  }
  const update = reader.line(lines[lines.length - 1]);
  assert.ok(update, 'the progress= line is what completes the block');
  assert.equal(update.frac, 0.4);
});

test('the ETA is the speed and the position from the same block', () => {
  // 4s of 10s written at 2x: 6s of output left, 3s of waiting.
  const [update] = feed(ffmpegProgress(10), block());
  assert.match(update.text, /ETA 3s$/);
  assert.match(update.text, /00:00:04 \/ 00:00:10/);
});

test('no speed yet means no ETA rather than a made-up one', () => {
  // ffmpeg says N/A until it has something to average, which is the first
  // block of every run.
  const [update] = feed(ffmpegProgress(10), block({ speed: 'N/A' }));
  assert.equal(update.frac, 0.4);
  assert.ok(!update.text.includes('ETA'), update.text);
});

test('a speed of zero is not divided by', () => {
  const [update] = feed(ffmpegProgress(10), block({ speed: '0x' }));
  assert.ok(!update.text.includes('ETA'), update.text);
});

test('the position carries from block to block, the speed with it', () => {
  const reader = ffmpegProgress(10);
  const updates = feed(reader, [
    ...block({ out: '00:00:02.000000', speed: '1.0x' }),
    ...block({ out: '00:00:08.000000', speed: '4.0x' }),
  ]);
  assert.equal(updates.length, 2);
  assert.match(updates[0].text, /ETA 8s$/);
  // 2s of output left at 4x is half a second, which rounds to nothing.
  assert.match(updates[1].text, /ETA 1s$/);
});

test('a negative out_time does not run the bar backwards', () => {
  // Reported before the first frame of a stream with a lead-in.
  const [update] = feed(ffmpegProgress(10), block({ out: '-00:00:01.000000' }));
  assert.equal(update.frac, 0);
});

test('running past the end still reads as finished, not as more than finished', () => {
  const [update] = feed(ffmpegProgress(10), block({ out: '00:00:12.000000' }));
  assert.equal(update.frac, 1);
  // Nothing left to wait for, so nothing is claimed about it.
  assert.ok(!update.text.includes('ETA'), update.text);
});

test('the closing block of a run is an update like any other', () => {
  const [update] = feed(ffmpegProgress(10),
    block({ out: '00:00:10.000000', end: 'end' }));
  assert.equal(update.frac, 1);
});

test('a span of nothing gives no fraction rather than a NaN', () => {
  const [update] = feed(ffmpegProgress(0), block());
  assert.equal(update.frac, null);
});

test('every line -progress writes is known to be progress', () => {
  for (const line of block()) {
    assert.ok(isProgressLine(line), line + ' should be recognised');
  }
});

test('anything ffmpeg has to say is not mistaken for progress', () => {
  const messages = [
    '[AVFilterGraph] No such filter: overlayy',
    'Error initializing complex filters.',
    'Invalid argument',
    '',
    'Conversion failed!',
  ];
  for (const line of messages) {
    assert.ok(!isProgressLine(line), line + ' should be kept for the error');
  }
});

test('a message that happens to contain an equals sign is still a message', () => {
  assert.ok(!isProgressLine('Option enable=1 not found.'));
});

test('the ETA reads as a duration once it stops being a handful of seconds', () => {
  assert.equal(fmtEta(0), '0s');
  assert.equal(fmtEta(42), '42s');
  assert.equal(fmtEta(59.4), '59s');
  assert.equal(fmtEta(60), '1:00');
  assert.equal(fmtEta(305), '5:05');
  assert.equal(fmtEta(3599), '59:59');
  assert.equal(fmtEta(3600), '1:00:00');
  assert.equal(fmtEta(3725), '1:02:05');
});

test('a negative ETA is nothing left rather than a minus sign', () => {
  assert.equal(fmtEta(-5), '0s');
});
