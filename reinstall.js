const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Installs the packaged .vsix into the editor, so a build actually reaches the
 * thing that runs it.
 *
 * This exists because `npm run package` stops at a file on disk. Every scheduled
 * run that edited this extension typechecked, tested, compiled and packaged —
 * and then the window carried on serving the version it loaded at startup, with
 * nothing anywhere saying the two had diverged. Hours of completed work looked
 * like work that had silently done nothing.
 *
 * Deliberately not called `install`: npm runs a script by that name during
 * `npm install`, which would package and reinstall the extension every time a
 * dependency was added.
 */

// VSCodium first, because that is the editor this is developed in. The two keep
// entirely separate extension folders — `~/.vscode-oss` and `~/.vscode` — so
// installing with the wrong CLI reports success, and leaves the editor you are
// actually looking at on whatever version it already had. That is not a
// hypothetical: it is how six hours of finished work stayed invisible. Swap the
// order if you move to Microsoft's build.
const EDITOR_CLIS = ['codium', 'code'];

const version = require('./package.json').version;
const vsix = path.join(__dirname, `synchrony-${version}.vsix`);

if (!fs.existsSync(vsix)) {
  console.error(`error: ${path.basename(vsix)} is missing — run \`npm run package\` first`);
  process.exit(1);
}

// shell: true because these are `.cmd` shims on Windows, which spawn cannot
// execute directly.
const found = EDITOR_CLIS.find(
  (cli) => spawnSync(cli, ['--version'], { shell: true, stdio: 'ignore' }).status === 0
);

if (!found) {
  console.error(
    `error: none of ${EDITOR_CLIS.join(', ')} are on PATH — open your editor and run\n` +
      '       "Shell Command: Install \'code\' command in PATH" from the palette'
  );
  process.exit(1);
}

// --force because the version has usually not changed, and without it the editor
// declines to reinstall and the stale copy stays put.
const result = spawnSync(found, ['--install-extension', vsix, '--force'], {
  stdio: 'inherit',
  shell: true
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Naming the editor, because installing into the wrong one is the failure this
// script exists to prevent and it looks identical to success. The reload is the
// other half: installing over a running window does not swap the code already
// loaded, so without it the build is on disk, correct, and still invisible.
console.log(`\nInstalled synchrony ${version} into ${found}. Reload the window to pick it up:`);
console.log('  Ctrl+Shift+P → Developer: Reload Window');
