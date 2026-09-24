'use strict';

// Pure text helpers: URL parsing, time formatting/parsing, filename safety.
// No Electron/Node dependency, so this is covered directly by node:test.

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PATH_ID_RE = /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/;
const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);

/**
 * Returns the 11-char video id, or null if this is not a YouTube video link.
 * Everything downstream is rebuilt from the id rather than the pasted string,
 * so tracking junk and hand-edited query strings never reach a filename or argv.
 */
function parseVideoId(text) {
  let raw = (text || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;
  if (ID_RE.test(raw)) return raw;
  if (!raw.includes('//')) raw = 'https://' + raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;

  if (host === 'youtu.be') {
    const first = url.pathname.replace(/^\/+/, '').split('/')[0];
    return ID_RE.test(first) ? first : null;
  }

  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/watch') {
    const v = url.searchParams.get('v') || '';
    return ID_RE.test(v) ? v : null;
  }

  const m = PATH_ID_RE.exec(url.pathname);
  return m ? m[1] : null;
}

function canonicalUrl(videoId) {
  return 'https://www.youtube.com/watch?v=' + videoId;
}

const HMS_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i;

function hmsToSeconds(value) {
  const m = HMS_RE.exec((value || '').trim());
  if (!m) return null;
  if (m[1] === undefined && m[2] === undefined && m[3] === undefined) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  const s = m[3] ? parseInt(m[3], 10) : 0;
  return h * 3600 + mi * 60 + s;
}

/**
 * Seconds from a shared link's start marker (?t=, &start=, #t=), or null.
 * The query string wins over the fragment when a link carries both.
 */
function parseStartOffset(text) {
  let raw = (text || '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;
  if (!raw.includes('//')) raw = 'https://' + raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const params = new Map();
  for (const [k, v] of url.searchParams) {
    if (!params.has(k)) params.set(k, []);
    params.get(k).push(v);
  }
  if (url.hash) {
    const fragParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    for (const [k, v] of fragParams) {
      if (!params.has(k)) params.set(k, []);
      params.get(k).push(v);
    }
  }

  for (const key of ['t', 'start', 'time_continue']) {
    const values = params.get(key);
    if (!values) continue;
    for (const value of values) {
      const seconds = hmsToSeconds(value);
      if (seconds !== null) return seconds;
    }
  }
  return null;
}

function fmtTime(seconds, ms = true) {
  seconds = Math.max(0, seconds);
  const h = Math.floor(seconds / 3600);
  const rest = seconds - h * 3600;
  const m = Math.floor(rest / 60);
  const s = rest - m * 60;
  const pad2 = (n) => String(n).padStart(2, '0');
  if (ms) {
    return `${pad2(h)}:${pad2(m)}:${s.toFixed(3).padStart(6, '0')}`;
  }
  return `${pad2(h)}:${pad2(m)}:${pad2(Math.floor(s))}`;
}

/**
 * Accepts 90, 1:30, 01:30.5 or 00:01:30.500. Deliberately lenient about the
 * parts (2:90 means 3:30) since typing a rough value then nudging is normal.
 */
function parseTime(text) {
  const raw = (text || '').trim().replace(/,/g, '.');
  if (!raw) throw new Error('empty time');
  const parts = raw.split(':');
  if (parts.length > 3) throw new Error('not a time: ' + text);
  let total = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isFinite(v)) throw new Error('not a time: ' + text);
    total = total * 60 + v;
  }
  if (total < 0) throw new Error('negative time');
  return total;
}

const BAD_CHARS_RE = /[<>:"/\\|?*\x00-\x1f]/g;
const WHITESPACE_RE = /\s+/g;
const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL']);
for (let i = 1; i <= 9; i++) {
  RESERVED.add('COM' + i);
  RESERVED.add('LPT' + i);
}

/**
 * Whitespace collapses BEFORE the control-character scrub, or a tab in the
 * title turns into an underscore instead of folding into the space beside it.
 */
function safeFilename(name, limit = 120) {
  let cleaned = (name || '').replace(WHITESPACE_RE, ' ');
  cleaned = cleaned.replace(BAD_CHARS_RE, '_').trim().replace(/^\.+|\.+$/g, '');
  cleaned = cleaned.slice(0, limit).trim().replace(/^\.+|\.+$/g, '');
  if (!cleaned) return 'video';
  const stem = cleaned.split('.')[0].toUpperCase();
  if (RESERVED.has(stem)) return '_' + cleaned;
  return cleaned;
}

// The slider shows 0/25/50/75 because even steps read better than raw encoder
// numbers. What each step is worth depends on the output format, so the numbers
// themselves live in COMPRESSION_TABLES below.
const COMPRESSION_STEPS = [0, 25, 50, 75];

// Every output format the app can write, and what each one means. One table so
// the toggle in the save row, the Save As filters, the encoder choice and the
// copy rules cannot drift apart: adding a format is adding a row here.
//
// `copy` lists the codecs the container will take as a straight stream copy.
// Measured against the bundled ffmpeg rather than assumed, because a copy into
// a container that cannot hold the codec does not degrade, it fails at the
// header. MOV is MP4 without the VP8/VP9 line; WAV deliberately refuses the
// compressed payloads ffmpeg would actually allow inside it, since a .wav
// holding MP3 data is not what anyone choosing WAV is asking for.
const OUTPUT_FORMATS = {
  mp4: {
    kind: 'video', label: 'MP4', dialogName: 'MP4 video',
    copy: { video: ['h264', 'hevc', 'av1', 'vp9', 'mpeg4'], audio: ['aac', 'mp3', 'opus'] },
  },
  webm: {
    kind: 'video', label: 'WebM', dialogName: 'WebM video',
    copy: { video: ['vp8', 'vp9', 'av1'], audio: ['vorbis', 'opus'] },
  },
  mov: {
    kind: 'video', label: 'MOV', dialogName: 'MOV video',
    copy: { video: ['h264', 'hevc', 'prores', 'mpeg4'], audio: ['aac', 'mp3'] },
  },
  mp3: {
    kind: 'audio', label: 'MP3', dialogName: 'MP3 audio',
    copy: { audio: ['mp3'] },
  },
  wav: {
    kind: 'audio', label: 'WAV', dialogName: 'WAV audio',
    copy: { audio: ['pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_u8', 'pcm_f32le'] },
  },
  ogg: {
    kind: 'audio', label: 'OGG', dialogName: 'OGG audio',
    copy: { audio: ['vorbis', 'opus'] },
  },
  aac: {
    kind: 'audio', label: 'AAC', dialogName: 'AAC audio',
    copy: { audio: ['aac'] },
  },
  flac: {
    kind: 'audio', label: 'FLAC', dialogName: 'FLAC audio',
    copy: { audio: ['flac'] },
  },
};

const VIDEO_OUTPUTS = ['mp4', 'webm', 'mov'];
const AUDIO_OUTPUTS = ['mp3', 'wav', 'ogg', 'aac', 'flac'];

function outputsFor(isAudio) {
  return (isAudio ? AUDIO_OUTPUTS : VIDEO_OUTPUTS).slice();
}

// What the slider is worth at each step, in whatever unit the format's encoder
// takes. Higher percentage always means a smaller file, whichever way the
// underlying number happens to run.
//
// x264 CRF 18 is what the app produced before the control existed, so 0% still
// reproduces the old output exactly. VP9 runs 0 to 63 rather than 0 to 51 and
// was matched to the x264 steps by VMAF on a 1080p60 cut, landing at roughly
// half the size for the same score. The audio numbers are kbit/s except Vorbis,
// which takes a 0 to 10 quality, and FLAC, which takes an effort level: FLAC is
// lossless at every one of them, so there the slider only trades size against
// time, measured at 2623 KB down to 2086 KB across the range.
const COMPRESSION_TABLES = {
  mp4: { 0: 18, 25: 23, 50: 28, 75: 32 },
  mov: { 0: 18, 25: 23, 50: 28, 75: 32 },
  webm: { 0: 33, 25: 41, 50: 49, 75: 56 },
  mp3: { 0: 320, 25: 192, 50: 128, 75: 64 },
  aac: { 0: 256, 25: 192, 50: 128, 75: 64 },
  ogg: { 0: 8, 25: 6, 50: 4, 75: 2 },
  flac: { 0: 0, 25: 5, 50: 8, 75: 12 },
};

// Snap to the nearest defined step rather than trusting the number: it arrives
// over IPC from the renderer, so it is not ours to assume valid. A null is the
// checkbox being off, which reads as step 0.
function compressionStep(percent) {
  if (percent === null || percent === undefined) return COMPRESSION_STEPS[0];
  const n = Number(percent);
  if (!Number.isFinite(n)) return COMPRESSION_STEPS[0];
  return COMPRESSION_STEPS.reduce(
    (best, step) => (Math.abs(step - n) < Math.abs(best - n) ? step : best), COMPRESSION_STEPS[0]);
}

// PCM has no quality knob at all, so the control is switched off for it rather
// than left sitting there doing nothing.
function supportsCompression(format) {
  return Object.prototype.hasOwnProperty.call(COMPRESSION_TABLES, format);
}

// What the slider should read at each step. MP3 is the one format whose steps
// are worth naming outright, since a bitrate is what people already think in
// for it; everything else stays a percentage. null means the format has no
// compression to offer, and the control is switched off for it.
function compressionDisplay(format) {
  if (!supportsCompression(format)) return null;
  if (format === 'mp3') {
    return COMPRESSION_STEPS.map((step) => COMPRESSION_TABLES.mp3[step] + ' kbit/s');
  }
  return COMPRESSION_STEPS.map((step) => step + '%');
}

// null means the checkbox is off, which is not the same as 0%: for audio it is
// the difference between copying the stream untouched and re-encoding it at the
// highest setting. Video has always encoded at step 0 when the cut is accurate,
// and still does.
function compressionSetting(format, percent) {
  const table = COMPRESSION_TABLES[format];
  return table ? table[compressionStep(percent)] : null;
}

function crfForCompression(percent) {
  return COMPRESSION_TABLES.mp4[compressionStep(percent)];
}

function vp9CrfForCompression(percent) {
  return COMPRESSION_TABLES.webm[compressionStep(percent)];
}

/**
 * Which slider step a source already sits at, so opening an mp3 can start the
 * control where the file already is rather than at an arbitrary default.
 * Only formats whose steps are bitrates can answer this, which is MP3. A rate
 * that is not one of the four offered gets the middle of the road rather than
 * the nearest step: 245 kbit/s is not meaningfully "320", and rounding it there
 * would promise a quality the source does not have.
 */
const BITRATE_FORMATS = ['mp3'];
const BITRATE_FALLBACK_STEP = 25;   // 192 kbit/s

function stepForBitrate(format, bitsPerSecond) {
  if (!BITRATE_FORMATS.includes(format)) return null;
  const kbps = Math.round(Number(bitsPerSecond) / 1000);
  if (!Number.isFinite(kbps) || kbps <= 0) return BITRATE_FALLBACK_STEP;
  const table = COMPRESSION_TABLES[format];
  const hit = COMPRESSION_STEPS.find((step) => table[step] === kbps);
  return hit === undefined ? BITRATE_FALLBACK_STEP : hit;
}

// The destination name carries the format, because choosing it in the save row
// is what decides the name. Anything unrecognised falls back to what the app
// has always written, so a hand-typed extension cannot produce a nonsense pair.
function containerFor(destination, isAudio) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(destination || ''));
  const ext = m ? m[1].toLowerCase() : '';
  const found = OUTPUT_FORMATS[ext];
  if (found && found.kind === (isAudio ? 'audio' : 'video')) return ext;
  return isAudio ? 'mp3' : 'mp4';
}

/**
 * Whether the source streams could be written into this format untouched.
 * Unknown codecs say no, which costs an encode that was not strictly needed
 * rather than a save that fails at the header.
 */
function canCopyInto(format, codecs, keepAudio) {
  const spec = OUTPUT_FORMATS[format];
  if (!spec) return false;
  const video = String((codecs && codecs.video) || '').toLowerCase();
  const audio = String((codecs && codecs.audio) || '').toLowerCase();
  // An audio-only output is one stream and it has to match. An unknown codec is
  // not a match: guessing costs an encode nobody needed, guessing the other way
  // costs a save that fails.
  if (spec.kind === 'audio') return spec.copy.audio.includes(audio);
  if (!spec.copy.video.includes(video)) return false;
  // Here an absent audio codec really does mean there is no audio stream, so
  // there is nothing to carry across and nothing that can be wrong with it.
  if (!keepAudio || !audio) return true;
  return spec.copy.audio.includes(audio);
}

// The one list behind the open dialog's filter, the audio/video decision, and
// the "What's supported?" popup, so those three cannot drift apart.
// The volume slider runs 0 to 200%. Like the compression percentage this
// arrives over IPC, so it is clamped here rather than trusted, and an absent
// value means unity, which is exactly what the app produced before the control
// existed.
const VOLUME_MAX_PERCENT = 200;

function volumeFactor(percent) {
  // Number(null) is 0, which would silence the output rather than leave it
  // alone, so an absent value is checked for before the numeric conversion.
  if (percent === null || percent === undefined) return 1;
  const n = Number(percent);
  if (!Number.isFinite(n)) return 1;
  return Math.min(VOLUME_MAX_PERCENT, Math.max(0, n)) / 100;
}

// Every crop dimension is forced even. That is not a preference: yuv420p
// subsamples chroma two pixels at a time, so an odd width or height has no
// valid encoding at all, which is why the crop UI steps in twos.
const evenDown = (v) => Math.floor(v / 2) * 2;

// How far out a frame may reach. The same ceiling the project frame uses in
// geometry.js, and for the same reason: larger than anything this app will be
// handed, small enough that one bad number over IPC cannot ask ffmpeg for a
// canvas the size of a hard disk.
const FRAME_MAX = 7680;

/**
 * Turns the renderer's crop rectangle into ffmpeg's video filter, or null when
 * there is nothing worth doing. The rectangle carries the frame size it was
 * measured against, because a crop means nothing without one, and everything
 * here arrives over IPC, so it is held to limits rather than trusted.
 *
 * V2.1 step 21e. The rectangle is allowed to reach outside the source, which
 * turns it from "which part of the picture to keep" into "what shape the output
 * is, and where the picture sits in it". It splits in two: the part of the
 * source the frame really covers, and the frame around it.
 *
 *     crop=take.w:take.h:take.x:take.y,pad=frame.w:frame.h:offset.x:offset.y
 *
 * Every number is even without being rounded again: the frame's edges are made
 * even below, the source's are, and a max or a min of two even numbers is even.
 *
 * The new room is black. That is ffmpeg's own default and it is named anyway,
 * because this is the one place the app decides what is in it, and in simple
 * editing there is nothing under the one video for it to be instead.
 */
function cropFilter(crop) {
  if (!crop) return null;
  const nums = [crop.x, crop.y, crop.width, crop.height, crop.sourceWidth, crop.sourceHeight]
    .map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const srcW = evenDown(nums[4]);
  const srcH = evenDown(nums[5]);
  if (srcW < 2 || srcH < 2) return null;

  // ffmpeg's crop filter masks the low bit off x and y itself for a subsampled
  // format, since a chroma plane has no sample to start from there. Doing the
  // same rounding here means the numbers in the argv are the numbers that get
  // cut, instead of something ffmpeg quietly adjusts afterwards.
  const x = evenDown(nums[0]);
  const y = evenDown(nums[1]);
  const w = Math.min(FRAME_MAX, Math.max(2, evenDown(nums[2])));
  const h = Math.min(FRAME_MAX, Math.max(2, evenDown(nums[3])));

  // What of the source that frame actually lies over.
  const takeX = Math.max(0, x);
  const takeY = Math.max(0, y);
  const takeW = Math.min(srcW, x + w) - takeX;
  const takeH = Math.min(srcH, y + h) - takeY;
  // Dragged clear of the picture altogether. A frame of nothing is not a save,
  // and pad would be asked to place a zero-sized image inside it.
  if (takeW < 2 || takeH < 2) return null;

  // The whole frame is not a crop. Saying so still costs a full re-encode,
  // because a filter cannot ride a stream copy, so it is worth ruling out.
  // Exactly the source's size, not merely as large: a frame larger than the
  // source is the new room, which is the one thing here that has to be said.
  if (x === 0 && y === 0 && w === srcW && h === srcH) return null;

  // Inside the source and no further, which is every crop made before 21e.
  if (takeW === w && takeH === h) return `crop=${w}:${h}:${takeX}:${takeY}`;

  return `crop=${takeW}:${takeH}:${takeX}:${takeY}`
    + `,pad=${w}:${h}:${takeX - x}:${takeY - y}:black`;
}

// Order matters only in that the open dialog and the supported-types popup
// both read it straight off this list.
const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus'];
const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.mov'];
// V2.3. What the app will take as a still. Two formats because two were asked
// for, and .jpeg alongside .jpg because they are one format with two spellings
// and refusing the longer one would be a bug rather than a decision.
//
// This list is what an image IS, wherever the question is asked: the open
// dialog offers these, describeMedia recognises them, and the layer made from
// one carries kind 'image'. Nothing else works out what a still is by looking
// at a file, because two answers to that eventually disagree.
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png'];

module.exports = {
  volumeFactor,
  cropFilter,
  VOLUME_MAX_PERCENT,
  AUDIO_EXTS,
  VIDEO_EXTS,
  IMAGE_EXTS,
  COMPRESSION_STEPS,
  crfForCompression,
  vp9CrfForCompression,
  compressionSetting,
  compressionStep,
  supportsCompression,
  compressionDisplay,
  stepForBitrate,
  containerFor,
  canCopyInto,
  OUTPUT_FORMATS,
  VIDEO_OUTPUTS,
  AUDIO_OUTPUTS,
  outputsFor,
  parseVideoId,
  canonicalUrl,
  parseStartOffset,
  fmtTime,
  parseTime,
  safeFilename,
};
