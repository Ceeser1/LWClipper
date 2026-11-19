'use strict';

// V5.5.2. Lock and Solo per row, slip, roll and slide, ease between
// keyframes: the model's half of each (src/timeline.js), the ease in the
// preview's placement (geometry.js) and in the export's expressions
// (composer.js piecewise), which must give the same numbers.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/timeline');
const G = require('../src/geometry');
const C = require('../src/composer');

const clip = (id, start, duration, extra = {}) => M.createLayer({
  id, type: 'video', src: id + '.mp4', start, duration, sourceDuration: 100, lane: 0, ...extra,
});
const sound = (id, start, duration, extra = {}) => M.createLayer({
  id, type: 'audio', src: id + '.mp3', start, duration, sourceDuration: 100, lane: 0, ...extra,
});
const byId = (layers, id) => layers.find((l) => l.id === id);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- Lock and Solo ----

test('a layer is unlocked and unsoloed unless it says otherwise, and keeps what it says', () => {
  const a = clip('a', 0, 2);
  assert.equal(a.locked, false);
  assert.equal(a.solo, false);
  const b = M.createLayer({ ...a, locked: true, solo: true });
  assert.equal(b.locked, true);
  assert.equal(b.solo, true);
  // A project written before 5.5.2 has neither field.
  const { locked: _l, solo: _s, ...old } = a;
  assert.equal(M.createLayer(old).locked, false);
});

test('a soloed row quietens the other rows of its kind and leaves the other kind alone', () => {
  const layers = [
    clip('v1', 0, 4), clip('v2', 0, 4, { lane: 1 }),
    sound('a1', 0, 4, { solo: true }), sound('a2', 0, 4, { lane: 1 }),
  ];
  const at = M.layersAt(layers, 1).map((l) => l.id).sort();
  assert.deepEqual(at, ['a1', 'v1', 'v2']);
  const shown = M.withSolo(layers);
  assert.equal(byId(shown, 'a2').enabled, false);
  assert.equal(byId(shown, 'a1').enabled, true);
  assert.equal(byId(shown, 'v2').enabled, true);
  assert.equal(M.layerLive(layers, byId(layers, 'a2')), false);
  // Nothing soloed: the very list.
  const plain = [clip('x', 0, 1)];
  assert.equal(M.withSolo(plain), plain);
});

test('a soloed row that is switched off stays off', () => {
  const layers = [sound('a1', 0, 4, { solo: true, enabled: false }), sound('a2', 0, 4, { lane: 1 })];
  assert.deepEqual(M.layersAt(layers, 1), []);
});

test('a clip dragged onto a soloed row takes its Solo, and off it loses it', () => {
  const before = [
    sound('a', 0, 2, { solo: true }), sound('b', 3, 2, { solo: true }),
    sound('c', 0, 2, { lane: 1 }),
  ];
  // c dragged onto the soloed row.
  const into = M.settleRowFlags(before, before.map((l) => (l.id === 'c' ? { ...l, lane: 0, start: 6 } : l)));
  assert.equal(byId(into, 'c').solo, true);
  // b dragged off it onto c's row.
  const off = M.settleRowFlags(before, before.map((l) => (l.id === 'b' ? { ...l, lane: 1, start: 6 } : l)));
  assert.equal(byId(off, 'b').solo, false);
  // b dragged onto a row nobody was on.
  const empty = M.settleRowFlags(before, before.map((l) => (l.id === 'b' ? { ...l, lane: 2 } : l)));
  assert.equal(byId(empty, 'b').solo, false);
});

test('a whole row moved keeps its Lock and Solo', () => {
  const before = M.arrangeLanes([
    clip('a', 0, 2, { locked: true }), clip('b', 3, 2, { locked: true }), clip('c', 0, 2, { lane: 1 }),
  ]);
  const moved = M.reorderLane(before, 'video', 0, 1, 2);
  const settled = M.settleRowFlags(before, moved);
  assert.equal(byId(settled, 'a').locked, true);
  assert.equal(byId(settled, 'a').lane, 1);
  assert.equal(byId(settled, 'c').locked, false);
});

test('a new clip on a soloed row is soloed, and a pasted copy brings no lock', () => {
  const before = [sound('a', 0, 2, { solo: true })];
  const added = M.settleRowFlags(before, [...before, sound('n', 5, 1)]);
  assert.equal(byId(added, 'n').solo, true);
  const pasted = M.settleRowFlags(before, [...before, sound('p', 0, 1, { lane: 3, locked: true, solo: true })]);
  assert.equal(byId(pasted, 'p').locked, false);
  assert.equal(byId(pasted, 'p').solo, false);
  // Nothing to change: the very list.
  assert.equal(M.settleRowFlags(before, before), before);
});

test('a grouped partner on a locked row is left where it is when its picture moves or trims', () => {
  const layers = [
    clip('v', 2, 4, { groupId: 'g' }),
    sound('s', 2, 4, { groupId: 'g', locked: true }),
  ];
  assert.deepEqual(M.groupOf(layers, 'v').map((l) => l.id), ['v']);
  assert.deepEqual(M.linkedOf(layers, 'v').map((l) => l.id), ['v']);
  const moved = M.moveGroup(layers, 'v', 5);
  assert.equal(byId(moved, 'v').start, 5);
  assert.equal(byId(moved, 's').start, 2);
  const trimmed = M.trimGroup(layers, 'v', 'end', 4);
  assert.equal(byId(trimmed, 'v').duration, 2);
  assert.equal(byId(trimmed, 's').duration, 4);
});

test('delete and close gap passes a locked row by, and does not wait for it', () => {
  const layers = [
    clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 1),
    // Locked, and running through the gap: it would hold the others back.
    sound('m', 1, 10, { locked: true }), sound('late', 6, 1, { lane: 1, locked: true }),
  ];
  const out = M.rippleRemove(layers, ['b']);
  assert.equal(byId(out.layers, 'c').start, 2);
  assert.equal(byId(out.layers, 'm').start, 1);
  assert.equal(byId(out.layers, 'late').start, 6);
  assert.equal(out.closed, 3);
  const made = M.rippleInsert(layers, 4, 2);
  assert.equal(byId(made, 'c').start, 7);
  assert.equal(byId(made, 'late').start, 6);
});

test('a paste onto a locked row goes onto a row of its own', () => {
  const layers = M.arrangeLanes([clip('a', 0, 2, { locked: true })]);
  assert.equal(M.laneLocked(layers, 'video', 0), true);
  assert.equal(M.laneLocked(layers, 'video', 1), false);
  const copied = { primary: 'x', items: [clip('x', 0, 1)] };
  const next = M.pasteInto(layers, copied, 5, 0);
  const pasted = next.find((l) => l.id !== 'a');
  assert.equal(pasted.lane, 1);
});

// ---- Slip ----

test('a slip moves the source under a clip and leaves its place and length', () => {
  const layers = [clip('a', 10, 4, { sourceIn: 20 })];
  const next = M.slipGroup(layers, 'a', 1.5);
  const a = byId(next, 'a');
  assert.equal(a.start, 10);
  assert.equal(a.duration, 4);
  // Right with the pointer: an earlier part of the source.
  assert.equal(a.sourceIn, 18.5);
});

test('a slip stops where the source runs out at either end', () => {
  const layers = [clip('a', 10, 4, { sourceIn: 2 })];
  assert.equal(byId(M.slipGroup(layers, 'a', 9), 'a').sourceIn, 0);
  assert.deepEqual(M.slipRange(layers[0]), { lo: -94, hi: 2 });
  assert.equal(byId(M.slipGroup(layers, 'a', -500), 'a').sourceIn, 96);
});

test('a slip at another speed moves that much more of the source', () => {
  const layers = [clip('a', 0, 4, { sourceIn: 20, speed: 2 })];
  assert.equal(byId(M.slipGroup(layers, 'a', 1), 'a').sourceIn, 18);
});

test('a slip takes the grouped sound along, so the two stay in step', () => {
  const layers = [
    clip('v', 0, 4, { sourceIn: 10, groupId: 'g' }),
    sound('s', 0, 4, { sourceIn: 10, groupId: 'g' }),
  ];
  const next = M.slipGroup(layers, 'v', -2);
  assert.equal(byId(next, 'v').sourceIn, 12);
  assert.equal(byId(next, 's').sourceIn, 12);
});

test('keyframes go with the slipped picture, so they stay on the frames they were set on', () => {
  const layers = [clip('a', 0, 4, { sourceIn: 10, keyframes: [{ id: 'k1', t: 1 }, { id: 'k2', t: 3 }] })];
  const next = M.slipGroup(layers, 'a', 0.5);
  assert.deepEqual(M.keyframesFor(byId(next, 'a')).map((k) => k.t), [1.5, 3.5]);
});

test('a still has no source to slip, and a locked clip is not slipped', () => {
  const still = M.createLayer({ id: 'i', type: 'video', kind: 'image', src: 'i.png', start: 0, duration: 4 });
  const layers = [still];
  assert.equal(M.slipGroup(layers, 'i', 1), layers);
  const locked = [clip('a', 0, 4, { sourceIn: 10, locked: true })];
  assert.equal(M.slipGroup(locked, 'a', 1), locked);
});

// ---- Roll ----

test('the clips that meet at a cut are found, and nothing across a gap', () => {
  const layers = M.arrangeLanes([clip('a', 0, 4), clip('b', 4, 3), clip('c', 8, 1)]);
  assert.equal(M.cutNeighbour(layers, 'a', 'end').id, 'b');
  assert.equal(M.cutNeighbour(layers, 'b', 'start').id, 'a');
  assert.equal(M.cutNeighbour(layers, 'b', 'end'), null);
  assert.equal(M.cutNeighbour(layers, 'a', 'start'), null);
});

test('a roll moves the cut: one clip longer by what the other loses', () => {
  const layers = M.arrangeLanes([clip('a', 0, 4, { sourceIn: 10 }), clip('b', 4, 3, { sourceIn: 30 })]);
  const next = M.rollCut(layers, 'a', 'b', 1);
  const a = byId(next, 'a');
  const b = byId(next, 'b');
  assert.equal(a.start, 0);
  assert.equal(a.duration, 5);
  assert.equal(b.start, 5);
  assert.equal(b.duration, 2);
  // The right clip's picture holds where it is on the timeline.
  assert.equal(b.sourceIn, 31);
  assert.equal(M.endOf(b), 7);
});

test('a roll stops at the source that is there and at a clip\'s least length', () => {
  const layers = M.arrangeLanes([clip('a', 0, 4, { sourceIn: 10 }), clip('b', 4, 3, { sourceIn: 1 })]);
  // Back: b can only reach one second further into its source.
  const back = M.rollCut(layers, 'a', 'b', -3);
  assert.equal(byId(back, 'b').start, 3);
  assert.equal(byId(back, 'b').sourceIn, 0);
  assert.equal(byId(back, 'a').duration, 3);
  // On: b keeps its least length.
  const on = M.rollCut(layers, 'a', 'b', 10);
  assert.ok(near(byId(on, 'b').duration, M.MIN_LAYER_SPAN));
  assert.ok(near(M.endOf(byId(on, 'a')), byId(on, 'b').start));
});

// ---- Slide ----

test('a slide moves a clip between the two it meets, and the row around them stays', () => {
  const layers = M.arrangeLanes([
    clip('a', 0, 4, { sourceIn: 10 }), clip('b', 4, 2, { sourceIn: 50 }), clip('c', 6, 4, { sourceIn: 20 }),
  ]);
  const next = M.slideGroup(layers, 'b', 1);
  assert.equal(byId(next, 'b').start, 5);
  assert.equal(byId(next, 'b').sourceIn, 50);
  assert.equal(byId(next, 'b').duration, 2);
  assert.equal(M.endOf(byId(next, 'a')), 5);
  assert.equal(byId(next, 'c').start, 7);
  assert.equal(M.endOf(byId(next, 'c')), 10);
  assert.equal(byId(next, 'c').sourceIn, 21);
});

test('a slide stops where a neighbour would be shorter than a clip may be', () => {
  const layers = M.arrangeLanes([clip('a', 0, 4), clip('b', 4, 2), clip('c', 6, 1)]);
  const next = M.slideGroup(layers, 'b', 5);
  assert.ok(near(byId(next, 'c').duration, M.MIN_LAYER_SPAN));
  assert.ok(near(byId(next, 'b').start, 5 - M.MIN_LAYER_SPAN));
});

test('a slide with nothing on one side is free on that side, and takes its sound along', () => {
  const layers = M.arrangeLanes([
    clip('b', 4, 2, { groupId: 'g' }), clip('c', 6, 4, { sourceIn: 10 }),
    sound('s', 4, 2, { groupId: 'g' }),
  ]);
  const next = M.slideGroup(layers, 'b', -3);
  assert.equal(byId(next, 'b').start, 1);
  assert.equal(byId(next, 's').start, 1);
  assert.equal(byId(next, 'c').start, 3);
  assert.equal(M.endOf(byId(next, 'c')), 10);
});

// ---- Ease ----

test('the four bends of a stretch between keyframes', () => {
  const plain = {};
  const out = { easeOut: true };
  const inn = { easeIn: true };
  assert.equal(M.easeKind(plain, plain), null);
  assert.equal(M.easeKind(out, plain), 'out');
  assert.equal(M.easeKind(plain, inn), 'in');
  assert.equal(M.easeKind({ easeOut: true }, { easeIn: true }), 'both');
  assert.equal(M.keyEase(plain, plain, 0.25), 0.25);
  assert.equal(M.keyEase(out, plain, 0.5), 0.25);
  assert.equal(M.keyEase(plain, inn, 0.5), 0.75);
  assert.equal(M.keyEase({ easeOut: true }, { easeIn: true }, 0.5), 0.5);
  assert.ok(near(M.keyEase({ easeOut: true }, { easeIn: true }, 0.25), 0.15625));
  for (const [a, b] of [[plain, plain], [out, plain], [plain, inn], [out, inn]]) {
    assert.equal(M.keyEase(a, b, 0), 0);
    assert.equal(M.keyEase(a, b, 1), 1);
  }
});

test('a keyframe carries its ease only when it has one, and keeps it when written again', () => {
  const layers = [clip('a', 0, 4, { keyframes: [{ id: 'k1', t: 0 }, { id: 'k2', t: 2 }] })];
  const k1 = M.keyframesFor(layers[0])[0];
  assert.equal('easeIn' in k1, false);
  const eased = M.setKeyframeEase(layers, 'a', 'k1', { easeOut: true });
  assert.equal(M.keyframesFor(byId(eased, 'a'))[0].easeOut, true);
  // A window's Accept writes the keyframe with no word of its ease.
  const written = M.putKeyframe(eased, 'a', { id: 'k1', t: 0, crop: null });
  assert.equal(M.keyframesFor(byId(written, 'a'))[0].easeOut, true);
  // Through the project file and back.
  const again = M.createLayer(JSON.parse(JSON.stringify(byId(eased, 'a'))));
  assert.equal(M.keyframesFor(again)[0].easeOut, true);
  // Unticked, the field goes.
  const plain = M.setKeyframeEase(eased, 'a', 'k1', { easeOut: false });
  assert.equal('easeOut' in M.keyframesFor(byId(plain, 'a'))[0], false);
  // No such keyframe: the very list.
  assert.equal(M.setKeyframeEase(layers, 'a', 'nope', { easeIn: true }), layers);
});

const project = { width: 1920, height: 1080 };
const source = { width: 1920, height: 1080 };
const moving = (ease1 = {}, ease2 = {}) => clip('m', 0, 4, {
  sourceWidth: 1920,
  sourceHeight: 1080,
  keyframes: [
    { id: 'k1', t: 0, render: { x: 0, y: 0, width: 960, height: 540 }, ...ease1 },
    { id: 'k2', t: 2, render: { x: 960, y: 540, width: 960, height: 540 }, ...ease2 },
  ],
});

test('the preview places an eased picture along the curve', () => {
  const linear = G.placementAt(moving(), 0.5, source, project);
  assert.ok(near(linear.dest.x, 240));
  const slowStart = G.placementAt(moving({ easeOut: true }), 0.5, source, project);
  assert.ok(near(slowStart.dest.x, 60));
  const slowEnd = G.placementAt(moving({}, { easeIn: true }), 0.5, source, project);
  assert.ok(near(slowEnd.dest.x, 420));
});

// The export's expression of t, worked out the way ffmpeg would.
function evalExpr(expr, t) {
  const js = expr.replace(/\\,/g, ',')
    .replace(/\bclip\(/g, '_clip(')
    .replace(/\bif\(/g, '_if(')
    .replace(/\blt\(/g, '_lt(');
  // eslint-disable-next-line no-new-func
  const f = new Function('t', '_clip', '_if', '_lt', 'return ' + js + ';');
  return f(t, (x, a, b) => Math.min(b, Math.max(a, x)), (c, a, b) => (c ? a : b), (a, b) => (a < b ? 1 : 0));
}

test('the export bends an eased stretch exactly as the preview does', () => {
  for (const [e1, e2] of [[{}, {}], [{ easeOut: true }, {}], [{}, { easeIn: true }], [{ easeOut: true }, { easeIn: true }]]) {
    const layer = moving(e1, e2);
    const motion = G.motionOf(layer, source, project);
    const times = motion.map((k) => layer.start + k.t);
    const expr = C.piecewise(times, motion.map((k) => k.dest.x), motion);
    for (const t of [0, 0.3, 0.5, 1, 1.7, 2, 3]) {
      const preview = G.placementAt(layer, t, source, project).dest.x;
      assert.ok(near(evalExpr(expr, t), preview, 1e-3), JSON.stringify([e1, e2, t]));
    }
  }
});

test('an expression with no ease is written as it always was', () => {
  const plain = C.piecewise([0, 2], [0, 960]);
  const keyed = C.piecewise([0, 2], [0, 960], [{ t: 0 }, { t: 2 }]);
  assert.equal(keyed, plain);
});

test('a mask between eased keyframes bends the same way', () => {
  const layer = clip('m', 0, 4, {
    mask: { kind: 'rect', box: { x: 0, y: 0, w: 100, h: 100 } },
    keyframes: [
      { id: 'k1', t: 0, mask: { box: { x: 0, y: 0, w: 100, h: 100 }, soft: 0 }, easeOut: true },
      { id: 'k2', t: 2, mask: { box: { x: 100, y: 0, w: 100, h: 100 }, soft: 0 } },
    ],
  });
  assert.ok(near(M.maskAt(layer, 1).box.x, 25));
});
