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
  const frame = projectFrame();
  const k = Math.min(w / frame.width, h / frame.height);
  const cw = Math.max(1, Math.round(frame.width * k));
  const ch = Math.max(1, Math.round(frame.height * k));
  canvas.style.left = Math.round((w - cw) / 2) + 'px';
  canvas.style.top = Math.round((h - ch) / 2) + 'px';
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
}

// `quick` draws the draft at the stage's own size rather than the project's,
// for a slider being dragged: a shadow's distance field over a 1080p frame on
// every step of a drag is work nobody sees, since the stage shows it scaled
// down anyway. The drag's end paints it again at full size.
function paintGenPreview(stage, canvas, id, gen, quick) {
  const frame = projectFrame();
  const surface = genPreviewSurface;
  const sw = quick ? canvas.width : frame.width;
  const sh = quick ? canvas.height : frame.height;
  if (surface.width !== sw) surface.width = sw;
  if (surface.height !== sh) surface.height = sh;
  genDraw.drawGen(surface.getContext('2d'), gen, sw, sh);
  stage.dataset.checker = String(!genBackdropOn);
  const ctx = canvas.getContext('2d');
  const own = timelineModel.layerById(layers, id);
  // The layer's own alpha ceiling but not its fade: the playhead may be
  // anywhere, and a bar that vanished because the playhead sits on the first
  // frame of its fade in would look like a bar that did not work.
  const ownAlpha = own ? timelineModel.alphaOf(own) : 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!genBackdropOn) {
    ctx.globalAlpha = ownAlpha;
    ctx.drawImage(surface, 0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Back to front, as paintLayers goes, with the layer being edited drawn from
  // the draft wherever it stands in the list, and drawn whether or not the
  // playhead is over it.
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const l = layers[i];
    if (l.type !== 'video') continue;
    if (l.id === id) {
      ctx.globalAlpha = ownAlpha;
      ctx.drawImage(surface, 0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
      continue;
    }
    if (!l.enabled || !timelineModel.covers(l, compositeAt)) continue;
    const alpha = timelineModel.layerAlphaAt(l, compositeAt);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    drawLayerInto(ctx, canvas, l);
    ctx.globalAlpha = 1;
  }
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
function acceptGenSettings(id, gen, changed, first) {
  genAddBefore = null;
  if (!timelineModel.layerById(layers, id)) return;
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
