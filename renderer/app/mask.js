'use strict';

// V3.6. A video or image track's mask. V3.6.2: the crop window's third view,
// Layer Mask, rather than a window of its own.
//
// The user, for 3.6: a right click on a video track offers "Add Mask", and
// once it has one "Edit Mask" with "Remove Mask" below it; "The Masks editor
// window should show a preview of the masked video track with the selectable
// shapes above the preview", the last of them "Custom", which opens a file
// dialog of pictures for a mask of the user's own. For 3.6.2: "Crop and Mask
// should be the same window", reached by the clip's cogwheel, with Video
// Frame, Layer Mask and Render Position in a menu that cycles.
//
// The mask belongs to the picture, so the view shows the picture alone as the
// crop window's drafts make it, cropped and unturned, fitted and zoomable like
// the other stages, with what the mask hides shown faintly and what it keeps
// in full. The box is edited in the picture's pixels and kept as fractions of
// it, so a crop changed on the Video Frame view keeps the mask where it is on
// the picture.
//
// One Accept for all three views, the crop window's, and one Cancel. A layer
// with no mask has none in the view until a shape is picked; Add Mask opens
// it on a circle. On a layer with keyframes the box and the soft edge go to
// the keyframe the window is editing, the crop's rule, and only when they
// moved; the rest is the layer's. Remove Mask takes it off outright.

const maskPanel = el('maskPanel');
const maskShapes = el('maskShapes');
const maskFileName = el('maskFileName');
const maskInvert = el('maskInvert');
const maskSoftSlider = el('maskSoftSlider');
const maskSoftBox = el('maskSoftBox');
const maskRingField = el('maskRingField');
const maskRingSlider = el('maskRingSlider');
const maskRingBox = el('maskRingBox');
const maskPointsField = el('maskPointsField');
const maskPointsSlider = el('maskPointsSlider');
const maskPointsBox = el('maskPointsBox');
const maskInnerField = el('maskInnerField');
const maskInnerSlider = el('maskInnerSlider');
const maskInnerBox = el('maskInnerBox');
// V3.6.4. A square's rounded corners, and the grid the fields are in.
const maskRadiusField = el('maskRadiusField');
const maskRadiusSlider = el('maskRadiusSlider');
const maskRadiusBox = el('maskRadiusBox');
const maskGrid = el('maskGrid');
const maskStage = el('maskStage');
const maskCanvas = el('maskCanvas');
const maskBoxEl = el('maskBoxEl');
const maskGuideX = el('maskGuideX');
const maskGuideY = el('maskGuideY');
const maskHint = el('maskHint');
const maskZoomHint = el('maskZoomHint');
// V3.7.1. Color or Gradient, Shape Settings' pair, and the gradient's editor.
const maskFill = el('maskFill');
const maskColorBtn = el('maskColorBtn');
const maskFillHint = el('maskFillHint');
const maskGradient = el('maskGradient');
const maskGradBar = el('maskGradBar');
const maskGradHelp = el('maskGradHelp');
const maskGradCanvas = el('maskGradCanvas');
const maskGradStart = el('maskGradStart');
const maskGradEnd = el('maskGradEnd');
const maskGradAngle = el('maskGradAngle');
const maskGradLine = el('maskGradLine');

// How faintly what the mask hides is shown on the stage.
const MASK_GHOST = 0.25;

// The layer had no mask when the window opened: whatever Accept keeps is a
// new mask, the whole of it the layer's.
let maskFirst = false;
// The picture the mask belongs to, as the window's drafts place it, in
// project pixels: { width, height }.
let maskPic = null;
// { kind, invert, soft and box in the picture's whole pixels, ring, points,
// inner, src, by, aspect, and since 3.6.4 radius in the picture's whole
// pixels, and since 3.7.1 fill, color, and gradient with its start and end
// in the picture's whole pixels and its angle in whole degrees }, or null
// for no mask.
let maskDraft = null;
// The mask as the window opened on it, in fractions, as JSON, or null.
let maskOpened = null;
// V3.6.4. Remove Mask was pressed: the window stays open and Accept takes the
// layer's mask off, keyframes and all, the way Remove Mask always has. A
// shape picked after it is a new mask, the whole of it the layer's.
let maskCleared = false;
// V3.8.2. The mask of a shape that was clicked off, in fractions of the
// picture, or null. See deselectMaskShape.
let maskStash = null;

/** The draft from a mask, in the picture's pixels. */
function maskDraftOf(m) {
  const W = maskPic.width;
  const H = maskPic.height;
  return {
    kind: m.kind,
    invert: m.invert,
    soft: Math.round(m.soft * H),
    box: { x: Math.round(m.box.x * W), y: Math.round(m.box.y * H), w: Math.round(m.box.w * W), h: Math.round(m.box.h * H) },
    ring: m.ring,
    points: m.points,
    inner: m.inner,
    radius: Math.round((m.radius || 0) * H),
    src: m.src,
    by: m.by,
    aspect: m.aspect,
    // V3.7.1.
    fill: m.fill || 'color',
    color: m.color || '#ffffffff',
    gradient: maskDraftGradient(m.gradient || timelineModel.maskGradientOf(null), H),
  };
}

/** V3.7.1. A mask's gradient in the picture's whole pixels, `H` high. */
function maskDraftGradient(g, H) {
  return {
    stops: g.stops.map((stop) => ({ at: stop.at, color: stop.color })),
    start: Math.round(g.start * H),
    end: Math.round(g.end * H),
    angle: Math.round(g.angle),
  };
}

/** The mask a draft stands for, in fractions of the picture, through the model. */
function maskOfDraft(d) {
  const W = Math.max(1, maskPic.width);
  const H = Math.max(1, maskPic.height);
  const g = d.gradient;
  return timelineModel.maskOf({
    ...d,
    soft: d.soft / H,
    radius: (d.radius || 0) / H,
    box: { x: d.box.x / W, y: d.box.y / H, w: d.box.w / W, h: d.box.h / H },
    gradient: g ? { ...g, start: g.start / H, end: g.end / H } : null,
  });
}

// V3.6.4. Rounded corners reach half the box's shorter side, where its ends
// are round, as a Square shape's do. A box made smaller afterwards keeps the
// number, and the drawing holds it to the half.
function maskRadiusCeiling() {
  const b = maskDraft ? maskDraft.box : null;
  return Math.max(1, Math.round(b ? Math.min(b.w, b.h) / 2 : 1));
}

// The soft edge reaches half the picture's height, as a shape's reaches half
// the frame's.
function maskSoftCeiling() {
  return Math.max(1, Math.round((maskPic ? maskPic.height : projectFrame().height) / 2));
}

/**
 * The picture the mask belongs to, as the crop window's drafts place it at
 * the moment it is editing: its size in project pixels.
 */
function maskPictureSize() {
  // V3.7. The clip as the window's draft has it, here and below.
  const layer = cropLayerNow();
  const source = layer && layerSource(layer);
  const draft = layer && cropDraftLayer(cropRenderDraft(), false);
  const t = layer ? (cropKeyframe ? cropKeyframe.t : compositeAt - layer.start) : 0;
  const p = source && draft && layerGeometry.placementAt(draft, t, source, projectFrame());
  return p ? { width: Math.max(1, p.dest.width), height: Math.max(1, p.dest.height) } : { width: 1280, height: 720 };
}

/** A new mask of a kind, the largest of its shape that fits the picture. */
function maskStarting(kind, props = {}) {
  const m = timelineModel.maskOf({ ...props, kind });
  return { ...m, box: genDraw.maskStartBox(m, maskPic.width, maskPic.height) };
}

/**
 * V3.6.2. The window has opened on `layer`: its mask at the moment being
 * edited, or none, or with `add` a circle, as Add Mask has always opened.
 */
function startMaskTab(layer, add) {
  maskFirst = !layer.mask;
  maskCleared = false;
  // V3.8.2. maskStash is not cleared here: the reseed after a reset opens the
  // tab again, and that is when the settings of a shape clicked off are kept.
  maskPic = maskPictureSize();
  const t = cropKeyframe ? cropKeyframe.t : compositeAt - layer.start;
  let mask = layer.mask ? timelineModel.maskAt(layer, t) : null;
  if (!mask && add) mask = maskStarting('circle');
  maskDraft = mask ? maskDraftOf(mask) : null;
  maskOpened = layer.mask ? JSON.stringify(maskOfDraft(maskDraftOf(timelineModel.maskAt(layer, t)))) : null;
  // A custom mask's picture, so the stage has it to draw.
  if (mask && mask.kind === 'custom') loadMaskPicture(mask).then(() => paintMaskStage(), () => {});
}

/** The window has closed, Accept or Cancel. */
function stopMaskTab() {
  maskDraft = null;
  maskOpened = null;
  maskPic = null;
  maskFirst = false;
  maskCleared = false;
  maskStash = null;
  maskGuideX.hidden = true;
  maskGuideY.hidden = true;
}

/** A shape button's first press on a layer with no mask. */
function startMaskDraft(kind) {
  if (!maskPic) maskPic = maskPictureSize();
  maskDraft = maskDraftOf(maskStarting(kind));
  if (cropTab === 'mask') showMaskTab();
}

/**
 * Remove Mask: the draft goes and the window stays. V3.6.4, the user: "Reset
 * Crop/Mask/Position shouldnt close the window, it should just reset it."
 * The draft's side of it; V3.7.1's saveCropReset takes it off the clip.
 */
function dropMaskDraft(keep = false) {
  // V3.8.2. Remove Mask and Accept let the stored settings go with the draft;
  // only a shape clicked off keeps them.
  maskStash = keep && maskDraft && maskPic ? maskOfDraft(maskDraft) : null;
  maskDraft = null;
  maskCleared = true;
  showMaskTab();
}

/**
 * V3.8.2. The user: clicking the selected shape again takes the mask off like
 * Remove Mask, "but keeps the applied settings temporarily so they can be
 * restored if the same shape gets clicked again or a part of the settings can
 * be applied to another shape". Not for Custom, which is a picture to pick.
 */
function deselectMaskShape() {
  dropMaskDraft(true);
  saveCropReset('mask');
}

/**
 * V3.8.2. A shape clicked with the stored settings waiting: the same shape
 * gets all of them back, another gets them as a shape switched to would, its
 * own proportions on the box's height and middle. The stash is kept until
 * Remove Mask or Accept, so it can be tried on one shape after another.
 */
function restoreMaskShape(kind) {
  maskDraft = maskDraftOf(maskStash);
  if (maskDraft.kind !== kind) maskDraft = { ...maskDraft, ...refitMask({ kind }) };
  maskCleared = true;
  showMaskTab();
  placeMaskBox();
  paintMaskStage();
}

/**
 * The Layer Mask view coming up. The crop or the placement may have changed
 * on the other views, so the picture is measured again and the draft, which
 * is in its pixels, carried across in fractions.
 */
function showMaskTab() {
  const pic = maskPictureSize();
  if (maskDraft && maskPic && (pic.width !== maskPic.width || pic.height !== maskPic.height)) {
    const m = maskOfDraft(maskDraft);
    maskPic = pic;
    maskDraft = maskDraftOf(m);
  } else {
    maskPic = pic;
  }
  showMaskDraft(null);
  resizeMaskStage();
}

/**
 * The mask as the drafts make it, for the layer `layer`: `layer` the mask the
 * layer has, and `keyed` the box, soft edge and corners for the keyframe being
 * edited, when it has its mask already and the window is on a keyframe. Empty
 * with no draft. V3.6.4: `remove` when Remove Mask has been pressed on a layer
 * with a mask, which goes first, keyframes and all, before any new one.
 */
function maskDraftParts(layer) {
  const gone = maskCleared && !!layer.mask;
  if (!maskDraft || !maskPic) return gone ? { remove: true } : {};
  const mask = maskOfDraft(maskDraft);
  if (gone) return { remove: true, layer: mask };
  if (maskFirst || !layer.mask || !cropKeyframe) return { layer: mask };
  return {
    layer: { ...mask, box: layer.mask.box, soft: layer.mask.soft, radius: layer.mask.radius },
    keyed: { box: mask.box, soft: mask.soft, radius: mask.radius },
  };
}

/** V3.6.4. What a keyframe written with the drafts holds of the mask, as fields. */
function maskKeyFields(parts) {
  if (parts.keyed) return { mask: parts.keyed };
  return parts.remove ? { mask: null } : {};
}


/** What Accept writes, as maskDraftParts, less whatever did not change. */
function maskAcceptPlan() {
  const layer = cropLayerNow();
  if (!layer) return {};
  const parts = maskDraftParts(layer);
  if (parts.remove || !maskDraft || !maskPic) return parts;
  const now = maskOfDraft(maskDraft);
  if (maskFirst || !layer.mask) return parts;
  if (JSON.stringify(now) === maskOpened) return {};
  if (!parts.keyed) return parts;
  const opened = JSON.parse(maskOpened);
  const moved = JSON.stringify([now.box, now.soft, now.radius])
    !== JSON.stringify([opened.box, opened.soft, opened.radius]);
  return moved ? parts : { layer: parts.layer };
}

// ---- the stage ----

function resizeMaskStage() {
  if (cropModal.hidden || cropTab !== 'mask' || !maskPic) return;
  // V3.6.3. The size all three views of the window share, measureCropStage's.
  const { w, h } = cropStageWH || measureCropStage();
  maskStage.style.width = w + 'px';
  maskStage.style.height = h + 'px';
  // V3.6.4. The settings over it as wide, so their columns start at its left
  // edge and at its middle.
  maskGrid.style.width = w + 'px';
  // V3.7.1. The gradient's bar as wide as the preview too.
  maskGradBar.style.width = w + 'px';
  maskGradHelp.style.width = w + 'px';
  maskCanvas.style.left = '0px';
  maskCanvas.style.top = '0px';
  maskCanvas.style.width = w + 'px';
  maskCanvas.style.height = h + 'px';
  const dpr = hostWindowOf(maskStage).devicePixelRatio || 1;
  maskCanvas.width = Math.max(1, Math.round(w * dpr));
  maskCanvas.height = Math.max(1, Math.round(h * dpr));
  placeMaskBox();
  maskGrad.paintBar(true);
  paintMaskStage();
}

// Held to this many pixels on its longer side: zoomed far in, the picture on
// the stage would otherwise be cut out at many times the screen's size.
const MASK_STAGE_MAX = 4096;

/**
 * The picture as the Video Frame view crops it, from the frame the crop
 * window holds, with what the mask hides faint over the checkerboard and what
 * it keeps in full, and outside the picture dimmed. With no mask, all of it.
 */
function paintMaskStage() {
  if (!maskPic || cropTab !== 'mask') return;
  const layer = cropLayerNow();
  const ctx = maskCanvas.getContext('2d');
  const r = stageFrameRect(maskStage);
  const dpr = maskCanvas.width / Math.max(1, r.w);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
  const fx = r.left * dpr;
  const fy = r.top * dpr;
  const fw = r.width * dpr;
  const fh = r.height * dpr;
  ctx.save();
  ctx.translate(fx, fy);
  ctx.fillStyle = checkerPattern(ctx, dpr);
  ctx.fillRect(0, 0, fw, fh);
  ctx.restore();
  const src = cropFrameSource();
  const size = sourceSize();
  if (layer && src && size && cropDraft) {
    const iw = src.videoWidth || src.naturalWidth || src.width || size.w;
    const ih = src.videoHeight || src.naturalHeight || src.height || size.h;
    const from = [cropDraft.x / size.w * iw, cropDraft.y / size.h * ih,
      cropDraft.width / size.w * iw, cropDraft.height / size.h * ih];
    if (!maskDraft) {
      ctx.drawImage(src, ...from, fx, fy, fw, fh);
    } else {
      ctx.globalAlpha = MASK_GHOST;
      ctx.drawImage(src, ...from, fx, fy, fw, fh);
      ctx.globalAlpha = 1;
      const k = Math.min(1, MASK_STAGE_MAX / Math.max(fw, fh));
      const cut = maskedPicture({ ...layer, mask: maskOfDraft(maskDraft), keyframes: [] }, src, from,
        { dw: fw * k, dh: fh * k }, layer.start);
      ctx.drawImage(cut.el, ...cut.from, fx, fy, fw, fh);
    }
  }
  dimOutsideFrame(ctx, maskCanvas, maskStage);
}

function placeMaskBox() {
  maskBoxEl.hidden = !maskDraft;
  // V3.7.1. The gradient's line goes with the box it runs from.
  maskGrad.placeLine();
  if (!maskDraft) return;
  const r = stageFrameRect(maskStage);
  const b = maskDraft.box;
  maskBoxEl.style.left = (r.left + b.x * r.s) + 'px';
  maskBoxEl.style.top = (r.top + b.y * r.s) + 'px';
  maskBoxEl.style.width = (b.w * r.s) + 'px';
  maskBoxEl.style.height = (b.h * r.s) + 'px';
}

function showMaskGuides(x, y) {
  const r = stageFrameRect(maskStage);
  maskGuideX.hidden = x === null;
  maskGuideY.hidden = y === null;
  if (x !== null) {
    maskGuideX.style.left = (r.left + x * r.s) + 'px';
    maskGuideX.style.top = r.top + 'px';
    maskGuideX.style.height = r.height + 'px';
  }
  if (y !== null) {
    maskGuideY.style.top = (r.top + y * r.s) + 'px';
    maskGuideY.style.left = r.left + 'px';
    maskGuideY.style.width = r.width + 'px';
  }
}

bindStageView(maskStage, {
  open: () => !!maskPic && !cropModal.hidden && cropTab === 'mask',
  empty: (evt) => evt.target === maskStage || evt.target === maskCanvas,
  redraw: () => {
    placeMaskBox();
    paintMaskStage();
  },
  size: () => maskPic,
});

// ---- the settings ----

function showMaskDraft(except) {
  const d = maskDraft;
  for (const b of maskShapes.querySelectorAll('button')) {
    b.classList.toggle('btn--active', !!d && b.dataset.kind === d.kind);
  }
  const name = d && d.kind === 'custom' && d.src ? d.src.split(/[\\/]/).pop() : '';
  maskFileName.textContent = name;
  maskFileName.title = d && d.kind === 'custom' && d.src ? d.src : '';
  maskFileName.hidden = !name;
  // With no mask there is nothing for these to say, so they wait, greyed.
  for (const input of [maskInvert, maskSoftSlider, maskSoftBox, maskRingSlider, maskRingBox,
    maskPointsSlider, maskPointsBox, maskInnerSlider, maskInnerBox,
    maskRadiusSlider, maskRadiusBox, maskColorBtn, ...maskFill.querySelectorAll('button')]) input.disabled = !d;
  // V3.7.1. Color shows the swatch; Gradient the line in its place and the
  // gradient's controls under the settings, as Shape Settings does.
  const grad = maskGradientOn();
  for (const b of maskFill.querySelectorAll('button')) {
    b.classList.toggle('btn--active', (d ? d.fill : 'color') === b.dataset.fill);
  }
  paintSwatch(maskColorBtn, d ? d.color : '#ffffffff');
  maskColorBtn.hidden = grad;
  maskFillHint.hidden = !grad;
  maskGradient.hidden = !grad;
  maskGrad.showBoxes(except);
  // Remove Mask has something to take off once there is a mask or a draft,
  // and nothing once it has been pressed.
  const own = cropLayerNow();
  // V3.8.2. Or stored settings to let go of.
  if (cropTab === 'mask') cropRemoveBtn.disabled = !d && !maskStash && !(own && own.mask && !maskCleared);
  if (!d) {
    maskInvert.checked = false;
    maskRingField.hidden = true;
    maskPointsField.hidden = true;
    maskInnerField.hidden = true;
    maskRadiusField.hidden = true;
    return;
  }
  maskInvert.checked = d.invert;
  const show = (slider, box, value) => {
    slider.value = String(value);
    if (except !== box) box.value = String(value);
  };
  maskSoftSlider.max = String(maskSoftCeiling());
  show(maskSoftSlider, maskSoftBox, d.soft);
  maskRingField.hidden = d.kind !== 'ring';
  show(maskRingSlider, maskRingBox, Math.round(d.ring * 100));
  maskPointsField.hidden = d.kind !== 'star';
  maskInnerField.hidden = d.kind !== 'star';
  show(maskPointsSlider, maskPointsBox, d.points);
  show(maskInnerSlider, maskInnerBox, Math.round(d.inner * 100));
  maskRadiusField.hidden = d.kind !== 'square';
  maskRadiusSlider.max = String(maskRadiusCeiling());
  show(maskRadiusSlider, maskRadiusBox, d.radius || 0);
}

function changeMask(props, except) {
  if (!maskDraft) return;
  maskDraft = { ...maskDraft, ...props };
  showMaskDraft(except);
  placeMaskBox();
  paintMaskStage();
}

function maskAspectOf(d) {
  return d.kind === 'custom' ? d.aspect || 1 : genDraw.shapeAspect(d);
}

// Another shape keeps the box's height and middle and takes its own
// proportions across, so going from one to another and back lands where it
// started.
function refitMask(props) {
  const b = maskDraft.box;
  const w = Math.max(1, Math.round(b.h * maskAspectOf({ ...maskDraft, ...props })));
  return { ...props, box: { ...b, x: Math.round(b.x + (b.w - w) / 2), w } };
}

// A star given other points or another depth keeps the proportions it had
// against the old figure, as Shape Settings does.
function restarMask(props) {
  const b = maskDraft.box;
  const was = maskAspectOf(maskDraft);
  const now = maskAspectOf({ ...maskDraft, ...props });
  const w = Math.max(1, Math.round(b.w * now / was));
  return { ...props, box: { ...b, x: Math.round(b.x + (b.w - w) / 2), w } };
}

/**
 * Custom: a picture of the user's own, from a dialog of pictures only. What
 * shows is decided once, here: its transparency when it has any, a PNG cut
 * out round a logo, and its brightness when it has none, a black and white
 * matte. On a layer with no mask yet it starts one, its own proportions
 * fitted to the picture.
 */
async function pickMaskImage() {
  const id = cropLayerId;
  const picked = await window.lwclipper.openMaskImage();
  if (cropLayerId !== id || cropModal.hidden || !picked || !picked.ok) return;
  let file;
  try {
    file = await readMaskFile(picked.path);
  } catch {
    if (cropLayerId === id) setStatus('That picture could not be read as a mask.');
    return;
  }
  if (cropLayerId !== id || cropModal.hidden || !maskPic) return;
  const props = { kind: 'custom', src: picked.path, by: file.transparent ? 'alpha' : 'luma', aspect: file.aspect };
  maskFailed.delete(props.src + '|' + props.by);
  if (!maskDraft && maskStash) {
    // V3.8.2. Settings waiting from a shape clicked off go onto the picture.
    maskDraft = maskDraftOf(maskStash);
  }
  if (maskDraft) {
    changeMask(refitMask(props));
  } else {
    maskDraft = maskDraftOf(maskStarting('custom', props));
    showMaskDraft(null);
    placeMaskBox();
    paintMaskStage();
  }
  loadMaskPicture(timelineModel.maskOf(maskOfDraft(maskDraft))).then(() => {
    if (cropLayerId === id) {
      cropPreviewKey = '';
      paintMaskStage();
    }
  }, () => {});
}

for (const b of maskShapes.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!maskPic) return;
    if (b.dataset.kind === 'custom') {
      pickMaskImage();
      return;
    }
    if (!maskDraft) {
      if (maskStash) restoreMaskShape(b.dataset.kind);
      else startMaskDraft(b.dataset.kind);
      return;
    }
    // V3.8.2. The selected shape clicked again is let go of.
    if (maskDraft.kind === b.dataset.kind) {
      deselectMaskShape();
      return;
    }
    changeMask(refitMask({ kind: b.dataset.kind }));
  });
}

maskInvert.addEventListener('change', () => changeMask({ invert: maskInvert.checked }, null));

bindNumberField({
  slider: maskSoftSlider,
  box: maskSoftBox,
  range: () => [0, maskSoftCeiling()],
  set: (n, except) => changeMask({ soft: n }, except),
  show: () => showMaskDraft(null),
});

bindNumberField({
  slider: maskRingSlider,
  box: maskRingBox,
  range: () => [5, 95],
  set: (n, except) => changeMask({ ring: n / 100 }, except),
  show: () => showMaskDraft(null),
});

bindNumberField({
  slider: maskPointsSlider,
  box: maskPointsBox,
  range: () => [3, 12],
  set: (n, except) => changeMask(restarMask({ points: n }), except),
  show: () => showMaskDraft(null),
});

bindNumberField({
  slider: maskInnerSlider,
  box: maskInnerBox,
  range: () => [10, 90],
  set: (n, except) => changeMask(restarMask({ inner: n / 100 }), except),
  show: () => showMaskDraft(null),
});

bindNumberField({
  slider: maskRadiusSlider,
  box: maskRadiusBox,
  range: () => [0, maskRadiusCeiling()],
  set: (n, except) => changeMask({ radius: n }, except),
  show: () => showMaskDraft(null),
});

// ---- V3.7.1. Color or Gradient ----
//
// The user: "Layer masks have no color or gradient option yet, add them".
// The colour is how much of the picture the mask shows, by the rule a custom
// mask picture already has: white shows, black hides, grey and transparency
// show in part; the hue says nothing. A gradient is a run of such colours,
// Shape Settings' editor (gen/gradient.js) on the mask: from the middle of its
// box, Start and End in the picture's pixels, and Rotation from the picture,
// which the mask turns with. The whole clip's, not keyed.

function maskGradientOn() {
  return !!maskDraft && maskDraft.fill === 'gradient';
}

const maskGrad = makeGradientEditor({
  bar: maskGradBar,
  canvas: maskGradCanvas,
  start: maskGradStart,
  end: maskGradEnd,
  angle: maskGradAngle,
  line: maskGradLine,
  stage: maskStage,
  // A hundred picture heights either way, the model's reach.
  reach: () => Math.round(100 * (maskPic ? maskPic.height : 720)),
  get: () => (maskDraft ? maskDraft.gradient : null),
  on: maskGradientOn,
  set: (props, quick, except) => setMaskGradient(props, quick, except),
  centre: () => {
    const b = maskDraft.box;
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  },
  turn: () => 0,
  pick: (color, live) => pickColor(color, live, cropModal),
  owner: () => cropLayerId,
});

function setMaskGradient(props, quick, except) {
  if (!maskDraft) return;
  maskDraft = { ...maskDraft, gradient: { ...maskDraft.gradient, ...props } };
  showMaskDraft(except || null);
  maskGrad.paintBar(!quick);
  maskGrad.placeLine();
  paintMaskStage();
}

// Color or Gradient. A mask that never had a gradient has it laid across
// itself the first time, white on its left edge into black on its right.
for (const b of maskFill.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!maskDraft || b.dataset.fill === maskDraft.fill) return;
    const props = { fill: b.dataset.fill };
    const unset = JSON.stringify(maskDraftGradient(timelineModel.maskGradientOf(null), maskPic.height));
    if (props.fill === 'gradient' && JSON.stringify(maskDraft.gradient) === unset) {
      const half = Math.max(1, Math.round(maskDraft.box.w / 2));
      props.gradient = { ...maskDraft.gradient, start: -half, end: half, angle: 0 };
    }
    changeMask(props, null);
    // The gradient's controls come and go, so the window is fitted again.
    cropContentChanged();
  });
}

maskColorBtn.addEventListener('click', async () => {
  if (!maskDraft) return;
  const was = maskDraft.color;
  const id = cropLayerId;
  const live = () => cropLayerId === id && !!maskDraft && !cropModal.hidden;
  const picked = await pickColor(was, (color) => {
    if (live()) changeMask({ color }, null);
  }, cropModal);
  // The window may have been closed under the picker, by Escape for one.
  if (!live()) return;
  changeMask({ color: picked || was }, null);
});

// ---- the box: the shape's grips, in the picture's pixels ----

function setMaskBox(box) {
  changeMask({ box: { x: box.x, y: box.y, w: box.w, h: box.h } }, null);
}

for (const grip of maskBoxEl.querySelectorAll('.crop-grip')) {
  const edge = grip.dataset.edge;
  const vertical = edge === 'top' || edge === 'bottom';
  grip.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !maskDraft) return;
    evt.stopPropagation();
    const start = { ...maskDraft.box };
    const s = stageFrameRect(maskStage).s;
    const from = vertical ? evt.clientY : evt.clientX;
    beginDrag(grip, evt, (ev) => {
      const travel = ((vertical ? ev.clientY : ev.clientX) - from) / s;
      const r = layerGeometry.textBoxEdge(start, edge, travel, ev.shiftKey, maskPic, TEXT_BOX_SNAP / s);
      showMaskGuides(vertical ? null : r.snap, vertical ? r.snap : null);
      setMaskBox(r.box);
    }, () => showMaskGuides(null, null));
  });
}

for (const corner of maskBoxEl.querySelectorAll('.crop-corner')) {
  corner.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !maskDraft) return;
    evt.stopPropagation();
    const start = { ...maskDraft.box };
    const s = stageFrameRect(maskStage).s;
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    beginDrag(corner, evt, (ev) => {
      setMaskBox(layerGeometry.boxCornerScale(start, corner.dataset.corner,
        (ev.clientX - x0) / s, (ev.clientY - y0) / s, ev.shiftKey, maskPic));
    });
  });
}

maskBoxEl.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || !maskDraft || evt.target !== maskBoxEl) return;
  const start = { ...maskDraft.box };
  const s = stageFrameRect(maskStage).s;
  const x0 = evt.clientX;
  const y0 = evt.clientY;
  beginDrag(maskBoxEl, evt, (ev) => {
    const r = layerGeometry.textBoxMove(start, (ev.clientX - x0) / s, (ev.clientY - y0) / s, maskPic, TEXT_BOX_SNAP / s);
    showMaskGuides(r.snapX, r.snapY);
    setMaskBox(r.box);
  }, () => showMaskGuides(null, null));
});

// ---- the right click ----

/**
 * Add Mask or Edit Mask on a layer, from the right click at `at` on the
 * timeline: the crop window on its Layer Mask view, on the clip, so its
 * picture is the one shown: where it was clicked, or its start, when the
 * playhead is somewhere else.
 */
function openMask(layerId, at) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || layer.kind === 'gen' || layer.type !== 'video' || busy) return;
  if (!cropWindowOn(layerId) && !timelineModel.covers(layer, compositeAt)) {
    const fps = projectFrame().fps || 30;
    const want = Number.isFinite(at) ? at : layer.start;
    seekComposite(Math.min(Math.max(want, layer.start), timelineModel.endOf(layer) - 1 / fps));
  }
  selectLayer(layer.id);
  openCrop(layer.id, 'mask', !layer.mask);
}

/** Remove Mask on the right click: one step, and a window open on it asked about. */
function removeMaskFrom(layerId) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || !layer.mask || busy) return;
  const run = () => {
    setLayers(timelineModel.removeMask(layers, layerId));
    commitHistory();
    return true;
  };
  confirmPopoutConflict([cropWindowOn(layerId) && cropWindowConflict()], run);
}
