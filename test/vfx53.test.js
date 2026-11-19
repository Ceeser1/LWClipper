'use strict';

// V5.3. Curves, a kind whose setting is a drawing, and LUT files of a second
// sort (.3dl), which the encoder is never handed as they are.

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
const FLAT = [[0, 0], [255, 255]];
const now = (kind, more = {}, t = 0) => T.vfxAt(T.vfxOf({ kind, ...more }), t);
const opsOf = (kind, more) => O.opsOf(kind, now(kind, more), 1920, 1080);
const graphsOf = (args) => args.filter((a, i) => args[i - 1] === '-filter_complex');

function vid(props) {
  return T.createLayer({
    id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 10, sourceWidth: 1920, sourceHeight: 1080, ...props,
  });
}

// ---- Curves: the setting ----

test('Curves is a correction with one setting of its own, a curve for all colours and one each for red, green and blue', () => {
  const def = T.vfxKind('curves');
  assert.equal(def.where, 'two');
  assert.deepEqual(def.statics.map((s) => [s.id, s.type]), [['curve', 'curve'], ['shape', 'shape'], ['invert', 'check']]);
  assert.deepEqual(def.keyed.map((s) => s.id), ['mix', 'soft']);
  assert.deepEqual(T.VFX_CURVE_CHANNELS, ['m', 'r', 'g', 'b']);
  const v = T.vfxOf({ kind: 'curves' });
  assert.deepEqual(v.curve.m, [[0, 0], [64, 50], [192, 206], [255, 255]]);
  for (const ch of ['r', 'g', 'b']) assert.deepEqual(v.curve[ch], FLAT);
  // A new one does something, and one with every point on the diagonal does nothing.
  assert.equal(now('curves').off, false);
  assert.equal(now('curves', { curve: { m: FLAT, r: FLAT, g: FLAT, b: FLAT } }).off, true);
  assert.equal(now('curves', { curve: { m: [[0, 0], [100, 100], [255, 255]] } }).off, true);
  assert.equal(now('curves', { curve: { b: [[0, 0], [255, 200]] } }).off, false);
  assert.equal(T.VFX_GROUPS.find((g) => g.id === 'color').kinds.includes('curves'), true);
});

test('a curve out of a file is held to whole numbers in order, each value once, two to sixteen points', () => {
  const c = T.vfxCurveOf({
    m: [[300, -5], [10.4, 20.6], [10.2, 99], ['x', 1], [0, 0], null],
    r: [[5, 5]],
    g: 'no',
  });
  // The later of two points on one value stays, a point outside is brought in.
  assert.deepEqual(c.m, [[0, 0], [10, 99], [255, 0]]);
  assert.deepEqual(c.r, FLAT);
  assert.deepEqual(c.g, FLAT);
  assert.deepEqual(c.b, FLAT);
  const many = [];
  for (let i = 0; i < 40; i += 1) many.push([i * 5, i]);
  assert.equal(T.vfxCurveOf({ m: many }).m.length, T.VFX_CURVE_POINTS);
  assert.equal(T.VFX_CURVE_POINTS, 16);
  // Nothing handed over is the kind's own start, and never the same lists.
  const a = T.vfxOf({ kind: 'curves' });
  const b = T.vfxOf({ kind: 'curves' });
  assert.notEqual(a.curve.m, b.curve.m);
  assert.notEqual(a.curve.r, a.curve.g);
});

test('a Curves VFX comes back out of a saved project as it went in', () => {
  const curve = { m: [[0, 10], [128, 140], [255, 250]], r: [[0, 0], [255, 230]], g: FLAT, b: [[0, 20], [90, 60], [255, 255]] };
  const layer = { ...vid({}), vfx: T.vfxListOf([{ kind: 'curves', curve, mix: 80 }]) };
  const out = P.parse(P.stringify(P.serialise({ layers: [layer], project: HD, trim: null })));
  const back = T.createLayer(out.doc.layers[0]).vfx[0];
  assert.equal(back.kind, 'curves');
  assert.deepEqual(back.curve, curve);
  assert.equal(back.mix, 80);
});

// ---- Curves: what it does ----

test('a smooth curve goes through its points, never past them, and is level outside them', () => {
  const pts = [[20, 40], [100, 60], [180, 200], [230, 210]];
  const f = O.smoothThrough(pts);
  for (const [x, y] of pts) assert.ok(Math.abs(f(x) - y) < 1e-9);
  assert.equal(f(0), 40);
  assert.equal(f(255), 210);
  // Rising points give a rising curve: no dip and no bump between them.
  let last = -1;
  for (let x = 0; x <= 255; x += 1) {
    const y = f(x);
    assert.ok(y >= last - 1e-9, 'rising at ' + x);
    assert.ok(y >= 40 - 1e-9 && y <= 210 + 1e-9);
    last = y;
  }
  // Where the points turn round the curve is level at the turn, not beyond it.
  const hill = O.smoothThrough([[0, 0], [128, 200], [255, 0]]);
  for (let x = 0; x <= 255; x += 1) assert.ok(hill(x) <= 200 + 1e-9 && hill(x) >= -1e-9);
  // Two points are a straight line, none is the diagonal.
  assert.ok(Math.abs(O.smoothThrough(FLAT)(77) - 77) < 1e-9);
  assert.equal(O.smoothThrough([])(91), 91);
});

test('the table of Curves is each colour through its own curve and then through the one for all', () => {
  const curve = { m: [[0, 0], [128, 160], [255, 255]], r: [[0, 30], [255, 255]], g: FLAT, b: FLAT };
  const [op] = opsOf('curves', { curve });
  assert.equal(op.op, 'colour');
  assert.equal(op.m, null);
  assert.equal(op.b, null);
  assert.equal(op.a.length, 3);
  const all = O.smoothThrough(curve.m);
  const red = O.smoothThrough(curve.r);
  const r = O.tableOf(op.a[0]);
  const g = O.tableOf(op.a[1]);
  assert.deepEqual(Array.from(O.tableOf(op.a[2])), Array.from(g));
  // Read at every fourth value and the last, and straight between: there
  // the table is the two curves one after the other, to the whole number.
  for (const x of [0, 4, 64, 128, 200, 252, 255]) {
    assert.equal(g[x], Math.round(all(x)), 'green at ' + x);
    assert.equal(r[x], Math.round(all(red(x))), 'red at ' + x);
  }
  // And between two of them never more than a level off the curve itself.
  for (let x = 0; x <= 255; x += 1) assert.ok(Math.abs(g[x] - all(x)) <= 1.01, 'green near the curve at ' + x);
  // Curves that change nothing are one stretch, which is the value itself.
  const [same] = O.opsOf('curves', { curve: { m: FLAT, r: FLAT, g: FLAT, b: FLAT } }, 1920, 1080);
  assert.equal(same.a[0], '0.5+(val-0)*1');
  assert.deepEqual(Array.from(O.tableOf(same.a[0])), Array.from({ length: 256 }, (x, i) => i));
});

test('points with straight lines between them are one expression, never deep, that the table follows', () => {
  const pts = O.curvePoints([[0, 255], [255, 0]], FLAT);
  assert.equal(pts.length, 65);
  assert.deepEqual(pts[0], [0, 255]);
  assert.deepEqual(pts[64], [255, 0]);
  // Points in a line are one stretch.
  assert.equal(O.linesThrough(pts), '255.5+(val-0)*-1');
  const bent = [[0, 0], [100, 50], [200, 250], [255, 255]];
  const text = O.linesThrough(bent);
  assert.equal(text, 'if(lt(val,100),0.5+(val-0)*0.5,if(lt(val,200),50.5+(val-100)*2,250.5+(val-200)*0.0909091))');
  const t = O.tableOf(text);
  assert.equal(t[0], 0);
  assert.equal(t[50], 25);
  assert.equal(t[100], 50);
  assert.equal(t[150], 150);
  assert.equal(t[200], 250);
  assert.equal(t[255], 255);
  // 64 stretches are halved six times, so no part is deeper than six ifs.
  const wild = [];
  for (let i = 0; i < 65; i += 1) wild.push([i === 64 ? 255 : i * 4, i % 2 ? 200 : 40]);
  const deep = O.linesThrough(wild);
  assert.equal((deep.match(/if\(/g) || []).length, 63);
  // Count the ifs that are open at once.
  let open = 0;
  let deepest = 0;
  const stack = [];
  for (let i = 0; i < deep.length; i += 1) {
    if (deep.startsWith('if(', i)) {
      stack.push('if');
      open += 1;
      deepest = Math.max(deepest, open);
      i += 2;
    } else if (deep[i] === '(') {
      stack.push('(');
    } else if (deep[i] === ')') {
      if (stack.pop() === 'if') open -= 1;
    }
  }
  assert.equal(deepest, 6);
  const table = O.tableOf(deep);
  for (const [x, y] of wild) assert.equal(table[x], y);
});

test('Curves reaches the encoder as three tables on red, green and blue', () => {
  const ops = opsOf('curves', { curve: { m: [[0, 0], [128, 160], [255, 255]] } });
  const args = buildComposeArgs({
    layers: [{ ...vid({}), vfxFiles: [{ kind: 'curves', region: WHOLE, steps: [{ ops }], on: null, whole: false, full: true }] }],
    project: HD, output: 'o.mp4', sources: SRC,
  });
  const g = graphsOf(args).join(';');
  assert.ok(g.includes("lutrgb=r='" + ops[0].a[0] + "':g='" + ops[0].a[1] + "':b='" + ops[0].a[2] + "'"));
  assert.ok(g.includes('format=gbrp,lutrgb='));
});

// ---- LUT files of a second sort ----

// A table of `n` steps a side as a .3dl file writes it: the input steps on a
// line, then a colour a line, blue running fastest.
function threeDl(n, white, colour, head = []) {
  const steps = [];
  for (let i = 0; i < n; i += 1) steps.push(Math.round((i * 1023) / (n - 1)));
  const lines = ['# made for a test', ...head, steps.join(' ')];
  for (let r = 0; r < n; r += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let b = 0; b < n; b += 1) {
        lines.push(colour(r / (n - 1), g / (n - 1), b / (n - 1)).map((x) => Math.round(x * white)).join(' '));
      }
    }
  }
  return lines.join('\r\n') + '\r\n';
}

test('a .3dl file is read as the same table a .cube file gives, red running fastest', () => {
  const swap = (r, g, b) => [b, r, g * 0.5];
  const t = O.parse3dl(threeDl(5, 4095, swap));
  assert.equal(t.ok, true);
  assert.equal(t.n, 5);
  assert.equal(t.foreign, true);
  assert.deepEqual(t.lo, [0, 0, 0]);
  assert.deepEqual(t.hi, [1, 1, 1]);
  assert.equal(t.data.length, 5 * 5 * 5 * 3);
  const at = (r, g, b) => Array.from(t.data.slice(((b * 5 + g) * 5 + r) * 3, ((b * 5 + g) * 5 + r) * 3 + 3));
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 0.001);
  assert.ok(near(at(4, 0, 0), [0, 1, 0]), 'red goes where the file put it');
  assert.ok(near(at(0, 4, 0), [0, 0, 0.5]));
  assert.ok(near(at(0, 0, 4), [1, 0, 0]));
  assert.ok(near(at(2, 4, 1), [0.25, 0.5, 0.5]));
});

test('how large white is in a .3dl file is what its Mesh line says, or what its figures fit in', () => {
  const same = (r, g, b) => [r, g, b];
  const top = (text) => {
    const t = O.parse3dl(text);
    return t.ok ? t.data[t.data.length - 1] : null;
  };
  // 10 bits and 12 bits by their largest figure, 16 bits too.
  assert.ok(Math.abs(top(threeDl(3, 1023, same)) - 1) < 1e-6);
  assert.ok(Math.abs(top(threeDl(3, 4095, same)) - 1) < 1e-6);
  assert.ok(Math.abs(top(threeDl(3, 65535, same)) - 1) < 1e-6);
  // A Mesh line says it: a table of 12 bits whose white is only 3000.
  const dim = top(threeDl(3, 3000, same, ['3DMESH', 'Mesh 1 12']));
  assert.ok(Math.abs(dim - 3000 / 4095) < 1e-6);
  // Without the line of input steps every line is a colour.
  const bare = threeDl(3, 1023, same).split('\r\n').filter((l, i) => i !== 1).join('\n');
  assert.equal(O.parse3dl(bare).n, 3);
  // What is no such table is not read.
  assert.equal(O.parse3dl('').ok, false);
  assert.equal(O.parse3dl(null).ok, false);
  assert.equal(O.parse3dl(threeDl(3, 1023, same).split('\r\n').slice(0, 20).join('\n')).ok, false);
  assert.equal(O.parse3dl(threeDl(3, 1023, same).replace('1023 1023 1023', '1023 x 1023')).ok, false);
});

test('a LUT file is read by what its name says it is', () => {
  const dl = threeDl(3, 1023, (r, g, b) => [r, g, b]);
  assert.equal(O.parseLut(dl, 'C:/luts/Look.3DL').ok, true);
  assert.equal(O.parseLut(dl, 'C:/luts/look.cube').ok, false);
  const cube = 'LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n';
  assert.equal(O.parseLut(cube, 'a.cube').ok, true);
  assert.equal(O.parseLut(cube, 'a.cube').foreign, undefined);
});

test('a table is written as a .cube file that reads back as the very same table', () => {
  const t = O.parse3dl(threeDl(4, 4095, (r, g, b) => [r * 0.9, g * g, 1 - b]));
  const text = O.cubeText(t);
  assert.ok(text.startsWith('LUT_3D_SIZE 4\n'));
  assert.equal(text.includes('DOMAIN'), false);
  const back = O.parseCube(text);
  assert.equal(back.ok, true);
  assert.equal(back.n, 4);
  assert.deepEqual(Array.from(back.data), Array.from(t.data));
  // A table with a range of its own keeps it.
  const ranged = O.parseCube('LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
  assert.deepEqual(O.parseCube(O.cubeText(ranged)).hi, [2, 2, 2]);
});

test('the encoder is handed a .cube written from a .3dl table, never the file itself', () => {
  const gl = read('renderer', 'app', 'vfxGl.js');
  assert.ok(gl.includes('vfxOps.parseLut(got.text, file)'));
  assert.ok(gl.includes('const made = await window.lwclipper.lutCube(entry.text);'));
  assert.ok(gl.includes("return entry.foreign ? (entry.path || '') : file;"));
  const exp = read('renderer', 'app', 'export.js');
  assert.ok(exp.includes(".map((o) => (o.op === 'lut3d' ? { ...o, file: vfxGl.cubePath(o.file) } : o))"));
  const main = read('main.js');
  assert.ok(main.includes("ipcMain.handle('lut:cube'"));
  assert.ok(main.includes("extensions: ['cube', '3dl']"));
  assert.ok(read('preload.js').includes("lutCube: (text) => ipcRenderer.invoke('lut:cube', text),"));
});

// ---- the tables and the window ----

test('Curves has a row in every table after the kinds before it, and a name for everything', () => {
  assert.equal(T.VFX_KIND_IDS[T.VFX_KIND_IDS.indexOf('halftone') + 1], 'curves');
  const rows = (file, table) => {
    const text = read(...file);
    const body = text.slice(text.indexOf('const ' + table + ' = {'));
    return [...body.slice(0, body.indexOf('\n};')).matchAll(/^  ([a-z]+): \{/gm)].map((m) => m[1]);
  };
  for (const [file, table] of [[['renderer', 'app', 'compositor.js'], 'VFX_PREVIEW'], [['renderer', 'app', 'export.js'], 'VFX_EXPORT'],
    [['src', 'composer.js'], 'VFX_FILTERS'], [['renderer', 'app', 'vfx.js'], 'VFX_UI']]) {
    const all = rows(file, table);
    assert.equal(all[all.indexOf('halftone') + 1], 'curves', table);
  }
  const js = read('renderer', 'app', 'vfx.js');
  assert.ok(js.includes("curves: { name: () => t('Curves'),"));
  assert.ok(js.includes("  curve: () => t('Curve:'),"));
  assert.ok(js.includes("if (s.type === 'curve') return vfxCurveField(doc, make, s, text, change);"));
  for (const file of ['en.json', 'de.json']) {
    const words = JSON.parse(read('locales', file));
    for (const key of ['Curves', 'Curve:', 'All', 'Reset Curve', 'Click to add a point, drag it out of the square to remove it',
      'Colours from a LUT file (.cube or .3dl), as colour grading tools write them']) assert.ok(words[key], file + ': ' + key);
  }
  const css = read('renderer', 'style.css');
  assert.ok(css.includes('.vfx-curve__pad {') && css.includes('.vfx-statics:has(.vfx-field--curve) {'));
});

test('a VFX that is off by a setting of its own is still on when its keyframes say so', () => {
  const keys = [{ t: 0, mix: 0 }, { t: 2, mix: 100 }];
  // Curves and Apply LUT are off by what is the same the whole clip long, which no keyframe holds.
  assert.equal(T.vfxEverOn(T.vfxOf({ kind: 'curves', keys })), true);
  assert.equal(T.vfxEverOn(T.vfxOf({ kind: 'lut', file: 'C:/luts/a.cube', keys })), true);
  assert.equal(T.vfxEverOn(T.vfxOf({ kind: 'lut', file: '', keys })), false);
  assert.equal(T.vfxEverOn(T.vfxOf({ kind: 'curves', curve: { m: FLAT, r: FLAT, g: FLAT, b: FLAT }, keys })), false);
  assert.equal(T.vfxEverOn(T.vfxOf({ kind: 'curves', keys: [{ t: 0, mix: 0 }, { t: 2, mix: 0 }] })), false);
  assert.equal(T.vfxEverOn(T.vfxOf({ kind: 'sepia', keys })), true);
});
