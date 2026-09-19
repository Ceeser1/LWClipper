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
    fitRect,
    placeLayer,
    previewCanvasSize,
    drawImageArgs,
    filterParts,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = layerGeometry;
