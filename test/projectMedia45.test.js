'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/project');
const settings = require('../src/settings');

const state = (media, layers = []) => ({
  layers, project: { width: 1280, height: 720, fps: 30 }, trim: { start: 0, end: 0 }, media,
});

test('the media list keeps path, name, kind and length, and drops nonsense', () => {
  const out = P.mediaOf([
    { src: 'C:/a.mp4', name: 'a.mp4', type: 'video', duration: 12.3456789, extra: 1 },
    { src: 'C:/b.png', name: 'b.png', type: 'image' },
    { src: 'C:/c.mp3', type: 'weird', duration: -3 },
    { name: 'no path' },
    null,
    'C:/d.mp4',
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { src: 'C:/a.mp4', name: 'a.mp4', type: 'video', duration: 12.345679 });
  assert.equal(out[1].duration, 0);
  assert.equal(out[2].type, 'video');
  assert.equal(out[2].name, '');
  assert.equal(out[2].duration, 0);
  assert.deepEqual(P.mediaOf(undefined), []);
});

test('a file added to Project Media is a change to the document', () => {
  const before = state([]);
  const after = state([{ src: 'C:/a.mp4', name: 'a.mp4', type: 'video', duration: 3 }]);
  assert.equal(P.sameDocument(before, after), false);
  assert.equal(P.sameDocument(after, state([{ src: 'C:/a.mp4', name: 'a.mp4', type: 'video', duration: 3 }])), true);
});

test('the list goes into the file with a reference each and comes back in order', () => {
  const media = [
    { src: 'C:/clips/a.mp4', name: 'a.mp4', type: 'video', duration: 3 },
    { src: 'C:/clips/b.mp3', name: 'b.mp3', type: 'audio', duration: 9 },
  ];
  const doc = P.serialise(state(media), {
    stats: { 'C:/clips/a.mp4': { size: 100, mtimeMs: 5 } },
    relatives: { 'C:/clips/a.mp4': 'clips\\a.mp4' },
  });
  assert.equal(doc.media.length, 2);
  assert.deepEqual(doc.media[0].ref, { path: 'C:/clips/a.mp4', relative: 'clips\\a.mp4', size: 100, mtime: 5, duration: 3 });
  const back = P.parse(P.stringify(doc));
  assert.ok(back.ok);
  assert.deepEqual(back.doc.media, media);
  assert.equal(back.mediaRefs.length, 2);
  assert.equal(back.mediaRefs[0].relative, 'clips\\a.mp4');
  assert.equal(back.mediaRefs[1].path, 'C:/clips/b.mp3');
});

test('a project from before Project Media opens with an empty list', () => {
  const doc = P.serialise(state(undefined));
  delete doc.media;
  const back = P.parse(P.stringify(doc));
  assert.deepEqual(back.doc.media, []);
  assert.deepEqual(back.mediaRefs, []);
});

test('a reference is resolved like a track file', () => {
  const ref = { path: 'C:/old/a.mp4', relative: 'a.mp4', size: 100, mtime: 5 };
  const tried = P.candidatesFor(ref, 'D:/proj', (a, b) => a + '/' + b);
  assert.deepEqual(tried, ['D:/proj/a.mp4', 'C:/old/a.mp4']);
  assert.equal(P.statusFor(ref, [{ path: tried[0], stat: { size: 100, mtimeMs: 5 } }]).state, 'ok');
  assert.equal(P.statusFor(ref, []).state, 'missing');
});

test('a poster comes from a tenth of the way in, never past five seconds', () => {
  const { posterAt } = require('../src/filmstrip');
  assert.equal(posterAt(10), 1);
  assert.equal(posterAt(600), 5);
  assert.equal(posterAt(0), 0);
});

test('the frame starts open', () => {
  assert.equal(settings.DEFAULTS.projectMediaCollapsed, false);
});

test('a project dropped on Project Media is opened, asking first when one is in work', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app', 'projectMedia.js'), 'utf8');
  const editing = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app', 'editing.js'), 'utf8');
  const add = src.slice(src.indexOf('async function addMediaFiles'), src.indexOf('async function askRemoveProjectMedia'));
  // A .lwc goes to openProjectPath, which opens into an empty project and
  // asks Different LWC Project (save, merge, discard) otherwise.
  assert.ok(/if \(result && result\.project\)/.test(add));
  assert.ok(add.includes('await openProjectPath(lwcPath);'));
  assert.ok(add.indexOf('await openProjectPath(lwcPath);') < add.indexOf('projectMedia.push('));
  assert.ok(editing.includes('layers.length > 0 || projectMedia.length > 0);'));
});
