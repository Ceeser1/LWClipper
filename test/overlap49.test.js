'use strict';

// V4.9. An overlap seen from either of its two ends: the transition a fade is
// part of, the curve chosen for it going onto both clips, and the pop-up
// drawing each choice as the crossing pair.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/timeline');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const CLIPS = read('renderer', 'app', 'clips.js');

function clip(type, props) {
  return T.createLayer({
    type, src: type === 'audio' ? 'a.mp3' : 'a.mp4', sourceDuration: 60, duration: 10, lane: 0, ...props,
  });
}

// Two clips on one row, the second starting at `bStart`, as a gesture leaves
// them: the overlap's fades written by crossfade.
function pair(type, bStart, props = {}) {
  const at = (start) => T.arrangeLanes([
    clip(type, { id: 'A', start: 0, ...props.a }),
    clip(type, { id: 'B', start, ...props.b }),
  ]);
  return T.crossfade(at(20), at(bStart));
}

test('an overlap is one transition, asked for by the earlier clip\'s end or the later clip\'s start', () => {
  const list = pair('video', 8);
  const want = { from: 'A', into: 'B', overlap: 2, both: false, curve: 'linear' };
  assert.deepEqual(T.overlapOf(list, 'B', 'in'), want);
  assert.deepEqual(T.overlapOf(list, 'A', 'out'), want);
  // The ends that overlap nothing are plain fades.
  assert.equal(T.overlapOf(list, 'A', 'in'), null);
  assert.equal(T.overlapOf(list, 'B', 'out'), null);
  assert.equal(T.overlapOf(list, 'nobody', 'in'), null);
});

test('clips that only touch, or lie on different rows, have no transition', () => {
  assert.equal(T.overlapOf(pair('video', 10), 'B', 'in'), null);
  const rows = T.arrangeLanes([clip('video', { id: 'A', start: 0 }), clip('video', { id: 'B', start: 8, lane: 1 })]);
  assert.equal(T.overlapOf(rows, 'B', 'in'), null);
  assert.equal(T.overlapOf(rows, 'A', 'out'), null);
});

test('sound and see-through pictures fade out under the later clip as well', () => {
  assert.equal(T.overlapOf(pair('audio', 7), 'A', 'out').both, true);
  assert.equal(T.overlapOf(pair('audio', 7), 'A', 'out').overlap, 3);
  const png = pair('video', 8, { a: { kind: 'image', src: 'a.png' }, b: { kind: 'image', src: 'b.png' } });
  assert.equal(T.overlapOf(png, 'B', 'in').both, true);
  assert.equal(T.overlapOf(pair('video', 8), 'B', 'in').both, false);
});

test('a fade in dragged by hand since is no longer the transition\'s', () => {
  const list = pair('video', 8);
  const hand = T.setFade(list, 'B', 'in', 1);
  assert.equal(T.overlapOf(hand, 'B', 'in'), null);
  assert.equal(T.overlapOf(hand, 'A', 'out'), null);
  // Dragged back to the overlap's own length it is one again.
  assert.notEqual(T.overlapOf(T.setFade(hand, 'B', 'in', 2), 'B', 'in'), null);
});

test('a curve chosen on either end of a transition goes onto both clips', () => {
  for (const [id, which] of [['B', 'in'], ['A', 'out']]) {
    const list = pair('audio', 7);
    const next = T.fadeCurveAcross(list, id, which, 'quadInOut');
    assert.equal(T.layerById(next, 'B').fadeInCurve, 'quadInOut');
    assert.equal(T.layerById(next, 'A').fadeOutCurve, 'quadInOut');
    // The ends the transition is not on keep theirs.
    assert.equal(T.layerById(next, 'A').fadeInCurve, 'linear');
    assert.equal(T.layerById(next, 'B').fadeOutCurve, 'linear');
    assert.equal(T.overlapOf(next, 'A', 'out').curve, 'quadInOut');
    // The same again changes nothing, and says so by the list it hands back.
    assert.equal(T.fadeCurveAcross(next, id, which, 'quadInOut'), next);
  }
});

test('the two ramps of a transition mirror each other: together they are always whole', () => {
  const list = T.fadeCurveAcross(pair('audio', 7), 'B', 'in', 'cubicIn');
  const a = T.layerById(list, 'A');
  const b = T.layerById(list, 'B');
  for (const t of [7, 7.4, 8.1, 8.5, 9.3, 9.99]) {
    const sum = T.fadeAlphaAt(a, t) + T.fadeAlphaAt(b, t);
    assert.ok(Math.abs(sum - 1) < 1e-9, 'at ' + t + ' the two gains come to ' + sum);
  }
});

test('where the later clip\'s curve was chosen before 4.9 the other end is brought to it', () => {
  // 3.8.1 set the curve on the pressed end only.
  const old = T.setFadeCurve(pair('audio', 7), 'B', 'in', 'sineInOut');
  assert.equal(T.layerById(old, 'A').fadeOutCurve, 'linear');
  assert.equal(T.overlapOf(old, 'A', 'out').curve, 'sineInOut', 'the transition runs by the later clip\'s');
  const next = T.fadeCurveAcross(old, 'B', 'in', 'sineInOut');
  assert.notEqual(next, old, 'the ticked curve again is still a change, to the other clip');
  assert.equal(T.layerById(next, 'A').fadeOutCurve, 'sineInOut');
});

test('a curve chosen for a grouped picture reaches its sound and both of their transitions', () => {
  const at = (start) => T.arrangeLanes([
    clip('video', { id: 'A', start: 0, groupId: 'g1' }),
    clip('audio', { id: 'As', start: 0, groupId: 'g1' }),
    clip('video', { id: 'B', start, groupId: 'g2' }),
    clip('audio', { id: 'Bs', start, groupId: 'g2' }),
  ]);
  const list = T.crossfade(at(20), at(8));
  const next = T.fadeCurveAcross(list, 'B', 'in', 'quartInOut');
  assert.deepEqual(['B', 'Bs'].map((id) => T.layerById(next, id).fadeInCurve), ['quartInOut', 'quartInOut']);
  assert.deepEqual(['A', 'As'].map((id) => T.layerById(next, id).fadeOutCurve), ['quartInOut', 'quartInOut']);
});

test('the choice comes to the same thing from either end, the sounds on rows of their own included', () => {
  // Each picture's sound on its own audio row, so the sounds do not overlap.
  const at = (start) => T.arrangeLanes([
    clip('video', { id: 'A', start: 0, groupId: 'g1' }),
    clip('audio', { id: 'As', start: 0, groupId: 'g1', lane: 0 }),
    clip('video', { id: 'B', start, groupId: 'g2' }),
    clip('audio', { id: 'Bs', start, groupId: 'g2', lane: 1 }),
  ]);
  const list = T.crossfade(at(20), at(8));
  const curvesOf = (l) => l.map((x) => [x.id, x.fadeInCurve, x.fadeOutCurve]);
  const fromIn = T.fadeCurveAcross(list, 'B', 'in', 'cubicOut');
  const fromOut = T.fadeCurveAcross(list, 'A', 'out', 'cubicOut');
  assert.deepEqual(curvesOf(fromIn), curvesOf(fromOut));
  assert.equal(T.layerById(fromOut, 'Bs').fadeInCurve, 'cubicOut');
  assert.equal(T.layerById(fromOut, 'As').fadeOutCurve, 'cubicOut');
});

test('without a transition it is the plain fade curve of the group, as it was', () => {
  const list = [clip('video', { id: 'A', groupId: 'g' }), clip('audio', { id: 'As', groupId: 'g' })];
  const next = T.fadeCurveAcross(list, 'A', 'out', 'quadOut');
  assert.deepEqual(next, T.fadeCurveGroup(list, 'A', 'out', 'quadOut'));
  assert.equal(T.layerById(next, 'As').fadeOutCurve, 'quadOut');
  assert.equal(T.fadeCurveAcross(next, 'A', 'out', 'quadOut'), next);
});

// ---- the pop-up ----

test('the curve pop-up asks for the transition and draws each choice doubled inside one', () => {
  const menu = CLIPS.slice(CLIPS.indexOf('function openFadeMenu('), CLIPS.indexOf('function bindFadeMenu('));
  assert.match(menu, /timelineModel\.overlapOf\(layers, layerId, which\)/);
  assert.match(menu, /cross \? cross\.curve : timelineModel\.fadeCurvesOf\(layer\)\[which\]/);
  assert.match(menu, /drawFadeCurveIcon\(icon, id, which === 'out', id === current, !!cross\)/);
  assert.match(menu, /timelineModel\.fadeCurveAcross\(layers, layerId, which, id\)/);
  // Doubled is the curve and the same curve the other way up, on one path.
  const icon = CLIPS.slice(CLIPS.indexOf('function drawFadeCurveIcon('), CLIPS.indexOf('function openFadeMenu('));
  assert.match(icon, /traceFadeRamp\(ctx, curve, doubled \? false : out,/);
  assert.match(icon, /if \(doubled\) traceFadeRamp\(ctx, curve, true,/);
});
