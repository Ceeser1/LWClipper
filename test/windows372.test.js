'use strict';

// V3.7.2. The user: "Let the windows be vertical scrollable if their size
// doesnt fit instead of shrinking its contents width". popout.js run in a
// sandbox, with a main window and one popped out window made up for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');

function sandbox() {
  const mainDoc = { name: 'main' };
  const popDoc = { name: 'pop' };
  const win = { innerWidth: 944, innerHeight: 600, document: popDoc };
  popDoc.defaultView = win;
  const ctx = vm.createContext({ document: mainDoc, window: { innerHeight: 1000 }, Map, Math, Number, Infinity });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'renderer', 'app', 'popout.js'), 'utf8'), ctx);
  const panel = { ownerDocument: popDoc, clientWidth: 927, scrollHeight: 900 };
  const modal = {};
  vm.runInContext('popped', ctx).set(modal, { win, panel, name: 'crop', gone: false, want: 0, fitted: 0 });
  return { ctx, win, panel, modal, mainDoc, popDoc };
}

test('a popped out stage is sized by the window\'s width, scrollbar or not', () => {
  const { ctx, panel, mainDoc } = sandbox();
  // 927 is the panel with a scrollbar beside it; the window is 944 across.
  assert.equal(ctx.popupWidth(panel), 944);
  assert.equal(ctx.popupWidth({ ownerDocument: mainDoc, clientWidth: 700 }), 700, 'in the main window, the panel\'s own');
});

test('out in its own window the stage is never cut down to the window\'s height', () => {
  const { ctx, panel, modal } = sandbox();
  const stage = { offsetHeight: 478 };
  assert.equal(ctx.popupStageRoom(panel, stage, 0.48, 478), Infinity);
  // The rest of the panel and the stage at its width, what the window is fitted to.
  assert.equal(vm.runInContext('popped', ctx).get(modal).want, 900 - 478 + 478 + 6);
});

test('in the main window, and in a dialog carried over a popped one, the old caps stay', () => {
  const { ctx, mainDoc, popDoc } = sandbox();
  assert.equal(ctx.popupStageRoom({ ownerDocument: mainDoc }, { offsetHeight: 0 }, 0.48), 480);
  const dialog = { ownerDocument: popDoc, clientWidth: 500, scrollHeight: 400 };
  assert.equal(ctx.popupStageRoom(dialog, { offsetHeight: 200 }, 0.48), 600 - 200 - 6);
  assert.equal(ctx.popupWidth(dialog), 500, 'a dialog\'s own width');
});

test('the buttons stay on the bottom edge of a window that scrolls', () => {
  const rule = CSS.match(/body\.popout-body > \.modal__panel > \.crop-actions \{([^}]*)\}/);
  assert.ok(rule, 'the rule is there');
  assert.match(rule[1], /position: sticky;/);
  assert.match(rule[1], /bottom: 0;/);
  assert.match(rule[1], /background: /, 'over whatever scrolls under them');
});
