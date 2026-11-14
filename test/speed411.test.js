'use strict';

// V4.11. A clip's speed: the same part of its source in more or less time.
// The model (where a moment of the timeline is in the source, stretching by
// an edge, going back), the export's graph, and the drag and the readouts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const P = require('../src/project');
const { buildComposeArgs, tempoFilters } = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CLIPS = read('renderer', 'app', 'clips.js');
const COMPOSITOR = read('renderer', 'app', 'compositor.js');

const HD = { width: 1920, height: 1080, fps: 30 };
const SRC = { 'a.mp4': { width: 1920, height: 1080 } };
const near = (a, b, e = 1e-5) => Math.abs(a - b) < e;

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, sourceIn: 5, duration: 10, start: 20,
    sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

function graphOf(args) {
  return args[args.indexOf('-filter_complex') + 1];
}

// ---- the model ----

test('a layer plays at 1 until it is stretched, a tenth to ten times, and a still always at 1', () => {
  assert.equal(vid({}).speed, 1);
  assert.equal(T.speedOf(vid({})), 1);
  assert.equal(vid({ speed: 2.5 }).speed, 2.5);
  assert.equal(vid({ speed: 0.01 }).speed, 0.1);
  assert.equal(vid({ speed: 99 }).speed, 10);
  for (const junk of [undefined, null, '', 'fast', 0, -3, NaN]) assert.equal(vid({ speed: junk }).speed, 1, String(junk));
  assert.deepEqual([T.SPEED_MIN, T.SPEED_MAX], [0.1, 10]);
  const image = T.createLayer({ type: 'video', kind: 'image', src: 'a.png', speed: 4 });
  assert.equal(image.speed, 1);
  assert.equal(T.speedOf({ ...image, speed: 4 }), 1);
  const text = T.createLayer({ kind: 'gen', gen: { form: 'text' }, speed: 4 });
  assert.equal(text.speed, 1);
});

test('a moment of the timeline is that much further into the source at the layer\'s speed', () => {
  const l = vid({ speed: 2 });
  assert.equal(T.sourceTimeFor(l, 20), 5);
  assert.equal(T.sourceTimeFor(l, 23), 11);
  assert.equal(T.sourceTimeFor(vid({ speed: 0.5 }), 24), 7);
  // At 1 it is the sum it always was.
  assert.equal(T.sourceTimeFor(vid({}), 23), 8);
});

test('how far an edge can be dragged out is in the timeline\'s seconds', () => {
  const l = vid({ speed: 2, duration: 10 });
  // 55 seconds of source are left from the in point, which is 27.5 of timeline.
  assert.equal(T.sourceRemaining(l), 27.5);
  assert.equal(T.sourceBefore(l), 2.5);
  // A layer made at a speed fills as much timeline as its source does at it.
  assert.equal(vid({ speed: 2, duration: undefined }).duration, 27.5);
  assert.equal(vid({ speed: 2, duration: 500 }).duration, 27.5, 'and never more');
  assert.equal(vid({ speed: 0.5, duration: 500 }).duration, 110);
  // The end can be trimmed out that far and no further.
  const out = T.trimLayer([l], 'v', 'end', 999);
  assert.equal(T.endOf(out[0]), 47.5);
  // And the start back to where the source begins.
  const back = T.trimLayer([l], 'v', 'start', 0);
  assert.equal(back[0].start, 17.5);
  assert.equal(back[0].sourceIn, 0);
});

test('a trim and a split move the in point by the source that went by', () => {
  const l = vid({ speed: 2 });
  const trimmed = T.trimLayer([l], 'v', 'start', 21)[0];
  assert.equal(trimmed.sourceIn, 7);
  assert.equal(trimmed.duration, 9);
  assert.equal(T.sourceTimeFor(trimmed, 23), T.sourceTimeFor(l, 23), 'the picture stays where it was');
  const [left, right] = T.splitLayer([l], 'v', 24);
  assert.equal(left.duration, 4);
  assert.equal(right.sourceIn, 13);
  assert.deepEqual([left.speed, right.speed], [2, 2]);
  assert.equal(T.sourceTimeFor(right, 24), T.sourceTimeFor(l, 24));
});

// ---- stretching ----

test('dragging the end with Ctrl keeps the same part of the source and makes it take the new length', () => {
  const l = vid({});
  const fast = T.stretchGroup([l], 'v', 'end', 25)[0];
  assert.equal(fast.start, 20);
  assert.equal(fast.duration, 5);
  assert.equal(fast.speed, 2);
  assert.equal(fast.sourceIn, 5);
  assert.equal(T.sourceTimeFor(fast, 25), 15, 'it still ends on the same moment of the source');
  const slow = T.stretchGroup([l], 'v', 'end', 40)[0];
  assert.equal(slow.duration, 20);
  assert.equal(slow.speed, 0.5);
  assert.equal(T.sourceTimeFor(slow, 40), 15);
});

test('dragging the start with Ctrl leaves the end where it is', () => {
  const l = vid({});
  const fast = T.stretchGroup([l], 'v', 'start', 25)[0];
  assert.equal(fast.start, 25);
  assert.equal(T.endOf(fast), 30);
  assert.equal(fast.speed, 2);
  assert.equal(fast.sourceIn, 5, 'nothing is cut off the front');
  const slow = T.stretchGroup([l], 'v', 'start', 10)[0];
  assert.equal(slow.start, 10);
  assert.equal(T.endOf(slow), 30);
  assert.equal(slow.speed, 0.5);
});

test('it stops at a tenth and at ten times the speed, and at the start of the timeline', () => {
  const l = vid({});
  const fastest = T.stretchGroup([l], 'v', 'end', 20.2)[0];
  assert.equal(fastest.speed, 10);
  assert.equal(fastest.duration, 1);
  const slowest = T.stretchGroup([l], 'v', 'end', 5000)[0];
  assert.equal(slowest.speed, 0.1);
  assert.equal(slowest.duration, 100);
  // From a speed it already has, the range is still a tenth to ten.
  assert.equal(T.stretchGroup([vid({ speed: 5, duration: 2 })], 'v', 'end', 20.1)[0].speed, 10);
  // The start edge cannot go before the timeline's own start.
  const early = T.stretchGroup([vid({ start: 3 })], 'v', 'start', -50)[0];
  assert.equal(early.start, 0);
  assert.equal(T.endOf(early), 13);
  assert.ok(near(early.speed, 10 / 13));
  // Nothing to do hands the same list back.
  const list = [l];
  assert.equal(T.stretchGroup(list, 'v', 'end', 30), list);
  assert.equal(T.stretchGroup(list, 'nobody', 'end', 30), list);
});

test('stretched again and again it still shows the same part of its source', () => {
  let list = [vid({})];
  for (const end of [23.7, 41.3, 26.111, 20.9, 33, 30]) list = T.stretchGroup(list, 'v', 'end', end);
  const l = list[0];
  assert.equal(l.duration, 10);
  assert.equal(l.speed, 1);
  assert.ok(near(l.duration * l.speed, 10));
});

test('what is on the clip goes with what it shows: keyframes spread out, fades keep their length', () => {
  const l = vid({
    fadeIn: 2,
    fadeOut: 3,
    keyframes: [{ id: 'a', t: 1, render: { x: 0, y: 0, width: 100, height: 100 } }, { id: 'b', t: 8, render: { x: 9, y: 9, width: 100, height: 100 } }],
    obscure: { areas: [{ kind: 'square', box: { x: 0, y: 0, w: 0.2, h: 0.2 },
      keys: [{ id: 'k', t: 2, box: { x: 0, y: 0, w: 0.2, h: 0.2 } }, { id: 'm', t: 6, box: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } }] }] },
  });
  const slow = T.stretchGroup([l], 'v', 'end', 40)[0];
  assert.deepEqual(slow.keyframes.map((k) => k.t), [2, 16]);
  assert.deepEqual(slow.obscure.areas[0].keys.map((k) => k.t), [4, 12]);
  assert.deepEqual([slow.fadeIn, slow.fadeOut], [2, 3]);
  // Each keyframe is still on the same moment of the source.
  assert.equal(T.sourceTimeFor(slow, slow.start + 16), T.sourceTimeFor(l, l.start + 8));
  // Made short, the fades give way to the clip and never overlap.
  const fast = T.stretchGroup([l], 'v', 'end', 24)[0];
  assert.equal(fast.duration, 4);
  assert.deepEqual([fast.fadeIn, fast.fadeOut], [2, 2]);
  assert.deepEqual(fast.keyframes.map((k) => k.t), [0.4, 3.2]);
});

test('a picture and its sound stretch together, and a still is simply trimmed', () => {
  const list = [
    vid({ id: 'p', groupId: 'g' }),
    T.createLayer({ id: 's', type: 'audio', src: 'a.mp4', sourceDuration: 60, sourceIn: 5, duration: 10, start: 20, groupId: 'g' }),
  ];
  const next = T.stretchGroup(list, 'p', 'end', 24);
  for (const id of ['p', 's']) {
    const l = T.layerById(next, id);
    assert.deepEqual([l.start, l.duration, l.speed], [20, 4, 2.5], id);
  }
  const image = [T.createLayer({ id: 'i', type: 'video', kind: 'image', src: 'a.png', start: 20, duration: 10 })];
  const cut = T.stretchGroup(image, 'i', 'end', 26);
  assert.deepEqual(cut, T.trimGroup(image, 'i', 'end', 26));
  assert.equal(cut[0].speed, 1);
});

test('a reset puts a clip back at its own speed and the length its source has', () => {
  const l = vid({ keyframes: [{ id: 'a', t: 1, render: { x: 0, y: 0, width: 100, height: 100 } }, { id: 'b', t: 8, render: { x: 9, y: 9, width: 100, height: 100 } }] });
  const list = [l];
  assert.equal(T.resetSpeed(list, 'v'), list, 'nothing to reset at 1');
  const fast = T.stretchGroup(list, 'v', 'end', 24);
  const back = T.resetSpeed(fast, 'v')[0];
  assert.equal(back.speed, 1);
  assert.equal(back.start, 20);
  assert.equal(back.duration, 10);
  assert.deepEqual(back.keyframes.map((k) => k.t), [1, 8]);
  // A pair goes back together.
  const pair = T.stretchGroup([
    vid({ id: 'p', groupId: 'g' }),
    T.createLayer({ id: 's', type: 'audio', src: 'a.mp4', sourceDuration: 60, sourceIn: 5, duration: 10, start: 20, groupId: 'g' }),
  ], 'p', 'start', 28);
  assert.deepEqual(pair.map((x) => [x.start, x.duration, x.speed]), [[28, 2, 5], [28, 2, 5]]);
  const reset = T.resetSpeed(pair, 's');
  assert.deepEqual(reset.map((x) => [x.start, x.duration, x.speed]), [[28, 10, 1], [28, 10, 1]]);
});

test('the speed is kept by the project file, and a file from before opens at 1', () => {
  const l = T.stretchGroup([vid({})], 'v', 'end', 24)[0];
  const out = P.parse(P.stringify(P.serialise({ layers: [l], project: HD, trim: { start: 0, end: 30 } })));
  assert.equal(out.ok, true);
  const back = T.createLayer(out.doc.layers[0]);
  assert.equal(back.speed, 2.5);
  assert.equal(back.duration, 4);
  const old = { ...l };
  delete old.speed;
  assert.equal(T.createLayer({ ...old, duration: 10 }).speed, 1);
});

// ---- the export ----

test('the encoder reads as much source as the layer shows and brings it to the layer\'s pace first', () => {
  const plain = buildComposeArgs({ layers: [vid({})], project: HD, output: 'o.mp4', sources: SRC });
  assert.ok(plain.join(' ').includes('-ss 5.0 -t 10.0 -i a.mp4'));
  assert.equal(graphOf(plain).includes('setpts=(PTS-STARTPTS)/'), false, 'a layer at 1 is said as it always was');
  const fast = buildComposeArgs({ layers: [vid({ speed: 2.5, duration: 4 })], project: HD, output: 'o.mp4', sources: SRC });
  assert.ok(fast.join(' ').includes('-ss 5.0 -t 10.0 -i a.mp4'), 'ten seconds of source for four of timeline');
  // Rounded up: each frame of the file is the source frame the preview shows there.
  assert.ok(graphOf(fast).includes('[0:v]setpts=(PTS-STARTPTS)/2.5,fps=30:round=up,fps=30'));
  // Its place on the timeline and its length there are the layer's.
  assert.ok(graphOf(fast).includes("enable='gte(t,20.0)*lt(t,24.0)'"));
  const slow = buildComposeArgs({ layers: [vid({ speed: 0.5, duration: 20 })], project: HD, output: 'o.mp4', sources: SRC });
  assert.ok(slow.join(' ').includes('-ss 5.0 -t 10.0 -i a.mp4'));
  assert.ok(graphOf(slow).includes('[0:v]setpts=(PTS-STARTPTS)/0.5,fps=30:round=up,fps=30'));
});

test('a sound is stretched with its pitch kept, in steps a half to two wide, before its fades', () => {
  assert.deepEqual(tempoFilters(1), []);
  assert.deepEqual(tempoFilters(1.5), ['atempo=1.5']);
  assert.deepEqual(tempoFilters(2), ['atempo=2.0']);
  assert.deepEqual(tempoFilters(10), ['atempo=2.0', 'atempo=2.0', 'atempo=2.0', 'atempo=1.25']);
  assert.deepEqual(tempoFilters(0.1), ['atempo=0.5', 'atempo=0.5', 'atempo=0.5', 'atempo=0.8']);
  assert.deepEqual(tempoFilters(0.5), ['atempo=0.5']);
  // Every chain multiplies out to the speed it was asked for.
  for (const speed of [0.1, 0.25, 0.37, 0.5, 0.9, 1.5, 3, 7.3, 10]) {
    const product = tempoFilters(speed).reduce((n, f) => n * Number(f.split('=')[1]), 1);
    assert.ok(near(product, speed, 1e-4), speed + ' came out ' + product);
    for (const f of tempoFilters(speed)) {
      const step = Number(f.split('=')[1]);
      assert.ok(step >= 0.5 && step <= 2, f);
    }
  }
  const sound = T.createLayer({
    id: 's', type: 'audio', src: 'a.mp3', sourceDuration: 60, sourceIn: 5, duration: 4, start: 2, speed: 2.5, fadeOut: 1,
  });
  const args = buildComposeArgs({ layers: [sound], project: HD, output: 'o.mp3', format: 'mp3', sources: {} });
  assert.ok(args.join(' ').includes('-ss 5.0 -t 10.0 -i a.mp3'));
  const g = graphOf(args);
  assert.ok(g.includes('[0:a]asetpts=PTS-STARTPTS,atempo=2.0,atempo=1.25,afade=t=out:st=3.0:d=1.0,adelay=2000:all=1'), g);
});

// ---- the drag and the readouts ----

test('Ctrl on a clip\'s edge changes its speed, and on a still it is the fine trim it was', () => {
  const drag = CLIPS.slice(CLIPS.indexOf('function bindClipDrag('), CLIPS.indexOf('// ---- V4.11. The speed of a clip, shown ----'));
  assert.match(drag, /const stretchy = !!edge && !timelineModel\.isStill\(layer\);/);
  assert.match(drag, /const modeOf = \(ev\) => \(stretchy && ev\.ctrlKey \? 'speed' : 'trim'\);/);
  assert.match(drag, /drag\.mode === 'speed'\s+\? timelineModel\.stretchGroup\(layers, layerId, edge, value\)\s+: timelineModel\.trimGroup\(layers, layerId, edge, value\)/);
  // Pressed or let go mid drag, the gesture carries on from where the clip is.
  assert.match(drag, /if \(factor !== drag\.factor \|\| mode !== drag\.mode\) \{/);
  assert.match(drag, /window\.addEventListener\('keydown', onKey, true\);/);
  assert.match(drag, /window\.removeEventListener\('keyup', onKey, true\);/);
});

test('the speed is written beside the pointer while dragging and stays in the clip\'s middle after', () => {
  const shown = CLIPS.slice(CLIPS.indexOf('// ---- V4.11. The speed of a clip, shown ----'), CLIPS.indexOf('const FADE_DRAG_SLOP'));
  assert.match(shown, /speedTip\.textContent = t\('Speed: x\{n\}', \{ n: speedText\(speed\) \}\);/);
  assert.match(shown, /const shown = \(live \|\| speed !== 1\) && visible >= 76;/);
  assert.match(shown, /live \? t\('Speed: x\{n\}', \{ n: speedText\(speed\) \}\) : t\('Speed x\{n\}', \{ n: speedText\(speed\) \}\)/);
  // The figures as they are written.
  const speedText = new Function(shown.slice(shown.indexOf('function speedText('), shown.indexOf('/** The speed beside the pointer')) + '; return speedText;')();
  assert.deepEqual([1, 2.5, 0.1, 10, 1.37, 0.333, 1.999].map(speedText), ['1.0', '2.5', '0.1', '10.0', '1.37', '0.33', '2.0']);
  // A right click on the figure puts the clip back, as one step.
  const build = CLIPS.slice(CLIPS.indexOf('function buildLayerClip('), CLIPS.indexOf('// ---- moving and trimming a clip ----'));
  assert.match(build, /figure\.className = 'clip-speed';/);
  assert.match(build, /line\.className = 'clip-speed-line';/);
  assert.match(build, /const next = timelineModel\.resetSpeed\(layers, layer\.id\);\s+if \(next === layers\) return;\s+selectLayer\(layer\.id\);\s+setLayers\(next\);\s+commitHistory\(\);/);
  const css = read('renderer', 'style.css');
  assert.ok(css.includes('.clip-speed-line {') && css.includes('.speed-tip {'));
});

test('the preview plays each clip at its speed, a sound with its pitch kept', () => {
  assert.match(COMPOSITOR, /const rate = timelineModel\.speedOf\(l\);\s+if \(v\.playbackRate !== rate\) v\.playbackRate = rate;/);
  assert.match(COMPOSITOR, /a\.preservesPitch = true;\s+a\.playbackRate = rate;/);
});
