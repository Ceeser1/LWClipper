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
const os = require('os');
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

// ---- V3.8.1. A fade that is not a straight line ----
//
// ffmpeg's fade filter only draws straight lines, and afade only has the curves
// it has been given, none of which is the quad in-out. So a layer with a curved
// fade is faded by the same sum the window does, written as an expression:
//
//   a sound   aeval, which multiplies every sample by the gain at its own time
//   a picture a 16x16 grey square whose brightness is the gain at each frame's
//             time (geq on 256 pixels costs nothing), scaled to the picture,
//             multiplied into its alpha by blend, and put back with alphamerge
//
// A layer whose fades are all straight keeps the fade and afade filters it has
// always had, so a project without curves exports exactly as before.

/** ffmpeg parses a comma in an expression as the end of the filter. */
function escapeExpr(expr) {
  return expr.replace(/,/g, '\\,');
}

// V4.10. Every fade in here is read through alphaFadesOf: an end that has a
// transition is not faded at all, the transition being what happens there.

/** Whether a layer has a fade that is not linear, and so needs the expression. */
function hasCurvedFade(l) {
  const fades = timeline.alphaFadesOf(l);
  const curves = timeline.fadeCurvesOf(l);
  return (fades.in > 0 && curves.in !== 'linear') || (fades.out > 0 && curves.out !== 'linear');
}

/**
 * Both of a layer's fades as one gain between 0 and 1, an expression of `time`,
 * the seconds into the layer. The window's fadeAlphaAt, in ffmpeg's words.
 */
function fadeGainExpr(l, time) {
  const fades = timeline.alphaFadesOf(l);
  const curves = timeline.fadeCurvesOf(l);
  const parts = [];
  if (fades.in > 0) {
    parts.push(timeline.fadeCurveExpr(curves.in, 'clip(' + time + '/' + fixed(fades.in) + ',0,1)'));
  }
  if (fades.out > 0) {
    parts.push('(1-' + timeline.fadeCurveExpr(curves.out,
      'clip((' + time + '-' + fixed(l.duration - fades.out) + ')/' + fixed(fades.out) + ',0,1)') + ')');
  }
  return parts.join('*') || '1';
}

/**
 * Fades a picture's alpha by a curve. `input` is the picture's label with its
 * brackets, `tail` the filters that follow the fade on the same chain, and the
 * result is left in `label`. The ramp is laid on the layer's own timeline
 * position, like the picture, so the two meet frame for frame.
 */
function curvedFade(graph, l, n, input, fps, tail, label) {
  const k = String(n);
  graph.push(input + 'split[fs' + k + '][fb' + k + ']');
  graph.push('[fb' + k + ']alphaextract[fx' + k + ']');
  graph.push('color=c=white:s=16x16:r=' + fps + ':d=' + fixed(l.duration)
    + ",format=gray,geq=lum='255*(" + escapeExpr(fadeGainExpr(l, 'T'))
    + ")',setpts=PTS-STARTPTS+" + fixed(l.start) + '/TB[fr' + k + ']');
  graph.push('[fr' + k + '][fx' + k + ']scale2ref[fq' + k + '][fy' + k + ']');
  graph.push('[fy' + k + '][fq' + k + ']blend=all_mode=multiply:shortest=1[fm' + k + ']');
  graph.push('[fs' + k + '][fm' + k + ']' + chain(['alphamerge', ...tail]) + '[' + label + ']');
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
//
// V4.10. `gaps` are stretches in the middle the sequence does not cover
// either, each `{ after, frames }`: once `after` of its frames have gone by,
// the last of them is held for `frames` more. A clip with a transition at
// each end is drawn for the two transitions and held between them. The
// frames' own times are moved on past each gap, and fps fills what that
// leaves with the frame before it. `fps` is the project's rate.
function holdFrames(frames, fps) {
  const lead = Math.max(0, Number(frames.lead) || 0);
  const tail = Math.max(0, Number(frames.tail) || 0);
  const gaps = (Array.isArray(frames.gaps) ? frames.gaps : [])
    .filter((g) => g && Number(g.after) > 0 && Number(g.frames) > 0);
  const parts = [];
  if (gaps.length && fps) {
    const skipped = gaps.map((g) => Math.round(g.frames) + '*gte(N\\,' + Math.round(g.after) + ')').join('+');
    parts.push("setpts='(N+" + skipped + ')/(' + fps + "*TB)'", 'fps=' + fps);
  }
  if (lead || tail) {
    parts.push('tpad=' + [
      lead ? 'start_mode=clone:start_duration=' + fixed(lead) : null,
      tail ? 'stop_mode=clone:stop_duration=' + fixed(tail) : null,
    ].filter(Boolean).join(':'));
  }
  return parts.length ? parts.join(',') : null;
}

/** An ffmpeg expression of t: the values at the times, blended between them. */
function piecewise(times, values) {
  const num = (v) => fixed(v);
  // V4.10. One number the whole way is that number: a slide to the right
  // never changes its height, and a transition's dozen moments would
  // otherwise say it a dozen times in every expression that uses it.
  if (values.every((v) => v === values[0])) return '(' + num(values[0]) + ')';
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

// ---- V3.6. Masks ----
//
// A mask arrives as the window drew it, white where the picture shows and
// black where it does not, the size of the picture or of the largest the
// picture gets: one PNG, or the frames of the stretch where the mask itself
// changes, held at either end like a moving generated layer's. It is the
// picture's own shape, so it is scaled to the picture as it is placed, on
// every frame where the picture moves, and becomes the picture's alpha
// before the turn, the fades and the ceiling, which all act on that alpha.

// ---- V4.12. A still decoded once ----
//
// A still used to come in as `-loop 1 -framerate F -t D -i file`, which has
// the demuxer hand the same file over for every frame of the clip, and the
// decoder open and decode it every time: a text, which is a PNG the size of
// the project, cost a PNG decode and a conversion out of RGBA for each frame
// it was on screen. Measured with the bundled ffmpeg on 60 seconds of 1080p:
// 5.9 s for the video alone, 10.1 s with one text over it.
//
// Now the file is read once (`-framerate F -i file`, one frame) and that one
// frame is held for as long as the clip is by the loop filter, which keeps
// the decoded picture and hands it on again. Everything that is the same on
// every frame (the cut, the size, the pixel format) is done before the hold,
// so it is done once as well. The same 60 seconds: 6.4 s, and the file frame
// for frame the one the old graph wrote (PSNR infinite over 1440 frames).
//
// The three stills an export has all take it: a picture layer (an image, or
// a text, shape or bar as the window drew it), a mask's PNG, and the PNG of
// where an Obscure or Pixelate acts. A sequence of drawn frames is not a
// still and comes in as it did.

/** The input flags of a still: read once, its one frame at the project's rate. */
function stillInput(src, fps) {
  return ['-framerate', String(fps), '-i', src];
}

/** One decoded frame handed on again and again for `duration` seconds. */
function holdStill(duration) {
  return 'loop=loop=-1:size=1:start=0,trim=duration=' + fixed(duration);
}

/** Whether a layer's own input is one still picture (not a sequence of drawn frames). */
function oneStill(l) {
  return timeline.isStill(l) && !l.frames;
}

/**
 * The mask's input, on the timeline's clock and in grey. `scale`, when given,
 * is the filter that brings it to the picture's size where that size is the
 * same the whole clip long.
 *
 * V4.12. A mask that is one PNG is made grey and sized once and then held;
 * the frames of a mask that changes are converted one by one as before.
 */
function maskSource(l, input, fps, scale = null) {
  const shift = 'setpts=PTS-STARTPTS+' + fixed(l.start) + '/TB';
  if (!l.maskFile.frames) {
    return '[' + input + ':v]' + chain(['format=gray', scale, holdStill(l.duration), 'fps=' + fps, shift]);
  }
  return '[' + input + ':v]' + chain([
    holdFrames(l.maskFile.frames, fps),
    'fps=' + fps,
    shift,
    'format=gray',
    scale,
  ]);
}

/**
 * Whether the picture has an alpha of its own that the mask must keep: a
 * PNG's, which alphamerge would otherwise replace. A video has none, and its
 * picture is opaque wherever the mask does not cut it.
 */
function ownAlpha(l) {
  return l.kind === 'image' && timeline.seeThrough(l);
}

// ---- V4.7. Obscure and Pixelate ----
//
// Both are done to the layer's picture as the file has it, before it is
// cropped, scaled, placed or turned, so nothing after this point has to know
// about them, the moving layers included. The window hands over, for each, the
// part of the source it touches and a PNG of where it acts in that part
// (export.js exportCovers). That part is cut out, filtered, given the PNG as
// its alpha and laid back where it came from.
//
// A picture with an alpha of its own, a PNG, cannot be done that way: the
// filtered part laid over the picture would add its see-through to the
// picture's, and come out more solid than either (measured: 90 over 90 gave
// 148). There the whole picture is filtered and the two are blended by the
// PNG, maskedmerge, alpha and all, at 4:4:4 where one grey plane can stand
// for all four. A PNG is a still, so the whole frame costs nothing to speak of.
//
// Measured with the bundled ffmpeg on 2026-11-12: gblur on 4:2:0 blurs the
// colour twice as far as the brightness, since it takes one sigma for planes
// of two sizes, so the blur is made at 4:4:4; and at its default one step it
// is not a Gaussian, the ramp of an edge coming out a fifth narrower than
// the sigma says. Six steps is within three percent, which is what the
// preview's blur is. pixelize takes an odd block one smaller on 4:2:0, so
// the block always arrives even (timeline.js pixelateBlock).

/**
 * What a layer's chain starts from: its input as it is, or with covers the
 * label of the picture with them laid on, at the project's rate. `inputs` is
 * each cover's PNG input, in their order.
 */
function coverHead(graph, l, n, input, fps, inputs, source) {
  // V4.11. At the layer's speed from the very start, covers and all.
  // V4.12. A still has no speed; it is its one frame, held for the clip.
  const plain = '[' + input + ':v]' + (oneStill(l) ? holdStill(l.duration) + ',' : speedHead(l, fps));
  const files = (Array.isArray(l.coverFiles) && l.type === 'video' ? l.coverFiles : [])
    .map((f, i) => ({ ...f, input: inputs && inputs[i] }))
    .filter((f) => {
      const r = f.region;
      if (f.input === undefined || !r) return false;
      const whole = [r.x, r.y, r.width, r.height].every((v) => Number.isInteger(v) && v >= 0);
      if (!whole || r.width < 2 || r.height < 2) return false;
      // Never past a source this module knows the size of.
      return !source || !(source.width > 0)
        || (r.x + r.width <= source.width && r.y + r.height <= source.height);
    });
  if (!files.length) return plain;
  const alpha = ownAlpha(l);
  let cur = 'cv' + n + 's';
  graph.push(plain + chain(['fps=' + fps, 'format=' + (alpha ? 'yuva420p' : 'yuv420p')]) + '[' + cur + ']');
  const blended = alpha && source && source.width > 0 && source.height > 0;
  files.forEach((f, i) => {
    const r = f.region;
    const t = 'cv' + n + 'x' + i;
    const blur = 'gblur=sigma=' + fixed(Math.min(1024, Math.max(0.1, Number(f.sigma) || 0.1))) + ':steps=6';
    const block = Math.max(2, Math.round(Number(f.block) || 2));
    const blocks = 'pixelize=w=' + block + ':h=' + block;
    // V4.8. Where it acts as one PNG, or with areas that move as the frames
    // of the stretch where they do, held at either end like a moving mask's.
    // Both this and the picture count from the clip's first frame here, the
    // layer's place on the timeline being given to it further down.
    // V4.12. The one PNG is made grey and sized once, and then held.
    const moving = !!(f.frames && f.frames.pattern);
    const where = '[' + f.input + ':v]' + chain(moving
      ? [holdFrames(f.frames, fps), 'fps=' + fps, 'format=gray', 'scale=' + r.width + ':' + r.height]
      : ['format=gray', 'scale=' + r.width + ':' + r.height, holdStill(l.duration), 'fps=' + fps]);
    if (blended) {
      graph.push('[' + cur + ']format=yuva444p,split[' + t + 'a][' + t + 'b]');
      // V4.8. Premultiplied round the filter, as the preview's canvas is: a
      // blur or a block that takes in both solid and see-through pixels must
      // weigh each colour by how much of it shows. Filtered plane by plane,
      // colour apart from alpha, the colour under a see-through part came
      // through at full weight (measured on a PNG half solid and half at 35%:
      // a blurred edge up to 44 of 255 off the preview, 12 this way; a block
      // across that edge 23 off, 6 this way).
      graph.push('[' + t + 'b]premultiply=inplace=1,' + (f.kind === 'obscure' ? blur : blocks)
        + ',unpremultiply=inplace=1[' + t + 'c]');
      graph.push(where + ',pad=' + Math.round(source.width) + ':' + Math.round(source.height) + ':' + r.x + ':' + r.y
        + ':black,mergeplanes=0x00000000:yuva444p[' + t + 'm]');
      graph.push('[' + t + 'a][' + t + 'c][' + t + 'm]maskedmerge,format=yuva420p[' + t + 'o]');
      cur = t + 'o';
      return;
    }
    graph.push('[' + cur + ']split[' + t + 'a][' + t + 'b]');
    graph.push('[' + t + 'b]crop=' + r.width + ':' + r.height + ':' + r.x + ':' + r.y + ','
      + (f.kind === 'obscure' ? 'format=yuv444p,' + blur : blocks) + '[' + t + 'c]');
    graph.push(where + '[' + t + 'm]');
    graph.push('[' + t + 'c][' + t + 'm]alphamerge[' + t + 'h]');
    graph.push('[' + t + 'a][' + t + 'h]overlay=x=' + r.x + ':y=' + r.y + ':format=yuv420[' + t + 'o]');
    cur = t + 'o';
  });
  return '[' + cur + ']';
}

/**
 * V4.10. The two inputs a moving layer's alphamerge takes: its picture laid
 * on its canvas, and where the picture shows. A picture with an alpha of its
 * own, a PNG, has that multiplied into where it shows first, or the merge
 * would put the plain rectangle in its place and the see-through parts would
 * come out solid. Found with a PNG sliding in; a PNG moved by keyframes took
 * the same road and lost its alpha the same way.
 */
//
// Both are brought to the full range before they are multiplied. An alpha is
// 0 to 255, but where the picture shows is a grey video made from a colour
// source, which is 16 to 235, and ffmpeg matches the two by squeezing the
// alpha into that as well: measured with the bundled ffmpeg, a solid part of
// a PNG then came out at 0.91 and a half see-through one at 0.45, and over a
// video worse, 0.74 and 0.37 with a faint veil over everything the picture
// travels across. Multiplied at the full range they come out 1 and 0.5.
function keepOwnAlpha(graph, l, tag) {
  if (!ownAlpha(l)) return '[' + tag('mp') + '][' + tag('mm') + ']';
  graph.push('[' + tag('mp') + ']split[' + tag('mq') + '][' + tag('mr') + ']');
  graph.push('[' + tag('mr') + ']alphaextract,scale=out_range=full[' + tag('ma') + ']');
  graph.push('[' + tag('mm') + ']scale=out_range=full[' + tag('mn') + ']');
  graph.push('[' + tag('ma') + '][' + tag('mn') + ']blend=all_mode=multiply[' + tag('mb') + ']');
  return '[' + tag('mq') + '][' + tag('mb') + ']';
}

// ---- V4.11. Speed ----
//
// A layer at another speed shows the same part of its source in more or less
// time (timeline.js "Speed"). The input is read for as long as that part is,
// and its frames' times are divided by the speed before anything else looks
// at them, so from there on the layer is as long as it is on the timeline and
// every later filter, the frame rate first, finds it at its own pace. A sound
// is stretched by atempo, which keeps its pitch, as the preview's player
// does. atempo takes a half to a hundred, and above two it drops samples
// rather than blending them, so a speed outside a half to two goes in steps.

/**
 * What goes first on a picture's chain to bring it to the layer's speed: its
 * frames' times divided by the speed, and the project's rate taken from them
 * there and then. Rounded up, which gives each frame of the output the last
 * frame of the source that had begun by its own moment: the frame the
 * preview shows with the playhead on it. Left to round to the nearest, as it
 * does at the source's own speed where the two are the same, the file ran up
 * to a source frame ahead of the preview at a speed like 1.37 (measured).
 */
function speedHead(l, fps) {
  const speed = timeline.speedOf(l);
  return speed === 1 ? '' : 'setpts=(PTS-STARTPTS)/' + fixed(speed) + ',fps=' + fps + ':round=up,';
}

/** The atempo filters that bring a sound to a speed, none for 1. */
function tempoFilters(speed) {
  const out = [];
  let left = speed;
  if (!(left > 0) || Math.abs(left - 1) < 1e-9) return out;
  while (left > 2 + 1e-9) {
    out.push('atempo=2.0');
    left /= 2;
  }
  while (left < 0.5 - 1e-9) {
    out.push('atempo=0.5');
    left /= 0.5;
  }
  if (Math.abs(left - 1) > 1e-9) out.push('atempo=' + fixed(left));
  return out;
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
function movingLayer(graph, l, n, motion, prev, { input, fps, source, projW, projH, mask, head, from }) {
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
  graph.push((head || '[' + input + ':v]') + chain([
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
  // 4. The mask: the moment's destination, white on black. V3.6. Or the
  // layer's own mask, scaled the same way, so it moves with the picture.
  graph.push((mask === undefined ? canvas('white', 16, 16, 'gray') : maskSource(l, mask, fps))
    + ",scale=w='max(1\\,round(" + dw + "))':h='max(1\\,round(" + dh + "))':eval=frame[" + tag('mw') + ']');
  graph.push(canvas('black', bw, bh, 'gray') + '[' + tag('md') + ']');
  graph.push('[' + tag('md') + '][' + tag('mw') + "]overlay=x='round(" + dx + '-' + bx + ")':y='round(" + dy + '-' + by
    + ")':eval=frame:eof_action=pass[" + tag('mm') + ']');

  // Then the fades and the ceiling, the same as a still picture's, on the alpha
  // the mask has just given it.
  const fades = timeline.alphaFadesOf(l);
  const alpha = timeline.alphaOf(l);
  const label = 'v' + n;
  const merge = keepOwnAlpha(graph, l, tag);
  if (hasCurvedFade(l)) {
    graph.push(merge + 'alphamerge[' + tag('mf') + ']');
    curvedFade(graph, l, n, '[' + tag('mf') + ']', fps,
      [alpha < 1 ? 'colorchannelmixer=aa=' + fixed(alpha) : null], label);
  } else {
    graph.push(merge + chain([
      'alphamerge',
      fades.in > 0 ? 'fade=t=in:st=' + fixed(l.start) + ':d=' + fixed(fades.in) + ':alpha=1' : null,
      fades.out > 0
        ? 'fade=t=out:st=' + fixed(l.start + l.duration - fades.out) + ':d=' + fixed(fades.out) + ':alpha=1'
        : null,
      alpha < 1 ? 'colorchannelmixer=aa=' + fixed(alpha) : null,
    ]) + '[' + label + ']');
  }
  const next = 'bg' + n;
  graph.push('[' + prev + '][' + label + ']overlay=' + bx + ':' + by
    + ':eof_action=pass:' + enableExpr(from === undefined ? l.start : from, timeline.endOf(l)) + '[' + next + ']');
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
function movingTurnedLayer(graph, l, n, motion, prev, { input, fps, source, mask, head, from }) {
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

  graph.push((head || '[' + input + ':v]') + chain([
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
  graph.push((mask === undefined ? canvas('white', 16, 16, 'gray') : maskSource(l, mask, fps))
    + ",scale=w='max(1\\,round(" + dw + "))':h='max(1\\,round(" + dh + "))':eval=frame[" + tag('mw') + ']');
  graph.push(canvas('black', side, side, 'gray') + '[' + tag('md') + ']');
  graph.push('[' + tag('md') + '][' + tag('mw') + "]overlay=x='round(" + half + '-' + dw + "/2)':y='round(" + half + '-' + dh
    + "/2)':eval=frame:eof_action=pass[" + tag('mm') + ']');

  const fades = timeline.alphaFadesOf(l);
  const alpha = timeline.alphaOf(l);
  const label = 'v' + n;
  const turnFilter = "rotate=a='" + turn + "':ow=" + side + ':oh=' + side + ':c=none';
  const merge = keepOwnAlpha(graph, l, tag);
  if (hasCurvedFade(l)) {
    graph.push(merge + 'alphamerge[' + tag('mf') + ']');
    curvedFade(graph, l, n, '[' + tag('mf') + ']', fps,
      [alpha < 1 ? 'colorchannelmixer=aa=' + fixed(alpha) : null, turnFilter], label);
  } else {
    graph.push(merge + chain([
      'alphamerge',
      fades.in > 0 ? 'fade=t=in:st=' + fixed(l.start) + ':d=' + fixed(fades.in) + ':alpha=1' : null,
      fades.out > 0
        ? 'fade=t=out:st=' + fixed(l.start + l.duration - fades.out) + ':d=' + fixed(fades.out) + ':alpha=1'
        : null,
      alpha < 1 ? 'colorchannelmixer=aa=' + fixed(alpha) : null,
      turnFilter,
    ]) + '[' + label + ']');
  }
  const next = 'bg' + n;
  graph.push('[' + prev + '][' + label + "]overlay=x='round(" + dx + '+' + dw + '/2-' + half + ")':y='round("
    + dy + '+' + dh + '/2-' + half + ")':eval=frame:eof_action=pass:"
    + enableExpr(from === undefined ? l.start : from, timeline.endOf(l))
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
  encoder = 'cpu',
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
  // V3.6. Each masked picture's mask is an input of its own, after its layer's.
  const maskIndexOf = new Map();
  const addMask = (l) => {
    if (!l.maskFile || l.type !== 'video') return;
    maskIndexOf.set(l.id, inputs.length);
    inputs.push(null);
    if (l.maskFile.frames) {
      args.push('-framerate', String(fps), '-start_number', '0', '-i', l.maskFile.frames.pattern);
    } else {
      // V4.12. Read once and held in the graph, see "A still decoded once".
      args.push(...stillInput(l.maskFile.src, fps));
    }
  };
  // V4.7. And each Obscure or Pixelate's picture of where it acts, after those.
  const coverInputsOf = new Map();
  const addCovers = (l) => {
    if (!Array.isArray(l.coverFiles) || l.type !== 'video') return;
    coverInputsOf.set(l.id, l.coverFiles.map((f) => {
      // V4.8. One whose areas move comes as numbered frames, like a moving mask.
      const frames = f && f.frames && f.frames.pattern ? f.frames : null;
      if (!f || (!f.src && !frames)) return undefined;
      inputs.push(null);
      if (frames) args.push('-framerate', String(fps), '-start_number', '0', '-i', frames.pattern);
      else args.push(...stillInput(f.src, fps));
      return inputs.length - 1;
    }));
  };
  for (const l of live) {
    indexOf.set(l.id, inputs.length);
    inputs.push(l);
    // V2.3. A still is one frame, so there is nothing to seek into and nothing
    // that runs out. -ss would be meaningless here and -framerate is set so
    // the frame arrives at the project's rate rather than at the demuxer's
    // own default of 25.
    // V4.12. It is read once and held in the graph for as long as the clip
    // is (holdStill), where `-loop 1 ... -t` had it decoded again for every
    // frame.
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
      args.push(...stillInput(l.src, fps));
    } else {
      // V4.11. As much of the source as the layer shows, which at another
      // speed is not as long as the layer is.
      args.push('-ss', fixed(l.sourceIn), '-t', fixed(l.duration * timeline.speedOf(l)), '-i', l.src);
    }
    addMask(l);
    addCovers(l);
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
      // V4.10. Or through a slide or a zoom: the same kind of list, from the
      // same sum the preview draws by. A generated layer's transition is in
      // the frames the window drew, so it is not placed again here.
      const steps = l.kind === 'gen' ? [] : timeline.transitionSteps(l);
      const motion = (steps.length && geometry.shownKeys(l, sources[l.src] || null, project, steps))
        || geometry.motionOf(l, sources[l.src] || null, project);
      // V4.7. What the layer's chain starts from, its covers laid on.
      const from = coverHead(graph, l, n, indexOf.get(l.id), fps, coverInputsOf.get(l.id), sources[l.src] || null);
      if (motion) {
        // V3.4. One that also turns takes the square road above.
        const mover = motion.some((k) => k.turn) ? movingTurnedLayer : movingLayer;
        prev = mover(graph, l, n, motion, prev, {
          input: indexOf.get(l.id), fps, source: sources[l.src] || null, projW, projH, mask: maskIndexOf.get(l.id),
          head: from,
          // At the very start of a slide or a zoom in there is nothing of the
          // picture yet, where the smallest it can be scaled to is two pixels.
          from: steps.length && steps[0].half === 'in' ? l.start + 0.001 : l.start,
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
      const fades = timeline.alphaFadesOf(l);
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
      // V3.6. A mask is a third.
      const maskInput = placement ? maskIndexOf.get(l.id) : undefined;
      const needsAlpha = fades.in > 0 || fades.out > 0 || alpha < 1 || !!rotate || maskInput !== undefined;
      // V4.12. A still with nothing laid on it is cut, sized and converted
      // once, and only then held for the clip. The format is always said
      // here: it is the one the overlay below takes a picture in anyway, and
      // saying it before the hold is what makes that conversion happen once
      // instead of on every frame.
      const bare = '[' + indexOf.get(l.id) + ':v]';
      const once = oneStill(l) && from === bare + holdStill(l.duration) + ',';
      const picture = once
        ? bare + chain([
          parts && parts.crop,
          parts && parts.scale,
          'format=yuva420p',
          holdStill(l.duration),
          'fps=' + fps,
          'setpts=PTS-STARTPTS+' + fixed(l.start) + '/TB',
        ])
        : from + chain([
          l.frames ? holdFrames(l.frames, fps) : null,
          'fps=' + fps,
          parts && parts.crop,
          parts && parts.scale,
          'setpts=PTS-STARTPTS+' + fixed(l.start) + '/TB',
          // Only when something wants one: an alpha channel every layer
          // carried would be a conversion on every frame of every project to
          // no end.
          needsAlpha ? 'format=yuva420p' : null,
        ]);
      // V3.6. The mask scaled to the picture as it is placed and made its
      // alpha, multiplied into the alpha a PNG already has rather than put in
      // its place. Then on through the turn and the fades as any picture.
      let head = picture;
      if (maskInput !== undefined) {
        const d = placement.dest;
        graph.push(picture + '[mp' + n + ']');
        graph.push(maskSource(l, maskInput, fps, 'scale=' + d.width + ':' + d.height) + '[mk' + n + ']');
        if (ownAlpha(l)) {
          graph.push('[mp' + n + ']split[mq' + n + '][mr' + n + ']');
          graph.push('[mr' + n + ']alphaextract[ma' + n + ']');
          graph.push('[ma' + n + '][mk' + n + ']blend=all_mode=multiply[mb' + n + ']');
          head = '[mq' + n + '][mb' + n + ']alphamerge';
        } else {
          head = '[mp' + n + '][mk' + n + ']alphamerge';
        }
      }
      // V2.4. The layer's maximum alpha, last, because it is the ceiling the
      // two ramps rise to rather than a third ramp of its own.
      // colorchannelmixer multiplies the alpha it is handed rather than
      // replacing it, so a layer at 60% that fades in arrives at 60% and not at
      // 100%. That is the same multiply layerAlphaAt does in the preview, which
      // is what keeps the file and the window one picture.
      const ceiling = alpha < 1 ? 'colorchannelmixer=aa=' + fixed(alpha) : null;
      if (hasCurvedFade(l)) {
        // V3.8.1. A fade with a curve: the picture so far, then the curved fade.
        graph.push(chain([head, rotate]) + '[fh' + n + ']');
        curvedFade(graph, l, n, '[fh' + n + ']', fps, [ceiling], label);
      } else {
        graph.push(chain([
            head,
            rotate,
            fades.in > 0
              ? 'fade=t=in:st=' + fixed(l.start) + ':d=' + fixed(fades.in) + ':alpha=1'
              : null,
            fades.out > 0
              ? 'fade=t=out:st=' + fixed(l.start + l.duration - fades.out)
                + ':d=' + fixed(fades.out) + ':alpha=1'
              : null,
            ceiling,
          ])
          + '[' + label + ']');
      }

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
      const fades = timeline.alphaFadesOf(l);
      graph.push('[' + indexOf.get(l.id) + ':a]'
        + chain([
          'asetpts=PTS-STARTPTS',
          // V4.11. Its speed first, so the fades after it are in the
          // timeline's seconds like everything else about the layer.
          ...tempoFilters(timeline.speedOf(l)),
          l.volume !== 1 ? 'volume=' + fixed(l.volume) : null,
          // Step 22a, and the opposite placement to the video above. adelay has
          // to stay last, so the fades go before it, which means they are still
          // in the layer's own timebase: a fade in starts at 0 here, where on
          // the video side it starts at the layer's timeline position.
          // V3.8.1. A curved fade is a gain per sample instead, in the layer's
          // own time like the afade it replaces. val(ch) is the sample of each
          // channel in turn, so a stereo layer stays stereo.
          ...(hasCurvedFade(l)
            ? ["aeval='val(ch)*" + escapeExpr(fadeGainExpr(l, 't')) + "':c=same"]
            : [
              fades.in > 0 ? 'afade=t=in:st=' + fixed(0) + ':d=' + fixed(fades.in) : null,
              fades.out > 0
                ? 'afade=t=out:st=' + fixed(l.duration - fades.out)
                  + ':d=' + fixed(fades.out)
                : null,
            ]),
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
    args.push(...videoTrackArgs(format, compression, encoder));
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

// V4.10. Windows will not start a process whose command line is longer than
// 32,767 characters, and the filter graph is one argument of it. A picture
// that moves is said in expressions of t, every number of its move once for
// each stretch between two moments, so a few clips eased through a slide can
// reach that. Past this length the graph goes to ffmpeg in a file instead,
// which it reads with the same parser.
const GRAPH_ARG_MAX = 24000;

/**
 * The argv with its filter graph taken out into `graphFile` when the whole
 * command would be too long: `{ args, graph }`, `graph` being the text to
 * write there, or null when the argv is handed back as it was.
 */
function spillGraph(args, graphFile, limit = GRAPH_ARG_MAX) {
  const at = args.indexOf('-filter_complex');
  const length = args.reduce((n, a) => n + String(a).length + 3, 0);
  if (at < 0 || length <= limit) return { args, graph: null };
  const next = args.slice();
  next.splice(at, 2, '-/filter_complex', graphFile);
  return { args: next, graph: args[at + 1] };
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
  encoder = 'cpu',
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
  const built = buildComposeArgs({
    layers, project, trim, output: out, format, compression, sources, encoder,
  });
  // V4.10. A graph too long for a command line is read from a file.
  const graphFile = path.join(os.tmpdir(), 'lwclipper-graph-' + process.pid + '-' + Date.now() + '.txt');
  const { args, graph } = spillGraph(built, graphFile);
  if (graph !== null) fs.writeFileSync(graphFile, graph);

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
  } finally {
    if (graph !== null) {
      try {
        fs.unlinkSync(graphFile);
      } catch {
        // Already gone, or still held: the temp folder is the system's to sweep.
      }
    }
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

module.exports = {
  buildComposeArgs, outputSpan, enableExpr, sourceSizes, render, spillGraph, GRAPH_ARG_MAX, tempoFilters,
};
