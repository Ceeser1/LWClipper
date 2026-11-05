'use strict';

// The .lwc project file: what goes in one, and what to make of one coming back.
//
// A project is the undo snapshot with file references attached, which is not a
// coincidence: both need exactly the same state, and Step 12 is what forced the
// document into one serialisable object. Saving is this module plus a write;
// opening is this module plus the restore path undo already has.
//
// A project never carries media. It references files by path, and a path alone
// cannot tell that the file at it has been swapped for a different one, so
// every reference carries a fingerprint too.
//
// **The version rule, and it is the whole compatibility story.** Only ever add
// fields, never repurpose an existing name. Then a newer app opening an older
// file is filling in defaults for what is absent, which is what `parse` does,
// and an older app opening a newer file refuses with a clear message rather
// than silently dropping what it does not understand.
//
// Pure: no fs, no Electron. The main process does the stat calls and hands the
// results in, which is what lets all of this be tested the way trimmer.js is.

const projectFile = (() => {
  // What a .lwc says it is. Checked on open, so a JSON file that happens to
  // parse is not mistaken for a project.
  const FORMAT = 'lwclipper-project';

  // The extension, with no dot. Here rather than in main.js because "what a
  // .lwc is" is this file's subject and three places now ask the question: the
  // save dialog, the open dialog, and every route that opens a file at all.
  const EXT = 'lwc';

  // Bumped only when the shape changes in a way an older app could not read.
  // Adding a field does not need it, by the rule above.
  const VERSION = 1;

  function round(t) {
    return Math.round(t * 1e6) / 1e6;
  }

  function num(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
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

  /**
   * The part of the state that gets written, with nothing else in it.
   *
   * Used both for writing and for deciding whether the document has changed
   * since it was last saved, which is the dirty flag. Comparing this rather
   * than the undo snapshot matters: undo deliberately ignores the Enabled tick
   * and the volume, and both of those do go in the file.
   */
  function documentOf(state) {
    return {
      project: {
        width: Math.max(0, Math.round(num(state.project && state.project.width))),
        height: Math.max(0, Math.round(num(state.project && state.project.height))),
        // Added in Step 15, by the rule above: a field a newer app writes and
        // an older one has never heard of. A file without it opens at the
        // fallback rate, which is what the app used before it existed.
        fps: round(Math.max(0, num(state.project && state.project.fps))),
      },
      trim: {
        start: round(Math.max(0, num(state.trim && state.trim.start))),
        end: round(Math.max(0, num(state.trim && state.trim.end))),
      },
      layers: (state.layers || []).map((l) => ({ ...l })),
    };
  }

  /**
   * The one description of the file's metadata, the way documentOf is the one
   * description of its contents. Everything here is a fact about the file
   * rather than about the project in it, which is why none of it is in
   * documentOf: putting it there would drag it into sameDocument and make
   * saving a project count as changing it.
   *
   * Step 18 is what forced this apart. The name was needed on the way back in,
   * and the alternatives were both worse: folding it into documentOf breaks the
   * dirty flag, and reading it straight off the raw JSON in parse writes the
   * shape out a second time, which is exactly the mistake Step 15 found.
   */
  function metaOf(source) {
    const doc = source || {};
    return {
      // Not read by anything. It is here because the first question anyone asks
      // about a file that will not open is which build wrote it.
      app: typeof doc.app === 'string' ? doc.app : '',
      savedAt: typeof doc.savedAt === 'string' ? doc.savedAt : '',
      // Step 18. What this project was called when it was last saved, so a
      // claim in the cache can still recognise it after a rename outside the
      // app. Absent from every file written before Step 18, which is the
      // additive-only rule working as intended: it reads as an empty name and
      // the claim falls back to matching on the path.
      name: typeof doc.name === 'string' ? doc.name : '',
    };
  }

  /**
   * V3.3. The zoom and pan each editor was left at, by layer and keyframe:
   * the user, 2026-11-03, "each setting/pan/zoom should be saved in the
   * project file as well". Keyed by strings the window makes and reads back
   * as they are; this only keeps what is a view and drops the rest, so a hand
   * edited file cannot hand the window a zoom of nothing.
   *
   * Not part of documentOf, for the reason the timeline's own zoom is not:
   * it is where the editors were looking, not what the project is. Zooming a
   * stage is therefore not an unsaved change on its own, and every save
   * writes the views as they are at that moment.
   */
  function viewsOf(source) {
    const out = {};
    if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
    for (const [key, view] of Object.entries(source)) {
      if (!key || !view || typeof view !== 'object') continue;
      const zoom = Number(view.zoom);
      if (!Number.isFinite(zoom) || zoom <= 0) continue;
      const kept = { zoom: round(zoom) };
      for (const field of ['cx', 'cy', 'panX', 'panY']) {
        if (view[field] === null) kept[field] = null;
        else if (typeof view[field] === 'number' && Number.isFinite(view[field])) kept[field] = round(view[field]);
      }
      out[key] = kept;
    }
    return out;
  }

  /**
   * V3.3. The undo stack as history.js packs it, kept beside the document for
   * the same reason the views are: undoing changes the document, the stack
   * itself is not an unsaved change. Only its shape is checked here;
   * projectHistory.unpack decides whether it still fits the project that
   * opened, and drops it whole if it does not.
   */
  function historyOf(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    if (!Array.isArray(source.pool) || !Array.isArray(source.steps)) return null;
    if (!Number.isInteger(source.at)) return null;
    return { at: source.at, pool: source.pool, steps: source.steps };
  }

  /**
   * V3.6.1. What an auto-save says about itself: which run of the app wrote
   * it, and the project file it is a copy of, null for a project never
   * saved. Null for every file that is not an auto-save, which is every file
   * the user saves. A fact about the file rather than the project, like
   * metaOf, so it is not part of documentOf either.
   */
  function autosaveOf(source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
    if (typeof source.session !== 'string' || !source.session) return null;
    const o = source.origin;
    const origin = o && typeof o === 'object' && typeof o.path === 'string' && o.path
      ? { path: o.path, name: typeof o.name === 'string' ? o.name : '' }
      : null;
    return { session: source.session, origin };
  }

  /** Whether the document has changed since a given copy of it. */
  function sameDocument(a, b) {
    return deepEqual(documentOf(a), documentOf(b));
  }

  /**
   * A file reference: where it was, where it is relative to the project, and
   * enough to tell whether it is still the same file.
   *
   * `duration` is in the fingerprint for a better reason than completeness: a
   * reference whose size and mtime still match needs no probe at all, so a
   * project of eight layers opens without eight ffprobe calls. It is also the
   * one field that would catch a file rewritten to the same size at the same
   * timestamp, which nothing else would.
   */
  function refFor(layer, stat, relative) {
    return {
      path: layer.src,
      // Only when the project and the file share a drive. Undefined rather than
      // null when there is none, so it simply is not written.
      relative: relative || undefined,
      size: stat ? Math.max(0, Math.round(num(stat.size))) : 0,
      mtime: stat ? Math.round(num(stat.mtimeMs)) : 0,
      duration: round(num(layer.sourceDuration)),
    };
  }

  /**
   * The object a .lwc holds.
   *
   * `stats` maps a source path to what fs.stat said about it, and `relatives`
   * maps the same path to its path relative to where the project is being
   * saved. Both are worked out by the main process, because this module does
   * not touch a filesystem.
   */
  function serialise(state, { stats = {}, relatives = {}, app = '', name = '', autosave = null } = {}) {
    const doc = documentOf(state);
    return {
      format: FORMAT,
      version: VERSION,
      // Spread from metaOf rather than written out here, so what serialise
      // writes and what parse reads back are the same set of fields by
      // construction rather than by two lists agreeing.
      ...metaOf({ app, savedAt: new Date().toISOString(), name }),
      // V3.6.1. Only on an auto-save; undefined is not written at all.
      autosave: autosaveOf(autosave) || undefined,
      project: doc.project,
      trim: doc.trim,
      layers: doc.layers.map((l) => ({
        ...l,
        // The reference travels beside the layer rather than replacing src, so
        // a project read by an older app still finds a path where it expects
        // one.
        ref: l.src ? refFor(l, stats[l.src], relatives[l.src]) : null,
      })),
      // V3.3. Beside the document rather than in it, see viewsOf.
      views: viewsOf(state.views),
      // V3.3. The undo stack, see historyOf. Last, since it is the bulk.
      history: historyOf(state.history),
    };
  }

  function stringify(doc) {
    return JSON.stringify(doc, null, 2) + '\n';
  }

  /**
   * Read a .lwc.
   *
   * Every failure is a message rather than a throw, because all of them end up
   * in front of the user and "not a project file" and "written by a newer
   * version" are different things to say.
   */
  function parse(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return { ok: false, error: 'notJson' };
    }
    if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) {
      return { ok: false, error: 'notProject' };
    }
    const version = Math.round(num(doc.version, 0));
    if (!(version >= 1)) return { ok: false, error: 'notProject' };
    if (version > VERSION) return { ok: false, error: 'tooNew', version };
    if (!Array.isArray(doc.layers)) return { ok: false, error: 'notProject' };
    // Filling in defaults for anything absent is the whole of opening an older
    // file, by the additive-only rule, and documentOf is already exactly that
    // function. It used to be written out a second time here, and Step 15 found
    // out why that was a mistake: a field added to one of them and not the
    // other is a field that is written and then silently dropped on the way
    // back in. There is one description of the document now.
    return {
      ok: true,
      version,
      doc: documentOf(doc),
      meta: metaOf(doc),
      views: viewsOf(doc.views),
      history: historyOf(doc.history),
      autosave: autosaveOf(doc.autosave),
    };
  }

  /**
   * Where a layer's file might be now, in the order to try.
   *
   * The relative path first, so that a project and its media moved together as
   * a folder are found where they are rather than where they were. The
   * absolute path is the fallback for media that never moved, and for a project
   * that was moved on its own.
   */
  function candidatesFor(ref, dir, join) {
    const out = [];
    if (ref && ref.relative && dir) out.push(join(dir, ref.relative));
    if (ref && ref.path) out.push(ref.path);
    return out;
  }

  /**
   * A source's path relative to where the project is being saved, so that a
   * project and its media moved together as a folder are found where they are
   * rather than where they were.
   *
   * `pathApi` is node's path module, handed in for the same reason
   * `candidatesFor` takes join: the window loads this file as a plain script
   * and cannot require anything.
   *
   * Null when there is no useful relationship to record: a different drive, or
   * a path that has to climb further out than a project and its media would
   * ever plausibly sit apart. "..\\..\\..\\..\\somewhere else" is not a
   * relationship, it is the absolute path spelled badly.
   */
  function relativePath(projectDir, filePath, pathApi, maxClimb = 3) {
    try {
      // The drive letter alone. path.parse reports the root as it was spelled,
      // so C:/ and C:\ come back as different strings for the same drive, and
      // comparing them whole makes a mixed-separator pair look like two drives
      // and silently drops the relative path.
      const driveOf = (p) => pathApi.parse(p).root.replace(/[\\/]+$/, '').toLowerCase();
      if (driveOf(projectDir) !== driveOf(filePath)) return null;
      const rel = pathApi.relative(projectDir, filePath);
      if (!rel || pathApi.isAbsolute(rel)) return null;
      if (rel.split(pathApi.sep).filter((p) => p === '..').length > maxClimb) return null;
      return rel;
    } catch {
      return null;
    }
  }

  /**
   * Does what is at this path look like the file that was saved?
   *
   * Size and mtime, both of which a single stat gives. Duration is carried but
   * not checked here, because checking it means a probe per layer and these two
   * already catch everything a probe would except a deliberate forgery.
   */
  function fingerprintMatches(ref, stat) {
    if (!ref || !stat) return false;
    if (!ref.size && !ref.mtime) return true; // Saved before a stat was possible.
    return Math.round(num(stat.size)) === ref.size
      && Math.round(num(stat.mtimeMs)) === ref.mtime;
  }

  /**
   * Decide what became of one reference, given what the filesystem said about
   * each of its candidate paths.
   *
   * `found` is a list of { path, stat } in candidate order, stat null when
   * there is nothing there.
   *
   *   ok        a candidate exists and its fingerprint matches
   *   replaced  something is there but it is not the file that was saved
   *   missing   nothing is at any candidate
   *
   * A match anywhere wins over an existing-but-different file earlier in the
   * list, so preferring the relative path never costs a perfectly good
   * absolute one. That is the one place this departs from "prefer the relative
   * path", and it departs in the direction of opening the project.
   */
  function statusFor(ref, found) {
    const live = (found || []).filter((f) => f && f.stat);
    if (!live.length) return { state: 'missing', path: ref ? ref.path : null };
    const match = live.find((f) => fingerprintMatches(ref, f.stat));
    if (match) return { state: 'ok', path: match.path };
    return { state: 'replaced', path: live[0].path };
  }

  /**
   * The document with each layer pointed at wherever its file turned out to be,
   * and a list of everything that is not where it was.
   *
   * Nothing is dropped here. Removing the unusable tracks is what Continue
   * does, and it is a separate step on purpose: the modal has to be able to
   * name them before anyone decides.
   */
  function applyStatuses(doc, statuses) {
    const trouble = [];
    const layers = doc.layers.map((l) => {
      const status = statuses[l.id];
      if (!status) return l;
      if (status.state === 'ok') return { ...l, src: status.path };
      trouble.push({
        id: l.id,
        name: l.name || '',
        state: status.state,
        path: (l.ref && l.ref.path) || l.src || '',
      });
      return { ...l, src: status.path || l.src };
    });
    return { layers, trouble };
  }

  /** What Continue does: the tracks that cannot be trusted, gone from memory. */
  function pruneTrouble(layers, trouble) {
    const drop = new Set((trouble || []).map((t) => t.id));
    return layers.filter((l) => !drop.has(l.id));
  }

  return {
    FORMAT,
    EXT,
    VERSION,
    documentOf,
    metaOf,
    viewsOf,
    historyOf,
    autosaveOf,
    sameDocument,
    serialise,
    stringify,
    parse,
    candidatesFor,
    relativePath,
    fingerprintMatches,
    statusFor,
    applyStatuses,
    pruneTrouble,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = projectFile;
