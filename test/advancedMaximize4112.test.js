'use strict';

// V4.11.2. Advanced editing has the window maximized: when the app opens in
// it, and when it is switched on while the app is open.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const STARTUP = read('renderer', 'app', 'startup.js');
const EDITING = read('renderer', 'app', 'editing.js');
const SHELL = read('renderer', 'app', 'shell.js');

/** A function's source, from its name to the blank line after its closing brace. */
function fn(source, name) {
  const from = source.indexOf('function ' + name + '(');
  assert.ok(from >= 0, name + ' is there');
  return source.slice(from, source.indexOf('\n}\n', from) + 3);
}

test('the window opens maximized in advanced editing, however it was left', () => {
  const create = fn(MAIN, 'createWindow');
  // After the kept state, so a window left maximized in simple editing still
  // opens that way, and one left restored down in advanced editing does not.
  assert.match(create, /if \(kept && kept\.maximized\) mainWindow\.maximize\(\);\s+(\/\/[^\n]*\s+)+else if \(settings\.get\('advancedEditing'\)\) mainWindow\.maximize\(\);/);
});

test('a fresh profile opens in advanced editing, and so maximized', () => {
  // "the v4.11.3 standalone and installer both should open in Advanced editing
  // mode in windowed-fullscreen from now on", the user on 2026-11-15. Both are
  // this one app, and nothing in it branches on which build it is, so the
  // default is what decides it.
  assert.equal(require('../src/settings').DEFAULTS.advancedEditing, true);
  // With nothing saved there is no kept window state, so it is the setting
  // that maximizes, and a setting nobody saved reads as its default.
  const create = fn(MAIN, 'createWindow');
  assert.match(create, /else if \(settings\.get\('advancedEditing'\)\) mainWindow\.maximize\(\);/);
  assert.match(read('src', 'settings.js'), /current = \{ \.\.\.DEFAULTS \};/);
});

test('the window can be asked to maximize, and a fullscreen one is left alone', () => {
  const from = MAIN.indexOf("ipcMain.handle('window:maximize'");
  assert.ok(from > 0);
  const handler = MAIN.slice(from, MAIN.indexOf('\n});\n', from));
  assert.match(handler, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) return false;/);
  assert.match(handler, /if \(mainWindow\.isFullScreen\(\)\) return false;\s+if \(!mainWindow\.isMaximized\(\)\) mainWindow\.maximize\(\);/);
  assert.match(PRELOAD, /maximizeWindow: \(\) => ipcRenderer\.invoke\('window:maximize'\),/);
});

test('switching advanced editing on maximizes, switching it off does not', () => {
  const set = fn(STARTUP, 'setAdvancedEditing');
  assert.match(set, /function setAdvancedEditing\(on, \{ maximize = true \} = \{\}\) \{/);
  // Read off the setting as it came back, so a switch that did not take does
  // not move the window, and off is never a reason to.
  assert.match(set, /applyAdvancedEditing\(\);\s+if \(maximize && appSettings\.advancedEditing\) window\.lwclipper\.maximizeWindow\(\);/);
  // The tick box and a still dropped on simple editing both go through it as
  // it stands.
  assert.match(STARTUP, /advancedEditingToggle\.addEventListener\('change', \(\) => \{\s+setAdvancedEditing\(advancedEditingToggle\.checked\);/);
  assert.match(SHELL, /if \(!timelineDriving\(\)\) await setAdvancedEditing\(true\);/);
});

test('a project opened from simple editing maximizes only once it is open', () => {
  const open = fn(EDITING, 'openProjectPath');
  assert.match(open, /if \(wasSimple\) await setAdvancedEditing\(true, \{ maximize: false \}\);/);
  // Every way out without a project puts the switch back and moves nothing.
  assert.equal(open.split('await setAdvancedEditing(false);').length - 1, 3);
  assert.match(open, /if \(!opened && wasSimple\) await setAdvancedEditing\(false\);\s+(\/\/[^\n]*\s+)+if \(opened && wasSimple\) window\.lwclipper\.maximizeWindow\(\);\s+return opened;/);
});
