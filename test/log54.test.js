'use strict';

// V5.4. The app's log: what a line looks like, that it never throws, and that
// the file is kept to a size.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('../src/log');
const { runProcess, setObserver } = require('../src/processRunner');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lwc-log-'));
}
function read(dir, name = log.FILE) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

test('a line carries the moment, the level, the part of the app and the text', () => {
  // The user's own clock, not UTC: it is read beside what they remember doing.
  const line = log.format('error', 'tool', 'ffmpeg failed', new Date(2026, 10, 19, 5, 7, 9, 42));
  assert.equal(line, '2026-11-19 05:07:09.042 ERROR [tool] ffmpeg failed\n');
});

test('what follows the first line of a text is set in under it', () => {
  const line = log.format('info', 'main', 'one\r\ntwo\nthree', new Date(0));
  assert.ok(line.endsWith('one\n    two\n    three\n'));
});

test('nothing is written, and nothing thrown, before the folder is known', () => {
  log.init(null);
  assert.equal(log.write('info', 'main', 'x'), false);
  assert.equal(log.filePath(), null);
});

test('lines are added to the file in the folder, which is made when missing', () => {
  const dir = path.join(tempDir(), 'logs', 'deeper');
  log.init(dir);
  assert.equal(log.info('main', 'first'), true);
  assert.equal(log.error('window', 'second'), true);
  const lines = read(dir).trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], / INFO  \[main\] first$/);
  assert.match(lines[1], / ERROR \[window\] second$/);
  log.init(null);
});

test('a folder that cannot be written to is an answer of false, not a throw', () => {
  const dir = tempDir();
  const blocker = path.join(dir, 'file');
  fs.writeFileSync(blocker, 'x');
  // A folder named as a path through a file can never be made.
  log.init(path.join(blocker, 'logs'));
  assert.equal(log.write('info', 'main', 'x'), false);
  log.init(null);
});

test('past its size the file becomes the old one and a new one is begun', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, log.FILE), 'a'.repeat(log.MAX_BYTES + 10));
  fs.writeFileSync(path.join(dir, log.OLD_FILE), 'the one before');
  log.init(dir);
  log.info('main', 'after');
  assert.equal(read(dir, log.OLD_FILE).length, log.MAX_BYTES + 10, 'the full file took the old one\'s place');
  assert.match(read(dir), /^\S+ \S+ INFO  \[main\] after\n$/);
  log.init(null);
});

test('a long text keeps its head and its end, and says how much is left out', () => {
  const text = 'H'.repeat(50) + 'm'.repeat(1000) + 'T'.repeat(50);
  const out = log.capped(text, 100);
  assert.ok(out.startsWith('H'.repeat(50)));
  assert.ok(out.endsWith('T'.repeat(40)));
  assert.ok(out.includes('(1000 characters left out)'));
  assert.equal(log.capped('short', 100), 'short');
});

test('a command is the tool\'s name and its arguments, quoted where they have spaces', () => {
  const line = log.commandLine('C:\\app\\tools\\ffmpeg.exe', ['-i', 'C:\\My Videos\\a.mp4', '-y', 'out.mp4']);
  assert.equal(line, 'ffmpeg.exe -i "C:\\My Videos\\a.mp4" -y out.mp4');
});

test('a tool that ended well is one info line with how long it took', () => {
  const dir = tempDir();
  log.init(dir);
  log.toolEnded({ exe: 'x/ffmpeg.exe', args: ['-y', 'a.mp4'], exitCode: 0, ms: 1234.4, stderrTail: [] });
  assert.match(read(dir), / INFO  \[tool\] ffmpeg\.exe ok in 1234 ms\n {4}ffmpeg\.exe -y a\.mp4\n$/);
  log.init(null);
});

test('a tool that failed is an error with its exit code and what it last said', () => {
  const dir = tempDir();
  log.init(dir);
  log.toolEnded({
    exe: 'x/yt-dlp.exe', args: ['https://example.com/v'], exitCode: 1, ms: 20,
    stderrTail: ['ERROR: Unsupported URL', 'second line'],
  });
  const text = read(dir);
  assert.match(text, / ERROR \[tool\] yt-dlp\.exe failed with exit code 1 after 20 ms\n/);
  assert.ok(text.includes('    ERROR: Unsupported URL\n    second line\n'));
  log.init(null);
});

test('a cancelled tool is not an error', () => {
  const dir = tempDir();
  log.init(dir);
  log.toolEnded({ exe: 'ffmpeg.exe', args: [], exitCode: 1, ms: 5, cancelled: true, stderrTail: ['x'] });
  assert.match(read(dir), / INFO  \[tool\] ffmpeg\.exe cancelled after 5 ms/);
  log.init(null);
});

test('the runner tells its observer of every run, and a throwing observer changes nothing', async () => {
  const seen = [];
  setObserver((what) => {
    seen.push(what);
    throw new Error('the log is broken');
  });
  try {
    const result = await runProcess(process.execPath, ['-e', 'console.error("said"); process.exit(3)'], null, null);
    assert.equal(result.exitCode, 3);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].exitCode, 3);
    assert.equal(seen[0].cancelled, false);
    assert.deepEqual(seen[0].stderrTail, ['said']);
    assert.ok(seen[0].ms >= 0);
  } finally {
    setObserver(null);
  }
});
