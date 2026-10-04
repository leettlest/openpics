#!/usr/bin/env node
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

function getAppRoot() {
  // when installed, __dirname is .../bin
  let p = __dirname;
  // if bin/openpics.js, go up
  if (path.basename(p) === 'bin') {
    p = path.dirname(p);
  }
  return p;
}

const root = getAppRoot();
// look for exe in release/win-unpacked or app path
const exe = process.platform === 'win32'
  ? path.join(root, 'release', 'win-unpacked', 'OpenPics.exe')
  : path.join(root, 'dist', process.platform === 'linux' ? 'openpics' : 'OpenPics.app');

if (process.platform === 'win32' && fs.existsSync(exe)) {
  spawn(exe, process.argv.slice(2), {detached: true, stdio: 'ignore'}).unref();
  process.exit(0);
}
console.error('OpenPics.exe not found at', exe);
process.exit(1);
