'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// toolPaths reaches for Electron's app to resolve the Videos folder. A real
// temp folder stands in for it, since these tests create directories for real.
const FAKE_VIDEOS = fs.mkdtempSync(path.join(os.tmpdir(), 'lwc-videos-'));
require.cache[require.resolve('electron')] = {
  exports: {
    app: {
      isPackaged: false,
      getPath: (name) => (name === 'videos' ? FAKE_VIDEOS : FAKE_VIDEOS),
    },
  },
};

const settings = require('../src/settings');
const toolPaths = require('../src/toolPaths');

const NAME = 'LWClipper_cache';
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), label));

test.afterEach(() => {
  settings.set({ cacheDir: null });
});

test('a picked folder gets the cache folder made inside it', () => {
  const picked = tempDir('lwc-pick-');
  settings.set({ cacheDir: picked });
  assert.equal(toolPaths.cacheDir(), path.join(picked, NAME));
  assert.ok(fs.existsSync(path.join(picked, NAME)));
});

test('picking the cache folder itself does not nest a second one', () => {
  // The dialog opens inside the current cache folder, so choosing it rather
  // than its parent is the easy mistake, and one nobody should be punished for.
  const parent = tempDir('lwc-self-');
  const inner = path.join(parent, NAME);
  fs.mkdirSync(inner);
  settings.set({ cacheDir: inner });
  assert.equal(toolPaths.cacheDir(), inner);
  assert.equal(fs.existsSync(path.join(inner, NAME)), false, 'nothing nested inside it');
});

test('and not even when Windows spelled it differently', () => {
  // Windows does not distinguish case in a path, so this is the same folder.
  const parent = tempDir('lwc-case-');
  const inner = path.join(parent, 'lwclipper_CACHE');
  fs.mkdirSync(inner);
  settings.set({ cacheDir: inner });
  assert.equal(toolPaths.cacheDir(), inner);
  assert.equal(fs.readdirSync(inner).length, 0, 'still empty, nothing was created in it');
});

test('an existing cache folder is reused, not replaced', () => {
  // Whatever is already downloaded has to survive pointing the setting at the
  // folder that holds it.
  const picked = tempDir('lwc-reuse-');
  const inner = path.join(picked, NAME);
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'already-here.mp4'), 'x');
  settings.set({ cacheDir: picked });
  assert.equal(toolPaths.cacheDir(), inner);
  assert.deepEqual(fs.readdirSync(inner), ['already-here.mp4']);
});

test('isCacheFolder only matches the last segment', () => {
  // A folder that merely lives under one of these is not itself one.
  assert.equal(toolPaths.isCacheFolder(path.join('D:', 'Videos', NAME)), true);
  assert.equal(toolPaths.isCacheFolder(path.join('D:', NAME, 'Clips')), false);
  assert.equal(toolPaths.isCacheFolder(path.join('D:', 'Videos')), false);
  assert.equal(toolPaths.isCacheFolder(path.join('D:', 'My_LWClipper_cache')), false);
});

test('with nothing picked it falls back under Videos', () => {
  assert.equal(toolPaths.cacheDir(), path.join(FAKE_VIDEOS, NAME));
});

// ---- moving the cache when the folder setting changes ----

// A pair of real cache folders, the first one holding the files named.
function twoFolders(label, files) {
  const from = path.join(tempDir(label), NAME);
  const to = path.join(tempDir(label), NAME);
  fs.mkdirSync(from);
  fs.mkdirSync(to);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(from, name), body);
  }
  return { from, to };
}

test('moveCache carries the files over and takes the old folder with them', () => {
  const { from, to } = twoFolders('lwc-move-', { 'a.mp4': 'aaa', 'b.webm': 'bb' });
  assert.equal(toolPaths.moveCache(from, to), 2);
  assert.deepEqual(fs.readdirSync(to).sort(), ['a.mp4', 'b.webm']);
  assert.equal(fs.readFileSync(path.join(to, 'a.mp4'), 'utf8'), 'aaa');
  assert.equal(fs.existsSync(from), false, 'the emptied folder does not linger');
});

test('moveCache keeps the copy already at the destination', () => {
  // Names here are content keys, so the same name is the same clip. Carrying it
  // over would only overwrite a good file with an identical one.
  const { from, to } = twoFolders('lwc-dup-', { 'same.mp4': 'old' });
  fs.writeFileSync(path.join(to, 'same.mp4'), 'already there');
  assert.equal(toolPaths.moveCache(from, to), 0, 'nothing new arrived');
  assert.equal(fs.readFileSync(path.join(to, 'same.mp4'), 'utf8'), 'already there');
  assert.equal(fs.existsSync(from), false, 'and the old copy is not left behind');
});

test('moveCache leaves subfolders where they are, and the folder with them', () => {
  const { from, to } = twoFolders('lwc-sub-', { 'a.mp4': 'aaa' });
  fs.mkdirSync(path.join(from, 'something_else'));
  assert.equal(toolPaths.moveCache(from, to), 1);
  assert.deepEqual(fs.readdirSync(to), ['a.mp4']);
  assert.deepEqual(fs.readdirSync(from), ['something_else'], 'not emptied, so not removed');
});

test('moveCache does nothing when the folder did not actually change', () => {
  const { from } = twoFolders('lwc-same-', { 'a.mp4': 'aaa' });
  assert.equal(toolPaths.moveCache(from, from), 0);
  // Windows does not distinguish case, so neither does this.
  assert.equal(toolPaths.moveCache(from, from.toUpperCase()), 0);
  assert.deepEqual(fs.readdirSync(from), ['a.mp4'], 'still there, and still one copy');
});

test('moveCache shrugs at an old folder that was never created', () => {
  const { from, to } = twoFolders('lwc-gone-', {});
  fs.rmdirSync(from);
  assert.equal(toolPaths.moveCache(from, to), 0);
});

test('moveCache will not remove a folder that is not one of ours', () => {
  // from is only ever a cacheDir() result in the app, but this is the guard
  // that stands between an empty folder somebody picked and an rmdir.
  const plain = tempDir('lwc-plain-');
  const to = path.join(tempDir('lwc-plain-'), NAME);
  fs.mkdirSync(to);
  assert.equal(toolPaths.moveCache(plain, to), 0);
  assert.ok(fs.existsSync(plain), 'left standing');
});

test('cacheSizeBytes counts what is in the folder and survives an empty one', () => {
  const picked = tempDir('lwc-size-');
  settings.set({ cacheDir: picked });
  assert.equal(toolPaths.cacheSizeBytes(), 0);
  fs.writeFileSync(path.join(picked, NAME, 'a.mp4'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(picked, NAME, 'b.mp4'), 'y'.repeat(24));
  assert.equal(toolPaths.cacheSizeBytes(), 1024);
});
