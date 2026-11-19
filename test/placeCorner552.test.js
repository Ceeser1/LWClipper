'use strict';

// V5.5.2. The user, 2026-11-19: the corners of Render Position size the picture
// and a dot turns it as on the other boxes, and "Using the corners to adjust
// the size must always maintain the aspect ratio from Video Frame and adjust
// the Scale slider accordingly."

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const G = require('../src/geometry');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const RECT = { x: 100, y: 200, width: 800, height: 450 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' is not ' + b);

test('a corner dragged along the diagonal gives the share of the size', () => {
  assert.equal(G.placeCornerShare(RECT, 'br', 0, { x: 900, y: 650 }, false), 1);
  near(G.placeCornerShare(RECT, 'br', 0, { x: 500, y: 425 }, false), 0.5);
  near(G.placeCornerShare(RECT, 'tl', 0, { x: -700, y: -250 }, false), 2);
});

test('a pointer off the diagonal still gives one share, so the shape cannot change', () => {
  // Straight right of the corner: measured along the diagonal all the same.
  const share = G.placeCornerShare(RECT, 'br', 0, { x: 1700, y: 650 }, false);
  assert.ok(share > 1 && share < 2);
});

test('a pointer taken past the corner that stays gives nothing below 0', () => {
  assert.equal(G.placeCornerShare(RECT, 'br', 0, { x: -500, y: -500 }, false), 0);
});

test('the opposite corner stays where it is, turned or not', () => {
  for (const deg of [0, 30, 90, -135]) {
    for (const [corner, opposite] of [['tl', 'br'], ['tr', 'bl'], ['bl', 'tr'], ['br', 'tl']]) {
      const size = { width: 400, height: 225 };
      const c = G.placeCornerCentre(RECT, corner, deg, size, false);
      const after = { x: c.cx - size.width / 2, y: c.cy - size.height / 2, ...size };
      const was = G.placeCornerPoint(RECT, opposite, deg);
      const now = G.placeCornerPoint(after, opposite, deg);
      near(now.x, was.x);
      near(now.y, was.y);
    }
  }
});

test('a turned corner follows the pointer along the turned diagonal', () => {
  const at = G.placeCornerPoint(RECT, 'br', 40);
  near(G.placeCornerShare(RECT, 'br', 40, at, false), 1);
  near(G.placeCornerShare(RECT, 'br', 40, at, true), 1);
});

test('about the middle the reach is measured from the middle', () => {
  near(G.placeCornerShare(RECT, 'br', 0, { x: 1300, y: 875 }, true), 2);
  near(G.placeCornerShare(RECT, 'tl', 0, { x: 300, y: 312.5 }, true), 0.5);
});

test('a corner holds the middle, Shift the opposite corner, and a ring wins over both', () => {
  const src = read('renderer', 'app', 'placement.js');
  const part = src.slice(src.indexOf("querySelectorAll('.place-corner')"), src.indexOf('const PLACE_FIT_PAD'));
  assert.match(part, /const broken = ev\.shiftKey && \(!stuck \|\| stuck\.key === 'centre'\);/);
  assert.match(part, /placeCornerShare\(start, name, turn, to, !broken\)/);
  assert.match(part, /placeCentre = broken\s+\? layerGeometry\.placeCornerCentre\([^)]*\)\)\s+: \{ \.\.\.middle \};/);
  // The ring stays selected and the picture is put back on it at every step.
  assert.match(part, /placeAnchor = ring \? ring\.key : null;/);
  assert.match(part, /if \(ring\) holdPlaceAnchor\(fit, true\);/);
});

test('stuck to the left side, a top corner is measured straight up from that side', () => {
  // The middle of the left side is 100, 425, and the top left corner is 225 above it.
  near(G.placeAnchorShare(RECT, 'tl', 0, { x: 100, y: 200 }, 0, 0.5), 1);
  near(G.placeAnchorShare(RECT, 'tl', 0, { x: 100, y: -25 }, 0, 0.5), 2);
  // Sideways is no reach at all on that line.
  near(G.placeAnchorShare(RECT, 'tl', 0, { x: 700, y: 200 }, 0, 0.5), 1);
});

test('stuck to a corner, the corner far from it follows the pointer', () => {
  near(G.placeAnchorShare(RECT, 'br', 0, { x: 500, y: 425 }, 0, 0), 0.5);
  near(G.placeAnchorShare(RECT, 'tr', 0, { x: 1700, y: 200 }, 0, 0), 2);
});

test('the corner standing on the ring itself grows the picture when dragged outwards', () => {
  assert.ok(G.placeAnchorShare(RECT, 'tl', 0, { x: 0, y: 100 }, 0, 0) > 1);
  assert.ok(G.placeAnchorShare(RECT, 'tl', 0, { x: 300, y: 300 }, 0, 0) < 1);
  // A quarter turn puts another corner on that ring, with the same result.
  const onRing = G.placeCornerPoint(RECT, 'bl', 90);
  const room = G.turnedSize(RECT.width, RECT.height, 90);
  near(onRing.x, 500 - room.width / 2);
  near(onRing.y, 425 - room.height / 2);
  near(G.placeAnchorShare(RECT, 'bl', 90, onRing, 0, 0), 1);
});

test('the stick to center measures the same as the middle', () => {
  const point = { x: 1000, y: 700 };
  near(G.placeAnchorShare(RECT, 'br', 30, point, 0.5, 0.5), G.placeCornerShare(RECT, 'br', 30, point, true));
});

test('the note stands under the Render Position preview, in that view only', () => {
  const html = read('renderer', 'index.html');
  const panel = html.slice(html.indexOf('id="placePanel"'), html.indexOf('id="maskPanel"'));
  const note = 'Hold shift while dragging to break the center point and scale across your axis.';
  assert.ok(panel.indexOf(note) > panel.indexOf('id="placeStage"'));
  assert.equal(JSON.parse(read('locales', 'en.json'))[note], note);
  assert.ok(JSON.parse(read('locales', 'de.json'))[note]);
});

test('a size read back as a scale rounds to the same width and height', () => {
  const fit = { width: 960, height: 720 };
  for (let w = 2; w <= 1900; w += 1) {
    const size = { width: Math.round(w), height: Math.round(w * 0.75) };
    const pct = G.placeScaleOf(size.width, size.height, fit);
    assert.equal(Math.round(fit.width * pct / 100), size.width);
    assert.equal(Math.round(fit.height * pct / 100), size.height);
  }
  // Another shape has no such scale and goes by its width.
  near(G.placeScaleOf(480, 100, fit), 50);
});

// ---- Landing on the borders of the frame ----

const FRAME = { width: 1920, height: 1080 };
const middleOf = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

test('a side within reach of a border lands on it, and further off it does not', () => {
  assert.equal(G.placeSnapSide(8, 500, 1920, 10), 0);
  assert.equal(G.placeSnapSide(-8, 500, 1920, 10), 0);
  assert.equal(G.placeSnapSide(1425, 500, 1920, 10), 1420);
  assert.equal(G.placeSnapSide(11, 500, 1920, 10), 11);
  // Just outside the frame on the far side, for a picture waiting to slide in.
  assert.equal(G.placeSnapSide(1925, 500, 1920, 10), 1920);
});

test('a square growing from the middle lands on the top and the bottom, then goes on', () => {
  const square = { x: 660, y: 240, width: 600, height: 600 };
  const fit = { width: 720, height: 720 };
  const at = (pct) => G.placeSnapScale(square, 0, middleOf(square), fit, pct, FRAME, 10);
  near(at(149), 150);
  near(at(151), 150);
  assert.equal(at(155), null);
});

test('a track of the frame\'s own shape lands on exactly the frame\'s size', () => {
  const fit = { width: 1280, height: 720 };
  // A rounded start and a middle off the frame's: the size comes out exact all the same.
  const start = { x: 300, y: 170, width: 1233, height: 694 };
  const pct = G.placeSnapScale(start, 0, middleOf(start), fit, 149.8, FRAME, 10);
  near(pct, 150);
  assert.equal(Math.round(fit.width * pct / 100), 1920);
  assert.equal(Math.round(fit.height * pct / 100), 1080);
});

test('the exact size wins over a side that is nearer', () => {
  const fit = { width: 1920, height: 1080 };
  const start = { x: 5, y: 0, width: 1800, height: 1012 };
  // The right side reaches the border first, at 99.5%, and 100% is still taken.
  near(G.placeSnapScale(start, 0, middleOf(start), fit, 99.6, FRAME, 10), 100);
});

test('a side that cannot move, the one on a ring, is no reason to land', () => {
  const fit = { width: 960, height: 540 };
  const start = { x: 0, y: 400, width: 480, height: 270 };
  const held = G.placeHeldPoint(start, 'br', 0, { ax: 0, ay: 0.5 }, false);
  assert.deepEqual(held, { x: 0, y: 535 });
  assert.equal(G.placeSnapScale(start, 0, held, fit, 60, FRAME, 10), null);
  // The side opposite the ring does land on the far border.
  near(G.placeSnapScale(start, 0, held, fit, 199.5, FRAME, 10), 200);
});

test('the opposite corner held, the far side lands on the border', () => {
  const fit = { width: 800, height: 450 };
  const start = { x: 100, y: 50, width: 800, height: 450 };
  const held = G.placeHeldPoint(start, 'br', 0, null, true);
  assert.deepEqual(held, { x: 100, y: 50 });
  near(G.placeSnapScale(start, 0, held, fit, 227, FRAME, 10), 1820 / 8);
});

test('the window has sizing corners and one turning dot', () => {
  const html = read('renderer', 'index.html');
  const box = html.slice(html.indexOf('id="placeBox"'), html.indexOf('id="placeAngle"'));
  assert.equal((box.match(/class="crop-corner [^"]*place-corner"/g) || []).length, 4);
  assert.equal((box.match(/crop-corner[^"]*text-rotor/g) || []).length, 0);
  assert.equal((box.match(/class="shape-rotor text-rotor place-rotor"/g) || []).length, 1);
});

test('a corner sets the scale, so the size stays the fit of the crop and the slider follows', () => {
  const src = read('renderer', 'app', 'placement.js');
  const part = src.slice(src.indexOf("querySelectorAll('.place-corner')"), src.indexOf('const PLACE_FIT_PAD'));
  assert.match(part, /const wanted = clamp\(startPct \* share/);
  assert.match(part, /placeScalePct = landed === null \? wanted : clamp\(landed/);
  assert.match(part, /placeDraftSize\(fit\)/);
  assert.match(part, /showPlaceScale\(\);/);
  assert.doesNotMatch(part, /placeDraft = /);
});
