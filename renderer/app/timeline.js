'use strict';

// The advanced editing timeline: its view, ruler, markers and scrubbing.

// ---- timeline ----
//
// Advanced editing's replacement for the Trim frame. Step 6 builds the surface
// only: a ruler, a playhead, click to seek, wheel to zoom and the two trim
// markers. There are no layers yet, so the one thing on it is the loaded media,
// which is deliberate. Driving something that already works is what makes this
// frame's own bugs findable before layers can be blamed for them.
//
// The arithmetic lives in timelineView.js and is tested there. What is left
// here is the part that needs a window: canvases, pointers and wheels.

// How long a marker drag has to hold still before its frame is built where it
// stands. Set by the user at a quarter second: long enough that a continuous
// drag never triggers one, short enough that pausing feels like asking.
const TRIM_DWELL_MS = 250;

const TIMELINE_BAND = 'rgba(90, 140, 220, 0.18)';
const TIMELINE_TICK_MAJOR = '#8a8a94';
const TIMELINE_TICK_MINOR = '#4e4e58';
const TIMELINE_LABEL = '#9a9aa4';

// One wheel notch. Chosen so about four notches double the zoom, which is slow
// enough to land on a span deliberately and fast enough to cross a long clip.
const TIMELINE_ZOOM_STEP = 1.19;

// Pixels per second and the second at the left edge. Replaced wholesale on
// every gesture rather than edited, the same as the layer model.
let tlView = { scale: 1, scroll: 0 };

// Whether the view is still the one a newly loaded clip gets rather than one
// the user chose. A fitted view refits when the window changes width; a chosen
// one is only re-clamped, so widening the window does not throw the zoom away.
//
// It has to be tested for exactly, because zooming out no longer stops at the
// fitted view: it carries on past the end of the clip and out to the headroom,
// so "at or below the fit scale" would call half the zoom range fitted.
let tlFitted = true;

/**
 * How much timeline there is: where the last layer ends, or where the loaded
 * media ends, whichever is further.
 *
 * The media half is temporary. Until Step 10 the preview is still the single
 * media file, so the ruler has to span it even before any layer exists, or
 * there is nothing to seek along. Once the compositor lands, the answer is the
 * layers alone.
 */
/** How much material there is: the last thing that ends, and nothing beyond. */
function timelineContent() {
  const fromMedia = media ? media.duration || 0 : 0;
  return Math.max(fromMedia, timelineModel.totalDuration(layers));
}

// V2.8 item 3. The strip of empty timeline the fitted view leaves past whatever
// is furthest out, as a share of it. Small, because it comes out of the width
// every clip is drawn in, and it only has to be enough to show that there is
// room past the end and to give the marker somewhere to be dragged to. Further
// than that is a zoom out, where the view can already pan an hour past the
// material.
const TRIM_TAIL_STRIP = 0.05;

/**
 * What the view is drawn against, which is no longer the same as what there is.
 *
 * The out marker may stand past the last layer since V2.8, and a view fitted to
 * the material alone would put it off the right edge at the one zoom everything
 * opens at. So the extent follows whichever is further, plus the strip.
 */
function timelineDuration() {
  const content = timelineContent();
  if (!timelineDriving()) return content;
  const reach = Math.max(content, slider.end);
  return reach > 0 ? reach * (1 + TRIM_TAIL_STRIP) : reach;
}

/** Back to showing the whole clip, which is where a newly loaded one starts. */
function resetTimelineView() {
  tlFitted = true;
}

/**
 * The stack's scrollbar comes and goes with the number of rows, and it narrows
 * the tracks without narrowing the pinned ruler above them. Stepping the ruler
 * and the lane back by the same amount is what keeps a second at the same x on
 * every row. Measured rather than assumed: the width is the browser's business.
 */
function syncScrollbarInset() {
  const bar = Math.max(0, timelineStack.offsetWidth - timelineStack.clientWidth);
  timelineStage.style.setProperty('--timeline-scrollbar', bar + 'px');
}

// ---- V3.8.2. The sideways scroll bar ----
//
// A native scroller, so it looks and acts exactly as the stack's own vertical
// one does: an empty strip as wide as the content in pixels (the timeline from
// 0 to the last track's end, plus one frame width so the end can reach the left
// edge), whose scrollLeft is the view's scroll in pixels. It is shown only while
// a track lies partly or wholly out of view to the left or the right.

// Set while the view writes scrollLeft, so that the scroll event that causes is
// not taken for the user's.
let hBarWriting = false;

function updateTimelineHBar() {
  const width = timelineLane.clientWidth;
  if (!timelineDriving() || !width || !layers.length || !(tlView.scale > 0)) {
    timelineHBar.hidden = true;
    timelineStage.style.setProperty('--timeline-hbar', '0px');
    return;
  }
  const left = tlView.scroll;
  const right = left + width / tlView.scale;
  const first = Math.min(...layers.map((l) => l.start));
  const last = timelineModel.totalDuration(layers);
  const out = first < left - 1e-6 || last > right + 1e-6;
  timelineHBar.hidden = !out;
  // The lane (and so the playhead's line) stops above the bar.
  timelineStage.style.setProperty('--timeline-hbar', out ? timelineHBar.offsetHeight + 'px' : '0px');
  if (!out) return;
  timelineHSpan.style.width = (last * tlView.scale + width) + 'px';
  const want = left * tlView.scale;
  if (Math.abs(timelineHBar.scrollLeft - want) > 0.5) {
    hBarWriting = true;
    timelineHBar.scrollLeft = want;
    // The scroll event is asynchronous; cleared on the next frame.
    requestAnimationFrame(() => { hBarWriting = false; });
  }
}

timelineHBar.addEventListener('scroll', () => {
  if (hBarWriting || busy) return;
  const width = timelineLane.clientWidth;
  const duration = timelineDuration();
  if (!duration || !width) return;
  tlFitted = false;
  tlView = {
    scale: tlView.scale,
    scroll: timelineView.clampScroll(timelineHBar.scrollLeft / tlView.scale, tlView.scale, duration, width),
  };
  noteTimelineFit(width);
  drawTimeline();
  updatePlayhead();
});

/** Whether the view a gesture just produced is still the fitted one. */
function noteTimelineFit(width) {
  tlFitted = tlView.scroll === 0
    && tlView.scale === timelineView.fitScale(timelineDuration(), width);
}

/**
 * Bring the view in line with the width it is actually being drawn at. The
 * frame is display:none in simple editing, so its width is 0 until the setting
 * is switched on, and it changes again with every window resize.
 */
function syncTimelineView() {
  const duration = timelineDuration();
  const width = timelineLane.clientWidth;
  if (!duration || !width) return;
  if (tlFitted) {
    tlView = timelineView.fitView(duration, width);
    return;
  }
  const scale = timelineView.clampScale(tlView.scale, duration, width);
  tlView = { scale, scroll: timelineView.clampScroll(tlView.scroll, scale, duration, width) };
}

function positionTimelineMarkers() {
  const duration = timelineDuration();
  // What the veil marks is where the material stops, which since V2.8 is not
  // where the timeline stops.
  const content = timelineContent();
  const show = duration > 0 && timelineLane.clientWidth > 0;
  timelineTrimIn.hidden = !show;
  timelineTrimOut.hidden = !show;
  timelineBeyond.hidden = !show;
  if (!show) {
    timelineOutsideStart.hidden = true;
    timelineOutsideEnd.hidden = true;
    return;
  }
  const inX = timelineView.timeToX(tlView, slider.start);
  const outX = timelineView.timeToX(tlView, slider.end);
  timelineTrimIn.style.left = inX + 'px';
  timelineTrimOut.style.left = outX + 'px';
  // Anchored at the right edge, so it only needs its left told to it. Clamped
  // at zero, or scrolling past the content would put it off the left and leave
  // a sliver of undimmed headroom at the edge.
  const endX = Math.max(0, timelineView.timeToX(tlView, content));
  timelineBeyond.style.left = endX + 'px';

  // V2.5. The two stretches the render leaves out. Each is anchored to its own
  // side of the lane and only needs a width, and a width of nothing is hidden
  // rather than drawn as a zero pixel element: the marker can be scrolled off
  // the side, at which point there is no outside on that side to show.
  const laneW = timelineLane.clientWidth;
  const before = Math.min(Math.max(0, inX), laneW);
  const after = Math.min(Math.max(0, laneW - outX), laneW);
  timelineOutsideStart.hidden = before <= 0;
  timelineOutsideStart.style.width = before + 'px';
  timelineOutsideEnd.hidden = after <= 0;
  timelineOutsideEnd.style.width = after + 'px';
}

// Drawn the same way as the waveform: backing store in device pixels, drawing
// in CSS pixels, so the marks are not blurry on a scaled display. The playhead
// and the markers are elements over the canvas rather than paint on it, so
// following playback costs a style write instead of a full redraw.
function drawTimeline() {
  // Before anything is measured: this changes the ruler's width, and the whole
  // frame is measured against that width.
  syncScrollbarInset();
  const cssW = timelineRuler.clientWidth;
  const cssH = timelineRuler.clientHeight;
  // Zero in simple editing, where the frame is not in the flow at all.
  if (!cssW || !cssH) return;
  syncTimelineView();

  const dpr = window.devicePixelRatio || 1;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (timelineRuler.width !== wantW || timelineRuler.height !== wantH) {
    timelineRuler.width = wantW;
    timelineRuler.height = wantH;
  }
  const ctx = timelineRuler.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const duration = timelineDuration();
  positionTimelineMarkers();
  positionLayerClips();
  updateTimelineHBar();
  if (!duration) return;

  // The selected span, so the two markers read as the ends of something rather
  // than as two unrelated lines.
  const bandX0 = timelineView.timeToX(tlView, slider.start);
  const bandX1 = timelineView.timeToX(tlView, slider.end);
  ctx.fillStyle = TIMELINE_BAND;
  ctx.fillRect(bandX0, 0, Math.max(0, bandX1 - bandX0), cssH);

  ctx.font = '10px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'top';
  const marks = timelineView.ticks(tlView, duration, cssW);
  // Every label on the ruler takes its shape from the largest time on it, so a
  // view that has reached an hour does not mix 59:00 with 1:01:00.
  const longest = marks.length ? marks[marks.length - 1].t : duration;
  for (const tick of marks) {
    // Half a pixel, so a one pixel line lands on a pixel instead of across two.
    const x = Math.round(tick.x) + 0.5;
    const height = tick.major ? 8 : 4;
    ctx.strokeStyle = tick.major ? TIMELINE_TICK_MAJOR : TIMELINE_TICK_MINOR;
    ctx.beginPath();
    ctx.moveTo(x, cssH - height);
    ctx.lineTo(x, cssH);
    ctx.stroke();
    if (!tick.major) continue;
    ctx.fillStyle = TIMELINE_LABEL;
    ctx.fillText(timelineView.tickLabel(tick.t, tick.step, longest), x + 3, 2);
  }
}

/**
 * Move the preview to a point on the timeline. The element drops currentTime
 * silently while it knows nothing about the file, so a seek before the metadata
 * has arrived is not attempted rather than being lost without saying so.
 */
function seekTimeline(at) {
  const duration = timelineDuration();
  if (!duration) return;
  // In advanced mode the playhead belongs to the compositor, which keeps its
  // own clock and may have no media file behind it at all.
  if (timelineDriving()) {
    seekComposite(at);
    updatePlayhead();
    return;
  }
  if (!Number.isFinite(transport.duration) || transport.duration <= 0) return;
  transport.currentTime = Math.min(Math.max(at, 0), duration);
  updatePlayhead();
}

// Anything under this many pixels of travel was meant as a click, not a drag.
// Without it a click with a shaky hand slides the view instead of moving the
// playhead, which is the more annoying of the two to undo.
const TIMELINE_DRAG_SLOP = 3;

// A click anywhere seeks. What a drag means depends on where it started:
//
//   on the ruler, it slides the timeline back and forth under the window, which
//   is what the left-right cursor there promises and the only way to reach the
//   rest of a clip once the view is zoomed past what the frame can show;
//
//   on empty space in a row, V3.8.2, it draws a range, and the clips that lie
//   wholly inside it are chosen when it is let go.
//
// On both the seek waits for the release: until the pointer has moved there is
// no telling which of the two gestures this was going to be.
timelineStage.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || busy || !timelineDuration()) return;
  const rect = timelineLane.getBoundingClientRect();
  const toTime = (clientX) => timelineView.xToTime(tlView, clientX - rect.left);
  // Read now, because pointer capture retargets every event after this one.
  const onRuler = evt.target === timelineRuler;
  // A layer's header is controls, not timeline. Clicking one selects the layer
  // and works its buttons; it must not also move the playhead.
  const onTrack = !!(evt.target.closest && evt.target.closest('.layer-track'));
  if (!onRuler && !onTrack) return;
  // A press on a control inside a row belongs to that control. Capturing the
  // pointer below retargets the click to the stage, so the button never sees
  // one, and an empty row's Open File simply stopped responding. It only ever
  // showed up once something had given the timeline a duration, because with
  // none this handler returns on the line above and was never in the way.
  if (evt.target.closest('button, input, select, textarea, label')) return;
  const drag = { startX: evt.clientX, startY: evt.clientY, lastX: evt.clientX, panning: false, box: null };

  const onMove = (ev) => {
    if (!onRuler) {
      if (!drag.box && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < TIMELINE_DRAG_SLOP) return;
      if (!drag.box) {
        drag.box = document.createElement('div');
        drag.box.className = 'timeline-marquee';
        document.body.appendChild(drag.box);
      }
      drag.at = marqueeRect(drag, ev);
      const b = drag.at;
      drag.box.style.cssText = 'left:' + b.left + 'px;top:' + b.top + 'px;width:'
        + (b.right - b.left) + 'px;height:' + (b.bottom - b.top) + 'px';
      return;
    }
    if (!drag.panning && Math.abs(ev.clientX - drag.startX) < TIMELINE_DRAG_SLOP) return;
    drag.panning = true;
    // The content follows the hand, so the view moves the other way: dragging
    // rightwards brings earlier seconds into the frame.
    tlView = timelineView.panBy(tlView, drag.lastX - ev.clientX, timelineDuration(), rect.width);
    drag.lastX = ev.clientX;
    noteTimelineFit(rect.width);
    drawTimeline();
    updatePlayhead();
  };
  const onUp = (ev) => {
    if (!onRuler) {
      if (drag.box) {
        drag.box.remove();
        if (ev.type === 'pointerup') chooseInRange(drag.at, rect, evt.shiftKey || ev.shiftKey);
      } else if (ev.type === 'pointerup') {
        beginScrub();
        seekTimeline(toTime(ev.clientX));
      }
    } else if (!drag.panning) {
      seekTimeline(toTime(ev.clientX));
    }
    // Unconditional, so a pointercancel lands the layers too. It returns at
    // once when no scrub was running.
    endScrub();
  };
  beginDrag(timelineStage, evt, onMove, onUp, true);
});

/** V3.8.2. The dragged range, kept inside the rows it is drawn over. */
function marqueeRect(drag, ev) {
  const stack = timelineStack.getBoundingClientRect();
  const lane = timelineLane.getBoundingClientRect();
  const clampX = (x) => Math.min(Math.max(x, lane.left), lane.right);
  const clampY = (y) => Math.min(Math.max(y, stack.top), stack.bottom);
  const x0 = clampX(drag.startX);
  const x1 = clampX(ev.clientX);
  const y0 = clampY(drag.startY);
  const y1 = clampY(ev.clientY);
  return { left: Math.min(x0, x1), right: Math.max(x0, x1), top: Math.min(y0, y1), bottom: Math.max(y0, y1) };
}

/**
 * V3.8.2. Choose the clips whose start and end both lie inside the range, on
 * the rows it reaches. Shift adds them to the ones already chosen.
 */
function chooseInRange(box, laneRect, add) {
  if (!box) return;
  const from = timelineView.xToTime(tlView, box.left - laneRect.left);
  const to = timelineView.xToTime(tlView, box.right - laneRect.left);
  const rows = [...timelineStack.querySelectorAll('.layer-track')].filter((track) => {
    const r = track.getBoundingClientRect();
    return r.bottom > box.top && r.top < box.bottom;
  });
  const inside = [];
  for (const track of rows) {
    for (const clip of track.querySelectorAll('.layer-clip[data-layer-id]')) {
      const layer = timelineModel.layerById(layers, clip.dataset.layerId);
      if (layer && layer.start >= from && timelineModel.endOf(layer) <= to) inside.push(layer.id);
    }
  }
  const ids = add ? [...selectionIds(), ...inside] : inside;
  setLayerSelection(ids, inside[inside.length - 1] || selectedLayerId);
}

// Wheel zooms about the cursor, Shift and wheel scrolls sideways. deltaX is
// added to deltaY for the scroll because a trackpad already reports a
// horizontal swipe that way, and some of them turn Shift and a vertical swipe
// into deltaX themselves.
timelineStage.addEventListener('wheel', (evt) => {
  const duration = timelineDuration();
  if (!duration) return;
  // Over the headers on the left, or over the stack's own scrollbar, the wheel
  // belongs to the rows. The stack is a fixed height with overflow-y auto, so
  // it can scroll perfectly well; preventDefault below was the only reason it
  // never did, and with more rows than fit there was no way to reach the ones
  // underneath at all. Returning without preventing the default hands the event
  // back to the browser, which scrolls .timeline-stack itself.
  if (overTimelineRows(evt)) return;
  evt.preventDefault();
  // V3.8.2. Ctrl and wheel scrolls the rows up and down when there are more
  // than fit, instead of zooming. With nothing to scroll it zooms as before.
  if (evt.ctrlKey && !evt.shiftKey && timelineStack.scrollHeight > timelineStack.clientHeight) {
    timelineStack.scrollTop += evt.deltaY || evt.deltaX;
    return;
  }
  const rect = timelineLane.getBoundingClientRect();
  if (evt.shiftKey) {
    tlView = timelineView.panBy(tlView, evt.deltaY + evt.deltaX, duration, rect.width);
  } else {
    const notches = -Math.sign(evt.deltaY || evt.deltaX);
    if (!notches) return;
    // V3.8.2. Zooming in with no track reaching past the right edge of the view
    // closes in on the tracks there are, from the left (towards 00:00), and
    // not about the pointer, which may be over empty space that then slides the
    // tracks out of the frame. Zooming out, or a track further right, keeps the
    // pointer as the fixed point.
    const right = tlView.scroll + rect.width / tlView.scale;
    const tracksBeyond = timelineModel.totalDuration(layers) > right + 1e-6;
    const anchor = notches > 0 && layers.length && !tracksBeyond ? 0 : evt.clientX - rect.left;
    tlView = timelineView.zoomAt(tlView, anchor,
      Math.pow(TIMELINE_ZOOM_STEP, notches), duration, rect.width);
  }
  noteTimelineFit(rect.width);
  drawTimeline();
  updatePlayhead();
}, { passive: false });

// ---- V4.0. The View menu and its keys ----

/**
 * One zoom step in (`dir` 1) or out (-1), the + and - keys: three wheel notches,
 * about the playhead while it is in view and about the middle when it is not.
 */
function zoomTimelineStep(dir) {
  const duration = timelineDuration();
  const width = timelineLane.clientWidth;
  if (!timelineDriving() || !duration || !width) return;
  const x = timelineView.timeToX(tlView, compositeAt);
  const anchor = x >= 0 && x <= width ? x : width / 2;
  tlView = timelineView.zoomAt(tlView, anchor, Math.pow(TIMELINE_ZOOM_STEP, 3 * dir), duration, width);
  noteTimelineFit(width);
  drawTimeline();
  updatePlayhead();
}

/** Ctrl+T: "Zooms so much in/out that all tracks are visible at once". */
function fitTimelineView() {
  if (!timelineDriving()) return;
  tlFitted = true;
  drawTimeline();
  updatePlayhead();
}

/**
 * Slide the view, at the zoom it has, so that a second is in it. Nothing moves
 * when it already is. `side` is where it lands when the view has to move: a
 * tenth of the width in from the left, or from the right for the end.
 */
function revealTime(at, side = 'left') {
  const duration = timelineDuration();
  const width = timelineLane.clientWidth;
  if (!timelineDriving() || !duration || !width || !(tlView.scale > 0)) return;
  const span = width / tlView.scale;
  if (at >= tlView.scroll && at <= tlView.scroll + span) return;
  const want = side === 'right' ? at - span * 0.9 : at - span * 0.1;
  tlView = { scale: tlView.scale, scroll: timelineView.clampScroll(want, tlView.scale, duration, width) };
  noteTimelineFit(width);
  drawTimeline();
}

/**
 * Home and End: the playhead to 0:00 or to the end of the last track, and the
 * view after it at the zoom it has. Home scrolls all the way left, since 0:00
 * is the left edge of everything.
 */
function goTimelineEdge(toEnd) {
  if (!timelineDriving()) return;
  const at = toEnd ? timelineModel.totalDuration(layers) : 0;
  seekComposite(at);
  if (toEnd) {
    revealTime(at, 'right');
  } else if (tlView.scroll > 0) {
    tlView = { scale: tlView.scale, scroll: 0 };
    noteTimelineFit(timelineLane.clientWidth);
    drawTimeline();
  }
  updatePlayhead();
}

/** Shift+Left: back to where playback last started, the grey line. */
function backToPlayStart() {
  if (!timelineDriving() || playStartAt === null) return;
  seekComposite(playStartAt);
  revealTime(playStartAt);
  updatePlayhead();
}

/**
 * Whether a wheel belongs to the stack rather than to the view.
 *
 * The headers are elements and can be asked for. The scrollbar is not: it is
 * painted inside the stack's border box but outside its client box, so the only
 * way to know the pointer is on it is to measure. clientWidth stops at the
 * scrollbar, which is the same measurement --timeline-scrollbar is computed
 * from, so the two cannot disagree about where the tracks end.
 */
function overTimelineRows(evt) {
  const node = evt.target;
  if (node && node.closest && node.closest('.layer-head, .timeline-gutter')) return true;
  const rect = timelineStack.getBoundingClientRect();
  if (evt.clientY < rect.top || evt.clientY > rect.bottom) return false;
  return evt.clientX > rect.left + timelineStack.clientWidth;
}

// The two markers move the same trim the Trim frame's handles do, through the
// same slider, so the time boxes, the frames, the waveform and the span line
// all follow without knowing which frame the drag happened in. Anchor-based
// and re-anchoring on a modifier change, exactly as TrimSlider does.
function bindTimelineMarker(markerEl, isStart) {
  // V2.5. The strip in the ruler is the whole of the marker's grab area now,
  // and it is where the drag lives: the marker itself is pointer-events: none
  // so that a press over the tracks reaches the clip under the line, and an
  // element that is not hit tested is not an element to capture a pointer on.
  const grabEl = markerEl.querySelector('.timeline-marker__grab') || markerEl;
  grabEl.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0 || busy || !timelineDuration()) return;
    // Or the click-to-seek surface underneath would take the playhead with it.
    evt.stopPropagation();
    evt.preventDefault();
    // V2.5. The pointer is captured for the whole drag, so what is under it is
    // no longer what decides the cursor. Held on the body, the way every other
    // gesture on this frame holds its own.
    document.body.classList.add('trim-dragging');
    // V2.8. The extent follows the out marker now, and a fitted view would
    // refit to it on every move: the scale would shrink under the hand and the
    // marker would drift away from the pointer, because the drag turns pixels
    // into seconds at whatever scale the view is showing. Frozen here and
    // settled on release, the same way a fade drag does it.
    tlFitted = false;
    const laneAtPress = timelineLane.getBoundingClientRect();
    const drag = {
      anchorX: evt.clientX,
      anchorValue: isStart ? slider.start : slider.end,
      factor: modifierFactor(evt),
    };
    setDragHint(drag.factor);
    // Step 10e. Only this marker's own frame: dragging the in point leaves the
    // End frame exactly as correct as it was, and a spinner over it would say
    // otherwise.
    const mine = isStart ? 'start' : 'end';
    // A drag that holds still is a drag that has arrived somewhere, so the
    // frame is built there and shown without waiting for the button. Re-armed
    // by every move, so a continuous drag never pays for one.
    let dwell = null;
    const armDwell = () => {
      clearTimeout(dwell);
      dwell = setTimeout(() => {
        dwell = null;
        renderTrimFrames(mine);
      }, TRIM_DWELL_MS);
    };
    if (compositing()) {
      trimFramesBusy(true, mine);
      armDwell();
    }

    let moved = false;
    const onMove = (ev) => {
      moved = true;
      const factor = modifierFactor(ev);
      if (factor !== drag.factor) {
        drag.anchorX = ev.clientX;
        drag.anchorValue = isStart ? slider.start : slider.end;
        drag.factor = factor;
        setDragHint(factor);
      }
      // Seconds per pixel is the zoom, so a marker moves under the cursor at
      // whatever scale the view is showing rather than at a fixed rate.
      const delta = ((ev.clientX - drag.anchorX) / tlView.scale) * drag.factor;
      let value = drag.anchorValue + delta;
      // V3.8.2. The markers are pulled onto the end (out) or the start (in) of a
      // track when they come within a few pixels of it, lit green with the
      // track's edge.
      {
        const snap = snapMarkerToTrackEdge(value, isStart);
        value = snap.value;
        lightSnap(snap.layerId
          ? [timelineStack.querySelector('.layer-clip[data-layer-id="' + snap.layerId
            + '"] .layer-clip__edge--' + (isStart ? 'start' : 'end'))]
          : []);
      }
      if (isStart) slider.setStart(value);
      else slider.setEnd(value);
      if (!compositing()) return;
      // Whatever is on that frame, and whatever is being built for it, is now a
      // picture of somewhere the marker has already left.
      trimDragGen += 1;
      trimFramesBusy(true, mine);
      armDwell();
    };
    const onUp = (ev) => {
      document.body.classList.remove('trim-dragging');
      lightSnap([]);
      setDragHint(1.0);
      clearTimeout(dwell);
      // The release is the commit. Cheap when a dwell already built this frame:
      // seekDecodersTo skips a decoder that is already on the right frame, so
      // re-rendering an unchanged trim costs nothing but the restore.
      renderTrimFrames(mine);
      if (isStart && moved) restartAtMarker();
      // Whether what came out of the drag is the fitted view again, which is
      // what decides if a window resize refits it.
      noteTimelineFit(laneAtPress.width);
      commitHistory();
    };
    beginDrag(grabEl, evt, onMove, onUp);
  });
}

/**
 * V3.8.2. A marker's time, moved onto the nearest end (the out marker) or start
 * (the in marker) of a track that is within CLIP_SNAP_PX of it on screen.
 * Pixels rather than seconds, since a few pixels are a different number of
 * seconds at every zoom.
 */
function snapMarkerToTrackEdge(value, isStart) {
  let best = null;
  for (const l of layers) {
    const edge = isStart ? l.start : timelineModel.endOf(l);
    const gap = Math.abs(edge - value) * tlView.scale;
    if (gap <= CLIP_SNAP_PX && (!best || gap < best.gap)) best = { gap, edge, layerId: l.id };
  }
  return best ? { value: best.edge, layerId: best.layerId } : { value, layerId: null };
}

/**
 * V3.8.2. An in marker let go with nothing on the timeline before it: that
 * point becomes 00:00:00. Every track slides left by as much, the out marker
 * and the playhead with them, and the marker is at the start again. One undo
 * step with the marker's own move.
 */
function restartAtMarker() {
  if (!timelineDriving() || busy) return;
  const point = slider.start;
  const shifted = timelineModel.shiftToZero(layers, point);
  if (shifted === layers) return;
  const end = slider.end - point;
  const at = compositeAt - point;
  setLayers(shifted);
  slider.setRange(timelineModel.trimCeiling(layers), 0, Math.max(end, slider.minSpan));
  seekComposite(Math.max(0, at));
  refreshSelection(null);
  renderTrimFrames();
}

bindTimelineMarker(timelineTrimIn, true);
bindTimelineMarker(timelineTrimOut, false);

/**
 * Dragging the playhead line itself.
 *
 * Step 10b made a press on bare track scrub, which is right but is not enough:
 * a project whose layers cover the whole timeline has no bare track left to
 * press, and pressing a clip drags the clip. The line is always there and is
 * always the playhead, so it is the one grip that cannot be taken away. It
 * takes the press before the track underneath, so hovering it does not put the
 * gesture on a clip.
 */
timelinePlayhead.addEventListener('pointerdown', (evt) => {
  if (evt.button !== 0 || busy || !timelineDuration()) return;
  // The clip underneath would start moving and the stage would scrub from
  // wherever the press landed. This press means the playhead and nothing else.
  evt.stopPropagation();
  evt.preventDefault();
  // Read once: the playhead moves out from under the cursor as it is dragged,
  // and the lane is what x is measured against either way.
  const rect = timelineLane.getBoundingClientRect();
  beginScrub();

  const onMove = (ev) => {
    seekTimeline(timelineView.xToTime(tlView, ev.clientX - rect.left));
  };
  const onUp = (ev) => {
    endScrub();
  };
  beginDrag(timelinePlayhead, evt, onMove, onUp);
});

// ---- layer rows ----
//
// Step 7. The rows are built from the model in src/timeline.js, which the
// window loads as a plain script beside this one because it cannot require()
// anything. That is deliberate: the main process encodes from the same file, so
// there is one layer model rather than two that have to be kept agreeing.
//
// Nothing here plays yet. The preview is still the single-media one Step 6
// wired up, and Step 10 replaces it with the compositor. What this step has to
// get right is that the model and the screen say the same thing after any
// sequence of adding, removing, reordering and switching layers off.

// The whole document, and the only thing an undo snapshot would need to hold.
let layers = [];
let selectedLayerId = null;
// V3.8.2. The clips chosen together (Ctrl+A, Shift and click, a dragged range),
// beside selectedLayerId, which stays the one the windows and the keys act on.
// Empty unless two or more are chosen, and then it holds selectedLayerId too.
let selectedLayerIds = new Set();
// V3.3. The keyframe last clicked, as { layerId, id }, or null. Its own
// selection beside the clip's: Delete takes the keyframe while one is chosen
// and the clip once it is not. See renderer/app/keyframes.js.
let selectedKeyframe = null;

// A trailing empty row of each type is always on offer, so there is somewhere
// to drop a file and somewhere to press Open File. Filling it puts a real layer
// in its place and a fresh empty one appears below, which is why there is no
// separate button to add a layer: the empty row is the button.
