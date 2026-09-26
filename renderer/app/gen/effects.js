'use strict';

// V3. The Outline and Shadow modals over Edit Text.

// ---- V3, 30g. Outline and Shadow ----
//
// One modal for each, over Edit Text, and what they edit is that modal's draft
// rather than the layer: Apply puts the effect into the draft and Remove takes
// it out, and Edit Text's own Accept or Cancel decides whether any of it
// reaches the layer. An outline applied and then cancelled in Edit Text is
// gone again, which is what the user asked for.
//
// The figures show in project pixels, like the size box, and 1 to 64 as the
// user gave them; they go into the draft at its refHeight to two decimals. An
// Apply that changed nothing leaves the stored figures alone, so opening and
// applying never rounds an effect set at another height.

const shadowArrow = el('shadowArrow');

function fxField(id, min, max, px) {
  return { slider: el(id + 'Slider'), box: el(id + 'Box'), min, max, px };
}

const FX = {
  outline: {
    modal: el('outlineModal'),
    stage: el('outlineStage'),
    canvas: el('outlineCanvas'),
    colorBtn: el('outlineColorBtn'),
    background: el('outlineBackground'),
    applyBtn: el('outlineApplyBtn'),
    removeBtn: el('outlineRemoveBtn'),
    cancelBtn: el('outlineCancelBtn'),
    button: textOutlineBtn,
    fields: {
      width: fxField('outlineWidth', 1, timelineModel.GEN_EFFECT_MAX, true),
    },
  },
  shadow: {
    modal: el('shadowModal'),
    stage: el('shadowStage'),
    canvas: el('shadowCanvas'),
    colorBtn: el('shadowColorBtn'),
    background: el('shadowBackground'),
    applyBtn: el('shadowApplyBtn'),
    removeBtn: el('shadowRemoveBtn'),
    cancelBtn: el('shadowCancelBtn'),
    button: textShadowBtn,
    fields: {
      angle: fxField('shadowAngle', -180, 180, false),
      distance: fxField('shadowDistance', 1, timelineModel.GEN_EFFECT_MAX, true),
      size: fxField('shadowSize', 1, timelineModel.GEN_EFFECT_MAX, true),
      // Percent in the modal, a fraction in the file, like the layer's alpha.
      fade: fxField('shadowFade', 0, 100, false),
    },
  },
};

let fxKind = null;      // 'outline' or 'shadow' while one is open
let fxDraft = null;     // the effect as the modal shows it: project pixels, fade in percent
let fxOpened = null;    // fxDraft as it opened, as JSON
let fxWasOn = false;    // whether the text had this effect when the modal opened

// An effect as the modal shows it, from the draft's own pixels.
function fxShownOf(kind, effect) {
  const k = textScale();
  const px = (v) => Math.max(1, Math.round(v * k));
  if (kind === 'outline') return { color: effect.color, width: px(effect.width) };
  return {
    color: effect.color,
    angle: Math.round(effect.angle),
    distance: px(effect.distance),
    size: px(effect.size),
    fade: Math.round(effect.fade * 100),
  };
}

// And back, into the draft's own pixels.
function fxStoredOf(kind, shown) {
  const k = textScale();
  const ref = (v) => Math.round(v / k * 100) / 100;
  if (kind === 'outline') return { color: shown.color, width: ref(shown.width) };
  return {
    color: shown.color,
    angle: shown.angle,
    distance: ref(shown.distance),
    size: ref(shown.size),
    fade: shown.fade / 100,
  };
}

// The effect the text would have on Apply: the one it has, when nothing has
// been touched, so the preview is exactly what Apply leaves.
function fxEffect() {
  if (fxWasOn && JSON.stringify(fxDraft) === fxOpened) return textDraft.text.style[fxKind];
  return fxStoredOf(fxKind, fxDraft);
}

// A text's effect as the model fills one in with nothing given: an outline
// 4 wide in black, a shadow of black at 70% falling 45 degrees, 8 off and 8
// deep, fading out entirely.
function fxDefaults(kind) {
  const g = timelineModel.genOf({ form: 'text', text: { style: { [kind]: {} } } });
  return g.text.style[kind];
}

function openFx(kind) {
  if (!textDraft || fxKind) return;
  const fx = FX[kind];
  const now = textDraft.text.style[kind];
  fxKind = kind;
  fxWasOn = !!now;
  // A first opening starts from the defaults in the draft's own pixels, so
  // they are the same size on the picture whatever the project's height.
  fxDraft = fxShownOf(kind, now || { ...fxDefaults(kind) });
  fxOpened = JSON.stringify(fxDraft);
  // "The first time there is nothing to remove".
  fx.removeBtn.hidden = !fxWasOn;
  fx.background.checked = genBackdropOn;
  fontCombo.close();
  sizeCombo.close();
  fx.modal.hidden = false;
  showFx(null);
  sizeGenStage(fx.stage, fx.canvas);
  paintFx(false);
  fx.applyBtn.focus();
}

function closeFx(refocus) {
  if (!fxKind) return;
  settlePick(false);
  FX[fxKind].modal.hidden = true;
  fxKind = null;
  fxDraft = null;
  fxOpened = null;
  fxWasOn = false;
  if (refocus && !textModal.hidden && textMode === 'edit') textEditBox.focus();
}

function showFx(except) {
  const fx = FX[fxKind];
  paintSwatch(fx.colorBtn, fxDraft.color);
  for (const [name, f] of Object.entries(fx.fields)) {
    // A figure past the slider's end, from a text set at a lower height, shows
    // in the box as it is and pins the slider at its end.
    f.slider.value = String(fxDraft[name]);
    if (except !== f.box) f.box.value = String(fxDraft[name]);
  }
  if (fxKind === 'shadow') shadowArrow.style.transform = 'rotate(' + fxDraft.angle + 'deg)';
}

function paintFx(quick) {
  if (!fxKind || !textDraft) return;
  const style = { ...textDraft.text.style, [fxKind]: fxEffect() };
  const gen = textGenOf({ ...textDraft, text: { ...textDraft.text, style } });
  paintGenPreview(FX[fxKind].stage, FX[fxKind].canvas, textLayerId, gen, quick);
}

function changeFx(props, except, quick) {
  if (!fxKind) return;
  fxDraft = { ...fxDraft, ...props };
  showFx(except);
  paintFx(quick);
}

function applyFx() {
  if (!fxKind || !textDraft) return;
  const kind = fxKind;
  const effect = fxEffect();
  closeFx(true);
  changeTextStyle({ [kind]: effect }, null);
}

// "Remove button completely removes the selected options": the effect off,
// not an effect of nothing.
function removeFx() {
  if (!fxKind || !textDraft) return;
  const kind = fxKind;
  closeFx(true);
  changeTextStyle({ [kind]: null }, null);
}

for (const [kind, fx] of Object.entries(FX)) {
  fx.button.addEventListener('click', () => openFx(kind));

  for (const [name, f] of Object.entries(fx.fields)) {
    // Drawn small while the slider moves and in full once it is let go.
    bindNumberField({
      slider: f.slider,
      box: f.box,
      range: () => [f.min, f.max],
      set: (n, except, quick) => {
        if (fxKind === kind) changeFx({ [name]: n }, except, quick);
      },
      settle: () => {
        if (fxKind === kind) paintFx(false);
      },
      show: () => {
        if (fxKind === kind) showFx(null);
      },
    });
  }

  fx.colorBtn.addEventListener('click', async () => {
    if (fxKind !== kind) return;
    const was = fxDraft.color;
    const picked = await pickColor(was, (color) => {
      if (fxKind === kind) changeFx({ color }, null, true);
    });
    // The modal may have been closed under the picker, by Escape for one.
    if (fxKind !== kind) return;
    changeFx({ color: picked || was }, null, false);
  });

  fx.background.addEventListener('change', () => {
    genBackdropOn = fx.background.checked;
    textBackground.checked = genBackdropOn;
    paintFx(false);
    paintTextPreview();
  });

  fx.applyBtn.addEventListener('click', applyFx);
  fx.removeBtn.addEventListener('click', removeFx);
  fx.cancelBtn.addEventListener('click', () => closeFx(true));

  // Over Edit Text: Cancel here, and Edit Text stays.
  bindPopup(fx.modal, () => closeFx(true), 2);
}

window.addEventListener('resize', () => {
  if (!colorModal.hidden) {
    drawPickWheel();
    showPick(null);
  }
  if (fxKind) {
    sizeGenStage(FX[fxKind].stage, FX[fxKind].canvas);
    paintFx(false);
  }
  if (!textModal.hidden && textDraft) {
    sizeTextStage();
    paintTextPreview();
  }
  if (barModal.hidden || !barDraft) return;
  sizeGenStage(barStage, barCanvas);
  paintBarPreview();
});
