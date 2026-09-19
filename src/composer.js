'use strict';

// The encoder graph for advanced mode: N video layers and M audio layers on one
// timeline, composited into one file. trimmer.js does the same job for simple
// mode's single source and stays untouched.
//
// Everything about where a picture lands comes from geometry.js and everything
// about when it appears comes from timeline.js, so this module decides nothing
// about the composition. It only says it in ffmpeg.
//
// Two behaviours here were measured against real ffmpeg rather than reasoned
// about, because a wrong filter graph does not throw, it produces a wrong video:
//
//   overlay repeats its last frame forever once its input ends. A layer running
//   3s to 6s on a 10s timeline was still painted at 8s. Both enable= and
//   eof_action=pass stop that on their own; both are used, because enable is
//   the honest statement of when the layer exists and eof_action covers an
//   input that turns out shorter than the layer claims.
//
//   A layer that has not started yet needs no such guard. overlay passes the
//   frame below straight through while it waits, in every variant tried.

const fs = require('fs');
const path = require('path');
const {
  videoTrackArgs, videoAudioTrackArgs, audioFileArgs, discardPartial, MIN_SPAN,
} = require('./trimmer');
const geometry = require('./geometry');
const timeline = require('./timeline');
const toolPaths = require('./toolPaths');
const progress = require('./progress');
const { runProcess, ProcessCancelledError } = require('./processRunner');

// Matches timeline.js. A layer covers its start but not its end, so the moment
// one clip ends is the moment the next begins and nothing is drawn twice.
// between() is inclusive at both ends and would overlap by a frame.
function enableExpr(start, end) {
  return "enable='gte(t," + fixed(start) + ")*lt(t," + fixed(end) + ")'";
}

// ffmpeg parses its own expressions, so a number must never reach it in
// exponential notation, which is what String(0.0000005) produces.
function fixed(v) {
  return (Math.round(Number(v) * 1e6) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
}

function msFixed(v) {
  return String(Math.max(0, Math.round(Number(v) * 1000)));
}

function chain(parts) {
  return parts.filter(Boolean).join(',');
}

/**
 * Works out the span of timeline the output covers. `trim` is the project's in
 * and out markers; without them the output is everything up to the last layer's
 * end.
 */
function outputSpan(layers, trim) {
  const total = timeline.totalDuration(layers);
  const start = Math.max(0, Number(trim && trim.start) || 0);
  const rawEnd = trim && Number.isFinite(Number(trim.end)) ? Number(trim.end) : total;
  const end = Math.min(total, Math.max(start, rawEnd));
  return { start, end, duration: end - start };
}

/**
 * The whole argv, ready for runProcess.
 *
 * `sources` maps a layer's src path to its probed dimensions, because the
 * geometry cannot be worked out without knowing how big the source frame is and
 * this module does not probe anything itself.
 */
function buildComposeArgs({
  layers = [],
  project,
  trim = null,
  output,
  format = 'mp4',
  compression = null,
  sources = {},
}) {
  const live = layers.filter((l) => l.enabled && l.src && l.duration > 0);
  const videoLayers = live.filter((l) => l.type === 'video');
  const audioLayers = live.filter((l) => l.type === 'audio');
  const span = outputSpan(live, trim);
  const fps = Math.max(1, Number(project && project.fps) || 30);

  // The same flags the trim opens with, for the same reasons: errors only, no
  // stdin to block on, and overwrite because the dialog already asked.
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  const inputs = [];

  // One input per layer, even when two layers share a file. A grouped video and
  // its sound are two layers of one file and could share a decode, but the
  // index juggling that saves is exactly the kind of cleverness that produces a
  // silently wrong graph.
  const indexOf = new Map();
  for (const l of live) {
    indexOf.set(l.id, inputs.length);
    inputs.push(l);
    args.push('-ss', fixed(l.sourceIn), '-t', fixed(l.duration), '-i', l.src);
  }

  const graph = [];
  const maps = [];

  if (videoLayers.length) {
    const projW = Number(project.width);
    const projH = Number(project.height);

    // A black frame the length of the output, which every layer is composited
    // onto. Without an explicit duration this source never ends.
    graph.push('color=c=black:s=' + projW + 'x' + projH + ':r=' + fps
      + ':d=' + fixed(span.end) + '[base]');

    // Back to front. The layer array is top first, so Video 1 is composited
    // last and lands on top.
    const order = videoLayers.slice().reverse();
    let prev = 'base';
    order.forEach((l, n) => {
      const placement = geometry.placeLayer({
        source: sources[l.src] || null,
        crop: l.crop || null,
        render: l.render || null,
        project,
      });
      const parts = geometry.filterParts(placement, sources[l.src] || null);
      const label = 'v' + n;

      // fps first: dropping frames before cropping and scaling means the work
      // is not done on frames that are about to be thrown away.
      graph.push('[' + indexOf.get(l.id) + ':v]'
        + chain([
          'fps=' + fps,
          parts && parts.crop,
          parts && parts.scale,
          'setpts=PTS-STARTPTS+' + fixed(l.start) + '/TB',
        ])
        + '[' + label + ']');

      const next = 'bg' + n;
      const xy = parts ? parts.overlay.slice('overlay='.length) : '0:0';
      graph.push('[' + prev + '][' + label + ']overlay=' + xy
        + ':eof_action=pass:' + enableExpr(l.start, timeline.endOf(l))
        + '[' + next + ']');
      prev = next;
    });

    // The project's in and out markers. Skipped when they select everything,
    // since a trim that trims nothing is still a filter and still a copy.
    if (span.start > 0) {
      graph.push('[' + prev + ']trim=start=' + fixed(span.start)
        + ':end=' + fixed(span.end) + ',setpts=PTS-STARTPTS[vout]');
      prev = 'vout';
    }
    maps.push('-map', '[' + prev + ']');
  }

  if (audioLayers.length) {
    const labels = [];
    audioLayers.forEach((l, n) => {
      const label = 'a' + n;
      labels.push('[' + label + ']');
      graph.push('[' + indexOf.get(l.id) + ':a]'
        + chain([
          'asetpts=PTS-STARTPTS',
          l.volume !== 1 ? 'volume=' + fixed(l.volume) : null,
          // adelay pads the front with silence, which is how a layer lands at
          // its timeline position. Nothing may reset the timestamps after it.
          l.start > 0 ? 'adelay=' + msFixed(l.start) + ':all=1' : null,
        ])
        + '[' + label + ']');
    });

    let prev;
    if (labels.length > 1) {
      // normalize=0 or amix divides by the number of inputs and every layer
      // gets quieter as the project grows, which is not what a mixer does.
      graph.push(labels.join('') + 'amix=inputs=' + labels.length
        + ':normalize=0:duration=longest[amixed]');
      prev = 'amixed';
    } else {
      prev = 'a0';
    }

    // Audio that ends before the picture does leaves a file whose streams
    // disagree about how long it is. Pad to the output length first, then cut.
    graph.push('[' + prev + ']apad=whole_dur=' + fixed(span.end)
      + ',atrim=start=' + fixed(span.start) + ':end=' + fixed(span.end)
      + ',asetpts=PTS-STARTPTS[aout]');
    maps.push('-map', '[aout]');
  }

  args.push('-filter_complex', graph.join(';'));
  args.push(...maps);

  if (videoLayers.length) {
    args.push(...videoTrackArgs(format, compression));
    args.push('-r', String(fps));
  } else {
    args.push('-vn');
  }
  if (audioLayers.length) {
    // With no picture the output is an audio file, and an audio file wants the
    // codec for its own container. videoAudioTrackArgs would put aac in an mp3.
    args.push(...(videoLayers.length
      ? videoAudioTrackArgs(format)
      : audioFileArgs(format, compression)));
  } else {
    args.push('-an');
  }

  args.push('-t', fixed(span.duration));
  // Inside the built argv rather than added by whatever runs it, so the command
  // the tests read is the command that runs.
  args.push('-progress', 'pipe:1', '-nostats', output);
  return args;
}

/**
 * How big each source's frame is, keyed by path.
 *
 * The layers carry it, because describeMedia probes a file the moment it is
 * opened and the layer keeps what it said. Taking it from there rather than
 * probing again is what keeps the crop meaning one rectangle: the same number
 * reaches the filmstrip, the preview and this.
 *
 * `probe` is the fallback for a layer that has none, which is a project written
 * before Step 11 added the fields. Passed in rather than required, so this
 * module still touches no filesystem.
 */
function sourceSizes(layers, probe = null) {
  const sizes = {};
  for (const l of layers) {
    if (!l.src || sizes[l.src]) continue;
    if (l.sourceWidth > 0 && l.sourceHeight > 0) {
      sizes[l.src] = { width: l.sourceWidth, height: l.sourceHeight };
    } else if (probe) {
      const info = probe(l.src) || {};
      sizes[l.src] = { width: info.width || 0, height: info.height || 0 };
    }
  }
  return sizes;
}

/**
 * Renders the timeline to a file. The composite half of trimmer.trim(), and
 * deliberately shaped like it: same arguments in the same order, same progress
 * callback, same cancel token, same thrown Error on a bad exit.
 *
 * The tail here comes from stderr, not stdout. ffmpeg writes its diagnostics to
 * stderr and its -progress blocks to stdout, and a filter graph that will not
 * build says so in one long paragraph on the first of those. Reading the wrong
 * stream is how a failed render reports nothing but an exit code.
 */
async function render({
  layers = [],
  project,
  trim = null,
  output,
  format = 'mp4',
  compression = null,
  sources = {},
}, onProgress, cancelToken) {
  const ffmpeg = toolPaths.findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg.exe was not found alongside the app.');

  const live = layers.filter((l) => l.enabled && l.src && l.duration > 0);
  if (!live.length) throw new Error('There is nothing on the timeline to write.');

  const out = path.resolve(output);
  // Writing over a file the graph is reading from truncates it before ffmpeg
  // has finished with it, which loses the source rather than producing a bad
  // export. Cheaper to refuse than to explain afterwards.
  if (live.some((l) => path.resolve(l.src).toLowerCase() === out.toLowerCase())) {
    throw new Error('Pick a destination that is not one of the files on the timeline.');
  }

  const span = outputSpan(live, trim);
  if (span.duration < MIN_SPAN) throw new Error('The selected range is empty.');

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = buildComposeArgs({
    layers, project, trim, output: out, format, compression, sources,
  });

  const reader = progress.ffmpegProgress(span.duration);
  let result;
  try {
    result = await runProcess(ffmpeg, args, (line) => {
      const update = reader.line(line);
      if (update && onProgress) onProgress(update.frac, update.text);
    }, cancelToken);
  } catch (e) {
    // The same answer the trim gives, from the same function, because a render
    // cancelled two minutes in leaves a far bigger piece of a file than a trim
    // ever does and it is no more finished for that.
    if (e instanceof ProcessCancelledError) discardPartial(out);
    throw e;
  }

  if (result.exitCode !== 0) {
    const detail = result.stderrTail.length
      ? result.stderrTail.join('\n')
      : 'exit code ' + result.exitCode;
    throw new Error('ffmpeg failed:\n' + detail);
  }
  if (onProgress) onProgress(1.0, 'Saved.');
  return out;
}

module.exports = { buildComposeArgs, outputSpan, enableExpr, sourceSizes, render };
