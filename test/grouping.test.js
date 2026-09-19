'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/timeline');

// A pair as grouping makes one: a video layer and an audio layer of the same
// file, at the same place, showing the same part of it.
function pair(props = {}) {
  const gid = 'g1';
  return [
    T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60, groupId: gid, ...props }),
    T.createLayer({ type: 'audio', src: 'v.mp4', sourceDuration: 60, groupId: gid, ...props }),
  ];
}

const at = (layers, i) => ({ start: layers[i].start, end: T.endOf(layers[i]) });

// ---- what a group is ----

test('a layer with no group is a group of one', () => {
  const l = T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60 });
  assert.deepEqual(T.groupOf([l], l.id).map((x) => x.id), [l.id]);
});

test('a grouped layer knows its partner', () => {
  const layers = pair();
  assert.deepEqual(T.groupOf(layers, layers[0].id).map((l) => l.type), ['video', 'audio']);
  assert.deepEqual(T.groupOf(layers, layers[1].id).map((l) => l.type), ['video', 'audio']);
});

test('groupOf on a layer that is not there is empty rather than a throw', () => {
  assert.deepEqual(T.groupOf(pair(), 'nope'), []);
});

test('group links exactly the named layers', () => {
  const a = T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60 });
  const b = T.createLayer({ type: 'audio', src: 'v.mp4', sourceDuration: 60 });
  const c = T.createLayer({ type: 'audio', src: 'other.mp3', sourceDuration: 60 });
  const out = T.group([a, b, c], [a.id, b.id]);
  assert.equal(out[0].groupId, out[1].groupId);
  assert.ok(out[0].groupId);
  assert.equal(out[2].groupId, null);
});

test('ungroup breaks the link and moves nothing', () => {
  const layers = pair();
  const out = T.ungroup(layers, layers[0].groupId);
  assert.equal(out[0].groupId, null);
  assert.equal(out[1].groupId, null);
  assert.deepEqual(at(out, 0), at(layers, 0));
  assert.deepEqual(at(out, 1), at(layers, 1));
});

test('ungroup with no group id changes nothing', () => {
  const layers = pair();
  assert.equal(T.ungroup(layers, null), layers);
});

// ---- the marker's index ----

test('group ids come back in the order they first appear', () => {
  const a = T.createLayer({ type: 'video', src: 'a.mp4', sourceDuration: 60, groupId: 'g2' });
  const b = T.createLayer({ type: 'video', src: 'b.mp4', sourceDuration: 60, groupId: 'g1' });
  const c = T.createLayer({ type: 'audio', src: 'a.mp4', sourceDuration: 60, groupId: 'g2' });
  // g2 first because its video layer is first, whatever the ids sort like.
  assert.deepEqual(T.groupIds([a, b, c]), ['g2', 'g1']);
});

test('ungrouped layers contribute no group id', () => {
  const l = T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60 });
  assert.deepEqual(T.groupIds([l]), []);
});

// ---- moving as one ----

test('moving one member moves the whole group', () => {
  const p = pair();
  for (const dragged of [0, 1]) {
    const out = T.moveGroup(p, p[dragged].id, 10);
    assert.equal(out[0].start, 10, 'dragging member ' + dragged);
    assert.equal(out[1].start, 10, 'dragging member ' + dragged);
  }
});

test('a group keeps the offsets between its members', () => {
  const p = pair();
  // The sound deliberately sits two seconds later than the picture.
  const offset = T.moveLayer(p, p[1].id, 2);
  const out = T.moveGroup(offset, offset[0].id, 10);
  assert.equal(out[0].start, 10);
  assert.equal(out[1].start, 12);
});

test('a group stops at zero as one, rather than sliding apart', () => {
  // This is the whole reason the shift is clamped once for the group: clamping
  // each layer on its own lets the picture stop at zero while the sound
  // carries on past it.
  const p = pair();
  const offset = T.moveLayer(p, p[1].id, 5);
  const out = T.moveGroup(offset, offset[0].id, -20);
  assert.equal(out[0].start, 0);
  assert.equal(out[1].start, 5, 'the offset survives the clamp');
});

test('moving an ungrouped layer is still just moving it', () => {
  const l = T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60 });
  assert.equal(T.moveGroup([l], l.id, 8)[0].start, 8);
});

// ---- trimming as one ----

test('trimming the start of one member trims the group', () => {
  const p = pair();
  const out = T.trimGroup(p, p[0].id, 'start', 10);
  assert.equal(out[0].start, 10);
  assert.equal(out[1].start, 10);
  assert.equal(out[0].sourceIn, 10, 'and the picture stays still while the edge moves');
  assert.equal(out[1].sourceIn, 10);
});

test('trimming the end of one member trims the group', () => {
  const p = pair();
  const out = T.trimGroup(p, p[0].id, 'end', 30);
  assert.equal(T.endOf(out[0]), 30);
  assert.equal(T.endOf(out[1]), 30);
});

test('a group cannot be lengthened past what its shortest member has', () => {
  // The sound is a 20 second file; the picture is 60. Both end at 20, so the
  // picture has forty seconds still in hand and the sound has none. Pulling
  // the right edge out must move neither, rather than stretching the picture
  // away from its sound.
  const gid = 'g1';
  const video = T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60, groupId: gid });
  const audio = T.createLayer({ type: 'audio', src: 'v.mp4', sourceDuration: 20, groupId: gid });
  const aligned = T.trimLayer([video, audio], video.id, 'end', 20);
  assert.equal(T.endOf(aligned[0]), 20, 'the pair starts out aligned');
  const out = T.trimGroup(aligned, video.id, 'end', 50);
  assert.equal(T.endOf(out[0]), 20);
  assert.equal(T.endOf(out[1]), 20);
});

test('a group shortens by one shift, applied to every member', () => {
  // Not "every member ends at the time being dragged to": that would snap a
  // pair together that was deliberately offset. The edge being dragged lands
  // where it was dropped and everything else moves with it by the same amount.
  const gid = 'g1';
  const video = T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60, groupId: gid });
  const audio = T.createLayer({
    type: 'audio', src: 'v.mp4', sourceDuration: 60, duration: 55, groupId: gid,
  });
  const out = T.trimGroup([video, audio], video.id, 'end', 50);
  assert.equal(T.endOf(out[0]), 50, 'the dragged edge lands where it was dropped');
  assert.equal(T.endOf(out[1]), 45, 'and the other keeps its five second offset');
});

test('a group cannot be trimmed back past what its members have in hand', () => {
  const gid = 'g1';
  // Both start ten seconds in, so the left edge can go back ten and no further.
  const video = T.createLayer({
    type: 'video', src: 'v.mp4', sourceDuration: 60, sourceIn: 10, start: 10, groupId: gid,
  });
  const audio = T.createLayer({
    type: 'audio', src: 'v.mp4', sourceDuration: 60, sourceIn: 4, start: 10, groupId: gid,
  });
  const out = T.trimGroup([video, audio], video.id, 'start', 0);
  assert.equal(out[0].start, 6, 'stopped by the member with the least behind it');
  assert.equal(out[1].start, 6);
  assert.equal(out[1].sourceIn, 0);
});

test('a group whose members have no room at all does not tear', () => {
  const gid = 'g1';
  const video = T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60, groupId: gid });
  // Nothing left to give from the right: already at the minimum span.
  const audio = T.createLayer({
    type: 'audio', src: 'v.mp4', sourceDuration: T.MIN_LAYER_SPAN, groupId: gid,
  });
  const layers = [video, audio];
  const out = T.trimGroup(layers, video.id, 'end', 40);
  assert.equal(out, layers, 'nothing moves at all');
});

test('a trim that changes nothing hands the same array back', () => {
  const p = pair();
  assert.equal(T.trimGroup(p, p[0].id, 'end', T.endOf(p[0])), p);
});

test('trimming an ungrouped layer is still just trimming it', () => {
  const l = T.createLayer({ type: 'video', src: 'v.mp4', sourceDuration: 60 });
  assert.equal(T.endOf(T.trimGroup([l], l.id, 'end', 25)[0]), 25);
});

// ---- deleting ----

test('deleting one member leaves the other, still marked', () => {
  // The design's rule: the pair is unlinked by the delete, only the clicked
  // layer goes, and the survivor keeps its marker so it is visible which one
  // it was.
  const p = pair();
  const out = T.removeLayer(p, p[1].id);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'video');
  assert.equal(out[0].groupId, p[0].groupId, 'the survivor keeps the marker');
  assert.deepEqual(T.groupOf(out, out[0].id).map((l) => l.id), [out[0].id],
    'and is a group of one, so nothing is linked to it any more');
});

test('a group of one moves and trims like any single layer', () => {
  const p = pair();
  const alone = T.removeLayer(p, p[1].id);
  assert.equal(T.moveGroup(alone, alone[0].id, 12)[0].start, 12);
  assert.equal(T.endOf(T.trimGroup(alone, alone[0].id, 'end', 18)[0]), 18);
});

// ---- nothing mutates ----

test('none of it mutates what it was given', () => {
  const p = pair();
  const before = JSON.stringify(p);
  T.moveGroup(p, p[0].id, 30);
  T.trimGroup(p, p[0].id, 'start', 10);
  T.ungroup(p, p[0].groupId);
  T.group(p, [p[0].id]);
  assert.equal(JSON.stringify(p), before);
});
