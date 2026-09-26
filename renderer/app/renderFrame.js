'use strict';

// V2.7, Crop Render Frame: the output frame itself, its presets and boxes.

// ---- V2.7, Crop Render Frame ----
//
// The output frame itself, not a crop of a picture. Dragging a bar changes what
// the composition covers rather than cutting anything out of it, and it may be
// dragged outwards to make room beside what is already there.
//
// **One rectangle, in a working space.** renderDraft is the output frame,
// renderBase is the composition the window opened on, and renderPins is where
// every layer stands. All three are in the same pixels, and the only thing that
// ever rescales them is a resample, which does all three at once. Dragging
// moves renderDraft and nothing else, so Accept is one subtraction: every
// layer's placement is its pin less the draft's own origin.
//
// The alternative, carrying a coverage rectangle and an output size side by
// side, was rejected on the same grounds as everything else in this file: two
// numbers that have to be kept agreeing eventually disagree.

const renderModal = el('renderModal');
const renderStage = el('renderStage');
const renderCanvas = el('renderCanvas');
const renderBox = el('renderBox');
const renderHintEl = el('renderHint');
const renderWidthBox = el('renderWidthBox');
const renderHeightBox = el('renderHeightBox');
const renderPresetRow = el('renderPresets');
const renderResRow = el('renderResPresets');
const renderAcceptBtn = el('renderAcceptBtn');
const renderCancelBtn = el('renderCancelBtn');

// How far past its own edge the pointer has to sit, and for how long, before a
// bar is let out past the composition. The dwell is TRIM_DWELL_MS rather than
// the 200 the user first suggested, because that constant already means "held
// on purpose rather than passed over" everywhere else in this window.
const RENDER_EXTEND_SLACK = 6;

// Room left around the frame on the stage, so the four grips are reachable.
// Each one sits at -4px of its own edge and so hangs outside the box, and the
// stage clips what leaves it: with the frame fitted edge to edge, every grip was
// clipped away and no bar could be grabbed at all. The crop popup never shows
// this because its picture is fitted inside a 16:9 stage and usually leaves bars
// of its own. Ten is the four pixels of overhang with room over.
const RENDER_STAGE_INSET = 10;

// 9:21 is here and not in the crop popup. That one crops a source, where there
// is nothing outside the picture to reach; this one chooses an output shape,
// and 21:9 had no portrait twin while every other landscape ratio did. Sony's
// CinemaWide phones are the real thing behind it.
const RENDER_ASPECTS = [
  { label: 'Original', ratio: null },
  { label: '21:9', ratio: 21 / 9, wide: true },
  { label: '16:9', ratio: 16 / 9 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '1:1', ratio: 1 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '9:21', ratio: 9 / 21, wide: true },
];

// Named after the short side, which is the one number that does not depend on
// which way up the frame is: 16:9 with 2160p is 3840x2160 and 9:16 with 1080p
// is 1080x1920. The nickname is the part that moves, because the aspect is
// always chosen first: at 21:9 the 2160p button reads UW-4K.
const RENDER_SHORTS = [
  { short: 2160, name: '4K' },
  { short: 1440, name: '2K' },
  { short: 1080, name: 'FHD' },
  { short: 720, name: 'HD' },
  { short: 480, name: 'SD' },
];

let renderDraft = null;      // the output frame, in working pixels
let renderBase = null;       // the composition it opened on, same pixels
let renderPins = null;       // Map layerId -> placement, same pixels
let renderFromFrame = null;  // the project frame it opened on
let renderScale = 1;         // display pixels per working pixel
let renderAspect = null;     // the lit ratio, or null for none
let renderAspectBtn = null;
let renderShortBtn = null;
let renderGesture = null;    // the drag in progress, for the dwell

function canRenderCrop() {
  return !!(timelineDriving() && compositeFrame
    && layers.some((l) => l.type === 'video'));
}

// Where a layer stands right now, placed or fitted, in the frame the window
// opened on. Not placeFitRect, which reads cropDraft: that is the other
// popup's draft and means nothing here.
function renderPinOf(layer) {
  const source = layerSource(layer);
  if (!source) return null;
  const placement = layerGeometry.placeLayer({
    source,
    crop: layer.crop,
    render: layer.render,
    project: renderFromFrame,
  });
  return placement ? { ...placement.dest } : null;
}

// Everything the stage has to hold: the frame and the composition, whichever
// way round they have grown.
function renderUnion() {
  const d = renderDraft;
  const b = renderBase;
  const x0 = Math.min(d.x, b.x);
  const y0 = Math.min(d.y, b.y);
  const x1 = Math.max(d.x + d.width, b.x + b.width);
  const y1 = Math.max(d.y + d.height, b.y + b.height);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function sizeRenderStage() {
  const panel = renderStage.parentElement.parentElement;
  // Always 16:9 whatever shape the frame is, the same rule the crop stage
  // follows and for the same reason: a portrait project must not make the
  // window narrow and tall.
  let w = Math.round(panel.clientWidth * CROP_FRAME_SHARE);
  let h = Math.round(w * 9 / 16);
  const maxH = Math.round(window.innerHeight * CROP_HEIGHT_SHARE);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * 16 / 9);
  }
  renderStage.style.width = w + 'px';
  renderStage.style.height = h + 'px';
}

/**
 * The scale, which only ever drops part way through a gesture.
 *
 * This is the user's "first by filling out grey bars if they exist, else by
 * shrinking the displayed content accordingly if there are no dark grey bars to
 * fill anymore", and it is one conditional rather than a mechanism. While the
 * frame is growing into the bars around the picture the union still fits at the
 * scale it already has, so nothing on screen moves at all. Once it does not
 * fit, everything shrinks to make room.
 *
 * Settled outright on release, not during, which is the rule the crop popup's
 * box-move already follows: re-fitting upward mid-drag would slide the picture
 * out from under the pointer as soon as a bar came back in.
 */
function fitRenderScale(settle) {
  const u = renderUnion();
  const across = Math.max(1, renderStage.clientWidth - 2 * RENDER_STAGE_INSET);
  const down = Math.max(1, renderStage.clientHeight - 2 * RENDER_STAGE_INSET);
  const room = Math.min(across / u.w, down / u.h);
  if (settle || !(renderScale > 0) || room < renderScale) renderScale = room;
}

// Where a working rectangle lands on the stage.
function renderOnStage(rect) {
  const u = renderUnion();
  const ox = (renderStage.clientWidth - u.w * renderScale) / 2;
  const oy = (renderStage.clientHeight - u.h * renderScale) / 2;
  return {
    left: ox + (rect.x - u.x) * renderScale,
    top: oy + (rect.y - u.y) * renderScale,
    width: rect.width * renderScale,
    height: rect.height * renderScale,
  };
}

function placeRenderBox() {
  const box = renderOnStage(renderDraft);
  renderBox.style.left = Math.round(box.left) + 'px';
  renderBox.style.top = Math.round(box.top) + 'px';
  renderBox.style.width = Math.round(box.width) + 'px';
  renderBox.style.height = Math.round(box.height) + 'px';
  const pic = renderOnStage(renderBase);
  renderCanvas.style.left = Math.round(pic.left) + 'px';
  renderCanvas.style.top = Math.round(pic.top) + 'px';
  renderCanvas.style.width = Math.round(pic.width) + 'px';
  renderCanvas.style.height = Math.round(pic.height) + 'px';
  // The boxes say what the frame is, and typing in them is how it is said back.
  // V2.8 dropped the line of text above them that said the same two numbers,
  // the user having counted them: shown twice, so shown once.
  if (document.activeElement !== renderWidthBox) {
    renderWidthBox.value = String(renderDraft.width);
  }
  if (document.activeElement !== renderHeightBox) {
    renderHeightBox.value = String(renderDraft.height);
  }
}

// The composite, drawn at the size the opening frame takes up on the stage.
// paintLayers maps the whole project frame onto whatever canvas it is handed,
// and renderBase is that frame, so the two agree without being told to.
function paintRenderFrame() {
  const pic = renderOnStage(renderBase);
  const w = Math.max(1, Math.round(pic.width));
  const h = Math.max(1, Math.round(pic.height));
  const dpr = window.devicePixelRatio || 1;
  renderCanvas.width = Math.max(1, Math.round(w * dpr));
  renderCanvas.height = Math.max(1, Math.round(h * dpr));
  paintLayers(renderCanvas.getContext('2d'), renderCanvas, compositeAt);
}

function setRenderHint(mirrored, diagonal = false, locked = false) {
  if (locked) {
    renderHintEl.textContent = t('Locked: the frame keeps the shape selected below');
  } else if (mirrored && diagonal) {
    renderHintEl.textContent = t('Mirrored and diagonal: all four borders, 1 px each');
  } else if (mirrored) {
    renderHintEl.textContent = t('Mirrored: both bars moving together, 1 px each');
  } else if (diagonal) {
    renderHintEl.textContent = t('Diagonal: both borders of the corner, 2 px each');
  } else {
    renderHintEl.textContent = t(CROP_HINT_IDLE);
  }
}

/**
 * How far a bar may travel, as positions in the working space.
 *
 * Getters rather than numbers, because the dwell widens them part way through a
 * gesture: until it fires a bar is held at the edge of the composition, and
 * after it the caps are the only thing left in the way. bindGrip reads these on
 * every move, which is what makes that possible.
 *
 * leastX and leastY are the shortest legal side on each axis, which is not a
 * constant here: the ratio cap means the smallest width depends on the current
 * height and the other way round.
 */
function renderDragBounds() {
  const across = layerGeometry.renderFrameSide(renderDraft.height);
  const down = layerGeometry.renderFrameSide(renderDraft.width);
  const x0 = renderDraft.x;
  const y0 = renderDraft.y;
  const x1 = x0 + renderDraft.width;
  const y1 = y0 + renderDraft.height;
  const b = renderBase;
  const out = () => !!(renderGesture && renderGesture.extended);
  return {
    get minX() { return out() ? x1 - across.max : Math.min(b.x, x0); },
    get maxX() { return out() ? x0 + across.max : Math.max(b.x + b.width, x1); },
    get minY() { return out() ? y1 - down.max : Math.min(b.y, y0); },
    get maxY() { return out() ? y0 + down.max : Math.max(b.y + b.height, y1); },
    leastX: across.min,
    leastY: down.min,
  };
}

function renderCommit(shifted, diagonal = false, locked = false) {
  setRenderHint(shifted, diagonal, locked);
  clearRenderPresets();
  fitRenderScale(false);
  paintRenderFrame();
  placeRenderBox();
}

const renderBoxCtx = {
  size: () => (renderFromFrame
    ? { w: renderFromFrame.width, h: renderFromFrame.height }
    : null),
  rect: () => renderDraft,
  bounds: renderDragBounds,
  scale: () => renderScale,
  ratio: () => (renderAspect
    || (renderDraft && renderDraft.height ? renderDraft.width / renderDraft.height : null)),
  hint: setRenderHint,
  commit: renderCommit,
  begin: (info) => {
    renderGesture = { ...info, extended: false, timer: null, last: null };
    document.addEventListener('pointermove', renderWatchPointer, true);
  },
  end: () => {
    renderStopDwell();
    document.removeEventListener('pointermove', renderWatchPointer, true);
    renderGesture = null;
    // The scale is allowed back up now that the hand is off, which is the one
    // moment doing so cannot move anything out from under the pointer.
    fitRenderScale(true);
    paintRenderFrame();
    placeRenderBox();
  },
};

function renderStopDwell() {
  if (renderGesture && renderGesture.timer) clearTimeout(renderGesture.timer);
  if (renderGesture) renderGesture.timer = null;
}

/**
 * The gate on extending, which is a hold rather than a drag.
 *
 * The user asked for it in as many words: push a bar against its own border,
 * keep the pointer a few pixels outside for a moment, and the frame starts
 * growing. Before that the bounds hold the bar at the edge of the composition,
 * so a bar pinned there with the pointer past it is exactly the state this is
 * watching for.
 *
 * When the clock runs out the bar is let go and a pointermove is dispatched
 * back at the grip, so bindGrip's own handler does the arithmetic rather than a
 * second copy of it living here. That works because its move is absolute: it is
 * computed from the press's own edges and the total travel, so one event with
 * the current pointer position lands the bar exactly where it belongs.
 */
function renderWatchPointer(ev) {
  const g = renderGesture;
  if (!g || g.extended || !renderDraft) return;
  g.last = ev;
  // A corner has two axes and no single border to be pushed against, so it is
  // left out: extending is a bar gesture.
  if (g.corner) return;
  const edgeAt = g.vertical
    ? (g.movesLo ? renderDraft.y : renderDraft.y + renderDraft.height)
    : (g.movesLo ? renderDraft.x : renderDraft.x + renderDraft.width);
  const on = renderOnStage({ x: edgeAt, y: edgeAt, width: 0, height: 0 });
  const box = renderStage.getBoundingClientRect();
  const edge = g.vertical ? box.top + on.top : box.left + on.left;
  const at = g.vertical ? ev.clientY : ev.clientX;
  const past = g.movesLo ? edge - at : at - edge;
  if (past < RENDER_EXTEND_SLACK) {
    renderStopDwell();
    return;
  }
  if (g.timer) return;
  g.timer = setTimeout(() => {
    if (!renderGesture || renderGesture !== g) return;
    g.timer = null;
    g.extended = true;
    const e = g.last;
    if (!e) return;
    g.el.dispatchEvent(new PointerEvent('pointermove', {
      clientX: e.clientX,
      clientY: e.clientY,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      pointerId: e.pointerId,
      bubbles: true,
    }));
  }, TRIM_DWELL_MS);
}

// ---- the two preset rows ----

function clearRenderPresets() {
  renderAspect = null;
  if (renderAspectBtn) renderAspectBtn.classList.remove('btn--active');
  if (renderShortBtn) renderShortBtn.classList.remove('btn--active');
  renderAspectBtn = null;
  renderShortBtn = null;
  markRenderShorts();
}

// The ratio the resolution row composes with: the lit aspect, or the shape the
// frame already has when none is lit.
function renderRatioNow() {
  if (renderAspect) return renderAspect;
  if (!renderDraft || !renderDraft.height) return null;
  return renderDraft.width / renderDraft.height;
}

// The aspect is always chosen first, so the resolution row can say what it will
// actually produce. At 21:9 the 2160p button is ultrawide 4K and says so.
function markRenderShorts() {
  const wide = !!(renderAspectBtn && renderAspectBtn.dataset.wide === '1');
  const ratio = renderRatioNow();
  for (const btn of renderResRow.children) {
    const short = Number(btn.dataset.short);
    if (!short) continue;
    const entry = RENDER_SHORTS.find((e) => e.short === short);
    btn.textContent = short + 'p / ' + (wide ? 'UW-' : '') + entry.name;
    // Disabled, not clamped: a button that cannot do what its label says would
    // be lying about it.
    btn.disabled = !ratio || !layerGeometry.renderFrameFor(ratio, short);
  }
}

function renderResample(next, centre) {
  if (!next || !renderDraft) return;
  const from = { width: renderDraft.width, height: renderDraft.height };
  if (next.width === from.width && next.height === from.height) return;
  const rel = (r) => ({
    x: r.x - renderDraft.x,
    y: r.y - renderDraft.y,
    width: r.width,
    height: r.height,
  });
  // The same call the boxes above the preview have always made, so the two
  // cannot drift apart: the old frame is fitted into the new one and everything
  // in it travels by the same scale.
  renderBase = layerGeometry.rescaleRender(rel(renderBase), from, next);
  for (const [id, pin] of renderPins) {
    renderPins.set(id, layerGeometry.rescaleRender(rel(pin), from, next));
  }
  renderDraft = { x: 0, y: 0, width: next.width, height: next.height };
  // A resolution button re-centres for the same reason an aspect button does.
  // The boxes do not: a typed number is a size, not a decision about where the
  // frame sits.
  if (centre) renderCentreOnBase();
  fitRenderScale(true);
  paintRenderFrame();
  placeRenderBox();
}

/**
 * V2.8, item 7.1: "when a direct aspect ratio/resolution gets clicked using
 * buttons, recenter the whole preview frame in the new aspect ratio/resolution
 * (again match relative size/scale and positions)."
 *
 * The frame moves rather than the picture, which is the same arrangement seen
 * from the other side and one object instead of a base and every pin. Only the
 * two of them relative to each other means anything here: Accept subtracts the
 * frame's origin from everything.
 *
 * A drag is left alone on purpose. Dragging the frame off the picture is how
 * the window reframes, and a button is a fresh decision about the shape, so the
 * two want opposite things from a composition that is off centre.
 */
function renderCentreOnBase() {
  if (!renderDraft || !renderBase) return;
  renderDraft = {
    ...renderDraft,
    x: Math.round(renderBase.x + (renderBase.width - renderDraft.width) / 2),
    y: Math.round(renderBase.y + (renderBase.height - renderDraft.height) / 2),
  };
}

// An aspect button changes the frame's shape, growing rather than cutting
// wherever the caps leave room, and leaves it centred on the picture.
function renderReshapeTo(ratio) {
  const next = ratio === null
    ? { width: renderFromFrame.width, height: renderFromFrame.height }
    : layerGeometry.renderReshape(renderDraft, ratio);
  if (!next) return;
  if (ratio === null) {
    // Original is the frame the window opened on, exactly, wherever the
    // dragging went. renderBase is where that frame still is, so this is the
    // centring below as well, arrived at by being the same rectangle.
    renderDraft = { ...renderBase };
    return;
  }
  renderDraft = { ...renderDraft, width: next.width, height: next.height };
  renderCentreOnBase();
}

function buildRenderPresets() {
  renderPresetRow.innerHTML = '';
  for (const preset of RENDER_ASPECTS) {
    const btn = document.createElement('button');
    btn.textContent = preset.label;
    if (preset.wide) btn.dataset.wide = '1';
    btn.addEventListener('click', () => {
      if (!renderDraft) return;
      clearRenderPresets();
      renderReshapeTo(preset.ratio);
      renderAspect = preset.ratio;
      renderAspectBtn = btn;
      btn.classList.add('btn--active');
      markRenderShorts();
      fitRenderScale(true);
      paintRenderFrame();
      placeRenderBox();
    });
    renderPresetRow.appendChild(btn);
  }

  renderResRow.innerHTML = '';
  // Original carries its own number, because it means the pixel count the
  // project opened at while the other Original, in the row above, means its
  // shape. Both are useful and together they give the frame exactly.
  const first = document.createElement('button');
  const openedShort = Math.min(renderFromFrame.width, renderFromFrame.height);
  first.textContent = 'Original (' + openedShort + 'p)';
  first.addEventListener('click', () => {
    if (renderShortBtn) renderShortBtn.classList.remove('btn--active');
    renderShortBtn = first;
    first.classList.add('btn--active');
    const ratio = renderRatioNow();
    renderResample(ratio ? layerGeometry.renderFrameFor(ratio, openedShort) : null, true);
  });
  renderResRow.appendChild(first);

  for (const entry of RENDER_SHORTS) {
    const btn = document.createElement('button');
    btn.dataset.short = String(entry.short);
    btn.addEventListener('click', () => {
      const ratio = renderRatioNow();
      const next = ratio ? layerGeometry.renderFrameFor(ratio, entry.short) : null;
      if (!next) return;
      if (renderShortBtn) renderShortBtn.classList.remove('btn--active');
      renderShortBtn = btn;
      btn.classList.add('btn--active');
      renderResample(next, true);
    });
    renderResRow.appendChild(btn);
  }
  markRenderShorts();
}

// ---- the boxes, which resample and never reframe ----

function commitRenderBoxes() {
  if (!renderDraft) return;
  const want = layerGeometry.frameSize(renderWidthBox.value, renderHeightBox.value);
  if (!want) {
    placeRenderBox();
    return;
  }
  // Held inside the caps rather than refused, because a typed number is a
  // request and not a button making a promise about itself.
  const across = layerGeometry.renderFrameSide(want.height);
  const down = layerGeometry.renderFrameSide(want.width);
  const next = {
    width: clamp(want.width, across.min, across.max),
    height: clamp(want.height, down.min, down.max),
  };
  renderResample(next);
  placeRenderBox();
}

for (const box of [renderWidthBox, renderHeightBox]) {
  box.addEventListener('blur', (evt) => {
    if (evt.relatedTarget === renderWidthBox || evt.relatedTarget === renderHeightBox) return;
    commitRenderBoxes();
  });
  box.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') {
      evt.preventDefault();
      commitRenderBoxes();
      box.blur();
    }
  });
}

// ---- open, accept, close ----

function openRenderCrop() {
  if (busy || !canRenderCrop()) return;
  renderFromFrame = { ...compositeFrame };
  renderDraft = { x: 0, y: 0, width: renderFromFrame.width, height: renderFromFrame.height };
  renderBase = { x: 0, y: 0, width: renderFromFrame.width, height: renderFromFrame.height };
  // Every layer, pinned where it stands. A layer with no placement of its own is
  // auto-fitted to the frame, so a frame that changed shape would re-fit it and
  // hand back exactly the bars this window exists to get rid of.
  renderPins = new Map();
  for (const l of layers) {
    // V3. A generated layer is drawn at whatever size the frame becomes, so it
    // has no pin. Accept carries it through reframeGen instead.
    if (l.type !== 'video' || l.kind === 'gen') continue;
    const pin = renderPinOf(l);
    if (pin) renderPins.set(l.id, pin);
  }
  renderAspect = null;
  renderAspectBtn = null;
  renderShortBtn = null;
  renderGesture = null;
  renderScale = 0;
  renderModal.hidden = false;
  sizeRenderStage();
  buildRenderPresets();
  fitRenderScale(true);
  paintRenderFrame();
  placeRenderBox();
  setRenderHint(false);
}

function closeRenderCrop() {
  renderStopDwell();
  document.removeEventListener('pointermove', renderWatchPointer, true);
  renderModal.hidden = true;
  renderDraft = null;
  renderBase = null;
  renderPins = null;
  renderFromFrame = null;
  renderGesture = null;
}

renderAcceptBtn.addEventListener('click', () => {
  if (!renderDraft || !renderFromFrame) return;
  const out = { width: renderDraft.width, height: renderDraft.height };
  const dx = renderDraft.x;
  const dy = renderDraft.y;
  const pins = renderPins;
  const from = renderFromFrame;
  const moved = out.width !== from.width || out.height !== from.height || dx || dy;
  if (!moved) {
    closeRenderCrop();
    return;
  }
  // The frame first, because everything that redraws below is a picture of it.
  compositeFrame = { ...from, width: out.width, height: out.height };
  sizeCompositeCanvas();
  // Where the old frame went, which is where the base went: its origin in the
  // new frame and its scale, the same move every pin made.
  const base = renderBase;
  const k = base.width / from.width;
  // Then every layer, pinned. One subtraction, which is all the reframe is once
  // the pins are carried in the same space as the frame.
  setLayers(layers.map((l) => {
    // V3, 31a. A generated layer has no pin, but its sizes follow the picture
    // and a text box moves with it. See timelineModel.reframeGen.
    if (l.kind === 'gen') {
      return { ...l, gen: timelineModel.reframeGen(l.gen, from.height, out.height, k, base.x - dx, base.y - dy) };
    }
    const pin = pins.get(l.id);
    if (!pin) return l;
    return {
      ...l,
      render: {
        x: Math.round(pin.x - dx),
        y: Math.round(pin.y - dy),
        width: Math.round(pin.width),
        height: Math.round(pin.height),
      },
    };
  }));
  commitHistory();
  closeRenderCrop();
  updateCropOverlays();
  updateCropBtn();
});

renderCancelBtn.addEventListener('click', closeRenderCrop);

bindPopup(renderModal, closeRenderCrop);

for (const grip of renderBox.querySelectorAll('.crop-grip')) bindGrip(grip, renderBoxCtx);
for (const dot of renderBox.querySelectorAll('.crop-corner')) bindCorner(dot, renderBoxCtx);

// The note only applies while the copy path is selected, and that switch lives
// outside the popup, so it can change while the popup is open.
accurateToggle.addEventListener('change', () => {
  if (!cropModal.hidden && cropDraft) updateCropNote();
});
