'use strict';

// V4.12. The cheap half of the performance work: a scrub that keeps texts,
// shapes and images on and lands every layer when the pointer rests, a
// preview drawn once a picture rather than once a screen frame, clip sizes
// read once, waveform analyses that queue, thumbnails from keyframes, caches
// kept between runs, and a still decoded once in the export.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lwc-perf412-'));
require.cache[require.resolve('electron')] = {
  exports: { app: { isPackaged: false, getPath: () => USER_DATA } },
};
const timeline = require('../src/timeline');
const waveform = require('../src/waveform');
const filmstrip = require('../src/filmstrip');
const { buildComposeArgs } = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const MAIN = read('main.js');
const CLIPS = read('renderer', 'app', 'clips.js');
const KEYFRAMES = read('renderer', 'app', 'keyframes.js');
const COMPOSITOR = read('renderer', 'app', 'compositor.js');

/** A function's source, from its name to its closing brace. */
function fn(source, name) {
  const from = source.indexOf('function ' + name + '(');
  assert.ok(from >= 0, name + ' is there');
  return source.slice(from, source.indexOf('\n}\n', from) + 3);
}

// ---- the preview: the compositor's own functions, run on a stand-in pool ----

/**
 * The scrub and draw functions as the window has them, lifted out of
 * compositor.js and given the few globals they read. `decoders` is the pool:
 * a file's entry has an element, a still's says so.
 */
function compositor() {
  const pixels = /const SCRUB_PIXELS = ([^;]+);/.exec(COMPOSITOR);
  assert.ok(pixels, 'the scrub ceiling is there');
  const names = ['paintLayers', 'topCoveringFile', 'scrubPlan', 'scrubMoving', 'compositeDrawDue', 'layerMovesAt'];
  const body = `
    let layers = [];
    const decoders = new Map();
    const popoutPreviews = new Map();
    let compositeAt = 0;
    let compositeScrub = false;
    let scrubRested = false;
    let compositeDrawnFrame = -1;
    let fps = 30;
    const SCRUB_PIXELS = ${pixels[1]};
    const projectFrame = () => ({ fps, width: 1920, height: 1080 });
    const painted = [];
    function drawLayerInto(ctx, canvas, shown) { painted.push(shown.id); }
    ${names.map((n) => fn(COMPOSITOR, n)).join('\n')}
    return {
      decoders, popoutPreviews, painted,
      set(o) {
        if ('layers' in o) layers = o.layers;
        if ('at' in o) compositeAt = o.at;
        if ('scrub' in o) compositeScrub = o.scrub;
        if ('rested' in o) scrubRested = o.rested;
        if ('fps' in o) fps = o.fps;
        if ('drawn' in o) compositeDrawnFrame = o.drawn;
      },
      ${names.join(', ')},
    };`;
  // eslint-disable-next-line no-new-func
  return new Function('timelineModel', body)(timeline);
}

const file = (id, lane, extra = {}) => timeline.createLayer({
  type: 'video', src: id + '.mp4', sourceDuration: 60, start: 0, duration: 10, lane, id, ...extra,
});
const text = (id, lane, extra = {}) => timeline.createLayer({
  type: 'video', kind: 'gen', start: 0, duration: 10, lane, id, ...extra,
});
const playing = (extra = {}) => ({ el: { paused: false }, width: 1920, height: 1080, pictures: 5, ...extra });
const CTX = { fillRect() {}, set fillStyle(v) {}, globalAlpha: 1 };
const CANVAS = { width: 853, height: 480 };

test('a scrub seeks the top file, not the text lying over it', () => {
  const c = compositor();
  const layers = [text('t', 0), file('a', 1), file('b', 2)];
  c.set({ layers, at: 2, scrub: true });
  c.decoders.set('t', { still: true, el: {} });
  c.decoders.set('a', playing());
  c.decoders.set('b', playing());
  assert.equal(c.topCoveringFile().id, 'a');
  assert.deepEqual({ file: c.scrubPlan().file.id, hold: c.scrubPlan().hold }, { file: 'a', hold: false });
});

test('a scrub passes over a file that is not read yet or is faded right out', () => {
  const c = compositor();
  c.set({ layers: [file('a', 0, { alpha: 0 }), file('b', 1), file('c', 2)], at: 2, scrub: true });
  c.decoders.set('a', playing());
  c.decoders.set('b', playing({ width: 0, height: 0 }));
  c.decoders.set('c', playing());
  assert.equal(c.topCoveringFile().id, 'c');
});

test('above 1080p a moving scrub seeks nothing and holds the picture', () => {
  const c = compositor();
  c.set({ layers: [file('a', 0)], at: 2, scrub: true });
  c.decoders.set('a', playing({ width: 3840, height: 2160 }));
  assert.deepEqual(c.scrubPlan(), { file: null, hold: true });
});

test('with only stills under the playhead there is nothing to seek and nothing to hold', () => {
  const c = compositor();
  c.set({ layers: [text('t', 0)], at: 2, scrub: true });
  c.decoders.set('t', { still: true, el: {} });
  assert.deepEqual(c.scrubPlan(), { file: null, hold: false });
});

test('a scrub is moving until the pointer rests, and again after', () => {
  const c = compositor();
  c.set({ scrub: false });
  assert.equal(c.scrubMoving(), false);
  c.set({ scrub: true, rested: false });
  assert.equal(c.scrubMoving(), true);
  c.set({ rested: true });
  assert.equal(c.scrubMoving(), false);
});

test('a moving scrub draws every still and the one file it seeks, and no other file', () => {
  const c = compositor();
  const layers = [text('t', 0), file('a', 1), file('b', 2)];
  c.set({ layers, at: 2 });
  c.decoders.set('t', { still: true, el: {} });
  c.decoders.set('a', playing());
  c.decoders.set('b', playing());

  c.paintLayers(CTX, CANVAS, 2, { file: layers[1], hold: false }, null);
  assert.deepEqual(c.painted.splice(0), ['a', 't'], 'the text stays on over the seeked file');

  // No file to seek: the stills are still drawn, where the preview went black.
  c.paintLayers(CTX, CANVAS, 2, { file: null, hold: false }, null);
  assert.deepEqual(c.painted.splice(0), ['t']);

  // At rest, and with no scrub at all, the whole picture.
  c.paintLayers(CTX, CANVAS, 2, null, null);
  assert.deepEqual(c.painted.splice(0), ['b', 'a', 't']);
});

test('the pointer resting lands every layer, and any move starts the wait again', () => {
  const rest = fn(COMPOSITOR, 'restScrub');
  assert.match(rest, /if \(!compositeScrub \|\| compositePlaying\) return;\s+scrubRested = true;\s+landDecoders\(\);/);
  const move = fn(COMPOSITOR, 'noteScrubMove');
  assert.match(move, /scrubRested = false;\s+clearTimeout\(scrubRestTimer\);\s+scrubRestTimer = setTimeout\(restScrub, SCRUB_REST_MS\);/);
  assert.match(fn(COMPOSITOR, 'seekComposite'), /if \(compositeScrub\) noteScrubMove\(\);/);
  // Letting go cancels a rest that has not come yet and lands as it always did.
  const end = fn(COMPOSITOR, 'endScrub');
  assert.match(end, /clearTimeout\(scrubRestTimer\);[\s\S]*landDecoders\(\);/);
  // And the seeks themselves follow the same plan the drawing does.
  const park = fn(COMPOSITOR, 'parkDecoders');
  assert.match(park, /const moving = scrubMoving\(\);\s+const only = moving \? scrubPlan\(\)\.file : null;/);
  assert.match(park, /if \(moving && \(!only \|\| l\.id !== only\.id\)\) continue;/);
});

test('playback draws when a file has a new picture, not on every screen frame', () => {
  const c = compositor();
  c.set({ layers: [file('a', 0)], at: 1.0, drawn: -1 });
  const entry = playing();
  c.decoders.set('a', entry);
  assert.equal(c.compositeDrawDue(), true, 'the first tick draws');
  assert.equal(c.compositeDrawDue(), false, 'the same frame again does not');
  // One project frame on with no new picture: the file is waited for.
  c.set({ at: 1.0 + 1 / 30 });
  assert.equal(c.compositeDrawDue(), false);
  // Its picture arrives: drawn at once, and the flag is taken down.
  entry.fresh = true;
  assert.equal(c.compositeDrawDue(), true);
  assert.equal(entry.fresh, false);
  assert.equal(c.compositeDrawDue(), false);
});

test('a file gone quiet does not hold the preview for more than two project frames', () => {
  const c = compositor();
  c.set({ layers: [file('a', 0)], at: 1.0, drawn: -1 });
  c.decoders.set('a', playing());
  assert.equal(c.compositeDrawDue(), true);
  c.set({ at: 1.0 + 2 / 30 });
  assert.equal(c.compositeDrawDue(), true);
});

test('a file that never reports its pictures is drawn by the clock, once a project frame', () => {
  const c = compositor();
  c.set({ layers: [file('a', 0)], at: 1.0, drawn: -1 });
  c.decoders.set('a', playing({ pictures: 0 }));
  assert.equal(c.compositeDrawDue(), true);
  assert.equal(c.compositeDrawDue(), false);
  c.set({ at: 1.0 + 1 / 30 });
  assert.equal(c.compositeDrawDue(), true);
});

test('with only stills the preview is drawn once a project frame, and a jump back is drawn', () => {
  const c = compositor();
  c.set({ layers: [text('t', 0)], at: 5.0, drawn: -1 });
  c.decoders.set('t', { still: true, el: {} });
  assert.equal(c.compositeDrawDue(), true);
  assert.equal(c.compositeDrawDue(), false);
  c.set({ at: 5.0 + 1 / 30 });
  assert.equal(c.compositeDrawDue(), true);
  c.set({ at: 2.0 });
  assert.equal(c.compositeDrawDue(), true);
});

test('a fade or keyframes over a running file are drawn every project frame', () => {
  const fading = text('t', 0, { fadeIn: 3 });
  assert.ok(timeline.layerAlphaAt(fading, 1) < 1, 'the text is mid-fade');
  const c = compositor();
  c.set({ layers: [fading, file('a', 1)], at: 1.0, drawn: -1 });
  c.decoders.set('t', { still: true, el: {} });
  c.decoders.set('a', playing());
  assert.equal(c.layerMovesAt(fading, 1.0), true);
  assert.equal(c.layerMovesAt(fading, 5.0), false, 'past its fade it stands still');
  assert.equal(c.compositeDrawDue(), true);
  c.set({ at: 1.0 + 1 / 30 });
  assert.equal(c.compositeDrawDue(), true, 'not left waiting for the file');
  // Past the fade the file is what is waited for again.
  c.set({ at: 5.0, drawn: -1 });
  assert.equal(c.compositeDrawDue(), true);
  c.set({ at: 5.0 + 1 / 30 });
  assert.equal(c.compositeDrawDue(), false);

  const keyed = file('k', 0, { keyframes: [{ t: 0 }, { t: 4 }] });
  assert.equal(c.layerMovesAt({ ...keyed, keyframes: [{ t: 0 }, { t: 4 }] }, 1.0), true);
  assert.equal(c.layerMovesAt(file('p', 0), 1.0), false);
});

test('each decoder reports its new pictures, and the tick draws only when one is due', () => {
  const add = fn(COMPOSITOR, 'addDecoder');
  assert.match(add, /entry\.fresh = true;\s+entry\.pictures = \(entry\.pictures \|\| 0\) \+ 1;\s+v\.requestVideoFrameCallback\(onPicture\);/);
  assert.match(fn(COMPOSITOR, 'compositeTick'), /if \(compositeDrawDue\(\)\) drawComposite\(\);/);
  // Play and a seek both draw whatever was drawn last.
  assert.match(fn(COMPOSITOR, 'seekComposite'), /compositeDrawnFrame = -1;/);
  assert.match(fn(COMPOSITOR, 'playComposite'), /compositeDrawnFrame = -1;/);
});

// ---- the timeline: sizes read once ----

test('every clip is measured before any clip is moved', () => {
  const place = fn(CLIPS, 'positionLayerClips');
  const read = place.indexOf('const boxes = clips.map(clipBoxOf);');
  assert.ok(read >= 0, 'the sizes are read in one go');
  // After that line nothing in the loop asks the page for a size again: one
  // read after a write is a whole layout, and it was three a clip.
  const rest = place.slice(read + 10);
  assert.doesNotMatch(rest, /\.(clientHeight|offsetTop|offsetHeight)\b/);
  assert.match(rest, /placeClipKeyframes\(clip, layer, box\)/);
  assert.match(rest, /placeAlphaLine\(track, clip, layer, x0, from, visible, gripW, box\)/);
  assert.match(fn(CLIPS, 'clipBoxOf'), /inner: clip\.clientHeight, top: clip\.offsetTop, outer: clip\.offsetHeight/);
  assert.match(fn(KEYFRAMES, 'placeClipKeyframes'), /box = clipBoxOf\(clip\)/);
  assert.doesNotMatch(fn(KEYFRAMES, 'placeClipKeyframes').split('\n').slice(1).join('\n'),
    /clip\.(clientHeight|offsetTop|offsetHeight)\b/);
});

// ---- waveforms and thumbnails: queued, stopped is not empty, kept ----

test('waveform analyses queue: one at a time, in order, a failure not in the way', async () => {
  const order = [];
  let running = 0;
  let most = 0;
  const job = (name, ms, fail) => () => new Promise((resolve, reject) => {
    running += 1;
    most = Math.max(most, running);
    setTimeout(() => {
      running -= 1;
      order.push(name);
      if (fail) reject(new Error(name));
      else resolve(name);
    }, ms);
  });
  const a = waveform.enqueue(job('a', 30));
  const b = waveform.enqueue(job('b', 1, true));
  const c = waveform.enqueue(job('c', 1));
  assert.equal(await a, 'a');
  await assert.rejects(b, /b/);
  assert.equal(await c, 'c');
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(most, 1);
});

test('a request for another file no longer ends the analysis in flight', () => {
  const src = read('src', 'waveform.js');
  const peaksFor = src.slice(src.indexOf('async function peaksFor('));
  // The old first line of peaksFor was a bare abort(): a second clip's
  // request killed the first one's decode, and what it had read by then was
  // cached as the whole waveform.
  assert.match(peaksFor, /if \(currentChild && currentFile === filePath\) abort\(\);\s+const peaks = await enqueue\(/);
  assert.equal((peaksFor.match(/\babort\(\)/g) || []).length, 1);
  // And a decode that was stopped answers as stopped, never with what it had.
  assert.match(src, /if \(child\.lwcStopped\) return reject\(stoppedError\(\)\);/);
  assert.equal(waveform.stoppedError().stopped, true);
  assert.equal(filmstrip.stoppedError().stopped, true);
});

test('the window is told when a request was stopped, and asks again instead of giving up', () => {
  assert.equal((MAIN.match(/stopped: !!\(e && e\.stopped\)/g) || []).length, 2);
  const peaks = fn(CLIPS, 'ensurePeaks');
  const stopped = peaks.slice(peaks.indexOf('if (result.stopped)'), peaks.indexOf('if (!result.ok)'));
  assert.match(stopped, /pending: false/);
  assert.doesNotMatch(stopped, /Infinity/);
  assert.match(stopped, /redrawTimelineSoon\(\);/);
  const strip = fn(CLIPS, 'ensureStrip');
  const cut = strip.slice(strip.indexOf('if (result.stopped)'), strip.indexOf('if (!result.ok'));
  assert.doesNotMatch(cut, /dead: true/);
  assert.match(cut, /redrawTimelineSoon\(\);/);
});

test('waveforms and thumbnails are kept between runs, and Clear cache is what empties them', () => {
  // The only place either is cleared is the Clear cache handler.
  assert.equal((MAIN.match(/waveform\.clearPeaks\(\)/g) || []).length, 1);
  assert.equal((MAIN.match(/filmstrip\.clearStrips\(\)/g) || []).length, 1);
  const from = MAIN.indexOf("ipcMain.handle('tools:clearCache'");
  const handler = MAIN.slice(from, MAIN.indexOf('\n});\n', from));
  assert.match(handler, /const derived = derivedCacheBytes\(\);\s+waveform\.clearPeaks\(\);\s+filmstrip\.clearStrips\(\);\s+freed \+= Math\.max\(0, derived - derivedCacheBytes\(\)\);/);
  // Quitting stops what is running without deleting anything.
  const quit = MAIN.slice(MAIN.indexOf("app.on('will-quit'"));
  assert.match(quit.slice(0, quit.indexOf('\n});\n')), /waveform\.abort\(\);\s+filmstrip\.abort\(\);/);
});

test('clearing the waveforms removes the files and says how many', () => {
  const dir = waveform.peaksPath();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'one.json'), '{}');
  fs.writeFileSync(path.join(dir, 'two.json'), '{}');
  assert.equal(waveform.clearPeaks(), 2);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(waveform.clearPeaks(), 0);
});

// ---- thumbnails from keyframes ----

test('only a coarse sheet is made from keyframes', () => {
  assert.equal(filmstrip.KEYFRAME_SECONDS, 8);
  // 32 thumbnails of 18 minutes stand for half a minute each.
  assert.equal(filmstrip.keyframesWorth({ span: 1080, tiles: 32 }), true);
  assert.equal(filmstrip.keyframesWorth({ span: 256, tiles: 32 }), true);
  // Denser than one in eight seconds the pictures would repeat.
  assert.equal(filmstrip.keyframesWorth({ span: 255, tiles: 32 }), false);
  assert.equal(filmstrip.keyframesWorth({ span: 1080, tiles: 256 }), false);
});

test('the keyframe pass counts what it decoded, and too few sends the sheet the long way', () => {
  const log = 'frame=    1 fps=0.4\n'
    + 'Input file #0 (a.mp4):\n'
    + '  Input stream #0:0 (video): 8638 packets read (41234567 bytes); 89 frames decoded; 0 decode errors;\n'
    + '  Input stream #0:1 (audio): 0 packets read (0 bytes); 0 frames decoded;\n';
  assert.equal(filmstrip.framesDecoded(log), 89);
  assert.equal(filmstrip.framesDecoded('nothing of the kind'), null);
  assert.equal(filmstrip.keyframesEnough(89, 32), true);
  assert.equal(filmstrip.keyframesEnough(32, 32), true);
  assert.equal(filmstrip.keyframesEnough(31, 32), false);
  assert.equal(filmstrip.keyframesEnough(null, 32), false, 'not knowing is not enough');
  const src = read('src', 'filmstrip.js');
  const extract = src.slice(src.indexOf('async function extract('));
  assert.match(extract, /if \(keyframesEnough\(decoded, plan\.tiles\)\) return;/);
  assert.match(extract, /if \(e && e\.stopped\) throw e;/);
});

test('the keyframe pass skips every other frame and holds the last one to the end', () => {
  const plan = { tiles: 32, span: 1080, start: 0, chunks: 1 };
  const keyed = filmstrip.extractArgs('a.mp4', plan, 'out.jpg', true);
  const skip = keyed.indexOf('-skip_frame');
  assert.ok(skip >= 0 && skip < keyed.indexOf('-i'), 'a decoder option, so before the input');
  assert.equal(keyed[skip + 1], 'nokey');
  assert.equal(keyed[keyed.indexOf('-loglevel') + 1], 'verbose');
  // Two thumbnails' worth of the last keyframe, 2 * 1080 / 32 seconds.
  assert.match(keyed[keyed.indexOf('-vf') + 1], /^tpad=stop_mode=clone:stop_duration=67\.500,fps=0\.029630,scale=/);

  const whole = filmstrip.extractArgs('a.mp4', plan, 'out.jpg', false);
  assert.ok(!whole.includes('-skip_frame'));
  assert.equal(whole[whole.indexOf('-loglevel') + 1], 'error');
  assert.match(whole[whole.indexOf('-vf') + 1], /^fps=0\.029630,scale=/);
});

// ---- the export: a still decoded once ----

test('a still picture is read once and its frame held, a video is read as before', () => {
  const HD = { width: 1920, height: 1080, fps: 30 };
  const layers = [
    timeline.createLayer({ type: 'video', kind: 'image', src: 'shot.png', sourceDuration: 6, duration: 6, lane: 0, id: 's' }),
    timeline.createLayer({ type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, lane: 1, id: 'v' }),
  ];
  const args = buildComposeArgs({
    layers, project: HD, output: 'out.mp4',
    sources: { 'a.mp4': { width: 1920, height: 1080 }, 'shot.png': { width: 1600, height: 900 } },
  });
  // `-loop 1 ... -t` made the demuxer hand the picture over, and the decoder
  // decode it, once for every frame of the clip.
  assert.ok(!args.includes('-loop'));
  const at = args.indexOf('shot.png');
  assert.deepEqual(args.slice(at - 3, at), ['-framerate', '30', '-i']);
  const graph = args[args.indexOf('-filter_complex') + 1];
  const holds = graph.split('loop=loop=-1:size=1:start=0,trim=duration=').length - 1;
  assert.equal(holds, 1, 'the one still is held, the video is not');
  assert.ok(graph.includes('loop=loop=-1:size=1:start=0,trim=duration=6.0,fps=30,'), graph);
});
