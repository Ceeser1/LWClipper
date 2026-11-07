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
  // V4.0. The grey line playback leaves where it started, placed the same way
  // the playhead is.
  const startShown = timelineDriving() && playStartAt !== null && !timelinePlayhead.hidden;
  timelinePlayStart.hidden = !startShown;
  if (startShown) timelinePlayStart.style.left = (timelineView.timeToX(tlView, playStartAt) - 0.5) + 'px';

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

// V4.0. Space, and every other key below, is read by the one listener in
// actions.js, which asks the action table what a press means. What used to be
// a listener here each is the function that table runs.

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

/**
 * V4.0. A second back or on, Down and Up. The transport keeps running if it
 * was: unlike a frame step, this is a jump to watch from, not a frame to look
 * at.
 */
function stepSeconds(dir) {
  if (timelineDriving()) {
    seekComposite(compositeAt + dir);
    revealTime(compositeAt, dir > 0 ? 'right' : 'left');
    updatePlayhead();
    return;
  }
  if (!media) return;
  const total = Math.max(0, media.duration || 0);
  transport.currentTime = Math.min(Math.max(0, (transport.currentTime || 0) + dir), total);
}

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
  // V3.3. The track a crop window is open on asks first.
  const id = selectedLayerId;
  // V3.6.2. And so does the track a media window is open on.
  return confirmPopoutConflict([cropWindowOn(id) && cropWindowConflict(), genWindowConflict(id)], () => {
    const now = timelineModel.splitLayer(layers, id, at);
    if (now === layers) return false;
    setLayers(now);
    commitHistory();
    return true;
  });
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
  // V3.3. A chosen keyframe goes before its clip does.
  if (selectedKeyframe) return deleteSelectedKeyframe();
  const next = timelineModel.removeLayer(layers, selectedLayerId);
  if (next.length === layers.length) return false;
  // V3.8.2. A grouped track asks first: its partner goes with it or is left.
  const group = timelineModel.groupOf(layers, selectedLayerId);
  if (group.length > 1) {
    const id = selectedLayerId;
    return confirmGroupedDelete(t('This track is grouped.'),
      () => deleteTracks([id], group[0].groupId),
      () => deleteTracks(group.map((l) => l.id), null));
  }
  return deleteTracks([selectedLayerId], null);
}

/**
 * V3.8.2. The question before a delete would take a track out of its group, or
 * a row holding grouped tracks. One line of text; Cancel on the left in the
 * ordinary button colour, and on the right Delete Group, which takes the
 * connected tracks too, and Delete Single, which takes only what was pointed
 * at and disbands the group. A click outside answers Cancel, which showChoice's
 * backdrop already does. Answers true at once, as a delete that is on its way.
 */
function confirmGroupedDelete(warning, onSingle, onGroup) {
  showChoice({
    title: t('Warning'),
    message: warning + ' ' + t('Are you sure you want to delete it?'),
    buttons: [
      { id: 'cancel', label: t('Cancel'), left: true },
      { id: 'group', label: t('Delete Group'), tone: 'danger' },
      { id: 'single', label: t('Delete Single'), tone: 'danger' },
    ],
    cancel: 'cancel',
  }).then((choice) => {
    if (choice === 'single') onSingle();
    else if (choice === 'group') onGroup();
  });
  return true;
}

/**
 * V3.8.2. These tracks out of the document, one undo step. `disband` is a
 * group id to dissolve in what is left, for a track deleted on its own out of
 * a group; the windows open on any of them are asked about first.
 */
function deleteTracks(ids, disband) {
  const conflicts = ids.flatMap((id) => [cropWindowOn(id) && cropWindowConflict(), genWindowConflict(id)]);
  return confirmPopoutConflict(conflicts, () => {
    let now = layers;
    for (const id of ids) now = timelineModel.removeLayer(now, id);
    if (disband) now = timelineModel.ungroup(now, disband);
    if (now.length === layers.length) return false;
    setLayers(now);
    commitHistory();
    return true;
  });
}

/**
 * Ctrl+V: at the playhead, on the selected clip's lane. "If there is no click
 * behind it, Crtl+V pastes behind the playhead. If no layer got selected,
 * paste the copied source into a newly created layer if needed."
 */
function pasteAtPlayhead() {
  const sel = selectedLayerId && timelineModel.layerById(layers, selectedLayerId);
  return pasteAt(compositeAt, sel ? sel.type : null, sel ? sel.lane : null);
}

/**
 * V4.0. Ctrl+X: copy, then take away what was copied. Copying a clip copies
 * its group with it, so the whole group goes and nothing is asked: the
 * clipboard is holding every one of them.
 */
function cutSelected() {
  if (!timelineDriving() || busy || !selectedLayerId) return false;
  const ids = timelineModel.groupOf(layers, selectedLayerId).map((l) => l.id);
  if (!copySelected()) return false;
  return deleteTracks(ids, null);
}

/**
 * Ctrl+A chooses every clip and nothing of the page round it.
 *
 * V4.0. On any press that is not typing, where V3.8.2 asked for the timeline
 * to have been clicked last: the Edit menu shows the key beside Select all
 * tracks, so the key has to do what the entry says wherever it is pressed.
 */
function selectAllClips() {
  window.getSelection().removeAllRanges();
  if (!timelineDriving() || !layers.length) return false;
  setLayerSelection(layers.map((l) => l.id), selectedLayerId);
  return true;
}

/**
 * V4.0. Ctrl+G: the chosen clips into one group. A chosen clip that is already
 * grouped brings its whole group into the new one, so a video is never pulled
 * away from its own sound by being grouped with something else.
 */
function groupSelected() {
  if (!timelineDriving() || busy) return false;
  const ids = selectionIds();
  if (ids.length < 2) return false;
  const all = new Set();
  for (const id of ids) for (const member of timelineModel.groupOf(layers, id)) all.add(member.id);
  setLayers(timelineModel.group(layers, [...all]));
  commitHistory();
  // The selection is kept, so the group can be moved straight away.
  setLayerSelection(ids, selectedLayerId);
  return true;
}

let clipMenu = null;

/**
 * V3. "Add Media" and the submenu it opens, the user's A1: "Only usable on a
 * video layer, greyed out on audio. Hovering it reveals the next menu".
 * V3.6.5. Shape is one entry now, where it opened a submenu of its kinds.
 */
function addMediaEntry(menu, enabled, at) {
  subMenuEntry(menu, t('Add Media'), enabled, (sub) => {
    for (const [form, kind] of Object.entries(GEN_KINDS)) {
      menuItem(sub, kind.label(), () => addGenMedia(form, at));
    }
  });
}

function menuItem(menu, label, act) {
  const b = document.createElement('button');
  b.className = 'clip-menu__item';
  b.setAttribute('role', 'menuitem');
  b.textContent = label;
  b.addEventListener('click', () => {
    closeClipMenu();
    act();
  });
  menu.appendChild(b);
}

/**
 * An entry with a right arrow that opens a submenu, filled by `fill`.
 *
 * The submenu opens beside the entry, on the right, and on the left when the
 * right would run it off the window. It lives inside the menu's element even
 * though it is placed outside its box, so the one outside-click test the menu
 * already has covers it, and so moving the pointer from the entry into it
 * never counts as leaving; a submenu inside a submenu is inside both. It
 * closes a moment after the pointer leaves, which is what lets a pointer cut
 * the corner on the way to the last item.
 */
function subMenuEntry(menu, label, enabled, fill) {
  const wrap = document.createElement('div');
  wrap.className = 'clip-menu__sub';
  const entry = document.createElement('button');
  entry.className = 'clip-menu__item clip-menu__item--more';
  entry.setAttribute('role', 'menuitem');
  entry.setAttribute('aria-haspopup', 'menu');
  entry.textContent = label;
  entry.disabled = !enabled;
  wrap.appendChild(entry);

  const sub = document.createElement('div');
  sub.className = 'clip-menu clip-menu--sub';
  sub.setAttribute('role', 'menu');
  sub.hidden = true;
  fill(sub);
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
 * V3. A new generated layer at `at`, on the row the user's rule gives it: the
 * topmost empty video row, or a new one on top. Ten seconds, like an image.
 * Its settings open straight away, and until they are accepted the new layer
 * is not a step of its own: adding it and the first Accept are one undo step,
 * and Cancel on that first opening takes it off again.
 */
function addGenMedia(form, at, variant) {
  if (!timelineDriving() || busy) return;
  // V3.6.2. Its settings open in a window, asked about before anything is
  // added, so Abort adds nothing. V3.8.2: only the same kind of window being
  // open, or Crop Render Frame, is in the way.
  const conflicts = genOpenConflicts(GEN_KINDS[form].modal());
  if (conflicts.some(Boolean)) {
    confirmPopoutConflict(conflicts, () => addGenMedia(form, at, variant));
    return;
  }
  const gen = GEN_KINDS[form].starter(variant);
  const rows = rowsOf('video');
  const before = { layers, rows: laneRows.video, selected: selectedLayerId };
  const added = timelineModel.addGen(layers, gen, at, rows);
  if (added.inserted) laneRows.video = rows + 1;
  selectedLayerId = added.layer.id;
  setLayers(added.layers);
  // V3.6.2. What the add made, so its Cancel can tell whether anything has
  // happened since, see cancelGenAdd.
  before.after = layers;
  before.id = added.layer.id;
  genAddBefore.set(added.layer.id, before);
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
function showChoice({ title, message, footer, entries, checks, single, onCheck, buttons, cancel, stacked }) {
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
    // V3.6.1. `single` makes the rows a pick of one, which is the restore
    // window's list of auto-saves. The answer still arrives through onCheck,
    // as a list holding the one picked.
    box.type = single ? 'radio' : 'checkbox';
    if (single) box.name = 'choicePick';
    box.className = 'choice-row__check';
    box.checked = !!row.checked && !(single && ticked.size);
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
      if (single) ticked.clear();
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
  // V3.8.4. One above the other in the middle of the panel, for answers too
  // long to stand side by side: the Different LWC Project question's.
  choiceButtons.classList.toggle('choice-buttons--stacked', !!stacked);
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
    // V3.8.2. A button kept to the left, the rest staying on the right.
    if (button.left) node.classList.add('choice-buttons__left');
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
  // V3.3. The editors' views go into the file beside the document, and not
  // into it: what markProjectSaved keeps below is the document alone.
  // V3.3. The undo stack goes with them, the same way.
  const result = await window.lwclipper.saveProject(target,
    { ...document, views: viewsForFile(), history: projectHistory.pack(undoStack) },
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
  // V3.8.4. With a project open the file is named first and the question
  // comes after, since merging it is one of the answers and needs the file.
  if (projectIsOpen()) {
    const picked = await window.lwclipper.projectOpenDialog();
    if (!picked || picked.cancelled) return;
    if (!picked.ok) {
      setProjectError(picked.error);
      return;
    }
    await openProjectPath(picked.path);
    return;
  }
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
 * V3.8.4. Whether a project is open for another to be told apart from: one
 * with a file, or anything on the timeline. An empty timeline that was never
 * saved is not one, and a project simply opens into it as it always has.
 */
function projectIsOpen() {
  return timelineDriving() && (!!projectPath || layers.length > 0);
}

/**
 * V3.8.4. The user: a project file dragged into a layer, onto Add new Layer
 * or opened with Open File "should not just replace the current project if
 * saved and not only give a warning popup "Unsaved changes" if not saved".
 * 'save', 'merge', 'discard' or 'cancel', and 'open' when no project is open
 * to ask about. Save in green, Merge in yellow, Discard in red, Cancel plain.
 */
async function askDifferentProject() {
  if (!projectIsOpen()) return 'open';
  return showChoice({
    title: t('Different LWC Project'),
    message: t('You attempted to open another LWC Project while one is opened, what would you like to do?'),
    buttons: [
      { id: 'save', label: t('Save this project, then open the other'), primary: true },
      { id: 'merge', label: t('Merge the other project with this as new layers'), tone: 'caution' },
      { id: 'discard', label: t('Discard changes on this project, then open the other'), tone: 'danger' },
      { id: 'cancel', label: t('Cancel') },
    ],
    cancel: 'cancel',
    stacked: true,
  });
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
  if (busy || !filePath) return false;
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
  // V3.8.4. With a project open, the Different LWC Project question instead:
  // save this one and open that, merge that one in, throw this one's changes
  // away and open that, or none of them. Each answer is the unsaved changes
  // question already answered, so that is not asked as well.
  const how = await askDifferentProject();
  const ready = how === 'save' ? await saveProject(false)
    : how === 'open' ? await confirmDiscard()
      : how === 'merge' || how === 'discard';
  if (!ready) {
    if (wasSimple) await setAdvancedEditing(false);
    return false;
  }
  // Read after the save, not before: the file may be this very project's.
  const result = await window.lwclipper.openProject(filePath);
  if (!result || !result.ok) {
    if (wasSimple) await setAdvancedEditing(false);
    setProjectError(result && result.error);
    return false;
  }
  // V3.6.1. Whether it opened, which the restore window needs to know.
  const opened = how === 'merge' ? await mergeProject(result) : await adoptProject(result);
  if (!opened && wasSimple) await setAdvancedEditing(false);
  return opened;
}

/**
 * V3.8.4. Merge: the other project's tracks under this one's as new layers,
 * the user's "keeping all settings from the project file except for the
 * Undo-stack of the other project, the current file only gets one undo added
 * which removes the merged project again if used". This project stays what
 * it was: its file, its frame, its trim and its undo stack. Tracks whose file
 * has gone are asked about as on opening, and the editors' zoom and pan for
 * the merged tracks come along.
 *
 * A project saved at another resolution is fitted into this one's frame the
 * way Crop Render Frame fits a frame into another: scaled to fit, centred, and
 * every placed picture, text box and shape carried with it, so the merged
 * tracks look in this frame as they did in their own.
 */
async function mergeProject(result) {
  const { layers: resolved, trouble } = projectFile.applyStatuses(result.doc, result.statuses);
  if (trouble.length && !(await askAboutMissing(trouble))) return false;
  const built = projectLayersOf(resolved, result.masksMissing);
  const keep = trouble.length ? projectFile.pruneTrouble(built, trouble) : built;
  if (!keep.length) {
    setStatus('That project has no tracks to merge.');
    return false;
  }
  const theirs = projectFrameOf(result.doc.project);
  let incoming = keep;
  if (!compositeFrame && theirs) {
    // Nothing here has a frame yet, which a timeline of sound alone has not.
    compositeFrame = theirs;
    sizeCompositeCanvas();
  } else if (compositeFrame && theirs
    && (theirs.width !== compositeFrame.width || theirs.height !== compositeFrame.height)) {
    incoming = keep.map((l) => fitMergedLayer(l, theirs, compositeFrame));
  }
  // Under the rows already shown, empty ones too, except a kind with nothing
  // on it at all, whose one row is a placeholder and is filled from the top.
  const rows = {};
  for (const type of ['video', 'audio']) {
    rows[type] = layers.some((l) => l.type === type) ? rowsOf(type) : 0;
  }
  const merged = timelineModel.mergeLayers(layers, incoming, rows);
  mergeViews(result.views, merged.ids);
  // As restoring, so the fades are put down exactly as saved rather than
  // worked out again for the overlaps the merged tracks bring along.
  setLayers(merged.layers, true);
  commitHistory();
  // Chosen together, so they can be moved as one straight away.
  const added = [...merged.ids.values()];
  setLayerSelection(added, added[0]);
  const maskless = (result.masksMissing || []).length;
  if (trouble.length) setStatus('Project merged without {n} track(s).', { n: trouble.length });
  else if (maskless) setStatus('Project merged. {n} mask picture(s) could not be found, those tracks have no mask.', { n: maskless });
  else setStatus('Project merged: {n} track(s) added.', { n: added.length });
  return true;
}

/**
 * V3.8.4. A merged layer moved from its own project's frame into this one's:
 * scaled by `k` to fit and centred, Crop Render Frame's carry. A picture with
 * no placement of its own keeps fitting the frame while the two frames are
 * one shape, and is pinned where it stood in its own frame when they are not.
 */
function fitMergedLayer(layer, from, to) {
  if (layer.type !== 'video') return layer;
  const k = Math.min(to.width / from.width, to.height / from.height);
  const dx = (to.width - from.width * k) / 2;
  const dy = (to.height - from.height * k) / 2;
  if (layer.kind === 'gen') return timelineModel.reframeKeyed(layer, from.height, to.height, k, dx, dy);
  const sameShape = Math.abs(from.width * to.height - to.width * from.height) < 1e-6 * from.width * to.height;
  const source = layerSource(layer);
  const carry = (crop, render) => {
    if (!render && (sameShape || !source)) return render;
    const p = source
      ? layerGeometry.placeLayer({ source, crop, render, project: from })
      : { dest: render };
    if (!p || !p.dest) return render;
    return {
      x: Math.round(dx + p.dest.x * k),
      y: Math.round(dy + p.dest.y * k),
      width: Math.round(p.dest.width * k),
      height: Math.round(p.dest.height * k),
    };
  };
  return {
    ...layer,
    render: carry(layer.crop, layer.render),
    keyframes: timelineModel.keyframesFor(layer).map((kf) => ({ ...kf, render: carry(kf.crop, kf.render) })),
  };
}

/** V3.8.4. The merged project's editor views, under its tracks' new ids. */
function mergeViews(views, ids) {
  for (const [key, view] of Object.entries(views || {})) {
    const m = /^([^|]+)\|([^#@]+)(.*)$/.exec(key);
    if (!m || !ids.has(m[2])) continue;
    rememberedViews.set(m[1] + '|' + ids.get(m[2]) + m[3], { ...view });
  }
}

/**
 * The tracks whose files are not where they were, named before anything is
 * decided. True to go on without them.
 */
async function askAboutMissing(trouble) {
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
  return choice === 'continue';
}

/**
 * A file's layers through the model, which is what says what a layer is. A
 * file carries a ref block and may carry fields this version has never heard
 * of; createLayer takes what it knows and clamps it. V3.6. A track whose mask
 * picture has gone opens without its mask.
 */
function projectLayersOf(resolved, masksMissing) {
  const maskless = new Set(masksMissing || []);
  return resolved.map((l) => {
    const layer = timelineModel.createLayer(l);
    return maskless.has(layer.id) ? timelineModel.removeMask([layer], layer.id)[0] : layer;
  });
}

/** A file's project frame, or null for a project that had no picture. */
function projectFrameOf(frame) {
  return frame && frame.width > 1 && frame.height > 1
    ? {
      width: frame.width,
      height: frame.height,
      // A project written before Step 15 carries no rate at all, and the rate
      // the app rendered at then was the composer's own default.
      fps: frame.fps > 0 ? frame.fps : COMPOSITE_FALLBACK.fps,
    }
    : null;
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
  if (trouble.length && !(await askAboutMissing(trouble))) return false;

  const maskless = new Set(result.masksMissing || []);
  const built = projectLayersOf(resolved, result.masksMissing);
  const keep = trouble.length ? projectFile.pruneTrouble(built, trouble) : built;

  compositeFrame = projectFrameOf(result.doc.project);
  sizeCompositeCanvas();

  resetLaneRows();
  // V3.3. A crop window left open on the old project goes, the way its Cancel
  // would; opening has already asked about unsaved work.
  if (!cropModal.hidden) closeCrop();
  if (!renderModal.hidden) closeRenderCrop();
  // V3.6.2. And a media window, the way its Cancel would.
  closeGenWindow();
  // V3.3. Before anything opens an editor on the new layers.
  adoptViews(result.views);
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
  // V4.0. The last project's playback start means nothing in this one.
  playStartAt = null;
  // Fitted to the opened project rather than left at the last one's zoom,
  // which would be a view of a timeline that is no longer there.
  tlFitted = true;
  syncTimelineView();
  drawTimeline();
  updatePlayhead();

  projectPath = result.path;
  projectTitle = result.name;
  // V3.3. The undo stack the file was saved with, standing on the project as
  // it opened: "a big history of undo-actions" kept in the project. Each step's
  // layers go through the model like the document's, pointed wherever their
  // files were found. With a track left out for a missing file it starts
  // fresh instead, since undo could only bring that track back broken.
  if (trouble.length) {
    undoStack = projectHistory.create(projectState());
  } else {
    const moved = new Map();
    result.doc.layers.forEach((l, i) => {
      if (l.src && resolved[i] && resolved[i].src !== l.src) moved.set(l.src, resolved[i].src);
    });
    undoStack = projectHistory.unpack(result.history, projectState(),
      (l) => timelineModel.createLayer({ ...l, src: moved.get(l.src) || l.src }));
  }


  // The baseline is the project **as the file has it**, tracks in trouble
  // included. So Continue having dropped them in memory reads as unsaved work,
  // which is exactly what it is: the file still references them, and it is
  // never rewritten by opening it. That is what keeps Continue a safe choice.
  //
  // V3.6.1. A restored auto-save is the exception: it is a copy, and what
  // counts as saved is the project file it is a copy of, when that is still
  // there, or nothing at all for a project never saved. So the work the crash
  // would have lost shows as unsaved until it is saved.
  if (result.restored && result.savedDoc) {
    const own = result.savedDoc.project;
    markProjectSaved({
      ...result.savedDoc,
      layers: result.savedDoc.layers.map((l) => timelineModel.createLayer(l)),
      // The frame the way opening that file would set it: its own, with the
      // same fallback rate, or when it has none the one its first picture
      // gives it, which is the one on screen. Measured: a file saved with no
      // frame read as changed even with every step undone.
      project: own.width > 1 && own.height > 1
        ? { width: own.width, height: own.height, fps: own.fps > 0 ? own.fps : COMPOSITE_FALLBACK.fps }
        : (compositeFrame || { width: 0, height: 0, fps: 0 }),
    });
  } else if (result.restored) {
    projectSaved = null;
    updateProjectUi();
  } else {
    markProjectSaved({
      layers: built,
      project: compositeFrame || { width: 0, height: 0, fps: 0 },
      trim: result.doc.trim,
    });
  }
  // Two calls rather than one with a ternary in it, for the reason spelled out
  // over setProjectError: the checker sees a literal and nothing else.
  if (trouble.length) setStatus('Project opened without {n} track(s).', { n: trouble.length });
  else if (maskless.size) setStatus('Project opened. {n} mask picture(s) could not be found, those tracks have no mask.', { n: maskless.size });
  else if (result.restored) setStatus('Project restored from its auto-save.');
  else setStatus('Project opened.');
  return true;
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

/**
 * V4.0. File, New empty project, Ctrl+N: "Opens a new project / clears
 * current layers, if something changed and unsaved, raise a warning popup".
 *
 * The unsaved changes question is the one opening a project asks. What is
 * cleared is what opening would replace: the tracks, the file it came from,
 * its frame, its trim, its undo stack and the editors' views. The clipboard
 * stays, so a clip copied out of the last project can be pasted into the new
 * one.
 */
async function newEmptyProject() {
  if (!timelineDriving() || busy) return false;
  if (!(await confirmDiscard())) return false;
  if (compositePlaying) pauseComposite();
  playUntil = null;
  if (!cropModal.hidden) closeCrop();
  if (!renderModal.hidden) closeRenderCrop();
  closeGenWindow();
  adoptViews(null);
  compositeFrame = null;
  sizeCompositeCanvas();
  resetLaneRows();
  setLayerSelection([], null);
  setLayers([], true);
  trimSpan = 0;
  slider.reset();
  setTrimEnabled(!busy && trimmable());
  refreshSelection(null);
  renderTrimFrames();
  playStartAt = null;
  seekComposite(0);
  tlFitted = true;
  syncTimelineView();
  drawTimeline();
  updatePlayhead();
  projectPath = null;
  projectTitle = '';
  undoStack = projectHistory.create(projectState());
  projectSaved = null;
  updateProjectUi();
  setStatus(IDLE_STATUS);
  updateStatusScale();
  return true;
}

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

/** V4.0. How many steps Undo and Redo each have, for the Edit menu's labels. */
function undoCounts() {
  return { undo: undoStack.past.length, redo: undoStack.future.length };
}

/**
 * Ctrl+Z, and Ctrl+Y or Ctrl+Shift+Z, which is the other spelling of redo that
 * every editor also answers to. The keys are the action table's (actions.js):
 * a popup is its own gesture with its own Cancel, so none of this runs under
 * one, and the URL box and the time and offset fields keep their own native
 * undo, since taking Ctrl+Z off a text box is how someone loses a paste.
 */
function undoRedo(redoing) {
  if (!timelineDriving() || busy) return;
  const next = redoing ? projectHistory.redo(undoStack) : projectHistory.undo(undoStack);
  if (next === undoStack) return;
  // V3.3. A step that would change the track a crop window is open on, or the
  // project frame under Crop Render Frame, asks first.
  const target = next.present;
  const cropHit = !cropModal.hidden && cropLayerId
    && JSON.stringify(timelineModel.layerById(layers, cropLayerId) || null)
      !== JSON.stringify(target.layers.find((l) => l.id === cropLayerId) || null);
  const frameHit = !renderModal.hidden && compositeFrame
    && ((target.width && target.width !== compositeFrame.width)
      || (target.height && target.height !== compositeFrame.height));
  // V3.6.2. And so does one that would change the track a media window is
  // open on. (The mask is the crop window's since 3.6.2, so cropHit has it.)
  const genHits = genWindowLayerIds().filter((genId) => JSON.stringify(timelineModel.layerById(layers, genId) || null)
    !== JSON.stringify(target.layers.find((l) => l.id === genId) || null));
  confirmPopoutConflict([cropHit && cropWindowConflict(), frameHit && renderWindowConflict(),
    ...genHits.map(genWindowConflict)], () => {
    // Asked about one step; if anything moved the stack meanwhile, nothing.
    if ((redoing ? projectHistory.redo(undoStack) : projectHistory.undo(undoStack)).present !== target) return;
    applyHistory(redoing ? projectHistory.redo(undoStack) : projectHistory.undo(undoStack));
  });
}
