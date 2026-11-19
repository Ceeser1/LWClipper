# The preview against export harness

LWClipper draws every picture twice: the preview draws it in the window, and
the export has ffmpeg draw it again into the file. The two must agree. The unit
tests (`npm test`) cannot see that, since they never start the app or ffmpeg.
This does: it starts the app from this folder's source, builds projects in its
window, exports them for real and compares the preview's frames with the
file's.

Nothing here ships. It is not in `package.json` `files`.

## Running it

```
node dev/harness/media.js             once: makes the test clips into dev/harness/work
node dev/harness/instance.js start    starts the test instance (its own profile and cache)
node dev/harness/run.js all           every suite, about ten minutes
node dev/harness/run.js colour        one suite
node dev/harness/run.js vfx sepia     the cases of a suite whose name matches
node dev/harness/instance.js stop
```

The test instance has its own profile, cache and log under `dev/harness/work`,
so an installed LWClipper, its settings and its downloads are never touched.
Only an instance on the harness's port (9442) is ever stopped.

A change under `src/` or to `main.js` needs the instance started again: the
export runs in the main process, and a page reload keeps the old one.

## Reading a line

```
ok     sepia                    328ms  30: 4.09 [1.27] 4.01
```

Frame 30 of the case: the preview's frame against the file's frame 29, its own
frame 30 (in brackets) and frame 31, as the mean difference of 255 over the
whole picture. The frame's own number should be the smallest of the three and
near what the codec alone costs, 0.5 to 2. A neighbour matching better means
the picture is a frame early or late. `high` marks a frame that is further off
than that by itself; kinds with fine patterns (grain, scan lines) read so and
are judged by `golden.json` instead.

## golden.json

For every frame of every case: how far apart preview and export were, and a
small picture of the export's frame (16 by 9 mean colours). A run compares
with it and says `MOVED` where either changed by more than 0.4 of 255 (or 3 on
any one of the small picture's cells), and `new` for a case it has no record
of. The run ends with an error when anything moved.

After a change that was meant to change a picture, look at what moved, and
then write the new state:

```
node dev/harness/run.js <suite> --update
```

It is the record to run against after anything that could move pictures
without meaning to: a new Electron (the preview is Chromium's drawing), a new
ffmpeg, a change to `composer.js`, `vfxOps.js` or the compositor.

## The suites

| Suite | What it covers | Source |
| --- | --- | --- |
| `vfx` | every kind of VFX from 5.0 and 5.1, in the ways each can be set | `src709.mp4` |
| `long` | six seconds of 1080p with sound and many VFX at once | `long1080.mp4` |
| `warps` | Corner Pin, Polar Coordinates, Vibrance, Halftone | `src709.mp4` |
| `curves` | Curves, Apply LUT with `.3dl` files | `src709.mp4` |
| `keys` | Chroma Key, Luma Key | `green.mp4` |
| `strobe` | Strobe | `src709.mp4` |
| `echo` | Echo | `moving.mp4` |
| `gravity` | Gravity | `g709.mp4` |
| `colour` | every way a file can say its colours, or not say them: BT.709, BT.601, unnamed, full range, VP9, 10 bit, HDR in HLG and PQ | `colour/*` |

A case is `[name, list of VFX, frames to compare, extra layer settings]`, in
`cases/<suite>.js`. A new kind of VFX gets its cases there.

## The files

- `lib.js`: where things are, and the suites.
- `instance.js`: starts and stops the test instance.
- `media.js`: makes the test clips with the bundled ffmpeg.
- `cdp.js`: a small client for the instance's debugging port.
- `page.js`: what runs inside the app's window: build the project, export it, compare.
- `run.js`: the runner, and the comparison with `golden.json`.
- `cases/`: the lists.
- `work/`: everything made. Not in git; delete it freely.

## What it cannot see

The harness reads the preview's canvas and the file's frames. It does not
check what the window looks like, sound, or anything a person does with the
mouse. Colours are compared as the app's Chromium shows a frame on a canvas,
which is what the preview is; another player may show an exported file a
little differently.
