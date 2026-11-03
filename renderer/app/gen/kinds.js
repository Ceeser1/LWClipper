'use strict';

// V3. The kinds of generated media and what the window does with each: the
// Add Media menu, a new layer, its settings, its name and its clip.

// ---- V3. The kinds of generated media ----
//
// Everything the window knows about each kind, in one place: what Add Media
// calls it, what a new one starts as, the settings it opens and their title,
// what its clip is called and how the clip is drawn. A new kind is an entry
// here, plus its form in timeline.js's genOf, its drawing in genDraw.js and
// its settings modal; nothing else in the window has to learn about it. Menu
// order is the order written here. A kind with `variants` opens a submenu of
// its own, and the variant picked is handed to its starter: the shapes.
//
// The functions are wrapped rather than named directly, so the table can sit
// before the modals it opens.
const GEN_KINDS = {
  text: {
    label: () => t('Text'),
    settingsTitle: () => t('Edit Text'),
    starter: () => ({ form: 'text', text: { runs: [{ text: t('Text'), style: {} }] } }),
    open: (layer, first) => openTextSettings(layer, first),
    name: (gen) => {
      const text = genWords(gen);
      return text.length > 60 ? text.slice(0, 59) + '...' : text || t('Text');
    },
    drawClip: (...args) => drawClipText(...args),
  },
  bar: {
    label: () => t('Bar'),
    settingsTitle: () => t('Bar Settings'),
    starter: () => ({ form: 'bar' }),
    open: (layer, first) => openBarSettings(layer, first),
    name: () => t('Bar'),
    drawClip: (...args) => drawClipBar(...args),
  },
  shape: {
    label: () => t('Shapes'),
    variants: () => timelineModel.SHAPE_KINDS.map((kind) => ({ id: kind, label: shapeName(kind) })),
    settingsTitle: () => t('Shape Settings'),
    starter: (kind) => ({ form: 'shape', shape: { kind } }),
    open: (layer, first) => openShapeSettings(layer, first),
    name: (gen) => shapeName(gen.shape.kind),
    drawClip: (...args) => drawClipShape(...args),
  },
};

// Written out one by one, so check-locales finds every name.
function shapeName(kind) {
  const names = {
    circle: () => t('Circle'),
    square: () => t('Square'),
    triangle: () => t('Triangle'),
    star: () => t('Star'),
    ring: () => t('Ring'),
  };
  return (names[kind] || names.circle)();
}

// A form this window does not know is shown as a text, the way the model
// reads one.
function genKind(gen) {
  return GEN_KINDS[gen && gen.form] || GEN_KINDS.text;
}

/** A text's words on one line, for a label. */
function genWords(gen) {
  if (!gen || !gen.text) return '';
  return gen.text.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
}

/**
 * V3. A generated layer's settings, whichever modal its kind has.
 *
 * `first` is the opening that follows adding it, where Cancel removes the
 * layer and Accept commits the add and the settings as one step.
 */
function openGenSettings(id, first) {
  const layer = timelineModel.layerById(layers, id);
  if (!layer || layer.kind !== 'gen') return;
  // V3.3. On a layer with keyframes the modal edits the one at the playhead,
  // or a new one there, the same rule as the crop popup. It is handed the
  // layer as that keyframe has it, so no modal has to know about keyframes;
  // acceptGenSettings sorts what comes back.
  genKeyframe = first ? null : genKeyframeToEdit(layer);
  const shown = genKeyframe ? { ...layer, gen: timelineModel.withKeyed(layer.gen, genKeyframe) } : layer;
  genKind(layer.gen).open(shown, first);
}

// V3.3. The keyframe the open settings modal is editing, as a draft with the
// layer's id, or null when the layer has none.
let genKeyframe = null;

// V3.3. The keyframe the open modal is on, when it is this layer's: what its
// remembered zoom and pan are kept under.
function genKeyframeOf(layerId) {
  return genKeyframe && genKeyframe.layerId === layerId ? genKeyframe : null;
}

/** What a generated layer is called where it has to be named. */
function genLabel(layer) {
  return genKind(layer.gen).name(layer.gen);
}

function closeClipMenu() {
  if (!clipMenu) return;
  clipMenu.remove();
  clipMenu = null;
}

/**
 * The menu, at the pointer. On a clip it offers all four; on the empty part of
 * a row only Paste has anything to act on, and the other three are there and
 * greyed rather than missing, so the menu is the same shape wherever it opens.
 */
function openClipMenu(evt, track) {
  closeClipMenu();
  const rect = timelineLane.getBoundingClientRect();
  const at = Math.max(0, timelineView.xToTime(tlView, evt.clientX - rect.left));
  const type = track.dataset.type;
  const lane = Number(track.dataset.lane);
  // V3.3. A diamond stands in the track beside its clip, not inside it, and
  // names its clip itself.
  const keyEl = evt.target.closest('.clip-key');
  const clipEl = evt.target.closest('.layer-clip[data-layer-id]');
  const layerId = keyEl ? keyEl.dataset.layerId : clipEl && clipEl.dataset.layerId;
  const layer = layerId && timelineModel.layerById(layers, layerId);
  if (layer) selectLayer(layer.id);

  const menu = document.createElement('div');
  menu.className = 'clip-menu';
  menu.setAttribute('role', 'menu');
  const item = (label, enabled, act) => {
    const b = document.createElement('button');
    b.className = 'clip-menu__item';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.disabled = !enabled;
    b.addEventListener('click', () => {
      closeClipMenu();
      act();
    });
    menu.appendChild(b);
  };
  addMediaEntry(menu, type === 'video', at);
  // V3.3. Keyframes, on a clip that can have them and within it. On anything
  // else they are there and greyed, so the menu keeps its shape.
  const keyable = !!layer && timelineModel.keyframable(layer) && timelineModel.covers(layer, at);
  item(t('Add Keyframe'), keyable, () => addKeyframeAt(layer.id, at - layer.start));
  item(t('Delete Keyframe'), !!layer && !!keyEl, () => deleteKeyframe(layer.id, keyEl.dataset.keyId));
  item(t('Crop Keyframe'), !!layer && !!keyEl, () => editKeyframe(layer.id, keyEl.dataset.keyId));
  item(t('Split here'), !!layer && timelineModel.canSplitAt(layer, at),
    () => splitSelected(at));
  item(t('Copy'), !!layer, () => copySelected());
  item(t('Paste'), !!layerClipboard, () => pasteAt(at, type, lane));
  item(t('Delete'), !!layer, () => deleteSelected());
  document.body.appendChild(menu);

  // At the pointer, and pulled back inside the window when it would run off
  // the right or the bottom, which a click near the end of the timeline does.
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = Math.max(4, Math.min(evt.clientX, window.innerWidth - w - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(evt.clientY, window.innerHeight - h - 4)) + 'px';
  clipMenu = menu;
}

timelineStack.addEventListener('contextmenu', (evt) => {
  const track = evt.target.closest && evt.target.closest('.layer-track[data-lane]');
  if (!track || busy || !timelineDriving()) return;
  evt.preventDefault();
  openClipMenu(evt, track);
});

// "clicking anywhere outside of it closes it". Capture, so a press that goes on
// to start a drag or a scrub closes the menu first rather than being stopped
// on the way by whatever it landed on.
document.addEventListener('pointerdown', (evt) => {
  if (clipMenu && !clipMenu.contains(evt.target)) closeClipMenu();
}, true);
document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape') closeClipMenu();
});
// And anything that moves what it was pointing at out from under it.
window.addEventListener('blur', closeClipMenu);
window.addEventListener('resize', closeClipMenu);
timelineStage.addEventListener('wheel', closeClipMenu, { passive: true });

playSelectionBtn.addEventListener('click', () => {
  // Step 17. This did nothing at all in advanced editing, because it opened on
  // a guard for media that is null there and then drove transport, the preview
  // element, which is not what plays a composite. The selection itself is the
  // same slider on both sides of the switch; only what plays it differs.
  if (timelineDriving()) {
    playUntil = slider.end;
    seekComposite(slider.start);
    playComposite();
    return;
  }
  if (!media) return;
  playUntil = slider.end;
  transport.currentTime = slider.start;
  transport.play();
  syncPreviewAudio(true);
});
for (const elem of [previewVideo, previewSound]) {
  elem.addEventListener('timeupdate', () => {
    if (playUntil !== null && transport.currentTime >= playUntil) {
      transport.pause();
      playUntil = null;
    }
  });
}

// A bar's clip is its colour, over the checkerboard its alpha shows through.
function drawClipBar(layer, ctx, leftX, width, height) {
  const cell = Math.max(3, Math.round(height / 4));
  const clipX = timelineView.timeToX(tlView, layer.start);
  const shift = ((((leftX - clipX) % (cell * 2)) + cell * 2) % (cell * 2));
  ctx.fillStyle = '#9a9aa2';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#6a6a72';
  for (let y = 0, row = 0; y < height; y += cell, row += 1) {
    for (let x = -shift + (row % 2) * cell; x < width; x += cell * 2) {
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.fillStyle = layer.gen.bar.color;
  ctx.fillRect(0, 0, width, height);
}

// A shape's clip is the shape in its colour at the clip's visible left edge,
// with a thin dark edge so a white or faint one still shows, and its name.
function drawClipShape(layer, ctx, leftX, width, height) {
  const shape = layer.gen.shape;
  const clipX = timelineView.timeToX(tlView, layer.start);
  const x = Math.max(0, clipX - leftX) + 6;
  const h = Math.max(4, Math.round(height * 0.6));
  const w = h * (genDraw.SHAPE_ASPECT[shape.kind] || 1);
  genDraw.fillShape(ctx, shape.kind, { x, y: (height - h) / 2, w, h }, shape.color);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.stroke();
  ctx.font = Math.max(8, Math.round(height * 0.4)) + 'px "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8e8ee';
  ctx.fillText(shapeName(shape.kind), x + w + 6, height / 2);
}

// A text's clip is its words, in its own font.
function drawClipText(layer, ctx, leftX, width, height) {
  const text = genWords(layer.gen);
  if (!text) return;
  const style = layer.gen.text.style;
  // The clip's own left edge while it is on screen, and the screen's left edge
  // once it has scrolled off to the left.
  const clipX = timelineView.timeToX(tlView, layer.start);
  const x = Math.max(0, clipX - leftX) + 6;
  ctx.font = textLayout.fontString({ ...style, size: Math.max(8, height * 0.5) });
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8e8ee';
  ctx.fillText(text, x, height / 2);
}
