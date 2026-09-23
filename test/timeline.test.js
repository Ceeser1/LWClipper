'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/timeline');

// A minute of video and a minute of sound, which is all these tests need to be
// about placement rather than about media.
function video(props) {
  return T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60, ...props });
}
function audio(props) {
  return T.createLayer({ type: 'audio', src: 'a.mp3', sourceDuration: 60, ...props });
}

test('a new layer shows the rest of its source', () => {
  const l = video({ sourceIn: 10 });
  assert.equal(l.duration, 50);
  assert.equal(T.endOf(l), 50);
});

test('a layer cannot claim more source than exists', () => {
  const l = video({ sourceIn: 50, duration: 9999 });
  assert.equal(l.duration, 10);
});

test('sourceTimeFor maps the timeline onto the source', () => {
  // Placed at 10s on the timeline, showing the source from 4s in. The moment
  // the layer starts is 4s of source; ten seconds later it is 14s of source.
  const l = video({ start: 10, sourceIn: 4 });
  assert.equal(T.sourceTimeFor(l, 10), 4);
  assert.equal(T.sourceTimeFor(l, 20), 14);
});

test('a layer trimmed at both ends and then moved still shows the same frames', () => {
  // The one that matters: trimming is non-destructive and moving is
  // independent of it, so the source span has to survive both untouched.
  let layers = [video({ id: 'a' })];
  layers = T.trimLayer(layers, 'a', 'start', 5);
  layers = T.trimLayer(layers, 'a', 'end', 20);

  const trimmed = T.layerById(layers, 'a');
  assert.equal(trimmed.start, 5);
  assert.equal(trimmed.duration, 15);
  assert.equal(trimmed.sourceIn, 5);
  assert.equal(T.sourceTimeFor(trimmed, 5), 5, 'first frame shown');
  assert.equal(T.sourceTimeFor(trimmed, 20), 20, 'one past the last frame shown');

  layers = T.moveLayer(layers, 'a', 100);
  const moved = T.layerById(layers, 'a');
  assert.equal(moved.duration, 15, 'moving does not change how long it runs');
  assert.equal(moved.sourceIn, 5, 'moving does not change what it shows');
  assert.equal(T.sourceTimeFor(moved, 100), 5, 'same first frame, later on the timeline');
  assert.equal(T.sourceTimeFor(moved, 115), 20, 'same last frame');
});

test('the left edge stops where the source begins', () => {
  let layers = [video({ id: 'a' })];
  layers = T.trimLayer(layers, 'a', 'start', 5);
  // Dragging further left than there is source to reveal must stop at 0, not
  // seek to a negative source time.
  layers = T.trimLayer(layers, 'a', 'start', -30);
  const l = T.layerById(layers, 'a');
  assert.equal(l.start, 0);
  assert.equal(l.sourceIn, 0);
  assert.equal(l.duration, 60);
});

test('the right edge stops where the source ends', () => {
  let layers = [video({ id: 'a', start: 100, sourceIn: 5, duration: 15 })];
  layers = T.trimLayer(layers, 'a', 'end', 9999);
  const l = T.layerById(layers, 'a');
  // 55 seconds of source left after the 5 second in-point.
  assert.equal(l.duration, 55);
  assert.equal(T.endOf(l), 155);
});

test('neither edge can shrink a layer away to nothing', () => {
  const start = T.trimLayer([video({ id: 'a' })], 'a', 'start', 59.999);
  assert.equal(T.layerById(start, 'a').duration, T.MIN_LAYER_SPAN);
  const end = T.trimLayer([video({ id: 'a' })], 'a', 'end', 0.001);
  assert.equal(T.layerById(end, 'a').duration, T.MIN_LAYER_SPAN);
});

test('a trimmed layer can be dragged back out to its full extent', () => {
  let layers = [video({ id: 'a' })];
  layers = T.trimLayer(layers, 'a', 'start', 12);
  layers = T.trimLayer(layers, 'a', 'end', 30);
  layers = T.trimLayer(layers, 'a', 'start', 0);
  layers = T.trimLayer(layers, 'a', 'end', 60);
  const l = T.layerById(layers, 'a');
  assert.deepEqual(
    { start: l.start, sourceIn: l.sourceIn, duration: l.duration },
    { start: 0, sourceIn: 0, duration: 60 },
  );
});

test('overlapping layers come back to front, so Video 1 draws last', () => {
  const layers = [
    video({ id: 'top', start: 0, duration: 30 }),
    video({ id: 'middle', start: 5, duration: 30 }),
    video({ id: 'bottom', start: 10, duration: 30 }),
  ];
  // All three cover 15s. Drawing them in the order returned leaves index 0 on
  // top, which is what "Video 1 is on top" means.
  assert.deepEqual(T.layersAt(layers, 15).map((l) => l.id), ['bottom', 'middle', 'top']);
  // At 2s only the first has started.
  assert.deepEqual(T.layersAt(layers, 2).map((l) => l.id), ['top']);
  // At 32s the first has ended, and the two that are left keep their order.
  assert.deepEqual(T.layersAt(layers, 32).map((l) => l.id), ['bottom', 'middle']);
});

test('a layer covers its start but not its end', () => {
  const l = video({ start: 10, duration: 5 });
  assert.equal(T.covers(l, 10), true);
  assert.equal(T.covers(l, 14.999), true);
  assert.equal(T.covers(l, 15), false, 'the end is where the next thing begins');
});

test('a disabled layer is not drawn', () => {
  const layers = [
    video({ id: 'off', start: 0, duration: 30, enabled: false }),
    video({ id: 'on', start: 0, duration: 30 }),
  ];
  assert.deepEqual(T.layersAt(layers, 5).map((l) => l.id), ['on']);
});

test('the total duration follows the last-ending layer, not the last in the list', () => {
  const layers = [
    video({ id: 'long', start: 0, duration: 45 }),
    video({ id: 'short', start: 5, duration: 10 }),
  ];
  assert.equal(T.totalDuration(layers), 45);
  // Dragging the short one out past the long one makes it the end of the
  // project, which is what "dragging content right extends the maximum" means.
  assert.equal(T.totalDuration(T.moveLayer(layers, 'short', 100)), 110);
});

test('a disabled layer still counts towards the total duration', () => {
  // Otherwise the timeline would shorten and redraw every time a box is
  // unticked, and lengthen again when it is ticked back.
  const layers = [video({ id: 'a', start: 0, duration: 45, enabled: false })];
  assert.equal(T.totalDuration(layers), 45);
});

test('an empty project has no duration', () => {
  assert.equal(T.totalDuration([]), 0);
});

test('a new video layer lands after the last video, above the audio block', () => {
  let layers = [video({ id: 'v1' }), audio({ id: 'a1' })];
  layers = T.addLayer(layers, video({ id: 'v2' }));
  assert.deepEqual(layers.map((l) => l.id), ['v1', 'v2', 'a1']);
  layers = T.addLayer(layers, audio({ id: 'a2' }));
  assert.deepEqual(layers.map((l) => l.id), ['v1', 'v2', 'a1', 'a2']);
});

test('the first audio layer lands below video, the first video above audio', () => {
  const withAudio = T.addLayer([video({ id: 'v1' })], audio({ id: 'a1' }));
  assert.deepEqual(withAudio.map((l) => l.id), ['v1', 'a1']);
  const withVideo = T.addLayer([audio({ id: 'a1' })], video({ id: 'v1' }));
  assert.deepEqual(withVideo.map((l) => l.id), ['v1', 'a1']);
});

test('removing a layer leaves the rest in order', () => {
  const layers = [video({ id: 'v1' }), video({ id: 'v2' }), audio({ id: 'a1' })];
  assert.deepEqual(T.removeLayer(layers, 'v2').map((l) => l.id), ['v1', 'a1']);
  assert.deepEqual(T.removeLayer(layers, 'nope').map((l) => l.id), ['v1', 'v2', 'a1']);
});

test('the z-order arrows step past the same type and never leave the block', () => {
  const layers = [video({ id: 'v1' }), video({ id: 'v2' }), video({ id: 'v3' }),
    audio({ id: 'a1' }), audio({ id: 'a2' })];

  assert.deepEqual(T.reorderLayer(layers, 'v3', -1).map((l) => l.id),
    ['v1', 'v3', 'v2', 'a1', 'a2']);
  assert.deepEqual(T.reorderLayer(layers, 'v1', 1).map((l) => l.id),
    ['v2', 'v1', 'v3', 'a1', 'a2']);
  // The back-most video has no video below it to swap with, and must not fall
  // through into the audio block.
  assert.deepEqual(T.reorderLayer(layers, 'v3', 1).map((l) => l.id),
    ['v1', 'v2', 'v3', 'a1', 'a2']);
  // Nor may the first audio row climb into the video block.
  assert.deepEqual(T.reorderLayer(layers, 'a1', -1).map((l) => l.id),
    ['v1', 'v2', 'v3', 'a1', 'a2']);
  assert.deepEqual(T.reorderLayer(layers, 'a2', -1).map((l) => l.id),
    ['v1', 'v2', 'v3', 'a2', 'a1']);
});

test('nothing can be moved before the start of the project', () => {
  const layers = T.moveLayer([video({ id: 'a', start: 10 })], 'a', -5);
  assert.equal(T.layerById(layers, 'a').start, 0);
});

test('drag arithmetic does not accumulate floating point noise', () => {
  // 0.1 + 0.2 is the classic, and a timeline is nothing but sums of drags.
  let layers = [video({ id: 'a', start: 0.1 })];
  layers = T.moveLayer(layers, 'a', T.layerById(layers, 'a').start + 0.2);
  assert.equal(T.layerById(layers, 'a').start, 0.3);
});

test('every change returns a new list and leaves the old one alone', () => {
  // The undo stack is snapshots of this array. A function that mutated in
  // place would quietly rewrite history.
  const layers = [video({ id: 'a', start: 0, duration: 30 }), audio({ id: 'b' })];
  const before = JSON.stringify(layers);

  const moved = T.moveLayer(layers, 'a', 50);
  const trimmed = T.trimLayer(layers, 'a', 'end', 10);
  const added = T.addLayer(layers, video({ id: 'c' }));
  const removed = T.removeLayer(layers, 'a');
  const reordered = T.reorderLayer(layers, 'a', 1);
  const set = T.setLayer(layers, 'a', { enabled: false });

  assert.equal(JSON.stringify(layers), before, 'the original list is untouched');
  for (const next of [moved, trimmed, added, removed, set]) {
    assert.notEqual(next, layers, 'a changed list is a new array');
  }
  assert.equal(reordered, layers, 'a reorder with nowhere to go returns the list as it was');
  assert.equal(T.layerById(moved, 'a').start, 50);
  assert.equal(T.layerById(trimmed, 'a').duration, 10);
  assert.equal(T.layerById(set, 'a').enabled, false);
});

// ---- the gestures Step 9 put on the timeline ----

test('a layer moved along the timeline and then trimmed still opens back to the whole source', () => {
  // The left edge stops at the source's own beginning, which after a move is
  // no longer the project's beginning. Pulling both edges back out has to hand
  // the whole file back, at the position the move left it in.
  let layers = [video({ id: 'a' })];
  layers = T.moveLayer(layers, 'a', 100);
  layers = T.trimLayer(layers, 'a', 'start', 118);
  layers = T.trimLayer(layers, 'a', 'end', 140);
  let l = T.layerById(layers, 'a');
  assert.equal(l.sourceIn, 18);
  assert.equal(l.duration, 22);

  layers = T.trimLayer(layers, 'a', 'start', -999);
  layers = T.trimLayer(layers, 'a', 'end', 9999);
  l = T.layerById(layers, 'a');
  assert.equal(l.start, 100, 'back where the move put it');
  assert.equal(l.sourceIn, 0);
  assert.equal(l.duration, 60, 'showing the whole source again');
});

test('a clip driven against the start of the project comes away where it went in', () => {
  // The drag is anchored rather than incremental: the value is always the grab
  // point plus the whole travel since. So a clip pushed into the zero wall and
  // dragged back out reappears when the pointer passes the point it was taken
  // hold of, instead of leaving the wall the moment the hand turns round.
  const anchor = 20;
  const layers = [video({ id: 'a', start: anchor })];
  const at = (travel) => T.layerById(T.moveLayer(layers, 'a', anchor + travel), 'a').start;
  assert.equal(at(-50), 0, 'driven well past the wall it stops at zero');
  assert.equal(at(-21), 0, 'still at zero a pixel short of where it was grabbed');
  assert.equal(at(-20), 0, 'reaching zero exactly as the pointer returns');
  assert.equal(at(-5), 15, 'and only then does it come away');
});

test('no sequence of drags and trims can put a layer in an impossible state', () => {
  // Step 9's done criterion, near enough verbatim. A drag is hundreds of these
  // calls with whatever numbers the hand produced, including numbers well off
  // both ends of the source, so the sequence is generated rather than written
  // out. Fixed seed, because a failure should be reproducible rather than a
  // story about a run that happened once.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  let layers = [video({ id: 'a', start: 10, sourceIn: 5, duration: 20 })];
  for (let i = 0; i < 4000; i += 1) {
    // Ranges from -70 to 130 against a 60 second source, so most of the draws
    // land outside what is legal and the clamping is what is under test.
    const at = (rand() * 200) - 70;
    const pick = rand();
    if (pick < 0.34) layers = T.moveLayer(layers, 'a', at);
    else if (pick < 0.67) layers = T.trimLayer(layers, 'a', 'start', at);
    else layers = T.trimLayer(layers, 'a', 'end', at);

    const l = T.layerById(layers, 'a');
    const where = 'after ' + (i + 1) + ' gestures: ';
    assert.ok(l.start >= 0, where + 'start ' + l.start + ' is before the project');
    assert.ok(l.duration >= T.MIN_LAYER_SPAN - 1e-9,
      where + 'duration ' + l.duration + ' has shrunk past the minimum');
    assert.ok(l.sourceIn >= 0, where + 'sourceIn ' + l.sourceIn + ' is before the file');
    assert.ok(l.sourceIn + l.duration <= l.sourceDuration + 1e-9,
      where + 'showing ' + (l.sourceIn + l.duration) + 's of a ' + l.sourceDuration + 's file');
    assert.equal(l.sourceDuration, 60, where + 'the source itself was touched');
  }

  // And after all that it still opens back up to the whole file, which is the
  // half of the criterion about lengthening a trimmed layer.
  layers = T.trimLayer(layers, 'a', 'start', -999);
  layers = T.trimLayer(layers, 'a', 'end', 9999);
  assert.equal(T.layerById(layers, 'a').duration, 60);
  assert.equal(T.layerById(layers, 'a').sourceIn, 0);
});

// ---- Step 11, the frame a crop is measured in ----

test('a layer records the frame its crop will be measured against', () => {
  const l = video({ sourceWidth: 1920, sourceHeight: 1080 });
  assert.equal(l.sourceWidth, 1920);
  assert.equal(l.sourceHeight, 1080);
});

test('an unmeasured source is zero rather than undefined', () => {
  // Every audio layer, and any video one made before a probe answered. Zero
  // means "ask the decoder", which is what layerSource in the renderer does.
  const l = audio();
  assert.equal(l.sourceWidth, 0);
  assert.equal(l.sourceHeight, 0);
});

test('nonsense dimensions read as unmeasured', () => {
  for (const bad of [-4, 0, 'wide', NaN, null, undefined, Infinity]) {
    assert.equal(video({ sourceWidth: bad }).sourceWidth, 0, String(bad));
  }
});

test('a fractional dimension is floored to whole pixels', () => {
  assert.equal(video({ sourceWidth: 1919.6 }).sourceWidth, 1919);
});

test('a crop survives setLayer without the frame it was measured in moving', () => {
  const l = video({ sourceWidth: 1920, sourceHeight: 1080 });
  const next = T.setLayer([l], l.id, { crop: { x: 0, y: 0, width: 960, height: 540 } });
  assert.deepEqual(next[0].crop, { x: 0, y: 0, width: 960, height: 540 });
  assert.equal(next[0].sourceWidth, 1920);
  assert.equal(next[0].sourceHeight, 1080);
  // Nothing mutates, so the layer handed in is untouched and an older snapshot
  // of it cannot change under the undo stack.
  assert.equal(l.crop, null);
});

test('a layer carries the rate its source was probed at', () => {
  // Step 15. The project is seeded from it and the export is written at the
  // project's rate, so it has to survive into the file the way the frame size
  // already does.
  const l = T.createLayer({ type: 'video', sourceDuration: 10, sourceFps: 29.97 });
  assert.equal(l.sourceFps, 29.97);
  assert.equal(T.createLayer({ type: 'audio', sourceDuration: 10 }).sourceFps, 0);
  assert.equal(T.createLayer({ type: 'video', sourceFps: -5 }).sourceFps, 0);
});

test('a layer carries its render rectangle, and null is centre and fit', () => {
  // V2.1. Until this field existed createLayer dropped it, and every layer
  // goes through createLayer on project open and on every undo: a position set
  // in the popup would have been put back in the middle of the frame by
  // Ctrl+Z. The geometry has read layer.render since Step 2.
  const rect = { x: 40, y: 20, width: 960, height: 540 };
  assert.deepEqual(video({ render: rect }).render, rect);
  assert.equal(video().render, null);
});

test('a render rectangle survives a round trip through the model', () => {
  // setLayer is what the popup will write through, and reorderLayer is the
  // kind of operation that rebuilds the array around a layer. Neither may lose
  // the placement on the way past.
  const rect = { x: -200, y: 0, width: 1920, height: 1080 };
  const one = video({ render: rect });
  const two = video();
  const moved = T.reorderLayer(T.setLayer([one, two], one.id, { render: rect }), one.id, 1);
  assert.deepEqual(T.layerById(moved, one.id).render, rect);
});
