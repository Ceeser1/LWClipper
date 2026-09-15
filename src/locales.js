'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const settings = require('./settings');

// The languages the dropdown offers. The label is deliberately written in both
// the user's language and its own, so someone who has landed on the wrong one
// can still recognise their way back.
const LANGUAGES = [
  { code: 'en', label: 'English (English)' },
  { code: 'de', label: 'German (Deutsch)' },
];

// Shipped as real files rather than bundled into a module, so they can be
// opened and edited. In a packaged build they land under resources/ via
// extraResources; in dev they are the locales/ folder beside the project.
function shippedDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'locales')
    : path.join(__dirname, '..', 'locales');
}

// A portable build extracts its resources to a temp folder that is wiped on
// exit, so a translation edited there would not survive. Anything in the user's
// own folder wins, which gives a built .exe somewhere durable to edit.
function overrideDir() {
  return path.join(app.getPath('userData'), 'locales');
}

function readFileIfAny(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // Absent, or not valid JSON. A broken hand-edit falls back to English
    // rather than emptying the interface.
    return null;
  }
}

/**
 * The lookup table for a language: English text to translated text. English is
 * the source language, so it needs no table at all and returns an empty one,
 * where every lookup falls through to the key.
 */
function strings(code) {
  if (!code || code === 'en') return {};
  const name = String(code).replace(/[^a-z-]/gi, '') + '.json';
  return {
    ...(readFileIfAny(path.join(shippedDir(), name)) || {}),
    ...(readFileIfAny(path.join(overrideDir(), name)) || {}),
  };
}

/**
 * The main process's own lookup, for the handful of sentences it puts in front
 * of anyone itself rather than through the window. The renderer is handed the
 * whole table once and holds it; here the language is read per call instead,
 * which costs two small file reads on the rare occasion a dialog goes up and
 * means one raised after a language change is never a language behind.
 *
 * Keys are the English text, the same as everywhere else, so
 * scripts/check-locales.js finds them by scanning for t() and the dialogs are
 * listed beside the window's own strings.
 */
function t(key, vars) {
  const out = strings(settings.get('language'))[key] || key;
  if (!vars) return out;
  return out.replace(/\{(\w+)\}/g, (whole, name) => (
    name in vars ? String(vars[name]) : whole
  ));
}

/**
 * The first language Windows is set to display in that this app has a table
 * for, out of the list it hands over in preference order. Tags arrive as
 * "de-DE" and "de-AT"; only the part before the dash is compared, since a
 * translation here is for the language and not for the country. Falls through
 * to English, which is the source language and needs no table.
 *
 * A machine set to English with German further down the list gets English, and
 * that is the point: the list is in the order the user put it in.
 */
function matchSystem(preferred) {
  for (const tag of preferred || []) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (LANGUAGES.some((lang) => lang.code === base)) return base;
  }
  return 'en';
}

module.exports = { LANGUAGES, strings, shippedDir, overrideDir, t, matchSystem };
