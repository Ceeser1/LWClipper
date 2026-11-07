'use strict';

// V3.8.2. Several editor windows open together, each its own state; the
// markup the window edits changed (Color | Gradient last, the gradient's
// how-to, Edit Text, the text box's knob); popout.js's dock rules for them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const T = require('../src/timeline');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = read('renderer', 'index.html');
const CSS = read('renderer', 'style.css');

// ---- the markup ----

/** The ids of a grid's fields' first elements, in order, for `gridOpen`. */
function gridBody(open) {
  const at = HTML.indexOf(open);
  assert.ok(at >= 0, open + ' is in the page');
  const rest = HTML.slice(at);
  // The grids close at the first line that starts a new block at the same
  // depth: the gradient block's comment follows each.
  const end = rest.search(/\n\s*<!-- V3\.7(\.1)?\. The (mask's )?gradient/);
  return rest.slice(0, end);
}

test('Color | Gradient is the last field of Shape Settings and of the Layer Mask grid', () => {
  for (const [open, fill] of [['<div class="gen-grid">', 'shapeFill'], ['<div id="maskGrid"', 'maskFill']]) {
    const body = gridBody(open);
    const at = body.indexOf('id="' + fill + '"');
    assert.ok(at > 0, fill + ' is in the grid');
    const fields = [...body.matchAll(/<div (?:id="\w+" )?class="gen-field[^"]*"/g)];
    const last = fields[fields.length - 1];
    assert.ok(last[0].includes('gen-field--fill'), 'the last field is the fill one');
    assert.ok(body.indexOf(last[0]) < at, 'and it holds ' + fill);
    assert.equal(body.slice(at).includes('class="gen-field'), false, 'nothing follows it in the grid');
  }
  assert.ok(/\.gen-grid \.gen-field--fill\s*\{[^}]*grid-column:\s*1 \/ -1/.test(CSS), 'on a row of its own');
});

test('the gradient\'s how-to is always shown with the gradient, not in Info', () => {
  const text = 'Gradient: Double click the gradient bar to add a color point, right click one to remove. '
    + 'To apply a gradient: Right-click somewhere on the preview and drag any direction.';
  for (const [block, help] of [['shapeGradient', 'shapeGradHelp'], ['maskGradient', 'maskGradHelp']]) {
    const at = HTML.indexOf('<div id="' + block + '"');
    const end = HTML.indexOf('<div id="' + (block === 'shapeGradient' ? 'shapeStage' : 'maskStage'), at);
    const part = HTML.slice(at, end);
    assert.ok(part.includes('id="' + help + '"') && part.includes(text), help + ' sits in ' + block);
  }
  assert.equal(/id="(shape|mask)GradHint"/.test(HTML), false, 'the Info lines are gone');
});

test('Edit Text: the mode button, the knob above the box, plain corners', () => {
  assert.ok(HTML.includes('<button data-mode="edit">Edit Text</button>'));
  const at = HTML.indexOf('<div id="textBoxEl"');
  const box = HTML.slice(at, HTML.indexOf('<div id="textAngle"', at));
  assert.ok(box.includes('id="textRotor" class="shape-rotor text-rotor"') && box.includes('shape-rotor-line'));
  assert.equal(/crop-corner[^"]*text-rotor/.test(box), false, 'no corner turns it any more');
  assert.equal((box.match(/class="crop-corner crop-corner--/g) || []).length, 4);
  const js = read('renderer', 'app', 'gen', 'text.js');
  assert.ok(js.includes("textFrame.style.transform = '';"), 'typed upright');
});

test('the right click on a gradient dot takes it off, the ends staying', () => {
  const js = read('renderer', 'app', 'gen', 'gradient.js');
  assert.ok(js.includes("dot.addEventListener('contextmenu'"));
  assert.ok(js.includes('index <= 0 || index >= g.stops.length - 1'), 'first and last stay');
});

// ---- popout.js: the dock rules ----

function cell(taken) {
  const classes = new Set(['preview-cell']);
  if (taken) classes.add('preview-cell--docked');
  return {
    getBoundingClientRect: () => ({ left: 0, right: 300, top: 0, bottom: 300, width: 300, height: 300 }),
    classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle() {} },
  };
}

function popoutSandbox(settings, cells) {
  const saved = [];
  const ctx = vm.createContext({
    document: {},
    window: { innerHeight: 1000, lwclipper: { setSettings: (patch) => saved.push(patch) } },
    previewGrid: { querySelectorAll: () => cells },
    previewSection: { dataset: { audio: 'false' } },
    appSettings: settings,
    Map, Math, Number, JSON, Infinity, setTimeout, clearTimeout, RegExp, Set,
  });
  vm.runInContext(read('renderer', 'app', 'popout.js'), ctx);
  return { ctx, saved };
}

test('the old shared "media" dock is read by the three media windows, then replaced', () => {
  const settings = { popoutDock: { media: 'end' } };
  const { ctx } = popoutSandbox(settings, [cell(), cell(), cell()]);
  for (const name of ['bar', 'shape', 'text']) assert.equal(ctx.dockedLast(name), 'end', name);
  assert.equal(ctx.dockedLast('crop'), null);
  ctx.rememberDock('shape', 'start');
  assert.equal(JSON.stringify(settings.popoutDock), JSON.stringify({ shape: 'start' }));
  assert.equal(ctx.dockedLast('text'), null, 'its own entry now, a window until docked');
});

test('a frame that already holds a window takes no second one', () => {
  const cells = [cell(true), cell(), cell(false)];
  const { ctx } = popoutSandbox({}, cells);
  assert.equal(ctx.dockInto({}, 'shape', {}, 'start', {}), false, 'Start Frame is taken');
});

test('the dock title is centred by an unseen copy of the buttons', () => {
  const js = read('renderer', 'app', 'popout.js');
  assert.ok(js.includes('head.append(lead, title, tools)'));
  assert.ok(/\.dock-head__lead\s*\{[^}]*visibility:\s*hidden/.test(CSS));
});

// ---- the media windows' state, one per window ----

function genSandbox() {
  const layers = [
    T.createLayer({ type: 'video', kind: 'gen', gen: { form: 'bar' }, duration: 10 }),
    T.createLayer({ type: 'video', kind: 'gen', gen: { form: 'text', text: { runs: [{ text: 'a', style: {} }] } }, duration: 10 }),
  ];
  const log = [];
  const modalOf = (id) => ({ id, querySelector: () => ({ textContent: id }) });
  const ctx = vm.createContext({
    document: { createElement: () => ({}) },
    timelineModel: T,
    layers,
    compositeAt: 0,
    compositePlaying: false,
    t: (s) => s,
    projectFrame: () => ({ width: 1280, height: 720 }),
    editorTitle: (title) => title,
    popOut: (modal, name) => log.push(['popOut', modal.id, name]),
    popIn: (modal) => log.push(['popIn', modal.id]),
    setPopoutPreview: () => {},
    clearPopoutPreview: (owner) => log.push(['clear', owner]),
    drawComposite: () => {},
    renderWindowConflict: () => null,
    makeKeySession: () => ({ reset() {}, follow() {} }),
    makeKeyStrip: () => ({ draw() {} }),
    newKeyframeId: () => 'k',
    rebaseWorkKeys: () => null,
    setLayers() {},
    commitHistory() {},
    selectKeyframe() {},
    Map, Set, JSON, Math, Number,
  });
  vm.runInContext(read('renderer', 'app', 'gen', 'preview.js'), ctx);
  return { ctx, layers, log, modalOf };
}

function open(S, layer, modalId, cancels) {
  const modal = S.modalOf(modalId);
  S.ctx.startGenWork(layer);
  S.ctx.popOutGenWindow(modal, layer.id, {
    title: 'x', cancel: () => cancels.push(layer.id), relayout() {}, draftGen: () => null, changed: () => false, reload() {}, strip: null,
  });
  return modal;
}

test('Bar Settings and Edit Text can be open together, each under a name of its own', () => {
  const S = genSandbox();
  const cancels = [];
  const bar = open(S, S.layers[0], 'barModal', cancels);
  const text = open(S, S.layers[1], 'textModal', cancels);
  assert.deepEqual(S.log.filter((e) => e[0] === 'popOut').map((e) => e[2]), ['bar', 'text']);
  assert.equal(S.ctx.genWindowOpen(), true);
  assert.equal(S.ctx.genWindowOn(S.layers[0].id) && S.ctx.genWindowOn(S.layers[1].id), true);
  assert.deepEqual([...S.ctx.genWindowLayerIds()], [S.layers[0].id, S.layers[1].id]);
  // The same kind again is what asks; another kind is left alone.
  const again = S.ctx.genOpenConflicts(bar);
  assert.ok(again[0] && again[0].message, 'Bar Settings is open already');
  assert.equal(S.ctx.genOpenConflicts(S.modalOf('shapeModal')).filter(Boolean).length, 0, 'Shape Settings is free');
  // Closing one leaves the other.
  S.ctx.popInGenWindow(bar);
  assert.equal(S.ctx.genWindowOn(S.layers[0].id), false);
  assert.equal(S.ctx.genWindowOn(S.layers[1].id), true);
  assert.deepEqual(S.log.filter((e) => e[0] === 'clear'), [['clear', 'barModal']], 'only its own draft off the preview');
  assert.equal(S.ctx.genOpenConflicts(bar).filter(Boolean).length, 0);
  // A conflict closes its own window the way its Cancel would.
  S.ctx.genWindowConflict(S.layers[1].id).close();
  assert.deepEqual(cancels, [S.layers[1].id]);
  void text;
});

test('closing every media window cancels each, and the keyframe lookup is per window', () => {
  const S = genSandbox();
  const cancels = [];
  open(S, S.layers[0], 'barModal', cancels);
  open(S, S.layers[1], 'textModal', cancels);
  S.ctx.genCtxOf(S.layers[1].id).keyframe = { id: 'k1', layerId: S.layers[1].id, t: 1 };
  assert.equal(S.ctx.genCtxOf(S.layers[0].id).keyframe, null);
  assert.equal(S.ctx.genCtxOf(S.layers[1].id).keyframe.id, 'k1');
  S.ctx.closeGenWindow();
  assert.deepEqual(cancels.sort(), [S.layers[0].id, S.layers[1].id].sort());
});

test('two adds waiting on their first Accept are cancelled one by one', () => {
  const S = genSandbox();
  assert.equal(typeof S.ctx.cancelGenAdd, 'function');
  assert.equal(S.ctx.cancelGenAdd.length, 1, 'by layer id');
  assert.equal(vm.runInContext('genAddBefore instanceof Map', S.ctx), true);
});

// ---- deleting grouped tracks asks first ----

test('a grouped track or a row of grouped tracks asks before it is deleted', () => {
  const edit = read('renderer', 'app', 'editing.js');
  const clips = read('renderer', 'app', 'clips.js');
  assert.ok(edit.includes("confirmGroupedDelete(t('This track is grouped.')"));
  assert.ok(clips.includes("confirmGroupedDelete(t('This layer contains grouped tracks.')"));
  assert.ok(edit.includes("cancel: 'cancel'"), 'a click outside answers Cancel');
  assert.ok(edit.includes("t('Are you sure you want to delete it?')"));
  // One line, Cancel left in the ordinary colour, Delete Group and Delete Single right.
  assert.ok(edit.includes("warning + ' ' + t('Are you sure you want to delete it?')"));
  assert.ok(edit.includes("{ id: 'cancel', label: t('Cancel'), left: true }"));
  const asks = edit.slice(edit.indexOf('function confirmGroupedDelete'), edit.indexOf('function deleteTracks'));
  assert.equal(/id: 'cancel'[^}]*(tone|primary)/.test(asks), false, 'Cancel is a plain button');
  assert.ok(edit.includes("t('Delete Group')") && edit.includes("t('Delete Single')"));
  assert.ok(/\.choice-buttons \.choice-buttons__left\s*\{[^}]*margin-right:\s*auto/.test(CSS));
});

// ---- choosing several clips, and moving them together ----

test('moveSet slides every chosen clip and their groups by one shift, held at zero together', () => {
  const g = T.newGroupId();
  const mk = (o) => T.createLayer({ type: 'video', kind: 'gen', gen: { form: 'bar' }, duration: 3, ...o });
  const a = mk({ start: 1 });
  const b = mk({ start: 6 });
  const v = mk({ start: 10, groupId: g });
  const s = T.createLayer({ type: 'audio', kind: 'gen', gen: { form: 'bar' }, duration: 3, start: 10, groupId: g });
  const list = [a, b, v, s];
  const moved = T.moveSet(list, [a.id, b.id, v.id], b.id, 8);
  assert.deepEqual(moved.map((l) => l.start), [3, 8, 12, 12], 'b by +2, the sound with its picture');
  const held = T.moveSet(list, [a.id, b.id], b.id, 0);
  assert.deepEqual(held.map((l) => l.start), [0, 5, 10, 10], 'the earliest stops at 0 and the rest keep their gaps');
});

test('Ctrl+A is taken only with the timeline clicked, Shift and a dragged range choose', () => {
  const edit = read('renderer', 'app', 'editing.js');
  const tl = read('renderer', 'app', 'timeline.js');
  const clips = read('renderer', 'app', 'clips.js');
  assert.ok(/key === 'a' && timelineClicked/.test(edit) && edit.includes('evt.preventDefault();\n    window.getSelection().removeAllRanges();'));
  assert.ok(tl.includes("closest('.timeline-section')"));
  assert.ok(clips.includes('if (evt.shiftKey && !edge)') && clips.includes('toggleLayerSelection(layerId)'));
  assert.ok(tl.includes('chooseInRange(') && tl.includes('timeline-marquee'));
  assert.ok(tl.includes('snapMarkerToTrackEdge(value, isStart)'), 'the markers snap to track edges');
});

test('shiftToZero slides everything left only when nothing starts before the point', () => {
  const mk = (o) => T.createLayer({ type: 'video', kind: 'gen', gen: { form: 'bar' }, duration: 3, ...o });
  const list = [mk({ start: 2 }), mk({ start: 6 })];
  assert.deepEqual(T.shiftToZero(list, 2).map((l) => l.start), [0, 4]);
  assert.equal(T.shiftToZero(list, 3), list, 'a clip starts before 3, so nothing moves');
  assert.equal(T.shiftToZero(list, 0), list);
  assert.equal(T.shiftToZero([], 2).length, 0);
  const tl = read('renderer', 'app', 'timeline.js');
  assert.ok(tl.includes('snapMarkerToTrackEdge(value, isStart)') && tl.includes('if (isStart && moved) restartAtMarker();'));
});

test('the timeline has a sideways scroll bar, shown while a track lies out of view', () => {
  assert.ok(HTML.includes('id="timelineHBar" class="timeline-hbar" hidden'));
  const tl = read('renderer', 'app', 'timeline.js');
  assert.ok(tl.includes('updateTimelineHBar();') && tl.includes('timelineHBar.hidden = !out;'));
  assert.ok(/\.timeline-hbar\s*\{[^}]*left:\s*var\(--timeline-gutter\)/.test(CSS));
});

test('Project saved. is a passing line: it takes the Clear button out and goes after a few seconds', () => {
  const shell = read('renderer', 'app', 'shell.js');
  assert.ok(/TRANSIENT_STATUS = \{ 'Project saved\.': \d+ \}/.test(shell));
  assert.ok(shell.includes('mainActions.hidden = transientStatusShown() && !busy;'));
  assert.ok(/\.main-actions\[hidden\]\s*\{\s*display:\s*none/.test(CSS));
});

test('zooming in with no track past the right edge closes in from the left, not at the pointer', () => {
  const tl = read('renderer', 'app', 'timeline.js');
  assert.ok(tl.includes('const tracksBeyond = timelineModel.totalDuration(layers) > right + 1e-6;'));
  assert.ok(tl.includes('notches > 0 && layers.length && !tracksBeyond ? 0 : evt.clientX - rect.left'));
});
