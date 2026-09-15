'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const toolPaths = require('./toolPaths');

// The base number of min/max pairs the renderer gets. Wide enough to look like a
// waveform at any window size this app allows, small enough that the whole thing is a
// few tens of KB over IPC. The raw decode is far bigger (a 11 minute video is
// about 10 MB of PCM at this rate), so it is bucketed as it streams in and
// never held in memory whole.
const BUCKETS = 1600;
// A replacement track is bucketed over its own length but drawn on the clip's
// timeline, so one ten times longer than the clip has only a tenth of its
// buckets to fill the frame with, and the bars come out wide and blocky. The
// renderer asks for the resolution it needs and the count rises to meet it, as
// far as this ceiling: past that the JSON costs more than the detail is worth.
const MAX_BUCKETS = 25600;
const RATE = 8000;

// Not in the video cache: peaks are derived data the user never asked to keep,
// and `clearCache()` deletes files rather than recursing, so a subfolder there
// would survive "Clear cache" forever while still being counted in its size.
function peaksPath() {
  return path.join(app.getPath('userData'), 'waveforms');
}

function peaksDir() {
  const dir = peaksPath();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Size and mtime are in the key so that a file replaced at the same path is
// re-analysed rather than served a stale waveform, and the bucket count so that
// a coarse entry is not served where a finer one was asked for.
function cachePathFor(filePath, buckets) {
  const st = fs.statSync(filePath);
  const key = crypto.createHash('sha1')
    .update([filePath.toLowerCase(), st.size, Math.round(st.mtimeMs), buckets, RATE].join('|'))
    .digest('hex');
  return path.join(peaksDir(), key + '.json');
}

// Only one analysis is ever useful at a time: loading another file makes the
// one in flight pointless, so it gets killed rather than left to finish.
let currentChild = null;

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

// An entry is only ever read again for a file that is being loaded, and the
// renderer keeps the peaks of the loaded file in memory, so nothing in here
// survives usefully past a run of the app. Swept at both ends: on quit for the
// normal case, and at startup because a crash or a kill from Task Manager never
// reaches the quit hook. Returns how many entries went.
function clearPeaks() {
  abort();
  const dir = peaksPath();
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

function decodePeaks(filePath, duration, buckets) {
  return new Promise((resolve, reject) => {
    const ffmpeg = toolPaths.findFfmpeg();
    if (!ffmpeg) return reject(new Error('ffmpeg.exe was not found alongside the app.'));

    const totalSamples = Math.max(1, Math.round(duration * RATE));
    const perBucket = Math.max(1, Math.ceil(totalSamples / buckets));
    const mins = new Float32Array(buckets).fill(0);
    const maxs = new Float32Array(buckets).fill(0);
    const seen = new Uint8Array(buckets);

    // -vn is what makes this cheap: the video stream is never decoded.
    const child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-i', filePath,
      '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-',
    ], { windowsHide: true });
    currentChild = child;

    let index = 0;
    let odd = null; // a sample split across two chunks
    const stderr = [];

    child.stdout.on('data', (chunk) => {
      let buf = chunk;
      if (odd) {
        buf = Buffer.concat([odd, chunk]);
        odd = null;
      }
      const usable = buf.length - (buf.length % 2);
      if (usable < buf.length) odd = buf.subarray(usable);

      for (let i = 0; i < usable; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        const b = Math.min(buckets - 1, Math.floor(index / perBucket));
        if (!seen[b]) {
          seen[b] = 1;
          mins[b] = v;
          maxs[b] = v;
        } else {
          if (v < mins[b]) mins[b] = v;
          if (v > maxs[b]) maxs[b] = v;
        }
        index += 1;
      }
    });

    child.stderr.on('data', (d) => stderr.push(String(d)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (currentChild === child) currentChild = null;
      if (code !== 0 && index === 0) {
        return reject(new Error(stderr.join('').trim() || 'ffmpeg could not read any audio.'));
      }
      // Flat, rounded and interleaved min,max: JSON of a few thousand short
      // numbers is a fraction of the size of an array of objects.
      const flat = new Array(buckets * 2);
      for (let b = 0; b < buckets; b += 1) {
        flat[b * 2] = Math.round(mins[b] * 1000) / 1000;
        flat[b * 2 + 1] = Math.round(maxs[b] * 1000) / 1000;
      }
      resolve(flat);
    });
  });
}

// The count doubles up from the base rather than following the request exactly,
// so that resizing the window keeps landing on a count that is already cached
// instead of asking for a slightly different one every few pixels. It can never
// ask for more buckets than there are samples to fill them.
function bucketsFor(duration, want) {
  const samples = Math.max(1, Math.round(duration * RATE));
  let n = BUCKETS;
  while (n < want && n < MAX_BUCKETS) n *= 2;
  return Math.min(n, MAX_BUCKETS, samples);
}

/**
 * Peaks for a media file, from cache when possible. want is how many buckets the
 * drawing would like; the count actually used comes back with the peaks. Returns
 * { peaks: number[], buckets } or throws when there is no readable audio.
 */
async function peaksFor(filePath, duration, want = 0) {
  abort();
  const buckets = bucketsFor(duration, want);
  const cacheFile = cachePathFor(filePath, buckets);
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Array.isArray(cached.peaks) && cached.peaks.length === buckets * 2) {
      return { peaks: cached.peaks, buckets, cached: true };
    }
  } catch {
    // No usable cache entry; fall through and decode.
  }

  const peaks = await decodePeaks(filePath, duration, buckets);
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ buckets, rate: RATE, peaks }));
  } catch {
    // A failed cache write must not fail the analysis itself.
  }
  return { peaks, buckets, cached: false };
}

module.exports = { peaksFor, abort, clearPeaks, bucketsFor, BUCKETS, MAX_BUCKETS };
