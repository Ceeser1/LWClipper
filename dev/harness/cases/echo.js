'use strict';
// Echo. The test bars hardly move, so most cases run on moving.mp4, a bar sliding across.
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const U = { under: true };
const k = (kind, more = {}) => ({ kind, shape: 'square', invert: false, box: FULL, ...more });
module.exports = [
  ['v551-none', [], [30]],
  ['v551-echo', [k('echo')], [1, 2, 5, 13, 30, 45]],
  ['v551-echo-many', [k('echo', { copies: 5, gap: 2, decay: 80 })], [3, 11, 30, 50]],
  ['v551-echo-far', [k('echo', { copies: 2, gap: 10, decay: 100 })], [5, 12, 25, 40]],
  ['v551-echo-one', [k('echo', { copies: 1, gap: 1, decay: 100 })], [1, 2, 30]],
  ['v551-echo-mix', [k('echo', { mix: 50 })], [13, 30]],
  ['v551-echo-keymix', [k('echo', { keys: [{ t: 0.3, mix: 0 }, { t: 1.5, mix: 100 }] })], [5, 20, 30, 50]],
  ['v551-echo-then-sepia', [k('sepia'), k('echo'), k('vignette', { shape: 'circle', invert: true, amount: 60, soft: 0.2 })], [13, 30]],
  ['v551-echo-crop', [k('echo')], [13, 30], { crop: { x: 200, y: 100, width: 800, height: 500 }, render: null }],
  ['v551-echo-two', [k('echo'), k('echo', { copies: 5, gap: 1, decay: 100 })], [13, 30]],
];
