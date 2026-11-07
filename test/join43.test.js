'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/timeline');

const clip = (id, start, duration, extra = {}) => M.createLayer({
  id, type: 'video', src: id + '.mp4', start, duration, sourceDuration: 100, lane: 0, ...extra,
});
const sound = (id, start, duration, extra = {}) => M.createLayer({
  id, type: 'audio', src: id + '.mp3', start, duration, sourceDuration: 100, lane: 0, ...extra,
});
const byId = (layers, id) => layers.find((l) => l.id === id);

test('createLayer keeps a join id and drops nonsense', () => {
  assert.equal(clip('a', 0, 1, { joinId: 'jx' }).joinId, 'jx');
  assert.equal(clip('a', 0, 1).joinId, null);
  assert.equal(clip('a', 0, 1, { joinId: 5 }).joinId, null);
});

test('join closes the gap, marks both pieces and takes the seam fades off', () => {
  const layers = [clip('a', 0, 2, { fadeOut: 0.5, fadeIn: 0.3 }), clip('b', 5, 3, { fadeIn: 0.5, fadeOut: 0.4 })];
  const out = M.join(layers, ['a', 'b']);
  const a = byId(out, 'a');
  const b = byId(out, 'b');
  assert.ok(a.joinId);
  assert.equal(a.joinId, b.joinId);
  assert.equal(b.start, 2);
  assert.equal(a.fadeOut, 0);
  assert.equal(b.fadeIn, 0);
  // The outer fades stay.
  assert.equal(a.fadeIn, 0.3);
  assert.equal(b.fadeOut, 0.4);
});

test('a piece slid by a join takes its grouped sound with it', () => {
  const layers = [
    clip('a', 0, 2), clip('b', 5, 3, { groupId: 'g1' }), sound('s', 5, 3, { groupId: 'g1' }),
  ];
  const out = M.join(layers, ['a', 'b']);
  assert.equal(byId(out, 'b').start, 2);
  assert.equal(byId(out, 's').start, 2);
  assert.equal(byId(out, 's').joinId, null);
});

test('joinCheck names why clips cannot be joined', () => {
  const two = [clip('a', 0, 2), clip('b', 3, 2, { lane: 1 })];
  assert.equal(M.joinCheck(two, ['a', 'b']).reason, 'rows');
  assert.equal(M.joinCheck(two, ['a']).reason, 'few');
  const between = [clip('a', 0, 2), clip('m', 2.5, 1), clip('b', 4, 2)];
  assert.equal(M.joinCheck(between, ['a', 'b']).reason, 'between');
  assert.equal(M.joinCheck(between, ['a', 'm', 'b']).ok, true);
  const text = [clip('a', 0, 2), M.createLayer({ id: 't', kind: 'gen', gen: { form: 'text' }, start: 3, duration: 2, lane: 0 })];
  assert.equal(M.joinCheck(text, ['a', 't']).reason, 'kind');
  const mixed = [clip('a', 0, 2), sound('b', 3, 2)];
  assert.equal(M.joinCheck(mixed, ['a', 'b']).reason, 'rows');
});

test('an image joins a video on its row', () => {
  const layers = [clip('a', 0, 2), M.createLayer({ id: 'p', type: 'video', kind: 'image', src: 'p.png', start: 4, duration: 3, lane: 0 })];
  const out = M.join(layers, ['a', 'p']);
  assert.equal(byId(out, 'p').joinId, byId(out, 'a').joinId);
  assert.equal(byId(out, 'p').start, 2);
});

test('a joined clip is one more piece when joined again, under the first id', () => {
  let layers = M.join([clip('a', 0, 2), clip('b', 2, 2), clip('c', 6, 1)], ['a', 'b']);
  const id = byId(layers, 'a').joinId;
  layers = M.join(layers, ['b', 'c']);
  assert.deepEqual(M.joinOf(layers, 'c').map((l) => l.id), ['a', 'b', 'c']);
  assert.equal(byId(layers, 'c').joinId, id);
  assert.equal(byId(layers, 'c').start, 4);
});

test('joinPlace says where a piece sits', () => {
  const layers = M.join([clip('a', 0, 1), clip('b', 1, 1), clip('c', 2, 1)], ['a', 'b', 'c']);
  assert.equal(M.joinPlace(layers, byId(layers, 'a')), 'first');
  assert.equal(M.joinPlace(layers, byId(layers, 'b')), 'mid');
  assert.equal(M.joinPlace(layers, byId(layers, 'c')), 'last');
  assert.equal(M.joinPlace(layers, clip('z', 9, 1)), null);
});

test('moving one piece moves the whole join and every piece group', () => {
  let layers = [clip('a', 0, 2, { groupId: 'g' }), sound('s', 0, 2, { groupId: 'g' }), clip('b', 2, 2)];
  layers = M.join(layers, ['a', 'b']);
  const out = M.moveGroup(layers, 'b', 5);
  assert.equal(byId(out, 'a').start, 3);
  assert.equal(byId(out, 'b').start, 5);
  assert.equal(byId(out, 's').start, 3);
  const set = M.moveSet(layers, ['b'], 'b', 4);
  assert.equal(byId(set, 'a').start, 2);
  assert.equal(byId(set, 's').start, 2);
});

test('unjoin takes the flag off and leaves the pieces where they are', () => {
  const layers = M.join([clip('a', 0, 2), clip('b', 3, 2)], ['a', 'b']);
  const out = M.unjoin(layers, byId(layers, 'a').joinId);
  assert.equal(byId(out, 'a').joinId, null);
  assert.equal(byId(out, 'b').joinId, null);
  assert.equal(byId(out, 'b').start, 2);
});

test('normalizeJoins breaks a join where its pieces stopped meeting', () => {
  const layers = [
    clip('a', 0, 1, { joinId: 'j' }), clip('b', 1, 1, { joinId: 'j' }),
    clip('c', 5, 1, { joinId: 'j' }), clip('d', 6, 1, { joinId: 'j' }), clip('e', 9, 1, { joinId: 'j' }),
  ];
  const out = M.normalizeJoins(layers);
  assert.equal(byId(out, 'a').joinId, 'j');
  assert.equal(byId(out, 'b').joinId, 'j');
  assert.ok(byId(out, 'c').joinId && byId(out, 'c').joinId !== 'j');
  assert.equal(byId(out, 'c').joinId, byId(out, 'd').joinId);
  assert.equal(byId(out, 'e').joinId, null);
  // Nothing to fix hands the same list back.
  const fine = M.join([clip('a', 0, 1), clip('b', 3, 1)], ['a', 'b']);
  assert.equal(M.normalizeJoins(fine), fine);
});

test('normalizeJoins drops a join left with one piece', () => {
  const out = M.normalizeJoins([clip('a', 0, 1, { joinId: 'j' })]);
  assert.equal(out[0].joinId, null);
});

test('a split at a seam takes the join apart there', () => {
  const layers = M.join([clip('a', 0, 2), clip('b', 2, 2), clip('c', 4, 2)], ['a', 'b', 'c']);
  const out = M.splitJoinAt(layers, 'a', 4);
  assert.equal(out.length, 3);
  assert.equal(byId(out, 'a').joinId, byId(out, 'b').joinId);
  assert.equal(byId(out, 'c').joinId, null);
});

test('a split inside a piece cuts it and leaves two joined clips', () => {
  const layers = M.join([clip('a', 0, 2), clip('b', 2, 2), clip('c', 4, 2), clip('d', 6, 2)], ['a', 'b', 'c', 'd']);
  const out = M.splitJoinAt(layers, 'a', 5);
  assert.equal(out.length, 5);
  const left = M.joinOf(out, 'a').map((l) => l.id);
  assert.deepEqual(left.slice(0, 2), ['a', 'b']);
  assert.equal(left.length, 3);
  const right = M.joinOf(out, 'd');
  assert.equal(right.length, 2);
  assert.equal(right[0].start, 5);
  assert.notEqual(byId(out, 'a').joinId, byId(out, 'd').joinId);
});

test('splitLayer on a piece breaks the join at the cut too', () => {
  const layers = M.join([clip('a', 0, 2), clip('b', 2, 2)], ['a', 'b']);
  const out = M.splitLayer(layers, 'b', 3);
  assert.equal(byId(out, 'a').joinId, byId(out, 'b').joinId);
  const right = out.find((l) => l.start === 3);
  assert.equal(right.joinId, null);
});

test('a copied join pastes as a new join on one row', () => {
  const layers = M.join([clip('a', 0, 2), clip('b', 2, 2)], ['a', 'b']);
  const copy = M.copyOf(layers, 'b');
  assert.equal(copy.items.length, 2);
  const out = M.pasteInto(layers, copy, 10, 1);
  const pasted = out.filter((l) => l.id !== 'a' && l.id !== 'b');
  assert.equal(pasted.length, 2);
  assert.ok(pasted[0].joinId);
  assert.equal(pasted[0].joinId, pasted[1].joinId);
  assert.notEqual(pasted[0].joinId, byId(out, 'a').joinId);
  assert.equal(pasted[0].lane, pasted[1].lane);
  assert.deepEqual(pasted.map((l) => l.start).sort((x, y) => x - y), [8, 10]);
});

test('a copy of one group still pastes as one group', () => {
  const layers = [clip('a', 0, 2, { groupId: 'g' }), sound('s', 0, 2, { groupId: 'g' })];
  const out = M.pasteInto(layers, M.copyOf(layers, 'a'), 5);
  const pasted = out.filter((l) => l.id !== 'a' && l.id !== 's');
  assert.equal(pasted.length, 2);
  assert.ok(pasted[0].groupId && pasted[0].groupId !== 'g');
  assert.equal(pasted[0].groupId, pasted[1].groupId);
});

test('a merged project keeps its joins under new ids', () => {
  const mine = M.join([clip('a', 0, 2), clip('b', 2, 2)], ['a', 'b']);
  const { layers } = M.mergeLayers(mine, mine, { video: 1, audio: 0 });
  const added = layers.filter((l) => l.id !== 'a' && l.id !== 'b');
  assert.equal(added.length, 2);
  assert.equal(added[0].joinId, added[1].joinId);
  assert.notEqual(added[0].joinId, byId(layers, 'a').joinId);
});

test('a join survives the project file', () => {
  const P = require('../src/project');
  const layers = M.join([clip('a', 0, 2), clip('b', 4, 2)], ['a', 'b']);
  const doc = P.serialise({ layers, project: { width: 640, height: 360, fps: 30 }, trim: { start: 0, end: 4 } });
  const back = P.parse(P.stringify(doc)).doc.layers.map((l) => M.createLayer(l));
  assert.equal(byId(back, 'a').joinId, byId(layers, 'a').joinId);
  assert.equal(byId(back, 'b').joinId, byId(layers, 'a').joinId);
  assert.equal(byId(back, 'b').start, 2);
});
