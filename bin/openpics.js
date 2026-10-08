#!/usr/bin/env node
/**
 * The `openpics` command: opens files, folders, and the assistant in OpenPics.
 *
 * A launcher, not a CLI in the unix sense: it finds the Windows executable and
 * hands it everything it was given, then gets out of the way. The app itself
 * interprets the arguments - files open in the viewer, folders become the
 * library root, `--chat` opens the assistant - so this file stays dumb on
 * purpose. Anything smarter here would drift from what the app does.
 *
 * Usage:
 *   openpics [files or folders] [--chat]
 *   openpics --help
 *   openpics --version
 *
 * Exit codes: 0 when the app was launched (or help/version printed), 1 when it
 * was not, with the reason on stderr. A second invocation while the app runs
 * exits 0 too: the running instance takes the arguments instead of starting
 * a duplicate.
 */
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log('usage: openpics [files or folders] [--chat]');
  console.log('');
  console.log('  files and folders   opened in the running app, or a fresh one');
  console.log('  --chat              open the AI assistant as well');
  console.log('  --help, --version   this text, or the installed version');
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  try {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    console.log(`openpics ${pkg.version}`);
  } catch {
    console.log('openpics (unknown version)');
  }
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.error('openpics runs on Windows: this launcher only knows how to start OpenPics.exe.');
  process.exit(1);
}

// Where the executable can live, in the order worth checking. The dev checkout
// first, so working on the app launches the build just made; then a portable
// exe beside the package; then the per-user and machine install locations the
// installer writes to.
function candidates() {
  const root = path.basename(__dirname) === 'bin' ? path.dirname(__dirname) : __dirname;
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || '';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || '';
  return [
    path.join(root, 'release', 'win-unpacked', 'OpenPics.exe'),
    path.join(root, 'OpenPics.exe'),
    localAppData ? path.join(localAppData, 'Programs', 'OpenPics', 'OpenPics.exe') : '',
    programFiles ? path.join(programFiles, 'OpenPics', 'OpenPics.exe') : '',
    programFilesX86 ? path.join(programFilesX86, 'OpenPics', 'OpenPics.exe') : ''
  ].filter((candidate) => candidate !== '');
}

const tried = candidates();
const exe = tried.find((candidate) => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
});

if (!exe) {
  console.error('OpenPics.exe was not found. Looked in:');
  for (const candidate of tried) console.error(`  ${candidate}`);
  console.error('Build a dev copy (`npm run package:dir`) or install OpenPics, then try again.');
  process.exit(1);
}

try {
  // Exit only on the spawn outcome, not after firing it off: exiting first
  // would report success for a launch that then fails.
  const child = spawn(exe, args, {detached: true, stdio: 'ignore'});
  child.on('spawn', () => {
    child.unref();
    process.exit(0);
  });
  child.on('error', (err) => {
    console.error(`Could not start ${exe}: ${err.message}`);
    process.exit(1);
  });
} catch (err) {
  console.error(`Could not start ${exe}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
