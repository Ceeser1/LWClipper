'use strict';

// V5.0. VFX: the list on a track that took the place of V4.7's Obscure and
// Pixelate and V4.8's moving areas. The model and its table of kinds, a VFX's
// own keyframes with every keyed setting in them, where one acts and the part
// of the picture the export filters, the export's graph with a figure that
// changes by keyframes, the preview's order, the project file, and the
// window's markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const D = require('../src/genDraw');
const P = require('../src/project');
const { buildComposeArgs, spillGraph, GRAPH_ARG_MAX } = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = read('renderer', 'index.html');

const HD = { width: 1920, height: 1080, fps: 30 };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const BOX = { x: 0.1, y: 0.2, w: 0.2, h: 0.2 };
const FAR = { x: 0.6, y: 0.4, w: 0.3, h: 0.4 };
const MID = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
const STILL = { kind: 'obscure', shape: 'square', box: MID };
// A VFX whose area goes from BOX to FAR over the clip's second to its sixth
// second, turning and growing stronger on the way.
const MOVER = {
  kind: 'pixelate',
  shape: 'circle',
  box: BOX,
  keys: [
    { id: 'a', t: 2, box: BOX, rotation: 0, strength: 10, soft: 0 },
    { id: 'b', t: 6, box: FAR, rotation: 40, strength: 50, soft: 0.02 },
  ],
};

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

function graphOf(args) {
  return args[args.indexOf('-filter_complex') + 1];
}

/** Every graph of an argv, in the order ffmpeg is handed them. */
function graphsOf(args) {
  return args.filter((a, i) => args[i - 1] === '-filter_complex');
}

// ---- the table of kinds ----

test('every kind says what its settings are, which are its own and which a keyframe holds', () => {
  // V5.1 put more kinds after the first two (test/vfx51.test.js).
  assert.deepEqual(T.VFX_KIND_IDS.slice(0, 2), ['obscure', 'pixelate']);
  for (const kind of ['obscure', 'pixelate']) {
    const def = T.vfxKind(kind);
    assert.equal(def.area, true);
    // The user: the settings that cannot blend between keyframes are the VFX's own.
    assert.deepEqual(def.statics.map((s) => s.id), ['shape', 'invert']);
    assert.deepEqual(def.keyed.map((s) => s.id), ['strength', 'soft']);
    assert.ok(def.keyed.every((s) => s.type === 'number'), 'only numbers blend');
    assert.deepEqual(T.vfxKeyedIds(kind), ['box', 'rotation', 'strength', 'soft']);
    assert.equal(def.keyed[0].min, 0, 'a strength of 0, which is off');
    assert.equal(def.off({ strength: 0 }), true);
    assert.equal(def.off({ strength: 1 }), false);
  }
  assert.equal(T.vfxKind('bloom'), null);
  assert.equal(T.vfxKind('constructor'), null, 'only its own rows');
  assert.deepEqual(T.vfxKeyedIds('bloom'), []);
});

// ---- the model ----

test('a layer written before VFX has none, and only a picture of a file can have any', () => {
  assert.deepEqual(vid({}).vfx, []);
  assert.deepEqual(T.createLayer({ kind: 'gen', gen: { form: 'shape' }, vfx: [STILL] }).vfx, []);
  assert.deepEqual(T.createLayer({ type: 'audio', src: 'a.mp3', vfx: [STILL] }).vfx, []);
  assert.equal(T.createLayer({ kind: 'image', src: 'a.png', vfx: [STILL] }).vfx.length, 1);
  assert.equal(vid({ vfx: [STILL] }).vfx.length, 1);
  assert.deepEqual(T.vfxList(null), []);
  assert.deepEqual(T.vfxList(T.createLayer({ type: 'audio', src: 'a.mp3' })), []);
});

test('a project from before V5.0 opens without its Obscure and Pixelate: no conversion', () => {
  const old = { areas: [{ kind: 'square', box: MID }], strength: 30, soft: 0, invert: false };
  const l = vid({ obscure: old, pixelate: old });
  assert.equal('obscure' in l, false);
  assert.equal('pixelate' in l, false);
  assert.deepEqual(l.vfx, []);
});

test('a VFX is its kind, its own settings and its keyed ones, each held to its range', () => {
  assert.equal(T.vfxOf(null), null);
  assert.equal(T.vfxOf({ kind: 'bloom' }), null, 'a kind this build does not have');
  const v = T.vfxOf({ id: 'x1', kind: 'obscure', shape: 'plaid', invert: 'yes', strength: 400, soft: -1,
    box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, rotation: 270 });
  assert.deepEqual(v, {
    id: 'x1', kind: 'obscure', shape: 'square', invert: false,
    box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, rotation: -90, strength: 100, soft: 0,
  });
  assert.equal('keys' in v, false, 'none at all without keyframes');
  assert.equal(T.vfxOf({ kind: 'obscure' }).strength, 30);
  assert.equal(T.vfxOf({ kind: 'pixelate' }).strength, 25);
  assert.equal(T.vfxOf({ kind: 'pixelate', strength: 0 }).strength, 0, '0 is a strength: off');
  assert.equal(T.vfxOf({ kind: 'pixelate', strength: 12.6 }).strength, 13, 'whole numbers');
  assert.deepEqual(T.vfxOf({ kind: 'obscure' }).box, { x: 0, y: 0, w: 1, h: 1 });
  assert.ok(/^x/.test(T.vfxOf({ kind: 'obscure' }).id));
});

test('a track keeps as many as it is given, in their order, each with an id of its own', () => {
  const list = T.vfxListOf([STILL, 'nonsense', { kind: 'bloom' }, { ...STILL, id: 'same' }, { kind: 'pixelate', id: 'same' }]);
  assert.deepEqual(list.map((v) => v.kind), ['obscure', 'obscure', 'pixelate']);
  assert.equal(new Set(list.map((v) => v.id)).size, 3);
  assert.deepEqual(T.vfxListOf(null), []);
  // The user: no cap, fifty of one kind must still be there.
  const many = T.vfxListOf(Array.from({ length: 50 }, () => STILL));
  assert.equal(many.length, 50);
});

test('several of a kind are numbered in the order they are processed', () => {
  const list = T.vfxListOf([{ kind: 'pixelate' }, { kind: 'obscure' }, { kind: 'pixelate' }, { kind: 'pixelate' }]);
  assert.deepEqual(list.map((_, i) => T.vfxNumber(list, i)), [1, 1, 2, 3]);
  assert.equal(T.vfxNumber(list, 9), 0);
});

test('the note about keyframes is due from the eighth VFX with three of a kind', () => {
  const of = (kinds) => T.vfxListOf(kinds.map((kind) => ({ kind })));
  assert.equal(T.vfxNoteDue(of(Array(7).fill('obscure'))), false, 'seven is not yet eight');
  assert.equal(T.vfxNoteDue(of(Array(8).fill('obscure'))), true);
  assert.equal(T.vfxNoteDue(of(['obscure', 'pixelate', 'obscure', 'pixelate', 'obscure', 'pixelate', 'obscure', 'pixelate'])), true);
  assert.equal(T.vfxNoteDue(of(Array(30).fill('pixelate'))), true, 'and on every one after it');
  assert.equal(T.vfxNoteDue(null), false);
  assert.equal(T.VFX_NOTE_FROM, 8);
  assert.equal(T.VFX_NOTE_SAME, 3);
});

test('the strength is a share of the picture\'s height, and a block is always even', () => {
  assert.ok(Math.abs(T.obscureSigma(30, 1080) - 16.2) < 1e-9);
  assert.ok(Math.abs(T.obscureSigma(30, 2160) - 32.4) < 1e-9, 'twice the picture, twice the blur');
  assert.equal(T.obscureSigma(1, 100), 0.5, 'never less than half a pixel');
  assert.equal(T.pixelateBlock(25, 1080), 28);
  assert.equal(T.pixelateBlock(1, 1080), 2, 'at least two pixels');
  for (let s = 1; s <= 100; s += 1) {
    for (const h of [360, 720, 1080, 1440, 2160]) assert.equal(T.pixelateBlock(s, h) % 2, 0, s + ' at ' + h);
  }
});

// ---- keyframes of its own ----

test('a VFX\'s keyframes are held in time order, one to a moment and one to an id, every keyed value in each', () => {
  const v = T.vfxOf({ kind: 'obscure', keys: [
    { id: 'b', t: 6, box: FAR, rotation: 400, strength: 80, soft: 0.1 },
    { id: 'a', t: 2, box: BOX },
    { id: 'a', t: 4, box: BOX },
    { t: 6, box: BOX, strength: 5 },
    { t: 'x' },
    'nonsense',
  ] });
  assert.deepEqual(v.keys.map((k) => k.t), [2, 4, 6]);
  assert.equal(new Set(v.keys.map((k) => k.id)).size, 3);
  assert.equal(v.keys[2].strength, 5, 'the later one at a moment is the one kept');
  for (const k of v.keys) assert.deepEqual(Object.keys(k), ['id', 't', 'box', 'rotation', 'strength', 'soft']);
  assert.equal(v.keys[0].strength, 30, 'what a keyframe does not say is the kind\'s start');
  assert.equal('keys' in T.vfxOf({ kind: 'obscure', keys: [] }), false);
  assert.equal('keys' in T.vfxOf({ kind: 'obscure', keys: 'nonsense' }), false);
});

test('between two keyframes every keyed value goes smoothly from the one to the other', () => {
  const v = T.vfxOf(MOVER);
  const at = (t) => T.vfxValuesAt(v, t);
  assert.deepEqual(at(0).box, BOX, 'before the first it is the first\'s');
  assert.deepEqual(at(9).box, FAR, 'after the last the last\'s');
  const mid = at(4);
  assert.ok(near(mid.box.x, 0.35) && near(mid.box.y, 0.3) && near(mid.box.w, 0.25) && near(mid.box.h, 0.3));
  assert.ok(near(mid.rotation, 20));
  assert.ok(near(mid.strength, 30), 'the strength blends as the box does');
  assert.ok(near(mid.soft, 0.01));
  // The turn goes the short way round.
  const turn = T.vfxOf({ kind: 'obscure', keys: [{ t: 0, rotation: 170 }, { t: 2, rotation: -170 }] });
  assert.ok(near(T.vfxValuesAt(turn, 1).rotation, 180) || near(T.vfxValuesAt(turn, 1).rotation, -180));
  // Without keyframes it is its own, a copy.
  const still = T.vfxOf(STILL);
  assert.deepEqual(T.vfxValuesAt(still, 3), { box: MID, rotation: 0, strength: 30, soft: 0 });
  assert.notEqual(T.vfxValuesAt(still, 3).box, still.box);
});

test('a VFX at a moment is what every drawing takes: no keys, whole strength, its area, and whether it is off', () => {
  const v = T.vfxOf({ ...MOVER, id: 'm', invert: true });
  const now = T.vfxAt(v, 4.1);
  assert.equal(now.id, 'm');
  assert.equal(now.kind, 'pixelate');
  assert.equal(now.shape, 'circle');
  assert.equal(now.invert, true);
  assert.equal(now.strength, 31, 'a whole number, the same for the preview and the export');
  assert.equal(now.off, false);
  assert.equal('keys' in now, false);
  assert.equal(now.areas.length, 1, 'one area a VFX');
  assert.equal(now.areas[0].kind, 'circle');
  assert.ok(near(now.areas[0].rotation, 21));
});

test('a strength of 0 is off, and keyframes at 0 limit a VFX to a stretch of the clip', () => {
  // The user's example: 0, 50, 0, 100, 0, 0 (off between those two), 50, 0 until the end.
  const strengths = [0, 50, 0, 100, 0, 0, 50, 0];
  const v = T.vfxOf({ kind: 'obscure', keys: strengths.map((strength, i) => ({ t: i, strength, box: MID })) });
  const off = (t) => T.vfxAt(v, t).off;
  assert.equal(off(0), true);
  assert.equal(T.vfxAt(v, 0.5).strength, 25, 'ramping up');
  assert.equal(T.vfxAt(v, 1).strength, 50);
  assert.equal(off(2), true, 'down to nothing');
  assert.equal(T.vfxAt(v, 3).strength, 100);
  assert.equal(off(4.5), true, 'off between two keyframes at 0');
  assert.equal(T.vfxAt(v, 6).strength, 50);
  assert.equal(off(7), true);
  assert.equal(off(9.9), true, 'the last keyframe holds until the end of the clip');
  assert.equal(T.vfxEverOn(v), true);
  // Off throughout: never on.
  assert.equal(T.vfxEverOn(T.vfxOf({ kind: 'obscure', strength: 0 })), false);
  assert.equal(T.vfxEverOn(T.vfxOf({ kind: 'obscure', keys: [{ t: 0, strength: 0 }, { t: 5, strength: 0 }] })), false);
  assert.equal(T.vfxEverOn(T.vfxOf(STILL)), true);
});

test('what a VFX does is handed on frame by frame, in runs that are the same throughout', () => {
  const l = vid({ duration: 4, vfx: [
    { kind: 'obscure', keys: [{ t: 0, strength: 0, box: MID }, { t: 1, strength: 3, box: MID }, { t: 2, strength: 0, box: MID }] },
    STILL,
    { kind: 'obscure', keys: [{ t: 0, strength: 20, box: BOX }, { t: 2, strength: 20, box: FAR }] },
  ] });
  const runs = T.vfxRuns(l, l.vfx[0], 30);
  // Every frame of the clip, once, in order.
  assert.equal(runs[0].from, 0);
  assert.equal(runs[runs.length - 1].to, 119);
  for (let i = 1; i < runs.length; i += 1) assert.equal(runs[i].from, runs[i - 1].to + 1);
  assert.deepEqual(runs.map((r) => (r.at.off ? 0 : r.at.strength)), [0, 1, 2, 3, 2, 1, 0]);
  // Frame i is the moment i / fps: the strength reaches 1 at half a step, 1 / 6 of a second.
  assert.equal(runs[1].from, 5);
  assert.equal(runs[6].from, 56);
  assert.equal(runs[6].at.off, true, 'and off to the end of the clip');
  // One that never changes what it does is one run, however its area moves.
  assert.equal(T.vfxRuns(l, l.vfx[1], 30).length, 1);
  assert.deepEqual(T.vfxRuns(l, l.vfx[2], 30).map((r) => [r.from, r.to]), [[0, 119]]);
});

test('where a VFX acts moves from its first keyframe to its last, and not at all when only its strength changes', () => {
  const l = vid({ vfx: [MOVER, STILL,
    { kind: 'obscure', keys: [{ t: 1, strength: 10, box: MID }, { t: 3, strength: 90, box: MID }] },
    { kind: 'obscure', keys: [{ t: 1, soft: 0, box: MID }, { t: 30, soft: 0.1, box: MID }] }] });
  assert.deepEqual(T.vfxMotion(l, l.vfx[0]), { from: 2, to: 6 });
  assert.equal(T.vfxMotion(l, l.vfx[1]), null);
  assert.equal(T.vfxMotion(l, l.vfx[2]), null, 'a change of strength draws no frame');
  assert.deepEqual(T.vfxMotion(l, l.vfx[3]), { from: 1, to: 10 }, 'a soft edge is where it acts; held to the clip');
  assert.equal(T.vfxMoves(l.vfx[0]), true);
  assert.equal(T.vfxMoves(l.vfx[1]), false);
  assert.equal(T.vfxMoves(l.vfx[2]), true, 'but it does change');
});

test('a keyframe is put, moved and found on a VFX in whatever unit its numbers are', () => {
  // The window's units: pixels and whole degrees.
  let v = { id: 'p', kind: 'obscure', shape: 'square', invert: false, box: { x: 100, y: 100, w: 200, h: 200 }, rotation: 0, strength: 30, soft: 12 };
  v = T.putVfxKey(v, { id: 'a', t: 0, box: v.box, rotation: 0, strength: 30, soft: 12 });
  v = T.putVfxKey(v, { id: 'b', t: 4, box: { x: 500, y: 100, w: 200, h: 200 }, rotation: 90, strength: 70, soft: 40 });
  assert.deepEqual(v.keys.map((k) => k.id), ['a', 'b']);
  assert.equal(T.vfxValuesAt(v, 2).box.x, 300);
  assert.equal(T.vfxValuesAt(v, 2).strength, 50);
  assert.equal(T.vfxValuesAt(v, 2).soft, 26);
  // Changed by its id, and one at the same moment gives way.
  v = T.putVfxKey(v, { id: 'b', t: 4, box: v.keys[1].box, rotation: 90, strength: 10, soft: 40 });
  assert.equal(v.keys.length, 2);
  assert.equal(v.keys[1].strength, 10);
  v = T.putVfxKey(v, { id: 'c', t: 4, box: v.keys[1].box, rotation: 0, strength: 5, soft: 0 });
  assert.deepEqual(v.keys.map((k) => k.id), ['a', 'c']);
  assert.equal(T.vfxKeyNear(v, 4.01, 0.02).id, 'c');
  assert.equal(T.vfxKeyNear(v, 4.5, 0.02), null);
  // Dragged: held to the clip, never onto another's moment.
  const moved = T.moveVfxKey(v, 'c', 99, 10);
  assert.equal(moved.keys.find((k) => k.id === 'c').t, 10);
  assert.equal(T.moveVfxKey(v, 'c', 0, 10).keys.find((k) => k.id === 'c').t, 0.001);
  assert.equal(T.moveVfxKey(v, 'nobody', 1, 10), v);
});

test('deleting a keyframe goes by a clip\'s rules: the last pair leaves the VFX as the first had it', () => {
  let v = T.vfxOf({ kind: 'pixelate', box: MID, keys: [
    { id: 'a', t: 0, box: BOX, strength: 10 },
    { id: 'b', t: 2, box: FAR, strength: 20 },
    { id: 'c', t: 4, box: MID, strength: 30 },
  ] });
  // The first, with two after it: it stays and takes the second's settings.
  const first = T.removeVfxKey(v, 'a');
  assert.deepEqual(first.keys.map((k) => k.id), ['a', 'b', 'c']);
  assert.deepEqual(first.keys[0].box, FAR);
  assert.equal(first.keys[0].strength, 20);
  assert.equal(first.keys[0].t, 0);
  // One from the middle simply goes.
  v = T.removeVfxKey(v, 'b');
  assert.deepEqual(v.keys.map((k) => k.id), ['a', 'c']);
  // Down to one: that goes too, and the VFX is what the first had, the whole clip long.
  v = T.removeVfxKey(v, 'c');
  assert.equal('keys' in v, false);
  assert.deepEqual(v.box, BOX);
  assert.equal(v.strength, 10);
  assert.equal(T.removeVfxKey(v, 'nobody'), v);
});

test('a trim of the start, a split and a stretch move a VFX\'s keyframes as they move the clip\'s own', () => {
  const l = vid({ vfx: [MOVER, STILL] });
  // The start trimmed two seconds in: the keyframes stay where they are on the timeline.
  const trimmed = T.trimLayer([l], 'v', 'start', 2)[0];
  assert.deepEqual(trimmed.vfx[0].keys.map((k) => k.t), [0, 4]);
  assert.equal('keys' in trimmed.vfx[1], false);
  // A move and a trim of the end shift nothing.
  assert.deepEqual(T.trimLayer([l], 'v', 'end', 8)[0].vfx, l.vfx);
  // Both halves of a split keep every keyframe, the right one on its own clock.
  const halves = T.splitLayer([l], 'v', 4).filter((x) => x.src === 'a.mp4');
  assert.equal(halves.length, 2);
  assert.deepEqual(halves[0].vfx[0].keys.map((k) => k.t), [2, 6]);
  assert.deepEqual(halves[1].vfx[0].keys.map((k) => k.t), [-2, 2]);
  assert.deepEqual(T.shiftVfxKeys(vid({ vfx: [STILL] }), 3), {}, 'nothing to spread without keyframes');
  // Played at half the speed, they are twice as far apart.
  const slow = T.stretchGroup([l], 'v', 'end', 20)[0];
  assert.deepEqual(slow.vfx[0].keys.map((k) => k.t), [4, 12]);
});

test('the list survives the project file, ids, order, keyframes and all', () => {
  const l = vid({ vfx: [MOVER, { ...STILL, invert: true, soft: 0.03, strength: 40 }, { kind: 'pixelate', box: FAR, rotation: 20 }] });
  const out = P.parse(P.stringify(P.serialise({ layers: [l], project: HD, trim: { start: 0, end: 10 } })));
  assert.equal(out.ok, true);
  const back = T.createLayer(out.doc.layers[0]);
  assert.deepEqual(back.vfx, l.vfx);
  assert.deepEqual(back.vfx[0].keys.map((k) => k.id), ['a', 'b']);
  assert.equal(JSON.stringify(l.vfx[1]).includes('keys'), false, 'nothing is written for keyframes it does not have');
});

test('the note that was shown is kept beside the document, not in it', () => {
  assert.deepEqual(P.notesOf(null), {});
  assert.deepEqual(P.notesOf({ vfxKeyframes: true, other: 'yes', 'bad key': true, 7: true }), { vfxKeyframes: true });
  const state = { layers: [vid({})], project: HD, trim: { start: 0, end: 10 } };
  const file = P.serialise({ ...state, notes: { vfxKeyframes: true } });
  assert.deepEqual(file.notes, { vfxKeyframes: true });
  const out = P.parse(P.stringify(file));
  assert.deepEqual(out.notes, { vfxKeyframes: true });
  assert.equal('notes' in out.doc, false);
  assert.equal(P.sameDocument(state, { ...state, notes: { vfxKeyframes: true } }), true, 'reading a note is not unsaved work');
  assert.deepEqual(P.parse(P.stringify(P.serialise(state))).notes, {}, 'a file without any reads as none shown');
});

// ---- where a VFX acts ----

// A context that writes down what is filled, and in which way.
function maskCtx() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); this.globalCompositeOperation = 'source-over'; },
    clearRect(...a) { calls.push(['clearRect', ...a]); },
    fillRect(...a) { calls.push(['fillRect', this.globalCompositeOperation, this.fillStyle, ...a]); },
    beginPath() { calls.push(['beginPath']); },
    closePath() {},
    moveTo() {},
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    ellipse(...a) { calls.push(['ellipse', ...a]); },
    arcTo() {},
    bezierCurveTo() {},
    fill(rule) { calls.push(['fill', this.fillStyle, rule]); },
  };
}

const nowOf = (v, t = 0) => T.vfxAt(T.vfxOf(v), t);

test('where it acts is its area as a white shape, in the picture\'s pixels', () => {
  const ctx = maskCtx();
  D.drawCoverMask(ctx, nowOf(STILL), 1000, 500, null);
  assert.deepEqual(ctx.calls[0], ['clearRect', 0, 0, 1000, 500]);
  const fills = ctx.calls.filter((c) => c[0] === 'fill');
  assert.equal(fills.length, 1, 'one area');
  assert.equal(fills[0][1], '#ffffffff');
  const lines = ctx.calls.filter((c) => c[0] === 'lineTo').map((c) => [c[1], c[2]]);
  assert.deepEqual(lines, [[750, 125], [750, 375], [250, 375]]);
  assert.equal(ctx.calls.some((c) => c[0] === 'fillRect'), false, 'not turned round');
  // A circle, where its keyframes have it at the moment.
  const round = maskCtx();
  D.drawCoverMask(round, nowOf({ kind: 'obscure', shape: 'circle', box: { x: 0.5, y: 0.5, w: 0.2, h: 0.4 } }), 1000, 500, null);
  assert.deepEqual(round.calls.find((c) => c[0] === 'ellipse').slice(1, 5), [600, 350, 100, 100]);
});

test('inverted, it is turned round over the whole picture', () => {
  const ctx = maskCtx();
  D.drawCoverMask(ctx, nowOf({ ...STILL, kind: 'pixelate', invert: true }), 1000, 500, null);
  const last = ctx.calls.filter((c) => c[0] === 'fillRect');
  assert.deepEqual(last, [['fillRect', 'source-out', '#ffffff', 0, 0, 1000, 500]]);
});

test('the export filters only the part of the picture the area is in', () => {
  const one = nowOf({ kind: 'obscure', box: { x: 0.25, y: 0.25, w: 0.25, h: 0.5 } });
  // 480 to 960 across and 270 to 810 down, two pixels of room, on even pixels.
  assert.deepEqual(D.coverRegion(one, 1920, 1080), { x: 478, y: 268, width: 484, height: 544 });
  // A blur asks for the pixels beside it as well.
  assert.deepEqual(D.coverRegion(one, 1920, 1080, { margin: 50 }), { x: 428, y: 218, width: 584, height: 644 });
  // Pixelate's blocks are counted from the picture's corner.
  const r = D.coverRegion(one, 1920, 1080, { grid: 28 });
  assert.equal(r.x % 28, 0);
  assert.equal(r.y % 28, 0);
  assert.equal((r.x + r.width) % 28, 0);
  assert.ok(r.x <= 478 && r.x + r.width >= 962);
  // A soft edge reaches further, and so does a turned area.
  const soft = D.coverRegion({ ...one, soft: 0.05 }, 1920, 1080);
  assert.ok(soft.x < 478 - 50 && soft.width > 484 + 100);
  const turned = D.coverRegion(nowOf({ kind: 'obscure', box: { x: 0.25, y: 0.25, w: 0.25, h: 0.5 }, rotation: 45 }), 1920, 1080);
  assert.ok(turned.width > 484 && turned.height > 544 - 200);
});

test('the part is held to the picture, to its last even pixel, and is all of it when inverted', () => {
  const edge = nowOf({ kind: 'obscure', box: { x: 0.9, y: 0.9, w: 0.3, h: 0.3 } });
  assert.deepEqual(D.coverRegion(edge, 1920, 1080), { x: 1726, y: 970, width: 194, height: 110 });
  assert.deepEqual(D.coverRegion(edge, 1919, 1079), { x: 1724, y: 968, width: 194, height: 110 }, 'an odd picture');
  const gridded = D.coverRegion(edge, 1920, 1080, { grid: 28 });
  assert.equal(gridded.x + gridded.width, 1920, 'the last blocks are cut short by the edge, as the encoder cuts them');
  assert.deepEqual(D.coverRegion({ ...edge, invert: true }, 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 });
  const off = nowOf({ kind: 'obscure', box: { x: 2, y: 2, w: 0.1, h: 0.1 } });
  assert.equal(D.coverRegion(off, 1920, 1080), null, 'an area off the picture touches none of it');
});

test('the part filtered for a moving VFX is every part it touches on the way', () => {
  const a = { x: 100, y: 200, width: 300, height: 200 };
  const b = { x: 600, y: 100, width: 200, height: 500 };
  assert.deepEqual(D.coverRegionUnion(a, b), { x: 100, y: 100, width: 700, height: 500 });
  assert.deepEqual(D.coverRegionUnion(b, a), { x: 100, y: 100, width: 700, height: 500 });
  assert.equal(D.coverRegionUnion(null, a), a);
  assert.equal(D.coverRegionUnion(null, null), null);
  // Over a real move, at every frame: it holds each moment's part.
  const v = T.vfxOf(MOVER);
  let all = null;
  const each = [];
  for (let i = 60; i <= 180; i += 1) {
    const r = D.coverRegion(T.vfxAt(v, i / 30), 1920, 1080, { grid: 2 });
    each.push(r);
    all = D.coverRegionUnion(all, r);
  }
  for (const r of each) {
    assert.ok(r.x >= all.x && r.y >= all.y && r.x + r.width <= all.x + all.width && r.y + r.height <= all.y + all.height);
  }
  assert.ok(all.width > each[0].width && all.width > each[each.length - 1].width);
});

// ---- the export ----

const FILES = [
  { kind: 'obscure', src: 'C:/c/gen/o.png', region: { x: 100, y: 200, width: 300, height: 200 }, steps: [{ sigma: 16.2 }], on: null, whole: false },
  { kind: 'pixelate', src: 'C:/c/gen/p.png', region: { x: 784, y: 420, width: 252, height: 196 }, steps: [{ block: 28 }], on: null, whole: false },
];
const SRC = { 'a.mp4': { width: 1920, height: 1080 } };
const SEQ = {
  kind: 'obscure',
  region: { x: 100, y: 200, width: 700, height: 500 },
  steps: [{ sigma: 16.2 }],
  on: null,
  whole: false,
  frames: { pattern: 'C:/c/gen/seq-1/%05d.png', lead: 2, tail: 3.966667 },
};

test('a layer with no VFX is written exactly as it was', () => {
  const g = graphOf(buildComposeArgs({ layers: [vid({})], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(g.includes('[0:v]fps=30'));
  assert.equal(/gblur|pixelize|alphamerge|\[cv/.test(g), false);
});

test('each VFX is cut out of the source, filtered, and laid back where it came from, in the track\'s order', () => {
  const l = { ...vid({}), vfxFiles: FILES };
  const args = buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC });
  // The pictures of where they act are inputs of their own, after the layer's.
  const inputs = args.filter((a, i) => args[i - 1] === '-i');
  assert.deepEqual(inputs, ['a.mp4', 'C:/c/gen/o.png', 'C:/c/gen/p.png']);
  const parts = graphOf(args).split(';');
  assert.ok(parts.includes('[0:v]fps=30,format=yuv420p[cv0s]'), 'at the project\'s rate, before anything else');
  // Obscure: blurred at 4:4:4 with six steps, the measured way to a Gaussian.
  assert.ok(parts.includes('[cv0x0b]crop=300:200:100:200,format=yuv444p,gblur=sigma=16.2:steps=6[cv0x0c]'));
  // V4.12. The one PNG is made grey and sized once, then held for the clip.
  assert.ok(parts.includes('[1:v]format=gray,scale=300:200,loop=loop=-1:size=1:start=0,trim=duration=10.0,fps=30[cv0x0m]'));
  assert.ok(parts.includes('[cv0x0c][cv0x0m]alphamerge[cv0x0h]'));
  assert.ok(parts.includes('[cv0x0a][cv0x0h]overlay=x=100:y=200:format=yuv420[cv0x0o]'));
  // Pixelate, on what Obscure left.
  assert.ok(parts.includes('[cv0x0o]split[cv0x1a][cv0x1b]'));
  assert.ok(parts.includes('[cv0x1b]crop=252:196:784:420,pixelize=w=28:h=28[cv0x1c]'));
  assert.ok(parts.includes('[cv0x1a][cv0x1h]overlay=x=784:y=420:format=yuv420[cv0x1o]'));
  // And the layer's own chain starts from that, not from the input.
  assert.ok(parts.some((p) => p.startsWith('[cv0x1o]fps=30')));
  assert.equal(parts.some((p) => p.startsWith('[0:v]') && !p.endsWith('[cv0s]')), false);
  // The other way round, the other way round: the order is the track's.
  const back = graphOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [FILES[1], FILES[0]] }], project: HD, output: 'o.mp4', sources: SRC })).split(';');
  assert.ok(back.includes('[cv0x0b]crop=252:196:784:420,pixelize=w=28:h=28[cv0x0c]'));
  assert.ok(back.includes('[cv0x1b]crop=300:200:100:200,format=yuv444p,gblur=sigma=16.2:steps=6[cv0x1c]'));
});

test('several of one kind are each their own step, as many as there are', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...FILES[1], src: 'C:/c/gen/p' + i + '.png' }));
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: many }], project: HD, output: 'o.mp4', sources: SRC });
  assert.equal(args.filter((a, i) => args[i - 1] === '-i').length, 13);
  const g = graphsOf(args).join(';');
  assert.equal((g.match(/pixelize=/g) || []).length, 12);
  assert.ok(g.includes('[cv0x11o]fps=30'));
});

test('up to two VFX stay in the layers\' own graph, as V4.7 wrote it', () => {
  for (const files of [[FILES[0]], FILES]) {
    const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: files }], project: HD, output: 'o.mp4', sources: SRC });
    assert.equal(graphsOf(args).length, 1);
  }
});

test('more than two go into graphs of their own, four to a graph, each handing its picture to the next', () => {
  // ffmpeg's cost for these steps in one graph doubles with each: 18 took 33 s and 50 never finished.
  const many = Array.from({ length: 10 }, (_, i) => ({ ...FILES[1], src: 'C:/c/gen/p' + i + '.png' }));
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: many }], project: HD, output: 'o.mp4', sources: SRC });
  const graphs = graphsOf(args);
  assert.equal(graphs.length, 4, 'four, four and two, then the layers\' own');
  const count = (text) => (text.match(/pixelize=/g) || []).length;
  assert.deepEqual(graphs.map(count), [4, 4, 2, 0]);
  // The first takes the layer's input, at the project's rate.
  assert.ok(graphs[0].startsWith('[0:v]fps=30,format=yuv420p[cv0s];[cv0s]split[cv0x0a][cv0x0b]'));
  // Each ends on a label the next one starts from.
  assert.ok(graphs[0].endsWith('[cv0x3o]'));
  assert.ok(graphs[1].startsWith('[cv0x3o]split[cv0x4a][cv0x4b]'));
  assert.ok(graphs[1].endsWith('[cv0x7o]'));
  assert.ok(graphs[2].startsWith('[cv0x7o]split[cv0x8a][cv0x8b]'));
  // And the layers' own graph takes the last one's as it would have taken the input.
  assert.ok(graphs[3].includes('[cv0x9o]fps=30'));
  assert.equal(graphs[3].includes('[0:v]'), false);
  // Three is the fewest that are shared out.
  const three = graphsOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: many.slice(0, 3) }], project: HD, output: 'o.mp4', sources: SRC }));
  assert.deepEqual(three.map(count), [3, 0]);
});

test('with the VFX in graphs of their own the sound has one too, or the export stands still', () => {
  const many = Array.from({ length: 3 }, (_, i) => ({ ...FILES[1], src: 'C:/c/gen/p' + i + '.png' }));
  const sound = T.createLayer({ id: 'a', type: 'audio', src: 'a.mp4', sourceDuration: 60, duration: 10 });
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: many }, sound], project: HD, output: 'o.mp4', sources: SRC });
  const graphs = graphsOf(args);
  assert.equal(graphs.length, 3, 'the VFX, the layers, the sound');
  assert.equal(/\[\d+:a\]|amix|apad/.test(graphs[0] + graphs[1]), false, 'no sound in the picture\'s graphs');
  assert.ok(/\[\d+:a\]/.test(graphs[2]) && graphs[2].endsWith('[aout]'));
  assert.equal(/overlay|split/.test(graphs[2]), false, 'and no picture in the sound\'s');
  // With few VFX it is the one graph it always was, sound and all.
  const few = graphsOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: FILES }, sound], project: HD, output: 'o.mp4', sources: SRC }));
  assert.equal(few.length, 1);
  assert.ok(few[0].endsWith('[aout]') && few[0].includes('[cv0x1o]fps=30'));
});

test('several graphs too long for a command line each go into a file of their own', () => {
  const many = Array.from({ length: 6 }, (_, i) => ({ ...FILES[1], src: 'C:/c/gen/p' + i + '.png' }));
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: many }], project: HD, output: 'o.mp4', sources: SRC });
  assert.deepEqual(spillGraph(args, 'g.txt'), { args, graph: null, files: [] }, 'short enough as it is');
  const texts = graphsOf(args);
  const spilt = spillGraph(args, 'g.txt', 100);
  assert.equal(spilt.args.includes('-filter_complex'), false);
  assert.deepEqual(spilt.args.filter((a, i) => spilt.args[i - 1] === '-/filter_complex'), ['g.txt.0', 'g.txt.1', 'g.txt']);
  assert.deepEqual(spilt.files, [
    { file: 'g.txt.0', text: texts[0] },
    { file: 'g.txt.1', text: texts[1] },
    { file: 'g.txt', text: texts[2] },
  ]);
  assert.equal(spilt.graph, texts[2], 'the layers\' own graph is the one in the file named');
  assert.equal(spilt.args.length, args.length);
  assert.ok(GRAPH_ARG_MAX > 100);
});

test('a strength that changes is a filter for each figure, on for exactly its frames', () => {
  const f = {
    ...FILES[0],
    steps: [
      { sigma: 5, ranges: [[0, 9]] },
      { sigma: 6, ranges: [[10, 19], [30, 39]] },
    ],
    on: [[0, 19], [30, 39]],
  };
  const parts = graphOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [f] }], project: HD, output: 'o.mp4', sources: SRC })).split(';');
  // Half a frame either side of the frames, on each frame's own time.
  assert.ok(parts.includes('[cv0x0b]crop=300:200:100:200,format=yuv444p,'
    + "gblur=sigma=5.0:steps=6:enable='between(t,-0.016667,0.316667)',"
    + "gblur=sigma=6.0:steps=6:enable='between(t,0.316667,0.65)+between(t,0.983333,1.316667)'[cv0x0c]"));
  // Where it is off the picture is handed on as it is.
  assert.ok(parts.includes("[cv0x0a][cv0x0h]overlay=x=100:y=200:format=yuv420:enable='between(t,-0.016667,0.65)+between(t,0.983333,1.316667)'[cv0x0o]"));
  assert.equal(graphOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [f] }], project: HD, output: 'o.mp4', sources: SRC })).includes('sendcmd'), false);
});

test('a Pixelate whose block changes is made of the whole picture, its part cut out afterwards', () => {
  const f = {
    ...FILES[1],
    region: { x: 784, y: 420, width: 252, height: 196 },
    whole: true,
    steps: [{ block: 8, ranges: [[0, 9]] }, { block: 10, ranges: [[10, 299]] }],
  };
  const parts = graphOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [f] }], project: HD, output: 'o.mp4', sources: SRC })).split(';');
  // The blocks are counted from the picture's corner, whatever their size.
  assert.ok(parts.includes("[cv0x0b]pixelize=w=8:h=8:enable='between(t,-0.016667,0.316667)',"
    + "pixelize=w=10:h=10:enable='between(t,0.316667,9.983333)',crop=252:196:784:420[cv0x0c]"));
  assert.ok(parts.includes('[cv0x0a][cv0x0h]overlay=x=784:y=420:format=yuv420[cv0x0o]'), 'on the whole clip long');
});

test('a picture that moves between keyframes takes its VFX along', () => {
  const R = { x: 320, y: 180, width: 640, height: 360 };
  const l = { ...vid({ keyframes: [{ t: 0, render: R }, { t: 2, render: { ...R, x: 0 } }] }), vfxFiles: [FILES[0]] };
  const g = graphOf(buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(g.includes('[cv0x0o]fps=30'), 'the moving road starts from the picture with its VFX');
  assert.ok(g.includes('eval=frame'));
  const turned = { ...vid({ keyframes: [{ t: 0, render: R, rotation: 0 }, { t: 2, render: R, rotation: 40 }] }), vfxFiles: [FILES[0]] };
  const g2 = graphOf(buildComposeArgs({ layers: [turned], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(g2.includes('[cv0x0o]fps=30'), 'and so does the turned one');
});

test('a VFX whose area moves goes to the encoder as numbered frames, held at either end', () => {
  const l = { ...vid({}), vfxFiles: [SEQ] };
  const args = buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC });
  const at = args.indexOf('C:/c/gen/seq-1/%05d.png');
  assert.deepEqual(args.slice(at - 5, at + 1), ['-framerate', '30', '-start_number', '0', '-i', 'C:/c/gen/seq-1/%05d.png']);
  const parts = graphOf(args).split(';');
  assert.ok(parts.includes('[1:v]tpad=start_mode=clone:start_duration=2.0:stop_mode=clone:stop_duration=3.966667,'
    + 'fps=30,format=gray,scale=700:500[cv0x0m]'), 'the first frame held before the move and the last after it');
  assert.ok(parts.includes('[cv0x0b]crop=700:500:100:200,format=yuv444p,gblur=sigma=16.2:steps=6[cv0x0c]'));
  assert.ok(parts.includes('[cv0x0c][cv0x0m]alphamerge[cv0x0h]'));
  // A move that fills the clip needs no holding, and a still one beside it is still one PNG.
  const whole = { ...SEQ, frames: { pattern: 'C:/c/gen/seq-2/%05d.png', lead: 0, tail: 0 } };
  const both = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [whole, FILES[1]] }], project: HD, output: 'o.mp4', sources: SRC });
  assert.deepEqual(both.filter((a, i) => both[i - 1] === '-i'), ['a.mp4', 'C:/c/gen/seq-2/%05d.png', 'C:/c/gen/p.png']);
  assert.ok(graphOf(both).split(';').includes('[1:v]fps=30,format=gray,scale=700:500[cv0x0m]'));
  assert.equal(graphOf(both).includes('tpad'), false);
});

test('a PNG with see-through parts is blended whole, premultiplied, its own alpha kept', () => {
  const img = {
    ...T.createLayer({ id: 'i', kind: 'image', type: 'video', src: 'logo.png', duration: 5, sourceWidth: 640, sourceHeight: 360 }),
    vfxFiles: [{ ...FILES[0], region: { x: 200, y: 80, width: 300, height: 200 } },
      { ...FILES[1], region: { x: 200, y: 80, width: 300, height: 200 }, steps: [{ block: 10 }] }],
  };
  const g = graphOf(buildComposeArgs({ layers: [img], project: HD, output: 'o.mp4', sources: { 'logo.png': { width: 640, height: 360 } } }));
  const parts = g.split(';');
  // V4.12. The picture is one frame held for the clip, and so is where the VFX acts.
  assert.ok(parts.includes('[0:v]loop=loop=-1:size=1:start=0,trim=duration=5.0,fps=30,format=yuva420p[cv0s]'));
  assert.ok(parts.includes('[cv0s]format=yuva444p,split[cv0x0a][cv0x0b]'));
  // V4.8. Premultiplied round the filter, so see-through colour weighs what it shows.
  assert.ok(parts.includes('[cv0x0b]premultiply=inplace=1,gblur=sigma=16.2:steps=6,unpremultiply=inplace=1[cv0x0c]'), 'the whole picture');
  assert.ok(parts.includes('[cv0x1b]premultiply=inplace=1,pixelize=w=10:h=10,unpremultiply=inplace=1[cv0x1c]'));
  assert.ok(parts.includes('[1:v]format=gray,scale=300:200,loop=loop=-1:size=1:start=0,trim=duration=5.0,fps=30,pad=640:360:200:80:black,mergeplanes=0x00000000:yuva444p[cv0x0m]'));
  assert.ok(parts.includes('[cv0x0a][cv0x0c][cv0x0m]maskedmerge,format=yuva420p[cv0x0o]'));
  assert.equal(g.includes('alphamerge'), false, 'not laid over itself, which would add the two alphas up');
  // A video has no alpha of its own and is filtered as it always was.
  const v = graphOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [SEQ] }], project: HD, output: 'o.mp4', sources: SRC }));
  assert.equal(v.includes('premultiply'), false);
});

test('what is not whole pixels inside the source, or of no kind, is left out rather than handed to ffmpeg', () => {
  const bad = [
    { ...FILES[0], region: { x: 100, y: 200, width: 3000, height: 200 } },
    { ...FILES[0], region: { x: 10.5, y: 0, width: 100, height: 100 } },
    { ...FILES[0], region: null },
    { ...FILES[0], src: '' },
    { ...FILES[0], kind: 'bloom' },
    { ...SEQ, frames: { lead: 1, tail: 1 } },
  ];
  for (const f of bad) {
    const g = graphOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [f] }], project: HD, output: 'o.mp4', sources: SRC }));
    assert.equal(/gblur|\[cv|tpad/.test(g), false, JSON.stringify(f.region));
  }
  // A block that came odd or broken is made even and at least two.
  const odd = graphOf(buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [{ ...FILES[1], steps: [{ block: 'x' }] }] }],
    project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(odd.includes('pixelize=w=2:h=2'));
});

// ---- the preview and the export's drawing ----

test('the preview and the export cut each VFX with the one drawing, as it is at the moment', () => {
  const comp = read('renderer', 'app', 'compositor.js');
  const exp = read('renderer', 'app', 'export.js');
  assert.ok(comp.includes('genDraw.drawCoverMask(m, v, src.W, src.H)'));
  assert.ok(exp.includes('genDraw.drawCoverMask(ink, now, W, H)'));
  assert.ok(comp.includes('.map((v) => timelineModel.vfxAt(v, at - layer.start))'), 'the preview, at the moment it draws');
  assert.ok(comp.includes('.filter((v) => !v.off && VFX_PREVIEW[v.kind])'), 'one that is off is not drawn');
  assert.ok(exp.includes('timelineModel.vfxAt(v, i / fps)'), 'each frame the moment at its start');
  assert.ok(exp.includes('timelineModel.vfxRuns(l, v, fps)'), 'and the figure by the same frames');
  assert.ok(exp.includes('genDraw.coverRegionUnion(region, genDraw.coverRegion(now, W, H, room))'));
  // The two figures come from the model both times.
  for (const text of [comp, exp]) {
    assert.ok(text.includes('timelineModel.obscureSigma(') && text.includes('timelineModel.pixelateBlock('));
  }
  // Blended in, not laid over: taken out of the picture where it acts first.
  assert.ok(/p\.globalCompositeOperation = 'destination-out';\s*p\.drawImage\(m\.canvas, 0, 0\);\s*p\.globalCompositeOperation = 'lighter';/.test(comp));
});

test('the preview lays the VFX on in their order, each on what the ones before it left', () => {
  const comp = read('renderer', 'app', 'compositor.js');
  assert.ok(comp.includes('layVfx(p, effects, el, src, w, h);'));
  // A later one reads the picture with the earlier ones on it, where they meet.
  assert.ok(comp.includes('const reads = !!under && onUnder.some((j) => meet(parts[j], part));'));
  assert.ok(comp.includes('if (!list.some((o, j) => j > i && meet(part, parts[j]))) return;'));
  // And nothing in it names a kind: each kind is a row.
  const body = comp.slice(comp.indexOf('function layVfx('), comp.indexOf('function vfxUnderlay('));
  assert.equal(/obscure|pixelate/.test(body), false);
  assert.ok(comp.includes('VFX_PREVIEW[v.kind].draw(e, p, v, el, src, w, h);'));
});

test('every kind has its row in the model, the preview, the export and the window', () => {
  const comp = read('renderer', 'app', 'compositor.js');
  const exp = read('renderer', 'app', 'export.js');
  const composer = read('src', 'composer.js');
  const win = read('renderer', 'app', 'vfx.js');
  const rows = (text, name) => {
    const at = text.indexOf('const ' + name + ' = {');
    assert.ok(at >= 0, name);
    const body = text.slice(at, text.indexOf('\n};', at));
    return [...body.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
  };
  assert.deepEqual(rows(comp, 'VFX_PREVIEW'), T.VFX_KIND_IDS);
  assert.deepEqual(rows(exp, 'VFX_EXPORT'), T.VFX_KIND_IDS);
  assert.deepEqual(rows(composer, 'VFX_FILTERS'), T.VFX_KIND_IDS);
  assert.deepEqual(rows(win, 'VFX_UI'), T.VFX_KIND_IDS);
});

// ---- the window ----

test('a video or image track\'s right click offers Add VFX or Edit VFX, not Obscure and Pixelate', () => {
  const js = read('renderer', 'app', 'gen', 'kinds.js');
  const at = js.indexOf("item(t('Edit VFX')");
  assert.ok(at > js.indexOf("item(t('Add Mask')"), 'under the mask entries');
  assert.ok(js.indexOf("item(t('Add VFX')") > at);
  assert.ok(at < js.indexOf("item(t('Add Keyframe')"), 'and over the keyframes');
  assert.equal(js.includes("item(t('Obscure')"), false);
  assert.equal(js.includes("item(t('Pixelate')"), false);
  assert.ok(js.includes('openVfx(layer.id, at)'));
});

test('a track has the VFX button left of its settings button, lit when it has VFX', () => {
  const js = read('renderer', 'app', 'clips.js');
  const at = js.indexOf("makeClipMark('clip-mark--vfx'");
  assert.ok(at > 0 && at < js.indexOf("makeClipMark('clip-mark--crop'"), 'before it, so to its left');
  assert.ok(js.includes("spark.src = '../images/effects.png';"));
  assert.ok(js.includes("vfx.classList.toggle('clip-mark--on', timelineModel.vfxList(layer).length > 0);"));
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'effects.png')), 'in the folder the build takes');
});

test('the window has its three parts, and the buttons under all of them', () => {
  const modal = HTML.slice(HTML.indexOf('<div id="vfxModal"'), HTML.indexOf('<div id="textGradModal"'));
  for (const id of ['vfxTitle', 'vfxMenuSearch', 'vfxMenu', 'vfxChain', 'vfxEditing', 'vfxPreviewAddBtn', 'vfxAbout',
    'vfxStatics', 'vfxStageCell', 'vfxStage', 'vfxCanvas', 'vfxOthers',
    'vfxBoxEl', 'vfxRotor', 'vfxAngle', 'vfxKeys', 'vfxKeysReadout', 'vfxKeysCanvas', 'vfxSettings',
    'vfxRemoveAllBtn', 'vfxCancelBtn', 'vfxApplyBtn']) {
    assert.ok(modal.includes('id="' + id + '"'), id);
  }
  // Left, centre, right, in that order. On the left the search over the
  // list; in the centre the VFX, the line with Add right of it, what the kind
  // does, the settings for the whole clip, the picture, the keyframes (V5.1.1).
  const order = ['id="vfxMenuSearch"', 'id="vfxMenu"', 'id="vfxChain"', 'id="vfxEditing"', 'id="vfxPreviewAddBtn"', 'id="vfxAbout"',
    'id="vfxStatics"', 'id="vfxStage"', 'id="vfxKeys"', 'id="vfxSettings"', 'id="vfxRemoveAllBtn"'];
  const places = order.map((o) => modal.indexOf(o));
  assert.deepEqual(places, places.slice().sort((a, b) => a - b));
  // Remove all VFX on the left, Cancel in the middle, Apply on the right.
  const row = modal.slice(modal.indexOf('<div class="crop-actions">'));
  assert.ok(row.indexOf('vfxRemoveAllBtn') < row.indexOf('vfxCancelBtn') && row.indexOf('vfxCancelBtn') < row.indexOf('vfxApplyBtn'));
  assert.ok(/id="vfxRemoveAllBtn" class="crop-remove-btn">Remove all VFX</.test(row));
  assert.ok(/id="vfxApplyBtn" class="crop-accept-btn">Apply</.test(row));
  // No kind's settings are written into the markup: they are made from the table.
  assert.equal(/type="range"|type="checkbox"|data-kind=/.test(modal), false);
  assert.equal(HTML.includes('coverModal'), false, 'the old window is gone');
  assert.ok(HTML.indexOf('app/keystrip.js') < HTML.indexOf('app/vfx.js'), 'the strip is loaded before the window that makes one');
  assert.ok(HTML.indexOf('app/vfx.js') > HTML.indexOf('app/gen/kinds.js'), 'and after what it uses');
  assert.equal(fs.existsSync(path.join(ROOT, 'renderer', 'app', 'cover.js')), false);
});

test('the three parts are a quarter, a half and a quarter, and the picture has what the centre leaves', () => {
  const css = read('renderer', 'style.css');
  const rule = (sel) => {
    const at = css.indexOf('\n' + sel + ' {');
    assert.ok(at >= 0, sel);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.ok(rule('.vfx-body').includes('grid-template-columns: 25% 50% 25%;'));
  // V5.1.1. The title moved up: the VFX, the line and the settings for the
  // whole clip take what they need, the picture the rest.
  assert.ok(rule('.vfx-center').includes('flex-direction: column;'));
  for (const sel of ['.vfx-chain', '.vfx-head', '.vfx-statics', '.vfx-keys-cell']) assert.ok(rule(sel).includes('flex: none;'), sel);
  assert.ok(rule('.vfx-stage-cell').includes('flex: 1 1 0;'));
  assert.ok(rule('.vfx-statics').includes('overflow-y: auto;'));
  assert.ok(rule('.vfx-menu__list').includes('overflow-y: auto;'));
  assert.ok(rule('.vfx-settings').includes('overflow-y: auto;'));
  // The user: static settings "slightly greenish (like 222, 255, 222)", the keyed ones white.
  assert.ok(/\.vfx-group--static[^{]*\{\s*color: rgb\(222, 255, 222\);/.test(css));
  assert.ok(/\.vfx-group--keyed[^{]*\{\s*color: #ffffff;/.test(css));
  // The + and the X are only their glyphs, the X alone red.
  assert.ok(rule('button.vfx-menu__add').includes('background: none;'));
  assert.ok(rule('button.vfx-chip__x').includes('background: none;'));
  // Rows that are display: flex hide only by a rule of their own.
  assert.ok(css.includes('.vfx-menu__row[hidden],'));
});

test('the window is made from the table: the menu, the settings in their two groups, the keyframes', () => {
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes("popOut(vfxModal, 'vfx'"), 'an editor window of its own');
  assert.ok(js.includes('noDock: true'), 'which does not dock');
  assert.ok(js.includes('const rest = timelineModel.VFX_KIND_IDS.filter((kind) => !listed.has(kind));'), 'the menu is every kind there is');
  // V5.1.1. A click on a row previews it; its + adds, or a double click.
  assert.ok(js.includes("vfxMenu.addEventListener('dblclick'"));
  assert.ok(/vfxMenu\.addEventListener\('click', \(evt\) => \{\s*const add = evt\.target\.closest && evt\.target\.closest\('\.vfx-menu__add'\);\s*if \(add\) \{\s*addVfx\(/.test(js));
  assert.ok(js.includes('if (row) previewVfx(row.dataset.kind);'));
  assert.ok(js.includes("vfxPreviewAddBtn.addEventListener('click', keepVfxPreview);"));
  // The statics in the centre, the keyed ones on the right.
  assert.ok(js.includes('if (fixed) vfxStatics.appendChild(fixed);'));
  assert.ok(js.includes('if (keyed) vfxSettings.appendChild(keyed);'));
  assert.ok(js.includes("group('vfx-group--static', t('The same for the whole clip'), def.statics, false)"));
  assert.ok(js.includes("group('vfx-group--keyed', t('Per keyframe'), def.keyed, true)"));
  assert.ok(js.includes('makeKeyStrip(vfxKeys, vfxKeysReadout, vfxKeysCanvas, {'));
  for (const call of ['timelineModel.putVfxKey(', 'timelineModel.removeVfxKey(', 'timelineModel.moveVfxKey(',
    'timelineModel.vfxKeyNear(', 'timelineModel.vfxValuesAt(']) {
    assert.ok(js.includes(call), call + ' comes from the model');
  }
  // The picture is drawn at the playhead's moment, and a press while playing stops first.
  assert.ok(js.includes('live.start + vfxLocalT()'));
  assert.ok(/pauseComposite\(\);\s*followVfxPlayhead\(\);/.test(js));
  // Nothing in the window's code is written for a kind but its name.
  const code = js.slice(js.indexOf('const VFX_STAGE_MAX'));
  assert.equal(/'obscure'|'pixelate'/.test(code), false);
});

test('Apply writes the whole list as one step, and only when it changed anything', () => {
  const js = read('renderer', 'app', 'vfx.js');
  const apply = js.slice(js.indexOf('function applyVfx()'), js.indexOf('function previewVfxDraft()'));
  assert.ok(apply.includes('setLayers(timelineModel.setLayer(layers, id, { vfx: list }));'));
  // V5.1.1. A VFX only previewed was never added and stays off the track.
  assert.ok(apply.includes('vfxListOfDraft(vfxDraft.filter((v) => v.id !== vfxPreviewId))'));
  assert.equal((apply.match(/commitHistory\(\)/g) || []).length, 1, 'one undo step, however much was changed');
  assert.ok(apply.indexOf('if (!changed) return;') < apply.indexOf('setLayers('));
  // Nothing else in the window writes to the track.
  assert.equal((js.match(/setLayers\(/g) || []).length, 1);
  assert.equal((js.match(/commitHistory\(\)/g) || []).length, 1);
});

test('the note is shown once a project, over the window, with the one button', () => {
  const js = read('renderer', 'app', 'vfx.js');
  const note = js.slice(js.indexOf('function noteVfxKeyframes()'), js.indexOf('// ---- the track\'s VFX'));
  assert.ok(note.includes("if (!timelineModel.vfxNoteDue(vfxDraft) || projectNoted('vfxKeyframes')) return;"));
  assert.ok(note.indexOf("noteProject('vfxKeyframes');") < note.indexOf('showChoice('), 'noted as it opens');
  assert.ok(note.includes("t('Note: You can add/edit/modify Keyframes to use the same VFX with different settings at different times')"));
  assert.ok(note.includes("buttons: [{ id: 'ok', label: t('I Understand'), tone: 'go' }]"));
  assert.ok(note.includes('over: vfxModal'));
  const editing = read('renderer', 'app', 'editing.js');
  assert.ok(editing.includes('notes: notesForFile()'), 'written with the project');
  assert.ok(editing.includes('adoptNotes(result.notes);'), 'and read back with it');
  assert.ok(read('renderer', 'app', 'startup.js').includes('adoptNotes(null);'), 'a new project has shown none');
  assert.ok(read('renderer', 'app', 'autosave.js').includes('notes: notesForFile()'));
});

test('the VFX window opens half as wide as the main window, and never under what its parts need', () => {
  const main = read('main.js');
  assert.ok(main.includes("const POPOUT_SHARES = { 'lwc-pop-vfx': { of: [0.5, 0.8], least: [900, 600] } };"));
  assert.ok(main.includes('Math.max(share.least[0], Math.round(host.width * share.of[0]))'));
});

test('the new words are in both languages, and the old window\'s are gone', () => {
  const en = JSON.parse(read('locales', 'en.json'));
  const de = JSON.parse(read('locales', 'de.json'));
  for (const key of ['Add VFX', 'Edit VFX', 'Editing VFX for {name}', 'Editing {name}', 'Available VFX', 'Remove all VFX',
    'The same for the whole clip', 'Per keyframe', 'Invert Area', 'I Understand', 'Obscure', 'Pixelate', 'Strength:',
    'Note: You can add/edit/modify Keyframes to use the same VFX with different settings at different times']) {
    assert.equal(en[key], key);
    assert.ok(de[key] && de[key] !== key, key + ' has a German word');
  }
  assert.equal(en.VFX, 'VFX');
  assert.equal(de.VFX, 'VFX');
  for (const key of ['Add Area', 'Remove Area', 'Invert Areas']) {
    assert.equal(key in en, false, key);
    assert.equal(key in de, false, key);
  }
});
