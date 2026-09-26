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
   * Pieces with the same shadow share one mask. In 3.0 that is all of them,
   * but a word with a shadow of its own, later, will get its own.
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

    const shadows = new Map();
    for (const p of pieces) {
      const s = p.piece.style.shadow;
      if (!s) continue;
      const key = JSON.stringify(s);
      if (!shadows.has(key)) shadows.set(key, { shadow: s, pieces: [] });
      shadows.get(key).pieces.push(p);
    }
    for (const { shadow, pieces: cast } of shadows.values()) {
      drawShadow(ctx, text, cast, box, scale, shadow, width, height, surface || defaultSurface);
    }

    ctx.save();
    turn(ctx, text, box);
    inkSetup(ctx);
    inkPass(ctx, pieces, box, scale, 'outline', null);
    inkPass(ctx, pieces, box, scale, 'fill', null);
    ctx.restore();
    return result;
  }

  /**
   * A generated layer onto a cleared canvas of the frame's size. `surface`,
   * for the tests, is what the shadow's mask is drawn on: (w, h) to a 2D
   * context, or null for none.
   */
  function drawGen(ctx, gen, width, height, surface) {
    ctx.clearRect(0, 0, width, height);
    if (!gen) return;
    if (gen.form === 'bar') drawBar(ctx, gen, width, height);
    else if (gen.text) drawText(ctx, gen, width, height, surface);
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
    drawGen,
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
