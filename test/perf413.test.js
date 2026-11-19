'use strict';

// V4.13. Playback and export timing: clips made ready before a cut and held
// to the clock, the clock held until the project runs, the Start and End
// frames rebuilt only when their picture changed and with the pool to
// themselves, and a selection exported without what is before it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lwc-perf413-'));
require.cache[require.resolve('electron')] = {
  exports: { app: { isPackaged: false, getPath: () => USER_DATA } },
};
const timeline = require('../src/timeline');
const exportWindow = require('../src/exportWindow');
const { buildComposeArgs, windowSkip, outputSpan } = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const COMPOSITOR = read('renderer', 'app', 'compositor.js');
const COMPOSER = read('src', 'composer.js');
const CLIPS = read('renderer', 'app', 'clips.js');

/** A function's source, from its name to its closing brace. */
function fn(source, name) {
  const from = source.indexOf('function ' + name + '(');
  assert.ok(from >= 0, name + ' is there');
  return source.slice(from, source.indexOf('\n}\n', from) + 3);
}

/** The compositor's constants by name, as it declares them. */
function consts(names) {
  return names.map((n) => {
    const m = new RegExp('const ' + n + ' = [^;]+;').exec(COMPOSITOR);
    assert.ok(m, n + ' is there');
    return m[0];
  }).join('\n');
}

const file = (id, extra = {}) => timeline.createLayer({
  type: 'video', src: id + '.mp4', sourceDuration: 600, start: 0, duration: 100, lane: 0, id, ...extra,
});
const sound = (id, extra = {}) => timeline.createLayer({
  type: 'audio', src: id + '.mp3', sourceDuration: 600, start: 0, duration: 100, lane: 0, id, ...extra,
});

// ---- playback: the compositor's own functions on stand-in elements ----

function playback() {
  const names = ['rollPhase', 'rollsEarly', 'readyPlace', 'placeElement', 'holdToClock', 'beginStartHold', 'startHeld'];
  const body = `
    ${consts(['COMPOSITE_SLACK', 'PREROLL_S', 'ROLL_S', 'VIDEO_BEND', 'AUDIO_BEND', 'START_HOLD_MS',
    'ELEMENT_RATE_MIN', 'ELEMENT_RATE_MAX'])}
    // V5.5.2. The playback speed, and whether a layer is on, Solo and all.
    let playRate = 1;
    let soloSeen = { list: null, types: new Set() };
    ${fn(CLIPS, 'layerOn')}
    ${fn(COMPOSITOR, 'elementRate')}
    let layers = [];
    const decoders = new Map();
    const players = new Map();
    let compositeAt = 0;
    let compositeLast = 0;
    let startHold = null;
    let total = 1000;
    let now = 0;
    const performance = { now: () => now };
    const compositing = () => true;
    const compositeTotal = () => total;
    ${names.map((n) => fn(COMPOSITOR, n)).join('\n')}
    return {
      decoders, players, VIDEO_BEND, AUDIO_BEND, COMPOSITE_SLACK, PREROLL_S, ROLL_S, START_HOLD_MS,
      set(o) {
        if ('layers' in o) layers = o.layers;
        if ('at' in o) compositeAt = o.at;
        if ('now' in o) now = o.now;
      },
      get at() { return compositeAt; },
      get last() { return compositeLast; },
      get held() { return startHold; },
      ${names.join(', ')},
    };`;
  // eslint-disable-next-line no-new-func
  return new Function('timelineModel', body)(timeline);
}

test('a clip is made ready before the playhead reaches it, and set running just before', () => {
  const c = playback();
  const l = file('a', { start: 10, sourceIn: 30 });
  c.set({ at: 5 });
  assert.equal(c.rollPhase(l), 'off', 'too far off yet');
  c.set({ at: 10 - c.PREROLL_S + 0.01 });
  assert.equal(c.rollPhase(l), 'ready');
  // It waits where it will start running from, that much before its in point.
  assert.equal(c.readyPlace(l), 30 - c.ROLL_S);
  c.set({ at: 10 - c.ROLL_S + 0.01 });
  assert.equal(c.rollPhase(l), 'roll');
  c.set({ at: 10 });
  assert.equal(c.rollPhase(l), 'on');
  c.set({ at: 110 });
  assert.equal(c.rollPhase(l), 'off', 'past its end');
  assert.equal(c.rollPhase({ ...l, enabled: false }), 'off');
});

test('a clip from the very start of its file cannot run early, and waits on its first frame', () => {
  const c = playback();
  const l = file('a', { start: 10, sourceIn: 0.1 });
  assert.equal(c.rollsEarly(l), false);
  c.set({ at: 9.9 });
  assert.equal(c.rollPhase(l), 'ready');
  assert.equal(c.readyPlace(l), 0.1);
  // At twice the speed the file needs twice as much before the in point.
  const fast = file('b', { start: 10, sourceIn: 0.6, speed: 2 });
  assert.equal(c.rollsEarly(fast), c.ROLL_S * 2 <= 0.6);
  assert.equal(c.rollsEarly(file('c', { start: 10, sourceIn: 5, speed: 2 })), true);
});

test('an element off the clock is bent back to it, and seeked only when it is lost', () => {
  const c = playback();
  const el = { currentTime: 10, playbackRate: 1 };
  // On the clock: its own rate.
  c.holdToClock(el, 10.002, 1, c.COMPOSITE_SLACK, c.VIDEO_BEND);
  assert.equal(el.playbackRate, 1);
  // 40ms behind: faster, by the drift times the gain.
  c.holdToClock(el, 10.04, 1, c.COMPOSITE_SLACK, c.VIDEO_BEND);
  assert.equal(el.playbackRate, 1 + Math.round(0.04 * c.VIDEO_BEND.gain * 100) / 100);
  assert.equal(el.currentTime, 10, 'not seeked');
  // Ahead: slower, and never past the most it may be bent.
  c.holdToClock(el, 9.8, 1, c.COMPOSITE_SLACK, c.VIDEO_BEND);
  assert.equal(el.playbackRate, 1 - c.VIDEO_BEND.most);
  // Sound is bent less than a picture.
  const a = { currentTime: 10, playbackRate: 1 };
  c.holdToClock(a, 10.2, 1, c.COMPOSITE_SLACK, c.AUDIO_BEND);
  assert.equal(a.playbackRate, 1 + c.AUDIO_BEND.most);
  assert.ok(c.AUDIO_BEND.most < c.VIDEO_BEND.most);
  // Lost: placed, at the layer's own rate.
  c.holdToClock(el, 11, 1, c.COMPOSITE_SLACK, c.VIDEO_BEND);
  assert.deepEqual(el, { currentTime: 11, playbackRate: 1 });
  // At another speed the bend is on top of the speed.
  const fast = { currentTime: 20, playbackRate: 2 };
  c.holdToClock(fast, 20.1, 2, c.COMPOSITE_SLACK, c.VIDEO_BEND);
  assert.equal(fast.playbackRate, 2 * (1 + Math.round(0.05 * c.VIDEO_BEND.gain * 100) / 100));
});

test('an element is not seeked to where it already is', () => {
  const c = playback();
  let sets = 0;
  const el = { get currentTime() { return 5; }, set currentTime(v) { sets += 1; } };
  c.placeElement(el, 5.0004);
  assert.equal(sets, 0);
  c.placeElement(el, 5.01);
  assert.equal(sets, 1);
});

test('the clock waits for the sound to start, and starts from how far it has got', () => {
  const c = playback();
  const a = { currentTime: 30 };
  const v = { currentTime: 30 };
  c.set({ layers: [file('v', { sourceIn: 25 }), sound('s', { sourceIn: 25 })], at: 5, now: 1000 });
  c.decoders.set('v', { el: v });
  c.players.set('s', { el: a });
  c.beginStartHold();
  assert.equal(c.held.el, a, 'the sound is the anchor where there is some');
  // Nothing has moved yet: held.
  c.set({ now: 1100 });
  assert.equal(c.startHeld(1100), true);
  assert.equal(c.at, 5);
  // The sound has run 40ms: the clock starts from there, and counts from now.
  a.currentTime = 30.04;
  assert.equal(c.startHeld(1150), false);
  assert.ok(Math.abs(c.at - 5.04) < 1e-9);
  assert.equal(c.last, 1150);
  assert.equal(c.held, null);
  assert.equal(c.startHeld(1200), false, 'and is not held again');
});

test('with no sound the clock is anchored to a picture, with only stills it is not held', () => {
  const c = playback();
  const v = { currentTime: 3 };
  c.set({ layers: [file('v')], at: 3, now: 0 });
  c.decoders.set('v', { el: v });
  c.beginStartHold();
  assert.equal(c.held.el, v);
  // An element that never starts does not hold the clock for good.
  assert.equal(c.startHeld(c.START_HOLD_MS - 1), true);
  assert.equal(c.startHeld(c.START_HOLD_MS + 1), false);
  assert.equal(c.at, 3);

  const stills = playback();
  stills.set({ layers: [file('t')], at: 3 });
  stills.decoders.set('t', { el: {}, still: true });
  stills.beginStartHold();
  assert.equal(stills.held, null);
  assert.equal(stills.startHeld(0), false);
});

test('playback is started held, a jump while running holds it again, and a pause lets go', () => {
  const play = fn(COMPOSITOR, 'playComposite');
  assert.match(play, /if \(compositing\(\)\) followDecoders\(\);\s+followPlayers\(true\);\s+beginStartHold\(\);/);
  const seek = fn(COMPOSITOR, 'seekComposite');
  assert.match(seek, /if \(compositePlaying\) \{\s+followPlayers\(true\);[\s\S]*beginStartHold\(\);\s+\} else \{\s+parkPlayers\(\);/);
  assert.match(fn(COMPOSITOR, 'compositeTick'), /if \(startHeld\(now\)\) \{\s+compositeLast = now;\s+compositeRaf = requestAnimationFrame\(compositeTick\);\s+return;/);
  assert.match(fn(COMPOSITOR, 'pauseComposite'), /compositePlaying = false;\s+startHold = null;/);
});

test('standing still the sound is put where the playhead is, but not while it is dragged', () => {
  const park = fn(COMPOSITOR, 'parkPlayers');
  assert.match(park, /const place = !scrubMoving\(\);/);
  assert.match(park, /if \(place && layerOn\(l\) && timelineModel\.covers\(l, compositeAt\)\) \{\s+placeElement\(entry\.el, timelineModel\.sourceTimeFor\(l, compositeAt\)\);/);
  // The end of a drag and its rest place it.
  assert.match(fn(COMPOSITOR, 'endScrub'), /landDecoders\(\);[\s\S]*parkPlayers\(\);/);
  assert.match(fn(COMPOSITOR, 'restScrub'), /landDecoders\(\);\s+parkPlayers\(\);/);
  // A layer running ahead of its clip is silent until the playhead is on it.
  const follow = fn(COMPOSITOR, 'followPlayers');
  assert.match(follow, /if \(phase === 'on'\) applyPlayerGain\(l\);\s+else silencePlayer\(entry\);/);
  assert.match(follow, /if \(phase === 'ready'\) placeElement\(a, readyPlace\(l\)\);/);
});

// ---- the Start and End frames ----

function frames() {
  const names = ['trimFrameKey', 'sameTrimFrameKey', 'trimFramesNeeded', 'trimFrameOutAt'];
  const body = `
    let layers = [];
    const decoders = new Map();
    const maskPictures = new Map();
    const trimFrameBuilt = { start: null, end: null };
    const slider = { start: 0, end: 100 };
    let frame = { width: 1920, height: 1080, fps: 30 };
    const projectFrame = () => frame;
    ${names.map((n) => fn(COMPOSITOR, n)).join('\n')}
    return {
      decoders, maskPictures, trimFrameBuilt, slider,
      set(o) { if ('layers' in o) layers = o.layers; if ('frame' in o) frame = o.frame; },
      built() { trimFrameBuilt.start = trimFrameKey(slider.start); trimFrameBuilt.end = trimFrameKey(trimFrameOutAt()); },
      ${names.join(', ')},
    };`;
  // eslint-disable-next-line no-new-func
  return new Function('timelineModel', body)(timeline);
}

test('an edit away from both trim points leaves the Start and End frames alone', () => {
  const c = frames();
  const a = file('a', { start: 0, duration: 30 });
  const mid = file('m', { start: 30, duration: 40 });
  const z = file('z', { start: 70, duration: 30 });
  for (const l of [a, mid, z]) c.decoders.set(l.id, { width: 1920 });
  c.set({ layers: [a, mid, z] });
  assert.equal(c.trimFramesNeeded('both'), 'both', 'never built yet');
  c.built();
  assert.equal(c.trimFramesNeeded('both'), null);
  // The clip in the middle changes: a new object, as every change makes.
  c.set({ layers: [a, { ...mid, alpha: 0.5 }, z] });
  assert.equal(c.trimFramesNeeded('both'), null);
  // The clip under the Start frame changes: that frame alone.
  c.set({ layers: [{ ...a, alpha: 0.5 }, mid, z] });
  assert.equal(c.trimFramesNeeded('both'), 'start');
  assert.equal(c.trimFramesNeeded('end'), null, 'asked for the other one only');
  c.set({ layers: [a, mid, { ...z, alpha: 0.5 }] });
  assert.equal(c.trimFramesNeeded('both'), 'end');
});

test('a marker moved, a file read, a font or a mask picture arrived each ask for the frame again', () => {
  const c = frames();
  const a = file('a', { start: 0, duration: 100, mask: { kind: 'custom', src: 'm.png', by: 'alpha' } });
  c.decoders.set('a', { width: 0 });
  c.set({ layers: [a] });
  c.built();
  assert.equal(c.trimFramesNeeded('both'), null);
  c.decoders.get('a').width = 1920;
  assert.equal(c.trimFramesNeeded('both'), 'both', 'the file has been read');
  c.built();
  c.decoders.get('a').fonts = true;
  assert.equal(c.trimFramesNeeded('both'), 'both', 'a font arrived');
  c.built();
  c.maskPictures.set('m.png|alpha', { canvas: {} });
  assert.equal(c.trimFramesNeeded('both'), 'both', 'the mask picture arrived');
  c.built();
  c.slider.start = 12;
  assert.equal(c.trimFramesNeeded('both'), 'start', 'the in marker moved');
  c.built();
  c.set({ frame: { width: 1280, height: 720, fps: 30 } });
  assert.equal(c.trimFramesNeeded('both'), 'both', 'the project has another size');
});

test('the trim frames have the pool to themselves while they are built', () => {
  // Nothing else seeks a decoder meanwhile: three seeks of one element inside
  // a millisecond left it seeking for good, and the frame was drawn from the
  // playhead's picture.
  const park = fn(COMPOSITOR, 'parkDecoders');
  assert.match(park, /if \(!entry\.el\.paused\) entry\.el\.pause\(\);[\s\S]*?if \(framesRunning\) continue;/);
  assert.match(fn(COMPOSITOR, 'landDecoders'), /if \(framesRunning\) return;\s+landing\.clear\(\);/);
  const run = fn(COMPOSITOR, 'runTrimFrames');
  // The pool is put back on the playhead when they are done.
  assert.match(run, /framesRunning = false;\s+paintingFrames = false;[\s\S]*if \(!compositePlaying\) parkDecoders\(\);\s+drawComposite\(\);/);
  // Two requests for one change are one pass, and a frame is kept as built
  // only when the document did not change under it.
  assert.match(run, /const which = trimFramesNeeded\(framesWanted\);\s+framesWanted = null;\s+if \(!which\) \{/);
  assert.match(run, /const key = trimFrameKey\(at\);\s+await seekDecodersTo\(at\);/);
  assert.match(run, /trimFrameBuilt\[name\] = held \? key : null;\s+if \(!held\) framesWanted = mergeWhich\(framesWanted, name\);/);
  // Play pressed meanwhile takes the pool, and the frame waits for the stop.
  assert.match(run, /if \(compositePlaying\) \{\s+trimFrameBuilt\[name\] = null;\s+trimFramesStale = true;\s+break;/);
  // Nothing to do: no pass, no hold, and the spinner comes down.
  const ask = fn(COMPOSITOR, 'renderTrimFrames');
  assert.match(ask, /const need = trimFramesNeeded\(which \|\| 'both'\);\s+if \(!need\) \{\s+if \(!framesRunning\) trimFramesBusy\(false\);\s+return;/);
  // A seek that never lands is asked for again.
  assert.match(fn(COMPOSITOR, 'seekDecodersTo'), /if \(entry\.el\.seeking\) entry\.el\.currentTime = want;\s+\}, 2000\);/);
});

// ---- a selection exported without what is before it ----

// A file of 24000/1001 frames a second, its frame times in ticks of 1/24000.
const TB = { num: 1, den: 24000 };
const FPS = 24000 / 1001;
const framesRound = (seconds, startUs = 0) => {
  const mid = Math.round((seconds + startUs / 1e6) * 24000 / 1001);
  const out = [];
  for (let j = Math.max(0, mid - 48); j <= mid + 48; j += 1) out.push(j * 1001 + Math.round(startUs * 24000 / 1e6));
  return out;
};
const probeOf = (startUs = 0) => (src, places) => ({ tb: TB, startUs, lists: places.map((p) => framesRound(p, startUs)) });

test('times are turned into ticks the way ffmpeg does, half away from zero', () => {
  assert.equal(exportWindow.toTicks(1e6, TB), 24000);
  assert.equal(exportWindow.toTicks(20.8333, { num: 1, den: 1000 }), 0);
  assert.equal(exportWindow.toTicks(500, { num: 1, den: 1000 }), 1);
  assert.equal(exportWindow.toTicks(-500, { num: 1, den: 1000 }), -1);
  assert.equal(exportWindow.firstKept([0, 1001, 2002], 41708, TB), 1001);
  assert.equal(exportWindow.firstKept([0, 1001, 2002], 41750, TB), 2002);
  assert.equal(exportWindow.firstKept([0, 1001], 1e6, TB), null);
});

test('a clip is read from a frame of its own, half way from the one before it', () => {
  for (const sourceIn of [0, 7.3137, 12.02, 59.999999]) {
    for (const startUs of [0, 23000]) {
      const l = file('a', { sourceIn, duration: 400 });
      const k = 4000;
      const info = probeOf(startUs)('a.mp4', [sourceIn, sourceIn + (k - exportWindow.LAYER_MARGIN) / FPS]);
      const plan = exportWindow.planFile(l, k, FPS, { ...info, near: info.lists[0], far: info.lists[1] });
      assert.ok(plan, 'a plan for ' + sourceIn);
      const far = info.lists[1];
      const m = exportWindow.firstKept(far, Math.round(plan.ss * 1e6) + startUs, TB);
      const at = far.indexOf(m);
      // Reading starts strictly between two frames, never on one.
      const usOf = (p) => p / 24000 * 1e6 - startUs;
      assert.ok(usOf(far[at - 1]) < plan.ss * 1e6 - 5000 && plan.ss * 1e6 + 5000 < usOf(m));
      // Where that frame stood on the old count: its time since the old
      // start of reading, to the tick.
      const oldFrom = exportWindow.toTicks(Math.round(sourceIn * 1e6) + startUs, TB);
      assert.equal(plan.raw, ((m - oldFrom) / 24000).toFixed(9));
      // It falls in a slot before the first one kept, with room.
      const first = exportWindow.firstKept(info.lists[0], Math.round(sourceIn * 1e6) + startUs, TB);
      const slot = (p) => Math.round((p - oldFrom) / 24000 * FPS);
      assert.equal(plan.q0, slot(first));
      assert.ok(slot(m) < plan.k + plan.q0 - 1);
      assert.ok(slot(m) >= plan.k + plan.q0 - 4, 'and not further back than it has to be');
    }
  }
});

test('with frame times missing or not understood there is no plan for the clip', () => {
  const l = file('a', { sourceIn: 5, duration: 400 });
  const info = probeOf()('a.mp4', [5, 5 + 3998 / FPS]);
  const ok = { ...info, near: info.lists[0], far: info.lists[1] };
  assert.ok(exportWindow.planFile(l, 4000, FPS, ok));
  assert.equal(exportWindow.planFile(l, 4000, FPS, null), null);
  assert.equal(exportWindow.planFile(l, 4000, FPS, { ...ok, tb: { num: 0, den: 1 } }), null);
  assert.equal(exportWindow.planFile(l, 4000, FPS, { ...ok, near: [] }), null);
  assert.equal(exportWindow.planFile(l, 4000, FPS, { ...ok, far: ok.far.slice(0, 2) }), null);
  // Frames only before the place: nothing says what follows.
  const before = ok.far.filter((p) => Math.round((p - 5 * 24000) / 24000 * FPS) < 3998);
  assert.equal(exportWindow.planFile(l, 4000, FPS, { ...ok, far: before }), null);
});

test('the plan: the black frame cut, layers outside dropped, stills held later, files asked about', () => {
  const asked = [];
  const probe = (src, places) => { asked.push(src); return probeOf()(src, places); };
  const layers = [
    file('over', { start: 0, duration: 50 }),
    file('long', { start: 0, duration: 400 }),
    file('after', { start: 320, duration: 20 }),
    file('fast', { start: 0, duration: 300, speed: 2 }),
    file('short', { start: 199.6, duration: 50 }),
    timeline.createLayer({ type: 'video', kind: 'image', src: 't.png', start: 10, duration: 380, id: 'still', sourceDuration: 380 }),
    sound('s', { duration: 400 }),
  ];
  const span = { start: 200, end: 210, duration: 10 };
  const plan = exportWindow.plan({ layers, span, fps: 24, probe });
  assert.equal(plan.cut, 200 * 24 - exportWindow.BASE_MARGIN);
  assert.deepEqual(plan.drop, ['over', 'after']);
  // The still: from two frames before the black frame's first.
  const from = plan.cut / 24;
  assert.deepEqual(plan.skips.still, { k: Math.floor((from - 10) * 24 + 1e-6) - exportWindow.LAYER_MARGIN });
  assert.ok(plan.skips.long && plan.skips.long.ss > 190 && plan.skips.long.ss < 200);
  // A clip at another speed, one that starts just before the selection, and
  // a sound are not asked about and are read as before.
  assert.deepEqual(asked, ['long.mp4']);
  assert.equal(plan.skips.fast, undefined);
  assert.equal(plan.skips.short, undefined);
  // A probe that fails means the long way for that clip, not no export.
  const failing = exportWindow.plan({ layers, span, fps: 24, probe: () => { throw new Error('no ffprobe'); } });
  assert.equal(failing.skips.long, undefined);
  assert.deepEqual(failing.drop, ['over', 'after']);
});

test('a selection from the start, or within a frame or two of it, has no plan', () => {
  const layers = [file('a', { duration: 400 })];
  assert.equal(exportWindow.plan({ layers, span: { start: 0, end: 5 }, fps: 24, probe: probeOf() }), null);
  assert.equal(exportWindow.plan({ layers, span: { start: 0.05, end: 5 }, fps: 24, probe: probeOf() }), null);
  assert.equal(exportWindow.plan({ layers, span: null, fps: 24, probe: probeOf() }), null);
});

const PROJECT = { width: 1920, height: 1080, fps: 24 };
const SOURCES = { 'long.mp4': { width: 1920, height: 1080 }, 't.png': { width: 1920, height: 1080 }, 'over.mp4': { width: 1920, height: 1080 } };
const graphOf = (args) => args[args.indexOf('-filter_complex') + 1];

test('without a plan, and with one for a selection from the start, the graph is the one it was', () => {
  const layers = [file('long', { duration: 400 }), sound('s', { duration: 400 })];
  const base = { layers, project: PROJECT, output: 'o.mp4', sources: SOURCES };
  const plain = buildComposeArgs({ ...base, trim: { start: 200, end: 210 } });
  assert.deepEqual(buildComposeArgs({ ...base, trim: { start: 200, end: 210 }, window: null }), plain);
  const plan = exportWindow.plan({ layers, span: { start: 200, end: 210 }, fps: 24, probe: probeOf() });
  assert.notDeepEqual(buildComposeArgs({ ...base, trim: { start: 200, end: 210 }, window: plan }), plain);
  // The same plan handed to an export of everything changes nothing.
  assert.deepEqual(buildComposeArgs({ ...base, trim: { start: 0, end: 400 }, window: plan }),
    buildComposeArgs({ ...base, trim: { start: 0, end: 400 } }));
});

test('with a plan the file is read from just before the selection and put where it stood', () => {
  const long = file('long', { start: 2, sourceIn: 5, duration: 400 });
  const over = file('over', { start: 0, duration: 50, lane: 1 });
  const still = timeline.createLayer({
    type: 'video', kind: 'image', src: 't.png', start: 10, duration: 380, id: 'still', sourceDuration: 380, lane: 2,
  });
  const layers = [still, long, over];
  const span = outputSpan(layers, { start: 200, end: 210 });
  const plan = exportWindow.plan({ layers, span, fps: 24, probe: probeOf() });
  const args = buildComposeArgs({ layers, project: PROJECT, trim: { start: 200, end: 210 }, output: 'o.mp4', sources: SOURCES, window: plan });
  const graph = graphOf(args);
  const skip = plan.skips.long;

  // The clip over before the selection is not an input at all.
  assert.ok(!args.includes('over.mp4'));
  // The file: read from the planned place, to the clip's end.
  const at = args.indexOf('long.mp4');
  assert.deepEqual(args.slice(at - 5, at), ['-ss', String(skip.ss), '-t', String(Math.round((5 + 400 - skip.ss) * 1e6) / 1e6), '-i']);
  // Its first frame put on the old count, the slots before the first kept
  // cut off, and the clip's start taken off by the old first slot.
  assert.ok(graph.includes("setpts='PTS-STARTPTS+round(" + skip.raw + "/TB)',fps=24,trim=start="
    + String(Math.round((skip.k + skip.q0 - 0.5) / 24 * 1e6) / 1e6)));
  assert.ok(graph.includes('setpts=PTS-' + skip.q0 + '+2.0/TB'));
  // The still: held for less, its first frame stamped k frames in.
  const k = plan.skips.still.k;
  assert.ok(graph.includes('trim=duration=' + String(Math.round((380 - k / 24) * 1e6) / 1e6) + ',fps=24,setpts=PTS-STARTPTS+' + k + '+10.0/TB'));
  // The black frame from just before the selection, numbered as it was.
  assert.ok(graph.includes('color=c=black:s=1920x1080:r=24:d=' + String(Math.round((210 - plan.cut / 24) * 1e6) / 1e6)
    + ',setpts=PTS+' + plan.cut + '[base]'));
  // What places and shows the layers is untouched: the selection is still cut
  // out at the end, by the same numbers.
  assert.ok(graph.includes('trim=start=200.0:end=210.0,setpts=PTS-STARTPTS[vout]'));
  assert.ok(graph.includes("enable='gte(t,2.0)*lt(t,402.0)'"));
});

test('a layer whose frames are counted from its start is read the long way', () => {
  const win = { cut: 100, drop: [], skips: { a: { k: 50, q0: 0, ss: 20, raw: '19.500000000' } } };
  const ok = file('a', { duration: 400 });
  const src = { 'a.mp4': { width: 1920, height: 1080 } };
  assert.ok(windowSkip(ok, win, src, PROJECT));
  assert.equal(windowSkip({ ...ok, speed: 2 }, win, src, PROJECT), null);
  assert.equal(windowSkip({ ...ok, frames: { pattern: 'f%d.png' } }, win, src, PROJECT), null);
  assert.equal(windowSkip({ ...ok, vfxFiles: [{ src: 'c.png' }] }, win, src, PROJECT), null);
  assert.equal(windowSkip({ ...ok, maskFile: { frames: { pattern: 'm%d.png' } } }, win, src, PROJECT), null);
  assert.ok(windowSkip({ ...ok, maskFile: { src: 'm.png' } }, win, src, PROJECT), 'one mask picture is fine');
  const moving = timeline.setLayer([ok], 'a', {
    keyframes: [{ t: 0, render: { x: 0, y: 0, width: 960, height: 540 } }, { t: 50, render: { x: 400, y: 0, width: 960, height: 540 } }],
  })[0];
  assert.ok(timeline.keyframesFor(moving).length === 2);
  assert.equal(windowSkip(moving, win, src, PROJECT), null);
  assert.equal(windowSkip(file('b'), win, src, PROJECT), null, 'no plan for it');
  assert.equal(windowSkip(ok, { ...win, skips: { a: { k: 50, q0: 0, ss: 0, raw: '1.0' } } }, src, PROJECT), null);
  // A still takes only how long it is held.
  const still = timeline.createLayer({ type: 'video', kind: 'image', src: 't.png', duration: 300, id: 'a', sourceDuration: 300 });
  assert.deepEqual(windowSkip(still, { cut: 100, drop: [], skips: { a: { k: 50 } } }, src, PROJECT), { k: 50, still: true });
});

test('the export asks for the plan, and goes the long way if that fails', () => {
  const render = fn(COMPOSER, 'render');
  assert.match(render, /window = exportWindow\.plan\(\{\s+layers: live, span, fps: [^\n]+, probe: exportWindow\.probeFrames,\s+\}\);\s+\} catch \{\s+window = null;/);
  assert.match(render, /layers, project, trim, output: out, format, compression, sources: withLuts, encoder, window,/);
});
