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

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

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

  // Every dimension ffmpeg is handed has to be even, because yuv420p subsamples
  // chroma two pixels at a time and an odd one has no valid encoding. That is
  // what sets the step sizes below rather than any feel for how fast a bar
  // should move: one bar alone moves in twos, and a mirrored pair moves one
  // each so the dimension between them still changes in twos.
  //
  // V2.7. These came over from renderer/app.js together with resizeEdge, which
  // is the only arithmetic that reads them. The window aliases the two it still
  // uses itself, so every use site over there is spelled as it always was.
  const CROP_STEP = 2;
  const CROP_MIRROR_STEP = 1;
  // Small enough never to be in the way, large enough that the four grips do
  // not pile up on each other and become impossible to tell apart.
  const CROP_MIN = 16;

  /**
   * Where a pair of opposite edges ends up after a bar is dragged. Kept pure and
   * out of the handler so the arithmetic can be checked on its own: the two axes
   * and all four bars come through here, which is what stops the clamping to the
   * frame from being written four slightly different ways.
   *
   * lo/hi are the near and far edge in source pixels, floor and limit how far
   * either may travel on that axis, movesLo which of the two the bar being
   * dragged is, rawDelta the pointer's travel converted to source pixels, and
   * travelPx that same travel in screen pixels, which is what holds the mirrored
   * pair to its one pixel step. `least` is how close the two edges may come,
   * which the crop popup leaves alone at CROP_MIN and the render frame works
   * out per axis, its shortest legal side depending on the other one.
   *
   * floor and limit are what is on the frame, not what is in the picture: zoomed
   * in, a bar dragged past the edge of the frame would take the box somewhere it
   * cannot be seen or grabbed. At 100% the two are the same thing.
   *
   * V2.7. Moved here from renderer/app.js unchanged, before the Crop Render
   * Frame window was built, because that window needs this same rule and
   * because here it can finally be checked by node --test rather than only
   * through a window probe. It is the part with the scars: the mirrored rate
   * cap, the even step and the two clampings were each fixed separately over
   * 21e and 22a.
   */
  function resizeEdge(lo0, hi0, limit, movesLo, mirrored, rawDelta, travelPx = Infinity,
    floor = 0, least = CROP_MIN) {
    if (mirrored) {
      // Both bars move by the same amount in opposite directions, so the centre
      // holds and the dimension between them changes by two per step: still even.
      // Outward they stop at the frame, inward at CROP_MIN apart.
      //
      // The rate is capped at a source pixel per pixel of travel. Without that
      // cap the step is whatever a screen pixel happens to be worth, and the
      // frame is usually shown small enough that this is two or three source
      // pixels: on a 1280 wide clip one screen pixel is 1.81 source pixels, so
      // the pair could only ever jump four at a time, never the two it is for.
      // Zoomed in, where a screen pixel is worth less than a source one, the
      // ordinary rate is already the slower of the two and still applies.
      const rate = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), Math.abs(travelPx));
      const outward = Math.max(0, Math.min(lo0 - floor, limit - hi0));
      const inward = Math.max(0, Math.floor((hi0 - lo0 - least) / 2));
      const d = clamp(Math.round(rate / CROP_MIRROR_STEP) * CROP_MIRROR_STEP,
        movesLo ? -outward : -inward, movesLo ? inward : outward);
      return movesLo ? { lo: lo0 + d, hi: hi0 - d } : { lo: lo0 - d, hi: hi0 + d };
    }
    const d = Math.round(rawDelta / CROP_STEP) * CROP_STEP;
    if (movesLo) return { lo: clamp(lo0 + d, floor, hi0 - least), hi: hi0 };
    return { lo: lo0, hi: clamp(hi0 + d, lo0 + least, limit) };
  }

  /**
   * What the render frame may be, settled with the user on 2026-09-24.
   *
   *     neither side above 5040, the shorter side never above 2160,
   *     the ratio never past 21:9 either way, and even numbers
   *
   * In their words: "A square should not exceed 2160px. If one side reaches
   * that only the other side can still move." So 2160x2160 is the largest
   * square and 3840x2160 the largest 16:9.
   *
   * Note which way the 21:9 rule bites. It is a floor on the short side rather
   * than a ceiling on the long one: given a long side, the short one may not be
   * so short that the pair goes past the ratio.
   *
   * The long side was 3840 when this was first agreed, on the argument that
   * nothing reachable should exceed 4K's pixel count. That made 21:9 at 2160p
   * impossible, and the user reopened it the same day and chose the other way:
   * "if there is resolution/pixels spare let it extend". So the ceiling is
   * 5040, which is exactly 21:9 at 2160 tall, and the largest frame is 10.9M
   * pixels against 4K's 8.3M. 5040 rather than the 5120 of an ultrawide
   * monitor, because the button says 21:9 and 5040x2160 is 21:9 while
   * 5120x2160 is 64:27. The screen's name for it belongs on the label, not in
   * the arithmetic.
   */
  const RENDER_MAX_SIDE = 5040;
  const RENDER_MAX_SHORT = 2160;
  const RENDER_MAX_RATIO = 21 / 9;

  const evenUp = (v) => Math.ceil(v / 2) * 2;

  /**
   * How long one side of the render frame may be, with the other side where it
   * is. Both bars of an axis are clamped through this, which is what stops the
   * four of them from each having their own idea of the caps.
   */
  function renderFrameSide(other) {
    const o = Math.max(2, evenDown(finite(other, 2)));
    // This side is the short one whenever the other is longer, and a short side
    // stops at 2160. Once the other side is past that, this one cannot be the
    // long one at all, so 2160 is the whole of it.
    const max = o > RENDER_MAX_SHORT
      ? RENDER_MAX_SHORT
      : Math.min(RENDER_MAX_SIDE, o * RENDER_MAX_RATIO);
    // And never so short that the pair goes past 21:9 the other way round.
    const min = o / RENDER_MAX_RATIO;
    return { min: Math.max(2, evenUp(min)), max: Math.max(2, evenDown(max)) };
  }

  /**
   * The frame a resolution button asks for, or null when that combination
   * cannot be built.
   *
   * `ratio` is width over height, as the aspect row already spells it, and
   * `shortSide` is what the second row is named after: the short side is the
   * one number that does not depend on which way up the frame is, which is why
   * 16:9 plus 2160p is 3840x2160 and 9:16 plus 1080p is 1080x1920.
   *
   * Null rather than a clamped answer on purpose: a button that cannot do what
   * its label says is disabled, not quietly corrected. With the ceiling at 5040
   * every combination the two rows offer is reachable, so nothing is disabled
   * today. The rule stays because it is what keeps a later row honest.
   */
  function renderFrameFor(ratio, shortSide) {
    const r = finite(ratio, 0);
    const s = evenDown(finite(shortSide, 0));
    if (!(r > 0) || !(s >= 2)) return null;
    const long = evenDown(s * (r >= 1 ? r : 1 / r));
    const size = r >= 1 ? { width: long, height: s } : { width: s, height: long };
    const lo = Math.min(size.width, size.height);
    const hi = Math.max(size.width, size.height);
    if (hi > RENDER_MAX_SIDE || lo > RENDER_MAX_SHORT) return null;
    // Rounding down to even can only have made the long side shorter, so the
    // ratio this is checked at is the one the frame really has.
    if (hi / lo > RENDER_MAX_RATIO) return null;
    return size;
  }

  /**
   * Whether a frame is one the caps allow. One statement of the three rules,
   * because three callers reach them by different roads and a road that skipped
   * the check would be a way round them.
   */
  function fitsCaps(size) {
    const w = finite(size && size.width, 0);
    const h = finite(size && size.height, 0);
    if (w < 2 || h < 2 || w % 2 || h % 2) return false;
    const lo = Math.min(w, h);
    const hi = Math.max(w, h);
    if (hi > RENDER_MAX_SIDE || lo > RENDER_MAX_SHORT) return false;
    return hi / lo <= RENDER_MAX_RATIO;
  }

  /**
   * The largest frame of a given shape the caps allow, which is what an aspect
   * button falls back to when neither growing nor cutting can be done legally.
   */
  function renderLargest(ratio) {
    const r = finite(ratio, 0);
    if (!(r > 0)) return null;
    const long = r >= 1 ? r : 1 / r;
    return renderFrameFor(r, evenDown(Math.min(RENDER_MAX_SHORT, RENDER_MAX_SIDE / long)));
  }

  /**
   * What an aspect button does to the frame it is pressed on.
   *
   * **It extends rather than cuts, where there is room.** The user, on
   * 2026-09-24: "if there is resolution/pixels spare let it extend, e.g. 1080p
   * from 1920x1080 at 16:9 to 2520x1080 at 21:9". So the axis that does not
   * have to change is left exactly where it is and the other one grows to meet
   * the ratio.
   *
   * This is the opposite of what the per-layer crop popup does, where every
   * preset is "the way back inside the picture". That rule is right for a crop
   * of a source, because there is nothing outside a source to reach. It is
   * wrong for a render frame, where growing is the whole point of the window.
   *
   * Cutting is the fallback, not the default: it happens only when growing
   * would breach a cap, and if that cannot be done either the answer is the
   * largest legal frame of that shape.
   */
  function renderReshape(size, ratio) {
    const w0 = evenDown(finite(size && size.width, 0));
    const h0 = evenDown(finite(size && size.height, 0));
    const r = finite(ratio, 0);
    if (!(r > 0) || w0 < 2 || h0 < 2) return null;
    // Too narrow for the shape wanted means the width is the one that grows.
    const needsWider = w0 / h0 < r;
    const grown = needsWider
      ? { width: evenDown(h0 * r), height: h0 }
      : { width: w0, height: evenDown(w0 / r) };
    if (fitsCaps(grown)) return grown;
    const cut = needsWider
      ? { width: w0, height: evenDown(w0 / r) }
      : { width: evenDown(h0 * r), height: h0 };
    if (fitsCaps(cut)) return cut;
    return renderLargest(r);
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
  // ---- the Render Position scale slider, V2.8 item 12 ----
  //
  // The user asked for 1% to 1000%, "kinda logarithmic but with 1%-precise
  // steps up to 200% (50% of the slider length) and then increasingly bigger
  // jumps towards 1000%". So the slider is 400 positions of an ordinary linear
  // range element and the bend is here, in two functions that have to be each
  // other's inverse or the handle jumps under the hand.
  //
  // Below the knee a position **is** the percentage, which is the 1% precision
  // asked for and needs no arithmetic at all. Above it the percentage is
  // multiplied rather than added to, so each step is a fixed fraction bigger
  // than the last: that is what makes the jumps grow, and it is why the top
  // half covers 200 to 1000 while the bottom half covers 1 to 200.
  const PLACE_SCALE_MIN = 1;
  const PLACE_SCALE_KNEE = 200;
  const PLACE_SCALE_MAX = 1000;
  // Twice the knee, so the knee really is at half the travel.
  const PLACE_SLIDER_MAX = PLACE_SCALE_KNEE * 2;

  /** What a slider position means, as a percentage. */
  function scaleFromSlider(pos) {
    const s = clamp(Math.round(finite(pos, PLACE_SCALE_KNEE)),
      PLACE_SCALE_MIN, PLACE_SLIDER_MAX);
    if (s <= PLACE_SCALE_KNEE) return s;
    const up = (s - PLACE_SCALE_KNEE) / PLACE_SCALE_KNEE;
    return Math.round(PLACE_SCALE_KNEE
      * Math.pow(PLACE_SCALE_MAX / PLACE_SCALE_KNEE, up));
  }

  /** And where the handle stands for a given percentage. */
  function sliderFromScale(percent) {
    const p = clamp(Math.round(finite(percent, PLACE_SCALE_KNEE)),
      PLACE_SCALE_MIN, PLACE_SCALE_MAX);
    if (p <= PLACE_SCALE_KNEE) return p;
    const up = Math.log(p / PLACE_SCALE_KNEE)
      / Math.log(PLACE_SCALE_MAX / PLACE_SCALE_KNEE);
    return PLACE_SCALE_KNEE + Math.round(PLACE_SCALE_KNEE * up);
  }

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

  // ---- V3, 31a. The text box ----
  //
  // A generated text's box, dragged in the Edit Text modal: its sides, one at a
  // time or with Shift the opposite one too, and the whole box. In project
  // pixels, whole ones, and held to the frame so every grip stays where it can
  // be grabbed. Nothing here is the crop's resizeEdge: that one steps in even
  // pixels for the encoder and caps a mirrored drag at a pixel per screen pixel,
  // which on a text box would leave the side trailing behind the pointer.

  // As small as a box may get, the crop's figure for the same reason: below it
  // the grips pile onto each other.
  const TEXT_BOX_MIN = 16;

  // The lines a box snaps to on one axis: the frame's two edges and its middle.
  function nearestLine(values, size, reach) {
    let best = null;
    for (const v of values) {
      for (const line of [0, size / 2, size]) {
        const d = line - v;
        if (Math.abs(d) <= reach && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line };
      }
    }
    return best;
  }

  /**
   * One side of the box moved by `delta` project pixels. Mirrored, the side
   * opposite moves the other way and the centre holds. `reach` is how near a
   * frame edge or the frame's middle the moving side has to come to land on it,
   * in project pixels, 0 for none. Hands back the box and the line it snapped
   * to, or null.
   */
  function textBoxEdge(box, edge, delta, mirrored, frame, reach = 0) {
    const vertical = edge === 'top' || edge === 'bottom';
    const movesLo = edge === 'left' || edge === 'top';
    const size = vertical ? frame.height : frame.width;
    const least = Math.min(TEXT_BOX_MIN, size);
    const lo0 = vertical ? box.y : box.x;
    const hi0 = lo0 + (vertical ? box.h : box.w);
    let v = (movesLo ? lo0 : hi0) + delta;
    const snap = nearestLine([v], size, reach);
    if (snap) v = snap.line;
    let lo;
    let hi;
    if (mirrored) {
      // The pair stays about the centre, lo + hi, which is a whole number, so
      // rounding one side and taking the other from the sum keeps both whole.
      const sum = lo0 + hi0;
      const c = sum / 2;
      const half = Math.min(Math.min(c, size - c), Math.max(least / 2, movesLo ? c - v : v - c));
      lo = Math.round(c - half);
      hi = sum - lo;
    } else if (movesLo) {
      lo = Math.min(hi0 - least, Math.max(0, Math.round(v)));
      hi = hi0;
    } else {
      lo = lo0;
      hi = Math.max(lo0 + least, Math.min(size, Math.round(v)));
    }
    const moved = movesLo ? lo : hi;
    const out = vertical ? { ...box, y: lo, h: hi - lo } : { ...box, x: lo, w: hi - lo };
    return { box: out, snap: snap && moved === snap.line ? snap.line : null };
  }

  /**
   * The whole box moved, held to the frame. Its left edge, centre or right
   * edge lands on the frame's edges or middle when it comes within `reach`,
   * and the same up and down. Hands back the box and the line met on each
   * axis, or null.
   */
  function textBoxMove(box, dx, dy, frame, reach = 0) {
    const axis = (pos, len, delta, size) => {
      let p = pos + delta;
      const snap = nearestLine([p, p + len / 2, p + len], size, reach);
      if (snap) p += snap.d;
      const held = Math.min(Math.max(0, size - len), Math.max(0, Math.round(p)));
      // A centre on the middle of an odd frame is half a pixel off it once
      // rounded, and still counts as on it.
      return { p: held, line: snap && Math.abs(held - p) <= 0.5 ? snap.line : null };
    };
    const x = axis(box.x, box.w, dx, frame.width);
    const y = axis(box.y, box.h, dy, frame.height);
    return { box: { ...box, x: x.p, y: y.p }, snapX: x.line, snapY: y.line };
  }

  // ---- 31b. Rotation ----

  // How near a quarter turn an angle has to come to land on it: the user's
  // figure, 88 and 92 land on 90, 87 and 93 stay.
  const TEXT_TURN_SNAP = 2;

  /**
   * An angle as the text keeps it: whole degrees in (-180, 180], on a quarter
   * turn when it is within TEXT_TURN_SNAP of one. -180 is kept as 180, the
   * model's own reading of the same direction.
   */
  function textTurn(deg) {
    let a = Math.round(Number(deg) || 0) % 360;
    if (a <= -180) a += 360;
    if (a > 180) a -= 360;
    const quarter = Math.round(a / 90) * 90;
    if (Math.abs(a - quarter) <= TEXT_TURN_SNAP) a = quarter;
    if (a === -180) a = 180;
    return a === 0 ? 0 : a;
  }

  /**
   * The angle after a corner has been dragged round the box's centre: where it
   * started, plus how far the pointer has gone round the centre since, from
   * `from` to `to`, both [x, y] relative to the centre. Screen y runs down, so
   * clockwise is positive, the text's own convention.
   */
  function textTurnDrag(start, from, to) {
    const a0 = Math.atan2(from[1], from[0]);
    const a1 = Math.atan2(to[1], to[0]);
    return textTurn(start + (a1 - a0) * 180 / Math.PI);
  }

  /**
   * One side of a turned box moved by `delta` pixels along the box's own axis,
   * positive outwards for the right and bottom sides and inwards for the left
   * and top, the same sense textBoxEdge's delta has. The side opposite stays
   * where it is on the screen, so the centre moves half as far along that same
   * turned axis; mirrored, the centre holds and both sides move.
   *
   * No snapping and no holding to the frame: a turned box's sides do not run
   * along the frame's, and part of a turned title may well be meant to leave
   * it. Only the least size holds, and a guard of a few frames across.
   */
  function textBoxEdgeTurned(box, edge, delta, mirrored, rotation, frame) {
    const vertical = edge === 'top' || edge === 'bottom';
    const movesLo = edge === 'left' || edge === 'top';
    const len0 = vertical ? box.h : box.w;
    const most = 4 * Math.max(frame.width, frame.height);
    const grow = (movesLo ? -delta : delta) * (mirrored ? 2 : 1);
    const len = Math.min(most, Math.max(TEXT_BOX_MIN, Math.round(len0 + grow)));
    const shift = mirrored ? 0 : (len - len0) / 2 * (movesLo ? -1 : 1);
    const a = rotation * Math.PI / 180;
    // The box's own axis on the screen: across for left and right, down for
    // top and bottom.
    const ux = vertical ? -Math.sin(a) : Math.cos(a);
    const uy = vertical ? Math.cos(a) : Math.sin(a);
    const cx = box.x + box.w / 2 + ux * shift;
    const cy = box.y + box.h / 2 + uy * shift;
    const w = vertical ? box.w : len;
    const h = vertical ? len : box.h;
    return { box: { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h }, snap: null };
  }

  /**
   * A turned box moved. Its centre, the one point of it that means the same
   * turned or not, lands on the frame's edges or middle within `reach`, and is
   * held inside the frame so the box cannot be lost off it.
   */
  function textBoxMoveTurned(box, dx, dy, frame, reach = 0) {
    const axis = (pos, len, delta, size) => {
      let c = pos + len / 2 + delta;
      const snap = nearestLine([c], size, reach);
      if (snap) c = snap.line;
      c = Math.min(size, Math.max(0, c));
      const p = Math.round(c - len / 2);
      return { p, line: snap && Math.abs(p + len / 2 - snap.line) <= 0.5 ? snap.line : null };
    };
    const x = axis(box.x, box.w, dx, frame.width);
    const y = axis(box.y, box.h, dy, frame.height);
    return { box: { ...box, x: x.p, y: y.p }, snapX: x.line, snapY: y.line };
  }

  /** Whether a box is the whole frame, which is the same as having none. */
  function isWholeBox(box, frame) {
    return !box || (Math.round(box.x) === 0 && Math.round(box.y) === 0
      && Math.round(box.w) === frame.width && Math.round(box.h) === frame.height);
  }

  return {
    TEXT_BOX_MIN,
    textBoxEdge,
    textBoxMove,
    isWholeBox,
    TEXT_TURN_SNAP,
    textTurn,
    textTurnDrag,
    textBoxEdgeTurned,
    textBoxMoveTurned,
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
    CROP_STEP,
    CROP_MIRROR_STEP,
    CROP_MIN,
    resizeEdge,
    RENDER_MAX_SIDE,
    RENDER_MAX_SHORT,
    RENDER_MAX_RATIO,
    renderFrameSide,
    renderFrameFor,
    fitsCaps,
    renderLargest,
    renderReshape,
    sideFraction,
    splitHeight,
    anchorCentre,
    alphaRow,
    PLACE_SCALE_MIN,
    PLACE_SCALE_KNEE,
    PLACE_SCALE_MAX,
    PLACE_SLIDER_MAX,
    scaleFromSlider,
    sliderFromScale,
    placeLayer,
    previewCanvasSize,
    drawImageArgs,
    filterParts,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = layerGeometry;
