'use strict';

// V4.13. Exporting a selection without rendering what comes before it.
//
// The graph composer.js builds starts everything at the project's second 0
// and cuts the selection out at the very end. So ten seconds at minute five
// meant five minutes decoded, placed and composited to be thrown away:
// measured on one 1080p clip, 1.1s for the ten seconds at the start of the
// project and 7.8s for the same ten seconds at second 300, of which 3.3 were
// the decoder alone.
//
// What this module works out is how much of that can be left out with the
// file coming out frame for frame the one the long way wrote:
//
//   the black frame everything is laid on starts just before the selection;
//   a layer that is over before the selection, or starts after it, is left
//   out of the graph altogether;
//   a still is held from just before the selection instead of from its start;
//   a clip out of a file is read from just before the selection.
//
// The last is the one that takes care. ffmpeg places a clip by its first
// decoded frame: the first one at or after the in point becomes the clip's
// first frame, and every later frame is counted from where the in point was.
// Read from further in, the first frame decoded is another one, and without
// knowing how the two lie to each other the whole clip could land a frame
// early or late. So the file is asked for its real frame times round both
// places (ffprobe, packets only, nothing decoded), and from them the graph is
// told exactly where on the old count the new first frame stands.
//
// Everything here is plain arithmetic on what ffprobe said, so it is tested
// without a file. composer.js decides which layers may take a skip at all,
// see windowSkip there: anything whose picture depends on frames counted from
// the clip's start (a moving mask, moving areas, drawn frames) is read the
// long way, as before.

const { execFileSync } = require('child_process');
const timeline = require('./timeline');
const toolPaths = require('./toolPaths');

// Slots, that is frames of the project, kept before the selection: the black
// frame starts one before it, and a layer two before that again.
const BASE_MARGIN = 1;
const LAYER_MARGIN = 2;
// A file is only read from further in when that saves at least this much.
const WORTH_SECONDS = 1;

/** Half away from zero, which is how ffmpeg rounds a time to a tick. */
function roundAway(v) {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

/** Microseconds as ticks of a stream whose time base is num/den seconds. */
function toTicks(us, tb) {
  return roundAway(us * tb.den / (tb.num * 1e6));
}

/** The seconds ffmpeg reads from a number the composer prints: six decimals. */
function printedUs(seconds) {
  return Math.round(Number(seconds) * 1e6);
}

/**
 * The first frame ffmpeg keeps when asked to start `us` microseconds into
 * the file: timestamps are moved back by that much, as ticks, and whatever
 * falls before zero is dropped. `pts` is sorted. Null when the list has none.
 */
function firstKept(pts, us, tb) {
  const from = toTicks(us, tb);
  for (const p of pts) if (p >= from) return p;
  return null;
}

/**
 * Where to read one clip from so that its frames from slot `k` on are the
 * ones the long way gives, or null when that cannot be said for sure.
 *
 * `info` is what the file says round the two places: { tb: { num, den },
 * startUs, near, far }, the sorted frame times in ticks near the in point
 * and near where the reading will start. Handed back: `ss`, where to start
 * reading, in the file's seconds; `raw`, where the first frame read stands
 * on the old count, in seconds; `q0`, the slot the old first frame fell in
 * (0 or 1); and `k`, the first slot of the clip that is kept.
 */
function planFile(layer, k, fps, info) {
  if (!info || !info.tb || !(info.tb.num > 0) || !(info.tb.den > 0)) return null;
  const tb = info.tb;
  const tick = tb.num / tb.den;
  const oldUs = printedUs(layer.sourceIn) + info.startUs;
  const oldFrom = toTicks(oldUs, tb);
  const first = firstKept(info.near, oldUs, tb);
  if (first === null) return null;
  // The slot a frame falls in: its time since the reading began, at the
  // project's rate, to the nearest.
  const slotOf = (p) => roundAway((p - oldFrom) * tick * fps);
  const q0 = slotOf(first);
  if (q0 !== 0 && q0 !== 1) return null;
  // The frame to start from: the last one at least two slots and a bit before
  // the first slot kept, so every slot kept is filled as it was.
  const last = k + q0 - LAYER_MARGIN;
  const before = info.far.filter((p) => slotOf(p) < last);
  if (before.length < 3) return null;
  const m = before[before.length - 1];
  const prev = before[before.length - 2];
  // Half way between it and the frame before it, so no rounding on the way
  // can make the reading begin with either neighbour. Checked all the same.
  const us = Math.round(((m + prev) / 2) * tick * 1e6) - info.startUs;
  if (!(us > printedUs(layer.sourceIn))) return null;
  if (firstKept(info.far, us + info.startUs, tb) !== m) return null;
  // The list must reach past it, or frames between may simply be missing.
  if (!(info.far[info.far.length - 1] > m)) return null;
  return {
    k, q0,
    ss: us / 1e6,
    raw: ((m - oldFrom) * tick).toFixed(9),
  };
}

/**
 * The plan for one export: { cut, drop, skips }, or null when there is
 * nothing to leave out. `cut` is how many frames of the project the black
 * frame starts in, `drop` the ids of the layers left out, and `skips` by
 * layer id what planFile says, or { k } alone for a still.
 *
 * `probe(src, places)` reads a file's frame times round each of `places`,
 * seconds into it, see probeFrames. It is asked once a clip, and only for a
 * clip that would save reading.
 */
function plan({ layers = [], span, fps, probe }) {
  const rate = Math.max(1, Number(fps) || 30);
  if (!span || !(span.start > 0)) return null;
  const cut = Math.floor(span.start * rate + 1e-6) - BASE_MARGIN;
  if (!(cut >= 1)) return null;
  const from = cut / rate;
  const out = { cut, drop: [], skips: {} };
  for (const l of layers) {
    if (l.type !== 'video' || !l.enabled || !l.src || !(l.duration > 0)) continue;
    if (timeline.endOf(l) <= from - LAYER_MARGIN / rate || l.start >= span.end + LAYER_MARGIN / rate) {
      out.drop.push(l.id);
      continue;
    }
    const k = Math.floor((from - l.start) * rate + 1e-6) - LAYER_MARGIN;
    if (!(k >= 1)) continue;
    if (timeline.isStill(l)) {
      if (!l.frames) out.skips[l.id] = { k };
      continue;
    }
    if (l.frames || timeline.speedOf(l) !== 1 || k / rate < WORTH_SECONDS || !probe) continue;
    let info = null;
    try {
      info = probe(l.src, [l.sourceIn, l.sourceIn + (k - LAYER_MARGIN) / rate]);
    } catch {
      info = null;
    }
    const file = info ? planFile(l, k, rate, { ...info, near: info.lists[0], far: info.lists[1] }) : null;
    if (file) out.skips[l.id] = file;
  }
  return out;
}

/**
 * A file's frame times round each of `places`, seconds from the file's own
 * start: { tb, startUs, lists }, each list sorted and in ticks, from the key
 * frame before one second ahead of the place to one second after it. Packets
 * are read, nothing is decoded, so it is quick wherever the place is.
 */
function probeFrames(src, places) {
  const ffprobe = toolPaths.findFfprobe();
  if (!ffprobe) return null;
  const head = JSON.parse(execFileSync(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=time_base:format=start_time', '-of', 'json', src,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
  const stream = head.streams && head.streams[0];
  const parts = stream && /^(\d+)\/(\d+)$/.exec(stream.time_base || '');
  if (!parts) return null;
  const tb = { num: Number(parts[1]), den: Number(parts[2]) };
  const start = Number(head.format && head.format.start_time);
  const startUs = Number.isFinite(start) ? Math.round(start * 1e6) : 0;
  const lists = places.map((place) => {
    const at = place + startUs / 1e6;
    const out = JSON.parse(execFileSync(ffprobe, [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts', '-of', 'json',
      '-read_intervals', Math.max(0, at - 1).toFixed(6) + '%' + (at + 1).toFixed(6), src,
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1 << 26 }));
    const pts = (out.packets || []).map((p) => Number(p.pts)).filter((p) => Number.isFinite(p));
    return [...new Set(pts)].sort((a, b) => a - b);
  });
  return { tb, startUs, lists };
}

module.exports = { plan, planFile, probeFrames, firstKept, toTicks, BASE_MARGIN, LAYER_MARGIN };
