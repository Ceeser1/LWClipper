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

  const GEN_FORMS = ['text', 'bar', 'shape'];

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

  // What a run of a text may change from the text's own style. Outline and
  // shadow are left out on purpose: they are set for the whole text.
  // V4.6. The gradient is one too, the only one that is not a plain value.
  const RUN_FIELDS = ['font', 'size', 'color', 'bold', 'italic', 'underline', 'strike', 'gradient'];

  const TEXT_H = ['left', 'center', 'right'];
  const TEXT_V = ['top', 'middle', 'bottom'];
  const BAR_SIDES = ['top', 'right', 'bottom', 'left'];
  // V3.6.5. The arrow, the heart and the speech bubble after the first five,
  // so a mask or a shape written before them reads as it was.
  const SHAPE_KINDS = ['circle', 'square', 'triangle', 'star', 'ring', 'arrow', 'heart', 'bubble'];

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
   * Outline and shadow belong to the whole text, the user's call for 3.2, so a
   * run never carries either: only the fields in RUN_FIELDS survive on one.
   */
  function textStyleOf(v, partial) {
    const src = v && typeof v === 'object' ? v : {};
    const has = (k) => Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined;
    const out = {};
    const field = (k, fn) => {
      if (!partial || (has(k) && RUN_FIELDS.includes(k))) out[k] = fn(src[k]);
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
    // V4.6. Null is no gradient, which is every text from before.
    field('gradient', textGradientOf);
    return out;
  }

  /**
   * The text itself, as runs: pieces of text that each carry the style they
   * change. 3.2's editor formats words one by one; a text formatted all alike
   * is one run with nothing changed, the shape every 3.0 and 3.1 text has.
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

  // V3.7. How a shape is filled: its one colour, or a gradient.
  const SHAPE_FILLS = ['color', 'gradient'];
  // Two stops at least, and at most this many.
  const GRADIENT_STOPS_MAX = 16;

  /**
   * V3.7. A shape's gradient, the user's "Color | Gradient": colour stops at
   * shares of its length, `at` 0 to 1, white into black by default, and the
   * line it runs along. `start` and `end` are in pixels at refHeight from the
   * shape's centre, along the direction `angle` points in, in degrees: 0 to
   * the right and positive clockwise, the app's way, and measured from the
   * shape, so the gradient turns with it. The whole clip's, not keyed.
   */
  function gradientOf(v) {
    const src = v && typeof v === 'object' ? v : {};
    let stops = Array.isArray(src.stops)
      ? src.stops
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({ at: within(s.at, 0, 1, 0), color: colourOf(s.color, '#ffffffff') }))
      : [];
    if (stops.length < 2) stops = [{ at: 0, color: '#ffffffff' }, { at: 1, color: '#000000ff' }];
    stops = stops.sort((a, b) => a.at - b.at).slice(0, GRADIENT_STOPS_MAX);
    return {
      stops,
      start: within(src.start, -100000, 100000, -100),
      end: within(src.end, -100000, 100000, 100),
      angle: rotationOf(src.angle),
    };
  }

  /**
   * V4.6. A text's gradient, the user's "A (by drag) selected text should have
   * the option to have a gradient applied": null for none, the letters then
   * filled with their colour, or a shape's stops and angle. It belongs to a
   * stretch of letters, neighbours that all carry the same one, and runs
   * across the box round those letters, so it stays on them as the text is
   * typed on, wrapped or moved. `start` and `end` are therefore shares of that
   * box's reach along the direction, from its middle: -0.5 its near edge and
   * 0.5 its far one, which is edge to edge at any length. The angle is
   * measured from the text, so the gradient turns with it.
   */
  function textGradientOf(v) {
    if (!v || typeof v !== 'object') return null;
    const g = gradientOf(v);
    return {
      stops: g.stops,
      start: within(v.start, -100, 100, -0.5),
      end: within(v.end, -100, 100, 0.5),
      angle: g.angle,
    };
  }

  /**
   * V4.6. A gradient as one string, the same for two that are the same, since
   * a run's fields are compared and a gradient is the one that is an object.
   * Empty for none.
   */
  function gradientKey(g) {
    if (!g || typeof g !== 'object') return '';
    const stops = Array.isArray(g.stops) ? g.stops.map((s) => s.at + ':' + s.color).join(',') : '';
    return stops + '|' + g.start + '|' + g.end + '|' + g.angle;
  }

  /**
   * A shape: which one, its colour, and the box it fills, in pixels at
   * refHeight, the user's "colored, scaled and positioned", and since 3.5 how
   * it is drawn in that box. A null box is the shape's own default, centred and a third of
   * the frame high, which only the drawing can place because only it knows
   * the frame; like a text's null box it follows the frame through a change.
   */
  function shapeOf(v) {
    const src = v && typeof v === 'object' ? v : {};
    return {
      kind: oneOf(src.kind, SHAPE_KINDS, 'circle'),
      color: colourOf(src.color, '#ffffffff'),
      box: boxOf(src.box),
      // V3.5, the shapes version. Every one of these reads as what a shape
      // drew before it existed, so a project written by 3.4 opens unchanged.
      // `invert` colours the whole render frame except the shape, which
      // becomes the see-through part.
      invert: bool(src.invert),
      // How far the shape's edge fades, in pixels at refHeight. 0 is the hard
      // edge every shape had. Keyed, so a spotlight can soften as it moves.
      soft: within(src.soft, 0, 100000, 0),
      // Outline Only: just a band `line` pixels wide, at refHeight, inside
      // the shape's edge. The width is kept while it is off.
      outline: bool(src.outline),
      line: within(src.line, 1, 100000, 20),
      // The ring's band as a share of its radius, so 0.4 is the hole of 60%
      // of the width that every ring had.
      ring: within(src.ring, 0.05, 0.95, 0.4),
      // The star's points, and how far in its inner corners sit as a share of
      // the outer radius: by default the regular five-point star, its inner
      // points at the golden ratio's share.
      points: Math.round(within(src.points, 3, 12, 5)),
      inner: within(src.inner, 0.1, 0.9, 0.381966),
      // V3.6.2. The turn about the box's centre, in degrees like a text's,
      // and a square's rounded corners, their radius in pixels at refHeight.
      // Both read as what a shape drew before, so a 3.6 project opens as it
      // was. Keyed, so a shape can spin and a square can round off.
      rotation: rotationOf(src.rotation),
      radius: within(src.radius, 0, 100000, 0),
      // V3.7. The colour, or the gradient, filling it. A shape from before
      // reads as its one colour.
      fill: oneOf(src.fill, SHAPE_FILLS, 'color'),
      gradient: gradientOf(src.gradient),
    };
  }

  // ---- V3.6. Masks ----
  //
  // A mask belongs to a video or image layer, the user's "Add Mask" on the
  // track: a shape, or a picture of their own, that decides which part of the
  // layer's picture shows. It sticks to the picture rather than to the frame,
  // so it moves, scales and turns with it: its box is in fractions of the
  // picture as it is placed, 0 to 1 across and down, and may reach past it.
  // Its soft edge is a fraction of the picture's height for the same reason.
  // Inverted, the shape becomes a hole and the rest shows.
  //
  // The box and the soft edge are keyed, a keyframe holding its own as
  // `mask: { box, soft }`; a keyframe holding none stands for the layer's.
  // Everything else, the kind, Invert, the ring's and star's figures and the
  // picture, is the layer's.
  //
  // V3.6.4. A square's rounded corners as well, `radius`, a fraction of the
  // picture's height like the soft edge and keyed with it, so a mask can
  // round off as a Square shape can. 0, the sharp corners every mask had
  // before, wherever it is missing.

  const MASK_KINDS = [...SHAPE_KINDS, 'custom'];
  const MASK_BY = ['alpha', 'luma'];

  // A mask's box: fractions, any position, a real size. The whole picture when
  // there is none to be had.
  function maskBoxOf(v) {
    const b = v && typeof v === 'object' ? v : {};
    const x = Number(b.x);
    const y = Number(b.y);
    const w = Number(b.w);
    const h = Number(b.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return { x: 0, y: 0, w: 1, h: 1 };
    return { x, y, w, h };
  }

  function maskSoftOf(v) {
    return within(v, 0, 1, 0);
  }

  // V3.6.4. The corners' radius, a fraction of the picture's height. The
  // drawing holds it to half the box's shorter side, as a shape's.
  function maskRadiusOf(v) {
    return within(v, 0, 1, 0);
  }

  // ---- V5.0. VFX ----
  //
  // The user, 2026-11-17: Obscure and Pixelate (V4.7, V4.8) become "VFX", a
  // list on a video or image track that one window edits. "Only one box/area
  // per vfx", several of a kind being several entries ("Pixelate, Pixelate
  // (2), Pixelate (n+1)"); "The order of which the VFX are added to a track
  // determine which gets processed first"; "All settings of any vfx should be
  // editable per keyframe, not set global"; and "Obscure and Pixelate are not
  // the only VFX settings, more will come later", so nothing below is written
  // for the two there are.
  //
  // A kind is a row of VFX_KINDS: its name, whether it acts in an area (a
  // shape in a box on the picture), its settings, and when it is off. The
  // settings are of two sorts, the user's rule for this and every later VFX:
  // "a few things cannot really interpolate between keyframes. A few settings
  // are global per VFX (or shape, like invert)". Those are `statics`, the
  // VFX's own and the same the whole clip long. The rest are `keyed`: numbers
  // that go smoothly from one keyframe to the next. An area's box and turn are
  // keyed on every kind that has an area.
  //
  // One VFX is { id, kind, ...statics, ...keyed values, keys? }. Without
  // `keys` it is the same the whole clip long, the user's "continuous". With
  // them, `keys: [{ id, t, ...keyed values }]`, `t` in the clip's own seconds
  // like a layer keyframe's: between two of them every keyed value blends,
  // before the first it is the first's and after the last the last's, and
  // while it has keys they are the whole of what it is. A Strength of 0 is
  // off, which is how keyframes limit a VFX to a stretch of the clip: the
  // user's example, 0, 50, 0, 100, 0, 0 (off between those two), 50, and a
  // last one at 0 "until end of the clip".
  //
  // An area belongs to the picture as the file has it, not as it is cropped
  // or placed: its box is in fractions of the whole source picture, so a crop
  // changed later leaves it on what it covered, and nothing the layer's own
  // keyframes do to the picture has to know about it. `soft` is how far its
  // edge fades, a fraction of the picture's height like a mask's.
  //
  // The same rules as a layer's keyframes hold for a VFX's: moving the clip
  // takes them along, a trim of its start shifts them back so they stay where
  // they are on the timeline, a split gives both halves all of them, and one
  // trimmed out of view is kept and still steers.
  //
  // A project written before V5.0 kept `obscure` and `pixelate` on the layer.
  // The user: "no conversion between old and new projects". createLayer no
  // longer names those two, so such a project opens without them.
  //
  // The key functions below take a VFX in any unit, the layer's fractions or
  // the window's pixels: they only blend and compare its numbers.

  // A setting: `id` is the field it is kept in, `type` what it is ('number',
  // 'check', 'shape'), `def` what a new VFX starts with. A number has its
  // range, `whole` when it only takes whole numbers, and `of: 'height'` (or
  // 'width') when it is a fraction of the picture's height that the window
  // shows in the picture's pixels. `in` says what a keyed setting changes:
  // 'mask', where the VFX acts, or 'filter', what it does there. A shape
  // with `options` is one of those only.
  const VFX_AREA_STATICS = [
    { id: 'shape', type: 'shape', def: 'square' },
    { id: 'invert', type: 'check', def: false },
  ];
  const VFX_SOFT = { id: 'soft', type: 'number', min: 0, max: 0.5, def: 0, of: 'height', in: 'mask' };

  // V5.1. The kinds after the first two. The user, 2026-11-17: "create many
  // more selectable vfx effects", "Some settings stay static, most should be
  // changeable/animatable using keyframes".
  //
  // More sorts of setting, all a VFX's own (they cannot blend): 'choice', one
  // of `options`; 'color', a colour as '#rrggbb'; 'file', a file's path, empty
  // for none; 'curve', the curves of a Curves VFX (V5.3, VFX_CURVE_DEF); and
  // a plain number where a figure cannot blend (a speed).
  //
  // Every one has Mix, 0 to 100, how much of the effect shows over the
  // picture as it was: it is `in: 'mask'`, a see-through of where the VFX
  // acts, so it is the same for every kind and needs nothing of a kind's
  // filter. Mix 0 is off, as Strength 0 is for the first two, which is how
  // keyframes hold a VFX to a stretch of the clip. A kind is also off while
  // its own figures leave the picture as it is (a Brightness of 0 with a
  // Contrast of 0).
  //
  // V5.1.3. Where a kind acts is its `where`. Until then every kind had an
  // area of any shape with a soft edge; the user, 2026-11-17: "for several it
  // doesnt make sense to have a shape to select, for some it doesnt make
  // sense to have "soft edge" available", "things like Seipa for example,
  // having a selectable box to arrange it, but no shape to select is enough",
  // "maybe even just rectangle/circle and skipping other shapes, but not all
  // shapes for every vfx". So, by what a part of the effect would mean:
  //   'whole'  all of the picture, nothing to place. What it does is told by
  //            the picture's own frame: bars along its edges, a flip, a turn.
  //   'point'  all of the picture about a point, `cx` and `cy`, keyed (V5.1.4).
  //            It has a reach of its own (a Bulge's Radius) or none at all.
  //   'box'    a rectangle to move, size and turn, with Invert and a soft
  //            edge: a look, put on the picture or on a panel of it.
  //   'two'    the same as a rectangle or a circle (VFX_TWO_SHAPES): a kind
  //            aimed at a thing in the picture, a face, a sign, a fire.
  //   'any'    any shape: the first two, which cover a thing up.
  // A soft edge goes with an area, but not where the effect moves the picture
  // far (Zoom, Glitch): the fade would show the thing twice. A kind with an
  // area starts on the whole picture (`fill`).
  //
  // What a kind does with its figures is its row in vfxOps.js. `centred`: it
  // bends the picture about the middle of its own area (vfxOps.js midOf).
  const VFX_MIX = { id: 'mix', type: 'number', min: 0, max: 100, whole: true, def: 100, in: 'mask' };
  const VFX_TWO_SHAPES = ['square', 'circle'];
  // V5.1.4. A point on the picture, each a fraction of its width or height.
  // They are figures of the kind's filter like any other, so they blend
  // between keyframes and make a step a frame while they move.
  const VFX_CX = { id: 'cx', type: 'number', min: 0, max: 1, def: 0.5, of: 'width', in: 'filter' };
  const VFX_CY = { id: 'cy', type: 'number', min: 0, max: 1, def: 0.5, of: 'height', in: 'filter' };
  const VFX_PALETTES = ['iron', 'rainbow', 'ice'];
  const VFX_LOOKS = ['tealorange', 'bleach', 'vintage', 'cross', 'cool', 'warm', 'noir', 'faded', 'matrix', 'sunset', 'moon', 'pastel'];
  const VFX_CHANNEL_ORDERS = ['rbg', 'grb', 'gbr', 'brg', 'bgr'];
  const VFX_EDGE_STYLES = ['neon', 'sketch', 'mono'];
  const VFX_FLIP_MODES = ['across', 'down', 'both', 'left', 'right', 'top', 'bottom', 'quad'];
  // V5.2. Polar Coordinates: the picture wrapped round its middle, or one so
  // wrapped laid out flat again.
  const VFX_POLAR_MODES = ['wrap', 'unwrap'];
  // V5.2. Corner Pin: the picture's four corners, each put somewhere else,
  // from the top left round by the right. A corner may lie outside the
  // picture by half of it.
  const VFX_PINS = [['x1', 'y1'], ['x2', 'y2'], ['x3', 'y3'], ['x4', 'y4']];
  // V5.3. Curves: a curve for all of red, green and blue, `m`, and one for
  // each of them, every one a few points [value, what it becomes], 0 to 255
  // in whole numbers, from the darkest value up. A curve that leaves the
  // picture as it is has both its points on the diagonal.
  const VFX_CURVE_CHANNELS = ['m', 'r', 'g', 'b'];
  const VFX_CURVE_POINTS = 16;
  const VFX_CURVE_FLAT = [[0, 0], [255, 255]];
  const VFX_CURVE_DEF = { m: [[0, 0], [64, 50], [192, 206], [255, 255]], r: VFX_CURVE_FLAT, g: VFX_CURVE_FLAT, b: VFX_CURVE_FLAT };

  /** One channel's curve as the model keeps it: at least two points, each value once, in order. */
  function vfxCurvePoints(list) {
    const byX = new Map();
    for (const raw of Array.isArray(list) ? list : []) {
      if (!Array.isArray(raw)) continue;
      const x = Number(raw[0]);
      const y = Number(raw[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      byX.set(Math.round(Math.min(255, Math.max(0, x))), Math.round(Math.min(255, Math.max(0, y))));
    }
    const out = [...byX.entries()].sort((a, b) => a[0] - b[0]).slice(0, VFX_CURVE_POINTS);
    return out.length >= 2 ? out : VFX_CURVE_FLAT.map((p) => [...p]);
  }

  /** The curves of a Curves VFX out of what a file or the window hands over. */
  function vfxCurveOf(v, fallback) {
    const from = v && typeof v === 'object' ? v : fallback;
    const out = {};
    for (const ch of VFX_CURVE_CHANNELS) out[ch] = vfxCurvePoints(from && from[ch]);
    return out;
  }

  /** Whether curves leave every colour as it is. */
  function vfxCurveFlat(c) {
    return !c || VFX_CURVE_CHANNELS.every((ch) => !Array.isArray(c[ch]) || c[ch].every((p) => p[0] === p[1]));
  }
  // V5.4. Luma Key: which end of the brightness is made see-through.
  const VFX_LUMA_MODES = ['dark', 'bright'];
  const VFX_MORE = (() => {
    const fig = (id, min, max, def) => ({ id, type: 'number', min, max, whole: true, def, in: 'filter' });
    const part = (id, max, def) => ({ id, type: 'number', min: 0, max, def, of: 'height', in: 'filter' });
    const pick = (id, options, def) => ({ id, type: 'choice', options, def: def || options[0] });
    const tone = (id, def) => ({ id, type: 'color', def });
    const tick = (id) => ({ id, type: 'check', def: false });
    // A figure that is the VFX's own: how fast it moves cannot blend, a speed
    // changed half way would make the picture jump.
    const own = (id, min, max, def) => ({ id, type: 'number', min, max, whole: true, def });
    // A corner's place, a fraction of the picture's width and of its height.
    const pin = ([x, y], dx, dy) => [
      { id: x, type: 'number', min: -0.5, max: 1.5, def: dx, of: 'width', in: 'filter' },
      { id: y, type: 'number', min: -0.5, max: 1.5, def: dy, of: 'height', in: 'filter' },
    ];
    // A kind by where it acts. What is its own comes first: the look or the
    // colour is what one came for. Then the shape, for a kind that has two,
    // and Invert, for one with an area. Keyed: its own figures, the point for
    // a kind about one, Mix, and the soft edge for one with an area. `more`
    // may say the shape and the Invert it starts with, how soft its edge
    // starts (false for none), and that it has no Mix.
    const kind = (where, statics, keyed, still, more = {}) => {
      const { shape = 'square', invert = false, soft = 0, mix = true, ...rest } = more;
      const area = where === 'box' || where === 'two';
      return {
        where,
        area,
        ...(area ? { fill: true } : {}),
        statics: [
          ...statics,
          ...(where === 'two' ? [{ id: 'shape', type: 'shape', options: VFX_TWO_SHAPES, def: shape }] : []),
          ...(area ? [{ id: 'invert', type: 'check', def: invert }] : []),
        ],
        keyed: [
          ...keyed,
          ...(where === 'point' ? [VFX_CX, VFX_CY] : []),
          ...(mix ? [VFX_MIX] : []),
          ...(area && soft !== false ? [{ ...VFX_SOFT, def: soft }] : []),
        ],
        off: (s) => (mix && !(s.mix > 0)) || (still ? !!still(s) : false),
        ...rest,
      };
    };
    const whole = (...row) => kind('whole', ...row);
    const point = (...row) => kind('point', ...row);
    const box = (...row) => kind('box', ...row);
    const two = (...row) => kind('two', ...row);
    return {
      // ---- blurs ----
      dirblur: two([tick('vertical')], [fig('strength', 0, 100, 30)], (s) => !(s.strength > 0)),
      // The sharp band across the middle, the blur on all but it.
      tiltshift: two([], [fig('strength', 0, 100, 20)], (s) => !(s.strength > 0),
        { invert: true, soft: 0.12, mix: false, fill: false, band: true }),
      // ---- colour: a correction is aimed at a thing, a look is not ----
      brightness: two([], [fig('brightness', -100, 100, 15), fig('contrast', -100, 100, 15)],
        (s) => s.brightness === 0 && s.contrast === 0),
      exposure: two([], [fig('exposure', -300, 300, 50), fig('gamma', 10, 400, 100)],
        (s) => s.exposure === 0 && s.gamma === 100),
      levels: two([], [fig('black', 0, 100, 8), fig('white', 0, 100, 92), fig('gamma', 10, 400, 100),
        fig('outBlack', 0, 100, 0), fig('outWhite', 0, 100, 100)],
      (s) => s.black === 0 && s.white === 100 && s.gamma === 100 && s.outBlack === 0 && s.outWhite === 100),
      huesat: two([], [fig('hue', -180, 180, 0), fig('saturation', -100, 100, 40)],
        (s) => s.hue === 0 && s.saturation === 0),
      temperature: two([], [fig('temperature', -100, 100, 40), fig('tint', -100, 100, 0)],
        (s) => s.temperature === 0 && s.tint === 0),
      rgb: two([], [fig('red', -100, 100, 20), fig('green', -100, 100, 0), fig('blue', -100, 100, -20)],
        (s) => s.red === 0 && s.green === 0 && s.blue === 0),
      mono: box([], [fig('red', 0, 200, 21), fig('green', 0, 200, 72), fig('blue', 0, 200, 7)]),
      sepia: box([], []),
      colorize: box([], [fig('hue', 0, 360, 200), fig('saturation', 0, 100, 60)]),
      duotone: box([tone('shadows', '#1b1464'), tone('highlights', '#ffd166')], []),
      colorpass: box([tone('color', '#ff0000')], [fig('range', 1, 100, 30), fig('softness', 0, 100, 10)]),
      look: box([pick('look', VFX_LOOKS)], []),
      invert: box([], []),
      // ---- stylize ----
      glow: box([tone('color', '#ffffff')], [fig('threshold', 0, 100, 60), part('radius', 0.1, 0.02), fig('intensity', 0, 200, 100)],
        (s) => !(s.intensity > 0)),
      sharpen: two([], [fig('amount', 0, 100, 40)], (s) => !(s.amount > 0)),
      // Dark outside a soft circle.
      vignette: two([], [fig('amount', -100, 100, 70)], (s) => s.amount === 0, { shape: 'circle', invert: true, soft: 0.2 }),
      grain: box([], [fig('amount', 0, 100, 25)], (s) => !(s.amount > 0)),
      scanlines: box([tick('vertical')], [fig('spacing', 2, 64, 4), fig('thickness', 1, 100, 50), fig('darkness', 0, 100, 50)],
        (s) => !(s.darkness > 0)),
      rgbsplit: box([], [part('amount', 0.05, 0.006), fig('angle', 0, 360, 0)], (s) => !(s.amount > 0)),
      posterize: box([], [fig('levels', 2, 32, 5)]),
      threshold: box([], [fig('level', 0, 100, 50)]),
      solarize: box([], [fig('level', 0, 100, 50)]),
      edges: box([pick('style', VFX_EDGE_STYLES)], [fig('intensity', 10, 500, 100)]),
      emboss: box([], [fig('amount', 0, 100, 50)], (s) => !(s.amount > 0)),
      nightvision: box([], [fig('gain', 0, 200, 150)]),
      thermal: box([pick('palette', VFX_PALETTES)], []),
      // ---- distort ----
      // A lens bends the frame it took: about the picture's middle.
      lens: whole([], [fig('amount', -100, 100, 40)], (s) => s.amount === 0),
      flip: whole([pick('mode', VFX_FLIP_MODES)], []),
      // ---- the second lot ----
      shadows: two([], [fig('shadows', -100, 100, 30), fig('highlights', -100, 100, -20)],
        (s) => s.shadows === 0 && s.highlights === 0),
      splittone: box([tone('shadows', '#1e5a8c'), tone('highlights', '#ffb060')], [fig('amount', 0, 100, 50)],
        (s) => !(s.amount > 0)),
      channels: box([pick('order', VFX_CHANNEL_ORDERS, 'bgr')], []),
      clarity: two([], [fig('amount', -100, 200, 60), part('radius', 0.1, 0.03)], (s) => s.amount === 0),
      dream: box([], [fig('amount', 0, 100, 60)], (s) => !(s.amount > 0)),
      oldfilm: box([], [fig('amount', 0, 100, 70)], (s) => !(s.amount > 0)),
      vhs: box([], [fig('amount', 0, 100, 60)], (s) => !(s.amount > 0)),
      // The curved screen is the whole picture's.
      crt: whole([], [fig('amount', 0, 100, 60)], (s) => !(s.amount > 0)),
      bars: whole([tick('vertical')], [part('size', 0.5, 0.12)], (s) => !(s.size > 0)),
      offset: whole([], [fig('x', 0, 100, 25), fig('y', 0, 100, 0)], (s) => s.x % 100 === 0 && s.y % 100 === 0),
      comic: box([], [fig('levels', 2, 16, 6), fig('edges', 0, 300, 120)]),
      border: whole([tone('color', '#ffffff')], [part('size', 0.25, 0.03)], (s) => !(s.size > 0)),
      rotate: whole([], [fig('angle', -180, 180, 15)], (s) => s.angle === 0),
      // ---- pictures that move by themselves ----
      // A magnifying glass: its edge is the glass's rim, not a fade.
      zoom: two([], [fig('zoom', 100, 800, 150), fig('x', -100, 100, 0), fig('y', -100, 100, 0)], (s) => !(s.zoom > 100),
        { soft: false, centred: true }),
      wave: box([tick('vertical'), own('speed', -50, 50, 10)], [part('amount', 0.1, 0.015), part('length', 1, 0.2)],
        (s) => !(s.amount > 0)),
      // Rings with no end of their own: the area is the pond.
      ripple: two([own('speed', -50, 50, 10)], [part('amount', 0.1, 0.01), part('length', 1, 0.15)], (s) => !(s.amount > 0),
        { centred: true }),
      swirl: point([], [fig('angle', -720, 720, 120), part('radius', 1.5, 0.6)], (s) => s.angle === 0),
      shake: whole([own('speed', 1, 100, 30)], [part('amount', 0.1, 0.01)], (s) => !(s.amount > 0)),
      glitch: box([own('speed', 1, 300, 80)], [part('amount', 0.3, 0.05), part('size', 0.5, 0.06)], (s) => !(s.amount > 0),
        { soft: false }),
      haze: two([own('speed', -50, 50, 10)], [part('amount', 0.05, 0.006), part('length', 0.5, 0.08)], (s) => !(s.amount > 0)),
      tile: whole([own('count', 2, 8, 3)], []),
      kaleido: point([own('segments', 2, 16, 6)], [fig('angle', -180, 180, 0)]),
      perspective: whole([], [fig('tiltx', -100, 100, 40), fig('tilty', -100, 100, 0)], (s) => s.tiltx === 0 && s.tilty === 0),
      bulge: point([], [fig('amount', -100, 100, 60), part('radius', 1.5, 0.35)], (s) => s.amount === 0),
      // A colour table of the user's own, a .cube file. Off until one is chosen.
      lut: box([{ id: 'file', type: 'file', def: '' }], [], (s) => !s.file),
      // ---- V5.2 ----
      // The picture on a surface seen at a slant: its corners dragged to the
      // surface's. Round it the picture is see-through (`alpha`), so what is
      // under the track shows there. It starts turned away a little, so that
      // it shows what it does.
      cornerpin: whole([], [...pin(VFX_PINS[0], 0.12, 0.1), ...pin(VFX_PINS[1], 0.88, 0.2), ...pin(VFX_PINS[2], 0.88, 0.8),
        ...pin(VFX_PINS[3], 0.12, 0.9)],
      (s) => s.x1 === 0 && s.y1 === 0 && s.x2 === 1 && s.y2 === 0 && s.x3 === 1 && s.y3 === 1 && s.x4 === 0 && s.y4 === 1,
      { pins: VFX_PINS, alpha: true }),
      polar: whole([pick('mode', VFX_POLAR_MODES)], [fig('amount', 0, 100, 100)], (s) => !(s.amount > 0)),
      // The pale colours made stronger and the strong ones left: a correction.
      vibrance: two([], [fig('vibrance', -100, 100, 60)], (s) => s.vibrance === 0),
      // Dots as a print has them, their size by how dark the picture is there.
      halftone: box([tick('tinted')], [part('size', 0.1, 0.014), fig('angle', 0, 90, 45)]),
      // ---- V5.3 ----
      // The tones bent by a curve drawn through points, for all colours and
      // for red, green and blue alone: a correction. It starts with a little
      // more contrast, so that it shows what it does.
      curves: two([{ id: 'curve', type: 'curve', def: VFX_CURVE_DEF }], [], (s) => vfxCurveFlat(s.curve)),
      // ---- V5.4. Keying ----
      // A colour of the picture made see-through, a green or a blue screen
      // first of all, so that the track under it shows there (`alpha`). The
      // whole picture and with no Mix: what is to stay of a screen is a
      // mask's business, and a key that is half on is no key. Its colour may
      // be taken from the picture (`pick`): a real screen is never the
      // green a colour well offers.
      chromakey: whole([{ ...tone('color', '#00b140'), pick: true }],
        [fig('tolerance', 0, 100, 30), fig('softness', 0, 100, 15), fig('spill', 0, 100, 60)], null, { mix: false, alpha: true }),
      // The dark or the bright parts made see-through.
      lumakey: whole([pick('mode', VFX_LUMA_MODES)], [fig('threshold', 0, 100, 20), fig('softness', 0, 100, 10)], null,
        { mix: false, alpha: true }),
      // ---- V5.5. Time ----
      // A flash of one colour over the whole picture, again and again:
      // Speed is how many in ten seconds, Flash Length how much of each
      // round the flash is there, in hundredths, and Mix how strong it is.
      strobe: whole([tone('color', '#ffffff'), own('speed', 1, 300, 40)], [fig('duration', 1, 100, 30)]),
      // V5.5.1. The picture as it was a few frames ago laid over it, and as
      // it was before that, each fainter than the one after it: what moves
      // leaves copies of itself behind. How many, how many frames apart and
      // how much fainter are the VFX's own, since the encoder keeps the
      // frames it mixes and cannot be told another number half way. It
      // works on the track's picture as the file has it, before every other
      // VFX of the track whatever its place among them (`first`), and only
      // one to a track: the frames from before are the file's, and nobody
      // has kept what the other VFX made of them.
      echo: whole([own('copies', 1, 5, 3), own('gap', 1, 10, 4), own('decay', 1, 100, 60)], [], null, { first: true }),
    };
  })();

  const VFX_KINDS = {
    obscure: {
      where: 'any',
      area: true,
      statics: VFX_AREA_STATICS,
      keyed: [
        { id: 'strength', type: 'number', min: 0, max: 100, whole: true, def: 30, in: 'filter' },
        VFX_SOFT,
      ],
      off: (s) => !(s.strength > 0),
    },
    pixelate: {
      where: 'any',
      area: true,
      statics: VFX_AREA_STATICS,
      keyed: [
        { id: 'strength', type: 'number', min: 0, max: 100, whole: true, def: 25, in: 'filter' },
        VFX_SOFT,
      ],
      off: (s) => !(s.strength > 0),
    },
    ...VFX_MORE,
  };
  const VFX_KIND_IDS = Object.keys(VFX_KINDS);
  // V5.1. The menu's groups, each the kinds under one heading, in order.
  const VFX_GROUPS = [
    { id: 'hide', kinds: ['obscure', 'pixelate', 'dirblur', 'tiltshift'] },
    { id: 'color', kinds: ['brightness', 'exposure', 'levels', 'curves', 'shadows', 'huesat', 'vibrance', 'temperature', 'rgb', 'mono', 'sepia',
      'colorize', 'duotone', 'splittone', 'colorpass', 'look', 'lut', 'channels', 'invert'] },
    { id: 'stylize', kinds: ['glow', 'dream', 'sharpen', 'clarity', 'vignette', 'bars', 'grain', 'oldfilm', 'vhs', 'crt', 'comic', 'border',
      'scanlines', 'halftone', 'rgbsplit', 'posterize', 'threshold', 'solarize', 'edges', 'emboss', 'nightvision', 'thermal'] },
    { id: 'distort', kinds: ['lens', 'bulge', 'flip', 'rotate', 'offset', 'zoom', 'perspective', 'cornerpin', 'polar', 'wave', 'ripple',
      'swirl', 'haze', 'shake', 'glitch', 'tile', 'kaleido'] },
    // V5.4.
    { id: 'key', kinds: ['chromakey', 'lumakey'] },
    // V5.5.
    { id: 'time', kinds: ['strobe', 'echo'] },
  ];

  // The user: no cap, "if you have 50 same vfx in a track but all at different
  // times ... it should still export", and instead a note, once a project,
  // on "adding >=8th VFX to a track with at least 3x the same vfx type".
  const VFX_NOTE_FROM = 8;
  const VFX_NOTE_SAME = 3;

  function vfxKind(kind) {
    return Object.prototype.hasOwnProperty.call(VFX_KINDS, kind) ? VFX_KINDS[kind] : null;
  }

  function newVfxId() {
    return 'x' + Math.random().toString(36).slice(2, 10);
  }

  /** The fields a keyframe of this kind holds, in a fixed order. */
  function vfxKeyedIds(kind) {
    const def = vfxKind(kind);
    if (!def) return [];
    return [...(def.area ? ['box', 'rotation'] : []), ...def.keyed.map((s) => s.id)];
  }

  function vfxSettingValue(s, v) {
    if (s.type === 'check') return bool(v);
    // V5.1.3. One of the shapes the kind offers, which may be fewer than all.
    if (s.type === 'shape') return oneOf(v, s.options || SHAPE_KINDS, s.def);
    if (s.type === 'choice') return oneOf(v, s.options, s.def);
    if (s.type === 'color') return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : s.def;
    if (s.type === 'file') return typeof v === 'string' ? v : '';
    if (s.type === 'curve') return vfxCurveOf(v, s.def);
    const n = within(v, s.min, s.max, s.def);
    return s.whole ? Math.round(n) : n;
  }

  /** A kind's keyed values read out of `src`, each held to its range. */
  function vfxValuesOf(kind, src) {
    const def = vfxKind(kind);
    const from = src && typeof src === 'object' ? src : {};
    const out = {};
    if (def.area) {
      out.box = maskBoxOf(from.box);
      out.rotation = rotationOf(from.rotation);
    }
    for (const s of def.keyed) out[s.id] = vfxSettingValue(s, from[s.id]);
    // V5.1.4. A kind about a point had an area before and bent the picture
    // about its middle: one kept from then stays where it was.
    if (def.where === 'point' && from.box && typeof from.box === 'object') {
      const b = maskBoxOf(from.box);
      if (!Number.isFinite(Number(from.cx))) out.cx = vfxSettingValue(VFX_CX, b.x + b.w / 2);
      if (!Number.isFinite(Number(from.cy))) out.cy = vfxSettingValue(VFX_CY, b.y + b.h / 2);
    }
    return out;
  }

  /** A VFX's keyframes as a file may hand them over: in time order, one to a moment and one to an id. */
  function vfxKeysOf(kind, list) {
    if (!Array.isArray(list)) return [];
    const byTime = new Map();
    const ids = new Set();
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const t = Number(raw.t);
      if (!Number.isFinite(t)) continue;
      const k = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : newKeyframeId(),
        t: round(t),
        ...vfxValuesOf(kind, raw),
      };
      if (ids.has(k.id)) k.id = newKeyframeId();
      ids.add(k.id);
      byTime.set(k.t, k);
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }

  /** One VFX as the model keeps it, or null for a kind this build does not have. */
  function vfxOf(v) {
    if (!v || typeof v !== 'object') return null;
    const def = vfxKind(v.kind);
    if (!def) return null;
    const out = { id: typeof v.id === 'string' && v.id ? v.id : newVfxId(), kind: v.kind };
    // V5.1.2. The user: a checkbox in front of every added VFX "so it can be
    // quickly dis-/enabled without the need to delete or move it". Kept only
    // when it is switched off, so a VFX that is on reads as it always did.
    if (v.disabled === true) out.disabled = true;
    for (const s of def.statics) out[s.id] = vfxSettingValue(s, v[s.id]);
    Object.assign(out, vfxValuesOf(v.kind, v));
    const keys = vfxKeysOf(v.kind, v.keys);
    if (keys.length) out.keys = keys;
    return out;
  }

  /** A layer's VFX in the order they are processed, each with an id of its own. */
  function vfxListOf(list) {
    if (!Array.isArray(list)) return [];
    const ids = new Set();
    const out = [];
    for (const raw of list) {
      const v = vfxOf(raw);
      if (!v) continue;
      if (ids.has(v.id)) v.id = newVfxId();
      ids.add(v.id);
      out.push(v);
    }
    return out;
  }

  /**
   * V5.5.1. A layer's VFX in the order they are worked: as listed, but a
   * kind that works on the picture as the file has it (`first`, an Echo)
   * before all others, and of several such only the first that is switched
   * on. The preview and the export both go by this.
   */
  function vfxWorked(layer) {
    const list = vfxList(layer);
    const isFirst = (v) => !!vfxKind(v.kind) && !!vfxKind(v.kind).first;
    if (!list.some(isFirst)) return list;
    const head = list.find((v) => isFirst(v) && !v.disabled);
    return [...(head ? [head] : []), ...list.filter((v) => !isFirst(v))];
  }

  /** What a layer has, in the order processed. Only a picture of a file has any. */
  function vfxList(layer) {
    if (!layer || layer.kind === 'gen' || layer.type !== 'video' || !Array.isArray(layer.vfx)) return [];
    return layer.vfx;
  }

  function vfxKeysFor(v) {
    return v && Array.isArray(v.keys) ? v.keys : [];
  }

  /**
   * Which of its kind a VFX is on its track, counted from 1 in the order
   * processed: the user's "Pixelate, Pixelate (2)".
   */
  function vfxNumber(list, index) {
    const v = list[index];
    if (!v) return 0;
    let n = 0;
    for (let i = 0; i <= index; i += 1) if (list[i].kind === v.kind) n += 1;
    return n;
  }

  /** Whether a track with this list is due the note about keyframes. */
  function vfxNoteDue(list) {
    if (!Array.isArray(list) || list.length < VFX_NOTE_FROM) return false;
    const counts = new Map();
    for (const v of list) counts.set(v.kind, (counts.get(v.kind) || 0) + 1);
    return [...counts.values()].some((n) => n >= VFX_NOTE_SAME);
  }

  /** From turn a to turn b the short way round, in signed degrees. */
  function turnBetween(a, b) {
    const d = ((((Number(b) || 0) - (Number(a) || 0)) % 360 + 540) % 360) - 180;
    return d === -180 ? 180 : d;
  }

  /** One set of keyed values copied, so a keyframe never shares its box. */
  function vfxValuesCopy(kind, src) {
    const out = {};
    for (const id of vfxKeyedIds(kind)) out[id] = id === 'box' ? { ...src.box } : src[id];
    return out;
  }

  /**
   * A VFX's keyed values at `t`, the clip's own seconds, blended between the
   * keyframes either side and not rounded: its own without keyframes. The
   * turn goes the short way round.
   */
  function vfxValuesAt(v, t) {
    const list = vfxKeysFor(v);
    if (!list.length) return vfxValuesCopy(v.kind, v);
    const at = Number.isFinite(Number(t)) ? Number(t) : 0;
    if (at <= list[0].t) return vfxValuesCopy(v.kind, list[0]);
    const last = list[list.length - 1];
    if (at >= last.t) return vfxValuesCopy(v.kind, last);
    let i = 0;
    while (list[i + 1].t <= at) i += 1;
    const a = list[i];
    const b = list[i + 1];
    const u = (at - a.t) / (b.t - a.t);
    const lerp = (p, q) => p + (q - p) * u;
    const out = {};
    for (const id of vfxKeyedIds(v.kind)) {
      if (id === 'box') {
        out.box = { x: lerp(a.box.x, b.box.x), y: lerp(a.box.y, b.box.y), w: lerp(a.box.w, b.box.w), h: lerp(a.box.h, b.box.h) };
      } else if (id === 'rotation') {
        out.rotation = rotationOf((a.rotation || 0) + turnBetween(a.rotation, b.rotation) * u);
      } else {
        out[id] = lerp(Number(a[id]) || 0, Number(b[id]) || 0);
      }
    }
    return out;
  }

  /**
   * A VFX as it is at `t` of the clip, with no keys left, which is what every
   * drawing takes: { id, kind, off, ...statics, ...keyed values, areas }.
   * A whole-number setting is rounded here, so the preview and the export
   * read the very same figure off a blend. `areas` is its area as the shared
   * drawing has always taken one, [{ kind: its shape, box, rotation }].
   *
   * V5.1.3. What a kind does not offer is here as it stands for it, so every
   * drawing reads one description whatever the kind: a kind with a box and
   * no shape is a square, one with no Invert is not inverted, one with no
   * soft edge has a hard one, and one with no area acts on all of the
   * picture, which is a square over all of it.
   */
  function vfxAt(v, t) {
    const def = vfxKind(v.kind);
    const now = vfxValuesAt(v, t);
    const out = { id: v.id, kind: v.kind, shape: 'square', invert: false, soft: 0 };
    for (const s of def.statics) out[s.id] = v[s.id];
    for (const s of def.keyed) out[s.id] = s.whole ? Math.round(now[s.id]) : now[s.id];
    out.areas = def.area
      ? [{ kind: out.shape, box: now.box, rotation: now.rotation || 0 }]
      : [{ kind: 'square', box: { x: 0, y: 0, w: 1, h: 1 }, rotation: 0 }];
    // V5.1.2. One switched off by its checkbox is off at every moment.
    out.off = !!v.disabled || !!def.off(out);
    return out;
  }

  /**
   * V5.1. Whether a VFX as it is at one moment (vfxAt) acts on all of the
   * picture alike: a square not turned and not inverted that reaches every
   * edge, with no soft edge. Mix aside, which takes all of it down alike.
   * Such a one needs no drawing of where it acts.
   */
  function vfxCoversAll(now) {
    if (!now || now.invert || now.shape !== 'square' || (now.soft || 0) > 0) return false;
    const a = now.areas && now.areas[0];
    if (!a || (((a.rotation || 0) % 180) + 180) % 180 !== 0) return false;
    const b = a.box;
    const e = 1e-6;
    return b.x <= e && b.y <= e && b.x + b.w >= 1 - e && b.y + b.h >= 1 - e;
  }

  /**
   * V5.2. Whether a layer's VFX leave parts of its picture see-through that
   * were not: one of a kind that does (`alpha`, a Corner Pin) that is ever
   * on. Such a picture is carried with an alpha from there on, like a PNG's.
   */
  function vfxGivesAlpha(layer) {
    return vfxList(layer).some((v) => {
      const def = vfxKind(v.kind);
      return !!def && !!def.alpha && vfxEverOn(v);
    });
  }

  // V5.1. The kinds whose picture changes from frame to frame with no setting
  // changing: the ones with a Speed, and the ones with grain.
  const VFX_ALONE = ['wave', 'ripple', 'shake', 'glitch', 'haze', 'grain', 'oldfilm', 'vhs', 'strobe'];

  /** Whether a VFX moves by itself while it is on, keyframes or none. */
  function vfxMovesAlone(v) {
    return !!v && VFX_ALONE.includes(v.kind) && vfxEverOn(v);
  }

  /** Whether a VFX does anything at any moment: one that is off throughout does not. */
  function vfxEverOn(v) {
    const def = vfxKind(v.kind);
    if (!def || v.disabled) return false;
    const list = vfxKeysFor(v);
    if (!list.length) return !def.off(v);
    // V5.3. A keyframe holds only what is keyed, and a kind may be off by a
    // setting of its own (no LUT file chosen, curves that change nothing):
    // so each keyframe is asked with the VFX's own settings beside it. Until
    // then an Apply LUT with keyframes was never on, and so never exported.
    return list.some((k) => !def.off({ ...v, ...k }));
  }

  /** Whether a VFX changes at all over the clip: keyframes that do not all say the same. */
  function vfxMoves(v) {
    const list = vfxKeysFor(v);
    if (list.length < 2 || v.disabled) return false;
    const ids = vfxKeyedIds(v.kind);
    const said = (k) => JSON.stringify(ids.map((id) => k[id]));
    const first = said(list[0]);
    return list.some((k) => said(k) !== first);
  }

  /**
   * The stretch of the clip over which where a VFX acts changes, in the
   * clip's own seconds, or null when it never does: its box, its turn and
   * every setting that is `in: 'mask'`. From the first keyframe to the last,
   * held to the clip.
   */
  function vfxMotion(layer, v) {
    if (!layer || !v) return null;
    const def = vfxKind(v.kind);
    const list = vfxKeysFor(v);
    if (!def || list.length < 2) return null;
    const ids = [...(def.area ? ['box', 'rotation'] : []), ...def.keyed.filter((s) => s.in === 'mask').map((s) => s.id)];
    const said = (k) => JSON.stringify(ids.map((id) => k[id]));
    const first = said(list[0]);
    if (list.every((k) => said(k) === first)) return null;
    const from = Math.max(0, list[0].t);
    const to = Math.min(layer.duration, list[list.length - 1].t);
    return to > from ? { from, to } : null;
  }

  /**
   * What a VFX does, frame by frame, for an encoder that cannot be told a
   * figure per frame: the frames of the clip at `fps` in runs, each
   * `{ from, to, at }`, first and last frame and the VFX as it is on them
   * (vfxAt at the frame's own moment, frame i being i / fps of the clip).
   * A run is as long as every `in: 'filter'` setting and `off` stay the same.
   * One run for a VFX that never changes what it does.
   */
  function vfxRuns(layer, v, fps) {
    const def = vfxKind(v.kind);
    const rate = Math.max(1, Number(fps) || 30);
    const total = Math.max(1, Math.round(layer.duration * rate));
    // V5.1. A kind that bends the picture about the middle of its area
    // (`centred`) does something else wherever the area is, so its area is
    // one of the figures its filter takes.
    const ids = [...(def.centred ? ['areas'] : []), ...def.keyed.filter((s) => s.in === 'filter').map((s) => s.id)];
    const said = (now) => (now.off ? 'off' : JSON.stringify(ids.map((id) => now[id])));
    const list = vfxKeysFor(v);
    const first = vfxAt(v, 0);
    // V5.1. By every setting a keyframe holds but the area's own: one that only
    // says where the VFX acts, like Mix, may still switch it off and on.
    const held = [...(def.centred ? ['box'] : []), ...def.keyed.map((s) => s.id)];
    if (list.length < 2 || list.every((k) => JSON.stringify(held.map((id) => k[id])) === JSON.stringify(held.map((id) => list[0][id])))) {
      return [{ from: 0, to: total - 1, at: first }];
    }
    const runs = [];
    let open = { from: 0, to: 0, at: first };
    let key = said(first);
    for (let i = 1; i < total; i += 1) {
      const now = vfxAt(v, i / rate);
      const k = said(now);
      if (k === key) {
        open.to = i;
        continue;
      }
      runs.push(open);
      open = { from: i, to: i, at: now };
      key = k;
    }
    runs.push(open);
    return runs;
  }

  /** The keyframe of a VFX at `t`, within `reach` either side, or null. */
  function vfxKeyNear(v, t, reach = 0) {
    let best = null;
    for (const k of vfxKeysFor(v)) {
      const d = Math.abs(k.t - t);
      if (d <= reach && (!best || d < Math.abs(best.t - t))) best = k;
    }
    return best;
  }

  /**
   * A keyframe put on a VFX, a new one or a changed one by its id, holding
   * every keyed value. One that was at the same moment already gives way.
   */
  function putVfxKey(v, key) {
    const k = { id: key.id || newKeyframeId(), t: round(Number(key.t) || 0), ...vfxValuesCopy(v.kind, key) };
    const rest = vfxKeysFor(v).filter((o) => o.id !== k.id && o.t !== k.t);
    return { ...v, keys: [...rest, k].sort((a, b) => a.t - b.t) };
  }

  /**
   * A keyframe taken off a VFX, by the rules a layer's go by: the first
   * deleted with two or more after it takes the second's settings and stays,
   * and when a delete leaves one alone that goes too, the VFX being from then
   * on what the first had.
   */
  function removeVfxKey(v, id) {
    const list = vfxKeysFor(v);
    const gone = list.find((k) => k.id === id);
    if (!gone) return v;
    if (gone === list[0] && list.length > 2) {
      const second = list[1];
      return { ...v, keys: list.map((k) => (k === gone ? { id: k.id, t: k.t, ...vfxValuesCopy(v.kind, second) } : k)) };
    }
    const keys = list.filter((k) => k !== gone);
    if (keys.length > 1) return { ...v, keys };
    const { keys: _keys, ...still } = v;
    return { ...still, ...vfxValuesCopy(v.kind, list[0]) };
  }

  /**
   * A keyframe of a VFX dragged along a clip `duration` long. It stays on the
   * part that shows and never lands on another's moment, stopping a
   * millisecond short instead.
   */
  function moveVfxKey(v, id, t, duration) {
    const list = vfxKeysFor(v);
    const k = list.find((o) => o.id === id);
    if (!k) return v;
    let at = clamp(round(Number(t)), 0, round(duration));
    const taken = (x) => list.some((o) => o !== k && Math.abs(o.t - x) < 0.0005);
    if (taken(at)) at = round(at + (at >= k.t ? -0.001 : 0.001));
    if (taken(at)) return v;
    return { ...v, keys: list.map((o) => (o === k ? { ...o, t: at } : o)).sort((a, b) => a.t - b.t) };
  }

  /** A list of VFX with every keyframe's time put through `move`. */
  function vfxKeysMoved(list, move) {
    return list.map((v) => {
      const keys = vfxKeysFor(v);
      return keys.length ? { ...v, keys: keys.map((k) => ({ ...k, t: round(move(k.t)) })) } : v;
    });
  }

  /**
   * A layer's VFX with every keyframe moved by `dt` of the clip's seconds, as
   * `{ vfx }` to spread onto it, or nothing to spread when none has any: what
   * a trim of the start and a split do to them, as they do to the layer's own.
   */
  function shiftVfxKeys(layer, dt) {
    const list = vfxList(layer);
    if (!dt || !list.some((v) => vfxKeysFor(v).length)) return {};
    return { vfx: vfxKeysMoved(list, (t) => t + dt) };
  }

  /**
   * Obscure's blur for a source picture `height` high: the sigma of the
   * Gaussian in that picture's pixels. Strength 30 is 1.5% of the height, 16
   * pixels at 1080p, which leaves a face a smudge.
   */
  function obscureSigma(strength, height) {
    return Math.max(0.5, height * strength * 0.0005);
  }

  /**
   * Pixelate's block for a source picture `height` high, in its pixels.
   * Strength 25 is 2.5% of the height, 26 pixels at 1080p. Always even: on
   * 4:2:0 video the encoder's pixelize takes an odd block one smaller
   * (measured, 27 came out 26), and the preview has to draw the same grid.
   */
  function pixelateBlock(strength, height) {
    return Math.max(2, 2 * Math.round(height * strength * 0.0005));
  }

  /**
   * A mask, or null for none. `src` is the user's own picture for a custom
   * one, `by` whether its transparency or its brightness is what shows
   * ("alpha" or "luma", decided once when it is picked), and `aspect` its
   * width over its height, for the box it starts in. A custom mask with no
   * picture is a circle, so a mask is never something that cannot be drawn.
   */
  function maskOf(v) {
    if (!v || typeof v !== 'object') return null;
    const src = typeof v.src === 'string' && v.src ? v.src : null;
    let kind = oneOf(v.kind, MASK_KINDS, 'circle');
    if (kind === 'custom' && !src) kind = 'circle';
    return {
      kind,
      invert: bool(v.invert),
      soft: maskSoftOf(v.soft),
      box: maskBoxOf(v.box),
      ring: within(v.ring, 0.05, 0.95, 0.4),
      points: Math.round(within(v.points, 3, 12, 5)),
      inner: within(v.inner, 0.1, 0.9, 0.381966),
      radius: maskRadiusOf(v.radius),
      src: kind === 'custom' ? src : null,
      by: oneOf(v.by, MASK_BY, 'alpha'),
      aspect: within(v.aspect, 0.01, 100, 1),
      // V3.7.1. The user: "Layer masks have no color or gradient option yet,
      // add them". How much of the picture the mask shows: by its colour, or
      // along a gradient, the custom picture's rule, white showing, black
      // hiding and grey showing in part, times the alpha. White is the mask
      // every one was before, so a 3.7 project opens as it was. The whole
      // clip's, not keyed, like a shape's.
      fill: oneOf(v.fill, SHAPE_FILLS, 'color'),
      color: colourOf(v.color, '#ffffffff'),
      gradient: maskGradientOf(v.gradient),
    };
  }

  /**
   * V3.7.1. A mask's gradient: a shape's, with Start and End in fractions of
   * the picture's height, as its soft edge is, so it scales with the picture.
   * The angle is measured from the picture, which the mask turns with.
   */
  function maskGradientOf(v) {
    const src = v && typeof v === 'object' ? v : {};
    return {
      ...gradientOf(src),
      start: within(src.start, -100, 100, -0.5),
      end: within(src.end, -100, 100, 0.5),
    };
  }

  /** What a keyframe holds of a mask, or null when it holds none. */
  function maskKeyOf(v) {
    if (!v || typeof v !== 'object') return null;
    return { box: maskBoxOf(v.box), soft: maskSoftOf(v.soft), radius: maskRadiusOf(v.radius) };
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
    if (form === 'shape') return { form, refHeight, shape: shapeOf(src.shape) };
    return { form, refHeight, text: textOf(src.text) };
  }

  function createLayer(props = {}) {
    const kind = kindOf(props);
    const still = kind !== 'media';
    const sourceDuration = still ? 0 : Math.max(0, round(props.sourceDuration || 0));
    const sourceIn = clamp(props.sourceIn === undefined ? 0 : props.sourceIn, 0, sourceDuration);
    // V4.11. How fast the source plays, 1 for every layer from before and for
    // a still, which has no clock to run faster.
    const speed = still ? 1 : speedValue(props.speed);
    // A layer defaults to showing the rest of its source from sourceIn onwards,
    // which at another speed takes that much less or more of the timeline.
    const rest = (sourceDuration - sourceIn) / speed;
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
      // V4.11. Seconds of the source to one second of the timeline, 0.1 to 10,
      // see "Speed" below. Declared here for the reason groupId is: a field
      // createLayer does not name is a field the project open path drops.
      speed,
      enabled: props.enabled === undefined ? true : !!props.enabled,
      volume: props.volume === undefined ? 1 : props.volume,
      // Set and read by grouping in Step 14. Declared here because the
      // serialisable shape wants settling in one place, not because anything
      // reads it yet.
      groupId: props.groupId || null,
      // V4.3. The join this layer is a piece of, null for none. Declared here
      // for the reason groupId is: a field createLayer does not name is a
      // field the project open path drops.
      joinId: typeof props.joinId === 'string' && props.joinId ? props.joinId : null,
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
      // V3.4. How far a picture is turned about its middle, in degrees, -180
      // to 180, clockwise positive like a text's. The user: "A video should
      // have the rotation-circles at its corners like texts do". A generated
      // layer turns inside its own settings, and a sound has nothing to turn.
      rotation: kind !== 'gen' && props.type !== 'audio' ? rotationOf(props.rotation) : 0,
      // V3.6. The layer's mask, null for none, which every layer written
      // before masks is. Only a picture of a file has one: a generated layer
      // is a shape or a text already, and a sound has nothing to mask.
      mask: kind !== 'gen' && props.type !== 'audio' ? maskOf(props.mask) : null,
      // V5.0. Its VFX in the order they are processed, empty for none, which
      // every layer written before them is. Like the mask, only a picture of
      // a file has them. Declared here for the reason render is: a field
      // createLayer does not name is a field the project open path drops,
      // which is also what becomes of the `obscure` and `pixelate` a project
      // from before V5.0 has (the user: "no conversion").
      vfx: kind !== 'gen' && props.type !== 'audio' ? vfxListOf(props.vfx) : [],
      // V3.3. The crop, placement and ring at moments of the clip, and empty on
      // everything written before them. See "Keyframes" below. Declared here
      // for the reason render is: a field createLayer does not name is a field
      // the project open path drops.
      keyframes: keyframesOf(props.keyframes, {
        type: props.type === 'audio' && kind !== 'gen' ? 'audio' : 'video',
        kind,
        gen: kind === 'gen' ? props.gen : null,
      }),
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
      // V5.1.5. What "no position" means for this layer: false is centre and
      // fit, which is every layer written before this and every video; true is
      // centred at its own pixel size where that fits the frame, which an
      // image gets when it is added (geometry.js ownSizeRect). Declared here
      // for the reason render is: a field createLayer does not name is a field
      // the project open path drops.
      ownSize: kind !== 'gen' && props.type !== 'audio' && props.ownSize === true,
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
      // V3.8.1. The shape of each fade, by name. Declared here for the reason
      // fadeIn is: a field createLayer does not name is a field the project
      // open path drops. Linear for anything unknown, old files included.
      fadeInCurve: curveId(props.fadeInCurve),
      fadeOutCurve: curveId(props.fadeOutCurve),
      // V4.10. What each fade does to the picture in place of fading it: a
      // wipe, a slide and so on, see "Transitions" below. Null is the plain
      // fade, which every layer written before this has. A sound has nothing
      // to wipe, so it never carries one. Declared here for the reason fadeIn
      // is: a field createLayer does not name is a field the project open
      // path drops.
      fadeInTransition: props.type === 'audio' && kind !== 'gen' ? null : transitionSettingsOf(props.fadeInTransition),
      fadeOutTransition: props.type === 'audio' && kind !== 'gen' ? null : transitionSettingsOf(props.fadeOutTransition),
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
  //
  // V4.11. In the timeline's seconds, so at twice the speed half as much is
  // left to drag out.
  function sourceRemaining(layer) {
    if (isStill(layer)) return Infinity;
    return round((layer.sourceDuration - layer.sourceIn) / speedOf(layer));
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
    return round(layer.sourceIn / speedOf(layer));
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
    // V4.10. An end with a transition is not faded: the transition is what
    // brings the picture in or takes it out there.
    const fades = alphaFadesOf(layer);
    if (!fades.in && !fades.out) return 1;
    const into = clamp(round(t - (Number(layer.start) || 0)), 0, span);
    const curves = fadeCurvesOf(layer);
    let alpha = 1;
    // V3.8.1. A fade in is the curve itself, a fade out is what the curve has
    // not yet taken away. Linear is the line these two sums drew before curves.
    if (fades.in > 0) alpha *= fadeShape(curves.in, clamp(into / fades.in, 0, 1));
    if (fades.out > 0) {
      alpha *= 1 - fadeShape(curves.out, clamp((into - (span - fades.out)) / fades.out, 0, 1));
    }
    return clamp(alpha, 0, 1);
  }

  // ---- V3.8.1. The shape of a fade ----
  //
  // "Different video and audio fade in/out options, not only linear but also
  // ease-in (InQuad), ease-out (OutQuad), ease-in-out (InOutQuad)". Nine of
  // them, the most the pop-up holds: three rows of three.
  //
  // A curve is how far the fade has got, 0 to 1, at a point 0 to 1 of the way
  // through it. A fade in is that number as the layer's opacity or volume; a
  // fade out is one minus it, so "ease in" means the same thing at both ends:
  // it starts slowly and ends fast, and a fade out with it holds on to the
  // picture for a while and lets go at the last moment.
  //
  // **Each curve is written twice, once for JavaScript and once as an ffmpeg
  // expression, and they sit side by side so they can be read against each
  // other.** The window answers the question with `at`; the file answers it
  // with `expr`, in geq for a picture and aeval for a sound. A test evaluates
  // both and compares them, which is what keeps the preview and the export one
  // picture. `x` in an expression is itself an expression, already clipped to
  // 0..1, and is repeated rather than named because ffmpeg has no variables.
  const FADE_CURVES = [
    { id: 'linear', at: (p) => p, expr: (x) => x },
    { id: 'quadIn', at: (p) => p * p, expr: (x) => 'pow(' + x + ',2)' },
    { id: 'quadOut', at: (p) => 1 - (1 - p) * (1 - p), expr: (x) => '(1-pow(1-' + x + ',2))' },
    {
      id: 'quadInOut',
      at: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(2 - 2 * p, 2) / 2),
      expr: (x) => 'if(lt(' + x + ',0.5),2*pow(' + x + ',2),1-pow(2-2*' + x + ',2)/2)',
    },
    { id: 'cubicIn', at: (p) => p * p * p, expr: (x) => 'pow(' + x + ',3)' },
    { id: 'cubicOut', at: (p) => 1 - Math.pow(1 - p, 3), expr: (x) => '(1-pow(1-' + x + ',3))' },
    {
      id: 'cubicInOut',
      at: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(2 - 2 * p, 3) / 2),
      expr: (x) => 'if(lt(' + x + ',0.5),4*pow(' + x + ',3),1-pow(2-2*' + x + ',3)/2)',
    },
    {
      id: 'quartInOut',
      at: (p) => (p < 0.5 ? 8 * Math.pow(p, 4) : 1 - Math.pow(2 - 2 * p, 4) / 2),
      expr: (x) => 'if(lt(' + x + ',0.5),8*pow(' + x + ',4),1-pow(2-2*' + x + ',4)/2)',
    },
    {
      id: 'sineInOut',
      at: (p) => (1 - Math.cos(Math.PI * p)) / 2,
      expr: (x) => '((1-cos(PI*' + x + '))/2)',
    },
  ];
  const FADE_CURVE_IDS = FADE_CURVES.map((c) => c.id);

  /** A curve name as one the model knows; anything else is linear. */
  function curveId(v) {
    return FADE_CURVE_IDS.includes(v) ? v : 'linear';
  }

  /** How far a fade has got, 0 to 1, a fraction p of the way through it. */
  function fadeShape(curve, p) {
    const c = FADE_CURVES.find((k) => k.id === curve) || FADE_CURVES[0];
    return clamp(c.at(clamp(Number(p) || 0, 0, 1)), 0, 1);
  }

  /** The same curve as an ffmpeg expression of `x`, an expression running 0 to 1. */
  function fadeCurveExpr(curve, x) {
    const c = FADE_CURVES.find((k) => k.id === curve) || FADE_CURVES[0];
    return c.expr(x);
  }

  /** A layer's two curves. Linear for every layer that never chose one. */
  function fadeCurvesOf(layer) {
    return { in: curveId(layer && layer.fadeInCurve), out: curveId(layer && layer.fadeOutCurve) };
  }

  // ---- V4.10. Transitions ----
  //
  // The user: "When rightclicking fade-in or fade-out (also at overlapping
  // tracks) below the 3x3 grid of fade curves add a row "Transision" which
  // opens a window where you can select one of pre-defined transitions. A
  // transition always takes an "old" track and a "new" track so they behave
  // identical between single-track "fade-in" transition, using a completely
  // transparent "track" as before-track if no overlap exists. If an overlap
  // exists it uses both tracks."
  //
  // So a transition is what a fade does to the picture in place of fading it,
  // and it belongs to one end of a layer the way a fade's length and curve do:
  // `fadeInTransition` and `fadeOutTransition`, each null for the plain fade
  // or `{ kind, ...its settings }`. The fade's length is how long it takes and
  // the fade's curve is how its progress runs, so the nine curves ease a wipe
  // exactly as they ease a fade.
  //
  // Progress `e` runs from 0, all of the old picture, to 1, all of the new.
  // A layer's start is the new picture coming in over whatever is under it,
  // and its end is the old picture going out for whatever is under it: on a
  // single track the other one is nothing at all, and where two tracks overlap
  // the earlier one's end and the later one's start carry the same transition
  // and run through it together, so the two halves are one movement.
  //
  //   wipe      a straight edge crossing the picture in a direction
  //   iris      a shape opening from the middle, or closing onto it
  //   clock     a hand sweeping round the middle
  //   blinds    slats opening side by side
  //   dissolve  blocks appearing in no order
  //   slide     the new picture pushing the old one out in a direction
  //   zoom      the new picture growing from the middle, turning if asked
  //
  // The first five are a matte, where the new picture shows and where it does
  // not yet; the last two move the picture. genDraw.js draws the mattes and
  // geometry.js places the moved pictures, each once for the preview and the
  // export alike.

  const TRANSITION_KINDS = ['wipe', 'iris', 'clock', 'blinds', 'dissolve', 'slide', 'zoom'];
  const IRIS_SHAPES = ['circle', 'square', 'diamond', 'star'];
  // What each kind is when nothing has been set on it yet.
  const TRANSITION_DEFAULTS = {
    wipe: { angle: 0, soft: 0.1 },
    iris: { shape: 'circle', soft: 0.1, reverse: false },
    clock: { start: 270, clockwise: true, soft: 0.05 },
    blinds: { count: 8, vertical: false, soft: 0 },
    dissolve: { rows: 24, soft: 0.2 },
    slide: { angle: 0 },
    zoom: { turns: 0 },
  };

  // A direction in whole degrees, 0 up to 360: 0 to the right and positive
  // clockwise, the app's way.
  function directionOf(v, fallback) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return fallback;
    return ((Math.round(n) % 360) + 360) % 360;
  }

  /**
   * A transition's settings as the model knows them, or null for the plain
   * fade: anything that is not one of the kinds, which is also what every file
   * written before 4.10 has. Each setting is held to its range, so a file
   * edited by hand opens as something drawable.
   */
  function transitionSettingsOf(v) {
    if (!v || typeof v !== 'object' || !TRANSITION_KINDS.includes(v.kind)) return null;
    const d = TRANSITION_DEFAULTS[v.kind];
    const soft = () => round(within(v.soft, 0, 1, d.soft));
    if (v.kind === 'wipe') return { kind: 'wipe', angle: directionOf(v.angle, d.angle), soft: soft() };
    if (v.kind === 'iris') {
      return { kind: 'iris', shape: oneOf(v.shape, IRIS_SHAPES, d.shape), soft: soft(), reverse: bool(v.reverse) };
    }
    if (v.kind === 'clock') {
      return { kind: 'clock', start: directionOf(v.start, d.start), clockwise: v.clockwise !== false, soft: soft() };
    }
    if (v.kind === 'blinds') {
      return { kind: 'blinds', count: Math.round(within(v.count, 2, 64, d.count)), vertical: bool(v.vertical), soft: soft() };
    }
    if (v.kind === 'dissolve') return { kind: 'dissolve', rows: Math.round(within(v.rows, 2, 200, d.rows)), soft: soft() };
    if (v.kind === 'slide') {
      // One of the four sides: the nearest quarter turn.
      return { kind: 'slide', angle: (Math.round(directionOf(v.angle, d.angle) / 90) % 4) * 90 };
    }
    // Quarter turns, either way round, four whole ones at most.
    return { kind: 'zoom', turns: Math.round(within(v.turns, -4, 4, d.turns) * 4) / 4 };
  }

  /** A kind as it is before anything is set on it. */
  function transitionDefault(kind) {
    return transitionSettingsOf({ kind });
  }

  /** A layer's two transitions, each null for the plain fade. */
  function transitionsOf(layer) {
    return {
      in: transitionSettingsOf(layer && layer.fadeInTransition),
      out: transitionSettingsOf(layer && layer.fadeOutTransition),
    };
  }

  /** Whether a transition moves the picture, where the others only cut it. */
  function transitionMoves(transition) {
    return !!transition && (transition.kind === 'slide' || transition.kind === 'zoom');
  }

  /**
   * Whether a transition moves the old picture as well as the new one. Then
   * the earlier of two overlapping clips has to go through it too, even where
   * the later one would cover it: a slide pushes it out of the way.
   */
  function transitionMovesOld(transition) {
    return !!transition && transition.kind === 'slide';
  }

  /**
   * A layer's fade lengths as far as they fade its alpha: fadesOf, with an
   * end that has a transition counted as no fade at all, since the transition
   * is what happens there instead. What the preview and the encoder fade by.
   */
  function alphaFadesOf(layer) {
    const fades = fadesOf(layer);
    const tr = transitionsOf(layer);
    return { in: tr.in ? 0 : fades.in, out: tr.out ? 0 : fades.out };
  }

  /**
   * The transition a layer is going through at timeline second `t`, or null
   * for none: `{ half, transition, e }`, `half` being 'in' for its start and
   * 'out' for its end, and `e` how far it has got, 0 to 1, by the fade's own
   * curve. Only one can be running, since the two fades never overlap. At
   * the very end of its way in and before the start of its way out there is
   * none: the picture is simply there.
   */
  function transitionAt(layer, t) {
    const tr = transitionsOf(layer);
    if (!tr.in && !tr.out) return null;
    const span = Math.max(0, round(Number(layer.duration) || 0));
    if (!(span > 0)) return null;
    const fades = fadesOf(layer);
    const curves = fadeCurvesOf(layer);
    const into = clamp(round(t - (Number(layer.start) || 0)), 0, span);
    if (tr.in && fades.in > 0 && into < fades.in) {
      return { half: 'in', transition: tr.in, e: fadeShape(curves.in, into / fades.in) };
    }
    if (tr.out && fades.out > 0 && into > span - fades.out) {
      return { half: 'out', transition: tr.out, e: fadeShape(curves.out, (into - (span - fades.out)) / fades.out) };
    }
    return null;
  }

  // How many straight pieces a moving transition's way is cut into when its
  // curve is not a straight line. The preview and the encoder both go along
  // the same pieces, so this is how smooth the easing looks and never a
  // difference between the two.
  const TRANSITION_STEPS = 12;

  /**
   * The moments a layer's moving transitions are placed at, in the clip's own
   * seconds and in order: `[{ t, half, transition, e }]`, from each one's
   * start to its end. Two for a straight curve, which a straight blend
   * between them follows exactly, TRANSITION_STEPS pieces for any other.
   * Empty when neither end has a transition that moves the picture.
   */
  function transitionSteps(layer) {
    const tr = transitionsOf(layer);
    const fades = fadesOf(layer);
    const curves = fadeCurvesOf(layer);
    const span = Math.max(0, round(Number(layer && layer.duration) || 0));
    const out = [];
    const run = (half, transition, from, length, curve) => {
      if (!transitionMoves(transition) || !(length > 0)) return;
      const n = curve === 'linear' ? 1 : TRANSITION_STEPS;
      for (let i = 0; i <= n; i += 1) {
        out.push({ t: round(from + (length * i) / n), half, transition, e: fadeShape(curve, i / n) });
      }
    };
    run('in', tr.in, 0, fades.in, curves.in);
    run('out', tr.out, round(span - fades.out), fades.out, curves.out);
    return out;
  }

  /**
   * Set the transition of one end of a layer, null for the plain fade.
   *
   * For every picture in its group, as a fade's length and curve are. Where
   * that end is part of an overlap, the clip on the other side gets the same
   * one on its facing end, and the earlier clip's fade out is brought to what
   * the transition needs: the length of the overlap when it has to go through
   * it itself (a sound never does; a see-through picture always; any picture
   * when the transition moves the old one), and nothing when the later clip
   * simply covers it.
   *
   * Hands back the list it was given when nothing changed.
   */
  function setTransition(layers, id, which, transition) {
    const want = transitionSettingsOf(transition);
    const key = (end) => (end === 'out' ? 'fadeOutTransition' : 'fadeInTransition');
    const other = which === 'out' ? 'in' : 'out';
    const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    const put = (list, layerId, end) => replace(list, layerId, (l) => {
      if (l.type !== 'video' || same(transitionSettingsOf(l[key(end)]), want)) return l;
      return { ...l, [key(end)]: want };
    });
    let next = layers;
    for (const member of groupOf(layers, id)) {
      const cross = overlapOf(layers, member.id, which);
      next = put(next, member.id, which);
      if (!cross || member.type !== 'video') continue;
      next = put(next, which === 'out' ? cross.into : cross.from, other);
      const from = layerById(next, cross.from);
      const into = layerById(next, cross.into);
      const both = fadesOutUnder(from, into) || transitionMovesOld(want);
      next = setFade(next, cross.from, 'out', both ? cross.overlap : 0);
    }
    return next.every((l, i) => l === layers[i]) ? layers : next;
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
  //
  // V4.11. At the layer's speed: a second of the timeline is that many seconds
  // of the source. 1 for every layer that was never stretched, which is the
  // sum this always was.
  function sourceTimeFor(layer, t) {
    return round((t - layer.start) * speedOf(layer) + layer.sourceIn);
  }

  // ---- V4.11. Speed ----
  //
  // The user: "When holding ctrl before or while dragging a tracks edge it
  // doesnt cut/extend a tracks length, but shorten (speeds up) or extends
  // (slows down) playback of the track ... Playback speed should range from
  // min x0.1 to x10.0 max." And a right click on the speed shown in the
  // middle of the track "resets the playback speed and length to default".
  //
  // So a layer has a `speed`: how many seconds of its source go by in one
  // second of the timeline. 1 is every layer from before this, and a still's
  // always, since one picture has no clock. The part of the source a layer
  // shows is `duration * speed` long from `sourceIn`, and stretching a layer
  // keeps exactly that part and changes how long it takes: the edge that was
  // dragged moves, the other stays, and the speed is what makes the same
  // source fill the new length. sourceTimeFor above is the one place a moment
  // of the timeline becomes a moment of the source, for the preview and the
  // encoder alike.
  //
  // What is on the clip goes with what it shows: its keyframes, and the ones
  // of its VFX, keep their place in the picture, so a
  // clip made twice as long has them twice as far apart. Its fades are times
  // of the timeline and stay the length they were, held to the new clip.

  const SPEED_MIN = 0.1;
  const SPEED_MAX = 10;

  /**
   * A speed as the model keeps one: held to its range, 1 for anything else.
   * Not rounded the way a time is: it is the part of the source shown over
   * the length it is shown for, and rounded, that part would creep by a
   * microsecond every time the clip was stretched again.
   */
  function speedValue(v) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n) || !(n > 0)) return 1;
    return clamp(n, SPEED_MIN, SPEED_MAX);
  }

  /** How fast a layer's source plays: 1 for a still and for anything unset. */
  function speedOf(layer) {
    if (!layer || isStill(layer)) return 1;
    return speedValue(layer.speed);
  }

  // A layer and what is on it made `r` times as long about `anchor`, a second
  // of the timeline that stays where it is.
  function stretched(l, anchor, r) {
    const duration = round(l.duration * r);
    const next = {
      ...l,
      start: round(Math.max(0, anchor + (l.start - anchor) * r)),
      duration,
    };
    if (!isStill(l)) {
      // From the part of the source it shows, so that part stays the same
      // however often it is stretched.
      const shown = l.duration * speedOf(l);
      const speed = clamp(shown / duration, SPEED_MIN, SPEED_MAX);
      next.speed = Math.abs(speed - 1) < 1e-9 ? 1 : speed;
    }
    const keys = keyframesFor(l);
    if (keys.length) next.keyframes = keys.map((k) => ({ ...k, t: round(k.t * r) }));
    if (vfxList(l).some((v) => vfxKeysFor(v).length)) next.vfx = vfxKeysMoved(vfxList(l), (t) => t * r);
    next.fadeIn = round(Math.min(l.fadeIn || 0, duration));
    next.fadeOut = round(Math.min(l.fadeOut || 0, Math.max(0, duration - next.fadeIn)));
    return next;
  }

  /**
   * Drag one edge of a layer to `time` without cutting anything: the same
   * part of its source made to take the new length, faster or slower. Its
   * whole group goes with it by the same share, about the edge that stays, so
   * a picture and its sound stay together.
   *
   * Held where any of them would pass a tenth or ten times the speed, shrink
   * below a clip's least length, or start before the timeline does. A still
   * has no speed to change, so an edge of one is simply trimmed, as without
   * the key. Hands back the list it was given when nothing moves.
   */
  function stretchGroup(layers, id, edge, time) {
    const layer = layerById(layers, id);
    if (!layer) return layers;
    if (isStill(layer)) return trimGroup(layers, id, edge, time);
    const members = groupOf(layers, id);
    const anchor = edge === 'start' ? endOf(layer) : layer.start;
    const want = edge === 'start' ? anchor - time : time - anchor;
    let lo = 0;
    let hi = Infinity;
    for (const m of members) {
      lo = Math.max(lo, MIN_LAYER_SPAN / m.duration);
      if (!isStill(m)) {
        lo = Math.max(lo, speedOf(m) / SPEED_MAX);
        hi = Math.min(hi, speedOf(m) / SPEED_MIN);
      }
      // One that starts before the edge that stays must not be pushed off
      // the front of the timeline.
      const before = anchor - m.start;
      if (before > 0) hi = Math.min(hi, anchor / before);
    }
    if (lo > hi) return layers;
    const r = clamp(want / layer.duration, lo, hi);
    if (!Number.isFinite(r) || Math.abs(r - 1) < 1e-9) return layers;
    return layers.map((l) => (members.includes(l) ? stretched(l, anchor, r) : l));
  }

  /**
   * A layer back at its own speed: the part of its source it shows at the
   * length that part has, from where the layer starts. Every member of its
   * group that has a speed goes back to its own. The list it was given when
   * the layer already plays at 1.
   */
  function resetSpeed(layers, id) {
    const layer = layerById(layers, id);
    if (!layer || speedOf(layer) === 1) return layers;
    const members = groupOf(layers, id);
    const anchor = layer.start;
    return layers.map((l) => {
      if (!members.includes(l) || speedOf(l) === 1) return l;
      return { ...stretched(l, anchor, speedOf(l)), speed: 1 };
    });
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
  // V3.3, the user, 2026-11-03: "Fading out a text keeps the text at 100% alpha
  // ... until the transition runs out where the text plops out of existence".
  // Holding the one underneath opaque only works when the one on top covers
  // it, and a text, a shape, a bar or a transparent picture does not: the held
  // one shows through round the letters and vanishes at its end. So when
  // either of the two is see-through the earlier one fades out across the
  // overlap as well, the way sound does. Two videos keep the exact dissolve.
  //
  // The fades are written onto the layers rather than worked out whenever they
  // are read, so the preview, the export and the clip's own drawing all read
  // one number, and so a fade dragged by hand afterwards stays where it was put.

  /**
   * Whether a picture may be transparent, so that a clip under it shows
   * through: generated media always is round what it draws, and an image may
   * be unless its format has no alpha. A video is taken as opaque.
   */
  function seeThrough(layer) {
    if (!layer || layer.type !== 'video') return false;
    if (layer.kind === 'gen') return true;
    if (layer.kind !== 'image') return false;
    return !/\.(jpe?g|jfif|bmp)$/i.test(String(layer.src || ''));
  }

  /**
   * Whether the earlier clip of an overlapping pair fades out across it: a
   * sound always, a picture when either of the two is see-through.
   */
  function fadesOutUnder(earlier, later) {
    if (!earlier) return false;
    return earlier.type === 'audio' || seeThrough(earlier) || seeThrough(later);
  }

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
      // V4.10. Or a picture that went through a transition that moved it.
      const went = fadesOutUnder(layerById(next, a), layerById(next, b))
        || transitionMovesOld(transitionsOf(layerById(next, a)).out);
      if (went && fadeIs(a, 'fadeOut', o)) next = setFade(next, a, 'out', 0);
    }
    for (const [pair, o] of now) {
      if (was.get(pair) === o) continue;
      const [a, b] = pair.split('|');
      const into = layerById(next, b);
      // V4.10. The overlap is the later clip's way in: its curve and its
      // transition become the earlier clip's way out as well, so the two
      // halves are one movement, and a transition that moves the old picture
      // has the earlier clip go through it whatever it is.
      const transition = transitionsOf(into).in;
      const curve = fadeCurvesOf(into).in;
      const both = fadesOutUnder(layerById(next, a), into) || transitionMovesOld(transition);
      next = setFade(next, b, 'in', o);
      next = setFade(next, a, 'out', both ? o : 0);
      next = replace(next, a, (l) => {
        const own = l.type === 'video' ? transition : null;
        const sameCurve = curveId(l.fadeOutCurve) === curve;
        const sameTransition = JSON.stringify(transitionSettingsOf(l.fadeOutTransition)) === JSON.stringify(own);
        return sameCurve && sameTransition ? l : { ...l, fadeOutCurve: curve, fadeOutTransition: own };
      });
    }
    // The list it was given when nothing was written.
    return next.every((l, i) => l === after[i]) ? after : next;
  }

  // ---- V4.9. The overlap a fade is part of ----
  //
  // The user: "Let the programm see if tracks overlap in a layer (it already
  // does kinda, auto-applying a crossfade), when 2 tracks overlap, opening the
  // fade-curves of the end (fade-out) of trackA or start (fade-in) of trackB
  // shouldnt show the default grid for fading, but doubled (vertically mirrored
  // second line) like it will be when applying."
  //
  // So an overlap is something that can be asked for by either of its two
  // ends, and a curve chosen on either end is the transition's: the later
  // clip comes in by it and the earlier one goes out by the same curve the
  // other way up, which is the crossing pair the clip is drawn with.

  /**
   * The overlap one end of a layer is part of: `which` is 'in' for its
   * start, where it is the later of two overlapping clips on a row, and 'out'
   * for its end, where it is the earlier. Null when that end overlaps nothing,
   * or when the later clip's fade in is no longer the one the overlap wrote: a
   * fade dragged by hand since is somebody's own and is a plain fade again.
   *
   * `both` says whether the earlier clip fades out as well (a sound, or a
   * picture that is see-through), and `curve` is the curve the transition
   * runs by, the later clip's fade in.
   */
  function overlapOf(layers, id, which) {
    for (const [pair, o] of overlapsOf(layers)) {
      const [a, b] = pair.split('|');
      if ((which === 'out' ? a : b) !== id) continue;
      const from = layerById(layers, a);
      const into = layerById(layers, b);
      if (!from || !into) return null;
      if (Math.abs(fadesOf(into).in - o) > 1e-6) return null;
      return {
        from: a,
        into: b,
        overlap: o,
        both: fadesOutUnder(from, into) && Math.abs(fadesOf(from).out - o) <= 1e-6,
        curve: fadeCurvesOf(into).in,
        // V4.10. And the transition it runs through, null for the plain fade.
        transition: transitionsOf(into).in,
      };
    }
    return null;
  }

  /**
   * V4.9. Set the curve of one end of a layer's fade, for its whole group as
   * fadeCurveGroup does, and where that end is part of a transition for the
   * clip on the other side of it too: the later clip's fade in and the earlier
   * clip's fade out carry the same curve, so the two ramps mirror each other.
   * Without a transition it is fadeCurveGroup exactly.
   */
  function fadeCurveAcross(layers, id, which, curve) {
    const other = which === 'out' ? 'in' : 'out';
    let next = layers;
    for (const member of groupOf(layers, id)) {
      // Asked of the list as it was, so one member's change cannot hide
      // another's transition.
      const cross = overlapOf(layers, member.id, which);
      next = setFadeCurve(next, member.id, which, curve);
      if (!cross) continue;
      // The clip on the other side with its own group, so the choice comes
      // to the same thing whichever end of the transition it was made on.
      for (const partner of groupOf(layers, which === 'out' ? cross.into : cross.from)) {
        next = setFadeCurve(next, partner.id, other, curve);
      }
    }
    // The list it was given when every end already had the curve, so a caller
    // can tell that nothing moved and take no undo step for it.
    return next.every((l, i) => l === layers[i]) ? layers : next;
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

  /**
   * V3.4. A lane carried from `from` to `to` with everything on it, the lanes
   * between closing up behind it: the held and dragged row header. One step
   * of reorderLane at a time, so it keeps every rule the arrows keep. Hands
   * back the list it was given when it goes nowhere.
   */
  function moveLane(layers, type, from, to, rows) {
    if (from === to) return layers;
    const delta = to > from ? 1 : -1;
    let next = layers;
    for (let lane = from; lane !== to; lane += delta) {
      const step = reorderLane(next, type, lane, delta, rows);
      if (step === next) return lane === from ? layers : next;
      next = step;
    }
    return next;
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
          // V4.11. By as much of the source as that much of the timeline is.
          sourceIn: round(Math.max(0, l.sourceIn + shift * speedOf(l))),
          duration: round(l.duration - shift),
          // V3.3. Held where they are on the timeline while the start moves
          // under them, which on the clip's own clock is back by the shift.
          keyframes: shiftKeyframes(l, -shift),
          // V4.8. And the ones its VFX carry.
          ...shiftVfxKeys(l, -shift),
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

  // ---- V3.3. Keyframes ----
  //
  // The user, 2026-11-03: "each video track should have keyframes that can be
  // positioned along the track. Each keyframe should have its own
  // crop/scale/position setting." A keyframe is a moment of the clip and the
  // three things the crop popup sets: the crop, the Render Position rect and the
  // ring it is stuck to. Between two of them the picture moves smoothly, and
  // that is the only way it moves: "If the user want jumps they can put 2
  // keyframes very close to each other on the timeline."
  //
  // **A keyframe's time is the clip's own**, seconds from its start, so moving
  // the clip takes its keyframes along. Trimming the start edge moves the start
  // and not the keyframes, which is why trimLayer shifts them back by what it
  // moved: they stay where they are on the timeline. A trim that passes one does
  // not delete it, the user's rule: "If a trim is moving past a keyframe the
  // program should remember it (outside of the view) so the transition can
  // still go on." So a time below zero or past the duration is a keyframe out
  // of view, and still steers the part that shows.
  //
  // An empty list is today's layer, crop and render and anchor as they always
  // were, and that is what every project written before this opens with. Once
  // there are keyframes they are the whole of the placement and the layer's own
  // three fields are what the last one hands back when it is deleted.
  //
  // Video and image layers hold the crop popup's three; a generated one holds
  // what its settings window places, GEN_KEYED below. An audio layer never has
  // any, by the user's word: "audio doesnt need any".

  /** A rectangle, a copy of it, or null for anything that is not one. */
  function rectOf(v) {
    if (!v || typeof v !== 'object') return null;
    const r = {
      x: Number(v.x),
      y: Number(v.y),
      width: Number(v.width),
      height: Number(v.height),
    };
    return Object.values(r).every(Number.isFinite) && r.width > 0 && r.height > 0 ? r : null;
  }

  function newKeyframeId() {
    return 'k' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Whether this layer has keyframes at all, by what it is: every picture,
   * never a sound. Stage 2 of 3.3 added the generated ones, the user's "For
   * text and shapes media as well", and bars "to animate in/out".
   */
  function keyframable(layer) {
    return !!layer && layer.type === 'video';
  }

  // V3.3, stage 2. What a keyframe holds on a generated layer, by form: what
  // that form's settings window places and sizes. A text's box and rotation,
  // which is its Render Preview; a shape's box; a bar's thickness, span and
  // colour, the colour so a bar can fade in and out by its alpha. Everything
  // else, the words, the font, the outline, the shape's kind and the bar's
  // side, stays the layer's own and is the same at every moment. In pixels at
  // the layer's refHeight like the settings they stand for, so a Crop Render
  // Frame carries both the same way.
  // V3.5. A shape's soft edge too, a number that blends like its box. Its
  // other new settings, Invert, Outline Only and the ring's and star's
  // figures, are the layer's: a checkbox cannot be halfway on, and a star
  // cannot have five and a half points.
  // V3.6.2. A shape's turn and a square's rounded corners as well, numbers
  // that blend like the box.
  const GEN_KEYED = {
    text: ['box', 'rotation'],
    shape: ['box', 'soft', 'rotation', 'radius'],
    bar: ['thickness', 'span', 'color'],
  };

  function genKeyOf(v, form) {
    const src = v && typeof v === 'object' ? v : {};
    if (form === 'bar') {
      return {
        thickness: within(src.thickness, 1, 100000, 40),
        span: within(src.span, 0.01, 1, 1),
        color: colourOf(src.color, '#ffffffff'),
      };
    }
    if (form === 'shape') {
      return {
        box: boxOf(src.box),
        soft: within(src.soft, 0, 100000, 0),
        rotation: rotationOf(src.rotation),
        radius: within(src.radius, 0, 100000, 0),
      };
    }
    return { box: boxOf(src.box), rotation: rotationOf(src.rotation) };
  }

  /** The keyed settings a generated layer has now, as a keyframe holds them. */
  function keyedOfGen(gen) {
    const g = genOf(gen);
    return genKeyOf(g[g.form], g.form);
  }

  /** A generated layer's settings with a keyframe's keyed ones in place. */
  function withKeyed(gen, keyframe) {
    const g = genOf(gen);
    const own = {};
    for (const f of GEN_KEYED[g.form]) {
      if (keyframe && Object.prototype.hasOwnProperty.call(keyframe, f)) own[f] = keyframe[f];
    }
    return genOf({ ...g, [g.form]: { ...g[g.form], ...own } });
  }

  /**
   * One keyframe as a file or a caller may hand it over, held to the shape its
   * layer's keyframes have. Null for one without a usable time.
   */
  function keyframeOf(v, layer) {
    if (!v || typeof v !== 'object') return null;
    const t = Number(v.t);
    if (!Number.isFinite(t)) return null;
    const base = { id: typeof v.id === 'string' && v.id ? v.id : newKeyframeId(), t: round(t) };
    if (layer && layer.kind === 'gen') {
      return { ...base, ...genKeyOf(v, genOf(layer.gen).form) };
    }
    return {
      ...base,
      crop: rectOf(v.crop),
      render: rectOf(v.render),
      anchor: typeof v.anchor === 'string' && v.anchor ? v.anchor : null,
      // V3.4. The turn at that moment.
      rotation: rotationOf(v.rotation),
      // V3.6. The mask's box and soft edge at that moment, or null for the
      // layer's own.
      mask: maskKeyOf(v.mask),
    };
  }

  /**
   * A layer's keyframes, in time order, one to a moment and one to an id. Two at
   * the same time would leave the picture two answers for that moment, so the
   * later in the list wins, which is the one a caller has just put there.
   */
  function keyframesOf(list, layer) {
    if (!Array.isArray(list) || !keyframable(layer)) return [];
    const byTime = new Map();
    const ids = new Set();
    for (const raw of list) {
      const k = keyframeOf(raw, layer);
      if (!k) continue;
      if (ids.has(k.id)) k.id = newKeyframeId();
      ids.add(k.id);
      byTime.set(k.t, k);
    }
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }

  function keyframesFor(layer) {
    return layer && Array.isArray(layer.keyframes) ? layer.keyframes : [];
  }

  /**
   * The keyframe on the clip at `t`, its own seconds, within `reach` either
   * side. The nearest when there are several, null when none is that close.
   */
  function keyframeNear(layer, t, reach = 0) {
    let best = null;
    for (const k of keyframesFor(layer)) {
      const d = Math.abs(k.t - t);
      if (d <= reach && (!best || d < Math.abs(best.t - t))) best = k;
    }
    return best;
  }

  /**
   * Puts a keyframe on a layer, a new one or a changed one by its id. One that
   * was at the same moment already gives way to it.
   */
  function putKeyframe(layers, id, keyframe) {
    return replace(layers, id, (l) => {
      if (!keyframable(l)) return l;
      const k = keyframeOf(keyframe, l);
      if (!k) return l;
      const rest = keyframesFor(l).filter((o) => o.id !== k.id && o.t !== k.t);
      return { ...l, keyframes: keyframesOf([...rest, k], l) };
    });
  }

  /**
   * Takes a keyframe off. One keyframe alone moves nothing, so when a delete
   * leaves one, it goes too and what it held becomes the whole clip's: the
   * user, "if the second-to-last keyframe gets deleted, the first should also
   * be removed and the crop/position/etc of the first keyframe should be
   * applied to all of the track". The first, whichever of the two was
   * deleted, even when it is the first itself: "the track shouldnt start with
   * the settings of the modified 2nd keyframe". The first is the clip as it was
   * before anything was keyed, which is what it goes back to. The last one
   * deleted on its own leaves itself, so the picture never jumps back to
   * whatever the layer held before it had any.
   */
  function removeKeyframe(layers, id, keyId) {
    return replace(layers, id, (l) => {
      const list = keyframesFor(l);
      const gone = list.find((k) => k.id === keyId);
      if (!gone) return l;
      // The first deleted while two or more stay after it: the start keeps a
      // keyframe, taking the second's settings, and the second stays where it
      // is. The user: "If #1 gets deleted #2 settings will become the new #1
      // keyframe settings but #2 stays where it is."
      if (gone === list[0] && list.length > 2) {
        const { id: _id, t: _t, ...settings } = list[1];
        return { ...l, keyframes: list.map((k) => (k === gone ? { ...k, ...settings } : k)) };
      }
      const keyframes = list.filter((k) => k !== gone);
      if (keyframes.length > 1) return { ...l, keyframes };
      const keep = list[0];
      if (l.kind === 'gen') return { ...l, keyframes: [], gen: withKeyed(l.gen, keep) };
      return {
        ...l,
        keyframes: [],
        crop: keep.crop,
        render: keep.render,
        anchor: keep.anchor,
        rotation: keep.rotation || 0,
        // V3.6. The first keyframe's mask too, when it held one of its own.
        mask: l.mask && keep.mask ? maskOf({ ...l.mask, ...keep.mask }) : l.mask,
      };
    });
  }

  /**
   * A keyframe dragged along its clip. It stays on the part of the clip that is
   * showing, since that is where it can be seen and grabbed, and it does not
   * land on another one's moment: it stops a millisecond short instead, which
   * is the closest two may be and still be two.
   */
  function moveKeyframe(layers, id, keyId, t) {
    return replace(layers, id, (l) => {
      const list = keyframesFor(l);
      const k = list.find((o) => o.id === keyId);
      if (!k) return l;
      let at = clamp(round(Number(t)), 0, round(l.duration));
      const taken = (v) => list.some((o) => o !== k && Math.abs(o.t - v) < 0.0005);
      if (taken(at)) at = round(at + (at >= k.t ? -0.001 : 0.001));
      if (taken(at)) return l;
      return { ...l, keyframes: keyframesOf(list.map((o) => (o === k ? { ...o, t: at } : o)), l) };
    });
  }

  /**
   * Keyed settings measured at one refHeight, measured at another: the boxes
   * and a bar's thickness are pixels and scale, a span, a turn and a colour do
   * not.
   */
  function keyedAt(keyed, k) {
    const out = { ...keyed };
    if (out.box) out.box = { x: out.box.x * k, y: out.box.y * k, w: out.box.w * k, h: out.box.h * k };
    if (Number.isFinite(out.thickness)) out.thickness = out.thickness * k;
    if (Number.isFinite(out.soft)) out.soft = out.soft * k;
    if (Number.isFinite(out.radius)) out.radius = out.radius * k;
    return out;
  }

  /**
   * A generated layer's keyframes measured at `refHeight` instead of the
   * layer's own. A settings window hands its Accept back at the project's
   * height, which need not be the height the keyframes were set at, and a
   * keyframe read at the wrong one is a bar the wrong thickness.
   */
  function keyframesAtRef(layer, refHeight) {
    const from = genOf(layer.gen).refHeight;
    const k = refHeight / from;
    if (k === 1) return keyframesFor(layer);
    return keyframesFor(layer).map((kf) => ({ ...kf, ...keyedAt(kf, k) }));
  }

  /**
   * A generated layer's keyframes carried through a Crop Render Frame change
   * the way reframeGen carries its settings, each as the picture it stands for,
   * so every stop of a move is pinned where it was. Hands back the layer.
   */
  function reframeKeyed(layer, fromHeight, toHeight, k, dx, dy) {
    if (!layer || layer.kind !== 'gen') return layer;
    const gen = reframeGen(layer.gen, fromHeight, toHeight, k, dx, dy);
    const keyframes = keyframesFor(layer).map((kf) => ({
      ...kf,
      ...keyedOfGen(reframeGen(withKeyed(layer.gen, kf), fromHeight, toHeight, k, dx, dy)),
    }));
    return { ...layer, gen, keyframes };
  }

  // ---- V3.6. A mask between keyframes ----

  /** The box, soft edge and corners a keyframe stands for: its own, or the layer's. */
  function maskKeyAt(layer, k) {
    return (k && k.mask) || { box: layer.mask.box, soft: layer.mask.soft, radius: layer.mask.radius || 0 };
  }

  /**
   * A layer's mask at `t`, the clip's own seconds: its settings with the box
   * and the soft edge blended between the keyframes either side, the way the
   * placement is. Null when the layer has no mask. Before the first keyframe
   * it is the first's and after the last the last's, so a trimmed-off one
   * still steers it.
   */
  function maskAt(layer, t) {
    if (!layer || !layer.mask) return null;
    const list = keyframesFor(layer);
    if (!list.some((k) => k.mask)) return layer.mask;
    const at = Number.isFinite(Number(t)) ? Number(t) : 0;
    const put = (key) => ({ ...layer.mask, box: { ...key.box }, soft: key.soft, radius: key.radius || 0 });
    if (at <= list[0].t) return put(maskKeyAt(layer, list[0]));
    const last = list[list.length - 1];
    if (at >= last.t) return put(maskKeyAt(layer, last));
    let i = 0;
    while (list[i + 1].t <= at) i += 1;
    const a = maskKeyAt(layer, list[i]);
    const b = maskKeyAt(layer, list[i + 1]);
    const u = (at - list[i].t) / (list[i + 1].t - list[i].t);
    const lerp = (p, q) => p + (q - p) * u;
    return put({
      box: { x: lerp(a.box.x, b.box.x), y: lerp(a.box.y, b.box.y), w: lerp(a.box.w, b.box.w), h: lerp(a.box.h, b.box.h) },
      soft: lerp(a.soft, b.soft),
      radius: lerp(a.radius || 0, b.radius || 0),
    });
  }

  /**
   * The stretch of the clip over which its mask changes, in its own seconds,
   * or null when it never does. Its placement moving is not this: the mask
   * sticks to the picture, so a mask that holds still on a moving picture is
   * still one mask.
   */
  function maskMotion(layer) {
    if (!layer || !layer.mask) return null;
    const list = keyframesFor(layer);
    if (list.length < 2) return null;
    const first = JSON.stringify(maskKeyAt(layer, list[0]));
    if (list.every((k) => JSON.stringify(maskKeyAt(layer, k)) === first)) return null;
    const from = Math.max(0, list[0].t);
    const to = Math.min(layer.duration, list[list.length - 1].t);
    return to > from ? { from, to } : null;
  }

  /** A new mask on a layer, its keyframes' own masks left as they are. */
  function setMask(layers, id, mask) {
    return replace(layers, id, (l) => (l.kind === 'gen' || l.type !== 'video' ? l : { ...l, mask: maskOf(mask) }));
  }

  /** The mask taken off a layer, and off every one of its keyframes. */
  function removeMask(layers, id) {
    return replace(layers, id, (l) => ({
      ...l,
      mask: null,
      keyframes: keyframesFor(l).map((k) => (k.mask ? { ...k, mask: null } : k)),
    }));
  }

  /** Every keyframe of a layer moved by `dt` of its own seconds. */
  function shiftKeyframes(layer, dt) {
    const list = keyframesFor(layer);
    if (!list.length || !dt) return list;
    return list.map((k) => ({ ...k, t: round(k.t + dt) }));
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
   * pinned like a video, so the box moves with the picture, and so is a shape.
   * A text with no box is laid out in the whole frame, a shape with none sits
   * in the middle and a bar sticks to its side, and all of those follow the
   * new frame.
   *
   * refHeight is a whole number, so the size can be off by the rounding of
   * that, well under a pixel; the box is worked out from the rounded height, so
   * it lands exactly.
   */
  function reframeGen(gen, fromHeight, toHeight, k, dx, dy) {
    const g = genOf(gen);
    const oldScale = fromHeight / g.refHeight;
    const refHeight = Math.max(1, Math.round(toHeight / (oldScale * k)));
    const own = g.form === 'text' || g.form === 'shape' ? g[g.form] : null;
    if (!own || !own.box) return genOf({ ...g, refHeight });
    const scale = toHeight / refHeight;
    const b = own.box;
    const at = (v, off) => round((off + v * oldScale * k) / scale);
    const box = { x: at(b.x, dx), y: at(b.y, dy), w: at(b.w, 0), h: at(b.h, 0) };
    return genOf({ ...g, refHeight, [g.form]: { ...own, box } });
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

  /**
   * V3.8.1. Set the shape of one of a layer's fades.
   *
   * The same layer object back when it already has that curve, as setAlpha
   * does, so a caller can tell nothing moved. A fade of no length keeps the curve
   * it is given: it applies the moment the fade is dragged out.
   */
  function setFadeCurve(layers, id, which, curve) {
    const key = which === 'out' ? 'fadeOutCurve' : 'fadeInCurve';
    const want = curveId(curve);
    return replace(layers, id, (l) => (curveId(l[key]) === want && l[key] === want ? l : { ...l, [key]: want }));
  }

  /** The same, for a whole group, as fadeGroup is for the length. */
  function fadeCurveGroup(layers, id, which, curve) {
    const members = groupOf(layers, id);
    if (members.length < 2) return setFadeCurve(layers, id, which, curve);
    let next = layers;
    for (const member of members) next = setFadeCurve(next, member.id, which, curve);
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
      // V3.8.1. The cut end is not a fade and does not keep a curve either, or
      // a fade dragged out there later would come out in a shape nobody chose.
      fadeOutCurve: 'linear',
      // V4.10. Nor a transition, for the same reason.
      fadeOutTransition: null,
    };
    const right = {
      ...layer,
      id: newId(),
      start: round(at),
      duration: rest,
      sourceIn: isStill(layer) ? layer.sourceIn : round(layer.sourceIn + kept * speedOf(layer)),
      fadeIn: 0,
      fadeInCurve: 'linear',
      fadeInTransition: null,
      fadeOut: round(Math.min(layer.fadeOut || 0, rest)),
      groupId,
      // V3.3. Both halves keep every keyframe, the right one on its own clock,
      // so a movement that ran across the cut runs on across it. The ones each
      // half cannot show are out of view and still steer it, the same as after
      // a trim.
      keyframes: shiftKeyframes(layer, -kept),
      // V4.8. The same for the keyframes of its VFX.
      ...shiftVfxKeys(layer, -kept),
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
    // V4.3. A piece of a join cut in two: the halves from the cut on are not
    // the same clip as the ones before it any more.
    if (target.joinId) {
      const fresh2 = newJoinId();
      return arrangeLanes(normalizeJoins(next.map((l) => (l.joinId === target.joinId && l.start >= cut - JOIN_EPS
        ? { ...l, joinId: fresh2 }
        : l))));
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
    // V4.3. And the join, every piece of it with its group.
    return { primary: target.id, items: linkedOf(layers, id).map((l) => ({ ...l })) };
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
    // V4.3. A new id for each group and each join that was copied, so the
    // paste is linked the way the copy was and to nothing on the timeline. A
    // copy from before joins was one group of everything in it.
    const linked = clip.items.some((l) => l.joinId)
      || new Set(clip.items.map((l) => l.groupId).filter(Boolean)).size > 1;
    const oneGroup = !linked && clip.items.length > 1 ? newGroupId() : null;
    const groups = new Map();
    const joins = new Map();
    const fresh = (map, key, make) => {
      if (!key) return null;
      if (!map.has(key)) map.set(key, make());
      return map.get(key);
    };
    let primaryLane = null;
    let next = arrangeLanes(layers);
    // The copied layer first, so its lane is settled before anything else of
    // its kind asks for a new one.
    const order = [primary, ...clip.items.filter((l) => l !== primary)];
    for (const item of order) {
      // A piece of the copied clip's own join goes on the row it went on.
      const samePiece = item !== primary && primary.joinId && item.joinId === primary.joinId;
      const want = item === primary ? laneValue(lane) : (samePiece ? primaryLane : laneValue(item.lane));
      const onto = want !== null ? want : laneCount(next, item.type);
      if (item === primary) primaryLane = onto;
      next = arrangeLanes([...next, {
        ...item,
        id: newId(),
        start: round(Math.max(0, when + (item.start - primary.start))),
        lane: onto,
        groupId: oneGroup || fresh(groups, item.groupId, newGroupId),
        joinId: fresh(joins, item.joinId, newJoinId),
      }]);
    }
    return normalizeJoins(next);
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
    // V4.3. And the join it is a piece of, with every piece's group.
    const members = linkedOf(layers, id);
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

  /**
   * V3.8.2. Slide several layers at once, and the groups they are in, by the
   * shift that puts `id` at `newStart`. One shift for all of them, clamped
   * by the earliest, so none is cut off at the start of the timeline while the
   * others carry on.
   */
  function moveSet(layers, ids, id, newStart) {
    const layer = layerById(layers, id);
    if (!layer) return layers;
    const moving = new Set();
    for (const one of ids) {
      // V4.3. A join moves whole, with its pieces' groups.
      for (const m of linkedOf(layers, one)) moving.add(m.id);
    }
    moving.add(id);
    if (moving.size < 2) return moveLayer(layers, id, newStart);
    const earliest = Math.min(...layers.filter((l) => moving.has(l.id)).map((l) => l.start));
    const shift = Math.max(round(newStart - layer.start), -earliest);
    return layers.map((l) => (moving.has(l.id)
      ? { ...l, start: round(Math.max(0, l.start + shift)) }
      : l));
  }

  /**
   * V3.8.2. The whole timeline slid left so that `point` becomes 0, when
   * nothing starts before it: every layer's start less `point`. Layers are
   * handed back unchanged when something does start earlier (it would be cut
   * off), or when `point` is no later than 0.
   */
  function shiftToZero(layers, point) {
    const by = round(point);
    if (!layers.length || by <= 0) return layers;
    if (layers.some((l) => l.start < by - 1e-6)) return layers;
    return layers.map((l) => ({ ...l, start: round(Math.max(0, l.start - by)) }));
  }

  /**
   * V3.8.4. Another project's layers put under this one's, the user's "adds
   * the layers below the existing ones": each kind's rows go below the rows of
   * that kind already there, `rows` ({ video, audio }, empty rows counted,
   * 0 for a kind with none). Every layer and every group gets a new id, so a
   * project merged into itself, or into a copy of itself, never shares one
   * with what is open; a group stays a group, among its own. Everything else
   * the clips were saved with is kept, keyframe ids included, which are the
   * layer's own. Hands back the list and the old id to new id map.
   */
  function mergeLayers(layers, incoming, rows = {}) {
    const theirs = arrangeLanes((incoming || []).slice());
    const used = new Set(layers.map((l) => l.id));
    const usedGroups = new Set(layers.map((l) => l.groupId).filter(Boolean));
    const fresh = (make, taken) => {
      let id = make();
      while (taken.has(id)) id = make();
      taken.add(id);
      return id;
    };
    const ids = new Map();
    const groups = new Map();
    // V4.3. And each join a new id, among its own.
    const joins = new Map();
    const usedJoins = new Set(layers.map((l) => l.joinId).filter(Boolean));
    const below = {
      video: Math.max(0, Math.floor(Number(rows.video) || 0)),
      audio: Math.max(0, Math.floor(Number(rows.audio) || 0)),
    };
    const added = theirs.map((l) => {
      const id = fresh(newId, used);
      ids.set(l.id, id);
      let groupId = null;
      if (l.groupId) {
        if (!groups.has(l.groupId)) groups.set(l.groupId, fresh(newGroupId, usedGroups));
        groupId = groups.get(l.groupId);
      }
      let joinId = null;
      if (l.joinId) {
        if (!joins.has(l.joinId)) joins.set(l.joinId, fresh(newJoinId, usedJoins));
        joinId = joins.get(l.joinId);
      }
      return { ...l, id, groupId, joinId, lane: below[l.type === 'audio' ? 'audio' : 'video'] + l.lane };
    });
    return { layers: arrangeLanes([...layers, ...added]), ids };
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

  // ---- V4.3. Joining ----
  //
  // The user: "Join selected tracks - J (This will combine end of track N with
  // start of track N+1, only in the same layer. If selected tracks are not in
  // the same layer raise a hint)", and asked whether pieces of different
  // sources may join: "Joining different sources cut/split clips should be
  // possible. In the background they can still be treated like different
  // sources, but marked as joined ... They should just show as one track in
  // the editor after joining. They can also keep a "flag" joined. When
  // rightclicking such a track the menu could show ... "Un-join tracks"".
  //
  // So a joined clip is still its pieces, each a layer with its own source,
  // crop, mask, keyframes and volume, and each carrying the same `joinId`. The
  // pieces of one join are on one row and end to end: each starts where the
  // one before it ends, which is what joining does to them (it closes the
  // gap). They move together, the seams are hard cuts with no fade, and only
  // the two outer edges trim and fade. normalizeJoins is what holds that true:
  // a join whose pieces stopped meeting is broken where they stopped.

  // Two ends this close are one seam. Positions are rounded to a microsecond,
  // so this is only there for what a frame step can add on top of that.
  const JOIN_EPS = 1e-4;

  function newJoinId() {
    return 'j' + Math.random().toString(36).slice(2, 10);
  }

  /** The pieces of the join `id` is in, by start; just the layer when none. */
  function joinOf(layers, id) {
    const layer = layerById(layers, id);
    if (!layer) return [];
    if (!layer.joinId) return [layer];
    return layers.filter((l) => l.joinId === layer.joinId).sort((a, b) => a.start - b.start);
  }

  /** Where in its join a layer is: 'first', 'mid', 'last', or null for none. */
  function joinPlace(layers, layer) {
    if (!layer || !layer.joinId) return null;
    const chain = joinOf(layers, layer.id);
    if (chain.length < 2) return null;
    const at = chain.findIndex((l) => l.id === layer.id);
    if (at === 0) return 'first';
    return at === chain.length - 1 ? 'last' : 'mid';
  }

  /**
   * Everything that moves when `id` moves: its join and its group, and theirs
   * in turn, so a joined picture brings each piece's sound and a grouped sound
   * brings the whole joined picture.
   */
  function linkedOf(layers, id) {
    const start = layerById(layers, id);
    if (!start) return [];
    const seen = new Set([start.id]);
    const queue = [start];
    while (queue.length) {
      const l = queue.shift();
      const near = [];
      if (l.joinId) near.push(...layers.filter((o) => o.joinId === l.joinId));
      if (l.groupId) near.push(...layers.filter((o) => o.groupId === l.groupId));
      for (const o of near) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        queue.push(o);
      }
    }
    return layers.filter((l) => seen.has(l.id));
  }

  /** Whether a layer can be a piece of a join: a file's picture or sound. */
  function joinableKind(layer) {
    return !!layer && layer.kind !== 'gen';
  }

  /**
   * Whether the layers `ids` (and the joins they are already in) can be joined,
   * and the pieces in order when they can: { ok, pieces } or { ok: false,
   * reason }. Reasons: 'few' (fewer than two clips), 'kind' (a text, shape or
   * bar), 'rows' (not all on one row), 'between' (another clip on the row
   * sits between two of them).
   */
  function joinCheck(layers, ids) {
    const chosen = new Map();
    for (const id of ids || []) {
      for (const l of joinOf(layers, id)) chosen.set(l.id, l);
    }
    const pieces = [...chosen.values()].sort((a, b) => a.start - b.start);
    if (pieces.length < 2) return { ok: false, reason: 'few' };
    if (pieces.some((l) => !joinableKind(l))) return { ok: false, reason: 'kind' };
    const first = pieces[0];
    if (pieces.some((l) => l.type !== first.type || laneValue(l.lane) !== laneValue(first.lane))) {
      return { ok: false, reason: 'rows' };
    }
    if (new Set(pieces.map((l) => l.joinId || l.id)).size < 2) return { ok: false, reason: 'few' };
    const others = layers.filter((l) => !chosen.has(l.id)
      && l.type === first.type && laneValue(l.lane) === laneValue(first.lane));
    for (let i = 1; i < pieces.length; i += 1) {
      const from = pieces[i - 1].start;
      const to = pieces[i].start;
      if (others.some((o) => o.start > from + JOIN_EPS && o.start < to - JOIN_EPS)) {
        return { ok: false, reason: 'between' };
      }
    }
    return { ok: true, pieces };
  }

  /**
   * The chosen clips joined into one: each piece after the first slid to start
   * where the one before it ends, its group's other members slid by the same
   * amount so a sound stays under its picture, and the fades at every seam
   * taken off, since a seam is a cut. The first piece's join id is kept when
   * it had one. Hands back the list it was given when they cannot be joined.
   */
  function join(layers, ids) {
    const check = joinCheck(layers, ids);
    if (!check.ok) return layers;
    const joinId = check.pieces[0].joinId || newJoinId();
    const pieceIds = check.pieces.map((l) => l.id);
    const isPiece = new Set(pieceIds);
    let next = layers;
    for (let i = 1; i < pieceIds.length; i += 1) {
      const before = layerById(next, pieceIds[i - 1]);
      const piece = layerById(next, pieceIds[i]);
      const shift = round(endOf(before) - piece.start);
      if (!shift) continue;
      const moving = new Set([piece.id]);
      if (piece.groupId) {
        for (const m of next) if (m.groupId === piece.groupId && !isPiece.has(m.id)) moving.add(m.id);
      }
      next = next.map((l) => (moving.has(l.id)
        ? { ...l, start: round(Math.max(0, l.start + shift)) }
        : l));
    }
    next = next.map((l) => {
      if (!isPiece.has(l.id)) return l;
      const at = pieceIds.indexOf(l.id);
      const out = { ...l, joinId };
      // V4.10. A seam is a cut, so it has no transition either.
      if (at > 0) {
        out.fadeIn = 0;
        out.fadeInCurve = 'linear';
        out.fadeInTransition = null;
      }
      if (at < pieceIds.length - 1) {
        out.fadeOut = 0;
        out.fadeOutCurve = 'linear';
        out.fadeOutTransition = null;
      }
      return out;
    });
    return arrangeLanes(next);
  }

  /** The join `joinId` taken apart. The pieces stay exactly where they are. */
  function unjoin(layers, joinId) {
    if (!joinId) return layers;
    return layers.map((l) => (l.joinId === joinId ? { ...l, joinId: null } : l));
  }

  /**
   * Every join made true again: its pieces split into runs that are on one
   * row and end to end, the first run keeping the id and every later one a
   * new id, and a run of one piece no join at all. What breaks a join is
   * anything that took one piece away from the others: a piece deleted from
   * the middle, an undo that put one back somewhere else, a file edited by
   * hand. Hands back the list it was given when every join already holds.
   */
  function normalizeJoins(layers) {
    const byJoin = new Map();
    for (const l of layers) {
      if (!l.joinId) continue;
      if (!byJoin.has(l.joinId)) byJoin.set(l.joinId, []);
      byJoin.get(l.joinId).push(l);
    }
    if (!byJoin.size) return layers;
    const fix = new Map();
    for (const [joinId, members] of byJoin) {
      const pieces = members.slice().sort((a, b) => a.start - b.start);
      const runs = [[pieces[0]]];
      for (let i = 1; i < pieces.length; i += 1) {
        const run = runs[runs.length - 1];
        const last = run[run.length - 1];
        const meets = pieces[i].type === last.type
          && laneValue(pieces[i].lane) === laneValue(last.lane)
          && joinableKind(pieces[i])
          && Math.abs(pieces[i].start - endOf(last)) <= JOIN_EPS;
        if (meets) run.push(pieces[i]);
        else runs.push([pieces[i]]);
      }
      runs.forEach((run, i) => {
        const id = run.length < 2 ? null : (i === 0 ? joinId : newJoinId());
        for (const l of run) if (l.joinId !== id) fix.set(l.id, id);
      });
    }
    if (!fix.size) return layers;
    return layers.map((l) => (fix.has(l.id) ? { ...l, joinId: fix.get(l.id) } : l));
  }

  /**
   * A joined clip cut at `at`: at a seam it simply comes apart there, and
   * inside a piece that piece is split (with its group, as splitLayer does)
   * and the pieces from the cut on become a join of their own. Not joined, it
   * is splitLayer. Hands back the list it was given when nothing is cut.
   */
  function splitJoinAt(layers, id, at) {
    const chain = joinOf(layers, id);
    const cut = round(Number(at));
    if (chain.length < 2 || !Number.isFinite(cut)) return splitLayer(layers, id, at);
    const seam = chain.slice(1).find((l) => Math.abs(l.start - cut) <= JOIN_EPS);
    let next = layers;
    if (!seam) {
      const piece = chain.find((l) => l.start < cut && endOf(l) > cut);
      if (!piece) return layers;
      next = splitLayer(layers, piece.id, cut);
      if (next === layers) return layers;
    }
    const fresh = newJoinId();
    const joinId = chain[0].joinId;
    next = next.map((l) => (l.joinId === joinId && l.start >= cut - JOIN_EPS
      ? { ...l, joinId: fresh }
      : l));
    return normalizeJoins(next);
  }

  return {
    MIN_LAYER_SPAN,
    createLayer,
    endOf,
    sourceRemaining,
    sourceBefore,
    // V4.11.
    SPEED_MIN,
    SPEED_MAX,
    speedOf,
    stretchGroup,
    resetSpeed,
    covers,
    IMAGE_SECONDS,
    isStill,
    GEN_FORMS,
    GEN_REF_HEIGHT,
    GEN_EFFECT_MAX,
    GEN_FONT_MAX,
    RUN_FIELDS,
    SHAPE_KINDS,
    SHAPE_FILLS,
    GRADIENT_STOPS_MAX,
    maskGradientOf,
    gradientOf,
    // V4.6.
    textGradientOf,
    gradientKey,
    DEFAULT_FONT,
    colourOf,
    genOf,
    setGen,
    reframeGen,
    fadesOf,
    fadeAlphaAt,
    FADE_CURVE_IDS,
    fadeShape,
    fadeCurveExpr,
    fadeCurvesOf,
    setFadeCurve,
    fadeCurveGroup,
    // V4.10.
    TRANSITION_KINDS,
    IRIS_SHAPES,
    TRANSITION_STEPS,
    transitionSettingsOf,
    transitionDefault,
    transitionsOf,
    transitionMoves,
    transitionMovesOld,
    alphaFadesOf,
    transitionAt,
    transitionSteps,
    setTransition,
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
    moveSet,
    mergeLayers,
    shiftToZero,
    reorderLayer,
    arrangeLanes,
    readingOrder,
    lanesOf,
    overlapsOf,
    crossfade,
    // V4.9.
    overlapOf,
    fadeCurveAcross,
    moveLane,
    seeThrough,
    fadesOutUnder,
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
    keyframable,
    GEN_KEYED,
    keyedOfGen,
    withKeyed,
    reframeKeyed,
    keyedAt,
    keyframesAtRef,
    keyframesOf,
    keyframesFor,
    keyframeNear,
    putKeyframe,
    removeKeyframe,
    moveKeyframe,
    MASK_KINDS,
    maskOf,
    maskAt,
    // V4.7.
    VFX_KINDS,
    VFX_KIND_IDS,
    VFX_GROUPS,
    VFX_CURVE_CHANNELS,
    VFX_CURVE_POINTS,
    vfxCurveOf,
    vfxCurveFlat,
    VFX_TWO_SHAPES,
    vfxGivesAlpha,
    vfxWorked,
    VFX_PALETTES,
    VFX_LOOKS,
    VFX_EDGE_STYLES,
    VFX_FLIP_MODES,
    VFX_CHANNEL_ORDERS,
    vfxCoversAll,
    vfxMovesAlone,
    VFX_NOTE_FROM,
    VFX_NOTE_SAME,
    vfxKind,
    vfxKeyedIds,
    vfxOf,
    vfxListOf,
    vfxList,
    vfxKeysFor,
    vfxNumber,
    vfxNoteDue,
    vfxValuesAt,
    vfxAt,
    vfxEverOn,
    vfxMoves,
    vfxMotion,
    vfxRuns,
    vfxKeyNear,
    putVfxKey,
    removeVfxKey,
    moveVfxKey,
    shiftVfxKeys,
    newVfxId,
    obscureSigma,
    pixelateBlock,
    maskMotion,
    setMask,
    removeMask,
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
    JOIN_EPS,
    newJoinId,
    joinOf,
    joinPlace,
    linkedOf,
    joinCheck,
    join,
    unjoin,
    normalizeJoins,
    splitJoinAt,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = timelineModel;
