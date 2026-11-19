'use strict';
// Curves, and Apply LUT with .3dl files (5.2.0).
const L = require('../lib').W + '/luts';
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const PART = { x: 0.3, y: 0.25, w: 0.4, h: 0.5 };
const FLAT = [[0, 0], [255, 255]];
const k = (kind, more = {}) => ({ kind, shape: 'square', invert: false, box: FULL, ...more });
module.exports = [
  ['v53-curves', [k('curves')], [30]],
  ['v53-curves-rgb', [k('curves', { curve: { m: [[0, 10], [90, 70], [170, 200], [255, 245]], r: [[0, 0], [128, 160], [255, 255]],
    g: [[0, 20], [255, 230]], b: [[0, 0], [60, 20], [200, 235], [255, 255]] } })], [30]],
  ['v53-curves-negative', [k('curves', { curve: { m: [[0, 255], [255, 0]], r: FLAT, g: FLAT, b: FLAT } })], [30]],
  ['v53-curves-steep', [k('curves', { curve: { m: [[0, 0], [100, 0], [101, 255], [255, 255]], r: FLAT, g: FLAT, b: FLAT } })], [30]],
  ['v53-curves-hill', [k('curves', { curve: { m: [[0, 0], [128, 255], [255, 0]], r: FLAT, g: FLAT, b: [[40, 200], [220, 30]] } })], [30]],
  ['v53-curves-circle', [k('curves', { shape: 'circle', box: PART, soft: 0.05 })], [30]],
  ['v53-curves-keymix', [k('curves', { curve: { m: [[0, 0], [128, 200], [255, 255]], r: FLAT, g: FLAT, b: FLAT }, keys: [
    { t: 0.5, box: FULL, rotation: 0, mix: 0, soft: 0 }, { t: 1.5, box: FULL, rotation: 0, mix: 100, soft: 0 }] })], [10, 30, 50]],
  ['v53-curves-stack', [k('brightness', { brightness: 10, contrast: 20 }), k('curves'), k('sepia', { mix: 50 })], [30]],
  ['v53-cube-17', [k('lut', { file: L + '/look17.cube' })], [30]],
  ['v53-3dl-17', [k('lut', { file: L + '/look17.3dl' })], [30]],
  ['v53-3dl-33-mesh', [k('lut', { file: L + '/look33 mesh.3dl' })], [30]],
  ['v53-3dl-part', [k('lut', { shape: 'circle', box: PART, soft: 0.04, file: L + '/look17.3dl' })], [30]],
  ['v53-3dl-mix', [k('lut', { file: L + '/look17.3dl', mix: 50 })], [30]],
  ['v53-3dl-gone', [k('lut', { file: L + '/gone.3dl' })], [30]],
];
