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

// ---- V2.1, 21b: the project frame becomes editable ----

test('a typed resolution is evened down and clamped into something encodable', () => {
  assert.deepEqual(G.frameSize(1921, 1081), { width: 1920, height: 1080 });
  // A box hands over a string, not a number.
  assert.deepEqual(G.frameSize('1280', '720'), { width: 1280, height: 720 });
  assert.deepEqual(G.frameSize(99999, 1), { width: G.FRAME_MAX, height: G.FRAME_MIN });
  assert.deepEqual(G.frameSize(-40, 0), { width: G.FRAME_MIN, height: G.FRAME_MIN });
});

test('a resolution that was not typed at all is refused rather than read as zero', () => {
  // The trap this exists for: Number('') is 0, so an emptied box would come
  // through as a 2x2 project instead of as nothing to act on.
  assert.equal(G.frameSize('', 720), null);
  assert.equal(G.frameSize('   ', 720), null);
  assert.equal(G.frameSize('1080p', 720), null);
  assert.equal(G.frameSize(1280, undefined), null);
  assert.equal(G.frameSize(NaN, 720), null);
});

test('asking for a bigger file is not asking for a different composition', () => {
  // A quarter-size picture in picture at 1280x720, carried to 1080p. Every
  // number multiplied by 1.5, which is what keeping the shot means.
  const moved = G.rescaleRender({ x: 200, y: 120, width: 480, height: 270 }, SMALL, HD);
  assert.deepEqual(moved, { x: 300, y: 180, width: 720, height: 405 });
});

test('a layer sitting on its own fit lands on the new fit when only the size changes', () => {
  // The rule the transform has to agree with, or a placed layer and an
  // unplaced one would drift apart for no reason the user can see.
  const fit = G.fitRect(WIDE.width, WIDE.height, SMALL);
  assert.deepEqual(G.rescaleRender(fit, SMALL, HD), G.fitRect(WIDE.width, WIDE.height, HD));
});

test('and within a pixel or two when the even-down lands differently', () => {
  // TALL into SMALL is 404 wide after evenDown, and 404 * 1.5 is 606 where
  // fitting the source straight into HD gives 608. Two roundings against one:
  // the agreement above is exact only when the first one divides evenly.
  const fit = G.fitRect(TALL.width, TALL.height, SMALL);
  const moved = G.rescaleRender(fit, SMALL, HD);
  const direct = G.fitRect(TALL.width, TALL.height, HD);
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(moved[key] - direct[key]) <= 2,
      key + ': ' + moved[key] + ' against ' + direct[key]);
  }
});

test('changing the aspect letterboxes the arrangement rather than stretching it', () => {
  // 16:9 to 9:16. A layer that filled the old frame fills the letterbox of the
  // old frame in the new one, which is the old frame fitted into the new.
  const filled = G.rescaleRender({ x: 0, y: 0, width: 1280, height: 720 }, SMALL, TALL);
  assert.deepEqual(filled, G.fitRect(SMALL.width, SMALL.height, TALL));
  // And a layer centred in the old frame is still centred in the new one,
  // still at the shape it was given rather than stretched to the new ratio.
  const pip = G.rescaleRender({ x: 480, y: 270, width: 320, height: 180 }, SMALL, TALL);
  assert.equal(pip.x + pip.width / 2, TALL.width / 2);
  assert.equal(pip.y + pip.height / 2, TALL.height / 2);
  assert.ok(Math.abs(pip.width / pip.height - 320 / 180) < 0.01, 'the shape survived');
});

test('a layer hanging off the edge is carried across still hanging off it', () => {
  // Sliding a layer out of shot has to survive a resize, or the resize would
  // quietly drag it back in.
  const moved = G.rescaleRender({ x: -200, y: 0, width: 1280, height: 720 }, SMALL, HD);
  assert.equal(moved.x, -300);
  assert.equal(moved.width, 1920);
});

test('nothing to carry, and nothing to carry it from', () => {
  assert.equal(G.rescaleRender(null, SMALL, HD), null);
  // No old frame to measure against: handed back untouched rather than
  // recentred on a guess about what it used to mean.
  const rect = { x: 10, y: 10, width: 100, height: 100 };
  assert.deepEqual(G.rescaleRender(rect, { width: 0, height: 0 }, HD), rect);
  assert.deepEqual(G.rescaleRender(rect, SMALL, { width: 0, height: 0 }), rect);
});

// ---- splitHeight, V2.1 step 21c-1 ----
//
// The two floors are measured in the running app: 192px of stack is one video
// track and one audio track once the empty row each kind carries is counted,
// and the preview floor is whatever previewFit() says the flush height is at
// the width the window happens to be. Here they are just numbers, which is the
// point of the arithmetic living out of the window.

test('a split the room can afford is the split that was asked for', () => {
  assert.equal(G.splitHeight(300, 600, 192, 279), 300);
  assert.equal(G.splitHeight(192, 600, 192, 279), 192);
  // Exactly the largest that leaves the preview its floor.
  assert.equal(G.splitHeight(321, 600, 192, 279), 321);
});

test('the preview keeps its floor however far the handle is dragged', () => {
  // 600 of room, 279 of it spoken for: 321 is the most the stack can hold, and
  // asking for 500 does not make the preview any smaller.
  assert.equal(G.splitHeight(500, 600, 192, 279), 321);
  assert.equal(G.splitHeight(5000, 600, 192, 279), 321);
});

test('and the timeline keeps its own, dragged the other way', () => {
  assert.equal(G.splitHeight(100, 600, 192, 279), 192);
  assert.equal(G.splitHeight(0, 600, 192, 279), 192);
  assert.equal(G.splitHeight(-40, 600, 192, 279), 192);
});

test('a window too short for both floors gives the room to the timeline', () => {
  // 400 of room against floors of 192 and 279. Something has to give, and a
  // preview of 208 is a small preview where a timeline of 121 has cut the
  // audio row in half.
  assert.equal(G.splitHeight(300, 400, 192, 279), 192);
  assert.equal(G.splitHeight(100, 400, 192, 279), 192);
});

test('the result is whole pixels, and rubbish reads as no wish at all', () => {
  assert.equal(G.splitHeight(300.6, 600, 192, 279), 301);
  // A wish that is not a number is the floor rather than zero, which would read
  // as a deliberate drag to the top of the travel.
  assert.equal(G.splitHeight(NaN, 600, 192, 279), 192);
  assert.equal(G.splitHeight(undefined, 600, 192, 279), 192);
  assert.equal(G.splitHeight(300, NaN, 192, 279), 192);
});

test('the clamp does not move a second time, which is what lets it re-run', () => {
  // Applied on every window resize, so a wish that has already been clamped
  // has to come back unchanged or the split would walk on its own.
  const once = G.splitHeight(500, 600, 192, 279);
  assert.equal(G.splitHeight(once, 600, 192, 279), once);
  const low = G.splitHeight(20, 600, 192, 279);
  assert.equal(G.splitHeight(low, 600, 192, 279), low);
});

// ---- resizeEdge, V2.1 21e and 22a, moved out of the window in V2.7 ----
//
// One bar of the crop box, dragged. Every bar and both axes come through here,
// which is what stops the clamping to the frame from being written four
// slightly different ways. Until V2.7 it sat in renderer/app.js and could only
// be reached by driving a real pointer at a real window, so the rules below had
// been fixed several times over without ever being stated anywhere.
//
// The arguments, in order: the near and far edge, the far limit, which of the
// two this bar is, whether Shift is down, the pointer's travel in source
// pixels, that same travel in screen pixels, and the near limit.

const EDGE_LIMIT = 1280;

test('the far bar moves by the pointer, snapped to an even step', () => {
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, false, false, 10),
    { lo: 200, hi: 610 });
  // Seven rounds to eight rather than to seven: an odd edge has no valid
  // encoding, which is the whole reason for the step.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, false, false, 7),
    { lo: 200, hi: 608 });
});

test('the near bar moves instead when it is the one being dragged', () => {
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, true, false, -10),
    { lo: 190, hi: 600 });
});

test('a bar dragged past the frame stops at it', () => {
  // Out to the left, where the floor is zero by default.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, true, false, -5000),
    { lo: 0, hi: 600 });
  // And out to the right, where the limit is the frame's far edge.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, false, false, 5000),
    { lo: 200, hi: EDGE_LIMIT });
});

test('the floor is a real argument, for a frame dragged while zoomed in', () => {
  // Zoomed in, a bar dragged past the edge of the window would take the box
  // somewhere it can be neither seen nor grabbed, so the near limit is the
  // window rather than zero.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, true, false, -5000, Infinity, 100),
    { lo: 100, hi: 600 });
});

test('the two bars can never be driven closer than the smallest box', () => {
  const near = G.resizeEdge(200, 600, EDGE_LIMIT, true, false, 5000);
  assert.deepEqual(near, { lo: 600 - G.CROP_MIN, hi: 600 });
  const far = G.resizeEdge(200, 600, EDGE_LIMIT, false, false, -5000);
  assert.deepEqual(far, { lo: 200, hi: 200 + G.CROP_MIN });
  // Which is the same distance either way round, and it is an even one.
  assert.equal(near.hi - near.lo, far.hi - far.lo);
  assert.equal((far.hi - far.lo) % 2, 0);
});

test('Shift moves both bars, so the centre holds and the span changes by two a step', () => {
  const out = G.resizeEdge(200, 600, EDGE_LIMIT, true, true, -10, -10);
  assert.deepEqual(out, { lo: 190, hi: 610 });
  // The middle is where it was, and the span grew by twice the step.
  assert.equal((out.lo + out.hi) / 2, (200 + 600) / 2);
  assert.equal((out.hi - out.lo) - (600 - 200), 20);
});

test('mirrored, either bar of the pair does the same thing', () => {
  // Dragging the near bar out ten is the far bar out ten: one gesture, one
  // answer, whichever end the hand took hold of.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, true, true, -10, -10),
    G.resizeEdge(200, 600, EDGE_LIMIT, false, true, 10, 10));
});

test('a mirrored pair is capped at a source pixel per pixel of travel', () => {
  // The frame is usually shown small enough that one screen pixel is worth two
  // or three source pixels, and without the cap the pair could only ever jump
  // by that many at a time, never by the one it is for. Twenty source pixels
  // asked for, five pixels of hand movement, five is what it gets.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, true, true, -20, -5),
    { lo: 195, hi: 605 });
  // Zoomed in it is the other way round and the ordinary rate is the slower of
  // the two, so that one still applies.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, true, true, -5, -20),
    { lo: 195, hi: 605 });
});

test('a mirrored pair stops as soon as either bar reaches the frame', () => {
  // The near bar is ten from the floor and the far one has 680 to spare. Ten is
  // what the pair gets, because the far bar going further would move the centre.
  assert.deepEqual(G.resizeEdge(10, 600, EDGE_LIMIT, true, true, -5000, -5000),
    { lo: 0, hi: 610 });
});

test('a mirrored pair closing in stops at the smallest box', () => {
  // Twenty apart, so there are two pixels a side to give before the two bars
  // are CROP_MIN apart.
  const out = G.resizeEdge(200, 220, EDGE_LIMIT, true, true, 5000, 5000);
  assert.deepEqual(out, { lo: 202, hi: 218 });
  assert.equal(out.hi - out.lo, G.CROP_MIN);
});

test('with no screen travel given the cap is off', () => {
  // The default is Infinity, so the source delta is the only rate. bindCorner
  // passes its travel; anything that has none is not being held to a hand.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, true, true, -30),
    { lo: 170, hi: 630 });
});

// ---- the render frame caps, V2.7 ----
//
// Settled with the user on 2026-09-24: neither side above 3840, the shorter
// side never above 2160, the ratio never past 21:9 either way, even numbers.
// Their own statement of it was "A square should not exceed 2160px. If one side
// reaches that only the other side can still move."

test('the largest square is 2160, and one side can still grow from there', () => {
  const at2160 = G.renderFrameSide(2160);
  // 5040, which is 21:9 at 2160 tall and the widest anything may be.
  assert.equal(at2160.max, G.RENDER_MAX_SIDE);
  // Which is to say 2160x2160 is legal and so is growing one side all the way.
  assert.ok(2160 <= at2160.max);
  // And the largest 16:9 is still 3840x2160, which is what 4K means.
  assert.deepEqual(G.renderFrameFor(16 / 9, 2160), { width: 3840, height: 2160 });
});

test('once one side is past 2160 the other is held to 2160', () => {
  assert.equal(G.renderFrameSide(3840).max, G.RENDER_MAX_SHORT);
  assert.equal(G.renderFrameSide(2162).max, G.RENDER_MAX_SHORT);
  // So the largest 16:9 is 3840x2160 and there is no way to ask for more.
  assert.equal(G.renderFrameSide(2160).max, G.RENDER_MAX_SIDE);
});

test('the 21:9 rule is a floor on the short side, not a ceiling on the long', () => {
  // The widest frame is 3840 across, and at that width the height may not go
  // below 1646: 3840/1646 is just inside 21:9 and 3840/1644 is just outside.
  assert.equal(G.renderFrameSide(3840).min, 1646);
  assert.ok(3840 / 1646 <= G.RENDER_MAX_RATIO);
  assert.ok(3840 / 1644 > G.RENDER_MAX_RATIO);
});

test('every side the caps allow is even', () => {
  for (const other of [480, 720, 1080, 1440, 2160, 2161, 3000, 3840]) {
    const side = G.renderFrameSide(other);
    assert.equal(side.min % 2, 0, 'min at ' + other);
    assert.equal(side.max % 2, 0, 'max at ' + other);
  }
});

test('the short side names the frame whichever way up it is', () => {
  // The one number that does not depend on orientation, which is why the second
  // preset row is named after it.
  assert.deepEqual(G.renderFrameFor(16 / 9, 2160), { width: 3840, height: 2160 });
  assert.deepEqual(G.renderFrameFor(9 / 16, 1080), { width: 1080, height: 1920 });
  assert.deepEqual(G.renderFrameFor(1, 1440), { width: 1440, height: 1440 });
});

test('21:9 reaches 2160p, which is what raising the ceiling to 5040 bought', () => {
  // The user reopened the 3840 cap to get this one: "if there is
  // resolution/pixels spare let it extend".
  assert.deepEqual(G.renderFrameFor(21 / 9, 2160), { width: 5040, height: 2160 });
  // And stood on its end, because the short side does not care which way up.
  assert.deepEqual(G.renderFrameFor(9 / 21, 2160), { width: 2160, height: 5040 });
});

test('a combination past the caps gives null rather than a clamped lie', () => {
  // A button that cannot do what its label says is disabled, not corrected.
  // Nothing the two rows offer is out of reach now, so this is the rule being
  // kept honest rather than a case the user can reach.
  assert.equal(G.renderFrameFor(16 / 9, 3000), null);
  assert.equal(G.renderFrameFor(0, 1080), null);
  assert.equal(G.renderFrameFor(16 / 9, 0), null);
});

test('every preset the app offers is either legal or refused, never out of range', () => {
  const ratios = [21 / 9, 16 / 9, 4 / 3, 1, 4 / 5, 3 / 4, 9 / 16];
  const shorts = [2160, 1440, 1080, 720, 480];
  for (const r of ratios) {
    for (const short of shorts) {
      const size = G.renderFrameFor(r, short);
      if (!size) continue;
      const lo = Math.min(size.width, size.height);
      const hi = Math.max(size.width, size.height);
      assert.ok(hi <= G.RENDER_MAX_SIDE, r + ' at ' + short + ' is ' + hi + ' long');
      assert.ok(lo <= G.RENDER_MAX_SHORT, r + ' at ' + short + ' is ' + lo + ' short');
      assert.ok(hi / lo <= G.RENDER_MAX_RATIO, r + ' at ' + short + ' is too wide');
      assert.equal(size.width % 2, 0);
      assert.equal(size.height % 2, 0);
      // And the short side really is the one the button is named after.
      assert.equal(lo, short);
    }
  }
});

test('a side the caps allow is a side the other axis accepts back', () => {
  // The two directions have to agree, or a frame could be dragged into a shape
  // that the opposite bar then refuses to leave alone.
  for (const other of [480, 1080, 2160, 3000, 3840]) {
    const side = G.renderFrameSide(other);
    for (const v of [side.min, side.max]) {
      const back = G.renderFrameSide(v);
      assert.ok(other >= back.min - 2 && other <= back.max + 2,
        other + ' against ' + v + ' giving ' + JSON.stringify(back));
    }
  }
});

test('resizeEdge takes a smallest side, which the crop popup leaves alone', () => {
  // V2.7. The render frame's shortest legal side depends on the other axis, so
  // it cannot be the constant the crop box uses.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, false, false, -5000, Infinity, 0, 400),
    { lo: 200, hi: 600 });
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, true, false, 5000, Infinity, 0, 400),
    { lo: 200, hi: 600 });
  // Left out, it is CROP_MIN, which is what every existing caller relies on.
  assert.deepEqual(G.resizeEdge(200, 600, EDGE_LIMIT, false, false, -5000),
    { lo: 200, hi: 200 + G.CROP_MIN });
});

// ---- renderReshape, V2.7: an aspect button extends ----

test('an aspect button grows the axis that has to change and leaves the other', () => {
  // The user's own example, on 2026-09-24: "if there is resolution/pixels spare
  // let it extend, e.g. 1080p from 1920x1080 at 16:9 to 2520x1080 at 21:9".
  assert.deepEqual(G.renderReshape({ width: 1920, height: 1080 }, 21 / 9),
    { width: 2520, height: 1080 });
  // The same the other way: a taller shape grows the height and keeps the width.
  assert.deepEqual(G.renderReshape({ width: 1920, height: 1080 }, 1),
    { width: 1920, height: 1920 });
});

test('it extends right up to the raised ceiling', () => {
  assert.deepEqual(G.renderReshape({ width: 3840, height: 2160 }, 21 / 9),
    { width: 5040, height: 2160 });
});

test('it cuts only when there is no room left to grow', () => {
  // 5040x2160 asked for 16:9 would want 2835 of height, past the short side
  // cap, so this one takes it out of the width instead.
  assert.deepEqual(G.renderReshape({ width: 5040, height: 2160 }, 16 / 9),
    { width: 3840, height: 2160 });
});

test('and falls back to the largest legal frame when neither will do', () => {
  const out = G.renderReshape({ width: 3840, height: 2160 }, 9 / 21);
  assert.deepEqual(out, G.renderLargest(9 / 21));
  assert.deepEqual(out, { width: 2160, height: 5040 });
});

test('whatever an aspect button returns is inside the caps', () => {
  const ratios = [21 / 9, 16 / 9, 4 / 3, 1, 4 / 5, 3 / 4, 9 / 16, 9 / 21];
  const starts = [
    { width: 1920, height: 1080 }, { width: 3840, height: 2160 },
    { width: 5040, height: 2160 }, { width: 480, height: 480 },
    { width: 1080, height: 1920 },
  ];
  for (const r of ratios) {
    for (const start of starts) {
      const out = G.renderReshape(start, r);
      assert.ok(out, r + ' from ' + start.width + 'x' + start.height);
      assert.ok(G.fitsCaps(out),
        r + ' from ' + start.width + 'x' + start.height + ' gave ' + JSON.stringify(out));
    }
  }
});

test('a frame nobody asked about is left alone rather than guessed at', () => {
  assert.equal(G.renderReshape(null, 16 / 9), null);
  assert.equal(G.renderReshape({ width: 1920, height: 1080 }, 0), null);
});

// ---- ratioResize, V2.1 step 21e-3 ----
//
// Shift and Ctrl held together on a bar or a corner. The shape is whatever
// preset is lit, or the box's own shape when none is, and what the drag asks
// for is a width: the height follows, so the two cannot disagree.

const CROP_BOUNDS = { minX: 0, maxX: 1280, minY: 0, maxY: 720 };
const CROP_START = { x: 200, y: 100, width: 400, height: 300 };

test('a corner holds the corner opposite it still', () => {
  // Bottom right dragged: the top left is where it was, and 16:9 of 800 is 450.
  assert.deepEqual(
    G.ratioResize(CROP_START, 16 / 9, { x: 'lo', y: 'lo' }, 800, CROP_BOUNDS, 16),
    { x: 200, y: 100, width: 800, height: 450 });
});

test('and the top left dragged keeps the bottom right where it was', () => {
  const out = G.ratioResize(CROP_START, 16 / 9, { x: 'hi', y: 'hi' }, 800, CROP_BOUNDS, 16);
  assert.equal(out.x + out.width, CROP_START.x + CROP_START.width);
  assert.equal(out.y + out.height, CROP_START.y + CROP_START.height);
  // 800 was more than the room to the top left corner of the frame allows, so
  // it stopped at what does fit rather than walking outside.
  assert.equal(out.x, 0);
  assert.deepEqual(out, { x: 0, y: 64, width: 600, height: 336 });
});

test('a bar grows about the middle of the axis it is not on', () => {
  // Otherwise changing the shape would slide the box up or down the frame,
  // which is not what dragging its right edge asked for.
  const out = G.ratioResize(CROP_START, 16 / 9, { x: 'lo', y: 'mid' }, 800, CROP_BOUNDS, 16);
  assert.equal(out.x, CROP_START.x);
  assert.equal(out.width, 800);
  assert.equal(out.height, 450);
  const centre = (r) => r.y + r.height / 2;
  assert.ok(Math.abs(centre(out) - centre(CROP_START)) <= 1, 'still on the same line');
});

test('the axis that runs out first is what stops the other one', () => {
  // The centre is pinned at 250 with the frame's top at 0, so the height can
  // reach 500 and no more, and 500 of 16:9 is 888 across. The width's own room
  // was 1080, which never gets a say.
  const out = G.ratioResize(CROP_START, 16 / 9, { x: 'lo', y: 'mid' }, 5000, CROP_BOUNDS, 16);
  assert.deepEqual(out, { x: 200, y: 0, width: 888, height: 498 });
  assert.ok(out.y >= 0 && out.y + out.height <= 720, 'inside the frame');
});

test('a tall shape is held by the height and a wide one by the width', () => {
  const tall = G.ratioResize(CROP_START, 9 / 16, { x: 'lo', y: 'lo' }, 5000, CROP_BOUNDS, 16);
  assert.ok(tall.y + tall.height <= 720, 'the bottom of the frame stopped it');
  assert.equal(tall.width, 348);
  assert.equal(tall.height, 618);
  const square = G.ratioResize(CROP_START, 1, { x: 'lo', y: 'mid' }, 600, CROP_BOUNDS, 16);
  assert.equal(square.width, square.height);
});

test('both sides come back even, because there is no odd frame to encode', () => {
  for (const want of [301, 302, 303, 477, 999]) {
    const out = G.ratioResize(CROP_START, 16 / 9, { x: 'lo', y: 'lo' }, want, CROP_BOUNDS, 16);
    assert.equal(out.width % 2, 0, 'width ' + out.width);
    assert.equal(out.height % 2, 0, 'height ' + out.height);
    assert.equal(out.x % 2, 0, 'x ' + out.x);
    assert.equal(out.y % 2, 0, 'y ' + out.y);
  }
});

test('the smallest box is the floor, whatever the drag asks for', () => {
  const out = G.ratioResize(CROP_START, 16 / 9, { x: 'lo', y: 'lo' }, 0, CROP_BOUNDS, 16);
  assert.ok(out.width >= 16 && out.height >= 16);
  assert.deepEqual(G.ratioResize(CROP_START, 16 / 9, { x: 'lo', y: 'lo' }, -500, CROP_BOUNDS, 16),
    out);
});

test('no shape to hold is no answer rather than a wrong one', () => {
  assert.equal(G.ratioResize(CROP_START, 0, { x: 'lo', y: 'lo' }, 400, CROP_BOUNDS, 16), null);
  assert.equal(G.ratioResize(CROP_START, NaN, { x: 'lo', y: 'lo' }, 400, CROP_BOUNDS, 16), null);
  assert.equal(G.ratioResize(null, 16 / 9, { x: 'lo', y: 'lo' }, 400, CROP_BOUNDS, 16), null);
});

test('a frame that may reach outside the picture takes negative bounds', () => {
  // 21e lets the crop leave the source, so minX and minY are not zero any more.
  const out = G.ratioResize({ x: 0, y: 0, width: 1280, height: 720 }, 9 / 16,
    { x: 'mid', y: 'mid' }, 1280, { minX: -1920, maxX: 3200, minY: -1080, maxY: 1800 }, 16);
  assert.equal(out.width, 1280);
  assert.equal(out.height, 2274);
  // Centred on the picture it started from, which is what a 9:16 frame around a
  // 16:9 clip has to be. Within a pixel, not exactly: y has to be even and half
  // of 2274 is odd, so the two cannot both be had.
  assert.equal(out.x, 0);
  assert.ok(Math.abs(out.y + out.height / 2 - 360) <= 1,
    'centred on ' + (out.y + out.height / 2));
  // Math.abs because -778 % 2 is -0, and a negative y is ordinary now.
  assert.equal(Math.abs(out.y % 2), 0);
});

// ---- sideFraction, V2.1 step 21c-3 ----
//
// The three preview columns are laid out as `side 1fr side`, so one number does
// both edges. span is the grid's width less its two gaps, because gaps come out
// before the fr units are worked out. The floors are measured in the running
// app rather than written down: the side column holds a fixed-width time field
// and comes to 130 in either language, and the middle holds three buttons and
// comes to 186 in English and 270 in German.

const SIDE_SPAN = 920;
const SIDE_MIN = 130;
const MIDDLE_MIN = 270;
// What a fraction actually lays out as, which is what the assertions are about.
const columns = (s, span = SIDE_SPAN) => ({
  side: Math.round((span * s) / (2 * s + 1)),
  middle: Math.round(span / (2 * s + 1)),
});

test('one fr each is three equal columns, which is where the grid starts', () => {
  const at = columns(1);
  assert.equal(at.side, 307);
  assert.equal(at.middle, 307);
  // And asking for exactly what it already is comes back as what it already is.
  assert.equal(columns(G.sideFraction(307, SIDE_SPAN, SIDE_MIN, MIDDLE_MIN)).side, 307);
});

test('a side dragged narrower hands the whole of it to the middle', () => {
  const at = columns(G.sideFraction(200, SIDE_SPAN, SIDE_MIN, MIDDLE_MIN));
  assert.equal(at.side, 200);
  // 920 less two sides of 200. Both edges moved, because there is one number.
  assert.equal(at.middle, 520);
});

test('the sides stop where their own contents do', () => {
  for (const want of [130, 60, 0, -200]) {
    const at = columns(G.sideFraction(want, SIDE_SPAN, SIDE_MIN, MIDDLE_MIN));
    assert.equal(at.side, 130, 'asked for ' + want);
  }
});

test('and they stop again where the middle would lose its own', () => {
  const at = columns(G.sideFraction(400, SIDE_SPAN, SIDE_MIN, MIDDLE_MIN));
  assert.equal(at.middle, MIDDLE_MIN);
  assert.equal(at.side, 325);
  // 325 is the widest a side can be: two of them plus the middle's floor is
  // exactly the span.
  assert.equal(2 * at.side + at.middle, SIDE_SPAN);
});

test('the clamp does not move a second time, which is what lets it re-run', () => {
  const once = G.sideFraction(400, SIDE_SPAN, SIDE_MIN, MIDDLE_MIN);
  const side = columns(once).side;
  assert.equal(columns(G.sideFraction(side, SIDE_SPAN, SIDE_MIN, MIDDLE_MIN)).side, side);
});

test('a grid with nothing left to divide gives no fraction rather than a bad one', () => {
  // The caller leaves the stylesheet's own three-way split alone, which is the
  // right answer for a window too narrow to be split at all.
  assert.equal(G.sideFraction(300, 200, SIDE_MIN, MIDDLE_MIN), null);
  assert.equal(G.sideFraction(300, 0, SIDE_MIN, MIDDLE_MIN), null);
});

test('floors that cross are settled in the sides favour', () => {
  // 500 of span against floors of 130 and 270: two sides and a middle do not
  // fit. The sides keep theirs, because the middle is a picture and can be
  // small, while a side is a picture plus a field that has a width of its own.
  const at = columns(G.sideFraction(90, 500, SIDE_MIN, MIDDLE_MIN), 500);
  assert.equal(at.side, 130);
  assert.equal(at.middle, 240);
});

// --- alphaRow, V2.5 ---------------------------------------------------------
//
// The row an alpha line is drawn on. Four drawings read it and they all have to
// agree, so what these check is the agreement rather than any one of them.

test('a whole layer draws its line on the clip first row', () => {
  assert.equal(G.alphaRow(64, 1), 0);
});

test('a layer at nothing draws its line on the clip last row, not past it', () => {
  // V2.4 used the span itself, which put 0% one row below the clip, where it
  // was cut off and seen by nobody. 64 pixels are rows 0 to 63.
  assert.equal(G.alphaRow(64, 0), 63);
});

test('half way up is half way down the clip', () => {
  assert.equal(G.alphaRow(65, 0.5), 32);
  assert.equal(G.alphaRow(64, 0.5), 31.5);
});

test('the row moves in a straight line, because the ramp it caps does', () => {
  // The fade ramp ends on this row and the ramp is linear. A row that was not
  // would meet the line at the ends and miss it everywhere in between.
  const mid = G.alphaRow(101, 0.5);
  assert.equal(mid, (G.alphaRow(101, 0) + G.alphaRow(101, 1)) / 2);
});

test('an alpha outside the range is held at the edges of the clip', () => {
  // setAlpha clamps, but this is read from a layer that was written anywhere,
  // and a line drawn off the clip is a line nobody can see.
  assert.equal(G.alphaRow(64, 4), 0);
  assert.equal(G.alphaRow(64, -2), 63);
});

test('a missing alpha reads as whole, the way the model reads it', () => {
  // timelineModel.alphaOf defaults to 1 and this has to agree with it, or a
  // layer with no alpha set would draw its line somewhere other than the top.
  assert.equal(G.alphaRow(64, undefined), 0);
  assert.equal(G.alphaRow(64, NaN), 0);
});

test('a clip with no height has no rows rather than a negative one', () => {
  for (const span of [1, 0, -5]) assert.equal(G.alphaRow(span, 0), 0);
});

// --- anchorCentre, the nine rings on the Render Position tab -----------------

// The user's rule, in their own words: "a click on left-top is the only one
// that positions it at 0, 0. Other circle clicks must position the bottom or
// right of the image so that they are not cut off but exactly at the edge(s)".
// Which is a statement about edges, so these check edges rather than centres.
const corner = (a, span, size) => G.anchorCentre(a, span, size) - size / 2;

test('the near anchor is the only one that lands on zero', () => {
  assert.equal(corner(0, 1920, 640), 0);
  assert.notEqual(corner(1, 1920, 640), 0);
  assert.notEqual(corner(0.5, 1920, 640), 0);
});

test('the far anchor puts the far edge on the edge, not past it', () => {
  const near = corner(1, 1920, 640);
  assert.equal(near, 1280);
  assert.equal(near + 640, 1920);
});

test('the middle anchor leaves the same room on both sides', () => {
  assert.equal(corner(0.5, 1920, 640), 640);
  assert.equal(corner(0.5, 1920, 640) + 640, 1920 - 640);
});

test('a picture the size of the frame is at zero whichever corner is asked for', () => {
  for (const a of [0, 0.5, 1]) assert.equal(corner(a, 1920, 1920), 0);
});

test('a picture larger than the frame keeps the anchored edge and hangs off the other', () => {
  // Scaling past 100% is allowed, and a corner click on one still means that
  // corner: the right edge is on the right edge and the left is off to the left.
  assert.equal(corner(1, 1920, 2400) + 2400, 1920);
  assert.equal(corner(0, 1920, 2400), 0);
});

test('the ring is inset from the stage by the gap plus its own radius', () => {
  // How the rings are placed: a span of twice the inset plus the radius, so
  // one call does both the drawing and the placing.
  const span = 2 * (10 + 9);
  assert.equal(G.anchorCentre(0, 600, span), 19);
  assert.equal(G.anchorCentre(1, 600, span), 581);
  assert.equal(G.anchorCentre(0.5, 600, span), 300);
});

// --- the Render Position scale slider, V2.8 item 12 -------------------------

test('a slider position below the knee is the percentage itself', () => {
  for (const pos of [1, 2, 37, 100, 199, 200]) {
    assert.equal(G.scaleFromSlider(pos), pos);
  }
});

test('the knee sits at exactly half the slider', () => {
  assert.equal(G.PLACE_SLIDER_MAX, G.PLACE_SCALE_KNEE * 2);
  assert.equal(G.scaleFromSlider(G.PLACE_SLIDER_MAX / 2), G.PLACE_SCALE_KNEE);
});

test('the two ends are the two ends', () => {
  assert.equal(G.scaleFromSlider(1), G.PLACE_SCALE_MIN);
  assert.equal(G.scaleFromSlider(G.PLACE_SLIDER_MAX), G.PLACE_SCALE_MAX);
});

test('the jumps above the knee grow rather than staying even', () => {
  const at = (p) => G.scaleFromSlider(p);
  const low = at(210) - at(209);
  const mid = at(300) - at(299);
  const high = at(400) - at(399);
  assert.ok(low < mid && mid < high,
    'each step is bigger than the last: ' + [low, mid, high].join(' '));
  // And still fine enough at the bottom of the upper half to be usable: a
  // couple of percent a step, not twenty.
  assert.ok(low <= 3, 'the first step past the knee is small: ' + low);
});

test('the scale never goes backwards as the handle goes forwards', () => {
  let last = 0;
  for (let pos = 1; pos <= G.PLACE_SLIDER_MAX; pos += 1) {
    const now = G.scaleFromSlider(pos);
    assert.ok(now >= last, 'position ' + pos + ' gave ' + now + ' after ' + last);
    last = now;
  }
});

test('every position survives the round trip, so the handle never jumps', () => {
  // The one property the pair has to have. showPlaceScale writes the handle
  // from the percentage it just read off the handle, so a position that does
  // not come back is a handle that moves on its own under the hand.
  for (let pos = 1; pos <= G.PLACE_SLIDER_MAX; pos += 1) {
    assert.equal(G.sliderFromScale(G.scaleFromSlider(pos)), pos);
  }
});

test('a percentage from outside the range is held inside it', () => {
  assert.equal(G.sliderFromScale(0), G.PLACE_SCALE_MIN);
  assert.equal(G.sliderFromScale(-40), G.PLACE_SCALE_MIN);
  assert.equal(G.sliderFromScale(99999), G.PLACE_SLIDER_MAX);
  assert.equal(G.scaleFromSlider(9999), G.PLACE_SCALE_MAX);
  assert.equal(G.scaleFromSlider(-3), G.PLACE_SCALE_MIN);
  for (const bad of [NaN, undefined, 'x', {}]) {
    assert.equal(G.scaleFromSlider(bad), G.PLACE_SCALE_KNEE);
    assert.equal(G.sliderFromScale(bad), G.PLACE_SCALE_KNEE);
  }
  // null and an emptied box are not nothing, they are zero: Number(null) is 0
  // and finite() takes it. So they land on the floor rather than on the
  // fallback, which is worth saying out loud rather than leaving to be found.
  assert.equal(G.scaleFromSlider(null), G.PLACE_SCALE_MIN);
  assert.equal(G.sliderFromScale(''), G.PLACE_SCALE_MIN);
});

// ---- V3, 31a. The text box ----

const BOX = { x: 100, y: 100, w: 400, h: 200 };

test('textBoxEdge moves one side and leaves the others', () => {
  assert.deepEqual(G.textBoxEdge(BOX, 'right', 50.4, false, SMALL).box, { x: 100, y: 100, w: 450, h: 200 });
  assert.deepEqual(G.textBoxEdge(BOX, 'left', -30, false, SMALL).box, { x: 70, y: 100, w: 430, h: 200 });
  assert.deepEqual(G.textBoxEdge(BOX, 'top', 20, false, SMALL).box, { x: 100, y: 120, w: 400, h: 180 });
  assert.deepEqual(G.textBoxEdge(BOX, 'bottom', -20, false, SMALL).box, { x: 100, y: 100, w: 400, h: 180 });
});

test('textBoxEdge holds to the frame and to the least size', () => {
  assert.equal(G.textBoxEdge(BOX, 'left', -500, false, SMALL).box.x, 0);
  assert.equal(G.textBoxEdge(BOX, 'right', 5000, false, SMALL).box.w, 1280 - 100);
  const shut = G.textBoxEdge(BOX, 'right', -1000, false, SMALL).box;
  assert.equal(shut.w, G.TEXT_BOX_MIN);
  assert.equal(shut.x, 100);
  assert.equal(G.textBoxEdge(BOX, 'top', 1000, false, SMALL).box.h, G.TEXT_BOX_MIN);
});

test('textBoxEdge mirrored keeps the centre, whole pixels, and stops at the nearer edge', () => {
  const r = G.textBoxEdge(BOX, 'right', 30, true, SMALL).box;
  assert.deepEqual(r, { x: 70, y: 100, w: 460, h: 200 });
  const l = G.textBoxEdge(BOX, 'left', 10, true, SMALL).box;
  assert.deepEqual(l, { x: 110, y: 100, w: 380, h: 200 });
  // Centre 300 is 300 from the left edge, so the pair stops there.
  assert.deepEqual(G.textBoxEdge(BOX, 'right', 900, true, SMALL).box, { x: 0, y: 100, w: 600, h: 200 });
  const tight = G.textBoxEdge(BOX, 'right', -900, true, SMALL).box;
  assert.equal(tight.w, G.TEXT_BOX_MIN);
  assert.equal(tight.x + tight.w / 2, 300);
  // An odd sum stays about its half pixel centre.
  const odd = G.textBoxEdge({ x: 101, y: 0, w: 400, h: 50 }, 'right', 7.3, true, SMALL).box;
  assert.equal(odd.x + odd.x + odd.w, 101 + 501);
  assert.ok(Number.isInteger(odd.x) && Number.isInteger(odd.w));
});

test('textBoxEdge snaps a side onto the frame edges and middle within reach', () => {
  const mid = G.textBoxEdge(BOX, 'right', 136, false, SMALL, 8);
  assert.equal(mid.box.x + mid.box.w, 640);
  assert.equal(mid.snap, 640);
  const edge = G.textBoxEdge(BOX, 'left', -95, false, SMALL, 8);
  assert.equal(edge.box.x, 0);
  assert.equal(edge.snap, 0);
  const none = G.textBoxEdge(BOX, 'right', 120, false, SMALL, 8);
  assert.equal(none.box.x + none.box.w, 620);
  assert.equal(none.snap, null);
  assert.equal(G.textBoxEdge(BOX, 'right', 136, false, SMALL, 0).snap, null);
});

test('textBoxMove moves, holds to the frame, and snaps edges and centre', () => {
  assert.deepEqual(G.textBoxMove(BOX, 10.4, -20, SMALL).box, { x: 110, y: 80, w: 400, h: 200 });
  assert.deepEqual(G.textBoxMove(BOX, -900, 900, SMALL).box, { x: 0, y: 520, w: 400, h: 200 });
  // Centre 300 + 336 = 636, four off the middle: it lands on 640.
  const c = G.textBoxMove(BOX, 336, 0, SMALL, 8);
  assert.equal(c.box.x + c.box.w / 2, 640);
  assert.equal(c.snapX, 640);
  assert.equal(c.snapY, null);
  const top = G.textBoxMove(BOX, 0, -94, SMALL, 8);
  assert.equal(top.box.y, 0);
  assert.equal(top.snapY, 0);
  const bottom = G.textBoxMove(BOX, 0, 415, SMALL, 8);
  assert.equal(bottom.box.y + bottom.box.h, 720);
  assert.equal(bottom.snapY, 720);
  // A box wider than the frame could never be held inside it; it sits at 0.
  assert.equal(G.textBoxMove({ x: 0, y: 0, w: 2000, h: 10 }, 50, 0, SMALL).box.x, 0);
});

test('isWholeBox: none, or the frame to the pixel', () => {
  assert.equal(G.isWholeBox(null, SMALL), true);
  assert.equal(G.isWholeBox({ x: 0, y: 0, w: 1280, h: 720 }, SMALL), true);
  assert.equal(G.isWholeBox({ x: 0.2, y: 0, w: 1279.9, h: 720 }, SMALL), true);
  assert.equal(G.isWholeBox({ x: 0, y: 0, w: 1279, h: 720 }, SMALL), false);
});

// ---- 31b, rotation ----

test('textTurn: whole degrees in (-180, 180], on a quarter turn within 2', () => {
  // The user's figures.
  assert.equal(G.textTurn(88), 90);
  assert.equal(G.textTurn(92), 90);
  assert.equal(G.textTurn(87), 87);
  assert.equal(G.textTurn(93), 93);
  assert.equal(G.textTurn(1.6), 0);
  assert.equal(G.textTurn(-2), 0);
  assert.equal(G.textTurn(-3), -3);
  assert.equal(G.textTurn(-89), -90);
  // Round the back: -180 is 180, and so is anything within 2 of it.
  assert.equal(G.textTurn(-180), 180);
  assert.equal(G.textTurn(-178.6), 180);
  assert.equal(G.textTurn(181), 180);
  assert.equal(G.textTurn(185), -175);
  assert.equal(G.textTurn(450), 90);
  assert.equal(G.textTurn(44.4), 44);
  assert.ok(Object.is(G.textTurn(-0.4), 0));
});

test('textTurnDrag: how far the pointer went round the centre, clockwise positive', () => {
  // From the right to straight down is a quarter turn clockwise on a screen.
  assert.equal(G.textTurnDrag(0, [10, 0], [0, 10]), 90);
  assert.equal(G.textTurnDrag(30, [10, 0], [0, -10]), -60);
  // Across the back, where atan2 jumps.
  assert.equal(G.textTurnDrag(170, [-10, 1], [-10, -1]), 180);
  assert.equal(G.textTurnDrag(0, [-10, 1], [-10, -3]), 22);
  // Near a quarter turn it lands on it.
  const a = Math.atan2(10, Math.tan(Math.PI / 180 * 1.5) * 10);
  assert.equal(G.textTurnDrag(0, [10, 0], [Math.cos(a), Math.sin(a)]), 90);
});

test('textBoxEdgeTurned: the opposite side stays put on the screen', () => {
  const box = { x: 100, y: 100, w: 400, h: 200 };
  const frame = { width: 1280, height: 720 };
  // Not turned it is the plain resize.
  assert.deepEqual(G.textBoxEdgeTurned(box, 'right', 50, false, 0, frame).box, { x: 100, y: 100, w: 450, h: 200 });
  assert.deepEqual(G.textBoxEdgeTurned(box, 'left', -50, false, 0, frame).box, { x: 50, y: 100, w: 450, h: 200 });
  // A quarter turn clockwise: the box's right side faces down, so growing it
  // moves the centre down and leaves the left side (now the top) where it was.
  const r = G.textBoxEdgeTurned(box, 'right', 100, false, 90, frame).box;
  assert.deepEqual(r, { x: 50, y: 150, w: 500, h: 200 });
  const top = (b) => b.y + b.h / 2 - b.w / 2;
  assert.equal(top(r), top(box));
  // And the top side, turned, faces right: growing it outwards (a negative delta)
  // moves the centre left.
  assert.deepEqual(G.textBoxEdgeTurned(box, 'top', -40, false, 90, frame).box, { x: 120, y: 80, w: 400, h: 240 });
  // Mirrored, the centre holds.
  const m = G.textBoxEdgeTurned(box, 'right', 30, true, 37, frame).box;
  assert.deepEqual([m.x + m.w / 2, m.y + m.h / 2, m.w], [300, 200, 460]);
  // Never below the least size.
  assert.equal(G.textBoxEdgeTurned(box, 'right', -1000, false, 45, frame).box.w, G.TEXT_BOX_MIN);
});

test('textBoxMoveTurned: the centre snaps and stays in the frame', () => {
  const frame = { width: 1280, height: 720 };
  const box = { x: 100, y: 100, w: 400, h: 200 };
  const r = G.textBoxMoveTurned(box, 337, 157, frame, 5);
  assert.deepEqual(r.box, { x: 440, y: 260, w: 400, h: 200 });
  assert.deepEqual([r.snapX, r.snapY], [640, 360]);
  // The centre held on the frame's edge, the box half off it.
  const off = G.textBoxMoveTurned(box, -900, 0, frame, 0);
  assert.equal(off.box.x + off.box.w / 2, 0);
  assert.equal(off.snapX, null);
});
