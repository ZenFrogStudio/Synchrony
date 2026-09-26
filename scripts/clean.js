const fs = require('fs');
const path = require('path');

/**
 * Deletes everything the build writes, so `npm run clean && npm run package`
 * starts from nothing.
 *
 * This exists because `vsce package` never removes the previous .vsix. Every
 * release left one behind until twenty-two sat in the root, and a dev build's
 * source maps outlived the production build that replaced them. A script
 * rather than `rm -rf` because that does not exist in cmd.exe.
 *
 * `--vsix` clears only the old .vsix files. `npm run package` runs it that way
 * just before `vsce package`, so each build replaces the last one.
 *
 * SYNCHRONY_CLEAN_ROOT points it at another folder. That is for the test,
 * which must not sweep the real repository.
 */

const ROOT = process.env.SYNCHRONY_CLEAN_ROOT || path.resolve(__dirname, '..');

// Folders the build and the test build write. `mobile/` is the phone app's own
// project with its own package.json, swept here because it lives in this
// repository and nothing else sweeps it.
const FOLDERS = process.argv.includes('--vsix')
  ? []
  : ['dist', 'dist-test', 'mobile/dist-test', 'mobile/.expo'];

for (const folder of FOLDERS) {
  const full = path.join(ROOT, folder);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`removed ${folder}/`);
  }
}

// Every packaged extension in the root, whatever its version. The next
// `npm run package` writes the one reinstall.js will look for.
for (const name of fs.readdirSync(ROOT)) {
  if (name.endsWith('.vsix')) {
    fs.unlinkSync(path.join(ROOT, name));
    console.log(`removed ${name}`);
  }
}
