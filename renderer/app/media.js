'use strict';

// Loading media by drag and drop, the audio frame with its replacement track
// and the spectrum.

// ---- drag and drop ----

// Every dragover and drop has to be prevented, or Electron does what a browser
// does and navigates the window to the dropped file, replacing the whole app
// with a bare media player and no way back.
let dragDepth = 0;

function isFileDrag(evt) {
  return !!(evt.dataTransfer && Array.from(evt.dataTransfer.types).includes('Files'));
}

// A replacement has nothing to replace in an audio-only clip: buildTrimArgs
// ignores one there, which is why the frame already hides Change Audio.
function audioDropAllowed() {
  return !(media && media.isAudio);
}

/**
 * Whether the frame at the top of the window will take a dropped file.
 *
 * V2.7. Not in advanced editing, at the user's word: "the title frame is hidden
 * in advanced mode, but the drop zone still tries to show up there ... No upper
 * drop zone in advanced mode."
 *
 * V2.6 collapsed that frame until it has something to report, but a job's
 * progress or a quality list brings it back, and while it was up it was still
 * lighting as a drop zone. It is a place the app speaks from now, not a place
 * to put things: the empty layer rows are what take a file here, which is the
 * argument the top zone was removed on in the first place.
 */
function mainDropTakesFiles() {
  return !timelineDriving();
}

function setDropActive(on) {
  const active = on && !busy;
  const mainOn = active && mainDropTakesFiles();
  mainDrop.dataset.drop = String(mainOn);
  mainDropHint.hidden = !mainOn;
  const audioOn = active && audioDropAllowed();
  audioSection.dataset.drop = String(audioOn);
  audioDropHint.hidden = !audioOn;
  if (!active) setDropHover(null);
}

// Both zones light up for the whole drag, so the one under the pointer is
// marked separately to say which of them would actually take the file.
function setDropHover(zone) {
  mainDrop.dataset.dropHover = String(zone === mainDrop && mainDropTakesFiles());
  audioSection.dataset.dropHover = String(zone === audioSection && audioDropAllowed());
  // Every zone that carries the attribute, which since V2.8 is the empty rows
  // and the Add a new Layer block. The class is the empty row's name for it and
  // the block borrows it rather than having a second one that means the same.
  for (const track of document.querySelectorAll('[data-empty-type]')) {
    track.classList.toggle('layer-track--dropping', track === zone);
  }
}

function dropZoneUnder(evt) {
  const node = evt.target;
  if (!node || !node.closest) return null;
  // An empty layer row is a drop zone too, and it wins over the frames behind
  // it, which is what closest() already gives since it is the deeper element.
  //
  // #audioSection stays named here and goes inert on its own in advanced mode:
  // Step 10c hides it, and a display:none element is never an event target, so
  // closest() cannot reach it. The empty Audio row is the drop zone there.
  const zone = node.closest('[data-empty-type], #mainDrop, #audioSection');
  // The frame at the top takes nothing in advanced editing, so a drag over it
  // lands nowhere rather than there. See mainDropTakesFiles.
  if (zone === mainDrop && !mainDropTakesFiles()) return null;
  return zone;
}

document.addEventListener('dragenter', (evt) => {
  if (!isFileDrag(evt)) return;
  evt.preventDefault();
  dragDepth += 1;
  setDropActive(true);
});

document.addEventListener('dragover', (evt) => {
  if (!isFileDrag(evt)) return;
  evt.preventDefault();
  evt.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  setDropHover(busy ? null : dropZoneUnder(evt));
});

document.addEventListener('dragleave', (evt) => {
  if (!isFileDrag(evt)) return;
  // dragleave fires for every element the pointer crosses on its way across the
  // window, so the drag has only really left once the enters and leaves balance.
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) setDropActive(false);
});

// Catches everything the zones do not, so a file dropped on the preview or the
// footer is simply ignored rather than navigating the window. An empty layer
// row is handled here rather than with a listener of its own, because the rows
// are rebuilt from the model and a per-row listener would have to be reattached
// every time they are.
document.addEventListener('drop', (evt) => {
  if (!isFileDrag(evt)) return;
  evt.preventDefault();
  dragDepth = 0;
  const zone = dropZoneUnder(evt);
  setDropActive(false);
  if (!zone || !zone.dataset.emptyType || busy) return;
  const filePath = droppedPath(evt);
  if (filePath) openIntoLayer(zone.dataset.emptyType, filePath, zone.dataset.lane);
});

// A drag that ends abnormally, Escape being the usual way, need not leave a
// balancing dragleave behind, and a stuck highlight hides the entire UI until
// the app is restarted. Mouse events are suppressed for the duration of a drag,
// so the first pointer move afterwards is proof one is no longer in progress.
function cancelDropHighlight() {
  if (!dragDepth) return;
  dragDepth = 0;
  setDropActive(false);
}

document.addEventListener('dragend', cancelDropHighlight);
document.addEventListener('pointermove', cancelDropHighlight);
window.addEventListener('blur', cancelDropHighlight);

// More than one file is not worth an error: the first is what was meant, and
// the rest would only replace it anyway.
function droppedPath(evt) {
  if (busy) return null;
  const files = evt.dataTransfer ? evt.dataTransfer.files : null;
  if (!files || !files.length) return null;
  return window.lwclipper.pathForFile(files[0]) || null;
}

async function handleMainDrop(filePath) {
  const result = await window.lwclipper.describeMedia(filePath);
  // A .lwc is not media and never was: this used to reach ffprobe, which
  // reported that it could not find a duration in it, which is true and useless.
  if (result.project) {
    await openProjectPath(result.path);
    return;
  }
  if (!result.ok) {
    reportFailure(result);
    updateStatusScale();
    return;
  }
  // Advanced editing has no single media file to replace: the project is the
  // timeline. So a file dropped up here becomes a track, which is what dropping
  // it on the app can usefully mean, rather than loading into a clip that
  // nothing in this mode is a view of. Which row it joins follows the file.
  if (appSettings.advancedEditing) {
    addLayerFromMedia(result.data.isAudio ? 'audio' : 'video', result.data);
    return;
  }
  adoptLocalMedia(result.data);
}

async function handleAudioDrop(filePath) {
  const result = await window.lwclipper.describeMedia(filePath);
  // The only zone that does not open it. This one means "replace this clip's
  // sound with that file", and a project is not a sound, so it says so rather
  // than quietly doing something else with the drop.
  if (result.project) {
    setAudioStatus(t('That is a LWClipper project, not an audio file.'));
    return;
  }
  if (!result.ok) {
    setAudioStatus(result.error || t('That file could not be read.'));
    return;
  }
  // Nothing loaded yet, so there is no audio track to replace. The file becomes
  // the clip instead, which is the only thing a drop here can usefully mean.
  if (!media) {
    adoptLocalMedia(result.data);
    return;
  }
  // A video dropped here contributes only its audio line. ffmpeg maps 1:a out
  // of it exactly as it would from an audio file, and the waveform decodes it
  // with -vn, so nothing else has to know the difference.
  if (!result.data.hasAudio) {
    setAudioStatus(t('That file has no audio track ffmpeg can read.'));
    return;
  }
  setAudioTrack({
    path: filePath,
    name: filePath.split(/[\\/]/).pop(),
    duration: result.data.duration,
  });
}

// The listeners stay thin: pull the path out of the event and hand it on,
// which leaves the routing above reachable without an operating system drag.
mainDrop.addEventListener('drop', (evt) => {
  // Guarded as well as unlit: a file let go over a frame that never offered to
  // take it must not be taken anyway.
  if (!mainDropTakesFiles()) return;
  const filePath = droppedPath(evt);
  if (filePath) handleMainDrop(filePath);
});

audioSection.addEventListener('drop', (evt) => {
  if (!audioDropAllowed()) return;
  const filePath = droppedPath(evt);
  if (filePath) handleAudioDrop(filePath);
});

// The canvas is sized in CSS pixels, and both playheads are placed from the
// current width, so a resize means a redraw and a reposition. The crop boxes
// are placed from the frames' own width, which moves with the window too.
window.addEventListener('resize', () => {
  // Step 21c-3, before 21c-1: the columns decide how wide each frame is and so
  // how tall it wants to be, which is what the split below it then divides.
  applySideSplit();
  // Step 21c. Then this, because it can move the boundary between the preview
  // and the timeline, and everything below measures one of the two.
  applySplit();
  drawWaveform();
  // Before updatePlayhead, which places the timeline bar from a view that this
  // is what re-fits to the new width.
  drawTimeline();
  updatePlayhead();
  updateCropOverlays();
  resizeCropStage();
});
// Switching the picture off turns this into an audio save, so the formats on
// offer, the compression scale and Frame-accurate cut all have to follow.
videoEnabledToggle.addEventListener('change', () => {
  applyPreviewMode();
  buildFormatToggle();
  updateCutControls();
  updateAudioUi();
  updateCompressionState();
  updateCropBtn();
  updateRenderResolution();
  fitWindow();
});

compressionToggle.addEventListener('change', updateCompressionState);
compressionSlider.addEventListener('input', updateCompressionState);

urlField.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && urlField.value.trim()) loadBtn.click();
});

pasteBtn.addEventListener('click', async () => {
  urlField.value = await window.lwclipper.readClipboardText();
});

loadBtn.addEventListener('click', async () => {
  if (busy) return;
  const url = urlField.value;
  probed = null;
  media = null;
  formatRow.querySelectorAll('button').forEach((b) => b.remove());
  formatPlaceholder.hidden = false;
  selectedFormatBtn = null;
  qualityListWanted = true;
  qualitiesPending = false;
  updateMainFrame();
  setTrimEnabled(false);
  titleLabel.textContent = '';

  await runJob(async () => {
    setStatus('Reading video info...');
    const result = await window.lwclipper.probe(url, cookieChoice());
    if (!result.ok) {
      reportFailure(result);
      return;
    }
    probed = result.data;
    titleLabel.textContent = probed.title;
    setStatus('Found: {title}   ({duration})',
      { title: probed.title, duration: fmtTime(probed.duration, false) });
    formatPlaceholder.hidden = true;
    for (const format of probed.formats) {
      const btn = document.createElement('button');
      btn.textContent = format.label;
      btn.addEventListener('click', () => onFormatClicked(format, btn));
      formatRow.appendChild(btn);
    }
    qualitiesPending = true;
    updateMainFrame();
    // The quality row just went from one line of text to a row of buttons.
    fitWindow();
  });
});

async function onFormatClicked(format, btn) {
  if (busy || !probed) return;
  // "Hidden again once a button is clicked". The list has done its job the
  // moment one is pressed, and what follows is a download with a bar.
  qualitiesPending = false;
  updateMainFrame();
  if (selectedFormatBtn) selectedFormatBtn.classList.remove('format-btn--selected');
  selectedFormatBtn = btn;
  btn.classList.add('format-btn--selected');
  const videoId = probed.videoId;
  const sourceUrl = probed.sourceUrl;
  const title = probed.title;

  await runJob(async () => {
    const result = await window.lwclipper.download(videoId, sourceUrl, title, format, cookieChoice());
    if (!result.ok) {
      reportFailure(result);
      return;
    }
    onMediaReady(result.data);
  });
}

function onMediaReady(m) {
  media = m;
  // Before anything reads outputIsAudio(): a fresh file arrives with its
  // picture on, whatever the last one was left set to, and the format toggle
  // below is built from that answer.
  videoEnabledToggle.checked = true;
  // Open on the format the file already is, which is both the least surprising
  // offer and the one that might avoid a re-encode. Anything the app cannot
  // write falls back to MP4 or MP3, which is decided in the main process so the
  // open and download paths cannot come to different answers.
  outputFormat = m.sourceFormat || (m.isAudio ? 'mp3' : 'mp4');
  buildFormatToggle();
  // A source that measures itself in bitrates starts the slider where it already
  // sits. The checkbox stays off: leaving it off copies the stream untouched,
  // and switching it on to re-encode an mp3 at its own rate would only lose
  // quality for nothing.
  if (m.compressionPreset !== null && m.compressionPreset !== undefined) {
    compressionSlider.value = String(m.compressionPreset);
  }
  // After the preset, so the setting is what wins when it is switched on.
  applyBestCompression();
  // Frames in an audio file are about 26 ms, so a copied cut already lands
  // within one of the asked-for point and the option has nothing to offer.
  updateCutControls();
  saveNotice.hidden = true;
  updateClearBtn();
  // A rectangle measured on the frame of some other file means nothing here,
  // and neither does the view it was chosen from.
  cropRect = null;
  cropView = null;
  updateCropOverlays();
  resetAudioState();
  // Default follows the file: on when there is a track, off and unavailable
  // when there is not.
  audioEnabledToggle.checked = m.hasAudio === true;
  updateAudioUi();
  loadAudioPeaks();
  titleLabel.textContent = m.title;
  updateStatusScale();
  const duration = m.duration || 0;
  // A link carrying ?t=117, #t=1m57s, &start=45 and friends means "begin here",
  // so open the selection there rather than always at zero.
  const offset = (probed && probed.startOffset) || 0;
  const startAt = Math.min(Math.max(0, offset), Math.max(0, duration - slider.minSpan));
  slider.setRange(duration, startAt, duration);
  // A new clip is shown whole, whatever the last one was zoomed to.
  resetTimelineView();
  refreshSelection(null);
  setTrimEnabled(duration > 0);

  // Audio gets a source too: <video> plays an mp3 fine, it just shows no
  // picture, and without it "Play selection" was dead for audio downloads.
  window.lwclipper.fileUrl(m.path).then((url) => {
    previewVideo.src = url;
    // The picture may already be switched off, in which case the transport is
    // the audio element and this is the source it has to pick up. If it is not,
    // it is still holding the file before this one open, and on Windows that is
    // a handle that outlives the clip it belonged to.
    if (transport === previewSound) previewSound.src = url;
    else if (previewSound.getAttribute('src')) {
      previewSound.removeAttribute("src");
      previewSound.load();
    }
    startFrame.load(url);
    endFrame.load(url);
    startFrame.seek(slider.start);
    endFrame.seek(slider.end);
  });
  updatePlayhead();
  setProgress(1.0, t('Ready: {name}', { name: m.path.split(/[\\/]/).pop() }));
}

function refreshSelection(skipField) {
  const { start, end } = slider;
  if (skipField !== startTimeField) startTimeField.value = fmtTime(start);
  if (skipField !== endTimeField) endTimeField.value = fmtTime(end);
  spanLabel.textContent = t('Selection: {selected}   of   {total}',
    { selected: fmtTime(end - start, false), total: fmtTime(slider.duration, false) });
  startFrame.seek(start);
  endFrame.seek(end);
  drawWaveform();
  drawTimeline();
  // The trim markers are part of the document, so moving them is unsaved work.
  // Here rather than at each of the four ways they move, because every one of
  // those comes through this.
  updateProjectUi();
}

slider.onChange = () => refreshSelection(null);

// What the trim applies to: the single media file in simple editing, the
// project in advanced. Only ever widens what is enabled, never narrows it, so
// a file loaded before the switch keeps everything it had.
function trimmable() {
  return media !== null || timelineModel.totalDuration(layers) > 0;
}

// The length the trim currently spans, so a project that grows can be told from
// one that was merely redrawn.
let trimSpan = 0;
// Which subject the slider was last ranged for, so re-applying the same mode
// does not re-range it. applyAdvancedEditing runs on every settings change,
// language included, and re-ranging there would wipe a trim in progress.
let trimSubjectAdvanced = null;

/**
 * Follow a project that has just got longer or shorter.
 *
 * The end follows the project only while it was already sitting at the end.
 * Once it has been pulled in deliberately it stays where it was put, or setting
 * an out point and then nudging any clip would silently undo it.
 */
function syncProjectTrim() {
  if (!appSettings.advancedEditing) return;
  const total = timelineModel.totalDuration(layers);
  if (total === trimSpan) return;
  // Against the material rather than against the ceiling: "was the end sitting
  // at the end of what there is" is the question, and V2.8 made those two
  // different numbers.
  const wasWhole = slider.end >= trimSpan - 0.001;
  // V2.8. And how far past it, because an end past the material is a length of
  // black somebody asked for. Following the project back to its new end would
  // throw that away, and standing still would turn it into a cut. Keeping the
  // distance is the only one of the three that means the same thing afterwards
  // as it did before.
  const tail = Math.max(0, slider.end - trimSpan);
  trimSpan = total;
  if (total <= 0) {
    slider.reset();
  } else {
    const start = Math.min(slider.start, Math.max(0, total - slider.minSpan));
    // No longer pulled back to the material. An end deliberately put past the
    // last layer stays there when a clip is nudged, the same way an end pulled
    // deliberately inward already did.
    const end = wasWhole ? total + tail : Math.max(slider.end, start + slider.minSpan);
    slider.setRange(timelineModel.trimCeiling(layers), start, end);
  }
  setTrimEnabled(!busy && trimmable());
  refreshSelection(null);
}

/**
 * The trim's subject changed because the mode did.
 *
 * Shows the whole of whichever it now is rather than carrying a trim across to
 * a different length of material, where the same numbers would mean something
 * else. Mode switching is rare; silently keeping a stale in and out would not
 * be worth the confusion the first time it bit.
 */
function applyTrimSubject() {
  const advanced = !!appSettings.advancedEditing;
  if (trimSubjectAdvanced === advanced) return;
  trimSubjectAdvanced = advanced;
  const total = advanced
    ? timelineModel.totalDuration(layers)
    : (media ? media.duration || 0 : 0);
  trimSpan = advanced ? total : 0;
  if (total <= 0) slider.reset();
  // Advanced editing's ceiling is past the material, V2.8 item 3. Simple
  // editing's is the file, which has nothing past it to show.
  else slider.setRange(advanced ? timelineModel.trimCeiling(layers) : total, 0, total);
  setTrimEnabled(!busy && trimmable());
  refreshSelection(null);
}

// ---- audio frame ----

// Selected uses the trim fill's blue; the walls borrow the two handle colours,
// so a boundary here reads as the same boundary as in the frame below.
const AUDIO_SELECTED = '#5a8cdc';
const AUDIO_UNSELECTED = '#8a8a94';
const AUDIO_WALL_START = '#78c88c';
const AUDIO_WALL_END = '#dc7878';

let audioPeaks = null;   // flat min,max pairs for whichever track is active
let audioTrack = null;   // null means the media's own audio
let audioOffset = 0;     // seconds the replacement is shifted along the clip
let audioToken = 0;      // stops a slow analysis landing after a newer one
let previewAudioPath = null; // whatever previewAudio currently holds open

// Which element the preview actually plays through, and so which one owns the
// control bar, the clock and the playhead. Chromium picks a control layout from
// the media in the element rather than from CSS, so a video element is given the
// video bar however it is styled. A source whose picture is switched off is
// therefore played through the audio element, which is handed the compact bar an
// audio file already gets.
let transport = previewVideo;

// Seeking a source that has only just been handed over has to wait for its
// duration: currentTime is simply dropped while the element knows nothing.
function resumeTransport(elem, at, playing) {
  const go = () => {
    if (Number.isFinite(elem.duration) && elem.duration > 0) {
      elem.currentTime = Math.min(at, elem.duration);
    }
    if (playing) elem.play().catch(() => {});
    updatePlayhead();
    syncPreviewAudio(true);
  };
  if (elem.readyState >= 1) go();
  else elem.addEventListener('loadedmetadata', go, { once: true });
}

// Hands playback from one element to the other, carrying across everything the
// user can see: where it had got to, whether it was running, and how loud.
function useTransport(next) {
  if (next === transport) return;
  const from = transport;
  const at = from.currentTime || 0;
  const playing = !from.paused && !from.ended;
  from.pause();
  transport = next;
  next.volume = from.volume;
  next.playbackRate = from.playbackRate;
  // Loaded only when it is first needed, so that the file is opened a second
  // time only for a source whose picture actually gets switched off.
  const url = previewVideo.getAttribute('src');
  if (next === previewSound && url && previewSound.getAttribute('src') !== url) {
    previewSound.src = url;
  }
  resumeTransport(next, at, playing);
}

// How far the replacement may drift from the video before it is nudged back.
// Re-seeking is audible, so the slack has to be wider than the ordinary jitter
// between two independently clocked media elements.
const AUDIO_SYNC_SLACK = 0.25;

// Mirrors TrimSlider._valueToX and _usableWidth so the waveform and its walls
// land on the same x as the handles in the frame below. The two frames are the
// same width, so matching the inset is all that alignment takes. If that
// geometry changes, this has to change with it.
function sliderMetrics(cssWidth) {
  const handleW = startHandleEl.offsetWidth || 16;
  return { inset: 8 + handleW / 2, usable: Math.max(1, cssWidth - 16 - handleW) };
}

function setAudioStatus(text) {
  audioStatus.textContent = text || '';
  audioStatus.hidden = !text;
}

function activeTrackDuration() {
  if (audioTrack) return audioTrack.duration;
  return media ? media.duration : 0;
}

// Whether there is any audio to draw at all. The same test loadAudioPeaks uses
// to decide there is nothing to read, so the two cannot disagree about it.
function hasAudioTrack() {
  return !!media && (audioTrack !== null || media.hasAudio === true);
}

function drawWaveform() {
  const cssW = audioCanvas.clientWidth;
  const cssH = audioCanvas.clientHeight;
  if (!cssW || !cssH) return;

  // Backing store in device pixels, drawing in CSS pixels, so the waveform is
  // not blurry on a scaled display.
  const dpr = window.devicePixelRatio || 1;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (audioCanvas.width !== wantW || audioCanvas.height !== wantH) {
    audioCanvas.width = wantW;
    audioCanvas.height = wantH;
  }
  const ctx = audioCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!media || !media.duration) return;
  // With no track there is nothing in this frame to mark up: no silence for a
  // baseline to stand for, and no selection or play position within it either.
  // The message in front of the canvas is the whole story, so the frame is left
  // empty behind it rather than dressed with bars that point at nothing.
  if (!hasAudioTrack()) return;

  const { inset, usable } = sliderMetrics(cssW);
  const mid = cssH / 2;
  const half = mid - 3;
  const duration = media.duration;
  const selX0 = inset + (slider.start / duration) * usable;
  const selX1 = inset + (slider.end / duration) * usable;

  // A flat line edge to edge first, so anywhere without audio reads as silence
  // rather than as a hole. The waveform draws over it wherever there is signal,
  // and it is the whole picture where a track runs but is quiet.
  const lineY = mid - 0.5;
  ctx.fillStyle = AUDIO_UNSELECTED;
  ctx.fillRect(0, lineY, cssW, 1);
  ctx.fillStyle = AUDIO_SELECTED;
  ctx.fillRect(selX0, lineY, Math.max(1, selX1 - selX0), 1);

  const wallAt = (x, colour) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x - 1, 2, 2, cssH - 4);
  };

  if (!audioPeaks) {
    wallAt(selX0, AUDIO_WALL_START);
    wallAt(selX1, AUDIO_WALL_END);
    return;
  }

  const trackDur = activeTrackDuration();
  const buckets = audioPeaks.length / 2;
  const gain = volumeGain();

  for (let px = 0; px < usable; px += 1) {
    const t = (px / usable) * duration;
    // A replacement rides the clip's timeline at its offset, so anywhere the
    // track does not reach is simply silent and gets nothing drawn.
    const withinTrack = audioTrack ? t - audioOffset : t;
    if (withinTrack < 0 || withinTrack >= trackDur) continue;

    const b = Math.min(buckets - 1, Math.floor((withinTrack / trackDur) * buckets));
    // Scaled by the volume, clamped to the box. Flattening against the edge is
    // not a drawing artefact: that is the point at which ffmpeg's volume filter
    // would clip too, so it is worth seeing.
    const lo = Math.max(-1, audioPeaks[b * 2] * gain);
    const hi = Math.min(1, audioPeaks[b * 2 + 1] * gain);
    ctx.fillStyle = (t >= slider.start && t <= slider.end) ? AUDIO_SELECTED : AUDIO_UNSELECTED;
    const top = mid - hi * half;
    ctx.fillRect(inset + px, top, 1, Math.max(1, (mid - lo * half) - top));
  }

  wallAt(selX0, AUDIO_WALL_START);
  wallAt(selX1, AUDIO_WALL_END);
}

function updateAudioUi() {
  const hasMedia = media !== null;
  const audioOnly = hasMedia && media.isAudio;
  const hasTrack = hasMedia && (audioTrack !== null || media.hasAudio === true);

  // Dropping the audio of an audio-only file would leave an empty output, so
  // the switch and the replace button do not apply there at all.
  audioEnabledLabel.hidden = audioOnly;
  // ... and the other way round: dropping the sound as well would leave an
  // empty file, so the last one standing cannot be switched off either.
  audioEnabledToggle.disabled = !hasTrack || busy || audioOnly
    || !videoEnabledToggle.checked;
  changeAudioBtn.hidden = audioOnly;
  changeAudioBtn.disabled = !hasMedia || busy;
  resetAudioBtn.hidden = audioTrack === null;
  resetAudioBtn.disabled = busy;
  audioOffsetGroup.hidden = audioTrack === null;
  audioOffsetField.disabled = busy;
  audioSource.textContent = audioTrack ? audioTrack.name : t('Original audio');
  audioSection.dataset.muted = String(!audioEnabledToggle.checked && !audioOnly);
  audioCanvas.classList.toggle('audio-canvas--draggable', audioTrack !== null && !busy);
  updateVideoUi();
  markActiveFormat();
  // Nothing else is in this row while the file's own audio is in use, so the
  // slider gets the room and a finer step with it. A replacement brings the
  // offset field and Use Original back, and the slider returns to the short one,
  // where 5% is as fine as it can usefully be.
  //
  // 2% and not 1%: a step has to be at least a pixel wide or some values fall
  // between two of them and cannot be set with the mouse at all. Measured by
  // pressing along the slider a pixel at a time, 192px at 1% gives 0.88px a step
  // and 100% was unreachable, 99% and 101% being all that could be landed on.
  // At 2% every value keeps about two pixels, and 100% is on the grid of both
  // steps, so it survives the switch between them.
  const wideVolume = audioTrack === null;
  audioSection.dataset.wideVolume = String(wideVolume);
  const wantStep = wideVolume ? '2' : '5';
  if (volumeSlider.step !== wantStep) {
    volumeSlider.step = wantStep;
    // Going the other way leaves the value between two steps, which the next
    // drag would snap without saying so. Better to snap it here, where the
    // readout, the waveform and the preview all follow it.
    const size = Number(wantStep);
    const snapped = Math.round(volumePercent() / size) * size;
    if (snapped !== volumePercent()) {
      volumeSlider.value = String(snapped);
      drawWaveform();
      applyPreviewGain();
    }
  }
  // No audio in the output means nothing for the volume to act on.
  volumeSlider.disabled = !hasTrack || busy || (!audioOnly && !audioEnabledToggle.checked);
  volumeValue.textContent = volumePercent() + '%';
  updatePreviewAudio();
}

// The peaks are bucketed over the track's own length but drawn on the clip's
// timeline, so a replacement longer than the clip has only the fraction of its
// buckets that the frame can reach, and they come out as wide blocks. Asking for
// one bucket per pixel at the clip's scale keeps the bars a pixel wide however
// long the track is.
function wantedBuckets(trackDur) {
  if (!media || !media.duration || !trackDur) return 0;
  const { usable } = sliderMetrics(audioCanvas.clientWidth);
  return Math.ceil((trackDur / media.duration) * usable);
}

async function loadAudioPeaks() {
  audioPeaks = null;
  drawWaveform();
  if (!media) {
    setAudioStatus('');
    return;
  }
  const source = audioTrack ? audioTrack.path : (media.hasAudio ? media.path : null);
  if (!source) {
    setAudioStatus(t('No audio track'));
    return;
  }

  const trackDur = activeTrackDuration();
  const token = ++audioToken;
  setAudioStatus(t('Reading audio...'));
  const result = await window.lwclipper.audioPeaks(source, trackDur, wantedBuckets(trackDur));
  if (token !== audioToken) return; // a newer request has taken over

  if (!result.ok) {
    setAudioStatus(result.error || t('Could not read the audio.'));
    return;
  }
  audioPeaks = result.data.peaks;
  setAudioStatus('');
  drawWaveform();
}

// True when the preview should be sounding the replacement rather than the
// file's own track. Mirrors the condition buildTrimArgs applies to the save, so
// what is heard here is what gets written.
function usingReplacement() {
  return !!(media && !media.isAudio && audioTrack && audioEnabledToggle.checked);
}

// Audio switched off: the saved clip has no sound, so neither does the preview.
function audioSilenced() {
  return !!(media && !media.isAudio && !audioEnabledToggle.checked);
}

// Points previewAudio at the right file, and mutes the video whenever its own
// track is not what a save would produce.
function updatePreviewAudio() {
  const wanted = usingReplacement() ? audioTrack.path : null;
  if (wanted !== previewAudioPath) {
    previewAudioPath = wanted;
    if (wanted) {
      window.lwclipper.fileUrl(wanted).then((url) => {
        // A different track may have been picked while this was resolving.
        if (previewAudioPath === wanted) previewAudio.src = url;
      });
    } else {
      dropPreviewAudio();
    }
  }
  transport.muted = usingReplacement() || audioSilenced();
  previewAudio.volume = transport.volume;
  syncPreviewAudio();
}

// The replacement has no clock of its own: it is placed from the video's
// position on every event that can move, start or stop the video.
// force skips the drift tolerance, for the moments where the video's position
// jumps rather than advances and any leftover drift would be plainly audible.
function syncPreviewAudio(force = false) {
  if (!usingReplacement()) {
    if (!previewAudio.paused) previewAudio.pause();
    return;
  }
  // The offset is on the clip's timeline, the same one the waveform is drawn
  // against, so this is the sum the saved file gets too.
  const at = transport.currentTime - audioOffset;
  if (at < 0 || at >= audioTrack.duration) {
    // The track does not reach this part of the clip, so it is silent here.
    if (!previewAudio.paused) previewAudio.pause();
    return;
  }
  if (force || Math.abs(previewAudio.currentTime - at) > AUDIO_SYNC_SLACK) {
    previewAudio.currentTime = at;
  }
  previewAudio.playbackRate = transport.playbackRate;
  if (transport.paused) {
    if (!previewAudio.paused) previewAudio.pause();
  } else if (previewAudio.paused) {
    // A play() interrupted by the next seek rejects; that is not a failure.
    previewAudio.play().catch(() => {});
  }
}

function volumePercent() {
  return Number(volumeSlider.value);
}

function volumeGain() {
  return volumePercent() / 100;
}

// A media element's own volume caps at 1.0, so anything above 100% has to go
// through a gain node. Built the first time the slider leaves 100% rather than
// at startup: routing an element is permanent, since it can only ever have one
// source node, so anyone who never touches the slider keeps the plain path.
// The element's own volume and muted still apply ahead of this, verified, so
// the mute that a replacement relies on goes on working untouched.
let gainCtx = null;
let videoGain = null;
let soundGain = null;
let trackGain = null;

// One context for the window. The three fixed preview elements want one and so
// does the timeline's mix bus, and a second context would be a second output
// path's worth of latency for nothing. Tried once: a window with no Web Audio
// at all must not retry on every slider move.
let audioContextTried = false;

function ensureAudioContext() {
  if (gainCtx) return gainCtx;
  if (audioContextTried) return null;
  audioContextTried = true;
  try {
    gainCtx = new AudioContext();
  } catch {
    // Callers fall back to plain element playback, which caps at 100%.
    gainCtx = null;
  }
  return gainCtx;
}

let eqAnalyser = null;
let eqLowAnalyser = null;
// Routing an element is a one-way door, so a half-built chain must not be
// retried: the second attempt would throw on the element already wired and
// leave the app trying forever. One flag, set whether it worked or not.
let gainChainTried = false;
// Separate from gainCtx, which no longer implies this: the mix bus may have
// made the context long before the volume slider is touched.
let gainChainBuilt = false;

// What anything audible connects into. Step 10d pulled this out of
// ensureGainChain so the timeline's mix bus can reach the analysers without
// the three fixed preview elements having been wired first: in advanced mode
// they are silent, and before this the spectrum was a picture of that silence
// while the mix played on past it straight to the output.
let eqTail = null;

function ensureAnalysers() {
  if (eqTail) return eqTail;
  const ctx = ensureAudioContext();
  if (!ctx) return null;
  try {
    // Two of them, because resolution and speed pull against each other: the
    // window that tells one low bar from the next is longer than the one that
    // keeps a hi-hat looking sharp. Measured at 48 kHz, on a 60 Hz note:
    //
    //    8192   5.86 Hz bins    77 ms to show up    14 of 75 bars below 100 Hz
    //   16384   2.93 Hz bins   139 ms               28 of 75
    //   32768   1.46 Hz bins   302 ms               51 of 75
    //
    // The bottom of the scale is read from the long window and everything above
    // it from the short one, so neither costs the other anything. The long one
    // is the middle size: the longest is the only one that gives the bottom two
    // octaves a bar apiece, but a third of a second is long enough that a bass
    // line visibly trails the sound it belongs to. Both carry the same settings
    // otherwise, so the two halves of the scale agree about a steady tone.
    const shape = (a, size) => {
      a.fftSize = size;
      a.smoothingTimeConstant = 0.72;
      // The defaults, -100 to -30 dB, put ordinary music at the top of the
      // scale and leave the bars pinned near full height. A wider window gives
      // the loud parts somewhere to go.
      a.minDecibels = -90;
      a.maxDecibels = -10;
      return a;
    };
    const analyser = shape(ctx.createAnalyser(), 8192);
    const lowAnalyser = shape(ctx.createAnalyser(), 16384);
    // An analyser passes its input straight through, so chaining them puts the
    // same signal into both without a splitter, and the sound still comes out.
    analyser.connect(lowAnalyser);
    lowAnalyser.connect(ctx.destination);
    eqAnalyser = analyser;
    eqLowAnalyser = lowAnalyser;
    eqTail = analyser;
  } catch {
    // No analysers to be had; the spectrum stays a flat line and everything
    // else goes to the output as before.
    return null;
  }
  return eqTail;
}

function ensureGainChain() {
  if (gainChainBuilt) return true;
  if (gainChainTried) return false;
  gainChainTried = true;
  const ctx = ensureAudioContext();
  const tail = ensureAnalysers();
  if (!ctx || !tail) return false;
  try {
    // All three meet at the analysers and are passed on to the output, so the
    // spectrum shows whatever is audible. Only one of them sounds at a time,
    // and a muted element contributes silence, which is what makes a
    // replacement track show up here in place of the original.
    const wire = (elem) => {
      const gain = ctx.createGain();
      ctx.createMediaElementSource(elem).connect(gain);
      gain.connect(tail);
      return gain;
    };
    videoGain = wire(previewVideo);
    soundGain = wire(previewSound);
    trackGain = wire(previewAudio);
    gainChainBuilt = true;
  } catch {
    // No gain chain to be had; the preview just stays at its own volume and
    // the spectrum stays a flat line.
    return false;
  }
  return true;
}

function applyPreviewGain() {
  const gain = volumeGain();
  // Nothing to apply and nothing wired yet: leave the plain path alone. Asked
  // of the chain rather than of the context, which the mix bus may have built.
  if (gain === 1 && !gainChainBuilt) return;
  if (!ensureGainChain()) return;
  videoGain.gain.value = gain;
  soundGain.gain.value = gain;
  trackGain.gain.value = gain;
  if (gainCtx.state === 'suspended') gainCtx.resume();
}

// ---- spectrum ----

// Audible range, laid out by octave rather than evenly: half of a linear axis
// would go to 10 kHz and above, where there is little to look at, and squeeze
// everything a voice or a bass line does into the leftmost tenth. Log spacing
// gives the bottom octaves the room they deserve.
const EQ_MIN_HZ = 20;
const EQ_MAX_HZ = 20000;
const EQ_MARKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const EQ_BAR = 2;      // bar width in css pixels
const EQ_GAP = 1;      // and the space between two of them
const EQ_FLOOR = 2;    // a bar this short reads as nothing, so it is left flat
// Where the long window takes over. Below this the short one has fewer bins
// than the scale has bars, so neighbours are handed the same number and move as
// one block: measured on the wide frame, a bar spans about 1.5% of its own
// frequency, which is under one 5.9 Hz bin all the way up to 400 Hz and ten
// bars wide at 40 Hz.
//
// The handover is spread over an octave rather than made at a single frequency.
// The two windows are not measuring the same thing: a bin of the long one covers
// half the bandwidth, so broadband sound lands in it about 3 dB quieter, while a
// steady tone reads the same in both. Switching at a point put a visible step
// into bars whose ordinary neighbour to neighbour variation is about 2 on a 255
// scale. Spread over this range it becomes a tilt of well under one bar's worth.
const EQ_BLEND_LO = 180;
const EQ_BLEND_HI = 400;

let eqRaf = null;

function eqLabel(hz) {
  return hz >= 1000 ? (hz / 1000) + 'k' : String(hz);
}

// Where a frequency sits across the width, 0 at 20 Hz and 1 at 20 kHz.
function eqFraction(hz) {
  return Math.log(hz / EQ_MIN_HZ) / Math.log(EQ_MAX_HZ / EQ_MIN_HZ);
}

function eqFreqAt(fraction) {
  return EQ_MIN_HZ * Math.pow(EQ_MAX_HZ / EQ_MIN_HZ, fraction);
}

function drawSpectrum() {
  const cssW = eqCanvas.clientWidth;
  const cssH = eqCanvas.clientHeight;
  if (!cssW || !cssH) return;

  const dpr = window.devicePixelRatio || 1;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (eqCanvas.width !== wantW || eqCanvas.height !== wantH) {
    eqCanvas.width = wantW;
    eqCanvas.height = wantH;
  }
  const ctx = eqCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const top = 14;                       // room for the frequency labels
  const mid = top + (cssH - top) / 2;
  const half = Math.max(1, (cssH - top) / 2 - 2);

  // The scale first, so the bars are drawn over it rather than under it.
  ctx.font = '9px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (const hz of EQ_MARKS) {
    const x = Math.round(eqFraction(hz) * cssW) + 0.5;
    ctx.fillStyle = 'rgba(220, 220, 230, 0.13)';
    ctx.fillRect(x, top, 1, cssH - top);
    ctx.fillStyle = 'rgba(220, 220, 230, 0.38)';
    // The last label would run off the right edge, so it sits inside its line.
    const text = eqLabel(hz);
    const w = ctx.measureText(text).width;
    const tx = Math.min(x + 3, cssW - w - 1);
    ctx.fillText(text, tx, 2);
  }

  const bins = eqAnalyser ? eqAnalyser.frequencyBinCount : 0;
  const lowBins = eqLowAnalyser ? eqLowAnalyser.frequencyBinCount : 0;
  const nyquist = gainCtx ? gainCtx.sampleRate / 2 : 0;
  let data = null;
  let lowData = null;
  if (bins && nyquist && previewSounding()) {
    data = new Uint8Array(bins);
    eqAnalyser.getByteFrequencyData(data);
    if (lowBins) {
      lowData = new Uint8Array(lowBins);
      eqLowAnalyser.getByteFrequencyData(lowData);
    }
  }

  // A line down the middle whatever happens, so silence reads as a level
  // baseline rather than as a frame that failed to draw.
  ctx.fillStyle = AUDIO_UNSELECTED;
  ctx.fillRect(0, Math.round(mid) - 0.5, cssW, 1);
  if (!data) return;

  // The average over the bins a bar covers, for one of the two analysers.
  const bandAvg = (src, n, f0, f1) => {
    const b0 = Math.min(n - 1, Math.max(0, Math.floor((f0 / nyquist) * n)));
    const b1 = Math.min(n - 1, Math.max(b0, Math.ceil((f1 / nyquist) * n) - 1));
    let sum = 0;
    for (let b = b0; b <= b1; b += 1) sum += src[b];
    return sum / (b1 - b0 + 1);
  };

  const step = EQ_BAR + EQ_GAP;
  ctx.fillStyle = AUDIO_SELECTED;
  for (let x = 0; x + EQ_BAR <= cssW; x += step) {
    // Each bar covers a slice of the axis, which on a log scale is one bin at
    // the bottom and several hundred at the top. Averaging them, not taking the
    // loudest: a max over hundreds of bins reports the single loudest one in a
    // wide band, which lifts the whole top end and draws something that looks
    // like a waveform rather than a spectrum.
    const f0 = eqFreqAt(x / cssW);
    const f1 = eqFreqAt((x + EQ_BAR) / cssW);
    // How much of this bar comes off the long window: all of it at the bottom
    // of the scale, where it is the only thing that tells one bar from the next,
    // none of it above the handover, and a share of it across.
    const fine = !lowData ? 0
      : f0 <= EQ_BLEND_LO ? 1
        : f0 >= EQ_BLEND_HI ? 0
          : Math.log(EQ_BLEND_HI / f0) / Math.log(EQ_BLEND_HI / EQ_BLEND_LO);
    const level = fine === 0 ? bandAvg(data, bins, f0, f1)
      : fine === 1 ? bandAvg(lowData, lowBins, f0, f1)
        : fine * bandAvg(lowData, lowBins, f0, f1)
          + (1 - fine) * bandAvg(data, bins, f0, f1);
    const h = Math.round((level / 255) * half);
    if (h < EQ_FLOOR) continue;
    ctx.fillRect(x, mid - h, EQ_BAR, h * 2);
  }
}

// Whether anything is actually making sound right now. A paused preview should
// settle to the flat line rather than hold the last frame it drew.
function previewSounding() {
  // The timeline's transport belongs to no element, so there is nothing here to
  // ask but the compositor itself.
  if (compositePlaying) return true;
  if (!transport.paused && !transport.ended) return true;
  return !previewAudio.paused && !previewAudio.ended && !!previewAudio.src;
}

function eqTick() {
  eqRaf = null;
  if (eqCanvas.hidden) return;
  drawSpectrum();
  // Keeps running while there is sound, and one last frame after it stops so
  // the bars fall back to the line instead of freezing mid-bounce.
  if (previewSounding()) eqRaf = requestAnimationFrame(eqTick);
}

function startSpectrum() {
  if (eqCanvas.hidden || eqRaf !== null) return;
  eqRaf = requestAnimationFrame(eqTick);
}

function stopSpectrum() {
  if (eqRaf !== null) cancelAnimationFrame(eqRaf);
  eqRaf = null;
}

// Audio sources get the wide frame and the spectrum; anything else, including
// nothing loaded at all, goes back to three picture frames. Driven from the
// current media rather than remembered, so clearing a file cannot leave the
// audio layout stranded behind it.
// Neither stream can be the one that goes: an output with nothing in it is not
// a clip. Whichever is still on is therefore locked on until the other returns.
/**
 * Whether the Video head is on screen at all.
 *
 * Two different subjects on either side of the switch. In simple editing it is
 * about the one media file, and it stays up for a video whose picture has been
 * switched off, being the only way back to the picture. In advanced editing
 * there is no media file and the head belongs to the project: it is up for as
 * long as there is a picture to say the size of.
 *
 * Found while building V2.1's resolution boxes. This used to be one answer
 * worked out from `media`, which in advanced editing is always null, so the
 * head was hidden there always and took the render resolution readout inside it
 * down with it. Nobody had noticed, because until the boxes there was nothing
 * in there anyone could reach for.
 */
function videoHeadShowing() {
  if (timelineDriving()) return layers.length > 0 && !outputIsAudio();
  return media !== null && !media.isAudio;
}

function updateVideoUi() {
  const hasMedia = media !== null;
  const audioOnly = hasMedia && media.isAudio;
  videoHead.hidden = !videoHeadShowing();
  videoEnabledToggle.disabled = !hasMedia || busy || audioOnly
    || !audioEnabledToggle.checked;
  // A source with no picture cannot be in any state but enabled.
  if (audioOnly) videoEnabledToggle.checked = true;
}

function applyPreviewMode() {
  // What the save will write, not what was loaded: a video with its picture
  // switched off has nothing to put in three picture frames either, so it gets
  // the wide frame and the spectrum as well. The Video header stays put in that
  // case, being the only way back to the picture.
  const audioOnly = outputIsAudio();
  previewSection.dataset.audio = String(audioOnly);
  updateCutControls();
  // A source that has a picture, switched off. It differs from a real audio
  // file in two ways the frame has to answer for: the picture would carry on
  // playing behind the spectrum, and Chromium hands the element its full video
  // control bar instead of the compact audio one.
  const pictureOff = audioOnly && !!media && !media.isAudio;
  previewSection.dataset.pictureOff = String(pictureOff);
  // The picture is gone from the frame, so the video element goes with it and
  // the audio element takes over the transport. That is what puts the compact
  // control bar there in place of the video one, and it takes fullscreen and
  // picture-in-picture out of play by leaving them nothing to act on.
  useTransport(pictureOff ? previewSound : previewVideo);
  previewCellTitle.textContent = audioOnly ? 'Equalizer' : 'Preview';
  eqCanvas.hidden = !audioOnly;
  applyCompositeMode();
  if (!audioOnly) {
    stopSpectrum();
    return;
  }
  // The spectrum needs analysers, which the volume slider would otherwise build
  // lazily on its first move, so for an audio source they are built up front.
  // In advanced mode the elements behind ensureGainChain are silent and the
  // sound comes from the mix bus, so only the analysers are wanted there.
  if (timelineDriving()) ensureAnalysers();
  else ensureGainChain();
  if (gainCtx && gainCtx.state === 'suspended') gainCtx.resume();
  drawSpectrum();
  startSpectrum();
}

for (const elem of [previewVideo, previewSound, previewAudio]) {
  elem.addEventListener('play', startSpectrum);
  elem.addEventListener('playing', startSpectrum);
  elem.addEventListener('pause', () => { drawSpectrum(); });
  elem.addEventListener('ended', () => { drawSpectrum(); });
}

window.addEventListener('resize', () => { if (!eqCanvas.hidden) drawSpectrum(); });

// Both preview sources at once: either may be holding the file open, and on
// Windows one remaining handle is enough to make a cache clear silently fail.
function dropPreviewSources() {
  for (const elem of [previewVideo, previewSound]) {
    elem.pause();
    elem.removeAttribute('src');
    elem.load();
  }
}

// Releasing the source releases the handle on the user's file, the same reason
// the preview video's source is dropped before a cache clear.
function dropPreviewAudio() {
  previewAudioPath = null;
  previewAudio.pause();
  previewAudio.removeAttribute('src');
  previewAudio.load();
}

// Wrapped, not passed directly: a listener is handed the event object, which
// would arrive as a truthy `force` and re-seek on every timeupdate.
for (const elem of [previewVideo, previewSound]) {
  for (const evt of ['play', 'pause', 'timeupdate', 'ratechange', 'ended']) {
    elem.addEventListener(evt, () => syncPreviewAudio());
  }
  // A seek is a jump, so the replacement is placed exactly rather than within
  // the drift tolerance it is allowed while simply playing along.
  elem.addEventListener('seeked', () => syncPreviewAudio(true));
}

// Either bar's volume slider drives whichever track is actually being heard,
// and the handover copies the level across, so this fires on both.
for (const elem of [previewVideo, previewSound]) elem.addEventListener('volumechange', () => {
  // The player's own mute button would otherwise bring the file's original
  // track back underneath the replacement. Its volume slider stays useful
  // though: it drives whichever track is actually being heard.
  previewAudio.volume = transport.volume;
  if (!transport.muted && (usingReplacement() || audioSilenced())) transport.muted = true;
});

function fmtOffset(seconds) {
  return (seconds < 0 ? '-' : '+') + fmtTime(Math.abs(seconds));
}

function setAudioOffset(seconds, syncField = true) {
  const trackDur = audioTrack ? audioTrack.duration : 0;
  const span = media ? media.duration : 0;
  // Past either end the track sits entirely outside the clip and nothing of it
  // would be audible, so there is no point letting it go further.
  audioOffset = Math.max(-trackDur, Math.min(span, seconds));
  if (syncField) audioOffsetField.value = fmtOffset(audioOffset);
  drawWaveform();
  syncPreviewAudio();
}

// normalize=false is the live path fired on every keystroke, matching how the
// start/end time boxes behave: it must not rewrite what is being typed.
function applyOffsetField(normalize) {
  const raw = audioOffsetField.value.trim();
  const sign = raw.startsWith('-') ? -1 : 1;
  try {
    setAudioOffset(sign * parseTime(raw.replace(/^[+-]/, '')), normalize);
  } catch {
    // Half-typed value; leave it alone until it parses.
  }
}

function resetAudioState() {
  audioToken += 1;
  window.lwclipper.abortAudioPeaks();
  audioPeaks = null;
  audioTrack = null;
  audioOffset = 0;
  audioOffsetField.value = fmtOffset(0);
  dropPreviewAudio();
}

// Read from the markup rather than repeated here, for the same reason as
// IDLE_STATUS: two copies of the same sentence drift apart.
const HINT_IDLE = hintLabel.textContent;
const TIMELINE_HINT_IDLE = timelineHint.textContent;
// Read before translateDom runs, so it holds the English, which is the key.

// Shared by the trim handles and the waveform drag, so the readout says the
// same thing whichever one is being dragged.
// Both frames, because a marker dragged on the timeline offers the same
// precision as a handle dragged on the slider and only one of the two frames is
// ever on screen to say so. Each keeps its own idle text.
// What the hint lines currently say is not one answer any more: a precision
// drag and a compositor catching up after a scrub both want the timeline's
// line. Kept as state plus one writer, so neither can leave the other's
// message stranded on screen.
let dragFine = 1.0;

function setDragHint(factor) {
  dragFine = factor;
  refreshHints();
}

function refreshHints() {
  const fine = dragFine === 1.0
    ? null
    : t('Fine dragging: {factor}x slower', { factor: Math.round(1 / dragFine) });
  hintLabel.textContent = fine || t(HINT_IDLE);
  // The compositor before the wheel: a scrub that has left layers behind is the
  // more urgent thing to say, and a composite that has stopped changing looks
  // exactly like one that has frozen.
  const behind = catchingUp() ? t('Catching up...') : null;
  timelineHint.textContent = fine || behind || t(TIMELINE_HINT_IDLE);
}

slider.onDragStateChange = setDragHint;

// normalize=false is the live path fired on every keystroke: it moves the
// frames but never rewrites the box being typed in, and tolerates a
// half-finished value instead of snapping the text back mid-edit.
function applyTimeField(field, isStart, normalize) {
  // Not media: in advanced editing the trim belongs to the project and there
  // may be no single file at all. Same subject the markers already use.
  if (!trimmable()) return;
  let value;
  try {
    value = parseTime(field.value);
  } catch {
    if (normalize) field.value = fmtTime(isStart ? slider.start : slider.end);
    return;
  }
  if (isStart) slider.setStart(value, false);
  else slider.setEnd(value, false);
  refreshSelection(normalize ? null : field);
  // normalize is the commit: on blur or Enter, not on every keystroke. Only the
  // field's own frame, for the same reason a marker drag rebuilds only its own.
  if (!normalize) return;
  renderTrimFrames(isStart ? 'start' : 'end');
  commitHistory();
}

for (const [field, isStart] of [[startTimeField, true], [endTimeField, false]]) {
  field.addEventListener('input', () => applyTimeField(field, isStart, false));
  field.addEventListener('blur', () => applyTimeField(field, isStart, true));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTimeField(field, isStart, true);
  });
}
