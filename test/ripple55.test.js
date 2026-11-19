'use strict';

// V5.5. Delete and close the gap: what moves, by how much, and what stops it.

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/timeline');

const clip = (id, start, duration, extra = {}) => M.createLayer({
  id, type: 'video', src: id + '.mp4', start, duration, sourceDuration: 100, lane: 0, ...extra,
});
const sound = (id, start, duration, extra = {}) => M.createLayer({
  id, type: 'audio', src: id + '.mp3', start, duration, sourceDuration: 100, lane: 0, ...extra,
});
const starts = (layers) => Object.fromEntries(layers.map((l) => [l.id, l.start]));

test('what follows on the row moves left by the length of the clip taken out', () => {
  const layers = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 1), clip('d', 6, 2)];
  const out = M.rippleRemove(layers, ['b']);
  assert.deepEqual(starts(out.layers), { a: 0, c: 2, d: 3 });
  assert.equal(out.closed, 3);
  assert.equal(out.wanted, 3);
});

test('every row moves by the same shift, so later clips stay in step with each other', () => {
  const layers = [
    clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 4),
    clip('title', 6, 2, { lane: 1 }), sound('music', 5.5, 10),
  ];
  const out = M.rippleRemove(layers, ['b']);
  assert.deepEqual(starts(out.layers), { a: 0, c: 2, title: 3, music: 2.5 });
});

test('a clip that starts before the gap ends does not move, whatever row it is on', () => {
  const layers = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 1), sound('early', 1, 2)];
  const out = M.rippleRemove(layers, ['b']);
  assert.equal(starts(out.layers).early, 1);
  assert.equal(starts(out.layers).c, 2);
});

test('a clip on another row that runs through the gap holds back what follows it', () => {
  // The music runs from 1 to 4.5, through the gap from 2 to 5. The next sound starts at 6.
  const layers = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 1), sound('music', 1, 3.5), sound('next', 6, 2)];
  const out = M.rippleRemove(layers, ['b']);
  // The sound row can give 1.5 (6 less 4.5), so everything moves by 1.5 and not by 3.
  assert.equal(out.closed, 1.5);
  assert.equal(out.wanted, 3);
  assert.deepEqual(starts(out.layers), { a: 0, c: 3.5, music: 1, next: 4.5 });
});

test('a clip running on past the gap with something already over its end stops the closing', () => {
  // `long` runs 0 to 8 on the second row and `over` crossfades into its end from 7.
  const layers = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 1), clip('long', 0, 8, { lane: 1 }), clip('over', 7, 3, { lane: 1 })];
  const out = M.rippleRemove(layers, ['b']);
  assert.equal(out.closed, 0);
  assert.deepEqual(starts(out.layers), { a: 0, c: 5, long: 0, over: 7 });
  assert.equal(out.layers.length, 4, 'the clip is still taken out');
});

test('a gap that was there before the clip is left alone: only the clip\'s own length closes', () => {
  const layers = [clip('a', 0, 1), clip('b', 3, 2), clip('c', 6, 1)];
  const out = M.rippleRemove(layers, ['b']);
  assert.deepEqual(starts(out.layers), { a: 0, c: 4 });
});

test('the first clip taken out brings the rest to the start', () => {
  const layers = [clip('a', 0, 2), clip('b', 2, 3)];
  assert.deepEqual(starts(M.rippleRemove(layers, ['a']).layers), { b: 0 });
});

test('a video and its sound taken out together close as one gap', () => {
  const layers = [
    clip('v1', 0, 2), clip('v2', 2, 3, { groupId: 'g' }), clip('v3', 5, 2),
    sound('s1', 0, 2), sound('s2', 2, 3, { groupId: 'g' }), sound('s3', 5, 2),
  ];
  const out = M.rippleRemove(layers, ['v2', 's2']);
  assert.deepEqual(starts(out.layers), { v1: 0, v3: 2, s1: 0, s3: 2 });
  assert.equal(out.closed, 3);
});

test('clips taken out in two places close both gaps', () => {
  const layers = [clip('a', 0, 1), clip('b', 1, 2), clip('c', 3, 1), clip('d', 4, 3), clip('e', 7, 1)];
  const out = M.rippleRemove(layers, ['b', 'd']);
  assert.deepEqual(starts(out.layers), { a: 0, c: 1, e: 2 });
  assert.equal(out.closed, 5);
  assert.equal(out.wanted, 5);
});

test('each gap and how far it closed is handed back, latest first, for the markers to follow', () => {
  const layers = [clip('a', 0, 1), clip('b', 1, 2), clip('c', 3, 1), clip('d', 4, 3), clip('e', 7, 1)];
  const out = M.rippleRemove(layers, ['b', 'd']);
  assert.deepEqual(out.shifts, [{ from: 4, to: 7, by: 3 }, { from: 1, to: 3, by: 2 }]);
  assert.deepEqual(M.rippleRemove(layers, ['nope']).shifts, []);
});

test('two clips that touch or overlap are one gap, not two', () => {
  const layers = [clip('a', 0, 1), clip('b', 1, 2), clip('c', 2.5, 2, { lane: 1 }), clip('d', 5, 1)];
  const out = M.rippleRemove(layers, ['b', 'c']);
  // One span from 1 to 4.5.
  assert.equal(out.wanted, 3.5);
  assert.deepEqual(starts(out.layers), { a: 0, d: 1.5 });
});

test('the last clip leaves nothing to move, and an id that is not there changes nothing', () => {
  const layers = [clip('a', 0, 2), clip('b', 2, 3)];
  const out = M.rippleRemove(layers, ['b']);
  assert.deepEqual(starts(out.layers), { a: 0 });
  const same = M.rippleRemove(layers, ['nope']);
  assert.equal(same.layers, layers);
  assert.equal(same.closed, 0);
});

test('a crossfade between two later clips is kept as it was', () => {
  const layers = [clip('a', 0, 2), clip('b', 2, 2), clip('c', 4, 3), clip('d', 6, 3)];
  const out = M.rippleRemove(layers, ['b']);
  const s = starts(out.layers);
  assert.equal(s.c, 2);
  assert.equal(s.d, 4);
  assert.equal(M.endOf(out.layers.find((l) => l.id === 'c')) - s.d, 1, 'still one second over each other');
});

test('the list handed in is not written to', () => {
  const layers = [clip('a', 0, 2), clip('b', 2, 3), clip('c', 5, 1)];
  const before = JSON.stringify(layers);
  M.rippleRemove(layers, ['b']);
  assert.equal(JSON.stringify(layers), before);
});

// ---- room made, the other way round ----

test('room made at a moment moves everything from there on right, on every row', () => {
  const layers = [clip('a', 0, 2), clip('b', 2, 3), clip('t', 2, 1, { lane: 1 }), sound('m', 3, 4), sound('early', 0, 1)];
  const out = M.rippleInsert(layers, 2, 1.5);
  assert.deepEqual(starts(out), { a: 0, b: 3.5, t: 3.5, m: 4.5, early: 0 });
});

test('a clip that starts before the moment stays, even when it runs through it', () => {
  const layers = [clip('long', 0, 10), clip('after', 4, 2, { lane: 1 })];
  assert.deepEqual(starts(M.rippleInsert(layers, 3, 2)), { long: 0, after: 6 });
});

test('no room asked for, or nothing that late, is the same list', () => {
  const layers = [clip('a', 0, 2)];
  assert.equal(M.rippleInsert(layers, 5, 2), layers);
  assert.equal(M.rippleInsert(layers, 0, 0), layers);
  assert.equal(M.rippleInsert(layers, 0, -3), layers);
});

test('closing a gap undoes the room made for it', () => {
  const layers = [clip('a', 0, 2), clip('b', 2, 3), sound('m', 2.5, 4)];
  const wide = M.rippleInsert(layers, 2, 2);
  const filled = [...wide, clip('still', 2, 2)];
  assert.deepEqual(starts(M.rippleRemove(filled, ['still']).layers), starts(layers));
});
