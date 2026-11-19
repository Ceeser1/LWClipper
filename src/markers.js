'use strict';

// V5.5. Timeline markers: points on the timeline the user sets to come back
// to, to cut on, and to snap clips against.
//
// A marker is a moment and, when the user gives it one, a name:
// `{ id, t, name }`, `t` in seconds from the project's start. The project
// keeps them as a list sorted by time (project.js, `markers`), part of the
// document like the tracks: setting one is unsaved work. They belong to the
// timeline, not to a clip, so moving a clip leaves them where they are. The
// one thing that moves them is closing a gap (timeline.rippleRemove), where
// what comes after a gap moves left and a marker set against it has to follow.
//
// Pure: no DOM, no fs. The window draws them and the project file saves them.

const timelineMarkers = (() => {
  const NAME_MAX = 80;
  // Two markers closer than this are one: nobody can tell them apart or pick
  // between them, at any zoom the timeline has.
  const SAME = 0.0005;

  function round(t) {
    return Math.round(t * 1e6) / 1e6;
  }

  function byTime(a, b) {
    return a.t - b.t;
  }

  /**
   * A list as it may be kept: every entry a marker with an id and a moment at
   * or after 0, sorted, none twice at one moment, a name of sensible length.
   * Anything else in what is handed over is dropped, so a hand-edited file
   * cannot hand the window a marker it cannot draw.
   */
  function markersOf(source) {
    if (!Array.isArray(source)) return [];
    const out = [];
    const ids = new Set();
    for (const m of source) {
      if (!m || typeof m !== 'object') continue;
      const t = Number(m.t);
      if (typeof m.id !== 'string' || !m.id || ids.has(m.id) || !Number.isFinite(t) || t < 0) continue;
      ids.add(m.id);
      out.push({ id: m.id, t: round(t), name: typeof m.name === 'string' ? m.name.slice(0, NAME_MAX) : '' });
    }
    out.sort(byTime);
    return out.filter((m, i) => i === 0 || m.t - out[i - 1].t >= SAME);
  }

  /** The marker within `reach` seconds of `t` that is nearest it, or null. */
  function near(markers, t, reach = SAME) {
    let best = null;
    for (const m of markers) {
      const d = Math.abs(m.t - t);
      if (d <= reach && (!best || d < Math.abs(best.t - t))) best = m;
    }
    return best;
  }

  /** A marker set at `t`. Where one stands already, the list as it was. */
  function add(markers, t, id, name = '') {
    const at = round(Math.max(0, Number(t) || 0));
    if (!id || near(markers, at) || markers.some((m) => m.id === id)) return markers;
    return markersOf([...markers, { id, t: at, name }]);
  }

  function remove(markers, id) {
    const next = markers.filter((m) => m.id !== id);
    return next.length === markers.length ? markers : next;
  }

  /**
   * M: a marker where there is none, and the marker taken away where there
   * is one within `reach` of `t` (the window gives it a frame's length, so the
   * key pressed again on a marker's frame removes it).
   */
  function toggle(markers, t, id, reach = SAME) {
    const there = near(markers, t, reach);
    return there ? remove(markers, there.id) : add(markers, t, id);
  }

  function rename(markers, id, name) {
    const text = String(name == null ? '' : name).trim().slice(0, NAME_MAX);
    if (!markers.some((m) => m.id === id && m.name !== text)) return markers;
    return markers.map((m) => (m.id === id ? { ...m, name: text } : m));
  }

  /** A marker dragged to `t`. Onto another's moment it does not go. */
  function move(markers, id, t) {
    const at = round(Math.max(0, Number(t) || 0));
    const mine = markers.find((m) => m.id === id);
    if (!mine || mine.t === at) return markers;
    if (markers.some((m) => m.id !== id && Math.abs(m.t - at) < SAME)) return markers;
    return markersOf(markers.map((m) => (m.id === id ? { ...m, t: at } : m)));
  }

  /** The first marker after `t`, or null. */
  function next(markers, t) {
    return markers.find((m) => m.t > t + SAME) || null;
  }

  /** The last marker before `t`, or null. */
  function previous(markers, t) {
    let found = null;
    for (const m of markers) {
      if (m.t < t - SAME) found = m;
    }
    return found;
  }

  /**
   * The list after a gap was closed: `shifts` as timeline.rippleRemove hands
   * them over, each `{ from, to, by }`, the gap that was from `from` to `to`
   * and how far what followed it moved left. A marker after the gap moves
   * with it; one inside the gap goes to where the gap began, since the
   * moment it stood on is gone; where that puts two on one moment, the
   * earlier of the two in the list stays.
   */
  function ripple(markers, shifts) {
    let out = markers;
    for (const s of shifts || []) {
      if (!(s.by > 0)) continue;
      out = out.map((m) => {
        if (m.t >= s.to - SAME) return { ...m, t: round(Math.max(0, m.t - s.by)) };
        if (m.t > s.from + SAME) return { ...m, t: round(Math.max(s.from, m.t - s.by)) };
        return m;
      });
    }
    return out === markers ? markers : markersOf(out);
  }

  /**
   * The list after room was made at `at` (timeline.rippleInsert): a marker at
   * or after it moves right by `by` with the clips it was set against.
   */
  function insert(markers, at, by) {
    if (!(by > 0) || !markers.some((m) => m.t >= at - SAME)) return markers;
    return markersOf(markers.map((m) => (m.t >= at - SAME ? { ...m, t: round(m.t + by) } : m)));
  }

  return { NAME_MAX, markersOf, near, add, remove, toggle, rename, move, next, previous, ripple, insert };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = timelineMarkers;
