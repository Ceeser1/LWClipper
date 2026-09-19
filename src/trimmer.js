'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  compressionSetting, volumeFactor, cropFilter, containerFor, canCopyInto,
} = require('./backend');
const toolPaths = require('./toolPaths');
const progress = require('./progress');
const { runProcess, ProcessCancelledError } = require('./processRunner');

const MIN_SPAN = 0.05;

// What each output format is actually encoded with. One place, because the
// accurate cut and the re-encoding copy mode both need it and would otherwise
// carry a copy each, which is how the x264 line ended up written twice before.
//
// VP9 wants -b:v 0 or its CRF is read as a ceiling rather than a target, and
// -row-mt with -cpu-used 4 more than halves the encode for the same file size.
// It is still around six times an x264 veryfast pass, which is the cost of the
// container rather than something tuning can fix.
function videoTrackArgs(format, compression) {
  const q = String(compressionSetting(format, compression));
  if (format === 'webm') {
    return ['-c:v', 'libvpx-vp9', '-crf', q, '-b:v', '0',
      '-row-mt', '1', '-cpu-used', '4', '-deadline', 'good', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', q, '-pix_fmt', 'yuv420p'];
}

// The audio riding along inside a video container. Opus at 160k sits above the
// aac 192k it replaces; the two scales are not comparable and Opus is the more
// efficient of them. The compression slider is aimed at the picture here, which
// is where the bytes are, so the sound keeps a fixed sensible rate.
function videoAudioTrackArgs(format) {
  return format === 'webm'
    ? ['-c:a', 'libopus', '-b:a', '160k']
    : ['-c:a', 'aac', '-b:a', '192k'];
}

// An audio-only output, where the slider is the whole point. Vorbis takes a
// quality rather than a rate, and FLAC an effort level that changes size
// without touching the samples, so each reads the table in its own unit.
function audioFileArgs(format, compression) {
  const q = compressionSetting(format, compression);
  switch (format) {
    case 'wav': return ['-c:a', 'pcm_s16le'];
    case 'flac': return ['-c:a', 'flac', '-compression_level', String(q)];
    case 'ogg': return ['-c:a', 'libvorbis', '-q:a', String(q)];
    case 'aac': return ['-c:a', 'aac', '-b:a', q + 'k'];
    default: return ['-c:a', 'libmp3lame', '-b:a', q + 'k'];
  }
}

/**
 * Assembles the ffmpeg argv. Split out so it can be unit-tested without
 * actually running ffmpeg - mirrors backend.py's build_trim_cmd().
 */
function buildTrimArgs(src, dst, start, span, isAudio, accurate, compression = null,
  audio = {}, crop = null, codecs = {}, video = {}) {
  // Dropping the audio from an audio-only file would leave an empty output, so
  // the switch simply does not apply there. The UI hides it, this makes sure.
  const enabled = isAudio ? true : audio.enabled !== false;
  // Switching the picture off turns a video cut into an audio one: the output
  // is an audio format, and the video stream is dropped rather than carried
  // along. An audio source has no picture to switch off in the first place.
  const keepVideo = !isAudio && video.enabled !== false;
  const audioOut = isAudio || !keepVideo;
  // A replacement track needs a video stream to ride along with, so it is
  // meaningless for audio-only media, and pointless when audio is switched off.
  const replace = (!isAudio && enabled && audio.replacePath) ? audio.replacePath : null;
  // The offset the UI reports is measured against the start of the whole clip,
  // which is the timeline the waveform is drawn on. ffmpeg only ever sees the
  // selected span, so it has to be rebased onto the cut: an offset of 30 on a
  // cut starting at 30 means the track begins exactly at the output's zero.
  // Without this, every cut not starting at zero came out misaligned, and any
  // offset at or past the cut start was delayed clean off the end of the
  // output, which is what made a replaced track save as silence.
  const offset = (Number(audio.offset) || 0) - start;
  const volume = volumeFactor(audio.volume);
  // A filter cannot be applied to a stream that is being copied, so any volume
  // other than unity forces the audio to be re-encoded, in every mode. At unity
  // nothing is added and each mode keeps exactly the codecs it always used.
  const encodeAudio = enabled && (replace !== null || volume !== 1);
  // A crop has no meaning for an audio-only file. Where it does apply the same
  // rule as the volume above applies to the video: it is a filter, so the video
  // cannot be copied while one is set, copy mode included.
  // A crop has no meaning without a picture to cut, whether that is because the
  // source has none or because it is being dropped.
  const cropArg = audioOut ? null : cropFilter(crop);
  // The destination name carries the format, for audio and video alike, because
  // the toggle in the save row is what decides that name.
  const container = containerFor(dst, audioOut);
  // The checkbox being off is not the same as 0%: off means leave the stream
  // alone where that is possible at all, 0% means encode at the best setting.
  const compressing = compression !== null && compression !== undefined;

  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ss', start.toFixed(3),
    '-i', src,
  ];

  if (replace) {
    // A negative offset means "start further into the replacement", which is
    // the same per-input seek used for the video above. A positive one is a
    // delay, applied as a filter further down.
    if (offset < 0) args.push('-ss', Math.abs(offset).toFixed(3));
    args.push('-i', replace);
  }

  args.push('-t', span.toFixed(3));

  if (replace) args.push('-map', '0:v', '-map', '1:a');

  if (enabled) {
    const filters = [];
    if (replace && offset > 0) filters.push('adelay=' + Math.round(offset * 1000) + ':all=1');
    // apad is what keeps a replacement shorter than the clip from cutting the
    // video short: -shortest alone would end the output when the audio runs
    // out. Padded to infinity, -shortest then trims to the video instead.
    if (replace) filters.push('apad');
    // Last in the chain, so it scales whatever the clip actually ends up with,
    // the original track or a replacement alike.
    if (volume !== 1) filters.push('volume=' + volume.toFixed(3));
    if (filters.length) args.push('-af', filters.join(','));
  }

  if (cropArg) args.push('-vf', cropArg);

  if (replace) args.push('-shortest');

  // Whether the streams could be written into this format untouched. A copy
  // into a container that cannot hold the codec does not degrade, it fails at
  // the header, which is what used to make saving a wav or a flac impossible:
  // the output is always one of a handful of formats, and only an mp3 source
  // could actually be copied into an mp3.
  const fitsContainer = canCopyInto(container, codecs, enabled);

  if (audioOut) {
    // Frames here are about 26 ms, so a copy lands within one of the asked-for
    // point and the accurate flag has nothing to offer; the UI hides it. What
    // does force an encode is a filter, a format the source does not already
    // fit, or compression being switched on, since that is the only way the
    // setting can mean anything.
    if (encodeAudio || compressing || !fitsContainer) {
      args.push(...audioFileArgs(container, compression));
    } else {
      args.push('-c', 'copy');
    }
  } else if (accurate) {
    // -ss before -i is still frame-exact when re-encoding: ffmpeg fast-seeks
    // to the preceding keyframe and then decodes forward to the exact point.
    args.push(...videoTrackArgs(container, compression));
    if (enabled) args.push(...videoAudioTrackArgs(container));
    if (container !== 'webm') args.push('-movflags', '+faststart');
  } else {
    // Copy mode snaps the start back to the nearest keyframe, so the clip
    // can begin a few seconds early. That is the price of finishing instantly.
    //
    // A filter forces its own stream to be encoded, and once one of them is,
    // the other cannot be left copying: -ss before -i hands over everything
    // from the keyframe preceding the cut, a copied stream keeps all of it and
    // an encoded one drops whatever precedes the cut. Mixing the two leaves
    // that lead-in with sound and no picture, or picture and no sound, measured
    // at a full 2 seconds on a 250-frame GOP. So once anything here has to be
    // encoded, all of it is, and the cut comes out exact rather than early.
    //
    // A copy also has to produce something the container can hold. WebM takes
    // only VP8/VP9/AV1 with Vorbis or Opus and MOV will not take either VP8 or
    // VP9, so unless the source already fits, copying in fails at the header
    // rather than falling back. A webm the app downloaded copies straight into
    // a webm; an mp4 never can.
    if (cropArg || encodeAudio || !fitsContainer) {
      args.push(...videoTrackArgs(container, compression));
      if (enabled) args.push(...videoAudioTrackArgs(container));
    } else {
      args.push('-c', 'copy');
    }
    args.push('-avoid_negative_ts', 'make_zero');
    if (container !== 'webm') args.push('-movflags', '+faststart');
  }

  if (!enabled) args.push('-an');
  // The mirror of -an: a video stream left in would be carried into the audio
  // container as cover art at best, and refused outright at worst.
  if (!keepVideo && !isAudio) args.push('-vn');

  args.push('-progress', 'pipe:1', '-nostats', dst);
  return args;
}

/**
 * Throw away what a cancelled encode had written.
 *
 * ffmpeg writes straight to the destination, so pressing Cancel leaves however
 * many seconds it got through sitting under the name the user chose in the Save
 * dialog. That file plays, and it is not the clip they asked for: it is the
 * front of it, with no container index if the cut came early enough. A missing
 * file says "cancelled" the way a truncated one never does.
 *
 * Shared with composer.js so the two save paths cannot disagree about it, and
 * only ever called on the way out with a cancellation: a file that failed to
 * encode keeps its remains, because there the question is why, and the answer
 * is sometimes in what was written.
 *
 * Failing to remove it is not worth reporting. The file was already going to be
 * left behind, and the encode is over either way.
 */
function discardPartial(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Something else has it open. Leaving it is what used to happen anyway.
  }
}

async function trim(media, dst, start, end, accurate, compression, audio, crop, video,
  onProgress, cancelToken) {
  const ffmpeg = toolPaths.findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg.exe was not found alongside the app.');

  const src = path.resolve(media.path);
  const dstFull = path.resolve(dst);
  if (src.toLowerCase() === dstFull.toLowerCase()) {
    throw new Error('Pick a destination outside the cache; that is the cached file itself.');
  }

  start = Math.max(0, start);
  if (media.duration) end = Math.min(end, media.duration);
  const span = end - start;
  if (span < MIN_SPAN) throw new Error('The selected range is empty.');

  fs.mkdirSync(path.dirname(dstFull), { recursive: true });
  const args = buildTrimArgs(
    src, dstFull, start, span, media.isAudio, accurate, compression, audio, crop,
    { video: media.videoCodec, audio: media.audioCodec }, video);

  const tail = [];
  const reader = progress.ffmpegProgress(span);
  let result;
  try {
    result = await runProcess(ffmpeg, args, (line) => {
      const update = reader.line(line);
      if (update) {
        if (onProgress) onProgress(update.frac, update.text);
      } else if (line.trim() && !progress.isProgressLine(line)) {
        tail.push(line.trim());
      }
    }, cancelToken);
  } catch (e) {
    if (e instanceof ProcessCancelledError) discardPartial(dstFull);
    throw e;
  }

  if (result.exitCode !== 0) {
    const detail = tail.length ? tail.join('\n') : `exit code ${result.exitCode}`;
    throw new Error('ffmpeg failed:\n' + detail);
  }
  if (onProgress) onProgress(1.0, 'Saved.');
  return dstFull;
}

const NO_MEDIA = {
  duration: 0, hasAudio: false, width: 0, height: 0, fps: 0, videoCodec: '', audioCodec: '',
  audioBitrate: 0,
};

/**
 * ffprobe writes a frame rate as a fraction, and "30000/1001" is not something
 * anything downstream should have to know about. 0 for anything unreadable,
 * which is every audio file and a variable-rate stream that declines to guess.
 *
 * Rounded to three places rather than to a whole number: 29.97 and 30 are
 * different rates and a project seeded from the first would drift against its
 * source if it were told they were the same.
 */
function parseFrameRate(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text || '').trim());
  if (!m) return 0;
  const den = Number(m[2]);
  if (!den) return 0;
  const fps = Number(m[1]) / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : 0;
}

/**
 * Duration, whether there is an audio stream, and the frame size, from a single
 * ffprobe call. Folding them into one query keeps opening a file at the cost it
 * already had. The frame size is what the crop is measured against, and it is
 * taken from here rather than from the <video> element because these are the
 * coded dimensions ffmpeg's crop filter actually works in.
 */
function probeMedia(filePath) {
  const ffprobe = toolPaths.findFfprobe();
  if (!ffprobe) return { ...NO_MEDIA };
  try {
    const out = execFileSync(ffprobe, [
      '-v', 'error',
      '-show_entries',
      'format=duration,bit_rate'
        + ':stream=codec_type,codec_name,width,height,bit_rate,r_frame_rate',
      '-of', 'json', filePath,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const info = JSON.parse(out);
    const d = parseFloat((info.format && info.format.duration) || '');
    const streams = Array.isArray(info.streams) ? info.streams : [];
    const video = streams.find((st) => st.codec_type === 'video') || {};
    const audio = streams.find((st) => st.codec_type === 'audio') || {};
    const size = (v) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 0);
    const rate = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);
    return {
      duration: Number.isFinite(d) ? d : 0,
      hasAudio: streams.some((st) => st.codec_type === 'audio'),
      width: size(video.width),
      height: size(video.height),
      // The project's own rate is seeded from its first source, so this has to
      // travel as far as the layer does. Without it every export would be
      // written at the composer's 30fps default, which silently halves 60fps
      // material.
      fps: parseFrameRate(video.r_frame_rate),
      // Only saving to WebM cares about these, to work out whether the streams
      // could be copied into one or have to be encoded for it.
      videoCodec: String(video.codec_name || ''),
      audioCodec: String(audio.codec_name || ''),
      // Bits per second. The stream figure is the precise one, but not every
      // file carries it, so the container's own is the fallback. Only the mp3
      // compression preset reads this.
      audioBitrate: rate(audio.bit_rate) || (streams.length === 1 ? rate(info.format.bit_rate) : 0),
    };
  } catch {
    return { ...NO_MEDIA };
  }
}

function probeDuration(filePath) {
  return probeMedia(filePath).duration;
}

module.exports = {
  buildTrimArgs, trim, probeMedia, probeDuration, parseFrameRate, discardPartial, MIN_SPAN,
  // Exported for composer.js, so advanced mode encodes with exactly the same
  // codec choices rather than growing a second copy of the x264 line.
  videoTrackArgs, videoAudioTrackArgs, audioFileArgs,
};
