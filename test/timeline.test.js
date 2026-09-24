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

// ---- V2.2, 22a. Fades ----
//
// Two numbers on a layer and one function over them. The point of the function
// being here rather than in the renderer is that the preview and ffmpeg both
// have to answer how opaque a layer is, and they must not answer differently.

test('a layer has no fades until somebody sets one', () => {
  const l = T.createLayer({ type: 'video', sourceDuration: 10 });
  assert.equal(l.fadeIn, 0);
  assert.equal(l.fadeOut, 0);
  assert.deepEqual(T.fadesOf(l), { in: 0, out: 0 });
  assert.equal(T.fadeAlphaAt(l, 0), 1, 'and is fully opaque at its first frame');
  assert.equal(T.fadeAlphaAt(l, 10), 1);
});

test('a fade survives being written through createLayer, the way render has to', () => {
  // The project file opens by running every layer back through createLayer, so
  // a field this does not name is a field that vanishes on reopening. That is
  // exactly the bug render carried until it was declared.
  const l = T.createLayer({ type: 'video', sourceDuration: 10, fadeIn: 2, fadeOut: 3 });
  const reopened = T.createLayer(JSON.parse(JSON.stringify(l)));
  assert.equal(reopened.fadeIn, 2);
  assert.equal(reopened.fadeOut, 3);
});

test('a fade is held to the layer it is on', () => {
  const l = T.createLayer({ type: 'video', sourceDuration: 60, duration: 4 });
  assert.deepEqual(T.fadesOf({ ...l, fadeIn: 100 }), { in: 4, out: 0 });
  assert.deepEqual(T.fadesOf({ ...l, fadeOut: 100 }), { in: 0, out: 4 });
  // Nonsense reads as no fade rather than as NaN reaching a filter string.
  for (const bad of [-1, NaN, Infinity, null, undefined, 'x']) {
    assert.deepEqual(T.fadesOf({ ...l, fadeIn: bad }), { in: 0, out: 0 },
      String(bad) + ' was not refused');
  }
});

test('a fade in ramps from nothing to whole across its own length', () => {
  const l = T.createLayer({
    type: 'video', sourceDuration: 60, duration: 10, start: 5, fadeIn: 2,
  });
  // Measured in timeline seconds, which is what the preview has in hand.
  assert.equal(T.fadeAlphaAt(l, 5), 0, 'transparent where the layer starts');
  assert.equal(T.fadeAlphaAt(l, 6), 0.5, 'half way up half way through');
  assert.equal(T.fadeAlphaAt(l, 7), 1, 'whole at the end of the ramp');
  assert.equal(T.fadeAlphaAt(l, 12), 1, 'and stays there');
});

test('a fade out ramps the other way, from the end of the layer', () => {
  const l = T.createLayer({
    type: 'video', sourceDuration: 60, duration: 10, start: 5, fadeOut: 4,
  });
  assert.equal(T.fadeAlphaAt(l, 5), 1);
  assert.equal(T.fadeAlphaAt(l, 11), 1, 'untouched until the ramp begins');
  assert.equal(T.fadeAlphaAt(l, 13), 0.5);
  assert.equal(T.fadeAlphaAt(l, 15), 0, 'gone where the layer ends');
});

test('the ramp is a straight line, because that is what ffmpeg draws', () => {
  // Linear and nothing else was the user's instruction, and it is also what
  // makes the preview and the export the same picture rather than two close
  // ones. Checked as a line rather than at two points.
  const l = T.createLayer({
    type: 'video', sourceDuration: 60, duration: 10, start: 0, fadeIn: 5,
  });
  for (let i = 0; i <= 10; i += 1) {
    const t = (i / 10) * 5;
    assert.ok(Math.abs(T.fadeAlphaAt(l, t) - t / 5) < 1e-9,
      'at ' + t + 's the ramp left the line');
  }
});

test('two fades that overlap multiply, which is what two fade filters do', () => {
  // Deliberately not held apart from each other. Letting them overlap means
  // there is no priority rule to invent here and then match in ffmpeg.
  const l = T.createLayer({
    type: 'video', sourceDuration: 60, duration: 4, start: 0, fadeIn: 4, fadeOut: 4,
  });
  assert.equal(T.fadeAlphaAt(l, 0), 0);
  assert.equal(T.fadeAlphaAt(l, 2), 0.25, 'half of a half in the middle');
  assert.equal(T.fadeAlphaAt(l, 4), 0);
});

test('a time outside the layer is clamped rather than refused', () => {
  const l = T.createLayer({
    type: 'video', sourceDuration: 60, duration: 10, start: 5, fadeIn: 2, fadeOut: 2,
  });
  assert.equal(T.fadeAlphaAt(l, -100), 0, 'before it, which is its first frame');
  assert.equal(T.fadeAlphaAt(l, 900), 0, 'after it, which is its last');
});

// ---- V2.3, 23a-1. Image layers ----
//
// An image is a video layer in every sense that matters to the compositor: it
// is drawn, it sits in the video block, it crops and it is placed. What it is
// not is a thing with a clock, and that is the whole of what `kind` records.

test('a layer is ordinary media unless it says otherwise', () => {
  assert.equal(T.createLayer({ type: 'video', sourceDuration: 10 }).kind, 'media');
  assert.equal(T.createLayer({ type: 'audio', sourceDuration: 10 }).kind, 'media');
  assert.equal(T.createLayer({ type: 'video', kind: 'nonsense' }).kind, 'media');
});

test('an image is a video layer, so nothing that asks about type has to change', () => {
  const img = T.createLayer({ type: 'video', kind: 'image', src: 'a.png' });
  assert.equal(img.type, 'video', 'it is drawn and it lives in the video block');
  assert.equal(img.kind, 'image', 'and what it is made of is a separate question');
});

test('a still arrives ten seconds long, which is what the user asked for', () => {
  const img = T.createLayer({ type: 'video', kind: 'image', src: 'a.png' });
  assert.equal(img.duration, T.IMAGE_SECONDS);
  assert.equal(img.duration, 10);
});

test('a still keeps the length it is given, against a source that has none', () => {
  // The trap this is here for: createLayer's ordinary rule clamps a layer to
  // sourceDuration - sourceIn, which for an image is zero, so a layer asked for
  // with ten seconds would come out with none at all and never draw.
  const img = T.createLayer({
    type: 'video', kind: 'image', src: 'a.png', duration: 4, sourceDuration: 0,
  });
  assert.equal(img.duration, 4);
  assert.ok(img.duration > 0, 'a still with no length is a layer that never draws');
});

test('a still survives being written through createLayer, like a fade', () => {
  const img = T.createLayer({ type: 'video', kind: 'image', src: 'a.png', duration: 7 });
  const reopened = T.createLayer(JSON.parse(JSON.stringify(img)));
  assert.equal(reopened.kind, 'image', 'or it comes back as a video with no frames');
  assert.equal(reopened.duration, 7);
});

test('a still can be dragged longer than it has ever been', () => {
  // The one way an image is not a video layer with a single frame in it.
  const img = T.createLayer({
    type: 'video', kind: 'image', src: 'a.png', start: 0, duration: 10,
  });
  assert.equal(T.sourceRemaining(img), Infinity, 'there is no source to run out of');
  const longer = T.trimLayer([img], img.id, 'end', 45);
  assert.equal(T.layerById(longer, img.id).duration, 45);
});

test('and longer from the left as well, which is the same fact twice', () => {
  const img = T.createLayer({
    type: 'video', kind: 'image', src: 'a.png', start: 20, duration: 10,
  });
  assert.equal(T.sourceBefore(img), Infinity, 'there is no source behind it either');
  const longer = T.trimLayer([img], img.id, 'start', 4);
  assert.equal(T.layerById(longer, img.id).start, 4);
  assert.equal(T.layerById(longer, img.id).duration, 26, 'the right edge stayed at 30');
  assert.equal(T.endOf(T.layerById(longer, img.id)), 30);
});

test('a video still stops at the last frame it has', () => {
  // The rule images are the exception to, checked alongside them so the two
  // cannot quietly become the same.
  const vid = T.createLayer({ type: 'video', src: 'a.mp4', sourceDuration: 12, start: 0 });
  assert.equal(T.sourceRemaining(vid), 12);
  const dragged = T.trimLayer([vid], vid.id, 'end', 99);
  assert.equal(T.layerById(dragged, vid.id).duration, 12, 'and no further');
});

test('a still shortens the way a video does', () => {
  const img = T.createLayer({
    type: 'video', kind: 'image', src: 'a.png', start: 2, duration: 10,
  });
  const shorter = T.trimLayer([img], img.id, 'end', 6);
  assert.equal(T.layerById(shorter, img.id).duration, 4);
});

test('a still left edge trims in, comes back out, and keeps going to zero', () => {
  // Trimmed in and back out is the part a video does too. Carrying on past
  // where the clip was put is the part only a still does, and it stops at the
  // start of the timeline rather than at the clip's own beginning.
  const img = T.createLayer({
    type: 'video', kind: 'image', src: 'a.png', start: 5, duration: 10,
  });
  const inward = T.trimLayer([img], img.id, 'start', 8);
  assert.equal(T.layerById(inward, img.id).start, 8);
  assert.equal(T.layerById(inward, img.id).duration, 7);
  const back = T.trimLayer(inward, img.id, 'start', 5);
  assert.equal(T.layerById(back, img.id).start, 5, 'all the way back');
  assert.equal(T.layerById(back, img.id).duration, 10);
  const further = T.trimLayer(back, img.id, 'start', 0);
  assert.equal(T.layerById(further, img.id).start, 0, 'and on past where it was put');
  assert.equal(T.layerById(further, img.id).duration, 15, 'the right edge never moved');
  assert.equal(T.layerById(further, img.id).sourceIn, 0, 'and no negative in-point');
});

test('a still left edge stops at the start of the timeline, not before it', () => {
  // The user's own exception to both edges extending: "except it sits at 0.0s
  // already, obviously". A negative start would put the clip somewhere the
  // ruler does not go and the export cannot write.
  const img = T.createLayer({
    type: 'video', kind: 'image', src: 'a.png', start: 3, duration: 10,
  });
  const dragged = T.trimLayer([img], img.id, 'start', -40);
  assert.equal(T.layerById(dragged, img.id).start, 0);
  assert.equal(T.endOf(T.layerById(dragged, img.id)), 13, 'the right edge held');
});

test('a video left edge still stops at the first frame it has', () => {
  // The rule stills are the exception to, checked alongside them so the two
  // cannot quietly become the same. The twin of the right edge test above.
  const vid = T.createLayer({
    type: 'video', src: 'a.mp4', sourceDuration: 20, sourceIn: 4, duration: 6, start: 10,
  });
  assert.equal(T.sourceBefore(vid), 4, 'four seconds of source sit behind the in-point');
  const dragged = T.trimLayer([vid], vid.id, 'start', 0);
  assert.equal(T.layerById(dragged, vid.id).start, 6, 'back by those four and no further');
  assert.equal(T.layerById(dragged, vid.id).sourceIn, 0);
  assert.equal(T.layerById(dragged, vid.id).duration, 10);
});

test('a still is never dragged down to nothing', () => {
  const img = T.createLayer({ type: 'video', kind: 'image', src: 'a.png', start: 0 });
  const crushed = T.trimLayer([img], img.id, 'end', -100);
  assert.ok(T.layerById(crushed, img.id).duration > 0);
});

// ---- V2.4. The maximum alpha of a layer ----
//
// A ceiling rather than a second fade, which is the one thing about it that can
// be got wrong. Every test below is about that: what it does to the fades, what
// it does not do to the sound, and what it reads as when nobody has set it.

test('a layer is fully opaque unless somebody says otherwise', () => {
  assert.equal(T.createLayer({ type: 'video', sourceDuration: 10 }).alpha, 1);
  assert.equal(T.alphaOf(T.createLayer({ type: 'video', sourceDuration: 10 })), 1);
});

test('alphaOf reads 1 from anything it cannot make sense of', () => {
  // The one value that cannot be a mistake is the one that changes nothing. A
  // layer that came back invisible because a field went missing would look
  // exactly like a layer somebody had turned off.
  assert.equal(T.alphaOf(null), 1);
  assert.equal(T.alphaOf({}), 1);
  assert.equal(T.alphaOf({ alpha: 'half' }), 1);
  assert.equal(T.alphaOf({ alpha: NaN }), 1);
  // But zero is a real answer and not a missing one.
  assert.equal(T.alphaOf({ alpha: 0 }), 0);
});

test('alpha is held between nothing and all of it', () => {
  assert.equal(T.alphaOf({ alpha: 4 }), 1);
  assert.equal(T.alphaOf({ alpha: -2 }), 0);
  assert.equal(T.createLayer({ type: 'video', sourceDuration: 10, alpha: 9 }).alpha, 1);
});

test('alpha survives being written through createLayer, like a fade', () => {
  const l = T.createLayer({ type: 'video', src: 'a.mp4', sourceDuration: 10, alpha: 0.4 });
  const reopened = T.createLayer(JSON.parse(JSON.stringify(l)));
  assert.equal(reopened.alpha, 0.4, 'or every project reopened is back at full');
});

test('the ceiling multiplies the ramp rather than replacing it', () => {
  // The whole of what "maximum" means: a layer at 60% that fades in over two
  // seconds goes 0, 30, 60, and never 100 at any point in between.
  const l = T.createLayer({
    type: 'video', src: 'a.mp4', sourceDuration: 10, duration: 10, fadeIn: 2, alpha: 0.6,
  });
  assert.equal(T.fadeAlphaAt(l, 0), 0);
  assert.equal(T.layerAlphaAt(l, 0), 0);
  assert.equal(T.fadeAlphaAt(l, 1), 0.5, 'the ramp alone is half way up');
  assert.equal(T.layerAlphaAt(l, 1), 0.3, 'and the picture is half of sixty');
  assert.equal(T.fadeAlphaAt(l, 5), 1, 'the ramp has finished');
  assert.equal(T.layerAlphaAt(l, 5), 0.6, 'and it finished at the ceiling');
});

test('with no fade the picture is simply the ceiling, at every moment', () => {
  const l = T.createLayer({
    type: 'video', src: 'a.mp4', sourceDuration: 10, duration: 10, alpha: 0.25,
  });
  for (const at of [0, 3, 9.9]) assert.equal(T.layerAlphaAt(l, at), 0.25);
});

test('with no ceiling the picture is simply the ramp, so nothing old changes', () => {
  const l = T.createLayer({
    type: 'video', src: 'a.mp4', sourceDuration: 10, duration: 10, fadeIn: 4,
  });
  for (const at of [0, 1, 2, 3, 8]) {
    assert.equal(T.layerAlphaAt(l, at), T.fadeAlphaAt(l, at));
  }
});

test('an alpha of zero is transparent, not a layer that is off', () => {
  const l = T.createLayer({
    type: 'video', src: 'a.mp4', sourceDuration: 10, duration: 10, alpha: 0,
  });
  assert.equal(T.layerAlphaAt(l, 5), 0);
  assert.equal(l.enabled, true, 'it still exists, it still exports, it is just clear');
  assert.equal(T.covers(l, 5), true);
});

test('setAlpha writes the one layer and leaves the list alone', () => {
  const list = [video({ duration: 10 }), video({ duration: 10 })];
  const next = T.setAlpha(list, list[0].id, 0.35);
  assert.equal(T.layerById(next, list[0].id).alpha, 0.35);
  assert.equal(T.layerById(next, list[1].id).alpha, 1, 'the other one is untouched');
});

test('setAlpha clamps, so a drag past either end stops under the pointer', () => {
  const list = [video({ duration: 10 })];
  assert.equal(T.setAlpha(list, list[0].id, 3)[0].alpha, 1);
  assert.equal(T.setAlpha(list, list[0].id, -3)[0].alpha, 0);
});

test('setAlpha returns the same layer when the value has not moved', () => {
  // A drag reports a value on every pointer move, and most of them land on the
  // number that is already there.
  const list = [video({ duration: 10, alpha: 0.5 })];
  const same = T.setAlpha(list, list[0].id, 0.5);
  assert.equal(same[0], list[0], 'the same object, so nothing downstream rebuilds');
});

// --- setting a fade, 22a-4 --------------------------------------------------

test('setFade writes one end and leaves the other alone', () => {
  const list = [video({ duration: 10 })];
  const withIn = T.setFade(list, list[0].id, 'in', 2);
  assert.equal(withIn[0].fadeIn, 2);
  assert.equal(withIn[0].fadeOut, 0);
  const both = T.setFade(withIn, list[0].id, 'out', 3);
  assert.equal(both[0].fadeIn, 2, 'the fade in survived the fade out being set');
  assert.equal(both[0].fadeOut, 3);
});

test('a fade is clamped to the clip on the way in, not only on the way out', () => {
  // fadesOf already holds a read to the span. This is about the number the
  // handle reports and the clip draws being the same one, so a drag past the
  // end of the clip stops under the pointer instead of running on unseen.
  const list = [video({ duration: 4 })];
  assert.equal(T.setFade(list, list[0].id, 'in', 99)[0].fadeIn, 4);
  assert.equal(T.setFade(list, list[0].id, 'out', -5)[0].fadeOut, 0);
  for (const bad of [NaN, undefined, null, 'x']) {
    assert.equal(T.setFade(list, list[0].id, 'in', bad)[0].fadeIn, 0);
  }
});

test('setting a fade to what it already is leaves the layer untouched', () => {
  // The same object back, not an equal one. replace still hands over a fresh
  // array, which costs nothing; what matters is that the layer itself is the
  // one that was there, so nothing reading it decides it has changed.
  const list = [video({ duration: 10, fadeIn: 2 })];
  assert.equal(T.setFade(list, list[0].id, 'in', 2)[0], list[0]);
  assert.notEqual(T.setFade(list, list[0].id, 'in', 3)[0], list[0]);
});

test('a fade set on a grouped clip is set on its sound too', () => {
  const g = T.newGroupId();
  const list = [video({ duration: 10, groupId: g }), audio({ duration: 10, groupId: g })];
  const faded = T.fadeGroup(list, list[0].id, 'out', 2.5);
  assert.equal(faded[0].fadeOut, 2.5);
  assert.equal(faded[1].fadeOut, 2.5, 'the sound goes down with the picture');
});

test('each member of a group is held to its own length', () => {
  // A pair whose halves are not quite equal, which trimming one of them apart
  // from the other can produce.
  const g = T.newGroupId();
  const list = [video({ duration: 10, groupId: g }), audio({ duration: 3, groupId: g })];
  const faded = T.fadeGroup(list, list[0].id, 'in', 6);
  assert.equal(faded[0].fadeIn, 6);
  assert.equal(faded[1].fadeIn, 3, 'clamped to the shorter one rather than overrunning it');
});

test('a fade on an ungrouped clip goes nowhere else', () => {
  const list = [video({ duration: 10 }), video({ duration: 10 })];
  const faded = T.fadeGroup(list, list[0].id, 'in', 1);
  assert.equal(faded[0].fadeIn, 1);
  assert.equal(faded[1].fadeIn, 0);
});
