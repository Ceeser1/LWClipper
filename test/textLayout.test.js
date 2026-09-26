'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/textLayout');

// A font where every character is half its size wide, with an ascent of 0.8
// and a descent of 0.2 of it. Round numbers, so every position below can be
// worked out by hand.
function measure(text, style, scale) {
  const size = style.size * scale;
  return { width: Array.from(text).length * size * 0.5, ascent: size * 0.8, descent: size * 0.2 };
}

const BASE = { font: 'Arial', size: 20, bold: false, italic: false };

function lay(runs, opts = {}) {
  return L.layoutText({
    runs,
    style: BASE,
    align: { h: 'left', v: 'top' },
    width: 1000,
    height: 500,
    measure,
    ...opts,
  });
}

function texts(result) {
  return result.lines.map((l) => l.pieces.map((p) => p.text).join(''));
}

test('a short text is one line, one piece', () => {
  const r = lay([{ text: 'Hello world', style: {} }]);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].pieces.length, 1);
  assert.equal(r.lines[0].pieces[0].text, 'Hello world');
  assert.equal(r.lines[0].width, 110);
  assert.equal(r.lines[0].height, 20);
  assert.equal(r.lines[0].baseline, 16);
});

test('text wraps at spaces, and the space it wrapped at belongs to neither line', () => {
  // Ten pixels a character: "aaaa bbbb" is 90 wide, so 60 wraps it.
  const r = lay([{ text: 'aaaa bbbb cc', style: {} }], { width: 60 });
  assert.deepEqual(texts(r), ['aaaa', 'bbbb', 'cc']);
  assert.equal(r.lines[0].width, 40);
  assert.equal(r.lines[1].top, 20);
  assert.equal(r.height, 60);
});

test('spaces at the end of a line do not count towards centring it', () => {
  const r = lay([{ text: 'ab   ', style: {} }], { align: { h: 'center', v: 'top' }, width: 100 });
  assert.equal(r.lines[0].width, 20);
  assert.equal(r.lines[0].x, 40);
});

test('a hard break starts a line, keeps the spaces typed after it, and empty lines have height', () => {
  const r = lay([{ text: 'one\n\n  two', style: {} }]);
  assert.deepEqual(texts(r), ['one', '', '  two']);
  assert.equal(r.lines[1].height, 20);
  assert.equal(r.lines[2].top, 40);
});

test('a line opened by wrapping does not start with spaces', () => {
  const r = lay([{ text: 'aaaa    bbbb', style: {} }], { width: 50 });
  assert.deepEqual(texts(r), ['aaaa', 'bbbb']);
});

test('a word wider than the box is cut between characters', () => {
  const r = lay([{ text: 'abcdefghij', style: {} }], { width: 35 });
  assert.deepEqual(texts(r), ['abc', 'def', 'ghi', 'j']);
});

test('a word across two runs is never wrapped between them', () => {
  const r = lay([
    { text: 'xx He', style: {} },
    { text: 'llo', style: { bold: true } },
  ], { width: 60 });
  assert.deepEqual(texts(r), ['xx', 'Hello']);
  // Two pieces on the second line, one per run, the second starting where the
  // first ends.
  const [a, b] = r.lines[1].pieces;
  assert.equal(a.text, 'He');
  assert.equal(b.text, 'llo');
  assert.equal(b.style.bold, true);
  assert.equal(b.x, a.x + a.width);
});

test('the largest run on a line sets its height and baseline', () => {
  const r = lay([
    { text: 'small ', style: {} },
    { text: 'BIG', style: { size: 40 } },
  ]);
  assert.equal(r.lines[0].height, 40);
  assert.equal(r.lines[0].baseline, 32);
});

test('an empty text is one line with the height of its style', () => {
  const r = lay([{ text: '', style: {} }]);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].height, 20);
  assert.equal(r.lines[0].pieces.length, 0);
});

test('no runs at all lays out as an empty text rather than failing', () => {
  const r = lay([]);
  assert.equal(r.lines.length, 1);
});

test('alignment places the block in the box', () => {
  const runs = [{ text: 'abcd', style: {} }];
  const at = (h, v) => {
    const l = lay(runs, { align: { h, v }, width: 100, height: 100 }).lines[0];
    return [l.x, l.top];
  };
  assert.deepEqual(at('left', 'top'), [0, 0]);
  assert.deepEqual(at('center', 'middle'), [30, 40]);
  assert.deepEqual(at('right', 'bottom'), [60, 80]);
});

test('a text taller than its box overflows both ways from the middle', () => {
  const r = lay([{ text: 'a\nb\nc', style: {} }], { align: { h: 'left', v: 'middle' }, height: 20 });
  assert.equal(r.lines[0].top, -20);
  assert.equal(r.lines[2].top, 20);
});

test('the scale reaches the measuring, so sizes are in project pixels', () => {
  const r = lay([{ text: 'ab', style: {} }], { scale: 0.5 });
  assert.equal(r.lines[0].width, 10);
  assert.equal(r.lines[0].height, 10);
  assert.equal(r.scale, 0.5);
  // The style handed back is the stored one, unscaled; the drawing scales it.
  assert.equal(r.lines[0].pieces[0].style.size, 20);
});

test('styleOf lays a run over the base, and null in a run is a real value', () => {
  const base = { size: 20, outline: { width: 3 } };
  assert.deepEqual(L.styleOf(base, { size: 30 }), { size: 30, outline: { width: 3 } });
  assert.deepEqual(L.styleOf(base, { size: undefined }), base);
  assert.equal(L.styleOf(base, { outline: null }).outline, null);
});

test('fontString quotes the family and scales the size', () => {
  assert.equal(L.fontString({ font: 'Segoe UI', size: 40, bold: true, italic: true }, 0.5),
    'italic bold 20px "Segoe UI", sans-serif');
  assert.equal(L.fontString({ font: 'A"b', size: 10 }), '10px "Ab", sans-serif');
});
