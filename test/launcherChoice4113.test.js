'use strict';

// V4.11.3. "LWC should have 2 options: Stand-alone and installer .exe", in one
// file: the launcher carries the installer and its first start asks which one.
// The launcher is NSIS and cannot be run from here, so these hold its script
// and the build that feeds it to the shape that was tried by hand.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const NSI = read('scripts', 'launcher.nsi');
const BUILD = read('scripts', 'build-launcher.js');
const PKG = JSON.parse(read('package.json'));

/** An NSIS function's body, from its name to its FunctionEnd. */
function fn(name) {
  const from = NSI.indexOf('\nFunction ' + name + '\n');
  assert.ok(from >= 0, name + ' is there');
  return NSI.slice(from, NSI.indexOf('\nFunctionEnd', from) + 12);
}

test('the question is only asked on a fresh start of a version with no file to open', () => {
  const init = fn('.onInit');
  assert.match(init, /\$\{FileExists\} "\$LOCALAPPDATA\\LWClipper\\runtime-\$\{VERSION\}\\\.ready"/);
  assert.match(init, /\$\{OrIf\} \$R0 != ""/);
  assert.match(init, /SetSilent silent[\s\S]*\$\{Else\}\s+SetSilent normal/);
  // Silence is decided at run time; a fixed SilentInstall would hide the page.
  assert.doesNotMatch(NSI, /^SilentInstall /m);
});

test('the runtime folder it checks is the one StartApp writes the marker into', () => {
  const start = fn('StartApp');
  assert.match(start, /StrCpy \$R1 "\$LOCALAPPDATA\\LWClipper"/);
  assert.match(start, /StrCpy \$R2 "\$R1\\runtime-\$\{VERSION\}"/);
  assert.match(start, /FileOpen \$0 "\$R2\\\.ready" w/);
});

test('both choices are on the page and lead where they say', () => {
  const page = fn('ChoicePage');
  assert.match(page, /"\$\(InstallLabel\)"/);
  assert.match(page, /"\$\(RunLabel\)"/);
  assert.match(page, /BCM_SETSHIELD/, 'the install choice carries the administrator shield');

  const leave = fn('ChoiceLeave');
  assert.match(leave, /\$Choice == "run"\s+HideWindow\s+Call StartApp\s+Quit/);
  assert.match(leave, /\$Choice == "install"\s+Call RunSetup\s+(;[^\n]*\s+)*Abort/);
});

test('the installer is waited for, and a refused start brings the page back', () => {
  const setup = fn('RunSetup');
  assert.match(setup, /File "\/oname=\$PLUGINSDIR\\LWClipper Setup\.exe" "\$\{SETUP\}"/);
  assert.match(setup, /ExecShellWait "open" "\$PLUGINSDIR\\LWClipper Setup\.exe"/);
  assert.match(setup, /\$\{IfNot\} \$\{Errors\}\s+Quit/);
  assert.match(setup, /ShowWindow \$HWNDPARENT \$\{SW_SHOW\}/);
  assert.match(setup, /\$\(NotStarted\)/);
});

test('every string of the window is there in English and in German', () => {
  const keys = new Set([...NSI.matchAll(/\$\((\w+)\)/g)].map((m) => m[1]));
  assert.ok(keys.size >= 8, 'the window uses its strings');
  for (const key of keys) {
    for (const lang of ['LANG_ENGLISH', 'LANG_GERMAN']) {
      assert.match(NSI, new RegExp('^LangString ' + key + ' +\\$\\{' + lang + '\\} ', 'm'), key + ' ' + lang);
    }
  }
});

test('no em dashes in the window text', () => {
  for (const line of NSI.split('\n').filter((l) => l.startsWith('LangString '))) {
    assert.doesNotMatch(line, /—/, line);
  }
});

test('the build wraps this version\'s Setup.exe and reads the script as UTF-8', () => {
  assert.match(BUILD, /const setupFile = path\.join\(ROOT, 'dist', `LWClipper v\$\{version\} Setup\.exe`\);/);
  assert.match(BUILD, /'\/DSETUP=' \+ setupFile/);
  assert.match(BUILD, /'\/INPUTCHARSET', 'UTF8'/);
  // The two names have to agree, or the launcher wraps nothing.
  assert.equal(PKG.build.nsis.artifactName, 'LWClipper v${version} Setup.${ext}');
  assert.match(PKG.scripts.dist, /electron-builder && node scripts\/build-launcher\.js/);
});
