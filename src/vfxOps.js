'use strict';

// V5.1. What each kind of VFX does to a picture, written once.
//
// A VFX is drawn twice: by the preview, on the graphics card, and by the
// export, in the encoder's filters. The two agree only when both are told the
// same thing, so neither is told by the kind. Each kind's row here turns its
// settings as they are at one moment into a short list of plain steps, "ops",
// in the source picture's own pixels, and both sides only know the ops:
// `filtersOf` writes them as the encoder's filters, and the preview's shaders
// (renderer/app/vfxGl.js) each do what one op's filter does. A new kind that
// gets by with the ops there are is a row here and nothing else to prove.
//
// The ops:
//   colour  a table per channel, then the three channels mixed, then a table
//           again, each part optional. A table is an expression of `val`, 0
//           to 255, in the encoder's own expression language (lutrgb), and
//           `tableOf` works the very same expression out here, so the preview
//           looks up what the encoder looks up. The mix is colorchannelmixer's
//           nine figures, each held to its -2 to 2.
//   hold    one colour kept and the rest made grey (colorhold).
//   conv    a 3 by 3 kernel of whole numbers with a divisor (convolution).
//   sobel   the Sobel edge strength of each channel.
//   blur    a Gaussian, a sigma across and one down (gblur).
//   shift   red and blue moved apart by whole pixels (rgbashift).
//   lens    barrel or pincushion (lenscorrection).
//   flip    across, down or both.
//   mirror  one half folded onto the other.
//   grid    dark lines at a spacing (drawgrid).
//   noise   grain on the brightness, or on brightness and colour (noise).
//   glow    the bright parts blurred and laid back on by screen.
//   clarity the picture's detail at one size, taken out, scaled and put back
//           (a blur, blend=grainextract, a table, blend=grainmerge).
//   bars    black bars at two facing edges (drawbox).
//   scroll  the picture moved round, what leaves one edge entering at the
//           other (scroll).
//   comic   the picture in few levels with its outlines inked on (a table, the
//           Sobel strength of its grey turned round, blend=multiply).
//   frame   a border of one colour along the picture's edges (drawbox).
//   rotate  turned about its middle, the corners that leave the picture
//           lost and what comes in black (rotate).
//   lut3d   the colours looked up in a table of the user's own, a .cube
//           file (lut3d); the preview reads the same file into a texture.
//   warp    every pixel taken from somewhere else in the picture, by a rule
//           of where it lies and of the clip's time (geq): a wave, rings, a
//           swirl, a zoom, a shake, slices pushed aside. The one op the
//           encoder works out pixel by pixel, so the slowest to export.
//   format  nothing to see: from here on the encoder works on the picture's
//           brightness and colour planes, or on red, green and blue again.

const vfxOps = (() => {
  // ---- the encoder's expressions, worked out here ----

  const FUNCS = {
    clip: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
    pow: (a, b) => Math.pow(a, b),
    if: (c, a, b) => (c ? a : (b === undefined ? 0 : b)),
    gt: (a, b) => (a > b ? 1 : 0),
    gte: (a, b) => (a >= b ? 1 : 0),
    lt: (a, b) => (a < b ? 1 : 0),
    lte: (a, b) => (a <= b ? 1 : 0),
    eq: (a, b) => (a === b ? 1 : 0),
    floor: Math.floor,
    ceil: Math.ceil,
    trunc: Math.trunc,
    // The encoder's round is C's: halves go away from zero.
    round: (x) => (x < 0 ? -Math.round(-x) : Math.round(x)),
    min: Math.min,
    max: Math.max,
    abs: Math.abs,
    exp: Math.exp,
    log: Math.log,
    sqrt: Math.sqrt,
    sin: Math.sin,
    cos: Math.cos,
    mod: (a, b) => a % b,
  };

  /** An expression of `val` as a function of it. Only what the rows below write. */
  function compile(text) {
    const src = String(text);
    let i = 0;
    const peek = () => src[i];
    const skip = () => { while (src[i] === ' ') i += 1; };
    function primary() {
      skip();
      const c = peek();
      if (c === '(') {
        i += 1;
        const e = expr();
        skip();
        if (peek() !== ')') throw new Error('vfxOps: ) expected in ' + src);
        i += 1;
        return e;
      }
      if (c === '-') {
        i += 1;
        const e = primary();
        return (v) => -e(v);
      }
      const num = /^[0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?/i.exec(src.slice(i));
      if (num) {
        i += num[0].length;
        const n = Number(num[0]);
        return () => n;
      }
      const id = /^[a-z_][a-z0-9_]*/i.exec(src.slice(i));
      if (!id) throw new Error('vfxOps: cannot read ' + src + ' at ' + i);
      i += id[0].length;
      skip();
      if (peek() !== '(') {
        if (id[0] !== 'val') throw new Error('vfxOps: unknown name ' + id[0]);
        return (v) => v;
      }
      i += 1;
      const args = [];
      skip();
      if (peek() !== ')') {
        for (;;) {
          args.push(expr());
          skip();
          if (peek() === ',') {
            i += 1;
            continue;
          }
          break;
        }
      }
      if (peek() !== ')') throw new Error('vfxOps: ) expected after ' + id[0]);
      i += 1;
      const fn = FUNCS[id[0]];
      if (!fn) throw new Error('vfxOps: unknown function ' + id[0]);
      return (v) => fn(...args.map((a) => a(v)));
    }
    function term() {
      let left = primary();
      for (;;) {
        skip();
        const c = peek();
        if (c !== '*' && c !== '/') return left;
        i += 1;
        const a = left;
        const b = primary();
        left = c === '*' ? (v) => a(v) * b(v) : (v) => a(v) / b(v);
      }
    }
    function expr() {
      let left = term();
      for (;;) {
        skip();
        const c = peek();
        if (c !== '+' && c !== '-') return left;
        i += 1;
        const a = left;
        const b = term();
        left = c === '+' ? (v) => a(v) + b(v) : (v) => a(v) - b(v);
      }
    }
    const out = expr();
    skip();
    if (i < src.length) throw new Error('vfxOps: left over in ' + src);
    return out;
  }

  const tables = new Map();
  /**
   * The 256 values an expression gives, as the encoder's lutrgb keeps them:
   * cut to a whole number towards zero and held to 0 to 255.
   */
  function tableOf(text) {
    let t = tables.get(text);
    if (t) return t;
    const fn = compile(text);
    t = new Uint8Array(256);
    for (let v = 0; v < 256; v += 1) {
      const r = fn(v);
      t[v] = Number.isFinite(r) ? Math.min(255, Math.max(0, Math.trunc(r))) : 0;
    }
    if (tables.size > 4000) tables.clear();
    tables.set(text, t);
    return t;
  }

  // ---- what the rows are written with ----

  /** A figure as the encoder is handed it: no more decimals than matter. */
  function num(x) {
    const n = Number((Number(x) || 0).toPrecision(6));
    return String(n === 0 ? 0 : n);
  }

  const all = (e) => [e, e, e];
  const LUM = [0.2126, 0.7152, 0.0722];
  const GREY = [...LUM, ...LUM, ...LUM];
  const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];

  /** The colours pulled towards grey, 0, or pushed from it, up to 2. */
  function saturate(s) {
    const [r, g, b] = LUM;
    return [
      r + (1 - r) * s, g * (1 - s), b * (1 - s),
      r * (1 - s), g + (1 - g) * s, b * (1 - s),
      r * (1 - s), g * (1 - s), b + (1 - b) * s,
    ];
  }

  /** The hues turned by `deg`, the brightness kept. */
  function hueTurn(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
      0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
      0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283,
      0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
    ];
  }

  /** Two mixes as one: `a` first, then `b`. */
  function mixThen(a, b) {
    const out = [];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) {
        out.push(b[r * 3] * a[c] + b[r * 3 + 1] * a[3 + c] + b[r * 3 + 2] * a[6 + c]);
      }
    }
    return out;
  }

  const gains = (r, g, b) => [r, 0, 0, 0, g, 0, 0, 0, b];

  /** A mix as the encoder takes it: each figure within -2 to 2, a few decimals. */
  function mixOf(m) {
    return m.map((x) => Math.round(Math.min(2, Math.max(-2, x)) * 1e4) / 1e4);
  }

  /** A curve through points, straight between them, as one expression. */
  function curve(points) {
    const p = points.map(([x, y]) => [Math.round(x), Math.round(y)]);
    const seg = (a, b) => num(a[1]) + '+(val-' + num(a[0]) + ')*' + num((b[1] - a[1]) / Math.max(1, b[0] - a[0]));
    let out = seg(p[p.length - 2], p[p.length - 1]);
    for (let i = p.length - 3; i >= 0; i -= 1) out = 'if(lt(val,' + num(p[i + 1][0]) + '),' + seg(p[i], p[i + 1]) + ',' + out + ')';
    return out;
  }

  const contrast = (k) => 'clip((val-128)*' + num(k) + '+128,0,255)';

  /** '#rrggbb' as three channels 0 to 255. */
  function rgbOf(hex, fallback) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(String(hex || ''));
    if (!m) return fallback || [255, 255, 255];
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  /** A pure hue as three channels 0 to 1. */
  function hueRgb(h) {
    const x = (((Number(h) || 0) % 360) + 360) % 360 / 60;
    const f = (n) => {
      const k = (n + x) % 6;
      return 1 - Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  const colour = (a, m, b) => ({ op: 'colour', a: a || null, m: m ? mixOf(m) : null, b: b || null });

  // The palettes of Thermal Camera: brightness 0 to 255 to a colour.
  const PALETTES = {
    iron: [[0, 0, 0, 0], [40, 30, 0, 120], [100, 170, 0, 150], [160, 240, 90, 0], [215, 255, 210, 20], [255, 255, 255, 255]],
    rainbow: [[0, 0, 0, 140], [64, 0, 150, 255], [128, 0, 220, 60], [192, 255, 230, 0], [255, 255, 20, 0]],
    ice: [[0, 0, 0, 20], [90, 10, 60, 170], [170, 60, 190, 235], [255, 240, 255, 255]],
  };
  const PALETTE_IDS = Object.keys(PALETTES);

  // The looks of Film Look: tables first, then a mix, then tables.
  const LOOKS = {
    tealorange: () => colour([
      curve([[0, 0], [64, 50], [128, 136], [192, 216], [255, 255]]),
      curve([[0, 8], [128, 128], [255, 246]]),
      curve([[0, 36], [64, 82], [128, 126], [192, 168], [255, 214]]),
    ], saturate(1.15), null),
    bleach: () => colour(null, saturate(0.4), all(contrast(1.4))),
    vintage: () => colour([curve([[0, 30], [255, 250]]), curve([[0, 20], [255, 235]]), curve([[0, 40], [255, 200]])],
      saturate(0.75), null),
    cross: () => colour([
      curve([[0, 0], [64, 40], [192, 222], [255, 255]]),
      curve([[0, 0], [64, 56], [192, 206], [255, 255]]),
      curve([[0, 40], [255, 215]]),
    ], null, null),
    cool: () => colour(null, mixThen(saturate(0.9), gains(0.9, 1, 1.15)), null),
    warm: () => colour(null, gains(1.12, 1.03, 0.85), null),
    noir: () => colour(null, GREY, all(contrast(1.5))),
    faded: () => colour(all('30+val*0.82'), saturate(0.8), null),
    matrix: () => colour(all(contrast(1.15)), mixThen(saturate(0.7), gains(0.75, 1.1, 0.7)), null),
    sunset: () => colour([curve([[0, 10], [128, 150], [255, 255]]), curve([[0, 0], [128, 120], [255, 240]]),
      curve([[0, 20], [128, 100], [255, 200]])], saturate(1.2), null),
    moon: () => colour(null, mixThen(saturate(0.45), gains(0.82, 0.95, 1.2)), all(contrast(1.2))),
    pastel: () => colour(all('44+val*0.76'), saturate(0.85), null),
  };
  const LOOK_IDS = Object.keys(LOOKS);

  const EDGE_STYLES = ['neon', 'sketch', 'mono'];
  const FLIP_MODES = ['across', 'down', 'both', 'left', 'right', 'top', 'bottom', 'quad'];
  // Channel Swap: which of red, green and blue each of the three is made of.
  const CHANNEL_ORDERS = {
    rbg: [0, 2, 1], grb: [1, 0, 2], gbr: [1, 2, 0], brg: [2, 0, 1], bgr: [2, 1, 0],
  };
  const CHANNEL_ORDER_IDS = Object.keys(CHANNEL_ORDERS);
  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /** A mix part of the way from leaving the colours as they are, 0, to `m`, 1. */
  const mixPart = (m, a) => m.map((x, i) => IDENTITY[i] + (x - IDENTITY[i]) * a);
  const YUV = { op: 'format', to: 'yuv' };
  const RGB = { op: 'format', to: 'rgb' };

  /**
   * The middle of a VFX's area in the source picture, as a pixel's place
   * (the first pixel is 0), to half a pixel: what a kind that bends the
   * picture about a point bends it about. The picture's own middle for an
   * area that is all of it, which is what a new one starts as. So a Zoom in
   * a small circle is a magnifying glass over what the circle is on, and a
   * Swirl on a face turns about the face.
   *
   * V5.1.4. A kind about a point of its own (timeline.js `where: 'point'`)
   * says the point itself, `cx` and `cy` as fractions of the picture.
   */
  function midOf(v, W, H) {
    const a = v && Array.isArray(v.areas) ? v.areas[0] : null;
    const b = a && a.box ? a.box : { x: 0, y: 0, w: 1, h: 1 };
    const own = !!v && Number.isFinite(v.cx) && Number.isFinite(v.cy);
    const x = own ? v.cx : b.x + b.w / 2;
    const y = own ? v.cy : b.y + b.h / 2;
    return {
      cx: Math.round((x * W - 0.5) * 2) / 2,
      cy: Math.round((y * H - 0.5) * 2) / 2,
    };
  }

  /**
   * The blur of a strength for a picture `H` high, the sigma in its pixels:
   * timeline.js obscureSigma's rule, written again so this file stands alone.
   */
  const sigmaOf = (strength, H) => Math.max(0.5, H * strength * 0.0005);

  // ---- the kinds ----
  //
  // Each row: the settings as they are at one moment (timeline.js vfxAt) and
  // the source picture's size to the ops. Figures that only place the VFX
  // (its area, Mix, Soft Edge) are not read here.
  const KINDS = {
    brightness: (v) => {
      const k = v.contrast >= 0 ? 1 + v.contrast / 50 : 1 + v.contrast / 100;
      return [colour(all('clip((val-128)*' + num(k) + '+128+' + num(v.brightness * 1.275) + ',0,255)'))];
    },
    exposure: (v) => [colour(all('255*pow(clip(val*' + num(Math.pow(2, v.exposure / 100) / 255) + ',0,1),'
      + num(100 / Math.max(10, v.gamma)) + ')'))],
    huesat: (v) => [colour(null, mixThen(hueTurn(v.hue), saturate(1 + v.saturation / 100)))],
    temperature: (v) => {
      const t = v.temperature / 100;
      const k = v.tint / 100;
      return [colour(null, gains(1 + 0.25 * t + 0.1 * k, 1 - 0.2 * k, 1 - 0.25 * t + 0.1 * k))];
    },
    rgb: (v) => [colour(null, gains(1 + v.red / 100, 1 + v.green / 100, 1 + v.blue / 100))],
    levels: (v) => {
      const lo = v.black * 2.55;
      const hi = Math.max(lo + 1, v.white * 2.55);
      const a = v.outBlack * 2.55;
      const b = v.outWhite * 2.55;
      return [colour(all(num(a) + '+' + num(b - a) + '*pow(clip((val-' + num(lo) + ')*' + num(1 / (hi - lo)) + ',0,1),'
        + num(100 / Math.max(10, v.gamma)) + ')'))];
    },
    mono: (v) => {
      const w = [v.red / 100, v.green / 100, v.blue / 100];
      return [colour(null, [...w, ...w, ...w])];
    },
    sepia: () => [colour(null, SEPIA)],
    colorize: (v) => {
      const s = v.saturation / 100;
      const mid = hueRgb(v.hue).map((c) => 127.5 + s * (c * 255 - 127.5));
      return [colour(null, GREY, mid.map((m) => 'if(lt(val,127.5),val*' + num(m / 127.5) + ','
        + num(m) + '+(val-127.5)*' + num((255 - m) / 127.5) + ')'))];
    },
    duotone: (v) => {
      const a = rgbOf(v.shadows, [20, 20, 80]);
      const b = rgbOf(v.highlights, [255, 220, 120]);
      return [colour(null, GREY, a.map((x, i) => num(x) + '+val*' + num((b[i] - x) / 255)))];
    },
    invert: () => [colour(all('255-val'))],
    posterize: (v) => {
      const n = Math.max(2, Math.round(v.levels));
      return [colour(all('floor(val*' + n + '/256)*' + num(255 / (n - 1))))];
    },
    threshold: (v) => [colour(null, GREY, all('if(gte(val,' + num(v.level * 2.55) + '),255,0)'))],
    solarize: (v) => [colour(all('if(gt(val,' + num(v.level * 2.55) + '),255-val,val)'))],
    nightvision: (v) => {
      const g = v.gain / 100;
      return [colour(null, [...LUM.map((x) => x * g * 0.15), ...LUM.map((x) => x * g), ...LUM.map((x) => x * g * 0.25)])];
    },
    thermal: (v) => {
      const stops = PALETTES[v.palette] || PALETTES.iron;
      return [colour(null, GREY, [1, 2, 3].map((c) => curve(stops.map((s) => [s[0], s[c]]))))];
    },
    look: (v) => [(LOOKS[v.look] || LOOKS.tealorange)()],
    colorpass: (v) => [{
      op: 'hold',
      color: rgbOf(v.color, [255, 0, 0]),
      sim: Math.min(1, Math.max(0.01, v.range / 100)),
      blend: Math.min(1, Math.max(0, v.softness / 100)),
    }],
    vignette: (v) => {
      const a = v.amount / 100;
      return [colour(all(a >= 0 ? 'val*' + num(1 - a) : 'val+(255-val)*' + num(-a)))];
    },
    sharpen: (v) => {
      const a = Math.round(v.amount * 0.64);
      return [{ op: 'conv', k: [-a, -2 * a, -a, -2 * a, 256 + 12 * a, -2 * a, -a, -2 * a, -a], div: 256 }];
    },
    emboss: (v) => {
      const a = Math.round(v.amount * 0.32);
      return [{ op: 'conv', k: [-2 * a, -a, 0, -a, 16, a, 0, a, 2 * a], div: 16 }];
    },
    edges: (v) => {
      const sobel = { op: 'sobel', scale: Math.round(v.intensity) / 100 };
      if (v.style === 'sketch') return [colour(null, GREY), sobel, colour(all('255-val'))];
      if (v.style === 'mono') return [colour(null, GREY), sobel];
      return [sobel];
    },
    glow: (v, W, H) => {
      const t = Math.min(250, v.threshold * 2.55);
      const tint = rgbOf(v.color, [255, 255, 255]);
      return [{
        op: 'glow',
        tables: tint.map((c) => 'clip((val-' + num(t) + ')*' + num((255 / (255 - t)) * (v.intensity / 100) * (c / 255)) + ',0,255)'),
        sigma: Math.max(0.5, Math.round(v.radius * H * 2) / 2),
      }];
    },
    // ---- V5.1, the second lot ----
    shadows: (v) => {
      const s = v.shadows / 100;
      const h = v.highlights / 100;
      return [colour(all(curve([[0, 0], [64, 64 + 40 * s], [128, 128 + 10 * (s + h)], [192, 192 + 40 * h], [255, 255]])))];
    },
    channels: (v) => {
      const order = CHANNEL_ORDERS[v.order] || CHANNEL_ORDERS.bgr;
      const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      order.forEach((from, to) => { m[to * 3 + from] = 1; });
      return [colour(null, m)];
    },
    splittone: (v) => {
      const a = (v.amount / 100) * 0.6;
      const lo = rgbOf(v.shadows, [30, 90, 140]);
      const hi = rgbOf(v.highlights, [255, 176, 96]);
      // Each channel pulled towards the shadow colour where it is dark and
      // towards the highlight colour where it is bright.
      return [colour(lo.map((s, i) => {
        const A = (a * (s - 128)) / 255;
        const B = (a * (hi[i] - 128)) / 255;
        return 'clip(val*' + num(1 + B - A) + (A < 0 ? '-' + num(-255 * A) : '+' + num(255 * A)) + ',0,255)';
      }))];
    },
    clarity: (v, W, H) => [{
      op: 'clarity',
      k: Math.round(v.amount) / 100,
      sigma: Math.max(0.5, Math.round(v.radius * H * 2) / 2),
    }],
    dream: (v, W, H) => {
      const a = v.amount / 100;
      const t = 'val*' + num(0.7 * a);
      return [
        { op: 'glow', tables: [t, t, t], sigma: Math.max(1, Math.round(H * 0.025 * (0.5 + a) * 2) / 2) },
        colour(null, saturate(1 + 0.25 * a)),
      ];
    },
    vhs: (v, W, H) => {
      const a = v.amount / 100;
      return [
        colour(null, saturate(1 + 0.3 * a), all(num(14 * a) + '+val*' + num(1 - 0.1 * a))),
        { op: 'shift', dx: Math.max(1, Math.round(H * 0.004 * a)), dy: 0 },
        YUV,
        { op: 'blur', sx: Math.max(0.5, Math.round(H * 0.0016 * a * 4) / 4), sy: 0 },
        { op: 'grid', period: 4, thick: 1, alpha: Math.round(30 * a) / 100, vertical: false },
        { op: 'noise', s: Math.max(1, Math.round(22 * a)), chroma: true },
      ];
    },
    crt: (v, W, H) => {
      const a = v.amount / 100;
      return [
        { op: 'shift', dx: Math.max(1, Math.round(H * 0.002 * a)), dy: 0 },
        YUV,
        { op: 'grid', period: 3, thick: 1, alpha: Math.round(45 * a) / 100, vertical: false },
        RGB,
        { op: 'lens', k1: -Math.round(16 * a) / 100 },
      ];
    },
    oldfilm: (v) => {
      const a = v.amount / 100;
      return [
        colour(null, mixPart(SEPIA, 0.85 * a), all(num(16 * a) + '+val*' + num(1 - 0.12 * a))),
        YUV,
        { op: 'noise', s: Math.max(1, Math.round(28 * a)) },
      ];
    },
    comic: (v) => {
      const n = Math.max(2, Math.round(v.levels));
      return [{ op: 'comic', table: 'floor(val*' + n + '/256)*' + num(255 / (n - 1)), k: Math.round(v.edges) / 100 }];
    },
    border: (v, W, H) => [{ op: 'frame', px: Math.max(0, Math.round(v.size * H)), color: rgbOf(v.color, [255, 255, 255]) }],
    rotate: (v) => [{ op: 'rotate', deg: Math.round(v.angle) }],
    // A table of the user's own. No ops without a file: it does nothing then.
    lut: (v) => (v.file ? [{ op: 'lut3d', file: v.file }] : []),
    // ---- V5.1, pictures that move by themselves ----
    wave: (v, W, H) => [{
      op: 'warp',
      form: 'wave',
      a: v.amount * H,
      k: (2 * Math.PI) / Math.max(4, v.length * H),
      s: (2 * Math.PI * v.speed) / 10,
      vertical: !!v.vertical,
    }],
    ripple: (v, W, H) => [{
      op: 'warp',
      form: 'ripple',
      a: v.amount * H,
      k: (2 * Math.PI) / Math.max(4, v.length * H),
      s: (2 * Math.PI * v.speed) / 10,
      ...midOf(v, W, H),
    }],
    swirl: (v, W, H) => [{
      op: 'warp',
      form: 'swirl',
      angle: (Math.round(v.angle) * Math.PI) / 180,
      rad: Math.max(4, v.radius * H),
      ...midOf(v, W, H),
    }],
    zoom: (v, W, H) => {
      const z = Math.max(100, Math.round(v.zoom)) / 100;
      return [{
        op: 'warp',
        form: 'zoom',
        iz: 1 / z,
        // As far as the picture reaches at this zoom, so 100 shows its very edge.
        px: (v.x / 100) * ((W - 1) / 2) * (1 - 1 / z),
        py: (v.y / 100) * ((H - 1) / 2) * (1 - 1 / z),
        ...midOf(v, W, H),
      }];
    },
    shake: (v, W, H) => {
      const a = v.amount * H;
      return [{
        op: 'warp',
        form: 'shake',
        a,
        w: (2 * Math.PI * v.speed) / 10,
        // Zoomed in by as much as it moves, so no edge shows.
        iz: Math.max(0.5, 1 - (2 * a) / Math.max(2, Math.min(W, H))),
        cx: (W - 1) / 2,
        cy: (H - 1) / 2,
      }];
    },
    glitch: (v, W, H) => [{
      op: 'warp',
      form: 'glitch',
      a: v.amount * H,
      // Even, so a slice ends where a row of colour does.
      slice: Math.max(2, 2 * Math.round((v.size * H) / 2)),
      rate: v.speed / 10,
    }],
    bulge: (v, W, H) => [{
      op: 'warp',
      form: 'bulge',
      // Up to 0.9: the middle shown from a tenth of the way out, so ten times
      // as large. Below zero the middle is pinched together instead.
      s: (Math.round(v.amount) / 100) * 0.9,
      rad: Math.max(4, v.radius * H),
      ...midOf(v, W, H),
    }],
    haze: (v, W, H) => [{
      op: 'warp',
      form: 'haze',
      a: v.amount * H,
      k: (2 * Math.PI) / Math.max(4, v.length * H),
      s: (2 * Math.PI * v.speed) / 10,
    }],
    tile: (v, W, H) => {
      const n = Math.max(2, Math.round(v.count));
      // Smoothed first by as much as it is made smaller, or fine detail would flicker.
      return [{ op: 'blur', sx: 0.35 * n, sy: 0.35 * n }, { op: 'warp', form: 'tile', n, W: Math.round(W), H: Math.round(H) }];
    },
    kaleido: (v, W, H) => [{
      op: 'warp',
      form: 'kaleido',
      seg: (2 * Math.PI) / Math.max(2, Math.round(v.segments)),
      rot: (Math.round(v.angle) * Math.PI) / 180,
      ...midOf(v, W, H),
    }],
    perspective: (v, W, H) => [{
      op: 'warp',
      form: 'persp',
      // The far side is at most a little under half as wide as the near one.
      a: ((Math.round(v.tiltx) / 100) * 0.45) / (W / 2),
      b: ((Math.round(v.tilty) / 100) * 0.45) / (H / 2),
      cx: (W - 1) / 2,
      cy: (H - 1) / 2,
      W: Math.round(W),
      H: Math.round(H),
    }],
    bars: (v, W, H) => [{ op: 'bars', px: Math.max(0, Math.round(v.size * (v.vertical ? W : H))), vertical: !!v.vertical }],
    offset: (v, W, H) => [{ op: 'scroll', dx: Math.round((v.x / 100) * W) % Math.max(1, Math.round(W)),
      dy: Math.round((v.y / 100) * H) % Math.max(1, Math.round(H)), W: Math.round(W), H: Math.round(H) }],
    rgbsplit: (v, W, H) => {
      const a = (v.angle * Math.PI) / 180;
      const r = v.amount * H;
      const dx = Math.round(r * Math.cos(a));
      const dy = Math.round(r * Math.sin(a));
      return [{ op: 'shift', dx, dy }];
    },
    scanlines: (v) => {
      const period = Math.max(2, Math.round(v.spacing));
      const thick = Math.min(period - 1, Math.max(1, Math.round((period * v.thickness) / 100)));
      return [{ op: 'grid', period, thick, alpha: Math.round(v.darkness) / 100, vertical: !!v.vertical }];
    },
    grain: (v) => [{ op: 'noise', s: Math.max(1, Math.round(v.amount * 0.6)) }],
    dirblur: (v, W, H) => {
      const s = Math.round(sigmaOf(v.strength, H) * 2 * 4) / 4;
      return [{ op: 'blur', sx: v.vertical ? 0 : s, sy: v.vertical ? s : 0 }];
    },
    // A positive Amount bulges the middle towards the viewer, a negative one
    // pulls the edges in, which is the filter's figure the other way round.
    lens: (v, W, H) => {
      const m = midOf(v, W, H);
      // The filter takes its middle as a share of the picture, 0 to 1.
      const share = (c, size) => Math.min(1, Math.max(0, Math.round(((c + 0.5) / size) * 1000) / 1000));
      return [{ op: 'lens', k1: -Math.round(v.amount) / 200, cx: share(m.cx, W), cy: share(m.cy, H) }];
    },
    flip: (v, W, H) => {
      const mode = FLIP_MODES.includes(v.mode) ? v.mode : 'across';
      if (mode === 'across') return [{ op: 'flip', h: true, v: false }];
      if (mode === 'down') return [{ op: 'flip', h: false, v: true }];
      if (mode === 'both') return [{ op: 'flip', h: true, v: true }];
      const sides = mode === 'quad' ? ['left', 'top'] : [mode];
      return sides.map((side) => ({ op: 'mirror', side, W: Math.round(W), H: Math.round(H) }));
    },
  };
  const KIND_IDS = Object.keys(KINDS);

  /** A kind's ops for its settings at one moment, on a source picture W by H. */
  function opsOf(kind, v, W, H) {
    const row = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
    return row ? row(v, W, H) : [];
  }

  /**
   * What ops need of the picture round the part they change: `margin`, the
   * source pixels beside it they read, and `whole`, that they are worked out
   * of the whole picture (a turn of it, or lines counted from its corner).
   */
  function roomOf(ops) {
    let margin = 0;
    let whole = false;
    for (const o of ops) {
      if (o.op === 'conv' || o.op === 'sobel') margin = Math.max(margin, 2);
      else if (o.op === 'blur') margin = Math.max(margin, Math.ceil(Math.max(o.sx, o.sy) * 3));
      else if (o.op === 'glow' || o.op === 'clarity') margin = Math.max(margin, Math.ceil(o.sigma * 3));
      else if (o.op === 'bars' || o.op === 'scroll' || o.op === 'frame' || o.op === 'rotate' || o.op === 'warp') whole = true;
      else if (o.op === 'comic') margin = Math.max(margin, 2);
      else if (o.op === 'shift') margin = Math.max(margin, Math.abs(o.dx) + 1, Math.abs(o.dy) + 1);
      else if (o.op === 'lens' || o.op === 'flip' || o.op === 'mirror' || o.op === 'grid') whole = true;
    }
    return { margin, whole };
  }

  // ---- the ops as the encoder's filters ----

  const hex2 = (n) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');

  /**
   * Where a warp takes each pixel from, as the encoder's expression of X, Y
   * and T: the pixel at that place of the plane being written, between pixels
   * smoothed, and half added because the filter cuts the result down to a
   * whole number. vfxGl.js works the same rule out for the preview.
   */
  function warpExpr(o) {
    const n = num;
    // X and Y in the picture's own pixels whatever plane is being written:
    // a colour plane of 4:2:0 video is half the size each way (SW, SH), so
    // its pixel stands for the picture's at twice its place.
    const X = '(X/SW)';
    const Y = '(Y/SH)';
    const from = (x, y) => 'p((' + x + ')*SW,(' + y + ')*SH)+0.5';
    if (o.form === 'wave') {
      const d = n(o.a) + '*sin(' + n(o.k) + '*' + (o.vertical ? X : Y) + '+' + n(o.s) + '*T)';
      return o.vertical ? from(X, Y + '+' + d) : from(X + '+' + d, Y);
    }
    if (o.form === 'ripple') {
      return 'st(2,' + X + '-' + n(o.cx) + ');st(3,' + Y + '-' + n(o.cy) + ');st(0,hypot(ld(2),ld(3)));st(1,' + n(o.a) + '*sin('
        + n(o.k) + '*ld(0)-' + n(o.s) + '*T)/max(ld(0),1));' + from(n(o.cx) + '+ld(2)*(1+ld(1))', n(o.cy) + '+ld(3)*(1+ld(1))');
    }
    if (o.form === 'swirl') {
      return 'st(2,' + X + '-' + n(o.cx) + ');st(3,' + Y + '-' + n(o.cy) + ');st(0,max(0,1-hypot(ld(2),ld(3))/' + n(o.rad)
        + '));st(1,' + n(o.angle) + '*ld(0)*ld(0));st(4,cos(ld(1)));st(5,sin(ld(1)));'
        + from(n(o.cx) + '+ld(4)*ld(2)-ld(5)*ld(3)', n(o.cy) + '+ld(5)*ld(2)+ld(4)*ld(3)');
    }
    if (o.form === 'zoom') {
      return from(n(o.cx + o.px) + '+(' + X + '-' + n(o.cx) + ')*' + n(o.iz), n(o.cy + o.py) + '+(' + Y + '-' + n(o.cy) + ')*' + n(o.iz));
    }
    if (o.form === 'shake') {
      const w = n(o.w);
      return from(
        n(o.cx) + '+(' + X + '-' + n(o.cx) + ')*' + n(o.iz) + '+' + n(o.a) + '*(0.6*sin(' + w + '*T)+0.4*sin(2.3*' + w + '*T+1.3))',
        n(o.cy) + '+(' + Y + '-' + n(o.cy) + ')*' + n(o.iz) + '+' + n(o.a) + '*(0.6*cos(1.1*' + w + '*T+0.7)+0.4*sin(2.9*' + w + '*T))');
    }
    if (o.form === 'bulge') {
      // Inside the radius every pixel comes from nearer the middle, the more
      // the nearer it is itself; at the radius from where it is.
      return 'st(2,' + X + '-' + n(o.cx) + ');st(3,' + Y + '-' + n(o.cy) + ');st(0,max(0,1-hypot(ld(2),ld(3))/' + n(o.rad)
        + '));st(1,1-' + n(o.s) + '*ld(0)*ld(0));' + from(n(o.cx) + '+ld(2)*ld(1)', n(o.cy) + '+ld(3)*ld(1)');
    }
    if (o.form === 'haze') {
      return from(X + '+' + n(o.a) + '*sin(' + n(o.k) + '*' + Y + '+' + n(o.s) + '*T+2*sin(' + n(0.7 * o.k) + '*' + X + '))',
        Y + '+' + n(o.a) + '*cos(' + n(1.3 * o.k) + '*' + X + '+' + n(1.7 * o.s) + '*T)');
    }
    if (o.form === 'tile') {
      return from('mod((' + X + '+0.5)*' + n(o.n) + ',' + n(o.W) + ')-0.5', 'mod((' + Y + '+0.5)*' + n(o.n) + ',' + n(o.H) + ')-0.5');
    }
    if (o.form === 'kaleido') {
      // The angle about the middle folded into one wedge, there and back.
      return 'st(2,' + X + '-' + n(o.cx) + ');st(3,' + Y + '-' + n(o.cy) + ');st(0,hypot(ld(2),ld(3)));st(1,abs(mod(atan2(ld(3),ld(2))-'
        + n(o.rot) + '+' + n(8 * Math.PI) + ',' + n(o.seg) + ')-' + n(o.seg / 2) + ')+' + n(o.rot) + ');'
        + from(n(o.cx) + '+ld(0)*cos(ld(1))', n(o.cy) + '+ld(0)*sin(ld(1))');
    }
    if (o.form === 'persp') {
      // Further from the viewer on one side: every place divided by how far
      // it is. What comes from outside the picture is black (OUT, which each
      // plane has its own figure for).
      return 'st(2,' + X + '-' + n(o.cx) + ');st(3,' + Y + '-' + n(o.cy) + ');st(0,1+' + n(o.a) + '*ld(2)+' + n(o.b) + '*ld(3));st(4,'
        + n(o.cx) + '+ld(2)/ld(0));st(5,' + n(o.cy) + '+ld(3)/ld(0));if(between(ld(4),0,' + n(o.W - 1) + ')*between(ld(5),0,' + n(o.H - 1)
        + '),p(ld(4)*SW,ld(5)*SH)+0.5,OUT)';
    }
    // Glitch: slices of the picture, some of them pushed aside, others every
    // few frames. Which and how far comes out of whole-number sums, small
    // enough that the preview's arithmetic gets the very same.
    return 'st(0,mod(floor(' + Y + '/' + n(o.slice) + '),89));st(1,mod(floor(T*' + n(o.rate) + '+0.01),97));'
      + from(X + '+' + n(o.a) + '*(mod(ld(0)*7+ld(1)*13+ld(0)*ld(1)*3,17)/8-1)*lt(mod(ld(0)*3+ld(1)*5+ld(0)*ld(1),7),2)', Y);
  }

  /**
   * A file's path as a filter's option takes it. Forward slashes, and every
   * character the filter graph or the option reads as its own (a colon, a
   * quote, a space, a comma and so on) with three backslashes before it: one
   * level for the graph, one for the option. Measured with a path that has
   * spaces and an apostrophe, on the command line and in a graph file; put
   * in single quotes instead, that same path was not found.
   */
  function filterPath(p) {
    return String(p).split('\\').join('/').replace(/([:' ,;[\]=])/g, '\\\\\\$1');
  }

  /**
   * A .cube file's text as a table: `{ ok, n, data, lo, hi }`, `data` n*n*n
   * colours of three, red running fastest, as the file has them. Not ok for
   * anything else, a 1D table among them.
   */
  function parseCube(text) {
    const bad = { ok: false };
    if (typeof text !== 'string') return bad;
    let n = 0;
    let lo = [0, 0, 0];
    let hi = [1, 1, 1];
    const values = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const c = line.charCodeAt(0);
      // A figure starts with a digit, a sign or a point.
      if ((c >= 48 && c <= 57) || c === 45 || c === 43 || c === 46) {
        const parts = line.split(/\s+/);
        if (parts.length < 3) return bad;
        values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
        continue;
      }
      const words = line.split(/\s+/);
      if (words[0] === 'LUT_3D_SIZE') n = Math.round(Number(words[1]));
      else if (words[0] === 'LUT_1D_SIZE') return bad;
      else if (words[0] === 'DOMAIN_MIN') lo = words.slice(1, 4).map(Number);
      else if (words[0] === 'DOMAIN_MAX') hi = words.slice(1, 4).map(Number);
    }
    if (!(n >= 2 && n <= 256) || values.length !== n * n * n * 3) return bad;
    if (values.some((x) => !Number.isFinite(x))) return bad;
    if (![...lo, ...hi].every(Number.isFinite) || hi.some((x, i) => !(x > lo[i]))) return bad;
    return { ok: true, n, data: Float32Array.from(values), lo, hi };
  }

  /** One op as its filters, in order, each a filter that takes `enable`. `alpha`: the picture has one of its own. */
  function filtersOfOp(o, alpha = false) {
    if (o.op === 'lut3d') return ['lut3d=file=' + filterPath(o.file) + ':interp=trilinear'];
    if (o.op === 'warp') {
      const e = warpExpr(o);
      // Black where nothing comes from: 16 of brightness, no colour, and solid.
      const plane = (black) => e.split('OUT').join(black);
      return ["geq=lum='" + plane('16') + "':cb='" + plane('128') + "':cr='" + plane('128') + "'" + (alpha ? ":a='" + plane('255') + "'" : '')];
    }
    if (o.op === 'colour') {
      const out = [];
      const lut = (t) => "lutrgb=r='" + t[0] + "':g='" + t[1] + "':b='" + t[2] + "'";
      if (o.a) out.push(lut(o.a));
      if (o.m) {
        const names = ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'];
        out.push('colorchannelmixer=' + names.map((n, i) => n + '=' + num(o.m[i])).join(':'));
      }
      if (o.b) out.push(lut(o.b));
      return out;
    }
    if (o.op === 'hold') {
      return ['colorhold=color=0x' + o.color.map(hex2).join('') + ':similarity=' + num(o.sim) + ':blend=' + num(o.blend)];
    }
    if (o.op === 'conv') {
      const m = o.k.map((x) => Math.round(x)).join(' ');
      const d = num(1 / o.div);
      return ["convolution=0m='" + m + "':1m='" + m + "':2m='" + m + "':0rdiv=" + d + ':1rdiv=' + d + ':2rdiv=' + d];
    }
    if (o.op === 'sobel') return ['sobel=planes=7:scale=' + num(o.scale) + ':delta=0'];
    if (o.op === 'blur') return ['gblur=sigma=' + num(o.sx) + ':sigmaV=' + num(o.sy) + ':steps=6'];
    if (o.op === 'shift') {
      return ['rgbashift=rh=' + o.dx + ':rv=' + o.dy + ':bh=' + (-o.dx) + ':bv=' + (-o.dy) + ':edge=smear'];
    }
    if (o.op === 'lens') {
      const at = o.cx === undefined ? '' : 'cx=' + num(o.cx) + ':cy=' + num(o.cy) + ':';
      return ['lenscorrection=' + at + 'k1=' + num(o.k1) + ':k2=0:i=bilinear:fc=black'];
    }
    if (o.op === 'flip') return [...(o.h ? ['hflip'] : []), ...(o.v ? ['vflip'] : [])];
    if (o.op === 'grid') {
      const far = 'x=-50000:w=100000';
      const lines = 'y=0:h=' + o.period;
      const at = o.vertical ? 'y=-50000:h=100000:x=0:w=' + o.period : far + ':' + lines;
      return ['drawgrid=' + at + ':t=' + o.thick + ':c=black@' + num(o.alpha)];
    }
    if (o.op === 'noise') {
      return [o.chroma ? 'noise=alls=' + Math.round(o.s) + ':allf=t+u' : 'noise=c0s=' + Math.round(o.s) + ':c0f=t+u'];
    }
    if (o.op === 'bars') {
      if (!(o.px > 0)) return [];
      return o.vertical
        ? ['drawbox=x=0:y=0:w=' + o.px + ':h=ih:c=black:t=fill', 'drawbox=x=iw-' + o.px + ':y=0:w=' + o.px + ':h=ih:c=black:t=fill']
        : ['drawbox=x=0:y=0:w=iw:h=' + o.px + ':c=black:t=fill', 'drawbox=x=0:y=ih-' + o.px + ':w=iw:h=' + o.px + ':c=black:t=fill'];
    }
    if (o.op === 'frame') {
      if (!(o.px > 0)) return [];
      return ['drawbox=x=0:y=0:w=iw:h=ih:c=0x' + o.color.map(hex2).join('') + ':t=' + o.px];
    }
    if (o.op === 'rotate') return ['rotate=angle=' + num((o.deg * Math.PI) / 180) + ':fillcolor=black:bilinear=1'];
    if (o.op === 'scroll') {
      // The filter rounds its place up to a whole pixel (measured: 133.32
      // moved 134), so half a pixel short of the one asked for lands on it.
      const place = (d, size) => (d > 0 ? num((d - 0.5) / size) : '0');
      return ['scroll=h=0:v=0:hpos=' + place(o.dx, o.W) + ':vpos=' + place(o.dy, o.H)];
    }
    return [];
  }

  // Between the picture's brightness and colour planes and red, green and
  // blue, the encoder's scaler by its own default cuts every value down
  // instead of rounding it: there and back left the picture 1.1 of 255
  // darker (measured, brightness 65.86 to 64.76, 46.7 dB). Told to round,
  // it is the same picture again (65.86, 74.4 dB). So every such change is
  // written with this in front of it.
  const TO_PLANES = 'scale=flags=accurate_rnd';

  /** How many times an op forks the picture: more than filters one behind the other. */
  const forksIn = (o) => (o.op === 'glow' || o.op === 'mirror' || o.op === 'comic' ? 1 : (o.op === 'clarity' ? 2 : 0));
  const forks = (o) => forksIn(o) > 0;
  /** An op that stands once in a VFX's filters whatever its figures do. */
  const stands = (o) => forks(o) || o.op === 'format';
  const forksOf = (ops) => (Array.isArray(ops) ? ops.reduce((sum, o) => sum + forksIn(o), 0) : 0);

  /** A half of the picture folded onto the other, between the labels it makes with `tag`. */
  function mirrorGraph(o, tag) {
    const W = o.W;
    const H = o.H;
    const a = '[' + tag + 'a]';
    const b = '[' + tag + 'b]';
    const p = '[' + tag + 'p]';
    const q = '[' + tag + 'q]';
    if (o.side === 'left' || o.side === 'right') {
      const big = Math.ceil(W / 2);
      const small = Math.floor(W / 2);
      if (o.side === 'left') {
        return 'split' + a + b + ';' + a + 'crop=' + big + ':' + H + ':0:0' + p + ';'
          + b + 'crop=' + small + ':' + H + ':0:0,hflip' + q + ';' + p + q + 'hstack=inputs=2';
      }
      return 'split' + a + b + ';' + a + 'crop=' + small + ':' + H + ':' + (W - small) + ':0,hflip' + p + ';'
        + b + 'crop=' + big + ':' + H + ':' + (W - big) + ':0' + q + ';' + p + q + 'hstack=inputs=2';
    }
    const big = Math.ceil(H / 2);
    const small = Math.floor(H / 2);
    if (o.side === 'top') {
      return 'split' + a + b + ';' + a + 'crop=' + W + ':' + big + ':0:0' + p + ';'
        + b + 'crop=' + W + ':' + small + ':0:0,vflip' + q + ';' + p + q + 'vstack=inputs=2';
    }
    return 'split' + a + b + ';' + a + 'crop=' + W + ':' + small + ':0:' + (H - small) + ',vflip' + p + ';'
      + b + 'crop=' + W + ':' + big + ':0:' + (H - big) + q + ';' + p + q + 'vstack=inputs=2';
  }

  /**
   * A VFX's ops as the encoder's filters. `steps` is each figure it has over
   * the clip, `{ ops, ranges }`, and `on(ranges)` the `enable` that holds a
   * filter to those frames, empty for always. Filters one behind the other
   * are each on for their own frames. An op that forks the picture is written
   * once, with `tag` to name its labels: a glow's fork stays whatever its
   * figures do, and its tables and blurs are on by their frames inside it.
   * Returns the text and `forks`, how many times the picture is split.
   */
  function filtersOf(steps, on, tag, alpha = false) {
    const list = (Array.isArray(steps) ? steps : []).filter((s) => s && Array.isArray(s.ops));
    if (!list.length) return { text: '', forks: 0, ends: null };
    // Every figure of one VFX has the same ops in the same order, only their
    // numbers differ. So the ops are gone through by their place: the plain
    // ones of every figure one behind the other, each on for its frames, and
    // one that stands once (a fork, a change of planes) written once.
    const shape = list[0].ops;
    const parts = [];
    let count = 0;
    // The planes the picture is left in, 'yuv' or 'rgb', when the ops change them.
    let ends = null;
    shape.forEach((first, i) => {
      if (!stands(first)) {
        for (const s of list) {
          const o = s.ops[i];
          if (!o || o.op !== first.op) continue;
          const when = on(s.ranges);
          for (const f of filtersOfOp(o, alpha)) parts.push(f + when);
        }
        return;
      }
      const t = tag + 'f' + i;
      if (first.op === 'format') {
        parts.push(TO_PLANES + ',format=' + (first.to === 'yuv' ? (alpha ? 'yuva444p' : 'yuv444p') : (alpha ? 'gbrap' : 'gbrp')));
        ends = first.to;
        return;
      }
      count += forksIn(first);
      if (first.op === 'mirror') {
        parts.push(mirrorGraph(first, t));
        return;
      }
      const blend = (mode) => 'blend=c0_mode=' + mode + ':c1_mode=' + mode + ':c2_mode=' + mode;
      if (first.op === 'comic') {
        // One half in few levels, the other its outlines: grey, their Sobel
        // strength, turned round so an edge is dark, and the two multiplied.
        const levels = [];
        const edges = [];
        for (const s of list) {
          const o = s.ops[i];
          if (!o || o.op !== 'comic') continue;
          const when = on(s.ranges);
          levels.push("lutrgb=r='" + o.table + "':g='" + o.table + "':b='" + o.table + "'" + when);
          edges.push('sobel=planes=7:scale=' + num(o.k) + ':delta=0' + when);
        }
        const grey = 'colorchannelmixer=' + ['rr', 'rg', 'rb', 'gr', 'gg', 'gb', 'br', 'bg', 'bb'].map((n, j) => n + '=' + num(GREY[j])).join(':');
        parts.push('split[' + t + 'a][' + t + 'b];[' + t + 'a]' + levels.join(',') + '[' + t + 'p];[' + t + 'b]' + grey + ','
          + edges.join(',') + ",lutrgb=r='255-val':g='255-val':b='255-val'[" + t + 'c];[' + t + 'p][' + t + 'c]' + blend('multiply'));
        return;
      }
      // The blurs of every figure, each on for its frames.
      const inner = [];
      const scale = [];
      for (const s of list) {
        const o = s.ops[i];
        if (!o || o.op !== first.op) continue;
        const when = on(s.ranges);
        if (o.op === 'glow') inner.push("lutrgb=r='" + o.tables[0] + "':g='" + o.tables[1] + "':b='" + o.tables[2] + "'" + when);
        inner.push('gblur=sigma=' + num(o.sigma) + ':steps=6' + when);
        if (o.op === 'clarity') {
          const e = '128+(val-128)*' + num(o.k);
          scale.push("lutrgb=r='" + e + "':g='" + e + "':b='" + e + "'" + when);
        }
      }
      const a = '[' + t + 'a]';
      const b = '[' + t + 'b]';
      const c = '[' + t + 'c]';
      // The three colours only (blend above): a picture's own alpha stays as
      // it came, the first input's, which is the picture.
      if (first.op === 'glow') {
        parts.push('split' + a + b + ';' + b + inner.join(',') + c + ';' + a + c + blend('screen'));
        return;
      }
      // Clarity: the picture less its blur is its detail about a middle grey,
      // which a table scales, and the picture takes it back.
      const d = '[' + t + 'd]';
      const e = '[' + t + 'e]';
      const g = '[' + t + 'g]';
      parts.push('split=3' + a + b + d + ';' + b + inner.join(',') + c + ';' + a + c + blend('grainextract') + e
        + ';' + e + scale.join(',') + g + ';' + d + g + blend('grainmerge'));
    });
    return { text: parts.join(','), forks: count, ends };
  }

  return {
    KIND_IDS,
    TO_PLANES,
    CHANNEL_ORDER_IDS,
    forksOf,
    PALETTE_IDS,
    LOOK_IDS,
    EDGE_STYLES,
    FLIP_MODES,
    tableOf,
    compile,
    opsOf,
    roomOf,
    filtersOf,
    filtersOfOp,
    filterPath,
    parseCube,
    midOf,
    warpExpr,
    sigmaOf,
    rgbOf,
    hueRgb,
    num,
  };
})();

// The tests and the encoder's side require this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = vfxOps;
