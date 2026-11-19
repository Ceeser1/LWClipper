'use strict';

// Gravity (5.3.0). A picture that falls.
//
// The user, 2026-11-19: a VFX under a heading of its own, Physics, that
// starts at a keyframe and from there lets the track's picture fall onto the
// bottom of the render frame, bounce, turn and roll. "Its not about a real
// interactive physics simulation, only a track gets physics applied to it.
// Multiple tracks having it ignore each other." So this is one solid body in
// an empty frame: a rectangle or a circle, a floor, and the frame's left and
// right edges when Edge Collision is on. Nothing here knows of another track,
// and a mass would have nothing to act on.
//
// Unlike every other VFX it changes no pixel. It says where the picture is,
// frame by frame, in the form geometry.js already has for a picture that
// moves: a list of placements at times with a straight blend between
// neighbours (shownKeys). The preview draws that blend and composer.js turns
// the same list into its expressions of t, so the two cannot differ.
//
// The user's rules, and the same settings always give the same path:
//   - Bounciness is a share of the height: 0 stays down, 100 jumps back to
//     the height it fell from.
//   - Drag is how much of the spin turns into sideways speed at a touch of
//     the floor: 100 turns all of it, 50 keeps half and turns half. A circle
//     100 pixels across at one turn a second moves 314 pixels a second.
//   - Sideways speed drops by 5% at every touch of a border.
//   - Lying or rolling on the floor is "constant" touching, "but still no
//     perfectly always touching, so no immediate stop": it fades.
//   - A rectangle's corner on the floor pushes it sideways by its spin, less
//     the more it bounces.
//   - Velocity is counted in the render frame: 100 is the frame's height a
//     second.
//   - Below 1 pixel a second it stands, and nothing more is worked out.
//
// "i just had kinda-fitting numbers in my mind. In practice they can be
// really off": every figure is in TUNING below and nowhere else, to be set
// by eye once the motion is seen.

const layerGravity = (() => {
  const geo = typeof layerGeometry !== 'undefined' ? layerGeometry : require('./geometry');
  const model = typeof timelineModel !== 'undefined' ? timelineModel : require('./timeline');

  const TUNING = {
    // How hard the frame pulls: frame heights a second, every second.
    gravity: 2.4,
    // The share of its sideways speed a picture loses at a touch of a border.
    touchLoss: 0.05,
    // Rolling on the floor is one such touch every so many seconds, and so
    // is a corner that stays on it. A rectangle lying flat touches with a
    // whole side and is slowed that much sooner.
    floorTouch: 0.1,
    slideTouch: 0.03,
    // Below this many pixels a second, on the floor, it stands.
    stop: 1,
    // A landing slower than gravity adds in this many seconds is no hop.
    hop: 0.06,
    // A rectangle on the floor moving slower than this share of the frame's
    // height a second is calmed, at this rate a second, so it lies down
    // instead of rocking on.
    calm: 0.2,
    calmRate: 10,
    // How far from flat, in radians, and how slow, as a share of the frame's
    // height a second, a rectangle is laid flat.
    flat: 0.003,
    flatSpeed: 0.02,
    // An edge hit slower than this share of the frame's height a second
    // does not bounce back.
    edgeHop: 0.02,
    // A picture that is let go while it reaches past the floor or an edge is
    // not put inside in one jump: the border starts where the picture is and
    // closes in at this many frame heights a second.
    rise: 1.5,
    // The steps a second everything is worked out in.
    step: 1 / 240,
    // How far, in pixels, the blend between two kept moments may lie from
    // the path, and how many steps one blend may span.
    keep: 0.25,
    span: 64,
  };

  // How near the floor, in pixels, a corner counts as on it.
  const SLOP = 0.5;
  const AIR = 0;
  const FLOOR = 1;
  const REST = 2;

  /**
   * The path of one body from its first throw to `until`, in the frame's
   * pixels: `{ t, x, y, turn }` lists of equal length, the body's middle and
   * its turn in degrees, not wrapped, one entry a step while it moves, and
   * `rest`, the moment it stood for good, or null.
   *
   * `body` is `{ kind: 'ball', r }` or `{ kind: 'box', w, h }`. `throws` are
   * `{ t, velocity, spin, drag, bounce }` in time order: pixels a second to
   * the right, degrees a second clockwise, and two shares of 1. The first
   * lets it go; a later one throws it again from where it is.
   */
  function simulate(o) {
    const W = Number(o.W);
    const H = Number(o.H);
    const dt = TUNING.step;
    const g = TUNING.gravity * H;
    const hop = TUNING.hop * g;
    const edgeHop = TUNING.edgeHop * H;
    const lose = 1 - TUNING.touchLoss;
    const fade = Math.pow(lose, dt / TUNING.floorTouch);
    const slide = Math.pow(lose, dt / TUNING.slideTouch);
    const ball = o.body.kind === 'ball';
    const bw = ball ? 2 * o.body.r : o.body.w;
    const bh = ball ? 2 * o.body.r : o.body.h;
    // The farthest any part of it is from its middle.
    const R = ball ? o.body.r : Math.hypot(bw, bh) / 2;
    const I = ball ? (R * R) / 2 : (bw * bw + bh * bh) / 12;
    // A picture that cannot fit between the edges at every turn ignores
    // them: one wider than the frame was thrown between both without end.
    const walls = !!o.walls && 2 * R <= W;
    const throws = o.throws;
    const from = throws[0].t;

    let x = Number(o.x);
    let y = Number(o.y);
    // The turn is handed back in degrees counted on from the one it came
    // with, so a picture that never turns keeps its very figure.
    const turn0 = Number(o.turn) || 0;
    const a0 = turn0 * Math.PI / 180;
    let a = a0;
    let quarters = null;
    let vx = 0;
    let vy = 0;
    let av = 0;
    let drag = 0;
    let bounce = 0;
    let mode = AIR;
    // A ball: the highest it has been since its last touch, and the height
    // its next jump is to reach. One height kept and multiplied, since
    // measuring every fall again drifted by 9% in half a minute.
    let apex = y;
    let promised = null;
    // A rectangle: the most energy it may have, so that the steps' rounding
    // never adds any, and half its width as it lies.
    let cap = 0;
    let lying = bw / 2;
    let lyingHigh = bh / 2;
    // Half the picture's size as it is laid, not turned, for the pixel its
    // corner comes to rest on.
    const layX = o.half ? o.half.x : bw / 2;
    const layY = o.half ? o.half.y : bh / 2;
    let rest = null;
    // The borders as they are now: the frame's, or farther out for a
    // picture that was let go past one (TUNING.rise), closing in.
    let floor = H;
    let left = 0;
    let right = W;
    const reachOf = () => {
      if (ball) return { x: R, y: R };
      const c = Math.abs(Math.cos(a));
      const s = Math.abs(Math.sin(a));
      return { x: (bw * c + bh * s) / 2, y: (bw * s + bh * c) / 2 };
    };
    const closeIn = () => {
      const by = TUNING.rise * H * dt;
      floor = Math.max(H, floor - by);
      left = Math.min(0, left + by);
      right = Math.max(W, right - by);
    };
    const inFrame = () => floor === H && left === 0 && right === W;

    const out = { t: [], x: [], y: [], turn: [], rest: null };
    const record = (t) => {
      out.t.push(Math.round(t * 1e6) / 1e6);
      out.x.push(x);
      out.y.push(y);
      out.turn.push(quarters !== null ? quarters * 90 : turn0 + (a - a0) * 180 / Math.PI);
    };
    const energy = () => (vx * vx + vy * vy + I * av * av) / 2 + g * (H - y);

    const stand = (t) => {
      // Its left edge on an even pixel, less than one away: the encoder
      // lays a moving picture on even pixels, so one that stood anywhere
      // else was a little aside in the file.
      x = 2 * Math.round((x - layX) / 2) + layX;
      vx = 0;
      vy = 0;
      av = 0;
      mode = REST;
      rest = t;
    };

    // The edges, for something `half` wide either side of its middle that
    // does not turn against them: back with 5% less.
    const edges = (half, spins) => {
      if (!walls) return;
      if ((x - half < left && vx <= 0) || (x + half > right && vx >= 0)) {
        x = x - half < left ? left + half : right - half;
        vx = -vx * lose;
        if (spins) av = -av;
      }
    };

    function stepBall(t) {
      if (mode === FLOOR) {
        // Rolling: what is left of the spin goes on turning into speed, and
        // both fade by the touch that never ends.
        if (drag > 0) {
          const keep = drag >= 1 ? 0 : Math.pow(1 - drag, dt / TUNING.floorTouch);
          const moved = av * (1 - keep);
          av -= moved;
          vx += moved * R;
        }
        vx *= fade;
        av *= fade;
        x += vx * dt;
        y = floor - R;
        a += av * dt;
        edges(R, true);
        if (inFrame() && Math.abs(vx) < TUNING.stop && Math.abs(av) * R < TUNING.stop) stand(t);
        return;
      }
      x += vx * dt;
      y += vy * dt + (g * dt * dt) / 2;
      vy += g * dt;
      a += av * dt;
      apex = Math.min(apex, y);
      edges(R, true);
      if (y + R < floor || vy <= 0) return;
      // A touch of the floor.
      const drop = Math.max(0, floor - R - apex);
      y = floor - R;
      vx *= lose;
      const moved = av * drag;
      vx += moved * R;
      av = (av - moved) * lose;
      if (promised === null) promised = drop;
      promised *= bounce;
      const up = Math.sqrt(2 * g * promised);
      apex = y;
      if (up > hop) {
        vy = -up;
      } else {
        vy = 0;
        mode = FLOOR;
      }
    }

    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

    function stepBox(t) {
      if (mode === FLOOR) {
        // Lying flat: it slides, and the slide fades.
        vx *= slide;
        x += vx * dt;
        y = floor - lyingHigh;
        edges(lying, false);
        if (inFrame() && Math.abs(vx) < TUNING.stop) stand(t);
        return;
      }
      x += vx * dt;
      y += vy * dt + (g * dt * dt) / 2;
      vy += g * dt;
      a += av * dt;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const list = [];
      let onFloor = 0;
      let landing = false;
      for (const [sx, sy] of CORNERS) {
        const rx = (sx * bw * c - sy * bh * s) / 2;
        const ry = (sx * bw * s + sy * bh * c) / 2;
        const depth = y + ry - floor;
        if (depth > -SLOP) {
          list.push({ rx, ry, nx: 0, ny: -1, depth });
          onFloor += 1;
          if (vy + av * rx > hop) landing = true;
        }
        if (walls) {
          if (x + rx < left) list.push({ rx, ry, nx: 1, ny: 0, depth: left - (x + rx) });
          else if (x + rx > right) list.push({ rx, ry, nx: -1, ny: 0, depth: x + rx - right });
        }
      }
      if (!list.length) return;
      // What a touch of the floor does to the speed sideways: a landing is
      // one touch, with the corner's push by the spin, and anything slower
      // is the touch that never ends.
      if (landing) {
        vx *= lose;
        // The push never gives more than the spin gives up for it. Without
        // that, a rectangle in the corner between the floor and an edge was
        // pushed by its spin, spun up by the edge and pushed harder, a
        // thousand pixels a step within a second.
        let push = av * R * drag * (1 - bounce);
        const given = (I * av * av * (1 - (1 - drag) * (1 - drag))) / 2;
        if (vx * push + (push * push) / 2 > given) {
          const reach = Math.sqrt(vx * vx + 2 * given);
          push = push > 0 ? reach - vx : -reach - vx;
        }
        vx += push;
        av *= (1 - drag) * lose;
      } else if (onFloor) {
        vx *= fade;
        av *= fade;
      }
      // Each corner is pushed off along the border it is in, never along it:
      // the floor and the edges are smooth, and what a rough floor would do
      // is the rule above. A corner that came in fast leaves by the
      // bounciness, a slow one stays.
      const up = Math.sqrt(bounce);
      for (const k of list) {
        const vn = (vx - av * k.ry) * k.nx + (vy + av * k.rx) * k.ny;
        k.rn = k.rx * k.ny - k.ry * k.nx;
        k.mass = 1 + (k.rn * k.rn) / I;
        k.want = k.ny ? (vn < -hop ? -up * vn : 0) : (vn < -edgeHop ? -lose * vn : 0);
        k.j = 0;
      }
      // Two corners at once, a rectangle coming down flat first of all, are
      // worked out together and exactly: taken one after the other they
      // left a turn of a millionth of a degree on a picture that fell
      // straight, and a picture that turns at all is exported the long way.
      let rounds = 12;
      if (list.length === 2) {
        const [p, q] = list;
        const pq = p.nx * q.nx + p.ny * q.ny + (p.rn * q.rn) / I;
        const det = p.mass * q.mass - pq * pq;
        const bp = p.want - ((vx - av * p.ry) * p.nx + (vy + av * p.rx) * p.ny);
        const bq = q.want - ((vx - av * q.ry) * q.nx + (vy + av * q.rx) * q.ny);
        const jp = (bp * q.mass - bq * pq) / det;
        const jq = (bq * p.mass - bp * pq) / det;
        if (Math.abs(det) > 1e-9 && jp >= 0 && jq >= 0) {
          vx += jp * p.nx + jq * q.nx;
          vy += jp * p.ny + jq * q.ny;
          av += (jp * p.rn + jq * q.rn) / I;
          rounds = 0;
        }
      }
      for (let round = 0; round < rounds; round += 1) {
        for (const k of list) {
          const vn = (vx - av * k.ry) * k.nx + (vy + av * k.rx) * k.ny;
          const j = Math.max(0, k.j + (k.want - vn) / k.mass);
          const d = j - k.j;
          k.j = j;
          vx += d * k.nx;
          vy += d * k.ny;
          av += (d * k.rn) / I;
        }
      }
      // A landing leaves it with no more energy than it came with: put
      // back out of the floor it stands higher than
      // it climbed, which at 100% Bounciness added a little to every jump.
      // Only a landing: on a rectangle standing on one corner, held to this
      // step after step, it took away the little speed it tips over by, and
      // the rectangle stood there for good.
      if (landing) {
        const now = energy();
        if (now > cap) {
          const own = (vy * vy + I * av * av) / 2;
          const room = cap - g * (H - y) - (vx * vx) / 2;
          if (own > 0) {
            const k = Math.sqrt(Math.max(0, room) / own);
            vy *= k;
            av *= k;
          }
        } else {
          cap = now;
        }
      }
      // Out of the border it is in.
      let down = 0;
      let side = 0;
      for (const k of list) {
        if (k.ny) down = Math.max(down, k.depth);
        else if (Math.abs(k.depth) > Math.abs(side)) side = k.depth * k.nx;
      }
      if (down > 0) y -= down;
      x += side;
      if (!onFloor || landing) return;
      const speed = Math.abs(vy) + Math.abs(av) * R;
      if (speed < TUNING.calm * H) {
        const k = Math.exp(-TUNING.calmRate * dt);
        vy *= k;
        av *= k;
      }
      // Standing on one corner with its middle right above it, it would
      // stand there for good: it tips, always the same way.
      if (onFloor === 1 && Math.abs(av) * R < 2) {
        const k = list.find((q) => q.ny);
        if (Math.abs(k.rx) < 0.5) av += 0.05;
      }
      // Flat on the floor and slow: laid down, and from here it only slides.
      // Two corners on the floor are already as good as flat, on a short
      // side by a wider angle than on a long one, and held there by both.
      const quarter = Math.round(a / (Math.PI / 2));
      const flat = Math.max(TUNING.flat, 1.5 / Math.min(bw, bh));
      if (onFloor >= 2 && Math.abs(a - quarter * (Math.PI / 2)) < flat
        && Math.abs(av) * R < TUNING.flatSpeed * H && Math.abs(vy) < hop) {
        const turned = Math.abs(quarter) % 2 === 1;
        a = quarter * (Math.PI / 2);
        quarters = quarter;
        lyingHigh = (turned ? bw : bh) / 2;
        lying = (turned ? bh : bw) / 2;
        // On its side its top edge may fall on an odd pixel, which the
        // encoder would lay one higher, a line of nothing under it. It lies
        // one pixel lower instead, in the preview and in the file alike.
        const top = H - lyingHigh - layY;
        if (Number.isInteger(top) && Math.abs(top) % 2 === 1) lyingHigh -= 1;
        y = floor - lyingHigh;
        vy = 0;
        av = 0;
        mode = FLOOR;
      }
    }

    const step = ball ? stepBall : stepBox;
    const total = Math.max(0, Math.ceil((Number(o.until) - from) / dt - 1e-9));
    let next = 0;
    record(from);
    for (let i = 0; i < total; i += 1) {
      const t = from + i * dt;
      let thrown = false;
      while (next < throws.length && throws[next].t <= t + 1e-9) {
        const k = throws[next];
        vx = k.velocity;
        av = k.spin * Math.PI / 180;
        drag = Math.min(1, Math.max(0, k.drag));
        bounce = Math.min(1, Math.max(0, k.bounce));
        promised = null;
        apex = y;
        next += 1;
        thrown = true;
      }
      if (thrown) {
        // Where it stood until now, when it stood.
        if (mode === REST && out.t[out.t.length - 1] < t - 1e-9) record(t);
        mode = AIR;
        rest = null;
        quarters = null;
        const reach = reachOf();
        floor = Math.max(floor, y + reach.y);
        if (walls) {
          left = Math.min(left, x - reach.x);
          right = Math.max(right, x + reach.x);
        }
        cap = energy();
      }
      if (mode === REST) {
        if (next >= throws.length) break;
        continue;
      }
      closeIn();
      step(from + (i + 1) * dt);
      record(from + (i + 1) * dt);
    }
    out.rest = rest;
    return out;
  }

  /**
   * The moments of a path worth keeping: the indexes of those between which
   * a straight blend stays within TUNING.keep of every moment left out, for
   * a body reaching `reach` pixels from its middle. A touch is a corner in
   * the path, so it is always one of them.
   */
  function thin(path, reach) {
    const n = path.t.length;
    if (n <= 2) return path.t.map((_, i) => i);
    const far = TUNING.keep;
    const farTurn = (TUNING.keep / Math.max(1, reach)) * 180 / Math.PI;
    const fits = (i, j) => {
      const span = path.t[j] - path.t[i];
      for (let k = i + 1; k < j; k += 1) {
        const u = (path.t[k] - path.t[i]) / span;
        if (Math.abs(path.x[i] + (path.x[j] - path.x[i]) * u - path.x[k]) > far) return false;
        if (Math.abs(path.y[i] + (path.y[j] - path.y[i]) * u - path.y[k]) > far) return false;
        if (Math.abs(path.turn[i] + (path.turn[j] - path.turn[i]) * u - path.turn[k]) > farTurn) return false;
      }
      return true;
    };
    const keep = [0];
    let i = 0;
    while (i < n - 1) {
      const last = Math.min(n - 1, i + TUNING.span);
      let j = i + 1;
      while (j < last && fits(i, j + 1)) j += 1;
      keep.push(j);
      i = j;
    }
    return keep;
  }

  const wrapped = (deg) => {
    const n = deg % 360;
    const w = n <= -180 ? n + 360 : (n > 180 ? n - 360 : n);
    return w === 0 ? 0 : w;
  };

  /**
   * A layer's placements with its Gravity on, as geometry.js shownKeys has
   * them: `[{ t, src, dest, rotation, turn, window }]` in time order. Until
   * the Gravity's first keyframe the picture is wherever its own keyframes
   * and its transition put it; from there it is the body's path, the size
   * and the part of the source it had at that moment kept. After the last
   * entry it stands. Null for a layer without a Gravity that ever starts.
   */
  function keysOf(layer, source, project) {
    const spec = model.gravityOf(layer);
    if (!spec || !source || !project) return null;
    const from = spec.throws[0].t;
    if (!(from < layer.duration)) return null;
    const steps = model.transitionSteps(layer);
    const base = (steps.length && geo.shownKeys(layer, source, project, steps))
      || geo.motionOf(layer, source, project);
    const start = base ? geo.shownPlacementAt(base, from) : geo.placementAt(layer, from, source, project);
    if (!start) return null;
    const W = Number(project.width);
    const H = Number(project.height);
    if (!(W > 0) || !(H > 0)) return null;
    const d = start.dest;
    const body = spec.body === 'ball'
      ? { kind: 'ball', r: Math.min(d.width, d.height) / 2 }
      : { kind: 'box', w: d.width, h: d.height };
    const path = simulate({
      W,
      H,
      body,
      x: d.x + d.width / 2,
      y: d.y + d.height / 2,
      half: { x: d.width / 2, y: d.height / 2 },
      turn: start.rotation || 0,
      walls: spec.walls,
      until: layer.duration,
      throws: spec.throws.map((k) => ({
        t: k.t,
        velocity: (k.velocity / 100) * H,
        spin: k.spin,
        drag: k.drag / 100,
        bounce: k.bounce / 100,
      })),
    });
    const out = [];
    for (const k of base || []) {
      if (k.t < from - 1e-9) {
        out.push({ t: k.t, src: k.src, dest: k.dest, rotation: wrapped(k.turn), turn: k.turn, window: k.window || null });
      }
    }
    const reach = body.kind === 'ball' ? body.r : Math.hypot(body.w, body.h) / 2;
    for (const i of thin(path, reach)) {
      out.push({
        t: path.t[i],
        src: start.src,
        dest: { x: path.x[i] - d.width / 2, y: path.y[i] - d.height / 2, width: d.width, height: d.height },
        rotation: wrapped(path.turn[i]),
        turn: path.turn[i],
        window: start.window || null,
      });
    }
    return out;
  }

  return { TUNING, simulate, thin, keysOf };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = layerGravity;
