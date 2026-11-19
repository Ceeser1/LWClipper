'use strict';

// Preview against export, case by case, and both against what they were.
//
//   node dev/harness/run.js <suite|all> [filter] [--update]
//
// For each case the project is built in the test instance's window, exported
// for real, and the frames named are pulled out of the file. The preview's own
// drawing of each frame is compared with the export's frame and with the
// frames before and after it: a picture a frame early or late shows as a
// neighbour matching better than the frame itself, and codec noise alone is
// about 0.5 to 2 of 255.
//
// golden.json keeps, for every frame of every case, how far preview and
// export were apart and a small picture of the export's frame (16 by 9 mean
// colours). A run says where either has moved since. --update writes what
// this run measured, for the cases it ran: do that only for a change that
// was meant.
//
// The instance has to be running (instance.js start) and the media made
// (media.js). A change under src/ needs the instance started again, since
// the export runs in the main process.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { connect } = require('./cdp');
const { W, FFMPEG, SUITES } = require('./lib');
const { PAGE } = require('./page');

const args = process.argv.slice(2);
const update = args.includes('--update');
const [suiteArg, filterArg] = args.filter((a) => !a.startsWith('--'));
const only = filterArg ? new RegExp(filterArg) : null;
const GOLDEN = path.join(__dirname, 'golden.json');
const OUT = W + '/out';

/** How far apart counts as having moved: of 255, on the mean difference and on any one cell. */
const MOVED_BY = 0.4;
const CELL_BY = 3;

// Every way a file can say its colours, each with nothing on it, with a
// colour VFX (worked in red, green and blue) and with a blur.
const COLOUR_SOURCES = [
  'named709.mp4', 'unnamed-hd.mp4', 'unnamed-sd.mp4', 'matrix601-only-hd.mp4', 'named601-hd.mp4', 'full-range.mp4',
  'unnamed-vp9.webm', 'hdr-hlg.mp4', 'hdr-pq.mp4', 'sdr-10bit.mp4',
];
const COLOUR_CASES = [
  ['plain', [], [30]],
  ['sepia', [{ kind: 'sepia', shape: 'square', invert: false, box: { x: 0, y: 0, w: 1, h: 1 } }], [30]],
  ['blur-part', [{ kind: 'obscure', shape: 'square', invert: false, box: { x: 0.3, y: 0.25, w: 0.4, h: 0.5 }, strength: 30 }], [30]],
];

function plan() {
  const runs = [];
  const names = suiteArg === 'all' || !suiteArg ? [...Object.keys(SUITES), 'colour'] : [suiteArg];
  for (const name of names) {
    if (name === 'colour') {
      for (const src of COLOUR_SOURCES) {
        runs.push({ suite: 'colour/' + src.replace(/\.\w+$/, ''), src: 'colour/' + src, end: 2, under: 'nat.mp4', cases: COLOUR_CASES });
      }
    } else if (SUITES[name]) {
      runs.push({ suite: name, ...SUITES[name], cases: require('./cases/' + name) });
    } else {
      throw new Error('no such suite: ' + name + ' (there are ' + [...Object.keys(SUITES), 'colour', 'all'].join(', ') + ')');
    }
  }
  return runs;
}

function signature(png) {
  const raw = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', png,
    '-vf', 'scale=16:9:flags=area,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-']);
  return raw.toString('hex');
}
function cellsApart(a, b) {
  if (!a || !b || a.length !== b.length) return 255;
  let worst = 0;
  for (let i = 0; i < a.length; i += 2) {
    worst = Math.max(worst, Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));
  }
  return worst;
}

/** One line a frame, sorted, so a change to it reads as the frames that changed. */
function writeGolden(golden) {
  const sorted = {};
  for (const key of Object.keys(golden).sort()) sorted[key] = golden[key];
  fs.writeFileSync(GOLDEN, JSON.stringify(sorted, null, 0).replace(/\},"/g, '},\n"') + '\n');
}

(async () => {
  const golden = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : {};
  const cdp = await connect();
  await cdp.evaluate(PAGE);
  const tally = { ran: 0, moved: [], fresh: [], failed: [], high: [] };

  for (const run of plan()) {
    const picked = run.cases.filter(([name]) => !only || only.test(name) || only.test(run.suite + '/' + name));
    if (!picked.length) continue;
    const src = W + '/' + run.src;
    if (!fs.existsSync(src)) throw new Error('missing ' + run.src + ': run node dev/harness/media.js');
    const info = await cdp.evaluate('window.__h.setup(' + JSON.stringify(src) + ')');
    if (info && info.error) throw new Error(run.src + ' could not be opened: ' + JSON.stringify(info));
    console.log('== ' + run.suite + '  (' + run.src + ', ' + picked.length + ' cases)');

    for (const [name, vfx, frames, props] of picked) {
      const id = run.suite + '/' + name;
      const dir = OUT + '/' + id;
      const file = dir + '.mp4';
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.rmSync(file, { force: true });
      await cdp.evaluate('window.__h.under(' + JSON.stringify(props && props.under ? W + '/' + run.under : null) + ')');
      await cdp.evaluate('window.__h.setVfx(' + JSON.stringify(vfx) + ',' + JSON.stringify(props || null) + ')');
      let rendered;
      try {
        rendered = await cdp.evaluate('window.__h.render(' + JSON.stringify(file) + ', ' + run.end + ')');
      } catch (err) {
        rendered = { ok: false, error: String(err) };
      }
      if (!rendered.ok) {
        console.log('FAILED ' + name.padEnd(22), String(rendered.error || '').replace(/\s+/g, ' ').slice(0, 200));
        tally.failed.push(id);
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const want = [...new Set(frames.flatMap((n) => [n - 1, n, n + 1]))].filter((n) => n >= 0);
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf',
        "select='" + want.map((n) => 'eq(n\\,' + n + ')').join('+') + "'", '-fps_mode', 'passthrough', '-frame_pts', '1',
        dir + '/f_%d.png']);

      const notes = [];
      let verdict = 'ok';
      for (const n of frames) {
        let c;
        try {
          c = await cdp.evaluate('window.__h.compare(' + n + ',' + JSON.stringify(dir) + ',' + (process.env.WAIT || 450) + ',false)');
        } catch (err) {
          // A frame the file does not have (a case asking past the export's end), or a picture that will not load.
          notes.push(n + ': could not be compared (' + String(err.message || err).split('\n')[0].slice(0, 80) + ')');
          verdict = 'failed';
          break;
        }
        const own = c[0];
        const sig = signature(dir + '/f_' + n + '.png');
        const key = id + '/' + n;
        const was = golden[key];
        // By the frame alone: closer to a neighbour than to itself, or far off whatever the neighbours say.
        const high = !(own <= Math.min(c[-1], c[1]) + 0.05 && own < 3);
        let mark = '';
        if (!was) {
          mark = ' NEW';
          if (verdict === 'ok') verdict = 'new';
        } else if (Math.abs(own - was.own) > MOVED_BY || cellsApart(sig, was.sig) > CELL_BY) {
          mark = ' MOVED (was ' + was.own + ', export ' + cellsApart(sig, was.sig) + ' apart)';
          verdict = 'moved';
        }
        if (high && !tally.high.includes(id)) tally.high.push(id);
        notes.push(n + ': ' + c[-1] + ' [' + own + '] ' + c[1] + (high ? ' high' : '') + mark);
        if (update) golden[key] = { own, sig };
      }
      tally.ran += 1;
      if (verdict === 'moved') tally.moved.push(id);
      if (verdict === 'new') tally.fresh.push(id);
      if (verdict === 'failed') tally.failed.push(id);
      console.log(({ ok: 'ok     ', new: 'new    ', moved: 'MOVED  ', failed: 'FAILED ' })[verdict] + name.padEnd(22),
        String(rendered.ms).padStart(5) + 'ms ', notes.join(' | '));
    }
    // After each suite, so a long run that is stopped keeps what it measured.
    if (update) writeGolden(golden);
  }
  cdp.close();
  console.log('\n' + tally.ran + ' cases ran. Moved: ' + (tally.moved.join(', ') || 'none')
    + '. New: ' + (tally.fresh.length || 'none') + '. Failed: ' + (tally.failed.join(', ') || 'none') + '.');
  if (tally.high.length) {
    console.log('Further apart than codec noise by the frame alone (fine patterns read so; compare with golden): ' + tally.high.length + ' cases.');
  }
  if (update) console.log('golden.json written for the cases that ran.');
  process.exit(tally.moved.length || tally.failed.length || (tally.fresh.length && !update) ? 1 : 0);
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
