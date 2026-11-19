'use strict';

// V5.5. File > Open recent: the projects last saved or opened, newest first.
//
// Kept in the settings (`recentProjects`), as paths and nothing else: the
// name shown is the file's own, and whether a project is still there is asked
// of the disk when the list is shown, not remembered. A project that is gone
// stays in the list, shown as missing, until it is opened (and found gone) or
// the list is cleared: a drive that is not plugged in today is not a project
// that no longer exists.
//
// Pure: the main process reads and writes the setting.

const MAX = 10;

/** Windows names a file alike in any case and with either slash. */
function keyOf(file) {
  return String(file || '').split('/').join('\\').toLowerCase();
}

/** The list as it may be kept: paths, each once, no more than MAX. */
function listOf(source) {
  if (!Array.isArray(source)) return [];
  const out = [];
  const seen = new Set();
  for (const file of source) {
    if (typeof file !== 'string' || !file.trim()) continue;
    const key = keyOf(file);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
    if (out.length >= MAX) break;
  }
  return out;
}

/** `file` put first, as it is spelled now, and taken out of wherever it was. */
function add(list, file) {
  if (typeof file !== 'string' || !file.trim()) return listOf(list);
  const key = keyOf(file);
  return listOf([file, ...listOf(list).filter((f) => keyOf(f) !== key)]);
}

function remove(list, file) {
  const key = keyOf(file);
  return listOf(list).filter((f) => keyOf(f) !== key);
}

module.exports = { MAX, listOf, add, remove, keyOf };
