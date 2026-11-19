'use strict';

// V5.5. The timeline's markers in the undo stack and in the project file.

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/history');
const P = require('../src/project');
const T = require('../src/timeline');

const clip = (id, start = 0) => T.createLayer({ id, type: 'video', src: id + '.mp4', start, duration: 2, sourceDuration: 10 });
const state = (markers, layers = [clip('a')]) => ({
  layers, start: 0, end: 2, fps: 30, width: 1920, height: 1080, ...(markers === undefined ? {} : { markers }),
});
const mark = (id, t, name = '') => ({ id, t, name });

test('setting a marker is a step, and undo takes it away again', () => {
  const layers = [clip('a')];
  let h = H.create(state([], layers));
  h = H.commit(h, state([mark('m', 1)], layers));
  assert.equal(h.past.length, 1);
  assert.deepEqual(H.undo(h).present.markers, []);
  assert.deepEqual(H.redo(H.undo(h)).present.markers, [mark('m', 1)]);
});

test('the same markers again are no step', () => {
  const layers = [clip('a')];
  const h = H.create(state([mark('m', 1)], layers));
  assert.equal(H.commit(h, state([mark('m', 1)], layers)), h);
});

test('a renamed or moved marker is a step', () => {
  const layers = [clip('a')];
  const h = H.create(state([mark('m', 1)], layers));
  assert.notEqual(H.commit(h, state([mark('m', 1, 'Intro')], layers)), h);
  assert.notEqual(H.commit(h, state([mark('m', 1.5)], layers)), h);
});

test('a snapshot from before markers were part of a step says nothing about them', () => {
  const layers = [clip('a')];
  const old = H.create(state(undefined, layers));
  assert.equal(H.commit(old, state([mark('m', 1)], layers)), old, 'not a change against a step that has no list');
  assert.ok(H.sameState(state(undefined, layers), state([], layers)));
});

test('the stack keeps each step\'s markers through a save and an open', () => {
  const layers = [clip('a')];
  let h = H.create(state([], layers));
  h = H.commit(h, state([mark('m', 1)], layers));
  h = H.commit(h, state([mark('m', 1), mark('n', 1.5, 'Cut')], layers));
  const packed = JSON.parse(JSON.stringify(H.pack(h)));
  assert.deepEqual(packed.steps.map((s) => s.markers.length), [0, 1, 2]);
  const back = H.unpack(packed, state([mark('m', 1), mark('n', 1.5, 'Cut')], layers), (l) => T.createLayer(l));
  assert.equal(back.past.length, 2);
  assert.deepEqual(H.undo(back).present.markers, [mark('m', 1)]);
});

test('a stack saved before 5.5 opens as it was, its steps without a list', () => {
  const layers = [clip('a'), clip('b', 2)];
  let h = H.create(state(undefined, [layers[0]]));
  h = H.commit(h, state(undefined, layers));
  const packed = JSON.parse(JSON.stringify(H.pack(h)));
  assert.ok(packed.steps.every((s) => !('markers' in s)));
  // The project opens with its (empty) list of markers; the old stack still fits it.
  const back = H.unpack(packed, state([], layers), (l) => T.createLayer(l));
  assert.equal(back.past.length, 1);
  assert.equal(H.undo(back).present.markers, undefined);
});

test('a stack whose markers are not the project\'s does not fit, and starts fresh', () => {
  const layers = [clip('a')];
  const h = H.create(state([mark('m', 1)], layers));
  const packed = JSON.parse(JSON.stringify(H.pack(h)));
  const back = H.unpack(packed, state([mark('m', 3)], layers), (l) => T.createLayer(l));
  assert.equal(back.past.length, 0);
});

test('the project file keeps the markers, sorted and cleaned', () => {
  const doc = P.documentOf({
    layers: [], project: { width: 0, height: 0, fps: 0 }, trim: { start: 0, end: 0 },
    markers: [mark('b', 5, 'Outro'), mark('a', 1), { id: 'bad' }, mark('a', 9)],
  });
  assert.deepEqual(doc.markers, [mark('a', 1), mark('b', 5, 'Outro')]);
});

test('markers go through a save and an open, and count as unsaved work', () => {
  const s = {
    layers: [clip('a')], project: { width: 1920, height: 1080, fps: 30 }, trim: { start: 0, end: 2 },
    markers: [mark('m', 1, 'Beat')],
  };
  const back = P.parse(P.stringify(P.serialise(s)));
  assert.ok(back.ok);
  assert.deepEqual(back.doc.markers, [mark('m', 1, 'Beat')]);
  assert.ok(P.sameDocument(s, { ...s }));
  assert.ok(!P.sameDocument(s, { ...s, markers: [] }), 'a marker taken away is a change to the document');
  assert.ok(!P.sameDocument(s, { ...s, markers: [mark('m', 1, 'Drop')] }), 'and so is a name');
});

test('a project written before 5.5 opens with no markers', () => {
  const s = { layers: [clip('a')], project: { width: 1920, height: 1080, fps: 30 }, trim: { start: 0, end: 2 } };
  const written = P.serialise(s);
  delete written.markers;
  const back = P.parse(P.stringify(written));
  assert.ok(back.ok);
  assert.deepEqual(back.doc.markers, []);
  // What the window holds for it is an empty list, which is the same document.
  assert.ok(P.sameDocument(back.doc, { ...back.doc, markers: [] }), 'and is not unsaved work for having none');
  assert.ok(P.sameDocument(back.doc, { ...back.doc, markers: undefined }));
});
