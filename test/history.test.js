'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/history');
const T = require('../src/timeline');

function video(props) {
  return T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60, ...props });
}

function state(layers, start = 0, end = 60) {
  return { layers, start, end };
}

test('a fresh history has nothing behind or ahead of it', () => {
  const h = H.create(state([]));
  assert.equal(H.canUndo(h), false);
  assert.equal(H.canRedo(h), false);
});

test('a commit puts the old state behind and the new one in front', () => {
  const a = state([]);
  const b = state([video()]);
  const h = H.commit(H.create(a), b);
  assert.equal(H.canUndo(h), true);
  assert.equal(h.present, b);
  assert.equal(H.undo(h).present, a);
});

test('undo and redo walk the same steps both ways', () => {
  const l = video();
  const a = state([]);
  const b = state([l]);
  const c = state([{ ...l, start: 5 }]);
  let h = H.commit(H.commit(H.create(a), b), c);
  h = H.undo(h);
  assert.equal(h.present, b);
  h = H.undo(h);
  assert.equal(h.present, a);
  assert.equal(H.canUndo(h), false);
  h = H.redo(h);
  assert.equal(h.present, b);
  h = H.redo(h);
  assert.equal(h.present, c);
  assert.equal(H.canRedo(h), false);
});

test('undo and redo at the ends of the stack are refused rather than throwing', () => {
  const h = H.create(state([]));
  assert.equal(H.undo(h), h);
  assert.equal(H.redo(h), h);
});

test('a new step throws away what redo was holding', () => {
  const l = video();
  let h = H.commit(H.create(state([])), state([l]));
  h = H.undo(h);
  assert.equal(H.canRedo(h), true);
  h = H.commit(h, state([{ ...l, start: 9 }]));
  assert.equal(H.canRedo(h), false);
});

// ---- the no-op skip ----

test('a gesture that changed nothing does not consume a press', () => {
  const l = video();
  const h = H.create(state([l]));
  // The same document, freshly built: equal by value, not by reference, which
  // is what every real commit hands in.
  const same = state([{ ...l }]);
  assert.equal(H.commit(h, same), h);
  assert.equal(H.canUndo(H.commit(h, same)), false);
});

test('a volume change alone is not a step', () => {
  const l = video({ volume: 1 });
  const h = H.create(state([l]));
  const louder = state([{ ...l, volume: 1.5 }]);
  assert.equal(H.commit(h, louder), h);
});

test('an enable change alone is not a step', () => {
  const l = video();
  const h = H.create(state([l]));
  assert.equal(H.commit(h, state([{ ...l, enabled: false }])), h);
});

test('a crop accepted unchanged after a volume nudge is still not a step', () => {
  // The trap this exists for: without the live fields being ignored, the crop
  // commit would see a different volume, push a step, and Ctrl+Z would appear
  // to do nothing.
  const l = video({ volume: 1, crop: { x: 0, y: 0, width: 960, height: 540 } });
  const h = H.create(state([l]));
  assert.equal(H.commit(h, state([{ ...l, volume: 0.4 }])), h);
});

test('a real change alongside a volume change is still a step', () => {
  const l = video({ volume: 1 });
  const h = H.create(state([l]));
  const moved = state([{ ...l, volume: 0.2, start: 4 }]);
  assert.equal(H.canUndo(H.commit(h, moved)), true);
});

test('moving a trim marker is a step on its own', () => {
  const l = video();
  const h = H.create(state([l], 0, 60));
  assert.equal(H.canUndo(H.commit(h, state([l], 0, 30))), true);
});

// ---- the project's render rate, Step 16 ----

test('changing the render rate is a step on its own', () => {
  const l = video();
  const h = H.create({ ...state([l]), fps: 30 });
  assert.equal(H.canUndo(H.commit(h, { ...state([l]), fps: 60 })), true);
  assert.equal(H.undo(H.commit(h, { ...state([l]), fps: 60 })).present.fps, 30);
});

test('the same rate twice is not a step', () => {
  const l = video();
  const h = H.create({ ...state([l]), fps: 30 });
  assert.equal(H.commit(h, { ...state([{ ...l }]), fps: 30 }), h);
});

test('a snapshot with no rate at all reads as unchanged against a zero one', () => {
  // Both spellings of "this project has no shape yet": a state written before
  // Step 16 carried no field, and one written after carries 0. Neither is a
  // gesture, so neither may push a step.
  const l = video();
  const h = H.create(state([l]));
  assert.equal(H.commit(h, { ...state([{ ...l }]), fps: 0 }), h);
});

test('reseat corrects the present without taking a step', () => {
  // What a decoder answering looks like: the layer was added and committed
  // before the file said what rate it runs at.
  const l = video();
  const added = H.commit(H.create({ ...state([]), fps: 0 }), { ...state([l]), fps: 0 });
  const seeded = H.reseat(added, { ...state([l]), fps: 29.97 });
  assert.equal(seeded.past.length, added.past.length);
  assert.equal(seeded.present.fps, 29.97);
  assert.deepEqual(seeded.future, []);
});

test('a rate picked after a reseat is one step back to the seeded rate', () => {
  // The whole point, end to end: without the reseat the step behind the change
  // claims the project had no rate at all.
  const l = video();
  let h = H.commit(H.create({ ...state([]), fps: 0 }), { ...state([l]), fps: 0 });
  h = H.reseat(h, { ...state([l]), fps: 29.97 });
  h = H.commit(h, { ...state([l]), fps: 24 });
  assert.equal(H.undo(h).present.fps, 29.97);
  assert.equal(H.redo(H.undo(h)).present.fps, 24);
});

test('reseat on an empty history changes nothing', () => {
  const empty = { past: [], present: null, future: [] };
  assert.equal(H.reseat(empty, state([])), empty);
  const h = H.create(state([]));
  assert.equal(H.reseat(h, null), h);
});

test('the rate survives a restore, which reads the whole snapshot', () => {
  const l = video();
  const restored = H.restore({ ...state([l]), fps: 48 }, [l]);
  assert.equal(restored.fps, 48);
});

test('a reorder is a change even though the same layers are there', () => {
  const a = video({ name: 'a' });
  const b = video({ name: 'b' });
  const h = H.create(state([a, b]));
  assert.equal(H.canUndo(H.commit(h, state([b, a]))), true);
});

test('a crop is compared by value, not by identity', () => {
  const l = video({ crop: { x: 0, y: 0, width: 960, height: 540 } });
  const h = H.create(state([l]));
  const rebuilt = state([{ ...l, crop: { x: 0, y: 0, width: 960, height: 540 } }]);
  assert.equal(H.commit(h, rebuilt), h);
  const tighter = state([{ ...l, crop: { x: 0, y: 0, width: 640, height: 360 } }]);
  assert.equal(H.canUndo(H.commit(h, tighter)), true);
});

test('taking a crop off is a step', () => {
  const l = video({ crop: { x: 0, y: 0, width: 960, height: 540 } });
  const h = H.create(state([l]));
  assert.equal(H.canUndo(H.commit(h, state([{ ...l, crop: null }]))), true);
});

// ---- restoring ----

test('an undo keeps the enable and volume the layers have now', () => {
  const l = video({ volume: 1, enabled: true, start: 0 });
  const snapshot = state([l]);
  // Since the snapshot was taken the clip moved and was muted and turned down.
  const live = [{ ...l, start: 20, enabled: false, volume: 0.25 }];
  const out = H.restore(snapshot, live);
  assert.equal(out.layers[0].start, 0, 'the move is undone');
  assert.equal(out.layers[0].enabled, false, 'the tick is left alone');
  assert.equal(out.layers[0].volume, 0.25, 'the level is left alone');
});

test('a layer being brought back keeps the settings it went away with', () => {
  const l = video({ volume: 0.5, enabled: false });
  // Nothing live to take them from: this undo is what is putting it back.
  const out = H.restore(state([l]), []);
  assert.equal(out.layers[0].volume, 0.5);
  assert.equal(out.layers[0].enabled, false);
});

test('restoring carries the trim markers across', () => {
  const out = H.restore(state([video()], 3, 40), []);
  assert.equal(out.start, 3);
  assert.equal(out.end, 40);
});

test('restoring does not mutate the snapshot it was given', () => {
  const l = video({ volume: 1 });
  const snapshot = state([l]);
  H.restore(snapshot, [{ ...l, volume: 0.1 }]);
  assert.equal(snapshot.layers[0].volume, 1);
  assert.equal(snapshot.layers[0], l);
});

// ---- the limit ----

test('the stack stops growing at the limit and drops the oldest step', () => {
  let h = H.create(state([video({ start: 0 })]));
  for (let i = 1; i <= H.LIMIT + 10; i += 1) {
    h = H.commit(h, state([video({ id: 'fixed', start: i })]));
  }
  assert.equal(h.past.length, H.LIMIT);
  // 110 commits push 110 states behind, the initial one and 109 of the rest,
  // and the last hundred are kept. So the oldest still reachable is the tenth,
  // and the ten before it are gone for good.
  assert.equal(h.past[0].layers[0].start, 10);
  assert.equal(h.past[H.LIMIT - 1].layers[0].start, H.LIMIT + 9);
});

// ---- V2.1, 21b: the project's size is a gesture too ----

test('a resize is a step of its own', () => {
  const a = { ...state([video()]), width: 1280, height: 720 };
  const b = { ...a, width: 1920, height: 1080 };
  const h = H.commit(H.create(a), b);
  assert.equal(H.canUndo(h), true);
  assert.deepEqual(H.undo(h).present, a);
});

test('a snapshot from before the project had a size says nothing about it', () => {
  // The trap: a project takes its shape from a decoder some time after the
  // layer that asked for it was added and committed, so the step behind the
  // first resize holds no size at all. Reading that as "no size" would make
  // Ctrl+Z either unseed the project or refuse to move.
  const old = state([video()]);
  assert.equal(H.sameState(old, { ...old, width: 0, height: 0 }), true);
  assert.equal(H.sameState(old, { ...old, width: 1920, height: 1080 }), false);
});

test('the width and the height are compared separately', () => {
  const a = { ...state([]), width: 1920, height: 1080 };
  assert.equal(H.sameState(a, { ...a, height: 816 }), false);
  assert.equal(H.sameState(a, { ...a, width: 1440 }), false);
  assert.equal(H.sameState(a, { ...a }), true);
});
