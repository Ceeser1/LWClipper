'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/keyBinds');

const DEFAULTS = {
  'edit.undo': ['Ctrl+Z'],
  'edit.redo': ['Ctrl+Y', 'Ctrl+Shift+Z'],
  'edit.copy': ['Ctrl+C'],
  'edit.split': ['S'],
};

test('Escape and Enter on their own cannot be bound, with a modifier they can', () => {
  assert.equal(B.bindable('Escape'), false);
  assert.equal(B.bindable('Enter'), false);
  assert.equal(B.bindable('Ctrl+Enter'), true);
  assert.equal(B.bindable('S'), true);
  assert.equal(B.bindable(''), false);
  assert.equal(B.bindable(null), false);
});

test('sanitize keeps known ids, puts combos in one form and drops the rest', () => {
  const out = B.sanitize({
    'edit.copy': ['shift + ctrl + c', 'Ctrl+Shift+C', 'Escape'],
    'edit.nothing': ['X'],
    'edit.split': 'S',
    'edit.undo': [],
  }, Object.keys(DEFAULTS));
  assert.deepEqual(out, { 'edit.copy': ['Ctrl+Shift+C'] });
});

test('sanitize answers an empty object for anything that is not one', () => {
  assert.deepEqual(B.sanitize(null, ['a']), {});
  assert.deepEqual(B.sanitize([['a']], ['a']), {});
  assert.deepEqual(B.sanitize('x', ['a']), {});
});

test('resolve takes the saved keys and the defaults for the rest', () => {
  const out = B.resolve(DEFAULTS, { 'edit.copy': ['Ctrl+Shift+C'] });
  assert.deepEqual(out['edit.copy'], ['Ctrl+Shift+C']);
  assert.deepEqual(out['edit.redo'], ['Ctrl+Y', 'Ctrl+Shift+Z']);
  assert.deepEqual(out['edit.split'], ['S']);
});

test('resolve never gives one key to two actions', () => {
  const out = B.resolve(DEFAULTS, { 'edit.undo': ['S'] });
  assert.deepEqual(out['edit.undo'], ['S']);
  assert.deepEqual(out['edit.split'], []);
});

test('holder names the other action with the key, not the one asking', () => {
  const now = B.resolve(DEFAULTS, {});
  assert.equal(B.holder(now, 'edit.copy', 'Ctrl+Shift+Z'), 'edit.redo');
  assert.equal(B.holder(now, 'edit.redo', 'Ctrl+Shift+Z'), null);
  assert.equal(B.holder(now, 'edit.copy', 'Ctrl+Q'), null);
});

test('changes lists only what differs from the defaults', () => {
  const now = B.resolve(DEFAULTS, { 'edit.copy': ['Ctrl+Shift+C'] });
  assert.deepEqual(B.changes(DEFAULTS, now), { 'edit.copy': ['Ctrl+Shift+C'] });
  assert.deepEqual(B.changes(DEFAULTS, B.resolve(DEFAULTS, {})), {});
});
