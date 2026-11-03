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
  for (const el of timelineStack.querySelectorAll('.clip-key')) {
    const clip = el.closest('.layer-clip');
    const on = !!selectedKeyframe && !!clip
      && clip.dataset.layerId === selectedKeyframe.layerId
      && el.dataset.keyId === selectedKeyframe.id;
    el.classList.toggle('clip-key--selected', on);
  }
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
    return { crop: layer.crop || null, render: layer.render || null, anchor: layer.anchor || null };
  }
  let a = null;
  let b = null;
  for (const k of list) {
    if (k.t <= t) a = k;
    else if (!b) b = k;
  }
  if (!a || !b) {
    const k = a || b;
    return { crop: k.crop, render: k.render, anchor: k.anchor };
  }
  const source = layerSource(layer);
  const p = source && layerGeometry.placementAt(layer, t, source, projectFrame());
  if (!p) return { crop: a.crop, render: a.render, anchor: a.anchor };
  return {
    crop: a.crop || b.crop ? wholeRect(p.src, true) : null,
    render: a.render || b.render ? wholeRect(p.dest, false) : null,
    anchor: a.anchor,
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
  setLayers(timelineModel.putKeyframe(layers, cropLayerId, { ...cropKeyframe, ...fields, id }));
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
  setLayers(timelineModel.putKeyframe(layers, layer.id, { id, t: local, ...keyframeSeed(layer, local) }));
  commitHistory();
  const added = timelineModel.keyframesFor(timelineModel.layerById(layers, layer.id)).find((k) => k.id === id);
  if (added) goToKeyframe(layer, added);
}

function deleteKeyframe(layerId, id) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || busy || !timelineModel.keyframesFor(layer).some((k) => k.id === id)) return false;
  setLayers(timelineModel.removeKeyframe(layers, layerId, id));
  commitHistory();
  selectKeyframe(null, null);
  updateCropBtn();
  return true;
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

/** One diamond per keyframe, on a clip that can have them. */
function buildClipKeyframes(clip, layer) {
  if (!timelineModel.keyframable(layer)) return;
  for (const k of timelineModel.keyframesFor(layer)) {
    const key = document.createElement('div');
    key.className = 'clip-key';
    key.dataset.keyId = k.id;
    key.title = t('Keyframe, click to go to it, drag to move it');
    clip.appendChild(key);
    bindKeyframeDrag(key, layer.id, k.id);
  }
  paintKeyframeSelection();
}

// Half the diamond's drawn width, from the stylesheet, so its point sits on the
// keyframe's moment.
const CLIP_KEY_HALF = 5;

/**
 * Each diamond at its moment of the clip, measured from the clip's left edge.
 * One trimmed off the clip is hidden and kept, the user's rule.
 */
function placeClipKeyframes(clip, layer, x0) {
  for (const el of clip.querySelectorAll('.clip-key')) {
    const k = timelineModel.keyframesFor(layer).find((o) => o.id === el.dataset.keyId);
    const shown = !!k && k.t >= 0 && k.t <= layer.duration;
    el.hidden = !shown;
    if (!shown) continue;
    el.style.left = (timelineView.timeToX(tlView, layer.start + k.t) - x0 - CLIP_KEY_HALF) + 'px';
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
      const clip = node.closest('.layer-clip');
      if (clip) placeClipKeyframes(clip, now, timelineView.timeToX(tlView, now.start));
      seekComposite(now.start + moved.t);
      updatePlayhead();
    };
    const onUp = () => {
      if (!drag.moved) return;
      setLayers(layers);
      commitHistory();
    };
    beginDrag(node, evt, onMove, onUp);
  });
}

// A press anywhere on the timeline that is not on a diamond lets the chosen
// keyframe go, so Delete is back to meaning the clip. Captured, so it is seen
// before a clip's own drag takes the press.
timelineStack.addEventListener('pointerdown', (evt) => {
  if (!selectedKeyframe) return;
  if (evt.target.closest && evt.target.closest('.clip-key')) return;
  selectKeyframe(null, null);
}, true);
