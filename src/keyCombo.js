'use strict';

// V4.0. A key press as one string, the form the menu shows it in and the form
// the action table keeps its keys in: the modifiers in a fixed order, then the
// key, joined by plus signs. "Ctrl+Shift+S", "Shift+Left", "Space", "Plus".
//
// The order is fixed whatever order the modifiers were pressed in, so Shift
// then Ctrl then S and Ctrl then Shift then S are the same bind. V4.2's Key
// Binds window saves what this writes, which is why it is its own file and
// tested on its own.

const keyCombo = (() => {
  const MODIFIERS = ['Ctrl', 'Shift', 'Alt'];

  // Keys whose name in an event is not the name worth showing or keeping.
  const NAMED = {
    ' ': 'Space',
    Spacebar: 'Space',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Delete: 'Del',
    Del: 'Del',
    Esc: 'Escape',
    '+': 'Plus',
    // The unshifted key under + on an English keyboard. Zooming with it is what
    // every editor answers to, and asking for Shift to reach + would make the
    // key shown in the menu a lie on that layout.
    '=': 'Plus',
    '-': 'Minus',
    Subtract: 'Minus',
    Add: 'Plus',
  };

  // A symbol is a character Shift may have been needed to type, so Shift is
  // not part of its name: + is Shift and = on an English keyboard and a key of
  // its own on a German one, and both have to be the same press.
  const SHIFT_FREE = new Set(['Plus', 'Minus']);

  // Pressed on their own they are not a key yet, only the start of one.
  const ALONE = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS']);

  /** The key's own name, without modifiers, or null for a modifier alone. */
  function keyName(key) {
    if (key === undefined || key === null || key === '') return null;
    const raw = String(key);
    if (ALONE.has(raw)) return null;
    if (NAMED[raw]) return NAMED[raw];
    // One letter or digit, in capitals, so Shift does not make a second key of it.
    if (raw.length === 1) return raw.toUpperCase();
    return raw;
  }

  /**
   * The press an event describes, or null while only modifiers are down.
   * Meta counts as Ctrl, which is what every shortcut in the app has done.
   */
  function fromEvent(evt) {
    if (!evt) return null;
    const name = keyName(evt.key);
    if (!name) return null;
    const parts = [];
    if (evt.ctrlKey || evt.metaKey) parts.push('Ctrl');
    if (evt.shiftKey && !SHIFT_FREE.has(name)) parts.push('Shift');
    if (evt.altKey) parts.push('Alt');
    parts.push(name);
    return parts.join('+');
  }

  /**
   * A combo written by hand, put in the one form fromEvent produces: "shift +
   * ctrl + s" is "Ctrl+Shift+S". Null for something that names no key.
   */
  function normalize(text) {
    if (typeof text !== 'string') return null;
    const parts = text.split('+').map((p) => p.trim()).filter(Boolean);
    // "Ctrl++" is Ctrl and Plus: the split leaves an empty piece at the end.
    if (/\+\s*\+\s*$/.test(text) || text.trim() === '+') parts.push('+');
    const mods = new Set();
    let name = null;
    for (const part of parts) {
      const low = part.toLowerCase();
      if (low === 'ctrl' || low === 'control' || low === 'cmd' || low === 'meta') mods.add('Ctrl');
      else if (low === 'shift') mods.add('Shift');
      else if (low === 'alt') mods.add('Alt');
      else if (name) return null;
      else name = keyName(part.length === 1 ? part : canonicalWord(part));
    }
    if (!name) return null;
    if (SHIFT_FREE.has(name)) mods.delete('Shift');
    return [...MODIFIERS.filter((m) => mods.has(m)), name].join('+');
  }

  // A word typed in any case, given the case an event would give it.
  function canonicalWord(word) {
    const low = word.toLowerCase();
    const known = ['Space', 'Left', 'Right', 'Up', 'Down', 'Del', 'Home', 'End',
      'Plus', 'Minus', 'Escape', 'Enter', 'Tab', 'Backspace', 'Insert', 'PageUp', 'PageDown'];
    const hit = known.find((k) => k.toLowerCase() === low);
    if (hit) return hit;
    if (/^f\d{1,2}$/i.test(word)) return word.toUpperCase();
    return word;
  }

  // What a key is called on screen, where its name would be the wrong thing to
  // show: the arrows as arrows, the user's "(arrow icon)", and + and - as the
  // characters on the key.
  const SHOWN = {
    Left: '←',
    Right: '→',
    Up: '↑',
    Down: '↓',
    Plus: '+',
    Minus: '-',
  };

  /**
   * The combo as the menu writes it. `word` translates the names that have a
   * word in other languages (Ctrl is Strg in German), and is the page's t().
   */
  function display(combo, word = (w) => w) {
    if (!combo) return '';
    return String(combo).split('+').filter(Boolean)
      .map((part) => SHOWN[part] || word(part))
      .join('+');
  }

  return { fromEvent, normalize, display, keyName, MODIFIERS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = keyCombo;
