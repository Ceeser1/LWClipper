'use strict';

const test = require('node:test');
const assert = require('node:assert');

const view = require('../renderer/timelineView');

// A 10 minute clip in an 800px frame, which is roughly what the window gives
// the timeline at its default size.
const DURATION = 600;
const WIDTH = 800;

test('a fitted view shows the whole clip and nothing more', () => {
  const v = view.fitView(DURATION, WIDTH);
  assert.strictEqual(v.scroll, 0);
  assert.strictEqual(view.timeToX(v, 0), 0);
  assert.strictEqual(view.timeToX(v, DURATION), WIDTH);
});

test('the whole reachable timeline is the furthest out the view can go', () => {
  const floor = view.minScale(DURATION, WIDTH);
  assert.strictEqual(view.clampScale(floor / 10, DURATION, WIDTH), floor);
  assert.strictEqual(view.clampScale(0, DURATION, WIDTH), floor);
  // And at that scale it is the whole of it across the frame, exactly.
  const out = { scale: floor, scroll: 0 };
  assert.ok(Math.abs(view.timeToX(out, view.reachOf(DURATION)) - WIDTH) < 1e-6);
});

test('zooming out goes past the end of the clip, as far as the headroom', () => {
  const fit = view.fitScale(DURATION, WIDTH);
  const floor = view.minScale(DURATION, WIDTH);
  assert.ok(floor < fit, 'the floor must be further out than the fit');
  // A ten minute clip zooms out to an hour and ten minutes.
  assert.strictEqual(view.reachOf(DURATION), DURATION + view.PAN_HEADROOM);
  assert.strictEqual(WIDTH / floor, DURATION + view.PAN_HEADROOM);
});

test('a three hour clip zooms out to four, not to three', () => {
  const long = 3 * 3600;
  const floor = view.minScale(long, WIDTH);
  assert.strictEqual(WIDTH / floor, long + view.PAN_HEADROOM);
});

test('a one minute clip zooms out to an hour and a minute', () => {
  const floor = view.minScale(60, WIDTH);
  assert.strictEqual(WIDTH / floor, 60 + view.PAN_HEADROOM);
});

test('zooming in stops at the maximum', () => {
  const capped = view.clampScale(1e6, DURATION, WIDTH);
  assert.strictEqual(capped, view.MAX_PX_PER_SEC);
});

test('a clip shorter than the frame can still be fitted rather than capped', () => {
  // 0.5s in 800px wants 1600 px/s, past the cap. The cap has to give way, or
  // the view cannot show the whole of a very short clip.
  const fit = view.fitScale(0.5, WIDTH);
  assert.ok(fit > view.MAX_PX_PER_SEC);
  assert.strictEqual(view.clampScale(fit, 0.5, WIDTH), fit);
});

test('x and time are inverses of each other', () => {
  const v = { scale: 12.5, scroll: 37.25 };
  for (const x of [0, 1, 123.5, 799]) {
    assert.ok(Math.abs(view.timeToX(v, view.xToTime(v, x)) - x) < 1e-6);
  }
});

test('nothing divides by a zero duration or a zero width', () => {
  assert.strictEqual(view.fitScale(0, WIDTH), 1);
  assert.strictEqual(view.fitScale(DURATION, 0), 1);
  assert.strictEqual(view.maxScroll(10, 0, WIDTH), 0);
  assert.deepStrictEqual(view.ticks({ scale: 10, scroll: 0 }, 0, WIDTH), []);
});

// ---- the anchored zoom, which is the part worth testing ----

test('zooming holds the second under the cursor exactly where it was', () => {
  let v = view.fitView(DURATION, WIDTH);
  const anchor = 613;
  const held = view.xToTime(v, anchor);
  for (const factor of [1.2, 1.2, 1.2, 0.8, 1.5]) {
    v = view.zoomAt(v, anchor, factor, DURATION, WIDTH);
    assert.ok(Math.abs(view.timeToX(v, held) - anchor) < 1e-6,
      'after x' + factor + ' the held second moved to ' + view.timeToX(v, held));
  }
});

test('zooming at the left edge cannot scroll past the start', () => {
  let v = view.fitView(DURATION, WIDTH);
  v = view.zoomAt(v, 0, 4, DURATION, WIDTH);
  assert.strictEqual(v.scroll, 0);
});

test('zooming at the right edge holds that second, and stays inside the headroom', () => {
  let v = view.fitView(DURATION, WIDTH);
  // The right edge of a fitted view is the end of the clip, not the end of the
  // headroom, so this pins the clip's end rather than running to the limit.
  v = view.zoomAt(v, WIDTH, 4, DURATION, WIDTH);
  assert.ok(Math.abs(view.timeToX(v, DURATION) - WIDTH) < 1e-6);
  assert.ok(v.scroll <= view.maxScroll(v.scale, DURATION, WIDTH));
  // From there the headroom is still to the right, waiting to be panned into.
  assert.ok(view.panBy(v, 400, DURATION, WIDTH).scroll > v.scroll);
});

test('zooming all the way back out lands on the reachable timeline', () => {
  let v = view.zoomAt(view.fitView(DURATION, WIDTH), 400, 8, DURATION, WIDTH);
  for (let i = 0; i < 60; i += 1) v = view.zoomAt(v, 400, 0.8, DURATION, WIDTH);
  assert.strictEqual(v.scale, view.minScale(DURATION, WIDTH));
  assert.strictEqual(v.scroll, 0);
});

test('panning is bounded at the start and at the end of the headroom', () => {
  const zoomed = view.zoomAt(view.fitView(DURATION, WIDTH), 400, 6, DURATION, WIDTH);
  assert.strictEqual(view.panBy(zoomed, -1e6, DURATION, WIDTH).scroll, 0);
  const far = view.panBy(zoomed, 1e6, DURATION, WIDTH);
  assert.strictEqual(far.scroll, view.maxScroll(zoomed.scale, DURATION, WIDTH));
  // Panned as far right as it goes, the last pixel is the end of the headroom.
  assert.ok(Math.abs(view.timeToX(far, view.reachOf(DURATION)) - WIDTH) < 1e-6);
});

test('a fitted view can still pan out into the headroom', () => {
  const v = view.fitView(DURATION, WIDTH);
  assert.ok(view.maxScroll(v.scale, DURATION, WIDTH) > 0,
    'the empty hour past the clip has to be reachable from the fitted view');
  assert.ok(view.panBy(v, 200, DURATION, WIDTH).scroll > 0);
  // But only out to the headroom, never past it.
  assert.strictEqual(view.panBy(v, 1e6, DURATION, WIDTH).scroll,
    view.reachOf(DURATION) - WIDTH / v.scale);
});

test('the fully zoomed out view has nowhere left to pan to', () => {
  const v = { scale: view.minScale(DURATION, WIDTH), scroll: 0 };
  assert.strictEqual(view.maxScroll(v.scale, DURATION, WIDTH), 0);
  assert.strictEqual(view.panBy(v, 1e6, DURATION, WIDTH).scroll, 0);
});

test('the view never mutates the one it was given', () => {
  const v = Object.freeze({ scale: 10, scroll: 5 });
  view.zoomAt(v, 100, 2, DURATION, WIDTH);
  view.panBy(v, 50, DURATION, WIDTH);
  assert.strictEqual(v.scale, 10);
  assert.strictEqual(v.scroll, 5);
});

// ---- the tick ladder ----

test('the chosen step always leaves room for its own label', () => {
  for (const scale of [0.5, 1, 3, 7, 20, 60, 150, 400]) {
    const chosen = view.chooseStep(scale);
    assert.ok(chosen.step * scale >= view.MIN_LABEL_GAP
      || chosen.step === view.TICK_STEPS[view.TICK_STEPS.length - 1].step,
    scale + ' px/s chose a ' + chosen.step + 's step');
  }
});

test('the step gets finer as the view zooms in, never coarser', () => {
  let previous = Infinity;
  for (const scale of [0.5, 1, 2, 5, 10, 30, 80, 200, 400]) {
    const step = view.chooseStep(scale).step;
    assert.ok(step <= previous, scale + ' px/s went back up to ' + step);
    previous = step;
  }
});

test('labelled marks are at least the label gap apart on screen', () => {
  for (const scale of [1, 4, 17, 55, 400]) {
    const v = { scale, scroll: 0 };
    const major = view.ticks(v, DURATION, WIDTH).filter((tick) => tick.major);
    for (let i = 1; i < major.length; i += 1) {
      assert.ok(major[i].x - major[i - 1].x >= view.MIN_LABEL_GAP - 1e-6,
        'at ' + scale + ' px/s two labels were ' + (major[i].x - major[i - 1].x) + 'px apart');
    }
  }
});

test('unlabelled marks are dropped rather than drawn on top of each other', () => {
  for (const scale of [0.4, 1, 3, 9, 40, 400]) {
    const all = view.ticks({ scale, scroll: 0 }, DURATION, WIDTH);
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(all[i].x - all[i - 1].x >= view.MIN_MINOR_GAP - 1e-6,
        'at ' + scale + ' px/s two marks were ' + (all[i].x - all[i - 1].x) + 'px apart');
    }
  }
});

test('every mark is inside the reachable timeline and inside the frame', () => {
  const v = view.zoomAt(view.fitView(DURATION, WIDTH), 500, 5, DURATION, WIDTH);
  for (const tick of view.ticks(v, DURATION, WIDTH)) {
    assert.ok(tick.t >= 0 && tick.t <= view.reachOf(DURATION), 'mark at ' + tick.t);
    assert.ok(tick.x >= -1e-6 && tick.x <= WIDTH + 1e-6, 'mark at x ' + tick.x);
  }
});

test('the headroom past the clip is marked too, and stops at its end', () => {
  // Panned right to the end, so the frame holds nothing but headroom.
  const zoomed = view.zoomAt(view.fitView(DURATION, WIDTH), 400, 6, DURATION, WIDTH);
  const far = view.panBy(zoomed, 1e6, DURATION, WIDTH);
  const marks = view.ticks(far, DURATION, WIDTH);
  assert.ok(marks.length, 'the headroom has no marks at all');
  assert.ok(marks.some((tick) => tick.t > DURATION), 'no mark past the end of the clip');
  const last = marks[marks.length - 1];
  assert.ok(last.t <= view.reachOf(DURATION), 'a mark past the headroom at ' + last.t);
});

test('a labelled mark is always a whole number of steps from zero', () => {
  for (const scale of [1, 6, 25, 120, 400]) {
    const v = { scale, scroll: 0 };
    for (const tick of view.ticks(v, DURATION, WIDTH)) {
      if (!tick.major) continue;
      const n = tick.t / tick.step;
      assert.ok(Math.abs(n - Math.round(n)) < 1e-6,
        tick.t + ' is not a multiple of ' + tick.step);
    }
  }
});

test('marks do not drift after hundreds of steps', () => {
  // 0.1s steps across an hour: the thousandth mark has to be 100.0 exactly, not
  // 99.99999999999859, which is what adding 0.1 a thousand times gives.
  const all = view.ticks({ scale: 400, scroll: 99.5 }, 3600, WIDTH);
  const hundred = all.find((tick) => Math.abs(tick.t - 100) < 1e-9);
  assert.ok(hundred, 'no mark at 100s');
  assert.strictEqual(hundred.t, 100);
});

test('the last mark of a clip is not lost to rounding', () => {
  // 10s exactly, fitted: the mark at 10s lands on the last pixel and the
  // tolerance in ticks() is what keeps it.
  const v = view.fitView(10, WIDTH);
  const all = view.ticks(v, 10, WIDTH);
  assert.ok(all.some((tick) => tick.t === 10), 'the end of the clip has no mark');
});

// ---- labels ----

test('labels drop the hour until a clip has one', () => {
  assert.strictEqual(view.tickLabel(90, 30, 600), '1:30');
  assert.strictEqual(view.tickLabel(90, 30, 7200), '0:01:30');
  assert.strictEqual(view.tickLabel(3661, 1, 7200), '1:01:01');
});

test('a sub-second step labels the decimal', () => {
  assert.strictEqual(view.tickLabel(12.5, 0.5, 60), '0:12.5');
  assert.strictEqual(view.tickLabel(65.2, 0.2, 600), '1:05.2');
});

test('a label never shows sixty seconds', () => {
  for (const step of [1, 2, 5, 10, 15, 30, 60]) {
    for (let t = 0; t <= 600; t += step) {
      const label = view.tickLabel(t, step, 600);
      assert.ok(!/:60$/.test(label), t + 's with a ' + step + 's step read ' + label);
    }
  }
});
