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

  // V2.9. A lane number, or nothing. Nothing is what every layer written before
  // lanes existed carries, and arrangeLanes gives those one each.
  function laneValue(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : null;
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
   * behind them. It is deliberately not a boolean, because the V3 text layer
   * the file anticipated, "a layer with no source file", is a third one, and a
   * boolean would have had to be replaced to admit it.
   *
   * V3. The third one arrived as `gen`, generated media: text and the bar,
   * drawn by the app from settings rather than decoded from a file. Its
   * settings are the `gen` object, see genOf below.
   */
  function kindOf(props) {
    if (props && (props.kind === 'image' || props.kind === 'gen')) return props.kind;
    return 'media';
  }

  /**
   * V3. Whether a layer is a still: one picture held for as long as the layer
   * lasts, with no clock behind it. An image is one, and so is everything
   * generated, which is drawn once from its settings and then behaves exactly
   * like an image for every rule that asks: its length, how far its edges can
   * be dragged, and what a split does to its source.
   */
  function isStill(layer) {
    return !!layer && (layer.kind === 'image' || layer.kind === 'gen');
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

  // ---- V3. Generated media ----
  //
  // A generated layer has no file. What it shows is the `gen` object, and the
  // window draws that into a frame-size picture which the preview and the
  // export then treat as an image. Everything here is the shape of that object
  // and the defaults and limits of each setting, so that a .lwc edited by hand,
  // or written by a later 3.X with fields this one has never heard of, opens as
  // something drawable rather than as an error halfway through a frame.
  //
  // `form` rather than `type`, because a layer's type is already video or
  // audio and a generated layer is a video one in every sense that word has.

  const GEN_FORMS = ['text', 'bar'];

  // Sizes in the gen object are pixels at the project height they were set at,
  // and that height travels with them as `refHeight`. Drawn into a frame of
  // another height, they scale by the ratio, so a title keeps its look when
  // the project goes from 720p to 1080p. A file without one reads as 1080p.
  const GEN_REF_HEIGHT = 1080;

  // The user's figures: outline thickness, shadow distance and shadow size are
  // all 1 to 64 pixels. Pixels of the project, as the modals show them, which
  // is not what is stored: a text keeps its sizes at its refHeight, and a new
  // one is set at 1080 whatever the project, so 64 on a 720p project is 96 in
  // the file and 1 on a 1080p project that was 720p is two thirds. The file is
  // therefore held only to a guard, a hundredth of a pixel (what the modals
  // store to) up to GEN_EFFECT_LIMIT, and the 1 to 64 is the modals' to keep.
  const GEN_EFFECT_MAX = 64;
  const GEN_EFFECT_MIN = 0.01;
  const GEN_EFFECT_LIMIT = 1024;

  // The largest font size, in pixels at refHeight. Past the frame on any
  // project anyone makes, so it is a guard against a typo, not a design limit.
  const GEN_FONT_MAX = 2000;

  // Only for a file that names no font at all. A font that is named but not
  // installed is kept as named, because the project may be opened on the PC
  // that has it; falling back for the drawing is the window's business.
  const DEFAULT_FONT = 'Arial';

  const TEXT_H = ['left', 'center', 'right'];
  const TEXT_V = ['top', 'middle', 'bottom'];
  const BAR_SIDES = ['top', 'right', 'bottom', 'left'];

  function bool(v) {
    return v === true;
  }

  // A number held to a range, or the fallback when it is not a number at all.
  // The clamp above would turn nonsense into the bottom of the range, which for
  // a font size is one pixel and looks exactly like a bug.
  function within(v, lo, hi, fallback) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function oneOf(v, list, fallback) {
    return list.includes(v) ? v : fallback;
  }

  /**
   * A colour as `#rrggbbaa`, lowercase, which is what canvas takes as it is and
   * what the colour picker hands back. Six digits read as fully opaque, since
   * that is what a colour written without its alpha has always meant.
   */
  function colourOf(v, fallback) {
    if (typeof v !== 'string') return fallback;
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v.trim());
    if (!m) return fallback;
    return ('#' + m[1] + (m[2] || 'ff')).toLowerCase();
  }

  // Both effects are null when they are off, which is the user's Remove: "Remove
  // button completely removes the selected options". Off is not an outline of
  // no width, it is no outline.
  function outlineOf(v) {
    if (!v || typeof v !== 'object') return null;
    return {
      color: colourOf(v.color, '#000000ff'),
      width: within(v.width, GEN_EFFECT_MIN, GEN_EFFECT_LIMIT, 4),
    };
  }

  /**
   * The shadow. `angle` is the direction it falls in, in degrees: the user's
   * convention, 0 to the right, positive clockwise, and -180 and +180 both to
   * the left. `fade` is how much of the colour's alpha is gone by the far edge
   * of `size`, 0 to 1, so 0 keeps it solid all the way out and the default of
   * 1 fades it to nothing.
   */
  function shadowOf(v) {
    if (!v || typeof v !== 'object') return null;
    return {
      color: colourOf(v.color, '#000000b3'),
      angle: within(v.angle, -180, 180, 45),
      distance: within(v.distance, GEN_EFFECT_MIN, GEN_EFFECT_LIMIT, 8),
      size: within(v.size, GEN_EFFECT_MIN, GEN_EFFECT_LIMIT, 8),
      fade: within(v.fade, 0, 1, 1),
    };
  }

  /**
   * One text style. With `partial` it is a run's own style, which holds only
   * what that run changes from the text's style, so only the fields actually
   * present come out. Without it every field is filled in.
   *
   * A partial style keeps an effect set to null, because on a run null is a
   * statement, "no outline on these words", where an absent field says "the
   * same as the rest".
   */
  function textStyleOf(v, partial) {
    const src = v && typeof v === 'object' ? v : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
    const out = {};
    const field = (k, fn) => {
      if (!partial || has(k)) out[k] = fn(src[k]);
    };
    field('font', (f) => (typeof f === 'string' && f.trim() ? f.trim() : DEFAULT_FONT));
    field('size', (n) => within(n, 1, GEN_FONT_MAX, 96));
    field('color', (c) => colourOf(c, '#ffffffff'));
    field('bold', bool);
    field('italic', bool);
    field('underline', bool);
    field('strike', bool);
    field('outline', outlineOf);
    field('shadow', shadowOf);
    return out;
  }

  /**
   * The text itself, as runs: pieces of text that each carry the style they
   * change. 3.0 formats a text as one, so it always has exactly one run with
   * nothing changed, but the layout already measures and draws run by run. The
   * user asked for the ground to be laid for words formatted one by one later,
   * and this is it: that becomes splitting runs, not changing what a text is.
   *
   * There is always at least one run, even for no text, so there is always a
   * style to measure an empty line with.
   */
  function runsOf(v) {
    const list = Array.isArray(v) ? v : [];
    const runs = list
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        text: typeof r.text === 'string' ? r.text.replace(/\r\n?/g, '\n') : '',
        style: textStyleOf(r.style, true),
      }));
    return runs.length ? runs : [{ text: '', style: {} }];
  }

  // 31a's box, in project pixels at refHeight. null is the whole frame, which
  // is all 3.0 has.
  function boxOf(v) {
    if (!v || typeof v !== 'object') return null;
    const x = Number(v.x);
    const y = Number(v.y);
    const w = Number(v.w);
    const h = Number(v.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  // 31b's rotation in degrees, kept to -180 up to and including 180 so that
  // one angle has one number.
  function rotationOf(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    const r = round(((n % 360) + 360) % 360);
    return r > 180 ? round(r - 360) : r;
  }

  function textOf(v) {
    const src = v && typeof v === 'object' ? v : {};
    const align = src.align && typeof src.align === 'object' ? src.align : {};
    return {
      runs: runsOf(src.runs),
      style: textStyleOf(src.style, false),
      align: {
        h: oneOf(align.h, TEXT_H, 'center'),
        v: oneOf(align.v, TEXT_V, 'middle'),
      },
      box: boxOf(src.box),
      rotation: rotationOf(src.rotation),
    };
  }

  /**
   * The bar: a strip stuck to one side of the frame. `thickness` is in pixels
   * at refHeight, and the user's ceiling for it, a quarter of the frame's
   * height or width depending on the side, is the drawing's to apply because
   * only the drawing knows the frame. `span` is how much of its side it covers,
   * 0.01 to 1, centred on the side: "Bars span from the center of the side
   * where they are sticky to".
   */
  function barOf(v) {
    const src = v && typeof v === 'object' ? v : {};
    return {
      side: oneOf(src.side, BAR_SIDES, 'top'),
      color: colourOf(src.color, '#ffffffff'),
      thickness: within(src.thickness, 1, 100000, 40),
      span: within(src.span, 0.01, 1, 1),
    };
  }

  /**
   * A generated layer's settings, whole. Anything missing or broken comes out
   * as its default, and a form this version does not know comes out as text,
   * because a layer that opens as the wrong kind of generated media can still
   * be looked at and deleted, where one that cannot be drawn at all cannot.
   *
   * Only the form's own settings are kept: a bar carries no text and a text no
   * bar, so changing a form is a real change rather than a hidden second one.
   */
  function genOf(v) {
    const src = v && typeof v === 'object' ? v : {};
    const form = oneOf(src.form, GEN_FORMS, 'text');
    const refHeight = Math.round(within(src.refHeight, 1, 100000, GEN_REF_HEIGHT));
    if (form === 'bar') return { form, refHeight, bar: barOf(src.bar) };
    return { form, refHeight, text: textOf(src.text) };
  }

  function createLayer(props = {}) {
    const kind = kindOf(props);
    const still = kind !== 'media';
    const sourceDuration = still ? 0 : Math.max(0, round(props.sourceDuration || 0));
    const sourceIn = clamp(props.sourceIn === undefined ? 0 : props.sourceIn, 0, sourceDuration);
    // A layer defaults to showing the rest of its source from sourceIn onwards.
    const rest = sourceDuration - sourceIn;
    const duration = still
      ? round(stillSpan(props))
      : (props.duration === undefined ? rest : clamp(props.duration, 0, rest));
    return {
      id: props.id || newId(),
      // A generated layer is a picture, whatever it was handed.
      type: props.type === 'audio' && kind !== 'gen' ? 'audio' : 'video',
      // V2.3. Declared here for the reason fadeIn and render are: the project
      // open path runs every layer back through createLayer, and a field this
      // does not name is a field it drops. An image whose kind vanished on
      // reopening would come back as a video layer with no frames.
      kind,
      // V3. What a generated layer shows, and null on every other kind.
      // Declared here for the reason kind is: a field createLayer does not name
      // is a field the project open path drops. Always rebuilt through genOf
      // rather than kept as handed in, so no two layers ever share one object:
      // a paste or an undo snapshot holding the very same settings as the
      // layer on the timeline would be a change to one reaching the other.
      gen: kind === 'gen' ? genOf(props.gen) : null,
      name: props.name || '',
      // A generated layer has no file, so any path it was handed means nothing.
      src: kind === 'gen' ? null : (props.src || null),
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
      // V2.9. Which row of its own kind the layer sits on: 0 is Video 1 or
      // Audio 1. Several layers can share one, which is how a row comes to hold
      // more than one clip. In the user's words the row is the layer and each
      // clip on it is a track; the code keeps `layer` for the clip, because
      // that is what every reader of this object already means by it, and
      // calls the row a lane.
      //
      // null until arrangeLanes has seen it, which is what a project written
      // before v2.9 opens with. Declared here for the reason anchor and render
      // are: a field createLayer does not name is a field it drops.
      lane: laneValue(props.lane),
      // Step 2's geometry owns what goes in here. null means the whole frame.
      // V3. Nothing on a generated layer: its picture is drawn at the frame's
      // size and covers it exactly, and where its text goes is its own box.
      crop: kind === 'gen' ? null : (props.crop || null),
      // V2.8 item 8. Which of the Render Position rings the picture was put on,
      // by name, so it can stay there when it is scaled rather than growing
      // about its own centre and coming away from the edge it was put against.
      // The user: "When a layer gets positioned at any position (circle) in
      // render position, remember where it should stick to, also while scaling
      // it it should stick to e.g. right-top floating if thats the selected
      // circle."
      //
      // Declared here for the reason render and fadeIn are: the project open
      // path runs every layer back through createLayer, and a field this does
      // not name is a field it drops.
      //
      // The name only. What the names mean is the window's business, and a name
      // it does not recognise simply does nothing, which is why this checks that
      // it is a string and not which string it is. null is a picture that was
      // put somewhere by hand and sticks to nothing.
      anchor: kind !== 'gen' && typeof props.anchor === 'string' && props.anchor ? props.anchor : null,
      // V2.1's Render Position tab owns this one: where the cropped picture is
      // placed and scaled inside the project frame, in project pixels. null
      // means centre and fit, which is what placeLayer works out for itself.
      //
      // Declared beside crop because the two travel together everywhere. Both
      // are rectangles the geometry reads, both are null by default, and until
      // this line existed a layer could carry a position that createLayer threw
      // away: every undo and every project reopened would have quietly put the
      // layer back in the middle of the frame.
      render: kind === 'gen' ? null : (props.render || null),
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
    if (isStill(layer)) return Infinity;
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
    if (isStill(layer)) return Infinity;
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
  //
  // V2.9. A layer that does not say which lane it wants gets a new one below
  // the others of its kind, which is what adding a file has always meant: a
  // new row.
  function addLayer(layers, layer, index) {
    if (index === undefined) {
      const settled = arrangeLanes(layers);
      const lane = layer.lane === null || layer.lane === undefined
        ? laneCount(settled, layer.type)
        : layer.lane;
      const next = settled.slice();
      next.splice(blockEnd(settled, layer.type), 0, { ...layer, lane });
      return arrangeLanes(next);
    }
    const next = layers.slice();
    next.splice(clamp(index, 0, layers.length), 0, layer);
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

  // ---- lanes ----
  //
  // V2.9. A row of the timeline holding more than one clip. The user's words
  // for it are a layer holding several tracks; here it is several layers
  // sharing a lane, which leaves every layer exactly the object it was. The
  // composer already draws any number of video layers with their own windows
  // in time, and layers have always been free to overlap, so it needs nothing.
  //
  // What the lane does need is for the list order to agree with it, because
  // the list order is the stacking order the composer reads. arrangeLanes is
  // the one place that settles that, and it is a function of the lanes rather
  // than a second opinion about them.

  /**
   * The list put in lane order.
   *
   *   video before audio, as it always was
   *   then by lane, so Video 1's clips come first and are drawn on top
   *   then by start, latest first, so where two clips on one lane overlap
   *   the later one is drawn over the earlier
   *
   * Latest on top, because a clip put down on top of another is the one meant
   * to be seen: a paste lands at the playhead, which is usually inside the clip
   * already there, and with the earlier clip on top the pasted one would
   * vanish under it. It is also the user's transition, "the right track fading
   * in", and it puts the ramp that does the work on the clip drawn on top.
   *
   * The list is the stacking order and nothing else. The order a person reads
   * the timeline in, left to right, is readingOrder's, and that is what the
   * group markers are numbered by.
   *
   * A layer with no lane, which is every layer in a project written before
   * v2.9, takes the next lane after the highest one in use, in list order.
   * When none of them has one, that is exactly the layout those projects
   * always had: one layer to a row, in the order they were in.
   *
   * V2.9.1. Lanes are not closed up. A lane whose last clip is deleted or
   * dragged away stays where it is, empty, which the user asked for: "When a
   * track gets deleted and the layer is empty now, do not auto-delete it." A
   * row goes when its own delete button is pressed, and removeLane is what
   * closes the gap then.
   *
   * Hands back the list it was given when nothing changes, so a caller that
   * compares identities is not told about a change that did not happen.
   */
  function arrangeLanes(layers) {
    const keyed = layers.map((layer, index) => ({ layer, index, key: 0 }));
    for (const type of ['video', 'audio']) {
      const mine = keyed.filter((k) => k.layer.type === type);
      let used = -1;
      for (const k of mine) {
        const lane = laneValue(k.layer.lane);
        if (lane !== null) used = Math.max(used, lane);
      }
      for (const k of mine) {
        const lane = laneValue(k.layer.lane);
        k.key = lane === null ? (used += 1) : lane;
      }
    }
    keyed.sort((a, b) => {
      const ta = a.layer.type === 'audio' ? 1 : 0;
      const tb = b.layer.type === 'audio' ? 1 : 0;
      return (ta - tb) || (a.key - b.key)
        || (b.layer.start - a.layer.start) || (a.index - b.index);
    });
    let changed = false;
    const next = keyed.map((k, at) => {
      if (k.index !== at) changed = true;
      if (k.layer.lane === k.key) return k.layer;
      changed = true;
      return { ...k.layer, lane: k.key };
    });
    return changed ? next : layers;
  }

  function laneCount(layers, type) {
    let most = -1;
    for (const l of layers) {
      if (l.type === type && Number.isInteger(l.lane)) most = Math.max(most, l.lane);
    }
    return most + 1;
  }

  /**
   * The list in the order a person reads the timeline: by kind, by lane, and
   * left to right along each lane. Not the stacking order, which on a lane is
   * the other way round.
   *
   * Group markers are numbered by first appearance in this, so a split leaves
   * the old group ahead of the new one and keeps the old one's marker: "the old
   * one (earlier on the timeline) and the new one with a new shape and color".
   * On a lane holding one clip, which is every lane of a project written before
   * lanes, it is the list order exactly.
   */
  function readingOrder(layers) {
    const settled = arrangeLanes(layers);
    return settled
      .map((layer, index) => ({ layer, index }))
      .sort((a, b) => {
        const ta = a.layer.type === 'audio' ? 1 : 0;
        const tb = b.layer.type === 'audio' ? 1 : 0;
        return (ta - tb) || (a.layer.lane - b.layer.lane)
          || (a.layer.start - b.layer.start) || (a.index - b.index);
      })
      .map((k) => k.layer);
  }

  /**
   * Each lane of one kind, top first, as the layers on it left to right. A lane
   * with nothing on it is a hole in the array, not an empty list, so a loop by
   * index is what sees it.
   */
  function lanesOf(layers, type) {
    const lanes = [];
    for (const l of readingOrder(layers)) {
      if (l.type !== type) continue;
      (lanes[l.lane] || (lanes[l.lane] = [])).push(l);
    }
    return lanes;
  }

  // ---- transitions ----
  //
  // V2.9 item 2: "Tracks on the same layer should be able to overlap. Now that
  // fade-in/out is possible, this can be handeled by a transition having the
  // left track on the timeline fading out and the right track fading in where
  // they overlap."
  //
  // For a picture only the one on top may fade, which is the later one. Fading
  // both dips in the middle: the overlay blends out = a * top + (1 - a) * under,
  // so with the one underneath at 1 - t as well the middle comes to
  // t * right + (1 - t)^2 * left, three quarters of the light. With the one
  // underneath held opaque it is t * right + (1 - t) * left, exactly.
  //
  // Sound is the other way: a mix adds rather than covers, so both sides fade.
  //
  // The fades are written onto the layers rather than worked out whenever they
  // are read, so the preview, the export and the clip's own drawing all read
  // one number, and so a fade dragged by hand afterwards stays where it was put.

  /**
   * Every pair of neighbours on a lane that overlap, as "earlier|later" to the
   * length of the overlap. A clip lying wholly inside another is not a
   * transition, it is a clip put on top of one, and is left out.
   */
  function overlapsOf(layers) {
    const out = new Map();
    for (const type of ['video', 'audio']) {
      for (const lane of lanesOf(layers, type)) {
        if (!lane) continue;
        for (let i = 0; i + 1 < lane.length; i += 1) {
          const a = lane[i];
          const b = lane[i + 1];
          const o = round(endOf(a) - b.start);
          if (o > 0 && endOf(b) > endOf(a)) out.set(a.id + '|' + b.id, o);
        }
      }
    }
    return out;
  }

  /**
   * The transitions brought up to date with what changed between two lists.
   *
   * Only an overlap that is new, or whose length changed, is written, so a pair
   * that did not move keeps whatever its fades were set to by hand. An overlap
   * that went away takes back what it wrote, but only where the fade still
   * holds the number it wrote: a fade dragged by hand since is somebody's, not
   * the transition's, and is left alone.
   */
  function crossfade(before, after) {
    const was = overlapsOf(before);
    const now = overlapsOf(after);
    let next = after;
    const fadeIs = (id, key, value) => {
      const l = layerById(next, id);
      return !!l && round(l[key] || 0) === value;
    };
    for (const [pair, o] of was) {
      if (now.get(pair) === o) continue;
      const [a, b] = pair.split('|');
      if (fadeIs(b, 'fadeIn', o)) next = setFade(next, b, 'in', 0);
      const left = layerById(next, a);
      if (left && left.type === 'audio' && fadeIs(a, 'fadeOut', o)) next = setFade(next, a, 'out', 0);
    }
    for (const [pair, o] of now) {
      if (was.get(pair) === o) continue;
      const [a, b] = pair.split('|');
      const left = layerById(next, a);
      next = setFade(next, b, 'in', o);
      next = setFade(next, a, 'out', left && left.type === 'audio' ? o : 0);
    }
    return next;
  }

  /**
   * One lane one place towards the front or the back, with everything on it.
   *
   * Within its own kind, because stepping over an audio row would put a video
   * layer below the audio block, and because "Video 2 goes above Video 1" is
   * what the arrows mean. A negative delta is towards the front.
   */
  //
  // `rows` is how many rows of this kind the window is showing, which since
  // V2.9.1 can be more than the lanes anything is on: an empty row at the
  // bottom is a place to move to as well.
  function reorderLane(layers, type, lane, delta, rows) {
    // Nowhere to go hands back the list it was given, arranged or not, so the
    // caller can tell that nothing happened.
    const settled = arrangeLanes(layers);
    if (!delta) return layers;
    const to = lane + (delta < 0 ? -1 : 1);
    const limit = Math.max(laneCount(settled, type), Number(rows) || 0);
    if (lane < 0 || to < 0 || to >= limit) return layers;
    return arrangeLanes(settled.map((l) => {
      if (l.type !== type) return l;
      if (l.lane === lane) return { ...l, lane: to };
      if (l.lane === to) return { ...l, lane };
      return l;
    }));
  }

  /** The lane a layer is on, moved. What the arrows did before lanes existed. */
  function reorderLayer(layers, id, delta) {
    const settled = arrangeLanes(layers);
    const layer = layerById(settled, id);
    if (!layer || !delta) return layers;
    const next = reorderLane(settled, layer.type, layer.lane, delta);
    return next === settled ? layers : next;
  }

  /**
   * A whole row gone, and the rows under it close up. The one place lanes are
   * renumbered, because it is the one place a row is asked to go.
   */
  function removeLane(layers, type, lane) {
    const settled = arrangeLanes(layers);
    return arrangeLanes(settled
      .filter((l) => !(l.type === type && l.lane === lane))
      .map((l) => (l.type === type && l.lane > lane ? { ...l, lane: l.lane - 1 } : l)));
  }

  /**
   * V3. An empty lane put in at `lane`, the lanes from there down moving down
   * one. removeLane's opposite, and the other time lanes are renumbered.
   */
  function insertLane(layers, type, lane) {
    const settled = arrangeLanes(layers);
    const at = Math.max(0, Math.floor(Number(lane) || 0));
    return arrangeLanes(settled.map((l) => (l.type === type && l.lane >= at
      ? { ...l, lane: l.lane + 1 }
      : l)));
  }

  /**
   * V3. Where a new generated layer goes, by the user's rule: "a generated
   * media first gets put into a new (or the next possible empty) video track".
   * Whatever row the click was on, then, since putting it onto a row's clips
   * would turn it into a crossfade with them.
   *
   * The topmost empty video row of the `rows` the timeline shows, but only if
   * nothing on a row above it is showing anywhere in the new layer's time, from
   * `at` for `length` seconds. Otherwise, and when there is no empty row, a new
   * row at the very top. Rows stack top first, so an empty row under a full
   * frame video is a row nobody can see: the user put a text on an empty
   * Video 4 under two videos, where Render Preview rightly hid it, and asked
   * on 2026-09-25 for it to go on top instead.
   *
   * Answers the lane, and whether it has to be inserted first.
   */
  function genLane(layers, rows, at = 0, length = IMAGE_SECONDS) {
    const video = layers.filter((l) => l.type === 'video');
    const used = new Set(video.map((l) => laneValue(l.lane)));
    const shown = Math.max(Number(rows) || 0, laneCount(layers, 'video'));
    const from = Math.max(0, Number(at) || 0);
    const to = from + length;
    for (let lane = 0; lane < shown; lane += 1) {
      if (used.has(lane)) continue;
      // Every row above the topmost empty one has clips; any of them showing
      // while this one does would cover it. Disabled ones count too, since the
      // row can be ticked back on.
      const covered = video.some((l) => laneValue(l.lane) < lane && l.start < to && endOf(l) > from);
      return covered ? { lane: 0, insert: true } : { lane, insert: false };
    }
    return { lane: 0, insert: true };
  }

  /**
   * V3. A new generated layer on the timeline at `at`, on the lane genLane
   * picks, with the row made first when it needs one. Its length is the ten
   * seconds an image opens at.
   */
  function addGen(layers, gen, at, rows, props = {}) {
    const where = genLane(arrangeLanes(layers), rows, at);
    const base = where.insert ? insertLane(layers, 'video', 0) : arrangeLanes(layers);
    const layer = createLayer({
      ...props,
      kind: 'gen',
      gen,
      start: Math.max(0, Number(at) || 0),
      lane: where.lane,
    });
    return { layers: arrangeLanes([...base, layer]), layer, inserted: where.insert };
  }

  /**
   * The same props written onto every layer of one lane. The row's head acts on
   * the whole row, which the user settled on 2026-09-24: Enabled and Volume
   * mean the row, not whichever of its clips was last clicked.
   */
  function setLane(layers, type, lane, props) {
    const settled = arrangeLanes(layers);
    return settled.map((l) => (l.type === type && l.lane === lane ? { ...l, ...props } : l));
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

  /**
   * How far past the last layer a project may be trimmed to, V2.8 item 3.
   *
   * The user, on 2026-09-24: "Let the End-time slider being dragged past the
   * last tracks end. This simply extends the video with a black screen if there
   * is simply nothing anymore, but it should be possible." So the out marker
   * stops being held to the material and the stretch past it renders as black,
   * which the composer was already building anyway: every layer is overlaid
   * onto a black frame the length of the output.
   *
   * An hour, which is the same reach the timeline view can already pan into, so
   * the marker cannot be dragged somewhere the view cannot follow it. It exists
   * to stop a corrupt or hand-edited .lwc asking for a week of black rather
   * than to be a wall anybody meets: nothing in advanced editing is drawn
   * against it, the Trim frame being hidden there.
   */
  const TAIL_REACH = 3600;

  function trimCeiling(layers) {
    return round(totalDuration(layers) + TAIL_REACH);
  }

  function setLayer(layers, id, props) {
    return replace(layers, id, (l) => ({ ...l, ...props }));
  }

  /**
   * V3. New settings for a generated layer, through genOf, so what a modal
   * hands over is held to the same limits a file is. Anything that is not a
   * generated layer is left alone.
   */
  function setGen(layers, id, gen) {
    return replace(layers, id, (l) => (l.kind === 'gen' ? { ...l, gen: genOf(gen) } : l));
  }

  /**
   * V3, 31a. A generated layer carried through a Crop Render Frame change,
   * which pins every picture where it stands: the old frame lands in the new
   * one at `dx, dy`, scaled by `k` (1 for a crop, the ratio of the two
   * resolutions for a resolution button), and the new frame is `toHeight` tall.
   *
   * Sizes follow the picture's scale, not the frame's height, so cropping 720
   * down to 600 leaves a title the size it was rather than shrinking it by a
   * sixth. Only refHeight has to change for that: every size is kept at it.
   * Where things go depends on what they are stuck to. A text with a box is
   * pinned like a video, so the box moves with the picture. A text with no box
   * is laid out in the whole frame and a bar sticks to its side, and both of
   * those follow the new frame.
   *
   * refHeight is a whole number, so the size can be off by the rounding of
   * that, well under a pixel; the box is worked out from the rounded height, so
   * it lands exactly.
   */
  function reframeGen(gen, fromHeight, toHeight, k, dx, dy) {
    const g = genOf(gen);
    const oldScale = fromHeight / g.refHeight;
    const refHeight = Math.max(1, Math.round(toHeight / (oldScale * k)));
    if (g.form !== 'text' || !g.text.box) return genOf({ ...g, refHeight });
    const scale = toHeight / refHeight;
    const b = g.text.box;
    const at = (v, off) => round((off + v * oldScale * k) / scale);
    const box = { x: at(b.x, dx), y: at(b.y, dy), w: at(b.w, 0), h: at(b.h, 0) };
    return genOf({ ...g, refHeight, text: { ...g.text, box } });
  }

  /**
   * Set one of a layer's two fades, in seconds.
   *
   * Held to the layer's own span on the way in as well as on the way out.
   * fadesOf already clamps when it reads, so this is not what makes the maths
   * safe; it is what makes the number the clip draws and the number the handle
   * reports the same one, so a fade dragged past the end of the clip stops
   * under the pointer rather than carrying on invisibly.
   *
   * **V2.8. The two fades share the clip and cannot both have all of it.**
   * Until now each was clamped to the span on its own, so two and a half
   * seconds in and two and a half out on a three second clip was allowed and
   * the ramps crossed. The user, on 2026-09-24: "If fade in/out are both used
   * and their vertical lines would collide/overlap, shift the other
   * (non-dragged) further to its side, dont let fade in/out overlap."
   *
   * So **the one being set wins** and the other gives way to it, which is the
   * only rule that can be obeyed by a hand holding one handle: stopping the
   * dragged one would leave the pointer somewhere the fade is not. The one that
   * gave way stays given way when the drag comes back, because it was shortened
   * rather than pushed, and there is nothing to remember it was ever longer.
   *
   * They may meet exactly. Touching is not overlapping, and a fade in that runs
   * straight into a fade out is a real thing to ask for.
   */
  function setFade(layers, id, which, seconds) {
    const key = which === 'out' ? 'fadeOut' : 'fadeIn';
    const twin = which === 'out' ? 'fadeIn' : 'fadeOut';
    return replace(layers, id, (l) => {
      const span = Math.max(0, round(Number(l.duration) || 0));
      const n = Number(seconds);
      const want = Number.isFinite(n) ? clamp(round(n), 0, span) : 0;
      const other = round(Number(l[twin]) || 0);
      const gives = clamp(other, 0, round(span - want));
      if (want === round(Number(l[key]) || 0) && gives === other) return l;
      return { ...l, [key]: want, [twin]: gives };
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

  // ---- splitting ----
  //
  // V2.9 item 3: "Pressing S will split the current selected track into 2 with
  // the cut happening at the current position slider's position." And from the
  // right click menu, at the second the click landed on, which is why this
  // takes a time rather than reading a playhead it has never heard of.

  /** Whether a cut at this second leaves two halves that are both clips. */
  function canSplitAt(layer, at) {
    return at - layer.start >= MIN_LAYER_SPAN && endOf(layer) - at >= MIN_LAYER_SPAN;
  }

  /**
   * The two halves of one layer. Everything the picture is carries over to both:
   * crop, placement, anchor, alpha, volume, lane, name and source. What does not
   * is what belongs to an end: the fade in stays with the left half and the
   * fade out with the right, and the cut ends carry neither, since a cut is not
   * a fade.
   *
   * A fade that ran past the cut is shortened to the half it is on. That changes
   * the slope of the ramp, which a cut through the middle of a fade can only
   * avoid by inventing a partial alpha at the cut, and nothing else in the
   * model has one to give.
   *
   * The right half's source moves on by what the left half kept, so the two
   * together show exactly what the one did. A still has no clock to move along,
   * and keeps its sourceIn as it was.
   */
  function halves(layer, at, groupId) {
    const kept = round(at - layer.start);
    const rest = round(endOf(layer) - at);
    const left = {
      ...layer,
      duration: kept,
      fadeIn: round(Math.min(layer.fadeIn || 0, kept)),
      fadeOut: 0,
    };
    const right = {
      ...layer,
      id: newId(),
      start: round(at),
      duration: rest,
      sourceIn: isStill(layer) ? layer.sourceIn : round(layer.sourceIn + kept),
      fadeIn: 0,
      fadeOut: round(Math.min(layer.fadeOut || 0, rest)),
      groupId,
    };
    return [left, right];
  }

  /**
   * One layer cut in two at a second of the timeline, and its whole group with
   * it.
   *
   * The user's rule for a group, 2026-09-25: "Splitting a grouped tracks splits
   * its video and audio into 2 groups instead, the old one (earlier on the
   * timeline) and the new one with a new shape and color (more right on the
   * timeline)." So the left halves keep the id they had, the right halves share
   * one new one, and each half is then a picture and its sound that move
   * together and apart from the other half. The new marker is groupMarker's
   * business and comes with the new id.
   *
   * A member of the group that the cut does not pass through, a sound trimmed
   * shorter than its picture for instance, goes with whichever side most of it
   * is on. One that ends up alone is a group of one, which is what deleting one
   * of a pair has always left and which moves like any single layer.
   *
   * Refused, by handing back the list it was given, when the cut would leave
   * the layer that was asked for with a half shorter than a clip can be.
   */
  function splitLayer(layers, id, at) {
    const target = layerById(layers, id);
    const cut = round(Number(at));
    if (!target || !Number.isFinite(cut) || !canSplitAt(target, cut)) return layers;
    const members = groupOf(layers, id);
    const fresh = target.groupId ? newGroupId() : null;
    const next = [];
    for (const l of layers) {
      if (!members.includes(l)) {
        next.push(l);
      } else if (canSplitAt(l, cut)) {
        next.push(...halves(l, cut, fresh));
      } else if (l.start + l.duration / 2 >= cut) {
        next.push({ ...l, groupId: fresh });
      } else {
        next.push(l);
      }
    }
    return arrangeLanes(next);
  }

  // ---- the clipboard ----
  //
  // V2.9. "Copy does the same thing as Crtl+C, copying the selected track and
  // Crtl+V or Paste will paste the copied track." The app's own clipboard, not
  // the system's: what it holds is a layer's fields, which no other program
  // has a use for, and the system clipboard is where a URL for the box at the
  // top comes from.

  /**
   * What Copy puts on the clipboard: the layer and the rest of its group, as
   * plain copies, so nothing done to the timeline afterwards can reach them.
   *
   * The group comes too, for the reason a split takes the whole group: a
   * picture copied without its sound would paste silent where a split leaves
   * both halves speaking, and the same gesture meaning two different things on
   * two different menu items is a thing nobody can learn.
   */
  function copyOf(layers, id) {
    const target = layerById(layers, id);
    if (!target) return null;
    return { primary: target.id, items: groupOf(layers, id).map((l) => ({ ...l })) };
  }

  /**
   * A copy put back on the timeline with new ids, the copied layer starting at
   * `at` and the rest of its group keeping the distance it had from it.
   *
   * The copied layer goes on `lane` when one is given, and on a new one below
   * the others of its kind otherwise, which is the user's rule for Ctrl+V with
   * nothing selected: "paste the copied source into a newly created layer if
   * needed". The rest of the group goes back on the lane it was copied from.
   *
   * A paste onto time that is already taken is an overlap like any other. The
   * clipboard does not refuse it, because what an overlap on one lane means is
   * the transition's business rather than this.
   */
  function pasteInto(layers, clip, at, lane) {
    if (!clip || !Array.isArray(clip.items) || !clip.items.length) return layers;
    const primary = clip.items.find((l) => l.id === clip.primary) || clip.items[0];
    const when = round(Math.max(0, Number(at) || 0));
    const groupId = clip.items.length > 1 ? newGroupId() : null;
    let next = arrangeLanes(layers);
    // The copied layer first, so its lane is settled before anything else of
    // its kind asks for a new one.
    const order = [primary, ...clip.items.filter((l) => l !== primary)];
    for (const item of order) {
      const want = item === primary ? laneValue(lane) : laneValue(item.lane);
      const onto = want !== null ? want : laneCount(next, item.type);
      next = arrangeLanes([...next, {
        ...item,
        id: newId(),
        start: round(Math.max(0, when + (item.start - primary.start))),
        lane: onto,
        groupId,
      }]);
    }
    return next;
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
    isStill,
    GEN_FORMS,
    GEN_REF_HEIGHT,
    GEN_EFFECT_MAX,
    GEN_FONT_MAX,
    DEFAULT_FONT,
    colourOf,
    genOf,
    setGen,
    reframeGen,
    fadesOf,
    fadeAlphaAt,
    alphaOf,
    layerAlphaAt,
    sourceTimeFor,
    layerById,
    indexOfLayer,
    layersAt,
    totalDuration,
    TAIL_REACH,
    trimCeiling,
    addLayer,
    removeLayer,
    reorderLayer,
    arrangeLanes,
    readingOrder,
    lanesOf,
    overlapsOf,
    crossfade,
    laneCount,
    reorderLane,
    removeLane,
    insertLane,
    genLane,
    addGen,
    setLane,
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
    canSplitAt,
    splitLayer,
    copyOf,
    pasteInto,
    trimRange,
    trimGroup,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = timelineModel;
