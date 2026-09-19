'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/geometry');

const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };
const WIDE = { width: 1920, height: 816 };    // 2.39:1, the cinema crop
const TALL = { width: 1080, height: 1920 };   // 9:16, a phone video
const SMALL = { width: 1280, height: 720 };

// Reads the filter strings back into numbers, so a test can ask whether the
// encoder and the canvas describe the same rectangle rather than trusting that
// they do.
function fromFilters(parts, source, project) {
  const nums = (s, prefix) => s.slice(prefix.length).split(':').map(Number);
  const src = parts.crop
    ? (([w, h, x, y]) => ({ x, y, width: w, height: h }))(nums(parts.crop, 'crop='))
    : { x: 0, y: 0, width: source.width, height: source.height };
  const size = parts.scale
    ? (([w, h]) => ({ width: w, height: h }))(nums(parts.scale, 'scale='))
    : { width: src.width, height: src.height };
  const [x, y] = nums(parts.overlay, 'overlay=');
  void project;
  return { src, dest: { x, y, width: size.width, height: size.height } };
}

// The whole point of the module: one placement, two renderers, no disagreement.
function assertRenderersAgree(source, project, crop) {
  const placement = G.placeLayer({ source, crop: crop || null, project });
  const canvas = G.previewCanvasSize(project);
  const draw = G.drawImageArgs(placement, project, canvas);
  const viaFilters = fromFilters(G.filterParts(placement, source), source, project);

  assert.deepEqual(
    { x: draw.sx, y: draw.sy, width: draw.sw, height: draw.sh },
    viaFilters.src,
    'the two renderers take the same part of the source',
  );

  // The canvas numbers are in canvas pixels; scale them back to project pixels
  // to compare. Fractions are expected, so compare with a tolerance rather than
  // exactly.
  const kx = canvas.width / project.width;
  const ky = canvas.height / project.height;
  const back = {
    x: draw.dx / kx, y: draw.dy / ky, width: draw.dw / kx, height: draw.dh / ky,
  };
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(back[key] - viaFilters.dest[key]) < 1e-6,
      'dest ' + key + ': canvas says ' + back[key] + ', ffmpeg says ' + viaFilters.dest[key]);
  }
  return placement;
}

test('a source that already matches the project is left alone', () => {
  const p = assertRenderersAgree(HD, HD);
  assert.deepEqual(p.dest, { x: 0, y: 0, width: 1920, height: 1080 });
  const parts = G.filterParts(p, HD);
  assert.equal(parts.crop, null, 'the whole frame is not a crop');
  assert.equal(parts.scale, null, 'scaling to the size it already is does nothing');
  assert.equal(parts.overlay, 'overlay=0:0');
});

test('a smaller source of the same shape is scaled up to fill the frame', () => {
  const p = assertRenderersAgree(SMALL, HD);
  assert.deepEqual(p.dest, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(G.filterParts(p, SMALL).scale, 'scale=1920:1080');
});

test('a source larger than the project is scaled down, not cut', () => {
  const p = assertRenderersAgree(UHD, HD);
  assert.deepEqual(p.dest, { x: 0, y: 0, width: 1920, height: 1080 });
  const parts = G.filterParts(p, UHD);
  assert.equal(parts.crop, null);
  assert.equal(parts.scale, 'scale=1920:1080');
});

test('a wider source is letterboxed, with equal bars top and bottom', () => {
  const p = assertRenderersAgree(WIDE, HD);
  assert.equal(p.dest.width, 1920, 'full width, because width is what runs out first');
  assert.equal(p.dest.height, 816);
  assert.equal(p.dest.x, 0);
  assert.equal(p.dest.y, 132, 'half of the 264 pixels left over');
  assert.equal(1080 - p.dest.y - p.dest.height, 132, 'the other bar is the same size');
});

test('a taller source is pillarboxed, with equal bars left and right', () => {
  const p = assertRenderersAgree(TALL, HD);
  assert.equal(p.dest.height, 1080, 'full height, because height is what runs out first');
  assert.equal(p.dest.width, 608);
  assert.equal(p.dest.y, 0);
  assert.equal(p.dest.x, 656);
  assert.equal(1920 - p.dest.x - p.dest.width, 656, 'the other bar is the same size');
});

test('a cropped source is fitted by what is left after the crop', () => {
  // A quarter-frame crop of a 16:9 source is still 16:9, so it fills the
  // project frame once it is scaled up.
  const crop = { x: 100, y: 50, width: 960, height: 540 };
  const p = assertRenderersAgree(HD, HD, crop);
  assert.deepEqual(p.src, { x: 100, y: 50, width: 960, height: 540 });
  assert.deepEqual(p.dest, { x: 0, y: 0, width: 1920, height: 1080 });
  const parts = G.filterParts(p, HD);
  assert.equal(parts.crop, 'crop=960:540:100:50');
  assert.equal(parts.scale, 'scale=1920:1080');
});

test('a crop that changes the shape gets letterboxed like any other source', () => {
  // Cropping a 16:9 source down to a square means the square is pillarboxed,
  // because the project ratio rules everywhere, cropping included.
  const crop = { x: 400, y: 0, width: 1080, height: 1080 };
  const p = assertRenderersAgree(HD, HD, crop);
  assert.equal(p.dest.width, 1080);
  assert.equal(p.dest.height, 1080);
  assert.equal(p.dest.x, 420);
  assert.equal(p.dest.y, 0);
});

test('a crop is clamped inside the frame it is cropping', () => {
  const r = G.sourceRect(HD, { x: 1800, y: 1000, width: 999, height: 999 });
  assert.equal(r.x + r.width, 1920, 'cannot reach past the right edge');
  assert.equal(r.y + r.height, 1080, 'cannot reach past the bottom edge');
});

test('odd numbers are rounded down, because H.264 refuses them', () => {
  const r = G.sourceRect({ width: 1921, height: 1081 }, { x: 3, y: 5, width: 101, height: 51 });
  assert.deepEqual(r, { x: 2, y: 4, width: 100, height: 50 });
  const p = G.placeLayer({ source: { width: 1921, height: 1081 }, project: { width: 641, height: 361 } });
  for (const v of [p.dest.x, p.dest.y, p.dest.width, p.dest.height]) {
    assert.equal(v % 2, 0, 'every emitted dimension is even');
  }
});

test('an explicit render rect overrides the fit and may hang off the edge', () => {
  // This is what the V2.1 Render Position tab will set, and sliding a layer out
  // of shot has to stay possible.
  const p = G.placeLayer({
    source: HD,
    project: HD,
    render: { x: -200, y: 900, width: 640, height: 360 },
  });
  assert.deepEqual(p.dest, { x: -200, y: 900, width: 640, height: 360 });
  assert.equal(G.filterParts(p, HD).overlay, 'overlay=-200:900');
});

test('the preview canvas keeps the project shape and never grows past the cap', () => {
  // 853 rather than 854, because the height cap binds first on 16:9 and the
  // aspect is what matters, not hitting the round number.
  assert.deepEqual(G.previewCanvasSize(HD), { width: 853, height: 480 });
  assert.deepEqual(G.previewCanvasSize(TALL), { width: 270, height: 480 });
  assert.deepEqual(G.previewCanvasSize({ width: 1080, height: 1080 }), { width: 480, height: 480 });
});

test('the preview canvas never scales a small project up', () => {
  assert.deepEqual(G.previewCanvasSize({ width: 320, height: 240 }), { width: 320, height: 240 });
});

test('drawImage arguments are in canvas pixels, the placement is in project pixels', () => {
  const p = G.placeLayer({ source: TALL, project: HD });
  const canvas = { width: 853, height: 480 };
  const d = G.drawImageArgs(p, HD, canvas);
  // The source rectangle is always source pixels: the canvas size never touches it.
  assert.deepEqual([d.sx, d.sy, d.sw, d.sh], [0, 0, 1080, 1920]);
  assert.ok(Math.abs(d.dx - 656 * (853 / 1920)) < 1e-9);
  assert.ok(Math.abs(d.dh - 480) < 1e-9, 'a full-height layer fills the canvas height');
});

test('a source with no dimensions places nothing rather than producing NaN', () => {
  assert.equal(G.placeLayer({ source: { width: 0, height: 0 }, project: HD }), null);
  assert.equal(G.placeLayer({ source: HD, project: { width: 0, height: 0 } }), null);
  assert.equal(G.drawImageArgs(null, HD, { width: 10, height: 10 }), null);
  assert.equal(G.filterParts(null, HD), null);
});

test('fitting a thumbnail is the same maths as fitting the output frame', () => {
  // The filmstrip draws at project ratio with the source centred inside, which
  // is this function at a much smaller size. Same shape, same bars.
  const big = G.fitRect(1920, 816, HD);
  const small = G.fitRect(1920, 816, { width: 160, height: 90 });
  assert.equal(big.y / 1080 > 0, true);
  assert.equal(small.width, 160);
  assert.equal(small.height, 68);
  assert.equal(small.x, 0);
  assert.equal(small.y, 10);
});
