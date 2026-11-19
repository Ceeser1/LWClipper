'use strict';

// V5.1. The VFX kinds after the first two: the table of kinds and its new
// sorts of setting, Mix, what each kind does as ops (src/vfxOps.js), the ops
// as the encoder's filters, the expressions worked out here as the encoder
// works them out, and the export's graph for a VFX on the whole picture.

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
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const WHOLE = { x: 0, y: 0, width: 1920, height: 1080 };
const FIRST = ['obscure', 'pixelate'];
const LATER = T.VFX_KIND_IDS.filter((k) => !FIRST.includes(k));
// Gravity (5.3.0). The kinds that move the picture and leave its pixels alone.
const MOVERS = LATER.filter((k) => T.vfxKind(k).moves);
// The kinds drawn from ops: every later one but Tilt-Shift, which is Obscure's blur, and the ones that only move the picture.
const OPS = LATER.filter((k) => k !== 'tiltshift' && !MOVERS.includes(k));
const KEYS = ['chromakey', 'lumakey'];
// Apply LUT does nothing until a file is chosen; with one it is a kind like the others.
const LUT_FILE = 'C:' + String.fromCharCode(92) + 'luts' + String.fromCharCode(92) + 'look one.cube';
const START = { lut: { file: LUT_FILE } };

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}
const graphsOf = (args) => args.filter((a, i) => args[i - 1] === '-filter_complex');
const now = (kind, more = {}) => T.vfxAt(T.vfxOf({ kind, box: FULL, ...(START[kind] || {}), ...more }), 0);
const opsOf = (kind, more) => O.opsOf(kind, now(kind, more), 1920, 1080);
const always = () => '';
const when = (ranges) => (ranges ? ":enable='" + JSON.stringify(ranges) + "'" : '');
const fileOf = (kind, more = {}, extra = {}) => ({
  kind, region: WHOLE, steps: [{ ops: opsOf(kind, more) }], on: null, whole: false, full: true, ...extra,
});

// ---- the table ----

test('there are forty and more kinds, every one under a heading of the menu, once', () => {
  assert.ok(T.VFX_KIND_IDS.length >= 57);
  const listed = T.VFX_GROUPS.flatMap((g) => g.kinds);
  assert.deepEqual(listed.slice().sort(), T.VFX_KIND_IDS.slice().sort());
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual(T.VFX_GROUPS.map((g) => g.id), ['hide', 'color', 'stylize', 'distort', 'key', 'time', 'physics']);
  assert.deepEqual(MOVERS, ['gravity']);
});

test('every kind drawn from ops has its row of ops, and no row is left over', () => {
  assert.deepEqual(O.KIND_IDS.slice().sort(), OPS.slice().sort());
  assert.deepEqual(O.opsOf('nothing', {}, 10, 10), []);
});

test('every later kind has its own settings first and numbers a keyframe holds', () => {
  for (const kind of LATER) {
    const def = T.vfxKind(kind);
    // V5.1.3. Its own first, then what its area has: the shape for a kind
    // with two, Invert for every kind with an area, nothing for one without.
    const tail = def.where === 'two' ? ['shape', 'invert'] : (def.area ? ['invert'] : []);
    assert.deepEqual(def.statics.slice(def.statics.length - tail.length).map((s) => s.id), tail, kind);
    const own = def.statics.slice(0, def.statics.length - tail.length);
    assert.equal(own.some((s) => s.id === 'shape' || s.id === 'invert'), false, kind);
    // A number among its own is a speed: it cannot blend, so no keyframe holds it.
    assert.ok(def.statics.every((s) => ['shape', 'check', 'choice', 'color', 'number', 'file', 'curve'].includes(s.type)), kind);
    assert.ok(def.statics.every((s) => s.type !== 'number' || ['speed', 'count', 'segments', 'copies', 'gap', 'decay'].includes(s.id)), kind);
    // V5.5.1. And Gravity's Enabled: a tick on a kind that moves the picture, gating the figures after it.
    assert.ok(def.keyed.every((s) => (s.type === 'number' && (s.in === 'mask' || s.in === 'filter'))
      || (s.type === 'check' && s.gate === true && MOVERS.includes(kind))), kind);
    // The soft edge last where the kind has one, and only with an area.
    const soft = def.keyed.findIndex((s) => s.id === 'soft');
    assert.ok(soft < 0 || (def.area && soft === def.keyed.length - 1), kind);
    const ids = [...def.statics, ...def.keyed].map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, kind + ': no setting twice');
    // A new one does something as it is added, or nobody would see it was.
    // One that moves the picture is off for every drawing of its pixels.
    assert.equal(now(kind).off, MOVERS.includes(kind), kind);
  }
});

test('every kind with an area starts on all of the picture and every one has Mix; Mix 0 is off', () => {
  for (const kind of OPS) {
    const def = T.vfxKind(kind);
    assert.equal(def.fill, def.area ? true : undefined, kind);
    // V5.4. A key has no Mix: half a key is no key.
    if (KEYS.includes(kind)) {
      assert.equal(def.keyed.some((s) => s.id === 'mix'), false, kind);
      continue;
    }
    const mix = def.keyed.find((s) => s.id === 'mix');
    assert.ok(mix && mix.in === 'mask' && mix.def === 100 && mix.min === 0 && mix.max === 100, kind);
    assert.equal(now(kind, { mix: 0 }).off, true, kind);
    assert.equal(now(kind, { mix: 1 }).off, false, kind);
  }
  assert.equal(T.vfxKind('tiltshift').band, true);
  assert.equal(T.vfxKind('tiltshift').keyed.some((s) => s.id === 'mix'), false, 'a blur has Strength');
});

test('a kind whose own figures leave the picture as it is is off', () => {
  assert.equal(now('brightness', { brightness: 0, contrast: 0 }).off, true);
  assert.equal(now('brightness', { brightness: 0, contrast: 1 }).off, false);
  assert.equal(now('huesat', { hue: 0, saturation: 0 }).off, true);
  assert.equal(now('levels', { black: 0, white: 100, gamma: 100, outBlack: 0, outWhite: 100 }).off, true);
  assert.equal(now('lens', { amount: 0 }).off, true);
  assert.equal(now('glow', { intensity: 0 }).off, true);
  assert.equal(now('offset', { x: 0, y: 0 }).off, true);
  assert.equal(now('offset', { x: 100, y: 100 }).off, true, 'all the way round is where it was');
  assert.equal(now('bars', { size: 0 }).off, true);
});

test('a choice is one of its options and a colour six hex digits, or what the kind starts with', () => {
  assert.equal(T.vfxOf({ kind: 'look', look: 'noir' }).look, 'noir');
  assert.equal(T.vfxOf({ kind: 'look', look: 'plaid' }).look, 'tealorange');
  assert.equal(T.vfxOf({ kind: 'duotone', shadows: '#AABBCC' }).shadows, '#aabbcc');
  assert.equal(T.vfxOf({ kind: 'duotone', shadows: 'red' }).shadows, '#1b1464');
  assert.equal(T.vfxOf({ kind: 'duotone', shadows: '#12345' }).shadows, '#1b1464');
  assert.equal(T.vfxOf({ kind: 'brightness', brightness: -500 }).brightness, -100);
  // The options are the ones the ops know.
  assert.deepEqual(T.VFX_LOOKS, O.LOOK_IDS);
  assert.deepEqual(T.VFX_PALETTES, O.PALETTE_IDS);
  assert.deepEqual(T.VFX_EDGE_STYLES, O.EDGE_STYLES);
  assert.deepEqual(T.VFX_FLIP_MODES, O.FLIP_MODES);
  assert.deepEqual(T.VFX_CHANNEL_ORDERS, O.CHANNEL_ORDER_IDS);
});

test('a setting between two keyframes blends, a negative one too', () => {
  const v = T.vfxOf({ kind: 'brightness', box: FULL, keys: [
    { t: 0, box: FULL, rotation: 0, brightness: -100, contrast: 0, mix: 0, soft: 0 },
    { t: 2, box: FULL, rotation: 0, brightness: 100, contrast: 50, mix: 100, soft: 0 },
  ] });
  const mid = T.vfxAt(v, 0.5);
  assert.equal(mid.brightness, -50);
  assert.equal(mid.contrast, 13);
  assert.equal(mid.mix, 25);
  assert.equal(T.vfxAt(v, 0).off, true);
  assert.equal(mid.off, false);
});

test('a Mix keyed up from 0 is not taken for off throughout', () => {
  // Found live: the runs went by the filter's figures alone, of which Invert
  // has none, so the clip's one run was off and the export left the VFX out.
  const v = T.vfxOf({ kind: 'invert', box: FULL, keys: [
    { t: 1, box: FULL, rotation: 0, mix: 0, soft: 0 },
    { t: 2, box: FULL, rotation: 0, mix: 100, soft: 0 },
  ] });
  const runs = T.vfxRuns(vid({ duration: 3 }), v, 30);
  assert.ok(runs.length >= 2);
  assert.equal(runs[0].at.off, true);
  assert.equal(runs[runs.length - 1].at.off, false);
  assert.equal(runs[runs.length - 1].to, 89);
  // One whose keyframes all say the same is still one run.
  const same = T.vfxOf({ kind: 'invert', box: FULL, keys: [
    { t: 1, box: FULL, rotation: 0, mix: 60, soft: 0 },
    { t: 2, box: { x: 0.2, y: 0, w: 0.5, h: 1 }, rotation: 0, mix: 60, soft: 0 },
  ] });
  assert.equal(T.vfxRuns(vid({ duration: 3 }), same, 30).length, 1);
});

test('a VFX covers all of the picture alike when it is a plain square over every edge', () => {
  assert.equal(T.vfxCoversAll(now('sepia')), true);
  assert.equal(T.vfxCoversAll(now('sepia', { mix: 40 })), true, 'Mix takes all of it down alike');
  assert.equal(T.vfxCoversAll(now('sepia', { box: { x: -0.1, y: -0.1, w: 1.5, h: 1.5 } })), true);
  assert.equal(T.vfxCoversAll(now('sepia', { box: { x: 0.1, y: 0, w: 0.9, h: 1 } })), false);
  assert.equal(T.vfxCoversAll(now('brightness')), true);
  assert.equal(T.vfxCoversAll(now('brightness', { shape: 'circle' })), false);
  // V5.1.3. A kind with a box and no choice of shape is a square whatever it is handed.
  assert.equal(T.vfxCoversAll(now('sepia', { shape: 'circle' })), true);
  assert.equal(T.vfxCoversAll(now('sepia', { invert: true })), false);
  assert.equal(T.vfxCoversAll(now('sepia', { soft: 0.1 })), false);
  assert.equal(T.vfxCoversAll(now('sepia', { rotation: 30 })), false);
  assert.equal(T.vfxCoversAll(now('sepia', { rotation: 180 })), true);
  assert.equal(T.vfxCoversAll(now('vignette')), false, 'a vignette starts as a soft circle turned round');
  // V5.1.3. A kind with no area is all of the picture wherever a box is handed to it.
  assert.equal(T.vfxCoversAll(now('bars', { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, rotation: 30 })), true);
  assert.equal(T.vfxCoversAll(now('swirl', { box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })), true);
});

// ---- the expressions ----

test('an expression is worked out as the encoder works it out: cut towards zero, held to 0 to 255', () => {
  assert.deepEqual([...O.tableOf('255-val').slice(0, 3)], [255, 254, 253]);
  assert.equal(O.tableOf('val*0.5')[5], 2, '2.5 is cut to 2');
  assert.equal(O.tableOf('val-300')[200], 0);
  assert.equal(O.tableOf('val*3')[200], 255);
  assert.equal(O.tableOf('clip((val-128)*2+128,0,255)')[100], 72);
  assert.equal(O.tableOf('if(lt(val,64),0+(val-0)*2,if(lt(val,128),128+(val-64)*1,255))')[70], 134);
  assert.equal(O.tableOf('if(gte(val,127.5),255,0)')[127], 0);
  assert.equal(O.tableOf('if(gte(val,127.5),255,0)')[128], 255);
  assert.equal(O.tableOf('255*pow(clip(val*0.00392157,0,1),0.5)')[64], Math.trunc(255 * Math.sqrt(64 * 0.00392157)));
  assert.equal(O.tableOf('floor(val*4/256)*85')[200], 255);
  assert.equal(O.tableOf('val*1.2+-20')[100], 100);
  assert.equal(O.tableOf('1e2+val')[5], 105);
  assert.throws(() => O.compile('val+'), /vfxOps/);
  assert.throws(() => O.compile('nope(val)'), /unknown function/);
  assert.throws(() => O.compile('x+1'), /unknown name/);
});

test('every kind\'s expressions can be read, here and by the encoder alike, and its mixes are within -2 to 2', () => {
  const variants = [
    ...OPS.map((kind) => [kind, {}]),
    ...T.VFX_LOOKS.map((look) => ['look', { look }]),
    ...T.VFX_PALETTES.map((palette) => ['thermal', { palette }]),
    ...T.VFX_EDGE_STYLES.map((style) => ['edges', { style }]),
    ...T.VFX_FLIP_MODES.map((mode) => ['flip', { mode }]),
    ...T.VFX_CHANNEL_ORDERS.map((order) => ['channels', { order }]),
    ['brightness', { brightness: -100, contrast: -100 }], ['brightness', { brightness: 100, contrast: 100 }],
    ['exposure', { exposure: -300, gamma: 10 }], ['exposure', { exposure: 300, gamma: 400 }],
    ['levels', { black: 100, white: 0, gamma: 10, outBlack: 100, outWhite: 0 }],
    ['huesat', { hue: 180, saturation: 100 }], ['huesat', { hue: -90, saturation: -100 }],
    ['vignette', { amount: -100 }], ['shadows', { shadows: -100, highlights: 100 }],
    ['splittone', { amount: 100, shadows: '#000000', highlights: '#ffffff' }],
    ['clarity', { amount: -100 }], ['glow', { threshold: 100, intensity: 200 }],
  ];
  for (const [kind, more] of variants) {
    const ops = opsOf(kind, more);
    assert.ok(ops.length > 0, kind);
    for (const o of ops) {
      const tables = o.op === 'colour' ? [o.a, o.b] : [o.tables, o.table ? [o.table] : null];
      for (const t of tables.filter(Boolean)) for (const e of t) assert.equal(O.tableOf(e).length, 256, kind);
      if (o.m) assert.ok(o.m.length === 9 && o.m.every((x) => x >= -2 && x <= 2), kind);
    }
    const made = O.filtersOf([{ ops }], always, 't');
    assert.ok(made.text.length > 0, kind);
    assert.equal(/undefined|NaN|Infinity/.test(made.text), false, kind + ': ' + made.text);
  }
});

test('the colour kinds are tables and mixes; what they say for plain figures', () => {
  assert.equal(O.filtersOf([{ ops: opsOf('invert') }], always, 't').text, "lutrgb=r='255-val':g='255-val':b='255-val'");
  assert.equal(O.filtersOf([{ ops: opsOf('sepia') }], always, 't').text,
    'colorchannelmixer=rr=0.393:rg=0.769:rb=0.189:gr=0.349:gg=0.686:gb=0.168:br=0.272:bg=0.534:bb=0.131');
  // Black and White: the same three shares on every channel.
  assert.ok(O.filtersOf([{ ops: opsOf('mono') }], always, 't').text.startsWith('colorchannelmixer=rr=0.21:rg=0.72:rb=0.07:gr=0.21:gg=0.72:gb=0.07'));
  // Threshold: grey first, then black or white.
  const th = O.filtersOf([{ ops: opsOf('threshold', { level: 50 }) }], always, 't').text;
  assert.ok(/^colorchannelmixer=rr=0\.2126[^,]*,lutrgb=r='if\(gte\(val,127\.5\),255,0\)'/.test(th));
  // A saturation of -100 is grey, a hue of 0 with it nothing else.
  const grey = opsOf('huesat', { hue: 0, saturation: -100 })[0].m;
  assert.deepEqual(grey.slice(0, 3), grey.slice(3, 6));
  // Channel Swap moves whole channels.
  assert.deepEqual(opsOf('channels', { order: 'bgr' })[0].m, [0, 0, 1, 0, 1, 0, 1, 0, 0]);
  // Posterize to two levels is 0 or 255.
  const two = O.tableOf(opsOf('posterize', { levels: 2 })[0].a[0]);
  assert.deepEqual([two[0], two[127], two[128], two[255]], [0, 0, 255, 255]);
});

test('figures that are a part of the picture\'s height come out in its pixels', () => {
  assert.deepEqual(opsOf('rgbsplit', { amount: 0.01, angle: 0 }), [{ op: 'shift', dx: 11, dy: 0 }]);
  assert.deepEqual(opsOf('rgbsplit', { amount: 0.01, angle: 90 }), [{ op: 'shift', dx: 0, dy: 11 }]);
  assert.equal(opsOf('glow', { radius: 0.02 })[0].sigma, 21.5);
  assert.deepEqual(opsOf('bars', { size: 0.1 }), [{ op: 'bars', px: 108, vertical: false }]);
  assert.deepEqual(opsOf('bars', { size: 0.1, vertical: true }), [{ op: 'bars', px: 192, vertical: true }]);
  assert.deepEqual(opsOf('offset', { x: 25, y: 50 }), [{ op: 'scroll', dx: 480, dy: 540, W: 1920, H: 1080 }]);
});

test('what ops read beside the part they change, and which are worked out of the whole picture', () => {
  assert.deepEqual(O.roomOf(opsOf('sepia')), { margin: 0, whole: false });
  assert.deepEqual(O.roomOf(opsOf('sharpen')), { margin: 2, whole: false });
  assert.deepEqual(O.roomOf(opsOf('glow', { radius: 0.02 })), { margin: 65, whole: false });
  assert.equal(O.roomOf(opsOf('rgbsplit', { amount: 0.01, angle: 0 })).margin, 12);
  for (const kind of ['lens', 'flip', 'scanlines', 'bars', 'offset', 'crt', 'vhs', 'border', 'rotate']) {
    assert.equal(O.roomOf(opsOf(kind)).whole, true, kind);
  }
});

// ---- the ops as filters ----

test('each figure\'s filters are on for its own frames', () => {
  const steps = [
    { ops: opsOf('huesat', { hue: 10 }), ranges: [[0, 4]] },
    { ops: opsOf('huesat', { hue: 20 }), ranges: [[5, 9]] },
  ];
  const made = O.filtersOf(steps, when, 't');
  const parts = made.text.split(',colorchannelmixer');
  assert.equal(parts.length, 2);
  assert.ok(parts[0].endsWith(":enable='[[0,4]]'"));
  assert.ok(made.text.endsWith(":enable='[[5,9]]'"));
  assert.equal(made.forks, 0);
});

test('a glow forks the picture once whatever its figures do, its tables and blurs on by their frames inside', () => {
  const steps = [
    { ops: opsOf('glow', { intensity: 50 }), ranges: [[0, 4]] },
    { ops: opsOf('glow', { intensity: 80 }), ranges: [[5, 9]] },
  ];
  const made = O.filtersOf(steps, when, 'q');
  assert.equal(made.forks, 1);
  assert.equal(made.text.split('split').length, 2, 'one fork');
  assert.equal(made.text.split('gblur').length, 3, 'a blur for each figure');
  assert.equal(made.text.split('lutrgb').length, 3);
  assert.ok(made.text.startsWith('split[qf0a][qf0b];[qf0b]lutrgb='));
  // The colours only: a picture's own alpha is the picture's.
  assert.ok(made.text.endsWith('[qf0a][qf0c]blend=c0_mode=screen:c1_mode=screen:c2_mode=screen'));
  assert.equal(made.text.includes('all_mode'), false);
});

test('Comic is the picture in few levels with its outlines multiplied on: one fork', () => {
  const steps = [
    { ops: opsOf('comic', { levels: 4, edges: 100 }), ranges: [[0, 4]] },
    { ops: opsOf('comic', { levels: 8, edges: 200 }), ranges: [[5, 9]] },
  ];
  const made = O.filtersOf(steps, when, 't');
  assert.equal(made.forks, 1);
  assert.equal(made.text.split('split').length, 2);
  assert.equal(made.text.split('sobel=').length, 3, 'an outline strength for each figure');
  assert.ok(made.text.includes("sobel=planes=7:scale=2:delta=0:enable='[[5,9]]',lutrgb=r='255-val'"));
  assert.ok(made.text.endsWith('[tf0p][tf0c]blend=c0_mode=multiply:c1_mode=multiply:c2_mode=multiply'));
});

test('a positive Lens amount bulges, which is the filter figure the other way round', () => {
  assert.deepEqual(opsOf('lens', { amount: 40 }), [{ op: 'lens', k1: -0.2, cx: 0.5, cy: 0.5 }]);
  assert.deepEqual(opsOf('lens', { amount: -100 }), [{ op: 'lens', k1: 0.5, cx: 0.5, cy: 0.5 }]);
  assert.equal(O.filtersOfOp({ op: 'rotate', deg: 180 })[0], 'rotate=angle=3.14159:fillcolor=black:bilinear=1');
  assert.equal(O.filtersOfOp({ op: 'frame', px: 32, color: [255, 204, 0] })[0], 'drawbox=x=0:y=0:w=iw:h=ih:c=0xffcc00:t=32');
  assert.deepEqual(O.filtersOfOp({ op: 'frame', px: 0, color: [0, 0, 0] }), []);
});

test('Clarity takes the detail out, scales it and puts it back: two forks', () => {
  const made = O.filtersOf([{ ops: opsOf('clarity', { amount: 60, radius: 0.03 }) }], always, 't');
  assert.equal(made.forks, 2);
  assert.equal(made.text,
    "split=3[tf0a][tf0b][tf0d];[tf0b]gblur=sigma=32.5:steps=6[tf0c];[tf0a][tf0c]blend=c0_mode=grainextract:c1_mode=grainextract:c2_mode=grainextract[tf0e];"
    + "[tf0e]lutrgb=r='128+(val-128)*0.6':g='128+(val-128)*0.6':b='128+(val-128)*0.6'[tf0g];"
    + '[tf0d][tf0g]blend=c0_mode=grainmerge:c1_mode=grainmerge:c2_mode=grainmerge');
});

test('a change of planes is written once however many figures there are, and keeps an alpha', () => {
  const steps = [
    { ops: opsOf('oldfilm', { amount: 40 }), ranges: [[0, 4]] },
    { ops: opsOf('oldfilm', { amount: 80 }), ranges: [[5, 9]] },
  ];
  const made = O.filtersOf(steps, when, 't');
  assert.equal(made.text.split('scale=flags=accurate_rnd,format=yuv444p').length, 2);
  assert.equal(made.ends, 'yuv');
  assert.equal(made.text.split('noise=').length, 3);
  // The colours of both figures before it, the grain of both after it.
  assert.ok(made.text.lastIndexOf('lutrgb') < made.text.indexOf('format=yuv444p'));
  assert.ok(made.text.indexOf('noise=') > made.text.indexOf('format=yuv444p'));
  assert.equal(/format=yuv444p:enable/.test(made.text), false, 'a format has no frames to be on for');
  const alpha = O.filtersOf(steps, when, 't', true);
  assert.ok(alpha.text.includes('format=yuva444p') && !alpha.text.includes('format=yuv444p'));
  const crt = O.filtersOf([{ ops: opsOf('crt') }], always, 't', true).text;
  assert.ok(crt.indexOf('format=yuva444p') < crt.indexOf('format=gbrap'));
});

test('a mirror folds one half onto the other, and a picture of odd width keeps its width', () => {
  const left = O.filtersOf([{ ops: O.opsOf('flip', { mode: 'left' }, 1921, 1080) }], always, 't');
  assert.equal(left.forks, 1);
  assert.ok(left.text.includes('crop=961:1080:0:0') && left.text.includes('crop=960:1080:0:0,hflip'));
  assert.ok(left.text.endsWith('hstack=inputs=2'));
  const quad = O.filtersOf([{ ops: opsOf('flip', { mode: 'quad' }) }], always, 't');
  assert.equal(quad.forks, 2);
  assert.ok(quad.text.includes('hstack') && quad.text.includes('vstack'));
  assert.equal(O.filtersOf([{ ops: opsOf('flip', { mode: 'both' }) }], always, 't').text, 'hflip,vflip');
});

test('the lines are counted from the picture\'s corner and run one way only', () => {
  assert.equal(O.filtersOf([{ ops: opsOf('scanlines', { spacing: 4, thickness: 50, darkness: 60 }) }], always, 't').text,
    'drawgrid=x=-50000:w=100000:y=0:h=4:t=2:c=black@0.6');
  assert.ok(O.filtersOf([{ ops: opsOf('scanlines', { vertical: true, spacing: 9 }) }], always, 't').text
    .startsWith('drawgrid=y=-50000:h=100000:x=0:w=9:'));
});

test('Offset lands on the pixel asked for: the filter rounds its place up', () => {
  assert.equal(O.filtersOfOp({ op: 'scroll', dx: 480, dy: 0, W: 1920, H: 1080 })[0], 'scroll=h=0:v=0:hpos=0.24974:vpos=0');
  assert.ok(Math.ceil(0.24974 * 1920) === 480);
});

// ---- the export's graph ----

test('a VFX on all of the picture is put straight on it: no drawing of where it acts, no fork', () => {
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [fileOf('sepia')] }], project: HD, output: 'o.mp4', sources: SRC });
  assert.equal(args.filter((a) => a === '-i').length, 1, 'the file alone');
  const g = graphsOf(args).join(';');
  // To red, green and blue and back with the scaler told to round: left to
  // itself it cuts every value down, and the picture came out 1.1 of 255 darker.
  assert.ok(g.includes('[cv0s]scale=flags=accurate_rnd,format=gbrp,colorchannelmixer=rr=0.393'));
  assert.ok(g.includes('[cv0x0o]scale=flags=accurate_rnd,format=yuv420p[cv0x0oz]'));
  assert.equal(/split|alphamerge|overlay=x=0:y=0:format=yuv420/.test(g.slice(0, g.indexOf('[cv0x0oz]'))), false);
});

test('several in a row stay in their planes and go back to 4:2:0 once, after the last', () => {
  const files = [fileOf('brightness'), fileOf('huesat'), fileOf('sepia'), fileOf('look'), fileOf('sharpen'), fileOf('invert')];
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: files }], project: HD, output: 'o.mp4', sources: SRC });
  const graphs = graphsOf(args);
  assert.equal(graphs.length, 1, 'none of them forks, so all stay in the layers\' graph');
  assert.equal(graphs[0].split('format=yuv420p').length, 3, 'the head\'s, and one after the last');
  assert.equal(graphs[0].split('format=gbrp').length, 2, 'into red, green and blue once, all six working on those');
  assert.equal(graphs[0].split('scale=flags=accurate_rnd').length, 3);
});

test('the graphs are shared out by how often the picture forks, not by how many VFX there are', () => {
  // Three Clarity fork six times: more than a graph holds.
  const forking = [fileOf('clarity'), fileOf('clarity'), fileOf('clarity')];
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: forking }], project: HD, output: 'o.mp4', sources: SRC });
  assert.equal(graphsOf(args).length, 3);
  assert.ok(graphsOf(args)[0].endsWith('[cv0x1o]'));
  // The labels of each are its own.
  assert.ok(graphsOf(args)[0].includes('[cv0x0f0a]') && graphsOf(args)[0].includes('[cv0x1f0a]'));
});

test('one held to a part goes the first two kinds\' way, on red, green and blue', () => {
  const part = { kind: 'invert', src: 'C:/c/gen/m.png', region: { x: 100, y: 200, width: 300, height: 200 },
    steps: [{ ops: opsOf('invert') }], on: null, whole: false };
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [part] }], project: HD, output: 'o.mp4', sources: SRC });
  const g = graphsOf(args).join(';');
  assert.ok(g.includes("[cv0x0b]crop=300:200:100:200,scale=flags=accurate_rnd,format=gbrp,lutrgb=r='255-val':g='255-val':b='255-val',scale=flags=accurate_rnd,format=yuv444p[cv0x0c]"));
  assert.ok(g.includes('alphamerge') && g.includes('overlay=x=100:y=200:format=yuv420'));
  // One worked out of the whole picture is filtered first and cut after.
  const lens = { ...part, kind: 'lens', steps: [{ ops: opsOf('lens') }], whole: true };
  const g2 = graphsOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [lens] }], project: HD, output: 'o.mp4', sources: SRC })).join(';');
  assert.ok(g2.includes('[cv0x0b]scale=flags=accurate_rnd,format=gbrp,lenscorrection=cx=0.5:cy=0.5:k1=-0.2:k2=0:i=bilinear:fc=black,scale=flags=accurate_rnd,format=yuv444p,crop=300:200:100:200[cv0x0c]'));
});

test('a kind with no ops to write, and one this build does not know, are left out', () => {
  const none = { kind: 'sepia', region: WHOLE, steps: [{ ops: [] }], on: null, whole: false, full: true };
  const odd = { kind: 'plaid', region: WHOLE, steps: [{ ops: opsOf('sepia') }], on: null, whole: false, full: true };
  const plain = buildComposeArgs({ layers: [vid({})], project: HD, output: 'o.mp4', sources: SRC });
  for (const f of [none, odd]) {
    assert.deepEqual(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [f] }], project: HD, output: 'o.mp4', sources: SRC }), plain);
  }
});

// ---- the preview, the export's side in the window, and the window ----

test('the preview and the export are both run by the ops, written once', () => {
  const comp = read('renderer', 'app', 'compositor.js');
  const exp = read('renderer', 'app', 'export.js');
  const gl = read('renderer', 'app', 'vfxGl.js');
  const html = read('renderer', 'index.html');
  assert.ok(comp.includes('const ops = vfxOps.opsOf(v.kind, v, src.W, src.H);'));
  assert.ok(comp.includes('vfxGl.passesOf(ops, kx, ky, vfxDrawnAt)'));
  assert.ok(exp.includes('ops: vfxOps.opsOf(now.kind, now, W, H)\n      .filter('));
  // A shader for every op there is a filter for.
  for (const prog of ['colour', 'hold', 'conv', 'sobel', 'blur', 'shift', 'lens', 'flip', 'mirror', 'grid', 'noise', 'screen', 'detail', 'bars', 'scroll', 'comic', 'frame', 'rotate', 'warp', 'lut3d']) {
    assert.ok(gl.includes('\n    ' + prog + ': `'), prog);
    assert.ok(gl.includes("prog: '" + prog + "'"), prog + ' is used');
  }
  // The tables the encoder looks up are the ones the preview looks up.
  assert.ok(gl.includes('vfxOps.tableOf(exprs[0])'));
  // Loaded before what uses them.
  assert.ok(html.indexOf('../src/vfxOps.js') > 0 && html.indexOf('../src/vfxOps.js') < html.indexOf('app/vfxGl.js'));
  assert.ok(html.indexOf('app/vfxGl.js') < html.indexOf('app/compositor.js'));
});

test('Mix takes the drawing of where a VFX acts down, for the preview and the export alike', () => {
  const draw = read('src', 'genDraw.js');
  const body = draw.slice(draw.indexOf('function drawCoverMask('), draw.indexOf('function coverRegion('));
  assert.ok(body.includes('const mix = cover.mix === undefined ? 100 : Number(cover.mix);'));
  assert.ok(body.includes("ctx.globalCompositeOperation = 'destination-in';"));
  const exp = read('renderer', 'app', 'export.js');
  assert.ok(exp.includes("JSON.stringify(['vfxmask', now.areas, now.soft, now.invert, W, H, region, w, h, now.mix])"), 'kept by its Mix too');
  assert.ok(exp.includes('if (kind.plain && flat && !moving && !(at(0).mix < 100) && !(forked && on)) {'));
});

test('every kind, every setting and every option has a name in the window', () => {
  const win = read('renderer', 'app', 'vfx.js');
  const block = (name) => {
    const at = win.indexOf('const ' + name + ' = {');
    assert.ok(at >= 0, name);
    return win.slice(at, win.indexOf('\n};', at));
  };
  const labels = block('VFX_SETTING_LABELS');
  const choices = block('VFX_CHOICE_LABELS');
  const groups = block('VFX_GROUP_NAMES');
  for (const kind of T.VFX_KIND_IDS) {
    const def = T.vfxKind(kind);
    for (const s of [...def.statics, ...def.keyed]) {
      assert.ok(new RegExp('\\n  ' + s.id + ': \\(\\) => t\\(').test(labels), kind + '.' + s.id);
      if (s.type !== 'choice') continue;
      const at = choices.indexOf('\n  ' + s.id + ': {');
      assert.ok(at >= 0, s.id);
      const body = choices.slice(at, choices.indexOf('\n  },', at));
      for (const option of s.options) assert.ok(body.includes('\n    ' + option + ': () => '), s.id + '.' + option);
    }
  }
  for (const g of T.VFX_GROUPS) assert.ok(groups.includes('\n  ' + g.id + ': () => t('), g.id);
  // The two new sorts of setting have a field of their own.
  assert.ok(win.includes("if (s.type === 'choice') {") && win.includes("if (s.type === 'color') {"));
  assert.ok(win.includes("well.type = 'color';"));
  // A kind for the whole picture starts on all of it.
  assert.ok(win.includes('v.box = { x: 0, y: 0, w: vfxPic.width, h: vfxPic.height };'));
});

test('a project keeps every kind with its own settings and its keyframes through a save and an open', () => {
  const P = require('../src/project');
  const list = T.VFX_KIND_IDS.map((kind) => ({ kind, box: FULL }));
  list.push({ kind: 'look', look: 'noir', box: FULL, keys: [
    { id: 'a', t: 0, box: FULL, rotation: 0, mix: 0, soft: 0 },
    { id: 'b', t: 2, box: { x: 0.2, y: 0.1, w: 0.5, h: 0.6 }, rotation: 20, mix: 100, soft: 0.05 },
  ] });
  list.push({ kind: 'duotone', shadows: '#102030', highlights: '#fefefe', box: FULL });
  const l = vid({ vfx: list });
  assert.equal(l.vfx.length, T.VFX_KIND_IDS.length + 2);
  const out = P.parse(P.stringify(P.serialise({ layers: [l], project: HD, trim: { start: 0, end: 10 } })));
  assert.equal(out.ok, true);
  const back = T.createLayer(out.doc.layers[0]).vfx;
  assert.deepEqual(back, l.vfx);
  assert.equal(back[back.length - 2].look, 'noir');
  assert.equal(back[back.length - 2].keys.length, 2);
  assert.equal(back[back.length - 1].shadows, '#102030');
});

test('a warp is one rule for every plane: counted in the picture\'s own pixels, read at the plane\'s scale', () => {
  const wave = O.warpExpr(opsOf('wave', { amount: 0.02, length: 0.2, speed: 10 })[0]);
  assert.equal(wave, 'p(((X/SW)+21.6*sin(0.0290888*(Y/SH)+6.28319*T))*SW,((Y/SH))*SH)+0.5');
  const up = O.warpExpr(opsOf('wave', { vertical: true, amount: 0.02, length: 0.2, speed: 10 })[0]);
  assert.ok(up.startsWith('p(((X/SW))*SW,((Y/SH)+21.6*sin(0.0290888*(X/SW)+'));
  // Half added: the filter cuts its result down to a whole number.
  for (const kind of ['zoom', 'wave', 'ripple', 'swirl', 'shake', 'glitch', 'haze', 'kaleido', 'bulge']) {
    const made = O.filtersOf([{ ops: opsOf(kind), ranges: [[0, 9]] }], when, 't');
    assert.ok(made.text.startsWith("geq=lum='"), kind);
    assert.equal(made.text.split(")+0.5'").length, 4, kind + ': the same rule for brightness and both colour planes');
    assert.ok(made.text.endsWith(":enable='[[0,9]]'"), kind);
    assert.equal(made.forks, 0);
    assert.equal(O.roomOf(opsOf(kind)).whole, true, kind);
    // A picture's own alpha is moved with it.
    assert.equal(O.filtersOf([{ ops: opsOf(kind) }], always, 't', true).text.split(")+0.5'").length, 5, kind);
  }
  // Perspective is black where nothing comes from, each plane with its own figure for black.
  const tilt = O.filtersOf([{ ops: opsOf('perspective') }], always, 't', true).text;
  assert.ok(tilt.includes("+0.5,16)':cb='") && tilt.includes("+0.5,128)':cr='") && tilt.endsWith("+0.5,255)'"));
  assert.equal(tilt.includes('OUT'), false);
  // Tile is smoothed before it is made smaller.
  assert.deepEqual(opsOf('tile', { count: 4 }).map((o) => o.op), ['blur', 'warp']);
  // A zoom of 100 with no shift is off; 200 shows the middle half, 100 to a side its edge.
  assert.equal(now('zoom', { zoom: 100, x: 50, y: 50 }).off, true);
  assert.deepEqual(opsOf('zoom', { zoom: 200, x: 100, y: -100 })[0],
    { op: 'warp', form: 'zoom', iz: 0.5, px: 479.75, py: -269.75, cx: 959.5, cy: 539.5 });
  // Glitch's slices end where a row of colour does.
  assert.equal(opsOf('glitch', { size: 0.0602 })[0].slice % 2, 0);
  // How fast one moves is its own, the same the whole clip long.
  for (const kind of ['wave', 'ripple', 'shake', 'glitch']) {
    assert.ok(T.vfxKind(kind).statics.some((s) => s.id === 'speed' && s.type === 'number'), kind);
    assert.equal(T.vfxKeyedIds(kind).includes('speed'), false, kind);
  }
});

test('a kind worked out pixel by pixel stays on the picture\'s own planes', () => {
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [fileOf('wave'), fileOf('sepia'), fileOf('zoom')] }],
    project: HD, output: 'o.mp4', sources: SRC });
  const g = graphsOf(args).join(';');
  assert.ok(g.includes("[cv0s]geq=lum='"), 'no change of planes before a warp on 4:2:0');
  assert.ok(g.includes('[cv0x0o]scale=flags=accurate_rnd,format=gbrp,colorchannelmixer='));
  assert.ok(g.includes("[cv0x1o]scale=flags=accurate_rnd,format=yuv420p,geq=lum='"), 'and back to them for the next one');
  assert.equal(g.includes('[cv0x2oz]'), false, 'nothing to bring back after the last');
});

test('a VFX that moves by itself keeps a still picture being drawn', () => {
  for (const kind of ['wave', 'ripple', 'shake', 'glitch', 'haze', 'grain', 'oldfilm', 'vhs']) {
    assert.equal(T.vfxMovesAlone(T.vfxOf({ kind, box: FULL })), true, kind);
    assert.equal(T.vfxMovesAlone(T.vfxOf({ kind, box: FULL, mix: 0 })), false, kind + ', switched off');
    // Each of them has a speed or grain: its ops read the clip's time or are random.
    const ops = opsOf(kind);
    assert.ok(ops.some((o) => o.op === 'noise' || (o.op === 'warp' && /[^A-Za-z]T[^A-Za-z]/.test(O.warpExpr(o)))), kind);
  }
  for (const kind of ['sepia', 'zoom', 'swirl', 'lens', 'tile', 'kaleido', 'perspective']) {
    assert.equal(T.vfxMovesAlone(T.vfxOf({ kind, box: FULL })), false, kind);
  }
  assert.equal(T.vfxMovesAlone(null), false);
  const comp = read('renderer', 'app', 'compositor.js');
  assert.ok(comp.includes('timelineModel.vfxMoves(v) || timelineModel.vfxMovesAlone(v)'));
  assert.ok(comp.includes('vfxDrawnAt = at - layer.start;'), 'the clip\'s own time, as the encoder counts it');
});

test('a kind that bends the picture about a point bends it about the middle of its own area, or about its own point', () => {
  const spot = { x: 0.5, y: 0, w: 0.5, h: 0.5 };
  // All of the picture: its middle, which is what a new one starts with.
  assert.deepEqual(O.midOf(now('zoom'), 1920, 1080), { cx: 959.5, cy: 539.5 });
  assert.deepEqual(O.midOf(now('zoom', { box: spot }), 1920, 1080), { cx: 1439.5, cy: 269.5 });
  assert.deepEqual(O.midOf(null, 1920, 1080), { cx: 959.5, cy: 539.5 });
  for (const kind of ['zoom', 'ripple']) {
    const o = opsOf(kind, { box: spot })[0];
    assert.equal(o.cx, 1439.5, kind);
    assert.equal(o.cy, 269.5, kind);
    assert.equal(T.vfxKind(kind).centred, true, kind);
  }
  // V5.1.4. A kind with a point of its own says it, and has no area to say it by.
  for (const kind of ['swirl', 'kaleido', 'bulge']) {
    assert.equal(T.vfxKind(kind).where, 'point', kind);
    assert.equal(T.vfxKind(kind).centred, undefined, kind);
    const mid = opsOf(kind)[0];
    assert.deepEqual([mid.cx, mid.cy], [959.5, 539.5], kind + ' starts on the picture\'s middle');
    const o = opsOf(kind, { cx: 0.75, cy: 0.25 })[0];
    assert.deepEqual([o.cx, o.cy], [1439.5, 269.5], kind);
  }
  // The lens filter takes its middle as a share of the picture. V5.1.3: a
  // lens bends the frame it took, so that is the picture's middle, always.
  assert.deepEqual(opsOf('lens', { box: spot, amount: 40 }), [{ op: 'lens', k1: -0.2, cx: 0.5, cy: 0.5 }]);
  assert.ok(O.filtersOfOp(opsOf('lens', { box: spot })[0])[0].startsWith('lenscorrection=cx=0.5:cy=0.5:k1='));
  assert.equal(T.vfxKind('lens').centred, undefined);
  assert.equal(T.vfxKind('wave').centred, undefined, 'a wave runs through the whole picture');
  // So where its area is is one of the figures its filter takes: an area
  // that moves makes a figure for every place, where another kind has one.
  const moving = (kind) => T.vfxOf({ kind, box: FULL, keys: [
    { t: 0, box: { x: 0, y: 0, w: 0.3, h: 0.3 }, rotation: 0, mix: 100, soft: 0 },
    { t: 1, box: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, rotation: 0, mix: 100, soft: 0 },
  ] });
  assert.equal(T.vfxRuns(vid({ duration: 1 }), moving('zoom'), 30).length, 30);
  assert.equal(T.vfxRuns(vid({ duration: 1 }), moving('sepia'), 30).length, 1);
});

test('Apply LUT does nothing until a file is chosen, and its path reaches the encoder whole', () => {
  assert.equal(T.vfxOf({ kind: 'lut' }).file, '');
  assert.equal(T.vfxAt(T.vfxOf({ kind: 'lut', box: FULL }), 0).off, true, 'no file: off');
  assert.deepEqual(O.opsOf('lut', { file: '' }, 1920, 1080), []);
  assert.equal(T.vfxOf({ kind: 'lut', file: 7 }).file, '', 'a path is text');
  assert.equal(now('lut').off, false);
  assert.deepEqual(opsOf('lut'), [{ op: 'lut3d', file: LUT_FILE }]);
  // Forward slashes, and three backslashes before whatever the graph or the
  // option would read as its own: measured with a path like this one.
  const three = String.fromCharCode(92).repeat(3);
  assert.equal(O.filterPath(LUT_FILE), 'C' + three + ':/luts/look' + three + ' one.cube');
  assert.equal(O.filterPath("C:/a/it's, [1]=x;.cube"),
    'C' + three + ':/a/it' + three + "'s" + three + ',' + three + ' ' + three + '[1' + three + ']' + three + '=x' + three + ';.cube');
  assert.equal(O.filtersOfOp(opsOf('lut')[0])[0], 'lut3d=file=' + O.filterPath(LUT_FILE) + ':interp=trilinear');
  // A file that is gone or is no table is left out of the export, which would stop at it.
  const exp = read('renderer', 'app', 'export.js');
  assert.ok(exp.includes(".filter((o) => o.op !== 'lut3d' || !!vfxGl.cubePath(o.file))"));
  assert.ok(exp.includes("if (s.type === 'file' && v[s.id]) await vfxGl.cubeReady(v[s.id]);"));
  // The window picks the file and the main process reads it.
  const main = read('main.js');
  assert.ok(main.includes("ipcMain.handle('dialog:openLut'") && main.includes("ipcMain.handle('lut:read'"));
  const pre = read('preload.js');
  assert.ok(pre.includes("openLut: () => ipcRenderer.invoke('dialog:openLut')") && pre.includes("readLut: (filePath) => ipcRenderer.invoke('lut:read', filePath)"));
});

test('a .cube file is read as a table of n by n by n colours, and nothing else is', () => {
  const lines = ['TITLE "two"', '# a comment', 'LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (let b = 0; b < 2; b += 1) for (let g = 0; g < 2; g += 1) for (let r = 0; r < 2; r += 1) lines.push([r, g * 0.5, b * 0.25].join(' '));
  const table = O.parseCube(lines.join(String.fromCharCode(13, 10)));
  assert.equal(table.ok, true);
  assert.equal(table.n, 2);
  assert.equal(table.data.length, 24);
  // Red runs fastest: the second colour is red at its end, the third green.
  assert.deepEqual([...table.data.slice(3, 6)], [1, 0, 0]);
  assert.deepEqual([...table.data.slice(6, 9)], [0, 0.5, 0]);
  assert.deepEqual([...table.data.slice(21, 24)], [1, 0.5, 0.25]);
  assert.deepEqual([table.lo, table.hi], [[0, 0, 0], [1, 1, 1]]);
  assert.equal(O.parseCube(lines.slice(0, -1).join('\n')).ok, false, 'a colour short');
  assert.equal(O.parseCube('LUT_1D_SIZE 2\n0 0 0\n1 1 1').ok, false, 'a table of one way only');
  assert.equal(O.parseCube('hello').ok, false);
  assert.equal(O.parseCube(null).ok, false);
  assert.equal(O.parseCube(lines.join('\n').replace('DOMAIN_MAX 1 1 1', 'DOMAIN_MAX 0 1 1')).ok, false, 'no room between its ends');
});

test('a track\'s VFX can be copied and pasted onto another track from the right click', () => {
  const menu = read('renderer', 'app', 'gen', 'kinds.js');
  const at = menu.indexOf("item(t('Copy VFX')");
  assert.ok(at > menu.indexOf("item(t('Add VFX')") && at < menu.indexOf("item(t('Add Keyframe')"), 'with the other VFX entries');
  assert.ok(menu.includes("if (timelineModel.vfxList(layer).length) item(t('Copy VFX'), true, () => copyVfx(layer.id));"));
  assert.ok(menu.includes("if (vfxCopied) item(t('Paste VFX'), !vfxOpenOn(layer.id), () => pasteVfx(layer.id));"));
  // In place of what the track has, as one step, each with an id of its own.
  // Not in the window's file, which writes to a track at Apply and nowhere else.
  assert.equal(read('renderer', 'app', 'vfx.js').includes('function pasteVfx('), false);
  const body = menu.slice(menu.indexOf('function pasteVfx('), menu.indexOf('function shapeName('));
  assert.ok(body.includes('setLayers(timelineModel.setLayer(layers, layerId, { vfx: list }));') && body.includes('commitHistory();'));
  assert.ok(body.includes('const { id: _id, ...rest } = v;'));
  assert.ok(body.includes("if (layer.kind === 'gen' || layer.type !== 'video') return;"), 'only onto a picture of a file');
  // What the model makes of a list without ids: new ones, nothing else changed.
  const from = vid({ vfx: [{ kind: 'look', look: 'noir', box: FULL, keys: [
    { id: 'a', t: 0, box: FULL, rotation: 0, mix: 0, soft: 0 }, { id: 'b', t: 1, box: FULL, rotation: 0, mix: 100, soft: 0 }] }] }).vfx;
  const pasted = T.vfxListOf(from.map(({ id, ...v }) => ({ ...v, keys: v.keys.map(({ id: key, ...k }) => k) })));
  assert.notEqual(pasted[0].id, from[0].id);
  assert.notEqual(pasted[0].keys[0].id, 'a');
  assert.equal(pasted[0].look, 'noir');
  assert.deepEqual(pasted[0].keys.map((k) => [k.t, k.mix]), [[0, 0], [1, 100]]);
});

// V5.1.2. The checkbox in front of each added VFX switches it off and on.
test('a VFX switched off by its checkbox is kept, and is off at every moment', () => {
  const v = T.vfxOf({ kind: 'sepia', disabled: true });
  assert.equal(v.disabled, true);
  assert.equal('disabled' in T.vfxOf({ kind: 'sepia', disabled: false }), false, 'kept only when off');
  assert.equal('disabled' in T.vfxOf({ kind: 'sepia', disabled: 'yes' }), false);
  assert.equal(T.vfxAt(v, 0).off, true);
  assert.equal(T.vfxAt(T.vfxOf({ kind: 'sepia' }), 0).off, false);
  assert.equal(T.vfxEverOn(v), false);
  const keyed = T.vfxOf({ kind: 'sepia', disabled: true, keys: [{ t: 0, mix: 0 }, { t: 1, mix: 100 }] });
  assert.equal(T.vfxMoves(keyed), false, 'nothing to draw again for one that is off');
  assert.equal(T.vfxMovesAlone(T.vfxOf({ kind: 'grain', disabled: true })), false);
  const layer = { duration: 2, vfx: [keyed] };
  assert.ok(T.vfxRuns(layer, keyed, 30).every((r) => r.at.off));
  // Through a list and back, as the window and Paste VFX take it.
  assert.equal(T.vfxListOf([{ kind: 'glow' }, { kind: 'sepia', disabled: true }])[1].disabled, true);
});

test('the window has a checkbox on each added VFX that changes only the draft', () => {
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes("on.className = 'vfx-chip__on';"));
  assert.ok(js.includes("vfxChain.addEventListener('change'"));
  assert.ok(js.includes("evt.target.closest('.vfx-chip__x, .vfx-chip__on')"), 'a press on it neither chooses nor drags');
  assert.ok(/function vfxDraftOf[\s\S]*?if \(v\.disabled\) d\.disabled = true;/.test(js));
  assert.ok(/function vfxListOfDraft[\s\S]*?if \(d\.disabled\) v\.disabled = true;/.test(js));
});
