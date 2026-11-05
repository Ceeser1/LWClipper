'use strict';

// V3.3. Keyframes: the model, the blend between them, and the export's graph.

const test = require('node:test');
const assert = require('node:assert/strict');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const G = require('../src/geometry');
const { buildComposeArgs } = require('../src/composer');

const SRC = { width: 1920, height: 1080 };
const HD = { width: 1920, height: 1080, fps: 30 };
const CROP = { x: 480, y: 270, width: 960, height: 540 };
const INSET = { x: 100, y: 100, width: 640, height: 360 };

function vid(props) {
  return T.createLayer({ id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, ...props });
}

// ---- the model ----

test('a layer written before keyframes opens with none, and places as it always did', () => {
  const l = vid({ crop: CROP });
  assert.deepEqual(l.keyframes, []);
  // V3.4. With the turn beside it, none on a layer written before turns.
  assert.deepEqual(G.placementAt(l, 3, SRC, HD), { ...G.placeLayer({ source: SRC, crop: CROP, project: HD }), rotation: 0 });
});

// ---- V3.4. Turned pictures ----

test('a turn is kept on the layer and each keyframe, and blends the short way round', () => {
  const l = vid({
    rotation: 190,
    keyframes: [
      { id: 'a', t: 0, crop: null, render: INSET, rotation: 170 },
      { id: 'b', t: 2, crop: null, render: INSET, rotation: -170 },
    ],
  });
  assert.equal(l.rotation, -170, 'held to -180..180');
  assert.deepEqual(l.keyframes.map((k) => k.rotation), [170, -170]);
  assert.equal(G.placementAt(l, 1, SRC, HD).rotation, 180);
  assert.equal(G.placementAt(l, 0.5, SRC, HD).rotation, 175);
  // The export's view of the same move: turns carried on, never jumping.
  const m = G.motionOf(l, SRC, HD);
  assert.deepEqual(m.map((k) => k.turn), [170, 190]);
  // Keyframes that differ only in their turn still move.
  assert.ok(m);
});

test('a turned picture takes the room of the box round it', () => {
  const r = G.turnedSize(400, 200, 90);
  assert.ok(Math.abs(r.width - 200) < 1e-9 && Math.abs(r.height - 400) < 1e-9);
  const d = G.turnedSize(100, 100, 45);
  assert.ok(Math.abs(d.width - 100 * Math.SQRT2) < 1e-9);
  assert.equal(G.turnOf(540), 180);
  assert.equal(G.turnOf(-190), 170);
  assert.equal(G.turnBetween(170, -170), 20);
  assert.equal(G.turnBetween(-170, 170), -20);
});

test('keyframes come back in time order, one to a moment, held to their shape', () => {
  const l = vid({
    keyframes: [
      { t: 4, crop: CROP, render: null, anchor: 'tl' },
      { t: 1, crop: { x: 'no' }, render: INSET },
      { t: 'never' },
      { id: 'late', t: 4, crop: null, render: INSET },
    ],
  });
  assert.deepEqual(l.keyframes.map((k) => k.t), [1, 4]);
  assert.equal(l.keyframes[0].crop, null, 'a broken rect is no rect');
  assert.deepEqual(l.keyframes[0].render, INSET);
  assert.equal(l.keyframes[1].id, 'late', 'the later of two at one moment wins');
  assert.equal(l.keyframes[1].anchor, null);
});

test('an audio layer carries no keyframes', () => {
  assert.deepEqual(T.createLayer({ type: 'audio', src: 'm.mp3', sourceDuration: 9, keyframes: [{ t: 1 }] }).keyframes, []);
});

// ---- generated media ----

const D = require('../src/genDraw');

function gen(form, props = {}, keyframes = []) {
  return T.createLayer({ id: 'g', kind: 'gen', duration: 10, gen: { form, refHeight: 1080, ...props }, keyframes });
}

test('a generated keyframe holds what its form places, and nothing of the crop popup', () => {
  const text = gen('text', {}, [{ t: 1, box: { x: 1, y: 2, w: 30, h: 40 }, rotation: 370, crop: CROP, span: 0.5 }]);
  assert.deepEqual(Object.keys(text.keyframes[0]).sort(), ['box', 'id', 'rotation', 't']);
  assert.equal(text.keyframes[0].rotation, 10);
  const bar = gen('bar', {}, [{ t: 1, thickness: 9, span: 4, color: '#ff000080', box: {} }]);
  assert.deepEqual(Object.keys(bar.keyframes[0]).sort(), ['color', 'id', 'span', 't', 'thickness']);
  assert.equal(bar.keyframes[0].span, 1, 'held to its range');
  const shape = gen('shape', { shape: { kind: 'star' } }, [{ t: 1, box: null }]);
  // V3.5. And its soft edge; V3.6.2, its turn and its rounded corners.
  assert.deepEqual(Object.keys(shape.keyframes[0]).sort(), ['box', 'id', 'radius', 'rotation', 'soft', 't']);
});

test('V3.5: a shape blends its soft edge and keeps the rest of its settings at every moment', () => {
  const l = gen('shape', { shape: { kind: 'ring', invert: true, ring: 0.2 } }, [
    { t: 0, box: { x: 0, y: 0, w: 100, h: 100 }, soft: 0 },
    { t: 2, box: { x: 0, y: 0, w: 100, h: 100 }, soft: 40 },
  ]);
  const mid = D.genAt(l, 1, 1920, 1080);
  assert.equal(mid.shape.soft, 20);
  assert.equal(mid.shape.invert, true);
  assert.equal(mid.shape.ring, 0.2);
  assert.deepEqual(D.genMotion(l), { from: 0, to: 2 }, 'a softening alone is a move');
  assert.equal(T.keyedAt({ soft: 30 }, 2 / 3).soft, 20, 'pixels, so it scales with refHeight');
  const [after] = T.removeKeyframe(T.removeKeyframe([l], 'g', l.keyframes[1].id), 'g', l.keyframes[0].id);
  assert.equal(after.gen.shape.soft, 0, 'the first keyframe is written back');
  assert.equal(after.gen.shape.invert, true);
});

test('the last keyframe of a generated layer deleted leaves its settings on the layer', () => {
  const l = gen('bar', { bar: { side: 'left', thickness: 20 } }, [{ id: 'a', t: 1, thickness: 80, span: 0.5, color: '#00ff00ff' }]);
  const [after] = T.removeKeyframe([l], 'g', 'a');
  assert.deepEqual(after.keyframes, []);
  assert.equal(after.gen.bar.thickness, 80);
  assert.equal(after.gen.bar.span, 0.5);
  assert.equal(after.gen.bar.color, '#00ff00ff');
  assert.equal(after.gen.bar.side, 'left', 'what keyframes do not hold stays');
});

test('a bar blends its thickness, span and colour, alpha included', () => {
  const l = gen('bar', {}, [
    { t: 0, thickness: 10, span: 0.2, color: '#ff000000' },
    { t: 4, thickness: 50, span: 1, color: '#0000ffff' },
  ]);
  const at = D.genAt(l, 1, 1920, 1080);
  assert.equal(at.bar.thickness, 20);
  assert.ok(Math.abs(at.bar.span - 0.4) < 1e-9);
  assert.equal(at.bar.color, '#bf004040');
  assert.equal(D.genAt(l, -3, 1920, 1080).bar.color, '#ff000000');
  assert.equal(D.genAt(l, 9, 1920, 1080).bar.thickness, 50);
});

test('a text box blends from the whole frame when one keyframe has none, and turns the short way', () => {
  const l = gen('text', {}, [
    { t: 0, box: null, rotation: 170 },
    { t: 2, box: { x: 960, y: 540, w: 100, h: 100 }, rotation: -170 },
  ]);
  const mid = D.genAt(l, 1, 1920, 1080);
  assert.deepEqual(mid.text.box, { x: 480, y: 270, w: 1010, h: 590 });
  assert.equal(mid.text.rotation, 180, 'twenty degrees across 180, not 340 the long way');
  assert.equal(D.genAt(l, 0, 1920, 1080).text.box, null);
});

test('two keyframes with no box stay without one', () => {
  const l = gen('shape', {}, [{ t: 0, box: null }, { t: 2, box: null }]);
  assert.equal(D.genAt(l, 1, 1920, 1080).shape.box, null);
  assert.equal(D.genMotion(l), null);
});

test('a shape on its default box blends from the box that default is', () => {
  const l = gen('shape', { shape: { kind: 'square' } }, [{ t: 0, box: null }, { t: 2, box: { x: 0, y: 0, w: 100, h: 100 } }]);
  const mid = D.genAt(l, 1, 1920, 1080);
  // The default square is 360 high and centred: 780, 360.
  assert.deepEqual(mid.shape.box, { x: 390, y: 180, w: 230, h: 230 });
});

test('the move of a generated layer is the stretch between its keyframes, inside the clip', () => {
  const l = gen('bar', {}, [{ t: -2, thickness: 1 }, { t: 3, thickness: 50 }, { t: 14, thickness: 50 }]);
  assert.deepEqual(D.genMotion(l), { from: 0, to: 10 });
  const still = gen('bar', {}, [{ t: 1, thickness: 5 }, { t: 3, thickness: 5 }]);
  assert.equal(D.genMotion(still), null);
});

test('keyframes measured at another refHeight scale their pixels and nothing else', () => {
  const l = gen('bar', {}, [{ id: 'a', t: 0, thickness: 60, span: 0.5, color: '#ff000080' }]);
  const [k] = T.keyframesAtRef(l, 720);
  assert.equal(k.thickness, 40);
  assert.equal(k.span, 0.5);
  assert.equal(k.color, '#ff000080');
  const box = T.keyedAt({ box: { x: 30, y: 60, w: 90, h: 120 }, rotation: 45 }, 2 / 3);
  assert.deepEqual(box, { box: { x: 20, y: 40, w: 60, h: 80 }, rotation: 45 });
  assert.equal(T.keyframesAtRef(l, 1080)[0], l.keyframes[0], 'at its own height nothing is rebuilt');
});

test('Crop Render Frame pins every keyframe box with the layer', () => {
  const l = gen('shape', {}, [{ id: 'a', t: 0, box: { x: 100, y: 100, w: 200, h: 200 } }]);
  const moved = T.reframeKeyed(l, 1080, 1080, 1, -50, -20);
  assert.deepEqual(moved.keyframes[0].box, { x: 50, y: 80, w: 200, h: 200 });
});

test('a moving generated layer is exported as its frames, held before and after its move', () => {
  const l = { ...gen('bar', {}, [{ t: 2, thickness: 1 }, { t: 6, thickness: 50 }]), start: 1, src: 'C:/c/seq/%05d.png',
    sourceWidth: 1920, sourceHeight: 1080, frames: { pattern: 'C:/c/seq/%05d.png', lead: 2, tail: 3.966667 } };
  const args = buildComposeArgs({ layers: [l], project: HD, output: 'out.mp4', sources: {} });
  const i = args.indexOf('C:/c/seq/%05d.png');
  assert.deepEqual(args.slice(i - 5, i + 1), ['-framerate', '30', '-start_number', '0', '-i', 'C:/c/seq/%05d.png']);
  const g = args[args.indexOf('-filter_complex') + 1];
  assert.ok(g.includes('[0:v]tpad=start_mode=clone:start_duration=2.0:stop_mode=clone:stop_duration=3.966667,fps=30,'), g);
});

test('putting a keyframe adds it, changes it by its id, and replaces one at the same moment', () => {
  let layers = [vid()];
  layers = T.putKeyframe(layers, 'v', { id: 'a', t: 2, render: INSET });
  layers = T.putKeyframe(layers, 'v', { id: 'b', t: 5, crop: CROP });
  assert.deepEqual(T.keyframesFor(layers[0]).map((k) => k.id), ['a', 'b']);
  layers = T.putKeyframe(layers, 'v', { id: 'a', t: 2, render: null, crop: CROP });
  assert.deepEqual(layers[0].keyframes[0].crop, CROP);
  layers = T.putKeyframe(layers, 'v', { id: 'c', t: 5 });
  assert.deepEqual(layers[0].keyframes.map((k) => k.id), ['a', 'c']);
});

test('deleting the second-to-last keyframe takes the last with it, its placement going to the whole clip', () => {
  let layers = [vid({ keyframes: [{ id: 'a', t: 0, crop: CROP, render: INSET, anchor: 'br' }, { id: 'b', t: 3 }, { id: 'c', t: 5 }] })];
  layers = T.removeKeyframe(layers, 'v', 'c');
  assert.equal(layers[0].keyframes.length, 2, 'two still move the picture');
  assert.equal(layers[0].crop, null, 'the layer is untouched while they do');
  layers = T.removeKeyframe(layers, 'v', 'b');
  assert.deepEqual(layers[0].keyframes, [], 'the one left alone goes too');
  assert.deepEqual(layers[0].crop, CROP);
  assert.deepEqual(layers[0].render, INSET);
  assert.equal(layers[0].anchor, 'br');
});

test('whichever of the two is deleted, the clip keeps the first, never the modified second', () => {
  const two = [vid({ keyframes: [{ id: 'a', t: 0, render: INSET }, { id: 'b', t: 3, crop: CROP }] })];
  for (const gone of ['a', 'b']) {
    const [l] = T.removeKeyframe(two, 'v', gone);
    assert.deepEqual(l.keyframes, []);
    assert.deepEqual(l.render, INSET, 'deleting ' + gone);
    assert.equal(l.crop, null, 'deleting ' + gone);
  }
});

test('deleting #1 of three gives the start #2 settings and leaves #2 where it is', () => {
  const three = [vid({ keyframes: [
    { id: 'a', t: 0, render: INSET },
    { id: 'b', t: 2, crop: CROP, anchor: 'tl' },
    { id: 'c', t: 5 },
  ] })];
  const [l] = T.removeKeyframe(three, 'v', 'a');
  assert.deepEqual(l.keyframes.map((k) => [k.id, k.t]), [['a', 0], ['b', 2], ['c', 5]]);
  assert.deepEqual(l.keyframes[0].crop, CROP);
  assert.equal(l.keyframes[0].render, null);
  assert.equal(l.keyframes[0].anchor, 'tl');
  assert.deepEqual(G.placementAt(l, 1, SRC, HD), G.placementAt(l, 2, SRC, HD), 'it holds still until #2');
  assert.equal(l.crop, null, 'the clip itself is untouched while keyframes remain');
});

test('a generated layer deleting #1 of three takes #2 values the same way', () => {
  const l = T.createLayer({ id: 'g', kind: 'gen', duration: 10, gen: { form: 'bar' }, keyframes: [
    { id: 'a', t: 0, thickness: 10 }, { id: 'b', t: 2, thickness: 90, span: 0.5 }, { id: 'c', t: 5, thickness: 20 },
  ] });
  const [after] = T.removeKeyframe([l], 'g', 'a');
  assert.equal(after.keyframes.length, 3);
  assert.equal(after.keyframes[0].thickness, 90);
  assert.equal(after.keyframes[0].span, 0.5);
  assert.equal(after.keyframes[0].t, 0);
});

test('a lone keyframe deleted leaves its placement on the layer', () => {
  const [l] = T.removeKeyframe([vid({ keyframes: [{ id: 'a', t: 1, crop: CROP }] })], 'v', 'a');
  assert.deepEqual(l.keyframes, []);
  assert.deepEqual(l.crop, CROP);
});

test('a dragged keyframe stays on the clip and never lands on another', () => {
  let layers = [vid({ keyframes: [{ id: 'a', t: 1 }, { id: 'b', t: 3 }] })];
  layers = T.moveKeyframe(layers, 'v', 'a', 25);
  assert.deepEqual(layers[0].keyframes.map((k) => [k.id, k.t]), [['b', 3], ['a', 10]]);
  layers = T.moveKeyframe(layers, 'v', 'a', 3);
  assert.deepEqual(layers[0].keyframes.map((k) => k.id), ['b', 'a'], 'it stops short of b');
  assert.equal(layers[0].keyframes.length, 2);
  assert.ok(Math.abs(layers[0].keyframes[1].t - 3.001) < 1e-9);
  layers = T.moveKeyframe(layers, 'v', 'a', -4);
  assert.equal(layers[0].keyframes[0].t, 0);
});

test('a trimmed start leaves the keyframes where they are on the timeline, out of view included', () => {
  let layers = [vid({ start: 10, sourceIn: 5, keyframes: [{ id: 'a', t: 1 }, { id: 'b', t: 6 }] })];
  layers = T.trimLayer(layers, 'v', 'start', 13);
  const l = layers[0];
  assert.equal(l.start, 13);
  assert.deepEqual(l.keyframes.map((k) => l.start + k.t), [11, 16], 'same seconds of the timeline');
  assert.equal(l.keyframes[0].t, -2, 'trimmed off, and kept');
  layers = T.trimLayer(layers, 'v', 'start', 10);
  assert.deepEqual(layers[0].keyframes.map((k) => k.t), [1, 6], 'pulled back out, it shows again');
});

test('a trimmed-off keyframe still steers the part of the clip that shows', () => {
  const l = vid({ keyframes: [{ t: 0, render: { x: 0, y: 0, width: 640, height: 360 } }, { t: 10, render: { x: 1000, y: 0, width: 640, height: 360 } }] });
  const [trimmed] = T.trimLayer([l], 'v', 'end', 5);
  assert.equal(trimmed.duration, 5);
  assert.equal(G.placementAt(trimmed, 5, SRC, HD).dest.x, 500, 'still halfway to a keyframe nobody can see');
});

test('a split gives both halves every keyframe, so the move runs on across the cut', () => {
  const l = vid({ start: 2, keyframes: [{ t: 0, render: { x: 0, y: 0, width: 640, height: 360 } }, { t: 10, render: { x: 1000, y: 0, width: 640, height: 360 } }] });
  const [left, right] = T.splitLayer([l], 'v', 6);
  assert.deepEqual(left.keyframes.map((k) => k.t), [0, 10]);
  assert.deepEqual(right.keyframes.map((k) => k.t), [-4, 6]);
  const before = G.placementAt(left, 4, SRC, HD).dest.x;
  const after = G.placementAt(right, 0, SRC, HD).dest.x;
  assert.equal(before, after);
});

test('a moved clip takes its keyframes along', () => {
  const [l] = T.moveLayer([vid({ start: 0, keyframes: [{ t: 2 }] })], 'v', 30);
  assert.equal(l.keyframes[0].t, 2);
});

// ---- the blend ----

test('between two keyframes every edge moves at an even pace, and holds outside them', () => {
  const l = vid({
    keyframes: [
      { t: 2, crop: null, render: { x: 0, y: 0, width: 640, height: 360 } },
      { t: 6, crop: CROP, render: { x: 400, y: 200, width: 1280, height: 720 } },
    ],
  });
  const mid = G.placementAt(l, 4, SRC, HD);
  assert.deepEqual(mid.dest, { x: 200, y: 100, width: 960, height: 540 });
  assert.deepEqual(mid.src, { x: 240, y: 135, width: 1440, height: 810 });
  assert.deepEqual(G.placementAt(l, 0, SRC, HD).dest, { x: 0, y: 0, width: 640, height: 360 });
  assert.deepEqual(G.placementAt(l, 9, SRC, HD).dest, { x: 400, y: 200, width: 1280, height: 720 });
});

test('a keyframe on centre and fit blends from the rect that fit is', () => {
  const l = vid({ keyframes: [{ t: 0 }, { t: 2, render: { x: 0, y: 0, width: 960, height: 540 } }] });
  assert.deepEqual(G.placementAt(l, 1, SRC, HD).dest, { x: 0, y: 0, width: 1440, height: 810 });
});

test('the picture only counts as moving when two keyframes disagree', () => {
  assert.equal(G.motionOf(vid(), SRC, HD), null);
  assert.equal(G.motionOf(vid({ keyframes: [{ t: 1, render: INSET }] }), SRC, HD), null);
  assert.equal(G.motionOf(vid({ keyframes: [{ t: 1, render: INSET }, { t: 3, render: INSET }] }), SRC, HD), null);
  assert.equal(G.motionOf(vid({ keyframes: [{ t: 1, render: INSET }, { t: 3 }] }), SRC, HD).length, 2);
});

// ---- the export ----

function graphOf(layers) {
  const args = buildComposeArgs({ layers, project: HD, output: 'out.mp4', sources: { 'a.mp4': SRC } });
  return args[args.indexOf('-filter_complex') + 1].split(';');
}

test('one keyframe is placed once, by the fixed filters, at the keyframe placement', () => {
  const g = graphOf([vid({ keyframes: [{ t: 1, crop: CROP, render: INSET }] })]);
  assert.ok(g.some((s) => s.includes('crop=960:540:480:270') && s.includes('scale=640:360')));
  assert.ok(g.some((s) => s.includes('overlay=100:100')));
  assert.ok(!g.some((s) => s.includes('eval=frame')));
});

test('a moving layer is scaled and laid per frame, and masked to where it is', () => {
  const g = graphOf([vid({ start: 2, keyframes: [{ t: 0, render: { x: 0, y: 0, width: 640, height: 360 } }, { t: 4, crop: CROP, render: { x: 600, y: 300, width: 640, height: 360 } }] })]);
  const all = g.join(';');
  assert.ok(g.some((s) => s.startsWith('[0:v]fps=30,setpts=') && s.includes(':eval=frame')),
    'the whole source is the union of the crops, so no fixed crop');
  assert.ok(all.includes('alphamerge'));
  assert.ok(all.includes('clip((t-2.0)/4.0\\,0\\,1)'), 'blended over the keyframes, on the timeline clock');
  assert.ok(g.some((s) => s.startsWith('color=c=white:s=16x16') && s.includes(':d=10.0,setpts=PTS-STARTPTS+2.0/TB')));
  // The canvases cover what the picture ever covers: 0,0 to 1240,660.
  assert.ok(g.some((s) => s.startsWith('color=c=black@0:s=1240x660')));
  assert.ok(g.some((s) => /\[base\]\[v0\]overlay=0:0:eof_action=pass:enable=/.test(s)));
});

test('a moving layer cut from one part of the source is cut once, to every crop at once', () => {
  const g = graphOf([vid({ keyframes: [{ t: 0, crop: CROP }, { t: 4, crop: { x: 0, y: 0, width: 960, height: 540 } }] })]);
  assert.ok(g.some((s) => s.startsWith('[0:v]fps=30,crop=1440:810:0:0,')));
});

test('a moving layer keeps its fades and its ceiling', () => {
  const g = graphOf([vid({ alpha: 0.5, fadeIn: 1, keyframes: [{ t: 0 }, { t: 4, render: INSET }] })]);
  const merged = g.find((s) => s.includes('alphamerge'));
  assert.ok(merged.includes('fade=t=in:st=0.0:d=1.0:alpha=1'));
  assert.ok(merged.includes('colorchannelmixer=aa=0.5'));
});
