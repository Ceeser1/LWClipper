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
async function exportGenFrames(l, motion, frame) {
  const fps = Number(frame.fps) || 30;
  const total = Math.max(1, Math.round(l.duration * fps));
  const first = Math.min(total - 1, Math.max(0, Math.floor(motion.from * fps)));
  const last = Math.min(total - 1, Math.max(first, Math.ceil(motion.to * fps)));
  const key = JSON.stringify(['frames', l.gen, l.keyframes, l.duration, fps, frame.width, frame.height, first, last]);
  const begun = await window.lwclipper.genFrames(key, { start: true });
  if (!begun.ok) return { ok: false, error: begun.error || 'no folder for the frames' };
  if (!begun.have) {
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    for (let i = first; i <= last; i += 1) {
      genDraw.drawGen(ctx, genDraw.genAt(l, i / fps, frame.width, frame.height), frame.width, frame.height);
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
      if (!blob) return { ok: false, error: 'canvas toBlob gave no PNG' };
      const wrote = await window.lwclipper.genFrame(key, i - first, new Uint8Array(await blob.arrayBuffer()));
      if (!wrote.ok) return { ok: false, error: wrote.error };
    }
    const done = await window.lwclipper.genFrames(key, { finish: true });
    if (!done.ok) return { ok: false, error: done.error };
  }
  return {
    ok: true,
    frames: {
      pattern: begun.dir.replace(/\\/g, '/') + '/%05d.png',
      lead: first / fps,
      tail: Math.max(0, l.duration - (last + 1) / fps),
    },
  };
}

/**
 * V3.6. A masked picture's mask for the export, drawn by drawMask like the
 * preview's, white where the picture shows on black: at the size the picture
 * is placed at, or the largest it gets when it moves, since composer.js scales
 * it to the picture on every frame. One PNG when the mask holds still on the
 * picture, which it does even while the picture moves; the frames of its own
 * change when its keyframes move it. Cached like a generated layer's.
 */
async function exportMask(l, frame) {
  const source = layerSource(l);
  if (!source) return { ok: true, file: null };
  const motion = layerGeometry.motionOf(l, source, frame);
  const still = layerGeometry.placementAt(l, 0, source, frame);
  const dests = motion ? motion.map((k) => k.dest) : (still ? [still.dest] : []);
  if (!dests.length) return { ok: true, file: null };
  const side = (v) => Math.max(2, Math.min(GEN_SURFACE_MAX, Math.round(v)));
  const w = side(Math.max(...dests.map((d) => d.width)));
  const h = side(Math.max(...dests.map((d) => d.height)));
  let picture = null;
  let pictureSize = null;
  if (l.mask.kind === 'custom') {
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
  const draw = (t) => {
    genDraw.drawMask(ink, timelineModel.maskAt(l, t), w, h, picture);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(ink.canvas, 0, 0);
  };
  const png = async () => {
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  };
  const moving = timelineModel.maskMotion(l);
  if (!moving) {
    const key = JSON.stringify(['mask', timelineModel.maskAt(l, 0), w, h, pictureSize]);
    let saved = await window.lwclipper.genImage(key, null);
    if (saved.ok && !saved.path) {
      draw(0);
      const bytes = await png();
      if (!bytes) return { ok: false, error: 'canvas toBlob gave no PNG' };
      saved = await window.lwclipper.genImage(key, bytes);
    }
    if (!saved.ok || !saved.path) return { ok: false, error: saved.error || 'no PNG path' };
    return { ok: true, file: { src: saved.path } };
  }
  const fps = Number(frame.fps) || 30;
  const total = Math.max(1, Math.round(l.duration * fps));
  const first = Math.min(total - 1, Math.max(0, Math.floor(moving.from * fps)));
  const last = Math.min(total - 1, Math.max(first, Math.ceil(moving.to * fps)));
  const key = JSON.stringify(['maskframes', l.mask, timelineModel.keyframesFor(l).map((k) => [k.t, k.mask]),
    l.duration, fps, w, h, first, last, pictureSize]);
  const begun = await window.lwclipper.genFrames(key, { start: true });
  if (!begun.ok) return { ok: false, error: begun.error || 'no folder for the mask frames' };
  if (!begun.have) {
    for (let i = first; i <= last; i += 1) {
      draw(i / fps);
      const bytes = await png();
      if (!bytes) return { ok: false, error: 'canvas toBlob gave no PNG' };
      const wrote = await window.lwclipper.genFrame(key, i - first, bytes);
      if (!wrote.ok) return { ok: false, error: wrote.error };
    }
    const done = await window.lwclipper.genFrames(key, { finish: true });
    if (!done.ok) return { ok: false, error: done.error };
  }
  return {
    ok: true,
    file: {
      frames: {
        pattern: begun.dir.replace(/\\/g, '/') + '/%05d.png',
        lead: first / fps,
        tail: Math.max(0, l.duration - (last + 1) / fps),
      },
    },
  };
}

async function exportLayers() {
  const frame = projectFrame();
  const out = [];
  for (const l of layers) {
    // V3.6. A masked picture goes with its mask.
    if (l.kind !== 'gen' && l.enabled && l.type === 'video' && l.mask) {
      const m = await exportMask(l, frame);
      if (!m.ok) return m;
      out.push(m.file ? { ...l, maskFile: m.file } : l);
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
    const motion = genDraw.genMotion(l);
    if (motion) {
      const seq = await exportGenFrames(l, motion, frame);
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
 * runJob, the same failure report, the same notice. What it hands over is the
 * project rather than a media file and a pair of markers, because in advanced
 * editing the markers are part of the project.
 *
 * The frame is projectFrame() rather than compositeFrame, so an audio-only
 * project still arrives with a size. Nothing reads it there, and handing the
 * encoder a 0x0 to ignore is a worse thing to rely on.
 */
async function exportProject() {
  if (!savable()) return;
  const destination = await window.lwclipper.saveAsDialog(
    exportName(), outputIsAudio(), outputFormat, true);
  if (!destination) return;
  await runJob(async () => {
    const prepared = await exportLayers();
    if (!prepared.ok) {
      reportFailure(prepared);
      return;
    }
    const result = await window.lwclipper.compose(
      prepared.layers, projectFrame(), { start: slider.start, end: slider.end },
      destination, compressionPercent());
    if (!result.ok) {
      reportFailure(result);
      return;
    }
    setStatus('Saved to {path}', { path: result.data });
    showSaveNotice(result.data);
  });
}

saveBtn.addEventListener('click', async () => {
  if (busy) return;
  if (timelineDriving()) {
    await exportProject();
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
