'use strict';

// The editing of 5.5.2 run in the real window: Lock and Solo on a row's head,
// slip, roll and slide by Alt and a real mouse drag, ease in and out from a
// keyframe's right-click menu with the eased move exported and held against
// the preview, and the playback speed by its keys.
//
//   node dev/harness/edit552.js
//
// Needs the instance (instance.js start) and the media (media.js).

const fs = require('fs');
const { execFileSync } = require('child_process');
const { connect } = require('./cdp');
const { W, FFMPEG } = require('./lib');

const SRC = W + '/talk709.mp4';
const OUT = W + '/out/edit552';

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok });
  console.log((ok ? 'ok     ' : 'FAILED ') + name + (ok || detail === undefined ? '' : '   ' + JSON.stringify(detail)));
};

// CDP modifier bits.
const ALT = 1;
const CTRL = 2;

const PAGE = `
window.__e = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  r3: (v) => Math.round(v * 1000) / 1000,
  state() {
    return layers.map((l) => ({ id: l.id, type: l.type, lane: l.lane, start: this.r3(l.start), duration: this.r3(l.duration),
      sourceIn: this.r3(l.sourceIn), locked: l.locked, solo: l.solo }));
  },
  video() {
    return layers.filter((l) => l.type === 'video').sort((a, b) => a.start - b.start);
  },
  audio(lane = 0) {
    return layers.filter((l) => l.type === 'audio' && l.lane === lane).sort((a, b) => a.start - b.start);
  },
  async fresh(src) {
    if (typeof choiceCancelId !== 'undefined' && choiceCancelId) settleChoice(choiceCancelId);
    if (compositePlaying) pauseComposite();
    setPlayRate(1);
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
    fitTimelineView();
    await this.wait(200);
    return { n: layers.length, duration: l.duration };
  },
  cutInThree() {
    selectLayer(this.video()[0].id);
    splitSelected(1.5);
    selectLayer(this.video().find((l) => l.start === 1.5).id);
    splitSelected(3);
    fitTimelineView();
    return this.state();
  },
  rect(selector) {
    const node = document.querySelector(selector);
    if (!node) return null;
    node.scrollIntoView({ block: 'nearest' });
    const r = node.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  },
  clipRect(id) {
    return this.rect('.layer-clip[data-layer-id="' + id + '"]');
  },
  edgeRect(id, edge) {
    return this.rect('.layer-clip[data-layer-id="' + id + '"] .layer-clip__edge[data-edge="' + edge + '"]');
  },
};
'ready'`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cdp = await connect();
  const run = (code) => cdp.evaluate('(async () => { ' + code + ' })()');
  await cdp.evaluate(PAGE);
  await cdp.send('Page.bringToFront');

  const mouse = (type, x, y, modifiers = 0, button = 'left') => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, modifiers, button, clickCount: 1,
    buttons: type === 'mouseReleased' ? 0 : (button === 'right' ? 2 : 1),
  });
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  // A real drag: press, move in steps, read what `during` asks while held, let go.
  const drag = async (x, y, dx, modifiers = 0, during = null) => {
    await mouse('mouseMoved', x, y, modifiers, 'none');
    await mouse('mousePressed', x, y, modifiers);
    for (let i = 1; i <= 8; i += 1) {
      await mouse('mouseMoved', x + (dx * i) / 8, y, modifiers);
      await pause(25);
    }
    const seen = during ? await run(during) : null;
    await mouse('mouseReleased', x + dx, y, modifiers);
    await pause(250);
    return seen;
  };
  const click = async (x, y, button = 'left') => {
    await mouse('mouseMoved', x, y, 0, 'none');
    await mouse('mousePressed', x, y, 0, button);
    await mouse('mouseReleased', x, y, 0, button);
    await pause(250);
  };
  const key = async (type, k, code, vk, modifiers = 0) => cdp.send('Input.dispatchKeyEvent', {
    type, key: k, code, windowsVirtualKeyCode: vk, modifiers,
  });

  let r = await run('return window.__e.fresh(' + JSON.stringify(SRC) + ')');
  check('a clip of video and sound is on the timeline', r.n === 2, r);
  const cut = await run('return window.__e.cutInThree()');
  check('cut into three of each', cut.length === 6, cut);
  const ids = await run('return { v: window.__e.video().map((l) => l.id), a: window.__e.audio().map((l) => l.id), scale: tlView.scale };');

  // ---- slip ----
  let box = await run(`return window.__e.clipRect(${JSON.stringify(ids.v[1])})`);
  let tip = await drag(box.cx, box.y + box.h * 0.6, 40, ALT,
    "const t = document.querySelector('.edit-tip'); return t && !t.hidden ? t.textContent : null;");
  r = await run(`const v = layers.find((l) => l.id === ${JSON.stringify(ids.v[1])});
    const a = layers.find((l) => l.id === ${JSON.stringify(ids.a[1])});
    return { v: [window.__e.r3(v.start), window.__e.r3(v.duration), window.__e.r3(v.sourceIn)], a: [window.__e.r3(a.start), window.__e.r3(a.sourceIn)],
      undo: undoCounts().undo, tip: document.querySelector('.edit-tip').hidden };`);
  const slipBy = 40 / ids.scale;
  check('Alt and a drag slip the middle clip: same place and length, an earlier part of the file',
    r.v[0] === 1.5 && r.v[1] === 1.5 && Math.abs(r.v[2] - (1.5 - slipBy)) < 0.02, { got: r.v, want: 1.5 - slipBy });
  check('its sound is slipped with it', r.a[0] === 1.5 && Math.abs(r.a[1] - r.v[2]) < 1e-6, r.a);
  check('the seconds were beside the pointer while it was held, and go when it is let go',
    /^Slip: \+0\.\d\d s$/.test(tip || '') && r.tip === true, tip);
  r = await run('undoRedo(false); await window.__e.wait(150); return layers.find((l) => l.id === ' + JSON.stringify(ids.v[1]) + ').sourceIn;');
  check('one undo takes the slip back', r === 1.5, r);

  // ---- roll ----
  box = await run(`return window.__e.edgeRect(${JSON.stringify(ids.v[0])}, 'end')`);
  tip = await drag(box.cx, box.cy, 40, ALT,
    "const t = document.querySelector('.edit-tip'); return t && !t.hidden ? t.textContent : null;");
  r = await run('return window.__e.state();');
  const by = (id) => r.find((l) => l.id === id);
  const rollBy = 40 / ids.scale;
  const cutAt = 1.5 + rollBy;
  check('Alt and a drag on the edge two clips meet at roll the cut',
    Math.abs(by(ids.v[0]).duration - cutAt) < 0.02 && Math.abs(by(ids.v[1]).start - by(ids.v[0]).duration) < 1e-6
    && Math.abs(by(ids.v[1]).sourceIn - by(ids.v[1]).start) < 1e-6 && by(ids.v[1]).start + by(ids.v[1]).duration === 3,
    [by(ids.v[0]), by(ids.v[1])]);
  check('the sound\'s cut rolls with it', Math.abs(by(ids.a[0]).duration - by(ids.v[0]).duration) < 1e-6
    && Math.abs(by(ids.a[1]).start - by(ids.v[1]).start) < 1e-6, [by(ids.a[0]), by(ids.a[1])]);
  check('the roll\'s seconds were shown', /^Roll: \+0\.\d\d s$/.test(tip || ''), tip);
  await run('undoRedo(false); await window.__e.wait(150);');

  // ---- slide ----
  box = await run(`return window.__e.clipRect(${JSON.stringify(ids.v[1])})`);
  tip = await drag(box.cx, box.y + box.h * 0.6, 40, ALT | CTRL,
    "const t = document.querySelector('.edit-tip'); return t && !t.hidden ? t.textContent : null;");
  r = await run('return window.__e.state();');
  const slideBy = 40 / ids.scale;
  check('Alt, Ctrl and a drag slide the middle clip between the two it meets',
    Math.abs(by(ids.v[1]).start - (1.5 + slideBy)) < 0.02 && by(ids.v[1]).duration === 1.5 && by(ids.v[1]).sourceIn === 1.5
    && Math.abs(by(ids.v[0]).duration - by(ids.v[1]).start) < 1e-6
    && Math.abs(by(ids.v[2]).start - (by(ids.v[1]).start + 1.5)) < 1e-6 && by(ids.v[2]).start + by(ids.v[2]).duration === 5,
    [by(ids.v[0]), by(ids.v[1]), by(ids.v[2])]);
  check('the sounds slide and give with them', Math.abs(by(ids.a[1]).start - by(ids.v[1]).start) < 1e-6
    && Math.abs(by(ids.a[2]).start - by(ids.v[2]).start) < 1e-6, [by(ids.a[1]), by(ids.a[2])]);
  check('the slide\'s seconds were shown', /^Slide: \+0\.\d\d s$/.test(tip || ''), tip);
  await run('undoRedo(false); await window.__e.wait(150);');

  // ---- the hint while Alt is held ----
  await key('rawKeyDown', 'Alt', 'AltLeft', 18, ALT);
  await pause(100);
  const hintAlt = await run("return el('timelineHint').textContent;");
  await key('keyUp', 'Alt', 'AltLeft', 18, 0);
  await pause(100);
  const hintIdle = await run("return el('timelineHint').textContent;");
  check('while Alt is held the hint line says what it does, and goes back after', /^Alt: drag a clip to slip it/.test(hintAlt)
    && !/^Alt:/.test(hintIdle), [hintAlt, hintIdle]);

  // ---- lock ----
  box = await run("return window.__e.rect('.layer-row--audio[data-lane=\"0\"] .layer-toggle--lock');");
  await click(box.cx, box.cy);
  r = await run(`const row = document.querySelector('.layer-row--audio[data-lane="0"]');
    const clip = row.querySelector('.layer-clip');
    return { locked: layers.filter((l) => l.type === 'audio').every((l) => l.locked), row: row.classList.contains('layer-row--locked'),
      pressed: row.querySelector('.layer-toggle--lock').getAttribute('aria-pressed'), events: getComputedStyle(clip).pointerEvents,
      remove: row.querySelector('.layer-btn--delete').disabled, undo: undoCounts().undo };`);
  check('the padlock locks the audio row: every clip on it, hatched, its clips take no press, its delete waits',
    r.locked && r.row && r.pressed === 'true' && r.events === 'none' && r.remove, r);
  box = await run(`return window.__e.clipRect(${JSON.stringify(ids.a[1])})`);
  await run('selectLayer(null);');
  await click(box.cx, box.cy);
  r = await run('return { chosen: selectedLayerId, at: window.__e.r3(compositeAt) };');
  check('a click on a locked clip chooses nothing and moves the playhead there', r.chosen === null && r.at > 1.4 && r.at < 3.1, r);
  r = await run(`selectLayer(${JSON.stringify(ids.a[1])}); return selectedLayerId;`);
  check('and nothing can choose it', r === null, r);
  box = await run(`return window.__e.clipRect(${JSON.stringify(ids.v[2])})`);
  await drag(box.cx, box.y + box.h * 0.6, 40, 0);
  r = await run('return window.__e.state();');
  check('a picture moved leaves its sound on the locked row where it was', by(ids.v[2]).start > 3.1 && by(ids.a[2]).start === 3, [by(ids.v[2]), by(ids.a[2])]);
  await run('undoRedo(false); await window.__e.wait(150);');
  r = await run(`selectLayer(${JSON.stringify(ids.v[1])}); rippleDeleteSelected(); await window.__e.wait(150); return window.__e.state();`);
  check('Delete and close gap takes the picture, leaves the locked sound, and the locked row does not move',
    !by(ids.v[1]) && by(ids.v[2]).start === 1.5 && by(ids.a[1]) && by(ids.a[2]).start === 3, r);
  await run('undoRedo(false); await window.__e.wait(150);');
  r = await run(`const before = layers.length;
    const d = await window.lwclipper.describeMedia(${JSON.stringify(SRC)});
    addLayerFromMedia('audio', d.data, 0, 6);
    await window.__e.wait(150);
    const added = layers.find((l) => l.type === 'audio' && l.start === 6);
    const out = { n: layers.length - before, lane: added && added.lane, locked: added && added.locked };
    undoRedo(false); await window.__e.wait(150);
    return out;`);
  check('a file let go over the locked row goes onto a new row, unlocked', r.n === 1 && r.lane === 1 && r.locked === false, r);
  box = await run("return window.__e.rect('.layer-row--audio[data-lane=\"0\"] .layer-toggle--lock');");
  await click(box.cx, box.cy);
  r = await run(`return { locked: layers.some((l) => l.locked), undo: undoCounts().undo };`);
  check('clicked again it unlocks', r.locked === false, r);

  // ---- solo ----
  r = await run(`const d = await window.lwclipper.describeMedia(${JSON.stringify(SRC)});
    addLayerFromMedia('audio', d.data, undefined, 0);
    await window.__e.wait(300);
    return window.__e.audio(1).map((l) => l.id);`);
  const second = r[0];
  box = await run("return window.__e.rect('.layer-row--audio[data-lane=\"0\"] .layer-toggle--solo');");
  await click(box.cx, box.cy);
  r = await run(`const two = layers.find((l) => l.id === ${JSON.stringify(second)});
    const one = layers.find((l) => l.id === ${JSON.stringify(ids.a[0])});
    const prepared = await exportLayers();
    const sent = prepared.ok ? prepared.layers.find((l) => l.id === two.id) : null;
    const sentOne = prepared.ok ? prepared.layers.find((l) => l.id === one.id) : null;
    const q = document.querySelector('.layer-row--audio[data-lane="1"]');
    const s = document.querySelector('.layer-row--audio[data-lane="0"]');
    return { on: [layerOn(one), layerOn(two)], gains: [playerGain(one), playerGain(two)], sent: sent && sent.enabled, sentOne: sentOne && sentOne.enabled,
      quiet: q.classList.contains('layer-row--quiet'), solo: s.classList.contains('layer-row--solo'),
      video: timelineModel.layersAt(layers, 1).some((l) => l.type === 'video'), pressed: s.querySelector('.layer-toggle--solo').getAttribute('aria-pressed') };`);
  check('S on Audio 1 solos it: Audio 2 goes quiet and silent, the video is untouched',
    r.on[0] && !r.on[1] && r.gains[0] > 0 && r.gains[1] === 0 && r.quiet && r.solo && r.video && r.pressed === 'true', r);
  check('and the export gets Audio 2 switched off and Audio 1 on', r.sent === false && r.sentOne === true, r);
  r = await run(`const d = await window.lwclipper.describeMedia(${JSON.stringify(SRC)});
    // A clip let go onto the soloed row takes its Solo.
    addLayerFromMedia('audio', d.data, 0, 6);
    await window.__e.wait(150);
    const added = layers.filter((l) => l.type === 'audio' && l.start === 6)[0];
    const out = { lane: added.lane, solo: added.solo };
    undoRedo(false); await window.__e.wait(150);
    return out;`);
  check('a clip let go onto the soloed row is soloed with it', r.lane === 0 && r.solo === true, r);
  await click(box.cx, box.cy);
  r = await run(`return { solo: layers.some((l) => l.solo), quiet: !!document.querySelector('.layer-row--quiet') };`);
  check('clicked again the Solo ends', !r.solo && !r.quiet, r);
  await run(`setLayers(layers.filter((l) => l.id !== ${JSON.stringify(second)})); commitHistory();`);

  // ---- ease ----
  r = await run(`
    const v = window.__e.video()[0];
    let next = timelineModel.putKeyframe(layers, v.id, { id: 'kA', t: 0, render: { x: 0, y: 0, width: 320, height: 180 } });
    next = timelineModel.putKeyframe(next, v.id, { id: 'kB', t: 1.2, render: { x: 960, y: 540, width: 320, height: 180 } });
    setLayers(next); commitHistory();
    await window.__e.wait(200);
    return window.__e.rect('.clip-key[data-key-id="kA"]');`);
  await click(r.cx, r.cy, 'right');
  r = await run(`const items = [...document.querySelectorAll('.clip-menu__item')].map((b) => b.textContent);
    return { items, at: (() => { const b = [...document.querySelectorAll('.clip-menu__item')].find((x) => x.textContent === 'Ease out');
      if (!b) return null; const q = b.getBoundingClientRect(); return { cx: q.left + q.width / 2, cy: q.top + q.height / 2 }; })() };`);
  check('a keyframe\'s right-click menu has Ease in and Ease out', r.items.includes('Ease in') && r.items.includes('Ease out'), r.items);
  if (r.at) await click(r.at.cx, r.at.cy);
  r = await run(`const v = window.__e.video()[0];
    const k = timelineModel.keyframesFor(v).find((o) => o.id === 'kA');
    const key = document.querySelector('.clip-key[data-key-id="kA"]');
    return { easeOut: k.easeOut === true, easeIn: !!k.easeIn, cls: key.classList.contains('clip-key--ease-out'),
      shape: getComputedStyle(key, '::before').borderTopRightRadius, undo: undoCounts().undo };`);
  check('Ease out ticks the keyframe, and its diamond is rounded on that side', r.easeOut && !r.easeIn && r.cls && r.shape === '50%', r);
  // Open the menu again and see the tick.
  r = await run('return window.__e.rect(\'.clip-key[data-key-id="kA"]\');');
  await click(r.cx, r.cy, 'right');
  r = await run("const items = [...document.querySelectorAll('.clip-menu__item')].map((b) => b.textContent); closeClipMenu(); return items;");
  check('the menu shows it ticked', r.includes('✓ Ease out') && r.includes('Ease in'), r);

  // The eased move exported and held against the preview, at 0.4 s (frame 12 at 30 fps).
  const file = OUT + '/ease.mp4';
  fs.rmSync(file, { force: true });
  r = await run(`const prepared = await exportLayers();
    if (!prepared.ok) return prepared;
    const fps = projectFrame().fps;
    const done = await window.lwclipper.compose(prepared.layers, projectFrame(), { start: 0, end: 1.5 }, ${JSON.stringify(file)}, 0, 'cpu');
    return { ...done, fps };`);
  check('the project with an eased move exports', r && r.ok, r);
  if (r && r.ok) {
    const fps = r.fps;
    const n = Math.round(0.4 * fps);
    execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf',
      "select='eq(n\\," + n + ")'", '-fps_mode', 'passthrough', OUT + '/ease_%d.png']);
    r = await run(`
      const load = async (file) => { const img = new Image(); img.src = await window.lwclipper.fileUrl(file); await img.decode(); return img; };
      const f = projectFrame();
      const pixels = (paint) => { const c = document.createElement('canvas'); c.width = f.width; c.height = f.height;
        const x = c.getContext('2d', { willReadFrequently: true }); paint(x, c); return x.getImageData(0, 0, f.width, f.height).data; };
      const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return Math.round(s / (a.length / 4 * 3) * 100) / 100; };
      const img = await load(${JSON.stringify(OUT)} + '/ease_1.png');
      const file = pixels((x) => x.drawImage(img, 0, 0, f.width, f.height));
      const t = ${n} / ${fps};
      seekComposite(t + 0.001); await window.__e.wait(800);
      const eased = pixels((x, c) => paintLayers(x, c, t, null));
      // The same moment with the ease taken off, which the file must not look like.
      const v = window.__e.video()[0];
      const plain = timelineModel.setKeyframeEase(layers, v.id, 'kA', { easeOut: false });
      const keep = layers; layers = plain;
      const linear = pixels((x, c) => paintLayers(x, c, t, null));
      layers = keep;
      const placeEased = layerGeometry.placementAt(v, t - v.start, { width: v.sourceWidth, height: v.sourceHeight }, f).dest.x;
      return { againstPreview: diff(file, eased), againstLinear: diff(file, linear), x: Math.round(placeEased) };`);
    check('the file is where the eased preview is at 0.4 s', r.againstPreview < 2.5, r);
    check('and not where a straight move would be', r.againstLinear > r.againstPreview * 3 && r.againstLinear > 3, r);
  }
  await run('undoRedo(false); await window.__e.wait(150);');

  // ---- playback speed ----
  await run('if (document.activeElement) document.activeElement.blur(); seekComposite(0); updatePlayhead();');
  await key('rawKeyDown', 'ArrowUp', 'ArrowUp', 38, CTRL);
  await key('keyUp', 'ArrowUp', 'ArrowUp', 38, CTRL);
  await pause(100);
  r = await run("return { rate: playRate, readout: el('speedReadout').hidden ? null : el('speedReadout').textContent };");
  check('Ctrl+Up plays faster, and the header says so', r.rate === 1.5 && r.readout === 'Playback x1.5', r);
  r = await run(`seekComposite(0.2); playComposite();
    await window.__e.wait(400);
    const a = compositeAt, t0 = performance.now();
    await window.__e.wait(1000);
    const gone = (compositeAt - a) / ((performance.now() - t0) / 1000);
    const v = window.__e.video().find((l) => timelineModel.covers(l, compositeAt));
    const e = v && decoders.get(v.id);
    const sound = window.__e.audio().find((l) => timelineModel.covers(l, compositeAt));
    const p = sound && players.get(sound.id);
    const out = { gone: Math.round(gone * 100) / 100, video: e && e.el.playbackRate, audio: p && p.el.playbackRate, pitch: p && p.el.preservesPitch };
    pauseComposite();
    return out;`);
  check('at x1.5 the playhead runs a second and a half a second', Math.abs(r.gone - 1.5) < 0.12, r);
  check('and the picture and the sound run at it, the pitch kept', Math.abs(r.video - 1.5) < 0.2 && Math.abs(r.audio - 1.5) < 0.2 && r.pitch, r);
  for (let i = 0; i < 2; i += 1) {
    await key('rawKeyDown', 'ArrowDown', 'ArrowDown', 40, CTRL);
    await key('keyUp', 'ArrowDown', 'ArrowDown', 40, CTRL);
  }
  await pause(100);
  r = await run("return { rate: playRate, readout: el('speedReadout').textContent, shown: !el('speedReadout').hidden };");
  check('Ctrl+Down twice from x1.5 is x0.75', r.rate === 0.75 && r.shown && r.readout === 'Playback x0.75', r);
  r = await run("ACTIONS.find((a) => a.id === 'play.normal').run(); return { rate: playRate, hidden: el('speedReadout').hidden };");
  check('Normal playback speed is x1 again, and the readout goes', r.rate === 1 && r.hidden, r);

  // ---- the keys ----
  r = await run(`const mine = ['play.faster', 'play.slower', 'play.normal'].map((id) => ACTIONS.find((a) => a.id === id));
    const keys = mine.flatMap((a) => a.keys);
    return { there: mine.every(Boolean), twice: ACTIONS.filter((a) => a.keys && a.keys.some((k) => keys.includes(k))).length, keys };`);
  check('the three are in the Playback menu and no key is bound twice', r.there && r.twice === r.keys.length, r);

  cdp.close();
  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + checks.length + ' checks, ' + failed.length + ' failed' + (failed.length ? ': ' + failed.map((c) => c.name).join(' | ') : '') + '.');
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(String(err && err.stack ? err.stack : err));
  process.exit(1);
});
