'use strict';

// The crop popup's second tab, Render Position: where a layer sits in the frame.

// ---- V2.1, 21a. The second tab ----
//
// The popup edits two rectangles now: which part of the source to take, which
// is what it has always done, and where that result is placed and scaled inside
// the output frame. Both belong to one layer and are settled by one Accept, so
// they are two tabs of one popup rather than two popups.
//
// Simple editing never sees them. There is no project frame there, the output
// is the source, and a position inside it would mean nothing.

let cropTab = 'frame';

// V2.1, 21a-2. The rectangle the position tab is editing, in project pixels.
// Always concrete while the popup is open, even for a layer that has never been
// placed: it starts as the centre and fit the geometry would have worked out
// anyway, so there is something to drag. What Accept writes is null again when
// it is still that rectangle, which is the same rule the crop tab applies to
// the whole frame. A position that is the default is not a position, and
// writing it down would freeze it against a crop or a project frame that
// changes later.
let placeDraft = null;
let placeDrag = null;
// Whether the user has moved or scaled it. An untouched draft follows the crop
// on the other tab; a touched one is theirs and is left alone.
let placeTouched = false;
/**
 * What the placement actually is: how big, as a percentage of the fit, and
 * where its middle sits in project pixels.
 *
 * The rectangle is worked out from these two rather than being carried and
 * edited, and that is the fix for two things at once.
 *
 * Scaling used to take the draft's own centre, round the new corner, and write
 * that back, so every step lost up to half a pixel and the picture walked:
 * measured on 2026-09-23, a 404x720 placement taken from 100% down to 33% and
 * back to 100% came home three pixels right and two pixels down of where it
 * started. A centre that is never rounded cannot drift.
 *
 * And a placement made against one crop used to keep its old size when the crop
 * changed underneath it, so the Render Position tab showed a 404x720 box for a
 * 552x552 crop. A percentage of the fit follows the crop by construction, which
 * is what the user asked for: the tab should show the change without having to
 * be poked.
 */
let placeCentre = null;
let placeScalePct = 100;

// V2.8 took the ceiling from 400% to 1000% and the floor from 10% to 1%, and
// put the bend between them in geometry beside the rest of the placement sums.
// The slider's own value is a position on that bend now rather than a
// percentage, which is the only reason the two are told apart here.
const PLACE_SCALE_MIN = layerGeometry.PLACE_SCALE_MIN;
const PLACE_SCALE_MAX = layerGeometry.PLACE_SCALE_MAX;

// V2.2. The anchors on the output frame, asked for on 2026-09-23: a ring in
// each corner a few pixels in from the edge, one in the middle, and a click on
// one drops the picture there at whatever size it already is.
//
// One list drives both where a ring is drawn and where the picture lands under
// it, because along each axis they are the same three positions: the near edge,
// the middle, the far edge. The ring is inset from the stage by the same shape
// of sum that insets the picture from the frame, so the ring really is standing
// where the picture will go rather than merely near it.
//
// V2.6 adds the four side centres, at the user's word: "Add more circles to the
// Render Position tab, on each side centered which place the video centered at
// each of the 4 sides." They cost nothing but their four lines, because the
// list was already the only thing that knew how many there were: anchorCentre
// has taken 0.5 on either axis since the middle ring was built, and the drawing,
// the hit test and the snap all read this list rather than counting.
const PLACE_ANCHORS = [
  { key: 'topLeft', ax: 0, ay: 0 },
  { key: 'top', ax: 0.5, ay: 0 },
  { key: 'topRight', ax: 1, ay: 0 },
  { key: 'left', ax: 0, ay: 0.5 },
  { key: 'centre', ax: 0.5, ay: 0.5 },
  { key: 'right', ax: 1, ay: 0.5 },
  { key: 'bottomLeft', ax: 0, ay: 1 },
  { key: 'bottom', ax: 0.5, ay: 1 },
  { key: 'bottomRight', ax: 1, ay: 1 },
];
// V2.6. Nine of them in the space five had, so they are smaller: "make the
// circles a bit smaller". It is the hit radius as well as the drawn one, which
// is why it is here and not only in the stylesheet.
const PLACE_RING_R = 9;
const PLACE_RING_INSET = 10;
// How far the pointer may wander between going down and coming up and still
// have been a click. Past it the press was the start of a drag, and the user
// was plain about which of the two wins: "dragging the image disables
// repositioning".
const PLACE_RING_SLOP = 3;
// The ring the pointer went down on, while it is still allowed to become a
// click. Cleared the moment the pointer leaves that ring or drags the picture.
let placeRingPress = null;
// V2.8 item 8. Which ring the picture is currently stuck to, by name, or null
// for one that was put somewhere by hand. It is the layer's own `anchor` while
// the popup is open: read from it when the popup opens and written back by
// Accept, so a picture put on a corner is still on that corner the next time.
//
// What it does while it is set: the centre is worked out from the anchor and
// the size every time the picture is rebuilt, rather than being held. So the
// scale slider grows the picture about that corner instead of about its middle,
// which is the whole of what was asked for.
let placeAnchor = null;
const placeRingEls = new Map();

const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y
  && a.width === b.width && a.height === b.height;

/**
 * Where this layer lands with no position set.
 *
 * Against the crop being edited rather than the crop on the layer: the two tabs
 * are one popup settled by one Accept, so switching here after changing the
 * crop has to place what that crop is going to produce.
 */
function placeFitRect(layer) {
  const source = layerSource(layer);
  if (!source) return null;
  const placement = layerGeometry.placeLayer({
    source,
    crop: cropDraft,
    project: projectFrame(),
  });
  return placement ? { ...placement.dest } : null;
}

function showCropTab(which) {
  cropTab = which === 'place' ? 'place' : 'frame';
  const place = cropTab === 'place';
  cropTabFrame.classList.toggle('btn--active', !place);
  cropTabPlace.classList.toggle('btn--active', place);
  cropFramePanel.hidden = place;
  placePanel.hidden = !place;
  // The crop tab's own controls go with it. The zoom is a view into the source
  // and the presets are crop ratios: neither has anything to say about where
  // the result lands.
  cropHint.hidden = place;
  cropSize.hidden = place;
  cropZoomRow.hidden = place;
  cropPresets.hidden = place;
  placeHint.hidden = !place;
  placeSize.hidden = !place;
  placeScaleRow.hidden = !place;
  if (!place) {
    // The crop stage is inside a panel that was hidden while the other tab was
    // up, so nothing has been able to measure it: a window resized during the
    // Render Position tab left it at the size it had before. Re-fitting on the
    // way back is what takes that up, and it is also the one moment the stage
    // is certainly visible again.
    const back = sourceSize();
    if (back && !cropModal.hidden) {
      sizeCropStage(back);
      paintCropFrame();
      placeCropDraft();
      captureCropAnchor(back);
      updateCropArrows();
    }
    return;
  }
  // The crop may have changed on the other tab, and the placement is a size
  // relative to it, so it is worked out again rather than carried. Without this
  // the tab shows the shape the crop used to be until something else is edited.
  rebuildPlaceDraft();
  showPlaceScale();
  drawPlaceStage();
}

/**
 * Work the draft out again from the scale and the centre.
 *
 * Called whenever the crop may have moved under it, which is what makes the
 * Render Position tab follow the Video Frame tab instead of showing the shape
 * the crop used to be.
 */
/**
 * Put the held ring's centre back under the picture at the size it is about to
 * be, V2.8 item 8.
 *
 * **Only when the size is actually changing**, which is the scale slider and an
 * accepted crop, and is why this is a condition rather than a line in the
 * rebuild. A picture that is not changing size has nothing to re-stick, and
 * re-sticking it anyway would mean opening the Render Position tab could move
 * the composition by itself, which is a thing no tab should do.
 *
 * That also settles what happens when the project frame changes under an
 * anchored layer: nothing. Item 7 says a frame change keeps every layer's
 * relative size and position rather than re-fitting anything, and a layer that
 * jumped to a corner because it had once been put there would be exactly the
 * re-fitting that item forbids. The ring stays lit and takes hold again the
 * next time the picture is scaled.
 */
function holdPlaceAnchor(fit) {
  const held = placeAnchor && PLACE_ANCHORS.find((a) => a.key === placeAnchor);
  if (!held || !fit || !placeDraft) return;
  const size = placeDraftSize(fit);
  if (size.width === placeDraft.width && size.height === placeDraft.height) return;
  const frame = projectFrame();
  placeCentre = {
    cx: layerGeometry.anchorCentre(held.ax, frame.width, size.width),
    cy: layerGeometry.anchorCentre(held.ay, frame.height, size.height),
  };
}

function rebuildPlaceDraft() {
  const fit = placeFitRect(cropTargetLayer());
  if (!fit) {
    placeDraft = null;
    return;
  }
  if (!placeTouched || !placeCentre) {
    // Untouched follows the crop whole, which is what it always did.
    placeDraft = fit;
    placeCentre = { cx: fit.x + fit.width / 2, cy: fit.y + fit.height / 2 };
    placeScalePct = 100;
    return;
  }
  holdPlaceAnchor(fit);
  const { width, height } = placeDraftSize(fit);
  placeDraft = {
    x: Math.round(placeCentre.cx - width / 2),
    y: Math.round(placeCentre.cy - height / 2),
    width,
    height,
  };
}

/**
 * The size the draft comes out at, for the scale it is set to.
 *
 * Its own function because the snap has to know it before the draft is built:
 * putting a right edge on the frame's right edge means knowing how wide the
 * picture is about to be, and working that out a second way would put the edge
 * a pixel out whenever the two roundings disagreed.
 */
function placeDraftSize(fit) {
  return {
    width: Math.max(2, Math.round(fit.width * placeScalePct / 100)),
    height: Math.max(2, Math.round(fit.height * placeScalePct / 100)),
  };
}

/** The rings, in the stage's own pixels, as centres. */
function placeRings() {
  const w = placeStage.clientWidth;
  const h = placeStage.clientHeight;
  if (!(w > 0) || !(h > 0)) return [];
  // What the ring occupies end to end, so that anchorCentre insets it by the
  // gap plus its own radius at 0 and at 1, and leaves it in the middle at half.
  const span = 2 * (PLACE_RING_INSET + PLACE_RING_R);
  return PLACE_ANCHORS.map((a) => ({
    ...a,
    cx: layerGeometry.anchorCentre(a.ax, w, span),
    cy: layerGeometry.anchorCentre(a.ay, h, span),
  }));
}

/** Put the rings where they belong, making them the first time round. */
function layoutPlaceRings() {
  const on = cropTab === 'place' && !!placeDraft;
  for (const ring of placeRings()) {
    let node = placeRingEls.get(ring.key);
    if (!node) {
      node = document.createElement('div');
      node.className = 'place-ring';
      // After the box, so a ring in a corner the picture reaches is drawn over
      // its outline rather than under it.
      placeStage.appendChild(node);
      placeRingEls.set(ring.key, node);
    }
    node.hidden = !on;
    // V2.8 item 8: "Keep the selected circle highlighted green until it gets
    // dragged or another circle gets clicked." The same green hovering one
    // shows, held rather than following the pointer.
    node.classList.toggle('place-ring--held', on && ring.key === placeAnchor);
    node.style.left = ring.cx + 'px';
    node.style.top = ring.cy + 'px';
  }
}

/** Which ring a point on the stage is inside, if any. */
function ringAt(p) {
  for (const ring of placeRings()) {
    if (Math.hypot(p.x - ring.cx, p.y - ring.cy) <= PLACE_RING_R) return ring;
  }
  return null;
}

/** Drop the picture on one of the five anchors, at the size it already is. */
function snapPlaceTo(key) {
  const anchor = PLACE_ANCHORS.find((a) => a.key === key);
  const fit = placeFitRect(cropTargetLayer());
  if (!anchor || !fit || !placeDraft) return;
  if (!placeCentre) adoptPlaceRect(placeDraft, fit);
  // V2.8 item 8. The picture sticks here from now on, until it is dragged off
  // or another ring is clicked.
  placeAnchor = key;
  const frame = projectFrame();
  const size = placeDraftSize(fit);
  // The centre rather than the corner, because the centre is what a placement
  // is carried as. rebuildPlaceDraft turns it back into the rectangle, so a
  // snapped picture and a dragged one are the same kind of thing afterwards and
  // the scale slider keeps working from where the snap left it.
  placeCentre = {
    cx: layerGeometry.anchorCentre(anchor.ax, frame.width, size.width),
    cy: layerGeometry.anchorCentre(anchor.ay, frame.height, size.height),
  };
  placeTouched = true;
  rebuildPlaceDraft();
  drawPlaceStage();
}

/** Take the scale and the centre from a rectangle that arrived from elsewhere. */
function adoptPlaceRect(rect, fit) {
  if (!rect) {
    placeCentre = null;
    placeScalePct = 100;
    return;
  }
  placeCentre = { cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 };
  placeScalePct = (fit && fit.width)
    ? clamp(Math.round((rect.width / fit.width) * 100), PLACE_SCALE_MIN, PLACE_SCALE_MAX)
    : 100;
}

/** The draft's size as a percentage of the fit, which is what 100% means. */
function showPlaceScale() {
  const percent = clamp(Math.round(placeScalePct), PLACE_SCALE_MIN, PLACE_SCALE_MAX);
  placeScaleSlider.value = String(layerGeometry.sliderFromScale(percent));
  placeScaleValue.textContent = percent + '%';
}

function setPlaceScale(percent) {
  const fit = placeFitRect(cropTargetLayer());
  if (!fit || !placeDraft) return;
  // Around its own centre, so scaling changes how big the picture is and not
  // where it is. Growing from the top left corner would walk it across the
  // frame and make the slider unusable for anything but a full-frame layer.
  //
  // The centre is held rather than taken from the rectangle each time. Taking
  // it from the rectangle means reading back a number that was rounded on the
  // way in, so a slider dragged down and back does not come home.
  if (!placeCentre) adoptPlaceRect(placeDraft, fit);
  placeScalePct = clamp(Math.round(percent), PLACE_SCALE_MIN, PLACE_SCALE_MAX);
  placeTouched = true;
  rebuildPlaceDraft();
  showPlaceScale();
  drawPlaceStage();
}

placeScaleSlider.addEventListener('input',
  () => setPlaceScale(layerGeometry.scaleFromSlider(Number(placeScaleSlider.value))));

/**
 * The stage's picture, in client pixels: where it starts and how big it is.
 *
 * Inside the border rather than around it. The stage has a one pixel border and
 * the whole sheet is border-box, so getBoundingClientRect is two pixels wider
 * than the canvas in it and starts one pixel sooner. The rings are laid out
 * against clientWidth, so a hit test taken off the bounding rectangle is a
 * pixel out from the ring it is testing, and a drag taken off it stretches the
 * picture's travel by those two pixels over the width of the stage.
 */
function placeStageBox() {
  const rect = placeStage.getBoundingClientRect();
  return {
    left: rect.left + placeStage.clientLeft,
    top: rect.top + placeStage.clientTop,
    width: placeStage.clientWidth,
    height: placeStage.clientHeight,
  };
}

/** Where a point on the stage is, in the stage's own pixels. */
function placeStagePointAt(evt) {
  const box = placeStageBox();
  return { x: evt.clientX - box.left, y: evt.clientY - box.top };
}

/** Where a point on the stage is in project pixels. */
function placePointAt(evt) {
  const box = placeStageBox();
  const frame = projectFrame();
  return {
    x: (evt.clientX - box.left) * frame.width / box.width,
    y: (evt.clientY - box.top) * frame.height / box.height,
  };
}

const onPicture = (p) => !!placeDraft && p.x >= placeDraft.x && p.y >= placeDraft.y
  && p.x <= placeDraft.x + placeDraft.width && p.y <= placeDraft.y + placeDraft.height;

// Anywhere on the picture, because the box is moved whole and there is nothing
// on it to grab. Outside it nothing happens, so a click on the grey beside a
// small picture does not teleport it to the pointer.
placeStage.addEventListener('pointerdown', (evt) => {
  if (cropTab !== 'place' || !placeDraft) return;
  // A ring and the picture under it are both live. Pressing a ring over the
  // picture arms the snap and starts the drag, and whichever of the two the
  // pointer then does decides which one happens: hold still and it is a click,
  // move and it is a drag with the snap called off.
  const ring = ringAt(placeStagePointAt(evt));
  if (ring) {
    placeRingPress = { key: ring.key, id: evt.pointerId, x: evt.clientX, y: evt.clientY };
    placeStage.setPointerCapture(evt.pointerId);
    evt.preventDefault();
  }
  const p = placePointAt(evt);
  if (!onPicture(p)) return;
  placeDrag = { dx: p.x - placeDraft.x, dy: p.y - placeDraft.y };
  placeStage.setPointerCapture(evt.pointerId);
  evt.preventDefault();
});

/** Whether the press that armed a snap is still allowed to become one. */
function ringPressHolds(evt) {
  if (!placeRingPress || placeRingPress.id !== evt.pointerId) return false;
  if (Math.hypot(evt.clientX - placeRingPress.x, evt.clientY - placeRingPress.y)
    > PLACE_RING_SLOP) return false;
  const under = ringAt(placeStagePointAt(evt));
  return !!under && under.key === placeRingPress.key;
}

placeStage.addEventListener('pointermove', (evt) => {
  if (cropTab !== 'place') return;
  if (placeRingPress && !ringPressHolds(evt)) placeRingPress = null;
  const p = placePointAt(evt);
  if (!placeDrag) {
    placeStage.style.cursor = onPicture(p) ? 'move' : 'default';
    return;
  }
  placeDraft = {
    ...placeDraft,
    x: Math.round(p.x - placeDrag.dx),
    y: Math.round(p.y - placeDrag.dy),
  };
  // The drag is what decides where the middle is from here on, so it is written
  // unrounded: the rectangle above is what is drawn, this is what it is drawn
  // from, and rounding both would be rounding twice.
  placeCentre = {
    cx: p.x - placeDrag.dx + placeDraft.width / 2,
    cy: p.y - placeDrag.dy + placeDraft.height / 2,
  };
  placeTouched = true;
  // V2.8 item 8. Dragging the picture is how it comes off the ring it was stuck
  // to, which is the same rule the click and the drag already settle between
  // them: "dragging the image disables repositioning".
  placeAnchor = null;
  drawPlaceStage();
});

function endPlaceDrag(evt, released) {
  // Read before the drag is let go, because a snap is only a snap if the press
  // that armed it came up on the same ring without the picture having moved.
  const snap = released && ringPressHolds(evt) ? placeRingPress.key : null;
  placeRingPress = null;
  placeDrag = null;
  if (placeStage.hasPointerCapture(evt.pointerId)) {
    placeStage.releasePointerCapture(evt.pointerId);
  }
  if (snap) snapPlaceTo(snap);
}
placeStage.addEventListener('pointerup', (evt) => endPlaceDrag(evt, true));
// A cancelled pointer is the window taking the gesture away, not a click.
placeStage.addEventListener('pointercancel', (evt) => endPlaceDrag(evt, false));

/**
 * The output frame, sized the way the crop frame is sized.
 *
 * At the project's own aspect rather than at 16:9. The crop frame is always
 * 16:9 so that the arrows around it and the hint above it never move; this one
 * has no arrows and is a picture of the file, so a portrait project has to look
 * portrait.
 */
function sizePlaceStage() {
  const frame = projectFrame();
  const panel = placePanel.parentElement;
  let w = Math.round(panel.clientWidth * CROP_FRAME_SHARE);
  let h = Math.round(w * frame.height / frame.width);
  const maxH = Math.round(window.innerHeight * CROP_HEIGHT_SHARE);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * frame.width / frame.height);
  }
  placeStage.style.width = w + 'px';
  placeStage.style.height = h + 'px';
  return { w, h };
}

function drawPlaceStage() {
  const { w, h } = sizePlaceStage();
  const dpr = window.devicePixelRatio || 1;
  placeCanvas.width = Math.round(w * dpr);
  placeCanvas.height = Math.round(h * dpr);
  const ctx = placeCanvas.getContext('2d');
  // No transform: drawImageArgs maps the project frame onto whatever size the
  // canvas is, which is what the preview canvas does with its own too.
  const target = cropTargetLayer();
  // Everything except the layer being placed, which is drawn afterwards from
  // the two drafts. It is drawn whether or not the playhead covers it: a layer
  // the playhead has left is not in the composite, and placing a picture that
  // is not on screen is placing it blind. Its decoder was parked on that
  // layer's own first frame when the popup opened.
  paintLayers(ctx, placeCanvas, compositeAt, null, target ? target.id : null);
  if (target) drawLayerInto(ctx, placeCanvas, target, cropDraft, placeDraft);
  drawPlaceBox(w, h);
  layoutPlaceRings();
}

/** Where the layer being placed lands, and the numbers under the stage. */
function drawPlaceBox(w, h) {
  const target = cropTargetLayer();
  const frame = projectFrame();
  const d = placeDraft;
  placeBox.hidden = !d;
  if (!d) {
    placeSize.textContent = '';
    return;
  }
  const kx = w / frame.width;
  const ky = h / frame.height;
  placeBox.style.left = Math.round(d.x * kx) + 'px';
  placeBox.style.top = Math.round(d.y * ky) + 'px';
  placeBox.style.width = Math.round(d.width * kx) + 'px';
  placeBox.style.height = Math.round(d.height * ky) + 'px';
  // Said rather than left to be worked out: a draft that is still the fit is
  // what Accept will store as no position at all.
  //
  // Two calls rather than one with a ternary in it, for the reason spelled out
  // over setProjectError: the checker sees a literal after t( and nothing else.
  if (sameRect(d, placeFitRect(target))) {
    placeSize.textContent = t('Centred and fitted, {w} x {h}',
      { w: d.width, h: d.height });
  } else {
    placeSize.textContent = t('{w} x {h} at {x}, {y}',
      { w: d.width, h: d.height, x: d.x, y: d.y });
  }
}

cropTabFrame.addEventListener('click', () => showCropTab('frame'));
cropTabPlace.addEventListener('click', () => showCropTab('place'));

// The popup is sized against the window, so resizing it while the popup is open
// has to redo the lot: the frame, the snapshot in it, and the box on top.
function resizeCropStage() {
  if (cropModal.hidden || !cropDraft) return;
  if (cropTab === 'place') {
    drawPlaceStage();
    return;
  }
  const size = sourceSize();
  if (!size) return;
  sizeCropStage(size);
  paintCropFrame();
  placeCropDraft();
  // The frame changed size, not the crop, so the anchor is restated against the
  // new one rather than the crop being re-derived from the old fractions.
  captureCropAnchor(size);
  updateCropArrows();
}

function markActivePreset() {
  for (const btn of cropPresets.children) {
    btn.classList.toggle('btn--active', btn === cropActivePreset);
  }
}

function updateCropNote() {
  // Advanced editing composites, which is an encode however it is asked for:
  // there is no stream copy here for a crop to be ruling out, so there is
  // nothing to warn about.
  if (timelineDriving()) {
    cropEncodeNote.hidden = true;
    return;
  }
  const size = sourceSize();
  cropEncodeNote.hidden = accurateToggle.checked || !size || isFullFrame(cropDraft, size);
}

function placeCropDraft() {
  const size = sourceSize();
  if (!size) return;
  const screen = boxScreenRect(size);
  cropBox.style.left = screen.left + 'px';
  cropBox.style.top = screen.top + 'px';
  cropBox.style.width = screen.width + 'px';
  cropBox.style.height = screen.height + 'px';
  cropSize.textContent = cropDraft.width + ' x ' + cropDraft.height;
  // A box with room to move inside the frame says so; one filling it hands the
  // cursor over to the stage, which is what pans the picture underneath.
  const room = (cropPicture.w - screen.width) > 1 || (cropPicture.h - screen.height) > 1;
  cropBox.style.cursor = room ? 'move' : '';
  cropStage.dataset.pannable = String(viewZoom > 1);
  updateCropNote();
}

function setCropHint(mirrored, diagonal = false, locked = false) {
  if (locked) {
    cropHint.textContent = t('Locked: the frame keeps the shape selected below');
  } else if (mirrored && diagonal) {
    cropHint.textContent = t('Mirrored and diagonal: all four borders, 1 px each');
  } else if (mirrored) {
    cropHint.textContent = t('Mirrored: both bars moving together, 1 px each');
  } else if (diagonal) {
    cropHint.textContent = t('Diagonal: both borders of the corner, 2 px each');
  } else {
    cropHint.textContent = t(CROP_HINT_IDLE);
  }
}

// The bounds a bar may travel between: what is on the frame, rounded inward to
// an even number so the box can still land on one. The half pixel of slack
// stops a rounding error at 100%, where the window is the whole picture, from
// quietly shaving two pixels off the far edge.
function viewBounds(size) {
  // 21e. The picture's own edges until extending is allowed, and a fixed
  // allowance around it once it is. Never cropOuter, which grows with the frame
  // and would therefore be no limit on it at all.
  const lim = cropLimit(size);
  // And at 100% the allowance is the whole of it, with no window to intersect.
  // The window there is everything the stage holds, which is the frame itself
  // once the frame is the larger of the two, so intersecting would hold the
  // frame to its own size: the bar could not be dragged out by a single pixel,
  // which is exactly what the first run of the probe measured.
  //
  // The reason for the intersection below is a zoom reason. It stays for one.
  if (cropExtendable() && viewZoom <= 1) {
    return { minX: lim.x, maxX: lim.x + lim.w, minY: lim.y, maxY: lim.y + lim.h };
  }
  const v = viewWindow(size);
  return {
    minX: Math.max(lim.x, 2 * Math.ceil((v.x - 0.5) / 2)),
    maxX: Math.min(lim.x + lim.w, 2 * Math.floor((v.x + v.w + 0.5) / 2)),
    minY: Math.max(lim.y, 2 * Math.ceil((v.y - 0.5) / 2)),
    maxY: Math.min(lim.y + lim.h, 2 * Math.floor((v.y + v.h + 0.5) / 2)),
  };
}

// Shared by the bars and the corners: a drag is no longer whatever preset last
// set the box, and the hint follows whether Shift is down. A drag is a real
// edit of the box, so this is one of the places the anchor is rewritten.
function applyDraft(shifted, diagonal = false, locked = false) {
  const size = sourceSize();
  setCropHint(shifted, diagonal, locked);
  clearActivePreset();
  // 21e. The frame may have just crossed the edge of the picture, which changes
  // what the stage has to hold and so what everything on it is drawn at. Before
  // the box is placed and before the anchor is taken, both of which are read
  // against the scale this settles.
  if (size) refitCropView(size);
  placeCropDraft();
  if (size) captureCropAnchor(size);
}

/**
 * Everything the bars and the corners need to know about the box they move.
 *
 * V2.7. Gathered so that the Crop Render Frame window can hand the same two
 * binders its own answers: a different rectangle, its own stage scale, its own
 * hint line. Nothing in here is new. Each entry is the popup global that the
 * binders read directly until now, and this object is the only thing that
 * reads them on their behalf.
 *
 * rect is a function rather than the rectangle itself because cropDraft is
 * replaced outright in several places, so a reference taken once would go
 * stale. The binders call it again on every move, which is what the code they
 * came from did by naming the global.
 */
const cropBoxCtx = {
  size: sourceSize,
  rect: () => cropDraft,
  bounds: viewBounds,
  scale: () => cropScale,
  ratio: cropLockRatio,
  hint: setCropHint,
  commit: applyDraft,
};

// One bar at a time, or with Shift the bar opposite it as well. Both work on
// the pair of edges the bar belongs to, lo and hi, which is what keeps the
// clamping to the frame in one place instead of four.
function bindGrip(grip, ctx) {
  const edge = grip.dataset.edge;
  const vertical = edge === 'top' || edge === 'bottom';
  const movesLo = edge === 'left' || edge === 'top';

  grip.addEventListener('pointerdown', (evt) => {
    const size = ctx.size();
    const draft = ctx.rect();
    if (!size || !draft) return;
    const bounds = ctx.bounds(size);
    const lo0 = vertical ? draft.y : draft.x;
    const hi0 = lo0 + (vertical ? draft.height : draft.width);
    const anchor = vertical ? evt.clientY : evt.clientX;
    // 21e. The scale the gesture started at, not the live one. Dragging the
    // frame out past the picture re-fits the stage under it, and reading the
    // scale back each time would make the travel worth more source pixels the
    // further it went: a drag that fed on itself rather than following the
    // pointer. The box's place on the stage moves less and less instead, which
    // is the picture shrinking inside a growing frame.
    const scale0 = ctx.scale();
    ctx.hint(evt.shiftKey);
    // Stops the pointerdown from also starting a move of the whole box.
    evt.stopPropagation();

    // 21e-3. The shape to hold if the two modifiers are down, taken now for
    // the reason cropLockRatio gives.
    const locked = { ...draft };
    const ratio0 = ctx.ratio();

    if (ctx.begin) ctx.begin({ el: grip, vertical, movesLo });

    beginDrag(grip, evt, (ev) => {
      // Read here rather than at the press: see the note above bindGrip.
      const floor = vertical ? bounds.minY : bounds.minX;
      const limit = vertical ? bounds.maxY : bounds.maxX;
      const least = (vertical ? bounds.leastY : bounds.leastX) || CROP_MIN;
      const travel = (vertical ? ev.clientY : ev.clientX) - anchor;
      if (ev.shiftKey && ev.ctrlKey && ratio0) {
        // The edge opposite this bar stays put, and the other axis grows about
        // its own middle so that changing the shape does not slide the box up
        // or down the frame. A bar on the vertical drives the height, so what
        // is asked for is converted through the ratio: one number drives both,
        // which is what stops the two sides from disagreeing.
        const grown = (vertical ? locked.height : locked.width)
          + (movesLo ? -1 : 1) * (travel / scale0);
        const rect = layerGeometry.ratioResize(locked, ratio0,
          vertical
            ? { x: 'mid', y: movesLo ? 'hi' : 'lo' }
            : { x: movesLo ? 'hi' : 'lo', y: 'mid' },
          vertical ? grown * ratio0 : grown, bounds, CROP_MIN);
        if (rect) {
          const live = ctx.rect();
          live.x = rect.x;
          live.y = rect.y;
          live.width = rect.width;
          live.height = rect.height;
          ctx.commit(false, false, true);
          return;
        }
      }
      const { lo, hi } = layerGeometry.resizeEdge(lo0, hi0, limit, movesLo,
        ev.shiftKey, travel / scale0, travel, floor, least);
      const live = ctx.rect();
      if (vertical) {
        live.y = lo;
        live.height = hi - lo;
      } else {
        live.x = lo;
        live.width = hi - lo;
      }
      ctx.commit(ev.shiftKey);
    }, () => {
      ctx.hint(false);
      if (ctx.end) ctx.end();
    });
  });
}

// A corner is simply both of its bars at once, one per axis, which is why it
// needs no arithmetic of its own. Shift therefore mirrors on both axes at once,
// and the corner diagonally opposite is the one that follows. Ctrl ties the two
// axes together so the corner runs along the box's own diagonal, and the two
// chain: Ctrl and Shift together move all four borders, a pixel at a time.
function bindCorner(dot, ctx) {
  const key = dot.dataset.corner;
  const movesLeft = key === 'tl' || key === 'bl';
  const movesTop = key === 'tl' || key === 'tr';

  dot.addEventListener('pointerdown', (evt) => {
    const size = ctx.size();
    const draft = ctx.rect();
    if (!size || !draft) return;
    const start = { ...draft };
    const bounds = ctx.bounds(size);
    const anchorX = evt.clientX;
    const anchorY = evt.clientY;
    // The scale the gesture started at, for the reason given on the bars.
    const scale0 = ctx.scale();
    ctx.hint(evt.shiftKey, evt.ctrlKey);
    evt.stopPropagation();

    const ratio0 = ctx.ratio();
    if (ctx.begin) ctx.begin({ el: dot, corner: true, movesLo: movesLeft });

    beginDrag(dot, evt, (ev) => {
      let travelX = ev.clientX - anchorX;
      let travelY = ev.clientY - anchorY;
      if (ev.shiftKey && ev.ctrlKey && ratio0) {
        // The corner opposite this one stays put and the box grows away from
        // it. Whichever way the pointer has travelled further is the axis that
        // drives, so the drag answers to both directions rather than going
        // dead in one of them, and the other side follows through the ratio.
        const outX = (movesLeft ? -travelX : travelX) / scale0;
        const outY = (movesTop ? -travelY : travelY) / scale0;
        const want = Math.abs(travelY) > Math.abs(travelX)
          ? (start.height + outY) * ratio0
          : start.width + outX;
        const rect = layerGeometry.ratioResize(start, ratio0,
          { x: movesLeft ? 'hi' : 'lo', y: movesTop ? 'hi' : 'lo' },
          want, bounds, CROP_MIN);
        if (rect) {
          const live = ctx.rect();
          live.x = rect.x;
          live.y = rect.y;
          live.width = rect.width;
          live.height = rect.height;
          ctx.commit(false, false, true);
          return;
        }
      }
      if (ev.ctrlKey) {
        // Averaged along the diagonal rather than taken per axis, so whatever
        // the pointer does the two borders move by the same amount. Which way
        // each axis has to go to close the box in depends on which corner this
        // is, which is what the two flips are for.
        const closeX = movesLeft ? travelX : -travelX;
        const closeY = movesTop ? travelY : -travelY;
        const along = (closeX + closeY) / 2;
        travelX = movesLeft ? along : -along;
        travelY = movesTop ? along : -along;
      }
      const across = layerGeometry.resizeEdge(start.x, start.x + start.width,
        bounds.maxX, movesLeft, ev.shiftKey, travelX / scale0, travelX, bounds.minX,
        bounds.leastX || CROP_MIN);
      const down = layerGeometry.resizeEdge(start.y, start.y + start.height,
        bounds.maxY, movesTop, ev.shiftKey, travelY / scale0, travelY, bounds.minY,
        bounds.leastY || CROP_MIN);
      const live = ctx.rect();
      live.x = across.lo;
      live.width = across.hi - across.lo;
      live.y = down.lo;
      live.height = down.hi - down.lo;
      ctx.commit(ev.shiftKey, ev.ctrlKey);
    }, () => {
      ctx.hint(false);
      if (ctx.end) ctx.end();
    });
  });
}

for (const grip of cropBox.querySelectorAll('.crop-grip')) bindGrip(grip, cropBoxCtx);
for (const dot of cropBox.querySelectorAll('.crop-corner')) bindCorner(dot, cropBoxCtx);

// Dragging the middle slides the whole box, which is the only way to choose
// which part of the frame a smaller box keeps.
cropBox.addEventListener('pointerdown', (evt) => {
  const size = sourceSize();
  if (!size || !cropDraft || !cropAnchor) return;
  // Measured against the picture rather than the frame: the bars beside a clip
  // that is not 16:9 are not somewhere the box may be moved to.
  const room = cropPicture;
  const screen0 = anchorScreenRect();
  // A box filling the picture has nowhere to go inside it, so that press is
  // left alone and carries on up to the stage, which pans instead. Any smaller
  // box moves, at whatever zoom.
  if (room.w - screen0.width <= 1 && room.h - screen0.height <= 1) return;
  evt.stopPropagation();
  const anchorX = evt.clientX;
  const anchorY = evt.clientY;

  beginDrag(cropBox, evt, (ev) => {
    // Snapped in source pixels, so the box lands on even numbers however far
    // the frame is zoomed, then held inside the frame: past its edge the box
    // would be neither visible nor grabbable, and panning is what reaches the
    // rest of the picture.
    const step = CROP_STEP * cropScale;
    const dx = Math.round((ev.clientX - anchorX) / step) * step;
    const dy = Math.round((ev.clientY - anchorY) / step) * step;
    const rect = {
      left: clamp(screen0.left + dx, room.left, room.left + room.w - screen0.width),
      top: clamp(screen0.top + dy, room.top, room.top + room.h - screen0.height),
      width: screen0.width,
      height: screen0.height,
    };
    cropDraft = sourceRectFromScreen(rect, size);
    // From the rectangle being dragged rather than back from the rounded crop,
    // so a long drag cannot shrink the box a pixel at a time.
    setCropAnchorFrom(rect);
    placeCropDraft();
    // 21e. Not refitted here. A move cannot grow what the stage has to show,
    // since it is held inside that already, but it can leave less of it in use,
    // and re-fitting for that mid-gesture would slide the box out from under
    // the pointer for nothing. Settled on release instead.
  }, () => {
    refitCropView(size);
    placeCropDraft();
  });
});

// Zoom holds the box where it sits on the frame and lets the source rectangle
// underneath it shrink, which is what tightens the crop. The pan moves with it
// so the box keeps looking at the same part of the picture rather than drifting
// toward the middle of the frame.
function setCropZoom(percent) {
  const size = sourceSize();
  if (!size || !cropAnchor) return;
  const before = anchorScreenRect();
  // The point of the picture sitting under the middle of the box, read off the
  // view rather than off the box, so no rounding of the box can reach the pan.
  const view = viewWindow(size);
  const holdX = view.x + (before.left + before.width / 2 - cropPicture.left) / cropScale;
  const holdY = view.y + (before.top + before.height / 2 - cropPicture.top) / cropScale;

  viewZoom = clamp(percent / 100, CROP_ZOOM_MIN, CROP_ZOOM_MAX);
  cropScale = cropBaseScale * viewZoom;
  // The picture is placed again before the box is asked where it now sits: on a
  // clip that is not 16:9 the picture grows into the bars as it zooms, and the
  // box, being anchored to the picture rather than to the frame, grows with it.
  placePicture(size);
  const after = anchorScreenRect();
  // Keep that same point under the box instead of letting the crop drift toward
  // the middle of the frame as it tightens.
  viewPanX = holdX + (cropPicture.left + cropPicture.w / 2 - (after.left + after.width / 2)) / cropScale;
  viewPanY = holdY + (cropPicture.top + cropPicture.h / 2 - (after.top + after.height / 2)) / cropScale;
  applyView(size);

  cropDraft = sourceRectFromScreen(anchorScreenRect(), size);
  // The slider is set here rather than only by whoever moved it, so the wheel
  // and the slider cannot drift apart about what the zoom currently is.
  cropZoomSlider.value = String(Math.round(viewZoom * 100));
  cropZoomValue.textContent = Math.round(viewZoom * 100) + '%';
  clearActivePreset();
  paintCropFrame();
  placeCropDraft();
  updateCropArrows();
}

cropZoomSlider.addEventListener('input', () => setCropZoom(Number(cropZoomSlider.value)));

// A wheel notch reports about 100 pixels of travel, so a twentieth of a point
// per pixel makes one notch a 5% step. The slider is finer than that, a point
// at a time, for placing an exact figure; the wheel is for getting there. A
// trackpad sends much smaller amounts far more often, which is why the
// leftovers are carried rather than rounded away: without that a slow scroll
// would round to nothing every time and never zoom at all.
const CROP_WHEEL_STEP = 5;
const CROP_WHEEL_RATE = 0.05;
let zoomWheelResidue = 0;

// Electron reports pixels, but a wheel is allowed to report lines or pages
// instead. The multipliers are chosen so a notch is worth about the same
// whichever unit it arrives in: at a line height of 16 a three line notch came
// to 4.8 points, just short of a step, so the first notch did nothing at all.
function wheelPixels(evt) {
  if (evt.deltaMode === 1) return evt.deltaY * 40;    // lines
  if (evt.deltaMode === 2) return evt.deltaY * 400;   // pages
  return evt.deltaY;
}

cropStage.addEventListener('wheel', (evt) => {
  if (cropModal.hidden || !cropAnchor) return;
  // Without this the popup scrolls behind the frame instead, which is also why
  // the listener cannot be a passive one.
  evt.preventDefault();
  const step = CROP_WHEEL_STEP;
  zoomWheelResidue += -wheelPixels(evt) * CROP_WHEEL_RATE;
  const steps = Math.trunc(zoomWheelResidue / step);
  if (!steps) return;
  zoomWheelResidue -= steps * step;
  const now = Math.round(viewZoom * 100);
  const next = clamp(now + steps * step, CROP_ZOOM_MIN * 100, CROP_ZOOM_MAX * 100);
  // Already as far as it goes that way: drop the leftovers rather than banking
  // them, or scrolling back would do nothing until the debt was paid off.
  if (next === now) {
    zoomWheelResidue = 0;
    return;
  }
  setCropZoom(next);
}, { passive: false });

// Above 100% a drag on the picture pans it, which is how a new centre is
// chosen once part of it is out of frame. The box is anchored to the frame, so
// its source rectangle follows the pan rather than travelling with the picture.
cropStage.addEventListener('pointerdown', (evt) => {
  const size = sourceSize();
  if (!size || !cropAnchor || viewZoom <= 1) return;
  const screen = anchorScreenRect();
  const anchorX = evt.clientX;
  const anchorY = evt.clientY;
  const panX0 = viewPanX;
  const panY0 = viewPanY;
  cropStage.dataset.panning = 'true';

  beginDrag(cropStage, evt, (ev) => {
    viewPanX = panX0 - (ev.clientX - anchorX) / cropScale;
    viewPanY = panY0 - (ev.clientY - anchorY) / cropScale;
    applyView(size);
    cropDraft = sourceRectFromScreen(screen, size);
    clearActivePreset();
    paintCropFrame();
    placeCropDraft();
    updateCropArrows();
  }, () => { cropStage.dataset.panning = 'false'; });
});

for (const preset of CROP_PRESETS) {
  const btn = document.createElement('button');
  btn.textContent = preset.label;
  btn.addEventListener('click', () => {
    const size = sourceSize();
    if (!size) return;
    // Fitted to what is on the frame, not to the whole picture: at a zoom the
    // largest 16:9 in the source would be far bigger than the frame can show,
    // and its edges would sit somewhere off in the part that is out of view.
    //
    // 21e. And to the part of the frame the picture is on, not to the room
    // around it. That is the whole of "clicking any AR button restores the
    // original frame size": a preset is never measured against an extension, so
    // every one of them, Original included, is the way back inside the picture.
    //
    // Which means the stage is about to be holding the picture and nothing more,
    // whatever it was holding a moment ago. Settled first, because every number
    // below is measured at the scale and the pan this sets, and a preset worked
    // out against a stage still zoomed out for an extension lands beside itself:
    // measured at 22px, on an Original that should have been the whole picture.
    cropDraft = fullRect(size);
    refitCropView(size);
    const view = viewWindow(size);
    const seen = pictureOnStage(size, view);
    const window_ = { w: evenDown(seen.w), h: evenDown(seen.h) };
    const rect = preset.ratio === null ? fullRect(window_) : ratioRect(window_, preset.ratio);
    // Offset onto the picture, since what comes back is measured from the
    // corner of the visible window and sourceRectFromScreen wants a place on
    // the frame. Without this a preset on a clip that is not 16:9 lands a
    // bar's width off, which a 16:9 clip never shows because its bars are zero.
    const onFrame = {
      left: cropPicture.left + (seen.x - view.x + rect.x) * cropScale,
      top: cropPicture.top + (seen.y - view.y + rect.y) * cropScale,
      width: rect.width * cropScale,
      height: rect.height * cropScale,
    };
    cropDraft = sourceRectFromScreen(onFrame, size);
    // From what the preset asked for, not from what came back rounded.
    setCropAnchorFrom(onFrame);
    cropActivePreset = btn;
    cropActiveRatio = preset.ratio;
    markActivePreset();
    placeCropDraft();
  });
  cropPresets.appendChild(btn);
}

function openCrop(layerId) {
  if (busy) return;
  if (timelineDriving()) {
    // Opened on a named row, or on whichever one is selected. Fixed here for
    // the life of the popup, which is what cropTargetLayer then reads.
    const target = (layerId && timelineModel.layerById(layers, layerId)) || cropTargetLayer();
    // V3. Nothing to crop out of a generated layer, whose picture is the frame.
    if (!target || target.type !== 'video' || target.kind === 'gen') return;
    cropLayerId = target.id;
  } else {
    cropLayerId = null;
  }
  const size = sourceSize();
  if (!size) {
    cropLayerId = null;
    return;
  }
  const accepted = currentCrop();
  // A rectangle left over from a frame of a different size would be nonsense,
  // so anything that does not fit the current one starts over.
  const kept = accepted
    && accepted.x + accepted.width <= size.w
    && accepted.y + accepted.height <= size.h;
  cropDraft = kept ? { ...accepted } : fullRect(size);
  clearActivePreset();
  // Back to the zoom and pan the crop was accepted at, so it opens on the view
  // it closed on rather than snapping out to the whole picture. The box is
  // carried in source pixels and drawn through that view, so it comes back the
  // size it was rather than the size it would be at 100%. With no crop to
  // return to there is nothing to restore, and it opens on the whole picture.
  const view = kept ? currentCropView() : null;
  viewZoom = view ? clamp(view.zoom, CROP_ZOOM_MIN, CROP_ZOOM_MAX) : 1;
  viewPanX = view ? view.panX : size.w / 2;
  viewPanY = view ? view.panY : size.h / 2;
  const percent = Math.round(viewZoom * 100);
  cropZoomSlider.value = String(percent);
  cropZoomValue.textContent = percent + '%';
  // Whatever a previous session left part way towards a step is not this one's.
  zoomWheelResidue = 0;
  cropModal.hidden = false;
  // Before the first paint, so a layer the playhead has left is not cropped
  // against whatever frame its decoder was last asked for.
  const target = cropTargetLayer();
  if (target) seedCropFrame(target);
  sizeCropStage(size);
  paintCropFrame();
  placeCropDraft();
  captureCropAnchor(size);
  updateCropArrows();
  setCropHint(false);
  // Every opening starts on the crop, which is what the button that opened it
  // says it does. The tabs themselves are advanced editing only.
  cropTabs.hidden = !timelineDriving();
  // Always the crop, which is what every button that opens this says it does.
  // Render Position is reached by its tab, and since 2026-09-23 that is the
  // only way in: the clip mark that opened it directly has gone.
  //
  // Wherever this layer is now, placed or not, so the position tab has a
  // rectangle to drag the moment it is opened.
  placeTouched = !!(target && target.render);
  // V2.8 item 8. Whatever this layer was stuck to last time, so the ring is lit
  // and the scale slider goes on growing it about the same corner.
  placeAnchor = (target && target.anchor) || null;
  placeDraft = target ? (target.render ? { ...target.render } : placeFitRect(target)) : null;
  // The scale and the centre are what the placement really is, so they are
  // taken from whatever it opens on rather than being left at their defaults
  // for the first slider move to invent.
  adoptPlaceRect(placeDraft, target ? placeFitRect(target) : null);
  showCropTab('frame');
}

function closeCrop() {
  cropModal.hidden = true;
  cropDraft = null;
  placeDraft = null;
  placeDrag = null;
  placeRingPress = null;
  placeTouched = false;
  placeAnchor = null;
  // Back to following the selection. Cleared after the modal is hidden and
  // before anything redraws, so nothing reads it as still open on a layer.
  cropLayerId = null;
  setCropHint(false);
  updateCropArrows();
}

// Wrapped rather than passed: the click hands its event to the first argument,
// which is where openCrop now takes a layer id. V2.7 sends advanced editing to
// the other window, which is what the button now says it does.
cropBtn.addEventListener('click', () => {
  if (timelineDriving()) openRenderCrop();
  else openCrop();
});
cropCancelBtn.addEventListener('click', closeCrop);

// Takes the crop off outright, whatever is in the popup: the whole picture is
// saved again and the boxes come off the three frames. The same thing Original
// then Accept does, without having to know that is what Original means.
cropRemoveBtn.addEventListener('click', () => {
  // V2.1. Whichever tab is up. On the crop it takes the crop off; on the
  // position it puts the layer back to centre and fit. One button rather than
  // two, because the tabs are two views of one layer and Remove means "take
  // back what this tab does".
  if (cropTab === 'place') {
    if (cropLayerId) {
      setLayers(timelineModel.setLayer(layers, cropLayerId, { render: null }));
      commitHistory();
    }
    closeCrop();
    updateCropOverlays();
    updateCropBtn();
    return;
  }
  // Nothing left to come back to, so the next opening starts over.
  setCurrentCrop(null, null);
  commitHistory();
  closeCrop();
  updateCropOverlays();
  updateCropBtn();
});

cropAcceptBtn.addEventListener('click', () => {
  const size = sourceSize();
  // The whole frame is not a crop: storing it would cost a re-encode and show a
  // box around the entire picture, for nothing.
  const rect = (size && cropDraft && !isFullFrame(cropDraft, size)) ? { ...cropDraft } : null;
  // Where the popup was looking from when the crop was settled on. Only worth
  // keeping alongside a crop: without one it would open zoomed into nothing.
  // One step for the whole popup: opening it on one side and accepting it on
  // the other, with nothing in between. The user set that boundary.
  // V2.1. One Accept settles both tabs, which is the boundary the user drew
  // when the popup gained the second one. A placement that is still the centre
  // and fit is stored as null, for the same reason the whole frame is not a
  // crop: it is what the geometry works out on its own, and writing it down
  // would freeze it against a crop or a project frame that changes later.
  const render = (placeDraft && !sameRect(placeDraft, placeFitRect(cropTargetLayer())))
    ? { ...placeDraft }
    : null;
  setCurrentCrop(rect, rect ? { zoom: viewZoom, panX: viewPanX, panY: viewPanY } : null);
  // After the crop, and through the id rather than the layer object: setLayers
  // has just replaced the array that object came out of.
  if (cropLayerId) {
    // V2.8 item 8. The ring travels with the placement, so reopening this layer
    // finds the same one lit and scaling goes on sticking to it.
    setLayers(timelineModel.setLayer(layers, cropLayerId,
      { render, anchor: placeAnchor }));
  }
  commitHistory();
  closeCrop();
  updateCropOverlays();
  updateCropBtn();
});

bindPopup(cropModal, closeCrop);
