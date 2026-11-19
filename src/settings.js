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
  // On, so a fresh profile opens in advanced editing, and with that maximized
  // (createWindow in main.js). It was on while the timeline was being built
  // and meant to go back to false before release. The user settled it the
  // other way on 2026-11-15: "the v4.11.3 standalone and installer both should
  // open in Advanced editing mode in windowed-fullscreen from now on". Both
  // builds are this one app, so the default is all there is to it. A default
  // only: a profile left in simple editing still opens in simple editing.
  advancedEditing: true,
  // V3.3. Where each popped out editor window was last closed, by its name:
  // { x, y, width, height }. null until one has been.
  popoutBounds: null,
  // V3.8. Which editor windows were last docked into the main window, by
  // their short names ('crop', 'bar', 'shape', 'text', 'render'): 'start' for Start Frame,
  // 'end' for End Frame. One not in it opens as a window. null until one is.
  popoutDock: null,
  // V4.2. The keys bound in Key Binds, by action id: { 'edit.copy': ['Ctrl+C'] }.
  // Only the ones that differ from their defaults; null until one does.
  keyBinds: null,
  // V4.4. What renders an export's picture: 'auto' (the GPU when it can),
  // 'gpu' or 'cpu'. See src/renderDevice.js.
  renderDevice: 'auto',
  // V4.5. Whether the Project Media frame is folded down to its title.
  projectMediaCollapsed: false,
  // V4.11.1. The frames as the handles between them were left: { split, the
  // timeline's height; splitMax, its share of the room while the window is
  // maximized; side, the two side previews' width; gutter, the layer column's;
  // media, the height of a Project Media tile's picture }, each null while it
  // is still the default. null until a handle is dragged, and again after
  // View > Restore default layout.
  layout: null,
  // V4.11.1. The main window's own size as it was left, since the frames are
  // measured inside it: { width, height, maximized, auto }, `auto` being
  // whether the window was still fitting its own height. null until the
  // window has been resized.
  windowSize: null,
  // V5.1.6. The headings of the VFX window's list that are folded shut, by
  // their ids (timeline.js VFX_GROUPS): ['color', 'distort']. null while all
  // are open.
  vfxFolded: null,
  // V5.5. The projects last saved or opened, newest first, as paths
  // (src/recentProjects.js). null until there is one.
  recentProjects: null,
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
