'use strict';

// The compositor that draws the layers into the preview, and the Start and End
// frames.

// ---- the compositor ----
//
// Step 10a. Advanced editing's preview: every video layer covering the playhead
// drawn onto one canvas, in the order the model hands them back, so Video 1
// lands on top.
//
// Nothing here decides anything about the picture. Where a layer lands comes
// from geometry.js and when it appears comes from timeline.js, which is what
// the encoder reads as well, so the preview and the saved file cannot come to
// different answers. This is dev/sliceRenderer.js generalised from two
// hardcoded layers to however many the project has.
//
// The video elements are muted and stay muted, now permanently rather than
// until Step 10c. A video layer is picture only in this model: composer.js
// mixes type 'audio' layers and nothing else, so a video decoder left unmuted
// would put sound in the preview that the saved file does not have. Step 14's
// grouping is what gives a dropped video file an audio row of its own to carry
// its sound. Muted is also what lets an element play without a gesture.
//
// Step 10c added the sound below: one audio element per audio layer, each
// through its own gain node into one bus.
//
// Seeking is naive: every covering layer on every playhead move. That is
// correct and slow, and making it affordable is the whole of Step 10b.

// Until the aspect and resolution dropdowns in the design exist, the project
// takes its shape from the first source to arrive and then keeps it. Seeded
// once rather than read off the top layer every time, so reordering the rows
// does not reshape the project underneath them.
const COMPOSITE_FALLBACK = { width: 1280, height: 720, fps: 30 };

// How far an element may drift before it is dragged back rather than left to
// catch up, and the same value as AUDIO_SYNC_SLACK for the same reason: a
// re-seek costs a decode, so it is worth doing only when an element is
// genuinely lost. Step 0 measured 2ms of real drift against a wall clock, which
// never comes near this wall.
const COMPOSITE_SLACK = 0.25;

// Above 1080p even the top layer alone costs about 450ms to seek, which is not
// a live scrub by any reading, so a project that size holds its picture through
// the drag and lands everything when the mouse comes up. Counted in pixels
// rather than in height, so a 1080x1920 portrait clip is the 1080p it is.
const SCRUB_PIXELS = 1920 * 1080;

const decoders = new Map();   // layer id -> { el, width, height }
// Step 10c. One player per audio layer, each with its own gain node, all of
// them summing into mixBus. A mix does not care what order it sums in, so
// unlike the decoders these have no order at all.
const players = new Map();    // layer id -> { el, gain }
let mixBus = null;
// Decoders still on their way to the playhead after a scrub let go. Step 0
// measured this at up to 5s for five 4K layers and 7.4s worst for eight, so it
// is not something to do quietly: the composite is wrong for that whole time,
// and a picture that has stopped changing looks exactly like one that froze.
const landing = new Set();
let landingTimer = null;
let compositeScrub = false;   // a drag on the stack is moving the playhead
// Step 10e is holding the pool at a trim point, so nothing may draw the preview
// from it. Declared here rather than beside the rest of 10e because
// drawComposite reads it and is defined long before that block.
let paintingFrames = false;
let compositeFrame = null;    // the project's size, seeded from the first source
let compositeAt = 0;          // where the playhead is, in timeline seconds
let compositePlaying = false;
let compositeRaf = null;
let compositeLast = 0;

const compositeCtx = compositeCanvas.getContext('2d', { alpha: false });

/**
 * Whether the composite is what the preview frame is showing.
 *
 * An audio-only output stays on the single media path with everything it
 * already has, spectrum included: there is no picture to composite. Step 10c
 * put the timeline's sound on a mix bus but left this alone, because what an
 * audio-only preview shows is the spectrum, and moving the spectrum onto the
 * bus is Step 10d. Until then, choosing MP3 in advanced mode gives the preview
 * back to the single media path.
 */
function compositing() {
  return timelineDriving() && !outputIsAudio();
}

/**
 * Whether the timeline owns the transport and the sound.
 *
 * Wider than compositing(), and the difference is the whole of what 10c left
 * open: with an audio output format there is no picture to draw, but there is
 * still a project to play. The canvas follows compositing(); the Play button,
 * the playhead, the space bar and the mix all follow this.
 */
function timelineDriving() {
  return !!appSettings.advancedEditing;
}

function projectFrame() {
  return compositeFrame || COMPOSITE_FALLBACK;
}

function compositeTotal() {
  return timelineModel.totalDuration(layers);
}

function sizeCompositeCanvas() {
  // The rough preview, capped at 854x480 by geometry.js, and deliberately not
  // scaled by devicePixelRatio the way the ruler and the waveform are. This one
  // is redrawn every frame with five decoders behind it, and Step 0 spent that
  // budget on the layers rather than on detail nobody is looking at.
  const size = layerGeometry.previewCanvasSize(projectFrame());
  if (!size) return;
  if (compositeCanvas.width === size.width && compositeCanvas.height === size.height) return;
  compositeCanvas.width = size.width;
  compositeCanvas.height = size.height;
}

/**
 * Seed the project frame, once, from the first source the project has.
 *
 * Walked in list order rather than taken from whichever decoder happened to
 * report first, or two files opened together would leave the project a
 * different shape on different runs. Kept afterwards, so dropping a portrait
 * clip on top of a landscape project does not turn the project portrait: the
 * design has an aspect and a resolution dropdown for that, and this is what
 * stands in until they exist.
 */
function noteSourceSize() {
  if (compositeFrame) return;
  for (const l of layers) {
    // V3. A generated layer is drawn at the project's size, so taking the size
    // from one would be the project taking its size from itself.
    if (l.type !== 'video' || l.kind === 'gen') continue;
    const source = layerSource(l);
    if (!source) continue;
    // The rate travels with the size for the same reason the size is kept once
    // it is set: the export is written at the project's rate, and a project
    // that took its rate from whichever layer happens to be first today would
    // change what it renders when that layer is deleted.
    compositeFrame = {
      width: source.width,
      height: source.height,
      fps: Math.round((l.sourceFps || 0) * 1000) / 1000 || COMPOSITE_FALLBACK.fps,
    };
    sizeCompositeCanvas();
    return;
  }
}

// The same dance as dropPreviewSources, and for the same reason: on Windows one
// remaining handle on a file is enough to make a cache clear silently fail.
function releaseDecoder(entry) {
  if (entry.gen) {
    // A canvas holds no file. Shrinking it is what gives its memory back, which
    // at 4K is 33 MB a layer.
    entry.el.width = 0;
    entry.el.height = 0;
    return;
  }
  if (entry.still) {
    // An <img> holds no handle on the file once its src is gone, and there is
    // no load() on one to call.
    entry.el.removeAttribute('src');
    entry.el.remove();
    return;
  }
  entry.el.pause();
  entry.el.removeAttribute('src');
  entry.el.load();
  entry.el.remove();
}

function releaseComposite() {
  for (const entry of decoders.values()) releaseDecoder(entry);
  decoders.clear();
  releasePlayers();
  compositeFrame = null;
  landing.clear();
  clearTimeout(landingTimer);
}

/**
 * A still's decoder: an <img>, which is the whole of what one needs.
 *
 * Shaped exactly like the video entry beside it, because everything that draws
 * a layer reaches for entry.el and entry.width and must not care which it has.
 * ctx.drawImage takes either. What an image has not got is a clock, so the
 * `still` flag marks the entries that must never be seeked, played or paused:
 * an <img> has no currentTime and no pause(), and calling one on it throws.
 */
function addStillDecoder(layer) {
  const img = document.createElement('img');
  const entry = { el: img, width: 0, height: 0, still: true };
  decoders.set(layer.id, entry);
  compositePool.appendChild(img);
  img.addEventListener('load', () => {
    entry.width = img.naturalWidth;
    entry.height = img.naturalHeight;
    // The same three the video path does on loadedmetadata, and for the same
    // reasons: the project takes its size from its first source, the resolution
    // readout is written from that, and the step already on the undo stack was
    // taken before this file said how big it is.
    noteSourceSize();
    updateRenderResolution();
    undoStack = projectHistory.reseat(undoStack, projectState());
    renderTrimFrames();
    // No parking and no following: one frame is right at every moment, which is
    // the one simplification a still buys.
    drawComposite();
    // The clip draws the picture itself rather than a filmstrip, so the row has
    // nothing on it until this arrives.
    drawTimeline();
  });
  window.lwclipper.fileUrl(layer.src).then((url) => {
    if (decoders.get(layer.id) !== entry) return;
    img.src = url;
  });
}

/**
 * V3. A generated layer's decoder: a canvas the app draws the layer into, at
 * the project's size, shaped like the image entry above so that everything
 * that draws a layer draws this one without asking what it is. It is a still
 * in every sense that flag means.
 *
 * Drawn when it is made and again whenever what it depends on changes, which
 * paintGen finds out for itself from the key, so an edit, an undo and a new
 * project size all reach it without any of them having to know it is there.
 */
function addGenDecoder(layer) {
  const canvas = document.createElement('canvas');
  const entry = { el: canvas, width: 0, height: 0, still: true, gen: true, key: null };
  decoders.set(layer.id, entry);
  paintGen(layer, entry);
  loadGenFonts(layer.gen).then((loaded) => {
    if (!loaded || decoders.get(layer.id) !== entry) return;
    // A font that was still loading when the first picture was drawn was drawn
    // in the fallback, so draw it again now that it is here.
    entry.key = null;
    drawComposite();
    drawTimeline();
  });
}

/**
 * The layer drawn into its canvas, unless the canvas already holds exactly
 * that. Cheap to ask every frame: the key is one JSON string of a small object.
 */
function paintGen(layer, entry) {
  const frame = projectFrame();
  const key = genDraw.keyOf(layer.gen, frame.width, frame.height);
  if (entry.key === key) return;
  const canvas = entry.el;
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  genDraw.drawGen(canvas.getContext('2d'), layer.gen, frame.width, frame.height);
  entry.width = frame.width;
  entry.height = frame.height;
  entry.key = key;
  warnMissingFonts(layer.gen);
}

// Fonts the page has had to load before drawing with them. System fonts need
// nothing and come back as an empty list at once; a font only half loaded when
// the first picture is drawn would put the fallback into it silently.
async function loadGenFonts(gen) {
  let loaded = false;
  for (const font of genDraw.fontsOf(gen)) {
    try {
      const faces = await document.fonts.load(font);
      if (faces.length) loaded = true;
    } catch {
      // A font string the browser cannot parse draws in the fallback anyway.
    }
  }
  return loaded;
}

/**
 * Whether a font family is installed, by the one test that works for the
 * fonts of the system: text set in it measures differently from text set in
 * the fallback alone. Three generic fallbacks, because a font can happen to
 * be exactly one of them, and Arial measured against a sans-serif that is
 * Arial proves nothing.
 */
const fontChecks = new Map();
let fontProbe = null;
function fontInstalled(family) {
  if (fontChecks.has(family)) return fontChecks.get(family);
  if (!fontProbe) fontProbe = document.createElement('canvas').getContext('2d');
  const sample = 'mmmmmmmmmmlli WQ@#0123456789';
  let installed = false;
  for (const generic of ['monospace', 'serif', 'sans-serif']) {
    fontProbe.font = '72px ' + generic;
    const plain = fontProbe.measureText(sample).width;
    fontProbe.font = '72px "' + family.replace(/["\\]/g, '') + '", ' + generic;
    if (fontProbe.measureText(sample).width !== plain) {
      installed = true;
      break;
    }
  }
  fontChecks.set(family, installed);
  return installed;
}

// Said once a family and session, when a project names a font this PC does
// not have. The picture is still drawn, in the fallback, and the setting is
// kept as it was, so the project comes back right on the PC that has it.
const fontsWarned = new Set();
function warnMissingFonts(gen) {
  for (const family of genDraw.familiesOf(gen)) {
    if (fontsWarned.has(family) || fontInstalled(family)) continue;
    fontsWarned.add(family);
    setStatus('The font {font} is not installed on this PC, a fallback font is used instead.',
      { font: family });
  }
}

function addDecoder(layer) {
  if (layer.kind === 'gen') return addGenDecoder(layer);
  if (layer.kind === 'image') return addStillDecoder(layer);
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  const entry = { el: v, width: 0, height: 0 };
  decoders.set(layer.id, entry);
  compositePool.appendChild(v);
  v.addEventListener('loadedmetadata', () => {
    entry.width = v.videoWidth;
    entry.height = v.videoHeight;
    noteSourceSize();
    updateRenderResolution();
    // The seed lands here and nowhere else, so this is where the dropdown finds
    // out what rate the project ended up with.
    updateFpsChoices();
    // And where the step already on the stack finds out too. The layer was
    // added and committed before this file said what rate it runs at, so
    // without this the snapshot behind the next gesture claims the project had
    // no rate, and Ctrl+Z over a rate change would find nothing to go back to.
    // Not a commit: a decoder answering is not a gesture.
    undoStack = projectHistory.reseat(undoStack, projectState());
    // This layer was not in the trim frames when they were last built, because
    // it had no size to place it by. The token makes a second arrival cancel
    // the first rather than queue behind it.
    renderTrimFrames();
    // It arrives parked at zero, which is the right frame only when the layer
    // happens to start there.
    if (compositePlaying) followDecoders();
    else parkDecoders();
    drawComposite();
  });
  // The frame is not there when currentTime is written, it is there when the
  // seek lands. Drawing on both is what fills the canvas in without the
  // scheduler having to wait for anything.
  v.addEventListener('seeked', () => {
    if (landing.delete(layer.id)) refreshHints();
    if (!compositePlaying) drawComposite();
  });
  window.lwclipper.fileUrl(layer.src).then((url) => {
    // The row may have gone while the path was crossing to the main process.
    if (decoders.get(layer.id) !== entry) return;
    v.src = url;
  });
}

/** One decoder per video layer: made when a layer appears, let go when it goes. */
function syncDecoders() {
  const wanted = new Set();
  for (const l of layers) {
    if (l.type !== 'video' || (!l.src && l.kind !== 'gen')) continue;
    wanted.add(l.id);
    if (!decoders.has(l.id)) addDecoder(l);
  }
  for (const [id, entry] of decoders) {
    if (wanted.has(id)) continue;
    releaseDecoder(entry);
    decoders.delete(id);
    // Nothing is going to answer for it now, so stop waiting on it.
    landing.delete(id);
  }
  // An empty project takes its shape from whatever source opens the next one.
  if (!decoders.size) compositeFrame = null;
}

/**
 * Every covering video layer at `at`, drawn onto one canvas.
 *
 * Shared by the preview canvas and by Step 10e's two trim frames, so a frame at
 * the in point and the picture at the playhead cannot be composited by two
 * different pieces of arithmetic and disagree.
 *
 * `only` restricts it to a single layer, which is what a scrub draws.
 */
/**
 * One layer's picture, drawn where that layer goes.
 *
 * Pulled out of paintLayers in V2.1 so the Render Position tab can draw a layer
 * the playhead has left, which the composite by definition does not hold. One
 * piece of arithmetic for both, which is the same reason paintLayers itself is
 * shared with the two trim frames.
 */
function drawLayerInto(ctx, canvas, layer, crop = layer.crop, render = layer.render) {
  const entry = decoders.get(layer.id);
  if (entry && entry.gen) paintGen(layer, entry);
  if (!entry || !entry.width) return;
  const source = layerSource(layer);
  if (!source) return;
  const frame = projectFrame();
  const placement = layerGeometry.placeLayer({
    source,
    // The two drafts the popup is editing, when it is the one drawing. Defaulted
    // to what the layer says, which is what every other caller wants.
    crop,
    // V2.1. composer.js has read this since Step 3 and the preview never did,
    // so a positioned layer would have been shown in the middle of the frame
    // and written somewhere else. The two renderers are not allowed to
    // disagree, which is the rule the whole of Step 4 existed to establish.
    render,
    project: frame,
  });
  const d = layerGeometry.drawImageArgs(placement, frame, canvas);
  if (!d) return;
  // drawImage measures its source rectangle in the element's own intrinsic
  // size, which need not be the coded size the crop was set against. So the
  // rectangle is carried across as a fraction, exactly as paintCropFrame
  // does, and for the same reason the coded numbers are the ones stored:
  // they are what ffmpeg will crop with. Both are equal for square pixels,
  // where kx and ky come out at 1 and nothing is scaled at all.
  const kx = entry.width / source.width;
  const ky = entry.height / source.height;
  ctx.drawImage(entry.el, d.sx * kx, d.sy * ky, d.sw * kx, d.sh * ky,
    d.dx, d.dy, d.dw, d.dh);
}

function paintLayers(ctx, canvas, at, only, skip) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Back to front, which is the order layersAt hands them back in, so index 0
  // is drawn last and Video 1 ends up on top.
  for (const l of timelineModel.layersAt(layers, at)) {
    if (l.type !== 'video') continue;
    // Mid-scrub, only the layer that is actually on the playhead's frame. The
    // others still hold whatever the last position decoded, and a frame from
    // another moment drawn into the composite has nothing on it to say it is
    // not the real one.
    if (only && l.id !== only.id) continue;
    // The layer the position tab is drawing itself, from its draft. Left in, it
    // would be drawn twice and its stored position would show underneath.
    if (skip && l.id === skip) continue;
    // V2.2. The fade as transparency, which is what the user asked it to be:
    // "video track fade in/out should affect its transparency so underlying
    // tracks get revealed by that time which can already be used for manual
    // transitions". The layers below have already been drawn, so a top layer
    // at less than full alpha lets them through exactly as the overlay does in
    // the file.
    //
    // composer.js reaches the same picture by another road, format=yuva420p
    // and fade with alpha=1, and both of them read the ramp off fadeAlphaAt.
    // Step 4's rule: the two renderers are not allowed to work it out
    // separately, because then they can disagree.
    //
    // V2.4. layerAlphaAt rather than fadeAlphaAt: the ramp times the layer's
    // own ceiling. ffmpeg multiplies by the same ceiling with colorchannelmixer
    // after its fade filters, which is the same sum in the same order.
    const alpha = timelineModel.layerAlphaAt(l, at);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    drawLayerInto(ctx, canvas, l);
    ctx.globalAlpha = 1;
  }
}

function drawComposite() {
  if (compositeCanvas.hidden) return;
  // The pool is parked at a trim point rather than at the playhead, so whatever
  // it holds right now is not this canvas's picture. Step 10e.
  if (paintingFrames) return;
  const only = compositeScrub ? scrubTarget() : null;
  // A scrub above 1080p seeks nothing, so there is nothing new to draw and the
  // canvas keeps the last full composite. Clearing it to black instead would be
  // less use than the stale picture, not more.
  if (compositeScrub && !only) return;
  paintLayers(compositeCtx, compositeCanvas, compositeAt, only);
}

// Standing still: every covering layer on its exact frame, everything else
// paused. The tolerance is a thousandth of a second rather than the playing
// one, because a still frame that is nearly right is simply the wrong frame.
function parkDecoders() {
  const only = compositeScrub ? scrubTarget() : null;
  for (const l of layers) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    if (!entry || entry.still) continue;
    if (!entry.el.paused) entry.el.pause();
    // Mid-scrub, only the top covering layer moves, and above 1080p not even
    // that. Everything else is landed by endScrub when the mouse comes up.
    if (compositeScrub && (!only || l.id !== only.id)) continue;
    if (!entry.width || !l.enabled || !timelineModel.covers(l, compositeAt)) continue;
    const want = timelineModel.sourceTimeFor(l, compositeAt);
    if (Math.abs(entry.el.currentTime - want) < 0.001) continue;
    entry.el.currentTime = want;
  }
}

// Running: elements play at their own rate and are only dragged back when they
// are genuinely lost, since every re-seek is a decode. A layer the playhead has
// left, or one that has been switched off, stops rather than playing on unseen
// behind the others.
function followDecoders() {
  for (const l of layers) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    // A still needs no following: its one frame is the right one at every
    // moment of the layer, playing or not.
    if (!entry || entry.still) continue;
    const v = entry.el;
    if (l.enabled && timelineModel.covers(l, compositeAt)) {
      const want = timelineModel.sourceTimeFor(l, compositeAt);
      if (Math.abs(v.currentTime - want) > COMPOSITE_SLACK) v.currentTime = want;
      if (v.paused) v.play().catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
  }
}

/**
 * The node every audio layer sums into.
 *
 * Connected straight to the output. Step 10d is what puts the spectrum's two
 * analysers on the end of it, which is the whole of that step: the chain
 * ensureGainChain builds for the three fixed preview elements is already a
 * three input mix, and this is the same shape generalised to N.
 */
function ensureMixBus() {
  if (mixBus) return mixBus;
  const ctx = ensureAudioContext();
  const tail = ensureAnalysers();
  if (!ctx) return null;
  mixBus = ctx.createGain();
  // Step 10d. Into the analysers, not straight to the output. Without this the
  // spectrum in advanced mode reads the three fixed elements, which are silent
  // there, so it showed a flat line over a project that was plainly playing.
  // Falls back to the output if there are no analysers, because being heard
  // matters more than being drawn.
  mixBus.connect(tail || ctx.destination);
  return mixBus;
}

// A layer that is switched off goes silent rather than being torn down, so
// ticking the box back on is immediate and costs no reload. Unticking is
// immediate for the same reason: the gain is set here and nothing has to wait
// for an element to react.
function playerGain(layer) {
  if (!layer.enabled) return 0;
  // V2.2. The fade multiplies the layer's own volume rather than replacing it,
  // so a track set to 40% fades in to 40% and not to 100%. That is also what
  // composer.js writes: afade sits before the volume filter in the chain.
  //
  // It depends on where the playhead is, which means this answer goes stale as
  // soon as the playhead moves. followPlayers asks again every tick.
  return Math.max(0, layer.volume) * timelineModel.fadeAlphaAt(layer, compositeAt);
}

function applyPlayerGain(layer) {
  const entry = players.get(layer.id);
  if (!entry) return;
  if (entry.gain) entry.gain.gain.value = playerGain(layer);
  // No Web Audio in this window, so the element's own volume is all there is
  // and the slider simply stops getting louder past 100% rather than failing.
  else entry.el.volume = Math.min(1, playerGain(layer));
}

// The same dance as releaseDecoder, and for the same reason: on Windows one
// remaining handle on a file is enough to make a cache clear silently fail.
// The source node cannot be detached from the element, since an element only
// ever has one and it lasts as long as the element does, so what leaves the bus
// is the gain node.
function releasePlayer(entry) {
  entry.el.pause();
  entry.el.removeAttribute('src');
  entry.el.load();
  entry.el.remove();
  if (entry.gain) entry.gain.disconnect();
}

function releasePlayers() {
  for (const entry of players.values()) releasePlayer(entry);
  players.clear();
}

function addPlayer(layer) {
  const a = document.createElement('audio');
  a.preload = 'auto';
  const entry = { el: a, gain: null };
  players.set(layer.id, entry);
  compositePool.appendChild(a);
  const bus = ensureMixBus();
  if (bus) {
    try {
      const gain = gainCtx.createGain();
      gainCtx.createMediaElementSource(a).connect(gain);
      gain.connect(bus);
      entry.gain = gain;
    } catch {
      // Routing an element is a one-way door and this one did not open, so the
      // player stays on its own volume for the rest of its life.
      entry.gain = null;
    }
  }
  applyPlayerGain(layer);
  window.lwclipper.fileUrl(layer.src).then((url) => {
    // The row may have gone while the path was crossing to the main process.
    if (players.get(layer.id) !== entry) return;
    a.src = url;
  });
}

/** One player per audio layer: made when a layer appears, let go when it goes. */
function syncPlayers() {
  const wanted = new Set();
  for (const l of layers) {
    if (l.type !== 'audio' || !l.src) continue;
    wanted.add(l.id);
    if (!players.has(l.id)) addPlayer(l);
    // Applied here and not only where the controls are, so a layer that arrives
    // already switched off or already quiet arrives that way.
    applyPlayerGain(l);
  }
  for (const [id, entry] of players) {
    if (wanted.has(id)) continue;
    releasePlayer(entry);
    players.delete(id);
  }
}

// Standing still is silence, and nothing is seeked to get there. A scrub calls
// this on every pointer move, and placing every audio layer on every move would
// be a decode each for sound nobody can hear while the mouse is down. Where
// they resume from is settled by followPlayers when the transport starts again.
function parkPlayers() {
  for (const entry of players.values()) {
    if (!entry.el.paused) entry.el.pause();
  }
}

/**
 * Running: every enabled audio layer covering the playhead sounds, placed from
 * the project's clock exactly the way the replacement track is placed from the
 * video's, and against the same tolerance.
 *
 * force skips that tolerance, for the moments where the playhead jumps rather
 * than advances and any leftover drift would be plainly audible.
 */
function followPlayers(force) {
  for (const l of layers) {
    if (l.type !== 'audio') continue;
    const entry = players.get(l.id);
    if (!entry) continue;
    const a = entry.el;
    if (l.enabled && timelineModel.covers(l, compositeAt)) {
      const want = timelineModel.sourceTimeFor(l, compositeAt);
      if (force || Math.abs(a.currentTime - want) > AUDIO_SYNC_SLACK) a.currentTime = want;
      // V2.2. Every tick, because the fade is a function of where the playhead
      // is and this is the only thing that runs as it moves. A layer with no
      // fades gets its own volume back, so this is not a special case for
      // faded layers, it is the gain being kept current.
      applyPlayerGain(l);
      // A play() interrupted by the next seek rejects; that is not a failure.
      if (a.paused) a.play().catch(() => {});
    } else if (!a.paused) {
      // Past its end, before its start, or switched off. Stopped rather than
      // left running silently, so it is not still going when the playhead comes
      // back to it.
      a.pause();
    }
  }
}

/**
 * The topmost video layer covering the playhead. layersAt hands them back to
 * front so that drawing them in order works, which puts the top one last.
 */
function topCovering() {
  const hits = timelineModel.layersAt(layers, compositeAt);
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    if (hits[i].type === 'video') return hits[i];
  }
  return null;
}

/**
 * The one layer a scrub may seek, or null for none at all.
 *
 * Step 0 measured seeking every layer at 0.8 to 1.2s at 1080p and 2.3 to 5.0s
 * at 4K, which is not a scrub, it is a wait. The top covering layer alone
 * settles in 120 to 200ms at 1080p, and that is a live scrub. At 4K even one
 * layer is about 450ms, so there the answer is to seek nothing until the mouse
 * comes up.
 */
function scrubTarget() {
  const top = topCovering();
  if (!top) return null;
  const entry = decoders.get(top.id);
  if (!entry || !entry.width) return null;
  if (entry.width * entry.height > SCRUB_PIXELS) return null;
  return top;
}

function beginScrub() {
  if (compositeScrub) return;
  // The scrub takes the playhead over, so playback stops rather than the two of
  // them fighting over the same clock.
  if (compositePlaying) pauseComposite();
  compositeScrub = true;
}

function endScrub() {
  if (!compositeScrub) return;
  compositeScrub = false;
  landDecoders();
}

/**
 * Bring every covering layer onto the playhead's frame, and say so until they
 * arrive. The picture fills in as each one lands, because every decoder redraws
 * the composite on its own seeked.
 */
function landDecoders() {
  landing.clear();
  for (const l of timelineModel.layersAt(layers, compositeAt)) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    if (!entry || !entry.width || entry.still) continue;
    const want = timelineModel.sourceTimeFor(l, compositeAt);
    if (Math.abs(entry.el.currentTime - want) < 0.001) continue;
    landing.add(l.id);
    entry.el.currentTime = want;
  }
  clearTimeout(landingTimer);
  if (landing.size) {
    // A decoder that never answers must not leave the message up for the rest
    // of the session. Well past the 7.4s worst case Step 0 measured.
    landingTimer = setTimeout(() => { landing.clear(); refreshHints(); }, 20000);
  }
  refreshHints();
  drawComposite();
}

function catchingUp() {
  return landing.size > 0;
}

// ---- Step 10e, the Start and End frames ----
//
// At a trim point the frame is a composite of whatever covers that moment, so
// it cannot be a video element seeked into one file. It is built from the same
// decoder pool the preview uses, which is only affordable because it happens on
// release and never during a drag: seeking every covering layer is about a
// second at five 1080p layers, and a spinner is what says so.
//
// While it runs the pool is parked somewhere other than the playhead, and every
// decoder redraws the preview on its own seeked, so drawComposite has to be
// held off for the duration or the preview would flash the trim point's
// picture. That is the whole of what this flag is for.

const startFrameCtx = startFrameCanvas.getContext('2d', { alpha: false });
const endFrameCtx = endFrameCanvas.getContext('2d', { alpha: false });
// The loop that owns the pool, and what it has been asked for: null, 'start',
// 'end' or 'both'. One loop only, because two renders seeking the same decoders
// would each be moving the other's.
let framesRunning = false;
let framesWanted = null;
// Bumped by every marker move. A render that finishes on an older generation is
// already out of date, so it leaves the spinner up for the one that follows it.
let trimDragGen = 0;
// A rebuild asked for while the transport was running, to be done when it stops.
let trimFramesStale = false;

/**
 * Where the End frame is actually painted.
 *
 * The out point is exclusive: composer.js trims to it, so the last frame in the
 * output is the one just before it, and at the very end of a project nothing
 * covers that instant at all. Painting exactly there gives a black frame, which
 * is what the first run of this showed. Backed off the same 0.05s the simple
 * mode frame seeker backs off from its own limit, for the same reason.
 */
function trimFrameOutAt() {
  return Math.max(slider.start, slider.end - 0.05);
}

/**
 * The spinners, by name. Turning them on names which one, because a drag on the
 * in marker leaves the End frame perfectly current and putting a spinner over
 * it would be a lie. Turning them off clears both: whoever is clearing is the
 * only render left, so there is nothing that could still be waiting.
 */
function trimFramesBusy(on, which) {
  if (!on) {
    startFrameBusy.hidden = true;
    endFrameBusy.hidden = true;
    return;
  }
  if (which !== 'end') startFrameBusy.hidden = false;
  if (which !== 'start') endFrameBusy.hidden = false;
}

function sizeTrimFrameCanvases() {
  const size = layerGeometry.previewCanvasSize(projectFrame());
  if (!size) return;
  for (const canvas of [startFrameCanvas, endFrameCanvas]) {
    if (canvas.width === size.width && canvas.height === size.height) continue;
    canvas.width = size.width;
    canvas.height = size.height;
  }
}

/**
 * Park every covering layer on the frame for `at`, and resolve once they are
 * all there. A decoder that never answers must not hold the spinner up for the
 * rest of the session, so each wait has its own way out.
 */
function seekDecodersTo(at) {
  const waits = [];
  for (const l of timelineModel.layersAt(layers, at)) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    // Nothing to wait for on a still, so it is not put in the list of things
    // being waited for: a promise on a seeked event that cannot fire would hold
    // the trim frames up for its full ten seconds.
    if (!entry || !entry.width || entry.still) continue;
    const want = timelineModel.sourceTimeFor(l, at);
    // Assigning the position it already holds may produce no seeked event at
    // all, which would leave this waiting for a reply that never comes.
    if (Math.abs(entry.el.currentTime - want) < 0.001) continue;
    waits.push(new Promise((resolve) => {
      const done = () => {
        entry.el.removeEventListener('seeked', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 10000);
      entry.el.addEventListener('seeked', done);
      entry.el.currentTime = want;
    }));
  }
  return Promise.all(waits);
}

/**
 * Rebuild both trim frames, then put the pool back where the playhead is.
 *
 * Deliberately not called during a drag. The user sets the spinner going on the
 * press and this runs on the release, which is what makes reusing the live pool
 * affordable at all.
 */
/** 'start' and 'end' together are 'both'; anything with 'both' stays 'both'. */
function mergeWhich(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a === b ? a : 'both';
}

/**
 * Ask for a rebuild. Never runs two at once.
 *
 * The pool is shared with the preview, so two renders seeking it at the same
 * time would each be moving the other's decoders. Requests therefore coalesce
 * into `framesWanted` and one loop drains it, which also means a drag that
 * dwells repeatedly does not pile up a queue of stale renders: by the time the
 * loop comes round again, `framesWanted` holds only the latest ask.
 */
function renderTrimFrames(which) {
  if (!compositing()) return;
  if (compositePlaying) {
    // Seeking the pool out from under a running transport would stutter the
    // picture and the sound. Remember, and do it when it stops.
    trimFramesStale = true;
    return;
  }
  trimFramesStale = false;
  framesWanted = mergeWhich(framesWanted, which || 'both');
  trimFramesBusy(true, framesWanted);
  if (!framesRunning) runTrimFrames();
}

async function runTrimFrames() {
  if (framesRunning) return;
  framesRunning = true;
  // Nothing may draw the preview from the pool while this has it parked
  // somewhere other than the playhead.
  paintingFrames = true;
  try {
    while (framesWanted) {
      const which = framesWanted;
      framesWanted = null;
      // Which drag this pass belongs to. If the markers move while it is being
      // built it is out of date before it lands, and the spinner has to stay up
      // for the pass that will replace it rather than being cleared here.
      const gen = trimDragGen;
      sizeTrimFrameCanvases();
      const jobs = [];
      if (which !== 'end') jobs.push([startFrameCtx, startFrameCanvas, slider.start]);
      if (which !== 'start') jobs.push([endFrameCtx, endFrameCanvas, trimFrameOutAt()]);
      for (const [ctx, canvas, at] of jobs) {
        await seekDecodersTo(at);
        paintLayers(ctx, canvas, at, null);
      }
      // Back to the playhead before anything else can look at the pool.
      await seekDecodersTo(compositeAt);
      if (gen === trimDragGen && !framesWanted) trimFramesBusy(false);
    }
  } finally {
    framesRunning = false;
    paintingFrames = false;
    drawComposite();
  }
}

/** Move the project's playhead, which is what the timeline seeks. */
function seekComposite(at) {
  compositeAt = Math.min(Math.max(at, 0), compositeTotal());
  parkDecoders();
  // A seek is a jump, so the tolerance is skipped: the audio goes exactly where
  // the playhead went rather than up to a quarter second behind it.
  if (compositePlaying) followPlayers(true);
  else parkPlayers();
  drawComposite();
}

// The clock is the wall clock rather than any one element's. With N elements
// there is no obvious one to follow, and the model's own arithmetic is then
// what every element is held against, which is exactly what the encoder does
// with the same numbers.
function compositeTick() {
  if (!compositePlaying) return;
  const now = performance.now();
  const total = compositeTotal();
  compositeAt = Math.min(total, compositeAt + (now - compositeLast) / 1000);
  compositeLast = now;
  // With an audio output there is nothing to draw, so the video layers are left
  // where they are rather than decoded for a canvas that is hidden.
  if (compositing()) followDecoders();
  followPlayers(false);
  drawComposite();
  updatePlayhead();
  // Step 17. Play selection's stop point, which the media elements check in
  // their timeupdate and the compositor had nowhere to check at all. Ahead of
  // the end of the project, because it is always the earlier of the two.
  if (playUntil !== null && compositeAt >= playUntil) {
    pauseComposite();
    playUntil = null;
    return;
  }
  if (compositeAt >= total) {
    pauseComposite();
    return;
  }
  compositeRaf = requestAnimationFrame(compositeTick);
}

function playComposite() {
  if (compositePlaying) return;
  const total = compositeTotal();
  if (!total) return;
  // Back to the top when the playhead is already sitting at the end, which is
  // where every run leaves it.
  if (compositeAt >= total) compositeAt = 0;
  // A context made before any click starts suspended, and this is a click.
  if (gainCtx && gainCtx.state === 'suspended') gainCtx.resume();
  compositePlaying = true;
  compositeLast = performance.now();
  updateCompositeUi();
  // The same kick the media elements give it through their play listeners.
  startSpectrum();
  compositeRaf = requestAnimationFrame(compositeTick);
}

function pauseComposite() {
  if (compositeRaf !== null) {
    cancelAnimationFrame(compositeRaf);
    compositeRaf = null;
  }
  compositePlaying = false;
  // Stopped where they are rather than parked exactly. They are already within
  // a couple of milliseconds of the playhead, and re-seeking all of them would
  // cost a decode each to land on the frame that is already on screen.
  for (const entry of decoders.values()) if (!entry.still) entry.el.pause();
  parkPlayers();
  updateCompositeUi();
  // One last frame, so the bars fall back to the line instead of freezing
  // mid-bounce, exactly as a paused media element leaves them.
  drawSpectrum();
  // A trim that moved while this was running is finally safe to build.
  if (trimFramesStale) renderTrimFrames();
}

function updateCompositeUi() {
  compositePlayBtn.textContent = compositePlaying ? t('Pause') : t('Play');
  compositePlayBtn.disabled = busy || !compositeTotal();
}

/**
 * Bring the preview frame in line with the mode it is in. Called wherever
 * advanced editing or the output format changes, since either of them decides
 * whether there is a composite to show at all.
 */
function applyCompositeMode() {
  const advanced = timelineDriving();
  const picture = compositing();
  // The frame belongs to advanced editing whether or not there is a picture in
  // it: the single media file is not what this mode is a preview of either way,
  // so the video element goes and the spectrum or the canvas takes the space.
  previewSection.dataset.composite = String(advanced);
  compositeCanvas.hidden = !picture;
  startFrameCanvas.hidden = !picture;
  endFrameCanvas.hidden = !picture;
  if (!picture) trimFramesBusy(false);
  compositePlayBtn.hidden = !advanced;
  if (!advanced) pauseComposite();
  else if (!transport.paused) {
    // The composite has the preview now, and until 10c the simple path could
    // still be sounding behind a picture the stylesheet had already hidden.
    transport.pause();
    syncPreviewAudio();
  }
  if (!advanced) {
    // Nothing is going to look at them, and each one is a handle on a file the
    // user may be about to clear out of the cache.
    releaseComposite();
    return;
  }
  syncDecoders();
  syncPlayers();
  sizeCompositeCanvas();
  parkDecoders();
  parkPlayers();
  drawComposite();
  updateCompositeUi();
  renderTrimFrames();
}

/**
 * Every change to the document. The pool follows the layers, and the playhead
 * cannot be left past the end of a project that has just got shorter.
 *
 * A live drag deliberately does not come through here: it writes `layers` and
 * redraws the timeline itself, so the picture is one gesture stale rather than
 * re-seeking every decoder on every pointer move.
 */
function syncComposite() {
  if (!appSettings.advancedEditing) return;
  syncDecoders();
  syncPlayers();
  compositeAt = Math.min(compositeAt, compositeTotal());
  if (compositePlaying) {
    followDecoders();
    followPlayers(false);
  } else {
    parkDecoders();
    parkPlayers();
  }
  drawComposite();
  updateCompositeUi();
  refreshHints();
}

compositePlayBtn.addEventListener('click', () => {
  if (compositePlaying) {
    pauseComposite();
  } else {
    // Plain play, so a stop point Play selection left behind is spent.
    playUntil = null;
    playComposite();
  }
});
