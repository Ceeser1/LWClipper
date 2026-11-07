'use strict';

// V3.8.5. A .lwc opened from outside the app: double-clicked in Explorer at
// startup, or while the app is already open. main.js keeps the files waiting
// and this takes them one at a time through openProjectPath, which is what a
// project dropped on the window goes through, so the Different LWC Project
// question comes up when a project is open, exactly as it does there.

// Not before startup has finished: the restore question after a crash comes
// first, so a project opened from outside never races a restore.
let outsideReady = false;
let outsideRunning = false;
let outsideAgain = false;

/**
 * Whether a question can be put up now. Not over another one, since
 * showChoice answers the open question with its cancel to make room, and not
 * during a job, where openProjectPath declines without a word. Either way the
 * file waits rather than being lost.
 */
function outsideCanAsk() {
  return !busy && !choiceSettle;
}

function whenOutsideCanAsk() {
  return new Promise((resolve) => {
    const look = () => (outsideCanAsk() ? resolve() : setTimeout(look, 250));
    look();
  });
}

/**
 * Open every file waiting, oldest first, each asked about in turn. A file that
 * arrives while this runs is picked up by the same run; outsideAgain covers
 * the one that lands between the last empty answer and the run ending.
 */
async function openFromOutside() {
  if (!outsideReady) return;
  if (outsideRunning) {
    outsideAgain = true;
    return;
  }
  outsideRunning = true;
  try {
    do {
      outsideAgain = false;
      for (;;) {
        await whenOutsideCanAsk();
        const filePath = await window.lwclipper.takeOutsideProject();
        if (!filePath) break;
        await openProjectPath(filePath);
      }
    } while (outsideAgain);
  } finally {
    outsideRunning = false;
  }
}

/** Called once, when startup is done: whatever the app was started with. */
function startOutsideOpening() {
  outsideReady = true;
  return openFromOutside();
}
