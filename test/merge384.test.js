'use strict';

// V3.8.4. A project file handed to the app while one is open: the Different
// LWC Project question, and merging the other project in as new layers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/timeline');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const EDITING = read('renderer', 'app', 'editing.js');
const CSS = read('renderer', 'style.css');

const media = (props) => T.createLayer({ kind: 'media', src: 'a.mp4', sourceDuration: 10, ...props });

// ---- the model ----

test('merged layers go below each kind\'s rows, with new ids and their groups kept among themselves', () => {
  const ours = T.arrangeLanes([
    media({ id: 'v1', type: 'video', lane: 0, groupId: 'g1' }),
    media({ id: 'a1', type: 'audio', lane: 0, groupId: 'g1' }),
  ]);
  // The very same project merged into itself: every id collides.
  const theirs = ours.map((l) => ({ ...l, start: 2 }));
  const { layers, ids } = T.mergeLayers(ours, theirs, { video: 2, audio: 1 });
  assert.equal(layers.length, 4);
  assert.equal(ids.size, 2);
  const added = layers.filter((l) => !['v1', 'a1'].includes(l.id));
  assert.equal(added.length, 2);
  assert.equal(new Set(layers.map((l) => l.id)).size, 4);
  const v = added.find((l) => l.type === 'video');
  const a = added.find((l) => l.type === 'audio');
  assert.equal(v.lane, 2);
  assert.equal(a.lane, 1);
  // Grouped with each other, not with the clips already there.
  assert.ok(v.groupId && v.groupId === a.groupId && v.groupId !== 'g1');
  assert.deepEqual(T.groupOf(layers, v.id).map((l) => l.id).sort(), [v.id, a.id].sort());
  assert.deepEqual(T.groupOf(layers, 'v1').map((l) => l.id).sort(), ['a1', 'v1']);
  // Everything else as it was saved.
  assert.equal(v.start, 2);
  assert.equal(ids.get('v1'), v.id);
  // The list stays in lane order: video before audio, top row first.
  assert.deepEqual(layers.map((l) => l.type), ['video', 'video', 'audio', 'audio']);
});

test('merging keeps the rows between the other project\'s own tracks, and a kind with none starts at the top', () => {
  const theirs = [
    media({ id: 'x', type: 'video', lane: 0 }),
    media({ id: 'y', type: 'video', lane: 3 }),
    media({ id: 'z', type: 'audio', lane: 1 }),
  ];
  const { layers, ids } = T.mergeLayers([], theirs, { video: 0, audio: 0 });
  const lane = (old) => layers.find((l) => l.id === ids.get(old)).lane;
  assert.equal(lane('x'), 0);
  assert.equal(lane('y'), 3);
  assert.equal(lane('z'), 1);
});

test('merged keyframes keep their ids, which are their own layer\'s', () => {
  const kf = { id: 'k1', t: 1, crop: null, render: { x: 0, y: 0, width: 100, height: 50 } };
  const theirs = [media({ id: 'v', type: 'video', lane: 0, keyframes: [kf] })];
  const { layers } = T.mergeLayers([], theirs, {});
  assert.equal(layers[0].keyframes[0].id, 'k1');
  assert.notEqual(layers[0].id, 'v');
});

// ---- the window ----

test('a project handed over while one is open asks Different LWC Project, with the three answers stacked', () => {
  assert.ok(EDITING.includes("title: t('Different LWC Project')"));
  assert.ok(EDITING.includes("t('You attempted to open another LWC Project while one is opened, what would you like to do?')"));
  const ask = EDITING.slice(EDITING.indexOf('async function askDifferentProject'), EDITING.indexOf('async function openProjectPath'));
  const save = ask.indexOf("id: 'save'");
  const merge = ask.indexOf("id: 'merge'");
  const discard = ask.indexOf("id: 'discard'");
  const cancel = ask.indexOf("id: 'cancel'");
  assert.ok(save > 0 && save < merge && merge < discard && discard < cancel, 'save, merge, discard, cancel in that order');
  // Save green, Merge yellow, Discard red, Cancel plain.
  assert.ok(ask.includes("t('Save this project, then open the other'), primary: true"));
  assert.ok(ask.includes("t('Merge the other project with this as new layers'), tone: 'caution'"));
  assert.ok(/button\[data-tone="caution"\]\s*\{[^}]*background:\s*#dcc878/.test(CSS));
  assert.ok(ask.includes("t('Discard changes on this project, then open the other'), tone: 'danger'"));
  assert.ok(ask.includes("{ id: 'cancel', label: t('Cancel') }"));
  assert.ok(ask.includes("cancel: 'cancel'"), 'the backdrop and Escape cancel');
  assert.ok(ask.includes('stacked: true'));
  assert.ok(EDITING.includes("choiceButtons.classList.toggle('choice-buttons--stacked', !!stacked);"));
  assert.ok(/\.choice-buttons\.choice-buttons--stacked\s*\{[^}]*display:\s*grid;[^}]*justify-content:\s*center/.test(CSS));
  // Nothing open is not a question.
  assert.ok(ask.includes("if (!projectIsOpen()) return 'open';"));
  assert.ok(EDITING.includes('return timelineDriving() && (!!projectPath || layers.length > 0);'));
});

test('save saves first and reads the other file after; merge merges; discard opens unasked; cancel leaves everything', () => {
  const open = EDITING.slice(EDITING.indexOf('async function openProjectPath'), EDITING.indexOf('async function mergeProject'));
  assert.ok(open.includes("how === 'save' ? await saveProject(false)"));
  assert.ok(open.includes(": how === 'merge' || how === 'discard';"));
  assert.ok(open.indexOf('saveProject(false)') < open.indexOf('window.lwclipper.openProject(filePath)'));
  assert.ok(open.includes("how === 'merge' ? await mergeProject(result) : await adoptProject(result)"));
  // Ctrl+O with a project open names the file first and then asks.
  const file = EDITING.slice(EDITING.indexOf('async function openProjectFile'), EDITING.indexOf('function projectIsOpen'));
  assert.ok(file.indexOf('if (projectIsOpen())') < file.indexOf('confirmDiscard'));
  assert.ok(file.includes('await openProjectPath(picked.path);'));
});

test('a merge is one undo step and leaves this project\'s file, trim and undo stack alone', () => {
  const merge = EDITING.slice(EDITING.indexOf('async function mergeProject'), EDITING.indexOf('function fitMergedLayer'));
  assert.equal((merge.match(/commitHistory\(\)/g) || []).length, 1);
  assert.ok(merge.includes('setLayers(merged.layers, true);'));
  assert.ok(!/undoStack\s*=/.test(merge), 'the other project\'s undo stack is never taken');
  assert.ok(!/projectPath\s*=/.test(merge) && !/slider\.setRange/.test(merge));
  assert.ok(merge.includes('askAboutMissing(trouble)'));
  assert.ok(merge.includes('mergeViews(result.views, merged.ids);'));
  assert.ok(merge.includes('fitMergedLayer(l, theirs, compositeFrame)'));
});

test('every way a project file arrives goes through openProjectPath', () => {
  assert.ok(read('renderer', 'app', 'clips.js').includes('await openProjectPath(result.path);'));
  assert.ok(read('renderer', 'app', 'media.js').includes('await openProjectPath(result.path);'));
  assert.ok(read('renderer', 'app', 'startup.js').includes('await openProjectPath(result.path);'));
});

test('the new strings are in both locale files', () => {
  const en = JSON.parse(read('locales', 'en.json'));
  const de = JSON.parse(read('locales', 'de.json'));
  for (const key of ['Different LWC Project', 'Save this project, then open the other',
    'Merge the other project with this as new layers', 'Discard changes on this project, then open the other',
    'Project merged: {n} track(s) added.']) {
    assert.ok(en[key] && de[key], key);
  }
});
