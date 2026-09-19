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

// ---- the claims folder, which Step 18 put inside the cache ----

// A claim file as the app writes one, with whatever name the test needs.
function claimIn(dir, id, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.lwcref'), body || '{}');
}

test('the claims folder is named inside the cache, and not made on the way past', () => {
  const picked = tempDir('lwc-claims-');
  settings.set({ cacheDir: picked });
  assert.equal(toolPaths.projectsDir(), path.join(picked, NAME, 'projects'));
  // Reading is the common case; an empty folder in the user's Videos before
  // anything has ever claimed is clutter with nothing behind it.
  assert.equal(fs.existsSync(toolPaths.projectsDir()), false);
});

test('moveCache takes the claims with it', () => {
  // Without this the folder is simply left behind at the old location and
  // nothing reports it: every project quietly loses its protection.
  const { from, to } = twoFolders('lwc-mc-', { 'a.mp4': 'aaa' });
  claimIn(path.join(from, 'projects'), 'holiday', '{"one":1}');
  assert.equal(toolPaths.moveCache(from, to), 2, 'the clip and the claim');
  assert.deepEqual(fs.readdirSync(path.join(to, 'projects')), ['holiday.lwcref']);
  assert.equal(fs.readFileSync(path.join(to, 'projects', 'holiday.lwcref'), 'utf8'), '{"one":1}');
  assert.equal(fs.existsSync(from), false, 'and the old folder goes, subtree and all');
});

test('a claim whose name is already taken at the destination is renamed, not dropped', () => {
  // Unlike a clip, where the name is a content key and a duplicate is the same
  // file. Two claims of the same name may be two different projects, and
  // dropping one would silently unprotect it.
  const { from, to } = twoFolders('lwc-mcc-', {});
  claimIn(path.join(from, 'projects'), 'holiday', '{"mine":true}');
  claimIn(path.join(to, 'projects'), 'holiday', '{"theirs":true}');
  assert.equal(toolPaths.moveCache(from, to), 1);
  assert.deepEqual(fs.readdirSync(path.join(to, 'projects')).sort(),
    ['holiday-2.lwcref', 'holiday.lwcref']);
  assert.equal(fs.readFileSync(path.join(to, 'projects', 'holiday.lwcref'), 'utf8'),
    '{"theirs":true}', 'the one already there is the one that keeps the name');
});

test('moveCache still leaves a folder that is not the claims one', () => {
  const { from, to } = twoFolders('lwc-mco-', {});
  fs.mkdirSync(path.join(from, 'something_else'));
  claimIn(path.join(from, 'projects'), 'x');
  assert.equal(toolPaths.moveCache(from, to), 1);
  assert.deepEqual(fs.readdirSync(from), ['something_else'], 'not ours, not touched');
});

// ---- clearing ----

test('clearCache takes the clips and leaves the claims', () => {
  // By rule now. This used to walk readdir and unlink everything, and the
  // folder survived only because unlink threw on it and the catch swallowed it.
  const picked = tempDir('lwc-clear-');
  settings.set({ cacheDir: picked });
  const dir = path.join(picked, NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mp4'), 'x'.repeat(500));
  claimIn(path.join(dir, 'projects'), 'holiday', '{"kept":true}');
  assert.equal(toolPaths.clearCache(), 500, 'only the clip counts as freed');
  assert.deepEqual(fs.readdirSync(dir), ['projects']);
  assert.equal(fs.readFileSync(path.join(dir, 'projects', 'holiday.lwcref'), 'utf8'),
    '{"kept":true}');
});

test('cacheFileNames lists the clips and not the folder among them', () => {
  const picked = tempDir('lwc-names-');
  settings.set({ cacheDir: picked });
  const dir = path.join(picked, NAME);
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mp4'), 'x');
  assert.deepEqual(toolPaths.cacheFileNames(), ['a.mp4']);
});

test('cacheSizeBytes counts the claims too, because they are in the folder', () => {
  const picked = tempDir('lwc-size2-');
  settings.set({ cacheDir: picked });
  const dir = path.join(picked, NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mp4'), 'x'.repeat(1000));
  claimIn(path.join(dir, 'projects'), 'holiday', 'y'.repeat(24));
  assert.equal(toolPaths.cacheSizeBytes(), 1024);
});

test('clearCache takes only the files it is given', () => {
  // Step 18. Which files those are is a question about projects, decided by
  // src/claim.js; this end only has to do as it is told.
  const picked = tempDir('lwc-clearsome-');
  settings.set({ cacheDir: picked });
  const dir = path.join(picked, NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kept.mp4'), 'x'.repeat(300));
  fs.writeFileSync(path.join(dir, 'gone.mp4'), 'x'.repeat(200));
  assert.equal(toolPaths.clearCache(['gone.mp4']), 200);
  assert.deepEqual(fs.readdirSync(dir), ['kept.mp4']);
});

test('an empty list takes nothing, which is not the same as taking everything', () => {
  // A real answer rather than a missing one: every cached file is claimed and
  // no project was ticked. Letting the empty list fall through to the default
  // would delete precisely what the modal was asked to protect.
  const picked = tempDir('lwc-clearnone-');
  settings.set({ cacheDir: picked });
  const dir = path.join(picked, NAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.mp4'), 'x'.repeat(100));
  assert.equal(toolPaths.clearCache([]), 0);
  assert.deepEqual(fs.readdirSync(dir), ['a.mp4']);
});
