'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

// locales reaches for Electron's app to find the folder a hand-edited
// translation would sit in. Nothing here reads a file, so a stub is enough.
require.cache[require.resolve('electron')] = {
  exports: {
    app: {
      isPackaged: false,
      getPath: () => os.tmpdir(),
    },
  },
};

const locales = require('../src/locales');

test('matchSystem takes the first language there is a table for', () => {
  assert.equal(locales.matchSystem(['de-DE', 'de-AT']), 'de');
});

test('matchSystem respects the order the user put the list in', () => {
  // A machine displayed in English with German further down is a machine whose
  // owner reads English.
  assert.equal(locales.matchSystem(['en-US', 'de-DE', 'de-AT']), 'en');
});

test('matchSystem skips languages that have no table', () => {
  assert.equal(locales.matchSystem(['fr-FR', 'it-IT', 'de-AT']), 'de');
});

test('matchSystem falls back to English when nothing matches', () => {
  assert.equal(locales.matchSystem(['fr-FR', 'ja-JP']), 'en');
});

test('matchSystem survives an empty or missing list', () => {
  assert.equal(locales.matchSystem([]), 'en');
  assert.equal(locales.matchSystem(undefined), 'en');
});

test('matchSystem ignores case and a bare tag without a country', () => {
  assert.equal(locales.matchSystem(['DE']), 'de');
  assert.equal(locales.matchSystem(['De-At']), 'de');
});
