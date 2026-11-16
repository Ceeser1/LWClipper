'use strict';

// V4.8. Obscure and Pixelate areas that move: an area's own keyframes in the
// model, what a trim and a split do to them, the export's frames, and the
// window's strip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const D = require('../src/genDraw');
const P = require('../src/project');
const { buildComposeArgs } = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = read('renderer', 'index.html');

const HD = { width: 1920, height: 1080, fps: 30 };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const BOX = { x: 0.1, y: 0.2, w: 0.2, h: 0.2 };
const FAR = { x: 0.6, y: 0.4, w: 0.3, h: 0.4 };
// An area that goes from BOX to FAR over the clip's second to its sixth second.
const MOVER = {
  kind: 'circle',
  box: BOX,
  keys: [{ id: 'a', t: 2, box: BOX, rotation: 0 }, { id: 'b', t: 6, box: FAR, rotation: 40 }],
};
const STILL = { kind: 'square', box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } };

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

function graphOf(args) {
  return args[args.indexOf('-filter_complex') + 1];
}

// ---- the model ----

test('an area without keyframes is the area 4.7 wrote, with no keys at all', () => {
  const c = T.coverOf({ areas: [STILL, { ...STILL, keys: [] }, { ...STILL, keys: 'nonsense' }] }, 'obscure');
  for (const a of c.areas) {
    assert.deepEqual(a, { kind: 'square', box: STILL.box, rotation: 0 });
    assert.equal('keys' in a, false);
  }
  assert.equal(T.coverAt(c, 3), c, 'and the effect at any moment is the very same object');
  assert.equal(T.coverMotion(vid({}), c), null);
});

test('an area\'s keyframes are held in time order, one to a moment and one to an id', () => {
  const c = T.coverOf({ areas: [{
    kind: 'star',
    box: BOX,
    keys: [
      { id: 'b', t: 6, box: FAR, rotation: 400 },
      { id: 'a', t: 2, box: BOX },
      { id: 'a', t: 4, box: FAR },
      { t: 'never', box: BOX },
      { id: 'c', t: 6, box: BOX, rotation: 10 },
      null,
    ],
  }] }, 'pixelate');
  const keys = c.areas[0].keys;
  assert.deepEqual(keys.map((k) => k.t), [2, 4, 6]);
  assert.equal(new Set(keys.map((k) => k.id)).size, 3, 'a second one of the same id is given its own');
  assert.equal(keys[0].id, 'a');
  assert.deepEqual(keys[2], { id: 'c', t: 6, box: BOX, rotation: 10 }, 'the later of two at one moment wins');
  assert.deepEqual(T.coverOf({ areas: [{ ...STILL, keys: [{ id: 'k', t: 1, box: { w: -1 }, rotation: 270 }] }] }, 'obscure')
    .areas[0].keys, [{ id: 'k', t: 1, box: { x: 0, y: 0, w: 1, h: 1 }, rotation: -90 }], 'each held to a box and a turn');
});

test('between two keyframes an area\'s box and turn go smoothly from the one to the other', () => {
  const area = T.coverOf({ areas: [MOVER] }, 'obscure').areas[0];
  const at = (t) => T.coverAreaAt(area, t);
  assert.deepEqual(at(0), { kind: 'circle', box: BOX, rotation: 0 }, 'before the first it is the first\'s');
  assert.deepEqual(at(2), { kind: 'circle', box: BOX, rotation: 0 });
  assert.deepEqual(at(9), { kind: 'circle', box: FAR, rotation: 40 }, 'after the last the last\'s');
  const mid = at(4);
  assert.ok(near(mid.box.x, 0.35) && near(mid.box.y, 0.3) && near(mid.box.w, 0.25) && near(mid.box.h, 0.3));
  assert.ok(near(mid.rotation, 20));
  assert.equal('keys' in mid, false, 'what the drawing takes has no keyframes');
  // The turn goes the short way round, as a picture's does.
  const turner = { kind: 'square', box: BOX, keys: [{ id: 'a', t: 0, box: BOX, rotation: 170 }, { id: 'b', t: 2, box: BOX, rotation: -170 }] };
  assert.ok(near(Math.abs(T.coverAreaAt(turner, 1).rotation), 180), '170 to -170 passes 180, not 0');
  // One keyframe alone is where the area is at every moment.
  const one = { kind: 'square', box: BOX, keys: [{ id: 'a', t: 5, box: FAR, rotation: 15 }] };
  assert.deepEqual(T.coverAreaAt(one, 0).box, FAR);
  assert.deepEqual(T.coverAreaAt(one, 9).box, FAR);
});

test('the effect at a moment is every area where its own keyframes put it then', () => {
  const c = T.coverOf({ strength: 40, soft: 0.02, invert: true, areas: [MOVER, STILL] }, 'obscure');
  const now = T.coverAt(c, 4);
  assert.deepEqual([now.strength, now.soft, now.invert], [40, 0.02, true]);
  assert.ok(near(now.areas[0].box.x, 0.35));
  assert.deepEqual(now.areas[1], { kind: 'square', box: STILL.box, rotation: 0 }, 'one without keyframes stays put');
  assert.ok(now.areas.every((a) => !('keys' in a)));
});

test('an effect moves from its first keyframe in view to its last, and not at all when they say the same', () => {
  const l = vid({ obscure: { areas: [MOVER, STILL] } });
  assert.deepEqual(T.coverMotion(l, l.obscure), { from: 2, to: 6 });
  // A keyframe trimmed out of view still steers, so the move starts with the clip.
  const early = { ...MOVER, keys: [{ id: 'a', t: -3, box: BOX }, { id: 'b', t: 6, box: FAR }] };
  assert.deepEqual(T.coverMotion(l, T.coverOf({ areas: [early] }, 'obscure')), { from: 0, to: 6 });
  const late = { ...MOVER, keys: [{ id: 'a', t: 4, box: BOX }, { id: 'b', t: 25, box: FAR }] };
  assert.deepEqual(T.coverMotion(l, T.coverOf({ areas: [late] }, 'obscure')), { from: 4, to: 10 });
  // Two areas: from the earliest to the latest.
  const two = T.coverOf({ areas: [MOVER, { ...MOVER, keys: [{ id: 'c', t: 1, box: BOX }, { id: 'd', t: 3, box: FAR }] }] }, 'obscure');
  assert.deepEqual(T.coverMotion(l, two), { from: 1, to: 6 });
  const same = T.coverOf({ areas: [{ ...MOVER, keys: [{ id: 'a', t: 2, box: BOX }, { id: 'b', t: 6, box: BOX }] }] }, 'obscure');
  assert.equal(T.coverMotion(l, same), null, 'keyframes that all say the same move nothing');
  const gone = T.coverOf({ areas: [{ ...MOVER, keys: [{ id: 'a', t: -9, box: BOX }, { id: 'b', t: -2, box: FAR }] }] }, 'obscure');
  assert.equal(T.coverMotion(l, gone), null, 'all of it trimmed off the front');
});

test('a keyframe is put, moved and found on an area in whatever unit its boxes are', () => {
  const PX = { x: 100, y: 200, w: 300, h: 400 };
  let area = { kind: 'square', box: PX, rotation: 0 };
  area = T.putCoverKey(area, { id: 'a', t: 0, box: PX, rotation: 0 });
  area = T.putCoverKey(area, { id: 'b', t: 4, box: { ...PX, x: 900 }, rotation: 30 });
  assert.deepEqual(area.keys.map((k) => k.id), ['a', 'b']);
  assert.equal(T.coverAreaAt(area, 2).box.x, 500, 'pixels blend as fractions do');
  // The same id again changes that one; another at its moment gives way.
  area = T.putCoverKey(area, { id: 'b', t: 4, box: { ...PX, x: 700 }, rotation: 30 });
  assert.equal(area.keys.length, 2);
  assert.equal(area.keys[1].box.x, 700);
  area = T.putCoverKey(area, { id: 'c', t: 4, box: PX, rotation: 0 });
  assert.deepEqual(area.keys.map((k) => k.id), ['a', 'c']);
  assert.equal(T.coverKeyNear(area, 4.01, 0.02).id, 'c');
  assert.equal(T.coverKeyNear(area, 4.1, 0.02), null);
  // Dragged along the clip: held to it, and never onto another's moment.
  assert.equal(T.moveCoverKey(area, 'c', 99, 10).keys[1].t, 10);
  assert.equal(T.moveCoverKey(area, 'c', -5, 10).keys.find((k) => k.id === 'c').t, 0.001, 'a millisecond short of the first');
  const swapped = T.moveCoverKey(T.putCoverKey(area, { id: 'd', t: 8, box: PX }), 'a', 6, 10);
  assert.deepEqual(swapped.keys.map((k) => k.id), ['c', 'a', 'd'], 'and kept in time order');
  assert.equal(T.moveCoverKey(area, 'nobody', 3, 10), area);
});

test('deleting a keyframe goes by a clip\'s rules: the last pair leaves the area still, as the first had it', () => {
  const A = { x: 1, y: 1, w: 10, h: 10 };
  const B = { x: 50, y: 1, w: 10, h: 10 };
  const C = { x: 90, y: 1, w: 10, h: 10 };
  const three = { kind: 'heart', box: { x: 7, y: 7, w: 7, h: 7 }, rotation: 5, keys: [
    { id: 'a', t: 0, box: A, rotation: 0 }, { id: 'b', t: 2, box: B, rotation: 10 }, { id: 'c', t: 4, box: C, rotation: 20 },
  ] };
  // One in the middle simply goes.
  assert.deepEqual(T.removeCoverKey(three, 'b').keys.map((k) => k.id), ['a', 'c']);
  // The first with two behind it stays, taking the second's settings.
  const first = T.removeCoverKey(three, 'a');
  assert.deepEqual(first.keys.map((k) => [k.id, k.t, k.box.x, k.rotation]), [['a', 0, 50, 10], ['b', 2, 50, 10], ['c', 4, 90, 20]]);
  // Down to one, it goes too, and the area is the first's from then on.
  const two = T.removeCoverKey(three, 'c');
  for (const id of ['a', 'b']) {
    const still = T.removeCoverKey(two, id);
    assert.equal('keys' in still, false);
    assert.deepEqual([still.kind, still.box, still.rotation], ['heart', A, 0], 'whichever of the two was deleted');
  }
  assert.equal(T.removeCoverKey(three, 'nobody'), three);
});

test('a trim of the start and a split shift an area\'s keyframes as they shift the clip\'s own', () => {
  const l = vid({
    obscure: { areas: [MOVER, STILL] },
    pixelate: { areas: [STILL] },
    keyframes: [{ id: 'k', t: 2, rotation: 0 }, { id: 'm', t: 6, rotation: 10 }],
  });
  // The start trimmed in by 1.5 s: they stay where they are on the timeline.
  const [trimmed] = T.trimLayer([l], l.id, 'start', 1.5);
  assert.deepEqual(trimmed.keyframes.map((k) => k.t), [0.5, 4.5]);
  assert.deepEqual(trimmed.obscure.areas[0].keys.map((k) => k.t), [0.5, 4.5]);
  assert.deepEqual(trimmed.obscure.areas[1], l.obscure.areas[1], 'an area without keyframes is untouched');
  assert.equal(trimmed.pixelate, l.pixelate, 'and so is an effect with none');
  // Trimmed past one, it is kept out of view and still steers.
  const [past] = T.trimLayer([l], l.id, 'start', 3);
  assert.deepEqual(past.obscure.areas[0].keys.map((k) => k.t), [-1, 3]);
  assert.ok(near(T.coverAt(past.obscure, 0).areas[0].box.x, T.coverAt(l.obscure, 3).areas[0].box.x), 'the same picture at the same frame');
  // The end trimmed moves nothing.
  const [shorter] = T.trimLayer([l], l.id, 'end', 5);
  assert.equal(shorter.obscure, l.obscure);
  // Split at 4: the left half as it was, the right on its own clock.
  const halves = T.splitLayer([l], l.id, 4).filter((x) => x.src === 'a.mp4').sort((a, b) => a.start - b.start);
  assert.deepEqual(halves[0].obscure.areas[0].keys.map((k) => k.t), [2, 6]);
  assert.deepEqual(halves[1].obscure.areas[0].keys.map((k) => k.t), [-2, 2]);
  assert.deepEqual(halves[1].obscure.areas[0].keys.map((k) => k.id), ['a', 'b']);
  assert.ok(near(T.coverAt(halves[1].obscure, 1).areas[0].box.x, T.coverAt(l.obscure, 5).areas[0].box.x),
    'a move that ran across the cut runs on across it');
  // Moving the clip takes them along untouched.
  const [moved] = T.moveLayer([l], l.id, 7);
  assert.equal(moved.obscure, l.obscure);
});

test('an area\'s keyframes survive the project file, and a 4.7 file opens without any', () => {
  const l = vid({ obscure: { strength: 40, areas: [MOVER, STILL] } });
  const out = P.parse(P.stringify(P.serialise({ layers: [l], project: HD, trim: { start: 0, end: 10 } })));
  assert.equal(out.ok, true);
  const back = T.createLayer(out.doc.layers[0]);
  assert.deepEqual(back.obscure, l.obscure);
  assert.deepEqual(back.obscure.areas[0].keys.map((k) => k.id), ['a', 'b'], 'ids and all');
  const old = JSON.parse(JSON.stringify(vid({ obscure: { areas: [STILL] } })));
  assert.equal(JSON.stringify(old.obscure).includes('keys'), false, 'nothing new is written for an area that holds still');
});

// ---- the part the export filters ----

test('the part filtered for a moving effect is every part it touches on the way', () => {
  const a = { x: 100, y: 200, width: 300, height: 200 };
  const b = { x: 600, y: 100, width: 200, height: 500 };
  assert.deepEqual(D.coverRegionUnion(a, b), { x: 100, y: 100, width: 700, height: 500 });
  assert.deepEqual(D.coverRegionUnion(b, a), { x: 100, y: 100, width: 700, height: 500 });
  assert.equal(D.coverRegionUnion(null, a), a);
  assert.equal(D.coverRegionUnion(a, null), a);
  assert.equal(D.coverRegionUnion(null, null), null);
  // Over a real move, at every frame: it holds each moment's part, on the grid.
  const l = vid({ pixelate: { areas: [MOVER] } });
  const block = T.pixelateBlock(l.pixelate.strength, 1080);
  let all = null;
  const each = [];
  for (let i = 60; i <= 180; i += 1) {
    const r = D.coverRegion(T.coverAt(l.pixelate, i / 30), 1920, 1080, { grid: block });
    each.push(r);
    all = D.coverRegionUnion(all, r);
  }
  for (const r of each) {
    assert.ok(r.x >= all.x && r.y >= all.y && r.x + r.width <= all.x + all.width && r.y + r.height <= all.y + all.height);
  }
  assert.equal(all.x % block, 0);
  assert.equal(all.y % block, 0);
  assert.ok(all.width > each[0].width && all.width > each[each.length - 1].width);
});

// ---- the export ----

const SRC = { 'a.mp4': { width: 1920, height: 1080 } };
const SEQ = {
  kind: 'obscure',
  region: { x: 100, y: 200, width: 700, height: 500 },
  sigma: 16.2,
  block: 32,
  frames: { pattern: 'C:/c/gen/seq-1/%05d.png', lead: 2, tail: 3.966667 },
};

test('a moving effect goes to the encoder as numbered frames, held at either end', () => {
  const l = { ...vid({}), coverFiles: [SEQ] };
  const args = buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC });
  const at = args.indexOf('C:/c/gen/seq-1/%05d.png');
  assert.deepEqual(args.slice(at - 5, at + 1), ['-framerate', '30', '-start_number', '0', '-i', 'C:/c/gen/seq-1/%05d.png']);
  assert.equal(args.includes('-loop'), false, 'not looped as the one PNG is');
  const parts = graphOf(args).split(';');
  assert.ok(parts.includes('[1:v]tpad=start_mode=clone:start_duration=2.0:stop_mode=clone:stop_duration=3.966667,'
    + 'fps=30,format=gray,scale=700:500[cv0x0m]'), 'the first frame held before the move and the last after it');
  assert.ok(parts.includes('[cv0x0b]crop=700:500:100:200,format=yuv444p,gblur=sigma=16.2:steps=6[cv0x0c]'));
  assert.ok(parts.includes('[cv0x0c][cv0x0m]alphamerge[cv0x0h]'));
  assert.ok(parts.includes('[cv0x0a][cv0x0h]overlay=x=100:y=200:format=yuv420[cv0x0o]'));
});

test('a move that fills the clip needs no holding, and a still effect beside it is still one PNG', () => {
  const whole = { ...SEQ, frames: { pattern: 'C:/c/gen/seq-2/%05d.png', lead: 0, tail: 0 } };
  const png = { kind: 'pixelate', src: 'C:/c/gen/p.png', region: { x: 784, y: 420, width: 252, height: 196 }, sigma: 13.5, block: 28 };
  const args = buildComposeArgs({ layers: [{ ...vid({}), coverFiles: [whole, png] }], project: HD, output: 'o.mp4', sources: SRC });
  const inputs = args.filter((a, i) => args[i - 1] === '-i');
  assert.deepEqual(inputs, ['a.mp4', 'C:/c/gen/seq-2/%05d.png', 'C:/c/gen/p.png']);
  const parts = graphOf(args).split(';');
  assert.ok(parts.includes('[1:v]fps=30,format=gray,scale=700:500[cv0x0m]'));
  assert.ok(parts.includes('[2:v]format=gray,scale=252:196,loop=loop=-1:size=1:start=0,trim=duration=10.0,fps=30[cv0x1m]'));
  assert.equal(graphOf(args).includes('tpad'), false);
});

test('a see-through PNG\'s moving effect is blended whole from the frames as well', () => {
  const img = {
    ...T.createLayer({ id: 'i', kind: 'image', type: 'video', src: 'logo.png', duration: 5, sourceWidth: 640, sourceHeight: 360 }),
    coverFiles: [{ ...SEQ, region: { x: 200, y: 80, width: 300, height: 200 }, frames: { ...SEQ.frames, tail: 0 } }],
  };
  const g = graphOf(buildComposeArgs({ layers: [img], project: HD, output: 'o.mp4', sources: { 'logo.png': { width: 640, height: 360 } } }));
  assert.ok(g.split(';').includes('[1:v]tpad=start_mode=clone:start_duration=2.0,fps=30,format=gray,scale=300:200,'
    + 'pad=640:360:200:80:black,mergeplanes=0x00000000:yuva444p[cv0x0m]'));
});

test('a see-through PNG is filtered premultiplied, as the preview\'s canvas has it', () => {
  const img = T.createLayer({ id: 'i', kind: 'image', type: 'video', src: 'logo.png', duration: 5, sourceWidth: 640, sourceHeight: 360 });
  const still = { kind: 'pixelate', src: 'C:/c/gen/p.png', region: { x: 200, y: 80, width: 300, height: 200 }, sigma: 5.4, block: 10 };
  const g = graphOf(buildComposeArgs({
    layers: [{ ...img, coverFiles: [{ ...SEQ, region: still.region }, still] }],
    project: HD, output: 'o.mp4', sources: { 'logo.png': { width: 640, height: 360 } },
  }));
  const parts = g.split(';');
  assert.ok(parts.includes('[cv0x0b]premultiply=inplace=1,gblur=sigma=16.2:steps=6,unpremultiply=inplace=1[cv0x0c]'));
  assert.ok(parts.includes('[cv0x1b]premultiply=inplace=1,pixelize=w=10:h=10,unpremultiply=inplace=1[cv0x1c]'));
  // A video has no alpha of its own and is filtered as it always was.
  const v = graphOf(buildComposeArgs({ layers: [{ ...vid({}), coverFiles: [SEQ] }], project: HD, output: 'o.mp4', sources: SRC }));
  assert.equal(v.includes('premultiply'), false);
});

test('Pixelate takes its blocks from the picture Obscure is already on, where the two meet', () => {
  const comp = read('renderer', 'app', 'compositor.js');
  assert.ok(comp.includes('const under = coverUnderlay(covers, el, src, w, h);'));
  assert.ok(comp.includes("if (c.kind === 'pixelate' && under) layCover(p, c, under.el, under.src, w, h);"));
  // Made before the picture is drawn, since it uses the covers' other surfaces.
  assert.ok(comp.indexOf('const under = coverUnderlay(') < comp.indexOf('const p = maskedSurface(0, w, h);'));
});

test('frames with no pattern are left out rather than handed to ffmpeg', () => {
  const bad = { ...SEQ, frames: { lead: 1, tail: 1 } };
  const g = graphOf(buildComposeArgs({ layers: [{ ...vid({}), coverFiles: [bad] }], project: HD, output: 'o.mp4', sources: SRC }));
  assert.equal(/gblur|\[cv|tpad/.test(g), false);
});

// ---- the preview, the export's drawing and the window ----

test('the preview and the export both draw an effect as it is at the moment', () => {
  const comp = read('renderer', 'app', 'compositor.js');
  assert.ok(comp.includes('timelineModel.coverAt(c.cover, at - layer.start)'), 'the preview, at the moment it draws');
  const exp = read('renderer', 'app', 'export.js');
  assert.ok(exp.includes('timelineModel.coverMotion(l, whole)'));
  assert.ok(exp.includes('timelineModel.coverAt(whole, i / fps)'), 'each frame the moment at its start');
  assert.ok(exp.includes('genDraw.coverRegionUnion(region, genDraw.coverRegion(at(i), W, H, room))'));
  assert.ok(exp.includes("'coverframes'"), 'cached apart from the single PNGs');
});

test('the window has the editors\' keyframe strip, for the selected area\'s own keyframes', () => {
  const modal = HTML.slice(HTML.indexOf('<div id="coverModal"'), HTML.indexOf('<div id="textGradModal"'));
  for (const id of ['coverKeys', 'coverKeysReadout', 'coverKeysCanvas', 'coverKeysHint']) {
    assert.ok(modal.includes('id="' + id + '"'), id);
  }
  assert.ok(modal.indexOf('id="coverKeys"') > modal.indexOf('id="coverStage"'), 'under the picture');
  assert.ok(modal.indexOf('id="coverKeys"') < modal.indexOf('id="coverRemoveBtn"'), 'and over the buttons');
  assert.ok(modal.includes('Keyframes: click one to edit it'), 'the strip\'s own hint is in its Info');
  assert.ok(HTML.indexOf('app/keystrip.js') < HTML.indexOf('app/cover.js'), 'the strip is loaded before the window that makes one');
  const js = read('renderer', 'app', 'cover.js');
  assert.ok(js.includes('makeKeyStrip(coverKeys, coverKeysReadout, coverKeysCanvas, {'));
  for (const call of ['timelineModel.putCoverKey(', 'timelineModel.removeCoverKey(', 'timelineModel.moveCoverKey(',
    'timelineModel.coverKeyNear(', 'timelineModel.coverAreaAt(']) {
    assert.ok(js.includes(call), call + ' comes from the model');
  }
  // The picture is drawn at the playhead's moment, and a press while playing stops first.
  assert.ok(js.includes('live.start + coverLocalT()'));
  assert.ok(/pauseComposite\(\);\s*followCoverPlayhead\(\);/.test(js));
});

test('the new line is in both languages', () => {
  const en = JSON.parse(read('locales', 'en.json'));
  const de = JSON.parse(read('locales', 'de.json'));
  const key = 'Each area has its own keyframes. Once the selected area has one, changing it sets the keyframe at the playhead or adds one there';
  assert.ok(HTML.includes(key));
  assert.equal(en[key], key);
  assert.ok(de[key] && de[key] !== key);
});
