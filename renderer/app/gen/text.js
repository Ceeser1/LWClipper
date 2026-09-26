'use strict';

// V3. Edit Text: the toolbar, the fonts, the edit box, the text box and its
// rotation.

// ---- V3, 30f. Edit Text ----
//
// The draft is the layer's text settings as they stand, at the layer's own
// refHeight. Unlike the bar's it is not moved to the project's height on
// Accept: the size box shows project pixels and converts on the way in and out
// instead, because moving the reference would mean rescaling the outline and
// the shadow alongside the size, and every rescale is a rounding.
//
// 3.0 edits a text as one run. A text from a later version with several is
// shown joined, and is only written back as one run if it is changed.

const textModal = el('textModal');
const textFontCombo = el('textFontCombo');
const textFontBox = el('textFontBox');
const textSizeCombo = el('textSizeCombo');
const textSizeBox = el('textSizeBox');
const textColorBtn = el('textColorBtn');
const textFlags = el('textFlags');
const textAlignH = el('textAlignH');
const textAlignV = el('textAlignV');
const textOutlineBtn = el('textOutlineBtn');
const textShadowBtn = el('textShadowBtn');
const textModes = el('textModes');
const textStage = el('textStage');
const textCanvas = el('textCanvas');
const textFrame = el('textFrame');
const textEditBox = el('textEditBox');
const textBoxEl = el('textBoxEl');
const textGuideX = el('textGuideX');
const textGuideY = el('textGuideY');
const textAngle = el('textAngle');
const textHint = el('textHint');
const textBackground = el('textBackground');
const textAcceptBtn = el('textAcceptBtn');
const textCancelBtn = el('textCancelBtn');

let textLayerId = null;
let textFirst = false;
let textDraft = null;    // { refHeight, text }, the words in text.runs
let textOpened = null;   // textGenOf of the draft as it opened, as JSON
let textMode = 'edit';   // or 'render'

// The sizes under the size box, in project pixels, which is what the box shows.
const TEXT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96,
  112, 128, 144, 160, 192, 240, 288];

function textGenOf(draft) {
  return { form: 'text', refHeight: draft.refHeight, text: draft.text };
}

// Project pixels per pixel of the draft's own.
function textScale() {
  return projectFrame().height / textDraft.refHeight;
}

// The style the words are drawn in: the text's, with the first run's changes
// over it, which in 3.0 are none.
function textStyleNow() {
  const run = textDraft.text.runs[0];
  return textLayout.styleOf(textDraft.text.style, run && run.style);
}

function textSizeShown() {
  return Math.max(1, Math.round(textDraft.text.style.size * textScale()));
}

// ---- the fonts on this PC ----
//
// queryLocalFonts, which Electron allows without asking and without a click
// (measured: 346 faces, 127 families). Should it ever fail, a list of the
// families Windows ships, kept to the ones that are really there.

const FALLBACK_FAMILIES = ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria',
  'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
  'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Lucida Console',
  'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Tahoma',
  'Times New Roman', 'Trebuchet MS', 'Verdana'];
let fontFamilies = null;

function loadFontFamilies() {
  if (!fontFamilies) {
    fontFamilies = (async () => {
      try {
        const faces = await window.queryLocalFonts();
        const names = [...new Set(faces.map((f) => f.family).filter(Boolean))];
        if (names.length) {
          return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        }
      } catch {
        // Falls through to the list below.
      }
      return FALLBACK_FAMILIES.filter(fontInstalled);
    })();
  }
  return fontFamilies;
}

// ---- a box with a list under it ----
//
// The font and the size share it: type into the box, or open the list with the
// arrow or the arrow keys and pick. The list keeps the focus in the box, so
// typing carries on filtering while it is open. Escape closes the list and
// only the list; a second one reaches the modal.
function bindCombo(root, opts) {
  const box = root.querySelector('.combo__box');
  const arrow = root.querySelector('.combo__arrow');
  const list = root.querySelector('.combo__list');
  let shown = [];
  let lit = -1;

  const light = (i, where) => {
    const items = list.querySelectorAll('.combo__item');
    lit = shown.length ? Math.min(shown.length - 1, Math.max(0, i)) : -1;
    items.forEach((item, n) => item.classList.toggle('combo__item--lit', n === lit));
    if (lit >= 0) items[lit].scrollIntoView({ block: where || 'nearest' });
  };

  const api = {
    box,
    isOpen: () => !list.hidden,
    open(values, at) {
      shown = values;
      list.replaceChildren(...values.map((v, i) => {
        const item = document.createElement('div');
        item.className = 'combo__item';
        item.textContent = String(v);
        item.dataset.index = String(i);
        if (opts.dress) opts.dress(item, v);
        return item;
      }));
      list.hidden = false;
      light(at === undefined ? -1 : at, 'center');
    },
    close() {
      list.hidden = true;
      lit = -1;
    },
  };

  const pick = (i) => {
    const v = shown[i];
    api.close();
    if (v !== undefined) opts.pick(v);
  };

  // mousedown rather than pointerdown, since that is the event whose default
  // moves the focus, and the box has to keep it.
  arrow.addEventListener('mousedown', (evt) => {
    evt.preventDefault();
    if (api.isOpen()) {
      api.close();
      return;
    }
    box.focus();
    opts.openAll(api);
  });
  list.addEventListener('mousedown', (evt) => evt.preventDefault());
  list.addEventListener('click', (evt) => {
    const item = evt.target.closest('.combo__item');
    if (item) pick(Number(item.dataset.index));
  });
  // Everything in the box selected when it takes the focus, so typing replaces
  // it. By the mouse that needs the release held back as well, or it puts the
  // caret down and undoes the selection.
  let fresh = false;
  box.addEventListener('mousedown', () => {
    fresh = document.activeElement !== box;
  });
  box.addEventListener('mouseup', (evt) => {
    if (fresh) evt.preventDefault();
    fresh = false;
  });
  box.addEventListener('focus', () => box.select());
  box.addEventListener('input', () => opts.typed(box.value, api));
  box.addEventListener('keydown', (evt) => {
    if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
      evt.preventDefault();
      if (!api.isOpen()) opts.openAll(api);
      else light(lit + (evt.key === 'ArrowDown' ? 1 : -1));
      return;
    }
    if (evt.key === 'Enter') {
      evt.preventDefault();
      if (api.isOpen() && lit >= 0) pick(lit);
      else box.blur();
      return;
    }
    if (evt.key === 'Escape' && api.isOpen()) {
      evt.preventDefault();
      evt.stopPropagation();
      api.close();
    }
  });
  box.addEventListener('blur', () => {
    api.close();
    opts.left(box.value);
  });
  return api;
}

const fontCombo = bindCombo(textFontCombo, {
  dress: (item, family) => {
    item.style.fontFamily = '"' + family.replace(/["\\]/g, '') + '", sans-serif';
  },
  async openAll(api) {
    const families = await loadFontFamilies();
    if (!textDraft) return;
    const at = families.findIndex((f) => f.toLowerCase() === textDraft.text.style.font.toLowerCase());
    api.open(families, at < 0 ? undefined : at);
  },
  // What has been typed so far narrows the list: names that start with it
  // first, then names that have it anywhere, the first of them lit so Enter
  // takes it.
  async typed(text, api) {
    const families = await loadFontFamilies();
    const want = text.trim().toLowerCase();
    if (!want) {
      api.open(families);
      return;
    }
    const starts = families.filter((f) => f.toLowerCase().startsWith(want));
    const has = families.filter((f) => !f.toLowerCase().startsWith(want) && f.toLowerCase().includes(want));
    api.open([...starts, ...has], 0);
  },
  pick: (family) => changeTextStyle({ font: family }, null),
  // A name typed out in full counts when the box is left; anything else goes
  // back to the font in force.
  async left(text) {
    if (!textDraft) return;
    const families = await loadFontFamilies();
    const found = families.find((f) => f.toLowerCase() === text.trim().toLowerCase());
    if (found && found !== textDraft.text.style.font) changeTextStyle({ font: found }, null);
    else showTextDraft(null);
  },
});

const sizeCombo = bindCombo(textSizeCombo, {
  openAll(api) {
    const now = textSizeShown();
    let at = 0;
    TEXT_SIZES.forEach((s, i) => {
      if (Math.abs(s - now) < Math.abs(TEXT_SIZES[at] - now)) at = i;
    });
    api.open(TEXT_SIZES, at);
  },
  // Taken as it is typed, like the bar's boxes, so the frame follows.
  typed(text) {
    if (!textDraft || !/^\d+$/.test(text.trim())) return;
    setTextSize(parseInt(text, 10), textSizeBox);
  },
  pick: (n) => setTextSize(n, null),
  left: () => showTextDraft(null),
});

// A size in project pixels, kept in the draft's own. The same number as the
// box shows already is no change, which matters when the two heights do not
// divide evenly and the round trip would move the size by a fraction.
function setTextSize(shown, except) {
  if (!textDraft) return;
  const scale = textScale();
  const n = Math.min(Math.floor(timelineModel.GEN_FONT_MAX * scale), Math.max(1, shown));
  if (n === textSizeShown()) {
    showTextDraft(except);
    return;
  }
  const size = Math.min(timelineModel.GEN_FONT_MAX, Math.max(1, Math.round(n / scale * 100) / 100));
  changeTextStyle({ size }, except);
}

// ---- the edit box ----

// The words as typed. Chromium's plaintext-only box keeps a line break as a
// newline in the text, and holds an empty last line open with a second one:
// Enter after "World" gives two newlines, and Backspace then leaves one, which
// shows as no empty line at all (measured). So one newline at the end is only
// ever the placeholder, and is dropped. A <br> or a <div> from a paste counts
// as a break too.
function editBoxText() {
  let out = '';
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        out += c.data;
      } else if (c.nodeName === 'BR') {
        out += '\n';
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        if (out && !out.endsWith('\n') && getComputedStyle(c).display !== 'inline') out += '\n';
        walk(c);
      }
    }
  };
  walk(textEditBox);
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

// The same form the box writes itself, placeholder and all.
function setEditBoxText(text) {
  textEditBox.textContent = text.endsWith('\n') ? text + '\n' : text;
}

// Line height as the drawing has it: the font's own ascent and descent, which
// is what textLayout stacks lines by. Measured at 100px and handed to CSS as a
// ratio, so the box's lines sit where the render's do.
let lineProbe = null;
function lineRatio(style) {
  if (!lineProbe) lineProbe = document.createElement('canvas').getContext('2d');
  lineProbe.font = textLayout.fontString({ ...style, size: 100 });
  const m = lineProbe.measureText('');
  const r = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100;
  return Number.isFinite(r) && r > 0 ? r : 1.15;
}

/**
 * The edit box dressed from the draft, over the frame at the size the stage
 * shows it. Everything genDraw draws has its CSS twin here: the outline as a
 * stroke painted under the fill, the way genDraw strokes every line before it
 * fills any, and the shadow as a text-shadow, which is only an approximation
 * of the distance field 30g draws.
 */
function styleTextEdit() {
  const d = textDraft;
  if (!d) return;
  const s = textStyleNow();
  const left = parseFloat(textCanvas.style.left) || 0;
  const top = parseFloat(textCanvas.style.top) || 0;
  const k = (parseFloat(textCanvas.style.height) || 0) / d.refHeight;
  const box = d.text.box;
  textFrame.style.left = (left + (box ? box.x * k : 0)) + 'px';
  textFrame.style.top = (top + (box ? box.y * k : 0)) + 'px';
  textFrame.style.width = (box ? box.w * k : parseFloat(textCanvas.style.width) || 0) + 'px';
  textFrame.style.height = (box ? box.h * k : parseFloat(textCanvas.style.height) || 0) + 'px';
  // 31b. Turned with the text, about the same centre, so the words are typed
  // where the render puts them.
  textFrame.style.transform = d.text.rotation ? 'rotate(' + d.text.rotation + 'deg)' : '';
  textFrame.dataset.v = d.text.align.v;
  // 31a. A box of its own is outlined, so the width the lines wrap at shows
  // while typing too.
  textFrame.dataset.boxed = String(!!box);
  const own = timelineModel.layerById(layers, textLayerId);
  textFrame.style.opacity = String(own ? timelineModel.alphaOf(own) : 1);

  const e = textEditBox.style;
  // The shorthand first, since it resets the line height.
  e.font = textLayout.fontString(s, k);
  e.lineHeight = String(lineRatio(s));
  e.color = s.color;
  e.textAlign = d.text.align.h;
  const lines = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean);
  e.textDecorationLine = lines.length ? lines.join(' ') : 'none';
  e.textDecorationThickness = textLayout.DECORATION_WIDTH + 'em';
  e.textUnderlineOffset = textLayout.UNDERLINE_OFFSET + 'em';
  e.webkitTextStroke = s.outline ? (s.outline.width * k * 2) + 'px ' + s.outline.color : '';
  if (s.shadow) {
    const a = s.shadow.angle * Math.PI / 180;
    const dist = s.shadow.distance * k;
    e.textShadow = (Math.cos(a) * dist) + 'px ' + (Math.sin(a) * dist) + 'px '
      + (s.shadow.size * k) + 'px ' + s.shadow.color;
  } else {
    e.textShadow = 'none';
  }
}

// ---- the modal ----

// Tooltips from t() each time the modal opens, since translateDom leaves
// attributes alone and these would otherwise stay in whatever language they
// were first written in.
function titleTextTools() {
  const titles = {
    bold: t('Bold'),
    italic: t('Italic'),
    underline: t('Underline'),
    strike: t('Strikethrough'),
    left: t('Align Left'),
    center: t('Align Center'),
    right: t('Align Right'),
    top: t('Align Top'),
    middle: t('Align Middle'),
    bottom: t('Align Bottom'),
  };
  for (const b of textFlags.querySelectorAll('button')) b.title = titles[b.dataset.flag];
  for (const b of textAlignH.querySelectorAll('button')) b.title = titles[b.dataset.h];
  for (const b of textAlignV.querySelectorAll('button')) b.title = titles[b.dataset.v];
  textFontBox.title = t('Font');
  textSizeBox.title = t('Size');
}

function openTextSettings(layer, first) {
  textLayerId = layer.id;
  textFirst = first;
  // A copy of its own, so nothing typed reaches the layer before Accept.
  textDraft = { refHeight: layer.gen.refHeight, text: JSON.parse(JSON.stringify(layer.gen.text)) };
  textOpened = JSON.stringify(textGenOf(textDraft));
  textMode = 'edit';
  textBackground.checked = genBackdropOn;
  titleTextTools();
  setEditBoxText(textDraft.text.runs.map((r) => r.text).join(''));
  textModal.hidden = false;
  showTextDraft(null);
  sizeTextStage();
  paintTextPreview();
  loadFontFamilies();
  // Straight into typing. A new text has its placeholder word selected so
  // the first key replaces it; an old one has the caret at its end.
  textEditBox.focus();
  const range = document.createRange();
  range.selectNodeContents(textEditBox);
  if (!first) range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function closeTextSettings() {
  closeFx(false);
  settlePick(false);
  fontCombo.close();
  sizeCombo.close();
  textModal.hidden = true;
  textGuideX.hidden = true;
  textGuideY.hidden = true;
  textAngle.hidden = true;
  textLayerId = null;
  textDraft = null;
  textOpened = null;
  textFirst = false;
  textEditBox.textContent = '';
}

function showTextDraft(except) {
  const d = textDraft;
  if (!d) return;
  const s = d.text.style;
  if (except !== textFontBox) textFontBox.value = s.font;
  if (except !== textSizeBox) textSizeBox.value = String(textSizeShown());
  paintSwatch(textColorBtn, s.color);
  for (const b of textFlags.querySelectorAll('button')) {
    b.classList.toggle('btn--active', !!s[b.dataset.flag]);
  }
  for (const b of textAlignH.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.h === d.text.align.h);
  }
  for (const b of textAlignV.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.v === d.text.align.v);
  }
  // Lit when the effect is on, which is the user's green.
  textOutlineBtn.classList.toggle('btn--active', !!s.outline);
  textShadowBtn.classList.toggle('btn--active', !!s.shadow);
  for (const b of textModes.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.mode === textMode);
  }
  textFrame.hidden = textMode !== 'edit';
  textBoxEl.hidden = textMode !== 'render';
  // Kept in the layout in Edit too, only unseen, or the modal would grow by
  // a line on the switch and, being centred, move the frame under the pointer.
  textHint.style.visibility = textMode === 'render' ? 'visible' : 'hidden';
  styleTextEdit();
  placeTextBox();
}

function sizeTextStage() {
  sizeGenStage(textStage, textCanvas);
  styleTextEdit();
  placeTextBox();
}

// ---- 31a. The text box ----
//
// Stored in the draft's own pixels like every other size, and null for the
// whole frame, which is also what a box dragged back out to the frame's edges
// becomes: null keeps following the frame through a resolution change, where
// a box the frame's size would not. Dragged in project pixels, which is what
// layerGeometry's text box functions work in.

// How near, in screen pixels, a side or the box's middle has to come to a frame
// edge or the frame's middle to land on it. The timeline's snapping reach.
const TEXT_BOX_SNAP = 5;

// Screen pixels per project pixel on the stage.
function textStageScale() {
  return (parseFloat(textCanvas.style.height) || 1) / projectFrame().height;
}

// The box in project pixels, the whole frame when there is none.
function textBoxNow() {
  const frame = projectFrame();
  const b = textDraft.text.box;
  if (!b) return { x: 0, y: 0, w: frame.width, h: frame.height };
  const k = textScale();
  return { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
}

function setTextBox(box) {
  if (!textDraft) return;
  const frame = projectFrame();
  const k = textScale();
  const ref = (v) => Math.round(v / k * 10000) / 10000;
  textDraft.text = {
    ...textDraft.text,
    box: layerGeometry.isWholeBox(box, frame)
      ? null
      : { x: ref(box.x), y: ref(box.y), w: ref(box.w), h: ref(box.h) },
  };
  styleTextEdit();
  placeTextBox();
  paintTextPreview();
}

function placeTextBox() {
  if (!textDraft) return;
  const s = textStageScale();
  const left = parseFloat(textCanvas.style.left) || 0;
  const top = parseFloat(textCanvas.style.top) || 0;
  const b = textBoxNow();
  textBoxEl.style.left = (left + b.x * s) + 'px';
  textBoxEl.style.top = (top + b.y * s) + 'px';
  textBoxEl.style.width = (b.w * s) + 'px';
  textBoxEl.style.height = (b.h * s) + 'px';
  // 31b. CSS turns an element about its centre, which is the box's centre,
  // the point genDraw turns the text about.
  const turn = textDraft.text.rotation;
  textBoxEl.style.transform = turn ? 'rotate(' + turn + 'deg)' : '';
}

// The frame line a drag has met, across the whole frame, or none.
function showTextGuides(x, y) {
  const s = textStageScale();
  const left = parseFloat(textCanvas.style.left) || 0;
  const top = parseFloat(textCanvas.style.top) || 0;
  textGuideX.hidden = x === null;
  textGuideY.hidden = y === null;
  if (x !== null) {
    textGuideX.style.left = (left + x * s) + 'px';
    textGuideX.style.top = top + 'px';
    textGuideX.style.height = textCanvas.style.height;
  }
  if (y !== null) {
    textGuideY.style.top = (top + y * s) + 'px';
    textGuideY.style.left = left + 'px';
    textGuideY.style.width = textCanvas.style.width;
  }
}

for (const grip of textBoxEl.querySelectorAll('.crop-grip')) {
  const edge = grip.dataset.edge;
  const vertical = edge === 'top' || edge === 'bottom';
  grip.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !textDraft) return;
    // Or the box underneath would take it as a move as well.
    evt.stopPropagation();
    const start = textBoxNow();
    const frame = projectFrame();
    const s = textStageScale();
    const turn = textDraft.text.rotation;
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    // 31b. A turned box's side moves along the box's own axis, so the pointer's
    // travel is taken along that: across the box for left and right, down it
    // for top and bottom.
    const a = turn * Math.PI / 180;
    const ux = vertical ? -Math.sin(a) : Math.cos(a);
    const uy = vertical ? Math.cos(a) : Math.sin(a);
    beginDrag(grip, evt, (ev) => {
      if (turn) {
        const along = ((ev.clientX - x0) * ux + (ev.clientY - y0) * uy) / s;
        setTextBox(layerGeometry.textBoxEdgeTurned(start, edge, along, ev.shiftKey, turn, frame).box);
        return;
      }
      const travel = ((vertical ? ev.clientY : ev.clientX) - (vertical ? y0 : x0)) / s;
      const r = layerGeometry.textBoxEdge(start, edge, travel, ev.shiftKey, frame, TEXT_BOX_SNAP / s);
      showTextGuides(vertical ? null : r.snap, vertical ? r.snap : null);
      setTextBox(r.box);
    }, () => showTextGuides(null, null));
  });
}

textBoxEl.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || !textDraft || evt.target !== textBoxEl) return;
  const start = textBoxNow();
  const frame = projectFrame();
  const s = textStageScale();
  const x0 = evt.clientX;
  const y0 = evt.clientY;
  // 31b. Turned, the box's sides no longer run along the frame's, so only its
  // centre snaps, and it is the centre that is held inside the frame.
  const move = textDraft.text.rotation ? layerGeometry.textBoxMoveTurned : layerGeometry.textBoxMove;
  beginDrag(textBoxEl, evt, (ev) => {
    const r = move(start, (ev.clientX - x0) / s, (ev.clientY - y0) / s, frame, TEXT_BOX_SNAP / s);
    showTextGuides(r.snapX, r.snapY);
    setTextBox(r.box);
  }, () => showTextGuides(null, null));
});

// ---- 31b. Rotation ----
//
// Any corner circle turns the text about the box's centre, by as far as the
// pointer goes round that centre, in whole degrees, landing on a quarter turn
// within two of one. The angle shows by the centre while it is dragged.

function setTextRotation(deg) {
  if (!textDraft || textDraft.text.rotation === deg) return;
  textDraft.text = { ...textDraft.text, rotation: deg };
  styleTextEdit();
  placeTextBox();
  paintTextPreview();
}

for (const rotor of textBoxEl.querySelectorAll('.text-rotor')) {
  rotor.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !textDraft) return;
    // Or the box underneath would take it as a move as well.
    evt.stopPropagation();
    const b = textBoxNow();
    const s = textStageScale();
    const r = textCanvas.getBoundingClientRect();
    const cx = r.left + (b.x + b.w / 2) * s;
    const cy = r.top + (b.y + b.h / 2) * s;
    const start = textDraft.text.rotation;
    const from = [evt.clientX - cx, evt.clientY - cy];
    const stage = textStage.getBoundingClientRect();
    textAngle.style.left = (cx - stage.left) + 'px';
    textAngle.style.top = (cy - stage.top) + 'px';
    textAngle.textContent = start + '°';
    textAngle.hidden = false;
    beginDrag(rotor, evt, (ev) => {
      const deg = layerGeometry.textTurnDrag(start, from, [ev.clientX - cx, ev.clientY - cy]);
      textAngle.textContent = deg + '°';
      setTextRotation(deg);
    }, () => {
      textAngle.hidden = true;
    });
  });
}

// Edit shows the frame without this layer, over which the box stands; Render
// Preview draws the draft itself, as the export will.
function paintTextPreview() {
  if (!textDraft) return;
  paintGenPreview(textStage, textCanvas, textLayerId,
    textMode === 'render' ? textGenOf(textDraft) : null);
}

function changeTextStyle(props, except) {
  if (!textDraft) return;
  textDraft.text = { ...textDraft.text, style: { ...textDraft.text.style, ...props } };
  showTextDraft(except);
  paintTextPreview();
  if (props.font) {
    const id = textLayerId;
    loadGenFonts(textGenOf(textDraft)).then((loaded) => {
      if (loaded && textLayerId === id) paintTextPreview();
    });
  }
}

function changeTextAlign(props) {
  if (!textDraft) return;
  textDraft.text = { ...textDraft.text, align: { ...textDraft.text.align, ...props } };
  showTextDraft(null);
  paintTextPreview();
}

function toggleTextFlag(flag) {
  if (!textDraft) return;
  changeTextStyle({ [flag]: !textDraft.text.style[flag] }, null);
}

textEditBox.addEventListener('input', () => {
  if (!textDraft) return;
  const run = textDraft.text.runs[0];
  textDraft.text = { ...textDraft.text, runs: [{ text: editBoxText(), style: run ? run.style : {} }] };
});

// Ctrl+B, I and U, which is where every editor has them. The whole text,
// since 3.0 has one style for it.
textEditBox.addEventListener('keydown', (evt) => {
  if (!(evt.ctrlKey || evt.metaKey) || evt.altKey || evt.shiftKey) return;
  const flag = { b: 'bold', i: 'italic', u: 'underline' }[String(evt.key).toLowerCase()];
  if (!flag) return;
  evt.preventDefault();
  toggleTextFlag(flag);
});

// A press on the frame around the words puts the caret at their end, rather
// than doing nothing because the box is only as tall as its lines.
textFrame.addEventListener('mousedown', (evt) => {
  if (evt.target !== textFrame) return;
  evt.preventDefault();
  textEditBox.focus();
  const range = document.createRange();
  range.selectNodeContents(textEditBox);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});

// The tools keep the caret where it was, so a word can be typed, made bold and
// typed on from without clicking back into the box.
for (const b of textModal.querySelectorAll('.text-tool')) {
  b.addEventListener('mousedown', (evt) => evt.preventDefault());
}

for (const b of textFlags.querySelectorAll('button')) {
  b.addEventListener('click', () => toggleTextFlag(b.dataset.flag));
}
for (const b of textAlignH.querySelectorAll('button')) {
  b.addEventListener('click', () => changeTextAlign({ h: b.dataset.h }));
}
for (const b of textAlignV.querySelectorAll('button')) {
  b.addEventListener('click', () => changeTextAlign({ v: b.dataset.v }));
}

for (const b of textModes.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!textDraft || textMode === b.dataset.mode) return;
    textMode = b.dataset.mode;
    showTextDraft(null);
    paintTextPreview();
    if (textMode === 'edit') textEditBox.focus();
  });
}

textColorBtn.addEventListener('click', async () => {
  if (!textDraft) return;
  const was = textDraft.text.style.color;
  const id = textLayerId;
  const picked = await pickColor(was, (color) => {
    if (textLayerId === id) changeTextStyle({ color }, null);
  });
  if (textLayerId !== id) return;
  changeTextStyle({ color: picked || was }, null);
});

textBackground.addEventListener('change', () => {
  genBackdropOn = textBackground.checked;
  paintTextPreview();
});

textAcceptBtn.addEventListener('click', () => {
  if (!textDraft) return;
  const id = textLayerId;
  const gen = textGenOf(textDraft);
  const changed = JSON.stringify(gen) !== textOpened;
  const first = textFirst;
  closeTextSettings();
  acceptGenSettings(id, gen, changed, first);
});

function cancelTextSettings() {
  const first = textFirst;
  closeTextSettings();
  if (first) cancelGenAdd();
}

textCancelBtn.addEventListener('click', cancelTextSettings);

// An open font or size list takes its own Escape before this sees one.
bindPopup(textModal, cancelTextSettings);
