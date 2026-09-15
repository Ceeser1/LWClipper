'use strict';

// Reports what the locale files are missing, without touching them. Run it after
// adding or rewording any user-visible string:
//
//   node scripts/check-locales.js
//
// It never writes, because locales/*.json are meant to be edited by hand and a
// generator would quietly overwrite that. It only tells you what to go and fix.
//
// Not shipped: nothing under scripts/ is in package.json "files" or
// extraResources, so it stays out of the build.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
// Both sides that translate: the window, and the main process for its dialogs.
// Only what either one wraps in t() counts, which is why the literals main.js
// hands to ffmpeg or writes to a log do not turn up here.
const js = [
  fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'),
].join('\n');

const decode = (s) => s
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ');

const keys = [];
const seen = new Set();

// Markup text is collapsed, because a paragraph wrapped over several lines
// reaches the DOM as one run with the newlines and indentation still in it, and
// the renderer collapses it the same way before looking it up. A t() key is
// taken exactly as written: it is one line of source, and any run of spaces in
// it is deliberate alignment.
//
// setStatus() counts as well as t(). It takes the same key and the same vars,
// it just keeps them so the status line can be drawn again in another language,
// and its strings would read as unused here otherwise.
const add = (raw, collapse = true) => {
  const key = collapse ? raw.replace(/\s+/g, ' ').trim() : raw;
  if (!key || !/[A-Za-z]/.test(key) || seen.has(key)) return;
  seen.add(key);
  keys.push(key);
};

const stripped = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<head[\s\S]*?<\/head>/i, '');
for (const m of stripped.matchAll(/>([^<>]+)</g)) add(decode(m[1]));

// Placeholders are the only attribute the renderer translates.
for (const m of html.matchAll(/placeholder="([^"]+)"/g)) add(decode(m[1]));

for (const m of js.matchAll(/\b(?:t|setStatus)\(\s*'((?:[^'\\]|\\.)*)'/g)) add(m[1].replace(/\\'/g, "'"), false);
for (const m of js.matchAll(/\b(?:t|setStatus)\(\s*"((?:[^"\\]|\\.)*)"/g)) add(m[1].replace(/\\"/g, '"'), false);

keys.sort((a, b) => a.localeCompare(b, 'en'));

const dir = path.join(ROOT, 'locales');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
let problems = 0;

console.log(keys.length + ' translatable strings in the app\n');

for (const file of files) {
  const table = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const missing = keys.filter((k) => !(k in table));
  const orphaned = Object.keys(table).filter((k) => !seen.has(k));
  // A placeholder dropped in translation loses whatever it was carrying, which
  // is worse than a missing translation: the line still reads fine and is wrong.
  const broken = keys.filter((k) => {
    if (!(k in table)) return false;
    const want = (k.match(/\{\w+\}/g) || []).sort().join(',');
    const got = (String(table[k]).match(/\{\w+\}/g) || []).sort().join(',');
    return want !== got;
  });

  console.log(file + ': ' + Object.keys(table).length + ' entries');
  for (const k of missing) console.log('  not translated : ' + JSON.stringify(k));
  for (const k of orphaned) console.log('  no longer used : ' + JSON.stringify(k));
  for (const k of broken) console.log('  placeholder    : ' + JSON.stringify(k));
  if (!missing.length && !orphaned.length && !broken.length) console.log('  complete');
  console.log('');
  problems += missing.length + orphaned.length + broken.length;
}

// A missing key is not fatal at runtime (it falls through to English), so this
// exits non-zero only to make it usable in a check, never to block the app.
process.exitCode = problems ? 1 : 0;
