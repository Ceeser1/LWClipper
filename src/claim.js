'use strict';

// The .lwcref claim file: which cached downloads a project still wants.
//
// Step 18. Clear cache deletes everything in the cache folder, and a project
// that references a download is a project whose media that deletes. The cache
// cannot know a project exists, so projects say so: saving or opening one
// writes a claim into <cache>/projects/, and clearing reads them.
//
// **A claim, not a copy and not a move.** The files stay in the flat cache and
// this only records which of them a project uses. Two projects can want the
// same download, which a move cannot express and a copy pays for in gigabytes;
// and the .lwc never has to be rewritten to new paths.
//
// **Files are named, not pathed.** A name in the cache folder is a content key,
// which is why moveCache treats a name already present at the destination as
// the same clip. Recording names rather than paths is what lets the whole cache
// folder move without invalidating a single claim.
//
// **A claim is found again by two things that check each other**: the path it
// recorded, and the project's own last-saved name, which the .lwc carries too.
// A path alone cannot survive the file being moved, and a name alone cannot
// tell two projects called the same thing apart. Agreeing on either is what
// tells a renamed project from a different one.
//
// Pure: no fs, no Electron. The main process does the reading and writing.

const projectClaim = (() => {
  // What a .lwcref says it is, checked on read so a stray JSON file in the
  // folder is not taken for a claim.
  const FORMAT = 'lwclipper-claim';

  // The extension, with no dot, and the folder claims live in. Both are here
  // rather than in main.js for the reason EXT is in project.js: this file is
  // the subject, and more than one caller asks.
  const EXT = 'lwcref';
  const FOLDER = 'projects';

  const VERSION = 1;

  // Windows does not distinguish case in either a filename or a path, and both
  // of the things a claim is matched on are one of those.
  const key = (s) => String(s || '').toLowerCase();

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  /**
   * The names a project claims, cleaned up.
   *
   * Bare names only: anything carrying a separator is a path, and a path in
   * here would survive a cache move as a reference to a folder that no longer
   * holds anything. Deduplicated without case, for the same reason `key` is.
   */
  function fileNames(files) {
    const seen = new Set();
    const out = [];
    for (const f of files || []) {
      const name = str(f).trim();
      if (!name || name.includes('/') || name.includes('\\')) continue;
      if (seen.has(key(name))) continue;
      seen.add(key(name));
      out.push(name);
    }
    return out;
  }

  /**
   * The one description of a claim, the way documentOf is the one description
   * of a document. Both writing and reading go through it, so a field cannot be
   * written and then silently dropped on the way back in.
   */
  function claimOf(source) {
    const c = source || {};
    const project = c.project || {};
    return {
      project: {
        // What the project was last called, which is the same string the .lwc
        // carries in its own metadata. The two are compared on open.
        name: str(project.name),
        // Where it was when this was written. Tried first, because it is exact
        // when it is still true.
        path: str(project.path),
      },
      files: fileNames(c.files),
    };
  }

  function build({ name = '', path = '', files = [], app = '', savedAt = '' } = {}) {
    return {
      format: FORMAT,
      version: VERSION,
      app: str(app),
      savedAt: savedAt || new Date().toISOString(),
      ...claimOf({ project: { name, path }, files }),
    };
  }

  function stringify(claim) {
    return JSON.stringify(claim, null, 2) + '\n';
  }

  /**
   * Read a .lwcref.
   *
   * Unlike a project, nothing here is shown to the user as a message: a claim
   * that cannot be read is one the app wrote and can write again, so the caller
   * skips it. The reason still comes back, because "the folder is full of
   * something else" and "this one file is corrupt" are worth telling apart in a
   * log.
   */
  function parse(text) {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      return { ok: false, error: 'notJson' };
    }
    if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) {
      return { ok: false, error: 'notClaim' };
    }
    const version = Math.round(Number(doc.version) || 0);
    if (!(version >= 1)) return { ok: false, error: 'notClaim' };
    if (version > VERSION) return { ok: false, error: 'tooNew', version };
    return { ok: true, version, claim: claimOf(doc) };
  }

  /**
   * A filename for a new claim, given the ones already in the folder.
   *
   * The project's name is a label, not a key: two projects saved under the same
   * filename in different folders are two projects, and each gets its own
   * claim. The suffix only has to be unique, not meaningful, because nothing
   * reads a claim by its name; `matchFor` is what finds one again.
   */
  function idFor(name, taken = []) {
    const base = str(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'project';
    const used = new Set((taken || []).map(key));
    if (!used.has(key(base))) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = base + '-' + n;
      if (!used.has(key(candidate))) return candidate;
    }
    return base + '-' + Date.now();
  }

  /**
   * Which of these claims belongs to this project, if any.
   *
   * The recorded path first, because it is exact whenever the project has not
   * moved. Then the name, which is what catches a project renamed or moved
   * outside the app: the .lwc carries its own last-saved name and so does the
   * claim, so two files that have never met still agree on what the project was
   * called. Without this second route a rename leaves the old claim behind
   * forever and every rename grows the list by one.
   *
   * A claim matched by name alone is still the right one to reuse: the
   * alternative is a second claim for the same project, which is precisely the
   * ever growing list this exists to prevent.
   */
  function matchFor(claims, project) {
    const p = project || {};
    const list = claims || [];
    const byPath = p.path
      ? list.find((c) => c.claim && key(c.claim.project.path) === key(p.path))
      : null;
    if (byPath) return byPath;
    if (!p.name) return null;
    return list.find((c) => c.claim && c.claim.project.name
      && key(c.claim.project.name) === key(p.name)) || null;
  }

  /**
   * What Clear cache is allowed to delete, given which projects were ticked.
   *
   * The whole rule, and it is the user's: **a cached file goes only when every
   * project claiming it was ticked.** One unticked project still wanting a file
   * is enough to keep it, however many ticked ones also want it.
   *
   * A file nothing claims is deleted, which falls out of the same line rather
   * than being a case of its own: "every claimant was ticked" is true when
   * there are no claimants. That is the ordinary cache file, and clearing those
   * is what the button has always done.
   */
  function deletableFiles(claims, ticked, files) {
    const on = new Set((ticked || []).map(key));
    const wantedBy = new Map();      // file name -> ids of the claims naming it
    for (const entry of claims || []) {
      if (!entry || !entry.claim) continue;
      for (const f of entry.claim.files) {
        const k = key(f);
        if (!wantedBy.has(k)) wantedBy.set(k, []);
        wantedBy.get(k).push(entry.id);
      }
    }
    return (files || []).filter((f) => {
      const claimants = wantedBy.get(key(f)) || [];
      return claimants.every((id) => on.has(key(id)));
    });
  }

  /**
   * The rows the modal draws: one per claim, with what it is holding on to.
   *
   * `sizes` maps a cache file name to its size in bytes. A file a claim names
   * but the cache no longer holds counts as nothing and is not reported as an
   * error: the cache has been cleared before, or the download was removed by
   * hand, and neither is the project's fault.
   *
   * `bytes` is what ticking this row alone would actually free, so a file two
   * projects share is counted in neither: ticking one of them frees nothing.
   * Counting it in both would promise twice the space that exists.
   */
  function rowsFor(claims, sizes = {}) {
    const lower = new Map(Object.keys(sizes).map((k) => [key(k), sizes[k]]));
    const shared = new Map();
    for (const entry of claims || []) {
      if (!entry || !entry.claim) continue;
      for (const f of entry.claim.files) {
        const k = key(f);
        shared.set(k, (shared.get(k) || 0) + 1);
      }
    }
    return (claims || []).filter((e) => e && e.claim).map((entry) => {
      let bytes = 0;
      let held = 0;
      for (const f of entry.claim.files) {
        const k = key(f);
        if (!lower.has(k)) continue;
        held += 1;
        if (shared.get(k) === 1) bytes += lower.get(k);
      }
      return {
        id: entry.id,
        name: entry.claim.project.name || entry.id,
        path: entry.claim.project.path,
        files: entry.claim.files.length,
        held,
        bytes,
        // Set by the caller, which is the only one that can stat the .lwc.
        missing: !!entry.missing,
      };
    });
  }

  return {
    FORMAT,
    EXT,
    FOLDER,
    VERSION,
    claimOf,
    build,
    stringify,
    parse,
    idFor,
    matchFor,
    deletableFiles,
    rowsFor,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = projectClaim;
