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
  tilesFor, gridFor, clearStrips, chunksFor, maxChunks, maxDensityFor, planFor,
  BASE_TILES, MAX_TILES, MAX_DENSITY, COLS,
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

// ---- V2.1, 21d. The windowed sheet ----
//
// Past the point where the whole source stops fitting in one sheet, a sheet
// covers a window of the source instead of all of it. These are about the
// arithmetic that decides which window; the drawing that holds several of them
// at once is the renderer's half.

// The finest the timeline ever zooms, from MAX_PX_PER_SEC in timelineView.js.
const FINEST = 400;

test('a clip the old cap was enough for is still one sheet across the whole of it', () => {
  // The degenerate case has to be the case it replaced, or every short clip
  // changes behaviour for a problem it never had. Ten minutes fitted, and
  // three minutes at the finest zoom the timeline offers.
  //
  // Three minutes and not four: the crossing point is where the finest zoom
  // first asks for more than one sheet holds, which is 184 seconds against the
  // 72px thumbnail assumed here and 218 against the 85px one a 16:9 source
  // really gives at this extraction height.
  for (const [seconds, px] of [[600, 790 / 600], [30, FINEST], [60, FINEST], [180, FINEST]]) {
    const w = want(seconds, px);
    const plan = planFor(w, seconds, seconds / 2);
    assert.equal(plan.chunks, 1, seconds + 's at ' + px + 'px/s was cut into ' + plan.chunks);
    assert.equal(plan.index, 0);
    assert.equal(plan.start, 0);
    assert.equal(plan.span, seconds);
    assert.equal(plan.tiles, tilesFor(w), 'and asks for exactly what it always asked for');
  }
});

test('a long clip zoomed in is cut into windows rather than repeating thumbnails', () => {
  // Thirty minutes at the finest zoom wants about 10000 thumbnails. The old
  // answer was 1024 across the whole clip, so every one was drawn nine times.
  const seconds = 1800;
  const w = want(seconds, FINEST);
  const plan = planFor(w, seconds, 0);
  assert.ok(plan.chunks > 1, 'thirty minutes at ' + FINEST + 'px/s still fits one sheet');
  assert.ok(plan.chunks * plan.tiles >= w,
    'the windows together hold ' + plan.chunks * plan.tiles + ' against the ' + w + ' asked for');
  assert.ok(plan.tiles <= MAX_TILES, 'and no single sheet went past the sheet limit');
});

test('the window count only ever doubles', () => {
  // Same reason tilesFor doubles: a zoom gesture asks for a slightly different
  // number every few pixels, and a count that followed the request exactly
  // would miss the cache on every one of them.
  for (const px of [1, 2, 4, 8, 16, 32, 64, 128, 256, FINEST]) {
    const n = chunksFor(want(1800, px), 1800);
    assert.ok(Number.isInteger(Math.log2(n)), px + ' px/s asked for ' + n + ' windows');
  }
});

test('the windows tile the source with no gap and no overlap', () => {
  const seconds = 1800;
  const w = want(seconds, FINEST);
  const chunks = chunksFor(w, seconds);
  let expected = 0;
  for (let i = 0; i < chunks; i += 1) {
    // Asked for from the middle of the window, which is what a view looking
    // there would pass.
    const span = seconds / chunks;
    const plan = planFor(w, seconds, i * span + span / 2);
    assert.equal(plan.index, i, 'the middle of window ' + i + ' landed in ' + plan.index);
    assert.ok(Math.abs(plan.start - expected) < 1e-9,
      'window ' + i + ' starts at ' + plan.start + ' where the last one ended at ' + expected);
    expected = plan.start + plan.span;
  }
  assert.ok(Math.abs(expected - seconds) < 1e-9,
    'the last window ends at ' + expected + ' and the clip at ' + seconds);
});

test('a coarser window contains the finer ones inside it', () => {
  // The guarantee the whole of the renderer's half rests on: a sheet from a
  // coarser level always covers whatever a finer one covers, so the coarse one
  // can keep being drawn while the fine one is fetched. It holds because the
  // counts are powers of two, so every boundary at one level is a boundary at
  // the next.
  const seconds = 1800;
  for (const at of [0, 17, 480, 901, 1799.9]) {
    let previous = null;
    for (const px of [1, 8, 64, 200, FINEST]) {
      const plan = planFor(want(seconds, px), seconds, at);
      if (previous) {
        assert.ok(plan.start >= previous.start - 1e-9
          && plan.start + plan.span <= previous.start + previous.span + 1e-9,
          'at ' + at + 's the finer window ' + plan.start + '+' + plan.span
          + ' is not inside ' + previous.start + '+' + previous.span);
      }
      previous = plan;
    }
  }
});

test('a window is never shorter than the density ceiling allows', () => {
  // Or a window would hold more thumbnails than the source has frames in it.
  for (const seconds of [70, 200, 600, 1800, 7200]) {
    const plan = planFor(1e9, seconds, 0);
    assert.ok(plan.tiles / plan.span <= MAX_DENSITY,
      seconds + 's went to ' + (plan.tiles / plan.span).toFixed(1) + ' thumbnails a second');
    assert.equal(maxChunks(seconds) * MAX_TILES / seconds, maxDensityFor(seconds),
      'and the ceiling handed back is the one being kept to');
  }
});

test('what comes back is at least as dense as what was asked for, up to the ceiling', () => {
  for (const seconds of [30, 300, 1800]) {
    for (const px of [0.5, 4, 32, FINEST]) {
      const w = want(seconds, px);
      const plan = planFor(w, seconds, seconds / 3);
      const asked = Math.min(w / seconds, maxDensityFor(seconds));
      assert.ok(plan.tiles / plan.span >= asked - 1e-9,
        seconds + 's at ' + px + 'px/s wanted ' + asked.toFixed(2)
        + ' a second and got ' + (plan.tiles / plan.span).toFixed(2));
    }
  }
});

test('a time past either end of the clip still names a window that exists', () => {
  const seconds = 1800;
  const w = want(seconds, FINEST);
  const chunks = chunksFor(w, seconds);
  for (const at of [-50, 0, seconds, seconds + 500, NaN, Infinity]) {
    const plan = planFor(w, seconds, at);
    assert.ok(plan.index >= 0 && plan.index < chunks, at + ' asked for window ' + plan.index);
  }
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
