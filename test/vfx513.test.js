'use strict';

// V5.1.3 and V5.1.4. Where a kind acts: not every kind has an area of any
// shape with a soft edge any more. A kind for the whole picture has nothing
// to place, a look has a box, a kind aimed at a thing a rectangle or a
// circle, the two that cover a thing up any shape, and a kind that bends the
// picture about a point has the point, which a keyframe holds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const O = require('../src/vfxOps');
const D = require('../src/genDraw');
const P = require('../src/project');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HD = { width: 1920, height: 1080, fps: 30 };
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const SPOT = { x: 0.5, y: 0, w: 0.5, h: 0.5 };
const LUT = { file: 'C:/luts/a.cube' };
const now = (kind, more = {}, t = 0) => T.vfxAt(T.vfxOf({ kind, ...(kind === 'lut' ? LUT : {}), ...more }), t);
const by = (where) => T.VFX_KIND_IDS.filter((k) => T.vfxKind(k).where === where);
const ids = (list) => list.map((s) => s.id);

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

// A context that writes down what is filled, and in which way.
function maskCtx() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    save() {},
    restore() { this.globalCompositeOperation = 'source-over'; },
    clearRect() {},
    fillRect(...a) { calls.push(['fillRect', this.globalCompositeOperation, ...a]); },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    ellipse(...a) { calls.push(['ellipse', ...a]); },
    arcTo() {},
    bezierCurveTo() {},
    fill() { calls.push(['fill']); },
  };
}

// ---- the table ----

test('every kind says where it acts, and the kinds are sorted as the user was shown', () => {
  assert.deepEqual(by('any'), ['obscure', 'pixelate']);
  assert.deepEqual(by('whole').sort(),
    ['bars', 'border', 'chromakey', 'cornerpin', 'crt', 'echo', 'flip', 'gravity', 'lens', 'lumakey', 'offset', 'perspective', 'polar', 'rotate', 'shake', 'strobe', 'tile']);
  assert.deepEqual(by('point').sort(), ['bulge', 'kaleido', 'swirl']);
  assert.deepEqual(by('two').sort(), ['brightness', 'clarity', 'curves', 'dirblur', 'exposure', 'haze', 'huesat', 'levels', 'rgb',
    'ripple', 'shadows', 'sharpen', 'temperature', 'tiltshift', 'vibrance', 'vignette', 'zoom']);
  assert.deepEqual(by('box').sort(), ['channels', 'colorize', 'colorpass', 'comic', 'dream', 'duotone', 'edges', 'emboss',
    'glitch', 'glow', 'grain', 'halftone', 'invert', 'look', 'lut', 'mono', 'nightvision', 'oldfilm', 'posterize', 'rgbsplit',
    'scanlines', 'sepia', 'solarize', 'splittone', 'thermal', 'threshold', 'vhs', 'wave']);
  assert.equal(T.VFX_KIND_IDS.every((k) => ['any', 'whole', 'point', 'two', 'box'].includes(T.vfxKind(k).where)), true);
});

test('a kind for the whole picture has no area, no shape, no Invert and no soft edge', () => {
  for (const kind of [...by('whole'), ...by('point')]) {
    const def = T.vfxKind(kind);
    assert.equal(def.area, false, kind);
    const all = ids([...def.statics, ...def.keyed]);
    for (const id of ['shape', 'invert', 'soft']) assert.equal(all.includes(id), false, kind + '.' + id);
    // V5.4. All but a key, which is on the whole clip long.
    // Gravity (5.3.0). Nor one that moves the picture, which starts at a keyframe.
    assert.equal(all.includes('mix'), !T.vfxKind(kind).moves && (!T.vfxKind(kind).alpha || kind === 'cornerpin'), kind + ': Mix is how keyframes switch it off and on');
    assert.equal(T.vfxKeyedIds(kind).includes('box'), false, kind);
    assert.equal(T.vfxKeyedIds(kind).includes('rotation'), false, kind);
    // One kept with an area from before has none any more.
    const kept = T.vfxOf({ kind, shape: 'star', invert: true, soft: 0.1, box: SPOT, rotation: 30 });
    for (const id of ['shape', 'invert', 'soft', 'box', 'rotation']) assert.equal(id in kept, false, kind + '.' + id);
  }
});

test('a look has a box to move, size and turn, with Invert and no choice of shape', () => {
  for (const kind of by('box')) {
    const def = T.vfxKind(kind);
    assert.equal(def.area, true, kind);
    assert.equal(def.fill, true, kind + ': it starts on all of the picture');
    assert.equal(ids(def.statics).includes('shape'), false, kind);
    assert.equal(ids(def.statics)[def.statics.length - 1], 'invert', kind);
    assert.deepEqual(T.vfxKeyedIds(kind).slice(0, 2), ['box', 'rotation'], kind);
    // A shape it was kept with is dropped, and it is drawn as a square.
    assert.equal('shape' in T.vfxOf({ kind, shape: 'heart' }), false, kind);
    assert.equal(now(kind, { shape: 'heart', box: SPOT }).areas[0].kind, 'square', kind);
  }
});

test('a kind aimed at a thing is a rectangle or a circle, and nothing else', () => {
  assert.deepEqual(T.VFX_TWO_SHAPES, ['square', 'circle']);
  for (const kind of by('two')) {
    const def = T.vfxKind(kind);
    const shape = def.statics.find((s) => s.id === 'shape');
    assert.deepEqual(shape.options, T.VFX_TWO_SHAPES, kind);
    assert.equal(T.vfxOf({ kind, shape: 'circle' }).shape, 'circle', kind);
    assert.equal(T.vfxOf({ kind, shape: 'star' }).shape, shape.def, kind + ': a shape it does not offer is the one it starts with');
    assert.equal(now(kind, { shape: 'circle', box: SPOT }).areas[0].kind, 'circle', kind);
  }
  assert.equal(T.vfxOf({ kind: 'vignette' }).shape, 'circle');
  assert.equal(T.vfxOf({ kind: 'vignette', shape: 'heart' }).shape, 'circle');
  // What a new one starts with, which the window reads off the table.
  const starts = (kind, id) => T.vfxKind(kind).statics.find((s) => s.id === id).def;
  assert.equal(starts('tiltshift', 'invert'), true, 'the band is the sharp part');
  assert.equal(starts('vignette', 'invert'), true, 'dark outside the circle');
  assert.equal(starts('brightness', 'invert'), false);
});

test('the two that cover a thing up keep every shape', () => {
  for (const kind of by('any')) {
    const shape = T.vfxKind(kind).statics.find((s) => s.id === 'shape');
    assert.equal(shape.options, undefined, kind);
    for (const s of T.SHAPE_KINDS) assert.equal(T.vfxOf({ kind, shape: s }).shape, s, kind + '.' + s);
  }
});

test('a soft edge goes with an area, but not where the effect moves the picture far', () => {
  const soft = (kind) => ids(T.vfxKind(kind).keyed).includes('soft');
  for (const kind of T.VFX_KIND_IDS) {
    const def = T.vfxKind(kind);
    const want = def.area && !['zoom', 'glitch'].includes(kind);
    assert.equal(soft(kind), want, kind);
  }
  // One kept with a soft edge from before has a hard one.
  assert.equal('soft' in T.vfxOf({ kind: 'zoom', soft: 0.1 }), false);
  assert.equal(now('zoom', { soft: 0.1 }).soft, 0);
  assert.equal(now('glitch', { soft: 0.1 }).soft, 0);
  // The ones that start soft still do.
  assert.equal(T.vfxOf({ kind: 'vignette' }).soft, 0.2);
  assert.equal(T.vfxOf({ kind: 'tiltshift' }).soft, 0.12);
});

// ---- what every drawing reads ----

test('what a kind does not offer stands as plain: a square, not inverted, a hard edge, all of the picture', () => {
  for (const kind of T.VFX_KIND_IDS) {
    const at = now(kind, { box: SPOT });
    assert.equal(typeof at.shape, 'string', kind);
    assert.equal(typeof at.invert, 'boolean', kind);
    assert.equal(typeof at.soft, 'number', kind);
    assert.equal(at.areas.length, 1, kind);
    const def = T.vfxKind(kind);
    assert.deepEqual(at.areas[0].box, def.area ? SPOT : FULL, kind);
    if (!def.area) {
      assert.deepEqual([at.shape, at.invert, at.soft, at.areas[0].kind, at.areas[0].rotation], ['square', false, 0, 'square', 0], kind);
      assert.equal(T.vfxCoversAll(at), true, kind);
      // So the part the export filters is all of the picture, and the drawing of where it acts all white.
      assert.deepEqual(D.coverRegion(at, 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 }, kind);
      const ctx = maskCtx();
      D.drawCoverMask(ctx, at, 1000, 500, null);
      assert.deepEqual(ctx.calls.filter((c) => c[0] === 'lineTo').map((c) => [c[1], c[2]]), [[1000, 0], [1000, 500], [0, 500]], kind);
      assert.equal(ctx.calls.some((c) => c[0] === 'fillRect'), false, kind + ': not turned round, Mix whole');
    }
  }
});

test('a kind with no area changes where it acts only by Mix', () => {
  const l = vid({ duration: 2 });
  const still = T.vfxOf({ kind: 'bars' });
  assert.equal(T.vfxMotion(l, still), null);
  const faded = T.vfxOf({ kind: 'bars', keys: [{ t: 0, size: 0.1, mix: 0 }, { t: 1, size: 0.1, mix: 100 }] });
  assert.deepEqual(T.vfxMotion(l, faded), { from: 0, to: 1 });
  // Its own figure keyed is a step a frame, and no move of where it acts.
  const grown = T.vfxOf({ kind: 'bars', keys: [{ t: 0, size: 0, mix: 100 }, { t: 1, size: 0.2, mix: 100 }] });
  assert.equal(T.vfxMotion(l, grown), null);
  assert.ok(T.vfxRuns(l, grown, 30).length > 20);
});

// ---- V5.1.4. the point ----

test('a kind about a point has the point as two figures a keyframe holds, starting on the middle', () => {
  for (const kind of by('point')) {
    const def = T.vfxKind(kind);
    const cx = def.keyed.find((s) => s.id === 'cx');
    const cy = def.keyed.find((s) => s.id === 'cy');
    assert.deepEqual([cx.min, cx.max, cx.def, cx.of, cx.in], [0, 1, 0.5, 'width', 'filter'], kind);
    assert.deepEqual([cy.min, cy.max, cy.def, cy.of, cy.in], [0, 1, 0.5, 'height', 'filter'], kind);
    const v = T.vfxOf({ kind });
    assert.deepEqual([v.cx, v.cy], [0.5, 0.5], kind);
    // Held to the picture.
    const out = T.vfxOf({ kind, cx: 3, cy: -1 });
    assert.deepEqual([out.cx, out.cy], [1, 0], kind);
    assert.equal(T.vfxKeyedIds(kind).includes('cx') && T.vfxKeyedIds(kind).includes('cy'), true, kind);
  }
  // Only they have one.
  for (const kind of T.VFX_KIND_IDS.filter((k) => !by('point').includes(k))) {
    assert.equal(ids(T.vfxKind(kind).keyed).includes('cx'), false, kind);
  }
});

test('the point is what the picture is bent about, and it blends between keyframes', () => {
  assert.deepEqual(O.midOf({ cx: 0.25, cy: 0.75, areas: [{ box: FULL }] }, 1920, 1080), { cx: 479.5, cy: 809.5 });
  assert.deepEqual(O.midOf({ cx: 0.5, cy: 0.5 }, 1920, 1080), { cx: 959.5, cy: 539.5 });
  const moving = T.vfxOf({ kind: 'bulge', keys: [
    { t: 0, amount: 60, radius: 0.35, cx: 0.2, cy: 0.2, mix: 100 },
    { t: 1, amount: 60, radius: 0.35, cx: 0.8, cy: 0.6, mix: 100 },
  ] });
  const mid = T.vfxAt(moving, 0.5);
  assert.ok(Math.abs(mid.cx - 0.5) < 1e-9 && Math.abs(mid.cy - 0.4) < 1e-9);
  const op = O.opsOf('bulge', mid, 1920, 1080)[0];
  assert.deepEqual([op.cx, op.cy], [959.5, 431.5]);
  // A point that moves is a figure for every place, like any figure of the filter.
  const l = vid({ duration: 1 });
  assert.equal(T.vfxRuns(l, moving, 30).length, 30);
  // And no move of where it acts: that stays all of the picture.
  assert.equal(T.vfxMotion(l, moving), null);
  assert.equal(T.vfxMoves(moving), true);
});

test('a kind about a point kept with an area from before stays about that area\'s middle', () => {
  for (const kind of by('point')) {
    const v = T.vfxOf({ kind, box: SPOT, shape: 'circle', keys: [
      { t: 0, box: SPOT, rotation: 0, mix: 100, soft: 0 },
      { t: 1, box: { x: 0, y: 0.5, w: 0.5, h: 0.5 }, rotation: 0, mix: 100, soft: 0 },
    ] });
    assert.deepEqual([v.cx, v.cy], [0.75, 0.25], kind);
    assert.deepEqual(v.keys.map((k) => [k.cx, k.cy]), [[0.75, 0.25], [0.25, 0.75]], kind);
    assert.equal('box' in v || 'box' in v.keys[0], false, kind);
    // Its own point wins over a box beside it.
    const own = T.vfxOf({ kind, box: SPOT, cx: 0.1, cy: 0.9 });
    assert.deepEqual([own.cx, own.cy], [0.1, 0.9], kind);
  }
});

test('a project keeps a point and its keyframes through a save and an open', () => {
  const l = vid({ vfx: [
    { kind: 'swirl', cx: 0.3, cy: 0.7, keys: [
      { id: 'a', t: 0, angle: 120, radius: 0.6, cx: 0.3, cy: 0.7, mix: 100 },
      { id: 'b', t: 2, angle: -90, radius: 0.2, cx: 0.9, cy: 0.1, mix: 50 },
    ] },
    { kind: 'bars', vertical: true, size: 0.2 },
    { kind: 'brightness', shape: 'circle', box: SPOT },
  ] });
  const out = P.parse(P.stringify(P.serialise({ layers: [l], project: HD, trim: { start: 0, end: 10 } })));
  assert.equal(out.ok, true);
  const back = T.createLayer(out.doc.layers[0]).vfx;
  assert.deepEqual(back, l.vfx);
  assert.deepEqual(back[0].keys.map((k) => [k.cx, k.cy]), [[0.3, 0.7], [0.9, 0.1]]);
  assert.equal(back[2].shape, 'circle');
});

// ---- the window ----

test('the window shows a kind\'s own shapes, and a crosshair for a kind about a point', () => {
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes('for (const kind of s.options || timelineModel.SHAPE_KINDS) {'), 'the Shape row has the kind\'s shapes');
  // A figure that is a fraction of the width is in the picture's pixels, as one of the height is.
  assert.ok(js.includes("s.of ? Math.round(o[s.id] * (s.of === 'width' ? W : H)) : o[s.id];"));
  assert.ok(js.includes("s.of ? o[s.id] / (s.of === 'width' ? W : H) : o[s.id];"));
  assert.ok(js.includes("s.of ? Math.round(s.def * (s.of === 'width' ? vfxPic.width : vfxPic.height)) : s.def;"));
  // The crosshair: there for the chosen VFX of such a kind, dragged at the playhead like a box.
  const html = read('renderer', 'index.html');
  assert.ok(html.includes('<div id="vfxPointEl" class="vfx-point" hidden></div>'));
  assert.ok(js.includes("const hasPoint = (v) => !!v && timelineModel.vfxKind(v.kind).where === 'point';"));
  assert.ok(js.includes('vfxPointEl.hidden = !hasPoint(chosen);'));
  assert.ok(js.includes('vfxBoxEl.hidden = !hasArea(chosen);'), 'and no box for a kind without an area');
  assert.ok(js.includes("dragVfxSpot(vfxPointEl, evt, 'cx', 'cy', 0, 1);"));
  assert.ok(js.includes('changeVfxKeyed({ [xi]: x.at, [yi]: y.at });'));
  assert.ok(js.includes("node.className = 'vfx-point vfx-point--other';"), 'another VFX\'s point is there to click');
  assert.ok(js.includes("evt.target.closest('.vfx-area, .vfx-point')"));
  const css = read('renderer', 'style.css');
  assert.ok(css.includes('.vfx-point {') && css.includes('.vfx-point--other {') && css.includes('.vfx-point[hidden] {'));
  // The two figures have names.
  assert.ok(js.includes("cx: () => t('Center X:'),") && js.includes("cy: () => t('Center Y:'),"));
});
