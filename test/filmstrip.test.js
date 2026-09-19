'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// filmstrip.js requires 'electron' for the cache folder; stub it out so these
// tests run under plain `node --test`. A real temp folder rather than an empty
// string, because the sweep tests write files into it.
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'lwc-strip-'));
require.cache[require.resolve('electron')] = {
  exports: { app: { isPackaged: false, getPath: () => USER_DATA } },
};
const {
  tilesFor, gridFor, clearStrips, BASE_TILES, MAX_TILES, COLS,
} = require('../src/filmstrip');

const stripsDir = path.join(USER_DATA, 'filmstrips');

// What the renderer asks for: one thumbnail per tile-width of clip on screen.
// A 72px tile is what a 16:9 source gives at the 48px extraction height.
const want = (clipSeconds, pxPerSec, tileW = 72) =>
  Math.ceil((clipSeconds * pxPerSec) / tileW);

test('a clip that fits the frame keeps the base count', () => {
  // A ten minute clip fitted into 790px wants about eleven thumbnails, which is
  // well under the base, so nothing finer is extracted and every strip cached
  // at the base stays valid.
  assert.equal(tilesFor(want(600, 790 / 600)), BASE_TILES);
  assert.equal(tilesFor(0), BASE_TILES);
  assert.equal(tilesFor(1), BASE_TILES);
});

test('zooming in asks for more thumbnails, and gets them in doublings', () => {
  const fitted = tilesFor(want(600, 790 / 600));
  const zoomed = tilesFor(want(600, 4));
  assert.ok(zoomed > fitted, 'a zoomed clip must be extracted finer');
  // Every count is a doubling of the base, which is what makes a zoom gesture
  // land on entries that are already cached.
  for (const px of [1, 2, 3, 5, 8, 13, 21, 34]) {
    const n = tilesFor(want(600, px));
    assert.ok(n === MAX_TILES || Number.isInteger(Math.log2(n / BASE_TILES)),
      px + ' px/s asked for ' + n + ', which is not a doubling of the base');
  }
});

test('the count never runs away, however far the view zooms', () => {
  assert.equal(tilesFor(want(1800, 400)), MAX_TILES);
  assert.equal(tilesFor(1e9), MAX_TILES);
});

test('the count only ever rises with the density asked for', () => {
  let previous = 0;
  for (const px of [0.2, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 400]) {
    const n = tilesFor(want(600, px));
    assert.ok(n >= previous, px + ' px/s went back down to ' + n);
    previous = n;
  }
});

test('a small clip and a huge one at the same zoom want the same density', () => {
  // The point of keying on zoom rather than clip length: thirty minutes at
  // fit-to-width is not 900 thumbnails nobody can see, it is the same handful a
  // thirty second clip gets at the same pixels per second.
  const short = want(30, 790 / 30);
  const long = want(1800, 790 / 1800);
  assert.equal(short, long);
});

test('the grid holds every tile and is never wider than the column limit', () => {
  for (const tiles of [1, 5, 32, 64, 256, 1024]) {
    const { cols, rows } = gridFor(tiles);
    assert.ok(cols <= COLS, tiles + ' tiles asked for ' + cols + ' columns');
    assert.ok(cols * rows >= tiles, tiles + ' tiles do not fit ' + cols + 'x' + rows);
    // And no more than one row of slack, or the sheet carries dead pixels.
    assert.ok(cols * rows - tiles < cols, tiles + ' tiles waste a whole row');
  }
});

test('a single thumbnail is a one by one grid, not a wide empty strip', () => {
  assert.deepEqual(gridFor(1), { cols: 1, rows: 1 });
});

test('sweeping an empty or missing cache folder is not an error', () => {
  assert.equal(clearStrips(), 0);
});

test('sweeping removes the sheets and the folder with them', () => {
  fs.mkdirSync(stripsDir, { recursive: true });
  fs.writeFileSync(path.join(stripsDir, 'a.jpg'), 'x');
  fs.writeFileSync(path.join(stripsDir, 'a.json'), '{}');
  assert.equal(clearStrips(), 2);
  assert.equal(fs.existsSync(stripsDir), false);
});

// ---- the queue ----
//
// Two video layers on one timeline used to mean the first one's extraction was
// killed by the second one's, and the renderer recorded the killed request as
// "this file has no video stream" for good. These are about the queue that
// replaced the cancelling, without spawning anything.

const { enqueue } = require('../src/filmstrip');

test('queued jobs run one at a time and in order', async () => {
  const order = [];
  let running = 0;
  let peak = 0;
  const job = (name, ms) => () => new Promise((resolve) => {
    running += 1;
    peak = Math.max(peak, running);
    setTimeout(() => {
      running -= 1;
      order.push(name);
      resolve(name);
    }, ms);
  });
  // The slow one first, so finishing in order is the queue and not luck.
  const a = enqueue(job('a', 40));
  const b = enqueue(job('b', 1));
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(peak, 1, 'never two extractions at once');
});

test('a failed job does not stop the ones behind it', async () => {
  // This is the whole point: a killed or broken extraction must not take the
  // next layer's strip down with it.
  const dead = enqueue(() => Promise.reject(new Error('ffmpeg produced no thumbnails.')));
  await assert.rejects(dead, /no thumbnails/);
  assert.equal(await enqueue(() => Promise.resolve('after')), 'after');
});
