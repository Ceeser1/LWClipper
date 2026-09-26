# LWClipper

A lightweight clipper for local video and audio files and for links, built on
Electron. Paste a link or open a file, trim it, crop it, replace or adjust its
audio, and save it as MP4, WebM, MOV, MP3, WAV, OGG, AAC or FLAC.

Switch on **Use advanced Editing** in the settings and the same window becomes a
small multi-track editor instead: several video and audio layers on one
timeline, each trimmed, moved, cropped and mixed on its own, composited into one
file. A project is saved as a `.lwc` file, which holds the arrangement and
references the media rather than copying it.

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

## Building

```
npm run dist
```

Runs electron-builder into `dist/win-unpacked`, then wraps it with
`scripts/build-launcher.js` into `dist/LWClipper <version>.exe`, a single file of
about 200MB that needs no installer. It unpacks itself once into
`%LOCALAPPDATA%\LWClipper\runtime-<version>` and reuses that afterwards, which is
what makes the first launch about 5 seconds and every one after it about half a
second. A splash covers the first wait; redraw it with `npm run splash` if the
icon or the wording ever change.

## Layout

- `main.js` owns every `ipcMain` route: downloads, encoding, dialogs, settings.
- `preload.js` exposes `window.lwclipper` across the context bridge. The
  renderer runs sandboxed with no Node.
- `renderer/` is the window. Its code is `renderer/app/`, one plain script per
  part of it, loaded in the order `index.html` lists them; generated media
  (text, bars) has its own folder, `renderer/app/gen/`.
- `src/` is the work: `ytdlp.js` fetches, `trimmer.js` builds the ffmpeg argv,
  `backend.js` holds the format table every encoder decision reads from,
  `waveform.js` renders the audio peaks, `toolPaths.js` locates everything.
- Advanced editing adds its own half of `src/`, none of which touches the DOM so
  that all of it can be tested under plain `node --test`: `timeline.js` is the
  layer model, `geometry.js` places a layer in the output frame, `composer.js`
  turns both into an ffmpeg filter graph, `history.js` is the undo stack,
  `project.js` reads and writes `.lwc`, `filmstrip.js` extracts clip thumbnails
  and `progress.js` reads ffmpeg's own progress blocks for the bar and the ETA.
  `renderer/timelineView.js` is the zoom and scroll arithmetic, and the only one
  of them that lives with the window.
- `locales/` holds the translations. English text is the key, so an untranslated
  string falls through to English rather than to a blank.
