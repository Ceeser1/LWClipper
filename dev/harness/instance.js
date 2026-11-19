'use strict';

// The test instance: LWClipper run from this folder's source with a profile
// and a cache of its own under work/, so the installed app and its projects
// are never touched, and a debugging port the other scripts drive it through.
//
//   node dev/harness/instance.js start     (stops one that is running first)
//   node dev/harness/instance.js stop
//
// Only an instance on this port is ever stopped: other Electron apps, and an
// LWClipper the user has open, are left alone.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { ROOT, W, PORT } = require('./lib');

function writeProfile() {
  const data = path.join(W, 'profile', 'LWClipper', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(W, 'cache'), { recursive: true });
  fs.mkdirSync(path.join(W, 'out'), { recursive: true });
  // Written from node: a settings file with a byte order mark reads as
  // defaults, which would point the instance at the real download cache.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    language: 'en', advancedEditing: true, cacheDir: path.join(W, 'cache'),
  }));
}

function stop() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { "
    + "$_.CommandLine -match 'remote-debugging-port=" + PORT + "' -and $_.CommandLine -notmatch '--type=' } | "
    + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false; $_.ProcessId }';
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
    return out ? out.split(/\s+/) : [];
  } catch {
    return [];
  }
}

async function up() {
  try {
    const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    return list.some((p) => p.type === 'page' && /index\.html/.test(p.url));
  } catch {
    return false;
  }
}

async function start() {
  stop();
  await new Promise((r) => setTimeout(r, 1000));
  writeProfile();
  const env = { ...process.env, LOCALAPPDATA: path.join(W, 'profile') };
  // An editor's terminal sets this, and Electron then starts as plain node.
  delete env.ELECTRON_RUN_AS_NODE;
  const log = fs.openSync(path.join(W, 'instance.log'), 'w');
  const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [
    '.', '--remote-debugging-port=' + PORT,
    // A window behind others would otherwise stop drawing and misreport its size.
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  ], { cwd: ROOT, env, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await up()) {
      // The page is there before its scripts have all run.
      await new Promise((r) => setTimeout(r, 3000));
      return true;
    }
  }
  return false;
}

module.exports = { start, stop, up, writeProfile };

if (require.main === module) {
  const what = process.argv[2];
  if (what === 'stop') {
    const gone = stop();
    console.log(gone.length ? 'stopped ' + gone.join(' ') : 'none running');
  } else if (what === 'start') {
    start().then((ok) => {
      console.log(ok ? 'up on port ' + PORT : 'did not come up, see work/instance.log');
      process.exit(ok ? 0 : 1);
    });
  } else {
    console.log('node dev/harness/instance.js start|stop');
  }
}
