'use strict';

// V3.2. The word processor's arithmetic: typing, deleting and formatting a
// stretch of a text, done to its runs.
//
// Pure, like textLayout.js. The editor works on a text's runs expanded, each
// with its whole style rather than only what it changes, because every edit is
// then cutting and joining a list of pieces and nothing else. compress() turns
// them back into what the file keeps: the text's style, and runs that hold only
// what differs from it.
//
// Positions are string offsets, UTF-16 code units, since that is what a DOM
// selection counts in.

const textRuns = (() => {
  const layout = typeof textLayout !== 'undefined' ? textLayout : require('./textLayout');
  const model = typeof timelineModel !== 'undefined' ? timelineModel : require('./timeline');
  const FIELDS = model.RUN_FIELDS;

  /** The runs with the text's style laid under each, so each has all of it. */
  function expand(runs, base) {
    const list = Array.isArray(runs) && runs.length ? runs : [{ text: '', style: {} }];
    return list.map((r) => ({ text: String(r.text || ''), style: layout.styleOf(base, r.style) }));
  }

  function sameStyle(a, b) {
    return FIELDS.every((k) => a[k] === b[k]);
  }

  /**
   * Expanded runs back into the file's form, `{ runs, style }`, always the one
   * way for one text: empty runs dropped, a field every run agrees on moved into
   * the text's style, a run holding only what differs from that, and neighbours
   * that differ in the same way joined. A text formatted all alike therefore
   * comes out as one run that changes nothing, the shape 3.0 and 3.1 wrote.
   *
   * An empty text keeps the style of its one empty run, which is the style the
   * next letter typed into it will have.
   */
  function compress(full, base) {
    let list = full.filter((r) => r.text);
    if (!list.length) list = full.length ? [{ text: '', style: full[0].style }] : [{ text: '', style: base }];
    const style = { ...base };
    for (const k of FIELDS) {
      const v = list[0].style[k];
      if (list.every((r) => r.style[k] === v)) style[k] = v;
    }
    const runs = [];
    for (const r of list) {
      const own = {};
      for (const k of FIELDS) {
        if (r.style[k] !== style[k]) own[k] = r.style[k];
      }
      const last = runs[runs.length - 1];
      // Both hold only what differs, so a field neither has compares equal.
      if (last && sameStyle(last.style, own)) {
        last.text += r.text;
      } else {
        runs.push({ text: r.text, style: own });
      }
    }
    return { runs, style };
  }

  function textOf(full) {
    return full.map((r) => r.text).join('');
  }

  // The run holding the character at `at`, and where that run starts. Past
  // the end it is the last run.
  function runAt(full, at) {
    let start = 0;
    for (let i = 0; i < full.length; i += 1) {
      const end = start + full[i].text.length;
      if (at < end) return { index: i, start };
      start = end;
    }
    const i = full.length - 1;
    return { index: i, start: start - (i >= 0 ? full[i].text.length : 0) };
  }

  /**
   * The style a letter typed at `at` takes: the letter before it, as in every
   * word processor, and at the very start the letter after it. An empty text
   * has its empty run's style.
   */
  function styleAt(full, at) {
    const len = textOf(full).length;
    if (!len) return { ...full[0].style };
    const pos = at > 0 ? Math.min(at, len) - 1 : 0;
    return { ...full[runAt(full, pos).index].style };
  }

  // The runs cut at `at`, so that a run starts there. Answers the index of
  // that run (the length of the list when `at` is the end).
  function cut(full, at) {
    let start = 0;
    for (let i = 0; i < full.length; i += 1) {
      const r = full[i];
      const end = start + r.text.length;
      if (at === start) return i;
      if (at < end) {
        full.splice(i, 1,
          { text: r.text.slice(0, at - start), style: r.style },
          { text: r.text.slice(at - start), style: r.style });
        return i + 1;
      }
      start = end;
    }
    return full.length;
  }

  function copyRuns(full) {
    return full.map((r) => ({ text: r.text, style: { ...r.style } }));
  }

  function clampRange(full, from, to) {
    const len = textOf(full).length;
    const a = Math.max(0, Math.min(len, Math.min(from, to)));
    const b = Math.max(0, Math.min(len, Math.max(from, to)));
    return [a, b];
  }

  /**
   * `from` to `to` replaced by `pieces`, expanded runs of their own. What is
   * left is never an empty list: a text emptied keeps one empty run in the
   * style of the first letter taken out, which is what gets typed next.
   */
  function replaceRuns(full, from, to, pieces) {
    const [a, b] = clampRange(full, from, to);
    const out = copyRuns(full);
    const keep = styleAt(full, a < b ? a + 1 : a);
    const i = cut(out, a);
    const j = cut(out, b);
    out.splice(i, j - i, ...copyRuns(pieces).filter((r) => r.text));
    if (!textOf(out)) return [{ text: '', style: keep }];
    return out.filter((r) => r.text);
  }

  /**
   * `from` to `to` replaced by `text` in `style`. Without a style it takes
   * the first letter it replaces, or with nothing replaced the letter before,
   * as typing over a selection does in Word.
   */
  function splice(full, from, to, text, style) {
    const [a, b] = clampRange(full, from, to);
    const s = style || styleAt(full, a < b ? a + 1 : a);
    return replaceRuns(full, a, b, [{ text: String(text || ''), style: { ...s } }]);
  }

  /** The letters from `from` to `to`, as expanded runs, for a copy. */
  function slice(full, from, to) {
    const [a, b] = clampRange(full, from, to);
    const out = copyRuns(full);
    const i = cut(out, a);
    const j = cut(out, b);
    return out.slice(i, j);
  }

  /**
   * `props` laid over every letter from `from` to `to`. Only the fields a run
   * may carry are taken; outline and shadow are the whole text's.
   */
  function applyStyle(full, from, to, props) {
    const [a, b] = clampRange(full, from, to);
    const change = {};
    for (const k of FIELDS) {
      if (props && props[k] !== undefined) change[k] = props[k];
    }
    if (a === b) return copyRuns(full);
    const out = copyRuns(full);
    const i = cut(out, a);
    const j = cut(out, b);
    for (let n = i; n < j; n += 1) out[n].style = { ...out[n].style, ...change };
    return out;
  }

  /**
   * What the toolbar shows for a selection: the style of its first letter, and
   * the fields in which the rest of it differs. A bare caret is the style the
   * next letter typed would have, with nothing mixed.
   */
  function selectionStyle(full, from, to) {
    const [a, b] = clampRange(full, from, to);
    if (a === b) return { style: styleAt(full, a), mixed: [] };
    const part = slice(full, a, b);
    const style = { ...part[0].style };
    const mixed = FIELDS.filter((k) => part.some((r) => r.style[k] !== style[k]));
    return { style, mixed };
  }

  /**
   * Where two versions of a text differ, as the one replacement that turns
   * `before` into `after`: `{ from, to, text }`, `from` and `to` in `before`.
   * That is how the editor learns what the box did after the fact, typing,
   * a dead key's letter, a paste or a delete alike.
   *
   * `caret`, where the caret stands in `after`, settles the cases a plain
   * comparison cannot: typing "a" after "a" changed the text after the caret's
   * old place, not before it, and that decides whose style the letter takes.
   */
  function textChange(before, after, caret) {
    const end = caret === undefined ? after.length : Math.max(0, Math.min(after.length, caret));
    let suffix = 0;
    const most = Math.min(before.length, after.length - end);
    while (suffix < most && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) {
      suffix += 1;
    }
    let prefix = 0;
    const room = Math.min(before.length, after.length) - suffix;
    while (prefix < room && before[prefix] === after[prefix]) prefix += 1;
    return {
      from: prefix,
      to: before.length - suffix,
      text: after.slice(prefix, after.length - suffix),
    };
  }

  return {
    expand,
    compress,
    textOf,
    styleAt,
    splice,
    replaceRuns,
    slice,
    applyStyle,
    selectionStyle,
    textChange,
  };
})();

// The main process requires this file; the window reads the binding above.
if (typeof module !== 'undefined' && module.exports) module.exports = textRuns;
