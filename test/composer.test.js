'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// composer.js reaches trimmer.js for the codec choices, and trimmer.js requires
// 'electron' via toolPaths.js. Same stub the trimmer tests use.
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const path = require('path');
const { buildComposeArgs, outputSpan, sourceSizes, render } = require('../src/composer');
const timeline = require('../src/timeline');

const HD = { width: 1920, height: 1080, fps: 30 };
const SOURCES = {
  'a.mp4': { width: 1920, height: 1080 },
  'b.mp4': { width: 1920, height: 1080 },
  'tall.mp4': { width: 1080, height: 1920 },
  'music.mp3': { width: 0, height: 0 },
};

function vid(props) {
  return timeline.createLayer({ type: 'video', src: 'a.mp4', sourceDuration: 60, ...props });
}
function aud(props) {
  return timeline.createLayer({ type: 'audio', src: 'music.mp3', sourceDuration: 60, ...props });
}

// The graph arrives as one long -filter_complex value. Tests read it as the
// list of statements it is.
function graphOf(args) {
  const i = args.indexOf('-filter_complex');
  assert.notEqual(i, -1, 'there is always a filter graph');
  return args[i + 1].split(';');
}
function find(graph, needle) {
  return graph.filter((s) => s.includes(needle));
}

test('each layer becomes one input, seeked and limited before it is decoded', () => {
  const layers = [vid({ id: 'v', sourceIn: 12, duration: 8, start: 0 })];
  const args = buildComposeArgs({ layers, project: HD, output: 'out.mp4', sources: SOURCES });
  const i = args.indexOf('-i');
  // -ss before -i seeks rather than decoding and discarding, which is the whole
  // reason the trim is an input option and not a filter.
  assert.deepEqual(args.slice(i - 4, i + 2), ['-ss', '12.0', '-t', '8.0', '-i', 'a.mp4']);
});

test('a single video layer is composited onto a black frame of the project size', () => {
  const layers = [vid({ id: 'v', duration: 10 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.equal(graph[0], 'color=c=black:s=1920x1080:r=30:d=10.0[base]');
  assert.ok(find(graph, 'overlay=0:0').length === 1);
});

test('overlay carries both guards against painting a layer outside its window', () => {
  // Measured, not assumed: without these a layer that ends at 6s is still
  // painted at 8s, because overlay repeats its last frame once its input ends.
  const layers = [vid({ id: 'v', start: 3, duration: 3 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const ov = find(graph, 'overlay=')[0];
  assert.ok(ov.includes('eof_action=pass'));
  assert.ok(ov.includes("enable='gte(t,3.0)*lt(t,6.0)'"),
    'half open, matching timeline.covers(), so abutting layers do not overlap by a frame');
});

test('video layers are composited back to front, so Video 1 lands on top', () => {
  const layers = [
    vid({ id: 'top', src: 'a.mp4', duration: 10 }),
    vid({ id: 'bottom', src: 'b.mp4', duration: 10 }),
  ];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  // Input 1 is the bottom layer and is drawn first, onto the base. Input 0 is
  // Video 1 and goes on last.
  assert.ok(graph.some((s) => s.startsWith('[1:v]') && s.endsWith('[v0]')));
  assert.ok(graph.some((s) => s === graph.find((g) => g.startsWith('[base][v0]overlay'))));
  assert.ok(graph.some((s) => s.startsWith('[0:v]') && s.endsWith('[v1]')));
  assert.ok(graph.some((s) => s.startsWith('[bg0][v1]overlay')));
});

test('the placement in the graph is the one geometry worked out', () => {
  // A 9:16 source in a 16:9 project is pillarboxed at x=656, which is exactly
  // what the geometry tests assert. The encoder must not decide this for itself.
  const layers = [vid({ id: 'v', src: 'tall.mp4', duration: 10 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.ok(find(graph, 'scale=608:1080').length === 1);
  assert.ok(find(graph, 'overlay=656:0').length === 1);
});

test('a cropped layer crops before it scales', () => {
  const layers = [vid({ id: 'v', duration: 10, crop: { x: 100, y: 50, width: 960, height: 540 } })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const line = find(graph, 'crop=')[0];
  assert.ok(line.indexOf('crop=960:540:100:50') < line.indexOf('scale=1920:1080'),
    'cropping first means the scaler has less to do');
  assert.ok(line.indexOf('fps=30') < line.indexOf('crop='),
    'dropping frames first means no work is done on frames about to be thrown away');
});

test('a disabled layer contributes no input and no filter', () => {
  const layers = [
    vid({ id: 'on', src: 'a.mp4', duration: 10 }),
    vid({ id: 'off', src: 'b.mp4', duration: 10, enabled: false }),
  ];
  const args = buildComposeArgs({ layers, project: HD, output: 'out.mp4', sources: SOURCES });
  assert.ok(!args.includes('b.mp4'), 'a muted layer is not even opened');
  assert.equal(graphOf(args).filter((s) => s.includes('overlay=')).length, 1);
});

test('an audio layer is delayed into place and never has its timestamps reset afterwards', () => {
  const layers = [aud({ id: 'a', start: 5, duration: 10 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const line = find(graph, 'adelay')[0];
  assert.ok(line.includes('adelay=5000:all=1'));
  assert.ok(line.indexOf('asetpts=PTS-STARTPTS') < line.indexOf('adelay='),
    'resetting the timestamps after the delay would undo it');
});

test('an audio layer at the start is not delayed at all', () => {
  const layers = [aud({ id: 'a', start: 0, duration: 10 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.equal(find(graph, 'adelay').length, 0);
});

test('per-layer volume is applied, and left out when it changes nothing', () => {
  const loud = graphOf(buildComposeArgs({
    layers: [aud({ id: 'a', duration: 10, volume: 0.5 })],
    project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.equal(find(loud, 'volume=0.5').length, 1);

  const plain = graphOf(buildComposeArgs({
    layers: [aud({ id: 'a', duration: 10 })],
    project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.equal(find(plain, 'volume=').length, 0);
});

test('several audio layers are mixed without being quietened', () => {
  const layers = [aud({ id: 'a', src: 'music.mp3', duration: 10 }),
    aud({ id: 'b', src: 'music.mp3', duration: 10 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const mix = find(graph, 'amix=')[0];
  assert.ok(mix.startsWith('[a0][a1]amix=inputs=2'));
  assert.ok(mix.includes('normalize=0'),
    'amix divides by its input count by default, so every layer would fade as the project grew');
});

test('a lone audio layer is not put through a mixer', () => {
  const graph = graphOf(buildComposeArgs({
    layers: [aud({ id: 'a', duration: 10 })],
    project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.equal(find(graph, 'amix=').length, 0);
});

test('audio is padded to the length of the picture before it is cut', () => {
  // A ten second video with four seconds of sound must not produce a file whose
  // two streams disagree about how long it is.
  const layers = [vid({ id: 'v', duration: 10 }), aud({ id: 'a', duration: 4 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const line = find(graph, 'apad')[0];
  assert.ok(line.includes('apad=whole_dur=10.0'));
  assert.ok(line.indexOf('apad') < line.indexOf('atrim'));
});

test('no audio layers means no audio track, and no video layers means no video track', () => {
  const silent = buildComposeArgs({
    layers: [vid({ id: 'v', duration: 10 })], project: HD, output: 'out.mp4', sources: SOURCES,
  });
  assert.ok(silent.includes('-an'));
  assert.ok(silent.includes('libx264'));

  const blind = buildComposeArgs({
    layers: [aud({ id: 'a', duration: 10 })], project: HD, output: 'out.mp3',
    format: 'mp3', sources: SOURCES,
  });
  assert.ok(blind.includes('-vn'));
  assert.ok(!blind.includes('libx264'));
  assert.ok(blind.includes('libmp3lame'),
    'an audio-only output wants its container codec, not the aac that rides inside an mp4');
});

test('the trim markers cut the finished timeline, not the layers', () => {
  const layers = [vid({ id: 'v', duration: 30 })];
  const args = buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES, trim: { start: 5, end: 12 },
  });
  const graph = graphOf(args);
  assert.ok(find(graph, 'trim=start=5.0:end=12.0')[0].includes('setpts=PTS-STARTPTS'),
    'the cut section has to start at zero in the output');
  const t = args.lastIndexOf('-t');
  assert.equal(args[t + 1], '7.0');
  // The layer itself is still read whole: trimming the output must not change
  // what any layer shows.
  assert.deepEqual(args.slice(args.indexOf('-i') - 4, args.indexOf('-i')), ['-ss', '0.0', '-t', '30.0']);
});

test('trimming past the end of the content is clamped to it', () => {
  const layers = [vid({ id: 'v', duration: 10 })];
  assert.deepEqual(outputSpan(layers, { start: 2, end: 999 }), { start: 2, end: 10, duration: 8 });
  assert.deepEqual(outputSpan(layers, null), { start: 0, end: 10, duration: 10 });
});

test('no number ever reaches ffmpeg in exponential notation', () => {
  // String(0.0000005) is "5e-7", which ffmpeg reads as something else entirely.
  const layers = [vid({ id: 'v', start: 0.0000005, duration: 10, sourceIn: 0.0000005 })];
  const args = buildComposeArgs({ layers, project: HD, output: 'out.mp4', sources: SOURCES });
  for (const a of args) {
    assert.ok(!/\de[-+]\d/.test(String(a)), 'exponential notation in: ' + a);
  }
});

test('a layer whose source could not be probed still produces a usable graph', () => {
  // Better a layer placed at the top left than a crash in the middle of a
  // render the user has been waiting on.
  const layers = [vid({ id: 'v', src: 'unknown.mp4', duration: 10 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.ok(find(graph, 'overlay=0:0').length === 1);
});

// ---- Step 15: what it takes to actually run one ----

test('the argv asks for progress on stdout, and the output is still last', () => {
  const layers = [vid({ id: 'v', duration: 10 })];
  const args = buildComposeArgs({ layers, project: HD, output: 'out.mp4', sources: SOURCES });
  assert.deepEqual(args.slice(-4), ['-progress', 'pipe:1', '-nostats', 'out.mp4']);
  // Errors only, so anything that does reach stderr is worth reporting.
  assert.deepEqual(args.slice(0, 5), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y']);
});

test('the source sizes come from what the layers were probed at', () => {
  const layers = [
    vid({ id: 'v', src: 'a.mp4', sourceWidth: 1920, sourceHeight: 1080 }),
    aud({ id: 'a', src: 'music.mp3' }),
  ];
  assert.deepEqual(sourceSizes(layers), { 'a.mp4': { width: 1920, height: 1080 } });
});

test('two layers of one file ask about it once', () => {
  let asked = 0;
  const layers = [
    vid({ id: 'v', src: 'a.mp4' }),
    aud({ id: 'a', src: 'a.mp4' }),
  ];
  sourceSizes(layers, (p) => { asked += 1; return { width: 1920, height: 1080, path: p }; });
  assert.equal(asked, 1);
});

test('a layer written before the sizes were saved is probed, and only that one', () => {
  const probed = [];
  const layers = [
    vid({ id: 'old', src: 'old.mp4' }),
    vid({ id: 'new', src: 'a.mp4', sourceWidth: 1920, sourceHeight: 1080 }),
  ];
  const sizes = sourceSizes(layers, (p) => {
    probed.push(p);
    return { width: 1280, height: 720 };
  });
  assert.deepEqual(probed, ['old.mp4']);
  assert.deepEqual(sizes['old.mp4'], { width: 1280, height: 720 });
});

test('with no way to probe, an unmeasured layer is simply left out', () => {
  // buildComposeArgs already places a layer with no source size at the top
  // left rather than crashing, which is the test above this block.
  assert.deepEqual(sourceSizes([vid({ id: 'v', src: 'old.mp4' })]), {});
});

test('a render refuses to write over a file it is reading from', async () => {
  // It would truncate the source before ffmpeg had finished with it, which
  // loses the file rather than producing a bad export.
  const layers = [vid({ id: 'v', src: path.resolve('a.mp4'), duration: 10 })];
  await assert.rejects(
    () => render({ layers, project: HD, output: 'A.MP4', sources: SOURCES }),
    /not one of the files on the timeline/);
});

test('a render of nothing says so rather than running ffmpeg on an empty graph', async () => {
  await assert.rejects(
    () => render({ layers: [], project: HD, output: 'out.mp4' }),
    /nothing on the timeline/);
  const off = [vid({ id: 'v', duration: 10, enabled: false })];
  await assert.rejects(
    () => render({ layers: off, project: HD, output: 'out.mp4', sources: SOURCES }),
    /nothing on the timeline/);
});

test('a range too short to hold a frame is refused before anything is spawned', async () => {
  const layers = [vid({ id: 'v', duration: 10 })];
  await assert.rejects(
    () => render({
      layers, project: HD, output: 'out.mp4', sources: SOURCES,
      trim: { start: 4, end: 4.01 },
    }),
    /range is empty/);
});

// ---- V2.2, 22a. Fades in the graph ----

test('a video fade fades the alpha, so the layer under it is revealed', () => {
  // Not fade=t=in on its own: that fades to black, which on a layer sitting
  // over another one paints black across it for the length of the fade. This
  // is the crossfade falling out of overlap, and it is what the user asked for.
  const layers = [vid({ id: 'v', duration: 10, start: 4, fadeIn: 2, fadeOut: 3 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const chain = find(graph, 'fade=')[0];
  assert.ok(chain.includes('format=yuva420p'),
    'there is an alpha channel to fade at all: ' + chain);
  assert.ok(chain.includes('fade=t=in:st=4.0:d=2.0:alpha=1'), chain);
  // 4 + 10 - 3, which is where the ramp down begins.
  assert.ok(chain.includes('fade=t=out:st=11.0:d=3.0:alpha=1'), chain);
});

test('a layer alpha under 1 is multiplied in after the fades', () => {
  // The order is the whole point. colorchannelmixer multiplies the alpha it is
  // handed, so standing after the fade filters it is the ceiling they rise to.
  // In front of them it would be overwritten by the first one and the layer
  // would fade in to fully opaque.
  const layers = [vid({ id: 'v', duration: 10, start: 0, fadeIn: 2, alpha: 0.6 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const chain = find(graph, 'colorchannelmixer')[0];
  assert.ok(chain.includes('colorchannelmixer=aa=0.6'), chain);
  assert.ok(chain.indexOf('fade=t=in') < chain.indexOf('colorchannelmixer'),
    'the ceiling came before the ramp it is meant to cap: ' + chain);
});

test('an alpha alone brings the alpha channel with it', () => {
  // Without format=yuva420p there is no alpha plane for colorchannelmixer to
  // scale, and a layer set to 40% would come out solid.
  const layers = [vid({ id: 'v', duration: 10, alpha: 0.4 })];
  const chain = find(graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  })), 'colorchannelmixer')[0];
  assert.ok(chain.includes('format=yuva420p'), chain);
  assert.ok(chain.indexOf('format=yuva420p') < chain.indexOf('colorchannelmixer'), chain);
});

test('an alpha of zero is still written, rather than read as nothing set', () => {
  // 0 is falsy, and a layer the user has pulled all the way down is not a layer
  // that has been left alone.
  const layers = [vid({ id: 'v', duration: 10, alpha: 0 })];
  const chain = find(graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  })), 'colorchannelmixer')[0];
  assert.ok(chain.includes('colorchannelmixer=aa=0.0'), chain);
});

test('a layer at full alpha carries no mixer and no conversion', () => {
  // The common case, and it has to cost nothing: an alpha channel and a matrix
  // multiply on every frame of every project to arrive back where it started.
  const layers = [vid({ id: 'v', duration: 10 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.equal(find(graph, 'colorchannelmixer').length, 0);
  assert.equal(find(graph, 'yuva420p').length, 0);
});

test('an audio layer takes no alpha, because a sound has none', () => {
  // alpha is a thing about a picture. The sound side has the layer's volume and
  // its fades and nothing else, and a silent 40% layer is not what anyone means
  // by a translucent one.
  const layers = [aud({ id: 'a', duration: 10, alpha: 0.5 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.m4a', sources: SOURCES,
  }));
  assert.equal(find(graph, 'colorchannelmixer').length, 0);
});

test('the video fade is measured after the timestamps have been shifted', () => {
  // st is in timeline seconds here, and only the setpts makes the layer's
  // timestamps its timeline positions, so the order in the chain is the
  // difference between a fade at the right moment and one four seconds early.
  const layers = [vid({ id: 'v', duration: 10, start: 4, fadeIn: 2 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const chain = find(graph, 'fade=')[0];
  assert.ok(chain.indexOf('setpts=') < chain.indexOf('fade=t=in'),
    'the fade came before the shift it is measured against: ' + chain);
});

test('a layer with no fade carries no alpha conversion', () => {
  // An alpha channel on every layer would be a conversion on every frame of
  // every project for nothing.
  const layers = [vid({ id: 'v', duration: 10 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.equal(find(graph, 'yuva420p').length, 0);
  assert.equal(find(graph, 'fade=').length, 0);
});

test('an audio fade is measured before the delay, in the layer own time', () => {
  // The opposite placement to the video, because adelay has to stay last and
  // nothing may reset the timestamps after it. So st is layer-relative here:
  // a fade in starts at 0 however far along the timeline the layer sits.
  const layers = [aud({ id: 'a', duration: 8, start: 5, fadeIn: 1, fadeOut: 2 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  const chain = find(graph, 'afade')[0];
  assert.ok(chain.includes('afade=t=in:st=0.0:d=1.0'), chain);
  // 8 - 2, in the layer's own timebase rather than 5 + 8 - 2.
  assert.ok(chain.includes('afade=t=out:st=6.0:d=2.0'), chain);
  assert.ok(chain.indexOf('afade') < chain.indexOf('adelay'),
    'the delay is still last: ' + chain);
});

test('a fade longer than its layer is cut to the layer, not written out whole', () => {
  const layers = [vid({ id: 'v', duration: 3, start: 0, fadeIn: 99 })];
  const graph = graphOf(buildComposeArgs({
    layers, project: HD, output: 'out.mp4', sources: SOURCES,
  }));
  assert.ok(find(graph, 'fade=')[0].includes('fade=t=in:st=0.0:d=3.0:alpha=1'),
    find(graph, 'fade=')[0]);
});

// --- V2.3, a still as an input ----------------------------------------------

function still(props) {
  return timeline.createLayer({
    type: 'video', kind: 'image', src: 'shot.png', sourceDuration: 10, ...props,
  });
}

const IMG_SOURCES = { ...SOURCES, 'shot.png': { width: 1600, height: 900 } };

/**
 * The input flags for one file, as the argument list holds them.
 *
 * The inputs are runs of flags each ending in "-i <file>", after the five
 * global flags the command opens with. Walked rather than searched backwards
 * from the filename, which cannot tell the first input's own flags from the
 * preamble in front of them.
 */
function inputFor(args, src) {
  assert.equal(args[0], '-hide_banner', 'the preamble moved: ' + args.slice(0, 6).join(' '));
  let run = [];
  for (let i = 5; i < args.length; i += 1) {
    if (args[i] !== '-i') {
      run.push(args[i]);
      continue;
    }
    if (args[i + 1] === src) return run;
    run = [];
    i += 1;
  }
  assert.fail(src + ' is not an input: ' + args.join(' '));
  return null;
}

test('a still is looped for its own length rather than seeked into', () => {
  const args = buildComposeArgs({
    layers: [still({ id: 's', duration: 4 })],
    project: HD, output: 'out.mp4', sources: IMG_SOURCES,
  });
  const flags = inputFor(args, 'shot.png');
  assert.deepEqual(flags, ['-loop', '1', '-framerate', '30', '-t', '4.0']);
  // -ss on a looped image would ask a one frame file to skip past its frame.
  assert.ok(!flags.includes('-ss'), flags.join(' '));
});

test('a still loops at the project rate, not at the demuxer default', () => {
  const args = buildComposeArgs({
    layers: [still({ id: 's', duration: 2 })],
    project: { width: 1920, height: 1080, fps: 60 },
    output: 'out.mp4', sources: IMG_SOURCES,
  });
  assert.deepEqual(inputFor(args, 'shot.png'),
    ['-loop', '1', '-framerate', '60', '-t', '2.0']);
});

test('a still held longer than it opened at is written that long', () => {
  // The whole point of an image layer: its right edge pulls out past where it
  // started, and what comes out has to be that long.
  const args = buildComposeArgs({
    layers: [still({ id: 's', duration: 45 })],
    project: HD, output: 'out.mp4', sources: IMG_SOURCES,
  });
  assert.ok(inputFor(args, 'shot.png').includes('45.0'), args.join(' '));
});

test('a video beside a still keeps being seeked into', () => {
  const args = buildComposeArgs({
    layers: [still({ id: 's', duration: 4 }), vid({ id: 'v', sourceIn: 12, duration: 4 })],
    project: HD, output: 'out.mp4', sources: IMG_SOURCES,
  });
  assert.deepEqual(inputFor(args, 'a.mp4'), ['-ss', '12.0', '-t', '4.0']);
  assert.deepEqual(inputFor(args, 'shot.png'), ['-loop', '1', '-framerate', '30', '-t', '4.0']);
});

test('a still is placed and cropped like any other picture', () => {
  const args = buildComposeArgs({
    layers: [still({ id: 's', duration: 4, crop: { x: 0, y: 0, width: 800, height: 900 } })],
    project: HD, output: 'out.mp4', sources: IMG_SOURCES,
  });
  const graph = graphOf(args);
  assert.ok(find(graph, 'crop=').length, graph.join(';'));
  assert.ok(find(graph, 'overlay=').length, graph.join(';'));
});

test('a still fades like any other picture', () => {
  const args = buildComposeArgs({
    layers: [still({ id: 's', duration: 6, fadeIn: 2 })],
    project: HD, output: 'out.mp4', sources: IMG_SOURCES,
  });
  const chain = find(graphOf(args), 'fade=')[0];
  assert.ok(chain.includes('fade=t=in:st=0.0:d=2.0:alpha=1'), chain);
  assert.ok(chain.includes('yuva420p'), chain);
});
