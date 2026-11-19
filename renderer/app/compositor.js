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

// V4.13. Holding the elements to the clock, see holdToClock and rollPhase.
//
// A clip's element is placed this long before the clip starts, so that at the
// cut its frame is decoded and waiting. A seek is 120 to 200ms at 1080p and
// about 450 at 4K, which this has to cover with room.
const PREROLL_S = 1.5;
// And set running this long before, silent and unseen, where the file has
// that much before the clip's in point: an element that is already running
// at the cut is on the clock at the cut, where one started there begins some
// tens of milliseconds late. Measured: a picture set running is about 50ms
// behind at first, and this is the time it has to make that up in.
const ROLL_S = 0.4;
// How an element's rate is bent toward the clock: left alone within `dead`
// seconds of it, and past that by the drift times `gain`, held to `most`. A
// picture has no pitch to hear, so it is bent a good deal and brought close;
// sound is bent only a little, and it keeps its pitch.
const VIDEO_BEND = { gain: 3, most: 0.15, dead: 0.008 };
const AUDIO_BEND = { gain: 1.5, most: 0.04, dead: 0.015 };
// How long Play waits for the first element to actually start before the
// clock runs without it.
const START_HOLD_MS = 600;

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
// V4.12. The pointer of that drag has held still for a moment, and every layer
// has been brought onto the playhead's frame: the scrub is a whole picture
// until it moves again. See restScrub.
let scrubRested = false;
let scrubRestTimer = null;
// How long the pointer holds still before the scrub lands everything. Short
// enough that pausing on a frame shows it, long enough that an ordinary drag,
// which reports a move every few milliseconds, never pays for it.
const SCRUB_REST_MS = 150;
// V4.12. The project frame the preview was last drawn for while playing, so a
// frame is drawn once and not once for every frame of the screen. -1 draws.
let compositeDrawnFrame = -1;
// Step 10e is holding the pool at a trim point, so nothing may draw the preview
// from it. Declared here rather than beside the rest of 10e because
// drawComposite reads it and is defined long before that block.
let paintingFrames = false;
let compositeFrame = null;    // the project's size, seeded from the first source
let compositeAt = 0;          // where the playhead is, in timeline seconds
let compositePlaying = false;
let compositeRaf = null;
let compositeLast = 0;

// ---- V5.5.2. Playback speed ----
//
// How fast the preview plays, a second of the timeline to this many of the
// clock: the roadmap's J/K/L shuttle in the form this app can have it, since
// Chromium cannot play a file backwards and J and L are Join and Loop. The
// clock runs at it and every element is set going at it times its clip's own
// speed, the sound with its pitch kept. The preview only: an export is always
// written at the project's own pace. Not saved; every start is at x1.
const PLAY_RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
let playRate = 1;

// What a media element will take. Outside it Chromium refuses the rate, so
// an element that would need more is held to the clock by seeking instead.
const ELEMENT_RATE_MIN = 0.0625;
const ELEMENT_RATE_MAX = 16;

/** A layer's element rate: its own speed at the playback speed, as far as an element goes. */
function elementRate(l) {
  const r = timelineModel.speedOf(l) * playRate;
  return Math.min(ELEMENT_RATE_MAX, Math.max(ELEMENT_RATE_MIN, r));
}

/** The playback speed one step faster (+1) or slower (-1), or back to x1 (0). */
function stepPlayRate(dir) {
  const at = PLAY_RATES.indexOf(playRate);
  const next = !dir ? 1 : PLAY_RATES[Math.min(PLAY_RATES.length - 1, Math.max(0, (at < 0 ? 3 : at) + dir))];
  setPlayRate(next);
}

function setPlayRate(rate) {
  const next = PLAY_RATES.includes(rate) ? rate : 1;
  if (next === playRate) {
    updateSpeedReadout();
    return;
  }
  playRate = next;
  updateSpeedReadout();
  // Running, everything is placed again at the new rate and the clock held
  // until it runs, as at Play.
  if (compositePlaying) seekComposite(compositeAt);
}

/** "x2" in the timeline's header while the preview does not play at x1. */
function updateSpeedReadout() {
  const readout = el('speedReadout');
  if (!readout) return;
  readout.hidden = playRate === 1;
  readout.textContent = t('Playback x{n}', { n: String(playRate) });
}
// V4.13. The clock held at a start or a jump until what it is anchored to has
// begun to run: { el, from, rate, at, since }, or null. See beginStartHold.
let startHold = null;
// V4.0. Where the playhead was when playback last started, the grey line it
// leaves behind on the timeline, and what Shift+Left goes back to. Null until
// anything has played.
let playStartAt = null;
// V4.0. Loop selection (L): playback that reaches the out marker from inside
// the selection carries on from the in marker instead of running past it.
let loopSelection = false;

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
  for (const id of [...echoStores.keys()]) releaseEcho(id);
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
    // V4.13. And the trim frames it is in, which go by this, see trimFrameKey.
    entry.fonts = true;
    renderTrimFrames();
    drawComposite();
    drawTimeline();
  });
}

/**
 * The layer drawn into its canvas, unless the canvas already holds exactly
 * that. Cheap to ask every frame: the key is one JSON string of a small object.
 */
function paintGen(layer, entry, at = null) {
  const frame = projectFrame();
  // V3.3. At a moment, a layer with keyframes is its settings blended there;
  // without one, or without keyframes, it is its settings. The key is the
  // blended settings', so a picture that holds still is not redrawn.
  const gen = at === null ? layer.gen : genDraw.genAt(layer, at - layer.start, frame.width, frame.height);
  const key = genDraw.keyOf(gen, frame.width, frame.height);
  if (entry.key === key) return;
  const canvas = entry.el;
  if (canvas.width !== frame.width) canvas.width = frame.width;
  if (canvas.height !== frame.height) canvas.height = frame.height;
  genDraw.drawGen(canvas.getContext('2d'), gen, frame.width, frame.height);
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
  // V4.12. Each new picture the element has is noted, which is what playback
  // draws by, see compositeDrawDue. Asked for again from inside itself, since
  // one request answers one picture, and for as long as the layer is here.
  if (typeof v.requestVideoFrameCallback === 'function') {
    const onPicture = () => {
      if (decoders.get(layer.id) !== entry) return;
      entry.fresh = true;
      entry.pictures = (entry.pictures || 0) + 1;
      v.requestVideoFrameCallback(onPicture);
    };
    v.requestVideoFrameCallback(onPicture);
  }
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
    releaseEcho(id);
  }
  // V5.5.1. And a track that has no Echo any more needs no frames kept.
  for (const id of [...echoStores.keys()]) {
    const l = layers.find((x) => x.id === id);
    const first = l ? timelineModel.vfxWorked(l)[0] : null;
    if (!first || !VFX_PREVIEW[first.kind] || !VFX_PREVIEW[first.kind].first) releaseEcho(id);
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
 * `scrub`, when given, is a playhead being dragged: `{ file }` is the one
 * layer out of a file that is being seeked along, or null for none, and no
 * other file's picture is drawn. V4.12: a text, a shape, a bar and an image
 * are drawn all the same, having no frame to be on. V4.12.1: the other files
 * are drawn as their shapes, see drawLayerInto's `shape`.
 */
/**
 * One layer's picture, drawn where that layer goes.
 *
 * Pulled out of paintLayers in V2.1 so the Render Position tab can draw a layer
 * the playhead has left, which the composite by definition does not hold. One
 * piece of arithmetic for both, which is the same reason paintLayers itself is
 * shared with the two trim frames.
 *
 * V4.12.1. `shape`, when given, draws the layer's shape and not its picture:
 * black where the picture would be, see paintLayers. `{ over: true }` says it
 * lies over the file a scrub is following, and then a shape that would hide
 * most of the frame is drawn as a veil with its box outlined, so that what
 * the drag is looking at is still to be seen under it.
 */
function drawLayerInto(ctx, canvas, layer, crop = layer.crop, render = layer.render, at = null, shape = null) {
  const entry = decoders.get(layer.id);
  if (entry && entry.gen) paintGen(layer, entry, at);
  if (!entry || !entry.width) return;
  const source = layerSource(layer);
  if (!source) return;
  const frame = projectFrame();
  // V4.10. The transition the layer is going through at this moment, if any:
  // a wipe, a slide and so on in place of its fade. Only at a moment of the
  // timeline; the editors' drafts are drawn without one and show the picture
  // whole. At the very start of its way in there is nothing of it yet.
  const going = at !== null ? timelineModel.transitionAt(layer, at) : null;
  if (going && going.half === 'in' && going.e <= 0) return;
  if (going && entry.gen) {
    // A generated picture is a canvas, so the whole transition is drawn:
    // genDraw's one drawing, which the export's frames are made by too.
    const gen = genDraw.genAt(layer, at - layer.start, frame.width, frame.height);
    genDraw.drawGenTransition(ctx, entry.el, going, genDraw.transitionBox(gen, frame.width, frame.height),
      frame.width, frame.height, canvas.width / frame.width, canvas.height / frame.height);
    return;
  }
  // A file's picture is placed through a slide or a zoom by geometry.js, the
  // list composer.js turns into its expressions, and cut by a matte below.
  const moved = at !== null && layer.kind !== 'gen' ? shownKeysFor(layer, source, frame) : null;
  // V3.3. At a moment of the timeline, a layer with keyframes is wherever they
  // put it then: the same placementAt composer.js turns into its expressions.
  // The popup's drafts come without a moment, because a draft is one keyframe.
  // A generated layer's keyframes move what is drawn on its canvas, above,
  // and the canvas itself always covers the frame.
  const keyed = !!moved || (at !== null && layer.kind !== 'gen' && timelineModel.keyframesFor(layer).length);
  const placement = moved
    ? layerGeometry.shownPlacementAt(moved, at - layer.start)
    : keyed
    ? layerGeometry.placementAt(layer, at - layer.start, source, frame)
    : layerGeometry.placeLayer({
      source,
      // The two drafts the popup is editing, when it is the one drawing.
      // Defaulted to what the layer says, which is what every other caller
      // wants.
      crop,
      // V2.1. composer.js has read this since Step 3 and the preview never
      // did, so a positioned layer would have been shown in the middle of the
      // frame and written somewhere else. The two renderers are not allowed to
      // disagree, which is the rule the whole of Step 4 existed to establish.
      render,
      project: frame,
      ownSize: !!layer.ownSize,
    });
  const d = layerGeometry.drawImageArgs(placement, frame, canvas);
  if (!d) return;
  // V3.4. Turned about its own middle, by the moment's turn when it moves and
  // by the layer's own otherwise.
  const turn = keyed ? (placement.rotation || 0) : (layer.rotation || 0);
  // drawImage measures its source rectangle in the element's own intrinsic
  // size, which need not be the coded size the crop was set against. So the
  // rectangle is carried across as a fraction, exactly as paintCropFrame
  // does, and for the same reason the coded numbers are the ones stored:
  // they are what ffmpeg will crop with. Both are equal for square pixels,
  // where kx and ky come out at 1 and nothing is scaled at all.
  const kx = entry.width / source.width;
  const ky = entry.height / source.height;
  // V3.6. A masked picture is cut out first, at the size it is drawn, and the
  // cut-out is what is placed and turned, so the mask goes wherever the
  // picture goes. At the moment drawn, or the playhead's for a draft.
  // V4.7. And its Obscure and Pixelate before that, which need to know what
  // part of the source the rectangle is.
  // V4.12.1. A shape is the same cut-out made of a black picture, without
  // the Obscure and Pixelate, which change what is in a picture and not where
  // it is.
  const pic = maskedPicture(layer,
    shape ? blackPicture() : entry.el,
    shape ? [0, 0, 2, 2] : [d.sx * kx, d.sy * ky, d.sw * kx, d.sh * ky],
    d,
    at === null ? compositeAt : at,
    shape ? null : { x: d.sx, y: d.sy, w: d.sw, h: d.sh, W: source.width, H: source.height, ex: kx, ey: ky },
    // V4.10. The matte of a transition that cuts the picture, and the part
    // of the picture a slide is showing, which its mask is cut to as well.
    going && !timelineModel.transitionMoves(going.transition) ? going : null,
    (placement && placement.window) || null);
  // Where the picture goes, on any context: the box as `box` draws it, about
  // its own middle when it is turned.
  const placed = (c, box) => {
    if (!turn) {
      box(d.dx, d.dy);
      return;
    }
    c.save();
    c.translate(d.dx + d.dw / 2, d.dy + d.dh / 2);
    c.rotate(turn * Math.PI / 180);
    box(-d.dw / 2, -d.dh / 2);
    c.restore();
  };
  const veil = !!shape && shape.over
    && shapeHides(layer, canvas, keyed || !!going, (c) => placed(c, (x, y) => c.drawImage(pic.el, ...pic.from, x, y, d.dw, d.dh)));
  const alpha = ctx.globalAlpha;
  if (veil) ctx.globalAlpha = alpha * SHAPE_VEIL;
  placed(ctx, (x, y) => ctx.drawImage(pic.el, ...pic.from, x, y, d.dw, d.dh));
  if (!veil) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(235, 235, 240, 0.9)';
  ctx.lineWidth = 2;
  // Inside the box by the line's own half, so one that fills the frame has
  // its outline on the canvas and not cut in half by its edge.
  placed(ctx, (x, y) => ctx.strokeRect(x + 1, y + 1, d.dw - 2, d.dh - 2));
}

// ---- V4.12.1. The shapes a scrub draws for the files it is not seeking ----

// How much of the frame a shape over the followed file may hide and still be
// drawn black, and how dark the veil is that it is drawn as past that. The
// user asked for black shapes with a small picture over a full one in mind,
// where the shape is the point. A full picture over the chosen one, drawn
// black, would leave nothing of what was chosen: the veil is my answer to it.
const SHAPE_VEIL_ABOVE = 0.5;
const SHAPE_VEIL = 0.45;

let blackPictureCanvas = null;
/** Two black pixels by two: the picture a shape is cut out of. */
function blackPicture() {
  if (!blackPictureCanvas) {
    blackPictureCanvas = new OffscreenCanvas(2, 2);
    const c = blackPictureCanvas.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, 2, 2);
  }
  return blackPictureCanvas;
}

// Whether each layer's shape hides most of the frame, by the layer object,
// which is a new one whenever anything about the layer changes.
const shapeHidden = new WeakMap();
/**
 * Whether a shape lying over the followed file covers more of the frame than
 * SHAPE_VEIL_ABOVE, and so is drawn as a veil.
 *
 * Measured once a layer and kept: reading the measure back waits for the
 * graphics card, 2 to 4ms as a rule and 25 to 30 one draw in ten (measured
 * over a drag), which is too much to pay on every picture of a scrub for an
 * answer that does not change. A layer whose shape moves, by keyframes or a
 * transition under way, is measured each time, and so is one whose custom
 * mask is still being read.
 */
function shapeHides(layer, canvas, moving, draw) {
  const mask = layer.mask && layer.mask.kind === 'custom' ? maskPictures.get(layer.mask.src + '|' + layer.mask.by) : null;
  const keep = !moving && (!layer.mask || layer.mask.kind !== 'custom' || !!(mask && mask.canvas));
  const frame = projectFrame();
  const key = canvas.width + 'x' + canvas.height + ':' + frame.width + 'x' + frame.height;
  const kept = keep ? shapeHidden.get(layer) : null;
  if (kept && kept.key === key) return kept.hides;
  const hides = shapeCover(canvas, draw) > SHAPE_VEIL_ABOVE;
  if (keep) shapeHidden.set(layer, { key, hides });
  return hides;
}

let shapeProbe = null;
/**
 * How much of the canvas a drawing covers, 0 to 1, weighed by how solid it
 * is. Measured and not worked out: the drawing is made by `draw` on a small
 * copy of the canvas and its alpha added up, which takes a crop, a turn, a
 * mask and a transition's cut as they come.
 */
function shapeCover(canvas, draw) {
  const w = 32;
  const h = Math.max(1, Math.round(w * canvas.height / canvas.width));
  if (!shapeProbe) shapeProbe = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  if (shapeProbe.canvas.height !== h) shapeProbe.canvas.height = h;
  shapeProbe.setTransform(1, 0, 0, 1, 0, 0);
  shapeProbe.clearRect(0, 0, w, h);
  shapeProbe.setTransform(w / canvas.width, 0, 0, h / canvas.height, 0, 0);
  draw(shapeProbe);
  const data = shapeProbe.getImageData(0, 0, w, h).data;
  let sum = 0;
  for (let i = 3; i < data.length; i += 4) sum += data[i];
  return sum / (255 * w * h);
}

// ---- V3.6. Masked pictures ----

// Two surfaces, kept: the picture, and its mask. Every masked layer is cut out
// on them in turn, and each is drawn out before the next is cut.
// V4.7. Three more for the VFX: the effect, and two that the blur's copy and
// Pixelate's halvings are made on.
// V4.8. And one for the whole picture with the earlier VFX on it, see layVfx.
const maskedSurfaces = [null, null, null, null, null, null, null];
function maskedSurface(i, w, h) {
  if (!maskedSurfaces[i]) maskedSurfaces[i] = new OffscreenCanvas(w, h).getContext('2d');
  const c = maskedSurfaces[i].canvas;
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return maskedSurfaces[i];
}

/**
 * What to draw for a layer's picture: the element and its source rect as they
 * are, or with a mask the picture cut out at the size `d` draws it, the mask
 * as it is at `at` on the timeline. drawMask is the export's drawing too.
 */
// V4.7. `src`, when given, says what part of the source picture `from` is,
// and with it the layer's VFX are laid on first, see layVfx.
// V4.10. `matte`, when given, is the transition cutting the picture at this
// moment (timeline.js transitionAt), laid on last, and `win` the part of the
// whole picture being drawn, as fractions of it, when a slide shows only part.
function maskedPicture(layer, el, from, d, at, src = null, matte = null, win = null) {
  const mask = layer.kind !== 'gen' ? timelineModel.maskAt(layer, at - layer.start) : null;
  // A custom mask whose picture cannot be read, gone from the disk since, is
  // shown as no mask rather than as a picture with nothing left of it.
  const cut = !!mask && !maskPictureFailed(mask);
  // V5.0. Its VFX as their keyframes have them at `at`, in the order they
  // are processed, the ones that are off at this moment left out.
  // V5.5.1. In the order they are worked, which puts an Echo first.
  let effects = (src ? timelineModel.vfxWorked(layer) : [])
    .map((v) => timelineModel.vfxAt(v, at - layer.start))
    .filter((v) => !v.off && VFX_PREVIEW[v.kind]);
  if (!cut && !effects.length && !matte) return { el, from };
  // V5.5.1. An Echo is not laid on the picture: it is the picture the rest
  // is made of, the frame mixed with the ones before it.
  if (effects.length && VFX_PREVIEW[effects[0].kind].first) {
    const mixed = echoPicture(layer, el, at, effects[0]);
    effects = effects.slice(1);
    if (mixed) {
      from = [from[0] * mixed.kx, from[1] * mixed.ky, from[2] * mixed.kx, from[3] * mixed.ky];
      src = { ...src, ex: src.ex * mixed.kx, ey: src.ey * mixed.ky };
      el = mixed.el;
    }
  }
  const w = Math.max(1, Math.round(d.dw));
  const h = Math.max(1, Math.round(d.dh));
  const p = maskedSurface(0, w, h);
  p.globalCompositeOperation = 'source-over';
  p.clearRect(0, 0, w, h);
  p.drawImage(el, ...from, 0, 0, w, h);
  vfxDrawnAt = at - layer.start;
  layVfx(p, effects, el, src, w, h);
  if (cut) {
    const m = maskedSurface(1, w, h);
    m.setTransform(1, 0, 0, 1, 0, 0);
    if (win && win.w > 0 && win.h > 0) {
      // V4.10. A slide is showing part of the picture, and the mask is the
      // whole picture's: drawn at the whole picture's size, moved so that the
      // part showing is the part on the surface.
      m.clearRect(0, 0, w, h);
      const W = w / win.w;
      const H = h / win.h;
      m.setTransform(1, 0, 0, 1, -win.x * W, -win.y * H);
      genDraw.drawMask(m, mask, W, H, maskPicture(mask));
      m.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      genDraw.drawMask(m, mask, w, h, maskPicture(mask));
    }
    p.globalCompositeOperation = 'destination-in';
    p.drawImage(m.canvas, 0, 0);
    p.globalCompositeOperation = 'source-over';
  }
  if (matte) {
    // V4.10. The transition's matte: the new picture kept where it shows on
    // its way in, the old one taken away there on its way out.
    const m = maskedSurface(1, w, h);
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, w, h);
    genDraw.drawTransitionMatte(m, matte.transition, matte.e, w, h);
    p.globalCompositeOperation = matte.half === 'in' ? 'destination-in' : 'destination-out';
    p.drawImage(m.canvas, 0, 0);
    p.globalCompositeOperation = 'source-over';
  }
  return { el: p.canvas, from: [0, 0, w, h] };
}

// ---- V5.5.1. Echo: the frames from before ----
//
// An Echo mixes the frame shown with the track's frames from a little
// earlier (vfxOps.js echoFrames says which, and how much of each). The
// export has them: its filter keeps the frames that pass. The preview has
// one frame, the one its decoder stands on. So each track with an Echo
// keeps a few of its frames here, by their number in the clip at the
// project's rate:
//   - While playing, every frame drawn is kept, small, as it goes by.
//   - Standing still, the ones an Echo asks for are fetched by a second
//     decoder of the same file, one seek after the other, each waited for
//     (several seeks of one decoder at once are what Chromium loses), and
//     the picture is drawn again when they are there. seekDecodersTo waits
//     for them too, so whoever waits for a frame gets the finished one.
// Until a frame is there its share goes to the frame shown, so the picture
// is never darker for the wait, only without that echo.
const echoStores = new Map();
// As many frames a track keeps, the widest a kept frame is while playing and
// standing still, and how long a fetch waits for one seek.
const ECHO_KEEP = 64;
const ECHO_PLAY_W = 960;
const ECHO_STILL_W = 1920;
const ECHO_SEEK_MS = 4000;
// How far into a frame's stretch of time the fetching decoder is put, in frames.
const ECHO_INTO = 0.1;

/**
 * A track's store. Its frames are kept by their number in the clip, which
 * says which frame of the file only while the clip starts where it did in
 * the file, runs at the speed it did and the project has the rate it had:
 * when any of that has changed (`sig`) the frames kept are another clip's
 * and are let go.
 */
function echoStore(layer) {
  let store = echoStores.get(layer.id);
  if (!store) {
    store = { frames: new Map(), el: null, url: '', busy: null, want: null, spare: [], sig: '' };
    echoStores.set(layer.id, store);
  }
  const sig = [layer.src, timelineModel.sourceTimeFor(layer, layer.start), timelineModel.sourceTimeFor(layer, layer.start + 1),
    projectFrame().fps].join('|');
  if (store.sig !== sig) {
    for (const kept of store.frames.values()) store.spare.push(kept.canvas);
    store.frames.clear();
    store.sig = sig;
  }
  return store;
}

/** A track's kept frames let go, with the decoder that fetched them. */
function releaseEcho(id) {
  const store = echoStores.get(id);
  if (!store) return;
  echoStores.delete(id);
  store.want = null;
  if (store.el) {
    store.el.removeAttribute('src');
    store.el.load();
    store.el.remove();
  }
}

/** The clip's frame number at `at` of the timeline, the first being 0. */
function echoFrameAt(layer, at) {
  return Math.max(0, Math.floor((at - layer.start) * projectFrame().fps + 1e-6));
}

/** A frame kept: the element's picture as it stands, no wider than `widest`. */
function echoKeep(store, n, el, widest, rough) {
  const k = Math.min(1, widest / Math.max(1, el.videoWidth));
  const w = Math.max(1, Math.round(el.videoWidth * k));
  const h = Math.max(1, Math.round(el.videoHeight * k));
  let kept = store.frames.get(n);
  if (!kept) {
    // The oldest out first, and its surface used again.
    if (store.frames.size >= ECHO_KEEP) {
      let far = null;
      for (const key of store.frames.keys()) if (far === null || Math.abs(key - n) > Math.abs(far - n)) far = key;
      store.spare.push(store.frames.get(far).canvas);
      store.frames.delete(far);
    }
    kept = { canvas: store.spare.pop() || new OffscreenCanvas(w, h), rough };
    store.frames.set(n, kept);
  }
  if (kept.canvas.width !== w) kept.canvas.width = w;
  if (kept.canvas.height !== h) kept.canvas.height = h;
  const ctx = kept.canvas.getContext('2d');
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(el, 0, 0, w, h);
  kept.rough = rough;
}

/** One seek of the fetching decoder, waited for: true when its picture is there. */
function echoSeek(el, want) {
  return new Promise((resolve) => {
    if (Math.abs(el.currentTime - want) < 0.0005 && el.readyState >= 2 && !el.seeking) {
      resolve(true);
      return;
    }
    const done = (ok) => {
      el.removeEventListener('seeked', landed);
      clearTimeout(timer);
      resolve(ok);
    };
    const landed = () => done(true);
    const timer = setTimeout(() => done(false), ECHO_SEEK_MS);
    el.addEventListener('seeked', landed);
    el.currentTime = want;
  });
}

/**
 * The frames `numbers` of a track fetched into its store, the ones not there
 * yet (or only kept small), one after the other. A later call with other
 * numbers takes over from the one running. Resolves when the frames asked
 * for last are there, or cannot be had.
 */
function echoFetch(layer, numbers) {
  const entry = decoders.get(layer.id);
  if (!entry || entry.still || entry.gen || !entry.width || !entry.el.src) return Promise.resolve();
  const store = echoStore(layer);
  const missing = (n) => !store.frames.has(n) || store.frames.get(n).rough;
  store.want = { layer, numbers: [...new Set(numbers)] };
  if (!store.want.numbers.some(missing)) return Promise.resolve();
  if (store.busy) return store.busy;
  store.busy = (async () => {
    if (!store.el || store.url !== entry.el.src) {
      if (store.el) store.el.remove();
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.playsInline = true;
      store.el = v;
      store.url = entry.el.src;
      compositePool.appendChild(v);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ECHO_SEEK_MS);
        v.addEventListener('loadeddata', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
        v.src = store.url;
      });
    }
    const fps = projectFrame().fps;
    let got = false;
    for (;;) {
      if (echoStores.get(layer.id) !== store || !store.want) break;
      const now = store.want;
      const n = now.numbers.find(missing);
      if (n === undefined) break;
      // A little into the frame's own stretch of time: the frame the file
      // has begun by the frame's moment, which is the one the export takes
      // and the preview shows with the playhead on it. Not its middle: at
      // double speed that is the edge between two of the file's frames
      // (measured: 2.2 of 255 off the export there, 1.2 this way).
      const sig = store.sig;
      const ok = await echoSeek(store.el, timelineModel.sourceTimeFor(now.layer, now.layer.start + (n + ECHO_INTO) / fps));
      if (echoStores.get(layer.id) !== store) break;
      // The clip was cut or sped up meanwhile: this frame is none of its frames now.
      if (store.sig !== sig) continue;
      if (ok && store.el.videoWidth) {
        echoKeep(store, n, store.el, ECHO_STILL_W, false);
        got = true;
      } else {
        // One that cannot be had is not asked for again and again.
        now.numbers = now.numbers.filter((x) => x !== n);
      }
    }
    store.busy = null;
    // The picture again, now with the frames it was missing.
    if (got && !compositePlaying) {
      drawComposite();
      if (typeof paintVfxStage === 'function') paintVfxStage();
    }
  })();
  return store.busy;
}

/** The numbers of the frames from before that an Echo as it is at `at` mixes, for a track. */
function echoNeeds(layer, at) {
  const v = timelineModel.vfxWorked(layer)[0];
  if (!v || !VFX_PREVIEW[v.kind] || !VFX_PREVIEW[v.kind].first) return [];
  const now = timelineModel.vfxAt(v, at - layer.start);
  if (now.off) return [];
  const [op] = vfxOps.opsOf(now.kind, now, 1, 1);
  const n = echoFrameAt(layer, at);
  return op ? vfxOps.echoFrames(op, n).slice(1).map((f) => f[0]).filter((x) => x !== n) : [];
}

/**
 * The frame shown mixed with the frames before it, as the Echo `v` says at
 * `at`: `{ el, kx, ky }`, a surface to read the picture from in place of
 * the element and how many of its pixels one of the element's is. Null for
 * a picture that has no frames (a still), which an Echo leaves as it is.
 */
function echoPicture(layer, el, at, v) {
  if (!(el instanceof HTMLVideoElement) || !el.videoWidth) return null;
  const [op] = vfxOps.opsOf(v.kind, v, 1, 1);
  if (!op) return null;
  const store = echoStore(layer);
  const n = echoFrameAt(layer, at);
  // While playing every frame that goes by is kept for the ones after it.
  if (compositePlaying && !store.frames.has(n)) echoKeep(store, n, el, ECHO_PLAY_W, true);
  const mix = v.mix === undefined ? 1 : v.mix / 100;
  const parts = vfxOps.echoFrames(op, n, mix);
  const k = Math.min(1, ECHO_STILL_W / el.videoWidth);
  const w = Math.max(1, Math.round(el.videoWidth * k));
  const h = Math.max(1, Math.round(el.videoHeight * k));
  const e = maskedSurface(6, w, h);
  e.setTransform(1, 0, 0, 1, 0, 0);
  e.filter = 'none';
  e.globalCompositeOperation = 'source-over';
  e.clearRect(0, 0, w, h);
  e.globalCompositeOperation = 'lighter';
  let own = parts[0][1];
  const missing = [];
  for (const [number, share] of parts.slice(1)) {
    // A frame that is this one (the clip's first, asked for from before it) is this one.
    const kept = number === n ? null : store.frames.get(number);
    if (!kept) {
      own += share;
      if (number !== n) missing.push(number);
      continue;
    }
    if (kept.rough && !compositePlaying) missing.push(number);
    e.globalAlpha = share;
    e.drawImage(kept.canvas, 0, 0, w, h);
  }
  e.globalAlpha = Math.min(1, own);
  e.drawImage(el, 0, 0, w, h);
  e.globalAlpha = 1;
  e.globalCompositeOperation = 'source-over';
  // Standing still, what was missing is fetched and the picture drawn again.
  if (missing.length && !compositePlaying) echoFetch(layer, parts.slice(1).map((f) => f[0]).filter((x) => x !== n));
  return { el: e.canvas, kx: w / el.videoWidth, ky: h / el.videoHeight };
}

// V4.10. A layer's placements through a slide or a zoom, kept by the layer
// object and the frame it was worked out for: asked for on every frame drawn,
// and a layer is a new object whenever anything about it changes.
const shownKeysCache = new WeakMap();
function shownKeysFor(layer, source, frame) {
  const key = source.width + 'x' + source.height + ':' + frame.width + 'x' + frame.height;
  const kept = shownKeysCache.get(layer);
  if (kept && kept.key === key) return kept.keys;
  const steps = timelineModel.transitionSteps(layer);
  // Gravity (5.3.0). A picture that falls is placed by its fall, worked out
  // once for the layer as it is and kept like a transition's list.
  const keys = layerGravity.keysOf(layer, source, frame)
    || (steps.length ? layerGeometry.shownKeys(layer, source, frame, steps) : null);
  shownKeysCache.set(layer, { key, keys });
  return keys;
}

// ---- V5.0. VFX (V4.7 and V4.8: Obscure and Pixelate) ----
//
// The export does every VFX to the source picture, before it is cropped,
// placed or turned, one after the other in the track's order (composer.js
// vfxHead). Here the picture is already cut out at the size it is drawn, `w`
// by `h`, so the same is worked out at that size: `src` is the part of the
// source that is, { x, y, w, h } in the source's pixels, { W, H } its whole
// size, and { ex, ey } the element's pixels for one of the source's.
//
// Each kind has a row here: `room`, what genDraw.coverRegion needs to say
// which part of the picture it reads and changes, and `draw`, the picture
// with the effect on all of it, onto `e`. A new kind is a new row; the
// cutting to where it acts, the order and the keyframes are the same for all.
//
// Obscure is a Gaussian of the sigma the export uses, scaled to the drawing.
// Pixelate is the source drawn small, one pixel to a block, and back up
// without smoothing; the blocks are counted from the source's corner as the
// encoder counts them, so a crop does not shift the grid.
//
// V5.1. Every later kind but Tilt-Shift is drawn from its ops (vfxOps.js) by
// the graphics card (vfxGl.js), the one row OPS_PREVIEW for all of them: what
// a kind does is written once, there, for this and for the export. Tilt-Shift
// is Obscure's blur with another start.
const OPS_PREVIEW = {
  room: (v, H) => {
    const room = vfxOps.roomOf(vfxOps.opsOf(v.kind, v, Math.round(H * 16 / 9), H));
    // One worked out of the whole picture reads all of it.
    return { margin: room.whole ? 1e9 : room.margin };
  },
  draw: (e, p, v, el, src, w, h) => drawVfxOps(e, p, v, el, src, w, h),
};
const BLUR_PREVIEW = {
  room: (v, H) => ({ margin: Math.ceil(timelineModel.obscureSigma(v.strength, H) * 3) }),
  draw: (e, p, v, el, src, w, h) => coverBlur(e, p, el, src, w, h,
    timelineModel.obscureSigma(v.strength, src.H) * (h / src.h)),
};
const VFX_PREVIEW = {
  obscure: { ...BLUR_PREVIEW },
  pixelate: {
    room: (v, H) => ({ grid: timelineModel.pixelateBlock(v.strength, H) }),
    draw: (e, p, v, el, src, w, h) => coverBlocks(e, el, src, w / src.w, h / src.h,
      timelineModel.pixelateBlock(v.strength, src.H)),
  },
  dirblur: { ...OPS_PREVIEW },
  tiltshift: { ...BLUR_PREVIEW },
  brightness: { ...OPS_PREVIEW },
  exposure: { ...OPS_PREVIEW },
  levels: { ...OPS_PREVIEW },
  huesat: { ...OPS_PREVIEW },
  temperature: { ...OPS_PREVIEW },
  rgb: { ...OPS_PREVIEW },
  mono: { ...OPS_PREVIEW },
  sepia: { ...OPS_PREVIEW },
  colorize: { ...OPS_PREVIEW },
  duotone: { ...OPS_PREVIEW },
  colorpass: { ...OPS_PREVIEW },
  look: { ...OPS_PREVIEW },
  invert: { ...OPS_PREVIEW },
  glow: { ...OPS_PREVIEW },
  sharpen: { ...OPS_PREVIEW },
  vignette: { ...OPS_PREVIEW },
  grain: { ...OPS_PREVIEW },
  scanlines: { ...OPS_PREVIEW },
  rgbsplit: { ...OPS_PREVIEW },
  posterize: { ...OPS_PREVIEW },
  threshold: { ...OPS_PREVIEW },
  solarize: { ...OPS_PREVIEW },
  edges: { ...OPS_PREVIEW },
  emboss: { ...OPS_PREVIEW },
  nightvision: { ...OPS_PREVIEW },
  thermal: { ...OPS_PREVIEW },
  lens: { ...OPS_PREVIEW },
  flip: { ...OPS_PREVIEW },
  shadows: { ...OPS_PREVIEW },
  splittone: { ...OPS_PREVIEW },
  channels: { ...OPS_PREVIEW },
  clarity: { ...OPS_PREVIEW },
  dream: { ...OPS_PREVIEW },
  oldfilm: { ...OPS_PREVIEW },
  vhs: { ...OPS_PREVIEW },
  crt: { ...OPS_PREVIEW },
  bars: { ...OPS_PREVIEW },
  offset: { ...OPS_PREVIEW },
  comic: { ...OPS_PREVIEW },
  border: { ...OPS_PREVIEW },
  rotate: { ...OPS_PREVIEW },
  zoom: { ...OPS_PREVIEW },
  wave: { ...OPS_PREVIEW },
  ripple: { ...OPS_PREVIEW },
  swirl: { ...OPS_PREVIEW },
  shake: { ...OPS_PREVIEW },
  glitch: { ...OPS_PREVIEW },
  haze: { ...OPS_PREVIEW },
  tile: { ...OPS_PREVIEW },
  kaleido: { ...OPS_PREVIEW },
  perspective: { ...OPS_PREVIEW },
  bulge: { ...OPS_PREVIEW },
  lut: { ...OPS_PREVIEW },
  cornerpin: { ...OPS_PREVIEW },
  polar: { ...OPS_PREVIEW },
  vibrance: { ...OPS_PREVIEW },
  halftone: { ...OPS_PREVIEW },
  curves: { ...OPS_PREVIEW },
  chromakey: { ...OPS_PREVIEW },
  lumakey: { ...OPS_PREVIEW },
  strobe: { ...OPS_PREVIEW },
  // V5.5.1. Not drawn as a pass: it is the picture the others are given (echoPicture).
  echo: { room: () => ({ margin: 0 }), draw: (e, p) => e.drawImage(p.canvas, 0, 0), first: true },
  // Gravity (5.3.0). Not drawn at all: it is where the picture is put (shownKeysFor).
  gravity: { room: () => ({ margin: 0 }), draw: (e, p) => e.drawImage(p.canvas, 0, 0) },
};

// The moment maskedPicture is drawing, in the clip's own seconds, for a kind
// whose picture changes by the frame with no setting changing (grain, and
// the ones that move by themselves: a wave, a shake).
let vfxDrawnAt = 0;

/**
 * V5.1. The picture with a kind's ops on all of it, onto `e`. What the ops
 * read beside the part shown is taken along: the source round the crop as far
 * as they reach, or all of the source for one worked out of the whole
 * picture, drawn at the size the part is shown. Read from `el`, the file's
 * picture or the underlay with earlier VFX on it, as the other kinds do.
 */
function drawVfxOps(e, p, v, el, src, w, h) {
  const ops = vfxOps.opsOf(v.kind, v, src.W, src.H);
  const room = vfxOps.roomOf(ops);
  const kx = w / src.w;
  const ky = h / src.h;
  // How far the source goes on past each edge of the part shown, in pixels here.
  const has = {
    l: Math.max(0, Math.round(src.x * kx)),
    t: Math.max(0, Math.round(src.y * ky)),
    r: Math.max(0, Math.round((src.W - src.x - src.w) * kx)),
    b: Math.max(0, Math.round((src.H - src.y - src.h) * ky)),
  };
  const want = room.whole ? Infinity : (room.margin ? Math.ceil(room.margin * Math.max(kx, ky)) + 1 : 0);
  const pad = { l: Math.min(has.l, want), t: Math.min(has.t, want), r: Math.min(has.r, want), b: Math.min(has.b, want) };
  const fw = w + pad.l + pad.r;
  const fh = h + pad.t + pad.b;
  const x = maskedSurface(3, fw, fh);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.filter = 'none';
  x.imageSmoothingEnabled = true;
  x.clearRect(0, 0, fw, fh);
  const sx = Math.max(0, src.x - pad.l / kx);
  const sy = Math.max(0, src.y - pad.t / ky);
  const sw = Math.min(src.W - sx, fw / kx);
  const sh = Math.min(src.H - sy, fh / ky);
  x.drawImage(el, sx * src.ex, sy * src.ey, sw * src.ex, sh * src.ey, 0, 0, fw, fh);
  const out = vfxGl.run(x.canvas, {
    scale: [kx, ky],
    pic: [pad.l - src.x * kx, pad.t - src.y * ky, src.W * kx, src.H * ky],
    time: vfxDrawnAt,
  }, vfxGl.passesOf(ops, kx, ky, vfxDrawnAt));
  if (!out) {
    e.drawImage(x.canvas, pad.l, pad.t, w, h, 0, 0, w, h);
    return;
  }
  e.drawImage(out, pad.l, pad.t, w, h, 0, 0, w, h);
}

/**
 * One VFX laid on the picture `p`: the effect made of the whole picture and
 * then blended in where it acts, genDraw.drawCoverMask laid the way the
 * source is: the picture taken out there and the effect put in, not the one
 * over the other, which on a PNG with see-through parts would add the two up.
 * `v` is the VFX at the moment drawn (timeline.js vfxAt), and `el` with
 * `src` what it reads the picture from.
 */
function layCover(p, v, el, src, w, h) {
  const kx = w / src.w;
  const ky = h / src.h;
  const e = maskedSurface(2, w, h);
  e.setTransform(1, 0, 0, 1, 0, 0);
  e.globalCompositeOperation = 'source-over';
  e.filter = 'none';
  e.clearRect(0, 0, w, h);
  VFX_PREVIEW[v.kind].draw(e, p, v, el, src, w, h);
  // V5.1. One that acts on all of the picture at full Mix is the picture
  // from here on: nothing of where it acts to draw, nothing to blend.
  if (timelineModel.vfxCoversAll(v) && !(v.mix < 100)) {
    p.globalCompositeOperation = 'copy';
    p.drawImage(e.canvas, 0, 0);
    p.globalCompositeOperation = 'source-over';
    return;
  }
  const m = maskedSurface(1, w, h);
  m.setTransform(1, 0, 0, 1, 0, 0);
  m.clearRect(0, 0, w, h);
  m.setTransform(kx, 0, 0, ky, -src.x * kx, -src.y * ky);
  genDraw.drawCoverMask(m, v, src.W, src.H);
  m.setTransform(1, 0, 0, 1, 0, 0);
  e.globalCompositeOperation = 'destination-in';
  e.drawImage(m.canvas, 0, 0);
  e.globalCompositeOperation = 'source-over';
  p.globalCompositeOperation = 'destination-out';
  p.drawImage(m.canvas, 0, 0);
  p.globalCompositeOperation = 'lighter';
  p.drawImage(e.canvas, 0, 0);
  p.globalCompositeOperation = 'source-over';
}

/**
 * V5.0. A track's VFX laid on the picture `p` in their order, each one
 * working on what the ones before it left, as the export has it: a block is
 * the average of what is there by then, a blur of a pixelated part blurs the
 * blocks.
 *
 * The picture drawn is only the part of the source that shows, at the size
 * it shows, and an effect reads more than that: Pixelate whole blocks,
 * Obscure the pixels beside what it blurs. So what a later VFX reads is kept
 * on the side, the whole source picture with the earlier ones on it (the
 * underlay, V4.8's answer for an Obscure under a Pixelate, here for any
 * order and number). Only where it is needed: a VFX goes onto the underlay
 * when a later one touches the part it changed, and one reads the underlay
 * when an earlier one changed the part it reads. Two that never meet cost
 * what they did alone, which is the common case of several faces hidden.
 *
 * The underlay is made no finer than the picture is drawn, so a small
 * preview of a large source costs a small surface.
 */
function layVfx(p, list, el, src, w, h) {
  if (!list.length) return;
  const parts = list.map((v) => genDraw.coverRegion(v, src.W, src.H, VFX_PREVIEW[v.kind].room(v, src.H)));
  const meet = (a, b) => !!a && !!b
    && !(a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height);
  // V5.1. A picture shown whole is its own underlay: each VFX reads what is
  // on it by then and is laid on once. Only a cropped one needs the whole
  // source kept on the side, below.
  if (src.x === 0 && src.y === 0 && src.w === src.W && src.h === src.H) {
    let laid = false;
    list.forEach((v, i) => {
      if (!parts[i]) return;
      if (laid) layCover(p, v, p.canvas, { ...src, ex: w / src.W, ey: h / src.H }, w, h);
      else layCover(p, v, el, src, w, h);
      laid = true;
    });
    return;
  }
  let under = null;
  const onUnder = [];
  list.forEach((v, i) => {
    const part = parts[i];
    // One that touches none of the picture changes none of it.
    if (!part) return;
    const reads = !!under && onUnder.some((j) => meet(parts[j], part));
    if (reads) layCover(p, v, under.el, { ...src, ex: under.ex, ey: under.ey }, w, h);
    else layCover(p, v, el, src, w, h);
    if (!list.some((o, j) => j > i && meet(part, parts[j]))) return;
    if (!under) under = vfxUnderlay(el, src, w, h);
    const whole = { x: 0, y: 0, w: src.W, h: src.H, W: src.W, H: src.H };
    if (reads) layCover(under.ctx, v, under.el, { ...whole, ex: under.ex, ey: under.ey }, under.w, under.h);
    else layCover(under.ctx, v, el, { ...whole, ex: src.ex, ey: src.ey }, under.w, under.h);
    onUnder.push(i);
  });
}

/** The whole source picture on a surface of its own, for layVfx to lay VFX on. */
function vfxUnderlay(el, src, w, h) {
  const k = Math.min(1, Math.max(w / src.w, h / src.h));
  const uw = Math.max(1, Math.round(src.W * Math.min(src.ex, k)));
  const uh = Math.max(1, Math.round(src.H * Math.min(src.ey, k)));
  const u = maskedSurface(5, uw, uh);
  u.setTransform(1, 0, 0, 1, 0, 0);
  u.globalCompositeOperation = 'source-over';
  u.filter = 'none';
  u.clearRect(0, 0, uw, uh);
  u.drawImage(el, 0, 0, src.W * src.ex, src.H * src.ey, 0, 0, uw, uh);
  return { ctx: u, el: u.canvas, w: uw, h: uh, ex: uw / src.W, ey: uh / src.H };
}

/**
 * The picture blurred, onto `e`. A blur reaches past what it is given, and
 * past the edge of a canvas there is nothing, which would fade the picture's
 * own edge out. So it is blurred from a copy with room round it: the source
 * beyond the crop where there is some, which is what the export blurs with,
 * and the edge's own pixels drawn out where there is not.
 */
function coverBlur(e, p, el, src, w, h, sigma) {
  if (!(sigma > 0.2)) {
    e.drawImage(p.canvas, 0, 0);
    return;
  }
  const pad = Math.ceil(sigma * 3);
  const x = maskedSurface(3, w + pad * 2, h + pad * 2);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.imageSmoothingEnabled = true;
  x.clearRect(0, 0, w + pad * 2, h + pad * 2);
  const c = p.canvas;
  x.drawImage(c, 0, 0, 1, h, 0, pad, pad, h);
  x.drawImage(c, w - 1, 0, 1, h, pad + w, pad, pad, h);
  x.drawImage(c, 0, 0, w, 1, pad, 0, w, pad);
  x.drawImage(c, 0, h - 1, w, 1, pad, pad + h, w, pad);
  x.drawImage(c, 0, 0, 1, 1, 0, 0, pad, pad);
  x.drawImage(c, w - 1, 0, 1, 1, pad + w, 0, pad, pad);
  x.drawImage(c, 0, h - 1, 1, 1, 0, pad + h, pad, pad);
  x.drawImage(c, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad);
  // What the source has beyond the crop, held to the source: drawImage is not
  // asked for anything outside the element.
  const sx = pad * src.w / w;
  const sy = pad * src.h / h;
  const x0 = Math.max(0, src.x - sx);
  const y0 = Math.max(0, src.y - sy);
  const x1 = Math.min(src.W, src.x + src.w + sx);
  const y1 = Math.min(src.H, src.y + src.h + sy);
  x.drawImage(el, x0 * src.ex, y0 * src.ey, (x1 - x0) * src.ex, (y1 - y0) * src.ey,
    pad + (x0 - src.x) * w / src.w, pad + (y0 - src.y) * h / src.h, (x1 - x0) * w / src.w, (y1 - y0) * h / src.h);
  e.filter = 'blur(' + sigma.toFixed(2) + 'px)';
  e.drawImage(x.canvas, -pad, -pad);
  e.filter = 'none';
}

/**
 * The picture in blocks of `B` source pixels, onto `e`, each block the
 * average of what it covers, which is what the encoder's pixelize makes it.
 *
 * Drawn straight down to a pixel a block, the browser takes a sample or two
 * of each block rather than its average (measured on a checkerboard: the
 * blocks came out a pattern of their own where the file had one even grey).
 * So the source is first drawn at `f` pixels a block, a power of two near its
 * own size, and then halved until it is one: a halving is the average of four
 * pixels, exactly.
 *
 * A last column or row cut short by the source's edge is a block of its own,
 * as the encoder has it, so it is drawn by itself rather than as part of a
 * whole one.
 */
function coverBlocks(e, el, src, kx, ky, B) {
  const spans = (from, to, most) => {
    const a = Math.floor(from / B) * B;
    const b = Math.min(most, Math.ceil(to / B) * B);
    const whole = Math.floor((b - a) / B);
    const out = [];
    if (whole > 0) out.push({ at: a, len: whole * B, n: whole });
    if (b - a - whole * B > 0) out.push({ at: a + whole * B, len: b - a - whole * B, n: 1 });
    return out;
  };
  const cols = spans(src.x, src.x + src.w, src.W);
  const rows = spans(src.y, src.y + src.h, src.H);
  const nx = cols.reduce((sum, c) => sum + c.n, 0);
  const ny = rows.reduce((sum, r) => sum + r.n, 0);
  if (!nx || !ny) return;
  // Pixels a block to start from: the block's own size in the element, down
  // to a power of two, and no more than keeps the surface a sane size.
  let f = 1;
  const own = B * Math.min(src.ex, src.ey);
  while (f * 2 <= own && Math.max(nx, ny) * f * 2 <= 4096) f *= 2;
  let from = maskedSurface(3, nx * f, ny * f);
  from.setTransform(1, 0, 0, 1, 0, 0);
  from.clearRect(0, 0, nx * f, ny * f);
  from.imageSmoothingEnabled = true;
  from.imageSmoothingQuality = 'low';
  let ty = 0;
  for (const r of rows) {
    let tx = 0;
    for (const c of cols) {
      from.drawImage(el, c.at * src.ex, r.at * src.ey, c.len * src.ex, r.len * src.ey,
        tx * f, ty * f, c.n * f, r.n * f);
      tx += c.n;
    }
    ty += r.n;
  }
  let side = 4;
  for (let g = f; g > 1; g /= 2) {
    const to = maskedSurface(side, nx * g / 2, ny * g / 2);
    to.setTransform(1, 0, 0, 1, 0, 0);
    to.clearRect(0, 0, nx * g / 2, ny * g / 2);
    to.imageSmoothingEnabled = true;
    to.imageSmoothingQuality = 'low';
    to.drawImage(from.canvas, 0, 0, nx * g, ny * g, 0, 0, nx * g / 2, ny * g / 2);
    from = to;
    side = side === 4 ? 3 : 4;
  }
  e.imageSmoothingEnabled = false;
  ty = 0;
  for (const r of rows) {
    let tx = 0;
    for (const c of cols) {
      e.drawImage(from.canvas, tx, ty, c.n, r.n,
        (c.at - src.x) * kx, (r.at - src.y) * ky, c.len * kx, r.len * ky);
      tx += c.n;
    }
    ty += r.n;
  }
  e.imageSmoothingEnabled = true;
}

// A custom mask's picture is at most this big on its longer side. A mask is
// scaled to the picture it cuts anyway, and a 6000 pixel photograph turned
// into one would be a lot of memory for nothing.
const MASK_PICTURE_MAX = 2048;

// Custom mask pictures by file: { img, width, height, transparent } once read,
// and each as a mask by what shows, `file|by`, once made.
const maskFiles = new Map();
const maskPictures = new Map();

/**
 * A custom mask's file read into the window, once: the picture, its size, and
 * whether any of it is see-through, which is what Custom decides `by` from.
 */
function readMaskFile(src) {
  if (maskFiles.has(src)) return maskFiles.get(src);
  const job = (async () => {
    const url = await window.lwclipper.fileUrl(src);
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, MASK_PICTURE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * k));
    const height = Math.max(1, Math.round(img.naturalHeight * k));
    const c = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0, width, height);
    const transparent = genDraw.hasTransparency(c.getImageData(0, 0, width, height).data);
    return { img, width, height, transparent, aspect: img.naturalWidth / img.naturalHeight };
  })();
  // A file that cannot be read is asked about again next time, not never.
  job.catch(() => maskFiles.delete(src));
  maskFiles.set(src, job);
  return job;
}

/** A custom mask's picture made into a mask, as a promise, once per file and way. */
function loadMaskPicture(mask) {
  const key = mask.src + '|' + mask.by;
  const kept = maskPictures.get(key);
  if (kept) return kept.job;
  const entry = { canvas: null, job: null };
  entry.job = readMaskFile(mask.src).then((f) => {
    const c = new OffscreenCanvas(f.width, f.height).getContext('2d', { willReadFrequently: true });
    c.drawImage(f.img, 0, 0, f.width, f.height);
    const data = c.getImageData(0, 0, f.width, f.height);
    genDraw.maskPixels(data.data, mask.by);
    c.putImageData(data, 0, 0);
    entry.canvas = c.canvas;
    return c.canvas;
  });
  entry.job.catch(() => {
    maskPictures.delete(key);
    maskFailed.add(key);
  });
  maskPictures.set(key, entry);
  return entry.job;
}

// Custom mask pictures that could not be read this session, by `file|by`.
// Picking one again through Custom asks again.
const maskFailed = new Set();

function maskPictureFailed(mask) {
  return mask.kind === 'custom' && maskFailed.has(mask.src + '|' + mask.by);
}

/**
 * A custom mask's picture as the drawing wants it now, or null while it is
 * still being made, in which case the preview is drawn again once it is.
 */
function maskPicture(mask) {
  if (mask.kind !== 'custom' || !mask.src) return null;
  const kept = maskPictures.get(mask.src + '|' + mask.by);
  if (kept && kept.canvas) return kept.canvas;
  if (!kept && !maskPictureFailed(mask)) {
    loadMaskPicture(mask).then(() => {
      if (!compositePlaying) drawComposite();
      // V4.13. A trim frame drawn while it was on its way has no mask on it.
      renderTrimFrames();
    }, () => {});
  }
  return null;
}

// V3.3. What a popped out editor window is doing, for the main window's
// preview to show: { layerId, layerNow } draws that layer as the window's
// Accept would leave it, at whatever moment the playhead is on, and { frame }
// is a Render Frame draft, drawn as an outline with everything outside it
// dimmed. V3.8.2: one per window, by the window's own key, since several can
// be open at once; empty when none is. Only drawComposite reads them, so the
// editors' own stages and the trim frames are drawn as they always were.
const popoutPreviews = new Map();

/** A window's draft for the preview, replacing its last. */
function setPopoutPreview(owner, entry) {
  popoutPreviews.set(owner, entry);
}

/** A window's draft taken off the preview, which is drawn again if it had one. */
function clearPopoutPreview(owner) {
  if (!popoutPreviews.delete(owner)) return;
  drawComposite();
}

function paintLayers(ctx, canvas, at, scrub, skip, drafts = null) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Whether the one file a scrub seeks has been drawn yet: what comes after it
  // lies over it.
  let passed = false;
  // Back to front, which is the order layersAt hands them back in, so index 0
  // is drawn last and Video 1 ends up on top.
  for (const l of timelineModel.layersAt(layers, at)) {
    if (l.type !== 'video') continue;
    // Mid-scrub, of the pictures that come out of a file only the one that is
    // actually on the playhead's frame. The others still hold whatever the
    // last position decoded, and a frame from another moment drawn into the
    // composite has nothing on it to say it is not the real one.
    //
    // V4.12. Only of those. A text, a shape, a bar and an image have no
    // moment to be wrong about: they are drawn from their settings at `at`,
    // so they stay on through the drag. Until now the one layer drawn was the
    // top layer of any kind, and with a text clip on top that was the text:
    // nothing was seeked and the preview went black round the letters
    // (measured, 99.8% of it) for as long as the playhead moved.
    //
    // V4.12.1. Such a file is no longer left out. It is drawn as its shape,
    // black where its picture would be: where it lies, how big, turned, cut
    // by its mask and its transition, at its own alpha, all of which are
    // known without a frame. The user's idea, "only the mask-cutout as
    // black": the drag shows what covers what, and only the pictures wait.
    let shape = null;
    if (scrub) {
      const entry = decoders.get(l.id);
      if (entry && !entry.still && (!scrub.file || l.id !== scrub.file.id)) shape = { over: passed };
      else if (scrub.file && l.id === scrub.file.id) passed = true;
    }
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
    // V3.3. The layer a crop window is editing, as its Accept would leave it.
    const draft = drafts && drafts.get(l.id);
    const shown = (draft && draft()) || l;
    drawLayerInto(ctx, canvas, shown, undefined, undefined, at, shape);
    ctx.globalAlpha = 1;
  }
}

/** V3.3. A Render Frame draft over the preview: outlined, the rest dimmed. */
function drawFrameDraft(ctx, canvas, rect) {
  const frame = projectFrame();
  const kx = canvas.width / frame.width;
  const ky = canvas.height / frame.height;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(rect.x * kx, rect.y * ky, rect.width * kx, rect.height * ky);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fill('evenodd');
  ctx.strokeStyle = 'rgba(235, 235, 240, 0.9)';
  ctx.lineWidth = 2;
  ctx.strokeRect(rect.x * kx, rect.y * ky, rect.width * kx, rect.height * ky);
  ctx.restore();
}

function drawComposite() {
  if (compositeCanvas.hidden) return;
  // The pool is parked at a trim point rather than at the playhead, so whatever
  // it holds right now is not this canvas's picture. Step 10e.
  if (paintingFrames) return;
  const scrub = scrubMoving() ? scrubPlan() : null;
  // A scrub above 1080p seeks nothing, so there is nothing new to draw and the
  // canvas keeps the last full composite. Clearing it to black instead would be
  // less use than the stale picture, not more.
  if (scrub && scrub.hold) return;
  // Each window's layer as its Accept would leave it, by the layer's id.
  const drafts = new Map();
  let frame = null;
  for (const p of popoutPreviews.values()) {
    if (p.layerId) drafts.set(p.layerId, p.layerNow);
    if (p.frame) frame = p.frame;
  }
  paintLayers(compositeCtx, compositeCanvas, compositeAt, scrub, null, drafts.size ? drafts : null);
  if (frame) drawFrameDraft(compositeCtx, compositeCanvas, frame);
}

// Standing still: every covering layer on its exact frame, everything else
// paused. The tolerance is a thousandth of a second rather than the playing
// one, because a still frame that is nearly right is simply the wrong frame.
function parkDecoders() {
  const moving = scrubMoving();
  const only = moving ? scrubPlan().file : null;
  for (const l of layers) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    if (!entry || entry.still) continue;
    if (!entry.el.paused) entry.el.pause();
    // V4.13. While the Start and End frames are being built the pool is
    // theirs, parked on a trim point, and it comes back to the playhead when
    // they are done, see runTrimFrames. One change to the document comes
    // through here several times, and each time used to pull the decoders
    // back from under the frame being built: the frame was then drawn from
    // the playhead's picture, and three seeks of one element inside a
    // millisecond (here, the trim point, here again) left Chromium seeking
    // for good about one time in two, which was the ten second hold.
    if (framesRunning) continue;
    // Mid-scrub, only the top covering file moves, and above 1080p not even
    // that. Everything else is landed when the pointer rests or comes up.
    if (moving && (!only || l.id !== only.id)) continue;
    if (!entry.width || !layerOn(l) || !timelineModel.covers(l, compositeAt)) continue;
    const want = timelineModel.sourceTimeFor(l, compositeAt);
    if (Math.abs(entry.el.currentTime - want) < 0.001) continue;
    entry.el.currentTime = want;
  }
}

// Running: elements play at their own rate and are only dragged back when they
// are genuinely lost, since every re-seek is a decode. A layer the playhead has
// left, or one that has been switched off, stops rather than playing on unseen
// behind the others.
//
// V4.13. Inside that, an element that has slipped is bent back to the clock
// by its rate, see holdToClock, and a clip the playhead is about to reach is
// made ready before it gets there, see rollPhase.
function followDecoders() {
  for (const l of layers) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    // A still needs no following: its one frame is the right one at every
    // moment of the layer, playing or not.
    if (!entry || entry.still) continue;
    const v = entry.el;
    const phase = rollPhase(l);
    if (phase === 'on' || phase === 'roll') {
      // V4.11. At the layer's speed, and lost by as much more of the source
      // as goes by in the same time at it.
      // V5.5.2. And at the playback speed.
      holdToClock(v, timelineModel.sourceTimeFor(l, compositeAt), elementRate(l), COMPOSITE_SLACK, VIDEO_BEND);
      if (v.paused) v.play().catch(() => {});
    } else {
      if (!v.paused) v.pause();
      if (phase === 'ready') placeElement(v, readyPlace(l));
    }
  }
}

/**
 * V4.13. Where a layer's element stands against the playhead while the
 * project runs:
 *
 *   'on'     the playhead is on the clip, the element runs and is seen or heard;
 *   'roll'   the clip starts within ROLL_S and the file has that much before
 *            its in point: the element runs already, unseen and silent, so
 *            that it is on the clock when the cut comes;
 *   'ready'  the clip starts within PREROLL_S: the element is placed where it
 *            will start from and waits there;
 *   'off'    none of these, the element stands still.
 *
 * Until this a clip's element was looked at when the playhead reached it. It
 * was seeked then, so at every cut the picture stood 200 to 250ms on whatever
 * frame that element had been left on, the sound was silent as long, and the
 * clip ran up to a quarter second behind from there on (measured).
 */
function rollPhase(l) {
  if (!layerOn(l)) return 'off';
  if (timelineModel.covers(l, compositeAt)) return 'on';
  const ahead = l.start - compositeAt;
  if (!(ahead > 0) || ahead > PREROLL_S) return 'off';
  return ahead <= ROLL_S && rollsEarly(l) ? 'roll' : 'ready';
}

/** Whether the file has ROLL_S of itself before the clip's in point. */
function rollsEarly(l) {
  return timelineModel.sourceTimeFor(l, l.start - ROLL_S) >= 0;
}

/** Where in its file a clip that is about to start waits. */
function readyPlace(l) {
  return timelineModel.sourceTimeFor(l, rollsEarly(l) ? l.start - ROLL_S : l.start);
}

/** Put a standing element on a place in its file, unless it is there. */
function placeElement(el, want) {
  // Assigning the position it already holds is a seek all the same.
  if (Math.abs(el.currentTime - want) > 0.001) el.currentTime = want;
}

/**
 * V4.13. Keep one running element where the clock says it should be.
 *
 * `want` is that place in its file and `rate` the layer's speed. Further off
 * than `slack` it is lost and is seeked, as it always was. Nearer than that
 * it used to be left alone, so whatever an element lost in starting, 50 to
 * 240ms measured, it stayed behind for as long as it ran, each element by its
 * own amount, and the sound by a different one than its picture. Now its
 * rate is bent toward the clock in proportion to how far off it is, and is
 * the layer's own again once it is within `bend.dead`.
 */
function holdToClock(el, want, rate, slack, bend) {
  const unit = Math.max(0.2, rate);
  const drift = (el.currentTime - want) / unit;
  if (Math.abs(drift) > slack) {
    el.currentTime = want;
    if (el.playbackRate !== rate) el.playbackRate = rate;
    return;
  }
  // In hundredths, so the rate is set a few times on the way in and not on
  // every frame of the screen.
  const by = Math.abs(drift) > bend.dead
    ? Math.round(Math.max(-bend.most, Math.min(bend.most, -drift * bend.gain)) * 100) / 100
    : 0;
  const next = by ? Math.min(ELEMENT_RATE_MAX, Math.max(ELEMENT_RATE_MIN, rate * (1 + by))) : rate;
  if (el.playbackRate !== next) el.playbackRate = next;
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
  if (!layerOn(layer)) return 0;
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

// Standing still is silence. A scrub calls this on every pointer move, and
// placing every audio layer on every move would be a decode each for sound
// nobody can hear while the mouse is down, so while the playhead is being
// dragged nothing is seeked.
//
// V4.13. Otherwise each covering layer is put where the playhead is. It used
// to be left wherever it had stopped and placed when the transport started,
// which is the seek that made the sound begin 130 to 180ms after the picture.
function parkPlayers() {
  const place = !scrubMoving();
  for (const l of layers) {
    if (l.type !== 'audio') continue;
    const entry = players.get(l.id);
    if (!entry) continue;
    if (!entry.el.paused) entry.el.pause();
    if (place && layerOn(l) && timelineModel.covers(l, compositeAt)) {
      placeElement(entry.el, timelineModel.sourceTimeFor(l, compositeAt));
    }
  }
}

/**
 * Running: every enabled audio layer covering the playhead sounds, placed from
 * the project's clock exactly the way the replacement track is placed from the
 * video's, and against the same tolerance.
 *
 * force skips that tolerance, for the moments where the playhead jumps rather
 * than advances and any leftover drift would be plainly audible.
 *
 * V4.13. Held to the clock inside the tolerance and made ready before its
 * clip starts, like the pictures, see holdToClock and rollPhase. A layer
 * running ahead of its clip is silent until the playhead is on it.
 */
function followPlayers(force) {
  for (const l of layers) {
    if (l.type !== 'audio') continue;
    const entry = players.get(l.id);
    if (!entry) continue;
    const a = entry.el;
    const phase = rollPhase(l);
    if (phase === 'on' || phase === 'roll') {
      const want = timelineModel.sourceTimeFor(l, compositeAt);
      // V4.11. At the layer's speed, its pitch kept, which is what the file's
      // atempo does too.
      // V5.5.2. And at the playback speed.
      const rate = elementRate(l);
      if (!a.preservesPitch) a.preservesPitch = true;
      if (force) {
        placeElement(a, want);
        if (a.playbackRate !== rate) a.playbackRate = rate;
      } else {
        holdToClock(a, want, rate, AUDIO_SYNC_SLACK, AUDIO_BEND);
      }
      // V2.2. Every tick, because the fade is a function of where the playhead
      // is and this is the only thing that runs as it moves. A layer with no
      // fades gets its own volume back, so this is not a special case for
      // faded layers, it is the gain being kept current.
      if (phase === 'on') applyPlayerGain(l);
      else silencePlayer(entry);
      // A play() interrupted by the next seek rejects; that is not a failure.
      if (a.paused) a.play().catch(() => {});
    } else {
      // Past its end, before its start, or switched off. Stopped rather than
      // left running silently, so it is not still going when the playhead comes
      // back to it.
      if (!a.paused) a.pause();
      if (phase === 'ready') placeElement(a, readyPlace(l));
    }
  }
}

/** V4.13. A player running ahead of its clip, not to be heard yet. */
function silencePlayer(entry) {
  if (entry.gain) entry.gain.gain.value = 0;
  else entry.el.volume = 0;
}

/**
 * The topmost layer covering the playhead whose picture comes out of a file,
 * and so has a frame to be seeked to. layersAt hands them back to front so
 * that drawing them in order works, which puts the top one last.
 *
 * V4.12. A file, not simply the top layer: a text, a shape, a bar or an image
 * above it needs no seek and is drawn whatever the scrub does, so it is not
 * what the scrub's one seek is spent on. One that is not showing at this
 * moment (faded right out, or not read yet) is passed over for the same
 * reason.
 */
function topCoveringFile() {
  const hits = timelineModel.layersAt(layers, compositeAt);
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    if (fileShowing(hits[i])) return hits[i];
  }
  return null;
}

/** Whether a layer is a picture out of a file, read and showing at the playhead. */
function fileShowing(l) {
  if (l.type !== 'video') return false;
  const entry = decoders.get(l.id);
  if (!entry || entry.still || !entry.width) return false;
  return timelineModel.layerAlphaAt(l, compositeAt) > 0;
}

/**
 * V4.12.1. The file the user has pointed the scrub at, or null: the selected
 * clip when it is a video out of a file under the playhead, and once the
 * playhead has left that clip, the video on the same row there, so that a
 * drag across a cut stays on the row that was chosen. The user's idea: with a
 * small picture lying over a full one, the full one is what a drag is usually
 * looking for, and the top one is what it used to get.
 *
 * With several clips chosen it is the one clicked last, selectedLayerId.
 */
function chosenCoveringFile() {
  const sel = selectedLayerId ? timelineModel.layerById(layers, selectedLayerId) : null;
  if (!sel || sel.type !== 'video') return null;
  const hits = timelineModel.layersAt(layers, compositeAt).filter(fileShowing);
  return hits.find((l) => l.id === sel.id)
    || hits.reverse().find((l) => l.lane === sel.lane)
    || null;
}

/**
 * What a scrub does at the playhead: `file` is the one layer it may seek, or
 * null for none, and `hold` says the preview keeps the picture it has.
 *
 * Step 0 measured seeking every layer at 0.8 to 1.2s at 1080p and 2.3 to 5.0s
 * at 4K, which is not a scrub, it is a wait. The top covering layer alone
 * settles in 120 to 200ms at 1080p, and that is a live scrub. At 4K even one
 * layer is about 450ms, so there the answer is to seek nothing while the
 * pointer moves, and to hold the last whole picture.
 *
 * V4.12. Measured again on two 1080p files: the one seeked gives about 7
 * pictures a second, both seeked give 2 each. So it is still one. With no
 * file under the playhead at all there is nothing to seek and nothing to
 * hold: every layer there is a still and the scrub draws the whole picture.
 *
 * V4.12.1. The one file is the selected video where there is one under the
 * playhead, see chosenCoveringFile, and the top one otherwise.
 */
function scrubPlan() {
  const file = chosenCoveringFile() || topCoveringFile();
  if (!file) return { file: null, hold: false };
  const entry = decoders.get(file.id);
  if (entry.width * entry.height > SCRUB_PIXELS) return { file: null, hold: true };
  return { file, hold: false };
}

/** Whether the playhead is being dragged and has not come to rest. */
function scrubMoving() {
  return compositeScrub && !scrubRested;
}

function beginScrub() {
  if (compositeScrub) return;
  // The scrub takes the playhead over, so playback stops rather than the two of
  // them fighting over the same clock.
  if (compositePlaying) pauseComposite();
  compositeScrub = true;
  scrubRested = false;
}

function endScrub() {
  if (!compositeScrub) return;
  compositeScrub = false;
  scrubRested = false;
  clearTimeout(scrubRestTimer);
  scrubRestTimer = null;
  landDecoders();
  // V4.13. And the sound, which a moving scrub leaves where it was.
  parkPlayers();
}

/**
 * V4.12. The playhead moved under a scrub: it is not at rest, and will be
 * taken to be once it has stood still for SCRUB_REST_MS.
 */
function noteScrubMove() {
  scrubRested = false;
  clearTimeout(scrubRestTimer);
  scrubRestTimer = setTimeout(restScrub, SCRUB_REST_MS);
}

/**
 * V4.12. The pointer has held still with the button down. Every layer is
 * brought onto the playhead's frame, as letting go would, and the preview
 * shows the whole picture for as long as the pointer rests: a drag that stops
 * to look at a frame sees all of it, a 4K project included, without having to
 * let go. The next move is a scrub again.
 */
function restScrub() {
  scrubRestTimer = null;
  if (!compositeScrub || compositePlaying) return;
  scrubRested = true;
  landDecoders();
  parkPlayers();
}

/**
 * Bring every covering layer onto the playhead's frame, and say so until they
 * arrive. The picture fills in as each one lands, because every decoder redraws
 * the composite on its own seeked.
 */
function landDecoders() {
  // V4.13. Not while the trim frames have the pool, see parkDecoders: they
  // put every layer on the playhead's frame themselves when they are done.
  if (framesRunning) return;
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
// V4.13. What each frame was last built from, see trimFrameKey, or null when
// it has never been built or was built from something that changed under it.
const trimFrameBuilt = { start: null, end: null };

/**
 * V4.13. Everything the picture at timeline second `at` is made from, as a
 * list to be compared entry by entry: the moment, the project's size, and
 * each covering layer with what its decoder has to give.
 *
 * A layer is a new object whenever anything about it changes, so the layer
 * itself stands for its settings. What it does not carry is what arrives
 * later by itself: the file being read (its width), a text's fonts, a custom
 * mask's picture.
 *
 * Every change to the document used to rebuild both frames, three rounds of
 * seeks and the preview held about 0.8 seconds each time, though most edits
 * touch neither point. With this an edit elsewhere costs a comparison.
 */
function trimFrameKey(at) {
  const frame = projectFrame();
  const key = [at, frame.width, frame.height];
  for (const l of timelineModel.layersAt(layers, at)) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    const mask = l.mask && l.mask.kind === 'custom' ? maskPictures.get(l.mask.src + '|' + l.mask.by) : null;
    key.push(l, entry ? entry.width : 0, (entry && entry.fonts) || 0, !!(mask && mask.canvas));
  }
  return key;
}

function sameTrimFrameKey(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Which of the frames asked for is not a picture of what is there now. */
function trimFramesNeeded(which) {
  const start = which !== 'end' && !sameTrimFrameKey(trimFrameBuilt.start, trimFrameKey(slider.start));
  const end = which !== 'start' && !sameTrimFrameKey(trimFrameBuilt.end, trimFrameKey(trimFrameOutAt()));
  if (start && end) return 'both';
  return start ? 'start' : end ? 'end' : null;
}

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
    // V5.5.1. And the frames from before that an Echo of this track mixes.
    const before = echoNeeds(l, at);
    if (before.length) waits.push(echoFetch(l, before));
    const want = timelineModel.sourceTimeFor(l, at);
    // Assigning the position it already holds may produce no seeked event at
    // all, which would leave this waiting for a reply that never comes.
    if (Math.abs(entry.el.currentTime - want) < 0.001) continue;
    waits.push(new Promise((resolve) => {
      const done = () => {
        entry.el.removeEventListener('seeked', done);
        clearTimeout(timer);
        clearTimeout(kick);
        resolve();
      };
      const timer = setTimeout(done, 10000);
      // V4.13. A seek Chromium has let go of is seen to stay `seeking` for
      // good, and asking again is what gets it out. Two seconds is past any
      // real seek measured here (450ms at 4K).
      const kick = setTimeout(() => {
        if (entry.el.seeking) entry.el.currentTime = want;
      }, 2000);
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
  // V4.13. Only what is no longer a picture of this project. With nothing to
  // do the pool is left alone and the preview is not held; a spinner a marker
  // put up on its press comes down, unless a pass still running will do that.
  const need = trimFramesNeeded(which || 'both');
  if (!need) {
    if (!framesRunning) trimFramesBusy(false);
    return;
  }
  framesWanted = mergeWhich(framesWanted, need);
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
      // V4.13. Asked again here: two requests for the same change, made
      // before the first pass had drawn, are one pass and not two.
      const which = trimFramesNeeded(framesWanted);
      framesWanted = null;
      if (!which) {
        trimFramesBusy(false);
        break;
      }
      // Which drag this pass belongs to. If the markers move while it is being
      // built it is out of date before it lands, and the spinner has to stay up
      // for the pass that will replace it rather than being cleared here.
      const gen = trimDragGen;
      sizeTrimFrameCanvases();
      const jobs = [];
      if (which !== 'end') jobs.push(['start', startFrameCtx, startFrameCanvas, slider.start]);
      if (which !== 'start') jobs.push(['end', endFrameCtx, endFrameCanvas, trimFrameOutAt()]);
      for (const [name, ctx, canvas, at] of jobs) {
        // V4.13. What it is about to be a picture of, taken before the wait:
        // the document can change while the decoders are on their way, and
        // then the pool was placed for layers that are no longer the ones
        // drawn. Such a frame is not kept as built, and is asked for again.
        const key = trimFrameKey(at);
        await seekDecodersTo(at);
        // Play was pressed meanwhile and has the pool now. The frame waits
        // for the transport to stop, like any asked for while it runs.
        if (compositePlaying) {
          trimFrameBuilt[name] = null;
          trimFramesStale = true;
          break;
        }
        paintLayers(ctx, canvas, at, null);
        const held = sameTrimFrameKey(key, trimFrameKey(at));
        trimFrameBuilt[name] = held ? key : null;
        if (!held) framesWanted = mergeWhich(framesWanted, name);
      }
      if (compositePlaying) {
        framesWanted = null;
        break;
      }
      // Back to the playhead before anything else can look at the pool.
      await seekDecodersTo(compositeAt);
      if (gen === trimDragGen && !framesWanted) trimFramesBusy(false);
    }
  } finally {
    framesRunning = false;
    paintingFrames = false;
    // V4.13. The playhead may have moved since the pool was sent back to it,
    // and nothing was allowed to follow it meanwhile.
    if (!compositePlaying) parkDecoders();
    drawComposite();
  }
}

/** Move the project's playhead, which is what the timeline seeks. */
function seekComposite(at) {
  compositeAt = Math.min(Math.max(at, 0), compositeTotal());
  // V4.12. A jump is drawn whatever frame was drawn last.
  compositeDrawnFrame = -1;
  if (compositeScrub) noteScrubMove();
  parkDecoders();
  // A seek is a jump, so the tolerance is skipped: the audio goes exactly where
  // the playhead went rather than up to a quarter second behind it.
  if (compositePlaying) {
    followPlayers(true);
    // V4.13. Everything was just placed anew, so the clock waits for it to
    // run again, as it does at Play.
    if (compositing()) followDecoders();
    beginStartHold();
  } else {
    parkPlayers();
  }
  drawComposite();
}

/**
 * V4.13. Hold the clock until the project is actually running.
 *
 * Play used to start the clock at once and the elements when they got round
 * to it: the sound began 126 to 184ms after the clock (968 the first time)
 * and, inside the tolerance, was never brought back. Now the clock stands at
 * where Play was pressed until one element has begun to move, and starts from
 * how far that one has got. The sound is what it is anchored to where there
 * is some, a file's picture otherwise: a picture can be bent to the clock
 * unnoticed, see VIDEO_BEND, and sound less so. With neither, texts and
 * images alone, there is nothing to wait for.
 *
 * Called after the elements have been placed and told to play, at Play and
 * at every jump while running (a click in the timeline, the loop coming
 * round).
 */
function beginStartHold() {
  startHold = null;
  const pick = (type, pool) => {
    for (const l of layers) {
      if (l.type !== type || !layerOn(l) || !timelineModel.covers(l, compositeAt)) continue;
      const entry = pool.get(l.id);
      if (!entry || entry.still) continue;
      // The source's seconds to one of the timeline, which is what turns how
      // far the element has got into how far the clock has (not the element
      // rate, which the playback speed is in as well).
      return { el: entry.el, rate: timelineModel.speedOf(l) };
    }
    return null;
  };
  const anchor = pick('audio', players) || (compositing() ? pick('video', decoders) : null);
  if (!anchor) return;
  startHold = { ...anchor, from: anchor.el.currentTime, at: compositeAt, since: performance.now() };
}

/**
 * V4.13. Whether the clock may run: at once with nothing held, and otherwise
 * when the anchor has moved, from where it has got to, or when it has been
 * waited for long enough.
 */
function startHeld(now) {
  if (!startHold) return false;
  const moved = (startHold.el.currentTime - startHold.from) / startHold.rate;
  if (!(moved > 0.003) && now - startHold.since < START_HOLD_MS) return true;
  if (moved > 0.003) compositeAt = Math.min(compositeTotal(), startHold.at + moved);
  startHold = null;
  // The clock counts from here, not from the last screen frame it was held on.
  compositeLast = now;
  return false;
}

// The clock is the wall clock rather than any one element's. With N elements
// there is no obvious one to follow, and the model's own arithmetic is then
// what every element is held against, which is exactly what the encoder does
// with the same numbers.
function compositeTick() {
  if (!compositePlaying) return;
  const now = performance.now();
  // V4.13. Not yet: what the clock is anchored to has not begun to run.
  if (startHeld(now)) {
    compositeLast = now;
    compositeRaf = requestAnimationFrame(compositeTick);
    return;
  }
  const total = compositeTotal();
  const was = compositeAt;
  // V5.5.2. At the playback speed.
  compositeAt = Math.min(total, compositeAt + ((now - compositeLast) / 1000) * playRate);
  compositeLast = now;
  // V4.0. Loop selection, before Play selection's stop point below, which is
  // the same out marker: with the loop on, reaching it starts the selection
  // again rather than ending the run. Only for a run that was inside the
  // selection, so playing up to it from earlier still enters it, and an out
  // marker past the last track loops at the last track, where playback ends.
  const loopEnd = Math.min(slider.end, total);
  if (loopSelection && loopEnd - slider.start > 0.01
    && was >= slider.start - 1e-3 && was < loopEnd && compositeAt >= loopEnd) {
    seekComposite(slider.start);
    updatePlayhead();
    compositeRaf = requestAnimationFrame(compositeTick);
    return;
  }
  // With an audio output there is nothing to draw, so the video layers are left
  // where they are rather than decoded for a canvas that is hidden.
  if (compositing()) followDecoders();
  followPlayers(false);
  // V4.12. Only when there is another picture to draw, see compositeDrawDue.
  if (compositeDrawDue()) drawComposite();
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

/**
 * V4.12. Whether playback has anything new to draw on this frame of the
 * screen.
 *
 * The tick runs once a screen frame, and it used to draw every time: 144
 * composites a second on a 144 Hz screen for a project of 24 frames a second,
 * each one the picture already there, masks and blurs and all. Measured, the
 * GPU process spent 45% of a core on a clip with a soft mask and an Obscure
 * area, and 25% drawing each picture once.
 *
 * What is new is a file's next picture, which its element reports (see
 * addDecoder), so the preview is drawn when one arrives and shows it within
 * a screen frame, as before. Drawing by the project's own clock instead
 * would sample a 24 frame file 24 times a second at whatever phase the two
 * happened to start in, and where they nearly coincide a picture is shown
 * twice and the next one skipped.
 *
 * With no file running under the playhead (texts, shapes, images, or
 * nothing) the clock is all there is, and a draw is due once a project
 * frame, which is as often as a fade or a keyframe moves anything in the
 * file. The same holds over a running file while something on the playhead
 * moves by itself (see layerMovesAt): a text sliding over a file of fewer
 * frames than the project would otherwise step at the file's rate, where the
 * export steps at the project's. And a file that should be running but has
 * gone quiet, seeking at a cut say, must not hold the picture still with it:
 * two project frames without a draw are drawn regardless.
 */
function compositeDrawDue() {
  const frame = Math.floor(compositeAt * projectFrame().fps + 1e-6);
  let running = false;
  let fresh = false;
  // A window's draft is drawn as it is edited, so it counts as moving.
  let moving = popoutPreviews.size > 0;
  for (const l of layers) {
    if (l.type !== 'video' || !layerOn(l) || !timelineModel.covers(l, compositeAt)) continue;
    if (!moving && layerMovesAt(l, compositeAt)) moving = true;
    const entry = decoders.get(l.id);
    if (!entry || entry.still) continue;
    // Only an element that has ever reported a picture can be waited on.
    if (entry.pictures && !entry.el.paused) running = true;
    if (entry.fresh) fresh = true;
  }
  const behind = frame - compositeDrawnFrame;
  const due = fresh || behind < 0 || behind >= (running && !moving ? 2 : 1);
  if (!due) return false;
  compositeDrawnFrame = frame;
  for (const entry of decoders.values()) entry.fresh = false;
  return true;
}

/**
 * V4.12. Whether a layer's picture changes from one project frame to the
 * next at timeline second `at` for a reason other than its file's next
 * picture: keyframes, a transition, a fade, or a VFX that changes by
 * keyframes of its own. Generous rather than exact, a clip with keyframes counts for
 * its whole length, since all it costs to be wrong that way is a draw.
 */
function layerMovesAt(l, at) {
  if (timelineModel.keyframesFor(l).length > 1) return true;
  if (timelineModel.transitionAt(l, at)) return true;
  // Gravity (5.3.0). Or it is falling.
  if (timelineModel.gravityOf(l)) return true;
  // V5.1. Or one that moves by itself: a wave on a still picture has no next
  // picture of the file to be drawn for.
  if (timelineModel.vfxList(l).some((v) => timelineModel.vfxMoves(v) || timelineModel.vfxMovesAlone(v))) return true;
  const next = at + 1 / projectFrame().fps;
  return timelineModel.layerAlphaAt(l, at) !== timelineModel.layerAlphaAt(l, next);
}

function playComposite() {
  if (compositePlaying) return;
  const total = compositeTotal();
  if (!total) return;
  // Back to the top when the playhead is already sitting at the end, which is
  // where every run leaves it.
  if (compositeAt >= total) compositeAt = 0;
  // V4.0. Every way of starting comes through here, Space, the Play button and
  // Play selection alike, so this is where the line is left behind.
  playStartAt = compositeAt;
  compositeDrawnFrame = -1;
  // A context made before any click starts suspended, and this is a click.
  if (gainCtx && gainCtx.state === 'suspended') gainCtx.resume();
  compositePlaying = true;
  compositeLast = performance.now();
  // V4.13. Everything set going now, and the clock held until it runs.
  if (compositing()) followDecoders();
  followPlayers(true);
  beginStartHold();
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
  startHold = null;
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
