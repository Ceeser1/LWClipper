# LWClipper

A lightweight clipper for local video and audio files and for links, built on
Electron. Paste a link or open a file, trim it, crop it, replace or adjust its
audio, and save it as MP4, WebM, MOV, MP3, WAV, OGG, AAC or FLAC.

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
- `renderer/` is the window. `app.js` is the bulk of it.
- `src/` is the work: `ytdlp.js` fetches, `trimmer.js` builds the ffmpeg argv,
  `backend.js` holds the format table every encoder decision reads from,
  `waveform.js` renders the audio peaks, `toolPaths.js` locates everything.
- `locales/` holds the translations. English text is the key, so an untranslated
  string falls through to English rather than to a blank.
