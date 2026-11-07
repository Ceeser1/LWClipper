'use strict';

// V4.0. The action table, the one key listener, and the menu bar.
//
// Every shortcut in the main window is an entry here: what it is called, the
// keys that run it, when it can run, and what it runs. The menu bar draws its
// dropdowns from the same entries and the key listener looks presses up in
// them, so a menu entry and its key cannot come to do different things or say
// different keys. They used to be six separate keydown listeners, each with
// its own guards; the guards are kept, one per kind of key (see keyBlocked).
//
// V4.2's Key Binds window changes `keys` and nothing else.
//
// Fields:
//   menu     which dropdown it is in, or null for a key with no entry
//   label    what the entry says, a function so it is read in the language on
//            screen and can carry a count
//   keys     the presses that run it, in keyCombo's form; the first is the one
//            the menu shows
//   shown    shown in place of keys, for one the system handles (Alt+F4)
//   guard    which focused controls keep the key for themselves
//   simple   also runs in simple editing (only some keys; the bar is advanced
//            editing's)
//   repeat   held down, it runs again with the key repeat
//   take     the key is taken from the page even when the action cannot run
//   stop     the press is stopped as well as prevented, for the preview's own
//            media controls, which answer arrows with a seek of their own
//   checked  a tick beside the entry
//   enabled  whether it can run now; a menu entry that cannot is greyed out
//   run      what it does

const ACTIONS = [
  // ---- File ----
  {
    id: 'file.new', menu: 'file', label: () => t('New empty project'), keys: ['Ctrl+N'], take: true,
    enabled: () => !busy, run: () => newEmptyProject(),
  },
  {
    id: 'file.import', menu: 'file', label: () => t('Open/Import local file'), keys: ['Ctrl+I'], take: true,
    enabled: () => !busy, run: () => importLocalFile(),
  },
  {
    id: 'file.download', menu: 'file', label: () => t('Download file'), keys: ['Ctrl+D'], take: true,
    enabled: () => !busy || downloadJob, run: () => openDownloadWindow(),
  },
  { divider: 'file' },
  {
    id: 'file.open', menu: 'file', label: () => t('Open project'), keys: ['Ctrl+O'], take: true,
    enabled: () => !busy, run: () => openProjectFile(),
  },
  {
    // Not held back by a running job: saving writes three kilobytes that touch
    // nothing a render is using (see saveProject).
    id: 'file.save', menu: 'file', label: () => t('Save project'), keys: ['Ctrl+S'], take: true,
    enabled: () => true, run: () => saveProject(false),
  },
  {
    id: 'file.saveAs', menu: 'file', label: () => t('Save project as...'), keys: ['Ctrl+Shift+S'], take: true,
    enabled: () => true, run: () => saveProject(true),
  },
  { divider: 'file' },
  {
    // The system's own key, so it is shown and not listened for. The close it
    // causes asks about unsaved work in main.js, and so does this.
    id: 'file.close', menu: 'file', label: () => t('Close LWClipper'), keys: [], shown: 'Alt+F4',
    enabled: () => true, run: () => window.lwclipper.closeApp(),
  },

  // ---- Edit ----
  {
    id: 'edit.undo', menu: 'edit', keys: ['Ctrl+Z'], guard: 'undo', repeat: true, take: true,
    label: () => (undoCounts().undo === 1
      ? t('Undo (1 step possible)')
      : t('Undo ({n} steps possible)', { n: undoCounts().undo })),
    enabled: () => !busy && undoCounts().undo > 0, run: () => undoRedo(false),
  },
  {
    id: 'edit.redo', menu: 'edit', keys: ['Ctrl+Y', 'Ctrl+Shift+Z'], guard: 'undo', repeat: true, take: true,
    label: () => (undoCounts().redo === 1
      ? t('Redo (1 step possible)')
      : t('Redo ({n} steps possible)', { n: undoCounts().redo })),
    enabled: () => !busy && undoCounts().redo > 0, run: () => undoRedo(true),
  },
  { divider: 'edit' },
  {
    id: 'edit.copy', menu: 'edit', label: () => t('Copy'), keys: ['Ctrl+C'], guard: 'letters',
    enabled: () => !!selectedLayerId, run: () => { copySelected(); closeClipMenu(); },
  },
  {
    id: 'edit.paste', menu: 'edit', label: () => t('Paste'), keys: ['Ctrl+V'], guard: 'letters',
    enabled: () => !busy && !!layerClipboard, run: () => { pasteAtPlayhead(); closeClipMenu(); },
  },
  {
    id: 'edit.cut', menu: 'edit', label: () => t('Cut out'), keys: ['Ctrl+X'], guard: 'letters',
    enabled: () => !busy && !!selectedLayerId, run: () => { cutSelected(); closeClipMenu(); },
  },
  {
    id: 'edit.delete', menu: 'edit', label: () => t('Delete'), keys: ['Del', 'Backspace'], guard: 'letters',
    enabled: () => !busy && !!selectedLayerId, run: () => { deleteSelected(); closeClipMenu(); },
  },
  { divider: 'edit' },
  {
    id: 'edit.selectAll', menu: 'edit', label: () => t('Select all tracks'), keys: ['Ctrl+A'], guard: 'letters', take: true,
    enabled: () => layers.length > 0, run: () => selectAllClips(),
  },
  {
    id: 'edit.split', menu: 'edit', label: () => t('Split selected track'), keys: ['S'], guard: 'letters',
    enabled: () => !busy && !!selectedLayerId, run: () => splitSelected(compositeAt),
  },
  {
    // V4.3 builds it. Listed now so the menu has its final shape.
    id: 'edit.join', menu: 'edit', label: () => t('Join selected tracks'), keys: ['J'], guard: 'letters',
    enabled: () => false, run: () => {},
  },
  {
    id: 'edit.group', menu: 'edit', label: () => t('Group selected tracks'), keys: ['Ctrl+G'], guard: 'letters', take: true,
    enabled: () => !busy && selectionIds().length > 1, run: () => groupSelected(),
  },

  // ---- Playback ----
  {
    id: 'play.toggle', menu: 'playback', label: () => t('Play/Pause playback'), keys: ['Space'], guard: 'space', simple: true,
    enabled: () => playable(), run: () => togglePreview(),
  },
  {
    id: 'play.selection', menu: 'playback', label: () => t('Play selection'), keys: ['P'], guard: 'letters', simple: true,
    enabled: () => !playSelectionBtn.disabled, run: () => playSelection(),
  },
  {
    id: 'play.loop', menu: 'playback', label: () => t('Loop selection'), keys: ['L'], guard: 'letters',
    checked: () => loopSelection,
    enabled: () => true, run: () => { loopSelection = !loopSelection; },
  },
  { divider: 'playback' },
  {
    id: 'play.toStart', menu: 'playback', label: () => t('To playback start'), keys: ['Shift+Left'], guard: 'arrows', stop: true,
    enabled: () => playStartAt !== null, run: () => backToPlayStart(),
  },
  {
    id: 'play.frameBack', menu: 'playback', label: () => t('Frame left'), keys: ['Left'], guard: 'arrows', simple: true, repeat: true, stop: true,
    enabled: () => playable(), run: () => stepFrame(-1),
  },
  {
    id: 'play.frameOn', menu: 'playback', label: () => t('Frame right'), keys: ['Right'], guard: 'arrows', simple: true, repeat: true, stop: true,
    enabled: () => playable(), run: () => stepFrame(1),
  },
  {
    id: 'play.secondBack', menu: 'playback', label: () => t('-1 Second'), keys: ['Down'], guard: 'arrows', simple: true, repeat: true, stop: true,
    enabled: () => playable(), run: () => stepSeconds(-1),
  },
  {
    id: 'play.secondOn', menu: 'playback', label: () => t('+1 Second'), keys: ['Up'], guard: 'arrows', simple: true, repeat: true, stop: true,
    enabled: () => playable(), run: () => stepSeconds(1),
  },

  // ---- View ----
  {
    id: 'view.zoomIn', menu: 'view', label: () => t('Timeline zoom in'), keys: ['Plus'], guard: 'letters', repeat: true,
    enabled: () => timelineDuration() > 0, run: () => zoomTimelineStep(1),
  },
  {
    id: 'view.zoomOut', menu: 'view', label: () => t('Timeline zoom out'), keys: ['Minus'], guard: 'letters', repeat: true,
    enabled: () => timelineDuration() > 0, run: () => zoomTimelineStep(-1),
  },
  {
    id: 'view.fit', menu: 'view', label: () => t('Fit timeline scale'), keys: ['Ctrl+T'], take: true,
    enabled: () => timelineDuration() > 0, run: () => fitTimelineView(),
  },
  { divider: 'view' },
  {
    id: 'view.start', menu: 'view', label: () => t('Timeline start'), keys: ['Home'], guard: 'arrows',
    enabled: () => timelineDuration() > 0, run: () => goTimelineEdge(false),
  },
  {
    id: 'view.end', menu: 'view', label: () => t('Timeline end'), keys: ['End'], guard: 'arrows',
    enabled: () => layers.length > 0, run: () => goTimelineEdge(true),
  },

  // ---- Settings ----
  {
    // V4.1 makes it a window of its own; until then it is the Settings modal
    // the cogwheel opens in simple editing.
    id: 'settings.preferences', menu: 'settings', label: () => t('Preferences'), keys: [],
    enabled: () => true, run: () => openSettings(),
  },
];

// ---- the keys ----

/** Whether there is anything for the transport to play or step through. */
function playable() {
  return timelineDriving() ? timelineDuration() > 0 : !!media;
}

/** The entry a press runs, or null. Built again whenever the keys change. */
let actionByKey = new Map();

function indexActionKeys() {
  actionByKey = new Map();
  for (const action of ACTIONS) {
    for (const combo of action.keys || []) {
      // The first entry to claim a key keeps it; V4.2 is where two entries
      // asking for one key gets asked about.
      if (!actionByKey.has(combo)) actionByKey.set(combo, action);
    }
  }
}
indexActionKeys();

/**
 * Whether the focused control keeps this kind of key for itself. One rule per
 * kind, each the guard its old listener had:
 *   letters  typing (typingInto): a text box, but not a ticked box or a slider,
 *            which have no use for a letter
 *   arrows   any input, select or text area, where the arrows set the value,
 *            and anything editable
 *   space    the same, where Space ticks a box or types a space
 *   undo     the same, so a text box keeps its own Ctrl+Z
 * No guard: the key works wherever the focus is, Ctrl+S in the URL box too.
 */
function keyBlocked(guard, node) {
  if (!guard || !node) return false;
  if (guard === 'letters') return typingInto(node);
  if (node.isContentEditable) return true;
  if (guard === 'arrows') return KEEPS_ARROWS.includes(node.tagName);
  if (guard === 'space') return KEEPS_SPACE.includes(node.tagName);
  if (guard === 'undo') return KEEPS_UNDO.includes(node.tagName);
  return false;
}

// Capture, so the arrows reach this before the preview's media controls do.
document.addEventListener('keydown', (evt) => {
  const combo = keyCombo.fromEvent(evt);
  if (!combo) return;
  if (menuOpen && combo === 'Escape') {
    evt.preventDefault();
    closeMenus();
    return;
  }
  const action = actionByKey.get(combo);
  if (!action) return;
  if (evt.repeat && !action.repeat) return;
  if (modalOpen()) return;
  // V3.8. An editor docked into Start Frame or End Frame keeps its keys, as it
  // would in its window, where the main window's shortcuts never hear them.
  if (evt.target && evt.target.closest && evt.target.closest('.dock-host')) return;
  if (!action.simple && !timelineDriving()) return;
  if (keyBlocked(action.guard, document.activeElement)) return;
  if (!action.enabled()) {
    if (action.take) evt.preventDefault();
    return;
  }
  // Without this a focused button would be pressed as well by Space, and the
  // browser would do its own thing with the rest.
  evt.preventDefault();
  if (action.stop) evt.stopPropagation();
  closeMenus();
  action.run();
}, true);

// ---- the menu bar ----

const menuBar = el('menuBar');
let menuOpen = null;      // { head, drop } of the dropdown that is down

// The names of keys that are words, as t() sees them. Literals, so that
// check-locales.js can find them.
function keyWord(word) {
  const words = {
    Ctrl: t('Ctrl'),
    Shift: t('Shift'),
    Alt: t('Alt'),
    Del: t('Del'),
    Space: t('Space'),
    Home: t('Home'),
    End: t('End'),
  };
  return words[word] || word;
}

function actionKeyText(action) {
  return keyCombo.display(action.shown || (action.keys || [])[0] || '', keyWord);
}

function closeMenus() {
  if (!menuOpen) return;
  menuOpen.head.classList.remove('menu-bar__head--open');
  menuOpen.drop.remove();
  menuOpen = null;
}

/** The dropdown under a heading, built from the table as it is right now. */
function openMenu(head) {
  closeMenus();
  const drop = document.createElement('div');
  drop.className = 'clip-menu menu-drop';
  drop.setAttribute('role', 'menu');
  let lastWasItem = false;
  for (const action of ACTIONS) {
    if (action.divider) {
      if (action.divider === head.dataset.menu && lastWasItem) {
        const line = document.createElement('div');
        line.className = 'menu-drop__divider';
        drop.appendChild(line);
        lastWasItem = false;
      }
      continue;
    }
    if (action.menu !== head.dataset.menu) continue;
    const item = document.createElement('button');
    item.className = 'clip-menu__item menu-drop__item';
    item.setAttribute('role', action.checked ? 'menuitemcheckbox' : 'menuitem');
    item.dataset.action = action.id;
    const tick = document.createElement('span');
    tick.className = 'menu-drop__tick';
    if (action.checked) {
      const on = !!action.checked();
      tick.textContent = on ? '✓' : '';
      item.setAttribute('aria-checked', String(on));
    }
    const label = document.createElement('span');
    label.className = 'menu-drop__label';
    label.textContent = action.label();
    const key = document.createElement('span');
    key.className = 'menu-drop__key';
    key.textContent = actionKeyText(action);
    item.append(tick, label, key);
    // The same gate a key press goes through, so an entry is greyed exactly
    // when its key would do nothing.
    item.disabled = (!action.simple && !timelineDriving()) || !action.enabled();
    item.addEventListener('click', () => {
      closeMenus();
      if (!action.enabled()) return;
      action.run();
    });
    drop.appendChild(item);
    lastWasItem = true;
  }
  document.body.appendChild(drop);
  const r = head.getBoundingClientRect();
  const w = drop.offsetWidth;
  drop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - w - 4)) + 'px';
  drop.style.top = (r.bottom + 2) + 'px';
  head.classList.add('menu-bar__head--open');
  menuOpen = { head, drop };
}

for (const head of menuBar.querySelectorAll('.menu-bar__head')) {
  // On the press, so a press on an open heading can close it, and a press and
  // drag into the dropdown is how a menu has always been worked as well.
  head.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0) return;
    evt.preventDefault();
    if (menuOpen && menuOpen.head === head) closeMenus();
    else openMenu(head);
  });
  // With one dropdown down, the pointer moving onto another heading opens that
  // one instead, the way every menu bar behaves.
  head.addEventListener('pointerenter', () => {
    if (menuOpen && menuOpen.head !== head) openMenu(head);
  });
  // A heading is worked by its press; the click that follows does nothing more.
  // Enter and Space on a focused heading arrive as a click with no press.
  head.addEventListener('click', (evt) => {
    if (evt.detail !== 0) return;
    if (menuOpen && menuOpen.head === head) closeMenus();
    else openMenu(head);
  });
}

// A press anywhere outside the bar and its dropdown puts it away.
document.addEventListener('pointerdown', (evt) => {
  if (!menuOpen) return;
  if (menuOpen.drop.contains(evt.target) || menuBar.contains(evt.target)) return;
  closeMenus();
}, true);
window.addEventListener('blur', closeMenus);
window.addEventListener('resize', closeMenus);
