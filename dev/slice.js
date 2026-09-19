'use strict';

// Step 4 of the V2 plan: the vertical slice, and the confidence checkpoint the
// whole plan turns on. Two hardcoded files become two layers, composited to a
// canvas in a window and exported through composer.js, and the two are then
// compared. Nothing after Phase C is allowed to start until they agree.
//
// Throwaway on purpose. It lives outside src/ and renderer/ so it is not in the
// packaged file list, it is reached only by passing --v2-slice, and it goes in
// the bin once Steps 5 to 10 build the real thing.
//
// It runs with nodeIntegration rather than going through preload.js and the IPC
// surface, because the thing being proved is that the preview and the encoder
// read the same numbers. How those numbers reach the renderer in the real app
// has nothing to do with it, and touching preload.js would mean editing shipped
// code for a harness.

const { BrowserWindow } = require('electron');
const path = require('path');
const toolPaths = require('../src/toolPaths');

function argValue(name) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : '';
}

function open() {
  const win = new BrowserWindow({
    width: 1100,
    height: 900,
    backgroundColor: '#1e1e22',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      // The renderer cannot ask toolPaths for these: toolPaths reads
      // electron's `app`, which does not exist in a renderer process.
      additionalArguments: [
        '--slice-ffmpeg=' + toolPaths.findFfmpeg(),
        '--slice-a=' + argValue('v2-a'),
        '--slice-b=' + argValue('v2-b'),
        '--slice-out=' + argValue('v2-out'),
      ],
    },
  });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, _level, message) => {
    process.stdout.write(message + '\n');
  });
  win.loadFile(path.join(__dirname, 'slice.html'));
  return win;
}

module.exports = { open };
