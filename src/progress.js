'use strict';

// Reading ffmpeg's -progress output, for the trim and for the composite render
// alike. Both run the same tool with the same flag and both want the same line
// out of it, so there is one reader rather than one each.
//
// -progress writes key=value lines, one key per line, in blocks that always end
// with a progress= line. That block boundary is what this reads on, and the
// reason is the ETA: out_time and speed arrive on separate lines of the same
// block, so anything emitting on out_time is pairing a fresh position with the
// speed from the block before. Waiting for progress= pairs the two the encoder
// meant to be read together.
//
// The ETA comes from ffmpeg's own speed= rather than from timing the lines here
// because speed= is already an average over the whole run. A rate worked out
// between two blocks swings wildly on a scene change and would need smoothing
// invented for it; this one is smooth because ffmpeg smoothed it.

const { fmtTime } = require('./backend');

// Everything -progress can put on stdout. Used to tell its chatter apart from a
// real message, since anything on that stream which is not one of these is
// worth keeping to say why a run failed.
const PROGRESS_KEYS = new Set([
  'frame', 'fps', 'bitrate', 'total_size', 'out_time_us', 'out_time_ms',
  'out_time', 'dup_frames', 'drop_frames', 'speed', 'progress',
]);

// Per-stream quality is one key per stream: stream_0_0_q, stream_0_1_q, ...
const STREAM_KEY_RE = /^stream_\d+_\d+_/;

const CLOCK_RE = /^(\d+):(\d\d):(\d\d(?:\.\d+)?)/;

function keyOf(line) {
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  return line.slice(0, eq).trim();
}

/** Whether ffmpeg wrote this line as progress rather than as something to read. */
function isProgressLine(line) {
  const key = keyOf(String(line));
  if (!key) return false;
  return PROGRESS_KEYS.has(key) || STREAM_KEY_RE.test(key);
}

/**
 * Seconds as the shortest thing that still reads as a duration.
 *
 * Under a minute in seconds, which is what the download ETA beside it already
 * does. Above that a raw second count stops being readable: a five minute
 * render reading "ETA 300s" is worse than "5:00" for no reason.
 */
function fmtEta(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return total + 's';
  const pad = (n) => String(n).padStart(2, '0');
  const m = Math.floor(total / 60);
  if (m < 60) return m + ':' + pad(total % 60);
  return Math.floor(m / 60) + ':' + pad(m % 60) + ':' + pad(total % 60);
}

function clockSeconds(value) {
  const m = CLOCK_RE.exec(value);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

/**
 * A reader for one run.
 *
 * Feed it every stdout line; it answers with an update at the end of each block
 * and null the rest of the time. `span` is how many seconds of output the run
 * is going to produce, which is the only thing ffmpeg does not say itself and
 * the thing both the fraction and the ETA are measured against.
 */
function ffmpegProgress(span) {
  const total = Math.max(0, Number(span) || 0);
  let done = 0;
  let speed = 0;

  return {
    line(raw) {
      const text = String(raw);
      const key = keyOf(text);
      if (!key) return null;
      const value = text.slice(text.indexOf('=') + 1).trim();

      if (key === 'out_time') {
        const at = clockSeconds(value);
        // Negative out_time is what ffmpeg reports before the first frame of a
        // stream with a lead-in; treating it as progress would run the bar
        // backwards at the start.
        if (at !== null && at >= 0) done = at;
        return null;
      }
      if (key === 'speed') {
        // "2.05x", or "N/A" for as long as there is nothing to average yet.
        const v = parseFloat(value);
        speed = Number.isFinite(v) && v > 0 ? v : 0;
        return null;
      }
      if (key !== 'progress') return null;

      const frac = total > 0 ? Math.min(done / total, 1) : null;
      const line = 'Writing   ' + fmtTime(done, false) + ' / ' + fmtTime(total, false);
      // No speed yet means no honest ETA, and a made-up one is worse than none.
      const eta = (speed > 0 && total > done)
        ? '   ETA ' + fmtEta((total - done) / speed)
        : '';
      return { frac, text: line + eta };
    },
  };
}

module.exports = { ffmpegProgress, isProgressLine, fmtEta };
