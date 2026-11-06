'use strict';

// V3.6.5. The arrow, the heart and the speech bubble, as shapes and as masks.

const test = require('node:test');
const assert = require('node:assert/strict');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const D = require('../src/genDraw');

const near = (a, b) => Math.abs(a - b) < 1e-9;

// A context that writes down the path it is given, every point as [x, y].
function pathCtx() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    save() {},
    restore() {},
    clearRect() {},
    beginPath() {},
    closePath() { calls.push(['closePath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    arcTo(x1, y1, x2, y2, r) { calls.push(['arcTo', x1, y1, x2, y2, r]); },
    bezierCurveTo(...a) { calls.push(['bezierCurveTo', ...a]); },
    ellipse() { calls.push(['ellipse']); },
    fill(rule) { calls.push(['fill', this.fillStyle, rule]); },
  };
}

function shapeGen(shape) {
  return T.genOf({ form: 'shape', refHeight: 1080, shape });
}

// Every point a path names, the ends and the controls of its curves.
function pointsOf(calls) {
  const out = [];
  for (const c of calls) {
    const nums = c.slice(1).filter((v) => typeof v === 'number');
    const pairs = c[0] === 'arcTo' ? nums.slice(0, 4) : nums;
    for (let i = 0; i + 1 < pairs.length; i += 2) out.push([pairs[i], pairs[i + 1]]);
  }
  return out;
}

test('the three new kinds come after the first five, and a shape or a mask keeps them', () => {
  assert.deepEqual(T.SHAPE_KINDS, ['circle', 'square', 'triangle', 'star', 'ring', 'arrow', 'heart', 'bubble']);
  for (const kind of ['arrow', 'heart', 'bubble']) {
    assert.equal(T.genOf({ form: 'shape', shape: { kind } }).shape.kind, kind);
    assert.equal(T.maskOf({ kind }).kind, kind);
  }
  assert.equal(T.genOf({ form: 'shape', shape: { kind: 'hexagon' } }).shape.kind, 'circle');
});

test('each starts in its own proportions', () => {
  assert.equal(D.shapeAspect({ kind: 'arrow' }), 1.6);
  assert.equal(D.shapeAspect({ kind: 'heart' }), 1.1);
  assert.ok(near(D.shapeAspect({ kind: 'bubble' }), 4 / 3));
  const b = D.shapeBox(shapeGen({ kind: 'arrow' }), 1920, 1080);
  assert.ok(near(b.h, 360) && near(b.w, 576) && near(b.x, (1920 - 576) / 2), 'a third of the frame high, centred');
});

test('the arrow points right, its shaft half its height and its head the last two fifths', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shapeGen({ kind: 'arrow', box: { x: 0, y: 0, w: 100, h: 50 } }), 1920, 1080);
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo'), [
    ['moveTo', 0, 12.5], ['lineTo', 60, 12.5], ['lineTo', 60, 0], ['lineTo', 100, 25],
    ['lineTo', 60, 50], ['lineTo', 60, 37.5], ['lineTo', 0, 37.5],
  ]);
});

test('the heart is curves from its point, reaching every side of its box and no further', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shapeGen({ kind: 'heart', box: { x: 10, y: 20, w: 110, h: 100 } }), 1920, 1080);
  assert.deepEqual(ctx.calls[0], ['moveTo', 65, 120], 'the point at the bottom middle');
  assert.equal(ctx.calls.filter((c) => c[0] === 'bezierCurveTo').length, 6);
  const pts = pointsOf(ctx.calls.filter((c) => c[0] !== 'fill'));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  assert.ok(near(Math.min(...xs), 10) && near(Math.max(...xs), 120));
  assert.ok(near(Math.min(...ys), 20) && near(Math.max(...ys), 120));
  assert.ok(ctx.calls.some((c) => c[0] === 'bezierCurveTo' && near(c[5], 65) && near(c[6], 37)), 'the dip between the lobes');
});

test('the speech bubble is a rounded body with its tail at the bottom left', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shapeGen({ kind: 'bubble', box: { x: 0, y: 0, w: 200, h: 100 } }), 1920, 1080);
  const arcs = ctx.calls.filter((c) => c[0] === 'arcTo');
  assert.equal(arcs.length, 4);
  assert.ok(arcs.every((c) => near(c[5], 78 * 0.16)), 'the corners a share of the body\'s shorter side');
  const lines = ctx.calls.filter((c) => c[0] === 'lineTo');
  assert.deepEqual(lines.map((c) => [Math.round(c[1]), Math.round(c[2])]), [[72, 78], [16, 100], [40, 78]],
    'along the body\'s bottom edge, down to the tip on the box\'s, and back');
  // A tall narrow one keeps its corners short of the tail's base.
  const thin = pathCtx();
  D.drawGen(thin, shapeGen({ kind: 'bubble', box: { x: 0, y: 0, w: 20, h: 400 } }), 1920, 1080);
  const r = thin.calls.find((c) => c[0] === 'arcTo')[5];
  assert.ok(r < 20 * 0.2, 'the corner ends before the tail starts');
});

test('the new shapes turn with the dot like the others', () => {
  const ctx = pathCtx();
  D.drawGen(ctx, shapeGen({ kind: 'arrow', rotation: 90, box: { x: 0, y: 0, w: 100, h: 50 } }), 1920, 1080);
  const tip = ctx.calls.filter((c) => c[0] === 'lineTo')[2];
  assert.ok(near(tip[1], 50) && near(tip[2], 75), 'pointing down, its tip under the centre');
});

test('a mask of each draws in its box in the picture\'s pixels', () => {
  for (const kind of ['arrow', 'heart', 'bubble']) {
    const ctx = pathCtx();
    D.drawMask(ctx, T.maskOf({ kind, box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }), 400, 200, null, null);
    const pts = pointsOf(ctx.calls.filter((c) => c[0] !== 'fill'));
    assert.ok(pts.every(([x, y]) => x >= 100 - 1e-9 && x <= 300 + 1e-9 && y >= 50 - 1e-9 && y <= 150 + 1e-9), kind);
    assert.deepEqual(ctx.calls.find((c) => c[0] === 'fill'), ['fill', '#ffffffff', 'nonzero']);
  }
});
