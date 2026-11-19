'use strict';

// The editing keys of 5.5 run in the real window: delete and close the gap,
// markers, the steps from edge to edge, duplicate, freeze frame and Open
// recent, each checked against what the window then holds, and the frozen
// frame against the exported file.
//
//   node dev/harness/edit55.js
//
// Needs the instance (instance.js start) and the media (media.js).

const fs = require('fs');
const { execFileSync } = require('child_process');
const { connect } = require('./cdp');
const { W, FFMPEG } = require('./lib');

const SRC = W + '/talk709.mp4';
const OUT = W + '/out/edit55';

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok });
  console.log((ok ? 'ok     ' : 'FAILED ') + name + (ok || detail === undefined ? '' : '   ' + JSON.stringify(detail)));
};

const PAGE = `
window.__e = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  starts() {
    return layers.map((l) => [l.type, l.lane, Math.round(l.start * 1000) / 1000, Math.round(l.duration * 1000) / 1000, l.kind]);
  },
  video() {
    return layers.filter((l) => l.type === 'video').sort((a, b) => a.start - b.start);
  },
  async fresh(src) {
    if (typeof choiceCancelId !== 'undefined' && choiceCancelId) settleChoice(choiceCancelId);
    if (compositePlaying) pauseComposite();
    setLayers([]);
    loadProjectMarkers([]);
    const r = await window.lwclipper.describeMedia(src);
    if (!r || !r.ok) return { error: r };
    addLayerFromMedia('video', r.data, undefined, 0);
    const l = layers.find((x) => x.type === 'video');
    for (let i = 0; i < 100; i++) {
      const e = decoders.get(l.id);
      if (e && e.width) break;
      await this.wait(100);
    }
    commitHistory();
    return { n: layers.length, duration: l.duration };
  },
  // The 5 second clip cut into three: 0 to 1.5, 1.5 to 3, 3 to 5, picture and sound alike.
  cutInThree() {
    selectLayer(this.video()[0].id);
    splitSelected(1.5);
    selectLayer(this.video().find((l) => l.start === 1.5).id);
    splitSelected(3);
    return this.starts();
  },
  async seek(t) {
    seekComposite(t);
    updatePlayhead();
    await this.wait(700);
    return compositeAt;
  },
  flags() {
    return [...document.querySelectorAll('.timeline-flag')].map((f) => ({
      hidden: f.hidden, left: Math.round(parseFloat(f.style.left) || 0), name: f.textContent,
    }));
  },
};
'ready'`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cdp = await connect();
  const run = (code) => cdp.evaluate('(async () => { ' + code + ' })()');
  await cdp.evaluate(PAGE);

  // ---- delete and close the gap ----
  await run('return window.__e.fresh(' + JSON.stringify(SRC) + ')');
  const cut = await run('return window.__e.cutInThree()');
  check('a clip of video and sound is cut into three of each', cut.length === 6, cut);
  let r = await run(`
    selectLayer(window.__e.video()[1].id);
    rippleDeleteSelected();
    await window.__e.wait(100);
    return { starts: window.__e.starts(), undo: undoCounts().undo };`);
  const vids = r.starts.filter((s) => s[0] === 'video');
  const auds = r.starts.filter((s) => s[0] === 'audio');
  check('the middle clip goes with its sound, and what follows closes up', vids.length === 2 && auds.length === 2
    && vids.some((s) => s[2] === 1.5 && s[3] === 2) && auds.some((s) => s[2] === 1.5 && s[3] === 2), r.starts);
  r = await run('undoRedo(false); await window.__e.wait(100); return window.__e.starts();');
  check('one undo puts all of it back', r.length === 6 && r.some((s) => s[0] === 'video' && s[2] === 3), r);

  // ---- markers ----
  r = await run(`
    await window.__e.seek(1.0); toggleMarkerAtPlayhead();
    await window.__e.seek(3.5); toggleMarkerAtPlayhead();
    await window.__e.seek(4.5); toggleMarkerAtPlayhead();
    setProjectMarkers(timelineMarkers.rename(projectMarkers, projectMarkers[1].id, 'Drop'));
    return { markers: projectMarkers.map((m) => [m.t, m.name]), flags: window.__e.flags(), dirty: projectDirty() };`);
  check('M sets a marker at the playhead, three in all, one named', r.markers.length === 3 && r.markers[1][1] === 'Drop', r.markers);
  check('each marker has its flag on the ruler, in order', r.flags.length === 3 && r.flags.every((f) => !f.hidden)
    && r.flags[0].left < r.flags[1].left && r.flags[1].left < r.flags[2].left && r.flags[1].name === 'Drop', r.flags);
  check('a marker is unsaved work', r.dirty === true, r.dirty);
  r = await run(`
    await window.__e.seek(4.5); toggleMarkerAtPlayhead();
    const two = projectMarkers.length;
    undoRedo(false); await window.__e.wait(100);
    return { two, back: projectMarkers.length };`);
  check('M on a marker\'s frame takes it away, and undo brings it back', r.two === 2 && r.back === 3, r);

  // Closing a gap carries the markers after it.
  r = await run(`
    selectLayer(window.__e.video()[1].id);
    rippleDeleteSelected();
    await window.__e.wait(100);
    const after = projectMarkers.map((m) => m.t);
    undoRedo(false); await window.__e.wait(100);
    return { after, undone: projectMarkers.map((m) => m.t) };`);
  check('closing the gap from 1.5 to 3 moves the markers after it by 1.5', JSON.stringify(r.after) === '[1,2,3]', r.after);
  check('and undo puts the markers back with the clips', JSON.stringify(r.undone) === '[1,3.5,4.5]', r.undone);

  // A dragged clip edge catches on a marker. The playhead is moved off it
  // first, since a playhead on the same moment is a line too.
  r = await run(`
    await window.__e.seek(0.2);
    const lines = snapLines(window.__e.video()[0]).filter((l) => l.part === 'marker').map((l) => l.at);
    const snap = snapClipValue(window.__e.video()[2], 'start', 3.5 + 2 / tlView.scale, 0);
    return { lines, value: snap.value, part: snap.line && snap.line.part, lit: !!snapLineElement(snap.line) };`);
  check('markers are lines a dragged edge catches on, with their flag to light', r.lines.length === 3 && r.value === 3.5
    && r.part === 'marker' && r.lit, r);

  // ---- from edge to edge ----
  r = await run(`
    await window.__e.seek(0);
    const seen = [];
    for (let i = 0; i < 6; i++) { stepToEdge(1); await window.__e.wait(60); seen.push(Math.round(compositeAt * 1000) / 1000); }
    stepToEdge(-1); await window.__e.wait(60);
    return { seen, back: Math.round(compositeAt * 1000) / 1000 };`);
  check('Ctrl+Right walks the edges and markers in order', JSON.stringify(r.seen) === '[1,1.5,3,3.5,4.5,5]', r.seen);
  check('Ctrl+Left goes back one', r.back === 4.5, r.back);

  // ---- duplicate ----
  r = await run(`
    const last = window.__e.video()[2];
    selectLayer(last.id);
    duplicateSelected();
    await window.__e.wait(100);
    const v = window.__e.video();
    const copy = v[v.length - 1];
    const out = { n: v.length, start: copy.start, lane: copy.lane, sameLane: copy.lane === last.lane, sounds: layers.filter((l) => l.type === 'audio').length,
      chosen: selectedLayerId === copy.id, clipboard: !!layerClipboard };
    selectLayer(window.__e.video()[0].id);
    duplicateSelected();
    await window.__e.wait(100);
    const first = layers.find((l) => l.id === selectedLayerId);
    out.blocked = { start: first.start, newRow: first.lane !== window.__e.video()[0].lane };
    undoRedo(false); undoRedo(false); await window.__e.wait(100);
    out.after = layers.length;
    return out;`);
  check('Ctrl+Shift+D puts a copy straight after the clip, on its row, with its sound', r.n === 4 && r.start === 5 && r.sameLane
    && r.sounds === 4 && r.chosen && !r.clipboard, r);
  check('where the row is taken the copy goes on a new row instead', r.blocked.start === 1.5 && r.blocked.newRow, r.blocked);
  check('and each is one undo step', r.after === 6, r.after);

  // ---- freeze frame ----
  r = await run(`
    selectLayer(window.__e.video()[0].id);
    await window.__e.seek(1.0);
    const can = canFreezeAt(window.__e.video()[0], compositeAt);
    const ok = await freezeFrameAtPlayhead();
    await window.__e.wait(800);
    const still = layers.find((l) => l.kind === 'image');
    return { can, ok, starts: window.__e.starts(), still: still && { start: still.start, duration: still.duration, lane: still.lane, src: still.src.split(/[\\\\/]/).pop(),
      w: still.sourceWidth, h: still.sourceHeight }, markers: projectMarkers.map((m) => m.t), chosen: still && selectedLayerId === still.id };`);
  const v2 = r.starts.filter((s) => s[0] === 'video');
  check('the frame at 1.0 becomes a two second still on the clip\'s row', r.can && r.ok && r.still && r.still.start === 1
    && r.still.duration === 2 && r.still.w === 1280 && /_frame_[0-9a-f]{10}\.png$/.test(r.still.src) && r.chosen, r.still);
  check('the clip is cut there and everything after moves two seconds on, sound too', v2.some((s) => s[2] === 0 && s[3] === 1 && s[4] === 'media')
    && v2.some((s) => s[2] === 3 && s[3] === 0.5) && v2.some((s) => s[2] === 5 && s[3] === 2)
    && r.starts.filter((s) => s[0] === 'audio').some((s) => s[2] === 3 && s[3] === 0.5), r.starts);
  check('the markers after it move along', JSON.stringify(r.markers) === '[3,5.5,6.5]', r.markers);

  // The still against the file: frames 45 and 75 (1.5 s and 2.5 s) must be the source's frame 30, in preview and export.
  const file = OUT + '/freeze.mp4';
  fs.rmSync(file, { force: true });
  const rendered = await run(`
    const prepared = await exportLayers();
    if (!prepared.ok) return prepared;
    return window.lwclipper.compose(prepared.layers, projectFrame(), { start: 0, end: 4 }, ${JSON.stringify(file)}, 0, 'cpu');`);
  check('the project with a frozen frame exports', rendered && rendered.ok, rendered);
  if (rendered && rendered.ok) {
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf',
      "select='eq(n\\,29)+eq(n\\,45)+eq(n\\,75)+eq(n\\,89)+eq(n\\,90)+eq(n\\,91)'", '-fps_mode', 'passthrough', '-frame_pts', '1', OUT + '/f_%d.png']);
    r = await run(`
      const load = async (file) => { const img = new Image(); img.src = await window.lwclipper.fileUrl(file); await img.decode(); return img; };
      const f = projectFrame();
      const read = async (n) => {
        const c = document.createElement('canvas'); c.width = f.width; c.height = f.height;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(await load(${JSON.stringify(OUT)} + '/f_' + n + '.png'), 0, 0, f.width, f.height);
        return x.getImageData(0, 0, f.width, f.height).data;
      };
      const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return Math.round(s / (a.length / 4 * 3) * 100) / 100; };
      const preview = async (t) => {
        await window.__e.seek(t + 0.001);
        const c = document.createElement('canvas'); c.width = f.width; c.height = f.height;
        const x = c.getContext('2d', { willReadFrequently: true });
        paintLayers(x, c, t, null);
        return x.getImageData(0, 0, f.width, f.height).data;
      };
      const e29 = await read(29), e45 = await read(45), e75 = await read(75), e89 = await read(89), e90 = await read(90), e91 = await read(91);
      return {
        heldInFile: diff(e45, e75), lastMovingToStill: diff(e29, e45), stillToNext: diff(e89, e90), nextMoves: diff(e90, e91),
        previewStill: diff(await preview(1.5), e45), previewAfter: diff(await preview(3.0), e90),
      };`);
    check('the file holds one picture through the freeze', r.heldInFile < 0.6, r);
    check('which is the frame the clip was cut on, not the one before', r.lastMovingToStill > 1, r);
    check('the preview shows the same still as the file', r.previewStill < 2.5, r);
    // The rest of the clip starts on the frame that was frozen, so the first
    // frame after the still is the still's picture, and the one after that moves.
    check('and the clip goes on from that frame after it, preview and file alike', r.previewAfter < 2.5
      && r.stillToNext < 2.5 && r.nextMoves > 1, r);
  }
  r = await run('undoRedo(false); await window.__e.wait(200); return { n: layers.length, markers: projectMarkers.map((m) => m.t) };');
  check('one undo takes the freeze away again, markers and all', r.n === 6 && JSON.stringify(r.markers) === '[1,3.5,4.5]', r);

  // ---- save, open, Open recent ----
  const project = (OUT + '/edit55.lwc').split('/').join('\\');
  fs.rmSync(project, { force: true });
  r = await run(`
    const doc = projectDocument();
    const saved = await window.lwclipper.saveProject(${JSON.stringify(project)},
      { ...doc, views: viewsForFile(), notes: notesForFile(), history: projectHistory.pack(undoStack) }, null);
    const opened = await window.lwclipper.openProject(${JSON.stringify(project)});
    const recent = await window.lwclipper.recentProjects();
    return { saved: saved.ok, markers: opened.ok && opened.doc.markers.map((m) => [m.t, m.name]),
      history: opened.ok && opened.history && opened.history.steps.filter((s) => Array.isArray(s.markers)).length,
      recent: recent.slice(0, 1).map((p) => [p.name, p.missing]) };`);
  check('the project file keeps the markers and their names', r.saved && JSON.stringify(r.markers) === '[[1,""],[3.5,"Drop"],[4.5,""]]', r);
  check('and its undo steps keep theirs', r.history > 0, r.history);
  check('the saved project is first under Open recent', JSON.stringify(r.recent) === '[["edit55",false]]', r.recent);
  r = await run(`
    const result = await window.lwclipper.openProject(${JSON.stringify(project)});
    await adoptProject(result);
    await window.__e.wait(800);
    const here = projectMarkers.map((m) => [m.t, m.name]);
    const flags = window.__e.flags().length;
    const steps = undoCounts().undo;
    undoRedo(false); await window.__e.wait(200);
    return { here, flags, steps, afterUndo: projectMarkers.length, layers: layers.length };`);
  check('opened again, the markers and the undo stack are back', JSON.stringify(r.here) === '[[1,""],[3.5,"Drop"],[4.5,""]]'
    && r.flags === 3 && r.steps > 0, r);

  // ---- the menus say what there is ----
  r = await run(`
    const byId = (id) => ACTIONS.find((a) => a.id === id);
    const ids = ['edit.rippleDelete', 'edit.duplicate', 'edit.freeze', 'play.marker', 'play.edgeBack', 'play.edgeOn', 'file.recent', 'file.saveFrame'];
    return ids.map((id) => [id, !!byId(id), byId(id) && byId(id).keys.join(' ')]);`);
  check('every new action is in the table with its key', r.every((x) => x[1]), r);
  const keys = r.flatMap((x) => (x[2] ? x[2].split(' ') : []));
  r = await run(`
    const mine = ${JSON.stringify(keys)};
    return ACTIONS.filter((a) => a.keys && a.keys.some((k) => mine.includes(k))).map((a) => [a.id, a.keys.join(' ')]);`);
  check('and no key is bound twice', r.length === keys.length, r);

  cdp.close();
  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + checks.length + ' checks, ' + failed.length + ' failed' + (failed.length ? ': ' + failed.map((c) => c.name).join(' | ') : '') + '.');
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
