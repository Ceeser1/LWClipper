'use strict';

// The crop popup: one layer's crop, its zoom and pan, and its preview.

// ---- crop ----

// V2.7. The even step and the smallest box now live in src/geometry.js beside
// resizeEdge, which is the arithmetic they exist for, and are aliased back here
// so every use site below is spelled the way it always was. CROP_MIRROR_STEP
// went with them and has no reader left on this side.
const CROP_STEP = layerGeometry.CROP_STEP;
const CROP_MIN = layerGeometry.CROP_MIN;

// The frame fills 90% of the popup, which is itself 80% of the window. A tall
// source would run off the bottom at that width, so the height is capped and
// the width follows it back down rather than the popup growing a scrollbar.
const CROP_FRAME_SHARE = 0.9;
const CROP_HEIGHT_SHARE = 0.48;

// Zoom tightens the crop rather than only magnifying it: the box keeps its
// place on the frame while the picture grows underneath, so at 200% it covers
// half as many source pixels each way and the boxes on the three preview frames
// shrink to match. The shape is kept, since both axes divide by the same zoom.
const CROP_ZOOM_MIN = 1;
const CROP_ZOOM_MAX = 4;

// Every arrow sits the same distance outside the frame, which is what the one
// gap is for. CROP_ARROW_SHORT is how much room each of the side ones needs
// beside the frame, and caps how wide the frame may be so a narrow popup cannot
// push one out past its edge.
const CROP_ARROW_SHORT = 19;
const CROP_ARROW_GAP = 6;

// V2.1, 21e. How far past the picture the frame may be dragged, as a multiple
// of the source on each axis. Four rather than a rounder number because of what
// the shapes ask for: turning a 16:9 clip into a 9:16 frame wants the height to
// reach 16/9 of the width, which on a 1280x720 source is 2276 against 720, a
// little over three. Four covers that with room over, and still leaves the
// picture a quarter of the stage to be looked at in.
const CROP_OUTER = 4;

const CROP_PRESETS = [
  { label: 'Original', ratio: null },
  { label: '21:9', ratio: 21 / 9 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '1:1', ratio: 1 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '9:16', ratio: 9 / 16 },
];

// Read from the markup for the same reason as HINT_IDLE and IDLE_STATUS.
const CROP_HINT_IDLE = cropHint.textContent;

// Step 11. Which layer the popup is pointed at, for as long as it is open.
// Held rather than re-read from the selection on every call, so that a row
// selected behind an open popup cannot move the crop onto it halfway through.
let cropLayerId = null;
// The zoom and pan each layer's crop was accepted at, keyed by layer id. Out of
// the model on purpose: it is where the popup was looking from, not part of the
// document, and the project file has no business carrying it.
const cropViews = new Map();

let cropRect = null;          // what a save will cut, in source pixels; null is the whole frame
let cropDraft = null;         // the rectangle the popup is editing
let cropScale = 1;            // display pixels per source pixel inside the popup
let cropBaseScale = 1;        // the same at 100%, which is the whole frame fitted to the stage
let viewZoom = 1;
let viewPanX = 0;             // the source coordinate sitting at the centre of the stage
let viewPanY = 0;
// Where the picture sits inside the frame, in frame pixels. The frame is always
// 16:9 so that the hint above it and the arrows around it never move; a picture
// of another shape sits centred in it with the frame's own grey either side of
// it or above and below. Everything that maps source pixels onto the frame goes
// through this rather than through the frame itself.
let cropPicture = { left: 0, top: 0, w: 0, h: 0 };
let cropAnchor = null;        // where the box sits on the picture, in fractions of it
let cropView = null;          // the zoom and pan a crop was accepted at
let cropActivePreset = null;
// V2.1, 21e-3. The ratio that preset names, kept beside the button because the
// button is a button and this is the number. Null for Original, which names no
// ratio of its own, and null once a drag has cleared the preset.
let cropActiveRatio = null;

/**
 * A preset is no longer what set this box, whatever set it instead: a drag, a
 * pan, the zoom, or the popup opening on a crop that was accepted earlier.
 *
 * One function rather than the two lines it replaces in five places. 21e-3 gave
 * the lit button a second thing to carry, its ratio, and five copies of "clear
 * the button" would have been five chances for one of them to forget.
 */
function clearActivePreset() {
  cropActivePreset = null;
  cropActiveRatio = null;
  markActivePreset();
}

const evenDown = (v) => Math.floor(v / 2) * 2;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * The frame a layer's crop is measured in: the probe's coded dimensions when
 * the file was probed, the decoder's intrinsic size when it was not.
 *
 * The probe wins for the same reason it does in simple mode, and it has to be
 * the same number here, in the filmstrip and in the encoder, or one crop would
 * mean three different rectangles.
 */
function layerSource(layer) {
  if (!layer) return null;
  if (layer.sourceWidth > 0 && layer.sourceHeight > 0) {
    return { width: layer.sourceWidth, height: layer.sourceHeight };
  }
  const entry = decoders.get(layer.id);
  if (entry && entry.width > 0 && entry.height > 0) {
    return { width: entry.width, height: entry.height };
  }
  return null;
}

/**
 * The layer the popup works on: whatever it was opened for while it is open,
 * and the selected video layer otherwise. Null in simple mode, where the
 * subject is the single media file and there is nothing to choose.
 */
function cropTargetLayer() {
  if (!timelineDriving()) return null;
  if (cropLayerId) return timelineModel.layerById(layers, cropLayerId);
  const l = selectedLayerId ? timelineModel.layerById(layers, selectedLayerId) : null;
  return l && l.type === 'video' ? l : null;
}

/**
 * The accepted crop, and where it is kept.
 *
 * Two storage places behind one pair of accessors: simple mode's single
 * rectangle, and the subject layer's own. Everything between here and the
 * popup's grips is written against "a rectangle in a source frame" and does not
 * need to know which of the two it is editing.
 */
function currentCrop() {
  if (timelineDriving()) {
    const l = cropTargetLayer();
    return l ? l.crop : null;
  }
  return cropRect;
}

function setCurrentCrop(rect, view) {
  if (timelineDriving()) {
    if (!cropLayerId) return;
    if (view) cropViews.set(cropLayerId, view);
    else cropViews.delete(cropLayerId);
    // Through setLayers, because a crop changes the picture: the preview and
    // both trim frames are composited through placeLayer and are now pictures
    // of the wrong rectangle.
    setLayers(timelineModel.setLayer(layers, cropLayerId, { crop: rect }));
    return;
  }
  cropRect = rect;
  cropView = view || null;
}

function currentCropView() {
  if (!timelineDriving()) return cropView;
  const l = cropTargetLayer();
  return l ? (cropViews.get(l.id) || null) : null;
}

// ffprobe's numbers are the coded dimensions ffmpeg's crop filter works in, so
// they win. The element's own are the fallback for anything that reached the
// app without a usable probe behind it.
function sourceSize() {
  // Advanced editing crops one layer, so the frame to crop out of is that
  // layer's. Same shape, same units, and everything downstream is unchanged.
  if (timelineDriving()) {
    const source = layerSource(cropTargetLayer());
    if (!source) return null;
    if (source.width < CROP_MIN || source.height < CROP_MIN) return null;
    return { w: evenDown(source.width), h: evenDown(source.height) };
  }
  const w = Math.floor((media && media.width) || previewVideo.videoWidth || 0);
  const h = Math.floor((media && media.height) || previewVideo.videoHeight || 0);
  if (w < CROP_MIN || h < CROP_MIN) return null;
  return { w: evenDown(w), h: evenDown(h) };
}

function canCrop() {
  if (timelineDriving()) return !!sourceSize();
  return !!(media && !media.isAudio && sourceSize());
}

function fullRect(size) {
  return { x: 0, y: 0, width: size.w, height: size.h };
}

/**
 * The shape a Shift and Ctrl drag holds on to.
 *
 * The lit preset if one is lit, and the box's own shape if none is. Original
 * lights a button without naming a ratio, and the two answers agree there
 * anyway: Original is the picture, so the box's shape is the picture's.
 *
 * Read at the press rather than during the drag. The first move clears the
 * preset, because a drag is no longer whatever a preset set, so by the second
 * move there would be nothing left to read.
 */
function cropLockRatio() {
  if (cropActiveRatio > 0) return cropActiveRatio;
  if (!cropDraft || cropDraft.height < 1) return null;
  return cropDraft.width / cropDraft.height;
}

/**
 * Whether the frame may be dragged out past the picture.
 *
 * Simple editing only, settled with the user on 2026-09-20. In advanced editing
 * the Render Position tab is what puts a picture somewhere in a frame, and a
 * layer whose own source had been padded would be a second answer to that same
 * question, which the two would then have to be kept agreeing about. In simple
 * editing there is no second answer: the crop is the only thing that decides
 * what shape the output is.
 */
function cropExtendable() {
  return !timelineDriving();
}

/**
 * Everything the stage has to show: the picture, and the frame the crop
 * describes. The same rectangle until a drag takes the frame outside the
 * picture, which is what makes all of this invisible to a crop that stays in.
 */
function cropOuter(size) {
  if (!cropDraft || !cropExtendable()) return { x: 0, y: 0, w: size.w, h: size.h };
  const x = Math.min(0, cropDraft.x);
  const y = Math.min(0, cropDraft.y);
  return {
    x,
    y,
    w: Math.max(size.w, cropDraft.x + cropDraft.width) - x,
    h: Math.max(size.h, cropDraft.y + cropDraft.height) - y,
  };
}

/**
 * How far out a drag may go, which is a fixed allowance and not the box above.
 * The box above grows with the frame, so holding the frame to it would be
 * holding it to itself and there would be no limit at all.
 */
function cropLimit(size) {
  if (!cropExtendable()) return { x: 0, y: 0, w: size.w, h: size.h };
  const grow = (CROP_OUTER - 1) / 2;
  return {
    x: -evenDown(size.w * grow),
    y: -evenDown(size.h * grow),
    w: evenDown(size.w * CROP_OUTER),
    h: evenDown(size.h * CROP_OUTER),
  };
}

/**
 * The part of the picture a view window covers, in source pixels. The whole of
 * the window until the frame reaches outside the picture and the two stop being
 * the same rectangle.
 */
function pictureOnStage(size, view) {
  const x = Math.max(0, view.x);
  const y = Math.max(0, view.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(size.w, view.x + view.w) - x),
    h: Math.max(0, Math.min(size.h, view.y + view.h) - y),
  };
}

// V2.1, 21e. Exactly the source's size, not merely as large as it. The rect may
// reach outside the picture now, and a frame larger than the source is the one
// thing 21e exists to say, so reading it as "nothing to crop" would throw it
// away on the way to the file. Same correction as backend.js cropFilter.
function isFullFrame(rect, size) {
  return rect.x === 0 && rect.y === 0 && rect.width === size.w && rect.height === size.h;
}

// The largest rectangle of that shape the frame can hold, sat in the middle of
// it. Whichever dimension runs out first is the one that fixes the size.
function ratioRect(size, ratio) {
  let w = size.w;
  let h = evenDown(Math.round(w / ratio));
  if (h > size.h) {
    h = size.h;
    w = evenDown(Math.round(h * ratio));
  }
  w = clamp(w, CROP_MIN, size.w);
  h = clamp(h, CROP_MIN, size.h);
  return { x: evenDown((size.w - w) / 2), y: evenDown((size.h - h) / 2), width: w, height: h };
}

// object-fit: contain letterboxes the picture inside its box, so the overlay
// has to be placed against the picture rather than against the element.
function pictureBox(stage, size) {
  const bw = stage.clientWidth;
  const bh = stage.clientHeight;
  if (!bw || !bh) return null;
  const scale = Math.min(bw / size.w, bh / size.h);
  return { left: (bw - size.w * scale) / 2, top: (bh - size.h * scale) / 2, scale };
}

const CROP_OVERLAYS = [
  [() => previewStage, () => previewCropBox],
  [() => startFrameStage, () => startCropBox],
  [() => endFrameStage, () => endCropBox],
];

// The white box over all three frames, showing what a save will keep. Sized
// from the picture every time rather than cached, since the frames shrink and
// grow with the window.
function updateCropOverlays() {
  // Nothing to outline in advanced editing. All three frames there are drawn
  // through placeLayer, so the crop is already composited into the picture and
  // a box saying what will be kept would be drawn around a picture that is
  // nothing but the kept part.
  const size = (!timelineDriving() && cropRect) ? sourceSize() : null;
  for (const [stageOf, boxOf] of CROP_OVERLAYS) {
    const box = boxOf();
    const pic = size ? pictureBox(stageOf(), size) : null;
    if (!pic) {
      box.hidden = true;
      continue;
    }
    box.style.left = (pic.left + cropRect.x * pic.scale) + 'px';
    box.style.top = (pic.top + cropRect.y * pic.scale) + 'px';
    box.style.width = (cropRect.width * pic.scale) + 'px';
    box.style.height = (cropRect.height * pic.scale) + 'px';
    box.hidden = false;
  }
  updateRenderResolution();
  fitWindow();
}

/**
 * What the save will actually write: the crop when there is one, the source's
 * own coded dimensions otherwise. Those are ffprobe's numbers, which are the
 * ones ffmpeg's crop filter works in, so they are what the output really is.
 * Nothing to say when the output has no picture in it.
 */
function updateRenderResolution() {
  if (timelineDriving()) {
    // The project frame, which is what every layer is fitted into and what the
    // encoder writes. A per-layer crop deliberately does not change it: it
    // changes what that layer shows, not what size the output is.
    const showing = videoHeadShowing();
    // The row around it, which nothing else in this mode owns: updateVideoUi
    // answers for the media file and there is none here.
    videoHead.hidden = !showing;
    renderResolution.hidden = !showing;
    if (!showing) {
      renderResolutionText.textContent = '';
      return;
    }
    // V2.8. Text rather than boxes, at the user's word: "The main window should
    // show text as info, not editboxes. The editboxes only inside the Crop
    // Render." So this line is a readout in both modes now, and the frame is
    // typed in the window that exists to decide it.
    const frame = projectFrame();
    renderResolutionText.textContent = t('Render Resolution: {w} x {h}',
      { w: frame.width, h: frame.height });
    return;
  }
  const size = sourceSize();
  const showing = !!media && !outputIsAudio() && !!size;
  renderResolution.hidden = !showing;
  if (!showing) return;
  const w = cropRect ? cropRect.width : size.w;
  const h = cropRect ? cropRect.height : size.h;
  renderResolutionText.textContent = t('Render Resolution: {w} x {h}', { w, h })
    + (cropRect ? ' ' + t('(cropped)') : '');
}

function updateCropBtn() {
  // No picture in the output, nothing to crop out of it.
  cropBtn.hidden = outputIsAudio();
  // V2.7. In advanced editing this button stopped being a crop of one layer and
  // became the output frame itself, so it is live whenever there is a frame to
  // reshape rather than only when a video row is selected. The per-layer crop is
  // reached from the mark on the clip, which is where it has been since
  // 2026-09-23 and which the 21a3 probe checks.
  const frame = timelineDriving();
  // Two calls rather than one with a ternary inside it, because
  // check-locales.js reads t('...') literally and cannot see a key that
  // is chosen at run time. It has missed strings that way before.
  cropBtn.textContent = frame ? t('Crop Render') : t('Crop');
  cropBtn.disabled = busy || (frame ? !canRenderCrop() : !canCrop());
  // The green only ever meant "there is a crop in force", and the render frame
  // is not a crop that can be in force or not.
  cropBtn.classList.toggle('btn--active', !frame && currentCrop() !== null);
  // In advanced editing one button used to stand for however many video layers
  // there were, so it said which one it would open on. It opens on the frame
  // now, and the frame needs no naming.
  const target = frame ? null : cropTargetLayer();
  cropBtn.title = target
    ? t('Crop {name}', { name: layerLabel(target.type, layerOrdinal(target)) })
    : '';
}

function sizeCropStage(size) {
  // The frame's own wrapper is only as wide as the popup's content, so the
  // share is taken from the panel rather than from the padding box around it.
  const frame = cropStage.parentElement;
  const panel = frame.parentElement;
  // The side arrows may hang into the popup's own padding, which is what lets
  // the frame keep its full share: at that share the frame leaves only about
  // 20px beside it, and an arrow plus its gap wants a little more than that.
  // The cap is only here so a freakishly narrow popup cannot push one out past
  // the edge and raise a scrollbar; in practice it never binds.
  const padding = parseFloat(getComputedStyle(panel).paddingLeft) || 0;
  const spare = Math.max(0, CROP_ARROW_SHORT + CROP_ARROW_GAP - padding + 2);
  const forArrows = frame.clientWidth - 2 * spare;
  // Always 16:9, whatever shape the picture is. A portrait clip used to make
  // the frame narrow and tall, which moved the arrows and the hint with it.
  let w = Math.min(Math.round(panel.clientWidth * CROP_FRAME_SHARE), forArrows);
  let h = Math.round(w * 9 / 16);
  const maxH = Math.round(window.innerHeight * CROP_HEIGHT_SHARE);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * 16 / 9);
  }
  cropStage.style.width = w + 'px';
  cropStage.style.height = h + 'px';

  // What the picture is drawn at with the zoom at 100%: fitted inside the
  // frame, which is where the bars come from. Where it sits and how much of the
  // frame it takes up is worked out per zoom in applyView, since zooming in
  // grows the picture and eats into those bars.
  fitCropScale(size);
  // Half the frame plus the gap, measured from the middle, which is where the
  // stage is centred. Written here because the stage's size is only known here.
  // The same gap on all four sides, so each arrow stands off its own edge by
  // the same amount whichever way round the frame is.
  const outX = `calc(50% + ${w / 2 + CROP_ARROW_GAP}px)`;
  const outY = `calc(50% + ${h / 2 + CROP_ARROW_GAP}px)`;
  cropArrowLeft.style.right = outX;
  cropArrowRight.style.left = outX;
  cropArrowUp.style.bottom = outY;
  cropArrowDown.style.top = outY;
  // Anchored to the same edge as the upper arrow and given its height, so the
  // two sit level however tall the arrows are, and lined up with the frame's
  // left edge rather than the popup's.
  cropPanHint.style.bottom = outY;
  cropPanHint.style.height = CROP_ARROW_SHORT + 'px';
  cropPanHint.style.left = `calc(50% - ${w / 2}px)`;
  applyView(size);
}

/**
 * The scale the stage shows 100% at. Fitted to everything that has to be on the
 * stage rather than to the picture, which since 21e are two different
 * rectangles whenever the frame has been dragged outside the picture.
 *
 * Split out of sizeCropStage because a drag changes what has to be shown while
 * the stage itself has not moved.
 */
function fitCropScale(size) {
  const outer = cropOuter(size);
  const fitted = Math.min(
    cropStage.clientWidth / Math.max(2, outer.w),
    cropStage.clientHeight / Math.max(2, outer.h));
  // A stage with no size gives a scale of zero, and a scale of zero is not a
  // small picture: viewWindow divides by it, so the window comes out infinite,
  // viewBounds subtracts one infinity from another and every number downstream
  // is NaN. The crop then reads "NaN x NaN" and stays that way, because the
  // anchor captured from it is NaN too and every later zoom is measured against
  // it. Keeping the last good scale is the difference between a stage that is
  // briefly the wrong size and one that can never be used again.
  //
  // It really can be zero. sizeCropStage measures the panel around the stage,
  // and that panel is hidden whenever the Render Position tab is up.
  if (fitted > 0 && Number.isFinite(fitted)) cropBaseScale = fitted;
}

/**
 * The frame has just grown or shrunk past the picture, so what the stage shows
 * has changed and everything drawn at a scale has to be drawn again. Kept out
 * of applyView, which the zoom and the pan also call and which must not re-fit
 * the stage under them.
 */
function refitCropView(size) {
  // Done every time rather than only when the scale comes out different. The
  // scale is not the only thing that goes stale: the pan is clamped inside what
  // the stage holds, and a frame can change that box while leaving the scale
  // alone, which on a portrait picture is simply widening it. A drawImage of
  // one video frame is what a pan costs already.
  fitCropScale(size);
  applyView(size);
  paintCropFrame();
  updateCropArrows();
}

// How much of the picture the frame shows. The frame holds the whole of it at
// 100%, so at any zoom it holds exactly that much divided by the zoom.
//
// Taken from the picture rather than from the frame's own pixel size, which is
// a rounded integer: measuring it that way left the window a fraction short of
// the whole picture at 100%, which was enough, once rounded to an even number,
// to lose two pixels off Original and to leave half a pixel of slack in the pan
// for an arrow to light up on.
function viewSpan(size) {
  const outer = cropOuter(size);
  return {
    w: Math.min(outer.w, cropStage.clientWidth / cropScale),
    h: Math.min(outer.h, cropStage.clientHeight / cropScale),
  };
}

// Where the picture sits on the frame at the current zoom, and how much of it
// it takes up. At 100% it is the picture fitted inside the frame, which leaves
// the bars; zooming draws it larger, so the part that fits grows and the bars
// shrink until at enough zoom there are none and the frame is filled.
//
// Nothing here is rounded. The span above divides by the same scale this
// multiplies by, and the pair have to come back to exactly the picture's size
// at 100%, or the whole frame stops counting as the whole picture.
function placePicture(size) {
  const frameW = cropStage.clientWidth;
  const frameH = cropStage.clientHeight;
  // Taken from the span rather than worked out again, so the two cannot
  // disagree: this is exactly the visible part of the picture drawn at scale.
  const span = viewSpan(size);
  const w = span.w * cropScale;
  const h = span.h * cropScale;
  cropPicture = { left: (frameW - w) / 2, top: (frameH - h) / 2, w, h };
  // 21e. The canvas covers the part of the picture that is on the stage, which
  // is the whole of the visible region until the frame is dragged outside the
  // picture. What is left over around it is the stage's own background, which
  // is what the bars have always been.
  const view = viewWindow(size);
  const seen = pictureOnStage(size, view);
  cropCanvas.style.left = (cropPicture.left + (seen.x - view.x) * cropScale) + 'px';
  cropCanvas.style.top = (cropPicture.top + (seen.y - view.y) * cropScale) + 'px';
  cropCanvas.style.width = (seen.w * cropScale) + 'px';
  cropCanvas.style.height = (seen.h * cropScale) + 'px';
}

// Recomputes the scale the zoom implies and keeps the pan inside the picture,
// so no drag can ever pull empty space into the frame. At 100% the visible
// window is the whole picture, which pins the pan to the middle and leaves
// nothing to drag, which is why panning only exists above 100%.
function applyView(size) {
  cropScale = cropBaseScale * viewZoom;
  const span = viewSpan(size);
  // Held inside everything the stage shows rather than inside the picture. With
  // the frame dragged out past it, the room above and to the left of the
  // picture is somewhere the view is allowed to be. Identical while the two
  // rectangles are the same, which is every crop that stays inside.
  const outer = cropOuter(size);
  viewPanX = clamp(viewPanX, outer.x + span.w / 2, outer.x + outer.w - span.w / 2);
  viewPanY = clamp(viewPanY, outer.y + span.h / 2, outer.y + outer.h - span.h / 2);
  // After the clamp, not before it. The picture used to be placed from the span
  // alone, which the pan does not enter into, so the order did not matter and
  // the pan was settled afterwards. Since 21e it is placed from the view as
  // well, and placing it first drew it from a pan belonging to the frame the
  // stage held a moment ago: 11px of the picture missing after a preset.
  placePicture(size);
}

// The part of the source currently under the frame, in source pixels.
function viewWindow(size) {
  const span = viewSpan(size);
  return { x: viewPanX - span.w / 2, y: viewPanY - span.h / 2, w: span.w, h: span.h };
}

// Where the box sits on the frame right now. Zoom and pan both work by holding
// this fixed and letting the source rectangle underneath it change, which is
// what makes zooming tighten the crop rather than only magnify it.
function boxScreenRect(size) {
  const view = viewWindow(size);
  return {
    left: cropPicture.left + (cropDraft.x - view.x) * cropScale,
    top: cropPicture.top + (cropDraft.y - view.y) * cropScale,
    width: cropDraft.width * cropScale,
    height: cropDraft.height * cropScale,
  };
}

// The box's place on the frame, kept as fractions of it, and written only when
// something actually edits the box: a bar, a corner, a move, a preset, or the
// popup opening. Zoom and pan read it and never write it.
//
// That is load-bearing rather than tidiness. Deriving the source rectangle
// rounds it to an even number, and if the rounded rectangle were then used as
// the starting point for the next step of the slider, the loss would feed into
// itself: measured at 23.6px of a 707px box shrinking away between 100% and
// 400%, which looked exactly like zooming resizing the box.
// Sets the anchor from a rectangle on the frame directly. Anything that knows
// where it meant to put the box should use this rather than reading the box
// back afterwards: the reading has been rounded to an even number and held
// inside the frame, and folding that back into the anchor makes the loss
// permanent. A preset at 250% came back from 100% two pixels short that way.
function setCropAnchorFrom(onFrame) {
  const w = Math.max(1, cropPicture.w);
  const h = Math.max(1, cropPicture.h);
  cropAnchor = {
    left: (onFrame.left - cropPicture.left) / w,
    top: (onFrame.top - cropPicture.top) / h,
    width: onFrame.width / w,
    height: onFrame.height / h,
  };
}

function captureCropAnchor(size) {
  setCropAnchorFrom(boxScreenRect(size));
}

function anchorScreenRect() {
  return {
    left: cropPicture.left + cropAnchor.left * cropPicture.w,
    top: cropPicture.top + cropAnchor.top * cropPicture.h,
    width: cropAnchor.width * cropPicture.w,
    height: cropAnchor.height * cropPicture.h,
  };
}

// The reverse: what a rectangle on the frame covers in source pixels, held to
// the same even numbers and the same bounds a drag is held to.
//
// Nearest even rather than rounding down, because rounding down always errs the
// same way: it would shave the box by up to two source pixels every time the
// view changed, which is a visible bias at a zoom where a source pixel is worth
// more than one on screen. The nearest leaves an error of at most one either
// way, and it is quantisation rather than drift, since the box's place on the
// frame is held separately in cropAnchor and never rewritten from this.
// The parameter is deliberately not called `screen`: that is a global, so a use
// of it that loses its local silently reads the display instead of failing, and
// window.screen.left does not exist in Chromium, which turns the whole sum into
// a quiet NaN rather than an error.
function sourceRectFromScreen(onFrame, size) {
  const view = viewWindow(size);
  // Held to what is on the frame, the same bounds a drag is held to. The crop
  // has to land on an even number and the edge of the visible window does not,
  // so rounding to the nearest one could otherwise leave the box a pixel over
  // the edge of the picture: 1.3px of it showing past the frame at 400%.
  const edge = viewBounds(size);
  const evenNear = (v) => 2 * Math.round(v / 2);
  // Sized first against how much is on the frame, then placed inside it. The
  // other order shaves a pixel or two off the crop whenever the placing runs up
  // against the far edge, which showed as the size flickering during a pan.
  const width = clamp(evenNear(onFrame.width / cropScale),
    CROP_MIN, Math.max(CROP_MIN, edge.maxX - edge.minX));
  const height = clamp(evenNear(onFrame.height / cropScale),
    CROP_MIN, Math.max(CROP_MIN, edge.maxY - edge.minY));
  const x = clamp(evenNear(view.x + (onFrame.left - cropPicture.left) / cropScale),
    edge.minX, Math.max(edge.minX, edge.maxX - width));
  const y = clamp(evenNear(view.y + (onFrame.top - cropPicture.top) / cropScale),
    edge.minY, Math.max(edge.minY, edge.maxY - height));
  return { x, y, width, height };
}

// An arrow on each side the picture runs past, so it is clear there is more
// that way. At 100% the whole frame is visible and none of them show.
// Always on show: grey while there is nothing that way, green while there are
// pixels left to reach. A green one can be clicked to nudge the picture along
// by a couple of pixels, for the last bit of placement a drag is too coarse for.
const CROP_ARROWS = [
  ['up', () => cropArrowUp, 0, -1],
  ['down', () => cropArrowDown, 0, 1],
  ['left', () => cropArrowLeft, -1, 0],
  ['right', () => cropArrowRight, 1, 0],
];

const ARROW_NUDGE = 2;        // source pixels per click, and per tick while held
const ARROW_HOLD_DELAY = 250; // how long a press has to be held before it repeats
const ARROW_HOLD_EVERY = 25;  // how often it moves once it is repeating

function cropOverflow(size) {
  const v = viewWindow(size);
  // 21e. Against everything the stage has to hold rather than against the
  // picture: with the frame dragged out, the room around the picture is part of
  // what there is to pan to, and an arrow that ignored it would go grey while
  // there was still frame to reach.
  const outer = cropOuter(size);
  const slack = 0.5;   // a rounded pixel is not content worth pointing at
  return {
    up: v.y > outer.y + slack,
    left: v.x > outer.x + slack,
    down: v.y + v.h < outer.y + outer.h - slack,
    right: v.x + v.w < outer.x + outer.w - slack,
  };
}

function updateCropArrows() {
  const size = cropModal.hidden ? null : sourceSize();
  const over = size ? cropOverflow(size) : null;
  let any = false;
  for (const [key, arrowOf] of CROP_ARROWS) {
    const live = !!over && over[key];
    arrowOf().dataset.live = String(live);
    any = any || live;
  }
  // Nothing to click, nothing to say about clicking it.
  cropPanHint.hidden = !any;
}

// Moves the frame over the picture, keeping the box where it sits on the frame,
// which is the same thing a drag on the picture does.
function nudgeCropView(dx, dy) {
  const size = sourceSize();
  if (!size || !cropAnchor) return;
  viewPanX += dx;
  viewPanY += dy;
  applyView(size);
  cropDraft = sourceRectFromScreen(anchorScreenRect(), size);
  clearActivePreset();
  paintCropFrame();
  placeCropDraft();
  updateCropArrows();
}

// A grey one points at nothing, so it does nothing. Checked again on every tick
// of a held press, since the picture can run out mid-hold.
function arrowLive(key) {
  const size = cropModal.hidden ? null : sourceSize();
  return !!size && cropOverflow(size)[key];
}

for (const [key, arrowOf, dx, dy] of CROP_ARROWS) {
  const arrow = arrowOf();
  const nudge = () => nudgeCropView(dx * ARROW_NUDGE, dy * ARROW_NUDGE);
  let holdTimer = null;
  let repeatTimer = null;
  let repeated = false;

  // Listened for on the window rather than the arrow: releasing the button
  // somewhere else has to stop it too, and the arrow itself stops taking
  // pointer events the moment it goes grey, which a hold can cause.
  function stopHold() {
    clearTimeout(holdTimer);
    clearInterval(repeatTimer);
    holdTimer = null;
    repeatTimer = null;
    window.removeEventListener('pointerup', stopHold);
    window.removeEventListener('pointercancel', stopHold);
    window.removeEventListener('blur', stopHold);
  }

  arrow.addEventListener('pointerdown', (evt) => {
    if (!arrowLive(key)) return;
    evt.preventDefault();
    repeated = false;
    holdTimer = setTimeout(() => {
      repeated = true;
      // Once immediately, so the wait is the delay rather than the delay plus
      // an interval, then at the repeat rate for as long as it is held.
      if (!arrowLive(key)) return;
      nudge();
      repeatTimer = setInterval(() => {
        if (!arrowLive(key)) stopHold();
        else nudge();
      }, ARROW_HOLD_EVERY);
    }, ARROW_HOLD_DELAY);
    window.addEventListener('pointerup', stopHold);
    window.addEventListener('pointercancel', stopHold);
    window.addEventListener('blur', stopHold);
  });

  arrow.addEventListener('click', () => {
    // The click that ends a hold must not add a step on top of the ones the
    // hold already made. A press too short to repeat still gets its single one.
    if (repeated) {
      repeated = false;
      return;
    }
    if (arrowLive(key)) nudge();
  });
}

/**
 * Which element the popup copies its picture out of.
 *
 * Advanced editing has no single preview to take it from: the picture on screen
 * is a composite of every covering layer, and cropping one of them against all
 * of them would be cropping the wrong thing. So it reads that layer's own
 * decoder, which is already open on the file and already parked on a frame.
 */
function cropFrameSource() {
  const layer = cropTargetLayer();
  if (layer) {
    const entry = decoders.get(layer.id);
    if (!entry) return null;
    // A still is ready when it has a size, which is the same claim readyState
    // makes for a video: there is a frame to copy.
    if (entry.still) return entry.width ? entry.el : null;
    return entry.el.readyState >= 2 ? entry.el : null;
  }
  // HAVE_CURRENT_DATA is the point at which there is a frame to copy at all.
  // Below it the start frame is the next best thing: it preloads and is already
  // parked on the cut, where the preview may not have decoded anything yet.
  if (previewVideo.readyState >= 2) return previewVideo;
  return startFrameVideo.readyState >= 2 ? startFrameVideo : null;
}

/**
 * Give the layer being cropped a frame worth cropping against.
 *
 * Its decoder is parked on the playhead whenever the layer covers it, which is
 * the picture the user is looking at and the right one. When the playhead is
 * somewhere else the decoder is wherever it last landed, so it is sent to the
 * layer's own first frame instead. Nothing on screen moves: a layer the
 * playhead has left is not in the composite either way.
 */
function seedCropFrame(layer) {
  const entry = decoders.get(layer.id);
  // A still is already on the only frame it has.
  if (!entry || entry.still) return;
  if (layer.enabled && timelineModel.covers(layer, compositeAt)) return;
  const onSeeked = () => {
    entry.el.removeEventListener('seeked', onSeeked);
    if (!cropModal.hidden) paintCropFrame();
  };
  entry.el.addEventListener('seeked', onSeeked);
  entry.el.currentTime = layer.sourceIn;
}

// Whatever the preview is showing, painted once into the canvas. A canvas
// rather than a second <video>: it holds no file open, and it cannot drift off
// the position the preview is parked at while the popup is being used.
function paintCropFrame() {
  // The canvas covers the picture, not the whole frame, so the bars either side
  // of it are simply the frame showing through and nothing has to draw them.
  // Since 21e that is the part of the picture on the stage rather than the
  // whole of the visible region: the two part company once the frame is out.
  const size = sourceSize();
  if (!size) return;
  const view = viewWindow(size);
  const shown = pictureOnStage(size, view);
  const cssW = shown.w * cropScale;
  const cssH = shown.h * cropScale;
  if (!cssW || !cssH) return;
  const dpr = window.devicePixelRatio || 1;
  cropCanvas.width = Math.round(cssW * dpr);
  cropCanvas.height = Math.round(cssH * dpr);
  const ctx = cropCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#121214';
  ctx.fillRect(0, 0, cssW, cssH);
  const src = cropFrameSource();
  // Nothing is ever read back out of this canvas, only shown, so the file://
  // source tainting it costs nothing.
  if (!src) return;

  // Only the visible window is drawn, rather than the whole picture with the
  // rest hanging over the edges. The element's own intrinsic size is what
  // drawImage measures its source rectangle in, and it need not match the coded
  // size ffprobe reported, so the window is carried across as a fraction.
  const iw = src.videoWidth || src.naturalWidth || size.w;
  const ih = src.videoHeight || src.naturalHeight || size.h;
  ctx.drawImage(src,
    (shown.x / size.w) * iw, (shown.y / size.h) * ih,
    (shown.w / size.w) * iw, (shown.h / size.h) * ih,
    0, 0, cssW, cssH);
}
