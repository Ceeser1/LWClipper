'use strict';

// V4.10. Transitions: the window a fade's right click menu opens.
//
// The user: "When rightclicking fade-in or fade-out (also at overlapping
// tracks) below the 3x3 grid of fade curves add a row "Transision" which
// opens a window where you can select one of pre-defined transitions. A
// transition always takes an "old" track and a "new" track ... The
// transitions window: A row of buttons with existing transitions to select
// from, each with its own settings when selected." And afterwards: "If a
// transition is applied, show a icon-button in the center of the fade-in/out
// or overlap so the transition window can be opened again by clicking it".
//
// A transition is what a fade does to the picture in place of fading it
// (timeline.js "Transitions"), so the window is opened on one end of one
// track: its start, its end, or where it overlaps the track before it, in
// which case the choice is both tracks'. It shows the transitions in a row,
// the chosen one's settings, how long it takes, and a small picture of it
// running from an old picture to a new one, drawn by the drawing the preview
// and the export use. The main preview shows the track as Accept would leave
// it meanwhile, as it does for every editor window, and the playhead is put
// in the middle of the fade when it is somewhere else, so there is something
// of the transition to see there.
//
// The draft keeps each kind's settings while the window is open, so trying
// another one and coming back does not lose them. Accept writes the chosen
// one, and the fade's length when that was changed, as one undo step; an
// Accept that changed nothing writes nothing.

const transitionModal = el('transitionModal');
const transitionTitle = el('transitionTitle');
const transitionWhere = el('transitionWhere');
const transitionKinds = el('transitionKinds');
const transitionDemo = el('transitionDemo');
const transitionGrid = el('transitionGrid');
const transitionDirs = el('transitionDirs');
const transitionShapes = el('transitionShapes');
const transitionReverse = el('transitionReverse');
const transitionClock = el('transitionClock');
const transitionStarts = el('transitionStarts');
const transitionCountSlider = el('transitionCountSlider');
const transitionCountBox = el('transitionCountBox');
const transitionSlats = el('transitionSlats');
const transitionRowsSlider = el('transitionRowsSlider');
const transitionRowsBox = el('transitionRowsBox');
const transitionTurnsSlider = el('transitionTurnsSlider');
const transitionTurnsBox = el('transitionTurnsBox');
const transitionSoftSlider = el('transitionSoftSlider');
const transitionSoftBox = el('transitionSoftBox');
const transitionSecondsBox = el('transitionSecondsBox');
const transitionCancelBtn = el('transitionCancelBtn');
const transitionAcceptBtn = el('transitionAcceptBtn');

// What a fade that has no length yet is given when a transition is chosen
// for it, so the choice shows: this long, or half the clip when that is less.
const TRANSITION_SECONDS = 1;
// The little picture: the old one held, the way across, the new one held.
const DEMO_HOLD_OLD = 0.45;
const DEMO_RUN = 1.3;
const DEMO_HOLD_NEW = 0.65;
const DEMO_W = 320;
const DEMO_H = 180;

let transitionLayerId = null;
let transitionEnd = null;      // 'in' or 'out'
// { kind: 'fade' or one of timelineModel.TRANSITION_KINDS, byKind: each
// kind's settings as last set here, seconds: the fade's length }
let transitionDraft = null;
let transitionTimer = 0;
let transitionShownKey = '';
let transitionShownLayers = null;
let transitionDraftList = null;
let transitionPictures = null;

/**
 * What each transition is called. Each name is a literal in a t() call and
 * not built, which is what the locale checker can see.
 */
function transitionLabels() {
  return {
    fade: t('Fade'),
    wipe: t('Wipe'),
    iris: t('Iris'),
    clock: t('Clock'),
    blinds: t('Blinds'),
    dissolve: t('Dissolve'),
    slide: t('Slide'),
    zoom: t('Zoom'),
  };
}

/** A transition's name, the plain fade's for none. */
function transitionName(transition) {
  return transitionLabels()[transition ? transition.kind : 'fade'] || t('Fade');
}

/** The window open as a conflict confirmPopoutConflict can name. */
function transitionWindowConflict() {
  if (transitionModal.hidden) return null;
  return {
    message: t('The Transition window is open. Going on closes it and discards what it has not accepted.'),
    close: cancelTransition,
  };
}

/** The overlap the window's end is part of right now, or null. */
function transitionCross() {
  return transitionLayerId ? timelineModel.overlapOf(layers, transitionLayerId, transitionEnd) : null;
}

/** The transition the draft stands for: null for the plain fade. */
function transitionOfDraft() {
  const d = transitionDraft;
  if (!d || d.kind === 'fade') return null;
  return timelineModel.transitionSettingsOf({ kind: d.kind, ...d.byKind[d.kind] });
}

/**
 * The timeline as Accept would leave it: the fade's length where it is the
 * window's to set, then the transition, through the model, so an overlap's
 * other track is written the way the model writes it. The list it was given
 * when nothing would change.
 */
function applyTransitionDraft(list) {
  const d = transitionDraft;
  const live = timelineModel.layerById(list, transitionLayerId);
  if (!d || !live) return list;
  let next = list;
  if (!timelineModel.overlapOf(list, transitionLayerId, transitionEnd)
    && Math.abs(timelineModel.fadesOf(live)[transitionEnd] - d.seconds) > 1e-6) {
    next = timelineModel.fadeGroup(next, transitionLayerId, transitionEnd, d.seconds);
  }
  next = timelineModel.setTransition(next, transitionLayerId, transitionEnd, transitionOfDraft());
  return next.every((l, i) => l === list[i]) ? list : next;
}

/** The draft's timeline, worked out again only when the draft or the list changed. */
function transitionDraftLayers() {
  const key = JSON.stringify(transitionDraft);
  if (key !== transitionShownKey || layers !== transitionShownLayers || !transitionDraftList) {
    transitionShownKey = key;
    transitionShownLayers = layers;
    transitionDraftList = applyTransitionDraft(layers);
  }
  return transitionDraftList;
}

/**
 * Transitions for one end of a track: `which` is 'in' for its start and
 * 'out' for its end. Where that end overlaps another track the window is the
 * overlap's, opened on the later track's start whichever end was pressed.
 * The same one already open is brought forward; another asks first.
 */
function openTransition(layerId, which) {
  const pressed = timelineModel.layerById(layers, layerId);
  if (!pressed || pressed.type !== 'video' || busy || !timelineDriving()) return;
  const cross = timelineModel.overlapOf(layers, layerId, which);
  const id = cross ? cross.into : layerId;
  const end = cross ? 'in' : (which === 'out' ? 'out' : 'in');
  if (!transitionModal.hidden) {
    if (transitionLayerId === id && transitionEnd === end) {
      focusPopOut(transitionModal);
      return;
    }
    confirmPopoutConflict([transitionWindowConflict()], () => openTransition(layerId, which));
    return;
  }
  const layer = timelineModel.layerById(layers, id);
  if (!layer) return;
  selectLayer(layer.id);
  transitionLayerId = id;
  transitionEnd = end;
  const current = timelineModel.transitionsOf(layer)[end];
  const byKind = {};
  for (const kind of timelineModel.TRANSITION_KINDS) {
    const { kind: _, ...settings } = current && current.kind === kind ? current : timelineModel.transitionDefault(kind);
    byKind[kind] = settings;
  }
  const length = timelineModel.fadesOf(layer)[end];
  transitionDraft = {
    kind: current ? current.kind : 'fade',
    byKind,
    seconds: length > 0 ? length : Math.round(Math.min(TRANSITION_SECONDS, layer.duration / 2) * 1000) / 1000,
  };
  transitionShownKey = '';
  transitionDraftList = null;
  transitionTitle.textContent = editorTitle(t('Transition'), layer);
  // Three calls, so check-locales sees each literal.
  transitionWhere.textContent = cross
    ? t('Between two overlapping tracks')
    : (end === 'in' ? t('Start of the track') : t('End of the track'));
  transitionModal.hidden = false;
  showTransitionDraft(null);
  drawTransitionKinds();
  // The playhead into the fade when it is somewhere else, so the main
  // preview has the transition in it.
  const from = end === 'in' ? layer.start : timelineModel.endOf(layer) - transitionDraft.seconds;
  if (!(compositeAt > from && compositeAt < from + transitionDraft.seconds)) {
    if (compositePlaying) pauseComposite();
    seekTimeline(from + transitionDraft.seconds / 2);
  }
  popOut(transitionModal, 'transition', {
    title: transitionTitle.textContent,
    cancel: cancelTransition,
    relayout: fitTransitionWindow,
    preview: previewTransitionDraft,
    noDock: true,
  }, true);
  clearInterval(transitionTimer);
  transitionTimer = setInterval(drawTransitionDemo, 33);
  previewTransitionDraft();
  drawTransitionDemo();
}

/** The window as tall as what it holds. */
function fitTransitionWindow() {
  const panel = transitionModal.querySelector('.modal__panel') || transitionTitle.parentElement;
  if (!panel) return;
  notePopoutWant(panel, panel.scrollHeight);
  fitPopOut(transitionModal);
}

function closeTransition() {
  if (transitionModal.hidden) return;
  clearInterval(transitionTimer);
  transitionTimer = 0;
  popIn(transitionModal);
  clearPopoutPreview(transitionModal.id);
  clearPopoutPreview(transitionModal.id + ':from');
  transitionModal.hidden = true;
  transitionLayerId = null;
  transitionEnd = null;
  transitionDraft = null;
  transitionDraftList = null;
  transitionShownLayers = null;
  drawComposite();
}

function cancelTransition() {
  closeTransition();
}

function acceptTransition() {
  if (!transitionDraft) return;
  const next = applyTransitionDraft(layers);
  closeTransition();
  if (next === layers) return;
  setLayers(next);
  commitHistory();
}

/**
 * POPOUT_FPS times a second while the window is open: the main preview shows
 * the track, and the one it overlaps, as Accept would leave them. A track
 * gone from under the window takes the window with it.
 */
function previewTransitionDraft() {
  if (transitionModal.hidden || !transitionDraft) return;
  const live = timelineModel.layerById(layers, transitionLayerId);
  if (!live) {
    cancelTransition();
    return;
  }
  const key = JSON.stringify(transitionDraft);
  if (key === transitionShownKey && layers === transitionShownLayers && transitionDraftList) return;
  // The timeline changed under the window: an overlap's length is shown here.
  if (layers !== transitionShownLayers) showTransitionDraft(null);
  const id = transitionLayerId;
  setPopoutPreview(transitionModal.id, {
    layerId: id,
    layerNow: () => timelineModel.layerById(transitionDraftLayers(), id),
  });
  // The earlier of two overlapping tracks goes through some of them too.
  const cross = transitionCross();
  if (cross) {
    setPopoutPreview(transitionModal.id + ':from', {
      layerId: cross.from,
      layerNow: () => timelineModel.layerById(transitionDraftLayers(), cross.from),
    });
  } else {
    clearPopoutPreview(transitionModal.id + ':from');
  }
  transitionDraftLayers();
  // A fade made longer or shorter here is drawn on the clip only at Accept;
  // the picture shows it now.
  drawComposite();
}

// ---- the settings ----

/** The window's controls brought to the draft. `except` is a box being typed in. */
function showTransitionDraft(except) {
  const d = transitionDraft;
  if (!d) return;
  const own = d.kind === 'fade' ? {} : d.byKind[d.kind];
  for (const b of transitionKinds.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.kind === d.kind);
  }
  for (const field of transitionGrid.querySelectorAll('.gen-field[data-for]')) {
    field.hidden = !field.dataset.for.split(' ').includes(d.kind);
  }
  // A slide goes along one of the four sides; a wipe may go corner to corner.
  for (const b of transitionDirs.querySelectorAll('button')) {
    const angle = Number(b.dataset.angle);
    b.hidden = d.kind === 'slide' && angle % 90 !== 0;
    b.classList.toggle('btn--active', angle === own.angle);
  }
  for (const b of transitionShapes.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.shape === own.shape);
  }
  transitionReverse.checked = !!own.reverse;
  for (const b of transitionClock.querySelectorAll('button')) {
    b.classList.toggle('btn--active', (b.dataset.clockwise === 'true') === (own.clockwise !== false));
  }
  for (const b of transitionStarts.querySelectorAll('button')) {
    b.classList.toggle('btn--active', Number(b.dataset.start) === own.start);
  }
  for (const b of transitionSlats.querySelectorAll('button')) {
    b.classList.toggle('btn--active', (b.dataset.vertical === 'true') === !!own.vertical);
  }
  const show = (slider, box, value, text) => {
    if (value === undefined) return;
    if (slider) slider.value = String(value);
    if (except !== box) box.value = text === undefined ? String(value) : text;
  };
  show(transitionCountSlider, transitionCountBox, own.count);
  show(transitionRowsSlider, transitionRowsBox, own.rows);
  if (own.turns !== undefined) show(transitionTurnsSlider, transitionTurnsBox, Math.round(own.turns * 4), String(own.turns));
  if (own.soft !== undefined) show(transitionSoftSlider, transitionSoftBox, Math.round(own.soft * 100));
  // An overlap is as long as the two tracks overlap, which is the timeline's
  // to say, so there the length is only shown.
  const cross = transitionCross();
  transitionSecondsBox.disabled = !!cross;
  if (except !== transitionSecondsBox) {
    transitionSecondsBox.value = (cross ? cross.overlap : d.seconds).toFixed(2);
  }
}

/** One of the chosen kind's settings changed. */
function changeTransition(props, except) {
  const d = transitionDraft;
  if (!d || d.kind === 'fade') return;
  d.byKind[d.kind] = { ...d.byKind[d.kind], ...props };
  // Through the model, so what the window shows is what it will write.
  const { kind: _, ...settings } = timelineModel.transitionSettingsOf({ kind: d.kind, ...d.byKind[d.kind] });
  d.byKind[d.kind] = settings;
  showTransitionDraft(except);
  previewTransitionDraft();
}

function chooseTransitionKind(kind) {
  if (!transitionDraft || transitionDraft.kind === kind) return;
  transitionDraft.kind = kind;
  showTransitionDraft(null);
  fitTransitionWindow();
  previewTransitionDraft();
}

transitionKinds.addEventListener('click', (evt) => {
  const b = evt.target.closest('button[data-kind]');
  if (b) chooseTransitionKind(b.dataset.kind);
});
transitionDirs.addEventListener('click', (evt) => {
  const b = evt.target.closest('button[data-angle]');
  if (b) changeTransition({ angle: Number(b.dataset.angle) }, null);
});
transitionShapes.addEventListener('click', (evt) => {
  const b = evt.target.closest('button[data-shape]');
  if (b) changeTransition({ shape: b.dataset.shape }, null);
});
transitionReverse.addEventListener('change', () => changeTransition({ reverse: transitionReverse.checked }, null));
transitionClock.addEventListener('click', (evt) => {
  const b = evt.target.closest('button[data-clockwise]');
  if (b) changeTransition({ clockwise: b.dataset.clockwise === 'true' }, null);
});
transitionStarts.addEventListener('click', (evt) => {
  const b = evt.target.closest('button[data-start]');
  if (b) changeTransition({ start: Number(b.dataset.start) }, null);
});
transitionSlats.addEventListener('click', (evt) => {
  const b = evt.target.closest('button[data-vertical]');
  if (b) changeTransition({ vertical: b.dataset.vertical === 'true' }, null);
});

bindNumberField({
  slider: transitionCountSlider,
  box: transitionCountBox,
  range: () => [2, 64],
  set: (n, except) => changeTransition({ count: n }, except),
  show: () => showTransitionDraft(null),
});
bindNumberField({
  slider: transitionRowsSlider,
  box: transitionRowsBox,
  range: () => [2, 200],
  set: (n, except) => changeTransition({ rows: n }, except),
  show: () => showTransitionDraft(null),
});
bindNumberField({
  slider: transitionSoftSlider,
  box: transitionSoftBox,
  range: () => [0, 100],
  set: (n, except) => changeTransition({ soft: n / 100 }, except),
  show: () => showTransitionDraft(null),
});

// The turns are quarter turns on the slider and a plain number in the box,
// 1.5 for a turn and a half, so the box is read as a decimal.
transitionTurnsSlider.addEventListener('input', () => {
  changeTransition({ turns: Number(transitionTurnsSlider.value) / 4 }, null);
});

/** A box holding a decimal number: Enter and leaving it settle it. */
function bindDecimalBox(box, take) {
  box.addEventListener('input', () => {
    const n = Number(box.value.trim().replace(',', '.'));
    if (box.value.trim() !== '' && Number.isFinite(n)) take(n);
  });
  box.addEventListener('blur', () => showTransitionDraft(null));
  box.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter') return;
    evt.preventDefault();
    box.blur();
  });
}

bindDecimalBox(transitionTurnsBox, (n) => changeTransition({ turns: n }, transitionTurnsBox));
bindDecimalBox(transitionSecondsBox, (n) => {
  const d = transitionDraft;
  const live = timelineModel.layerById(layers, transitionLayerId);
  if (!d || !live || transitionCross()) return;
  // No shorter than a frame, and no longer than the room the other fade
  // leaves: the two fades of a clip never overlap.
  const fps = projectFrame().fps || 30;
  const other = timelineModel.fadesOf(live)[transitionEnd === 'in' ? 'out' : 'in'];
  const most = Math.max(1 / fps, live.duration - other);
  d.seconds = Math.round(Math.min(most, Math.max(1 / fps, n)) * 1000) / 1000;
  showTransitionDraft(transitionSecondsBox);
  previewTransitionDraft();
});

transitionAcceptBtn.addEventListener('click', acceptTransition);
transitionCancelBtn.addEventListener('click', cancelTransition);

bindPopup(transitionModal, cancelTransition);

// ---- the little picture ----

/**
 * The two pictures the demonstration runs between: an old one and a new
 * one, each a letter on its own colour, and the squares that stand for
 * nothing at all where a track has no other track to come from or go to.
 */
function transitionDemoPictures() {
  if (transitionPictures) return transitionPictures;
  const make = (fill, ink, letter) => {
    const c = new OffscreenCanvas(DEMO_W, DEMO_H);
    const x = c.getContext('2d');
    x.fillStyle = fill;
    x.fillRect(0, 0, DEMO_W, DEMO_H);
    x.fillStyle = ink;
    x.font = 'bold 120px Arial, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(letter, DEMO_W / 2, DEMO_H / 2 + 8);
    return c;
  };
  const none = new OffscreenCanvas(DEMO_W, DEMO_H);
  const n = none.getContext('2d');
  const cell = 12;
  for (let y = 0; y < DEMO_H; y += cell) {
    for (let x = 0; x < DEMO_W; x += cell) {
      n.fillStyle = ((x / cell + y / cell) % 2) ? '#2b2b31' : '#222227';
      n.fillRect(x, y, cell, cell);
    }
  }
  transitionPictures = {
    a: make('#3b4f78', '#c9d6f2', 'A'),
    b: make('#7a4a3a', '#f4d9c8', 'B'),
    none,
  };
  return transitionPictures;
}

/**
 * The demonstration at `e` of the way across, onto a context whose canvas is
 * `k` of the demonstration's size: the old picture, and the new one coming
 * through the transition over it. `kind` is how the window was opened: both
 * pictures for an overlap, and nothing where there is no other track.
 */
function drawTransitionAt(ctx, transition, e, kind, k) {
  const pics = transitionDemoPictures();
  const box = { x: 0, y: 0, w: DEMO_W, h: DEMO_H, rotation: 0 };
  const lay = (picture, half) => {
    if (!picture) return;
    if (!half) {
      ctx.drawImage(picture, 0, 0, DEMO_W, DEMO_H, 0, 0, DEMO_W * k, DEMO_H * k);
      return;
    }
    if (!transition) {
      ctx.globalAlpha = half === 'in' ? e : 1 - e;
      ctx.drawImage(picture, 0, 0, DEMO_W, DEMO_H, 0, 0, DEMO_W * k, DEMO_H * k);
      ctx.globalAlpha = 1;
      return;
    }
    genDraw.drawGenTransition(ctx, picture, { half, transition, e }, box, DEMO_W, DEMO_H, k, k);
  };
  lay(pics.none, null);
  const oldPic = kind === 'in' ? null : pics.a;
  const newPic = kind === 'out' ? null : (kind === 'in' ? pics.a : pics.b);
  // Two pictures that cover each other: the old one stays whole under the
  // new one, unless the transition moves it out of the way. On its own it
  // goes out through the transition.
  if (oldPic) lay(oldPic, newPic && !timelineModel.transitionMovesOld(transition) ? null : 'out');
  if (newPic) lay(newPic, 'in');
}

/** The running demonstration, on the window's canvas. */
function drawTransitionDemo() {
  if (transitionModal.hidden || !transitionDraft) return;
  const ratio = Math.min(2, hostWindowOf(transitionDemo).devicePixelRatio || 1);
  const w = Math.round(DEMO_W * ratio);
  const h = Math.round(DEMO_H * ratio);
  if (transitionDemo.width !== w) transitionDemo.width = w;
  if (transitionDemo.height !== h) transitionDemo.height = h;
  const ctx = transitionDemo.getContext('2d');
  const live = timelineModel.layerById(layers, transitionLayerId);
  const cross = transitionCross();
  const curve = live ? timelineModel.fadeCurvesOf(live)[transitionEnd] : 'linear';
  const period = DEMO_HOLD_OLD + DEMO_RUN + DEMO_HOLD_NEW;
  const at = (performance.now() / 1000) % period;
  const p = Math.min(1, Math.max(0, (at - DEMO_HOLD_OLD) / DEMO_RUN));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawTransitionAt(ctx, transitionOfDraft(), timelineModel.fadeShape(curve, p),
    cross ? 'both' : transitionEnd, ratio);
}

/** Each button's picture: its transition half way, as it is by default. */
function drawTransitionKinds() {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  for (const b of transitionKinds.querySelectorAll('button[data-kind]')) {
    const canvas = b.querySelector('canvas');
    if (!canvas) continue;
    const w = 56;
    const h = 32;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    const kind = b.dataset.kind;
    drawTransitionAt(ctx, kind === 'fade' ? null : timelineModel.transitionDefault(kind), 0.5, 'both',
      (w * ratio) / DEMO_W);
  }
}
