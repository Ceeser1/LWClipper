'use strict';

// Wraps dist/win-unpacked in the caching launcher. Run it after electron-builder
// has produced that folder:
//
//   npm run dist        (produces dist/win-unpacked)
//   npm run launcher    (produces dist/LWClipper <version>.exe)
//
// The splash it shows comes from assets/splash.bmp, which is drawn separately by
// "npm run splash" and only needs redrawing when the icon or the wording change.
//
// makensis comes from electron-builder's own download cache, so there is no
// separate toolchain to install; it is the same compiler electron-builder used
// for the portable target.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const appDir = path.join(ROOT, 'dist', 'win-unpacked');
const outFile = path.join(ROOT, 'dist', `LWClipper ${version}.exe`);
const icon = path.join(ROOT, 'icon.ico');
const splash = path.join(ROOT, 'assets', 'splash.bmp');
const script = path.join(__dirname, 'launcher.nsi');

// The launcher has to size its window to the bitmap, and it has no way to read
// a BMP header at run time, so the size is compiled in. Taken from the file
// itself rather than written down twice.
function splashSize(file) {
  const head = Buffer.alloc(26);
  const fd = fs.openSync(file, 'r');
  const read = fs.readSync(fd, head, 0, 26, 0);
  fs.closeSync(fd);
  if (read < 26 || head.toString('ascii', 0, 2) !== 'BM') return null;
  const width = head.readInt32LE(18);
  const height = head.readInt32LE(22);
  if (width < 1 || height < 1) return null;
  return { width, height };
}

// The launcher keeps the splash up until it finds the app's window, and finds
// it by title. Reading the title out of the page means the two cannot drift
// apart without this build failing.
function windowTitle() {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const open = html.indexOf('<title>');
  const close = html.indexOf('</title>');
  if (open < 0 || close < open) return null;
  return html.slice(open + 7, close).trim() || null;
}

function findMakensis() {
  const caches = [
    path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'nsis'),
    path.join(os.homedir(), '.cache', 'electron-builder', 'nsis'),
  ];
  for (const cache of caches) {
    if (!fs.existsSync(cache)) continue;
    for (const entry of fs.readdirSync(cache)) {
      const candidate = path.join(cache, entry, 'makensis.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const makensis = findMakensis();
if (!makensis) {
  console.error('makensis was not found. Run "npm run dist" once and it will be downloaded.');
  process.exit(1);
}
if (!fs.existsSync(path.join(appDir, 'LWClipper.exe'))) {
  console.error('dist/win-unpacked is not there. Run "npm run dist" first.');
  process.exit(1);
}
if (!fs.existsSync(splash)) {
  console.error('assets/splash.bmp is not there. Run "npm run splash" to draw it.');
  process.exit(1);
}

const size = splashSize(splash);
if (!size) {
  console.error('assets/splash.bmp is not a bitmap this can measure. Run "npm run splash".');
  process.exit(1);
}
const title = windowTitle();
if (!title) {
  console.error('renderer/index.html has no <title>, so the launcher cannot wait for the window.');
  process.exit(1);
}

const before = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
console.log('makensis : ' + makensis);
console.log('payload  : ' + appDir);
console.log('output   : ' + outFile);
console.log('version  : ' + version);
console.log('splash   : ' + size.width + 'x' + size.height);
console.log('waits for: ' + title + '\n');

// NSIS needs a plain x.y.z.w for VIProductVersion, so anything with a prerelease
// tag on it would have to be trimmed. Fail loudly rather than emit a bad build.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('version "' + version + '" is not three numbers; VIProductVersion needs that.');
  process.exit(1);
}

try {
  const out = execFileSync(makensis, [
    '/V2',
    '/DVERSION=' + version,
    '/DAPPDIR=' + appDir,
    '/DOUTFILE=' + outFile,
    '/DICON=' + icon,
    '/DSPLASH=' + splash,
    '/DSPLASH_W=' + size.width,
    '/DSPLASH_H=' + size.height,
    '/DWINDOWTITLE=' + title,
    script,
  ], { encoding: 'utf8', windowsHide: true });
  if (out.trim()) console.log(out.trim());
} catch (error) {
  console.error(String(error.stdout || '') + String(error.stderr || '') || error.message);
  process.exit(1);
}

const bytes = fs.statSync(outFile).size;
console.log('\nwrote ' + outFile);
console.log('      ' + bytes.toLocaleString() + ' bytes ('
  + (bytes / 1048576).toFixed(0) + ' MB)'
  + (before ? ', was ' + (before / 1048576).toFixed(0) + ' MB' : ''));
