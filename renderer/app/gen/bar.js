'use strict';

// V3. Bar Settings.

// ---- V3, 30e. Bar Settings ----
//
// The draft is in the project's own pixels, not the layer's reference pixels,
// because that is what the thickness box shows and what the user's ceiling is
// a quarter of. Accept writes it back with refHeight set to the project's
// height, so the two agree; an Accept that changed nothing writes nothing, so
// opening and closing never rounds a thickness set at another height.

const barModal = el('barModal');
const barSides = el('barSides');
const barColorBtn = el('barColorBtn');
const barThickSlider = el('barThickSlider');
const barThickBox = el('barThickBox');
const barSpanSlider = el('barSpanSlider');
const barSpanBox = el('barSpanBox');
const barStage = el('barStage');
const barCanvas = el('barCanvas');
const barBackground = el('barBackground');
const barAcceptBtn = el('barAcceptBtn');
const barCancelBtn = el('barCancelBtn');

let barLayerId = null;
let barFirst = false;
let barDraft = null;     // { side, color, thickness in project pixels, span 0.01 to 1 }
let barOpened = null;    // the draft as it opened, as JSON

// The user's ceiling: a quarter of the frame across the bar, so the height
// for a bar on the top or bottom and the width for one on a side.
function barCeiling(side) {
  const frame = projectFrame();
  const across = side === 'left' || side === 'right';
  return Math.max(1, Math.floor((across ? frame.width : frame.height) / 4));
}

function barGenOf(draft) {
  return {
    form: 'bar',
    refHeight: projectFrame().height,
    bar: { side: draft.side, color: draft.color, thickness: draft.thickness, span: draft.span },
  };
}

function openBarSettings(layer, first) {
  const bar = layer.gen.bar;
  const frame = projectFrame();
  const scale = genDraw.scaleOf(layer.gen, frame.height);
  barLayerId = layer.id;
  barFirst = first;
  // The thickness the picture has now, which is the one barRect draws.
  const thickness = Math.min(barCeiling(bar.side), Math.max(1, Math.round(bar.thickness * scale)));
  barDraft = { side: bar.side, color: bar.color, thickness, span: bar.span };
  barOpened = JSON.stringify(barDraft);
  barBackground.checked = genBackdropOn;
  barModal.hidden = false;
  showBarDraft(null);
  sizeGenStage(barStage, barCanvas);
  paintBarPreview();
}

function closeBarSettings() {
  settlePick(false);
  barModal.hidden = true;
  barLayerId = null;
  barDraft = null;
  barOpened = null;
  barFirst = false;
}

function showBarDraft(except) {
  const d = barDraft;
  if (!d) return;
  for (const b of barSides.querySelectorAll('button')) {
    b.classList.toggle('btn--active', b.dataset.side === d.side);
  }
  paintSwatch(barColorBtn, d.color);
  barThickSlider.max = String(barCeiling(d.side));
  barThickSlider.value = String(d.thickness);
  if (except !== barThickBox) barThickBox.value = String(d.thickness);
  barSpanSlider.value = String(Math.round(d.span * 100));
  if (except !== barSpanBox) barSpanBox.value = String(Math.round(d.span * 100));
}

function paintBarPreview() {
  if (!barDraft) return;
  paintGenPreview(barStage, barCanvas, barLayerId, barGenOf(barDraft));
}

function changeBar(props, except) {
  if (!barDraft) return;
  barDraft = { ...barDraft, ...props };
  showBarDraft(except);
  paintBarPreview();
}

for (const b of barSides.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    if (!barDraft) return;
    // Clamped when the side changes: a bar a quarter of a 1920 wide frame
    // thick on the left is far past a quarter of its 1080 height on the top.
    const side = b.dataset.side;
    changeBar({ side, thickness: Math.min(barDraft.thickness, barCeiling(side)) }, null);
  });
}

bindNumberField({
  slider: barThickSlider,
  box: barThickBox,
  range: () => [1, barDraft ? barCeiling(barDraft.side) : 1],
  set: (n, except) => changeBar({ thickness: n }, except),
  show: () => showBarDraft(null),
});

bindNumberField({
  slider: barSpanSlider,
  box: barSpanBox,
  range: () => [1, 100],
  set: (n, except) => changeBar({ span: n / 100 }, except),
  show: () => showBarDraft(null),
});

barColorBtn.addEventListener('click', async () => {
  if (!barDraft) return;
  const was = barDraft.color;
  const id = barLayerId;
  const picked = await pickColor(was, (color) => {
    if (barLayerId === id) changeBar({ color }, null);
  });
  // The modal may have been closed under the picker, by Escape for one.
  if (barLayerId !== id) return;
  changeBar({ color: picked || was }, null);
});

barBackground.addEventListener('change', () => {
  genBackdropOn = barBackground.checked;
  paintBarPreview();
});

barAcceptBtn.addEventListener('click', () => {
  if (!barDraft) return;
  const id = barLayerId;
  const changed = JSON.stringify(barDraft) !== barOpened;
  const first = barFirst;
  const gen = barGenOf(barDraft);
  closeBarSettings();
  acceptGenSettings(id, gen, changed, first);
});

function cancelBarSettings() {
  const first = barFirst;
  closeBarSettings();
  if (first) cancelGenAdd();
}

barCancelBtn.addEventListener('click', cancelBarSettings);

bindPopup(barModal, cancelBarSettings);
