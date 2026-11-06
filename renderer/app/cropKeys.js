'use strict';

// V3.7. The Crop and Mask window's draft of the whole clip, and its strip.
//
// Until V3.7 the window edited one keyframe, the one at the playhead when it
// opened, and Accept wrote its three views into that one. Now its strip is a
// keyframe editor (see keystrip.js), so the window holds a draft of every
// setting the clip has that the window sets: its crop, placement, ring, turn
// and mask, and all its keyframes. Moving, adding and deleting keyframes, and
// stepping between them, all happen in the draft; Accept writes the lot as one
// step and Cancel drops it, the user's draft-until-Accept for the whole window.
//
// The three views' drafts (cropDraft, placeDraft, maskDraft and the rest) go
// on being what they were, the settings at the keyframe being edited. Folding
// writes them into the clip's draft at that keyframe, the way Accept always
// wrote them into the clip, and reseeding reads them back out of it for
// another keyframe. A new keyframe the window is editing between two others is
// only made when its settings differ from the blend there, so stepping the
// playhead along the strip leaves nothing behind.

// The settings the window owns, which Accept writes onto the clip.
const CROP_OWNED = ['crop', 'render', 'anchor', 'rotation', 'mask', 'keyframes'];

// The clip's draft, those fields, while the window is open in advanced
// editing; null otherwise.
let cropWork = null;
// The live clip's keyframes the draft's were last measured against, for a
// trim made in the main window meanwhile.
let cropWorkBase = null;

function ownedOf(layer, fields) {
  const out = {};
  for (const f of fields) out[f] = layer[f];
  return out;
}

/**
 * The clip the window is open on as its draft has it: the live clip, which
 * the main window may have moved or trimmed meanwhile, with the window's own
 * settings and keyframes in place. The live clip while there is no draft.
 */
function cropLayerNow() {
  const live = cropLayerId ? timelineModel.layerById(layers, cropLayerId) : null;
  if (!live || !cropWork) return live;
  return { ...live, ...cropWork };
}

function startCropWork(layer) {
  cropWork = ownedOf(layer, CROP_OWNED);
  cropWorkBase = layer.keyframes;
  cropSession.reset();
}

function stopCropWork() {
  cropWork = null;
  cropWorkBase = null;
}

/** A trim of the clip's start in the main window, carried into the draft. */
function rebaseCropWork() {
  const live = cropLayerId ? timelineModel.layerById(layers, cropLayerId) : null;
  if (!live || !cropWork || live.keyframes === cropWorkBase) return;
  const moved = rebaseWorkKeys(cropWork.keyframes, cropWorkBase, live.keyframes);
  cropWorkBase = live.keyframes;
  if (!moved) return;
  cropWork = { ...cropWork, keyframes: moved.keyframes };
  if (cropKeyframe) cropKeyframe = { ...cropKeyframe, t: Math.round((cropKeyframe.t + moved.dt) * 1e6) / 1e6 };
  drawCropKeys();
}

// Null rectangles mean the whole picture and the fit, so a draft that says it
// in numbers is the same thing.
function sameOrBoth(a, b) {
  return (!a && !b) || sameRect(a, b);
}

/** Whether a new keyframe's fields say anything the blend there does not. */
function cropFieldsMoved(f, seed, size, fit) {
  const full = size ? fullRect(size) : null;
  if (!sameOrBoth(f.crop || full, seed.crop || full)) return true;
  if (!sameOrBoth(f.render || fit, seed.render || fit)) return true;
  if ((f.anchor || null) !== (seed.anchor || null)) return true;
  if (Math.abs((f.rotation || 0) - (seed.rotation || 0)) > 0.25) return true;
  return !!f.mask;
}

/**
 * The clip as the three views' drafts would leave it, worked out rather than
 * set: what the preview shows and what folding stores. A new keyframe the
 * window edits between two is in it under `keyId` when its settings moved.
 * `withMask` false leaves the Layer Mask view's draft out, which is how that
 * view asks where the picture it masks lands.
 */
function cropFoldedLayer(keyId = 'draft', withMask = true) {
  const layer0 = cropLayerNow();
  if (!layer0) return null;
  const size = sourceSize();
  const rect = size && cropDraft && !isFullFrame(cropDraft, size) ? { ...cropDraft } : null;
  const target = cropTargetLayer();
  const fit = target ? placeFitRect(target) : null;
  // A placement that is still the fit is no placement, the rule Accept has
  // always had, so it goes on following the crop.
  const render = placeTouched && placeDraft && !sameOrBoth(placeDraft, fit) ? { ...placeDraft } : null;
  const plan = withMask ? maskAcceptPlan() : {};
  let layer = layer0;
  if (plan.remove) layer = timelineModel.removeMask([layer], layer.id)[0];
  if (plan.layer) layer = timelineModel.setMask([layer], layer.id, plan.layer)[0];
  if (!cropKeyframe) return { ...layer, crop: rect, render, anchor: placeAnchor, rotation: placeRotation };
  const fields = { crop: rect, render, anchor: placeAnchor, rotation: placeRotation, ...maskKeyFields(plan) };
  if (!cropKeyframe.id && !cropFieldsMoved(fields, cropKeyframe, size, fit)) return layer;
  const live = cropKeyframe.id ? timelineModel.keyframesFor(layer).find((k) => k.id === cropKeyframe.id) : null;
  return timelineModel.putKeyframe([layer], layer.id,
    { ...cropKeyframe, ...(live || {}), ...fields, id: cropKeyframe.id || keyId })[0];
}

/** The three views' drafts written into the clip's, at the keyframe edited. */
function cropFold() {
  if (!cropWork) return;
  const size = sourceSize();
  // The zoom and pan the crop was set at, kept for that keyframe as Accept
  // has always kept it.
  rememberView('crop', cropLayerId, cropKeyframe,
    size && cropDraft && !isFullFrame(cropDraft, size) ? { zoom: viewZoom, panX: viewPanX, panY: viewPanY } : null);
  const id = newKeyframeId();
  const layer = cropFoldedLayer(id);
  if (!layer) return;
  cropWork = ownedOf(layer, CROP_OWNED);
  // A new keyframe the fold made is the one edited from now on.
  const made = cropKeyframe && !cropKeyframe.id && timelineModel.keyframesFor(layer).find((k) => k.id === id);
  if (made) cropKeyframe = { ...made };
}

/**
 * The three views' drafts read again out of the clip's draft, at the keyframe
 * now being edited, the way openCrop reads them out of the clip.
 */
function cropReseed() {
  const size = sourceSize();
  if (!size || cropModal.hidden) return;
  const target = cropTargetLayer();
  const accepted = currentCrop();
  const kept = accepted
    && accepted.x + accepted.width <= size.w
    && accepted.y + accepted.height <= size.h;
  cropDraft = kept ? { ...accepted } : fullRect(size);
  clearActivePreset();
  const view = kept ? currentCropView() : null;
  viewZoom = view ? clamp(view.zoom, CROP_ZOOM_MIN, CROP_ZOOM_MAX) : 1;
  viewPanX = view ? view.panX : size.w / 2;
  viewPanY = view ? view.panY : size.h / 2;
  const percent = Math.round(viewZoom * 100);
  cropZoomSlider.value = String(percent);
  cropZoomValue.textContent = percent + '%';
  zoomWheelResidue = 0;
  placeTouched = !!(target && target.render);
  placeAnchor = (target && target.anchor) || null;
  placeRotation = (target && target.rotation) || 0;
  placeDrag = null;
  placeRingPress = null;
  placeDraft = target ? (target.render ? { ...target.render } : placeFitRect(target)) : null;
  adoptPlaceRect(placeDraft, target ? placeFitRect(target) : null);
  const now = cropLayerNow();
  if (now) startMaskTab(now, false);
  showCropTab(cropTab);
}

/**
 * The picture under the crop and the mask again, for the playhead having
 * moved: the clip's decoder is on its way to the new frame, and once there it
 * is painted. Until then the frame it was on.
 */
function refreshCropPicture() {
  if (cropModal.hidden) return;
  const repaint = () => {
    if (cropModal.hidden) return;
    cropFrozen = null;
    if (cropTab === 'frame') paintCropFrame();
    else if (cropTab === 'mask') paintMaskStage();
    else drawPlaceStage();
  };
  const entry = cropLayerId ? decoders.get(cropLayerId) : null;
  if (entry && !entry.still && entry.el.seeking) entry.el.addEventListener('seeked', repaint, { once: true });
  repaint();
}

const cropSession = makeKeySession({
  active: () => !!cropWork && !cropModal.hidden,
  layer: cropLayerNow,
  store: (layer) => {
    cropWork = ownedOf(layer, CROP_OWNED);
  },
  fold: cropFold,
  target: () => cropKeyframe,
  setTarget: (k) => {
    cropKeyframe = k;
  },
  reseed: cropReseed,
  refresh: refreshCropPicture,
  draw: () => drawCropKeys(),
});

/** The clip the Crop and Mask window is open on, in advanced editing. */
function cropKeysLayer() {
  if (cropModal.hidden || !timelineDriving() || !cropLayerId || !cropWork) return null;
  return cropLayerNow();
}

const cropStrip = makeKeyStrip(cropKeys, cropKeysReadout, cropKeysCanvas, {
  state: () => {
    const layer = cropKeysLayer();
    if (!layer) return null;
    return {
      layer,
      keys: timelineModel.keyframesFor(layer),
      editing: cropKeyframe,
      width: cropStageWH ? cropStageWH.w : 1,
      lower: !timelineModel.isStill(layer),
    };
  },
  pick: (id) => cropSession.pick(id),
  move: (id, t) => cropSession.move(id, t),
  moved: (id) => cropSession.moved(id),
  scrub: (t) => cropSession.scrub(t),
  scrubbed: () => cropSession.scrubbed(),
  add: (t) => cropSession.add(t),
  remove: (id) => cropSession.remove(id),
});

/** The line and the strip, the strip as wide as the stages. */
function drawCropKeys() {
  cropStrip.draw();
}
