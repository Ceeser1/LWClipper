'use strict';

// V3.6.1. Auto-save and crash restore, the window's half.
//
// The user, 2026-11-05: "Auto-save should happen every 3 minutes, max 5 last
// auto-saves get stored", and "After a crash a window should open asking to
// restore the last project." src/autosave.js holds the rules and main.js the
// disk; what is here is when to write, and the question after a crash.
//
// Advanced editing only, since that is the mode with a project in it. An
// auto-save is the same document Save writes, the editors' views and the
// undo stack included, so a restore is an open like any other.

// What this run last auto-saved, and as which file, so an unchanged project
// is not written again every three minutes: five copies of one state would
// push out the four before it.
let autosavedDoc = null;
let autosavedFrom = null;
let autosaving = false;
// Said once when writing fails, not every three minutes after.
let autosaveFailed = false;

/** Write an auto-save when there is a project and it changed. True if written. */
async function autosaveNow() {
  if (autosaving || !timelineDriving() || !layers.length) return false;
  const doc = projectDocument();
  if (autosavedDoc && autosavedFrom === projectPath
    && projectFile.sameDocument(doc, autosavedDoc)) return false;
  autosaving = true;
  try {
    const from = projectPath;
    const result = await window.lwclipper.autosave(
      { ...doc, views: viewsForFile(), history: projectHistory.pack(undoStack) },
      from ? { path: from, name: projectTitle } : null);
    if (!result || !result.ok) {
      if (!autosaveFailed) setStatus('The auto-save could not be written: {error}', { error: (result && result.error) || '' });
      autosaveFailed = true;
      return false;
    }
    autosaveFailed = false;
    autosavedDoc = projectFile.documentOf(doc);
    autosavedFrom = from;
    return true;
  } finally {
    autosaving = false;
  }
}

setInterval(autosaveNow, autosave.EVERY_MS);

function autosaveWhen(savedAt) {
  const d = new Date(savedAt);
  if (!Number.isFinite(d.getTime())) return '';
  try {
    // To the second, so two copies written in one minute can be told apart.
    return d.toLocaleString(appSettings.language || undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  } catch {
    return d.toLocaleString();
  }
}

/**
 * After a crash: the auto-saves the crashed run wrote, newest first and
 * picked, and whether to open one. Asked once, whichever button answers it,
 * since the auto-saves stay where they are and open like any project.
 *
 * A restored project is written again straight away as this run's own, so
 * a second crash before the next three minutes are up still has it to offer.
 */
async function offerRestore() {
  const found = await window.lwclipper.crashedAutosaves();
  if (!Array.isArray(found) || !found.length) return;
  let pick = [found[0].file];
  const choice = await showChoice({
    title: t('Restore project'),
    message: t('LWClipper was not closed properly last time. Restore the last project from its auto-save?'),
    checks: found.map((a, i) => ({
      id: a.file,
      label: (a.origin && a.origin.name) || t('Unsaved project'),
      title: a.origin ? a.origin.path : '',
      note: autosaveWhen(a.savedAt),
      checked: i === 0,
    })),
    single: true,
    onCheck: (ids) => { pick = ids; },
    footer: t('Not restoring keeps the auto-saves. They are in the autosave folder of the App files and open like any project.'),
    buttons: [
      { id: 'restore', label: t('Restore'), primary: true },
      { id: 'skip', label: t("Don't Restore") },
    ],
    // Escape or a stray click beside the panel is not an answer: the
    // question comes back next start. Only the two buttons settle it.
    cancel: 'later',
  });
  if (choice === 'later') return;
  await window.lwclipper.forgetCrashes();
  if (choice !== 'restore' || !pick.length) return;
  if (await openProjectPath(pick[0])) autosaveNow();
}
