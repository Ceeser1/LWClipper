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
async function exportLayers() {
  const frame = projectFrame();
  const out = [];
  for (const l of layers) {
    if (l.kind !== 'gen' || !l.enabled) {
      out.push(l);
      continue;
    }
    let entry = decoders.get(l.id);
    if (!entry || !entry.gen) {
      entry = { el: document.createElement('canvas'), width: 0, height: 0, gen: true, key: null };
    }
    if (await loadGenFonts(l.gen)) entry.key = null;
    paintGen(l, entry);
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
