'use strict';

// V5.4. A newer yt-dlp kept as the app's own copy: which of the two is run,
// and what an update leaves behind however it ends. yt-dlp itself is stood in
// for; nothing here goes to the internet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const up = require('../src/ytdlpUpdate');

function folders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwc-ytdlp-'));
  const bundled = path.join(root, 'shipped', 'yt-dlp.exe');
  fs.mkdirSync(path.dirname(bundled), { recursive: true });
  fs.writeFileSync(bundled, 'shipped 2026.10.26');
  return { root, bundled, dir: path.join(root, 'own') };
}
/** A stand-in yt-dlp: its "version" is the last word of the file. */
const versionOf = (exe) => {
  try {
    return fs.readFileSync(exe, 'utf8').split(' ').pop();
  } catch {
    return null;
  }
};
const ownExe = (f) => path.join(f.dir, up.EXE);
const mark = (f) => up.readMark(f.dir);

test('versions are compared as numbers, a nightly after its day', () => {
  assert.ok(up.compareVersions('2026.11.02', '2026.10.26') > 0);
  assert.ok(up.compareVersions('2026.10.26', '2026.10.26') === 0);
  assert.ok(up.compareVersions('2026.9.30', '2026.10.01') < 0, 'not as text, where 9 would be after 10');
  assert.ok(up.compareVersions('2026.10.26.232800', '2026.10.26') > 0);
  assert.ok(up.compareVersions('', '2026.10.26') < 0);
});

test('with no copy of its own the app runs the yt-dlp it came with', () => {
  const f = folders();
  assert.equal(up.choose({ bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf }), f.bundled);
  assert.equal(up.choose({ bundled: f.bundled, dir: null, appVersion: '5.4.0', versionOf }), f.bundled);
});

test('a copy without its mark is an update that never finished, and is not run', () => {
  const f = folders();
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(ownExe(f), 'half a file');
  assert.equal(up.choose({ bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf }), f.bundled);
});

test('a newer copy is run, and the shipped one is asked its version only once', () => {
  const f = folders();
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(ownExe(f), 'own 2026.11.02');
  fs.writeFileSync(path.join(f.dir, up.MARK), JSON.stringify({ version: '2026.11.02' }));
  let asked = 0;
  const counting = (exe) => {
    asked += 1;
    return versionOf(exe);
  };
  const args = { bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf: counting };
  assert.equal(up.choose(args), ownExe(f));
  assert.equal(up.choose(args), ownExe(f));
  assert.equal(asked, 1);
  assert.deepEqual(mark(f), { version: '2026.11.02', app: '5.4.0', use: true });
});

test('a later LWClipper that ships a newer yt-dlp wins over an old copy', () => {
  const f = folders();
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(ownExe(f), 'own 2026.11.02');
  fs.writeFileSync(path.join(f.dir, up.MARK), JSON.stringify({ version: '2026.11.02', app: '5.4.0', use: true }));
  fs.writeFileSync(f.bundled, 'shipped 2026.12.24');
  assert.equal(up.choose({ bundled: f.bundled, dir: f.dir, appVersion: '5.5.0', versionOf }), f.bundled);
  assert.equal(mark(f).use, false);
  // And it stays decided for that version without asking again.
  assert.equal(up.choose({ bundled: f.bundled, dir: f.dir, appVersion: '5.5.0', versionOf: () => assert.fail('asked again') }), f.bundled);
});

test('with no yt-dlp shipped at all, a whole copy is what there is', () => {
  const f = folders();
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(ownExe(f), 'own 2026.11.02');
  fs.writeFileSync(path.join(f.dir, up.MARK), JSON.stringify({ version: '2026.11.02' }));
  assert.equal(up.choose({ bundled: null, dir: f.dir, appVersion: '5.4.0', versionOf }), ownExe(f));
});

test('an update copies the shipped yt-dlp, runs the copy with -U and marks what it became', async () => {
  const f = folders();
  const ran = [];
  const result = await up.update({
    bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf,
    run: async (exe, args) => {
      ran.push([exe, args]);
      assert.equal(fs.readFileSync(exe, 'utf8'), 'shipped 2026.10.26', 'the copy starts as the shipped one');
      assert.equal(mark(f), null, 'and counts as unfinished while it runs');
      fs.writeFileSync(exe, 'own 2026.11.02');
      return { exitCode: 0, stdoutTail: ['Updated yt-dlp to stable@2026.11.02'], stderrTail: [] };
    },
  });
  assert.deepEqual(ran, [[ownExe(f), ['-U']]]);
  assert.deepEqual(result, { ok: true, updated: true, version: '2026.11.02', from: '2026.10.26' });
  assert.deepEqual(mark(f), { version: '2026.11.02', app: '5.4.0', use: true });
  assert.equal(fs.readFileSync(f.bundled, 'utf8'), 'shipped 2026.10.26', 'the shipped one is never written to');
  assert.equal(up.choose({ bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf }), ownExe(f));
});

test('already the newest: the copy is taken away again and the app stays on the shipped one', async () => {
  const f = folders();
  const result = await up.update({
    bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf,
    run: async () => ({ exitCode: 0, stdoutTail: ['yt-dlp is up to date (stable@2026.10.26)'], stderrTail: [] }),
  });
  assert.deepEqual(result, { ok: true, updated: false, version: '2026.10.26', from: '2026.10.26' });
  assert.equal(fs.existsSync(ownExe(f)), false);
  assert.equal(mark(f), null);
});

test('a second update starts from the copy, not from the shipped one', async () => {
  const f = folders();
  const step = (to) => up.update({
    bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf,
    run: async (exe) => {
      fs.writeFileSync(exe, 'own ' + to);
      return { exitCode: 0, stdoutTail: [], stderrTail: [] };
    },
  });
  await step('2026.11.02');
  const second = await step('2026.11.20');
  assert.deepEqual(second, { ok: true, updated: true, version: '2026.11.20', from: '2026.11.02' });
  assert.equal(mark(f).version, '2026.11.20');
});

test('a failed first update leaves nothing behind and says what yt-dlp said', async () => {
  const f = folders();
  const result = await up.update({
    bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf,
    run: async () => ({
      exitCode: 1, stdoutTail: ['Current version: stable@2026.10.26'],
      stderrTail: ['ERROR: Unable to obtain version info (getaddrinfo failed); Please try again later'],
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unable to obtain version info/);
  assert.equal(fs.existsSync(ownExe(f)), false);
  assert.equal(up.choose({ bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf }), f.bundled);
});

test('a failed later update keeps the copy that worked', async () => {
  const f = folders();
  await up.update({
    bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf,
    run: async (exe) => {
      fs.writeFileSync(exe, 'own 2026.11.02');
      return { exitCode: 0, stdoutTail: [], stderrTail: [] };
    },
  });
  const result = await up.update({
    bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf,
    run: async () => ({ exitCode: 1, stdoutTail: [], stderrTail: ['ERROR: no connection'] }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(mark(f), { version: '2026.11.02', app: '5.4.0', use: true });
  assert.equal(up.choose({ bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf }), ownExe(f));
});

test('a cancelled update goes back to how it was and hands the cancel on', async () => {
  const f = folders();
  class Cancelled extends Error {}
  await assert.rejects(up.update({
    bundled: f.bundled, dir: f.dir, appVersion: '5.4.0', versionOf,
    run: async () => {
      throw new Cancelled();
    },
  }), Cancelled);
  assert.equal(fs.existsSync(ownExe(f)), false);
  assert.equal(mark(f), null);
});

test('with no yt-dlp anywhere an update says so', async () => {
  const f = folders();
  const result = await up.update({
    bundled: null, dir: f.dir, appVersion: '5.4.0', versionOf, run: async () => assert.fail('ran'),
  });
  assert.equal(result.ok, false);
});
