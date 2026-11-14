'use strict';

// V4.11.1. A handle between Project Media and the timeline, the layout kept
// in the app's settings and put back at the next start, and View > Restore
// default layout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const HTML = read('renderer', 'index.html');
const CSS = read('renderer', 'style.css');
const LAYOUT = read('renderer', 'app', 'layout.js');
const MEDIA = read('renderer', 'app', 'projectMedia.js');
const ACTIONS = read('renderer', 'app', 'actions.js');
const MAIN = read('main.js');

/** A function's source, from its name to the blank line after its closing brace. */
function fn(source, name) {
  const from = source.indexOf('function ' + name + '(');
  assert.ok(from >= 0, name + ' is there');
  return source.slice(from, source.indexOf('\n}\n', from) + 3);
}

test('a handle stands between Project Media and the timeline', () => {
  const media = HTML.indexOf('<section class="section media-section" id="projectMedia">');
  const handle = HTML.indexOf('<div id="mediaSplitter" class="splitter splitter--media" role="separator"');
  const timeline = HTML.indexOf('<div class="edit-area">');
  assert.ok(media > 0 && handle > media && timeline > handle);
  // Like the one above Project Media, and nothing else between the two.
  assert.ok(HTML.indexOf('<div id="editSplitter" class="splitter"') < media);
  // It takes the frame's own bottom margin, so nothing on the screen moves for it.
  assert.match(CSS, /body\.advanced \.media-section \{\s+margin-bottom: 0;\s+\}/);
});

test('one number sizes everything in the frame: the height of a tile\'s picture', () => {
  assert.match(CSS, /\.media-tile__frame \{\s+width: calc\(var\(--media-h, 81px\) \* 16 \/ 9\);\s+height: var\(--media-h, 81px\);\s+\}/);
  assert.match(CSS, /\.media-tile \{\s+width: calc\(var\(--media-h, 81px\) \* 16 \/ 9 \+ 8px\);\s+\}/);
  assert.match(CSS, /\.media-add \{\s+width: calc\(var\(--media-h, 81px\) \+ 27px\);\s+height: calc\(var\(--media-h, 81px\) \+ 27px\);\s+\}/);
  // The model of it, run: the default is no property at all, and it is held to its range.
  const props = new Map();
  const document = { documentElement: { style: {
    setProperty: (k, v) => props.set(k, v),
    removeProperty: (k) => props.delete(k),
  } } };
  const make = new Function('document', [
    'const MEDIA_H_DEFAULT = 81; const MEDIA_H_MIN = 36; const MEDIA_H_MAX = 270; let mediaHeight = null;',
    fn(MEDIA, 'mediaHeightWish'), fn(MEDIA, 'mediaFrameSize'), fn(MEDIA, 'setMediaHeight'),
    'return { mediaHeightWish, mediaFrameSize, setMediaHeight };',
  ].join('\n'));
  const m = make(document);
  assert.deepEqual(m.mediaFrameSize(), { w: 144, h: 81 }, 'the size the frame always had');
  assert.equal(m.mediaHeightWish(), null);
  m.setMediaHeight(140.4);
  assert.equal(m.mediaHeightWish(), 140);
  assert.equal(props.get('--media-h'), '140px');
  assert.deepEqual(m.mediaFrameSize(), { w: 249, h: 140 });
  m.setMediaHeight(5);
  assert.equal(m.mediaHeightWish(), 36);
  m.setMediaHeight(5000);
  assert.equal(m.mediaHeightWish(), 270);
  // Back at the default it is the stylesheet's again, and nothing to save.
  m.setMediaHeight(81);
  assert.equal(m.mediaHeightWish(), null);
  assert.equal(props.has('--media-h'), false);
  m.setMediaHeight(100);
  m.setMediaHeight(null);
  assert.equal(props.has('--media-h'), false);
});

test('dragging it trades height with the timeline and leaves the previews alone', () => {
  const drag = MEDIA.slice(MEDIA.indexOf("mediaSplitter.addEventListener('pointermove'"), MEDIA.indexOf('function endMediaSplit('));
  assert.match(drag, /setMediaHeight\(want\);/);
  // Where the stack belongs is said on every step, the step back included.
  assert.match(drag, /holdSplitAt\(mediaFrom\.stack \+ \(mediaFrom\.section - now\)\);/);
  // No taller than the timeline has rows to give.
  assert.match(drag, /Math\.min\(mediaFrom\.height \+ \(evt\.clientY - mediaFrom\.y\), mediaFrom\.height \+ mediaFrom\.stack\)/);
  // Folded there is nothing to size.
  assert.match(MEDIA, /if \(evt\.button !== 0 \|\| projectMediaSection\.classList\.contains\('media-section--collapsed'\)\) return;/);
  assert.match(MEDIA, /mediaSplitter\.classList\.toggle\('splitter--off', on\);/);
  assert.match(fn(MEDIA, 'endMediaSplit'), /drawProjectMedia\(\);\s+saveLayout\(\);/);
});

test('every handle saves the layout when it is let go, in the app\'s settings', () => {
  for (const name of ['endSplit', 'endGutterDrag', 'holdSplitAt']) {
    assert.match(fn(LAYOUT, name), /saveLayout\(\);/, name);
  }
  // The side handles' release.
  assert.match(LAYOUT, /document\.body\.classList\.remove\('splitting-side'\);\s+if \(handle\.hasPointerCapture\(evt\.pointerId\)\) handle\.releasePointerCapture\(evt\.pointerId\);\s+saveLayout\(\);/);
  const now = fn(LAYOUT, 'layoutNow');
  for (const key of ['split:', 'splitMax:', 'side:', 'gutter:', 'media:']) assert.ok(now.includes(key), key);
  const save = fn(LAYOUT, 'saveLayout');
  assert.match(save, /window\.lwclipper\.setSettings\(\{ layout: any \? now : null \}\)/);
  const settings = read('src', 'settings.js');
  assert.match(settings, /\n {2}layout: null,\n/);
  assert.match(settings, /\n {2}windowSize: null,\n/);
});

test('the saved layout is put back once, held to what each handle allows', () => {
  const restore = fn(LAYOUT, 'restoreLayout');
  assert.match(restore, /if \(layoutRestored\) return;\s+layoutRestored = true;/);
  assert.match(restore, /splitWish = held\(saved\.split, 0, 100000\);/);
  assert.match(restore, /splitMaxShare = held\(saved\.splitMax, 0, 1\);/);
  assert.match(restore, /gutterWish = held\(saved\.gutter, GUTTER_MIN, GUTTER_MAX\);/);
  assert.match(restore, /setMediaHeight\(held\(saved\.media, MEDIA_H_MIN, MEDIA_H_MAX\)\)/);
  // A split somebody set stops the window sizing itself round the previews.
  assert.match(restore, /splitTaken = true;\s+window\.lwclipper\.releaseWindowHeight\(\);/);
  assert.match(read('renderer', 'app', 'shell.js'), /if \(typeof restoreLayout === 'function'\) restoreLayout\(appSettings\.layout\);/);
  // What is not a number is left at its default.
  const held = new Function('return ' + restore.slice(restore.indexOf('(v, lo, hi) =>'), restore.indexOf('splitWish = held')).replace(/;\s*$/, ''))();
  assert.equal(held(null, 0, 10), null);
  assert.equal(held(undefined, 0, 10), null);
  assert.equal(held('wide', 0, 10), null);
  assert.equal(held(4, 0, 10), 4);
  assert.equal(held(400, 0, 10), 10);
  assert.equal(held(-3, 0, 10), 0);
});

test('View has Restore default layout on F12, under Toggle Fullscreen', () => {
  const at = ACTIONS.indexOf("id: 'view.resetLayout'");
  assert.ok(at > ACTIONS.indexOf("id: 'view.fullscreen'") && at < ACTIONS.indexOf("id: 'settings.preferences'"));
  assert.match(ACTIONS, /id: 'view\.resetLayout', menu: 'view', label: \(\) => t\('Restore default layout'\), keys: \['F12'\], take: true,/);
  assert.match(ACTIONS, /run: \(\) => resetLayout\(\),/);
  const reset = fn(LAYOUT, 'resetLayout');
  for (const line of ['splitWish = null;', 'splitMaxShare = null;', 'sideWish = null;', 'gutterWish = null;', 'splitTaken = false;',
    "document.documentElement.style.removeProperty('--timeline-gutter');", 'setMediaHeight(null);',
    'window.lwclipper.setSettings({ layout: null })', 'window.lwclipper.resetWindowSize()']) {
    assert.ok(reset.includes(line), line);
  }
  for (const code of ['en', 'de']) {
    assert.ok(JSON.parse(read('locales', code + '.json'))['Restore default layout'], code);
  }
});

test('the window opens at the size it was left at, and Restore default layout forgets it', () => {
  assert.match(MAIN, /const kept = keptWindowSize\(\);\s+const openWidth = kept \? kept\.width : BASE_WIDTH;\s+const openHeight = kept \? kept\.height : BASE_HEIGHT;\s+if \(kept && !kept\.auto\) autoHeight = false;/);
  const kept = fn(MAIN, 'keptWindowSize');
  // Still fitting its own height when it was left, only the width is taken.
  assert.match(kept, /height: auto \? BASE_HEIGHT : Math\.max\(MIN_HEIGHT, Math\.min\(height, area\.height\)\),/);
  assert.match(kept, /width: Math\.max\(MIN_WIDTH, Math\.min\(width, area\.width\)\),/);
  assert.match(MAIN, /if \(kept && kept\.maximized\) mainWindow\.maximize\(\);/);
  const note = fn(MAIN, 'noteWindowSize');
  assert.match(note, /if \(mainWindow\.isMinimized\(\) \|\| mainWindow\.isFullScreen\(\)\) return;/);
  assert.match(note, /const b = mainWindow\.getNormalBounds\(\);/);
  const reset = MAIN.slice(MAIN.indexOf("ipcMain.handle('window:resetSize'"), MAIN.indexOf("ipcMain.handle('window:fit'"));
  assert.match(reset, /autoHeight = true;\s+lastAutoHeight = BASE_HEIGHT;/);
  assert.match(reset, /mainWindow\.setSize\(BASE_WIDTH, BASE_HEIGHT, false\);/);
  assert.match(reset, /settings\.set\(\{ windowSize: null \}\);/);
  assert.match(read('preload.js'), /resetWindowSize: \(\) => ipcRenderer\.invoke\('window:resetSize'\),/);
});
