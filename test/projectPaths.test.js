'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const P = require('../src/project');

// path.win32 rather than path, so these say the same thing wherever they run.
// Every path this app meets comes from a Windows dialog, a drop or path.join.
const w32 = path.win32;

test('a file under the project folder gets a relative path', () => {
  assert.equal(P.relativePath('C:\\work', 'C:\\work\\media\\a.mp4', w32), 'media\\a.mp4');
});

test('mixed separators are still one drive', () => {
  // The bug this exists for. path.parse reports the root as it was spelled, so
  // "C:/" and "C:\" compare unequal for the same drive, and comparing them
  // whole made every relative path silently vanish.
  assert.equal(P.relativePath('C:/work', 'C:\\work\\a.mp4', w32), 'a.mp4');
  assert.equal(P.relativePath('C:\\work', 'C:/work/a.mp4', w32), 'a.mp4');
});

test('the drive letter is compared without regard to case', () => {
  assert.equal(P.relativePath('c:\\work', 'C:\\work\\a.mp4', w32), 'a.mp4');
});

test('another drive has no relative path worth recording', () => {
  assert.equal(P.relativePath('C:\\work', 'D:\\media\\a.mp4', w32), null);
});

test('a file just outside the project folder still gets one', () => {
  // One level up is a real relationship: move the parent folder and both go.
  assert.equal(P.relativePath('C:\\work\\proj', 'C:\\work\\media\\a.mp4', w32),
    '..\\media\\a.mp4');
});

test('a path that has to climb miles out does not', () => {
  const deep = 'C:\\a\\b\\c\\d\\e\\f\\proj';
  assert.equal(P.relativePath(deep, 'C:\\somewhere\\a.mp4', w32), null);
});

test('the climb limit is where it says it is', () => {
  assert.equal(P.relativePath('C:\\a\\b\\c', 'C:\\a\\x.mp4', w32, 2), '..\\..\\x.mp4');
  assert.equal(P.relativePath('C:\\a\\b\\c', 'C:\\a\\x.mp4', w32, 1), null);
});

test('nonsense in gives null rather than a throw', () => {
  assert.equal(P.relativePath(null, 'C:\\a.mp4', w32), null);
  assert.equal(P.relativePath('C:\\work', null, w32), null);
  assert.equal(P.relativePath('C:\\work', 'C:\\work', w32), null);
});

test('a relative path and the candidate list agree about where to look', () => {
  // The two halves of the same journey: this is what is written at save time,
  // and that is what is tried at open time.
  const dir = 'C:\\work';
  const src = 'C:\\work\\media\\a.mp4';
  const rel = P.relativePath(dir, src, w32);
  const ref = { path: src, relative: rel };
  // The project and its media moved to D: together.
  assert.deepEqual(P.candidatesFor(ref, 'D:\\moved', w32.join),
    ['D:\\moved\\media\\a.mp4', src]);
});
