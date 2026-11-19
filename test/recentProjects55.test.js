'use strict';

// V5.5. File > Open recent: the list itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/recentProjects');

test('a project opened goes first', () => {
  assert.deepEqual(R.add(['C:\\a.lwc', 'C:\\b.lwc'], 'C:\\c.lwc'), ['C:\\c.lwc', 'C:\\a.lwc', 'C:\\b.lwc']);
  assert.deepEqual(R.add(null, 'C:\\a.lwc'), ['C:\\a.lwc']);
});

test('one opened again moves to the front and is not listed twice', () => {
  assert.deepEqual(R.add(['C:\\a.lwc', 'C:\\b.lwc', 'C:\\c.lwc'], 'C:\\b.lwc'), ['C:\\b.lwc', 'C:\\a.lwc', 'C:\\c.lwc']);
});

test('the same file spelled in another case or with other slashes is the same file', () => {
  const out = R.add(['C:\\Videos\\Clip.lwc', 'C:\\b.lwc'], 'c:/videos/clip.LWC');
  assert.deepEqual(out, ['c:/videos/clip.LWC', 'C:\\b.lwc'], 'kept as it is spelled now');
});

test('the list holds no more than ten', () => {
  let list = [];
  for (let i = 0; i < 14; i += 1) list = R.add(list, 'C:\\p' + i + '.lwc');
  assert.equal(list.length, R.MAX);
  assert.equal(list[0], 'C:\\p13.lwc');
  assert.equal(list[9], 'C:\\p4.lwc');
});

test('remove takes one out, whatever its spelling', () => {
  assert.deepEqual(R.remove(['C:\\a.lwc', 'C:\\b.lwc'], 'c:/A.LWC'), ['C:\\b.lwc']);
  assert.deepEqual(R.remove(['C:\\a.lwc'], 'C:\\nope.lwc'), ['C:\\a.lwc']);
});

test('what is no path is dropped from a list read back', () => {
  assert.deepEqual(R.listOf(['C:\\a.lwc', '', null, 5, '  ', 'C:\\a.lwc', 'C:\\b.lwc']), ['C:\\a.lwc', 'C:\\b.lwc']);
  assert.deepEqual(R.listOf('C:\\a.lwc'), []);
  assert.deepEqual(R.add(['C:\\a.lwc'], ''), ['C:\\a.lwc']);
});
