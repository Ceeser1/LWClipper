'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// waveform.js requires 'electron' for the cache folder; stub it out so these
// tests can run under plain `node --test` without Electron. A real temp folder
// rather than an empty string, because the sweep tests write files into it.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lwc-wave-'));
require.cache[require.resolve('electron')] = {
  exports: { app: { isPackaged: false, getPath: () => USER_DATA } },
};
const { bucketsFor, clearPeaks, BUCKETS, MAX_BUCKETS } = require('../src/waveform');

const peaksDir = path.join(USER_DATA, 'waveforms');

// What the renderer asks for: one bucket per pixel of the frame, on the clip's
// timeline rather than the track's. A 956 px frame is what the default window
// gives, and it is the width the chunky bars were measured at.
const want = (trackDur, clipDur, px = 956) => Math.ceil((trackDur / clipDur) * px);

test('a track no longer than the clip keeps the base count', () => {
  // The file's own audio, and any replacement that fits: the frame already has
  // more buckets than pixels, so nothing is gained by decoding finer, and every
  // waveform cached before this existed stays valid.
  assert.equal(bucketsFor(20, want(20, 20)), BUCKETS);
  assert.equal(bucketsFor(600, want(600, 600)), BUCKETS);
  assert.equal(bucketsFor(20, want(5, 20)), BUCKETS);
});

test('a replacement far longer than the clip is bucketed finer', () => {
  // The reported bug: 1600 buckets over a 200 s track leaves a 20 s clip with
  // 160 of them to fill 956 px, which drew bars about 6 px wide.
  const n = bucketsFor(200, want(200, 20));
  const visible = n * (20 / 200);
  assert.ok(visible >= 956, 'the visible share must cover the frame, got ' + visible);
  assert.ok(BUCKETS * (20 / 200) < 200, 'sanity: the old count did not');
});

test('the count doubles from the base rather than tracking the request', () => {
  // So that resizing the window keeps hitting a count that is already cached.
  assert.equal(bucketsFor(200, BUCKETS + 1), BUCKETS * 2);
  assert.equal(bucketsFor(200, BUCKETS * 2), BUCKETS * 2);
  assert.equal(bucketsFor(200, BUCKETS * 2 + 1), BUCKETS * 4);
});

test('an extreme ratio stops at the ceiling', () => {
  // An hour of audio against a five second clip would ask for 648000 buckets.
  assert.equal(bucketsFor(3600, want(3600, 5)), MAX_BUCKETS);
});

test('never more buckets than there are samples to fill them', () => {
  // A very short replacement on a shorter clip still asks for the base count,
  // but a tenth of a second of audio is only 800 samples at the decode rate.
  assert.equal(bucketsFor(0.1, want(0.1, 0.05)), 800);
});

test('the sweep takes every entry and the folder with them', () => {
  // Peaks are only re-read for a file being loaded, and the renderer holds the
  // loaded file's in memory, so none of this is worth keeping past a run.
  fs.mkdirSync(peaksDir, { recursive: true });
  for (const name of ['a.json', 'b.json', 'c.json']) {
    fs.writeFileSync(path.join(peaksDir, name), '{}');
  }
  assert.equal(clearPeaks(), 3);
  assert.equal(fs.existsSync(peaksDir), false);
});

test('sweeping a folder that was never created is not an error', () => {
  // The startup sweep runs before anything has been decoded, every time.
  assert.equal(fs.existsSync(peaksDir), false);
  assert.equal(clearPeaks(), 0);
});
