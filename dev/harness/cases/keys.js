'use strict';
// Chroma Key and Luma Key (5.2.0). Source: green.mp4; every case has the photograph on a track below, so what is keyed out shows it.
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const PART = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 };
const U = { under: true };
const k = (kind, more = {}) => ({ kind, shape: 'square', invert: false, box: FULL, ...more });
module.exports = [
  ['v54-none', [], [30], U],
  ['v54-chroma', [k('chromakey')], [30], U],
  ['v54-chroma-hard', [k('chromakey', { softness: 0 })], [30], U],
  ['v54-chroma-wide', [k('chromakey', { tolerance: 60, softness: 40 })], [30], U],
  ['v54-chroma-narrow', [k('chromakey', { tolerance: 8, softness: 5, spill: 0 })], [30], U],
  ['v54-chroma-nospill', [k('chromakey', { spill: 0 })], [30], U],
  ['v54-chroma-fullspill', [k('chromakey', { spill: 100 })], [30], U],
  ['v54-chroma-blue', [k('chromakey', { color: '#0000ff', tolerance: 40, spill: 100 })], [30], U],
  ['v54-chroma-red', [k('chromakey', { color: '#ff0000', tolerance: 40, spill: 100 })], [30], U],
  ['v54-chroma-keyed', [k('chromakey', { keys: [
    { t: 0.3, tolerance: 0, softness: 0, spill: 0 }, { t: 1.7, tolerance: 60, softness: 30, spill: 100 }] })], [5, 30, 55], U],
  ['v54-luma-dark', [k('lumakey')], [30], U],
  ['v54-luma-bright', [k('lumakey', { mode: 'bright', threshold: 60, softness: 20 })], [30], U],
  ['v54-luma-hard', [k('lumakey', { threshold: 50, softness: 0 })], [30], U],
  ['v54-luma-keyed', [k('lumakey', { keys: [{ t: 0.3, threshold: 0, softness: 0 }, { t: 1.7, threshold: 90, softness: 40 }] })], [5, 30, 55], U],
  ['v54-chroma-then-sepia', [k('chromakey'), k('sepia')], [30], U],
  ['v54-sepia-then-chroma', [k('huesat', { hue: 40, saturation: 20 }), k('chromakey', { color: '#00b17c' })], [30], U],
  ['v54-chroma-then-blur', [k('chromakey'), k('obscure', { box: PART, strength: 30 })], [30], U],
  ['v54-chroma-then-pin', [k('chromakey'), { kind: 'cornerpin', x1: 0.1, y1: 0.05, x2: 0.9, y2: 0.2, x3: 0.95, y3: 0.9, x4: 0.05, y4: 0.8 }], [30], U],
  ['v54-chroma-luma', [k('chromakey'), k('lumakey', { threshold: 10, softness: 5 })], [30], U],
  ['v54-chroma-crop', [k('chromakey')], [30], { under: true, crop: { x: 200, y: 100, width: 800, height: 500 }, render: null }],
  ['v54-chroma-placed', [k('chromakey')], [30], { under: true, crop: { x: 200, y: 100, width: 800, height: 500 }, render: { x: 300, y: 150, width: 640, height: 400 } }],
];
