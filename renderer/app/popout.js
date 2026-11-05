'use strict';

// ---- V3.3. The crop popups as windows of their own ----
//
// The user, 2026-11-03: the crop editors should open "as a new window instead
// of just a modal so they could get dragged around, even out of the programms
// window / side screens with an X close button", "separately moveable but
// bound to the main window. If you minimize the main window all goes down, if
// you close a single child only that closes". Only the crops: the layer and
// media Crop popup (which is also Edit Keyframe on a video) and Crop Render
// Frame. And "even tho the main window is unusable during a pop-out window, it
// should still update (maybe not live, but at 10 fps to 30 fps rate)".
//
// How: window.open on a blank document, which main.js lets through for these
// names only and makes an owned window of the main one. It runs in this page's
// own process, so the popup's panel is simply moved into it. Every listener,
// canvas and frame the crop code holds keeps working from here, and nothing is
// copied or kept in step across a bridge. The stylesheets are copied in.
//
// The modal itself stays open in the main window, emptied of its panel and
// not shown, so the code that asks whether the popup is open still gets yes.
// The main window stays usable, at the user's word: "The main window (e.g.
// Timeline/playhead mainly) should still be accessible and moveable, else it
// can be hard to compare what changes you've done vs the final preview". What
// would throw a crop window's work away asks first, see confirmPopoutConflict.
// Its X is Cancel, the same as Escape and the popup's own Cancel button.
//
// If the window cannot be opened the popup simply stays a modal, as before.

const POPOUT_FPS = 20;
const popped = new Map();

/** The window an element is in now, the main one or a popped out one. */
function hostWindowOf(node) {
  return (node && node.ownerDocument && node.ownerDocument.defaultView) || window;
}

/** Whether a modal's panel is out in a window of its own. */
function isPoppedOut(modal) {
  return popped.has(modal);
}

/** Bring a popped out modal's window forward. False when it is not popped. */
function focusPopOut(modal) {
  const state = popped.get(modal);
  if (!state) return false;
  try {
    state.win.focus();
  } catch {
    // Gone already; its pagehide is on its way.
  }
  return true;
}

/**
 * Move a shown modal's panel into a window of its own.
 *
 * `name` is the window's name under lwc-pop-, which is also what its place on
 * the screen is remembered by. `cancel()` is what its X does. `relayout()`
 * fits the panel to the window, run as it opens and whenever it is resized.
 * `preview()` runs POPOUT_FPS times a second while it is open, for the main
 * window to show what the popup is doing.
 */
function popOut(modal, name, { title, cancel, relayout, preview }) {
  if (popped.has(modal)) {
    focusPopOut(modal);
    return true;
  }
  const panel = modal.querySelector('.modal__panel');
  if (!panel) return false;
  let win = null;
  try {
    win = window.open('about:blank', 'lwc-pop-' + name);
  } catch {
    win = null;
  }
  if (!win || !win.document) return false;

  const doc = win.document;
  // Standards mode, which a blank document is not until it is told so.
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  doc.close();
  doc.documentElement.lang = document.documentElement.lang;
  doc.title = title || document.title;
  for (const sheet of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = doc.importNode(sheet, true);
    // Absolute, since a blank document has nothing to resolve a relative one by.
    if (copy.tagName === 'LINK') copy.href = sheet.href;
    doc.head.appendChild(copy);
  }
  doc.body.className = 'popout-body';
  doc.body.appendChild(panel);
  modal.classList.add('modal--popped');

  const state = { win, panel, gone: false, timer: 0, settle: [] };
  popped.set(modal, state);

  // Escape in the window cancels that window.
  doc.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') cancel();
  });
  win.addEventListener('resize', () => relayout());
  // The window does not know its size at once, so the fit is done again over
  // its first moments as well as now.
  relayout();
  for (const wait of [0, 60, 200, 500]) state.settle.push(setTimeout(() => {
    if (popped.get(modal) === state) relayout();
  }, wait));
  // Its X. The panel comes home before the window's document goes, and then
  // the popup is cancelled the way its Cancel button would.
  win.addEventListener('pagehide', () => {
    if (state.gone || popped.get(modal) !== state) return;
    state.gone = true;
    cancel();
  });
  if (preview) state.timer = setInterval(preview, Math.round(1000 / POPOUT_FPS));
  win.focus();
  return true;
}

/** Put a popped out modal's panel back and close its window. */
function popIn(modal) {
  const state = popped.get(modal);
  if (!state) return;
  popped.delete(modal);
  clearInterval(state.timer);
  for (const t of state.settle) clearTimeout(t);
  if (state.panel.ownerDocument !== document) modal.appendChild(state.panel);
  modal.classList.remove('modal--popped');
  if (!state.gone) {
    state.gone = true;
    try {
      state.win.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * V3.3. Ask before something in the main window throws away what an open crop
 * window is editing: "if you are trying to delete a track while a
 * crop/keyframe window is open it must show a warning modal ... [Confirm]
 * [Abort]". `conflicts` are the windows it would throw away, each
 * { message, close }. With none, `run` goes ahead at once; otherwise it runs
 * after Confirm, once those windows are closed as their Cancel would, and not
 * at all after Abort. Hands back what run did, or true while it is asking,
 * since the key or the click was taken either way.
 */
function confirmPopoutConflict(conflicts, run) {
  const live = conflicts.filter(Boolean);
  if (!live.length) return run();
  showChoice({
    title: t('Warning'),
    message: live.map((c) => c.message),
    buttons: [
      { id: 'confirm', label: t('Confirm') },
      { id: 'abort', label: t('Abort'), primary: true },
    ],
    cancel: 'abort',
  }).then((choice) => {
    if (choice !== 'confirm') return;
    for (const c of live) c.close();
    run();
  });
  return true;
}

/**
 * The height a popup's stage may take. In the main window it is the share of
 * the window it always was. In a window of its own it is whatever the rest of
 * the panel leaves, the room round the stage included, so a taller window is
 * a taller stage.
 */
function popupStageRoom(panel, stage, share) {
  if (panel.ownerDocument === document) return Math.round(window.innerHeight * share);
  const win = hostWindowOf(panel);
  const other = panel.scrollHeight - stage.offsetHeight;
  return Math.max(120, Math.round(win.innerHeight - other - 6));
}
