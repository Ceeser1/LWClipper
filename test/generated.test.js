'use strict';

// V3. Generated media, text and the bar, through everything a layer goes
// through: made, cut, copied, undone, saved and opened again.

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/timeline');
const P = require('../src/project');
const H = require('../src/history');

function text(props) {
  return T.createLayer({ kind: 'gen', gen: { form: 'text', text: { runs: [{ text: 'Hi' }] } }, ...props });
}
function bar(props) {
  return T.createLayer({ kind: 'gen', gen: { form: 'bar' }, ...props });
}

test('a generated layer is a ten second picture with no file', () => {
  const l = text({ type: 'audio', src: 'x.mp4', sourceDuration: 3 });
  assert.equal(l.kind, 'gen');
  assert.equal(l.type, 'video');
  assert.equal(l.src, null);
  assert.equal(l.duration, T.IMAGE_SECONDS);
  assert.equal(l.sourceDuration, 0);
  assert.equal(T.isStill(l), true);
});

test('a generated layer is never cropped or placed: its picture is the frame', () => {
  const l = text({ crop: { x: 0, y: 0, w: 10, h: 10 }, render: { x: 5, y: 5, w: 10, h: 10 }, anchor: 'top-left' });
  assert.equal(l.crop, null);
  assert.equal(l.render, null);
  assert.equal(l.anchor, null);
});

test('every other kind carries no gen object', () => {
  assert.equal(T.createLayer({ src: 'v.mp4', sourceDuration: 5 }).gen, null);
  assert.equal(T.createLayer({ kind: 'image', src: 'a.png', gen: { form: 'bar' } }).gen, null);
});

test('a text with nothing set comes out whole, with one empty run', () => {
  const g = T.createLayer({ kind: 'gen' }).gen;
  assert.deepEqual(g, {
    form: 'text',
    refHeight: 1080,
    text: {
      runs: [{ text: '', style: {} }],
      style: {
        font: 'Arial', size: 96, color: '#ffffffff',
        bold: false, italic: false, underline: false, strike: false,
        outline: null, shadow: null,
      },
      align: { h: 'center', v: 'middle' },
      box: null,
      rotation: 0,
    },
  });
});

test('a bar with nothing set is a full width white bar at the top', () => {
  assert.deepEqual(bar().gen, {
    form: 'bar',
    refHeight: 1080,
    bar: { side: 'top', color: '#ffffffff', thickness: 40, span: 1 },
  });
});

test('settings are held to their limits and nonsense falls back to the default', () => {
  const g = T.genOf({
    form: 'text',
    refHeight: 720,
    text: {
      style: {
        font: '  ', size: 'huge', color: '#12AB34', bold: 'yes',
        outline: { color: 'red', width: 99999 },
        shadow: { angle: 400, distance: 0, size: 'x', fade: 2 },
      },
      align: { h: 'middle', v: 'bottom' },
      box: { x: 0, y: 0, w: 0, h: 5 },
      rotation: 270,
    },
  });
  const s = g.text.style;
  assert.equal(g.refHeight, 720);
  assert.equal(s.font, 'Arial');
  assert.equal(s.size, 96);
  assert.equal(s.color, '#12ab34ff');
  assert.equal(s.bold, false);
  assert.deepEqual(s.outline, { color: '#000000ff', width: 1024 });
  assert.deepEqual(s.shadow, { color: '#000000b3', angle: 180, distance: 0.01, size: 8, fade: 1 });
  assert.deepEqual(g.text.align, { h: 'center', v: 'bottom' });
  assert.equal(g.text.box, null);
  assert.equal(g.text.rotation, -90);
});

test('a form this version does not know opens as text, and each form keeps only its own settings', () => {
  const g = T.genOf({ form: 'star', bar: { side: 'left' } });
  assert.equal(g.form, 'text');
  assert.equal(g.bar, undefined);
  const b = T.genOf({ form: 'bar', text: { runs: [{ text: 'x' }] }, bar: { side: 'left', span: 0 } });
  assert.equal(b.text, undefined);
  assert.equal(b.bar.side, 'left');
  assert.equal(b.bar.span, 0.01);
});

test('a run keeps only what it changes, and an effect set to null stays null', () => {
  const g = T.genOf({ text: { runs: [
    { text: 'a\r\nb', style: { bold: true, outline: null, nonsense: 1 } },
    { text: 5 },
    'not a run',
  ] } });
  assert.deepEqual(g.text.runs, [
    { text: 'a\nb', style: { bold: true, outline: null } },
    { text: '', style: {} },
  ]);
});

test('colourOf takes six or eight digits and nothing else', () => {
  assert.equal(T.colourOf('#AABBCC', null), '#aabbccff');
  assert.equal(T.colourOf('aabbcc80', null), '#aabbcc80');
  assert.equal(T.colourOf('#abc', 'd'), 'd');
  assert.equal(T.colourOf(7, 'd'), 'd');
});

test('createLayer twice is createLayer once, and never shares the gen object', () => {
  const a = text({ gen: { form: 'text', text: { style: { shadow: { angle: 10 } } } } });
  const b = T.createLayer(a);
  assert.deepEqual(b, a);
  assert.notEqual(b.gen, a.gen);
  assert.notEqual(b.gen.text.style, a.gen.text.style);
});

test('its edges drag past its length in both directions, like an image', () => {
  let layers = [text({ id: 't', start: 5 })];
  layers = T.trimLayer(layers, 't', 'end', 60);
  layers = T.trimLayer(layers, 't', 'start', 0);
  assert.equal(layers[0].start, 0);
  assert.equal(layers[0].duration, 60);
});

test('a split gives both halves the same settings, and neither shares them', () => {
  const layers = T.splitLayer(T.arrangeLanes([text({ id: 't' })]), 't', 4);
  assert.equal(layers.length, 2);
  const l = T.layerById(layers, 't');
  const r = layers.find((x) => x.id !== 't');
  assert.deepEqual(l.gen, r.gen);
  assert.equal(r.sourceIn, 0);
  assert.equal(r.start, 4);
  // Whatever the halves share now, a setGen on one leaves the other as it was.
  const next = T.setGen(layers, r.id, { form: 'bar' });
  assert.equal(T.layerById(next, l.id).gen.form, 'text');
  assert.equal(T.layerById(next, r.id).gen.form, 'bar');
});

test('copy and paste carry the settings to a new layer', () => {
  const layers = T.arrangeLanes([bar({ id: 'b', gen: { form: 'bar', bar: { side: 'bottom' } } })]);
  const clip = T.copyOf(layers, 'b');
  const next = T.pasteInto(layers, clip, 20, null);
  assert.equal(next.length, 2);
  const pasted = next.find((l) => l.id !== 'b');
  assert.equal(pasted.start, 20);
  assert.equal(pasted.kind, 'gen');
  assert.equal(pasted.gen.bar.side, 'bottom');
});

test('setGen normalises, leaves the list it was given alone, and ignores other kinds', () => {
  const v = T.createLayer({ id: 'v', src: 'v.mp4', sourceDuration: 5 });
  const layers = [text({ id: 't' }), v];
  const next = T.setGen(layers, 't', { form: 'text', text: { style: { size: -5 } } });
  assert.equal(next[0].gen.text.style.size, 1);
  assert.equal(layers[0].gen.text.style.size, 96);
  assert.equal(T.setGen(layers, 'v', { form: 'bar' })[1], v);
});

// The Edit Text size box holds to this ceiling too, so the two must be one
// number rather than two that happen to agree.
test('a font size is held to GEN_FONT_MAX and keeps its fractions', () => {
  const big = T.genOf({ form: 'text', text: { style: { size: 99999 } } });
  assert.equal(big.text.style.size, T.GEN_FONT_MAX);
  const odd = T.genOf({ form: 'text', text: { style: { size: 95.99 } } });
  assert.equal(odd.text.style.size, 95.99);
});

test('a change to the settings is a change undo sees', () => {
  const layers = [text({ id: 't' })];
  let h = H.create({ layers });
  const changed = T.setGen(layers, 't', { form: 'text', text: { style: { bold: true } } });
  h = H.commit(h, { layers: changed });
  assert.equal(H.canUndo(h), true);
  h = H.undo(h);
  assert.equal(h.present.layers[0].gen.text.style.bold, false);
});

test('a .lwc carries generated layers there and back, with no file reference', () => {
  const layers = T.arrangeLanes([
    text({ id: 't', gen: { form: 'text', refHeight: 720, text: {
      runs: [{ text: 'Line one\nLine two', style: {} }],
      style: { font: 'Segoe UI', color: '#ff000080', outline: { width: 3 } },
      align: { h: 'left', v: 'top' },
    } } }),
    bar({ id: 'b', start: 3, gen: { form: 'bar', bar: { side: 'right', span: 0.5 } } }),
  ]);
  const state = { project: { width: 1280, height: 720, fps: 30 }, trim: { start: 0, end: 10 }, layers };
  const written = P.serialise(state, { app: 'test' });
  assert.equal(written.layers[0].ref, null);
  const parsed = P.parse(P.stringify(written));
  assert.equal(parsed.ok, true);
  const back = parsed.doc.layers.map((l) => T.createLayer(l));
  // What comes back through createLayer is exactly what went in: the ref block
  // serialise added beside each layer is not a field createLayer keeps.
  assert.deepEqual(back, layers);
});

// ---- 30c. Where a new one goes ----

function clip(id, lane, type = 'video') {
  return T.createLayer({ id, type, src: id + '.mp4', sourceDuration: 60, lane });
}

test('a new generated layer takes the topmost empty video row when nothing above it shows then', () => {
  // Video 1 and Video 3 full, Video 2 empty between them. The clip on Video 1
  // runs 0 to 60, so at 70 nothing covers Video 2.
  const layers = T.arrangeLanes([clip('a', 0), clip('b', 2), clip('s', 0, 'audio')]);
  assert.deepEqual(T.genLane(layers, 3, 70), { lane: 1, insert: false });
  const { layers: next, layer, inserted } = T.addGen(layers, { form: 'bar' }, 70, 3);
  assert.equal(inserted, false);
  assert.equal(layer.lane, 1);
  assert.equal(layer.start, 70);
  assert.equal(layer.duration, 10);
  assert.equal(T.layerById(next, 'b').lane, 2);
});

test('an empty row under a picture is passed over for a new Video 1', () => {
  // The user's case: the only empty row under full frame videos.
  const layers = T.arrangeLanes([clip('a', 0), clip('b', 1)]);
  assert.deepEqual(T.genLane(layers, 3, 7.5), { lane: 0, insert: true });
  const { layers: next, layer } = T.addGen(layers, { form: 'text' }, 7.5, 3);
  assert.equal(layer.lane, 0);
  assert.equal(T.layerById(next, 'a').lane, 1);
  assert.equal(T.layerById(next, 'b').lane, 2);
  // Covered for only its last second still counts.
  assert.deepEqual(T.genLane(T.arrangeLanes([clip('a', 0)]), 2, 50.5), { lane: 0, insert: true });
  // And a disabled row above still counts, since it can be ticked back on.
  const off = T.arrangeLanes([{ ...clip('a', 0), enabled: false }]);
  assert.deepEqual(T.genLane(off, 2, 0), { lane: 0, insert: true });
});

test('an empty row below the last full one counts, since the timeline shows it', () => {
  const layers = T.arrangeLanes([clip('a', 0)]);
  assert.deepEqual(T.genLane(layers, 2, 60), { lane: 1, insert: false });
});

test('with no empty row, a new one goes in on top and every video row moves down one', () => {
  const layers = T.arrangeLanes([clip('a', 0), clip('b', 1), clip('s', 0, 'audio')]);
  assert.deepEqual(T.genLane(layers, 2), { lane: 0, insert: true });
  const { layers: next, layer, inserted } = T.addGen(layers, { form: 'text' }, 0, 2);
  assert.equal(inserted, true);
  assert.equal(layer.lane, 0);
  assert.equal(T.layerById(next, 'a').lane, 1);
  assert.equal(T.layerById(next, 'b').lane, 2);
  // Audio rows are not video rows and stay where they were.
  assert.equal(T.layerById(next, 's').lane, 0);
  // First in the list, so it is drawn on top of everything.
  assert.equal(next[0].id, layer.id);
});

test('an empty timeline puts it on Video 1', () => {
  assert.deepEqual(T.genLane([], 1), { lane: 0, insert: false });
});

test('insertLane opens a gap and removeLane closes it again', () => {
  const layers = T.arrangeLanes([clip('a', 0), clip('b', 1)]);
  const opened = T.insertLane(layers, 'video', 1);
  assert.equal(T.layerById(opened, 'a').lane, 0);
  assert.equal(T.layerById(opened, 'b').lane, 2);
  const closed = T.removeLane(opened, 'video', 1);
  assert.deepEqual(closed.map((l) => [l.id, l.lane]), [['a', 0], ['b', 1]]);
});

// ---- V3, 31a. Through a Crop Render Frame change ----

test('reframeGen: a crop keeps sizes in pixels and moves a box with the picture', () => {
  const g = T.genOf({ form: 'text', refHeight: 1080, text: { style: { size: 96 }, box: { x: 300, y: 300, w: 600, h: 300 } } });
  // 720p project, the frame cut to 600 tall, the old frame's origin landing at
  // -40, -60 in the new one.
  const out = T.reframeGen(g, 720, 600, 1, -40, -60);
  assert.equal(out.refHeight, 900);
  const scale = 600 / out.refHeight;
  assert.equal(out.text.style.size * scale, 96 * 720 / 1080);
  // In project pixels: was 200, 200, 400 x 200; now 160, 140 and the same size.
  const b = out.text.box;
  assert.deepEqual([b.x * scale, b.y * scale, b.w * scale, b.h * scale].map((v) => Math.round(v * 1e6) / 1e6), [160, 140, 400, 200]);
});

test('reframeGen: a resolution change scales everything together and leaves refHeight', () => {
  const g = T.genOf({ form: 'text', refHeight: 1080, text: { box: { x: 300, y: 300, w: 600, h: 300 } } });
  const out = T.reframeGen(g, 720, 1080, 1.5, 0, 0);
  assert.equal(out.refHeight, 1080);
  assert.deepEqual(out.text.box, { x: 300, y: 300, w: 600, h: 300 });
});

test('reframeGen: a whole frame text and a bar follow the frame, sizes held', () => {
  const t = T.reframeGen(T.genOf({ form: 'text', refHeight: 1080, text: {} }), 720, 600, 1, -40, -60);
  assert.equal(t.text.box, null);
  assert.equal(t.refHeight, 900);
  const bar = T.reframeGen(T.genOf({ form: 'bar', refHeight: 720, bar: { thickness: 30 } }), 720, 1000, 1, 0, 0);
  assert.equal(bar.refHeight, 1000);
  assert.equal(bar.bar.thickness * 1000 / bar.refHeight, 30);
});
