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

// ---- V3.3. A picture that moves between keyframes ----
//
// crop cannot do it: its width and height are worked out once, when the graph
// is built, and so is drawbox's box. Measured on 2026-11-03 with the bundled
// ffmpeg, and so was the obvious second try, sendcmd with one command per frame,
// which raced: overlay looks a frame ahead and took the next frame's place,
// scale held some values for two frames. What does work is the expressions
// scale and overlay evaluate on every frame, against that frame's own t:
//
//   1. the source cut once to the rect every keyframe's crop lies inside, a
//      fixed crop like any other, so a deep zoom does not scale the whole frame
//   2. scaled per frame so the moment's crop comes out the moment's size
//   3. laid on a clear canvas per frame so that crop lands where it goes
//   4. everything outside the moment's destination masked off, by a white
//      square scaled and laid the same way on black, through alphamerge
//
// Against the fixed crop, scale and overlay at the same numbers that gave SSIM
// 0.98 to 0.99 between keyframes and an identical first frame. The canvases are
// only as big as the frame the picture ever covers and only as long as the
// clip, so a small moving inset costs a small amount.

/**
 * A drawn frame sequence held still before its first frame and after its last,
 * for as long as the clip runs on either side of the move. Null when it covers
 * the whole clip.
 */
function holdFrames(frames) {
  const lead = Math.max(0, Number(frames.lead) || 0);
  const tail = Math.max(0, Number(frames.tail) || 0);
  if (!lead && !tail) return null;
  return 'tpad=' + [
    lead ? 'start_mode=clone:start_duration=' + fixed(lead) : null,
    tail ? 'stop_mode=clone:stop_duration=' + fixed(tail) : null,
  ].filter(Boolean).join(':');
}

/** An ffmpeg expression of t: the values at the times, blended between them. */
function piecewise(times, values) {
  const num = (v) => fixed(v);
  const seg = (i) => {
    const a = values[i];
    const b = values[i + 1];
    if (a === b) return num(a);
    const span = times[i + 1] - times[i];
    return '(' + num(a) + '+' + num(b - a) + '*clip((t-' + num(times[i]) + ')/' + num(span) + '\\,0\\,1))';
  };
  let expr = seg(values.length - 2);
  for (let i = values.length - 3; i >= 0; i -= 1) {
    expr = 'if(lt(t\\,' + num(times[i + 1]) + ')\\,' + seg(i) + '\\,' + expr + ')';
  }
  return '(' + expr + ')';
}

const evenDown = (v) => Math.floor(v / 2) * 2;
const evenUp = (v) => Math.ceil(v / 2) * 2;

function unionOf(rects) {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width));
  const y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * The filters for one moving layer, composited onto `prev`. Hands back the
 * label of what it made, the next layer's `prev`.
 */
function movingLayer(graph, l, n, motion, prev, { input, fps, source, projW, projH }) {
  const times = motion.map((k) => l.start + k.t);
  const at = (pick) => piecewise(times, motion.map(pick));
  // 1. The fixed cut. Every crop is even and inside the source already, so
  // their union is too.
  const cut = unionOf(motion.map((k) => k.src));
  const whole = source && cut.x === 0 && cut.y === 0
    && cut.width >= evenDown(Number(source.width)) && cut.height >= evenDown(Number(source.height));
  // The part of the frame the picture ever covers, which is all the canvases
  // need to be. Even, for yuva420p.
  const reach = unionOf(motion.map((k) => k.dest));
  const bx = Math.max(0, evenDown(reach.x));
  const by = Math.max(0, evenDown(reach.y));
  const bw = Math.max(2, Math.min(projW, evenUp(reach.x + reach.width)) - bx);
  const bh = Math.max(2, Math.min(projH, evenUp(reach.y + reach.height)) - by);

  const sx = at((k) => k.src.x);
  const sy = at((k) => k.src.y);
  const sw = at((k) => k.src.width);
  const sh = at((k) => k.src.height);
  const dx = at((k) => k.dest.x);
  const dy = at((k) => k.dest.y);
  const dw = at((k) => k.dest.width);
  const dh = at((k) => k.dest.height);
  const kx = '(' + dw + '/' + sw + ')';
  const ky = '(' + dh + '/' + sh + ')';

  const shift = 'setpts=PTS-STARTPTS+' + fixed(l.start) + '/TB';
  // A source as long as the clip and on the timeline's clock, which is what the
  // expressions read t against.
  const canvas = (colour, w, h, format) => 'color=c=' + colour + ':s=' + w + 'x' + h
    + ':r=' + fps + ':d=' + fixed(l.duration) + ',' + shift + ',format=' + format;
  const tag = (s) => s + n;

  // 2 and 3. The picture, scaled for the moment and laid where its crop goes.
  graph.push('[' + input + ':v]' + chain([
    'fps=' + fps,
    whole ? null : 'crop=' + cut.width + ':' + cut.height + ':' + cut.x + ':' + cut.y,
    shift,
    'format=yuva420p',
    "scale=w='max(2\\,round(" + cut.width + '*' + kx + "))':h='max(2\\,round(" + cut.height + '*' + ky
      + "))':eval=frame",
  ]) + '[' + tag('mv') + ']');
  graph.push(canvas('black@0', bw, bh, 'yuva420p') + '[' + tag('mc') + ']');
  graph.push('[' + tag('mc') + '][' + tag('mv') + "]overlay=x='" + dx + '-' + bx + '-(' + sx + '-' + cut.x + ')*' + kx
    + "':y='" + dy + '-' + by + '-(' + sy + '-' + cut.y + ')*' + ky
    + "':eval=frame:eof_action=pass:format=yuv420[" + tag('mp') + ']');
  // 4. The mask: the moment's destination, white on black.
  graph.push(canvas('white', 16, 16, 'gray')
    + ",scale=w='max(1\\,round(" + dw + "))':h='max(1\\,round(" + dh + "))':eval=frame[" + tag('mw') + ']');
  graph.push(canvas('black', bw, bh, 'gray') + '[' + tag('md') + ']');
  graph.push('[' + tag('md') + '][' + tag('mw') + "]overlay=x='round(" + dx + '-' + bx + ")':y='round(" + dy + '-' + by
    + ")':eval=frame:eof_action=pass[" + tag('mm') + ']');

  // Then the fades and the ceiling, the same as a still picture's, on the alpha
  // the mask has just given it.
  const fades = timeline.fadesOf(l);
  const alpha = timeline.alphaOf(l);
  const label = 'v' + n;
  graph.push('[' + tag('mp') + '][' + tag('mm') + ']' + chain([
    'alphamerge',
    fades.in > 0 ? 'fade=t=in:st=' + fixed(l.start) + ':d=' + fixed(fades.in) + ':alpha=1' : null,
    fades.out > 0
      ? 'fade=t=out:st=' + fixed(l.start + l.duration - fades.out) + ':d=' + fixed(fades.out) + ':alpha=1'
      : null,
    alpha < 1 ? 'colorchannelmixer=aa=' + fixed(alpha) : null,
  ]) + '[' + label + ']');
  const next = 'bg' + n;
  graph.push('[' + prev + '][' + label + ']overlay=' + bx + ':' + by
    + ':eof_action=pass:' + enableExpr(l.start, timeline.endOf(l)) + '[' + next + ']');
  return next;
}

/**
 * V3.4. A picture that moves between keyframes and turns as it does.
 *
 * rotate turns about the middle of what it is handed, and the picture's middle
 * travels, so the reach canvas movingLayer lays the picture on will not do.
 * Here each frame's picture is laid, cut and masked the same way, but on a
 * square centred on the moment's destination and big enough for it at any
 * turn, which is the longest diagonal any keyframe gives it. The square is
 * turned by the moment's angle, an expression of t like every other number of
 * the move, with what it uncovers left clear, and laid on the frame with its
 * middle on the moment's middle.
 */
function movingTurnedLayer(graph, l, n, motion, prev, { input, fps, source }) {
  const times = motion.map((k) => l.start + k.t);
  const at = (pick) => piecewise(times, motion.map(pick));
  const cut = unionOf(motion.map((k) => k.src));
  const whole = source && cut.x === 0 && cut.y === 0
    && cut.width >= evenDown(Number(source.width)) && cut.height >= evenDown(Number(source.height));
  // A multiple of four, so its half is even: overlay rounds an odd position on
  // a subsampled picture to an even one, which measured two pixels high.
  const side = Math.ceil(Math.max(...motion.map((k) => Math.hypot(k.dest.width, k.dest.height))) / 4) * 4 + 4;
  const half = side / 2;

  const sx = at((k) => k.src.x);
  const sy = at((k) => k.src.y);
  const sw = at((k) => k.src.width);
  const sh = at((k) => k.src.height);
  const dx = at((k) => k.dest.x);
  const dy = at((k) => k.dest.y);
  const dw = at((k) => k.dest.width);
  const dh = at((k) => k.dest.height);
  const turn = at((k) => k.turn * Math.PI / 180);
  const kx = '(' + dw + '/' + sw + ')';
  const ky = '(' + dh + '/' + sh + ')';

  const shift = 'setpts=PTS-STARTPTS+' + fixed(l.start) + '/TB';
  const canvas = (colour, w, h, format) => 'color=c=' + colour + ':s=' + w + 'x' + h
    + ':r=' + fps + ':d=' + fixed(l.duration) + ',' + shift + ',format=' + format;
  const tag = (s) => s + n;

  graph.push('[' + input + ':v]' + chain([
    'fps=' + fps,
    whole ? null : 'crop=' + cut.width + ':' + cut.height + ':' + cut.x + ':' + cut.y,
    shift,
    'format=yuva420p',
    "scale=w='max(2\\,round(" + cut.width + '*' + kx + "))':h='max(2\\,round(" + cut.height + '*' + ky
      + "))':eval=frame",
  ]) + '[' + tag('mv') + ']');
  graph.push(canvas('black@0', side, side, 'yuva420p') + '[' + tag('mc') + ']');
  graph.push('[' + tag('mc') + '][' + tag('mv') + "]overlay=x='" + half + '-' + dw + '/2-(' + sx + '-' + cut.x + ')*' + kx
    + "':y='" + half + '-' + dh + '/2-(' + sy + '-' + cut.y + ')*' + ky
    + "':eval=frame:eof_action=pass:format=yuv420[" + tag('mp') + ']');
  graph.push(canvas('white', 16, 16, 'gray')
    + ",scale=w='max(1\\,round(" + dw + "))':h='max(1\\,round(" + dh + "))':eval=frame[" + tag('mw') + ']');
  graph.push(canvas('black', side, side, 'gray') + '[' + tag('md') + ']');
  graph.push('[' + tag('md') + '][' + tag('mw') + "]overlay=x='round(" + half + '-' + dw + "/2)':y='round(" + half + '-' + dh
    + "/2)':eval=frame:eof_action=pass[" + tag('mm') + ']');

  const fades = timeline.fadesOf(l);
  const alpha = timeline.alphaOf(l);
  const label = 'v' + n;
  graph.push('[' + tag('mp') + '][' + tag('mm') + ']' + chain([
    'alphamerge',
    fades.in > 0 ? 'fade=t=in:st=' + fixed(l.start) + ':d=' + fixed(fades.in) + ':alpha=1' : null,
    fades.out > 0
      ? 'fade=t=out:st=' + fixed(l.start + l.duration - fades.out) + ':d=' + fixed(fades.out) + ':alpha=1'
      : null,
    alpha < 1 ? 'colorchannelmixer=aa=' + fixed(alpha) : null,
    "rotate=a='" + turn + "':ow=" + side + ':oh=' + side + ':c=none',
  ]) + '[' + label + ']');
  const next = 'bg' + n;
  graph.push('[' + prev + '][' + label + "]overlay=x='round(" + dx + '+' + dw + '/2-' + half + ")':y='round("
    + dy + '+' + dh + '/2-' + half + ")':eval=frame:eof_action=pass:" + enableExpr(l.start, timeline.endOf(l))
    + '[' + next + ']');
  return next;
}

/**
 * Works out the span of timeline the output covers. `trim` is the project's in
 * and out markers; without them the output is everything up to the last layer's
 * end.
 *
 * **V2.8 item 3: the end may be past the last layer**, and then the output runs
 * on into black. Nothing else in here had to change for that, which is the
 * happy part: the video is already composited onto a black frame built to the
 * output's length, and the audio is already padded to it, so a span that
 * reaches past the material produces exactly what it should. It was only ever
 * this one Math.min that forbade it.
 *
 * Still bounded, by timeline.trimCeiling, so a .lwc with a silly number in it
 * cannot ask ffmpeg for an hour of black past an hour of black.
 */
function outputSpan(layers, trim) {
  const total = timeline.totalDuration(layers);
  const start = Math.max(0, Number(trim && trim.start) || 0);
  const rawEnd = trim && Number.isFinite(Number(trim.end)) ? Number(trim.end) : total;
  const end = Math.min(timeline.trimCeiling(layers), Math.max(start, rawEnd));
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
    // V2.3. A still is one frame, so there is nothing to seek into and nothing
    // that runs out: -loop 1 makes the demuxer hand the same frame over for as
    // long as it is asked, and -t is what stops it. -ss would be meaningless
    // here and -framerate is set so the loop arrives at the project's rate
    // rather than at the demuxer's own default of 25.
    //
    // V3. A generated layer arrives here as the PNG the window drew it into,
    // at the project's size, so it is a still like any image from this point.
    // V3.3. A generated layer that moves between keyframes arrives as the
    // frames the window drew it into, numbered from 0, covering only the
    // stretch where it changes. tpad below holds the first and the last of
    // them for the rest of the clip.
    if (l.frames) {
      args.push('-framerate', String(fps), '-start_number', '0', '-i', l.frames.pattern);
    } else if (timeline.isStill(l)) {
      args.push('-loop', '1', '-framerate', String(fps), '-t', fixed(l.duration), '-i', l.src);
    } else {
      args.push('-ss', fixed(l.sourceIn), '-t', fixed(l.duration), '-i', l.src);
    }
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
      // V3.3. A picture that moves between keyframes takes the road of its
      // own below. One that does not is placed once, as it always was, from
      // its keyframe when it has a single one.
      const motion = geometry.motionOf(l, sources[l.src] || null, project);
      if (motion) {
        // V3.4. One that also turns takes the square road above.
        const mover = motion.some((k) => k.turn) ? movingTurnedLayer : movingLayer;
        prev = mover(graph, l, n, motion, prev, {
          input: indexOf.get(l.id), fps, source: sources[l.src] || null, projW, projH,
        });
        return;
      }
      const placement = geometry.placementAt(l, 0, sources[l.src] || null, project);
      const parts = geometry.filterParts(placement, sources[l.src] || null);
      const label = 'v' + n;

      // fps first: dropping frames before cropping and scaling means the work
      // is not done on frames that are about to be thrown away.
      //
      // Step 22a. The fades come last, and they fade the **alpha** rather than
      // the picture. A plain fade=t=in fades to black, which on a layer sitting
      // over another one paints black across it and punches a hole in the
      // composite for the length of the fade. Fading the alpha lets overlay
      // blend it instead, so a fade reveals whatever is underneath, which is
      // what the user asked for and is also what turns two overlapping layers
      // into a crossfade for nothing. On the bottom layer it comes to the same
      // thing anyway, because the base this is all composited onto is black.
      //
      // After the setpts, and that matters: only once the timestamps have been
      // shifted are they the layer's timeline positions, which is what st is
      // measured in here. The audio side below is the other way round.
      const fades = timeline.fadesOf(l);
      const alpha = timeline.alphaOf(l);
      // V3.4. A still turn: rotate on the placed picture, into the box round
      // it with what the turn uncovers left clear, laid with its middle on the
      // picture's middle. Even sides, for yuva420p.
      const turn = placement ? placement.rotation || 0 : 0;
      let rotate = null;
      let turnedXY = null;
      if (turn && placement) {
        const d = placement.dest;
        const room = geometry.turnedSize(d.width, d.height, turn);
        // Even sides, and two more when that leaves the corner on an odd
        // pixel: overlay rounds an odd position on a subsampled picture to an
        // even one, a pixel off the middle.
        const cx = d.x + d.width / 2;
        const cy = d.y + d.height / 2;
        // A millionth off first: cos 90 is not quite 0 in floating point, and
        // 360.0000001 must not come out as a wider box.
        const fit = (need, c) => {
          const side = evenUp(Math.ceil(need - 1e-6));
          return Math.round(c - side / 2) % 2 ? side + 2 : side;
        };
        const ow = fit(room.width, cx);
        const oh = fit(room.height, cy);
        rotate = 'rotate=a=' + fixed(turn * Math.PI / 180) + ':ow=' + ow + ':oh=' + oh + ':c=none';
        turnedXY = Math.round(cx - ow / 2) + ':' + Math.round(cy - oh / 2);
      }
      // V2.4. An alpha channel is now wanted for two reasons rather than one,
      // so the name says what it is for rather than which of them asked.
      const needsAlpha = fades.in > 0 || fades.out > 0 || alpha < 1 || !!rotate;
      graph.push('[' + indexOf.get(l.id) + ':v]'
        + chain([
          l.frames ? holdFrames(l.frames) : null,
          'fps=' + fps,
          parts && parts.crop,
          parts && parts.scale,
          'setpts=PTS-STARTPTS+' + fixed(l.start) + '/TB',
          // Only when something wants one: an alpha channel every layer
          // carried would be a conversion on every frame of every project to
          // no end.
          needsAlpha ? 'format=yuva420p' : null,
          rotate,
          fades.in > 0
            ? 'fade=t=in:st=' + fixed(l.start) + ':d=' + fixed(fades.in) + ':alpha=1'
            : null,
          fades.out > 0
            ? 'fade=t=out:st=' + fixed(l.start + l.duration - fades.out)
              + ':d=' + fixed(fades.out) + ':alpha=1'
            : null,
          // V2.4. The layer's maximum alpha, last, because it is the ceiling
          // the two ramps rise to rather than a third ramp of its own.
          // colorchannelmixer multiplies the alpha it is handed rather than
          // replacing it, so a layer at 60% that fades in arrives at 60% and
          // not at 100%. That is the same multiply layerAlphaAt does in the
          // preview, which is what keeps the file and the window one picture.
          alpha < 1 ? 'colorchannelmixer=aa=' + fixed(alpha) : null,
        ])
        + '[' + label + ']');

      const next = 'bg' + n;
      const xy = turnedXY || (parts ? parts.overlay.slice('overlay='.length) : '0:0');
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
      const fades = timeline.fadesOf(l);
      graph.push('[' + indexOf.get(l.id) + ':a]'
        + chain([
          'asetpts=PTS-STARTPTS',
          l.volume !== 1 ? 'volume=' + fixed(l.volume) : null,
          // Step 22a, and the opposite placement to the video above. adelay has
          // to stay last, so the fades go before it, which means they are still
          // in the layer's own timebase: a fade in starts at 0 here, where on
          // the video side it starts at the layer's timeline position.
          fades.in > 0 ? 'afade=t=in:st=' + fixed(0) + ':d=' + fixed(fades.in) : null,
          fades.out > 0
            ? 'afade=t=out:st=' + fixed(l.duration - fades.out)
              + ':d=' + fixed(fades.out)
            : null,
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
