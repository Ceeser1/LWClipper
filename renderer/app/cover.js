'use strict';

// V4.7. Obscure and Pixelate: the window a track's right click opens.
//
// The user: "Next media idea to add would be Obscure or Pixelate. You can
// right click on a track to have Obscure or Pixelate in its menu. Both get a
// setting in a new modal, what they want to obscure/pixelate." Asked what
// Obscure is and whether a track holds one area or several, the answer was
// "so add it now", so it went in as proposed: Obscure blurs, and a track
// holds several areas of each.
//
// One window does for both, on one track at a time. It shows the track's
// whole picture, as the file has it and before any crop, at the playhead,
// with the effect on it as the export will make it. Each area is a shape in
// a box on that picture, dragged, sized and turned like a shape in Shape
// Settings; the selected one has the grips, the others are outlines to click.
// The shapes over the picture make the selected area that shape, Add Area
// puts another one in the middle, and Remove Area takes the selected one
// away. Strength, the soft edge and Invert are the effect's, all its areas'.
//
// The draft is in the picture's own whole pixels, the source's, and what the
// layer keeps is in fractions of it (timeline.js coverOf). Accept writes the
// effect onto the layer as one step, or takes it off when no area is left,
// which is also what Remove leaves; an Accept that changed nothing writes
// nothing. The main preview shows the draft meanwhile, as it does for every
// editor window. In the code the pair is the layer's covers.

const coverModal = el('coverModal');
const coverTitle = el('coverTitle');
const coverShapes = el('coverShapes');
const coverAddBtn = el('coverAddBtn');
const coverDropBtn = el('coverDropBtn');
const coverStrengthSlider = el('coverStrengthSlider');
const coverStrengthBox = el('coverStrengthBox');
const coverSoftSlider = el('coverSoftSlider');
const coverSoftBox = el('coverSoftBox');
const coverInvert = el('coverInvert');
const coverStage = el('coverStage');
const coverCanvas = el('coverCanvas');
const coverOthers = el('coverOthers');
const coverBoxEl = el('coverBoxEl');
const coverRotor = el('coverRotor');
const coverAngle = el('coverAngle');
const coverGuideX = el('coverGuideX');
const coverGuideY = el('coverGuideY');
const coverRemoveBtn = el('coverRemoveBtn');
const coverCancelBtn = el('coverCancelBtn');
const coverAcceptBtn = el('coverAcceptBtn');

// Held to this many pixels on its longer side, like the mask view's stage.
const COVER_STAGE_MAX = 4096;
// After the playhead has moved the stage is drawn again for this long, since
// the frame it moved to arrives from the decoder a little after the move.
const COVER_SETTLE_MS = 700;

let coverLayerId = null;
let coverKind = null;      // 'obscure' or 'pixelate'
let coverPic = null;       // the source picture's size, { width, height }
// { strength, soft in the picture's whole pixels, invert, areas: [{ kind, box
// in the picture's whole pixels, rotation in whole degrees }] }
let coverDraft = null;
let coverOpened = null;    // what the layer had when the window opened, as JSON
let coverSel = -1;         // the selected area's place in the draft, or -1
let coverLastKind = 'square';
let coverPreviewKey = '';
let coverPreviewLayers = null;
let coverSeenAt = null;
let coverSettleUntil = 0;

/** The draft from what a layer has. */
function coverDraftOf(cover) {
  const W = coverPic.width;
  const H = coverPic.height;
  return {
    strength: cover.strength,
    soft: Math.round(cover.soft * H),
    invert: cover.invert,
    areas: cover.areas.map((a) => ({
      kind: a.kind,
      box: { x: Math.round(a.box.x * W), y: Math.round(a.box.y * H), w: Math.round(a.box.w * W), h: Math.round(a.box.h * H) },
      rotation: Math.round(a.rotation),
    })),
  };
}

/** What a draft stands for, through the model: null with no area left. */
function coverOfDraft(d) {
  const W = Math.max(1, coverPic.width);
  const H = Math.max(1, coverPic.height);
  return timelineModel.coverOf({
    strength: d.strength,
    soft: d.soft / H,
    invert: d.invert,
    areas: d.areas.map((a) => ({
      kind: a.kind,
      box: { x: a.box.x / W, y: a.box.y / H, w: a.box.w / W, h: a.box.h / H },
      rotation: a.rotation,
    })),
  }, coverKind);
}

// The soft edge reaches half the picture's height, as a mask's does.
function coverSoftCeiling() {
  return Math.max(1, Math.round((coverPic ? coverPic.height : 720) / 2));
}

/**
 * A new area of a kind: a third of the picture high, in the shape's own
 * proportions, in the middle, and a little down and to the right of one that
 * is already exactly there, so two never hide each other.
 */
function coverNewArea(kind) {
  const h = Math.max(16, Math.round(coverPic.height / 3));
  const w = Math.max(16, Math.round(h * genDraw.shapeAspect({ kind })));
  const box = { x: Math.round((coverPic.width - w) / 2), y: Math.round((coverPic.height - h) / 2), w, h };
  const step = Math.max(8, Math.round(coverPic.height / 30));
  const taken = (b) => coverDraft && coverDraft.areas.some((a) => a.box.x === b.x && a.box.y === b.y);
  while (taken(box)) {
    box.x += step;
    box.y += step;
  }
  return { kind, box, rotation: 0 };
}

function coverArea() {
  return coverDraft && coverSel >= 0 ? coverDraft.areas[coverSel] || null : null;
}

/** The window open on this layer as a conflict confirmPopoutConflict can name. */
function coverWindowConflict() {
  if (coverModal.hidden) return null;
  return {
    message: t('The Obscure or Pixelate window is open. Going on closes it and discards what it has not accepted.'),
    close: cancelCover,
  };
}

/**
 * Obscure or Pixelate on a layer, from the right click at `at` on the
 * timeline. The same one already open is brought forward; another asks
 * before it is thrown away. The playhead is put on the clip when it is
 * somewhere else, so its picture is the one shown.
 */
function openCover(layerId, kind, at) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || layer.kind === 'gen' || layer.type !== 'video' || busy) return;
  if (!timelineModel.COVER_KINDS.includes(kind)) return;
  if (!coverModal.hidden) {
    if (coverLayerId === layerId && coverKind === kind) {
      focusPopOut(coverModal);
      return;
    }
    confirmPopoutConflict([coverWindowConflict()], () => openCover(layerId, kind, at));
    return;
  }
  const source = layerSource(layer);
  if (!source) return;
  if (!timelineModel.covers(layer, compositeAt)) {
    const fps = projectFrame().fps || 30;
    const want = Number.isFinite(at) ? at : layer.start;
    seekComposite(Math.min(Math.max(want, layer.start), timelineModel.endOf(layer) - 1 / fps));
  }
  selectLayer(layer.id);
  coverLayerId = layer.id;
  coverKind = kind;
  coverPic = { width: Math.max(1, Math.round(source.width)), height: Math.max(1, Math.round(source.height)) };
  const has = layer[kind];
  coverOpened = JSON.stringify(has || null);
  coverDraft = has
    ? coverDraftOf(has)
    : { strength: timelineModel.COVER_STRENGTH[kind], soft: 0, invert: false, areas: [] };
  // A track with none yet opens with one area on it, selected, so there is
  // something to see and to drag straight away.
  if (!has) coverDraft.areas.push(coverNewArea('square'));
  coverSel = 0;
  coverLastKind = coverDraft.areas[0].kind;
  coverPreviewKey = '';
  coverPreviewLayers = null;
  coverSeenAt = null;
  coverSettleUntil = performance.now() + COVER_SETTLE_MS;
  // Two calls, so check-locales sees both literals.
  coverTitle.textContent = editorTitle(kind === 'obscure' ? t('Obscure') : t('Pixelate'), layer);
  coverModal.hidden = false;
  resetStageView(coverStage);
  popOut(coverModal, 'cover', {
    title: coverTitle.textContent,
    cancel: cancelCover,
    relayout: () => {
      if (!coverDraft) return;
      sizeCoverStage();
      paintCoverStage();
    },
    preview: previewCoverDraft,
  });
  showCoverDraft(null);
  sizeCoverStage();
  paintCoverStage();
}

function closeCover() {
  if (coverModal.hidden) return;
  popIn(coverModal);
  clearPopoutPreview(coverModal.id);
  coverModal.hidden = true;
  coverGuideX.hidden = true;
  coverGuideY.hidden = true;
  coverAngle.hidden = true;
  coverOthers.replaceChildren();
  coverLayerId = null;
  coverKind = null;
  coverPic = null;
  coverDraft = null;
  coverOpened = null;
  coverSel = -1;
}

function cancelCover() {
  closeCover();
}

function acceptCover() {
  if (!coverDraft) return;
  const id = coverLayerId;
  const kind = coverKind;
  const cover = coverOfDraft(coverDraft);
  const changed = JSON.stringify(cover) !== coverOpened;
  closeCover();
  if (!changed || !timelineModel.layerById(layers, id)) return;
  setLayers(timelineModel.setLayer(layers, id, { [kind]: cover }));
  commitHistory();
}

/**
 * POPOUT_FPS times a second while the window is open: the main preview shows
 * the track as Accept would leave it, and the window's own picture follows
 * the playhead. A track gone from under the window takes the window with it.
 */
function previewCoverDraft() {
  if (coverModal.hidden || !coverDraft) return;
  const live = timelineModel.layerById(layers, coverLayerId);
  if (!live) {
    cancelCover();
    return;
  }
  const now = performance.now();
  if (compositeAt !== coverSeenAt) {
    coverSeenAt = compositeAt;
    coverSettleUntil = now + COVER_SETTLE_MS;
  }
  if (compositePlaying || now < coverSettleUntil) paintCoverStage();
  const cover = coverOfDraft(coverDraft);
  const key = JSON.stringify(cover);
  if (key === coverPreviewKey && layers === coverPreviewLayers) return;
  coverPreviewKey = key;
  coverPreviewLayers = layers;
  const kind = coverKind;
  setPopoutPreview(coverModal.id, {
    layerId: live.id,
    layerNow: () => {
      const l = timelineModel.layerById(layers, live.id);
      return l ? { ...l, [kind]: cover } : null;
    },
  });
  if (!compositePlaying) drawComposite();
}

// ---- the settings ----

function showCoverDraft(except) {
  const d = coverDraft;
  if (!d) return;
  const area = coverArea();
  for (const b of coverShapes.querySelectorAll('button')) {
    b.classList.toggle('btn--active', !!area && b.dataset.kind === area.kind);
  }
  coverAddBtn.disabled = d.areas.length >= timelineModel.COVER_AREAS_MAX;
  coverDropBtn.disabled = !area;
  // Remove has something to take off while there is an area.
  coverRemoveBtn.disabled = !d.areas.length;
  const show = (slider, box, value) => {
    slider.value = String(value);
    if (except !== box) box.value = String(value);
  };
  show(coverStrengthSlider, coverStrengthBox, d.strength);
  coverSoftSlider.max = String(coverSoftCeiling());
  show(coverSoftSlider, coverSoftBox, d.soft);
  coverInvert.checked = d.invert;
}

/** The effect's own settings changed: Strength, the soft edge, Invert. */
function changeCover(props, except) {
  if (!coverDraft) return;
  coverDraft = { ...coverDraft, ...props };
  showCoverDraft(except);
  paintCoverStage();
}

/** The selected area changed. */
function changeCoverArea(props) {
  const area = coverArea();
  if (!area) return;
  const areas = coverDraft.areas.map((a, i) => (i === coverSel ? { ...a, ...props } : a));
  coverDraft = { ...coverDraft, areas };
  showCoverDraft(null);
  placeCoverBoxes();
  paintCoverStage();
}

function selectCoverArea(index) {
  coverSel = index;
  const area = coverArea();
  if (area) coverLastKind = area.kind;
  showCoverDraft(null);
  placeCoverBoxes();
}

function addCoverArea(kind) {
  if (!coverDraft || coverDraft.areas.length >= timelineModel.COVER_AREAS_MAX) return;
  const area = coverNewArea(kind);
  coverDraft = { ...coverDraft, areas: [...coverDraft.areas, area] };
  coverLastKind = kind;
  coverSel = coverDraft.areas.length - 1;
  showCoverDraft(null);
  placeCoverBoxes();
  paintCoverStage();
}

function dropCoverArea() {
  if (!coverArea()) return;
  coverDraft = { ...coverDraft, areas: coverDraft.areas.filter((_, i) => i !== coverSel) };
  coverSel = Math.min(coverSel, coverDraft.areas.length - 1);
  showCoverDraft(null);
  placeCoverBoxes();
  paintCoverStage();
}

// A shape makes the selected area that shape, in the box it has; with none
// selected it is a new area of that shape.
for (const b of coverShapes.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!coverDraft) return;
    const kind = b.dataset.kind;
    coverLastKind = kind;
    if (coverArea()) changeCoverArea({ kind });
    else addCoverArea(kind);
  });
}

coverAddBtn.addEventListener('click', () => addCoverArea(coverLastKind));
coverDropBtn.addEventListener('click', dropCoverArea);

// Remove: every area goes and the window stays, as Remove Mask leaves the
// Crop and Mask window open. Accept then takes the effect off the track.
coverRemoveBtn.addEventListener('click', () => {
  if (!coverDraft) return;
  coverDraft = { ...coverDraft, areas: [] };
  coverSel = -1;
  showCoverDraft(null);
  placeCoverBoxes();
  paintCoverStage();
});

coverInvert.addEventListener('change', () => changeCover({ invert: coverInvert.checked }, null));

bindNumberField({
  slider: coverStrengthSlider,
  box: coverStrengthBox,
  range: () => [1, 100],
  set: (n, except) => changeCover({ strength: n }, except),
  show: () => showCoverDraft(null),
});

bindNumberField({
  slider: coverSoftSlider,
  box: coverSoftBox,
  range: () => [0, coverSoftCeiling()],
  set: (n, except) => changeCover({ soft: n }, except),
  show: () => showCoverDraft(null),
});

// ---- the stage ----

function sizeCoverStage() {
  sizeGenStage(coverStage, coverCanvas);
  placeCoverBoxes();
}

/** The track's decoder when it has a frame to draw, or null. */
function coverFrameSource() {
  const entry = decoders.get(coverLayerId);
  if (!entry || !entry.width || !entry.height) return null;
  if (!entry.still && !(entry.el.readyState >= 2)) return null;
  return entry;
}

/**
 * The track's whole picture at the playhead with its covers on it, the one in
 * the window from the draft and the other as the track has it, over the
 * checkerboard, and outside the picture dimmed. Drawn by the preview's own
 * maskedPicture, which is the drawing the main window shows too.
 */
function paintCoverStage() {
  if (!coverDraft || !coverPic || coverModal.hidden) return;
  const ctx = coverCanvas.getContext('2d');
  const r = stageFrameRect(coverStage);
  const dpr = coverCanvas.width / Math.max(1, r.w);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, coverCanvas.width, coverCanvas.height);
  const fx = r.left * dpr;
  const fy = r.top * dpr;
  const fw = r.width * dpr;
  const fh = r.height * dpr;
  ctx.save();
  ctx.translate(fx, fy);
  ctx.fillStyle = checkerPattern(ctx, dpr);
  ctx.fillRect(0, 0, fw, fh);
  ctx.restore();
  const entry = coverFrameSource();
  const live = timelineModel.layerById(layers, coverLayerId);
  if (entry && live) {
    const W = coverPic.width;
    const H = coverPic.height;
    const k = Math.min(1, COVER_STAGE_MAX / Math.max(fw, fh));
    const shown = { ...live, mask: null, keyframes: [], [coverKind]: coverOfDraft(coverDraft) };
    const pic = maskedPicture(shown, entry.el, [0, 0, entry.width, entry.height],
      { dw: fw * k, dh: fh * k }, live.start,
      { x: 0, y: 0, w: W, h: H, W, H, ex: entry.width / W, ey: entry.height / H });
    ctx.drawImage(pic.el, ...pic.from, fx, fy, fw, fh);
  }
  dimOutsideFrame(ctx, coverCanvas, coverStage);
}

/** A box on the stage: an area's, turned as the area is. */
function placeCoverNode(node, area, r) {
  const b = area.box;
  node.style.left = (r.left + b.x * r.s) + 'px';
  node.style.top = (r.top + b.y * r.s) + 'px';
  node.style.width = (b.w * r.s) + 'px';
  node.style.height = (b.h * r.s) + 'px';
  node.style.transform = area.rotation ? 'rotate(' + area.rotation + 'deg)' : '';
}

/** The selected area's box with its grips, and the others as outlines. */
function placeCoverBoxes() {
  if (!coverDraft) return;
  const r = stageFrameRect(coverStage);
  const area = coverArea();
  coverBoxEl.hidden = !area;
  if (area) placeCoverNode(coverBoxEl, area, r);
  const doc = coverOthers.ownerDocument;
  coverOthers.replaceChildren(...coverDraft.areas.map((a, i) => {
    if (i === coverSel) return null;
    const node = doc.createElement('div');
    node.className = 'cover-area';
    node.dataset.index = String(i);
    placeCoverNode(node, a, r);
    return node;
  }).filter(Boolean));
}

function showCoverGuides(x, y) {
  const r = stageFrameRect(coverStage);
  coverGuideX.hidden = x === null;
  coverGuideY.hidden = y === null;
  if (x !== null) {
    coverGuideX.style.left = (r.left + x * r.s) + 'px';
    coverGuideX.style.top = r.top + 'px';
    coverGuideX.style.height = r.height + 'px';
  }
  if (y !== null) {
    coverGuideY.style.top = (r.top + y * r.s) + 'px';
    coverGuideY.style.left = r.left + 'px';
    coverGuideY.style.width = r.width + 'px';
  }
}

// The wheel zooms and empty space pans, as on the other stages, in the
// picture's own pixels.
bindStageView(coverStage, {
  open: () => !!coverDraft && !coverModal.hidden,
  empty: (evt) => evt.target === coverStage || evt.target === coverCanvas,
  redraw: () => {
    placeCoverBoxes();
    paintCoverStage();
  },
  size: () => coverPic,
});

// ---- the selected area's box: a shape's grips, in the picture's pixels ----

function setCoverBox(box) {
  changeCoverArea({ box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } });
}

// A side stretches the area, landing on the picture's edges and middle; Shift
// takes the opposite side along. A turned area's side moves along its own axis.
for (const grip of coverBoxEl.querySelectorAll('.crop-grip')) {
  const edge = grip.dataset.edge;
  const vertical = edge === 'top' || edge === 'bottom';
  grip.addEventListener('pointerdown', (evt) => {
    const area = coverArea();
    if (evt.button !== 0 || !area) return;
    // Or the box underneath would take it as a move as well.
    evt.stopPropagation();
    const start = { ...area.box };
    const s = stageFrameRect(coverStage).s;
    const turn = area.rotation;
    const a = turn * Math.PI / 180;
    const ux = vertical ? -Math.sin(a) : Math.cos(a);
    const uy = vertical ? Math.cos(a) : Math.sin(a);
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    beginDrag(grip, evt, (ev) => {
      if (turn) {
        const along = ((ev.clientX - x0) * ux + (ev.clientY - y0) * uy) / s;
        setCoverBox(layerGeometry.textBoxEdgeTurned(start, edge, along, ev.shiftKey, turn, coverPic).box);
        return;
      }
      const travel = ((vertical ? ev.clientY : ev.clientX) - (vertical ? y0 : x0)) / s;
      const r = layerGeometry.textBoxEdge(start, edge, travel, ev.shiftKey, coverPic, TEXT_BOX_SNAP / s);
      showCoverGuides(vertical ? null : r.snap, vertical ? r.snap : null);
      setCoverBox(r.box);
    }, () => showCoverGuides(null, null));
  });
}

// A corner sizes the two sides it joins, freely, since an area is whatever
// rectangle covers the thing; Shift moves the opposite sides along as well.
for (const corner of coverBoxEl.querySelectorAll('.crop-corner')) {
  const name = corner.dataset.corner;
  const sideH = name.includes('l') ? 'left' : 'right';
  const sideV = name.includes('t') ? 'top' : 'bottom';
  corner.addEventListener('pointerdown', (evt) => {
    const area = coverArea();
    if (evt.button !== 0 || !area) return;
    evt.stopPropagation();
    const start = { ...area.box };
    const s = stageFrameRect(coverStage).s;
    const turn = area.rotation;
    const a = turn * Math.PI / 180;
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    beginDrag(corner, evt, (ev) => {
      const dx = (ev.clientX - x0) / s;
      const dy = (ev.clientY - y0) / s;
      if (turn) {
        const h = layerGeometry.textBoxEdgeTurned(start, sideH, dx * Math.cos(a) + dy * Math.sin(a),
          ev.shiftKey, turn, coverPic).box;
        setCoverBox(layerGeometry.textBoxEdgeTurned(h, sideV, -dx * Math.sin(a) + dy * Math.cos(a),
          ev.shiftKey, turn, coverPic).box);
        return;
      }
      const reach = TEXT_BOX_SNAP / s;
      const h = layerGeometry.textBoxEdge(start, sideH, dx, ev.shiftKey, coverPic, reach);
      const v = layerGeometry.textBoxEdge(h.box, sideV, dy, ev.shiftKey, coverPic, reach);
      showCoverGuides(h.snap, v.snap);
      setCoverBox(v.box);
    }, () => showCoverGuides(null, null));
  });
}

/** The selected area moved by a drag that began at `evt`. */
function dragCoverArea(evt) {
  const area = coverArea();
  if (!area) return;
  const start = { ...area.box };
  const s = stageFrameRect(coverStage).s;
  const x0 = evt.clientX;
  const y0 = evt.clientY;
  // Turned, only its centre lands on the picture's lines, as a turned shape's.
  const move = area.rotation ? layerGeometry.textBoxMoveTurned : layerGeometry.textBoxMove;
  beginDrag(coverBoxEl, evt, (ev) => {
    const r = move(start, (ev.clientX - x0) / s, (ev.clientY - y0) / s, coverPic, TEXT_BOX_SNAP / s);
    showCoverGuides(r.snapX, r.snapY);
    setCoverBox(r.box);
  }, () => showCoverGuides(null, null));
}

coverBoxEl.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || evt.target !== coverBoxEl) return;
  dragCoverArea(evt);
});

// Another area pressed: it is the selected one from then on, and the same
// press goes on to move it.
coverOthers.addEventListener('pointerdown', (evt) => {
  const node = evt.target.closest && evt.target.closest('.cover-area');
  if (evt.button !== 0 || !node || !coverDraft) return;
  selectCoverArea(Number(node.dataset.index));
  dragCoverArea(evt);
});

// The dot turns the area about its box's centre, by as far as the pointer
// goes round it, in whole degrees, landing on a quarter turn within two of
// one; the angle shows by the centre meanwhile.
coverRotor.addEventListener('pointerdown', (evt) => {
  const area = coverArea();
  if (evt.button !== 0 || !area) return;
  evt.stopPropagation();
  const b = area.box;
  const r = stageFrameRect(coverStage);
  const stage = coverStage.getBoundingClientRect();
  const cx = stage.left + coverStage.clientLeft + r.left + (b.x + b.w / 2) * r.s;
  const cy = stage.top + coverStage.clientTop + r.top + (b.y + b.h / 2) * r.s;
  const start = area.rotation;
  const from = [evt.clientX - cx, evt.clientY - cy];
  coverAngle.style.left = (cx - stage.left) + 'px';
  coverAngle.style.top = (cy - stage.top) + 'px';
  coverAngle.textContent = start + '\u00B0';
  coverAngle.hidden = false;
  beginDrag(coverRotor, evt, (ev) => {
    const deg = layerGeometry.textTurnDrag(start, from, [ev.clientX - cx, ev.clientY - cy]);
    coverAngle.textContent = deg + '\u00B0';
    const now = coverArea();
    if (now && deg !== now.rotation) changeCoverArea({ rotation: deg });
  }, () => {
    coverAngle.hidden = true;
  });
});

window.addEventListener('resize', () => {
  if (coverModal.hidden || !coverDraft) return;
  sizeCoverStage();
  paintCoverStage();
});

coverAcceptBtn.addEventListener('click', acceptCover);
coverCancelBtn.addEventListener('click', cancelCover);

bindPopup(coverModal, cancelCover);
