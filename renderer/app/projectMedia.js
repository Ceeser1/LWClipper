'use strict';

// V4.5. Project Media.
//
// The user: "add a new frame between the previews and the timeline which
// should be collapsible: Project Media. IT lists every source media of the
// project in a horizontal scrollable row, default 16:9 preview frames with
// their file names at the top (as long as it fits, else cut off -2 chars and
// add ".."). When collapsing Project Media the Timeline should move upwards by
// the vertical space freed. The first entry if empty is a half-transparent
// frame 1:1 rounded rectangle "+" in big and below "Add Media". Hovering it
// highlights it, clicking it opens the file explorer. Any supported files can
// be drag and dropped into the "Project Media" frame. Each entry/source from
// the project media frame can be dragged into the timeline."
//
// The list is the project's own (projectMedia below, saved in the .lwc by
// src/project.js mediaOf): every file put on the timeline joins it through
// setLayers, and a file added here waits in it until it is dragged down. A
// track deleted from the timeline leaves its file here, the way a bin keeps
// what was imported. Add Media stays the first tile with media in the list as
// well, so there is always a way to add more.

const projectMediaSection = el('projectMedia');
const projectMediaToggle = el('projectMediaToggle');
const projectMediaList = el('projectMediaList');
const projectMediaCount = el('projectMediaCount');
const projectMediaDropHint = el('projectMediaDropHint');

/** [{ src, name, type: 'video'|'audio'|'image', duration, missing? }], in the order they came in. */
let projectMedia = [];

// A path compared the way Windows compares it, so C:/a.mp4 and C:\A.mp4 are
// one entry rather than two.
const mediaKey = (src) => String(src || '').replace(/\//g, '\\').toLowerCase();

function mediaIndexOf(src) {
  const key = mediaKey(src);
  return projectMedia.findIndex((m) => mediaKey(m.src) === key);
}

function mediaBaseName(src) {
  return String(src || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

/**
 * The name a tile shows: the file's name with its extension. A download in
 * the cache is named after its video id, so there the title it came with
 * stands in front of the extension instead.
 */
function mediaShownName(src, title) {
  const base = mediaBaseName(src);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  const stem = dot > 0 ? base.slice(0, dot) : base;
  if (!title || title === stem || title === base) return base;
  return title.endsWith(ext) ? title : title + ext;
}

function mediaEntryFromData(data) {
  let type = 'video';
  if (data.isImage) type = 'image';
  else if (data.isAudio || !(data.width > 0)) type = 'audio';
  return {
    src: data.path,
    name: mediaShownName(data.path, data.title),
    type,
    duration: data.isImage ? 0 : Math.max(0, Number(data.duration) || 0),
  };
}

function mediaEntryFromLayer(layer, all) {
  let type = 'audio';
  if (layer.kind === 'image') type = 'image';
  else if (all.some((l) => l.src === layer.src && l.type === 'video' && l.kind !== 'image')) type = 'video';
  return {
    src: layer.src,
    name: mediaShownName(layer.src, layer.name),
    type,
    duration: type === 'image' ? 0 : Math.max(0, Number(layer.sourceDuration) || 0),
  };
}

/** What the .lwc keeps of the list: no missing marks, they are found again on opening. */
function projectMediaForFile() {
  return projectMedia.map((m) => ({ src: m.src, name: m.name, type: m.type, duration: m.duration }));
}

/**
 * From setLayers, on every change: a file the timeline has that the list
 * does not yet. Generated layers have no file and mask pictures are a
 * layer's setting, so neither is media here.
 */
function noteProjectMediaLayers() {
  let changed = false;
  for (const layer of layers) {
    if (!layer.src || layer.kind === 'gen') continue;
    const at = mediaIndexOf(layer.src);
    if (at < 0) {
      projectMedia.push(mediaEntryFromLayer(layer, layers));
      changed = true;
    } else if (projectMedia[at].missing) {
      // Found again: a track on the timeline is using it.
      projectMedia[at] = { ...projectMedia[at], src: layer.src, missing: false };
      changed = true;
    }
  }
  if (changed) drawProjectMedia();
  else paintMediaUsage();
}

/** The list a project file opened with, pointed at wherever its files were found. */
function mediaFromProject(result) {
  const list = (result && result.doc && result.doc.media) || [];
  const statuses = (result && result.mediaStatuses) || [];
  return list.map((m, i) => {
    const st = statuses[i];
    if (!st) return { ...m };
    if (st.state === 'missing') return { ...m, missing: true };
    return { ...m, src: st.path || m.src };
  });
}

function adoptProjectMedia(result) {
  projectMedia = [];
  mergeProjectMedia(result);
}

function mergeProjectMedia(result) {
  for (const m of mediaFromProject(result)) {
    if (mediaIndexOf(m.src) < 0) projectMedia.push(m);
  }
  drawProjectMedia();
}

function clearProjectMedia() {
  projectMedia = [];
  drawProjectMedia();
}

// ---- adding ----

/**
 * Files from the dialog or from a drop: each that describeMedia reads joins
 * the list.
 *
 * A project file among them is opened instead, the user's "if its an .lwc
 * project being draged into project media and its empty, load the .lwc
 * project. If a project is in work ... ask the user about the
 * save/discard/merge": openProjectPath, which opens straight into an empty
 * one and puts the Different LWC Project question to one in work. First, so
 * the media that came with it land in whichever project that leaves open.
 * One project a drop; a second one is said rather than asked about again.
 */
async function addMediaFiles(paths) {
  if (!paths || !paths.length || busy || !timelineDriving()) return;
  const described = [];
  let lwcPath = null;
  let extraProjects = 0;
  for (const filePath of paths) {
    let result;
    try {
      result = await window.lwclipper.describeMedia(filePath);
    } catch {
      result = null;
    }
    if (result && result.project) {
      if (lwcPath) extraProjects += 1;
      else lwcPath = result.path;
      continue;
    }
    described.push(result);
  }
  if (lwcPath) {
    await openProjectPath(lwcPath);
    if (!described.length || busy || !timelineDriving()) {
      if (extraProjects) setStatus('Only one project can be opened at a time; {n} more were left out.', { n: extraProjects });
      return;
    }
  }
  let added = 0;
  let refused = 0;
  let already = 0;
  for (const result of described) {
    if (!result || !result.ok) {
      refused += 1;
      continue;
    }
    if (mediaIndexOf(result.data.path) >= 0) {
      already += 1;
      continue;
    }
    projectMedia.push(mediaEntryFromData(result.data));
    added += 1;
  }
  if (added) {
    if (projectMediaSection.classList.contains('media-section--collapsed')) setMediaCollapsed(false, true);
    drawProjectMedia();
    updateProjectUi();
    // The last one added is the one worth seeing.
    projectMediaList.scrollLeft = projectMediaList.scrollWidth;
  }
  // A project left out is the thing least likely to be noticed otherwise, so
  // it is said over the count of the media.
  if (extraProjects) setStatus('Only one project can be opened at a time; {n} more were left out.', { n: extraProjects });
  else if (refused) setStatus('{n} file(s) could not be added to Project Media.', { n: refused });
  else if (added) setStatus('Added {n} file(s) to Project Media.', { n: added });
  else if (already) setStatus('Already in Project Media.');
}

/**
 * V4.5. The red X on a tile, and the right click menu's Remove. A file the
 * timeline does not use simply goes. One it does use asks first, at the
 * user's word: "This media is in use, do you really want to delete it? Every
 * occurance of it in the timeline will be deleted.", Cancel left and Confirm
 * right, both plain. Confirmed, every track of that file goes as one step
 * that undo brings back (and the file with it, through setLayers).
 */
async function askRemoveProjectMedia(src) {
  if (busy) return;
  if (!mediaOnTimeline(src)) {
    removeProjectMedia(src);
    return;
  }
  const choice = await showChoice({
    title: t('Warning'),
    message: t('This media is in use, do you really want to delete it? Every occurrence of it in the timeline will be deleted.'),
    buttons: [
      { id: 'cancel', label: t('Cancel'), left: true },
      { id: 'confirm', label: t('Confirm') },
    ],
    cancel: 'cancel',
  });
  if (choice !== 'confirm' || busy) return;
  const key = mediaKey(src);
  const ids = layers.filter((l) => l.src && mediaKey(l.src) === key).map((l) => l.id);
  // An editor window open on one of them is asked about the way Delete asks
  // (deleteTracks' check), and the file goes in the same step as its tracks.
  // Answered Abort, both stay.
  const conflicts = ids.flatMap((id) => [cropWindowOn(id) && cropWindowConflict(), genWindowConflict(id)]);
  confirmPopoutConflict(conflicts, () => {
    let now = layers;
    for (const id of ids) now = timelineModel.removeLayer(now, id);
    setLayers(now);
    commitHistory();
    removeProjectMedia(src);
  });
}

function removeProjectMedia(src) {
  const at = mediaIndexOf(src);
  if (at < 0) return;
  projectMedia.splice(at, 1);
  drawProjectMedia();
  updateProjectUi();
}

function mediaOnTimeline(src) {
  const key = mediaKey(src);
  return layers.some((l) => l.src && mediaKey(l.src) === key);
}

// ---- drawing ----

// The tile's name, whole while it fits, and otherwise as much as fits less
// two more characters with ".." after them, the user's own rule.
const mediaNameInk = document.createElement('canvas').getContext('2d');
const MEDIA_NAME_WIDTH = 144;

function fitMediaName(name, width, font) {
  mediaNameInk.font = font;
  if (mediaNameInk.measureText(name).width <= width) return name;
  let n = name.length;
  while (n > 0 && mediaNameInk.measureText(name.slice(0, n)).width > width) n -= 1;
  return name.slice(0, Math.max(0, n - 2)) + '..';
}

function mediaTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (v) => String(v).padStart(2, '0');
  return h ? h + ':' + pad(m) + ':' + pad(s % 60) : m + ':' + pad(s % 60);
}

// A tile's picture, asked once a file and a run: a frame of a video, the
// picture itself for an image. Kept by path, so redrawing the row costs
// nothing.
const mediaPictures = new Map();

function mediaPicture(entry) {
  const key = mediaKey(entry.src);
  if (!mediaPictures.has(key)) mediaPictures.set(key, loadMediaPicture(entry));
  return mediaPictures.get(key);
}

async function loadMediaPicture(entry) {
  try {
    if (entry.type === 'image') return await window.lwclipper.fileUrl(entry.src);
    if (entry.type === 'video') {
      const poster = await window.lwclipper.mediaPoster(entry.src, entry.duration);
      return poster && poster.ok ? await window.lwclipper.fileUrl(poster.file) : null;
    }
  } catch {
    // No picture; the tile stays a dark frame with its name.
  }
  return null;
}

/**
 * An audio tile's picture. Its real waveform when the timeline already has
 * one for it, since asking for one here would cancel the timeline's own (the
 * peaks reader runs one job at a time), and otherwise a plain sound sign.
 */
function drawAudioPicture(canvas, entry) {
  const dpr = window.devicePixelRatio || 1;
  const w = 144;
  const h = 81;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const cached = typeof peakCache !== 'undefined' ? peakCache.get(entry.src) : null;
  const mid = h / 2;
  ctx.fillStyle = '#5a8cdc';
  if (cached && cached.peaks && cached.buckets) {
    const { peaks, buckets } = cached;
    for (let px = 0; px < w; px += 1) {
      const b = Math.min(buckets - 1, Math.floor((px / w) * buckets));
      const top = mid - peaks[b * 2 + 1] * (mid - 6);
      const bottom = mid - peaks[b * 2] * (mid - 6);
      ctx.fillRect(px, top, 1, Math.max(1, bottom - top));
    }
    return;
  }
  // Bars of a made-up level, the same for every file, so it reads as sound
  // without claiming to be this one.
  const bars = 24;
  const gap = 2;
  const bw = (w - 24 - gap * (bars - 1)) / bars;
  for (let i = 0; i < bars; i += 1) {
    const level = 0.25 + 0.6 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.6));
    const bh = Math.max(2, level * (h - 24));
    ctx.fillRect(12 + i * (bw + gap), mid - bh / 2, bw, bh);
  }
}

function paintMediaFrame(frame, entry) {
  if (entry.type === 'audio') {
    const canvas = document.createElement('canvas');
    drawAudioPicture(canvas, entry);
    frame.appendChild(canvas);
    return;
  }
  mediaPicture(entry).then((url) => {
    if (!url || !frame.isConnected) return;
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = url;
    frame.prepend(img);
  });
}

function buildAddTile() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'media-add';
  const plus = document.createElement('span');
  plus.className = 'media-add__plus';
  plus.textContent = '+';
  const label = document.createElement('span');
  label.className = 'media-add__label';
  label.textContent = t('Add Media');
  btn.append(plus, label);
  btn.addEventListener('click', async () => {
    if (busy) return;
    addMediaFiles(await window.lwclipper.pickMedia());
  });
  return btn;
}

function buildMediaTile(entry) {
  const tile = document.createElement('div');
  tile.className = 'media-tile';
  tile.dataset.src = entry.src;
  tile.title = entry.src;
  const name = document.createElement('div');
  name.className = 'media-tile__name';
  name.dataset.full = entry.name;
  name.textContent = entry.name;
  const frame = document.createElement('div');
  frame.className = 'media-tile__frame';
  if (entry.missing) {
    tile.classList.add('media-tile--missing');
    const gone = document.createElement('div');
    gone.className = 'media-tile__missing';
    gone.textContent = t('Missing');
    frame.appendChild(gone);
  } else {
    paintMediaFrame(frame, entry);
    if (entry.duration > 0) {
      const time = document.createElement('span');
      time.className = 'media-tile__time';
      time.textContent = mediaTime(entry.duration);
      frame.appendChild(time);
    }
  }
  // V4.5. A green tick while the timeline uses the file (paintMediaUsage
  // shows it), and the red X that takes it out of the project.
  const used = document.createElement('span');
  used.className = 'media-tile__used';
  used.title = t('Used in the timeline');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'media-tile__remove';
  remove.textContent = '\u2715';
  remove.title = t('Remove media from project');
  remove.setAttribute('aria-label', remove.title);
  // Its own press, or it would start dragging the tile.
  remove.addEventListener('pointerdown', (evt) => evt.stopPropagation());
  remove.addEventListener('click', (evt) => {
    evt.stopPropagation();
    askRemoveProjectMedia(entry.src);
  });
  frame.append(used, remove);
  tile.append(name, frame);
  tile.addEventListener('pointerdown', (evt) => startMediaDrag(evt, entry, tile));
  tile.addEventListener('contextmenu', (evt) => openMediaMenu(evt, entry));
  return tile;
}

/** The tick on every tile whose file is on the timeline, after any change to it. */
function paintMediaUsage() {
  const used = new Set(layers.filter((l) => l.src).map((l) => mediaKey(l.src)));
  for (const tile of projectMediaList.querySelectorAll('.media-tile')) {
    tile.classList.toggle('media-tile--used', used.has(mediaKey(tile.dataset.src)));
  }
}

function fitMediaNames() {
  for (const node of projectMediaList.querySelectorAll('.media-tile__name')) {
    const width = node.clientWidth || MEDIA_NAME_WIDTH;
    node.textContent = fitMediaName(node.dataset.full, width, getComputedStyle(node).font);
  }
}

function drawProjectMedia() {
  const scroll = projectMediaList.scrollLeft;
  projectMediaList.replaceChildren(buildAddTile(), ...projectMedia.map(buildMediaTile));
  projectMediaList.scrollLeft = scroll;
  projectMediaCount.textContent = projectMedia.length ? String(projectMedia.length) : '';
  paintMediaUsage();
  fitMediaNames();
}

// A wheel turned over the row scrolls it sideways, which is the only way it
// goes.
projectMediaList.addEventListener('wheel', (evt) => {
  if (evt.deltaX || !evt.deltaY) return;
  if (projectMediaList.scrollWidth <= projectMediaList.clientWidth) return;
  projectMediaList.scrollLeft += evt.deltaY;
  evt.preventDefault();
}, { passive: false });

// ---- collapsing ----

/**
 * Open or shut the frame. Its height goes to the timeline, not to the
 * previews: "the Timeline should move upwards by the vertical space freed",
 * so the split is moved by what the frame gave up or took.
 */
function setMediaCollapsed(on, save) {
  const was = projectMediaSection.classList.contains('media-section--collapsed');
  if (was === on) return;
  const before = projectMediaSection.getBoundingClientRect().height;
  const stack = timelineStack.getBoundingClientRect().height;
  projectMediaSection.classList.toggle('media-section--collapsed', on);
  projectMediaToggle.setAttribute('aria-expanded', String(!on));
  const after = projectMediaSection.getBoundingClientRect().height;
  if (before > 0 && after > 0) shiftSplitBy(stack, before - after);
  if (!on) fitMediaNames();
  if (save) {
    window.lwclipper.setSettings({ projectMediaCollapsed: on }).then((r) => {
      if (r && r.settings) appSettings = r.settings;
    });
  }
}

/** The saved state, from applySettingsPayload, without moving the split. */
function applyMediaCollapsedSetting() {
  const on = !!(appSettings && appSettings.projectMediaCollapsed);
  projectMediaSection.classList.toggle('media-section--collapsed', on);
  projectMediaToggle.setAttribute('aria-expanded', String(!on));
}

projectMediaToggle.addEventListener('click', () => {
  setMediaCollapsed(!projectMediaSection.classList.contains('media-section--collapsed'), true);
});

// ---- the right click menu ----

function openMediaMenu(evt, entry) {
  evt.preventDefault();
  closeClipMenu();
  const menu = document.createElement('div');
  menu.className = 'clip-menu';
  menu.setAttribute('role', 'menu');
  const b = document.createElement('button');
  b.className = 'clip-menu__item';
  b.setAttribute('role', 'menuitem');
  b.textContent = t('Remove media from project');
  b.disabled = busy;
  // The same as the red X, the warning included.
  b.addEventListener('click', () => {
    closeClipMenu();
    askRemoveProjectMedia(entry.src);
  });
  menu.appendChild(b);
  document.body.appendChild(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = Math.max(4, Math.min(evt.clientX, window.innerWidth - w - 4)) + 'px';
  menu.style.top = Math.max(4, Math.min(evt.clientY, window.innerHeight - h - 4)) + 'px';
  clipMenu = menu;
}

// ---- dragging a tile onto the timeline ----

const MEDIA_DRAG_SLOP = 5;
let mediaDrag = null;
const mediaDropLine = document.createElement('div');
mediaDropLine.className = 'media-drop-line';
mediaDropLine.hidden = true;
timelineLane.appendChild(mediaDropLine);

/**
 * Where a tile let go at (x, y) would land: the row under it and the time
 * under it. A row of the other kind still takes it, on a new row of its own
 * kind, and anywhere else in the timeline frame is a new row. Null outside
 * the timeline.
 */
function mediaDropTarget(x, y) {
  if (!timelineDriving()) return null;
  const node = document.elementFromPoint(x, y);
  if (!node || !node.closest('.timeline-section')) return null;
  const lane = timelineLane.getBoundingClientRect();
  const inLane = x >= lane.left && x <= lane.right;
  // An empty timeline's ruler has no length to measure against yet, so the
  // first file starts at the beginning wherever it was let go.
  const at = inLane && layers.length ? Math.max(0, timelineView.xToTime(tlView, x - lane.left)) : 0;
  const row = node.closest('.layer-row[data-lane]');
  const track = node.closest('.layer-track, [data-empty-type]')
    || (row && row.querySelector('.layer-track'));
  if (track) {
    const type = track.dataset.type || track.dataset.emptyType || 'auto';
    const laneOf = track.dataset.lane;
    return {
      node: track, type, at, x: inLane ? x - lane.left : null,
      lane: type === 'auto' || laneOf === undefined || laneOf === '' ? null : Number(laneOf),
    };
  }
  return { node: null, type: 'auto', lane: null, at, x: inLane ? x - lane.left : null };
}

function paintMediaTarget(target) {
  for (const n of document.querySelectorAll('.layer-track--dropping')) {
    if (!target || n !== target.node) n.classList.remove('layer-track--dropping');
  }
  if (target && target.node) target.node.classList.add('layer-track--dropping');
  mediaDropLine.hidden = !target || target.x === null;
  if (target && target.x !== null) mediaDropLine.style.left = target.x + 'px';
  document.body.classList.toggle('media-dragging--nowhere', !!mediaDrag && !target);
}

function startMediaDrag(evt, entry, tile) {
  if (evt.button !== 0 || busy || entry.missing || !timelineDriving()) return;
  evt.preventDefault();
  mediaDrag = { entry, x: evt.clientX, y: evt.clientY, started: false, ghost: null, target: null, tile };
  tile.setPointerCapture(evt.pointerId);
  const move = (ev) => {
    if (!mediaDrag) return;
    if (!mediaDrag.started) {
      if (Math.hypot(ev.clientX - mediaDrag.x, ev.clientY - mediaDrag.y) < MEDIA_DRAG_SLOP) return;
      mediaDrag.started = true;
      const ghost = document.createElement('div');
      ghost.className = 'media-ghost';
      const pic = tile.querySelector('.media-tile__frame > img, .media-tile__frame > canvas');
      if (pic) {
        const copy = pic.cloneNode(true);
        if (pic.tagName === 'CANVAS') copy.getContext('2d').drawImage(pic, 0, 0);
        ghost.appendChild(copy);
      }
      document.body.appendChild(ghost);
      mediaDrag.ghost = ghost;
      document.body.classList.add('media-dragging');
    }
    mediaDrag.ghost.style.left = (ev.clientX + 12) + 'px';
    mediaDrag.ghost.style.top = (ev.clientY + 12) + 'px';
    mediaDrag.target = mediaDropTarget(ev.clientX, ev.clientY);
    paintMediaTarget(mediaDrag.target);
  };
  const end = (ev) => {
    tile.removeEventListener('pointermove', move);
    tile.removeEventListener('pointerup', end);
    tile.removeEventListener('pointercancel', end);
    if (tile.hasPointerCapture(ev.pointerId)) tile.releasePointerCapture(ev.pointerId);
    const drag = mediaDrag;
    endMediaDrag();
    if (drag && drag.started && ev.type === 'pointerup') {
      const target = mediaDropTarget(ev.clientX, ev.clientY);
      if (target) dropMediaOnTimeline(drag.entry, target);
    }
  };
  tile.addEventListener('pointermove', move);
  tile.addEventListener('pointerup', end);
  tile.addEventListener('pointercancel', end);
}

function endMediaDrag() {
  if (!mediaDrag) return;
  if (mediaDrag.ghost) mediaDrag.ghost.remove();
  mediaDrag = null;
  document.body.classList.remove('media-dragging', 'media-dragging--nowhere');
  paintMediaTarget(null);
}

// Escape lets go of a drag without dropping it.
document.addEventListener('keydown', (evt) => {
  if (evt.key === 'Escape' && mediaDrag && mediaDrag.started) {
    evt.preventDefault();
    evt.stopPropagation();
    endMediaDrag();
  }
}, true);

/**
 * The tile's file as a track where it was let go, at the time under the
 * pointer. Asked of describeMedia afresh, since what the list keeps is only
 * enough to draw it. A video dropped on an audio row brings its sound alone,
 * as a file dropped there from outside does.
 */
async function dropMediaOnTimeline(entry, target) {
  if (busy) return;
  const result = await window.lwclipper.describeMedia(entry.src);
  if (!result || !result.ok) {
    if (result && !result.project) reportFailure(result);
    return;
  }
  const data = result.data;
  const sound = data.isAudio || (!data.isImage && !(data.width > 0));
  let want;
  let lane = target.lane;
  if (target.type === 'video') {
    want = sound ? 'audio' : 'video';
    if (sound) lane = null;
  } else if (target.type === 'audio') {
    if (data.isImage) {
      reportFailure({ error: t('An image has no sound to put on an audio track.') });
      return;
    }
    if (!sound && !data.hasAudio) {
      reportFailure({ error: t('That file has no audio track ffmpeg can read.') });
      return;
    }
    want = 'audio';
  } else {
    want = sound ? 'audio' : 'video';
    lane = null;
  }
  addLayerFromMedia(want, data, lane === null ? undefined : lane, target.at);
}

drawProjectMedia();
