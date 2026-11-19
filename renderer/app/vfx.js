'use strict';

// V5.0. VFX: the window a track's VFX button and its right click open.
//
// The user, 2026-11-17: Obscure and Pixelate (V4.7, V4.8) become "VFX" in a
// window of their own, "Editing VFX for [track X]", "with more VFX to come
// later", and "the vfx window must be suitable for many other vfx
// shaders/adjustments later on, dont only bake it for the 2 existing ones".
// So nothing here is written for a kind: what a kind is called is its row of
// VFX_UI below, what settings it has is its row of timeline.js VFX_KINDS, and
// the menu, the settings and the keyframes are made from those.
//
// Three parts, the user's layout. Left, a quarter of the window: every VFX
// there is, under a search, added to the end of the track's by its + or a
// double click; since V5.1.1 a single click previews one with its defaults,
// added only by Add. Centre, half: the track's VFX as buttons in the order
// they are processed, an arrow between each two, clicked to choose the one
// edited, dragged to change the order, each with a red X that takes it off;
// the line "Editing [name] (number)" or "Previewing [name]" and Add, what
// the kind does, and the settings that are the same the whole clip long; the
// track's whole picture at the playhead with every VFX on it; and the chosen
// VFX's keyframes. Right, a quarter: the settings a keyframe holds.
//
// The settings are of two sorts, the user's rule for this and every later
// VFX: the ones that cannot blend between keyframes are the VFX's own and
// come first, "slightly greenish (like 222, 255, 222)", then "a divider
// line", then the ones a keyframe holds, in white. Since V5.1.1 the first
// are in the centre and the others on the right, the column between them the
// line. A VFX without keyframes
// is the same the whole clip long, and all its settings are simply its own.
// Once it has one, a change to its area or to a white setting is made at the
// playhead: to the keyframe there, or to a new one made there.
//
// One area a VFX ("Only one box/area per vfx"), a shape in a box on the
// picture, dragged, sized and turned like a shape in Shape Settings. The
// chosen VFX's has the grips, the others' are outlines to click.
//
// V5.1.3. Not every kind has one (timeline.js `where`): a kind for the whole
// picture has nothing on the picture to place, a kind with a box and no
// choice of shape has no Shape row, and a kind's Shape row has only the
// shapes the kind offers. V5.1.4: a kind about a point has a crosshair on
// the picture to drag instead of a box, and the point as two figures.
//
// The draft is the whole list, in the picture's own whole pixels, and what
// the layer keeps is in fractions of it (timeline.js vfxOf). Nothing reaches
// the track before Apply ("VFX only get finalized applied to the track on
// the timeline after clicking the Apply button"), which writes the list as
// one step however much was changed ("Each Apply in VFX counts as one
// undo-step"); an Apply that changed nothing writes nothing. Remove all VFX
// empties the draft and the window stays, so it too is final only with
// Apply. The main preview shows the draft meanwhile, as it does for every
// editor window. The window does not dock: three parts do not fit a frame.

const vfxModal = el('vfxModal');
const vfxTitle = el('vfxTitle');
const vfxMenu = el('vfxMenu');
const vfxChain = el('vfxChain');
const vfxEditing = el('vfxEditing');
const vfxStageCell = el('vfxStageCell');
const vfxStage = el('vfxStage');
const vfxCanvas = el('vfxCanvas');
const vfxOthers = el('vfxOthers');
const vfxBoxEl = el('vfxBoxEl');
const vfxRotor = el('vfxRotor');
const vfxPointEl = el('vfxPointEl');
const vfxPins = el('vfxPins');
const vfxPinFrame = el('vfxPinFrame');
const vfxAngle = el('vfxAngle');
const vfxGuideX = el('vfxGuideX');
const vfxGuideY = el('vfxGuideY');
const vfxKeys = el('vfxKeys');
const vfxKeysReadout = el('vfxKeysReadout');
const vfxKeysCanvas = el('vfxKeysCanvas');
const vfxMenuSearch = el('vfxMenuSearch');
const vfxPreviewAddBtn = el('vfxPreviewAddBtn');
const vfxAbout = el('vfxAbout');
const vfxStatics = el('vfxStatics');
const vfxSettings = el('vfxSettings');
const vfxRemoveAllBtn = el('vfxRemoveAllBtn');
const vfxCancelBtn = el('vfxCancelBtn');
const vfxApplyBtn = el('vfxApplyBtn');

// What each kind is called. Written out one by one, so check-locales finds
// every name. A new kind is a row here and a row in timeline.js VFX_KINDS.
// V5.1. `about` says in a line what it does: the menu shows it when the
// pointer rests on a row, and the settings column under the VFX's name.
const VFX_UI = {
  obscure: { name: () => t('Obscure'), about: () => t('Blurs an area, to make it unreadable') },
  pixelate: { name: () => t('Pixelate'), about: () => t('Turns an area into coarse blocks') },
  // V5.1.
  dirblur: { name: () => t('Directional Blur'), about: () => t('Blurs in one direction only, like fast movement') },
  tiltshift: { name: () => t('Tilt-Shift'), about: () => t('Keeps a band sharp and blurs the rest, for a miniature look') },
  brightness: { name: () => t('Brightness and Contrast'), about: () => t('Makes the picture brighter or darker and its contrast stronger or weaker') },
  exposure: { name: () => t('Exposure and Gamma'), about: () => t('Brightens like a longer exposure, Gamma lifts or lowers the middle tones') },
  levels: { name: () => t('Levels'), about: () => t('Sets which tone becomes black and which white, and how bright the output may get') },
  huesat: { name: () => t('Hue and Saturation'), about: () => t('Turns all colours round the colour wheel and makes them stronger or paler') },
  temperature: { name: () => t('Temperature and Tint'), about: () => t('Makes the picture warmer or cooler, Tint shifts between green and magenta') },
  rgb: { name: () => t('RGB Balance'), about: () => t('Raises or lowers red, green and blue on their own') },
  mono: { name: () => t('Black and White'), about: () => t('Black and white, with the share of each colour in the grey') },
  sepia: { name: () => t('Sepia'), about: () => t('The brown tone of old photographs') },
  colorize: { name: () => t('Colorize'), about: () => t('Paints the whole picture in one hue') },
  duotone: { name: () => t('Duotone'), about: () => t('Two colours instead of all: one for the dark parts, one for the bright') },
  colorpass: { name: () => t('Color Pass'), about: () => t('Keeps one colour and turns everything else grey') },
  look: { name: () => t('Film Look'), about: () => t('Ready-made colour looks, from Teal and Orange to Noir') },
  invert: { name: () => t('Invert Colors'), about: () => t('The negative: bright becomes dark and every colour its opposite') },
  glow: { name: () => t('Glow'), about: () => t('Lets the bright parts shine into their surroundings') },
  sharpen: { name: () => t('Sharpen'), about: () => t('Makes fine detail crisper') },
  vignette: { name: () => t('Vignette'), about: () => t('Darkens or brightens the corners') },
  grain: { name: () => t('Film Grain'), about: () => t('Fine grain that changes with every frame') },
  scanlines: { name: () => t('Scanlines'), about: () => t('Dark lines across the picture') },
  rgbsplit: { name: () => t('RGB Split'), about: () => t('Pulls red and blue apart, for coloured fringes') },
  posterize: { name: () => t('Posterize'), about: () => t('Reduces every colour to a few levels') },
  threshold: { name: () => t('Threshold'), about: () => t('Pure black and white, split at one brightness') },
  solarize: { name: () => t('Solarize'), about: () => t('Turns the bright tones round, like an overexposed film') },
  edges: { name: () => t('Edge Detect'), about: () => t('Shows only the outlines') },
  emboss: { name: () => t('Emboss'), about: () => t('Makes the picture look pressed into metal') },
  nightvision: { name: () => t('Night Vision'), about: () => t('Green and bright, like a night-vision device') },
  thermal: { name: () => t('Thermal Camera'), about: () => t('Brightness shown as heat colours') },
  lens: { name: () => t('Lens Distortion'), about: () => t('Bulges the middle outward or pulls the edges in') },
  flip: { name: () => t('Flip and Mirror'), about: () => t('Flips the picture or mirrors one half onto the other') },
  shadows: { name: () => t('Shadows and Highlights'), about: () => t('Brightens or darkens only the dark parts or only the bright parts') },
  splittone: { name: () => t('Split Toning'), about: () => t('Tints the dark parts with one colour and the bright parts with another') },
  channels: { name: () => t('Channel Swap'), about: () => t('Swaps red, green and blue with each other') },
  clarity: { name: () => t('Clarity'), about: () => t('Strengthens or softens the larger detail, for punch or for smooth skin') },
  dream: { name: () => t('Dream'), about: () => t('A soft, bright haze over the whole picture') },
  oldfilm: { name: () => t('Old Film'), about: () => t('Faded, brownish and grainy, like an old film') },
  vhs: { name: () => t('VHS'), about: () => t('Colour fringes, soft lines and noise, like a video tape') },
  crt: { name: () => t('Old TV'), about: () => t('Picture lines and a curved screen, like an old television') },
  bars: { name: () => t('Cinema Bars'), about: () => t('Black bars at the top and bottom, or at the sides') },
  offset: { name: () => t('Offset'), about: () => t('Shifts the picture, what leaves one edge comes in at the other') },
  comic: { name: () => t('Comic'), about: () => t('Few flat colours with dark outlines') },
  border: { name: () => t('Border'), about: () => t('A frame of one colour along the edges') },
  rotate: { name: () => t('Rotate'), about: () => t('Turns the picture about its middle') },
  zoom: { name: () => t('Zoom'), about: () => t('Enlarges a part of the picture, with a round area a magnifying glass') },
  wave: { name: () => t('Wave'), about: () => t('Waves that run through the picture') },
  ripple: { name: () => t('Ripple'), about: () => t('Rings that spread from the middle, as on water') },
  swirl: { name: () => t('Swirl'), about: () => t('Twists the picture about a point') },
  shake: { name: () => t('Shake'), about: () => t('Shakes the picture like a hand-held camera') },
  glitch: { name: () => t('Glitch'), about: () => t('Pushes slices of the picture aside, again and again') },
  haze: { name: () => t('Heat Haze'), about: () => t('A restless shimmer, like hot air') },
  tile: { name: () => t('Tile'), about: () => t('The picture several times side by side and one above the other') },
  kaleido: { name: () => t('Kaleidoscope'), about: () => t('Mirrors a wedge of the picture all the way round') },
  perspective: { name: () => t('Perspective'), about: () => t('Tilts the picture away from the viewer') },
  bulge: { name: () => t('Bulge and Pinch'), about: () => t('Blows up the picture round a point like a bump, or pinches it together') },
  lut: { name: () => t('Apply LUT'), about: () => t('Colours from a LUT file (.cube or .3dl), as colour grading tools write them') },
  // V5.2.
  cornerpin: { name: () => t('Corner Pin'), about: () => t('Puts the four corners of the picture where you drag them, as onto a screen or a wall seen at a slant') },
  polar: { name: () => t('Polar Coordinates'), about: () => t('Wraps the picture into a circle round its middle, or lays such a circle out flat') },
  vibrance: { name: () => t('Vibrance'), about: () => t('Strengthens the pale colours more than the strong ones, or mutes them') },
  halftone: { name: () => t('Halftone'), about: () => t('Dots as in a newspaper print, bigger where the picture is darker') },
  // V5.3.
  curves: { name: () => t('Curves'), about: () => t('Bends the tones along a curve you draw, for all colours or for red, green and blue alone') },
  // V5.4.
  chromakey: { name: () => t('Chroma Key'), about: () => t('Makes one colour see-through, such as a green screen, so the track under it shows there') },
  lumakey: { name: () => t('Luma Key'), about: () => t('Makes the dark or the bright parts see-through, so the track under it shows there') },
  // V5.5.
  strobe: { name: () => t('Strobe'), about: () => t('Flashes one colour over the picture, again and again') },
  // V5.5.1.
  echo: { name: () => t('Echo'), about: () => t('What moves leaves fading copies of itself behind. Works on the track\'s picture before its other VFX, one Echo to a track') },
};

// V5.1. The headings the menu puts the kinds under (timeline.js VFX_GROUPS).
const VFX_GROUP_NAMES = {
  hide: () => t('Blur and Hide'),
  color: () => t('Color'),
  stylize: () => t('Stylize'),
  distort: () => t('Distort'),
  key: () => t('Keying'),
  time: () => t('Time'),
};

// What each setting is called, by its id, for every kind that has it.
const VFX_SETTING_LABELS = {
  shape: () => t('Shape:'),
  invert: () => t('Invert Area'),
  strength: () => t('Strength:'),
  soft: () => t('Soft Edge:'),
  // V5.1.
  mix: () => t('Mix:'),
  vertical: () => t('Vertical'),
  brightness: () => t('Brightness:'),
  contrast: () => t('Contrast:'),
  exposure: () => t('Exposure:'),
  gamma: () => t('Gamma:'),
  black: () => t('Black Point:'),
  white: () => t('White Point:'),
  outBlack: () => t('Output Black:'),
  outWhite: () => t('Output White:'),
  hue: () => t('Hue:'),
  saturation: () => t('Saturation:'),
  temperature: () => t('Temperature:'),
  tint: () => t('Tint:'),
  red: () => t('Red:'),
  green: () => t('Green:'),
  blue: () => t('Blue:'),
  shadows: () => t('Shadows:'),
  highlights: () => t('Highlights:'),
  color: () => t('Color:'),
  range: () => t('Range:'),
  softness: () => t('Softness:'),
  look: () => t('Look:'),
  threshold: () => t('Threshold:'),
  radius: () => t('Radius:'),
  intensity: () => t('Intensity:'),
  amount: () => t('Amount:'),
  spacing: () => t('Spacing:'),
  thickness: () => t('Thickness:'),
  darkness: () => t('Darkness:'),
  angle: () => t('Angle:'),
  levels: () => t('Levels:'),
  level: () => t('Level:'),
  style: () => t('Style:'),
  gain: () => t('Gain:'),
  palette: () => t('Palette:'),
  mode: () => t('Mode:'),
  order: () => t('Order:'),
  edges: () => t('Outlines:'),
  file: () => t('LUT file:'),
  speed: () => t('Speed:'),
  length: () => t('Wavelength:'),
  zoom: () => t('Zoom:'),
  count: () => t('Tiles:'),
  segments: () => t('Segments:'),
  tiltx: () => t('Tilt Horizontal:'),
  tilty: () => t('Tilt Vertical:'),
  size: () => t('Size:'),
  x: () => t('Horizontal:'),
  y: () => t('Vertical:'),
  // V5.1.4. The point a kind bends the picture about.
  cx: () => t('Center X:'),
  cy: () => t('Center Y:'),
  // V5.2. The corners of a Corner Pin.
  x1: () => t('Top Left X:'),
  y1: () => t('Top Left Y:'),
  x2: () => t('Top Right X:'),
  y2: () => t('Top Right Y:'),
  x3: () => t('Bottom Right X:'),
  y3: () => t('Bottom Right Y:'),
  x4: () => t('Bottom Left X:'),
  y4: () => t('Bottom Left Y:'),
  vibrance: () => t('Vibrance:'),
  tinted: () => t('Colored Dots'),
  // V5.3.
  curve: () => t('Curve:'),
  // V5.4.
  tolerance: () => t('Tolerance:'),
  spill: () => t('Spill Removal:'),
  // V5.5.
  duration: () => t('Flash Length:'),
  // V5.5.1.
  copies: () => t('Echoes:'),
  gap: () => t('Frames Apart:'),
  decay: () => t('Echo Strength:'),
};

// V5.1. What a figure is counted in, where that says something: shown after
// it. A length is in the picture's pixels and says so by itself.
const VFX_SETTING_UNITS = {
  mix: '%',
  angle: '°',
  hue: '°',
  zoom: '%',
  thickness: '%',
  darkness: '%',
  x: '%',
  y: '%',
  black: '%',
  white: '%',
  outBlack: '%',
  outWhite: '%',
  duration: '%',
  decay: '%',
};

// V5.1. What each option of a choice is called, by the setting's id.
const VFX_CHOICE_LABELS = {
  look: {
    tealorange: () => t('Teal and Orange'),
    bleach: () => t('Bleach Bypass'),
    vintage: () => t('Vintage'),
    cross: () => t('Cross Process'),
    cool: () => t('Cool'),
    warm: () => t('Warm'),
    noir: () => t('Noir'),
    faded: () => t('Faded'),
    matrix: () => t('Matrix'),
    sunset: () => t('Sunset'),
    moon: () => t('Moonlight'),
    pastel: () => t('Pastel'),
  },
  order: {
    rbg: () => 'R B G',
    grb: () => 'G R B',
    gbr: () => 'G B R',
    brg: () => 'B R G',
    bgr: () => 'B G R',
  },
  style: {
    neon: () => t('Neon'),
    sketch: () => t('Sketch'),
    mono: () => t('White on Black'),
  },
  palette: {
    iron: () => t('Iron'),
    rainbow: () => t('Rainbow'),
    ice: () => t('Ice'),
  },
  mode: {
    dark: () => t('Remove Dark'),
    bright: () => t('Remove Bright'),
    wrap: () => t('Wrap into a Circle'),
    unwrap: () => t('Unwrap a Circle'),
    across: () => t('Flip Horizontal'),
    down: () => t('Flip Vertical'),
    both: () => t('Flip Both'),
    left: () => t('Mirror Left'),
    right: () => t('Mirror Right'),
    top: () => t('Mirror Top'),
    bottom: () => t('Mirror Bottom'),
    quad: () => t('Mirror Four Ways'),
  },
};

// Held to this many pixels on its longer side, like the mask view's stage.
const VFX_STAGE_MAX = 4096;
// After the playhead has moved the stage is drawn again for this long, since
// the frame it moved to arrives from the decoder a little after the move.
const VFX_SETTLE_MS = 700;
// As far as the pointer goes before a press on a VFX's button is a drag.
const VFX_CHIP_SLOP = 5;

let vfxLayerId = null;
let vfxPic = null;         // the source picture's size, { width, height }
// The track's VFX in the order processed, each as the model keeps one but in
// the window's units: a box in the picture's whole pixels, a turn in whole
// degrees, a setting that is a fraction of the picture's height in its
// pixels; `keys` the same.
let vfxDraft = null;
let vfxSel = -1;           // the chosen VFX's place in the draft, or -1
// V5.1.1. The id of the VFX a click in the menu previews, or null. It is
// the last of the draft and the chosen one while it is previewed, so the
// picture, its area and its keyframes work as for any other, but it has no
// button in the line and Apply leaves it out: only Add, its + or a double
// click keeps it. Another VFX previewed or chosen drops it.
let vfxPreviewId = null;
// Where the clip started and ended when last looked at, so a trim of its
// start in the main window can be carried into the draft's keyframes.
let vfxClip = null;
let vfxPreviewKey = '';
let vfxPreviewLayers = null;
let vfxSeenAt = null;
let vfxSettleUntil = 0;
// What the settings panel was last built for, so it is built again only
// when another VFX is chosen, and the fields it holds, by setting.
let vfxPanelFor = '';
let vfxFields = [];

// ---- between the layer's units and the window's ----

/** A kind's keyed values out of `o`, from the layer's fractions into the window's units. */
function vfxValuesIn(def, o) {
  const W = vfxPic.width;
  const H = vfxPic.height;
  const out = {};
  if (def.area) {
    const b = o.box;
    out.box = { x: Math.round(b.x * W), y: Math.round(b.y * H), w: Math.max(1, Math.round(b.w * W)), h: Math.max(1, Math.round(b.h * H)) };
    out.rotation = Math.round(o.rotation) || 0;
  }
  for (const s of def.keyed) out[s.id] = s.of ? Math.round(o[s.id] * (s.of === 'width' ? W : H)) : o[s.id];
  return out;
}

/** The same the other way, from the window's units into the layer's fractions. */
function vfxValuesOut(def, o) {
  const W = Math.max(1, vfxPic.width);
  const H = Math.max(1, vfxPic.height);
  const out = {};
  if (def.area) {
    const b = o.box;
    out.box = { x: b.x / W, y: b.y / H, w: b.w / W, h: b.h / H };
    out.rotation = o.rotation;
  }
  for (const s of def.keyed) out[s.id] = s.of ? o[s.id] / (s.of === 'width' ? W : H) : o[s.id];
  return out;
}

/** The draft from what a layer has. */
function vfxDraftOf(list) {
  return list.map((v) => {
    const def = timelineModel.vfxKind(v.kind);
    const d = { id: v.id, kind: v.kind };
    if (v.disabled) d.disabled = true;
    for (const s of def.statics) d[s.id] = v[s.id];
    Object.assign(d, vfxValuesIn(def, v));
    const keys = timelineModel.vfxKeysFor(v);
    if (keys.length) d.keys = keys.map((k) => ({ id: k.id, t: k.t, ...vfxValuesIn(def, k) }));
    return d;
  });
}

/** What a draft stands for, through the model: the list a layer keeps. */
function vfxListOfDraft(draft) {
  return timelineModel.vfxListOf(draft.map((d) => {
    const def = timelineModel.vfxKind(d.kind);
    const v = { id: d.id, kind: d.kind };
    if (d.disabled) v.disabled = true;
    for (const s of def.statics) v[s.id] = d[s.id];
    Object.assign(v, vfxValuesOut(def, d));
    if (d.keys) v.keys = d.keys.map((k) => ({ id: k.id, t: k.t, ...vfxValuesOut(def, k) }));
    return v;
  }));
}

/** A setting's range in the window's units: [lowest, highest]. */
function vfxSettingRange(s) {
  // A fraction of the picture's height, or of its width, is in its pixels here.
  const k = !s.of ? 1 : (s.of === 'width' ? (vfxPic ? vfxPic.width : 1280) : (vfxPic ? vfxPic.height : 720));
  return [Math.round(s.min * k), Math.max(1, Math.round(s.max * k))];
}

/** What a VFX is called on this track: its kind, and from the second of a kind its number. */
function vfxLabel(index) {
  const v = vfxDraft && vfxDraft[index];
  if (!v) return '';
  const ui = VFX_UI[v.kind];
  const name = ui ? ui.name() : v.kind;
  const n = timelineModel.vfxNumber(vfxDraft, index);
  return n > 1 ? name + ' (' + n + ')' : name;
}

// ---- a VFX at the playhead ----

/** The playhead's moment on the clip, in the clip's own seconds, held to it. */
function vfxLocalT() {
  const live = timelineModel.layerById(layers, vfxLayerId);
  if (!live) return 0;
  return Math.min(Math.max(compositeAt - live.start, 0), live.duration);
}

function vfxCurrent() {
  return vfxDraft && vfxSel >= 0 ? vfxDraft[vfxSel] || null : null;
}

/**
 * A draft VFX's keyed values as they are at the playhead: its own without
 * keyframes, and with them where they put it then. `whole` holds them to
 * whole pixels, degrees and steps, which is what an edit starts from and
 * what the settings show; the boxes drawn over the picture are not held, so
 * they glide with it.
 */
function vfxShown(v, whole = true) {
  const now = timelineModel.vfxValuesAt(v, vfxLocalT());
  if (!whole) return now;
  const out = {};
  for (const [id, value] of Object.entries(now)) {
    if (id === 'box') {
      out.box = { x: Math.round(value.x), y: Math.round(value.y), w: Math.max(1, Math.round(value.w)), h: Math.max(1, Math.round(value.h)) };
    } else {
      out[id] = Math.round(value) || 0;
    }
  }
  return out;
}

/** The chosen VFX's area as it is at the playhead, { box, rotation } in whole pixels, or null. */
function vfxAreaNow() {
  const v = vfxCurrent();
  if (!v || !timelineModel.vfxKind(v.kind).area) return null;
  const now = vfxShown(v);
  return { box: now.box, rotation: now.rotation };
}

/**
 * The keyframe of the chosen VFX an edit now goes to, as the strip marks it:
 * the one at the playhead, within half a frame, or `{ id: null, t }` for the
 * new one an edit would make there. Null for a VFX without keyframes.
 */
function vfxKeyEditing() {
  const v = vfxCurrent();
  if (!v || !v.keys) return null;
  const at = vfxLocalT();
  const near = timelineModel.vfxKeyNear(v, at, keyframeReach());
  return near ? { id: near.id, t: near.t } : { id: null, t: at };
}

/**
 * A new VFX of a kind, as its table row starts it. Its area is a third of
 * the picture high, in the shape's own proportions, in the middle, and a
 * little down and to the right of one that is already exactly there, so two
 * never hide each other.
 */
function vfxNew(kind) {
  const def = timelineModel.vfxKind(kind);
  const v = { id: timelineModel.newVfxId(), kind };
  for (const s of def.statics) v[s.id] = s.def;
  for (const s of def.keyed) v[s.id] = s.of ? Math.round(s.def * (s.of === 'width' ? vfxPic.width : vfxPic.height)) : s.def;
  if (!def.area) return v;
  v.rotation = 0;
  // V5.1. A kind for the whole picture starts on all of it, and Tilt-Shift
  // on a band across its middle, the sharp part.
  if (def.fill) {
    v.box = { x: 0, y: 0, w: vfxPic.width, h: vfxPic.height };
    return v;
  }
  if (def.band) {
    const bh = Math.max(16, Math.round(vfxPic.height / 3));
    v.box = { x: 0, y: Math.round((vfxPic.height - bh) / 2), w: vfxPic.width, h: bh };
    return v;
  }
  const h = Math.max(16, Math.round(vfxPic.height / 3));
  const w = Math.max(16, Math.round(h * genDraw.shapeAspect({ kind: v.shape })));
  const box = { x: Math.round((vfxPic.width - w) / 2), y: Math.round((vfxPic.height - h) / 2), w, h };
  const step = Math.max(8, Math.round(vfxPic.height / 30));
  const taken = (b) => vfxDraft.some((o) => {
    if (!timelineModel.vfxKind(o.kind).area) return false;
    const at = vfxShown(o).box;
    return at.x === b.x && at.y === b.y;
  });
  while (taken(box)) {
    box.x += step;
    box.y += step;
  }
  v.box = box;
  v.rotation = 0;
  return v;
}

// ---- opening and closing ----

/** The window open on a layer as a conflict confirmPopoutConflict can name. */
function vfxWindowConflict() {
  if (vfxModal.hidden) return null;
  return {
    message: t('The VFX window is open. Going on closes it and discards what it has not applied.'),
    close: cancelVfx,
  };
}

/**
 * The VFX window on a layer, from its button or from the right click at `at`
 * on the timeline. The same one already open is brought forward; another
 * track's asks before it is thrown away. The playhead is put on the clip
 * when it is somewhere else, so its picture is the one shown.
 */
function openVfx(layerId, at) {
  const layer = timelineModel.layerById(layers, layerId);
  if (!layer || layer.kind === 'gen' || layer.type !== 'video' || busy) return;
  if (!vfxModal.hidden) {
    if (vfxLayerId === layerId) {
      focusPopOut(vfxModal);
      return;
    }
    confirmPopoutConflict([vfxWindowConflict()], () => openVfx(layerId, at));
    return;
  }
  const source = layerSource(layer);
  if (!source) return;
  if (!timelineModel.covers(layer, compositeAt)) {
    const fps = projectFrame().fps || 30;
    const want = Number.isFinite(at) ? at : layer.start;
    seekComposite(Math.min(Math.max(want, layer.start), timelineModel.endOf(layer) - 1 / fps));
  }
  selectLayer(layer.id);
  vfxLayerId = layer.id;
  vfxPic = { width: Math.max(1, Math.round(source.width)), height: Math.max(1, Math.round(source.height)) };
  vfxClip = { start: layer.start, end: timelineModel.endOf(layer) };
  vfxDraft = vfxDraftOf(timelineModel.vfxList(layer));
  vfxSel = vfxDraft.length ? 0 : -1;
  vfxPreviewId = null;
  vfxMenuSearch.value = '';
  vfxPreviewKey = '';
  vfxPreviewLayers = null;
  vfxSeenAt = null;
  vfxSettleUntil = performance.now() + VFX_SETTLE_MS;
  vfxPanelFor = '';
  vfxTitle.textContent = t('Editing VFX for {name}', { name: layerLabel(layer.type, layerOrdinal(layer)) });
  vfxModal.hidden = false;
  resetStageView(vfxStage);
  popOut(vfxModal, 'vfx', {
    title: vfxTitle.textContent,
    cancel: cancelVfx,
    relayout: () => {
      if (!vfxDraft) return;
      sizeVfxStage();
      paintVfxStage();
    },
    preview: previewVfxDraft,
    // The user: "The vfx window cannot be docked".
    noDock: true,
  });
  showVfxMenu();
  showVfxDraft();
  sizeVfxStage();
  paintVfxStage();
}

function closeVfx() {
  if (vfxModal.hidden) return;
  popIn(vfxModal);
  clearPopoutPreview(vfxModal.id);
  vfxModal.hidden = true;
  vfxGuideX.hidden = true;
  vfxGuideY.hidden = true;
  vfxAngle.hidden = true;
  vfxPointEl.hidden = true;
  vfxOthers.replaceChildren();
  vfxChain.replaceChildren();
  vfxStatics.replaceChildren();
  vfxSettings.replaceChildren();
  vfxPanelFor = '';
  vfxFields = [];
  vfxLayerId = null;
  vfxPic = null;
  vfxDraft = null;
  vfxClip = null;
  vfxSel = -1;
  vfxPreviewId = null;
  endVfxColourPick();
}

function cancelVfx() {
  closeVfx();
}

/** Apply: the draft onto the track as one step, when it changed anything. */
function applyVfx() {
  if (!vfxDraft) return;
  const id = vfxLayerId;
  // A VFX only previewed was never added, so it does not go onto the track.
  const list = vfxListOfDraft(vfxDraft.filter((v) => v.id !== vfxPreviewId));
  // Against the track as it is now, not as it was when the window opened: a
  // trim of its start meanwhile moved its keyframes and the draft's alike.
  const live = timelineModel.layerById(layers, id);
  const changed = !!live && JSON.stringify(list) !== JSON.stringify(timelineModel.vfxList(live));
  closeVfx();
  if (!changed) return;
  setLayers(timelineModel.setLayer(layers, id, { vfx: list }));
  commitHistory();
}

/**
 * POPOUT_FPS times a second while the window is open: the main preview shows
 * the track as Apply would leave it, and the window's own picture follows
 * the playhead. A track gone from under the window takes the window with it.
 */
function previewVfxDraft() {
  if (vfxModal.hidden || !vfxDraft) return;
  const live = timelineModel.layerById(layers, vfxLayerId);
  if (!live) {
    cancelVfx();
    return;
  }
  rebaseVfxDraft(live);
  const now = performance.now();
  if (compositeAt !== vfxSeenAt) {
    vfxSeenAt = compositeAt;
    vfxSettleUntil = now + VFX_SETTLE_MS;
    // Every VFX is where its keyframes have it at the new moment, the
    // settings say what they are then, and the strip's playhead is there.
    placeVfxBoxes();
    showVfxSettings(null);
  }
  if (compositePlaying || now < vfxSettleUntil) paintVfxStage();
  const list = vfxListOfDraft(vfxDraft);
  const key = JSON.stringify(list);
  if (key === vfxPreviewKey && layers === vfxPreviewLayers) return;
  vfxPreviewKey = key;
  vfxPreviewLayers = layers;
  setPopoutPreview(vfxModal.id, {
    layerId: live.id,
    layerNow: () => {
      const l = timelineModel.layerById(layers, live.id);
      return l ? { ...l, vfx: list } : null;
    },
  });
  if (!compositePlaying) drawComposite();
}

/**
 * A trim of the clip's start made in the main window while this one is open
 * moved the track's keyframes back by as much, so they stay where they are
 * on the timeline; the draft's go with them. Told from a move by the clip's
 * end, which a trim of the start leaves where it was.
 */
function rebaseVfxDraft(live) {
  const end = timelineModel.endOf(live);
  const was = vfxClip;
  vfxClip = { start: live.start, end };
  if (!was || !vfxDraft) return;
  const shift = live.start - was.start;
  if (Math.abs(shift) < 1e-9 || Math.abs(end - was.end) > 1e-6) return;
  if (!vfxDraft.some((v) => v.keys)) return;
  vfxDraft = vfxDraft.map((v) => (v.keys
    ? { ...v, keys: v.keys.map((k) => ({ ...k, t: Math.round((k.t - shift) * 1e6) / 1e6 })) }
    : v));
  placeVfxBoxes();
}

// ---- the menu: every VFX there is ----

function showVfxMenu() {
  const doc = vfxMenu.ownerDocument;
  // V5.1. Under headings, a kind no heading names after them all.
  const listed = new Set(timelineModel.VFX_GROUPS.flatMap((g) => g.kinds));
  const rest = timelineModel.VFX_KIND_IDS.filter((kind) => !listed.has(kind));
  const groups = [...timelineModel.VFX_GROUPS, ...(rest.length ? [{ id: '', kinds: rest }] : [])];
  const row = (kind) => {
    const row = doc.createElement('div');
    row.className = 'vfx-menu__row';
    row.dataset.kind = kind;
    if (VFX_UI[kind].about) row.title = VFX_UI[kind].about();
    const name = doc.createElement('span');
    name.className = 'vfx-menu__name';
    name.textContent = VFX_UI[kind].name();
    const add = doc.createElement('button');
    add.type = 'button';
    add.className = 'vfx-menu__add';
    add.textContent = '+';
    add.title = t('Add this VFX');
    row.append(name, add);
    return row;
  };
  const nodes = [];
  for (const g of groups) {
    const kinds = g.kinds.filter((kind) => VFX_UI[kind] && timelineModel.vfxKind(kind));
    if (!kinds.length) continue;
    if (VFX_GROUP_NAMES[g.id]) {
      // V5.1.6. The heading is the switch that folds its kinds away.
      const head = doc.createElement('div');
      head.className = 'vfx-menu__group';
      head.dataset.group = g.id;
      head.setAttribute('role', 'button');
      const chevron = doc.createElement('span');
      chevron.className = 'vfx-menu__chevron';
      const label = doc.createElement('span');
      label.textContent = VFX_GROUP_NAMES[g.id]();
      head.append(chevron, label);
      nodes.push(head);
    }
    nodes.push(...kinds.map(row));
  }
  const none = doc.createElement('div');
  none.className = 'vfx-menu__none';
  none.textContent = t('No VFX found');
  none.hidden = true;
  nodes.push(none);
  vfxMenu.replaceChildren(...nodes);
  filterVfxMenu();
  markVfxMenu();
}

/**
 * V5.1.1. The user: "a search bar right below" the title. The rows whose
 * name holds what is typed, any case, and the headings that still have one.
 */
function filterVfxMenu() {
  const want = vfxMenuSearch.value.trim().toLowerCase();
  const folded = vfxFoldedGroups();
  let head = null;
  let headShows = false;
  let shut = false;
  let any = false;
  // With nothing typed a heading always shows, folded or not; with a search
  // only the ones that still have a row.
  const closeHead = () => {
    if (head) head.hidden = !!want && !headShows;
  };
  // V5.1.6. While something is typed every heading is open, whatever it was
  // folded to, and a click on one does nothing: the search is over all kinds.
  vfxMenu.classList.toggle('vfx-menu__list--search', !!want);
  for (const node of vfxMenu.children) {
    if (node.classList.contains('vfx-menu__group')) {
      closeHead();
      head = node;
      headShows = false;
      shut = !want && folded.has(node.dataset.group);
      node.classList.toggle('vfx-menu__group--folded', shut);
      node.setAttribute('aria-expanded', String(!shut));
    } else if (node.classList.contains('vfx-menu__row')) {
      const name = node.querySelector('.vfx-menu__name').textContent.toLowerCase();
      const found = !want || name.includes(want);
      node.hidden = !found || shut;
      if (found) {
        headShows = true;
        any = true;
      }
    } else if (node.classList.contains('vfx-menu__none')) {
      node.hidden = any;
    }
  }
  closeHead();
}

/**
 * V5.1.6. The user: "Make the vfx categories collapsible so you dont have to
 * scroll through all effects all the time and let the window remember which
 * are collapsed." The folded headings by their ids, as the settings keep
 * them, so they are the same in every project and on the next start.
 */
function vfxFoldedGroups() {
  const saved = typeof appSettings === 'object' && appSettings && appSettings.vfxFolded;
  return new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : []);
}

function toggleVfxGroup(id) {
  if (!id || typeof appSettings !== 'object' || !appSettings) return;
  const folded = vfxFoldedGroups();
  if (folded.has(id)) folded.delete(id);
  else folded.add(id);
  // In the menu's order, and only headings there are, so the file stays small.
  const list = timelineModel.VFX_GROUPS.map((g) => g.id).filter((g) => folded.has(g));
  appSettings.vfxFolded = list.length ? list : null;
  if (window.lwclipper && window.lwclipper.setSettings) window.lwclipper.setSettings({ vfxFolded: appSettings.vfxFolded });
  filterVfxMenu();
}

vfxMenuSearch.addEventListener('input', filterVfxMenu);
// Escape in the search empties it first; only an empty one lets the window close.
vfxMenuSearch.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Escape' || !vfxMenuSearch.value) return;
  evt.stopPropagation();
  vfxMenuSearch.value = '';
  filterVfxMenu();
});

/** The row of the kind being previewed lit, the others not. */
function markVfxMenu() {
  const p = vfxDraft && vfxDraft.find((v) => v.id === vfxPreviewId);
  for (const row of vfxMenu.querySelectorAll('.vfx-menu__row')) {
    row.classList.toggle('vfx-menu__row--on', !!p && row.dataset.kind === p.kind);
  }
}

// The user, V5.1.1: "A left-click on an VFX opens its preview with default
// parameters only, not adding it yet, double-click or "+" adds it."
vfxMenu.addEventListener('click', (evt) => {
  const add = evt.target.closest && evt.target.closest('.vfx-menu__add');
  if (add) {
    addVfx(add.parentNode.dataset.kind);
    return;
  }
  const row = evt.target.closest && evt.target.closest('.vfx-menu__row');
  if (row) previewVfx(row.dataset.kind);
  // V5.1.6. A heading folds or opens its kinds; not while a search has them
  // all open. A row is not inside its heading, so a click is one or the other.
  const group = evt.target.closest && evt.target.closest('.vfx-menu__group');
  if (group && !vfxMenuSearch.value.trim()) toggleVfxGroup(group.dataset.group);
});
vfxMenu.addEventListener('dblclick', (evt) => {
  if (evt.target.closest && evt.target.closest('.vfx-menu__add')) return;
  const row = evt.target.closest && evt.target.closest('.vfx-menu__row');
  if (row) addVfx(row.dataset.kind);
});

/** The VFX being previewed taken out of the draft, when there is one; true if it was. */
function dropVfxPreview() {
  if (!vfxPreviewId || !vfxDraft) return false;
  const wasSel = vfxCurrent() && vfxCurrent().id === vfxPreviewId;
  vfxDraft = vfxDraft.filter((v) => v.id !== vfxPreviewId);
  vfxPreviewId = null;
  if (wasSel) vfxSel = -1;
  return true;
}

/**
 * A VFX of a kind previewed: as a new one starts, at the end of the draft
 * and chosen, but not added. Whatever another preview had set is dropped
 * with it ("Clicking another vfx to preview discards all settings made in
 * the preview"); the kind already previewed is left as it is, so the first
 * click of a double click does not undo what was set.
 */
function previewVfx(kind) {
  if (!vfxDraft || !timelineModel.vfxKind(kind)) return;
  const was = vfxDraft.find((v) => v.id === vfxPreviewId);
  if (was && was.kind === kind) return;
  dropVfxPreview();
  const v = vfxNew(kind);
  vfxDraft = [...vfxDraft, v];
  vfxPreviewId = v.id;
  vfxSel = vfxDraft.length - 1;
  showVfxDraft();
  paintVfxStage();
}

/** The VFX being previewed kept as it is set, the user's Add. */
function keepVfxPreview() {
  if (!vfxPreviewId || !vfxDraft) return;
  vfxPreviewId = null;
  showVfxDraft();
  paintVfxStage();
  noteVfxKeyframes();
}

/**
 * A VFX of a kind added at the end of the track's, and chosen. The kind
 * being previewed is kept with what was set in the preview; another kind
 * drops the preview and is added as it starts.
 */
function addVfx(kind) {
  if (!vfxDraft || !timelineModel.vfxKind(kind)) return;
  const was = vfxDraft.find((v) => v.id === vfxPreviewId);
  if (was && was.kind === kind) {
    keepVfxPreview();
    return;
  }
  dropVfxPreview();
  vfxDraft = [...vfxDraft, vfxNew(kind)];
  vfxSel = vfxDraft.length - 1;
  showVfxDraft();
  paintVfxStage();
  noteVfxKeyframes();
}

vfxPreviewAddBtn.addEventListener('click', keepVfxPreview);

/**
 * The user: no cap on VFX, but once a project, on "adding >=8th VFX to a
 * track with at least 3x the same vfx type", a note that keyframes do the
 * same with one, with only an "I Understand" button; "let the user continue
 * and dont re-open that modal on the project again (so note, if it got
 * opened once)". The VFX is added either way, and the note is kept with the
 * project whether or not this window is applied.
 */
function noteVfxKeyframes() {
  if (!timelineModel.vfxNoteDue(vfxDraft) || projectNoted('vfxKeyframes')) return;
  noteProject('vfxKeyframes');
  showChoice({
    title: t('Note'),
    message: t('Note: You can add/edit/modify Keyframes to use the same VFX with different settings at different times'),
    buttons: [{ id: 'ok', label: t('I Understand'), tone: 'go' }],
    cancel: 'ok',
    over: vfxModal,
  });
}

// ---- the track's VFX, in the order they are processed ----

function showVfxChain() {
  const doc = vfxChain.ownerDocument;
  // The one previewed is the last of the draft and has no button.
  const added = vfxDraft.filter((v) => v.id !== vfxPreviewId);
  if (!added.length) {
    const none = doc.createElement('div');
    none.className = 'vfx-chain__none';
    none.textContent = t('No VFX yet. Add one from the list on the left.');
    vfxChain.replaceChildren(none);
    return;
  }
  // The user, V5.1.1: "[VFX1 X] > [VFX2 X] > VFX N, to indicate order
  // better". The arrows are between the buttons, not part of them.
  const nodes = [];
  added.forEach((v, i) => {
    if (i > 0) {
      const arrow = doc.createElement('span');
      arrow.className = 'vfx-chain__arrow';
      arrow.textContent = '>';
      nodes.push(arrow);
    }
    nodes.push(vfxChip(doc, i));
  });
  vfxChain.replaceChildren(...nodes);
}

/** The button of the draft's VFX at `i`: its name and its X. */
function vfxChip(doc, i) {
  const chip = doc.createElement('div');
  chip.className = 'vfx-chip' + (i === vfxSel ? ' vfx-chip--on' : '') + (vfxDraft[i].disabled ? ' vfx-chip--disabled' : '');
  chip.dataset.index = String(i);
  // V5.1.2. The user: a checkbox "right infront of every added VFX so it
  // can be quickly dis-/enabled without the need to delete or move it to
  // compare changes". Like everything here it reaches the track with Apply.
  const on = doc.createElement('input');
  on.type = 'checkbox';
  on.className = 'vfx-chip__on';
  on.checked = !vfxDraft[i].disabled;
  on.title = t('Switch this VFX on or off');
  chip.appendChild(on);
  const name = doc.createElement('span');
  name.className = 'vfx-chip__name';
  name.textContent = vfxLabel(i);
  // The user: "Each added VFX has its own red X right of its name to be
  // removed individually." V5.1.1: only the X itself is red.
  const x = doc.createElement('button');
  x.type = 'button';
  x.className = 'vfx-chip__x';
  x.textContent = '×';
  x.title = t('Remove this VFX');
  chip.append(name, x);
  return chip;
}

/** An added VFX chosen to edit; a preview there was is dropped. */
function selectVfx(index) {
  if (!vfxDraft || index === vfxSel) return;
  const keep = vfxDraft[index];
  const dropped = dropVfxPreview();
  vfxSel = keep ? vfxDraft.indexOf(keep) : -1;
  showVfxDraft();
  if (dropped) paintVfxStage();
}

function removeVfx(index) {
  if (!vfxDraft || !vfxDraft[index]) return;
  const chosen = vfxCurrent();
  vfxDraft = vfxDraft.filter((_, i) => i !== index);
  // The chosen one stays the chosen one; when it is the one that went, the
  // one that took its place is.
  vfxSel = chosen && index !== vfxSel ? vfxDraft.indexOf(chosen) : Math.min(index, vfxDraft.length - 1);
  showVfxDraft();
  paintVfxStage();
}

/** The VFX at `from` put where the one at `to` is, the rest closing up. */
function moveVfx(from, to) {
  if (!vfxDraft || from === to || !vfxDraft[from] || !vfxDraft[to]) return;
  const chosen = vfxCurrent();
  const next = vfxDraft.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  vfxDraft = next;
  vfxSel = chosen ? vfxDraft.indexOf(chosen) : -1;
}

// A press on a VFX's button chooses it; dragged, it changes the order they
// are processed in ("each added vfx must be dragable to switch position in
// their line"), the button following the pointer from one place to the next.
vfxChain.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || !vfxDraft) return;
  if (evt.target.closest && evt.target.closest('.vfx-chip__x, .vfx-chip__on')) return;
  const chip = evt.target.closest && evt.target.closest('.vfx-chip');
  if (!chip) return;
  let index = Number(chip.dataset.index);
  const id = vfxDraft[index] && vfxDraft[index].id;
  const x0 = evt.clientX;
  const y0 = evt.clientY;
  let dragging = false;
  selectVfx(index);
  beginDrag(vfxChain, evt, (ev) => {
    if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < VFX_CHIP_SLOP) return;
    dragging = true;
    vfxChain.dataset.dragging = 'true';
    const doc = vfxChain.ownerDocument;
    // The button under the pointer, looked for past the capture.
    const under = doc.elementsFromPoint(ev.clientX, ev.clientY)
      .map((n) => (n.closest ? n.closest('.vfx-chip') : null)).find(Boolean);
    if (!under || under.parentNode !== vfxChain) return;
    const to = Number(under.dataset.index);
    if (to === index) return;
    // Only past its middle, so two buttons of different widths do not swap
    // back and forth under a pointer that is not moving.
    const b = under.getBoundingClientRect();
    const past = to > index ? ev.clientX > b.left + b.width / 2 : ev.clientX < b.left + b.width / 2;
    // By its index, since the arrows between the buttons are children too.
    const own = vfxChain.querySelector('.vfx-chip[data-index="' + index + '"]');
    const sameRow = !!own && Math.abs(b.top - own.getBoundingClientRect().top) < b.height / 2;
    if (sameRow && !past) return;
    moveVfx(index, to);
    index = vfxDraft.findIndex((v) => v.id === id);
    showVfxDraft();
  }, () => {
    delete vfxChain.dataset.dragging;
    if (dragging) paintVfxStage();
  });
});

vfxChain.addEventListener('click', (evt) => {
  const x = evt.target.closest && evt.target.closest('.vfx-chip__x');
  if (!x || !vfxDraft) return;
  removeVfx(Number(x.parentNode.dataset.index));
});

// V5.1.2. A checkbox switches its VFX off or on without choosing it, so the
// picture can be compared with and without it while another is edited.
vfxChain.addEventListener('change', (evt) => {
  const box = evt.target.closest && evt.target.closest('.vfx-chip__on');
  if (!box || !vfxDraft) return;
  const index = Number(box.parentNode.dataset.index);
  const v = vfxDraft[index];
  if (!v) return;
  const { disabled: _was, ...rest } = v;
  vfxDraft = vfxDraft.map((o, i) => (i === index ? (box.checked ? rest : { ...rest, disabled: true }) : o));
  showVfxChain();
  paintVfxStage();
});

// ---- the chosen VFX: its name and its settings ----

/** Everything the window shows of the draft, the picture apart. */
function showVfxDraft() {
  if (!vfxDraft) return;
  showVfxChain();
  const v = vfxCurrent();
  const label = v ? vfxLabel(vfxSel) : '';
  // V5.1.1. The user: "While a VFX is only left-clicked once show
  // "Previewing [vfx_name]" ... instead of "Editing [vfx_name]" and give it
  // an "Add" button floating right of the "Previewing..." title".
  const previewing = !!v && v.id === vfxPreviewId;
  vfxEditing.textContent = !v ? ''
    : (previewing ? t('Previewing {name}', { name: label }) : t('Editing {name}', { name: label }));
  vfxPreviewAddBtn.hidden = !previewing;
  // Under it in a line what the kind does.
  vfxAbout.textContent = v && VFX_UI[v.kind] && VFX_UI[v.kind].about ? VFX_UI[v.kind].about() : '';
  markVfxMenu();
  vfxRemoveAllBtn.disabled = !vfxDraft.length;
  buildVfxSettings();
  showVfxSettings(null);
  placeVfxBoxes();
  // V5.1.1. The line of VFX and the settings in the centre take what room
  // they need, so the picture's cell can have grown or shrunk.
  if (vfxStageCell.clientWidth !== parseFloat(vfxStage.style.width)
    || vfxStageCell.clientHeight !== parseFloat(vfxStage.style.height)) {
    sizeVfxStage();
    paintVfxStage();
  }
}

/**
 * The settings of the chosen VFX's kind, made from its table row: the ones
 * that are the same the whole clip long in the centre under its name, the
 * ones a keyframe holds on the right. Made again only when another VFX is
 * chosen.
 */
function buildVfxSettings() {
  const v = vfxCurrent();
  const want = v ? v.id + ':' + v.kind : '';
  if (want === vfxPanelFor) return;
  vfxPanelFor = want;
  vfxFields = [];
  vfxCurveChannel = 'm';
  endVfxColourPick();
  vfxStatics.replaceChildren();
  vfxSettings.replaceChildren();
  if (!v) return;
  const doc = vfxSettings.ownerDocument;
  const def = timelineModel.vfxKind(v.kind);
  const make = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const label = (s) => (VFX_SETTING_LABELS[s.id] ? VFX_SETTING_LABELS[s.id]() : s.id);
  const group = (cls, title, settings, keyed) => {
    if (!settings.length) return null;
    const box = make('div', 'vfx-group ' + cls);
    box.appendChild(make('div', 'vfx-group__title', title));
    for (const s of settings) box.appendChild(vfxField(doc, make, s, label(s), keyed));
    return box;
  };
  // The user: "show static settings as slightly greenish (like 222, 255,
  // 222)" and the ones per keyframe in white. V5.1.1: "put its constant
  // settings into the center as well, only leave the per-keyframe settings
  // sitting on the right", so the column between the two is the divider.
  const fixed = group('vfx-group--static', t('The same for the whole clip'), def.statics, false);
  const keyed = group('vfx-group--keyed', t('Per keyframe'), def.keyed, true);
  if (fixed) vfxStatics.appendChild(fixed);
  if (keyed) vfxSettings.appendChild(keyed);
}

/** One setting's row, by what sort of setting it is, bound to the draft. */
function vfxField(doc, make, s, text, keyed) {
  const row = make('div', 'vfx-field vfx-field--' + s.type);
  const change = (value) => (keyed ? changeVfxKeyed({ [s.id]: value }) : changeVfxStatic({ [s.id]: value }));
  if (s.type === 'check') {
    const wrap = make('label', 'gen-check gen-check--field');
    const box = make('input');
    box.type = 'checkbox';
    wrap.append(box, doc.createTextNode(' ' + text));
    row.appendChild(wrap);
    box.addEventListener('change', () => change(box.checked));
    vfxFields.push({ s, keyed, show: (value) => { box.checked = !!value; } });
    return row;
  }
  if (s.type === 'shape') {
    row.appendChild(make('div', 'vfx-field__caption', text));
    const kinds = make('div', 'gen-choice shape-kinds vfx-shapes');
    // V5.1.3. The shapes the kind offers: all of them, or a rectangle and a circle.
    for (const kind of s.options || timelineModel.SHAPE_KINDS) {
      const b = make('button', '', shapeName(kind));
      b.type = 'button';
      b.dataset.kind = kind;
      b.addEventListener('click', () => change(kind));
      kinds.appendChild(b);
    }
    row.appendChild(kinds);
    vfxFields.push({
      s,
      keyed,
      show: (value) => {
        for (const b of kinds.children) b.classList.toggle('btn--active', b.dataset.kind === value);
      },
    });
    return row;
  }
  if (s.type === 'choice') {
    // V5.1. One of a few, as buttons like the shapes.
    row.appendChild(make('div', 'vfx-field__caption', text));
    const names = VFX_CHOICE_LABELS[s.id] || {};
    const picks = make('div', 'gen-choice shape-kinds vfx-shapes');
    for (const option of s.options) {
      const b = make('button', '', names[option] ? names[option]() : option);
      b.type = 'button';
      b.dataset.option = option;
      b.addEventListener('click', () => change(option));
      picks.appendChild(b);
    }
    row.appendChild(picks);
    vfxFields.push({
      s,
      keyed,
      show: (value) => {
        for (const b of picks.children) b.classList.toggle('btn--active', b.dataset.option === value);
      },
    });
    return row;
  }
  if (s.type === 'file') {
    // V5.1. A file of the user's own: its name, and a button that picks one.
    row.appendChild(make('div', 'vfx-field__caption', text));
    const line = make('div', 'vfx-field__line');
    const name = make('span', 'vfx-file__name');
    const pick = make('button', 'vfx-file__pick', t('Choose File'));
    pick.type = 'button';
    line.append(name, pick);
    row.appendChild(line);
    pick.addEventListener('click', async () => {
      const kept = vfxCurrent();
      const picked = await window.lwclipper.openLut();
      if (!picked || !picked.ok || !vfxDraft || vfxCurrent() !== kept) return;
      // Read again from the disk, in case it is one chosen before and changed since.
      vfxGl.forgetCube(picked.path);
      change(picked.path);
    });
    vfxFields.push({
      s,
      keyed,
      show: (value) => {
        const file = typeof value === 'string' ? value : '';
        const state = file ? vfxGl.cube(file).state : '';
        name.textContent = !file ? t('No file chosen')
          : (state === 'bad' ? t('This file could not be read as a LUT') : file.split(/[\\/]/).pop());
        name.title = file;
        name.classList.toggle('vfx-file__name--bad', state === 'bad');
      },
    });
    return row;
  }
  if (s.type === 'curve') return vfxCurveField(doc, make, s, text, change);
  if (s.type === 'color') {
    // V5.1. A colour, picked in the system's own colour window.
    const wrap = make('label', 'vfx-field__color');
    wrap.appendChild(make('span', 'vfx-field__caption', text));
    const well = make('input', 'vfx-color');
    well.type = 'color';
    wrap.appendChild(well);
    row.appendChild(wrap);
    well.addEventListener('input', () => change(well.value));
    // V5.4. A colour that may be taken from the picture: a button, and then
    // a click on the picture.
    let pick = null;
    if (s.pick) {
      pick = make('button', 'vfx-color__pick', t('Pick from Picture'));
      pick.type = 'button';
      pick.title = t('Click a spot of the picture to take its colour');
      pick.addEventListener('click', () => {
        if (vfxPicking && vfxPicking.id === s.id) endVfxColourPick();
        else beginVfxColourPick(s.id);
        showVfxSettings(null);
      });
      row.appendChild(pick);
    }
    vfxFields.push({
      s,
      keyed,
      show: (value) => {
        if (well.value !== value) well.value = value;
        if (pick) pick.classList.toggle('btn--active', !!vfxPicking && vfxPicking.id === s.id);
      },
    });
    return row;
  }
  // A number: its name, a slider and the figure to type.
  row.appendChild(make('div', 'vfx-field__caption', text));
  const line = make('div', 'vfx-field__line');
  const slider = make('input', 'gen-field__slider vfx-field__slider');
  slider.type = 'range';
  slider.step = '1';
  const box = make('input', 'gen-num');
  box.type = 'text';
  box.inputMode = 'numeric';
  box.maxLength = 5;
  line.append(slider, box);
  // A unit's room after every figure, named or not, so the sliders line up.
  line.appendChild(make('span', 'gen-field__unit', s.of ? 'px' : (VFX_SETTING_UNITS[s.id] || '')));
  row.appendChild(line);
  const field = {
    s,
    keyed,
    show: (value, except) => {
      const [lo, hi] = vfxSettingRange(s);
      slider.min = String(lo);
      slider.max = String(hi);
      slider.value = String(value);
      if (except !== box) box.value = String(value);
    },
  };
  bindNumberField({
    slider,
    box,
    range: () => vfxSettingRange(s),
    set: (n, except) => {
      change(n);
      showVfxSettings(except);
    },
    show: () => showVfxSettings(null),
  });
  vfxFields.push(field);
  return row;
}

// ---- V5.4. A colour taken from the picture ----

// The setting waiting for a click on the picture, { id }, or null.
let vfxPicking = null;
// As many of the picture's pixels each way as the colour is the mean of: a
// screen is grainy, and one pixel of it is not its colour.
const VFX_PICK_SPAN = 5;

function beginVfxColourPick(id) {
  vfxPicking = { id };
  vfxStage.classList.add('vfx-stage--picking');
}

function endVfxColourPick() {
  vfxPicking = null;
  vfxStage.classList.remove('vfx-stage--picking');
}

/**
 * The picture's colour under the pointer, '#rrggbb', as it reaches the
 * chosen VFX: with the VFX before it on it and without its own, so a key
 * takes the colour it is going to look for. The mean of a few pixels round
 * the spot. Null off the picture, or where it is see-through.
 */
function vfxColourAt(evt) {
  const entry = vfxFrameSource();
  const live = timelineModel.layerById(layers, vfxLayerId);
  if (!entry || !live || !vfxPic || !vfxDraft || vfxSel < 0) return null;
  const r = stageFrameRect(vfxStage);
  const stage = vfxStage.getBoundingClientRect();
  const W = vfxPic.width;
  const H = vfxPic.height;
  const x = (evt.clientX - stage.left - vfxStage.clientLeft - r.left) / r.s;
  const y = (evt.clientY - stage.top - vfxStage.clientTop - r.top) / r.s;
  if (!(x >= 0 && y >= 0 && x < W && y < H)) return null;
  const k = Math.min(1, VFX_STAGE_MAX / Math.max(W, H));
  const shown = { ...live, mask: null, keyframes: [], vfx: vfxListOfDraft(vfxDraft.slice(0, vfxSel)) };
  const pic = maskedPicture(shown, entry.el, [0, 0, entry.width, entry.height],
    { dw: W * k, dh: H * k }, live.start + vfxLocalT(),
    { x: 0, y: 0, w: W, h: H, W, H, ex: entry.width / W, ey: entry.height / H });
  const [sx, sy, sw, sh] = pic.from;
  const n = VFX_PICK_SPAN;
  // The few pixels round the spot, held inside the picture, each read as it is.
  const px = Math.min(W - n, Math.max(0, Math.round(x - n / 2)));
  const py = Math.min(H - n, Math.max(0, Math.round(y - n / 2)));
  const ctx = new OffscreenCanvas(n, n).getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pic.el, sx + (px / W) * sw, sy + (py / H) * sh, (n / W) * sw, (n / H) * sh, 0, 0, n, n);
  const data = ctx.getImageData(0, 0, n, n).data;
  const sum = [0, 0, 0];
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    sum[0] += data[i] * a;
    sum[1] += data[i + 1] * a;
    sum[2] += data[i + 2] * a;
    weight += a;
  }
  if (!(weight > n * n * 0.1)) return null;
  return '#' + sum.map((c) => Math.min(255, Math.max(0, Math.round(c / weight))).toString(16).padStart(2, '0')).join('');
}

// A press on the picture while a colour is waiting for one takes the colour
// there, before anything else on the picture hears of the press.
vfxStage.addEventListener('pointerdown', (evt) => {
  if (!vfxPicking || evt.button !== 0) return;
  evt.preventDefault();
  evt.stopPropagation();
  const id = vfxPicking.id;
  const colour = vfxColourAt(evt);
  // A press beside the picture leaves the colour waiting.
  if (!colour) return;
  endVfxColourPick();
  changeVfxStatic({ [id]: colour });
}, true);

// Escape gives the wait up, and only that: the window stays. Heard on the
// window's panel, which is what travels into a window of its own, before
// that window's own Escape closes it.
vfxStage.closest('.modal__panel').addEventListener('keydown', (evt) => {
  if (!vfxPicking || evt.key !== 'Escape') return;
  evt.preventDefault();
  evt.stopPropagation();
  endVfxColourPick();
  showVfxSettings(null);
}, true);

// V5.3. Curves. The square the curves are drawn in, in the window's pixels,
// the room round it that lets a point on its edge be taken hold of, how near
// a press has to be to a point to mean it, and how far outside the square a
// point is dragged to be removed.
const VFX_CURVE_SIZE = 180;
const VFX_CURVE_EDGE = 9;
const VFX_CURVE_REACH = 10;
const VFX_CURVE_DROP = 28;
const VFX_CURVE_COLOURS = { m: '#f0f0f4', r: '#ff6464', g: '#5fd35f', b: '#6c9dff' };
// Which of the curves is being drawn: the one for all colours, or red's,
// green's or blue's. The window's own, back to the first for another VFX.
let vfxCurveChannel = 'm';

/**
 * V5.3. The setting of a Curves VFX: a square with the curves in it, the
 * chosen one with its points to drag, and beside it which curve is chosen.
 * A press on the square puts a point there, a point dragged far out of it
 * is taken away again, as is one double-clicked.
 */
function vfxCurveField(doc, make, s, text, change) {
  const row = make('div', 'vfx-field vfx-field--curve');
  row.appendChild(make('div', 'vfx-field__caption', text));
  const line = make('div', 'vfx-curve');
  const pad = make('canvas', 'vfx-curve__pad');
  const side = make('div', 'vfx-curve__side');
  const picks = make('div', 'gen-choice shape-kinds vfx-shapes');
  const names = { m: t('All'), r: 'R', g: 'G', b: 'B' };
  for (const ch of timelineModel.VFX_CURVE_CHANNELS) {
    const b = make('button', 'vfx-curve__channel vfx-curve__channel--' + ch, names[ch]);
    b.type = 'button';
    b.dataset.channel = ch;
    b.addEventListener('click', () => {
      vfxCurveChannel = ch;
      showVfxSettings(null);
    });
    picks.appendChild(b);
  }
  const reset = make('button', 'vfx-curve__reset', t('Reset Curve'));
  reset.type = 'button';
  const readout = make('div', 'vfx-curve__readout');
  const hint = make('div', 'vfx-curve__hint', t('Click to add a point, drag it out of the square to remove it'));
  side.append(picks, reset, readout, hint);
  line.append(pad, side);
  row.appendChild(line);

  const flat = () => [[0, 0], [255, 255]];
  const curveNow = () => {
    const v = vfxCurrent();
    return timelineModel.vfxCurveOf(v ? v[s.id] : null, s.def);
  };
  const span = VFX_CURVE_SIZE - 2 * VFX_CURVE_EDGE;
  const toPad = (p) => [VFX_CURVE_EDGE + (p[0] / 255) * span, VFX_CURVE_EDGE + (1 - p[1] / 255) * span];
  // Where a pointer is in the square's own pixels, and as a value and what it becomes.
  const placeOf = (evt) => {
    const box = pad.getBoundingClientRect();
    const k = VFX_CURVE_SIZE / Math.max(1, box.width);
    const x = (evt.clientX - box.left) * k;
    const y = (evt.clientY - box.top) * k;
    return { x, y, vx: ((x - VFX_CURVE_EDGE) / span) * 255, vy: (1 - (y - VFX_CURVE_EDGE) / span) * 255 };
  };
  let held = null;       // the point being dragged: { rest: the others, at: its place among them }
  let lit = -1;          // the place of the point shown as taken hold of

  const draw = (curve) => {
    const ratio = Math.max(1, (doc.defaultView && doc.defaultView.devicePixelRatio) || 1);
    const size = Math.round(VFX_CURVE_SIZE * ratio);
    if (pad.width !== size) {
      pad.width = size;
      pad.height = size;
    }
    const ctx = pad.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, VFX_CURVE_SIZE, VFX_CURVE_SIZE);
    const lo = VFX_CURVE_EDGE;
    const hi = VFX_CURVE_EDGE + span;
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#3d3d47';
    ctx.beginPath();
    for (let i = 0; i <= 4; i += 1) {
      const at = Math.round(lo + (span * i) / 4) + 0.5;
      ctx.moveTo(at, lo);
      ctx.lineTo(at, hi);
      ctx.moveTo(lo, at);
      ctx.lineTo(hi, at);
    }
    ctx.stroke();
    // The diagonal: a curve on it changes nothing.
    ctx.strokeStyle = '#55555f';
    ctx.beginPath();
    ctx.moveTo(lo, hi);
    ctx.lineTo(hi, lo);
    ctx.stroke();
    const trace = (ch, alpha, width) => {
      const fn = vfxOps.smoothThrough(curve[ch]);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = VFX_CURVE_COLOURS[ch];
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = 0; x <= 255; x += 1) {
        const [px, py] = toPad([x, Math.min(255, Math.max(0, fn(x)))]);
        if (x === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    // The curves not chosen faintly behind, where they do something.
    for (const ch of timelineModel.VFX_CURVE_CHANNELS) {
      if (ch !== vfxCurveChannel && !curve[ch].every((p) => p[0] === p[1])) trace(ch, 0.4, 1);
    }
    trace(vfxCurveChannel, 1, 1.75);
    curve[vfxCurveChannel].forEach((p, i) => {
      const [px, py] = toPad(p);
      ctx.beginPath();
      ctx.arc(px, py, i === lit ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === lit ? '#ffffff' : VFX_CURVE_COLOURS[vfxCurveChannel];
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#16161a';
      ctx.stroke();
    });
  };

  /** The place of the chosen curve's point a press at `at` means, or -1. */
  const pointAt = (points, at) => {
    let best = -1;
    let dist = VFX_CURVE_REACH;
    points.forEach((p, i) => {
      const [px, py] = toPad(p);
      const d = Math.hypot(px - at.x, py - at.y);
      if (d <= dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };
  const put = (points) => change({ ...curveNow(), [vfxCurveChannel]: points });
  /** The dragged point where the pointer is: between its neighbours, or gone when far outside. */
  const dragTo = (evt) => {
    const at = placeOf(evt);
    const { rest, index } = held;
    const far = Math.max(-at.x, at.x - VFX_CURVE_SIZE, -at.y, at.y - VFX_CURVE_SIZE);
    if (far > VFX_CURVE_DROP && rest.length >= 2) {
      lit = -1;
      readout.textContent = '';
      put(rest);
      return;
    }
    const before = index > 0 ? rest[index - 1][0] + 1 : 0;
    const after = index < rest.length ? rest[index][0] - 1 : 255;
    const x = Math.round(Math.min(after, Math.max(before, at.vx)));
    const y = Math.round(Math.min(255, Math.max(0, at.vy)));
    lit = index;
    readout.textContent = x + ' → ' + y;
    put([...rest.slice(0, index), [x, y], ...rest.slice(index)]);
  };
  pad.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !vfxCurrent()) return;
    const points = curveNow()[vfxCurveChannel];
    const at = placeOf(evt);
    let index = pointAt(points, at);
    let rest = null;
    if (index >= 0) {
      rest = points.filter((p, i) => i !== index);
    } else {
      // A new point, where there is room for one between two others.
      const x = Math.round(Math.min(255, Math.max(0, at.vx)));
      if (points.length >= timelineModel.VFX_CURVE_POINTS) return;
      index = points.findIndex((p) => p[0] >= x);
      if (index < 0) index = points.length;
      const before = index > 0 ? points[index - 1][0] + 1 : 0;
      const after = index < points.length ? points[index][0] - 1 : 255;
      if (points[index] && points[index][0] === x) rest = points.filter((p, i) => i !== index);
      else if (after < before) return;
      else rest = points;
    }
    evt.preventDefault();
    held = { rest, index };
    pad.setPointerCapture(evt.pointerId);
    dragTo(evt);
  });
  pad.addEventListener('pointermove', (evt) => {
    if (held) {
      dragTo(evt);
      return;
    }
    const over = vfxCurrent() ? pointAt(curveNow()[vfxCurveChannel], placeOf(evt)) : -1;
    if (over !== lit) {
      lit = over;
      draw(curveNow());
    }
  });
  const letGo = (evt) => {
    if (!held) return;
    held = null;
    lit = -1;
    readout.textContent = '';
    if (pad.hasPointerCapture(evt.pointerId)) pad.releasePointerCapture(evt.pointerId);
    draw(curveNow());
  };
  pad.addEventListener('pointerup', letGo);
  pad.addEventListener('pointercancel', letGo);
  pad.addEventListener('pointerleave', () => {
    if (held || lit < 0) return;
    lit = -1;
    draw(curveNow());
  });
  pad.addEventListener('dblclick', (evt) => {
    if (!vfxCurrent()) return;
    const points = curveNow()[vfxCurveChannel];
    const index = pointAt(points, placeOf(evt));
    if (index < 0 || points.length <= 2) return;
    lit = -1;
    put(points.filter((p, i) => i !== index));
  });
  reset.addEventListener('click', () => {
    if (vfxCurrent()) put(flat());
  });
  vfxFields.push({
    s,
    keyed: false,
    show: (value) => {
      const curve = timelineModel.vfxCurveOf(value, s.def);
      for (const b of picks.children) b.classList.toggle('btn--active', b.dataset.channel === vfxCurveChannel);
      reset.disabled = curve[vfxCurveChannel].length === 2 && curve[vfxCurveChannel].every((p) => p[0] === p[1]);
      draw(curve);
    },
  });
  return row;
}

/** The settings as the chosen VFX has them, the keyed ones as they are at the playhead. */
function showVfxSettings(except) {
  const v = vfxCurrent();
  if (!v || !vfxFields.length) return;
  const now = vfxShown(v);
  for (const f of vfxFields) f.show(f.keyed ? now[f.s.id] : v[f.s.id], except);
}

/** The chosen VFX put back into the draft, changed. */
function setVfx(v) {
  if (!vfxDraft || vfxSel < 0) return;
  vfxDraft = vfxDraft.map((o, i) => (i === vfxSel ? v : o));
  showVfxSettings(null);
  placeVfxBoxes();
  paintVfxStage();
}

/** A setting that is the VFX's own changed: the same at every moment. */
function changeVfxStatic(props) {
  const v = vfxCurrent();
  if (v) setVfx({ ...v, ...props });
}

/**
 * A setting a keyframe holds changed, the area's box and turn among them.
 * It is the VFX's own while it has no keyframes; once it has, it is changed
 * at the playhead, in the keyframe there or in a new one made there, which
 * starts as the VFX is at that moment.
 */
function changeVfxKeyed(props) {
  const v = vfxCurrent();
  if (!v) return;
  if (!v.keys) {
    setVfx({ ...v, ...props });
    return;
  }
  const at = vfxLocalT();
  const near = timelineModel.vfxKeyNear(v, at, keyframeReach());
  setVfx(timelineModel.putVfxKey(v, {
    ...vfxShown(v),
    ...props,
    id: near ? near.id : newKeyframeId(),
    t: near ? near.t : at,
  }));
}

// Remove all VFX: every one goes and the window stays, final only with
// Apply, the user's "Remove All clears all and only gets final when applied".
vfxRemoveAllBtn.addEventListener('click', () => {
  if (!vfxDraft) return;
  vfxDraft = [];
  vfxSel = -1;
  vfxPreviewId = null;
  showVfxDraft();
  paintVfxStage();
});

// ---- the stage ----

/** The stage as big as its part of the window, which the layout decides. */
function sizeVfxStage() {
  const w = Math.max(40, vfxStageCell.clientWidth);
  const h = Math.max(40, vfxStageCell.clientHeight);
  vfxStage.style.width = w + 'px';
  vfxStage.style.height = h + 'px';
  vfxCanvas.style.left = '0px';
  vfxCanvas.style.top = '0px';
  vfxCanvas.style.width = w + 'px';
  vfxCanvas.style.height = h + 'px';
  const dpr = hostWindowOf(vfxStage).devicePixelRatio || 1;
  vfxCanvas.width = Math.max(1, Math.round(w * dpr));
  vfxCanvas.height = Math.max(1, Math.round(h * dpr));
  placeVfxBoxes();
}

/** The track's decoder when it has a frame to draw, or null. */
function vfxFrameSource() {
  const entry = decoders.get(vfxLayerId);
  if (!entry || !entry.width || !entry.height) return null;
  if (!entry.still && !(entry.el.readyState >= 2)) return null;
  return entry;
}

/**
 * The track's whole picture at the playhead with the draft's VFX on it, in
 * their order, over the checkerboard, and outside the picture dimmed. Drawn
 * by the preview's own maskedPicture, which is the drawing the main window
 * shows too.
 */
function paintVfxStage() {
  if (!vfxDraft || !vfxPic || vfxModal.hidden) return;
  const ctx = vfxCanvas.getContext('2d');
  const r = stageFrameRect(vfxStage);
  const dpr = vfxCanvas.width / Math.max(1, r.w);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, vfxCanvas.width, vfxCanvas.height);
  const fx = r.left * dpr;
  const fy = r.top * dpr;
  const fw = r.width * dpr;
  const fh = r.height * dpr;
  ctx.save();
  ctx.translate(fx, fy);
  ctx.fillStyle = checkerPattern(ctx, dpr);
  ctx.fillRect(0, 0, fw, fh);
  ctx.restore();
  const entry = vfxFrameSource();
  const live = timelineModel.layerById(layers, vfxLayerId);
  if (entry && live) {
    const W = vfxPic.width;
    const H = vfxPic.height;
    const k = Math.min(1, VFX_STAGE_MAX / Math.max(fw, fh));
    const shown = { ...live, mask: null, keyframes: [], vfx: vfxListOfDraft(vfxDraft) };
    // At the playhead's moment of the clip, as the VFX are then.
    const pic = maskedPicture(shown, entry.el, [0, 0, entry.width, entry.height],
      { dw: fw * k, dh: fh * k }, live.start + vfxLocalT(),
      { x: 0, y: 0, w: W, h: H, W, H, ex: entry.width / W, ey: entry.height / H });
    ctx.drawImage(pic.el, ...pic.from, fx, fy, fw, fh);
  }
  dimOutsideFrame(ctx, vfxCanvas, vfxStage);
}

/** A box on the stage: an area's, turned as the area is. */
function placeVfxNode(node, area, r) {
  const b = area.box;
  node.style.left = (r.left + b.x * r.s) + 'px';
  node.style.top = (r.top + b.y * r.s) + 'px';
  node.style.width = (b.w * r.s) + 'px';
  node.style.height = (b.h * r.s) + 'px';
  node.style.transform = area.rotation ? 'rotate(' + area.rotation + 'deg)' : '';
}

/** A crosshair on the stage: on a point of the picture, in its pixels. */
function placeVfxPoint(node, now, r) {
  node.style.left = (r.left + now.cx * r.s) + 'px';
  node.style.top = (r.top + now.cy * r.s) + 'px';
}

/**
 * The chosen VFX's area with its grips, and the others' as outlines. V5.1.4:
 * a kind about a point has a crosshair on its point instead, the chosen
 * one's to drag and the others' fainter, to click. A kind for the whole
 * picture has nothing here.
 */
function placeVfxBoxes() {
  if (!vfxDraft) return;
  const r = stageFrameRect(vfxStage);
  const chosen = vfxCurrent();
  const hasArea = (v) => !!v && timelineModel.vfxKind(v.kind).area;
  const hasPoint = (v) => !!v && timelineModel.vfxKind(v.kind).where === 'point';
  vfxBoxEl.hidden = !hasArea(chosen);
  vfxPointEl.hidden = !hasPoint(chosen);
  // V5.2. A Corner Pin's corners, each where it is at the playhead.
  const pins = chosen ? timelineModel.vfxKind(chosen.kind).pins || null : null;
  vfxPins.hidden = !pins;
  // An svg has no `hidden` of its own to set: the attribute is what the style goes by.
  vfxPinFrame.toggleAttribute('hidden', !pins);
  if (pins) {
    const now = vfxShown(chosen, false);
    const spots = pins.map(([x, y]) => [r.left + now[x] * r.s, r.top + now[y] * r.s]);
    spots.forEach(([x, y], i) => {
      const node = vfxPins.children[i];
      if (!node) return;
      node.style.left = x + 'px';
      node.style.top = y + 'px';
    });
    vfxPinFrame.firstElementChild.setAttribute('points', spots.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '));
  }
  // Each where it is at the playhead.
  if (hasArea(chosen)) placeVfxNode(vfxBoxEl, vfxShown(chosen, false), r);
  if (hasPoint(chosen)) placeVfxPoint(vfxPointEl, vfxShown(chosen, false), r);
  const doc = vfxOthers.ownerDocument;
  vfxOthers.replaceChildren(...vfxDraft.map((v, i) => {
    if (i === vfxSel || !(hasArea(v) || hasPoint(v))) return null;
    const node = doc.createElement('div');
    node.dataset.index = String(i);
    node.title = vfxLabel(i);
    if (hasPoint(v)) {
      node.className = 'vfx-point vfx-point--other';
      placeVfxPoint(node, vfxShown(v, false), r);
      return node;
    }
    node.className = 'vfx-area';
    placeVfxNode(node, vfxShown(v, false), r);
    return node;
  }).filter(Boolean));
  // And the strip, which shows the chosen one's keyframes and the playhead.
  vfxStrip.draw();
}

function showVfxGuides(x, y) {
  const r = stageFrameRect(vfxStage);
  vfxGuideX.hidden = x === null;
  vfxGuideY.hidden = y === null;
  if (x !== null) {
    vfxGuideX.style.left = (r.left + x * r.s) + 'px';
    vfxGuideX.style.top = r.top + 'px';
    vfxGuideX.style.height = r.height + 'px';
  }
  if (y !== null) {
    vfxGuideY.style.top = (r.top + y * r.s) + 'px';
    vfxGuideY.style.left = r.left + 'px';
    vfxGuideY.style.width = r.width + 'px';
  }
}

// The wheel zooms and empty space pans, as on the other stages, in the
// picture's own pixels.
bindStageView(vfxStage, {
  open: () => !!vfxDraft && !vfxModal.hidden,
  empty: (evt) => evt.target === vfxStage || evt.target === vfxCanvas,
  redraw: () => {
    placeVfxBoxes();
    paintVfxStage();
  },
  size: () => vfxPic,
});

// A press on an area while the project plays stops it first: a VFX with
// keyframes is changed at the playhead, and a playhead on its way would
// leave a keyframe at every moment the drag passed through. Captured, so the
// press's own handler starts from the picture as it stopped.
vfxStage.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || !compositePlaying || !vfxDraft) return;
  if (evt.target === vfxStage || evt.target === vfxCanvas) return;
  pauseComposite();
  followVfxPlayhead();
}, true);

// ---- the keyframe strip: the chosen VFX's keyframes ----
//
// The strip the other editor windows have (keystrip.js), under the picture.
// What it shows and changes is the chosen VFX's own keyframes, in the draft;
// the playhead on it is the timeline's.

/** The window brought up to the playhead as it now is. */
function followVfxPlayhead() {
  vfxSeenAt = compositeAt;
  vfxSettleUntil = performance.now() + VFX_SETTLE_MS;
  placeVfxBoxes();
  showVfxSettings(null);
  paintVfxStage();
}

/** The playhead put on `at` of the clip, and the window with it. */
function seekVfxClip(at) {
  const live = timelineModel.layerById(layers, vfxLayerId);
  if (!live) return;
  seekComposite(live.start + at);
  updatePlayhead();
  followVfxPlayhead();
}

const vfxStrip = makeKeyStrip(vfxKeys, vfxKeysReadout, vfxKeysCanvas, {
  state: () => {
    if (vfxModal.hidden || !vfxDraft) return null;
    const live = timelineModel.layerById(layers, vfxLayerId);
    if (!live) return null;
    const v = vfxCurrent();
    return {
      layer: live,
      keys: v && v.keys ? v.keys : [],
      editing: vfxKeyEditing(),
      width: Math.max(40, (vfxKeys.parentNode.clientWidth || 1) - 2),
      lower: !timelineModel.isStill(live),
    };
  },
  // A keyframe pressed: the playhead goes to it, which makes it the one edited.
  pick: (id) => {
    const v = vfxCurrent();
    const k = v && v.keys ? v.keys.find((o) => o.id === id) : null;
    if (k) seekVfxClip(k.t);
  },
  // Dragged along the clip, the playhead and the picture with it.
  move: (id, at) => {
    const v = vfxCurrent();
    const live = timelineModel.layerById(layers, vfxLayerId);
    if (!v || !v.keys || !live) return;
    const next = timelineModel.moveVfxKey(v, id, at, live.duration);
    const k = next.keys.find((o) => o.id === id);
    setVfx(next);
    if (k) seekVfxClip(k.t);
  },
  moved: () => {},
  scrub: (at) => seekVfxClip(at),
  scrubbed: () => {},
  /**
   * A double click on the bar: a keyframe there for the chosen VFX, as the
   * VFX is at that moment, so it changes nothing until it is edited. The
   * first one a VFX gets puts one at the clip's very start as well, the
   * user's rule for a clip's first keyframe.
   */
  add: (at) => {
    const v = vfxCurrent();
    if (!v) return;
    const reach = keyframeReach();
    const near = timelineModel.vfxKeyNear(v, at, reach);
    if (near) {
      seekVfxClip(near.t);
      return;
    }
    let next = v;
    if (!v.keys && at > reach) next = timelineModel.putVfxKey(next, { ...v, id: newKeyframeId(), t: 0 });
    const there = timelineModel.vfxValuesAt(next, at);
    const whole = {};
    for (const [id, value] of Object.entries(there)) {
      whole[id] = id === 'box'
        ? { x: Math.round(value.x), y: Math.round(value.y), w: Math.max(1, Math.round(value.w)), h: Math.max(1, Math.round(value.h)) }
        : Math.round(value) || 0;
    }
    next = timelineModel.putVfxKey(next, { ...whole, id: newKeyframeId(), t: at });
    setVfx(next);
    seekVfxClip(at);
  },
  // A right click on a keyframe deletes it, by the model's rules: the last
  // pair leaves the VFX as its first keyframe had it.
  remove: (id) => {
    const v = vfxCurrent();
    if (!v || !v.keys) return;
    setVfx(timelineModel.removeVfxKey(v, id));
  },
});

// ---- the chosen VFX's area: a shape's grips, in the picture's pixels ----

function setVfxBox(box) {
  changeVfxKeyed({ box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) } });
}

// A side stretches the area, landing on the picture's edges and middle; Shift
// takes the opposite side along. A turned area's side moves along its own axis.
for (const grip of vfxBoxEl.querySelectorAll('.crop-grip')) {
  const edge = grip.dataset.edge;
  const vertical = edge === 'top' || edge === 'bottom';
  grip.addEventListener('pointerdown', (evt) => {
    const area = vfxAreaNow();
    if (evt.button !== 0 || !area) return;
    // Or the box underneath would take it as a move as well.
    evt.stopPropagation();
    const start = { ...area.box };
    const s = stageFrameRect(vfxStage).s;
    const turn = area.rotation;
    const a = turn * Math.PI / 180;
    const ux = vertical ? -Math.sin(a) : Math.cos(a);
    const uy = vertical ? Math.cos(a) : Math.sin(a);
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    beginDrag(grip, evt, (ev) => {
      if (turn) {
        const along = ((ev.clientX - x0) * ux + (ev.clientY - y0) * uy) / s;
        setVfxBox(layerGeometry.textBoxEdgeTurned(start, edge, along, ev.shiftKey, turn, vfxPic).box);
        return;
      }
      const travel = ((vertical ? ev.clientY : ev.clientX) - (vertical ? y0 : x0)) / s;
      const r = layerGeometry.textBoxEdge(start, edge, travel, ev.shiftKey, vfxPic, TEXT_BOX_SNAP / s);
      showVfxGuides(vertical ? null : r.snap, vertical ? r.snap : null);
      setVfxBox(r.box);
    }, () => showVfxGuides(null, null));
  });
}

// A corner sizes the two sides it joins, freely, since an area is whatever
// rectangle covers the thing; Shift moves the opposite sides along as well.
for (const corner of vfxBoxEl.querySelectorAll('.crop-corner')) {
  const name = corner.dataset.corner;
  const sideH = name.includes('l') ? 'left' : 'right';
  const sideV = name.includes('t') ? 'top' : 'bottom';
  corner.addEventListener('pointerdown', (evt) => {
    const area = vfxAreaNow();
    if (evt.button !== 0 || !area) return;
    evt.stopPropagation();
    const start = { ...area.box };
    const s = stageFrameRect(vfxStage).s;
    const turn = area.rotation;
    const a = turn * Math.PI / 180;
    const x0 = evt.clientX;
    const y0 = evt.clientY;
    beginDrag(corner, evt, (ev) => {
      const dx = (ev.clientX - x0) / s;
      const dy = (ev.clientY - y0) / s;
      if (turn) {
        const h = layerGeometry.textBoxEdgeTurned(start, sideH, dx * Math.cos(a) + dy * Math.sin(a),
          ev.shiftKey, turn, vfxPic).box;
        setVfxBox(layerGeometry.textBoxEdgeTurned(h, sideV, -dx * Math.sin(a) + dy * Math.cos(a),
          ev.shiftKey, turn, vfxPic).box);
        return;
      }
      const reach = TEXT_BOX_SNAP / s;
      const h = layerGeometry.textBoxEdge(start, sideH, dx, ev.shiftKey, vfxPic, reach);
      const v = layerGeometry.textBoxEdge(h.box, sideV, dy, ev.shiftKey, vfxPic, reach);
      showVfxGuides(h.snap, v.snap);
      setVfxBox(v.box);
    }, () => showVfxGuides(null, null));
  });
}

/** The chosen VFX's area moved by a drag that began at `evt`. */
function dragVfxArea(evt) {
  const area = vfxAreaNow();
  if (!area) return;
  const start = { ...area.box };
  const s = stageFrameRect(vfxStage).s;
  const x0 = evt.clientX;
  const y0 = evt.clientY;
  // Turned, only its centre lands on the picture's lines, as a turned shape's.
  const move = area.rotation ? layerGeometry.textBoxMoveTurned : layerGeometry.textBoxMove;
  beginDrag(vfxBoxEl, evt, (ev) => {
    const r = move(start, (ev.clientX - x0) / s, (ev.clientY - y0) / s, vfxPic, TEXT_BOX_SNAP / s);
    showVfxGuides(r.snapX, r.snapY);
    setVfxBox(r.box);
  }, () => showVfxGuides(null, null));
}

vfxBoxEl.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || evt.target !== vfxBoxEl) return;
  dragVfxArea(evt);
});

// Another VFX's area pressed: it is the chosen one from then on, and the
// same press goes on to move it. Its crosshair the same.
vfxOthers.addEventListener('pointerdown', (evt) => {
  const node = evt.target.closest && evt.target.closest('.vfx-area, .vfx-point');
  if (evt.button !== 0 || !node || !vfxDraft) return;
  selectVfx(Number(node.dataset.index));
  if (node.classList.contains('vfx-point')) dragVfxPoint(evt);
  else dragVfxArea(evt);
});

// ---- V5.1.4. the chosen VFX's point: a crosshair, in the picture's pixels ----

/** The chosen VFX's point as it is at the playhead, { cx, cy } in whole pixels, or null. */
function vfxPointNow() {
  const v = vfxCurrent();
  if (!v || timelineModel.vfxKind(v.kind).where !== 'point') return null;
  const now = vfxShown(v);
  return { cx: now.cx, cy: now.cy };
}

/**
 * The chosen VFX's point moved by a drag that began at `evt`. It stays on
 * the picture and lands on its middle and its edges, as a box does. With
 * keyframes it is changed at the playhead, like every setting a keyframe
 * holds.
 */
function dragVfxPoint(evt) {
  if (vfxPointNow()) dragVfxSpot(vfxPointEl, evt, 'cx', 'cy', 0, 1);
}

/**
 * V5.2. A place on the picture that the chosen VFX keeps as two figures,
 * `xi` and `yi`, moved by a drag of `node` that began at `evt`: a
 * point's crosshair, or one corner of a Corner Pin. Held to `lo` to `hi`
 * of the picture's width and height, and landing on its middle and edges.
 */
function dragVfxSpot(node, evt, xi, yi, lo, hi) {
  const first = vfxCurrent();
  if (!first) return;
  const start = vfxShown(first);
  const s = stageFrameRect(vfxStage).s;
  const x0 = evt.clientX;
  const y0 = evt.clientY;
  const reach = TEXT_BOX_SNAP / s;
  const land = (at, size) => {
    const held = Math.min(size * hi, Math.max(size * lo, at));
    const line = [0, size / 2, size].find((to) => Math.abs(held - to) <= reach);
    return line === undefined ? { at: Math.round(held), snap: null } : { at: Math.round(line), snap: line };
  };
  beginDrag(node, evt, (ev) => {
    const x = land(start[xi] + (ev.clientX - x0) / s, vfxPic.width);
    const y = land(start[yi] + (ev.clientY - y0) / s, vfxPic.height);
    showVfxGuides(x.snap, y.snap);
    const v = vfxCurrent();
    if (!v) return;
    const now = vfxShown(v);
    if (now[xi] !== x.at || now[yi] !== y.at) changeVfxKeyed({ [xi]: x.at, [yi]: y.at });
  }, () => showVfxGuides(null, null));
}

// V5.2. A corner of a Corner Pin pressed: it goes where it is dragged, also
// off the picture by up to half of it.
vfxPins.addEventListener('pointerdown', (evt) => {
  const node = evt.target.closest && evt.target.closest('.vfx-pin');
  const v = vfxCurrent();
  const pins = v ? timelineModel.vfxKind(v.kind).pins : null;
  const pair = node && pins ? pins[Number(node.dataset.pin)] : null;
  if (evt.button !== 0 || !pair) return;
  dragVfxSpot(node, evt, pair[0], pair[1], -0.5, 1.5);
});

vfxPointEl.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  dragVfxPoint(evt);
});

// The dot turns the area about its box's centre, by as far as the pointer
// goes round it, in whole degrees, landing on a quarter turn within two of
// one; the angle shows by the centre meanwhile.
vfxRotor.addEventListener('pointerdown', (evt) => {
  const area = vfxAreaNow();
  if (evt.button !== 0 || !area) return;
  evt.stopPropagation();
  const b = area.box;
  const r = stageFrameRect(vfxStage);
  const stage = vfxStage.getBoundingClientRect();
  const cx = stage.left + vfxStage.clientLeft + r.left + (b.x + b.w / 2) * r.s;
  const cy = stage.top + vfxStage.clientTop + r.top + (b.y + b.h / 2) * r.s;
  const start = area.rotation;
  const from = [evt.clientX - cx, evt.clientY - cy];
  vfxAngle.style.left = (cx - stage.left) + 'px';
  vfxAngle.style.top = (cy - stage.top) + 'px';
  vfxAngle.textContent = start + '°';
  vfxAngle.hidden = false;
  beginDrag(vfxRotor, evt, (ev) => {
    const deg = layerGeometry.textTurnDrag(start, from, [ev.clientX - cx, ev.clientY - cy]);
    vfxAngle.textContent = deg + '°';
    const now = vfxAreaNow();
    if (now && deg !== now.rotation) changeVfxKeyed({ rotation: deg });
  }, () => {
    vfxAngle.hidden = true;
  });
});

window.addEventListener('resize', () => {
  if (vfxModal.hidden || !vfxDraft) return;
  sizeVfxStage();
  paintVfxStage();
});

vfxApplyBtn.addEventListener('click', applyVfx);
vfxCancelBtn.addEventListener('click', cancelVfx);

bindPopup(vfxModal, cancelVfx);
