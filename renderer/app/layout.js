'use strict';

// How the window divides its height and width: the preview fit, the split
// between preview and timeline, the frame handles and the layer column.

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
    // The frame's 16:9 height and the height it has, for previewFloor.
    ideal,
    height: Math.round(stage.height),
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

/**
 * How little of the timeline's tracks the handle may leave: none of them.
 *
 * This was 192 until 2026-09-23, four rows of 48, on the reasoning that a
 * one-video one-audio project should not be pushed into a scrollbar by its own
 * floor. The user asked for the other thing: the preview should go on growing
 * "until timeline has only the header/title left". A floor that keeps four rows
 * back is a floor that decides for them how much timeline they want to see.
 *
 * Nothing is left showing tracks at zero, which is the point, and the section
 * keeps its header row and its ruler because neither is in the stack. Dragging
 * back up brings the rows out from under the ruler they already sit below, so
 * there is nothing to reappear and nothing to jump.
 */
const SPLIT_STACK_FLOOR = 0;

/** The height the stack is held at, or null while the split is still the stylesheet's. */
let splitWish = null;
/** Whether the fit has been handed over yet. It is handed over once, and for the run. */
let splitTaken = false;
/** Where the stack was and where the pointer was when the drag started, or null. */
let splitFrom = null;

// ---- V2.1, 21c-2. Maximized is a second split, not the same one stretched ----
//
// Maximizing shares the extra height between the two in the proportion they
// already had, rather than putting the handle down the middle of the new space.
// That was put to the user when Step 17 was planned and the middle was rejected:
// a timeline of two tracks does not want half the screen.
//
// Which means the maximized split is kept as a **share of the room** while the
// restored-down one is kept as a height. That is not an inconsistency, it is
// what makes this work at all. Both the maximize and the unmaximize events fire
// after the window has already changed size, so the renderer may have laid out
// for the new size before it hears which state it is in. A height would have to
// know which room it was measured against and would be wrong for one of the two
// orders. A share is right against whichever room is current, so there is no
// order to get right.
let windowMaxed = false;
/** The share of the room the timeline holds when maximized. Null until the first one. */
let splitMaxShare = null;
/** The stack height last applied at the ordinary size. */
let splitNormalStack = 0;
/**
 * The last two rooms the window has had at the ordinary size, oldest first, each
 * with the moment it started. Two, because of what the first maximize has to
 * work out and cannot otherwise know.
 */
let splitRoomLog = [];

/** What the two frames have between them, which is the whole of what to divide. */
function splitRoom() {
  return timelineStack.getBoundingClientRect().height
    + previewSection.getBoundingClientRect().height;
}

/**
 * Remember what the split looks like at the ordinary window size, so the first
 * maximize has a proportion to carry up.
 *
 * The stack is passed in rather than measured, and that is not a shortcut: this
 * runs inside applySplit, before the property it just worked out has been laid
 * out, so a measurement here answers with the previous split. It read a drag one
 * step short every time, 317 where the stack was about to be 342.
 */
function noteNormalSplit(stack, room) {
  if (windowMaxed || room <= 0) return;
  splitNormalStack = stack;
  const newest = splitRoomLog[splitRoomLog.length - 1];
  if (newest && Math.abs(newest.room - room) <= 2) {
    // The same room it already had. Its age is when it started, not when it was
    // last looked at, which is the whole point of keeping the time.
    newest.room = room;
    return;
  }
  splitRoomLog.push({ room, at: Date.now() });
  if (splitRoomLog.length > 2) splitRoomLog.shift();
}

/**
 * The room the window had before it was maximized.
 *
 * Both window events fire after the window has already changed size, so by the
 * time the page hears which state it is in, it may have laid out for the new
 * room and recorded that as an ordinary one. The stack survives either order,
 * since a window resize is absorbed by the preview and leaves the timeline
 * where it is, so the only thing in doubt is the room, and it can be told apart
 * by its age: a resize that is part of a maximize arrives in the same breath as
 * the event announcing it, and one the user performed themselves is older.
 */
const SPLIT_SAME_BREATH = 400;

function roomBeforeMaxed() {
  const n = splitRoomLog.length;
  if (!n) return 0;
  const newest = splitRoomLog[n - 1];
  if (n > 1 && Date.now() - newest.at < SPLIT_SAME_BREATH) return splitRoomLog[n - 2].room;
  return newest.room;
}

/** The height the split is asking for, in whichever way this state keeps it. */
function splitWant(room) {
  if (windowMaxed) return splitMaxShare === null ? null : splitMaxShare * room;
  return splitWish;
}

/**
 * Maximized or restored down, as the main process reports it.
 *
 * The restored-down wish is never touched by any of this, which is the whole of
 * "the previous split comes back on restore": there is nothing to put back
 * because nothing took it away. And the maximized share outlives a restore, so
 * a second maximize opens on the split the first one was left at.
 */
function setWindowMaxed(maxed) {
  if (maxed === windowMaxed) return;
  const before = roomBeforeMaxed();
  windowMaxed = maxed;
  if (maxed && splitMaxShare === null && before > 0) {
    // The proportion the two had a moment ago, carried into a bigger room. Both
    // end up larger and neither ends up rearranged.
    splitMaxShare = splitNormalStack / before;
  }
  applySplit();
  drawTimeline();
  updatePlayhead();
}

/**
 * The smallest the preview section may be made, measured off the section as it
 * stands rather than stored, because both answers move with the window's width
 * and one of them moves with whether the video head is up.
 *
 * For a picture it is the height at which the frames are exactly 16:9, which is
 * the height fitWindow spends the window's own size to reach, and previewFit()
 * already measures how far off it is in whichever direction there is one. For
 * an audio project there is no ratio to keep, so the floor is where the
 * spectrum reaches the minimum the stylesheet already gives it.
 *
 * Both sums under-report a section that is already crushed, because the stage
 * stops at its own minimum while the rest of the section carries on shrinking,
 * and the distance to 16:9 stops growing with it. Under is the safe direction:
 * a floor read too low gives the stack room it should not have had, and the
 * next call, with the section no longer crushed, reads the real one. Over would
 * be a floor that fought the drag it was measured during.
 */
// V2.9.1. How far down the handle may press the frames, as a share of their
// 16:9 height: "Let the preview-timeline divider shrink down the preview frame
// until the frames are only 10% of their max width to height ratio so that the
// timeline can get much more expanded up if needed". It was the whole 16:9
// until then.
const PREVIEW_LEAST_SHARE = 0.1;

/** The least height a frame may be pressed to, in pixels, or null for audio. */
function frameLeast(fit) {
  return fit ? Math.max(1, Math.round(fit.ideal * PREVIEW_LEAST_SHARE)) : null;
}

function previewFloor() {
  const now = previewSection.getBoundingClientRect().height;
  const fit = previewFit();
  // What the section can give up is whatever it has spare, and then the frame
  // down to its least. The frame's own minimum in the stylesheet is held at the
  // same number by applySplit, or the frame would stop at 60px while this sum
  // went on believing it could shrink.
  if (fit) return now - fit.spare - fit.height + frameLeast(fit);
  const stage = previewStage.getBoundingClientRect().height;
  const least = parseFloat(getComputedStyle(previewStage).minHeight) || 0;
  return now - stage + least;
}

/**
 * Hold the stack at the height the handle was dragged to, inside what the
 * column can actually give it.
 *
 * Run on every window resize as well as on the drag, so a window made shorter
 * takes the room back from whichever of the two can spare it. What is clamped
 * is the applied height and never the wish, which is what hands the split back
 * whole when the window is made tall again, and what lets simple editing pass
 * through here with a stack of no height at all without losing anything.
 */
function applySplit() {
  // The preview is the only section in the column that grows, so every pixel
  // the stack takes comes out of it and the two of them together are a
  // constant. That sum is the whole of what there is to divide.
  const room = splitRoom();
  const want = splitWant(room);
  if (want === null) {
    document.documentElement.style.removeProperty('--split-stack');
    // Nothing is about to change, so the stack on the page is the stack.
    noteNormalSplit(timelineStack.getBoundingClientRect().height, room);
    return;
  }
  // The frames' own minimum first, so the floor below is measured against a
  // frame that is allowed to get that small.
  const least = frameLeast(previewFit());
  if (least === null) document.documentElement.style.removeProperty('--frame-least');
  else document.documentElement.style.setProperty('--frame-least', least + 'px');
  const held = layerGeometry.splitHeight(want, room, SPLIT_STACK_FLOOR, previewFloor());
  document.documentElement.style.setProperty('--split-stack', held + 'px');
  noteNormalSplit(held, room);
}

// ---- V2.1, 21c-3. The two handles between the three frames ----

/** The side column width the user dragged to, or null while it is the stylesheet's. */
let sideWish = null;
let sideFrom = null;
/** The floors for the gesture in hand, so the reflow happens once and not per move. */
let sideFloors = null;

/**
 * How near the even split a drag has to come before it takes it.
 *
 * Three equal frames is the layout everything starts at and the one worth
 * being able to get back to, and landing on it by hand means hitting one exact
 * pixel. What the snap writes is not a width but no width at all, so the
 * columns fall back to the stylesheet's own 1fr 1fr 1fr rather than to a
 * fraction that works out very nearly the same.
 */
const SIDE_SNAP = 8;

/**
 * The narrowest each of the three columns may be made, asked of the browser
 * rather than written down.
 *
 * A frame will shrink to anything, so what stops fitting first is the row of
 * controls underneath it, and how wide that is depends on the language and on
 * which mode is up: measured at a 940px grid, the sides come to 130 in both
 * languages because the time field has a width of its own, while the middle is
 * 132 with nothing loaded, 186 in advanced editing and 270 of that in German.
 * A constant would have been right for one of those.
 *
 * Taken at the press and not during the drag, because it costs a reflow: the
 * only way to ask an element what its contents need is to lay it out that way
 * and look. The same shape of answer as previewFloor, one gesture, one reading.
 */
function previewColumnFloors() {
  const natural = (node) => {
    if (!node) return 0;
    const was = node.style.width;
    node.style.width = 'min-content';
    const w = Math.ceil(node.getBoundingClientRect().width);
    node.style.width = was;
    return w;
  };
  const mins = [...previewGrid.querySelectorAll('.preview-cell')].map((cell) => Math.max(
    natural(cell.querySelector('.preview-cell__controls')),
    natural(cell.querySelector('.preview-cell__title'))));
  return {
    side: Math.max(mins[0] || 0, mins[2] || 0),
    middle: mins[1] || 0,
  };
}

/**
 * Put each grip level with the middle of the frame beside it.
 *
 * The cells are stretched to one height by the grid and that height is the
 * middle frame's, which is the tall one, so the middle of a cell is not the
 * middle of the frame it holds. The frames are what the handle divides, so the
 * frames are what it should line up with.
 *
 * Measured per handle rather than once for both: the two cells hold the same
 * shape of content, but a title that wraps in one language and not another
 * would move one of them and not the other.
 */
function placeSideGrips() {
  for (const handle of [sideSplitterLeft, sideSplitterRight]) {
    const cell = handle.closest('.preview-cell');
    const stage = cell && cell.querySelector('.frame-stage');
    if (!stage) continue;
    const cellBox = cell.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    // In audio editing the cells are display: contents and have no box at all,
    // so both of these read zero. Nothing is being shown there anyway, and a
    // grip placed from a rect that is not being laid out is the mistake this
    // file has now made four times.
    if (!(cellBox.height > 0) || !(stageBox.height > 0)) continue;
    handle.style.setProperty('--grip-mid',
      Math.round(stageBox.top - cellBox.top + stageBox.height / 2) + 'px');
  }
}

/** What the three columns divide between them: the grid, less its two gaps. */
function previewSpan() {
  const gap = parseFloat(getComputedStyle(previewGrid).columnGap) || 0;
  return previewGrid.getBoundingClientRect().width - 2 * gap;
}

/**
 * Hold the side columns at the width they were dragged to.
 *
 * Re-run on every window resize as well as on the drag, because the wish is a
 * width and the grid it sits in is not: a narrower window has to take the room
 * back from somewhere, and the clamp is what decides where.
 */
function applySideSplit() {
  if (sideWish === null) {
    document.documentElement.style.removeProperty('--preview-side');
  } else {
    const floors = sideFloors || previewColumnFloors();
    const fr = layerGeometry.sideFraction(sideWish, previewSpan(), floors.side, floors.middle);
    // A null fraction means there is nothing left to divide. The stylesheet's
    // own three equal columns are a better answer than one worked out from a
    // grid this narrow.
    if (fr === null) document.documentElement.style.removeProperty('--preview-side');
    else document.documentElement.style.setProperty('--preview-side', fr + 'fr');
  }
  // After the columns, never before: the frames are sized from the columns and
  // the grips are placed from the frames.
  placeSideGrips();
}

function bindSideSplitter(handle, sign) {
  handle.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0) return;
    const cell = handle.closest('.preview-cell');
    sideFrom = { x: evt.clientX, width: cell.getBoundingClientRect().width };
    sideFloors = previewColumnFloors();
    handle.setPointerCapture(evt.pointerId);
    document.body.classList.add('splitting-side');
    evt.preventDefault();
  });

  handle.addEventListener('pointermove', (evt) => {
    if (!sideFrom) return;
    // The left handle widens its column by moving right and the right handle by
    // moving left, which is the sign. Both write the one value, so either of
    // them moves both edges and the picture in the middle stays centred.
    const want = sideFrom.width + sign * (evt.clientX - sideFrom.x);
    // Within a few pixels of three equal frames, take three equal frames. Null
    // rather than a third of the span, because null is the stylesheet's own
    // 1fr 1fr 1fr and a third worked back into an fr is only nearly that.
    const even = previewSpan() / 3;
    sideWish = Math.abs(want - even) <= SIDE_SNAP ? null : want;
    applySideSplit();
    // The frames are 16:9 of their own width, so a narrower column is a shorter
    // one, and the window would want to resize itself to suit. That is the
    // fight Step 17 said to settle before building any of this, and it is
    // settled the same way the handle above the timeline settles it.
    if (!splitTaken) {
      splitTaken = true;
      window.lwclipper.releaseWindowHeight();
    }
    // The preview's height moved, so the split below it has a different room to
    // divide, and the crop outline is placed from the picture's own width.
    applySplit();
    updateCropOverlays();
  });

  const done = (evt) => {
    if (!sideFrom) return;
    sideFrom = null;
    sideFloors = null;
    document.body.classList.remove('splitting-side');
    if (handle.hasPointerCapture(evt.pointerId)) handle.releasePointerCapture(evt.pointerId);
  };
  handle.addEventListener('pointerup', done);
  handle.addEventListener('pointercancel', done);
}

bindSideSplitter(sideSplitterLeft, 1);
bindSideSplitter(sideSplitterRight, -1);

// The grips are placed from the frames, and the frames change size for reasons
// this file does not own: a layer arriving, the window sizing itself to 16:9, a
// language with a longer title, the split being dragged. Watching the frames is
// what makes the grip right in all of those without having to find every one of
// them, and the first thing a ResizeObserver does is report the size it starts
// at, which is what places them before anything has happened at all.
//
// It writes a custom property on the handle, which cannot change the size of
// the frame it is watching, so there is no loop here to guard against.
for (const handle of [sideSplitterLeft, sideSplitterRight]) {
  const stage = handle.closest('.preview-cell').querySelector('.frame-stage');
  if (stage) new ResizeObserver(() => placeSideGrips()).observe(stage);
}

// ---- the layer column's width, V2.8 item 6 ----
//
// --timeline-gutter is the one horizontal measurement the whole frame agrees
// on, so this drag writes that and nothing else and the heads, the ruler and
// the lane all follow it. Session state rather than saved, like the height
// splitter above: it is a way of looking at the timeline, not part of the
// project.
//
// The floor is what the head's own controls need to stay usable; the ceiling is
// there so a drag cannot push the timeline itself off the frame.
const GUTTER_MIN = 90;
const GUTTER_MAX = 360;
let gutterFrom = null;

// Read from the property rather than measured off an element. The heads are
// border-box and a pixel of border would come off every reading, so a drag made
// of many small ones would walk the column leftwards on its own.
function gutterNow() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--timeline-gutter');
  return parseFloat(raw) || GUTTER_MIN;
}

layersSplitter.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  gutterFrom = { x: evt.clientX, width: gutterNow() };
  // So the drag survives the pointer leaving a six pixel strip, which it does
  // at once and for the whole of the gesture.
  layersSplitter.setPointerCapture(evt.pointerId);
  document.body.classList.add('splitting-layers');
  // The stage seeks on a press it does not recognise. This one is not a seek.
  evt.stopPropagation();
  evt.preventDefault();
});

layersSplitter.addEventListener('pointermove', (evt) => {
  if (!gutterFrom) return;
  // From where the column was when the pointer went down, the same as the
  // height splitter and for the same reason: a pointer that runs past a floor
  // and comes back lands where it started rather than a drag's worth away.
  const want = clamp(Math.round(gutterFrom.width + (evt.clientX - gutterFrom.x)),
    GUTTER_MIN, GUTTER_MAX);
  document.documentElement.style.setProperty('--timeline-gutter', want + 'px');
  // The lane is narrower or wider than it was and every second in it has moved,
  // so the ruler, the clips and the playhead are all redrawn against the new
  // width. drawTimeline does the first two.
  drawTimeline();
  updatePlayhead();
});

function endGutterDrag(evt) {
  if (!gutterFrom) return;
  gutterFrom = null;
  document.body.classList.remove('splitting-layers');
  if (layersSplitter.hasPointerCapture(evt.pointerId)) {
    layersSplitter.releasePointerCapture(evt.pointerId);
  }
  // The view that came out of the drag may or may not be the fitted one any
  // more, which is what decides whether a window resize refits it.
  noteTimelineFit(timelineLane.getBoundingClientRect().width);
}

layersSplitter.addEventListener('pointerup', endGutterDrag);
layersSplitter.addEventListener('pointercancel', endGutterDrag);

// V2.9.1. How near the middle frame's whole 16:9 a drag of this handle has to
// come before it takes it, the side handles' reach. See splitEqualStack.
const SPLIT_SNAP = 8;

/**
 * The stack height at which the middle Preview frame is exactly 16:9: the last
 * height it is still whole at, before the handle starts to flatten it.
 *
 * The user's own description, 2026-09-25: "Make the timeline-preview divider
 * snap to the position where the center Preview matches 16:9 aspect. If its
 * large its snaps lower on the window, if its small (or all 3 preview frames
 * are equal) it snaps higher on the window." A wide middle is a tall frame at
 * 16:9 and so a snap low down; a narrow one is short and snaps high. The side
 * frames follow wherever that leaves them.
 *
 * Found by trying heights rather than by adding them up, because the columns
 * do not give up height evenly: a narrow column's buttons wrap onto a second
 * line, and a sum that treated the three alike put the snap a long way from
 * where the frame really stops being whole. So the stack is set, the frame is
 * read, and a search closes in on the last height it is whole at, a dozen
 * layouts at the press and none while the handle moves.
 *
 * Null for an audio project, which has no frame, and when there is no such
 * height in reach: a window too short for the frame to be whole at all, or one
 * so tall the stack never presses it.
 */
function splitEqualStack() {
  if (previewSection.dataset.audio === 'true') return null;
  const width = previewStage.getBoundingClientRect().width;
  if (!width) return null;
  const whole = (width * 9) / 16 - 0.5;
  const root = document.documentElement.style;
  const saved = root.getPropertyValue('--split-stack');
  const wholeAt = (stack) => {
    root.setProperty('--split-stack', stack + 'px');
    return previewStage.getBoundingClientRect().height >= whole;
  };
  let lo = 0;
  let hi = Math.max(0, splitRoom());
  let found = null;
  if (wholeAt(lo) && !wholeAt(hi)) {
    while (hi - lo > 0.5) {
      const mid = (lo + hi) / 2;
      if (wholeAt(mid)) lo = mid;
      else hi = mid;
    }
    found = Math.floor(lo);
  }
  if (saved) root.setProperty('--split-stack', saved);
  else root.removeProperty('--split-stack');
  return found;
}

editSplitter.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0) return;
  splitFrom = {
    y: evt.clientY,
    stack: timelineStack.getBoundingClientRect().height,
    equalAt: splitEqualStack(),
  };
  // So the drag survives the pointer leaving a 10px strip, which it does
  // immediately and for the whole of the gesture.
  editSplitter.setPointerCapture(evt.pointerId);
  document.body.classList.add('splitting');
  evt.preventDefault();
});

editSplitter.addEventListener('pointermove', (evt) => {
  if (!splitFrom) return;
  // Measured from where the stack was when the pointer went down rather than
  // from where it is now, so a pointer that runs past a floor and comes back
  // lands where it started instead of a drag's worth of travel away from it.
  //
  // Minus, because the stack is below the handle. Dragging down moves the
  // boundary down, which is the preview above it growing and the timeline
  // below it giving the room up. This was a plus until 2026-09-23 and the
  // whole thing ran backwards.
  let wish = splitFrom.stack - (evt.clientY - splitFrom.y);
  // Within a few pixels of the middle frame being exactly 16:9, exactly.
  if (splitFrom.equalAt !== null && Math.abs(wish - splitFrom.equalAt) <= SPLIT_SNAP) {
    wish = splitFrom.equalAt;
  }
  if (windowMaxed) {
    // Written into the maximized share, so a drag made up there does not follow
    // the window back down, and is still there on the next maximize.
    const room = splitRoom();
    if (room > 0) splitMaxShare = wish / room;
  } else {
    splitWish = wish;
  }
  applySplit();
  // The fit is given up for a drag that moved something, not for a press the
  // floors ate whole. At the default window size there is about fifteen pixels
  // of slack with two layers loaded, and nothing at all is a poor price for
  // the window giving up its own sizing for the rest of the session.
  const moved = Math.round(timelineStack.getBoundingClientRect().height)
    !== Math.round(splitFrom.stack);
  if (moved && !splitTaken) {
    splitTaken = true;
    window.lwclipper.releaseWindowHeight();
  }
  // The stack is what gained or lost the height, and whether it now scrolls is
  // what the ruler and the lane are inset by.
  drawTimeline();
  updatePlayhead();
});

function endSplit(evt) {
  if (!splitFrom) return;
  splitFrom = null;
  document.body.classList.remove('splitting');
  if (editSplitter.hasPointerCapture(evt.pointerId)) {
    editSplitter.releasePointerCapture(evt.pointerId);
  }
}

editSplitter.addEventListener('pointerup', endSplit);
editSplitter.addEventListener('pointercancel', endSplit);
