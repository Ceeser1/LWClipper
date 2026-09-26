'use strict';

// V3. Where every piece of a generated text goes: runs in, positioned lines out.
//
// Pure, like timeline.js. It never measures anything itself. The caller hands
// in a function that does, which in the window is canvas measureText and in
// the tests is arithmetic, so the wrapping and the alignment can be tested in
// node the way the rest of the model is.
//
// It works run by run with each run's style laid over the text's, even though
// 3.0 only ever has one run. That is the ground the user asked to have laid for
// formatting words one by one later: a second run with its own size is already
// measured, wrapped and given its line height here, and nothing in this file
// has to change when the editor learns to make one.

const textLayout = (() => {
  // How far below the baseline the underline sits and how far above it the
  // strike runs, and how thick both are, as fractions of the font size. Canvas
  // fillText draws no decoration, so the drawing draws these lines itself, and
  // keeps the numbers here so the Edit Mode box and the render agree on them.
  const UNDERLINE_OFFSET = 0.1;
  const STRIKE_OFFSET = 0.3;
  const DECORATION_WIDTH = 0.06;

  /**
   * A run's style laid over the text's. A run holds only what it changes, and
   * a field it leaves undefined is one it does not change. null is different:
   * it is a run that turns an effect off, and it wins like any other value.
   */
  function styleOf(base, override) {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(override || {})) {
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /**
   * The CSS font a style draws with, at a scale. Canvas and the Edit Mode box
   * both take this string, which is what keeps the two from choosing different
   * faces for one setting. The family is quoted because installed fonts have
   * names with spaces and digits in them, which unquoted is not a font at all.
   */
  function fontString(style, scale = 1) {
    const s = style || {};
    const size = Math.max(0.01, (Number(s.size) || 0) * scale);
    const family = String(s.font || 'Arial').replace(/["\\]/g, '');
    return (s.italic ? 'italic ' : '') + (s.bold ? 'bold ' : '')
      + Math.round(size * 100) / 100 + 'px "' + family + '", sans-serif';
  }

  // Each run's text cut into words, stretches of spaces and hard line breaks.
  // A word is anything between spaces, and it can run across two runs: "He"
  // in bold followed by "llo" is one word, and is never wrapped between the two.
  function tokenise(runs, base, measure, scale) {
    const items = [];
    runs.forEach((run, index) => {
      const style = styleOf(base, run && run.style);
      const text = String((run && run.text) || '');
      const parts = text.match(/\n| +|[^ \n]+/g) || [];
      for (const part of parts) {
        const kind = part === '\n' ? 'break' : (part[0] === ' ' ? 'space' : 'word');
        const frag = { text: part === '\n' ? '' : part, style, run: index };
        frag.width = kind === 'break' ? 0 : measure(frag.text, style, scale).width;
        const last = items[items.length - 1];
        if (kind === 'word' && last && last.kind === 'word') {
          last.frags.push(frag);
          last.width += frag.width;
        } else {
          items.push({ kind, frags: [frag], width: frag.width });
        }
      }
      // A run ending does not end a word, so the next run's first letters join
      // the word this one ended on. Only a space or a break ends one.
    });
    return items;
  }

  // A word too wide for a line of its own, cut between characters wherever the
  // line is full. Without this it would run off the side of the frame, and a
  // long URL in a narrow box is exactly where somebody would find that out.
  function splitWord(item, width, measure, scale) {
    const out = [];
    let cur = { kind: 'word', frags: [], width: 0 };
    for (const frag of item.frags) {
      let text = '';
      for (const ch of Array.from(frag.text)) {
        const w = measure(text + ch, frag.style, scale).width;
        if (cur.width + w > width && (cur.frags.length || text)) {
          if (text) {
            const done = measure(text, frag.style, scale).width;
            cur.frags.push({ ...frag, text, width: done });
            cur.width += done;
          }
          out.push(cur);
          cur = { kind: 'word', frags: [], width: 0 };
          text = ch;
        } else {
          text += ch;
        }
      }
      if (text) {
        const done = measure(text, frag.style, scale).width;
        cur.frags.push({ ...frag, text, width: done });
        cur.width += done;
      }
    }
    if (cur.frags.length) out.push(cur);
    return out;
  }

  /**
   * Lay out a text.
   *
   * `measure(text, style, scale)` answers `{ width, ascent, descent }` in
   * pixels: the width of that text in that style, and the font's own ascent
   * and descent, which is canvas's fontBoundingBox pair and does not depend on
   * the letters. It is asked for an empty string too, which is how an empty
   * line gets a height.
   *
   * `width` and `height` are the box, in the same pixels. Text wraps at spaces
   * to the width and is aligned in the box by `align.h` and `align.v`. Text
   * taller than the box is not cut: it overflows by the alignment, downwards
   * from the top, both ways from the middle.
   *
   * Out come lines, each with its top, its baseline, its width and its pieces,
   * and each piece with its text, its merged style, its run and where it
   * starts. Everything is relative to the box's top left corner.
   */
  function layoutText({ runs, style, align, width, height, measure, scale = 1 }) {
    const base = style || {};
    const list = Array.isArray(runs) && runs.length ? runs : [{ text: '', style: {} }];
    const boxW = Math.max(0, Number(width) || 0);
    const boxH = Math.max(0, Number(height) || 0);
    const items = tokenise(list, base, measure, scale);

    // Greedy filling, the way every word processor does it. Spaces wait until a
    // word follows them, so a line never ends in spaces that count towards its
    // width, and a line opened by wrapping does not start with the spaces the
    // wrap happened at. A line opened by a hard break keeps them: those are
    // spaces somebody typed at the start of a line.
    const lines = [];
    let line = null;
    let pending = [];
    const open = (reason, fallbackStyle, run) => {
      line = { items: [], width: 0, reason, emptyStyle: fallbackStyle, run };
      lines.push(line);
      pending = [];
    };
    const place = (item) => {
      for (const sp of pending) {
        line.items.push(sp);
        line.width += sp.width;
      }
      pending = [];
      line.items.push(item);
      line.width += item.width;
    };
    open('start', styleOf(base, list[0].style), 0);

    for (const item of items) {
      if (item.kind === 'break') {
        const f = item.frags[0];
        // An empty line still has the height of the style it was typed in.
        if (!line.items.length) line.emptyStyle = f.style;
        open('break', f.style, f.run);
        continue;
      }
      if (item.kind === 'space') {
        // Spaces typed at the start of a line are kept straight away, so
        // a line of nothing but spaces still has them.
        if (!line.items.length && line.reason !== 'wrap') place(item);
        else pending.push(item);
        continue;
      }
      const spaceW = pending.reduce((sum, sp) => sum + sp.width, 0);
      if (line.items.length && line.width + spaceW + item.width > boxW) {
        open('wrap', item.frags[0].style, item.frags[0].run);
      }
      if (item.width > boxW && boxW > 0) {
        const pieces = splitWord(item, boxW, measure, scale);
        pieces.forEach((piece, i) => {
          if (i > 0) open('wrap', piece.frags[0].style, piece.frags[0].run);
          place(piece);
        });
      } else {
        place(item);
      }
    }

    // Each line's pieces: neighbouring fragments of one run joined and measured
    // again as one, so the drawing hands canvas whole stretches of text and the
    // font's own kerning between the letters survives. The width the line was
    // wrapped at was the sum of its parts, which differs from this by a kerning
    // pair or two, far less than anything that would change where it wrapped.
    const out = [];
    let top = 0;
    for (const l of lines) {
      const frags = [];
      for (const item of l.items) frags.push(...item.frags);
      const pieces = [];
      for (const f of frags) {
        const last = pieces[pieces.length - 1];
        if (last && last.run === f.run) last.text += f.text;
        else pieces.push({ text: f.text, style: f.style, run: f.run });
      }
      let ascent = 0;
      let descent = 0;
      let x = 0;
      for (const p of pieces) {
        const m = measure(p.text, p.style, scale);
        p.x = x;
        p.width = m.width;
        x += m.width;
        ascent = Math.max(ascent, m.ascent);
        descent = Math.max(descent, m.descent);
      }
      if (!pieces.length) {
        const m = measure('', l.emptyStyle, scale);
        ascent = m.ascent;
        descent = m.descent;
      }
      out.push({ top, baseline: top + ascent, width: x, height: ascent + descent, pieces });
      top += ascent + descent;
    }

    const h = (align && align.h) || 'center';
    const v = (align && align.v) || 'middle';
    const total = top;
    let dy = 0;
    if (v === 'middle') dy = (boxH - total) / 2;
    else if (v === 'bottom') dy = boxH - total;
    for (const l of out) {
      let dx = 0;
      if (h === 'center') dx = (boxW - l.width) / 2;
      else if (h === 'right') dx = boxW - l.width;
      l.x = dx;
      l.top += dy;
      l.baseline += dy;
      for (const p of l.pieces) p.x += dx;
    }
    return {
      lines: out,
      width: out.reduce((m, l) => Math.max(m, l.width), 0),
      height: total,
      scale,
    };
  }

  return {
    UNDERLINE_OFFSET,
    STRIKE_OFFSET,
    DECORATION_WIDTH,
    styleOf,
    fontString,
    layoutText,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = textLayout;
