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

  // V2.3. How long a still is when it arrives, asked for by the user. It is a
  // starting length and nothing more: both of an image's edges can be dragged
  // anywhere between the start of the timeline and forever, which is the one
  // way an image layer is not simply a video layer with a single frame in it.
  const IMAGE_SECONDS = 10;

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
  /**
   * What a layer's source is, as against what the layer does.
   *
   * `type` stays what it always was, video or audio, because that is what
   * decides which block the layer sits in, whether it is drawn or heard, and
   * how it is composited. An image is a video layer in every one of those
   * senses, so it keeps `type: 'video'` and every existing test of it goes on
   * working untouched.
   *
   * What `kind` says is where the pixels come from and whether there is a clock
   * behind them. Two values today. It is deliberately not a boolean, because
   * the V3 text layer the file already anticipates, "a layer with no source
   * file", is a third one, and a boolean would have to be replaced to admit it.
   */
  function kindOf(props) {
    return props && props.kind === 'image' ? 'image' : 'media';
  }

  /**
   * How long a still is, which is its own business and not its source's.
   *
   * An image has no source length to be held inside, and createLayer's ordinary
   * rule clamps a layer to `sourceDuration - sourceIn`. For an image that is
   * zero, so a layer asked for with ten seconds would come out with none at all
   * and never draw. That is the reason kind has to be known here rather than
   * set on the layer afterwards.
   */
  function stillSpan(props) {
    const n = Number(props && props.duration);
    if (!props || props.duration === undefined || !Number.isFinite(n)) return IMAGE_SECONDS;
    return Math.max(MIN_LAYER_SPAN, n);
  }

  function createLayer(props = {}) {
    const kind = kindOf(props);
    const sourceDuration = Math.max(0, round(props.sourceDuration || 0));
    const sourceIn = clamp(props.sourceIn === undefined ? 0 : props.sourceIn, 0, sourceDuration);
    // A layer defaults to showing the rest of its source from sourceIn onwards.
    const rest = sourceDuration - sourceIn;
    const duration = kind === 'image'
      ? round(stillSpan(props))
      : (props.duration === undefined ? rest : clamp(props.duration, 0, rest));
    return {
      id: props.id || newId(),
      type: props.type === 'audio' ? 'audio' : 'video',
      // V2.3. Declared here for the reason fadeIn and render are: the project
      // open path runs every layer back through createLayer, and a field this
      // does not name is a field it drops. An image whose kind vanished on
      // reopening would come back as a video layer with no frames.
      kind,
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
      // V2.1's Render Position tab owns this one: where the cropped picture is
      // placed and scaled inside the project frame, in project pixels. null
      // means centre and fit, which is what placeLayer works out for itself.
      //
      // Declared beside crop because the two travel together everywhere. Both
      // are rectangles the geometry reads, both are null by default, and until
      // this line existed a layer could carry a position that createLayer threw
      // away: every undo and every project reopened would have quietly put the
      // layer back in the middle of the frame.
      render: props.render || null,
      // V2.2's fades, in seconds in from each end of the layer. Zero is no
      // fade, which is what every layer and every project file written before
      // this existed reads as, so nothing old changes.
      //
      // Declared here for the reason render is declared here: a field the model
      // does not name is a field createLayer silently drops, and the project
      // open path runs every layer back through createLayer. A fade that
      // survived being set and vanished on reopening would be that same bug a
      // second time.
      fadeIn: Math.max(0, round(props.fadeIn || 0)),
      fadeOut: Math.max(0, round(props.fadeOut || 0)),
      // V2.4. The ceiling the fades rise to, asked for as a line across the
      // clip: "Add a new horizontal line to set maximum alpha of video tracks."
      // 1 for every layer until somebody drags that line, so nothing written
      // before this existed reads any differently.
      //
      // Through alphaOf rather than a ternary, so undefined and nonsense both
      // land on 1 rather than on the 0 a bare clamp would give them. A layer
      // that came back invisible because a field was missing would look exactly
      // like a layer that had been turned off.
      alpha: alphaOf(props),
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
  //
  // V2.3. A still has no source to run out of, so it has no limit: the user
  // asked for an image to be extendable past its own length by dragging, where
  // a video stops at the last frame it has. Infinity rather than a large
  // number, because trimLayer clamps against this and a clamp with no ceiling
  // is what "no ceiling" means. round(Infinity) is Infinity, so the arithmetic
  // above it needs no special case.
  function sourceRemaining(layer) {
    if (layer && layer.kind === 'image') return Infinity;
    return round(layer.sourceDuration - layer.sourceIn);
  }

  // How much source lies before the in-point. The limit on lengthening a layer
  // from its left edge, and sourceRemaining's twin: the two together are the
  // whole of what stops an edge, so a rule that holds one edge and not the
  // other has one of them written in the wrong place.
  //
  // V2.3. A still has no source to run back into any more than it has one to
  // run out of, so the only thing that stops its left edge is the start of the
  // timeline. That is the user's own exception: an image's edge extends "except
  // it sits at 0.0s already, obviously". Infinity is what says there is no
  // limit of its own, and the Math.max(0, ...) at the call site, which every
  // layer already goes through, is what turns that into 0.0s.
  function sourceBefore(layer) {
    if (layer && layer.kind === 'image') return Infinity;
    return round(layer.sourceIn);
  }

  function covers(layer, t) {
    return t >= layer.start && t < endOf(layer);
  }

  // ---- V2.2, 22a. Fades ----
  //
  // Two numbers on a layer and one function over them, because the preview and
  // ffmpeg both have to answer "how opaque is this layer right now" and they
  // must not answer it differently. That is the rule Step 4 set when the
  // preview and the encoder were first made to agree, and the reason the ramp
  // is linear and nothing else: a straight line is what ffmpeg's fade filter
  // draws, so the two match exactly rather than closely.

  /**
   * A layer's two fade lengths, clamped to the layer itself.
   *
   * Each is held to the layer's own span and no further. They are deliberately
   * not held apart from each other: a fade in and a fade out that overlap
   * simply multiply, which is what two chained fade filters do in ffmpeg, so
   * letting them overlap is what keeps the preview and the export identical
   * without a priority rule that would have to be invented and then matched on
   * both sides.
   */
  function fadesOf(layer) {
    const span = Math.max(0, round(Number(layer && layer.duration) || 0));
    const hold = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? round(Math.min(span, n)) : 0;
    };
    return { in: hold(layer && layer.fadeIn), out: hold(layer && layer.fadeOut) };
  }

  /**
   * How opaque a layer is at timeline second `t`, from 0 to 1.
   *
   * 1 for a layer with no fades, which is every layer until somebody drags one,
   * so the common case costs one comparison. Clamped to the layer's own span
   * rather than refusing a time outside it: callers have already decided the
   * layer is on screen, and a fade is about the ends of the layer.
   */
  function fadeAlphaAt(layer, t) {
    const span = Math.max(0, round(Number(layer && layer.duration) || 0));
    if (!(span > 0)) return 1;
    const fades = fadesOf(layer);
    if (!fades.in && !fades.out) return 1;
    const into = clamp(round(t - (Number(layer.start) || 0)), 0, span);
    let alpha = 1;
    if (fades.in > 0) alpha *= Math.min(1, into / fades.in);
    if (fades.out > 0) alpha *= Math.min(1, (span - into) / fades.out);
    return clamp(alpha, 0, 1);
  }

  // ---- V2.4. The maximum alpha of a layer ----
  //
  // One number, built the way the fades are and for the same reason: the
  // preview and ffmpeg both have to answer "how opaque is this layer" and they
  // are not allowed to answer it separately.
  //
  // It is a **ceiling**, not a second fade. A fade ramps from nothing up to
  // whatever this is, which is why the two multiply rather than argue: a layer
  // at 60% that fades in goes 0%, 30%, 60%, and the line the user drags is the
  // top of that ramp. ffmpeg reaches the same picture with colorchannelmixer
  // after the fade filters, which multiplies for the same reason.

  /**
   * A layer's maximum alpha, 0 to 1.
   *
   * 1 for anything that has never been touched and for anything that arrives
   * unreadable, because the one value that cannot be a mistake is the one that
   * changes nothing.
   */
  function alphaOf(layer) {
    // `layer ? layer.alpha : undefined` rather than `layer && layer.alpha`,
    // which is the idiom fadesOf uses two functions up. That one is safe and
    // this one is not, for a reason worth saying out loud: `null && x` is null,
    // and Number(null) is **0**, not NaN. A fade's default is 0 anyway, so the
    // difference never shows there. Alpha's default is 1, so the same
    // expression would have read a missing layer as fully transparent, which is
    // the exact failure the paragraph above claims to rule out. A test found
    // it; the comment did not.
    const n = Number(layer ? layer.alpha : undefined);
    return Number.isFinite(n) ? clamp(round(n), 0, 1) : 1;
  }

  /**
   * How opaque a layer's picture actually is at timeline second `t`.
   *
   * The ceiling times the ramp, and **this is the one that draws a layer**.
   * fadeAlphaAt is the ramp on its own, which is not the whole answer for a
   * picture and is the whole answer for a sound: the audio side multiplies the
   * ramp by the layer's volume instead, because alpha is a thing about a
   * picture and a silent 40% layer is not what anybody means by one.
   */
  function layerAlphaAt(layer, t) {
    return clamp(alphaOf(layer) * fadeAlphaAt(layer, t), 0, 1);
  }

  /**
   * Set a layer's maximum alpha.
   *
   * Returns the same layer object when the value has not moved, so a drag that
   * has not yet crossed a pixel does not churn the list. Held to 0 and 1 on the
   * way in as well as on the way out, for the reason setFade is: the number the
   * line is drawn at and the number the drag reports have to be one number, or
   * the line carries on past the bottom of the clip while the picture has
   * already stopped changing.
   */
  function setAlpha(layers, id, value) {
    return replace(layers, id, (l) => {
      const n = Number(value);
      const want = Number.isFinite(n) ? clamp(round(n), 0, 1) : 1;
      return want === alphaOf(l) ? l : { ...l, alpha: want };
    });
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
   * V2.3. A still has no source behind either edge, so both of its edges run as
   * far as they are dragged. sourceBefore and sourceRemaining are where that is
   * said; this reads the same for every layer.
   *
   * `edge` is 'start' or 'end', and `time` is where on the timeline that edge is
   * being dropped.
   */
  function trimLayer(layers, id, edge, time) {
    return replace(layers, id, (l) => {
      const end = endOf(l);
      if (edge === 'start') {
        // Back as far as the source's own beginning, forward to a minimum clip.
        const earliest = Math.max(0, round(l.start - sourceBefore(l)));
        const start = clamp(time, earliest, round(end - MIN_LAYER_SPAN));
        const shift = round(start - l.start);
        return {
          ...l,
          start: round(start),
          // A no-op for media, where earliest is worked out from sourceIn and
          // the shift can never take it below zero. It is the whole of what a
          // still needs: its edge runs past its own beginning, and there is no
          // in-point behind it to go negative.
          sourceIn: round(Math.max(0, l.sourceIn + shift)),
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

  /**
   * Set one of a layer's two fades, in seconds.
   *
   * Held to the layer's own span on the way in as well as on the way out.
   * fadesOf already clamps when it reads, so this is not what makes the maths
   * safe; it is what makes the number the clip draws and the number the handle
   * reports the same one, so a fade dragged past the end of the clip stops
   * under the pointer rather than carrying on invisibly.
   */
  function setFade(layers, id, which, seconds) {
    const key = which === 'out' ? 'fadeOut' : 'fadeIn';
    return replace(layers, id, (l) => {
      const span = Math.max(0, round(Number(l.duration) || 0));
      const n = Number(seconds);
      const want = Number.isFinite(n) ? clamp(round(n), 0, span) : 0;
      return want === round(Number(l[key]) || 0) ? l : { ...l, [key]: want };
    });
  }

  /**
   * The same, for a whole group.
   *
   * A picture and its own sound fade together, the way they already move and
   * trim together. Fading a clip out and leaving its sound at full volume is
   * not something anybody means by fading a clip out, and setting it twice on
   * every pair would be the ordinary case rather than the rare one.
   *
   * Each member is clamped to its own span rather than to the group's, so a
   * pair whose halves are not quite the same length stays sane.
   */
  function fadeGroup(layers, id, which, seconds) {
    const members = groupOf(layers, id);
    if (members.length < 2) return setFade(layers, id, which, seconds);
    let next = layers;
    for (const member of members) next = setFade(next, member.id, which, seconds);
    return next;
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
      const earliest = Math.max(0, round(layer.start - sourceBefore(layer)));
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
    sourceBefore,
    covers,
    IMAGE_SECONDS,
    fadesOf,
    fadeAlphaAt,
    alphaOf,
    layerAlphaAt,
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
    setFade,
    fadeGroup,
    setAlpha,
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
