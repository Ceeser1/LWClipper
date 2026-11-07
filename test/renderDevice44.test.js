'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/renderDevice');
const { videoTrackArgs } = require('../src/trimmer');
const backend = require('../src/backend');
const { buildComposeArgs } = require('../src/composer');
const timeline = require('../src/timeline');
const settings = require('../src/settings');

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('Auto and GPU take the GPU only where it opened and can write the format', () => {
  assert.equal(D.resolveEncoder('auto', 'mp4', true), 'nvenc');
  assert.equal(D.resolveEncoder('gpu', 'mov', true), 'nvenc');
  assert.equal(D.resolveEncoder('gpu', 'mp4', false), 'cpu');
  assert.equal(D.resolveEncoder('auto', 'webm', true), 'cpu');
  assert.equal(D.resolveEncoder('cpu', 'mp4', true), 'cpu');
  // A setting from a hand-edited file reads as Auto.
  assert.equal(D.sanitizeChoice('both'), 'auto');
  assert.equal(D.resolveEncoder('nonsense', 'mp4', true), 'nvenc');
});

test('the GPU line is h264_nvenc with the measured step for each slider position', () => {
  const steps = { 0: '25', 25: '30', 50: '34', 75: '38' };
  for (const [percent, cq] of Object.entries(steps)) {
    const args = videoTrackArgs('mp4', Number(percent), 'nvenc');
    assert.equal(valueAfter(args, '-c:v'), 'h264_nvenc');
    assert.equal(valueAfter(args, '-cq'), cq);
    assert.equal(valueAfter(args, '-preset'), 'p4');
    assert.equal(valueAfter(args, '-b:v'), '0');
    assert.equal(valueAfter(args, '-pix_fmt'), 'yuv420p');
  }
  // The checkbox off is step 0, as it is for x264.
  assert.equal(valueAfter(videoTrackArgs('mov', null, 'nvenc'), '-cq'), '25');
  assert.equal(backend.gpuCompressionSetting(60), 34);
});

test('WebM and the CPU keep their own encoders', () => {
  assert.equal(valueAfter(videoTrackArgs('webm', 25, 'nvenc'), '-c:v'), 'libvpx-vp9');
  assert.equal(valueAfter(videoTrackArgs('mp4', 25), '-c:v'), 'libx264');
  assert.equal(valueAfter(videoTrackArgs('mp4', 25, 'cpu'), '-crf'), '23');
});

test('a composed export carries the encoder it was given', () => {
  const layers = [timeline.createLayer({ id: 'v', type: 'video', src: 'a.mp4', sourceDuration: 60, duration: 4 })];
  const base = { layers, project: { width: 1280, height: 720, fps: 30 }, output: 'out.mp4', sources: { 'a.mp4': { width: 1280, height: 720 } } };
  assert.equal(valueAfter(buildComposeArgs(base), '-c:v'), 'libx264');
  assert.equal(valueAfter(buildComposeArgs({ ...base, encoder: 'nvenc' }), '-c:v'), 'h264_nvenc');
});

test('the probe is a real encode, not a look at the encoder list', () => {
  assert.ok(D.PROBE_ARGS.includes('h264_nvenc'));
  assert.ok(!D.PROBE_ARGS.includes('-encoders'));
  assert.equal(D.PROBE_ARGS[D.PROBE_ARGS.length - 1], '-');
});

test('a fresh profile renders on Auto', () => {
  assert.equal(settings.DEFAULTS.renderDevice, 'auto');
});
