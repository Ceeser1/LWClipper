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
const maskStage = el('maskStage');
const maskCanvas = el('maskCanvas');
const maskBoxEl = el('maskBoxEl');
const maskGuideX = el('maskGuideX');
const maskGuideY = el('maskGuideY');
const maskHint = el('maskHint');
const maskZoomHint = el('maskZoomHint');

// How faintly what the mask hides is shown on the stage.
const MASK_GHOST = 0.25;

// The layer had no mask when the window opened: whatever Accept keeps is a
// new mask, the whole of it the layer's.
let maskFirst = false;
// The picture the mask belongs to, as the window's drafts place it, in
// project pixels: { width, height }.
let maskPic = null;
// { kind, invert, soft and box in the picture's whole pixels, ring, points,
// inner, src, by, aspect }, or null for no mask.
let maskDraft = null;
// The mask as the window opened on it, in fractions, as JSON, or null.
let maskOpened = null;

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
    src: m.src,
    by: m.by,
    aspect: m.aspect,
  };
}

/** The mask a draft stands for, in fractions of the picture, through the model. */
function maskOfDraft(d) {
  const W = Math.max(1, maskPic.width);
  const H = Math.max(1, maskPic.height);
  return timelineModel.maskOf({
    ...d,
    soft: d.soft / H,
    box: { x: d.box.x / W, y: d.box.y / H, w: d.box.w / W, h: d.box.h / H },
  });
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
  const layer = cropLayerId && timelineModel.layerById(layers, cropLayerId);
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
  maskGuideX.hidden = true;
  maskGuideY.hidden = true;
}

/** A shape button's first press on a layer with no mask. */
function startMaskDraft(kind) {
  if (!maskPic) maskPic = maskPictureSize();
  maskDraft = maskDraftOf(maskStarting(kind));
  if (cropTab === 'mask') showMaskTab();
}

/** Remove Mask with nothing on the layer yet: the started draft goes. */
function dropMaskDraft() {
  maskDraft = null;
  showMaskTab();
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
 * layer has, and `keyed` the box and soft edge for the keyframe being edited,
 * when it has its mask already and the window is on a keyframe. Empty with no
 * draft.
 */
function maskDraftParts(layer) {
  if (!maskDraft || !maskPic) return {};
  const mask = maskOfDraft(maskDraft);
  if (maskFirst || !layer.mask || !cropKeyframe) return { layer: mask };
  return {
    layer: { ...mask, box: layer.mask.box, soft: layer.mask.soft },
    keyed: { box: mask.box, soft: mask.soft },
  };
}

/** What Accept writes, as maskDraftParts, less whatever did not change. */
function maskAcceptPlan() {
  const layer = cropLayerId && timelineModel.layerById(layers, cropLayerId);
  if (!layer || !maskDraft || !maskPic) return {};
  const parts = maskDraftParts(layer);
  const now = maskOfDraft(maskDraft);
  if (maskFirst || !layer.mask) return parts;
  if (JSON.stringify(now) === maskOpened) return {};
  if (!parts.keyed) return parts;
  const opened = JSON.parse(maskOpened);
  const moved = JSON.stringify([now.box, now.soft]) !== JSON.stringify([opened.box, opened.soft]);
  return moved ? parts : { layer: parts.layer };
}

// ---- the stage ----

function resizeMaskStage() {
  if (cropModal.hidden || cropTab !== 'mask' || !maskPic) return;
  // V3.6.3. The size all three views of the window share, measureCropStage's.
  const { w, h } = cropStageWH || measureCropStage();
  maskStage.style.width = w + 'px';
  maskStage.style.height = h + 'px';
  maskCanvas.style.left = '0px';
  maskCanvas.style.top = '0px';
  maskCanvas.style.width = w + 'px';
  maskCanvas.style.height = h + 'px';
  const dpr = hostWindowOf(maskStage).devicePixelRatio || 1;
  maskCanvas.width = Math.max(1, Math.round(w * dpr));
  maskCanvas.height = Math.max(1, Math.round(h * dpr));
  placeMaskBox();
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
  const layer = cropLayerId && timelineModel.layerById(layers, cropLayerId);
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
    maskPointsSlider, maskPointsBox, maskInnerSlider, maskInnerBox]) input.disabled = !d;
  // Remove Mask has something to take off once there is a mask or a draft.
  const own = cropLayerId && timelineModel.layerById(layers, cropLayerId);
  if (cropTab === 'mask') cropRemoveBtn.disabled = !d && !(own && own.mask);
  if (!d) {
    maskInvert.checked = false;
    maskRingField.hidden = true;
    maskPointsField.hidden = true;
    maskInnerField.hidden = true;
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
      startMaskDraft(b.dataset.kind);
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
