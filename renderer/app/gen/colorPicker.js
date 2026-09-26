'use strict';

// V3. The colour picker every generated media modal opens.

// ---- V3, 30d. The colour picker ----
//
// Ours rather than <input type=color>, which in Electron 33 has no alpha, and
// the outline and shadow colours need one. One picker for every colour the
// generated media settings have: pickColor opens it over whichever modal asked
// and settles with `#rrggbbaa` on Accept and null on Cancel. `onInput` is told
// every change on the way, so the modal behind can show the colour live; on
// Cancel it is that modal's job to put its own colour back.
//
// The arithmetic is src/colorModel.js. The state is hue, saturation, value
// and alpha, and every box is worked out from it, so dragging the brightness
// to black and back, or typing a grey, does not lose the hue.

const colorModal = el('colorModal');
const colorWheel = el('colorWheel');
const colorWheelCanvas = el('colorWheelCanvas');
const colorWheelDot = el('colorWheelDot');
const colorValueBar = el('colorValueBar');
const colorAlphaBar = el('colorAlphaBar');
const colorHexBox = el('colorHexBox');
const colorByteBoxes = {
  r: el('colorRBox'),
  g: el('colorGBox'),
  b: el('colorBBox'),
  a: el('colorABox'),
};
const colorAcceptBtn = el('colorAcceptBtn');
const colorCancelBtn = el('colorCancelBtn');

let pickState = null;    // { h, s, v, a } while the picker is open
let pickOnInput = null;
let pickSettle = null;   // the open promise's resolve

function pickColor(color, onInput) {
  // One at a time: a second request settles the first as cancelled.
  if (pickSettle) settlePick(false);
  pickState = colorModel.stateOf(color);
  pickOnInput = onInput || null;
  colorModal.hidden = false;
  drawPickWheel();
  showPick(null);
  return new Promise((resolve) => {
    pickSettle = resolve;
  });
}

function settlePick(accept) {
  if (!pickSettle) return;
  const resolve = pickSettle;
  const out = accept ? colorModel.colorOf(pickState) : null;
  pickSettle = null;
  pickOnInput = null;
  pickState = null;
  colorModal.hidden = true;
  resolve(out);
}

// The wheel at full brightness, hue round it and saturation out from the
// middle. It does not change with the state, so it is drawn once per size
// rather than on every move. Pixel by pixel, which at 200 across is forty
// thousand, with the rim faded over one pixel so it is not jagged.
function drawPickWheel() {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(1, Math.round(colorWheel.clientWidth * dpr));
  if (colorWheelCanvas.width === size && colorWheelCanvas.dataset.drawn) return;
  colorWheelCanvas.width = size;
  colorWheelCanvas.height = size;
  const ctx = colorWheelCanvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const r = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - r;
      const dy = y + 0.5 - r;
      const edge = Math.min(1, Math.max(0, r - Math.hypot(dx, dy)));
      if (!edge) continue;
      const hs = colorModel.wheelPick(dx, dy, r);
      const c = colorModel.hsvToRgb(hs.h, hs.s, 1);
      const i = (y * size + x) * 4;
      img.data[i] = c.r;
      img.data[i + 1] = c.g;
      img.data[i + 2] = c.b;
      img.data[i + 3] = Math.round(edge * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  colorWheelCanvas.dataset.drawn = '1';
}

// One vertical bar: its canvas at the screen's pixels, filled top to bottom,
// and its mark at `frac` down from the top.
function paintPickBar(bar, top, bottom, frac) {
  const canvas = bar.querySelector('canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  bar.querySelector('.color-bar__mark').style.top = (frac * canvas.clientHeight) + 'px';
}

/**
 * Everything the picker shows, from the state. `except` is the box being typed
 * in, which is left as the user has it: rewriting it would move the caret and
 * turn a half-typed "1" into whatever the colour rounds to.
 */
function showPick(except) {
  const s = pickState;
  if (!s) return;
  const radius = colorWheel.clientWidth / 2;
  const p = colorModel.wheelPoint(s.h, s.s, radius);
  colorWheelDot.style.left = (radius + p.dx) + 'px';
  colorWheelDot.style.top = (radius + p.dy) + 'px';
  const full = colorModel.hsvToRgb(s.h, s.s, 1);
  paintPickBar(colorValueBar, `rgb(${full.r}, ${full.g}, ${full.b})`, '#000000', 1 - s.v);
  const c = colorModel.rgbOf(s);
  paintPickBar(colorAlphaBar, `rgba(${c.r}, ${c.g}, ${c.b}, 1)`, `rgba(${c.r}, ${c.g}, ${c.b}, 0)`,
    1 - s.a / 255);
  if (except !== colorHexBox) colorHexBox.value = colorModel.hexOf(s);
  const values = { ...c, a: s.a };
  for (const [key, box] of Object.entries(colorByteBoxes)) {
    if (box !== except) box.value = String(values[key]);
  }
}

function changePick(next, except) {
  if (!pickState || !next) return;
  pickState = next;
  showPick(except);
  if (pickOnInput) pickOnInput(colorModel.colorOf(pickState));
}

// A drag on the wheel or a bar, which also acts on the press, so a click is a
// pick. Whatever box had the caret lets go of it first, which is what writes
// it back to the state if it was left half typed.
function bindPickDrag(target, apply) {
  target.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !pickState) return;
    evt.preventDefault();
    if (document.activeElement && colorModal.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    apply(evt);
    beginDrag(target, evt, apply, null);
  });
}

// Down the bar from its top, 0 to 1, held to the bar past either end.
function pickBarFrac(bar, evt) {
  const r = bar.querySelector('canvas').getBoundingClientRect();
  return Math.min(1, Math.max(0, (evt.clientY - r.top) / Math.max(1, r.height)));
}

bindPickDrag(colorWheel, (evt) => {
  const r = colorWheelCanvas.getBoundingClientRect();
  const hs = colorModel.wheelPick(evt.clientX - (r.left + r.width / 2),
    evt.clientY - (r.top + r.height / 2), r.width / 2);
  changePick({ ...pickState, h: hs.h, s: hs.s }, null);
});

bindPickDrag(colorValueBar, (evt) => {
  changePick({ ...pickState, v: 1 - pickBarFrac(colorValueBar, evt) }, null);
});

bindPickDrag(colorAlphaBar, (evt) => {
  changePick({ ...pickState, a: Math.round(255 * (1 - pickBarFrac(colorAlphaBar, evt))) }, null);
});

colorHexBox.addEventListener('input', () => {
  if (!pickState) return;
  const read = colorModel.readHex(colorHexBox.value, pickState);
  if (read.text !== null) colorHexBox.value = read.text;
  if (read.state) changePick(read.state, colorHexBox);
});

for (const [key, box] of Object.entries(colorByteBoxes)) {
  box.addEventListener('input', () => {
    if (!pickState) return;
    const n = colorModel.readByte(box.value);
    if (n === null) return;
    // Past the range reads as its end, and the box says so at once rather
    // than showing 300 against a colour that is using 255.
    if (parseInt(box.value, 10) !== n) box.value = String(n);
    if (key === 'a') {
      changePick({ ...pickState, a: n }, box);
      return;
    }
    const c = colorModel.rgbOf(pickState);
    c[key] = n;
    changePick(colorModel.withRgb(pickState, c.r, c.g, c.b), box);
  });
}

// Leaving a box, or Enter in it, writes it back as the state has it: a half
// typed hex, an empty R or a "007" all come back as the colour in force.
for (const box of [colorHexBox, ...Object.values(colorByteBoxes)]) {
  box.addEventListener('blur', () => showPick(null));
  box.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter') return;
    evt.preventDefault();
    box.blur();
  });
}

colorAcceptBtn.addEventListener('click', () => settlePick(true));
colorCancelBtn.addEventListener('click', () => settlePick(false));

// Over whichever modal asked for it, Outline and Shadow included.
bindPopup(colorModal, () => settlePick(false), 3);

/** A colour button's face: the colour, over the checkerboard its alpha shows. */
function paintSwatch(btn, color) {
  btn.querySelector('.color-swatch__fill').style.background = color;
  btn.title = color.slice(0, 7) + ', A ' + parseInt(color.slice(7, 9) || 'ff', 16);
}
