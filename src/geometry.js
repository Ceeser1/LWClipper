'use strict';

// Where a layer's picture lands. Pure maths, no DOM and no Electron, and the
// single answer that both renderers read: the preview turns it into drawImage
// arguments, the encoder turns it into crop, scale and overlay. They cannot
// disagree about the framing because neither of them works it out.
//
// Three coordinate spaces, kept apart on purpose:
//
//   source pixels   what the file actually contains. The crop rect lives here.
//   project pixels  the output frame. The render rect lives here.
//   canvas pixels   the rough preview, 854x480 or smaller. Derived, never stored.
//
// The project ratio rules everywhere. A source that does not match it is
// centred and letterboxed or pillarboxed rather than stretched or cut.

// Wrapped the way src/timeline.js is, and for the same reason: the window
// loads this as a plain script beside app.js, where a top-level const shares
// one scope with every other script. evenDown is declared in both files.
const layerGeometry = (() => {
  // H.264 refuses odd dimensions, and ffmpeg's crop filter masks the low bit off
  // x and y itself on a subsampled format because a chroma plane has no sample to
  // start from there. Rounding here means the numbers we emit are the numbers
  // that get used, rather than something ffmpeg quietly adjusts afterwards. Same
  // rule as backend.js cropFilter, deliberately duplicated rather than reaching
  // into simple mode's module for it.
  const evenDown = (v) => Math.floor(v / 2) * 2;

  // The rough preview, as decided in the design. Anything larger buys detail
  // nobody is looking at while costing composite time that five layers need.
  const PREVIEW_MAX_W = 854;
  const PREVIEW_MAX_H = 480;

  // What a project frame is allowed to be. The floor is the same 2 that fitRect
  // already refuses to work below. The ceiling is 8K, which is past anything
  // this app will be handed and still small enough that one digit too many in a
  // typed box cannot ask for a canvas the size of a hard disk.
  const FRAME_MIN = 2;
  const FRAME_MAX = 7680;

  function finite(v, fallback) {
    return Number.isFinite(Number(v)) ? Number(v) : fallback;
  }

  /**
   * The part of the source frame a layer shows, in source pixels, even-aligned
   * and clamped inside the frame. A null or whole-frame crop gives the lot.
   */
  function sourceRect(source, crop) {
    const srcW = evenDown(Math.max(0, finite(source && source.width, 0)));
    const srcH = evenDown(Math.max(0, finite(source && source.height, 0)));
    if (srcW < 2 || srcH < 2) return null;
    if (!crop) return { x: 0, y: 0, width: srcW, height: srcH };

    let x = evenDown(Math.max(0, finite(crop.x, 0)));
    let y = evenDown(Math.max(0, finite(crop.y, 0)));
    x = Math.min(x, srcW - 2);
    y = Math.min(y, srcH - 2);
    const w = Math.min(Math.max(2, evenDown(finite(crop.width, srcW))), srcW - x);
    const h = Math.min(Math.max(2, evenDown(finite(crop.height, srcH))), srcH - y);
    return { x, y, width: w, height: h };
  }

  function isWholeFrame(rect, source) {
    if (!rect) return true;
    return rect.x === 0 && rect.y === 0
      && rect.width >= evenDown(finite(source && source.width, 0))
      && rect.height >= evenDown(finite(source && source.height, 0));
  }

  /**
   * Centre and fit: the largest even-sized box of the given aspect that fits
   * inside the project frame, centred in it.
   *
   * This is what stands in for the Render Position tab until V2.1, and it is also
   * what a filmstrip thumbnail wants, since a thumbnail is just a very small
   * project frame. It scales up as readily as down, so a 640x360 source fills a
   * 1080p project rather than sitting tiny in the middle of it.
   */
  function fitRect(width, height, project) {
    const projW = evenDown(Math.max(0, finite(project && project.width, 0)));
    const projH = evenDown(Math.max(0, finite(project && project.height, 0)));
    const w = Math.max(0, finite(width, 0));
    const h = Math.max(0, finite(height, 0));
    if (projW < 2 || projH < 2 || w < 1 || h < 1) return null;

    const scale = Math.min(projW / w, projH / h);
    const outW = Math.max(2, Math.min(projW, evenDown(Math.round(w * scale))));
    const outH = Math.max(2, Math.min(projH, evenDown(Math.round(h * scale))));
    return {
      x: evenDown(Math.round((projW - outW) / 2)),
      y: evenDown(Math.round((projH - outH) / 2)),
      width: outW,
      height: outH,
    };
  }

  /**
   * A typed resolution turned into one an encoder will take, or null.
   *
   * Even, because H.264 refuses odd dimensions, and evenDown rather than
   * rounding to the nearest even for the same reason sourceRect uses it: the
   * number that comes out here is the number that gets used, and nothing
   * downstream should have to adjust it again.
   *
   * Null for anything that is not a pair of numbers, which is what an emptied
   * box hands over. A caller that gets null puts the project's own size back
   * rather than guessing at what was meant.
   */
  function frameSize(width, height) {
    // Not finite() above, which would take an emptied box: Number('') is 0, and
    // 0 reads as a resolution rather than as nothing typed.
    const num = (v) => {
      if (v === null || v === undefined || String(v).trim() === '') return NaN;
      const n = Number(v);
      return Number.isFinite(n) ? n : NaN;
    };
    const w = num(width);
    const h = num(height);
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
    const fit = (v) => evenDown(Math.min(FRAME_MAX, Math.max(FRAME_MIN, Math.round(v))));
    return { width: fit(w), height: fit(h) };
  }

  /**
   * A render rect carried from one project frame to another.
   *
   * The whole composition is treated as a picture of the old frame, and that
   * picture is centred and fitted into the new one, which is fitRect's own
   * arithmetic applied to a frame instead of to a source.
   *
   * Leaving the numbers where they are would be the natural implementation and
   * it is wrong: a project taken from 1280x720 to 1920x1080 is a request for a
   * bigger file, not for a different composition, and every placed layer would
   * keep its pixel size and slide towards the top left corner.
   *
   * At an unchanged aspect, which is what asking for a bigger file means, this
   * agrees exactly with recomputing the layer from null: a layer sitting on its
   * own fit lands on the new fit. At a changed aspect the two part company, and
   * that is the difference between a layer that was placed and one that was
   * not. An unplaced layer has no arrangement to keep, so it refits; a placed
   * one was put somewhere in relation to everything else in the frame, so the
   * arrangement travels whole and gets letterboxed with it.
   *
   * A rect is allowed off the edge of the frame, so nothing is clamped here.
   */
  function rescaleRender(rect, from, to) {
    if (!rect) return null;
    const fromW = Math.max(0, finite(from && from.width, 0));
    const fromH = Math.max(0, finite(from && from.height, 0));
    const box = fitRect(fromW, fromH, to);
    // No old frame to measure against, or no new one worth speaking of. The
    // rect is handed back untouched rather than recentred on a guess.
    if (!box || fromW < 1) return rect;
    const s = box.width / fromW;
    return {
      x: Math.round(box.x + finite(rect.x, 0) * s),
      y: Math.round(box.y + finite(rect.y, 0) * s),
      width: Math.max(2, Math.round(finite(rect.width, 0) * s)),
      height: Math.max(2, Math.round(finite(rect.height, 0) * s)),
    };
  }

  /**
   * A crop rectangle resized to a fixed shape, anchored, and held inside bounds.
   *
   * V2.1 step 21e-3, which is Shift and Ctrl held together on a bar or a corner:
   * the drag keeps the shape the lit preset names, and the side that was not
   * dragged follows the side that was.
   *
   * `hold` says what stays where on each axis. A corner pins the two edges of
   * the corner opposite it, so the box grows away from a fixed point. A bar pins
   * the edge opposite itself and the centre of the other axis, so the box grows
   * about itself rather than sliding sideways as it changes shape.
   *
   *     'lo'  the near edge stays        'hi'  the far edge stays
   *     'mid' the centre stays
   *
   * `want` is the width the drag is asking for. The height follows from the
   * ratio, so one number drives both and there is no way for the two to
   * disagree. Both come back even, because yuv420p has no odd frame, and the
   * evening is what makes the shape approximate by up to a pixel rather than
   * exact: a 16:9 box 482 wide is 270 tall and not 271.125.
   *
   * The limit is worked out rather than searched for. Each axis has a largest
   * size its own anchor allows inside the bounds, and the width is held to the
   * smaller of its own and what the height's limit permits through the ratio,
   * so a box that runs into one edge stops keeping its shape at that edge
   * instead of breaking it.
   */
  function ratioResize(start, ratio, hold, want, bounds, minSide) {
    const r = finite(ratio, 0);
    if (!start || !(r > 0)) return null;
    const least = Math.max(2, evenDown(finite(minSide, 2)));
    const x0 = finite(start.x, 0);
    const y0 = finite(start.y, 0);
    const w0 = Math.max(0, finite(start.width, 0));
    const h0 = Math.max(0, finite(start.height, 0));
    const minX = finite(bounds && bounds.minX, -Infinity);
    const maxX = finite(bounds && bounds.maxX, Infinity);
    const minY = finite(bounds && bounds.minY, -Infinity);
    const maxY = finite(bounds && bounds.maxY, Infinity);

    // How large each axis may be with its own anchor where it is.
    const room = (lo, span, min, max, how) => {
      if (how === 'lo') return max - lo;
      if (how === 'hi') return lo + span - min;
      const mid = lo + span / 2;
      return 2 * Math.min(mid - min, max - mid);
    };
    const roomW = room(x0, w0, minX, maxX, hold.x);
    const roomH = room(y0, h0, minY, maxY, hold.y);

    const width = Math.max(least, evenDown(Math.min(
      Math.max(least, finite(want, w0)), Math.max(least, roomW), Math.max(least, roomH) * r)));
    const height = Math.max(least, evenDown(width / r));

    const place = (lo, span, next, how) => {
      if (how === 'lo') return lo;
      if (how === 'hi') return lo + span - next;
      return evenDown(lo + span / 2 - next / 2);
    };
    return {
      x: place(x0, w0, width, hold.x),
      y: place(y0, h0, height, hold.y),
      width,
      height,
    };
  }

  /**
   * How many fr units the two side columns of the preview get.
   *
   * V2.1 step 21c-3. The three frames are laid out as `side 1fr side`, one
   * number for both edges, so the mirroring is the shape of the rule rather than
   * two values that have to be kept agreeing. `span` is the room the columns
   * divide, which is the grid's width less its gaps, since gaps are taken out
   * before the fr units are worked out.
   *
   *     side = span * s / (2s + 1)      middle = span / (2s + 1)
   *
   * so the fraction wanted for a side of `want` pixels is just side over middle.
   * At s = 1 that is three equal columns, which is what the stylesheet says
   * before anything has been dragged.
   *
   * Null when there is nothing left for the middle column. A caller with no
   * fraction to apply leaves the stylesheet's own three-way split alone, which
   * is the right answer for a grid too narrow to divide.
   */
  function sideFraction(want, span, sideMin, middleMin) {
    const room = Math.max(0, finite(span, 0));
    const floor = Math.max(0, finite(sideMin, 0));
    const middle = Math.max(0, finite(middleMin, 0));
    // The widest a side may be is what leaves the middle its own floor. The max
    // keeps the two floors from crossing on a grid too narrow for both, and the
    // side wins that, because the middle is the one that can usefully be small:
    // it is a picture, and the sides are a picture plus a fixed-width field.
    const ceiling = Math.max(floor, (room - middle) / 2);
    const side = Math.min(Math.max(finite(want, floor), floor), ceiling);
    const left = room - 2 * side;
    if (left <= 0) return null;
    return side / left;
  }

  /**
   * How tall to hold the timeline stack: the height the splitter was dragged to,
   * kept inside what the two frames can actually give each other.
   *
   * The preview is the only section in the column that grows, so every pixel the
   * stack takes comes out of it and `stack + preview` does not move. That sum is
   * `room`, and it is why the whole clamp is one line of arithmetic rather than a
   * walk down the layout.
   *
   * The outer max is the window being too short for both floors at once. The
   * timeline wins it, because a preview of a hundred pixels is a small preview
   * and a timeline of a hundred pixels has cut the audio row in half.
   */
  function splitHeight(wish, room, stackFloor, previewFloor) {
    const floor = Math.max(0, finite(stackFloor, 0));
    const ceiling = Math.max(floor, finite(room, 0) - Math.max(0, finite(previewFloor, 0)));
    return Math.round(Math.min(Math.max(finite(wish, floor), floor), ceiling));
  }

  /**
   * Everything about where one layer's picture goes: which part of the source to
   * take, and where in the project frame to put it.
   *
   * `render` is the explicit destination rect the V2.1 Render Position tab will
   * set. Until then it is null and the fit is worked out, which is why the two
   * paths are the same function rather than two.
   *
   * A render rect is allowed to hang off the edge of the frame. overlay clips it
   * and the canvas clips it, both without complaint, and refusing it here would
   * make "slide a layer out of shot" impossible later.
   */
  function placeLayer({ source, crop = null, render = null, project }) {
    const src = sourceRect(source, crop);
    if (!src) return null;

    let dest;
    if (render) {
      const w = Math.max(2, evenDown(Math.round(finite(render.width, src.width))));
      const h = Math.max(2, evenDown(Math.round(finite(render.height, src.height))));
      dest = {
        x: evenDown(Math.round(finite(render.x, 0))),
        y: evenDown(Math.round(finite(render.y, 0))),
        width: w,
        height: h,
      };
    } else {
      dest = fitRect(src.width, src.height, project);
    }
    if (!dest) return null;
    return { src, dest };
  }

  /**
   * Where something of this size sits along an axis of this length, anchored at
   * the near edge, the middle, or the far edge.
   *
   * Returns the centre, because a centre is what the placement is carried as.
   * At 0 it is the size's own half, so the near edge lands on 0; at 1 it is the
   * span less that half, so the far edge lands on the span exactly. Which is
   * the whole of what the corner rings were asked to do on 2026-09-23: "a click
   * on left-top is the only one that positions it at 0, 0. Other circle clicks
   * must position the bottom or right of the image so that they are not cut off
   * but exactly at the edge".
   *
   * A size larger than the span gives a centre outside it, and that is right:
   * the anchored edge still lands on the span and the other one hangs off, the
   * same way a render rect is allowed to hang off the frame anywhere else.
   */
  function anchorCentre(anchor, span, size) {
    return anchor * span + (0.5 - anchor) * size;
  }

  /**
   * Which row of a clip an alpha of this much is drawn on.
   *
   * The user set the scale when they asked for the control: "From 100% to 0%
   * height of the track." So 100% is the clip's first row and 0% is its last,
   * and everything between them is linear.
   *
   * span - 1 rather than span, because a rectangle of 64 pixels has 64 rows and
   * not 65 boundaries. Without it 0% lands one row past the bottom of the clip,
   * where it is drawn by nobody and seen by no one, which is exactly what V2.4
   * shipped.
   *
   * It lives here rather than in the window because four drawings read it: the
   * line, the bar that moves it, and the top of each of the two fade ramps. A
   * second copy of this sum would drift at the extremes first, which is where
   * anybody would look.
   */
  function alphaRow(span, alpha) {
    const rows = Math.max(0, finite(span, 0) - 1);
    const a = Math.min(1, Math.max(0, finite(alpha, 1)));
    return (1 - a) * rows;
  }

  /**
   * The preview canvas: the project's own shape, capped at the rough-preview
   * size. Keeping it at the project aspect is what lets the letterboxing show up
   * on screen exactly where it will be in the file.
   */
  function previewCanvasSize(project, maxW = PREVIEW_MAX_W, maxH = PREVIEW_MAX_H) {
    const projW = Math.max(0, finite(project && project.width, 0));
    const projH = Math.max(0, finite(project && project.height, 0));
    if (projW < 1 || projH < 1) return null;
    const scale = Math.min(1, maxW / projW, maxH / projH);
    return {
      width: Math.max(1, Math.round(projW * scale)),
      height: Math.max(1, Math.round(projH * scale)),
    };
  }

  /**
   * The eight numbers for ctx.drawImage(src, sx,sy,sw,sh, dx,dy,dw,dh), which is
   * crop plus position plus scale in one call.
   *
   * These stay fractional. The canvas is happy with sub-pixel destinations and
   * the even-number rule is an encoder constraint, not a drawing one, so forcing
   * it here would only add error. The two renderers can therefore differ by up to
   * one project pixel in placement, which at an 854 wide preview of a 1920 wide
   * project is under half a screen pixel. Not a disagreement worth chasing.
   */
  function drawImageArgs(placement, project, canvas) {
    if (!placement) return null;
    const projW = Math.max(1, finite(project && project.width, 1));
    const projH = Math.max(1, finite(project && project.height, 1));
    const kx = finite(canvas && canvas.width, projW) / projW;
    const ky = finite(canvas && canvas.height, projH) / projH;
    const { src, dest } = placement;
    return {
      sx: src.x,
      sy: src.y,
      sw: src.width,
      sh: src.height,
      dx: dest.x * kx,
      dy: dest.y * ky,
      dw: dest.width * kx,
      dh: dest.height * ky,
    };
  }

  /**
   * The same placement as ffmpeg filters, one layer's worth. Step 3 strings these
   * into the graph; this only decides what each layer's three parts say.
   *
   * A part is null when it would do nothing, matching what backend.js cropFilter
   * already does: a full-frame crop and a scale to the size it already is are
   * both filters that cost a copy and change no pixels.
   */
  function filterParts(placement, source) {
    if (!placement) return null;
    const { src, dest } = placement;
    const crop = isWholeFrame(src, source)
      ? null
      : 'crop=' + src.width + ':' + src.height + ':' + src.x + ':' + src.y;
    const scale = (dest.width === src.width && dest.height === src.height)
      ? null
      : 'scale=' + dest.width + ':' + dest.height;
    // overlay always says something, because a layer at 0,0 still has to be
    // composited onto the frame below it.
    const overlay = 'overlay=' + dest.x + ':' + dest.y;
    return { crop, scale, overlay };
  }

  return {
    PREVIEW_MAX_W,
    PREVIEW_MAX_H,
    sourceRect,
    isWholeFrame,
    FRAME_MIN,
    FRAME_MAX,
    fitRect,
    frameSize,
    rescaleRender,
    ratioResize,
    sideFraction,
    splitHeight,
    anchorCentre,
    alphaRow,
    placeLayer,
    previewCanvasSize,
    drawImageArgs,
    filterParts,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = layerGeometry;
