'use strict';

// V5.4. What a picture's numbers mean as colours, said once for the export.
//
// A video file holds brightness and two colour differences, and which red,
// green and blue those stand for depends on a matrix the file may name
// (BT.709 for HD, BT.601 for SD, BT.2020) or leave out. The preview is drawn
// by Chromium, which reads the name, and guesses when there is none. The
// export is written by ffmpeg, which reads the name too, but guesses another
// way (always BT.601) and until 5.4 wrote the file in whatever the bottom
// layer happened to be in, with no name at all when that was a picture file.
// Measured 2026-11-19: an export of images alone came out in BT.601 with no
// tag, which every player reads as BT.709: a green of 50,180,80 was shown as
// 40,161,76.
//
// So the export now always writes BT.709 in TV range and says so in the file
// (OUTPUT_TAGS and OUTPUT_FILTER; ffmpeg converts whatever reaches the end of
// the graph in another matrix or range), and a source the preview does not
// take at its word is given the matrix the preview reads it in (headFilters),
// so both read it alike.
//
// What the preview does is Chromium's doing, measured in the app (Chrome 130,
// Electron 33) on H.264 and VP9 of several sizes holding known colours, drawn
// on a 2D canvas and through a WebGL texture, both the same:
//
//   H.264 naming its matrix, its primaries and its transfer   as it says
//   H.264 naming fewer than all three, or nothing             by its height:
//       720 lines or more BT.709, fewer BT.601, whatever
//       matrix it does name
//   VP9 naming its matrix                                     as it says
//   VP9 naming none                                           BT.601
//
// The second line is the surprising one: a 720p file tagged BT.601 and
// nothing else is shown as BT.709. ffmpeg would believe the tag, so there the
// export is told to read the file the preview's way. Other codecs are taken
// to behave like H.264, which is the general rule in Chromium's source and
// VP9 the exception.
//
// HDR (a transfer of HLG or PQ, what a phone films in) is a case of its own.
// The preview draws every video through a 2D canvas, and the canvas brings
// HDR down to SDR; ffmpeg changed nothing, so the export of an HDR clip was
// some 20 of 255 off the preview all over, and from 5.4 on, named BT.709,
// would have been flat and grey in every player. What the canvas does was
// measured on a grid of 35,937 colours covering every signal value, for HLG
// and for PQ (with and without mastering metadata, which changed nothing),
// and it is plain arithmetic, fitted to a mean of 0.3 of 255:
//
//   the signal made linear light (the HLG or PQ curve backwards),
//   scaled so that reference white is 1: HLG's 75% signal, PQ's 206.5 nits,
//   BT.2020's red, green and blue made BT.709's, each cut off at 0 and 1,
//   and written with the sRGB curve.
//
// Nothing is rolled off: what is brighter than white is white. That is what
// the preview shows, so it is what the export writes (hdrToSdr). The export
// does it with a table of the whole sum (hdrCube, a .cube file for lut3d)
// laid on the picture as its very first step, in red, green and blue at 10
// bits.
//
// Not covered: a file whose transfer or primaries are something else again
// (PAL's gamma 2.8, wide gamut SDR). The canvas corrects for those and ffmpeg
// does not (measured on a full PAL tag: up to 50 of 255).

/** The flags that make the written file BT.709 in TV range. */
const OUTPUT_TAGS = [
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
];

/**
 * The last filter of the picture, which names its primaries and transfer.
 * The matrix and the range are settled by the flags above (ffmpeg converts to
 * them), but the bundled ffmpeg takes the other two from the frames it is
 * handed and not from the flags, and wrote "unknown" for both without this.
 */
const OUTPUT_FILTER = 'setparams=color_primaries=bt709:color_trc=bt709';

/** BT.601 goes by three names in ffprobe's words, all one matrix. */
function family(word) {
  const w = String(word || '').trim().toLowerCase();
  if (w === 'bt709') return '709';
  if (w === 'smpte170m' || w === 'bt470bg' || w === 'bt601') return '601';
  return w;
}

/** Whether ffprobe's word for a matrix, transfer or primaries names one. */
function named(word) {
  const w = String(word || '').trim().toLowerCase();
  return !!w && w !== 'unknown' && w !== 'unspecified' && w !== 'reserved' && w !== 'n/a';
}

/**
 * The matrix the export has to be told to read a video in, in ffmpeg's word:
 * the one the preview reads it in, where that is not what ffmpeg would make
 * of the file by itself. Null for a file both read alike, and for anything
 * that is no video at all.
 * `info` is what trimmer.probeMedia says of the file.
 */
function assumedMatrix(info) {
  if (!info || !(Number(info.height) > 0)) return null;
  let read;
  if (String(info.videoCodec || '').toLowerCase() === 'vp9') {
    if (named(info.colorSpace)) return null;
    read = 'smpte170m';
  } else {
    if (named(info.colorSpace) && named(info.colorPrimaries) && named(info.colorTransfer)) return null;
    read = Number(info.height) >= 720 ? 'bt709' : 'smpte170m';
  }
  // A matrix it names, and the same one the preview reads it in: ffmpeg
  // believes the tag and nothing needs saying.
  if (named(info.colorSpace) && family(info.colorSpace) === family(read)) return null;
  return read;
}

/** 'hlg' or 'pq' for a video in one of the two HDR transfers, or null. */
function hdrKind(info) {
  if (!info || !(Number(info.height) > 0)) return null;
  const transfer = String(info.colorTransfer || '').trim().toLowerCase();
  if (transfer === 'arib-std-b67') return 'hlg';
  if (transfer === 'smpte2084') return 'pq';
  return null;
}

// ---- HDR to SDR, as the preview's canvas does it ----

const clamp01 = (x) => Math.min(1, Math.max(0, x));

// HLG's curve backwards (ARIB STD-B67): signal to scene light, 0 to 1.
const HLG_A = 0.17883277;
const HLG_B = 1 - 4 * HLG_A;
const HLG_C = 0.5 - HLG_A * Math.log(4 * HLG_A);
function hlgToLinear(signal) {
  const e = clamp01(signal);
  return e <= 0.5 ? e * e / 3 : (Math.exp((e - HLG_C) / HLG_A) + HLG_B) / 12;
}
/** HLG's reference white is its 75% signal. */
const HLG_WHITE = hlgToLinear(0.75);

// PQ's curve backwards (SMPTE ST 2084): signal to nits, 0 to 10000.
const PQ_M1 = 2610 / 16384;
const PQ_M2 = 2523 / 4096 * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = 2413 / 4096 * 32;
const PQ_C3 = 2392 / 4096 * 32;
function pqToNits(signal) {
  const p = Math.pow(clamp01(signal), 1 / PQ_M2);
  return 10000 * Math.pow(Math.max(p - PQ_C1, 0) / (PQ_C2 - PQ_C3 * p), 1 / PQ_M1);
}
/** The nits the preview shows as white. Fitted: 206 to 207 read alike, 203 a little worse. */
const PQ_WHITE = 206.5;

/** BT.2020's red, green and blue as BT.709's, in linear light. */
const BT2020_TO_709 = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
];

function linearToSrgb(light) {
  const l = clamp01(light);
  return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

/**
 * One HDR colour as the preview shows it: `rgb` the BT.2020 signal, each of
 * its three 0 to 1, the answer SDR red, green and blue, 0 to 1.
 */
function hdrToSdr(kind, rgb) {
  const lin = kind === 'pq'
    ? rgb.map((e) => pqToNits(e) / PQ_WHITE)
    : rgb.map((e) => hlgToLinear(e) / HLG_WHITE);
  return BT2020_TO_709.map((row) => linearToSrgb(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]));
}

/** How many steps a side the table has. 65 is what colour tools write. */
const HDR_CUBE_SIZE = 65;

/**
 * The whole of hdrToSdr as a .cube file's text, red running fastest, which
 * is the order the format is in.
 */
function hdrCube(kind, size = HDR_CUBE_SIZE) {
  const n = Math.max(2, Math.round(size));
  const lines = ['TITLE "LWClipper ' + (kind === 'pq' ? 'PQ' : 'HLG') + ' to SDR"', 'LUT_3D_SIZE ' + n];
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) {
        const out = hdrToSdr(kind, [r / (n - 1), g / (n - 1), b / (n - 1)]);
        lines.push(out[0].toFixed(5) + ' ' + out[1].toFixed(5) + ' ' + out[2].toFixed(5));
      }
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * What the export has to know of a source's colours: `{ assume, hdr }`, the
 * matrix to read it in where the preview does not take it at its word, and
 * 'hlg' or 'pq' for an HDR one. `lut`, the table's file, is added by the
 * export once it has written it (composer.render).
 */
//
// And `convert`, for a video that is not already BT.709 in TV range: the
// export brings it there itself as its first step, with the scaler told to
// round and to work the colour at full size. Left to ffmpeg, which puts a
// conversion in wherever two parts of the graph disagree, a BT.601 picture
// came out darker by 2 of 255 on red, 1.7 on green and 1.5 on blue all over
// (measured on a photograph, 2026-11-19); said like this it is within 0.1.
// A JPEG is the same case, being BT.601 at full range inside: `still: true`
// asks for it to be made red, green and blue the same careful way (`rgb`).
function describe(info, { still = false } = {}) {
  if (still) {
    return { assume: null, hdr: null, rgb: /^yuv/i.test(String((info && info.pixFmt) || '')) };
  }
  const hdr = hdrKind(info);
  // An HDR file that names no matrix is BT.2020; nothing else is filmed in HLG or PQ.
  const assume = hdr ? (named(info.colorSpace) ? null : 'bt2020nc') : assumedMatrix(info);
  let convert = null;
  if (!hdr && info && Number(info.height) > 0) {
    const matrix = family(assume || info.colorSpace);
    const full = /^(pc|jpeg|full)$/i.test(String(info.colorRange || '')) || /^yuvj/i.test(String(info.pixFmt || ''));
    // Only from a matrix the scaler knows: BT.601 and BT.2020. Anything
    // rarer is left to ffmpeg as before.
    const known = matrix === '601' || matrix === 'bt2020nc' || matrix === 'bt2020ncl';
    if (known || (full && (matrix === '709' || known))) {
      // A full range picture in one of the old "j" formats has to leave them, or it stays full range by name.
      const format = /^yuvj/i.test(String(info.pixFmt || '')) ? String(info.pixFmt).replace(/^yuvj/i, 'yuv') : null;
      convert = { format };
    }
  }
  return { assume, hdr, convert };
}

/** The scaler told to round, and to convert colour at the picture's full size. */
const CAREFUL = 'flags=accurate_rnd+full_chroma_int+full_chroma_inp';
const NAMED_709 = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';

/**
 * The filters a source's picture goes through first, before anything reads
 * its colours: none for one that needs nothing said.
 */
function headFilters(source, filterPath = (p) => p) {
  const colour = source && source.colour;
  if (!colour) return [];
  if (colour.rgb) return ['scale=' + CAREFUL, 'format=gbrp'];
  const said = colour.assume ? ['setparams=colorspace=' + colour.assume] : [];
  if (colour.convert) {
    said.push('scale=' + CAREFUL + ':out_color_matrix=bt709:out_range=tv');
    if (colour.convert.format) said.push('format=' + colour.convert.format);
    said.push(NAMED_709);
  }
  // HDR: to red, green and blue at 10 bits with the scaler told to round, the
  // table, and back to what a 10 bit BT.709 file would have handed over, named
  // as that. Left in red, green and blue, a VFX after it read 2 to 3 of 255
  // off the preview all over (measured): what follows converts by the names
  // on the frames, and those were still the HDR file's.
  if (colour.hdr && colour.lut) {
    said.push('scale=flags=accurate_rnd', 'format=gbrp10le',
      'lut3d=file=' + filterPath(colour.lut) + ':interp=tetrahedral',
      'scale=flags=accurate_rnd:out_color_matrix=bt709:out_range=tv', 'format=yuv420p10le',
      'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv');
  }
  return said;
}

module.exports = {
  OUTPUT_TAGS, OUTPUT_FILTER, named, assumedMatrix, describe, headFilters,
  hdrKind, hdrToSdr, hdrCube, HDR_CUBE_SIZE, hlgToLinear, pqToNits, PQ_WHITE,
};
