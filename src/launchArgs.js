'use strict';

// V3.8.5. A project handed to the app from outside: a .lwc double-clicked in
// Explorer, dropped on the .exe, or named on a command line.
//
// The user, 2026-11-07: "Double-clicking an .lwc file should open in the same
// instance, and if a project is currently opened the same modal to
// save/discard/merge can come up."
//
// Pure: main.js hands in the command line and the folder it was started in,
// and does the locking, the focusing and the talking to the window.

const path = require('path');

/**
 * The project files on a command line, in the order they were named, as
 * absolute paths.
 *
 * Read by extension rather than by position. argv[1] is the file when Explorer
 * starts the packaged app, but it is "." under `electron .`, and Chromium adds
 * switches of its own to the copy a second instance hands over. Anything
 * starting with a dash is a switch, whatever it ends in.
 *
 * Not checked against the disk: a name that does not open is told so by the
 * same message Open Project gives, which is better than nothing happening.
 */
function projectArgs(argv, cwd, ext = 'lwc') {
  const tail = '.' + String(ext).toLowerCase();
  const out = [];
  for (const raw of (Array.isArray(argv) ? argv.slice(1) : [])) {
    if (typeof raw !== 'string') continue;
    const arg = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!arg || arg.startsWith('-')) continue;
    if (!arg.toLowerCase().endsWith(tail)) continue;
    // Explorer always passes a full path. A relative one is from a terminal,
    // and means relative to where that terminal was.
    const full = path.isAbsolute(arg) ? arg : path.resolve(cwd || '.', arg);
    if (!out.some((p) => samePath(p, full))) out.push(full);
  }
  return out;
}

/** Windows does not tell case apart in a path, so neither does this. */
function samePath(a, b) {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/**
 * The waiting list, with what arrived added to the end. A file already
 * waiting is not asked about twice: one double-click can reach the app as
 * both the second instance's own message and its command line.
 */
function enqueue(queue, files) {
  const next = Array.isArray(queue) ? queue.slice() : [];
  for (const f of files || []) {
    if (typeof f === 'string' && f && !next.some((q) => samePath(q, f))) next.push(f);
  }
  return next;
}

module.exports = { projectArgs, samePath, enqueue };
