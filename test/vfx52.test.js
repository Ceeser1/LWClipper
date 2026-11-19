'use strict';

// V5.2. More warps and two smaller kinds: Corner Pin, which leaves the
// picture see-through round where it puts it, Polar Coordinates, Vibrance
// and Halftone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const O = require('../src/vfxOps');
const { buildComposeArgs } = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HD = { width: 1920, height: 1080, fps: 30 };
const SRC = { 'a.mp4': { width: 1920, height: 1080 } };
const WHOLE = { x: 0, y: 0, width: 1920, height: 1080 };
const now = (kind, more = {}, t = 0) => T.vfxAt(T.vfxOf({ kind, ...more }), t);
const opsOf = (kind, more) => O.opsOf(kind, now(kind, more), 1920, 1080);
const graphsOf = (args) => args.filter((a, i) => args[i - 1] === '-filter_complex');
const graphOf = (...files) => graphsOf(buildComposeArgs({
  layers: [{ ...vid({}), vfxFiles: files }], project: HD, output: 'o.mp4', sources: SRC,
})).join(';');

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

// Where the nine figures take a place of the shown picture from.
function from(m, x, y) {
  const d = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / d - 0.5, (m[3] * x + m[4] * y + m[5]) / d - 0.5, d];
}

// ---- Corner Pin ----

test('Corner Pin is a kind for the whole picture with four corners a keyframe holds', () => {
  const def = T.vfxKind('cornerpin');
  assert.equal(def.where, 'whole');
  assert.equal(def.area, false);
  assert.equal(def.alpha, true);
  assert.deepEqual(def.pins, [['x1', 'y1'], ['x2', 'y2'], ['x3', 'y3'], ['x4', 'y4']]);
  assert.deepEqual(def.keyed.map((s) => s.id), ['x1', 'y1', 'x2', 'y2', 'x3', 'y3', 'x4', 'y4', 'mix']);
  for (const [x, y] of def.pins) {
    const sx = def.keyed.find((s) => s.id === x);
    const sy = def.keyed.find((s) => s.id === y);
    assert.equal(sx.of, 'width');
    assert.equal(sy.of, 'height');
    assert.ok(sx.min === -0.5 && sx.max === 1.5 && sy.min === -0.5 && sy.max === 1.5, 'a corner may lie off the picture');
    assert.equal(sx.in, 'filter');
  }
  // A new one shows what it does; with its corners on the picture's own it does nothing.
  assert.equal(now('cornerpin').off, false);
  assert.equal(now('cornerpin', { x1: 0, y1: 0, x2: 1, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1 }).off, true);
  assert.equal(now('cornerpin', { mix: 0 }).off, true);
});

test('the corners blend between keyframes and make a step a frame while they move', () => {
  const v = T.vfxOf({ kind: 'cornerpin', keys: [
    { t: 0, x1: 0, y1: 0, x2: 1, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1 },
    { t: 2, x1: 0.2, y1: 0.4, x2: 1, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1 },
  ] });
  const mid = T.vfxAt(v, 1);
  assert.ok(Math.abs(mid.x1 - 0.1) < 1e-9 && Math.abs(mid.y1 - 0.2) < 1e-9);
  const runs = T.vfxRuns(vid({ duration: 2, vfx: [v] }), v, 30);
  assert.ok(runs.length > 50, 'a figure of its filter on every frame');
  assert.equal(runs[0].at.off, true, 'the first frame has the corners on the picture\'s own');
});

test('the nine figures take each corner as shown back to the picture\'s own corner', () => {
  const W = 1920;
  const H = 1080;
  const v = { x1: 0.12, y1: 0.1, x2: 0.88, y2: 0.2, x3: 0.88, y3: 0.8, x4: 0.12, y4: 0.9 };
  const m = O.pinOf(v, W, H);
  const near = (got, want) => assert.ok(Math.abs(got[0] - want[0]) < 1e-3 && Math.abs(got[1] - want[1]) < 1e-3, got + ' ' + want);
  near(from(m, v.x1 * W - 0.5, v.y1 * H - 0.5), [-0.5, -0.5]);
  near(from(m, v.x2 * W - 0.5, v.y2 * H - 0.5), [W - 0.5, -0.5]);
  near(from(m, v.x3 * W - 0.5, v.y3 * H - 0.5), [W - 0.5, H - 0.5]);
  near(from(m, v.x4 * W - 0.5, v.y4 * H - 0.5), [-0.5, H - 0.5]);
  // The divisor is above zero where the picture shows, also turned over left to right.
  assert.ok(from(m, 960, 540)[2] > 0);
  const over = O.pinOf({ x1: 1, y1: 0, x2: 0, y2: 0, x3: 0, y3: 1, x4: 1, y4: 1 }, W, H);
  const got = from(over, 100, 200);
  assert.ok(got[2] > 0 && Math.abs(got[0] - (W - 1 - 100)) < 1e-3 && Math.abs(got[1] - 200) < 1e-3);
  // The picture's own corners are every pixel where it was.
  const same = from(O.pinOf({ x1: 0, y1: 0, x2: 1, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1 }, W, H), 333, 77);
  near(same, [333, 77]);
  // Corners that span nothing give no rule, and so no ops.
  assert.equal(O.pinOf({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5, x3: 0.5, y3: 0.5, x4: 0.5, y4: 0.5 }, W, H), null);
  assert.deepEqual(O.opsOf('cornerpin', { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5, x3: 0.5, y3: 0.5, x4: 0.5, y4: 0.5 }, W, H), []);
});

test('Corner Pin is one rule for every plane, and writes the alpha itself: nothing outside the picture\'s edges', () => {
  const [op] = opsOf('cornerpin');
  assert.equal(op.op, 'warp');
  assert.equal(op.form, 'pin');
  assert.equal(op.map.length, 9);
  const solid = O.filtersOfOp(op, false)[0];
  assert.ok(solid.startsWith("geq=lum='st(0,"));
  assert.equal(solid.includes(":a='"), false);
  const text = O.filtersOfOp(op, true)[0];
  const a = text.slice(text.indexOf(":a='") + 4, -1);
  // The picture's own alpha where the pixel comes from, times how far inside the edges that is, a pixel soft.
  assert.ok(a.includes('st(6,if(gt(ld(0),0),min(min(ld(4),1919-ld(4)),min(ld(5),1079-ld(5))),-1000));'), a);
  assert.ok(a.endsWith('p(ld(4),ld(5))*clip(ld(6)+1,0,1)+0.5'), a);
  // The colour planes take the place at their own scale, as every warp does,
  // and keep the picture's own colour under what is left see-through.
  assert.ok(text.includes('if(gt(ld(6),-4),p(ld(4)*SW,ld(5)*SH),p(X,Y))+0.5'));
  assert.equal(/undefined|NaN|Infinity/.test(text), false);
  // Another warp keeps the picture solid.
  assert.equal(O.warpAlpha(opsOf('swirl')[0]), null);
  assert.ok(O.filtersOfOp(opsOf('perspective')[0], true)[0].includes(":a='"));
  assert.equal(O.roomOf([op]).whole, true);
});

test('a track with a Corner Pin is carried with an alpha from its VFX on', () => {
  assert.equal(T.vfxGivesAlpha(vid({ vfx: [T.vfxOf({ kind: 'cornerpin' })] })), true);
  assert.equal(T.vfxGivesAlpha(vid({ vfx: [T.vfxOf({ kind: 'cornerpin', disabled: true })] })), false);
  assert.equal(T.vfxGivesAlpha(vid({ vfx: [T.vfxOf({ kind: 'sepia' })] })), false);
  const file = { kind: 'cornerpin', region: WHOLE, steps: [{ ops: opsOf('cornerpin') }], on: null, whole: true, full: true };
  const graph = graphOf(file);
  assert.ok(graph.includes('format=yuva420p'), 'the picture has an alpha before its VFX');
  assert.ok(graph.includes(":a='st(0,"), 'the filter writes it');
  // On the colours as they are: nothing weighs them by an alpha the filter is about to replace.
  assert.equal(graph.includes('premultiply'), false);
  // The same track without the pin has none.
  const plain = { kind: 'polar', region: WHOLE, steps: [{ ops: opsOf('polar') }], on: null, whole: true, full: true };
  const other = graphOf(plain);
  assert.equal(other.includes('yuva'), false);
  assert.equal(other.includes(":a='"), false);
});

test('at part Mix a Corner Pin is blended with the picture as it was, alpha and all, with no weighing step', () => {
  const file = { kind: 'cornerpin', region: WHOLE, steps: [{ ops: opsOf('cornerpin') }], on: null, whole: true, src: 'C:/gen/mask.png' };
  const graph = graphOf(file);
  // The encoder's premultiply takes a level off a solid picture (measured:
  // 251 came back 248), so none is used: the pinned picture has the
  // picture's own colour where it is see-through, and plane by plane comes
  // out as the preview blends them.
  assert.equal(graph.includes('premultiply'), false);
  assert.ok(graph.includes('[cv0x0a][cv0x0c][cv0x0m]maskedmerge,format=yuva420p[cv0x0o]'));
});

// ---- Polar Coordinates ----

test('Polar Coordinates wraps the picture round its middle or lays it out flat, by an amount', () => {
  const def = T.vfxKind('polar');
  assert.equal(def.where, 'whole');
  assert.deepEqual(def.statics.map((s) => [s.id, s.type, s.options]), [['mode', 'choice', ['wrap', 'unwrap']]]);
  assert.deepEqual(def.keyed.map((s) => s.id), ['amount', 'mix']);
  assert.equal(now('polar', { amount: 0 }).off, true);
  const [wrap] = opsOf('polar', { mode: 'wrap', amount: 50 });
  assert.deepEqual([wrap.op, wrap.form, wrap.unwrap, wrap.a, wrap.W, wrap.H], ['warp', 'polar', false, 0.5, 1920, 1080]);
  const text = O.warpExpr(wrap);
  assert.ok(text.includes('atan2(-ld(2),ld(3))/6.28319+0.5'), 'the angle round the middle is how far across');
  assert.ok(text.includes('st(0,hypot(ld(2),ld(3)))'), 'and how far out is how far down');
  const [flat] = opsOf('polar', { mode: 'unwrap' });
  assert.equal(flat.unwrap, true);
  assert.ok(O.warpExpr(flat).includes('sin(ld(1))') && O.warpExpr(flat).includes('cos(ld(1))'));
  // The two undo each other: a place wrapped and unwrapped is where it was.
  const W = 1920;
  const H = 1080;
  const wrapAt = (x, y) => {
    const u = (x - (W - 1) / 2) / (W / 2);
    const v = (y - (H - 1) / 2) / (H / 2);
    return [(Math.atan2(-u, v) / (2 * Math.PI) + 0.5) * W - 0.5, Math.hypot(u, v) * H - 0.5];
  };
  const unwrapAt = (x, y) => {
    const th = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
    const r = (y + 0.5) / H;
    return [(W - 1) / 2 - r * Math.sin(th) * (W / 2), (H - 1) / 2 + r * Math.cos(th) * (H / 2)];
  };
  const there = wrapAt(1200, 300);
  const back = unwrapAt(there[0], there[1]);
  assert.ok(Math.abs(back[0] - 1200) < 1e-6 && Math.abs(back[1] - 300) < 1e-6);
});

// ---- Vibrance ----

test('Vibrance changes the pale colours most, up and down, with the encoder\'s filter told which way to count', () => {
  const def = T.vfxKind('vibrance');
  assert.equal(def.where, 'two');
  assert.equal(now('vibrance', { vibrance: 0 }).off, true);
  const up = O.filtersOfOp(opsOf('vibrance', { vibrance: 60 })[0])[0];
  assert.equal(up, 'vibrance=intensity=0.6:rbal=1:gbal=1:bbal=1:rlum=0.2126:glum=0.7152:blum=0.0722:alternate=1');
  const down = O.filtersOfOp(opsOf('vibrance', { vibrance: -40 })[0])[0];
  assert.ok(down.startsWith('vibrance=intensity=-0.4:') && down.endsWith(':alternate=0'));
  const gl = read('renderer', 'app', 'vfxGl.js');
  assert.ok(gl.includes('float k = 1.0 + uK * (1.0 - strong);'), 'the one rule both ways come to');
});

// ---- Halftone ----

test('Halftone is the picture smoothed by about a cell and then dots on white, read off the brightness plane', () => {
  const def = T.vfxKind('halftone');
  assert.equal(def.where, 'box');
  assert.deepEqual(def.statics.map((s) => s.id), ['tinted', 'invert']);
  const ops = opsOf('halftone', { size: 0.02, angle: 30 });
  assert.deepEqual(ops.map((o) => o.op), ['blur', 'dots']);
  const dots = ops[1];
  assert.equal(dots.size, 22);
  // A cell's middle is read no nearer the picture's edge than about a third of a cell.
  assert.deepEqual([dots.inset, dots.W, dots.H], [7, 1920, 1080]);
  assert.ok(O.filtersOfOp(dots)[0].includes('st(4,clip(ld(2)*0.866025-ld(3)*0.5,7,1912));st(5,clip(ld(2)*0.5+ld(3)*0.866025,7,1072));'));
  assert.ok(Math.abs(dots.angle - Math.PI / 6) < 1e-12);
  assert.equal(O.roomOf(ops).whole, true, 'the cells are counted from the picture\'s corner');
  const black = O.filtersOfOp(dots)[0];
  assert.ok(black.startsWith("geq=lum='st(0,(X/SW)*0.866025+(Y/SH)*0.5);"));
  assert.ok(black.includes('st(6,lum(ld(4),ld(5)))'), 'how dark the cell\'s middle is');
  assert.ok(black.includes("235-219*ld(7)+0.5':cb='128':cr='128'"), 'black dots on white, the colour planes one figure');
  assert.equal(black.includes(":a='"), false);
  const tinted = O.filtersOfOp(opsOf('halftone', { tinted: true })[1], true)[0];
  assert.ok(tinted.includes('235+(ld(6)-235)*ld(7)+0.5') && tinted.includes('128+(cb(ld(4)*SW,ld(5)*SH)-128)*ld(7)+0.5')
    && tinted.includes('128+(cr(ld(4)*SW,ld(5)*SH)-128)*ld(7)+0.5'));
  assert.ok(tinted.endsWith(":a='alpha(X,Y)'"), 'a picture\'s own alpha stays');
  // A dot reaches its cell's corners where the picture is black.
  assert.ok(black.includes(O.num(22 * Math.SQRT1_2) + '*sqrt(clip((235-ld(6))/219,0,1))'));
  // The blur and the dots both at full size, back to the picture's own planes once after.
  const g = graphOf({ kind: 'halftone', region: WHOLE, steps: [{ ops }], on: null, whole: true, full: true });
  assert.ok(g.includes('format=yuv444p,gblur='));
  assert.ok(g.includes(':steps=6,geq='));
});

// ---- the tables and the window ----

test('the four kinds have a row in every table, in one order, and a name for everything', () => {
  const added = ['cornerpin', 'polar', 'vibrance', 'halftone'];
  const first = T.VFX_KIND_IDS.indexOf('cornerpin');
  assert.deepEqual(T.VFX_KIND_IDS.slice(first, first + 4), added);
  const rows = (file, table) => {
    const text = read(...file);
    const body = text.slice(text.indexOf('const ' + table + ' = {'));
    return [...body.slice(0, body.indexOf('\n};')).matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]);
  };
  for (const [file, table] of [[['renderer', 'app', 'compositor.js'], 'VFX_PREVIEW'], [['renderer', 'app', 'export.js'], 'VFX_EXPORT'],
    [['src', 'composer.js'], 'VFX_FILTERS'], [['renderer', 'app', 'vfx.js'], 'VFX_UI']]) {
    const all = rows(file, table);
    assert.deepEqual(all.slice(all.indexOf('cornerpin'), all.indexOf('cornerpin') + 4), added, table);
  }
  const listed = T.VFX_GROUPS.flatMap((g) => g.kinds);
  for (const kind of added) assert.ok(listed.includes(kind), kind);
  const js = read('renderer', 'app', 'vfx.js');
  for (const id of ['x1', 'y1', 'x2', 'y2', 'x3', 'y3', 'x4', 'y4', 'vibrance', 'tinted']) assert.ok(js.includes('  ' + id + ': () => t('), id);
  assert.ok(js.includes("wrap: () => t('Wrap into a Circle'),") && js.includes("unwrap: () => t('Unwrap a Circle'),"));
  // Pinch is Bulge the other way, and the list says so.
  assert.ok(js.includes("bulge: { name: () => t('Bulge and Pinch'),"));
});

test('the window has a handle on each corner of a Corner Pin, dragged like a point', () => {
  const html = read('renderer', 'index.html');
  assert.ok(html.includes('<svg id="vfxPinFrame" class="vfx-pin-frame" hidden><polygon points=""></polygon></svg>'));
  assert.equal((html.match(/<div class="vfx-pin" data-pin="/g) || []).length, 4);
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes('const pins = chosen ? timelineModel.vfxKind(chosen.kind).pins || null : null;'));
  assert.ok(js.includes('vfxPins.hidden = !pins;') && js.includes("vfxPinFrame.toggleAttribute('hidden', !pins);"));
  assert.ok(js.includes('dragVfxSpot(node, evt, pair[0], pair[1], -0.5, 1.5);'));
  const css = read('renderer', 'style.css');
  assert.ok(css.includes('.vfx-pin {') && css.includes('.vfx-pin-frame {'));
});

test('a project keeps a Corner Pin and its keyframes through a save and an open', () => {
  const P = require('../src/project');
  const v = T.vfxOf({ kind: 'cornerpin', x1: -0.2, y1: 0.1, keys: [
    { t: 0, x1: -0.2, y1: 0.1, x2: 1, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1, mix: 100 },
    { t: 1, x1: 0.3, y1: 0.3, x2: 1.4, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1, mix: 50 },
  ] });
  const layer = vid({ vfx: [v] });
  const back = P.parse(P.stringify(P.serialise({ layers: [layer], project: HD, trim: { start: 0, end: 10 } })));
  assert.equal(back.ok, true);
  assert.deepEqual(T.createLayer(back.doc.layers[0]).vfx, [v]);
  // A corner further off than half the picture is held there.
  assert.equal(T.vfxOf({ kind: 'cornerpin', x1: -3 }).x1, -0.5);
});
