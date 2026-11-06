'use strict';

// V3.7. A shape's gradient: the model, and how it is painted.

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/timeline');
const D = require('../src/genDraw');

const near = (a, b) => Math.abs(a - b) < 1e-9;

// A context with gradients, writing down the line each runs along and its stops.
function gradCtx() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    save() {},
    restore() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    ellipse() {},
    arcTo() {},
    bezierCurveTo() {},
    fill(rule) { calls.push(['fill', this.fillStyle, rule]); },
    createLinearGradient(x0, y0, x1, y1) {
      const g = { line: [x0, y0, x1, y1], stops: [] };
      g.addColorStop = (at, color) => g.stops.push([at, color]);
      calls.push(['gradient', g]);
      return g;
    },
  };
}

test('a shape is filled with its colour unless it says Gradient', () => {
  const s = T.genOf({ form: 'shape' }).shape;
  assert.equal(s.fill, 'color');
  assert.equal(T.genOf({ form: 'shape', shape: { fill: 'gradient' } }).shape.fill, 'gradient');
  assert.equal(T.genOf({ form: 'shape', shape: { fill: 'plaid' } }).shape.fill, 'color');
});

test('a gradient is white into black by default, its stops sorted and held to their ranges', () => {
  assert.deepEqual(T.gradientOf(null), {
    stops: [{ at: 0, color: '#ffffffff' }, { at: 1, color: '#000000ff' }], start: -100, end: 100, angle: 0,
  });
  const g = T.gradientOf({
    stops: [{ at: 2, color: '#0000FF' }, { at: -1, color: 'nonsense' }, { at: 0.4, color: '#ff000080' }],
    start: -40, end: 'x', angle: 270,
  });
  assert.deepEqual(g.stops, [
    { at: 0, color: '#ffffffff' }, { at: 0.4, color: '#ff000080' }, { at: 1, color: '#0000ffff' },
  ]);
  assert.equal(g.start, -40);
  assert.equal(g.end, 100, 'not a number is the default');
  assert.equal(g.angle, -90, 'an angle kept to -180 up to 180');
  assert.equal(T.gradientOf({ stops: [{ at: 0.5, color: '#ff0000' }] }).stops.length, 2, 'two stops at least');
  const many = Array.from({ length: 30 }, (_, i) => ({ at: i / 29, color: '#ffffff' }));
  assert.equal(T.gradientOf({ stops: many }).stops.length, T.GRADIENT_STOPS_MAX);
});

test('the gradient runs through the shape\'s centre from Start to End, at the angle from the shape', () => {
  const ctx = gradCtx();
  const gen = T.genOf({
    form: 'shape', refHeight: 540,
    shape: {
      kind: 'square', fill: 'gradient', box: { x: 100, y: 100, w: 200, h: 100 },
      gradient: { stops: [{ at: 0, color: '#ff0000' }, { at: 1, color: '#0000ff' }], start: -50, end: 50, angle: 0 },
    },
  });
  D.drawGen(ctx, gen, 1920, 1080);
  const g = ctx.calls.find((c) => c[0] === 'gradient')[1];
  // At twice refHeight: the box is 200..600 across, its centre (400, 300).
  assert.deepEqual(g.line, [300, 300, 500, 300]);
  assert.deepEqual(g.stops, [[0, '#ff0000ff'], [1, '#0000ffff']]);
  assert.equal(ctx.calls.find((c) => c[0] === 'fill')[1], g, 'the gradient is what fills it');
});

test('the gradient turns with the shape, and a line of no length is given half a pixel', () => {
  const ctx = gradCtx();
  const shape = { fill: 'gradient', rotation: 60, gradient: { stops: [], start: 0, end: 10, angle: 30 }, color: '#fff' };
  const g = D.shapePaint(ctx, shape, { x: 0, y: 0, w: 20, h: 20 }, 1);
  assert.ok(near(g.line[0], 10) && near(g.line[1], 10));
  assert.ok(near(g.line[2], 10) && near(g.line[3], 20), 'ninety degrees: pointing down from the centre');
  const flat = D.shapePaint(ctx, { ...shape, rotation: 0, gradient: { stops: [], start: 5, end: 5, angle: 0 } },
    { x: 0, y: 0, w: 20, h: 20 }, 1);
  assert.ok(near(flat.line[2] - flat.line[0], 0.5));
  assert.equal(D.shapePaint(ctx, { ...shape, fill: 'color' }, { x: 0, y: 0, w: 1, h: 1 }, 1), '#fff');
  assert.equal(D.shapePaint({}, shape, { x: 0, y: 0, w: 1, h: 1 }, 1), '#fff', 'no gradients to be had, its colour');
});

test('a stop added between two starts as the colour the gradient has there', () => {
  const stops = [{ at: 0, color: '#ffffffff' }, { at: 1, color: '#000000ff' }];
  assert.equal(D.gradientColourAt(stops, 0.5), '#808080ff');
  assert.equal(D.gradientColourAt(stops, -1), '#ffffffff');
  assert.equal(D.gradientColourAt(stops, 2), '#000000ff');
  assert.equal(D.gradientColourAt([{ at: 0.2, color: '#ff000000' }, { at: 0.6, color: '#ff0000ff' }], 0.4), '#ff000080');
});

test('the gradient is the whole clip\'s, not a keyframe\'s, and survives a Crop Render Frame', () => {
  assert.ok(!T.GEN_KEYED.shape.includes('gradient') && !T.GEN_KEYED.shape.includes('fill'));
  const gen = { form: 'shape', refHeight: 720, shape: { fill: 'gradient', box: { x: 0, y: 0, w: 100, h: 100 }, gradient: { start: -30, end: 30 } } };
  // A crop from 720 down to 600 lines keeps every size as it was on screen.
  const moved = T.reframeGen(gen, 720, 600, 1, 0, 0);
  assert.equal(moved.shape.fill, 'gradient');
  assert.equal(moved.refHeight, 600);
  assert.equal(moved.shape.gradient.start, -30, 'kept at its refHeight, like the box, so it stays the size it was');
  assert.equal(D.scaleOf(moved, 600), 1);
});

test('a gradient survives a project saved and opened again', () => {
  require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
  const P = require('../src/project');
  const l = T.createLayer({
    id: 's', kind: 'gen', duration: 5,
    gen: { form: 'shape', refHeight: 1080, shape: {
      kind: 'heart', fill: 'gradient',
      gradient: { stops: [{ at: 0, color: '#ff0000' }, { at: 0.3, color: '#00ff0080' }, { at: 1, color: '#0000ff' }], start: -80, end: 120, angle: 45 },
    } },
  });
  const doc = P.serialise({ layers: [l], project: { width: 1920, height: 1080, fps: 30 }, trim: { start: 0, end: 5 } });
  const parsed = P.parse(P.stringify(doc));
  assert.equal(parsed.ok, true);
  const back = T.createLayer(parsed.doc.layers[0]);
  assert.deepEqual(back.gen.shape.gradient, l.gen.shape.gradient);
  assert.equal(back.gen.shape.fill, 'gradient');
});
