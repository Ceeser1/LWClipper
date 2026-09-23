'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { app } = require('electron');
const toolPaths = require('./toolPaths');

// Thumbnails for a timeline clip, built and cached the way waveform.js builds
// peaks: derived data nobody asked to keep, kept under userData where "Clear
// cache" deliberately cannot reach it, keyed on the file's size and mtime so a
// file replaced at the same path is re-extracted rather than served a stale
// strip.
//
// One ffmpeg pass produces one JPEG holding every thumbnail in a grid. A sheet
// rather than N files because a filmstrip is drawn as a whole: one image the
// renderer can drawImage sub-rectangles out of costs one load and one decode,
// where 200 separate files cost 200 of each.

// How tall a thumbnail is extracted. The clip bar in a 48px row has about 34px
// of usable height; extracting at 48 leaves room for the row to grow later
// without re-extracting everything, and costs almost nothing at JPEG.
const TILE_HEIGHT = 48;

// Thumbnails across the whole source at the coarsest useful density, doubling
// from there as the view zooms in.
const BASE_TILES = 32;

// The most thumbnails one sheet holds. Past this the JPEG is about 2300x1900,
// which is as large as a sheet should get for something a canvas decodes on the
// way to drawing one row of it.
//
// Step 21d. It is no longer the ceiling on density, only on one sheet: past it
// the sheet stops covering the whole source and covers a window of it instead.
const MAX_TILES = 1024;

// Thumbnails per second of source that no view could use, which is what bounds
// the window count. Past 30 a window holds more tiles than the source has
// frames, and the strip cannot show more than one per thumbnail-width of screen
// anyway: the finest zoom is 400px per second against an 85px thumbnail, which
// is under five. This leaves a window no shorter than about 34 seconds.
const MAX_DENSITY = 30;

// Sheet columns. Keeps the JPEG within sizes every canvas implementation is
// happy to decode, while keeping the grid arithmetic trivial.
const COLS = 32;

function stripPath() {
  return path.join(app.getPath('userData'), 'filmstrips');
}

function stripDir() {
  const dir = stripPath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The window is in the key as well as the tile count, or the second window of a
// clip would be served the first one's sheet.
function cacheKeyFor(filePath, plan) {
  const st = fs.statSync(filePath);
  return crypto.createHash('sha1')
    .update([
      filePath.toLowerCase(), st.size, Math.round(st.mtimeMs),
      plan.tiles, plan.chunks, plan.index, TILE_HEIGHT,
    ].join('|'))
    .digest('hex');
}

// One extraction at a time. They are all reading video off the same disk and
// two at once is slower than two in a row, so they queue.
//
// Queue, not cancel. An earlier attempt cancelled whatever was in flight on the
// way in, on the reasoning that a request from an older zoom level is pointless
// by the time a newer one arrives. That is true of the same file and only of
// the same file: with two video layers on a timeline, the second layer's
// request killed the first layer's, which came back as "ffmpeg produced no
// thumbnails", which the renderer reads as "this file has no video stream" and
// records for good. The top layer showed a plain bar for the rest of the
// session. Only a newer request for the same file supersedes an older one, and
// there it is right, because the coarse sheet is about to be thrown away.
let currentChild = null;
let currentFile = null;
let queue = Promise.resolve();

function abort() {
  if (currentChild) {
    try {
      currentChild.kill();
    } catch {
      // Already gone; nothing to clean up.
    }
    currentChild = null;
  }
}

/**
 * Run one extraction after whatever is already queued.
 *
 * The queue carries on past a failure, which is why the same job is handed to
 * both arms of then, and what the caller waits on is not the queue itself:
 * handing back the chained promise would record an unhandled rejection against
 * every extraction that ever failed.
 */
function enqueue(job) {
  const mine = queue.then(job, job);
  queue = mine.catch(() => {});
  return mine;
}

// Swept at both ends like the waveform cache: on quit for the normal case, and
// at startup because a crash never reaches the quit hook. Returns how many
// files went.
function clearStrips() {
  abort();
  queue = Promise.resolve();
  const dir = stripPath();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0; // Never created, or userData is not reachable.
  }
  let removed = 0;
  for (const name of names) {
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      // Still open; the rest of the sweep carries on without it.
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // Something survived, so the folder is not empty. Leave it.
  }
  return removed;
}

/**
 * How many thumbnails to extract for a clip that would like `want` of them.
 *
 * Doubling from the base rather than following the request exactly is the same
 * trick waveform.js uses on bucket counts: a zoom gesture asks for a slightly
 * different number every few pixels, and without this every one of them would
 * miss the cache and start another extraction.
 */
function tilesFor(want) {
  let n = BASE_TILES;
  while (n < want && n < MAX_TILES) n *= 2;
  return Math.min(n, MAX_TILES);
}

/**
 * The most windows a source of this length is ever cut into.
 *
 * A power of two, so that every boundary at one level is also a boundary at the
 * next: that is what makes a coarser sheet a strict ancestor of a finer one,
 * and what lets the coarse one keep being drawn while the fine one is fetched.
 */
function maxChunks(duration) {
  if (!(duration > 0)) return 1;
  const ceiling = Math.floor((duration * MAX_DENSITY) / MAX_TILES);
  let n = 1;
  while (n * 2 <= ceiling) n *= 2;
  return n;
}

/**
 * How many windows to cut the source into for a view that wants `want`
 * thumbnails across the whole of it.
 *
 * One while the whole source still fits in a sheet, which is every clip of
 * about three minutes or less even at the finest zoom, so nothing short ever
 * leaves the path it was on before this existed.
 */
function chunksFor(want, duration) {
  const most = maxChunks(duration);
  let n = 1;
  while (n * MAX_TILES < want && n < most) n *= 2;
  return n;
}

/**
 * The finest density this source can be extracted at, in thumbnails per second.
 *
 * Handed back to the caller because a view zoomed past it would otherwise ask
 * for something finer on every frame, get the same sheet back, and ask again.
 */
function maxDensityFor(duration) {
  if (!(duration > 0)) return 0;
  return (maxChunks(duration) * MAX_TILES) / duration;
}

/**
 * Which sheet answers a view that wants `want` thumbnails across the source and
 * is looking at second `at` of it.
 *
 * duration / chunks divides evenly, so every window is the same length: there is
 * no short last one and no half-filled grid.
 */
function planFor(want, duration, at = 0) {
  const chunks = chunksFor(want, duration);
  const span = duration / chunks;
  const seconds = Number.isFinite(at) ? Math.max(0, at) : 0;
  const index = Math.min(chunks - 1, Math.floor(seconds / span));
  return {
    chunks,
    index,
    span,
    start: index * span,
    tiles: tilesFor(Math.ceil(Math.max(0, want || 0) / chunks)),
  };
}

/** The grid a given number of thumbnails is laid out in. */
function gridFor(tiles) {
  const cols = Math.min(COLS, Math.max(1, tiles));
  return { cols, rows: Math.ceil(tiles / cols) };
}

function sheetSize(file) {
  const ffprobe = toolPaths.findFfprobe();
  if (!ffprobe) return null;
  try {
    const out = execFileSync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file,
    ], { encoding: 'utf8', windowsHide: true }).trim();
    const [w, h] = out.split('x').map(Number);
    if (!(w > 0) || !(h > 0)) return null;
    return { width: w, height: h };
  } catch {
    return null;
  }
}

function extract(filePath, plan, dest) {
  return new Promise((resolve, reject) => {
    const ffmpeg = toolPaths.findFfmpeg();
    if (!ffmpeg) return reject(new Error('ffmpeg.exe was not found alongside the app.'));
    const { cols, rows } = gridFor(plan.tiles);

    // fps rather than a seek per thumbnail: one pass decoding forward beats N
    // passes each seeking to a keyframe and decoding from there. The rate is
    // tiles per second of the window, so thumbnail i is the frame at
    // start + i*span/tiles and covers from there to the next one.
    //
    // -an because there is no reason to decode the audio, and tile's own
    // padding is left at zero so the grid arithmetic is a plain divide.
    const rate = plan.tiles / Math.max(plan.span, 0.001);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
    // Step 21d. Seeking before -i is what makes a window cost a window rather
    // than a file: ffmpeg jumps to the keyframe before the start and decodes
    // from there, so the deeper the zoom the less there is to read. Left off
    // the whole-clip sheet entirely, so that one stays the call it has always
    // been rather than the same call with two arguments that do nothing.
    if (plan.chunks > 1) args.push('-ss', plan.start.toFixed(3));
    args.push('-i', filePath);
    if (plan.chunks > 1) args.push('-t', plan.span.toFixed(3));
    args.push(
      '-an',
      '-vf', 'fps=' + rate.toFixed(6) + ',scale=-2:' + TILE_HEIGHT
        + ',tile=' + cols + 'x' + rows + ':padding=0:margin=0',
      '-frames:v', '1', '-qscale:v', '4',
      dest,
    );
    const child = spawn(ffmpeg, args, { windowsHide: true });
    currentChild = child;

    const stderr = [];
    child.stderr.on('data', (d) => stderr.push(String(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (currentChild === child) currentChild = null;
      if (code !== 0 || !fs.existsSync(dest)) {
        return reject(new Error(stderr.join('').trim() || 'ffmpeg produced no thumbnails.'));
      }
      resolve();
    });
  });
}

/**
 * A filmstrip for a media file, from cache when possible.
 *
 * `want` is how many thumbnails the drawing would like across the whole source
 * and `at` is the second of the source it is looking at. Below the point where
 * the whole source stops fitting in one sheet, `at` does nothing and the sheet
 * covers everything; past it the sheet covers the window holding `at`, and what
 * comes back says which window that was. Either way the reply carries the
 * geometry needed to pick a tile out of the sheet. Returns null for a file with
 * no video stream, which is not an error: an audio layer draws a waveform.
 */
async function stripFor(filePath, duration, want = 0, at = 0) {
  if (!(duration > 0)) return null;
  const plan = planFor(want, duration, at);
  const tiles = plan.tiles;
  const key = cacheKeyFor(filePath, plan);
  const sheet = path.join(stripDir(), key + '.jpg');
  const meta = path.join(stripDir(), key + '.json');

  try {
    const cached = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (cached && cached.tiles === tiles && cached.chunks === plan.chunks
      && cached.index === plan.index && fs.existsSync(sheet)) {
      return { ...cached, file: sheet, cached: true };
    }
  } catch {
    // No usable cache entry; fall through and extract.
  }

  // A newer sheet of this same file makes the one being built pointless. Any
  // other file is another layer's strip and is wanted as much as this one.
  if (currentChild && currentFile === filePath) abort();
  await enqueue(() => {
    currentFile = filePath;
    return extract(filePath, plan, sheet);
  });
  const size = sheetSize(sheet);
  if (!size) {
    try {
      fs.unlinkSync(sheet);
    } catch {
      // Nothing to clean up, or it is still open.
    }
    throw new Error('the thumbnail sheet could not be measured.');
  }

  const { cols, rows } = gridFor(tiles);
  const info = {
    tiles,
    cols,
    rows,
    // Divided out rather than assumed: scale=-2 rounds the width to an even
    // number, so the tile is whatever that rounding produced and not what the
    // source aspect says it should be.
    tileWidth: Math.round(size.width / cols),
    tileHeight: Math.round(size.height / rows),
    // Seconds of source each thumbnail stands for.
    interval: plan.span / tiles,
    duration,
    // Step 21d. Where this sheet sits in the source, so a caller holding
    // several of them can tell which one covers the second it is drawing and
    // which of those is the finest. tiles / span is that density.
    chunks: plan.chunks,
    index: plan.index,
    start: plan.start,
    span: plan.span,
    maxDensity: maxDensityFor(duration),
  };
  try {
    fs.writeFileSync(meta, JSON.stringify(info));
  } catch {
    // A failed cache write must not fail the extraction itself.
  }
  return { ...info, file: sheet, cached: false };
}

module.exports = {
  stripFor,
  abort,
  enqueue,
  clearStrips,
  tilesFor,
  chunksFor,
  maxChunks,
  maxDensityFor,
  planFor,
  gridFor,
  TILE_HEIGHT,
  BASE_TILES,
  MAX_TILES,
  MAX_DENSITY,
  COLS,
};
