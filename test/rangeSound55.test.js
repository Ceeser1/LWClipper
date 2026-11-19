'use strict';

// V5.5. A sound that starts after the end of the exported range is left out.
// Delayed past the end it kept amix waiting and the audio encoder got nothing:
// ffmpeg wrote no file at all (found exporting the first seconds of a project
// with a frozen frame in it).

const test = require('node:test');
const assert = require('node:assert/strict');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const { buildComposeArgs } = require('../src/composer');
const timeline = require('../src/timeline');

const HD = { width: 1920, height: 1080, fps: 30 };
const SOURCES = { 'a.mp4': { width: 1920, height: 1080 }, 'music.mp3': { width: 0, height: 0 } };
const vid = (props) => timeline.createLayer({ type: 'video', src: 'a.mp4', sourceDuration: 60, ...props });
const aud = (props) => timeline.createLayer({ type: 'audio', src: 'music.mp3', sourceDuration: 60, ...props });
const inputs = (args) => args.filter((a, i) => args[i - 1] === '-i');
const graph = (args) => args[args.indexOf('-filter_complex') + 1];

test('a sound starting at or after the range end is not an input and not in the mix', () => {
  const layers = [
    vid({ id: 'v', start: 0, duration: 8 }),
    aud({ id: 'early', start: 0, duration: 3 }),
    aud({ id: 'edge', start: 4, duration: 2 }),
    aud({ id: 'late', start: 5, duration: 2 }),
  ];
  const args = buildComposeArgs({ layers, project: HD, trim: { start: 0, end: 4 }, output: 'out.mp4', sources: SOURCES });
  assert.equal(inputs(args).filter((i) => i === 'music.mp3').length, 1, 'only the sound heard in the range');
  assert.ok(!/adelay=4000|adelay=5000/.test(graph(args)), graph(args));
  assert.ok(args.includes('-c:a'), 'the file still has its sound');
});

test('a sound that starts inside the range stays, however late in it', () => {
  const layers = [vid({ id: 'v', start: 0, duration: 8 }), aud({ id: 'in', start: 3.9, duration: 2 })];
  const args = buildComposeArgs({ layers, project: HD, trim: { start: 0, end: 4 }, output: 'out.mp4', sources: SOURCES });
  assert.match(graph(args), /adelay=3900/);
});

test('with every sound after the range, the file has no sound track', () => {
  const layers = [vid({ id: 'v', start: 0, duration: 8 }), aud({ id: 'late', start: 6, duration: 2 })];
  const args = buildComposeArgs({ layers, project: HD, trim: { start: 0, end: 4 }, output: 'out.mp4', sources: SOURCES });
  assert.ok(args.includes('-an'));
  assert.ok(!inputs(args).includes('music.mp3'));
});

test('the whole project exported keeps every sound', () => {
  const layers = [vid({ id: 'v', start: 0, duration: 8 }), aud({ id: 'a', start: 0, duration: 3 }), aud({ id: 'b', start: 5, duration: 3 })];
  const args = buildComposeArgs({ layers, project: HD, output: 'out.mp4', sources: SOURCES });
  assert.equal(inputs(args).filter((i) => i === 'music.mp3').length, 2);
});
