'use strict';

// V3.6.1. Auto-save and crash restore: the rules, with no disk in them.
//
// The user, 2026-11-05: "Auto-save should happen every 3 minutes, max 5 last
// auto-saves get stored", and "After a crash a window should open asking to
// restore the last project."
//
// An auto-save is an ordinary .lwc with one more block in it, `autosave`,
// which says which run of the app wrote it and which project file it is a
// copy of (src/project.js reads and writes that block). They sit in one
// folder under the app's data, and the five newest are kept, whichever run
// or project they came from.
//
// A crash is told apart from a clean exit by a marker: every run writes one
// at startup and removes it at a clean quit. A marker still there whose
// process has gone is a run that never reached the quit hook, and the
// auto-saves that run wrote are what the restore window offers. A run's own
// marker is never read as a crash, and a marker whose process is still alive
// is a second window of the app, not a crash.
//
// Pure: main.js does the reading, writing and asking whether a process lives.

const autosave = (() => {
  // Under userData, beside the settings. Not in the cache folder, which Clear
  // cache empties.
  const FOLDER = 'autosave';
  // The user's numbers.
  const KEEP = 5;
  const EVERY_MS = 3 * 60 * 1000;
  // A run's marker: session-<id>.json, holding { id, pid, startedAt }.
  const MARKER_PREFIX = 'session-';
  const MARKER_EXT = '.json';

  const two = (n) => String(n).padStart(2, '0');

  /**
   * An auto-save's file name: local time to the second, then the project,
   * so the folder reads as a list in the order it was written when someone
   * opens it from Open Project. `name` is already safe for a file name.
   */
  function fileNameFor(date, name, ext = 'lwc') {
    const d = date instanceof Date ? date : new Date(date);
    const stamp = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate())
      + ' ' + two(d.getHours()) + '-' + two(d.getMinutes()) + '-' + two(d.getSeconds());
    return stamp + ' ' + (name || 'Project') + '.' + ext;
  }

  /** A fresh id for this run: the time it started and the process. */
  function newSessionId(now, pid) {
    return Math.round(Number(now) || 0).toString(36) + '-' + Math.round(Number(pid) || 0).toString(36);
  }

  function markerName(id) {
    return MARKER_PREFIX + id + MARKER_EXT;
  }

  /** The id in a marker's file name, or null for any other file. */
  function markerId(fileName) {
    const name = String(fileName || '');
    if (!name.startsWith(MARKER_PREFIX) || !name.endsWith(MARKER_EXT)) return null;
    const id = name.slice(MARKER_PREFIX.length, name.length - MARKER_EXT.length);
    return id || null;
  }

  /** What a marker holds, or null when it does not hold that. */
  function markerOf(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return null;
    }
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return null;
    const pid = Number(m.pid);
    return {
      id: m.id,
      pid: Number.isInteger(pid) && pid > 0 ? pid : 0,
      startedAt: typeof m.startedAt === 'string' ? m.startedAt : '',
    };
  }

  /**
   * The runs that ended without reaching the quit hook: a marker whose
   * process has gone. `isAlive(pid)` is asked by main.js. A marker with no
   * pid in it cannot be asked about and counts as gone, since nothing alive
   * can have written it. This run's own marker is never one.
   */
  function crashedSessions(markers, isAlive, ownId) {
    return (markers || [])
      .filter((m) => m && m.id && m.id !== ownId && !(m.pid && isAlive(m.pid)))
      .map((m) => m.id);
  }

  /** Newest first, by when each was written, the file name breaking a tie. */
  function newestFirst(entries) {
    return [...(entries || [])].sort((a, b) => {
      const at = String(b.savedAt || '').localeCompare(String(a.savedAt || ''));
      return at || String(b.file || '').localeCompare(String(a.file || ''));
    });
  }

  /** The auto-saves past the newest `keep`, which are the ones to delete. */
  function toPrune(entries, keep = KEEP) {
    return newestFirst(entries).slice(Math.max(0, keep));
  }

  /**
   * What the restore window offers: the auto-saves written by the runs that
   * crashed, newest first. Only theirs, so a crash a minute after starting
   * does not offer an older copy of a project than the file it was opened
   * from.
   */
  function restorable(entries, sessions) {
    const from = new Set(sessions || []);
    return newestFirst((entries || []).filter((e) => e && from.has(e.session)));
  }

  return {
    FOLDER,
    KEEP,
    EVERY_MS,
    fileNameFor,
    newSessionId,
    markerName,
    markerId,
    markerOf,
    crashedSessions,
    newestFirst,
    toPrune,
    restorable,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = autosave;
