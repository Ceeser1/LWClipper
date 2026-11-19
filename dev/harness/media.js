'use strict';

// Makes the harness's test media with the bundled ffmpeg, into work/.
//
//   node dev/harness/media.js          (only what is missing)
//   node dev/harness/media.js --all    (everything again)
//
// A file that changed under a running instance keeps its old picture there:
// restart the instance after --all.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { W, FFMPEG } = require('./lib');

const all = process.argv.includes('--all');
fs.mkdirSync(W, { recursive: true });

function ff(args) {
  try {
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    // What ffmpeg said, without the font library's note that it has no config file here.
    const said = String(e.stderr || e.message).split(/\r?\n/).filter((l) => l && !/^Fontconfig error/.test(l));
    throw new Error('ffmpeg could not make it:\n' + said.join('\n'));
  }
}
function make(name, build) {
  const file = W + '/' + name;
  if (!all && fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  build(file);
  console.log('made', name);
}

// The frame number drawn on a clip is what tells a frame from its neighbours.
const COUNTER = "drawtext=text='%{n}':fontsize=80:x=40:y=40:fontcolor=white:box=1:boxcolor=black";
const TAGS709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const NAME709 = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv';
const UNNAMED = 'setparams=colorspace=unknown:color_primaries=unknown:color_trc=unknown:range=unknown';
const bars = (size, seconds) => ['-f', 'lavfi', '-i', 'testsrc2=s=' + size + ':r=30:d=' + seconds];
const x264 = ['-c:v', 'libx264', '-crf', '12'];
const to = (matrix, range = 'tv') => 'scale=out_color_matrix=' + matrix + ':out_range=' + range + ',format=yuv420p';

// ---- the clips the VFX lists run on ----
make('src709.mp4', (f) => ff([...bars('1280x720', 2), '-vf', [COUNTER, to('bt709'), NAME709].join(','), ...x264, f]));
make('g709.mp4', (f) => ff([...bars('1280x720', 5), '-vf', [COUNTER, to('bt709'), NAME709].join(','), ...x264, f]));
// Five seconds of picture and sound, for the editing checks (edit55.js).
make('talk709.mp4', (f) => ff([...bars('1280x720', 5), '-f', 'lavfi', '-i', 'sine=frequency=440:d=5',
  '-vf', [COUNTER, to('bt709'), NAME709].join(','), ...x264, '-c:a', 'aac', f]));
make('long1080.mp4',(f) => ff([...bars('1920x1080', 6), '-f', 'lavfi', '-i', 'sine=frequency=440:d=6',
  '-vf', [COUNTER, to('bt709'), NAME709].join(','), ...x264, '-c:a', 'aac', f]));
// Natural colours: a picture that ships with Windows, slowly zoomed.
make('nat.mp4', (f) => ff(['-loop', '1', '-i', 'C:/Windows/Web/Wallpaper/Theme2/img10.jpg', '-t', '2', '-r', '30',
  '-vf', ["zoompan=z='1+0.001*on':d=1:s=1280x720:fps=30", to('bt709'), NAME709].join(','), ...x264, f]));
// A green screen: the photograph small on plain green.
make('green.mp4', (f) => ff(['-f', 'lavfi', '-i', 'color=c=0x10c020:s=1280x720:r=30:d=2', '-i', W + '/nat.mp4',
  '-filter_complex', '[1:v]scale=560:-2[p];[0:v][p]overlay=360:200,' + COUNTER + ',' + to('bt709') + ',' + NAME709,
  ...x264, f]));
// Something that moves: a bar sliding across, for the kinds that look back in time.
make('moving.mp4', (f) => ff(['-f', 'lavfi', '-i', 'color=c=0x202838:s=1280x720:r=30:d=2',
  '-f', 'lavfi', '-i', 'color=c=0xf0d040:s=120x400:r=30:d=2', '-filter_complex',
  "[0:v][1:v]overlay=x='mod(n*18,1280)':y=160," + [COUNTER, to('bt709'), NAME709].join(','), ...x264, f]));
make('alpha1.png', (f) => ff(['-f', 'lavfi', '-i', 'testsrc2=s=800x600:r=1:d=1', '-frames:v', '1', '-vf',
  "format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,400),255,if(lt(Y,300),90,0))'", f]));

// ---- the same bars as every way a file can say, or not say, its colours ----
make('colour/named709.mp4', (f) => ff([...bars('1280x720', 2), '-vf', [COUNTER, to('bt709'), NAME709].join(','), ...x264, f]));
make('colour/unnamed-hd.mp4', (f) => ff([...bars('1280x720', 2), '-vf', [COUNTER, to('bt709'), UNNAMED].join(','), ...x264, f]));
make('colour/unnamed-sd.mp4', (f) => ff([...bars('854x480', 2), '-vf', [COUNTER, to('bt601'), UNNAMED].join(','), ...x264, f]));
make('colour/matrix601-only-hd.mp4', (f) => ff([...bars('1280x720', 2), '-vf',
  [COUNTER, to('bt601'), 'setparams=colorspace=smpte170m:color_primaries=unknown:color_trc=unknown:range=tv'].join(','), ...x264, f]));
make('colour/named601-hd.mp4', (f) => ff([...bars('1280x720', 2), '-vf',
  [COUNTER, to('bt601'), 'setparams=colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m:range=tv'].join(','), ...x264, f]));
make('colour/full-range.mp4', (f) => ff([...bars('1280x720', 2), '-vf',
  [COUNTER, to('bt709', 'pc'), 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=pc'].join(','), ...x264, f]));
make('colour/unnamed-vp9.webm', (f) => ff([...bars('1280x720', 2), '-vf', [COUNTER, to('bt601'), UNNAMED].join(','),
  '-c:v', 'libvpx-vp9', '-crf', '14', '-b:v', '0', f]));
// HDR as a phone films it: 10 bit HEVC in BT.2020 with HLG or PQ. The photograph's
// numbers are simply read as an HDR signal; what matters is that both sides read it alike.
const hdr = (transfer) => 'scale=out_color_matrix=bt2020nc:out_range=tv,format=yuv420p10le,'
  + 'setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=' + transfer + ':range=tv';
const x265 = ['-c:v', 'libx265', '-crf', '14', '-tag:v', 'hvc1', '-x265-params', 'log-level=error'];
make('colour/hdr-hlg.mp4', (f) => ff(['-i', W + '/nat.mp4', '-vf', hdr('arib-std-b67'), ...x265, f]));
make('colour/hdr-pq.mp4', (f) => ff(['-i', W + '/nat.mp4', '-vf', hdr('smpte2084'), ...x265, f]));
make('colour/sdr-10bit.mp4', (f) => ff(['-i', W + '/nat.mp4', '-vf', 'format=yuv420p10le,' + NAME709, ...x265, f]));
make('colour/photo.png', (f) => ff(['-i', W + '/nat.mp4', '-frames:v', '1', f]));
make('colour/photo.jpg', (f) => ff(['-i', W + '/nat.mp4', '-frames:v', '1', '-q:v', '2', f]));

// ---- colour tables for Apply LUT ----
const look = (r, g, b) => [Math.pow(r, 0.8), g * 0.9 + 0.05, Math.min(1, b * 1.1)];
function cube(n) {
  let s = 'LUT_3D_SIZE ' + n + '\n';
  for (let b = 0; b < n; b += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let r = 0; r < n; r += 1) s += look(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' ') + '\n';
    }
  }
  return s;
}
// A .3dl runs blue fastest and holds whole numbers, here 12 bits.
function threeDl(n, mesh) {
  const lines = mesh
    ? ['3DMESH', 'Mesh ' + Math.round(Math.log2(n - 1)) + ' 12']
    : [Array.from({ length: n }, (_, i) => Math.min(1023, Math.round(i * 1024 / (n - 1)))).join(' ')];
  for (let r = 0; r < n; r += 1) {
    for (let g = 0; g < n; g += 1) {
      for (let b = 0; b < n; b += 1) lines.push(look(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => Math.round(v * 4095)).join(' '));
    }
  }
  if (mesh) lines.push('', 'LUT8', 'gamma 1.0');
  return lines.join('\n') + '\n';
}
make('plain.cube', (f) => fs.writeFileSync(f, cube(17)));
make("lut dir/it's here/look one.cube", (f) => fs.writeFileSync(f, cube(17)));
make('notalut.cube', (f) => fs.writeFileSync(f, 'not a lut\n'));
make('luts/look17.cube', (f) => fs.writeFileSync(f, cube(17)));
make('luts/look17.3dl', (f) => fs.writeFileSync(f, threeDl(17, false)));
make('luts/look33 mesh.3dl', (f) => fs.writeFileSync(f, threeDl(33, true)));
console.log('media ready in dev/harness/work');
