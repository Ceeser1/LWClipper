'use strict';

// V4.7. Obscure and Pixelate: the model, where an effect acts, the part of
// the picture the export filters, the export's graph, and the window's markup.

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
const AREA = { kind: 'square', box: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } };

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

function graphOf(args) {
  return args[args.indexOf('-filter_complex') + 1];
}

// ---- the model ----

test('a layer written before them has neither, and only a picture of a file can have one', () => {
  assert.equal(vid({}).obscure, null);
  assert.equal(vid({}).pixelate, null);
  const cover = { areas: [AREA] };
  assert.equal(T.createLayer({ kind: 'gen', gen: { form: 'shape' }, obscure: cover }).obscure, null);
  assert.equal(T.createLayer({ type: 'audio', src: 'a.mp3', pixelate: cover }).pixelate, null);
  assert.ok(T.createLayer({ kind: 'image', src: 'a.png', obscure: cover }).obscure);
  assert.ok(vid({ pixelate: cover }).pixelate);
});

test('an effect is its areas, held to their ranges, and with no area it is none', () => {
  assert.equal(T.coverOf(null, 'obscure'), null);
  assert.equal(T.coverOf({ strength: 50 }, 'obscure'), null);
  assert.equal(T.coverOf({ areas: [] }, 'obscure'), null);
  assert.equal(T.coverOf({ areas: ['nonsense', 7] }, 'obscure'), null);
  const c = T.coverOf({ strength: 400, soft: -1, invert: 'yes', areas: [
    { kind: 'plaid', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, rotation: 270 },
    { kind: 'circle' },
  ] }, 'obscure');
  assert.deepEqual(c, {
    strength: 100,
    soft: 0,
    invert: false,
    areas: [
      { kind: 'square', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, rotation: -90 },
      { kind: 'circle', box: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0 },
    ],
  });
  assert.equal(T.coverOf({ areas: [AREA] }, 'obscure').strength, T.COVER_STRENGTH.obscure);
  assert.equal(T.coverOf({ areas: [AREA] }, 'pixelate').strength, T.COVER_STRENGTH.pixelate);
  const many = Array.from({ length: 60 }, () => AREA);
  assert.equal(T.coverOf({ areas: many }, 'obscure').areas.length, T.COVER_AREAS_MAX);
});

test('Obscure is laid on before Pixelate, whichever a layer has', () => {
  const both = vid({ pixelate: { areas: [AREA] }, obscure: { areas: [AREA] } });
  assert.deepEqual(T.coverList(both).map((c) => c.kind), ['obscure', 'pixelate']);
  assert.deepEqual(T.coverList(vid({ pixelate: { areas: [AREA] } })).map((c) => c.kind), ['pixelate']);
  assert.deepEqual(T.coverList(vid({})), []);
  assert.deepEqual(T.coverList(null), []);
});

test('the strength is a share of the picture\'s height, and a block is always even', () => {
  assert.ok(Math.abs(T.obscureSigma(30, 1080) - 16.2) < 1e-9);
  assert.ok(Math.abs(T.obscureSigma(30, 2160) - 32.4) < 1e-9, 'twice the picture, twice the blur');
  assert.equal(T.obscureSigma(1, 100), 0.5, 'never less than half a pixel');
  assert.equal(T.pixelateBlock(25, 1080), 28);
  assert.equal(T.pixelateBlock(1, 1080), 2, 'at least two pixels');
  for (let s = 1; s <= 100; s += 1) {
    for (const h of [360, 720, 1080, 1440, 2160]) assert.equal(T.pixelateBlock(s, h) % 2, 0, s + ' at ' + h);
  }
});

test('both survive the project file, a split and a copy, and an old file opens without them', () => {
  const l = vid({
    obscure: { strength: 40, soft: 0.02, areas: [AREA, { kind: 'circle', box: { x: 0.6, y: 0.1, w: 0.2, h: 0.3 }, rotation: 20 }] },
    pixelate: { invert: true, areas: [AREA] },
  });
  const state = { layers: [l], project: HD, trim: { start: 0, end: 10 } };
  const out = P.parse(P.stringify(P.serialise(state)));
  assert.equal(out.ok, true);
  const back = T.createLayer(out.doc.layers[0]);
  assert.deepEqual(back.obscure, l.obscure);
  assert.deepEqual(back.pixelate, l.pixelate);
  const halves = T.splitLayer([l], l.id, 4).filter((x) => x.src === 'a.mp4');
  assert.equal(halves.length, 2);
  for (const h of halves) assert.deepEqual(h.obscure, l.obscure);
  const old = JSON.parse(JSON.stringify(l));
  delete old.obscure;
  delete old.pixelate;
  const opened = T.createLayer(old);
  assert.equal(opened.obscure, null);
  assert.equal(opened.pixelate, null);
});

// ---- where an effect acts ----

// A context that writes down what is filled, and in which way.
function maskCtx() {
  const calls = [];
  return {
    calls,
    fillStyle: '',
    globalCompositeOperation: 'source-over',
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); this.globalCompositeOperation = 'source-over'; },
    clearRect(...a) { calls.push(['clearRect', ...a]); },
    fillRect(...a) { calls.push(['fillRect', this.globalCompositeOperation, this.fillStyle, ...a]); },
    beginPath() { calls.push(['beginPath']); },
    closePath() {},
    moveTo() {},
    lineTo(x, y) { calls.push(['lineTo', x, y]); },
    ellipse(...a) { calls.push(['ellipse', ...a]); },
    arcTo() {},
    bezierCurveTo() {},
    fill(rule) { calls.push(['fill', this.fillStyle, rule]); },
  };
}

test('where it acts is every area as a white shape, in the picture\'s pixels', () => {
  const ctx = maskCtx();
  const cover = T.coverOf({ areas: [AREA, { kind: 'circle', box: { x: 0.5, y: 0.5, w: 0.2, h: 0.4 } }] }, 'obscure');
  D.drawCoverMask(ctx, cover, 1000, 500, null);
  assert.deepEqual(ctx.calls[0], ['clearRect', 0, 0, 1000, 500]);
  const fills = ctx.calls.filter((c) => c[0] === 'fill');
  assert.equal(fills.length, 2, 'one for each area');
  assert.ok(fills.every((c) => c[1] === '#ffffffff'));
  // The square's corners, and the circle's middle and half sizes.
  const lines = ctx.calls.filter((c) => c[0] === 'lineTo').map((c) => [c[1], c[2]]);
  assert.deepEqual(lines, [[750, 125], [750, 375], [250, 375]]);
  const round = ctx.calls.find((c) => c[0] === 'ellipse');
  assert.deepEqual(round.slice(1, 5), [600, 350, 100, 100]);
  assert.equal(ctx.calls.some((c) => c[0] === 'fillRect'), false, 'not turned round');
});

test('inverted, it is turned round over the whole picture', () => {
  const ctx = maskCtx();
  D.drawCoverMask(ctx, T.coverOf({ invert: true, areas: [AREA] }, 'pixelate'), 1000, 500, null);
  const last = ctx.calls.filter((c) => c[0] === 'fillRect');
  assert.deepEqual(last, [['fillRect', 'source-out', '#ffffff', 0, 0, 1000, 500]]);
});

test('the export filters only the part of the picture the areas are in', () => {
  const one = T.coverOf({ areas: [{ kind: 'square', box: { x: 0.25, y: 0.25, w: 0.25, h: 0.5 } }] }, 'obscure');
  // 480 to 960 across and 270 to 810 down, two pixels of room, on even pixels.
  assert.deepEqual(D.coverRegion(one, 1920, 1080), { x: 478, y: 268, width: 484, height: 544 });
  // A blur asks for the pixels beside it as well.
  assert.deepEqual(D.coverRegion(one, 1920, 1080, { margin: 50 }), { x: 428, y: 218, width: 584, height: 644 });
  // Pixelate's blocks are counted from the picture's corner.
  const r = D.coverRegion(one, 1920, 1080, { grid: 28 });
  assert.equal(r.x % 28, 0);
  assert.equal(r.y % 28, 0);
  assert.equal((r.x + r.width) % 28, 0);
  assert.ok(r.x <= 478 && r.x + r.width >= 962);
  // A soft edge reaches further, and so does a turned area.
  const soft = D.coverRegion({ ...one, soft: 0.05 }, 1920, 1080);
  assert.ok(soft.x < 478 - 50 && soft.width > 484 + 100);
  const turned = D.coverRegion({ ...one, areas: [{ ...one.areas[0], rotation: 45 }] }, 1920, 1080);
  assert.ok(turned.width > 484 && turned.height > 544 - 200);
});

test('the part is held to the picture, to its last even pixel, and is all of it when inverted', () => {
  const edge = T.coverOf({ areas: [{ kind: 'square', box: { x: 0.9, y: 0.9, w: 0.3, h: 0.3 } }] }, 'obscure');
  assert.deepEqual(D.coverRegion(edge, 1920, 1080), { x: 1726, y: 970, width: 194, height: 110 });
  assert.deepEqual(D.coverRegion(edge, 1919, 1079), { x: 1724, y: 968, width: 194, height: 110 }, 'an odd picture');
  const gridded = D.coverRegion(edge, 1920, 1080, { grid: 28 });
  assert.equal(gridded.x + gridded.width, 1920, 'the last blocks are cut short by the edge, as the encoder cuts them');
  assert.deepEqual(D.coverRegion({ ...edge, invert: true }, 1920, 1080), { x: 0, y: 0, width: 1920, height: 1080 });
  const off = T.coverOf({ areas: [{ kind: 'square', box: { x: 2, y: 2, w: 0.1, h: 0.1 } }] }, 'obscure');
  assert.equal(D.coverRegion(off, 1920, 1080), null, 'an area off the picture touches none of it');
});

// ---- the export ----

const FILES = [
  { kind: 'obscure', src: 'C:/c/gen/o.png', region: { x: 100, y: 200, width: 300, height: 200 }, sigma: 16.2, block: 32 },
  { kind: 'pixelate', src: 'C:/c/gen/p.png', region: { x: 784, y: 420, width: 252, height: 196 }, sigma: 13.5, block: 28 },
];
const SRC = { 'a.mp4': { width: 1920, height: 1080 } };

test('a layer with neither is written exactly as it was', () => {
  const g = graphOf(buildComposeArgs({ layers: [vid({})], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(g.includes('[0:v]fps=30'));
  assert.equal(/gblur|pixelize|alphamerge|\[cv/.test(g), false);
});

test('each effect is cut out of the source, filtered, and laid back where it came from', () => {
  const l = { ...vid({}), coverFiles: FILES };
  const args = buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC });
  // The two pictures of where they act are inputs of their own, after the layer's.
  const inputs = args.filter((a, i) => args[i - 1] === '-i');
  assert.deepEqual(inputs, ['a.mp4', 'C:/c/gen/o.png', 'C:/c/gen/p.png']);
  const g = graphOf(args);
  const parts = g.split(';');
  assert.ok(parts.includes('[0:v]fps=30,format=yuv420p[cv0s]'), 'at the project\'s rate, before anything else');
  // Obscure: blurred at 4:4:4 with six steps, the measured way to a Gaussian.
  assert.ok(parts.includes('[cv0x0b]crop=300:200:100:200,format=yuv444p,gblur=sigma=16.2:steps=6[cv0x0c]'));
  assert.ok(parts.includes('[1:v]fps=30,format=gray,scale=300:200[cv0x0m]'));
  assert.ok(parts.includes('[cv0x0c][cv0x0m]alphamerge[cv0x0h]'));
  assert.ok(parts.includes('[cv0x0a][cv0x0h]overlay=x=100:y=200:format=yuv420[cv0x0o]'));
  // Pixelate, on what Obscure left.
  assert.ok(parts.includes('[cv0x0o]split[cv0x1a][cv0x1b]'));
  assert.ok(parts.includes('[cv0x1b]crop=252:196:784:420,pixelize=w=28:h=28[cv0x1c]'));
  assert.ok(parts.includes('[cv0x1a][cv0x1h]overlay=x=784:y=420:format=yuv420[cv0x1o]'));
  // And the layer's own chain starts from that, not from the input.
  assert.ok(parts.some((p) => p.startsWith('[cv0x1o]fps=30')));
  assert.equal(parts.some((p) => p.startsWith('[0:v]') && !p.endsWith('[cv0s]')), false);
});

test('a picture that moves between keyframes takes its covers along', () => {
  const R = { x: 320, y: 180, width: 640, height: 360 };
  const l = { ...vid({ keyframes: [{ t: 0, render: R }, { t: 2, render: { ...R, x: 0 } }] }), coverFiles: [FILES[0]] };
  const g = graphOf(buildComposeArgs({ layers: [l], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(g.includes('[cv0x0o]fps=30'), 'the moving road starts from the covered picture');
  assert.ok(g.includes('eval=frame'));
  const turned = { ...vid({ keyframes: [{ t: 0, render: R, rotation: 0 }, { t: 2, render: R, rotation: 40 }] }), coverFiles: [FILES[0]] };
  const g2 = graphOf(buildComposeArgs({ layers: [turned], project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(g2.includes('[cv0x0o]fps=30'), 'and so does the turned one');
});

test('a PNG with see-through parts is blended whole, its own alpha kept', () => {
  const img = {
    ...T.createLayer({ id: 'i', kind: 'image', type: 'video', src: 'logo.png', duration: 5, sourceWidth: 640, sourceHeight: 360 }),
    coverFiles: [{ ...FILES[0], region: { x: 200, y: 80, width: 300, height: 200 } }],
  };
  const g = graphOf(buildComposeArgs({ layers: [img], project: HD, output: 'o.mp4', sources: { 'logo.png': { width: 640, height: 360 } } }));
  const parts = g.split(';');
  assert.ok(parts.includes('[0:v]fps=30,format=yuva420p[cv0s]'));
  assert.ok(parts.includes('[cv0s]format=yuva444p,split[cv0x0a][cv0x0b]'));
  assert.ok(parts.includes('[cv0x0b]gblur=sigma=16.2:steps=6[cv0x0c]'), 'the whole picture');
  assert.ok(parts.includes('[1:v]fps=30,format=gray,scale=300:200,pad=640:360:200:80:black,mergeplanes=0x00000000:yuva444p[cv0x0m]'));
  assert.ok(parts.includes('[cv0x0a][cv0x0c][cv0x0m]maskedmerge,format=yuva420p[cv0x0o]'));
  assert.equal(g.includes('alphamerge'), false, 'not laid over itself, which would add the two alphas up');
});

test('a part that is not whole pixels inside the source is left out rather than handed to ffmpeg', () => {
  const bad = [
    { ...FILES[0], region: { x: 100, y: 200, width: 3000, height: 200 } },
    { ...FILES[0], region: { x: 10.5, y: 0, width: 100, height: 100 } },
    { ...FILES[0], region: null },
    { ...FILES[0], src: '' },
  ];
  for (const f of bad) {
    const g = graphOf(buildComposeArgs({ layers: [{ ...vid({}), coverFiles: [f] }], project: HD, output: 'o.mp4', sources: SRC }));
    assert.equal(/gblur|\[cv/.test(g), false, JSON.stringify(f.region));
  }
  // A block that came odd or broken is made even and at least two.
  const odd = graphOf(buildComposeArgs({ layers: [{ ...vid({}), coverFiles: [{ ...FILES[1], block: 'x' }] }],
    project: HD, output: 'o.mp4', sources: SRC }));
  assert.ok(odd.includes('pixelize=w=2:h=2'));
});

// ---- the window ----

test('a video or image track\'s right click offers Obscure and Pixelate', () => {
  const js = read('renderer', 'app', 'gen', 'kinds.js');
  const at = js.indexOf("item(t('Obscure')");
  assert.ok(at > js.indexOf("item(t('Add Mask')"), 'under the mask entries');
  assert.ok(js.indexOf("item(t('Pixelate')") > at);
  assert.ok(at < js.indexOf("item(t('Add Keyframe')"), 'and over the keyframes');
  assert.ok(js.includes("openCover(layer.id, 'obscure', at)") && js.includes("openCover(layer.id, 'pixelate', at)"));
});

test('one window for both: the shapes, the areas, Strength, Soft Edge, Invert, and Remove, Cancel, Accept', () => {
  const modal = HTML.slice(HTML.indexOf('<div id="coverModal"'), HTML.indexOf('<div id="textGradModal"'));
  for (const id of ['coverTitle', 'coverHint', 'coverShapes', 'coverAddBtn', 'coverDropBtn', 'coverStrengthSlider',
    'coverStrengthBox', 'coverSoftSlider', 'coverSoftBox', 'coverInvert', 'coverStage', 'coverCanvas', 'coverOthers',
    'coverBoxEl', 'coverRotor', 'coverAngle', 'coverRemoveBtn', 'coverCancelBtn', 'coverAcceptBtn']) {
    assert.ok(modal.includes('id="' + id + '"'), id);
  }
  assert.equal((modal.match(/<button data-kind="/g) || []).length, 8, 'the eight shapes, no Custom');
  assert.equal(modal.includes('data-kind="custom"'), false);
  assert.ok(HTML.indexOf('app/cover.js') > HTML.indexOf('app/gen/kinds.js'), 'loaded after what it uses');
  const js = read('renderer', 'app', 'cover.js');
  assert.ok(js.includes("popOut(coverModal, 'cover'"), 'an editor window of its own');
  assert.ok(js.includes('setLayers(timelineModel.setLayer(layers, id, { [kind]: cover }))'), 'Accept writes only its own effect');
});

test('the preview and the export cut the effect with the one drawing', () => {
  const comp = read('renderer', 'app', 'compositor.js');
  const exp = read('renderer', 'app', 'export.js');
  assert.ok(comp.includes('genDraw.drawCoverMask(m, cover, src.W, src.H)'));
  assert.ok(exp.includes('genDraw.drawCoverMask(ink, cover, W, H)'));
  // And the two figures come from the model both times.
  for (const text of [comp, exp]) {
    assert.ok(text.includes('timelineModel.obscureSigma(') && text.includes('timelineModel.pixelateBlock('));
  }
  // Blended in, not laid over: taken out of the picture where it acts first.
  assert.ok(/p\.globalCompositeOperation = 'destination-out';\s*p\.drawImage\(m\.canvas, 0, 0\);\s*p\.globalCompositeOperation = 'lighter';/.test(comp));
});

test('the new words are in both languages', () => {
  const en = JSON.parse(read('locales', 'en.json'));
  const de = JSON.parse(read('locales', 'de.json'));
  for (const key of ['Obscure', 'Pixelate', 'Add Area', 'Remove Area', 'Strength:', 'Invert Areas']) {
    assert.equal(en[key], key);
    assert.ok(de[key] && de[key] !== key, key + ' has a German word');
  }
});
