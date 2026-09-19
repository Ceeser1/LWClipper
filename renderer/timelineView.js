'use strict';

// Where a second sits on the timeline, and what second a pixel is.
//
// The whole view is two numbers: scale, in pixels per second, and scroll, the
// second sitting at the left edge. Every gesture returns a new pair rather than
// mutating one, which is the same shape src/timeline.js uses for layers and for
// the same reason: nothing can be half-applied.
//
// Kept out of app.js because the awkward parts, anchored zoom and the tick
// ladder, are arithmetic that should be tested rather than eyeballed in a
// window. Loaded as a classic script beside app.js, which cannot require()
// anything: the renderer is sandboxed with no node integration. The export at
// the bottom is for node --test only.

// A second this wide is about thirteen pixels a frame at 30fps, which is as far
// in as anything without frame-level editing has a use for.
const MAX_PX_PER_SEC = 400;

// Empty timeline kept reachable past the end of the content, so there is
// somewhere to drag a layer out to. It is headroom, not length: the output is
// only ever as long as its last layer ends, so an hour of empty timeline costs
// nothing and is never rendered.
//
// It sets both limits. Panning stops when the left edge reaches it, and zooming
// out stops when the whole of it fits the frame, so a one minute clip zooms out
// to an hour and a minute and a three hour one zooms out to four hours. Either
// way the far end of what can be reached is the far end of what can be seen.
const PAN_HEADROOM = 3600;

// A labelled mark needs room for its own label plus a gap. Below this the ruler
// has more labels than it has pixels to put them on.
const MIN_LABEL_GAP = 64;

// Unlabelled marks are dropped rather than drawn as a smear once they get this
// close together.
const MIN_MINOR_GAP = 7;

// Seconds between labelled marks, and how many parts each one is divided into.
// The divisors are picked so the small marks land on round numbers wherever the
// step allows: 15/3 and 30/6 are both 5s, 60/4 is 15s, 900/3 is 5 minutes.
const TICK_STEPS = [
  { step: 0.1, minor: 5 },
  { step: 0.2, minor: 4 },
  { step: 0.5, minor: 5 },
  { step: 1, minor: 5 },
  { step: 2, minor: 4 },
  { step: 5, minor: 5 },
  { step: 10, minor: 5 },
  { step: 15, minor: 3 },
  { step: 30, minor: 6 },
  { step: 60, minor: 4 },
  { step: 120, minor: 4 },
  { step: 300, minor: 5 },
  { step: 600, minor: 5 },
  { step: 900, minor: 3 },
  { step: 1800, minor: 6 },
  { step: 3600, minor: 4 },
];

// Microsecond resolution, matching src/timeline.js, so a time read off the
// ruler and a time held in the model round the same way.
function round(t) {
  return Math.round(t * 1e6) / 1e6;
}

/**
 * The last second the view can reach: the end of the content plus the empty
 * headroom past it.
 */
function reachOf(duration) {
  if (!(duration > 0)) return 0;
  return duration + PAN_HEADROOM;
}

/** The scale at which the whole of duration is exactly one width across. */
function fitScale(duration, width) {
  if (!(duration > 0) || !(width > 0)) return 1;
  return width / duration;
}

/**
 * The furthest out the view may go: the whole reachable timeline across the
 * frame, and no further, since there is nothing beyond it to look at.
 */
function minScale(duration, width) {
  return fitScale(reachOf(duration), width);
}

function clampScale(scale, duration, width) {
  const fit = fitScale(duration, width);
  if (!Number.isFinite(scale)) return fit;
  // A clip shorter than the frame needs a scale above the cap to be shown
  // whole, and being shown whole wins.
  return Math.min(Math.max(scale, minScale(duration, width)),
    Math.max(fit, MAX_PX_PER_SEC));
}

/** How far right the left edge can go before it runs past the headroom. */
function maxScroll(scale, duration, width) {
  if (!(scale > 0) || !(duration > 0) || !(width > 0)) return 0;
  return Math.max(0, reachOf(duration) - width / scale);
}

function clampScroll(scroll, scale, duration, width) {
  if (!Number.isFinite(scroll)) return 0;
  return Math.min(Math.max(scroll, 0), maxScroll(scale, duration, width));
}

/** Fitted to the width, showing everything, which is where a new clip starts. */
function fitView(duration, width) {
  return { scale: fitScale(duration, width), scroll: 0 };
}

function timeToX(view, t) {
  return (t - view.scroll) * view.scale;
}

function xToTime(view, x) {
  return round(view.scroll + x / view.scale);
}

/**
 * Zoom by factor while keeping whatever is under anchorX exactly where it is.
 * That fixed point is the whole trick: zooming about the centre of the view
 * means the thing being looked at slides away as it grows.
 */
function zoomAt(view, anchorX, factor, duration, width) {
  const held = xToTime(view, anchorX);
  const scale = clampScale(view.scale * factor, duration, width);
  return { scale, scroll: clampScroll(held - anchorX / scale, scale, duration, width) };
}

/** Slide the view sideways by a number of pixels, positive meaning rightwards. */
function panBy(view, dx, duration, width) {
  const scroll = clampScroll(view.scroll + dx / view.scale, view.scale, duration, width);
  return { scale: view.scale, scroll };
}

/**
 * The finest step from the ladder whose labels still have room to stand apart,
 * falling back to the coarsest when even that is too tight.
 */
function chooseStep(scale, minLabelGap = MIN_LABEL_GAP) {
  for (const entry of TICK_STEPS) {
    if (entry.step * scale >= minLabelGap) return entry;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/**
 * Every mark visible in width pixels of this view, labelled ones flagged as
 * major. Times are generated from an integer index rather than by adding the
 * step repeatedly, so the hundredth mark is exactly a hundred steps rather than
 * a hundred roundings.
 */
function ticks(view, duration, width, minLabelGap = MIN_LABEL_GAP) {
  const out = [];
  if (!(view.scale > 0) || !(duration > 0) || !(width > 0)) return out;

  const chosen = chooseStep(view.scale, minLabelGap);
  const minorStep = chosen.step / chosen.minor;
  const showMinor = minorStep * view.scale >= MIN_MINOR_GAP;

  // Marked across the whole reachable timeline, headroom included: the empty
  // hour past the content is somewhere a layer can be put, so it needs a ruler
  // to put it against.
  const from = Math.max(0, view.scroll);
  const to = Math.min(reachOf(duration), view.scroll + width / view.scale);
  // A tolerance of a millionth of a step, so a mark that lands exactly on the
  // edge is not lost to the rounding that put it there.
  const eps = minorStep * 1e-6;
  const first = Math.ceil(from / minorStep - eps);
  const last = Math.floor(to / minorStep + eps);

  for (let i = first; i <= last; i += 1) {
    const major = i % chosen.minor === 0;
    if (!major && !showMinor) continue;
    const t = round(i * minorStep);
    out.push({ t, x: timeToX(view, t), major, step: chosen.step });
  }
  return out;
}

/**
 * What a labelled mark says. A step under a second gets one decimal, which is
 * all that 0.1, 0.2 and 0.5 can distinguish anyway.
 *
 * The third argument is the largest time on the ruler rather than the clip's
 * own length, so that every label in one frame is the same shape. Deciding it
 * per label instead would mix 59:00 and 1:01:00 on the same ruler the moment
 * the view reached an hour.
 */
function tickLabel(t, step, longest) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t - h * 3600) / 60);
  const s = t - h * 3600 - m * 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  if (step < 1) {
    const shown = s.toFixed(1).padStart(4, '0');
    return longest >= 3600 ? h + ':' + pad2(m) + ':' + shown : m + ':' + shown;
  }
  if (longest >= 3600) return h + ':' + pad2(m) + ':' + pad2(Math.round(s));
  return m + ':' + pad2(Math.round(s));
}

const timelineView = {
  MAX_PX_PER_SEC,
  MIN_LABEL_GAP,
  MIN_MINOR_GAP,
  PAN_HEADROOM,
  TICK_STEPS,
  reachOf,
  fitScale,
  minScale,
  clampScale,
  maxScroll,
  clampScroll,
  fitView,
  timeToX,
  xToTime,
  zoomAt,
  panBy,
  chooseStep,
  ticks,
  tickLabel,
};

// The window reaches this through the lexical binding above; node --test needs
// it handed over properly.
if (typeof module !== 'undefined' && module.exports) module.exports = timelineView;
