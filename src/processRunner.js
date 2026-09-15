'use strict';

const { spawn } = require('child_process');
const readline = require('readline');

class ProcessCancelledError extends Error {}

const TAIL_CAP = 60;

function appendCapped(tail, line) {
  if (!line || !line.trim()) return;
  tail.push(line);
  if (tail.length > TAIL_CAP) tail.shift();
}

/**
 * Runs an external tool (yt-dlp, ffmpeg) and streams its stdout line by line.
 * `cancelToken` is a plain { cancelled: false } object the caller can flip;
 * checking it between lines is enough since we're reading a stream, not
 * polling - mirrors the Python app's threading.Event cancel flag.
 */
function runProcess(exePath, args, onStdoutLine, cancelToken) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { windowsHide: true });
    const stdoutTail = [];
    const stderrTail = [];

    // yt-dlp spawns ffmpeg to merge, so killing the child alone can leave that
    // grandchild running. On Windows taskkill /T is what ends the whole tree.
    const killTree = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill();
        }
      } catch {
        // Already gone; the close handler still rejects as cancelled.
      }
    };
    if (cancelToken) cancelToken.kill = killTree;

    const outRl = readline.createInterface({ input: child.stdout });
    outRl.on('line', (line) => {
      if (cancelToken && cancelToken.cancelled) {
        killTree();
        return;
      }
      appendCapped(stdoutTail, line);
      if (onStdoutLine) onStdoutLine(line);
    });

    const errRl = readline.createInterface({ input: child.stderr });
    errRl.on('line', (line) => appendCapped(stderrTail, line));

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (cancelToken && cancelToken.cancelled) {
        reject(new ProcessCancelledError());
        return;
      }
      resolve({ exitCode: code, stdoutTail, stderrTail });
    });
  });
}

module.exports = { runProcess, ProcessCancelledError };
