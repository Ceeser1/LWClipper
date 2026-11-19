'use strict';

// V5.5. Time: Strobe, a flash that is on or off by the clip's time alone.
// V5.5.1. And Echo, which mixes the frame with the frames before it.

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

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

test('Strobe is for the whole picture, with a colour and a speed of its own and a flash length and Mix that keyframes hold', () => {
  const def = T.vfxKind('strobe');
  assert.equal(def.where, 'whole');
  assert.equal(def.alpha, undefined, 'it leaves the picture as solid as it was');
  assert.deepEqual(def.statics.map((s) => [s.id, s.type]), [['color', 'color'], ['speed', 'number']]);
  assert.deepEqual(def.keyed.map((s) => [s.id, s.min, s.max, s.def]), [['duration', 1, 100, 30], ['mix', 0, 100, 100]]);
  assert.equal(now('strobe').off, false);
  assert.equal(now('strobe', { mix: 0 }).off, true);
  // Its picture changes with no setting changing, so the preview keeps drawing it.
  assert.equal(T.vfxMovesAlone(T.vfxOf({ kind: 'strobe' })), true);
  assert.deepEqual(T.VFX_GROUPS[T.VFX_GROUPS.length - 1], { id: 'time', kinds: ['strobe', 'echo'] });
});

test('a flash is there for the first part of every round of the clip\'s time', () => {
  const [o] = opsOf('strobe', { color: '#ff8000', speed: 40, duration: 30 });
  assert.deepEqual(o, { op: 'flash', color: [255, 128, 0], rate: 4, part: 0.3 });
  // Four rounds a second at 30 frames: a round is seven and a half frames, the flash its first three tenths.
  const frames = [];
  for (let n = 0; n < 16; n += 1) frames.push(O.flashOn(o, n / 30) ? 1 : 0);
  assert.equal(frames.join(''), '1110000011000001');
  // The whole round is a flash that never ends.
  const [all] = opsOf('strobe', { duration: 100 });
  for (let n = 0; n < 60; n += 1) assert.equal(O.flashOn(all, n / 30), true);
  // A frame on the very start of a round is on, whichever way its time was rounded.
  const [o5] = opsOf('strobe', { speed: 50, duration: 50 });
  for (const t of [0.2, 0.2 - 1e-12, 0.2 + 1e-12, 3.4, 3.4 - 1e-9]) assert.equal(O.flashOn(o5, t), true, String(t));
  for (const t of [0.1, 0.1 + 1e-12, 0.1 - 1e-12]) assert.equal(O.flashOn(o5, t), false, String(t));
});

test('the encoder has the flash as a filled box that is on by the same rule of the frame\'s time', () => {
  const [o] = opsOf('strobe', { color: '#ff8000', speed: 40, duration: 30 });
  assert.equal(O.flashExpr(o), 'lt(mod(t*4+0.001,1),0.3)');
  const one = O.filtersOf([{ ops: [o] }], () => '', 't', false);
  assert.equal(one.text, "drawbox=x=0:y=0:w=iw:h=ih:c=0xff8000:t=fill:enable='lt(mod(t*4+0.001,1),0.3)'");
  assert.equal(one.forks, 0);
  // A figure that holds for some frames only: both rules in the one enable a filter has.
  const [late] = opsOf('strobe', { duration: 60 });
  const two = O.filtersOf([{ ops: [o], ranges: [[0, 29]] }, { ops: [late], ranges: [[30, 59]] }],
    (r) => ":enable='between(t," + r[0][0] + ',' + r[0][1] + ")'", 't', false).text;
  assert.equal(two, "drawbox=x=0:y=0:w=iw:h=ih:c=0xff8000:t=fill:enable='(between(t,0,29))*lt(mod(t*4+0.001,1),0.3)',"
    + "drawbox=x=0:y=0:w=iw:h=ih:c=0xffffff:t=fill:enable='(between(t,30,59))*lt(mod(t*4+0.001,1),0.6)'");
  assert.equal((two.match(/enable=/g) || []).length, 2);
  // On red, green and blue, where the box has the very colour asked for.
  const file = { kind: 'strobe', region: WHOLE, steps: [{ ops: [o] }], on: null, whole: false, full: true };
  const g = graphsOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [file] }], project: HD, output: 'o.mp4', sources: SRC })).join(';');
  assert.ok(g.includes('format=gbrp,drawbox=x=0:y=0:w=iw:h=ih:c=0xff8000:t=fill:enable='));
  assert.equal(g.includes('yuva420p'), false);
});

test('the preview asks the same rule, with the moment it is drawing', () => {
  const gl = read('renderer', 'app', 'vfxGl.js');
  assert.ok(gl.includes('function passesOf(ops, kx, ky, time = 0) {'));
  assert.ok(gl.includes("out.push({ prog: 'flash', u: { uColor: o.color, uOn: vfxOps.flashOn(o, time) ? 1 : 0 } });"));
  assert.ok(gl.includes('    flash: `'));
  assert.ok(read('renderer', 'app', 'compositor.js').includes('vfxGl.passesOf(ops, kx, ky, vfxDrawnAt)'));
});

test('Strobe has a row in every table and a name for everything, under the heading Time', () => {
  const rows = (file, table) => {
    const text = read(...file);
    const body = text.slice(text.indexOf('const ' + table + ' = {'));
    return [...body.slice(0, body.indexOf('\n};')).matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]);
  };
  for (const [file, table] of [[['renderer', 'app', 'compositor.js'], 'VFX_PREVIEW'], [['renderer', 'app', 'export.js'], 'VFX_EXPORT'],
    [['src', 'composer.js'], 'VFX_FILTERS'], [['renderer', 'app', 'vfx.js'], 'VFX_UI']]) {
    const all = rows(file, table);
    assert.equal(all[all.indexOf('lumakey') + 1], 'strobe', table);
  }
  assert.equal(T.VFX_KIND_IDS[T.VFX_KIND_IDS.indexOf('lumakey') + 1], 'strobe');
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes("strobe: { name: () => t('Strobe'),"));
  assert.ok(js.includes("  time: () => t('Time'),"));
  assert.ok(js.includes("  duration: () => t('Flash Length:'),"));
  assert.ok(js.includes("  duration: '%',"));
  for (const file of ['en.json', 'de.json']) {
    const words = JSON.parse(read('locales', file));
    for (const key of ['Time', 'Strobe', 'Flashes one colour over the picture, again and again', 'Flash Length:']) assert.ok(words[key], file + ': ' + key);
  }
});

// ---- V5.5.1. Echo ----

test('Echo has three figures of its own and only Mix for keyframes', () => {
  const def = T.vfxKind('echo');
  assert.equal(def.where, 'whole');
  assert.equal(def.first, true, 'it works on the picture as the file has it');
  assert.deepEqual(def.statics.map((s) => [s.id, s.type, s.min, s.max, s.def]),
    [['copies', 'number', 1, 5, 3], ['gap', 'number', 1, 10, 4], ['decay', 'number', 1, 100, 60]]);
  assert.deepEqual(def.keyed.map((s) => s.id), ['mix']);
  assert.equal(now('echo').off, false);
  assert.equal(now('echo', { mix: 0 }).off, true);
});

test('an Echo is worked before every other VFX of its track, and only one of them', () => {
  const kinds = (list) => T.vfxWorked({ type: 'video', vfx: T.vfxListOf(list) }).map((v) => v.kind + (v.gap ? v.gap : ''));
  assert.deepEqual(kinds([{ kind: 'sepia' }, { kind: 'echo', gap: 2 }, { kind: 'invert' }]), ['echo2', 'sepia', 'invert']);
  // The first that is switched on counts, the others are left out.
  assert.deepEqual(kinds([{ kind: 'sepia' }, { kind: 'echo', gap: 2, disabled: true }, { kind: 'echo', gap: 3 }, { kind: 'echo', gap: 5 }]), ['echo3', 'sepia']);
  assert.deepEqual(kinds([{ kind: 'echo', gap: 2, disabled: true }, { kind: 'sepia' }]), ['sepia']);
  // A track without one is as it is listed, the very list.
  const plain = { type: 'video', vfx: T.vfxListOf([{ kind: 'sepia' }, { kind: 'invert' }]) };
  assert.equal(T.vfxWorked(plain), plain.vfx);
  // Both sides go by it.
  assert.ok(read('renderer', 'app', 'export.js').includes('for (const v of timelineModel.vfxWorked(l)) {'));
  assert.ok(read('renderer', 'app', 'compositor.js').includes('let effects = (src ? timelineModel.vfxWorked(layer) : [])'));
});

test('an echo is the frame and the frames before it, each fainter by the Echo Strength', () => {
  const [o] = opsOf('echo', { copies: 3, gap: 4, decay: 50 });
  assert.deepEqual(o, { op: 'echo', gap: 4, weights: [1, 0.5, 0.25, 0.125] });
  const parts = O.echoFrames(o, 20);
  assert.deepEqual(parts.map((p) => p[0]), [20, 16, 12, 8]);
  assert.ok(Math.abs(parts.reduce((a, p) => a + p[1], 0) - 1) < 1e-12, 'the shares add up to the whole picture');
  assert.ok(Math.abs(parts[0][1] - 1 / 1.875) < 1e-12 && Math.abs(parts[3][1] - 0.125 / 1.875) < 1e-12);
  // Before the clip's first frame there is the first frame.
  assert.deepEqual(O.echoFrames(o, 5).map((p) => p[0]), [5, 1, 0, 0]);
  assert.deepEqual(O.echoFrames(o, 0).map((p) => p[0]), [0, 0, 0, 0]);
  // Mix is how much of the echo shows: at half, the frame itself has half and half of its share.
  const half = O.echoFrames(o, 20, 0.5);
  assert.ok(Math.abs(half[0][1] - (0.5 + 0.5 / 1.875)) < 1e-12);
  assert.ok(Math.abs(half.reduce((a, p) => a + p[1], 0) - 1) < 1e-12);
  assert.deepEqual(O.echoFrames(o, 20, 0).map((p) => p[1]), [1, 0, 0, 0]);
  // The figures are held to what the encoder is given room for.
  const [most] = opsOf('echo', { copies: 5, gap: 10, decay: 100 });
  assert.equal(most.weights.length, 6);
  assert.equal(most.gap, 10);
});

test('the encoder mixes the same frames, oldest first, and is never told when', () => {
  const [o] = opsOf('echo', { copies: 3, gap: 4, decay: 50 });
  const on = () => ":enable='between(t,0,1)'";
  const made = O.filtersOf([{ ops: [o], ranges: [[0, 30]] }], on, 't', false);
  assert.equal(made.text, "tmix=frames=13:weights='0.125 0 0 0 0.25 0 0 0 0.5 0 0 0 1'");
  assert.equal(made.text.includes('enable'), false, 'the filter keeps its frames only while they pass');
  assert.equal(made.forks, 0);
  const [near] = opsOf('echo', { copies: 2, gap: 1, decay: 100 });
  assert.equal(O.filtersOf([{ ops: [near] }], () => '', 't', false).text, "tmix=frames=3:weights='1 1 1'");
  // On the planes the picture comes in, straight on it when it is all of the picture at full Mix.
  const file = { kind: 'echo', region: WHOLE, steps: [{ ops: [o] }], on: null, whole: false, full: true };
  const g = graphsOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [file] }], project: HD, output: 'o.mp4', sources: SRC })).join(';');
  assert.ok(g.includes('format=yuv420p[cv0s];[cv0s]tmix=frames=13:'));
  assert.ok(read('src', 'composer.js').includes('echo: { ...OWN_OPS },'));
});

test('the preview keeps the frames from before and fetches the ones it lacks while standing still', () => {
  const js = read('renderer', 'app', 'compositor.js');
  assert.ok(js.includes('const echoStores = new Map();'));
  // An Echo is the picture the rest is made of, not a pass laid on it.
  assert.ok(js.includes('if (effects.length && VFX_PREVIEW[effects[0].kind].first) {'));
  assert.ok(js.includes('const mixed = echoPicture(layer, el, at, effects[0]);'));
  // Kept as it goes by while playing, fetched one seek after the other while not.
  assert.ok(js.includes('if (compositePlaying && !store.frames.has(n)) echoKeep(store, n, el, ECHO_PLAY_W, true);'));
  assert.ok(js.includes('const ok = await echoSeek(store.el, timelineModel.sourceTimeFor(now.layer, now.layer.start + (n + ECHO_INTO) / fps));'));
  // A frame that is not there gives its share to the frame shown.
  assert.ok(js.includes('own += share;'));
  // Whoever waits for a seek waits for the frames too.
  assert.ok(js.includes('if (before.length) waits.push(echoFetch(l, before));'));
  // The frames are another clip's once the clip is cut, sped up or the rate changes.
  assert.ok(js.includes('if (store.sig !== sig) {'));
  assert.ok(js.includes('releaseEcho(id);'));
});

test('Echo has a row in every table and a name for everything', () => {
  const rows = (file, table) => {
    const text = read(...file);
    const body = text.slice(text.indexOf('const ' + table + ' = {'));
    return [...body.slice(0, body.indexOf('\n};')).matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]);
  };
  for (const [file, table] of [[['renderer', 'app', 'compositor.js'], 'VFX_PREVIEW'], [['renderer', 'app', 'export.js'], 'VFX_EXPORT'],
    [['src', 'composer.js'], 'VFX_FILTERS'], [['renderer', 'app', 'vfx.js'], 'VFX_UI']]) {
    const all = rows(file, table);
    assert.equal(all[all.indexOf('strobe') + 1], 'echo', table);
  }
  assert.equal(T.VFX_KIND_IDS[T.VFX_KIND_IDS.indexOf('strobe') + 1], 'echo');
  const js = read('renderer', 'app', 'vfx.js');
  for (const id of ['copies', 'gap', 'decay']) assert.ok(js.includes('  ' + id + ': () => t('), id);
  for (const file of ['en.json', 'de.json']) {
    const words = JSON.parse(read('locales', file));
    for (const key of ['Echo', 'Echoes:', 'Frames Apart:', 'Echo Strength:',
      "What moves leaves fading copies of itself behind. Works on the track's picture before its other VFX, one Echo to a track"]) assert.ok(words[key], file + ': ' + key);
  }
});
