'use strict';

// V5.5.1. Enabled, a Gravity keyframe's first setting. The user: "keyframe
// Enable true = apply all settings", "keyframe2 Enable false = stop physics
// at this keyframe2", and unticked it "disables all settings below".

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
const BALL = { kind: 'ball', r: 50 };
const BOX = { kind: 'box', w: 480, h: 270 };
const SMALL = { x: 720, y: 100, width: 480, height: 270 };
const KEY = { velocity: 0, spin: 0, drag: 50, bounce: 50 };
// The same as simulate takes it: Drag and Bounciness as shares of 1.
const SIM = { velocity: 0, spin: 0, drag: 0.5, bounce: 0.5 };

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

function run(body, throws, more = {}) {
  return G.simulate({ W, H, body, x: 960, y: 300, turn: 0, walls: false, until: 20, half: { x: 240, y: 135 }, ...more, throws });
}

/** Where the path has the picture at `t`: the last moment written down at or before it. */
function at(r, t) {
  let i = 0;
  while (i + 1 < r.t.length && r.t[i + 1] <= t + 1e-9) i += 1;
  return { x: r.x[i], y: r.y[i], turn: r.turn[i], i };
}

// ---- the setting ----

test('Enabled is the first setting a keyframe holds, a tick that starts ticked and gates the ones below', () => {
  const def = T.vfxKind('gravity');
  assert.deepEqual(def.keyed[0], { id: 'on', type: 'check', def: true, gate: true });
  assert.deepEqual(T.vfxKeyedIds('gravity'), ['on', 'gravity', 'airVelocity', 'airRotation', 'velocity', 'spin', 'drag', 'bounce']);
  // No other kind has a keyed tick, and none but this one gates.
  for (const id of T.VFX_KIND_IDS) {
    if (id === 'gravity') continue;
    assert.equal(T.vfxKind(id).keyed.some((s) => s.type === 'check' || s.gate), false, id);
  }
});

test('a keyframe kept before there was Enabled is enabled, and an unticked one stays unticked', () => {
  const v = T.vfxOf({ kind: 'gravity', keys: [{ id: 'a', t: 1, ...KEY }, { id: 'b', t: 3, ...KEY, on: false }] });
  assert.equal(v.keys[0].on, true, 'written by 5.3.0, without it');
  assert.equal(v.keys[1].on, false);
  assert.equal(T.vfxOf({ kind: 'gravity' }).on, true, 'a new Gravity starts enabled');
  // Only a real false is false: a file's nonsense is not taken as unticked.
  assert.equal(T.vfxOf({ kind: 'gravity', keys: [{ t: 1, ...KEY, on: 'no' }] }).keys[0].on, false);
  assert.equal(T.vfxOf({ kind: 'gravity', keys: [{ t: 1, ...KEY, on: true }] }).keys[0].on, true);
  // The statics' ticks are as they were: unticked unless written ticked.
  assert.equal(T.vfxOf({ kind: 'gravity' }).walls, false);
  // A round trip through a saved project keeps it.
  const again = T.vfxOf(JSON.parse(JSON.stringify(v)));
  assert.deepEqual(again.keys.map((k) => k.on), [true, false]);
});

test('Enabled holds from its keyframe to the next, like every figure of a throw', () => {
  const v = T.vfxOf({ kind: 'gravity', keys: [{ id: 'a', t: 1, ...KEY }, { id: 'b', t: 3, ...KEY, on: false }, { id: 'c', t: 5, ...KEY }] });
  assert.equal(T.vfxValuesAt(v, 0).on, true);
  assert.equal(T.vfxValuesAt(v, 2.99).on, true);
  assert.equal(T.vfxValuesAt(v, 3).on, false);
  assert.equal(T.vfxValuesAt(v, 4.99).on, false);
  assert.equal(T.vfxValuesAt(v, 9).on, true);
  // A keyframe put by the window keeps the tick as a tick.
  const put = T.putVfxKey(v, { id: 'b', t: 3, ...KEY, on: true });
  assert.equal(put.keys[1].on, true);
  // Deleting the unticked one leaves the others as they were.
  assert.deepEqual(T.removeVfxKey(v, 'b').keys.map((k) => [k.id, k.on]), [['a', true], ['c', true]]);
});

test('it starts at the first keyframe with Enabled ticked, and one with none ticked is no Gravity at all', () => {
  const l = (keys) => vid({ render: SMALL, vfx: [{ kind: 'gravity', keys }] });
  assert.deepEqual(T.gravityOf(l([{ t: 1, ...KEY }, { t: 3, ...KEY, on: false }])).throws.map((k) => [k.t, k.on]), [[1, true], [3, false]]);
  // The unticked ones before the first ticked one do nothing.
  assert.deepEqual(T.gravityOf(l([{ t: 1, ...KEY, on: false }, { t: 2, ...KEY, on: false }, { t: 4, ...KEY }])).throws.map((k) => k.t), [4]);
  assert.equal(T.gravityOf(l([{ t: 1, ...KEY, on: false }])), null);
  assert.equal(T.gravityOf(l([{ t: 1, ...KEY, on: false }, { t: 2, ...KEY, on: false }])), null);
  assert.equal(G.keysOf(l([{ t: 1, ...KEY, on: false }]), SRC, HD), null);
  // Its own checkbox in the line of VFX still switches all of it off.
  assert.equal(T.gravityOf(vid({ vfx: [{ kind: 'gravity', disabled: true, keys: [{ t: 1, ...KEY }] }] })), null);
  // A picture with only unticked keyframes stays where its own keyframes put it.
  const keys = G.keysOf(l([{ t: 1, ...KEY, on: false }, { t: 4, ...KEY }]), SRC, HD);
  assert.equal(keys[0].t, 4, 'from the ticked one on');
  assert.deepEqual(keys[0].dest, geometry.placementAt(l([]), 4, SRC, HD).dest);
});

// ---- the stop ----

test('an unticked keyframe stops the picture where it is, in the air, and nothing more is worked out', () => {
  for (const body of [BALL, BOX]) {
    const free = run(body, [{ t: 0, ...SIM, velocity: 300, spin: 90 }]);
    const r = run(body, [{ t: 0, ...SIM, velocity: 300, spin: 90 }, { t: 0.3, on: false, ...SIM }]);
    const then = at(free, 0.3);
    const held = at(r, 0.3);
    assert.ok(then.y < H - 300, body.kind + ' is still in the air at 0.3 s');
    // The same path until then, and within a pixel of it at the stop.
    for (let i = 0; i < held.i; i += 1) assert.equal(r.y[i], free.y[i]);
    assert.ok(Math.abs(held.x - then.x) <= 1 && Math.abs(held.y - then.y) <= 1, body.kind);
    assert.equal(held.turn, then.turn, 'turned as it was');
    assert.equal(r.rest, 0.3);
    // It is the last moment written down: after it the picture stands.
    assert.equal(r.t[r.t.length - 1], 0.3);
    // Its left and top edges on even pixels, as a picture that stands.
    assert.equal((held.x - 240) % 2, 0);
    assert.equal((held.y - 135) % 2, 0);
  }
});

test('a later keyframe with Enabled lets it go again from where it hung, with that keyframe\'s figures', () => {
  const r = run(BALL, [{ t: 0, ...SIM }, { t: 0.3, on: false, ...SIM }, { t: 2, velocity: 400, spin: 0, drag: 0, bounce: 0 }]);
  const hung = at(r, 0.3);
  // One moment at the stop and one where it goes again, the same place.
  const go = r.t.indexOf(2);
  assert.ok(go > 0);
  assert.equal(r.t[go - 1], 0.3);
  assert.equal(r.x[go], hung.x);
  assert.equal(r.y[go], hung.y);
  // From there it falls and moves right by the new throw.
  assert.ok(r.y[go + 30] > hung.y);
  assert.ok(r.x[go + 30] > hung.x + 20);
  assert.ok(r.rest > 2);
});

test('an unticked keyframe on a picture that already stands changes nothing, and two in one step go by the later', () => {
  const plain = run(BOX, [{ t: 0, ...SIM }]);
  assert.ok(plain.rest !== null && plain.rest < 10, 'it stands first');
  const late = run(BOX, [{ t: 0, ...SIM }, { t: 15, on: false, ...SIM }]);
  assert.deepEqual(late, plain);
  // Unticked then ticked a millisecond later: the ticked one throws it, so it does not hang.
  const both = run(BALL, [{ t: 0, ...SIM }, { t: 0.3, on: false, ...SIM }, { t: 0.301, ...SIM, velocity: 200 }]);
  assert.ok(both.t[both.t.length - 1] > 0.4);
  // Ticked then unticked a millisecond later: it hangs.
  const hangs = run(BALL, [{ t: 0, ...SIM }, { t: 0.3, ...SIM, velocity: 200 }, { t: 0.301, on: false, ...SIM }]);
  assert.ok(hangs.t[hangs.t.length - 1] < 0.31);
});

test('the preview and the encoder both hold the stopped picture: one list, standing after its last entry', () => {
  const l = vid({ render: SMALL, vfx: [{ kind: 'gravity', keys: [{ t: 2, ...KEY, spin: 120 }, { t: 2.4, ...KEY, on: false }] }] });
  const keys = G.keysOf(l, SRC, HD);
  const last = keys[keys.length - 1];
  assert.equal(last.t, 2.4);
  assert.ok(last.dest.y > SMALL.y + 50 && last.dest.y + last.dest.height < H - 50, 'in the air');
  assert.deepEqual(geometry.shownPlacementAt(keys, 9).dest, last.dest, 'and there until the end');
  assert.equal(geometry.shownPlacementAt(keys, 9).rotation, last.rotation);
  // The encoder is given the same list: its graph holds the last place after the last moment.
  const graph = composer.buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: { 'a.mp4': SRC } })
    .filter((a, i, all) => all[i - 1] === '-filter_complex').join(';');
  assert.ok(graph.includes(':eval=frame'));
});

// ---- Gravity, in G ----

/** The first moment a body's lowest point is on the floor, or its highest on the top edge. */
function landsAt(r, reach, top = false) {
  const i = r.y.findIndex((y) => (top ? y - reach <= 1e-6 : y + reach >= H - 1e-6));
  return i < 0 ? null : r.t[i];
}

test('Gravity is a figure a keyframe holds, -3.00 to 3.00 G kept in hundredths, 1 G the pull it always had', () => {
  const s = T.vfxKind('gravity').keyed.find((o) => o.id === 'gravity');
  assert.deepEqual([s.min, s.max, s.def, s.whole, s.scale, s.in], [-300, 300, 100, true, 100, 'filter']);
  // A keyframe written before it pulls with 1 G, and the throw is told in G.
  const l = vid({ render: SMALL, vfx: [{ kind: 'gravity', keys: [{ t: 1, ...KEY }, { t: 2, ...KEY, gravity: -250 }] }] });
  assert.deepEqual(T.gravityOf(l).throws.map((k) => k.gravity), [1, -2.5]);
  assert.equal(T.vfxOf({ kind: 'gravity', keys: [{ t: 1, ...KEY, gravity: 999 }] }).keys[0].gravity, 300, 'held to its range');
  assert.equal(T.vfxOf({ kind: 'gravity', keys: [{ t: 1, ...KEY, gravity: 12.6 }] }).keys[0].gravity, 13, 'a whole number');
  // Without a Gravity, simulate pulls with 1 G: the path of 5.3.0.
  assert.deepEqual(run(BALL, [{ t: 0, ...SIM }]), run(BALL, [{ t: 0, ...SIM, gravity: 1 }]));
});

test('twice the Gravity lands sooner by the square root of two, and 0 G floats', () => {
  const drop = H - 50 - 300;
  const one = landsAt(run(BALL, [{ t: 0, ...SIM }]), 50);
  const two = landsAt(run(BALL, [{ t: 0, ...SIM, gravity: 2 }]), 50);
  const g1 = G.TUNING.gravity * H;
  assert.ok(Math.abs(one - Math.sqrt((2 * drop) / g1)) < 0.01, 'at 1 G as it always was: ' + one);
  assert.ok(Math.abs(two - Math.sqrt((2 * drop) / (2 * g1))) < 0.01, 'at 2 G: ' + two);
  // At 0 G nothing pulls: it goes on as it was thrown, straight, turning, and never down.
  const free = run(BOX, [{ t: 0, ...SIM, gravity: 0, velocity: 100, spin: 45 }], { until: 4, walls: true });
  assert.ok(free.y.every((y) => y === 300), 'it never falls');
  assert.ok(Math.abs(free.x[free.x.length - 1] - (960 + 400)) < 1e-6, '100 pixels a second for four seconds');
  assert.ok(Math.abs(free.turn[free.turn.length - 1] - 180) < 1e-6, '45 degrees a second');
  assert.equal(free.rest, null);
});

test('below 0 G it falls onto the top of the frame by the same rules, upside down', () => {
  // The same throw turned upside down is the same path turned upside down: y from the top, the turn the other way.
  for (const body of [BALL, BOX]) {
    const throws = [{ t: 0, ...SIM, velocity: 150, spin: 200, airVelocity: 0.3, airRotation: 0.4 }];
    const down = run(body, throws, { y: H - 300, turn: 10 });
    const up = run(body, throws.map((k) => ({ ...k, gravity: -1, spin: -k.spin })), { turn: -10 });
    assert.equal(up.t.length, down.t.length, body.kind);
    for (let i = 0; i < up.t.length; i += 25) {
      assert.ok(Math.abs(up.x[i] - down.x[i]) < 1e-6, body.kind + ' x at ' + up.t[i]);
      assert.ok(Math.abs(up.y[i] - (H - down.y[i])) < 1e-6, body.kind + ' y at ' + up.t[i]);
      assert.ok(Math.abs(up.turn[i] + down.turn[i]) < 1e-6, body.kind + ' turn at ' + up.t[i]);
    }
    assert.equal(up.rest, down.rest, body.kind + ' stands at the same moment');
  }
  // A rectangle comes to rest lying flat against the top edge.
  const l = vid({ render: SMALL, vfx: [{ kind: 'gravity', keys: [{ t: 1, ...KEY, gravity: -100, spin: 90 }] }] });
  const last = G.keysOf(l, SRC, HD).slice(-1)[0];
  assert.ok(Math.abs(last.dest.y) <= 1, 'at the top: ' + last.dest.y);
  assert.equal(Math.abs(last.rotation % 90), 0, 'lying flat');
});

test('a later keyframe may turn the pull round: it slows, turns back and lands on the other edge', () => {
  const r = run(BALL, [{ t: 0, ...SIM }, { t: 0.3, ...SIM, gravity: -1 }], { until: 12 });
  const at3 = r.t.findIndex((t) => t >= 0.3);
  assert.ok(r.y[at3 + 5] > r.y[at3], 'still going down just after the keyframe');
  assert.ok(landsAt(r, 50, true) > 0.3, 'and then up onto the top edge');
  assert.ok(Math.abs(r.y[r.y.length - 1] - 50) < 1, 'where it ends: ' + r.y[r.y.length - 1]);
  // Stopped there by an unticked keyframe, it stays at the top: the hold is in the frame's own pixels.
  const held = run(BOX, [{ t: 0, ...SIM, gravity: -1 }, { t: 0.2, on: false, ...SIM }]);
  const last = held.y.length - 1;
  assert.equal((held.y[last] - 135) % 2, 0, 'its top edge on an even pixel');
  assert.ok(held.y[last] < 300, 'it had begun to rise');
});

// ---- air drag ----

test('Air drag (velocity) and Air drag (rotation) sit under Gravity, 0 to 100 %/s, 0 by default', () => {
  const keyed = T.vfxKind('gravity').keyed;
  assert.deepEqual(keyed.slice(1, 4).map((s) => [s.id, s.min, s.max, s.def, s.whole, s.in]),
    [['gravity', -300, 300, 100, true, 'filter'], ['airVelocity', 0, 100, 0, true, 'filter'], ['airRotation', 0, 100, 0, true, 'filter']]);
  // A keyframe written before them has none, and the throw is told in percent, the simulation in shares.
  const l = vid({ render: SMALL, vfx: [{ kind: 'gravity', keys: [{ t: 1, ...KEY }, { t: 2, ...KEY, airVelocity: 40, airRotation: 100 }] }] });
  assert.deepEqual(T.gravityOf(l).throws.map((k) => [k.airVelocity, k.airRotation]), [[0, 0], [40, 100]]);
  // 0 changes nothing ever: the very same path as without them.
  assert.deepEqual(run(BOX, [{ t: 0, ...SIM, velocity: 300, spin: 200 }]),
    run(BOX, [{ t: 0, ...SIM, velocity: 300, spin: 200, airVelocity: 0, airRotation: 0 }]));
});

test('in the air the speed and the spin go down in a straight line: 100 %/s to nothing within a second, 50 %/s in two', () => {
  // At 0 G nothing else touches them.
  const speedAt = (r, t) => {
    const i = r.t.findIndex((x) => x >= t - 1e-9);
    return [(r.x[i + 1] - r.x[i]) / (r.t[i + 1] - r.t[i]), (r.turn[i + 1] - r.turn[i]) / (r.t[i + 1] - r.t[i])];
  };
  const full = run(BALL, [{ t: 0, ...SIM, gravity: 0, velocity: 200, spin: 360, airVelocity: 1, airRotation: 1 }], { until: 3 });
  const [v0, s0] = speedAt(full, 0.5);
  assert.ok(Math.abs(v0 - 100) < 1.5, 'half the speed after half a second: ' + v0);
  assert.ok(Math.abs(s0 - 180) < 2.5, 'and half the spin: ' + s0);
  // Under a pixel a second it stands: at 1 s, 100 pixels further (half of 200 for one second), half a turn on.
  assert.ok(Math.abs(full.rest - 1) < 0.02, 'it stands at 1 s: ' + full.rest);
  assert.ok(Math.abs(full.x[full.x.length - 1] - 1060) < 2, String(full.x[full.x.length - 1]));
  assert.ok(Math.abs(full.turn[full.turn.length - 1] - 180) < 2, String(full.turn[full.turn.length - 1]));
  const half = run(BALL, [{ t: 0, ...SIM, gravity: 0, velocity: 200, airVelocity: 0.5 }], { until: 3 });
  assert.ok(Math.abs(speedAt(half, 1)[0] - 100) < 1.5, 'half after a second');
  assert.ok(Math.abs(half.rest - 2) < 0.02, 'nothing after two: ' + half.rest);
  // The one goes without the other.
  const spinOnly = run(BALL, [{ t: 0, ...SIM, gravity: 0, velocity: 200, spin: 360, airRotation: 1 }], { until: 2 });
  assert.ok(Math.abs(speedAt(spinOnly, 1.5)[0] - 200) < 0.1, 'the speed is left alone (moments are kept to the microsecond)');
  assert.equal(speedAt(spinOnly, 1.5)[1], 0, 'the spin is gone');
});

test('air drag does not slow the fall, and does nothing while it touches the floor or an edge', () => {
  // The fall is the same: it lands at the same moment from the same height.
  const plain = run(BALL, [{ t: 0, ...SIM, velocity: 200 }]);
  const slowed = run(BALL, [{ t: 0, ...SIM, velocity: 200, airVelocity: 1 }]);
  assert.equal(landsAt(slowed, 50), landsAt(plain, 50));
  for (let i = 0; i < 100; i += 10) assert.equal(slowed.y[i], plain.y[i]);
  assert.ok(slowed.x[100] < plain.x[100], 'but moves less far sideways');
  // A ball rolling on the floor from the start: the same path with air drag or without.
  const floor = { y: H - 50 };
  assert.deepEqual(run(BALL, [{ t: 0, ...SIM, bounce: 0, velocity: 300, spin: 200, airVelocity: 1, airRotation: 1 }], floor),
    run(BALL, [{ t: 0, ...SIM, bounce: 0, velocity: 300, spin: 200 }], floor));
  // Each touch starts the count again from the speed it leaves with: off an edge at 0 G it is slowed
  // for a whole second from there, by what it had when it came off.
  const wall = run(BALL, [{ t: 0, ...SIM, gravity: 0, velocity: 1000, airVelocity: 1 }], { x: 1700, walls: true, until: 3 });
  const back = wall.x.findIndex((x, i) => i > 0 && x < wall.x[i - 1]);
  assert.ok(back > 0, 'it came back off the right edge');
  assert.ok(wall.rest > wall.t[back] + 0.98 && wall.rest < wall.t[back] + 1.02, 'and stood a second after: ' + wall.rest + ' against ' + wall.t[back]);
});

// ---- the window ----

test('the window shows a tick as a tick, and an unticked gate turns off the settings below it', () => {
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes("  on: () => t('Enabled'),"));
  assert.ok(js.includes("out[id] = typeof value === 'boolean' ? value : Math.round(value) || 0;"), 'rounding leaves a tick alone');
  assert.equal(js.split('Math.round(value) || 0').length, 2, 'and no other rounding of keyed values is left');
  assert.ok(js.includes('next = timelineModel.putVfxKey(next, { ...vfxWhole(there), id: newKeyframeId(), t: at });'));
  assert.ok(js.includes("f.row.classList.toggle('vfx-field--off', gated);"));
  assert.ok(js.includes("for (const input of f.row.querySelectorAll('input, button, select')) input.disabled = gated;"));
  assert.ok(js.includes('if (f.s.gate && value === false) gated = true;'));
  assert.ok(read('renderer', 'style.css').includes('.vfx-field--off {'));
  const about = 'A keyframe with Enabled unticked stops it where it is.';
  assert.ok(js.includes(about));
  for (const file of ['en.json', 'de.json']) {
    const words = JSON.parse(read('locales', file));
    assert.ok(words.Enabled, file);
    assert.ok(Object.keys(words).some((k) => k.includes(about)), file);
  }
});

test('Simple Physics is its name, its Gravity reads in G, and while it is chosen the stage is the render frame', () => {
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes("gravity: { name: () => t('Simple Physics'),"));
  assert.ok(js.includes("  gravity: () => t('Gravity:'),"));
  assert.ok(js.includes("  gravity: 'G',"));
  // Kept in hundredths, shown and typed as G with two places.
  assert.ok(js.includes('const shownText = (value) => (scale === 1 ? String(value) : (value / scale).toFixed(places));'));
  assert.ok(js.includes('if (except !== box) box.value = shownText(value);'));
  assert.ok(read('renderer', 'app', 'gen', 'preview.js').includes('const n = parse ? parse(text) :'));
  // The stage: the render frame's size, and the track drawn into it by the main preview's own drawing.
  assert.ok(js.includes('size: () => (vfxShowsFrame() ? projectFrame() : vfxPic),'));
  assert.ok(js.includes('drawLayerInto(ctx, { width: fw * k, height: fh * k }, shown, undefined, undefined, at);'));
  // The settings shown are those of the keyframe an edit goes to.
  assert.ok(js.includes('const near = timelineModel.vfxKind(v.kind).hold ? timelineModel.vfxKeyNear(v, at, keyframeReach()) : null;'));
});
