'use strict';

// V5.4. The export always writes BT.709 and says so, and a video that names no
// colour matrix is read the way the preview reads it.

const test = require('node:test');
const assert = require('node:assert/strict');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const colorSpace = require('../src/colorSpace');
const { buildComposeArgs, sourceColours } = require('../src/composer');
const timeline = require('../src/timeline');

const HD = { width: 1920, height: 1080, fps: 30 };
const vid = (props) => timeline.createLayer({ type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 5, ...props });
const img = (props) => timeline.createLayer({
  type: 'video', kind: 'image', src: 'shot.png', sourceDuration: 10, duration: 5, ...props,
});
const graphOf = (args) => args[args.indexOf('-filter_complex') + 1].split(';');

test('a video that names its matrix, primaries and transfer is left to say them itself', () => {
  for (const colorSpaceName of ['bt709', 'smpte170m', 'bt470bg', 'bt2020nc']) {
    for (const height of [480, 1080]) {
      assert.equal(colorSpace.assumedMatrix({
        height, colorSpace: colorSpaceName, colorPrimaries: 'bt709', colorTransfer: 'bt709', videoCodec: 'h264',
      }), null);
    }
  }
});

test('a matrix named alone is not believed by the preview, so the export is told its guess', () => {
  const of = (height, space, more = {}) => colorSpace.assumedMatrix({
    height, colorSpace: space, colorPrimaries: '', colorTransfer: '', videoCodec: 'h264', ...more,
  });
  // Measured: 720p tagged BT.601 and nothing else is shown as BT.709.
  assert.equal(of(720, 'smpte170m'), 'bt709');
  assert.equal(of(720, 'bt470bg'), 'bt709');
  assert.equal(of(480, 'bt709'), 'smpte170m');
  // Two of the three are still not all three.
  assert.equal(of(1080, 'smpte170m', { colorTransfer: 'smpte170m' }), 'bt709');
  assert.equal(of(1080, 'smpte170m', { colorPrimaries: 'smpte170m' }), 'bt709');
  // Where the guess is what the tag says anyway, ffmpeg reads it right alone.
  assert.equal(of(1080, 'bt709'), null);
  assert.equal(of(480, 'smpte170m'), null);
  assert.equal(of(480, 'bt470bg'), null);
});

test('VP9 is believed on its matrix alone', () => {
  const of = (height, space) => colorSpace.assumedMatrix({ height, colorSpace: space, videoCodec: 'vp9' });
  assert.equal(of(480, 'bt709'), null);
  assert.equal(of(1080, 'smpte170m'), null);
});

test('the picture is named BT.709 as the last thing in the graph', () => {
  const args = buildComposeArgs({
    layers: [vid({ id: 'v' }), img({ id: 'i', start: 1 })], project: HD, output: 'o.mp4',
    sources: { 'a.mp4': { width: 1920, height: 1080 }, 'shot.png': { width: 800, height: 600 } },
  });
  const graph = graphOf(args);
  const said = graph.filter((s) => s.includes(colorSpace.OUTPUT_FILTER));
  assert.equal(said.length, 1);
  assert.ok(said[0].endsWith('setparams=color_primaries=bt709:color_trc=bt709[vsaid]'));
  assert.equal(args[args.indexOf('-map') + 1], '[vsaid]');
});

test('a selection keeps its cut before the naming', () => {
  const graph = graphOf(buildComposeArgs({
    layers: [vid({ id: 'v' })], project: HD, output: 'o.mp4', trim: { start: 1, end: 3 },
    sources: { 'a.mp4': { width: 1920, height: 1080 } },
  }));
  assert.ok(graph.some((s) => s.startsWith('[vout]setparams=') && s.endsWith('[vsaid]')), graph.join('\n'));
});

test('an untagged video is BT.709 from 720 lines up and BT.601 below, as the preview guesses', () => {
  const of = (height, more = {}) => colorSpace.assumedMatrix({ height, colorSpace: '', videoCodec: 'h264', ...more });
  assert.equal(of(1080), 'bt709');
  assert.equal(of(720), 'bt709');
  assert.equal(of(719), 'smpte170m');
  assert.equal(of(480), 'smpte170m');
  // The height decides, not the width: an upright phone clip is HD.
  assert.equal(colorSpace.assumedMatrix({ width: 720, height: 1280, colorSpace: 'unknown', videoCodec: 'hevc' }), 'bt709');
  assert.equal(colorSpace.assumedMatrix({ width: 2000, height: 600, colorSpace: 'unknown', videoCodec: 'h264' }), 'smpte170m');
});

test('ffprobe\'s ways of saying nothing all count as untagged', () => {
  for (const word of ['', 'unknown', 'unspecified', 'reserved', 'N/A', undefined, null]) {
    assert.equal(colorSpace.assumedMatrix({ height: 1080, colorSpace: word, videoCodec: 'h264' }), 'bt709', String(word));
  }
});

test('untagged VP9 is BT.601 at any size, which is what Chromium shows', () => {
  assert.equal(colorSpace.assumedMatrix({ height: 1080, colorSpace: '', videoCodec: 'vp9' }), 'smpte170m');
  assert.equal(colorSpace.assumedMatrix({ height: 2160, colorSpace: 'unknown', videoCodec: 'VP9' }), 'smpte170m');
});

test('a file with no picture has nothing to assume', () => {
  assert.equal(colorSpace.assumedMatrix({ height: 0, colorSpace: '' }), null);
  assert.equal(colorSpace.assumedMatrix(null), null);
  assert.deepEqual(colorSpace.headFilters(null), []);
  assert.deepEqual(colorSpace.headFilters({ width: 10, height: 10 }), []);
});

test('every export with a picture is written as BT.709 in TV range and tagged so', () => {
  for (const [format, encoder] of [['mp4', 'cpu'], ['mp4', 'nvenc'], ['webm', 'cpu'], ['mov', 'cpu']]) {
    const args = buildComposeArgs({
      layers: [img({ id: 'i' })], project: HD, output: 'out.' + format, format, encoder,
      sources: { 'shot.png': { width: 800, height: 600 } },
    });
    const flag = (name) => args[args.indexOf(name) + 1];
    assert.equal(flag('-colorspace'), 'bt709', format);
    assert.equal(flag('-color_primaries'), 'bt709', format);
    assert.equal(flag('-color_trc'), 'bt709', format);
    assert.equal(flag('-color_range'), 'tv', format);
    // Before the output's name, or they would be read as the next file's.
    assert.ok(args.indexOf('-colorspace') < args.indexOf('out.' + format));
  }
});

test('a sound-only export carries no colour flags', () => {
  const args = buildComposeArgs({
    layers: [timeline.createLayer({ type: 'audio', src: 'm.mp3', sourceDuration: 60, duration: 5 })],
    project: HD, output: 'out.mp3', format: 'mp3', sources: {},
  });
  assert.equal(args.indexOf('-colorspace'), -1);
});

test('an untagged video is told its matrix before anything else touches it', () => {
  const sources = { 'a.mp4': { width: 1920, height: 1080, colour: { assume: 'bt709' } } };
  const graph = graphOf(buildComposeArgs({ layers: [vid({ id: 'v' })], project: HD, output: 'o.mp4', sources }));
  const mine = graph.find((s) => s.startsWith('[0:v]'));
  assert.ok(mine.startsWith('[0:v]setparams=colorspace=bt709,'), mine);
});

test('a tagged video\'s graph is exactly the one from before 5.4', () => {
  const tagged = graphOf(buildComposeArgs({
    layers: [vid({ id: 'v' })], project: HD, output: 'o.mp4', sources: { 'a.mp4': { width: 1920, height: 1080 } },
  }));
  assert.ok(!tagged.some((s) => s.includes('setparams=colorspace')));
  assert.equal(tagged.filter((s) => s.includes('setparams')).length, 1, 'only the naming at the end');
});

test('the matrix is said on every road a picture can take: keyframes, a turn, VFX', () => {
  const sources = { 'a.mp4': { width: 1920, height: 1080, colour: { assume: 'smpte170m' } } };
  const moving = vid({
    id: 'm',
    keyframes: [
      { t: 0, render: { x: 0, y: 0, width: 960, height: 540 } },
      { t: 2, render: { x: 400, y: 200, width: 960, height: 540 } },
    ],
  });
  const turning = vid({
    id: 't',
    keyframes: [
      { t: 0, render: { x: 0, y: 0, width: 960, height: 540 }, rotation: 0 },
      { t: 2, render: { x: 400, y: 200, width: 960, height: 540 }, rotation: 90 },
    ],
  });
  for (const layer of [moving, turning]) {
    const graph = graphOf(buildComposeArgs({ layers: [layer], project: HD, output: 'o.mp4', sources }));
    const heads = graph.filter((s) => s.startsWith('[0:v]'));
    assert.equal(heads.length, 1, layer.id);
    assert.ok(heads[0].startsWith('[0:v]setparams=colorspace=smpte170m,'), heads[0].slice(0, 80));
  }
});

test('the export asks each file once, and never a drawn layer or a sound', () => {
  const asked = [];
  const NAMED = { colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709', colorRange: 'tv' };
  const probe = (file) => {
    asked.push(file);
    if (file === 'bare.mp4') return { width: 1280, height: 720, colorSpace: '', videoCodec: 'h264', pixFmt: 'yuv420p' };
    if (file === 'shot.png') return { width: 800, height: 600, pixFmt: 'rgba' };
    if (file === 'photo.jpg') return { width: 800, height: 600, pixFmt: 'yuvj420p', colorSpace: 'bt470bg', colorRange: 'pc' };
    return { width: 1920, height: 1080, videoCodec: 'h264', pixFmt: 'yuv420p', ...NAMED };
  };
  const layers = [
    vid({ id: 'a', src: 'bare.mp4' }), vid({ id: 'b', src: 'bare.mp4' }), vid({ id: 'c', src: 'tagged.mp4' }),
    img({ id: 'i' }), img({ id: 'j', src: 'photo.jpg' }),
    timeline.createLayer({ type: 'video', kind: 'gen', src: 'text.png', sourceDuration: 10, duration: 5 }),
    timeline.createLayer({ type: 'audio', src: 'm.mp3', sourceDuration: 60, duration: 5 }),
  ];
  const sizes = { 'bare.mp4': { width: 1280, height: 720 }, 'tagged.mp4': { width: 1920, height: 1080 } };
  const out = sourceColours(layers, sizes, probe);
  assert.deepEqual(asked, ['bare.mp4', 'tagged.mp4', 'shot.png', 'photo.jpg']);
  assert.deepEqual(out['bare.mp4'], { width: 1280, height: 720, colour: { assume: 'bt709', hdr: null, convert: null } });
  assert.deepEqual(out['tagged.mp4'], { width: 1920, height: 1080 }, 'a file that is BT.709 by name is handed on as it was');
  assert.equal(out['shot.png'], undefined, 'a PNG is red, green and blue already');
  assert.deepEqual(out['photo.jpg'].colour, { assume: null, hdr: null, rgb: true });
  assert.deepEqual(sizes['bare.mp4'], { width: 1280, height: 720 }, 'the list given is not written to');
});

test('a video that is not BT.709 in TV range is converted by the export itself, first of all', () => {
  const d = (info) => colorSpace.describe({ height: 1080, videoCodec: 'h264', pixFmt: 'yuv420p', ...info });
  const FULL_601 = { colorSpace: 'smpte170m', colorPrimaries: 'smpte170m', colorTransfer: 'smpte170m', colorRange: 'tv' };
  const FULL_709 = { colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709', colorRange: 'tv' };
  assert.deepEqual(d(FULL_601).convert, { format: null }, 'BT.601 by name');
  assert.equal(d(FULL_709).convert, null, 'BT.709 in TV range needs nothing');
  assert.deepEqual(d({ ...FULL_709, colorRange: 'pc' }).convert, { format: null }, 'BT.709 at full range');
  assert.deepEqual(d({ ...FULL_709, colorRange: 'pc', pixFmt: 'yuvj420p' }).convert, { format: 'yuv420p' },
    'and out of the old full range format, which would keep it full range by name');
  assert.deepEqual(d({ height: 480, colorSpace: '' }).convert, { format: null }, 'a small file naming nothing is read as BT.601');
  assert.equal(d({ height: 1080, colorSpace: '' }).convert, null, 'a large one as BT.709');
  assert.equal(d({ ...FULL_709, colorSpace: 'ycgco' }).convert, null, 'a matrix the scaler does not know is left to ffmpeg');

  const sources = { 'a.mp4': { width: 1920, height: 1080, colour: { assume: 'smpte170m', hdr: null, convert: { format: null } } } };
  const graph = graphOf(buildComposeArgs({ layers: [vid({ id: 'v' })], project: HD, output: 'o.mp4', sources }));
  const mine = graph.find((s) => s.startsWith('[0:v]'));
  assert.ok(mine.startsWith('[0:v]setparams=colorspace=smpte170m,'
    + 'scale=flags=accurate_rnd+full_chroma_int+full_chroma_inp:out_color_matrix=bt709:out_range=tv,'
    + 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv,'), mine.slice(0, 220));
});

test('a JPEG is made red, green and blue the careful way before it is placed', () => {
  const sources = { 'photo.jpg': { width: 800, height: 600, colour: { assume: null, hdr: null, rgb: true } } };
  const graph = graphOf(buildComposeArgs({
    layers: [img({ id: 'j', src: 'photo.jpg' })], project: HD, output: 'o.mp4', sources,
  }));
  const mine = graph.find((s) => s.startsWith('[0:v]'));
  assert.ok(mine.startsWith('[0:v]scale=flags=accurate_rnd+full_chroma_int+full_chroma_inp,format=gbrp,'), mine.slice(0, 120));
  // Still read once and held, the conversion with it: the hold comes after.
  assert.ok(mine.indexOf('format=gbrp') < mine.indexOf('loop='), mine);
});

// ---- HDR ----

test('HLG and PQ are told apart by the transfer the file names', () => {
  const of = (colorTransfer) => colorSpace.hdrKind({ height: 1080, colorTransfer });
  assert.equal(of('arib-std-b67'), 'hlg');
  assert.equal(of('smpte2084'), 'pq');
  assert.equal(of('bt709'), null);
  assert.equal(of(''), null);
  assert.equal(colorSpace.hdrKind({ height: 0, colorTransfer: 'smpte2084' }), null, 'no picture, no HDR');
});

test('HDR comes down to SDR as the preview was measured to show it', () => {
  const shown = (kind, rgb) => colorSpace.hdrToSdr(kind, rgb).map((x) => Math.round(x * 255));
  // Read off Chromium's canvas, 2026-11-19: the grey steps of the two grids.
  assert.deepEqual(shown('hlg', [0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(shown('hlg', [0.5, 0.5, 0.5]), [152, 152, 152]);
  assert.deepEqual(shown('hlg', [0.75, 0.75, 0.75]), [255, 255, 255], 'HLG reference white is white');
  assert.deepEqual(shown('hlg', [1, 1, 1]), [255, 255, 255], 'and nothing is brighter than white');
  assert.deepEqual(shown('pq', [0.5, 0.5, 0.5]), [178, 178, 178]);
  assert.deepEqual(shown('pq', [0.75, 0.75, 0.75]), [255, 255, 255]);
  // A colour outside BT.709 is cut off at its edge, each channel by itself.
  assert.deepEqual(shown('hlg', [1, 0, 0]), [255, 0, 0]);
  const halfRed = shown('pq', [0.5, 0, 0]);
  assert.ok(Math.abs(halfRed[0] - 223) <= 1 && halfRed[1] === 0 && halfRed[2] === 0, String(halfRed));
});

test('the table is a .cube of the whole sum, red running fastest', () => {
  const text = colorSpace.hdrCube('hlg', 3);
  const lines = text.trimEnd().split('\n');
  assert.equal(lines[1], 'LUT_3D_SIZE 3');
  assert.equal(lines.length, 2 + 27);
  const row = (i) => lines[2 + i].split(' ').map(Number);
  assert.deepEqual(row(0), [0, 0, 0]);
  // The second entry is red at half signal, green and blue at none.
  const half = colorSpace.hdrToSdr('hlg', [0.5, 0, 0]);
  assert.ok(Math.abs(row(1)[0] - half[0]) < 1e-4 && row(1)[1] === 0 && row(1)[2] === 0);
  assert.deepEqual(row(26), [1, 1, 1]);
  assert.ok(colorSpace.hdrCube('pq', 2).startsWith('TITLE "LWClipper PQ to SDR"'));
});

test('an HDR clip is brought to SDR before anything else, and named BT.709 after', () => {
  const sources = { 'a.mp4': { width: 1920, height: 1080, colour: { assume: null, hdr: 'hlg', lut: 'C:/tmp/t.cube' } } };
  const graph = graphOf(buildComposeArgs({ layers: [vid({ id: 'v' })], project: HD, output: 'o.mp4', sources }));
  const mine = graph.find((s) => s.startsWith('[0:v]'));
  const steps = mine.slice('[0:v]'.length).split(',');
  assert.equal(steps[0], 'scale=flags=accurate_rnd');
  assert.equal(steps[1], 'format=gbrp10le');
  assert.match(steps[2], /^lut3d=file=C.*\/tmp\/t\.cube:interp=tetrahedral$/);
  assert.equal(steps[3], 'scale=flags=accurate_rnd:out_color_matrix=bt709:out_range=tv');
  assert.equal(steps[4], 'format=yuv420p10le');
  assert.equal(steps[5], 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv');
});

test('without its table an HDR clip is left as it is rather than half converted', () => {
  const sources = { 'a.mp4': { width: 1920, height: 1080, colour: { assume: null, hdr: 'pq' } } };
  const graph = graphOf(buildComposeArgs({ layers: [vid({ id: 'v' })], project: HD, output: 'o.mp4', sources }));
  assert.ok(!graph.some((s) => s.includes('lut3d')));
});

test('an HDR file that names no matrix is read as BT.2020', () => {
  assert.deepEqual(colorSpace.describe({ height: 1080, colorSpace: '', colorTransfer: 'arib-std-b67', videoCodec: 'hevc' }),
    { assume: 'bt2020nc', hdr: 'hlg', convert: null });
  assert.deepEqual(colorSpace.describe({ height: 1080, colorSpace: 'bt2020nc', colorTransfer: 'smpte2084', videoCodec: 'hevc' }),
    { assume: null, hdr: 'pq', convert: null });
});
