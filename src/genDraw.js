'use strict';

// V3. Generated media drawn: a text or a bar onto a canvas the size of the
// project frame, transparent wherever there is nothing.
//
// That one picture is the whole of how generated media reaches the screen and
// the file. The preview draws it like an image layer, and the export writes it
// out as a PNG and hands it to ffmpeg through the image path, so the two show
// the same pixels by construction rather than by two renderers agreeing.
// ffmpeg's drawtext could never promise that: it has its own font lookup, its
// own wrapping and no outline to match.
//
// Everything is drawn through a 2D context handed in, which is all this asks
// of it, so the tests can hand it a recording one.

const genDraw = (() => {
  const layout = typeof textLayout !== 'undefined' ? textLayout : require('./textLayout');
  const model = typeof timelineModel !== 'undefined' ? timelineModel : require('./timeline');

  /**
   * The factor from the pixels a generated layer was set in to the pixels of
   * the frame it is drawn into. Sizes are kept at the project height they were
   * set at, so a title keeps its look when the project changes resolution.
   */
  function scaleOf(gen, frameHeight) {
    const ref = Number(gen && gen.refHeight) || 1080;
    return frameHeight / ref;
  }

  /**
   * Where a bar goes, in whole pixels. Its thickness is held to the user's
   * ceiling, a quarter of the frame's height for a bar on the top or bottom and
   * of its width for one on a side, and to at least one pixel. It covers `span`
   * of its side, centred: "Bars span from the center of the side where they are
   * sticky to".
   */
  function barRect(bar, scale, width, height) {
    const across = bar.side === 'left' || bar.side === 'right';
    const ceiling = Math.max(1, Math.floor((across ? width : height) / 4));
    const thick = Math.min(ceiling, Math.max(1, Math.round(bar.thickness * scale)));
    const side = across ? height : width;
    const len = Math.max(1, Math.round(side * bar.span));
    const from = Math.round((side - len) / 2);
    if (bar.side === 'top') return { x: from, y: 0, w: len, h: thick };
    if (bar.side === 'bottom') return { x: from, y: height - thick, w: len, h: thick };
    if (bar.side === 'left') return { x: 0, y: from, w: thick, h: len };
    return { x: width - thick, y: from, w: thick, h: len };
  }

  function drawBar(ctx, gen, width, height) {
    const r = barRect(gen.bar, scaleOf(gen, height), width, height);
    ctx.fillStyle = gen.bar.color;
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }

  // ---- shapes ----
  //
  // Each shape is an outline in a box, the same thing an SVG path is, traced
  // straight onto the canvas: the bundled ffmpeg has no SVG reader, and the
  // canvas is what already becomes the preview, the export's PNG and the clip.
  // A shape fills its box edge to edge, so the box's grips sit on its ink.

  // V3.5. A star's corners, `points` of them on the outside and as many in
  // between at `inner` of the outer radius, the first point straight up, then
  // scaled to fill the unit box. Worked out once per figure, since a slider
  // being dragged asks for the same one on every frame.
  const starCache = new Map();
  function starPolygon(points, inner) {
    const key = points + ':' + inner;
    const kept = starCache.get(key);
    if (kept) return kept;
    const pts = [];
    for (let i = 0; i < points * 2; i += 1) {
      const r = i % 2 ? inner : 1;
      const a = -Math.PI / 2 + i * Math.PI / points;
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(...xs) - x0;
    const h = Math.max(...ys) - y0;
    const out = {
      pts: pts.map(([x, y]) => [(x - x0) / w, (y - y0) / h]),
      aspect: w / h,
    };
    starCache.set(key, out);
    return out;
  }

  // Corners as fractions of the box, for the shapes made of straight lines.
  // The star's are its own figures', above.
  const SHAPE_POLYGONS = {
    square: [[0, 0], [1, 0], [1, 1], [0, 1]],
    triangle: [[0.5, 0], [1, 1], [0, 1]],
    // V3.6.5. Pointing right, its shaft half the box's height and its head
    // the last two fifths of its length. The turning dot points it any other
    // way.
    arrow: [[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]],
  };

  // V3.6.5. The heart as curves, fractions of the box, from its point at the
  // bottom up the left side, over both lobes and down the right: each is
  // [first control, second control, end], the start of the first being the
  // point. Its widest and highest reach the box's edges, so the grips sit on
  // its ink like every other shape's.
  const HEART_CURVES = [
    [0.4, 0.9, 0, 0.62, 0, 0.3],
    [0, 0.1, 0.12, 0, 0.27, 0],
    [0.39, 0, 0.47, 0.07, 0.5, 0.17],
    [0.53, 0.07, 0.61, 0, 0.73, 0],
    [0.88, 0, 1, 0.1, 1, 0.3],
    [1, 0.62, 0.6, 0.9, 0.5, 1],
  ];

  // V3.6.5. The speech bubble: a body with rounded corners over the top of
  // the box, BUBBLE_BODY of its height, and the tail under it at the bottom
  // left, from between BUBBLE_TAIL's two shares of the width on the body's
  // edge to its tip on the box's bottom edge. The corners are BUBBLE_ROUND of
  // the body's shorter side, which keeps them short of the tail's base.
  const BUBBLE_BODY = 0.78;
  const BUBBLE_TAIL = { from: 0.2, to: 0.36, tip: 0.08 };
  const BUBBLE_ROUND = 0.16;

  // Width over height of a shape's default box, so a new one is the regular
  // shape: an equilateral triangle, a star with its own proportions (the
  // regular five-point one's here, any other's from shapeAspect).
  const SHAPE_ASPECT = {
    circle: 1,
    square: 1,
    ring: 1,
    triangle: 2 / Math.sqrt(3),
    star: Math.cos(Math.PI / 10) / (0.5 + 0.5 * Math.cos(Math.PI / 5)),
    // V3.6.5.
    arrow: 1.6,
    heart: 1.1,
    bubble: 4 / 3,
  };

  // The defaults a shape from before 3.5 is drawn with, the model's own.
  const SHAPE_DEFAULTS = { ring: 0.4, points: 5, inner: 0.381966 };

  /** Width over height of a shape's regular box: a star's by its figures. */
  function shapeAspect(shape) {
    if (shape && shape.kind === 'star') {
      return starPolygon(shape.points || SHAPE_DEFAULTS.points, shape.inner || SHAPE_DEFAULTS.inner).aspect;
    }
    return SHAPE_ASPECT[shape && shape.kind] || 1;
  }

  /**
   * A shape's box in the frame's pixels: its own scaled, or with none the
   * default, a third of the frame high in the shape's proportions, centred.
   */
  function shapeBox(gen, width, height) {
    const s = gen.shape;
    if (s.box) {
      const k = scaleOf(gen, height);
      return { x: s.box.x * k, y: s.box.y * k, w: s.box.w * k, h: s.box.h * k };
    }
    const h = height / 3;
    const w = h * shapeAspect(s);
    return { x: (width - w) / 2, y: (height - h) / 2, w, h };
  }

  // The ring's hole is the inner ellipse, left out by the even-odd rule.
  function fillRule(shape) {
    return shape.kind === 'ring' ? 'evenodd' : 'nonzero';
  }

  /**
   * The outline of a shape in a box added to the path on `ctx`, which is how
   * an inverted one puts the frame's rectangle round it first.
   */
  //
  // V3.6.2. Turned by `shape.rotation` degrees about the box's centre, every
  // point of the path worked out turned rather than the context being turned,
  // so an inverted shape's frame and a soft edge's surface stay square to the
  // frame. A square with `shape.radius`, in the canvas's pixels, has its
  // corners rounded by that much, never more than half its shorter side.
  function tracePath(ctx, shape, b) {
    const kind = shape.kind;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const a = (Number(shape.rotation) || 0) * Math.PI / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    // Unturned, the points exactly as they are, not as cx + (x - cx).
    const at = a
      ? (x, y) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos]
      : (x, y) => [x, y];
    if (kind === 'circle' || kind === 'ring') {
      ctx.moveTo(...at(cx + b.w / 2, cy));
      ctx.ellipse(cx, cy, b.w / 2, b.h / 2, a, 0, Math.PI * 2);
      if (kind === 'ring') {
        const hole = 1 - (Number.isFinite(shape.ring) ? shape.ring : SHAPE_DEFAULTS.ring);
        ctx.moveTo(...at(cx + b.w / 2 * hole, cy));
        ctx.ellipse(cx, cy, b.w / 2 * hole, b.h / 2 * hole, a, 0, Math.PI * 2);
      }
      return;
    }
    // V3.6.5. The heart and the bubble, each its own path.
    if (kind === 'heart') {
      const p = (x, y) => at(b.x + x * b.w, b.y + y * b.h);
      ctx.moveTo(...p(0.5, 1));
      for (const [ax, ay, bx, by, x, y] of HEART_CURVES) ctx.bezierCurveTo(...p(ax, ay), ...p(bx, by), ...p(x, y));
      ctx.closePath();
      return;
    }
    if (kind === 'bubble') {
      const left = b.x;
      const right = b.x + b.w;
      const top = b.y;
      const bottom = b.y + b.h * BUBBLE_BODY;
      const round = Math.min(b.w, b.h * BUBBLE_BODY) * BUBBLE_ROUND;
      ctx.moveTo(...at(cx, top));
      ctx.arcTo(...at(right, top), ...at(right, bottom), round);
      ctx.arcTo(...at(right, bottom), ...at(left, bottom), round);
      ctx.lineTo(...at(left + b.w * BUBBLE_TAIL.to, bottom));
      ctx.lineTo(...at(left + b.w * BUBBLE_TAIL.tip, b.y + b.h));
      ctx.lineTo(...at(left + b.w * BUBBLE_TAIL.from, bottom));
      ctx.arcTo(...at(left, bottom), ...at(left, top), round);
      ctx.arcTo(...at(left, top), ...at(right, top), round);
      ctx.closePath();
      return;
    }
    const r = kind === 'square' ? Math.min(Math.max(0, Number(shape.radius) || 0), b.w / 2, b.h / 2) : 0;
    if (r > 0) {
      const tl = at(b.x, b.y);
      const tr = at(b.x + b.w, b.y);
      const br = at(b.x + b.w, b.y + b.h);
      const bl = at(b.x, b.y + b.h);
      ctx.moveTo(...at(cx, b.y));
      ctx.arcTo(...tr, ...br, r);
      ctx.arcTo(...br, ...bl, r);
      ctx.arcTo(...bl, ...tl, r);
      ctx.arcTo(...tl, ...tr, r);
      ctx.closePath();
      return;
    }
    const pts = kind === 'star'
      ? starPolygon(shape.points || SHAPE_DEFAULTS.points, shape.inner || SHAPE_DEFAULTS.inner).pts
      : SHAPE_POLYGONS[kind] || SHAPE_POLYGONS.square;
    pts.forEach(([x, y], i) => {
      const p = at(b.x + x * b.w, b.y + y * b.h);
      if (i) ctx.lineTo(...p);
      else ctx.moveTo(...p);
    });
    ctx.closePath();
  }

  /** The outline of a shape in a box, as a path on `ctx`, ready to fill. */
  function traceShape(ctx, shape, b) {
    ctx.beginPath();
    tracePath(ctx, shape, b);
  }

  function fillShape(ctx, shape, b, color) {
    traceShape(ctx, shape, b);
    ctx.fillStyle = color;
    ctx.fill(fillRule(shape));
  }

  /**
   * The shape's ink in one colour: all of it, or with `band` only that many
   * pixels inside its edge. The band is a stroke twice as wide held to the
   * inside by a clip, so it never reaches past the box the grips sit on, and
   * a ring's band runs round its hole as well as its outside.
   */
  function inkShape(ctx, shape, b, band, color) {
    // V3.6. A custom mask's picture, already white wherever it shows, see
    // maskPicture. Its colour is its own; only its alpha is ever used.
    if (shape.kind === 'custom') {
      if (shape.image) ctx.drawImage(shape.image, b.x, b.y, b.w, b.h);
      return;
    }
    if (!band) {
      fillShape(ctx, shape, b, color);
      return;
    }
    ctx.save();
    traceShape(ctx, shape, b);
    ctx.clip(fillRule(shape));
    ctx.lineWidth = band * 2;
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 10;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }

  // The soft edge as a blur: a figure of N pixels is a Gaussian whose ramp
  // from a tenth to nine tenths is about N pixels wide.
  const SOFT_SPREAD = 2.5;

  // V3.5. The surface the soft edge is drawn on before it is blurred, kept
  // like the shadow's: the window has OffscreenCanvas, node has neither.
  let softSurface = null;
  function defaultShapeSurface(w, h) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    if (!softSurface) softSurface = new OffscreenCanvas(w, h).getContext('2d');
    const c = softSurface.canvas;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return softSurface;
  }

  /**
   * The ink with a soft edge: drawn sharp onto a surface the size of the
   * canvas, in whatever transform `ctx` is in, and blurred back onto it. The
   * surface has a margin of the blur's reach on every side, so a shape that
   * hangs off the edge of the frame still blurs as the whole shape rather
   * than fading where the canvas stops. False when there is no surface.
   */
  function softInk(ctx, shape, b, band, color, soft, surface) {
    if (!ctx.canvas) return false;
    const T = typeof ctx.getTransform === 'function' ? ctx.getTransform() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const sigma = (soft / SOFT_SPREAD) * Math.hypot(T.a, T.b);
    const pad = Math.ceil(sigma * 3) + 2;
    const cw = ctx.canvas.width + pad * 2;
    const ch = ctx.canvas.height + pad * 2;
    const m = surface(cw, ch);
    if (!m) return false;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, cw, ch);
    m.setTransform(T.a, T.b, T.c, T.d, T.e + pad, T.f + pad);
    inkShape(m, shape, b, band, color);
    m.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'blur(' + sigma + 'px)';
    ctx.drawImage(m.canvas, -pad, -pad);
    ctx.restore();
    return true;
  }

  /**
   * A shape onto its own cleared canvas, which drawGen always hands it, so the
   * inverted one can cut its hole out of what is already there.
   *
   * Inverted, the colour covers the render frame and nothing past it, the
   * user's "everything becomes the color except the circle", and the shape is
   * then taken out of it: so a ring's hole is coloured again and only its band
   * is see-through, and a colour with alpha keeps its alpha everywhere but the
   * hole, which is a spotlight. A soft edge blurs the shape before the cut,
   * so the hole's edge fades and the frame's own edges stay solid.
   */
  function drawShape(ctx, gen, width, height, surface) {
    const k = scaleOf(gen, height);
    const b = shapeBox(gen, width, height);
    // V3.6.2. The rounded corners in the canvas's pixels, which tracePath takes.
    // V3.7. And the gradient as the paint, when it is filled with one.
    const s = { ...gen.shape, radius: (gen.shape.radius || 0) * k, color: shapePaint(ctx, gen.shape, b, k) };
    paintShape(ctx, s, b, Math.max(0, (s.soft || 0) * k),
      s.outline ? Math.max(0.5, s.line * k) : 0, width, height, surface);
  }

  /**
   * V3.7. What a shape is painted with: its colour, or with Gradient its
   * gradient on `ctx`, along its line through the middle of the box `b`,
   * turned with the shape, `k` canvas pixels to one at refHeight. A line of
   * no length paints nothing in canvas, so it is given half a pixel.
   */
  function shapePaint(ctx, shape, b, k) {
    const g = shape.gradient;
    if (shape.fill !== 'gradient' || !g || typeof ctx.createLinearGradient !== 'function') return shape.color;
    const a = ((Number(g.angle) || 0) + (Number(shape.rotation) || 0)) * Math.PI / 180;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const from = g.start * k;
    let to = g.end * k;
    if (Math.abs(to - from) < 0.5) to = from + 0.5;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const lin = ctx.createLinearGradient(cx + cos * from, cy + sin * from, cx + cos * to, cy + sin * to);
    for (const stop of g.stops) lin.addColorStop(Math.min(1, Math.max(0, stop.at)), stop.color);
    return lin;
  }

  /**
   * V3.7. The colour a gradient's stops give at `at`, 0 to 1, as #rrggbbaa:
   * what a stop added there starts as, so adding one changes nothing.
   */
  function gradientColourAt(stops, at) {
    const list = [...stops].sort((p, q) => p.at - q.at);
    if (!list.length) return '#ffffffff';
    if (at <= list[0].at) return list[0].color;
    const last = list[list.length - 1];
    if (at >= last.at) return last.color;
    let i = 0;
    while (list[i + 1].at < at) i += 1;
    const a = list[i];
    const b = list[i + 1];
    const u = b.at > a.at ? (at - a.at) / (b.at - a.at) : 0;
    return blendColour(a.color, b.color, u);
  }

  /**
   * A shape in its box, `soft` and `band` in the canvas's pixels, onto a
   * cleared canvas whose frame is `width` by `height`: drawShape's, and V3.6's
   * masks', whose frame is the picture they belong to.
   */
  function paintShape(ctx, s, b, soft, band, width, height, surface) {
    if (!s.invert && !soft && !band) {
      if (s.kind === 'custom') inkShape(ctx, s, b, 0, s.color);
      else fillShape(ctx, s, b, s.color);
      return;
    }
    ctx.save();
    if (s.invert) {
      ctx.beginPath();
      ctx.rect(0, 0, width, height);
      ctx.clip();
      ctx.fillStyle = s.color;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'destination-out';
    }
    // Opaque black to cut with, which takes out all of whatever alpha is under it.
    const ink = s.invert ? '#000000' : s.color;
    if (!(soft && surface && softInk(ctx, s, b, band, ink, soft, surface))) inkShape(ctx, s, b, band, ink);
    ctx.restore();
  }

  // ---- V3.6. Masks ----

  /** A mask's box in the pixels of a picture `width` by `height`. */
  function maskBox(mask, width, height) {
    const b = mask.box;
    return { x: b.x * width, y: b.y * height, w: b.w * width, h: b.h * height };
  }

  /**
   * The box a new mask starts in, as fractions of a picture `width` by
   * `height`: the largest in the shape's proportions, or a custom picture's,
   * that fits inside it, centred. So Add Mask's circle is a round picture
   * straight away.
   */
  function maskStartBox(mask, width, height) {
    const a = mask.kind === 'custom' ? mask.aspect || 1 : shapeAspect(mask);
    const pic = Math.max(1e-6, width) / Math.max(1e-6, height);
    const w = a <= pic ? a / pic : 1;
    const h = a <= pic ? 1 : pic / a;
    return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }

  /**
   * A mask onto a cleared canvas the size of the picture it belongs to, white
   * wherever the picture shows and clear wherever it does not: drawn exactly
   * as a white shape is, Invert and Soft Edge included, so a mask and a shape
   * with the same settings are the same picture. `image` is a custom mask's
   * picture, see maskPicture, and nothing is drawn of one not loaded yet.
   */
  function drawMask(ctx, mask, width, height, image, surface) {
    ctx.clearRect(0, 0, width, height);
    // V3.6.4. The corners' radius in the picture's pixels, which tracePath takes.
    // V3.7.1. Drawn white and flat whatever its own colour or gradient says,
    // which are how much of that shows, put in below.
    const s = { ...mask, color: '#ffffffff', fill: 'color', outline: false, image: image || null,
      radius: Math.max(0, (mask.radius || 0) * height) };
    const b = maskBox(mask, width, height);
    paintShape(ctx, s, b, Math.max(0, (mask.soft || 0) * height), 0,
      width, height, surface === undefined ? defaultShapeSurface : surface);
    // V3.7.1. Then all of it taken down by its colour, or along its gradient:
    // source-in keeps the mask's own alpha and multiplies it by the paint's.
    const paint = maskStrengthPaint(ctx, mask, b, height);
    if (paint === null) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = paint;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // ---- V4.7. Obscure and Pixelate ----

  /**
   * Where an Obscure or a Pixelate acts on a picture `width` by `height`,
   * onto its cleared canvas: white where it does, clear where it does not.
   * Every area is drawn as a white shape is, turned and with the soft edge,
   * one over the other, and inverted the whole is turned round, the soft
   * edges with it. The preview, the window and the export all cut the effect
   * with this one drawing.
   */
  function drawCoverMask(ctx, cover, width, height, surface) {
    ctx.clearRect(0, 0, width, height);
    const soft = Math.max(0, (cover.soft || 0) * height);
    const on = surface === undefined ? defaultShapeSurface : surface;
    for (const a of cover.areas) {
      paintShape(ctx, { kind: a.kind, rotation: a.rotation, color: '#ffffffff' },
        maskBox(a, width, height), soft, 0, width, height, on);
    }
    if (cover.invert) {
      // source-out: white wherever nothing is yet, and what is there taken away
      // by as much as it covers, which is the same picture the other way round.
      ctx.save();
      ctx.globalCompositeOperation = 'source-out';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
    }
    // V5.1. Mix: all of it taken down alike, so that much of the effect shows
    // over the picture as it was. A kind without Mix has it whole.
    const mix = cover.mix === undefined ? 100 : Number(cover.mix);
    if (mix >= 100 || !Number.isFinite(mix)) return;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0, 0, 0, ' + (Math.round(Math.max(0, mix) * 2.55) / 255) + ')';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  /**
   * The part of a picture `W` by `H` an Obscure or a Pixelate touches, so the
   * export filters that much and not the whole frame: round every area as it
   * is turned, with room for the soft edge and `margin` more (a blur needs
   * the pixels beside what it blurs), all of the picture when inverted. Whole
   * pixels on a grid of `grid`, which is 2 for 4:2:0 video and the block for
   * Pixelate, whose blocks are counted from the picture's corner; never past
   * the last even pixel. Null when it touches none of the picture.
   */
  function coverRegion(cover, W, H, { margin = 0, grid = 2 } = {}) {
    let x0 = 0;
    let y0 = 0;
    let x1 = W;
    let y1 = H;
    if (!cover.invert) {
      x0 = Infinity;
      y0 = Infinity;
      x1 = -Infinity;
      y1 = -Infinity;
      const room = (cover.soft || 0) * H * 1.5 + 2 + margin;
      for (const a of cover.areas) {
        const b = maskBox(a, W, H);
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        const rad = (Number(a.rotation) || 0) * Math.PI / 180;
        const hw = (Math.abs(b.w * Math.cos(rad)) + Math.abs(b.h * Math.sin(rad))) / 2;
        const hh = (Math.abs(b.w * Math.sin(rad)) + Math.abs(b.h * Math.cos(rad))) / 2;
        x0 = Math.min(x0, cx - hw - room);
        x1 = Math.max(x1, cx + hw + room);
        y0 = Math.min(y0, cy - hh - room);
        y1 = Math.max(y1, cy + hh + room);
      }
    }
    const g = Math.max(2, Math.round(grid / 2) * 2);
    const down = (v) => Math.floor(v / g) * g;
    const up = (v, most) => Math.min(Math.floor(most / 2) * 2, Math.ceil(v / g) * g);
    const x = Math.max(0, down(x0));
    const y = Math.max(0, down(y0));
    const width = up(x1, W) - x;
    const height = up(y1, H) - y;
    if (!(width >= 2) || !(height >= 2)) return null;
    return { x, y, width, height };
  }

  /**
   * V4.8. Two such parts as one, for an effect whose areas move: the
   * rectangle round both, either alone when the other is null. Both lie on
   * the same grid, or end at the picture's last even pixel, and so does this.
   */
  function coverRegionUnion(a, b) {
    if (!a || !b) return a || b || null;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      width: Math.max(a.x + a.width, b.x + b.width) - x,
      height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
  }

  /**
   * V3.7.1. How much a colour lets a mask show, 0 to 1: its brightness by the
   * rule a custom mask picture has (maskPixels' luma), times its alpha. The
   * hue says nothing.
   */
  function maskStrength(color) {
    const ch = (i) => parseInt(String(color).slice(1 + i * 2, 3 + i * 2), 16) / 255;
    const a = String(color).length >= 9 ? ch(3) : 1;
    const s = (0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2)) * a;
    return Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 1;
  }

  /**
   * V3.7.1. What a mask is multiplied by: white at its colour's strength, or
   * a gradient of such whites along its line, which runs as a shape's does
   * from the middle of its box, Start and End in fractions of the picture's
   * height. Null when it shows in full, which is nothing to do.
   */
  function maskStrengthPaint(ctx, mask, b, height) {
    const white = (s) => 'rgba(255,255,255,' + s.toFixed(4) + ')';
    if (mask.fill === 'gradient' && mask.gradient) {
      if (typeof ctx.createLinearGradient !== 'function') return null;
      const g = mask.gradient;
      return shapePaint(ctx, {
        fill: 'gradient',
        rotation: 0,
        color: '#ffffffff',
        gradient: { ...g, stops: g.stops.map((stop) => ({ at: stop.at, color: white(maskStrength(stop.color)) })) },
      }, b, height);
    }
    const s = maskStrength(mask.color || '#ffffffff');
    return s >= 1 ? null : white(s);
  }

  /**
   * A custom mask's picture as a mask: every pixel white, with the alpha of
   * what shows. By its alpha, a PNG's transparency is what hides; by its
   * brightness, white shows, black hides and grey shows in part, the way a
   * matte is painted. `data` is RGBA as getImageData gives it, changed in
   * place.
   */
  function maskPixels(data, by) {
    for (let i = 0; i < data.length; i += 4) {
      const a = by === 'luma'
        ? (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * (data[i + 3] / 255)
        : data[i + 3];
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(a);
    }
    return data;
  }

  /** Whether a picture has any pixel that is not wholly opaque. */
  function hasTransparency(data) {
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
  }

  /**
   * V3.5. A shape on its clip, which is drawn over the checkerboard of the
   * clip itself, so nothing here may cut into what is under it: an inverted
   * one is its colour in a margin round the shape with the shape left out, by
   * the even-odd rule alone. The path is left traced for the clip's dark edge.
   */
  function drawShapeIcon(ctx, shape, b, band) {
    if (shape.invert) {
      const m = Math.max(2, b.h * 0.2);
      ctx.beginPath();
      ctx.rect(b.x - m, b.y - m, b.w + m * 2, b.h + m * 2);
      tracePath(ctx, shape, b);
      ctx.fillStyle = shape.color;
      ctx.fill('evenodd');
      return;
    }
    inkShape(ctx, shape, b, band, shape.color);
    traceShape(ctx, shape, b);
  }

  /** The measuring textLayout wants, done by canvas in the font a style names. */
  function measurer(ctx) {
    return (text, style, scale) => {
      ctx.font = layout.fontString(style, scale);
      const m = ctx.measureText(text);
      return {
        width: m.width,
        // The font's own ascent and descent rather than the letters', so a line
        // of lowercase is as tall as a line of capitals and lines do not jump
        // about as they are typed.
        ascent: m.fontBoundingBoxAscent,
        descent: m.fontBoundingBoxDescent,
      };
    };
  }

  // The underline and the strike as rectangles, since fillText draws neither.
  // Across the whole piece, spaces included, which is what an underline under
  // a phrase looks like everywhere else.
  function decorations(piece, line, left, top, scale) {
    const s = piece.style;
    const px = s.size * scale;
    const h = Math.max(1, px * layout.DECORATION_WIDTH);
    const out = [];
    if (s.underline) {
      out.push({ x: left + piece.x, y: top + line.baseline + px * layout.UNDERLINE_OFFSET, w: piece.width, h });
    }
    if (s.strike) {
      out.push({ x: left + piece.x, y: top + line.baseline - px * layout.STRIKE_OFFSET - h / 2, w: piece.width, h });
    }
    return out;
  }

  // The text's box in the frame's pixels: its own, or the whole frame.
  function boxOf(text, scale, width, height) {
    return text.box
      ? { x: text.box.x * scale, y: text.box.y * scale, w: text.box.w * scale, h: text.box.h * scale }
      : { x: 0, y: 0, w: width, h: height };
  }

  // The rotation, about the box's centre. The caller saves and restores.
  function turn(ctx, text, box) {
    if (!text.rotation) return;
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(text.rotation * Math.PI / 180);
    ctx.translate(-cx, -cy);
  }

  function inkSetup(ctx) {
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
  }

  /**
   * One pass over the pieces: 'outline' strokes the outlined ones, 'fill' fills
   * every one in its colour. `ink`, when given, is the colour both are drawn in
   * instead, which is how the shadow's mask is made out of the same strokes and
   * fills as the letters. `paints`, V4.6, is textPaints' gradients by run.
   *
   * The outline's stroke is twice its thickness wide, because a stroke is
   * centred on the letter's edge and the fill covers the inner half. The
   * thickness the user set is what shows outside the letter.
   */
  function inkPass(ctx, pieces, box, scale, pass, ink, paints) {
    for (const { piece, line } of pieces) {
      ctx.font = layout.fontString(piece.style, scale);
      if (pass === 'outline') {
        const o = piece.style.outline;
        if (!o) continue;
        const w = o.width * scale;
        ctx.strokeStyle = ink || o.color;
        ctx.fillStyle = ink || o.color;
        ctx.lineWidth = w * 2;
        if (piece.text.trim()) ctx.strokeText(piece.text, box.x + piece.x, box.y + line.baseline);
        for (const d of decorations(piece, line, box.x, box.y, scale)) {
          ctx.fillRect(d.x - w, d.y - w, d.w + w * 2, d.h + w * 2);
        }
      } else {
        // V4.6. Its stretch's gradient when it has one, underline and
        // strike with it.
        ctx.fillStyle = ink || (paints && paints.get(piece.run)) || piece.style.color;
        if (piece.text.trim()) ctx.fillText(piece.text, box.x + piece.x, box.y + line.baseline);
        for (const d of decorations(piece, line, box.x, box.y, scale)) {
          ctx.fillRect(d.x, d.y, d.w, d.h);
        }
      }
    }
  }

  // ---- the shadow ----
  //
  // Not canvas's shadowBlur, which is a Gaussian and can do neither of the
  // user's two figures: Size, the shadow grown that far round every letter,
  // and Fade-out, how much of the colour's alpha is gone by the far edge of it,
  // in a straight line. Both are a matter of how far a pixel is from the
  // nearest letter, so that distance is worked out for every pixel near the
  // text: the letters (outline and all) drawn as a mask, and an exact
  // Euclidean distance transform over it.

  const FAR = 1e20;

  // Felzenszwalb and Huttenlocher's one-dimensional squared distance transform,
  // over `n` values of `grid` from `offset` in steps of `stride`, in place. The
  // lower envelope of the parabolas rooted at each sample. `f`, `v` and `z` are
  // scratch arrays at least n + 1 long.
  function edt1d(grid, offset, stride, n, f, v, z) {
    v[0] = 0;
    z[0] = -FAR;
    z[1] = FAR;
    f[0] = grid[offset];
    for (let q = 1, k = 0; q < n; q += 1) {
      f[q] = grid[offset + q * stride];
      const q2 = q * q;
      let s;
      // f[q] - f[r] first, so two samples that are both FAR subtract to 0
      // rather than losing the q2 - r2 beside them to rounding.
      do {
        const r = v[k];
        s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
      } while (s <= z[k] && --k > -1);
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = FAR;
    }
    for (let q = 0, k = 0; q < n; q += 1) {
      while (z[k + 1] < q) k += 1;
      const r = v[k];
      grid[offset + q * stride] = f[r] + (q - r) * (q - r);
    }
  }

  /**
   * The squared distance from every pixel of a `w` by `h` grid to the nearest
   * one `inside` says is set, exact, in two passes: along the rows, then down
   * the columns of what the rows gave. Zero on the set pixels themselves, and
   * FAR or more everywhere when none is set.
   */
  function distanceField(inside, w, h) {
    const grid = new Float64Array(w * h);
    for (let i = 0; i < w * h; i += 1) grid[i] = inside[i] ? 0 : FAR;
    const n = Math.max(w, h);
    const f = new Float64Array(n + 1);
    const v = new Int32Array(n + 1);
    const z = new Float64Array(n + 2);
    for (let y = 0; y < h; y += 1) edt1d(grid, y * w, 1, w, f, v, z);
    for (let x = 0; x < w; x += 1) edt1d(grid, x, w, h, f, v, z);
    return grid;
  }

  /**
   * The shadow's alpha, 0 to 1, at `d` pixels out from the letter's edge, for
   * a shadow `size` pixels deep that loses `fade` of its alpha by the far edge.
   * The far edge itself is smoothed over one pixel, since with Fade-out below
   * 100% the shadow still has alpha to lose there and would be jagged.
   */
  function shadowFalloff(d, size, fade) {
    if (d <= 0) return 1;
    const ramp = 1 - fade * Math.min(d, size) / size;
    const cover = Math.min(1, Math.max(0, size - d + 0.5));
    return ramp * cover;
  }

  /**
   * The shadow's pixels from the letters' mask: `mask` is RGBA as getImageData
   * gives it, `w` by `h`, of which only the alpha is read. Answers RGBA in the
   * shadow's colour, the alpha that colour's alpha times the falloff.
   *
   * A pixel is a letter's when the mask covers at least half of it. The
   * distance is measured from the centre of the nearest such pixel, which puts
   * the letter's edge half a pixel nearer than that, and the mask's own soft
   * edge is kept wherever it is more than the falloff, so a thin shadow is as
   * smooth as the letters it comes from.
   */
  function shadowPixels(mask, w, h, shadow, scale) {
    const size = Math.max(0.01, shadow.size * scale);
    const fade = shadow.fade;
    const inside = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i += 1) inside[i] = mask[i * 4 + 3] >= 128 ? 1 : 0;
    const sq = distanceField(inside, w, h);
    const c = colourBytes(shadow.color);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      const soft = mask[i * 4 + 3] / 255;
      const fall = inside[i] ? 1 : shadowFalloff(Math.sqrt(sq[i]) - 0.5, size, fade);
      const a = Math.max(soft, fall) * c.a;
      if (a <= 0) continue;
      out[i * 4] = c.r;
      out[i * 4 + 1] = c.g;
      out[i * 4 + 2] = c.b;
      out[i * 4 + 3] = Math.round(a * 255);
    }
    return out;
  }

  // `#rrggbbaa` as bytes, the alpha as 0 to 1.
  function colourBytes(color) {
    const hex = String(color).replace('#', '');
    const byte = (i) => parseInt(hex.slice(i, i + 2), 16) || 0;
    return { r: byte(0), g: byte(2), b: byte(4), a: hex.length >= 8 ? byte(6) / 255 : 1 };
  }

  /** Where the shadow lands from the letters, in frame pixels. */
  function shadowOffset(shadow, scale) {
    const a = shadow.angle * Math.PI / 180;
    const d = shadow.distance * scale;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d };
  }

  // A canvas to draw the mask on, where there is one to be had: the window
  // has OffscreenCanvas, and node has neither it nor any use for a shadow.
  // One, kept, since a slider drag asks for it on every step.
  let maskSurface = null;
  function defaultSurface(w, h) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    if (!maskSurface) maskSurface = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
    const c = maskSurface.canvas;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return maskSurface;
  }

  /**
   * One shadow, under the pieces that carry it. The mask is the frame grown
   * on every side by as far as a shadow can reach into it, so a letter off the
   * edge of the frame still casts into it. Only the part of the mask with ink
   * on it, and the shadow's depth round that, goes through the distance
   * transform, which keeps a title at the bottom of a 1080p frame to a strip.
   *
   * The mask is drawn turned with the text, and the shadow is offset in the
   * frame's own directions afterwards: 45 degrees falls down and to the right
   * whichever way the text is turned, like a light that stays where it is.
   */
  function drawShadow(ctx, text, pieces, box, scale, shadow, width, height, surface) {
    const size = shadow.size * scale;
    const off = shadowOffset(shadow, scale);
    // Held to the frame, so a file written by hand with a huge figure costs a
    // frame's worth of work and no more.
    const pad = Math.ceil(Math.min(size + Math.hypot(off.x, off.y), Math.max(width, height))) + 2;
    const mw = width + pad * 2;
    const mh = height + pad * 2;
    const m = surface(mw, mh);
    if (!m) return;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, mw, mh);
    m.save();
    m.translate(pad, pad);
    turn(m, text, box);
    inkSetup(m);
    inkPass(m, pieces, box, scale, 'outline', '#000000');
    inkPass(m, pieces, box, scale, 'fill', '#000000');
    m.restore();

    const all = m.getImageData(0, 0, mw, mh).data;
    let x0 = mw;
    let y0 = mh;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < mh; y += 1) {
      const row = y * mw * 4;
      for (let x = 0; x < mw; x += 1) {
        if (!all[row + x * 4 + 3]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return;
    const reach = Math.ceil(size) + 2;
    const rx = Math.max(0, x0 - reach);
    const ry = Math.max(0, y0 - reach);
    const rw = Math.min(mw, x1 + reach + 1) - rx;
    const rh = Math.min(mh, y1 + reach + 1) - ry;
    const part = m.getImageData(rx, ry, rw, rh);
    part.data.set(shadowPixels(part.data, rw, rh, shadow, scale));
    m.clearRect(0, 0, mw, mh);
    m.putImageData(part, rx, ry);
    ctx.drawImage(m.canvas, rx, ry, rw, rh, rx - pad + off.x, ry - pad + off.y, rw, rh);
  }

  /**
   * The text in three passes: the shadows, then every outline, then every
   * fill, so an outline never lies across a letter of the line above it and no
   * shadow across either. The outline before the fill is the look
   * `paint-order: stroke fill` gives the Edit Mode box, and the same one here.
   *
   * The box and the rotation are 3.1's. With neither the text is laid out in
   * the whole frame; the rotation is about the box's centre.
   *
   * The shadow and the outline belong to the whole text (3.2 formats words
   * one by one, but never these two), so all of it goes into the one mask.
   */
  function drawText(ctx, gen, width, height, surface) {
    const laid = layoutOfText(ctx, gen, width, height);
    const { text, scale, box, result } = laid;
    const pieces = [];
    for (const line of result.lines) {
      for (const piece of line.pieces) pieces.push({ piece, line });
    }

    if (text.style.shadow && pieces.length) {
      drawShadow(ctx, text, pieces, box, scale, text.style.shadow, width, height, surface || defaultSurface);
    }

    ctx.save();
    turn(ctx, text, box);
    inkSetup(ctx);
    inkPass(ctx, pieces, box, scale, 'outline', null);
    // V4.6. The gradients are made here, inside the turn, so they turn with
    // the text they are measured from.
    inkPass(ctx, pieces, box, scale, 'fill', null, textPaints(ctx, laid));
    ctx.restore();
    return result;
  }

  // ---- V4.6. A text's gradients ----
  //
  // The user: "A (by drag) selected text should have the option to have a
  // gradient applied". A gradient belongs to a stretch of letters, neighbouring
  // runs that all carry the same one, and runs across the box round those
  // letters wherever they have been laid: one word, or three lines. Each
  // letter's box is its own font's, the ascent above the baseline and the
  // descent below, so a small word on a tall line has it across its own height.

  /** A text laid out in a frame: `{ text, scale, box, result }`, as drawText draws it. */
  function layoutOfText(ctx, gen, width, height) {
    const text = gen.text;
    const scale = scaleOf(gen, height);
    const box = boxOf(text, scale, width, height);
    const result = layout.layoutText({
      runs: text.runs,
      style: text.style,
      align: text.align,
      width: box.w,
      height: box.h,
      measure: measurer(ctx),
      scale,
    });
    return { text, scale, box, result };
  }

  /**
   * The box round the pieces `pick(piece)` says yes to, in the frame's pixels
   * with the text not turned, or null when there is none of them.
   */
  function piecesBox(laid, pick) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const line of laid.result.lines) {
      for (const piece of line.pieces) {
        if (!piece.text || !pick(piece)) continue;
        x0 = Math.min(x0, piece.x);
        x1 = Math.max(x1, piece.x + piece.width);
        y0 = Math.min(y0, line.baseline - piece.ascent);
        y1 = Math.max(y1, line.baseline + piece.descent);
      }
    }
    if (!(x1 >= x0) || !(y1 >= y0)) return null;
    return { x: laid.box.x + x0, y: laid.box.y + y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * The stretches a laid out text's gradients fill, textRuns.stretches' rule
   * on the file's runs: `list`, each `{ gradient, box }`, the box null for one
   * with no letter drawn, and `ids`, each run's place in the list or -1.
   */
  function textStretches(laid) {
    const { text } = laid;
    const list = [];
    const ids = [];
    let open = -1;
    text.runs.forEach((run, i) => {
      const g = layout.styleOf(text.style, run.style).gradient || null;
      if (g && open >= 0 && model.gradientKey(list[open].gradient) === model.gradientKey(g)) {
        ids[i] = open;
      } else if (g) {
        list.push({ gradient: g, box: null });
        open = list.length - 1;
        ids[i] = open;
      } else {
        ids[i] = -1;
        if (run.text) open = -1;
      }
    });
    list.forEach((stretch, n) => {
      stretch.box = piecesBox(laid, (piece) => ids[piece.run] === n);
    });
    return { list, ids };
  }

  /** How far a box reaches along a direction, the length a gradient's shares are of. */
  function gradientReach(angle, w, h) {
    const a = (Number(angle) || 0) * Math.PI / 180;
    return Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
  }

  /**
   * The line a text's gradient runs along in a box `b`: `{ x0, y0, x1, y1 }`
   * from its start to its end, through the box's middle. A line of no length
   * paints nothing in canvas, so it is given half a pixel, as a shape's is.
   */
  function gradientLine(g, b) {
    const a = (Number(g.angle) || 0) * Math.PI / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const reach = gradientReach(g.angle, b.w, b.h);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const from = g.start * reach;
    let to = g.end * reach;
    if (Math.abs(to - from) < 0.5) to = from + 0.5;
    return { x0: cx + cos * from, y0: cy + sin * from, x1: cx + cos * to, y1: cy + sin * to };
  }

  /**
   * A gradient measured in box `a`, as the same line measured in box `b`:
   * what a stretch cut in two gives each part, so the letters nobody touched
   * keep their look. Shares to four places, held to the model's range.
   */
  function rebaseGradient(g, a, b) {
    const rad = (Number(g.angle) || 0) * Math.PI / 180;
    const ra = gradientReach(g.angle, a.w, a.h);
    const rb = gradientReach(g.angle, b.w, b.h);
    if (!(rb > 0)) return g;
    const shift = (a.x + a.w / 2 - b.x - b.w / 2) * Math.cos(rad)
      + (a.y + a.h / 2 - b.y - b.h / 2) * Math.sin(rad);
    const share = (v) => Math.min(100, Math.max(-100, Math.round((shift + v * ra) / rb * 1e4) / 1e4));
    return { stops: g.stops, start: share(g.start), end: share(g.end), angle: g.angle };
  }

  /**
   * What each run of a laid out text is filled with when it is not its
   * colour: its stretch's gradient on `ctx`, by the run's index. Null with no
   * gradient in the text, or on a context that cannot make one.
   */
  function textPaints(ctx, laid) {
    if (typeof ctx.createLinearGradient !== 'function') return null;
    const { list, ids } = textStretches(laid);
    if (!list.length) return null;
    const made = list.map((stretch) => {
      if (!stretch.box) return null;
      const l = gradientLine(stretch.gradient, stretch.box);
      const lin = ctx.createLinearGradient(l.x0, l.y0, l.x1, l.y1);
      for (const stop of stretch.gradient.stops) lin.addColorStop(Math.min(1, Math.max(0, stop.at)), stop.color);
      return lin;
    });
    const paints = new Map();
    ids.forEach((n, i) => {
      if (n >= 0 && made[n]) paints.set(i, made[n]);
    });
    return paints;
  }

  // How each form is drawn. A new form, a shape say, adds its drawing here,
  // beside its settings in timeline.js's genOf and its entry in the window's
  // GEN_KINDS.
  const DRAWERS = {
    text: (ctx, gen, width, height, surface) => {
      if (gen.text) drawText(ctx, gen, width, height, surface);
    },
    bar: (ctx, gen, width, height) => drawBar(ctx, gen, width, height),
    shape: (ctx, gen, width, height, surface) => drawShape(ctx, gen, width, height,
      surface === undefined ? defaultShapeSurface : surface),
  };

  /**
   * A generated layer onto a cleared canvas of the frame's size. `surface`,
   * for the tests, is what the shadow's mask is drawn on: (w, h) to a 2D
   * context, or null for none.
   */
  function drawGen(ctx, gen, width, height, surface) {
    ctx.clearRect(0, 0, width, height);
    const draw = gen && DRAWERS[gen.form];
    if (draw) draw(ctx, gen, width, height, surface);
  }

  // ---- V3.3. Generated media between keyframes ----
  //
  // A generated layer with keyframes is, at any moment, its own settings with
  // the keyed ones blended between the two keyframes either side, and then
  // drawn exactly as it always is. So the preview and the export, which both
  // draw through drawGen, show one picture at every moment, and a text whose
  // box narrows re-wraps the way it would if the box had been set there.
  //
  // A box nobody set, a text laid out in the whole frame or a shape on its
  // default, is worked out to the rect it means before it is blended with one
  // that was set; two unset boxes stay unset. A turn takes the short way
  // round, so 170 to -170 degrees is twenty degrees and not three hundred and
  // forty. A colour blends every channel, alpha included, which is a fade.

  function hexByte(v) {
    return Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  }

  function blendColour(a, b, u) {
    const ch = (s, i) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
    let out = '#';
    for (let i = 0; i < 4; i++) {
      const p = ch(a, i);
      const q = ch(b, i);
      out += hexByte(p + (q - p) * u);
    }
    return out;
  }

  // A box in pixels at refHeight, or the one an unset box stands for.
  function keyedBox(gen, width, height) {
    const own = gen.form === 'shape' ? gen.shape : gen.text;
    if (own.box) return own.box;
    const k = scaleOf(gen, height);
    if (gen.form === 'shape') {
      const b = shapeBox(gen, width, height);
      return { x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k };
    }
    return { x: 0, y: 0, w: width / k, h: height / k };
  }

  function blendGen(a, b, u, width, height) {
    const lerp = (p, q) => p + (q - p) * u;
    if (a.form === 'bar') {
      return {
        ...a,
        bar: {
          ...a.bar,
          thickness: lerp(a.bar.thickness, b.bar.thickness),
          span: lerp(a.bar.span, b.bar.span),
          color: blendColour(a.bar.color, b.bar.color, u),
        },
      };
    }
    const own = a.form === 'shape' ? 'shape' : 'text';
    let box = null;
    if (a[own].box || b[own].box) {
      const p = keyedBox(a, width, height);
      const q = keyedBox(b, width, height);
      box = { x: lerp(p.x, q.x), y: lerp(p.y, q.y), w: lerp(p.w, q.w), h: lerp(p.h, q.h) };
    }
    if (own === 'shape') {
      // V3.6.2. The turn the short way round, as a text's is.
      const from = a.shape.rotation || 0;
      const spin = (((((b.shape.rotation || 0) - from) % 360) + 540) % 360) - 180;
      return {
        ...a,
        shape: {
          ...a.shape,
          box,
          soft: lerp(a.shape.soft || 0, b.shape.soft || 0),
          rotation: from + spin * u,
          radius: lerp(a.shape.radius || 0, b.shape.radius || 0),
        },
      };
    }
    const turn = ((((b.text.rotation - a.text.rotation) % 360) + 540) % 360) - 180;
    return { ...a, text: { ...a.text, box, rotation: a.text.rotation + turn * u } };
  }

  /**
   * A generated layer's settings at `t`, the clip's own seconds, in a frame of
   * this size. Without keyframes, its settings as they are.
   */
  function genAt(layer, t, width, height) {
    const list = model.keyframesFor(layer);
    if (!list.length) return layer.gen;
    const at = Number.isFinite(Number(t)) ? Number(t) : 0;
    if (at <= list[0].t) return model.withKeyed(layer.gen, list[0]);
    const last = list[list.length - 1];
    if (at >= last.t) return model.withKeyed(layer.gen, last);
    let i = 0;
    while (list[i + 1].t <= at) i += 1;
    const a = list[i];
    const b = list[i + 1];
    // V5.5.2. Bent by the two keyframes' ease (timeline.js keyEase).
    return blendGen(model.withKeyed(layer.gen, a), model.withKeyed(layer.gen, b),
      model.keyEase(a, b, (at - a.t) / (b.t - a.t)), width, height);
  }

  /**
   * The stretch of the clip, in its own seconds, over which its picture
   * changes, or null when it never does: no keyframes, one, or several that
   * all say the same. Before it and after it the picture holds still.
   */
  function genMotion(layer) {
    const list = model.keyframesFor(layer);
    if (list.length < 2) return null;
    const fields = model.GEN_KEYED[layer.gen.form] || [];
    const same = (k) => fields.every((f) => JSON.stringify(k[f]) === JSON.stringify(list[0][f]));
    if (list.every(same)) return null;
    const from = Math.max(0, list[0].t);
    const to = Math.min(layer.duration, list[list.length - 1].t);
    return to > from ? { from, to } : null;
  }

  /**
   * Everything the picture depends on, as one string: the settings and the
   * frame. Two layers with the same key draw the same pixels, which is what
   * lets the window skip a redraw and the export reuse a PNG it has written.
   */
  function keyOf(gen, width, height) {
    return JSON.stringify([gen, width, height]);
  }

  /** The font families a generated layer draws with, each once. */
  function familiesOf(gen) {
    if (!gen || gen.form !== 'text' || !gen.text) return [];
    const out = new Set([gen.text.style.font]);
    for (const run of gen.text.runs) {
      const s = layout.styleOf(gen.text.style, run.style);
      out.add(s.font);
    }
    return [...out].filter(Boolean);
  }

  /** Every CSS font a generated layer draws with, at its stored size, each once. */
  function fontsOf(gen) {
    if (!gen || gen.form !== 'text' || !gen.text) return [];
    const out = new Set([layout.fontString(gen.text.style)]);
    for (const run of gen.text.runs) out.add(layout.fontString(layout.styleOf(gen.text.style, run.style)));
    return [...out];
  }

  // ---- V4.10. Transitions ----
  //
  // What a fade does to a picture in place of fading it (timeline.js
  // "Transitions"). Five of them are a matte: where the new picture already
  // shows, at a moment of the way from the old one to it. drawTransitionMatte
  // is that matte and the only drawing of it, so the preview, which lays it
  // on the picture it is drawing, and the export, which writes it out frame
  // by frame for the encoder, cut by the same pixels. The other two move the
  // picture: geometry.js places a file's picture, and drawGenTransition below
  // draws a generated one, which is a canvas already.

  // Surfaces kept like the soft edge's: the window has OffscreenCanvas, node
  // has neither. 0 and 1 are a generated picture and its matte, 2 what a soft
  // iris is drawn on before it is blurred, 3 a dissolve's cells.
  const transitionSurfaces = [null, null, null, null];
  function transitionSurface(i, w, h) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    if (!transitionSurfaces[i]) transitionSurfaces[i] = new OffscreenCanvas(w, h).getContext('2d');
    const c = transitionSurfaces[i].canvas;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return transitionSurfaces[i];
  }

  /**
   * A dissolve cell's place in the order they come in, 0 up to 1: the same
   * for the same cell every time, and nothing like its neighbours'.
   */
  function dissolveOrder(i, j) {
    let n = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  }

  // A five-pointed star, one point straight up: how far in its points' hollows
  // lie, as a share of the points.
  const STAR_INNER = 0.381966;

  /**
   * How far a star whose points are at 1 reaches from its middle in a
   * direction: to the edge between the point and the hollow either side.
   */
  function starReach(angle) {
    const step = Math.PI / 5;
    const turn = ((((angle + Math.PI / 2) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / step;
    const k = Math.min(9, Math.floor(turn));
    const corner = (i) => {
      const a = -Math.PI / 2 + i * step;
      const reach = i % 2 ? STAR_INNER : 1;
      return [Math.cos(a) * reach, Math.sin(a) * reach];
    };
    const [ax, ay] = corner(k);
    const [bx, by] = corner(k + 1);
    const ex = bx - ax;
    const ey = by - ay;
    return (ax * ey - ay * ex) / (Math.cos(angle) * ey - Math.sin(angle) * ex);
  }

  /**
   * How large a star's points have to be for it to hold a picture `w` by
   * `h` about its middle: until the last corner is inside it. Worked out from
   * the corners rather than from the circle the star holds, which a wide
   * picture's corners are inside long before, so the star would have covered
   * the picture with a fifth of the way still to go.
   */
  function starCover(w, h) {
    const far = Math.hypot(w, h) / 2;
    let least = Infinity;
    for (const [x, y] of [[w, h], [-w, h], [w, -h], [-w, -h]]) {
      least = Math.min(least, starReach(Math.atan2(y, x)));
    }
    return far / least;
  }

  /**
   * An iris's opening as a path: `r` is how far it has opened, and at `far`,
   * the way to the picture's corner, every shape just covers the picture. A
   * square has the picture's own proportions and a diamond stands on its
   * corners.
   */
  function irisPath(ctx, shape, w, h, r, far) {
    const cx = w / 2;
    const cy = h / 2;
    const k = r / far;
    if (shape === 'square') {
      ctx.rect(cx - (k * w) / 2, cy - (k * h) / 2, k * w, k * h);
      return;
    }
    if (shape === 'diamond') {
      ctx.moveTo(cx, cy - k * h);
      ctx.lineTo(cx + k * w, cy);
      ctx.lineTo(cx, cy + k * h);
      ctx.lineTo(cx - k * w, cy);
      ctx.closePath();
      return;
    }
    if (shape === 'star') {
      const outer = k * starCover(w, h);
      for (let i = 0; i < 10; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const reach = i % 2 ? outer * STAR_INNER : outer;
        if (i) ctx.lineTo(cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
        else ctx.moveTo(cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
      }
      ctx.closePath();
      return;
    }
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }

  /**
   * A path filled white with its edge blurred by `sigma`, in the pixels the
   * path is said in: drawn sharp on a surface with room round it and blurred
   * back, as a shape's soft edge is. Sharp when there is no blur to make or
   * no surface to make it on.
   */
  function fillSoft(ctx, sigma, trace, surface) {
    const T = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
    const blur = T ? sigma * Math.hypot(T.a, T.b) : 0;
    const m = blur > 0.05 && ctx.canvas && surface
      ? surface(2, ctx.canvas.width + (Math.ceil(blur * 3) + 2) * 2, ctx.canvas.height + (Math.ceil(blur * 3) + 2) * 2)
      : null;
    if (!m) {
      ctx.beginPath();
      trace(ctx);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      return;
    }
    const pad = Math.ceil(blur * 3) + 2;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, m.canvas.width, m.canvas.height);
    m.setTransform(T.a, T.b, T.c, T.d, T.e + pad, T.f + pad);
    m.beginPath();
    trace(m);
    m.fillStyle = '#ffffff';
    m.fill();
    m.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'blur(' + blur + 'px)';
    ctx.drawImage(m.canvas, -pad, -pad);
    ctx.restore();
  }

  /**
   * Where the new picture already shows, `e` of the way through a transition
   * (0 none of it, 1 all of it), onto a cleared canvas: white where it does,
   * clear where it does not, in a box `w` by `h` at the context's origin. The
   * old picture's part is this taken away from everything.
   *
   * `pad` is how far round the box the matte is carried on, for a picture
   * that reaches past the box it is measured by, a title's shadow say. Each
   * kind goes on outside the box the way it goes inside it.
   *
   * `surface(i, w, h)` hands out scratch contexts, or is null for none: then
   * a soft iris is drawn sharp, which is what the tests draw.
   */
  function drawTransitionMatte(ctx, transition, e, w, h, pad = 0, surface) {
    const u = Math.min(1, Math.max(0, Number(e) || 0));
    if (u <= 0 || !transition) return;
    const on = surface === undefined ? transitionSurface : surface;
    const x0 = 0 - pad;
    const y0 = 0 - pad;
    const x1 = w + pad;
    const y1 = h + pad;
    ctx.save();
    if (u >= 1) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
      return;
    }
    const soft = Math.min(1, Math.max(0, Number(transition.soft) || 0));
    const kind = transition.kind;
    if (kind === 'wipe') {
      // A straight edge, square to the way it travels, from the box's near
      // corner to its far one. Its soft band is a share of that way, and it
      // starts wholly before the box and ends wholly past it.
      const a = (transition.angle * Math.PI) / 180;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const reach = (Math.abs(ux) * w + Math.abs(uy) * h) / 2;
      const band = Math.max(1, soft * 2 * reach);
      const mid = -reach - band / 2 + u * (2 * reach + band);
      const g = ctx.createLinearGradient(
        w / 2 + ux * (mid - band / 2), h / 2 + uy * (mid - band / 2),
        w / 2 + ux * (mid + band / 2), h / 2 + uy * (mid + band / 2));
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else if (kind === 'iris') {
      // A shape growing from the middle until it holds the whole box, or with
      // `reverse` everything but a shape that shrinks onto the middle.
      const far = Math.hypot(w, h) / 2;
      const sigma = (soft * far) / SOFT_SPREAD;
      const room = sigma * 3;
      const r = -room + (transition.reverse ? 1 - u : u) * (far + room * 2);
      if (transition.reverse) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.globalCompositeOperation = 'destination-out';
      }
      if (r > 0) fillSoft(ctx, sigma, (c) => irisPath(c, transition.shape, w, h, r, far), on);
    } else if (kind === 'clock') {
      // A hand going once round the middle from `start`, the new picture
      // behind it. `q` is a place on the way round, 0 up to 1.
      const band = Math.max(0.004, soft);
      const hand = -band / 2 + u * (1 + band);
      const alphaAt = (q) => Math.min(1, Math.max(0, (hand + band / 2 - q) / band));
      const g = ctx.createConicGradient((transition.start * Math.PI) / 180, w / 2, h / 2);
      for (const q of [0, hand - band / 2, hand + band / 2, 1]) {
        if (q < 0 || q > 1) continue;
        g.addColorStop(transition.clockwise ? q : 1 - q, 'rgba(255,255,255,' + alphaAt(q) + ')');
      }
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    } else if (kind === 'blinds') {
      // Slats side by side, each opening across its own width like a wipe.
      const along = transition.vertical ? w : h;
      const size = along / transition.count;
      const band = Math.max(1, soft * size);
      const edge = -band / 2 + u * (size + band);
      for (let i = Math.floor((0 - pad) / size); i < Math.ceil((along + pad) / size); i += 1) {
        const from = i * size;
        const g = transition.vertical
          ? ctx.createLinearGradient(from + edge - band / 2, 0, from + edge + band / 2, 0)
          : ctx.createLinearGradient(0, from + edge - band / 2, 0, from + edge + band / 2);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        if (transition.vertical) ctx.fillRect(from, y0, size, y1 - y0);
        else ctx.fillRect(x0, from, x1 - x0, size);
      }
    } else if (kind === 'dissolve') {
      // Square cells, `rows` of them down the box, each coming in at its own
      // moment and over `soft` of the way.
      const cell = h / transition.rows;
      const band = Math.max(0.001, soft);
      const level = u * (1 + band);
      // No further out than is worth the cells: a small box in a large frame
      // would otherwise ask for millions of them.
      const most = 1200;
      const i0 = Math.max(Math.floor(x0 / cell), Math.floor(w / cell / 2) - most);
      const i1 = Math.min(Math.ceil(x1 / cell), Math.ceil(w / cell / 2) + most);
      const j0 = Math.max(Math.floor(y0 / cell), Math.floor(transition.rows / 2) - most);
      const j1 = Math.min(Math.ceil(y1 / cell), Math.ceil(transition.rows / 2) + most);
      const cols = Math.max(1, i1 - i0);
      const rows = Math.max(1, j1 - j0);
      const alphaAt = (i, j) => Math.min(1, Math.max(0, (level - dissolveOrder(i, j)) / band));
      const cells = on ? on(3, cols, rows) : null;
      if (cells && typeof cells.createImageData === 'function') {
        // One pixel a cell, drawn up to size without smoothing, so cells meet
        // without a seam between them.
        const img = cells.createImageData(cols, rows);
        for (let j = 0; j < rows; j += 1) {
          for (let i = 0; i < cols; i += 1) {
            const at = (j * cols + i) * 4;
            img.data[at] = 255;
            img.data[at + 1] = 255;
            img.data[at + 2] = 255;
            img.data[at + 3] = Math.round(alphaAt(i0 + i, j0 + j) * 255);
          }
        }
        cells.putImageData(img, 0, 0);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(cells.canvas, 0, 0, cols, rows, i0 * cell, j0 * cell, cols * cell, rows * cell);
      } else {
        for (let j = j0; j < j1; j += 1) {
          for (let i = i0; i < i1; i += 1) {
            const a = alphaAt(i, j);
            if (a <= 0) continue;
            ctx.fillStyle = 'rgba(255,255,255,' + a + ')';
            ctx.fillRect(i * cell, j * cell, cell, cell);
          }
        }
      }
    }
    ctx.restore();
  }

  /**
   * The box a generated layer's transition is measured by, in the frame's
   * pixels, with its turn: a text's or a shape's own box, with room for an
   * outline, a shadow or a soft edge round it, a bar's strip, and the whole
   * frame for a text laid out in it or an inverted shape, which fills it.
   */
  function transitionBox(gen, width, height) {
    const whole = { x: 0, y: 0, w: width, h: height, rotation: 0 };
    if (!gen) return whole;
    const k = scaleOf(gen, height);
    const grown = (b, by, rotation) => ({
      x: b.x - by, y: b.y - by, w: b.w + by * 2, h: b.h + by * 2, rotation: Number(rotation) || 0,
    });
    if (gen.form === 'bar') return grown(barRect(gen.bar, k, width, height), 0, 0);
    if (gen.form === 'shape') {
      const s = gen.shape;
      if (s.invert) return whole;
      return grown(shapeBox(gen, width, height), (Number(s.soft) || 0) * k, s.rotation);
    }
    const text = gen.text;
    if (!text || !text.box) return whole;
    const style = text.style || {};
    const room = ((style.outline ? style.outline.width : 0)
      + (style.shadow ? style.shadow.distance + style.shadow.size : 0)) * k;
    return grown(boxOf(text, k, width, height), room, text.rotation);
  }

  /**
   * A generated layer's picture, `width` by `height` like the frame, drawn
   * through a transition onto a canvas `kx` by `ky` of its pixels for one of
   * the frame's: the whole of what a transition does to a text, a shape or a
   * bar, for the preview and for the frames the export writes. `state` is
   * timeline.js transitionAt's, and `box` transitionBox's, which a matte is
   * measured by and a zoom grows from the middle of. A slide crosses the
   * whole frame, since a title's own box would cut its shadow off.
   */
  function drawGenTransition(ctx, picture, state, box, width, height, kx = 1, ky = 1, surface) {
    const { half, transition } = state;
    const u = Math.min(1, Math.max(0, Number(state.e) || 0));
    const shown = half === 'in' ? u : 1 - u;
    if (shown <= 0) return;
    const W = width * kx;
    const H = height * ky;
    if (transition.kind === 'slide') {
      const a = (transition.angle * Math.PI) / 180;
      const by = half === 'in' ? -(1 - u) : u;
      ctx.drawImage(picture, 0, 0, width, height,
        Math.round(Math.cos(a)) * by * W, Math.round(Math.sin(a)) * by * H, W, H);
      return;
    }
    if (transition.kind === 'zoom') {
      const cx = (box.x + box.w / 2) * kx;
      const cy = (box.y + box.h / 2) * ky;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((half === 'in' ? -(1 - u) : u) * transition.turns * Math.PI * 2);
      ctx.scale(shown, shown);
      ctx.translate(-cx, -cy);
      ctx.drawImage(picture, 0, 0, width, height, 0, 0, W, H);
      ctx.restore();
      return;
    }
    const on = surface === undefined ? transitionSurface : surface;
    const w = Math.max(1, Math.round(W));
    const h = Math.max(1, Math.round(H));
    const p = on ? on(0, w, h) : null;
    const m = on ? on(1, w, h) : null;
    if (!p || !m) {
      ctx.drawImage(picture, 0, 0, width, height, 0, 0, W, H);
      return;
    }
    p.setTransform(1, 0, 0, 1, 0, 0);
    p.globalCompositeOperation = 'source-over';
    p.clearRect(0, 0, w, h);
    p.drawImage(picture, 0, 0, width, height, 0, 0, w, h);
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, w, h);
    // The matte in the box's own pixels, turned with it, and carried on over
    // the whole frame.
    m.setTransform(w / width, 0, 0, h / height, 0, 0);
    m.translate(box.x + box.w / 2, box.y + box.h / 2);
    m.rotate(((Number(box.rotation) || 0) * Math.PI) / 180);
    m.translate(-box.w / 2, -box.h / 2);
    drawTransitionMatte(m, transition, u, box.w, box.h, Math.hypot(width, height), on);
    m.setTransform(1, 0, 0, 1, 0, 0);
    p.globalCompositeOperation = half === 'in' ? 'destination-in' : 'destination-out';
    p.drawImage(m.canvas, 0, 0);
    p.globalCompositeOperation = 'source-over';
    ctx.drawImage(p.canvas, 0, 0, w, h, 0, 0, W, H);
  }

  return {
    // V4.10.
    drawTransitionMatte,
    dissolveOrder,
    transitionBox,
    drawGenTransition,
    scaleOf,
    barRect,
    SHAPE_ASPECT,
    SOFT_SPREAD,
    shapeAspect,
    shapeBox,
    fillShape,
    // V3.7.
    shapePaint,
    gradientColourAt,
    drawShapeIcon,
    // V3.6. Masks.
    maskBox,
    maskStartBox,
    drawMask,
    // V4.7.
    drawCoverMask,
    coverRegion,
    coverRegionUnion,
    // V3.7.1.
    maskStrength,
    maskStrengthPaint,
    maskPixels,
    hasTransparency,
    // V4.6. A text's gradients.
    layoutOfText,
    piecesBox,
    textStretches,
    gradientReach,
    gradientLine,
    rebaseGradient,
    drawGen,
    genAt,
    genMotion,
    distanceField,
    shadowFalloff,
    shadowPixels,
    shadowOffset,
    keyOf,
    familiesOf,
    fontsOf,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = genDraw;
