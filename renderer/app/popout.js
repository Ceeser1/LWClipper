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

/** Whether a modal's panel is out in a window of its own, or V3.8 docked. */
function isPoppedOut(modal) {
  return popped.has(modal) || docked.has(modal);
}

/**
 * Bring a popped out modal's window forward. False when it is not popped.
 * V3.8: a docked one is in the main window already, and is there to be seen.
 */
function focusPopOut(modal) {
  if (docked.has(modal)) return true;
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
 *
 * V3.8. Docked in Start Frame or End Frame instead, when that is where this
 * window was last, unless `asWindow`: the agreed "an editor opens where it was
 * last, docked or as a window".
 */
function popOut(modal, name, opts, asWindow = false) {
  const { title, cancel, relayout, preview } = opts;
  if (popped.has(modal)) {
    focusPopOut(modal);
    return true;
  }
  if (docked.has(modal)) return true;
  const panel = modal.querySelector('.modal__panel');
  if (!panel) return false;
  const last = asWindow ? null : dockedLast(name);
  if (last && dockInto(modal, name, opts, last, panel)) return true;
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

  // V3.7.1. `want` is the height its content last asked for, `fitted` the
  // one the window was last given, see fitPopOut.
  // V3.8. `opts` too, for docking it and popping it out again.
  const state = { win, panel, name, opts, gone: false, timer: 0, settle: [], want: 0, fitted: 0, fitUntil: 0 };
  popped.set(modal, state);

  // Escape in the window cancels that window, or V3.6.2 the dialog carried
  // over it, the colour picker or Outline or Shadow, when one is open.
  doc.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Escape') return;
    const over = topPopupIn(doc);
    if (over) over.cancel();
    else cancel();
  });
  // V3.7.1. A resize by hand only lays it out again: the height is fitted as
  // it opens and when what it holds changes, never against the user's own.
  // The resize a fit itself makes is measured again and fitted once more,
  // since what the content wants was measured with the window too short for
  // it, and so with a scrollbar taking its width.
  win.addEventListener('resize', () => {
    relayout();
    if (Date.now() < state.fitUntil) fitPopOut(modal);
  });
  // The window does not know its size at once, so the fit is done again over
  // its first moments as well as now.
  relayout();
  fitPopOut(modal);
  for (const wait of [0, 60, 200, 500]) state.settle.push(setTimeout(() => {
    if (popped.get(modal) !== state) return;
    relayout();
    fitPopOut(modal);
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

/** Put a popped out modal's panel back and close its window. V3.8: or docked. */
function popIn(modal) {
  if (docked.has(modal)) {
    undock(modal);
    return;
  }
  const state = popped.get(modal);
  if (!state) return;
  leavePopWindow(modal, state);
  if (state.panel.ownerDocument !== document) modal.appendChild(state.panel);
  modal.classList.remove('modal--popped');
  closePopWindow(state);
}

/**
 * A popped out modal no longer its window's: its ticks stopped, and anything
 * carried over it home first, V3.6.2, or it would go with the window's
 * document. The panel is still in there for the caller to move.
 */
function leavePopWindow(modal, state) {
  popped.delete(modal);
  clearInterval(state.timer);
  for (const timer of state.settle) clearTimeout(timer);
  for (const sub of [...carried.keys()]) {
    if (sub.ownerDocument === state.win.document) carryBack(sub);
  }
}

function closePopWindow(state) {
  if (state.gone) return;
  state.gone = true;
  try {
    state.win.close();
  } catch {
    // Already closed.
  }
}

// ---- V3.6.2. Dialogs carried over a popped out window ----
//
// The media windows open dialogs of their own over themselves: the colour
// picker, and Outline and Shadow over Edit Text. Those live in the main
// window's document, where a popped out media window cannot show them, so
// while one is open it is moved into that window, over its panel, and moved
// back as it closes: the same move popOut makes with a panel, so every
// listener on it goes on working.

const carried = new Map();

/** `sub` into the window `modal` is popped out in, if it is. */
function carryOver(sub, modal) {
  // V3.8.2. Several windows can be out, so one dialog asked for over another
  // window comes home first rather than taking this one for its home.
  carryBack(sub);
  const state = modal && popped.get(modal);
  if (!state || state.gone || sub.ownerDocument === state.win.document) return;
  carried.set(sub, { parent: sub.parentNode, next: sub.nextSibling });
  state.win.document.body.appendChild(sub);
}

/** `sub` back where it came from, if it was carried. */
function carryBack(sub) {
  const home = carried.get(sub);
  if (!home) return;
  carried.delete(sub);
  if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(sub, home.next);
  else home.parent.appendChild(sub);
}

/** The highest popup open in another window's document, or null. */
function topPopupIn(doc) {
  let top = null;
  for (const p of popups) {
    if (p.modal.hidden || p.modal.ownerDocument !== doc) continue;
    if (!top || p.layer > top.layer) top = p;
  }
  return top;
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
    message: [...new Set(live.map((c) => c.message))],
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

/** V3.7.2. The window `panel` is popped out in, or null. */
function poppedStateOf(panel) {
  for (const state of popped.values()) {
    if (state.panel === panel && !state.gone) return state;
  }
  return null;
}

/** V3.8. Where `panel` is docked, or null. */
function dockedStateOf(panel) {
  for (const state of docked.values()) {
    if (state.panel === panel) return state;
  }
  return null;
}

/** V3.8. Whether `panel` is out of its modal: in a window, or docked. */
function popupFree(panel) {
  return !!poppedStateOf(panel) || !!dockedStateOf(panel);
}

/**
 * V3.7.2. The width a popup's stage is sized from: the panel's, or out in a
 * window of its own the window's, whether a scrollbar is up in it or not. A
 * stage that gave the scrollbar its width would be shorter for it, which can
 * take the scrollbar away again, which widens it, and round.
 */
function popupWidth(panel) {
  const state = poppedStateOf(panel);
  if (state) return state.win.innerWidth;
  // V3.8. Docked, the cell's: its scrollbar's room is always kept, so it is
  // the same width whether one is up or not.
  const dock = dockedStateOf(panel);
  return dock ? dock.body.clientWidth : panel.clientWidth;
}

/**
 * The height a popup's stage may take. In the main window it is the share of
 * the window it always was. V3.7.1: `full` is the height the stage has at the
 * window's width, which with the rest of the panel is what the window is
 * fitted to. V3.7.2, the user: "Let the windows be vertical scrollable if
 * their size doesnt fit instead of shrinking its contents width". Out in its
 * own window the stage is as tall as its width makes it, and a window too
 * short for that scrolls. A dialog carried over it, Outline or Shadow, is
 * still held to the window's height, being a pop-up of its own.
 */
function popupStageRoom(panel, stage, share, full) {
  // V3.8. Docked, as a window of its own: the cell scrolls.
  if (dockedStateOf(panel)) return Infinity;
  if (panel.ownerDocument === document) return Math.round(window.innerHeight * share);
  const win = hostWindowOf(panel);
  const other = panel.scrollHeight - stage.offsetHeight;
  if (poppedStateOf(panel)) {
    if (full) notePopoutWant(panel, other + full);
    return Infinity;
  }
  return Math.max(120, Math.round(win.innerHeight - other - 6));
}

// ---- V3.7.1. Each window as tall as what it holds ----
//
// The user: "Open each window as its required max height so that the full 90%
// of the window default width gets used for the preview and all elements fit
// in vertically without scrolling". The stages are 16:9 at 90% of the width
// unless the height left cuts them down, so the window is given the height
// at which nothing does: the rest of the panel plus the stage at its width.

/** The height the panel's content wants, the stage at its width included. */
function notePopoutWant(panel, height) {
  for (const state of popped.values()) {
    if (state.panel === panel) state.want = Math.round(height + 6);
  }
}

/**
 * A popped out window given the height its content last asked for, as it
 * opens and when what it shows changes: a gradient's controls coming up,
 * for one. The screen it is on holds it, which main.js sees to.
 */
function fitPopOut(modal) {
  const state = popped.get(modal);
  if (!state || state.gone || !state.want || state.want === state.fitted) return;
  state.fitted = state.want;
  state.fitUntil = Date.now() + 1000;
  if (window.lwclipper && window.lwclipper.fitPopout) window.lwclipper.fitPopout(state.name, state.want);
}

// ---- V3.8. An editor docked into Start Frame or End Frame ----
//
// The user: "Let any window snap into or on top of 'Start Frame' or 'End
// Frame', hiding the frames and show the window instead with the title of the
// window above instead of e.g. 'Start Frame', a 'pop-out' button (arrow
// diagonal to the top right) which creates the window again a red 'X' button
// to close the window and restore the start/end frame preview." And: "While
// dragging a window and moving the cursor over the Start/End Frame preview let
// it glow like layers when hovering a file over it", then "When dragging a
// window, highlight the Start/End Frames right away, not only when hovering
// it". Agreed with them as well: an editor opens where it was last, docked or
// as a window.
//
// Docked, the panel is moved into the cell the way popOut moves it into a
// window, so every listener and canvas it has goes on working. The cell's own
// frame is only hidden under it, so nothing else in the main window moves.
// The modal stays open and emptied, as it does for a window, which is what
// keeps every "is the editor open" question answering yes.

const docked = new Map();
const DOCK_CELLS = ['start', 'end'];
// A drag whose end never came is let go of after this long without a step.
const DOCK_GLOW_HOLD = 2500;
let dockGlowTimer = 0;

/** The Start Frame or End Frame cell, or null while the preview shows none. */
function dockCell(where) {
  if (typeof previewGrid === 'undefined' || previewSection.dataset.audio === 'true') return null;
  const cells = previewGrid.querySelectorAll(':scope > .preview-cell');
  if (cells.length < 3) return null;
  const cell = where === 'start' ? cells[0] : where === 'end' ? cells[cells.length - 1] : null;
  if (!cell) return null;
  const box = cell.getBoundingClientRect();
  return box.width > 40 && box.height > 40 ? cell : null;
}

/** The cell a point in the main window's own pixels is over, or null. */
function dockCellAt(x, y) {
  for (const where of DOCK_CELLS) {
    const cell = dockCell(where);
    if (!cell || cell.classList.contains('preview-cell--docked')) continue;
    const b = cell.getBoundingClientRect();
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return where;
  }
  return null;
}

/** Where the window `name` was docked last, or null for a window. */
function dockedLast(name) {
  const all = (typeof appSettings === 'object' && appSettings && appSettings.popoutDock) || {};
  // V3.8.2. The one name the three media windows had before they got their own.
  const kept = all[name] || (/^(bar|shape|text)$/.test(name) ? all.media : null);
  return DOCK_CELLS.includes(kept) ? kept : null;
}

function rememberDock(name, where) {
  if (typeof appSettings !== 'object' || !appSettings) return;
  const next = { ...(appSettings.popoutDock || {}) };
  // V3.8.2. Its own entry now, the old shared one having done its part.
  if (/^(bar|shape|text)$/.test(name)) delete next.media;
  if (where) next[name] = where;
  else delete next[name];
  if (JSON.stringify(next) === JSON.stringify(appSettings.popoutDock || {})) return;
  appSettings.popoutDock = next;
  if (window.lwclipper && window.lwclipper.setSettings) window.lwclipper.setSettings({ popoutDock: next });
}

const DOCK_OUT_ICON = '<svg viewBox="0 0 12 12"><path d="M3 9L9 3M4.5 3H9V7.5" /></svg>';
const DOCK_CLOSE_ICON = '<svg viewBox="0 0 12 12"><path d="M3 3L9 9M9 3L3 9" /></svg>';

/**
 * `panel` into the cell `where`, out of its modal: its title over it in the
 * cell's title's place with its Info, a pop-out button and a red X, which is
 * the window's Cancel. False when the cell is not there to be had.
 */
function dockInto(modal, name, opts, where, panel) {
  const cell = dockCell(where);
  // V3.8.2. One window to a frame: the user, "Let Start Frame and End Frame
  // have different settings windows docked". One whose frame is taken opens
  // as a window of its own.
  if (!cell || cell.classList.contains('preview-cell--docked')) return false;
  const host = document.createElement('div');
  host.className = 'dock-host';
  const head = document.createElement('div');
  head.className = 'dock-head';
  const title = document.createElement('div');
  title.className = 'dock-head__title';
  title.dataset.noTranslate = '';
  title.textContent = opts.title || '';
  const out = document.createElement('button');
  out.className = 'dock-btn';
  out.dataset.noTranslate = '';
  out.innerHTML = DOCK_OUT_ICON;
  out.title = t('Pop Out');
  const shut = document.createElement('button');
  shut.className = 'dock-btn dock-btn--close';
  shut.dataset.noTranslate = '';
  shut.innerHTML = DOCK_CLOSE_ICON;
  shut.title = t('Close');
  // V3.8.2. The user: "Re-center the title text horizontal for docked
  // windows, the buttons shift it to the left". The buttons are in a group on
  // the right, and an unseen copy of them stands on the left, so the title
  // between has the same room either side and is centred on the cell.
  const tools = document.createElement('div');
  tools.className = 'dock-head__tools';
  tools.append(out, shut);
  const lead = document.createElement('div');
  lead.className = 'dock-head__tools dock-head__lead';
  lead.setAttribute('aria-hidden', 'true');
  head.append(lead, title, tools);
  const body = document.createElement('div');
  body.className = 'dock-body';
  host.append(head, body);
  cell.appendChild(host);
  cell.classList.add('preview-cell--docked');
  body.appendChild(panel);
  modal.classList.add('modal--popped');
  // The Info button into the title row, the panel's own title being the row.
  const info = panel.querySelector(':scope > .info-tip');
  if (info) tools.insertBefore(info, out);
  for (const tool of tools.children) {
    const copy = tool.classList.contains('info-tip')
      ? Object.assign(document.createElement('div'), { className: 'info-tip' })
      : tool.cloneNode(true);
    if (tool.classList.contains('info-tip')) copy.appendChild(tool.querySelector('.info-tip__btn').cloneNode(true));
    lead.appendChild(copy);
  }
  const state = { cell, host, body, panel, name, opts, where, info, timer: 0, settle: [], ro: null };
  docked.set(modal, state);
  out.addEventListener('click', () => popOutAgain(modal));
  shut.addEventListener('click', () => opts.cancel());
  // A key pressed in it stays in it, as it would in its window, where the
  // main window's shortcuts never hear it: S would split, Delete delete and
  // Ctrl+Z undo on the timeline. Escape cancels it, as in its window. The
  // arrows, which the main window takes before anything else does, look
  // for it themselves (editing.js).
  host.addEventListener('keydown', (evt) => {
    evt.stopPropagation();
    if (evt.key !== 'Escape' || docked.get(modal) !== state) return;
    opts.cancel();
  });
  state.ro = new ResizeObserver(() => {
    if (docked.get(modal) === state) opts.relayout();
  });
  state.ro.observe(body);
  opts.relayout();
  for (const wait of [0, 60, 200]) state.settle.push(setTimeout(() => {
    if (docked.get(modal) === state) opts.relayout();
  }, wait));
  if (opts.preview) state.timer = setInterval(opts.preview, Math.round(1000 / POPOUT_FPS));
  rememberDock(name, where);
  return true;
}

/** A docked panel back in its modal, and its cell's frame back. */
function undock(modal) {
  const state = docked.get(modal);
  if (!state) return;
  docked.delete(modal);
  clearInterval(state.timer);
  for (const timer of state.settle) clearTimeout(timer);
  if (state.ro) state.ro.disconnect();
  if (state.info) {
    const heading = state.panel.querySelector(':scope > .modal__title');
    state.panel.insertBefore(state.info, heading ? heading.nextSibling : state.panel.firstChild);
  }
  modal.appendChild(state.panel);
  state.host.remove();
  state.cell.classList.remove('preview-cell--docked');
  modal.classList.remove('modal--popped');
}

/** The pop-out button: the window made again, where it was before it docked. */
function popOutAgain(modal) {
  const state = docked.get(modal);
  if (!state) return;
  undock(modal);
  rememberDock(state.name, null);
  // No window to be had leaves it the modal it has always fallen back to.
  popOut(modal, state.name, state.opts, true);
}

/** A popped out window let go of over a cell: its panel into that cell. */
function dockPopOut(modal, where) {
  const state = popped.get(modal);
  if (!state || state.gone || !dockCell(where)) return false;
  leavePopWindow(modal, state);
  if (!dockInto(modal, state.name, state.opts, where, state.panel)) {
    modal.appendChild(state.panel);
    modal.classList.remove('modal--popped');
  }
  // Told first, so the window is remembered where it was before the drag
  // rather than over the frame it was dropped on.
  const told = window.lwclipper && window.lwclipper.popoutDocked
    ? Promise.resolve(window.lwclipper.popoutDocked(state.name)).catch(() => {})
    : Promise.resolve();
  told.then(() => closePopWindow(state));
  return true;
}

/**
 * V4.1. The panels out in windows of their own put into the language just
 * chosen: translateDom walks the main document, which they are no longer in.
 */
function translatePopped(wasShowing) {
  for (const state of popped.values()) {
    if (!state.gone) translateDom(state.panel, wasShowing);
  }
  for (const sub of carried.keys()) translateDom(sub, wasShowing);
}

/** The popped out modal whose window is `name`, or null. */
function poppedNamed(name) {
  for (const [modal, state] of popped) {
    if (state.name === name && !state.gone) return modal;
  }
  return null;
}

/**
 * Both cells lit while a window is dragged, the one under the pointer more,
 * in the green a timeline row takes for a file held over it.
 */
function paintDockTargets(on, over) {
  if (typeof previewGrid === 'undefined') return;
  const cells = previewGrid.querySelectorAll(':scope > .preview-cell');
  const ends = cells.length >= 3 ? [cells[0], cells[cells.length - 1]] : [];
  ends.forEach((cell, i) => {
    const where = DOCK_CELLS[i];
    const can = on && !!dockCell(where) && !cell.classList.contains('preview-cell--docked');
    cell.classList.toggle('preview-cell--dock-target', can);
    cell.classList.toggle('preview-cell--dock-over', can && over === where);
  });
}

if (window.lwclipper && window.lwclipper.onPopoutDrag) {
  // V4.1. A window that is a list rather than an editor (Preferences, Key
  // Binds) says noDock, and is never offered a frame.
  const dockable = (modal) => !!modal && !(popped.get(modal).opts || {}).noDock;
  window.lwclipper.onPopoutDrag(({ name, x, y }) => {
    if (!dockable(poppedNamed(name))) return;
    paintDockTargets(true, dockCellAt(x, y));
    clearTimeout(dockGlowTimer);
    dockGlowTimer = setTimeout(() => paintDockTargets(false, null), DOCK_GLOW_HOLD);
  });
  window.lwclipper.onPopoutDrop(({ name, x, y }) => {
    clearTimeout(dockGlowTimer);
    paintDockTargets(false, null);
    const modal = poppedNamed(name);
    const where = dockable(modal) ? dockCellAt(x, y) : null;
    if (where) dockPopOut(modal, where);
  });
}
