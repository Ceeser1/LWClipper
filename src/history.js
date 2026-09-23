'use strict';

// Undo for the advanced editing document.
//
// Whole-state snapshots rather than do/undo instruction pairs. Eight layers is
// about 3 KB of JSON and a hundred-deep stack around 300 KB, which is less than
// one decoded 1080p frame, and a snapshot is one code path that is already
// correct for operations nobody has written yet, where every instruction needs
// an inverse that someone eventually gets wrong.
//
// Three rules the user set, the last two on 2026-09-18, and the last is the
// whole of why this is not simply "put the snapshot back":
//
//   One gesture is one step. The boundary is the mouse coming up or the file
//   arriving, never the mousemove in between. A crop is one step from opening
//   the popup to accepting it, not one per grip drag.
//
//   Undoable: adding and deleting a layer, moving one, trimming either edge,
//   cropping, reordering, and moving the in and out markers. Not undoable: the
//   playhead, the timeline zoom, and the Enabled tick.
//
//   The Enabled tick and the volume slider are mixer controls rather than edits
//   to the document. They neither make a step of their own nor get rolled back
//   by somebody else's: undoing a clip move leaves a layer muted if it is muted
//   now.
//
// That last rule is why a snapshot is compared and restored through the same
// lens, with those two fields taken out of it. Comparing the whole thing would
// mean a crop accepted after a volume nudge pushes a step that changes nothing
// anyone can see, and Ctrl+Z appearing to do nothing several times is exactly
// the trap the no-op skip exists to avoid.
//
// Nothing here mutates, matching src/timeline.js: every call returns a new
// history, so a half-applied undo is not a state this can be in.
//
// Wrapped the way src/timeline.js is, because the window loads it as a plain
// script beside app.js where a top-level const shares one scope with every
// other script.

const projectHistory = (() => {
  // A hundred gestures back, as sized above. A real limit rather than a
  // formality: without one, a long session's stack holds every layer list it
  // ever had.
  const LIMIT = 100;

  // The per-layer settings undo neither records nor restores.
  const LIVE_FIELDS = ['enabled', 'volume'];

  /**
   * A fresh history sitting on one state, which is the one Ctrl+Z at the very
   * start has nothing behind.
   */
  function create(state) {
    return { past: [], present: state || null, future: [] };
  }

  function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== 'object' || typeof b !== 'object') return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }

  /** Two layers, ignoring the settings undo does not own. */
  function sameLayer(a, b) {
    const keys = new Set(Object.keys(a).concat(Object.keys(b)));
    for (const key of keys) {
      if (LIVE_FIELDS.includes(key)) continue;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  /**
   * Whether two states are the same document.
   *
   * Order matters, because a reorder is a real change even though the same
   * layers are present either way: the array is the draw order.
   *
   * `fps`, `width` and `height` are the project frame. All three are compared
   * as 0 when absent, so a snapshot taken before the field existed does not read
   * as a change. They are here rather than left out with the rest of the
   * project's state because the controls that set them are gestures like any
   * other: without them the stack would drop the very step the user just took.
   * The rate came in with Step 16's dropdown, the size with V2.1's resolution
   * boxes.
   */
  function sameState(a, b) {
    if (!a || !b) return a === b;
    if (a.start !== b.start || a.end !== b.end) return false;
    if ((a.fps || 0) !== (b.fps || 0)) return false;
    if ((a.width || 0) !== (b.width || 0)) return false;
    if ((a.height || 0) !== (b.height || 0)) return false;
    if (a.layers.length !== b.layers.length) return false;
    return a.layers.every((l, i) => sameLayer(l, b.layers[i]));
  }

  /**
   * Take a step, unless the gesture changed nothing.
   *
   * The state handed in is the one the gesture produced, so it becomes the
   * present and whatever was the present becomes the step Ctrl+Z goes back to.
   * Nothing ahead survives: once a new branch is taken, what redo was holding
   * is not reachable any more and pretending otherwise would put a layer list
   * back that was never a step on this path.
   */
  function commit(history, state) {
    if (!state) return history;
    if (!history || !history.present) return create(state);
    if (sameState(history.present, state)) return history;
    const past = history.past.concat([history.present]);
    return {
      past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past,
      present: state,
      future: [],
    };
  }

  /**
   * Correct the state the stack believes it is in, without taking a step.
   *
   * For a fact about the present that arrives after the gesture that made it.
   * The project's render rate is the one there is: it comes from a decoder
   * reading a file's metadata, which lands some time after the layer that asked
   * for it was added and committed. Without this the snapshot behind the next
   * gesture says the project had no rate, and undoing back to it would either
   * unseed the project or, if it refuses to do that, silently keep the rate the
   * user just changed.
   *
   * Not a commit: nothing the user did happened here, so there is nothing to go
   * back to. The caller is responsible for handing in a state that differs from
   * the present only in what it has just learned.
   */
  function reseat(history, state) {
    if (!history || !history.present || !state) return history;
    return { ...history, present: state };
  }

  function canUndo(history) {
    return !!history && history.past.length > 0;
  }

  function canRedo(history) {
    return !!history && history.future.length > 0;
  }

  function undo(history) {
    if (!canUndo(history)) return history;
    return {
      past: history.past.slice(0, -1),
      present: history.past[history.past.length - 1],
      future: [history.present].concat(history.future),
    };
  }

  function redo(history) {
    if (!canRedo(history)) return history;
    return {
      past: history.past.concat([history.present]),
      present: history.future[0],
      future: history.future.slice(1),
    };
  }

  /**
   * The state to actually put on screen: the snapshot, with every layer that
   * still exists keeping the enable and volume it has right now.
   *
   * A layer the snapshot has and the live list does not is one this very undo
   * is bringing back, so it keeps the settings it had when it went. There is
   * nowhere else for them to come from, and they are the ones it went away
   * with.
   */
  function restore(state, live) {
    if (!state) return null;
    const now = new Map();
    for (const l of (live || [])) now.set(l.id, l);
    return {
      ...state,
      layers: state.layers.map((l) => {
        const current = now.get(l.id);
        if (!current) return l;
        const merged = { ...l };
        for (const key of LIVE_FIELDS) merged[key] = current[key];
        return merged;
      }),
    };
  }

  return {
    LIMIT,
    LIVE_FIELDS,
    create,
    sameState,
    commit,
    reseat,
    canUndo,
    canRedo,
    undo,
    redo,
    restore,
  };
})();

// The window reaches this through the lexical binding above; node --test needs
// it handed over properly.
if (typeof module !== 'undefined' && module.exports) module.exports = projectHistory;
