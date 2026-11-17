'use strict';

// V5.1.5. Three things the user asked for on 2026-11-17:
//   "A smaller picture should be displayed center at its actual size when
//    added / not modified yet."
//   "Move Keyframes to the bottom like on every other window and the settings
//    above the preview. For Video Frame it should be Aspect Ratio buttons row,
//    then pixel values, then zoom slider, then preview, then keyframes."
//   A drag of the strip's playhead between two keyframes of different sizes
//   left a new keyframe at every step while Render Position was up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const G = require('../src/geometry');
const P = require('../src/project');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HD = { width: 1920, height: 1080, fps: 30 };
const SMALL = { width: 256, height: 256 };

function image(props = {}) {
  return T.createLayer({
    type: 'video', kind: 'image', src: 'C:/pics/a.png', duration: 10,
    sourceWidth: SMALL.width, sourceHeight: SMALL.height, ...props,
  });
}

test('a picture no bigger than the frame stands in its middle at its own size', () => {
  assert.deepEqual(G.ownSizeRect(256, 256, HD), { x: 832, y: 412, width: 256, height: 256 });
  // As big as the frame is the frame.
  assert.deepEqual(G.ownSizeRect(1920, 1080, HD), { x: 0, y: 0, width: 1920, height: 1080 });
  // Odd sizes come down to even ones, as every size the encoder gets does.
  assert.deepEqual(G.ownSizeRect(301, 201, HD), { x: 810, y: 440, width: 300, height: 200 });
});

test('a picture bigger than the frame either way is fitted down, as it always was', () => {
  assert.deepEqual(G.ownSizeRect(3840, 2160, HD), G.fitRect(3840, 2160, HD));
  // Narrow but too tall: still fitted, not cut off.
  assert.deepEqual(G.ownSizeRect(500, 2000, HD), G.fitRect(500, 2000, HD));
  assert.deepEqual(G.ownSizeRect(4000, 300, HD), G.fitRect(4000, 300, HD));
});

test('placeLayer fits unless the layer is marked, so every old layer lands where it did', () => {
  const fitted = G.placeLayer({ source: SMALL, project: HD });
  assert.deepEqual(fitted.dest, { x: 420, y: 0, width: 1080, height: 1080 });
  const own = G.placeLayer({ source: SMALL, project: HD, ownSize: true });
  assert.deepEqual(own.dest, { x: 832, y: 412, width: 256, height: 256 });
  assert.deepEqual(own.src, fitted.src);
});

test('a crop of a marked picture stays where that part was, pixel for pixel', () => {
  const p = G.placeLayer({ source: SMALL, crop: { x: 64, y: 32, width: 128, height: 96 }, project: HD, ownSize: true });
  assert.deepEqual(p.dest, { x: 832 + 64, y: 412 + 32, width: 128, height: 96 });
});

test('a position set by hand wins over the mark', () => {
  const render = { x: 10, y: 20, width: 512, height: 512 };
  assert.deepEqual(G.placeLayer({ source: SMALL, render, project: HD, ownSize: true }).dest, render);
});

test('placementAt reads the mark off the layer, with and without keyframes', () => {
  const plain = image({ ownSize: true });
  assert.deepEqual(G.placementAt(plain, 0, SMALL, HD).dest, { x: 832, y: 412, width: 256, height: 256 });
  assert.deepEqual(G.placementAt(image(), 0, SMALL, HD).dest, { x: 420, y: 0, width: 1080, height: 1080 });
  // A keyframe left on "no position" is the picture's own size too, so a move
  // from there to a placed keyframe starts at 256 and not at 1080.
  const keyed = image({
    ownSize: true,
    keyframes: [
      { id: 'a', t: 0, crop: null, render: null },
      { id: 'b', t: 2, crop: null, render: { x: 0, y: 0, width: 512, height: 512 } },
    ],
  });
  assert.deepEqual(G.placementAt(keyed, 0, SMALL, HD).dest, { x: 832, y: 412, width: 256, height: 256 });
  assert.deepEqual(G.placementAt(keyed, 1, SMALL, HD).dest, { x: 416, y: 206, width: 384, height: 384 });
  assert.equal(G.motionOf(keyed, SMALL, HD) !== null, true);
});

test('the mark is the layer\'s own: kept by createLayer, only when exactly true, never on sound or generated media', () => {
  assert.equal(image({ ownSize: true }).ownSize, true);
  assert.equal(image().ownSize, false);
  assert.equal(image({ ownSize: 1 }).ownSize, false);
  assert.equal(T.createLayer({ type: 'audio', src: 'a.mp3', sourceDuration: 5, ownSize: true }).ownSize, false);
  assert.equal(T.createLayer({ type: 'video', kind: 'gen', gen: { kind: 'text' }, ownSize: true }).ownSize, false);
  // Both halves of a split keep it.
  const halves = T.splitLayer([image({ ownSize: true, id: 'x' })], 'x', 4);
  assert.deepEqual(halves.map((l) => l.ownSize), [true, true]);
});

test('a project keeps the mark, and one saved before it opens fitted', () => {
  const text = P.stringify(P.serialise({ layers: [image({ ownSize: true })], project: HD, trim: { start: 0, end: 10 } }));
  assert.equal(T.createLayer(P.parse(text).doc.layers[0]).ownSize, true);
  const old = JSON.parse(text);
  delete old.layers[0].ownSize;
  assert.equal(T.createLayer(P.parse(JSON.stringify(old)).doc.layers[0]).ownSize, false);
});

test('an image is marked when it is added, a video is not', () => {
  const clips = read('renderer', 'app', 'clips.js');
  assert.match(clips, /ownSize: image,/);
  // Every caller that places a layer itself hands the mark on.
  for (const f of ['compositor.js', 'editing.js', 'renderFrame.js', 'placement.js']) {
    assert.match(read('renderer', 'app', f), /ownSize: !!layer\.ownSize/, f);
  }
});

test('Crop and Mask: each view\'s settings are over its stage and the keyframes are last', () => {
  const html = read('renderer', 'index.html');
  const from = html.indexOf('id="cropModal"');
  const to = html.indexOf('id="renderModal"');
  const at = (needle) => {
    const i = html.indexOf(needle, from);
    assert.ok(i > from && i < to, needle);
    return i;
  };
  const order = [
    'id="cropTabs"',
    'id="cropPresets"',
    'id="cropSize"',
    'id="placeSize"',
    'id="placeScaleRow"',
    'id="cropZoomRow"',
    'id="cropFramePanel"',
    'id="placePanel"',
    'id="maskPanel"',
    'id="cropKeys"',
    'id="cropAcceptBtn"',
  ].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('Render Position hands a placement back as it came in until it is scaled or moved', () => {
  const src = read('renderer', 'app', 'placement.js');
  assert.match(src, /let placeHeld = null;/);
  // Taken where the scale and the centre are taken, given back in the rebuild.
  const adopt = src.slice(src.indexOf('function adoptPlaceRect'), src.indexOf('function showPlaceScale'));
  assert.match(adopt, /placeHeld = fit/);
  const rebuild = src.slice(src.indexOf('function rebuildPlaceDraft'), src.indexOf('function placeDraftSize'));
  assert.match(rebuild, /placeDraft = \{ \.\.\.placeHeld\.rect \};/);
  assert.ok(rebuild.indexOf('placeHeld.rect') < rebuild.indexOf('holdPlaceAnchor(fit)'));
});
