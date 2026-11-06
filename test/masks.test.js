'use strict';

// V3.6. Masks: the model, between keyframes, the drawing, and the export's graph.

const test = require('node:test');
const assert = require('node:assert/strict');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const D = require('../src/genDraw');
const { buildComposeArgs } = require('../src/composer');

const HD = { width: 1920, height: 1080, fps: 30 };
const R = { x: 320, y: 180, width: 640, height: 360 };
const CIRCLE = { kind: 'circle', box: { x: 0.2, y: 0, w: 0.6, h: 1 } };

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

const near = (a, b) => Math.abs(a - b) < 1e-9;

// ---- the model ----

test('a layer written before masks has none, and only a picture of a file can have one', () => {
  assert.equal(vid({}).mask, null);
  assert.equal(T.createLayer({ kind: 'gen', gen: { form: 'shape' }, mask: CIRCLE }).mask, null);
  assert.equal(T.createLayer({ type: 'audio', src: 'a.mp3', mask: CIRCLE }).mask, null);
  const img = T.createLayer({ kind: 'image', src: 'a.png', mask: CIRCLE });
  assert.equal(img.mask.kind, 'circle');
});

test('a mask keeps its settings, held to their ranges', () => {
  const m = vid({ mask: { kind: 'star', invert: true, soft: 0.1, box: { x: -0.5, y: 0.1, w: 2, h: 0.5 }, points: 7, inner: 0.5 } }).mask;
  assert.deepEqual(m, {
    kind: 'star', invert: true, soft: 0.1, box: { x: -0.5, y: 0.1, w: 2, h: 0.5 }, ring: 0.4, points: 7, inner: 0.5,
    radius: 0, src: null, by: 'alpha', aspect: 1,
    // V3.7.1. Shown in full, as every mask before it was.
    fill: 'color', color: '#ffffffff', gradient: T.maskGradientOf(null),
  });
  const wild = T.maskOf({ kind: 'hexagon', soft: 9, box: { x: 0, y: 0, w: 0, h: 1 }, by: 'red' });
  assert.equal(wild.kind, 'circle');
  assert.equal(wild.soft, 1);
  assert.deepEqual(wild.box, { x: 0, y: 0, w: 1, h: 1 }, 'a box of no size is the whole picture');
  assert.equal(wild.by, 'alpha');
  assert.equal(T.maskOf(null), null);
});

test('a custom mask keeps its picture, and one with none is a circle', () => {
  const m = T.maskOf({ kind: 'custom', src: 'C:/m/logo.png', by: 'luma', aspect: 2 });
  assert.deepEqual([m.kind, m.src, m.by, m.aspect], ['custom', 'C:/m/logo.png', 'luma', 2]);
  assert.equal(T.maskOf({ kind: 'custom' }).kind, 'circle');
  assert.equal(T.maskOf({ kind: 'circle', src: 'C:/x.png' }).src, null, 'only a custom one has a picture');
});

test('setMask puts one on a picture and nothing else; removeMask takes it off every keyframe too', () => {
  const g = T.createLayer({ id: 'g', kind: 'gen', gen: { form: 'bar' } });
  const v = vid({ keyframes: [{ id: 'a', t: 0, mask: { box: CIRCLE.box, soft: 0 } }, { id: 'b', t: 2 }] });
  const [g2, v2] = T.setMask([g, v], 'g', CIRCLE).concat();
  assert.equal(g2.mask, null);
  const [v3] = T.setMask([v], 'v', CIRCLE);
  assert.equal(v3.mask.kind, 'circle');
  const [v4] = T.removeMask([v3], 'v');
  assert.equal(v4.mask, null);
  assert.ok(v4.keyframes.every((k) => k.mask === null));
  assert.equal(v2.id, 'v');
});

// ---- between keyframes ----

test('a video keyframe holds a mask box and soft edge of its own, or none', () => {
  const l = vid({ mask: CIRCLE, keyframes: [{ t: 0, mask: { box: { x: 0, y: 0, w: 0.5, h: 0.5 }, soft: 0.2, kind: 'star' } }, { t: 1 }] });
  assert.deepEqual(l.keyframes[0].mask, { box: { x: 0, y: 0, w: 0.5, h: 0.5 }, soft: 0.2, radius: 0 });
  assert.equal(l.keyframes[1].mask, null);
});

test('the mask blends its box and soft edge between keyframes, one holding none standing for the layer', () => {
  const l = vid({
    mask: { ...CIRCLE, invert: true },
    keyframes: [
      { id: 'a', t: 0 },
      { id: 'b', t: 2, mask: { box: { x: 0, y: 0, w: 1, h: 1 }, soft: 0.2 } },
    ],
  });
  const mid = T.maskAt(l, 1);
  assert.ok(near(mid.box.x, 0.1) && near(mid.box.w, 0.8) && near(mid.box.h, 1));
  assert.ok(near(mid.soft, 0.1));
  assert.equal(mid.invert, true, 'what is not keyed is the layer\'s');
  assert.deepEqual(T.maskAt(l, -5).box, CIRCLE.box);
  assert.deepEqual(T.maskAt(l, 9).box, { x: 0, y: 0, w: 1, h: 1 });
  assert.deepEqual(T.maskMotion(l), { from: 0, to: 2 });
});

test('a mask that holds still on a moving picture is one mask', () => {
  const l = vid({ mask: CIRCLE, keyframes: [{ t: 0, render: R }, { t: 2, render: { ...R, x: 0 } }] });
  assert.equal(T.maskAt(l, 1), l.mask);
  assert.equal(T.maskMotion(l), null);
  assert.equal(T.maskMotion(vid({})), null);
});

test('the last keyframe deleted leaves the first one\'s mask on the layer', () => {
  const l = vid({
    mask: CIRCLE,
    keyframes: [{ id: 'a', t: 0, mask: { box: { x: 0, y: 0, w: 0.3, h: 0.3 }, soft: 0.05 } }, { id: 'b', t: 2 }],
  });
  const [after] = T.removeKeyframe([l], 'v', 'b');
  assert.deepEqual(after.keyframes, []);
  assert.deepEqual(after.mask.box, { x: 0, y: 0, w: 0.3, h: 0.3 });
  assert.equal(after.mask.soft, 0.05);
  assert.equal(after.mask.kind, 'circle');
});

test('a split keeps the mask on both halves', () => {
  const l = vid({ mask: CIRCLE });
  const out = T.splitLayer([l], 'v', 4);
  assert.equal(out.length, 2);
  assert.ok(out.every((h) => h.mask && h.mask.kind === 'circle'));
});

// ---- the drawing ----

test('a new mask starts as the largest of its shape that fits the picture, centred', () => {
  const c = D.maskStartBox({ kind: 'circle' }, 1920, 1080);
  assert.ok(near(c.w, 1080 / 1920) && near(c.h, 1) && near(c.x, (1 - 1080 / 1920) / 2) && c.y === 0);
  const wide = D.maskStartBox({ kind: 'custom', aspect: 4 }, 1920, 1080);
  assert.ok(near(wide.w, 1) && near(wide.h, (1920 / 1080) / 4) && wide.x === 0);
});

test('a mask is drawn as a white shape in its box, in the picture\'s pixels', () => {
  const calls = [];
  const ctx = {
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    ellipse: (...a) => calls.push(['ellipse', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]),
    closePath: () => calls.push(['closePath']),
    fill(rule) { calls.push(['fill', this.fillStyle, rule]); },
    drawImage: (...a) => calls.push(['drawImage', ...a]),
    fillStyle: '',
  };
  D.drawMask(ctx, T.maskOf(CIRCLE), 640, 360, null, null);
  assert.deepEqual(calls[0], ['clearRect', 0, 0, 640, 360]);
  assert.deepEqual(calls.find((c) => c[0] === 'ellipse').slice(1, 5), [320, 180, 192, 180]);
  assert.deepEqual(calls.find((c) => c[0] === 'fill'), ['fill', '#ffffffff', 'nonzero']);
  // A custom one is its picture, stretched to the box.
  calls.length = 0;
  const pic = { id: 'pic' };
  D.drawMask(ctx, T.maskOf({ kind: 'custom', src: 'x.png', box: { x: 0.5, y: 0, w: 0.5, h: 1 } }), 640, 360, pic, null);
  assert.deepEqual(calls.find((c) => c[0] === 'drawImage'), ['drawImage', pic, 320, 0, 320, 360]);
});

test('a custom picture becomes a mask by its alpha or by its brightness', () => {
  const px = () => new Uint8ClampedArray([255, 255, 255, 128, 0, 0, 0, 255, 255, 0, 0, 255]);
  assert.deepEqual(Array.from(D.maskPixels(px(), 'alpha')), [255, 255, 255, 128, 255, 255, 255, 255, 255, 255, 255, 255]);
  const luma = Array.from(D.maskPixels(px(), 'luma'));
  assert.deepEqual([luma[3], luma[7], luma[11]], [128, 0, 54], 'white half seen, black hidden, red a fifth');
  assert.ok(luma.every((v, i) => i % 4 === 3 || v === 255), 'every pixel white');
  assert.equal(D.hasTransparency(px()), true);
  assert.equal(D.hasTransparency(new Uint8ClampedArray([1, 2, 3, 255])), false);
});

// ---- the export ----

function graphOf(args) {
  return args[args.indexOf('-filter_complex') + 1];
}

test('a masked still picture takes its mask as an input, scaled to it and made its alpha before the fades', () => {
  const l = { ...vid({ render: R, fadeIn: 1 }), maskFile: { src: 'C:/c/gen/m.png' } };
  const args = buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: { 'a.mp4': { width: 1920, height: 1080 } } });
  const i = args.indexOf('C:/c/gen/m.png');
  assert.deepEqual(args.slice(i - 7, i), ['-loop', '1', '-framerate', '30', '-t', '10.0', '-i']);
  const g = graphOf(args);
  assert.match(g, /\[1:v\]fps=30,setpts=PTS-STARTPTS\+0\.0\/TB,format=gray,scale=640:360\[mk0\]/);
  assert.match(g, /format=yuva420p\[mp0\]/);
  assert.match(g, /\[mp0\]\[mk0\]alphamerge,fade=t=in/);
  assert.doesNotMatch(g, /alphaextract/, 'a video has no alpha of its own to keep');
});

test('a PNG keeps its own transparency under its mask, the two multiplied', () => {
  const l = { ...T.createLayer({ id: 'p', kind: 'image', src: 'C:/x/logo.png', sourceWidth: 640, sourceHeight: 360, render: R, duration: 5 }),
    maskFile: { src: 'C:/c/gen/m.png' } };
  const g = graphOf(buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4',
    sources: { 'C:/x/logo.png': { width: 640, height: 360 } } }));
  assert.match(g, /\[mp0\]split\[mq0\]\[mr0\];\[mr0\]alphaextract\[ma0\];\[ma0\]\[mk0\]blend=all_mode=multiply\[mb0\];\[mq0\]\[mb0\]alphamerge/);
});

test('a masked picture that moves scales its mask on every frame in place of the plain one', () => {
  const l = { ...vid({ keyframes: [{ t: 0, render: R }, { t: 2, render: { ...R, x: 0 } }] }), maskFile: { src: 'C:/c/gen/m.png' } };
  const g = graphOf(buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: { 'a.mp4': { width: 1920, height: 1080 } } }));
  assert.doesNotMatch(g, /color=c=white/);
  assert.match(g, /\[1:v\]fps=30,setpts=PTS-STARTPTS\+0\.0\/TB,format=gray,scale=w='max\(1\\,round\(/);
  const plain = graphOf(buildComposeArgs({ layers: [vid({ keyframes: [{ t: 0, render: R }, { t: 2, render: { ...R, x: 0 } }] })],
    project: HD, output: 'o.mp4', sources: { 'a.mp4': { width: 1920, height: 1080 } } }));
  assert.match(plain, /color=c=white:s=16x16/, 'without one, the white square as before');
});

test('a mask that changes arrives as its frames, held before and after', () => {
  const l = { ...vid({ render: R }), maskFile: { frames: { pattern: 'C:/c/seq/%05d.png', lead: 1, tail: 2 } } };
  const args = buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: { 'a.mp4': { width: 1920, height: 1080 } } });
  const i = args.indexOf('C:/c/seq/%05d.png');
  assert.deepEqual(args.slice(i - 5, i), ['-framerate', '30', '-start_number', '0', '-i']);
  assert.match(graphOf(args), /\[1:v\]tpad=start_mode=clone:start_duration=1\.0:stop_mode=clone:stop_duration=2\.0,fps=30/);
});

// ---- the project file ----

test('a mask and its keyframes survive a project saved and opened again', () => {
  const P = require('../src/project');
  const l = vid({
    mask: { kind: 'custom', src: 'C:/m/logo.png', by: 'luma', aspect: 2, invert: true, soft: 0.1, box: { x: 0, y: 0, w: 1, h: 0.5 } },
    keyframes: [{ id: 'a', t: 0 }, { id: 'b', t: 2, mask: { box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, soft: 0 } }],
  });
  const doc = P.serialise({ layers: [l], project: HD, trim: { start: 0, end: 10 } });
  const parsed = P.parse(P.stringify(doc));
  assert.equal(parsed.ok, true);
  const back = T.createLayer(parsed.doc.layers[0]);
  assert.deepEqual(back.mask, l.mask);
  assert.deepEqual(back.keyframes.map((k) => k.mask), [null, { box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, soft: 0, radius: 0 }]);
});

// ---- V3.6.4. A square mask's rounded corners ----

test('a mask has no rounded corners unless given them, held to its picture\'s height', () => {
  assert.equal(T.maskOf(CIRCLE).radius, 0, 'a mask written before 3.6.4 is sharp');
  assert.equal(T.maskOf({ kind: 'square', radius: 0.1 }).radius, 0.1);
  assert.equal(T.maskOf({ kind: 'square', radius: 5 }).radius, 1);
  assert.equal(T.maskOf({ kind: 'square', radius: -1 }).radius, 0);
  assert.equal(T.maskOf({ kind: 'square', radius: 'x' }).radius, 0);
});

test('the corners are keyed with the box and the soft edge, blended between keyframes', () => {
  const SQ = { kind: 'square', box: { x: 0, y: 0, w: 1, h: 1 }, radius: 0.1 };
  const l = vid({
    mask: SQ,
    keyframes: [{ id: 'a', t: 0 }, { id: 'b', t: 2, mask: { box: SQ.box, soft: 0, radius: 0.3 } }],
  });
  assert.equal(l.keyframes[1].mask.radius, 0.3);
  assert.ok(near(T.maskAt(l, 1).radius, 0.2), 'halfway from the layer\'s 0.1 to the keyframe\'s 0.3');
  assert.ok(near(T.maskAt(l, 5).radius, 0.3));
  assert.deepEqual(T.maskMotion(l), { from: 0, to: 2 }, 'corners rounding off is a mask that changes');
  const still = vid({ mask: SQ, keyframes: [{ id: 'a', t: 0 }, { id: 'b', t: 2, mask: { box: SQ.box, soft: 0, radius: 0.1 } }] });
  assert.equal(T.maskMotion(still), null);
});

test('the last keyframe deleted leaves the first one\'s corners on the layer', () => {
  const l = vid({
    mask: { kind: 'square', radius: 0 },
    keyframes: [{ id: 'a', t: 0, mask: { box: { x: 0, y: 0, w: 1, h: 1 }, soft: 0, radius: 0.25 } }, { id: 'b', t: 2 }],
  });
  const [after] = T.removeKeyframe([l], 'v', 'b');
  assert.equal(after.mask.radius, 0.25);
});

test('a square mask is drawn with its corners rounded, in the picture\'s pixels and no more than half its side', () => {
  const calls = [];
  const ctx = {
    clearRect() {},
    beginPath() {},
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]),
    arcTo: (...a) => calls.push(['arcTo', ...a]),
    ellipse() {},
    closePath() {},
    fill() {},
    fillStyle: '',
  };
  const box = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  D.drawMask(ctx, T.maskOf({ kind: 'square', box, radius: 0.05 }), 640, 360, null, null);
  const arcs = calls.filter((c) => c[0] === 'arcTo');
  assert.equal(arcs.length, 4);
  assert.ok(arcs.every((c) => near(c[5], 18)), 'a twentieth of 360 pixels');
  calls.length = 0;
  D.drawMask(ctx, T.maskOf({ kind: 'square', box, radius: 1 }), 640, 360, null, null);
  assert.ok(calls.filter((c) => c[0] === 'arcTo').every((c) => near(c[5], 90)), 'half the 180 pixel side');
  calls.length = 0;
  D.drawMask(ctx, T.maskOf({ kind: 'circle', box, radius: 0.05 }), 640, 360, null, null);
  assert.equal(calls.filter((c) => c[0] === 'arcTo').length, 0, 'only a square has corners to round');
});
