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
const startFrameVideo = el('startFrameVideo');
const endFrameVideo = el('endFrameVideo');
const previewStage = el('previewStage');
const startFrameStage = el('startFrameStage');
const endFrameStage = el('endFrameStage');
const previewCropBox = el('previewCropBox');
const startCropBox = el('startCropBox');
const endCropBox = el('endCropBox');
const playSelectionBtn = el('playSelectionBtn');
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
const startTimeField = el('startTimeField');
const endTimeField = el('endTimeField');
const hintLabel = el('hintLabel');
const spanLabel = el('spanLabel');
const accurateToggle = el('accurateToggle');
const accurateLabel = el('accurateLabel');
const videoEnabledToggle = el('videoEnabledToggle');
const renderResolution = el('renderResolution');
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
const openAppFilesBtn = el('openAppFilesBtn');
const deleteAppFilesBtn = el('deleteAppFilesBtn');

// ---- settings ----

let appSettings = { language: 'en', cacheDir: null, bestCompression: false };

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
  setTrimEnabled(!v && media !== null);
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
  if (!media) return false;
  return !!media.isAudio || !videoEnabledToggle.checked;
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
    b.disabled = busy || !media;
  });
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
  const modeAllows = isAudio || (accurateToggle.checked && !accurateToggle.disabled);
  const canCompress = !!steps && modeAllows && !!media && !busy;
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
  saveBtn.disabled = !(on && !busy);
  quickSaveBtn.disabled = !(on && !busy);
  updateCompressionState();
  playSelectionBtn.disabled = !on;
  updateCropBtn();
  if (!on) spanLabel.textContent = '';
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
  qualitySection.hidden = true;
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
}

function dropZoneUnder(evt) {
  const node = evt.target;
  if (!node || !node.closest) return null;
  return node.closest('#mainDrop, #audioSection');
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

// Catches everything the two zones do not, so a file dropped on the preview or
// the footer is simply ignored rather than navigating the window.
document.addEventListener('drop', (evt) => {
  if (!isFileDrag(evt)) return;
  evt.preventDefault();
  dragDepth = 0;
  setDropActive(false);
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
  if (!result.ok) {
    reportFailure(result);
    updateStatusScale();
    return;
  }
  adoptLocalMedia(result.data);
}

async function handleAudioDrop(filePath) {
  const result = await window.lwclipper.describeMedia(filePath);
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
  drawWaveform();
  updatePlayhead();
  updateCropOverlays();
  resizeCropStage();
});
// Switching the picture off turns this into an audio save, so the formats on
// offer, the compression scale and Frame-accurate cut all have to follow.
videoEnabledToggle.addEventListener('change', () => {
  applyPreviewMode();
  buildFormatToggle();
  accurateLabel.hidden = outputIsAudio();
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
  qualitySection.hidden = false;
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
    // The quality row just went from one line of text to a row of buttons.
    fitWindow();
  });
});

async function onFormatClicked(format, btn) {
  if (busy || !probed) return;
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
  accurateLabel.hidden = outputIsAudio();
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
}

slider.onChange = () => refreshSelection(null);

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

let eqAnalyser = null;
let eqLowAnalyser = null;
// Routing an element is a one-way door, so a half-built chain must not be
// retried: the second attempt would throw on the element already wired and
// leave the app trying forever. One flag, set whether it worked or not.
let gainChainTried = false;

function ensureGainChain() {
  if (gainCtx) return true;
  if (gainChainTried) return false;
  gainChainTried = true;
  try {
    const ctx = new AudioContext();
    // Both elements meet at the analyser and it passes them on to the output,
    // so the spectrum shows whatever is audible. Only one of them sounds at a
    // time, and a muted element contributes silence, which is what makes a
    // replacement track show up here in place of the original.
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
    const wire = (elem) => {
      const gain = ctx.createGain();
      ctx.createMediaElementSource(elem).connect(gain);
      gain.connect(analyser);
      return gain;
    };
    videoGain = wire(previewVideo);
    soundGain = wire(previewSound);
    trackGain = wire(previewAudio);
    // An analyser passes its input straight through, so chaining them puts the
    // same signal into both without a splitter, and the sound still comes out.
    analyser.connect(lowAnalyser);
    lowAnalyser.connect(ctx.destination);
    eqAnalyser = analyser;
    eqLowAnalyser = lowAnalyser;
    gainCtx = ctx;
  } catch {
    // No gain chain to be had; the preview just stays at its own volume and
    // the spectrum stays a flat line.
    return false;
  }
  return true;
}

function applyPreviewGain() {
  const gain = volumeGain();
  // Nothing to apply and nothing built yet: leave the plain path alone.
  if (gain === 1 && !gainCtx) return;
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
function updateVideoUi() {
  const hasMedia = media !== null;
  const audioOnly = hasMedia && media.isAudio;
  videoHead.hidden = !hasMedia || audioOnly;
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
  if (!audioOnly) {
    stopSpectrum();
    return;
  }
  // The spectrum needs the graph the volume slider builds lazily, so for an
  // audio source it is built up front rather than on the first slider move.
  if (ensureGainChain() && gainCtx.state === 'suspended') gainCtx.resume();
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
// Read before translateDom runs, so it holds the English, which is the key.

// Shared by the trim handles and the waveform drag, so the readout says the
// same thing whichever one is being dragged.
function setDragHint(factor) {
  hintLabel.textContent = factor === 1.0
    ? t(HINT_IDLE)
    : t('Fine dragging: {factor}x slower', { factor: Math.round(1 / factor) });
}

slider.onDragStateChange = setDragHint;

// normalize=false is the live path fired on every keystroke: it moves the
// frames but never rewrites the box being typed in, and tolerates a
// half-finished value instead of snapping the text back mid-edit.
function applyTimeField(field, isStart, normalize) {
  if (!media) return;
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
}

for (const [field, isStart] of [[startTimeField, true], [endTimeField, false]]) {
  field.addEventListener('input', () => applyTimeField(field, isStart, false));
  field.addEventListener('blur', () => applyTimeField(field, isStart, true));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTimeField(field, isStart, true);
  });
}

// ---- playhead ----

// Where the preview has got to, shown on the waveform and on the trim slider.
// Both use sliderMetrics, the same mapping the trim handles are placed with, so
// the bar lands on exactly the x a handle would for that second. Drawn as
// elements rather than into the canvas, so following playback costs two style
// writes a frame instead of a full waveform redraw.
function updatePlayhead() {
  const duration = media ? media.duration : 0;
  if (!duration) {
    audioPlayhead.hidden = true;
    trimPlayhead.hidden = true;
    return;
  }
  const at = Math.min(Math.max(transport.currentTime || 0, 0), duration);
  const frac = at / duration;

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

function togglePreview() {
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
  if (!settingsModal.hidden || !cropModal.hidden) return;
  const focused = document.activeElement;
  if (focused && KEEPS_SPACE.includes(focused.tagName)) return;
  if (!media) return;
  // Without this a focused button would be pressed as well, and the preview's
  // own controls would toggle it a second time, cancelling this one out.
  evt.preventDefault();
  togglePreview();
});

playSelectionBtn.addEventListener('click', () => {
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

const evenDown = (v) => Math.floor(v / 2) * 2;
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ffprobe's numbers are the coded dimensions ffmpeg's crop filter works in, so
// they win. The element's own are the fallback for anything that reached the
// app without a usable probe behind it.
function sourceSize() {
  const w = Math.floor((media && media.width) || previewVideo.videoWidth || 0);
  const h = Math.floor((media && media.height) || previewVideo.videoHeight || 0);
  if (w < CROP_MIN || h < CROP_MIN) return null;
  return { w: evenDown(w), h: evenDown(h) };
}

function canCrop() {
  return !!(media && !media.isAudio && sourceSize());
}

function fullRect(size) {
  return { x: 0, y: 0, width: size.w, height: size.h };
}

function isFullFrame(rect, size) {
  return rect.x === 0 && rect.y === 0 && rect.width >= size.w && rect.height >= size.h;
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
  const size = sourceSize();
  for (const [stageOf, boxOf] of CROP_OVERLAYS) {
    const box = boxOf();
    const pic = (cropRect && size) ? pictureBox(stageOf(), size) : null;
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
  const size = sourceSize();
  const showing = !!media && !outputIsAudio() && !!size;
  renderResolution.hidden = !showing;
  if (!showing) return;
  const w = cropRect ? cropRect.width : size.w;
  const h = cropRect ? cropRect.height : size.h;
  renderResolution.textContent = t('Render Resolution: {w} x {h}', { w, h })
    + (cropRect ? ' ' + t('(cropped)') : '');
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

function updateCropBtn() {
  // No picture in the output, nothing to crop out of it.
  cropBtn.hidden = outputIsAudio();
  cropBtn.disabled = busy || !canCrop();
  cropBtn.classList.toggle('btn--active', cropRect !== null);
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
  cropBaseScale = Math.min(w / size.w, h / size.h);
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

// How much of the picture the frame shows. The frame holds the whole of it at
// 100%, so at any zoom it holds exactly that much divided by the zoom.
//
// Taken from the picture rather than from the frame's own pixel size, which is
// a rounded integer: measuring it that way left the window a fraction short of
// the whole picture at 100%, which was enough, once rounded to an even number,
// to lose two pixels off Original and to leave half a pixel of slack in the pan
// for an arrow to light up on.
function viewSpan(size) {
  return {
    w: Math.min(size.w, cropStage.clientWidth / cropScale),
    h: Math.min(size.h, cropStage.clientHeight / cropScale),
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
  cropCanvas.style.left = cropPicture.left + 'px';
  cropCanvas.style.top = cropPicture.top + 'px';
  cropCanvas.style.width = w + 'px';
  cropCanvas.style.height = h + 'px';
}

// Recomputes the scale the zoom implies and keeps the pan inside the picture,
// so no drag can ever pull empty space into the frame. At 100% the visible
// window is the whole picture, which pins the pan to the middle and leaves
// nothing to drag, which is why panning only exists above 100%.
function applyView(size) {
  cropScale = cropBaseScale * viewZoom;
  placePicture(size);
  const span = viewSpan(size);
  viewPanX = clamp(viewPanX, span.w / 2, size.w - span.w / 2);
  viewPanY = clamp(viewPanY, span.h / 2, size.h - span.h / 2);
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
  const slack = 0.5;   // a rounded pixel is not content worth pointing at
  return {
    up: v.y > slack,
    left: v.x > slack,
    down: v.y + v.h < size.h - slack,
    right: v.x + v.w < size.w - slack,
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
  cropActivePreset = null;
  markActivePreset();
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

// Whatever the preview is showing, painted once into the canvas. A canvas
// rather than a second <video>: it holds no file open, and it cannot drift off
// the position the preview is parked at while the popup is being used.
function paintCropFrame() {
  // The canvas covers the picture, not the whole frame, so the bars either side
  // of it are simply the frame showing through and nothing has to draw them.
  const cssW = cropPicture.w;
  const cssH = cropPicture.h;
  if (!cssW || !cssH) return;
  const dpr = window.devicePixelRatio || 1;
  cropCanvas.width = Math.round(cssW * dpr);
  cropCanvas.height = Math.round(cssH * dpr);
  const ctx = cropCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#121214';
  ctx.fillRect(0, 0, cssW, cssH);
  // HAVE_CURRENT_DATA is the point at which there is a frame to copy at all.
  // Below it the start frame is the next best thing: it preloads and is already
  // parked on the cut, where the preview may not have decoded anything yet.
  const src = previewVideo.readyState >= 2 ? previewVideo
    : (startFrameVideo.readyState >= 2 ? startFrameVideo : null);
  // Nothing is ever read back out of this canvas, only shown, so the file://
  // source tainting it costs nothing.
  if (!src) return;

  const size = sourceSize();
  if (!size) return;
  const view = viewWindow(size);
  // Only the visible window is drawn, rather than the whole picture with the
  // rest hanging over the edges. The element's own intrinsic size is what
  // drawImage measures its source rectangle in, and it need not match the coded
  // size ffprobe reported, so the window is carried across as a fraction.
  const iw = src.videoWidth || size.w;
  const ih = src.videoHeight || size.h;
  ctx.drawImage(src,
    (view.x / size.w) * iw, (view.y / size.h) * ih,
    (view.w / size.w) * iw, (view.h / size.h) * ih,
    0, 0, cssW, cssH);
}

// The popup is sized against the window, so resizing it while the popup is open
// has to redo the lot: the frame, the snapshot in it, and the box on top.
function resizeCropStage() {
  if (cropModal.hidden || !cropDraft) return;
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

function setCropHint(mirrored, diagonal = false) {
  if (mirrored && diagonal) {
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
  const v = viewWindow(size);
  return {
    minX: Math.max(0, 2 * Math.ceil((v.x - 0.5) / 2)),
    maxX: Math.min(size.w, 2 * Math.floor((v.x + v.w + 0.5) / 2)),
    minY: Math.max(0, 2 * Math.ceil((v.y - 0.5) / 2)),
    maxY: Math.min(size.h, 2 * Math.floor((v.y + v.h + 0.5) / 2)),
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
function applyDraft(shifted, diagonal = false) {
  const size = sourceSize();
  setCropHint(shifted, diagonal);
  cropActivePreset = null;
  markActivePreset();
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
    setCropHint(evt.shiftKey);
    // Stops the pointerdown from also starting a move of the whole box.
    evt.stopPropagation();

    beginDrag(grip, evt, (ev) => {
      const travel = (vertical ? ev.clientY : ev.clientX) - anchor;
      const { lo, hi } = resizeEdge(lo0, hi0, limit, movesLo, ev.shiftKey,
        travel / cropScale, travel, floor);
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
    setCropHint(evt.shiftKey, evt.ctrlKey);
    evt.stopPropagation();

    beginDrag(dot, evt, (ev) => {
      let travelX = ev.clientX - anchorX;
      let travelY = ev.clientY - anchorY;
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
        ev.shiftKey, travelX / cropScale, travelX, bounds.minX);
      const down = resizeEdge(start.y, start.y + start.height, bounds.maxY, movesTop,
        ev.shiftKey, travelY / cropScale, travelY, bounds.minY);
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
  cropActivePreset = null;
  markActivePreset();
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
    cropActivePreset = null;
    markActivePreset();
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
    const view = viewWindow(size);
    const window_ = { w: evenDown(view.w), h: evenDown(view.h) };
    const rect = preset.ratio === null ? fullRect(window_) : ratioRect(window_, preset.ratio);
    // Offset onto the picture, since what comes back is measured from the
    // corner of the visible window and sourceRectFromScreen wants a place on
    // the frame. Without this a preset on a clip that is not 16:9 lands a
    // bar's width off, which a 16:9 clip never shows because its bars are zero.
    const onFrame = {
      left: cropPicture.left + rect.x * cropScale,
      top: cropPicture.top + rect.y * cropScale,
      width: rect.width * cropScale,
      height: rect.height * cropScale,
    };
    cropDraft = sourceRectFromScreen(onFrame, size);
    // From what the preset asked for, not from what came back rounded.
    setCropAnchorFrom(onFrame);
    cropActivePreset = btn;
    markActivePreset();
    placeCropDraft();
  });
  cropPresets.appendChild(btn);
}

function openCrop() {
  const size = sourceSize();
  if (busy || !size) return;
  // A rectangle left over from a frame of a different size would be nonsense,
  // so anything that does not fit the current one starts over.
  const kept = cropRect
    && cropRect.x + cropRect.width <= size.w
    && cropRect.y + cropRect.height <= size.h;
  cropDraft = kept ? { ...cropRect } : fullRect(size);
  cropActivePreset = null;
  markActivePreset();
  // Back to the zoom and pan the crop was accepted at, so it opens on the view
  // it closed on rather than snapping out to the whole picture. The box is
  // carried in source pixels and drawn through that view, so it comes back the
  // size it was rather than the size it would be at 100%. With no crop to
  // return to there is nothing to restore, and it opens on the whole picture.
  const view = kept ? cropView : null;
  viewZoom = view ? clamp(view.zoom, CROP_ZOOM_MIN, CROP_ZOOM_MAX) : 1;
  viewPanX = view ? view.panX : size.w / 2;
  viewPanY = view ? view.panY : size.h / 2;
  const percent = Math.round(viewZoom * 100);
  cropZoomSlider.value = String(percent);
  cropZoomValue.textContent = percent + '%';
  // Whatever a previous session left part way towards a step is not this one's.
  zoomWheelResidue = 0;
  cropModal.hidden = false;
  sizeCropStage(size);
  paintCropFrame();
  placeCropDraft();
  captureCropAnchor(size);
  updateCropArrows();
  setCropHint(false);
}

function closeCrop() {
  cropModal.hidden = true;
  cropDraft = null;
  setCropHint(false);
  updateCropArrows();
}

cropBtn.addEventListener('click', openCrop);
cropCancelBtn.addEventListener('click', closeCrop);

// Takes the crop off outright, whatever is in the popup: the whole picture is
// saved again and the boxes come off the three frames. The same thing Original
// then Accept does, without having to know that is what Original means.
cropRemoveBtn.addEventListener('click', () => {
  cropRect = null;
  // Nothing left to come back to, so the next opening starts over.
  cropView = null;
  closeCrop();
  updateCropOverlays();
  updateCropBtn();
});

cropAcceptBtn.addEventListener('click', () => {
  const size = sourceSize();
  // The whole frame is not a crop: storing it would cost a re-encode and show a
  // box around the entire picture, for nothing.
  cropRect = (size && cropDraft && !isFullFrame(cropDraft, size)) ? { ...cropDraft } : null;
  // Where the popup was looking from when the crop was settled on. Only worth
  // keeping alongside a crop: without one it would open zoomed into nothing.
  cropView = cropRect ? { zoom: viewZoom, panX: viewPanX, panY: viewPanY } : null;
  closeCrop();
  updateCropOverlays();
  updateCropBtn();
});

// Backdrop only, matching the other popup: a click on the panel itself, or the
// tail of a drag that ended outside the frame, must not throw the crop away.
cropModal.addEventListener('click', (evt) => {
  if (evt.target === cropModal) closeCrop();
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
  // without one, and the main process clamps against that rather than trusting
  // the rectangle to be inside the picture.
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

saveBtn.addEventListener('click', async () => {
  if (busy || !media) return;
  const destination = await window.lwclipper.saveAsDialog(
    media.title, outputIsAudio(), outputFormat);
  if (!destination) return;
  await saveClipTo(destination);
});

quickSaveBtn.addEventListener('click', async () => {
  if (busy || !media) return;
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
  qualitySection.hidden = false;

  slider.reset();
  startTimeField.value = fmtTime(0);
  endTimeField.value = fmtTime(0);
  setTrimEnabled(false);

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

clearCacheBtn.addEventListener('click', async () => {
  if (busy) return;
  // Windows keeps a lock on whatever the preview holds open, and a locked file
  // silently survives the clear, so drop the source before deleting.
  dropPreviewSources();
  startFrame.clear();
  endFrame.clear();
  const freedMb = await window.lwclipper.clearCache();
  media = null;
  setTrimEnabled(false);
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
