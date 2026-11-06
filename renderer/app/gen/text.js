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
// 3.2 formats words one by one. The words are edited as expanded runs
// (textRuns.js), every run with its whole style, and written back into the
// draft in the file's form after each change. Outline and shadow are the whole
// text's and go through changeTextStyle; everything a run may carry goes
// through formatText, onto the selection.

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
// V3.7. The clip's keyframes.
const textStrip = makeGenStrip(textModal, el('textKeys'), el('textKeysReadout'), el('textKeysCanvas'), textStage);

let textLayerId = null;
let textFirst = false;
let textDraft = null;    // { refHeight, text }, the words in text.runs
let textOpened = null;   // textGenOf of the draft as it opened, as JSON
let textMode = 'edit';   // or 'render'

// 3.2. The words as expanded runs, the last selection made in the box (kept
// while the focus is in a toolbar box or the colour picker), and the pending
// style: what a toolbar change at a bare caret sets for the next letters typed
// there, dropped when the caret moves.
let textFull = null;
let textSel = { from: 0, to: 0 };
let textPending = null;
let textPendingAt = -1;

// The box's own undo. A rerender of the box wipes Chromium's, so the words and
// their formatting keep a stack here: expanded runs and the selection, with a
// burst of typing going in as one step.
let textUndo = [];
let textRedo = [];
let textTyping = null;   // { end, time } of the burst being typed
let textFontShown = '';  // the font the toolbar last showed, '' when mixed
const TEXT_UNDO_MAX = 200;
const TEXT_TYPING_GAP = 1500;

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

function textLength() {
  return textRuns.textOf(textFull).length;
}

// What the toolbar acts on: the selection, or in Render Preview, where no
// selection shows, the whole text.
function textTarget() {
  if (textMode === 'render') return { from: 0, to: textLength() };
  return textSel;
}

// What the toolbar shows: the pending style at a bare caret, else the target's
// first letter, with the fields in which the rest of it differs.
function textShown() {
  const { from, to } = textTarget();
  if (textPending && from === to && from === textPendingAt) return { style: textPending, mixed: [] };
  return textRuns.selectionStyle(textFull, from, to);
}

function textSizeShown(style) {
  return Math.max(1, Math.round(style.size * textScale()));
}

// The expanded runs written into the draft in the file's form, and taken back
// from it, so the two never drift and neighbours alike are always one run.
function setTextRuns(full) {
  const c = textRuns.compress(full, textDraft.text.style);
  textDraft.text = { ...textDraft.text, runs: c.runs, style: c.style };
  textFull = textRuns.expand(c.runs, c.style);
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
let fontFamilyList = null;   // the same, once it has arrived

function loadFontFamilies() {
  if (!fontFamilies) {
    fontFamilies = (async () => {
      let found = null;
      try {
        const faces = await window.queryLocalFonts();
        const names = [...new Set(faces.map((f) => f.family).filter(Boolean))];
        if (names.length) found = names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      } catch {
        // Falls through to the list below.
      }
      fontFamilyList = found || FALLBACK_FAMILIES.filter(fontInstalled);
      return fontFamilyList;
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
    fresh = box.ownerDocument.activeElement !== box;
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
    const shown = textShown();
    const font = shown.mixed.includes('font') ? '' : shown.style.font.toLowerCase();
    const at = families.findIndex((f) => f.toLowerCase() === font);
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
  pick: (family) => formatText({ font: family }, null),
  // A name typed out in full counts when the box is left; anything else goes
  // back to the font in force. Only a name that was edited: leaving the box by
  // clicking into the words must not put the shown font onto a selection that
  // is about to change, and must answer at once, before that selection does.
  left(text) {
    if (!textDraft) return;
    const typed = text.trim().toLowerCase();
    const found = (fontFamilyList || []).find((f) => f.toLowerCase() === typed);
    if (found && typed !== textFontShown.toLowerCase()) formatText({ font: found }, null);
    else showTextTools(null);
  },
});

const sizeCombo = bindCombo(textSizeCombo, {
  openAll(api) {
    const now = textSizeShown(textShown().style);
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
  left: () => showTextTools(null),
});

// A size in project pixels, kept in the draft's own. The same number as the
// box shows already is no change, which matters when the two heights do not
// divide evenly and the round trip would move the size by a fraction. A
// selection of mixed sizes takes any number, the one shown included.
function setTextSize(value, except) {
  if (!textDraft) return;
  const scale = textScale();
  const n = Math.min(Math.floor(timelineModel.GEN_FONT_MAX * scale), Math.max(1, value));
  const shown = textShown();
  if (n === textSizeShown(shown.style) && !shown.mixed.includes('size')) {
    showTextTools(except);
    return;
  }
  const size = Math.min(timelineModel.GEN_FONT_MAX, Math.max(1, Math.round(n / scale * 100) / 100));
  formatText({ size }, except);
}

// ---- the edit box ----
//
// 3.2. One span per run, each dressed in its run's style. The box stays
// `plaintext-only`, so Chromium never writes formatting of its own into it:
// typing, Enter, a dead key's letter or a paste only ever change text. After
// each change the box's text is compared with the model's, the difference is
// put into the runs (textRuns.textChange and splice), and the spans are drawn
// again only when they no longer say what the runs say.

// Elements a paste or Chromium itself may leave that start a line of their own.
const TEXT_BLOCKS = new Set(['DIV', 'P', 'LI', 'PRE', 'BLOCKQUOTE']);

// The text under a node, a <br> or the start of a block counting as a break.
// By the element's name rather than its computed style, since it is also asked
// of a detached copy of part of the box, which has no style.
function boxTextOf(root) {
  let out = '';
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        out += c.data;
      } else if (c.nodeName === 'BR') {
        out += '\n';
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        if (out && !out.endsWith('\n') && TEXT_BLOCKS.has(c.nodeName)) out += '\n';
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

// The words as typed. Chromium's plaintext-only box keeps a line break as a
// newline in the text, and holds an empty last line open with a second one:
// Enter after "World" gives two newlines, and Backspace then leaves one, which
// shows as no empty line at all (measured). So one newline at the end is only
// ever the placeholder, and is dropped.
function editBoxText() {
  const out = boxTextOf(textEditBox);
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

// The runs that get a span: all but an empty text's one empty run.
function editRuns() {
  return textFull.filter((r) => r.text);
}

function styleKey(style) {
  return timelineModel.RUN_FIELDS.map((f) => style[f]).join('|');
}

// The spans, one per run, the last one carrying the placeholder newline when
// the text ends in a break, the same form the box writes itself.
function renderEditBox() {
  const runs = editRuns();
  textEditBox.replaceChildren(...runs.map((r, i) => {
    const span = document.createElement('span');
    span.textContent = r.text + (i === runs.length - 1 && r.text.endsWith('\n') ? '\n' : '');
    span.dataset.key = styleKey(r.style);
    return span;
  }));
  styleTextEdit();
}

// Whether the box still holds exactly the spans renderEditBox would make.
// Typing into a span keeps it so; a letter in a new style, a span Chromium
// emptied and dropped, or text outside every span does not.
function editBoxMatches() {
  const runs = editRuns();
  const kids = textEditBox.childNodes;
  if (kids.length !== runs.length) return false;
  return runs.every((r, i) => {
    const node = kids[i];
    if (node.nodeName !== 'SPAN' || node.dataset.key !== styleKey(r.style)) return false;
    if (node.childNodes.length !== 1 || node.firstChild.nodeType !== Node.TEXT_NODE) return false;
    return node.firstChild.data === r.text + (i === runs.length - 1 && r.text.endsWith('\n') ? '\n' : '');
  });
}

// Where a point in the box is, as an offset into its text.
function boxOffset(node, offset) {
  const range = textEditBox.ownerDocument.createRange();
  range.setStart(textEditBox, 0);
  range.setEnd(node, offset);
  return boxTextOf(range.cloneContents()).length;
}

// The selection in the box as offsets, or null when it is somewhere else.
function boxSelection() {
  // V3.6.2. The window the box is in, which is the media window's once it is out.
  const sel = hostWindowOf(textEditBox).getSelection();
  if (!sel.rangeCount || !textEditBox.contains(sel.anchorNode) || !textEditBox.contains(sel.focusNode)) {
    return null;
  }
  const len = editBoxText().length;
  const anchor = Math.min(len, boxOffset(sel.anchorNode, sel.anchorOffset));
  const focus = Math.min(len, boxOffset(sel.focusNode, sel.focusOffset));
  return { from: Math.min(anchor, focus), to: Math.max(anchor, focus), anchor, focus };
}

// An offset as a point in the box's text nodes. On the line between two
// spans it is the end of the first, so a letter typed there goes into the
// span whose style it takes.
function boxPoint(at) {
  const walker = textEditBox.ownerDocument.createTreeWalker(textEditBox, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (at <= acc + node.data.length) return [node, at - acc];
    acc += node.data.length;
    last = node;
  }
  return last ? [last, last.data.length] : [textEditBox, 0];
}

function setBoxSelection(anchor, focus) {
  const [an, ao] = boxPoint(anchor);
  const [fn, fo] = boxPoint(focus);
  hostWindowOf(textEditBox).getSelection().setBaseAndExtent(an, ao, fn, fo);
  textSel = { from: Math.min(anchor, focus), to: Math.max(anchor, focus), anchor, focus };
}

// The spans drawn again if they have gone out of step with the runs. The
// selection is put back only while the box has the focus: setting it moves the
// focus into the box, which would take it from a toolbar box being typed in.
function refreshEditBox() {
  if (editBoxMatches()) {
    styleTextEdit();
    return;
  }
  renderEditBox();
  if (textEditBox.ownerDocument.activeElement === textEditBox) {
    setBoxSelection(textSel.anchor ?? textSel.from, textSel.focus ?? textSel.to);
  }
}

/**
 * A step onto the box's undo stack, taken before a change. A letter typed
 * straight after the last one, soon after it, joins that step, so undo takes
 * back a word or a burst rather than a letter at a time.
 */
function recordTextUndo(change) {
  const now = Date.now();
  const typed = !!(change && change.text && change.from === change.to && !change.text.includes('\n'));
  if (typed && textTyping && textTyping.end === change.from && now - textTyping.time < TEXT_TYPING_GAP) {
    textTyping = { end: change.from + change.text.length, time: now };
    return;
  }
  textUndo.push({ full: textFull, sel: { ...textSel } });
  if (textUndo.length > TEXT_UNDO_MAX) textUndo.shift();
  textRedo = [];
  textTyping = typed ? { end: change.from + change.text.length, time: now } : null;
}

function stepTextUndo(redo) {
  if (!textDraft) return;
  const from = redo ? textRedo : textUndo;
  const to = redo ? textUndo : textRedo;
  if (!from.length) return;
  to.push({ full: textFull, sel: { ...textSel } });
  const step = from.pop();
  textPending = null;
  textTyping = null;
  setTextRuns(step.full);
  renderEditBox();
  if (textMode === 'edit') setBoxSelection(step.sel.from, step.sel.to);
  else textSel = { ...step.sel };
  showTextDraft(null);
  paintTextPreview();
}

/**
 * What the box did, put into the runs. The caret says where a doubled letter
 * went; a pending style, when there is one, is what the new letters get.
 */
function readEditBox() {
  if (!textDraft) return;
  const after = editBoxText();
  const sel = boxSelection();
  const caret = sel ? sel.focus : after.length;
  const change = textRuns.textChange(textRuns.textOf(textFull), after, caret);
  if (change.from === change.to && !change.text) {
    refreshEditBox();
    return;
  }
  recordTextUndo(change);
  const text = change.text.replace(/\r\n?/g, '\n');
  const style = text && textPending && textPendingAt === change.from ? textPending : undefined;
  textPending = null;
  setTextRuns(textRuns.splice(textFull, change.from, change.to, text, style));
  const at = change.from + text.length;
  textSel = { from: at, to: at, anchor: at, focus: at };
  refreshEditBox();
  showTextTools(null);
}

// Line height as the drawing has it: the font's own ascent and descent, which
// is what textLayout stacks lines by. Measured at 100px and handed to CSS as a
// ratio, so the box's lines sit where the render's do. Kept per font, since a
// text now has as many as it has runs.
let lineProbe = null;
const lineRatios = new Map();
function lineRatio(style) {
  if (!lineProbe) lineProbe = document.createElement('canvas').getContext('2d');
  const font = textLayout.fontString({ ...style, size: 100 });
  if (!lineRatios.has(font)) {
    lineProbe.font = font;
    const m = lineProbe.measureText('');
    const r = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100;
    lineRatios.set(font, Number.isFinite(r) && r > 0 ? r : 1.15);
  }
  return lineRatios.get(font);
}

// CSS pixels on the stage per pixel of the draft's own, zoomed as it is.
function textEditScale() {
  return stageFrameRect(textStage).height / textDraft.refHeight;
}

// One span in its run's style. Each has its own line height, from its own
// font, so a line is as tall as its tallest run, the way textLayout has it.
function dressSpan(span, style, k) {
  const s = span.style;
  s.font = textLayout.fontString(style, k);
  s.lineHeight = String(lineRatio(style));
  s.color = style.color;
  const lines = [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean);
  s.textDecorationLine = lines.length ? lines.join(' ') : 'none';
  s.textDecorationThickness = textLayout.DECORATION_WIDTH + 'em';
  s.textUnderlineOffset = textLayout.UNDERLINE_OFFSET + 'em';
}

/**
 * The edit box dressed from the draft, over the frame at the size the stage
 * shows it. Everything genDraw draws has its CSS twin here: each run as its
 * span, the outline as a stroke painted under the fill, the way genDraw
 * strokes every line before it fills any, and the shadow as a text-shadow,
 * which is only an approximation of the distance field 30g draws. Outline and
 * shadow are the whole text's, so they are set on the box and the spans
 * inherit them.
 */
function styleTextEdit() {
  const d = textDraft;
  if (!d) return;
  const base = d.text.style;
  const r = stageFrameRect(textStage);
  const k = textEditScale();
  const box = d.text.box;
  textFrame.style.left = (r.left + (box ? box.x * k : 0)) + 'px';
  textFrame.style.top = (r.top + (box ? box.y * k : 0)) + 'px';
  textFrame.style.width = (box ? box.w * k : r.width) + 'px';
  textFrame.style.height = (box ? box.h * k : r.height) + 'px';
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
  // The box's own font is what an empty text's caret stands in. With words in
  // it, its line height is none at all, so only the spans give a line its
  // height: the box's own would otherwise hold every line to at least its size.
  e.font = textLayout.fontString(base, k);
  e.lineHeight = editRuns().length ? '0' : String(lineRatio(base));
  e.color = base.color;
  e.textAlign = d.text.align.h;
  e.webkitTextStroke = base.outline ? (base.outline.width * k * 2) + 'px ' + base.outline.color : '';
  if (base.shadow) {
    const a = base.shadow.angle * Math.PI / 180;
    const dist = base.shadow.distance * k;
    e.textShadow = (Math.cos(a) * dist) + 'px ' + (Math.sin(a) * dist) + 'px '
      + (base.shadow.size * k) + 'px ' + base.shadow.color;
  } else {
    e.textShadow = 'none';
  }
  const runs = editRuns();
  textEditBox.childNodes.forEach((node, i) => {
    if (node.nodeName === 'SPAN' && runs[i]) dressSpan(node, runs[i].style, k);
  });
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
  textFull = textRuns.expand(textDraft.text.runs, textDraft.text.style);
  textPending = null;
  textUndo = [];
  textRedo = [];
  textTyping = null;
  textMode = 'edit';
  textBackground.checked = genBackdropOn;
  titleTextTools();
  textModal.hidden = false;
  recallStageView(textStage, textLayerId, genKeyframeOf(textLayerId));
  // V3.6.2. Out into the media window, before anything below measures it.
  popOutGenWindow(textModal, layer.id, {
    cancel: cancelTextSettings,
    relayout: () => {
      if (!textDraft) return;
      sizeTextStage();
      paintTextPreview();
      if (fxKind) {
        sizeGenStage(FX[fxKind].stage, FX[fxKind].canvas);
        paintFx(false);
      }
    },
    draftGen: () => (textDraft ? textGenOf(textDraft) : null),
    // V3.7. The keyframe editor's side of it.
    changed: () => !!textDraft && JSON.stringify(textGenOf(textDraft)) !== textOpened,
    reload: reloadTextKeyed,
    strip: textStrip,
  });
  // The selection is followed in whichever document the box is in now.
  const textDoc = textEditBox.ownerDocument;
  if (textDoc !== document) textDoc.addEventListener('selectionchange', followTextSelection);
  sizeTextStage();
  renderEditBox();
  // Straight into typing. A new text has its placeholder word selected so
  // the first key replaces it; an old one has the caret at its end.
  textEditBox.focus();
  const len = textLength();
  setBoxSelection(first ? 0 : len, len);
  showTextDraft(null);
  paintTextPreview();
  loadFontFamilies();
}

function closeTextSettings() {
  // V3.3. Kept before the modal lets the layer go, Accept or Cancel.
  if (textLayerId) rememberStageView(textStage, textLayerId, genKeyframeOf(textLayerId));
  closeFx(false);
  settlePick(false);
  fontCombo.close();
  sizeCombo.close();
  popInGenWindow(textModal);
  textModal.hidden = true;
  textGuideX.hidden = true;
  textGuideY.hidden = true;
  textAngle.hidden = true;
  textLayerId = null;
  textDraft = null;
  textOpened = null;
  textFirst = false;
  textFull = null;
  textPending = null;
  textUndo = [];
  textRedo = [];
  textTyping = null;
  textEditBox.textContent = '';
}

// The toolbar from what it acts on: the selection's style, a field that is
// mixed across it shown blank or unlit.
function showTextTools(except) {
  const d = textDraft;
  if (!d) return;
  const { style, mixed } = textShown();
  textFontShown = mixed.includes('font') ? '' : style.font;
  if (except !== textFontBox) textFontBox.value = textFontShown;
  if (except !== textSizeBox) textSizeBox.value = mixed.includes('size') ? '' : String(textSizeShown(style));
  paintSwatch(textColorBtn, style.color);
  for (const b of textFlags.querySelectorAll('button')) {
    b.classList.toggle('btn--active', !!style[b.dataset.flag] && !mixed.includes(b.dataset.flag));
  }
  for (const b of textAlignH.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.h === d.text.align.h);
  }
  for (const b of textAlignV.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.v === d.text.align.v);
  }
  // Lit when the effect is on, which is the user's green.
  textOutlineBtn.classList.toggle('btn--active', !!d.text.style.outline);
  textShadowBtn.classList.toggle('btn--active', !!d.text.style.shadow);
}

function showTextDraft(except) {
  const d = textDraft;
  if (!d) return;
  showTextTools(except);
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
  textStrip.draw();
}

/**
 * V3.7. The keyed settings, the box and the turn, read out of `gen` into the
 * draft: the clip's draft at another keyframe. The words and their styles
 * are the whole clip's, so what is being typed is left as it is.
 */
function reloadTextKeyed(gen) {
  if (!textDraft) return;
  const k = textDraft.refHeight / gen.refHeight;
  const b = gen.text.box;
  textDraft.text = {
    ...textDraft.text,
    box: b ? { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k } : null,
    rotation: gen.text.rotation,
  };
  textOpened = JSON.stringify(textGenOf(textDraft));
  styleTextEdit();
  placeTextBox();
  paintTextPreview();
  textStrip.draw();
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

// Screen pixels per project pixel on the stage, zoomed as it is.
function textStageScale() {
  return stageFrameRect(textStage).s;
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
  const r = stageFrameRect(textStage);
  const s = r.s;
  const b = textBoxNow();
  textBoxEl.style.left = (r.left + b.x * s) + 'px';
  textBoxEl.style.top = (r.top + b.y * s) + 'px';
  textBoxEl.style.width = (b.w * s) + 'px';
  textBoxEl.style.height = (b.h * s) + 'px';
  // 31b. CSS turns an element about its centre, which is the box's centre,
  // the point genDraw turns the text about.
  const turn = textDraft.text.rotation;
  textBoxEl.style.transform = turn ? 'rotate(' + turn + 'deg)' : '';
}

// The frame line a drag has met, across the whole frame, or none.
function showTextGuides(x, y) {
  const r = stageFrameRect(textStage);
  textGuideX.hidden = x === null;
  textGuideY.hidden = y === null;
  if (x !== null) {
    textGuideX.style.left = (r.left + x * r.s) + 'px';
    textGuideX.style.top = r.top + 'px';
    textGuideX.style.height = r.height + 'px';
  }
  if (y !== null) {
    textGuideY.style.top = (r.top + y * r.s) + 'px';
    textGuideY.style.left = r.left + 'px';
    textGuideY.style.width = r.width + 'px';
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
    const r = stageFrameRect(textStage);
    const s = r.s;
    const stage = textStage.getBoundingClientRect();
    const cx = stage.left + textStage.clientLeft + r.left + (b.x + b.w / 2) * s;
    const cy = stage.top + textStage.clientTop + r.top + (b.y + b.h / 2) * s;
    const start = textDraft.text.rotation;
    const from = [evt.clientX - cx, evt.clientY - cy];
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
function paintTextPreview(quick) {
  if (!textDraft) return;
  paintGenPreview(textStage, textCanvas, textLayerId,
    textMode === 'render' ? textGenOf(textDraft) : null, quick);
}

// V3.3. The wheel zooms and empty space pans, so a text can be put off the
// frame and found there again, in Edit and in Render Preview alike.
bindStageView(textStage, {
  open: () => !!textDraft && !textModal.hidden,
  empty: (evt) => evt.target === textStage || evt.target === textCanvas,
  redraw: (quick) => {
    styleTextEdit();
    placeTextBox();
    paintTextPreview(quick);
  },
});

// A font that is not loaded yet draws as the fallback, so the preview is drawn
// again once it is.
function loadTextFonts() {
  const id = textLayerId;
  loadGenFonts(textGenOf(textDraft)).then((loaded) => {
    if (loaded && textLayerId === id) paintTextPreview();
  });
}

// The whole text's style, which since 3.2 means the outline and the shadow:
// what a run may carry goes through formatText.
function changeTextStyle(props, except) {
  if (!textDraft) return;
  textDraft.text = { ...textDraft.text, style: { ...textDraft.text.style, ...props } };
  textFull = textRuns.expand(textDraft.text.runs, textDraft.text.style);
  refreshEditBox();
  showTextDraft(except);
  paintTextPreview();
}

/**
 * `props` onto what the toolbar acts on. A selection, or the whole text in
 * Render Preview, is formatted, one step on the box's undo. A bare caret in
 * words sets the pending style instead, for the letters about to be typed
 * there, as every word processor does. An empty text takes it straight into
 * its one empty run, which is where the next letter's style comes from.
 *
 * `start`, when given, is the runs to lay the change over rather than the
 * ones in force, with no undo step: the colour picker's live preview, which
 * starts over from the runs as they were for every colour it shows.
 */
function formatText(props, except, start) {
  if (!textDraft) return;
  const base = start || textFull;
  const { from, to } = textTarget();
  const len = textRuns.textOf(base).length;
  if (from === to && len) {
    const now = textPending && textPendingAt === from ? textPending : textRuns.styleAt(base, from);
    textPending = { ...now, ...props };
    textPendingAt = from;
    showTextTools(except);
    return;
  }
  if (!start) recordTextUndo(null);
  setTextRuns(len
    ? textRuns.applyStyle(base, from, to, props)
    : [{ text: '', style: { ...base[0].style, ...props } }]);
  refreshEditBox();
  showTextDraft(except);
  paintTextPreview();
  if (props.font) loadTextFonts();
}

function changeTextAlign(props) {
  if (!textDraft) return;
  textDraft.text = { ...textDraft.text, align: { ...textDraft.text.align, ...props } };
  showTextDraft(null);
  paintTextPreview();
}

// On unless all of it is on already, so a mixed selection is made all bold
// first, the way Word does it.
function toggleTextFlag(flag) {
  if (!textDraft) return;
  const { style, mixed } = textShown();
  formatText({ [flag]: !(style[flag] && !mixed.includes(flag)) }, null);
}

// While a dead key or an input method is still composing a letter the box is
// left alone, since drawing it again would end the composition; its end
// reads the box instead.
textEditBox.addEventListener('input', (evt) => {
  if (!evt.isComposing) readEditBox();
});
textEditBox.addEventListener('compositionend', () => readEditBox());

// The box's own undo, from the menu Chromium would otherwise answer from its
// own stack, which a rerender has made meaningless.
textEditBox.addEventListener('beforeinput', (evt) => {
  if (evt.inputType === 'historyUndo' || evt.inputType === 'historyRedo') {
    evt.preventDefault();
    stepTextUndo(evt.inputType === 'historyRedo');
  }
});

// Ctrl+B, I and U on the selection, which is where every editor has them, and
// Ctrl+Z with Ctrl+Y or Ctrl+Shift+Z as the box's undo and redo. By the key,
// not the physical position, so a German keyboard's Z is Z.
textEditBox.addEventListener('keydown', (evt) => {
  if (!(evt.ctrlKey || evt.metaKey) || evt.altKey) return;
  const key = String(evt.key).toLowerCase();
  if (key === 'z' || key === 'y') {
    evt.preventDefault();
    stepTextUndo(key === 'y' || evt.shiftKey);
    return;
  }
  if (evt.shiftKey) return;
  const flag = { b: 'bold', i: 'italic', u: 'underline' }[key];
  if (!flag) return;
  evt.preventDefault();
  toggleTextFlag(flag);
});

// The selection, followed while it is in the box and kept while it is not, so
// the font box, the size box and the colour picker act on the words that were
// selected before they took the focus. A caret moved off the pending style's
// place drops it.
// V3.6.2. Named, so the media window's document can follow it as well.
function followTextSelection() {
  if (!textDraft || textModal.hidden || textMode !== 'edit') return;
  const s = boxSelection();
  if (!s) return;
  textSel = s;
  if (textPending && !(s.from === s.to && s.from === textPendingAt)) textPending = null;
  showTextTools(null);
}

document.addEventListener('selectionchange', followTextSelection);

// Words copied inside the box keep their formatting, in a type of the app's
// own beside the plain text. Anything else is pasted by the box as plain text
// and styled like typing.
const TEXT_RUNS_TYPE = 'application/x-lwclipper-runs';

function copyEditBox(evt, cut) {
  const s = boxSelection();
  if (!textDraft || !s || s.from === s.to) return;
  evt.preventDefault();
  const part = textRuns.slice(textFull, s.from, s.to);
  const own = part.map((r) => ({
    text: r.text,
    style: Object.fromEntries(timelineModel.RUN_FIELDS.map((f) => [f, r.style[f]])),
  }));
  evt.clipboardData.setData('text/plain', textRuns.textOf(part));
  evt.clipboardData.setData(TEXT_RUNS_TYPE, JSON.stringify(own));
  if (cut) replaceEditRange(s.from, s.to, []);
}

textEditBox.addEventListener('copy', (evt) => copyEditBox(evt, false));
textEditBox.addEventListener('cut', (evt) => copyEditBox(evt, true));

textEditBox.addEventListener('paste', (evt) => {
  const s = boxSelection();
  if (!textDraft || !s) return;
  const plain = evt.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
  let raw = null;
  try {
    raw = JSON.parse(evt.clipboardData.getData(TEXT_RUNS_TYPE) || 'null');
  } catch {
    raw = null;
  }
  // Only ours, and only while it still goes with the plain text beside it.
  if (!Array.isArray(raw) || raw.map((r) => (r && r.text) || '').join('') !== plain) return;
  evt.preventDefault();
  const clean = timelineModel.genOf({ form: 'text', text: { runs: raw } }).text.runs;
  replaceEditRange(s.from, s.to, textRuns.expand(clean, textDraft.text.style));
  loadTextFonts();
});

// Dragging words about would be a delete and an insert far apart, which the
// read-back would take as one replacement of everything between. Cut and
// paste does the same job.
textEditBox.addEventListener('dragstart', (evt) => evt.preventDefault());
textEditBox.addEventListener('drop', (evt) => evt.preventDefault());

function replaceEditRange(from, to, pieces) {
  recordTextUndo(null);
  textPending = null;
  setTextRuns(textRuns.replaceRuns(textFull, from, to, pieces));
  renderEditBox();
  const at = from + textRuns.textOf(pieces).length;
  setBoxSelection(at, at);
  showTextTools(null);
  paintTextPreview();
}

// A press on the frame around the words puts the caret at their end, rather
// than doing nothing because the box is only as tall as its lines.
textFrame.addEventListener('mousedown', (evt) => {
  if (evt.target !== textFrame) return;
  evt.preventDefault();
  textEditBox.focus();
  const len = textLength();
  setBoxSelection(len, len);
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
    if (textMode === 'edit') {
      textEditBox.focus();
      setBoxSelection(textSel.anchor ?? textSel.from, textSel.focus ?? textSel.to);
    }
  });
}

// The colour onto the selection. Every colour the picker shows is laid over
// the runs as they were when it opened, and a Cancel puts those back, so a
// selection of several colours keeps them all.
textColorBtn.addEventListener('click', async () => {
  if (!textDraft) return;
  const id = textLayerId;
  const start = textFull;
  const pending = textPending;
  const pendingAt = textPendingAt;
  const put = (color) => {
    textPending = pending;
    textPendingAt = pendingAt;
    formatText({ color }, null, start);
  };
  const picked = await pickColor(textShown().style.color, (color) => {
    if (textLayerId === id) put(color);
  });
  if (textLayerId !== id) return;
  textPending = pending;
  textPendingAt = pendingAt;
  setTextRuns(start);
  refreshEditBox();
  if (picked) formatText({ color: picked }, null);
  else {
    showTextDraft(null);
    paintTextPreview();
  }
  if (textMode === 'edit') {
    textEditBox.focus();
    setBoxSelection(textSel.anchor ?? textSel.from, textSel.focus ?? textSel.to);
  }
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
