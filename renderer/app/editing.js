'use strict';

// The playhead, the clipboard and right click menu, the question modal, the
// project file and undo.

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
 * Every popup is in the list bindPopup keeps, so none can be forgotten here.
 */
function modalOpen() {
  return topPopup() !== null;
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

// Typing keeps the arrows, and so does a focused slider, where left and right
// are how it is set without a mouse. Its own list rather than KEEPS_SPACE's,
// for the reason KEEPS_UNDO has its own: these guards are about different keys
// and there is no reason they should have to move together.
const KEEPS_ARROWS = ['INPUT', 'TEXTAREA', 'SELECT'];

/**
 * The frame rate the playhead is a position in.
 *
 * The project's own in advanced editing, because that is the rate that will be
 * written and a step of any other length would land between two frames of the
 * file. The media's in simple editing, where the output follows the source.
 */
function playheadFps() {
  const fps = timelineDriving() ? projectFrame().fps : Number(media && media.fps);
  return Number.isFinite(fps) && fps > 0 ? fps : COMPOSITE_FALLBACK.fps;
}

/**
 * One frame back or on: "Add support for arrow left/right pressing which will
 * jump to the previous/next frame (if thats possible without proxy media)."
 *
 * It is possible, and this is what it costs: each step is a real seek and a
 * real decode of one frame, so holding the key down runs at whatever the
 * decoders manage rather than at the key repeat rate. Nothing is cached and
 * nothing is built ahead, which is exactly why it needs no proxy media.
 *
 * Counted in frames rather than added in seconds, so a hundred steps land on
 * frame one hundred instead of a hundred roundings away from it. A source whose
 * frames are not evenly spaced steps by the output's frame rather than by its
 * own, which is the only step that is the same length every time and the only
 * one the encoder would agree with.
 *
 * It stops the transport first. Stepping is a way of looking at one frame, and
 * a clock that is about to move the playhead on again is not looking at it.
 */
function stepFrame(dir) {
  const fps = playheadFps();
  const frameAt = (at) => Math.round(at * fps);
  if (timelineDriving()) {
    if (compositePlaying) pauseComposite();
    seekComposite((frameAt(compositeAt) + dir) / fps);
    // seekComposite moves the clock and the picture and leaves the line where
    // it was: the frame loop is what usually carries it, and there is no frame
    // loop running here. In simple editing the element's own seeked does it.
    updatePlayhead();
    return;
  }
  if (!media) return;
  if (!transport.paused) transport.pause();
  const total = Math.max(0, media.duration || 0);
  const want = (frameAt(transport.currentTime) + dir) / fps;
  transport.currentTime = Math.min(Math.max(0, want), total);
}

// Capture, and the event is stopped here rather than only prevented. The
// preview carries the browser's own media controls, and those answer an arrow
// key with a five second seek of their own before a listener on the document
// would ever be reached.
document.addEventListener('keydown', (evt) => {
  const back = evt.key === 'ArrowLeft';
  if (!back && evt.key !== 'ArrowRight') return;
  if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
  if (modalOpen()) return;
  const focused = document.activeElement;
  if (focused && KEEPS_ARROWS.includes(focused.tagName)) return;
  if (focused && focused.isContentEditable) return;
  if (!media && !timelineDriving()) return;
  evt.preventDefault();
  evt.stopPropagation();
  stepFrame(back ? -1 : 1);
}, true);

/**
 * V2.9. The selected clip cut in two at a second of the timeline, and its group
 * with it. S cuts at the playhead; the right click menu cuts where it was
 * opened. Hands back whether anything was cut, since a cut too close to an end
 * is refused and the caller may want to say so.
 */
function splitSelected(at) {
  if (!timelineDriving() || busy || !selectedLayerId) return false;
  const next = timelineModel.splitLayer(layers, selectedLayerId, at);
  if (next === layers) return false;
  setLayers(next);
  commitHistory();
  return true;
}

/**
 * Whether a letter pressed now is being typed into something. Narrower than
 * KEEPS_ARROWS on purpose: a focused checkbox or slider takes the arrows,
 * which is how it is set from the keyboard, but has no use for a letter, and
 * pressing Enabled leaves the focus on it.
 */
const TAKES_NO_LETTERS = ['checkbox', 'radio', 'range', 'button', 'submit', 'color', 'file'];
function typingInto(node) {
  if (!node) return false;
  if (node.isContentEditable) return true;
  if (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true;
  return node.tagName === 'INPUT' && !TAKES_NO_LETTERS.includes(node.type);
}

// S splits, not while something is being typed and not while a popup has the
// window. No modifiers, because Ctrl+S is save and is handled on its own.
document.addEventListener('keydown', (evt) => {
  if (String(evt.key).toLowerCase() !== 's') return;
  if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.repeat) return;
  if (modalOpen() || typingInto(document.activeElement)) return;
  if (!timelineDriving()) return;
  evt.preventDefault();
  splitSelected(compositeAt);
});

// ---- the clipboard, Delete, and the right click menu ----
//
// V2.9. Asked for on 2026-09-24: "pressing del or backspace on the keyboard
// deletes the selected track. Additionally add a little pop-up right click
// menu. So rightclicking anywhere on the track opens it, selecting an option or
// clicking anywhere outside of it closes it. Options of the right click menu:
// Split here, Copy, Paste, Delete for now."
//
// Every item is a thing a key already does, so the menu is a second way to
// reach four functions rather than four functions of its own. What the menu
// adds is a place: Split here and Paste act where it was opened, not at the
// playhead.

// The app's own clipboard. See timelineModel.copyOf for why not the system's.
let layerClipboard = null;

function copySelected() {
  if (!timelineDriving() || !selectedLayerId) return false;
  const clip = timelineModel.copyOf(layers, selectedLayerId);
  if (!clip) return false;
  layerClipboard = clip;
  return true;
}

/**
 * The clipboard put back at a second of the timeline, on a lane of the given
 * kind when that is the kind being pasted, and on a new lane otherwise. The
 * copied layer becomes the selection, so a second Ctrl+V pastes after it
 * rather than over the original, and so the Crop button acts on what was just
 * pasted.
 */
function pasteAt(at, type, lane) {
  if (!timelineDriving() || busy || !layerClipboard) return false;
  const primary = layerClipboard.items.find((l) => l.id === layerClipboard.primary)
    || layerClipboard.items[0];
  const onto = type === primary.type ? lane : null;
  const had = new Set(layers.map((l) => l.id));
  const next = timelineModel.pasteInto(layers, layerClipboard, at, onto);
  if (next === layers) return false;
  const pasted = next.find((l) => !had.has(l.id) && l.type === primary.type);
  if (pasted) selectedLayerId = pasted.id;
  setLayers(next);
  commitHistory();
  return true;
}

/**
 * The selected clip, and only it. A clip grouped with a sound leaves the sound
 * behind, still marked, which is the rule the row's delete button has kept
 * since Step 14: only what was pointed at goes.
 */
function deleteSelected() {
  if (!timelineDriving() || busy || !selectedLayerId) return false;
  const next = timelineModel.removeLayer(layers, selectedLayerId);
  if (next.length === layers.length) return false;
  setLayers(next);
  commitHistory();
  return true;
}

// Ctrl+C and Ctrl+V on the timeline, and Del and Backspace. Each leaves the key
// alone while something is being typed, where copy, paste and delete already
// mean something, and each only takes the key when it has something to do with
// it, so the browser's own answer is not swallowed for nothing.
document.addEventListener('keydown', (evt) => {
  if (modalOpen() || typingInto(document.activeElement)) return;
  if (!timelineDriving()) return;
  const key = String(evt.key).toLowerCase();
  const ctrl = evt.ctrlKey || evt.metaKey;
  let done = false;
  if (ctrl && !evt.altKey && !evt.shiftKey && key === 'c') {
    done = copySelected();
  } else if (ctrl && !evt.altKey && !evt.shiftKey && key === 'v') {
    // At the playhead, on the selected clip's lane: "If there is no click
    // behind it, Crtl+V pastes behind the playhead. If no layer got selected,
    // paste the copied source into a newly created layer if needed."
    const sel = selectedLayerId && timelineModel.layerById(layers, selectedLayerId);
    done = pasteAt(compositeAt, sel ? sel.type : null, sel ? sel.lane : null);
  } else if (!ctrl && !evt.altKey && (key === 'delete' || key === 'backspace')) {
    done = deleteSelected();
  }
  if (done) {
    evt.preventDefault();
    closeClipMenu();
  }
});

let clipMenu = null;

/**
 * V3. "Add Media" and the submenu it opens, the user's A1: "Only usable on a
 * video layer, greyed out on audio. Hovering it reveals the next menu". Shapes
 * are not in it until they exist.
 *
 * The submenu opens beside the entry, on the right, and on the left when the
 * right would run it off the window. It lives inside the menu's element even
 * though it is placed outside its box, so the one outside-click test the menu
 * already has covers it, and so moving the pointer from the entry into it
 * never counts as leaving. It closes a moment after the pointer leaves, which
 * is what lets a pointer cut the corner on the way to Bar.
 */
function addMediaEntry(menu, enabled, at) {
  const wrap = document.createElement('div');
  wrap.className = 'clip-menu__sub';
  const entry = document.createElement('button');
  entry.className = 'clip-menu__item clip-menu__item--more';
  entry.setAttribute('role', 'menuitem');
  entry.setAttribute('aria-haspopup', 'menu');
  entry.textContent = t('Add Media');
  entry.disabled = !enabled;
  wrap.appendChild(entry);

  const sub = document.createElement('div');
  sub.className = 'clip-menu clip-menu--sub';
  sub.setAttribute('role', 'menu');
  sub.hidden = true;
  for (const [form, kind] of Object.entries(GEN_KINDS)) {
    const b = document.createElement('button');
    b.className = 'clip-menu__item';
    b.setAttribute('role', 'menuitem');
    b.textContent = kind.label();
    b.addEventListener('click', () => {
      closeClipMenu();
      addGenMedia(form, at);
    });
    sub.appendChild(b);
  }
  wrap.appendChild(sub);
  menu.appendChild(wrap);
  if (!enabled) return;

  let closing = null;
  const show = () => {
    clearTimeout(closing);
    if (!sub.hidden) return;
    sub.hidden = false;
    const r = entry.getBoundingClientRect();
    const w = sub.offsetWidth;
    const h = sub.offsetHeight;
    // Level with the entry, less the submenu's own padding, so its first item
    // sits beside the entry that opened it.
    const left = r.right + w + 4 <= window.innerWidth ? r.right : r.left - w;
    sub.style.left = Math.max(4, left) + 'px';
    sub.style.top = Math.max(4, Math.min(r.top - 4, window.innerHeight - h - 4)) + 'px';
  };
  const hide = () => {
    clearTimeout(closing);
    closing = setTimeout(() => {
      sub.hidden = true;
    }, 250);
  };
  wrap.addEventListener('pointerenter', show);
  wrap.addEventListener('pointerleave', hide);
  entry.addEventListener('click', show);
}

/**
 * V3. A new text or bar at `at`, on the row the user's rule gives it: the
 * topmost empty video row, or a new one on top. Ten seconds, like an image.
 * Its settings open straight away, and until they are accepted the new layer
 * is not a step of its own: adding it and the first Accept are one undo step,
 * and Cancel on that first opening takes it off again.
 */
function addGenMedia(form, at) {
  if (!timelineDriving() || busy) return;
  const gen = GEN_KINDS[form].starter();
  const rows = rowsOf('video');
  genAddBefore = { layers, rows: laneRows.video, selected: selectedLayerId };
  const added = timelineModel.addGen(layers, gen, at, rows);
  if (added.inserted) laneRows.video = rows + 1;
  selectedLayerId = added.layer.id;
  setLayers(added.layers);
  openGenSettings(added.layer.id, true);
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
    // Not named el: that is the id lookup every file of the window uses,
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

// Backdrop only: a click on the panel itself must not answer the question.
// Over whatever asked it.
bindPopup(choiceModal, () => settleChoice(choiceCancelId), 1);

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

  resetLaneRows();
  setLayers(keep, true);
  // After setLayers, the same ordering applyHistory needs: syncProjectTrim in
  // there follows the project's new length and would move the very markers
  // being restored.
  const total = timelineModel.totalDuration(keep);
  trimSpan = total;
  if (total <= 0) slider.reset();
  // The ceiling rather than the total, or a project saved with its end past the
  // last layer would lose that the moment it was opened.
  else slider.setRange(timelineModel.trimCeiling(keep),
    result.doc.trim.start, result.doc.trim.end);
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
  resetLaneRows();
  setLayers(state.layers, true);
  // After setLayers and not before. syncProjectTrim in there follows a project
  // that just got longer or shorter, and it would move the very markers being
  // restored.
  const total = timelineModel.totalDuration(state.layers);
  trimSpan = total;
  if (total <= 0) slider.reset();
  // The ceiling rather than the total, for the reason opening a project uses
  // it: an end past the last layer is a thing to undo back to, not to lose.
  else slider.setRange(timelineModel.trimCeiling(state.layers), state.start, state.end);
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
