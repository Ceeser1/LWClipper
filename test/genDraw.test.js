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
