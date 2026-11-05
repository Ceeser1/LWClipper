'use strict';

// Shape Settings: a shape's colour, and its box on the render preview. Since
// 3.5 also Invert Shape, Soft Edge, Outline Only, and a ring's thickness and a
// star's points and inner radius.

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
// V3.5, the shapes version.
const shapeInvert = el('shapeInvert');
const shapeSoftSlider = el('shapeSoftSlider');
const shapeSoftBox = el('shapeSoftBox');
const shapeOutline = el('shapeOutline');
const shapeLineSlider = el('shapeLineSlider');
const shapeLineBox = el('shapeLineBox');
const shapeRingField = el('shapeRingField');
const shapeRingSlider = el('shapeRingSlider');
const shapeRingBox = el('shapeRingBox');
const shapePointsField = el('shapePointsField');
const shapePointsSlider = el('shapePointsSlider');
const shapePointsBox = el('shapePointsBox');
const shapeInnerField = el('shapeInnerField');
const shapeInnerSlider = el('shapeInnerSlider');
const shapeInnerBox = el('shapeInnerBox');

let shapeLayerId = null;
let shapeFirst = false;
// { kind, color, box: null or whole project pixels, invert, soft and line in
// whole project pixels, outline, ring and inner as shares, points }
let shapeDraft = null;
let shapeOpened = null;   // the draft as it opened, as JSON

function shapeGenOf(draft) {
  return {
    form: 'shape',
    refHeight: projectFrame().height,
    shape: { ...draft },
  };
}

// V3.5. How far the sliders reach, by the frame: a soft edge up to half its
// height, which fades a spotlight over most of the picture, and an outline up
// to a quarter, the bar's ceiling. The boxes take the same.
function shapeSoftCeiling() {
  return Math.max(1, Math.round(projectFrame().height / 2));
}

function shapeLineCeiling() {
  return Math.max(1, Math.round(projectFrame().height / 4));
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
    invert: shape.invert,
    soft: Math.min(shapeSoftCeiling(), Math.round(shape.soft * k)),
    outline: shape.outline,
    line: Math.min(shapeLineCeiling(), Math.max(1, Math.round(shape.line * k))),
    ring: shape.ring,
    points: shape.points,
    inner: shape.inner,
  };
  shapeOpened = JSON.stringify(shapeDraft);
  shapeBackground.checked = genBackdropOn;
  shapeModal.hidden = false;
  recallStageView(shapeStage, shapeLayerId, genKeyframeOf(shapeLayerId));
  showShapeDraft(null);
  sizeShapeStage();
  paintShapePreview();
}

// V3.5. The settings as the draft has them, except the box being typed in.
function showShapeDraft(except) {
  const d = shapeDraft;
  if (!d) return;
  paintSwatch(shapeColorBtn, d.color);
  shapeInvert.checked = d.invert;
  const show = (slider, box, value) => {
    slider.value = String(value);
    if (except !== box) box.value = String(value);
  };
  shapeSoftSlider.max = String(shapeSoftCeiling());
  show(shapeSoftSlider, shapeSoftBox, d.soft);
  shapeOutline.checked = d.outline;
  shapeLineSlider.max = String(shapeLineCeiling());
  shapeLineSlider.disabled = !d.outline;
  shapeLineBox.disabled = !d.outline;
  show(shapeLineSlider, shapeLineBox, d.line);
  shapeRingField.hidden = d.kind !== 'ring';
  show(shapeRingSlider, shapeRingBox, Math.round(d.ring * 100));
  shapePointsField.hidden = d.kind !== 'star';
  shapeInnerField.hidden = d.kind !== 'star';
  show(shapePointsSlider, shapePointsBox, d.points);
  show(shapeInnerSlider, shapeInnerBox, Math.round(d.inner * 100));
}

function changeShape(props, except, quick) {
  if (!shapeDraft) return;
  shapeDraft = { ...shapeDraft, ...props };
  showShapeDraft(except);
  placeShapeBox();
  paintShapePreview(quick);
}

// V3.5. A star given other points or another depth keeps the proportions the
// box had against the old figure, about the box's middle, so a regular star
// stays regular and one stretched by hand stays stretched by as much.
function restar(props) {
  const d = shapeDraft;
  if (!d.box) return props;
  const was = genDraw.shapeAspect(d);
  const now = genDraw.shapeAspect({ ...d, ...props });
  const w = Math.max(1, Math.round(d.box.w * now / was));
  return { ...props, box: { ...d.box, x: Math.round(d.box.x + (d.box.w - w) / 2), w } };
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

// ---- V3.5, the shapes version ----

shapeInvert.addEventListener('change', () => changeShape({ invert: shapeInvert.checked }, null));
shapeOutline.addEventListener('change', () => changeShape({ outline: shapeOutline.checked }, null));

// The soft edge is drawn at the stage's size while its slider moves, since a
// blur over the whole frame on every step is work nobody sees, and at the
// project's once it is let go.
bindNumberField({
  slider: shapeSoftSlider,
  box: shapeSoftBox,
  range: () => [0, shapeSoftCeiling()],
  set: (n, except, quick) => changeShape({ soft: n }, except, quick),
  settle: () => paintShapePreview(),
  show: () => showShapeDraft(null),
});

bindNumberField({
  slider: shapeLineSlider,
  box: shapeLineBox,
  range: () => [1, shapeLineCeiling()],
  set: (n, except) => changeShape({ line: n }, except),
  show: () => showShapeDraft(null),
});

bindNumberField({
  slider: shapeRingSlider,
  box: shapeRingBox,
  range: () => [5, 95],
  set: (n, except) => changeShape({ ring: n / 100 }, except),
  show: () => showShapeDraft(null),
});

bindNumberField({
  slider: shapePointsSlider,
  box: shapePointsBox,
  range: () => [3, 12],
  set: (n, except) => changeShape(restar({ points: n }), except),
  show: () => showShapeDraft(null),
});

bindNumberField({
  slider: shapeInnerSlider,
  box: shapeInnerBox,
  range: () => [10, 90],
  set: (n, except) => changeShape(restar({ inner: n / 100 }), except),
  show: () => showShapeDraft(null),
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
