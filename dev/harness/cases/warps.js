'use strict';
// Corner Pin, Polar Coordinates, Vibrance, Halftone (5.2.0).
const PART = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 };
const U = { under: true };
const PIN = { x1: 0.12, y1: 0.1, x2: 0.88, y2: 0.2, x3: 0.88, y3: 0.8, x4: 0.12, y4: 0.9 };
module.exports = [
  ['v52-none-under', [], [30], U],
  ['v52-pin', [{ kind: 'cornerpin', ...PIN }], [30], U],
  ['v52-pin-nounder', [{ kind: 'cornerpin', ...PIN }], [30]],
  ['v52-pin-steep', [{ kind: 'cornerpin', x1: 0.4, y1: 0.3, x2: 0.9, y2: 0.05, x3: 0.95, y3: 0.95, x4: 0.4, y4: 0.6 }], [30], U],
  ['v52-pin-flipped', [{ kind: 'cornerpin', x1: 0.8, y1: 0.1, x2: 0.2, y2: 0.2, x3: 0.2, y3: 0.8, x4: 0.8, y4: 0.9 }], [30], U],
  ['v52-pin-off-picture', [{ kind: 'cornerpin', x1: -0.3, y1: -0.2, x2: 1.2, y2: 0.1, x3: 0.9, y3: 1.3, x4: 0.1, y4: 0.8 }], [30], U],
  ['v52-pin-mix50', [{ kind: 'cornerpin', ...PIN, mix: 50 }], [30], U],
  ['v52-pin-keyed', [{ kind: 'cornerpin', keys: [
    { t: 0.2, x1: 0, y1: 0, x2: 1, y2: 0, x3: 1, y3: 1, x4: 0, y4: 1, mix: 100 },
    { t: 1.8, x1: 0.3, y1: 0.2, x2: 0.9, y2: 0.3, x3: 0.8, y3: 0.9, x4: 0.2, y4: 0.7, mix: 100 }] }], [10, 30, 50], U],
  ['v52-pin-keyed-mix', [{ kind: 'cornerpin', keys: [
    { t: 0.2, ...PIN, mix: 0 }, { t: 1.8, ...PIN, mix: 100 }] }], [10, 30, 50], U],
  ['v52-pin-then-sepia', [{ kind: 'cornerpin', ...PIN }, { kind: 'sepia', box: PART, soft: 0.03 }], [30], U],
  ['v52-sepia-then-pin', [{ kind: 'sepia', box: PART }, { kind: 'cornerpin', ...PIN }, { kind: 'obscure', shape: 'circle', box: PART, strength: 20 }], [30], U],
  ['v52-pin-crop', [{ kind: 'cornerpin', ...PIN }], [30], { under: true, crop: { x: 200, y: 100, width: 800, height: 500 }, render: null }],
  ['v52-pin-small', [{ kind: 'cornerpin', ...PIN }], [30],
    { under: true, crop: { x: 200, y: 100, width: 800, height: 500 }, render: { x: 120, y: 80, width: 640, height: 400 } }],
  ['v52-polar-wrap', [{ kind: 'polar', mode: 'wrap', amount: 100 }], [30]],
  ['v52-polar-unwrap', [{ kind: 'polar', mode: 'unwrap', amount: 100 }], [30]],
  ['v52-polar-half', [{ kind: 'polar', mode: 'wrap', amount: 50 }], [30]],
  ['v52-polar-keyed', [{ kind: 'polar', mode: 'wrap', keys: [{ t: 0.2, amount: 0, mix: 100 }, { t: 1.8, amount: 100, mix: 100 }] }], [10, 30, 50]],
  ['v52-vibrance-up', [{ kind: 'vibrance', vibrance: 80, box: { x: 0, y: 0, w: 1, h: 1 } }], [30]],
  ['v52-vibrance-down', [{ kind: 'vibrance', vibrance: -80, box: { x: 0, y: 0, w: 1, h: 1 } }], [30]],
  ['v52-vibrance-circle', [{ kind: 'vibrance', vibrance: 100, shape: 'circle', box: PART, soft: 0.04 }], [30]],
  ['v52-halftone', [{ kind: 'halftone', size: 0.014, angle: 45, box: { x: 0, y: 0, w: 1, h: 1 } }], [30]],
  ['v52-halftone-tinted', [{ kind: 'halftone', tinted: true, size: 0.03, angle: 20, box: { x: 0, y: 0, w: 1, h: 1 } }], [30]],
  ['v52-halftone-box', [{ kind: 'halftone', size: 0.02, angle: 0, box: PART, soft: 0.03 }], [30]],
  ['v52-halftone-crop', [{ kind: 'halftone', size: 0.02, angle: 30, box: { x: 0, y: 0, w: 1, h: 1 } }], [30],
    { crop: { x: 200, y: 100, width: 800, height: 500 }, render: null }],
  ['v52-bulge-still', [{ kind: 'bulge', amount: -80, radius: 0.5, cx: 0.4, cy: 0.5 }], [30]],
];
