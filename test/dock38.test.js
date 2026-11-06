'use strict';

// V3.8. An editor window docked into Start Frame or End Frame: which cell a
// dragged window is over, where each editor was last, and how a docked
// panel's stage is sized. popout.js run in a sandbox, with a made-up preview
// row of three cells.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');

function cell(left, width) {
  const classes = new Set(['preview-cell']);
  return {
    rect: { left, right: left + width, top: 100, bottom: 400, width, height: 300 },
    getBoundingClientRect() { return this.rect; },
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    classes,
  };
}

function sandbox(settings) {
  const cells = [cell(20, 300), cell(330, 300), cell(640, 300)];
  const saved = [];
  const ctx = vm.createContext({
    document: {},
    window: { innerHeight: 1000, lwclipper: { setSettings: (patch) => saved.push(patch) } },
    previewGrid: { querySelectorAll: () => cells },
    previewSection: { dataset: { audio: 'false' } },
    appSettings: settings,
    Map, Math, Number, JSON, Infinity, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'app', 'popout.js'), 'utf8'), ctx);
  return { ctx, cells, saved };
}

test('a dragged window is over Start Frame, End Frame or neither, never the preview', () => {
  const { ctx } = sandbox({});
  assert.equal(ctx.dockCellAt(100, 200), 'start');
  assert.equal(ctx.dockCellAt(700, 390), 'end');
  assert.equal(ctx.dockCellAt(400, 200), null, 'the preview in the middle takes nothing');
  assert.equal(ctx.dockCellAt(100, 500), null);
});

test('both frames light up as soon as a window is dragged, the one under the pointer more', () => {
  const { ctx, cells } = sandbox({});
  ctx.paintDockTargets(true, 'end');
  assert.ok(cells[0].classes.has('preview-cell--dock-target'));
  assert.ok(!cells[0].classes.has('preview-cell--dock-over'));
  assert.ok(cells[2].classes.has('preview-cell--dock-target') && cells[2].classes.has('preview-cell--dock-over'));
  assert.ok(!cells[1].classes.has('preview-cell--dock-target'), 'not the preview');
  ctx.paintDockTargets(false, null);
  assert.ok(cells.every((c) => !c.classes.has('preview-cell--dock-target') && !c.classes.has('preview-cell--dock-over')));
});

test('with no picture in the preview row there is nothing to dock into', () => {
  const { ctx } = sandbox({});
  vm.runInContext('previewSection.dataset.audio = "true"', ctx);
  assert.equal(ctx.dockCellAt(100, 200), null);
  assert.equal(ctx.dockCell('start'), null);
});

test('each editor window is remembered docked or not, by its name, and saved', () => {
  const settings = { popoutDock: null };
  const { ctx, saved } = sandbox(settings);
  assert.equal(ctx.dockedLast('crop'), null, 'a window until it has been docked');
  ctx.rememberDock('crop', 'end');
  assert.equal(ctx.dockedLast('crop'), 'end');
  // Made in the sandbox, so compared as what it would be written as.
  assert.equal(JSON.stringify(saved.at(-1)), JSON.stringify({ popoutDock: { crop: 'end' } }));
  ctx.rememberDock('media', 'start');
  ctx.rememberDock('crop', null);
  assert.equal(ctx.dockedLast('crop'), null, 'popped out again, a window again');
  assert.equal(ctx.dockedLast('media'), 'start');
  const n = saved.length;
  ctx.rememberDock('media', 'start');
  assert.equal(saved.length, n, 'nothing written when nothing changed');
  settings.popoutDock = { crop: 'middle' };
  assert.equal(ctx.dockedLast('crop'), null, 'only the two frames');
});

test('docked, a stage is sized by its cell and never cut to a height: the cell scrolls', () => {
  const { ctx } = sandbox({});
  const panel = { ownerDocument: {}, clientWidth: 400, scrollHeight: 900 };
  const modal = {};
  vm.runInContext('docked', ctx).set(modal, { panel, body: { clientWidth: 288 } });
  assert.equal(ctx.popupWidth(panel), 288);
  assert.equal(ctx.popupStageRoom(panel, { offsetHeight: 200 }, 0.48, 162), Infinity);
  assert.equal(ctx.popupFree(panel), true);
  assert.equal(ctx.isPoppedOut(modal), true, 'it counts as out of its modal');
});

test('the cell keeps its frame under the editor, and its scrollbar\'s room always', () => {
  assert.match(CSS, /\.preview-cell--docked > :not\(\.dock-host\):not\(\.preview-splitter\) \{\s*visibility: hidden;/);
  const body = CSS.match(/\.dock-body \{([^}]*)\}/)[1];
  assert.match(body, /scrollbar-gutter: stable;/);
  assert.match(body, /overflow: auto;/);
});
