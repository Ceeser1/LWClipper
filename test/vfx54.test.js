'use strict';

// V5.4. Keying: Chroma Key and Luma Key, which leave the picture see-through
// where a colour or a brightness was, and a colour taken from the picture.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const O = require('../src/vfxOps');
const P = require('../src/project');
const { buildComposeArgs } = require('../src/composer');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HD = { width: 1920, height: 1080, fps: 30 };
const SRC = { 'a.mp4': { width: 1920, height: 1080 } };
const WHOLE = { x: 0, y: 0, width: 1920, height: 1080 };
const now = (kind, more = {}, t = 0) => T.vfxAt(T.vfxOf({ kind, ...more }), t);
const opsOf = (kind, more) => O.opsOf(kind, now(kind, more), 1920, 1080);
const keyOf = (kind, more) => opsOf(kind, more)[0];
const graphsOf = (args) => args.filter((a, i) => args[i - 1] === '-filter_complex');

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

// ---- the kinds ----

test('the two keys are for the whole picture, have no Mix, are never off and give the picture an alpha', () => {
  for (const kind of ['chromakey', 'lumakey']) {
    const def = T.vfxKind(kind);
    assert.equal(def.where, 'whole', kind);
    assert.equal(def.area, false, kind);
    assert.equal(def.alpha, true, kind);
    assert.equal(def.keyed.some((s) => s.id === 'mix'), false, kind);
    assert.equal(now(kind).off, false, kind);
    assert.equal(T.vfxEverOn(T.vfxOf({ kind })), true, kind);
    assert.equal(T.vfxGivesAlpha({ ...vid({}), vfx: T.vfxListOf([{ kind }]) }), true, kind);
    // Switched off by its checkbox it gives none.
    assert.equal(T.vfxGivesAlpha({ ...vid({}), vfx: T.vfxListOf([{ kind, disabled: true }]) }), false, kind);
  }
  const chroma = T.vfxKind('chromakey');
  assert.deepEqual(chroma.statics.map((s) => [s.id, s.type]), [['color', 'color']]);
  assert.equal(chroma.statics[0].pick, true, 'its colour may be taken from the picture');
  assert.equal(chroma.statics[0].def, '#00b140');
  assert.deepEqual(chroma.keyed.map((s) => [s.id, s.min, s.max, s.def]), [['tolerance', 0, 100, 30], ['softness', 0, 100, 15], ['spill', 0, 100, 60]]);
  const luma = T.vfxKind('lumakey');
  assert.deepEqual(luma.statics.map((s) => [s.id, s.type, s.options]), [['mode', 'choice', ['dark', 'bright']]]);
  assert.deepEqual(luma.keyed.map((s) => [s.id, s.min, s.max, s.def]), [['threshold', 0, 100, 20], ['softness', 0, 100, 10]]);
});

test('the keys have a heading of their own, after the four there were', () => {
  const groups = T.VFX_GROUPS;
  assert.deepEqual(groups[4], { id: 'key', kinds: ['chromakey', 'lumakey'] });
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes("  key: () => t('Keying'),"));
});

test('a key comes back out of a saved project as it went in, keyframes and all', () => {
  const list = T.vfxListOf([
    { kind: 'chromakey', color: '#12AB34', tolerance: 44, softness: 7, spill: 0, keys: [{ t: 0, tolerance: 10, softness: 0, spill: 0 }, { t: 2, tolerance: 60, softness: 30, spill: 100 }] },
    { kind: 'lumakey', mode: 'bright', threshold: 70, softness: 5 },
  ]);
  const out = P.parse(P.stringify(P.serialise({ layers: [{ ...vid({}), vfx: list }], project: HD, trim: null })));
  const back = T.createLayer(out.doc.layers[0]).vfx;
  assert.equal(back[0].color, '#12ab34');
  assert.deepEqual(back[0].keys.map((k) => [k.t, k.tolerance, k.softness, k.spill]), [[0, 10, 0, 0], [2, 60, 30, 100]]);
  assert.equal(T.vfxAt(back[0], 1).tolerance, 35);
  assert.deepEqual([back[1].mode, back[1].threshold, back[1].softness], ['bright', 70, 5]);
});

// ---- what a key measures a colour by ----

test('no gain of a key times a value lands on a half, so both sides round it the same way', () => {
  const rows = [...keyOf('chromakey').rows, ...keyOf('lumakey').rows];
  for (const row of rows) {
    for (const gain of row.slice(0, 3)) {
      for (let v = 0; v <= 255; v += 1) {
        const x = Math.abs(v * gain);
        assert.ok(Math.abs(x - Math.floor(x) - 0.5) > 1e-6, gain + ' times ' + v);
      }
    }
  }
  // The alpha's share, on a picture made solid, is a whole number well off a half too.
  assert.equal(O.lrint(255 * 0.502), 128);
  // lrint as C has it: a half goes to the even number.
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6, -2.6].map(O.lrint).map((x) => x + 0), [0, 2, 2, 0, -2, 2, 3, -3]);
});

test('a chroma key measures where a colour lies apart from how bright it is', () => {
  const rows = keyOf('chromakey').rows;
  // Every grey lies in the middle, whatever its brightness.
  for (const g of [0, 60, 128, 200, 255]) {
    const [p, q] = O.keyPlace(rows, [g, g, g]);
    assert.ok(Math.abs(p - 128) <= 1 && Math.abs(q - 128) <= 1, 'grey ' + g + ' at ' + p + ',' + q);
  }
  // A darker and a brighter green lie in one direction from the middle.
  const dark = O.keyPlace(rows, [0, 120, 40]);
  const bright = O.keyPlace(rows, [0, 200, 70]);
  const angle = (a) => Math.atan2(a[1] - 128, a[0] - 128);
  assert.ok(Math.abs(angle(dark) - angle(bright)) < 0.08);
  // The key's own colour is where the key looks.
  assert.deepEqual(keyOf('chromakey', { color: '#00b140' }).at, O.keyPlace(rows, [0, 177, 64]));
  assert.deepEqual(keyOf('chromakey', { color: '#00b140' }).at, [45, 92]);
});

test('Tolerance is how far from its colour a chroma key reaches and Softness how far beyond it fades', () => {
  const o = keyOf('chromakey', { color: '#00b140', tolerance: 30, softness: 15 });
  assert.equal(o.op, 'key');
  assert.equal(o.sim, 0.12);
  assert.ok(Math.abs(o.blend - 0.06) < 1e-12);
  // The key's colour and the screen a little darker and brighter: gone.
  assert.equal(O.keyAlpha(o, [0, 177, 64]), 0);
  assert.equal(O.keyAlpha(o, [0, 150, 50]), 0);
  assert.equal(O.keyAlpha(o, [10, 200, 80]), 0);
  // Skin, white, black, red and blue: all there.
  for (const rgb of [[224, 172, 150], [255, 255, 255], [0, 0, 0], [200, 30, 30], [30, 40, 200]]) assert.equal(O.keyAlpha(o, rgb), 255, rgb.join(','));
  // Between the two a part.
  const edge = O.keyAlpha(o, [120, 170, 120]);
  assert.ok(edge > 0 && edge < 255, 'a greenish grey is part there: ' + edge);
  // No Softness is a hard edge: all or nothing.
  const hard = keyOf('chromakey', { softness: 0 });
  assert.equal(hard.blend, 0);
  for (const rgb of [[70, 170, 90], [0, 177, 64], [120, 160, 120]]) assert.ok([0, 255].includes(O.keyAlpha(hard, rgb)));
  // No Tolerance keys only the colour itself, and the most reaches twice as far as a screen green is from grey.
  assert.equal(keyOf('chromakey', { tolerance: 0 }).sim, 0.00001);
  assert.equal(keyOf('chromakey', { tolerance: 100 }).sim, 0.4);
  assert.equal(O.keyAlpha(keyOf('chromakey', { tolerance: 0, softness: 0 }), [0, 150, 50]), 255);
});

test('what is taken out of the colours left is green for a green key, blue for a blue one, nothing for another', () => {
  assert.deepEqual(keyOf('chromakey', { color: '#00b140', spill: 60 }).spill, { blue: false, k: 0.6 });
  assert.deepEqual(keyOf('chromakey', { color: '#2040d0', spill: 100 }).spill, { blue: true, k: 1 });
  assert.equal(keyOf('chromakey', { color: '#d02020', spill: 100 }).spill, null);
  assert.equal(keyOf('chromakey', { color: '#00b140', spill: 0 }).spill, null);
  // Green above the mean of red and blue comes down to it at full strength, part of the way at less.
  assert.deepEqual(O.keySpill({ blue: false, k: 1 }, [100, 200, 50]), [100, 75, 50]);
  assert.deepEqual(O.keySpill({ blue: false, k: 0.5 }, [100, 200, 50]), [100, 137, 50]);
  // A colour with no more green than that is left as it is, to the value.
  for (const rgb of [[200, 100, 150], [255, 255, 255], [0, 0, 0], [37, 37, 37], [250, 120, 20]]) {
    assert.deepEqual(O.keySpill({ blue: false, k: 1 }, rgb), rgb);
  }
  assert.deepEqual(O.keySpill({ blue: true, k: 1 }, [60, 100, 220]), [60, 100, 80]);
  assert.deepEqual(O.keySpill(null, [1, 2, 3]), [1, 2, 3]);
});

test('a luma key makes the dark end or the bright end see-through, by the brightness alone', () => {
  const dark = keyOf('lumakey', { mode: 'dark', threshold: 20, softness: 10 });
  assert.deepEqual(dark.at, [0, 0]);
  assert.equal(dark.spill, null);
  // Up to a fifth of the brightness gone, from three tenths on all there.
  assert.equal(O.keyAlpha(dark, [0, 0, 0]), 0);
  assert.equal(O.keyAlpha(dark, [50, 50, 50]), 0);
  assert.equal(O.keyAlpha(dark, [80, 80, 80]), 255);
  assert.equal(O.keyAlpha(dark, [255, 255, 255]), 255);
  const mid = O.keyAlpha(dark, [64, 64, 64]);
  assert.ok(mid > 100 && mid < 160, 'half way between: ' + mid);
  // A pure blue is dark, a pure green bright: brightness as the eye has it.
  assert.equal(O.keyAlpha(dark, [0, 0, 255]), 0);
  assert.equal(O.keyAlpha(dark, [0, 255, 0]), 255);
  const bright = keyOf('lumakey', { mode: 'bright', threshold: 80, softness: 10 });
  assert.deepEqual(bright.at, [255, 0]);
  assert.equal(O.keyAlpha(bright, [255, 255, 255]), 0);
  assert.equal(O.keyAlpha(bright, [210, 210, 210]), 0);
  assert.equal(O.keyAlpha(bright, [170, 170, 170]), 255);
  assert.equal(O.keyAlpha(bright, [0, 0, 0]), 255);
});

// ---- the encoder ----

test('a key is written once as three of the picture: measured, its own alpha, and the one that takes both', () => {
  const o = keyOf('chromakey');
  const made = O.filtersOf([{ ops: [o] }], () => '', 't', true);
  assert.equal(made.forks, 2);
  assert.equal(made.ends, 'rgb');
  assert.equal(made.text, 'format=rgba,split=3[tf0a][tf0b][tf0d];'
    + '[tf0b]lutrgb=a=255,colorchannelmixer=rr=0.4999:rg=-0.4542:rb=-0.0458:ra=0.502:gr=-0.1146:gg=-0.3854:gb=0.4999:ga=0.502:br=0:bg=0:bb=0:ba=0,'
    + 'colorkey=color=0x2d5c00:similarity=0.12:blend=0.06,alphaextract[tf0k];'
    + '[tf0d]alphaextract[tf0e];[tf0e][tf0k]blend=all_mode=multiply[tf0g];'
    + '[tf0a]despill=type=green:mix=0.5:expand=0:red=0:green=-0.6:blue=0:brightness=0[tf0m];[tf0m][tf0g]alphamerge,format=gbrap');
  // With nothing to take out the picture goes to the merge as it is.
  const plain = O.filtersOf([{ ops: [keyOf('chromakey', { spill: 0 })] }], () => '', 't', true).text;
  assert.equal(plain.includes('despill'), false);
  assert.ok(plain.endsWith('[tf0a][tf0g]alphamerge,format=gbrap'));
  const blue = O.filtersOf([{ ops: [keyOf('chromakey', { color: '#2040d0', spill: 50 })] }], () => '', 't', true).text;
  assert.ok(blue.includes('despill=type=blue:mix=0.5:expand=0:red=0:green=0:blue=-0.5:brightness=0'));
  const luma = O.filtersOf([{ ops: [keyOf('lumakey', { mode: 'bright', threshold: 80, softness: 10 })] }], () => '', 't', true).text;
  assert.ok(luma.includes('colorchannelmixer=rr=0.2126:rg=0.7152:rb=0.0722:ra=0:gr=0:gg=0:gb=0:ga=0:br=0:bg=0:bb=0:ba=0,colorkey=color=0xff0000:similarity=0.11547:blend=0.057735,'));
});

test('a key whose figures change has a key for each figure, each on for its frames', () => {
  const steps = [
    { ops: [keyOf('chromakey', { tolerance: 10, spill: 0 })], ranges: [[0, 9]] },
    { ops: [keyOf('chromakey', { tolerance: 20, spill: 50 })], ranges: [[10, 19]] },
  ];
  const text = O.filtersOf(steps, (r) => ':enable=' + r[0].join('-'), 't', true).text;
  assert.ok(text.includes('colorkey=color=0x2d5c00:similarity=0.04:blend=0.06:enable=0-9,colorkey=color=0x2d5c00:similarity=0.08:blend=0.06:enable=10-19,alphaextract'));
  // The one figure with something to take out has its filter, on for its frames only.
  assert.equal((text.match(/despill=/g) || []).length, 1);
  assert.ok(text.includes(':brightness=0:enable=10-19[tf0m]'));
  assert.equal((text.match(/split=3/g) || []).length, 1);
});

test('a track with a key is carried with an alpha, the key put straight on the whole picture', () => {
  const ops = opsOf('chromakey');
  const file = { kind: 'chromakey', region: WHOLE, steps: [{ ops }], on: null, whole: false, full: true };
  const args = buildComposeArgs({ layers: [{ ...vid({}), vfxFiles: [file] }], project: HD, output: 'o.mp4', sources: SRC });
  const g = graphsOf(args).join(';');
  assert.ok(g.includes('format=yuva420p'), 'from its VFX on the picture has an alpha');
  assert.ok(g.includes('scale=flags=accurate_rnd,format=gbrap,format=rgba,split=3['));
  assert.ok(g.includes('alphamerge,format=gbrap['));
  assert.equal(g.includes('premultiply'), false, 'colours are keyed as they are');
  // A plain track beside it has none.
  const plain = graphsOf(buildComposeArgs({ layers: [vid({})], project: HD, output: 'o.mp4', sources: SRC })).join(';');
  assert.equal(plain.includes('yuva420p'), false);
  const src = read('src', 'composer.js');
  assert.ok(src.includes('chromakey: { ...RGB_OPS, gives: true },') && src.includes('lumakey: { ...RGB_OPS, gives: true },'));
});

// ---- the preview and the window ----

test('the preview keys by the same rule, in a pass of its own', () => {
  const gl = read('renderer', 'app', 'vfxGl.js');
  assert.ok(gl.includes('    key: `'));
  assert.ok(gl.includes('float diff = sqrt(dot(d, d) / 195075.0);'), '255 * 255 * 3');
  assert.ok(gl.includes('float key = floor(k * 255.0);'));
  assert.ok(gl.includes('outColor = back(v, floor(had * key / 255.0 + 0.001) / 255.0);'));
  assert.ok(gl.includes("} else if (o.op === 'key') {"));
  assert.ok(gl.includes('const row = (r) => [r[0], r[1], r[2], vfxOps.lrint(255 * r[3])];'));
});

test('the keys have a row in every table, names for everything, and a colour to take from the picture', () => {
  const rows = (file, table) => {
    const text = read(...file);
    const body = text.slice(text.indexOf('const ' + table + ' = {'));
    return [...body.slice(0, body.indexOf('\n};')).matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]);
  };
  for (const [file, table] of [[['renderer', 'app', 'compositor.js'], 'VFX_PREVIEW'], [['renderer', 'app', 'export.js'], 'VFX_EXPORT'],
    [['src', 'composer.js'], 'VFX_FILTERS'], [['renderer', 'app', 'vfx.js'], 'VFX_UI']]) {
    const all = rows(file, table);
    assert.deepEqual(all.slice(all.indexOf('curves') + 1, all.indexOf('curves') + 3), ['chromakey', 'lumakey'], table);
  }
  assert.deepEqual(T.VFX_KIND_IDS.slice(T.VFX_KIND_IDS.indexOf('curves') + 1, T.VFX_KIND_IDS.indexOf('curves') + 3), ['chromakey', 'lumakey']);
  const js = read('renderer', 'app', 'vfx.js');
  for (const id of ['tolerance', 'spill']) assert.ok(js.includes('  ' + id + ': () => t('), id);
  assert.ok(js.includes("dark: () => t('Remove Dark'),") && js.includes("bright: () => t('Remove Bright'),"));
  assert.ok(js.includes("pick = make('button', 'vfx-color__pick', t('Pick from Picture'));"));
  // The colour is read off the picture as it reaches the chosen VFX, and the wait ends with the window.
  assert.ok(js.includes('vfx: vfxListOfDraft(vfxDraft.slice(0, vfxSel))'));
  assert.ok(js.includes("vfxStage.closest('.modal__panel').addEventListener('keydown'"));
  assert.ok(/vfxPreviewId = null;\n  endVfxColourPick\(\);\n}/.test(js));
  for (const file of ['en.json', 'de.json']) {
    const words = JSON.parse(read('locales', file));
    for (const key of ['Keying', 'Chroma Key', 'Luma Key', 'Tolerance:', 'Spill Removal:', 'Pick from Picture', 'Remove Dark', 'Remove Bright',
      'Click a spot of the picture to take its colour']) assert.ok(words[key], file + ': ' + key);
  }
  assert.ok(read('renderer', 'style.css').includes('.vfx-stage--picking,'));
});
