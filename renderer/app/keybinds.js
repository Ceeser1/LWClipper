'use strict';

// V4.2. Settings, Key Binds.
//
// The user: "Opens a "Keybinds" window where all key binds are displayed and
// changeable, sorted by menu category 1-3 as header, each keybind is a
// textbox, click one to edit - They only register key presses e.g. Shift+E in
// that order or Crtl+Shift+I, no mouse clicks or enter, a mouse click
// somewhere outside the editbox and pressing enter finishes editing that box".
// Agreed with them: Escape cancels the box, a key another entry holds is
// named and not taken, and each row and the whole list can be reset.
//
// A window of its own the way Preferences is (popout.js), so the menu bar can
// be looked at beside it. What it changes is each action's `keys` in the
// action table and nothing else, so the menu and the key listener follow at
// once. Saved in the settings, only what differs from the defaults
// (src/keyBinds.js has the rules and their tests).

const keysModal = el('keysModal');
const keysList = el('keysList');
const keysResetAllBtn = el('keysResetAllBtn');
const keysCloseBtn = el('keysCloseBtn');
const keysPanel = keysModal.querySelector('.modal__panel');

// The headings, in the menu bar's order. Export is a button of its own on the
// bar and is listed with File, whose kind of entry it is.
const KEY_SECTIONS = [
  ['file', () => t('File')],
  ['edit', () => t('Edit')],
  ['playback', () => t('Playback')],
  ['view', () => t('View')],
];

// Each entry's keys as the table was written, before anything was bound.
for (const action of ACTIONS) {
  if (!action.divider) action.defaults = (action.keys || []).slice();
}

/** An entry whose key can be changed: not Close (the system's Alt+F4), not Settings. */
function isBindable(action) {
  if (action.divider || action.shown || action.flyout) return false;
  return action.id === 'file.export' || KEY_SECTIONS.some(([menu]) => menu === action.menu);
}

function bindableActions() {
  return ACTIONS.filter(isBindable);
}

function keyMap(field) {
  const out = {};
  for (const action of bindableActions()) out[action.id] = (action[field] || []).slice();
  return out;
}

/** The saved binds put into the table. Run whenever the settings arrive. */
function applyKeyBinds(saved) {
  const defaults = keyMap('defaults');
  const resolved = keyBinds.resolve(defaults, keyBinds.sanitize(saved, Object.keys(defaults)));
  for (const action of bindableActions()) action.keys = resolved[action.id];
  indexActionKeys();
  if (!keysModal.hidden) drawKeyBinds();
}

async function saveKeyBinds() {
  indexActionKeys();
  const changed = keyBinds.changes(keyMap('defaults'), keyMap('keys'));
  const payload = Object.keys(changed).length ? changed : null;
  appSettings = (await window.lwclipper.setSettings({ keyBinds: payload })).settings;
}

function keysText(keys) {
  return (keys || []).map((k) => keyCombo.display(k, keyWord)).join(', ');
}

function sameKeys(a, b) {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

// ---- the box being edited ----

let keyEdit = null;       // { action, box, note, pending }

function startKeyEdit(action, box, note) {
  if (keyEdit && keyEdit.box === box) return;
  endKeyEdit(false);
  keyEdit = { action, box, note, pending: null };
  box.classList.add('keys-box--editing');
  box.value = '';
  box.placeholder = t('Press the keys...');
  note.textContent = '';
}

/** The box left: what was pressed kept when `keep`, else put back. */
function endKeyEdit(keep) {
  if (!keyEdit) return;
  const { action, box, note, pending } = keyEdit;
  keyEdit = null;
  box.classList.remove('keys-box--editing');
  box.placeholder = '';
  if (keep && pending && !sameKeys([pending], action.keys || [])) {
    const holder = keyBinds.holder(keyMap('keys'), action.id, pending);
    if (holder) {
      const other = ACTIONS.find((a) => a.id === holder);
      note.textContent = t('{key} is already used by "{action}".', {
        key: keyCombo.display(pending, keyWord),
        action: other ? (other.keyLabel || other.label)() : holder,
      });
    } else {
      action.keys = [pending];
      saveKeyBinds();
    }
  }
  box.value = keysText(action.keys);
  drawResetStates();
}

function onKeyBoxDown(evt) {
  if (!keyEdit || keyEdit.box !== evt.currentTarget) return;
  // Nothing a press in here does may reach the window behind it: not the
  // timeline's keys, not Escape closing the window.
  evt.preventDefault();
  evt.stopPropagation();
  const bare = !evt.ctrlKey && !evt.metaKey && !evt.shiftKey && !evt.altKey;
  if (bare && evt.key === 'Escape') {
    endKeyEdit(false);
    keyEdit = null;
    evt.currentTarget.blur();
    return;
  }
  if (bare && evt.key === 'Enter') {
    const box = evt.currentTarget;
    endKeyEdit(true);
    box.blur();
    return;
  }
  if (evt.repeat) return;
  const combo = keyCombo.fromEvent(evt);
  if (!combo) {
    // Only modifiers so far: shown as they are held, in the order they keep.
    const held = [];
    if (evt.ctrlKey || evt.metaKey) held.push(keyWord('Ctrl'));
    if (evt.shiftKey) held.push(keyWord('Shift'));
    if (evt.altKey) held.push(keyWord('Alt'));
    keyEdit.box.value = held.length ? held.join('+') + '+' : '';
    return;
  }
  keyEdit.pending = combo;
  keyEdit.box.value = keyCombo.display(combo, keyWord);
  keyEdit.note.textContent = '';
}

function onKeyBoxUp(evt) {
  if (!keyEdit || keyEdit.box !== evt.currentTarget) return;
  evt.stopPropagation();
  // Modifiers let go of without a key: back to what was pressed last.
  if (!keyEdit.pending && !evt.ctrlKey && !evt.shiftKey && !evt.altKey) keyEdit.box.value = '';
  else if (keyEdit.pending) keyEdit.box.value = keyCombo.display(keyEdit.pending, keyWord);
}

// ---- the window ----

const keyRows = new Map();    // action id -> { box, reset, note }

function drawKeyBinds() {
  endKeyEdit(false);
  keyRows.clear();
  keysList.replaceChildren();
  for (const [menu, heading] of KEY_SECTIONS) {
    const actions = bindableActions().filter((a) => (a.menu || 'file') === menu);
    if (!actions.length) continue;
    const head = document.createElement('div');
    head.className = 'modal__section keys-section';
    head.textContent = heading();
    keysList.appendChild(head);
    for (const action of actions) {
      const row = document.createElement('div');
      row.className = 'keys-row';
      const label = document.createElement('span');
      label.className = 'keys-row__label';
      label.dataset.noTranslate = '';
      label.textContent = (action.keyLabel || action.label)();
      const box = document.createElement('input');
      box.type = 'text';
      box.readOnly = true;
      box.className = 'keys-box';
      box.dataset.action = action.id;
      box.dataset.noTranslate = '';
      box.value = keysText(action.keys);
      const reset = document.createElement('button');
      reset.className = 'keys-reset';
      reset.dataset.noTranslate = '';
      reset.textContent = '↺';
      reset.title = t('Reset');
      const note = document.createElement('div');
      note.className = 'keys-row__note';
      note.dataset.noTranslate = '';
      box.addEventListener('focus', () => startKeyEdit(action, box, note));
      box.addEventListener('blur', () => {
        if (keyEdit && keyEdit.box === box) endKeyEdit(true);
      });
      box.addEventListener('keydown', onKeyBoxDown);
      box.addEventListener('keyup', onKeyBoxUp);
      reset.addEventListener('click', () => resetKeyRow(action, note));
      row.append(label, box, reset, note);
      keysList.appendChild(row);
      keyRows.set(action.id, { box, reset, note });
    }
  }
  drawResetStates();
}

function drawResetStates() {
  let any = false;
  for (const action of bindableActions()) {
    const row = keyRows.get(action.id);
    const changed = !sameKeys(action.keys || [], action.defaults || []);
    if (changed) any = true;
    if (row) row.reset.disabled = !changed;
  }
  keysResetAllBtn.disabled = !any;
}

/** One row back to its default, unless another entry holds that key now. */
function resetKeyRow(action, note) {
  endKeyEdit(false);
  const now = keyMap('keys');
  for (const k of action.defaults) {
    const holder = keyBinds.holder(now, action.id, k);
    if (!holder) continue;
    const other = ACTIONS.find((a) => a.id === holder);
    note.textContent = t('{key} is already used by "{action}".', {
      key: keyCombo.display(k, keyWord),
      action: other ? (other.keyLabel || other.label)() : holder,
    });
    return;
  }
  action.keys = action.defaults.slice();
  note.textContent = '';
  const row = keyRows.get(action.id);
  if (row) row.box.value = keysText(action.keys);
  drawResetStates();
  saveKeyBinds();
}

async function resetAllKeys() {
  endKeyEdit(false);
  for (const action of bindableActions()) action.keys = action.defaults.slice();
  await saveKeyBinds();
  drawKeyBinds();
}

function openKeyBinds() {
  if (isPoppedOut(keysModal)) {
    focusPopOut(keysModal);
    return;
  }
  drawKeyBinds();
  keysModal.hidden = false;
  popOut(keysModal, 'keys', {
    title: t('Key Binds'),
    cancel: closeKeyBinds,
    noDock: true,
    relayout: () => {
      if (keysPanel.ownerDocument !== document) notePopoutWant(keysPanel, keysPanel.scrollHeight);
      fitPopOut(keysModal);
    },
  }, true);
}

function closeKeyBinds() {
  endKeyEdit(false);
  popIn(keysModal);
  keysModal.hidden = true;
}

keysResetAllBtn.addEventListener('click', () => resetAllKeys());
keysCloseBtn.addEventListener('click', closeKeyBinds);
bindPopup(keysModal, closeKeyBinds);

// The settings may have arrived before this file was read.
if (typeof appSettings === 'object' && appSettings) applyKeyBinds(appSettings.keyBinds);
