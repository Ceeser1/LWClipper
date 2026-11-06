'use strict';

// V3.7. The keyframe strip every editor window has: Crop and Mask, Shape
// Settings, Edit Text and Bar Settings.
//
// V3.6.3 drew it in the Crop and Mask window for the user's "Selected
// Keyframe: X / Y" and a black bar of the clip's keyframes between two
// rulers, the clip's own time above and the source's below. V3.7 makes it the
// window's keyframe editor, the user's additions of 2026-11-05:
//   "The Keyframes bar in the edit should be clickable to switch or drag
//    selected/editing keyframes inside the edit window."
//   "Shapes settings should also have the keyframes bar and ruler."
//   "Add a small slider/playhead to the bar so the user can see the
//    transitions by moving it"
//   "Always show the keyframe-bar. Double-clicking it somewhere empty creates
//    a new keyframe (if between existing keyframes, linear interpolate),
//    right-clicking a keyframe in the edit deletes it."
//
// The strip only draws and reports presses; what a press does is the window's,
// handed in as `opts`:
//   state()      { layer, keys: [{ id, t }], editing: { id, t } or null,
//                  width, lower } or null while it has nothing to show;
//                  `lower` is whether there is a source ruler under the bar
//   pick(id)     a keyframe pressed
//   move(id, t)  that keyframe dragged to `t` of the clip; moved(id) at the end
//   scrub(t)     the playhead pressed or dragged to `t`; scrubbed() at the end
//   add(t)       a double click on the bar where there is no keyframe
//   remove(id)   a right click on a keyframe
// Times are the clip's own seconds. The playhead is the timeline's.

// Each ruler's height and the bar's, together the canvas's 48px in style.css.
const KEYS_RULER = 17;
const KEYS_BAR = 14;
// The clip's time starts and ends this far in from the strip's ends, so a
// diamond on its first or last moment is drawn whole.
const KEYS_INSET = 7;
const KEYS_FONT = '10px -apple-system, "Segoe UI", Roboto, sans-serif';
const KEY_GOLD = '#e8c860';
const KEY_WHITE = '#ffffff';
// The two ends' labels, a little brighter than the marks between them.
const KEYS_END_LABEL = '#c8c8d2';
// A press this near a diamond's middle, across, is on it.
const KEY_HIT = 3;
// As far as the pointer goes before a press on a diamond is a drag.
const KEY_STRIP_SLOP = 3;

/** The strip's diamonds' half diagonal. */
function keyStripRadius() {
  return KEYS_BAR / 2 - 1;
}

/**
 * A strip in `root`, its line in `readout` and its picture on `canvas`.
 * Hands back { draw }, which the window calls whenever what it shows moves.
 */
function makeKeyStrip(root, readout, canvas, opts) {
  // Where the clip's time is on the canvas, as the last draw left it.
  let geo = null;

  const timeAt = (x) => {
    if (!geo) return 0;
    return Math.min(Math.max((x - KEYS_INSET) / geo.scale, 0), geo.span);
  };

  const pointOf = (evt) => {
    const r = canvas.getBoundingClientRect();
    return { x: evt.clientX - r.left, y: evt.clientY - r.top };
  };

  // The diamond under a point, the nearest when two overlap, or null.
  const keyAt = (p) => {
    const s = opts.state();
    if (!s || !geo) return null;
    const r = keyStripRadius() + KEY_HIT;
    const mid = KEYS_RULER + KEYS_BAR / 2;
    if (Math.abs(p.y - mid) > KEYS_BAR / 2 + KEY_HIT) return null;
    let best = null;
    for (const k of s.keys) {
      if (!k.id) continue;
      const d = Math.abs(KEYS_INSET + k.t * geo.scale - p.x);
      if (d <= r && (!best || d < best.d)) best = { id: k.id, t: k.t, d };
    }
    return best;
  };

  canvas.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || !opts.state()) return;
    const p = pointOf(evt);
    const hit = keyAt(p);
    if (hit) {
      opts.pick(hit.id);
      const grab = p.x - (KEYS_INSET + hit.t * geo.scale);
      let moved = false;
      beginDrag(canvas, evt, (ev) => {
        const q = pointOf(ev);
        if (!moved && Math.abs(q.x - p.x) < KEY_STRIP_SLOP) return;
        moved = true;
        opts.move(hit.id, timeAt(q.x - grab));
      }, () => {
        if (moved) opts.moved(hit.id);
      });
      return;
    }
    opts.scrub(timeAt(p.x));
    beginDrag(canvas, evt, (ev) => opts.scrub(timeAt(pointOf(ev).x)), () => opts.scrubbed());
  });

  canvas.addEventListener('dblclick', (evt) => {
    if (!opts.state()) return;
    const p = pointOf(evt);
    if (keyAt(p)) return;
    opts.add(timeAt(p.x));
  });

  canvas.addEventListener('contextmenu', (evt) => {
    evt.preventDefault();
    if (!opts.state()) return;
    const hit = keyAt(pointOf(evt));
    if (hit) opts.remove(hit.id);
  });

  // A hand over a diamond, a resize arrow over the rest, which moves the
  // playhead.
  canvas.addEventListener('pointermove', (evt) => {
    if (evt.buttons) return;
    canvas.style.cursor = keyAt(pointOf(evt)) ? 'pointer' : 'ew-resize';
  });

  function draw() {
    const s = opts.state();
    root.hidden = !s;
    if (!s) return;
    const { layer } = s;
    // The keyframes in view, and one Accept is to make where the window is
    // editing between them, counted in and drawn as an outline.
    const keys = s.keys
      .filter((k) => k.t >= 0 && k.t <= layer.duration)
      .map((k) => ({ ...k, on: !!s.editing && !!s.editing.id && k.id === s.editing.id, fresh: false }));
    if (s.editing && !s.editing.id) keys.push({ id: null, t: s.editing.t, on: true, fresh: true });
    keys.sort((a, b) => a.t - b.t);
    // Two calls, so check-locales sees both literals.
    if (keys.length) {
      readout.textContent = t('Selected Keyframe: {n} / {total}', {
        n: keys.findIndex((k) => k.on) + 1,
        total: keys.length,
      });
    } else {
      readout.textContent = t('No keyframes');
    }
    const w = Math.max(1, Math.round(s.width));
    const h = 2 * KEYS_RULER + KEYS_BAR;
    const dpr = hostWindowOf(canvas).devicePixelRatio || 1;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const backW = Math.max(1, Math.round(w * dpr));
    const backH = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== backW || canvas.height !== backH) {
      canvas.width = backW;
      canvas.height = backH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const span = Math.max(1e-6, layer.duration);
    const scale = Math.max(1, w - 2 * KEYS_INSET) / span;
    geo = { span, scale };
    const barTop = KEYS_RULER;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, barTop, w, KEYS_BAR);
    // The clip's own time above, 0 to its length; the source's below, from
    // where the clip starts in it to as far again.
    drawKeyStripRuler(ctx, { from: 0, span, scale, w, top: 0, above: true });
    if (s.lower) {
      drawKeyStripRuler(ctx, {
        from: layer.sourceIn || 0, span, scale, w, top: barTop + KEYS_BAR, above: false,
      });
    }
    // The playhead, while it is on the clip: a line through the rulers and
    // the bar with the timeline's head on top, under the diamonds.
    const local = compositeAt - layer.start;
    if (local >= -1e-9 && local <= layer.duration + 1e-9) {
      const x = Math.round(KEYS_INSET + Math.min(Math.max(local, 0), layer.duration) * scale) + 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 4);
      ctx.lineTo(x, s.lower ? h : barTop + KEYS_BAR);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(x - 4.5, 0);
      ctx.lineTo(x + 4.5, 0);
      ctx.lineTo(x + 4.5, 5);
      ctx.lineTo(x, 8);
      ctx.lineTo(x - 4.5, 5);
      ctx.closePath();
      ctx.fill();
    }
    // The edited one last, so it is on top where two meet.
    const mid = barTop + KEYS_BAR / 2;
    const r = keyStripRadius();
    for (const k of [...keys.filter((o) => !o.on), ...keys.filter((o) => o.on)]) {
      const x = KEYS_INSET + k.t * scale;
      ctx.beginPath();
      ctx.moveTo(x, mid - r);
      ctx.lineTo(x + r, mid);
      ctx.lineTo(x, mid + r);
      ctx.lineTo(x - r, mid);
      ctx.closePath();
      if (k.fresh) {
        ctx.strokeStyle = KEY_GOLD;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = k.on ? KEY_GOLD : KEY_WHITE;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  return { draw };
}

/**
 * One of the strip's rulers, `from` to `from + span`: the timeline's own
 * ladder of marks standing on the bar's edge, both ends marked and labelled to
 * the millisecond, and the labelled marks between them labelled where they
 * have room. `above` is the ruler over the bar, its marks hanging down to it.
 */
function drawKeyStripRuler(ctx, { from, span, scale, w, top, above }) {
  const axis = Math.max(1, w - 2 * KEYS_INSET);
  const end = from + span;
  const marks = timelineView.ticks({ scale, scroll: from }, end, axis);
  const edge = above ? top + KEYS_RULER : top;
  const mark = (x, len, colour) => {
    const px = Math.round(x) + 0.5;
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, edge);
    ctx.lineTo(px, above ? edge - len : edge + len);
    ctx.stroke();
  };
  ctx.font = KEYS_FONT;
  ctx.textBaseline = above ? 'top' : 'bottom';
  ctx.textAlign = 'left';
  const textY = above ? top + 1 : top + KEYS_RULER - 1;
  const first = timelineView.clockLabel(from, end, 3);
  const last = timelineView.clockLabel(end, end, 3);
  const firstX = KEYS_INSET;
  const lastX = w - KEYS_INSET;
  // Where the two end labels reach, which a label between may not come near.
  const firstReach = firstX + 3 + ctx.measureText(first).width + 6;
  const lastReach = lastX - 3 - ctx.measureText(last).width - 6;
  for (const m of marks) {
    const x = KEYS_INSET + m.x;
    mark(x, m.major ? 5 : 3, m.major ? TIMELINE_TICK_MAJOR : TIMELINE_TICK_MINOR);
    if (!m.major) continue;
    const text = timelineView.clockLabel(m.t, end, m.step < 1 ? 1 : 0);
    const left = x + 3;
    if (left < firstReach || left + ctx.measureText(text).width > lastReach) continue;
    ctx.fillStyle = TIMELINE_LABEL;
    ctx.fillText(text, left, textY);
  }
  mark(firstX, 7, TIMELINE_TICK_MAJOR);
  mark(lastX, 7, TIMELINE_TICK_MAJOR);
  ctx.fillStyle = KEYS_END_LABEL;
  ctx.fillText(first, firstX + 3, textY);
  ctx.textAlign = 'right';
  ctx.fillText(last, lastX - 3, textY);
  ctx.textAlign = 'left';
}

/**
 * V3.7. Whether a window's keyframe and the one it would edit at a moment are
 * the same: the same keyframe, or both new ones at the same moment, or neither.
 */
function sameKeyTarget(a, b) {
  if (!a || !b) return !a && !b;
  if (a.id || b.id) return a.id === b.id;
  return Math.abs(a.t - b.t) < 1e-6;
}

/**
 * V3.7. A window's draft of a clip's keyframes measured against the clip as
 * it is now: a trim of the clip's start in the main window moves its
 * keyframes in its own time, every one by as much, and the draft's are moved
 * by as much too. Anything else done to them meanwhile is left to Accept,
 * which writes the window's over it. Hands back { keyframes, dt } or null when
 * nothing moved.
 */
function rebaseWorkKeys(work, base, live) {
  if (base === live) return null;
  const a = base || [];
  const b = live || [];
  if (a.length !== b.length || !a.length) return null;
  const dt = b[0].t - a[0].t;
  if (Math.abs(dt) < 1e-9) return null;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id || Math.abs((b[i].t - a[i].t) - dt) > 1e-6) return null;
  }
  return { keyframes: work.map((k) => ({ ...k, t: Math.round((k.t + dt) * 1e6) / 1e6 })), dt };
}

/**
 * V3.7. What a press on a window's strip does, the same in every window. `s`
 * is the window's side of it:
 *   active()         whether the window is open on a clip with its draft
 *   layer()          the clip as the window's draft has it
 *   store(layer)     that clip's keyframes and settings back into the draft
 *   fold()           the window's settings into the draft, at the keyframe
 *                    it is editing, the way Accept would write them
 *   target()         the keyframe it edits, { id, t } as keyframeToEditAt
 *                    hands it, or null on a clip with none
 *   setTarget(k)     another one to edit
 *   reseed()         the window's settings again from the draft, there
 *   refresh()        its picture again, for the playhead having moved
 *   draw()           the strip again
 * The playhead is the timeline's: moving it on the strip moves it there, and
 * moving it there moves the keyframe the window edits, as the user's rule for
 * an edit between two keyframes has always had it.
 */
function makeKeySession(s) {
  let followAt = null;
  let moving = null;
  const find = (layer, id) => (layer ? timelineModel.keyframesFor(layer).find((k) => k.id === id) : null);

  function retarget(t, id) {
    s.fold();
    const layer = s.layer();
    if (!layer) return;
    const k = id ? find(layer, id) : null;
    s.setTarget(k ? { ...k } : keyframeToEditAt(layer, t));
    s.reseed();
    s.refresh();
    s.draw();
  }

  const session = {
    /** The window has opened: the playhead as it is is the one followed. */
    reset() {
      followAt = compositeAt;
      moving = null;
    },
    retarget,
    /**
     * Run by the window's preview tick: the playhead moved in the main
     * window, or by the strip, so the keyframe being edited is the one there
     * now. Off the clip, the one it was.
     */
    follow() {
      if (!s.active() || compositePlaying || compositeAt === followAt) return;
      followAt = compositeAt;
      const layer = s.layer();
      if (!layer) return;
      const local = compositeAt - layer.start;
      if (local < -1e-9 || local > layer.duration + 1e-9) {
        s.draw();
        return;
      }
      const want = keyframeToEditAt(layer, local);
      if (!sameKeyTarget(want, s.target())) {
        retarget(local);
        return;
      }
      s.refresh();
      s.draw();
    },
    pick(id) {
      const layer = s.layer();
      const k = find(layer, id);
      if (!k) return;
      seekComposite(layer.start + k.t);
      updatePlayhead();
      followAt = compositeAt;
      const now = s.target();
      if (now && now.id === id) {
        s.refresh();
        s.draw();
        return;
      }
      retarget(k.t, id);
    },
    move(id, t) {
      // The window's settings go into the draft before the keyframe they
      // belong to moves off with them.
      if (moving !== id) {
        s.fold();
        moving = id;
      }
      const layer = s.layer();
      if (!layer) return;
      const [after] = timelineModel.moveKeyframe([layer], layer.id, id, t);
      s.store(after);
      const k = find(after, id);
      const now = s.target();
      if (k && now && now.id === id) s.setTarget({ ...now, t: k.t });
      if (k) {
        seekComposite(after.start + k.t);
        updatePlayhead();
        followAt = compositeAt;
      }
      s.draw();
    },
    moved() {
      moving = null;
      s.reseed();
      s.refresh();
      s.draw();
    },
    scrub(t) {
      const layer = s.layer();
      if (!layer) return;
      seekComposite(layer.start + t);
      updatePlayhead();
      session.follow();
      s.draw();
    },
    scrubbed() {},
    /**
     * A keyframe where the strip was double clicked: the picture there, so it
     * changes nothing until it is edited, between two the blend of the pair.
     * On a clip with none yet one goes at its start too, the user's rule for
     * the first keyframe, as the timeline's Add Keyframe has it.
     */
    add(t) {
      s.fold();
      const layer = s.layer();
      if (!layer) return;
      const near = timelineModel.keyframeNear(layer, t, keyframeReach());
      if (near) {
        session.pick(near.id);
        return;
      }
      let list = [layer];
      if (!timelineModel.keyframesFor(layer).length && t > keyframeReach()) {
        list = timelineModel.putKeyframe(list, layer.id, { id: newKeyframeId(), t: 0, ...keyframeSeed(layer, 0) });
      }
      const id = newKeyframeId();
      list = timelineModel.putKeyframe(list, layer.id, { id, t, ...keyframeSeed(layer, t) });
      s.store(list[0]);
      session.pick(id);
    },
    /**
     * A keyframe deleted by the model's rules: the last pair collapses into
     * the clip's own settings, and the first deleted with more behind it
     * takes the second's. The window then edits what is at the playhead.
     */
    remove(id) {
      s.fold();
      const layer = s.layer();
      if (!layer || !find(layer, id)) return;
      const [after] = timelineModel.removeKeyframe([layer], layer.id, id);
      s.store(after);
      const local = Math.min(Math.max(compositeAt - after.start, 0), after.duration);
      s.setTarget(keyframeToEditAt(after, local));
      s.reseed();
      s.refresh();
      s.draw();
    },
  };
  return session;
}
