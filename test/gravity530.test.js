'use strict';

// Gravity (5.3.0). A VFX under Physics that lets a track's picture fall onto
// the bottom of the render frame from its first keyframe on. Every figure of
// its rules is read from gravity.js TUNING, which is where they are set.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const geometry = require('../src/geometry');
const G = require('../src/gravity');
const composer = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HD = { width: 1920, height: 1080, fps: 30 };
const SRC = { width: 1920, height: 1080 };
const W = 1920;
const H = 1080;
const K = G.TUNING;
const g = K.gravity * H;
const RATE = 1 / K.step;
const BALL = { kind: 'ball', r: 50 };
const BOX = { kind: 'box', w: 480, h: 270 };
const graphsOf = (args) => args.filter((a, i) => args[i - 1] === '-filter_complex');
const near = (a, b, by, what) => assert.ok(Math.abs(a - b) <= by, (what || '') + ' ' + a + ' against ' + b);

function drop(body, thrown = {}, more = {}) {
  return G.simulate({
    W, H, body, x: 960, y: 300, turn: 0, walls: false, until: 60, ...more,
    throws: [{ t: 0, velocity: 0, spin: 0, drag: 0, bounce: 0.5, ...thrown }],
  });
}

/** The steps at which a ball is on the floor after having been off it. */
function landings(r, body) {
  const out = [];
  const low = H - body.r;
  for (let i = 1; i < r.t.length; i += 1) if (r.y[i] >= low - 1e-9 && r.y[i - 1] < low - 1e-9) out.push(i);
  return out;
}
const speedAt = (r, i) => (r.x[i + 1] - r.x[i]) * RATE;
const spinAt = (r, i) => (r.turn[i + 1] - r.turn[i]) * RATE;

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}
const SMALL = { x: 720, y: 100, width: 480, height: 270 };
const fall = (more = {}, key = {}) => ({ kind: 'gravity', ...more, keys: [{ t: 2, velocity: 0, spin: 0, drag: 50, bounce: 50, ...key }] });

// ---- the kind ----

test('Gravity is a kind under a heading of its own, Physics, and moves the picture without touching its pixels', () => {
  const def = T.vfxKind('gravity');
  assert.equal(def.where, 'whole');
  assert.equal(def.moves, true);
  assert.equal(def.hold, true);
  assert.deepEqual(def.statics.map((s) => [s.id, s.type]), [['body', 'choice'], ['walls', 'check']]);
  assert.deepEqual(def.statics[0].options, ['box', 'ball']);
  assert.deepEqual(def.keyed.map((s) => [s.id, s.min, s.max, s.def]),
    [['velocity', -300, 300, 0], ['spin', -1440, 1440, 0], ['drag', 0, 100, 50], ['bounce', 0, 100, 50]]);
  assert.deepEqual(T.VFX_GROUPS[T.VFX_GROUPS.length - 1], { id: 'physics', kinds: ['gravity'] });
  // No drawing of the picture ever has it on, with keyframes or without.
  assert.equal(T.vfxAt(T.vfxOf({ kind: 'gravity' }), 0).off, true);
  assert.equal(T.vfxEverOn(T.vfxOf(fall())), false);
  assert.equal(T.vfxGivesAlpha(vid({ vfx: [fall()] })), false);
});

test('it starts at its first keyframe: without one it does nothing, and each keyframe is a throw', () => {
  assert.equal(T.gravityOf(vid({ vfx: [{ kind: 'gravity' }] })), null, 'no keyframe, no fall');
  assert.equal(T.gravityOf(vid({})), null);
  const l = vid({ vfx: [{ kind: 'sepia' }, { kind: 'gravity', body: 'ball', walls: true, keys: [
    { t: 3, velocity: 40, spin: -90, drag: 100, bounce: 0 },
    { t: 1, velocity: 0, spin: 0, drag: 50, bounce: 50 },
  ] }] });
  const got = T.gravityOf(l);
  assert.equal(got.body, 'ball');
  assert.equal(got.walls, true);
  assert.deepEqual(got.throws, [
    { t: 1, velocity: 0, spin: 0, drag: 50, bounce: 50 },
    { t: 3, velocity: 40, spin: -90, drag: 100, bounce: 0 },
  ]);
  // Switched off by its checkbox it is off, and a second one on a track is left out.
  assert.equal(T.gravityOf(vid({ vfx: [{ ...fall(), disabled: true }] })), null);
  const two = vid({ vfx: [fall({ body: 'ball' }), fall({ body: 'box' }, { velocity: 99 })] });
  assert.equal(T.gravityOf(two).body, 'ball');
  // A text or a shape has no VFX, so none of this.
  assert.equal(T.gravityOf({ kind: 'gen', type: 'video', vfx: [fall()] }), null);
});

test('a keyframe\'s figures hold until the next one and never blend', () => {
  const v = T.vfxOf({ kind: 'gravity', keys: [
    { id: 'a', t: 1, velocity: 0, spin: 0, drag: 0, bounce: 0 },
    { id: 'b', t: 3, velocity: 100, spin: 200, drag: 100, bounce: 100 },
  ] });
  assert.equal(T.vfxKeyHeld(v, 0).id, 'a', 'before them all, the first');
  assert.equal(T.vfxKeyHeld(v, 2.9).id, 'a');
  assert.equal(T.vfxKeyHeld(v, 3).id, 'b');
  assert.equal(T.vfxKeyHeld(T.vfxOf({ kind: 'gravity' }), 1), null);
  assert.deepEqual(T.vfxValuesAt(v, 2), { velocity: 0, spin: 0, drag: 0, bounce: 0 });
  assert.deepEqual(T.vfxValuesAt(v, 5), { velocity: 100, spin: 200, drag: 100, bounce: 100 });
  // Another kind still blends.
  const bars = T.vfxOf({ kind: 'bars', keys: [{ t: 0, size: 0, mix: 0 }, { t: 2, size: 0.2, mix: 100 }] });
  assert.equal(T.vfxValuesAt(bars, 1).mix, 50);
});

test('one keyframe alone is a Gravity\'s usual state: deleting one of two leaves the other', () => {
  const v = T.vfxOf({ kind: 'gravity', keys: [
    { id: 'a', t: 1, velocity: 10, spin: 0, drag: 0, bounce: 0 },
    { id: 'b', t: 3, velocity: 100, spin: 200, drag: 100, bounce: 100 },
  ] });
  const one = T.removeVfxKey(v, 'a');
  assert.deepEqual(one.keys.map((k) => k.id), ['b']);
  assert.equal(one.keys[0].velocity, 100, 'it keeps its own figures');
  const none = T.removeVfxKey(one, 'b');
  assert.equal('keys' in none, false);
  assert.equal(none.velocity, 100, 'and the last leaves the VFX with its figures');
  // The kinds that blend keep the rule they had: the last pair goes together.
  const bars = T.vfxOf({ kind: 'bars', keys: [{ id: 'a', t: 0, size: 0, mix: 0 }, { id: 'b', t: 2, size: 0.2, mix: 100 }] });
  assert.equal('keys' in T.removeVfxKey(bars, 'b'), false);
});

// ---- the rules, on a circle ----

test('Bounciness is a share of the height: each jump reaches that share of the fall before it', () => {
  const low = H - BALL.r;
  for (const bounce of [0.25, 0.5, 0.75]) {
    const r = drop(BALL, { bounce });
    const at = landings(r, BALL);
    let fell = low - 300;
    for (let n = 0; n < 3; n += 1) {
      let top = Infinity;
      for (let i = at[n]; i < at[n + 1]; i += 1) top = Math.min(top, r.y[i]);
      const rose = low - top;
      near(rose / fell, bounce, 0.01, 'bounce ' + bounce + ' jump ' + n);
      fell = rose;
    }
  }
  // None at all: it stays where it came down.
  const dead = drop(BALL, { bounce: 0 });
  assert.equal(landings(dead, BALL).length, 1);
  assert.equal(dead.y[dead.y.length - 1], low);
  // All of it: back to the height it was let go at, also half a minute on.
  const full = drop(BALL, { bounce: 1 }, { until: 30 });
  assert.equal(full.rest, null, 'it never stands');
  let top = Infinity;
  for (let i = full.t.length - 400; i < full.t.length; i += 1) top = Math.min(top, full.y[i]);
  near((low - top) / (low - 300), 1, 0.01, 'the last jump');
});

test('Drag turns spin into sideways speed at a touch: all of it at 100, half at 50, a circle 100 across at one turn a second by 314', () => {
  const full = drop(BALL, { spin: 360, drag: 1, bounce: 0.5 });
  const [first] = landings(full, BALL);
  near(speedAt(full, first), 100 * Math.PI, 0.5, 'the user\'s figure');
  near(spinAt(full, first), 0, 1e-6, 'and no spin is left');
  const half = drop(BALL, { spin: 360, drag: 0.5, bounce: 0.5 });
  const [one, two] = landings(half, BALL);
  near(speedAt(half, one), 50 * Math.PI, 0.5);
  near(spinAt(half, one), 180 * (1 - K.touchLoss), 0.01, 'half the spin kept, less the touch');
  // The second touch turns half of what the first left, and takes the touch's share off the speed.
  near(speedAt(half, two), 50 * Math.PI * (1 - K.touchLoss) + 0.5 * (180 * (1 - K.touchLoss)) * Math.PI / 180 * 50, 0.5);
  // The other way round it goes left, and with no Drag it goes nowhere.
  assert.ok(speedAt(drop(BALL, { spin: -360, drag: 1 }), first) < -300);
  const none = drop(BALL, { spin: 360, drag: 0 });
  assert.equal(none.x.every((x) => x === 960), true);
});

test('every touch of the floor takes its share off the sideways speed', () => {
  const r = drop(BALL, { velocity: 400, bounce: 0.6 });
  const at = landings(r, BALL);
  near(speedAt(r, at[0] - 3), 400, 1e-6, 'none in the air');
  near(speedAt(r, at[0]), 400 * (1 - K.touchLoss), 1e-6);
  near(speedAt(r, at[1]), 400 * (1 - K.touchLoss) ** 2, 1e-6);
  near(speedAt(r, at[2]), 400 * (1 - K.touchLoss) ** 3, 1e-6);
});

test('on the floor it fades and does not stop at once, and below the stop it stands for good', () => {
  const r = drop(BALL, { velocity: 600, bounce: 0 });
  const [down] = landings(r, BALL);
  const second = Math.round(RATE);
  const v0 = speedAt(r, down + 1);
  near(speedAt(r, down + 1 + second) / v0, (1 - K.touchLoss) ** (1 / K.floorTouch), 0.002, 'one touch every floorTouch seconds');
  assert.ok(r.rest > 5, 'no immediate stop: ' + r.rest);
  // The last step it moved was slower than the stop, and then nothing more is worked out.
  const n = r.t.length;
  assert.equal(r.t[n - 1], Math.round(r.rest * 1e6) / 1e6);
  assert.ok(Math.abs(speedAt(r, n - 3)) < K.stop * 1.01);
  assert.ok(Math.abs(speedAt(r, n - 200)) > K.stop);
  // Where it stands, its left edge is on an even pixel, for the encoder lays it on one.
  assert.equal(Math.abs((r.x[n - 1] - BALL.r) % 2), 0);
  assert.ok(Math.abs(r.x[n - 1] - r.x[n - 2]) <= 1);
  assert.ok(n < 60 * RATE, 'the path ends where it stands');
});

test('Velocity is counted in the frame: the same throw is the same picture at any size', () => {
  const run = (w, h) => G.simulate({
    W: w, H: h, body: { kind: 'ball', r: h * 0.05 }, x: w / 2, y: h * 0.3, turn: 0, walls: false, until: 3,
    throws: [{ t: 0, velocity: 1.0 * h, spin: 200, drag: 0.5, bounce: 0.7 }],
  });
  const a = run(640, 480);
  const b = run(3840, 2160);
  assert.equal(a.t.length, b.t.length);
  for (let i = 0; i < a.t.length; i += 20) {
    near(a.y[i] / 480, b.y[i] / 2160, 1e-9, 'height at step ' + i);
    near((a.x[i] - 320) / 480, (b.x[i] - 1920) / 2160, 1e-9, 'way at step ' + i);
    near(a.turn[i], b.turn[i], 1e-6, 'turn at step ' + i);
  }
  // 100 is the frame's height a second.
  near((a.x[100] - a.x[0]) / (100 * K.step), 480, 1e-6);
  near((b.x[100] - b.x[0]) / (100 * K.step), 2160, 1e-6);
});

test('with Edge Collision it comes back off the left and right edges with the touch\'s share less, without it it leaves', () => {
  const kept = drop(BALL, { velocity: 2000, bounce: 0.6 }, { walls: true, until: 20 });
  assert.ok(kept.x.every((x) => x >= BALL.r - 1e-6 && x <= W - BALL.r + 1e-6));
  const hit = kept.x.findIndex((x, i) => i > 0 && x < kept.x[i - 1]);
  near(speedAt(kept, hit), -2000 * (1 - K.touchLoss), 1e-6, 'back, 5% slower');
  const gone = drop(BALL, { velocity: 2000, bounce: 0.6 }, { walls: false, until: 20 });
  assert.ok(gone.x[gone.x.length - 1] > W + BALL.r, 'out of shot');
  // One that cannot fit between the edges ignores them.
  const wide = drop({ kind: 'ball', r: 1000 }, { velocity: 500 }, { walls: true, y: -200, until: 5 });
  assert.ok(wide.x[wide.x.length - 1] > 960 + 500);
});

test('the same settings always give the same path', () => {
  const a = drop(BOX, { velocity: 700, spin: 300, drag: 0.6, bounce: 0.7 }, { turn: 25, walls: true });
  const b = drop(BOX, { velocity: 700, spin: 300, drag: 0.6, bounce: 0.7 }, { turn: 25, walls: true });
  assert.deepEqual(a, b);
});

// ---- a rectangle ----

test('a rectangle comes to rest lying flat on the floor, however it was let go', () => {
  for (const [w, h] of [[480, 270], [270, 480], [400, 400], [900, 60]]) {
    for (const turn of [0, 20, 45, 60]) {
      for (const thrown of [{}, { spin: 300 }, { spin: -900, drag: 1, bounce: 0 }, { velocity: 1200, bounce: 0.9 }, { drag: 0, bounce: 0.75, spin: 300 }]) {
        for (const walls of [true, false]) {
          const r = G.simulate({ W, H, body: { kind: 'box', w, h }, x: 960, y: 300, turn, walls, until: 90,
            throws: [{ t: 0, velocity: 0, spin: 0, drag: 0.5, bounce: 0.5, ...thrown }] });
          const what = [w, h, turn, JSON.stringify(thrown), walls].join(' ');
          assert.notEqual(r.rest, null, what + ': stands');
          const end = r.turn[r.turn.length - 1];
          assert.equal(Math.abs(end - Math.round(end / 90) * 90) < 1e-9, true, what + ': flat');
          // On its side, a top edge that would fall on an odd pixel lies one lower instead.
          const upright = Math.abs(Math.round(end / 90)) % 2 === 1;
          const high = (upright ? w : h) / 2;
          const sunk = Math.abs(H - high - h / 2) % 2 === 1 ? 1 : 0;
          near(r.y[r.y.length - 1], H - high + sunk, 1e-9, what + ': on the floor');
          assert.equal(Math.abs((r.x[r.x.length - 1] - w / 2) % 2), 0, what + ': on an even pixel');
        }
      }
    }
  }
});

test('a rectangle never goes through the floor, and with Edge Collision never past an edge', () => {
  const r = drop(BOX, { velocity: 1500, spin: 500, drag: 0.5, bounce: 0.8 }, { turn: 30, walls: true });
  let lowest = 0;
  let side = 0;
  for (let i = 0; i < r.t.length; i += 1) {
    const a = r.turn[i] * Math.PI / 180;
    const hx = (BOX.w * Math.abs(Math.cos(a)) + BOX.h * Math.abs(Math.sin(a))) / 2;
    const hy = (BOX.w * Math.abs(Math.sin(a)) + BOX.h * Math.abs(Math.cos(a))) / 2;
    lowest = Math.max(lowest, r.y[i] + hy - H);
    side = Math.max(side, hx - r.x[i], r.x[i] + hx - W);
  }
  assert.ok(lowest < 0.01, 'below the floor by ' + lowest);
  assert.ok(side < 0.01, 'past an edge by ' + side);
});

test('a corner on the floor pushes a rectangle sideways by its spin, the way it turns, and less the more it bounces', () => {
  const end = (thrown) => {
    const r = drop(BOX, { drag: 0.5, bounce: 0.3, ...thrown });
    return r.x[r.x.length - 1] - 960;
  };
  // The first landing's push: spin, corner distance, Drag and what Bounciness leaves of it.
  const push = (spin, bounce) => {
    const r = drop(BOX, { spin, drag: 0.5, bounce });
    const at = r.x.findIndex((x) => x !== 960);
    return at < 0 ? 0 : speedAt(r, at);
  };
  const reach = Math.hypot(BOX.w, BOX.h) / 2;
  near(push(300, 0.3), (300 * Math.PI / 180) * reach * 0.5 * 0.7, 0.01, 'clockwise goes right');
  near(push(-300, 0.3), -(300 * Math.PI / 180) * reach * 0.5 * 0.7, 0.01, 'the other way goes left');
  near(push(300, 0.8), (300 * Math.PI / 180) * reach * 0.5 * 0.2, 0.01);
  assert.equal(push(300, 1), 0, 'all bounce, no push');
  near(end({ spin: 300 }), -end({ spin: -300 }), 1e-6, 'a mirror of each other');
  assert.equal(end({ spin: 300, drag: 0 }), 0, 'no Drag, no push');
  // One that falls flat and does not spin goes straight down and never turns.
  const straight = drop(BOX, { bounce: 0.8 });
  assert.equal(straight.x.every((x) => x === 960), true);
  assert.equal(straight.turn.every((t) => t === 0), true);
  // The push is never more than the spin gives up for it: all the Drag there is, no bounce, a hard spin.
  const hard = drop(BOX, { spin: 1440, drag: 1, bounce: 0 }, { turn: 20, walls: true, until: 30 });
  let fastest = 0;
  for (let i = 1; i < hard.t.length; i += 1) fastest = Math.max(fastest, Math.abs(hard.x[i] - hard.x[i - 1]) * RATE);
  assert.ok(fastest < 12 * H, 'never faster sideways than ' + fastest);
  assert.notEqual(hard.rest, null);
});

test('a picture let go while it reaches below the floor is brought up, not put up in one jump', () => {
  const r = G.simulate({ W, H, body: BOX, x: 960, y: 1100, turn: 0, walls: false, until: 5,
    throws: [{ t: 0, velocity: 0, spin: 0, drag: 0.5, bounce: 0.5 }] });
  let most = 0;
  for (let i = 1; i < r.t.length; i += 1) most = Math.max(most, Math.abs(r.y[i] - r.y[i - 1]));
  assert.ok(most <= K.rise * H * K.step + 1e-6, 'a step of ' + most);
  near(r.y[r.y.length - 1], H - BOX.h / 2, 1e-9);
  assert.notEqual(r.rest, null);
});

test('a later keyframe throws the picture again from where it lies', () => {
  const r = G.simulate({ W, H, body: BALL, x: 960, y: 300, turn: 0, walls: false, until: 30, throws: [
    { t: 0, velocity: 0, spin: 0, drag: 0, bounce: 0 },
    { t: 10, velocity: 500, spin: 0, drag: 0, bounce: 0 },
  ] });
  assert.ok(r.rest > 10);
  const at = r.t.findIndex((t) => t >= 10);
  assert.equal(r.x[at], 960, 'it lay still until then');
  assert.ok(r.x[r.x.length - 1] > 960 + 500);
  // Nothing is written down for the time it lay there: one moment at its start and one at its end.
  assert.ok(r.t[at - 1] < 2 && r.t[at] === 10);
});

// ---- the path as placements ----

test('thinning keeps the moments a straight blend cannot do without', () => {
  const r = drop(BOX, { velocity: 700, spin: 300, bounce: 0.7 }, { turn: 25, walls: true });
  const reach = Math.hypot(BOX.w, BOX.h) / 2;
  const keep = G.thin(r, reach);
  assert.equal(keep[0], 0);
  assert.equal(keep[keep.length - 1], r.t.length - 1);
  assert.ok(keep.length < r.t.length / 4, keep.length + ' of ' + r.t.length);
  let k = 0;
  let worst = 0;
  for (let i = 0; i < r.t.length; i += 1) {
    while (keep[k + 1] < i) k += 1;
    const a = keep[k];
    const b = keep[Math.min(k + 1, keep.length - 1)];
    const u = b === a ? 0 : (r.t[i] - r.t[a]) / (r.t[b] - r.t[a]);
    worst = Math.max(worst, Math.abs(r.x[a] + (r.x[b] - r.x[a]) * u - r.x[i]), Math.abs(r.y[a] + (r.y[b] - r.y[a]) * u - r.y[i]),
      Math.abs(r.turn[a] + (r.turn[b] - r.turn[a]) * u - r.turn[i]) * Math.PI / 180 * reach);
  }
  assert.ok(worst <= K.keep + 1e-9, 'off by ' + worst);
});

test('a layer with Gravity is placed by its fall: where it was until the keyframe, the path from there, its size kept', () => {
  assert.equal(G.keysOf(vid({ render: SMALL }), SRC, HD), null);
  assert.equal(G.keysOf(vid({ render: SMALL, vfx: [{ kind: 'gravity' }] }), SRC, HD), null);
  const l = vid({ render: SMALL, rotation: 15, vfx: [fall()] });
  const keys = G.keysOf(l, SRC, HD);
  const still = geometry.placementAt(l, 2, SRC, HD);
  assert.equal(keys[0].t, 2);
  assert.deepEqual(keys[0].dest, still.dest);
  assert.equal(keys[0].turn, 15);
  for (const k of keys) {
    assert.deepEqual([k.dest.width, k.dest.height], [480, 270]);
    assert.deepEqual(k.src, still.src);
    assert.equal(k.window, null);
    assert.ok(Math.abs(k.rotation) <= 180);
  }
  for (let i = 1; i < keys.length; i += 1) assert.ok(keys[i].t > keys[i - 1].t);
  const last = keys[keys.length - 1];
  assert.ok(last.t < 10, 'it stands before the clip ends');
  near(last.dest.y + 135, H - 135, 1e-9, 'lying on the floor');
  assert.equal(last.rotation, 0);
  // The list is the one both renderers blend.
  const mid = geometry.shownPlacementAt(keys, 2.2);
  near(mid.dest.y, SMALL.y + (g * 0.2 * 0.2) / 2, 0.3, 'a fifth of a second of falling');
  // A circle is the one that fits inside the picture.
  const ball = G.keysOf(vid({ render: SMALL, vfx: [fall({ body: 'ball' })] }), SRC, HD);
  near(ball[ball.length - 1].dest.y + 135, H - 135, 1e-9);
  // One whose keyframe lies past the clip's end never starts.
  assert.equal(G.keysOf(vid({ render: SMALL, vfx: [fall({}, { t: 10 })] }), SRC, HD), null);
});

test('the picture\'s own keyframes move it until the fall begins, and from the place they had put it', () => {
  const l = vid({
    keyframes: [{ id: 'a', t: 0, render: SMALL }, { id: 'b', t: 4, render: { ...SMALL, x: 1120 } }],
    vfx: [fall()],
  });
  const keys = G.keysOf(l, SRC, HD);
  assert.equal(keys[0].t, 0);
  assert.equal(keys[0].dest.x, 720);
  assert.equal(keys[1].t, 2);
  assert.equal(keys[1].dest.x, 920, 'half way along at the keyframe');
  assert.equal(keys[1].dest.y, 100);
  assert.ok(keys.every((k) => k.t <= 2 || k.dest.x === 920), 'straight down from there: the move is over');
  // A keyframe trimmed off before the clip's start: it is already falling when the clip begins.
  const early = G.keysOf(vid({ render: SMALL, vfx: [fall({}, { t: -0.5 })] }), SRC, HD);
  assert.equal(early[0].t, -0.5);
  assert.ok(geometry.shownPlacementAt(early, 0).dest.y > SMALL.y + 200);
});

// ---- the export ----

test('a long list of moments is asked by halves, a short one is written as it always was', () => {
  const times = [];
  const values = [];
  for (let i = 0; i < 1500; i += 1) {
    times.push(i / 240);
    values.push(Math.sin(i / 37) * 400);
  }
  const read = (expr) => new Function('t', 'iff', 'lt', 'clip', 'return ' + expr.replace(/\\,/g, ',').replace(/\bif\(/g, 'iff('));
  const iff = (c, a, b) => (c ? a : b);
  const lt = (a, b) => (a < b ? 1 : 0);
  const clip = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const long = composer.piecewise(times, values);
  let depth = 0;
  let deepest = 0;
  for (const ch of long) {
    if (ch === '(') deepest = Math.max(deepest, depth += 1);
    else if (ch === ')') depth -= 1;
  }
  assert.ok(deepest < 40, 'nested ' + deepest + ' deep');
  const f = read(long);
  for (const t of [-1, 0, 0.0021, 1.2345, 3.3333, 6.2, 6.245, 99]) {
    const i = Math.min(times.length - 2, Math.max(0, Math.floor(t * 240)));
    const u = Math.min(1, Math.max(0, (t - times[i]) / (times[i + 1] - times[i])));
    // The encoder is handed figures of six places.
    near(f(t, iff, lt, clip), values[i] + (values[i + 1] - values[i]) * u, 0.01, 't ' + t);
  }
  // Up to PIECEWISE_CHAIN moments nothing changes, to the letter.
  assert.equal(composer.piecewise([0, 1, 2], [10, 20, 40]),
    '(if(lt(t\\,1.0)\\,(10.0+10.0*clip((t-0.0)/1.0\\,0\\,1))\\,(20.0+20.0*clip((t-1.0)/1.0\\,0\\,1))))');
  const edge = composer.PIECEWISE_CHAIN;
  const chain = composer.piecewise(times.slice(0, edge), values.slice(0, edge));
  const tree = composer.piecewise(times.slice(0, edge + 1), values.slice(0, edge + 1));
  assert.ok(chain.endsWith(')'.repeat(edge - 1)), 'one inside the other');
  assert.equal(tree.endsWith(')'.repeat(20)), false);
  for (const t of [0, 0.05, 0.2, 0.24]) near(read(chain)(t, iff, lt, clip), read(tree)(t, iff, lt, clip), 0.01);
});

test('the encoder lays a falling picture by the list of its fall, turned where it turns', () => {
  const args = (l) => composer.buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: { 'a.mp4': SRC } });
  const plain = graphsOf(args(vid({ render: SMALL }))).join(';');
  assert.equal(plain.includes('eval=frame'), false);
  // Straight down, never turned: placed frame by frame, and no turn in the graph.
  const down = graphsOf(args(vid({ render: SMALL, vfx: [fall()] }))).join(';');
  assert.ok(down.includes(':eval=frame'));
  assert.equal(down.includes('rotate='), false);
  // With a spin it is turned by the frame's own angle.
  const spun = graphsOf(args(vid({ render: SMALL, vfx: [fall({}, { spin: 200 })] }))).join(';');
  assert.ok(spun.includes("rotate=a='(if(lt(t\\,"));
  // The square it is turned in is a pixel wider either side where half the picture is odd (270 high: 135),
  // so the picture is laid on an even place in it and the square on an even place of the frame.
  assert.ok(spun.includes('color=c=black@0:s=556x558:'), 'the square');
  assert.ok(spun.includes(":ow=556:oh=558:c=none"));
  // A Gravity is no filter on the picture: nothing of it reaches the layer's VFX.
  assert.equal(/vfx|gbrp|geq/.test(down), false);
  // And a selection is not exported without what is before it: the fall is counted from its keyframe.
  const l = vid({ render: SMALL, vfx: [fall()] });
  assert.equal(composer.windowSkip(l, { skips: { v: { k: 30, ss: 1, raw: '1' } } }, { 'a.mp4': SRC }, HD), null);
});

// ---- the tables and the window ----

test('Gravity has a row in every table and a name for everything, in both languages', () => {
  const rows = (file, table) => {
    const text = read(...file);
    const body = text.slice(text.indexOf('const ' + table + ' = {'));
    return [...body.slice(0, body.indexOf('\n};')).matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]);
  };
  for (const [file, table] of [[['renderer', 'app', 'compositor.js'], 'VFX_PREVIEW'], [['renderer', 'app', 'export.js'], 'VFX_EXPORT'],
    [['src', 'composer.js'], 'VFX_FILTERS'], [['renderer', 'app', 'vfx.js'], 'VFX_UI']]) {
    const all = rows(file, table);
    assert.equal(all[all.indexOf('echo') + 1], 'gravity', table);
  }
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes("gravity: { name: () => t('Gravity'),"));
  assert.ok(js.includes("  physics: () => t('Physics'),"));
  for (const line of ["  body: () => t('Collision Shape:'),", "  walls: () => t('Edge Collision'),", "  velocity: () => t('Velocity:'),",
    "  spin: () => t('Rotational Speed:'),", "  drag: () => t('Drag:'),", "  bounce: () => t('Bounciness:'),",
    "    box: () => t('Rectangle'),", "    ball: () => t('Circle'),"]) assert.ok(js.includes(line), line);
  for (const file of ['en.json', 'de.json']) {
    const words = JSON.parse(read('locales', file));
    for (const key of ['Physics', 'Gravity', 'Collision Shape:', 'Rectangle', 'Circle', 'Edge Collision', 'Velocity:', 'Rotational Speed:',
      'Drag:', 'Bounciness:']) assert.ok(words[key], file + ': ' + key);
  }
  // The window's script reads the fall from the same file the encoder does.
  const html = read('renderer', 'index.html');
  assert.ok(html.indexOf('src/geometry.js') < html.indexOf('src/gravity.js'));
  assert.ok(read('src', 'composer.js').includes("const gravity = require('./gravity');"));
});

test('the preview, the encoder and the mask all ask the one list, and the window edits the throw in force', () => {
  const comp = read('renderer', 'app', 'compositor.js');
  assert.ok(comp.includes('const keys = layerGravity.keysOf(layer, source, frame)'));
  assert.ok(comp.includes('if (timelineModel.gravityOf(l)) return true;'), 'a falling picture is drawn every frame');
  const exp = read('renderer', 'app', 'export.js');
  assert.ok(exp.includes('const shown = layerGravity.keysOf(l, source, frame)'));
  assert.ok(read('src', 'composer.js').includes('const motion = gravity.keysOf(l, sources[l.src] || null, project)'));
  const win = read('renderer', 'app', 'vfx.js');
  // A change goes to the keyframe in force and makes none; the first keyframe is not doubled at the clip's start.
  assert.ok(win.includes('const held = near || timelineModel.vfxKeyHeld(v, at);'));
  assert.ok(win.includes('setVfx(timelineModel.putVfxKey(v, { ...held, ...props }));'));
  assert.ok(win.includes('if (!v.keys && at > reach && !starts) next = timelineModel.putVfxKey(next, { ...v, id: newKeyframeId(), t: 0 });'));
});
