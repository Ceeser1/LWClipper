'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/timeline');
const D = require('../src/genDraw');

// A 2D context that measures every character as half its size wide, with a
// font ascent of 0.8 and descent of 0.2 of it, and writes down what it is told
// to draw along with the state it was drawn in.
function fakeCtx() {
  const calls = [];
  const ctx = {
    calls,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    measureText(text) {
      const px = Number(/([\d.]+)px/.exec(this.font)[1]);
      return {
        width: Array.from(text).length * px * 0.5,
        fontBoundingBoxAscent: px * 0.8,
        fontBoundingBoxDescent: px * 0.2,
      };
    },
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    translate(x, y) { calls.push(['translate', x, y]); },
    rotate(a) { calls.push(['rotate', a]); },
    clearRect(...a) { calls.push(['clearRect', ...a]); },
    fillRect(...a) { calls.push(['fillRect', this.fillStyle, ...a]); },
    fillText(text, x, y) { calls.push(['fillText', text, x, y, this.fillStyle, this.font]); },
    strokeText(text, x, y) { calls.push(['strokeText', text, x, y, this.strokeStyle, this.lineWidth]); },
    beginPath() { calls.push(['beginPath']); },
    closePath() { calls.push(['closePath']); },
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    ellipse(...a) { calls.push(['ellipse', ...a]); },
    fill(rule) { calls.push(['fill', this.fillStyle, rule]); },
  };
  return ctx;
}

function gen(g) {
  return T.genOf(g);
}

test('a bar sits on its side, centred along it, at its thickness scaled to the frame', () => {
  const bar = (b) => gen({ form: 'bar', refHeight: 1080, bar: b }).bar;
  // 40px at 1080p is 20px at 540p.
  assert.deepEqual(D.barRect(bar({ side: 'top' }), 0.5, 960, 540), { x: 0, y: 0, w: 960, h: 20 });
  assert.deepEqual(D.barRect(bar({ side: 'bottom', span: 0.5 }), 1, 1920, 1080),
    { x: 480, y: 1040, w: 960, h: 40 });
  assert.deepEqual(D.barRect(bar({ side: 'left', span: 0.5 }), 1, 1920, 1080),
    { x: 0, y: 270, w: 40, h: 540 });
  assert.deepEqual(D.barRect(bar({ side: 'right' }), 1, 1920, 1080),
    { x: 1880, y: 0, w: 40, h: 1080 });
});

test('a bar is never thicker than a quarter of the frame across it, nor thinner than a pixel', () => {
  const thick = gen({ form: 'bar', bar: { side: 'top', thickness: 5000 } }).bar;
  assert.equal(D.barRect(thick, 1, 1920, 1080).h, 270);
  const side = gen({ form: 'bar', bar: { side: 'left', thickness: 5000 } }).bar;
  assert.equal(D.barRect(side, 1, 1920, 1080).w, 480);
  const thin = gen({ form: 'bar', bar: { thickness: 1 } }).bar;
  assert.equal(D.barRect(thin, 0.1, 1920, 1080).h, 1);
});

test('drawing a bar clears the frame and fills one rectangle in its colour', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'bar', bar: { color: '#ff000080' } }), 1920, 1080);
  assert.deepEqual(ctx.calls, [
    ['clearRect', 0, 0, 1920, 1080],
    ['fillRect', '#ff000080', 0, 0, 1920, 40],
  ]);
});

test('text is drawn at its layout position, scaled to the frame', () => {
  const ctx = fakeCtx();
  // 96px at 1080p is 48px at 540p: 24px a character, "Hi" is 48 wide and the
  // line 48 tall, centred in 960x540.
  D.drawGen(ctx, gen({ form: 'text', text: { runs: [{ text: 'Hi' }] } }), 960, 540);
  const fill = ctx.calls.find((c) => c[0] === 'fillText');
  assert.deepEqual(fill.slice(0, 5), ['fillText', 'Hi', 456, 246 + 48 * 0.8, '#ffffffff']);
  assert.match(fill[5], /^48px "Arial"/);
  assert.equal(ctx.calls.some((c) => c[0] === 'strokeText'), false);
});

test('every outline is drawn before any fill, twice its thickness wide', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'text', text: {
    runs: [{ text: 'a\nb' }],
    style: { outline: { color: '#000000ff', width: 3 } },
  } }), 1920, 1080);
  const order = ctx.calls.filter((c) => c[0] === 'strokeText' || c[0] === 'fillText').map((c) => c[0] + c[1]);
  assert.deepEqual(order, ['strokeTexta', 'strokeTextb', 'fillTexta', 'fillTextb']);
  assert.equal(ctx.calls.find((c) => c[0] === 'strokeText')[5], 6);
});

test('underline and strike are drawn as rectangles, outlined when the text is', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'text', text: {
    runs: [{ text: 'ab' }],
    style: { size: 100, underline: true, strike: true, color: '#112233ff', outline: { width: 2 } },
    align: { h: 'left', v: 'top' },
  } }), 1920, 1080);
  const rects = ctx.calls.filter((c) => c[0] === 'fillRect');
  // Baseline at 80. Underline 10 below it, strike 30 above it less half of its
  // 6px thickness. The outline passes come first, 2px bigger all round.
  assert.deepEqual(rects, [
    ['fillRect', '#000000ff', -2, 88, 104, 10],
    ['fillRect', '#000000ff', -2, 45, 104, 10],
    ['fillRect', '#112233ff', 0, 90, 100, 6],
    ['fillRect', '#112233ff', 0, 47, 100, 6],
  ]);
});

test('a rotated text turns about the centre of its box', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'text', text: {
    runs: [{ text: 'x' }], box: { x: 100, y: 100, w: 200, h: 100 }, rotation: 90,
  } }), 1920, 1080);
  assert.deepEqual(ctx.calls.slice(1, 5), [
    ['save'], ['translate', 200, 150], ['rotate', Math.PI / 2], ['translate', -200, -150],
  ]);
});

test('an empty text draws nothing but the clear', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'text' }), 1920, 1080);
  assert.deepEqual(ctx.calls.filter((c) => c[0] !== 'save' && c[0] !== 'restore'),
    [['clearRect', 0, 0, 1920, 1080]]);
});

test('the key changes with the settings and with the frame, and with nothing else', () => {
  const a = gen({ form: 'bar' });
  assert.equal(D.keyOf(a, 1920, 1080), D.keyOf(gen({ form: 'bar' }), 1920, 1080));
  assert.notEqual(D.keyOf(a, 1920, 1080), D.keyOf(a, 1280, 720));
  assert.notEqual(D.keyOf(a, 1920, 1080), D.keyOf(gen({ form: 'bar', bar: { span: 0.5 } }), 1920, 1080));
});

test('the fonts of a text are its own and its runs, each once, and a bar has none', () => {
  const g = gen({ form: 'text', text: {
    style: { font: 'Segoe UI' },
    runs: [{ text: 'a' }, { text: 'b', style: { font: 'Impact' } }, { text: 'c', style: { bold: true } }],
  } });
  assert.deepEqual(D.familiesOf(g), ['Segoe UI', 'Impact']);
  assert.equal(D.fontsOf(g).length, 3);
  assert.deepEqual(D.familiesOf(gen({ form: 'bar' })), []);
});

// ---- 30g, the shadow ----

test('the distance field is exact, including along the diagonals', () => {
  const w = 7;
  const h = 5;
  const inside = new Uint8Array(w * h);
  inside[2 * w + 3] = 1;
  const sq = D.distanceField(inside, w, h);
  assert.equal(sq[2 * w + 3], 0);
  assert.equal(sq[2 * w + 4], 1);
  assert.equal(sq[0 * w + 5], 8);
  assert.equal(sq[4 * w + 0], 13);
  // Two set pixels: each one answers for the side it is nearer.
  inside[2 * w + 0] = 1;
  const two = D.distanceField(inside, w, h);
  assert.equal(two[2 * w + 1], 1);
  assert.equal(two[0 * w + 6], 13);
});

test('with nothing set, every distance is far past any shadow', () => {
  const sq = D.distanceField(new Uint8Array(12), 4, 3);
  for (const d of sq) assert.ok(d >= 1e20);
});

test('the falloff: solid at the letter, fading to nothing at Size, or kept with no Fade-out', () => {
  assert.equal(D.shadowFalloff(0, 10, 1), 1);
  assert.equal(D.shadowFalloff(5, 10, 1), 0.5);
  assert.equal(D.shadowFalloff(10, 10, 1), 0);
  assert.equal(D.shadowFalloff(12, 10, 1), 0);
  // No Fade-out: the colour's alpha all the way out, the last pixel smoothed.
  assert.equal(D.shadowFalloff(9, 10, 0), 1);
  assert.equal(D.shadowFalloff(10, 10, 0), 0.5);
  assert.equal(D.shadowFalloff(11, 10, 0), 0);
  // Half Fade-out: half the alpha left at the far edge.
  assert.equal(D.shadowFalloff(8, 8, 0.5) * 2, 0.5);
});

test('the shadow pixels are the colour, its alpha times the falloff, from half coverage in', () => {
  const w = 10;
  const h = 1;
  const mask = new Uint8ClampedArray(w * 4);
  mask[4 * 4 + 3] = 255;   // the letter, one pixel
  mask[3 * 4 + 3] = 100;   // its soft edge, under half
  const out = D.shadowPixels(mask, w, h, { color: '#ff800080', size: 4, fade: 1 }, 1);
  const alpha = (i) => out[i * 4 + 3];
  assert.deepEqual([out[16], out[17], out[18]], [255, 128, 0]);
  assert.equal(alpha(4), 128);
  // One pixel out is half a pixel from the edge: 1 - 0.5 / 4 of 128.
  assert.equal(alpha(5), Math.round(0.875 * 128));
  assert.equal(alpha(6), Math.round(0.625 * 128));
  assert.equal(alpha(8), Math.round(0.125 * 128));
  assert.equal(alpha(9), 0);
  // The soft edge keeps the falloff, which is more than its own 100.
  assert.equal(alpha(3), alpha(5));
});

test('the shadow falls along its angle: 0 right, positive clockwise, scaled with the frame', () => {
  const o = D.shadowOffset({ angle: 0, distance: 10 }, 2);
  assert.deepEqual([o.x, o.y], [20, 0]);
  const down = D.shadowOffset({ angle: 90, distance: 10 }, 1);
  assert.ok(Math.abs(down.x) < 1e-9 && Math.abs(down.y - 10) < 1e-9);
  const left = D.shadowOffset({ angle: -180, distance: 10 }, 1);
  assert.ok(Math.abs(left.x + 10) < 1e-9);
});

// A mask surface that has one opaque 2x2 square at (50, 60) and records what
// is put back on it.
function fakeSurface(log) {
  return (w, h) => {
    const s = fakeCtx();
    s.canvas = { width: w, height: h, name: 'mask' };
    s.setTransform = () => {};
    s.getImageData = (x, y, gw, gh) => {
      const data = new Uint8ClampedArray(gw * gh * 4);
      for (let j = 0; j < gh; j += 1) {
        for (let i = 0; i < gw; i += 1) {
          const px = x + i;
          const py = y + j;
          if (px >= 50 && px < 52 && py >= 60 && py < 62) data[(j * gw + i) * 4 + 3] = 255;
        }
      }
      return { data, width: gw, height: gh };
    };
    s.putImageData = (img, x, y) => log.push(['put', x, y, img.width, img.height]);
    log.push(['surface', w, h, s]);
    return s;
  };
}

test('the shadow is drawn under the outline and the fill, offset along its angle', () => {
  const ctx = fakeCtx();
  ctx.drawImage = (...a) => ctx.calls.push(['drawImage', a[0].name, ...a.slice(1)]);
  const log = [];
  D.drawGen(ctx, gen({ form: 'text', refHeight: 1080, text: {
    runs: [{ text: 'a' }],
    style: {
      outline: { width: 2 },
      shadow: { color: '#000000ff', angle: 0, distance: 10, size: 4, fade: 1 },
    },
  } }), 1920, 1080, fakeSurface(log));
  const order = ctx.calls.map((c) => c[0]).filter((n) => ['drawImage', 'strokeText', 'fillText'].includes(n));
  assert.deepEqual(order, ['drawImage', 'strokeText', 'fillText']);
  // The mask is the frame grown by Size and Distance and two to spare.
  const [, mw, mh, mask] = log[0];
  const pad = 4 + 10 + 2;
  assert.deepEqual([mw, mh], [1920 + pad * 2, 1080 + pad * 2]);
  // The letters go onto the mask in black, outline and fill.
  const inked = mask.calls.filter((c) => c[0] === 'strokeText' || c[0] === 'fillText');
  assert.deepEqual(inked.map((c) => c[0] === 'strokeText' ? c[4] : c[4]), ['#000000', '#000000']);
  // Only the ink's surroundings go through the transform: 2x2 and 6 round it.
  const put = log.find((l) => l[0] === 'put');
  assert.deepEqual(put.slice(1), [44, 54, 14, 14]);
  const draw = ctx.calls.find((c) => c[0] === 'drawImage');
  assert.deepEqual(draw.slice(1), ['mask', 44, 54, 14, 14, 44 - pad + 10, 54 - pad, 14, 14]);
});

test('no shadow, no mask; and nowhere to draw one, no shadow', () => {
  const log = [];
  D.drawGen(fakeCtx(), gen({ form: 'text', text: { runs: [{ text: 'a' }] } }), 1920, 1080, fakeSurface(log));
  assert.equal(log.length, 0);
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'text', text: { runs: [{ text: 'a' }], style: { shadow: {} } } }),
    1920, 1080, () => null);
  assert.ok(ctx.calls.some((c) => c[0] === 'fillText'));
});

// ---- 3.2, words formatted one by one ----

test('each run is drawn in its own font, size and colour, on the line\'s one baseline', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'text', refHeight: 1080, text: {
    runs: [
      { text: 'ab ' },
      { text: 'cd', style: { size: 200, color: '#ff0000ff', bold: true } },
      { text: ' ef', style: { font: 'Impact' } },
    ],
    style: { size: 100, color: '#ffffffff' },
    align: { h: 'left', v: 'top' },
  } }), 1920, 1080);
  const fills = ctx.calls.filter((c) => c[0] === 'fillText');
  // 50 a character at 100, 100 at 200; the line's ascent is the big run's 160.
  assert.deepEqual(fills.map((c) => c.slice(1, 5)), [
    ['ab ', 0, 160, '#ffffffff'],
    ['cd', 150, 160, '#ff0000ff'],
    [' ef', 350, 160, '#ffffffff'],
  ]);
  assert.match(fills[1][5], /^bold 200px "Arial"/);
  assert.match(fills[2][5], /^100px "Impact"/);
});

test('an underline runs under each run at that run\'s own size and colour', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'text', refHeight: 1080, text: {
    runs: [{ text: 'ab' }, { text: 'cd', style: { size: 200, color: '#00ff00ff' } }],
    style: { size: 100, underline: true, color: '#112233ff' },
    align: { h: 'left', v: 'top' },
  } }), 1920, 1080);
  const rects = ctx.calls.filter((c) => c[0] === 'fillRect');
  // Baseline 160. At 100: 10 below it, 6 thick; at 200: 20 below, 12 thick.
  assert.deepEqual(rects, [
    ['fillRect', '#112233ff', 0, 170, 100, 6],
    ['fillRect', '#00ff00ff', 100, 180, 200, 12],
  ]);
});

test('outline and shadow are the whole text\'s: every run outlined, one mask for all', () => {
  const ctx = fakeCtx();
  ctx.drawImage = (...a) => ctx.calls.push(['drawImage', a[0].name, ...a.slice(1)]);
  const log = [];
  D.drawGen(ctx, gen({ form: 'text', text: {
    runs: [
      { text: 'a ', style: { outline: null, shadow: null } },
      { text: 'b', style: { color: '#ff0000ff' } },
    ],
    style: {
      outline: { width: 2, color: '#0000ffff' },
      shadow: { color: '#000000ff', angle: 0, distance: 10, size: 4, fade: 1 },
    },
  } }), 1920, 1080, fakeSurface(log));
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'strokeText').map((c) => [c[1], c[4]]),
    [['a ', '#0000ffff'], ['b', '#0000ffff']]);
  assert.equal(log.filter((l) => l[0] === 'surface').length, 1);
  assert.equal(ctx.calls.filter((c) => c[0] === 'drawImage').length, 1);
});

// ---- shapes ----

const near = (a, b) => Math.abs(a - b) < 1e-9;

test('a shape with no box is centred, a third of the frame high, in its own proportions', () => {
  const circle = gen({ form: 'shape', shape: { kind: 'circle' } });
  assert.deepEqual(D.shapeBox(circle, 1920, 1080), { x: 780, y: 360, w: 360, h: 360 });
  const tri = D.shapeBox(gen({ form: 'shape', shape: { kind: 'triangle' } }), 1920, 1080);
  assert.ok(near(tri.w, 360 * 2 / Math.sqrt(3)));
  assert.ok(near(tri.x, (1920 - tri.w) / 2));
});

test('a shape with its own box is scaled to the frame like every other size', () => {
  const g = gen({ form: 'shape', refHeight: 1080, shape: { kind: 'square', box: { x: 150, y: 60, w: 300, h: 120 } } });
  assert.deepEqual(D.shapeBox(g, 960, 540), { x: 75, y: 30, w: 150, h: 60 });
});

test('a square fills its box in its colour', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'shape', shape: { kind: 'square', color: '#ff000080', box: { x: 10, y: 20, w: 30, h: 40 } } }),
    1920, 1080);
  assert.deepEqual(ctx.calls.slice(1), [
    ['beginPath'], ['moveTo', 10, 20], ['lineTo', 40, 20], ['lineTo', 40, 60], ['lineTo', 10, 60], ['closePath'],
    ['fill', '#ff000080', 'nonzero'],
  ]);
});

test('a triangle points up from the middle of the top', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'shape', shape: { kind: 'triangle', box: { x: 0, y: 0, w: 100, h: 50 } } }), 1920, 1080);
  assert.deepEqual(ctx.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo'),
    [['moveTo', 50, 0], ['lineTo', 100, 50], ['lineTo', 0, 50]]);
});

test('a star has ten corners that reach every side of its box and no further', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'shape', shape: { kind: 'star', box: { x: 0, y: 0, w: 100, h: 100 } } }), 1920, 1080);
  const pts = ctx.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo');
  assert.equal(pts.length, 10);
  const xs = pts.map((p) => p[1]);
  const ys = pts.map((p) => p[2]);
  assert.ok(near(Math.min(...xs), 0) && near(Math.max(...xs), 100));
  assert.ok(near(Math.min(...ys), 0) && near(Math.max(...ys), 100));
  assert.ok(near(pts[0][1], 50) && near(pts[0][2], 0), 'the first point is the top');
});

test('a circle is an ellipse filling its box; a ring cuts its hole by the even-odd rule', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, gen({ form: 'shape', shape: { kind: 'circle', box: { x: 0, y: 0, w: 200, h: 100 } } }), 1920, 1080);
  assert.deepEqual(ctx.calls.find((c) => c[0] === 'ellipse').slice(1, 5), [100, 50, 100, 50]);
  const ring = fakeCtx();
  D.drawGen(ring, gen({ form: 'shape', shape: { kind: 'ring', box: { x: 0, y: 0, w: 200, h: 200 } } }), 1920, 1080);
  const ellipses = ring.calls.filter((c) => c[0] === 'ellipse');
  assert.equal(ellipses.length, 2);
  // The hole every ring had: 60% of the width, a band of 40% of the radius.
  assert.deepEqual(ellipses[1].slice(1, 5), [100, 100, 60, 60]);
  assert.equal(ring.calls.find((c) => c[0] === 'fill')[2], 'evenodd');
});

// ---- V3.5, the shapes version ----

// The recording context with what an inverted, outlined or soft shape asks
// of a canvas as well, the compositing and the blur written down with each
// call that draws.
function shapeCtx(width = 1920, height = 1080) {
  const ctx = fakeCtx();
  const calls = ctx.calls;
  const state = [];
  Object.assign(ctx, {
    canvas: { width, height },
    globalCompositeOperation: 'source-over',
    filter: 'none',
    lineJoin: 'miter',
    miterLimit: 10,
    transform: [1, 0, 0, 1, 0, 0],
    save() {
      state.push([this.globalCompositeOperation, this.filter, this.transform]);
      calls.push(['save']);
    },
    restore() {
      [this.globalCompositeOperation, this.filter, this.transform] = state.pop();
      calls.push(['restore']);
    },
    rect(...a) { calls.push(['rect', ...a]); },
    clip(rule) { calls.push(['clip', rule]); },
    stroke() { calls.push(['stroke', this.strokeStyle, this.lineWidth, this.globalCompositeOperation]); },
    fill(rule) { calls.push(['fill', this.fillStyle, rule, this.globalCompositeOperation]); },
    fillRect(...a) { calls.push(['fillRect', this.fillStyle, ...a, this.globalCompositeOperation]); },
    setTransform(...m) { this.transform = m; },
    getTransform() {
      const [a, b, c, d, e, f] = this.transform;
      return { a, b, c, d, e, f };
    },
    drawImage(img, x, y) { calls.push(['drawImage', img, x, y, this.filter, this.globalCompositeOperation]); },
  });
  return ctx;
}

function shapeGen(shape) {
  return gen({ form: 'shape', refHeight: 1080, shape: { box: { x: 100, y: 100, w: 200, h: 200 }, ...shape } });
}

test('a star has its points, its inner corners at its inner radius, and fills its box', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, shapeGen({ kind: 'star', points: 7, inner: 0.5, box: { x: 0, y: 0, w: 100, h: 100 } }), 1920, 1080);
  const pts = ctx.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo');
  assert.equal(pts.length, 14);
  const xs = pts.map((p) => p[1]);
  const ys = pts.map((p) => p[2]);
  assert.ok(near(Math.min(...xs), 0) && near(Math.max(...xs), 100));
  assert.ok(near(Math.min(...ys), 0) && near(Math.max(...ys), 100));
  // The regular five-point star is the one every star from before 3.5 is.
  assert.ok(near(D.shapeAspect({ kind: 'star', points: 5, inner: 0.381966 }), D.SHAPE_ASPECT.star));
  assert.ok(near(D.shapeAspect({ kind: 'star', points: 6, inner: 0.5 }), Math.sqrt(3) / 2), 'six points, flat sides');
  assert.equal(D.shapeAspect({ kind: 'triangle' }), D.SHAPE_ASPECT.triangle);
});

test('a ring is as thick as its setting, a share of its radius', () => {
  const ctx = fakeCtx();
  D.drawGen(ctx, shapeGen({ kind: 'ring', ring: 0.25, box: { x: 0, y: 0, w: 200, h: 100 } }), 1920, 1080);
  const ellipses = ctx.calls.filter((c) => c[0] === 'ellipse');
  assert.deepEqual(ellipses[1].slice(1, 5), [100, 50, 75, 37.5]);
});

test('an inverted shape colours the frame and nothing past it, then cuts the shape out', () => {
  const ctx = shapeCtx();
  D.drawGen(ctx, shapeGen({ kind: 'circle', color: '#00000099', invert: true }), 1920, 1080, null);
  const c = ctx.calls;
  const at = (name) => c.findIndex((x) => x[0] === name);
  assert.deepEqual(c[at('rect')], ['rect', 0, 0, 1920, 1080]);
  assert.ok(at('clip') > at('rect'));
  assert.deepEqual(c.find((x) => x[0] === 'fillRect'), ['fillRect', '#00000099', 0, 0, 1920, 1080, 'source-over'],
    'its own alpha kept');
  const cut = c.find((x) => x[0] === 'fill');
  assert.deepEqual(cut, ['fill', '#000000', 'nonzero', 'destination-out'], 'opaque, so the hole is clear');
  assert.equal(ctx.globalCompositeOperation, 'source-over', 'left as it was found');
});

test('Outline Only strokes twice the band inside the shape, held there by a clip', () => {
  const ctx = shapeCtx();
  D.drawGen(ctx, shapeGen({ kind: 'square', color: '#ff0000ff', outline: true, line: 12 }), 960, 540, null);
  const c = ctx.calls;
  // At half the reference height: 6 pixels of band, a 12 pixel stroke.
  assert.deepEqual(c.find((x) => x[0] === 'clip'), ['clip', 'nonzero']);
  assert.deepEqual(c.find((x) => x[0] === 'stroke'), ['stroke', '#ff0000ff', 12, 'source-over']);
  assert.equal(c.filter((x) => x[0] === 'fill').length, 0, 'nothing filled');
  const ring = shapeCtx();
  D.drawGen(ring, shapeGen({ kind: 'ring', outline: true }), 1920, 1080, null);
  assert.deepEqual(ring.calls.find((x) => x[0] === 'clip'), ['clip', 'evenodd'], 'round the hole too');
});

test('a soft edge is the sharp shape blurred back from a surface with room for the blur', () => {
  const ctx = shapeCtx(1920, 1080);
  let asked = null;
  const surface = (w, h) => {
    asked = shapeCtx(w, h);
    return asked;
  };
  D.drawGen(ctx, shapeGen({ kind: 'circle', color: '#ffffffff', soft: 25 }), 1920, 1080, surface);
  const sigma = 25 / D.SOFT_SPREAD;
  const pad = Math.ceil(sigma * 3) + 2;
  assert.deepEqual([asked.canvas.width, asked.canvas.height], [1920 + pad * 2, 1080 + pad * 2]);
  assert.deepEqual(asked.calls.find((x) => x[0] === 'fill'), ['fill', '#ffffffff', 'nonzero', 'source-over']);
  const blit = ctx.calls.find((x) => x[0] === 'drawImage');
  assert.equal(blit[1], asked.canvas);
  assert.deepEqual(blit.slice(2), [-pad, -pad, 'blur(' + sigma + 'px)', 'source-over']);
  assert.equal(ctx.filter, 'none', 'the blur ends with the drawing');
  // Inverted, the blurred shape is what cuts the hole.
  const inv = shapeCtx();
  D.drawGen(inv, shapeGen({ kind: 'circle', invert: true, soft: 25 }), 1920, 1080, surface);
  assert.equal(inv.calls.find((x) => x[0] === 'drawImage')[5], 'destination-out');
  // With no surface to be had, a sharp shape rather than none.
  const bare = shapeCtx();
  D.drawGen(bare, shapeGen({ kind: 'circle', soft: 25 }), 1920, 1080, null);
  assert.equal(bare.calls.filter((x) => x[0] === 'fill').length, 1);
});

test('a soft edge follows the canvas the frame is drawn into, offset or not', () => {
  const ctx = shapeCtx(3000, 2000);
  ctx.transform = [1, 0, 0, 1, 400, 300];
  let asked = null;
  D.drawGen(ctx, shapeGen({ kind: 'square', soft: 10 }), 1920, 1080, (w, h) => (asked = shapeCtx(w, h)));
  const pad = Math.ceil((10 / D.SOFT_SPREAD) * 3) + 2;
  assert.deepEqual([asked.canvas.width, asked.canvas.height], [3000 + pad * 2, 2000 + pad * 2]);
  // The ink is laid in the frame's own units, under the canvas's offset and
  // the margin, which the surface's transform carries.
  assert.deepEqual(asked.calls.find((x) => x[0] === 'moveTo'), ['moveTo', 100, 100]);
});

test('an inverted shape on its clip is its colour round the shape, cut by the even-odd rule', () => {
  const ctx = shapeCtx();
  D.drawShapeIcon(ctx, { kind: 'circle', color: '#ff0000ff', invert: true }, { x: 10, y: 10, w: 20, h: 20 }, 0);
  const c = ctx.calls;
  assert.deepEqual(c.find((x) => x[0] === 'rect'), ['rect', 6, 6, 28, 28]);
  assert.deepEqual(c.find((x) => x[0] === 'fill'), ['fill', '#ff0000ff', 'evenodd', 'source-over']);
  assert.equal(c.filter((x) => x[0] === 'clip').length, 0, 'nothing that could cut into the clip');
});

test('a shape has no fonts', () => {
  assert.deepEqual(D.familiesOf(gen({ form: 'shape' })), []);
  assert.deepEqual(D.fontsOf(gen({ form: 'shape' })), []);
});
