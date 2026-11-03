'use strict';

// Shape Settings: a shape's colour, and its box on the render preview.

// The user: "Each shape can be colored, scaled and positioned - thats all".
// The draft is in the project's own pixels, like the bar's, and Accept writes
// it back with refHeight set to the project's height; an Accept that changed
// nothing writes nothing. A shape that was never dragged keeps a null box, its
// default place, until it is.

const shapeModal = el('shapeModal');
const shapeColorBtn = el('shapeColorBtn');
const shapeStage = el('shapeStage');
const shapeCanvas = el('shapeCanvas');
const shapeBoxEl = el('shapeBoxEl');
const shapeGuideX = el('shapeGuideX');
const shapeGuideY = el('shapeGuideY');
const shapeBackground = el('shapeBackground');
const shapeAcceptBtn = el('shapeAcceptBtn');
const shapeCancelBtn = el('shapeCancelBtn');

let shapeLayerId = null;
let shapeFirst = false;
let shapeDraft = null;    // { kind, color, box: null or whole project pixels }
let shapeOpened = null;   // the draft as it opened, as JSON

function shapeGenOf(draft) {
  return {
    form: 'shape',
    refHeight: projectFrame().height,
    shape: { kind: draft.kind, color: draft.color, box: draft.box },
  };
}

function openShapeSettings(layer, first) {
  const shape = layer.gen.shape;
  const k = genDraw.scaleOf(layer.gen, projectFrame().height);
  const b = shape.box;
  shapeLayerId = layer.id;
  shapeFirst = first;
  shapeDraft = {
    kind: shape.kind,
    color: shape.color,
    box: b ? { x: Math.round(b.x * k), y: Math.round(b.y * k), w: Math.round(b.w * k), h: Math.round(b.h * k) } : null,
  };
  shapeOpened = JSON.stringify(shapeDraft);
  shapeBackground.checked = genBackdropOn;
  shapeModal.hidden = false;
  recallStageView(shapeStage, shapeLayerId, genKeyframeOf(shapeLayerId));
  paintSwatch(shapeColorBtn, shapeDraft.color);
  sizeShapeStage();
  paintShapePreview();
}

function closeShapeSettings() {
  // V3.3. Kept before the modal lets the layer go, Accept or Cancel.
  if (shapeLayerId) rememberStageView(shapeStage, shapeLayerId, genKeyframeOf(shapeLayerId));
  settlePick(false);
  shapeModal.hidden = true;
  shapeGuideX.hidden = true;
  shapeGuideY.hidden = true;
  shapeLayerId = null;
  shapeDraft = null;
  shapeOpened = null;
  shapeFirst = false;
}

function sizeShapeStage() {
  sizeGenStage(shapeStage, shapeCanvas);
  placeShapeBox();
}

function paintShapePreview(quick) {
  if (!shapeDraft) return;
  paintGenPreview(shapeStage, shapeCanvas, shapeLayerId, shapeGenOf(shapeDraft), quick);
}

// The box in project pixels: its own, or where the drawing puts a shape with
// none, in whole pixels like every box a drag makes, since a drag moves only
// the side it holds and the others would keep the default's fractions.
function shapeBoxNow() {
  if (shapeDraft.box) return shapeDraft.box;
  const frame = projectFrame();
  // Through the model, so the drawing is asked about what a file would hold.
  const b = genDraw.shapeBox(timelineModel.genOf(shapeGenOf(shapeDraft)), frame.width, frame.height);
  const w = Math.round(b.w);
  const h = Math.round(b.h);
  return { x: Math.round((frame.width - w) / 2), y: Math.round((frame.height - h) / 2), w, h };
}

// Screen pixels per project pixel on the stage, zoomed as it is.
function shapeStageScale() {
  return stageFrameRect(shapeStage).s;
}

function placeShapeBox() {
  if (!shapeDraft) return;
  const r = stageFrameRect(shapeStage);
  const s = r.s;
  const b = shapeBoxNow();
  shapeBoxEl.style.left = (r.left + b.x * s) + 'px';
  shapeBoxEl.style.top = (r.top + b.y * s) + 'px';
  shapeBoxEl.style.width = (b.w * s) + 'px';
  shapeBoxEl.style.height = (b.h * s) + 'px';
}

function setShapeBox(box) {
  if (!shapeDraft) return;
  shapeDraft = { ...shapeDraft, box: { x: box.x, y: box.y, w: box.w, h: box.h } };
  placeShapeBox();
  paintShapePreview();
}

// The frame line a drag has met, across the whole frame, or none.
function showShapeGuides(x, y) {
  const r = stageFrameRect(shapeStage);
  shapeGuideX.hidden = x === null;
  shapeGuideY.hidden = y === null;
  if (x !== null) {
    shapeGuideX.style.left = (r.left + x * r.s) + 'px';
    shapeGuideX.style.top = r.top + 'px';
    shapeGuideX.style.height = r.height + 'px';
  }
  if (y !== null) {
    shapeGuideY.style.top = (r.top + y * r.s) + 'px';
    shapeGuideY.style.left = r.left + 'px';
    shapeGuideY.style.width = r.width + 'px';
  }
}

// V3.3. The wheel zooms and empty space pans, so a shape can be put off the
// frame and found there again.
bindStageView(shapeStage, {
  open: () => !!shapeDraft && !shapeModal.hidden,
  empty: (evt) => evt.target === shapeStage || evt.target === shapeCanvas,
  redraw: (quick) => {
    placeShapeBox();
    paintShapePreview(quick);
  },
});

// A side stretches the shape, snapping to the frame's edges and middle the way
// the text box's does; Shift takes the opposite side along.
for (const grip of shapeBoxEl.querySelectorAll('.crop-grip')) {
  const edge = grip.dataset.edge;
  const vertical = edge === 'top' || edge === 'bottom';
  grip.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !shapeDraft) return;
    // Or the box underneath would take it as a move as well.
    evt.stopPropagation();
    const start = shapeBoxNow();
    const frame = projectFrame();
    const s = shapeStageScale();
    const from = vertical ? evt.clientY : evt.clientX;
    beginDrag(grip, evt, (ev) => {
      const travel = ((vertical ? ev.clientY : ev.clientX) - from) / s;
      const r = layerGeometry.textBoxEdge(start, edge, travel, ev.shiftKey, frame, TEXT_BOX_SNAP / s);
      showShapeGuides(vertical ? null : r.snap, vertical ? r.snap : null);
      setShapeBox(r.box);
    }, () => showShapeGuides(null, null));
  });
}

// A corner scales it and keeps its proportions, about the opposite corner, or
// with Shift about the centre.
for (const corner of shapeBoxEl.querySelectorAll('.crop-corner')) {
  corner.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !shapeDraft) return;
    evt.stopPropagation();
    const start = shapeBoxNow();
    const frame = projectFrame();
    const s = shapeStageScale();
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    beginDrag(corner, evt, (ev) => {
      setShapeBox(layerGeometry.boxCornerScale(start, corner.dataset.corner,
        (ev.clientX - x0) / s, (ev.clientY - y0) / s, ev.shiftKey, frame));
    });
  });
}

shapeBoxEl.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || !shapeDraft || evt.target !== shapeBoxEl) return;
  const start = shapeBoxNow();
  const frame = projectFrame();
  const s = shapeStageScale();
  const x0 = evt.clientX;
  const y0 = evt.clientY;
  beginDrag(shapeBoxEl, evt, (ev) => {
    const r = layerGeometry.textBoxMove(start, (ev.clientX - x0) / s, (ev.clientY - y0) / s, frame, TEXT_BOX_SNAP / s);
    showShapeGuides(r.snapX, r.snapY);
    setShapeBox(r.box);
  }, () => showShapeGuides(null, null));
});

shapeColorBtn.addEventListener('click', async () => {
  if (!shapeDraft) return;
  const was = shapeDraft.color;
  const id = shapeLayerId;
  const set = (color) => {
    shapeDraft = { ...shapeDraft, color };
    paintSwatch(shapeColorBtn, color);
    paintShapePreview();
  };
  const picked = await pickColor(was, (color) => {
    if (shapeLayerId === id) set(color);
  });
  // The modal may have been closed under the picker, by Escape for one.
  if (shapeLayerId !== id) return;
  set(picked || was);
});

shapeBackground.addEventListener('change', () => {
  genBackdropOn = shapeBackground.checked;
  paintShapePreview();
});

window.addEventListener('resize', () => {
  if (shapeModal.hidden || !shapeDraft) return;
  sizeShapeStage();
  paintShapePreview();
});

shapeAcceptBtn.addEventListener('click', () => {
  if (!shapeDraft) return;
  const id = shapeLayerId;
  const changed = JSON.stringify(shapeDraft) !== shapeOpened;
  const first = shapeFirst;
  const gen = shapeGenOf(shapeDraft);
  closeShapeSettings();
  acceptGenSettings(id, gen, changed, first);
});

function cancelShapeSettings() {
  const first = shapeFirst;
  closeShapeSettings();
  if (first) cancelGenAdd();
}

shapeCancelBtn.addEventListener('click', cancelShapeSettings);

bindPopup(shapeModal, cancelShapeSettings);
