'use strict';

// V5.1.6. The user, 2026-11-18: "Make the vfx categories collapsible so you
// dont have to scroll through all effects all the time and let the window
// remember which are collapsed. Search still (temporarily) expands the folder
// showing matching items inside it."
//
// The list itself is run here: the part of vfx.js that folds and searches is
// cut out and run over a small stand-in for the rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
require.cache[require.resolve('electron')] = { exports: { app: { isPackaged: false, getPath: () => '' } } };
const T = require('../src/timeline');
const settings = require('../src/settings');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const JS = read('renderer', 'app', 'vfx.js');

/** A stand-in for an element: the few things the list's code asks of one. */
function node(cls, extra = {}) {
  const classes = new Set([cls]);
  const attrs = {};
  return {
    hidden: false,
    dataset: {},
    classList: {
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
    ...extra,
  };
}

/** The menu as showVfxMenu builds it, with the code under test bound to it. */
function menu(saved) {
  const children = [];
  const rows = {};
  for (const g of [{ id: 'hide', kinds: ['Obscure', 'Pixelate'] }, { id: 'color', kinds: ['Sepia', 'Colorize'] },
    { id: 'distort', kinds: ['Swirl', 'Pixel Wave'] }]) {
    const head = node('vfx-menu__group');
    head.dataset.group = g.id;
    children.push(head);
    rows[g.id] = head;
    for (const name of g.kinds) {
      const row = node('vfx-menu__row', { querySelector: () => ({ textContent: name }) });
      children.push(row);
      rows[name] = row;
    }
  }
  const none = node('vfx-menu__none');
  none.hidden = true;
  children.push(none);
  const writes = [];
  const box = {
    vfxMenu: { children, classList: node('vfx-menu__list').classList },
    vfxMenuSearch: { value: '' },
    appSettings: { vfxFolded: saved },
    timelineModel: { VFX_GROUPS: T.VFX_GROUPS },
    window: { lwclipper: { setSettings: (patch) => writes.push(patch) } },
  };
  const from = JS.indexOf('function filterVfxMenu()');
  const to = JS.indexOf("vfxMenuSearch.addEventListener('input', filterVfxMenu);");
  assert.ok(from > 0 && to > from);
  vm.runInNewContext(JS.slice(from, to) + '\nthis.filterVfxMenu = filterVfxMenu; this.toggleVfxGroup = toggleVfxGroup;', box);
  const shown = () => Object.keys(rows).filter((k) => !rows[k].hidden);
  return { box, rows, none, writes, shown };
}

const ALL = ['hide', 'Obscure', 'Pixelate', 'color', 'Sepia', 'Colorize', 'distort', 'Swirl', 'Pixel Wave'];

test('every heading starts open, and none is folded in a new profile', () => {
  assert.equal(settings.DEFAULTS.vfxFolded, null);
  const m = menu(null);
  m.box.filterVfxMenu();
  assert.deepEqual(m.shown(), ALL);
  assert.equal(m.none.hidden, true);
  assert.equal(m.rows.color.getAttribute('aria-expanded'), 'true');
});

test('a click on a heading folds its kinds away, the heading stays, and the settings are told', () => {
  const m = menu(null);
  m.box.toggleVfxGroup('color');
  assert.deepEqual(m.shown(), ['hide', 'Obscure', 'Pixelate', 'color', 'distort', 'Swirl', 'Pixel Wave']);
  assert.ok(m.rows.color.classList.contains('vfx-menu__group--folded'));
  assert.equal(m.rows.color.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(JSON.parse(JSON.stringify(m.writes)), [{ vfxFolded: ['color'] }]);
  // Folded in the menu's order, whatever order they were clicked in.
  m.box.toggleVfxGroup('hide');
  assert.deepEqual(JSON.parse(JSON.stringify(m.writes[1])), { vfxFolded: ['hide', 'color'] });
  // And open again: back to null once none is folded.
  m.box.toggleVfxGroup('color');
  m.box.toggleVfxGroup('hide');
  assert.deepEqual(m.shown(), ALL);
  assert.deepEqual(JSON.parse(JSON.stringify(m.writes[3])), { vfxFolded: null });
});

test('what was folded is folded when the window opens again', () => {
  const m = menu(['color', 'distort']);
  m.box.filterVfxMenu();
  assert.deepEqual(m.shown(), ['hide', 'Obscure', 'Pixelate', 'color', 'distort']);
  // All folded is three headings and no "No VFX found".
  const all = menu(['hide', 'color', 'distort']);
  all.box.filterVfxMenu();
  assert.deepEqual(all.shown(), ['hide', 'color', 'distort']);
  assert.equal(all.none.hidden, true);
  // A settings file edited by hand cannot break the list.
  for (const odd of ['color', { color: true }, [1, null, 'nothing']]) {
    const o = menu(odd);
    o.box.filterVfxMenu();
    assert.deepEqual(o.shown(), ALL);
  }
});

test('a search opens a folded heading for what it finds, and gives it back folded', () => {
  const m = menu(['color', 'distort']);
  m.box.vfxMenuSearch.value = 'pix';
  m.box.filterVfxMenu();
  // Pixelate under an open heading, Pixel Wave under a folded one; Color has no match and goes.
  assert.deepEqual(m.shown(), ['hide', 'Pixelate', 'distort', 'Pixel Wave']);
  assert.equal(m.rows.distort.classList.contains('vfx-menu__group--folded'), false);
  assert.equal(m.rows.distort.getAttribute('aria-expanded'), 'true');
  assert.ok(m.box.vfxMenu.classList.contains('vfx-menu__list--search'));
  // Nothing found.
  m.box.vfxMenuSearch.value = 'zzz';
  m.box.filterVfxMenu();
  assert.deepEqual(m.shown(), []);
  assert.equal(m.none.hidden, false);
  // The search emptied: as it was folded, and nothing was written meanwhile.
  m.box.vfxMenuSearch.value = '';
  m.box.filterVfxMenu();
  assert.deepEqual(m.shown(), ['hide', 'Obscure', 'Pixelate', 'color', 'distort']);
  assert.equal(m.box.vfxMenu.classList.contains('vfx-menu__list--search'), false);
  assert.equal(m.none.hidden, true);
  assert.deepEqual(m.writes, []);
  assert.deepEqual(JSON.parse(JSON.stringify(m.box.appSettings.vfxFolded)), ['color', 'distort']);
});

test('the heading is made as a switch with a chevron, and a click on it is not taken while searching', () => {
  const show = JS.slice(JS.indexOf('function showVfxMenu()'), JS.indexOf('function filterVfxMenu()'));
  assert.ok(show.includes('head.dataset.group = g.id;'));
  assert.ok(show.includes("chevron.className = 'vfx-menu__chevron';"));
  assert.ok(show.includes("head.setAttribute('role', 'button');"));
  // A row or its + first; a row is not inside its heading.
  const click = JS.slice(JS.indexOf("vfxMenu.addEventListener('click'"), JS.indexOf("vfxMenu.addEventListener('dblclick'"));
  assert.ok(click.indexOf('previewVfx(row.dataset.kind)') < click.indexOf('toggleVfxGroup('));
  assert.ok(click.includes('if (group && !vfxMenuSearch.value.trim()) toggleVfxGroup(group.dataset.group);'));
  const css = read('renderer', 'style.css');
  assert.ok(/\.vfx-menu__group--folded \.vfx-menu__chevron::before \{\s*transform: rotate\(-90deg\);/.test(css));
  assert.ok(/\.vfx-menu__list--search \.vfx-menu__group \{\s*cursor: default;/.test(css));
  // A heading is display: flex now, so it hides only by the rule of its own.
  assert.ok(css.includes('.vfx-menu__group[hidden],'));
});
