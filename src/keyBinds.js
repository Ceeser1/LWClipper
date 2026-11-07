'use strict';

// V4.2. The keys the user has bound, kept apart from the action table so the
// rules can be tested without a window: what is saved, what is read back, and
// which action already holds a key.
//
// Saved in the settings as { actionId: [combo, ...] }, only for the actions
// whose keys differ from their defaults, so a later version that changes a
// default still reaches everyone who never touched that key.

const keyBinds = (() => {
  const combo = (typeof keyCombo !== 'undefined') ? keyCombo : require('./keyCombo');

  // Pressed on their own they end or cancel the editing of a box, so they
  // cannot be a key of their own there. With a modifier they can.
  const RESERVED = new Set(['Escape', 'Enter']);

  /** Whether a press can be bound at all. */
  function bindable(c) {
    return typeof c === 'string' && !!c && !RESERVED.has(c);
  }

  /**
   * What was saved, cleaned: only the ids in `known`, each a list of combos in
   * keyCombo's one form, nothing that cannot be bound, no repeats. An entry
   * that comes out empty is dropped, so the action keeps its defaults.
   */
  function sanitize(saved, known) {
    const out = {};
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
    const ids = new Set(known);
    for (const [id, keys] of Object.entries(saved)) {
      if (!ids.has(id) || !Array.isArray(keys)) continue;
      const clean = [];
      for (const k of keys) {
        const c = combo.normalize(String(k));
        if (bindable(c) && !clean.includes(c)) clean.push(c);
      }
      if (clean.length) out[id] = clean;
    }
    return out;
  }

  /**
   * The keys every action ends up with: its saved ones when it has some,
   * else its defaults. `defaults` is { id: [combo, ...] }. A saved key that
   * an earlier action in the list already holds is taken off the later one,
   * so two actions never answer to one press, however the file was edited.
   */
  function resolve(defaults, saved) {
    const out = {};
    const taken = new Map();
    const ids = Object.keys(defaults);
    for (const id of ids) {
      const keys = (saved && saved[id]) || defaults[id] || [];
      out[id] = [];
      for (const k of keys) {
        if (taken.has(k)) continue;
        taken.set(k, id);
        out[id].push(k);
      }
    }
    return out;
  }

  /** The id of the action other than `id` that holds `c` in `current`, or null. */
  function holder(current, id, c) {
    for (const [other, keys] of Object.entries(current)) {
      if (other !== id && (keys || []).includes(c)) return other;
    }
    return null;
  }

  /** What to save: only the actions whose keys are not their defaults. */
  function changes(defaults, current) {
    const out = {};
    for (const id of Object.keys(defaults)) {
      const now = current[id] || [];
      const was = defaults[id] || [];
      if (now.length !== was.length || now.some((k, i) => k !== was[i])) out[id] = now.slice();
    }
    return out;
  }

  return { bindable, sanitize, resolve, holder, changes, RESERVED };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = keyBinds;
