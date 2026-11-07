'use strict';

// V3.8.5. A .lwc handed to the app from outside.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const L = require('../src/launchArgs');

const EXE = 'C:\\Program Files\\LWClipper\\LWClipper.exe';

test('Explorer: the file after the exe', () => {
  const file = 'C:\\Users\\Ceeser\\Desktop\\KI Programme\\Mein Projekt.lwc';
  assert.deepEqual(L.projectArgs([EXE, file], 'C:\\'), [file]);
});

test('nothing named is nothing to open', () => {
  assert.deepEqual(L.projectArgs([EXE], 'C:\\'), []);
  assert.deepEqual(L.projectArgs([], 'C:\\'), []);
  assert.deepEqual(L.projectArgs(undefined, 'C:\\'), []);
});

test('electron . in development is not a project', () => {
  assert.deepEqual(L.projectArgs(['electron.exe', '.'], 'C:\\dev'), []);
});

test('switches are skipped, Chromium ones included', () => {
  const file = 'D:\\clips\\a.lwc';
  const argv = [EXE, '--allow-file-access-from-files', '--original-process-start-time=1', file, '--x=y.lwc'];
  assert.deepEqual(L.projectArgs(argv, 'C:\\'), [file]);
});

test('the extension is matched without case, other files are not projects', () => {
  assert.deepEqual(L.projectArgs([EXE, 'D:\\a.LWC', 'D:\\b.mp4', 'D:\\c.lwcref'], 'C:\\'), ['D:\\a.LWC']);
});

test('a relative name is relative to where it was started', () => {
  assert.deepEqual(L.projectArgs([EXE, 'sub\\p.lwc'], 'D:\\work'), [path.resolve('D:\\work', 'sub\\p.lwc')]);
});

test('quotes left on an argument are taken off', () => {
  assert.deepEqual(L.projectArgs([EXE, '"D:\\with space\\p.lwc"'], 'C:\\'), ['D:\\with space\\p.lwc']);
});

test('several files in order, the same one once', () => {
  const argv = [EXE, 'D:\\a.lwc', 'D:\\b.lwc', 'd:\\A.lwc'];
  assert.deepEqual(L.projectArgs(argv, 'C:\\'), ['D:\\a.lwc', 'D:\\b.lwc']);
});

test('the waiting list keeps order and asks about a file once', () => {
  let q = L.enqueue([], ['D:\\a.lwc']);
  q = L.enqueue(q, ['D:\\b.lwc', 'd:\\A.LWC']);
  assert.deepEqual(q, ['D:\\a.lwc', 'D:\\b.lwc']);
  assert.deepEqual(L.enqueue(undefined, [null, '', 'D:\\c.lwc']), ['D:\\c.lwc']);
});

test('the queue handed in is not changed', () => {
  const q = ['D:\\a.lwc'];
  L.enqueue(q, ['D:\\b.lwc']);
  assert.deepEqual(q, ['D:\\a.lwc']);
});
