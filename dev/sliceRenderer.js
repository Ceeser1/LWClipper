'use strict';

// The slice's renderer. Deliberately ugly: no timeline, no controls beyond Play
// and Export, no polish. Its whole job is to draw the same two layers that
// composer.js will encode, and to expose enough of itself over the devtools
// port that a script can compare the two.

const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const timeline = require('../src/timeline');
const geometry = require('../src/geometry');
const { buildComposeArgs } = require('../src/composer');

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : '';
}

const FFMPEG = argValue('slice-ffmpeg');
const FILE_A = argValue('slice-a');
const FILE_B = argValue('slice-b');
const OUT = argValue('slice-out');

const PROJECT = { width: 1280, height: 720, fps: 30 };

const stage = document.getElementById('stage');
const ctx = stage.getContext('2d', { alpha: false });
const pool = document.getElementById('pool');
const logEl = document.getElementById('log');
const clock = document.getElementById('clock');

function say(line) {
  console.log(line);
  logEl.textContent += line + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function once(el, event, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; el.removeEventListener(event, hit); resolve(); } };
    const hit = () => finish();
    el.addEventListener(event, hit, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

// --- the arrangement -------------------------------------------------------
// Video 1 is the portrait source, on top, appearing 2s into the timeline and
// showing its own source from 3s in. Video 2 is the landscape backdrop for the
// whole ten seconds. Chosen so that a wrong z-order, a wrong position, a wrong
// source time and a wrong window each look different from a right one.
const layers = [
  timeline.createLayer({
    id: 'top', type: 'video', name: 'Video 1', src: FILE_B,
    sourceDuration: 20, sourceIn: 3, duration: 5, start: 2,
  }),
  timeline.createLayer({
    id: 'bottom', type: 'video', name: 'Video 2', src: FILE_A,
    sourceDuration: 20, sourceIn: 0, duration: 10, start: 0,
  }),
];

const media = new Map();   // layer id  -> video element
const sources = {};        // src path  -> { width, height }

async function load() {
  const size = geometry.previewCanvasSize(PROJECT);
  stage.width = size.width;
  stage.height = size.height;

  for (const l of layers) {
    const v = document.createElement('video');
    v.src = pathToFileURL(l.src).href;
    v.muted = true;
    v.preload = 'auto';
    pool.appendChild(v);
    media.set(l.id, v);
  }
  await Promise.all(layers.map(async (l) => {
    const v = media.get(l.id);
    if (v.readyState < 2) await once(v, 'loadeddata', 20000);
    sources[l.src] = { width: v.videoWidth, height: v.videoHeight };
  }));

  for (const l of layers) {
    say(l.name + ': ' + path.basename(l.src) + '  '
      + sources[l.src].width + 'x' + sources[l.src].height
      + '  timeline ' + l.start + 's to ' + timeline.endOf(l) + 's'
      + '  source from ' + l.sourceIn + 's');
  }
  say('project ' + PROJECT.width + 'x' + PROJECT.height + ' at ' + PROJECT.fps
    + 'fps, canvas ' + stage.width + 'x' + stage.height
    + ', total ' + timeline.totalDuration(layers) + 's');
}

// --- the compositor --------------------------------------------------------
function draw(t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, stage.width, stage.height);
  // Back to front, which is the order layersAt hands them back in.
  for (const l of timeline.layersAt(layers, t)) {
    if (l.type !== 'video') continue;
    const v = media.get(l.id);
    if (!v || !v.videoWidth) continue;
    const placement = geometry.placeLayer({
      source: sources[l.src], crop: l.crop, project: PROJECT,
    });
    const d = geometry.drawImageArgs(placement, PROJECT, stage);
    if (!d) continue;
    ctx.drawImage(v, d.sx, d.sy, d.sw, d.sh, d.dx, d.dy, d.dw, d.dh);
  }
  clock.textContent = t.toFixed(2) + 's';
}

// Parks every layer on the frame the timeline says it should show at `t`, and
// waits for the seeks to land. This is the still path, used by the comparison.
async function seekAll(t) {
  const jobs = [];
  for (const l of layers) {
    const v = media.get(l.id);
    if (!v) continue;
    if (!timeline.covers(l, t)) continue;
    const want = timeline.sourceTimeFor(l, t);
    if (Math.abs(v.currentTime - want) < 0.001) continue;
    const p = once(v, 'seeked', 8000);
    v.currentTime = want;
    jobs.push(p);
  }
  await Promise.all(jobs);
  draw(t);
}

let playing = false;
let playhead = 0;

async function play() {
  if (playing) return;
  playing = true;
  document.getElementById('playBtn').textContent = 'Pause';
  const total = timeline.totalDuration(layers);
  let last = performance.now();
  const tick = async () => {
    if (!playing) return;
    const now = performance.now();
    playhead += (now - last) / 1000;
    last = now;
    if (playhead >= total) { playhead = 0; }

    for (const l of layers) {
      const v = media.get(l.id);
      if (!v) continue;
      if (timeline.covers(l, playhead)) {
        const want = timeline.sourceTimeFor(l, playhead);
        // A tolerance, then a forced re-seek. One replacement audio track
        // already needed exactly this, and eight elements will need it more.
        if (Math.abs(v.currentTime - want) > 0.25) v.currentTime = want;
        if (v.paused) v.play().catch(() => {});
      } else if (!v.paused) {
        v.pause();
      }
    }
    draw(playhead);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function pause() {
  playing = false;
  document.getElementById('playBtn').textContent = 'Play';
  for (const v of media.values()) v.pause();
}

// --- the encoder -----------------------------------------------------------
function exportTo(dest) {
  const args = buildComposeArgs({
    layers, project: PROJECT, trim: null, output: dest, format: 'mp4', sources,
  });
  say('');
  say('ffmpeg ' + args.join(' '));
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  const ok = r.status === 0;
  say(ok ? 'exported to ' + dest : 'EXPORT FAILED\n' + String(r.stderr || '').slice(-2000));
  return { ok, args, stderr: String(r.stderr || '') };
}

// --- what the comparison script talks to -----------------------------------
// A coarse grid rather than the whole frame: the preview and the encoder are
// expected to differ by a fraction of a pixel in placement and by codec noise
// in colour, and neither of those is the disagreement worth catching. A wrong
// position, a wrong z-order, a wrong source time or a wrong window all move
// whole cells.
async function grid(t, cols = 16, rows = 9) {
  await seekAll(t);
  const small = document.createElement('canvas');
  small.width = cols;
  small.height = rows;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(stage, 0, 0, cols, rows);
  const px = sctx.getImageData(0, 0, cols, rows).data;
  const out = [];
  for (let i = 0; i < px.length; i += 4) out.push(px[i], px[i + 1], px[i + 2]);
  return out;
}

window.__slice = {
  ready: () => media.size === layers.length && layers.every((l) => sources[l.src] && sources[l.src].width > 0),
  state: () => ({ layers, project: PROJECT, sources, canvas: { width: stage.width, height: stage.height } }),
  grid,
  seekAll,
  exportTo,
  totalDuration: () => timeline.totalDuration(layers),
};

document.getElementById('playBtn').addEventListener('click', () => (playing ? pause() : play()));
document.getElementById('exportBtn').addEventListener('click', () => exportTo(OUT || 'slice-out.mp4'));

load().then(() => {
  seekAll(4);
  say('ready');
}).catch((e) => say('SLICE FAILED: ' + (e && e.stack || e)));
