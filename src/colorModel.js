'use strict';

// V3, 30d. The colour picker's arithmetic, kept out of the window so the rules
// the user set can be tested without one.
//
// The picker's state is hue, saturation, value and alpha, never RGB. RGB is
// worked out from it every time it is shown. That is the user's "dragging
// brightness to black and back does not lose the hue": black has no hue in
// RGB, so a picker that kept RGB would come back from black as grey. Typing a
// grey into R, G and B keeps the hue the same way, and typing black keeps the
// saturation too.
//
// Colours cross in and out as `#rrggbbaa`, the form timeline.colourOf keeps
// them in.

const colorModel = (() => {
  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function byte(v) {
    return clamp(Math.round(Number(v) || 0), 0, 255);
  }

  function hex2(n) {
    return byte(n).toString(16).padStart(2, '0');
  }

  /** Hue 0 to 360, saturation and value 0 to 1, into whole 0 to 255 channels. */
  function hsvToRgb(h, s, v) {
    const hue = ((Number(h) % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = v - c;
    let r = 0;
    let g = 0;
    let b = 0;
    if (hue < 60) [r, g, b] = [c, x, 0];
    else if (hue < 120) [r, g, b] = [x, c, 0];
    else if (hue < 180) [r, g, b] = [0, c, x];
    else if (hue < 240) [r, g, b] = [0, x, c];
    else if (hue < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255) };
  }

  /**
   * Channels into hue, saturation and value. Where the channels say nothing
   * about a part, a grey about its hue and black about its hue and saturation,
   * that part is taken from `keep`, which is the state the picker was already
   * in.
   */
  function rgbToHsv(r, g, b, keep) {
    const R = byte(r) / 255;
    const G = byte(g) / 255;
    const B = byte(b) / 255;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const d = max - min;
    const v = max;
    let s = max === 0 ? 0 : d / max;
    let h = 0;
    if (d > 0) {
      if (max === R) h = 60 * (((G - B) / d) % 6);
      else if (max === G) h = 60 * ((B - R) / d + 2);
      else h = 60 * ((R - G) / d + 4);
      if (h < 0) h += 360;
    } else if (keep) {
      h = keep.h;
    }
    if (max === 0 && keep) s = keep.s;
    return { h, s, v };
  }

  /** The state a stored colour opens the picker in. Nonsense opens as white. */
  function stateOf(color) {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(color || '').trim());
    const hex = m ? m[1] : 'ffffff';
    const a = m && m[2] ? parseInt(m[2], 16) : 255;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { ...rgbToHsv(r, g, b), a };
  }

  function rgbOf(state) {
    return hsvToRgb(state.h, state.s, state.v);
  }

  /** The six digit hex the Hex box shows, lowercase with its #. */
  function hexOf(state) {
    const c = rgbOf(state);
    return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
  }

  /** What the picker hands back: `#rrggbbaa`. */
  function colorOf(state) {
    return hexOf(state) + hex2(state.a);
  }

  /** New R, G and B typed in, everything else kept that the channels do not say. */
  function withRgb(state, r, g, b) {
    return { ...rgbToHsv(r, g, b, state), a: state.a };
  }

  /**
   * The Hex box as typed or pasted.
   *
   * Six digits are the colour; a leading # is optional. The user's rule for
   * eight, 2026-09-25: the 7th and 8th become A and the box is cut back to
   * six, and if those two are not valid hex, A stays as it was and the box is
   * still cut to six. Seven is someone halfway through typing eight, so it is
   * left alone and the first six are the colour. Anything past eight is cut.
   *
   * Hands back `text`, what the box should now hold (null to leave it as the
   * user has it), and `state`, the new state, or null while the first six are
   * not a colour yet.
   */
  function readHex(text, state) {
    const raw = String(text || '').trim();
    const hash = raw.startsWith('#');
    let digits = hash ? raw.slice(1) : raw;
    let a = state.a;
    let text2 = null;
    if (digits.length >= 8) {
      const tail = digits.slice(6, 8);
      if (/^[0-9a-f]{2}$/i.test(tail)) a = parseInt(tail, 16);
      digits = digits.slice(0, 6);
      text2 = (hash ? '#' : '') + digits;
    }
    const six = digits.slice(0, 6);
    if (!/^[0-9a-f]{6}$/i.test(six)) {
      return { text: text2, state: a === state.a ? null : { ...state, a } };
    }
    const r = parseInt(six.slice(0, 2), 16);
    const g = parseInt(six.slice(2, 4), 16);
    const b = parseInt(six.slice(4, 6), 16);
    return { text: text2, state: { ...withRgb(state, r, g, b), a } };
  }

  /**
   * One of R, G, B or A as typed: a whole number 0 to 255, or null while the
   * box does not hold one (empty, a minus sign on its own). Out of range is
   * held to the range rather than refused, so 300 reads as 255.
   */
  function readByte(text) {
    const s = String(text || '').trim();
    if (!/^-?\d+$/.test(s)) return null;
    return clamp(parseInt(s, 10), 0, 255);
  }

  /**
   * A point on the wheel into hue and saturation. `dx` and `dy` are from the
   * centre in screen pixels (y down) and `radius` is the wheel's. Red points
   * right and the hue turns anticlockwise on screen, the way the angle is
   * read in maths; outside the wheel is its edge.
   */
  function wheelPick(dx, dy, radius) {
    // Through the modulo rather than a test for below zero, which lets the -0
    // atan2 gives on the right-hand axis through.
    const h = ((Math.atan2(-dy, dx) * 180) / Math.PI + 360) % 360;
    const s = clamp(Math.hypot(dx, dy) / Math.max(1, radius), 0, 1);
    return { h, s };
  }

  /** Where hue and saturation sit on the wheel, the inverse of wheelPick. */
  function wheelPoint(h, s, radius) {
    const rad = (h * Math.PI) / 180;
    return { dx: Math.cos(rad) * s * radius, dy: -Math.sin(rad) * s * radius };
  }

  return {
    hsvToRgb,
    rgbToHsv,
    stateOf,
    rgbOf,
    hexOf,
    colorOf,
    withRgb,
    readHex,
    readByte,
    wheelPick,
    wheelPoint,
  };
})();

// The tests require this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = colorModel;
