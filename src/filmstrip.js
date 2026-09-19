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

// The ceiling, and it is a real limit rather than a formality: past this the
// sheet is a 2300x1900 JPEG and the extraction pass is reading most of the
// file. A clip zoomed in past the density this affords repeats thumbnails
// rather than extracting more, which is the honest failure and is visible
// rather than slow. Extracting only the visible span at high density is the
// proper answer and is not built.
const MAX_TILES = 1024;

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

function cacheKeyFor(filePath, tiles) {
  const st = fs.statSync(filePath);
  return crypto.createHash('sha1')
    .update([filePath.toLowerCase(), st.size, Math.round(st.mtimeMs), tiles, TILE_HEIGHT].join('|'))
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

function extract(filePath, duration, tiles, dest) {
  return new Promise((resolve, reject) => {
    const ffmpeg = toolPaths.findFfmpeg();
    if (!ffmpeg) return reject(new Error('ffmpeg.exe was not found alongside the app.'));
    const { cols, rows } = gridFor(tiles);

    // fps rather than a seek per thumbnail: one pass decoding forward beats N
    // passes each seeking to a keyframe and decoding from there. The rate is
    // tiles per second of source, so thumbnail i is the frame at i*duration
    // /tiles and covers the span from there to the next one.
    //
    // -an because there is no reason to decode the audio, and tile's own
    // padding is left at zero so the grid arithmetic is a plain divide.
    const rate = tiles / Math.max(duration, 0.001);
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', filePath,
      '-an',
      '-vf', 'fps=' + rate.toFixed(6) + ',scale=-2:' + TILE_HEIGHT
        + ',tile=' + cols + 'x' + rows + ':padding=0:margin=0',
      '-frames:v', '1', '-qscale:v', '4',
      dest,
    ], { windowsHide: true });
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
 * `want` is how many thumbnails the drawing would like across the whole source;
 * the number actually extracted comes back, along with the geometry needed to
 * pick a tile out of the sheet. Returns null for a file with no video stream,
 * which is not an error: an audio layer draws a waveform instead.
 */
async function stripFor(filePath, duration, want = 0) {
  if (!(duration > 0)) return null;
  const tiles = tilesFor(want);
  const key = cacheKeyFor(filePath, tiles);
  const sheet = path.join(stripDir(), key + '.jpg');
  const meta = path.join(stripDir(), key + '.json');

  try {
    const cached = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (cached && cached.tiles === tiles && fs.existsSync(sheet)) {
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
    return extract(filePath, duration, tiles, sheet);
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
    interval: duration / tiles,
    duration,
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
  gridFor,
  TILE_HEIGHT,
  BASE_TILES,
  MAX_TILES,
  COLS,
};
