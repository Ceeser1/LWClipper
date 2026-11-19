'use strict';
// What the harness runs inside the app's window: it builds a project there,
// has it exported, and compares the preview's own drawing of a frame with the
// frame the export wrote. The names it reaches for (layers, setLayers,
// paintLayers, seekDecodersTo, ...) are the window's own top-level ones.
const PAGE = `
window.__h = {
  async setup(src) {
    if (typeof choiceCancelId !== 'undefined' && choiceCancelId) settleChoice(choiceCancelId);
    const have = layers.find((x) => x.type === 'video');
    if (!have || have.src.split(String.fromCharCode(92)).join('/') !== src) {
      if (layers.length) setLayers([]);
      const r = await window.lwclipper.describeMedia(src);
      if (!r || !r.ok) return { error: 'describe', r };
      addLayerFromMedia('video', r.data, undefined, 0);
    }
    const l = layers.find((x) => x.type === 'video');
    for (let i = 0; i < 100; i++) {
      const e = decoders.get(l.id);
      if (e && e.width) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const f = projectFrame();
    return { id: l.id, frame: f, duration: l.duration, n: layers.length };
  },
  async under(src) {
    const norm = (p) => p.split(String.fromCharCode(92)).join('/');
    const vids = layers.filter((x) => x.type === 'video');
    const have = vids.find((x, i) => i > 0);
    if (!src) {
      if (have) setLayers(layers.filter((x) => x.id !== have.id && x.groupId !== have.groupId || x === vids[0]));
      return layers.length;
    }
    if (have && norm(have.src) === src) return layers.length;
    if (have) setLayers(layers.filter((x) => x.id !== have.id));
    const r = await window.lwclipper.describeMedia(src);
    if (!r || !r.ok) return { error: 'describe', r };
    addLayerFromMedia('video', r.data, undefined, 0);
    const l = layers.filter((x) => x.type === 'video')[1];
    for (let i = 0; i < 100; i++) {
      const e = decoders.get(l.id);
      if (e && e.width) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return layers.filter((x) => x.type === 'video').map((x) => [x.lane, norm(x.src).split('/').pop()]);
  },
  setVfx(list, props) {
    const l = layers.find((x) => x.type === 'video');
    const { under, frame, ...rest } = props || {};
    // The project's frame for this case: its size and rate.
    compositeFrame = frame || { width: 1280, height: 720, fps: 30 };
    sizeCompositeCanvas();
    // Every case starts from a plain layer, and what it is given goes through the model, as a file's would.
    const made = timelineModel.createLayer({ ...l, crop: null, render: null, rotation: 0, mask: null, keyframes: [], alpha: 1, fadeIn: 0, fadeOut: 0, ...rest, vfx: list });
    setLayers(layers.map((x) => (x.id === l.id ? made : x)));
    return timelineModel.vfxList(layers.find((x) => x.type === 'video')).length;
  },
  async render(file, end) {
    const prepared = await exportLayers();
    if (!prepared.ok) return prepared;
    const t0 = performance.now();
    const r = await window.lwclipper.compose(prepared.layers, projectFrame(), { start: 0, end }, file, 0, 'cpu');
    return { ok: r.ok, error: r.error, ms: Math.round(performance.now() - t0),
      files: prepared.layers.map((l) => (l.vfxFiles || []).map((f) => ({ kind: f.kind, full: !!f.full, steps: f.steps.length, frames: !!f.frames, whole: f.whole }))) };
  },
  async load(file) {
    const url = await window.lwclipper.fileUrl(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  },
  async compare(n, dir, wait, save) {
    const f = projectFrame();
    const t = n / f.fps;
    await seekDecodersTo(t + 0.03 / f.fps);
    await new Promise((r) => setTimeout(r, wait));
    const c = document.createElement('canvas');
    c.width = f.width; c.height = f.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const t0 = performance.now();
    paintLayers(ctx, c, t, null);
    const mine = ctx.getImageData(0, 0, c.width, c.height).data;
    const paintMs = performance.now() - t0;
    const x = document.createElement('canvas');
    x.width = f.width; x.height = f.height;
    const xc = x.getContext('2d', { willReadFrequently: true });
    const out = {};
    for (const d of [-1, 0, 1]) {
      const img = await this.load(dir + '/f_' + (n + d) + '.png');
      xc.drawImage(img, 0, 0, x.width, x.height);
      const theirs = xc.getImageData(0, 0, x.width, x.height).data;
      let sum = 0;
      let worst = 0;
      for (let i = 0; i < mine.length; i += 4) {
        const e = Math.abs(mine[i] - theirs[i]) + Math.abs(mine[i + 1] - theirs[i + 1]) + Math.abs(mine[i + 2] - theirs[i + 2]);
        sum += e;
      }
      out[d] = Math.round(sum / (mine.length / 4 * 3) * 100) / 100;
      if (d === 0) {
        // The same at an eighth of the size, where grain and fine lines average out.
        const lw = Math.round(c.width / 8), lh = Math.round(c.height / 8);
        const small = (src) => {
          let cur = src;
          for (let k = 0; k < 3; k++) {
            const n = document.createElement('canvas');
            n.width = Math.round(cur.width / 2); n.height = Math.round(cur.height / 2);
            const nc = n.getContext('2d', { willReadFrequently: true });
            nc.imageSmoothingEnabled = true;
            nc.drawImage(cur, 0, 0, n.width, n.height);
            cur = n;
          }
          return cur.getContext('2d').getImageData(0, 0, cur.width, cur.height).data;
        };
        const a = small(c), b = small(x);
        let ls = 0;
        for (let i = 0; i < a.length; i += 4) ls += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        out.low = Math.round(ls / (a.length / 4 * 3) * 100) / 100;
      }
    }
    out.paintMs = Math.round(paintMs * 10) / 10;
    if (save) {
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      out.png = Array.from(new Uint8Array(await blob.arrayBuffer()));
    }
    return out;
  },
};
'ok'`;

module.exports = { PAGE };
