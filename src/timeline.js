'use strict';

// The layer model for advanced editing. Pure functions over a plain array, no
// DOM and no Electron, so it can be tested the way trimmer.js is and so the
// whole document is one JSON.stringify away from being a .lwc file.
//
// Nothing here mutates. Every function that changes something returns a new
// array with new objects for the layers it touched, because the undo stack is
// snapshots of this state and a shared object would let a past snapshot change
// under it.
//
// Two invariants the rest of the app relies on:
//
//   Order is draw order, top first. Index 0 is Video 1 and is drawn last so it
//   lands on top; the highest index is furthest back. layersAt() hands them
//   back already reversed, so a caller just loops and draws.
//
//   Video layers come before audio layers. One list with a type field rather
//   than two arrays, because undo and the project file both want a single list,
//   and keeping the types in blocks is what makes the timeline rows stack the
//   way they do, video above audio.

// Wrapped so the window, which loads this as a plain script beside app.js,
// gets one name out of it rather than twenty. Several of those twenty are
// generic enough to collide with the renderer's own: clamp already does.
const timelineModel = (() => {
  // Below this a layer is not a clip any more, it is a mistake. Same value as
  // trimmer.js MIN_SPAN, which guards the output range for the same reason.
  const MIN_LAYER_SPAN = 0.05;

  // Timeline positions come out of drag arithmetic, so they accumulate binary
  // noise fast. Microsecond resolution is finer than any frame rate cares about
  // and keeps 0.1 + 0.2 from turning into a trim that is one epsilon too long.
  function round(t) {
    return Math.round(t * 1e6) / 1e6;
  }

  // A pixel dimension: a whole number of pixels, or nothing at all. Zero and
  // "not measured yet" are the same thing here, and both mean "ask the decoder".
  function size(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function clamp(v, lo, hi) {
    if (!Number.isFinite(v)) return lo;
    return Math.min(hi, Math.max(lo, v));
  }

  function newId() {
    return 'l' + Math.random().toString(36).slice(2, 10);
  }

  function newGroupId() {
    return 'g' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * A layer, with everything the preview, the encoder and the project file need.
   *
   * `src` is deliberately optional rather than required: a V3 text layer has no
   * file, and a model that assumes a path on every layer makes that awkward
   * forever.
   */
  function createLayer(props = {}) {
    const sourceDuration = Math.max(0, round(props.sourceDuration || 0));
    const sourceIn = clamp(props.sourceIn === undefined ? 0 : props.sourceIn, 0, sourceDuration);
    // A layer defaults to showing the rest of its source from sourceIn onwards.
    const rest = sourceDuration - sourceIn;
    const duration = props.duration === undefined ? rest : clamp(props.duration, 0, rest);
    return {
      id: props.id || newId(),
      type: props.type === 'audio' ? 'audio' : 'video',
      name: props.name || '',
      src: props.src || null,
      start: round(Math.max(0, props.start || 0)),
      duration: round(duration),
      sourceIn: round(sourceIn),
      sourceDuration: round(sourceDuration),
      enabled: props.enabled === undefined ? true : !!props.enabled,
      volume: props.volume === undefined ? 1 : props.volume,
      // Set and read by grouping in Step 14. Declared here because the
      // serialisable shape wants settling in one place, not because anything
      // reads it yet.
      groupId: props.groupId || null,
      // Step 2's geometry owns what goes in here. null means the whole frame.
      crop: props.crop || null,
      // The frame that crop is measured in. A rectangle without the frame it
      // was cut from means nothing, which is why simple mode already sends its
      // own alongside it. These are the probe's coded dimensions rather than
      // any video element's intrinsic size, because the coded ones are what
      // ffmpeg's crop filter works in. Zero when nothing has measured the
      // source: every audio layer, and any video one still loading.
      sourceWidth: size(props.sourceWidth),
      sourceHeight: size(props.sourceHeight),
      // Step 15. The project's frame rate is seeded from its first source, and
      // the export is written at the project's rate, so the rate has to travel
      // with the layer for a project reopened from a file to render at the rate
      // it was built at. Zero for an audio layer and for anything ffprobe would
      // not commit to.
      sourceFps: Math.max(0, round(props.sourceFps || 0)),
    };
  }

  function endOf(layer) {
    return round(layer.start + layer.duration);
  }

  // How much source is left after the in-point. The limit on lengthening a layer
  // from its right edge.
  function sourceRemaining(layer) {
    return round(layer.sourceDuration - layer.sourceIn);
  }

  function covers(layer, t) {
    return t >= layer.start && t < endOf(layer);
  }

  /**
   * Where inside the source file a given timeline moment falls. The one equation
   * the preview and the encoder both read, so they cannot drift apart.
   *
   * Returns a number whether or not the layer covers `t`, because the caller
   * deciding that is cheaper than every caller having to handle a null. Ask
   * covers() first.
   */
  function sourceTimeFor(layer, t) {
    return round(t - layer.start + layer.sourceIn);
  }

  function layerById(layers, id) {
    return layers.find((l) => l.id === id) || null;
  }

  function indexOfLayer(layers, id) {
    return layers.findIndex((l) => l.id === id);
  }

  /**
   * Every enabled layer covering `t`, back to front, so drawing them in order
   * leaves Video 1 on top.
   *
   * Audio layers come back too and their order among themselves is meaningless,
   * which is fine: a mix does not care what order it sums in. Callers filter by
   * type.
   */
  function layersAt(layers, t) {
    const hits = [];
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const l = layers[i];
      if (l.enabled && covers(l, t)) hits.push(l);
    }
    return hits;
  }

  /**
   * The project's length: where the last layer to end, ends.
   *
   * Disabled layers still count. They still occupy the timeline and still come
   * back if the box is ticked, so letting the total jump about as layers are
   * muted would be a surprise.
   */
  function totalDuration(layers) {
    let end = 0;
    for (const l of layers) {
      const e = endOf(l);
      if (e > end) end = e;
    }
    return round(end);
  }

  // The end of the type's block, which is where a new layer of that type belongs:
  // video appends after the last video row, audio after the last audio row.
  function blockEnd(layers, type) {
    let last = -1;
    for (let i = 0; i < layers.length; i += 1) {
      if (layers[i].type === type) last = i;
    }
    if (last >= 0) return last + 1;
    // No layer of this type yet. Video opens the list, audio closes it.
    return type === 'video' ? 0 : layers.length;
  }

  /**
   * Adds a layer, by default at the end of its own type's block so the video and
   * audio rows stay in their groups. An explicit index overrides that.
   */
  function addLayer(layers, layer, index) {
    const at = index === undefined
      ? blockEnd(layers, layer.type)
      : clamp(index, 0, layers.length);
    const next = layers.slice();
    next.splice(at, 0, layer);
    return next;
  }

  function removeLayer(layers, id) {
    return layers.filter((l) => l.id !== id);
  }

  function replace(layers, id, fn) {
    let touched = false;
    const next = layers.map((l) => {
      if (l.id !== id) return l;
      touched = true;
      return fn(l);
    });
    return touched ? next : layers;
  }

  /**
   * Moves a layer one place towards the front or the back, past its nearest
   * neighbour of the same type.
   *
   * Same type, because stepping over an audio row would put a video layer below
   * the audio block and break the row grouping, and because "Video 2 goes above
   * Video 1" is what the arrows mean. A negative delta is towards the front.
   */
  function reorderLayer(layers, id, delta) {
    const from = indexOfLayer(layers, id);
    if (from < 0 || !delta) return layers;
    const step = delta < 0 ? -1 : 1;
    let to = -1;
    for (let i = from + step; i >= 0 && i < layers.length; i += step) {
      if (layers[i].type === layers[from].type) { to = i; break; }
    }
    if (to < 0) return layers;
    const next = layers.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    return next;
  }

  /**
   * Slides a layer along the timeline without touching what it shows. Clamped at
   * zero, since nothing can start before the project does.
   */
  function moveLayer(layers, id, newStart) {
    return replace(layers, id, (l) => ({ ...l, start: round(Math.max(0, newStart)) }));
  }

  /**
   * Drags one edge of a layer. Non-destructive: the source is untouched, the
   * layer simply shows more or less of it, so a layer trimmed in can always be
   * dragged back out to its full extent.
   *
   * Dragging the left edge moves start and sourceIn together, which is what keeps
   * the picture still while the edge moves. Dragging the right edge changes only
   * how long the layer runs.
   *
   * `edge` is 'start' or 'end', and `time` is where on the timeline that edge is
   * being dropped.
   */
  function trimLayer(layers, id, edge, time) {
    return replace(layers, id, (l) => {
      const end = endOf(l);
      if (edge === 'start') {
        // Back as far as the source's own beginning, forward to a minimum clip.
        const earliest = Math.max(0, round(l.start - l.sourceIn));
        const start = clamp(time, earliest, round(end - MIN_LAYER_SPAN));
        const shift = round(start - l.start);
        return {
          ...l,
          start: round(start),
          sourceIn: round(l.sourceIn + shift),
          duration: round(l.duration - shift),
        };
      }
      const latest = round(l.start + sourceRemaining(l));
      const newEnd = clamp(time, round(l.start + MIN_LAYER_SPAN), latest);
      return { ...l, duration: round(newEnd - l.start) };
    });
  }

  function setLayer(layers, id, props) {
    return replace(layers, id, (l) => ({ ...l, ...props }));
  }

  // ---- grouping, Step 14 ----
  //
  // A video file dropped into a video layer also makes an audio layer for its
  // sound, and the pair is linked: it moves and trims as one until it is
  // ungrouped. Everything below is about the group as a unit, because "move
  // this clip" and "move this clip and its sound together" are different sums
  // and only one of them can be done a layer at a time.

  /**
   * Every layer in the same group, in list order.
   *
   * A layer with no group is a group of one, so callers never need the special
   * case. A group of one is also a real state: deleting one member of a pair
   * leaves the other still carrying the marker.
   */
  function groupOf(layers, id) {
    const layer = layerById(layers, id);
    if (!layer) return [];
    if (!layer.groupId) return [layer];
    return layers.filter((l) => l.groupId === layer.groupId);
  }

  /**
   * The distinct group ids, in the order they first appear in the list.
   *
   * What the marker's shape and colour are chosen by. First-appearance order
   * rather than a hash, so two groups can never be handed the same marker; the
   * cost is that deleting a group shifts the markers of the ones after it,
   * which is cosmetic and visible rather than a collision that is neither.
   */
  function groupIds(layers) {
    const seen = [];
    for (const l of layers) {
      if (l.groupId && !seen.includes(l.groupId)) seen.push(l.groupId);
    }
    return seen;
  }

  /** Links every named layer into one new group, and hands back its id. */
  function group(layers, ids, groupId) {
    const id = groupId || newGroupId();
    const wanted = new Set(ids);
    return layers.map((l) => (wanted.has(l.id) ? { ...l, groupId: id } : l));
  }

  /** Breaks the link. The layers stay exactly where they are. */
  function ungroup(layers, groupId) {
    if (!groupId) return layers;
    return layers.map((l) => (l.groupId === groupId ? { ...l, groupId: null } : l));
  }

  /**
   * Slide a whole group, keeping the members' offsets from each other.
   *
   * The shift is clamped once for the group rather than per layer, because
   * clamping each one separately is what would let a pair slide apart at the
   * start of the timeline: the video stops at zero and the sound carries on.
   */
  function moveGroup(layers, id, newStart) {
    const members = groupOf(layers, id);
    const layer = layerById(layers, id);
    if (!layer || members.length < 2) return moveLayer(layers, id, newStart);
    let shift = round(newStart - layer.start);
    // Nothing can start before the project does, so the group stops when its
    // earliest member would.
    const earliest = Math.min(...members.map((l) => l.start));
    shift = Math.max(shift, -earliest);
    const wanted = new Map(members.map((l) => [l.id, round(l.start + shift)]));
    return layers.map((l) => (wanted.has(l.id)
      ? { ...l, start: round(Math.max(0, wanted.get(l.id))) }
      : l));
  }

  /** How far one layer's given edge may travel, as a low and high shift. */
  function trimRange(layer, edge) {
    if (edge === 'start') {
      const earliest = Math.max(0, round(layer.start - layer.sourceIn));
      const latest = round(endOf(layer) - MIN_LAYER_SPAN);
      return { lo: round(earliest - layer.start), hi: round(latest - layer.start) };
    }
    const end = endOf(layer);
    const earliest = round(layer.start + MIN_LAYER_SPAN);
    const latest = round(layer.start + sourceRemaining(layer));
    return { lo: round(earliest - end), hi: round(latest - end) };
  }

  /**
   * Drag one edge of a whole group.
   *
   * The shift every member can take, intersected, then applied to all of them.
   * Taking the dragged layer's own new position and handing the same absolute
   * time to the others would be wrong the moment a pair is not perfectly
   * aligned, and intersecting first is what keeps them from drifting apart when
   * one of them runs out of source before the other.
   */
  function trimGroup(layers, id, edge, time) {
    const members = groupOf(layers, id);
    const layer = layerById(layers, id);
    if (!layer || members.length < 2) return trimLayer(layers, id, edge, time);
    const from = edge === 'start' ? layer.start : endOf(layer);
    let shift = round(time - from);
    let lo = -Infinity;
    let hi = Infinity;
    for (const member of members) {
      const range = trimRange(member, edge);
      lo = Math.max(lo, range.lo);
      hi = Math.min(hi, range.hi);
    }
    // An empty intersection means one member has no room at all, so nothing
    // moves rather than the group tearing.
    if (lo > hi) return layers;
    shift = clamp(shift, lo, hi);
    if (!shift) return layers;
    let next = layers;
    for (const member of members) {
      const at = edge === 'start' ? member.start : endOf(member);
      next = trimLayer(next, member.id, edge, round(at + shift));
    }
    return next;
  }

  return {
    MIN_LAYER_SPAN,
    createLayer,
    endOf,
    sourceRemaining,
    covers,
    sourceTimeFor,
    layerById,
    indexOfLayer,
    layersAt,
    totalDuration,
    addLayer,
    removeLayer,
    reorderLayer,
    moveLayer,
    trimLayer,
    setLayer,
    newGroupId,
    groupOf,
    groupIds,
    group,
    ungroup,
    moveGroup,
    trimRange,
    trimGroup,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = timelineModel;
