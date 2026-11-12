'use strict';

// V4.6. A gradient on the letters of a text: the model, the runs, where the
// drawing lays it, and the window's markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/timeline');
const R = require('../src/textRuns');
const D = require('../src/genDraw');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = read('renderer', 'index.html');

const near = (a, b, reach = 1e-6) => Math.abs(a - b) <= reach;

const RED_BLUE = { stops: [{ at: 0, color: '#ff0000ff' }, { at: 1, color: '#0000ffff' }], start: -0.5, end: 0.5, angle: 0 };
const WHITE_BLACK = T.textGradientOf({});

// A 2D context that measures every character as half its size wide, with a
// font ascent of 0.8 and descent of 0.2 of it, and writes down every fill and
// every gradient it is asked for.
function gradCtx() {
  const calls = [];
  return {
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
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    clearRect() {},
    fillRect() {},
    strokeText() {},
    fillText(text) { calls.push(['fillText', text, this.fillStyle]); },
    createLinearGradient(x0, y0, x1, y1) {
      const g = { line: [x0, y0, x1, y1], stops: [] };
      g.addColorStop = (at, color) => g.stops.push([at, color]);
      calls.push(['gradient', g]);
      return g;
    },
  };
}

// A text of 100px letters, each 50 wide and 100 high, in a 1000 by 400 box at
// the frame's corner, laid from its top left.
function textGen(runs, style) {
  return T.genOf({
    form: 'text',
    refHeight: 1080,
    text: {
      runs,
      style: { size: 100, color: '#ffffffff', ...style },
      align: { h: 'left', v: 'top' },
      box: { x: 0, y: 0, w: 1000, h: 400 },
    },
  });
}

test('a text has no gradient unless it is given one, and a run may carry its own', () => {
  assert.equal(T.genOf({ form: 'text' }).text.style.gradient, null);
  assert.ok(T.RUN_FIELDS.includes('gradient'));
  const g = T.genOf({ form: 'text', text: { runs: [
    { text: 'a', style: { gradient: { stops: [{ at: 0, color: '#FF0000' }, { at: 1, color: '#0000ff' }], angle: 450 } } },
    { text: 'b', style: { gradient: null } },
    { text: 'c', style: { gradient: 'nonsense' } },
    { text: 'd' },
  ] } }).text;
  assert.deepEqual(g.runs[0].style.gradient, { ...RED_BLUE, angle: 90 }, 'edge to edge by default, the angle kept in range');
  assert.equal(g.runs[1].style.gradient, null, 'a run may turn the text\'s gradient off');
  assert.equal(g.runs[2].style.gradient, null, 'nonsense is none');
  assert.equal('gradient' in g.runs[3].style, false, 'a run that says nothing changes nothing');
});

test('a text gradient is shares of its letters\' box, white into black by default', () => {
  assert.equal(T.textGradientOf(null), null);
  assert.deepEqual(WHITE_BLACK, {
    stops: [{ at: 0, color: '#ffffffff' }, { at: 1, color: '#000000ff' }], start: -0.5, end: 0.5, angle: 0,
  });
  const g = T.textGradientOf({ start: -500, end: 0.25, angle: 30 });
  assert.equal(g.start, -100, 'held to its range');
  assert.equal(g.end, 0.25);
});

test('two gradients are one when they say the same', () => {
  const copy = JSON.parse(JSON.stringify(RED_BLUE));
  assert.equal(T.gradientKey(RED_BLUE), T.gradientKey(copy));
  assert.notEqual(T.gradientKey(RED_BLUE), T.gradientKey({ ...RED_BLUE, angle: 1 }));
  assert.equal(T.gradientKey(null), '');
  assert.ok(R.sameValue(RED_BLUE, copy));
  assert.equal(R.sameValue(RED_BLUE, null), false);
  assert.equal(R.sameValue(RED_BLUE, WHITE_BLACK), false);
  assert.ok(R.sameValue(null, null));
});

test('runs with the same gradient are joined, and one all of the text has is the text\'s', () => {
  const base = T.genOf({ form: 'text' }).text.style;
  const full = R.expand([{ text: 'Hello World', style: {} }], base);
  const part = R.applyStyle(full, 0, 5, { gradient: RED_BLUE });
  const c = R.compress(R.applyStyle(part, 5, 11, { gradient: JSON.parse(JSON.stringify(RED_BLUE)) }), base);
  assert.equal(c.runs.length, 1, 'two copies of one gradient are one run');
  assert.deepEqual(c.style.gradient, RED_BLUE);
  assert.deepEqual(c.runs[0].style, {});
  const half = R.compress(part, base);
  assert.equal(half.style.gradient, null);
  assert.deepEqual(half.runs.map((r) => [r.text, r.style]), [['Hello', { gradient: RED_BLUE }], [' World', {}]]);
});

test('the toolbar sees a gradient on part of a selection as mixed', () => {
  const base = T.genOf({ form: 'text' }).text.style;
  const full = R.applyStyle(R.expand([{ text: 'Hello World', style: {} }], base), 0, 5, { gradient: RED_BLUE });
  assert.equal(R.selectionStyle(full, 0, 5).mixed.includes('gradient'), false);
  assert.deepEqual(R.selectionStyle(full, 0, 5).style.gradient, RED_BLUE);
  assert.ok(R.selectionStyle(full, 0, 11).mixed.includes('gradient'));
});

test('a stretch is neighbouring runs with one gradient, whatever else they differ in', () => {
  const base = T.genOf({ form: 'text' }).text.style;
  let full = R.expand([{ text: 'Hello big World', style: {} }], base);
  full = R.applyStyle(full, 0, 5, { gradient: RED_BLUE });
  full = R.applyStyle(full, 2, 4, { bold: true });
  full = R.applyStyle(full, 10, 15, { gradient: RED_BLUE });
  assert.deepEqual(R.stretches(full).map((s) => [s.from, s.to]), [[0, 5], [10, 15]],
    'bold in the middle does not cut it, plain letters between two do');
  full = R.applyStyle(full, 5, 10, { gradient: WHITE_BLACK });
  assert.deepEqual(R.stretches(full).map((s) => [s.from, s.to]), [[0, 5], [5, 10], [10, 15]]);
  assert.deepEqual(R.stretches(R.expand([{ text: 'plain', style: {} }], base)), []);
});

test('a gradient runs across the box round its letters, each stretch its own', () => {
  const ctx = gradCtx();
  // "ab" and "ef" carry it, "cd" between them does not: 50 wide letters.
  D.drawGen(ctx, textGen([
    { text: 'ab', style: { gradient: RED_BLUE } },
    { text: 'cd' },
    { text: 'ef', style: { gradient: RED_BLUE } },
  ]), 1920, 1080);
  const grads = ctx.calls.filter((c) => c[0] === 'gradient').map((c) => c[1]);
  assert.equal(grads.length, 2, 'one for each stretch');
  assert.deepEqual(grads[0].line, [0, 50, 100, 50], 'edge to edge of "ab", through its middle');
  assert.deepEqual(grads[1].line, [200, 50, 300, 50], 'and of "ef"');
  assert.deepEqual(grads[0].stops, [[0, '#ff0000ff'], [1, '#0000ffff']]);
  const fills = ctx.calls.filter((c) => c[0] === 'fillText');
  assert.deepEqual(fills.map((c) => c[1]), ['ab', 'cd', 'ef']);
  assert.equal(fills[0][2], grads[0]);
  assert.equal(fills[1][2], '#ffffffff', 'letters without one keep their colour');
  assert.equal(fills[2][2], grads[1]);
});

test('one stretch over two lines and two sizes is one gradient over all of it', () => {
  const ctx = gradCtx();
  // A hard break: "abcd" over "ef", the second line half the size.
  const gen = textGen([
    { text: 'abcd\n', style: { gradient: { ...RED_BLUE, angle: 90 } } },
    { text: 'ef', style: { gradient: { ...RED_BLUE, angle: 90 }, size: 50 } },
  ]);
  D.drawGen(ctx, gen, 1920, 1080);
  const grads = ctx.calls.filter((c) => c[0] === 'gradient').map((c) => c[1]);
  assert.equal(grads.length, 1);
  // 200 wide, the first line 100 high and the second 50: down the middle.
  const [x0, y0, x1, y1] = grads[0].line;
  assert.ok(near(x0, 100) && near(x1, 100) && near(y0, 0) && near(y1, 150), JSON.stringify(grads[0].line));
  const laid = D.layoutOfText(ctx, gen, 1920, 1080);
  const { list, ids } = D.textStretches(laid);
  assert.deepEqual(ids, [0, 0]);
  assert.deepEqual(list[0].box, { x: 0, y: 0, w: 200, h: 150 });
});

test('Start and End are shares of the box\'s reach along the direction', () => {
  assert.ok(near(D.gradientReach(0, 200, 100), 200));
  assert.ok(near(D.gradientReach(90, 200, 100), 100));
  assert.ok(near(D.gradientReach(45, 100, 100), 100 * Math.SQRT2));
  const box = { x: 10, y: 20, w: 200, h: 100 };
  const l = D.gradientLine({ ...RED_BLUE, start: -0.25, end: 0.5 }, box);
  assert.ok(near(l.x0, 60) && near(l.y0, 70) && near(l.x1, 210) && near(l.y1, 70));
  const flat = D.gradientLine({ ...RED_BLUE, start: 0.1, end: 0.1 }, box);
  assert.ok(near(Math.hypot(flat.x1 - flat.x0, flat.y1 - flat.y0), 0.5), 'never a line of no length');
});

test('a gradient said again from another box is the same line on the picture', () => {
  const whole = { x: 100, y: 50, w: 400, h: 100 };
  for (const angle of [0, 30, 90, -135]) {
    const g = { ...RED_BLUE, start: -0.5, end: 0.5, angle };
    for (const part of [{ x: 100, y: 50, w: 150, h: 100 }, { x: 350, y: 50, w: 150, h: 100 }, { x: 0, y: 0, w: 900, h: 300 }]) {
      const a = D.gradientLine(g, whole);
      const b = D.gradientLine(D.rebaseGradient(g, whole, part), part);
      // The lines need not be the same segment, only the same gradient: the
      // start and end as far along the direction as they were.
      const rad = angle * Math.PI / 180;
      const along = (x, y) => x * Math.cos(rad) + y * Math.sin(rad);
      assert.ok(near(along(a.x0, a.y0), along(b.x0, b.y0), 0.05), 'start at ' + angle);
      assert.ok(near(along(a.x1, a.y1), along(b.x1, b.y1), 0.05), 'end at ' + angle);
    }
  }
  const same = D.rebaseGradient(RED_BLUE, whole, whole);
  assert.deepEqual(same, RED_BLUE);
});

test('a text with no gradient is drawn as it always was', () => {
  const ctx = gradCtx();
  D.drawGen(ctx, textGen([{ text: 'ab' }]), 1920, 1080);
  assert.equal(ctx.calls.filter((c) => c[0] === 'gradient').length, 0);
  assert.equal(ctx.calls.find((c) => c[0] === 'fillText')[2], '#ffffffff');
  // And on a context that cannot make gradients, the letters in their colour.
  const plain = gradCtx();
  delete plain.createLinearGradient;
  D.drawGen(plain, textGen([{ text: 'ab', style: { gradient: RED_BLUE, color: '#00ff00ff' } }]), 1920, 1080);
  assert.equal(plain.calls.find((c) => c[0] === 'fillText')[2], '#00ff00ff');
});

test('the picture\'s key changes with the gradient, so nothing draws a stale one', () => {
  const a = textGen([{ text: 'ab', style: { gradient: RED_BLUE } }]);
  const b = textGen([{ text: 'ab', style: { gradient: { ...RED_BLUE, angle: 10 } } }]);
  assert.notEqual(D.keyOf(a, 1920, 1080), D.keyOf(b, 1920, 1080));
});

test('Edit Text has a Gradient button beside the colour, and a modal with the shape\'s editor', () => {
  const bar = HTML.slice(HTML.indexOf('<div class="text-toolbar">'), HTML.indexOf('<div id="textModes"'));
  const at = bar.indexOf('id="textColorBtn"');
  assert.ok(at > 0 && bar.indexOf('<button id="textGradientBtn" class="text-tool text-tool--gradient">') > at,
    'after the swatch');
  const modal = HTML.slice(HTML.indexOf('<div id="textGradModal"'), HTML.indexOf('<div id="colorModal"'));
  for (const id of ['textGradBar', 'textGradCanvas', 'textGradStart', 'textGradEnd', 'textGradAngle',
    'textGradHelp', 'textGradStage', 'textGradPreview', 'textGradLine', 'textGradBackground',
    'textGradRemoveBtn', 'textGradCancelBtn', 'textGradApplyBtn']) {
    assert.ok(modal.includes('id="' + id + '"'), id);
  }
  assert.ok(modal.includes('To apply a gradient: Right-click somewhere on the preview and drag any direction.'));
  assert.ok(HTML.indexOf('app/gen/textGradient.js') > HTML.indexOf('app/gen/effects.js'), 'loaded after Edit Text');
});

test('the edit box has a copy over it for the gradients, which takes no press', () => {
  const frame = HTML.slice(HTML.indexOf('<div id="textFrame"'), HTML.indexOf('<div id="textGuideX"'));
  assert.ok(frame.indexOf('id="textEditGhost"') > frame.indexOf('id="textEditBox"'));
  assert.equal(/id="textEditGhost"[^>]*contenteditable/.test(frame), false, 'not typed in');
  const css = read('renderer', 'style.css');
  assert.ok(/\.text-edit-ghost\s*\{[^}]*pointer-events:\s*none/.test(css));
  assert.ok(/\.text-edit-ghost\s*\{[^}]*background-clip:\s*text/.test(css));
  const js = read('renderer', 'app', 'gen', 'text.js');
  assert.ok(js.includes("s.webkitTextFillColor = style.gradient ? 'transparent' : '';"));
  assert.ok(js.includes('formatText({ color: picked, gradient: null }, null)'), 'a colour picked takes the gradient off');
});

test('a text\'s gradients survive the project file, and a file from before opens as it was', () => {
  const P = require('../src/project');
  const gen = textGen([
    { text: 'ab', style: { gradient: { ...RED_BLUE, start: -0.25, angle: 30 } } },
    { text: 'cd' },
  ]);
  const layer = T.createLayer({ kind: 'gen', gen, duration: 10 });
  const state = { layers: [layer], project: { width: 1920, height: 1080, fps: 30 }, trim: { start: 0, end: 10 } };
  const out = P.parse(P.stringify(P.serialise(state)));
  assert.equal(out.ok, true);
  const back = T.createLayer(out.doc.layers[0]);
  assert.deepEqual(back.gen, layer.gen);
  assert.deepEqual(back.gen.text.runs[0].style.gradient, { ...RED_BLUE, start: -0.25, angle: 30 });
  // A text written before 4.6 has no gradient field anywhere.
  const old = JSON.parse(JSON.stringify(layer));
  delete old.gen.text.style.gradient;
  old.gen.text.runs = [{ text: 'abcd', style: { bold: true } }];
  const opened = T.createLayer(old).gen.text;
  assert.equal(opened.style.gradient, null);
  assert.deepEqual(opened.runs, [{ text: 'abcd', style: { bold: true } }]);
});
