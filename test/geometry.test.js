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
