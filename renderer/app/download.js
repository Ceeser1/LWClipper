'use strict';

// V4.0. File, Download file (Ctrl+D): "Opens a window with the URL editbox and
// the paste and load button, the fetching/quality select/download also happen
// in this modal".
//
// The window borrows what it shows rather than having copies of its own: the
// URL box, Paste and Load from the row at the top of simple editing, and the
// frame that reports a job (the title, the progress bar, Cancel, the status
// line and the quality list) from under it. updateMainFrame already moves the
// pieces of that frame between two homes for the same reason: one status line,
// one progress bar and one Cancel in the document, so nothing can disagree
// about what the app is doing. This is a third home for the frame, kept for as
// long as the window is open.
//
// Closing it during a download leaves the download running: the frame goes
// back where it came from and goes on showing the bar there, as it always has.

const downloadModal = el('downloadModal');
const downloadRow = el('downloadRow');
const downloadBody = el('downloadBody');
const downloadCloseBtn = el('downloadCloseBtn');
const topSection = el('topSection');

// Set while a link is being read or downloaded, which is the one job the
// window may be opened over: it is where that job is shown.
let downloadJob = false;

function downloadWindowOpen() {
  return !downloadModal.hidden;
}

/**
 * V4.5. The address box's hint for where it stands. Beside Open File at the
 * top of simple editing it is the second way in ("or paste a Video link
 * here..."); alone in Download File it is the only one, so the user's "Paste a
 * Video/Audio URL". Kept as English in englishPlaceholder too, which is what a
 * language switch translates from, or the switch would put the other one back.
 */
function setUrlPlaceholder(inWindow) {
  if (inWindow) {
    englishPlaceholder.set(urlField, 'Paste a Video/Audio URL');
    urlField.setAttribute('placeholder', t('Paste a Video/Audio URL'));
  } else {
    englishPlaceholder.set(urlField, 'or paste a Video link here...');
    urlField.setAttribute('placeholder', t('or paste a Video link here...'));
  }
}

function openDownloadWindow() {
  if (!timelineDriving() || (busy && !downloadJob)) return;
  if (downloadWindowOpen()) return;
  // The three in the order they stand in at the top of the window.
  downloadRow.append(urlField, pasteBtn, loadBtn);
  setUrlPlaceholder(true);
  downloadBody.appendChild(mainDrop);
  downloadModal.hidden = false;
  updateMainFrame();
  fitWindow();
  urlField.focus();
  urlField.select();
}

function closeDownloadWindow() {
  if (!downloadWindowOpen()) return;
  downloadModal.hidden = true;
  // Back before the settings button, which is where they stood.
  settingsBtn.before(urlField, pasteBtn, loadBtn);
  setUrlPlaceholder(false);
  topSection.after(mainDrop);
  updateMainFrame();
  fitWindow();
}

downloadCloseBtn.addEventListener('click', closeDownloadWindow);
bindPopup(downloadModal, closeDownloadWindow);

// ---- V5.4. Settings > Update yt-dlp ----
//
// yt-dlp is what reads the video sites, and it ages: when a site changes, the
// one the app came with stops reading it. This asks before it does anything,
// because it is the one thing in the app that goes to the internet for
// something other than the link the user pasted. The fetching is yt-dlp's own
// (main process, src/ytdlpUpdate.js).

async function updateYtdlp() {
  if (busy) return;
  let about = null;
  try {
    about = await window.lwclipper.aboutInfo();
  } catch {
    about = null;
  }
  const have = (about && about.ytdlp) || t('not found');
  const go = await showChoice({
    title: t('Update yt-dlp'),
    message: [
      t('yt-dlp is the part of LWClipper that reads video sites. When a download stops working, a newer yt-dlp usually fixes it.'),
      t('This asks github.com for the newest version and downloads it into the app folder.'),
      t('Installed: {version}', { version: have }),
    ],
    buttons: [
      { id: 'cancel', label: t('Cancel'), left: true },
      { id: 'update', label: t('Update'), primary: true },
    ],
    cancel: 'cancel',
  });
  if (go !== 'update' || busy) return;

  // The question stays up while it runs, with Cancel as its one answer; the
  // result settles it from here when the update is through first.
  let done = false;
  const running = window.lwclipper.updateYtdlp().then(
    (r) => r, (e) => ({ ok: false, error: String((e && e.message) || e) }),
  ).then((r) => {
    done = true;
    settleChoice('done');
    return r;
  });
  const waited = await showChoice({
    title: t('Update yt-dlp'),
    message: t('Looking for a newer yt-dlp...'),
    buttons: [{ id: 'cancel', label: t('Cancel') }],
    cancel: 'cancel',
  });
  if (waited === 'cancel' && !done) window.lwclipper.cancelJob();
  const result = await running;
  if (result.cancelled) return;

  const message = !result.ok
    ? [t('yt-dlp could not be updated:'), result.error]
    : result.updated
      ? t('yt-dlp is now version {version}.', { version: result.version })
      : t('yt-dlp {version} is already the newest.', { version: result.version });
  await showChoice({
    title: t('Update yt-dlp'),
    message,
    buttons: [{ id: 'ok', label: t('OK'), primary: true }],
    cancel: 'ok',
  });
}
