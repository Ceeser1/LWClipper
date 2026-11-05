'use strict';

// V3.6. Edit Mask: a video or image track's mask, in a window of its own.
//
// The user: a right click on a video track offers "Add Mask", and once it has
// one "Edit Mask" with "Remove Mask" below it; "The Masks editor window should
// show a preview of the masked video track with the selectable shapes above
// the preview", the last of them "Custom", which opens a file dialog of
// pictures for a mask of the user's own.
//
// The mask belongs to the picture, so the stage shows the picture alone as it
// is placed at the playhead, cropped and unturned, fitted and zoomable like
// the other stages, with what the mask hides shown faintly and what it keeps
// in full. The main window's preview shows the draft in the whole frame while
// the window is open, the way the crop window's does. The box is edited in
// the picture's pixels and kept as fractions of it.
//
// Add Mask's Accept adds the mask and its Cancel adds nothing, the Add Media
// rule. Editing on a layer with keyframes follows the crop's rule: the box and
// the soft edge go to the keyframe at the playhead, made there if there is
// none, and only when they changed; the rest is the layer's.

const maskModal = el('maskModal');
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
const maskAcceptBtn = el('maskAcceptBtn');
const maskCancelBtn = el('maskCancelBtn');

// How faintly what the mask hides is shown on the stage.
const MASK_GHOST = 0.25;

let maskLayerId = null;
// Opened by Add Mask: Accept adds the mask, Cancel adds nothing.
let maskFirst = false;
// The keyframe being edited, as keyframeToEdit gives it, or null.
let maskKeyframe = null;
// The picture the mask belongs to, as placed where the editor opened, in
// project pixels: { width, height }.
let maskPic = null;
// { kind, invert, soft and box in the picture's whole pixels, ring, points,
// inner, src, by, aspect }
let maskDraft = null;
let maskOpened = null;    // the draft as it opened, as JSON
let maskPreviewKey = '';
let maskOwnsPreview = false;

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

/** V3.6. Whether the mask window is open on this layer. */
function maskWindowOn(layerId) {
  return !maskModal.hidden && !!maskLayerId && maskLayerId === layerId;
}

/** V3.6. The open mask window as a conflict confirmPopoutConflict can name, or null. */
function maskWindowConflict() {
  if (maskModal.hidden) return null;
  return {
    message: t('The mask window is open. Going on closes it and discards what it has not accepted.'),
    close: cancelMask,
  };
}

/**
 * Add Mask or Edit Mask on a layer, from the right click at `at` on the
 * timeline. A crop window or Crop Render Frame open beside it asks first,
 * since only one window at a time can show its draft in the main preview.
 */
function openMask(layerId, at) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || layer.kind === 'gen' || layer.type !== 'video' || busy) return;
  if (maskWindowOn(layerId)) {
    focusPopOut(maskModal);
    return;
  }
  confirmPopoutConflict([cropWindowConflict(), renderWindowConflict(), maskWindowConflict()],
    () => openMaskNow(layerId, at));
}

function openMaskNow(layerId, at) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer) return;
  // On the clip, so its picture is the one shown: where it was clicked, or
  // its start, when the playhead is somewhere else.
  if (!timelineModel.covers(layer, compositeAt)) {
    const fps = projectFrame().fps || 30;
    const want = Number.isFinite(at) ? at : layer.start;
    seekComposite(Math.min(Math.max(want, layer.start), timelineModel.endOf(layer) - 1 / fps));
  }
  maskLayerId = layer.id;
  maskFirst = !layer.mask;
  maskKeyframe = maskFirst ? null : keyframeToEdit(layer);
  const t = maskKeyframe ? maskKeyframe.t : compositeAt - layer.start;
  const source = layerSource(layer);
  const p = source && layerGeometry.placementAt(layer, t, source, projectFrame());
  maskPic = p ? { width: p.dest.width, height: p.dest.height } : { width: 1280, height: 720 };
  let mask = layer.mask ? timelineModel.maskAt(layer, t) : null;
  if (!mask) {
    mask = timelineModel.maskOf({ kind: 'circle' });
    mask = { ...mask, box: genDraw.maskStartBox(mask, maskPic.width, maskPic.height) };
  }
  maskDraft = maskDraftOf(mask);
  maskOpened = JSON.stringify(maskDraft);
  maskModal.hidden = false;
  recallStageView(maskStage, maskLayerId, maskKeyframe);
  maskPreviewKey = '';
  popOut(maskModal, 'mask', {
    title: maskModal.querySelector('.modal__title').textContent,
    cancel: cancelMask,
    relayout: resizeMaskStage,
    preview: previewMaskDraft,
  });
  showMaskDraft(null);
  resizeMaskStage();
  // A custom mask's picture, so the stage has it to draw.
  if (mask.kind === 'custom') loadMaskPicture(mask).then(() => paintMaskStage(), () => {});
}

function closeMask() {
  if (maskLayerId) rememberStageView(maskStage, maskLayerId, maskKeyframe);
  popIn(maskModal);
  maskModal.hidden = true;
  maskGuideX.hidden = true;
  maskGuideY.hidden = true;
  if (maskOwnsPreview) {
    maskOwnsPreview = false;
    popoutPreview = null;
    drawComposite();
  }
  maskLayerId = null;
  maskKeyframe = null;
  maskDraft = null;
  maskOpened = null;
  maskPic = null;
}

function cancelMask() {
  closeMask();
}

/** The layer as Accept would leave it, for the main window's preview. */
function maskDraftLayer() {
  const layer = maskLayerId ? timelineModel.layerById(layers, maskLayerId) : null;
  if (!layer || !maskDraft) return null;
  const mask = maskOfDraft(maskDraft);
  if (!maskKeyframe || !layer.mask) return { ...layer, mask };
  const live = maskKeyframe.id
    ? timelineModel.keyframesFor(layer).find((k) => k.id === maskKeyframe.id)
    : null;
  const base = { ...layer, mask: { ...mask, box: layer.mask.box, soft: layer.mask.soft } };
  return timelineModel.putKeyframe([base], layer.id, {
    ...maskKeyframe,
    ...(live || {}),
    mask: { box: mask.box, soft: mask.soft },
    id: maskKeyframe.id || 'draft',
  })[0];
}

/**
 * POPOUT_FPS times a second while the window is open: the stage follows the
 * playhead, since the main window stays usable, and the main preview shows the
 * draft. A layer that has gone from under the window takes the window with it.
 */
function previewMaskDraft() {
  if (maskModal.hidden || !maskDraft) return;
  if (!timelineModel.layerById(layers, maskLayerId)) {
    cancelMask();
    return;
  }
  const key = JSON.stringify([maskDraft, compositeAt]);
  if (key === maskPreviewKey && !compositePlaying) return;
  maskPreviewKey = key;
  paintMaskStage();
  popoutPreview = { layerId: maskLayerId, layerNow: maskDraftLayer };
  maskOwnsPreview = true;
  if (!compositePlaying) drawComposite();
}

// ---- the stage ----

function resizeMaskStage() {
  if (maskModal.hidden || !maskDraft) return;
  const panel = maskStage.parentElement;
  let w = Math.round(panel.clientWidth * CROP_FRAME_SHARE);
  let h = Math.round(w * 9 / 16);
  const maxH = popupStageRoom(panel, maskStage, CROP_HEIGHT_SHARE);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * 16 / 9);
  }
  w = Math.max(160, w);
  h = Math.max(90, h);
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
 * The picture as it is at the playhead, with what the mask hides faint over
 * the checkerboard and what it keeps in full, and outside the picture dimmed.
 */
function paintMaskStage() {
  if (!maskDraft) return;
  const layer = timelineModel.layerById(layers, maskLayerId);
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
  const entry = layer && decoders.get(layer.id);
  const source = layer && layerSource(layer);
  if (entry && entry.width && source) {
    const t = maskKeyframe ? maskKeyframe.t : compositeAt - layer.start;
    const p = layerGeometry.placementAt(layer, t, source, projectFrame());
    if (p) {
      const kx = entry.width / source.width;
      const ky = entry.height / source.height;
      const from = [p.src.x * kx, p.src.y * ky, p.src.width * kx, p.src.height * ky];
      ctx.globalAlpha = MASK_GHOST;
      ctx.drawImage(entry.el, ...from, fx, fy, fw, fh);
      ctx.globalAlpha = 1;
      const k = Math.min(1, MASK_STAGE_MAX / Math.max(fw, fh));
      const cut = maskedPicture({ ...layer, mask: maskOfDraft(maskDraft), keyframes: [] }, entry.el, from,
        { dw: fw * k, dh: fh * k }, layer.start);
      ctx.drawImage(cut.el, ...cut.from, fx, fy, fw, fh);
    }
  }
  dimOutsideFrame(ctx, maskCanvas, maskStage);
}

function placeMaskBox() {
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
  open: () => !!maskDraft && !maskModal.hidden,
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
  if (!d) return;
  for (const b of maskShapes.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.kind === d.kind);
  }
  const name = d.kind === 'custom' && d.src ? d.src.split(/[\\/]/).pop() : '';
  maskFileName.textContent = name;
  maskFileName.title = d.kind === 'custom' && d.src ? d.src : '';
  maskFileName.hidden = !name;
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
 * matte.
 */
async function pickMaskImage() {
  const id = maskLayerId;
  const picked = await window.lwclipper.openMaskImage();
  if (maskLayerId !== id || !maskDraft || !picked || !picked.ok) return;
  let file;
  try {
    file = await readMaskFile(picked.path);
  } catch {
    if (maskLayerId === id) setStatus('That picture could not be read as a mask.');
    return;
  }
  if (maskLayerId !== id || !maskDraft) return;
  const props = { kind: 'custom', src: picked.path, by: file.transparent ? 'alpha' : 'luma', aspect: file.aspect };
  maskFailed.delete(props.src + '|' + props.by);
  changeMask(refitMask(props));
  loadMaskPicture(timelineModel.maskOf({ ...maskDraft })).then(() => {
    if (maskLayerId === id) {
      maskPreviewKey = '';
      paintMaskStage();
    }
  }, () => {});
}

for (const b of maskShapes.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!maskDraft) return;
    if (b.dataset.kind === 'custom') {
      pickMaskImage();
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

// ---- Accept, and Remove Mask ----

maskAcceptBtn.addEventListener('click', () => {
  if (!maskDraft) return;
  const id = maskLayerId;
  const layer = timelineModel.layerById(layers, id);
  const mask = maskOfDraft(maskDraft);
  const opened = JSON.parse(maskOpened);
  const changed = JSON.stringify(maskDraft) !== maskOpened;
  const first = maskFirst;
  const k = maskKeyframe;
  const draft = maskDraft;
  closeMask();
  if (!layer) return;
  if (first || !layer.mask) {
    setLayers(timelineModel.setMask(layers, id, mask));
    commitHistory();
    return;
  }
  if (!changed) return;
  if (!k) {
    setLayers(timelineModel.setMask(layers, id, mask));
    commitHistory();
    return;
  }
  // On a keyframe: the box and the soft edge to it when they moved, made here
  // if it is new; the rest to the layer, its own box and soft edge kept.
  let next = timelineModel.setMask(layers, id, { ...mask, box: layer.mask.box, soft: layer.mask.soft });
  const moved = JSON.stringify([draft.box, draft.soft]) !== JSON.stringify([opened.box, opened.soft]);
  if (moved) {
    const live = k.id ? timelineModel.keyframesFor(layer).find((o) => o.id === k.id) : null;
    const keyId = k.id || newKeyframeId();
    next = timelineModel.putKeyframe(next, id, { ...k, ...(live || {}), mask: { box: mask.box, soft: mask.soft }, id: keyId });
    setLayers(next);
    selectKeyframe(id, keyId);
  } else {
    setLayers(next);
  }
  commitHistory();
});

maskCancelBtn.addEventListener('click', cancelMask);

bindPopup(maskModal, cancelMask);

/** Remove Mask on the right click: one step, and the window on it closed. */
function removeMaskFrom(layerId) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || !layer.mask || busy) return;
  const run = () => {
    setLayers(timelineModel.removeMask(layers, layerId));
    commitHistory();
    return true;
  };
  confirmPopoutConflict([maskWindowOn(layerId) && maskWindowConflict()], run);
}
