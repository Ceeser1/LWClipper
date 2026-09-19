'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { safeFilename, containerFor } = require('./backend');
const settings = require('./settings');
const projectClaim = require('./claim');

// In a packaged build, tools/ ships under process.resourcesPath (see
// extraResources in package.json). In dev, it's just the tools/ folder
// beside this project. PATH is kept as a last-resort fallback only.
function bundledToolsDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'tools');
  }
  return path.join(__dirname, '..', 'tools');
}

function findBundledOrPath(exeName) {
  const bundled = path.join(bundledToolsDir(), exeName + '.exe');
  if (fs.existsSync(bundled)) return bundled;

  const pathEnv = process.env.PATH || '';
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry.trim()) continue;
    const candidate = path.join(entry.trim().replace(/^"|"$/g, ''), exeName + '.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Ships via extraResources rather than inside the asar, so it is a real file on
// disk that Windows can read directly. Same packaged/dev split as the tools.
function appIconPath() {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'icon.ico');
  return fs.existsSync(file) ? file : null;
}

const findYtDlp = () => findBundledOrPath('yt-dlp');
const findFfmpeg = () => findBundledOrPath('ffmpeg');
const findFfprobe = () => findBundledOrPath('ffprobe');

const CACHE_FOLDER_NAME = 'LWClipper_cache';

// Under the user's Videos folder. app.getPath resolves the real location even
// when Videos has been redirected to another drive, so this follows the user's
// own setup rather than assuming C:\Users\<name>\Videos. Still a plain visible
// folder, not AppData, so it stays easy to find and clear by hand.
function cacheRoot() {
  // A folder the user chose in Settings wins over everything below it.
  const chosen = settings.get('cacheDir');
  if (chosen) return chosen;
  try {
    const videos = app.getPath('videos');
    if (videos) return videos;
  } catch {
    // Windows could not resolve the Videos folder; fall back below.
  }
  // Fallback: beside the executable in a packaged build, beside the project in
  // dev. A portable build runs from a temp extraction folder, so
  // app.getPath('exe') points at temp rather than at wherever the user actually
  // keeps the .exe. electron-builder sets PORTABLE_EXECUTABLE_DIR to the real
  // location, which is what keeps the cache beside the file the user launched.
  return app.isPackaged
    ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')))
    : path.join(__dirname, '..');
}

// CACHE_FOLDER_NAME is appended to a folder the user picked, and that is
// deliberate: clearCache() deletes every file in here, so it must only ever
// point at a folder the app made. Pointing it straight at a folder somebody
// chose in a dialog would put their own files one button away from deletion.
//
// Unless they picked the cache folder itself, which is an easy thing to do when
// the dialog opens inside it. Nesting a second one in there would put the files
// somewhere nobody was expecting and abandon whatever the first one held, so a
// folder already carrying this name is taken as it stands. Compared without
// case, since Windows does not distinguish it and the folder on disk is the
// same one either way.
function isCacheFolder(dir) {
  return path.basename(dir).toLowerCase() === CACHE_FOLDER_NAME.toLowerCase();
}

// mkdir is recursive, so an existing folder is reused rather than replaced and
// nothing already cached in it is disturbed.
//
// A folder that cannot be created is still reported. The settings panel writes
// its readout from what this answers, and a throw here rejects that call and
// leaves the panel showing the folder it had before the change, which reads as
// the setting not having taken at all. Naming a folder that could not be made
// is the better of the two wrong answers.
function cacheDir() {
  const root = cacheRoot();
  const dir = isCacheFolder(root) ? root : path.join(root, CACHE_FOLDER_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Read-only, gone, or a drive that is not there any more.
  }
  return dir;
}

/**
 * Where the claim files live: one folder inside the cache, holding a .lwcref
 * per project that wants something in here.
 *
 * Not created on the way past, unlike cacheDir. Reading the claims is the
 * common case and an empty folder appearing in the user's Videos before any
 * project has ever claimed anything is clutter with nothing behind it. The one
 * caller that writes makes it.
 */
function projectsDir() {
  return path.join(cacheDir(), projectClaim.FOLDER);
}

// The plain files in a folder, with anything that is not one skipped. This is
// what keeps the claims folder out of every listing that means "the clips".
function fileNamesIn(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((f) => {
    try {
      return fs.statSync(path.join(dir, f)).isFile();
    } catch {
      return false; // Gone since the listing, or unreadable.
    }
  });
}

/** The cached clips, by name. A name in here is a content key. */
function cacheFileNames() {
  return fileNamesIn(cacheDir());
}

// A size that cannot be taken is 0 rather than a throw, and one file that
// cannot be stat'd costs only itself. A download finishing between the listing
// and the stat is enough to hit this.
function dirSizeBytes(dir) {
  let total = 0;
  for (const f of fileNamesIn(dir)) {
    try {
      total += fs.statSync(path.join(dir, f)).size;
    } catch {
      // Gone since the listing, or unreadable. Not counted.
    }
  }
  return total;
}

// The clips plus the claims. The claims are kilobytes against gigabytes, but
// the readout says what is in the folder and they are in the folder.
function cacheSizeBytes() {
  return dirSizeBytes(cacheDir()) + dirSizeBytes(projectsDir());
}

/**
 * Carries whatever the old cache folder still holds into the new one, so
 * changing the folder does not strand the clips already downloaded into it.
 * Within one drive this is a rename and costs nothing; across drives rename
 * fails with EXDEV, and those are copied and then removed.
 *
 * A name in this folder is a content key, so a file already sitting in the
 * destination is the same clip: the old copy is dropped rather than carried
 * over under a second name. Returns how many files arrived.
 */
/**
 * One folder's plain files carried into another, with the two collision rules
 * this app has.
 *
 * `onCollision` is 'drop' for clips, because a name in the cache is a content
 * key and a file already at the destination is the same clip. It is 'rename'
 * for claims, where a shared name means only that two projects were called the
 * same thing, and dropping one would silently unprotect a project.
 */
function moveFiles(from, to, onCollision) {
  const names = fileNamesIn(from);
  if (!names.length) return 0;
  try {
    fs.mkdirSync(to, { recursive: true });
  } catch {
    return 0; // Nowhere to put them; they stay where they are.
  }
  let moved = 0;
  for (const name of names) {
    const src = path.join(from, name);
    let dest = path.join(to, name);
    try {
      if (fs.existsSync(dest)) {
        if (onCollision === 'drop') {
          fs.unlinkSync(src);
          continue;
        }
        const ext = path.extname(name);
        const taken = fileNamesIn(to).map((f) => path.basename(f, path.extname(f)));
        dest = path.join(to, projectClaim.idFor(path.basename(name, ext), taken) + ext);
      }
      try {
        fs.renameSync(src, dest);
      } catch {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      }
      moved += 1;
    } catch {
      // Held open by a download in flight, or unreadable. It stays where it is,
      // and so does the folder around it.
    }
  }
  return moved;
}

function moveCache(from, to) {
  if (!from || !to) return 0;
  if (path.resolve(from).toLowerCase() === path.resolve(to).toLowerCase()) return 0;
  let moved = moveFiles(from, to, 'drop');
  // Step 18. The claims travel with the cache they describe. Without this the
  // folder would simply be left behind at the old location, and nothing would
  // report it: every project would quietly lose its protection the first time
  // the cache folder was changed.
  const fromClaims = path.join(from, projectClaim.FOLDER);
  moved += moveFiles(fromClaims, path.join(to, projectClaim.FOLDER), 'rename');
  try {
    fs.rmdirSync(fromClaims);
  } catch {
    // Never existed, or something in it could not be moved.
  }
  try {
    // Only ever a folder this app made, and only once it is empty: rmdir
    // refuses one with anything left in it, so a file that could not be moved
    // keeps its folder rather than losing it.
    if (isCacheFolder(from)) fs.rmdirSync(from);
  } catch {
    // Something is still in there, or in use.
  }
  return moved;
}

/**
 * Clear the clips, keeping the claims.
 *
 * `names` is which files to take, and defaults to all of them, which is what
 * this meant before a project could claim one. Step 18 gives the caller the say
 * because the rule that decides is about projects rather than about paths: it
 * lives in src/claim.js, and only the side holding the claims can apply it.
 *
 * The claims folder survives either way, because cacheFileNames lists files and
 * it is not one. That is the rule rather than the accident it used to be: this
 * walked readdir and unlinked everything, and a folder survived only because
 * unlink threw on it and the catch swallowed the error.
 */
function clearCache(names) {
  const dir = cacheDir();
  let freed = 0;
  for (const f of names || cacheFileNames()) {
    const full = path.join(dir, f);
    try {
      freed += fs.statSync(full).size;
      fs.unlinkSync(full);
    } catch {
      // Skip files still in use; the rest of the cache still clears.
    }
  }
  return freed;
}

// Quick-save target: <Desktop>\<current name>_clipped.<ext>. app.getPath
// resolves the user's real Desktop, a relocated or OneDrive-backed one included.
// Quick-save shows no dialog, so there is no overwrite prompt either; an
// existing file gets a numbered sibling rather than being clobbered.
function quickSaveTarget(title, isAudio, format) {
  const dir = app.getPath('desktop');
  // The format toggle in the save row picks this; the old defaults stand in if
  // it ever hands over something unrecognised.
  const ext = '.' + containerFor('x.' + String(format || ''), isAudio);
  const stem = safeFilename(title) + '_clipped';
  let candidate = path.join(dir, stem + ext);
  for (let n = 2; fs.existsSync(candidate); n += 1) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

module.exports = {
  findYtDlp, findFfmpeg, findFfprobe, cacheDir, isCacheFolder, cacheSizeBytes, clearCache,
  moveCache,
  projectsDir, cacheFileNames,
  quickSaveTarget,
  appIconPath,
};
