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
// V3.6.2. The turning dot and a square's rounded corners.
const shapeRotor = el('shapeRotor');
const shapeAngle = el('shapeAngle');
const shapeRadiusField = el('shapeRadiusField');
const shapeRadiusSlider = el('shapeRadiusSlider');
const shapeRadiusBox = el('shapeRadiusBox');
// V3.6.5. Which shape it is.
const shapeKinds = el('shapeKinds');
// V3.7. The clip's keyframes.
const shapeKeys = el('shapeKeys');
// V3.7. Color or Gradient, and the gradient's own controls.
const shapeFill = el('shapeFill');
const shapeFillHint = el('shapeFillHint');
const shapeGradient = el('shapeGradient');
const shapeGradBar = el('shapeGradBar');
const shapeGradHelp = el('shapeGradHelp');
const shapeGradCanvas = el('shapeGradCanvas');
const shapeGradStart = el('shapeGradStart');
const shapeGradEnd = el('shapeGradEnd');
const shapeGradAngle = el('shapeGradAngle');
const shapeGradLine = el('shapeGradLine');
const shapeHint = el('shapeHint');
const shapeStrip = makeGenStrip(shapeModal, shapeKeys, el('shapeKeysReadout'), el('shapeKeysCanvas'), shapeStage);

let shapeLayerId = null;
let shapeFirst = false;
// { kind, color, box: null or whole project pixels, invert, soft and line in
// whole project pixels, outline, ring and inner as shares, points, and since
// 3.6.2 rotation in whole degrees and radius in whole project pixels, and
// since 3.7 fill, and gradient with its start and end in whole project
// pixels and its angle in whole degrees }
let shapeDraft = null;
let shapeOpened = null;   // the draft as it opened, as JSON
// V3.7. The gradient a shape that never had one has, in the draft's measure,
// as JSON: picking Gradient for it first lays it across the shape.
let shapeGradientUnset = null;

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

// V3.6.2. Rounded corners reach half the square's shorter side, where its
// ends are round. A box made smaller afterwards keeps the number, and the
// drawing holds it to the half.
function shapeRadiusCeiling() {
  const b = shapeBoxNow();
  return Math.max(1, Math.round(Math.min(b.w, b.h) / 2));
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
    rotation: Math.round(shape.rotation),
    radius: Math.round(shape.radius * k),
    // V3.7.
    fill: shape.fill,
    gradient: shapeDraftGradient(shape.gradient, k),
  };
  shapeOpened = JSON.stringify(shapeDraft);
  shapeGradientUnset = JSON.stringify(shapeDraftGradient(timelineModel.gradientOf(null), k));
  shapeBackground.checked = genBackdropOn;
  shapeModal.hidden = false;
  recallStageView(shapeStage, shapeLayerId, genKeyframeOf(shapeLayerId));
  // V3.6.2. Out into the media window, before anything below measures it.
  popOutGenWindow(shapeModal, layer.id, {
    title: t('Shape Settings'),
    cancel: cancelShapeSettings,
    relayout: () => {
      if (!shapeDraft) return;
      sizeShapeStage();
      paintShapePreview();
    },
    draftGen: () => (shapeDraft ? shapeGenOf(shapeDraft) : null),
    // V3.7. The keyframe editor's side of it.
    changed: () => !!shapeDraft && JSON.stringify(shapeDraft) !== shapeOpened,
    reload: reloadShapeKeyed,
    strip: shapeStrip,
    fold: refitShapeLayer,
  });
  showShapeDraft(null);
  sizeShapeStage();
  paintShapePreview();
}

// V3.5. The settings as the draft has them, except the box being typed in.
function showShapeDraft(except) {
  const d = shapeDraft;
  if (!d) return;
  for (const b of shapeKinds.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.kind === d.kind);
  }
  paintSwatch(shapeColorBtn, d.color);
  // V3.7. Color shows the swatch; Gradient its hint in the swatch's place and
  // the gradient's controls under the settings.
  const grad = d.fill === 'gradient';
  for (const b of shapeFill.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.fill === d.fill);
  }
  shapeColorBtn.hidden = grad;
  shapeFillHint.hidden = !grad;
  shapeGradient.hidden = !grad;
  shapeGrad.showBoxes(except);
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
  shapeRadiusField.hidden = d.kind !== 'square';
  shapeRadiusSlider.max = String(shapeRadiusCeiling());
  show(shapeRadiusSlider, shapeRadiusBox, d.radius);
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
  return { ...props, box: refitShapeBox(d.box, d, { ...d, ...props }, true) };
}

/**
 * V3.6.5. A box given another figure's proportions about its middle: as much
 * wider or narrower as the new figure's regular box is than the old one's, so
 * a shape stretched by hand stays stretched by as much, and going to another
 * kind and back lands where it started. `whole` rounds it to whole pixels, the
 * draft's measure; a keyframe's box is kept as it comes.
 */
function refitShapeBox(box, from, to, whole) {
  if (!box) return box;
  const k = genDraw.shapeAspect(to) / genDraw.shapeAspect(from);
  if (k === 1) return box;
  const w = whole ? Math.max(1, Math.round(box.w * k)) : box.w * k;
  const x = box.x + (box.w - w) / 2;
  return { ...box, x: whole ? Math.round(x) : x, w };
}

/**
 * V3.6.5. The kind is the whole clip's, so a clip with keyframes given another
 * one, or a star given other points, has every keyframe's box and its own
 * refitted the way the draft's was, before the draft is written over the one
 * it is on. V3.7: the media window's fold hook, so the clip's draft takes it
 * whenever the modal's settings are folded in. Hands back the layer.
 */
function refitShapeLayer(layer, gen) {
  const list = timelineModel.keyframesFor(layer);
  const from = layer.gen.shape;
  const to = gen.shape;
  if (!list.length || genDraw.shapeAspect(from) === genDraw.shapeAspect(to)) return layer;
  const fit = (box) => refitShapeBox(box, from, to, false);
  return {
    ...layer,
    gen: { ...layer.gen, shape: { ...layer.gen.shape, box: fit(layer.gen.shape.box) } },
    keyframes: list.map((k) => (k.box ? { ...k, box: fit(k.box) } : k)),
  };
}

function closeShapeSettings() {
  // V3.3. Kept before the modal lets the layer go, Accept or Cancel.
  if (shapeLayerId) rememberStageView(shapeStage, shapeLayerId, genKeyframeOf(shapeLayerId));
  settlePick(false);
  popInGenWindow(shapeModal);
  shapeModal.hidden = true;
  shapeGuideX.hidden = true;
  shapeGuideY.hidden = true;
  shapeAngle.hidden = true;
  shapeLayerId = null;
  shapeDraft = null;
  shapeOpened = null;
  shapeFirst = false;
}

function sizeShapeStage() {
  // V3.7. The kind can be changed in the window since 3.6.5, and a ring, a
  // star or a square has a third row of fields the others have not. It is
  // always counted, so picking one never pushes the buttons out of the
  // window, the way the Layer Mask view counts its second row.
  const noThird = shapeRingField.hidden && shapePointsField.hidden
    && shapeInnerField.hidden && shapeRadiusField.hidden;
  if (noThird) shapeRingField.hidden = false;
  sizeGenStage(shapeStage, shapeCanvas);
  if (noThird) shapeRingField.hidden = true;
  // V3.7. The gradient's bar as wide as the preview.
  shapeGradBar.style.width = shapeStage.style.width;
  shapeGradHelp.style.width = shapeStage.style.width;
  paintShapeGradBar(true);
  placeShapeBox();
  shapeStrip.draw();
}

/**
 * V3.7. The keyed settings, the box, the soft edge, the turn and the corners,
 * read out of `gen` into the draft: the clip's draft at another keyframe. The
 * rest is the whole clip's and is the draft's already.
 */
function reloadShapeKeyed(gen) {
  if (!shapeDraft) return;
  const shape = gen.shape;
  const k = genDraw.scaleOf(gen, projectFrame().height);
  const b = shape.box;
  shapeDraft = {
    ...shapeDraft,
    box: b ? { x: Math.round(b.x * k), y: Math.round(b.y * k), w: Math.round(b.w * k), h: Math.round(b.h * k) } : null,
    soft: Math.min(shapeSoftCeiling(), Math.round(shape.soft * k)),
    rotation: Math.round(shape.rotation),
    radius: Math.round(shape.radius * k),
  };
  shapeOpened = JSON.stringify(shapeDraft);
  showShapeDraft(null);
  placeShapeBox();
  paintShapePreview();
  shapeStrip.draw();
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
  // V3.6.2. Turned about its centre, the point the drawing turns it about.
  shapeBoxEl.style.transform = shapeDraft.rotation ? 'rotate(' + shapeDraft.rotation + 'deg)' : '';
  placeShapeGradLine();
}

function setShapeBox(box) {
  if (!shapeDraft) return;
  shapeDraft = { ...shapeDraft, box: { x: box.x, y: box.y, w: box.w, h: box.h } };
  placeShapeBox();
  // The rounded corners' reach follows the box.
  shapeRadiusSlider.max = String(shapeRadiusCeiling());
  shapeRadiusSlider.value = String(shapeDraft.radius);
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
  // V3.7.1. The gradient is drawn with the right button now, so a left drag
  // on empty space pans in Gradient as it does in Color.
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
    // V3.6.2. A turned shape's side moves along the box's own axis, as a
    // turned text box's does.
    const turn = shapeDraft.rotation;
    const a = turn * Math.PI / 180;
    const ux = vertical ? -Math.sin(a) : Math.cos(a);
    const uy = vertical ? Math.cos(a) : Math.sin(a);
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    beginDrag(grip, evt, (ev) => {
      if (turn) {
        const along = ((ev.clientX - x0) * ux + (ev.clientY - y0) * uy) / s;
        setShapeBox(layerGeometry.textBoxEdgeTurned(start, edge, along, ev.shiftKey, turn, frame).box);
        return;
      }
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
    const turn = shapeDraft.rotation;
    beginDrag(corner, evt, (ev) => {
      // V3.6.2. Turned, along the box's own diagonal, its opposite corner
      // held where it is on the screen.
      setShapeBox(turn
        ? layerGeometry.boxCornerScaleTurned(start, corner.dataset.corner,
          (ev.clientX - x0) / s, (ev.clientY - y0) / s, ev.shiftKey, turn, frame)
        : layerGeometry.boxCornerScale(start, corner.dataset.corner,
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
  // V3.6.2. Turned, only its centre snaps, as a turned text box's does.
  const move = shapeDraft.rotation ? layerGeometry.textBoxMoveTurned : layerGeometry.textBoxMove;
  beginDrag(shapeBoxEl, evt, (ev) => {
    const r = move(start, (ev.clientX - x0) / s, (ev.clientY - y0) / s, frame, TEXT_BOX_SNAP / s);
    showShapeGuides(r.snapX, r.snapY);
    setShapeBox(r.box);
  }, () => showShapeGuides(null, null));
});

// V3.6.2. The dot turns the shape about the box's centre by as far as the
// pointer goes round it, in whole degrees, landing on a quarter turn within
// two of one, the text's rule; the angle shows by the centre meanwhile.
shapeRotor.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || !shapeDraft) return;
  evt.stopPropagation();
  const b = shapeBoxNow();
  const r = stageFrameRect(shapeStage);
  const stage = shapeStage.getBoundingClientRect();
  const cx = stage.left + shapeStage.clientLeft + r.left + (b.x + b.w / 2) * r.s;
  const cy = stage.top + shapeStage.clientTop + r.top + (b.y + b.h / 2) * r.s;
  const start = shapeDraft.rotation;
  const from = [evt.clientX - cx, evt.clientY - cy];
  shapeAngle.style.left = (cx - stage.left) + 'px';
  shapeAngle.style.top = (cy - stage.top) + 'px';
  shapeAngle.textContent = start + '\u00B0';
  shapeAngle.hidden = false;
  beginDrag(shapeRotor, evt, (ev) => {
    const deg = layerGeometry.textTurnDrag(start, from, [ev.clientX - cx, ev.clientY - cy]);
    shapeAngle.textContent = deg + '\u00B0';
    if (deg !== shapeDraft.rotation) changeShape({ rotation: deg }, null);
  }, () => {
    shapeAngle.hidden = true;
  });
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
  }, shapeModal);
  // The modal may have been closed under the picker, by Escape for one.
  if (shapeLayerId !== id) return;
  set(picked || was);
});

shapeBackground.addEventListener('change', () => {
  genBackdropOn = shapeBackground.checked;
  paintShapePreview();
});

// ---- V3.5, the shapes version ----

// V3.6.5. Another shape at any time, keeping the box's height and middle and
// taking the new one's proportions across.
for (const b of shapeKinds.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!shapeDraft || b.dataset.kind === shapeDraft.kind) return;
    changeShape(restar({ kind: b.dataset.kind }), null);
  });
}

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

// V3.6.2. Drawn at the stage's size while dragged, like the soft edge.
bindNumberField({
  slider: shapeRadiusSlider,
  box: shapeRadiusBox,
  range: () => [0, shapeRadiusCeiling()],
  set: (n, except, quick) => changeShape({ radius: n }, except, quick),
  settle: () => paintShapePreview(),
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
  acceptGenSettings(id, gen, changed, first, refitShapeLayer);
});

function cancelShapeSettings() {
  const first = shapeFirst;
  const id = shapeLayerId;
  closeShapeSettings();
  if (first) cancelGenAdd(id);
}

shapeCancelBtn.addEventListener('click', cancelShapeSettings);

bindPopup(shapeModal, cancelShapeSettings);

// ---- V3.7. Color or Gradient ----
//
// The editor is gen/gradient.js's since V3.7.1, shared with the Layer Mask
// view. A shape's gradient runs from the middle of its box, Start and End in
// project pixels, and Rotation is measured from the shape, so it turns and
// moves with it. It is the whole clip's, not keyed.

// Start and End reach this far either way, in project pixels.
const GRAD_REACH = 100000;

function shapeGradientMode() {
  return !!shapeDraft && shapeDraft.fill === 'gradient';
}

/** A model gradient in the draft's measure: `k` project pixels to one at refHeight. */
function shapeDraftGradient(g, k) {
  return {
    stops: g.stops.map((stop) => ({ at: stop.at, color: stop.color })),
    start: Math.round(g.start * k),
    end: Math.round(g.end * k),
    angle: Math.round(g.angle),
  };
}

const shapeGrad = makeGradientEditor({
  bar: shapeGradBar,
  canvas: shapeGradCanvas,
  start: shapeGradStart,
  end: shapeGradEnd,
  angle: shapeGradAngle,
  line: shapeGradLine,
  stage: shapeStage,
  reach: () => GRAD_REACH,
  get: () => (shapeDraft ? shapeDraft.gradient : null),
  on: shapeGradientMode,
  set: (props, quick, except) => setShapeGradient(props, quick, except),
  centre: () => {
    const b = shapeBoxNow();
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  },
  turn: () => (shapeDraft ? shapeDraft.rotation : 0),
  pick: (color, live) => pickColor(color, live, shapeModal),
  owner: () => shapeLayerId,
});

/**
 * The gradient changed: `quick` while something is being dragged, which
 * leaves the dots where they are, since one of them is the thing dragged.
 */
function setShapeGradient(props, quick, except) {
  if (!shapeDraft) return;
  shapeDraft = { ...shapeDraft, gradient: { ...shapeDraft.gradient, ...props } };
  showShapeDraft(except || null);
  shapeGrad.paintBar(!quick);
  shapeGrad.placeLine();
  paintShapePreview(quick);
}

function paintShapeGradBar(withDots) {
  shapeGrad.paintBar(withDots);
}

function placeShapeGradLine() {
  shapeGrad.placeLine();
}

// Color or Gradient. A shape that never had a gradient has it laid across
// itself the first time, white on its left edge into black on its right.
for (const b of shapeFill.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!shapeDraft || b.dataset.fill === shapeDraft.fill) return;
    const props = { fill: b.dataset.fill };
    if (props.fill === 'gradient' && JSON.stringify(shapeDraft.gradient) === shapeGradientUnset) {
      const half = Math.max(1, Math.round(shapeBoxNow().w / 2));
      props.gradient = { ...shapeDraft.gradient, start: -half, end: half, angle: 0 };
    }
    changeShape(props, null);
    // The gradient's controls come and go, so the preview is fitted again,
    // and V3.7.1 the window to them.
    sizeShapeStage();
    paintShapePreview();
    fitPopOut(shapeModal);
  });
}
