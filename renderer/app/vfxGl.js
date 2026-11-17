'use strict';

// V5.1. The preview's side of the VFX ops (src/vfxOps.js): each op done on
// the graphics card by a small shader that works out what the encoder's
// filter for that op works out, on whole 0 to 255 values where the filter
// does, so the preview is the export's picture and not a look-alike.
//
// One WebGL2 surface, kept. A picture comes in as a canvas, goes through the
// passes its ops make, each from the last one's result, and the surface
// itself is the result, drawn on by the caller. Colours are premultiplied on
// the way in and out, as a canvas has them; a pass that works on colours
// takes the alpha off first and puts it back.
//
// Everything a pass is told of the picture is in the source's terms: `uScale`
// is how many pixels here one source pixel is, and `uPic` where the whole
// source picture lies on this surface, so a lens bends about the picture's
// middle and lines are counted from its corner whatever part of it shows.
//
// Without WebGL2, or with its context lost for good, `run` gives null and the
// picture is shown without the VFX; the export does not depend on any of it.

const vfxGl = (() => {
  let canvas = null;
  let gl = null;
  let failed = false;
  let quad = null;
  const programs = new Map();
  const targets = [null, null];
  let sourceTex = null;
  const luts = new Map();
  // V5.1. Apply LUT's files, by their path: { state: 'loading' | 'ok' | 'bad',
  // n, data, lo, hi, tex }. Read once; a file changed on the disk is read
  // again when the window is opened again.
  const cubes = new Map();

  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform sampler2D uOrig;
uniform vec2 uSize;
uniform vec2 uScale;
uniform vec4 uPic;
uniform float uTime;
// This pixel's middle, counted from the top left.
vec2 pix() { return vec2(vUv.x, 1.0 - vUv.y) * uSize; }
vec4 at(sampler2D t, vec2 p) { return texture(t, vec2(p.x, uSize.y - p.y) / uSize); }
// A colour without its alpha, as whole values 0 to 255.
vec3 whole(vec4 c) { return c.a > 0.0 ? floor(c.rgb / c.a * 255.0 + 0.5) : vec3(0.0); }
vec4 back(vec3 v, float a) { return vec4(clamp(v, 0.0, 255.0) / 255.0 * a, a); }
`;

  const FRAG = {
    // A table per channel, the channels mixed, a table again: lutrgb,
    // colorchannelmixer (which rounds each of its nine products), lutrgb.
    colour: `
uniform sampler2D uLutA;
uniform sampler2D uLutB;
uniform float uHasA;
uniform float uHasM;
uniform float uHasB;
uniform vec3 uRowR;
uniform vec3 uRowG;
uniform vec3 uRowB;
vec3 look(sampler2D t, vec3 v) {
  return vec3(texelFetch(t, ivec2(int(v.r), 0), 0).r, texelFetch(t, ivec2(int(v.g), 0), 0).g,
    texelFetch(t, ivec2(int(v.b), 0), 0).b) * 255.0;
}
float mixed(vec3 v, vec3 row) {
  vec3 p = floor(v * row + 0.5);
  return clamp(p.r + p.g + p.b, 0.0, 255.0);
}
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 v = whole(c);
  if (uHasA > 0.5) v = floor(look(uLutA, v) + 0.5);
  if (uHasM > 0.5) v = vec3(mixed(v, uRowR), mixed(v, uRowG), mixed(v, uRowB));
  if (uHasB > 0.5) v = floor(look(uLutB, v) + 0.5);
  outColor = back(v, c.a);
}`,
    // colorhold: how far a colour is from the one kept, and grey by that much.
    hold: `
uniform vec3 uColor;
uniform float uSim;
uniform float uBlend;
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 v = whole(c);
  vec3 d = v - uColor;
  float diff = sqrt(dot(d, d) / (255.0 * 255.0 * 3.0));
  float t = uBlend > 0.0001 ? clamp((diff - uSim) / uBlend, 0.0, 1.0) * 255.0 : (diff > uSim ? 255.0 : 0.0);
  t = floor(t);
  if (t > 0.0) {
    float g = floor((v.r + v.g + v.b) / 3.0);
    v = floor((g * t + v * (255.0 - t) + 127.0) / 255.0);
  }
  outColor = back(v, c.a);
}`,
    // convolution, 3 by 3, the same kernel on every channel.
    conv: `
uniform float uK[9];
uniform float uDiv;
uniform vec2 uStep;
void main() {
  vec2 p = pix();
  float a = texture(uTex, vUv).a;
  vec3 sum = vec3(0.0);
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      sum += uK[j * 3 + i] * whole(at(uTex, p + vec2(float(i - 1), float(j - 1)) * uStep));
    }
  }
  outColor = back(floor(sum / uDiv + 0.5), a);
}`,
    sobel: `
uniform float uGain;
uniform vec2 uStep;
vec3 s(vec2 p, float x, float y) { return whole(at(uTex, p + vec2(x, y) * uStep)); }
void main() {
  vec2 p = pix();
  float a = texture(uTex, vUv).a;
  vec3 c0 = s(p, -1.0, -1.0); vec3 c1 = s(p, 0.0, -1.0); vec3 c2 = s(p, 1.0, -1.0);
  vec3 c3 = s(p, -1.0, 0.0); vec3 c5 = s(p, 1.0, 0.0);
  vec3 c6 = s(p, -1.0, 1.0); vec3 c7 = s(p, 0.0, 1.0); vec3 c8 = s(p, 1.0, 1.0);
  vec3 gx = -c0 + c2 - 2.0 * c3 + 2.0 * c5 - c6 + c8;
  vec3 gy = -c0 - 2.0 * c1 - c2 + c6 + 2.0 * c7 + c8;
  outColor = back(floor(sqrt(gx * gx + gy * gy) * uGain), a);
}`,
    // A Gaussian one way. Past a sigma of a few pixels it steps wider than a
    // pixel, the samples then being taken between pixels.
    blur: `
uniform vec2 uDir;
uniform float uSigma;
void main() {
  vec2 p = pix();
  float s = max(uSigma, 0.01);
  float stride = max(1.0, 3.0 * s / 40.0);
  vec4 sum = at(uTex, p);
  float total = 1.0;
  for (int i = 1; i <= 40; i++) {
    float x = float(i) * stride;
    if (x > 3.0 * s + 0.5) break;
    float w = exp(-0.5 * x * x / (s * s));
    sum += w * (at(uTex, p + uDir * x) + at(uTex, p - uDir * x));
    total += 2.0 * w;
  }
  outColor = sum / total;
}`,
    // rgbashift: red one way by so many pixels, blue the other.
    shift: `
uniform vec2 uShift;
void main() {
  vec2 p = pix();
  vec4 c = at(uTex, p);
  outColor = vec4(at(uTex, p - uShift).r, c.g, at(uTex, p + uShift).b, c.a);
}`,
    // lenscorrection: each pixel from further out or further in by the square
    // of how far it is from the middle, counted against half the diagonal.
    lens: `
uniform float uK1;
uniform vec2 uMid;
void main() {
  vec2 p = pix();
  vec2 size = uPic.zw / uScale;
  vec2 sp = (p - uPic.xy) / uScale - 0.5;
  // The filter's middle: a share of the picture, cut to a whole pixel.
  vec2 mid = floor(size * uMid);
  vec2 off = sp - mid;
  float r2 = dot(off, off) * 4.0 / dot(size, size);
  // Half a pixel on, both ways: the encoder's filter reads there when it
  // smooths between pixels (its own rounding), and the preview shows what
  // the export will be.
  vec2 q = mid + (1.0 + uK1 * r2) * off + 0.5;
  if (floor(q.x) < 0.0 || floor(q.y) < 0.0 || floor(q.x) > size.x - 1.0 || floor(q.y) > size.y - 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = at(uTex, (q + 0.5) * uScale + uPic.xy);
}`,
    flip: `
uniform vec2 uFlip;
void main() {
  vec2 p = pix();
  vec2 turned = uPic.xy + uPic.zw - (p - uPic.xy);
  outColor = at(uTex, mix(p, turned, uFlip));
}`,
    // One half folded onto the other: 0 the left kept, 1 the right, 2 the top, 3 the bottom.
    mirror: `
uniform float uSide;
void main() {
  vec2 p = pix();
  vec2 rel = (p - uPic.xy) / uPic.zw;
  if (uSide < 0.5) { if (rel.x > 0.5) rel.x = 1.0 - rel.x; }
  else if (uSide < 1.5) { if (rel.x < 0.5) rel.x = 1.0 - rel.x; }
  else if (uSide < 2.5) { if (rel.y > 0.5) rel.y = 1.0 - rel.y; }
  else { if (rel.y < 0.5) rel.y = 1.0 - rel.y; }
  outColor = at(uTex, rel * uPic.zw + uPic.xy);
}`,
    // drawgrid: lines counted in source pixels from the picture's corner,
    // each pixel here darkened by as much of it as lines cover.
    grid: `
uniform float uPeriod;
uniform float uThick;
uniform float uAlpha;
uniform float uVertical;
float lined(float y) {
  float n = floor(y / uPeriod);
  return n * uThick + min(y - n * uPeriod, uThick);
}
void main() {
  vec2 p = pix();
  vec4 c = at(uTex, p);
  float y = uVertical > 0.5 ? (p.x - uPic.x) / uScale.x : (p.y - uPic.y) / uScale.y;
  float half_ = 0.5 / (uVertical > 0.5 ? uScale.x : uScale.y);
  float cover = (lined(y + half_) - lined(y - half_)) / (2.0 * half_);
  outColor = vec4(c.rgb * (1.0 - uAlpha * clamp(cover, 0.0, 1.0)), c.a);
}`,
    // noise: grain on the brightness, even between its two ends, new on
    // every frame. Not the encoder's own grains, which no one could tell.
    noise: `
uniform float uAmount;
uniform float uChroma;
float hash(vec3 q) {
  q = fract(q * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec2 p = pix();
  vec4 c = at(uTex, p);
  float soften = min(1.0, min(uScale.x, uScale.y));
  float t = floor(uTime * 1000.0);
  float k = uAmount * soften / 255.0;
  float n = (hash(vec3(floor(p), t)) - 0.5) * k * (255.0 / 219.0);
  vec3 add = vec3(n);
  if (uChroma > 0.5) {
    // The colour planes too, each with grains of its own, as they come out in red, green and blue.
    float u = (hash(vec3(floor(p) + 311.0, t + 7.0)) - 0.5) * k * (255.0 / 224.0);
    float w = (hash(vec3(floor(p) + 733.0, t + 13.0)) - 0.5) * k * (255.0 / 224.0);
    add += vec3(1.5748 * w, -0.1873 * u - 0.4681 * w, 1.8556 * u);
  }
  outColor = vec4(clamp(c.rgb + add * c.a, 0.0, c.a), c.a);
}`,
    // Clarity: the picture less its blur, about a middle grey (grainextract),
    // scaled as the encoder's table scales it, and added back (grainmerge).
    detail: `
uniform float uK;
void main() {
  vec4 o = texture(uOrig, vUv);
  vec3 a = whole(o);
  vec3 b = whole(texture(uTex, vUv));
  vec3 d = clamp(a - b + 128.0, 0.0, 255.0);
  vec3 e = clamp(trunc(128.0 + (d - 128.0) * uK), 0.0, 255.0);
  outColor = back(a + e - 128.0, o.a);
}`,
    // Comic: this pass's outlines turned round, multiplied onto the picture
    // as it came in few levels (the table), as blend=multiply does it.
    comic: `
uniform sampler2D uLutA;
void main() {
  vec4 o = texture(uOrig, vUv);
  vec3 v = whole(o);
  vec3 p = vec3(texelFetch(uLutA, ivec2(int(v.r), 0), 0).r, texelFetch(uLutA, ivec2(int(v.g), 0), 0).g,
    texelFetch(uLutA, ivec2(int(v.b), 0), 0).b) * 255.0;
  p = floor(p + 0.5);
  vec3 e = 255.0 - whole(texture(uTex, vUv));
  outColor = back(floor(p * e / 255.0), o.a);
}`,
    // drawbox with a thickness: one colour along the picture's edges, so many source pixels deep.
    frame: `
uniform float uPx;
uniform vec3 uColor;
void main() {
  vec2 p = pix();
  vec4 c = at(uTex, p);
  vec2 sp = (p - uPic.xy) / uScale;
  vec2 size = uPic.zw / uScale;
  vec2 d = min(sp, size - sp);
  vec2 h = 0.5 / uScale;
  vec2 cover = clamp((uPx - (d - h)) / (2.0 * h), 0.0, 1.0);
  float k = uPx > 0.0 ? max(cover.x, cover.y) : 0.0;
  outColor = vec4(mix(c.rgb, uColor / 255.0 * c.a, k), c.a);
}`,
    // rotate: turned clockwise about the picture's middle, black where nothing comes from.
    rotate: `
uniform float uAngle;
void main() {
  vec2 p = pix();
  vec2 size = uPic.zw / uScale;
  vec2 sp = (p - uPic.xy) / uScale - 0.5;
  // About the middle of the first and the last pixel, each way: measured,
  // half a turn puts pixel 100 of 400 on pixel 299.
  vec2 mid = (size - 1.0) * 0.5;
  vec2 off = sp - mid;
  float c = cos(uAngle);
  float s = sin(uAngle);
  vec2 q = vec2(c * off.x + s * off.y, -s * off.x + c * off.y) + mid;
  if (q.x < -0.5 || q.y < -0.5 || q.x > size.x - 0.5 || q.y > size.y - 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  outColor = at(uTex, (q + 0.5) * uScale + uPic.xy);
}`,
    // geq: every pixel from somewhere else in the picture, by the rule
    // vfxOps.warpExpr writes for the encoder, worked out again here. 0 wave,
    // 1 ripple, 2 swirl, 3 zoom, 4 shake, 5 glitch, 6 haze, 7 tile,
    // 8 kaleidoscope, 9 perspective, 10 bulge; uA and uB its figures.
    warp: `
uniform float uForm;
uniform vec4 uA;
uniform vec4 uB;
int imod(int a, int b) { return a - b * (a / b); }
void main() {
  vec2 p = pix();
  vec2 size = uPic.zw / uScale;
  vec2 sp = (p - uPic.xy) / uScale - 0.5;
  float T = uTime;
  vec2 q = sp;
  if (uForm < 0.5) {
    if (uA.w > 0.5) q.y = sp.y + uA.x * sin(uA.y * sp.x + uA.z * T);
    else q.x = sp.x + uA.x * sin(uA.y * sp.y + uA.z * T);
  } else if (uForm < 1.5) {
    vec2 o = sp - uB.xy;
    float r = length(o);
    q = sp + o * (uA.x * sin(uA.y * r - uA.z * T) / max(r, 1.0));
  } else if (uForm < 2.5) {
    vec2 o = sp - uB.xy;
    float t = max(0.0, 1.0 - length(o) / uA.y);
    float th = uA.x * t * t;
    q = uB.xy + vec2(cos(th) * o.x - sin(th) * o.y, sin(th) * o.x + cos(th) * o.y);
  } else if (uForm < 3.5) {
    q = uB.xy + uA.yz + (sp - uB.xy) * uA.x;
  } else if (uForm < 4.5) {
    float w = uA.y;
    vec2 d = uA.x * vec2(0.6 * sin(w * T) + 0.4 * sin(2.3 * w * T + 1.3), 0.6 * cos(1.1 * w * T + 0.7) + 0.4 * sin(2.9 * w * T));
    q = uB.xy + (sp - uB.xy) * uA.z + d;
  } else if (uForm > 5.5 && uForm < 6.5) {
    q.x = sp.x + uA.x * sin(uA.y * sp.y + uA.z * T + 2.0 * sin(0.7 * uA.y * sp.x));
    q.y = sp.y + uA.x * cos(1.3 * uA.y * sp.x + 1.7 * uA.z * T);
  } else if (uForm > 6.5 && uForm < 7.5) {
    q = mod((sp + 0.5) * uA.x, uB.zw) - 0.5;
  } else if (uForm > 7.5 && uForm < 8.5) {
    vec2 o = sp - uB.xy;
    float r = length(o);
    float th = abs(mod(atan(o.y, o.x) - uA.y + 25.132741, uA.x) - uA.x * 0.5) + uA.y;
    q = uB.xy + r * vec2(cos(th), sin(th));
  } else if (uForm > 9.5) {
    vec2 o = sp - uB.xy;
    float t = max(0.0, 1.0 - length(o) / uA.y);
    q = uB.xy + o * (1.0 - uA.x * t * t);
  } else if (uForm > 8.5) {
    vec2 o = sp - uB.xy;
    float d = 1.0 + uA.x * o.x + uA.y * o.y;
    q = uB.xy + o / d;
    if (q.x < 0.0 || q.y < 0.0 || q.x > size.x - 1.0 || q.y > size.y - 1.0) {
      outColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }
  } else {
    int n = imod(int(floor(sp.y / uA.y)), 89);
    int k = imod(int(floor(T * uA.z + 0.01)), 97);
    float far = float(imod(n * 7 + k * 13 + n * k * 3, 17)) / 8.0 - 1.0;
    float on = imod(n * 3 + k * 5 + n * k, 7) < 2 ? 1.0 : 0.0;
    q.x = sp.x + uA.x * far * on;
  }
  q = clamp(q, vec2(0.0), size - 1.0);
  outColor = at(uTex, (q + 0.5) * uScale + uPic.xy);
}`,
    // lut3d: each colour looked up in the file's table, between its entries
    // smoothed all three ways.
    lut3d: `
uniform highp sampler3D uCube;
uniform float uN;
uniform vec3 uLo;
uniform vec3 uHi;
void main() {
  vec4 c = texture(uTex, vUv);
  vec3 v = clamp((whole(c) / 255.0 - uLo) / (uHi - uLo), 0.0, 1.0);
  vec3 r = texture(uCube, (v * (uN - 1.0) + 0.5) / uN).rgb;
  outColor = back(floor(clamp(r, 0.0, 1.0) * 255.0 + 0.5), c.a);
}`,
    // drawbox, filled: black bars at two facing edges, so many source pixels deep.
    bars: `
uniform float uPx;
uniform float uVertical;
void main() {
  vec2 p = pix();
  vec4 c = at(uTex, p);
  float k = uVertical > 0.5 ? uScale.x : uScale.y;
  float y = (uVertical > 0.5 ? (p.x - uPic.x) : (p.y - uPic.y)) / k;
  float size = (uVertical > 0.5 ? uPic.z : uPic.w) / k;
  float h = 0.5 / k;
  float near = clamp((uPx - (y - h)) / (2.0 * h), 0.0, 1.0);
  float far = clamp(((y + h) - (size - uPx)) / (2.0 * h), 0.0, 1.0);
  float cover = uPx > 0.0 ? max(near, far) : 0.0;
  outColor = vec4(c.rgb * (1.0 - cover), c.a);
}`,
    // scroll: moved round by so many source pixels, wrapping at the picture's edges.
    scroll: `
uniform vec2 uMove;
void main() {
  vec2 p = pix();
  vec2 rel = mod(p - uPic.xy - uMove * uScale, uPic.zw);
  outColor = at(uTex, rel + uPic.xy);
}`,
    // blend=screen: the picture as it came with this pass's laid on.
    screen: `
void main() {
  vec4 o = texture(uOrig, vUv);
  vec4 g = texture(uTex, vUv);
  vec3 a = whole(o);
  vec3 b = whole(g);
  outColor = back(255.0 - floor((255.0 - a) * (255.0 - b) / 255.0), o.a);
}`,
  };

  function start() {
    if (gl && !gl.isContextLost()) return true;
    if (failed) return false;
    try {
      canvas = new OffscreenCanvas(2, 2);
      gl = canvas.getContext('webgl2', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true,
      });
    } catch (err) {
      gl = null;
    }
    if (!gl) {
      failed = true;
      return false;
    }
    programs.clear();
    luts.clear();
    for (const cube of cubes.values()) cube.tex = null;
    targets[0] = null;
    targets[1] = null;
    sourceTex = null;
    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    return true;
  }

  function program(name) {
    let p = programs.get(name);
    if (p) return p;
    const make = (type, text) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error('vfxGl ' + name + ': ' + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, make(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, make(gl.FRAGMENT_SHADER, HEAD + FRAG[name]));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('vfxGl ' + name + ': ' + gl.getProgramInfoLog(prog));
    p = { prog, at: new Map() };
    programs.set(name, p);
    return p;
  }

  function loc(p, name) {
    if (!p.at.has(name)) p.at.set(name, gl.getUniformLocation(p.prog, name));
    return p.at.get(name);
  }

  function texture(w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  function target(i, w, h) {
    let t = targets[i];
    if (t && t.w === w && t.h === h) return t;
    if (t) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    const tex = texture(w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    t = { tex, fbo, w, h };
    targets[i] = t;
    return t;
  }

  /** The three tables of a colour op as one texture 256 wide: red's in its red, and so on. */
  function lut(exprs) {
    const key = exprs.join('|');
    let t = luts.get(key);
    if (t) return t;
    const r = vfxOps.tableOf(exprs[0]);
    const g = vfxOps.tableOf(exprs[1]);
    const b = vfxOps.tableOf(exprs[2]);
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i += 1) {
      data[i * 4] = r[i];
      data[i * 4 + 1] = g[i];
      data[i * 4 + 2] = b[i];
      data[i * 4 + 3] = 255;
    }
    if (luts.size >= 96) {
      const old = luts.keys().next().value;
      gl.deleteTexture(luts.get(old));
      luts.delete(old);
    }
    t = gl.createTexture();
    // Made on a unit no pass reads from: made on the one in use it took the
    // picture's place there, and a pass that reads the picture as it came
    // (Comic) drew the table instead, for the one frame the table was new.
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    luts.set(key, t);
    return t;
  }

  /**
   * V5.1. A LUT file's table, read the first time it is asked for. Returns
   * what is known of it now; the picture is drawn again when it has arrived.
   */
  function cube(file) {
    let entry = cubes.get(file);
    if (entry) return entry;
    entry = { state: 'loading', done: null };
    cubes.set(file, entry);
    entry.done = Promise.resolve()
      .then(() => window.lwclipper.readLut(file))
      .then((got) => {
        const table = got && got.ok ? vfxOps.parseCube(got.text) : { ok: false };
        Object.assign(entry, table.ok ? { state: 'ok', ...table } : { state: 'bad' });
      })
      .catch(() => { entry.state = 'bad'; })
      .then(() => {
        if (typeof drawComposite === 'function' && typeof compositePlaying !== 'undefined' && !compositePlaying) drawComposite();
        if (typeof paintVfxStage === 'function') paintVfxStage();
        if (typeof showVfxSettings === 'function') showVfxSettings(null);
      });
    return entry;
  }

  /** Whether a LUT file's table is there to be used, once it has been read. */
  async function cubeReady(file) {
    const entry = cube(file);
    await entry.done;
    return entry.state === 'ok';
  }

  /** A LUT file read again from the disk the next time it is asked for. */
  function forgetCube(file) {
    const entry = cubes.get(file);
    if (entry && entry.tex && gl) gl.deleteTexture(entry.tex);
    cubes.delete(file);
  }

  function cubeTexture(entry) {
    if (entry.tex) return entry.tex;
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_3D, t);
    for (const [name, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_3D, name, value);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, entry.n, entry.n, entry.n, 0, gl.RGB, gl.FLOAT, entry.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    entry.tex = t;
    return t;
  }

  /**
   * The passes ops make, for a picture drawn `kx` by `ky` pixels to one of
   * the source's. Each `{ prog, u, lutA, lutB }`.
   */
  function passesOf(ops, kx, ky) {
    const out = [];
    const step = [Math.max(1, kx), Math.max(1, ky)];
    const blur = (sx, sy) => {
      if (sx > 0) out.push({ prog: 'blur', u: { uDir: [1, 0], uSigma: sx * kx } });
      if (sy > 0) out.push({ prog: 'blur', u: { uDir: [0, 1], uSigma: sy * ky } });
    };
    for (const o of ops) {
      if (o.op === 'colour') {
        const m = o.m || [1, 0, 0, 0, 1, 0, 0, 0, 1];
        out.push({
          prog: 'colour',
          lutA: o.a,
          lutB: o.b,
          u: {
            uHasA: o.a ? 1 : 0, uHasM: o.m ? 1 : 0, uHasB: o.b ? 1 : 0,
            uRowR: m.slice(0, 3), uRowG: m.slice(3, 6), uRowB: m.slice(6, 9),
          },
        });
      } else if (o.op === 'hold') {
        out.push({ prog: 'hold', u: { uColor: o.color, uSim: o.sim, uBlend: o.blend } });
      } else if (o.op === 'conv') {
        out.push({ prog: 'conv', u: { uK: o.k, uDiv: o.div, uStep: step } });
      } else if (o.op === 'sobel') {
        out.push({ prog: 'sobel', u: { uGain: o.scale, uStep: step } });
      } else if (o.op === 'blur') {
        blur(o.sx, o.sy);
      } else if (o.op === 'shift') {
        out.push({ prog: 'shift', u: { uShift: [o.dx * kx, o.dy * ky] } });
      } else if (o.op === 'lens') {
        out.push({ prog: 'lens', u: { uK1: o.k1, uMid: [o.cx === undefined ? 0.5 : o.cx, o.cy === undefined ? 0.5 : o.cy] } });
      } else if (o.op === 'flip') {
        out.push({ prog: 'flip', u: { uFlip: [o.h ? 1 : 0, o.v ? 1 : 0] } });
      } else if (o.op === 'mirror') {
        out.push({ prog: 'mirror', u: { uSide: ['left', 'right', 'top', 'bottom'].indexOf(o.side) } });
      } else if (o.op === 'grid') {
        out.push({ prog: 'grid', u: { uPeriod: o.period, uThick: o.thick, uAlpha: o.alpha, uVertical: o.vertical ? 1 : 0 } });
      } else if (o.op === 'noise') {
        out.push({ prog: 'noise', u: { uAmount: o.s, uChroma: o.chroma ? 1 : 0 } });
      } else if (o.op === 'comic') {
        out.push({ prog: 'colour', lutA: null, lutB: null,
          u: { uHasA: 0, uHasM: 1, uHasB: 0, uRowR: [0.2126, 0.7152, 0.0722], uRowG: [0.2126, 0.7152, 0.0722], uRowB: [0.2126, 0.7152, 0.0722] } });
        out.push({ prog: 'sobel', u: { uGain: o.k, uStep: step } });
        out.push({ prog: 'comic', lutA: [o.table, o.table, o.table], u: {} });
      } else if (o.op === 'frame') {
        out.push({ prog: 'frame', u: { uPx: o.px, uColor: o.color } });
      } else if (o.op === 'rotate') {
        out.push({ prog: 'rotate', u: { uAngle: (o.deg * Math.PI) / 180 } });
      } else if (o.op === 'lut3d') {
        // Nothing until the file's table has arrived, and nothing for a file
        // that is no table: the picture then shows as it is.
        const entry = cube(o.file);
        if (entry.state === 'ok') out.push({ prog: 'lut3d', cube: entry, u: { uN: entry.n, uLo: entry.lo, uHi: entry.hi } });
      } else if (o.op === 'warp') {
        const forms = ['wave', 'ripple', 'swirl', 'zoom', 'shake', 'glitch', 'haze', 'tile', 'kaleido', 'persp', 'bulge'];
        const figures = {
          wave: [[o.a, o.k, o.s, o.vertical ? 1 : 0], [0, 0, 0, 0]],
          ripple: [[o.a, o.k, o.s, 0], [o.cx, o.cy, 0, 0]],
          swirl: [[o.angle, o.rad, 0, 0], [o.cx, o.cy, 0, 0]],
          zoom: [[o.iz, o.px, o.py, 0], [o.cx, o.cy, 0, 0]],
          shake: [[o.a, o.w, o.iz, 0], [o.cx, o.cy, 0, 0]],
          glitch: [[o.a, o.slice, o.rate, 0], [0, 0, 0, 0]],
          haze: [[o.a, o.k, o.s, 0], [0, 0, 0, 0]],
          tile: [[o.n, 0, 0, 0], [0, 0, o.W, o.H]],
          kaleido: [[o.seg, o.rot, 0, 0], [o.cx, o.cy, 0, 0]],
          persp: [[o.a, o.b, 0, 0], [o.cx, o.cy, 0, 0]],
          bulge: [[o.s, o.rad, 0, 0], [o.cx, o.cy, 0, 0]],
        }[o.form];
        out.push({ prog: 'warp', u: { uForm: forms.indexOf(o.form), uA: figures[0], uB: figures[1] } });
      } else if (o.op === 'bars') {
        out.push({ prog: 'bars', u: { uPx: o.px, uVertical: o.vertical ? 1 : 0 } });
      } else if (o.op === 'scroll') {
        out.push({ prog: 'scroll', u: { uMove: [o.dx, o.dy] } });
      } else if (o.op === 'clarity') {
        blur(o.sigma, o.sigma);
        out.push({ prog: 'detail', u: { uK: o.k } });
      } else if (o.op === 'glow') {
        out.push({ prog: 'colour', lutA: o.tables, lutB: null,
          u: { uHasA: 1, uHasM: 0, uHasB: 0, uRowR: [1, 0, 0], uRowG: [0, 1, 0], uRowB: [0, 0, 1] } });
        blur(o.sigma, o.sigma);
        out.push({ prog: 'screen', u: {} });
      }
    }
    return out;
  }

  /**
   * A picture through passes. `source` is a canvas; `about` is `{ scale: [kx,
   * ky], pic: [x, y, w, h], time }`, the whole source picture's place on it
   * in its pixels and the moment drawn. Returns the surface with the result,
   * as big as `source`, to be drawn from at once, or null when it cannot.
   */
  function run(source, about, passes) {
    if (!passes.length || !start()) return null;
    const w = source.width;
    const h = source.height;
    if (!(w > 0) || !(h > 0)) return null;
    try {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      gl.viewport(0, 0, w, h);
      if (!sourceTex) sourceTex = texture(0, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      let from = sourceTex;
      passes.forEach((pass, i) => {
        const last = i === passes.length - 1;
        const to = last ? null : target(i % 2, w, h);
        const p = program(pass.prog);
        gl.useProgram(p.prog);
        gl.bindFramebuffer(gl.FRAMEBUFFER, to ? to.fbo : null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, from);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, sourceTex);
        gl.uniform1i(loc(p, 'uTex'), 0);
        gl.uniform1i(loc(p, 'uOrig'), 1);
        if (pass.lutA) {
          const t = lut(pass.lutA);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.uniform1i(loc(p, 'uLutA'), 2);
        }
        if (pass.lutB) {
          const t = lut(pass.lutB);
          gl.activeTexture(gl.TEXTURE3);
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.uniform1i(loc(p, 'uLutB'), 3);
        }
        if (pass.cube) {
          const t = cubeTexture(pass.cube);
          gl.activeTexture(gl.TEXTURE4);
          gl.bindTexture(gl.TEXTURE_3D, t);
          gl.uniform1i(loc(p, 'uCube'), 4);
        }
        gl.uniform2f(loc(p, 'uSize'), w, h);
        gl.uniform2f(loc(p, 'uScale'), about.scale[0], about.scale[1]);
        gl.uniform4f(loc(p, 'uPic'), about.pic[0], about.pic[1], about.pic[2], about.pic[3]);
        gl.uniform1f(loc(p, 'uTime'), Number(about.time) || 0);
        for (const [name, value] of Object.entries(pass.u)) {
          const at = loc(p, name);
          if (at === null) continue;
          if (typeof value === 'number') gl.uniform1f(at, value);
          else if (value.length === 2) gl.uniform2f(at, value[0], value[1]);
          else if (value.length === 3) gl.uniform3f(at, value[0], value[1], value[2]);
          else if (value.length === 4) gl.uniform4f(at, value[0], value[1], value[2], value[3]);
          else gl.uniform1fv(at, new Float32Array(value));
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (to) from = to.tex;
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return canvas;
    } catch (err) {
      console.error(err);
      return null;
    }
  }

  return { run, passesOf, cube, cubeReady, forgetCube };
})();
