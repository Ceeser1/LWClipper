'use strict';

// V3.6.2. A shape's turn and a square's rounded corners: the model, the
// drawing, the blend between keyframes, and a turned box scaled by a corner.

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/timeline');
const D = require('../src/genDraw');
const G = require('../src/geometry');
const P = require('../src/project');

// A context that writes down the path it is given.
function pathCtx() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: '',
    beginPath() { calls.push(['beginPath']); },
    closePath() { calls.push(['closePath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    arcTo(...a) { calls.push(['arcTo', ...a]); },
    ellipse(...a) { calls.push(['ellipse', ...a]); },
    fill(rule) { calls.push(['fill', this.fillStyle, rule]); },
    clearRect() {},
    save() {},
    restore() {},
  };
  return ctx;
}

const near = (a, b) => Math.abs(a - b) < 1e-9;
const shape = (s) => T.genOf({ form: 'shape', refHeight: 1080, shape: { box: { x: 100, y: 100, w: 200, h: 100 }, ...s } });
const points = (calls) => calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo').map((c) => [c[1], c[2]]);

// ---- the model ----

test('a shape keeps its turn, held to one number per direction, and its rounded corners', () => {
  const s = shape({ rotation: 370, radius: 25 }).shape;
  assert.equal(s.rotation, 10);
  assert.equal(s.radius, 25);
  assert.equal(shape({ rotation: -190 }).shape.rotation, 170);
  assert.equal(shape({ radius: -4 }).shape.radius, 0);
  const old = shape({}).shape;
  assert.deepEqual([old.rotation, old.radius], [0, 0], 'a 3.6 shape opens as it was');
});

test('the turn and the corners are keyed; the corners scale with refHeight and the turn does not', () => {
  assert.deepEqual(T.GEN_KEYED.shape, ['box', 'soft', 'rotation', 'radius']);
  const k = T.keyedAt({ rotation: 30, radius: 30 }, 2 / 3);
  assert.equal(k.rotation, 30);
  assert.equal(k.radius, 20);
});

test('a project keeps both', () => {
  const l = T.createLayer({ type: 'video', kind: 'gen', gen: { form: 'shape', shape: { kind: 'square', rotation: 45, radius: 12 } }, duration: 5 });
  const back = P.parse(P.stringify(P.serialise({ layers: [l], project: { width: 1920, height: 1080, fps: 30 }, trim: { start: 0, end: 5 } })));
  const s = T.createLayer(back.doc.layers[0]).gen.shape;
  assert.deepEqual([s.rotation, s.radius], [45, 12]);
});

// ---- the drawing ----

test('a turned square has its corners turned about the box centre', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shape({ kind: 'square', rotation: 90 }), 1920, 1080);
  // Centre (200, 150); a quarter turn clockwise takes (100, 100) to (250, 50).
  const [first, ...rest] = points(ctx.calls);
  assert.ok(near(first[0], 250) && near(first[1], 50), JSON.stringify(first));
  assert.equal(rest.length, 3);
  const corner = rest[1];
  assert.ok(near(corner[0], 150) && near(corner[1], 250), JSON.stringify(corner));
});

test('unturned, the points are exactly the box\'s', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shape({ kind: 'square' }), 1920, 1080);
  assert.deepEqual(points(ctx.calls), [[100, 100], [300, 100], [300, 200], [100, 200]]);
});

test('a turned circle and ring pass the turn to the ellipse', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shape({ kind: 'ring', rotation: 30 }), 1920, 1080);
  const ellipses = ctx.calls.filter((c) => c[0] === 'ellipse');
  assert.equal(ellipses.length, 2);
  for (const e of ellipses) assert.ok(near(e[5], Math.PI / 6));
  assert.equal(ctx.calls.find((c) => c[0] === 'fill')[2], 'evenodd');
});

test('rounded corners are four arcs, never more than half the shorter side', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shape({ kind: 'square', radius: 30 }), 1920, 1080);
  const arcs = ctx.calls.filter((c) => c[0] === 'arcTo');
  assert.equal(arcs.length, 4);
  for (const a of arcs) assert.equal(a[5], 30);
  // From the middle of the top side.
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'moveTo').slice(1), [200, 100]);
  const big = pathCtx();
  D.drawGen(big, shape({ kind: 'square', radius: 500 }), 1920, 1080);
  for (const a of big.calls.filter((c) => c[0] === 'arcTo')) assert.equal(a[5], 50, 'half of 100');
});

test('the corners are in the frame\'s pixels, scaled from refHeight', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shape({ kind: 'square', radius: 30 }), 1280, 720);
  for (const a of ctx.calls.filter((c) => c[0] === 'arcTo')) assert.ok(near(a[5], 20));
});

test('only a square rounds its corners', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shape({ kind: 'triangle', radius: 30 }), 1920, 1080);
  assert.equal(ctx.calls.filter((c) => c[0] === 'arcTo').length, 0);
});

// ---- between keyframes ----

function keyed(list) {
  return T.createLayer({
    id: 'g', type: 'video', kind: 'gen', duration: 10,
    gen: { form: 'shape', refHeight: 1080, shape: { kind: 'square', box: { x: 0, y: 0, w: 100, h: 100 } } },
    keyframes: list,
  });
}

test('a turn blends the short way round, and the corners blend', () => {
  const l = keyed([
    { t: 0, box: { x: 0, y: 0, w: 100, h: 100 }, rotation: 170, radius: 0 },
    { t: 2, box: { x: 0, y: 0, w: 100, h: 100 }, rotation: -170, radius: 40 },
  ]);
  const mid = D.genAt(l, 1, 1920, 1080);
  assert.ok(near(Math.abs(mid.shape.rotation), 180), String(mid.shape.rotation));
  assert.equal(mid.shape.radius, 20);
  assert.deepEqual(D.genMotion(l), { from: 0, to: 2 });
});

test('a spin alone is a move', () => {
  const l = keyed([
    { t: 0, box: { x: 0, y: 0, w: 100, h: 100 }, rotation: 0 },
    { t: 3, box: { x: 0, y: 0, w: 100, h: 100 }, rotation: 90 },
  ]);
  assert.deepEqual(D.genMotion(l), { from: 0, to: 3 });
  assert.equal(D.genAt(l, 1, 1920, 1080).shape.rotation, 30);
});

// ---- a turned box scaled by a corner ----

const FRAME = { width: 1920, height: 1080 };
const box = { x: 100, y: 100, w: 200, h: 100 };

function cornerAt(b, sx, sy, deg) {
  const a = deg * Math.PI / 180;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const x = sx * b.w / 2;
  const y = sy * b.h / 2;
  return [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)];
}

test('unturned, it is the corner scale every shape has', () => {
  for (const c of ['tl', 'tr', 'bl', 'br']) {
    assert.deepEqual(G.boxCornerScaleTurned(box, c, 24, 13, false, 0, FRAME), G.boxCornerScale(box, c, 24, 13, false, FRAME), c);
  }
});

test('turned, the opposite corner stays where it is on the screen', () => {
  for (const deg of [30, 90, -135]) {
    // Outwards along the turned box's own diagonal, on the screen.
    const rad = deg * Math.PI / 180;
    const dx = 20 * Math.cos(rad) - 10 * Math.sin(rad);
    const dy = 20 * Math.sin(rad) + 10 * Math.cos(rad);
    const r = G.boxCornerScaleTurned(box, 'br', dx, dy, false, deg, FRAME);
    assert.ok(r.w > box.w, 'it grew');
    assert.ok(Math.abs(r.w / r.h - 2) < 0.02, 'and kept its proportions');
    const before = cornerAt(box, -1, -1, deg);
    const after = cornerAt(r, -1, -1, deg);
    assert.ok(Math.hypot(before[0] - after[0], before[1] - after[1]) <= 1.5, deg + ': ' + JSON.stringify([before, after]));
  }
});

test('turned and mirrored, the centre holds', () => {
  const r = G.boxCornerScaleTurned(box, 'tr', 20, -20, true, 45, FRAME);
  assert.ok(Math.abs(r.x + r.w / 2 - 200) <= 0.5 && Math.abs(r.y + r.h / 2 - 150) <= 0.5);
});

test('turned, it never shrinks below the least size', () => {
  const r = G.boxCornerScaleTurned(box, 'br', -1000, -1000, false, 60, FRAME);
  assert.ok(Math.min(r.w, r.h) >= G.TEXT_BOX_MIN, JSON.stringify(r));
});
