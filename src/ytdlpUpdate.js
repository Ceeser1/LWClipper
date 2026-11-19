'use strict';

// V5.4. A newer yt-dlp without a newer LWClipper.
//
// yt-dlp is the part that reads the video sites, and the sites change under
// it: a yt-dlp a few weeks old stops reading YouTube, and until now the only
// cure was a new build of the whole app. The yt-dlp that ships with the app
// cannot be replaced where it lies either, an installed app being in Program
// Files, where it may not write.
//
// So an updated yt-dlp is a second copy in the app's own folder under
// LOCALAPPDATA (`tools\yt-dlp.exe`, removed with Delete App files), and it
// is yt-dlp that fetches it: the copy is run with `-U`, its own updater,
// which asks github.com for the newest release, checks what it downloaded
// against the release's published SHA-256 and puts it in its own place. The
// app downloads nothing itself and only ever on the user's click.
//
// Beside the copy is a mark (`yt-dlp.json`) of which version it is and
// whether it is the one to use. A later LWClipper may ship a yt-dlp newer
// than a copy fetched long ago, so the two are compared once for each app
// version (`choose`), and the newer wins.

const fs = require('fs');
const path = require('path');

const EXE = 'yt-dlp.exe';
const MARK = 'yt-dlp.json';

/**
 * Two yt-dlp versions compared: negative, zero or positive, like a sort.
 * They are dates with dots (2026.10.26), a nightly with a time after it
 * (2026.10.26.232800), so they are compared number by number.
 */
function compareVersions(a, b) {
  const parts = (v) => String(v || '').trim().split(/[^0-9]+/).filter(Boolean).map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

function readMark(dir) {
  try {
    const mark = JSON.parse(fs.readFileSync(path.join(dir, MARK), 'utf8'));
    return mark && typeof mark === 'object' && typeof mark.version === 'string' && mark.version ? mark : null;
  } catch {
    return null;
  }
}

function writeMark(dir, mark) {
  try {
    fs.writeFileSync(path.join(dir, MARK), JSON.stringify(mark));
    return true;
  } catch {
    return false;
  }
}

/** The copy and its mark taken away again, leaving the app on the yt-dlp it came with. */
function removeOwn(dir) {
  for (const name of [EXE, MARK, EXE + '.old', EXE + '.new']) {
    try {
      fs.unlinkSync(path.join(dir, name));
    } catch {
      // Not there, or still held for a moment by the run that just ended.
    }
  }
}

/**
 * The yt-dlp to run: the app's own copy when there is one, it is whole (it
 * has its mark) and it is newer than the one the app came with, or else that
 * one. `versionOf(exe)` answers a yt-dlp's version, or null; it is asked at
 * most once for each app version, and only when there is a copy at all.
 */
function choose({ bundled, dir, appVersion, versionOf }) {
  if (!dir) return bundled;
  const own = path.join(dir, EXE);
  if (!fs.existsSync(own)) return bundled;
  const mark = readMark(dir);
  // No mark: an update that never finished. The copy may be half a file.
  if (!mark) return bundled;
  if (!bundled) return own;
  if (mark.app === appVersion && typeof mark.use === 'boolean') return mark.use ? own : bundled;
  const shipped = versionOf ? versionOf(bundled) : null;
  const use = !shipped || compareVersions(mark.version, shipped) > 0;
  writeMark(dir, { ...mark, app: appVersion, use });
  return use ? own : bundled;
}

/**
 * Asks for the newest yt-dlp and keeps it as the app's own copy.
 *
 * `run(exe, args)` runs a tool to its end and answers `{ exitCode, stdoutTail,
 * stderrTail }` (processRunner's shape); `versionOf(exe)` answers a version or
 * null and may be asynchronous. Answers `{ ok, updated, version, from }`, or
 * `{ ok: false, error }` with what yt-dlp said. Never throws for a failed
 * update; a cancel is the runner's own error and goes through.
 */
async function update({ bundled, dir, appVersion, run, versionOf }) {
  if (!dir) return { ok: false, error: 'There is no folder to keep an updated yt-dlp in.' };
  const own = path.join(dir, EXE);
  const hadOwn = fs.existsSync(own) && !!readMark(dir);
  const start = hadOwn ? own : bundled;
  if (!start) return { ok: false, error: 'yt-dlp.exe was not found alongside the app.' };

  const shipped = bundled ? await versionOf(bundled) : null;
  const from = hadOwn ? await versionOf(own) : shipped;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Without its mark the copy counts as unfinished for as long as this runs.
    try {
      fs.unlinkSync(path.join(dir, MARK));
    } catch {
      // There was none.
    }
    if (!hadOwn) fs.copyFileSync(bundled, own);
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }

  let result;
  try {
    result = await run(own, ['-U']);
  } catch (e) {
    // Cancelled, or it could not be started. Back to how it was.
    if (hadOwn && from) writeMark(dir, { version: from, app: appVersion, use: !shipped || compareVersions(from, shipped) > 0 });
    else removeOwn(dir);
    throw e;
  }
  const version = await versionOf(own);
  if (result.exitCode !== 0 || !version) {
    const said = [...(result.stderrTail || []), ...(result.stdoutTail || [])]
      .filter((line) => /error|unable|fail|denied|not/i.test(line));
    if (hadOwn && from && version) writeMark(dir, { version, app: appVersion, use: !shipped || compareVersions(version, shipped) > 0 });
    else removeOwn(dir);
    return {
      ok: false,
      error: (said.length ? said : (result.stderrTail || [])).slice(-4).join('\n') || 'exit code ' + result.exitCode,
    };
  }
  // No newer than the one the app came with: a copy would only be 18 MB of
  // the same thing.
  if (shipped && compareVersions(version, shipped) <= 0) {
    removeOwn(dir);
    return { ok: true, updated: false, version: shipped, from };
  }
  writeMark(dir, { version, app: appVersion, use: true });
  return { ok: true, updated: !from || compareVersions(version, from) > 0, version, from };
}

module.exports = { choose, update, compareVersions, readMark, removeOwn, EXE, MARK };
