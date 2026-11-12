'use strict';

// V4.6. A gradient on the selected letters of a text.
//
// The user: "Features still missing are Text media gradient. A (by drag)
// selected text should have the option to have a gradient applied". The
// Gradient button beside the colour opens a modal over Edit Text, as Outline
// and Shadow do, with Shape Settings' editor in it (gen/gradient.js): the bar
// of stops, Start, End and Rotation, and a right drag on the preview. What it
// edits is Edit Text's draft: Apply puts the gradient onto the letters that
// were selected when it opened and Remove takes it off them, back to their
// colour, and Edit Text's own Accept or Cancel decides whether any of it
// reaches the layer.
//
// A gradient is one more thing a run may carry (timeline.js textGradientOf),
// so it is typed on, copied, undone and saved like a colour. It belongs to a
// stretch of letters, neighbours that carry the same one, and runs across the
// box round them, kept as shares of that box so it stays edge to edge as the
// stretch is typed on. The modal shows project pixels, like every other box
// here, measured from the middle of the letters it opened on.

const textGradModal = el('textGradModal');
const textGradStage = el('textGradStage');
const textGradPreview = el('textGradPreview');
const textGradBar = el('textGradBar');
const textGradHelp = el('textGradHelp');
const textGradLine = el('textGradLine');
const textGradBackground = el('textGradBackground');
const textGradApplyBtn = el('textGradApplyBtn');
const textGradRemoveBtn = el('textGradRemoveBtn');
const textGradCancelBtn = el('textGradCancelBtn');

let tgTarget = null;     // { from, to }, the letters it is for, while it is open
let tgBox = null;        // the box round those letters, project pixels, the text not turned
let tgDraft = null;      // { stops, start, end, angle }: whole project pixels and degrees
let tgOpened = null;     // tgDraft as it opened, as JSON
let tgStored = null;     // what an untouched Apply puts on: shares, measured from tgBox
let tgWasOn = false;     // whether the first of the letters had a gradient
let tgUniform = false;   // whether all of them had that one

// ---- where the letters are ----

let textMeasureCtx = null;

/**
 * The box round the letters `from` to `to` of `full`, expanded runs, as the
 * drawing lays them out: project pixels in the frame, the text not turned.
 * Null when none of them is drawn, a line break or the spaces a line was
 * wrapped at. The runs are cut at both ends first, which moves nothing, so
 * the letters asked about are whole pieces of the layout.
 */
function textRangeBox(full, from, to) {
  if (!textDraft || !(to > from)) return null;
  if (!textMeasureCtx) textMeasureCtx = document.createElement('canvas').getContext('2d');
  const cut = textRuns.applyStyle(full, from, to, {});
  const inside = new Set();
  let at = 0;
  cut.forEach((r, i) => {
    if (r.text && at >= from && at + r.text.length <= to) inside.add(i);
    at += r.text.length;
  });
  const frame = projectFrame();
  const gen = textGenOf({ ...textDraft, text: { ...textDraft.text, runs: cut } });
  const laid = genDraw.layoutOfText(textMeasureCtx, gen, frame.width, frame.height);
  return genDraw.piecesBox(laid, (piece) => inside.has(piece.run));
}

/**
 * `props` laid over `from` to `to` of `full`, as textRuns.applyStyle does it.
 * When they change the gradient and the letters are part of a longer stretch,
 * what is left of that stretch on either side would be measured from its own,
 * smaller box from then on and change its look, so each side's gradient is
 * said again from that box: the letters nobody touched stay as they were.
 */
function applyTextProps(full, from, to, props) {
  let out = textRuns.applyStyle(full, from, to, props);
  if (!props || props.gradient === undefined || !(to > from)) return out;
  for (const s of textRuns.stretches(full)) {
    if (s.to <= from || s.from >= to) continue;
    // The same gradient again joins the stretch rather than cutting it.
    if (props.gradient && textRuns.sameValue(props.gradient, s.gradient)) continue;
    const sides = [[s.from, Math.min(s.to, from)], [Math.max(s.from, to), s.to]].filter(([a, b]) => b > a);
    if (!sides.length) continue;
    const whole = textRangeBox(full, s.from, s.to);
    if (!whole) continue;
    for (const [a, b] of sides) {
      const part = textRangeBox(full, a, b);
      if (part) out = textRuns.applyStyle(out, a, b, { gradient: genDraw.rebaseGradient(s.gradient, whole, part) });
    }
  }
  return out;
}

// ---- the modal ----

/**
 * The letters the modal is for: the selection; with a bare caret the stretch
 * of gradient it stands in, so one can be edited without selecting exactly
 * its letters again, and otherwise the whole text, which is also what Render
 * Preview's tools act on.
 */
function textGradientTarget() {
  const len = textLength();
  if (!len) return null;
  const { from, to } = textTarget();
  if (to > from) return { from, to };
  const inside = textRuns.stretches(textFull).find((s) => s.from <= from && from <= s.to);
  return inside ? { from: inside.from, to: inside.to } : { from: 0, to: len };
}

// A gradient as the modal shows it, and back into shares of the letters' box.
function tgShownOf(g) {
  const reach = genDraw.gradientReach(g.angle, tgBox.w, tgBox.h);
  return {
    stops: g.stops.map((stop) => ({ at: stop.at, color: stop.color })),
    start: Math.round(g.start * reach),
    end: Math.round(g.end * reach),
    angle: Math.round(g.angle),
  };
}

// An end that was not moved keeps the share it had, rather than the share
// the whole pixel it showed as comes to: edge to edge stays edge to edge when
// only a colour was changed.
function tgStoredOf(shown) {
  const reach = Math.max(1e-6, genDraw.gradientReach(shown.angle, tgBox.w, tgBox.h));
  const was = JSON.parse(tgOpened);
  const share = (name) => (shown.angle === was.angle && shown[name] === was[name]
    ? tgStored[name]
    : Math.round(shown[name] / reach * 1e4) / 1e4);
  return timelineModel.textGradientOf({
    stops: shown.stops,
    start: share('start'),
    end: share('end'),
    angle: shown.angle === was.angle ? tgStored.angle : shown.angle,
  });
}

// The gradient the letters would have on Apply: the one they have, when
// nothing has been touched, so opening and applying never rounds one.
function tgEffect() {
  return JSON.stringify(tgDraft) === tgOpened ? tgStored : tgStoredOf(tgDraft);
}

// The text as Apply would leave it, which is what the preview draws.
function tgGen() {
  const full = applyTextProps(textFull, tgTarget.from, tgTarget.to, { gradient: tgEffect() });
  const c = textRuns.compress(full, textDraft.text.style);
  return textGenOf({ ...textDraft, text: { ...textDraft.text, runs: c.runs, style: c.style } });
}

function paintTextGradient(quick) {
  if (!tgDraft || !textDraft) return;
  paintGenPreview(textGradStage, textGradPreview, textLayerId, tgGen(), quick);
}

// The middle of the letters on the preview, where the text's turn has put it:
// the drawing turns the text about its box's centre.
function tgCentre() {
  const c = { x: tgBox.x + tgBox.w / 2, y: tgBox.y + tgBox.h / 2 };
  const turn = textDraft ? textDraft.text.rotation : 0;
  if (!turn) return c;
  const b = textBoxNow();
  const ox = b.x + b.w / 2;
  const oy = b.y + b.h / 2;
  const a = turn * Math.PI / 180;
  const dx = c.x - ox;
  const dy = c.y - oy;
  return { x: ox + dx * Math.cos(a) - dy * Math.sin(a), y: oy + dx * Math.sin(a) + dy * Math.cos(a) };
}

const textGrad = makeGradientEditor({
  bar: textGradBar,
  canvas: el('textGradCanvas'),
  start: el('textGradStart'),
  end: el('textGradEnd'),
  angle: el('textGradAngle'),
  line: textGradLine,
  stage: textGradStage,
  reach: () => GRAD_REACH,
  get: () => tgDraft,
  on: () => !!tgDraft,
  set: (props, quick, except) => setTextGradient(props, quick, except),
  centre: tgCentre,
  turn: () => (textDraft ? textDraft.text.rotation : 0),
  pick: (color, live) => pickColor(color, live, textModal),
  owner: () => (tgDraft ? textLayerId : null),
});

/** The gradient changed: `quick` while something is being dragged. */
function setTextGradient(props, quick, except) {
  if (!tgDraft) return;
  tgDraft = { ...tgDraft, ...props };
  textGrad.showBoxes(except || null);
  textGrad.paintBar(!quick);
  textGrad.placeLine();
  paintTextGradient(quick);
}

function sizeTextGradStage() {
  sizeGenStage(textGradStage, textGradPreview);
  // The bar as wide as the preview, as Shape Settings has it.
  textGradBar.style.width = textGradStage.style.width;
  textGradHelp.style.width = textGradStage.style.width;
  textGrad.paintBar(true);
  textGrad.placeLine();
}

/** The window was resized under it. */
function relayoutTextGradient() {
  if (!tgDraft || !textDraft) return;
  sizeTextGradStage();
  paintTextGradient(false);
}

function openTextGradient() {
  if (!textDraft || tgDraft || fxKind) return;
  const target = textGradientTarget();
  if (!target) return;
  const box = textRangeBox(textFull, target.from, target.to);
  if (!box || !(box.w > 0) || !(box.h > 0)) return;
  const shown = textRuns.selectionStyle(textFull, target.from, target.to);
  const first = shown.style.gradient || null;
  tgTarget = target;
  tgBox = box;
  tgWasOn = !!first;
  tgUniform = !!first && !shown.mixed.includes('gradient');
  // What the letters have is measured from the stretch they are part of,
  // which may be longer than what was selected, or shorter. Said from the
  // selected letters' own box it is the same line on the picture.
  tgStored = timelineModel.textGradientOf({});
  if (first) {
    const s = textRuns.stretches(textFull).find((x) => x.from <= target.from && target.from < x.to);
    const whole = s && !(s.from === target.from && s.to === target.to) ? textRangeBox(textFull, s.from, s.to) : null;
    tgStored = whole ? genDraw.rebaseGradient(first, whole, box) : first;
  }
  tgDraft = tgShownOf(tgStored);
  tgOpened = JSON.stringify(tgDraft);
  // "The first time there is nothing to remove", as Outline and Shadow say.
  textGradRemoveBtn.hidden = !tgWasOn;
  textGradBackground.checked = genBackdropOn;
  fontCombo.close();
  sizeCombo.close();
  // Over the media window when it is out.
  carryOver(textGradModal, textModal);
  textGradModal.hidden = false;
  // Looking where Edit Text is looking, zoomed and panned as it is.
  const from = stageViews.get(textStage);
  const view = stageViews.get(textGradStage);
  if (from && view) {
    view.zoom = from.zoom;
    view.cx = from.cx;
    view.cy = from.cy;
    showStageZoom(textGradStage);
  }
  sizeTextGradStage();
  textGrad.showBoxes(null);
  paintTextGradient(false);
  textGradApplyBtn.focus();
}

function closeTextGradient(refocus) {
  if (!tgDraft) return;
  settlePick(false);
  textGradModal.hidden = true;
  carryBack(textGradModal);
  textGradLine.hidden = true;
  tgTarget = null;
  tgBox = null;
  tgDraft = null;
  tgOpened = null;
  tgStored = null;
  tgWasOn = false;
  tgUniform = false;
  if (refocus) refocusTextEdit();
}

// Back into the words, the selection as it was.
function refocusTextEdit() {
  if (!textDraft || textModal.hidden || textMode !== 'edit') return;
  textEditBox.focus();
  setBoxSelection(textSel.anchor ?? textSel.from, textSel.focus ?? textSel.to);
}

/**
 * `props` onto the letters the modal was for, one step on the box's undo,
 * whatever the selection has done meanwhile; a bare caret is put back where
 * it stood.
 */
function formatTextRange(target, props) {
  const keep = { ...textSel };
  textSel = { from: target.from, to: target.to, anchor: target.from, focus: target.to };
  textPending = null;
  formatText(props, null);
  textSel = keep;
  refocusTextEdit();
}

function applyTextGradient() {
  if (!tgDraft || !textDraft) return;
  const target = tgTarget;
  const effect = tgEffect();
  // Letters that all have it already, with nothing touched: nothing to do.
  const same = tgUniform && JSON.stringify(tgDraft) === tgOpened;
  closeTextGradient(false);
  if (same) refocusTextEdit();
  else formatTextRange(target, { gradient: effect });
}

// The letters back to their colour.
function removeTextGradient() {
  if (!tgDraft || !textDraft) return;
  const target = tgTarget;
  closeTextGradient(false);
  formatTextRange(target, { gradient: null });
}

// The selection stays in the words while the button is pressed, like the
// tools beside it.
textGradientBtn.addEventListener('mousedown', (evt) => evt.preventDefault());
textGradientBtn.addEventListener('click', openTextGradient);

textGradApplyBtn.addEventListener('click', applyTextGradient);
textGradRemoveBtn.addEventListener('click', removeTextGradient);
textGradCancelBtn.addEventListener('click', () => closeTextGradient(true));

textGradBackground.addEventListener('change', () => {
  genBackdropOn = textGradBackground.checked;
  textBackground.checked = genBackdropOn;
  paintTextGradient(false);
  paintTextPreview();
});

// The wheel zooms and empty space pans, as on Edit Text's own preview; the
// gradient is drawn with the right button, so the left one is free for it.
bindStageView(textGradStage, {
  open: () => !!tgDraft && !textGradModal.hidden,
  empty: (evt) => evt.target === textGradStage || evt.target === textGradPreview,
  redraw: (quick) => {
    textGrad.placeLine();
    paintTextGradient(quick);
  },
});

window.addEventListener('resize', relayoutTextGradient);

// Over Edit Text: Cancel here, and Edit Text stays.
bindPopup(textGradModal, () => closeTextGradient(true), 2);
