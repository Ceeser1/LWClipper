'use strict';

// The window's shared parts: translation, the element table, settings, the
// status line, the frame at the top, the output formats and running a job.

// ---- translation ----
//
// The English text is the key, so anything with no entry in the table falls
// through to itself: a half-finished translation reads as English rather than
// as blanks, and a new string works before anyone has translated it. The tables
// are read off disk by the main process, out of locales/.
let localeStrings = {};
// The same table read backwards. Text written by script while another language
// was showing carries that language's words, and this is what recognises them
// as a translation and recovers the English key behind them.
let reverseStrings = {};

function setLocale(table) {
  localeStrings = table || {};
  reverseStrings = {};
  for (const [english, translated] of Object.entries(localeStrings)) {
    // First one wins. If two English strings share a translation there is no
    // way back, and picking the later one would be no more right than the first.
    if (!(translated in reverseStrings)) reverseStrings[translated] = english;
  }
}

function t(text, vars) {
  const out = localeStrings[text] || text;
  if (!vars) return out;
  return out.replace(/\{(\w+)\}/g, (whole, name) => (
    name in vars ? String(vars[name]) : whole
  ));
}

// What a node said in English, kept from the first time it was seen. Switching
// language twice would otherwise try to translate an already translated string
// and find nothing, leaving the interface stuck in whichever language it
// reached first.
const englishText = new WeakMap();
const englishPlaceholder = new WeakMap();

/**
 * Translates the static interface in place. Anything written by script goes
 * through t() at the point it is written instead, since this only knows about
 * text that is already in the document.
 */
function translateDom(root = document.body, wasShowing = {}) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      // V3. What the user typed and the names of their fonts are not the app's
      // words, even when one of them happens to be spelt like a key.
      if (node.parentElement && node.parentElement.closest('[data-no-translate]')) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
  for (const node of nodes) {
    if (!englishText.has(node)) {
      // A node script wrote while another language was up is not English, and
      // storing it as if it were is what would strand it in that language
      // forever. wasShowing maps it back.
      const fresh = node.nodeValue;
      const showing = fresh.trim().replace(/\s+/g, ' ');
      englishText.set(node, wasShowing[showing]
        ? fresh.replace(fresh.trim(), wasShowing[showing])
        : fresh);
    }
    const original = englishText.get(node);
    const raw = original.trim();
    // A paragraph wrapped across several lines of markup arrives with the
    // newlines and indentation still in it. The key is that run collapsed to
    // single spaces, which is how the locale file writes it and how anyone
    // translating it would expect to see it.
    const key = raw.replace(/\s+/g, ' ');
    // Swapped in where the original sat rather than replacing the whole value,
    // so the space that separates a checkbox from its label survives.
    node.nodeValue = original.replace(raw, t(key));
  }
  // Only placeholders: the one title attribute in the app is a file path, and
  // caching that as "English" would freeze it at whatever it first said.
  for (const elem of root.querySelectorAll('[placeholder]')) {
    if (!englishPlaceholder.has(elem)) {
      englishPlaceholder.set(elem, elem.getAttribute('placeholder'));
    }
    elem.setAttribute('placeholder', t(englishPlaceholder.get(elem)));
  }
}

const urlField = el('urlField');
const pasteBtn = el('pasteBtn');
const loadBtn = el('loadBtn');
const formatRow = el('formatRow');
const formatPlaceholder = el('formatPlaceholder');
const qualitySection = el('qualitySection');
const qualityMain = el('qualityMain');
const titleSection = el('titleSection');
const titleMain = el('titleMain');
const mainFrameBody = el('mainFrameBody');
const mainActions = el('mainActions');
const cancelBtn = el('cancelBtn');
const titleLabel = el('titleLabel');
const progressBar = el('progressBar');
const statusLabel = el('statusLabel');
const previewVideo = el('previewVideo');
const previewSound = el('previewSound');
const previewAudio = el('previewAudio');
const previewSection = el('previewSection');
const previewCellTitle = el('previewCellTitle');
const eqCanvas = el('eqCanvas');
const compositeCanvas = el('compositeCanvas');
const compositePool = el('compositePool');
const compositePlayBtn = el('compositePlayBtn');
const startFrameCanvas = el('startFrameCanvas');
const endFrameCanvas = el('endFrameCanvas');
const startFrameBusy = el('startFrameBusy');
const endFrameBusy = el('endFrameBusy');
const startFrameVideo = el('startFrameVideo');
const endFrameVideo = el('endFrameVideo');
const previewGrid = document.querySelector('.preview-grid');
// Step 21c-3. Two handles, one value: what either of them drags is how wide
// both side columns are, so the layout stays mirrored without anything having
// to keep the two edges agreeing.
const sideSplitterLeft = el('sideSplitterLeft');
const sideSplitterRight = el('sideSplitterRight');
const previewStage = el('previewStage');
const startFrameStage = el('startFrameStage');
const endFrameStage = el('endFrameStage');
const previewCropBox = el('previewCropBox');
const startCropBox = el('startCropBox');
const endCropBox = el('endCropBox');
const playSelectionBtn = el('playSelectionBtn');
const openProjectBtn = el('openProjectBtn');
const projectNameLabel = el('projectName');
const choiceModal = el('choiceModal');
const choiceTitle = el('choiceTitle');
const choiceMessage = el('choiceMessage');
const choiceList = el('choiceList');
const choiceFooter = el('choiceFooter');
const choiceButtons = el('choiceButtons');

const cropBtn = el('cropBtn');
const cropModal = el('cropModal');
const cropStage = el('cropStage');
const cropCanvas = el('cropCanvas');
const cropBox = el('cropBox');
const cropHint = el('cropHint');
const cropSize = el('cropSize');
const cropEncodeNote = el('cropEncodeNote');
const cropPresets = el('cropPresets');
const cropAcceptBtn = el('cropAcceptBtn');
const cropRemoveBtn = el('cropRemoveBtn');
const cropCancelBtn = el('cropCancelBtn');
const cropZoomSlider = el('cropZoomSlider');
const cropZoomValue = el('cropZoomValue');
const cropArrowUp = el('cropArrowUp');
const cropArrowDown = el('cropArrowDown');
const cropArrowLeft = el('cropArrowLeft');
const cropArrowRight = el('cropArrowRight');
const cropPanHint = el('cropPanHint');
const cropTabs = el('cropTabs');
const cropTabFrame = el('cropTabFrame');
const cropTabPlace = el('cropTabPlace');
const cropFramePanel = el('cropFramePanel');
const cropZoomRow = el('cropZoomRow');
const placePanel = el('placePanel');
const placeStage = el('placeStage');
const placeCanvas = el('placeCanvas');
const placeBox = el('placeBox');
const placeSize = el('placeSize');
const placeHint = el('placeHint');
const placeScaleRow = el('placeScaleRow');
const placeScaleSlider = el('placeScaleSlider');
const placeScaleValue = el('placeScaleValue');
const startTimeField = el('startTimeField');
const endTimeField = el('endTimeField');
const hintLabel = el('hintLabel');
const spanLabel = el('spanLabel');
const accurateToggle = el('accurateToggle');
const accurateLabel = el('accurateLabel');
const fpsLabel = el('fpsLabel');
const fpsSelect = el('fpsSelect');
const videoEnabledToggle = el('videoEnabledToggle');
const renderResolution = el('renderResolution');
const renderResolutionText = el('renderResolutionText');
const videoHead = el('videoHead');
const formatToggle = el('formatToggle');
const compressionToggle = el('compressionToggle');
const compressionSlider = el('compressionSlider');
const compressionValue = el('compressionValue');
const openCachedBtn = el('openCachedBtn');
const saveBtn = el('saveBtn');
const quickSaveBtn = el('quickSaveBtn');
const saveNotice = el('saveNotice');
const saveNoticeText = el('saveNoticeText');
const dismissNoticeBtn = el('dismissNoticeBtn');
const openSavedBtn = el('openSavedBtn');
const settingsBtn = el('settingsBtn');
const settingsModal = el('settingsModal');
const settingsCloseBtn = el('settingsCloseBtn');
const toolsLabel = el('toolsLabel');
const toolsSection = el('toolsSection');
const languageSelect = el('languageSelect');
const languageFlag = el('languageFlag');
const cacheSummary = el('cacheSummary');
const changeCacheBtn = el('changeCacheBtn');
const bestCompressionToggle = el('bestCompressionToggle');
const advancedEditingToggle = el('advancedEditingToggle');
const openAppFilesBtn = el('openAppFilesBtn');
const deleteAppFilesBtn = el('deleteAppFilesBtn');

// ---- settings ----

let appSettings = {
  language: 'en', cacheDir: null, bestCompression: false, advancedEditing: false,
};

// The picture shown beside the language dropdown, per language code.
const LANGUAGE_FLAGS = { en: 'english', de: 'german' };

// "Auto pre-select best quality to file-size ratio" is a default, not a lock,
// and where the knee sits is not the same step for every format:
//
//   25%  MP4, MOV and WebM, where the scale was built around it: CRF 23 is
//        x264's own default and VP9's 41 was matched to it by VMAF. MP3 too, at
//        192 kbit/s, which is about where LAME stops being told apart.
//   50%  AAC and Ogg. Both carry further per byte than MP3 does, so 128 kbit/s
//        and Vorbis q4 buy the same ear for fewer of them.
//   75%  FLAC, which is lossless at every level it offers. Quality cannot move,
//        so the only thing left to weigh is size against encode time and the
//        smallest file wins. That is effort level 12, not the level 5 sitting
//        at 25%.
//
// The video steps were measured here; the audio ones are the encoders' own
// well-worn numbers rather than anything this project put a score against.
const BEST_COMPRESSION_STEPS = { aac: '50', ogg: '50', flac: '75' };
const BEST_COMPRESSION_DEFAULT = '25';

function applyBestCompression() {
  const format = currentFormat();
  if (!appSettings.bestCompression || !format || !format.steps) return;
  // Video only re-encodes on an accurate cut, so ticking the compression box on
  // its own would grey it straight back out and leave the output exactly as it
  // was. Audio encodes at every step and does not show the option at all, so
  // there it is left alone.
  if (!outputIsAudio()) accurateToggle.checked = true;
  compressionToggle.checked = true;
  compressionSlider.value = BEST_COMPRESSION_STEPS[format.key] || BEST_COMPRESSION_DEFAULT;
}

/**
 * One class on the body, which the stylesheet reads to decide which of the two
 * editing frames is in the flow. Kept as the only thing the switch does, so
 * that with it off there is nothing left for the window to be different about.
 */
function applyAdvancedEditing() {
  document.body.classList.toggle('advanced', !!appSettings.advancedEditing);
  // The trim means a different thing on each side of this switch.
  applyTrimSubject();
  // The timeline frame has no width at all while it is out of the flow, so it
  // can only be drawn once the class is on. Ordered after the toggle for that
  // reason, not by accident.
  applyCompositeMode();
  // Step 11. The crop's subject is the media on one side of this switch and a
  // layer on the other, and the white outline belongs only to the first.
  updateCropBtn();
  updateCropOverlays();
  updateProjectUi();
  updateMainFrame();
  // Step 15. Quick-Save exists because it is instant and asks nothing, and in
  // advanced editing every save re-encodes a composite, so neither half is
  // true: it becomes Save Project, which is the thing here that really is
  // instant. And Save As renders a timeline for minutes rather than cutting a
  // clip out of a file, which is what Export says and Save As does not.
  const advanced = timelineDriving();
  // Written as four t() calls rather than two with a ternary inside, because
  // check-locales.js reads literals and a string it cannot see is a string
  // nobody is told is missing.
  quickSaveBtn.textContent = advanced ? t('Save Project') : t('Quick-Save');
  saveBtn.textContent = advanced ? t('Export...') : t('Save As...');
  buildFormatToggle();
  // Step 21c. The timeline frame is out of the flow in simple editing, so the
  // split has to be put back on the stack rather than assumed to have survived.
  applySplit();
  drawTimeline();
  updatePlayhead();
  // The two frames are not the same height, so the section above them has a
  // different amount of room to scale the previews into.
  fitWindow();
}

function applySettingsPayload(payload) {
  appSettings = payload.settings;
  // Kept before the table is swapped: it is the language currently on screen
  // that anything script-written is written in.
  const wasShowing = reverseStrings;
  setLocale(payload.strings);
  if (languageSelect.options.length !== payload.languages.length) {
    languageSelect.replaceChildren();
    for (const lang of payload.languages) {
      const option = document.createElement('option');
      option.value = lang.code;
      // Not translated: a language is named the same whatever the interface is
      // set to, which is the point of showing both spellings.
      option.textContent = lang.label;
      languageSelect.appendChild(option);
    }
  }
  languageSelect.value = appSettings.language;
  // Named for the language rather than for its code, so the two are paired
  // here. A language with no flag to show simply shows none.
  const flag = LANGUAGE_FLAGS[appSettings.language];
  languageFlag.hidden = !flag;
  if (flag) languageFlag.src = '../images/' + flag + '.png';
  bestCompressionToggle.checked = !!appSettings.bestCompression;
  advancedEditingToggle.checked = !!appSettings.advancedEditing;
  // The rows carry text written by script, so translateDom cannot reach them.
  renderLayerRows();
  applyAdvancedEditing();
  translateDom(document.body, wasShowing);
  // The buttons this one is measured against have just been relabelled.
  sizeSettingsBtn();
  updateRenderResolution();
  // Written by script, so translateDom cannot reach them: re-run the ones that
  // own text of their own. The status line is redrawn from the key it was last
  // given rather than from what is on screen, which has its placeholders
  // already filled in.
  retranslateStatus();
  refreshToolsLabel();
  updateAudioUi();
}

async function loadSettings() {
  applySettingsPayload(await window.lwclipper.getSettings());
}

// The size is read when the panel opens rather than kept up to date behind it,
// which is the only moment anyone can see it.
async function refreshSettingsPanel() {
  const status = await window.lwclipper.toolsStatus();
  cacheSummary.textContent = t('{mb} MB - Located at {path}', {
    mb: status.cacheSizeMb.toFixed(0),
    path: status.cacheDir,
  });
}
const loadCachedBtn = el('loadCachedBtn');
const clearCacheBtn = el('clearCacheBtn');
const cookiesToggle = el('cookiesToggle');
const cookieBrowser = el('cookieBrowser');
const errorHint = el('errorHint');
const audioSection = el('audioSection');
const audioEnabledToggle = el('audioEnabledToggle');
const audioEnabledLabel = el('audioEnabledLabel');
const audioSource = el('audioSource');
const audioCanvas = el('audioCanvas');
const audioStatus = el('audioStatus');
const audioOffsetGroup = el('audioOffsetGroup');
const audioOffsetField = el('audioOffsetField');
const changeAudioBtn = el('changeAudioBtn');
const volumeSlider = el('volumeSlider');
const volumeValue = el('volumeValue');
const resetAudioBtn = el('resetAudioBtn');
const startHandleEl = el('startHandle');
const clearBtn = el('clearBtn');
const mainDrop = el('mainDrop');
const mainDropHint = el('mainDropHint');
const audioDropHint = el('audioDropHint');
const audioPlayhead = el('audioPlayhead');
const trimPlayhead = el('trimPlayhead');
const trimSliderEl = el('trimSlider');
// Step 21c. Between the preview and whichever editing frame is up, and it
// belongs to neither: what it drags is how the two divide the column.
const editSplitter = el('editSplitter');
const layersSplitter = el('layersSplitter');
const timelineStage = el('timelineStage');
const timelineRuler = el('timelineRuler');
// Where time is measured from. The lane starts after the layer headers, so x
// inside it is the same x the ruler is drawn against and the view arithmetic
// needs no offset anywhere.
const timelineLane = el('timelineLane');
const timelineStack = el('timelineStack');
const timelineBeyond = el('timelineBeyond');
const timelineOutsideStart = el('timelineOutsideStart');
const timelineOutsideEnd = el('timelineOutsideEnd');
const timelinePlayhead = el('timelinePlayhead');
const timelineTrimIn = el('timelineTrimIn');
const timelineTrimOut = el('timelineTrimOut');
const timelineHint = el('timelineHint');
const progressRow = el('progressRow');

// Captured from the markup rather than duplicated as a literal, so the
// reset can never drift out of step with what the app opens showing.
const IDLE_STATUS = statusLabel.textContent;

// What the status line last said, as the English key and whatever filled it.
// The line is written by script and its placeholders are already filled in by
// the time it reaches the DOM, so the text on screen matches no key and
// translateDom cannot put it into another language. Keeping the pieces is what
// lets a language switch draw it again. Every write of that label goes through
// here, or the switch would restore a line that has since been replaced.
let lastStatus = null;

function setStatus(key, vars) {
  lastStatus = key ? { key, vars } : null;
  statusLabel.textContent = key ? t(key, vars) : '';
  // V2.6. In advanced editing the frame this line lives in is only up while it
  // has something to say, and this is the line that says it. Here rather than
  // at the fifteen call sites, because a message that arrived without the frame
  // to show it would be a message nobody ever sees.
  updateMainFrame();
}

// Whether the status line is saying anything beyond the standing invitation to
// load something. Read off lastStatus rather than off the element, because the
// element's text is translated and the key is not.
function statusSpeaks() {
  return !!lastStatus && lastStatus.key !== IDLE_STATUS;
}

function retranslateStatus() {
  if (lastStatus) statusLabel.textContent = t(lastStatus.key, lastStatus.vars);
}

// Seeking a <video> is asynchronous, and firing a new seek while one is still
// running just drops it. So keep only the latest wanted time and apply it when
// the element reports it is finished, which keeps the frames tracking a drag
// without queueing up hundreds of stale seeks.
function makeFrameSeeker(video) {
  let wanted = null;
  let seeking = false;

  function pump() {
    if (seeking || wanted === null) return;
    if (!video.getAttribute('src') || video.readyState < 1) return; // wait for metadata
    let t = Math.max(0, wanted);
    wanted = null;

    const limit = video.duration;
    if (Number.isFinite(limit) && limit > 0 && t >= limit) {
      // There is usually no decodable frame exactly at the duration, and asking
      // for it can leave the element showing nothing. Back off just inside it.
      t = Math.max(0, limit - 0.05);
    }
    // Assigning the position it already holds may produce no 'seeked' event at
    // all, which would leave this waiting forever for a reply that never comes.
    if (Math.abs(video.currentTime - t) < 0.001) return;

    seeking = true;
    video.currentTime = t;
  }

  video.addEventListener('seeked', () => { seeking = false; pump(); });
  video.addEventListener('loadedmetadata', pump);
  video.addEventListener('loadeddata', pump);

  // Swapping the source aborts any seek already in flight, so its 'seeked'
  // never arrives. Without clearing the flag here the seeker stays wedged and
  // the frame never updates again for the rest of the session.
  for (const evt of ['emptied', 'loadstart', 'abort', 'error']) {
    video.addEventListener(evt, () => { seeking = false; });
  }

  return {
    seek(time) { wanted = time; pump(); },
    load(url) {
      wanted = null;
      seeking = false;
      video.src = url;
    },
    clear() {
      wanted = null;
      seeking = false;
      video.removeAttribute('src');
      video.load();
    },
  };
}

const startFrame = makeFrameSeeker(startFrameVideo);
const endFrame = makeFrameSeeker(endFrameVideo);

// null means "send no cookies at all", which is the normal case.
function cookieChoice() {
  return cookiesToggle.checked ? { browser: cookieBrowser.value } : null;
}

const slider = new TrimSlider(el('trimSlider'), el('startHandle'), el('endHandle'), el('trimFill'));

let probed = null;
let media = null;
let selectedFormatBtn = null;
let busy = false;
let playUntil = null;

function setBusy(v) {
  busy = v;
  loadBtn.disabled = v;
  loadCachedBtn.disabled = v;
  cookiesToggle.disabled = v;
  cookieBrowser.disabled = v || !cookiesToggle.checked;
  cancelBtn.disabled = !v;
  // Idle means there is no progress to show, so the bar goes away and the
  // status line becomes the headline instead.
  progressRow.hidden = !v;
  if (v) {
    errorHint.hidden = true;
    saveNotice.hidden = true;
  }
  updateMainFrame();
  setTrimEnabled(!v && trimmable());
  updateCompositeUi();
  updateClearBtn();
  updateAudioUi();
  updateStatusScale();
}

// Enabled only once something is loaded, and hidden outright mid-job: while a
// job runs the progress row owns that frame, and resetting under a running
// ffmpeg/yt-dlp is what Cancel is for.
function updateClearBtn() {
  clearBtn.hidden = busy;
  clearBtn.disabled = !media;
}

// ---- the frame at the top of the window ----
//
// Simple editing keeps the two frames it has always had: the title with its
// Clear button, and the quality picker under it.
//
// Advanced editing has one. The title frame there is a headline for a single
// media file that advanced mode is not a view of, and the quality frame below
// it spends almost all of its life saying that no video is loaded, so between
// them they were most of the height above the timeline and were about nothing.
// Merged, one frame says whichever of those four things is currently true.
//
// The nodes are moved, not duplicated. There is one status line, one progress
// bar, one Cancel button and one Clear button in the document however the
// switch is set, which is the only way the two layouts cannot come to disagree
// about what the app is doing.

// Whether the quality picker has a place in the layout at all. Simple editing
// shows it with its placeholder from the moment a link is loaded, and hides it
// for a local file, which has no qualities to offer.
let qualityListWanted = true;

// Whether it is actually waiting for a choice. Advanced editing shows it only
// then: "when a load is done, and hidden again once a button is clicked".
let qualitiesPending = false;

let mainFrameSignature = '';

/**
 * Whether the frame at the top of the window has anything to say.
 *
 * V2.6, and only asked in advanced editing: "Remove the title frame (drag and
 * drop zone) since the timeline already has drag and dropable layers and
 * Unsaved Project like a possible title already." Both of those are true, so
 * what is left in that frame when nothing is happening is an empty headline
 * over a prompt to load a file, taking the height of two rows to say nothing.
 *
 * It is a collapse rather than a removal, because the frame is also the only
 * place four other things are shown: a job's progress bar, the Cancel button
 * that stops it, the list of qualities a pasted link is waiting on, and the
 * cookie hint. Those are what bring it back. A status line with something to
 * report brings it back too, and the click that dismisses the save notice puts
 * it away again, which is the whole of its life.
 */
function mainFrameSpeaks() {
  return busy || qualitiesPending || !errorHint.hidden || statusSpeaks();
}

function updateMainFrame() {
  const advanced = timelineDriving();
  // Simple editing keeps both frames whatever is happening; the rule below is
  // only ever about the merged one.
  const speaks = !advanced || mainFrameSpeaks();

  // Relocation, guarded so this is free to call as often as anything changes.
  if (advanced) {
    if (titleMain.parentElement !== mainFrameBody) mainFrameBody.prepend(titleMain);
    if (mainActions.parentElement !== qualitySection) qualitySection.appendChild(mainActions);
    // Out of the progress row and in beside Clear, which is free exactly when
    // Cancel is needed: Clear hides itself for the duration of a job.
    if (cancelBtn.parentElement !== mainActions) mainActions.prepend(cancelBtn);
  } else {
    if (titleMain.parentElement !== titleSection) titleSection.prepend(titleMain);
    if (mainActions.parentElement !== titleSection) titleSection.appendChild(mainActions);
    if (cancelBtn.parentElement !== progressRow) progressRow.appendChild(cancelBtn);
  }

  titleSection.hidden = advanced;
  // V2.6. The merged frame is up when it has something to say and gone when it
  // has not. The drop zone around it goes with it, gap and margin and all: it
  // is the "(drag and drop zone)" of the request, and an empty layer row is the
  // one that takes a file in this mode anyway.
  qualitySection.hidden = advanced ? !speaks : !qualityListWanted;
  mainDrop.hidden = advanced && !speaks;
  qualityMain.hidden = advanced ? !qualitiesPending : false;
  // In simple editing the progress row hides Cancel by hiding itself. In
  // advanced editing it lives outside that row and has to say so on its own.
  cancelBtn.hidden = advanced && !busy;

  // The frame changes height when the picker or the progress row comes and
  // goes, and the window is sized to its contents. Only on a real change,
  // because this runs on every busy transition.
  const now = [advanced, titleSection.hidden, qualitySection.hidden,
    mainDrop.hidden, qualityMain.hidden, cancelBtn.hidden].join(',');
  if (now === mainFrameSignature) return;
  mainFrameSignature = now;
  fitWindow();
}

// Whichever line is actually informative gets the large treatment: before a
// video is loaded that is the status prompt, afterwards it is the video title.
function updateStatusScale() {
  const idle = !busy && !titleLabel.textContent;
  statusLabel.classList.toggle('status-label--big', idle);
  // An empty title still claims its min-height, which pushed the idle prompt to
  // the bottom of a frame taller than the one line it holds. Collapsing it only
  // in the idle case keeps the reserved space during a load, where the title
  // arrives mid-job and would otherwise jog the layout when it lands.
  titleLabel.hidden = idle;
}

// ---- output format ----

// Both lists come from the main process, off the same table the encoders read,
// so the buttons cannot offer a format the app has no encoder for. Each entry
// carries what the compression slider should read at its four steps, or null
// where the format has nothing to compress.
let outputChoices = { video: [], audio: [] };
let outputFormat = 'mp4';

// What the save will actually write. A video source with its picture switched
// off produces an audio file, so the whole save row follows this rather than
// following what the source happens to be.
function outputIsAudio() {
  // In advanced editing the project decides, not a media file this mode is not
  // a view of. The design's "no global video switch any more": with every video
  // layer disabled or gone there is no picture to write, so the output is audio
  // and the preview frame shows the spectrum instead of the composite.
  if (timelineDriving()) {
    // An empty project is not an audio project, it is an empty one, and
    // announcing it as audio would put an equalizer where a user has not yet
    // put anything at all.
    if (!layers.length) return false;
    // V3. A generated layer is a picture with no file behind it.
    return !layers.some((l) => l.type === 'video' && l.enabled && (l.src || l.kind === 'gen'));
  }
  if (!media) return false;
  return !!media.isAudio || !videoEnabledToggle.checked;
}

/**
 * Whether there is anything for the save row to write.
 *
 * Not trimmable(), which deliberately answers yes to either subject so that a
 * file loaded before the switch keeps its slider. The save row writes one
 * particular file, and which subject it comes from is the whole question here:
 * an empty project with a media file still loaded has nothing to export.
 */
function savable() {
  return timelineDriving() ? layers.length > 0 : !!media;
}

function currentOutputs() {
  return outputIsAudio() ? outputChoices.audio : outputChoices.video;
}

function currentFormat() {
  return currentOutputs().find((f) => f.key === outputFormat) || currentOutputs()[0] || null;
}

// null here means the format has no compression to offer, which is what
// switches the control off for WAV rather than leaving it there doing nothing.
function currentSteps() {
  const f = currentFormat();
  return f ? f.steps : null;
}

// Rebuilt rather than shown and hidden, because a video source and an audio one
// do not offer the same formats or even the same number of them.
function buildFormatToggle() {
  const outputs = currentOutputs();
  formatToggle.querySelectorAll('button').forEach((b) => b.remove());
  const has = (key) => outputs.some((f) => f.key === key);
  if (!has(outputFormat)) {
    // Falling back through the source's own format means switching the picture
    // off and on again lands back where it started rather than on the default.
    const source = media && media.sourceFormat;
    outputFormat = has(source) ? source : (outputs.length ? outputs[0].key : 'mp4');
  }
  for (const f of outputs) {
    const btn = document.createElement('button');
    btn.textContent = f.label;
    btn.dataset.format = f.key;
    btn.addEventListener('click', () => {
      if (busy) return;
      outputFormat = f.key;
      markActiveFormat();
      applyBestCompression();
      updateCompressionState();
    });
    formatToggle.appendChild(btn);
  }
  markActiveFormat();
}

function markActiveFormat() {
  formatToggle.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('btn--active', b.dataset.format === outputFormat);
    b.disabled = busy || !savable();
  });
}

/**
 * Which of the two controls has the first slot of the save row.
 *
 * Frames in an audio file are about 26 ms, so a copied cut already lands within
 * one of the asked-for point and Frame-accurate cut has nothing to offer. And
 * every composite is re-encoded from a filter graph, so in advanced editing
 * there is no copy mode for it to choose between either. Hidden rather than
 * disabled in both cases: it is not a decision, so it is not shown as one.
 *
 * Advanced editing has a decision to put there instead, and only there: the
 * rate the project renders at. Neither control shows for an audio-only output,
 * which has no frames to be accurate about and no rate to write.
 */
function updateCutControls() {
  const audio = outputIsAudio();
  accurateLabel.hidden = audio || timelineDriving();
  fpsLabel.hidden = audio || !timelineDriving();
  updateFpsChoices();
}

// What the design asks the dropdown to offer. Whole numbers, because these are
// the rates someone picks on purpose; a project that came in at 29.97 keeps it
// through the extra entry below rather than by this list growing every
// broadcast rate there has ever been.
const FPS_CHOICES = [15, 24, 30, 48, 60];

/**
 * Fill the dropdown and put the project's own rate in it.
 *
 * Three things go in the list: the five standard rates, every rate a source on
 * this timeline actually runs at, and whatever the project is set to now.
 *
 * The middle one is what makes the control reversible. A 29.97 source seeds a
 * 29.97 project, and offering only the five after that would mean picking 24 by
 * accident costs you the source's own rate, with Ctrl+Z the only way back and
 * only until the next few edits bury it. The sources are on the timeline and
 * can be asked at any time, so there is no reason for their rates to expire.
 *
 * The project's own rate is in there for the case where it came from a source
 * that has since been deleted. Showing the nearest of the five instead would
 * say the project renders at a rate it does not.
 *
 * Rebuilt rather than patched, because the extra entries come and go with the
 * layers and half a dozen options is not something worth diffing. The signature
 * is what keeps that from happening on every redraw.
 */
function updateFpsChoices() {
  if (fpsLabel.hidden) return;
  const round = (n) => Math.round(n * 1000) / 1000;
  const current = round(projectFrame().fps);
  const offered = [...new Set(FPS_CHOICES
    .concat(layers.map((l) => round(l.sourceFps || 0)))
    .concat([current])
    .filter((fps) => fps > 0))].sort((a, b) => a - b);
  const signature = offered.join(',') + '@' + current;
  if (fpsSelect.dataset.signature === signature) return;
  fpsSelect.dataset.signature = signature;
  fpsSelect.textContent = '';
  for (const fps of offered) {
    const option = document.createElement('option');
    option.value = String(fps);
    // A number in every language, so deliberately not a translatable string.
    option.textContent = String(fps);
    fpsSelect.appendChild(option);
  }
  fpsSelect.value = String(current);
}

/**
 * The project renders at a different rate from now on.
 *
 * A commit point, unlike the format buttons and the compression slider it sits
 * beside. Those say how to write this one file and are gone the moment it is
 * written; this is written into the .lwc and changes what every later export
 * is, which puts it on the document's side of that line however close together
 * the two sit on screen.
 */
fpsSelect.addEventListener('change', () => {
  const fps = Number(fpsSelect.value);
  if (!timelineDriving() || busy || !(fps > 0)) return;
  compositeFrame = { ...projectFrame(), fps };
  updateFpsChoices();
  updateProjectUi();
  commitHistory();
});

// V2.8 took setProjectFrame out with the two boxes that were its only caller.
// The project frame is decided in the Crop Render window now, and that window's
// Accept writes each layer's rectangle from where it is pinned, which is
// strictly more than rescaling every layer by the frame's change. Routing it
// through a function that rescales first would have meant rescaling and then
// overwriting the result. One road in, and git has the old one.

async function loadOutputChoices() {
  const types = await window.lwclipper.supportedTypes();
  outputChoices = { video: types.videoOut || [], audio: types.audioOut || [] };
  buildFormatToggle();
  updateCompressionState();
}

// Copy mode re-encodes nothing, so there is no size to trade there and the
// control follows Frame-accurate cut. An audio-only cut has no such mode: the
// checkbox is itself what forces the encode, so it stands on its own there.
function updateCompressionState() {
  const steps = currentSteps();
  // A format with nothing to compress does not get to keep a ticked box.
  if (!steps) compressionToggle.checked = false;
  const isAudio = outputIsAudio();
  const modeAllows = isAudio || timelineDriving()
    || (accurateToggle.checked && !accurateToggle.disabled);
  const canCompress = !!steps && modeAllows && savable() && !busy;
  compressionToggle.disabled = !canCompress;
  compressionSlider.disabled = !canCompress || !compressionToggle.checked;
  const index = Math.round(Number(compressionSlider.value) / 25);
  compressionValue.textContent = steps
    ? (steps[index] || steps[steps.length - 1])
    : compressionSlider.value + '%';
  // A bitrate needs about twice the room a percentage does, and reserving the
  // wider of the two at all times is what left the readout stranded from the
  // slider. The class follows the mode instead.
  compressionValue.classList.toggle('compression-value--rate',
    !!steps && !steps[0].endsWith('%'));
}

// Unchecked is null rather than 0%, and the two are not the same thing: 0% is
// the best setting the format offers, while null means leave the stream alone
// where that is possible at all. Video has always encoded at step 0 when the
// cut is accurate and still does, so its output is unchanged either way.
function compressionPercent() {
  return compressionToggle.checked ? Number(compressionSlider.value) : null;
}

function setTrimEnabled(on) {
  // Every path that loads or clears a file ends up here, which is what keeps
  // the wide audio frame from outliving the audio file that asked for it.
  applyPreviewMode();
  el('trimSlider').dataset.disabled = on ? 'false' : 'true';
  startTimeField.disabled = !on;
  endTimeField.disabled = !on;
  accurateToggle.disabled = !on;
  // The other occupant of that slot, gated the same way: an empty project has
  // no rate worth choosing and a running render has already been handed one.
  fpsSelect.disabled = !on;
  // The other half of the project's geometry, gated on the same answer. It is
  // reached through here rather than read directly because this is the one
  // place that hears about a render starting and finishing.
  updateRenderResolution();
  saveBtn.disabled = !(on && !busy && savable());
  quickSaveBtn.disabled = !(on && !busy && savable());
  updateCompressionState();
  playSelectionBtn.disabled = !on;
  updateCropBtn();
  if (!on) spanLabel.textContent = '';
  // Every path that loads or clears a file comes through here, which is the one
  // place the timeline has to be redrawn from whatever else it also does.
  drawTimeline();
}

// Sites that gate content behind an account fail in a way that says nothing
// about cookies, so the hint has to point at the setting that fixes it. Which
// advice applies depends on whether cookies are already switched on.
const AUTH_ERROR_RE =
  /not logged in|nicht eingeloggt|log ?in|sign ?in|authenticat|unauthor|forbidden|private|members[ -]only|account|premium|subscri|cookie/i;

function reportFailure(result) {
  if (result.cancelled) {
    setStatus('Cancelled.');
    errorHint.hidden = true;
    return;
  }
  const message = String(result.error || '');
  setStatus('Error: {message}', { message });

  if (!AUTH_ERROR_RE.test(message)) {
    errorHint.hidden = true;
    return;
  }
  errorHint.textContent = cookiesToggle.checked
    ? t('You may need to select the correct browser or close the tab/leave the site to prevent double-login rejection')
    : t('You may need to enable using cookies');
  errorHint.hidden = false;
}

function setProgress(frac, text) {
  if (frac !== null && frac !== undefined) progressBar.value = Math.min(1, Math.max(0, frac));
  // Progress text arrives worded by the job that produced it, so there is no
  // key to keep and nothing for a language switch to redraw. Forgetting the
  // last line here is what stops the switch putting a stale one back over it.
  if (text) {
    lastStatus = null;
    statusLabel.textContent = text;
  }
}

async function refreshToolsLabel() {
  const status = await window.lwclipper.toolsStatus();

  // The three tools ship inside the app, so listing them all as "ok" is noise
  // in the normal case. They can still go missing though: Windows Defender
  // quarantines yt-dlp.exe often enough that it is worth detecting, and without
  // this the only symptom is a confusing error at download time. So say nothing
  // when healthy, and name the exact file when not.
  const missing = [];
  if (!status.ytdlp) missing.push('yt-dlp.exe');
  if (!status.ffmpeg) missing.push('ffmpeg.exe');
  if (!status.ffprobe) missing.push('ffprobe.exe');

  // The cache line lives in Settings now, so all this frame has left to say is
  // that something went missing. With nothing to say it is not there at all,
  // which is the row of height the main window gets back.
  toolsSection.hidden = missing.length === 0;
  if (missing.length) {
    toolsLabel.textContent = t(
      '{files} missing from the app folder, check whether antivirus quarantined it.',
      { files: missing.join(', ') },
    );
    toolsLabel.dataset.warn = 'true';
  }
}

async function runJob(fn) {
  setBusy(true);
  try {
    await fn();
  } finally {
    setBusy(false);
    refreshToolsLabel();
  }
}

cookiesToggle.addEventListener('change', () => {
  cookieBrowser.disabled = !cookiesToggle.checked;
});

accurateToggle.addEventListener('change', updateCompressionState);

audioEnabledToggle.addEventListener('change', () => {
  updateAudioUi();
  drawWaveform();
});

changeAudioBtn.addEventListener('click', async () => {
  if (busy || !media) return;
  const result = await window.lwclipper.openAudioTrack();
  if (result.cancelled) return;
  if (!result.ok) {
    setAudioStatus(result.error || t('That file could not be read.'));
    return;
  }
  setAudioTrack(result.data);
});

// A file off disk has no probe behind it, so the quality list left over from
// any previous link goes, and with it the start offset inherited from that
// link. Shared by Open File and by a file dropped on the main zone.
async function adoptLocalMedia(data) {
  // Simple editing is a view of one media file with a length to trim, and a
  // still has no length to trim. V2.3 said exactly that and refused the file.
  //
  // **V2.8 takes it instead.** The user, on 2026-09-24: "Instead it should just
  // accept it and put into the timeline as a video layer." So the mode follows
  // the file, which is the rule a .lwc has gone by since Step 17: handing the
  // app something only one mode can hold is asking for that mode. Nothing is
  // lost in the switch either, because the media simple editing was showing is
  // still loaded and still there when the switch goes back.
  //
  // Handled here rather than at each of the ways in, so there is one answer:
  // the Open File button, a drop on the frame and a drop on the audio frame
  // with nothing loaded all arrive through this.
  if (data && data.isImage) {
    if (!timelineDriving()) await setAdvancedEditing(true);
    addLayerFromMedia('video', data);
    return;
  }
  probed = null;
  formatRow.querySelectorAll('button').forEach((b) => b.remove());
  formatPlaceholder.hidden = false;
  selectedFormatBtn = null;
  qualityListWanted = false;
  qualitiesPending = false;
  updateMainFrame();
  onMediaReady(data);
}

// Shared by Change Audio and by a file dropped on the audio frame, so a
// replacement arrives in the same state whichever way it was chosen.
function setAudioTrack(track) {
  audioTrack = track;
  audioOffset = 0;
  audioOffsetField.value = fmtOffset(0);
  audioEnabledToggle.checked = true;
  updateAudioUi();
  loadAudioPeaks();
}

resetAudioBtn.addEventListener('click', () => {
  if (busy) return;
  resetAudioState();
  audioEnabledToggle.checked = media ? media.hasAudio === true : true;
  updateAudioUi();
  loadAudioPeaks();
});

volumeSlider.addEventListener('input', () => {
  volumeValue.textContent = volumePercent() + '%';
  drawWaveform();
  applyPreviewGain();
});

audioOffsetField.addEventListener('input', () => applyOffsetField(false));
audioOffsetField.addEventListener('change', () => applyOffsetField(true));
audioOffsetField.addEventListener('blur', () => {
  audioOffsetField.value = fmtOffset(audioOffset);
});

// Drag the waveform to slide a replacement along the clip. Pointer capture so
// the drag survives the cursor leaving the canvas, same as the trim handles.
audioCanvas.addEventListener('pointerdown', (e) => {
  if (!audioTrack || busy || !media) return;
  const { usable } = sliderMetrics(audioCanvas.clientWidth);
  const drag = { anchorX: e.clientX, anchorOffset: audioOffset, factor: modifierFactor(e) };
  setDragHint(drag.factor);

  const onMove = (ev) => {
    const factor = modifierFactor(ev);
    if (factor !== drag.factor) {
      // Re-anchored the same way the trim handles are: the new rate carries on
      // from where the track sits now rather than jumping.
      drag.anchorX = ev.clientX;
      drag.anchorOffset = audioOffset;
      drag.factor = factor;
      setDragHint(factor);
    }
    const delta = ((ev.clientX - drag.anchorX) / usable) * media.duration * drag.factor;
    setAudioOffset(drag.anchorOffset + delta);
  };
  const onUp = (ev) => {
    setDragHint(1.0);
  };
  beginDrag(audioCanvas, e, onMove, onUp, true);
});
