'use strict';

// V4.4. What renders an export: the CPU (libx264, libvpx) or the GPU's own
// encoder. Only the encode moves. Building the frames (crop, masks, overlays,
// fades, keyframes) is ffmpeg's filter graph, and that runs on the CPU either
// way, so "GPU" already is the CPU and the GPU working together.
//
// Only Nvidia's encoder is offered. Its quality steps were measured against
// x264 (backend.js GPU_COMPRESSION_TABLE); Intel's and AMD's never were, and a
// slider that means something else on one machine is worse than no choice.

const { spawn } = require('child_process');

const CHOICES = ['auto', 'gpu', 'cpu'];
const DEFAULT_CHOICE = 'auto';

// The formats the GPU can write. WebM wants VP9, which no Nvidia card encodes.
const GPU_FORMATS = ['mp4', 'mov'];

function sanitizeChoice(choice) {
  return CHOICES.includes(choice) ? choice : DEFAULT_CHOICE;
}

function gpuCanWrite(format) {
  return GPU_FORMATS.includes(format);
}

/**
 * The encoder a job runs with: 'nvenc' or 'cpu'. Auto and GPU agree on this;
 * they differ only in whether a fall back to the CPU is worth saying out loud,
 * which is the caller's business.
 */
function resolveEncoder(choice, format, gpuAvailable) {
  if (sanitizeChoice(choice) === 'cpu') return 'cpu';
  return gpuAvailable && gpuCanWrite(format) ? 'nvenc' : 'cpu';
}

// The encoder list is no answer: the bundled ffmpeg lists h264_nvenc on every
// machine, and on this one it failed to open for two months until a driver
// update. So the probe is a real encode of a few black frames, once a run.
// 320x240 because nvenc refuses very small frames.
const PROBE_ARGS = ['-hide_banner', '-loglevel', 'error', '-nostdin',
  '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30', '-frames:v', '5',
  '-c:v', 'h264_nvenc', '-f', 'null', '-'];
const PROBE_TIMEOUT_MS = 10000;

function runProbe(ffmpeg) {
  return new Promise((resolve) => {
    if (!ffmpeg) {
      resolve(false);
      return;
    }
    let child;
    try {
      child = spawn(ffmpeg, PROBE_ARGS, { windowsHide: true, stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
    }, PROBE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

let probed = null;

/** Whether the GPU encoder opens here. Asked once a run, then remembered. */
function gpuAvailable(ffmpeg) {
  if (!probed) probed = runProbe(ffmpeg);
  return probed;
}

module.exports = {
  CHOICES, DEFAULT_CHOICE, GPU_FORMATS, PROBE_ARGS,
  sanitizeChoice, gpuCanWrite, resolveEncoder, gpuAvailable,
};
