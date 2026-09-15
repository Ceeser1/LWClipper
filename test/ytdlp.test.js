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
