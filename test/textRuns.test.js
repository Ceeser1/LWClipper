'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/timeline');
const R = require('../src/textRuns');

// A text's full style, as genOf fills it in.
const BASE = T.genOf({ form: 'text' }).text.style;

function full(runs, base = BASE) {
  return R.expand(runs, base);
}

// The runs as text and the one field a test is about, easy to read in a diff.
function show(list, field) {
  return list.map((r) => [r.text, r.style[field]]);
}

test('expand gives every run the whole style, compress takes it back to one run', () => {
  const f = full([{ text: 'Hello', style: { bold: true } }]);
  assert.equal(f[0].style.font, 'Arial');
  assert.equal(f[0].style.bold, true);
  // All of it bold: bold moves into the text's style and the run changes nothing.
  const c = R.compress(f, BASE);
  assert.deepEqual(c.runs, [{ text: 'Hello', style: {} }]);
  assert.equal(c.style.bold, true);
});

test('compress keeps only what differs, joins neighbours alike and drops empty runs', () => {
  const f = full([
    { text: 'a', style: { bold: true } },
    { text: '', style: { italic: true } },
    { text: 'b', style: { bold: true } },
    { text: 'c' },
    { text: 'd', style: { size: 96 } },
  ]);
  const c = R.compress(f, BASE);
  assert.deepEqual(c.runs, [
    { text: 'ab', style: { bold: true } },
    { text: 'cd', style: {} },
  ]);
  assert.equal(c.style.bold, false);
});

test('compress leaves the text\'s outline and shadow alone', () => {
  const base = { ...BASE, outline: { color: '#000000ff', width: 4 } };
  const c = R.compress(full([{ text: 'a' }, { text: 'b', style: { italic: true } }], base), base);
  assert.deepEqual(c.style.outline, base.outline);
  assert.deepEqual(c.runs[1].style, { italic: true });
});

test('an emptied text keeps the style of what was in it, in the text\'s style', () => {
  const f = R.splice(full([{ text: 'ab', style: { color: '#ff0000ff' } }, { text: 'cd' }]), 0, 4, '');
  assert.deepEqual(show(f, 'color'), [['', '#ff0000ff']]);
  const c = R.compress(f, BASE);
  assert.deepEqual(c.runs, [{ text: '', style: {} }]);
  assert.equal(c.style.color, '#ff0000ff');
});

test('a letter typed takes the style of the one before it, at the start the one after', () => {
  const f = full([{ text: 'ab', style: { bold: true } }, { text: 'cd' }]);
  assert.equal(R.styleAt(f, 0).bold, true);
  assert.equal(R.styleAt(f, 2).bold, true);
  assert.equal(R.styleAt(f, 3).bold, false);
  assert.equal(R.styleAt(f, 99).bold, false);
  assert.deepEqual(show(R.splice(f, 2, 2, 'X'), 'bold'), [['ab', true], ['X', true], ['cd', false]]);
  assert.deepEqual(R.textOf(R.splice(f, 2, 2, 'X')), 'abXcd');
});

test('typing over a selection takes the style of its first letter', () => {
  const f = full([{ text: 'ab' }, { text: 'cd', style: { italic: true } }]);
  const out = R.splice(f, 2, 4, 'Z');
  assert.deepEqual(show(out, 'italic'), [['ab', false], ['Z', true]]);
});

test('a style handed in wins, which is the pending style of a bare caret', () => {
  const f = full([{ text: 'ab' }]);
  const out = R.splice(f, 1, 1, 'X', { ...R.styleAt(f, 1), underline: true });
  assert.deepEqual(show(out, 'underline'), [['a', false], ['X', true], ['b', false]]);
});

test('typing into an empty text uses the empty run\'s style', () => {
  const f = full([{ text: '', style: { size: 40 } }]);
  const out = R.splice(f, 0, 0, 'hi');
  assert.deepEqual(show(out, 'size'), [['hi', 40]]);
});

test('applyStyle formats exactly the range, cutting runs where it starts and ends', () => {
  const f = full([{ text: 'Hello world' }]);
  const out = R.applyStyle(f, 6, 11, { bold: true, color: '#00ff00ff' });
  assert.deepEqual(show(out, 'bold'), [['Hello ', false], ['world', true]]);
  assert.equal(out[1].style.color, '#00ff00ff');
  const c = R.compress(out, BASE);
  assert.deepEqual(c.runs, [
    { text: 'Hello ', style: {} },
    { text: 'world', style: { bold: true, color: '#00ff00ff' } },
  ]);
  // The input is never changed.
  assert.deepEqual(show(f, 'bold'), [['Hello world', false]]);
});

test('applyStyle takes no outline or shadow, and a bare caret changes nothing', () => {
  const f = full([{ text: 'ab' }]);
  const out = R.applyStyle(f, 0, 2, { outline: { width: 3 }, shadow: null, italic: true });
  assert.equal(out[0].style.outline, BASE.outline);
  assert.equal(out[0].style.italic, true);
  assert.deepEqual(R.applyStyle(f, 1, 1, { italic: true }), f);
});

test('the range may be given backwards or past the ends', () => {
  const f = full([{ text: 'abc' }]);
  assert.deepEqual(show(R.applyStyle(f, 99, 2, { bold: true }), 'bold'), [['ab', false], ['c', true]]);
  assert.equal(R.textOf(R.splice(f, -5, 1, '')), 'bc');
});

test('slice and replaceRuns carry formatting through a copy and a paste', () => {
  const f = full([{ text: 'ab' }, { text: 'cd', style: { bold: true } }, { text: 'ef' }]);
  const copied = R.slice(f, 1, 5);
  assert.deepEqual(show(copied, 'bold'), [['b', false], ['cd', true], ['e', false]]);
  const pasted = R.replaceRuns(f, 6, 6, copied);
  assert.equal(R.textOf(pasted), 'abcdefbcde');
  const c = R.compress(pasted, BASE);
  assert.deepEqual(c.runs.map((r) => [r.text, !!r.style.bold]), [
    ['ab', false], ['cd', true], ['efb', false], ['cd', true], ['e', false],
  ]);
});

test('the selection shows its first letter\'s style and names what is mixed', () => {
  const f = full([{ text: 'ab', style: { bold: true, size: 50 } }, { text: 'cd', style: { size: 50 } }]);
  const s = R.selectionStyle(f, 0, 4);
  assert.equal(s.style.bold, true);
  assert.deepEqual(s.mixed, ['bold']);
  assert.deepEqual(R.selectionStyle(f, 2, 4).mixed, []);
  // A caret has nothing mixed and shows what it would type.
  const caret = R.selectionStyle(f, 3, 3);
  assert.equal(caret.style.bold, false);
  assert.deepEqual(caret.mixed, []);
});

test('textChange finds the one replacement between two versions', () => {
  assert.deepEqual(R.textChange('Hello', 'Hello!'), { from: 5, to: 5, text: '!' });
  assert.deepEqual(R.textChange('Hello', 'Hllo', 1), { from: 1, to: 2, text: '' });
  assert.deepEqual(R.textChange('abc', 'aXc', 2), { from: 1, to: 2, text: 'X' });
  assert.deepEqual(R.textChange('same', 'same', 2), { from: 2, to: 2, text: '' });
  assert.deepEqual(R.textChange('', 'new', 3), { from: 0, to: 0, text: 'new' });
});

test('textChange lets the caret say where a doubled letter went', () => {
  // "a" typed between the two a's of "aab": the caret stands at 2, so the new
  // letter is the second one, not the third.
  assert.deepEqual(R.textChange('aab', 'aaab', 2), { from: 1, to: 1, text: 'a' });
  assert.deepEqual(R.textChange('aab', 'aaab', 3), { from: 2, to: 2, text: 'a' });
  // Backspace on the first of two spaces.
  assert.deepEqual(R.textChange('a  b', 'a b', 1), { from: 1, to: 2, text: '' });
});

test('a change found by textChange and put through splice rebuilds the text', () => {
  const f = full([{ text: 'one ', style: { italic: true } }, { text: 'two' }]);
  const after = 'one-and two';
  const ch = R.textChange(R.textOf(f), after, 7);
  const out = R.splice(f, ch.from, ch.to, ch.text);
  assert.equal(R.textOf(out), after);
  // Typed after "one", so italic like "one".
  assert.deepEqual(show(out, 'italic'), [['one', true], ['-and', true], [' ', true], ['two', false]]);
});
