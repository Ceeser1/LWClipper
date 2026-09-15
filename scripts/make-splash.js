'use strict';

// Draws the launcher's splash and writes it as assets/splash.bmp.
//
//   npm run splash
//
// A bitmap because that is the only thing LoadImage reads from a file, and the
// launcher has no image decoder of its own. Run this again after changing
// icon.ico or the wording; the built launcher uses the checked-in file.
//
// It runs under Electron rather than plain node so Chromium does the drawing:
// the icon needs an .ico decoder and the name needs a font, and neither is
// worth hand-rolling for one 400x280 picture.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, nativeImage } = require('electron');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'splash.bmp');
const WIDTH = 400;
const HEIGHT = 280;

// Without this the capture comes back at the display's scale, so a machine at
// 125% would bake a 500x350 picture and the launcher would show it stretched.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// 24-bit, bottom-up, rows padded to 4 bytes: the plainest BMP there is, which
// is what an unadorned LoadImage call wants. toBitmap gives BGRA, and the
// background is opaque, so alpha is dropped rather than composited.
function toBmp24(bgra, w, h) {
  const stride = (w * 3 + 3) & ~3;
  const pixels = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    const src = y * w * 4;
    const dst = (h - 1 - y) * stride;
    for (let x = 0; x < w; x += 1) {
      pixels[dst + x * 3] = bgra[src + x * 4];
      pixels[dst + x * 3 + 1] = bgra[src + x * 4 + 1];
      pixels[dst + x * 3 + 2] = bgra[src + x * 4 + 2];
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(54 + pixels.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(w, 18);
  head.writeInt32LE(h, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(pixels.length, 34);
  head.writeInt32LE(2835, 38);
  head.writeInt32LE(2835, 42);
  return Buffer.concat([head, pixels]);
}

function page(iconUrl) {
  return [
    '<!doctype html><meta charset="utf-8"><style>',
    'html, body { margin: 0; padding: 0; }',
    'body {',
    '  width: ' + WIDTH + 'px; height: ' + HEIGHT + 'px;',
    '  box-sizing: border-box;',
    '  background: #1e1e22;',
    // No drawn border. The launcher rounds the window off with a region, and a
    // border painted into the bitmap would have to follow that curve exactly or
    // show as a clipped arc at each corner. A flat card cannot mismatch.
    '  display: flex; flex-direction: column;',
    '  align-items: center; justify-content: center;',
    '  font-family: "Segoe UI", sans-serif; color: #e6e6eb;',
    '}',
    '.icon { width: 132px; height: 132px; }',
    '.name { margin-top: 22px; font-size: 27px; font-weight: 600; letter-spacing: 0.4px; }',
    '.rule { margin-top: 16px; width: 64px; height: 3px; border-radius: 2px; background: #78c88c; }',
    '</style>',
    '<img class="icon" src="' + iconUrl + '">',
    '<div class="name">LWClipper</div>',
    '<div class="rule"></div>',
  ].join('\n');
}

app.whenReady().then(async () => {
  const icon = nativeImage.createFromPath(path.join(ROOT, 'icon.ico'));
  if (icon.isEmpty()) throw new Error('icon.ico did not decode');
  const size = icon.getSize();

  const html = path.join(os.tmpdir(), 'lwclipper-splash-' + process.pid + '.html');
  fs.writeFileSync(html, page(icon.toDataURL()));

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    webPreferences: { offscreen: true },
  });
  await win.loadFile(html);
  // Offscreen windows paint on their own schedule, so capture only once a frame
  // has actually been produced.
  await new Promise((done) => win.webContents.once('paint', done));
  const shot = await win.webContents.capturePage();
  const got = shot.getSize();
  if (got.width !== WIDTH || got.height !== HEIGHT) {
    throw new Error('captured ' + got.width + 'x' + got.height + ', wanted ' + WIDTH + 'x' + HEIGHT);
  }

  fs.writeFileSync(OUT, toBmp24(shot.toBitmap(), WIDTH, HEIGHT));
  fs.unlinkSync(html);
  win.destroy();

  console.log('icon     : ' + size.width + 'x' + size.height + ' from icon.ico');
  console.log('wrote    : ' + OUT);
  console.log('           ' + WIDTH + 'x' + HEIGHT + ', '
    + fs.statSync(OUT).size.toLocaleString() + ' bytes');
  app.exit(0);
}).catch((error) => {
  console.error(String((error && error.stack) || error));
  app.exit(1);
});
