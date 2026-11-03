'use strict';

const test = require('node:test');
const assert = require('node:assert');

// Safe to require outside Electron: this only reaches the pure helpers, and
// toolPaths touches `app` inside its functions rather than at module load.
const ytdlp = require('../src/ytdlp');

test('normalizeUrl passes through non-YouTube links untouched', () => {
  assert.equal(ytdlp.normalizeUrl('https://vimeo.com/76979871'), 'https://vimeo.com/76979871');
  assert.equal(ytdlp.normalizeUrl('https://www.twitch.tv/videos/123'), 'https://www.twitch.tv/videos/123');
});

test('normalizeUrl supplies a missing scheme and trims quoting', () => {
  assert.equal(ytdlp.normalizeUrl('vimeo.com/76979871'), 'https://vimeo.com/76979871');
  assert.equal(ytdlp.normalizeUrl('  "https://vimeo.com/1"  '), 'https://vimeo.com/1');
});

test('normalizeUrl rejects what is not an http link', () => {
  for (const bad of ['', '   ', 'file:///C:/secret.txt', 'javascript:alert(1)', 'not a url at all']) {
    assert.equal(ytdlp.normalizeUrl(bad), null, JSON.stringify(bad));
  }
});

test('cacheKeyFor prefers a YouTube id when there is one', () => {
  assert.equal(ytdlp.cacheKeyFor({ id: 'other', extractor: 'vimeo' }, 'dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
});

test('cacheKeyFor folds in the extractor so sites cannot collide', () => {
  const a = ytdlp.cacheKeyFor({ id: '123', extractor_key: 'Vimeo' }, null);
  const b = ytdlp.cacheKeyFor({ id: '123', extractor_key: 'Twitch' }, null);
  assert.equal(a, 'Vimeo-123');
  assert.notEqual(a, b);
});

test('cacheKeyFor scrubs characters that cannot be in a filename', () => {
  const key = ytdlp.cacheKeyFor({ id: 'a/b:c*d?e', extractor_key: 'Some Site' }, null);
  assert.ok(!/[^A-Za-z0-9_-]/.test(key), 'unsafe characters survived: ' + key);
});

test('cacheKeyFor stays within a sane filename length', () => {
  const key = ytdlp.cacheKeyFor({ id: 'x'.repeat(500), extractor_key: 'Site' }, null);
  assert.ok(key.length <= 80, 'key was ' + key.length + ' chars');
});

test('cookieArgs stays out of the way when cookies are off', () => {
  for (const off of [null, undefined, {}, { browser: '' }]) {
    assert.deepEqual(ytdlp.cookieArgs(off), [], JSON.stringify(off));
  }
});

test('cookieArgs builds the flag for a supported browser', () => {
  assert.deepEqual(ytdlp.cookieArgs({ browser: 'firefox' }), ['--cookies-from-browser', 'firefox']);
  assert.deepEqual(ytdlp.cookieArgs({ browser: 'FireFox' }), ['--cookies-from-browser', 'firefox']);
});

test('cookieArgs refuses anything not on the allowlist', () => {
  // The value arrives from the renderer and becomes a command line argument,
  // so an unknown string must never be forwarded.
  for (const bad of ['netscape', '--rm-rf', 'firefox; echo hi', '../../etc']) {
    assert.deepEqual(ytdlp.cookieArgs({ browser: bad }), [], bad);
  }
});

// ---- a merge left under its temporary name ----

const fs = require('fs');
const os = require('os');
const path = require('path');

const STUCK = "ERROR: [WinError 32] The process cannot access the file because it is being used by another process: "
  + "'C:\\cache\\vid.1080p.temp.mp4' -> 'C:\\cache\\vid.1080p.mp4'";

function stuckDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwc-merge-'));
  for (const [name, text] of [['vid.1080p.temp.mp4', 'merged'], ['vid.1080p.f137.mp4', 'v'],
    ['vid.1080p.f140.m4a', 'a'], ['other.1080p.f137.mp4', 'keep'], ['vid.720p.mp4', 'keep']]) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('a refused rename is tried again until it goes, and only its own parts are cleared', async () => {
  const dir = stuckDir();
  let tries = 0;
  const statuses = [];
  const final = await ytdlp.finishStuckMerge(dir, 'vid.1080p', STUCK, (f, s) => statuses.push(s), {
    sleep: async () => {},
    rename: (a, b) => {
      tries += 1;
      if (tries < 4) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      fs.renameSync(a, b);
    },
  });
  assert.equal(final, path.join(dir, 'vid.1080p.mp4'));
  assert.equal(tries, 4);
  assert.equal(fs.readFileSync(final, 'utf8'), 'merged');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['other.1080p.f137.mp4', 'vid.1080p.mp4', 'vid.720p.mp4']);
  assert.equal(statuses.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('any other failure is left as a failure', async () => {
  const dir = stuckDir();
  assert.equal(await ytdlp.finishStuckMerge(dir, 'vid.1080p', 'ERROR: HTTP Error 403: Forbidden', null), null);
  // WinError 32 about some other file is not this.
  assert.equal(await ytdlp.finishStuckMerge(dir, 'vid.720p', STUCK, null), null);
  assert.ok(fs.existsSync(path.join(dir, 'vid.1080p.f137.mp4')), 'nothing deleted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no temporary file on disk, nothing to finish', async () => {
  const dir = stuckDir();
  fs.rmSync(path.join(dir, 'vid.1080p.temp.mp4'));
  assert.equal(await ytdlp.finishStuckMerge(dir, 'vid.1080p', STUCK, null), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a file never released gives up after the wait, and keeps every file', async () => {
  const dir = stuckDir();
  await assert.rejects(ytdlp.finishStuckMerge(dir, 'vid.1080p', STUCK, null, {
    waitMs: 0,
    sleep: async () => {},
    rename: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
  }));
  assert.equal(fs.readdirSync(dir).length, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a cancel stops the waiting', async () => {
  const dir = stuckDir();
  const token = { cancelled: false };
  let tries = 0;
  const out = await ytdlp.finishStuckMerge(dir, 'vid.1080p', STUCK, null, {
    cancelToken: token,
    sleep: async () => { token.cancelled = true; },
    rename: () => { tries += 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
  });
  assert.equal(out, null);
  assert.equal(tries, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
