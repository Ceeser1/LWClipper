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
  };

  // Width over height of a shape's default box, so a new one is the regular
  // shape: an equilateral triangle, a star with its own proportions (the
  // regular five-point one's here, any other's from shapeAspect).
  const SHAPE_ASPECT = {
    circle: 1,
    square: 1,
    ring: 1,
    triangle: 2 / Math.sqrt(3),
    star: Math.cos(Math.PI / 10) / (0.5 + 0.5 * Math.cos(Math.PI / 5)),
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
  function tracePath(ctx, shape, b) {
    const kind = shape.kind;
    if (kind === 'circle' || kind === 'ring') {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      ctx.moveTo(cx + b.w / 2, cy);
      ctx.ellipse(cx, cy, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
      if (kind === 'ring') {
        const hole = 1 - (Number.isFinite(shape.ring) ? shape.ring : SHAPE_DEFAULTS.ring);
        ctx.moveTo(cx + b.w / 2 * hole, cy);
        ctx.ellipse(cx, cy, b.w / 2 * hole, b.h / 2 * hole, 0, 0, Math.PI * 2);
      }
      return;
    }
    const pts = kind === 'star'
      ? starPolygon(shape.points || SHAPE_DEFAULTS.points, shape.inner || SHAPE_DEFAULTS.inner).pts
      : SHAPE_POLYGONS[kind] || SHAPE_POLYGONS.square;
    pts.forEach(([x, y], i) => {
      if (i) ctx.lineTo(b.x + x * b.w, b.y + y * b.h);
      else ctx.moveTo(b.x + x * b.w, b.y + y * b.h);
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
    const s = gen.shape;
    const b = shapeBox(gen, width, height);
    const k = scaleOf(gen, height);
    const soft = Math.max(0, (s.soft || 0) * k);
    const band = s.outline ? Math.max(0.5, s.line * k) : 0;
    if (!s.invert && !soft && !band) {
      fillShape(ctx, s, b, s.color);
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
   * fills as the letters.
   *
   * The outline's stroke is twice its thickness wide, because a stroke is
   * centred on the letter's edge and the fill covers the inner half. The
   * thickness the user set is what shows outside the letter.
   */
  function inkPass(ctx, pieces, box, scale, pass, ink) {
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
        ctx.fillStyle = ink || piece.style.color;
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
    inkPass(ctx, pieces, box, scale, 'fill', null);
    ctx.restore();
    return result;
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
      return { ...a, shape: { ...a.shape, box, soft: lerp(a.shape.soft || 0, b.shape.soft || 0) } };
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
    return blendGen(model.withKeyed(layer.gen, a), model.withKeyed(layer.gen, b),
      (at - a.t) / (b.t - a.t), width, height);
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

  return {
    scaleOf,
    barRect,
    SHAPE_ASPECT,
    SOFT_SPREAD,
    shapeAspect,
    shapeBox,
    fillShape,
    drawShapeIcon,
    // V3.6's masks draw the same shapes, in their own box.
    tracePath,
    inkShape,
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
