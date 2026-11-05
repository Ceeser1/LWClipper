'use strict';

// V3.3. Keyframes on the timeline: the diamonds on a clip, choosing one and
// moving it, adding and deleting them, and which one the crop popup edits.
//
// The model is in src/timeline.js under "Keyframes" and the blend between two
// in src/geometry.js, placementAt, which the preview and composer.js both read.
// This file is only the window's half: where a keyframe is drawn and what a
// press on one does.
//
// The user's rules, 2026-11-03: the picture moves smoothly from one keyframe to
// the next and two close together make a jump; an edit with the playhead
// between two makes a new one there; a trim that passes one keeps it, out of
// view, still steering the part that shows.

// The header's readout of the chosen keyframe.
const keyframeReadout = el('keyframeReadout');

// How near the playhead has to be for an edit to change the keyframe that is
// there rather than make a new one beside it: half a frame of the project
// either side, which is every moment that frame stands for.
function keyframeReach() {
  const fps = Number(projectFrame().fps) || 30;
  return 0.5 / fps;
}

function newKeyframeId() {
  return 'k' + Math.random().toString(36).slice(2, 10);
}

function selectKeyframe(layerId, id) {
  selectedKeyframe = layerId && id ? { layerId, id } : null;
  paintKeyframeSelection();
}

/** The chosen keyframe, when it is this layer's. */
function selectedKeyframeOf(layer) {
  if (!layer || !selectedKeyframe || selectedKeyframe.layerId !== layer.id) return null;
  return timelineModel.keyframesFor(layer).find((k) => k.id === selectedKeyframe.id) || null;
}

function paintKeyframeSelection() {
  // A keyframe that has gone, by an undo or with its clip, is not chosen.
  if (selectedKeyframe) {
    const layer = timelineModel.layerById(layers, selectedKeyframe.layerId);
    if (!selectedKeyframeOf(layer)) selectedKeyframe = null;
  }
  for (const el of timelineStack.querySelectorAll('.clip-key')) {
    const on = !!selectedKeyframe
      && el.dataset.layerId === selectedKeyframe.layerId
      && el.dataset.keyId === selectedKeyframe.id;
    el.classList.toggle('clip-key--selected', on);
  }
  updateKeyframeReadout();
}

/**
 * The header's "Selected Keyframe: Video X Keyframe Y / Z", the user's words:
 * X the layer's number, Y the chosen one's place among all the keyframes on
 * that layer and Z how many there are. A layer is a row here, the user's sense
 * of the word, so a row holding two clips counts the keyframes of both, in
 * the order they stand on the timeline. Only the ones in view are counted,
 * since a keyframe trimmed off a clip cannot be chosen. Hidden while none is
 * chosen.
 */
function updateKeyframeReadout() {
  const layer = selectedKeyframe && timelineModel.layerById(layers, selectedKeyframe.layerId);
  const k = selectedKeyframeOf(layer);
  keyframeReadout.hidden = !k;
  if (!k) return;
  const onRow = layers
    .filter((l) => l.type === 'video' && l.lane === layer.lane)
    .flatMap((l) => timelineModel.keyframesFor(l)
      .filter((o) => o.t >= 0 && o.t <= l.duration)
      .map((o) => ({ layerId: l.id, id: o.id, at: l.start + o.t })))
    .sort((a, b) => a.at - b.at);
  const n = onRow.findIndex((o) => o.layerId === layer.id && o.id === k.id) + 1;
  keyframeReadout.textContent = t('Selected Keyframe: {layer} Keyframe {n} / {total}', {
    layer: layerLabel('video', layerOrdinal(layer)),
    n,
    total: onRow.length,
  });
}

// Whole pixels, and even ones for a crop, which is what every crop the popup
// makes already is.
function wholeRect(r, even) {
  if (!r) return null;
  const n = even ? (v) => Math.round(v / 2) * 2 : Math.round;
  return { x: n(r.x), y: n(r.y), width: Math.max(2, n(r.width)), height: Math.max(2, n(r.height)) };
}

/**
 * What a new keyframe at `t` starts as: exactly the picture that is there now,
 * so adding one changes nothing until it is edited. On a layer with none yet
 * that is the layer's own crop and placement; between two it is the blend; past
 * the first or the last it is that one's.
 *
 * A crop or a placement that neither neighbour has stays null, so a layer left
 * on centre and fit keeps following its crop.
 */
function keyframeSeed(layer, t) {
  // V3.3, stage 2. A generated layer's is what its keyed settings are then.
  if (layer.kind === 'gen') {
    const frame = projectFrame();
    return timelineModel.keyedOfGen(genDraw.genAt(layer, t, frame.width, frame.height));
  }
  const list = timelineModel.keyframesFor(layer);
  if (!list.length) {
    return {
      crop: layer.crop || null, render: layer.render || null, anchor: layer.anchor || null, rotation: layer.rotation || 0,
    };
  }
  let a = null;
  let b = null;
  for (const k of list) {
    if (k.t <= t) a = k;
    else if (!b) b = k;
  }
  // V3.6. The mask's box and soft edge there too, when either side holds its
  // own; a keyframe holding none goes on standing for the layer's.
  const maskThere = () => {
    if (!layer.mask || !((a && a.mask) || (b && b.mask))) return null;
    const m = timelineModel.maskAt(layer, t);
    return { box: { ...m.box }, soft: m.soft };
  };
  if (!a || !b) {
    const k = a || b;
    return { crop: k.crop, render: k.render, anchor: k.anchor, rotation: k.rotation || 0, mask: k.mask || null };
  }
  const source = layerSource(layer);
  const p = source && layerGeometry.placementAt(layer, t, source, projectFrame());
  if (!p) return { crop: a.crop, render: a.render, anchor: a.anchor, rotation: a.rotation || 0, mask: maskThere() };
  return {
    crop: a.crop || b.crop ? wholeRect(p.src, true) : null,
    render: a.render || b.render ? wholeRect(p.dest, false) : null,
    anchor: a.anchor,
    // V3.4. The turn there, blended the short way round.
    rotation: p.rotation || 0,
    mask: maskThere(),
  };
}

/**
 * The keyframe the crop popup edits on this layer, as a draft, or null when the
 * layer has none and the popup edits the layer itself as it always has.
 *
 * The one at the playhead while the playhead is on the clip, and a new one
 * there when there is none, which Accept then makes: "it should create a new
 * keyframe". With the playhead off the clip, the one last clicked, and failing
 * that the nearest end of the clip.
 */
function keyframeToEdit(layer) {
  if (!timelineModel.keyframesFor(layer).length) return null;
  const local = compositeAt - layer.start;
  const onClip = local >= 0 && local <= layer.duration;
  if (!onClip) {
    const chosen = selectedKeyframeOf(layer);
    if (chosen) return { ...chosen };
  }
  const t = Math.min(Math.max(local, 0), layer.duration);
  const near = timelineModel.keyframeNear(layer, t, keyframeReach());
  if (near) return { ...near };
  return { id: null, t, ...keyframeSeed(layer, t) };
}

/**
 * V3.3, stage 2. The same choice for a generated layer's settings modal, with
 * the layer's id on it so its Accept can tell it is the one it opened on.
 */
function genKeyframeToEdit(layer) {
  if (!timelineModel.keyframesFor(layer).length) return null;
  const local = compositeAt - layer.start;
  const onClip = local >= 0 && local <= layer.duration;
  const chosen = !onClip && selectedKeyframeOf(layer);
  if (chosen) return { ...chosen, layerId: layer.id };
  const t = Math.min(Math.max(local, 0), layer.duration);
  const near = timelineModel.keyframeNear(layer, t, keyframeReach());
  if (near) return { ...near, layerId: layer.id };
  return { id: null, t, ...keyframeSeed(layer, t), layerId: layer.id };
}

/**
 * Writes the popup's keyframe with `fields` changed, making it if it is new,
 * and chooses it. The caller commits.
 */
function saveCropKeyframe(fields) {
  if (!cropKeyframe || !cropLayerId) return;
  const id = cropKeyframe.id || newKeyframeId();
  // V3.3. The keyframe as it stands now, not as it was when the popup opened:
  // the main window stays usable while the popup is out, so the keyframe may
  // have been dragged along the clip, or the clip trimmed, in the meantime.
  const layer = timelineModel.layerById(layers, cropLayerId);
  const live = cropKeyframe.id && layer
    ? timelineModel.keyframesFor(layer).find((k) => k.id === cropKeyframe.id)
    : null;
  setLayers(timelineModel.putKeyframe(layers, cropLayerId, { ...cropKeyframe, ...(live || {}), ...fields, id }));
  selectKeyframe(cropLayerId, id);
}

/** A keyframe at `t` of the clip, the right click's Add Keyframe. */
function addKeyframeAt(layerId, t) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || !timelineModel.keyframable(layer) || busy) return;
  const local = Math.min(Math.max(t, 0), layer.duration);
  selectLayer(layer.id);
  // One already there is chosen rather than doubled.
  const near = timelineModel.keyframeNear(layer, local, keyframeReach());
  if (near) {
    goToKeyframe(layer, near);
    return;
  }
  const id = newKeyframeId();
  // The user: "If a first keyframe gets added anywhere, always put #1 keyframe
  // at the very start of the track." Both start as the clip is, so neither
  // moves anything until one of them is edited. One added at the start is
  // that keyframe already.
  let next = layers;
  if (!timelineModel.keyframesFor(layer).length && local > keyframeReach()) {
    next = timelineModel.putKeyframe(next, layer.id, { id: newKeyframeId(), t: 0, ...keyframeSeed(layer, 0) });
  }
  setLayers(timelineModel.putKeyframe(next, layer.id, { id, t: local, ...keyframeSeed(layer, local) }));
  commitHistory();
  const added = timelineModel.keyframesFor(timelineModel.layerById(layers, layer.id)).find((k) => k.id === id);
  if (added) goToKeyframe(layer, added);
}

function deleteKeyframe(layerId, id) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || busy || !timelineModel.keyframesFor(layer).some((k) => k.id === id)) return false;
  // V3.3. The keyframe a crop window has open, or one whose going takes it
  // with it (a last pair collapses), asks first.
  const left = timelineModel.keyframesFor(layer).length - 1;
  const hit = cropWindowOn(layerId) && (!cropKeyframe || cropKeyframe.id === id || left < 2);
  return confirmPopoutConflict([hit && cropWindowConflict()], () => {
    removeKeyframeNow(layerId, id);
    return true;
  });
}

function removeKeyframeNow(layerId, id) {
  setLayers(timelineModel.removeKeyframe(layers, layerId, id));
  commitHistory();
  selectKeyframe(null, null);
  updateCropBtn();
  return true;
}

/**
 * The right click's Edit Keyframe (Crop Keyframe until V3.4): that keyframe chosen, the playhead on it,
 * and the window that edits it opened there. On a video or an image that is
 * the crop popup; a text, a shape or a bar has nothing to crop and its
 * keyframes are edited in its own settings, so that is what opens.
 */
function editKeyframe(layerId, id) {
  const layer = timelineModel.layerById(layers, layerId);
  const k = layer && timelineModel.keyframesFor(layer).find((o) => o.id === id);
  if (!k || busy) return;
  selectLayer(layer.id);
  goToKeyframe(layer, k);
  if (layer.kind === 'gen') openGenSettings(layer.id, false);
  else openCrop(layer.id);
}

/** Del or Backspace with a keyframe chosen. */
function deleteSelectedKeyframe() {
  if (!selectedKeyframe) return false;
  return deleteKeyframe(selectedKeyframe.layerId, selectedKeyframe.id);
}

// Choosing a keyframe takes the playhead to it, so the preview shows that
// keyframe's picture and the crop popup opens on it.
function goToKeyframe(layer, k) {
  selectKeyframe(layer.id, k.id);
  seekComposite(layer.start + k.t);
  updatePlayhead();
}

// ---- the diamonds ----

/**
 * One diamond per keyframe of a clip that can have them, in the clip's track:
 * a diamond reaches a little above and below the clip's strip, and inside the
 * clip its edge would cut that off. Each says whose it is, since the track
 * holds every clip of the row.
 */
function buildClipKeyframes(track, layer) {
  if (!timelineModel.keyframable(layer)) return;
  for (const k of timelineModel.keyframesFor(layer)) {
    const key = document.createElement('div');
    key.className = 'clip-key';
    key.dataset.layerId = layer.id;
    key.dataset.keyId = k.id;
    key.title = t('Keyframe, click to go to it, drag to move it, double-click to edit it');
    track.appendChild(key);
    bindKeyframeDrag(key, layer.id, k.id);
  }
  paintKeyframeSelection();
}

// How far a diamond reaches past the strip, above and below alike: "so they
// stick a little bit above and below even".
const CLIP_KEY_REACH = 2;

/**
 * Each diamond at its moment of the clip and on the middle of its strip, in
 * the track's pixels. One trimmed off the clip is hidden and kept, the user's
 * rule.
 */
function placeClipKeyframes(clip, layer) {
  const track = clip.parentElement;
  if (!track) return;
  const strip = Number(clip.dataset.keyStrip) || 0;
  // From point to point, the strip and the reach either side of it.
  const tall = strip + 2 * CLIP_KEY_REACH;
  const middle = clip.offsetTop + CLIP_BORDER + clip.clientHeight - strip / 2;
  const mine = '.clip-key[data-layer-id="' + layer.id + '"]';
  for (const el of track.querySelectorAll(mine)) {
    const k = timelineModel.keyframesFor(layer).find((o) => o.id === el.dataset.keyId);
    const shown = !!k && k.t >= 0 && k.t <= layer.duration && strip > 0;
    el.hidden = !shown;
    if (!shown) continue;
    el.style.width = tall + 'px';
    el.style.height = tall + 'px';
    el.style.setProperty('--key-side', (tall / Math.SQRT2) + 'px');
    el.style.left = (timelineView.timeToX(tlView, layer.start + k.t) - tall / 2) + 'px';
    el.style.top = (middle - tall / 2) + 'px';
  }
}

// As far as the pointer goes before a press on a diamond is a drag: the fade
// handles' two pixels.
const KEY_DRAG_SLOP = 2;

/**
 * A press on a diamond chooses it and takes the playhead there. Dragged, it
 * slides along the clip, the playhead and the picture with it, so what is being
 * moved is in view the whole way.
 *
 * Into `layers` directly while it runs and committed on release, the way every
 * timeline drag is, since setLayers rebuilds the rows and would take away the
 * element the pointer is captured on.
 */
function bindKeyframeDrag(node, layerId, keyId) {
  node.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || busy) return;
    const layer = timelineModel.layerById(layers, layerId);
    const k = layer && timelineModel.keyframesFor(layer).find((o) => o.id === keyId);
    if (!k) return;
    evt.stopPropagation();
    evt.preventDefault();
    selectLayer(layerId);
    goToKeyframe(layer, k);
    const drag = { x: evt.clientX, from: k.t, moved: false };
    const onMove = (ev) => {
      if (!drag.moved) {
        if (Math.abs(ev.clientX - drag.x) < KEY_DRAG_SLOP) return;
        drag.moved = true;
      }
      const want = drag.from + (ev.clientX - drag.x) / tlView.scale;
      layers = timelineModel.moveKeyframe(layers, layerId, keyId, want);
      const now = timelineModel.layerById(layers, layerId);
      const moved = now && timelineModel.keyframesFor(now).find((o) => o.id === keyId);
      if (!moved) return;
      const clip = node.parentElement
        && node.parentElement.querySelector('.layer-clip[data-layer-id="' + layerId + '"]');
      if (clip) placeClipKeyframes(clip, now);
      seekComposite(now.start + moved.t);
      updatePlayhead();
    };
    const onUp = () => {
      node.dataset.dragged = String(drag.moved);
      if (!drag.moved) return;
      setLayers(layers);
      commitHistory();
    };
    beginDrag(node, evt, onMove, onUp);
  });
  // V3.4. The user: "A double-click on a keyframe should bring up its render
  // crop/settings", the right click's Edit Keyframe: the crop window for a
  // video or an image, the settings for a text, a shape or a bar. Not after a
  // press that dragged it, which was a move.
  node.addEventListener('dblclick', (evt) => {
    evt.stopPropagation();
    if (busy || node.dataset.dragged === 'true') return;
    editKeyframe(layerId, keyId);
  });
}

// A press anywhere on the timeline that is not on a diamond lets the chosen
// keyframe go, so Delete is back to meaning the clip. Captured, so it is seen
// before a clip's own drag takes the press.
//
// It also remembers where each press was, for the double click below.
let lastPress = null;
let prevPress = null;
timelineStack.addEventListener('pointerdown', (evt) => {
  prevPress = lastPress;
  lastPress = { x: evt.clientX, y: evt.clientY };
  if (!selectedKeyframe) return;
  if (evt.target.closest && evt.target.closest('.clip-key')) return;
  selectKeyframe(null, null);
}, true);

// How far apart the two presses of a double click may be and still be "at
// exact the same position": the pixel the user aims at, and one either side
// for a hand that is not a machine.
const KEY_DOUBLE_REACH = 1;

/**
 * A double click on a picture clip adds a keyframe where it was, the user's
 * "Double-clicking a track twice at exact the same position should add a
 * keyframe at that position". Not on the clip's own controls, the marks, the
 * fade handles and lines or the trim grips, which a double click on means
 * nothing new, and not when the two presses landed apart, which is two
 * clicks rather than one place clicked twice.
 */
timelineStack.addEventListener('dblclick', (evt) => {
  if (!timelineDriving() || busy) return;
  const clip = evt.target.closest && evt.target.closest('.layer-clip[data-layer-id]');
  if (!clip) return;
  if (evt.target.closest('.layer-clip__marks, .clip-fade-dot, .clip-fade-line, .layer-clip__edge')) return;
  if (!prevPress || !lastPress
    || Math.abs(prevPress.x - lastPress.x) > KEY_DOUBLE_REACH
    || Math.abs(prevPress.y - lastPress.y) > KEY_DOUBLE_REACH) return;
  const layer = timelineModel.layerById(layers, clip.dataset.layerId);
  if (!layer || !timelineModel.keyframable(layer)) return;
  const rect = timelineLane.getBoundingClientRect();
  const at = timelineView.xToTime(tlView, evt.clientX - rect.left);
  if (!timelineModel.covers(layer, at)) return;
  addKeyframeAt(layer.id, at - layer.start);
});
