# LWClipper

A lightweight clipper for local video and audio files and for links, built on
Electron. Paste a link or open a file, trim it, crop it, replace or adjust its
audio, and save it as MP4, WebM, MOV, MP3, WAV, OGG, AAC or FLAC.

It opens in advanced editing, with the window maximized: a small multi-track
editor, several video and audio layers on one timeline, each trimmed, moved,
cropped and mixed on its own, composited into one file. A project is saved as a
`.lwc` file, which holds the arrangement and references the media rather than
copying it. Every three minutes the open project is also auto-saved, the last
five copies kept in `%LOCALAPPDATA%\LWClipper\data\autosave`, and after a crash
the next start offers to restore it.

Switch off **Use advanced Editing** in the settings and the same window is the
simple one-clip trimmer instead. The app opens in whichever of the two it was
left in.

Windows only. The interface is in English and German.

## The three tools are not in this repo

`ffmpeg.exe` and `ffprobe.exe` are about 102MB each, over GitHub's 100MB
per-file limit, so `tools/` is excluded. Nothing runs without them.

Put the Windows builds of all three here:

```
tools/
  ffmpeg.exe
  ffprobe.exe
  yt-dlp.exe
```

They are found at run time by `src/toolPaths.js`, which falls back to whatever is
on `PATH` if the folder is empty, so a system install works for development. A
built `.exe` carries its own copies and never looks at `PATH`.

## Running it

```
npm install
npm start
```

## Tests

```
npm test
```

No network, no ffmpeg, nothing on disk beyond temp folders the tests make and
clean up themselves. There is also a translation check, which reports any string
in the app with no entry in `locales/`, and any entry no longer used:

```
node scripts/check-locales.js
```

Whether the preview and the exported file show the same picture is checked by
starting the app and exporting for real, which `npm test` does not do. That is
`dev/harness`, with its own README: run it after a change to how anything is
drawn or exported, and after a new Electron or ffmpeg.

## Building

```
npm run dist
```

Produces `dist/LWClipper v<version>.exe`, the one file to hand out. Its first
start asks how LWClipper should run:

- **Install LWClipper** runs the installer it carries,
  `LWClipper v<version> Setup.exe`. That asks for administrator rights,
  installs into `C:\Program Files\LWClipper` unless another folder is picked,
  adds Start menu and desktop shortcuts and an uninstaller, and registers `.lwc`
  so a double-click on a project opens it in LWClipper. The registration is
  `build.win.fileAssociations` in `package.json` plus `scripts/installer.nsh`.
- **Run without installing** installs nothing and registers nothing. It unpacks
  the app once into `%LOCALAPPDATA%\LWClipper\runtime-<version>` and reuses
  that afterwards, which is what makes the first launch about 5 seconds and
  every one after it about half a second. A splash covers the wait; redraw it
  with `npm run splash` if the icon or the wording ever change. It opens a
  `.lwc` project through Open Project, by a drop on the window, or when the
  file is named on its command line.

The question comes once per version: after "Run without installing" every start
goes straight to the app, and a start that is handed a file to open never asks.
After "Install" the same file asks again, so it can also reinstall. The window
is in German when Windows is, otherwise in English.

How it is put together: electron-builder writes the app into `dist/win-unpacked`
and the installer beside it (`LWClipper v<version> Setup.exe`, which stays in
`dist` and works on its own too), then `scripts/build-launcher.js` wraps both
into the one file with `scripts/launcher.nsi`. That makes it about 350MB, since
the installer and the stand-alone payload each carry a copy of the app.

Both ways keep their settings in the same place, so they are one app: starting
one while the other is open brings the open window forward.

## Layout

- `main.js` owns every `ipcMain` route: downloads, encoding, dialogs, settings.
- `preload.js` exposes `window.lwclipper` across the context bridge. The
  renderer runs sandboxed with no Node.
- `renderer/` is the window. Its code is `renderer/app/`, one plain script per
  part of it, loaded in the order `index.html` lists them; generated media
  (text, bars) has its own folder, `renderer/app/gen/`.
- `src/` is the work: `ytdlp.js` fetches, `trimmer.js` builds the ffmpeg argv,
  `backend.js` holds the format table every encoder decision reads from,
  `waveform.js` renders the audio peaks, `toolPaths.js` locates everything,
  `log.js` writes the app's log and `ytdlpUpdate.js` keeps a newer yt-dlp.
- Advanced editing adds its own half of `src/`, none of which touches the DOM so
  that all of it can be tested under plain `node --test`: `timeline.js` is the
  layer model, `geometry.js` places a layer in the output frame, `composer.js`
  turns both into an ffmpeg filter graph, `colorSpace.js` says what a file's
  colours mean so the export reads them as the preview does, `history.js` is
  the undo stack,
  `project.js` reads and writes `.lwc`, `autosave.js` decides which auto-saves
  to keep and which runs crashed, `filmstrip.js` extracts clip thumbnails
  and `progress.js` reads ffmpeg's own progress blocks for the bar and the ETA.
  `renderer/timelineView.js` is the zoom and scroll arithmetic, and the only one
  of them that lives with the window.
- `locales/` holds the translations. English text is the key, so an untranslated
  string falls through to English rather than to a blank.
