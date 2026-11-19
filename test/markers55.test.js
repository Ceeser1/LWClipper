'use strict';

// V5.5. Timeline markers: the list, and what each gesture makes of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src/markers');

const list = (...times) => K.markersOf(times.map((t, i) => ({ id: 'm' + i, t })));
const times = (markers) => markers.map((m) => m.t);

test('a list is kept sorted, with what is no marker dropped', () => {
  const out = K.markersOf([
    { id: 'b', t: 5 }, { id: 'a', t: 1, name: 'Intro' }, null, { id: '', t: 2 }, { id: 'c', t: -1 },
    { id: 'd', t: 'soon' }, { id: 'a', t: 9 }, { t: 3 }, 'text',
  ]);
  assert.deepEqual(out, [{ id: 'a', t: 1, name: 'Intro' }, { id: 'b', t: 5, name: '' }]);
  assert.deepEqual(K.markersOf(undefined), []);
  assert.deepEqual(K.markersOf({}), []);
});

test('two markers on one moment are one', () => {
  assert.deepEqual(times(K.markersOf([{ id: 'a', t: 2 }, { id: 'b', t: 2.0001 }, { id: 'c', t: 2.01 }])), [2, 2.01]);
});

test('a name is kept to a sensible length', () => {
  const out = K.markersOf([{ id: 'a', t: 1, name: 'x'.repeat(200) }]);
  assert.equal(out[0].name.length, K.NAME_MAX);
});

test('add sets a marker, sorted in, and does nothing where one stands', () => {
  const start = list(1, 5);
  const more = K.add(start, 3, 'new');
  assert.deepEqual(times(more), [1, 3, 5]);
  assert.equal(K.add(more, 3, 'again'), more, 'the same list, so nothing counts as changed');
  assert.equal(K.add(more, 9, 'new'), more, 'an id is not used twice');
  assert.deepEqual(times(K.add([], -4, 'a')), [0], 'never before the start');
});

test('M sets a marker, and pressed again on its frame takes it away', () => {
  const frame = 1 / 30;
  const one = K.toggle([], 2, 'a', frame / 2);
  assert.deepEqual(times(one), [2]);
  assert.deepEqual(K.toggle(one, 2.01, 'b', frame / 2), [], 'within half a frame is on it');
  assert.deepEqual(times(K.toggle(one, 2.1, 'b', frame / 2)), [2, 2.1], 'further off is a second marker');
});

test('remove and rename change only the marker named, and nothing for one that is not there', () => {
  const start = list(1, 5);
  assert.deepEqual(times(K.remove(start, 'm0')), [5]);
  assert.equal(K.remove(start, 'nope'), start);
  const named = K.rename(start, 'm1', '  Chorus  ');
  assert.equal(named[1].name, 'Chorus');
  assert.equal(K.rename(named, 'm1', 'Chorus'), named, 'the same name is no change');
  assert.equal(K.rename(start, 'nope', 'x'), start);
});

test('a moved marker is sorted again, and does not land on another', () => {
  const start = list(1, 5, 9);
  assert.deepEqual(K.move(start, 'm0', 7).map((m) => m.id), ['m1', 'm0', 'm2']);
  assert.equal(K.move(start, 'm0', 5), start);
  assert.equal(K.move(start, 'm0', 1), start);
  assert.deepEqual(times(K.move(start, 'm2', -3)), [0, 1, 5]);
});

test('next and previous step over the marker the playhead is on', () => {
  const m = list(1, 5, 9);
  assert.equal(K.next(m, 0).t, 1);
  assert.equal(K.next(m, 1).t, 5);
  assert.equal(K.next(m, 9), null);
  assert.equal(K.previous(m, 9).t, 5);
  assert.equal(K.previous(m, 5.5).t, 5);
  assert.equal(K.previous(m, 1), null);
});

test('near finds the closest marker within reach', () => {
  const m = list(1, 1.4, 5);
  assert.equal(K.near(m, 1.25, 0.3).t, 1.4);
  assert.equal(K.near(m, 1.15, 0.3).t, 1);
  assert.equal(K.near(m, 3, 0.3), null);
});

test('closing a gap moves the markers after it, and brings one inside it to where it began', () => {
  const m = list(1, 3, 4.5, 6, 10);
  // A gap from 2 to 5 closed whole: three seconds.
  const out = K.ripple(m, [{ from: 2, to: 5, by: 3 }]);
  // 1 stays; 3 and 4.5 were inside and both land on 2 (one is kept); 6 becomes 3; 10 becomes 7.
  assert.deepEqual(times(out), [1, 2, 3, 7]);
});

test('a gap closed only partly moves markers by what it closed', () => {
  const out = K.ripple(list(1, 6), [{ from: 2, to: 5, by: 1.5 }]);
  assert.deepEqual(times(out), [1, 4.5]);
});

test('a gap that did not close leaves the markers as they were', () => {
  const m = list(1, 6);
  assert.equal(K.ripple(m, [{ from: 2, to: 5, by: 0 }]), m);
  assert.equal(K.ripple(m, []), m);
  assert.equal(K.ripple(m, undefined), m);
});

test('several gaps are applied in the order given, latest first as the clips were', () => {
  // Gaps 1 to 3 and 4 to 7, closed latest first.
  const out = K.ripple(list(0.5, 3.5, 8), [{ from: 4, to: 7, by: 3 }, { from: 1, to: 3, by: 2 }]);
  assert.deepEqual(times(out), [0.5, 1.5, 3]);
});

test('room made on the timeline moves the markers from there on with it', () => {
  const m = list(1, 3, 6);
  assert.deepEqual(times(K.insert(m, 3, 2)), [1, 5, 8]);
  assert.equal(K.insert(m, 7, 2), m, 'none that late: the same list');
  assert.equal(K.insert(m, 0, 0), m);
});
