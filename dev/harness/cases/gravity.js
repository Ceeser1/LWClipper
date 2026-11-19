'use strict';
// Gravity (5.3.0). Source: g709.mp4, 5 s with a frame counter drawn on it; all 5 s are exported.
// The picture is small in the frame, so it has room to fall: 480 by 270 in 1280 by 720.
const SMALL = { x: 400, y: 60, width: 480, height: 270 };
const P = { render: SMALL };
const FRAMES = [20, 33, 40, 47, 55, 66, 80, 100, 130];
const g = (more = {}, key = {}, keys = []) => ({
  kind: 'gravity', ...more,
  keys: [{ t: 1, velocity: 0, spin: 0, drag: 50, bounce: 50, ...key }, ...keys],
});
module.exports = [
  ['g-none', [], [20, 40], P],
  // The road a moving picture already takes, as the measure of what a moving picture reads.
  ['g-keys-only', [], [20, 40, 55], { keyframes: [{ id: 'a', t: 0.5, render: SMALL }, { id: 'b', t: 2, render: { ...SMALL, x: 60, y: 400 }, rotation: 50 }] }],
  ['g-no-key', [{ kind: 'gravity' }], [20, 60], P],
  ['g-off', [{ ...g(), disabled: true }], [20, 60], P],
  ['g-drop', [g()], FRAMES, P],
  ['g-drop-b0', [g({}, { bounce: 0 })], FRAMES, P],
  ['g-drop-b90', [g({}, { bounce: 90 })], FRAMES, P],
  ['g-tilt', [g()], FRAMES, { ...P, rotation: 20 }],
  ['g-spin', [g({}, { spin: 200, bounce: 60 })], FRAMES, P],
  ['g-spin-d100', [g({}, { spin: -400, drag: 100, bounce: 30 })], FRAMES, P],
  ['g-throw', [g({}, { velocity: 120, spin: 150, bounce: 70 })], FRAMES, P],
  ['g-throw-walls', [g({ walls: true }, { velocity: 150, spin: -300, bounce: 70 })], FRAMES, P],
  ['g-ball', [g({ body: 'ball' }, { velocity: 60, spin: 200, bounce: 70 })], FRAMES, P],
  ['g-ball-walls', [g({ body: 'ball', walls: true }, { velocity: -200, spin: 300, drag: 100, bounce: 80 })], FRAMES, P],
  ['g-ball-mask', [g({ body: 'ball' }, { velocity: 60, spin: 200, bounce: 70 })], FRAMES, { ...P, mask: { kind: 'circle' } }],
  ['g-box-mask-star', [g({}, { spin: 150, bounce: 60 })], FRAMES, { ...P, mask: { kind: 'star' } }],
  ['g-sepia', [{ kind: 'sepia' }, g({}, { spin: 200, bounce: 60 }), { kind: 'bars', size: 0.1 }], FRAMES, P],
  ['g-key-chroma', [{ kind: 'lumakey', mode: 'dark', threshold: 30, softness: 10 }, g({}, { spin: 100 })], FRAMES, P],
  ['g-crop', [g({}, { spin: 120, bounce: 60 })], FRAMES, { crop: { x: 200, y: 100, width: 800, height: 500 }, render: { x: 300, y: 40, width: 480, height: 300 } }],
  ['g-keys-before', [g({}, { spin: 100, bounce: 60 })], [10, 20, 29, 31, 40, 55, 80, 120],
    { keyframes: [{ id: 'a', t: 0, render: SMALL }, { id: 'b', t: 2, render: { ...SMALL, x: 760 }, rotation: 40 }] }],
  ['g-two-throws', [g({}, { bounce: 30 }, [{ t: 3, velocity: 150, spin: 300, drag: 50, bounce: 60 }])], [40, 80, 89, 91, 95, 110, 130], P],
  ['g-late', [g({}, { t: 4.5, spin: 100 })], [100, 134, 137, 142, 148], P],
  ['g-full', [g({}, { spin: 60, bounce: 40 })], FRAMES, {}],
  ['g-opacity-fade', [g({}, { spin: 200, bounce: 60 })], FRAMES, { ...P, alpha: 0.6, fadeIn: 1.5 }],
];
