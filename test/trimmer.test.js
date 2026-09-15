'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// trimmer.js requires 'electron' via toolPaths.js; stub it out so these pure
// buildTrimArgs tests can run under plain `node --test` without Electron.
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const { buildTrimArgs } = require('../src/trimmer');

// probeMedia always reports these, so a call without them is describing a state
// the app cannot actually be in. Named here so the argv tests read as real cuts.
const H264 = { video: 'h264', audio: 'aac' };
const VP9 = { video: 'vp9', audio: 'opus' };
const MP3 = { audio: 'mp3' };

test('an mp3 cut into an mp3 stream-copies', () => {
  const args = buildTrimArgs('src.mp3', 'dst.mp3', 1.5, 10.0, true, true, null, {}, null, MP3);
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('copy'));
  assert.ok(!args.includes('libx264'), 'audio path must never touch the video encoder options');
});

test('any other source has to be encoded to become an mp3', () => {
  // This used to copy, and the save failed at the header: an mp3 container
  // holds exactly one mp3 stream, so an m4a cannot simply be poured into one.
  const args = buildTrimArgs('src.m4a', 'dst.mp3', 1.5, 10.0, true, true, null, {}, null,
    { audio: 'aac' });
  assert.ok(!args.includes('copy'));
  assert.ok(args.includes('libmp3lame'));
  assert.ok(!args.includes('libx264'), 'audio path must never touch the video encoder options');
});

test('accurate mode re-encodes video', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true);
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('aac'));
  assert.ok(!args.includes('-avoid_negative_ts'), 'accurate mode does not need the negative-timestamp fixup copy mode needs');
});

test('copy mode snaps to keyframe and fixes timestamps', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, null, {}, null, H264);
  assert.ok(args.includes('copy'));
  assert.ok(args.includes('-avoid_negative_ts'));
  assert.ok(args.includes('make_zero'));
  assert.ok(!args.includes('libx264'));
});

test('uses -t not -to for span length', () => {
  // -t <span> is deliberate: -to's meaning shifts with where -ss sits
  // relative to -i, whereas -t is always "duration from the seek point".
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 2.0, 8.0, false, true);
  const tIndex = args.indexOf('-t');
  assert.ok(tIndex > -1);
  assert.equal(args[tIndex + 1], '8.000');
  assert.ok(!args.includes('-to'));
});

test('seeks before input for fast keyframe seek', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 3.25, 4.0, false, false);
  const ssIndex = args.indexOf('-ss');
  const iIndex = args.indexOf('-i');
  assert.ok(iIndex > ssIndex, '-ss must come before -i to fast-seek instead of decoding up to the point');
  assert.equal(args[ssIndex + 1], '3.250');
});

test('always requests machine-readable progress', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 1.0, false, true);
  const progIndex = args.indexOf('-progress');
  assert.ok(progIndex > -1);
  assert.equal(args[progIndex + 1], 'pipe:1');
});

const crfOf = (args) => args[args.indexOf('-crf') + 1];

test('compression only reaches ffmpeg when the cut re-encodes', () => {
  const accurate = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 75);
  assert.equal(crfOf(accurate), '32');

  // Copy mode re-encodes nothing, so there is nothing for the setting to do.
  const copy = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, 75, {}, null, H264);
  assert.ok(!copy.includes('-crf'));
  assert.ok(!copy.includes('libx264'));

  const audio = buildTrimArgs('src.m4a', 'dst.mp3', 0, 5.0, true, true, 75);
  assert.ok(!audio.includes('-crf'));
});

test('omitting compression reproduces the pre-slider output', () => {
  // 0% and "argument not passed at all" must both mean the original CRF 18,
  // so an old call site cannot silently change what users get.
  assert.equal(crfOf(buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true)), '18');
  assert.equal(crfOf(buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0)), '18');
});

test('each slider step produces a distinct encoder setting', () => {
  const seen = [0, 25, 50, 75].map((pct) =>
    crfOf(buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, pct)));
  assert.deepEqual(seen, ['18', '23', '28', '32']);
  assert.equal(new Set(seen).size, 4, 'two steps must never collapse to the same quality');
});

// ---- audio: switch off, and replacement tracks ----

const inputsOf = (args) => args.reduce((acc, a, i) => (a === '-i' ? acc.concat(args[i + 1]) : acc), []);
const afOf = (args) => args[args.indexOf('-af') + 1];

test('disabling audio drops the stream and asks for no encoder', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0, { enabled: false });
  assert.ok(args.includes('-an'));
  assert.ok(!args.includes('aac'), 'no point configuring an encoder for a stream being dropped');
  assert.ok(args.includes('libx264'), 'video still gets encoded');
});

test('disabling audio works in copy mode too', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, 0, { enabled: false },
    null, H264);
  assert.ok(args.includes('-an'));
  assert.ok(args.includes('copy'));
});

test('an audio-only file never loses its only stream', () => {
  // Honouring enabled:false here would write an empty file.
  const args = buildTrimArgs('src.mp3', 'dst.mp3', 0, 5.0, true, true, 0, { enabled: false });
  assert.ok(!args.includes('-an'));
});

test('a replacement track is mapped in as the second input', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 0 });
  assert.deepEqual(inputsOf(args), ['src.mp4', 'music.mp3']);
  const map = args.reduce((acc, a, i) => (a === '-map' ? acc.concat(args[i + 1]) : acc), []);
  assert.deepEqual(map, ['0:v', '1:a']);
  assert.ok(args.includes('-shortest'));
  assert.ok(afOf(args).includes('apad'), 'apad is what stops a short track truncating the video');
});

test('a positive offset delays the replacement, a negative one seeks into it', () => {
  const later = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 2.5 });
  assert.ok(afOf(later).startsWith('adelay=2500:all=1'));

  const earlier = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0,
    { enabled: true, replacePath: 'music.mp3', offset: -4 });
  assert.ok(!afOf(earlier).includes('adelay'), 'seeking in is not a delay');
  // The seek has to sit between the two inputs, or it would apply to the video.
  const firstInput = earlier.indexOf('-i');
  const secondInput = earlier.indexOf('-i', firstInput + 1);
  const seek = earlier.indexOf('-ss', firstInput);
  assert.ok(seek > firstInput && seek < secondInput, 'the -ss must bind to the replacement input');
  assert.equal(earlier[seek + 1], '4.000');
});

test('the offset is rebased onto the cut, not the whole clip', () => {
  // The UI measures the offset from the start of the clip, which is the
  // timeline the waveform is drawn on; ffmpeg only sees the selected span. A
  // track sitting at 0:30 under a cut that starts at 0:30 has to land at the
  // output's zero, not 30 seconds past the end of a 5 second clip.
  const aligned = buildTrimArgs('src.mp4', 'dst.mp4', 30, 5.0, false, true, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 30 });
  assert.ok(!afOf(aligned).includes('adelay'), 'aligned means no delay at all');
  assert.equal(inputsOf(aligned).length, 2);

  // Same alignment, later cut: identical audio treatment.
  const later = buildTrimArgs('src.mp4', 'dst.mp4', 120, 5.0, false, true, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 120 });
  assert.ok(!afOf(later).includes('adelay'));

  // A track left at the clip's start, with the cut moved along, is reached by
  // seeking that far into it.
  const behind = buildTrimArgs('src.mp4', 'dst.mp4', 30, 5.0, false, true, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 0 });
  const firstInput = behind.indexOf('-i');
  const seek = behind.indexOf('-ss', firstInput);
  assert.equal(behind[seek + 1], '30.000');

  // And one starting after the cut keeps the delay the gap actually is.
  const ahead = buildTrimArgs('src.mp4', 'dst.mp4', 30, 5.0, false, true, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 32 });
  assert.ok(afOf(ahead).startsWith('adelay=2000:all=1'));
});

test('volume scales the audio and forces it to be encoded', () => {
  // A filter cannot ride a stream copy, so every mode has to give up copying
  // the audio once the volume leaves unity.
  const loud = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0,
    { enabled: true, volume: 150 });
  assert.equal(afOf(loud), 'volume=1.500');
  assert.ok(loud.includes('aac'));

  const copyLoud = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, 0,
    { enabled: true, volume: 50 });
  assert.equal(afOf(copyLoud), 'volume=0.500');
  assert.ok(!copyLoud.includes('-c'), 'a blanket -c copy cannot carry a filter');
  assert.ok(copyLoud.includes('-c:v') && copyLoud.includes('aac'));

  const quietMp3 = buildTrimArgs('src.mp3', 'dst.mp3', 0, 5.0, true, true, 0, { volume: 25 });
  assert.ok(quietMp3.includes('libmp3lame'), 'an mp3 has to be re-encoded to be scaled');
  assert.ok(!quietMp3.includes('copy'));

  // Last in the chain, so it scales the replacement rather than the original.
  const both = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 2, volume: 200 });
  assert.equal(afOf(both), 'adelay=2000:all=1,apad,volume=2.000');
});

test('unity volume leaves every mode exactly as it was', () => {
  for (const [isAudio, accurate] of [[false, true], [false, false], [true, true]]) {
    const src = isAudio ? 'src.mp3' : 'src.mp4';
    const dst = isAudio ? 'dst.mp3' : 'dst.mp4';
    const before = buildTrimArgs(src, dst, 0, 5.0, isAudio, accurate, 0, { enabled: true });
    for (const v of [100, undefined, null]) {
      assert.deepEqual(
        buildTrimArgs(src, dst, 0, 5.0, isAudio, accurate, 0, { enabled: true, volume: v }),
        before, 'volume ' + v + ' must change nothing');
    }
  }
});

test('volume is ignored where there is no audio to scale', () => {
  const muted = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0,
    { enabled: false, volume: 200 });
  assert.ok(muted.includes('-an'));
  assert.ok(!muted.includes('-af'), 'no filter on a stream that is not there');
});

test('copy mode gives up copying once either stream has to be filtered', () => {
  // Measured, not assumed. Copying the video while encoding the audio left the
  // keyframe lead-in this mode puts at the front with picture and no sound, and
  // the other way round it had sound and no picture: -ss before -i hands over
  // everything from the keyframe before the cut, a copied stream keeps all of
  // it and an encoded one drops it. Cutting both the same way is what keeps the
  // output whole, and it makes the cut exact into the bargain.
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 0 });
  assert.ok(!args.includes('-c'), 'a blanket -c copy would try to copy the replacement too');
  assert.ok(args.includes('libx264'), 'the video is cut the same way as the audio');
  assert.ok(args.includes('aac'));
  assert.ok(args.includes('-avoid_negative_ts'), 'still the copy branch, not the accurate one');
});

test('a replacement is ignored where it cannot apply', () => {
  const muted = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0,
    { enabled: false, replacePath: 'music.mp3' });
  assert.equal(inputsOf(muted).length, 1, 'nothing to replace when audio is off');
  assert.ok(muted.includes('-an'));

  const audioOnly = buildTrimArgs('src.mp3', 'dst.mp3', 0, 5.0, true, true, 0,
    { enabled: true, replacePath: 'music.mp3' });
  assert.equal(inputsOf(audioOnly).length, 1, 'no video stream for a replacement to ride along with');
});

test('omitting the audio options leaves the old behaviour untouched', () => {
  const before = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0);
  const explicit = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0,
    { enabled: true, replacePath: null, offset: 0 });
  assert.deepEqual(before, explicit);
  assert.ok(!before.includes('-an'));
  assert.ok(!before.includes('-map'));
});

const vfOf = (args) => args[args.indexOf('-vf') + 1];
const FULL = { sourceWidth: 1920, sourceHeight: 1080 };

test('a crop becomes a video filter', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, true, 0, {},
    { x: 420, y: 0, width: 1080, height: 1080, ...FULL });
  assert.equal(vfOf(args), 'crop=1080:1080:420:0');
  assert.ok(args.includes('libx264'));
});

test('a crop forces copy mode to re-encode', () => {
  // Same rule the volume slider already runs into: there is no filtering a
  // stream that is being copied through. The audio goes with it, or the
  // keyframe lead-in comes out with sound over no picture.
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, 0, {},
    { x: 0, y: 140, width: 1920, height: 800, ...FULL });
  assert.equal(vfOf(args), 'crop=1920:800:0:140');
  assert.ok(args.includes('libx264'), 'the video has to be encoded to be cropped');
  assert.ok(!args.includes('-c'), 'a blanket -c copy cannot carry a filter');
  assert.ok(args.includes('aac'), 'the audio is cut the same way the video is');
  assert.ok(args.includes('-avoid_negative_ts'), 'still the copy branch, not the accurate one');
});

test('a crop in copy mode still drops the audio when it is switched off', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, 0,
    { enabled: false }, { x: 0, y: 0, width: 1280, height: 720, ...FULL });
  assert.ok(args.includes('-an'));
  assert.ok(!args.includes('aac'), 'no codec for a stream that is not in the output');
});

test('a crop in copy mode follows the compression setting', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, 50, {},
    { x: 0, y: 0, width: 1280, height: 720, ...FULL });
  assert.equal(args[args.indexOf('-crf') + 1], '28');
});

test('a crop and a replacement track coexist', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, false, 0,
    { enabled: true, replacePath: 'music.mp3', offset: 0, volume: 150 },
    { x: 0, y: 0, width: 1280, height: 720, ...FULL });
  assert.equal(vfOf(args), 'crop=1280:720:0:0');
  assert.equal(afOf(args), 'apad,volume=1.500');
  assert.ok(args.includes('aac'), 'a filtered replacement still has to be encoded');
});

test('a crop cannot apply to an audio-only file', () => {
  const args = buildTrimArgs('src.mp3', 'dst.mp3', 0, 5.0, true, true, null, {},
    { x: 0, y: 0, width: 320, height: 240, sourceWidth: 640, sourceHeight: 480 }, MP3);
  assert.ok(!args.includes('-vf'), 'there is no picture to cut');
  assert.ok(args.includes('copy'));
});

test('no crop leaves every mode exactly as it was', () => {
  for (const [isAudio, accurate] of [[false, true], [false, false], [true, true]]) {
    const src = isAudio ? 'src.mp3' : 'src.mp4';
    const dst = isAudio ? 'dst.mp3' : 'dst.mp4';
    const before = buildTrimArgs(src, dst, 0, 5.0, isAudio, accurate, 0, { enabled: true });
    for (const c of [undefined, null, { x: 0, y: 0, width: 1920, height: 1080, ...FULL }]) {
      assert.deepEqual(
        buildTrimArgs(src, dst, 0, 5.0, isAudio, accurate, 0, { enabled: true }, c),
        before, 'crop ' + JSON.stringify(c) + ' must change nothing');
    }
  }
});

// --- WebM output -----------------------------------------------------------
// Only Save As can pick it, and it is the destination name that carries the
// choice, so every one of these turns on the extension alone.

test('a webm destination encodes VP9 and Opus instead of x264 and aac', () => {
  const args = buildTrimArgs('src.mp4', 'dst.webm', 0, 5.0, false, true, 0, {}, null, H264);
  assert.ok(args.includes('libvpx-vp9'));
  assert.ok(args.includes('libopus'));
  assert.ok(!args.includes('libx264'), 'webm cannot hold h264');
  assert.ok(!args.includes('aac'), 'webm cannot hold aac');
});

test('VP9 is given -b:v 0 so the crf is a target and not a ceiling', () => {
  const args = buildTrimArgs('src.mp4', 'dst.webm', 0, 5.0, false, true);
  assert.equal(args[args.indexOf('-b:v') + 1], '0');
  assert.ok(args.includes('-row-mt'), 'row threading is most of the encode time');
});

test('the compression slider maps onto VP9 own scale, not x264 numbers', () => {
  // 0 to 63 rather than 0 to 51: reusing 18/23/28/32 would hand out a quietly
  // better and bigger file than the slider promises. Matched by VMAF.
  const crfAt = (pct, dst) => {
    const args = buildTrimArgs('src.mp4', dst, 0, 5.0, false, true, pct);
    return args[args.indexOf('-crf') + 1];
  };
  assert.deepEqual([0, 25, 50, 75].map((p) => crfAt(p, 'd.webm')), ['33', '41', '49', '56']);
  assert.deepEqual([0, 25, 50, 75].map((p) => crfAt(p, 'd.mp4')), ['18', '23', '28', '32']);
});

test('faststart is an mp4 flag and is not sent to a webm', () => {
  for (const accurate of [true, false]) {
    const webm = buildTrimArgs('src.webm', 'dst.webm', 0, 5.0, false, accurate, 0, {}, null, VP9);
    const mp4 = buildTrimArgs('src.mp4', 'dst.mp4', 0, 5.0, false, accurate);
    assert.ok(!webm.includes('-movflags'), 'accurate=' + accurate);
    assert.ok(mp4.includes('-movflags'), 'accurate=' + accurate);
  }
});

test('copy mode into webm re-encodes an h264 source, which webm cannot hold', () => {
  // Not a quality choice: a stream copy of h264 into webm fails at the header.
  const args = buildTrimArgs('src.mp4', 'dst.webm', 0, 5.0, false, false, 0, {}, null, H264);
  assert.ok(args.includes('libvpx-vp9'));
  assert.ok(!args.includes('copy'), 'there is nothing here that could be copied');
  assert.ok(args.includes('-avoid_negative_ts'), 'still the copy branch, not the accurate one');
});

test('copy mode into webm really does copy a source that is already webm', () => {
  const args = buildTrimArgs('src.webm', 'dst.webm', 0, 5.0, false, false, 0, {}, null, VP9);
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('copy'));
  assert.ok(!args.includes('libvpx-vp9'), 're-encoding a webm that already fits is wasted work');
});

test('a VP9 source with aac audio cannot be copied into a webm either', () => {
  const args = buildTrimArgs('src.mkv', 'dst.webm', 0, 5.0, false, false, 0, {}, null,
    { video: 'vp9', audio: 'aac' });
  assert.ok(!args.includes('copy'), 'webm takes Vorbis or Opus, not aac');
  assert.ok(args.includes('libopus'));
});

test('a silent VP9 source copies into webm, having no audio to be wrong about', () => {
  const args = buildTrimArgs('src.webm', 'dst.webm', 0, 5.0, false, false, 0, {}, null,
    { video: 'vp9', audio: '' });
  assert.ok(args.includes('copy'));
});

test('dropping the audio lets a VP9 source with aac copy into webm after all', () => {
  const args = buildTrimArgs('src.mkv', 'dst.webm', 0, 5.0, false, false, 0,
    { enabled: false }, null, { video: 'vp9', audio: 'aac' });
  assert.ok(args.includes('copy'), 'the offending stream is not in the output');
  assert.ok(args.includes('-an'));
});

test('a crop into webm still forces the encode, as it does for mp4', () => {
  const args = buildTrimArgs('src.webm', 'dst.webm', 0, 5.0, false, false, 0, {},
    { x: 0, y: 0, width: 640, height: 360, sourceWidth: 1280, sourceHeight: 720 }, VP9);
  assert.ok(args.includes('libvpx-vp9'), 'a filtered stream cannot be copied');
  assert.ok(args.includes('libopus'), 'and its partner goes with it');
});

test('unknown source codecs fall back to encoding rather than a failed copy', () => {
  // An older cached descriptor has no codec fields on it at all.
  const args = buildTrimArgs('src.mp4', 'dst.webm', 0, 5.0, false, false);
  assert.ok(args.includes('libvpx-vp9'));
  assert.ok(!args.includes('copy'));
});

test('an ordinary mp4 cut is exactly what it always was', () => {
  const args = buildTrimArgs('src.mp4', 'dst.mp4', 1.0, 5.0, false, false, 25, { volume: 100 },
    null, H264);
  assert.ok(args.includes('copy'));
  assert.ok(args.includes('-movflags'));
  assert.ok(!args.includes('libvpx-vp9'));
});

test('a webm source saved as mp4 copies, but a vp8 one cannot', () => {
  // mp4 takes vp9 but not vp8, and this is the same trap the mp3 path had:
  // the copy does not degrade, it fails at the header.
  const vp9 = buildTrimArgs('s.webm', 'd.mp4', 0, 5.0, false, false, null, {}, null, VP9);
  assert.ok(vp9.includes('copy'));
  const vp8 = buildTrimArgs('s.webm', 'd.mp4', 0, 5.0, false, false, null, {}, null,
    { video: 'vp8', audio: 'vorbis' });
  assert.ok(!vp8.includes('copy'));
  assert.ok(vp8.includes('libx264'));
});

// --- audio output formats ---------------------------------------------------

const argOf = (args, flag) => args[args.indexOf(flag) + 1];
const audioArgs = (dst, compression, codecs) =>
  buildTrimArgs('src.wav', dst, 0, 5.0, true, false, compression, {}, null,
    codecs || { audio: 'pcm_s16le' });

test('each audio format is written with its own encoder', () => {
  assert.ok(audioArgs('d.mp3', 0).includes('libmp3lame'));
  assert.ok(audioArgs('d.wav', null, { audio: 'mp3' }).includes('pcm_s16le'));
  assert.ok(audioArgs('d.ogg', 0).includes('libvorbis'));
  assert.ok(audioArgs('d.aac', 0).includes('aac'));
  assert.ok(audioArgs('d.flac', 0).includes('flac'));
});

test('the mp3 steps are the bitrates the slider names', () => {
  assert.deepEqual([0, 25, 50, 75].map((p) => argOf(audioArgs('d.mp3', p), '-b:a')),
    ['320k', '192k', '128k', '64k']);
});

test('vorbis takes a quality and flac an effort level, not a bitrate', () => {
  assert.deepEqual([0, 25, 50, 75].map((p) => argOf(audioArgs('d.ogg', p), '-q:a')),
    ['8', '6', '4', '2']);
  assert.deepEqual(
    [0, 25, 50, 75].map((p) => argOf(audioArgs('d.flac', p), '-compression_level')),
    ['0', '5', '8', '12']);
});

test('wav has no knob to turn, whatever the slider says', () => {
  for (const p of [null, 0, 25, 50, 75]) {
    const args = audioArgs('d.wav', p, { audio: 'mp3' });
    assert.ok(args.includes('pcm_s16le'), 'at ' + p);
    assert.ok(!args.includes('-b:a'), 'no bitrate at ' + p);
    assert.ok(!args.includes('-q:a'), 'no quality at ' + p);
  }
});

test('compression being on is what forces an audio encode', () => {
  // Same source, same format: the only difference is the checkbox.
  const off = audioArgs('d.wav', null, { audio: 'pcm_s16le' });
  assert.ok(off.includes('copy'), 'nothing asked for, so nothing done');
  const on = audioArgs('d.wav', 75, { audio: 'pcm_s16le' });
  assert.ok(!on.includes('copy'));
  assert.ok(on.includes('pcm_s16le'));
});

test('an audio cut never carries the mp4 flags', () => {
  for (const f of ['mp3', 'wav', 'ogg', 'aac', 'flac']) {
    const args = audioArgs('d.' + f, 25);
    assert.ok(!args.includes('-movflags'), f);
    assert.ok(!args.includes('libx264'), f);
  }
});

test('mov is written like mp4, not like webm', () => {
  const mov = buildTrimArgs('s.mp4', 'd.mov', 0, 5.0, false, true, 0, {}, null, H264);
  assert.ok(mov.includes('libx264'));
  assert.ok(mov.includes('aac'));
  assert.ok(mov.includes('-movflags'), 'mov carries a moov atom too');
  assert.ok(!mov.includes('libvpx-vp9'));
});

test('a vp9 source cannot be copied into a mov, though mp4 would take it', () => {
  const mov = buildTrimArgs('s.webm', 'd.mov', 0, 5.0, false, false, null, {}, null, VP9);
  assert.ok(!mov.includes('copy'));
  assert.ok(mov.includes('libx264'));
  const mp4 = buildTrimArgs('s.webm', 'd.mp4', 0, 5.0, false, false, null, {}, null, VP9);
  assert.ok(mp4.includes('copy'));
});

// --- the picture switch ------------------------------------------------------

const OFF = { enabled: false };
const noVideo = (dst, opts) => buildTrimArgs('src.mp4', dst, 0, 5.0, false,
  (opts || {}).accurate === true, (opts || {}).compression ?? null,
  (opts || {}).audio || {}, (opts || {}).crop || null, H264, OFF);

test('switching the picture off makes it an audio cut', () => {
  const args = noVideo('d.mp3');
  assert.ok(args.includes('-vn'), 'the video stream has to be dropped, not carried');
  assert.ok(args.includes('libmp3lame'));
  assert.ok(!args.includes('libx264'));
  assert.ok(!args.includes('-movflags'), 'an mp3 carries no moov atom');
});

test('it reads the destination as an audio format, not a video one', () => {
  // The same name means different things depending on what is being written.
  assert.ok(noVideo('d.flac').includes('flac'));
  assert.ok(noVideo('d.wav').includes('pcm_s16le'));
  assert.ok(noVideo('d.ogg').includes('libvorbis'));
});

test('a crop is dropped along with the picture it was cutting', () => {
  const args = noVideo('d.mp3', {
    crop: { x: 0, y: 0, width: 640, height: 360, sourceWidth: 1280, sourceHeight: 720 },
  });
  assert.ok(!args.includes('-vf'), 'nothing left to crop');
  assert.ok(!args.some((a) => String(a).startsWith('crop=')));
});

test('the compression slider switches to the audio scale with it', () => {
  const bitrate = (pct) => {
    const args = noVideo('d.mp3', { compression: pct });
    return args[args.indexOf('-b:a') + 1];
  };
  assert.deepEqual([0, 25, 50, 75].map(bitrate), ['320k', '192k', '128k', '64k']);
  assert.ok(!noVideo('d.mp3', { compression: 75 }).includes('-crf'), 'no video to rate');
});

test('the picture stays unless it is actually switched off', () => {
  for (const v of [undefined, {}, { enabled: true }]) {
    const args = buildTrimArgs('src.mp4', 'd.mp4', 0, 5.0, false, true, null, {}, null, H264, v);
    assert.ok(!args.includes('-vn'), JSON.stringify(v));
    assert.ok(args.includes('libx264'), JSON.stringify(v));
  }
});

test('an audio source is unaffected by a switch it does not have', () => {
  const before = buildTrimArgs('s.mp3', 'd.mp3', 0, 5.0, true, false, null, {}, null, MP3);
  const after = buildTrimArgs('s.mp3', 'd.mp3', 0, 5.0, true, false, null, {}, null, MP3, OFF);
  assert.deepEqual(after, before, 'there was never a picture to drop');
  assert.ok(!after.includes('-vn'));
});

test('dropping the picture still keeps the sound', () => {
  const args = noVideo('d.mp3');
  assert.ok(!args.includes('-an'), 'an output with neither stream is not a clip');
});
