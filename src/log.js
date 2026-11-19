'use strict';

// V5.4. The app's own log: one text file a person can read and send.
//
// Until now nothing was written down. A failed export showed the last lines
// ffmpeg said and then they were gone, and a download that stopped working
// left no trace of what yt-dlp had answered. Now every run of a tool, every
// error of the app's two halves and each start are a line here.
//
// The file is `lwclipper.log` in the log folder (the app's own folder under
// LOCALAPPDATA, beside its data, so Delete App files removes it too). Past
// MAX_BYTES it becomes `lwclipper.old.log`, taking the place of the one
// before, so the two together never grow past twice that. Nothing in here
// leaves the machine: the app sends it nowhere.
//
// Written with appendFileSync, a line at a time. A log that is still in a
// buffer when the app goes down has lost the one line it was kept for, and
// the app writes a handful of lines a minute at its busiest.

const fs = require('fs');
const path = require('path');

const FILE = 'lwclipper.log';
const OLD_FILE = 'lwclipper.old.log';
const MAX_BYTES = 2 * 1024 * 1024;
// A filter graph can be tens of thousands of characters; the head of the
// command names the files and the end names the output, which is what a
// reader wants of it.
const COMMAND_CAP = 6000;
const TEXT_CAP = 8000;

let dir = null;
let size = -1;

/** Where the log is kept. Nothing is written before this is called. */
function init(folder) {
  dir = folder ? String(folder) : null;
  size = -1;
}

function folder() {
  return dir;
}

function filePath() {
  return dir ? path.join(dir, FILE) : null;
}

/** A text held to `cap` characters, its middle left out and counted. */
function capped(text, cap = TEXT_CAP) {
  const s = String(text == null ? '' : text);
  if (s.length <= cap) return s;
  const head = Math.ceil(cap * 0.6);
  const tail = cap - head;
  return s.slice(0, head) + ' ...(' + (s.length - cap) + ' characters left out)... ' + s.slice(s.length - tail);
}

/** A command as it would be typed: the tool's name and its arguments, quoted where they need it. */
function commandLine(exe, args) {
  const quote = (a) => {
    const s = String(a);
    return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s;
  };
  return capped([path.basename(String(exe || '')), ...(Array.isArray(args) ? args : []).map(quote)].join(' '), COMMAND_CAP);
}

/** The moment on the user's own clock, to the millisecond: 2026-11-19 05:20:30.123. */
function stamp(now) {
  const p = (v, n = 2) => String(v).padStart(n, '0');
  return now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) + ' '
    + p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds()) + '.' + p(now.getMilliseconds(), 3);
}

/** One line of the log: the moment, the level, the part of the app, the text. */
function format(level, area, message, now = new Date()) {
  const text = capped(message).replace(/\r?\n/g, '\n    ');
  return stamp(now) + ' ' + String(level).toUpperCase().padEnd(5) + ' [' + area + '] ' + text + '\n';
}

function rotate(file) {
  try {
    fs.renameSync(file, path.join(dir, OLD_FILE));
  } catch {
    // Held by something reading it: the next line tries again.
    try {
      fs.copyFileSync(file, path.join(dir, OLD_FILE));
      fs.truncateSync(file, 0);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Writes one line. Never throws: a log that cannot be written must not take
 * down what it was describing.
 */
function write(level, area, message) {
  if (!dir) return false;
  try {
    const file = path.join(dir, FILE);
    if (size < 0) {
      fs.mkdirSync(dir, { recursive: true });
      try {
        size = fs.statSync(file).size;
      } catch {
        size = 0;
      }
    }
    if (size > MAX_BYTES && rotate(file)) size = 0;
    const line = format(level, area, message);
    fs.appendFileSync(file, line);
    size += Buffer.byteLength(line);
    return true;
  } catch {
    size = -1;
    return false;
  }
}

const info = (area, message) => write('info', area, message);
const warn = (area, message) => write('warn', area, message);
const error = (area, message) => write('error', area, message);

/** An Error as text, with where it was thrown from when it says. */
function errorText(e) {
  if (!e) return 'unknown error';
  if (e.stack) return String(e.stack);
  return String(e.message || e);
}

/**
 * What processRunner calls when a tool has ended (see setObserver there): the
 * command, how it ended and how long it took, and on a failure the last
 * lines it wrote.
 */
function toolEnded({ exe, args, exitCode, ms, cancelled, stderrTail, spawnError }) {
  const name = path.basename(String(exe || 'tool'));
  const took = Math.round(Number(ms) || 0) + ' ms';
  if (spawnError) {
    error('tool', name + ' could not be started: ' + errorText(spawnError) + '\n' + commandLine(exe, args));
    return;
  }
  if (cancelled) {
    info('tool', name + ' cancelled after ' + took + '\n' + commandLine(exe, args));
    return;
  }
  if (exitCode === 0) {
    info('tool', name + ' ok in ' + took + '\n' + commandLine(exe, args));
    return;
  }
  const said = Array.isArray(stderrTail) && stderrTail.length ? '\n' + stderrTail.join('\n') : '';
  error('tool', name + ' failed with exit code ' + exitCode + ' after ' + took + '\n' + commandLine(exe, args) + said);
}

module.exports = {
  init, folder, filePath, write, info, warn, error, errorText, toolEnded,
  format, capped, commandLine, FILE, OLD_FILE, MAX_BYTES,
};
