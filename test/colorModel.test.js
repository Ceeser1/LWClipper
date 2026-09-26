'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/colorModel');

test('hsvToRgb hits the primaries and the greys', () => {
  assert.deepEqual(C.hsvToRgb(0, 1, 1), { r: 255, g: 0, b: 0 });
  assert.deepEqual(C.hsvToRgb(120, 1, 1), { r: 0, g: 255, b: 0 });
  assert.deepEqual(C.hsvToRgb(240, 1, 1), { r: 0, g: 0, b: 255 });
  assert.deepEqual(C.hsvToRgb(360, 1, 1), { r: 255, g: 0, b: 0 });
  assert.deepEqual(C.hsvToRgb(77, 0, 0.5), { r: 128, g: 128, b: 128 });
  assert.deepEqual(C.hsvToRgb(200, 0.7, 0), { r: 0, g: 0, b: 0 });
});

test('every 8 bit colour survives the round trip through hsv', () => {
  for (let r = 0; r < 256; r += 15) {
    for (let g = 0; g < 256; g += 17) {
      for (let b = 0; b < 256; b += 13) {
        const s = C.rgbToHsv(r, g, b);
        assert.deepEqual(C.hsvToRgb(s.h, s.s, s.v), { r, g, b });
      }
    }
  }
});

test('stateOf and colorOf read and write #rrggbbaa', () => {
  const s = C.stateOf('#ff000080');
  assert.equal(s.h, 0);
  assert.equal(s.s, 1);
  assert.equal(s.v, 1);
  assert.equal(s.a, 128);
  assert.equal(C.colorOf(s), '#ff000080');
  assert.equal(C.colorOf(C.stateOf('#12AB9C')), '#12ab9cff');
  assert.equal(C.colorOf(C.stateOf('rubbish')), '#ffffffff');
  assert.equal(C.hexOf(C.stateOf('#12ab9c40')), '#12ab9c');
});

test('brightness down to black and back keeps the hue and saturation', () => {
  const start = C.stateOf('#3366ccff');
  const black = { ...start, v: 0 };
  assert.equal(C.hexOf(black), '#000000');
  const back = { ...black, v: start.v };
  assert.equal(C.colorOf(back), '#3366ccff');
});

test('typing a grey or black into R, G, B keeps what it cannot say', () => {
  const start = C.stateOf('#3366ccff');
  const grey = C.withRgb(start, 90, 90, 90);
  assert.equal(grey.h, start.h);
  assert.equal(grey.s, 0);
  assert.equal(C.hexOf(grey), '#5a5a5a');
  const black = C.withRgb(start, 0, 0, 0);
  assert.equal(black.h, start.h);
  assert.equal(black.s, start.s);
  assert.equal(black.v, 0);
  assert.equal(black.a, 255);
});

test('readHex takes six digits with or without #, and waits on fewer', () => {
  const s = C.stateOf('#000000ff');
  assert.equal(C.colorOf(C.readHex('#00ff00', s).state), '#00ff00ff');
  assert.equal(C.colorOf(C.readHex('0000FF', s).state), '#0000ffff');
  assert.equal(C.readHex('#00ff0', s).state, null);
  assert.equal(C.readHex('#00ff0', s).text, null);
  assert.equal(C.readHex('#00gg00', s).state, null);
});

test('readHex: seven digits are left alone, the first six are the colour', () => {
  const s = C.stateOf('#000000ff');
  const r = C.readHex('#00ff008', s);
  assert.equal(r.text, null);
  assert.equal(C.colorOf(r.state), '#00ff00ff');
});

test('readHex: eight digits put the last two into A and cut the box to six', () => {
  const s = C.stateOf('#000000ff');
  const r = C.readHex('#11223380', s);
  assert.equal(r.text, '#112233');
  assert.equal(C.colorOf(r.state), '#11223380');
  const bare = C.readHex('1122330a', s);
  assert.equal(bare.text, '112233');
  assert.equal(bare.state.a, 10);
});

test('readHex: eight digits whose last two are not hex keep A, still cut to six', () => {
  const s = C.stateOf('#00000040');
  const r = C.readHex('#112233zz', s);
  assert.equal(r.text, '#112233');
  assert.equal(C.colorOf(r.state), '#11223340');
});

test('readHex: more than eight is cut, the 7th and 8th still being A', () => {
  const s = C.stateOf('#000000ff');
  const r = C.readHex('#112233445566', s);
  assert.equal(r.text, '#112233');
  assert.equal(r.state.a, 0x44);
});

test('readHex keeps the hue when a grey is typed', () => {
  const s = C.stateOf('#3366ccff');
  const r = C.readHex('#808080', s);
  assert.equal(r.state.h, s.h);
});

test('readByte takes whole numbers and holds them to 0..255', () => {
  assert.equal(C.readByte('12'), 12);
  assert.equal(C.readByte(' 300 '), 255);
  assert.equal(C.readByte('-4'), 0);
  assert.equal(C.readByte(''), null);
  assert.equal(C.readByte('-'), null);
  assert.equal(C.readByte('1.5'), null);
  assert.equal(C.readByte('ab'), null);
});

test('wheelPick puts red right, a quarter turn up, and the edge at full saturation', () => {
  const red = C.wheelPick(50, 0, 100);
  assert.equal(red.h, 0);
  assert.equal(red.s, 0.5);
  const up = C.wheelPick(0, -100, 100);
  assert.equal(up.h, 90);
  assert.equal(up.s, 1);
  const out = C.wheelPick(-300, 0, 100);
  assert.equal(out.h, 180);
  assert.equal(out.s, 1);
  assert.equal(C.wheelPick(0, 0, 100).s, 0);
});

test('wheelPoint is the inverse of wheelPick', () => {
  for (const [h, s] of [[0, 1], [45, 0.5], [200, 0.25], [300, 0.9]]) {
    const p = C.wheelPoint(h, s, 80);
    const back = C.wheelPick(p.dx, p.dy, 80);
    assert.ok(Math.abs(back.h - h) < 1e-9);
    assert.ok(Math.abs(back.s - s) < 1e-9);
  }
});
