'use strict';
// Strobe. A flash is the same picture on every frame it is on, so a frame's neighbours tell nothing there:
// the frames either side of a flash's start and end are the ones that count.
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const U = { under: true };
const k = (kind, more = {}) => ({ kind, shape: 'square', invert: false, box: FULL, ...more });
module.exports = [
  ['v55-strobe', [k('strobe')], [2, 3, 7, 8, 10, 30, 32, 33, 37, 38]],
  ['v55-strobe-mix', [k('strobe', { color: '#ff2060', mix: 50, speed: 70, duration: 50 })], [1, 2, 3, 4, 5, 6, 30, 31]],
  ['v55-strobe-fast', [k('strobe', { speed: 150, duration: 50, mix: 80 })], [1, 2, 3, 4, 5, 30, 31, 32]],
  ['v55-strobe-odd', [k('strobe', { speed: 33, duration: 41, color: '#102080' })], [8, 9, 10, 17, 18, 19, 27, 28, 40]],
  ['v55-strobe-keyed', [k('strobe', { speed: 50, keys: [{ t: 0, duration: 10, mix: 100 }, { t: 2, duration: 90, mix: 40 }] })], [1, 6, 7, 20, 31, 36, 40, 55]],
  ['v55-strobe-off-part', [k('strobe', { speed: 50, keys: [{ t: 0.5, duration: 50, mix: 0 }, { t: 1.5, duration: 50, mix: 100 }] })], [3, 13, 20, 31, 43, 49]],
  ['v55-strobe-stack', [k('sepia'), k('strobe', { mix: 70 }), k('vignette', { shape: 'circle', invert: true, amount: 60, soft: 0.2 })], [2, 3, 30, 33]],
  ['v55-strobe-keyed-under', [k('chromakey', { color: '#00ff00', tolerance: 40 }), k('strobe', { mix: 60 })], [2, 3, 30, 33], U],
];
