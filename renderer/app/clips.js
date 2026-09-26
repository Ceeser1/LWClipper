'use strict';

// The rows and clips on the timeline: grouping, moving and trimming a clip, rows
// not there yet, and how a clip is drawn.

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
  // V2.9. In reading order rather than list order: on a lane the list puts the
  // later clip first, and a split would otherwise hand the old group's marker
  // to the new one.
  const index = timelineModel.groupIds(timelineModel.readingOrder(layers)).indexOf(groupId);
  if (index < 0) return null;
  return {
    shape: GROUP_SHAPES[index % GROUP_SHAPES.length],
    colour: GROUP_COLOURS[index % GROUP_COLOURS.length],
  };
}

function layersOfType(type) {
  return layers.filter((l) => l.type === type);
}

// V2.9. The row a layer is on, counted from 1. Its lane once arrangeLanes has
// seen it, which setLayers makes sure of; the old count among its own kind for
// the moment in between.
function layerOrdinal(layer) {
  if (Number.isInteger(layer.lane)) return layer.lane + 1;
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
  // V2.9. The row lights when the selected clip is on it, and the clip itself
  // says which of the row's clips that is.
  for (const clip of timelineStack.querySelectorAll('.layer-clip[data-layer-id]')) {
    clip.classList.toggle('layer-clip--selected', clip.dataset.layerId === selectedLayerId);
  }
  for (const row of timelineStack.querySelectorAll('.layer-row[data-lane]')) {
    row.classList.toggle('layer-row--selected',
      !!row.querySelector('.layer-clip--selected'));
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
// V2.9. The list as the last setLayers left it. Drags write straight into
// `layers` while they run, so this, not `layers`, is what the document looked
// like before the gesture that is now being committed.
let settledLayers = [];

function setLayers(next, restoring) {
  // V2.9. In lane order, whoever built the list. The composer reads the list
  // order as the stacking order and the rows are drawn from the lanes, so this
  // is the one place the two are made to agree.
  const arranged = timelineModel.arrangeLanes(next);
  // And the transitions brought up to date with whatever the gesture did to the
  // overlaps on each lane. Not on a restore, undo or a project opening, whose
  // fades are exactly what was saved and are put back as they were rather than
  // worked out again.
  layers = restoring ? arranged : timelineModel.crossfade(settledLayers, arranged);
  settledLayers = layers;
  if (selectedLayerId && !timelineModel.layerById(layers, selectedLayerId)) {
    selectedLayerId = null;
  }
  dropUnusedStrips();
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
function addLayerFromMedia(type, data, lane) {
  const duration = Math.max(0, data.duration || 0);
  if (!duration) return;
  // V2.3. A still goes in as a video layer with kind 'image' beside its type,
  // not instead of it. Everything that asks whether a layer is a picture asks
  // type === 'video' and keeps working; the handful of places that have to know
  // it is one frame rather than a file ask kind.
  const image = type === 'video' && !!data.isImage;
  const paired = type === 'video' && !image && !!data.hasAudio;
  const groupId = paired ? timelineModel.newGroupId() : null;
  const layer = timelineModel.createLayer({
    type,
    kind: image ? 'image' : 'media',
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
    // V2.9.1. The row it was dropped or opened into, when there was one. None
    // is a new row below the others, which is also where its sound goes.
    lane,
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
async function openIntoLayer(type, filePath, lane) {
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
  // V2.8. 'auto' is the Add a new Layer block, which has no kind of its own and
  // takes whatever the file is. Resolved once, here, so everything below sees a
  // real type.
  const want = type === 'auto'
    ? (result.data.isAudio ? 'audio' : 'video')
    : type;
  // V2.3. A still has no sound in it, so an Audio row is not somewhere it can
  // go. Said rather than quietly making a silent audio layer, which would look
  // like the drop worked. An image can never resolve to audio through 'auto',
  // so this only ever answers a row that was asked for as an audio row.
  if (want === 'audio' && result.data.isImage) {
    reportFailure({ error: t('An image has no sound to put on an audio track.') });
    return;
  }
  // Into the row it was aimed at, which since V2.9.1 is a lane like any other.
  // The block at the bottom has none, and the file takes a new row.
  const onto = lane === undefined || lane === null || lane === '' ? undefined : Number(lane);
  addLayerFromMedia(want, result.data, onto);
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
/**
 * One row of the timeline: a head, and a track holding every clip on the lane.
 *
 * V2.9. A row used to be one layer. It is a lane now, which can hold any number
 * of them, and the head is the row's: Enabled, Volume, the arrows and the
 * delete button act on every clip on it, which the user settled on 2026-09-24.
 * "A control that means something different depending on what was last
 * clicked is a control nobody can read." Everything about one picture stays on
 * the clip, where it is drawn.
 */
function buildLaneRow(type, lane, members) {
  const row = document.createElement('div');
  row.className = 'layer-row layer-row--' + type;
  row.dataset.type = type;
  row.dataset.lane = String(lane);
  if (members.every((l) => !l.enabled)) row.classList.add('layer-row--off');
  if (members.some((l) => l.id === selectedLayerId)) row.classList.add('layer-row--selected');

  const head = document.createElement('div');
  head.className = 'layer-head';

  const top = document.createElement('div');
  top.className = 'layer-head__top';
  // The group marker and the crop button used to sit here, either side of the
  // name, and between them and the arrows the name had about six characters of
  // room. Both now ride the end of the clip instead, where the thing they are
  // about actually is. The head keeps the name and the two things that are not
  // about one clip: where the row sits in the stack, and whether it stays.
  const name = document.createElement('div');
  name.className = 'layer-name';
  name.textContent = layerLabel(type, lane + 1);
  name.title = members.map((l) => l.name).filter(Boolean).join(', ');
  top.appendChild(name);

  // Up and down only on video: a mix does not care what order it sums in, so
  // there is nothing for the arrows to mean on an audio row.
  if (type === 'video') {
    const count = rowsOf('video');
    const reorder = (delta) => {
      setLayers(timelineModel.reorderLane(layers, type, lane, delta, count));
      commitHistory();
    };
    const up = makeButton('layer-btn', '▲', t('Move layer up'), () => reorder(-1));
    const down = makeButton('layer-btn', '▼', t('Move layer down'), () => reorder(1));
    up.disabled = lane === 0;
    down.disabled = lane === count - 1;
    top.appendChild(up);
    top.appendChild(down);
  }

  top.appendChild(makeButton('layer-btn layer-btn--delete', '✕', t('Delete layer'), () => {
    // The whole row. A clip grouped with something on another row loses its
    // partner by this and the partner keeps its marker, so it is visible which
    // one it was: the design's rule since Step 14, which removeLane keeps by
    // doing nothing clever, the way removeLayer did.
    deleteRow(type, lane);
  }));
  head.appendChild(top);

  const controls = document.createElement('div');
  controls.className = 'layer-head__row';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'layer-enabled';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  // Ticked while anything on the row is on, and half ticked when only some of
  // it is, which a clip dragged in from another row can bring about. Ticking it
  // then switches the whole row on, which is what a half ticked box is for.
  const on = members.filter((l) => l.enabled).length;
  enabled.checked = on > 0;
  enabled.indeterminate = on > 0 && on < members.length;
  enabled.addEventListener('click', (evt) => evt.stopPropagation());
  enabled.addEventListener('change', () => {
    setLayers(timelineModel.setLane(layers, type, lane, { enabled: enabled.checked }));
  });
  enabledLabel.appendChild(enabled);
  enabledLabel.appendChild(document.createTextNode(t('Enabled')));
  controls.appendChild(enabledLabel);

  // Per-row volume, which is what replaces the single global slider.
  if (type === 'audio') {
    // Showing the selected clip's level when it is on this row, since that is
    // the one being looked at, and the first clip's otherwise. Moving it sets
    // every clip on the row to the same level.
    const shown = members.find((l) => l.id === selectedLayerId) || members[0];
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.className = 'layer-volume';
    vol.min = '0';
    vol.max = '200';
    vol.step = '5';
    vol.value = String(Math.round(shown.volume * 100));
    const readout = document.createElement('span');
    readout.className = 'layer-volume__value';
    readout.textContent = vol.value + '%';
    vol.addEventListener('click', (evt) => evt.stopPropagation());
    // Written straight into the model on input rather than on change, but
    // without a re-render: rebuilding the rows mid-drag would take the slider
    // out from under the pointer.
    vol.addEventListener('input', () => {
      readout.textContent = vol.value + '%';
      layers = timelineModel.setLane(layers, type, lane, { volume: Number(vol.value) / 100 });
      // Live, because the slider is how a level gets found and finding it means
      // hearing it move. Read back out of the model rather than trusting the
      // value in hand, so what is heard is what was written.
      for (const member of members) {
        const updated = timelineModel.layerById(layers, member.id);
        if (updated) applyPlayerGain(updated);
      }
      // Written straight into the list, so nothing else is going to notice.
      updateProjectUi();
    });
    controls.appendChild(vol);
    controls.appendChild(readout);
  }
  head.appendChild(controls);

  const track = document.createElement('div');
  track.className = 'layer-track';
  track.dataset.type = type;
  track.dataset.lane = String(lane);
  for (const layer of members) buildLayerClip(track, layer);

  row.appendChild(head);
  row.appendChild(track);
  // A press anywhere on the row keeps a selection already on it, and otherwise
  // selects its first clip. On a row of one clip that is exactly what pressing
  // a row always did. A press on a clip selects that clip itself, and stops
  // there, so it never reaches this.
  row.addEventListener('pointerdown', () => {
    if (members.some((l) => l.id === selectedLayerId)) return;
    selectLayer(members[0].id);
  });
  return row;
}

/**
 * One clip on a lane's track: the clip itself, and beside it in the track the
 * alpha line and its bar, which V2.5 moved out of the clip so the bar could
 * straddle its edges. All three carry the layer's id, because a track holds
 * several of each now and that id is how each finds its own.
 */
function buildLayerClip(track, layer) {
  const marker = groupMarker(layer.groupId);
  const clip = document.createElement('div');
  clip.className = 'layer-clip';
  clip.dataset.layerId = layer.id;
  if (!layer.enabled) clip.classList.add('layer-clip--off');
  if (layer.id === selectedLayerId) clip.classList.add('layer-clip--selected');
  // Step 17. The file's own name with its extension. This was layer.src, the
  // whole path, which is longer than a tooltip usefully is; layer.name is not
  // it either, because a download's title arrives there instead of a filename.
  clip.title = (layer.src || '').split(/[\\/]/).pop();
  // V3. A generated layer has no file to be named after, so it is named after
  // what it shows.
  if (layer.kind === 'gen') clip.title = genLabel(layer);
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
  // V3. A generated layer has the cogwheel instead, the one from Settings,
  // since there is nothing in it to crop: its picture is the frame. The user,
  // for text: "a cogwheel button on the right, use the one from settings".
  if (layer.kind === 'gen') {
    const cog = makeClipMark('clip-mark--gen', '', genKind(layer.gen).settingsTitle(), () => {
        selectLayer(layer.id);
        openGenSettings(layer.id, false);
      });
    const icon = document.createElement('img');
    icon.className = 'clip-mark__icon';
    icon.src = '../images/settings.png';
    icon.alt = '';
    cog.appendChild(icon);
    marks.appendChild(cog);
  } else if (layer.type === 'video') {
    // Video only: there is nothing to crop out of a waveform.
    const crop = makeClipMark('clip-mark--crop', '⛶', t('Crop layer'), () => {
      selectLayer(layer.id);
      openCrop(layer.id);
    });
    // Lit when this layer is actually cropped, so the row says so without
    // anything having to be opened to find out.
    crop.classList.toggle('clip-mark--on', !!layer.crop);
    marks.appendChild(crop);
    // There was a second mark here for the Render Position tab, added in 21a so
    // each layer could be opened straight onto it. Removed on 2026-09-23: the
    // popup already has the tab, and a mark whose only job is to open the same
    // popup one click further along is a second door into one room.
  }
  if (marks.childElementCount) clip.appendChild(marks);

  // V2.2. The fade handles, one in each top corner, and the line each drag
  // leaves behind. On every clip and not only video ones: a fade is a property
  // of a layer, and an audio layer fades by its volume exactly as a video one
  // fades by its alpha. composer.js has written both since 22a-1.
  //
  // Last, so a press lands on them rather than on the grip or the marks under
  // them. They bind their own drag and stop the event there, which is what
  // keeps bindClipDrag from reading the same press as a move.
  for (const which of ['in', 'out']) {
    const dot = document.createElement('div');
    dot.className = 'clip-fade-dot clip-fade-dot--' + which;
    dot.dataset.fade = which;
    dot.textContent = '°';
    // Two calls rather than one with a ternary inside t(, for the reason
    // spelled out over setProjectError: the checker sees a literal after t(
    // and nothing else.
    dot.title = which === 'in'
      ? t('Drag right to fade this layer in')
      : t('Drag left to fade this layer out');
    clip.appendChild(dot);
    // From nothing: a press on the handle starts the fade at zero and grows it
    // with the pointer, which is the gesture as described.
    bindFadeDrag(dot, layer.id, which, true);

    const line = document.createElement('div');
    line.className = 'clip-fade-line clip-fade-line--' + which;
    line.dataset.fadeLine = which;
    line.hidden = true;
    clip.appendChild(line);
    // From where it stands, so moving a fade that exists does not throw it away
    // and redraw it from the corner.
    bindFadeDrag(line, layer.id, which, false);
  }

  bindClipDrag(clip, layer.id);
  track.appendChild(clip);

  // V2.4. The maximum alpha: a line across the clip at the height it is set to,
  // and a bar to take hold of. Video only, unlike the fades: alpha is a thing
  // about a picture, and an audio layer already has its volume in the row's
  // head, where it has been since Step 10.
  //
  // Two elements rather than one, because they are two different things. The
  // line is the readout and runs the width of the clip, so it must not take a
  // press or the clip could no longer be dragged by its own body. The bar is
  // the control and is the only thing here a pointer reaches.
  //
  // V2.5 puts them in the track beside the clip rather than inside it, so the
  // bar can straddle the clip's top and bottom edges instead of being cut off
  // by them. After the clip, so both are drawn over it.
  if (layer.type === 'video') {
    const line = document.createElement('div');
    line.className = 'clip-alpha-line';
    line.dataset.layerId = layer.id;
    track.appendChild(line);

    const grip = document.createElement('div');
    grip.className = 'clip-alpha-grip';
    grip.dataset.layerId = layer.id;
    track.appendChild(grip);
    bindAlphaDrag(grip, layer.id);
  }
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

/**
 * V2.9 item 1. The row of the clip's own kind under the pointer, when it is not
 * the row the clip is on: "if there are 2 video tracks and i click to drag on
 * video 2 but move the mouse upwards to video 1, show a green box like drag
 * and drop area on video 1 layer".
 *
 * An empty row that was asked for is a target too, and is how a clip is moved
 * onto a row of its own: add one, then drag the clip into it. Rows of the other
 * kind are not, since a picture has nowhere to be drawn on an audio row.
 */
function laneTargetAt(type, fromLane, clientY) {
  for (const row of timelineStack.querySelectorAll('.layer-row--' + type + '[data-lane]')) {
    const b = row.getBoundingClientRect();
    if (clientY < b.top || clientY >= b.bottom) continue;
    const track = row.querySelector('.layer-track');
    if (!track) return null;
    const lane = Number(row.dataset.lane);
    return lane === fromLane ? null : { lane, track };
  }
  return null;
}

/**
 * The green box on the target row, the length of the clip, at the start the
 * horizontal half of the drag has already worked out. That is where the
 * user's "same distance from track-start to mouse click" comes from without
 * any sum of its own: the drag has carried the second the press landed on
 * since Step 9, not the pointer's position, so the box lands under the
 * pointer exactly where the clip would.
 *
 * Open ended because the track clips it: "let it open-end if it goes beyond
 * current timeline scale to the right". The clip being moved is dimmed while
 * the box is shown, so there is one place it looks as if it is going.
 */
function placeLaneGhost(drag, clip, layer) {
  const target = drag.target;
  if (!target) {
    if (drag.ghost) drag.ghost.remove();
    drag.ghost = null;
    clip.classList.remove('layer-clip--leaving');
    return;
  }
  if (!drag.ghost || drag.ghost.parentElement !== target.track) {
    if (drag.ghost) drag.ghost.remove();
    drag.ghost = document.createElement('div');
    drag.ghost.className = 'layer-drop-ghost';
    target.track.appendChild(drag.ghost);
  }
  const x0 = timelineView.timeToX(tlView, layer.start);
  const x1 = timelineView.timeToX(tlView, timelineModel.endOf(layer));
  drag.ghost.style.left = x0 + 'px';
  drag.ghost.style.width = Math.max(2, x1 - x0) + 'px';
  clip.classList.add('layer-clip--leaving');
}

// V2.9.1 item 4. How near a clip's end has to be drawn to a neighbour's before
// the two meet: "Let the end/start of tracks on the same layer snap together
// perfectly if they are only a few pixel apart when dragged". The same reach as
// FADE_SNAP_PX, and in pixels for the same reason: it is the gap on screen
// being aimed at. A number of its own rather than that name, which is declared
// further down the file and is not there yet when this line runs.
const CLIP_SNAP_PX = 5;

/**
 * Every line a dragged fade or trimmed edge can land on: the playhead, and the
 * start, the end and the two fade lines of every other clip on any row. Its
 * own group is left out, its sound starting, ending and fading where the
 * picture does, so its lines are the clip's own.
 *
 * V2.9.1, and the additions sent after it: "while trimming/extending a track
 * make it snap to fade in/out and start/end of other layers tracks", and "Let
 * fade sliders also snap to other layers tracks fade sliders". A fade line is
 * only offered while there is a fade, since a fade of nothing stands on the
 * clip's own edge, which is offered already.
 */
function snapLines(layer) {
  const own = new Set(timelineModel.groupOf(layers, layer.id).map((l) => l.id));
  const lines = [{ at: compositeAt, layerId: null, part: 'playhead' }];
  for (const l of layers) {
    if (own.has(l.id)) continue;
    const end = timelineModel.endOf(l);
    const fades = timelineModel.fadesOf(l);
    lines.push({ at: l.start, layerId: l.id, part: 'start' });
    lines.push({ at: end, layerId: l.id, part: 'end' });
    if (fades.in > 0) lines.push({ at: l.start + fades.in, layerId: l.id, part: 'in' });
    if (fades.out > 0) lines.push({ at: end - fades.out, layerId: l.id, part: 'out' });
  }
  return lines;
}

/** The element on screen that stands for a snap line. */
function snapLineElement(line) {
  if (!line) return null;
  if (line.part === 'playhead') return timelinePlayhead;
  const clip = timelineStack.querySelector('.layer-clip[data-layer-id="' + line.layerId + '"]');
  if (!clip) return null;
  return line.part === 'start' || line.part === 'end'
    ? clip.querySelector('.layer-clip__edge--' + line.part)
    : clip.querySelector('.clip-fade-line--' + line.part);
}

// "When fade or trim sliders snap by the few pixels, highlight the current
// dragged fade/trim slider and the one of the track it snapped to in green
// until it gets moved further or let go." A class on the two elements rather
// than anything drawn, so it goes with them and asks nothing of the canvas.
// Taken off and put back on each move, which is what makes it end the moment
// the pull is broken.
let snapLit = [];

function lightSnap(elements) {
  const next = elements.filter(Boolean);
  for (const e of snapLit) if (!next.includes(e)) e.classList.remove('snap-lit');
  for (const e of next) e.classList.add('snap-lit');
  snapLit = next;
}

/**
 * The value a clip drag is asking for, pulled onto a neighbour's edge when one
 * of the clip's own is within reach of it.
 *
 * The neighbours are the clips on the row the clip is on, or on the row it is
 * being carried to, since that is where it will land. A move carries both of
 * the clip's ends, so either can meet something; a trim carries the one edge.
 * Its own group is left out: those are on another row by kind anyway, and the
 * one thing they must never do is pull the clip onto itself.
 */
//
// Hands back the value, the line it landed on or null for none, and which of
// the clip's own ends met it.
//
// Both reach every row since the additions after V2.9.1. A trimmed or extended
// edge lands on any of snapLines', the playhead included: "Same as for fade
// in/out". A moved clip lands either of its ends on the other clips' starts,
// ends and fade lines: "When moving tracks across the timeline, let it snap to
// other layers tracks start/end and fade in/out sliders with highlights as
// well". Not on the playhead, which that did not ask for. `lane` is no longer
// needed to find the neighbours, since every row is searched, and is kept so
// the caller reads the same as before.
function snapClipValue(layer, edge, value, lane) {
  const lines = edge
    ? snapLines(layer)
    : snapLines(layer).filter((line) => line.part !== 'playhead');
  const offsets = edge ? [0] : [0, layer.duration];
  let best = null;
  let hit = null;
  let side = null;
  for (const line of lines) {
    for (const off of offsets) {
      const gap = line.at - (value + off);
      if (Math.abs(gap) * tlView.scale > CLIP_SNAP_PX) continue;
      if (best === null || Math.abs(gap) < Math.abs(best)) {
        best = gap;
        hit = line;
        side = edge || (off === 0 ? 'start' : 'end');
      }
    }
  }
  return best === null
    ? { value, line: null, side: null }
    : { value: value + best, line: hit, side };
}

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

    const rect = timelineLane.getBoundingClientRect();
    // The fit is frozen for the duration of the drag. A layer dragged
    // rightwards on a fitted view makes the project longer, which would rescale
    // the ruler under the drag and leave the clip forever chasing the cursor.
    // noteTimelineFit on release works out whether it is the fitted view again.
    tlFitted = false;
    const drag = {
      anchorX: evt.clientX,
      anchorY: evt.clientY,
      anchorValue: valueOf(layer),
      factor: modifierFactor(evt),
      moved: false,
      // V2.9. The row a move is aimed at, and the box drawn on it. A trim
      // never has one: an edge belongs to the row its clip is on.
      target: null,
      ghost: null,
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
        // Either way counts now that a clip can be carried up or down as well.
        const far = Math.max(Math.abs(ev.clientX - drag.anchorX),
          edge ? 0 : Math.abs(ev.clientY - drag.anchorY));
        if (far < TIMELINE_DRAG_SLOP) return;
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
      const here = timelineModel.layerById(layers, layerId);
      if (!here) return;
      // The row first, because the neighbours to snap to are the ones on the row
      // the clip will land on.
      if (!edge) drag.target = laneTargetAt(here.type, here.lane, ev.clientY);
      const lane = drag.target ? drag.target.lane : here.lane;
      const snap = snapClipValue(here, edge, drag.anchorValue + delta, lane);
      apply(snap.value);
      // Green on the end that met something and on what it met, while it is
      // held: the grip being dragged for a trim, and for a move whichever of
      // the clip's two ends it was.
      lightSnap(snap.line
        ? [clip.querySelector('.layer-clip__edge--' + snap.side), snapLineElement(snap.line)]
        : []);
      if (!edge) {
        const now = timelineModel.layerById(layers, layerId);
        if (now) placeLaneGhost(drag, clip, now);
      }
    };
    const onUp = (ev) => {
      clip.classList.remove('layer-clip--dragging');
      document.body.classList.remove('layer-dragging', 'layer-trimming');
      lightSnap([]);
      setDragHint(1.0);
      noteTimelineFit(rect.width);
      // V2.9. The row and the start in one commit, so one undo takes back the
      // whole move. Only this clip changes row: its group went with it in time
      // and stays where it is in rows, which the user settled on 2026-09-25 and
      // asked for again in V2.9.1: "the sound should not follow into Audio 1
      // but stay on Audio 2". The row it leaves stays, empty if it was the only
      // clip there, for the reason a deleted clip's row does.
      const target = drag.target;
      drag.target = null;
      placeLaneGhost(drag, clip, null);
      if (drag.moved && target) {
        layers = timelineModel.setLayer(layers, layerId, { lane: target.lane });
      }
      // The commit point, and so Step 12's undo snapshot. A press that never
      // moved changed nothing and does not rebuild the rows, let alone take a
      // step.
      if (drag.moved) {
        setLayers(layers);
        commitHistory();
      }
    };
    beginDrag(clip, evt, onMove, onUp);
  });
}

// How far the pointer moves before a press on a fade handle is a drag. Smaller
// than the clip's own slop: the handle does one thing, so there is no second
// meaning for a short movement to be mistaken for.
const FADE_DRAG_SLOP = 2;

// V2.6. How near the playhead a fade's end has to be drawn before it lands on
// it: "Make the fade in/out sliders snap to the current position slider within
// a few pixels range." Pixels rather than seconds, because a few pixels is a
// different number of seconds at every zoom, and what the user is aiming at is
// the line they can see.
const FADE_SNAP_PX = 5;

/**
 * A fade length, snapped to the playhead when the two would be drawn together.
 *
 * The length that would put this fade's inner end exactly on the playhead is
 * worked out first, and the gap between that and the length the pointer is
 * asking for is the gap between the two lines on screen, because both go
 * through the same scale. So the test is the distance the user can see.
 *
 * Nothing is clamped here. A playhead outside the clip gives a length outside
 * the clip, and fadeGroup already holds every fade inside its own layer, which
 * is where that rule lives and where it should stay.
 */
function snapFadeToPlayhead(layer, which, want) {
  // V2.9.1 item 6: "When dragging a fade in/out slider, make it snap to the
  // start/end of tracks in other layers if its only a few pixel away", and the
  // addition after it, to their fade lines too. So the playhead is one of
  // several lines the fade's inner end can land on, all of them snapLines',
  // and the nearest within reach wins. Hands back the length and the line it
  // landed on, or null for none, so the two can be lit.
  let best = want;
  let hit = null;
  let gap = FADE_SNAP_PX;
  for (const line of snapLines(layer)) {
    const span = which === 'in' ? line.at - layer.start : timelineModel.endOf(layer) - line.at;
    const off = Math.abs(span - want) * tlView.scale;
    if (off <= gap) {
      gap = off;
      best = span;
      hit = line;
    }
  }
  return { value: best, line: hit };
}

/**
 * Drag a fade, from the handle in the corner or from the line it left behind.
 *
 * Both gestures are the same sum with a different starting point, which is why
 * they share this: the handle starts at nothing and the line starts at whatever
 * the fade already is. Inward from its own end, so a fade in grows as the
 * pointer goes right and a fade out grows as it goes left, which is what the
 * user described from each corner.
 *
 * Written into `layers` directly during the drag, exactly as bindClipDrag does
 * and for the same reason: setLayers rebuilds the rows and would destroy the
 * element the pointer is captured on. The commit, and so the undo step, is on
 * release, which answers the other half of the request: fades are undoable.
 */
function bindFadeDrag(node, layerId, which, fromZero) {
  node.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || busy) return;
    const layer = timelineModel.layerById(layers, layerId);
    if (!layer) return;
    // Nothing else gets this press: not the clip's move, not the edge's trim,
    // not the row's selection, which is done here instead.
    evt.stopPropagation();
    evt.preventDefault();
    selectLayer(layerId);
    // The fit is frozen for the drag, the same as a trim: a fade does not
    // change the project's length, but committing on release goes through
    // noteTimelineFit either way and this keeps the two paths alike.
    tlFitted = false;
    const rect = timelineLane.getBoundingClientRect();
    const sign = which === 'in' ? 1 : -1;
    const drag = {
      x: evt.clientX,
      from: fromZero ? 0 : timelineModel.fadesOf(layer)[which],
      moved: false,
    };
    document.body.classList.add('layer-fading');

    const onMove = (ev) => {
      if (!drag.moved) {
        if (Math.abs(ev.clientX - drag.x) < FADE_DRAG_SLOP) return;
        drag.moved = true;
      }
      // Seconds per pixel is the zoom, so the line travels with the cursor at
      // whatever the view is showing. The model clamps it to the clip.
      const want = drag.from + ((ev.clientX - drag.x) / tlView.scale) * sign;
      const snap = snapFadeToPlayhead(layer, which, want);
      layers = timelineModel.fadeGroup(layers, layerId, which, snap.value);
      // The fade's own line is what stands at its end, whichever of the handle
      // or the line is being dragged, so that is the one lit.
      const mine = node.closest('.layer-clip');
      lightSnap(snap.line
        ? [mine && mine.querySelector('.clip-fade-line--' + which), snapLineElement(snap.line)]
        : []);
      drawTimeline();
      // The picture at the playhead is what the fade is for, so it is redrawn
      // as the ramp changes rather than only once the drag is over.
      drawComposite();
    };
    const onUp = (ev) => {
      document.body.classList.remove('layer-fading');
      lightSnap([]);
      noteTimelineFit(rect.width);
      if (drag.moved) {
        setLayers(layers);
        commitHistory();
      }
    };
    beginDrag(node, evt, onMove, onUp);
  });
}

// How far the pointer moves before a press on the alpha bar is a drag. The
// same two pixels the fade handles use, on the other axis.
const ALPHA_DRAG_SLOP = 2;

/**
 * Drag the alpha bar up and down.
 *
 * The clip's own height is the scale, so a drag from the bottom of a clip to
 * the top is 0% to 100% whatever the rows have been set to. That is the same
 * arithmetic placeAlphaLine draws with, read backwards, which is what keeps the
 * bar under the pointer rather than near it.
 *
 * Written straight into `layers` during the drag and committed on release, for
 * the reason bindClipDrag and bindFadeDrag both are: setLayers rebuilds the
 * rows and would destroy the element the pointer is captured on. The commit is
 * also the undo step, so one drag is one Ctrl+Z.
 */
function bindAlphaDrag(node, layerId) {
  node.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || busy) return;
    const layer = timelineModel.layerById(layers, layerId);
    if (!layer) return;
    // Nothing else gets this press: not the clip's move, not a trim, not the
    // row's selection, which is done here instead.
    evt.stopPropagation();
    evt.preventDefault();
    selectLayer(layerId);
    // V2.5. The bar is the clip's sibling now, not its child, so the clip is
    // found through the track they share. The scale is the clip's border box
    // less one, which is alphaRow's, read backwards: the rectangle has that
    // many rows between its first and its last.
    const track = node.closest('.layer-track');
    const clip = track && track.querySelector('.layer-clip[data-layer-id="' + layerId + '"]');
    const span = Math.max(1, clip ? clip.offsetHeight - 1 : 1);
    const rect = timelineLane.getBoundingClientRect();
    const drag = { y: evt.clientY, from: timelineModel.alphaOf(layer), moved: false };
    document.body.classList.add('layer-alpha');

    const onMove = (ev) => {
      if (!drag.moved) {
        if (Math.abs(ev.clientY - drag.y) < ALPHA_DRAG_SLOP) return;
        drag.moved = true;
      }
      // Up is more, because the line's height is its value and a line that fell
      // as the hand rose would be a control that argues with its own readout.
      // The model clamps it to 0 and 1.
      layers = timelineModel.setAlpha(layers, layerId, drag.from + (drag.y - ev.clientY) / span);
      drawTimeline();
      // The picture at the playhead is the whole point of the control, so it is
      // redrawn as the bar moves rather than once the drag is over.
      drawComposite();
    };
    const onUp = (ev) => {
      document.body.classList.remove('layer-alpha');
      noteTimelineFit(rect.width);
      if (drag.moved) {
        setLayers(layers);
        commitHistory();
      }
    };
    beginDrag(node, evt, onMove, onUp);
  });
}

// ---- tracks that are not there yet, V2.8 item 5 ----
//
// renderLayerRows used to append one empty video row and one empty audio row
// every time it ran, so the rows were derived and always there. The user, on
// 2026-09-24: "Instead of having an 'Video 2 / Audio 2' or X layer prepared,
// simply put an 'Add a new Track' as title after the active/used layers".
//
// An empty row is therefore something asked for, which means it is state. It is
// deliberately **not** in `layers` and not in history: an empty row has nothing
// to save, nothing to undo and nothing to export.
//
// V2.9.1. The state is now how many rows of each kind are shown, rather than a
// list of empty ones kept after the full ones. Two things asked for at once
// made the change: "When a track gets deleted and the layer is empty now, do
// not auto-delete it", which means an empty row can sit between two full ones,
// and "Make empty layers right-clickable" and every other way into a row,
// which is simplest when an empty row is a lane like any other that happens to
// have nothing on it. So every row is lane 0 to rowsOf(type) - 1, full or not,
// and the count only ever grows by itself: renderLayerRows writes back what it
// drew, so a row that loses its last clip is still counted. It shrinks when a
// row's delete button is pressed, and it starts again from what the layers
// need when a project is opened or a step is undone.
let laneRows = { video: 0, audio: 0 };

// At least one of each kind, which is the user's amendment to V2.8 item 5:
// "Video 1 and Audio 1 should be default".
function rowsOf(type) {
  return Math.max(1, laneRows[type] || 0, timelineModel.laneCount(layers, type));
}

function resetLaneRows() {
  laneRows = { video: 0, audio: 0 };
}

function addEmptyRow(type) {
  laneRows[type] = rowsOf(type) + 1;
  renderLayerRows();
}

/**
 * A row's delete button, full or empty. The rows under it move up, which is the
 * one time lanes are renumbered.
 */
function deleteRow(type, lane) {
  laneRows[type] = rowsOf(type) - 1;
  setLayers(timelineModel.removeLane(layers, type, lane));
  commitHistory();
}

function buildEmptyRow(type, lane, removable) {
  const row = document.createElement('div');
  row.className = 'layer-row layer-row--' + type + ' layer-row--empty';
  row.dataset.type = type;
  row.dataset.lane = String(lane);

  const head = document.createElement('div');
  head.className = 'layer-head';
  const top = document.createElement('div');
  top.className = 'layer-head__top';
  const name = document.createElement('div');
  name.className = 'layer-name';
  name.textContent = layerLabel(type, lane + 1);
  top.appendChild(name);
  // A row that was asked for has to be refusable as well, or one added by
  // mistake stays for the rest of the session with nothing to do about it. The
  // same button the real rows carry, doing the only thing there is to do to a
  // track with nothing in it.
  //
  // The last row of a kind has no button: one of each always stands ready, so
  // there is nothing to take back and a button would only put it straight
  // back on the next draw.
  if (removable) {
    top.appendChild(makeButton('layer-btn layer-btn--delete', '✕', t('Delete layer'),
      () => deleteRow(type, lane)));
  }
  head.appendChild(top);

  const track = document.createElement('div');
  track.className = 'layer-track';
  track.dataset.emptyType = type;
  track.dataset.type = type;
  track.dataset.lane = String(lane);
  const empty = document.createElement('div');
  empty.className = 'layer-empty';
  const text = document.createElement('span');
  text.textContent = type === 'audio' ? t('No Audio track') : t('No Video track');
  empty.appendChild(makeButton('', t('Open File'), '',
    () => openIntoLayer(type, null, lane)));
  empty.appendChild(text);
  track.appendChild(empty);

  row.appendChild(head);
  row.appendChild(track);
  return row;
}

/**
 * The block under the rows: a title, the two ways to make a track, a way to
 * open a file straight into one, and the words that say a file can simply be
 * dropped here.
 *
 * **It is also the drop zone advanced editing now depends on.** V2.6 took the
 * frame at the top out of the drop path on the argument that there is always an
 * empty layer row to drop onto; item 5 takes those rows away, so the argument
 * has to survive somewhere, and this is where. It is always present, whatever
 * the timeline holds.
 *
 * 'auto' rather than a type: a file dropped here becomes the kind of track the
 * file is, which is the same rule the frame at the top followed before V2.6.
 */
function buildAddRow() {
  const row = document.createElement('div');
  row.className = 'layer-add';

  const head = document.createElement('div');
  head.className = 'layer-add__head';
  head.textContent = t('Add a new Layer');
  row.appendChild(head);

  const body = document.createElement('div');
  body.className = 'layer-add__body';
  body.dataset.emptyType = 'auto';
  body.appendChild(makeButton('layer-add__btn', t('New Video Layer'), '',
    () => addEmptyRow('video')));
  body.appendChild(makeButton('layer-add__btn', t('New Audio Layer'), '',
    () => addEmptyRow('audio')));
  body.appendChild(makeButton('layer-add__btn', t('Open File'), '',
    () => openIntoLayer('auto', null, null)));
  const hint = document.createElement('span');
  hint.className = 'layer-add__hint';
  hint.textContent = t('or drag and drop any supported file here');
  body.appendChild(hint);
  row.appendChild(body);
  return row;
}

function renderLayerRows() {
  const stack = timelineStack;
  stack.replaceChildren();
  // Each kind's empty rows follow its real ones, so the video block and the
  // audio block stay whole, and the numbering carries on from the layers that
  // are already there.
  for (const type of ['video', 'audio']) {
    // V2.9. A row per lane, holding every clip on it. V2.9.1: and a row for
    // every lane with nothing on it, wherever it is, down to the number of rows
    // this kind has been showing. One row of each kind stands ready while there
    // is nothing of that kind at all, which is the user's amendment to V2.8
    // item 5: "Video 1 and Audio 1 should be default, but no auto-adding Video
    // 2 if Video 1 gets track loaded in it".
    const lanes = timelineModel.lanesOf(layers, type);
    const shown = rowsOf(type);
    for (let lane = 0; lane < shown; lane += 1) {
      const members = lanes[lane];
      stack.appendChild(members && members.length
        ? buildLaneRow(type, lane, members)
        : buildEmptyRow(type, lane, shown > 1));
    }
    laneRows[type] = shown;
  }
  stack.appendChild(buildAddRow());
  positionLayerClips();
}

/** Every clip placed against the same view the ruler is drawn against. */
function positionLayerClips() {
  const trackW = timelineLane.clientWidth;
  // V2.9. Clip by clip rather than track by track, since a track holds several.
  for (const clip of timelineStack.querySelectorAll('.layer-clip[data-layer-id]')) {
    const layer = timelineModel.layerById(layers, clip.dataset.layerId);
    const track = clip.parentElement;
    if (!layer || !track) continue;
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
    // Before the marks, which inset themselves past the fade handle once they
    // know whether it is on show.
    placeFadeGrips(clip, layer, x0, width, gripW);
    placeClipMarks(clip, width, from, visible, gripW);
    placeAlphaLine(track, clip, layer, x0, from, visible, gripW);
    drawClipArt(layer, art, x0 + from, visible, clip.clientHeight);
  }
}

// How wide one clip mark is, and the gap between two, matching the stylesheet.
// Taken as numbers rather than measured: this runs for every clip on every pan
// and zoom frame, and reading offsetWidth there is a layout per clip per frame
// to learn something that never changes.
const CLIP_MARK_W = 17;
const CLIP_MARK_GAP = 3;
// And how wide a fade handle is, for the same reason.
const CLIP_FADE_W = 19;
// And the alpha bar, matching the stylesheet on both counts. The height is the
// grab area's, not the three pixels drawn down the middle of it.
const CLIP_ALPHA_W = 44;
const CLIP_ALPHA_H = 11;
// The clip's own border, also from the stylesheet. The alpha row is measured
// against the rectangle a person sees, and that includes it.
//
// The row itself is layerGeometry.alphaRow, in the file the main process shares,
// because four drawings read it: the line, the bar that moves it, and the top of
// each of the two fade ramps.
const CLIP_BORDER = 1;

/**
 * The two fade handles, and the line each fade has left on the clip.
 *
 * The handles are hidden on a clip with no room for them beside the grips, the
 * same rule the marks follow and for the same reason: a control the width of
 * its own row is not a control. The lines are not, because a line is a fact
 * about the layer rather than something to press, and a clip zoomed down to
 * nothing should still show that it fades.
 */
function placeFadeGrips(clip, layer, x0, width, gripW) {
  const fades = timelineModel.fadesOf(layer);
  const room = width >= 2 * (CLIP_FADE_W + gripW) + 12;
  for (const dot of clip.querySelectorAll('.clip-fade-dot')) dot.hidden = !room;
  for (const line of clip.querySelectorAll('.clip-fade-line')) {
    const which = line.dataset.fadeLine;
    const span = fades[which];
    line.hidden = !(span > 0);
    if (!(span > 0)) continue;
    // Against the clip's own left edge, since that is what it is positioned in.
    const at = which === 'in'
      ? layer.start + span
      : timelineModel.endOf(layer) - span;
    line.style.left = (timelineView.timeToX(tlView, at) - x0) + 'px';
  }
}

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
  // And past the fade handle in that corner, when there is one. It stands at
  // the clip's true right edge, so it is only in the way under the same
  // condition the grip is: when that edge is on screen at all.
  const fade = clip.querySelector('.clip-fade-dot--out');
  const fadeW = (endOnScreen && fade && !fade.hidden) ? CLIP_FADE_W + CLIP_MARK_GAP : 0;
  marks.style.right = (width - (from + visible)
    + (endOnScreen ? gripW : 0) + fadeW) + 'px';
}

/**
 * The alpha line and the bar that moves it.
 *
 * The user set the scale: "From 100% to 0% height of the track." So the line's
 * height inside the clip **is** the value, top for whole and bottom for gone,
 * and nothing has to be read anywhere to see what a layer is set to.
 *
 * The bar sits in the middle of whatever part of the clip is on screen rather
 * than in the middle of the clip. A clip can be a quarter of a million pixels
 * wide at full zoom, and a control at its true centre is a control nobody can
 * reach. The line is given the same stretch, for the reason the art canvas is:
 * out here in the track it is no longer a child of the thing that was clipping
 * it, and an element as wide as a fully zoomed clip is an element nobody needs.
 *
 * V2.5. Both are placed in the track's pixels, which is why every measurement
 * here starts from the clip's own offset within it.
 */
function placeAlphaLine(track, clip, layer, x0, from, visible, gripW) {
  // By id, because the track holds a line and a bar for every video clip on it.
  const mine = '[data-layer-id="' + layer.id + '"]';
  const line = track.querySelector('.clip-alpha-line' + mine);
  if (!line) return;
  const alpha = timelineModel.alphaOf(layer);
  const row = clip.offsetTop + layerGeometry.alphaRow(clip.offsetHeight, alpha);

  // V2.8. The line runs between the fades rather than under them: "Hide the max
  // alpha horizontal line inside the fade in/out areas, there is already the
  // diagonal". Inside a fade the ramp is what the alpha is, so a flat line
  // across it would be drawing a value the layer does not have there.
  //
  // Both ends are already known to two other drawings: the ramps stop at this
  // row and the two vertical fade lines stand at these exact seconds. Taking
  // the seconds and converting here, rather than reading the elements, keeps
  // this the same kind of sum as everything else in this function.
  const fades = timelineModel.fadesOf(layer);
  const lo = Math.max(x0 + from,
    timelineView.timeToX(tlView, layer.start + fades.in));
  const hi = Math.min(x0 + from + visible,
    timelineView.timeToX(tlView, timelineModel.endOf(layer) - fades.out));
  const span = hi - lo;
  // Fades that meet leave no middle to draw in, and then the two diagonals are
  // the whole picture, which is what the user says is enough.
  line.hidden = span < 1;
  line.style.top = Math.round(row) + 'px';
  line.style.left = Math.round(lo) + 'px';
  line.style.width = Math.max(0, Math.round(span)) + 'px';

  const grip = track.querySelector('.clip-alpha-grip' + mine);
  if (!grip) return;
  // Room between the two trim grips and the two fade handles, or it goes: the
  // rule the marks already follow, because a control the width of its own row
  // is not a control. The handles are in it because the bar now outranks them
  // for a press, being the later element, and on a clip this narrow the bar at
  // full alpha would sit across both corners and swallow them.
  grip.hidden = visible < 2 * (gripW + CLIP_FADE_W) + CLIP_ALPHA_W + 16;
  if (grip.hidden) return;
  // V2.8. The bar rides the line now. It is the line's handle, and a handle
  // standing over a stretch with no line under it is pointing at nothing. The
  // middle of the visible part is still where it wants to be, for the reason
  // above, so that is where it goes whenever the line reaches that far.
  const half = CLIP_ALPHA_W / 2;
  const want = span >= CLIP_ALPHA_W
    ? Math.min(Math.max(x0 + from + visible / 2, lo + half), hi - half)
    : (lo + hi) / 2;
  // And inside the visible part whatever the fades are doing, or a clip scrolled
  // half off screen would put its only alpha control off the screen with it.
  const mid = Math.min(Math.max(want, x0 + from + half),
    x0 + from + visible - half);
  grip.style.left = Math.round(mid - half) + 'px';
  // Centred on the line and not held anywhere: the track has four pixels of
  // room above the clip and four below, which is more than the bar needs to
  // straddle either edge, and that is the whole reason it moved out here. The
  // grab area is the element and the bar is the three pixels down the middle of
  // it, so the row lands under the bar when the element is lifted by half.
  grip.style.top = Math.round(row - (CLIP_ALPHA_H - 1) / 2) + 'px';
  // The percentage after the sentence rather than inside it, so the checker
  // still sees a plain literal after t( and the number never has to be
  // translated.
  grip.title = t('Drag up or down to set this layer maximum alpha')
    + ' (' + Math.round(alpha * 100) + '%)';
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
//
// Step 21d. A filmstrip is no longer one sheet. Past the density a single sheet
// can hold, a sheet covers a window of the source instead of all of it, so a
// layer holds several: the whole-clip one, which covers every second of it and
// is what keeps the strip drawn, and the windows the view is over. A column
// draws from the densest sheet that covers its own second of the source.

const stripCache = new Map();   // src -> { sheets, pending, dead, maxDensity }
const peakCache = new Map();    // src -> { want, buckets, peaks, pending }

// How many windowed sheets one layer holds. The visible span can straddle one
// boundary and never more than one, so two is enough to draw with and the third
// is what makes panning back across a boundary free. This is memory rather than
// bookkeeping: each one is a decoded JPEG of up to about 2300x1900.
const STRIP_SHEETS = 3;

function clipArtColours(type) {
  return type === 'audio'
    ? { wave: '#a6d8b4', mid: 'rgba(200, 235, 210, 0.35)' }
    : { wave: '#8fa8d8', mid: 'rgba(200, 215, 240, 0.3)' };
}

/**
 * Forget the sheets of sources no layer holds any more.
 *
 * Step 21d, and it is about memory rather than tidiness. A sheet is a decoded
 * JPEG of up to about 2300x1900, and a source now keeps up to four of them
 * where it used to keep one, so a session that opened several long clips in
 * turn would hold every sheet it had ever fetched for the rest of its life.
 *
 * The peaks are left alone: an audio layer's entry is an array of numbers, and
 * it was not costing anything before this step either.
 */
function dropUnusedStrips() {
  const used = new Set(layers.map((l) => l.src));
  for (const src of [...stripCache.keys()]) {
    if (!used.has(src)) stripCache.delete(src);
  }
}

/**
 * The sheet to draw second `at` of the source from: the densest one covering it.
 *
 * Thumbnails per second is what makes two sheets comparable when one covers the
 * whole clip in 1024 and another covers a sixteenth of it in 1024.
 */
function sheetAt(entry, at) {
  let best = null;
  for (const sheet of (entry && entry.sheets) || []) {
    const { start, span, tiles } = sheet.info;
    // Inclusive at the far end, so the last second of the clip is covered by
    // the window that ends on it rather than by nothing.
    if (at < start || at > start + span) continue;
    if (!best || tiles / span > best.info.tiles / best.info.span) best = sheet;
  }
  return best;
}

/** The whole-clip sheet, the one that covers every second of the source. */
const wholeSheet = (entry) =>
  ((entry && entry.sheets) || []).find((s) => s.info.chunks === 1) || null;

/**
 * The sheets worth keeping once another has arrived.
 *
 * A sheet covering the same window replaces the one that was there, which is
 * what carries a whole-clip sheet from 32 thumbnails up to 1024 as the view
 * zooms without leaving the coarse ones lying about. The whole-clip sheet
 * itself is never evicted: it is the fallback the strip stays drawn from.
 */
function keepSheets(sheets, added) {
  const key = (s) => s.info.chunks + ':' + s.info.index;
  const kept = [added, ...sheets.filter((s) => key(s) !== key(added))];
  const whole = kept.find((s) => s.info.chunks === 1);
  const windows = kept.filter((s) => s !== whole).slice(0, STRIP_SHEETS);
  return whole ? [...windows, whole] : windows;
}

/**
 * Make sure something dense enough to draw second `at` of this layer exists.
 *
 * One request in flight per source, as before: a reply calls drawTimeline, which
 * asks again for whatever is still missing, so two windows on screen are fetched
 * one after the other rather than at once.
 */
async function ensureStrip(layer, want, at) {
  const entry = stripCache.get(layer.src);
  if (entry && (entry.pending || entry.dead)) return;
  const sheets = (entry && entry.sheets) || [];

  // The whole-clip sheet comes first whatever the zoom is, because it is the
  // one that covers every second of the source. A project opened already zoomed
  // in would otherwise have nothing to draw the moment it panned past the edge
  // of the one window it had fetched. Asking with no want is asking for the
  // coarsest, which is a sheet that cannot be windowed.
  let ask = want;
  let askAt = at;
  if (!wholeSheet(entry)) {
    ask = 0;
    askAt = 0;
  } else {
    // What the view is asking for, in thumbnails per second of source, held to
    // what this source can be extracted at. Past that the reply is the same
    // sheet every time, and asking for it on every frame is what this would
    // otherwise become.
    const density = Math.min(
      layer.sourceDuration > 0 ? want / layer.sourceDuration : 0,
      entry.maxDensity || Infinity);
    const have = sheetAt(entry, at);
    if (have && have.info.tiles / have.info.span >= density) return;
  }

  stripCache.set(layer.src, { ...(entry || {}), sheets, pending: true });
  try {
    const result = await window.lwclipper
      .filmstrip(layer.src, layer.sourceDuration, ask, askAt);
    const now = stripCache.get(layer.src) || {};
    if (!result.ok || !result.data) {
      // No video stream, or ffmpeg could not read one. The clip keeps its plain
      // bar rather than the frame going quiet about it.
      stripCache.set(layer.src, { ...now, dead: true, pending: false });
      return;
    }
    const url = await window.lwclipper.fileUrl(result.data.file);
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    stripCache.set(layer.src, {
      ...now,
      sheets: keepSheets(now.sheets || [], { info: result.data, img }),
      maxDensity: result.data.maxDensity,
      pending: false,
    });
    drawTimeline();
  } catch {
    stripCache.set(layer.src,
      { ...(stripCache.get(layer.src) || {}), dead: true, pending: false });
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
  if (!(width > 0) || !(height > 0) || (!layer.src && layer.kind !== 'gen')) return;
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
  else if (layer.kind === 'gen') drawClipGen(layer, ctx, leftX, width, height);
  else if (layer.kind === 'image') drawClipStill(layer, ctx, leftX, width, height);
  else drawClipFilmstrip(layer, ctx, leftX, width, height);
  drawClipFades(layer, ctx, leftX, width, height);
}

/**
 * The two fade ramps, drawn over whatever the clip shows.
 *
 * The picture the user described, in their words: "For fade in: A diagonal grey
 * line goes from the bottom left of the tracks start to the top right of the
 * fade-in-end line. For fade-out its reversed, from the top left of the
 * fade-out-start line to the bottom right end of the track."
 *
 * Straight, because the ramp really is straight. fadeAlphaAt works out a linear
 * ramp and ffmpeg's fade filter draws one, so a curve here would be a drawing
 * of something that does not happen. "Only linear fading for now, no curves."
 *
 * V2.5. It stops at the alpha line rather than at the top of the clip, and so
 * its angle follows the bar: "The diagonal fade in/out bar should only get as
 * high as the max alpha bar is." That is also the truer picture, and the
 * clearest evidence that the two controls really do multiply. The file does the
 * same sum in the same order: colorchannelmixer stands after the fade filters
 * and multiplies what they hand it, so a layer at 60% that fades in really does
 * level off at 60% and never reaches the top of anything.
 *
 * The vertical line at each fade's inner end is not drawn here: it is the
 * element that drags it, so that what is on the screen and what takes the
 * pointer are one thing rather than two kept level by hand.
 */
// V2.9.1 item 5. Which clip each transition's later clip covers, and by how
// much, worked out once per list rather than once per clip per frame: this is
// read from drawClipFades, which runs for every clip on every pan and zoom.
let transitionCache = { of: null, into: new Map() };

function transitionInto(layer) {
  if (transitionCache.of !== layers) {
    const into = new Map();
    for (const [pair, o] of timelineModel.overlapsOf(layers)) {
      const [a, b] = pair.split('|');
      into.set(b, { from: a, overlap: o });
    }
    transitionCache = { of: layers, into };
  }
  return transitionCache.into.get(layer.id) || null;
}

function drawClipFades(layer, ctx, leftX, width, height) {
  const fades = timelineModel.fadesOf(layer);
  if (!fades.in && !fades.out) return;
  // The canvas covers only the part of the clip on screen, so a ramp that runs
  // off the side is clipped by the canvas rather than by any sum here.
  const xAt = (t) => timelineView.timeToX(tlView, t) - leftX;
  // The canvas is the clip's content box and the row is measured in its border
  // box, so the border comes back off. An audio layer has no alpha and reads as
  // 1, which puts the top of its ramp where it has been since V2.2.
  const top = layerGeometry.alphaRow(height + 2 * CLIP_BORDER,
    timelineModel.alphaOf(layer)) - CLIP_BORDER;
  ctx.save();
  ctx.strokeStyle = 'rgba(224, 228, 238, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (fades.in > 0) {
    ctx.moveTo(xAt(layer.start), height);
    ctx.lineTo(xAt(layer.start + fades.in), top);
  }
  if (fades.out > 0) {
    const end = timelineModel.endOf(layer);
    ctx.moveTo(xAt(end - fades.out), top);
    ctx.lineTo(xAt(end), height);
  }
  // V2.9.1 item 5. Where this clip is the later of two overlapping on a lane,
  // the earlier one's way out is drawn across the overlap too, so the two
  // ramps cross: "When Tracks overlap one should fade out while the other fades
  // in". On screen that is exactly what happens, and the sum is why only one of
  // them carries a fade: the clip on top covering the one under it by t is
  // what takes the one under it down by t, so out = t * right + (1 - t) * left.
  // Giving the one underneath a fade of its own as well would take it down
  // twice and leave the middle at three quarters of the light. The earlier
  // clip is under this one here and cannot show its own ramp, so this one
  // draws it. Only while the fade is still the one the overlap wrote: a fade
  // changed by hand since is somebody's own and is drawn as just that.
  const cross = transitionInto(layer);
  if (cross && Math.abs(fades.in - cross.overlap) < 1e-6) {
    const under = timelineModel.layerById(layers, cross.from);
    const underTop = under
      ? layerGeometry.alphaRow(height + 2 * CLIP_BORDER, timelineModel.alphaOf(under)) - CLIP_BORDER
      : top;
    ctx.moveTo(xAt(layer.start), underTop);
    ctx.lineTo(xAt(layer.start + cross.overlap), height);
  }
  ctx.stroke();
  ctx.restore();
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

/**
 * A still's clip: its own picture, over and over.
 *
 * No filmstrip and no round trip to ffmpeg. Every second of a still is the same
 * second, so asking the main process to extract a sheet of identical thumbnails
 * and cache it on disk would be work done to learn something already decoded
 * and sitting in the window.
 *
 * Tiled from the clip's own left edge rather than from the canvas's, which is
 * only the visible part of it. Anchored anywhere else the tiles would slide
 * under a pan while the picture stood still.
 */
function drawClipStill(layer, ctx, leftX, width, height) {
  const entry = decoders.get(layer.id);
  if (!entry || !entry.width || !entry.height) return;
  // The same rule the filmstrip follows: the strip shows what the render will,
  // so a cropped layer shows the cropped part of its picture.
  const win = cropWindow(layer);
  const sw = entry.width * win.w;
  const sh = entry.height * win.h;
  if (!(sw > 0) || !(sh > 0)) return;
  const drawW = Math.max(4, sw * (height / sh));
  const clipX = timelineView.timeToX(tlView, layer.start);
  let x = -((((leftX - clipX) % drawW) + drawW) % drawW);
  for (; x < width; x += drawW) {
    ctx.drawImage(entry.el,
      entry.width * win.x, entry.height * win.y, sw, sh,
      x, 0, drawW, height);
  }
}

/**
 * V3. What a generated clip looks like on the timeline: a bar is its colour,
 * over a checkerboard so its alpha shows, and a text is its own words in its
 * own font, held at the left of whatever part of the clip is on screen so a
 * long clip scrolled halfway still says what it is.
 *
 * Not the picture, which is what an image clip shows: a frame of mostly
 * nothing with a line of text in the middle is unreadable at clip height.
 */
function drawClipGen(layer, ctx, leftX, width, height) {
  if (layer.gen) genKind(layer.gen).drawClip(layer, ctx, leftX, width, height);
}

function drawClipFilmstrip(layer, ctx, leftX, width, height) {
  const entry = stripCache.get(layer.src);
  // Step 11. The sheet holds whole source frames, so a crop is the same
  // fractions of a tile that it is of the frame, and the strip shows what the
  // render will rather than what the file happens to contain.
  const win = cropWindow(layer);
  // Any sheet answers for the tile size: every sheet of one source has the same
  // one, since it comes from the source frame and the extraction height and not
  // from how much of the clip the sheet covers.
  const sized = entry && entry.sheets && entry.sheets[0];
  const tileW = sized ? sized.info.tileWidth * win.w : 0;
  const tileH = sized ? sized.info.tileHeight * win.h : 0;
  // How wide one thumbnail is on screen once scaled to the row's height. The
  // cropped part of it, so a 9:16 crop shows as a narrow thumbnail.
  const drawW = sized ? Math.max(4, tileW * (height / tileH)) : 48;
  // Thumbnails across the whole source. It follows the zoom and not the clip's
  // length: thirty minutes at fit-to-width asks for the same handful a thirty
  // second clip does. Past what one sheet holds it is the density that carries
  // on rising, and the sheets cover windows instead of the whole source.
  const want = Math.ceil((layer.sourceDuration * tlView.scale) / drawW);
  const atFor = (px) =>
    timelineModel.sourceTimeFor(layer, timelineView.xToTime(tlView, leftX + px));
  // Step 21d. Both ends of what is on screen, because the visible span can
  // straddle one window boundary. Only one of the two can start a fetch, and
  // the other is asked again on the redraw that fetch ends with.
  ensureStrip(layer, want, atFor(0));
  ensureStrip(layer, want, atFor(Math.max(0, width - 1)));
  if (!entry || !entry.sheets || !entry.sheets.length) return;

  for (let px = 0; px < width; px += drawW) {
    const at = atFor(px);
    const sheet = sheetAt(entry, at) || wholeSheet(entry);
    if (!sheet) continue;
    const info = sheet.info;
    const index = Math.min(info.tiles - 1,
      Math.max(0, Math.floor((at - info.start) / info.interval)));
    const sx = (index % info.cols) * info.tileWidth + info.tileWidth * win.x;
    const sy = Math.floor(index / info.cols) * info.tileHeight + info.tileHeight * win.y;
    ctx.drawImage(sheet.img, sx, sy, tileW, tileH,
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
