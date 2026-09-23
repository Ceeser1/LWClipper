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
const composer = require('./src/composer');
const waveform = require('./src/waveform');
const filmstrip = require('./src/filmstrip');
const projectFile = require('./src/project');
const projectClaim = require('./src/claim');
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

  // Step 21c-2. The split is shared differently when the window is maximized,
  // and only the main process knows that it is. Both events fire after the
  // window has already changed size, so the renderer may well have laid out for
  // the new size before this arrives: what it does with it has to be written
  // for either order.
  const sayState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state',
      { maximized: mainWindow.isMaximized() || mainWindow.isFullScreen() });
  };
  mainWindow.on('maximize', sayState);
  mainWindow.on('unmaximize', sayState);
  mainWindow.on('enter-full-screen', sayState);
  mainWindow.on('leave-full-screen', sayState);

  // Step 13. Closing with unsaved work asks first. Only the renderer knows
  // whether there is any, so the close is held, the question is sent across,
  // and closeAllowed is what comes back: set once and the next close goes
  // straight through, which is what stops this from being a loop.
  mainWindow.on('close', (evt) => {
    if (closeAllowed || !mainWindow || mainWindow.isDestroyed()) return;
    evt.preventDefault();
    mainWindow.webContents.send('app:closing');
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Set by the renderer once it has asked about unsaved work, or when there was
// none to ask about. Never reset: a window only closes once.
let closeAllowed = false;

ipcMain.handle('app:allowClose', () => {
  closeAllowed = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  return true;
});

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
  filmstrip.clearStrips();

  // Step 4 of the V2 plan, a throwaway development path. Reached only with
  // --v2-slice on the command line, and the folder it loads is outside the
  // packaged file list, so a shipped build cannot take this branch at all.
  // Goes away with the slice.
  if (process.argv.includes('--v2-slice')) {
    require('./dev/slice').open();
    return;
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Waveforms and filmstrips are worth nothing once the app is closed, so the
// folders go with it rather than growing across sessions.
app.on('will-quit', () => {
  waveform.clearPeaks();
  filmstrip.clearStrips();
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

// Step 18. A clear is no longer everything in the folder. The rule is the
// user's and it lives in src/claim.js: a cached file goes only when every
// project claiming it was ticked. A file nothing claims falls out of the same
// line rather than being a case of its own, and clearing those is what this
// button has always done.
ipcMain.handle('tools:clearCache', (_event, ticked) => {
  const claims = claimsOnDisk();
  const doomed = projectClaim.deletableFiles(claims, ticked, toolPaths.cacheFileNames());
  const freed = toolPaths.clearCache(doomed);
  // After the delete rather than before: a claim is given up only once the
  // files it named are actually gone, so a clear that fails halfway leaves
  // every project still protecting whatever survived it.
  const on = new Set((ticked || []).map((id) => String(id).toLowerCase()));
  for (const entry of claims) {
    if (on.has(entry.id.toLowerCase())) removeClaim(entry.id);
  }
  return freed / 1048576;
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

/**
 * Advanced mode's save: the whole timeline rendered to one file.
 *
 * The composite twin of video:trim above, and it deliberately reads the same:
 * one job token, one progress channel, the same shape of answer. What differs
 * is only what is being encoded.
 *
 * The container comes from the name the dialog produced, exactly as it does for
 * a trim, so typing a different extension into the dialog is what picks the
 * format on both paths rather than only on one.
 */
ipcMain.handle('video:compose', async (_event, { layers, project, trim, destination, compression }) => {
  const token = startJob();
  try {
    const hasVideo = (layers || []).some((l) => l.type === 'video' && l.enabled && l.src);
    const format = containerFor(destination, !hasVideo);
    const sources = composer.sourceSizes(layers || [], trimmer.probeMedia);
    const saved = await composer.render(
      { layers, project, trim, output: destination, format, compression, sources },
      sendProgress, token);
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

// Thumbnails for one timeline clip. Returns the sheet as a path; the renderer
// turns it into a file URL and draws sub-rectangles out of it.
ipcMain.handle('video:filmstrip', async (_event, { filePath, duration, tiles }) => {
  try {
    return { ok: true, data: await filmstrip.stripFor(filePath, duration, tiles) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

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
ipcMain.handle('dialog:saveAs', async (_event, { title, isAudio, format, isProject }) => {
  const chosen = containerFor('x.' + String(format || ''), isAudio);
  const ordered = [chosen, ...outputsFor(isAudio).filter((f) => f !== chosen)];
  const result = await dialog.showSaveDialog(mainWindow, {
    // The same dialog serves both saves, and they are not the same act: one
    // cuts a clip out of a file, the other renders a timeline.
    title: isProject ? 'Export project as' : 'Save clip as',
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
  // A project is not media, and every route that opens a file comes through
  // here: the Open File dialog, the drop zone at the top, and a file dropped on
  // an empty track. Answering it once is what keeps three callers from each
  // having to know what a .lwc is, and it replaces the only thing they used to
  // get, which was ffprobe failing to find a duration in a JSON file.
  if (ext === '.' + PROJECT_EXT) return { ok: false, project: true, path: filePath };
  const { duration, hasAudio, width, height, fps, videoCodec, audioCodec, audioBitrate } =
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
      // Advanced editing seeds the project's frame rate from its first source,
      // the way it already seeds the frame size.
      fps,
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

// ---- the project file ----
//
// Step 13. src/project.js decides what a .lwc says and what to make of one;
// everything here is the parts it refuses to do, which is touching a disk.

// src/project.js owns what a .lwc is, this included: describeMedia above reads
// it too, and two spellings of the same extension is one of them being wrong.
const PROJECT_EXT = projectFile.EXT;

function statOrNull(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

ipcMain.handle('project:saveDialog', async (_event, suggested) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save project',
    defaultPath: suggested || path.join(app.getPath('videos'), 'Project.' + PROJECT_EXT),
    filters: [{ name: 'LWClipper project', extensions: [PROJECT_EXT] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  return { ok: true, path: result.filePath };
});

// ---- claims: which cached downloads a project still wants ----
//
// Step 18. Clear cache deletes what is in the cache folder, and a project that
// references a download is a project whose media that deletes. The cache cannot
// know a project exists, so projects say so: saving or opening one records what
// it wants, and clearing reads the records.
//
// Written on open as well as on save, which is the user's call and the right
// one: opening is when the app first learns a project exists at all. Without it
// every project written before Step 18 would have a gap, with files at risk and
// no row to untick.

const claimFileFor = (id) =>
  path.join(toolPaths.projectsDir(), id + '.' + projectClaim.EXT);

/** Every readable claim, with whether its project is still where it said. */
function claimsOnDisk() {
  const dir = toolPaths.projectsDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // Nothing has ever claimed anything.
  }
  const out = [];
  for (const file of names) {
    if (path.extname(file).toLowerCase() !== '.' + projectClaim.EXT) continue;
    let parsed;
    try {
      parsed = projectClaim.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue; // Unreadable. The app wrote it and can write it again.
    }
    if (!parsed.ok) continue;
    out.push({
      id: path.basename(file, path.extname(file)),
      claim: parsed.claim,
      // The project itself, gone from where it was. Listed rather than swept:
      // a project moved to another drive would otherwise silently lose its
      // protection, and one that is really orphaned is worth saying so about.
      missing: !statOrNull(parsed.claim.project.path),
    });
  }
  return out;
}

function removeClaim(id) {
  try {
    fs.rmSync(claimFileFor(id), { force: true });
  } catch {
    // Already gone, or held open. Nothing here is worth failing a save for.
  }
}

/** Which of these sources are files sitting in the cache folder itself. */
function cacheNamesOf(sources) {
  const dir = toolPaths.cacheDir().toLowerCase();
  const names = [];
  const seen = new Set();
  for (const src of sources || []) {
    if (!src) continue;
    const full = path.resolve(String(src));
    // The same test the reveal button uses, and without case, as Windows does.
    if (path.dirname(full).toLowerCase() !== dir) continue;
    const name = path.basename(full);
    // Once each. A video with sound is two layers over one file, and a warning
    // that names what clearing would take must not name it twice.
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/**
 * Record what this project wants from the cache, or stop recording it.
 *
 * `previous` is who the project was a moment ago, which only the caller knows:
 * a Save As arrives with a new path and a new name, so without it the old claim
 * would be left behind and a second one written beside it. That is the ever
 * growing list the user asked not to have.
 *
 * The claim file is then named after what the project is called **now**, so the
 * folder reads as a list of projects rather than a list of what they used to be
 * called. Nothing reads a claim by its name, so the rename costs nothing:
 * matchFor is what finds one again.
 *
 * A project with nothing cached has its claim removed rather than emptied. An
 * empty claim protects nothing and would sit in the list forever asking to be
 * understood.
 */
function writeClaim(filePath, name, sources, previous) {
  const files = cacheNamesOf(sources);
  const claims = claimsOnDisk();
  const existing = (previous && projectClaim.matchFor(claims, previous))
    || projectClaim.matchFor(claims, { path: filePath, name });
  if (!files.length) {
    if (existing) removeClaim(existing.id);
    return null;
  }
  // Its own id is not taken from itself: a project saved again under the same
  // name keeps its claim rather than becoming a second one with a suffix.
  const taken = claims.filter((c) => !existing || c.id !== existing.id).map((c) => c.id);
  const id = projectClaim.idFor(name, taken);
  try {
    fs.mkdirSync(toolPaths.projectsDir(), { recursive: true });
    fs.writeFileSync(claimFileFor(id), projectClaim.stringify(projectClaim.build({
      name, path: filePath, files, app: app.getVersion(),
    })), 'utf8');
  } catch {
    return null; // Read-only, or a drive that is not there. The save still stands.
  }
  if (existing && existing.id !== id) removeClaim(existing.id);
  return id;
}

/**
 * Write the project.
 *
 * The renderer hands over the state and this side adds what only it can know:
 * a stat per source for the fingerprints, and each source's path relative to
 * wherever the file is going.
 */
ipcMain.handle('project:save', (_event, { filePath, state, previous }) => {
  try {
    const dir = path.dirname(filePath);
    const stats = {};
    const relatives = {};
    for (const layer of state.layers || []) {
      if (!layer.src || stats[layer.src] !== undefined) continue;
      stats[layer.src] = statOrNull(layer.src);
      const rel = projectFile.relativePath(dir, layer.src, path);
      if (rel) relatives[layer.src] = rel;
    }
    const doc = projectFile.serialise(state, {
      stats, relatives, app: app.getVersion(),
      // Step 18. The file records what it is called, so that a claim in the
      // cache can still find it after it is renamed from outside the app.
      name: path.basename(filePath, '.' + PROJECT_EXT),
    });
    fs.writeFileSync(filePath, projectFile.stringify(doc), 'utf8');
    const name = path.basename(filePath, '.' + PROJECT_EXT);
    // After the write, not before: a claim for a project that failed to save is
    // a claim for a file that does not exist.
    writeClaim(filePath, name, (state.layers || []).map((l) => l.src), previous);
    return { ok: true, path: filePath, name };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('project:openDialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open project',
    properties: ['openFile'],
    filters: [
      { name: 'LWClipper project', extensions: [PROJECT_EXT] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
  return openProject(result.filePaths[0]);
});

/**
 * Read a project and work out where each of its files actually is.
 *
 * Every reference is resolved here rather than in the renderer, because
 * deciding it needs a stat per candidate path and the renderer is sandboxed
 * with no filesystem at all. What comes back is the document plus one verdict
 * per layer, which is exactly what the missing-files modal is a picture of.
 */
function openProject(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, error: 'unreadable', detail: String(err && err.message) };
  }
  const parsed = projectFile.parse(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, version: parsed.version };

  const dir = path.dirname(filePath);
  const statuses = {};
  for (const layer of parsed.doc.layers) {
    const ref = layer.ref || (layer.src ? { path: layer.src } : null);
    if (!ref) continue;
    const found = projectFile.candidatesFor(ref, dir, path.join)
      .map((p) => ({ path: p, stat: statOrNull(p) }));
    statuses[layer.id] = projectFile.statusFor(ref, found);
  }
  const name = path.basename(filePath, '.' + PROJECT_EXT);
  // Opening is when the app learns this project exists, so it claims here too.
  // The identity to match on is what the file says it was last called, which is
  // what catches a .lwc renamed from outside the app: the claim still carries
  // that name and the two agree without ever having met.
  writeClaim(filePath, name,
    parsed.doc.layers.map((l) => (statuses[l.id] && statuses[l.id].path) || l.src),
    { path: filePath, name: parsed.meta.name });
  return {
    ok: true,
    path: filePath,
    name,
    doc: parsed.doc,
    meta: parsed.meta,
    statuses,
  };
}

ipcMain.handle('project:open', (_event, filePath) => openProject(filePath));

// The facts only this side can take: every claim on disk, and the size of
// every file in the cache. The rows and the totals are worked out in the
// window, through the same src/claim.js this side uses, so the rule that says
// what a tick would free is written once and read from both ends of the bridge.
ipcMain.handle('tools:claims', () => {
  const dir = toolPaths.cacheDir();
  const sizes = {};
  for (const f of toolPaths.cacheFileNames()) {
    try {
      sizes[f] = fs.statSync(path.join(dir, f)).size;
    } catch {
      // Gone since the listing. It counts as nothing, which it now is.
    }
  }
  return { claims: claimsOnDisk(), sizes };
});

// Which of the sources the window has open are downloads sitting in the cache,
// by the same test the claim writer uses. A warning about what clearing takes
// is only right if it asks the question the deletion asks.
ipcMain.handle('tools:cacheNames', (_event, sources) => cacheNamesOf(sources));

ipcMain.handle('dialog:openMedia', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load a cached or local file',
    defaultPath: toolPaths.cacheDir(),
    properties: ['openFile'],
    // Projects are in the first filter rather than only in one of their own, so
    // a .lwc is visible without anyone having to know to change the dropdown
    // first. This is the design's original ask, which Step 13 deviated from
    // because the timeline header buttons had just been built; a file the app
    // can open should be openable from the button that says Open File.
    filters: [
      {
        name: 'Audio, video and projects',
        extensions: [...VIDEO_EXTS, ...AUDIO_EXTS].map((e) => e.slice(1)).concat([PROJECT_EXT]),
      },
      { name: 'LWClipper project', extensions: [PROJECT_EXT] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
  return describeMedia(result.filePaths[0]);
});

ipcMain.handle('window:isMaximized', () =>
  !!(mainWindow && !mainWindow.isDestroyed()
    && (mainWindow.isMaximized() || mainWindow.isFullScreen())));

// Step 21c. The splitter takes the height into the user's hands without
// resizing the window, so the resize listener above cannot see it happen and
// the renderer has to say so. Same switch, same one-way trip: the fit is off
// for the rest of the run.
ipcMain.handle('window:release', () => {
  autoHeight = false;
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
