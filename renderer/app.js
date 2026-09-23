'use strict';

// ---- pure time helpers (mirrors src/backend.js; kept local since renderer
// runs without nodeIntegration and can't require() the shared module) ----
function fmtTime(seconds, ms = true) {
  seconds = Math.max(0, seconds);
  const h = Math.floor(seconds / 3600);
  const rest = seconds - h * 3600;
  const m = Math.floor(rest / 60);
  const s = rest - m * 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  if (ms) return `${pad2(h)}:${pad2(m)}:${s.toFixed(3).padStart(6, '0')}`;
  return `${pad2(h)}:${pad2(m)}:${pad2(Math.floor(s))}`;
}

function parseTime(text) {
  const raw = (text || '').trim().replace(/,/g, '.');
  if (!raw) throw new Error('empty time');
  const parts = raw.split(':');
  if (parts.length > 3) throw new Error('not a time');
  let total = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isFinite(v)) throw new Error('not a time');
    total = total * 60 + v;
  }
  if (total < 0) throw new Error('negative time');
  return total;
}

// ---- dual-handle trim slider, with Shift/Ctrl precision drag ----
const FINE_SHIFT = 0.10;
const FINE_CTRL = 0.01;

// Module level rather than a method, because the audio waveform drag offers the
// same precision and has to read the modifiers exactly the same way.
function modifierFactor(evt) {
  if (evt.ctrlKey) return FINE_CTRL;
  if (evt.shiftKey) return FINE_SHIFT;
  return 1.0;
}

class TrimSlider {
  constructor(rootEl, startHandleEl, endHandleEl, fillEl) {
    this.root = rootEl;
    this.startHandle = startHandleEl;
    this.endHandle = endHandleEl;
    this.fill = fillEl;
    this.duration = 1;
    this.start = 0;
    this.end = 1;
    this.minSpan = 0.05;
    this.onChange = null;
    this.onDragStateChange = null;
    this._drag = null;

    this._bindHandle(this.startHandle, true);
    this._bindHandle(this.endHandle, false);
    window.addEventListener('resize', () => this._reposition());
  }

  setRange(duration, start, end) {
    this.duration = Math.max(duration, this.minSpan);
    this.start = this._clamp(start);
    this.end = this._clamp(end);
    this._enforceGap(false);
    this._reposition();
  }

  // Back to the constructor's values. Deliberately skips _enforceGap, which
  // would shove the handles minSpan apart; a fresh slider has them stacked at
  // the far left, and this has to look identical to that.
  reset() {
    this.duration = 1;
    this.start = 0;
    this.end = 0;
    this._reposition();
  }

  setStart(value, notify = true) {
    this.start = this._clamp(value);
    this._enforceGap(true);
    this._reposition();
    if (notify && this.onChange) this.onChange(this.start, this.end);
  }

  setEnd(value, notify = true) {
    this.end = this._clamp(value);
    this._enforceGap(false);
    this._reposition();
    if (notify && this.onChange) this.onChange(this.start, this.end);
  }

  _clamp(v) { return Math.min(Math.max(v, 0), this.duration); }

  _enforceGap(startMoved) {
    if (this.end - this.start >= this.minSpan) return;
    if (startMoved) {
      this.end = Math.min(this.duration, this.start + this.minSpan);
      this.start = Math.min(this.start, this.end - this.minSpan);
    } else {
      this.start = Math.max(0, this.end - this.minSpan);
      this.end = Math.max(this.end, this.start + this.minSpan);
    }
  }

  _usableWidth() {
    const w = this.root.clientWidth;
    const handleW = this.startHandle.offsetWidth || 16;
    return Math.max(1, w - 16 - handleW); // 16 = track's left+right inset
  }

  _valueToX(value) {
    const usable = this._usableWidth();
    const half = (this.startHandle.offsetWidth || 16) / 2;
    return 8 + half + (value / this.duration) * usable;
  }

  _xToValueDelta(deltaPixels) {
    const usable = this._usableWidth();
    return (deltaPixels / usable) * this.duration;
  }

  _reposition() {
    const startX = this._valueToX(this.start);
    const endX = this._valueToX(this.end);
    const half = (this.startHandle.offsetWidth || 16) / 2;
    this.startHandle.style.left = (startX - half) + 'px';
    this.endHandle.style.left = (endX - half) + 'px';
    this.fill.style.left = startX + 'px';
    this.fill.style.width = Math.max(0, endX - startX) + 'px';
  }

  _bindHandle(handle, isStart) {
    handle.addEventListener('pointerdown', (evt) => {
      handle.setPointerCapture(evt.pointerId);
      const factor = modifierFactor(evt);
      this._drag = {
        isStart, anchorX: evt.clientX,
        anchorValue: isStart ? this.start : this.end,
        factor,
      };
      if (this.onDragStateChange) this.onDragStateChange(factor);
      evt.preventDefault();
    });

    handle.addEventListener('pointermove', (evt) => {
      if (!this._drag || this._drag.isStart !== isStart) return;
      const factor = modifierFactor(evt);
      if (factor !== this._drag.factor) {
        // Modifier changed mid-drag: re-anchor so the new rate continues
        // from where the handle sits now, no jump.
        this._drag.anchorX = evt.clientX;
        this._drag.anchorValue = isStart ? this.start : this.end;
        this._drag.factor = factor;
        if (this.onDragStateChange) this.onDragStateChange(factor);
      }
      const delta = this._xToValueDelta(evt.clientX - this._drag.anchorX) * this._drag.factor;
      const newValue = this._drag.anchorValue + delta;
      if (isStart) this.setStart(newValue);
      else this.setEnd(newValue);
    });

    const endDrag = (evt) => {
      if (handle.hasPointerCapture(evt.pointerId)) handle.releasePointerCapture(evt.pointerId);
      this._drag = null;
      if (this.onDragStateChange) this.onDragStateChange(1.0);
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }
}

// ---- main controller ----
const el = (id) => document.getElementById(id);

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
const renderResolutionEdit = el('renderResolutionEdit');
const frameWidthBox = el('frameWidthBox');
const frameHeightBox = el('frameHeightBox');
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
const timelineStage = el('timelineStage');
const timelineRuler = el('timelineRuler');
// Where time is measured from. The lane starts after the layer headers, so x
// inside it is the same x the ruler is drawn against and the view arithmetic
// needs no offset anywhere.
const timelineLane = el('timelineLane');
const timelineStack = el('timelineStack');
const timelineBeyond = el('timelineBeyond');
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

function updateMainFrame() {
  const advanced = timelineDriving();

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
  // The merged frame is always up: it is the only one, and it always has at
  // least the prompt to show.
  qualitySection.hidden = advanced ? false : !qualityListWanted;
  qualityMain.hidden = advanced ? !qualitiesPending : false;
  // In simple editing the progress row hides Cancel by hiding itself. In
  // advanced editing it lives outside that row and has to say so on its own.
  cancelBtn.hidden = advanced && !busy;

  // The frame changes height when the picker or the progress row comes and
  // goes, and the window is sized to its contents. Only on a real change,
  // because this runs on every busy transition.
  const now = [advanced, titleSection.hidden, qualitySection.hidden,
    qualityMain.hidden, cancelBtn.hidden].join(',');
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
    return !layers.some((l) => l.type === 'video' && l.enabled && l.src);
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

/**
 * The project renders at a different size from now on.
 *
 * A commit point for the same reason the rate above is one: it goes into the
 * .lwc and it changes what every later export is, however close to the format
 * buttons it happens to sit on screen.
 *
 * Every placed layer travels with it, in one gesture rather than two, so Ctrl+Z
 * takes the frame and the placements back together. Where they land, and why
 * that rather than leaving their numbers alone, is in geometry.rescaleRender.
 *
 * Refused while the project has no shape of its own. projectFrame() substitutes
 * a fallback so there is something to draw before a decoder has answered, and
 * accepting a size against that would freeze the fallback as the project's own
 * and stop the first source from ever seeding it.
 */
function setProjectFrame(width, height) {
  if (!timelineDriving() || busy || !compositeFrame) return false;
  const size = layerGeometry.frameSize(width, height);
  if (!size) return false;
  const from = compositeFrame;
  if (size.width === from.width && size.height === from.height) return false;
  compositeFrame = { ...from, width: size.width, height: size.height };
  sizeCompositeCanvas();
  // Through setLayers even when no layer moved, because the composite canvas
  // and the two trim frames are all pictures of a frame that has just changed
  // shape and none of them redraws itself.
  setLayers(layers.map((l) => (l.render
    ? { ...l, render: layerGeometry.rescaleRender(l.render, from, size) }
    : l)));
  commitHistory();
  return true;
}

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
function adoptLocalMedia(data) {
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
  audioCanvas.setPointerCapture(e.pointerId);
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
    if (audioCanvas.hasPointerCapture(ev.pointerId)) audioCanvas.releasePointerCapture(ev.pointerId);
    audioCanvas.removeEventListener('pointermove', onMove);
    audioCanvas.removeEventListener('pointerup', onUp);
    audioCanvas.removeEventListener('pointercancel', onUp);
    setDragHint(1.0);
  };
  audioCanvas.addEventListener('pointermove', onMove);
  audioCanvas.addEventListener('pointerup', onUp);
  audioCanvas.addEventListener('pointercancel', onUp);
});


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

function setDropActive(on) {
  const active = on && !busy;
  mainDrop.dataset.drop = String(active);
  mainDropHint.hidden = !active;
  const audioOn = active && audioDropAllowed();
  audioSection.dataset.drop = String(audioOn);
  audioDropHint.hidden = !audioOn;
  if (!active) setDropHover(null);
}

// Both zones light up for the whole drag, so the one under the pointer is
// marked separately to say which of them would actually take the file.
function setDropHover(zone) {
  mainDrop.dataset.dropHover = String(zone === mainDrop);
  audioSection.dataset.dropHover = String(zone === audioSection && audioDropAllowed());
  for (const track of document.querySelectorAll('.layer-track[data-empty-type]')) {
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
  return node.closest('.layer-track[data-empty-type], #mainDrop, #audioSection');
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
  if (filePath) openIntoLayer(zone.dataset.emptyType, filePath);
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
  const wasWhole = slider.end >= trimSpan - 0.001;
  trimSpan = total;
  if (total <= 0) {
    slider.reset();
  } else {
    const start = Math.min(slider.start, Math.max(0, total - slider.minSpan));
    const end = wasWhole ? total
      : Math.min(Math.max(slider.end, start + slider.minSpan), total);
    slider.setRange(total, start, end);
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
  else slider.setRange(total, 0, total);
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

// ---- timeline ----
//
// Advanced editing's replacement for the Trim frame. Step 6 builds the surface
// only: a ruler, a playhead, click to seek, wheel to zoom and the two trim
// markers. There are no layers yet, so the one thing on it is the loaded media,
// which is deliberate. Driving something that already works is what makes this
// frame's own bugs findable before layers can be blamed for them.
//
// The arithmetic lives in timelineView.js and is tested there. What is left
// here is the part that needs a window: canvases, pointers and wheels.

// How long a marker drag has to hold still before its frame is built where it
// stands. Set by the user at a quarter second: long enough that a continuous
// drag never triggers one, short enough that pausing feels like asking.
const TRIM_DWELL_MS = 250;

const TIMELINE_BAND = 'rgba(90, 140, 220, 0.18)';
const TIMELINE_TICK_MAJOR = '#8a8a94';
const TIMELINE_TICK_MINOR = '#4e4e58';
const TIMELINE_LABEL = '#9a9aa4';

// One wheel notch. Chosen so about four notches double the zoom, which is slow
// enough to land on a span deliberately and fast enough to cross a long clip.
const TIMELINE_ZOOM_STEP = 1.19;

// Pixels per second and the second at the left edge. Replaced wholesale on
// every gesture rather than edited, the same as the layer model.
let tlView = { scale: 1, scroll: 0 };

// Whether the view is still the one a newly loaded clip gets rather than one
// the user chose. A fitted view refits when the window changes width; a chosen
// one is only re-clamped, so widening the window does not throw the zoom away.
//
// It has to be tested for exactly, because zooming out no longer stops at the
// fitted view: it carries on past the end of the clip and out to the headroom,
// so "at or below the fit scale" would call half the zoom range fitted.
let tlFitted = true;

/**
 * How much timeline there is: where the last layer ends, or where the loaded
 * media ends, whichever is further.
 *
 * The media half is temporary. Until Step 10 the preview is still the single
 * media file, so the ruler has to span it even before any layer exists, or
 * there is nothing to seek along. Once the compositor lands, the answer is the
 * layers alone.
 */
function timelineDuration() {
  const fromMedia = media ? media.duration || 0 : 0;
  return Math.max(fromMedia, timelineModel.totalDuration(layers));
}

/** Back to showing the whole clip, which is where a newly loaded one starts. */
function resetTimelineView() {
  tlFitted = true;
}

/**
 * The stack's scrollbar comes and goes with the number of rows, and it narrows
 * the tracks without narrowing the pinned ruler above them. Stepping the ruler
 * and the lane back by the same amount is what keeps a second at the same x on
 * every row. Measured rather than assumed: the width is the browser's business.
 */
function syncScrollbarInset() {
  const bar = Math.max(0, timelineStack.offsetWidth - timelineStack.clientWidth);
  timelineStage.style.setProperty('--timeline-scrollbar', bar + 'px');
}

/** Whether the view a gesture just produced is still the fitted one. */
function noteTimelineFit(width) {
  tlFitted = tlView.scroll === 0
    && tlView.scale === timelineView.fitScale(timelineDuration(), width);
}

/**
 * Bring the view in line with the width it is actually being drawn at. The
 * frame is display:none in simple editing, so its width is 0 until the setting
 * is switched on, and it changes again with every window resize.
 */
function syncTimelineView() {
  const duration = timelineDuration();
  const width = timelineLane.clientWidth;
  if (!duration || !width) return;
  if (tlFitted) {
    tlView = timelineView.fitView(duration, width);
    return;
  }
  const scale = timelineView.clampScale(tlView.scale, duration, width);
  tlView = { scale, scroll: timelineView.clampScroll(tlView.scroll, scale, duration, width) };
}

function positionTimelineMarkers() {
  const duration = timelineDuration();
  const show = duration > 0 && timelineLane.clientWidth > 0;
  timelineTrimIn.hidden = !show;
  timelineTrimOut.hidden = !show;
  timelineBeyond.hidden = !show;
  if (!show) return;
  timelineTrimIn.style.left = timelineView.timeToX(tlView, slider.start) + 'px';
  timelineTrimOut.style.left = timelineView.timeToX(tlView, slider.end) + 'px';
  // Anchored at the right edge, so it only needs its left told to it. Clamped
  // at zero, or scrolling past the content would put it off the left and leave
  // a sliver of undimmed headroom at the edge.
  const endX = Math.max(0, timelineView.timeToX(tlView, duration));
  timelineBeyond.style.left = endX + 'px';
}

// Drawn the same way as the waveform: backing store in device pixels, drawing
// in CSS pixels, so the marks are not blurry on a scaled display. The playhead
// and the markers are elements over the canvas rather than paint on it, so
// following playback costs a style write instead of a full redraw.
function drawTimeline() {
  // Before anything is measured: this changes the ruler's width, and the whole
  // frame is measured against that width.
  syncScrollbarInset();
  const cssW = timelineRuler.clientWidth;
  const cssH = timelineRuler.clientHeight;
  // Zero in simple editing, where the frame is not in the flow at all.
  if (!cssW || !cssH) return;
  syncTimelineView();

  const dpr = window.devicePixelRatio || 1;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (timelineRuler.width !== wantW || timelineRuler.height !== wantH) {
    timelineRuler.width = wantW;
    timelineRuler.height = wantH;
  }
  const ctx = timelineRuler.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const duration = timelineDuration();
  positionTimelineMarkers();
  positionLayerClips();
  if (!duration) return;

  // The selected span, so the two markers read as the ends of something rather
  // than as two unrelated lines.
  const bandX0 = timelineView.timeToX(tlView, slider.start);
  const bandX1 = timelineView.timeToX(tlView, slider.end);
  ctx.fillStyle = TIMELINE_BAND;
  ctx.fillRect(bandX0, 0, Math.max(0, bandX1 - bandX0), cssH);

  ctx.font = '10px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'top';
  const marks = timelineView.ticks(tlView, duration, cssW);
  // Every label on the ruler takes its shape from the largest time on it, so a
  // view that has reached an hour does not mix 59:00 with 1:01:00.
  const longest = marks.length ? marks[marks.length - 1].t : duration;
  for (const tick of marks) {
    // Half a pixel, so a one pixel line lands on a pixel instead of across two.
    const x = Math.round(tick.x) + 0.5;
    const height = tick.major ? 8 : 4;
    ctx.strokeStyle = tick.major ? TIMELINE_TICK_MAJOR : TIMELINE_TICK_MINOR;
    ctx.beginPath();
    ctx.moveTo(x, cssH - height);
    ctx.lineTo(x, cssH);
    ctx.stroke();
    if (!tick.major) continue;
    ctx.fillStyle = TIMELINE_LABEL;
    ctx.fillText(timelineView.tickLabel(tick.t, tick.step, longest), x + 3, 2);
  }
}

/**
 * Move the preview to a point on the timeline. The element drops currentTime
 * silently while it knows nothing about the file, so a seek before the metadata
 * has arrived is not attempted rather than being lost without saying so.
 */
function seekTimeline(at) {
  const duration = timelineDuration();
  if (!duration) return;
  // In advanced mode the playhead belongs to the compositor, which keeps its
  // own clock and may have no media file behind it at all.
  if (timelineDriving()) {
    seekComposite(at);
    updatePlayhead();
    return;
  }
  if (!Number.isFinite(transport.duration) || transport.duration <= 0) return;
  transport.currentTime = Math.min(Math.max(at, 0), duration);
  updatePlayhead();
}

// Anything under this many pixels of travel was meant as a click, not a drag.
// Without it a click with a shaky hand slides the view instead of moving the
// playhead, which is the more annoying of the two to undo.
const TIMELINE_DRAG_SLOP = 3;

// A click anywhere seeks. What a drag means depends on where it started:
//
//   on the ruler, it slides the timeline back and forth under the window, which
//   is what the left-right cursor there promises and the only way to reach the
//   rest of a clip once the view is zoomed past what the frame can show;
//
//   on the stack, it scrubs, because that surface belongs to the layers and
//   sliding the view out from under a layer being dragged is not what anyone
//   means by it.
//
// On the ruler the seek has to wait for the release: until the pointer has
// moved there is no telling which of the two gestures this was going to be. On
// the stack there is no such doubt, so it seeks from the press.
timelineStage.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || busy || !timelineDuration()) return;
  const rect = timelineLane.getBoundingClientRect();
  const toTime = (clientX) => timelineView.xToTime(tlView, clientX - rect.left);
  // Read now, because pointer capture retargets every event after this one.
  const onRuler = evt.target === timelineRuler;
  // A layer's header is controls, not timeline. Clicking one selects the layer
  // and works its buttons; it must not also move the playhead.
  const onTrack = !!(evt.target.closest && evt.target.closest('.layer-track'));
  if (!onRuler && !onTrack) return;
  // A press on a control inside a row belongs to that control. Capturing the
  // pointer below retargets the click to the stage, so the button never sees
  // one, and an empty row's Open File simply stopped responding. It only ever
  // showed up once something had given the timeline a duration, because with
  // none this handler returns on the line above and was never in the way.
  if (evt.target.closest('button, input, select, textarea, label')) return;
  timelineStage.setPointerCapture(evt.pointerId);
  const drag = { startX: evt.clientX, lastX: evt.clientX, panning: false };
  // A press on the stack is a scrub from the moment it lands, click or drag
  // alike, so a single click seeks the top layer now and lands the rest on the
  // release exactly as a drag does.
  if (!onRuler) {
    beginScrub();
    seekTimeline(toTime(evt.clientX));
  }

  const onMove = (ev) => {
    if (!onRuler) {
      seekTimeline(toTime(ev.clientX));
      return;
    }
    if (!drag.panning && Math.abs(ev.clientX - drag.startX) < TIMELINE_DRAG_SLOP) return;
    drag.panning = true;
    // The content follows the hand, so the view moves the other way: dragging
    // rightwards brings earlier seconds into the frame.
    tlView = timelineView.panBy(tlView, drag.lastX - ev.clientX, timelineDuration(), rect.width);
    drag.lastX = ev.clientX;
    noteTimelineFit(rect.width);
    drawTimeline();
    updatePlayhead();
  };
  const onUp = (ev) => {
    if (timelineStage.hasPointerCapture(ev.pointerId)) {
      timelineStage.releasePointerCapture(ev.pointerId);
    }
    timelineStage.removeEventListener('pointermove', onMove);
    timelineStage.removeEventListener('pointerup', onUp);
    timelineStage.removeEventListener('pointercancel', onUp);
    if (onRuler && !drag.panning) seekTimeline(toTime(ev.clientX));
    // Unconditional, so a pointercancel lands the layers too. It returns at
    // once when no scrub was running.
    endScrub();
  };
  timelineStage.addEventListener('pointermove', onMove);
  timelineStage.addEventListener('pointerup', onUp);
  timelineStage.addEventListener('pointercancel', onUp);
});

// Wheel zooms about the cursor, Shift and wheel scrolls sideways. deltaX is
// added to deltaY for the scroll because a trackpad already reports a
// horizontal swipe that way, and some of them turn Shift and a vertical swipe
// into deltaX themselves.
timelineStage.addEventListener('wheel', (evt) => {
  const duration = timelineDuration();
  if (!duration) return;
  // Over the headers on the left, or over the stack's own scrollbar, the wheel
  // belongs to the rows. The stack is a fixed height with overflow-y auto, so
  // it can scroll perfectly well; preventDefault below was the only reason it
  // never did, and with more rows than fit there was no way to reach the ones
  // underneath at all. Returning without preventing the default hands the event
  // back to the browser, which scrolls .timeline-stack itself.
  if (overTimelineRows(evt)) return;
  evt.preventDefault();
  const rect = timelineLane.getBoundingClientRect();
  if (evt.shiftKey) {
    tlView = timelineView.panBy(tlView, evt.deltaY + evt.deltaX, duration, rect.width);
  } else {
    const notches = -Math.sign(evt.deltaY || evt.deltaX);
    if (!notches) return;
    tlView = timelineView.zoomAt(tlView, evt.clientX - rect.left,
      Math.pow(TIMELINE_ZOOM_STEP, notches), duration, rect.width);
  }
  noteTimelineFit(rect.width);
  drawTimeline();
  updatePlayhead();
}, { passive: false });

/**
 * Whether a wheel belongs to the stack rather than to the view.
 *
 * The headers are elements and can be asked for. The scrollbar is not: it is
 * painted inside the stack's border box but outside its client box, so the only
 * way to know the pointer is on it is to measure. clientWidth stops at the
 * scrollbar, which is the same measurement --timeline-scrollbar is computed
 * from, so the two cannot disagree about where the tracks end.
 */
function overTimelineRows(evt) {
  const node = evt.target;
  if (node && node.closest && node.closest('.layer-head, .timeline-gutter')) return true;
  const rect = timelineStack.getBoundingClientRect();
  if (evt.clientY < rect.top || evt.clientY > rect.bottom) return false;
  return evt.clientX > rect.left + timelineStack.clientWidth;
}

// The two markers move the same trim the Trim frame's handles do, through the
// same slider, so the time boxes, the frames, the waveform and the span line
// all follow without knowing which frame the drag happened in. Anchor-based
// and re-anchoring on a modifier change, exactly as TrimSlider does.
function bindTimelineMarker(markerEl, isStart) {
  markerEl.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || busy || !timelineDuration()) return;
    // Or the click-to-seek surface underneath would take the playhead with it.
    evt.stopPropagation();
    evt.preventDefault();
    markerEl.setPointerCapture(evt.pointerId);
    const drag = {
      anchorX: evt.clientX,
      anchorValue: isStart ? slider.start : slider.end,
      factor: modifierFactor(evt),
    };
    setDragHint(drag.factor);
    // Step 10e. Only this marker's own frame: dragging the in point leaves the
    // End frame exactly as correct as it was, and a spinner over it would say
    // otherwise.
    const mine = isStart ? 'start' : 'end';
    // A drag that holds still is a drag that has arrived somewhere, so the
    // frame is built there and shown without waiting for the button. Re-armed
    // by every move, so a continuous drag never pays for one.
    let dwell = null;
    const armDwell = () => {
      clearTimeout(dwell);
      dwell = setTimeout(() => {
        dwell = null;
        renderTrimFrames(mine);
      }, TRIM_DWELL_MS);
    };
    if (compositing()) {
      trimFramesBusy(true, mine);
      armDwell();
    }

    const onMove = (ev) => {
      const factor = modifierFactor(ev);
      if (factor !== drag.factor) {
        drag.anchorX = ev.clientX;
        drag.anchorValue = isStart ? slider.start : slider.end;
        drag.factor = factor;
        setDragHint(factor);
      }
      // Seconds per pixel is the zoom, so a marker moves under the cursor at
      // whatever scale the view is showing rather than at a fixed rate.
      const delta = ((ev.clientX - drag.anchorX) / tlView.scale) * drag.factor;
      const value = drag.anchorValue + delta;
      if (isStart) slider.setStart(value);
      else slider.setEnd(value);
      if (!compositing()) return;
      // Whatever is on that frame, and whatever is being built for it, is now a
      // picture of somewhere the marker has already left.
      trimDragGen += 1;
      trimFramesBusy(true, mine);
      armDwell();
    };
    const onUp = (ev) => {
      if (markerEl.hasPointerCapture(ev.pointerId)) markerEl.releasePointerCapture(ev.pointerId);
      markerEl.removeEventListener('pointermove', onMove);
      markerEl.removeEventListener('pointerup', onUp);
      markerEl.removeEventListener('pointercancel', onUp);
      setDragHint(1.0);
      clearTimeout(dwell);
      // The release is the commit. Cheap when a dwell already built this frame:
      // seekDecodersTo skips a decoder that is already on the right frame, so
      // re-rendering an unchanged trim costs nothing but the restore.
      renderTrimFrames(mine);
      commitHistory();
    };
    markerEl.addEventListener('pointermove', onMove);
    markerEl.addEventListener('pointerup', onUp);
    markerEl.addEventListener('pointercancel', onUp);
  });
}

bindTimelineMarker(timelineTrimIn, true);
bindTimelineMarker(timelineTrimOut, false);

/**
 * Dragging the playhead line itself.
 *
 * Step 10b made a press on bare track scrub, which is right but is not enough:
 * a project whose layers cover the whole timeline has no bare track left to
 * press, and pressing a clip drags the clip. The line is always there and is
 * always the playhead, so it is the one grip that cannot be taken away. It
 * takes the press before the track underneath, so hovering it does not put the
 * gesture on a clip.
 */
timelinePlayhead.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || busy || !timelineDuration()) return;
  // The clip underneath would start moving and the stage would scrub from
  // wherever the press landed. This press means the playhead and nothing else.
  evt.stopPropagation();
  evt.preventDefault();
  timelinePlayhead.setPointerCapture(evt.pointerId);
  // Read once: the playhead moves out from under the cursor as it is dragged,
  // and the lane is what x is measured against either way.
  const rect = timelineLane.getBoundingClientRect();
  beginScrub();

  const onMove = (ev) => {
    seekTimeline(timelineView.xToTime(tlView, ev.clientX - rect.left));
  };
  const onUp = (ev) => {
    if (timelinePlayhead.hasPointerCapture(ev.pointerId)) {
      timelinePlayhead.releasePointerCapture(ev.pointerId);
    }
    timelinePlayhead.removeEventListener('pointermove', onMove);
    timelinePlayhead.removeEventListener('pointerup', onUp);
    timelinePlayhead.removeEventListener('pointercancel', onUp);
    endScrub();
  };
  timelinePlayhead.addEventListener('pointermove', onMove);
  timelinePlayhead.addEventListener('pointerup', onUp);
  timelinePlayhead.addEventListener('pointercancel', onUp);
});

// ---- layer rows ----
//
// Step 7. The rows are built from the model in src/timeline.js, which the
// window loads as a plain script beside this one because it cannot require()
// anything. That is deliberate: the main process encodes from the same file, so
// there is one layer model rather than two that have to be kept agreeing.
//
// Nothing here plays yet. The preview is still the single-media one Step 6
// wired up, and Step 10 replaces it with the compositor. What this step has to
// get right is that the model and the screen say the same thing after any
// sequence of adding, removing, reordering and switching layers off.

// The whole document, and the only thing an undo snapshot would need to hold.
let layers = [];
let selectedLayerId = null;

// A trailing empty row of each type is always on offer, so there is somewhere
// to drop a file and somewhere to press Open File. Filling it puts a real layer
// in its place and a fresh empty one appears below, which is why there is no
// separate button to add a layer: the empty row is the button.
// ---- grouping, Step 14 ----
//
// A video file dropped into a video layer also makes an audio layer for its
// sound, and the two are marked as one.

// Shape and colour together rather than colour alone, so that two green groups
// are still a star and a circle. Six shapes against five colours, so both
// change from one group to the next and thirty go by before any pair repeats.
const GROUP_SHAPES = ['★', '●', '▲', '■', '◆', '✦'];
const GROUP_COLOURS = ['#78c88c', '#78a8dc', '#dcc878', '#dc8c78', '#b48cdc'];

/**
 * The shape and colour that stand for a group.
 *
 * Chosen by where the group first appears in the layer list, so no two groups
 * on screen can be handed the same marker, and so a project reopened from a
 * file gets the same markers it was saved with: the list order is saved too.
 * The cost is that deleting a group shifts the markers of the ones after it,
 * which is visible and harmless where a hash collision would be neither.
 */
function groupMarker(groupId) {
  if (!groupId) return null;
  const index = timelineModel.groupIds(layers).indexOf(groupId);
  if (index < 0) return null;
  return {
    shape: GROUP_SHAPES[index % GROUP_SHAPES.length],
    colour: GROUP_COLOURS[index % GROUP_COLOURS.length],
  };
}

function layersOfType(type) {
  return layers.filter((l) => l.type === type);
}

function layerOrdinal(layer) {
  return layersOfType(layer.type).indexOf(layer) + 1;
}

/** What a layer is called, which is its position among its own kind. */
function layerLabel(type, ordinal) {
  return type === 'audio' ? t('Audio {n}', { n: ordinal }) : t('Video {n}', { n: ordinal });
}

/**
 * Selection repaints rather than rebuilding, and that is load-bearing rather
 * than an optimisation. Selecting happens on pointerdown, so rebuilding the
 * rows here would destroy the very checkbox or button the press landed on
 * before it could receive its own click: pressing Enabled on an unselected row
 * selected the row and did not switch the layer off.
 */
function paintLayerSelection() {
  for (const row of timelineStack.querySelectorAll('.layer-row[data-layer-id]')) {
    row.classList.toggle('layer-row--selected', row.dataset.layerId === selectedLayerId);
  }
}

function selectLayer(id) {
  if (selectedLayerId === id) return;
  selectedLayerId = id;
  paintLayerSelection();
  // The Crop button acts on the selected layer, so selecting one is what
  // enables it and what decides which layer its tooltip names. Step 11.
  updateCropBtn();
}

/**
 * Replace the document. Every change goes through here, so there is one place
 * that redraws and one place an undo commit will hook into at Step 12.
 */
function setLayers(next) {
  layers = next;
  if (selectedLayerId && !timelineModel.layerById(layers, selectedLayerId)) {
    selectedLayerId = null;
  }
  renderLayerRows();
  syncComposite();
  // Before the redraw: the markers are placed from the slider, so the slider
  // has to know how long the project is first.
  syncProjectTrim();
  // And the layers decide whether this project has a picture at all, so the
  // preview frame may have just become the equalizer or stopped being it.
  applyPreviewMode();
  // Step 15. The same answer decides which formats the save row offers, and
  // whether there is anything to export at all. syncProjectTrim below only
  // re-gates the row when the project's length changed, and unticking the last
  // video layer changes neither its length nor its media file.
  if (timelineDriving()) {
    buildFormatToggle();
    setTrimEnabled(!busy && trimmable());
  }
  // Step 11. Which layer the Crop button acts on, whether it has a crop, and
  // what size the project renders at are all answers about the list that has
  // just changed.
  updateCropBtn();
  updateRenderResolution();
  updateProjectUi();
  // A layer added, removed, moved or trimmed changes what covers the trim
  // points, so the two frames are no longer pictures of this project.
  renderTrimFrames();
  drawTimeline();
  updatePlayhead();
  fitWindow();
}

/**
 * A file becoming one or two layers.
 *
 * Step 14: a video file with sound in it makes a video layer and an audio
 * layer, linked. That is the only way a video's own sound reaches the output,
 * because a video layer is picture only: the encoder builds its audio graph
 * from the audio layers and nothing else.
 *
 * Only on the video path. A video dropped into an audio row is a deliberate
 * "take the sound and leave the picture", and answering it with a picture as
 * well would be ignoring what was asked.
 */
function addLayerFromMedia(type, data) {
  const duration = Math.max(0, data.duration || 0);
  if (!duration) return;
  const paired = type === 'video' && !!data.hasAudio;
  const groupId = paired ? timelineModel.newGroupId() : null;
  const layer = timelineModel.createLayer({
    type,
    name: data.title || String(data.path).split(/[\\/]/).pop(),
    src: data.path,
    start: 0,
    sourceDuration: duration,
    // Carried from the probe at the moment the layer is made, because a crop
    // set later has to be measured against the same numbers the encoder will
    // crop with. Step 11.
    sourceWidth: data.width,
    sourceHeight: data.height,
    // Step 15. The project's rate is seeded from its first source, and the
    // export is written at the project's rate.
    sourceFps: data.fps,
    groupId,
  });
  let next = timelineModel.addLayer(layers, layer);
  if (paired) {
    // The same file, the same place, the same part of it. addLayer puts it at
    // the end of the audio block, which is where an audio row belongs whatever
    // it is grouped with.
    next = timelineModel.addLayer(next, timelineModel.createLayer({
      type: 'audio',
      name: layer.name,
      src: layer.src,
      start: layer.start,
      sourceIn: layer.sourceIn,
      duration: layer.duration,
      sourceDuration: layer.sourceDuration,
      groupId,
    }));
  }
  // The picture, not the sound: it is the one the eye is on and the one the
  // crop button acts on.
  selectedLayerId = layer.id;
  setLayers(next);
  commitHistory();
}

/**
 * A file chosen or dropped onto an empty row of the given type. A video dropped
 * into an audio row keeps only its sound, which costs nothing here because the
 * layer records the type it was made as and the encoder reads that.
 */
async function openIntoLayer(type, filePath) {
  if (busy) return;
  const result = filePath
    ? await window.lwclipper.describeMedia(filePath)
    : await window.lwclipper.loadLocalMedia();
  if (!result || result.cancelled) return;
  // Still "open this project". There is nothing else a .lwc can mean, and
  // answering a track drop differently from the zone above would only mean
  // learning which corner of the window opens projects.
  if (result.project) {
    await openProjectPath(result.path);
    return;
  }
  if (!result.ok) {
    reportFailure(result);
    return;
  }
  addLayerFromMedia(type, result.data);
}

/**
 * A small control living on a clip rather than in the header.
 *
 * It stops the press and not only the click, which a header button does not
 * have to: the clip underneath turns a pointerdown into a drag or a trim, so a
 * button that only stopped the click would start a drag on the way to being
 * pressed and then never be pressed at all.
 */
function makeClipMark(className, label, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'clip-mark ' + className;
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('pointerdown', (evt) => evt.stopPropagation());
  btn.addEventListener('click', (evt) => {
    evt.stopPropagation();
    onClick();
  });
  return btn;
}

function makeButton(className, label, title, onClick) {
  const btn = document.createElement('button');
  btn.className = className;
  btn.textContent = label;
  if (title) btn.title = title;
  btn.addEventListener('click', (evt) => {
    evt.stopPropagation();
    onClick();
  });
  return btn;
}

/** One row per layer, then the trailing empty row for that type. */
function buildLayerRow(layer) {
  const row = document.createElement('div');
  row.className = 'layer-row layer-row--' + layer.type;
  row.dataset.layerId = layer.id;
  if (!layer.enabled) row.classList.add('layer-row--off');
  if (layer.id === selectedLayerId) row.classList.add('layer-row--selected');

  const head = document.createElement('div');
  head.className = 'layer-head';

  const top = document.createElement('div');
  top.className = 'layer-head__top';
  // The group marker and the crop button used to sit here, either side of the
  // name, and between them and the arrows the name had about six characters of
  // room. Both now ride the end of the clip instead, where the thing they are
  // about actually is. The head keeps the name and the two things that are not
  // about one clip: where the layer sits in the stack, and whether it stays.
  const marker = groupMarker(layer.groupId);

  const name = document.createElement('div');
  name.className = 'layer-name';
  name.textContent = layerLabel(layer.type, layerOrdinal(layer));
  name.title = layer.name || '';
  top.appendChild(name);

  // Up and down only on video: a mix does not care what order it sums in, so
  // there is nothing for the arrows to mean on an audio layer.
  if (layer.type === 'video') {
    const siblings = layersOfType('video');
    const at = siblings.indexOf(layer);
    const reorder = (delta) => {
      setLayers(timelineModel.reorderLayer(layers, layer.id, delta));
      commitHistory();
    };
    const up = makeButton('layer-btn', '▲', t('Move layer up'), () => reorder(-1));
    const down = makeButton('layer-btn', '▼', t('Move layer down'), () => reorder(1));
    up.disabled = at === 0;
    down.disabled = at === siblings.length - 1;
    top.appendChild(up);
    top.appendChild(down);
  }

  top.appendChild(makeButton('layer-btn layer-btn--delete', '✕', t('Delete layer'), () => {
    // The design's rule: only the clicked layer goes, the pair is unlinked by
    // its going, and the survivor keeps the marker so it is visible which one
    // it was. removeLayer does all of that by doing nothing clever.
    setLayers(timelineModel.removeLayer(layers, layer.id));
    commitHistory();
  }));
  head.appendChild(top);

  const controls = document.createElement('div');
  controls.className = 'layer-head__row';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'layer-enabled';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = layer.enabled;
  enabled.addEventListener('click', (evt) => evt.stopPropagation());
  enabled.addEventListener('change', () => {
    setLayers(timelineModel.setLayer(layers, layer.id, { enabled: enabled.checked }));
  });
  enabledLabel.appendChild(enabled);
  enabledLabel.appendChild(document.createTextNode(t('Enabled')));
  controls.appendChild(enabledLabel);

  // Per-layer volume, which is what replaces the single global slider.
  if (layer.type === 'audio') {
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'layer-volume';
    vol.min = '0';
    vol.max = '200';
    vol.step = '5';
    vol.value = String(Math.round(layer.volume * 100));
    const readout = document.createElement('span');
    readout.className = 'layer-volume__value';
    readout.textContent = vol.value + '%';
    vol.addEventListener('click', (evt) => evt.stopPropagation());
    // Written straight into the model on input rather than on change, but
    // without a re-render: rebuilding the rows mid-drag would take the slider
    // out from under the pointer.
    vol.addEventListener('input', () => {
      readout.textContent = vol.value + '%';
      layers = timelineModel.setLayer(layers, layer.id, { volume: Number(vol.value) / 100 });
      // Live, because the slider is how a level gets found and finding it means
      // hearing it move. Read back out of the model rather than trusting the
      // value in hand, so what is heard is what was written.
      const updated = timelineModel.layerById(layers, layer.id);
      if (updated) applyPlayerGain(updated);
      // Written straight into the list, so nothing else is going to notice.
      updateProjectUi();
    });
    controls.appendChild(vol);
    controls.appendChild(readout);
  }
  head.appendChild(controls);

  const track = document.createElement('div');
  track.className = 'layer-track';
  track.dataset.layerId = layer.id;
  const clip = document.createElement('div');
  clip.className = 'layer-clip';
  // Step 17. The file's own name with its extension. This was layer.src, the
  // whole path, which is longer than a tooltip usefully is; layer.name is not
  // it either, because a download's title arrives there instead of a filename.
  clip.title = (layer.src || '').split(/[\\/]/).pop();
  // The thumbnails or the waveform, on a canvas only as wide as the part of the
  // clip that is actually on screen. Sizing it to the whole clip would ask for
  // a 260000px canvas at full zoom on a ten minute layer.
  const art = document.createElement('canvas');
  art.className = 'layer-clip__art';
  clip.appendChild(art);
  // The grips, over the art. Their width is set in
  // positionLayerClips, which is the only place that knows how wide the clip
  // has ended up on screen.
  for (const side of ['start', 'end']) {
    const handle = document.createElement('div');
    handle.className = 'layer-clip__edge layer-clip__edge--' + side;
    handle.dataset.edge = side;
    handle.title = t('Drag to trim this edge');
    clip.appendChild(handle);
  }

  // The group marker and the crop control, at the top right of the clip. Last,
  // so they take a press before the end grip does; placeClipMarks then insets
  // them by the grip's width so the two never actually overlap.
  //
  // Step 17 moved them from the middle of the clip's end to its top corner.
  // They stay the clip's, not the row's: they say something about this layer's
  // media and they belong where that media is.
  const marks = document.createElement('div');
  marks.className = 'layer-clip__marks';
  if (marker) {
    // One control, not a marker beside an Ungroup button. It says which group
    // the clip is in and breaking that group is the only thing there is to do
    // about it. A stray press is a normal undo step, which is what makes one
    // control safe enough to be worth the room.
    const mark = makeClipMark('clip-mark--group', marker.shape,
      t('Grouped with its sound, click to ungroup'), () => {
        setLayers(timelineModel.ungroup(layers, layer.groupId));
        commitHistory();
      });
    mark.style.color = marker.colour;
    marks.appendChild(mark);
  }
  // Video only: there is nothing to crop out of a waveform.
  if (layer.type === 'video') {
    const crop = makeClipMark('clip-mark--crop', '⛶', t('Crop layer'), () => {
      selectLayer(layer.id);
      openCrop(layer.id);
    });
    // Lit when this layer is actually cropped, so the row says so without
    // anything having to be opened to find out.
    crop.classList.toggle('clip-mark--on', !!layer.crop);
    marks.appendChild(crop);
    // V2.1. The same reasoning one glyph along: where this layer's picture goes
    // in the output frame is a fact about this layer's media, and a project with
    // a layer tucked into a corner should say which layer that is without the
    // popup having to be opened on each one in turn.
    const place = makeClipMark('clip-mark--place', '◳', t('Place layer in the frame'), () => {
      selectLayer(layer.id);
      openCrop(layer.id, 'place');
    });
    place.classList.toggle('clip-mark--on', !!layer.render);
    marks.appendChild(place);
  }
  if (marks.childElementCount) clip.appendChild(marks);

  bindClipDrag(clip, layer.id);
  track.appendChild(clip);

  row.appendChild(head);
  row.appendChild(track);
  row.addEventListener('pointerdown', () => selectLayer(layer.id));
  return row;
}

// ---- moving and trimming a clip ----
//
// Step 9. Three gestures on one element: slide the clip along the timeline, or
// pull either edge in and out.
//
// The model does every piece of clamping, which is what Step 1 being a pure
// module bought. moveLayer will not go below zero, trimLayer will not run past
// the source or shrink a clip away to nothing, and both round, so nothing here
// has to know those rules or worry about drift.
//
// Trimming is non-destructive in the literal sense: the source file is never
// touched and the layer only records how much of it to show, so an edge pulled
// all the way in can always be pulled back out to where it started.

// How wide an edge grip is at most. Seven pixels is about the least a hand
// reliably lands on, and it is what the timeline's trim markers already use.
const CLIP_EDGE_GRAB = 7;

function bindClipDrag(clip, layerId) {
  clip.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || busy) return;
    const layer = timelineModel.layerById(layers, layerId);
    if (!layer) return;
    // The stage underneath would scrub, and the row above would select on the
    // way past. Selecting here instead means the press does one thing.
    evt.stopPropagation();
    evt.preventDefault();
    selectLayer(layerId);

    const grip = evt.target.closest && evt.target.closest('.layer-clip__edge');
    const edge = grip ? grip.dataset.edge : null;
    // What the gesture is dragging: the clip's position, or the edge's own
    // place on the timeline.
    const valueOf = (l) => (edge === 'end' ? timelineModel.endOf(l) : l.start);

    clip.setPointerCapture(evt.pointerId);
    const rect = timelineLane.getBoundingClientRect();
    // The fit is frozen for the duration of the drag. A layer dragged
    // rightwards on a fitted view makes the project longer, which would rescale
    // the ruler under the drag and leave the clip forever chasing the cursor.
    // noteTimelineFit on release works out whether it is the fitted view again.
    tlFitted = false;
    const drag = {
      anchorX: evt.clientX,
      anchorValue: valueOf(layer),
      factor: modifierFactor(evt),
      moved: false,
    };
    clip.classList.add('layer-clip--dragging');
    document.body.classList.add(edge ? 'layer-trimming' : 'layer-dragging');
    setDragHint(drag.factor);

    // Written straight into the list without setLayers, for the same reason the
    // volume slider is: setLayers rebuilds the rows, which would destroy the
    // very clip the pointer is captured on. The commit happens on release.
    // Step 14. A grouped clip drags its whole group, which for the common case
    // is a picture and its own sound. moveGroup and trimGroup fall through to
    // the single-layer versions when there is no group, so there is one path
    // here rather than two.
    const apply = (value) => {
      layers = edge
        ? timelineModel.trimGroup(layers, layerId, edge, value)
        : timelineModel.moveGroup(layers, layerId, value);
      drawTimeline();
      updatePlayhead();
    };

    const onMove = (ev) => {
      if (!drag.moved) {
        if (Math.abs(ev.clientX - drag.anchorX) < TIMELINE_DRAG_SLOP) return;
        drag.moved = true;
      }
      const factor = modifierFactor(ev);
      if (factor !== drag.factor) {
        // Re-anchored on the layer as it stands now, so the new rate carries on
        // from where the clip is rather than jumping. Read back from the model
        // rather than tracked, because the model may have clamped the last move.
        const now = timelineModel.layerById(layers, layerId);
        if (!now) return;
        drag.anchorX = ev.clientX;
        drag.anchorValue = valueOf(now);
        drag.factor = factor;
        setDragHint(factor);
      }
      // Seconds per pixel is the zoom, so a clip travels with the cursor at
      // whatever the view is showing rather than at some fixed rate.
      const delta = ((ev.clientX - drag.anchorX) / tlView.scale) * drag.factor;
      apply(drag.anchorValue + delta);
    };
    const onUp = (ev) => {
      if (clip.hasPointerCapture(ev.pointerId)) clip.releasePointerCapture(ev.pointerId);
      clip.removeEventListener('pointermove', onMove);
      clip.removeEventListener('pointerup', onUp);
      clip.removeEventListener('pointercancel', onUp);
      clip.classList.remove('layer-clip--dragging');
      document.body.classList.remove('layer-dragging', 'layer-trimming');
      setDragHint(1.0);
      noteTimelineFit(rect.width);
      // The commit point, and so Step 12's undo snapshot. A press that never
      // moved changed nothing and does not rebuild the rows, let alone take a
      // step.
      if (drag.moved) {
        setLayers(layers);
        commitHistory();
      }
    };
    clip.addEventListener('pointermove', onMove);
    clip.addEventListener('pointerup', onUp);
    clip.addEventListener('pointercancel', onUp);
  });
}

function buildEmptyRow(type) {
  const row = document.createElement('div');
  row.className = 'layer-row layer-row--' + type + ' layer-row--empty';

  const head = document.createElement('div');
  head.className = 'layer-head';
  const name = document.createElement('div');
  name.className = 'layer-name';
  name.textContent = layerLabel(type, layersOfType(type).length + 1);
  head.appendChild(name);

  const track = document.createElement('div');
  track.className = 'layer-track';
  track.dataset.emptyType = type;
  const empty = document.createElement('div');
  empty.className = 'layer-empty';
  const text = document.createElement('span');
  text.textContent = type === 'audio' ? t('No Audio track') : t('No Video track');
  empty.appendChild(makeButton('', t('Open File'), '', () => openIntoLayer(type, null)));
  empty.appendChild(text);
  track.appendChild(empty);

  row.appendChild(head);
  row.appendChild(track);
  return row;
}

function renderLayerRows() {
  const stack = timelineStack;
  stack.replaceChildren();
  for (const layer of layersOfType('video')) stack.appendChild(buildLayerRow(layer));
  stack.appendChild(buildEmptyRow('video'));
  for (const layer of layersOfType('audio')) stack.appendChild(buildLayerRow(layer));
  stack.appendChild(buildEmptyRow('audio'));
  positionLayerClips();
}

/** Every clip placed against the same view the ruler is drawn against. */
function positionLayerClips() {
  const trackW = timelineLane.clientWidth;
  for (const track of timelineStack.querySelectorAll('.layer-track[data-layer-id]')) {
    const layer = timelineModel.layerById(layers, track.dataset.layerId);
    const clip = track.querySelector('.layer-clip');
    if (!layer || !clip) continue;
    const x0 = timelineView.timeToX(tlView, layer.start);
    const x1 = timelineView.timeToX(tlView, timelineModel.endOf(layer));
    const width = Math.max(2, x1 - x0);
    clip.style.left = x0 + 'px';
    clip.style.width = width + 'px';

    // A clip too narrow to spare two full grips gives each of them a third of
    // itself, so there is always a body left in the middle and a short clip can
    // still be moved rather than only trimmed.
    const gripW = Math.min(CLIP_EDGE_GRAB, Math.floor(width / 3));
    for (const handle of clip.querySelectorAll('.layer-clip__edge')) {
      handle.style.width = gripW + 'px';
    }

    // The canvas covers only the part of the clip inside the frame, placed at
    // its offset within the clip, so its width is bounded by the track however
    // far the view is zoomed in.
    const art = clip.querySelector('.layer-clip__art');
    if (!art) continue;
    const from = Math.max(0, -x0);
    const to = Math.min(width, trackW - x0);
    const visible = Math.max(0, to - from);
    art.style.left = from + 'px';
    art.style.width = visible + 'px';
    placeClipMarks(clip, width, from, visible, gripW);
    drawClipArt(layer, art, x0 + from, visible, clip.clientHeight);
  }
}

// How wide one clip mark is, and the gap between two, matching the stylesheet.
// Taken as numbers rather than measured: this runs for every clip on every pan
// and zoom frame, and reading offsetWidth there is a layout per clip per frame
// to learn something that never changes.
const CLIP_MARK_W = 17;
const CLIP_MARK_GAP = 3;

/**
 * The marks at the top right of a clip.
 *
 * They float at the right of whatever part of the clip is on screen rather
 * than at its true end, or a clip wider than the frame would keep them
 * somewhere off to the side of it. Their height is the stylesheet's; this only
 * decides how far in from the right they sit.
 *
 * Inset by the grip's width, but only when the clip's own end is on screen. If
 * the clip runs off the right of the frame there is no grip there to clear, and
 * insetting anyway would leave the marks floating short of the edge.
 */
function placeClipMarks(clip, width, from, visible, gripW) {
  const marks = clip.querySelector('.layer-clip__marks');
  if (!marks) return;
  const n = marks.childElementCount;
  const needed = n * CLIP_MARK_W + (n - 1) * CLIP_MARK_GAP;
  const endOnScreen = from + visible >= width - 0.5;
  // Room for the marks, the grip they sit beside, and enough clip left over to
  // still be a clip. Below that they go, because a control the width of its own
  // row is not a control, it is the row.
  marks.hidden = visible < needed + gripW + 24;
  if (marks.hidden) return;
  marks.style.right = (width - (from + visible) + (endOnScreen ? gripW : 0)) + 'px';
}

// ---- what a clip looks like ----
//
// Thumbnails for a video layer, a waveform for an audio one. Both are derived
// data fetched from the main process and cached here as well as on disk: this
// runs on every pan and zoom frame, and a round trip per frame would be absurd.
//
// Each cache entry records what density it was fetched at. A finer one is
// requested when the view has zoomed past what the current one can draw, and
// the coarse one keeps being drawn until the finer one arrives, so zooming
// never blanks the strip it is refining.

const stripCache = new Map();   // src -> { want, tiles, info, img, pending }
const peakCache = new Map();    // src -> { want, buckets, peaks, pending }

function clipArtColours(type) {
  return type === 'audio'
    ? { wave: '#a6d8b4', mid: 'rgba(200, 235, 210, 0.35)' }
    : { wave: '#8fa8d8', mid: 'rgba(200, 215, 240, 0.3)' };
}

async function ensureStrip(layer, want) {
  const entry = stripCache.get(layer.src);
  if (entry && entry.pending) return;
  // tilesFor doubles, so asking again for a want the current entry already
  // satisfies would fetch the same sheet forever.
  if (entry && entry.want >= want) return;
  stripCache.set(layer.src, { ...(entry || {}), want, pending: true });
  try {
    const result = await window.lwclipper.filmstrip(layer.src, layer.sourceDuration, want);
    if (!result.ok || !result.data) {
      // No video stream, or ffmpeg could not read one. The clip keeps its plain
      // bar rather than the frame going quiet about it.
      stripCache.set(layer.src, { want: Infinity, pending: false });
      return;
    }
    const url = await window.lwclipper.fileUrl(result.data.file);
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    stripCache.set(layer.src, { want, info: result.data, img, pending: false });
    drawTimeline();
  } catch {
    stripCache.set(layer.src, { want: Infinity, pending: false });
  }
}

async function ensurePeaks(layer, want) {
  const entry = peakCache.get(layer.src);
  if (entry && entry.pending) return;
  if (entry && entry.want >= want) return;
  peakCache.set(layer.src, { ...(entry || {}), want, pending: true });
  try {
    const result = await window.lwclipper.audioPeaks(layer.src, layer.sourceDuration, want);
    if (!result.ok) {
      peakCache.set(layer.src, { want: Infinity, pending: false });
      return;
    }
    peakCache.set(layer.src, {
      want, peaks: result.data.peaks, buckets: result.data.buckets, pending: false,
    });
    drawTimeline();
  } catch {
    peakCache.set(layer.src, { want: Infinity, pending: false });
  }
}

/**
 * Draw the visible slice of one clip.
 *
 * `leftX` is where the canvas starts in lane coordinates, which is what turns a
 * pixel into a time and then into a position in the source.
 */
function drawClipArt(layer, canvas, leftX, width, height) {
  if (!(width > 0) || !(height > 0) || !layer.src) return;
  const dpr = window.devicePixelRatio || 1;
  const wantW = Math.max(1, Math.round(width * dpr));
  const wantH = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (layer.type === 'audio') drawClipWaveform(layer, ctx, leftX, width, height);
  else drawClipFilmstrip(layer, ctx, leftX, width, height);
}

/**
 * A layer's crop as fractions of its source frame.
 *
 * Fractions rather than pixels because that is the one form that works against
 * anything measured in that frame whatever size it has been reduced to: a
 * thumbnail on a sheet here, a video element's intrinsic size in paintLayers.
 * The whole frame when there is no crop, or when nothing has measured the
 * source to put one against.
 */
function cropWindow(layer) {
  const whole = { x: 0, y: 0, w: 1, h: 1 };
  const source = layerSource(layer);
  if (!layer.crop || !source) return whole;
  const rect = layerGeometry.sourceRect(source, layer.crop);
  if (!rect) return whole;
  // Against the even-down frame sourceRect clamps to, not against the raw
  // numbers, so the fractions describe the rectangle it actually returned.
  const w = source.width - (source.width % 2);
  const h = source.height - (source.height % 2);
  return { x: rect.x / w, y: rect.y / h, w: rect.width / w, h: rect.height / h };
}

function drawClipFilmstrip(layer, ctx, leftX, width, height) {
  const entry = stripCache.get(layer.src);
  const info = entry && entry.info;
  // Step 11. The sheet holds whole source frames, so a crop is the same
  // fractions of a tile that it is of the frame, and the strip shows what the
  // render will rather than what the file happens to contain.
  const win = cropWindow(layer);
  const tileW = info ? info.tileWidth * win.w : 0;
  const tileH = info ? info.tileHeight * win.h : 0;
  // How wide one thumbnail is on screen once scaled to the row's height. The
  // cropped part of it, so a 9:16 crop shows as a narrow thumbnail.
  const drawW = info ? Math.max(4, tileW * (height / tileH)) : 48;
  // Thumbnails across the whole source, which is what the sheet holds. It
  // follows the zoom and not the clip's length: thirty minutes at fit-to-width
  // asks for the same handful a thirty second clip does.
  const want = Math.ceil((layer.sourceDuration * tlView.scale) / drawW);
  ensureStrip(layer, want);
  if (!info || !entry.img) return;

  for (let px = 0; px < width; px += drawW) {
    const t = timelineView.xToTime(tlView, leftX + px);
    const at = timelineModel.sourceTimeFor(layer, t);
    const index = Math.min(info.tiles - 1,
      Math.max(0, Math.floor(at / info.interval)));
    const sx = (index % info.cols) * info.tileWidth + info.tileWidth * win.x;
    const sy = Math.floor(index / info.cols) * info.tileHeight + info.tileHeight * win.y;
    ctx.drawImage(entry.img, sx, sy, tileW, tileH,
      px, 0, Math.min(drawW, width - px), height);
  }
}

function drawClipWaveform(layer, ctx, leftX, width, height) {
  // One bucket per pixel of the source at this zoom, which is what the frame
  // can actually show.
  const want = Math.ceil(layer.sourceDuration * tlView.scale);
  ensurePeaks(layer, want);
  const entry = peakCache.get(layer.src);
  if (!entry || !entry.peaks) return;

  const { peaks, buckets } = entry;
  const mid = height / 2;
  const half = mid - 2;
  const colours = clipArtColours(layer.type);
  ctx.fillStyle = colours.wave;
  for (let px = 0; px < width; px += 1) {
    const t = timelineView.xToTime(tlView, leftX + px);
    const at = timelineModel.sourceTimeFor(layer, t);
    const b = Math.min(buckets - 1,
      Math.max(0, Math.floor((at / layer.sourceDuration) * buckets)));
    const lo = peaks[b * 2];
    const hi = peaks[b * 2 + 1];
    const top = mid - hi * half;
    const bottom = mid - lo * half;
    ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
  }
  ctx.fillStyle = colours.mid;
  ctx.fillRect(0, mid, width, 1);
}

// ---- the compositor ----
//
// Step 10a. Advanced editing's preview: every video layer covering the playhead
// drawn onto one canvas, in the order the model hands them back, so Video 1
// lands on top.
//
// Nothing here decides anything about the picture. Where a layer lands comes
// from geometry.js and when it appears comes from timeline.js, which is what
// the encoder reads as well, so the preview and the saved file cannot come to
// different answers. This is dev/sliceRenderer.js generalised from two
// hardcoded layers to however many the project has.
//
// The video elements are muted and stay muted, now permanently rather than
// until Step 10c. A video layer is picture only in this model: composer.js
// mixes type 'audio' layers and nothing else, so a video decoder left unmuted
// would put sound in the preview that the saved file does not have. Step 14's
// grouping is what gives a dropped video file an audio row of its own to carry
// its sound. Muted is also what lets an element play without a gesture.
//
// Step 10c added the sound below: one audio element per audio layer, each
// through its own gain node into one bus.
//
// Seeking is naive: every covering layer on every playhead move. That is
// correct and slow, and making it affordable is the whole of Step 10b.

// Until the aspect and resolution dropdowns in the design exist, the project
// takes its shape from the first source to arrive and then keeps it. Seeded
// once rather than read off the top layer every time, so reordering the rows
// does not reshape the project underneath them.
const COMPOSITE_FALLBACK = { width: 1280, height: 720, fps: 30 };

// How far an element may drift before it is dragged back rather than left to
// catch up, and the same value as AUDIO_SYNC_SLACK for the same reason: a
// re-seek costs a decode, so it is worth doing only when an element is
// genuinely lost. Step 0 measured 2ms of real drift against a wall clock, which
// never comes near this wall.
const COMPOSITE_SLACK = 0.25;

// Above 1080p even the top layer alone costs about 450ms to seek, which is not
// a live scrub by any reading, so a project that size holds its picture through
// the drag and lands everything when the mouse comes up. Counted in pixels
// rather than in height, so a 1080x1920 portrait clip is the 1080p it is.
const SCRUB_PIXELS = 1920 * 1080;

const decoders = new Map();   // layer id -> { el, width, height }
// Step 10c. One player per audio layer, each with its own gain node, all of
// them summing into mixBus. A mix does not care what order it sums in, so
// unlike the decoders these have no order at all.
const players = new Map();    // layer id -> { el, gain }
let mixBus = null;
// Decoders still on their way to the playhead after a scrub let go. Step 0
// measured this at up to 5s for five 4K layers and 7.4s worst for eight, so it
// is not something to do quietly: the composite is wrong for that whole time,
// and a picture that has stopped changing looks exactly like one that froze.
const landing = new Set();
let landingTimer = null;
let compositeScrub = false;   // a drag on the stack is moving the playhead
// Step 10e is holding the pool at a trim point, so nothing may draw the preview
// from it. Declared here rather than beside the rest of 10e because
// drawComposite reads it and is defined long before that block.
let paintingFrames = false;
let compositeFrame = null;    // the project's size, seeded from the first source
let compositeAt = 0;          // where the playhead is, in timeline seconds
let compositePlaying = false;
let compositeRaf = null;
let compositeLast = 0;

const compositeCtx = compositeCanvas.getContext('2d', { alpha: false });

/**
 * Whether the composite is what the preview frame is showing.
 *
 * An audio-only output stays on the single media path with everything it
 * already has, spectrum included: there is no picture to composite. Step 10c
 * put the timeline's sound on a mix bus but left this alone, because what an
 * audio-only preview shows is the spectrum, and moving the spectrum onto the
 * bus is Step 10d. Until then, choosing MP3 in advanced mode gives the preview
 * back to the single media path.
 */
function compositing() {
  return timelineDriving() && !outputIsAudio();
}

/**
 * Whether the timeline owns the transport and the sound.
 *
 * Wider than compositing(), and the difference is the whole of what 10c left
 * open: with an audio output format there is no picture to draw, but there is
 * still a project to play. The canvas follows compositing(); the Play button,
 * the playhead, the space bar and the mix all follow this.
 */
function timelineDriving() {
  return !!appSettings.advancedEditing;
}

function projectFrame() {
  return compositeFrame || COMPOSITE_FALLBACK;
}

function compositeTotal() {
  return timelineModel.totalDuration(layers);
}

function sizeCompositeCanvas() {
  // The rough preview, capped at 854x480 by geometry.js, and deliberately not
  // scaled by devicePixelRatio the way the ruler and the waveform are. This one
  // is redrawn every frame with five decoders behind it, and Step 0 spent that
  // budget on the layers rather than on detail nobody is looking at.
  const size = layerGeometry.previewCanvasSize(projectFrame());
  if (!size) return;
  if (compositeCanvas.width === size.width && compositeCanvas.height === size.height) return;
  compositeCanvas.width = size.width;
  compositeCanvas.height = size.height;
}

/**
 * Seed the project frame, once, from the first source the project has.
 *
 * Walked in list order rather than taken from whichever decoder happened to
 * report first, or two files opened together would leave the project a
 * different shape on different runs. Kept afterwards, so dropping a portrait
 * clip on top of a landscape project does not turn the project portrait: the
 * design has an aspect and a resolution dropdown for that, and this is what
 * stands in until they exist.
 */
function noteSourceSize() {
  if (compositeFrame) return;
  for (const l of layers) {
    if (l.type !== 'video') continue;
    const source = layerSource(l);
    if (!source) continue;
    // The rate travels with the size for the same reason the size is kept once
    // it is set: the export is written at the project's rate, and a project
    // that took its rate from whichever layer happens to be first today would
    // change what it renders when that layer is deleted.
    compositeFrame = {
      width: source.width,
      height: source.height,
      fps: Math.round((l.sourceFps || 0) * 1000) / 1000 || COMPOSITE_FALLBACK.fps,
    };
    sizeCompositeCanvas();
    return;
  }
}

// The same dance as dropPreviewSources, and for the same reason: on Windows one
// remaining handle on a file is enough to make a cache clear silently fail.
function releaseDecoder(entry) {
  entry.el.pause();
  entry.el.removeAttribute('src');
  entry.el.load();
  entry.el.remove();
}

function releaseComposite() {
  for (const entry of decoders.values()) releaseDecoder(entry);
  decoders.clear();
  releasePlayers();
  compositeFrame = null;
  landing.clear();
  clearTimeout(landingTimer);
}

function addDecoder(layer) {
  const v = document.createElement('video');
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  const entry = { el: v, width: 0, height: 0 };
  decoders.set(layer.id, entry);
  compositePool.appendChild(v);
  v.addEventListener('loadedmetadata', () => {
    entry.width = v.videoWidth;
    entry.height = v.videoHeight;
    noteSourceSize();
    updateRenderResolution();
    // The seed lands here and nowhere else, so this is where the dropdown finds
    // out what rate the project ended up with.
    updateFpsChoices();
    // And where the step already on the stack finds out too. The layer was
    // added and committed before this file said what rate it runs at, so
    // without this the snapshot behind the next gesture claims the project had
    // no rate, and Ctrl+Z over a rate change would find nothing to go back to.
    // Not a commit: a decoder answering is not a gesture.
    undoStack = projectHistory.reseat(undoStack, projectState());
    // This layer was not in the trim frames when they were last built, because
    // it had no size to place it by. The token makes a second arrival cancel
    // the first rather than queue behind it.
    renderTrimFrames();
    // It arrives parked at zero, which is the right frame only when the layer
    // happens to start there.
    if (compositePlaying) followDecoders();
    else parkDecoders();
    drawComposite();
  });
  // The frame is not there when currentTime is written, it is there when the
  // seek lands. Drawing on both is what fills the canvas in without the
  // scheduler having to wait for anything.
  v.addEventListener('seeked', () => {
    if (landing.delete(layer.id)) refreshHints();
    if (!compositePlaying) drawComposite();
  });
  window.lwclipper.fileUrl(layer.src).then((url) => {
    // The row may have gone while the path was crossing to the main process.
    if (decoders.get(layer.id) !== entry) return;
    v.src = url;
  });
}

/** One decoder per video layer: made when a layer appears, let go when it goes. */
function syncDecoders() {
  const wanted = new Set();
  for (const l of layers) {
    if (l.type !== 'video' || !l.src) continue;
    wanted.add(l.id);
    if (!decoders.has(l.id)) addDecoder(l);
  }
  for (const [id, entry] of decoders) {
    if (wanted.has(id)) continue;
    releaseDecoder(entry);
    decoders.delete(id);
    // Nothing is going to answer for it now, so stop waiting on it.
    landing.delete(id);
  }
  // An empty project takes its shape from whatever source opens the next one.
  if (!decoders.size) compositeFrame = null;
}

/**
 * Every covering video layer at `at`, drawn onto one canvas.
 *
 * Shared by the preview canvas and by Step 10e's two trim frames, so a frame at
 * the in point and the picture at the playhead cannot be composited by two
 * different pieces of arithmetic and disagree.
 *
 * `only` restricts it to a single layer, which is what a scrub draws.
 */
/**
 * One layer's picture, drawn where that layer goes.
 *
 * Pulled out of paintLayers in V2.1 so the Render Position tab can draw a layer
 * the playhead has left, which the composite by definition does not hold. One
 * piece of arithmetic for both, which is the same reason paintLayers itself is
 * shared with the two trim frames.
 */
function drawLayerInto(ctx, canvas, layer, crop = layer.crop, render = layer.render) {
  const entry = decoders.get(layer.id);
  if (!entry || !entry.width) return;
  const source = layerSource(layer);
  if (!source) return;
  const frame = projectFrame();
  const placement = layerGeometry.placeLayer({
    source,
    // The two drafts the popup is editing, when it is the one drawing. Defaulted
    // to what the layer says, which is what every other caller wants.
    crop,
    // V2.1. composer.js has read this since Step 3 and the preview never did,
    // so a positioned layer would have been shown in the middle of the frame
    // and written somewhere else. The two renderers are not allowed to
    // disagree, which is the rule the whole of Step 4 existed to establish.
    render,
    project: frame,
  });
  const d = layerGeometry.drawImageArgs(placement, frame, canvas);
  if (!d) return;
  // drawImage measures its source rectangle in the element's own intrinsic
  // size, which need not be the coded size the crop was set against. So the
  // rectangle is carried across as a fraction, exactly as paintCropFrame
  // does, and for the same reason the coded numbers are the ones stored:
  // they are what ffmpeg will crop with. Both are equal for square pixels,
  // where kx and ky come out at 1 and nothing is scaled at all.
  const kx = entry.width / source.width;
  const ky = entry.height / source.height;
  ctx.drawImage(entry.el, d.sx * kx, d.sy * ky, d.sw * kx, d.sh * ky,
    d.dx, d.dy, d.dw, d.dh);
}

function paintLayers(ctx, canvas, at, only, skip) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Back to front, which is the order layersAt hands them back in, so index 0
  // is drawn last and Video 1 ends up on top.
  for (const l of timelineModel.layersAt(layers, at)) {
    if (l.type !== 'video') continue;
    // Mid-scrub, only the layer that is actually on the playhead's frame. The
    // others still hold whatever the last position decoded, and a frame from
    // another moment drawn into the composite has nothing on it to say it is
    // not the real one.
    if (only && l.id !== only.id) continue;
    // The layer the position tab is drawing itself, from its draft. Left in, it
    // would be drawn twice and its stored position would show underneath.
    if (skip && l.id === skip) continue;
    drawLayerInto(ctx, canvas, l);
  }
}

function drawComposite() {
  if (compositeCanvas.hidden) return;
  // The pool is parked at a trim point rather than at the playhead, so whatever
  // it holds right now is not this canvas's picture. Step 10e.
  if (paintingFrames) return;
  const only = compositeScrub ? scrubTarget() : null;
  // A scrub above 1080p seeks nothing, so there is nothing new to draw and the
  // canvas keeps the last full composite. Clearing it to black instead would be
  // less use than the stale picture, not more.
  if (compositeScrub && !only) return;
  paintLayers(compositeCtx, compositeCanvas, compositeAt, only);
}

// Standing still: every covering layer on its exact frame, everything else
// paused. The tolerance is a thousandth of a second rather than the playing
// one, because a still frame that is nearly right is simply the wrong frame.
function parkDecoders() {
  const only = compositeScrub ? scrubTarget() : null;
  for (const l of layers) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    if (!entry) continue;
    if (!entry.el.paused) entry.el.pause();
    // Mid-scrub, only the top covering layer moves, and above 1080p not even
    // that. Everything else is landed by endScrub when the mouse comes up.
    if (compositeScrub && (!only || l.id !== only.id)) continue;
    if (!entry.width || !l.enabled || !timelineModel.covers(l, compositeAt)) continue;
    const want = timelineModel.sourceTimeFor(l, compositeAt);
    if (Math.abs(entry.el.currentTime - want) < 0.001) continue;
    entry.el.currentTime = want;
  }
}

// Running: elements play at their own rate and are only dragged back when they
// are genuinely lost, since every re-seek is a decode. A layer the playhead has
// left, or one that has been switched off, stops rather than playing on unseen
// behind the others.
function followDecoders() {
  for (const l of layers) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    if (!entry) continue;
    const v = entry.el;
    if (l.enabled && timelineModel.covers(l, compositeAt)) {
      const want = timelineModel.sourceTimeFor(l, compositeAt);
      if (Math.abs(v.currentTime - want) > COMPOSITE_SLACK) v.currentTime = want;
      if (v.paused) v.play().catch(() => {});
    } else if (!v.paused) {
      v.pause();
    }
  }
}

/**
 * The node every audio layer sums into.
 *
 * Connected straight to the output. Step 10d is what puts the spectrum's two
 * analysers on the end of it, which is the whole of that step: the chain
 * ensureGainChain builds for the three fixed preview elements is already a
 * three input mix, and this is the same shape generalised to N.
 */
function ensureMixBus() {
  if (mixBus) return mixBus;
  const ctx = ensureAudioContext();
  const tail = ensureAnalysers();
  if (!ctx) return null;
  mixBus = ctx.createGain();
  // Step 10d. Into the analysers, not straight to the output. Without this the
  // spectrum in advanced mode reads the three fixed elements, which are silent
  // there, so it showed a flat line over a project that was plainly playing.
  // Falls back to the output if there are no analysers, because being heard
  // matters more than being drawn.
  mixBus.connect(tail || ctx.destination);
  return mixBus;
}

// A layer that is switched off goes silent rather than being torn down, so
// ticking the box back on is immediate and costs no reload. Unticking is
// immediate for the same reason: the gain is set here and nothing has to wait
// for an element to react.
function playerGain(layer) {
  return layer.enabled ? Math.max(0, layer.volume) : 0;
}

function applyPlayerGain(layer) {
  const entry = players.get(layer.id);
  if (!entry) return;
  if (entry.gain) entry.gain.gain.value = playerGain(layer);
  // No Web Audio in this window, so the element's own volume is all there is
  // and the slider simply stops getting louder past 100% rather than failing.
  else entry.el.volume = Math.min(1, playerGain(layer));
}

// The same dance as releaseDecoder, and for the same reason: on Windows one
// remaining handle on a file is enough to make a cache clear silently fail.
// The source node cannot be detached from the element, since an element only
// ever has one and it lasts as long as the element does, so what leaves the bus
// is the gain node.
function releasePlayer(entry) {
  entry.el.pause();
  entry.el.removeAttribute('src');
  entry.el.load();
  entry.el.remove();
  if (entry.gain) entry.gain.disconnect();
}

function releasePlayers() {
  for (const entry of players.values()) releasePlayer(entry);
  players.clear();
}

function addPlayer(layer) {
  const a = document.createElement('audio');
  a.preload = 'auto';
  const entry = { el: a, gain: null };
  players.set(layer.id, entry);
  compositePool.appendChild(a);
  const bus = ensureMixBus();
  if (bus) {
    try {
      const gain = gainCtx.createGain();
      gainCtx.createMediaElementSource(a).connect(gain);
      gain.connect(bus);
      entry.gain = gain;
    } catch {
      // Routing an element is a one-way door and this one did not open, so the
      // player stays on its own volume for the rest of its life.
      entry.gain = null;
    }
  }
  applyPlayerGain(layer);
  window.lwclipper.fileUrl(layer.src).then((url) => {
    // The row may have gone while the path was crossing to the main process.
    if (players.get(layer.id) !== entry) return;
    a.src = url;
  });
}

/** One player per audio layer: made when a layer appears, let go when it goes. */
function syncPlayers() {
  const wanted = new Set();
  for (const l of layers) {
    if (l.type !== 'audio' || !l.src) continue;
    wanted.add(l.id);
    if (!players.has(l.id)) addPlayer(l);
    // Applied here and not only where the controls are, so a layer that arrives
    // already switched off or already quiet arrives that way.
    applyPlayerGain(l);
  }
  for (const [id, entry] of players) {
    if (wanted.has(id)) continue;
    releasePlayer(entry);
    players.delete(id);
  }
}

// Standing still is silence, and nothing is seeked to get there. A scrub calls
// this on every pointer move, and placing every audio layer on every move would
// be a decode each for sound nobody can hear while the mouse is down. Where
// they resume from is settled by followPlayers when the transport starts again.
function parkPlayers() {
  for (const entry of players.values()) {
    if (!entry.el.paused) entry.el.pause();
  }
}

/**
 * Running: every enabled audio layer covering the playhead sounds, placed from
 * the project's clock exactly the way the replacement track is placed from the
 * video's, and against the same tolerance.
 *
 * force skips that tolerance, for the moments where the playhead jumps rather
 * than advances and any leftover drift would be plainly audible.
 */
function followPlayers(force) {
  for (const l of layers) {
    if (l.type !== 'audio') continue;
    const entry = players.get(l.id);
    if (!entry) continue;
    const a = entry.el;
    if (l.enabled && timelineModel.covers(l, compositeAt)) {
      const want = timelineModel.sourceTimeFor(l, compositeAt);
      if (force || Math.abs(a.currentTime - want) > AUDIO_SYNC_SLACK) a.currentTime = want;
      // A play() interrupted by the next seek rejects; that is not a failure.
      if (a.paused) a.play().catch(() => {});
    } else if (!a.paused) {
      // Past its end, before its start, or switched off. Stopped rather than
      // left running silently, so it is not still going when the playhead comes
      // back to it.
      a.pause();
    }
  }
}

/**
 * The topmost video layer covering the playhead. layersAt hands them back to
 * front so that drawing them in order works, which puts the top one last.
 */
function topCovering() {
  const hits = timelineModel.layersAt(layers, compositeAt);
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    if (hits[i].type === 'video') return hits[i];
  }
  return null;
}

/**
 * The one layer a scrub may seek, or null for none at all.
 *
 * Step 0 measured seeking every layer at 0.8 to 1.2s at 1080p and 2.3 to 5.0s
 * at 4K, which is not a scrub, it is a wait. The top covering layer alone
 * settles in 120 to 200ms at 1080p, and that is a live scrub. At 4K even one
 * layer is about 450ms, so there the answer is to seek nothing until the mouse
 * comes up.
 */
function scrubTarget() {
  const top = topCovering();
  if (!top) return null;
  const entry = decoders.get(top.id);
  if (!entry || !entry.width) return null;
  if (entry.width * entry.height > SCRUB_PIXELS) return null;
  return top;
}

function beginScrub() {
  if (compositeScrub) return;
  // The scrub takes the playhead over, so playback stops rather than the two of
  // them fighting over the same clock.
  if (compositePlaying) pauseComposite();
  compositeScrub = true;
}

function endScrub() {
  if (!compositeScrub) return;
  compositeScrub = false;
  landDecoders();
}

/**
 * Bring every covering layer onto the playhead's frame, and say so until they
 * arrive. The picture fills in as each one lands, because every decoder redraws
 * the composite on its own seeked.
 */
function landDecoders() {
  landing.clear();
  for (const l of timelineModel.layersAt(layers, compositeAt)) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    if (!entry || !entry.width) continue;
    const want = timelineModel.sourceTimeFor(l, compositeAt);
    if (Math.abs(entry.el.currentTime - want) < 0.001) continue;
    landing.add(l.id);
    entry.el.currentTime = want;
  }
  clearTimeout(landingTimer);
  if (landing.size) {
    // A decoder that never answers must not leave the message up for the rest
    // of the session. Well past the 7.4s worst case Step 0 measured.
    landingTimer = setTimeout(() => { landing.clear(); refreshHints(); }, 20000);
  }
  refreshHints();
  drawComposite();
}

function catchingUp() {
  return landing.size > 0;
}

// ---- Step 10e, the Start and End frames ----
//
// At a trim point the frame is a composite of whatever covers that moment, so
// it cannot be a video element seeked into one file. It is built from the same
// decoder pool the preview uses, which is only affordable because it happens on
// release and never during a drag: seeking every covering layer is about a
// second at five 1080p layers, and a spinner is what says so.
//
// While it runs the pool is parked somewhere other than the playhead, and every
// decoder redraws the preview on its own seeked, so drawComposite has to be
// held off for the duration or the preview would flash the trim point's
// picture. That is the whole of what this flag is for.

const startFrameCtx = startFrameCanvas.getContext('2d', { alpha: false });
const endFrameCtx = endFrameCanvas.getContext('2d', { alpha: false });
// The loop that owns the pool, and what it has been asked for: null, 'start',
// 'end' or 'both'. One loop only, because two renders seeking the same decoders
// would each be moving the other's.
let framesRunning = false;
let framesWanted = null;
// Bumped by every marker move. A render that finishes on an older generation is
// already out of date, so it leaves the spinner up for the one that follows it.
let trimDragGen = 0;
// A rebuild asked for while the transport was running, to be done when it stops.
let trimFramesStale = false;

/**
 * Where the End frame is actually painted.
 *
 * The out point is exclusive: composer.js trims to it, so the last frame in the
 * output is the one just before it, and at the very end of a project nothing
 * covers that instant at all. Painting exactly there gives a black frame, which
 * is what the first run of this showed. Backed off the same 0.05s the simple
 * mode frame seeker backs off from its own limit, for the same reason.
 */
function trimFrameOutAt() {
  return Math.max(slider.start, slider.end - 0.05);
}

/**
 * The spinners, by name. Turning them on names which one, because a drag on the
 * in marker leaves the End frame perfectly current and putting a spinner over
 * it would be a lie. Turning them off clears both: whoever is clearing is the
 * only render left, so there is nothing that could still be waiting.
 */
function trimFramesBusy(on, which) {
  if (!on) {
    startFrameBusy.hidden = true;
    endFrameBusy.hidden = true;
    return;
  }
  if (which !== 'end') startFrameBusy.hidden = false;
  if (which !== 'start') endFrameBusy.hidden = false;
}

function sizeTrimFrameCanvases() {
  const size = layerGeometry.previewCanvasSize(projectFrame());
  if (!size) return;
  for (const canvas of [startFrameCanvas, endFrameCanvas]) {
    if (canvas.width === size.width && canvas.height === size.height) continue;
    canvas.width = size.width;
    canvas.height = size.height;
  }
}

/**
 * Park every covering layer on the frame for `at`, and resolve once they are
 * all there. A decoder that never answers must not hold the spinner up for the
 * rest of the session, so each wait has its own way out.
 */
function seekDecodersTo(at) {
  const waits = [];
  for (const l of timelineModel.layersAt(layers, at)) {
    if (l.type !== 'video') continue;
    const entry = decoders.get(l.id);
    if (!entry || !entry.width) continue;
    const want = timelineModel.sourceTimeFor(l, at);
    // Assigning the position it already holds may produce no seeked event at
    // all, which would leave this waiting for a reply that never comes.
    if (Math.abs(entry.el.currentTime - want) < 0.001) continue;
    waits.push(new Promise((resolve) => {
      const done = () => {
        entry.el.removeEventListener('seeked', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 10000);
      entry.el.addEventListener('seeked', done);
      entry.el.currentTime = want;
    }));
  }
  return Promise.all(waits);
}

/**
 * Rebuild both trim frames, then put the pool back where the playhead is.
 *
 * Deliberately not called during a drag. The user sets the spinner going on the
 * press and this runs on the release, which is what makes reusing the live pool
 * affordable at all.
 */
/** 'start' and 'end' together are 'both'; anything with 'both' stays 'both'. */
function mergeWhich(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a === b ? a : 'both';
}

/**
 * Ask for a rebuild. Never runs two at once.
 *
 * The pool is shared with the preview, so two renders seeking it at the same
 * time would each be moving the other's decoders. Requests therefore coalesce
 * into `framesWanted` and one loop drains it, which also means a drag that
 * dwells repeatedly does not pile up a queue of stale renders: by the time the
 * loop comes round again, `framesWanted` holds only the latest ask.
 */
function renderTrimFrames(which) {
  if (!compositing()) return;
  if (compositePlaying) {
    // Seeking the pool out from under a running transport would stutter the
    // picture and the sound. Remember, and do it when it stops.
    trimFramesStale = true;
    return;
  }
  trimFramesStale = false;
  framesWanted = mergeWhich(framesWanted, which || 'both');
  trimFramesBusy(true, framesWanted);
  if (!framesRunning) runTrimFrames();
}

async function runTrimFrames() {
  if (framesRunning) return;
  framesRunning = true;
  // Nothing may draw the preview from the pool while this has it parked
  // somewhere other than the playhead.
  paintingFrames = true;
  try {
    while (framesWanted) {
      const which = framesWanted;
      framesWanted = null;
      // Which drag this pass belongs to. If the markers move while it is being
      // built it is out of date before it lands, and the spinner has to stay up
      // for the pass that will replace it rather than being cleared here.
      const gen = trimDragGen;
      sizeTrimFrameCanvases();
      const jobs = [];
      if (which !== 'end') jobs.push([startFrameCtx, startFrameCanvas, slider.start]);
      if (which !== 'start') jobs.push([endFrameCtx, endFrameCanvas, trimFrameOutAt()]);
      for (const [ctx, canvas, at] of jobs) {
        await seekDecodersTo(at);
        paintLayers(ctx, canvas, at, null);
      }
      // Back to the playhead before anything else can look at the pool.
      await seekDecodersTo(compositeAt);
      if (gen === trimDragGen && !framesWanted) trimFramesBusy(false);
    }
  } finally {
    framesRunning = false;
    paintingFrames = false;
    drawComposite();
  }
}

/** Move the project's playhead, which is what the timeline seeks. */
function seekComposite(at) {
  compositeAt = Math.min(Math.max(at, 0), compositeTotal());
  parkDecoders();
  // A seek is a jump, so the tolerance is skipped: the audio goes exactly where
  // the playhead went rather than up to a quarter second behind it.
  if (compositePlaying) followPlayers(true);
  else parkPlayers();
  drawComposite();
}

// The clock is the wall clock rather than any one element's. With N elements
// there is no obvious one to follow, and the model's own arithmetic is then
// what every element is held against, which is exactly what the encoder does
// with the same numbers.
function compositeTick() {
  if (!compositePlaying) return;
  const now = performance.now();
  const total = compositeTotal();
  compositeAt = Math.min(total, compositeAt + (now - compositeLast) / 1000);
  compositeLast = now;
  // With an audio output there is nothing to draw, so the video layers are left
  // where they are rather than decoded for a canvas that is hidden.
  if (compositing()) followDecoders();
  followPlayers(false);
  drawComposite();
  updatePlayhead();
  // Step 17. Play selection's stop point, which the media elements check in
  // their timeupdate and the compositor had nowhere to check at all. Ahead of
  // the end of the project, because it is always the earlier of the two.
  if (playUntil !== null && compositeAt >= playUntil) {
    pauseComposite();
    playUntil = null;
    return;
  }
  if (compositeAt >= total) {
    pauseComposite();
    return;
  }
  compositeRaf = requestAnimationFrame(compositeTick);
}

function playComposite() {
  if (compositePlaying) return;
  const total = compositeTotal();
  if (!total) return;
  // Back to the top when the playhead is already sitting at the end, which is
  // where every run leaves it.
  if (compositeAt >= total) compositeAt = 0;
  // A context made before any click starts suspended, and this is a click.
  if (gainCtx && gainCtx.state === 'suspended') gainCtx.resume();
  compositePlaying = true;
  compositeLast = performance.now();
  updateCompositeUi();
  // The same kick the media elements give it through their play listeners.
  startSpectrum();
  compositeRaf = requestAnimationFrame(compositeTick);
}

function pauseComposite() {
  if (compositeRaf !== null) {
    cancelAnimationFrame(compositeRaf);
    compositeRaf = null;
  }
  compositePlaying = false;
  // Stopped where they are rather than parked exactly. They are already within
  // a couple of milliseconds of the playhead, and re-seeking all of them would
  // cost a decode each to land on the frame that is already on screen.
  for (const entry of decoders.values()) entry.el.pause();
  parkPlayers();
  updateCompositeUi();
  // One last frame, so the bars fall back to the line instead of freezing
  // mid-bounce, exactly as a paused media element leaves them.
  drawSpectrum();
  // A trim that moved while this was running is finally safe to build.
  if (trimFramesStale) renderTrimFrames();
}

function updateCompositeUi() {
  compositePlayBtn.textContent = compositePlaying ? t('Pause') : t('Play');
  compositePlayBtn.disabled = busy || !compositeTotal();
}

/**
 * Bring the preview frame in line with the mode it is in. Called wherever
 * advanced editing or the output format changes, since either of them decides
 * whether there is a composite to show at all.
 */
function applyCompositeMode() {
  const advanced = timelineDriving();
  const picture = compositing();
  // The frame belongs to advanced editing whether or not there is a picture in
  // it: the single media file is not what this mode is a preview of either way,
  // so the video element goes and the spectrum or the canvas takes the space.
  previewSection.dataset.composite = String(advanced);
  compositeCanvas.hidden = !picture;
  startFrameCanvas.hidden = !picture;
  endFrameCanvas.hidden = !picture;
  if (!picture) trimFramesBusy(false);
  compositePlayBtn.hidden = !advanced;
  if (!advanced) pauseComposite();
  else if (!transport.paused) {
    // The composite has the preview now, and until 10c the simple path could
    // still be sounding behind a picture the stylesheet had already hidden.
    transport.pause();
    syncPreviewAudio();
  }
  if (!advanced) {
    // Nothing is going to look at them, and each one is a handle on a file the
    // user may be about to clear out of the cache.
    releaseComposite();
    return;
  }
  syncDecoders();
  syncPlayers();
  sizeCompositeCanvas();
  parkDecoders();
  parkPlayers();
  drawComposite();
  updateCompositeUi();
  renderTrimFrames();
}

/**
 * Every change to the document. The pool follows the layers, and the playhead
 * cannot be left past the end of a project that has just got shorter.
 *
 * A live drag deliberately does not come through here: it writes `layers` and
 * redraws the timeline itself, so the picture is one gesture stale rather than
 * re-seeking every decoder on every pointer move.
 */
function syncComposite() {
  if (!appSettings.advancedEditing) return;
  syncDecoders();
  syncPlayers();
  compositeAt = Math.min(compositeAt, compositeTotal());
  if (compositePlaying) {
    followDecoders();
    followPlayers(false);
  } else {
    parkDecoders();
    parkPlayers();
  }
  drawComposite();
  updateCompositeUi();
  refreshHints();
}

compositePlayBtn.addEventListener('click', () => {
  if (compositePlaying) {
    pauseComposite();
  } else {
    // Plain play, so a stop point Play selection left behind is spent.
    playUntil = null;
    playComposite();
  }
});

// ---- playhead ----

// Where the preview has got to, shown on the waveform and on the trim slider.
// Both use sliderMetrics, the same mapping the trim handles are placed with, so
// the bar lands on exactly the x a handle would for that second. Drawn as
// elements rather than into the canvas, so following playback costs two style
// writes a frame instead of a full waveform redraw.
function updatePlayhead() {
  // The timeline's own mapping, not the fraction the other two share: this one
  // is zoomed and scrolled, so a second is not at a fixed fraction of the width.
  // In advanced mode it follows the compositor's clock as well, because the
  // project is the layers and there may be no media file loaded at all.
  const duration = media ? media.duration : 0;
  const shown = Math.min(Math.max(transport.currentTime || 0, 0), duration);
  const lineAt = timelineDriving() ? compositeAt : shown;
  if (timelineDuration() && timelineLane.clientWidth) {
    timelinePlayhead.style.left = (timelineView.timeToX(tlView, lineAt) - 0.5) + 'px';
    timelinePlayhead.hidden = false;
  } else {
    timelinePlayhead.hidden = true;
  }

  if (!duration) {
    audioPlayhead.hidden = true;
    trimPlayhead.hidden = true;
    return;
  }
  const frac = shown / duration;

  const audioM = sliderMetrics(audioCanvas.clientWidth);
  audioPlayhead.style.left = (audioM.inset + frac * audioM.usable - 0.5) + 'px';
  // Drawn as an element rather than into the canvas, so the empty-frame return
  // in drawWaveform does not reach it. The trim slider below keeps its own:
  // that one follows the picture, which is playing whether there is sound or not.
  audioPlayhead.hidden = !hasAudioTrack();

  const trimM = sliderMetrics(trimSliderEl.clientWidth);
  trimPlayhead.style.left = (trimM.inset + frac * trimM.usable - 0.5) + 'px';
  trimPlayhead.hidden = false;
}

let playheadRaf = null;

// timeupdate alone fires about four times a second, which reads as a stutter on
// a bar this thin, so playback drives it from the frame loop and the loop ends
// itself as soon as the preview stops.
function pumpPlayhead() {
  updatePlayhead();
  playheadRaf = transport.paused ? null : requestAnimationFrame(pumpPlayhead);
}

for (const elem of [previewVideo, previewSound]) {
  for (const evt of ['seeked', 'timeupdate', 'loadedmetadata', 'durationchange',
    'pause', 'ended', 'emptied']) {
    elem.addEventListener(evt, updatePlayhead);
  }
  elem.addEventListener('play', () => {
    if (playheadRaf === null) pumpPlayhead();
  });
}

// Space starts and stops the preview wherever it currently sits. Typing keeps
// its own meaning, and so does a focused checkbox, which is what an INPUT is
// here as often as it is a text box.
const KEEPS_SPACE = ['INPUT', 'TEXTAREA', 'SELECT'];

/**
 * Whether a popup is in the way, which every keyboard shortcut has to ask.
 *
 * One list rather than three. Step 13 added a third modal, and the way that
 * goes wrong is one of the handlers not being told about it: Space would play
 * the preview behind an open missing-files panel.
 */
function modalOpen() {
  return !settingsModal.hidden || !cropModal.hidden || !choiceModal.hidden;
}
// The same list for Ctrl+Z, and separate on purpose: these two guards are
// about different keys and there is no reason they should have to move
// together if one of them ever needs a tag the other does not.
const KEEPS_UNDO = ['INPUT', 'TEXTAREA', 'SELECT'];

function togglePreview() {
  // Advanced mode's transport is the compositor's. It belongs to no single
  // element, and it runs whether or not a media file is loaded behind it.
  if (timelineDriving()) {
    if (compositePlaying) {
      pauseComposite();
    } else {
      // The same reason the media branch below clears it: a stop point left
      // over from Play selection would end this the instant it started.
      playUntil = null;
      playComposite();
    }
    return;
  }
  if (!media) return;
  if (transport.paused) {
    // A stop point left over from Play selection would end this the instant it
    // started, whenever the preview already sits past the end of the selection.
    playUntil = null;
    transport.play();
  } else {
    transport.pause();
  }
}

document.addEventListener('keydown', (evt) => {
  if (evt.code !== 'Space' || evt.repeat) return;
  if (modalOpen()) return;
  const focused = document.activeElement;
  if (focused && KEEPS_SPACE.includes(focused.tagName)) return;
  if (!media && !timelineDriving()) return;
  // Without this a focused button would be pressed as well, and the preview's
  // own controls would toggle it a second time, cancelling this one out.
  evt.preventDefault();
  togglePreview();
});

playSelectionBtn.addEventListener('click', () => {
  // Step 17. This did nothing at all in advanced editing, because it opened on
  // a guard for media that is null there and then drove transport, the preview
  // element, which is not what plays a composite. The selection itself is the
  // same slider on both sides of the switch; only what plays it differs.
  if (timelineDriving()) {
    playUntil = slider.end;
    seekComposite(slider.start);
    playComposite();
    return;
  }
  if (!media) return;
  playUntil = slider.end;
  transport.currentTime = slider.start;
  transport.play();
  syncPreviewAudio(true);
});
for (const elem of [previewVideo, previewSound]) {
  elem.addEventListener('timeupdate', () => {
    if (playUntil !== null && transport.currentTime >= playUntil) {
      transport.pause();
      playUntil = null;
    }
  });
}

// ---- a modal that answers back ----
//
// Step 13. Both existing modals open and close through listeners and neither
// returns a decision. This one blocks whatever asked until a button is pressed,
// which is what the missing-files question and the unsaved-changes question
// both need, and what the "a project is already open" question in the design
// will need after them.
//
// A list of buttons rather than a boolean confirm, because the three-button
// case is the one that cannot be faked and the two-button case is just a list
// of two.

let choiceSettle = null;
let choiceCancelId = null;

/**
 * Put a question up and wait for the answer, which is the id of the button
 * pressed.
 *
 * `cancel` names the id that Escape and a click on the backdrop mean. That is
 * always the safe direction, matching the settings modal, and it is required
 * rather than optional so that no question can be put up with no way out of it.
 *
 * Step 18 added three things. `message` may be a list of paragraphs, because
 * Clear cache asks two questions at once and either of them can be absent.
 * `checks` draws a ticked list, and `footer` may be a function of what is
 * ticked, which is what lets a total under that list follow the boxes.
 *
 * The answer is still the id of the button pressed, in every case. Handing back
 * a pair when `checks` is passed would give one function two shapes of answer
 * depending on its arguments, and every existing caller would have to read
 * around that, so the ticks arrive through `onCheck` instead and the caller
 * keeps its own copy of them.
 */
function showChoice({ title, message, footer, entries, checks, onCheck, buttons, cancel }) {
  // Nothing may stack: a second question while one is up would strand the
  // first one's promise forever.
  if (choiceSettle) settleChoice(choiceCancelId);

  choiceTitle.textContent = title;
  // A paragraph each rather than one string: the two warnings Clear cache can
  // put up are separate points, and they run together as a single block.
  const lines = Array.isArray(message) ? message.filter(Boolean) : (message ? [message] : []);
  choiceMessage.replaceChildren();
  choiceMessage.hidden = !lines.length;
  for (const line of lines) {
    const note = document.createElement('p');
    note.className = 'modal__note';
    note.textContent = line;
    choiceMessage.appendChild(note);
  }

  // What is ticked lives here rather than in the caller, so the total under the
  // list and the answer handed back cannot drift apart: both read this one set.
  const ticked = new Set();
  const drawFooter = () => {
    const text = typeof footer === 'function' ? footer([...ticked]) : footer;
    choiceFooter.textContent = text || '';
    choiceFooter.hidden = !text;
  };

  choiceList.replaceChildren();
  choiceList.hidden = !(entries && entries.length) && !(checks && checks.length);
  for (const entry of entries || []) {
    const row = document.createElement('div');
    row.className = 'choice-row';
    const path = document.createElement('div');
    path.className = 'choice-row__path';
    path.textContent = entry.path;
    const badge = document.createElement('span');
    badge.className = 'choice-row__badge';
    badge.dataset.state = entry.state;
    badge.textContent = entry.state === 'replaced' ? t('Replaced') : t('Missing');
    row.appendChild(path);
    row.appendChild(badge);
    choiceList.appendChild(row);
  }

  // A label rather than a div, so the whole row is the hit area. These rows are
  // read for their name and their size, and the box on its own is a small
  // target for a decision about deleting files.
  for (const row of checks || []) {
    const line = document.createElement('label');
    line.className = 'choice-row choice-row--check';
    if (row.title) line.title = row.title;
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'choice-row__check';
    box.checked = !!row.checked;
    if (box.checked) ticked.add(row.id);
    const name = document.createElement('div');
    name.className = 'choice-row__name';
    name.textContent = row.label;
    line.appendChild(box);
    line.appendChild(name);
    if (row.badge) {
      const badge = document.createElement('span');
      badge.className = 'choice-row__badge';
      badge.textContent = row.badge;
      line.appendChild(badge);
    }
    const size = document.createElement('span');
    size.className = 'choice-row__size';
    size.textContent = row.note || '';
    line.appendChild(size);
    box.addEventListener('change', () => {
      if (box.checked) ticked.add(row.id);
      else ticked.delete(row.id);
      drawFooter();
      if (onCheck) onCheck([...ticked]);
    });
    choiceList.appendChild(line);
  }
  drawFooter();
  // A row that starts ticked counts from the start rather than from the first
  // click on it, which is the kind of thing that is only ever found late.
  if (onCheck) onCheck([...ticked]);

  choiceButtons.replaceChildren();
  for (const button of buttons) {
    // Not named el: that is the id lookup every other line in this file uses,
    // and shadowing it inside a loop is how someone later loses an afternoon.
    const node = document.createElement('button');
    node.textContent = button.label;
    if (button.primary) node.classList.add('btn--active');
    // Step 18. Red for the answer that deletes something and green for the way
    // out of it. The app has not had a coloured answer until now, because every
    // other question in here is answered by buttons that are all reversible.
    if (button.tone) node.dataset.tone = button.tone;
    node.addEventListener('click', () => settleChoice(button.id));
    choiceButtons.appendChild(node);
  }

  choiceCancelId = cancel;
  choiceModal.hidden = false;
  // So Enter and Escape both do something sensible without the pointer having
  // to travel, and so the panel is where the focus is while it is up.
  const primary = choiceButtons.querySelector('.btn--active') || choiceButtons.firstChild;
  if (primary) primary.focus();
  return new Promise((resolve) => { choiceSettle = resolve; });
}

function settleChoice(id) {
  choiceModal.hidden = true;
  const settle = choiceSettle;
  choiceSettle = null;
  choiceCancelId = null;
  if (settle) settle(id);
}

// Backdrop only, matching the other two popups: a click on the panel itself
// must not answer the question.
choiceModal.addEventListener('click', (evt) => {
  if (evt.target === choiceModal) settleChoice(choiceCancelId);
});

// ---- the project file ----
//
// Step 13. src/project.js decides what a .lwc says; the main process owns the
// dialogs and the stat calls. What is left here is the document itself: where
// it came from, whether it has changed since, and what to do about a file that
// has moved.

// Where the document was last saved or opened from, and what it was called.
// Null means it has never been written, which is what makes the Save button
// Save-or-Save-As without needing two of them.
let projectPath = null;
let projectTitle = '';

// The document as the file has it. Everything since is unsaved work.
let projectSaved = null;

/**
 * The document, as the file sees it.
 *
 * Not the same object undo takes: undo deliberately ignores the Enabled tick
 * and the volume, and both of those are saved. The project frame is included
 * because it detaches from its seed the moment it is set, so a project
 * reopened after its first layer was deleted still renders at the size it was
 * built at.
 */
function projectDocument() {
  return {
    layers,
    // Not projectFrame(), which substitutes a fallback. A project with no
    // picture in it yet has no frame, and writing a made-up one would give it
    // one it never had.
    project: compositeFrame || { width: 0, height: 0, fps: 0 },
    trim: { start: slider.start, end: slider.end },
  };
}

function projectDirty() {
  if (!timelineDriving()) return false;
  if (!projectSaved) return layers.length > 0;
  return !projectFile.sameDocument(projectDocument(), projectSaved);
}

/** This is now what the file says, so there is nothing unsaved. */
function markProjectSaved(document) {
  projectSaved = projectFile.documentOf(document || projectDocument());
  updateProjectUi();
}

function updateProjectUi() {
  if (!timelineDriving()) {
    projectNameLabel.hidden = true;
    return;
  }
  const dirty = projectDirty();
  const named = !!projectPath;
  // Step 17. The button is the way in to a timeline with nothing in it yet.
  // Once a project is open or anything is loaded it offers nothing the drop
  // zone, Open File and Ctrl+O do not, and it is a way to lose work by
  // accident. It comes back if the timeline is emptied again.
  openProjectBtn.hidden = named || layers.length > 0;
  projectNameLabel.hidden = !named && !layers.length;
  projectNameLabel.textContent = named ? projectTitle : t('Unsaved project');
  projectNameLabel.dataset.dirty = String(named && dirty);
  projectNameLabel.title = projectPath || '';
}

/**
 * Save, asking where only when it has to.
 *
 * Deliberately not blocked while a render is running, unlike almost everything
 * else in the app. A render is minutes and this writes three kilobytes that
 * touch nothing the render is using, so refusing would be an inconvenience
 * bought for nothing.
 */
async function saveProject(alwaysAsk) {
  if (!timelineDriving()) return false;
  let target = projectPath;
  if (!target || alwaysAsk) {
    const picked = await window.lwclipper.projectSaveDialog(projectPath || null);
    if (!picked || !picked.ok) return false;
    target = picked.path;
  }
  // Read once, so what is written and what is recorded as written cannot be
  // two different moments.
  const document = projectDocument();
  // Step 18. Who this project was before this save, so that a Save As renames
  // the claim in the cache rather than leaving the old one behind. Null on a
  // project that has never been saved, which has nothing to rename.
  const result = await window.lwclipper.saveProject(target, document,
    projectPath ? { path: projectPath, name: projectTitle } : null);
  if (!result.ok) {
    reportFailure(result);
    return false;
  }
  projectPath = result.path;
  projectTitle = result.name;
  markProjectSaved(document);
  setStatus('Project saved.');
  return true;
}

/**
 * Say why a project would not open.
 *
 * Written as a run of setStatus() calls rather than a code-to-string table,
 * because scripts/check-locales.js reads the literal that follows t( or
 * setStatus( and a string sitting in an object never reaches it. A key nothing
 * can see is a key nobody is told is missing, and these four were reported as
 * no longer used while being the only thing the window says when an open fails.
 */
function setProjectError(code) {
  if (code === 'notJson' || code === 'notProject') {
    setStatus('That file is not a LWClipper project.');
  } else if (code === 'tooNew') {
    setStatus('That project was saved by a newer version of LWClipper.');
  } else {
    setStatus('That project could not be read.');
  }
}

async function openProjectFile() {
  if (!timelineDriving() || busy) return;
  // Whatever is open now would be replaced, so ask before the file dialog
  // rather than after: being asked about unsaved work only once a new project
  // has been chosen is the wrong order.
  if (!(await confirmDiscard())) return;
  const result = await window.lwclipper.projectOpenDialog();
  if (!result || result.cancelled) return;
  if (!result.ok) {
    setProjectError(result.error);
    return;
  }
  await adoptProject(result);
}

/**
 * Open a project whose path is already known: dropped on the window, or chosen
 * from the Open File dialog rather than from Open Project.
 *
 * The guard runs after the file is named here and before it in openProjectFile
 * above, which is not an inconsistency: there the dialog has still to happen and
 * asking first is the only order that makes sense, here the file has already
 * arrived and there is nothing left to ask first.
 */
async function openProjectPath(filePath) {
  if (busy || !filePath) return;
  // Advanced editing first, so the guard below is asked in the mode that has a
  // project to lose. Asked in simple editing it always answers yes, because
  // projectDirty() reports false there, and a timeline switched away from five
  // minutes ago would go without a word.
  //
  // Switching it is not a liberty: a .lwc is the advanced editing document, so
  // handing one to the app is asking for the mode it belongs to. It is a
  // visible setting and one click to put back.
  const wasSimple = !timelineDriving();
  if (wasSimple) await setAdvancedEditing(true);
  // Anything that ends without a project open puts the switch back, because
  // nothing else about the window changed either.
  if (!(await confirmDiscard())) {
    if (wasSimple) await setAdvancedEditing(false);
    return;
  }
  const result = await window.lwclipper.openProject(filePath);
  if (!result || !result.ok) {
    if (wasSimple) await setAdvancedEditing(false);
    setProjectError(result && result.error);
    return;
  }
  await adoptProject(result);
}

/**
 * Put an opened project on screen.
 *
 * Every reference was resolved by the main process, so what arrives is the
 * document plus one verdict per layer. Anything that is not where it was gets
 * named before anything is decided, which is the whole point of the modal:
 * Cancel has to be a real option and it cannot be if the tracks are already
 * gone.
 */
async function adoptProject(result) {
  const { layers: resolved, trouble } = projectFile.applyStatuses(result.doc, result.statuses);
  if (trouble.length) {
    const choice = await showChoice({
      title: t('Unable to find source files'),
      message: t('These files have moved or been deleted:'),
      entries: trouble,
      footer: t('You can continue opening the project, but the tracks using these files will be removed. Cancel instead to put the files back where they were, then open the project again.'),
      buttons: [
        { id: 'continue', label: t('Continue') },
        { id: 'cancel', label: t('Cancel'), primary: true },
      ],
      cancel: 'cancel',
    });
    if (choice !== 'continue') return;
  }

  // Through the model, which is what says what a layer is. A file carries a
  // ref block and may carry fields this version has never heard of; createLayer
  // takes what it knows and clamps it.
  const built = resolved.map((l) => timelineModel.createLayer(l));
  const keep = trouble.length ? projectFile.pruneTrouble(built, trouble) : built;

  const frame = result.doc.project;
  compositeFrame = (frame.width > 1 && frame.height > 1)
    ? {
      width: frame.width,
      height: frame.height,
      // A project written before Step 15 carries no rate at all, and the rate
      // the app rendered at then was the composer's own default.
      fps: frame.fps > 0 ? frame.fps : COMPOSITE_FALLBACK.fps,
    }
    : null;
  sizeCompositeCanvas();

  setLayers(keep);
  // After setLayers, the same ordering applyHistory needs: syncProjectTrim in
  // there follows the project's new length and would move the very markers
  // being restored.
  const total = timelineModel.totalDuration(keep);
  trimSpan = total;
  if (total <= 0) slider.reset();
  else slider.setRange(total, result.doc.trim.start, result.doc.trim.end);
  setTrimEnabled(!busy && trimmable());
  refreshSelection(null);
  renderTrimFrames();
  // Fitted to the opened project rather than left at the last one's zoom,
  // which would be a view of a timeline that is no longer there.
  tlFitted = true;
  syncTimelineView();
  drawTimeline();
  updatePlayhead();

  projectPath = result.path;
  projectTitle = result.name;
  // Opening replaces the document, so there is nothing behind it for Ctrl+Z to
  // resurrect. The stack is session state and never goes in the file.
  undoStack = projectHistory.create(projectState());

  // The baseline is the project **as the file has it**, tracks in trouble
  // included. So Continue having dropped them in memory reads as unsaved work,
  // which is exactly what it is: the file still references them, and it is
  // never rewritten by opening it. That is what keeps Continue a safe choice.
  markProjectSaved({
    layers: built,
    project: compositeFrame || { width: 0, height: 0, fps: 0 },
    trim: result.doc.trim,
  });
  // Two calls rather than one with a ternary in it, for the reason spelled out
  // over setProjectError: the checker sees a literal and nothing else.
  if (trouble.length) setStatus('Project opened without {n} track(s).', { n: trouble.length });
  else setStatus('Project opened.');
}

/**
 * Ask before throwing unsaved work away. True means carry on.
 *
 * Save is offered rather than only Discard and Cancel, because the answer to
 * "you have unsaved changes" is usually "then save them" and making that a
 * two-step is the kind of thing that loses work.
 */
async function confirmDiscard() {
  if (!projectDirty()) return true;
  const choice = await showChoice({
    title: t('Unsaved changes'),
    message: t('This project has changes that have not been saved.'),
    buttons: [
      { id: 'save', label: t('Save Project') },
      { id: 'discard', label: t('Discard') },
      { id: 'cancel', label: t('Cancel'), primary: true },
    ],
    cancel: 'cancel',
  });
  if (choice === 'save') return saveProject(false);
  return choice === 'discard';
}

openProjectBtn.addEventListener('click', openProjectFile);

// Ctrl+S saves, Ctrl+Shift+S saves somewhere else, Ctrl+O opens. Nothing in the
// app used any of the three.
document.addEventListener('keydown', (evt) => {
  if (!evt.ctrlKey && !evt.metaKey) return;
  const key = String(evt.key).toLowerCase();
  if (key !== 's' && key !== 'o') return;
  if (!timelineDriving() || modalOpen()) return;
  evt.preventDefault();
  if (key === 'o') openProjectFile();
  else saveProject(evt.shiftKey);
});

// The window is held shut until this answers. Closing with unsaved work is the
// second user of showChoice and the reason it was built as a pair.
window.lwclipper.onClosing(async () => {
  if (await confirmDiscard()) window.lwclipper.allowClose();
});

// ---- undo ----
//
// Step 12. src/history.js holds the stack, the no-op skip and the rule about
// which fields undo owns. Everything here is the two halves it cannot do:
// taking a snapshot at the right moment, and putting one back on screen.
//
// Advanced editing only. Every gesture on the list the user gave is a layer
// operation or a trim marker on the timeline, and simple mode has neither a
// layer list nor anything else undo would know how to restore.

/**
 * The document as undo sees it.
 *
 * The layer array itself, not a copy: src/timeline.js never mutates, so every
 * layer in it is already frozen in practice and a snapshot cannot change under
 * the stack. The trim markers ride along because moving them is on the list.
 *
 * Deliberately not in here: the playhead, the timeline zoom and scroll, and the
 * selection. The first two the user ruled out by name, and all three are where
 * the window is looking rather than what the document says. Restoring them
 * would move the view out from under whoever pressed Ctrl+Z, and comparing them
 * would turn a click on a row into an undo step of its own.
 *
 * The whole project frame is in here: the rate from Step 16's dropdown and the
 * size from V2.1's resolution boxes. Both are gestures, and a gesture the stack
 * cannot see is a Ctrl+Z that skips it.
 *
 * All of it arrives asynchronously from a decoder's metadata, so a snapshot
 * taken before that landed holds no shape at all, and putting that back would
 * unseed a project for pressing Ctrl+Z. What protects it is applyHistory, which
 * treats a snapshot without a frame in it as saying nothing about the frame
 * rather than as saying there is none.
 */
function projectState() {
  return {
    layers,
    start: slider.start,
    end: slider.end,
    fps: compositeFrame ? compositeFrame.fps : 0,
    width: compositeFrame ? compositeFrame.width : 0,
    height: compositeFrame ? compositeFrame.height : 0,
  };
}

// Named undoStack rather than history, which would shadow window.history in the
// one global lexical scope every classic script here shares.
//
// Seeded here rather than lazily, and that matters: a commit records the state
// the gesture produced, so without a present already standing behind it the
// very first gesture of a session would have nothing to go back to.
let undoStack = projectHistory.create(projectState());

/**
 * One gesture, one step. Called after the change has been made, because the
 * stack holds where things are now and where they were, not an instruction.
 *
 * A gesture that changed nothing is dropped by the stack itself rather than by
 * every caller having to check, which is what keeps Ctrl+Z from appearing to do
 * nothing several times in a row.
 */
function commitHistory() {
  if (!timelineDriving()) return;
  undoStack = projectHistory.commit(undoStack, projectState());
}

/**
 * Put a step on screen.
 *
 * The snapshot is not applied as it stands: restore() hands back the same
 * document with every surviving layer keeping the Enabled tick and the volume
 * it has right now, because those two are not undo's to move.
 */
function applyHistory(next) {
  if (!next || next === undoStack) return;
  const state = projectHistory.restore(next.present, layers);
  if (!state) return;
  undoStack = next;
  // A snapshot from before the project had a shape says nothing about the frame
  // rather than saying the frame is nothing, so it leaves the one in force
  // alone. Set before setLayers, which asks what size the project renders at on
  // its way through updateRenderResolution.
  if (compositeFrame) {
    if (state.fps > 0) compositeFrame = { ...compositeFrame, fps: state.fps };
    if (state.width > 1 && state.height > 1) {
      compositeFrame = { ...compositeFrame, width: state.width, height: state.height };
      // The preview canvas is the project's own shape, so undoing a resize has
      // to resize it back before anything is drawn into it.
      sizeCompositeCanvas();
    }
  }
  setLayers(state.layers);
  // After setLayers and not before. syncProjectTrim in there follows a project
  // that just got longer or shorter, and it would move the very markers being
  // restored.
  const total = timelineModel.totalDuration(state.layers);
  trimSpan = total;
  if (total <= 0) slider.reset();
  else slider.setRange(total, state.start, state.end);
  setTrimEnabled(!busy && trimmable());
  refreshSelection(null);
  // The markers moved after setLayers asked for its rebuild, so both frames are
  // pictures of the wrong moments again.
  renderTrimFrames();
}

// Ctrl+Z, Ctrl+Y, and Ctrl+Shift+Z, which is the other spelling of redo that
// every editor also answers to.
document.addEventListener('keydown', (evt) => {
  if (!evt.ctrlKey && !evt.metaKey) return;
  const key = String(evt.key).toLowerCase();
  const redoing = key === 'y' || (key === 'z' && evt.shiftKey);
  const undoing = key === 'z' && !evt.shiftKey;
  if (!undoing && !redoing) return;
  if (!timelineDriving() || busy) return;
  // A popup is its own gesture with its own Cancel. Undoing the document out
  // from under an open crop would leave it editing a rectangle on a layer that
  // may no longer be there.
  if (modalOpen()) return;
  // The URL box and the time and offset fields keep their own native undo.
  // Taking Ctrl+Z off a text box is how someone loses a paste.
  const focused = document.activeElement;
  if (focused && KEEPS_UNDO.includes(focused.tagName)) return;
  if (focused && focused.isContentEditable) return;
  evt.preventDefault();
  applyHistory(redoing ? projectHistory.redo(undoStack) : projectHistory.undo(undoStack));
});

// ---- crop ----

// Every dimension ffmpeg is handed has to be even, because yuv420p subsamples
// chroma two pixels at a time and an odd one has no valid encoding. That is
// what sets the step sizes below rather than any feel for how fast a bar
// should move: one bar alone moves in twos, and a mirrored pair moves one each
// so the dimension between them still changes in twos.
const CROP_STEP = 2;
const CROP_MIRROR_STEP = 1;
// Small enough never to be in the way, large enough that the four grips do not
// pile up on each other and become impossible to tell apart.
const CROP_MIN = 16;

// The frame fills 90% of the popup, which is itself 80% of the window. A tall
// source would run off the bottom at that width, so the height is capped and
// the width follows it back down rather than the popup growing a scrollbar.
const CROP_FRAME_SHARE = 0.9;
const CROP_HEIGHT_SHARE = 0.48;

// Zoom tightens the crop rather than only magnifying it: the box keeps its
// place on the frame while the picture grows underneath, so at 200% it covers
// half as many source pixels each way and the boxes on the three preview frames
// shrink to match. The shape is kept, since both axes divide by the same zoom.
const CROP_ZOOM_MIN = 1;
const CROP_ZOOM_MAX = 4;

// Every arrow sits the same distance outside the frame, which is what the one
// gap is for. CROP_ARROW_SHORT is how much room each of the side ones needs
// beside the frame, and caps how wide the frame may be so a narrow popup cannot
// push one out past its edge.
const CROP_ARROW_SHORT = 19;
const CROP_ARROW_GAP = 6;

// V2.1, 21e. How far past the picture the frame may be dragged, as a multiple
// of the source on each axis. Four rather than a rounder number because of what
// the shapes ask for: turning a 16:9 clip into a 9:16 frame wants the height to
// reach 16/9 of the width, which on a 1280x720 source is 2276 against 720, a
// little over three. Four covers that with room over, and still leaves the
// picture a quarter of the stage to be looked at in.
const CROP_OUTER = 4;

const CROP_PRESETS = [
  { label: 'Original', ratio: null },
  { label: '21:9', ratio: 21 / 9 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '1:1', ratio: 1 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '9:16', ratio: 9 / 16 },
];

// Read from the markup for the same reason as HINT_IDLE and IDLE_STATUS.
const CROP_HINT_IDLE = cropHint.textContent;

// Step 11. Which layer the popup is pointed at, for as long as it is open.
// Held rather than re-read from the selection on every call, so that a row
// selected behind an open popup cannot move the crop onto it halfway through.
let cropLayerId = null;
// The zoom and pan each layer's crop was accepted at, keyed by layer id. Out of
// the model on purpose: it is where the popup was looking from, not part of the
// document, and the project file has no business carrying it.
const cropViews = new Map();

let cropRect = null;          // what a save will cut, in source pixels; null is the whole frame
let cropDraft = null;         // the rectangle the popup is editing
let cropScale = 1;            // display pixels per source pixel inside the popup
let cropBaseScale = 1;        // the same at 100%, which is the whole frame fitted to the stage
let viewZoom = 1;
let viewPanX = 0;             // the source coordinate sitting at the centre of the stage
let viewPanY = 0;
// Where the picture sits inside the frame, in frame pixels. The frame is always
// 16:9 so that the hint above it and the arrows around it never move; a picture
// of another shape sits centred in it with the frame's own grey either side of
// it or above and below. Everything that maps source pixels onto the frame goes
// through this rather than through the frame itself.
let cropPicture = { left: 0, top: 0, w: 0, h: 0 };
let cropAnchor = null;        // where the box sits on the picture, in fractions of it
let cropView = null;          // the zoom and pan a crop was accepted at
let cropActivePreset = null;
// V2.1, 21e-3. The ratio that preset names, kept beside the button because the
// button is a button and this is the number. Null for Original, which names no
// ratio of its own, and null once a drag has cleared the preset.
let cropActiveRatio = null;

/**
 * A preset is no longer what set this box, whatever set it instead: a drag, a
 * pan, the zoom, or the popup opening on a crop that was accepted earlier.
 *
 * One function rather than the two lines it replaces in five places. 21e-3 gave
 * the lit button a second thing to carry, its ratio, and five copies of "clear
 * the button" would have been five chances for one of them to forget.
 */
function clearActivePreset() {
  cropActivePreset = null;
  cropActiveRatio = null;
  markActivePreset();
}

const evenDown = (v) => Math.floor(v / 2) * 2;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * The frame a layer's crop is measured in: the probe's coded dimensions when
 * the file was probed, the decoder's intrinsic size when it was not.
 *
 * The probe wins for the same reason it does in simple mode, and it has to be
 * the same number here, in the filmstrip and in the encoder, or one crop would
 * mean three different rectangles.
 */
function layerSource(layer) {
  if (!layer) return null;
  if (layer.sourceWidth > 0 && layer.sourceHeight > 0) {
    return { width: layer.sourceWidth, height: layer.sourceHeight };
  }
  const entry = decoders.get(layer.id);
  if (entry && entry.width > 0 && entry.height > 0) {
    return { width: entry.width, height: entry.height };
  }
  return null;
}

/**
 * The layer the popup works on: whatever it was opened for while it is open,
 * and the selected video layer otherwise. Null in simple mode, where the
 * subject is the single media file and there is nothing to choose.
 */
function cropTargetLayer() {
  if (!timelineDriving()) return null;
  if (cropLayerId) return timelineModel.layerById(layers, cropLayerId);
  const l = selectedLayerId ? timelineModel.layerById(layers, selectedLayerId) : null;
  return l && l.type === 'video' ? l : null;
}

/**
 * The accepted crop, and where it is kept.
 *
 * Two storage places behind one pair of accessors: simple mode's single
 * rectangle, and the subject layer's own. Everything between here and the
 * popup's grips is written against "a rectangle in a source frame" and does not
 * need to know which of the two it is editing.
 */
function currentCrop() {
  if (timelineDriving()) {
    const l = cropTargetLayer();
    return l ? l.crop : null;
  }
  return cropRect;
}

function setCurrentCrop(rect, view) {
  if (timelineDriving()) {
    if (!cropLayerId) return;
    if (view) cropViews.set(cropLayerId, view);
    else cropViews.delete(cropLayerId);
    // Through setLayers, because a crop changes the picture: the preview and
    // both trim frames are composited through placeLayer and are now pictures
    // of the wrong rectangle.
    setLayers(timelineModel.setLayer(layers, cropLayerId, { crop: rect }));
    return;
  }
  cropRect = rect;
  cropView = view || null;
}

function currentCropView() {
  if (!timelineDriving()) return cropView;
  const l = cropTargetLayer();
  return l ? (cropViews.get(l.id) || null) : null;
}

// ffprobe's numbers are the coded dimensions ffmpeg's crop filter works in, so
// they win. The element's own are the fallback for anything that reached the
// app without a usable probe behind it.
function sourceSize() {
  // Advanced editing crops one layer, so the frame to crop out of is that
  // layer's. Same shape, same units, and everything downstream is unchanged.
  if (timelineDriving()) {
    const source = layerSource(cropTargetLayer());
    if (!source) return null;
    if (source.width < CROP_MIN || source.height < CROP_MIN) return null;
    return { w: evenDown(source.width), h: evenDown(source.height) };
  }
  const w = Math.floor((media && media.width) || previewVideo.videoWidth || 0);
  const h = Math.floor((media && media.height) || previewVideo.videoHeight || 0);
  if (w < CROP_MIN || h < CROP_MIN) return null;
  return { w: evenDown(w), h: evenDown(h) };
}

function canCrop() {
  if (timelineDriving()) return !!sourceSize();
  return !!(media && !media.isAudio && sourceSize());
}

function fullRect(size) {
  return { x: 0, y: 0, width: size.w, height: size.h };
}

/**
 * The shape a Shift and Ctrl drag holds on to.
 *
 * The lit preset if one is lit, and the box's own shape if none is. Original
 * lights a button without naming a ratio, and the two answers agree there
 * anyway: Original is the picture, so the box's shape is the picture's.
 *
 * Read at the press rather than during the drag. The first move clears the
 * preset, because a drag is no longer whatever a preset set, so by the second
 * move there would be nothing left to read.
 */
function cropLockRatio() {
  if (cropActiveRatio > 0) return cropActiveRatio;
  if (!cropDraft || cropDraft.height < 1) return null;
  return cropDraft.width / cropDraft.height;
}

/**
 * Whether the frame may be dragged out past the picture.
 *
 * Simple editing only, settled with the user on 2026-09-20. In advanced editing
 * the Render Position tab is what puts a picture somewhere in a frame, and a
 * layer whose own source had been padded would be a second answer to that same
 * question, which the two would then have to be kept agreeing about. In simple
 * editing there is no second answer: the crop is the only thing that decides
 * what shape the output is.
 */
function cropExtendable() {
  return !timelineDriving();
}

/**
 * Everything the stage has to show: the picture, and the frame the crop
 * describes. The same rectangle until a drag takes the frame outside the
 * picture, which is what makes all of this invisible to a crop that stays in.
 */
function cropOuter(size) {
  if (!cropDraft || !cropExtendable()) return { x: 0, y: 0, w: size.w, h: size.h };
  const x = Math.min(0, cropDraft.x);
  const y = Math.min(0, cropDraft.y);
  return {
    x,
    y,
    w: Math.max(size.w, cropDraft.x + cropDraft.width) - x,
    h: Math.max(size.h, cropDraft.y + cropDraft.height) - y,
  };
}

/**
 * How far out a drag may go, which is a fixed allowance and not the box above.
 * The box above grows with the frame, so holding the frame to it would be
 * holding it to itself and there would be no limit at all.
 */
function cropLimit(size) {
  if (!cropExtendable()) return { x: 0, y: 0, w: size.w, h: size.h };
  const grow = (CROP_OUTER - 1) / 2;
  return {
    x: -evenDown(size.w * grow),
    y: -evenDown(size.h * grow),
    w: evenDown(size.w * CROP_OUTER),
    h: evenDown(size.h * CROP_OUTER),
  };
}

/**
 * The part of the picture a view window covers, in source pixels. The whole of
 * the window until the frame reaches outside the picture and the two stop being
 * the same rectangle.
 */
function pictureOnStage(size, view) {
  const x = Math.max(0, view.x);
  const y = Math.max(0, view.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(size.w, view.x + view.w) - x),
    h: Math.max(0, Math.min(size.h, view.y + view.h) - y),
  };
}

// V2.1, 21e. Exactly the source's size, not merely as large as it. The rect may
// reach outside the picture now, and a frame larger than the source is the one
// thing 21e exists to say, so reading it as "nothing to crop" would throw it
// away on the way to the file. Same correction as backend.js cropFilter.
function isFullFrame(rect, size) {
  return rect.x === 0 && rect.y === 0 && rect.width === size.w && rect.height === size.h;
}

// The largest rectangle of that shape the frame can hold, sat in the middle of
// it. Whichever dimension runs out first is the one that fixes the size.
function ratioRect(size, ratio) {
  let w = size.w;
  let h = evenDown(Math.round(w / ratio));
  if (h > size.h) {
    h = size.h;
    w = evenDown(Math.round(h * ratio));
  }
  w = clamp(w, CROP_MIN, size.w);
  h = clamp(h, CROP_MIN, size.h);
  return { x: evenDown((size.w - w) / 2), y: evenDown((size.h - h) / 2), width: w, height: h };
}

// object-fit: contain letterboxes the picture inside its box, so the overlay
// has to be placed against the picture rather than against the element.
function pictureBox(stage, size) {
  const bw = stage.clientWidth;
  const bh = stage.clientHeight;
  if (!bw || !bh) return null;
  const scale = Math.min(bw / size.w, bh / size.h);
  return { left: (bw - size.w * scale) / 2, top: (bh - size.h * scale) / 2, scale };
}

const CROP_OVERLAYS = [
  [() => previewStage, () => previewCropBox],
  [() => startFrameStage, () => startCropBox],
  [() => endFrameStage, () => endCropBox],
];

// The white box over all three frames, showing what a save will keep. Sized
// from the picture every time rather than cached, since the frames shrink and
// grow with the window.
function updateCropOverlays() {
  // Nothing to outline in advanced editing. All three frames there are drawn
  // through placeLayer, so the crop is already composited into the picture and
  // a box saying what will be kept would be drawn around a picture that is
  // nothing but the kept part.
  const size = (!timelineDriving() && cropRect) ? sourceSize() : null;
  for (const [stageOf, boxOf] of CROP_OVERLAYS) {
    const box = boxOf();
    const pic = size ? pictureBox(stageOf(), size) : null;
    if (!pic) {
      box.hidden = true;
      continue;
    }
    box.style.left = (pic.left + cropRect.x * pic.scale) + 'px';
    box.style.top = (pic.top + cropRect.y * pic.scale) + 'px';
    box.style.width = (cropRect.width * pic.scale) + 'px';
    box.style.height = (cropRect.height * pic.scale) + 'px';
    box.hidden = false;
  }
  updateRenderResolution();
  fitWindow();
}

/**
 * What the save will actually write: the crop when there is one, the source's
 * own coded dimensions otherwise. Those are ffprobe's numbers, which are the
 * ones ffmpeg's crop filter works in, so they are what the output really is.
 * Nothing to say when the output has no picture in it.
 */
function updateRenderResolution() {
  if (timelineDriving()) {
    // The project frame, which is what every layer is fitted into and what the
    // encoder writes. A per-layer crop deliberately does not change it: it
    // changes what that layer shows, not what size the output is.
    const showing = videoHeadShowing();
    // The row around it, which nothing else in this mode owns: updateVideoUi
    // answers for the media file and there is none here.
    videoHead.hidden = !showing;
    renderResolution.hidden = !showing;
    renderResolutionEdit.hidden = !showing;
    renderResolutionText.textContent = '';
    if (!showing) return;
    const frame = projectFrame();
    // Typeable only while the project has a shape of its own. projectFrame()
    // substitutes a fallback until a decoder has answered, and a box over a
    // number the project has not agreed to yet is a box that lies about what
    // pressing Enter in it would do.
    const editable = !!compositeFrame && !busy;
    for (const [box, value] of [[frameWidthBox, frame.width], [frameHeightBox, frame.height]]) {
      box.disabled = !editable;
      // Never over what is being typed. A file dropped while a box has the
      // focus comes back through here, and rewriting the value under the cursor
      // would throw the edit away mid-word.
      if (document.activeElement !== box) box.value = String(value);
    }
    return;
  }
  renderResolutionEdit.hidden = true;
  const size = sourceSize();
  const showing = !!media && !outputIsAudio() && !!size;
  renderResolution.hidden = !showing;
  if (!showing) return;
  const w = cropRect ? cropRect.width : size.w;
  const h = cropRect ? cropRect.height : size.h;
  renderResolutionText.textContent = t('Render Resolution: {w} x {h}', { w, h })
    + (cropRect ? ' ' + t('(cropped)') : '');
}

/**
 * The two boxes are one gesture, and that is arithmetic rather than tidiness.
 *
 * 1280x720 to 1920x1080 in one move carries a layer at 200,120 480x270 to
 * 300,180 720x405. The same change made as two, through 1920x720 on the way,
 * lands it at 520,300 480x270: pillarboxed and then letterboxed, which is a
 * different shot from the one that was asked for. So tabbing from one box to
 * the other does not commit anything, and whichever of the two is left last
 * commits both together.
 */
function commitFrameBoxes() {
  if (setProjectFrame(frameWidthBox.value, frameHeightBox.value)) return;
  // Refused, or the same size it already was. Either way the boxes are now
  // saying something the project is not, so they go back to what it says.
  updateRenderResolution();
}

for (const box of [frameWidthBox, frameHeightBox]) {
  box.addEventListener('focusout', (evt) => {
    if (evt.relatedTarget === frameWidthBox || evt.relatedTarget === frameHeightBox) return;
    commitFrameBoxes();
  });
  // Enter commits by leaving the box rather than by committing directly, so
  // there is one path in and not two. It also puts the caret somewhere the
  // even-down can be written back under it.
  box.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') box.blur();
  });
}

/**
 * How far the preview frames are from the 16:9 they are meant to hold, and how
 * much room the section has spare. Only one of the two is ever above zero: the
 * frames either fit with room left over or are being squeezed out of shape.
 * Null when there is nothing to measure, which is an audio source, where the
 * frame deliberately has no ratio to keep.
 */
function previewFit() {
  if (previewSection.dataset.audio === 'true') return null;
  const stage = startFrameStage.getBoundingClientRect();
  if (!stage.width) return null;
  const controls = document.querySelector('.preview-cell__controls');
  if (!controls) return null;
  const ideal = Math.round((stage.width * 9) / 16);
  const pad = parseFloat(getComputedStyle(previewSection).paddingBottom) || 0;
  const mb = parseFloat(getComputedStyle(controls).marginBottom) || 0;
  return {
    short: Math.max(0, ideal - Math.round(stage.height)),
    spare: Math.max(0, Math.round(
      previewSection.getBoundingClientRect().bottom - pad
      - controls.getBoundingClientRect().bottom - mb)),
  };
}

// Several of these fire for one change: loading a link shows the quality frame,
// then fills it with buttons, then brings the header in. One request once it
// has settled rather than three on the way there.
let fitTimer = null;

function fitWindow() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    const fit = previewFit();
    if (!fit) return;
    window.lwclipper.fitWindow(fit.short - fit.spare);
  }, 140);
}

/**
 * Step 21c. One video track and one audio track, which is the floor the
 * timeline keeps. Measured on 2026-09-20 rather than read off the stylesheet:
 * an empty advanced project already shows one empty video row and one empty
 * audio row, and a loaded project carries those two as well as its own, so the
 * smallest real project is four rows of 48. The 96 that two rows would give is
 * the letter of it, and it would put a one-video one-audio project into a
 * scrollbar the moment the handle reached the floor.
 */
const SPLIT_STACK_FLOOR = 192;

/** The height the stack is held at, or null while the split is still the stylesheet's. */
let splitWish = null;
/** Whether the fit has been handed over yet. It is handed over once, and for the run. */
let splitTaken = false;
/** Where the stack was and where the pointer was when the drag started, or null. */
let splitFrom = null;

// ---- V2.1, 21c-2. Maximized is a second split, not the same one stretched ----
//
// Maximizing shares the extra height between the two in the proportion they
// already had, rather than putting the handle down the middle of the new space.
// That was put to the user when Step 17 was planned and the middle was rejected:
// a timeline of two tracks does not want half the screen.
//
// Which means the maximized split is kept as a **share of the room** while the
// restored-down one is kept as a height. That is not an inconsistency, it is
// what makes this work at all. Both the maximize and the unmaximize events fire
// after the window has already changed size, so the renderer may have laid out
// for the new size before it hears which state it is in. A height would have to
// know which room it was measured against and would be wrong for one of the two
// orders. A share is right against whichever room is current, so there is no
// order to get right.
let windowMaxed = false;
/** The share of the room the timeline holds when maximized. Null until the first one. */
let splitMaxShare = null;
/** The stack height last applied at the ordinary size. */
let splitNormalStack = 0;
/**
 * The last two rooms the window has had at the ordinary size, oldest first, each
 * with the moment it started. Two, because of what the first maximize has to
 * work out and cannot otherwise know.
 */
let splitRoomLog = [];

/** What the two frames have between them, which is the whole of what to divide. */
function splitRoom() {
  return timelineStack.getBoundingClientRect().height
    + previewSection.getBoundingClientRect().height;
}

/**
 * Remember what the split looks like at the ordinary window size, so the first
 * maximize has a proportion to carry up.
 *
 * The stack is passed in rather than measured, and that is not a shortcut: this
 * runs inside applySplit, before the property it just worked out has been laid
 * out, so a measurement here answers with the previous split. It read a drag one
 * step short every time, 317 where the stack was about to be 342.
 */
function noteNormalSplit(stack, room) {
  if (windowMaxed || room <= 0) return;
  splitNormalStack = stack;
  const newest = splitRoomLog[splitRoomLog.length - 1];
  if (newest && Math.abs(newest.room - room) <= 2) {
    // The same room it already had. Its age is when it started, not when it was
    // last looked at, which is the whole point of keeping the time.
    newest.room = room;
    return;
  }
  splitRoomLog.push({ room, at: Date.now() });
  if (splitRoomLog.length > 2) splitRoomLog.shift();
}

/**
 * The room the window had before it was maximized.
 *
 * Both window events fire after the window has already changed size, so by the
 * time the page hears which state it is in, it may have laid out for the new
 * room and recorded that as an ordinary one. The stack survives either order,
 * since a window resize is absorbed by the preview and leaves the timeline
 * where it is, so the only thing in doubt is the room, and it can be told apart
 * by its age: a resize that is part of a maximize arrives in the same breath as
 * the event announcing it, and one the user performed themselves is older.
 */
const SPLIT_SAME_BREATH = 400;

function roomBeforeMaxed() {
  const n = splitRoomLog.length;
  if (!n) return 0;
  const newest = splitRoomLog[n - 1];
  if (n > 1 && Date.now() - newest.at < SPLIT_SAME_BREATH) return splitRoomLog[n - 2].room;
  return newest.room;
}

/** The height the split is asking for, in whichever way this state keeps it. */
function splitWant(room) {
  if (windowMaxed) return splitMaxShare === null ? null : splitMaxShare * room;
  return splitWish;
}

/**
 * Maximized or restored down, as the main process reports it.
 *
 * The restored-down wish is never touched by any of this, which is the whole of
 * "the previous split comes back on restore": there is nothing to put back
 * because nothing took it away. And the maximized share outlives a restore, so
 * a second maximize opens on the split the first one was left at.
 */
function setWindowMaxed(maxed) {
  if (maxed === windowMaxed) return;
  const before = roomBeforeMaxed();
  windowMaxed = maxed;
  if (maxed && splitMaxShare === null && before > 0) {
    // The proportion the two had a moment ago, carried into a bigger room. Both
    // end up larger and neither ends up rearranged.
    splitMaxShare = splitNormalStack / before;
  }
  applySplit();
  drawTimeline();
  updatePlayhead();
}

window.lwclipper.onWindowState((state) => setWindowMaxed(!!(state && state.maximized)));
window.lwclipper.windowMaximized().then((maxed) => setWindowMaxed(!!maxed));

/**
 * The smallest the preview section may be made, measured off the section as it
 * stands rather than stored, because both answers move with the window's width
 * and one of them moves with whether the video head is up.
 *
 * For a picture it is the height at which the frames are exactly 16:9, which is
 * the height fitWindow spends the window's own size to reach, and previewFit()
 * already measures how far off it is in whichever direction there is one. For
 * an audio project there is no ratio to keep, so the floor is where the
 * spectrum reaches the minimum the stylesheet already gives it.
 *
 * Both sums under-report a section that is already crushed, because the stage
 * stops at its own minimum while the rest of the section carries on shrinking,
 * and the distance to 16:9 stops growing with it. Under is the safe direction:
 * a floor read too low gives the stack room it should not have had, and the
 * next call, with the section no longer crushed, reads the real one. Over would
 * be a floor that fought the drag it was measured during.
 */
function previewFloor() {
  const now = previewSection.getBoundingClientRect().height;
  const fit = previewFit();
  if (fit) return now - fit.spare + fit.short;
  const stage = previewStage.getBoundingClientRect().height;
  const least = parseFloat(getComputedStyle(previewStage).minHeight) || 0;
  return now - stage + least;
}

/**
 * Hold the stack at the height the handle was dragged to, inside what the
 * column can actually give it.
 *
 * Run on every window resize as well as on the drag, so a window made shorter
 * takes the room back from whichever of the two can spare it. What is clamped
 * is the applied height and never the wish, which is what hands the split back
 * whole when the window is made tall again, and what lets simple editing pass
 * through here with a stack of no height at all without losing anything.
 */
function applySplit() {
  // The preview is the only section in the column that grows, so every pixel
  // the stack takes comes out of it and the two of them together are a
  // constant. That sum is the whole of what there is to divide.
  const room = splitRoom();
  const want = splitWant(room);
  if (want === null) {
    document.documentElement.style.removeProperty('--split-stack');
    // Nothing is about to change, so the stack on the page is the stack.
    noteNormalSplit(timelineStack.getBoundingClientRect().height, room);
    return;
  }
  const held = layerGeometry.splitHeight(want, room, SPLIT_STACK_FLOOR, previewFloor());
  document.documentElement.style.setProperty('--split-stack', held + 'px');
  noteNormalSplit(held, room);
}

// ---- V2.1, 21c-3. The two handles between the three frames ----

/** The side column width the user dragged to, or null while it is the stylesheet's. */
let sideWish = null;
let sideFrom = null;
/** The floors for the gesture in hand, so the reflow happens once and not per move. */
let sideFloors = null;

/**
 * The narrowest each of the three columns may be made, asked of the browser
 * rather than written down.
 *
 * A frame will shrink to anything, so what stops fitting first is the row of
 * controls underneath it, and how wide that is depends on the language and on
 * which mode is up: measured at a 940px grid, the sides come to 130 in both
 * languages because the time field has a width of its own, while the middle is
 * 132 with nothing loaded, 186 in advanced editing and 270 of that in German.
 * A constant would have been right for one of those.
 *
 * Taken at the press and not during the drag, because it costs a reflow: the
 * only way to ask an element what its contents need is to lay it out that way
 * and look. The same shape of answer as previewFloor, one gesture, one reading.
 */
function previewColumnFloors() {
  const natural = (node) => {
    if (!node) return 0;
    const was = node.style.width;
    node.style.width = 'min-content';
    const w = Math.ceil(node.getBoundingClientRect().width);
    node.style.width = was;
    return w;
  };
  const mins = [...previewGrid.querySelectorAll('.preview-cell')].map((cell) => Math.max(
    natural(cell.querySelector('.preview-cell__controls')),
    natural(cell.querySelector('.preview-cell__title'))));
  return {
    side: Math.max(mins[0] || 0, mins[2] || 0),
    middle: mins[1] || 0,
  };
}

/** What the three columns divide between them: the grid, less its two gaps. */
function previewSpan() {
  const gap = parseFloat(getComputedStyle(previewGrid).columnGap) || 0;
  return previewGrid.getBoundingClientRect().width - 2 * gap;
}

/**
 * Hold the side columns at the width they were dragged to.
 *
 * Re-run on every window resize as well as on the drag, because the wish is a
 * width and the grid it sits in is not: a narrower window has to take the room
 * back from somewhere, and the clamp is what decides where.
 */
function applySideSplit() {
  if (sideWish === null) {
    document.documentElement.style.removeProperty('--preview-side');
    return;
  }
  const floors = sideFloors || previewColumnFloors();
  const fr = layerGeometry.sideFraction(sideWish, previewSpan(), floors.side, floors.middle);
  if (fr === null) {
    // Nothing left to divide. The stylesheet's own three equal columns are a
    // better answer than a fraction worked out from a grid this narrow.
    document.documentElement.style.removeProperty('--preview-side');
    return;
  }
  document.documentElement.style.setProperty('--preview-side', fr + 'fr');
}

function bindSideSplitter(handle, sign) {
  handle.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0) return;
    const cell = handle.closest('.preview-cell');
    sideFrom = { x: evt.clientX, width: cell.getBoundingClientRect().width };
    sideFloors = previewColumnFloors();
    handle.setPointerCapture(evt.pointerId);
    document.body.classList.add('splitting-side');
    evt.preventDefault();
  });

  handle.addEventListener('pointermove', (evt) => {
    if (!sideFrom) return;
    // The left handle widens its column by moving right and the right handle by
    // moving left, which is the sign. Both write the one value, so either of
    // them moves both edges and the picture in the middle stays centred.
    sideWish = sideFrom.width + sign * (evt.clientX - sideFrom.x);
    applySideSplit();
    // The frames are 16:9 of their own width, so a narrower column is a shorter
    // one, and the window would want to resize itself to suit. That is the
    // fight Step 17 said to settle before building any of this, and it is
    // settled the same way the handle above the timeline settles it.
    if (!splitTaken) {
      splitTaken = true;
      window.lwclipper.releaseWindowHeight();
    }
    // The preview's height moved, so the split below it has a different room to
    // divide, and the crop outline is placed from the picture's own width.
    applySplit();
    updateCropOverlays();
  });

  const done = (evt) => {
    if (!sideFrom) return;
    sideFrom = null;
    sideFloors = null;
    document.body.classList.remove('splitting-side');
    if (handle.hasPointerCapture(evt.pointerId)) handle.releasePointerCapture(evt.pointerId);
  };
  handle.addEventListener('pointerup', done);
  handle.addEventListener('pointercancel', done);
}

bindSideSplitter(sideSplitterLeft, 1);
bindSideSplitter(sideSplitterRight, -1);

editSplitter.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  splitFrom = { y: evt.clientY, stack: timelineStack.getBoundingClientRect().height };
  // So the drag survives the pointer leaving a 10px strip, which it does
  // immediately and for the whole of the gesture.
  editSplitter.setPointerCapture(evt.pointerId);
  document.body.classList.add('splitting');
  evt.preventDefault();
});

editSplitter.addEventListener('pointermove', (evt) => {
  if (!splitFrom) return;
  // Measured from where the stack was when the pointer went down rather than
  // from where it is now, so a pointer that runs past a floor and comes back
  // lands where it started instead of a drag's worth of travel away from it.
  const wish = splitFrom.stack + (evt.clientY - splitFrom.y);
  if (windowMaxed) {
    // Written into the maximized share, so a drag made up there does not follow
    // the window back down, and is still there on the next maximize.
    const room = splitRoom();
    if (room > 0) splitMaxShare = wish / room;
  } else {
    splitWish = wish;
  }
  applySplit();
  // The fit is given up for a drag that moved something, not for a press the
  // floors ate whole. At the default window size there is about fifteen pixels
  // of slack with two layers loaded, and nothing at all is a poor price for
  // the window giving up its own sizing for the rest of the session.
  const moved = Math.round(timelineStack.getBoundingClientRect().height)
    !== Math.round(splitFrom.stack);
  if (moved && !splitTaken) {
    splitTaken = true;
    window.lwclipper.releaseWindowHeight();
  }
  // The stack is what gained or lost the height, and whether it now scrolls is
  // what the ruler and the lane are inset by.
  drawTimeline();
  updatePlayhead();
});

function endSplit(evt) {
  if (!splitFrom) return;
  splitFrom = null;
  document.body.classList.remove('splitting');
  if (editSplitter.hasPointerCapture(evt.pointerId)) {
    editSplitter.releasePointerCapture(evt.pointerId);
  }
}

editSplitter.addEventListener('pointerup', endSplit);
editSplitter.addEventListener('pointercancel', endSplit);

function updateCropBtn() {
  // No picture in the output, nothing to crop out of it.
  cropBtn.hidden = outputIsAudio();
  cropBtn.disabled = busy || !canCrop();
  cropBtn.classList.toggle('btn--active', currentCrop() !== null);
  // In advanced editing one button stands for however many video layers there
  // are, so it says which one it will open on rather than leaving that to be
  // guessed from which row happens to look selected.
  const target = cropTargetLayer();
  cropBtn.title = target
    ? t('Crop {name}', { name: layerLabel(target.type, layerOrdinal(target)) })
    : '';
}

function sizeCropStage(size) {
  // The frame's own wrapper is only as wide as the popup's content, so the
  // share is taken from the panel rather than from the padding box around it.
  const frame = cropStage.parentElement;
  const panel = frame.parentElement;
  // The side arrows may hang into the popup's own padding, which is what lets
  // the frame keep its full share: at that share the frame leaves only about
  // 20px beside it, and an arrow plus its gap wants a little more than that.
  // The cap is only here so a freakishly narrow popup cannot push one out past
  // the edge and raise a scrollbar; in practice it never binds.
  const padding = parseFloat(getComputedStyle(panel).paddingLeft) || 0;
  const spare = Math.max(0, CROP_ARROW_SHORT + CROP_ARROW_GAP - padding + 2);
  const forArrows = frame.clientWidth - 2 * spare;
  // Always 16:9, whatever shape the picture is. A portrait clip used to make
  // the frame narrow and tall, which moved the arrows and the hint with it.
  let w = Math.min(Math.round(panel.clientWidth * CROP_FRAME_SHARE), forArrows);
  let h = Math.round(w * 9 / 16);
  const maxH = Math.round(window.innerHeight * CROP_HEIGHT_SHARE);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * 16 / 9);
  }
  cropStage.style.width = w + 'px';
  cropStage.style.height = h + 'px';

  // What the picture is drawn at with the zoom at 100%: fitted inside the
  // frame, which is where the bars come from. Where it sits and how much of the
  // frame it takes up is worked out per zoom in applyView, since zooming in
  // grows the picture and eats into those bars.
  fitCropScale(size);
  // Half the frame plus the gap, measured from the middle, which is where the
  // stage is centred. Written here because the stage's size is only known here.
  // The same gap on all four sides, so each arrow stands off its own edge by
  // the same amount whichever way round the frame is.
  const outX = `calc(50% + ${w / 2 + CROP_ARROW_GAP}px)`;
  const outY = `calc(50% + ${h / 2 + CROP_ARROW_GAP}px)`;
  cropArrowLeft.style.right = outX;
  cropArrowRight.style.left = outX;
  cropArrowUp.style.bottom = outY;
  cropArrowDown.style.top = outY;
  // Anchored to the same edge as the upper arrow and given its height, so the
  // two sit level however tall the arrows are, and lined up with the frame's
  // left edge rather than the popup's.
  cropPanHint.style.bottom = outY;
  cropPanHint.style.height = CROP_ARROW_SHORT + 'px';
  cropPanHint.style.left = `calc(50% - ${w / 2}px)`;
  applyView(size);
}

/**
 * The scale the stage shows 100% at. Fitted to everything that has to be on the
 * stage rather than to the picture, which since 21e are two different
 * rectangles whenever the frame has been dragged outside the picture.
 *
 * Split out of sizeCropStage because a drag changes what has to be shown while
 * the stage itself has not moved.
 */
function fitCropScale(size) {
  const outer = cropOuter(size);
  cropBaseScale = Math.min(
    cropStage.clientWidth / Math.max(2, outer.w),
    cropStage.clientHeight / Math.max(2, outer.h));
}

/**
 * The frame has just grown or shrunk past the picture, so what the stage shows
 * has changed and everything drawn at a scale has to be drawn again. Kept out
 * of applyView, which the zoom and the pan also call and which must not re-fit
 * the stage under them.
 */
function refitCropView(size) {
  // Done every time rather than only when the scale comes out different. The
  // scale is not the only thing that goes stale: the pan is clamped inside what
  // the stage holds, and a frame can change that box while leaving the scale
  // alone, which on a portrait picture is simply widening it. A drawImage of
  // one video frame is what a pan costs already.
  fitCropScale(size);
  applyView(size);
  paintCropFrame();
  updateCropArrows();
}

// How much of the picture the frame shows. The frame holds the whole of it at
// 100%, so at any zoom it holds exactly that much divided by the zoom.
//
// Taken from the picture rather than from the frame's own pixel size, which is
// a rounded integer: measuring it that way left the window a fraction short of
// the whole picture at 100%, which was enough, once rounded to an even number,
// to lose two pixels off Original and to leave half a pixel of slack in the pan
// for an arrow to light up on.
function viewSpan(size) {
  const outer = cropOuter(size);
  return {
    w: Math.min(outer.w, cropStage.clientWidth / cropScale),
    h: Math.min(outer.h, cropStage.clientHeight / cropScale),
  };
}

// Where the picture sits on the frame at the current zoom, and how much of it
// it takes up. At 100% it is the picture fitted inside the frame, which leaves
// the bars; zooming draws it larger, so the part that fits grows and the bars
// shrink until at enough zoom there are none and the frame is filled.
//
// Nothing here is rounded. The span above divides by the same scale this
// multiplies by, and the pair have to come back to exactly the picture's size
// at 100%, or the whole frame stops counting as the whole picture.
function placePicture(size) {
  const frameW = cropStage.clientWidth;
  const frameH = cropStage.clientHeight;
  // Taken from the span rather than worked out again, so the two cannot
  // disagree: this is exactly the visible part of the picture drawn at scale.
  const span = viewSpan(size);
  const w = span.w * cropScale;
  const h = span.h * cropScale;
  cropPicture = { left: (frameW - w) / 2, top: (frameH - h) / 2, w, h };
  // 21e. The canvas covers the part of the picture that is on the stage, which
  // is the whole of the visible region until the frame is dragged outside the
  // picture. What is left over around it is the stage's own background, which
  // is what the bars have always been.
  const view = viewWindow(size);
  const seen = pictureOnStage(size, view);
  cropCanvas.style.left = (cropPicture.left + (seen.x - view.x) * cropScale) + 'px';
  cropCanvas.style.top = (cropPicture.top + (seen.y - view.y) * cropScale) + 'px';
  cropCanvas.style.width = (seen.w * cropScale) + 'px';
  cropCanvas.style.height = (seen.h * cropScale) + 'px';
}

// Recomputes the scale the zoom implies and keeps the pan inside the picture,
// so no drag can ever pull empty space into the frame. At 100% the visible
// window is the whole picture, which pins the pan to the middle and leaves
// nothing to drag, which is why panning only exists above 100%.
function applyView(size) {
  cropScale = cropBaseScale * viewZoom;
  const span = viewSpan(size);
  // Held inside everything the stage shows rather than inside the picture. With
  // the frame dragged out past it, the room above and to the left of the
  // picture is somewhere the view is allowed to be. Identical while the two
  // rectangles are the same, which is every crop that stays inside.
  const outer = cropOuter(size);
  viewPanX = clamp(viewPanX, outer.x + span.w / 2, outer.x + outer.w - span.w / 2);
  viewPanY = clamp(viewPanY, outer.y + span.h / 2, outer.y + outer.h - span.h / 2);
  // After the clamp, not before it. The picture used to be placed from the span
  // alone, which the pan does not enter into, so the order did not matter and
  // the pan was settled afterwards. Since 21e it is placed from the view as
  // well, and placing it first drew it from a pan belonging to the frame the
  // stage held a moment ago: 11px of the picture missing after a preset.
  placePicture(size);
}

// The part of the source currently under the frame, in source pixels.
function viewWindow(size) {
  const span = viewSpan(size);
  return { x: viewPanX - span.w / 2, y: viewPanY - span.h / 2, w: span.w, h: span.h };
}

// Where the box sits on the frame right now. Zoom and pan both work by holding
// this fixed and letting the source rectangle underneath it change, which is
// what makes zooming tighten the crop rather than only magnify it.
function boxScreenRect(size) {
  const view = viewWindow(size);
  return {
    left: cropPicture.left + (cropDraft.x - view.x) * cropScale,
    top: cropPicture.top + (cropDraft.y - view.y) * cropScale,
    width: cropDraft.width * cropScale,
    height: cropDraft.height * cropScale,
  };
}

// The box's place on the frame, kept as fractions of it, and written only when
// something actually edits the box: a bar, a corner, a move, a preset, or the
// popup opening. Zoom and pan read it and never write it.
//
// That is load-bearing rather than tidiness. Deriving the source rectangle
// rounds it to an even number, and if the rounded rectangle were then used as
// the starting point for the next step of the slider, the loss would feed into
// itself: measured at 23.6px of a 707px box shrinking away between 100% and
// 400%, which looked exactly like zooming resizing the box.
// Sets the anchor from a rectangle on the frame directly. Anything that knows
// where it meant to put the box should use this rather than reading the box
// back afterwards: the reading has been rounded to an even number and held
// inside the frame, and folding that back into the anchor makes the loss
// permanent. A preset at 250% came back from 100% two pixels short that way.
function setCropAnchorFrom(onFrame) {
  const w = Math.max(1, cropPicture.w);
  const h = Math.max(1, cropPicture.h);
  cropAnchor = {
    left: (onFrame.left - cropPicture.left) / w,
    top: (onFrame.top - cropPicture.top) / h,
    width: onFrame.width / w,
    height: onFrame.height / h,
  };
}

function captureCropAnchor(size) {
  setCropAnchorFrom(boxScreenRect(size));
}

function anchorScreenRect() {
  return {
    left: cropPicture.left + cropAnchor.left * cropPicture.w,
    top: cropPicture.top + cropAnchor.top * cropPicture.h,
    width: cropAnchor.width * cropPicture.w,
    height: cropAnchor.height * cropPicture.h,
  };
}

// The reverse: what a rectangle on the frame covers in source pixels, held to
// the same even numbers and the same bounds a drag is held to.
//
// Nearest even rather than rounding down, because rounding down always errs the
// same way: it would shave the box by up to two source pixels every time the
// view changed, which is a visible bias at a zoom where a source pixel is worth
// more than one on screen. The nearest leaves an error of at most one either
// way, and it is quantisation rather than drift, since the box's place on the
// frame is held separately in cropAnchor and never rewritten from this.
// The parameter is deliberately not called `screen`: that is a global, so a use
// of it that loses its local silently reads the display instead of failing, and
// window.screen.left does not exist in Chromium, which turns the whole sum into
// a quiet NaN rather than an error.
function sourceRectFromScreen(onFrame, size) {
  const view = viewWindow(size);
  // Held to what is on the frame, the same bounds a drag is held to. The crop
  // has to land on an even number and the edge of the visible window does not,
  // so rounding to the nearest one could otherwise leave the box a pixel over
  // the edge of the picture: 1.3px of it showing past the frame at 400%.
  const edge = viewBounds(size);
  const evenNear = (v) => 2 * Math.round(v / 2);
  // Sized first against how much is on the frame, then placed inside it. The
  // other order shaves a pixel or two off the crop whenever the placing runs up
  // against the far edge, which showed as the size flickering during a pan.
  const width = clamp(evenNear(onFrame.width / cropScale),
    CROP_MIN, Math.max(CROP_MIN, edge.maxX - edge.minX));
  const height = clamp(evenNear(onFrame.height / cropScale),
    CROP_MIN, Math.max(CROP_MIN, edge.maxY - edge.minY));
  const x = clamp(evenNear(view.x + (onFrame.left - cropPicture.left) / cropScale),
    edge.minX, Math.max(edge.minX, edge.maxX - width));
  const y = clamp(evenNear(view.y + (onFrame.top - cropPicture.top) / cropScale),
    edge.minY, Math.max(edge.minY, edge.maxY - height));
  return { x, y, width, height };
}

// An arrow on each side the picture runs past, so it is clear there is more
// that way. At 100% the whole frame is visible and none of them show.
// Always on show: grey while there is nothing that way, green while there are
// pixels left to reach. A green one can be clicked to nudge the picture along
// by a couple of pixels, for the last bit of placement a drag is too coarse for.
const CROP_ARROWS = [
  ['up', () => cropArrowUp, 0, -1],
  ['down', () => cropArrowDown, 0, 1],
  ['left', () => cropArrowLeft, -1, 0],
  ['right', () => cropArrowRight, 1, 0],
];

const ARROW_NUDGE = 2;        // source pixels per click, and per tick while held
const ARROW_HOLD_DELAY = 250; // how long a press has to be held before it repeats
const ARROW_HOLD_EVERY = 25;  // how often it moves once it is repeating

function cropOverflow(size) {
  const v = viewWindow(size);
  // 21e. Against everything the stage has to hold rather than against the
  // picture: with the frame dragged out, the room around the picture is part of
  // what there is to pan to, and an arrow that ignored it would go grey while
  // there was still frame to reach.
  const outer = cropOuter(size);
  const slack = 0.5;   // a rounded pixel is not content worth pointing at
  return {
    up: v.y > outer.y + slack,
    left: v.x > outer.x + slack,
    down: v.y + v.h < outer.y + outer.h - slack,
    right: v.x + v.w < outer.x + outer.w - slack,
  };
}

function updateCropArrows() {
  const size = cropModal.hidden ? null : sourceSize();
  const over = size ? cropOverflow(size) : null;
  let any = false;
  for (const [key, arrowOf] of CROP_ARROWS) {
    const live = !!over && over[key];
    arrowOf().dataset.live = String(live);
    any = any || live;
  }
  // Nothing to click, nothing to say about clicking it.
  cropPanHint.hidden = !any;
}

// Moves the frame over the picture, keeping the box where it sits on the frame,
// which is the same thing a drag on the picture does.
function nudgeCropView(dx, dy) {
  const size = sourceSize();
  if (!size || !cropAnchor) return;
  viewPanX += dx;
  viewPanY += dy;
  applyView(size);
  cropDraft = sourceRectFromScreen(anchorScreenRect(), size);
  clearActivePreset();
  paintCropFrame();
  placeCropDraft();
  updateCropArrows();
}

// A grey one points at nothing, so it does nothing. Checked again on every tick
// of a held press, since the picture can run out mid-hold.
function arrowLive(key) {
  const size = cropModal.hidden ? null : sourceSize();
  return !!size && cropOverflow(size)[key];
}

for (const [key, arrowOf, dx, dy] of CROP_ARROWS) {
  const arrow = arrowOf();
  const nudge = () => nudgeCropView(dx * ARROW_NUDGE, dy * ARROW_NUDGE);
  let holdTimer = null;
  let repeatTimer = null;
  let repeated = false;

  // Listened for on the window rather than the arrow: releasing the button
  // somewhere else has to stop it too, and the arrow itself stops taking
  // pointer events the moment it goes grey, which a hold can cause.
  function stopHold() {
    clearTimeout(holdTimer);
    clearInterval(repeatTimer);
    holdTimer = null;
    repeatTimer = null;
    window.removeEventListener('pointerup', stopHold);
    window.removeEventListener('pointercancel', stopHold);
    window.removeEventListener('blur', stopHold);
  }

  arrow.addEventListener('pointerdown', (evt) => {
    if (!arrowLive(key)) return;
    evt.preventDefault();
    repeated = false;
    holdTimer = setTimeout(() => {
      repeated = true;
      // Once immediately, so the wait is the delay rather than the delay plus
      // an interval, then at the repeat rate for as long as it is held.
      if (!arrowLive(key)) return;
      nudge();
      repeatTimer = setInterval(() => {
        if (!arrowLive(key)) stopHold();
        else nudge();
      }, ARROW_HOLD_EVERY);
    }, ARROW_HOLD_DELAY);
    window.addEventListener('pointerup', stopHold);
    window.addEventListener('pointercancel', stopHold);
    window.addEventListener('blur', stopHold);
  });

  arrow.addEventListener('click', () => {
    // The click that ends a hold must not add a step on top of the ones the
    // hold already made. A press too short to repeat still gets its single one.
    if (repeated) {
      repeated = false;
      return;
    }
    if (arrowLive(key)) nudge();
  });
}

/**
 * Which element the popup copies its picture out of.
 *
 * Advanced editing has no single preview to take it from: the picture on screen
 * is a composite of every covering layer, and cropping one of them against all
 * of them would be cropping the wrong thing. So it reads that layer's own
 * decoder, which is already open on the file and already parked on a frame.
 */
function cropFrameSource() {
  const layer = cropTargetLayer();
  if (layer) {
    const entry = decoders.get(layer.id);
    return entry && entry.el.readyState >= 2 ? entry.el : null;
  }
  // HAVE_CURRENT_DATA is the point at which there is a frame to copy at all.
  // Below it the start frame is the next best thing: it preloads and is already
  // parked on the cut, where the preview may not have decoded anything yet.
  if (previewVideo.readyState >= 2) return previewVideo;
  return startFrameVideo.readyState >= 2 ? startFrameVideo : null;
}

/**
 * Give the layer being cropped a frame worth cropping against.
 *
 * Its decoder is parked on the playhead whenever the layer covers it, which is
 * the picture the user is looking at and the right one. When the playhead is
 * somewhere else the decoder is wherever it last landed, so it is sent to the
 * layer's own first frame instead. Nothing on screen moves: a layer the
 * playhead has left is not in the composite either way.
 */
function seedCropFrame(layer) {
  const entry = decoders.get(layer.id);
  if (!entry) return;
  if (layer.enabled && timelineModel.covers(layer, compositeAt)) return;
  const onSeeked = () => {
    entry.el.removeEventListener('seeked', onSeeked);
    if (!cropModal.hidden) paintCropFrame();
  };
  entry.el.addEventListener('seeked', onSeeked);
  entry.el.currentTime = layer.sourceIn;
}

// Whatever the preview is showing, painted once into the canvas. A canvas
// rather than a second <video>: it holds no file open, and it cannot drift off
// the position the preview is parked at while the popup is being used.
function paintCropFrame() {
  // The canvas covers the picture, not the whole frame, so the bars either side
  // of it are simply the frame showing through and nothing has to draw them.
  // Since 21e that is the part of the picture on the stage rather than the
  // whole of the visible region: the two part company once the frame is out.
  const size = sourceSize();
  if (!size) return;
  const view = viewWindow(size);
  const shown = pictureOnStage(size, view);
  const cssW = shown.w * cropScale;
  const cssH = shown.h * cropScale;
  if (!cssW || !cssH) return;
  const dpr = window.devicePixelRatio || 1;
  cropCanvas.width = Math.round(cssW * dpr);
  cropCanvas.height = Math.round(cssH * dpr);
  const ctx = cropCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#121214';
  ctx.fillRect(0, 0, cssW, cssH);
  const src = cropFrameSource();
  // Nothing is ever read back out of this canvas, only shown, so the file://
  // source tainting it costs nothing.
  if (!src) return;

  // Only the visible window is drawn, rather than the whole picture with the
  // rest hanging over the edges. The element's own intrinsic size is what
  // drawImage measures its source rectangle in, and it need not match the coded
  // size ffprobe reported, so the window is carried across as a fraction.
  const iw = src.videoWidth || size.w;
  const ih = src.videoHeight || size.h;
  ctx.drawImage(src,
    (shown.x / size.w) * iw, (shown.y / size.h) * ih,
    (shown.w / size.w) * iw, (shown.h / size.h) * ih,
    0, 0, cssW, cssH);
}

// ---- V2.1, 21a. The second tab ----
//
// The popup edits two rectangles now: which part of the source to take, which
// is what it has always done, and where that result is placed and scaled inside
// the output frame. Both belong to one layer and are settled by one Accept, so
// they are two tabs of one popup rather than two popups.
//
// Simple editing never sees them. There is no project frame there, the output
// is the source, and a position inside it would mean nothing.

let cropTab = 'frame';

// V2.1, 21a-2. The rectangle the position tab is editing, in project pixels.
// Always concrete while the popup is open, even for a layer that has never been
// placed: it starts as the centre and fit the geometry would have worked out
// anyway, so there is something to drag. What Accept writes is null again when
// it is still that rectangle, which is the same rule the crop tab applies to
// the whole frame. A position that is the default is not a position, and
// writing it down would freeze it against a crop or a project frame that
// changes later.
let placeDraft = null;
let placeDrag = null;
// Whether the user has moved or scaled it. An untouched draft follows the crop
// on the other tab; a touched one is theirs and is left alone.
let placeTouched = false;

const PLACE_SCALE_MIN = 10;
const PLACE_SCALE_MAX = 400;

const sameRect = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y
  && a.width === b.width && a.height === b.height;

/**
 * Where this layer lands with no position set.
 *
 * Against the crop being edited rather than the crop on the layer: the two tabs
 * are one popup settled by one Accept, so switching here after changing the
 * crop has to place what that crop is going to produce.
 */
function placeFitRect(layer) {
  const source = layerSource(layer);
  if (!source) return null;
  const placement = layerGeometry.placeLayer({
    source,
    crop: cropDraft,
    project: projectFrame(),
  });
  return placement ? { ...placement.dest } : null;
}

function showCropTab(which) {
  cropTab = which === 'place' ? 'place' : 'frame';
  const place = cropTab === 'place';
  cropTabFrame.classList.toggle('btn--active', !place);
  cropTabPlace.classList.toggle('btn--active', place);
  cropFramePanel.hidden = place;
  placePanel.hidden = !place;
  // The crop tab's own controls go with it. The zoom is a view into the source
  // and the presets are crop ratios: neither has anything to say about where
  // the result lands.
  cropHint.hidden = place;
  cropSize.hidden = place;
  cropZoomRow.hidden = place;
  cropPresets.hidden = place;
  placeHint.hidden = !place;
  placeSize.hidden = !place;
  placeScaleRow.hidden = !place;
  if (!place) return;
  const target = cropTargetLayer();
  // An untouched placement follows the crop. Cropping on the other tab changes
  // what centre and fit means, and a draft that ignored that would be placing a
  // rectangle the file is never going to produce.
  if (target && !placeTouched && !target.render) placeDraft = placeFitRect(target);
  showPlaceScale();
  drawPlaceStage();
}

/** The draft's size as a percentage of the fit, which is what 100% means. */
function showPlaceScale() {
  const fit = placeFitRect(cropTargetLayer());
  const percent = (fit && placeDraft && fit.width)
    ? clamp(Math.round((placeDraft.width / fit.width) * 100), PLACE_SCALE_MIN, PLACE_SCALE_MAX)
    : 100;
  placeScaleSlider.value = String(percent);
  placeScaleValue.textContent = percent + '%';
}

function setPlaceScale(percent) {
  const fit = placeFitRect(cropTargetLayer());
  if (!fit || !placeDraft) return;
  const p = clamp(Math.round(percent), PLACE_SCALE_MIN, PLACE_SCALE_MAX);
  // Around its own centre, so scaling changes how big the picture is and not
  // where it is. Growing from the top left corner would walk it across the
  // frame and make the slider unusable for anything but a full-frame layer.
  const cx = placeDraft.x + placeDraft.width / 2;
  const cy = placeDraft.y + placeDraft.height / 2;
  const width = Math.max(2, Math.round(fit.width * p / 100));
  const height = Math.max(2, Math.round(fit.height * p / 100));
  placeDraft = {
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
    width,
    height,
  };
  placeTouched = true;
  placeScaleSlider.value = String(p);
  placeScaleValue.textContent = p + '%';
  drawPlaceStage();
}

placeScaleSlider.addEventListener('input', () => setPlaceScale(Number(placeScaleSlider.value)));

/** Where a point on the stage is in project pixels. */
function placePointAt(evt) {
  const rect = placeStage.getBoundingClientRect();
  const frame = projectFrame();
  return {
    x: (evt.clientX - rect.left) * frame.width / rect.width,
    y: (evt.clientY - rect.top) * frame.height / rect.height,
  };
}

const onPicture = (p) => !!placeDraft && p.x >= placeDraft.x && p.y >= placeDraft.y
  && p.x <= placeDraft.x + placeDraft.width && p.y <= placeDraft.y + placeDraft.height;

// Anywhere on the picture, because the box is moved whole and there is nothing
// on it to grab. Outside it nothing happens, so a click on the grey beside a
// small picture does not teleport it to the pointer.
placeStage.addEventListener('pointerdown', (evt) => {
  if (cropTab !== 'place' || !placeDraft) return;
  const p = placePointAt(evt);
  if (!onPicture(p)) return;
  placeDrag = { dx: p.x - placeDraft.x, dy: p.y - placeDraft.y };
  placeStage.setPointerCapture(evt.pointerId);
  evt.preventDefault();
});

placeStage.addEventListener('pointermove', (evt) => {
  if (cropTab !== 'place') return;
  const p = placePointAt(evt);
  if (!placeDrag) {
    placeStage.style.cursor = onPicture(p) ? 'move' : 'default';
    return;
  }
  placeDraft = {
    ...placeDraft,
    x: Math.round(p.x - placeDrag.dx),
    y: Math.round(p.y - placeDrag.dy),
  };
  placeTouched = true;
  drawPlaceStage();
});

function endPlaceDrag(evt) {
  if (!placeDrag) return;
  placeDrag = null;
  if (placeStage.hasPointerCapture(evt.pointerId)) {
    placeStage.releasePointerCapture(evt.pointerId);
  }
}
placeStage.addEventListener('pointerup', endPlaceDrag);
placeStage.addEventListener('pointercancel', endPlaceDrag);

/**
 * The output frame, sized the way the crop frame is sized.
 *
 * At the project's own aspect rather than at 16:9. The crop frame is always
 * 16:9 so that the arrows around it and the hint above it never move; this one
 * has no arrows and is a picture of the file, so a portrait project has to look
 * portrait.
 */
function sizePlaceStage() {
  const frame = projectFrame();
  const panel = placePanel.parentElement;
  let w = Math.round(panel.clientWidth * CROP_FRAME_SHARE);
  let h = Math.round(w * frame.height / frame.width);
  const maxH = Math.round(window.innerHeight * CROP_HEIGHT_SHARE);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * frame.width / frame.height);
  }
  placeStage.style.width = w + 'px';
  placeStage.style.height = h + 'px';
  return { w, h };
}

function drawPlaceStage() {
  const { w, h } = sizePlaceStage();
  const dpr = window.devicePixelRatio || 1;
  placeCanvas.width = Math.round(w * dpr);
  placeCanvas.height = Math.round(h * dpr);
  const ctx = placeCanvas.getContext('2d');
  // No transform: drawImageArgs maps the project frame onto whatever size the
  // canvas is, which is what the preview canvas does with its own too.
  const target = cropTargetLayer();
  // Everything except the layer being placed, which is drawn afterwards from
  // the two drafts. It is drawn whether or not the playhead covers it: a layer
  // the playhead has left is not in the composite, and placing a picture that
  // is not on screen is placing it blind. Its decoder was parked on that
  // layer's own first frame when the popup opened.
  paintLayers(ctx, placeCanvas, compositeAt, null, target ? target.id : null);
  if (target) drawLayerInto(ctx, placeCanvas, target, cropDraft, placeDraft);
  drawPlaceBox(w, h);
}

/** Where the layer being placed lands, and the numbers under the stage. */
function drawPlaceBox(w, h) {
  const target = cropTargetLayer();
  const frame = projectFrame();
  const d = placeDraft;
  placeBox.hidden = !d;
  if (!d) {
    placeSize.textContent = '';
    return;
  }
  const kx = w / frame.width;
  const ky = h / frame.height;
  placeBox.style.left = Math.round(d.x * kx) + 'px';
  placeBox.style.top = Math.round(d.y * ky) + 'px';
  placeBox.style.width = Math.round(d.width * kx) + 'px';
  placeBox.style.height = Math.round(d.height * ky) + 'px';
  // Said rather than left to be worked out: a draft that is still the fit is
  // what Accept will store as no position at all.
  //
  // Two calls rather than one with a ternary in it, for the reason spelled out
  // over setProjectError: the checker sees a literal after t( and nothing else.
  if (sameRect(d, placeFitRect(target))) {
    placeSize.textContent = t('Centred and fitted, {w} x {h}',
      { w: d.width, h: d.height });
  } else {
    placeSize.textContent = t('{w} x {h} at {x}, {y}',
      { w: d.width, h: d.height, x: d.x, y: d.y });
  }
}

cropTabFrame.addEventListener('click', () => showCropTab('frame'));
cropTabPlace.addEventListener('click', () => showCropTab('place'));

// The popup is sized against the window, so resizing it while the popup is open
// has to redo the lot: the frame, the snapshot in it, and the box on top.
function resizeCropStage() {
  if (cropModal.hidden || !cropDraft) return;
  if (cropTab === 'place') {
    drawPlaceStage();
    return;
  }
  const size = sourceSize();
  if (!size) return;
  sizeCropStage(size);
  paintCropFrame();
  placeCropDraft();
  // The frame changed size, not the crop, so the anchor is restated against the
  // new one rather than the crop being re-derived from the old fractions.
  captureCropAnchor(size);
  updateCropArrows();
}

function markActivePreset() {
  for (const btn of cropPresets.children) {
    btn.classList.toggle('btn--active', btn === cropActivePreset);
  }
}

function updateCropNote() {
  // Advanced editing composites, which is an encode however it is asked for:
  // there is no stream copy here for a crop to be ruling out, so there is
  // nothing to warn about.
  if (timelineDriving()) {
    cropEncodeNote.hidden = true;
    return;
  }
  const size = sourceSize();
  cropEncodeNote.hidden = accurateToggle.checked || !size || isFullFrame(cropDraft, size);
}

function placeCropDraft() {
  const size = sourceSize();
  if (!size) return;
  const screen = boxScreenRect(size);
  cropBox.style.left = screen.left + 'px';
  cropBox.style.top = screen.top + 'px';
  cropBox.style.width = screen.width + 'px';
  cropBox.style.height = screen.height + 'px';
  cropSize.textContent = cropDraft.width + ' x ' + cropDraft.height;
  // A box with room to move inside the frame says so; one filling it hands the
  // cursor over to the stage, which is what pans the picture underneath.
  const room = (cropPicture.w - screen.width) > 1 || (cropPicture.h - screen.height) > 1;
  cropBox.style.cursor = room ? 'move' : '';
  cropStage.dataset.pannable = String(viewZoom > 1);
  updateCropNote();
}

function setCropHint(mirrored, diagonal = false, locked = false) {
  if (locked) {
    cropHint.textContent = t('Locked: the frame keeps the shape selected below');
  } else if (mirrored && diagonal) {
    cropHint.textContent = t('Mirrored and diagonal: all four borders, 1 px each');
  } else if (mirrored) {
    cropHint.textContent = t('Mirrored: both bars moving together, 1 px each');
  } else if (diagonal) {
    cropHint.textContent = t('Diagonal: both borders of the corner, 2 px each');
  } else {
    cropHint.textContent = t(CROP_HINT_IDLE);
  }
}

/**
 * Where a pair of opposite edges ends up after a bar is dragged. Kept pure and
 * out of the handler so the arithmetic can be checked on its own: the two axes
 * and all four bars come through here, which is what stops the clamping to the
 * frame from being written four slightly different ways.
 *
 * lo/hi are the near and far edge in source pixels, floor and limit how far
 * either may travel on that axis, movesLo which of the two the bar being
 * dragged is, rawDelta the pointer's travel converted to source pixels, and
 * travelPx that same travel in screen pixels, which is what holds the mirrored
 * pair to its one pixel step.
 *
 * floor and limit are what is on the frame, not what is in the picture: zoomed
 * in, a bar dragged past the edge of the frame would take the box somewhere it
 * cannot be seen or grabbed. At 100% the two are the same thing.
 */
function resizeEdge(lo0, hi0, limit, movesLo, mirrored, rawDelta, travelPx = Infinity, floor = 0) {
  if (mirrored) {
    // Both bars move by the same amount in opposite directions, so the centre
    // holds and the dimension between them changes by two per step: still even.
    // Outward they stop at the frame, inward at CROP_MIN apart.
    //
    // The rate is capped at a source pixel per pixel of travel. Without that
    // cap the step is whatever a screen pixel happens to be worth, and the
    // frame is usually shown small enough that this is two or three source
    // pixels: on a 1280 wide clip one screen pixel is 1.81 source pixels, so
    // the pair could only ever jump four at a time, never the two it is for.
    // Zoomed in, where a screen pixel is worth less than a source one, the
    // ordinary rate is already the slower of the two and still applies.
    const rate = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), Math.abs(travelPx));
    const outward = Math.max(0, Math.min(lo0 - floor, limit - hi0));
    const inward = Math.max(0, Math.floor((hi0 - lo0 - CROP_MIN) / 2));
    const d = clamp(Math.round(rate / CROP_MIRROR_STEP) * CROP_MIRROR_STEP,
      movesLo ? -outward : -inward, movesLo ? inward : outward);
    return movesLo ? { lo: lo0 + d, hi: hi0 - d } : { lo: lo0 - d, hi: hi0 + d };
  }
  const d = Math.round(rawDelta / CROP_STEP) * CROP_STEP;
  if (movesLo) return { lo: clamp(lo0 + d, floor, hi0 - CROP_MIN), hi: hi0 };
  return { lo: lo0, hi: clamp(hi0 + d, lo0 + CROP_MIN, limit) };
}

// The bounds a bar may travel between: what is on the frame, rounded inward to
// an even number so the box can still land on one. The half pixel of slack
// stops a rounding error at 100%, where the window is the whole picture, from
// quietly shaving two pixels off the far edge.
function viewBounds(size) {
  // 21e. The picture's own edges until extending is allowed, and a fixed
  // allowance around it once it is. Never cropOuter, which grows with the frame
  // and would therefore be no limit on it at all.
  const lim = cropLimit(size);
  // And at 100% the allowance is the whole of it, with no window to intersect.
  // The window there is everything the stage holds, which is the frame itself
  // once the frame is the larger of the two, so intersecting would hold the
  // frame to its own size: the bar could not be dragged out by a single pixel,
  // which is exactly what the first run of the probe measured.
  //
  // The reason for the intersection below is a zoom reason. It stays for one.
  if (cropExtendable() && viewZoom <= 1) {
    return { minX: lim.x, maxX: lim.x + lim.w, minY: lim.y, maxY: lim.y + lim.h };
  }
  const v = viewWindow(size);
  return {
    minX: Math.max(lim.x, 2 * Math.ceil((v.x - 0.5) / 2)),
    maxX: Math.min(lim.x + lim.w, 2 * Math.floor((v.x + v.w + 0.5) / 2)),
    minY: Math.max(lim.y, 2 * Math.ceil((v.y - 0.5) / 2)),
    maxY: Math.min(lim.y + lim.h, 2 * Math.floor((v.y + v.h + 0.5) / 2)),
  };
}

// Pointer capture and the three listeners every drag in this popup needs, so
// the bars, the corners and the box itself differ only in what they do with the
// movement rather than in how they follow the pointer.
function beginDrag(el, evt, onMove, onDone) {
  el.setPointerCapture(evt.pointerId);
  evt.preventDefault();
  const move = (ev) => onMove(ev);
  const up = (ev) => {
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    if (onDone) onDone();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

// Shared by the bars and the corners: a drag is no longer whatever preset last
// set the box, and the hint follows whether Shift is down. A drag is a real
// edit of the box, so this is one of the places the anchor is rewritten.
function applyDraft(shifted, diagonal = false, locked = false) {
  const size = sourceSize();
  setCropHint(shifted, diagonal, locked);
  clearActivePreset();
  // 21e. The frame may have just crossed the edge of the picture, which changes
  // what the stage has to hold and so what everything on it is drawn at. Before
  // the box is placed and before the anchor is taken, both of which are read
  // against the scale this settles.
  if (size) refitCropView(size);
  placeCropDraft();
  if (size) captureCropAnchor(size);
}

// One bar at a time, or with Shift the bar opposite it as well. Both work on
// the pair of edges the bar belongs to, lo and hi, which is what keeps the
// clamping to the frame in one place instead of four.
function bindGrip(grip) {
  const edge = grip.dataset.edge;
  const vertical = edge === 'top' || edge === 'bottom';
  const movesLo = edge === 'left' || edge === 'top';

  grip.addEventListener('pointerdown', (evt) => {
    const size = sourceSize();
    if (!size || !cropDraft) return;
    const bounds = viewBounds(size);
    const floor = vertical ? bounds.minY : bounds.minX;
    const limit = vertical ? bounds.maxY : bounds.maxX;
    const lo0 = vertical ? cropDraft.y : cropDraft.x;
    const hi0 = lo0 + (vertical ? cropDraft.height : cropDraft.width);
    const anchor = vertical ? evt.clientY : evt.clientX;
    // 21e. The scale the gesture started at, not the live one. Dragging the
    // frame out past the picture re-fits the stage under it, and reading the
    // scale back each time would make the travel worth more source pixels the
    // further it went: a drag that fed on itself rather than following the
    // pointer. The box's place on the stage moves less and less instead, which
    // is the picture shrinking inside a growing frame.
    const scale0 = cropScale;
    setCropHint(evt.shiftKey);
    // Stops the pointerdown from also starting a move of the whole box.
    evt.stopPropagation();

    // 21e-3. The shape to hold if the two modifiers are down, taken now for
    // the reason cropLockRatio gives.
    const locked = { ...cropDraft };
    const ratio0 = cropLockRatio();

    beginDrag(grip, evt, (ev) => {
      const travel = (vertical ? ev.clientY : ev.clientX) - anchor;
      if (ev.shiftKey && ev.ctrlKey && ratio0) {
        // The edge opposite this bar stays put, and the other axis grows about
        // its own middle so that changing the shape does not slide the box up
        // or down the frame. A bar on the vertical drives the height, so what
        // is asked for is converted through the ratio: one number drives both,
        // which is what stops the two sides from disagreeing.
        const grown = (vertical ? locked.height : locked.width)
          + (movesLo ? -1 : 1) * (travel / scale0);
        const rect = layerGeometry.ratioResize(locked, ratio0,
          vertical
            ? { x: 'mid', y: movesLo ? 'hi' : 'lo' }
            : { x: movesLo ? 'hi' : 'lo', y: 'mid' },
          vertical ? grown * ratio0 : grown, bounds, CROP_MIN);
        if (rect) {
          cropDraft.x = rect.x;
          cropDraft.y = rect.y;
          cropDraft.width = rect.width;
          cropDraft.height = rect.height;
          applyDraft(false, false, true);
          return;
        }
      }
      const { lo, hi } = resizeEdge(lo0, hi0, limit, movesLo, ev.shiftKey,
        travel / scale0, travel, floor);
      if (vertical) {
        cropDraft.y = lo;
        cropDraft.height = hi - lo;
      } else {
        cropDraft.x = lo;
        cropDraft.width = hi - lo;
      }
      applyDraft(ev.shiftKey);
    }, () => setCropHint(false));
  });
}

// A corner is simply both of its bars at once, one per axis, which is why it
// needs no arithmetic of its own. Shift therefore mirrors on both axes at once,
// and the corner diagonally opposite is the one that follows. Ctrl ties the two
// axes together so the corner runs along the box's own diagonal, and the two
// chain: Ctrl and Shift together move all four borders, a pixel at a time.
function bindCorner(dot) {
  const key = dot.dataset.corner;
  const movesLeft = key === 'tl' || key === 'bl';
  const movesTop = key === 'tl' || key === 'tr';

  dot.addEventListener('pointerdown', (evt) => {
    const size = sourceSize();
    if (!size || !cropDraft) return;
    const start = { ...cropDraft };
    const bounds = viewBounds(size);
    const anchorX = evt.clientX;
    const anchorY = evt.clientY;
    // The scale the gesture started at, for the reason given on the bars.
    const scale0 = cropScale;
    setCropHint(evt.shiftKey, evt.ctrlKey);
    evt.stopPropagation();

    const ratio0 = cropLockRatio();

    beginDrag(dot, evt, (ev) => {
      let travelX = ev.clientX - anchorX;
      let travelY = ev.clientY - anchorY;
      if (ev.shiftKey && ev.ctrlKey && ratio0) {
        // The corner opposite this one stays put and the box grows away from
        // it. Whichever way the pointer has travelled further is the axis that
        // drives, so the drag answers to both directions rather than going
        // dead in one of them, and the other side follows through the ratio.
        const outX = (movesLeft ? -travelX : travelX) / scale0;
        const outY = (movesTop ? -travelY : travelY) / scale0;
        const want = Math.abs(travelY) > Math.abs(travelX)
          ? (start.height + outY) * ratio0
          : start.width + outX;
        const rect = layerGeometry.ratioResize(start, ratio0,
          { x: movesLeft ? 'hi' : 'lo', y: movesTop ? 'hi' : 'lo' },
          want, bounds, CROP_MIN);
        if (rect) {
          cropDraft.x = rect.x;
          cropDraft.y = rect.y;
          cropDraft.width = rect.width;
          cropDraft.height = rect.height;
          applyDraft(false, false, true);
          return;
        }
      }
      if (ev.ctrlKey) {
        // Averaged along the diagonal rather than taken per axis, so whatever
        // the pointer does the two borders move by the same amount. Which way
        // each axis has to go to close the box in depends on which corner this
        // is, which is what the two flips are for.
        const closeX = movesLeft ? travelX : -travelX;
        const closeY = movesTop ? travelY : -travelY;
        const along = (closeX + closeY) / 2;
        travelX = movesLeft ? along : -along;
        travelY = movesTop ? along : -along;
      }
      const across = resizeEdge(start.x, start.x + start.width, bounds.maxX, movesLeft,
        ev.shiftKey, travelX / scale0, travelX, bounds.minX);
      const down = resizeEdge(start.y, start.y + start.height, bounds.maxY, movesTop,
        ev.shiftKey, travelY / scale0, travelY, bounds.minY);
      cropDraft.x = across.lo;
      cropDraft.width = across.hi - across.lo;
      cropDraft.y = down.lo;
      cropDraft.height = down.hi - down.lo;
      applyDraft(ev.shiftKey, ev.ctrlKey);
    }, () => setCropHint(false));
  });
}

for (const grip of cropBox.querySelectorAll('.crop-grip')) bindGrip(grip);
for (const dot of cropBox.querySelectorAll('.crop-corner')) bindCorner(dot);

// Dragging the middle slides the whole box, which is the only way to choose
// which part of the frame a smaller box keeps.
cropBox.addEventListener('pointerdown', (evt) => {
  const size = sourceSize();
  if (!size || !cropDraft || !cropAnchor) return;
  // Measured against the picture rather than the frame: the bars beside a clip
  // that is not 16:9 are not somewhere the box may be moved to.
  const room = cropPicture;
  const screen0 = anchorScreenRect();
  // A box filling the picture has nowhere to go inside it, so that press is
  // left alone and carries on up to the stage, which pans instead. Any smaller
  // box moves, at whatever zoom.
  if (room.w - screen0.width <= 1 && room.h - screen0.height <= 1) return;
  evt.stopPropagation();
  const anchorX = evt.clientX;
  const anchorY = evt.clientY;

  beginDrag(cropBox, evt, (ev) => {
    // Snapped in source pixels, so the box lands on even numbers however far
    // the frame is zoomed, then held inside the frame: past its edge the box
    // would be neither visible nor grabbable, and panning is what reaches the
    // rest of the picture.
    const step = CROP_STEP * cropScale;
    const dx = Math.round((ev.clientX - anchorX) / step) * step;
    const dy = Math.round((ev.clientY - anchorY) / step) * step;
    const rect = {
      left: clamp(screen0.left + dx, room.left, room.left + room.w - screen0.width),
      top: clamp(screen0.top + dy, room.top, room.top + room.h - screen0.height),
      width: screen0.width,
      height: screen0.height,
    };
    cropDraft = sourceRectFromScreen(rect, size);
    // From the rectangle being dragged rather than back from the rounded crop,
    // so a long drag cannot shrink the box a pixel at a time.
    setCropAnchorFrom(rect);
    placeCropDraft();
    // 21e. Not refitted here. A move cannot grow what the stage has to show,
    // since it is held inside that already, but it can leave less of it in use,
    // and re-fitting for that mid-gesture would slide the box out from under
    // the pointer for nothing. Settled on release instead.
  }, () => {
    refitCropView(size);
    placeCropDraft();
  });
});

// Zoom holds the box where it sits on the frame and lets the source rectangle
// underneath it shrink, which is what tightens the crop. The pan moves with it
// so the box keeps looking at the same part of the picture rather than drifting
// toward the middle of the frame.
function setCropZoom(percent) {
  const size = sourceSize();
  if (!size || !cropAnchor) return;
  const before = anchorScreenRect();
  // The point of the picture sitting under the middle of the box, read off the
  // view rather than off the box, so no rounding of the box can reach the pan.
  const view = viewWindow(size);
  const holdX = view.x + (before.left + before.width / 2 - cropPicture.left) / cropScale;
  const holdY = view.y + (before.top + before.height / 2 - cropPicture.top) / cropScale;

  viewZoom = clamp(percent / 100, CROP_ZOOM_MIN, CROP_ZOOM_MAX);
  cropScale = cropBaseScale * viewZoom;
  // The picture is placed again before the box is asked where it now sits: on a
  // clip that is not 16:9 the picture grows into the bars as it zooms, and the
  // box, being anchored to the picture rather than to the frame, grows with it.
  placePicture(size);
  const after = anchorScreenRect();
  // Keep that same point under the box instead of letting the crop drift toward
  // the middle of the frame as it tightens.
  viewPanX = holdX + (cropPicture.left + cropPicture.w / 2 - (after.left + after.width / 2)) / cropScale;
  viewPanY = holdY + (cropPicture.top + cropPicture.h / 2 - (after.top + after.height / 2)) / cropScale;
  applyView(size);

  cropDraft = sourceRectFromScreen(anchorScreenRect(), size);
  // The slider is set here rather than only by whoever moved it, so the wheel
  // and the slider cannot drift apart about what the zoom currently is.
  cropZoomSlider.value = String(Math.round(viewZoom * 100));
  cropZoomValue.textContent = Math.round(viewZoom * 100) + '%';
  clearActivePreset();
  paintCropFrame();
  placeCropDraft();
  updateCropArrows();
}

cropZoomSlider.addEventListener('input', () => setCropZoom(Number(cropZoomSlider.value)));

// A wheel notch reports about 100 pixels of travel, so a twentieth of a point
// per pixel makes one notch a 5% step. The slider is finer than that, a point
// at a time, for placing an exact figure; the wheel is for getting there. A
// trackpad sends much smaller amounts far more often, which is why the
// leftovers are carried rather than rounded away: without that a slow scroll
// would round to nothing every time and never zoom at all.
const CROP_WHEEL_STEP = 5;
const CROP_WHEEL_RATE = 0.05;
let zoomWheelResidue = 0;

// Electron reports pixels, but a wheel is allowed to report lines or pages
// instead. The multipliers are chosen so a notch is worth about the same
// whichever unit it arrives in: at a line height of 16 a three line notch came
// to 4.8 points, just short of a step, so the first notch did nothing at all.
function wheelPixels(evt) {
  if (evt.deltaMode === 1) return evt.deltaY * 40;    // lines
  if (evt.deltaMode === 2) return evt.deltaY * 400;   // pages
  return evt.deltaY;
}

cropStage.addEventListener('wheel', (evt) => {
  if (cropModal.hidden || !cropAnchor) return;
  // Without this the popup scrolls behind the frame instead, which is also why
  // the listener cannot be a passive one.
  evt.preventDefault();
  const step = CROP_WHEEL_STEP;
  zoomWheelResidue += -wheelPixels(evt) * CROP_WHEEL_RATE;
  const steps = Math.trunc(zoomWheelResidue / step);
  if (!steps) return;
  zoomWheelResidue -= steps * step;
  const now = Math.round(viewZoom * 100);
  const next = clamp(now + steps * step, CROP_ZOOM_MIN * 100, CROP_ZOOM_MAX * 100);
  // Already as far as it goes that way: drop the leftovers rather than banking
  // them, or scrolling back would do nothing until the debt was paid off.
  if (next === now) {
    zoomWheelResidue = 0;
    return;
  }
  setCropZoom(next);
}, { passive: false });

// Above 100% a drag on the picture pans it, which is how a new centre is
// chosen once part of it is out of frame. The box is anchored to the frame, so
// its source rectangle follows the pan rather than travelling with the picture.
cropStage.addEventListener('pointerdown', (evt) => {
  const size = sourceSize();
  if (!size || !cropAnchor || viewZoom <= 1) return;
  const screen = anchorScreenRect();
  const anchorX = evt.clientX;
  const anchorY = evt.clientY;
  const panX0 = viewPanX;
  const panY0 = viewPanY;
  cropStage.dataset.panning = 'true';

  beginDrag(cropStage, evt, (ev) => {
    viewPanX = panX0 - (ev.clientX - anchorX) / cropScale;
    viewPanY = panY0 - (ev.clientY - anchorY) / cropScale;
    applyView(size);
    cropDraft = sourceRectFromScreen(screen, size);
    clearActivePreset();
    paintCropFrame();
    placeCropDraft();
    updateCropArrows();
  }, () => { cropStage.dataset.panning = 'false'; });
});

for (const preset of CROP_PRESETS) {
  const btn = document.createElement('button');
  btn.textContent = preset.label;
  btn.addEventListener('click', () => {
    const size = sourceSize();
    if (!size) return;
    // Fitted to what is on the frame, not to the whole picture: at a zoom the
    // largest 16:9 in the source would be far bigger than the frame can show,
    // and its edges would sit somewhere off in the part that is out of view.
    //
    // 21e. And to the part of the frame the picture is on, not to the room
    // around it. That is the whole of "clicking any AR button restores the
    // original frame size": a preset is never measured against an extension, so
    // every one of them, Original included, is the way back inside the picture.
    //
    // Which means the stage is about to be holding the picture and nothing more,
    // whatever it was holding a moment ago. Settled first, because every number
    // below is measured at the scale and the pan this sets, and a preset worked
    // out against a stage still zoomed out for an extension lands beside itself:
    // measured at 22px, on an Original that should have been the whole picture.
    cropDraft = fullRect(size);
    refitCropView(size);
    const view = viewWindow(size);
    const seen = pictureOnStage(size, view);
    const window_ = { w: evenDown(seen.w), h: evenDown(seen.h) };
    const rect = preset.ratio === null ? fullRect(window_) : ratioRect(window_, preset.ratio);
    // Offset onto the picture, since what comes back is measured from the
    // corner of the visible window and sourceRectFromScreen wants a place on
    // the frame. Without this a preset on a clip that is not 16:9 lands a
    // bar's width off, which a 16:9 clip never shows because its bars are zero.
    const onFrame = {
      left: cropPicture.left + (seen.x - view.x + rect.x) * cropScale,
      top: cropPicture.top + (seen.y - view.y + rect.y) * cropScale,
      width: rect.width * cropScale,
      height: rect.height * cropScale,
    };
    cropDraft = sourceRectFromScreen(onFrame, size);
    // From what the preset asked for, not from what came back rounded.
    setCropAnchorFrom(onFrame);
    cropActivePreset = btn;
    cropActiveRatio = preset.ratio;
    markActivePreset();
    placeCropDraft();
  });
  cropPresets.appendChild(btn);
}

function openCrop(layerId, tab) {
  if (busy) return;
  if (timelineDriving()) {
    // Opened on a named row, or on whichever one is selected. Fixed here for
    // the life of the popup, which is what cropTargetLayer then reads.
    const target = (layerId && timelineModel.layerById(layers, layerId)) || cropTargetLayer();
    if (!target || target.type !== 'video') return;
    cropLayerId = target.id;
  } else {
    cropLayerId = null;
  }
  const size = sourceSize();
  if (!size) {
    cropLayerId = null;
    return;
  }
  const accepted = currentCrop();
  // A rectangle left over from a frame of a different size would be nonsense,
  // so anything that does not fit the current one starts over.
  const kept = accepted
    && accepted.x + accepted.width <= size.w
    && accepted.y + accepted.height <= size.h;
  cropDraft = kept ? { ...accepted } : fullRect(size);
  clearActivePreset();
  // Back to the zoom and pan the crop was accepted at, so it opens on the view
  // it closed on rather than snapping out to the whole picture. The box is
  // carried in source pixels and drawn through that view, so it comes back the
  // size it was rather than the size it would be at 100%. With no crop to
  // return to there is nothing to restore, and it opens on the whole picture.
  const view = kept ? currentCropView() : null;
  viewZoom = view ? clamp(view.zoom, CROP_ZOOM_MIN, CROP_ZOOM_MAX) : 1;
  viewPanX = view ? view.panX : size.w / 2;
  viewPanY = view ? view.panY : size.h / 2;
  const percent = Math.round(viewZoom * 100);
  cropZoomSlider.value = String(percent);
  cropZoomValue.textContent = percent + '%';
  // Whatever a previous session left part way towards a step is not this one's.
  zoomWheelResidue = 0;
  cropModal.hidden = false;
  // Before the first paint, so a layer the playhead has left is not cropped
  // against whatever frame its decoder was last asked for.
  const target = cropTargetLayer();
  if (target) seedCropFrame(target);
  sizeCropStage(size);
  paintCropFrame();
  placeCropDraft();
  captureCropAnchor(size);
  updateCropArrows();
  setCropHint(false);
  // Every opening starts on the crop, which is what the button that opened it
  // says it does. The tabs themselves are advanced editing only.
  cropTabs.hidden = !timelineDriving();
  // Opened on whichever tab the caller asked for, which is how the two clip
  // marks each land on their own. The button in the preview head asks for
  // nothing and gets the crop, which is what it says it does.
  // Wherever this layer is now, placed or not, so the position tab has a
  // rectangle to drag the moment it is opened.
  placeTouched = false;
  placeDraft = target ? (target.render ? { ...target.render } : placeFitRect(target)) : null;
  showCropTab(timelineDriving() && tab === 'place' ? 'place' : 'frame');
}

function closeCrop() {
  cropModal.hidden = true;
  cropDraft = null;
  placeDraft = null;
  placeDrag = null;
  placeTouched = false;
  // Back to following the selection. Cleared after the modal is hidden and
  // before anything redraws, so nothing reads it as still open on a layer.
  cropLayerId = null;
  setCropHint(false);
  updateCropArrows();
}

// Wrapped rather than passed: the click hands its event to the first argument,
// which is where openCrop now takes a layer id.
cropBtn.addEventListener('click', () => openCrop());
cropCancelBtn.addEventListener('click', closeCrop);

// Takes the crop off outright, whatever is in the popup: the whole picture is
// saved again and the boxes come off the three frames. The same thing Original
// then Accept does, without having to know that is what Original means.
cropRemoveBtn.addEventListener('click', () => {
  // V2.1. Whichever tab is up. On the crop it takes the crop off; on the
  // position it puts the layer back to centre and fit. One button rather than
  // two, because the tabs are two views of one layer and Remove means "take
  // back what this tab does".
  if (cropTab === 'place') {
    if (cropLayerId) {
      setLayers(timelineModel.setLayer(layers, cropLayerId, { render: null }));
      commitHistory();
    }
    closeCrop();
    updateCropOverlays();
    updateCropBtn();
    return;
  }
  // Nothing left to come back to, so the next opening starts over.
  setCurrentCrop(null, null);
  commitHistory();
  closeCrop();
  updateCropOverlays();
  updateCropBtn();
});

cropAcceptBtn.addEventListener('click', () => {
  const size = sourceSize();
  // The whole frame is not a crop: storing it would cost a re-encode and show a
  // box around the entire picture, for nothing.
  const rect = (size && cropDraft && !isFullFrame(cropDraft, size)) ? { ...cropDraft } : null;
  // Where the popup was looking from when the crop was settled on. Only worth
  // keeping alongside a crop: without one it would open zoomed into nothing.
  // One step for the whole popup: opening it on one side and accepting it on
  // the other, with nothing in between. The user set that boundary.
  // V2.1. One Accept settles both tabs, which is the boundary the user drew
  // when the popup gained the second one. A placement that is still the centre
  // and fit is stored as null, for the same reason the whole frame is not a
  // crop: it is what the geometry works out on its own, and writing it down
  // would freeze it against a crop or a project frame that changes later.
  const render = (placeDraft && !sameRect(placeDraft, placeFitRect(cropTargetLayer())))
    ? { ...placeDraft }
    : null;
  setCurrentCrop(rect, rect ? { zoom: viewZoom, panX: viewPanX, panY: viewPanY } : null);
  // After the crop, and through the id rather than the layer object: setLayers
  // has just replaced the array that object came out of.
  if (cropLayerId) {
    setLayers(timelineModel.setLayer(layers, cropLayerId, { render }));
  }
  commitHistory();
  closeCrop();
  updateCropOverlays();
  updateCropBtn();
});

// Backdrop only, matching the other popup: a click on the panel itself, or the
// tail of a drag that ended outside the frame, must not throw the crop away.
//
// The second half of that was written here as an intention and never as code,
// and it went unnoticed because a bar could not be dragged past the picture, so
// the pointer rarely left the panel. 21e makes it the ordinary way to use the
// popup. A click is dispatched to the nearest ancestor of where the press and
// the release landed, which for a drag that ends out on the backdrop is the
// backdrop, so the press has to be remembered rather than the release trusted.
let cropPressedBackdrop = false;
cropModal.addEventListener('pointerdown', (evt) => {
  cropPressedBackdrop = evt.target === cropModal;
});
cropModal.addEventListener('click', (evt) => {
  if (evt.target === cropModal && cropPressedBackdrop) closeCrop();
});

// The note only applies while the copy path is selected, and that switch lives
// outside the popup, so it can change while the popup is open.
accurateToggle.addEventListener('change', () => {
  if (!cropModal.hidden && cropDraft) updateCropNote();
});

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
    const result = await window.lwclipper.compose(
      layers, projectFrame(), { start: slider.start, end: slider.end },
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
document.addEventListener('click', () => {
  if (!saveNotice.hidden) saveNotice.hidden = true;
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

// Backdrop only. Listening here rather than on the document avoids the opening
// click closing it again on the same gesture.
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // The question first: it is the one that is blocking something.
  if (!choiceModal.hidden) settleChoice(choiceCancelId);
  if (!settingsModal.hidden) closeSettings();
  // Escape discards, the same as Cancel: nothing is written to cropRect here.
  if (!cropModal.hidden) closeCrop();
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

// Registered once, not per job: preload adds a listener on every call, so
// wiring this inside the download/save handlers stacked up duplicates.
window.lwclipper.onProgress(({ frac, text }) => setProgress(frac, text));
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
