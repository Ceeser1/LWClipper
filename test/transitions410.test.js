'use strict';

// V4.10. Transitions: what a fade does to the picture in place of fading it.
// The model (settings, progress, an overlap's two halves), where a slide and
// a zoom put the picture, the mattes' drawing, the export's graph, and the
// window and its ways in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const G = require('../src/geometry');
const D = require('../src/genDraw');
const P = require('../src/project');
const { buildComposeArgs, spillGraph, GRAPH_ARG_MAX } = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = read('renderer', 'index.html');
const CLIPS = read('renderer', 'app', 'clips.js');
const WINDOW = read('renderer', 'app', 'transition.js');
const COMPOSITOR = read('renderer', 'app', 'compositor.js');
const EXPORT = read('renderer', 'app', 'export.js');

const HD = { width: 1920, height: 1080, fps: 30 };
const SRC = { 'a.mp4': { width: 1920, height: 1080 }, 'b.mp4': { width: 1920, height: 1080 } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

function graphOf(args) {
  return args[args.indexOf('-filter_complex') + 1];
}

const WIPE = { kind: 'wipe', angle: 0, soft: 0 };
const SLIDE = { kind: 'slide', angle: 0 };

// ---- the settings ----

test('a fade is plain until it is given a transition, and a file from before reads as plain', () => {
  const l = vid({});
  assert.equal(l.fadeInTransition, null);
  assert.equal(l.fadeOutTransition, null);
  assert.deepEqual(T.transitionsOf(l), { in: null, out: null });
  for (const junk of [undefined, null, 'wipe', 7, {}, { kind: 'nonsense' }, { kind: 'fade' }]) {
    assert.equal(T.transitionSettingsOf(junk), null);
  }
});

test('each kind has its own settings, held to their ranges', () => {
  assert.deepEqual(T.TRANSITION_KINDS, ['wipe', 'iris', 'clock', 'blinds', 'dissolve', 'slide', 'zoom']);
  assert.deepEqual(T.transitionSettingsOf({ kind: 'wipe', angle: -45, soft: 7 }), { kind: 'wipe', angle: 315, soft: 1 });
  assert.deepEqual(T.transitionSettingsOf({ kind: 'iris', shape: 'hexagon', reverse: 1 }),
    { kind: 'iris', shape: 'circle', soft: 0.1, reverse: false });
  assert.deepEqual(T.transitionSettingsOf({ kind: 'iris', shape: 'star', soft: 0, reverse: true }),
    { kind: 'iris', shape: 'star', soft: 0, reverse: true });
  assert.deepEqual(T.transitionSettingsOf({ kind: 'clock', start: 450, clockwise: false }),
    { kind: 'clock', start: 90, clockwise: false, soft: 0.05 });
  assert.deepEqual(T.transitionSettingsOf({ kind: 'blinds', count: 500, vertical: true, soft: 0.3 }),
    { kind: 'blinds', count: 64, vertical: true, soft: 0.3 });
  assert.deepEqual(T.transitionSettingsOf({ kind: 'dissolve', rows: 1 }), { kind: 'dissolve', rows: 2, soft: 0.2 });
  // A slide goes along a side, and a zoom turns by quarters.
  assert.deepEqual(T.transitionSettingsOf({ kind: 'slide', angle: 100 }), { kind: 'slide', angle: 90 });
  assert.deepEqual(T.transitionSettingsOf({ kind: 'slide', angle: 350 }), { kind: 'slide', angle: 0 });
  assert.deepEqual(T.transitionSettingsOf({ kind: 'zoom', turns: 1.3 }), { kind: 'zoom', turns: 1.25 });
  assert.deepEqual(T.transitionSettingsOf({ kind: 'zoom', turns: -9 }), { kind: 'zoom', turns: -4 });
  for (const kind of T.TRANSITION_KINDS) {
    assert.deepEqual(T.transitionSettingsOf(T.transitionDefault(kind)), T.transitionDefault(kind), kind);
  }
});

test('a transition is kept by the layer and by the project file, and a sound never has one', () => {
  const l = vid({ fadeIn: 1, fadeInTransition: { kind: 'clock' }, fadeOutTransition: SLIDE });
  assert.deepEqual(l.fadeInTransition, { kind: 'clock', start: 270, clockwise: true, soft: 0.05 });
  const out = P.parse(P.stringify(P.serialise({ layers: [l], project: HD, trim: { start: 0, end: 10 } })));
  assert.equal(out.ok, true);
  const back = T.createLayer(out.doc.layers[0]);
  assert.deepEqual(back.fadeInTransition, l.fadeInTransition);
  assert.deepEqual(back.fadeOutTransition, SLIDE);
  const sound = T.createLayer({ type: 'audio', src: 'a.mp3', sourceDuration: 9, fadeInTransition: WIPE });
  assert.equal(sound.fadeInTransition, null);
  // A text is a picture and has them.
  const text = T.createLayer({ kind: 'gen', gen: { form: 'text' }, fadeOutTransition: WIPE });
  assert.deepEqual(text.fadeOutTransition, WIPE);
});

// ---- how far it has got ----

test('an end with a transition is not faded: the transition is what happens there', () => {
  const plain = vid({ fadeIn: 2, fadeOut: 2 });
  assert.ok(near(T.fadeAlphaAt(plain, 1), 0.5));
  const l = vid({ fadeIn: 2, fadeOut: 2, fadeInTransition: WIPE });
  assert.equal(T.fadeAlphaAt(l, 1), 1, 'whole all through its way in');
  assert.ok(near(T.fadeAlphaAt(l, 9), 0.5), 'the other end still fades');
  assert.deepEqual(T.alphaFadesOf(l), { in: 0, out: 2 });
  assert.deepEqual(T.fadesOf(l), { in: 2, out: 2 }, 'the fade keeps its length, which is how long the transition takes');
});

test('transitionAt is the half a layer is going through and how far, by the fade\'s curve', () => {
  const l = vid({ start: 5, fadeIn: 2, fadeOut: 4, fadeInTransition: WIPE, fadeOutTransition: SLIDE, fadeInCurve: 'quadIn' });
  assert.deepEqual(T.transitionAt(l, 5), { half: 'in', transition: WIPE, e: 0 });
  assert.deepEqual(T.transitionAt(l, 6), { half: 'in', transition: WIPE, e: 0.25 });
  assert.equal(T.transitionAt(l, 7), null, 'at the end of its way in the picture is simply there');
  assert.equal(T.transitionAt(l, 9), null);
  assert.equal(T.transitionAt(l, 11), null, 'and at the start of its way out');
  assert.deepEqual(T.transitionAt(l, 13), { half: 'out', transition: SLIDE, e: 0.5 });
  // No transition, or no fade for it to take, is none.
  assert.equal(T.transitionAt(vid({ fadeIn: 2 }), 1), null);
  assert.equal(T.transitionAt(vid({ fadeInTransition: WIPE }), 0), null);
});

test('only the kinds that move the picture have steps, two for a straight curve', () => {
  assert.deepEqual(T.transitionSteps(vid({ fadeIn: 2, fadeInTransition: WIPE })), []);
  const straight = T.transitionSteps(vid({ fadeIn: 2, fadeInTransition: SLIDE }));
  assert.deepEqual(straight, [
    { t: 0, half: 'in', transition: SLIDE, e: 0 },
    { t: 2, half: 'in', transition: SLIDE, e: 1 },
  ]);
  const eased = T.transitionSteps(vid({ fadeOut: 3, fadeOutTransition: { kind: 'zoom', turns: 1 }, fadeOutCurve: 'sineInOut' }));
  assert.equal(eased.length, T.TRANSITION_STEPS + 1);
  assert.equal(eased[0].t, 7);
  assert.equal(eased[eased.length - 1].t, 10);
  assert.ok(near(eased[T.TRANSITION_STEPS / 2].e, 0.5));
  assert.ok(eased.every((s, i) => !i || s.e >= eased[i - 1].e));
  assert.equal(T.transitionMoves(WIPE), false);
  assert.equal(T.transitionMoves(SLIDE), true);
  assert.equal(T.transitionMovesOld(SLIDE), true);
  assert.equal(T.transitionMovesOld({ kind: 'zoom' }), false);
});

// ---- setting one ----

function clip(type, props) {
  return T.createLayer({
    type, src: type === 'audio' ? 'a.mp3' : 'a.mp4', sourceDuration: 60, duration: 10, lane: 0, ...props,
  });
}

// Two pictures on one row overlapping by two seconds, as a gesture leaves them.
function pair(props = {}) {
  const at = (start) => T.arrangeLanes([
    clip('video', { id: 'A', start: 0, ...props.a }),
    clip('video', { id: 'B', start, ...props.b }),
  ]);
  return T.crossfade(at(20), at(8));
}

test('setTransition puts it on one end of a track, and on its picture partners, never on its sound', () => {
  const list = [clip('video', { id: 'A', groupId: 'g' }), clip('audio', { id: 'As', groupId: 'g' })];
  const next = T.setTransition(list, 'A', 'out', { kind: 'iris' });
  assert.equal(T.layerById(next, 'A').fadeOutTransition.kind, 'iris');
  assert.equal(T.layerById(next, 'A').fadeInTransition, null);
  assert.equal(T.layerById(next, 'As').fadeOutTransition, null);
  assert.equal(T.setTransition(next, 'A', 'out', { kind: 'iris' }), next, 'the same again is the same list');
  assert.equal(T.layerById(T.setTransition(next, 'A', 'out', null), 'A').fadeOutTransition, null);
});

test('on an overlap it goes onto both tracks, from whichever end it was set', () => {
  for (const [id, which] of [['B', 'in'], ['A', 'out']]) {
    const next = T.setTransition(pair(), id, which, WIPE);
    assert.deepEqual(T.layerById(next, 'B').fadeInTransition, WIPE);
    assert.deepEqual(T.layerById(next, 'A').fadeOutTransition, WIPE);
    assert.deepEqual(T.overlapOf(next, 'A', 'out').transition, WIPE);
    // Two pictures that cover each other: the earlier one stays whole under
    // the later one's matte, so it has no way out of its own.
    assert.equal(T.layerById(next, 'A').fadeOut, 0);
    assert.equal(T.transitionAt(T.layerById(next, 'A'), 9), null);
    assert.equal(T.transitionAt(T.layerById(next, 'B'), 9).e, 0.5);
  }
});

test('a slide moves the old picture too, so the earlier track goes through it as well', () => {
  const slid = T.setTransition(pair(), 'B', 'in', SLIDE);
  assert.equal(T.layerById(slid, 'A').fadeOut, 2, 'the length of the overlap');
  assert.deepEqual(T.transitionAt(T.layerById(slid, 'A'), 9), { half: 'out', transition: SLIDE, e: 0.5 });
  assert.deepEqual(T.transitionAt(T.layerById(slid, 'B'), 9), { half: 'in', transition: SLIDE, e: 0.5 });
  // Back to one that only cuts, the earlier track is whole under the later again.
  const wiped = T.setTransition(slid, 'A', 'out', WIPE);
  assert.equal(T.layerById(wiped, 'A').fadeOut, 0);
  // And see-through pictures go out through any of them.
  const pngs = pair({ a: { kind: 'image', src: 'a.png' }, b: { kind: 'image', src: 'b.png' } });
  assert.equal(T.layerById(T.setTransition(pngs, 'B', 'in', WIPE), 'A').fadeOut, 2);
});

test('a new overlap takes the later track\'s transition and curve for the earlier track\'s way out', () => {
  const at = (start) => T.arrangeLanes([
    clip('video', { id: 'A', start: 0, fadeOut: 1, fadeOutCurve: 'cubicIn', fadeOutTransition: { kind: 'clock' } }),
    clip('video', { id: 'B', start, fadeInCurve: 'quadOut', fadeInTransition: SLIDE }),
  ]);
  const met = T.crossfade(at(20), at(7));
  const a = T.layerById(met, 'A');
  assert.equal(T.layerById(met, 'B').fadeIn, 3);
  assert.equal(a.fadeOut, 3, 'a slide has the earlier one go through it');
  assert.deepEqual(a.fadeOutTransition, SLIDE);
  assert.equal(a.fadeOutCurve, 'quadOut');
  // Pulled apart again, the overlap takes back the fades it wrote.
  const apart = T.crossfade(met, T.moveLayer(met, 'B', 20));
  assert.equal(T.layerById(apart, 'A').fadeOut, 0);
  assert.equal(T.layerById(apart, 'B').fadeIn, 0);
});

test('an overlap that did not change is left as it is', () => {
  const list = T.setTransition(pair(), 'B', 'in', SLIDE);
  assert.equal(T.crossfade(list, list), list);
});

test('a cut end and a joined seam have no transition', () => {
  const l = vid({ fadeIn: 1, fadeOut: 1, fadeInTransition: WIPE, fadeOutTransition: SLIDE });
  const [left, right] = T.splitLayer([l], 'v', 5);
  assert.deepEqual([left.fadeInTransition, left.fadeOutTransition], [WIPE, null]);
  assert.deepEqual([right.fadeInTransition, right.fadeOutTransition], [null, SLIDE]);
  const two = [
    clip('video', { id: 'A', start: 0, duration: 5, fadeOut: 1, fadeOutTransition: WIPE }),
    clip('video', { id: 'B', start: 5, duration: 5, fadeIn: 1, fadeInTransition: WIPE, fadeOut: 1, fadeOutTransition: SLIDE }),
  ];
  const joined = T.join(two, ['A', 'B']);
  assert.equal(T.layerById(joined, 'A').fadeOutTransition, null);
  assert.equal(T.layerById(joined, 'B').fadeInTransition, null);
  assert.deepEqual(T.layerById(joined, 'B').fadeOutTransition, SLIDE, 'the outer end keeps its own');
});

// ---- where a slide and a zoom put the picture ----

const WHOLE = { src: { x: 0, y: 0, width: 1920, height: 1080 }, dest: { x: 0, y: 0, width: 1920, height: 1080 }, rotation: 0 };

test('a slide shows the part of the picture inside its box, at that part of the box', () => {
  // Coming in to the right, a quarter of the way: the picture's right quarter
  // at the box's left.
  const p = G.transitionPlacement(WHOLE, 'in', SLIDE, 0.25);
  assert.deepEqual(p.src, { x: 1440, y: 0, width: 480, height: 1080 });
  assert.deepEqual(p.dest, { x: 0, y: 0, width: 480, height: 1080 });
  assert.deepEqual(p.window, { x: 0.75, y: 0, w: 0.25, h: 1 });
  // Going out to the right by a quarter: its left three quarters, pushed along.
  const q = G.transitionPlacement(WHOLE, 'out', SLIDE, 0.25);
  assert.deepEqual(q.src, { x: 0, y: 0, width: 1440, height: 1080 });
  assert.deepEqual(q.dest, { x: 480, y: 0, width: 1440, height: 1080 });
  // The two halves of one slide meet edge to edge the whole way.
  for (const e of [0.1, 0.5, 0.9]) {
    const coming = G.transitionPlacement(WHOLE, 'in', SLIDE, e).dest;
    const going = G.transitionPlacement(WHOLE, 'out', SLIDE, e).dest;
    assert.ok(near(coming.x + coming.width, going.x), 'at ' + e);
  }
  // Upwards, in a box that is not the frame.
  const inset = { src: WHOLE.src, dest: { x: 100, y: 200, width: 800, height: 400 }, rotation: 0 };
  const up = G.transitionPlacement(inset, 'in', { kind: 'slide', angle: 270 }, 0.5);
  assert.deepEqual(up.dest, { x: 100, y: 400, width: 800, height: 200 });
  assert.deepEqual(up.src, { x: 0, y: 0, width: 1920, height: 540 });
  // All the way in, it is the picture where it belongs.
  const done = G.transitionPlacement(inset, 'in', SLIDE, 1);
  assert.deepEqual(done.dest, inset.dest);
  assert.deepEqual(done.src, inset.src);
});

test('a turned picture slides along its own turned box', () => {
  const turned = { src: WHOLE.src, dest: { x: 0, y: 0, width: 800, height: 400 }, rotation: 90 };
  const p = G.transitionPlacement(turned, 'in', SLIDE, 0.5);
  // Half its width shows, and that half's middle is a quarter width from the
  // box's middle, which a quarter turn puts straight above it.
  assert.ok(near(p.dest.width, 400) && near(p.dest.height, 400));
  assert.ok(near(p.dest.x + p.dest.width / 2, 400));
  assert.ok(near(p.dest.y + p.dest.height / 2, 200 - 200));
  assert.equal(p.rotation, 90);
});

test('a zoom is the whole picture smaller about its middle, turning by what is left of its spin', () => {
  const p = G.transitionPlacement(WHOLE, 'in', { kind: 'zoom', turns: 2 }, 0.25);
  assert.deepEqual(p.dest, { x: 720, y: 405, width: 480, height: 270 });
  assert.deepEqual(p.src, WHOLE.src);
  assert.equal(p.rotation, -540);
  assert.equal(p.window, null);
  const out = G.transitionPlacement(WHOLE, 'out', { kind: 'zoom', turns: 2 }, 0.25);
  assert.equal(out.dest.width, 1440);
  assert.equal(out.rotation, 180);
  // Never to nothing: two pixels is the least a picture can be scaled to.
  const least = G.transitionPlacement(WHOLE, 'in', { kind: 'zoom', turns: 0 }, 0);
  assert.ok(least.dest.width > 0 && least.dest.height >= 2 - 1e-9);
});

test('the placements through a transition are a list the preview and the export both follow', () => {
  const l = vid({ fadeIn: 2, fadeInTransition: SLIDE });
  assert.equal(G.shownKeys(l, SRC['a.mp4'], HD, []), null);
  const keys = G.shownKeys(l, SRC['a.mp4'], HD, T.transitionSteps(l));
  assert.deepEqual(keys.map((k) => k.t), [0, 2]);
  assert.deepEqual(keys[1].dest, { x: 0, y: 0, width: 1920, height: 1080 });
  // Half way, the straight blend of the two is the slide half way.
  const mid = G.shownPlacementAt(keys, 1);
  const want = G.transitionPlacement(WHOLE, 'in', SLIDE, 0.5);
  assert.ok(near(mid.dest.width, want.dest.width, 2) && near(mid.src.x, want.src.x, 2));
  assert.ok(near(mid.window.w, 0.5, 0.01));
  // After it the picture is where it is, with no part cut.
  const after = G.shownPlacementAt(keys, 5);
  assert.deepEqual(after.dest, WHOLE.dest);
  // A spin is carried on without wrapping, so the blend turns the whole way.
  const z = vid({ fadeIn: 2, fadeInTransition: { kind: 'zoom', turns: 2 } });
  const zk = G.shownKeys(z, SRC['a.mp4'], HD, T.transitionSteps(z));
  assert.deepEqual(zk.map((k) => k.turn), [-720, 0]);
  assert.equal(G.shownPlacementAt(zk, 0.5).rotation, -540);
});

test('a layer\'s own keyframes are in the list, moved by the transition where they fall inside it', () => {
  const l = vid({
    fadeIn: 2,
    fadeInTransition: { kind: 'zoom', turns: 0 },
    keyframes: [
      { id: 'a', t: 1, render: { x: 0, y: 0, width: 960, height: 540 } },
      { id: 'b', t: 6, render: { x: 960, y: 540, width: 960, height: 540 } },
    ],
  });
  const keys = G.shownKeys(l, SRC['a.mp4'], HD, T.transitionSteps(l));
  assert.deepEqual(keys.map((k) => k.t), [0, 1, 2, 6]);
  // At one second it is its keyframe's picture at half size, about that picture's middle.
  assert.deepEqual(keys[1].dest, { x: 240, y: 135, width: 480, height: 270 });
  // Past the transition the keyframes are as they are.
  assert.deepEqual(keys[3].dest, { x: 960, y: 540, width: 960, height: 540 });
});

// ---- the mattes ----

function recorder(extra = {}) {
  const calls = [];
  const gradient = (kind, args) => {
    const g = { kind, args, stops: [], addColorStop(at, colour) { g.stops.push([at, colour]); } };
    calls.push(['gradient', g]);
    return g;
  };
  return {
    calls,
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
    save() {},
    restore() { this.globalCompositeOperation = 'source-over'; },
    beginPath() { calls.push(['beginPath']); },
    closePath() {},
    moveTo(x, y) { calls.push(['moveTo', x, y]); },
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    rect(...a) { calls.push(['rect', ...a]); },
    arc(...a) { calls.push(['arc', ...a]); },
    fill() { calls.push(['fill', this.globalCompositeOperation, this.fillStyle]); },
    fillRect(...a) { calls.push(['fillRect', this.globalCompositeOperation, this.fillStyle, ...a]); },
    createLinearGradient: (...a) => gradient('linear', a),
    createConicGradient: (...a) => gradient('conic', a),
    ...extra,
  };
}

test('a matte is nothing at the start and everything at the end, whatever the kind', () => {
  for (const kind of ['wipe', 'iris', 'clock', 'blinds', 'dissolve']) {
    const tr = T.transitionDefault(kind);
    const none = recorder();
    D.drawTransitionMatte(none, tr, 0, 400, 200, 0, null);
    assert.deepEqual(none.calls, [], kind + ' at 0');
    const all = recorder();
    D.drawTransitionMatte(all, tr, 1, 400, 200, 10, null);
    assert.deepEqual(all.calls, [['fillRect', 'source-over', '#ffffff', -10, -10, 420, 220]], kind + ' at 1');
  }
});

test('a wipe is an edge square to its way, from before the box to past it', () => {
  const edgeAt = (e, angle = 0, soft = 0) => {
    const ctx = recorder();
    D.drawTransitionMatte(ctx, { kind: 'wipe', angle, soft }, e, 400, 200, 0, null);
    const g = ctx.calls.find((c) => c[0] === 'gradient')[1];
    return { from: [g.args[0], g.args[1]], to: [g.args[2], g.args[3]], stops: g.stops };
  };
  // A hard edge is a pixel wide, and half way it stands in the middle.
  const mid = edgeAt(0.5);
  assert.ok(near(mid.from[0], 199.5) && near(mid.to[0], 200.5));
  assert.deepEqual(mid.stops, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
  // Downwards it crosses the height.
  const down = edgeAt(0.5, 90);
  assert.ok(near(down.from[1], 99.5) && near(down.from[0], 200));
  // A soft one is a share of the way across, and starts wholly before the box.
  const soft = edgeAt(0.001, 0, 0.5);
  assert.ok(near(soft.to[0] - soft.from[0], 200));
  assert.ok(soft.to[0] < 1);
});

test('an iris holds a circle that reaches the corner at the end, and closes the other way round', () => {
  const far = Math.hypot(400, 200) / 2;
  const radius = (tr, e) => {
    const ctx = recorder();
    D.drawTransitionMatte(ctx, tr, e, 400, 200, 0, null);
    return ctx.calls;
  };
  const open = radius({ kind: 'iris', shape: 'circle', soft: 0, reverse: false }, 0.5);
  const arc = open.find((c) => c[0] === 'arc');
  assert.ok(near(arc[1], 200) && near(arc[2], 100) && near(arc[3], far / 2));
  // Closing: everything, with the shape taken out of it.
  const close = radius({ kind: 'iris', shape: 'circle', soft: 0, reverse: true }, 0.25);
  assert.equal(close[0][0], 'fillRect');
  assert.deepEqual(close.find((c) => c[0] === 'fill').slice(1), ['destination-out', '#ffffff']);
  assert.ok(near(close.find((c) => c[0] === 'arc')[3], far * 0.75));
  // A square has the picture's proportions, a diamond stands on its corners.
  const square = radius({ kind: 'iris', shape: 'square', soft: 0, reverse: false }, 0.5).find((c) => c[0] === 'rect');
  assert.deepEqual(square.slice(1), [100, 50, 200, 100]);
  const diamond = radius({ kind: 'iris', shape: 'diamond', soft: 0, reverse: false }, 0.5);
  assert.deepEqual(diamond.find((c) => c[0] === 'moveTo').slice(1), [200, 0]);
  // A star's ten corners.
  const star = radius({ kind: 'iris', shape: 'star', soft: 0, reverse: false }, 0.5);
  assert.equal(star.filter((c) => c[0] === 'lineTo').length, 9);
});

test('a star covers the picture at the end of its way and not before, whatever the picture\'s shape', () => {
  const inside = (poly, x, y) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (const [w, h] of [[400, 200], [1920, 1080], [300, 300], [200, 500]]) {
    const star = (e) => {
      const ctx = recorder();
      D.drawTransitionMatte(ctx, { kind: 'iris', shape: 'star', soft: 0, reverse: false }, e, w, h, 0, null);
      return ctx.calls.filter((c) => c[0] === 'moveTo' || c[0] === 'lineTo').map((c) => [c[1], c[2]]);
    };
    // A hair inside each corner, since the last corner lies on the star's edge.
    const corners = [[0.01 * w, 0.01 * h], [0.99 * w, 0.01 * h], [0.01 * w, 0.99 * h], [0.99 * w, 0.99 * h]];
    const held = (e) => corners.filter(([x, y]) => inside(star(e), x, y)).length;
    assert.equal(held(0.999), 4, w + 'x' + h + ' is held at the end');
    assert.ok(held(0.9) < 4, w + 'x' + h + ' still has a corner out at nine tenths');
  }
});

test('a clock sweeps round from its start, either way', () => {
  const stops = (tr, e) => {
    const ctx = recorder();
    D.drawTransitionMatte(ctx, tr, e, 400, 200, 0, null);
    const g = ctx.calls.find((c) => c[0] === 'gradient')[1];
    return { args: g.args, stops: g.stops };
  };
  const cw = stops({ kind: 'clock', start: 270, clockwise: true, soft: 0 }, 0.5);
  assert.ok(near(cw.args[0], 1.5 * Math.PI) && cw.args[1] === 200 && cw.args[2] === 100);
  // White up to the hand, clear after it.
  assert.equal(cw.stops[0][1], 'rgba(255,255,255,1)');
  assert.equal(cw.stops[cw.stops.length - 1][1], 'rgba(255,255,255,0)');
  assert.ok(cw.stops.some(([at]) => near(at, 0.5, 0.01)));
  const ccw = stops({ kind: 'clock', start: 270, clockwise: false, soft: 0 }, 0.25);
  // The other way round the white part is the last quarter of the turn.
  assert.deepEqual(ccw.stops.find(([at]) => at === 1), [1, 'rgba(255,255,255,1)']);
  assert.ok(ccw.stops.some(([at]) => near(at, 0.75, 0.01)));
});

test('blinds are slats side by side, each opening like a wipe', () => {
  const ctx = recorder();
  D.drawTransitionMatte(ctx, { kind: 'blinds', count: 4, vertical: false, soft: 0 }, 0.5, 400, 200, 0, null);
  const strips = ctx.calls.filter((c) => c[0] === 'fillRect');
  assert.deepEqual(strips.map((c) => c.slice(3)), [[0, 0, 400, 50], [0, 50, 400, 50], [0, 100, 400, 50], [0, 150, 400, 50]]);
  const up = recorder();
  D.drawTransitionMatte(up, { kind: 'blinds', count: 8, vertical: true, soft: 0 }, 0.5, 400, 200, 0, null);
  assert.equal(up.calls.filter((c) => c[0] === 'fillRect').length, 8);
  assert.deepEqual(up.calls.filter((c) => c[0] === 'fillRect')[1].slice(3), [50, 0, 50, 200]);
});

test('a dissolve brings each cell in at its own moment, the same one every time', () => {
  const seen = new Set();
  let below = 0;
  for (let i = -20; i < 20; i += 1) {
    for (let j = -20; j < 20; j += 1) {
      const r = D.dissolveOrder(i, j);
      assert.ok(r >= 0 && r < 1);
      assert.equal(r, D.dissolveOrder(i, j));
      seen.add(r);
      if (r < 0.5) below += 1;
    }
  }
  assert.ok(seen.size > 1590, 'no two cells to speak of share a moment');
  assert.ok(below > 700 && below < 900, 'about half of them are in by half way: ' + below);
  // Half way, about half the cells are drawn.
  const ctx = recorder();
  D.drawTransitionMatte(ctx, { kind: 'dissolve', rows: 10, soft: 0 }, 0.5, 400, 200, 0, null);
  const cells = ctx.calls.filter((c) => c[0] === 'fillRect');
  assert.ok(cells.length > 60 && cells.length < 140, cells.length + ' of 200');
  assert.deepEqual(cells[0].slice(5), [20, 20]);
});

test('a generated layer\'s transition is measured by its own box, with room for its shadow', () => {
  const frame = { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 };
  assert.deepEqual(D.transitionBox(T.genOf({ form: 'text' }), 1920, 1080), frame);
  const boxed = T.genOf({
    form: 'text',
    text: { box: { x: 100, y: 200, w: 600, h: 100 }, rotation: 30, style: { shadow: { distance: 10, size: 6 }, outline: { width: 4 } } },
  });
  assert.deepEqual(D.transitionBox(boxed, 1920, 1080), { x: 80, y: 180, w: 640, h: 140, rotation: 30 });
  const shape = T.genOf({ form: 'shape', shape: { kind: 'circle', box: { x: 0, y: 0, w: 100, h: 100 } } });
  assert.deepEqual(D.transitionBox(shape, 1920, 1080), { x: 0, y: 0, w: 100, h: 100, rotation: 0 });
  const hole = T.genOf({ form: 'shape', shape: { kind: 'circle', invert: true, box: { x: 0, y: 0, w: 100, h: 100 } } });
  assert.deepEqual(D.transitionBox(hole, 1920, 1080), frame, 'an inverted shape fills the frame');
});

// ---- the export ----

test('an end with a transition is not faded in the file either', () => {
  const plain = graphOf(buildComposeArgs({ layers: [vid({ fadeIn: 2, fadeOut: 1 })], project: HD, output: 'o.mp4', sources: SRC }));
  assert.match(plain, /fade=t=in:st=0\.0:d=2\.0:alpha=1/);
  const l = vid({ fadeIn: 2, fadeOut: 1, fadeInTransition: WIPE });
  const g = graphOf(buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC }));
  assert.equal(g.includes('fade=t=in'), false);
  assert.match(g, /fade=t=out:st=9\.0:d=1\.0:alpha=1/, 'the other end still fades');
});

test('a matte reaches the encoder as the picture\'s mask, drawn for each transition and held between', () => {
  const frames = { pattern: 'm/%05d.png', lead: 0, tail: 0, gaps: [{ after: 61, frames: 209 }] };
  const l = { ...vid({ fadeIn: 2, fadeOut: 1, fadeInTransition: WIPE, fadeOutTransition: WIPE }), maskFile: { frames } };
  const args = buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC });
  assert.ok(args.join(' ').includes('-framerate 30 -start_number 0 -i m/%05d.png'));
  const g = graphOf(args);
  // The frames after the gap come 209 frames later, and fps fills the gap.
  assert.ok(g.includes("[1:v]setpts='(N+209*gte(N\\,61))/(30*TB)',fps=30,fps=30,setpts=PTS-STARTPTS+0.0/TB,format=gray"), g);
  assert.match(g, /\[mp0\]\[mk0\]alphamerge/);
  assert.equal(g.includes('fade=t='), false);
});

test('a slide and a zoom take the road a picture between keyframes takes', () => {
  const still = graphOf(buildComposeArgs({ layers: [vid({})], project: HD, output: 'o.mp4', sources: SRC }));
  assert.equal(still.includes('eval=frame'), false);
  const l = vid({ start: 3, fadeIn: 2, fadeInTransition: SLIDE });
  const g = graphOf(buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(g.includes('eval=frame'));
  // Its width goes from the two pixels it starts at to the whole 1920 over the two seconds from 3.
  assert.ok(g.includes('(2.0+1918.0*clip((t-3.0)/2.0\\,0\\,1))'), g);
  // What never changes is said once: the height, and where it stands.
  assert.ok(g.includes('(1080.0)'));
  // At its very first moment there is nothing of it yet.
  assert.ok(g.includes("enable='gte(t,3.001)*lt(t,13.0)'"));
  assert.equal(g.includes('fade=t=in'), false);
  // A zoom that turns takes the turning road.
  const z = vid({ fadeOut: 2, fadeOutTransition: { kind: 'zoom', turns: 1 } });
  const zg = graphOf(buildComposeArgs({ layers: [z], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(zg.includes('rotate=a='));
  assert.ok(zg.includes("enable='gte(t,0.0)*lt(t,10.0)'"), 'a way out starts with the picture whole');
});

test('a see-through picture keeps its own alpha on the moving roads', () => {
  const png = T.createLayer({
    id: 'p', type: 'video', kind: 'image', src: 'logo.png', duration: 6, sourceWidth: 640, sourceHeight: 360,
    fadeIn: 1, fadeInTransition: SLIDE,
  });
  const g = graphOf(buildComposeArgs({ layers: [png], project: HD, output: 'o.mp4', sources: { 'logo.png': { width: 640, height: 360 } } }));
  assert.ok(g.includes('[mp0]split[mq0][mr0]'));
  // Both at the full range before they are multiplied: an alpha is 0 to 255
  // and a grey video is 16 to 235, and squeezed to match they come out dim.
  assert.ok(g.includes('[mr0]alphaextract,scale=out_range=full[ma0]'));
  assert.ok(g.includes('[mm0]scale=out_range=full[mn0]'));
  assert.ok(g.includes('[ma0][mn0]blend=all_mode=multiply[mb0]'));
  assert.ok(g.includes('[mq0][mb0]alphamerge'));
  // A video has none to keep, and is cut by the rectangle as it always was.
  const v = graphOf(buildComposeArgs({ layers: [vid({ fadeIn: 1, fadeInTransition: SLIDE })], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(v.includes('[mp0][mm0]alphamerge'));
});

test('a generated layer arrives with its transition drawn, and is not put through it again', () => {
  const text = {
    ...T.createLayer({ id: 't', kind: 'gen', gen: { form: 'text' }, duration: 5, fadeIn: 1, fadeInTransition: SLIDE }),
    src: 'f/%05d.png',
    frames: { pattern: 'f/%05d.png', lead: 0, tail: 3.9 },
    sourceWidth: 1920,
    sourceHeight: 1080,
  };
  const g = graphOf(buildComposeArgs({ layers: [text], project: HD, output: 'o.mp4', sources: { 'f/%05d.png': { width: 1920, height: 1080 } } }));
  assert.equal(g.includes('eval=frame'), false);
  assert.equal(g.includes('fade=t=in'), false);
  assert.ok(g.includes('tpad=stop_mode=clone:stop_duration=3.9'));
});

test('a filter graph too long for a command line goes to ffmpeg in a file', () => {
  const short = ['-y', '-filter_complex', 'color=c=black[o]', '-map', '[o]', 'out.mp4'];
  // V5.0. `files` names every graph written, none here.
  assert.deepEqual(spillGraph(short, 'g.txt'), { args: short, graph: null, files: [] });
  const graph = 'x'.repeat(GRAPH_ARG_MAX);
  const long = ['-y', '-filter_complex', graph, '-map', '[o]', 'out.mp4'];
  const spilt = spillGraph(long, 'g.txt');
  assert.deepEqual(spilt.args, ['-y', '-/filter_complex', 'g.txt', '-map', '[o]', 'out.mp4']);
  assert.equal(spilt.graph, graph);
  assert.deepEqual(spilt.files, [{ file: 'g.txt', text: graph }]);
  assert.deepEqual(long[1], '-filter_complex', 'the argv handed in is left alone');
  // Twelve eased steps on a few layers is what gets there.
  const eased = [0, 1, 2, 3].map((i) => vid({
    id: 'v' + i, start: i, lane: i, fadeIn: 2, fadeOut: 2, fadeInCurve: 'sineInOut', fadeOutCurve: 'sineInOut',
    fadeInTransition: { kind: 'zoom', turns: 1 }, fadeOutTransition: { kind: 'zoom', turns: 1 },
  }));
  const args = buildComposeArgs({ layers: eased, project: HD, output: 'o.mp4', sources: SRC });
  assert.ok(graphOf(args).length > GRAPH_ARG_MAX, 'four eased zooms are ' + graphOf(args).length + ' characters');
  assert.notEqual(spillGraph(args, 'g.txt').graph, null);
});

// ---- the window and its ways in ----

test('the fade pop-up has a Transition row under its curves, on a picture only', () => {
  const menu = CLIPS.slice(CLIPS.indexOf('function openFadeMenu('), CLIPS.indexOf('function bindFadeMenu('));
  assert.ok(menu.indexOf("row.className = 'clip-menu__item clip-fade-transition'") > menu.indexOf('timelineModel.FADE_CURVE_IDS'));
  assert.match(menu, /if \(layer\.type === 'video'\) \{/);
  assert.match(menu, /label\.textContent = t\('Transition'\)/);
  assert.match(menu, /transitionName\(cross \? cross\.transition : timelineModel\.transitionsOf\(layer\)\[which\]\)/);
  assert.match(menu, /row\.addEventListener\('click', \(\) => openTransition\(layerId, which\)\)/);
});

test('a fade that has a transition has a button in its middle that opens the window again', () => {
  const build = CLIPS.slice(CLIPS.indexOf('function buildLayerClip('), CLIPS.indexOf('// ---- moving and trimming a clip ----'));
  assert.match(build, /mark\.className = 'clip-transition-mark'/);
  assert.match(build, /openTransition\(layer\.id, which\)/);
  assert.match(build, /mark\.addEventListener\('pointerdown', \(evt\) => evt\.stopPropagation\(\)\)/);
  const place = CLIPS.slice(CLIPS.indexOf('function placeFadeGrips('), CLIPS.indexOf('function placeClipMarks('));
  // Only with a transition and a fade for it, and once for an overlap.
  assert.match(place, /const shown = !!tr\[which\] && span > 0 && width >= 30\s+&& !\(which === 'out' && transitionOutOf\(layer\)\);/);
  assert.match(place, /const mid = which === 'in' \? layer\.start \+ span \/ 2 : timelineModel\.endOf\(layer\) - span \/ 2;/);
});

test('the window: the transitions in a row, their settings, how long, Cancel and Accept', () => {
  const modal = HTML.slice(HTML.indexOf('<div id="transitionModal"'), HTML.indexOf('<div id="colorModal"'));
  for (const id of ['transitionTitle', 'transitionWhere', 'transitionKinds', 'transitionDemo', 'transitionGrid',
    'transitionDirs', 'transitionShapes', 'transitionReverse', 'transitionClock', 'transitionStarts',
    'transitionCountSlider', 'transitionCountBox', 'transitionSlats', 'transitionRowsSlider', 'transitionRowsBox',
    'transitionTurnsSlider', 'transitionTurnsBox', 'transitionSoftSlider', 'transitionSoftBox',
    'transitionSecondsBox', 'transitionCancelBtn', 'transitionAcceptBtn']) {
    assert.ok(modal.includes('id="' + id + '"'), id);
  }
  const kinds = [...modal.matchAll(/<button data-kind="([a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(kinds, ['fade', ...T.TRANSITION_KINDS], 'the plain fade first, then every kind the model has');
  assert.ok(kinds.length <= 9, 'nine at most');
  // Every setting row says which kinds it is for, and every kind has one.
  const rows = [...modal.matchAll(/class="gen-field" data-for="([a-z ]+)"/g)].flatMap((m) => m[1].split(' '));
  for (const kind of kinds) assert.ok(rows.includes(kind), kind + ' has a row');
  assert.deepEqual([...modal.matchAll(/data-shape="([a-z]+)"/g)].map((m) => m[1]), T.IRIS_SHAPES);
  assert.ok(HTML.indexOf('app/transition.js') > HTML.indexOf('app/gen/preview.js'), 'loaded after what it uses');
  assert.ok(HTML.indexOf('app/transition.js') < HTML.indexOf('app/startup.js'));
});

test('the window is opened on an overlap\'s later track, and writes through the model', () => {
  assert.match(WINDOW, /const id = cross \? cross\.into : layerId;/);
  assert.match(WINDOW, /const end = cross \? 'in' : \(which === 'out' \? 'out' : 'in'\);/);
  assert.ok(WINDOW.includes("popOut(transitionModal, 'transition', {"));
  assert.match(WINDOW, /next = timelineModel\.setTransition\(next, transitionLayerId, transitionEnd, transitionOfDraft\(\)\);/);
  assert.match(WINDOW, /next = timelineModel\.fadeGroup\(next, transitionLayerId, transitionEnd, d\.seconds\);/);
  // An Accept that changed nothing writes nothing.
  const accept = WINDOW.slice(WINDOW.indexOf('function acceptTransition('), WINDOW.indexOf('function previewTransitionDraft('));
  assert.match(accept, /if \(next === layers\) return;\s+setLayers\(next\);\s+commitHistory\(\);/);
  assert.ok(read('main.js').includes("'lwc-pop-transition': ["));
});

test('the preview and the export draw a transition by the same drawings', () => {
  assert.match(COMPOSITOR, /const going = at !== null \? timelineModel\.transitionAt\(layer, at\) : null;/);
  assert.match(COMPOSITOR, /genDraw\.drawGenTransition\(ctx, entry\.el, going, genDraw\.transitionBox\(gen, frame\.width, frame\.height\),/);
  assert.match(COMPOSITOR, /genDraw\.drawTransitionMatte\(m, matte\.transition, matte\.e, w, h\);/);
  assert.match(COMPOSITOR, /layerGeometry\.shownPlacementAt\(moved, at - layer\.start\)/);
  assert.match(EXPORT, /genDraw\.drawTransitionMatte\(matte, going\.transition, going\.e, w, h\);/);
  assert.match(EXPORT, /genDraw\.drawGenTransition\(ctx, own, going, genDraw\.transitionBox\(gen, frame\.width, frame\.height\),/);
  assert.match(EXPORT, /layerGeometry\.shownKeys\(l, source, frame, steps\)/);
});
