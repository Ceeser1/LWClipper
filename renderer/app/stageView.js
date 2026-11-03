'use strict';

// ---- V3.3. Zoom and pan on the stages a layer is placed on ----
//
// The user, 2026-11-03: "it should be able to let it spawn outside", for a
// shape flying into the screen, and of the two ways offered to show the space
// outside the frame, the one where "mouse-wheel scroll to zoom in/out and click
// to pan with a highlighted box of the actual render frame".
//
// Three stages take part: the crop popup's Render Position tab, Shape Settings
// and Text. Each opens fitted, the frame centred with a little room round it so
// a grip on the frame's edge is not cut off. The wheel zooms about the pointer,
// a drag on empty space pans, the middle button pans from anywhere, and a
// double-click on empty space fits the frame again. Outside the frame is drawn
// dimmed and the frame is outlined, so what is in the file and what is not are
// told apart at a glance.
//
// The view is held as a zoom on the fit and the project point at the stage's
// middle, rather than as an offset, so a window resized under a zoomed stage
// keeps looking at the same place.
//
// A stage nobody bound here, a bar's or an effect's, still asks stageFrameRect
// where its frame is and gets the plain letterbox it always had.

const STAGE_ZOOM_MIN = 0.25;
const STAGE_ZOOM_MAX = 8;
// Screen pixels of room round the fitted frame, a little more than a corner
// grip reaches past the box's line.
const STAGE_FIT_PAD = 16;
// A wheel notch of about 100 pixels is about a seventh in or out.
const STAGE_WHEEL_RATE = 0.0015;
// Outside the frame: the stage's own grey laid over what is there, so a layer
// hanging off the frame still shows, only faded.
const STAGE_DIM = 'rgba(20, 20, 24, 0.62)';
const STAGE_FRAME_LINE = 'rgba(235, 235, 240, 0.6)';

const stageViews = new Map();

/** Back to fitted, the way every stage opens. */
function resetStageView(stage) {
  const v = stageViews.get(stage);
  if (!v) return;
  v.zoom = 1;
  v.cx = null;
  v.cy = null;
  showStageZoom(stage);
}

/**
 * Where the project frame is on a stage, in the stage's own CSS pixels, and
 * `s`, screen pixels per project pixel. `w` and `h` are the stage's own size.
 */
function stageFrameRect(stage) {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const frame = projectFrame();
  const v = stageViews.get(stage);
  const pad = v ? STAGE_FIT_PAD : 0;
  const fit = Math.max(1e-6, Math.min((w - 2 * pad) / frame.width, (h - 2 * pad) / frame.height));
  if (!v) {
    // The letterbox the generated media stages always had, in whole pixels.
    const cw = Math.max(1, Math.round(frame.width * fit));
    const ch = Math.max(1, Math.round(frame.height * fit));
    return { left: Math.round((w - cw) / 2), top: Math.round((h - ch) / 2), width: cw, height: ch, s: ch / frame.height, w, h };
  }
  const s = fit * v.zoom;
  const cx = v.cx === null ? frame.width / 2 : v.cx;
  const cy = v.cy === null ? frame.height / 2 : v.cy;
  return {
    left: w / 2 - cx * s,
    top: h / 2 - cy * s,
    width: frame.width * s,
    height: frame.height * s,
    s,
    w,
    h,
  };
}

/** A point on the screen, in project pixels on a stage. */
function stageProjectPoint(stage, evt) {
  const b = stage.getBoundingClientRect();
  const r = stageFrameRect(stage);
  return {
    x: (evt.clientX - b.left - stage.clientLeft - r.left) / r.s,
    y: (evt.clientY - b.top - stage.clientTop - r.top) / r.s,
  };
}

// The middle of the view is kept where a layer may still be: a frame past
// each edge, which is as far as a side may reach.
function holdStageView(stage) {
  const v = stageViews.get(stage);
  if (!v || v.cx === null) return;
  const frame = projectFrame();
  v.cx = clamp(v.cx, -frame.width, 2 * frame.width);
  v.cy = clamp(v.cy, -frame.height, 2 * frame.height);
}

/**
 * The outside of the frame dimmed and the frame outlined, over whatever the
 * canvas already holds. The canvas covers the whole stage.
 */
function dimOutsideFrame(ctx, canvas, stage) {
  const r = stageFrameRect(stage);
  const k = canvas.width / Math.max(1, r.w);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(r.left * k, r.top * k, r.width * k, r.height * k);
  ctx.fillStyle = STAGE_DIM;
  ctx.fill('evenodd');
  if (stageViews.has(stage)) {
    ctx.strokeStyle = STAGE_FRAME_LINE;
    ctx.lineWidth = Math.max(1, Math.round(k));
    const half = ctx.lineWidth / 2;
    ctx.strokeRect(Math.round(r.left * k) - half, Math.round(r.top * k) - half,
      Math.round(r.width * k) + ctx.lineWidth, Math.round(r.height * k) + ctx.lineWidth);
  }
  ctx.restore();
}

// The zoom, said in the stage's corner while it is not the fit.
function showStageZoom(stage) {
  const v = stageViews.get(stage);
  if (!v || !v.label) return;
  const pct = Math.round(v.zoom * 100);
  v.label.hidden = pct === 100;
  v.label.textContent = pct + '%';
}

/**
 * Zoom and pan on `stage`. `open()` says whether it is live, `empty(evt)`
 * whether a press is on nothing a left drag would otherwise move, and
 * `redraw(quick)` puts everything on the stage where the view now says;
 * `quick` is true while the view is still moving.
 */
function bindStageView(stage, { open, empty, redraw }) {
  const label = document.createElement('div');
  label.className = 'stage-zoom';
  label.dataset.noTranslate = '';
  label.hidden = true;
  stage.appendChild(label);
  stageViews.set(stage, { zoom: 1, cx: null, cy: null, label });
  stage.dataset.zoomable = 'true';

  // The full paint once the wheel has been still for a moment, since a text
  // with a shadow is a lot of work to redo on every notch.
  let settle = 0;
  const settled = () => {
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (open()) redraw(false);
    }, 160);
  };

  stage.addEventListener('wheel', (evt) => {
    if (!open()) return;
    // Or the modal scrolls behind the stage, which is why it is not passive.
    evt.preventDefault();
    const v = stageViews.get(stage);
    const zoom = clamp(v.zoom * Math.exp(-wheelPixels(evt) * STAGE_WHEEL_RATE),
      STAGE_ZOOM_MIN, STAGE_ZOOM_MAX);
    if (zoom === v.zoom) return;
    // About the pointer: the project point under it stays under it.
    const r = stageFrameRect(stage);
    const b = stage.getBoundingClientRect();
    const px = evt.clientX - b.left - stage.clientLeft;
    const py = evt.clientY - b.top - stage.clientTop;
    const p = { x: (px - r.left) / r.s, y: (py - r.top) / r.s };
    const s = r.s * zoom / v.zoom;
    v.zoom = zoom;
    v.cx = p.x + (r.w / 2 - px) / s;
    v.cy = p.y + (r.h / 2 - py) / s;
    holdStageView(stage);
    showStageZoom(stage);
    redraw(true);
    settled();
  }, { passive: false });

  // Chromium's autoscroll would take the middle button otherwise.
  stage.addEventListener('mousedown', (evt) => {
    if (evt.button === 1 && open()) evt.preventDefault();
  });

  stage.addEventListener('pointerdown', (evt) => {
    if (!open()) return;
    if (!(evt.button === 1 || (evt.button === 0 && empty(evt)))) return;
    const v = stageViews.get(stage);
    const frame = projectFrame();
    const r = stageFrameRect(stage);
    const cx0 = v.cx === null ? frame.width / 2 : v.cx;
    const cy0 = v.cy === null ? frame.height / 2 : v.cy;
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    stage.dataset.panning = 'true';
    beginDrag(stage, evt, (ev) => {
      v.cx = cx0 - (ev.clientX - x0) / r.s;
      v.cy = cy0 - (ev.clientY - y0) / r.s;
      holdStageView(stage);
      redraw(true);
    }, () => {
      stage.dataset.panning = 'false';
      if (open()) redraw(false);
    });
  });

  stage.addEventListener('dblclick', (evt) => {
    if (!open() || evt.button !== 0 || !empty(evt)) return;
    resetStageView(stage);
    redraw(false);
  });
}

// ---- V3.3. The view each keyframe was left at ----
//
// The user, 2026-11-03: "let the program remember which zoom/pan was at which
// keyframe so when you open it again you dont end up on the default render
// screen but rather the screen you left the setting of that key frame", and
// then "each setting/pan/zoom should be saved in the project file as well".
//
// One store for every editor's view: the three stages above, and the crop
// tab's zoom and pan under the scope 'crop'. Written into the project on every
// save beside the document (projectFile.viewsOf) and read back on open, but
// not part of the document, so zooming is not an unsaved change on its own.
//
// Keyed by the scope, the layer and the keyframe's id, all of which the file
// keeps. A keyframe that is new when its modal opens has no id until Accept,
// so it is also kept by the moment on the clip it is made at, which is where
// the keyframe Accept makes then sits. A layer with no keyframes is kept by
// the layer alone, and a stage falls back on that for a keyframe nothing was
// remembered for; the crop does not, since each keyframe's crop is its own
// and another one's view could be looking somewhere else entirely.
const rememberedViews = new Map();

function viewKeys(scope, layerId, keyframe, fallBack) {
  const base = scope + '|' + layerId;
  if (!keyframe) return [base];
  const at = base + '@' + Number(keyframe.t || 0).toFixed(3);
  const own = keyframe.id ? [base + '#' + keyframe.id, at] : [at];
  return fallBack ? [...own, base] : own;
}

/** Keep a view for a layer and keyframe, or forget it with null. */
function rememberView(scope, layerId, keyframe, view) {
  if (!layerId) return;
  const [key] = viewKeys(scope, layerId, keyframe, false);
  if (view) rememberedViews.set(key, { ...view });
  else rememberedViews.delete(key);
}

/** The view kept for a layer and keyframe, or null. */
function recallView(scope, layerId, keyframe, fallBack) {
  if (!layerId) return null;
  for (const key of viewKeys(scope, layerId, keyframe, fallBack)) {
    const kept = rememberedViews.get(key);
    if (kept) return { ...kept };
  }
  return null;
}

/** Keep the view the stage is at, for this layer and keyframe. */
function rememberStageView(stage, layerId, keyframe) {
  const v = stageViews.get(stage);
  if (!v) return;
  rememberView(stage.id, layerId, keyframe, { zoom: v.zoom, cx: v.cx, cy: v.cy });
}

/** The view kept for this layer and keyframe, or fitted when there is none. */
function recallStageView(stage, layerId, keyframe) {
  const v = stageViews.get(stage);
  if (!v) return;
  resetStageView(stage);
  const kept = recallView(stage.id, layerId, keyframe, true);
  if (!kept) return;
  v.zoom = clamp(Number(kept.zoom) || 1, STAGE_ZOOM_MIN, STAGE_ZOOM_MAX);
  v.cx = Number.isFinite(kept.cx) ? kept.cx : null;
  v.cy = Number.isFinite(kept.cy) ? kept.cy : null;
  holdStageView(stage);
  showStageZoom(stage);
}

/**
 * The views as the project file takes them, with those that belong to a layer
 * or a keyframe no longer there left out, so a file does not keep the view of
 * every clip it ever had.
 */
function viewsForFile() {
  const out = {};
  for (const [key, view] of rememberedViews) {
    const m = /^[^|]+\|([^#@]+)(?:#(.+)|@([\d.]+))?$/.exec(key);
    if (!m) continue;
    const layer = timelineModel.layerById(layers, m[1]);
    if (!layer) continue;
    const keyed = timelineModel.keyframesFor(layer);
    if (m[2] && !keyed.some((k) => k.id === m[2])) continue;
    if (m[3] && !keyed.some((k) => Math.abs(k.t - Number(m[3])) < 0.0005)) continue;
    out[key] = view;
  }
  return out;
}

/** Every view put back to what a file says, or to none for a new project. */
function adoptViews(views) {
  rememberedViews.clear();
  for (const [key, view] of Object.entries(views || {})) rememberedViews.set(key, { ...view });
}
