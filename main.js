'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// Everything the app keeps for itself sits under one folder. Electron has no
// 'localAppData' path name, and its 'appData' is Roaming, which a domain profile
// would try to sync, so Local is read from the environment with the standard
// location as the fallback. This has to run before the app is ready, or
// Chromium has already opened its files at the old path. The download cache is
// deliberately not here: it holds videos, and lives somewhere visible.
const localAppData = process.env.LOCALAPPDATA
  || path.join(app.getPath('home'), 'AppData', 'Local');
app.setPath('userData', path.join(localAppData, 'LWClipper', 'data'));

const toolPaths = require('./src/toolPaths');
const ytdlp = require('./src/ytdlp');
const trimmer = require('./src/trimmer');
const waveform = require('./src/waveform');
const settings = require('./src/settings');
const locales = require('./src/locales');
// The dialogs below are the only sentences this side of the app writes, and
// they read off the same table the window does.
const t = locales.t;
const {
  safeFilename, AUDIO_EXTS, VIDEO_EXTS, OUTPUT_FORMATS, outputsFor, containerFor,
  compressionDisplay, stepForBitrate,
} = require('./src/backend');
const { ProcessCancelledError } = require('./src/processRunner');

// ffprobe reads the duration either way; the extension only decides whether the
// trim runs the audio path (stream copy) or the video path. Both lists live in
// backend.js so the dialog filter and the popup stay in step.

let mainWindow;
let currentCancelToken = null;

// The height the window opens at, and the floor the automatic fit works from:
// it may grow past this when the content needs it, never shrink below it.
//
// Measured on a real window, and the distinction matters: an offscreen
// BrowserWindow has no frame, so a height set on one of those is all client
// area, while this one spends about 36px of it on the title bar. 842 came from
// an offscreen measurement and left the preview frames squeezed by exactly that
// much, which is what the fit kept growing back out, landing on 878.
//
// 845 is that 878 less the 33px the cookie row took up before it moved into
// the settings panel. Measured the same way: the running window reported 33px
// spare under the preview controls once the row was gone, and the fit cannot
// give that back on its own because this is the floor it works from.
const BASE_HEIGHT = 845;

// The fit gives up the moment the user takes the size into their own hands, and
// never comes back for the rest of the run. Anything we set ourselves is
// recorded first so the resize it causes is not mistaken for theirs.
let autoHeight = true;
let lastAutoHeight = null;

function createWindow() {
  // Without this the taskbar and window show Electron's default icon, because
  // signAndEditExecutable is off and rcedit never stamps the inner executable.
  const icon = toolPaths.appIconPath();
  mainWindow = new BrowserWindow({
    ...(icon ? { icon } : {}),
    width: 1000,
    // The frame boxes are locked to 16:9 of their own width, so height the
    // preview section is given beyond what its title, frame and controls need
    // cannot be used and shows as an empty strip under the controls.
    // BASE_HEIGHT is where that strip measures 0 in the state the app opens in,
    // and it is the largest height that does, which leaves the spectrum as tall
    // as it can be.
    //
    // No height gives a zero strip and an exactly 16:9 box at once, since a
    // pixel of one is a pixel of the other. Closing the strip wins, because
    // object-fit: contain keeps the picture's own ratio whatever the box does,
    // so the cost is half a pixel of letterbox rather than a distorted frame.
    //
    // Only the opening state is flush. Loading a local file takes the quality
    // frame away and hands its 63px to a section that cannot grow into it, so
    // the strip comes back at about 38px. That is deliberate rather than
    // overlooked: flattening it too would mean sizing the window for the state
    // it is not usually in, and costing the spectrum another 40px to do it.
    height: BASE_HEIGHT,
    minWidth: 820,
    // 40px of shrink below the default, the same latitude the old 920/880 pair
    // allowed. Nothing scrolls at that height in any of the three states.
    minHeight: BASE_HEIGHT - 40,
    backgroundColor: '#1e1e22',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // Only a height we did not set counts as the user resizing. Dragging the
  // window wider leaves the height alone, so that on its own does not stop the
  // fit, which is about height only.
  lastAutoHeight = BASE_HEIGHT;
  mainWindow.on('resize', () => {
    if (!autoHeight || mainWindow.isDestroyed()) return;
    const height = mainWindow.getSize()[1];
    if (height !== lastAutoHeight) autoHeight = false;
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // First start only: open in the language Windows is set to display in, when
  // there is a translation for it. Writing it means every start after this one
  // reads a saved choice rather than guessing again, so switching the app to
  // English on a German machine sticks.
  if (settings.isFirstRun()) {
    settings.set({ language: locales.matchSystem(app.getPreferredSystemLanguages()) });
  }
  // Anything still here is left over from a run that never reached will-quit.
  waveform.clearPeaks();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Waveforms are worth nothing once the app is closed, so the folder goes with
// it rather than growing across sessions.
app.on('will-quit', () => {
  waveform.clearPeaks();
});

function sendProgress(frac, text) {
  if (mainWindow) mainWindow.webContents.send('job:progress', { frac, text });
}

function startJob() {
  currentCancelToken = { cancelled: false };
  return currentCancelToken;
}

ipcMain.handle('tools:status', () => {
  return {
    ytdlp: !!toolPaths.findYtDlp(),
    ffmpeg: !!toolPaths.findFfmpeg(),
    ffprobe: !!toolPaths.findFfprobe(),
    cacheSizeMb: toolPaths.cacheSizeBytes() / 1048576,
    cacheDir: toolPaths.cacheDir(),
  };
});

ipcMain.handle('tools:clearCache', () => {
  return toolPaths.clearCache() / 1048576;
});

// Everything the settings panel needs in one round trip: the values, the list
// the dropdown is built from, and the table the interface is translated with.
function settingsPayload() {
  return {
    settings: settings.all(),
    languages: locales.LANGUAGES,
    strings: locales.strings(settings.get('language')),
    appFilesDir: appFilesDir(),
  };
}

ipcMain.handle('settings:get', () => settingsPayload());

ipcMain.handle('settings:set', (_event, patch) => {
  settings.set(patch && typeof patch === 'object' ? patch : {});
  return settingsPayload();
});

// The folder the app keeps itself in, which is the parent of userData. Offered
// for opening and for deleting, and named in the panel so it is not a mystery
// where an app that was never installed has put things.
function appFilesDir() {
  return path.dirname(app.getPath('userData'));
}

ipcMain.handle('shell:openAppFiles', () => {
  const dir = appFilesDir();
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

ipcMain.handle('dialog:chooseCacheFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a folder for the cache',
    properties: ['openDirectory', 'createDirectory'],
    // One above the cache rather than inside it. What is being picked is the
    // folder the cache sits in, so opening in its parent shows the choice that
    // is already made alongside the alternatives, instead of opening in a
    // folder whose only contents are cached files.
    defaultPath: path.dirname(toolPaths.cacheDir()),
  });
  if (result.canceled || !result.filePaths.length) return { cancelled: true };
  // Read before the setting moves, or it reports the new folder as the old one.
  const from = toolPaths.cacheDir();
  const next = settings.set({ cacheDir: result.filePaths[0] });
  const to = toolPaths.cacheDir();
  // Whatever was already downloaded goes with it. Leaving it behind would put
  // the files somewhere the app no longer looks, where they neither count
  // towards the size shown nor come back on the next load, and Clear cache
  // could never reach them again either.
  const moved = toolPaths.moveCache(from, to);
  // The folder name is still appended underneath, so this reports where files
  // will actually go rather than what was picked.
  return { cancelled: false, cacheDir: to, moved, settings: next };
});

/**
 * Removes the app's own folder from LocalAppData. Chromium keeps files in there
 * open for as long as this process lives, so deleting in-process would leave
 * the locked ones behind. A detached command waits for this PID to go and then
 * takes the folder, which is the only way to get all of it.
 */
ipcMain.handle('app:deleteAppFiles', async () => {
  const dir = appFilesDir();
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    // 'Cancel' is deliberately the English word and deliberately not translated.
    // Windows lays a task dialog out by what it recognises: a label it knows as
    // a standard button goes in the row along the bottom and everything else
    // becomes a command link in the middle. It knows "Cancel" and has never
    // heard of "Abbrechen", so translating this one turned the dialog into two
    // stacked blocks in German and left it alone in English. Handing it the
    // word it knows keeps one layout in every language, and the caption on
    // screen is then Windows' own, in whatever language Windows is set to.
    buttons: ['Cancel', t('Delete App files')],
    defaultId: 0,
    cancelId: 0,
    title: t('Delete App files'),
    message: t('Delete everything in {dir}?', { dir }),
    // One literal on one line however long it runs: check-locales reads the
    // first string of a t() call as the key, so a sentence built by joining two
    // of them would register as its first half and never be translated.
    detail: t('This removes the settings and the language files. The app closes to do it. Your saved clips and the download cache are not touched.'),
  });
  if (choice.response !== 1) return { cancelled: true };

  // Written to a file rather than passed as a command line: the folder path
  // goes in as plain text, so nothing here depends on how quotes survive being
  // handed through spawn to cmd.
  //
  // It waits with ping rather than timeout. timeout reads the console to watch
  // for a keypress, and a detached process has no console, so it fails on the
  // spot instead of waiting; that is what left the folder behind, because rmdir
  // then ran while this process still had every file in it open. ping needs no
  // console. It retries for about a minute in case something is slow to let go,
  // then removes itself either way.
  const script = [
    '@echo off',
    'set /a tries=0',
    ':again',
    'set /a tries+=1',
    'ping -n 3 127.0.0.1 >nul 2>&1',
    'rmdir /s /q "' + dir + '" >nul 2>&1',
    'if not exist "' + dir + '" goto done',
    'if %tries% lss 30 goto again',
    ':done',
    'del "%~f0" >nul 2>&1',
    '',
  ].join('\r\n');
  const scriptPath = path.join(app.getPath('temp'),
    'lwclipper-remove-' + Date.now() + '.cmd');
  try {
    fs.writeFileSync(scriptPath, script);
  } catch {
    return { cancelled: false, error: 'Could not write the cleanup step.' };
  }
  spawn('cmd.exe', ['/c', scriptPath], {
    detached: true, windowsHide: true, stdio: 'ignore',
  }).unref();
  app.quit();
  return { cancelled: false };
});

ipcMain.handle('job:cancel', () => {
  if (!currentCancelToken) return;
  currentCancelToken.cancelled = true;
  // Killing is what actually stops a job that has gone quiet. Flipping the flag
  // alone only takes effect on the next line of output, which may never come.
  if (currentCancelToken.kill) currentCancelToken.kill();
});

ipcMain.handle('video:probe', async (_event, { url, cookies }) => {
  const token = startJob();
  try {
    return { ok: true, data: await ytdlp.probe(url, cookies, token) };
  } catch (e) {
    return { ok: false, cancelled: e instanceof ProcessCancelledError, error: String(e.message || e) };
  } finally {
    currentCancelToken = null;
  }
});

ipcMain.handle('video:download', async (_event, { videoId, sourceUrl, title, format, cookies }) => {
  const token = startJob();
  try {
    const media = await ytdlp.download(videoId, sourceUrl, title, format, cookies, sendProgress, token);
    return { ok: true, data: media };
  } catch (e) {
    return { ok: false, cancelled: e instanceof ProcessCancelledError, error: String(e.message || e) };
  } finally {
    currentCancelToken = null;
  }
});

ipcMain.handle('video:trim', async (_event, { media, destination, start, end, accurate, compression, audio, crop, video }) => {
  const token = startJob();
  try {
    const saved = await trimmer.trim(
      media, destination, start, end, accurate, compression, audio, crop, video, sendProgress, token);
    return { ok: true, data: saved };
  } catch (e) {
    return { ok: false, cancelled: e instanceof ProcessCancelledError, error: String(e.message || e) };
  } finally {
    currentCancelToken = null;
  }
});

ipcMain.handle('audio:peaks', async (_event, { filePath, duration, buckets }) => {
  try {
    return { ok: true, data: await waveform.peaksFor(filePath, duration, buckets) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('audio:abortPeaks', () => waveform.abort());

ipcMain.handle('dialog:openAudio', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a replacement audio track',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: AUDIO_EXTS.map((e) => e.slice(1)) },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };

  const filePath = result.filePaths[0];
  const { duration, hasAudio } = trimmer.probeMedia(filePath);
  if (!duration || !hasAudio) {
    return { ok: false, error: 'That file has no audio track ffmpeg can read.' };
  }
  return {
    ok: true,
    data: { path: filePath, name: path.basename(filePath), duration },
  };
});

// `steps` is what the compression slider reads at each of its four positions,
// or null for a format with nothing to compress, which is how WAV switches the
// control off without the renderer needing its own list of special cases.
const describeOutput = (f) => ({
  key: f, label: OUTPUT_FORMATS[f].label, steps: compressionDisplay(f),
});

ipcMain.handle('media:supportedTypes', () => {
  return {
    video: VIDEO_EXTS.map((e) => e.slice(1)),
    audio: AUDIO_EXTS.map((e) => e.slice(1)),
    // The save row builds its toggle from these, so the buttons and the
    // encoders cannot come to disagree about what the app can write.
    videoOut: outputsFor(false).map(describeOutput),
    audioOut: outputsFor(true).map(describeOutput),
  };
});

ipcMain.handle('path:quickSaveTarget', (_event, { title, isAudio, format }) => {
  return toolPaths.quickSaveTarget(title, isAudio, format);
});

// The format toggle in the save row decides what this opens on: that format is
// the pre-selected filter and the extension on the suggested name. The others
// stay in the list, so the dialog is still a way to change your mind.
ipcMain.handle('dialog:saveAs', async (_event, { title, isAudio, format }) => {
  const chosen = containerFor('x.' + String(format || ''), isAudio);
  const ordered = [chosen, ...outputsFor(isAudio).filter((f) => f !== chosen)];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save clip as',
    defaultPath: safeFilename(title) + '.' + chosen,
    filters: ordered.map((f) => ({ name: OUTPUT_FORMATS[f].dialogName, extensions: [f] })),
  });
  return result.canceled ? null : result.filePath;
});

/**
 * What the app needs to know about a file on disk. Shared by the Open File
 * dialog and by a dropped file, so the two cannot come to disagree about what
 * counts as loadable. Deliberately does not reject on extension: the dialog has
 * always had an "All files" option, and anything ffprobe can read a duration
 * from works, so a dropped file is held to exactly the same standard.
 */
function describeMedia(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const { duration, hasAudio, width, height, videoCodec, audioCodec, audioBitrate } =
    trimmer.probeMedia(filePath);
  if (!duration) {
    return { ok: false, error: 'ffprobe could not read a duration from that file.' };
  }
  const isAudio = AUDIO_EXTS.includes(ext);
  // What the save row should open on: the format the file already is, where the
  // app can write that format, and the usual default where it cannot. Saving a
  // .mov as a .mov is the least surprising thing it can offer, and it is also
  // the one choice that might avoid a re-encode entirely.
  const sourceFormat = containerFor(filePath, isAudio);
  return {
    ok: true,
    data: {
      path: filePath,
      title: path.basename(filePath, ext),
      duration,
      isAudio,
      hasAudio,
      width,
      height,
      videoCodec,
      audioCodec,
      sourceFormat,
      // Where the compression slider should start for a source whose format
      // measures itself in bitrates, so an mp3 opens at its own rate.
      compressionPreset: stepForBitrate(sourceFormat, audioBitrate),
    },
  };
}

ipcMain.handle('media:describe', (_event, filePath) => describeMedia(filePath));

ipcMain.handle('dialog:openMedia', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load a cached or local file',
    defaultPath: toolPaths.cacheDir(),
    properties: ['openFile'],
    filters: [
      { name: 'Audio and video', extensions: [...VIDEO_EXTS, ...AUDIO_EXTS].map((e) => e.slice(1)) },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
  return describeMedia(result.filePaths[0]);
});

/**
 * Grows or shrinks the window by what the renderer says the preview frames are
 * short of, or have spare. Positive is short, negative is spare. Converges
 * rather than oscillating, because growing by exactly the shortfall lands on
 * the size where there is neither.
 */
ipcMain.handle('window:fit', (_event, delta) => {
  if (!autoHeight || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized() || mainWindow.isFullScreen() || mainWindow.isMinimized()) return;
  const amount = Number(delta);
  if (!Number.isFinite(amount)) return;

  const [width, height] = mainWindow.getSize();
  // Never taller than the screen it is on has room for, or the bottom of the
  // window walks off the desktop on a short display.
  const room = screen.getDisplayMatching(mainWindow.getBounds()).workAreaSize.height;
  const wanted = Math.min(Math.max(height + amount, BASE_HEIGHT), room);
  // A pixel or two of rounding is not worth moving the window for, and acting
  // on it is what would turn rounding into a loop.
  if (Math.abs(wanted - height) < 4) return;

  lastAutoHeight = wanted;
  mainWindow.setSize(width, wanted, false);
});

// Takes a file to reveal, and honours it only when the file really is in the
// cache. The button that calls this passes whatever is loaded, and a clip
// dragged in from the desktop is not a cached file at all: revealing it opened
// the desktop under a button that says cache, which read as the cache having
// moved somewhere else. Compared without case, as Windows does.
ipcMain.handle('shell:openCacheFolder', (_event, reveal) => {
  const dir = toolPaths.cacheDir();
  const file = reveal ? path.resolve(String(reveal)) : '';
  if (file && path.dirname(file).toLowerCase() === dir.toLowerCase()) {
    shell.showItemInFolder(file);
    return '';
  }
  return shell.openPath(dir);
});

// Hands the file to whatever Windows opens that type with. openPath resolves to
// an empty string on success and to the reason on failure, which is how a
// missing default program or a file that has since been moved comes back.
ipcMain.handle('shell:openFile', async (_event, filePath) => {
  const error = await shell.openPath(String(filePath || ''));
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle('clipboard:readText', () => clipboard.readText());

ipcMain.handle('shell:fileUrl', (_event, filePath) => {
  // pathToFileURL escapes spaces, #, % and unicode; hand-building the string
  // silently truncated any path containing a #.
  return pathToFileURL(filePath).href;
});
