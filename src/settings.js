'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Everything the user can change that has to outlive a run. Kept deliberately
// small: a portable app that leaves a large state file behind is the thing the
// portable build was avoiding. Unknown keys in the file on disk are dropped on
// the next write rather than carried, so a hand-edit typo cannot accumulate.
const DEFAULTS = {
  // Locale code, matching a file in locales/. 'en' is the source language and
  // needs no file of its own, since every key is already its English text.
  language: 'en',
  // null means the app picks its own location. A string overrides it, which is
  // what "Change cache folder" writes.
  cacheDir: null,
  // Turn compression on at the quality-to-size sweet spot whenever a format is
  // chosen, rather than leaving it off.
  bestCompression: false,
  // Swaps the Trim frame for the layer timeline.
  //
  // On while the timeline is being built, so a fresh profile opens straight
  // into the thing under construction. It goes back to false before release:
  // the simple window is what the app is for, and the timeline is the thing you
  // go and ask for.
  advancedEditing: true,
};

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Read once and keep it: this is consulted on every cache path lookup, which
// happens often enough that hitting the disk each time would be wasteful.
let current = null;

function all() {
  if (current) return current;
  current = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined && raw[key] !== null) current[key] = raw[key];
      else if (key in raw) current[key] = raw[key];
    }
  } catch {
    // No file yet, or it is not readable JSON. The defaults stand, and the next
    // write replaces whatever was there.
  }
  return current;
}

function get(key) {
  return all()[key];
}

/**
 * Merge a patch in and write it. Returns the full settings so a caller can hand
 * them straight back to the renderer without a second read.
 */
function set(patch) {
  const next = { ...all() };
  for (const key of Object.keys(DEFAULTS)) {
    if (key in patch) next[key] = patch[key];
  }
  current = next;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  } catch {
    // A settings file that cannot be written must not take the app down with
    // it. The change still applies for this run, it just will not survive it.
  }
  return next;
}

/**
 * Nothing has been saved yet. This is the one moment where guessing at a
 * default is right rather than presumptuous: from the first write onwards the
 * user's own choice stands, including the choice to leave it as it was.
 */
function isFirstRun() {
  return !fs.existsSync(settingsFile());
}

module.exports = { get, set, all, DEFAULTS, isFirstRun };
