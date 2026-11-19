'use strict';

// Shared by the harness scripts: where things are, and the small helpers the
// case lists are written with.

const path = require('path');

/** The repo, with forward slashes: what ffmpeg and the app's window both take. */
const ROOT = path.resolve(__dirname, '..', '..').split(path.sep).join('/');
/** Everything the harness makes (test media, a profile, exports) goes here. Never in git. */
const W = ROOT + '/dev/harness/work';
/** The same folder as Windows writes it, for the cases that are about backslashes. */
const WB = W.split('/').join('\\');
const FFMPEG = ROOT + '/tools/ffmpeg.exe';
const FFPROBE = ROOT + '/tools/ffprobe.exe';
const PORT = Number(process.env.CDP_PORT) || 9442;

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const PART = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 };
/** A VFX of one kind on the whole picture, with whatever else is given. */
const k = (kind, more = {}) => ({ kind, shape: 'square', invert: false, box: FULL, ...more });

/**
 * The lists of cases. `src` is the clip on the track, `end` how many seconds
 * are exported, `under` the clip laid on a track below for the cases that ask
 * for one.
 */
const SUITES = {
  vfx: { src: 'src709.mp4', end: 2, under: 'nat.mp4' },
  long: { src: 'long1080.mp4', end: 6, under: 'nat.mp4' },
  warps: { src: 'src709.mp4', end: 2, under: 'nat.mp4' },
  curves: { src: 'src709.mp4', end: 2, under: 'nat.mp4' },
  keys: { src: 'green.mp4', end: 2, under: 'nat.mp4' },
  strobe: { src: 'src709.mp4', end: 2, under: 'nat.mp4' },
  echo: { src: 'moving.mp4', end: 2, under: 'nat.mp4' },
  gravity: { src: 'g709.mp4', end: 5, under: 'nat.mp4' },
};

module.exports = { ROOT, W, WB, FFMPEG, FFPROBE, PORT, FULL, PART, k, SUITES };
