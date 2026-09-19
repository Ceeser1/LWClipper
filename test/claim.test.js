'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/claim');

// An entry as the main process will hand it over: the claim file's own name
// without its extension, and what was in it.
function entry(id, name, files, props) {
  return { id, claim: C.claimOf({ project: { name, path: 'C:\\p\\' + name + '.lwc' }, files }), ...props };
}

// ---- the round trip ----

test('a claim round-trips unchanged', () => {
  const c = C.build({
    name: 'holiday', path: 'C:\\projects\\holiday.lwc',
    files: ['aaa.mp4', 'bbb.webm'], app: '1.5.5',
  });
  const out = C.parse(C.stringify(c));
  assert.equal(out.ok, true);
  assert.equal(out.claim.project.name, 'holiday');
  assert.equal(out.claim.project.path, 'C:\\projects\\holiday.lwc');
  assert.deepEqual(out.claim.files, ['aaa.mp4', 'bbb.webm']);
});

test('what is written and what is read back are the same shape', () => {
  // The Step 15 lesson, checked rather than trusted: claimOf is the only
  // description of a claim, so a field cannot be written by build and dropped
  // by parse.
  const c = C.build({ name: 'x', path: 'C:\\x.lwc', files: ['a.mp4'] });
  const out = C.parse(C.stringify(c));
  assert.deepEqual(out.claim, C.claimOf(c));
});

test('JSON that is not a claim is refused', () => {
  assert.equal(C.parse('nonsense').error, 'notJson');
  assert.equal(C.parse('{"hello":true}').error, 'notClaim');
  assert.equal(C.parse('{"format":"lwclipper-project","version":1}').error, 'notClaim');
});

test('a claim from a newer app is refused by name', () => {
  const c = C.build({ name: 'x', files: [] });
  c.version = C.VERSION + 3;
  const out = C.parse(JSON.stringify(c));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'tooNew');
});

// ---- what may be claimed ----

test('a claim holds bare names, never paths', () => {
  // A path would survive a cache move as a reference to a folder that has
  // nothing in it any more.
  const c = C.build({ name: 'x', files: ['a.mp4', 'C:\\cache\\b.mp4', 'sub/c.mp4', '  '] });
  assert.deepEqual(c.files, ['a.mp4']);
});

test('the same file claimed twice is held once', () => {
  const c = C.build({ name: 'x', files: ['a.mp4', 'A.MP4', 'a.mp4'] });
  assert.deepEqual(c.files, ['a.mp4']);
});

// ---- naming a claim file ----

test('a claim is named after its project', () => {
  assert.equal(C.idFor('holiday', []), 'holiday');
});

test('two projects of the same name get a claim each', () => {
  // The name is a label, not a key: same filename, different folders.
  assert.equal(C.idFor('holiday', ['holiday']), 'holiday-2');
  assert.equal(C.idFor('holiday', ['holiday', 'holiday-2']), 'holiday-3');
});

test('a name that cannot be a filename is made into one', () => {
  assert.equal(C.idFor('a/b:c*d', []), 'a_b_c_d');
  assert.equal(C.idFor('', []), 'project');
});

// ---- finding a claim again ----

test('a project is matched by the path it recorded', () => {
  const claims = [entry('one', 'one', []), entry('two', 'two', [])];
  const hit = C.matchFor(claims, { path: 'C:\\p\\two.lwc', name: 'two' });
  assert.equal(hit.id, 'two');
});

test('a project renamed outside the app is matched by its own name', () => {
  // The whole point of the .lwc carrying its last-saved name: the file is now
  // at a path no claim has ever heard of, and the name is what still agrees.
  const claims = [entry('holiday', 'holiday', ['a.mp4'])];
  const hit = C.matchFor(claims, { path: 'D:\\elsewhere\\summer trip.lwc', name: 'holiday' });
  assert.equal(hit.id, 'holiday');
});

test('the path wins over the name when they disagree', () => {
  // Two claims, one matching on each. The path is exact when it is still true.
  const claims = [entry('one', 'shared', ['a.mp4']), entry('two', 'other', ['b.mp4'])];
  const hit = C.matchFor(claims, { path: 'C:\\p\\other.lwc', name: 'shared' });
  assert.equal(hit.id, 'two');
});

test('a project nothing has claimed matches nothing', () => {
  const claims = [entry('one', 'one', [])];
  assert.equal(C.matchFor(claims, { path: 'C:\\p\\new.lwc', name: 'new' }), null);
});

test('a project with no name at all is matched by path or not at all', () => {
  // Every .lwc written before Step 18 is this: no name inside it.
  const claims = [entry('one', 'one', [])];
  assert.equal(C.matchFor(claims, { path: 'C:\\p\\one.lwc', name: '' }).id, 'one');
  assert.equal(C.matchFor(claims, { path: 'C:\\p\\gone.lwc', name: '' }), null);
});

test('matching ignores case, because Windows does', () => {
  const claims = [entry('one', 'Holiday', [])];
  assert.equal(C.matchFor(claims, { path: 'c:\\P\\HOLIDAY.LWC', name: 'x' }).id, 'one');
  assert.equal(C.matchFor(claims, { path: '', name: 'holiday' }).id, 'one');
});

// ---- what may be deleted, which is the rule the user gave ----

test('a file no project claims is deleted', () => {
  // The ordinary cache file, and it falls out of the same line rather than
  // being a case of its own.
  assert.deepEqual(C.deletableFiles([], [], ['a.mp4', 'b.mp4']), ['a.mp4', 'b.mp4']);
});

test('a file claimed by an unticked project is kept', () => {
  const claims = [entry('one', 'one', ['a.mp4'])];
  assert.deepEqual(C.deletableFiles(claims, [], ['a.mp4', 'b.mp4']), ['b.mp4']);
});

test('a file claimed only by ticked projects is deleted', () => {
  const claims = [entry('one', 'one', ['a.mp4'])];
  assert.deepEqual(C.deletableFiles(claims, ['one'], ['a.mp4']), ['a.mp4']);
});

test('a file two projects share survives until both are ticked', () => {
  // The user's rule in one test: "Only delete it if all projects with that
  // file are marked for clearing".
  const claims = [entry('one', 'one', ['shared.mp4']), entry('two', 'two', ['shared.mp4'])];
  assert.deepEqual(C.deletableFiles(claims, ['one'], ['shared.mp4']), []);
  assert.deepEqual(C.deletableFiles(claims, ['two'], ['shared.mp4']), []);
  assert.deepEqual(C.deletableFiles(claims, ['one', 'two'], ['shared.mp4']), ['shared.mp4']);
});

test('ticking one project frees only what it alone was holding', () => {
  const claims = [
    entry('one', 'one', ['mine.mp4', 'shared.mp4']),
    entry('two', 'two', ['shared.mp4']),
  ];
  assert.deepEqual(
    C.deletableFiles(claims, ['one'], ['mine.mp4', 'shared.mp4', 'loose.mp4']),
    ['mine.mp4', 'loose.mp4'],
  );
});

test('a claim naming a file the cache no longer holds protects nothing', () => {
  const claims = [entry('one', 'one', ['gone.mp4'])];
  assert.deepEqual(C.deletableFiles(claims, [], ['a.mp4']), ['a.mp4']);
});

// ---- the rows the modal will draw ----

test('a row says what ticking it alone would free', () => {
  const claims = [
    entry('one', 'one', ['mine.mp4', 'shared.mp4']),
    entry('two', 'two', ['shared.mp4']),
  ];
  const rows = C.rowsFor(claims, { 'mine.mp4': 100, 'shared.mp4': 500 });
  assert.equal(rows.length, 2);
  // Not 600: ticking this one alone leaves shared.mp4 in place, because the
  // other project still wants it. Promising 600 would promise twice the space
  // that exists once both rows are added up.
  assert.equal(rows[0].bytes, 100);
  assert.equal(rows[1].bytes, 0);
  assert.equal(rows[0].held, 2);
});

test('a row counts only the files the cache still holds', () => {
  const claims = [entry('one', 'one', ['here.mp4', 'gone.mp4'])];
  const rows = C.rowsFor(claims, { 'here.mp4': 42 });
  assert.equal(rows[0].files, 2);
  assert.equal(rows[0].held, 1);
  assert.equal(rows[0].bytes, 42);
});

test('a row is named after the project, not after the claim file', () => {
  const claims = [entry('holiday-2', 'holiday', ['a.mp4'])];
  const rows = C.rowsFor(claims, { 'a.mp4': 1 });
  assert.equal(rows[0].id, 'holiday-2');
  assert.equal(rows[0].name, 'holiday');
});

test('a missing project is carried through rather than dropped', () => {
  // Sweeping it would silently unprotect a project moved to another drive.
  const claims = [entry('one', 'one', ['a.mp4'], { missing: true })];
  const rows = C.rowsFor(claims, { 'a.mp4': 5 });
  assert.equal(rows[0].missing, true);
});
