'use strict';
// Six seconds of 1080p with sound, with many VFX at once: what a long graph
// and a long clip do that two seconds of 720p do not show. Source: long1080.mp4.
const { FULL, PART, k, W, WB } = require('../lib');

module.exports = [
  ['long-12', [k('brightness', { brightness: 5, contrast: 20 }), k('look', { look: 'tealorange' }), k('clarity', { amount: 60, radius: 0.03 }),
    k('glow', { threshold: 60, radius: 0.02, intensity: 80 }), k('sharpen', { amount: 30 }), k('obscure', { box: PART, strength: 30 }),
    k('pixelate', { box: { x: 0.05, y: 0.6, w: 0.2, h: 0.3 }, strength: 25 }), k('vignette', { shape: 'circle', invert: true, amount: 60, soft: 0.2 }),
    k('grain', { amount: 15 }), k('rgbsplit', { amount: 0.004, angle: 0 }), k('lens', { amount: -20 }), k('bars', { size: 0.1 })], [45, 120]],
  ['long-50', Array.from({ length: 50 }, (_, i) => k(['invert', 'sepia', 'posterize', 'huesat', 'threshold'][i % 5], { keys: [
    { t: i * 0.1, box: FULL, rotation: 0, hue: 90, saturation: 20, levels: 4, level: 50, mix: 0, soft: 0 },
    { t: i * 0.1 + 0.05, box: FULL, rotation: 0, hue: 90, saturation: 20, levels: 4, level: 50, mix: 100, soft: 0 },
    { t: i * 0.1 + 0.4, box: FULL, rotation: 0, hue: 90, saturation: 20, levels: 4, level: 50, mix: 100, soft: 0 },
    { t: i * 0.1 + 0.45, box: FULL, rotation: 0, hue: 90, saturation: 20, levels: 4, level: 50, mix: 0, soft: 0 }] })), [45, 120]],
  ['long-ramp', [k('huesat', { keys: [
    { t: 0, box: FULL, rotation: 0, hue: -180, saturation: -50, mix: 100, soft: 0 },
    { t: 6, box: FULL, rotation: 0, hue: 180, saturation: 60, mix: 100, soft: 0 }] }),
    k('clarity', { keys: [
    { t: 0, box: FULL, rotation: 0, amount: -100, radius: 0.005, mix: 100, soft: 0 },
    { t: 6, box: FULL, rotation: 0, amount: 200, radius: 0.05, mix: 100, soft: 0 }] }),
    k('lens', { keys: [
    { t: 0, box: FULL, rotation: 0, amount: -100, mix: 100, soft: 0 },
    { t: 6, box: FULL, rotation: 0, amount: 100, mix: 100, soft: 0 }] })], [45, 120]],
];
