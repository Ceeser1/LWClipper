'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const P = require('../src/project');
const T = require('../src/timeline');

const join = (a, b) => path.win32.join(a, b);

function video(props) {
  return T.createLayer({
    type: 'video', src: 'C:\\clips\\a.mp4', sourceDuration: 60,
    sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

function state(layers, start = 0, end = 60, fps = 30) {
  return { layers, project: { width: 1920, height: 1080, fps }, trim: { start, end } };
}

const stat = (size, mtimeMs) => ({ size, mtimeMs });

// ---- the round trip ----

test('a project round-trips unchanged', () => {
  const s = state([
    video({ start: 2, crop: { x: 0, y: 0, width: 960, height: 540 } }),
    T.createLayer({ type: 'audio', src: 'C:\\clips\\b.mp3', sourceDuration: 30, volume: 0.4 }),
  ], 1, 42);
  const out = P.parse(P.stringify(P.serialise(s)));
  assert.equal(out.ok, true);
  // Back through the model, which is what the renderer does: it is the model
  // that says what a layer is, not the file.
  const back = {
    layers: out.doc.layers.map((l) => T.createLayer(l)),
    project: out.doc.project,
    trim: out.doc.trim,
  };
  assert.equal(P.sameDocument(s, back), true);
});

test('everything a layer carries survives the trip', () => {
  const l = video({
    start: 3, sourceIn: 5, duration: 20, enabled: false, volume: 1.75,
    groupId: 'g1', crop: { x: 2, y: 4, width: 800, height: 600 }, name: 'take one',
  });
  const out = P.parse(P.stringify(P.serialise(state([l]))));
  const back = T.createLayer(out.doc.layers[0]);
  for (const key of Object.keys(l)) {
    assert.deepEqual(back[key], l[key], key);
  }
});

test('the project frame and the trim markers survive', () => {
  const out = P.parse(P.stringify(P.serialise(state([video()], 4.5, 31.25))));
  assert.deepEqual(out.doc.project, { width: 1920, height: 1080, fps: 30 });
  assert.deepEqual(out.doc.trim, { start: 4.5, end: 31.25 });
});

test('every field of the project block comes back, not only the ones parse lists', () => {
  // Step 15 added the frame rate to documentOf and not to parse, which had its
  // own copy of the same object, so the rate was written to the file and
  // dropped on the way back in. parse now goes through documentOf, and this is
  // the test that says the two cannot come apart again: it compares against
  // what documentOf produces rather than against a list written out by hand.
  const s = state([video()], 1, 42, 59.94);
  const out = P.parse(P.stringify(P.serialise(s)));
  assert.deepEqual(out.doc.project, P.documentOf(s).project);
  assert.equal(out.doc.project.fps, 59.94);
});

test('the file says what it is and which version it is', () => {
  const doc = P.serialise(state([video()]));
  assert.equal(doc.format, P.FORMAT);
  assert.equal(doc.version, P.VERSION);
});

// ---- refusing what it should refuse ----

test('a file that is not JSON is refused as such', () => {
  assert.equal(P.parse('not a project at all').error, 'notJson');
});

test('JSON that is not a project is refused', () => {
  assert.equal(P.parse('{"hello":true}').error, 'notProject');
  assert.equal(P.parse('{"format":"something-else","version":1}').error, 'notProject');
});

test('a file from a newer app is refused by name rather than half read', () => {
  const doc = P.serialise(state([video()]));
  doc.version = P.VERSION + 5;
  const out = P.parse(JSON.stringify(doc));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tooNew');
  assert.equal(out.version, P.VERSION + 5);
});

test('an older file opens, with defaults for what it does not carry', () => {
  // The additive-only rule from the other side: version 1 with no trim block
  // and no project block at all.
  const old = { format: P.FORMAT, version: 1, layers: [{ id: 'x', type: 'video', src: 'a.mp4' }] };
  const out = P.parse(JSON.stringify(old));
  assert.equal(out.ok, true);
  assert.deepEqual(out.doc.project, { width: 0, height: 0, fps: 0 });
  assert.deepEqual(out.doc.trim, { start: 0, end: 0 });
  assert.equal(out.doc.layers.length, 1);
});

// ---- fingerprints ----

test('a reference carries size, mtime and duration', () => {
  const l = video();
  const doc = P.serialise(state([l]), { stats: { [l.src]: stat(1234, 99000) } });
  assert.deepEqual(doc.layers[0].ref, {
    path: l.src, relative: undefined, size: 1234, mtime: 99000, duration: 60,
  });
});

test('the same file reads as the same file', () => {
  const ref = { size: 1234, mtime: 99000 };
  assert.equal(P.fingerprintMatches(ref, stat(1234, 99000)), true);
});

test('a file replaced at the same path does not', () => {
  const ref = { size: 1234, mtime: 99000 };
  assert.equal(P.fingerprintMatches(ref, stat(1234, 99001)), false, 'rewritten');
  assert.equal(P.fingerprintMatches(ref, stat(1235, 99000)), false, 'resized');
});

test('a fractional mtime is rounded on both sides so it cannot drift', () => {
  const l = video();
  const doc = P.serialise(state([l]), { stats: { [l.src]: stat(10, 1700000000123.7) } });
  assert.equal(P.fingerprintMatches(doc.layers[0].ref, stat(10, 1700000000123.7)), true);
});

// ---- where the file might be ----

test('the relative path is tried before the one it was saved at', () => {
  const ref = { path: 'C:\\old\\a.mp4', relative: 'media\\a.mp4' };
  assert.deepEqual(P.candidatesFor(ref, 'D:\\new', join),
    ['D:\\new\\media\\a.mp4', 'C:\\old\\a.mp4']);
});

test('a reference with no relative path still has one candidate', () => {
  assert.deepEqual(P.candidatesFor({ path: 'C:\\a.mp4' }, 'D:\\new', join), ['C:\\a.mp4']);
});

test('a project and its media moved together are found at the relative path', () => {
  const ref = { path: 'C:\\old\\a.mp4', relative: 'a.mp4', size: 10, mtime: 5 };
  const out = P.statusFor(ref, [
    { path: 'D:\\new\\a.mp4', stat: stat(10, 5) },
    { path: 'C:\\old\\a.mp4', stat: null },
  ]);
  assert.deepEqual(out, { state: 'ok', path: 'D:\\new\\a.mp4' });
});

test('a matching file wins over a nearer one that does not match', () => {
  // The project moved but the media did not, and something unrelated now sits
  // where the media would have been. Preferring the relative path must not
  // cost the real file.
  const ref = { path: 'C:\\old\\a.mp4', relative: 'a.mp4', size: 10, mtime: 5 };
  const out = P.statusFor(ref, [
    { path: 'D:\\new\\a.mp4', stat: stat(999, 999) },
    { path: 'C:\\old\\a.mp4', stat: stat(10, 5) },
  ]);
  assert.deepEqual(out, { state: 'ok', path: 'C:\\old\\a.mp4' });
});

test('a file that is there but is not the one saved reads as replaced', () => {
  const ref = { path: 'C:\\old\\a.mp4', size: 10, mtime: 5 };
  const out = P.statusFor(ref, [{ path: 'C:\\old\\a.mp4', stat: stat(11, 5) }]);
  assert.deepEqual(out, { state: 'replaced', path: 'C:\\old\\a.mp4' });
});

test('a file that is nowhere reads as missing', () => {
  const ref = { path: 'C:\\old\\a.mp4', size: 10, mtime: 5 };
  assert.deepEqual(P.statusFor(ref, [{ path: 'C:\\old\\a.mp4', stat: null }]),
    { state: 'missing', path: 'C:\\old\\a.mp4' });
});

// ---- what the modal is given, and what Continue does ----

test('every layer in trouble is listed, and the rest are pointed at their file', () => {
  const a = video({ id: 'a', src: 'C:\\old\\a.mp4', name: 'a' });
  const b = video({ id: 'b', src: 'C:\\old\\b.mp4', name: 'b' });
  const c = video({ id: 'c', src: 'C:\\old\\c.mp4', name: 'c' });
  const doc = {
    project: { width: 1920, height: 1080 },
    trim: { start: 0, end: 60 },
    layers: [a, b, c].map((l) => ({ ...l, ref: { path: l.src, size: 1, mtime: 1 } })),
  };
  const out = P.applyStatuses(doc, {
    a: { state: 'ok', path: 'D:\\new\\a.mp4' },
    b: { state: 'missing', path: null },
    c: { state: 'replaced', path: 'C:\\old\\c.mp4' },
  });
  assert.equal(out.layers[0].src, 'D:\\new\\a.mp4', 'a good one follows its file');
  assert.deepEqual(out.trouble.map((t) => [t.id, t.state]), [['b', 'missing'], ['c', 'replaced']]);
  // Nothing is dropped here: the modal has to name them before anyone decides.
  assert.equal(out.layers.length, 3);
});

test('Continue drops exactly the tracks that were listed', () => {
  const layers = [video({ id: 'a' }), video({ id: 'b' }), video({ id: 'c' })];
  const kept = P.pruneTrouble(layers, [{ id: 'b' }]);
  assert.deepEqual(kept.map((l) => l.id), ['a', 'c']);
});

test('a project with nothing wrong raises nothing', () => {
  const l = video({ id: 'a' });
  const out = P.applyStatuses(
    { project: {}, trim: {}, layers: [{ ...l, ref: { path: l.src } }] },
    { a: { state: 'ok', path: l.src } });
  assert.deepEqual(out.trouble, []);
});

// ---- the dirty flag ----

test('the document compares equal to a copy of itself', () => {
  const s = state([video({ start: 3 })], 1, 20);
  assert.equal(P.sameDocument(s, { ...s, layers: s.layers.map((l) => ({ ...l })) }), true);
});

test('a volume change counts as a change to the document', () => {
  // Undo deliberately ignores volume; the file does not, so the dirty flag
  // cannot be the undo comparison.
  const l = video({ volume: 1 });
  assert.equal(P.sameDocument(state([l]), state([{ ...l, volume: 0.5 }])), false);
});

test('an Enabled tick counts too', () => {
  const l = video();
  assert.equal(P.sameDocument(state([l]), state([{ ...l, enabled: false }])), false);
});

test('moving a trim marker counts', () => {
  const l = video();
  assert.equal(P.sameDocument(state([l], 0, 60), state([l], 0, 30)), false);
});

test('a reorder counts', () => {
  const a = video({ id: 'a' });
  const b = video({ id: 'b' });
  assert.equal(P.sameDocument(state([a, b]), state([b, a])), false);
});

test('the project frame counts', () => {
  const s = state([video()]);
  assert.equal(P.sameDocument(s, { ...s, project: { width: 1280, height: 720 } }), false);
});

test('the project rate goes in the file, and an older file without one reads as zero', () => {
  // Step 15, and the version rule at work: a field added rather than a name
  // repurposed, so a file written before it existed still opens.
  const doc = P.documentOf({
    project: { width: 1920, height: 1080, fps: 29.97 }, trim: {}, layers: [],
  });
  assert.equal(doc.project.fps, 29.97);
  const old = P.documentOf({ project: { width: 1920, height: 1080 }, trim: {}, layers: [] });
  assert.equal(old.project.fps, 0);
});

test('changing only the project rate is a change to the document', () => {
  const a = { project: { width: 1920, height: 1080, fps: 30 }, trim: {}, layers: [] };
  const b = { project: { width: 1920, height: 1080, fps: 60 }, trim: {}, layers: [] };
  assert.ok(!P.sameDocument(a, b));
  assert.ok(P.sameDocument(a, { ...a }));
});

// ---- the metadata, which is not the document ----

test('a project carries the name it was saved under', () => {
  const out = P.parse(P.stringify(P.serialise(state([video()]), { name: 'holiday' })));
  assert.equal(out.ok, true);
  assert.equal(out.meta.name, 'holiday');
});

test('the metadata is its own block, not part of the document', () => {
  // Step 18 put the name in the file. If it had gone into documentOf instead,
  // this would be false: saving a project under a new name would count as
  // changing the project, and the dirty dot would never go out.
  const s = state([video()]);
  const a = P.parse(P.stringify(P.serialise(s, { name: 'first' })));
  const b = P.parse(P.stringify(P.serialise(s, { name: 'second' })));
  assert.equal(P.sameDocument(a.doc, b.doc), true);
  assert.equal('name' in a.doc, false);
});

test('every metadata field written comes back', () => {
  // The Step 15 lesson applied to the new block: serialise spreads metaOf and
  // parse returns metaOf, so the two cannot describe different sets.
  const doc = P.serialise(state([video()]), { app: '9.9.9', name: 'x' });
  const out = P.parse(P.stringify(doc));
  for (const k of Object.keys(P.metaOf(doc))) {
    assert.equal(out.meta[k], doc[k], 'field kept: ' + k);
  }
  assert.ok(out.meta.savedAt);
});

test('a project saved before Step 18 reads as having no name', () => {
  // The additive-only rule from the other side, for the field Step 18 added.
  const old = { format: P.FORMAT, version: 1, layers: [] };
  const out = P.parse(JSON.stringify(old));
  assert.equal(out.ok, true);
  assert.equal(out.meta.name, '');
  assert.equal(out.meta.app, '');
});
