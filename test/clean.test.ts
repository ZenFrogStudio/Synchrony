import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

/**
 * `scripts/clean.js`, run against a throwaway folder.
 *
 * Spawned rather than required: the script has no exports and acts the moment
 * it loads, and SYNCHRONY_CLEAN_ROOT is how it is kept away from the real
 * repository.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'clean.js');

let dir: string;

function write(relative: string): void {
  const full = path.join(dir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, '', 'utf8');
}

function runClean() {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, SYNCHRONY_CLEAN_ROOT: dir },
    encoding: 'utf8'
  });
}

describe('clean', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-clean-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should_sweep_build_output_and_leave_source_and_dependencies', () => {
    // Arrange
    const build = [
      'dist/extension.js',
      'dist/extension.js.map',
      'dist-test/test/x.js',
      'mobile/dist-test/x.js',
      'mobile/.expo/settings.json',
      'synchrony-0.1.0.vsix',
      'synchrony-0.2.0.vsix'
    ];
    const keep = ['src/keep.ts', 'node_modules/keep/index.js', 'package.json'];
    for (const file of [...build, ...keep]) write(file);

    // Act
    const result = runClean();

    // Assert
    assert.equal(result.status, 0, result.stderr);
    for (const file of build) {
      assert.ok(!fs.existsSync(path.join(dir, file)), `${file} survived the sweep`);
    }
    for (const file of keep) {
      assert.ok(fs.existsSync(path.join(dir, file)), `${file} was swept`);
    }
  });

  it('should_exit_cleanly_when_there_is_nothing_to_remove', () => {
    // Arrange: an empty folder.

    // Act
    const result = runClean();

    // Assert
    assert.equal(result.status, 0, result.stderr);
  });

  it('should_only_sweep_vsix_files_from_the_root', () => {
    // Arrange
    write('src/synchrony-0.1.0.vsix');

    // Act
    const result = runClean();

    // Assert
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'src', 'synchrony-0.1.0.vsix')), 'the sweep recursed into src/');
  });
});
