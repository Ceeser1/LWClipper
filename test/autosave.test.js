'use strict';

// V3.6.1. Auto-save and crash restore: the rules in src/autosave.js and the
// block src/project.js writes into an auto-save.

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/autosave');
const P = require('../src/project');
const T = require('../src/timeline');

function state() {
  return {
    layers: [T.createLayer({ type: 'video', src: 'C:\\clips\\a.mp4', sourceDuration: 60, sourceWidth: 1920, sourceHeight: 1080 })],
    project: { width: 1920, height: 1080, fps: 30 },
    trim: { start: 0, end: 60 },
  };
}

// ---- the user's numbers ----

test('every three minutes, five kept', () => {
  assert.equal(A.EVERY_MS, 180000);
  assert.equal(A.KEEP, 5);
});

// ---- names ----

test('an auto-save is named by local time to the second, then the project', () => {
  const at = new Date(2026, 10, 5, 9, 4, 7);
  assert.equal(A.fileNameFor(at, 'My Project'), '2026-11-05 09-04-07 My Project.lwc');
  assert.equal(A.fileNameFor(at, ''), '2026-11-05 09-04-07 Project.lwc');
});

test('names in time order sort in that order', () => {
  const names = [new Date(2026, 0, 2, 10, 0, 0), new Date(2025, 11, 31, 23, 59, 59), new Date(2026, 0, 2, 9, 59, 59)]
    .map((d) => A.fileNameFor(d, 'x'));
  assert.deepEqual([...names].sort(), [names[1], names[2], names[0]]);
});

test('a marker name comes back to its id, and nothing else reads as one', () => {
  const id = A.newSessionId(1762337000000, 4242);
  assert.equal(A.markerId(A.markerName(id)), id);
  assert.equal(A.markerId('2026-11-05 09-04-07 x.lwc'), null);
  assert.equal(A.markerId('session-.json'), null);
  assert.equal(A.markerId('session-abc.json.tmp'), null);
});

test('a marker reads back, and junk does not', () => {
  const m = A.markerOf(JSON.stringify({ id: 'a1', pid: 77, startedAt: '2026-11-05T10:00:00.000Z' }));
  assert.deepEqual(m, { id: 'a1', pid: 77, startedAt: '2026-11-05T10:00:00.000Z' });
  assert.equal(A.markerOf('{'), null);
  assert.equal(A.markerOf('{"pid": 4}'), null);
  assert.equal(A.markerOf(JSON.stringify({ id: 'b', pid: -3 })).pid, 0);
});

// ---- telling a crash from a clean exit ----

test('a marker whose process has gone is a crash', () => {
  const alive = new Set([10, 30]);
  const markers = [{ id: 'own', pid: 10 }, { id: 'gone', pid: 20 }, { id: 'second window', pid: 30 }, { id: 'no pid', pid: 0 }];
  assert.deepEqual(A.crashedSessions(markers, (p) => alive.has(p), 'own'), ['gone', 'no pid']);
});

test('this run is never its own crash, even when its process cannot be found', () => {
  assert.deepEqual(A.crashedSessions([{ id: 'own', pid: 99 }], () => false, 'own'), []);
});

// ---- keeping five ----

const entry = (file, savedAt, session = 's') => ({ file, savedAt, session });

test('the five newest are kept, whichever run wrote them', () => {
  const all = [1, 2, 3, 4, 5, 6, 7].map((n) => entry('f' + n, '2026-11-05T10:0' + n + ':00.000Z', n % 2 ? 'a' : 'b'));
  assert.deepEqual(A.toPrune(all).map((e) => e.file), ['f2', 'f1']);
  assert.deepEqual(A.toPrune(all.slice(0, 5)), []);
});

test('a tie on the time falls to the file name', () => {
  const at = '2026-11-05T10:00:00.000Z';
  const order = A.newestFirst([entry('x (2).lwc', at), entry('x (3).lwc', at), entry('x.lwc', at)]);
  assert.equal(order[0].file, 'x.lwc');
});

// ---- what a crash offers ----

test('only the crashed runs\' auto-saves are offered, newest first', () => {
  const all = [
    entry('old', '2026-11-04T10:00:00.000Z', 'clean'),
    entry('c1', '2026-11-05T10:00:00.000Z', 'crashed'),
    entry('c2', '2026-11-05T10:03:00.000Z', 'crashed'),
  ];
  assert.deepEqual(A.restorable(all, ['crashed']).map((e) => e.file), ['c2', 'c1']);
  assert.deepEqual(A.restorable(all, []), []);
});

// ---- the block in the file ----

test('an auto-save carries its run and the project it is a copy of', () => {
  const origin = { path: 'C:\\work\\film.lwc', name: 'film' };
  const back = P.parse(P.stringify(P.serialise(state(), { autosave: { session: 'run1', origin } })));
  assert.equal(back.ok, true);
  assert.deepEqual(back.autosave, { session: 'run1', origin });
});

test('a copy of a project never saved has no origin', () => {
  const back = P.parse(P.stringify(P.serialise(state(), { autosave: { session: 'run1', origin: null } })));
  assert.deepEqual(back.autosave, { session: 'run1', origin: null });
});

test('a project the user saves has no auto-save block at all', () => {
  const text = P.stringify(P.serialise(state()));
  assert.equal(JSON.parse(text).autosave, undefined);
  assert.equal(P.parse(text).autosave, null);
});

test('the block is not part of the document, so it is never an unsaved change', () => {
  const s = state();
  const copy = P.parse(P.stringify(P.serialise(s, { autosave: { session: 'r', origin: null } })));
  // Through the model, as adoptProject builds them, which drops the ref.
  const layers = copy.doc.layers.map((l) => T.createLayer(l));
  assert.equal(P.sameDocument({ ...copy.doc, layers }, s), true);
});

test('a block that is not one reads as none', () => {
  assert.equal(P.autosaveOf(null), null);
  assert.equal(P.autosaveOf({ origin: { path: 'C:\\a.lwc' } }), null);
  assert.equal(P.autosaveOf([]), null);
  assert.deepEqual(P.autosaveOf({ session: 's', origin: { name: 'no path' } }), { session: 's', origin: null });
});
