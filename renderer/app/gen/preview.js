'use strict';

// V3. What the generated media modals share: the render preview, adding and
// accepting, and a slider with its number box.

// ---- V3, the render preview the generated media modals share ----
//
// The project frame letterboxed in a 16:9 stage, like the crop popup's, since
// a project can be 9:16 or 1:1 and the modal must not turn tall and narrow for
// it. What it shows is the draft being edited, drawn at the project's size by
// the same genDraw the preview and the export use, then scaled down: over the
// checkerboard, or with Enable Background over the real frame at the playhead,
// in its place in the stack, so a layer above covers it as it will in the file.

// Enable Background, remembered for the session and shared by the modals.
let genBackdropOn = false;
const genPreviewSurface = document.createElement('canvas');

function sizeGenStage(stage, canvas) {
  const panel = stage.parentElement;
  let w = Math.round(panel.clientWidth * CROP_FRAME_SHARE);
  let h = Math.round(w * 9 / 16);
  const maxH = Math.round(window.innerHeight * CROP_HEIGHT_SHARE);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * 16 / 9);
  }
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  // V3.3. The canvas covers the whole stage rather than only the frame, so a
  // layer hanging off the frame can be drawn where it hangs. Where the frame
  // is on it is stageFrameRect's to say, zoomed and panned or not.
  canvas.style.left = '0px';
  canvas.style.top = '0px';
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
}

// The draft is drawn on its own surface first, as big as the stage's view in
// project pixels at the project's own resolution, and then scaled onto the
// stage. Held to this many pixels on its longer side, which a view zoomed far
// out would otherwise ask several frames' worth of.
const GEN_SURFACE_MAX = 4096;

// The checkerboard behind a draft with Enable Background off, the one the
// stylesheet drew under the canvas until V3.3: twelve pixel tiles of four.
function checkerPattern(ctx, dpr) {
  const q = Math.max(1, Math.round(6 * dpr));
  const tile = document.createElement('canvas');
  tile.width = q * 2;
  tile.height = q * 2;
  const t = tile.getContext('2d');
  t.fillStyle = '#6a6a72';
  t.fillRect(0, 0, q * 2, q * 2);
  t.fillStyle = '#9a9aa2';
  t.fillRect(q, 0, q, q);
  t.fillRect(0, q, q, q);
  return ctx.createPattern(tile, 'repeat');
}

// `quick` draws the draft at the stage's own size rather than the project's,
// for a slider being dragged: a shadow's distance field over a 1080p frame on
// every step of a drag is work nobody sees, since the stage shows it scaled
// down anyway. The drag's end paints it again at full size.
function paintGenPreview(stage, canvas, id, gen, quick) {
  const frame = projectFrame();
  const r = stageFrameRect(stage);
  const dpr = canvas.width / Math.max(1, r.w);
  // Surface pixels per project pixel: the project's own, or the screen's when
  // quick, never less than the screen's and never past the cap.
  const viewW = r.w / r.s;
  const viewH = r.h / r.s;
  const screen = r.s * dpr;
  const k = Math.max(screen, Math.min(quick ? screen : 1, GEN_SURFACE_MAX / Math.max(viewW, viewH)));
  const surface = genPreviewSurface;
  const sw = Math.max(1, Math.round(viewW * k));
  const sh = Math.max(1, Math.round(viewH * k));
  if (surface.width !== sw) surface.width = sw;
  if (surface.height !== sh) surface.height = sh;
  const sctx = surface.getContext('2d');
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, sw, sh);
  // The frame's origin where the stage has it, and drawn at k times the
  // project's size, which genDraw scales everything to by the height.
  sctx.setTransform(1, 0, 0, 1, (r.left / r.s) * k, (r.top / r.s) * k);
  genDraw.drawGen(sctx, gen, frame.width * k, frame.height * k);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  stage.dataset.checker = String(!genBackdropOn);
  const ctx = canvas.getContext('2d');
  const own = timelineModel.layerById(layers, id);
  // The layer's own alpha ceiling but not its fade: the playhead may be
  // anywhere, and a bar that vanished because the playhead sits on the first
  // frame of its fade in would look like a bar that did not work.
  const ownAlpha = own ? timelineModel.alphaOf(own) : 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const fx = r.left * dpr;
  const fy = r.top * dpr;
  const fw = r.width * dpr;
  const fh = r.height * dpr;
  const drawDraft = () => {
    ctx.globalAlpha = ownAlpha;
    ctx.drawImage(surface, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
  };
  if (!genBackdropOn) {
    ctx.save();
    ctx.translate(fx, fy);
    ctx.fillStyle = checkerPattern(ctx, dpr);
    ctx.fillRect(0, 0, fw, fh);
    ctx.restore();
    drawDraft();
    dimOutsideFrame(ctx, canvas, stage);
    return;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(fx, fy, fw, fh);
  // The other layers in project pixels, with the stage's view as the canvas's
  // transform: drawLayerInto maps the frame onto the canvas it is handed, so
  // it is handed one the frame's own size.
  const virtual = { width: frame.width, height: frame.height };
  // Back to front, as paintLayers goes, with the layer being edited drawn from
  // the draft wherever it stands in the list, and drawn whether or not the
  // playhead is over it.
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const l = layers[i];
    if (l.type !== 'video') continue;
    if (l.id === id) {
      drawDraft();
      continue;
    }
    if (!l.enabled || !timelineModel.covers(l, compositeAt)) continue;
    const alpha = timelineModel.layerAlphaAt(l, compositeAt);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.setTransform(r.s * dpr, 0, 0, r.s * dpr, fx, fy);
    // V3.3. At the playhead, so a layer with keyframes is where it is then.
    drawLayerInto(ctx, virtual, l, undefined, undefined, compositeAt);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
  }
  dimOutsideFrame(ctx, canvas, stage);
}

// What addGenMedia had before it added, so Cancel on the first opening can put
// it back: the list, the row count and the selection. Null once the add is
// settled either way.
let genAddBefore = null;

// The first opening's Cancel: the add taken off again, with no step of its own
// ever having been written, so there is nothing for undo to find either.
function cancelGenAdd() {
  const before = genAddBefore;
  genAddBefore = null;
  if (!before) return;
  laneRows.video = before.rows;
  selectedLayerId = before.selected;
  setLayers(before.layers, true);
}

/**
 * Accept in a generated layer's settings, once its modal has closed. The first
 * opening commits even unchanged, since that Accept is what makes the add a
 * step at all; any other Accept that changed nothing writes nothing, so opening
 * and closing a modal never leaves an undo step behind.
 */
/**
 * V3.3. Whether two sets of keyed settings are the same picture. The modals
 * round what they show to whole project pixels and degrees, so a keyframe
 * opened between two others comes back off by a fraction it was never told to
 * move: within under a pixel, or a degree, or a half percent of span, is the
 * same.
 */
function sameKeyed(a, b) {
  const close = (p, q, reach) => Math.abs(p - q) <= reach;
  if ('color' in a && a.color !== b.color) return false;
  if ('span' in a && !close(a.span, b.span, 0.005)) return false;
  if ('thickness' in a && !close(a.thickness, b.thickness, 0.75)) return false;
  if ('rotation' in a && !close(a.rotation, b.rotation, 0.75)) return false;
  if ('box' in a) {
    if (!a.box !== !b.box) return false;
    if (a.box && !['x', 'y', 'w', 'h'].every((f) => close(a.box[f], b.box[f], 0.75))) return false;
  }
  return true;
}

function acceptGenSettings(id, gen, changed, first) {
  genAddBefore = null;
  const layer = timelineModel.layerById(layers, id);
  if (!layer) return;
  // V3.3. On a keyframe: what the keyframe holds goes to the keyframe, made
  // here if it is new, and only when it changed, so editing a text's words
  // with the playhead between two keyframes does not leave a third behind.
  // Everything else goes to the layer, its own keyed settings untouched.
  const k = genKeyframe && genKeyframe.layerId === id ? genKeyframe : null;
  genKeyframe = null;
  if (k) {
    if (!changed) return;
    // The modal hands back its settings at the project's height, so the layer's
    // keyframes, the one it opened on and its own keyed settings are all
    // brought to that height first, to be compared and kept in one measure.
    const ref = timelineModel.genOf(gen).refHeight;
    const scale = ref / timelineModel.genOf(layer.gen).refHeight;
    const keyed = timelineModel.keyedOfGen(gen);
    const opened = timelineModel.keyedAt(timelineModel.keyedOfGen(timelineModel.withKeyed(layer.gen, k)), scale);
    const rest = timelineModel.withKeyed(gen, timelineModel.keyedAt(timelineModel.keyedOfGen(layer.gen), scale));
    let next = timelineModel.setGen(layers, id, rest);
    next = timelineModel.setLayer(next, id, { keyframes: timelineModel.keyframesAtRef(layer, ref) });
    const keyId = k.id || newKeyframeId();
    const moved = !sameKeyed(keyed, opened);
    if (moved) next = timelineModel.putKeyframe(next, id, { ...k, ...keyed, id: keyId });
    setLayers(next);
    if (moved) selectKeyframe(id, keyId);
    commitHistory();
    return;
  }
  if (changed) setLayers(timelineModel.setGen(layers, id, gen));
  if (changed || first) commitHistory();
}

/**
 * A slider and the number box beside it, both one setting, the way every
 * generated media modal lays out a figure.
 *
 * `range()` answers [min, max] as it is now, since a bar's ceiling moves with
 * its side. `set(n, except, quick)` takes a value: `except` is the box being
 * typed in, which is not written back while it is, and `quick` is true while
 * the slider is being dragged. `settle()`, if given, runs when the slider is
 * let go. `show()` writes the value in force back into the box once it is
 * left, so a box left empty or past its range does not stay that way.
 */
function bindNumberField({ slider, box, range, set, settle, show }) {
  slider.addEventListener('input', () => set(Number(slider.value), null, true));
  if (settle) slider.addEventListener('change', settle);
  box.addEventListener('input', () => {
    const text = box.value.trim();
    const [lo, hi] = range();
    if (!(lo < 0 ? /^[-+]?\d+$/ : /^\d+$/).test(text)) return;
    set(Math.min(hi, Math.max(lo, parseInt(text, 10))), box, false);
  });
  box.addEventListener('blur', show);
  box.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter') return;
    evt.preventDefault();
    box.blur();
  });
}
