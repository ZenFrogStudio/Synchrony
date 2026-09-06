import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { STALE_MS, instancesDir as payloadInstancesDir } from '../src/dashboard-payload';

/**
 * The dashboard server's pure helpers.
 *
 * Loaded through `createRequire` rather than imported: `scripts/dashboard-server.js`
 * is plain JavaScript run straight from the repo, so that `npm run dashboard`
 * works without compiling the extension first. It only starts listening under
 * `require.main`, so requiring it here is inert.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const server = createRequire(__filename)(
  path.join(ROOT, 'scripts', 'dashboard-server.js')
) as {
  instancesDir: (home?: string) => string;
  readInstances: (dir: string, nowMs: number) => Record<string, unknown>[];
  resolveStatic: (root: string, urlPath: string) => string | null;
  STALE_MS: number;
};

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const SECOND = 1000;

let dir: string;

function writeInstance(name: string, body: unknown): void {
  fs.writeFileSync(
    path.join(dir, name),
    typeof body === 'string' ? body : JSON.stringify(body),
    'utf8'
  );
}

function instance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    instanceId: '4321-abc123',
    workspaceName: 'repo',
    activeFolder: 'D:\\repo',
    status: 'active',
    lastHeartbeatAt: new Date(NOW - 5 * SECOND).toISOString(),
    counts: { scheduled: 1, running: 0, pending: 0, missed: 0, failedRecent: 0 },
    ...overrides
  };
}

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronos-dashboard-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('dashboard server — reading heartbeats', () => {
  it('should_return_an_empty_board_when_no_window_has_ever_exported', () => {
    assert.deepEqual(server.readInstances(path.join(dir, 'never-created'), NOW), []);
  });

  it('should_read_a_well_formed_heartbeat', () => {
    writeInstance('one.json', instance());

    const found = server.readInstances(dir, NOW);

    assert.equal(found.length, 1);
    assert.equal(found[0].instanceId, '4321-abc123');
    assert.equal(found[0].stale, false);
    assert.equal(found[0].heartbeatAgeMs, 5 * SECOND);

    fs.rmSync(path.join(dir, 'one.json'));
  });

  it('should_skip_a_malformed_file_without_losing_the_healthy_ones', () => {
    writeInstance('good.json', instance({ instanceId: 'good' }));
    writeInstance('truncated.json', '{"instanceId": "half-writ');
    writeInstance('not-an-object.json', '"just a string"');
    writeInstance('no-id.json', { schemaVersion: 1, status: 'active' });

    const found = server.readInstances(dir, NOW);

    assert.deepEqual(
      found.map((i) => i.instanceId),
      ['good'],
      'one unreadable heartbeat must not take the response down'
    );

    for (const name of ['good.json', 'truncated.json', 'not-an-object.json', 'no-id.json']) {
      fs.rmSync(path.join(dir, name));
    }
  });

  it('should_ignore_a_temp_file_a_window_is_still_writing', () => {
    writeInstance('live.json', instance({ instanceId: 'live' }));
    writeInstance('live.json.tmp', instance({ instanceId: 'live' }));

    assert.equal(server.readInstances(dir, NOW).length, 1);

    fs.rmSync(path.join(dir, 'live.json'));
    fs.rmSync(path.join(dir, 'live.json.tmp'));
  });

  it('should_mark_an_old_heartbeat_stale_rather_than_deleting_the_file', () => {
    writeInstance(
      'quiet.json',
      instance({ lastHeartbeatAt: new Date(NOW - STALE_MS - SECOND).toISOString() })
    );

    const found = server.readInstances(dir, NOW);

    assert.equal(found[0].stale, true);
    assert.ok(fs.existsSync(path.join(dir, 'quiet.json')), 'the API never deletes');

    fs.rmSync(path.join(dir, 'quiet.json'));
  });

  it('should_treat_an_unreadable_heartbeat_time_as_stale', () => {
    writeInstance('undated.json', instance({ lastHeartbeatAt: 'not a date' }));

    const found = server.readInstances(dir, NOW);

    assert.equal(found[0].stale, true);
    assert.equal(found[0].heartbeatAgeMs, null);

    fs.rmSync(path.join(dir, 'undated.json'));
  });

  it('should_group_windows_open_on_the_same_folder_together', () => {
    writeInstance('b.json', instance({ instanceId: 'b', workspaceName: 'zebra' }));
    writeInstance('a.json', instance({ instanceId: 'a', workspaceName: 'apple' }));
    writeInstance('c.json', instance({ instanceId: 'c', workspaceName: 'apple' }));

    const found = server.readInstances(dir, NOW);

    assert.deepEqual(
      found.map((i) => i.instanceId),
      ['a', 'c', 'b']
    );

    for (const name of ['a.json', 'b.json', 'c.json']) {
      fs.rmSync(path.join(dir, name));
    }
  });
});

describe('dashboard server — serving static files', () => {
  const root = path.join('D:\\', 'repo', 'dashboard');

  it('should_serve_the_page_at_the_root', () => {
    assert.equal(server.resolveStatic(root, '/'), path.join(root, 'index.html'));
  });

  it('should_serve_a_named_file_inside_the_folder', () => {
    assert.equal(server.resolveStatic(root, '/styles.css'), path.join(root, 'styles.css'));
  });

  it('should_ignore_a_query_string', () => {
    assert.equal(server.resolveStatic(root, '/dashboard.js?v=2'), path.join(root, 'dashboard.js'));
  });

  it('should_refuse_a_path_that_climbs_out_of_the_folder', () => {
    // The server runs on a developer's machine with their home directory a
    // couple of levels up from here.
    assert.equal(server.resolveStatic(root, '/../../.ssh/id_rsa'), null);
    assert.equal(server.resolveStatic(root, '/nested/../../secrets.json'), null);
  });

  it('should_refuse_an_encoded_climb', () => {
    assert.equal(server.resolveStatic(root, '/%2e%2e/%2e%2e/secrets.json'), null);
  });

  it('should_refuse_malformed_percent_encoding_rather_than_throwing', () => {
    assert.equal(server.resolveStatic(root, '/%ZZ'), null);
  });

  it('should_refuse_a_null_byte', () => {
    assert.equal(server.resolveStatic(root, '/index.html%00.png'), null);
  });
});

describe('dashboard artifact', () => {
  it('should_embed_the_dashboard_styles_without_an_external_stylesheet', () => {
    const dashboardDir = path.join(ROOT, 'dashboard');
    const stylesheet = fs
      .readFileSync(path.join(dashboardDir, 'styles.css'), 'utf8')
      .replace(/\r\n/g, '\n')
      .trim();
    const artifact = fs.readFileSync(path.join(dashboardDir, 'artifact.html'), 'utf8');
    const embeddedStyle = artifact.match(/<style>\s*([\s\S]*?)\s*<\/style>/);

    assert.ok(embeddedStyle, 'the artifact must contain an inline style block');
    assert.equal(embeddedStyle[1].replace(/\r\n/g, '\n').trim(), stylesheet);
    assert.doesNotMatch(artifact, /<link\b[^>]*rel=["']stylesheet["']/i);
  });
});

describe('dashboard server — agreement with the exporter', () => {
  it('should_read_the_same_directory_the_exporter_writes_to', () => {
    // The server is plain JavaScript that cannot import the extension's
    // TypeScript, so the path is written out twice. A silent disagreement here
    // is a dashboard that is permanently empty and says nothing about why.
    assert.equal(server.instancesDir('D:\\Users\\dev'), payloadInstancesDir('D:\\Users\\dev'));
  });

  it('should_call_a_heartbeat_stale_at_the_same_age_the_exporter_expects', () => {
    assert.equal(server.STALE_MS, STALE_MS);
  });
});
