'use strict';

// V3.7.1. The gradient editor, Shape Settings' since V3.7 and the Layer Mask
// view's as well now, the user's "Layer masks have no color or gradient
// option yet, add them". Written once: the bar of stops, the Start, End and
// Rotation boxes, the line on the preview, and the right drag that draws it.
// Each window says where its own are and what its draft is.
//
// The user, for V3.7: "Make shapes Color a 2-way button selector Color |
// Gradient. Color only shows the clickable color display/selector button,
// gradient adds hint Modify your gradient below instead ... In the new row
// below show a bar ranging across the preview width with white left
// transitioning into black on the right with clickable dots that open the
// color picker for that region. Double-click somewhere empty on this bar adds
// a new dot inbetween as a transition point. Below the bar show a text Click
// somewhere on the preview and drag any direction to apply a gradient with 3
// text-/editboxes below Start: [Start-pixel], End: [End-pixel], Rotation:
// [gradient-rotation]. Each Editbox should be drag-able. So clicking and
// moving the mouse right/left should increase/decrease their values." And for
// V3.7.1: "Gradient movement/editing by click should be done using right
// click so left click is still available to navigate and pan in the preview".
//
// Start and End run from the middle of what it fills along its direction,
// and Rotation is measured from that thing's own turn, so the gradient turns
// and moves with it. A stop is moved by dragging it along the bar and taken
// away by dragging it off, two staying at least; a box moves one a pixel, ten
// with Shift.

// How far off the bar a dot has to be dragged to go.
const GRAD_STOP_OFF = 28;
// How far a press on a dot or a box goes before it is a drag.
const GRAD_SLOP = 3;

/** An angle wrapped into -180 up to 180, the way the model keeps one. */
function wrapDegrees(deg) {
  const r = ((Math.round(deg) % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/**
 * A number box that is also dragged: pressed and moved sideways it changes
 * by a unit a pixel, ten with Shift, right for more; pressed and let go it is
 * typed in. `alive()` is whether its window has something to edit, `get()`
 * and `set(n, except, quick)` read and write the value, `range()` is
 * [lo, hi], `wrap` turns past the ends round, for an angle, and `shown()`
 * puts every box back to what the draft says.
 */
function bindScrubBox(box, { alive, get, set, range, wrap, shown }) {
  const fit = (n) => {
    if (wrap) return wrapDegrees(n);
    const [lo, hi] = range();
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  box.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !alive()) return;
    // Already being typed in: the press places the caret, as it always has.
    if (box.ownerDocument.activeElement === box) return;
    let last = evt.clientX;
    let value = get();
    let moved = false;
    const x0 = evt.clientX;
    beginDrag(box, evt, (ev) => {
      if (!moved && Math.abs(ev.clientX - x0) < GRAD_SLOP) return;
      moved = true;
      value += (ev.clientX - last) * (ev.shiftKey ? 10 : 1);
      last = ev.clientX;
      set(fit(value), null, true);
    }, () => {
      if (moved) {
        set(fit(value), null, false);
        return;
      }
      box.focus();
      box.select();
    });
  });
  box.addEventListener('input', () => {
    const text = box.value.trim();
    if (!/^[-+]?\d+$/.test(text)) return;
    set(fit(parseInt(text, 10)), box, false);
  });
  box.addEventListener('blur', () => shown());
  box.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter') return;
    evt.preventDefault();
    box.blur();
  });
}

/**
 * The editor for one window. `o`:
 *   bar, canvas          the bar of stops, and the canvas in it
 *   start, end, angle    the three boxes
 *   line                 the dashed line on the preview
 *   stage                the preview, which a right drag draws on
 *   reach()              how far Start and End go either way
 *   get()                the draft's gradient in the window's measure, or
 *                        null with nothing being edited
 *   on()                 whether the draft is filled with it
 *   set(props, quick, except)  it changed: into the draft, and shown. `quick`
 *                        while something is being dragged
 *   centre()             the middle it runs from, in the preview's frame units
 *   turn()               the turn it is measured from, in degrees
 *   pick(color, live)    the colour picker, over the window, as pickColor
 *   owner()              what the window is open on, to tell when the picker
 *                        comes back to a window closed or opened on another
 * Hands back { paintBar(withDots), placeLine(), showBoxes(except) }.
 */
function makeGradientEditor(o) {
  /** A point on the preview, in its frame's units. */
  function point(evt) {
    const r = stageFrameRect(o.stage);
    const b = o.stage.getBoundingClientRect();
    return {
      x: (evt.clientX - b.left - o.stage.clientLeft - r.left) / r.s,
      y: (evt.clientY - b.top - o.stage.clientTop - r.top) / r.s,
    };
  }

  /** The bar: the stops' colours over a checkerboard, and a dot at each. */
  function paintBar(withDots) {
    const g = o.get();
    if (!g || !o.on()) return;
    const w = Math.max(1, o.bar.clientWidth);
    const h = Math.max(1, o.bar.clientHeight);
    const dpr = hostWindowOf(o.canvas).devicePixelRatio || 1;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (o.canvas.width !== bw) o.canvas.width = bw;
    if (o.canvas.height !== bh) o.canvas.height = bh;
    const ctx = o.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = checkerPattern(ctx, dpr);
    ctx.fillRect(0, 0, bw, bh);
    const lin = ctx.createLinearGradient(0, 0, bw, 0);
    for (const stop of g.stops) lin.addColorStop(stop.at, stop.color);
    ctx.fillStyle = lin;
    ctx.fillRect(0, 0, bw, bh);
    if (!withDots) return;
    for (const old of o.bar.querySelectorAll('.gradient-stop')) old.remove();
    g.stops.forEach((stop, i) => {
      const dot = o.bar.ownerDocument.createElement('div');
      dot.className = 'gradient-stop';
      dot.style.left = (stop.at * 100) + '%';
      dot.style.background = stop.color;
      dot.title = t('Color');
      o.bar.appendChild(dot);
      bindStop(dot, i);
    });
  }

  /** A stop's dot: a click picks its colour, a drag moves it or takes it off. */
  function bindStop(dot, index) {
    dot.addEventListener('pointerdown', (evt) => {
      const g = o.get();
      if (evt.button !== 0 || !g) return;
      evt.stopPropagation();
      const bar = o.bar.getBoundingClientRect();
      const x0 = evt.clientX;
      const y0 = evt.clientY;
      const start = g.stops.map((stop) => ({ ...stop }));
      let moved = false;
      let off = false;
      let at = start[index].at;
      const stopsNow = () => (off
        ? start.filter((_, i) => i !== index)
        : start.map((stop, i) => (i === index ? { ...stop, at } : stop)));
      beginDrag(dot, evt, (ev) => {
        if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < GRAD_SLOP) return;
        moved = true;
        off = start.length > 2 && Math.abs(ev.clientY - y0) > GRAD_STOP_OFF;
        dot.classList.toggle('gradient-stop--off', off);
        at = Math.min(1, Math.max(0, (ev.clientX - bar.left) / Math.max(1, bar.width)));
        dot.style.left = (at * 100) + '%';
        o.set({ stops: stopsNow() }, true);
      }, () => {
        if (!moved) {
          pickStop(index);
          return;
        }
        o.set({ stops: stopsNow().sort((p, q) => p.at - q.at) }, false);
      });
    });
  }

  async function pickStop(index) {
    const g = o.get();
    if (!g) return;
    const owner = o.owner();
    const was = g.stops[index].color;
    const live = () => o.owner() === owner && !!o.get();
    const put = (color) => {
      const stops = o.get().stops.map((stop, i) => (i === index ? { ...stop, color } : stop));
      o.set({ stops }, false);
    };
    const picked = await o.pick(was, (color) => {
      if (live()) put(color);
    });
    // The window may have been closed under the picker, by Escape for one.
    if (!live()) return;
    put(picked || was);
  }

  // A double click on the bar where there is no dot adds a stop there, the
  // colour the gradient has there, so it changes nothing until it is edited.
  o.bar.addEventListener('dblclick', (evt) => {
    const g = o.get();
    if (!g || evt.target.closest('.gradient-stop')) return;
    if (g.stops.length >= timelineModel.GRADIENT_STOPS_MAX) return;
    const bar = o.bar.getBoundingClientRect();
    const at = Math.min(1, Math.max(0, (evt.clientX - bar.left) / Math.max(1, bar.width)));
    const color = genDraw.gradientColourAt(g.stops, at);
    o.set({ stops: [...g.stops, { at, color }].sort((p, q) => p.at - q.at) }, false);
  });

  /** Where it runs, on the preview: a line from its start to its end. */
  function placeLine() {
    const g = o.get();
    const on = !!g && o.on();
    o.line.hidden = !on;
    if (!on) return;
    const r = stageFrameRect(o.stage);
    const c = o.centre();
    const cx = r.left + c.x * r.s;
    const cy = r.top + c.y * r.s;
    const a = (g.angle + o.turn()) * Math.PI / 180;
    const len = (g.end - g.start) * r.s;
    o.line.style.left = (cx + Math.cos(a) * g.start * r.s) + 'px';
    o.line.style.top = (cy + Math.sin(a) * g.start * r.s) + 'px';
    o.line.style.width = Math.abs(len) + 'px';
    o.line.style.transform = 'rotate(' + (a + (len < 0 ? Math.PI : 0)) + 'rad)';
  }

  /**
   * The gradient a drag on the preview draws: from where it was pressed to
   * where it is now, measured along that direction from the middle, and the
   * direction measured from the thing's own turn.
   */
  function fromDrag(p0, p1) {
    const c = o.centre();
    const th = Math.atan2(p1.y - p0.y, p1.x - p0.x);
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    return {
      start: Math.round((p0.x - c.x) * cos + (p0.y - c.y) * sin),
      end: Math.round((p1.x - c.x) * cos + (p1.y - c.y) * sin),
      angle: wrapDegrees(th * 180 / Math.PI - o.turn()),
    };
  }

  // A right drag anywhere on the preview draws it: on the thing, its grips
  // or beside it, all of which take only the left button.
  o.stage.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 2 || !o.get() || !o.on()) return;
    const p0 = point(evt);
    const s = stageFrameRect(o.stage).s;
    let drew = false;
    beginDrag(o.stage, evt, (ev) => {
      const p1 = point(ev);
      if (!drew && Math.hypot(p1.x - p0.x, p1.y - p0.y) * s < GRAD_SLOP) return;
      drew = true;
      o.set(fromDrag(p0, p1), true);
    }, () => {
      if (drew) o.set({}, false);
    });
  });

  // No menu of its own at the end of a right drag on the preview.
  o.stage.addEventListener('contextmenu', (evt) => evt.preventDefault());

  function showBoxes(except) {
    const g = o.get();
    if (!g) return;
    if (except !== o.start) o.start.value = String(g.start);
    if (except !== o.end) o.end.value = String(g.end);
    if (except !== o.angle) o.angle.value = String(g.angle);
  }

  const alive = () => !!o.get();
  const shown = () => showBoxes(null);
  bindScrubBox(o.start, {
    alive,
    shown,
    get: () => o.get().start,
    set: (n, except, quick) => o.set({ start: n }, quick, except),
    range: () => [-o.reach(), o.reach()],
  });
  bindScrubBox(o.end, {
    alive,
    shown,
    get: () => o.get().end,
    set: (n, except, quick) => o.set({ end: n }, quick, except),
    range: () => [-o.reach(), o.reach()],
  });
  bindScrubBox(o.angle, {
    alive,
    shown,
    get: () => o.get().angle,
    set: (n, except, quick) => o.set({ angle: n }, quick, except),
    range: () => [-180, 180],
    wrap: true,
  });

  return { paintBar, placeLine, showBoxes };
}
