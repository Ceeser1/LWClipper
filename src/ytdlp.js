'use strict';

const fs = require('fs');
const path = require('path');
const { parseVideoId, canonicalUrl, parseStartOffset } = require('./backend');
const toolPaths = require('./toolPaths');
const { runProcess } = require('./processRunner');
const { probeMedia } = require('./trimmer');
const { containerFor, stepForBitrate } = require('./backend');

const VIDEO_EXTS = ['.mp4', '.mkv', '.webm'];
const COOKIE_BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'];
const MAX_HEIGHT_CHOICES = 6;

/**
 * yt-dlp only ever sees a canonical YouTube URL when the link actually is one.
 * Anything else is passed through untouched, because only yt-dlp knows which of
 * its ~1800 extractors can handle a given host.
 */
function normalizeUrl(raw) {
  let candidate = (raw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!candidate) return null;
  if (!candidate.includes('//')) candidate = 'https://' + candidate;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Cache filenames key off this. A YouTube id is already unique and filename
 * safe; for every other site the extractor name is folded in so two sites
 * handing out the same id cannot collide in the cache.
 */
function cacheKeyFor(info, videoId) {
  if (videoId) return videoId;
  const extractor = String(info.extractor_key || info.extractor || 'src');
  const id = String(info.id || 'media');
  return (extractor + '-' + id).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 80);
}

/**
 * Reads the session out of the named browser so sites that only serve content
 * to logged in accounts work. Needed on the probe as much as the download,
 * since the probe is the request that talks to the site's API.
 */
function cookieArgs(cookies) {
  if (!cookies || !cookies.browser) return [];
  const browser = String(cookies.browser).toLowerCase();
  if (!COOKIE_BROWSERS.includes(browser)) return [];
  return ['--cookies-from-browser', browser];
}

function formatOptionForHeight(height) {
  const sel = `bv*[vcodec^=avc1][height<=${height}]+ba[acodec^=mp4a]/bv*[height<=${height}]+ba/b[height<=${height}]/b`;
  return { label: `${height}p`, selector: sel, cacheKey: `${height}p`, isAudio: false };
}

function audioFormatOption() {
  return { label: 'Audio only (MP3)', selector: 'ba[acodec^=mp4a]/ba/b', cacheKey: 'audio', isAudio: true };
}

/**
 * Probes a URL for title/duration/available heights via `yt-dlp -j`, then
 * builds the format picker options. Splitting probe from download (unlike
 * the Python app, which got a structured info dict mid-download-hook from
 * yt-dlp's Python API) means the format list is known up front, driven by
 * whatever heights this specific video actually has.
 */
async function probe(url, cookies, cancelToken) {
  const videoId = parseVideoId(url);
  const target = videoId ? canonicalUrl(videoId) : normalizeUrl(url);
  if (!target) throw new Error('That does not look like a link.');

  const ytdlp = toolPaths.findYtDlp();
  if (!ytdlp) throw new Error('yt-dlp.exe was not found alongside the app.');

  const args = ['--no-warnings', '--no-playlist', ...cookieArgs(cookies), '-j', target];
  let out = '';
  const result = await runProcess(ytdlp, args, (line) => {
    // -j prints one compact JSON object per line, so a page resolving to
    // several entries yields several. Keep the first and ignore the rest.
    if (!out && line.trim().startsWith("{")) out = line.trim();
  }, cancelToken);
  if (result.exitCode !== 0) {
    if (/Unsupported URL/i.test(result.stderrTail.join(" "))) {
      throw new Error("yt-dlp does not know how to read that site.");
    }
    throw new Error('yt-dlp failed:\n' + result.stderrTail.join('\n'));
  }

  if (!out) throw new Error('Could not read video info from yt-dlp.');
  let info;
  try {
    info = JSON.parse(out);
  } catch (e) {
    throw new Error('Could not read video info from yt-dlp.');
  }

  const heights = new Set();
  for (const f of info.formats || []) {
    if (f.height && f.vcodec && f.vcodec !== 'none') heights.add(f.height);
  }
  const sortedHeights = [...heights].sort((a, b) => b - a).slice(0, MAX_HEIGHT_CHOICES);

  const formats = sortedHeights.map(formatOptionForHeight);
  formats.push(audioFormatOption());

  const key = cacheKeyFor(info, videoId);
  return {
    videoId: key,
    // The link the user actually pasted, so the download hits the same page the
    // probe did instead of being rebuilt into a YouTube URL.
    sourceUrl: target,
    title: info.title || key,
    duration: info.duration || 0,
    formats,
    // Read off the URL the user actually pasted, not the canonical one, since
    // canonicalUrl drops the timestamp.
    startOffset: parseStartOffset(url) || 0,
  };
}

function findCachedFile(videoId, format) {
  const dir = toolPaths.cacheDir();
  const exts = format.isAudio ? ['.mp3'] : VIDEO_EXTS;
  for (const ext of exts) {
    const p = path.join(dir, `${videoId}.${format.cacheKey}${ext}`);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
  }
  return null;
}

function mb(n) {
  return ((n || 0) / 1048576).toFixed(1) + ' MB';
}

function downloadStatusLine(got, total, speed, eta) {
  const parts = [];
  if (total) {
    parts.push(`${((got || 0) / total * 100).toFixed(1).padStart(5)}%   ${mb(got)} / ${mb(total)}`);
  } else {
    parts.push(mb(got));
  }
  if (speed) parts.push(`${(speed / 1048576).toFixed(1)} MB/s`);
  if (eta !== null && eta !== undefined) parts.push(`ETA ${Math.round(eta)}s`);
  return parts.join('   ');
}

const PROGRESS_RE = /^LWCLIPPER_DL\t([\d.]+|NA)\t([\d.]+|NA)\t([\d.]+|NA)\t([\d.]+|NA)$/;

function parseNum(s) {
  if (s === 'NA' || !s) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/**
 * Downloads the chosen format into the cache, reporting progress via
 * onProgress(frac|null, statusText). Reuses a cached file at the same
 * video id + quality without hitting the network again.
 */
async function download(videoId, sourceUrl, title, format, cookies, onProgress, cancelToken) {
  const ytdlp = toolPaths.findYtDlp();
  const ffmpeg = toolPaths.findFfmpeg();
  if (!ytdlp) throw new Error('yt-dlp.exe was not found alongside the app.');
  if (!ffmpeg) throw new Error('ffmpeg.exe was not found alongside the app.');

  const cached = findCachedFile(videoId, format);
  if (cached) {
    if (onProgress) onProgress(1.0, 'Already in cache.');
    const info = probeMedia(cached);
    return {
      path: cached, title, duration: info.duration, videoId,
      cacheKey: format.cacheKey, isAudio: format.isAudio, hasAudio: info.hasAudio,
      width: info.width, height: info.height,
      videoCodec: info.videoCodec, audioCodec: info.audioCodec,
      ...outputHints(cached, format.isAudio, info.audioBitrate),
    };
  }

  const outTemplate = path.join(toolPaths.cacheDir(), `${videoId}.${format.cacheKey}.%(ext)s`);
  const args = [
    '--no-warnings', '--no-playlist',
    '--ffmpeg-location', path.dirname(ffmpeg),
    '-o', outTemplate,
    '--newline',
    '--progress-template', 'download:LWCLIPPER_DL\t%(progress.downloaded_bytes)s\t%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s',
    '--retries', '5', '--fragment-retries', '5', '--concurrent-fragments', '4',
    '--force-overwrites',
    ...cookieArgs(cookies),
  ];
  if (format.isAudio) {
    args.push('-f', format.selector, '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '192K');
  } else {
    args.push('-f', format.selector, '--merge-output-format', 'mp4');
  }
  args.push(sourceUrl);

  if (onProgress) onProgress(0, 'Starting download...');
  const result = await runProcess(ytdlp, args, (line) => {
    const m = PROGRESS_RE.exec(line);
    if (!m) {
      if (/Merging|Extracting audio|\[Merger\]|\[ExtractAudio\]/.test(line)) {
        if (onProgress) onProgress(null, format.isAudio ? 'Converting to mp3...' : 'Merging video and audio...');
      }
      return;
    }
    const got = parseNum(m[1]);
    const total = parseNum(m[2]);
    const speed = parseNum(m[3]);
    const eta = parseNum(m[4]);
    const frac = (got !== null && total) ? got / total : null;
    if (onProgress) onProgress(frac, downloadStatusLine(got, total, speed, eta));
  }, cancelToken);

  if (result.exitCode !== 0) {
    throw new Error('yt-dlp failed:\n' + result.stderrTail.join('\n'));
  }

  const finalPath = findCachedFile(videoId, format);
  if (!finalPath) throw new Error('The download finished but no output file turned up in the cache.');

  const { duration, hasAudio, width, height, videoCodec, audioCodec, audioBitrate } =
    probeMedia(finalPath);
  return {
    path: finalPath, title, duration, videoId,
    cacheKey: format.cacheKey, isAudio: format.isAudio, hasAudio, width, height,
    videoCodec, audioCodec,
    ...outputHints(finalPath, format.isAudio, audioBitrate),
  };
}

// A download lands as whatever yt-dlp gave us, so the save row should open on
// that format the same way opening a local file does. Same two fields
// describeMedia adds, kept in one place so the two paths cannot drift.
function outputHints(filePath, isAudio, audioBitrate) {
  const sourceFormat = containerFor(filePath, isAudio);
  return { sourceFormat, compressionPreset: stepForBitrate(sourceFormat, audioBitrate) };
}

module.exports = { probe, download, normalizeUrl, cacheKeyFor, cookieArgs };
