import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  dashboardDirFor,
  hasRoot,
  LEGACY_ROOT_DIR,
  migrateHomeDir,
  migrateRoot,
  oldCopies,
  ROOT_DIR,
  rootDirFor
} from '../src/migrate-name';
import { pathsFor } from '../src/roots';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synchrony-rename-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('rename — project root', () => {
  it('should_rename_a_legacy_root_and_keep_its_contents', () => {
    fs.mkdirSync(path.join(dir, LEGACY_ROOT_DIR, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(dir, LEGACY_ROOT_DIR, 'state.json'), '{"schemaVersion":1,"series":[],"runs":[]}');

    assert.equal(migrateRoot(dir), 'migrated');
    assert.equal(fs.existsSync(path.join(dir, LEGACY_ROOT_DIR)), false);
    assert.ok(fs.existsSync(path.join(dir, ROOT_DIR, 'plans')));
    assert.ok(fs.existsSync(path.join(dir, ROOT_DIR, 'state.json')));
  });

  it('should_leave_a_current_root_alone_even_if_a_legacy_one_reappears', () => {
    fs.mkdirSync(path.join(dir, ROOT_DIR));
    fs.mkdirSync(path.join(dir, LEGACY_ROOT_DIR));
    assert.equal(migrateRoot(dir), 'current');
    assert.ok(fs.existsSync(path.join(dir, LEGACY_ROOT_DIR)), 'nothing is deleted');
  });

  it('should_report_none_for_a_folder_that_is_not_a_project', () => {
    assert.equal(migrateRoot(dir), 'none');
    assert.equal(hasRoot(dir), false);
  });

  it('should_resolve_paths_under_the_legacy_name_until_it_is_migrated', () => {
    fs.mkdirSync(path.join(dir, LEGACY_ROOT_DIR));
    assert.equal(rootDirFor(dir), LEGACY_ROOT_DIR);
    assert.equal(hasRoot(dir), true);
    assert.equal(pathsFor(dir).root, path.join(dir, LEGACY_ROOT_DIR));

    migrateRoot(dir);
    assert.equal(rootDirFor(dir), ROOT_DIR);
    assert.equal(pathsFor(dir).root, path.join(dir, ROOT_DIR));
  });

  it('should_use_the_new_name_for_a_fresh_project', () => {
    assert.equal(rootDirFor(dir), ROOT_DIR);
    assert.equal(pathsFor(dir).root, path.join(dir, ROOT_DIR));
  });
});

describe('rename — home directory', () => {
  it('should_rename_the_legacy_dashboard_dir_and_resolve_to_it', () => {
    fs.mkdirSync(path.join(dir, '.chronos-dashboard', 'instances'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.chronos-dashboard', 'hub.token'), 'abc\n');

    assert.equal(migrateHomeDir(dir), 'migrated');
    assert.equal(dashboardDirFor(dir), path.join(dir, '.synchrony-dashboard'));
    assert.equal(fs.readFileSync(path.join(dir, '.synchrony-dashboard', 'hub.token'), 'utf8'), 'abc\n');
  });

  it('should_point_at_the_new_dir_when_neither_exists', () => {
    assert.equal(dashboardDirFor(dir), path.join(dir, '.synchrony-dashboard'));
    assert.equal(migrateHomeDir(dir), 'none');
  });
});

describe('rename — older builds still installed', () => {
  const self = { id: 'Z3n.synchrony', name: 'synchrony', version: '0.9.1' };
  const chronos = { id: 'z3n.chronos', name: 'chronos', version: '0.8.0-rc.86' };
  const chronus = { id: 'onemedialabs.chronus', name: 'chronus', version: '0.8.0-rc.9' };
  const unrelated = { id: 'ms-python.python', name: 'python', version: '2026.1.0' };

  it('should_report_every_previous_id_and_nothing_else', () => {
    const found = oldCopies([unrelated, chronos, self, chronus], self.id);
    assert.deepEqual(found, [chronos, chronus]);
  });

  it('should_not_report_itself_whatever_the_editor_does_to_the_case', () => {
    // The manifest says `Z3n`; the editor's registry says `z3n`.
    assert.deepEqual(oldCopies([{ ...self, id: 'z3n.synchrony' }], 'Z3n.synchrony'), []);
  });

  it('should_report_the_same_name_under_another_publisher', () => {
    const marketplace = { id: 'someone-else.synchrony', name: 'synchrony', version: '0.9.0' };
    assert.deepEqual(oldCopies([self, marketplace], self.id), [marketplace]);
  });

  it('should_report_nothing_when_only_this_build_is_installed', () => {
    assert.deepEqual(oldCopies([self, unrelated], self.id), []);
  });
});
