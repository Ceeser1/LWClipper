'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src/keyCombo');

const press = (key, mods = {}) => K.fromEvent({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test('a letter is its capital, with or without Shift held', () => {
  assert.equal(press('s'), 'S');
  assert.equal(press('S', { shiftKey: true }), 'Shift+S');
  assert.equal(press('z', { ctrlKey: true }), 'Ctrl+Z');
});

test('modifiers come out in one order whatever was pressed first', () => {
  assert.equal(press('S', { shiftKey: true, ctrlKey: true }), 'Ctrl+Shift+S');
  assert.equal(press('i', { altKey: true, shiftKey: true, ctrlKey: true }), 'Ctrl+Shift+Alt+I');
});

test('Meta counts as Ctrl', () => {
  assert.equal(press('o', { metaKey: true }), 'Ctrl+O');
});

test('the named keys get their short names', () => {
  assert.equal(press(' '), 'Space');
  assert.equal(press('ArrowLeft', { shiftKey: true }), 'Shift+Left');
  assert.equal(press('ArrowRight'), 'Right');
  assert.equal(press('ArrowUp'), 'Up');
  assert.equal(press('ArrowDown'), 'Down');
  assert.equal(press('Delete'), 'Del');
  assert.equal(press('Home'), 'Home');
  assert.equal(press('End'), 'End');
  assert.equal(press('Backspace'), 'Backspace');
  assert.equal(press('F4', { altKey: true }), 'Alt+F4');
});

test('plus and minus are the same press with or without the Shift that types them', () => {
  assert.equal(press('+'), 'Plus');
  assert.equal(press('+', { shiftKey: true }), 'Plus');
  assert.equal(press('='), 'Plus');
  assert.equal(press('-'), 'Minus');
  assert.equal(press('-', { ctrlKey: true }), 'Ctrl+Minus');
});

test('a modifier on its own is not a press yet', () => {
  assert.equal(press('Control', { ctrlKey: true }), null);
  assert.equal(press('Shift', { shiftKey: true }), null);
  assert.equal(press('Alt', { altKey: true }), null);
  assert.equal(press(''), null);
  assert.equal(K.fromEvent(null), null);
});

test('normalize puts a hand-written combo in the form an event gives', () => {
  assert.equal(K.normalize('shift + ctrl + s'), 'Ctrl+Shift+S');
  assert.equal(K.normalize('Crtl+S'), null);
  assert.equal(K.normalize('ctrl+t'), 'Ctrl+T');
  assert.equal(K.normalize('shift+left'), 'Shift+Left');
  assert.equal(K.normalize('Space'), 'Space');
  assert.equal(K.normalize('del'), 'Del');
  assert.equal(K.normalize('alt+f4'), 'Alt+F4');
  assert.equal(K.normalize('+'), 'Plus');
  assert.equal(K.normalize('Ctrl++'), 'Ctrl+Plus');
  assert.equal(K.normalize('Shift+Plus'), 'Plus');
  assert.equal(K.normalize('Ctrl+Shift'), null);
  assert.equal(K.normalize('A+B'), null);
  assert.equal(K.normalize(42), null);
});

test('what fromEvent writes, normalize leaves alone', () => {
  for (const combo of ['Ctrl+Shift+S', 'Shift+Left', 'Space', 'Plus', 'Ctrl+Minus', 'Del', 'Ctrl+Shift+Alt+I', 'Home']) {
    assert.equal(K.normalize(combo), combo);
  }
});

test('display draws the arrows and the symbols, and translates the words', () => {
  assert.equal(K.display('Shift+Left'), 'Shift+←');
  assert.equal(K.display('Right'), '→');
  assert.equal(K.display('Up'), '↑');
  assert.equal(K.display('Plus'), '+');
  assert.equal(K.display('Minus'), '-');
  const de = { Ctrl: 'Strg', Shift: 'Umschalt', Del: 'Entf' };
  assert.equal(K.display('Ctrl+Shift+S', (w) => de[w] || w), 'Strg+Umschalt+S');
  assert.equal(K.display('Del', (w) => de[w] || w), 'Entf');
  assert.equal(K.display(''), '');
  assert.equal(K.display(null), '');
});
