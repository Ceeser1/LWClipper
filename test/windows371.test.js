'use strict';

// V3.7.1. A mask's colour or gradient, and the editor windows' markup: the
// buttons' order and the hints gone into Info.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/timeline');
const D = require('../src/genDraw');

const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

// A context that writes down the shape's fill, the gradients made, and what
// the strength is put in with.
function maskCtx() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    ellipse() {},
    arcTo() {},
    bezierCurveTo() {},
    fill(rule) { calls.push(['fill', this.fillStyle, rule]); },
    fillRect(x, y, w, h) { calls.push(['fillRect', this.fillStyle, this.globalCompositeOperation, x, y, w, h]); },
    createLinearGradient(x0, y0, x1, y1) {
      const g = { line: [x0, y0, x1, y1], stops: [] };
      g.addColorStop = (at, color) => g.stops.push([at, color]);
      calls.push(['gradient', g]);
      return g;
    },
  };
}

const BOX = { x: 0.25, y: 0, w: 0.5, h: 1 };

// ---- the model ----

test('a mask shows in full by default, so one written by 3.7 opens as it was', () => {
  const m = T.maskOf({ kind: 'circle', box: BOX });
  assert.equal(m.fill, 'color');
  assert.equal(m.color, '#ffffffff');
  assert.deepEqual(m.gradient, T.maskGradientOf(null));
  assert.equal(T.maskOf({ fill: 'paint' }).fill, 'color', 'only Color or Gradient');
  assert.equal(T.maskOf({ fill: 'gradient' }).fill, 'gradient');
});

test('a mask\'s gradient runs in fractions of the picture\'s height, held to a hundred of them', () => {
  const g = T.maskGradientOf(null);
  assert.deepEqual([g.start, g.end, g.angle], [-0.5, 0.5, 0]);
  assert.deepEqual(g.stops, [{ at: 0, color: '#ffffffff' }, { at: 1, color: '#000000ff' }]);
  const wild = T.maskGradientOf({ start: -500, end: 0.25, angle: 400 });
  assert.equal(wild.start, -100);
  assert.equal(wild.end, 0.25);
  assert.equal(wild.angle, 40);
});

test('the colour and the gradient are the whole clip\'s, carried through its keyframes', () => {
  const v = T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080,
    mask: { kind: 'circle', box: BOX, fill: 'gradient', color: '#808080ff', gradient: { start: -0.2, end: 0.2, angle: 90 } },
    keyframes: [{ id: 'a', t: 0, mask: { box: BOX, soft: 0 } }, { id: 'b', t: 4, mask: { box: { ...BOX, w: 0.25 }, soft: 0.1 } }],
  });
  const m = T.maskAt(v, 2);
  assert.equal(m.fill, 'gradient');
  assert.equal(m.color, '#808080ff');
  assert.deepEqual([m.gradient.start, m.gradient.end, m.gradient.angle], [-0.2, 0.2, 90]);
  assert.ok(near(m.box.w, 0.375), 'the box still blends');
});

// ---- the drawing ----

test('a colour lets a mask show by its brightness times its alpha, whatever its hue', () => {
  assert.equal(D.maskStrength('#ffffffff'), 1);
  assert.equal(D.maskStrength('#000000ff'), 0);
  assert.equal(D.maskStrength('#ffffff00'), 0);
  assert.ok(near(D.maskStrength('#ffffff80'), 128 / 255));
  assert.ok(near(D.maskStrength('#ff0000ff'), 0.2126), 'red a fifth, as a custom picture\'s brightness has it');
  assert.ok(near(D.maskStrength('#808080ff'), 128 / 255, 1e-6));
});

test('a mask in full white is drawn as it always was, with nothing put over it', () => {
  const ctx = maskCtx();
  D.drawMask(ctx, T.maskOf({ kind: 'circle', box: BOX }), 640, 360, null, null);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'fill'), ['fill', '#ffffffff', 'nonzero']);
  assert.equal(ctx.calls.some((c) => c[0] === 'fillRect'), false);
});

test('a grey mask is the white one taken down to its strength, keeping its own shape', () => {
  const ctx = maskCtx();
  D.drawMask(ctx, T.maskOf({ kind: 'circle', box: BOX, color: '#ffffff80' }), 640, 360, null, null);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'fill'), ['fill', '#ffffffff', 'nonzero'], 'the shape white');
  const over = ctx.calls.find((c) => c[0] === 'fillRect');
  assert.deepEqual(over.slice(2), ['source-in', 0, 0, 640, 360]);
  assert.equal(over[1], 'rgba(255,255,255,' + (128 / 255).toFixed(4) + ')');
});

test('a gradient mask runs from the middle of its box, Start and End by the picture\'s height', () => {
  const ctx = maskCtx();
  const mask = T.maskOf({
    kind: 'circle', box: BOX, fill: 'gradient',
    gradient: { stops: [{ at: 0, color: '#ffffffff' }, { at: 1, color: '#00000000' }], start: -0.25, end: 0.25, angle: 0 },
  });
  D.drawMask(ctx, mask, 640, 360, null, null);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'fill'), ['fill', '#ffffffff', 'nonzero'],
    'the shape is never painted with the gradient itself');
  const g = ctx.calls.find((c) => c[0] === 'gradient')[1];
  // The box's middle is (320, 180); a quarter of 360 either side, across.
  assert.deepEqual(g.line, [320 - 90, 180, 320 + 90, 180]);
  assert.deepEqual(g.stops, [[0, 'rgba(255,255,255,1.0000)'], [1, 'rgba(255,255,255,0.0000)']]);
  const over = ctx.calls.find((c) => c[0] === 'fillRect');
  assert.equal(over[1], g);
  assert.equal(over[2], 'source-in');
});

test('a mask gradient turns from the picture only: a mask has no turn of its own', () => {
  const ctx = maskCtx();
  const mask = T.maskOf({ kind: 'square', box: { x: 0, y: 0, w: 1, h: 1 }, fill: 'gradient', gradient: { start: 0, end: 0.5, angle: 90 } });
  D.drawMask(ctx, mask, 200, 100, null, null);
  const [x0, y0, x1, y1] = ctx.calls.find((c) => c[0] === 'gradient')[1].line;
  assert.ok(near(x0, 100) && near(y0, 50) && near(x1, 100, 1e-6) && near(y1, 100), 'straight down from the middle');
});

// ---- the windows' markup ----

/** The buttons of every Accept and Cancel row, in order, by their classes. */
function actionRows() {
  const rows = [...HTML.matchAll(/<div class="crop-actions">([\s\S]*?)<\/div>/g)];
  return rows.map((m) => [...m[1].matchAll(/<button id="(\w+)"(?: class="([\w-]+)")?/g)]
    .map((b) => (b[2] === 'crop-accept-btn' ? 'accept' : b[2] === 'crop-remove-btn' ? 'remove' : 'cancel')));
}

test('every window\'s row is Remove on the left, Cancel in the middle and Accept on the right', () => {
  const rows = actionRows();
  assert.equal(rows.length, 8);
  for (const row of rows) {
    const order = ['remove', 'cancel', 'accept'].filter((k) => row.includes(k));
    assert.deepEqual(row, order);
    assert.ok(row.includes('cancel') && row.includes('accept'));
  }
});

test('the editor windows\' hints are in their Info pop-up, not in the window', () => {
  const pops = [...HTML.matchAll(/<div class="info-tip__pop">([\s\S]*?)\n\s*<\/div>\n\s*<\/div>/g)].map((m) => m[1]);
  assert.equal(pops.length, 5, 'Crop and Mask, Crop Render Frame, Bar, Shape and Text');
  const inPops = pops.join('\n');
  for (const id of ['cropHint', 'cropPanHint', 'placeHint', 'placeZoomHint', 'maskHint', 'maskZoomHint',
    'maskGradHint', 'cropKeysHint', 'renderHint', 'shapeHint', 'shapeGradHint', 'textHint']) {
    assert.ok(inPops.includes('id="' + id + '"'), id + ' is in an Info pop-up');
  }
  const outside = pops.reduce((html, pop) => html.replace(pop, ''), HTML);
  assert.equal(/class="hint-label crop-hint/.test(outside), false, 'no hint line left in a window');
  assert.ok(outside.includes('Modify your gradient below'), 'the line in the swatch\'s place stays, the user\'s word');
});
