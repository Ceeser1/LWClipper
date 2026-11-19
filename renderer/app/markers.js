'use strict';

// V5.5. Timeline markers in the window: the project's list, the flags that
// stand for it on the ruler, and the keys and the menu that change it.
//
// What a marker is and what each gesture makes of the list is src/markers.js;
// this draws it and listens. A marker is a flag in the ruler with a line down
// through the tracks: M sets one at the playhead (and takes it away again on
// its frame), a click on a flag moves the playhead there, a double click
// names it, a right click offers Rename and Delete. Clips, trimmed edges and
// fades catch on markers as they do on each other (clips.js snapLines).
//
// The list is part of the project file, of unsaved work and of every undo
// step: setting, naming or deleting a marker is a step of its own, and a
// step that moved markers (closing a gap) puts them back when it is undone.
// A step saved in a project from before 5.5 has no list and leaves the
// markers as they are (history.js).

/** The project's markers, sorted by time: [{ id, t, name }]. */
let projectMarkers = [];

const timelineFlags = document.createElement('div');
timelineFlags.className = 'timeline-flags';
// Before the playhead in the lane, so the playhead is drawn over a marker it stands on.
timelineLane.insertBefore(timelineFlags, timelinePlayStart);

function newMarkerId() {
  let id;
  do {
    id = 'k' + Math.random().toString(36).slice(2, 10);
  } while (projectMarkers.some((m) => m.id === id));
  return id;
}

/** Half a frame: within that of a marker, the playhead is on it. */
function markerReach() {
  return 0.5 / playheadFps();
}

/**
 * The list replaced and redrawn, and one undo step taken for it. `step`
 * false is for a change that is part of a bigger gesture, which takes the
 * step itself once everything of it is in place.
 */
function setProjectMarkers(next, step = true) {
  if (next === projectMarkers) return;
  projectMarkers = timelineMarkers.markersOf(next);
  renderProjectMarkers();
  if (step) commitHistory();
  if (typeof updateProjectUi === 'function') updateProjectUi();
  if (typeof refreshMenuBar === 'function') refreshMenuBar();
}

/** A project opened or begun: its markers, with nothing counted as changed. */
function loadProjectMarkers(source) {
  projectMarkers = timelineMarkers.markersOf(source);
  renderProjectMarkers();
}

function markerLabel(m) {
  return m.name || timelineView.tickLabel(m.t, 0.01, Math.max(m.t, 60));
}

/** The flags rebuilt from the list. Cheap: a project has a handful. */
function renderProjectMarkers() {
  closeMarkerRename();
  timelineFlags.replaceChildren();
  for (const m of projectMarkers) {
    const flag = document.createElement('div');
    flag.className = 'timeline-flag';
    flag.dataset.markerId = m.id;
    const head = document.createElement('button');
    head.className = 'timeline-flag__head';
    head.dataset.noTranslate = '';
    head.title = markerLabel(m);
    if (m.name) {
      const name = document.createElement('span');
      name.className = 'timeline-flag__name';
      name.textContent = m.name;
      head.appendChild(name);
    }
    // A press on a flag is the flag's: it must not also start a drag of the
    // ruler under it, or scrub the playhead away from where the click put it.
    head.addEventListener('pointerdown', (evt) => evt.stopPropagation());
    head.addEventListener('click', (evt) => {
      evt.stopPropagation();
      goToMarker(m.id);
    });
    head.addEventListener('dblclick', (evt) => {
      evt.stopPropagation();
      renameMarker(m.id);
    });
    head.addEventListener('contextmenu', (evt) => openMarkerMenu(evt, m.id));
    flag.appendChild(head);
    timelineFlags.appendChild(flag);
  }
  positionProjectMarkers();
}

/** Each flag put where its moment is in the view; one scrolled out of it is hidden. */
function positionProjectMarkers() {
  const show = timelineDriving() && timelineLane.clientWidth > 0;
  const width = timelineLane.clientWidth;
  for (const flag of timelineFlags.children) {
    const m = projectMarkers.find((x) => x.id === flag.dataset.markerId);
    const x = m ? timelineView.timeToX(tlView, m.t) : -1;
    flag.hidden = !show || !m || x < -1 || x > width + 1;
    if (!flag.hidden) flag.style.left = x + 'px';
  }
}

/** The element that stands for a marker, for the snap highlight. */
function markerElement(id) {
  return timelineFlags.querySelector('.timeline-flag[data-marker-id="' + id + '"]');
}

function seekToTime(t) {
  seekComposite(t);
  revealTime(compositeAt, 'left');
  updatePlayhead();
}

function goToMarker(id) {
  const m = projectMarkers.find((x) => x.id === id);
  if (!m || !timelineDriving()) return false;
  if (compositePlaying) pauseComposite();
  seekToTime(m.t);
  return true;
}

/** M: a marker at the playhead, or the one on this frame taken away. */
function toggleMarkerAtPlayhead() {
  if (!timelineDriving() || busy) return false;
  const before = projectMarkers;
  setProjectMarkers(timelineMarkers.toggle(projectMarkers, compositeAt, newMarkerId(), markerReach()));
  return projectMarkers !== before;
}

function deleteMarker(id) {
  setProjectMarkers(timelineMarkers.remove(projectMarkers, id));
}

// ---- naming one, in place ----

let markerRename = null;

function closeMarkerRename() {
  if (!markerRename) return;
  const { input } = markerRename;
  markerRename = null;
  input.remove();
}

/**
 * A small box at the flag to type its name into. Enter or a click elsewhere
 * keeps what was typed, Escape leaves the name as it was.
 */
function renameMarker(id) {
  const m = projectMarkers.find((x) => x.id === id);
  const flag = markerElement(id);
  if (!m || !flag || busy) return;
  closeMarkerRename();
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'timeline-flag__rename';
  input.maxLength = timelineMarkers.NAME_MAX;
  input.value = m.name;
  input.placeholder = t('Marker name');
  const at = flag.getBoundingClientRect();
  document.body.appendChild(input);
  input.style.left = Math.max(4, Math.min(at.left + 8, window.innerWidth - input.offsetWidth - 4)) + 'px';
  input.style.top = Math.max(4, at.top) + 'px';
  markerRename = { id, input };
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const value = input.value;
    closeMarkerRename();
    if (keep) setProjectMarkers(timelineMarkers.rename(projectMarkers, id, value));
  };
  input.addEventListener('keydown', (evt) => {
    // Its own keys, not the timeline's: a letter typed here is a letter.
    evt.stopPropagation();
    if (evt.key === 'Enter') finish(true);
    else if (evt.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
}

function openMarkerMenu(evt, id) {
  evt.preventDefault();
  evt.stopPropagation();
  closeClipMenu();
  const menu = document.createElement('div');
  menu.className = 'clip-menu';
  menu.setAttribute('role', 'menu');
  menuItem(menu, t('Rename marker'), () => renameMarker(id));
  menuItem(menu, t('Delete marker'), () => deleteMarker(id));
  document.body.appendChild(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = Math.max(4, Math.min(evt.clientX, window.innerWidth - w - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(evt.clientY, window.innerHeight - h - 4)) + 'px';
  clipMenu = menu;
}

// ---- stepping along the timeline's edges ----

/**
 * Every moment worth stopping at: where a clip starts or ends, the markers,
 * the two ends of the selection, and the project's start and end.
 */
function timelineStops() {
  const stops = new Set([0]);
  for (const l of layers) {
    stops.add(l.start);
    stops.add(timelineModel.endOf(l));
  }
  for (const m of projectMarkers) stops.add(m.t);
  if (trimmable()) {
    stops.add(slider.start);
    stops.add(slider.end);
  }
  return [...stops].filter((s) => Number.isFinite(s) && s >= 0).sort((a, b) => a - b);
}

/**
 * The playhead to the stop before it (-1) or after it (1). A frame's width
 * of slack, so that standing on an edge the key goes on to the next one
 * rather than staying.
 */
function stepToEdge(dir) {
  if (!timelineDriving() || !layers.length) return false;
  const slack = 0.5 / playheadFps();
  const stops = timelineStops();
  const target = dir > 0
    ? stops.find((s) => s > compositeAt + slack)
    : stops.slice().reverse().find((s) => s < compositeAt - slack);
  if (target === undefined) return false;
  if (compositePlaying) pauseComposite();
  seekToTime(target);
  return true;
}
