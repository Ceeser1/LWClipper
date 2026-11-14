'use strict';

// Saving a clip and exporting a project.

// The frame size may only be known once the element has metadata, which is
// where a file with no usable probe behind it gets its dimensions from.
previewVideo.addEventListener('loadedmetadata', () => {
  updateCropBtn();
  updateCropOverlays();
});

// Longest name kept before it gets elided. The suffix and extension are always
// shown in full, since they are what tells you which file this actually is.
const NOTICE_NAME_MAX = 32;

// Quick-save names are `<title>_clipped.mp4`, and a collision adds ` (2)`. Both
// are worth keeping whole, so they are peeled off before the length limit hits
// the part the user actually chose.
const CLIPPED_SUFFIX_RE = /(_clipped(?: \(\d+\))?)$/;

function shortenFileName(file) {
  const dot = file.lastIndexOf('.');
  const ext = dot > 0 ? file.slice(dot) : '';
  const stem = dot > 0 ? file.slice(0, dot) : file;

  const match = CLIPPED_SUFFIX_RE.exec(stem);
  const suffix = match ? match[1] : '';
  const name = suffix ? stem.slice(0, -suffix.length) : stem;

  if (name.length <= NOTICE_NAME_MAX) return file;
  return name.slice(0, NOTICE_NAME_MAX) + '...' + suffix + ext;
}

// The status line carries the full path; this is the at-a-glance confirmation,
// so it names the file and the folder it landed in rather than the whole path.
// Splitting on both separators keeps it correct whichever way ffmpeg echoed it.
// Remembered so Open has something to act on: the click that presses it also
// dismisses the notice, so the path cannot be read back off the overlay.
let lastSavedPath = null;

function showSaveNotice(fullPath) {
  lastSavedPath = fullPath;
  const parts = fullPath.split(/[\\/]/).filter(Boolean);
  const file = shortenFileName(parts.pop());
  const folder = parts.pop();
  saveNoticeText.textContent = folder
    ? t('Saved as "{file}" to {folder}', { file, folder })
    : t('Saved as "{file}"', { file });
  saveNotice.hidden = false;
}

// Hands the file to whatever Windows opens that type with. The document
// listener further down hides the overlay during the capture phase of this very
// click, which is why the path is held above rather than read from the notice.
openSavedBtn.addEventListener('click', async () => {
  if (!lastSavedPath) return;
  const result = await window.lwclipper.openFile(lastSavedPath);
  if (result && result.ok === false) {
    setStatus('Could not open that file: {error}', { error: result.error });
  }
});

// Both buttons run the identical trim; they only differ in how the destination
// was chosen, so the range and the accuracy flag are read here, once.
async function saveClipTo(destination) {
  const start = slider.start;
  const end = slider.end;
  const accurate = accurateToggle.checked;
  const compression = compressionPercent();
  const audio = {
    enabled: audioEnabledToggle.checked,
    replacePath: audioTrack ? audioTrack.path : null,
    offset: audioOffset,
    volume: volumePercent(),
  };
  // The frame it was measured against travels with it: a crop means nothing
  // without one, and since 21e the rectangle is not inside the picture in the
  // first place. It is what the main process splits the rectangle against, into
  // the part of the picture the frame covers and the room around it.
  const size = sourceSize();
  const crop = (cropRect && size)
    ? { ...cropRect, sourceWidth: size.w, sourceHeight: size.h }
    : null;

  await runJob(async () => {
    const result = await window.lwclipper.trim(
      media, destination, start, end, accurate, compression, audio, crop,
      { enabled: videoEnabledToggle.checked });
    if (!result.ok) {
      reportFailure(result);
      return;
    }
    setStatus('Saved to {path}', { path: result.data });
    showSaveNotice(result.data);
  });
}

/**
 * What to call the exported file before anyone has said.
 *
 * The project's own name once it has one, because that is what the user already
 * decided to call this arrangement. Before that, the top layer's name, which is
 * the clip the export is mostly of. The main process sanitises whichever it
 * gets and puts the extension on.
 */
function exportName() {
  if (projectTitle) return projectTitle;
  const first = layers.find((l) => l.name);
  if (!first) return 'Project';
  // A layer is usually named without one already, since describeMedia strips
  // it. This is for the path fallback, so "clip.mp4" does not come back as
  // "clip.mp4.mp4" once the dialog adds the extension.
  return first.name.replace(/\.[A-Za-z0-9]{2,4}$/, '') || first.name;
}

/**
 * V3. The layers as the export gets them: every generated one pointed at the
 * PNG of its picture, at the project's size, which from there on is an image
 * layer covering the frame, and every other one as it is.
 *
 * The picture is the very canvas the preview draws, brought up to date first,
 * with its fonts waited for, so the file shows what the preview did. It is only
 * encoded when the cache does not already hold it.
 *
 * Answers in the shape a job does, so a picture that could not be saved is
 * reported the way a failed encode is.
 */
/**
 * V3.3. A generated layer that moves between keyframes, drawn frame by frame
 * at the project's rate for the stretch where it changes, through genAt and
 * drawGen like the preview. Each frame is the moment at its start, the moment
 * the preview shows when the playhead stands on that frame.
 *
 * Cached like the single PNGs, by everything the frames depend on, so a second
 * export of the same project draws nothing.
 */
//
// V4.10. And one going through a transition, any of them, for the stretch of
// each: a generated picture is a canvas, so genDraw draws the transition
// itself (drawGenTransition, the preview's own drawing) and the encoder is
// handed the result. `spans` are the stretches drawn, as frames.
async function exportGenFrames(l, spans, frame) {
  const fps = Number(frame.fps) || 30;
  const runs = frameRuns(spans);
  const key = JSON.stringify(['frames', l.gen, l.keyframes, l.duration, fps, frame.width, frame.height, runs,
    transitionKey(l)]);
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const ctx = canvas.getContext('2d');
  // The picture itself, drawn again only when it is another picture.
  const own = new OffscreenCanvas(frame.width, frame.height);
  const ownCtx = own.getContext('2d');
  let ownKey = null;
  const wrote = await writeFrameRuns(key, runs, async (i) => {
    const t = i / fps;
    const gen = genDraw.genAt(l, t, frame.width, frame.height);
    const genKey = genDraw.keyOf(gen, frame.width, frame.height);
    if (genKey !== ownKey) {
      genDraw.drawGen(ownCtx, gen, frame.width, frame.height);
      ownKey = genKey;
    }
    const going = timelineModel.transitionAt(l, l.start + t);
    ctx.clearRect(0, 0, frame.width, frame.height);
    if (!going) ctx.drawImage(own, 0, 0);
    else if (!(going.half === 'in' && going.e <= 0)) {
      genDraw.drawGenTransition(ctx, own, going, genDraw.transitionBox(gen, frame.width, frame.height),
        frame.width, frame.height);
    }
    return canvasPng(canvas);
  });
  if (!wrote.ok) return wrote;
  return { ok: true, frames: { pattern: wrote.pattern, ...frameHolds(runs, l.duration, fps) } };
}

// ---- V4.10. Frames drawn for parts of a clip ----
//
// A moving mask, a moving generated picture and now a transition are each
// drawn frame by frame, but only where they change: before, between and
// after, the encoder holds a frame (composer.js holdFrames). With a
// transition at each end of a clip that is two stretches with the whole
// middle between them, so the stretches are a list.

/** A canvas as a PNG's bytes, or null. */
async function canvasPng(canvas) {
  const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

/** Stretches of frames, each [first, last], in order and run together where they meet. */
function frameRuns(spans) {
  const sorted = spans.filter((r) => r && r[1] >= r[0]).map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const runs = [];
  for (const r of sorted) {
    const last = runs[runs.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else runs.push(r);
  }
  return runs;
}

/** The stretch of frames a part of the clip covers, from `from` to `to` in its own seconds. */
function frameSpan(l, fps, from, to) {
  const total = Math.max(1, Math.round(l.duration * fps));
  const first = Math.min(total - 1, Math.max(0, Math.floor(from * fps)));
  const last = Math.min(total - 1, Math.max(first, Math.ceil(to * fps)));
  return [first, last];
}

/**
 * How the encoder holds the frames of `runs` for the rest of the clip: the
 * first for `lead` seconds before them, the last for `tail` after, and
 * between two runs the last frame of the earlier one for the frames missing.
 */
function frameHolds(runs, duration, fps) {
  const gaps = [];
  let drawn = 0;
  for (let i = 0; i < runs.length; i += 1) {
    if (i) gaps.push({ after: drawn, frames: runs[i][0] - runs[i - 1][1] - 1 });
    drawn += runs[i][1] - runs[i][0] + 1;
  }
  const holds = {
    lead: runs[0][0] / fps,
    tail: Math.max(0, duration - (runs[runs.length - 1][1] + 1) / fps),
  };
  return gaps.length ? { ...holds, gaps } : holds;
}

/**
 * The frames of `runs` written under `key`, numbered on from 0 through every
 * run, each drawn by `draw(i)`, which hands back a PNG's bytes for the clip's
 * frame i. Nothing is drawn when the cache already holds them.
 */
async function writeFrameRuns(key, runs, draw) {
  const begun = await window.lwclipper.genFrames(key, { start: true });
  if (!begun.ok) return { ok: false, error: begun.error || 'no folder for the frames' };
  if (!begun.have) {
    let n = 0;
    for (const [first, last] of runs) {
      for (let i = first; i <= last; i += 1) {
        const bytes = await draw(i);
        if (!bytes) return { ok: false, error: 'canvas toBlob gave no PNG' };
        const wrote = await window.lwclipper.genFrame(key, n, bytes);
        if (!wrote.ok) return { ok: false, error: wrote.error };
        n += 1;
      }
    }
    const done = await window.lwclipper.genFrames(key, { finish: true });
    if (!done.ok) return { ok: false, error: done.error };
  }
  return { ok: true, pattern: begun.dir.replace(/\\/g, '/') + '/%05d.png' };
}

/** Everything about a layer's two fades a drawn transition depends on. */
function transitionKey(l) {
  const fades = timelineModel.fadesOf(l);
  return [fades, timelineModel.fadeCurvesOf(l), timelineModel.transitionsOf(l)];
}

/**
 * The stretches of a clip its transitions are drawn over, as frames: each
 * end's, where `counts(transition)` says that one is drawn.
 */
function transitionSpans(l, fps, counts) {
  const fades = timelineModel.fadesOf(l);
  const tr = timelineModel.transitionsOf(l);
  const spans = [];
  if (tr.in && fades.in > 0 && counts(tr.in)) spans.push(frameSpan(l, fps, 0, fades.in));
  if (tr.out && fades.out > 0 && counts(tr.out)) spans.push(frameSpan(l, fps, l.duration - fades.out, l.duration));
  return spans;
}

/** Whether a file's picture is cut by a transition's matte at either end. */
function hasTransitionMatte(l) {
  return transitionSpans(l, 30, (t) => !timelineModel.transitionMoves(t)).length > 0;
}

/**
 * V3.6. A masked picture's mask for the export, drawn by drawMask like the
 * preview's, white where the picture shows on black: at the size the picture
 * is placed at, or the largest it gets when it moves, since composer.js scales
 * it to the picture on every frame. One PNG when the mask holds still on the
 * picture, which it does even while the picture moves; the frames of its own
 * change when its keyframes move it. Cached like a generated layer's.
 *
 * V4.10. A transition that cuts the picture is cut into this: where the mask
 * shows the picture and the transition's matte does, over the frames of the
 * transition, so the encoder takes the two as the one alpha it already knows
 * how to take. A picture with no mask of its own has the matte alone, on
 * white. And a mask on a picture that slides is drawn as the part of it the
 * slide is showing, since the encoder fits what it is handed to that part.
 */
async function exportMask(l, frame) {
  const source = layerSource(l);
  if (!source) return { ok: true, file: null };
  const steps = timelineModel.transitionSteps(l);
  const shown = steps.length ? layerGeometry.shownKeys(l, source, frame, steps) : null;
  const motion = shown || layerGeometry.motionOf(l, source, frame);
  const still = layerGeometry.placementAt(l, 0, source, frame);
  const dests = motion ? motion.map((k) => k.dest) : (still ? [still.dest] : []);
  if (!dests.length) return { ok: true, file: null };
  const side = (v) => Math.max(2, Math.min(GEN_SURFACE_MAX, Math.round(v)));
  const w = side(Math.max(...dests.map((d) => d.width)));
  const h = side(Math.max(...dests.map((d) => d.height)));
  let picture = null;
  let pictureSize = null;
  if (l.mask && l.mask.kind === 'custom') {
    try {
      picture = await loadMaskPicture(l.mask);
      pictureSize = [picture.width, picture.height];
    } catch {
      return { ok: false, error: 'The mask picture ' + l.mask.src + ' could not be read.' };
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const ink = new OffscreenCanvas(w, h).getContext('2d');
  const matte = new OffscreenCanvas(w, h).getContext('2d');
  const draw = (t) => {
    ink.setTransform(1, 0, 0, 1, 0, 0);
    ink.globalCompositeOperation = 'source-over';
    // The part of the picture a slide is showing at this moment, if any.
    const win = shown && l.mask ? layerGeometry.shownPlacementAt(shown, t).window : null;
    if (!l.mask) {
      ink.fillStyle = '#fff';
      ink.fillRect(0, 0, w, h);
    } else if (win && win.w > 0 && win.h > 0) {
      ink.clearRect(0, 0, w, h);
      const W = w / win.w;
      const H = h / win.h;
      ink.setTransform(1, 0, 0, 1, -win.x * W, -win.y * H);
      genDraw.drawMask(ink, timelineModel.maskAt(l, t), W, H, picture);
      ink.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      genDraw.drawMask(ink, timelineModel.maskAt(l, t), w, h, picture);
    }
    const going = timelineModel.transitionAt(l, l.start + t);
    if (going && !timelineModel.transitionMoves(going.transition)) {
      matte.clearRect(0, 0, w, h);
      genDraw.drawTransitionMatte(matte, going.transition, going.e, w, h);
      ink.globalCompositeOperation = going.half === 'in' ? 'destination-in' : 'destination-out';
      ink.drawImage(matte.canvas, 0, 0);
      ink.globalCompositeOperation = 'source-over';
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(ink.canvas, 0, 0);
  };
  const fps = Number(frame.fps) || 30;
  const moving = l.mask ? timelineModel.maskMotion(l) : null;
  // A matte at either end, and a slide's part of a mask, are drawn frame by
  // frame like a mask that moves.
  const runs = frameRuns([
    ...(moving ? [frameSpan(l, fps, moving.from, moving.to)] : []),
    ...transitionSpans(l, fps, (t) => !timelineModel.transitionMoves(t) || (!!l.mask && t.kind === 'slide')),
  ]);
  if (!runs.length) {
    if (!l.mask) return { ok: true, file: null };
    const key = JSON.stringify(['mask', timelineModel.maskAt(l, 0), w, h, pictureSize]);
    let saved = await window.lwclipper.genImage(key, null);
    if (saved.ok && !saved.path) {
      draw(0);
      const bytes = await canvasPng(canvas);
      if (!bytes) return { ok: false, error: 'canvas toBlob gave no PNG' };
      saved = await window.lwclipper.genImage(key, bytes);
    }
    if (!saved.ok || !saved.path) return { ok: false, error: saved.error || 'no PNG path' };
    return { ok: true, file: { src: saved.path } };
  }
  const key = JSON.stringify(['maskframes', l.mask, timelineModel.keyframesFor(l).map((k) => [k.t, k.mask]),
    l.duration, fps, w, h, runs, pictureSize, transitionKey(l)]);
  const wrote = await writeFrameRuns(key, runs, async (i) => {
    draw(i / fps);
    return canvasPng(canvas);
  });
  if (!wrote.ok) return wrote;
  return { ok: true, file: { frames: { pattern: wrote.pattern, ...frameHolds(runs, l.duration, fps) } } };
}

/**
 * V4.7. A layer's Obscure and Pixelate for the encoder, in the order they are
 * laid on: for each, the part of the source picture it touches, where it acts
 * in that part as a PNG, white on black, and the figure its filter takes.
 * Only that part is filtered, so a face in a 4K frame costs a face's worth.
 * Cached by what it shows, like a mask.
 *
 * V4.8. One whose areas move between keyframes of their own goes as the
 * frames of the stretch where they do, at the project's rate, each the moment
 * at its start as the preview shows it, the way a moving mask goes. The part
 * filtered is then every part it touches over that stretch, one rectangle for
 * the whole clip, since the encoder's crop is fixed.
 */
async function exportCovers(l, frame) {
  const source = layerSource(l);
  const files = [];
  if (!source) return { ok: true, files };
  const W = Math.round(source.width);
  const H = Math.round(source.height);
  const fps = Number(frame && frame.fps) || 30;
  for (const { kind, cover: whole } of timelineModel.coverList(l)) {
    const sigma = timelineModel.obscureSigma(whole.strength, H);
    const block = timelineModel.pixelateBlock(whole.strength, H);
    const room = kind === 'obscure' ? { margin: Math.ceil(sigma * 3), grid: 2 } : { margin: 0, grid: block };
    // The frames it changes over, or the one it is the whole clip long.
    const moving = timelineModel.coverMotion(l, whole);
    const total = Math.max(1, Math.round(l.duration * fps));
    const first = moving ? Math.min(total - 1, Math.max(0, Math.floor(moving.from * fps))) : 0;
    const last = moving ? Math.min(total - 1, Math.max(first, Math.ceil(moving.to * fps))) : 0;
    const at = (i) => timelineModel.coverAt(whole, i / fps);
    let region = null;
    for (let i = first; i <= last; i += 1) {
      region = genDraw.coverRegionUnion(region, genDraw.coverRegion(at(i), W, H, room));
    }
    if (!region) continue;
    // A picture held to the size every drawn surface is; the encoder scales
    // it back to the region.
    const k = Math.min(1, GEN_SURFACE_MAX / Math.max(region.width, region.height));
    const w = Math.max(2, Math.round(region.width * k));
    const h = Math.max(2, Math.round(region.height * k));
    const ink = new OffscreenCanvas(w, h).getContext('2d');
    ink.setTransform(k, 0, 0, k, -region.x * k, -region.y * k);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    // Where `cover` acts in the region, white on black, as a PNG's bytes.
    const png = async (cover) => {
      genDraw.drawCoverMask(ink, cover, W, H);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(ink.canvas, 0, 0);
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    };
    if (!moving) {
      const cover = at(0);
      const key = JSON.stringify(['cover', cover.areas, cover.soft, cover.invert, W, H, region, w, h]);
      let saved = await window.lwclipper.genImage(key, null);
      if (saved.ok && !saved.path) {
        const bytes = await png(cover);
        if (!bytes) return { ok: false, error: 'canvas toBlob gave no PNG' };
        saved = await window.lwclipper.genImage(key, bytes);
      }
      if (!saved.ok || !saved.path) return { ok: false, error: saved.error || 'no PNG path' };
      files.push({ kind, src: saved.path, region, sigma, block });
      continue;
    }
    const key = JSON.stringify(['coverframes', whole.areas, whole.soft, whole.invert, W, H, region, w, h,
      l.duration, fps, first, last]);
    const begun = await window.lwclipper.genFrames(key, { start: true });
    if (!begun.ok) return { ok: false, error: begun.error || 'no folder for the frames' };
    if (!begun.have) {
      for (let i = first; i <= last; i += 1) {
        const bytes = await png(at(i));
        if (!bytes) return { ok: false, error: 'canvas toBlob gave no PNG' };
        const wrote = await window.lwclipper.genFrame(key, i - first, bytes);
        if (!wrote.ok) return { ok: false, error: wrote.error };
      }
      const done = await window.lwclipper.genFrames(key, { finish: true });
      if (!done.ok) return { ok: false, error: done.error };
    }
    files.push({
      kind,
      region,
      sigma,
      block,
      frames: {
        pattern: begun.dir.replace(/\\/g, '/') + '/%05d.png',
        lead: first / fps,
        tail: Math.max(0, l.duration - (last + 1) / fps),
      },
    });
  }
  return { ok: true, files };
}

async function exportLayers() {
  const frame = projectFrame();
  const out = [];
  for (const l of layers) {
    // V3.6. A masked picture goes with its mask.
    // V4.7. And one with an Obscure or a Pixelate with where each acts.
    // V4.10. And one a transition cuts with the matte of that, which goes
    // the mask's way whether it has a mask or not.
    if (l.kind !== 'gen' && l.enabled && l.type === 'video'
      && (l.mask || timelineModel.coverList(l).length || hasTransitionMatte(l))) {
      let next = l;
      if (l.mask || hasTransitionMatte(l)) {
        const m = await exportMask(l, frame);
        if (!m.ok) return m;
        if (m.file) next = { ...next, maskFile: m.file };
      }
      const c = await exportCovers(l, frame);
      if (!c.ok) return c;
      if (c.files.length) next = { ...next, coverFiles: c.files };
      out.push(next);
      continue;
    }
    if (l.kind !== 'gen' || !l.enabled) {
      out.push(l);
      continue;
    }
    let entry = decoders.get(l.id);
    if (!entry || !entry.gen) {
      entry = { el: document.createElement('canvas'), width: 0, height: 0, gen: true, key: null };
    }
    if (await loadGenFonts(l.gen)) entry.key = null;
    // V3.3. One that moves goes as the frames of its move.
    // V4.10. And one with a transition as the frames of that, whichever it is.
    const motion = genDraw.genMotion(l);
    const fps = Number(frame.fps) || 30;
    const spans = [
      ...(motion ? [frameSpan(l, fps, motion.from, motion.to)] : []),
      ...transitionSpans(l, fps, () => true),
    ];
    if (spans.length) {
      const seq = await exportGenFrames(l, spans, frame);
      if (!seq.ok) return seq;
      out.push({ ...l, src: seq.frames.pattern, frames: seq.frames,
        sourceWidth: frame.width, sourceHeight: frame.height });
      continue;
    }
    // One that holds still is drawn once, as its keyframe has it when it has
    // keyframes: at its start, which is every moment of it.
    paintGen(l, entry, timelineModel.keyframesFor(l).length ? l.start : null);
    const key = entry.key;
    let saved = await window.lwclipper.genImage(key, null);
    if (saved.ok && !saved.path) {
      const blob = await new Promise((done) => entry.el.toBlob(done, 'image/png'));
      if (!blob) return { ok: false, error: 'canvas toBlob gave no PNG' };
      saved = await window.lwclipper.genImage(key, new Uint8Array(await blob.arrayBuffer()));
    }
    if (!saved.ok || !saved.path) return { ok: false, error: saved.error || 'no PNG path' };
    out.push({ ...l, src: saved.path, sourceWidth: frame.width, sourceHeight: frame.height });
  }
  return { ok: true, layers: out };
}

/**
 * Step 15. The timeline rendered to one file.
 *
 * The composite twin of saveClipTo, and deliberately the same shape: one
 * runJob, the same failure report. What it hands over is the project rather
 * than a media file and a pair of markers, because in advanced editing the
 * markers are part of the project.
 *
 * The frame is projectFrame() rather than compositeFrame, so an audio-only
 * project still arrives with a size. Nothing reads it there, and handing the
 * encoder a 0x0 to ignore is a worse thing to rely on.
 *
 * V4.1. Started from the Export window, with the name chosen there, and shown
 * in the Rendering modal rather than under the main window's status line.
 */
async function exportProject(title) {
  if (!savable()) return false;
  const destination = await window.lwclipper.saveAsDialog(
    title || exportName(), outputIsAudio(), outputFormat, true);
  if (!destination) return false;
  closeExportWindow();
  openRendering(destination);
  await runJob(async () => {
    const prepared = await exportLayers();
    if (!prepared.ok) {
      reportFailure(prepared);
      finishRendering(prepared);
      return;
    }
    const result = await window.lwclipper.compose(
      prepared.layers, projectFrame(), { start: slider.start, end: slider.end },
      destination, compressionPercent(), chosenDevice());
    if (!result.ok) reportFailure(result);
    else setStatus('Saved to {path}', { path: result.data });
    finishRendering(result);
  });
  return true;
}

// ---- V4.1. The Export window ----
//
// The user: "Opens a window for the export options (Title, Framerate, File
// compression, Output Format, [Cancel] left, [Export] right)", with the size
// "defined by Crop Render", shown in boxes that cannot be edited. The frame
// rate, compression and format are the save row's own controls, moved in for
// as long as the window is open and back out after, so there is one of each
// and nothing to keep in step (download.js does the same with the URL row).

const exportModal = el('exportModal');
const exportControls = el('exportControls');
const exportNameField = el('exportNameField');
const exportWidth = el('exportWidth');
const exportHeight = el('exportHeight');
const exportSizeLabel = el('exportSizeLabel');
const exportSize = el('exportSize');
const exportCancelBtn = el('exportCancelBtn');
const exportGoBtn = el('exportGoBtn');
const saveRowNode = document.querySelector('.save-row');
const compressionGroup = saveRowNode.querySelector('.compression-group');
const formatGroup = saveRowNode.querySelector('.format-group');
const saveActions = saveRowNode.querySelector('.save-actions');

function exportWindowOpen() {
  return !exportModal.hidden;
}

// ---- V4.4. Render using ----
//
// The user: "For exporting it would be nice to have the option to chose
// between "Render using [x] GPU [ ] CPU [ ] Both"." Both is what the GPU
// already is: ffmpeg builds the frames on the CPU and only the encode moves,
// so the choice is Auto, GPU or CPU. Auto and GPU render the same way; GPU
// only says so when the GPU let it down and the CPU took over.

const exportDeviceLabel = el('exportDeviceLabel');
const exportDeviceRow = el('exportDeviceRow');
const exportDevice = el('exportDevice');
const exportDeviceNote = el('exportDeviceNote');
const RENDER_DEVICES = ['auto', 'gpu', 'cpu'];
const GPU_OUTPUTS = ['mp4', 'mov'];

// null until the main process has tried a real encode on the GPU.
let gpuAvailable = null;

function chosenDevice() {
  const saved = appSettings && appSettings.renderDevice;
  return RENDER_DEVICES.includes(saved) ? saved : 'auto';
}

/** What this export will actually run on, as far as the window knows. */
function effectiveDevice() {
  if (chosenDevice() === 'cpu') return 'cpu';
  if (!GPU_OUTPUTS.includes(outputFormat)) return 'cpu';
  return gpuAvailable === false ? 'cpu' : chosenDevice();
}

function refreshDeviceRow() {
  const audio = outputIsAudio();
  exportDeviceLabel.hidden = audio;
  exportDeviceRow.hidden = audio;
  if (audio) return;
  const gpuFormat = GPU_OUTPUTS.includes(outputFormat);
  const shown = effectiveDevice();
  exportDevice.querySelectorAll('button').forEach((b) => {
    const device = b.dataset.device;
    b.classList.toggle('btn--active', device === shown);
    b.disabled = device !== 'cpu' && (!gpuFormat || gpuAvailable === false);
  });
  let note;
  if (!gpuFormat) note = t('WebM is always rendered on the CPU.');
  else if (gpuAvailable === false) note = t('No GPU encoder was found, so the CPU renders.');
  else if (gpuAvailable === null) note = t('Checking the GPU...');
  else if (shown === 'auto') note = t('The GPU encodes when it can.');
  else if (shown === 'gpu') note = t('The GPU encodes, the CPU builds the frames.');
  else note = t('The CPU does all of it.');
  exportDeviceNote.textContent = note;
}

async function checkGpu() {
  if (gpuAvailable !== null) return;
  try {
    const info = await window.lwclipper.gpuInfo();
    gpuAvailable = !!(info && info.available);
  } catch {
    gpuAvailable = false;
  }
  if (exportWindowOpen()) refreshDeviceRow();
}

exportDevice.addEventListener('click', async (evt) => {
  const btn = evt.target.closest('button[data-device]');
  if (!btn || btn.disabled) return;
  appSettings = (await window.lwclipper.setSettings({ renderDevice: btn.dataset.device })).settings;
  refreshDeviceRow();
});

function canExport() {
  return timelineDriving() && !busy && savable();
}

/** The size and the rate's row, as the output is right now. */
function refreshExportWindow() {
  const frame = projectFrame();
  const audio = outputIsAudio();
  exportWidth.value = String(frame.width);
  exportHeight.value = String(frame.height);
  exportSizeLabel.hidden = audio;
  exportSize.hidden = audio;
  updateCutControls();
  refreshDeviceRow();
  exportGoBtn.disabled = !canExport();
}

function openExportWindow() {
  if (!canExport() || exportWindowOpen()) return;
  // In the order they stood in on the row.
  exportControls.append(fpsLabel, compressionGroup, formatGroup);
  exportNameField.value = exportName();
  exportModal.hidden = false;
  refreshExportWindow();
  checkGpu();
  exportNameField.focus();
  exportNameField.select();
}

function closeExportWindow() {
  if (!exportWindowOpen()) return;
  exportModal.hidden = true;
  saveActions.before(fpsLabel, compressionGroup, formatGroup);
}

exportCancelBtn.addEventListener('click', closeExportWindow);
exportGoBtn.addEventListener('click', async () => {
  if (!canExport()) return;
  // A name made of nothing but spaces is no name; the main process strips
  // what a file name cannot hold from the rest.
  const title = exportNameField.value.trim() || exportName();
  await exportProject(title);
});
exportNameField.addEventListener('keydown', (evt) => {
  if (evt.key !== 'Enter') return;
  evt.preventDefault();
  exportGoBtn.click();
});
// A format button can change whether the output has a picture at all, and
// with it whether the rate and the size mean anything.
formatGroup.addEventListener('click', () => {
  if (exportWindowOpen()) refreshExportWindow();
});
bindPopup(exportModal, closeExportWindow);

// ---- V4.1. The Rendering modal ----
//
// The user: "When export is setup and the actual export to render it is
// clicked, close the export window, open a non-closeable modal "Rendering...",
// which blocks interactions with the rest of the app and that shows the chosen
// file name and a progress bar with estimated time left. When finished show 3
// buttons at the bottom of that modal: "Open File", "Open Folder", "Close"."
// Escape and the backdrop do nothing while it runs; Cancel stops the render,
// the same Cancel the main window has.

const renderingModal = el('renderingModal');
const renderingTitle = el('renderingTitle');
const renderingFile = el('renderingFile');
const renderingBar = el('renderingBar');
const renderingStatus = el('renderingStatus');
const renderingCancelBtn = el('renderingCancelBtn');
const renderingOpenBtn = el('renderingOpenBtn');
const renderingFolderBtn = el('renderingFolderBtn');
const renderingCloseBtn = el('renderingCloseBtn');

let rendering = null;     // { path, done }

function fileNameOf(fullPath) {
  return String(fullPath || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function openRendering(destination) {
  rendering = { path: destination, done: false };
  renderingTitle.textContent = t('Rendering...');
  renderingFile.textContent = fileNameOf(destination);
  renderingFile.title = destination;
  // No value at first: the layers are drawn before ffmpeg says anything, and
  // a bar that moves without knowing is the honest picture of that.
  renderingBar.removeAttribute('value');
  renderingStatus.textContent = t('Preparing the layers...');
  renderingStatus.dataset.tone = '';
  renderingCancelBtn.hidden = false;
  renderingCancelBtn.disabled = false;
  renderingOpenBtn.hidden = true;
  renderingFolderBtn.hidden = true;
  renderingCloseBtn.hidden = true;
  renderingModal.hidden = false;
  closeMenus();
}

/** Every progress line while the modal is up, from setProgress. */
function noteRenderProgress(frac, text) {
  if (!rendering || rendering.done) return;
  if (frac !== null && frac !== undefined) renderingBar.value = Math.min(1, Math.max(0, frac));
  if (text) renderingStatus.textContent = text;
}

function finishRendering(result) {
  if (!rendering) return;
  // Cancelled is the user's own answer and wants nothing more from them.
  if (result && result.cancelled) {
    closeRendering();
    return;
  }
  rendering.done = true;
  renderingCancelBtn.hidden = true;
  renderingCloseBtn.hidden = false;
  if (result && result.ok) {
    rendering.path = result.data || rendering.path;
    renderingTitle.textContent = t('Export finished');
    renderingFile.textContent = fileNameOf(rendering.path);
    renderingFile.title = rendering.path;
    renderingBar.value = 1;
    renderingStatus.textContent = t('Saved to {path}', { path: rendering.path });
    renderingStatus.dataset.tone = '';
    // V4.4. Auto falls back without a word; a GPU that was asked for says it.
    if (result.fellBack && chosenDevice() === 'gpu') {
      renderingStatus.textContent += '\n' + t('The GPU could not render this, so the CPU did.');
      renderingStatus.dataset.tone = 'warn';
    }
    renderingOpenBtn.hidden = false;
    renderingFolderBtn.hidden = false;
    renderingOpenBtn.focus();
  } else {
    renderingTitle.textContent = t('Export failed');
    renderingStatus.textContent = t('Error: {message}', { message: String((result && result.error) || '') });
    renderingStatus.dataset.tone = 'error';
    renderingCloseBtn.focus();
  }
}

function closeRendering() {
  rendering = null;
  renderingModal.hidden = true;
}

renderingCancelBtn.addEventListener('click', async () => {
  renderingCancelBtn.disabled = true;
  renderingStatus.textContent = t('Cancelling...');
  await window.lwclipper.cancelJob();
});
renderingOpenBtn.addEventListener('click', async () => {
  if (!rendering) return;
  const result = await window.lwclipper.openFile(rendering.path);
  if (result && result.ok === false) {
    renderingStatus.textContent = t('Could not open that file: {error}', { error: result.error });
    renderingStatus.dataset.tone = 'error';
  }
});
renderingFolderBtn.addEventListener('click', () => {
  if (rendering) window.lwclipper.showInFolder(rendering.path);
});
renderingCloseBtn.addEventListener('click', closeRendering);
// Over everything, the questions included. Only once it is done do Escape and
// the backdrop do what Close does.
bindPopup(renderingModal, () => {
  if (rendering && rendering.done) closeRendering();
}, 4);

saveBtn.addEventListener('click', async () => {
  if (busy) return;
  if (timelineDriving()) {
    openExportWindow();
    return;
  }
  if (!media) return;
  const destination = await window.lwclipper.saveAsDialog(
    media.title, outputIsAudio(), outputFormat);
  if (!destination) return;
  await saveClipTo(destination);
});

quickSaveBtn.addEventListener('click', async () => {
  if (busy) return;
  // The same button, and in advanced editing the instant one is the project
  // rather than a render. Straight to saveProject, which is the same thing the
  // header button and Ctrl+S do.
  if (timelineDriving()) {
    await saveProject(false);
    return;
  }
  if (!media) return;
  await saveClipTo(await window.lwclipper.quickSaveTarget(
    media.title, outputIsAudio(), outputFormat));
});

cancelBtn.addEventListener('click', async () => {
  await window.lwclipper.cancelJob();
  setStatus('Cancelling...');
});
