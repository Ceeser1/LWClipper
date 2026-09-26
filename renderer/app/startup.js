'use strict';

// Resetting, the settings modal and its controls, clearing the cache, and the
// window's start: everything that calls back from the main process is
// subscribed here, once every other file has loaded.

// Back to the state the app opens in, with one deliberate exception: the URL
// field keeps its text, so the same link can be reloaded without pasting it
// again. Everything holding a file handle is dropped first, because Windows
// keeps the cached file locked for as long as a <video> still points at it.
function resetApp() {
  dropPreviewSources();
  startFrame.clear();
  endFrame.clear();
  playUntil = null;
  cropRect = null;
  cropView = null;
  closeCrop();
  updateCropOverlays();

  resetAudioState();
  audioEnabledToggle.checked = true;
  volumeSlider.value = '100';
  applyPreviewGain();
  setAudioStatus('');

  media = null;
  probed = null;
  selectedFormatBtn = null;
  formatRow.querySelectorAll('button').forEach((b) => b.remove());
  formatPlaceholder.hidden = false;
  qualityListWanted = true;
  qualitiesPending = false;
  updateMainFrame();

  // The trim belongs to whichever subject the slider is currently about. In
  // simple editing that is the media file being cleared, so it goes with it. In
  // advanced editing it is the project's own in and out points, and Clear is
  // about the frame at the top of the window, not about the timeline: wiping
  // them here silently threw away part of the project.
  if (!timelineDriving()) {
    slider.reset();
    startTimeField.value = fmtTime(0);
    endTimeField.value = fmtTime(0);
  }
  // Not setTrimEnabled(false). media has just been nulled, so in simple editing
  // trimmable() is already false and this says exactly what it used to. In
  // advanced editing there is still a project, and switching the save row off
  // for it left Save Project and Export dead with no way back: the only thing
  // still offering to save was the warning on the way out.
  setTrimEnabled(!busy && trimmable());

  titleLabel.textContent = '';
  errorHint.hidden = true;
  saveNotice.hidden = true;
  setProgress(0, '');
  setStatus(IDLE_STATUS);
  updateStatusScale();
  updateClearBtn();
  updateAudioUi();
  drawWaveform();
  updatePlayhead();
}

clearBtn.addEventListener('click', () => {
  if (busy) return;
  resetApp();
});

// Any click anywhere dismisses the save confirmation, the overlay itself
// included. On the document rather than the overlay so a click on any other
// control clears it too. Capture phase, so the click that dismisses cannot also
// be acted on by whatever sits underneath. The click that started the save is
// long finished by the time the job resolves, so it cannot self-dismiss.
document.addEventListener('click', (evt) => {
  if (!saveNotice.hidden) saveNotice.hidden = true;
  // V2.6. The same gesture, for the same reason, on the thing that has taken
  // the save notice's place in advanced editing: a message holds the top frame
  // open, and something has to close it again. A click inside the frame is not
  // that gesture, or pressing a quality button would clear the line that says
  // which video the qualities belong to on the way in.
  if (!busy && timelineDriving() && statusSpeaks()
    && !(evt.target && evt.target.closest && evt.target.closest('#mainDrop'))) {
    setStatus(IDLE_STATUS);
    updateStatusScale();
    updateMainFrame();
  }
}, true);

// Redundant with the document listener above, which already catches this click
// in the capture phase. Kept so the button is not a control with nothing wired
// to it, and so it still works if that listener is ever narrowed.
dismissNoticeBtn.addEventListener('click', () => {
  saveNotice.hidden = true;
});

// Square, and exactly as tall as the buttons it stands beside. Their height is
// the row's 1.5x font plus its padding, which is not a number the stylesheet
// can be told up front, so it is measured and handed back as both sides of this
// one. Re-run on resize so it survives a font or zoom change.
function sizeSettingsBtn() {
  const side = loadBtn.getBoundingClientRect().height;
  if (!side) return;
  settingsBtn.style.width = side + 'px';
  settingsBtn.style.height = side + 'px';
}

sizeSettingsBtn();
window.addEventListener('resize', () => {
  sizeSettingsBtn();
  // One request only moves the window by what was short or spare at the time,
  // and the move changes both. Re-measuring here is what lets it walk down to
  // the right size instead of stopping part way: each step is smaller than the
  // last, and the 4px dead zone in main ends it. A resize the user performed
  // themselves has already switched the fit off, so this asks for nothing.
  fitWindow();
});

// The lists come from the main process rather than being retyped here, so they
// cannot drift from what the open dialog actually accepts.
settingsBtn.addEventListener('click', async () => {
  refreshSettingsPanel();
  const types = await window.lwclipper.supportedTypes();
  const list = (xs) => xs.map((e) => e.toUpperCase()).join(', ');
  el('supportedVideo').textContent = list(types.video);
  el('supportedAudio').textContent = list(types.audio);
  el('supportedVideoOut').textContent = list((types.videoOut || []).map((f) => f.label));
  el('supportedAudioOut').textContent = list((types.audioOut || []).map((f) => f.label));
  settingsModal.hidden = false;
});

function closeSettings() {
  settingsModal.hidden = true;
}

settingsCloseBtn.addEventListener('click', closeSettings);

bindPopup(settingsModal, closeSettings);

// One Escape cancels one popup, the one on top.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = topPopup();
  if (top) top.cancel();
});

openCachedBtn.addEventListener('click', () => {
  // The loaded clip is worth pointing at, but only if it is one of the cached
  // ones, which is decided in the main process where the cache folder is known.
  window.lwclipper.openCacheFolder(media ? media.path : null);
});

loadCachedBtn.addEventListener('click', async () => {
  if (busy) return;
  const result = await window.lwclipper.loadLocalMedia();
  if (result.cancelled) return;
  if (result.project) {
    await openProjectPath(result.path);
    return;
  }
  if (!result.ok) {
    reportFailure(result);
    updateStatusScale();
    return;
  }
  // V2.8. The rule the main drop zone has followed since V2.1, now on the
  // button beside it: in advanced editing there is no single media file for the
  // window to be a view of, so a file opened here becomes a track. It used to
  // load into simple editing's media, which advanced editing does not show, so
  // the button looked like it had done nothing at all.
  if (timelineDriving()) {
    addLayerFromMedia(result.data.isAudio ? 'audio' : 'video', result.data);
    return;
  }
  adoptLocalMedia(result.data);
});

languageSelect.addEventListener('change', async () => {
  applySettingsPayload(await window.lwclipper.setSettings({
    language: languageSelect.value,
  }));
  refreshSettingsPanel();
});

bestCompressionToggle.addEventListener('change', async () => {
  appSettings = (await window.lwclipper.setSettings({
    bestCompression: bestCompressionToggle.checked,
  })).settings;
  applyBestCompression();
  updateCompressionState();
});

/**
 * Throw the advanced editing switch, from the tick box or from anything else.
 *
 * Pulled out of the listener because opening a project is the other thing that
 * needs it: the box has to follow, not only the setting, or the settings panel
 * shows the opposite of what the window is doing.
 */
async function setAdvancedEditing(on) {
  appSettings = (await window.lwclipper.setSettings({ advancedEditing: on })).settings;
  advancedEditingToggle.checked = !!appSettings.advancedEditing;
  applyAdvancedEditing();
}

advancedEditingToggle.addEventListener('change', () => {
  setAdvancedEditing(advancedEditingToggle.checked);
});

changeCacheBtn.addEventListener('click', async () => {
  if (busy) return;
  const result = await window.lwclipper.chooseCacheFolder();
  if (result.cancelled) return;
  // Main carried whatever the old folder held across, so the size on the line
  // below stays what it was rather than dropping to zero.
  appSettings = result.settings;
  refreshSettingsPanel();
  refreshToolsLabel();
});

openAppFilesBtn.addEventListener('click', () => {
  window.lwclipper.openAppFiles();
});

// The confirmation and the deleting both live in the main process, which is the
// only side that can put a real dialog up and outlive itself long enough to
// remove a folder it is running out of.
deleteAppFilesBtn.addEventListener('click', () => {
  if (busy) return;
  window.lwclipper.deleteAppFiles();
});

/**
 * Ask before clearing, when there is anything to ask about.
 *
 * Answers with the claim ids to give up, or null for cancelled. An empty list
 * is a real answer rather than a refusal: it means take whatever nothing
 * claims, which is every file in the folder when no project has claimed one.
 *
 * Two warnings and either can be absent. A cache with no claims, and nothing
 * cached open, is the plain clear this button has always been, with no modal at
 * all. One modal and not one per mode: claims are claims whichever mode is on,
 * and a cache full of files held by projects is exactly as undeletable from
 * simple editing as from advanced. Only the wording of the first line differs.
 *
 * What is open warns only when what is open is really in the cache, which is
 * asked of the main process so that it is the same test the deletion makes. A
 * warning that clearing deletes a file it cannot touch is worse than no warning
 * at all, because the next one is believed less.
 */
async function confirmClear() {
  const { claims, sizes } = await window.lwclipper.listClaims();
  const open = await window.lwclipper.cachedNames(
    timelineDriving() ? layers.map((l) => l.src) : [media && media.path]);
  if (!claims.length && !open.length) return [];

  const names = Object.keys(sizes);
  const mb = (bytes) => (bytes / 1048576).toFixed(1);
  // Through claim.js rather than by adding the rows up: a file two ticked
  // projects share is counted in neither row, so the rows sum to less than the
  // clear would free. This is the number the deletion will actually produce,
  // because it is the deletion's own rule being asked.
  const freedBy = (ids) => projectClaim.deletableFiles(claims, ids, names)
    .reduce((total, f) => total + (sizes[f] || 0), 0);

  // Two calls rather than one with a ternary in it, for the reason spelled out
  // over setProjectError: the checker sees a literal after t( and nothing else.
  const messages = [];
  if (open.length && timelineDriving()) {
    messages.push(t('Warning! You are currently working on {files}. Clearing the cache now removes them.', { files: open.join(', ') }));
  } else if (open.length) {
    messages.push(t('Warning! You are currently working on {name}. Clearing now without saving first deletes your clip.', { name: open[0] }));
  }
  if (claims.length) {
    messages.push(t('Warning! You have cached project files that might be unfinished. Select the cached project files you want to be removed.'));
  }

  let ticked = [];
  const choice = await showChoice({
    title: t('Clear cache'),
    message: messages,
    checks: projectClaim.rowsFor(claims, sizes).map((row) => ({
      id: row.id,
      label: row.name,
      // The path as the tooltip, because two projects can be called the same
      // thing and the row is being asked to identify one of them.
      title: row.path,
      note: t('{mb} MB', { mb: mb(row.bytes) }),
      // Listed and flagged rather than swept: a project moved to another drive
      // would otherwise silently lose its protection.
      badge: row.missing ? t('Missing') : '',
    })),
    onCheck: (ids) => { ticked = ids; },
    footer: (ids) => t('Clearing now frees {mb} MB.', { mb: mb(freedBy(ids)) }),
    buttons: [
      { id: 'clear', label: t('Clear now'), tone: 'danger' },
      // Primary, which is both the green the design asks for and where the
      // focus lands, so Enter on a question about deleting files means Cancel.
      { id: 'cancel', label: t('Cancel'), primary: true },
    ],
    cancel: 'cancel',
  });
  return choice === 'clear' ? ticked : null;
}

clearCacheBtn.addEventListener('click', async () => {
  if (busy) return;
  // Step 18. Before anything is dropped or deleted: Cancel has to leave the
  // preview holding exactly what it held, which it cannot do once the source
  // has been let go of.
  const ticked = await confirmClear();
  if (!ticked) return;
  // Windows keeps a lock on whatever the preview holds open, and a locked file
  // silently survives the clear, so drop the source before deleting.
  dropPreviewSources();
  releaseComposite();
  startFrame.clear();
  endFrame.clear();
  const freedMb = await window.lwclipper.clearCache(ticked);
  syncComposite();
  media = null;
  // The same fault Clear had, in the second of the two places that ended on a
  // hard false. media has just been nulled, so simple editing is unaffected:
  // trimmable() is false there and this says what it always said. Advanced
  // editing still has a project, and switching the save row off for it left
  // Export, Save Project on the row, the frame rate and the trim slider all
  // dead with nothing to bring them back.
  //
  // Clearing the cache does not touch the timeline. It can delete files a
  // project references, which is a real and separate problem, but the answer to
  // that is the missing-files modal on the next open, not disabling the buttons
  // that would let the work be saved first.
  setTrimEnabled(!busy && trimmable());
  updateClearBtn();
  titleLabel.textContent = '';
  updateStatusScale();
  setProgress(0, '');
  setStatus('Cache cleared, {mb} MB freed.', { mb: freedMb.toFixed(1) });
  refreshToolsLabel();
  refreshSettingsPanel();
});

// Everything the main process calls back into is subscribed here, once every
// part of the page has loaded: a reply that landed while the later files were
// still loading would find functions that were not there yet.
//
// Registered once, not per job: preload adds a listener on every call, so
// wiring this inside the download/save handlers stacked up duplicates.
window.lwclipper.onProgress(({ frac, text }) => setProgress(frac, text));
// The window is held shut until this answers. Closing with unsaved work is the
// second user of showChoice and the reason it was built as a pair.
window.lwclipper.onClosing(async () => {
  if (await confirmDiscard()) window.lwclipper.allowClose();
});
window.lwclipper.onWindowState((state) => setWindowMaxed(!!(state && state.maximized)));
window.lwclipper.windowMaximized().then((maxed) => setWindowMaxed(!!maxed));
setBusy(false);
updateAudioUi();
drawWaveform();
refreshToolsLabel();
// Translates the interface and fills the settings panel. Async, so the first
// frame is English even when another language is saved; it is one frame.
loadSettings();
// Builds the format toggle from what the main process says it can write. Async,
// so the row starts empty for a frame; nothing is enabled until a file is
// loaded anyway.
loadOutputChoices();
